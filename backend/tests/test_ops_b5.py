import json
import logging
from unittest.mock import MagicMock, patch

import pytest
from alembic import command
from alembic.config import Config

from app import emailer, jobs, services
from app.config import get_settings
from app.db import Base, get_db, init_db, run_migrations
from app.jobs import alert_failed_job, clear_alert_hooks, register_alert_hook
from app.logging_conf import (
    PiiSanitizingFilter,
    StructuredJsonFormatter,
    sanitize_data,
    sanitize_text,
    setup_logging,
)
from app.models import Customer, Job
from tests.conftest import admin_headers


# ------------------------------------------------------------------ Alembic Migrations
def test_alembic_migrations_lifecycle():
    """Verify that Alembic can upgrade to head and downgrade cleanly on a database."""
    engine = init_db("sqlite://", create_tables=False)
    cfg = Config("alembic.ini")

    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        # Run upgrade to head
        command.upgrade(cfg, "head")

    from sqlalchemy import inspect
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    expected = [
        "access_tokens", "audit_logs", "consent_ledger", "customers",
        "documents", "jobs", "manual_reviews", "ocr_results",
        "privacy_requests", "required_documents", "alembic_version"
    ]
    for exp in expected:
        assert exp in tables

    # Test downgrade to base
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.downgrade(cfg, "base")

    inspector = inspect(engine)
    tables_after = inspector.get_table_names()
    assert "customers" not in tables_after
    assert "documents" not in tables_after


# ------------------------------------------------------------------ Structured Logging & PII Sanitization
def test_pii_sanitization_patterns():
    # Email redaction
    assert "[REDACTED_EMAIL]" in sanitize_text("Send to test.user@example.com immediately")
    # PAN redaction
    assert "[REDACTED_PAN]" in sanitize_text("PAN is ABCDE1234F verified")
    # Aadhaar redaction
    assert "[REDACTED_AADHAAR]" in sanitize_text("Aadhaar 1234 5678 9012 recorded")
    assert "[REDACTED_AADHAAR]" in sanitize_text("Aadhaar 123456789012 recorded")
    # Phone redaction
    assert "[REDACTED_PHONE]" in sanitize_text("Call +919876543210 for info")


def test_pii_dict_data_sanitization():
    sensitive_dict = {
        "customer_id": 123,
        "email": "secret@example.com",
        "mobile": "+919876543210",
        "aadhaar": "1234 5678 9012",
        "nested": {
            "pan": "ABCDE1234F",
            "safe_code": "CUS-000123"
        }
    }
    cleaned = sanitize_data(sensitive_dict)
    assert cleaned["customer_id"] == 123
    assert cleaned["email"] == "[REDACTED]"
    assert cleaned["mobile"] == "[REDACTED]"
    assert cleaned["aadhaar"] == "[REDACTED]"
    assert cleaned["nested"]["pan"] == "[REDACTED]"
    assert cleaned["nested"]["safe_code"] == "CUS-000123"


def test_structured_json_formatter():
    formatter = StructuredJsonFormatter()
    record = logging.LogRecord(
        name="test_logger",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg="Processing customer rajesh@example.com with PAN ABCPE1234F",
        args=(),
        exc_info=None,
    )
    record.document_id = "doc-uuid-1234"
    record.customer_id = 42

    formatted = formatter.format(record)
    data = json.loads(formatted)

    assert data["level"] == "INFO"
    assert data["logger"] == "test_logger"
    assert "[REDACTED_EMAIL]" in data["message"]
    assert "[REDACTED_PAN]" in data["message"]
    assert "rajesh@example.com" not in data["message"]
    assert "ABCPE1234F" not in data["message"]
    assert data["context"]["document_id"] == "doc-uuid-1234"
    assert data["context"]["customer_id"] == 42
    assert "timestamp" in data


# ------------------------------------------------------------------ Alert Hook for Failed Jobs
def test_alert_hook_trigger():
    clear_alert_hooks()
    received_alerts = []

    def mock_hook(info):
        received_alerts.append(info)

    register_alert_hook(mock_hook)

    dummy_job = Job(
        id=999,
        kind="process_document",
        payload={"document_id": "doc-123"},
        status="running",
        attempts=3,
        max_attempts=3,
    )

    alert_failed_job(dummy_job, "OCR service timeout after 3 attempts")

    assert len(received_alerts) == 1
    alert = received_alerts[0]
    assert alert["alert"] == "job_failed"
    assert alert["job_id"] == 999
    assert alert["kind"] == "process_document"
    assert alert["attempts"] == 3
    assert "OCR service timeout" in alert["error"]

    clear_alert_hooks()


