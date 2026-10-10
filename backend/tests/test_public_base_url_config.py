import pytest
from sqlalchemy import select
from app.config import Settings, get_settings
from app import db as dbmod, emailer, services
from app.models import Customer, Document
from tests.conftest import PDF, PNG, admin_headers

pytestmark = pytest.mark.usefixtures("env")


def test_public_base_url_trailing_slash_normalization():
    """Verify that public_base_url automatically strips any trailing slashes."""
    s1 = Settings(public_base_url="http://10.241.156.99:5173/")
    assert s1.public_base_url == "http://10.241.156.99:5173"

    s2 = Settings(public_base_url="http://10.241.156.99:5173///")
    assert s2.public_base_url == "http://10.241.156.99:5173"

    s3 = Settings(public_base_url="http://10.241.156.99:5173")
    assert s3.public_base_url == "http://10.241.156.99:5173"


def test_cors_origin_includes_lan_ip():
    """Verify CORS origins include the configured development IP."""
    s = Settings(cors_origins="http://localhost:5173,http://localhost:5180,http://10.241.156.99:5173")
    assert "http://10.241.156.99:5173" in s.cors_origin_list


def test_email_links_use_public_base_url(monkeypatch, client):
    """Verify all customer email types use PUBLIC_BASE_URL without double slashes."""
    test_base = "http://10.241.156.99:5173"
    monkeypatch.setenv("PUBLIC_BASE_URL", f"{test_base}///")  # Test normalization with trailing slashes
    get_settings.cache_clear()

    # Clear outbox
    emailer.OUTBOX.clear()

    # 1. Customer creation -> Consent Request email
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Link Test Customer",
        "email": "linktest@example.com",
        "required_documents": ["PAN"],
        "send_consent": True,
    })
    assert res.status_code == 201

    consent_email = [e for e in emailer.OUTBOX if "Consent needed" in e["subject"]][-1]
    assert f"{test_base}/consent/" in consent_email["body"]
    assert f"{test_base}//consent/" not in consent_email["body"]

    # Extract token
    consent_tok = consent_email["body"].split(f"{test_base}/consent/")[1].split()[0].strip()

    # 2. Grant consent -> Pending documents / Upload portal email
    grant_res = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert grant_res.status_code == 200

    upload_email = [e for e in emailer.OUTBOX if "Please upload your documents" in e["subject"]][-1]
    assert f"{test_base}/portal/" in upload_email["body"]
    assert f"{test_base}//portal/" not in upload_email["body"]

    # 3. Privacy request -> Confirmation email
    priv_res = client.post("/api/public/privacy/request", json={
        "email": "linktest@example.com",
        "action": "withdraw",
    })
    assert priv_res.status_code == 202

    privacy_email = [e for e in emailer.OUTBOX if "Confirm your privacy request" in e["subject"]][-1]
    assert f"{test_base}/privacy/confirm/" in privacy_email["body"]
    assert f"{test_base}//privacy/confirm/" not in privacy_email["body"]

    # 4. Trigger resubmission request -> Resubmission email
    with dbmod.session_scope() as db:
        c = db.scalar(select(Customer).where(Customer.email == "linktest@example.com"))
        doc = Document(
            customer_id=c.id,
            doc_type="PAN",
            filename="pan.png",
            mime="image/png",
            size=100,
            sha256="dummy",
            storage_key="test/pan.enc",
            file_state="stored",
            verification_status="rejected",
        )
        db.add(doc)
        db.flush()
        services.request_resubmission(db, c, doc)

    resub_email = [e for e in emailer.OUTBOX if "Please re-upload your" in e["subject"]][-1]
    assert f"{test_base}/portal/" in resub_email["body"]
    assert f"{test_base}//portal/" not in resub_email["body"]
