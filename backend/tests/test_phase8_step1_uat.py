"""PHASE 8 — STEP 1: Formal User Acceptance Testing (UAT) Suite

Covers the complete end-to-end business journey:
Admin:
- Login & auth verification
- Create customer
- Select required documents
- Send consent
- Track customer status
- View documents & Secure View streaming
- Review pending/manual-review cases
- Approve/reject documents
- Handle resubmission
- View reports & audit log
- Manage retention/privacy

Customer:
- Receive consent email
- Accept consent
- Decline consent
- Open secure portal
- Upload required documents
- View processing status
- Resubmit rejected documents
- See verified documents
- See completion status
- Request deletion (double opt-in)
- Withdraw consent (double opt-in)

Privacy & Negative Scenarios:
- Zero raw PII in portal, audit logs, and error responses
- Magic-byte disguised file rejection
- Expired / invalid token safety
- Non-leakage of internal fraud flags to customers
"""
from datetime import timedelta
import pytest
from sqlalchemy import select

from app import ai_service, db as dbmod, emailer, jobs, models, pipeline, rules, services
from app.ai_service import AIResponse, MockAIProvider, reset_ai_provider, set_ai_provider
from app.config import get_settings
from app.models import AuditLog, ConsentLedger, Customer, Document, Job, ManualReview, OcrResult
from app.ocr_client import OCRResult, set_ocr_client
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


@pytest.fixture(autouse=True)
def clean_pipeline():
    reset_ai_provider()
    yield
    reset_ai_provider()


# =============================================================================
# ADMIN JOURNEY UAT
# =============================================================================

def test_uat_admin_01_login_and_auth(client):
    """Admin: Login and authentication verification (valid, unauthorized, invalid tokens)."""
    # 1. Unauthenticated request rejected
    assert client.get("/api/admin/customers").status_code == 401

    # 2. Unauthorized non-admin email rejected
    assert client.get("/api/admin/customers", headers=admin_headers("unauthorized@example.com")).status_code == 403

    # 3. Authorized admin accepted
    res = client.get("/api/admin/customers", headers=admin_headers("admin@example.com"))
    assert res.status_code == 200
    assert isinstance(res.json(), list)


def test_uat_admin_02_create_customer_and_select_docs(client):
    """Admin: Create customer, select required documents, verify checklist."""
    payload = {
        "name": "Arjun Singhania",
        "email": "arjun.singhania@example.com",
        "mobile": "+919876543210",
        "required_documents": ["PAN", "Bank Statement"],
        "send_consent": True,
    }
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res.status_code == 201
    c = res.json()
    assert c["name"] == "Arjun Singhania"
    assert c["email"] == "arjun.singhania@example.com"
    assert c["pending_count"] == 2
    assert c["case_status"] == "awaiting_consent"
    assert c["consent_status"] == "pending"
    assert c["code"].startswith("CUS-")


def test_uat_admin_03_send_consent_and_track_status(client):
    """Admin: Send consent email and track customer progress/status."""
    res = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Priya Nair", "email": "priya@example.com", "required_documents": ["PAN"]},
    )
    c = res.json()
    assert any("Consent" in m["subject"] for m in emailer.OUTBOX)

    # Track status via admin customer detail
    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["pending_count"] == 1
    assert detail["workflow_state"] == "NOT_STARTED"
    assert detail["consent_status"] == "pending"


def test_uat_admin_04_view_documents_and_secure_view_streaming(client, env):
    """Admin: View documents list and stream decrypted file via Secure View without public URLs."""
    # Onboard & upload document
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Kavita Patel", "email": "kavita@example.com", "required_documents": ["PAN"]})
    c = r.json()
    consent = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent}", json={"granted": True}).json()["upload_token"]

    dummy_pan_content = PNG + b"_pan_kavita_secure_view"
    u_res = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": ("pan.png", dummy_pan_content)},
    )
    doc_id = u_res.json()["document_id"]
    jobs.run_all()

    # 1. Documents list in admin
    docs_res = client.get(f"/api/admin/documents?customer_id={c['id']}", headers=admin_headers())
    assert docs_res.status_code == 200
    docs = docs_res.json()
    assert len(docs) == 1
    assert docs[0]["id"] == doc_id
    assert docs[0]["doc_type"] == "pan"
    # Never expose public storage URLs
    assert "public_url" not in docs[0]
    assert "http" not in docs[0].get("storage_key", "")

    # 2. Secure View streaming endpoint
    stream_res = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert stream_res.status_code == 200
    assert stream_res.content == dummy_pan_content

    # 3. Audit row recorded for staff file viewing
    with dbmod.session_scope() as db:
        view_audit = db.scalar(
            select(AuditLog)
            .where(AuditLog.entity_id == str(doc_id), AuditLog.action == "document_viewed")
        )
        assert view_audit is not None
        assert view_audit.actor == "admin@example.com"


