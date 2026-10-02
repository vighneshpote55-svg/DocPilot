from fastapi.testclient import TestClient

from app.db import session_scope
from app.models import Customer, Document
from tests.conftest import PNG, admin_headers, token_from_outbox


def _create_customer(client: TestClient, name: str, email: str, docs: list[str], grant_consent: bool = True) -> dict:
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": name,
        "email": email,
        "required_documents": docs,
        "send_consent": True,
    })
    assert res.status_code == 201
    cust = res.json()
    if grant_consent:
        consent_tok = token_from_outbox("consent")
        client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
        # reload customer details
        cust = client.get(f"/api/admin/customers/{cust['id']}", headers=admin_headers()).json()
    return cust


def test_admin_customers_status_filter(client: TestClient):
    """Staff can filter customer list by case_status (in_progress, completed, etc.)."""
    c1 = _create_customer(client, "Active Customer", "active@example.com", ["pan"])
    c2 = _create_customer(client, "Done Customer", "done@example.com", ["pan"])

    # Close c2 so it becomes completed
    close_res = client.post(f"/api/admin/customers/{c2['id']}/close", headers=admin_headers(), json={"reason": "Case finished"})
    assert close_res.status_code == 200

    # Query status=in_progress
    res_in_prog = client.get("/api/admin/customers?status=in_progress", headers=admin_headers())
    assert res_in_prog.status_code == 200
    ids_in_prog = [c["id"] for c in res_in_prog.json()]
    assert c1["id"] in ids_in_prog
    assert c2["id"] not in ids_in_prog

    # Query status=completed
    res_comp = client.get("/api/admin/customers?status=completed", headers=admin_headers())
    assert res_comp.status_code == 200
    ids_comp = [c["id"] for c in res_comp.json()]
    assert c2["id"] in ids_comp
    assert c1["id"] not in ids_comp
    assert int(res_comp.headers["X-Total-Count"]) >= 1


def test_admin_documents_ocr_status_filter(client: TestClient):
    """Staff can filter global documents list by ocr_status to track processing errors and failures."""
    c = _create_customer(client, "Doc Filter User", "docfilter@example.com", ["pan", "passport"])
    cid = c["id"]

    portal_tok = token_from_outbox("portal")

    # Upload PAN
    u1 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u1.status_code == 202
    doc1_id = u1.json()["document_id"]

    # Upload Passport
    u2 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "passport"}, files={"file": ("passport.png", PNG, "image/png")})
    assert u2.status_code == 202
    doc2_id = u2.json()["document_id"]

    # Set doc1 to completed OCR, doc2 to failed OCR
    with session_scope() as db:
        d1 = db.get(Document, doc1_id)
        d1.ocr_status = "completed"
        d1.verification_status = "verified"

        d2 = db.get(Document, doc2_id)
        d2.ocr_status = "failed"
        d2.verification_status = "manual_review"

    # Query ocr_status=failed (to find processing errors)
    r_failed = client.get("/api/admin/documents?ocr_status=failed", headers=admin_headers())
    assert r_failed.status_code == 200
    failed_docs = r_failed.json()
    failed_ids = [d["id"] for d in failed_docs]
    assert doc2_id in failed_ids
    assert doc1_id not in failed_ids

    # Query ocr_status=completed
    r_comp = client.get("/api/admin/documents?ocr_status=completed", headers=admin_headers())
    assert r_comp.status_code == 200
    comp_docs = r_comp.json()
    comp_ids = [d["id"] for d in comp_docs]
    assert doc1_id in comp_ids
    assert doc2_id not in comp_ids


def test_admin_summary_kpis(client: TestClient):
    """Admin summary returns accurate KPI counts including cases, docs, metrics, open reviews, and jobs."""
    _create_customer(client, "KPI User 1", "kpi1@example.com", ["pan"])
    res = client.get("/api/admin/summary", headers=admin_headers())
    assert res.status_code == 200
    data = res.json()

    assert "cases" in data
    assert "documents" in data
    assert "metrics" in data
    assert "open_reviews" in data
    assert "jobs" in data

    metrics = data["metrics"]
    assert "total_customers" in metrics
    assert "completed_customers" in metrics
    assert "completion_rate" in metrics
    assert "total_documents" in metrics
    assert "verified_documents" in metrics


def test_admin_secure_view_audit_record(client: TestClient):
    """Streaming document file via secure view logs a document_viewed audit entry."""
    c = _create_customer(client, "Audit View User", "auditview@example.com", ["pan"])
    portal_tok = token_from_outbox("portal")

    u = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    doc_id = u.json()["document_id"]

    # Secure View stream
    view_res = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert view_res.status_code == 200

    # Verify audit entry recorded
    audit_res = client.get("/api/admin/audit", headers=admin_headers())
    assert audit_res.status_code == 200
    audits = audit_res.json()
    assert any(a["action"] == "document_viewed" and a["entity_id"] == str(doc_id) for a in audits)
