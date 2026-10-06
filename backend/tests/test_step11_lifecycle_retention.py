import logging
from datetime import datetime, timedelta
import pytest
from sqlalchemy import select

from app import emailer, jobs, scheduler, services, storage
from app.db import get_db, session_scope
from app.models import AccessToken, AuditLog, Customer, Document, ManualReview, OcrResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


class FakeClock:
    """Controllable monotonic fake clock for lifecycle and retention testing."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 3, 1, 10, 0, 0)

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


def _onboard_customer(client, name="Ananya Gupta", email="ananya@example.com", docs=("pan", "bank_statement")):
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


# 1. Recalculate pending documents after every verified/rejected/resubmitted document
def test_pending_recalculation_after_verify_reject_resubmit(client, env):
    cid, portal = _onboard_customer(client, "Rohan Verma", "rohan@example.com", docs=("pan", "bank_statement"))

    with session_scope() as db:
        c = db.get(Customer, cid)
        state = services.recalc_case(db, c)
        assert state["pending_count"] == 2
        assert state["case_status"] == "in_progress"

    # Upload PAN with low confidence -> manual review
    from app.ocr_client import OCRResult
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.35, reason="blurred")
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        state = services.recalc_case(db, c)
        assert state["pending_count"] == 2

    # Reviewer rejects PAN
    rev = client.get("/api/admin/reviews", headers=admin_headers()).json()[0]
    client.post(f"/api/admin/reviews/{rev['id']}/reject", headers=admin_headers(), json={"note": "blurry"})

    # Check pending remains 2, slot still pending for resubmission
    with session_scope() as db:
        c = db.get(Customer, cid)
        state = services.recalc_case(db, c)
        assert state["pending_count"] == 2

    # Customer resubmits PAN cleanly using fresh resubmission portal link
    resubmit_tok = token_from_outbox("portal")
    del env.responses["pan"]
    _upload_doc(client, resubmit_tok, "pan", "clean_pan.png", PNG + b"_clean")
    jobs.run_all()

    # PAN is now verified -> pending becomes 1
    with session_scope() as db:
        c = db.get(Customer, cid)
        state = services.recalc_case(db, c)
        assert state["pending_count"] == 1
        assert state["received_count"] == 1
        assert state["pending_keys"] == ["bank_statement"]

    # Upload clean Bank Statement -> pending becomes 0 -> completed
    _upload_doc(client, resubmit_tok, "bank_statement", "bank.pdf", PDF)
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        state = services.recalc_case(db, c)
        assert state["pending_count"] == 0
        assert state["completed"] is True
        assert c.workflow_state == "COMPLETED"


# 2. When all required documents are verified: COMPLETED, timestamp, 7-day retention, email, audit
def test_customer_completion_lifecycle_and_audit(client, fake_clock):
    cid, portal = _onboard_customer(client, "Deepak Joshi", "deepak@example.com", docs=("pan",))

    # Upload and verify
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
        assert c.completed_at == fake_clock.current
        # Scheduled for 7-day retention
        assert c.delete_after == fake_clock.current + timedelta(days=7)

        # Audit events
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(cid))))
        actions = [a.action for a in audits]
        assert "customer_completed" in actions
        assert "retention_started" in actions
        assert "case_completed" in actions

    # Completion email sent
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)


# 3. Reminders at Day 3, 7, 14 only while pending, active consent, not completed/deleted/withdrawn
def test_reminders_3_7_14_day_schedule(client, fake_clock):
    cid, _ = _onboard_customer(client, "Kiran Rao", "kiran@example.com", docs=("pan", "bank_statement"))

    # Day 0: No reminders
    assert scheduler.tick()["reminders"] == 0

    # Advance to Day 3
    fake_clock.advance(days=3)
    tick3 = scheduler.tick()
    assert tick3["reminders"] == 1
    assert any("Reminder" in m["subject"] and "kiran@example.com" == m["to"] for m in emailer.OUTBOX)
    emailer.OUTBOX.clear()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 3
        # Audit reminder_sent
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "reminder_sent"))
        assert audit is not None
        assert audit.details["stage"] == 3

    # Advance to Day 7
    fake_clock.advance(days=4)
    tick7 = scheduler.tick()
    assert tick7["reminders"] == 1
    emailer.OUTBOX.clear()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 7

    # Advance to Day 14
    fake_clock.advance(days=7)
    tick14 = scheduler.tick()
    assert tick14["reminders"] == 1
    emailer.OUTBOX.clear()

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 14

    # Advance past Day 14: No further reminders
    fake_clock.advance(days=5)
    assert scheduler.tick()["reminders"] == 0


# 4. Reminders are strictly idempotent
def test_reminders_idempotency_no_duplicates(client, fake_clock):
    cid, _ = _onboard_customer(client, "Idempotent User", "idem@example.com", docs=("pan",))

    fake_clock.advance(days=3)
    assert scheduler.tick()["reminders"] == 1
    assert len(emailer.OUTBOX) == 1

    # Run 5 repeated ticks on the exact same day
    for _ in range(5):
        assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 1


# 5. Withdrawn / deleted / completed customers are skipped by reminders
def test_reminders_skip_withdrawn_deleted_completed(client, fake_clock):
    # Customer 1: Consent withdrawn
    cid1, _ = _onboard_customer(client, "User 1", "u1@example.com", docs=("pan",))
    with session_scope() as db:
        c1 = db.get(Customer, cid1)
        c1.consent_status = "withdrawn"
        c1.case_status = "consent_withdrawn"

    # Customer 2: Deleted
    cid2, _ = _onboard_customer(client, "User 2", "u2@example.com", docs=("pan",))
    with session_scope() as db:
        c2 = db.get(Customer, cid2)
        c2.case_status = "deleted"

    # Customer 3: Completed
    cid3, portal3 = _onboard_customer(client, "User 3", "u3@example.com", docs=("pan",))
    _upload_doc(client, portal3, "pan")
    jobs.run_all()
    emailer.OUTBOX.clear()

    # Advance to Day 3
    fake_clock.advance(days=3)
    tick = scheduler.tick()
    assert tick["reminders"] == 0
    assert len(emailer.OUTBOX) == 0


# 6. 7-day retention permanent deletion: purge files, OCR, review rows, hashes, tokens
def test_7_day_retention_permanent_deletion(client, fake_clock):
    cid, portal = _onboard_customer(client, "Purge Customer", "purge@example.com", docs=("pan",))
    r_up = _upload_doc(client, portal, "pan")
    doc_id = r_up.json()["document_id"]
    jobs.run_all()

    # Case completes on Day 0 -> delete_after = Day 7
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.delete_after == fake_clock.current + timedelta(days=7)

    # Day 5: files still present and accessible
    fake_clock.advance(days=5)
    assert scheduler.tick()["deleted"] == 0
    assert client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers()).status_code == 200

    # Day 7 + 1 hour: retention deletion triggers
    fake_clock.advance(days=2, hours=1)
    emailer.OUTBOX.clear()
    tick_purge = scheduler.tick()
    assert tick_purge["deleted"] == 1

    # Confirmation email sent
    assert any("Your documents have been deleted" in m["subject"] for m in emailer.OUTBOX)

    # Check purged state
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is not None

        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # Encrypted file in storage deleted
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # OCR results, review records, tokens deleted
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None
        assert db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id)) is None
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None

        # Audit events recorded
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(cid))))
        actions = [a.action for a in audits]
        assert "data_permanently_deleted" in actions
        assert "retention_deleted" in actions


# 7. Deleted data must never be downloadable afterward (returns 410)
def test_deleted_data_not_downloadable_410(client, fake_clock):
    cid, portal = _onboard_customer(client, "No Download", "nodownload@example.com", docs=("pan",))
    r_up = _upload_doc(client, portal, "pan")
    doc_id = r_up.json()["document_id"]
    jobs.run_all()

    # Advance past retention
    fake_clock.advance(days=8)
    scheduler.tick()

    # Both view and download attempts return 410 Gone
    v_res = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert v_res.status_code == 410
    assert v_res.json()["detail"] == "file_deleted"

    d_res = client.get(f"/api/admin/documents/{doc_id}/file?download=true", headers=admin_headers())
    assert d_res.status_code == 410
    assert d_res.json()["detail"] == "file_deleted"


# 8. Worker/scheduler failures fail safely and retry without duplicate emails/deletions
def test_retention_scheduler_failure_retry_safety(client, fake_clock, monkeypatch):
    cid, portal = _onboard_customer(client, "Retry Safety", "retrysafety@example.com", docs=("pan",))
    _upload_doc(client, portal, "pan")
    jobs.run_all()

    fake_clock.advance(days=8)

    # Simulate temporary failure during storage deletion
    call_count = 0
    orig_delete = services.delete_file

    def flaky_delete(key):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("Transient Storage Error")
        orig_delete(key)

    monkeypatch.setattr(services, "delete_file", flaky_delete)
    emailer.OUTBOX.clear()

    # First tick encounters failure, fails safely, does not mark deleted
    tick1 = scheduler.delete_due()
    assert tick1 == 0
    assert len(emailer.OUTBOX) == 0

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is None

    # Next tick succeeds cleanly
    tick2 = scheduler.delete_due()
    assert tick2 == 1
    assert len(emailer.OUTBOX) == 1

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is not None


# 9. No PII leakage in retention and reminder audit logs
def test_no_pii_in_retention_and_reminder_audit_logs(client, fake_clock, caplog):
    caplog.set_level(logging.DEBUG)
    raw_email = "piisafe@example.com"
    cid, _ = _onboard_customer(client, "PII Safe User", raw_email, docs=("pan",))

    fake_clock.advance(days=3)
    scheduler.tick()

    # Advance and complete
    with session_scope() as db:
        c = db.get(Customer, cid)
        services.recalc_case(db, c)

    fake_clock.advance(days=8)
    scheduler.tick()

    with session_scope() as db:
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(cid))))
        for a in audits:
            details_str = str(a.details or {})
            assert raw_email not in details_str