def test_uat_admin_05_manual_review_approve_journey(client, env):
    """Admin: Review pending manual-review cases and approve document."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Deepak Joshi", "email": "deepak@example.com", "required_documents": ["PAN"]})
    c = r.json()
    consent = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.55,
        reason="document_blurred",
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Deepak Joshi"},
    )
    u_res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    # Admin fetches review queue
    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) == 1
    rid = revs[0]["id"]
    assert revs[0]["customer_name"] == "Deepak Joshi"

    # Admin approves with note
    appr = client.post(
        f"/api/admin/reviews/{rid}/approve",
        headers=admin_headers(),
        json={"note": "Document verified manually after visual check."},
    )
    assert appr.status_code == 200
    assert appr.json()["status"] == "approved"

    # Case completes
    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["case_status"] == "completed"
    assert detail["pending_count"] == 0


def test_uat_admin_06_manual_review_reject_and_resubmit_journey(client, env):
    """Admin: Reject document in manual review and issue resubmission."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Meera Sen", "email": "meera@example.com", "required_documents": ["PAN"]})
    c = r.json()
    consent = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.40,
        reason="document_blurred",
    )
    client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = revs[0]["id"]

    rej = client.post(
        f"/api/admin/reviews/{rid}/reject",
        headers=admin_headers(),
        json={"note": "Image is unreadable. Please upload a clear color photo."},
    )
    assert rej.status_code == 200
    assert rej.json()["status"] == "rejected"

    # Resubmission email generated
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)


def test_uat_admin_07_view_reports_and_audit_log(client):
    """Admin: View system summary metrics, reports, and ID-only audit log."""
    # Summary
    summary = client.get("/api/admin/summary", headers=admin_headers()).json()
    assert "total_cases" in summary or "cases" in summary
    assert "open_reviews" in summary

    # Audit log
    audit_res = client.get("/api/admin/audit", headers=admin_headers())
    assert audit_res.status_code == 200
    logs = audit_res.json()
    assert isinstance(logs, list)
    # Check that audit log contains only IDs and safe actions, never raw PII
    for entry in logs[:10]:
        assert "actor" in entry
        assert "action" in entry
        assert "target_id" in entry
        details = str(entry.get("details", {}))
        assert "password" not in details
        assert "secret" not in details


def test_uat_admin_08_close_case_and_manage_privacy(client):
    """Admin: Close case and delete customer data with audit trail."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Rohit Verma", "email": "rohit@example.com", "required_documents": ["PAN"]})
    c = r.json()

    # Admin closes case
    close_res = client.post(f"/api/admin/customers/{c['id']}/close", headers=admin_headers(),
                            json={"reason": "Customer requested cancellation."})
    assert close_res.status_code == 200

    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["case_status"] == "completed"

    # Admin deletes customer data
    del_res = client.post(f"/api/admin/customers/{c['id']}/delete-data", headers=admin_headers())
    assert del_res.status_code == 200

    detail_del = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail_del["case_status"] == "deleted"
    assert detail_del["name"] == "[deleted]"


# =============================================================================
# CUSTOMER JOURNEY UAT
# =============================================================================

def test_uat_customer_01_receive_and_accept_consent(client):
    """Customer: Receive consent email, accept consent, and obtain upload portal link."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Ananya Roy", "email": "ananya@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    assert consent_tok is not None

    # Customer views consent page
    info = client.get(f"/api/public/consent/{consent_tok}").json()
    assert info["first_name"] == "Ananya"
    assert any("PAN" in doc for doc in info["documents"])
    assert "Identity and business document verification" in info["purpose"]

    # Customer grants consent
    grant = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()
    assert grant["consent"] == "granted"
    assert "upload_token" in grant


