"""Dedicated tests for DocPilot consent email links, reachable URL resolution, and token flow."""
import pytest
from app.config import Settings, get_settings
from app import emailer, services
from tests.conftest import admin_headers

pytestmark = pytest.mark.usefixtures("env")


def test_build_consent_url_helper():
    """Verify build_consent_url defensively handles trailing slashes, spaces, and schemes."""
    # Development reachable LAN URL
    url = services.build_consent_url("http://192.168.1.107:5173/", "test_token_123")
    assert url == "http://192.168.1.107:5173/consent/test_token_123"

    # URL with multiple trailing slashes and whitespace
    url_multi = services.build_consent_url("  http://192.168.1.107:5173///  ", "tok_abc")
    assert url_multi == "http://192.168.1.107:5173/consent/tok_abc"

    # Production HTTPS URL
    prod_url = services.build_consent_url("https://portal.docpilot.internal", "secure_tok_xyz")
    assert prod_url == "https://portal.docpilot.internal/consent/secure_tok_xyz"


def test_consent_email_link_reachable_url(monkeypatch, client):
    """Verify newly sent consent emails use the active reachable URL without stale IPs or localhost."""
    reachable_url = "http://192.168.1.107:5173"
    monkeypatch.setenv("PUBLIC_BASE_URL", reachable_url)
    get_settings.cache_clear()

    emailer.OUTBOX.clear()

    # Create customer with send_consent=True
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Consent Link User",
        "email": "consent_user@example.com",
        "required_documents": ["PAN", "AADHAAR"],
        "send_consent": True,
    })
    assert res.status_code == 201

    assert len(emailer.OUTBOX) == 1
    email = emailer.OUTBOX[0]
    body = email["body"]

    # Verify reachable link presence
    assert f"{reachable_url}/consent/" in body
    assert f"{reachable_url}//consent/" not in body

    # Verify stale addresses are NOT used
    assert "192.168.1.43" not in body
    assert "10.241.156.99" not in body
    assert "localhost" not in body


def test_consent_email_link_token_lifecycle(monkeypatch, client):
    """Verify the token extracted from the consent email works on the frontend/public consent API."""
    reachable_url = "http://192.168.1.107:5173"
    monkeypatch.setenv("PUBLIC_BASE_URL", reachable_url)
    get_settings.cache_clear()

    emailer.OUTBOX.clear()

    # Create customer
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Token Lifecycle User",
        "email": "lifecycle_user@example.com",
        "required_documents": ["PAN"],
        "send_consent": True,
    })

    email = emailer.OUTBOX[0]
    # Extract token following /consent/
    token = email["body"].split(f"{reachable_url}/consent/")[1].split()[0].strip()
    assert len(token) > 20

    # 1. Inspect consent page data via GET /api/public/consent/{token}
    info_res = client.get(f"/api/public/consent/{token}")
    assert info_res.status_code == 200
    info = info_res.json()
    assert info["first_name"] == "Token"
    assert "PAN Card" in info["documents"]
    assert "purpose" in info

    # 2. Grant consent via POST /api/public/consent/{token}
    grant_res = client.post(f"/api/public/consent/{token}", json={"granted": True})
    assert grant_res.status_code == 200
    grant_data = grant_res.json()
    assert grant_data["consent"] == "granted"
    assert "upload_token" in grant_data
    assert grant_data["upload_token"] is not None
