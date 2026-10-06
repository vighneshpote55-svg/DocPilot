"""STEP 2: admin customer creation. Dummy customers only."""
import re

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app import db as dbmod
from app import emailer, services
from app.models import AccessToken, AuditLog, Customer, Document, RequiredDocument
from tests.conftest import JWT_SECRET, admin_headers

URL = "/api/admin/customers"


def body(**kw):
    b = {"name": "Test Customer", "email": "test.customer@example.com",
         "required_documents": ["PAN", "Aadhaar"], "send_consent": False}
    b.update(kw)
    return b


def count(model):
    with dbmod.session_scope() as s:
        return s.scalar(select(func.count()).select_from(model))


def test_create_success_and_initial_state(client):
    r = client.post(URL, headers=admin_headers(), json=body(name="  Test   Customer ", email=" Test.Customer@Example.COM "))
    assert r.status_code == 201
    c = r.json()
    assert re.fullmatch(r"CUS-\d{6}", c["code"])
    assert c["name"] == "Test Customer"
    assert c["email"] == "test.customer@example.com"
    assert c["workflow_state"] == "NOT_STARTED"
    assert c["consent_status"] == "pending"
    assert c["case_status"] == "awaiting_consent"
    assert c["completed_at"] is None and c["delete_after"] is None and c["data_deleted_at"] is None
    assert c["created_at"]
    with dbmod.session_scope() as s:
        row = s.get(Customer, c["id"])
        assert row.consent_at is None and row.workflow_state == "NOT_STARTED"


def test_ids_are_unique(client):
    a = client.post(URL, headers=admin_headers(), json=body(email="a@example.com")).json()
    b = client.post(URL, headers=admin_headers(), json=body(email="b@example.com")).json()
    assert a["id"] != b["id"] and a["code"] != b["code"]


def test_checklist_created_pending_no_documents(client):
    r = client.post(URL, headers=admin_headers(), json=body(required_documents=["PAN", "pan", "Aadhaar"]))
    c = r.json()
    with dbmod.session_scope() as s:
        reqs = list(s.scalars(select(RequiredDocument).where(RequiredDocument.customer_id == c["id"])))
        assert len(reqs) == 2
        assert all(x.verified_document_id is None for x in reqs)
    assert c["required_count"] == 2 and c["pending_count"] == 2 and c["received_count"] == 0
    assert count(Document) == 0


@pytest.mark.parametrize("email", ["not-an-email", "a@b", "", "   "])
def test_invalid_email(client, email):
    r = client.post(URL, headers=admin_headers(), json=body(email=email))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_email"


@pytest.mark.parametrize("missing", ["name", "email", "required_documents"])
def test_missing_fields(client, missing):
    b = body()
    b.pop(missing)
    assert client.post(URL, headers=admin_headers(), json=b).status_code == 422
    assert count(Customer) == 0


def test_blank_name(client):
    r = client.post(URL, headers=admin_headers(), json=body(name="   "))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_name"


@pytest.mark.parametrize("mobile,expected", [("98765 43210", "+919876543210"), ("+91-9876543210", "+919876543210"),
                                             ("", None), (None, None)])
def test_mobile_normalized(client, mobile, expected):
    r = client.post(URL, headers=admin_headers(), json=body(mobile=mobile))
    assert r.status_code == 201 and r.json()["mobile"] == expected


@pytest.mark.parametrize("mobile", ["12345", "5876543210", "98765432101", "abcdefghij"])
def test_invalid_mobile(client, mobile):
    r = client.post(URL, headers=admin_headers(), json=body(mobile=mobile))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_mobile"


def test_unsupported_document_type(client):
    r = client.post(URL, headers=admin_headers(), json=body(required_documents=["PAN", "Spaceship License"]))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unsupported_document_type"
    assert count(Customer) == 0 and count(RequiredDocument) == 0


def test_empty_required_documents(client):
    r = client.post(URL, headers=admin_headers(), json=body(required_documents=[]))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "required_documents_empty"
    assert count(Customer) == 0


def test_duplicate_open_case_blocked_closed_allowed(client):
    first = client.post(URL, headers=admin_headers(), json=body()).json()
    r = client.post(URL, headers=admin_headers(), json=body(email=" TEST.customer@example.com"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_customer"
    assert count(Customer) == 1
    with dbmod.session_scope() as s:
        s.get(Customer, first["id"]).case_status = "completed"
    assert client.post(URL, headers=admin_headers(), json=body()).status_code == 201


def test_rollback_when_checklist_fails(client, monkeypatch):
    class Boom:
        def __init__(self, *a, **k):
            raise SQLAlchemyError("simulated")

    monkeypatch.setattr(services, "RequiredDocument", Boom)
    r = client.post(URL, headers=admin_headers(), json=body())
    assert r.status_code == 500
    assert r.json()["detail"] == {"code": "create_failed", "message": "Could not create customer."}
    assert count(Customer) == 0 and count(RequiredDocument) == 0 and count(AuditLog) == 0


def test_auth_required(client):
    assert client.post(URL, json=body()).status_code == 401
    assert client.post(URL, headers=admin_headers("someone@example.com"), json=body()).status_code == 403
    assert client.post(URL, headers={"Authorization": "Bearer bad"}, json=body()).status_code == 401
    assert count(Customer) == 0
    assert JWT_SECRET  # fixture secret in use, nothing real


def test_response_compatible_and_no_secrets(client):
    c = client.post(URL, headers=admin_headers(), json=body()).json()
    for k in ("id", "code", "name", "email", "mobile", "consent_status", "case_status", "created_at",
              "completed_at", "delete_after", "data_deleted_at", "required", "required_count",
              "received_count", "pending_count", "allow_download", "workflow_state"):
        assert k in c
    text = str(c).lower()
    for bad in ("token", "hash", "secret", "key"):
        assert bad not in text.replace("allow_download", "")
    assert emailer.OUTBOX == []


def test_send_consent_default_sends_after_commit(client):
    b = body()
    b.pop("send_consent")
    r = client.post(URL, headers=admin_headers(), json=b)
    assert r.status_code == 201
    assert len(emailer.OUTBOX) == 1
    assert count(AccessToken) == 1


def test_consent_email_failure_keeps_customer(client, monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(services, "send_consent_email", fail)
    b = body()
    b.pop("send_consent")
    r = client.post(URL, headers=admin_headers(), json=b)
    assert r.status_code == 201
    assert count(Customer) == 1 and count(RequiredDocument) == 2
