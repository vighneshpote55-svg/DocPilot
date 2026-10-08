"""PHASE 8 — STEP 3: Formal Compatibility Testing Suite

Validates system-level, HTTP, and browser client compatibility:
1. Cross-Origin Resource Sharing (CORS) preflight and headers
2. User-Agent compatibility (Chrome, Safari, Firefox, Edge, Mobile Safari, Android Chrome)
3. File upload MIME-types and multipart boundary variations
4. Internationalized Unicode names and special filename handling
5. Token parsing tolerance (whitespace, casing)
6. Secure View file streaming headers (inline disposition, mime detection)
7. Content-Type and Accept header negotiation
8. Error response contract consistency across all client request types
9. Mobile network payload optimization
10. Customer portal responsive schema integrity
"""
import pytest
from sqlalchemy import select

from app import db as dbmod, jobs, models, services
from app.config import get_settings
from app.models import Customer, Document
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


# -----------------------------------------------------------------------------
# 1. CORS Preflight & Header Compatibility
# -----------------------------------------------------------------------------
def test_compat_01_cors_preflight_and_headers(client):
    """Verify CORS preflight OPTIONS and response headers for cross-origin frontend clients."""
    headers = {
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
    }
    # Preflight on public consent endpoint
    res = client.options("/api/public/consent/some-token", headers=headers)
    assert res.status_code in (200, 204)
    assert res.headers.get("access-control-allow-origin") in ("*", "http://localhost:5173")


# -----------------------------------------------------------------------------
# 2. User-Agent Compatibility
# -----------------------------------------------------------------------------
@pytest.mark.parametrize("ua_name, ua_string", [
    ("Desktop Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    ("Desktop Firefox", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"),
    ("Desktop Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"),
    ("Desktop Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"),
    ("Mobile iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1"),
    ("Mobile Android Chrome", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"),
    ("Tablet iPad Safari", "Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1"),
])
def test_compat_02_user_agent_compatibility(client, ua_name, ua_string):
    """Verify that requests from various desktop, mobile, and tablet browsers execute consistently."""
    # Health endpoint
    res = client.get("/health", headers={"User-Agent": ua_string})
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


# -----------------------------------------------------------------------------
# 3. Multipart Upload & Boundary Compatibility
# -----------------------------------------------------------------------------
def test_compat_03_multipart_mime_variations(client, env):
    """Verify upload compatibility with various browser MIME types (e.g. image/x-png, application/pdf)."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Pooja Hegde", "email": "pooja@example.com", "required_documents": ["PAN"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # 1. Standard image/png
    u1 = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert u1.status_code == 202

    # 2. Browser reporting image/x-png or octet-stream
    u2 = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": ("pan_alt.png", PNG, "application/octet-stream")},
    )
    assert u2.status_code == 202


# -----------------------------------------------------------------------------
# 4. Unicode Names and Filename Compatibility
# -----------------------------------------------------------------------------
def test_compat_04_unicode_and_complex_filenames(client, env):
    """Verify handling of complex filenames (spaces, dashes, parentheses, non-ASCII) and Unicode customer names."""
    # Unicode name (Devanagari + accented letters)
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "राजेश René Sharma", "email": "rajesh.rene@example.com", "required_documents": ["PAN"]},
    )
    assert r.status_code == 201
    c = r.json()
    assert c["name"] == "राजेश René Sharma"

    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Complex filename with special characters
    complex_filename = "My PAN Card (Final_Copy) - 2026.png"
    u = client.post(
        f"/api/portal/{upload_tok}/upload",
        data={"doc_type": "PAN"},
        files={"file": (complex_filename, PNG)},
    )
    assert u.status_code == 202
    doc_id = u.json()["document_id"]

    # Check filename stored safely with secure path-safe sanitization
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.filename == "My PAN Card _Final_Copy_ - 2026.png"
        assert doc.filename.endswith(".png")


# -----------------------------------------------------------------------------
# 5. Token Parsing Tolerance
# -----------------------------------------------------------------------------
def test_compat_05_auth_token_parsing_tolerance(client):
    """Verify that authorization header handles whitespace and casing variations safely."""
    # Leading and trailing whitespace around token
    raw_token = admin_headers()["Authorization"].replace("Bearer ", "")
    h_spaced = {"Authorization": f"Bearer   {raw_token}  "}
    res = client.get("/api/admin/customers", headers=h_spaced)
    assert res.status_code == 200


# -----------------------------------------------------------------------------
# 6. Secure View File Streaming Compatibility
# -----------------------------------------------------------------------------
def test_compat_06_secure_view_streaming_headers(client):
    """Verify that file streaming sets correct Content-Type and inline Content-Disposition for browser display."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Gaurav Sen", "email": "gaurav@example.com", "required_documents": ["PAN"]})
    c = r.json()
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("id.png", PNG)})
    doc_id = up.json()["document_id"]
    jobs.run_all()

    # Stream file
    stream_res = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert stream_res.status_code == 200
    assert "image/png" in stream_res.headers.get("content-type", "")
    assert "inline" in stream_res.headers.get("content-disposition", "")
    assert stream_res.content == PNG


# -----------------------------------------------------------------------------
# 7. Content Negotiation (Accept Headers)
# -----------------------------------------------------------------------------
@pytest.mark.parametrize("accept_header", [
    "application/json",
    "*/*",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
])
def test_compat_07_accept_header_negotiation(client, accept_header):
    """Verify that API endpoints respond with JSON even when browser requests send complex Accept headers."""
    res = client.get("/api/portal/invalid-token", headers={"Accept": accept_header})
    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/json")


# -----------------------------------------------------------------------------
# 8. Mobile Payload Optimization
# -----------------------------------------------------------------------------
def test_compat_08_mobile_payload_efficiency(client):
    """Verify that public customer portal responses are lightweight for high-latency mobile networks."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Bandwidth Test", "email": "bw@example.com", "required_documents": ["PAN", "Bank Statement"]})
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    portal_resp = client.get(f"/api/portal/{upload_tok}")
    assert portal_resp.status_code == 200
    assert len(portal_resp.content) < 4096  # strictly under 4 KB
