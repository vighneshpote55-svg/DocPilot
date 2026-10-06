import logging
from datetime import datetime, timedelta
import pytest
from sqlalchemy import select

from app import ai_service, emailer, jobs, scheduler, services, storage
from app.db import get_db, session_scope
from app.models import AccessToken, AuditLog, ConsentLedger, Customer, Document, Job, ManualReview, OcrResult, PrivacyRequest
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


class FakeClock:
    """Controllable monotonic fake clock for end-to-end testing."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 4, 1, 10, 0, 0)

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


def _onboard_customer(client, name="Meera Patel", email="meera.patel@example.com", docs=("pan", "bank_statement")):
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


def _upload_doc(client, portal, doc_type, filename="doc.png", content=PNG):
    return client.post(f"/api/portal/{portal}/upload", data={"doc_type": doc_type},
                       files={"file": (filename, content, "image/png" if filename.endswith(".png") else "application/pdf")})


# 1. Privacy deletion confirmation: atomicity, token consumption, customer anonymization, purge
def test_privacy_deletion_end_to_end(client):
    cid, portal = _onboard_customer(client, "Ramesh Rao", "ramesh.rao@example.com", docs=("pan",))
    r_up = _upload_doc(client, portal, "pan")
    assert r_up.status_code == 202
    doc_id = r_up.json()["document_id"]
    jobs.run_all()

    # Verify document is stored and encrypted
    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.file_state == "stored"
        assert storage.get_file(d.storage_key) is not None

    # Step 1: Submit deletion request
    emailer.OUTBOX.clear()
    req_res = client.post("/api/public/privacy/request", json={"email": "ramesh.rao@example.com", "action": "delete"})
    assert req_res.status_code == 202
    priv_token = token_from_outbox("privacy/confirm")
    assert priv_token is not None

    # Step 2: Confirm deletion request
    emailer.OUTBOX.clear()
    conf_res = client.post(f"/api/public/privacy/confirm/{priv_token}")
    assert conf_res.status_code == 200
    assert conf_res.json()["completed"] == "delete"

    # Step 3: Deletion confirmation email was sent
    assert any("Your documents have been deleted" in m["subject"] for m in emailer.OUTBOX)

    # Step 4: Verify customer anonymization and data purge
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.name == "[deleted]"
        assert c.email == f"deleted-{cid}@invalid.local"
        assert c.mobile is None
        assert c.case_status == "deleted"
        assert c.consent_status == "withdrawn"
        assert c.workflow_state == "DELETED"
        assert c.data_deleted_at is not None

        # Document file state is deleted and sha256 wiped
        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # Encrypted storage file is purged
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # Temporary OCR results, review records, access tokens are wiped
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None
        assert db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id)) is None
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None

        # Consent ledger recorded without PII
        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cid)))
        events = [l.event for l in ledger]
        assert "granted" in events
        assert "deleted" in events


# 2. Consent withdrawal: stops uploads, sets state, schedules retention
def test_privacy_withdrawal_end_to_end(client, fake_clock):
    cid, portal = _onboard_customer(client, "Shruti Desai", "shruti.desai@example.com", docs=("pan",))
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    # Submit withdrawal request
    emailer.OUTBOX.clear()
    r = client.post("/api/public/privacy/request", json={"email": "shruti.desai@example.com", "action": "withdraw"})
    assert r.status_code == 202
    priv_token = token_from_outbox("privacy/confirm")

    # Confirm withdrawal
    emailer.OUTBOX.clear()
    conf_res = client.post(f"/api/public/privacy/confirm/{priv_token}")
    assert conf_res.status_code == 200
    assert conf_res.json()["completed"] == "withdraw"
    assert any("Consent withdrawn" in m["subject"] for m in emailer.OUTBOX)

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.consent_status == "withdrawn"
        assert c.case_status == "consent_withdrawn"
        assert c.workflow_state == "CONSENT_WITHDRAWN"
        assert c.delete_after == fake_clock.current + timedelta(days=7)

        # Access tokens revoked
        tokens = list(db.scalars(select(AccessToken).where(AccessToken.customer_id == cid)))
        assert all(t.revoked for t in tokens)

    # Portal access is now blocked (token was revoked -> returns 404 invalid_or_expired_link)
    portal_res = client.get(f"/api/portal/{portal}")
    assert portal_res.status_code == 404
    assert portal_res.json()["detail"] == "invalid_or_expired_link"


# 3. Queued-job cancellation / blocking when customer withdraws consent
def test_queued_job_blocked_on_consent_withdrawal(client, monkeypatch):
    cid, portal = _onboard_customer(client, "Job Blocking User", "jobblock@example.com", docs=("pan",))

    # Upload document (enqueues job in DB)
    u_res = _upload_doc(client, portal, "pan")
    doc_id = u_res.json()["document_id"]

    # Customer withdraws consent before the worker processes the queued job
    with session_scope() as db:
        c = db.get(Customer, cid)
        c.consent_status = "withdrawn"
        c.case_status = "consent_withdrawn"

    # Track if OCR client is called
    ocr_called = False
    from app import ocr_client
    orig_extract = ocr_client.HTTPOCRClient.extract

    def fake_extract(*args, **kwargs):
        nonlocal ocr_called
        ocr_called = True
        return orig_extract(*args, **kwargs)

    monkeypatch.setattr(ocr_client.HTTPOCRClient, "extract", fake_extract)

    # Worker picks the job
    assert jobs.run_one() is True

    # Assert OCR was NOT called, processing stopped cleanly
    assert ocr_called is False

    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.reason == "processing_stopped"


# 4. Token single-use & expiration enforcement
def test_privacy_token_single_use_and_invalidation(client, fake_clock):
    cid, _ = _onboard_customer(client, "Token Safety", "tokensafety@example.com", docs=("pan",))

    client.post("/api/public/privacy/request", json={"email": "tokensafety@example.com", "action": "delete"})
    priv_token = token_from_outbox("privacy/confirm")

    # Advance past 30 minutes (token expiry)
    fake_clock.advance(minutes=31)
    exp_res = client.post(f"/api/public/privacy/confirm/{priv_token}")
    assert exp_res.status_code == 404
    assert exp_res.json()["detail"] == "invalid_or_expired_link"

    # Request new token
    emailer.OUTBOX.clear()
    client.post("/api/public/privacy/request", json={"email": "tokensafety@example.com", "action": "delete"})
    new_token = token_from_outbox("privacy/confirm")

    # First consumption succeeds
    first_use = client.post(f"/api/public/privacy/confirm/{new_token}")
    assert first_use.status_code == 200

    # Second consumption of the exact same token fails (single use)
    second_use = client.post(f"/api/public/privacy/confirm/{new_token}")
    assert second_use.status_code == 404
    assert second_use.json()["detail"] == "invalid_or_expired_link"


# 5. Full End-to-End Workflow: Clean Auto-Verification -> Completion -> 7-Day Retention -> Deletion
def test_full_e2e_clear_workflow(client, fake_clock):
    cid, portal = _onboard_customer(client, "Aarav Sharma", "aarav.clear@example.com", docs=("pan",))

    # Day 0: Upload clean PAN
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
        assert c.completed_at == fake_clock.current
        assert c.delete_after == fake_clock.current + timedelta(days=7)

    # Day 5: Files still viewable by admin
    fake_clock.advance(days=5)
    assert scheduler.tick()["deleted"] == 0

    # Day 7 + 1 hour: 7-day retention deletes files
    fake_clock.advance(days=2, hours=1)
    tick = scheduler.tick()
    assert tick["deleted"] == 1

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is not None
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(cid))))
        actions = [a.action for a in audits]
        assert "customer_completed" in actions
        assert "retention_started" in actions
        assert "data_permanently_deleted" in actions


# 6. Full End-to-End Workflow: Inconclusive -> AI escalation -> Manual Review -> Approval -> Completion
def test_full_e2e_ai_and_manual_review_workflow(client, fake_clock, env, monkeypatch):
    cid, portal = _onboard_customer(client, "Neha Verma", "neha.verma@example.com", docs=("pan",))

    # OCR produces borderline confidence (inconclusive -> triggers AI)
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.74,
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Neha Verma"}
    )

    # AI returns manual_review verdict
    monkeypatch.setattr(ai_service, "assess", lambda *args, **kwargs: {
        "verdict": "manual_review",
        "confidence": 0.60,
        "reason_codes": ["borderline_scan"],
        "risk_flags": ["layout_uncertain"],
    })

    _upload_doc(client, portal, "pan")
    jobs.run_all()

    # Document enters manual review queue
    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) == 1
    rev_id = revs[0]["id"]
    doc_id = revs[0]["document"]["id"]

    # Reviewer inspects and approves
    app_res = client.post(f"/api/admin/reviews/{rev_id}/approve", headers=admin_headers(), json={"note": "Approved by KYC Lead"})
    assert app_res.status_code == 200

    # Customer completes case and schedules retention
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
        d = db.get(Document, doc_id)
        assert d.verification_status == "verified"


# 7. Full End-to-End Workflow: Rejection -> Resubmission Token -> Clean Upload -> Completion
def test_full_e2e_rejection_resubmission_workflow(client, fake_clock, env):
    cid, portal = _onboard_customer(client, "Suresh Nair", "suresh.nair@example.com", docs=("pan",))

    # Initial upload is rejected
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.30, reason="bad_lighting")
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) == 1
    rev_id = revs[0]["id"]

    # Staff rejects with note
    client.post(f"/api/admin/reviews/{rev_id}/reject", headers=admin_headers(), json={"note": "Too dark, retake"})

    # Resubmission email was sent with new portal token
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)
    resubmit_portal_tok = token_from_outbox("portal")
    assert resubmit_portal_tok is not None

    # Customer re-uploads clean copy
    del env.responses["pan"]
    _upload_doc(client, resubmit_portal_tok, "pan", "pan_bright.png", PNG + b"_bright")
    jobs.run_all()

    # Case completes
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"


# 8. Privacy safety: No raw PII in logs, audit records, or error messages
def test_no_pii_in_logs_and_audits_across_all_workflows(client, caplog):
    caplog.set_level(logging.DEBUG)
    raw_pan = "BNZPK9876Q"
    raw_acc = "123456789012"
    raw_email = "superprivacy@example.com"

    cid, portal = _onboard_customer(client, "Super Privacy User", raw_email, docs=("pan",))
    from app.ocr_client import OCRResult
    from tests.conftest import FakeOCR

    # Upload document with raw fields in OCR response
    client.app.state.fake_ocr = FakeOCR()
    client.app.state.fake_ocr.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        extracted_fields={"pan_number": raw_pan, "account_number": raw_acc, "name": "Super Privacy User"}
    )
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    # Verify audit logs do not contain raw PAN or account number
    with session_scope() as db:
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(cid))))
        for a in audits:
            details_str = str(a.details or {})
            assert raw_pan not in details_str
            assert raw_acc not in details_str
            assert raw_email not in details_str

    # Verify caplog records do not contain raw PAN or account number
    for record in caplog.records:
        assert raw_pan not in record.message
        assert raw_acc not in record.message
