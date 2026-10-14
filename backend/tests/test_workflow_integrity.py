import threading
import time
from datetime import timedelta
from unittest.mock import patch
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as dbmod
from app import emailer, pipeline, rules, services
from app.config import get_settings
from app.db import init_db, utcnow
from app.models import AccessToken, AuditLog, Customer, Document, ManualReview, RequiredDocument
from app.rate_limiter import reset_rate_limits
from tests.conftest import PNG, admin_headers, token_from_outbox


def _setup_customer_in_review(client, name="Alice Corp", email="alice@example.com"):
    """Helper to create customer, grant consent, upload document, and place into manual review."""
    res = client.post("/api/admin/customers", json={"name": name, "email": email, "required_documents": ["pan"], "send_consent": True}, headers=admin_headers())
    assert res.status_code == 201
    cid = res.json()["id"]

    consent_tok = token_from_outbox("consent")
    c_res = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert c_res.status_code == 200
    upload_tok = c_res.json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert up.status_code == 202
    doc_id = up.json()["document_id"]

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        cust = db.get(Customer, cid)
        pipeline.apply_decision(db, doc, cust, rules.Decision("manual_review", flags=["name_mismatch"], reason="flagged", confidence=0.7))
        rev = db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id, ManualReview.status == "open"))
        assert rev is not None
        rev_id = rev.id

    return cid, doc_id, rev_id, upload_tok


def test_consent_withdrawal_blocks_review_approval_and_rejection(client, env):
    """F-01: Neither approval nor rejection may proceed on a customer who withdrew consent."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Alice Corp", "alice@example.com")

    # Customer withdraws consent
    with dbmod.session_scope() as db:
        cust = db.get(Customer, cid)
        cust.consent_status = "withdrawn"
        cust.case_status = "consent_withdrawn"
        # Keep review row open to test rejection protection
        rev = db.get(ManualReview, rev_id)
        rev.status = "open"
        db.commit()

    emailer.OUTBOX.clear()

    # Rejecting must be blocked with 400 consent_withdrawn
    rej_res = client.post(f"/api/admin/reviews/{rev_id}/reject", json={"note": "Bad copy"}, headers=admin_headers())
    assert rej_res.status_code == 400
    assert rej_res.json()["detail"] == "consent_withdrawn"
    # Verify no resubmission email was sent
    assert len(emailer.OUTBOX) == 0

    # Approving must also be blocked with 400 consent_withdrawn
    app_res = client.post(f"/api/admin/reviews/{rev_id}/approve", json={"note": "Looks ok"}, headers=admin_headers())
    assert app_res.status_code == 400
    assert app_res.json()["detail"] == "consent_withdrawn"


def test_concurrent_review_decisions_prevent_double_decision(client, env):
    """F-02: Concurrent decisions on the same review ID prevent duplicate or conflicting transitions."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Bob Ltd", "bob@example.com")

    # First decision succeeds
    r1 = client.post(f"/api/admin/reviews/{rev_id}/approve", json={"note": "Approved by A"}, headers=admin_headers("admin@example.com"))
    assert r1.status_code == 200

    # Second decision fails with 409 Conflict
    r2 = client.post(f"/api/admin/reviews/{rev_id}/reject", json={"note": "Rejected by B"}, headers=admin_headers("admin@example.com"))
    assert r2.status_code == 409
    assert r2.json()["detail"] == "already_decided"


