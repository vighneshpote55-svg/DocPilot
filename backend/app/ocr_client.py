"""Adapter for the OCR service: POST /ocr/{doc_type}?sync=true (stateless)."""
import json
import logging
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from .config import get_settings
from .doc_types import OCR_TYPE_NAMES

log = logging.getLogger(__name__)


class OCRUnavailable(Exception):
    """Transient failure (timeout, connection, 5xx). The job queue retries these."""


class OCRResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: str = "error"  # success | low_confidence | error
    doc_type: str | None = None
    confidence: float = 0.0
    field_confidences: dict[str, Any] = {}
    extracted_fields: dict[str, Any] = {}
    reason: str | None = None
    cross_check: dict[str, Any] | None = None


class HTTPOCRClient:
    def extract(self, data: bytes, filename: str, mime: str, doc_type: str, expected: dict | None = None) -> OCRResult:
        s = get_settings()
        path_type = OCR_TYPE_NAMES.get(doc_type, doc_type)
        form = {"expected": json.dumps(expected)} if expected else None
        try:
            r = httpx.post(
                f"{s.ocr_url.rstrip('/')}/ocr/{path_type}",
                params={"sync": "true"},
                headers={"Authorization": f"Bearer {s.ocr_api_key}"},
                files={"file": (filename, data, mime)},
                data=form,
                timeout=httpx.Timeout(s.ocr_timeout_seconds, connect=10),
            )
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise OCRUnavailable(str(e)) from e
        if r.status_code >= 500 or r.status_code in (401, 403, 429):
            raise OCRUnavailable(f"OCR service returned {r.status_code}")
        if r.status_code >= 400:  # e.g. unsupported file: a permanent error for this document
            log.warning("OCR rejected document with %s", r.status_code)
            return OCRResult(status="error", reason=f"ocr_http_{r.status_code}")
        try:
            return OCRResult.model_validate(r.json())
        except Exception:
            return OCRResult(status="error", reason="ocr_invalid_response")


MOCK_EXTRACTED_TEMPLATES = {
    "pan": lambda name: {"pan_number": "ABCPE1234F", "name": name or "VIKRAM SHARMA"},
    "aadhaar": lambda name: {"aadhaar_number": "987654321012", "name": name or "VIKRAM SHARMA"},
    "passport": lambda name: {"passport_number": "A1234567", "name": name or "VIKRAM SHARMA"},
    "voter": lambda name: {"epic_number": "XYZ1234567", "name": name or "VIKRAM SHARMA"},
    "driving_licence": lambda name: {"licence_number": "DL-1420110012345", "name": name or "VIKRAM SHARMA"},
    "bank_statement": lambda name: {"account_number": "123456789012", "bank_name": "State Bank of India"},
    "salary_slip": lambda name: {"employee_name": name or "VIKRAM SHARMA", "employer_name": "Tech Corp Pvt Ltd"},
    "cancelled_cheque": lambda name: {"account_holder": name or "VIKRAM SHARMA", "ifsc": "SBIN0001234"},
    "itr": lambda name: {"acknowledgement_number": "123456789012345", "name": name or "VIKRAM SHARMA"},
    "udyam": lambda name: {"udyam_registration_number": "UDYAM-MH-01-0012345", "enterprise_name": "Sharma Enterprises"},
    "shop_establishment": lambda name: {"establishment_name": "Sharma Trading", "registration_number": "REG-12345"},
    "fssai": lambda name: {"fssai_licence_number": "12345678901234", "business_name": "Sharma Foods"},
    "utility_bill": lambda name: {"consumer_number": "1234567890", "bill_amount": "1250.00"},
}


class MockOCRClient:
    """Mock OCR provider for standalone development, testing, and offline demos (PDF Section 10)."""
    def extract(self, data: bytes, filename: str, mime: str, doc_type: str, expected: dict | None = None) -> OCRResult:
        expected_name = (expected or {}).get("name") if isinstance(expected, dict) else None

        # Heuristic detection from filename / content bytes for mismatch test cases
        fn = (filename or "").lower()
        content = (data or b"")[:2000].lower()
        detected_type = doc_type

        if b"permanent account number" in content or b"income tax" in content or "pan" in fn:
            detected_type = "pan"
        elif b"aadhaar" in content or b"uidai" in content or "aadhaar" in fn:
            detected_type = "aadhaar"
        elif b"passport" in content or "passport" in fn:
            detected_type = "passport"
        elif b"driving" in content or "driving" in fn:
            detected_type = "driving_licence"
        elif b"salary" in content or "salary" in fn:
            detected_type = "salary_slip"
        elif b"cheque" in content or "cheque" in fn:
            detected_type = "cancelled_cheque"

        tmpl = MOCK_EXTRACTED_TEMPLATES.get(detected_type)
        fields = tmpl(expected_name) if tmpl else {"name": expected_name or "VIKRAM SHARMA"}
        field_confs = {k: 0.95 for k in fields}
        return OCRResult(
            status="success",
            doc_type=detected_type,
            confidence=0.96,
            field_confidences=field_confs,
            extracted_fields=fields,
            reason=None,
        )


_client = None


def get_ocr_client():
    if _client is not None:
        return _client
    if get_settings().mock_ocr_mode:
        return MockOCRClient()
    return HTTPOCRClient()


def set_ocr_client(client) -> None:
    """Tests (or a different OCR backend) can swap the client."""
    global _client
    _client = client

