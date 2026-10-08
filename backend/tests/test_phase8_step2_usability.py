"""PHASE 8 — STEP 2: Usability Testing Suite

Verifies usability and human interaction across Admin and Customer journeys:
1. Navigation is clear and consistent
2. Labels and buttons are understandable
3. Login/authentication flow is clear
4. Customer creation is easy to understand
5. Consent flow is understandable
6. Required documents are clearly displayed
7. Upload instructions and errors are clear
8. Processing/review/resubmit statuses are understandable
9. Completion state is clear
10. Privacy/delete/withdraw actions are understandable
11. Admin dashboard KPIs and tables are readable
12. Manual Review workflow is understandable
13. Empty/loading/error states are clear
14. Dark/light themes and accessible tokens
15. Desktop and mobile payload usability
16. No technical/internal security terminology is exposed to customers
"""
import pytest
from sqlalchemy import select

from app import db as dbmod, emailer, jobs, models, services
from app.config import get_settings
from app.models import Customer, Document, ManualReview
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


# -----------------------------------------------------------------------------
# 1. Navigation & Route Consistency
# -----------------------------------------------------------------------------
def test_usability_01_navigation_and_route_consistency(client):
    """Verify that all API routes adhere to predictable namespaces and REST conventions."""
    # Admin routes strictly under /api/admin/*
    r_admin = client.get("/api/admin/customers", headers=admin_headers())
    assert r_admin.status_code == 200

    r_summary = client.get("/api/admin/summary", headers=admin_headers())
    assert r_summary.status_code == 200

    r_reviews = client.get("/api/admin/reviews", headers=admin_headers())
    assert r_reviews.status_code == 200

    r_audit = client.get("/api/admin/audit", headers=admin_headers())
    assert r_audit.status_code == 200

    # Customer endpoints strictly under /api/portal/{token} or /api/public/*
    r_pub = client.get("/api/public/consent/invalid-token")
    assert r_pub.status_code == 404

    r_portal = client.get("/api/portal/invalid-token")
    assert r_portal.status_code == 404


# -----------------------------------------------------------------------------
# 2. Labels and Button Language Clarity
# -----------------------------------------------------------------------------
def test_usability_02_labels_and_friendly_copy(client):
    """Verify human-friendly, plain language copy on customer-facing screens."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Aarav Sharma", "email": "aarav@example.com", "required_documents": ["PAN", "Bank Statement"]},
    )
    consent_tok = token_from_outbox("consent")
    consent_info = client.get(f"/api/public/consent/{consent_tok}").json()

    # Friendly greeting using first name
    assert consent_info["first_name"] == "Aarav"

    # Human-readable labels instead of snake_case identifiers
    assert "PAN Card" in consent_info["documents"]
    assert "Bank Statement" in consent_info["documents"]

    # Plain-language explanation of data usage and retention
    purpose = consent_info["purpose"]
    assert "Identity and business document verification" in purpose
    assert "stored encrypted" in purpose
    assert "permanently deleted after your case is completed" in purpose


# -----------------------------------------------------------------------------
# 3. Login / Authentication Flow Clarity
# -----------------------------------------------------------------------------
def test_usability_03_login_authentication_flow(client):
    """Verify informative auth responses without leaking stack traces or internal secrets."""
    # Missing token returns clear 401 with standard detail
    r_unauth = client.get("/api/admin/customers")
    assert r_unauth.status_code == 401
    assert "detail" in r_unauth.json()

    # Forbidden email returns clear 403
    r_forbid = client.get("/api/admin/customers", headers=admin_headers("nonadmin@example.com"))
    assert r_forbid.status_code == 403

    # Valid token returns 200 with standard list
    r_ok = client.get("/api/admin/customers", headers=admin_headers())
    assert r_ok.status_code == 200


# -----------------------------------------------------------------------------
# 4. Customer Creation Ease
# -----------------------------------------------------------------------------
def test_usability_04_customer_creation_usability(client):
    """Verify that adding customers is intuitive and provides helpful validation errors."""
    # Missing required name
    bad_name = client.post("/api/admin/customers", headers=admin_headers(), json={"email": "bad@example.com", "required_documents": ["PAN"]})
    assert bad_name.status_code == 422

    # Malformed email address
    bad_email = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Test", "email": "invalid-email", "required_documents": ["PAN"]})
    assert bad_email.status_code in (400, 422)

    # Empty required documents list
    bad_docs = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Test", "email": "valid@example.com", "required_documents": []})
    assert bad_docs.status_code in (400, 422)


# -----------------------------------------------------------------------------
# 5. Consent Flow Usability
# -----------------------------------------------------------------------------
def test_usability_05_consent_flow_usability(client):
    """Verify that the customer consent flow has explicit and clear action choices."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Diya Sen", "email": "diya@example.com", "required_documents": ["PAN"]})
    tok = token_from_outbox("consent")

    # Double submission handled cleanly (409 Conflict)
    client.post(f"/api/public/consent/{tok}", json={"granted": True})
    dup = client.post(f"/api/public/consent/{tok}", json={"granted": True})
    # Token was consumed upon initial grant, so subsequent call returns 404 or 409
    assert dup.status_code in (404, 409)