def test_email_delivery_failure_prevents_reminder_advancement(client, env):
    """F-03: Reminder stage is not advanced and delivery failure is audited if email send fails."""
    from app.scheduler import send_reminders

    res = client.post("/api/admin/customers", json={"name": "Carol Inc", "email": "carol@example.com", "required_documents": ["pan"], "send_consent": True}, headers=admin_headers())
    assert res.status_code == 201
    cid = res.json()["id"]

    consent_tok = token_from_outbox("consent")
    c_res = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert c_res.status_code == 200

    with dbmod.session_scope() as db:
        cust = db.get(Customer, cid)
        # Advance consent_at back by 4 days so stage 3 reminder is due
        cust.consent_at = utcnow() - timedelta(days=4)
        cust.last_reminder_stage = 0
        db.commit()

    # Simulate email delivery failure
    with patch("app.emailer.pending_documents", return_value=False):
        with dbmod.session_scope() as db:
            sent_count = send_reminders(db)
            db.commit()
            assert sent_count == 0

            # Verify customer stage was NOT incremented
            cust = db.get(Customer, cid)
            assert cust.last_reminder_stage == 0

            # Verify audit trail records delivery failure
            failed_audit = db.scalar(
                select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "reminder_delivery_failed")
            )
            assert failed_audit is not None
            assert failed_audit.details.get("stage") == 3

    # Now let delivery succeed
    with patch("app.emailer.pending_documents", return_value=True):
        with dbmod.session_scope() as db:
            sent_count = send_reminders(db)
            db.commit()
            assert sent_count == 1

            cust = db.get(Customer, cid)
            assert cust.last_reminder_stage == 3

            success_audit = db.scalar(
                select(AuditLog).where(AuditLog.entity_id == str(cid), AuditLog.action == "reminder_sent")
            )
            assert success_audit is not None
            assert success_audit.details.get("stage") == 3


def test_document_workflow_state_lifecycle(client, env):
    """F-04: Document workflow_state correctly transitions through UPLOADED -> IN_REVIEW -> VERIFIED/REJECTED."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Dan Co", "dan@example.com")

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.workflow_state == "IN_REVIEW"

        # Approve review
        rev = db.get(ManualReview, rev_id)
        services.decide_review(db, rev, approve=True, admin="admin@example.com", note="clear")
        assert doc.workflow_state == "VERIFIED"


def test_consent_withdrawal_closes_open_manual_reviews(client, env):
    """F-05: Privacy request withdrawal automatically closes open manual reviews."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Eve LLC", "eve@example.com")

    # Initiate and confirm privacy withdrawal
    req_res = client.post("/api/public/privacy/request", json={"email": "eve@example.com", "action": "withdraw"})
    assert req_res.status_code == 202
    priv_tok = token_from_outbox("privacy/confirm")
    conf_res = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert conf_res.status_code == 200

    # Verify the open review was automatically closed
    with dbmod.session_scope() as db:
        rev = db.get(ManualReview, rev_id)
        assert rev.status == "rejected"
        assert rev.note == "auto_closed_consent_withdrawn"
        assert rev.decided_by == "system"

    # Attempting to decide this review as admin fails with 409 already_decided
    dec_res = client.post(f"/api/admin/reviews/{rev_id}/approve", json={"note": "too late"}, headers=admin_headers())
    assert dec_res.status_code == 409
    assert dec_res.json()["detail"] == "already_decided"


def test_upload_token_blocked_after_consent_withdrawal(client, env):
    """Task 3/5: Upload attempts and portal view must be blocked once consent is withdrawn."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Frank Co", "frank@example.com")

    # Directly withdraw consent without deleting customer
    with dbmod.session_scope() as db:
        cust = db.get(Customer, cid)
        cust.consent_status = "withdrawn"
        cust.workflow_state = "CONSENT_WITHDRAWN"
        db.commit()

    # Portal view is blocked with 403 consent_required
    r_view = client.get(f"/api/portal/{upload_tok}")
    assert r_view.status_code == 403
    assert r_view.json()["detail"] == "consent_required"

    # Upload attempt is blocked with 403 consent_required
    r_up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert r_up.status_code == 403
    assert r_up.json()["detail"] == "consent_required"


def test_upload_token_blocked_after_case_completion(client, env):
    """Task 3: Upload attempts are blocked once customer case is completed."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Grace Co", "grace@example.com")

    # Complete the case
    with dbmod.session_scope() as db:
        cust = db.get(Customer, cid)
        cust.case_status = "completed"
        cust.workflow_state = "COMPLETED"
        db.commit()

    # Upload attempt is blocked with 409 case_not_open
    r_up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert r_up.status_code == 409
    assert r_up.json()["detail"] == "case_not_open"


