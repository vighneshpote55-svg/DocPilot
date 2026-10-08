"""
Phase 6 Step 3: Email Failure, Retry, Resilience & Recovery Test Suite.

Verifies:
1. SMTP connection failure handling.
2. SMTP timeout handling.
3. SMTP connection reset/network failure handling.
4. Email send failure during consent creation.
5. Email send failure during reminder dispatch.
6. Email send failure during manual review resubmission.
7. Email send failure during case completion.
8. Email send failure during privacy deletion / withdrawal.
9. Retry and backoff execution behavior (up to 3 attempts).
10. Underlying customer workflow integrity preserved on email failure (no corrupt rollbacks).
11. Successful retry sends exactly one email.
12. Repeated scheduler execution does not create duplicate emails.
13. Safe logging without credentials, secrets, tokens, or raw PII.
14. Worker/scheduler continues processing subsequent customers after one email failure.
15. SMTP recovery restores normal email delivery.
16. No customer remains permanently stuck due to email delivery issues.
"""
from datetime import timedelta
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import select

from app import db as dbmod, emailer, models, scheduler, services
from app.config import get_settings
from tests.conftest import admin_headers

pytestmark = pytest.mark.usefixtures("env")


# 1, 2, 3, 9. SMTP connection failure, timeout, reset, and retry behavior
def test_smtp_connection_failure_and_retries(monkeypatch):
    """Verify SMTP connection refused retries 3 times and returns False without crashing."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_smtp.side_effect = ConnectionRefusedError("Connection refused by SMTP server")
        with patch("time.sleep") as mock_sleep:
            success = emailer.send_email("user@example.com", "Subject", "Body")
            assert success is False
            assert mock_smtp.call_count == 3
            assert mock_sleep.call_count == 2  # Backoff sleep between retries


def test_smtp_timeout_handling(monkeypatch):
    """Verify SMTP timeout retries and fails safely."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_instance.send_message.side_effect = TimeoutError("SMTP connection timed out")
        mock_smtp.return_value.__enter__.return_value = mock_instance
        with patch("time.sleep"):
            success = emailer.send_email("user@example.com", "Subject", "Body")
            assert success is False
            assert mock_instance.send_message.call_count == 3


def test_smtp_network_reset_and_successful_retry(monkeypatch):
    """Verify 1st attempt failure with 2nd attempt success sends exactly 1 email."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_instance.send_message.side_effect = [
            ConnectionResetError("Connection reset by peer"),
            None,  # Success on 2nd attempt
        ]
        mock_smtp.return_value.__enter__.return_value = mock_instance
        with patch("time.sleep"):
            success = emailer.send_email("user@example.com", "Subject", "Body")
            assert success is True
            assert mock_instance.send_message.call_count == 2


# 4, 10. Consent creation workflow integrity on email failure
def test_email_failure_during_consent_preserves_workflow(client):
    """When consent email fails to send, customer & token are created safely in DB."""
    with patch("app.emailer.send_email", return_value=False):
        r = client.post(
            "/api/admin/customers",
            headers=admin_headers(),
            json={
                "name": "Consent Fail Customer",
                "email": "consent_fail@example.com",
                "required_documents": ["pan"],
                "send_consent": True,
            },
        )
    assert r.status_code == 201
    cid = r.json()["id"]

    # Customer exists, token exists, not stuck
    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cid)
        assert c is not None
        assert c.case_status == "awaiting_consent"
        assert c.consent_status == "pending"

        tok = s.scalar(select(models.AccessToken).where(models.AccessToken.customer_id == cid))
        assert tok is not None
        assert tok.purpose == "consent"


# 5, 14. Email failure during reminder & worker continuation
def test_reminder_failure_allows_worker_continuation():
    """If customer A's reminder email fails, scheduler continues and processes customer B."""
    with dbmod.session_scope() as s:
        # Customer A (will fail email)
        cA = models.Customer(
            name="Customer A",
            email="cust_a@example.com",
            case_status="in_progress",
            consent_status="granted",
            consent_at=dbmod.utcnow() - timedelta(days=5),
            last_reminder_stage=0,
            workflow_state="IN_PROGRESS",
        )
        s.add(cA)
        s.flush()
        s.add(models.RequiredDocument(customer_id=cA.id, doc_type="pan"))

        # Customer B (will succeed email)
        cB = models.Customer(
            name="Customer B",
            email="cust_b@example.com",
            case_status="in_progress",
            consent_status="granted",
            consent_at=dbmod.utcnow() - timedelta(days=5),
            last_reminder_stage=0,
            workflow_state="IN_PROGRESS",
        )
        s.add(cB)
        s.flush()
        s.add(models.RequiredDocument(customer_id=cB.id, doc_type="pan"))
        s.commit()
        cidA, cidB = cA.id, cB.id

    def mock_send(to, subject, body):
        if "cust_a" in to:
            return False  # Customer A fails
        emailer.OUTBOX.append({"to": to, "subject": subject, "body": body})
        return True

    with patch("app.emailer.send_email", side_effect=mock_send):
        with dbmod.session_scope() as s:
            sent_count = scheduler.send_reminders(s)
            s.commit()

    # Scheduler did not crash; customer B received reminder
    assert sent_count >= 1
    assert any("cust_b" in e["to"] for e in emailer.OUTBOX)


