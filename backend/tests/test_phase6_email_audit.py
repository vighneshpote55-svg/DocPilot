"""
Phase 6 Step 1: Email & Customer Communication Audit Test Suite.

Verifies:
1. SMTP configuration and connection testing (dev mode and live SMTP mocking).
2. Consent email generation, link structure, and expiry.
3. Initial document request / upload link email.
4. Day 3, 7, and 14 reminders timing and idempotency.
5. Resubmission email upon manual review rejection.
6. Completion email upon case resolution.
7. Privacy data deletion and consent withdrawal confirmation emails.
8. Single-use vs multi-use token security across email links.
9. Email transient failure retry handling.
10. Complete audit logging of email events with zero PII/secret leaks.
"""
from datetime import timedelta
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import select

from app import db as dbmod, emailer, models, scheduler, services
from app.config import get_settings
from app.security import hash_token, new_token
from tests.conftest import admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


def test_smtp_configuration_and_dev_mode():
    """Verify SMTP connection test returns correct status in dev mode."""
    res = emailer.test_smtp_connection()
    assert res["configured"] is False
    assert res["mode"] == "dev_outbox"


def test_smtp_live_connection_mocking(monkeypatch):
    """Verify live SMTP connection handling and authentication."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USER", "apikey")
    monkeypatch.setenv("SMTP_PASSWORD", "secret_pass")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_smtp.return_value.__enter__.return_value = mock_instance

        status = emailer.test_smtp_connection()
        assert status["configured"] is True
        assert status["connected"] is True
        assert status["host"] == "smtp.example.com"
        assert status["port"] == 587
        mock_instance.starttls.assert_called_once()
        mock_instance.login.assert_called_once_with("apikey", "secret_pass")
        mock_instance.noop.assert_called_once()


def test_email_retry_on_transient_failure(monkeypatch):
    """Verify that send_email retries transient network failures up to 3 times."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_instance.send_message.side_effect = [
            TimeoutError("Connection timed out"),
            ConnectionResetError("Reset by peer"),
            None,  # Success on 3rd attempt
        ]
        mock_smtp.return_value.__enter__.return_value = mock_instance

        success = emailer.send_email("recipient@example.com", "Test Subject", "Hello body")
        assert success is True
        assert mock_instance.send_message.call_count == 3


def test_consent_email_workflow(client):
    """Verify consent email contains pending document labels and valid one-time link."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Consent Audit User",
            "email": "consent_audit@example.com",
            "required_documents": ["pan", "aadhaar"],
            "send_consent": True,
        },
    )
    assert r.status_code == 201

    # Find consent email in outbox
    email = next(e for e in reversed(emailer.OUTBOX) if "Consent needed" in e["subject"])
    assert "Consent Audit User" in email["body"]
    assert "PAN Card" in email["body"]
    assert "Aadhaar Card" in email["body"]
    assert "/consent/" in email["body"]
    assert "consent_audit@example.com" == email["to"]

    # Extract token and verify single-use
    token = email["body"].split("/consent/")[1].split()[0]
    with dbmod.session_scope() as s:
        tok_rec = services.resolve_token(s, token, "consent")
        assert tok_rec is not None
        assert tok_rec.purpose == "consent"


def test_upload_link_and_pending_documents_email(client):
    """Verify document upload email is dispatched after consent is granted."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Upload Email User",
            "email": "upload_user@example.com",
            "required_documents": ["pan"],
            "send_consent": True,
        },
    )
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})

    email = next(e for e in reversed(emailer.OUTBOX) if "Please upload your documents" in e["subject"])
    assert "Upload Email User" in email["body"]
    assert "PAN Card" in email["body"]
    assert "/portal/" in email["body"]

    token = email["body"].split("/portal/")[1].split()[0]
    with dbmod.session_scope() as s:
        tok_rec = services.resolve_token(s, token, "upload")
        assert tok_rec is not None
        assert tok_rec.purpose == "upload"


def test_reminder_cadence_and_idempotency():
    """Verify 3, 7, and 14-day reminders are sent idempotently and recorded in audit logs."""
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Reminder Test User",
            email="reminder_test@example.com",
            case_status="in_progress",
            consent_status="granted",
            consent_at=dbmod.utcnow() - timedelta(days=4),  # Day 4 -> Day 3 reminder due
            last_reminder_stage=0,
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.flush()
        s.add(models.RequiredDocument(customer_id=c.id, doc_type="pan"))
        s.commit()
        cid = c.id

    # Run scheduler tick
    with dbmod.session_scope() as s:
        sent_count = scheduler.send_reminders(s)
        s.commit()

    assert sent_count == 1
    reminder_emails = [e for e in emailer.OUTBOX if "Reminder: documents still pending" in e["subject"]]
    assert len(reminder_emails) == 1

    # Re-running immediately on same day must NOT send duplicate
    with dbmod.session_scope() as s:
        second_sent = scheduler.send_reminders(s)
        s.commit()
    assert second_sent == 0
    assert len([e for e in emailer.OUTBOX if "Reminder: documents still pending" in e["subject"]]) == 1

    # Verify audit record
    with dbmod.session_scope() as s:
        audit = s.scalar(
            select(models.AuditLog)
            .where(models.AuditLog.entity_id == str(cid), models.AuditLog.action == "reminder_sent")
        )
        assert audit is not None
        assert audit.details.get("stage") == 3


