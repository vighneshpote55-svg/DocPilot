"""
STEP 4: Consent & Secure Token Service Test Suite.
Verifies token lifecycle, anti-enumeration, single-use, consent ledger,
workflow_state transitions, upload token isolation, and consent withdrawal.
"""
from datetime import timedelta
import re
import pytest
from sqlalchemy import select

from app import db as dbmod
from app import emailer, services
from app.models import AccessToken, AuditLog, ConsentLedger, Customer, Document
from tests.conftest import PNG, admin_headers, token_from_outbox


def create_customer(client, name="Deepa Nair", email="deepa@example.com", docs=("PAN", "Aadhaar")):
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "required_documents": list(docs), "send_consent": True},
    )
    assert r.status_code == 201
    return r.json()


# 1. Valid consent token resolves session metadata without DB IDs or secrets
def test_valid_consent_token_session_info(client):
    c = create_customer(client, name="Aarav Sharma", email="aarav@example.com")
    token = token_from_outbox("consent")
    r = client.get(f"/api/public/consent/{token}")
    assert r.status_code == 200
    data = r.json()
    assert data["first_name"] == "Aarav"
    assert "PAN Card" in data["documents"]
    assert "Aadhaar Card" in data["documents"]
    assert "purpose" in data
    # Security: No customer ID, token ID, email or secrets exposed
    raw_str = str(data).lower()
    for secret_key in ("id", "email", "token", "hash", "secret", str(c["id"])):
        assert secret_key not in data


# 2. Expired consent token returns generic 404
def test_expired_consent_token(client):
    c = create_customer(client, email="expired@example.com")
    token = token_from_outbox("consent")
    with dbmod.session_scope() as db:
        tok = db.scalar(select(AccessToken).where(AccessToken.customer_id == c["id"], AccessToken.purpose == "consent"))
        tok.expires_at = dbmod.utcnow() - timedelta(minutes=5)
    r = client.get(f"/api/public/consent/{token}")
    assert r.status_code == 404
    assert r.json()["detail"] == "invalid_or_expired_link"
    r_post = client.post(f"/api/public/consent/{token}", json={"granted": True})
    assert r_post.status_code == 404
    assert r_post.json()["detail"] == "invalid_or_expired_link"


# 3. Malformed token returns generic 404
@pytest.mark.parametrize("bad_token", ["", "short", "invalid-char!", "12345", " " * 32])
def test_malformed_token_rejected(client, bad_token):
    r_get = client.get(f"/api/public/consent/{bad_token}")
    assert r_get.status_code in (404, 422)
    r_post = client.post(f"/api/public/consent/{bad_token}", json={"granted": True})
    assert r_post.status_code in (404, 422)


# 4. Random nonexistent token returns generic 404
def test_random_nonexistent_token(client):
    fake_token = "A" * 43
    r_get = client.get(f"/api/public/consent/{fake_token}")
    assert r_get.status_code == 404
    assert r_get.json()["detail"] == "invalid_or_expired_link"
    r_post = client.post(f"/api/public/consent/{fake_token}", json={"granted": True})
    assert r_post.status_code == 404
    assert r_post.json()["detail"] == "invalid_or_expired_link"


# 5. Token cannot access or modify another customer
def test_token_cannot_access_another_customer(client):
    c1 = create_customer(client, name="Customer One", email="one@example.com")
    t1 = token_from_outbox("consent")
    c2 = create_customer(client, name="Customer Two", email="two@example.com")
    t2 = token_from_outbox("consent")

    # t1 only resolves c1's first name
    r1 = client.get(f"/api/public/consent/{t1}").json()
    assert r1["first_name"] == "Customer"
    # Submit consent for c1 using t1
    r_sub = client.post(f"/api/public/consent/{t1}", json={"granted": True})
    assert r_sub.status_code == 200

    # Verify c2 is untouched and remains pending
    with dbmod.session_scope() as db:
        cust2 = db.get(Customer, c2["id"])
        assert cust2.consent_status == "pending"
        assert cust2.workflow_state == "NOT_STARTED"


# 6, 7, 8. Successful consent grant, timestamp recorded, workflow_state = CONSENT_GRANTED
def test_successful_consent_grant_lifecycle(client):
    c = create_customer(client, name="Sunita Rao", email="sunita@example.com")
    token = token_from_outbox("consent")

    r = client.post(f"/api/public/consent/{token}", json={"granted": True})
    assert r.status_code == 200
    res = r.json()
    assert res["consent"] == "granted"
    assert "upload_token" in res
    upload_tok = res["upload_token"]

    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.consent_status == "granted"
        assert cust.case_status == "in_progress"
        assert cust.workflow_state == "CONSENT_GRANTED"
        assert cust.consent_at is not None
        assert cust.case_expires_at is not None

        # ConsentLedger record created
        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == c["id"])))
        assert len(ledger) == 1
        assert ledger[0].event == "granted"

        # AuditLog record created
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == str(c["id"]), AuditLog.action == "consent_granted"))
        assert audit is not None