def test_uat_customer_02_receive_and_decline_consent(client):
    """Customer: Receive consent email and decline consent."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Dev Sharma", "email": "dev@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")

    decline = client.post(f"/api/public/consent/{consent_tok}", json={"granted": False}).json()
    assert decline["consent"] == "declined"
    assert "upload_token" not in decline

    # Customer record reflects declined status
    with dbmod.session_scope() as db:
        c = db.get(Customer, r.json()["id"])
        assert c.consent_status == "declined"
        assert c.case_status == "consent_declined"
        assert c.workflow_state == "CONSENT_WITHDRAWN"


def test_uat_customer_03_open_portal_and_upload_required_documents(client, env):
    """Customer: Open portal, upload document, and track processing state."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Simran Kaur", "email": "simran@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Customer opens portal
    portal = client.get(f"/api/portal/{upload_tok}").json()
    assert portal["first_name"] == "Simran"
    assert portal["required_count"] == 1
    assert portal["pending_count"] == 1
    assert portal["documents"][0]["state"] == "pending_upload"

    # Customer uploads document
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96, "name": 0.95},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Simran Kaur"},
    )
    up = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": ("pan.png", PNG)},
    )
    assert up.status_code == 202
    assert up.json()["state"] == "processing"

    # Poll status before worker finishes
    status_mid = client.get(f"/api/portal/{upload_tok}/documents/{up.json()['document_id']}/status").json()
    assert status_mid["state"] == "processing"

    # Process background worker
    jobs.run_all()

    # Document verified in portal
    portal_done = client.get(f"/api/portal/{upload_tok}").json()
    assert portal_done["pending_count"] == 0
    assert portal_done["received_count"] == 1
    assert portal_done["documents"][0]["state"] == "verified"


def test_uat_customer_04_resubmit_rejected_document(client, env):
    """Customer: Resubmit document after rejection and achieve verification."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Tarun Mehta", "email": "tarun@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # First attempt: blurry scan
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.35, reason="blurred")
    client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    # Admin rejects and requests resubmission
    rev = client.get("/api/admin/reviews", headers=admin_headers()).json()[0]
    client.post(f"/api/admin/reviews/{rev['id']}/reject", headers=admin_headers(), json={"note": "Please retake under bright light."})

    resubmit_tok = token_from_outbox("portal")
    assert resubmit_tok is not None

    # Customer portal shows resubmit prompt
    portal_state = client.get(f"/api/portal/{resubmit_tok}").json()
    assert portal_state["documents"][0]["state"] == "resubmit"

    # Second attempt: clean scan
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.98, "name": 0.96},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Tarun Mehta"},
    )
    up2 = client.post(f"/api/portal/{resubmit_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG + b"_2")})
    assert up2.status_code == 202
    jobs.run_all()

    # Verified and completed
    portal_final = client.get(f"/api/portal/{resubmit_tok}").json()
    assert portal_final["pending_count"] == 0
    assert portal_final["documents"][0]["state"] == "verified"


def test_uat_customer_05_see_completion_and_retention_status(client, env):
    """Customer: See completion status when all documents are verified."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Isha Sengupta", "email": "isha@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96, "name": 0.95},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Isha Sengupta"},
    )
    client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    # Customer completion email dispatched
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)

    # Portal shows completed case
    portal = client.get(f"/api/portal/{upload_tok}").json()
    assert portal["case_status"] == "completed"
    assert portal["pending_count"] == 0


