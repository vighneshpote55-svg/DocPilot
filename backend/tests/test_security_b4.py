import io
import re
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import jwt
import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import emailer, security, services
from app.config import get_settings
from app.db import get_db, utcnow
from app.models import AccessToken, Customer
from app.rate_limiter import reset_rate_limits
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def setup_customer_and_portal(client, name="Secure User", email="secure@example.com", docs=None):
    if docs is None:
        docs = ["pan", "aadhaar"]
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "mobile": "+919876543210", "required_documents": docs},
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    consent_tok = token_from_outbox("consent")
    r_consent = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_consent.status_code == 200
    portal_tok = token_from_outbox("portal")
    return cid, portal_tok, consent_tok


def upload_file(client, token: str, doc_type: str, filename: str, content: bytes):
    return client.post(
        f"/api/portal/{token}/upload",
        data={"doc_type": doc_type},
        files={"file": (filename, io.BytesIO(content), "application/octet-stream")},
    )


# ------------------------------------------------------------------ Magic Byte Tests
def test_magic_byte_extension_mismatch(client):
    reset_rate_limits()
    _, portal, _ = setup_customer_and_portal(client)

    # .pdf with PNG magic bytes
    r = upload_file(client, portal, "pan", "document.pdf", PNG)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"

    # .png with JPEG magic bytes
    jpeg_bytes = b"\xff\xd8\xff\xe0" + b"0" * 100
    r = upload_file(client, portal, "pan", "document.png", jpeg_bytes)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"

    # .jpg with PDF magic bytes
    r = upload_file(client, portal, "pan", "document.jpg", PDF)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"


def test_dangerous_file_signatures(client):
    reset_rate_limits()
    _, portal, _ = setup_customer_and_portal(client)

    # Disguised DOS / Windows PE executable
    exe_bytes = b"MZ\x90\x00" + b"\x00" * 200
    r = upload_file(client, portal, "pan", "payload.pdf", exe_bytes)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"

    # Disguised Linux ELF executable
    elf_bytes = b"\x7fELF\x02\x01\x01" + b"\x00" * 200
    r = upload_file(client, portal, "pan", "exploit.pdf", elf_bytes)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"

    # Disguised Zip / Jar file
    zip_bytes = b"PK\x03\x04" + b"\x00" * 200
    r = upload_file(client, portal, "pan", "archive.png", zip_bytes)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "file_content_mismatch"

    # HTML script tag content
    script_bytes = b"<script>alert('xss')</script>"
    r = upload_file(client, portal, "pan", "hack.png", script_bytes)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] in ("unsafe_file", "file_content_mismatch")


def test_unsafe_active_pdf(client):
    reset_rate_limits()
    _, portal, _ = setup_customer_and_portal(client)

    # PDF with /JavaScript
    pdf_js = b"%PDF-1.4\n/JavaScript (app.alert('evil'));\n" + b"0" * 100
    r = upload_file(client, portal, "pan", "js.pdf", pdf_js)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsafe_pdf"

    # PDF with /Launch
    pdf_launch = b"%PDF-1.4\n/Launch /F (cmd.exe)\n" + b"0" * 100
    r = upload_file(client, portal, "pan", "launch.pdf", pdf_launch)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsafe_pdf"

    # Password-protected PDF
    pdf_enc = b"%PDF-1.4\n/Encrypt 12 0 R\n" + b"0" * 100
    r = upload_file(client, portal, "pan", "encrypted.pdf", pdf_enc)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "password_protected_pdf"


def test_valid_file_uploads_accepted(client):
    reset_rate_limits()
    _, portal, _ = setup_customer_and_portal(client)

    # Valid PNG
    r_png = upload_file(client, portal, "pan", "valid.png", PNG)
    assert r_png.status_code == 202

    # Valid PDF
    r_pdf = upload_file(client, portal, "aadhaar", "valid.pdf", PDF)
    assert r_pdf.status_code == 202


