"""
Focused Diagnostic Test Suite for DocPilot Consent Submission.
Covers:
1. Successful consent submission and complete DB persistence (Customer, AccessToken, ConsentLedger, AuditLog).
2. Response contract verification (HTTP 200, consent: 'granted', upload_token returned).
3. Consent decline submission (HTTP 200, consent: 'declined', workflow_state: CONSENT_WITHDRAWN).
4. Single-use token consumption (second submission fails with HTTP 404).
5. Expired token rejection (HTTP 404).
6. Non-existent/forged token rejection (HTTP 404).
7. Admin Dashboard API synchronization (GET /api/admin/customers/{id} reflects consent_status='granted').
"""
from datetime import timedelta
import pytest
from sqlalchemy import select

from app import db as dbmod
from app import services
from app.models import AccessToken, AuditLog, ConsentLedger, Customer
from tests.conftest import admin_headers, token_from_outbox


def create_synthetic_test_customer(client, name="Ananya Gupta", email="ananya.test@example.com", docs=("PAN", "Aadhaar")):
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": name,
            "email": email,
            "mobile": "+919876543210",
            "required_documents": list(docs),
            "send_consent": True,
        },
    )
    assert r.status_code == 201, f"Failed to create test customer: {r.text}"
    return r.json()


def test_consent_submission_success_persistence(client):
    """Verify successful consent submission returns upload_token and updates all DB models."""
    cust_data = create_synthetic_test_customer(client, name="Kavita Rao", email="kavita.diag@example.com")
    cust_id = cust_data["id"]
    consent_token = token_from_outbox("consent")
    assert consent_token, "Consent token was not found in email outbox"

    # Step 1: Submit consent
    response = client.post(
        f"/api/public/consent/{consent_token}",
        json={"granted": True},
    )
    assert response.status_code == 200
    res_body = response.json()
    assert res_body["consent"] == "granted"
    assert "upload_token" in res_body
    upload_token = res_body["upload_token"]
    assert len(upload_token) >= 20, "Upload token should be a secure random string"

    # Step 2: Verify database state
    with dbmod.session_scope() as db:
        customer = db.get(Customer, cust_id)
        assert customer is not None
        assert customer.consent_status == "granted"
        assert customer.case_status == "in_progress"
        assert customer.workflow_state == "CONSENT_GRANTED"
        assert customer.consent_at is not None
        assert customer.case_expires_at is not None

        # Verify ConsentLedger row
        ledgers = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cust_id)))
        assert len(ledgers) == 1
        assert ledgers[0].event == "granted"
        assert ledgers[0].created_at is not None

        # Verify original consent token was marked as used (consumed)
        consent_token_row = db.scalar(
            select(AccessToken).where(
                AccessToken.customer_id == cust_id,
                AccessToken.purpose == "consent",
            )
        )
        assert consent_token_row is not None
        assert consent_token_row.used_at is not None

        # Verify newly issued upload token exists in DB
        upload_token_row = db.scalar(
            select(AccessToken).where(
                AccessToken.customer_id == cust_id,
                AccessToken.purpose == "upload",
            )
        )
        assert upload_token_row is not None
        assert upload_token_row.used_at is None
        assert upload_token_row.revoked is False
        assert upload_token_row.expires_at > dbmod.utcnow()

        # Verify AuditLog row
        audit_row = db.scalar(
            select(AuditLog).where(
                AuditLog.entity_id == str(cust_id),
                AuditLog.action == "consent_granted",
            )
        )
        assert audit_row is not None


def test_consent_submission_decline_persistence(client):
    """Verify declining consent marks customer as declined/withdrawn and persists to ledger."""
    cust_data = create_synthetic_test_customer(client, name="Rahul Verma", email="rahul.diag@example.com")
    cust_id = cust_data["id"]
    consent_token = token_from_outbox("consent")

    response = client.post(
        f"/api/public/consent/{consent_token}",
        json={"granted": False},
    )
    assert response.status_code == 200
    res_body = response.json()
    assert res_body["consent"] == "declined"
    assert "upload_token" not in res_body

    with dbmod.session_scope() as db:
        customer = db.get(Customer, cust_id)
        assert customer.consent_status == "declined"
        assert customer.case_status == "consent_declined"
        assert customer.workflow_state == "CONSENT_WITHDRAWN"

        ledgers = list(db.scalars(select(ConsentLedger).where(ConsentLedger.customer_id == cust_id)))
        assert len(ledgers) == 1
        assert ledgers[0].event == "declined"

        # No upload token issued on decline
        upload_tokens = list(db.scalars(
            select(AccessToken).where(
                AccessToken.customer_id == cust_id,
                AccessToken.purpose == "upload",
            )
        ))
        assert len(upload_tokens) == 0


