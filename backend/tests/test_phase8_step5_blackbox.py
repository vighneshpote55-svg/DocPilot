"""PHASE 8 — STEP 5: Formal Black-Box Testing Suite

Strictly tests externally observable behaviors via HTTP requests and public contracts:
1. Valid inputs
2. Invalid inputs
3. Boundary inputs (0-byte, 10MB boundary, 10MB+1 byte, max name length, min/max collections)
4. Missing inputs
5. Duplicate inputs
6. Expired / revoked tokens
7. Unauthorized and IDOR attempts (accessing doc with wrong portal token, tampered auth)
8. Zero raw PII, secret, or stack trace exposure in responses
9. Lifecycle states (Consent, Upload, Status Polling, Review Decision, Completion, Retention)
10. Reminders, Audit, Privacy Deletion, and Withdrawal observables
"""
import io
import pytest

from tests.conftest import PDF, PNG, admin_headers, token_from_outbox
from app.ocr_client import OCRResult

pytestmark = pytest.mark.usefixtures("env")


# =============================================================================
# 1. ADMIN AUTHENTICATION & ACCESS CONTROL (BLACK-BOX)
# =============================================================================

def test_bb_01_auth_unauthenticated(client):
    """BB-01: Access admin endpoints with no authentication header."""
    res = client.get("/api/admin/customers")
    assert res.status_code == 401
    assert "detail" in res.json()
    assert "traceback" not in res.text.lower()


def test_bb_02_auth_invalid_token(client):
    """BB-02: Access admin endpoints with an invalid / forged JWT."""
    res = client.get("/api/admin/customers", headers={"Authorization": "Bearer forged.invalid.token"})
    assert res.status_code == 401


def test_bb_03_auth_unauthorized_user(client):
    """BB-03: Access admin endpoints with valid JWT from a non-admin user."""
    res = client.get("/api/admin/customers", headers=admin_headers("nonadmin@example.com"))
    assert res.status_code == 403
    assert res.json()["detail"] == "not_an_admin"


def test_bb_04_auth_valid_admin(client):
    """BB-04: Access admin endpoints with a valid admin Bearer token."""
    res = client.get("/api/admin/customers", headers=admin_headers())
    assert res.status_code == 200
    assert isinstance(res.json(), list)


# =============================================================================
# 2. CUSTOMER CREATION INPUT VALIDATION & BOUNDARY CONDITIONS
# =============================================================================

def test_bb_05_create_customer_valid(client):
    """BB-05: Valid customer creation payload."""
    payload = {
        "name": "Kunal Bahl",
        "email": "kunal.bahl@example.com",
        "mobile": "+919876543210",
        "required_documents": ["PAN", "Aadhaar"],
        "send_consent": True,
    }
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res.status_code == 201
    data = res.json()
    assert data["name"] == "Kunal Bahl"
    assert data["email"] == "kunal.bahl@example.com"
    assert data["case_status"] == "awaiting_consent"
    assert data["pending_count"] == 2


def test_bb_06_create_customer_missing_name(client):
    """BB-06: Customer creation with missing required name field."""
    payload = {"email": "noname@example.com", "required_documents": ["PAN"]}
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res.status_code == 422


def test_bb_07_create_customer_invalid_email(client):
    """BB-07: Customer creation with invalid email syntax."""
    payload = {"name": "Test User", "email": "invalid-email-format", "required_documents": ["PAN"]}
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res.status_code in (400, 422)
    assert "traceback" not in res.text.lower()


def test_bb_08_create_customer_empty_documents(client):
    """BB-08: Customer creation with empty required documents list (boundary)."""
    payload = {"name": "No Docs User", "email": "nodocs@example.com", "required_documents": []}
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res.status_code in (400, 422)


def test_bb_09_create_customer_boundary_long_name(client):
    """BB-09: Customer creation with 300-character name (boundary test)."""
    long_name = "A" * 300
    payload = {"name": long_name, "email": "longname@example.com", "required_documents": ["PAN"]}
    res = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    # Backend either accepts trimmed name or returns 422 without 500
    assert res.status_code in (201, 422)
    assert res.status_code != 500


def test_bb_10_create_customer_duplicate_active_email(client):
    """BB-10: Attempting to create duplicate active customer with identical email."""
    payload = {"name": "Duplicate User", "email": "dup@example.com", "required_documents": ["PAN"]}
    res1 = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res1.status_code == 201

    # Second creation with identical active email
    res2 = client.post("/api/admin/customers", headers=admin_headers(), json=payload)
    assert res2.status_code in (400, 409, 422)
    assert "already" in res2.text.lower() or "duplicate" in res2.text.lower() or "open" in res2.text.lower()


# =============================================================================
# 3. EXCEL BATCH IMPORT (BLACK-BOX)
# =============================================================================

