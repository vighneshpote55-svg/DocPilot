import uuid
from fastapi.testclient import TestClient

from app import services
from app.db import session_scope
from app.models import Customer, Document
from tests.conftest import PNG, admin_headers, token_from_outbox


def _create_customer_with_token(client: TestClient, name: str, email: str, required_types: list[str]) -> tuple[str, str, str]:
    """Helper to create a customer via admin API, grant consent, and return (customer_id, consent_token, portal_token)."""
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": name,
        "email": email,
        "required_documents": required_types,
    })
    assert res.status_code == 201, res.text
    customer_id = res.json()["id"]

    # Send consent and grant it
    client.post(f"/api/admin/customers/{customer_id}/send-consent", headers=admin_headers())
    consent_token = token_from_outbox("consent")
    c_res = client.post(f"/api/public/consent/{consent_token}", json={"granted": True})
    assert c_res.status_code == 200

    # Retrieve the portal token sent upon consent
    portal_token = token_from_outbox("portal")
    return customer_id, consent_token, portal_token


def test_portal_cross_customer_isolation(client: TestClient):
    """A customer with a valid portal token cannot view or query status of another customer's documents."""
    c1_id, _, token1 = _create_customer_with_token(client, "Alice Wonder", "alice@example.com", ["pan"])
    c2_id, _, token2 = _create_customer_with_token(client, "Bob Builder", "bob@example.com", ["pan"])

    # Alice uploads a PAN
    u1 = client.post(f"/api/portal/{token1}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u1.status_code == 202
    doc1_id = u1.json()["document_id"]

    # Bob uploads a PAN
    u2 = client.post(f"/api/portal/{token2}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u2.status_code == 202
    doc2_id = u2.json()["document_id"]

    # Alice queries her own document status -> Success (200)
    res_alice_own = client.get(f"/api/portal/{token1}/documents/{doc1_id}/status")
    assert res_alice_own.status_code == 200
    assert res_alice_own.json()["document_id"] == doc1_id

    # Bob queries his own document status -> Success (200)
    res_bob_own = client.get(f"/api/portal/{token2}/documents/{doc2_id}/status")
    assert res_bob_own.status_code == 200
    assert res_bob_own.json()["document_id"] == doc2_id

    # Alice tries to query Bob's document using Alice's token -> Returns 404 (not found)
    res_cross_alice = client.get(f"/api/portal/{token1}/documents/{doc2_id}/status")
    assert res_cross_alice.status_code == 404
    assert res_cross_alice.json()["detail"] == "not_found"

    # Bob tries to query Alice's document using Bob's token -> Returns 404 (not found)
    res_cross_bob = client.get(f"/api/portal/{token2}/documents/{doc1_id}/status")
    assert res_cross_bob.status_code == 404
    assert res_cross_bob.json()["detail"] == "not_found"


def test_portal_nonexistent_document_id(client: TestClient):
    """Querying a non-existent document ID with a valid token returns 404."""
    _, _, token = _create_customer_with_token(client, "Charlie Day", "charlie@example.com", ["pan"])
    random_doc_id = str(uuid.uuid4())

    res = client.get(f"/api/portal/{token}/documents/{random_doc_id}/status")
    assert res.status_code == 404
    assert res.json()["detail"] == "not_found"


def test_portal_invalid_or_expired_token(client: TestClient):
    """An unknown, forged, or expired token returns generic 404 error without leaking customer data."""
    fake_token = "completely-bogus-token-000000000"

    # GET portal state
    res_get = client.get(f"/api/portal/{fake_token}")
    assert res_get.status_code == 404
    assert res_get.json()["detail"] == "invalid_or_expired_link"

    # POST upload
    res_post = client.post(f"/api/portal/{fake_token}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert res_post.status_code == 404
    assert res_post.json()["detail"] == "invalid_or_expired_link"

    # GET doc status
    res_doc = client.get(f"/api/portal/{fake_token}/documents/{uuid.uuid4()}/status")
    assert res_doc.status_code == 404
    assert res_doc.json()["detail"] == "invalid_or_expired_link"


def test_portal_state_scope_and_counters(client: TestClient):
    """Portal state displays first name, case status, correct document checklist, and counts."""
    _, _, token = _create_customer_with_token(client, "Diana Prince", "diana@example.com", ["pan", "passport"])

    res = client.get(f"/api/portal/{token}")
    assert res.status_code == 200
    data = res.json()

    assert data["first_name"] == "Diana"
    assert data["case_status"] == "in_progress"
    assert data["required_count"] == 2
    assert data["received_count"] == 0
    assert data["pending_count"] == 2
    assert len(data["documents"]) == 2
    for doc in data["documents"]:
        assert doc["state"] == "pending_upload"


def test_portal_rejected_document_and_resubmission(client: TestClient):
    """Rejected document transitions to resubmit and permits re-upload."""
    c_id, _, token = _create_customer_with_token(client, "Evan Wright", "evan@example.com", ["pan"])

    # Upload document
    u_res = client.post(f"/api/portal/{token}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u_res.status_code == 202
    doc_id = u_res.json()["document_id"]

    # Mark document as rejected in the database
    with session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.verification_status = "rejected"
        doc.ocr_status = "completed"

    # Query status endpoint
    st_res = client.get(f"/api/portal/{token}/documents/{doc_id}/status")
    assert st_res.status_code == 200
    st_data = st_res.json()
    assert st_data["state"] == "resubmit"
    assert st_data["message"] == "Please upload a clear, valid copy again."

    # Query portal state
    p_res = client.get(f"/api/portal/{token}")
    assert p_res.status_code == 200
    p_docs = p_res.json()["documents"]
    pan_doc = next(d for d in p_docs if d["doc_type"] == "pan")
    assert pan_doc["state"] == "resubmit"

    # Re-upload replacement file with new content
    new_data = PNG + b"_replacement_bytes_123"
    reup_res = client.post(f"/api/portal/{token}/upload", data={"doc_type": "pan"}, files={"file": ("pan_new.png", new_data, "image/png")})
    assert reup_res.status_code == 202
    new_doc_id = reup_res.json()["document_id"]
    assert new_doc_id != doc_id
    assert reup_res.json()["state"] == "processing"

    # Verify old doc was superseded
    with session_scope() as db:
        old_doc = db.get(Document, doc_id)
        assert old_doc.superseded is True
        assert old_doc.file_state == "deleted"