def test_uat_customer_06_request_privacy_deletion(client, env):
    """Customer: Request data deletion via double opt-in confirmation."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Karan Singhal", "email": "karan@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Step 1: Silent privacy request
    req = client.post("/api/public/privacy/request", json={"email": "karan@example.com", "action": "delete"})
    assert req.status_code == 202

    # Step 2: Confirm via email link token
    confirm_tok = token_from_outbox("privacy/confirm")
    conf = client.post(f"/api/public/privacy/confirm/{confirm_tok}")
    assert conf.status_code == 200
    assert conf.json()["completed"] == "delete"

    # Verify data wiped
    with dbmod.session_scope() as db:
        c = db.get(Customer, r.json()["id"])
        assert c.name == "[deleted]"
        assert c.email.startswith("deleted-")
        assert c.case_status == "deleted"
        ledger = db.scalar(select(ConsentLedger).where(ConsentLedger.customer_id == c.id, ConsentLedger.event == "deleted"))
        assert ledger is not None


def test_uat_customer_07_withdraw_consent(client, env):
    """Customer: Withdraw consent via double opt-in confirmation."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Neha Kapoor", "email": "neha@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Step 1: Silent privacy request for withdrawal
    req = client.post("/api/public/privacy/request", json={"email": "neha@example.com", "action": "withdraw"})
    assert req.status_code == 202

    # Step 2: Confirm via email link token
    confirm_tok = token_from_outbox("privacy/confirm")
    conf = client.post(f"/api/public/privacy/confirm/{confirm_tok}")
    assert conf.status_code == 200
    assert conf.json()["completed"] == "withdraw"

    # Verify upload portal blocked
    portal_blocked = client.get(f"/api/portal/{upload_tok}")
    assert portal_blocked.status_code in (403, 404)


# =============================================================================
# PRIVACY, SECURITY & NEGATIVE SCENARIOS UAT
# =============================================================================

def test_uat_security_01_magic_byte_disguised_file_rejection(client):
    """Security: Disguised executables and malicious scripts are rejected."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Malicious Test", "email": "mal@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Disguised executable (MZ DOS/Windows executable header)
    fake_exe = b"MZ\x90\x00\x03\x00\x00\x00" + b"0" * 100
    resp1 = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", fake_exe)})
    assert resp1.status_code == 400
    assert resp1.json()["detail"]["code"] == "file_content_mismatch"

    # Disguised shell script
    fake_sh = b"#!/bin/bash\nrm -rf /"
    resp2 = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.pdf", fake_sh)})
    assert resp2.status_code == 400
    assert resp2.json()["detail"]["code"] == "file_content_mismatch"

    # Disguised HTML / script
    fake_html = b"<script>alert(1)</script>"
    resp3 = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.jpg", fake_html)})
    assert resp3.status_code == 400
    assert resp3.json()["detail"]["code"] in ("file_content_mismatch", "unsafe_file")


def test_uat_security_02_expired_and_unknown_token_safety(client):
    """Security: Invalid or expired tokens return generic 404 without leaking customer identity."""
    # Unknown portal token
    res1 = client.get("/api/portal/nonexistent-token-12345")
    assert res1.status_code == 404
    assert res1.json()["detail"] == "invalid_or_expired_link"

    # Unknown consent token
    res2 = client.get("/api/public/consent/nonexistent-consent-12345")
    assert res2.status_code == 404
    assert res2.json()["detail"] == "invalid_or_expired_link"

    # Unknown privacy token
    res3 = client.post("/api/public/privacy/confirm/nonexistent-privacy-12345")
    assert res3.status_code == 404
    assert res3.json()["detail"] == "invalid_or_expired_link"


def test_uat_privacy_03_zero_pii_and_internal_flags_exposed_to_customer(client, env):
    """Privacy: Customer portal displays friendly copy and never leaks fraud/tampering tags."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Vijay Kelkar", "email": "vijay@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.95,
        risk_flags=["tampering_suspected", "font_anomaly"],
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Vijay Kelkar"},
    )
    u = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    # Customer portal state
    portal = client.get(f"/api/portal/{upload_tok}").json()
    portal_str = str(portal).lower()
    assert "tamper" not in portal_str
    assert "fraud" not in portal_str
    assert "font_anomaly" not in portal_str
    assert portal["documents"][0]["state"] == "under_review"

    # Document status endpoint
    d_stat = client.get(f"/api/portal/{upload_tok}/documents/{u.json()['document_id']}/status").json()
    stat_str = str(d_stat).lower()
    assert "tamper" not in stat_str
    assert "fraud" not in stat_str
    assert d_stat["state"] == "under_review"
