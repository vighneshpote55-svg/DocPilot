"""Adapter for the OCR service: POST /ocr/{doc_type}?sync=true (stateless)."""
import json
import re
import time
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
    detected_type: str | None = None
    confidence: float = 0.0
    field_confidences: dict[str, Any] = {}
    extracted_fields: dict[str, Any] = {}
    reason: str | None = None
    cross_check: dict[str, Any] | None = None
    qr_disagreements: list[dict[str, Any]] = []
    message: str | None = None
    risk_flags: list[str] | str | None = None
    risk_score: float | None = None
    verification_status: str | None = None


class HTTPOCRClient:
    def _poll_job(self, base_url: str, poll_url: str, headers: dict, timeout_seconds: int) -> OCRResult:
        url = poll_url if poll_url.startswith("http") else f"{base_url.rstrip('/')}{poll_url}"
        start_time = time.time()
        interval = 1.0

        while time.time() - start_time < timeout_seconds:
            try:
                r = httpx.get(url, headers=headers, timeout=httpx.Timeout(15.0, connect=5))
                if r.status_code == 200:
                    data = r.json()
                    status = data.get("status")
                    if status == "completed":
                        result_dict = data.get("result") or {}
                        return OCRResult.model_validate(result_dict)
                    elif status == "failed":
                        err_msg = data.get("error") or "ocr_job_failed"
                        return OCRResult(status="error", reason=str(err_msg))
                elif r.status_code >= 500 or r.status_code in (401, 403, 429):
                    raise OCRUnavailable(f"OCR polling returned {r.status_code}")
            except (httpx.TimeoutException, httpx.TransportError):
                pass
            time.sleep(interval)
            if interval < 3.0:
                interval += 0.5

        raise OCRUnavailable(f"OCR async job timed out after {timeout_seconds}s")

    def extract(
        self,
        data: bytes,
        filename: str,
        mime: str,
        doc_type: str,
        expected: dict | None = None,
        customer_id: str | int | None = None,
    ) -> OCRResult:
        s = get_settings()
        path_type = OCR_TYPE_NAMES.get(doc_type, doc_type)
        form: dict[str, Any] = {}
        if expected:
            form["expected"] = json.dumps(expected)
        if customer_id is not None:
            form["customer_id"] = str(customer_id)
        headers = {"Authorization": f"Bearer {s.ocr_api_key}"}

        # Detect heavy multi-page documents (e.g. PDFs with > 5 pages or bank statements / ITRs > 3 pages)
        is_pdf = data[:5] == b"%PDF-" or filename.lower().endswith(".pdf")
        is_heavy = False
        if is_pdf:
            try:
                page_count = len(re.findall(rb"/Type[\s/]*Page", data))
                if page_count > 5 or (doc_type in ("bank_statement", "itr") and page_count > 3):
                    is_heavy = True
                    log.info("Detected multi-page document (%d pages) for doc_type '%s', using async OCR queue.", page_count, doc_type)
            except Exception:
                pass

        params = {} if is_heavy else {"sync": "true"}

        try:
            r = httpx.post(
                f"{s.ocr_url.rstrip('/')}/ocr/{path_type}",
                params=params,
                headers=headers,
                files={"file": (filename, data, mime)},
                data=form,
                timeout=httpx.Timeout(s.ocr_timeout_seconds, connect=10),
            )
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise OCRUnavailable(str(e)) from e

        # Handle async job enqueue response (202 Accepted)
        if r.status_code == 202:
            try:
                job_data = r.json()
                poll_url = job_data.get("poll_url") or f"/ocr/jobs/{job_data.get('job_id')}"
                return self._poll_job(s.ocr_url, poll_url, headers, s.ocr_timeout_seconds)
            except Exception as e:
                if isinstance(e, OCRUnavailable):
                    raise
                raise OCRUnavailable(f"Failed to track async OCR job: {e}") from e

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
    "gst_certificate": lambda name: {"gstin": "27ABCDE1234F1Z5", "legal_name": "Sharma Enterprises Pvt Ltd"},
    "certificate_of_incorporation": lambda name: {"cin": "U72900MH2025PTC123456", "company_name": "Sharma Tech Solutions Pvt Ltd"},
    "partnership_deed": lambda name: {"firm_name": "Sharma & Associates", "partner_names_masked": ["V. S*****"]},
    "rent_agreement": lambda name: {"monthly_rent": "25000", "lessor_name_masked": "R. K****"},
    "form_16": lambda name: {"employer_name": "Tech Corp Pvt Ltd", "pan_number": "ABCPE1234F"},
    "bank_passbook": lambda name: {"bank_name": "State Bank of India", "ifsc": "SBIN0001234", "account_number_masked": "XXXXXXX1234"},
    "property_tax_receipt": lambda name: {"property_id": "PID-12345678", "tax_amount_paid": "5000.00"},
    "iec_certificate": lambda name: {"iec_number": "0123456789", "entity_name": "Sharma Global Exports"},
    "income_certificate": lambda name: {"certificate_number": "MH-INC-2025-123456", "annual_income": "250000", "applicant_name": name or "VIKRAM SHARMA"},
}


class MockOCRClient:
    """Mock OCR provider for standalone development, testing, and offline demos (PDF Section 10)."""
    def extract(
        self,
        data: bytes,
        filename: str,
        mime: str,
        doc_type: str,
        expected: dict | None = None,
        customer_id: str | int | None = None,
    ) -> OCRResult:
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
        elif b"gst" in content or "gst" in fn:
            detected_type = "gst_certificate"
        elif b"incorporation" in content or "incorporation" in fn:
            detected_type = "certificate_of_incorporation"
        elif b"partnership" in content or "partnership" in fn:
            detected_type = "partnership_deed"
        elif b"rent" in content or "rent" in fn:
            detected_type = "rent_agreement"
        elif b"form 16" in content or "form_16" in fn or "form16" in fn:
            detected_type = "form_16"
        elif b"passbook" in content or "passbook" in fn:
            detected_type = "bank_passbook"
        elif b"property tax" in content or "property_tax" in fn:
            detected_type = "property_tax_receipt"
        elif b"iec" in content or "iec" in fn:
            detected_type = "iec_certificate"
        elif b"income cert" in content or "income_cert" in fn:
            detected_type = "income_certificate"

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

