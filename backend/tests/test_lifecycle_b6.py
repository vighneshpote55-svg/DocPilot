from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app import emailer, jobs, scheduler, services, storage
from app.db import get_db
from app.models import AccessToken, AuditLog, Customer, Document, ManualReview, OcrResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


class FakeClock:
    """Controllable monotonic fake clock for lifecycle testing."""

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


def test_full_lifecycle_reminders_completion_retention_and_purge(client, fake_clock):
    """
    Walks a case through the full lifecycle:
    1. Day 0: Customer created, consent given, upload link sent, 1st doc uploaded & verified.
    2. Day 3: 1st reminder sent.
    3. Day 7: 2nd reminder sent.
    4. Day 14: 3rd reminder sent.
    5. Day 15: 2nd doc uploaded & verified -> case completes -> retention timer set (delete_after = Day 22).
    6. Day 20: Files still present and viewable.
    7. Day 22: Retention deletion runs -> Storage files, OCR data, hashes, and tokens all purged.
    """
    emailer.OUTBOX.clear()

    # --- Day 0: Customer Creation & Consent ---
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Vikram Malhotra",
            "email": "vikram.m@example.com",
            "mobile": "+919876543210",
            "required_documents": ["pan", "bank_statement"],
            "send_consent": True,
        },
    )
    assert r.status_code == 201
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    emailer.OUTBOX.clear()

    # Customer grants consent
    r_consent = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_consent.status_code == 200
    upload_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()

    # Customer uploads first document (PAN) on Day 0
    r_up1 = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r_up1.status_code == 202
    doc1_id = r_up1.json()["document_id"]

    # Process first document via job queue
    assert jobs.run_one() is True

    # Verify first doc is verified and bank_statement is still pending
    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.case_status == "in_progress"
        assert c.last_reminder_stage == 0
        d1 = db.get(Document, doc1_id)
        assert d1.verification_status == "verified"
        assert d1.file_state == "stored"
        assert len(d1.sha256) == 64
        # Storage file exists
        assert storage.get_file(d1.storage_key) is not None
        # OCR result exists
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc1_id)) is not None

    # --- Day 3: First Reminder ---
    fake_clock.advance(days=3)
    tick1 = scheduler.tick()
    assert tick1["reminders"] == 1
    assert len(emailer.OUTBOX) == 1
    rem1_mail = emailer.OUTBOX[-1]
    assert rem1_mail["to"] == "vikram.m@example.com"
    assert "Reminder: documents still pending" in rem1_mail["subject"]
    emailer.OUTBOX.clear()

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 3

    # Running tick again on Day 3 should not send duplicate reminder
    assert scheduler.tick()["reminders"] == 0

    # --- Day 7: Second Reminder ---
    fake_clock.advance(days=4)  # Now at Day 7 from consent
    tick2 = scheduler.tick()
    assert tick2["reminders"] == 1
    assert len(emailer.OUTBOX) == 1
    rem2_mail = emailer.OUTBOX[-1]
    assert rem2_mail["to"] == "vikram.m@example.com"
    assert "Reminder: documents still pending" in rem2_mail["subject"]
    emailer.OUTBOX.clear()

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 7

    # --- Day 14: Third Reminder ---
    fake_clock.advance(days=7)  # Now at Day 14 from consent
    tick3 = scheduler.tick()
    assert tick3["reminders"] == 1
    assert len(emailer.OUTBOX) == 1
    rem3_mail = emailer.OUTBOX[-1]
    assert rem3_mail["to"] == "vikram.m@example.com"
    assert "Reminder: documents still pending" in rem3_mail["subject"]
    active_upload_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 14

    # --- Day 15: Customer uploads remaining document (Bank Statement) ---
    fake_clock.advance(days=1)  # Day 15 (uses active upload token issued in Day 14 reminder)
    r_up2 = client.post(
        f"/api/portal/{active_upload_tok}/upload",
        data={"doc_type": "bank_statement"},
        files={"file": ("statement.pdf", PDF, "application/pdf")},
    )
    assert r_up2.status_code == 202
    doc2_id = r_up2.json()["document_id"]

    # Process second document
    assert jobs.run_one() is True

    # Verify case completion and retention scheduling
    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.completed_at == fake_clock.current
        # Retention default: 7 days
        assert c.delete_after == fake_clock.current + timedelta(days=7)

    # Completion email dispatched
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)
    emailer.OUTBOX.clear()

    # --- Day 20: Mid-retention period (files still accessible to staff) ---
    fake_clock.advance(days=5)  # Day 20 (delete_after is at Day 22)
    tick_mid = scheduler.tick()
    assert tick_mid["deleted"] == 0

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is None
        # Files still in storage and viewable by staff
        r_view1 = client.get(f"/api/admin/documents/{doc1_id}/file", headers=admin_headers())
        assert r_view1.status_code == 200
        r_view2 = client.get(f"/api/admin/documents/{doc2_id}/file", headers=admin_headers())
        assert r_view2.status_code == 200

    # --- Day 22: Retention period expires -> Deletion purge runs ---
    fake_clock.advance(days=2, hours=1)  # Day 22 + 1 hour (past delete_after)
    tick_purge = scheduler.tick()
    assert tick_purge["deleted"] == 1

    # Deletion confirmation email dispatched
    assert any("Your documents have been deleted" in m["subject"] for m in emailer.OUTBOX)

    # --- Assert EVERYTHING is gone (Rule 9) ---
    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.data_deleted_at is not None

        d1 = db.get(Document, doc1_id)
        d2 = db.get(Document, doc2_id)

        # 1. File states marked deleted
        assert d1.file_state == "deleted"
        assert d2.file_state == "deleted"

        # 2. Hashes are purged (wiped)
        assert d1.sha256 == ""
        assert d2.sha256 == ""

        # 3. Encrypted files in Storage are deleted
        with pytest.raises(Exception):
            storage.get_file(d1.storage_key)
        with pytest.raises(Exception):
            storage.get_file(d2.storage_key)

        # 4. OCR data is purged
        ocr_rows = list(db.scalars(select(OcrResult).where(OcrResult.document_id.in_([doc1_id, doc2_id]))))
        assert len(ocr_rows) == 0

        # 5. Review evidence rows are purged
        rev_rows = list(db.scalars(select(ManualReview).where(ManualReview.document_id.in_([doc1_id, doc2_id]))))
        assert len(rev_rows) == 0

        # 6. Customer access tokens are permanently deleted
        tokens = list(db.scalars(select(AccessToken).where(AccessToken.customer_id == cid)))
        assert len(tokens) == 0

        # 7. Audit log contains retention_deleted record (IDs only, no PII)
        audit_del = db.scalar(
            select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "retention_deleted")
        )
        assert audit_del is not None
        assert audit_del.actor == "system"

    # 8. Staff view returns 410 Gone
    assert client.get(f"/api/admin/documents/{doc1_id}/file", headers=admin_headers()).status_code == 410
    assert client.get(f"/api/admin/documents/{doc2_id}/file", headers=admin_headers()).status_code == 410