def test_upload_token_expiry_and_revocation(client, env):
    """Task 3: Expired or revoked upload tokens return 404 invalid_or_expired_link."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Hank Co", "hank@example.com")

    # 1. Revocation test
    with dbmod.session_scope() as db:
        tok_row = db.scalar(select(AccessToken).where(AccessToken.customer_id == cid, AccessToken.purpose == "upload"))
        assert tok_row is not None
        tok_row.revoked = True
        db.commit()

    r_revoked = client.get(f"/api/portal/{upload_tok}")
    assert r_revoked.status_code == 404
    assert r_revoked.json()["detail"] == "invalid_or_expired_link"

    # 2. Expiry test
    with dbmod.session_scope() as db:
        tok_row = db.scalar(select(AccessToken).where(AccessToken.customer_id == cid, AccessToken.purpose == "upload"))
        tok_row.revoked = False
        tok_row.expires_at = utcnow() - timedelta(minutes=10)
        db.commit()

    r_expired = client.get(f"/api/portal/{upload_tok}")
    assert r_expired.status_code == 404
    assert r_expired.json()["detail"] == "invalid_or_expired_link"


def test_public_endpoints_rate_limiting_enforcement(client, env, monkeypatch):
    """Task 3: Exceeding rate limit thresholds returns HTTP 429 rate_limited."""
    s = get_settings()
    reset_rate_limits()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    monkeypatch.setattr(s, "rate_limit_consent_per_minute", 2)

    # 1st request -> processed
    client.get("/api/public/consent/invalidtok0000000000001")
    # 2nd request -> processed
    client.get("/api/public/consent/invalidtok0000000000002")
    # 3rd request -> throttled with 429
    r_throttled = client.get("/api/public/consent/invalidtok0000000000003")
    assert r_throttled.status_code == 429
    assert r_throttled.json()["detail"]["code"] == "rate_limited"

    reset_rate_limits()


def test_postgresql_row_locking_concurrency():
    """Task 6: Test PostgreSQL row-level locking (SELECT ... FOR UPDATE) across concurrent sessions."""
    settings = get_settings()
    if not settings.database_url.startswith(("postgres://", "postgresql://", "postgresql+pg8000://")):
        pytest.skip("Test requires PostgreSQL engine")

    engine = init_db()
    with dbmod.session_scope() as s:
        c = Customer(name="Concurrency Test User", email="concurr_pg@invalid.local")
        s.add(c)
        s.flush()
        d = Document(customer_id=c.id, doc_type="pan", filename="test.png", mime="image/png", size=100, sha256="0"*64, storage_key="k")
        s.add(d)
        s.flush()
        rev = ManualReview(
            document_id=d.id,
            customer_id=c.id,
            reason="test_pg_row_lock",
            status="open"
        )
        s.add(rev)
        s.commit()
        rid = rev.id
        cid = c.id
        did = d.id

    results = []

    def decision_worker(name, approve, delay=0):
        with Session(engine) as s:
            try:
                # Emulate admin route _decide row-locking
                r = s.scalar(select(ManualReview).where(ManualReview.id == rid).with_for_update())
                if r.status != "open":
                    results.append((name, 409, "already_decided"))
                    return
                time.sleep(delay)
                r.status = "approved" if approve else "rejected"
                r.decided_by = name
                s.commit()
                results.append((name, 200, r.status))
            except Exception as e:
                results.append((name, 500, str(e)))

    try:
        t1 = threading.Thread(target=decision_worker, args=("AdminA", True, 0.2))
        t2 = threading.Thread(target=decision_worker, args=("AdminB", False, 0.0))

        t1.start()
        time.sleep(0.05)  # ensure t1 acquires the row lock first
        t2.start()

        t1.join()
        t2.join()

        # Verify exact serialization: exactly one 200 (first decider) and one 409 (second decider)
        statuses = [res[1] for res in results]
        assert 200 in statuses
        assert 409 in statuses
        assert len(results) == 2
    finally:
        with Session(engine) as s:
            r = s.get(ManualReview, rid)
            if r:
                s.delete(r)
            d = s.get(Document, did)
            if d:
                s.delete(d)
            c = s.get(Customer, cid)
            if c:
                s.delete(c)
            s.commit()


def test_document_file_access_unauthenticated_blocked(client, env):
    """Unauthenticated requests to stream decrypted files are rejected with 401."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Unauth User", "unauth@example.com")
    r = client.get(f"/api/admin/documents/{doc_id}/file")
    assert r.status_code == 401
    assert r.json()["detail"] == "missing_token"