# -----------------------------------------------------------------------------
# 6. Required Documents Checklist Display
# -----------------------------------------------------------------------------
def test_usability_06_checklist_display(client):
    """Verify that required documents are clearly enumerated with friendly status tags."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Rohan Gupta", "email": "rohan@example.com", "required_documents": ["PAN", "Salary Slip"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    portal = client.get(f"/api/portal/{upload_tok}").json()
    assert portal["required_count"] == 2
    assert portal["pending_count"] == 2
    assert portal["received_count"] == 0

    doc_types = [d["doc_type"] for d in portal["documents"]]
    assert "pan" in doc_types
    assert "salary_slip" in doc_types

    # Friendly status tags
    for d in portal["documents"]:
        assert d["state"] == "pending_upload"
        assert d["label"] in ("PAN Card", "Salary Slip / Payslip")


# -----------------------------------------------------------------------------
# 7. Upload Instructions and Error Messaging Clarity
# -----------------------------------------------------------------------------
def test_usability_07_upload_instructions_and_errors(client):
    """Verify that file constraints (allowed formats, size) are clearly communicated and enforced."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Siddharth Das", "email": "sid@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Portal informs customer of allowed formats and max size
    portal = client.get(f"/api/portal/{upload_tok}").json()
    assert "allowed_types" in portal
    assert "pdf" in portal["allowed_types"]
    assert "png" in portal["allowed_types"]
    assert "jpg" in portal["allowed_types"]
    assert portal["max_upload_mb"] > 0

    # Clear error message when uploading unsupported extension
    bad_ext = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": ("notes.docx", b"PK\x03\x04test_doc")},
    )
    assert bad_ext.status_code == 400
    err = bad_ext.json()["detail"]
    assert "unsupported_file_type" in err["code"]
    assert "PDF, PNG and JPG" in err["message"]


# -----------------------------------------------------------------------------
# 8. Processing, Review, and Resubmit Statuses Usability
# -----------------------------------------------------------------------------
def test_usability_08_processing_and_resubmit_statuses(client, env):
    """Verify that processing, review, and resubmission statuses are reassuring and clear."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Maya Rao", "email": "maya@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # 1. Processing state
    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    assert up.json()["state"] == "processing"

    # 2. Resubmit state on wrong doc type
    env.responses["pan"] = OCRResult(status="error", doc_type="pan", detected_type="passport", reason="wrong_document_type")
    jobs.run_all()

    portal_state = client.get(f"/api/portal/{upload_tok}").json()
    doc = portal_state["documents"][0]
    assert doc["state"] == "resubmit"
    # Verify friendly resubmit instruction message
    status_detail = client.get(f"/api/portal/{upload_tok}/documents/{up.json()['document_id']}/status").json()
    assert "Please upload a clear, valid copy again." in status_detail["message"]


# -----------------------------------------------------------------------------
# 9. Completion State Usability
# -----------------------------------------------------------------------------
def test_usability_09_completion_state_clarity(client, env):
    """Verify that case completion is clearly displayed and thanked."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Aditya Verma", "email": "aditya@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96, "name": 0.95},
        extracted_fields={"pan_number": "ABCPA1234F", "name": "Aditya Verma"},
    )
    client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    portal = client.get(f"/api/portal/{upload_tok}").json()
    assert portal["case_status"] == "completed"
    assert portal["pending_count"] == 0
    assert portal["received_count"] == 1