# ------------------------------------------------------------------ Three Emails Verification
def test_consent_email_content_and_dispatch(client):
    """Test 1: Consent email generation, link formatting, and outbox copy."""
    emailer.OUTBOX.clear()
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Kiran Rao",
            "email": "kiran.rao@example.com",
            "mobile": "+919876543210",
            "required_documents": ["pan", "passport"],
            "send_consent": True,
        },
    )
    assert r.status_code == 201

    assert len(emailer.OUTBOX) == 1
    mail = emailer.OUTBOX[0]
    assert mail["to"] == "kiran.rao@example.com"
    assert mail["subject"] == "Consent needed to collect your documents"
    assert "Hello Kiran Rao," in mail["body"]
    assert "PAN Card" in mail["body"]
    assert "Passport" in mail["body"]
    assert "consent/" in mail["body"]
    assert "Documents are uploaded through a secure portal; please do not send them by email." in mail["body"]


def test_upload_link_email_content_and_dispatch(client):
    """Test 2: Upload link email sent upon customer granting consent."""
    emailer.OUTBOX.clear()
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "Arjun Mehta",
            "email": "arjun.mehta@example.com",
            "required_documents": ["pan"],
            "send_consent": True,
        },
    )
    assert r.status_code == 201
    from tests.conftest import token_from_outbox
    consent_tok = token_from_outbox("consent")

    emailer.OUTBOX.clear()
    r_consent = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_consent.status_code == 200

    assert len(emailer.OUTBOX) == 1
    mail = emailer.OUTBOX[0]
    assert mail["to"] == "arjun.mehta@example.com"
    assert mail["subject"] == "Please upload your documents"
    assert "Hello Arjun Mehta," in mail["body"]
    assert "PAN Card" in mail["body"]
    assert "portal/" in mail["body"]
    assert "Upload them securely here" in mail["body"]
    assert "Please do not reply with attachments." in mail["body"]


def test_reminder_email_content_and_dispatch(env):
    """Test 3: Reminder email formatting and copy."""
    emailer.OUTBOX.clear()
    emailer.pending_documents(
        to="arjun.mehta@example.com",
        name="Arjun Mehta",
        labels=["Permanent Account Number (PAN)"],
        link="http://portal.test/portal/dummy-upload-token",
        reminder=True,
    )

    assert len(emailer.OUTBOX) == 1
    mail = emailer.OUTBOX[0]
    assert mail["to"] == "arjun.mehta@example.com"
    assert mail["subject"] == "Reminder: documents still pending"
    assert "Hello Arjun Mehta," in mail["body"]
    assert "Permanent Account Number (PAN)" in mail["body"]
    assert "http://portal.test/portal/dummy-upload-token" in mail["body"]
    assert "Please do not reply with attachments." in mail["body"]


def test_smtp_live_dispatch_configuration(monkeypatch):
    """Test SMTP dispatch when SMTP_HOST is configured."""
    s = get_settings()
    monkeypatch.setattr(s, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(s, "smtp_port", 587)
    monkeypatch.setattr(s, "smtp_user", "mailer@example.com")
    monkeypatch.setattr(s, "smtp_password", "super-secret-pass")
    monkeypatch.setattr(s, "smtp_from", "noreply@docpilot.test")

    mock_smtp_instance = MagicMock()
    mock_smtp_class = MagicMock(return_value=mock_smtp_instance)
    mock_smtp_instance.__enter__.return_value = mock_smtp_instance

    with patch("smtplib.SMTP", mock_smtp_class):
        emailer.consent_request(
            to="customer@example.com",
            name="Test Customer",
            labels=["PAN"],
            link="http://portal.test/consent/xyz",
        )

        mock_smtp_class.assert_called_once_with("smtp.example.com", 587, timeout=30)
        mock_smtp_instance.starttls.assert_called_once()
        mock_smtp_instance.login.assert_called_once_with("mailer@example.com", "super-secret-pass")
        mock_smtp_instance.send_message.assert_called_once()
        sent_msg = mock_smtp_instance.send_message.call_args[0][0]
        assert sent_msg["To"] == "customer@example.com"
        assert sent_msg["From"] == "noreply@docpilot.test"
        assert sent_msg["Subject"] == "Consent needed to collect your documents"