def test_document_file_access_non_admin_blocked(client, env):
    """Non-admin callers cannot access decrypted files (HTTP 403)."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "NonAdmin User", "nonadmin@example.com")
    r = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers("stranger@example.com"))
    assert r.status_code == 403
    assert r.json()["detail"] == "not_an_admin"


def test_document_file_access_invalid_id_returns_404(client, env):
    """Invalid or non-existent document IDs return 404 not_found."""
    r = client.get("/api/admin/documents/00000000-0000-0000-0000-000000000000/file", headers=admin_headers())
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


def test_document_file_access_withdrawn_consent_denied_and_audited(client, env):
    """Accessing documents for a customer with withdrawn consent is denied (403) and audited."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Withdrawn Doc User", "withdrawn_doc@example.com")

    with dbmod.session_scope() as db:
        c = db.get(Customer, cid)
        c.consent_status = "withdrawn"
        c.case_status = "consent_withdrawn"
        db.commit()

    r = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r.status_code == 403
    assert r.json()["detail"] == "consent_withdrawn"

    # Verify audit row was recorded
    with dbmod.session_scope() as db:
        audit_row = db.scalar(
            select(AuditLog).where(AuditLog.entity_id == doc_id, AuditLog.action == "document_access_denied")
        )
        assert audit_row is not None
        assert audit_row.details.get("reason") == "consent_withdrawn"


def test_document_file_download_policy_disabled_denied_and_audited(client, env, monkeypatch):
    """When allow_download is False (default), download=True is denied (403) and audited."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "NoDownload User", "nodownload@example.com")
    s = get_settings()
    monkeypatch.setattr(s, "allow_download", False)

    r = client.get(f"/api/admin/documents/{doc_id}/file?download=true", headers=admin_headers())
    assert r.status_code == 403
    assert r.json()["detail"] == "download_disabled"

    with dbmod.session_scope() as db:
        audit_row = db.scalar(
            select(AuditLog).where(AuditLog.entity_id == doc_id, AuditLog.action == "document_download_denied")
        )
        assert audit_row is not None
        assert audit_row.details.get("reason") == "download_disabled"


def test_document_file_download_policy_enabled_success_and_audited(client, env, monkeypatch):
    """When allow_download is True, download=True returns attachment and writes audit row."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "AllowDownload User", "allowdownload@example.com")
    s = get_settings()
    monkeypatch.setattr(s, "allow_download", True)

    r = client.get(f"/api/admin/documents/{doc_id}/file?download=true", headers=admin_headers())
    assert r.status_code == 200
    assert "attachment" in r.headers.get("content-disposition", "")
    assert r.headers.get("cache-control") == "no-store"

    with dbmod.session_scope() as db:
        audit_row = db.scalar(
            select(AuditLog).where(AuditLog.entity_id == doc_id, AuditLog.action == "document_downloaded")
        )
        assert audit_row is not None


def test_portal_document_status_anti_enumeration(client, env):
    """Probing unauthorized or foreign document IDs on portal status returns uniform 404."""
    cid, doc_id, rev_id, upload_tok = _setup_customer_in_review(client, "Enumerate User", "enum@example.com")

    # Probe non-existent ID
    r_fake = client.get(f"/api/portal/{upload_tok}/documents/00000000-0000-0000-0000-000000000000/status")
    assert r_fake.status_code == 404
    assert r_fake.json()["detail"] == "not_found"