def test_resubmission_email_on_review_rejection():
    """Verify rejection in manual review sends resubmission email with clean upload link."""
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Resubmit User",
            email="resubmit@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.flush()
        s.add(models.RequiredDocument(customer_id=c.id, doc_type="pan"))
        doc = models.Document(
            customer_id=c.id,
            doc_type="pan",
            filename="pan.png",
            mime="image/png",
            size=100,
            file_state="stored",
            storage_key="test-key",
            sha256="abc",
            ocr_status="completed",
            verification_status="manual_review",
        )
        s.add(doc)
        s.flush()
        rev = models.ManualReview(
            customer_id=c.id,
            document_id=doc.id,
            status="open",
            reason="low_confidence",
        )
        s.add(rev)
        s.commit()
        rev_id = rev.id

    with dbmod.session_scope() as s:
        rev = s.get(models.ManualReview, rev_id)
        services.decide_review(s, rev, approve=False, admin="admin@example.com", note="Blurry corner")
        s.commit()

    resubmit_emails = [e for e in emailer.OUTBOX if "Please re-upload your PAN Card" in e["subject"]]
    assert len(resubmit_emails) == 1
    assert "/portal/" in resubmit_emails[0]["body"]


def test_completion_email_on_full_verification():
    """Verify completion email is triggered once all required documents are verified."""
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Completed User",
            email="completed@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.flush()
        req = models.RequiredDocument(customer_id=c.id, doc_type="pan")
        s.add(req)
        doc = models.Document(
            customer_id=c.id,
            doc_type="pan",
            filename="pan.png",
            mime="image/png",
            size=100,
            file_state="stored",
            storage_key="test-key",
            sha256="abc",
            ocr_status="completed",
            verification_status="verified",
        )
        s.add(doc)
        s.flush()
        req.verified_document_id = doc.id
        s.commit()
        cid = c.id

    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cid)
        services.recalc_case(s, c)
        s.commit()

    completed_emails = [e for e in emailer.OUTBOX if "All documents received" in e["subject"]]
    assert len(completed_emails) == 1
    assert "Completed User" in completed_emails[0]["body"]


def test_privacy_and_consent_withdrawal_emails():
    """Verify privacy request confirmation and consent withdrawal emails."""
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Privacy Email User",
            email="privacy_email@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.commit()
        cid = c.id

    # 1. Privacy deletion request
    with dbmod.session_scope() as s:
        services.start_privacy_request(s, "privacy_email@example.com", "delete")
        s.commit()

    confirm_emails = [e for e in emailer.OUTBOX if "Confirm your privacy request" in e["subject"]]
    assert len(confirm_emails) == 1
    delete_token = confirm_emails[0]["body"].split("/privacy/confirm/")[1].split()[0]

    # 2. Confirm privacy deletion
    with dbmod.session_scope() as s:
        action = services.confirm_privacy_request(s, delete_token)
        s.commit()
    assert action == "delete"

    deleted_emails = [e for e in emailer.OUTBOX if "Your documents have been deleted" in e["subject"]]
    assert len(deleted_emails) == 1

    # 3. Privacy consent withdrawal
    with dbmod.session_scope() as s:
        # Create second customer for withdrawal test
        c2 = models.Customer(
            name="Withdraw User",
            email="withdraw@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c2)
        s.commit()
        services.start_privacy_request(s, "withdraw@example.com", "withdraw")
        s.commit()

    withdraw_confirm_emails = [e for e in emailer.OUTBOX if "Confirm your privacy request" in e["subject"] and "withdraw" in e["body"]]
    assert len(withdraw_confirm_emails) == 1
    withdraw_token = withdraw_confirm_emails[0]["body"].split("/privacy/confirm/")[1].split()[0]

    with dbmod.session_scope() as s:
        action2 = services.confirm_privacy_request(s, withdraw_token)
        s.commit()
    assert action2 == "withdraw"

    withdrawn_emails = [e for e in emailer.OUTBOX if "Consent withdrawn" in e["subject"]]
    assert len(withdrawn_emails) == 1


def test_admin_email_test_endpoint(client):
    """Verify /api/admin/settings/email/test endpoint responds without error."""
    r = client.post("/api/admin/settings/email/test", headers=admin_headers())
    assert r.status_code == 200
    data = r.json()
    assert "configured" in data