# 9, 14. Duplicate consent submission on same token is blocked (single-use enforcement)
def test_single_use_consent_token_consumed(client):
    create_customer(client, email="singleuse@example.com")
    token = token_from_outbox("consent")

    # First attempt: succeeds
    r1 = client.post(f"/api/public/consent/{token}", json={"granted": True})
    assert r1.status_code == 200

    # Second attempt with same token: 404 (already consumed)
    r2 = client.post(f"/api/public/consent/{token}", json={"granted": True})
    assert r2.status_code == 404
    assert r2.json()["detail"] == "invalid_or_expired_link"

    # GET with same consumed token also returns 404
    r_get = client.get(f"/api/public/consent/{token}")
    assert r_get.status_code == 404


# 10, 11. Consent withdrawal stops processing and invalidates portal access
def test_consent_withdrawal_stops_processing(client):
    c = create_customer(client, name="Meera Patel", email="meera.priv@example.com")
    token = token_from_outbox("consent")
    r_consent = client.post(f"/api/public/consent/{token}", json={"granted": True})
    upload_token = r_consent.json()["upload_token"]

    # Portal is initially accessible
    r_portal = client.get(f"/api/portal/{upload_token}")
    assert r_portal.status_code == 200

    # Withdraw consent via privacy flow
    r_req = client.post("/api/public/privacy/request", json={"email": "meera.priv@example.com", "action": "withdraw"})
    assert r_req.status_code == 202
    confirm_token = token_from_outbox("privacy/confirm")

    r_conf = client.post(f"/api/public/privacy/confirm/{confirm_token}")
    assert r_conf.status_code == 200
    assert r_conf.json()["completed"] == "withdraw"

    # Verify customer states
    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.consent_status == "withdrawn"
        assert cust.case_status == "consent_withdrawn"
        assert cust.workflow_state == "CONSENT_WITHDRAWN"

        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == c["id"])))
        events = [l.event for l in ledger]
        assert "granted" in events
        assert "withdrawn" in events

    # Withdrawn customer cannot upload or access portal
    r_portal_after = client.get(f"/api/portal/{upload_token}")
    assert r_portal_after.status_code in (403, 404)
    r_upload = client.post(
        f"/api/portal/{upload_token}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r_upload.status_code in (403, 404)


# 12. Upload token is issued only after consent is granted
def test_upload_token_only_after_consent(client):
    c = create_customer(client, email="noconsent@example.com")
    with dbmod.session_scope() as db:
        upload_tokens = list(db.scalars(
            select(AccessToken).where(AccessToken.customer_id == c["id"], AccessToken.purpose == "upload")
        ))
        assert len(upload_tokens) == 0

    token = token_from_outbox("consent")
    client.post(f"/api/public/consent/{token}", json={"granted": True})

    with dbmod.session_scope() as db:
        upload_tokens = list(db.scalars(
            select(AccessToken).where(AccessToken.customer_id == c["id"], AccessToken.purpose == "upload")
        ))
        assert len(upload_tokens) == 1
        assert upload_tokens[0].token_hash is not None


# 13. Upload token expiration
def test_upload_token_expiration(client):
    c = create_customer(client, email="expireportal@example.com")
    token = token_from_outbox("consent")
    r_sub = client.post(f"/api/public/consent/{token}", json={"granted": True})
    upload_tok = r_sub.json()["upload_token"]

    # Expire upload token in DB
    with dbmod.session_scope() as db:
        tok = db.scalar(select(AccessToken).where(AccessToken.customer_id == c["id"], AccessToken.purpose == "upload"))
        tok.expires_at = dbmod.utcnow() - timedelta(minutes=1)

    r_portal = client.get(f"/api/portal/{upload_tok}")
    assert r_portal.status_code == 404
    assert r_portal.json()["detail"] == "invalid_or_expired_link"


# 15. No sensitive info leaked in error responses
def test_no_sensitive_info_in_errors(client):
    for bad_endpoint in ("/api/public/consent/invalid_tok_12345", "/api/public/consent/99999999999999999999999"):
        r = client.get(bad_endpoint)
        assert r.status_code == 404
        content = r.text.lower()
        for forbidden in ("password", "secret", "hash", "traceback", "exception", "database", "sqlite", "postgres"):
            assert forbidden not in content


# 16. Admin vs customer authorization boundaries
def test_auth_boundaries(client):
    # Customer cannot call admin endpoints without admin JWT
    assert client.get("/api/admin/customers").status_code == 401
    assert client.post("/api/admin/customers", json={}).status_code == 401
    # Customer consent endpoint is public but token-gated
    assert client.get("/api/public/consent/fake_token").status_code == 404


# Decline consent stops case and marks CONSENT_WITHDRAWN
def test_consent_declined_stops_case(client):
    c = create_customer(client, email="decline@example.com")
    token = token_from_outbox("consent")

    r = client.post(f"/api/public/consent/{token}", json={"granted": False})
    assert r.status_code == 200
    assert r.json() == {"consent": "declined"}

    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.consent_status == "declined"
        assert cust.case_status == "consent_declined"
        assert cust.workflow_state == "CONSENT_WITHDRAWN"

        ledger = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == c["id"])))
        assert len(ledger) == 1
        assert ledger[0].event == "declined"