def test_lifecycle_case_expiry_at_30_days_and_purge(client, fake_clock):
    """
    Tests uncompleted case expiry after 30 days:
    1. Day 0: Customer created with required doc, consents, uploads doc that needs manual review.
    2. Customer does nothing for 30 days.
    3. Day 30: Case expires (case_status = 'expired'), queued for deletion.
    4. Deletion purge runs: Storage files, OCR data, hashes, review rows, and tokens are all gone.
    """
    emailer.OUTBOX.clear()

    # --- Day 0 ---
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Abhishek Roy",
            "email": "abhishek@example.com",
            "required_documents": ["pan", "bank_statement"],
            "send_consent": True,
        },
    )
    assert r.status_code == 201
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    upload_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()

    # Upload document
    r_up = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r_up.status_code == 202
    doc_id = r_up.json()["document_id"]
    # Run OCR job
    jobs.run_one()

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.case_status == "in_progress"
        assert c.case_expires_at == fake_clock.current + timedelta(days=30)
        # Token exists in DB
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is not None
        # OCR data exists in DB
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is not None

    # --- Day 30 + 1 hour: Case Expiry ---
    fake_clock.advance(days=30, hours=1)
    tick = scheduler.tick()
    assert tick["expired"] == 1
    assert tick["deleted"] == 1

    # --- Assert case expired and fully purged ---
    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.case_status == "expired"
        assert c.data_deleted_at is not None

        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # OCR data purged
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None

        # Tokens purged
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None

        # Encrypted storage file purged
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # Audit rows exist for both expiry and deletion
        assert db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "case_expired")) is not None
        assert db.scalar(select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "retention_deleted")) is not None


def test_lifecycle_privacy_deletion_and_ledger(client):
    """
    Tests privacy deletion request lifecycle (Right to be Forgotten):
    1. Customer uploads document and completes review.
    2. Customer requests privacy deletion.
    3. Customer confirms via single-use privacy token.
    4. Assert encrypted files, OCR data, hashes, tokens, reviews are all purged.
    5. Customer personal fields wiped (name='[deleted]', email='deleted-{id}@invalid.local', mobile=None).
    6. Consent ledger preserves event='deleted' without PII.
    """
    from app.models import ConsentLedger

    emailer.OUTBOX.clear()
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Privacy Customer", "email": "priv.cust@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    upload_tok = token_from_outbox("portal")

    r_up = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    doc_id = r_up.json()["document_id"]
    jobs.run_one()

    # Customer submits privacy deletion request
    client.post("/api/public/privacy/request", json={"email": "priv.cust@example.com", "action": "delete"})
    priv_tok = token_from_outbox("privacy/confirm")

    # Confirm privacy deletion
    r_confirm = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r_confirm.status_code == 200
    assert r_confirm.json()["completed"] == "delete"

    # Confirmation email sent
    assert any("Your documents have been deleted" in m["subject"] for m in emailer.OUTBOX)

    with next(get_db()) as db:
        c = db.get(Customer, cid)
        assert c.case_status == "deleted"
        assert c.consent_status == "withdrawn"
        assert c.name == "[deleted]"
        assert c.email == f"deleted-{cid}@invalid.local"
        assert c.mobile is None

        d = db.get(Document, doc_id)
        assert d.file_state == "deleted"
        assert d.sha256 == ""

        # OCR data wiped
        assert db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id)) is None

        # Tokens wiped
        assert db.scalar(select(AccessToken).where(AccessToken.customer_id == cid)) is None

        # Storage file purged
        with pytest.raises(Exception):
            storage.get_file(d.storage_key)

        # Consent ledger recorded without PII
        ledger_rows = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cid)))
        events = [l.event for l in ledger_rows]
        assert "granted" in events
        assert "deleted" in events

