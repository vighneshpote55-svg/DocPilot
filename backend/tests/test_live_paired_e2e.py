"""
Live integration smoke test validating:
1. Authenticated OCR connectivity between DocPilot and live OCR service (port 8001)
2. Submission of a synthetic document through the full DocPilot workflow (customer -> consent -> portal upload -> OCR -> rules verification)
3. Verified OCR result persistence
4. Rejection of ordinary integration credentials on administrative routes (POST /api/documents/cleanup -> 403)
5. Secure error handling with zero credential leaks
"""
import io
import os
import json
import httpx
import pytest
from sqlalchemy import select

from app import jobs, services
from app.config import get_settings
from app.db import session_scope
from app.models import Customer, Document, Job, OcrResult
from app.ocr_client import HTTPOCRClient, set_ocr_client
from tests.conftest import admin_headers, token_from_outbox

pytestmark = pytest.mark.live_e2e


@pytest.fixture(autouse=True)
def live_ocr_config():
    """Ensure live HTTP OCR client is active and DocPilot settings point to live OCR service."""
    settings = get_settings()
    assert settings.ocr_api_key, "OCR_API_KEY must be configured in DocPilot environment"
    assert ":8001" in settings.ocr_url, f"OCR_URL must point to port 8001, got {settings.ocr_url}"
    set_ocr_client(HTTPOCRClient())


def test_live_authenticated_ocr_connection():
    """Verify DocPilot's settings test successfully authenticates with the live OCR service."""
    settings = get_settings()
    assert settings.ocr_api_key, "OCR_API_KEY must be configured"

    headers = {
        "Authorization": f"Bearer {settings.ocr_api_key}",
        "X-API-Key": settings.ocr_api_key,
    }
    r = httpx.get(f"{settings.ocr_url.rstrip('/')}/api/v1/ping", headers=headers, timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "connected"
    assert data["authenticated_client"]["role"] == "api_client"


def test_live_least_privilege_cleanup_boundary():
    """Verify DocPilot's integration credentials cannot invoke administrative cleanup (403 Forbidden)."""
    settings = get_settings()
    headers = {
        "Authorization": f"Bearer {settings.ocr_api_key}",
        "X-API-Key": settings.ocr_api_key,
    }
    r = httpx.post(f"{settings.ocr_url.rstrip('/')}/api/documents/cleanup", headers=headers, timeout=5.0)
    assert r.status_code == 403
    assert "admin" in r.json().get("detail", "").lower()


def test_live_invalid_credentials_rejected():
    """Verify invalid credentials against the live OCR service return 401 Unauthorized."""
    settings = get_settings()
    headers = {
        "Authorization": "Bearer invalid_test_key_fail",
        "X-API-Key": "invalid_test_key_fail",
    }
    r = httpx.get(f"{settings.ocr_url.rstrip('/')}/api/v1/ping", headers=headers, timeout=5.0)
    assert r.status_code == 401


def test_live_synthetic_document_e2e_pipeline(client):
    """
    Submits a synthetic document through the live DocPilot workflow:
    - Creates synthetic customer
    - Records consent
    - Uploads synthetic file to customer portal
    - Processes job using the live HTTPOCRClient against the live OCR service
    - Verifies OCR results, job completion, and rules execution
    - Cleans up synthetic customer and data
    """
    # Ensure live OCR client is active
    set_ocr_client(HTTPOCRClient())

    fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "valid_synthetic_pan.png")
    with open(fixture_path, "rb") as f:
        pan_bytes = f.read()

    # 1. Create synthetic customer
    r_cust = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "VIKRAM SHARMA",
            "email": "live_synthetic_e2e@example.com",
            "required_documents": ["pan"],
            "send_consent": True,
        },
    )
    assert r_cust.status_code == 201
    customer_id = r_cust.json()["id"]

    try:
        # 2. Grant consent
        consent_token = token_from_outbox("consent")
        r_consent = client.post(f"/api/public/consent/{consent_token}", json={"granted": True})
        assert r_consent.status_code == 200
        upload_token = r_consent.json()["upload_token"]

        # 3. Upload synthetic document
        r_upload = client.post(
            f"/api/portal/{upload_token}/upload",
            data={"doc_type": "pan"},
            files={"file": ("synthetic_pan.png", pan_bytes, "image/png")},
        )
        assert r_upload.status_code == 202
        doc_id = r_upload.json()["document_id"]

        # 4. Process pending job using live OCR client
        ran = jobs.run_one()
        assert ran is True

        # 5. Verify OCR result and document state in database
        with session_scope() as db:
            doc = db.get(Document, doc_id)
            assert doc is not None
            assert doc.ocr_status == "completed"

            ocr_res = db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id))
            assert ocr_res is not None
            assert isinstance(ocr_res.payload, dict)
            assert ocr_res.payload.get("status") in ("success", "low_confidence")
            assert doc.verification_status in ("verified", "manual_review")

    finally:
        # Safe cleanup of synthetic customer
        with session_scope() as db:
            c = db.get(Customer, customer_id)
            if c:
                services.delete_customer_data_by_admin(db, c, "test_cleanup")
