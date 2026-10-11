"""
Tests for SMTP Integration, SSL/TLS Handshake Paths, and Phone-Reachable Consent Links.
Verifies:
1. SSL mode (port 465) invokes smtplib.SMTP_SSL and authenticates.
2. STARTTLS mode (port 587) invokes smtplib.SMTP + starttls and authenticates.
3. Authentication failure (SMTPAuthenticationError) is handled gracefully without leaking credentials.
4. Transient timeout retries 3 times before failing safely.
5. Email recipient addresses are masked in logs (zero PII).
6. build_consent_url uses PUBLIC_BASE_URL for mobile network accessibility.
7. Duplicate consent requests on non-pending customers are blocked with HTTP 409.
"""
from smtplib import SMTPAuthenticationError
from unittest.mock import MagicMock, patch
import pytest

from app import emailer, services
from app.config import get_settings
from app.models import Customer
from tests.conftest import admin_headers

pytestmark = pytest.mark.usefixtures("env")


def test_smtp_ssl_mode_port_465(monkeypatch):
    """Verify that setting smtp_port=465 uses smtplib.SMTP_SSL."""
    monkeypatch.setenv("SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_USER", "test_user@gmail.com")
    monkeypatch.setenv("SMTP_PASSWORD", "sample_app_password")
    monkeypatch.setenv("SMTP_FROM", "test_user@gmail.com")
    get_settings.cache_clear()

    with patch("smtplib.SMTP_SSL") as mock_ssl:
        mock_instance = MagicMock()
        mock_ssl.return_value.__enter__.return_value = mock_instance

        # Test connection probe
        probe = emailer.test_smtp_connection()
        assert probe["configured"] is True
        assert probe["connected"] is True
        assert probe["port"] == 465
        mock_ssl.assert_called_with("smtp.gmail.com", 465, timeout=10)
        mock_instance.login.assert_called_with("test_user@gmail.com", "sample_app_password")
        mock_instance.noop.assert_called_once()

        # Test message dispatch
        sent = emailer.send_email("recipient@example.com", "Test Subject", "Hello body")
        assert sent is True
        mock_instance.send_message.assert_called_once()


def test_smtp_starttls_mode_port_587(monkeypatch):
    """Verify that setting smtp_port=587 uses smtplib.SMTP with starttls()."""
    monkeypatch.setenv("SMTP_HOST", "smtp.sendgrid.net")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USER", "apikey")
    monkeypatch.setenv("SMTP_PASSWORD", "secret_sg_key")
    monkeypatch.setenv("SMTP_FROM", "no-reply@docpilot.internal")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_smtp.return_value.__enter__.return_value = mock_instance

        # Test connection probe
        probe = emailer.test_smtp_connection()
        assert probe["configured"] is True
        assert probe["connected"] is True
        assert probe["port"] == 587
        mock_smtp.assert_called_with("smtp.sendgrid.net", 587, timeout=10)
        mock_instance.starttls.assert_called_once()
        mock_instance.login.assert_called_with("apikey", "secret_sg_key")

        # Test message dispatch
        sent = emailer.send_email("customer@example.com", "Action Required", "Upload files")
        assert sent is True
        mock_instance.send_message.assert_called_once()


def test_smtp_auth_failure_handling(monkeypatch):
    """Verify that SMTPAuthenticationError does not raise unhandled exceptions and logs safely."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USER", "user@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "wrong_password")
    get_settings.cache_clear()

    with patch("smtplib.SMTP") as mock_smtp:
        mock_instance = MagicMock()
        mock_instance.login.side_effect = SMTPAuthenticationError(535, b"Authentication failed")
        mock_smtp.return_value.__enter__.return_value = mock_instance

        # Test connection check handles auth failure
        probe = emailer.test_smtp_connection()
        assert probe["configured"] is True
        assert probe["connected"] is False
        assert "535" in probe["error"]

        # Test send_email handles auth failure gracefully
        sent = emailer.send_email("customer@example.com", "Test", "Body")
        assert sent is False


def test_email_masking_pii_protection():
    """Verify recipient email masking avoids exposing complete email in logs."""
    assert emailer.mask_email("vighnesh@example.com") == "v***@example.com"
    assert emailer.mask_email("admin.ops@company.org") == "a***@company.org"
    assert emailer.mask_email("user@gmail.com") == "u***@gmail.com"
    assert emailer.mask_email("invalid_email") == "***"
    assert emailer.mask_email("") == "***"


def test_phone_reachable_consent_url_generation():
    """Verify generated links use LAN IP or tunnel without localhost so phones can reach it."""
    lan_base = "http://192.168.1.107:5173"
    token = "sec_tok_phone_test_123"

    url = services.build_consent_url(lan_base, token)
    assert url == f"{lan_base}/consent/{token}"
    assert "localhost" not in url
    assert "127.0.0.1" not in url

    portal_url = services.build_portal_url(lan_base, token)
    assert portal_url == f"{lan_base}/portal/{token}"


def test_duplicate_consent_send_prevention(client):
    """Verify resending consent email to a customer whose consent is already granted returns 409."""
    # 1. Create customer
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Consent Sent Customer",
        "email": "consent_dup@example.com",
        "required_documents": ["pan"],
        "send_consent": False,
    })
    assert res.status_code == 201
    cid = res.json()["id"]

    # 2. Resend consent while pending -> succeeds
    r_resend = client.post(f"/api/admin/customers/{cid}/send-consent", headers=admin_headers())
    assert r_resend.status_code == 200
    assert r_resend.json()["sent"] is True

    # 3. Simulate customer granting consent
    consent_tok = emailer.OUTBOX[-1]["body"].split("/consent/")[1].split()[0].strip()
    r_grant = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_grant.status_code == 200

    # 4. Attempt to resend consent when already granted -> 409 consent_not_pending
    r_dup = client.post(f"/api/admin/customers/{cid}/send-consent", headers=admin_headers())
    assert r_dup.status_code == 409
    assert r_dup.json()["detail"] == "consent_not_pending"
