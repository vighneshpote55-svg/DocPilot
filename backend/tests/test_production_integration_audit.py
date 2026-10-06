import logging
from datetime import datetime, timedelta
import pytest
from sqlalchemy import select

from app import ai_service, emailer, jobs, scheduler, services, storage
from app.db import get_db, session_scope
from app.models import AccessToken, AuditLog, ConsentLedger, Customer, Document, ManualReview, OcrResult
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


class FakeClock:
    """Monotonic fake clock for safe simulation of lifecycle periods."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 5, 1, 10, 0, 0)

    def utcnow(self) -> datetime:
        return self.current

    def advance(self, days: int = 0, hours: int = 0, minutes: int = 0, seconds: int = 0) -> datetime:
        self.current += timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)
        return self.current


@pytest.fixture
def fake_clock(monkeypatch):
    clock = FakeClock()
    for mod in ("app.db", "app.services", "app.scheduler", "app.jobs", "app.pipeline", "app.models"):
        monkeypatch.setattr(f"{mod}.utcnow", clock.utcnow)
    return clock


def _onboard_sim_customer(client, name="Audit User", email="audit.user@example.com", docs=("pan",)):
    emailer.OUTBOX.clear()
    r = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": name,
        "email": email,
        "required_documents": list(docs),
        "send_consent": True,
    })
    assert r.status_code == 201
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).status_code == 200
    portal_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()
    return cid, portal_tok


def _upload_file(client, portal, doc_type, filename="doc.png", content=PNG):
    return client.post(f"/api/portal/{portal}/upload", data={"doc_type": doc_type},
                       files={"file": (filename, content, "image/png" if filename.endswith(".png") else "application/pdf")})


# 1. Path A: Customer creation -> consent -> upload -> OCR -> masking -> rules CLEAR -> verification -> completion -> retention -> deletion
def test_production_path_clear_auto_verification_to_purge(client, fake_clock):
    cid, portal = _onboard_sim_customer(client, "Path A Customer", "path.a@example.com", docs=("pan",))

    # Day 0: Customer uploads document
    r_up = _upload_file(client, portal, "pan")
    assert r_up.status_code == 202
    doc_id = r_up.json()["document_id"]

    # PostgreSQL job runner executes asynchronous OCR
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        d = db.get(Document, doc_id)
        assert d.verification_status == "verified"
        assert d.file_state == "stored"
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
        assert c.completed_at == fake_clock.current
        assert c.delete_after == fake_clock.current + timedelta(days=7)

    # Completion email dispatched
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)
    emailer.OUTBOX.clear()

    # Day 5: Mid-retention, files still accessible by authorized admin
    fake_clock.advance(days=5)
    assert scheduler.tick()["deleted"] == 0
    view_res = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert view_res.status_code == 200

    # Day 7 + 1 hour: 7-day retention expires -> permanent deletion purge
    fake_clock.advance(days=2, hours=1)
    tick_res = scheduler.tick()
    assert tick_res["deleted"] == 1

    # Assert complete purge
    with session_scope() as db:
        c = db.get(Customer, cid)
        d = db.get(Document, doc_id)
        assert c.data_deleted_at is not None
        assert d.file_state == "deleted"
        assert d.sha256 == ""
        # Storage file deleted
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)
        # OCR data purged
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None
        # Access tokens purged
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None


# 2. Path B: Upload -> OCR -> rules INCONCLUSIVE -> redacted AI -> AI manual review -> reviewer approval -> completion
def test_production_path_inconclusive_ai_manual_review_approval(client, fake_clock, env, monkeypatch):
    cid, portal = _onboard_sim_customer(client, "Path B Customer", "path.b@example.com", docs=("pan",))

    # Borderline confidence triggers AI escalation
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.75,
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Path B Customer"}
    )

    # AI returns manual_review
    monkeypatch.setattr(ai_service, "assess", lambda *args, **kwargs: {
        "verdict": "manual_review",
        "confidence": 0.65,
        "reason_codes": ["layout_ambiguous"],
        "risk_flags": ["layout_flag"],
    })

    _upload_file(client, portal, "pan")
    jobs.run_all()

    # Review queue received the document
    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1
    rev_id = reviews[0]["id"]
    doc_id = reviews[0]["document"]["id"]

    # Reviewer inspects masked evidence and approves
    resp = client.post(f"/api/admin/reviews/{rev_id}/approve", headers=admin_headers(), json={"note": "Approved by senior officer"})
    assert resp.status_code == 200

    with session_scope() as db:
        c = db.get(Customer, cid)
        d = db.get(Document, doc_id)
        assert d.verification_status == "verified"
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"


# 3. Path C: Upload -> manual review -> rejection -> resubmission -> verification
def test_production_path_rejection_resubmission_completion(client, fake_clock, env):
    cid, portal = _onboard_sim_customer(client, "Path C Customer", "path.c@example.com", docs=("pan",))

    # OCR returns low confidence with reason
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.35, reason="illegible")
    _upload_file(client, portal, "pan")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1
    rev_id = reviews[0]["id"]

    # Staff rejects with note
    rej_res = client.post(f"/api/admin/reviews/{rev_id}/reject", headers=admin_headers(), json={"note": "Document blurry"})
    assert rej_res.status_code == 200

    # Customer receives email with fresh portal token
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)
    resub_portal = token_from_outbox("portal")
    assert resub_portal is not None

    # Customer uploads clean replacement
    del env.responses["pan"]
    _upload_file(client, resub_portal, "pan", "clean.png", PNG + b"_clean")
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