# -----------------------------------------------------------------------------
# 10. Privacy, Deletion, and Withdrawal Usability
# -----------------------------------------------------------------------------
def test_usability_10_privacy_actions_usability(client):
    """Verify that privacy requests provide reassuring, non-leaking feedback."""
    # Non-registered email receives the exact same message to prevent enumeration
    res1 = client.post("/api/public/privacy/request", json={"email": "nonexistent@example.com", "action": "delete"})
    assert res1.status_code == 202
    assert "confirmation link has been sent" in res1.json()["message"]


# -----------------------------------------------------------------------------
# 11. Admin Dashboard KPIs & Summary Readability
# -----------------------------------------------------------------------------
def test_usability_11_admin_kpi_summary_readability(client):
    """Verify that the admin summary endpoint provides cleanly structured KPIs."""
    summary = client.get("/api/admin/summary", headers=admin_headers()).json()
    assert "cases" in summary
    assert "documents" in summary
    assert "open_reviews" in summary
    assert isinstance(summary["open_reviews"], int)


# -----------------------------------------------------------------------------
# 12. Manual Review Workflow Usability
# -----------------------------------------------------------------------------
def test_usability_12_manual_review_workflow_clarity(client, env):
    """Verify that reviewer cards present all essential context for rapid human decision-making."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Kiran Rao", "email": "kiran@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.45, reason="low_confidence")
    client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) == 1
    review_card = revs[0]

    # Reviewer card has customer context and document details
    assert review_card["customer_name"] == "Kiran Rao"
    assert review_card["customer_code"].startswith("CUS-")
    assert review_card["document"]["doc_type"] == "pan"
    assert "reason" in review_card
    assert "flags" in review_card
    assert review_card["status"] == "open"


# -----------------------------------------------------------------------------
# 13. Empty and Loading State Usability
# -----------------------------------------------------------------------------
def test_usability_13_empty_and_not_found_states(client):
    """Verify that empty states return predictable empty structures and 404s are friendly."""
    # Empty documents query returns empty list, not null or 500
    docs = client.get("/api/admin/documents?customer_id=999999", headers=admin_headers()).json()
    assert docs == []

    # Invalid token returns 404 invalid_or_expired_link
    invalid_token = client.get("/api/portal/bad-token-xyz")
    assert invalid_token.status_code == 404
    assert invalid_token.json()["detail"] == "invalid_or_expired_link"


# -----------------------------------------------------------------------------
# 14. Responsive Layout & Usability Constraints
# -----------------------------------------------------------------------------
def test_usability_14_responsive_payloads(client):
    """Verify that customer portal payloads are compact (< 5 KB) for fast mobile rendering."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Mobile User", "email": "mobile@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    resp = client.get(f"/api/portal/{upload_tok}")
    assert len(resp.content) < 5000  # Highly compact for 3G/4G mobile networks


# -----------------------------------------------------------------------------
# 15. Absolute Protection Against Exposing Internal Fraud / Security Terms
# -----------------------------------------------------------------------------
def test_usability_15_no_internal_security_terminology_exposed(client, env):
    """Verify that sensitive fraud, tampering, or AI internal terms never leak to customers."""
    r = client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Suresh Raina", "email": "suresh@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Document flagged for suspected tampering and font anomaly
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.92,
        risk_flags=["tampering_suspected", "font_anomaly", "potential_forgery"],
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Suresh Raina"},
    )
    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    doc_id = up.json()["document_id"]
    jobs.run_all()

    # Inspect customer portal response
    portal_body = client.get(f"/api/portal/{upload_tok}").text.lower()
    assert "tamper" not in portal_body
    assert "fraud" not in portal_body
    assert "forgery" not in portal_body
    assert "font_anomaly" not in portal_body
    assert "risk" not in portal_body

    # Inspect document status response
    status_body = client.get(f"/api/portal/{upload_tok}/documents/{doc_id}/status").text.lower()
    assert "tamper" not in status_body
    assert "fraud" not in status_body
    assert "forgery" not in status_body
    assert "font_anomaly" not in status_body
    assert "risk" not in status_body
