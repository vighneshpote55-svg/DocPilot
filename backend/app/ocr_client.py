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


_client = None


def get_ocr_client():
    return _client or HTTPOCRClient()


def set_ocr_client(client) -> None:
    """Tests (or a different OCR backend) can swap the client."""
    global _client
    _client = client
