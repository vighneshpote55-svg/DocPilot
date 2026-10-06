"""Tests for Phase B3 Admin Completeness:
- Admin close-case (audited, require_admin, token revocation, retention timestamp)
- Admin delete-customer-data (audited, require_admin, storage deletion, anonymisation)
- Customer search and pagination (by name, email, code, limit/offset, X-Total-Count)
- Admin mark file deleted (audited, require_admin, storage deletion, file_state=deleted)
"""
import pytest
from app import jobs
from app.models import AccessToken, AuditLog, ConsentLedger, Customer, Document
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def create_test_customer(client, name="Alice Walker", email="alice@example.com", docs=("PAN", "Bank Statement")):
    r = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": name, "email": email, "required_documents": list(docs), "send_consent": True,
    })
    assert r.status_code == 201
    return r.json()


# ------------------------------------------------------------------ Close Case
def test_admin_close_case_auth(client):
    r_no_auth = client.post("/api/admin/customers/1/close")
    assert r_no_auth.status_code == 401

    r_non_admin = client.post("/api/admin/customers/1/close", headers=admin_headers("unauthorized@example.com"))
    assert r_non_admin.status_code == 403


def test_admin_close_case_flow(client):
    c = create_test_customer(client, name="Close Test User", email="close@test.com")
    cid = c["id"]

    # Close case with reason
    r = client.post(f"/api/admin/customers/{cid}/close", headers=admin_headers(), json={"reason": "Customer cancelled"})
    assert r.status_code == 200
    detail = r.json()
    assert detail["case_status"] == "completed"
    assert detail["completed_at"] is not None
    assert detail["delete_after"] is not None

    # Verify audit row created
    audit = client.get("/api/admin/audit", headers=admin_headers()).json()
    close_audits = [a for a in audit if a["action"] == "case_closed" and a["entity_id"] == str(cid)]
    assert len(close_audits) == 1
    assert close_audits[0]["details"]["reason"] == "Customer cancelled"

    # Attempting to close again returns 409
    r2 = client.post(f"/api/admin/customers/{cid}/close", headers=admin_headers())
    assert r2.status_code == 409


# ------------------------------------------------------------------ Delete Customer Data
def test_admin_delete_customer_data_auth(client):
    r_no_auth = client.post("/api/admin/customers/1/delete-data")
    assert r_no_auth.status_code == 401

    r_non_admin = client.post("/api/admin/customers/1/delete-data", headers=admin_headers("unauthorized@example.com"))
    assert r_non_admin.status_code == 403


def test_admin_delete_customer_data_flow(client):
    c = create_test_customer(client, name="Delete Test User", email="delete@test.com")
    cid = c["id"]

    # Complete consent and upload document
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    portal_tok = token_from_outbox("portal")
    upload_r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"},
                           files={"file": ("pan.png", PNG, "image/png")})
    assert upload_r.status_code == 202

    # Verify file stored
    doc_id = upload_r.json()["document_id"]
    doc_file_r = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert doc_file_r.status_code == 200

    # Admin deletes customer data
    del_r = client.post(f"/api/admin/customers/{cid}/delete-data", headers=admin_headers())
    assert del_r.status_code == 200
    assert del_r.json()["deleted"] is True

    # Check customer row anonymised
    detail = client.get(f"/api/admin/customers/{cid}", headers=admin_headers()).json()
    assert detail["name"] == "[deleted]"
    assert detail["email"] == f"deleted-{cid}@invalid.local"
    assert detail["case_status"] == "deleted"
    assert detail["data_deleted_at"] is not None

    # Check file was deleted from storage (returns 410)
    assert client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers()).status_code == 410

    # Check audit row
    audit = client.get("/api/admin/audit", headers=admin_headers()).json()
    assert any(a["action"] == "customer_data_deleted" and a["entity_id"] == str(cid) for a in audit)

    # Deleting again returns 409
    del_again = client.post(f"/api/admin/customers/{cid}/delete-data", headers=admin_headers())
    assert del_again.status_code == 409


# ------------------------------------------------------------------ Mark File Deleted
def test_admin_mark_file_deleted_auth(client):
    r_no_auth = client.post("/api/admin/documents/some-id/delete-file")
    assert r_no_auth.status_code == 401

    r_non_admin = client.post("/api/admin/documents/some-id/delete-file",
                              headers=admin_headers("unauthorized@example.com"))
    assert r_non_admin.status_code == 403


def test_admin_mark_file_deleted_flow(client):
    c = create_test_customer(client, name="File Delete User", email="filedel@test.com")
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    portal_tok = token_from_outbox("portal")
    upload_r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"},
                           files={"file": ("pan.png", PNG, "image/png")})
    assert upload_r.status_code == 202
    doc_id = upload_r.json()["document_id"]

    # Verify file can be viewed
    assert client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers()).status_code == 200

    # Admin marks file deleted
    r = client.post(f"/api/admin/documents/{doc_id}/delete-file", headers=admin_headers())
    assert r.status_code == 200
    assert r.json()["file_state"] == "deleted"

    # Now viewing returns 410 file_deleted
    view_r = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert view_r.status_code == 410

    # Check audit log recorded
    audit = client.get("/api/admin/audit", headers=admin_headers()).json()
    assert any(a["action"] == "file_marked_deleted" and a["entity_id"] == doc_id for a in audit)