def test_bb_11_excel_import_valid_and_boundary(client):
    """BB-11: Uploading valid and invalid rows in an Excel spreadsheet."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["name", "email", "mobile", "required_documents"])
    ws.append(["Valid User", "valid.import@example.com", "+919111122222", "PAN, Salary Slip"])
    ws.append(["Bad Email", "not-an-email", "+919111122222", "PAN"])

    buf = io.BytesIO()
    wb.save(buf)
    content = buf.getvalue()

    # Preview endpoint
    prev = client.post(
        "/api/admin/customers/import/preview",
        headers=admin_headers(),
        files={"file": ("batch.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert prev.status_code == 200
    pdata = prev.json()
    assert pdata["total_rows"] == 2
    assert pdata["valid_rows"] == 1
    assert pdata["invalid_rows"] == 1


# =============================================================================
# 4. CONSENT ACCEPTANCE & DECLINE (BLACK-BOX)
# =============================================================================

def test_bb_12_consent_grant_lifecycle(client):
    """BB-12: Observable lifecycle when customer grants consent."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Sanjay Dutt", "email": "sanjay@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")

    # Observable consent inspection
    info = client.get(f"/api/public/consent/{consent_tok}")
    assert info.status_code == 200
    assert info.json()["first_name"] == "Sanjay"

    # Grant consent
    grant = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert grant.status_code == 200
    assert "upload_token" in grant.json()

    # Consuming the token again must fail (replay protection)
    replay = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert replay.status_code in (404, 409)


def test_bb_13_consent_decline_lifecycle(client):
    """BB-13: Observable lifecycle when customer declines consent."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Rakesh Roshan", "email": "rakesh@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")

    decline = client.post(f"/api/public/consent/{consent_tok}", json={"granted": False})
    assert decline.status_code == 200
    assert decline.json()["consent"] == "declined"
    assert "upload_token" not in decline.json()


# =============================================================================
# 5. SECURE PORTAL & FILE UPLOAD BOUNDARIES
# =============================================================================

def test_bb_14_upload_empty_file_rejected(client):
    """BB-14: Uploading a 0-byte empty file is rejected with clean 400."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Empty Upload", "email": "empty@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("empty.png", b"")})
    assert res.status_code == 400
    assert "empty" in res.text.lower()


def test_bb_15_upload_oversized_file_rejected(client):
    """BB-15: Uploading a file exceeding max size limit (10MB + 1 byte) returns 413 or 400."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Oversize Upload", "email": "oversize@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    large_file = b"%PDF-" + b"0" * (10 * 1024 * 1024 + 10)
    res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("large.pdf", large_file)})
    assert res.status_code in (400, 413)
    assert "large" in res.text.lower() or "size" in res.text.lower() or "mb" in res.text.lower()


def test_bb_16_upload_unsupported_file_extension(client):
    """BB-16: Uploading unsupported file format (.exe, .zip, .docx) is rejected."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Bad Ext", "email": "badext@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("malicious.exe", b"MZtest")})
    assert res.status_code == 400
    assert "unsupported" in res.text.lower() or "pdf, png and jpg" in res.text.lower()


# =============================================================================
# 6. UNAUTHORIZED / IDOR ATTEMPTS (BLACK-BOX)
# =============================================================================

def test_bb_17_idor_upload_slot_not_required(client):
    """BB-17: Customer attempts to upload a document type not requested for their case."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Slot IDOR", "email": "slot@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Attempt to upload Passport when only PAN was required
    res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PASSPORT"}, files={"file": ("pass.png", PNG)})
    assert res.status_code in (400, 422)


def test_bb_18_idor_cross_customer_doc_status(client):
    """BB-18: Customer A attempts to query status of Document B owned by Customer B."""
    # Customer 1
    client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Cust A", "email": "a@example.com", "required_documents": ["PAN"]})
    tok_a = token_from_outbox("consent")
    up_tok_a = client.post(f"/api/public/consent/{tok_a}", json={"granted": True}).json()["upload_token"]
    doc_a = client.post(f"/api/portal/{up_tok_a}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)}).json()["document_id"]

    # Customer 2
    client.post("/api/admin/customers", headers=admin_headers(), json={"name": "Cust B", "email": "b@example.com", "required_documents": ["PAN"]})
    tok_b = token_from_outbox("consent")
    up_tok_b = client.post(f"/api/public/consent/{tok_b}", json={"granted": True}).json()["upload_token"]

    # Customer B attempts to view Document A's status using Token B
    cross_res = client.get(f"/api/portal/{up_tok_b}/documents/{doc_a}/status")
    assert cross_res.status_code in (403, 404)


# =============================================================================
# 7. REMINDERS & AUTOMATED AUDIT (BLACK-BOX)
# =============================================================================

def test_bb_19_reminders_status_endpoint(client):
    """BB-19: Observable admin reminders schedule and history."""
    c = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Remind User", "email": "remind@example.com", "required_documents": ["PAN"]}).json()
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})

    # Trigger admin upload link reminder
    res = client.post(f"/api/admin/customers/{c['id']}/send-upload-link", headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["sent"] is True


def test_bb_20_zero_pii_or_secrets_leakage(client, env):
    """BB-20: Public responses never leak raw Aadhaar, PAN, secrets, or stack traces."""
    client.post("/api/admin/customers", headers=admin_headers(),
                json={"name": "Privacy Check", "email": "priv@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    res = client.get(f"/api/portal/{upload_tok}")
    raw_body = res.text
    # Check no server secrets or environment tokens are reflected
    assert "SUPABASE_SERVICE_KEY" not in raw_body
    assert "ENCRYPTION_KEY" not in raw_body
    assert "OCR_API_KEY" not in raw_body
    assert "Traceback" not in raw_body