def test_consent_submission_single_use_duplicate_rejection(client):
    """Verify that a consent token is strictly single-use and cannot be submitted twice."""
    create_synthetic_test_customer(client, name="Pooja Sharma", email="pooja.diag@example.com")
    consent_token = token_from_outbox("consent")

    # First submission succeeds
    first_res = client.post(
        f"/api/public/consent/{consent_token}",
        json={"granted": True},
    )
    assert first_res.status_code == 200

    # Second submission with the same token must fail with 404 (anti-enumeration / consumed)
    second_res = client.post(
        f"/api/public/consent/{consent_token}",
        json={"granted": True},
    )
    assert second_res.status_code == 404
    assert second_res.json()["detail"] == "invalid_or_expired_link"

    # GET also fails
    get_res = client.get(f"/api/public/consent/{consent_token}")
    assert get_res.status_code == 404
    assert get_res.json()["detail"] == "invalid_or_expired_link"


def test_consent_submission_expired_token(client):
    """Verify that an expired consent token cannot be retrieved or submitted."""
    cust_data = create_synthetic_test_customer(client, name="Vikram Roy", email="vikram.diag@example.com")
    cust_id = cust_data["id"]
    consent_token = token_from_outbox("consent")

    # Manually expire token in database
    with dbmod.session_scope() as db:
        tok = db.scalar(
            select(AccessToken).where(
                AccessToken.customer_id == cust_id,
                AccessToken.purpose == "consent",
            )
        )
        tok.expires_at = dbmod.utcnow() - timedelta(minutes=10)

    # Both GET and POST should fail with 404
    r_get = client.get(f"/api/public/consent/{consent_token}")
    assert r_get.status_code == 404
    assert r_get.json()["detail"] == "invalid_or_expired_link"

    r_post = client.post(f"/api/public/consent/{consent_token}", json={"granted": True})
    assert r_post.status_code == 404
    assert r_post.json()["detail"] == "invalid_or_expired_link"


def test_consent_submission_forged_or_random_token(client):
    """Verify that a forged or non-existent token returns 404."""
    forged_token = "0123456789abcdef0123456789abcdef"
    r_get = client.get(f"/api/public/consent/{forged_token}")
    assert r_get.status_code == 404
    assert r_get.json()["detail"] == "invalid_or_expired_link"

    r_post = client.post(f"/api/public/consent/{forged_token}", json={"granted": True})
    assert r_post.status_code == 404
    assert r_post.json()["detail"] == "invalid_or_expired_link"


def test_admin_dashboard_sees_updated_consent_status(client):
    """Verify that after consent is granted, the Admin Customer API displays the status."""
    cust_data = create_synthetic_test_customer(client, name="Divya Iyer", email="divya.diag@example.com")
    cust_id = cust_data["id"]
    consent_token = token_from_outbox("consent")

    # Admin check before consent
    admin_res_before = client.get(f"/api/admin/customers/{cust_id}", headers=admin_headers())
    assert admin_res_before.status_code == 200
    assert admin_res_before.json()["consent_status"] == "pending"
    assert admin_res_before.json()["case_status"] == "awaiting_consent"

    # Customer submits consent
    grant_res = client.post(f"/api/public/consent/{consent_token}", json={"granted": True})
    assert grant_res.status_code == 200

    # Admin check after consent
    admin_res_after = client.get(f"/api/admin/customers/{cust_id}", headers=admin_headers())
    assert admin_res_after.status_code == 200
    detail = admin_res_after.json()
    assert detail["consent_status"] == "granted"
    assert detail["case_status"] == "in_progress"
    assert detail["workflow_state"] == "CONSENT_GRANTED"