# 6, 10. Email failure during resubmission preserves review rejection
def test_resubmission_failure_preserves_review_rejection():
    """Manual review rejection commits to DB even if resubmission email fails."""
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Resubmit Fail User",
            email="resubmit_fail@example.com",
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
        doc_id = doc.id

    with patch("app.emailer.send_email", return_value=False):
        with dbmod.session_scope() as s:
            rev = s.get(models.ManualReview, rev_id)
            services.decide_review(s, rev, approve=False, admin="admin@example.com", note="Blurry corner")
            s.commit()

    # Document and review are cleanly rejected despite email failure
    with dbmod.session_scope() as s:
        doc = s.get(models.Document, doc_id)
        rev = s.get(models.ManualReview, rev_id)
        assert doc.verification_status == "rejected"
        assert rev.status == "rejected"


# 7, 10. Email failure during completion preserves case completion
def test_completion_email_failure_preserves_completion():
    """Case is marked completed and retention scheduled even if completion email fails."""
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Complete Fail User",
            email="complete_fail@example.com",
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

    with patch("app.emailer.send_email", return_value=False):
        with dbmod.session_scope() as s:
            c = s.get(models.Customer, cid)
            services.recalc_case(s, c)
            s.commit()

    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"
        assert c.delete_after is not None


# 8, 10. Email failure during privacy confirmation preserves data deletion
def test_privacy_email_failure_preserves_data_deletion():
    """Privacy deletion executes and purges files even if deletion confirmation email fails."""
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Privacy Fail User",
            email="privacy_fail@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.commit()
        cid = c.id
        services.start_privacy_request(s, "privacy_fail@example.com", "delete")
        s.commit()

    # Find token
    confirm_email = next(e for e in reversed(emailer.OUTBOX) if "Confirm your privacy request" in e["subject"])
    del_token = confirm_email["body"].split("/privacy/confirm/")[1].split()[0]

    with patch("app.emailer.send_email", return_value=False):
        with dbmod.session_scope() as s:
            action = services.confirm_privacy_request(s, del_token)
            s.commit()

    assert action == "delete"
    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cid)
        assert c.case_status == "deleted"
        assert c.workflow_state == "DELETED"
        assert c.name == "[deleted]"


# 12. Repeated scheduler execution does not create duplicates
def test_repeated_scheduler_ticks_no_duplicate_emails():
    """Multiple scheduler runs do not duplicate emails."""
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = models.Customer(
            name="Dup Guard User",
            email="dupguard@example.com",
            case_status="in_progress",
            consent_status="granted",
            consent_at=dbmod.utcnow() - timedelta(days=4),
            last_reminder_stage=0,
            workflow_state="IN_PROGRESS",
        )
        s.add(c)
        s.flush()
        s.add(models.RequiredDocument(customer_id=c.id, doc_type="pan"))
        s.commit()

    with dbmod.session_scope() as s:
        scheduler.send_reminders(s)
        s.commit()

    initial_count = len([e for e in emailer.OUTBOX if "dupguard@example.com" in e["to"]])
    assert initial_count == 1

    # Second and third tick
    with dbmod.session_scope() as s:
        scheduler.send_reminders(s)
        s.commit()
    with dbmod.session_scope() as s:
        scheduler.send_reminders(s)
        s.commit()

    final_count = len([e for e in emailer.OUTBOX if "dupguard@example.com" in e["to"]])
    assert final_count == 1


# 13. Safe logging without credentials or unmasked PII
def test_email_failures_logged_safely(monkeypatch):
    """Verify failed emails log masked recipient and subject without leaking secrets or tokens."""
    s = get_settings()
    monkeypatch.setattr(s, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(s, "smtp_port", 587)
    monkeypatch.setattr(s, "smtp_user", "apikey_username")
    monkeypatch.setattr(s, "smtp_password", "super_secret_smtp_pass")

    with patch.object(emailer.log, "warning") as mock_warn, patch.object(emailer.log, "exception") as mock_exc:
        with patch("smtplib.SMTP") as mock_smtp:
            mock_smtp.side_effect = Exception("Auth failed for user")
            with patch("time.sleep"):
                res = emailer.send_email("sensitive.customer@example.com", "Test Subject", "Private body with token abc123xyz")
                assert res is False

        # Gather all logged strings across format args
        logged_items = []
        for call_obj in mock_warn.call_args_list + mock_exc.call_args_list:
            args, _ = call_obj
            for arg in args:
                logged_items.append(str(arg))

        log_text = " ".join(logged_items)
        assert "super_secret_smtp_pass" not in log_text
        assert "sensitive.customer@example.com" not in log_text
        assert "s***@example.com" in log_text  # Masked recipient
        assert "Private body with token" not in log_text
        assert "Test Subject" in log_text


# 15. SMTP recovery restores normal delivery
def test_smtp_recovery_restores_email_delivery(monkeypatch):
    """When SMTP recovers from failure, subsequent emails deliver normally."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        # First call fails
        mock_smtp.side_effect = ConnectionRefusedError("Down")
        with patch("time.sleep"):
            res1 = emailer.send_email("user1@example.com", "Subj 1", "Body 1")
            assert res1 is False

        # Service recovers
        mock_instance = MagicMock()
        mock_smtp.side_effect = None
        mock_smtp.return_value.__enter__.return_value = mock_instance
        res2 = emailer.send_email("user2@example.com", "Subj 2", "Body 2")
        assert res2 is True
        mock_instance.send_message.assert_called_once()
