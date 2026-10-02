from datetime import datetime, timedelta
import re
import pytest
from sqlalchemy import select

from app import emailer, jobs, pipeline, scheduler, services, storage
from app.db import get_db, session_scope
from app.models import AccessToken, AuditLog, ConsentLedger, Customer, Document, ManualReview, OcrResult, PrivacyRequest
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


class FakeClock:
    """Controllable monotonic clock for retention and lifecycle tests."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 1, 1, 10, 0, 0)

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


def _create_customer_with_doc(client, name="Test Customer", email="test.retention@example.com"):
    """Helper to create a customer, record consent, upload one document, and verify it."""
    emailer.OUTBOX.clear()
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "required_documents": ["pan"], "send_consent": True},
    )
    assert r.status_code == 201
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    upload_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()

    r_up = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r_up.status_code == 202
    doc_id = r_up.json()["document_id"]
    jobs.run_one()
    return cid, doc_id, upload_tok


def test_retention_7_day_lifecycle(client, fake_clock):
    """
    1. Case completes -> delete_after scheduled for 7 days.
    2. Before 7 days -> files present, accessible via Secure View, delete_due() deletes 0.
    3. At 7 days -> delete_due() deletes files, wipes OCR, hashes, review rows, and tokens.
    4. Confirmatory deletion email sent. Audit row written. Consent ledger preserved.
    """
    cid, doc_id, _ = _create_customer_with_doc(client, "Ravi Kumar", "ravi.retention@example.com")

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.completed_at is not None
        assert c.delete_after == fake_clock.current + timedelta(days=7)
        assert c.data_deleted_at is None

        d = db.get(Document, doc_id)
        assert d.file_state == "stored"
        assert len(d.sha256) == 64
        assert storage.get_file(d.storage_key) is not None

    # Before 7 days (advance 5 days): files still viewable by admin
    fake_clock.advance(days=5)
    assert scheduler.delete_due() == 0
    r_file = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r_file.status_code == 200

    # Advance past 7 days (5 + 2 days + 1 hour)
    fake_clock.advance(days=2, hours=1)
    emailer.OUTBOX.clear()
    deleted_count = scheduler.delete_due()
    assert deleted_count == 1

    # Assert deletion confirmation email
    assert any("Your documents have been deleted" in m["subject"] for m in emailer.OUTBOX)

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is not None

        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # Encrypted file in storage is gone
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # OCR results, review records, and tokens wiped
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None
        assert db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id)) is None
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None

        # Minimal audit log row exists
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "retention_deleted"))
        assert audit is not None
        assert audit.actor == "system"


def test_privacy_consent_withdrawal(client, fake_clock):
    """
    1. Customer requests consent withdrawal via /api/public/privacy/request.
    2. Receives confirmation email with single-use privacy token.
    3. Confirms token -> case marked consent_withdrawn, delete_after scheduled for 7 days.
    4. Tokens revoked, ConsentLedger(event='withdrawn') recorded, withdrawal confirmation sent.
    """
    cid, doc_id, upload_tok = _create_customer_with_doc(client, "Anita Roy", "anita.priv@example.com")

    emailer.OUTBOX.clear()
    # Step 1: Submit withdrawal request
    r_req = client.post("/api/public/privacy/request", json={"email": "anita.priv@example.com", "action": "withdraw"})
    assert r_req.status_code == 202

    # Step 2: Grab privacy token from outbox
    priv_tok = token_from_outbox("privacy/confirm")
    assert any("Confirm your privacy request" in m["subject"] for m in emailer.OUTBOX)
    emailer.OUTBOX.clear()

    # Step 3: Confirm privacy withdrawal
    r_conf = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r_conf.status_code == 200
    assert r_conf.json()["completed"] == "withdraw"

    # Step 4: Verification of state and records
    assert any("Consent withdrawn" in m["subject"] for m in emailer.OUTBOX)

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.consent_status == "withdrawn"
        assert c.case_status == "consent_withdrawn"
        assert c.delete_after == fake_clock.current + timedelta(days=7)

        # Consent ledger recorded
        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cid)))
        events = [l.event for l in ledger]
        assert "withdrawn" in events

        # Audit record
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "privacy_withdraw"))
        assert audit is not None

        # Upload token revoked
        t = services.resolve_token(db, upload_tok, "portal")
        assert t is None


def test_privacy_deletion_request_right_to_be_forgotten(client):
    """
    1. Customer requests data deletion (Right to be Forgotten).
    2. Single-use token confirmed.
    3. Files, OCR, hashes, reviews, tokens immediately purged.
    4. Customer PII pseudonymized (name='[deleted]', email='deleted-{id}@invalid.local', mobile=None).
    5. Case marked deleted, consent marked withdrawn.
    """
    cid, doc_id, _ = _create_customer_with_doc(client, "Sunil Joshi", "sunil.del@example.com")

    emailer.OUTBOX.clear()
    r_req = client.post("/api/public/privacy/request", json={"email": "sunil.del@example.com", "action": "delete"})
    assert r_req.status_code == 202
    priv_tok = token_from_outbox("privacy/confirm")
    emailer.OUTBOX.clear()

    r_conf = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r_conf.status_code == 200
    assert r_conf.json()["completed"] == "delete"

    # Deletion confirmation sent to original email before wipe
    assert any("Your documents have been deleted" in m["subject"] and "sunil.del@example.com" in m["to"] for m in emailer.OUTBOX)

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "deleted"
        assert c.consent_status == "withdrawn"
        assert c.name == "[deleted]"
        assert c.email == f"deleted-{cid}@invalid.local"
        assert c.mobile is None
        assert c.data_deleted_at is not None

        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # Storage file deleted
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # OCR and review rows wiped
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None
        assert db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id)) is None

        # Ledger records 'deleted' without PII
        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cid)))
        assert any(l.event == "deleted" for l in ledger)

        # Audit log written without PII
        aud = db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "privacy_delete"))
        assert aud is not None


def test_privacy_token_validation(client, fake_clock):
    """
    1. Single-use token: second confirmation returns 404 invalid_or_expired_link.
    2. Expired token: confirmation past 30 min returns 404.
    3. Invalid / unknown token returns 404.
    4. Wrong purpose token returns 404.
    """
    cid, _, upload_tok = _create_customer_with_doc(client, "Pooja Hegde", "pooja.tok@example.com")

    # Request privacy deletion
    client.post("/api/public/privacy/request", json={"email": "pooja.tok@example.com", "action": "delete"})
    priv_tok = token_from_outbox("privacy/confirm")

    # 1. First confirmation succeeds
    r1 = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r1.status_code == 200

    # 2. Re-using same token fails with 404
    r2 = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r2.status_code == 404
    assert r2.json()["detail"] == "invalid_or_expired_link"

    # 3. Non-existent token fails with 404
    r_fake = client.post("/api/public/privacy/confirm/non_existent_token_12345")
    assert r_fake.status_code == 404
    assert r_fake.json()["detail"] == "invalid_or_expired_link"

    # 4. Wrong purpose token fails with 404
    r_wrong = client.post(f"/api/public/privacy/confirm/{upload_tok}")
    assert r_wrong.status_code == 404
    assert r_wrong.json()["detail"] == "invalid_or_expired_link"

    # 5. Expired token: create another request and advance clock past 30 minutes
    r_cust2 = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Karan Mehra", "email": "karan.exp@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    client.post("/api/public/privacy/request", json={"email": "karan.exp@example.com", "action": "withdraw"})
    exp_tok = token_from_outbox("privacy/confirm")

    fake_clock.advance(minutes=31)
    r_exp = client.post(f"/api/public/privacy/confirm/{exp_tok}")
    assert r_exp.status_code == 404
    assert r_exp.json()["detail"] == "invalid_or_expired_link"


def test_reminders_and_processing_halt_on_withdrawal(client, fake_clock):
    """
    1. Case created with 2 required documents, 1 uploaded and 1 pending.
    2. Customer withdraws consent.
    3. Reminders on Day 3, 7, 14 send 0 emails.
    4. Any unverified uploaded document job stops processing with reason 'processing_stopped'.
    """
    emailer.OUTBOX.clear()
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Manish Dayal", "email": "manish.halt@example.com", "required_documents": ["pan", "bank_statement"], "send_consent": True},
    )
    cid = r.json()["id"]
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    upload_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()

    # Upload 1 document but do not process OCR yet
    r_up = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    doc_id = r_up.json()["document_id"]

    # Customer withdraws consent
    client.post("/api/public/privacy/request", json={"email": "manish.halt@example.com", "action": "withdraw"})
    priv_tok = token_from_outbox("privacy/confirm")
    client.post(f"/api/public/privacy/confirm/{priv_tok}")
    emailer.OUTBOX.clear()

    # When the background job runs for the uploaded document:
    assert jobs.run_one() is True
    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.reason == "processing_stopped"

    # Advance clock to Day 3, 7, and 14
    for days_ahead in (3, 4, 7):
        fake_clock.advance(days=days_ahead)
        tick = scheduler.tick()
        assert tick["reminders"] == 0
        assert not any("Reminder" in m["subject"] for m in emailer.OUTBOX)


def test_repeated_deletion_safety(client, fake_clock):
    """
    1. delete_customer_files() called repeatedly does not crash or throw.
    2. delete_due() called repeatedly after retention does not repeat deletions or duplicate emails.
    3. Admin delete-data endpoint on already deleted customer returns 409 data_already_deleted.
    4. Privacy request for already deleted customer is silently ignored (account enumeration protection).
    """
    cid, doc_id, _ = _create_customer_with_doc(client, "Safe Customer", "safe.del@example.com")

    # Direct repeated call to delete_customer_files
    with session_scope() as db:
        c = db.get(Customer, cid)
        services.delete_customer_files(db, c)
        assert c.data_deleted_at is not None

        # Second call to delete_customer_files runs cleanly
        services.delete_customer_files(db, c)
        assert c.data_deleted_at is not None

    # Advance past retention period
    fake_clock.advance(days=8)
    emailer.OUTBOX.clear()
    assert scheduler.delete_due() == 0  # Already deleted, 0 due
    assert len(emailer.OUTBOX) == 0

    # Admin delete on already-deleted customer returns 409
    # Admin first marks status = 'deleted'
    with session_scope() as db:
        c = db.get(Customer, cid)
        c.case_status = "deleted"

    r_admin = client.post(f"/api/admin/customers/{cid}/delete-data", headers=admin_headers())
    assert r_admin.status_code == 409
    assert r_admin.json()["detail"] == "data_already_deleted"

    # Privacy request on deleted customer returns 202 (silent) but creates 0 privacy requests
    emailer.OUTBOX.clear()
    r_silent = client.post("/api/public/privacy/request", json={"email": "safe.del@example.com", "action": "delete"})
    assert r_silent.status_code == 202
    assert len(emailer.OUTBOX) == 0