# ------------------------------------------------------------------ Search & Pagination
def test_customer_search_and_pagination(client):
    create_test_customer(client, name="Suresh Gupta", email="suresh@enterprise.in")
    create_test_customer(client, name="Anita Desai", email="anita@startup.io")
    create_test_customer(client, name="Ramesh Gupta", email="ramesh@corp.org")

    # Search by name "Gupta"
    r_name = client.get("/api/admin/customers?q=Gupta", headers=admin_headers())
    assert r_name.status_code == 200
    names = [c["name"] for c in r_name.json()]
    assert "Suresh Gupta" in names and "Ramesh Gupta" in names
    assert "Anita Desai" not in names

    # Search by email domain "startup.io"
    r_email = client.get("/api/admin/customers?q=startup.io", headers=admin_headers())
    assert r_email.status_code == 200
    emails = [c["email"] for c in r_email.json()]
    assert emails == ["anita@startup.io"]

    # Search by code
    anita = r_email.json()[0]
    r_code = client.get(f"/api/admin/customers?q={anita['code']}", headers=admin_headers())
    assert r_code.status_code == 200
    assert len(r_code.json()) == 1 and r_code.json()[0]["id"] == anita["id"]

    # Pagination test: limit and offset
    r_page1 = client.get("/api/admin/customers?limit=2&offset=0", headers=admin_headers())
    assert r_page1.status_code == 200
    assert len(r_page1.json()) == 2
    assert int(r_page1.headers["X-Total-Count"]) >= 3

    r_page2 = client.get("/api/admin/customers?limit=2&offset=2", headers=admin_headers())
    assert r_page2.status_code == 200
    assert len(r_page2.json()) >= 1
    # Items from page 1 and page 2 must not overlap
    page1_ids = {c["id"] for c in r_page1.json()}
    page2_ids = {c["id"] for c in r_page2.json()}
    assert page1_ids.isdisjoint(page2_ids)


def test_admin_list_documents_and_summary_metrics(client):
    # Check summary metrics shape
    r_sum = client.get("/api/admin/summary", headers=admin_headers())
    assert r_sum.status_code == 200
    data = r_sum.json()
    assert "metrics" in data
    m = data["metrics"]
    assert "total_customers" in m
    assert "completion_rate" in m
    assert "total_documents" in m

    # Check global documents endpoint
    r_docs = client.get("/api/admin/documents", headers=admin_headers())
    assert r_docs.status_code == 200
    assert "X-Total-Count" in r_docs.headers
    docs = r_docs.json()
    assert isinstance(docs, list)
    if docs:
        d0 = docs[0]
        assert "customer_name" in d0
        assert "doc_type" in d0
        assert "ocr_status" in d0
        assert "verification_status" in d0

    # Test filtering by doc_type
    r_filtered = client.get("/api/admin/documents?doc_type=pan", headers=admin_headers())
    assert r_filtered.status_code == 200
    for doc in r_filtered.json():
        assert doc["doc_type"] == "pan"


def test_admin_ocr_settings_api(client):
    """Verify admin OCR settings management and masking."""
    # Auth checks
    assert client.get("/api/admin/settings/ocr").status_code in (401, 403)
    assert client.put("/api/admin/settings/ocr", json={"ocr_url": "http://127.0.0.1:8000"}).status_code in (401, 403)

    # Get OCR settings with admin token
    r = client.get("/api/admin/settings/ocr", headers=admin_headers())
    assert r.status_code == 200
    data = r.json()
    assert "ocr_url" in data
    assert "has_api_key" in data
    assert "masked_api_key" in data
    # Invariant: Never return raw OCR API key
    if data["has_api_key"]:
        assert "••••" in data["masked_api_key"]

    # Update OCR settings
    r_up = client.put("/api/admin/settings/ocr", headers=admin_headers(), json={
        "ocr_url": "http://127.0.0.1:8000",
        "ocr_api_key": "test_api_key_sample_12345678",
    })
    assert r_up.status_code == 200
    up_data = r_up.json()
    assert up_data["ocr_url"] == "http://127.0.0.1:8000"
    assert up_data["has_api_key"] is True
    assert "test••••" in up_data["masked_api_key"]

    # Test connectivity endpoint
    r_test = client.post("/api/admin/settings/ocr/test", headers=admin_headers(), json={
        "ocr_url": "http://127.0.0.1:8000",
        "ocr_api_key": "test_api_key_sample_12345678",
    })
    assert r_test.status_code == 200
    assert "connected" in r_test.json()