# ------------------------------------------------------------------ Rate Limiting Tests
def test_rate_limiting_portal(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    monkeypatch.setattr(s, "rate_limit_portal_per_minute", 3)

    _, portal, _ = setup_customer_and_portal(client)

    # 3 portal requests allowed
    for _ in range(3):
        res = client.get(f"/api/portal/{portal}")
        assert res.status_code == 200

    # 4th request must be rate limited (429)
    res_limited = client.get(f"/api/portal/{portal}")
    assert res_limited.status_code == 429
    assert res_limited.json()["detail"]["code"] == "rate_limited"

    # Resetting limits allows requests again
    reset_rate_limits()
    res_after_reset = client.get(f"/api/portal/{portal}")
    assert res_after_reset.status_code == 200


def test_rate_limiting_upload(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    monkeypatch.setattr(s, "rate_limit_upload_per_minute", 2)

    _, portal, _ = setup_customer_and_portal(client)

    # 2 uploads succeed
    r1 = upload_file(client, portal, "pan", "test1.png", PNG)
    assert r1.status_code == 202
    r2 = upload_file(client, portal, "pan", "test2.png", PNG)
    assert r2.status_code == 202

    # 3rd upload gets rate limited
    r3 = upload_file(client, portal, "pan", "test3.png", PNG)
    assert r3.status_code == 429
    assert r3.json()["detail"]["code"] == "rate_limited"


def test_rate_limiting_consent_and_privacy(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    monkeypatch.setattr(s, "rate_limit_privacy_per_minute", 2)

    # Privacy request route
    r1 = client.post("/api/public/privacy/request", json={"email": "u1@example.com", "action": "delete"})
    assert r1.status_code == 202
    r2 = client.post("/api/public/privacy/request", json={"email": "u2@example.com", "action": "delete"})
    assert r2.status_code == 202
    r3 = client.post("/api/public/privacy/request", json={"email": "u3@example.com", "action": "delete"})
    assert r3.status_code == 429


# ------------------------------------------------------------------ Email OTP before Upload Tests
def test_upload_otp_workflow(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "upload_otp_enabled", True)

    _, portal, _ = setup_customer_and_portal(client, name="Rohan Joshi", email="rohan.joshi@example.com")

    # Portal state shows otp_required = True, otp_verified = False, masked_email
    state = client.get(f"/api/portal/{portal}").json()
    assert state["otp_required"] is True
    assert state["otp_verified"] is False
    assert state["masked_email"] == "r***@example.com"

    # Attempting to upload without OTP verification returns 403
    r_unauth = upload_file(client, portal, "pan", "pan.png", PNG)
    assert r_unauth.status_code == 403
    assert r_unauth.json()["detail"]["code"] == "otp_required"

    # Request OTP to email
    outbox_count_before = len(emailer.OUTBOX)
    r_send = client.post(f"/api/portal/{portal}/otp/send")
    assert r_send.status_code == 200
    assert r_send.json()["sent"] is True
    assert r_send.json()["masked_email"] == "r***@example.com"
    assert len(emailer.OUTBOX) == outbox_count_before + 1

    # Extract 6-digit OTP code from email body
    last_email = emailer.OUTBOX[-1]
    match = re.search(r"code is:\s*(\d{6})", last_email["body"])
    assert match is not None
    otp_code = match.group(1)

    # Submitting wrong OTP code fails
    r_wrong = client.post(f"/api/portal/{portal}/otp/verify", json={"code": "000000"})
    assert r_wrong.status_code == 400
    assert r_wrong.json()["detail"]["code"] == "invalid_or_expired_otp"

    # Submitting correct OTP code succeeds
    r_verify = client.post(f"/api/portal/{portal}/otp/verify", json={"code": otp_code})
    assert r_verify.status_code == 200
    assert r_verify.json()["verified"] is True

    # Portal state now shows verified
    state_after = client.get(f"/api/portal/{portal}").json()
    assert state_after["otp_required"] is False
    assert state_after["otp_verified"] is True

    # Upload now succeeds
    r_upload = upload_file(client, portal, "pan", "pan.png", PNG)
    assert r_upload.status_code == 202


def test_upload_otp_expiry(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "upload_otp_enabled", True)

    _, portal, _ = setup_customer_and_portal(client, name="Expired User", email="expired@example.com")

    # Request OTP
    client.post(f"/api/portal/{portal}/otp/send")
    last_email = emailer.OUTBOX[-1]
    otp_code = re.search(r"code is:\s*(\d{6})", last_email["body"]).group(1)

    # Manually expire the OTP token in database
    app_db = next(get_db())
    app_db.execute(
        AccessToken.__table__.update()
        .where(AccessToken.purpose == "upload_otp")
        .values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    )
    app_db.commit()

    # Verification must fail due to expiry
    r_verify = client.post(f"/api/portal/{portal}/otp/verify", json={"code": otp_code})
    assert r_verify.status_code == 400
    assert r_verify.json()["detail"]["code"] == "invalid_or_expired_otp"


# ------------------------------------------------------------------ Expired & Single-Use Tokens
def test_expired_tokens_return_404(client):
    reset_rate_limits()
    _, portal, consent = setup_customer_and_portal(client)

    app_db = next(get_db())
    # Expire all tokens
    app_db.execute(
        AccessToken.__table__.update().values(expires_at=datetime.now(timezone.utc) - timedelta(hours=1))
    )
    app_db.commit()

    # Expired portal token returns 404
    assert client.get(f"/api/portal/{portal}").status_code == 404
    assert upload_file(client, portal, "pan", "doc.png", PNG).status_code == 404

    # Expired consent token returns 404
    assert client.get(f"/api/public/consent/{consent}").status_code == 404
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 404


def test_single_use_consent_token_abuse(client):
    reset_rate_limits()
    # Create customer without submitting consent yet
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Consent User", "email": "consent@example.com", "required_documents": ["pan"]},
    )
    assert r.status_code == 201
    consent = token_from_outbox("consent")

    # First consent submission succeeds
    r1 = client.post(f"/api/public/consent/{consent}", json={"granted": True})
    assert r1.status_code == 200

    # Second submission with the same token must fail (single use token consumed)
    r2 = client.post(f"/api/public/consent/{consent}", json={"granted": True})
    assert r2.status_code in (404, 409)


def test_single_use_privacy_token_abuse(client):
    reset_rate_limits()
    setup_customer_and_portal(client, name="Privacy User", email="privacy.test@example.com")

    # Request privacy deletion
    client.post("/api/public/privacy/request", json={"email": "privacy.test@example.com", "action": "delete"})
    priv_tok = token_from_outbox("privacy/confirm")

    # First confirmation succeeds
    r1 = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r1.status_code == 200
    assert r1.json()["completed"] == "delete"

    # Second confirmation with the same token must fail (single-use consumed)
    r2 = client.post(f"/api/public/privacy/confirm/{priv_tok}")
    assert r2.status_code == 404


def test_forwarded_upload_link_abuse_with_otp(client, monkeypatch):
    """If an upload link is forwarded to an unauthorized party, OTP protection prevents uploads."""
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "upload_otp_enabled", True)

    _, portal, _ = setup_customer_and_portal(client, name="Victim User", email="victim@example.com")

    # Attacker tries to upload using the forwarded link
    r_attacker = upload_file(client, portal, "pan", "malicious.png", PNG)
    assert r_attacker.status_code == 403
    assert r_attacker.json()["detail"]["code"] == "otp_required"

    # Attacker triggers OTP send, but OTP is sent to victim's registered email
    client.post(f"/api/portal/{portal}/otp/send")
    victim_email = emailer.OUTBOX[-1]
    assert victim_email["to"] == "victim@example.com"

    # Attacker guessing OTP fails
    r_guess = client.post(f"/api/portal/{portal}/otp/verify", json={"code": "111111"})
    assert r_guess.status_code == 400


# ------------------------------------------------------------------ Supabase JWKS Admin Auth
def test_admin_auth_via_jwks(client, monkeypatch):
    """Admin auth works via JWKS (RS256) without needing legacy HS256 secret."""
    # Generate RSA Key pair
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
    public_key = private_key.public_key()

    # Clear legacy HS256 secret and set dummy supabase_url
    s = get_settings()
    monkeypatch.setattr(s, "supabase_jwt_secret", "")
    monkeypatch.setattr(s, "supabase_url", "https://mock-supabase.supabase.co")
    monkeypatch.setattr(s, "admin_emails", "jwks-admin@example.com")

    # Mock PyJWKClient to return public key
    mock_signing_key = MagicMock()
    mock_signing_key.key = public_key

    mock_jwks = MagicMock()
    mock_jwks.get_signing_key_from_jwt.return_value = mock_signing_key
    security.set_jwks_client(mock_jwks)

    try:
        # Issue an RS256 token signed with RSA private key
        payload = {
            "email": "jwks-admin@example.com",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": "mock-key-id"})

        # Authorized admin request succeeds with JWKS
        r = client.get("/api/admin/customers", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200

        # Non-admin email signed by same valid JWKS key is rejected (403)
        non_admin_token = jwt.encode(
            {"email": "stranger@example.com", "aud": "authenticated", "exp": int(time.time()) + 3600},
            private_key,
            algorithm="RS256",
            headers={"kid": "mock-key-id"},
        )
        r_forbidden = client.get("/api/admin/customers", headers={"Authorization": f"Bearer {non_admin_token}"})
        assert r_forbidden.status_code == 403

        # Invalid token signature fails (401)
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
        bad_token = jwt.encode(payload, other_key, algorithm="RS256", headers={"kid": "mock-key-id"})
        # Verification against mock_signing_key.key (first public key) will fail
        r_invalid = client.get("/api/admin/customers", headers={"Authorization": f"Bearer {bad_token}"})
        assert r_invalid.status_code == 401

    finally:
        security.reset_jwks_client()
