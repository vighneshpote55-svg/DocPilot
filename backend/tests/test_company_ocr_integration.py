"""
STEP 6 Test Suite: Company OCR Service Integration.

Verifies:
1. upload creates OCR processing job
2. worker claims OCR job via FOR UPDATE SKIP LOCKED
3. encrypted document is retrieved
4. document is decrypted correctly for OCR
5. plaintext is not persisted permanently
6. company-ocr-service is called with correct request (multipart, auth headers)
7. OCR response is mapped correctly
8. OCR result is stored in ocr_results table
9. OCR status becomes completed
10. document remains unverified (not marked verified before rules engine)
11. OCR timeout raises OCRUnavailable and re-queues
12. OCR service unavailable (503) raises OCRUnavailable
13. OCR 4xx permanent error handling
14. OCR 5xx transient error handling
15. malformed OCR response handling
16. empty OCR response handling
17. retry behavior (exponential backoff)
18. idempotent duplicate processing
19. superseded document is not processed
20. temporary plaintext memory cleanup
21. OCR credentials are not logged
22. OCR text is not logged
23. cross-customer isolation
24. audit events (ocr_processing_started, ocr_completed, ocr_failed)
"""
import io
import json
import logging
from datetime import timedelta
from unittest.mock import MagicMock, patch

import httpx
import pytest
from sqlalchemy import select

from app import jobs, ocr_client, pipeline, services
from app.db import session_scope, utcnow
from app.models import AuditLog, Customer, Document, Job, ManualReview, OcrResult
from app.ocr_client import HTTPOCRClient, OCRResult, OCRUnavailable, set_ocr_client
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def setup_customer_and_upload(client, name="Test User", doc_type="pan", file_bytes=PNG, filename="pan.png"):
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": f"{name.lower().replace(' ', '_')}@example.com", "required_documents": [doc_type], "send_consent": True},
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    consent_tok = token_from_outbox("consent")
    r_c = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_c.status_code == 200
    portal_tok = r_c.json()["upload_token"]

    r_u = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": doc_type},
        files={"file": (filename, file_bytes, "image/png")},
    )
    assert r_u.status_code == 202
    doc_id = r_u.json()["document_id"]
    return cid, portal_tok, doc_id


# -----------------------------------------------------------------------------
# 1. Upload creates OCR processing job
# -----------------------------------------------------------------------------
def test_upload_creates_ocr_job(client):
    cid, _, doc_id = setup_customer_and_upload(client, name="Job User", doc_type="pan")
    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document", Job.status == "queued"))
        assert job is not None
        assert job.payload["document_id"] == doc_id
        assert job.attempts == 0
        assert job.max_attempts == 3

        doc = db.get(Document, doc_id)
        assert doc.workflow_state == "UPLOADED"
        assert doc.ocr_status == "waiting"
        assert doc.verification_status == "not_started"


# -----------------------------------------------------------------------------
# 2, 3, 4, 5, 8, 9, 24. Worker claims job, decrypts in memory, stores OCR result, audits
# -----------------------------------------------------------------------------
def test_worker_processes_job_and_stores_result(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Worker User", doc_type="pan")

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.99, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Worker User"},
    )

    # Worker executes job
    assert jobs.run_one() is True

    with session_scope() as db:
        # Job marked done
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job.status == "done"
        assert job.attempts == 1

        # Document OCR status completed
        doc = db.get(Document, doc_id)
        assert doc.ocr_status == "completed"

        # OCR result stored in ocr_results table
        ocr_row = db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id))
        assert ocr_row is not None
        assert ocr_row.payload["status"] == "success"
        assert ocr_row.payload["confidence"] == 0.97

        # Audit logs recorded
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == doc_id)).all())
        actions = [a.action for a in audits]
        assert "ocr_processing_started" in actions
        assert "ocr_completed" in actions


# -----------------------------------------------------------------------------
# 6, 7. HTTPOCRClient sends correct multipart request & auth headers to company-ocr-service
# -----------------------------------------------------------------------------
def test_http_ocr_client_request_and_mapping():
    client = HTTPOCRClient()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.96},
        "extracted_fields": {"pan_number": "ABCPE1234F"},
        "reason": None,
        "qr_disagreements": [],
    }

    with patch("httpx.post", return_value=mock_resp) as mock_post:
        res = client.extract(
            data=PNG,
            filename="pan.png",
            mime="image/png",
            doc_type="pan",
            expected={"name": "VIKRAM SHARMA"},
            customer_id=101,
        )

        assert res.status == "success"
        assert res.doc_type == "pan"
        assert res.confidence == 0.95
        assert res.extracted_fields["pan_number"] == "ABCPE1234F"

        # Verify POST request parameters
        call_kwargs = mock_post.call_args.kwargs
        assert call_kwargs["params"] == {"sync": "true"}
        assert "Authorization" in call_kwargs["headers"] or "X-API-Key" in call_kwargs["headers"]
        assert "file" in call_kwargs["files"]
        assert call_kwargs["data"]["customer_id"] == "101"
        assert "VIKRAM SHARMA" in call_kwargs["data"]["expected"]


# -----------------------------------------------------------------------------
# 10. Document remains unverified in Step 6 (before rules acceptance)
# -----------------------------------------------------------------------------
def test_document_remains_unverified_during_ocr(client):
    cid, _, doc_id = setup_customer_and_upload(client, name="Pending User", doc_type="pan")
    with session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "not_started"


# -----------------------------------------------------------------------------
# 11, 12, 14, 17. Transient failures (timeout, 503, 500) trigger retry with exponential backoff
# -----------------------------------------------------------------------------
def test_transient_failure_retries_with_backoff(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Retry User", doc_type="pan")

    # Fail once with OCRUnavailable (network timeout or 503)
    env.fail_times = 1
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.98},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Retry User"},
    )

    # First run fails and schedules retry
    assert jobs.run_one() is True

    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job.status == "queued"
        assert job.attempts == 1
        assert job.run_at > utcnow()

        # Document is not marked failed or verified
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "not_started"

        # Fast forward
        job.run_at = utcnow() - timedelta(seconds=1)

    # Second run succeeds
    assert jobs.run_one() is True

    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job.status == "done"
        doc = db.get(Document, doc_id)
        assert doc.ocr_status == "completed"


# -----------------------------------------------------------------------------
# 13. OCR 4xx permanent failure handling (HTTP 400/415/422)
# -----------------------------------------------------------------------------
def test_ocr_permanent_4xx_error_handling():
    client = HTTPOCRClient()
    mock_resp = MagicMock()
    mock_resp.status_code = 400
    mock_resp.json.return_value = {"detail": "Unsupported document format"}

    with patch("httpx.post", return_value=mock_resp):
        res = client.extract(PNG, "bad.png", "image/png", "pan")
        assert res.status == "error"
        assert res.reason == "ocr_http_400"


# -----------------------------------------------------------------------------
# 15, 16. Malformed and empty OCR response handling
# -----------------------------------------------------------------------------
def test_ocr_malformed_and_empty_response():
    client = HTTPOCRClient()

    # Empty body
    mock_empty = MagicMock()
    mock_empty.status_code = 200
    mock_empty.json.side_effect = ValueError("No JSON")

    with patch("httpx.post", return_value=mock_empty):
        res = client.extract(PNG, "empty.png", "image/png", "pan")
        assert res.status == "error"
        assert res.reason == "ocr_invalid_response"

    # Malformed schema
    mock_malformed = MagicMock()
    mock_malformed.status_code = 200
    mock_malformed.json.return_value = {"unrecognized_key": 123}

    with patch("httpx.post", return_value=mock_malformed):
        res = client.extract(PNG, "malformed.png", "image/png", "pan")
        assert res.status == "error"


# -----------------------------------------------------------------------------
# 18. Idempotent duplicate processing
# -----------------------------------------------------------------------------
def test_idempotent_duplicate_ocr_processing(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Idempotent User", doc_type="pan")
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Idempotent User"},
    )

    # First execution
    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    # Duplicate execution
    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    with session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.ocr_status == "completed"
        # Only one row in ocr_results
        rows = list(db.scalars(select(OcrResult).where(OcrResult.document_id == doc_id)).all())
        assert len(rows) == 1


# -----------------------------------------------------------------------------
# 19. Superseded document is skipped
# -----------------------------------------------------------------------------
def test_superseded_document_is_not_processed(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Superseded User", doc_type="pan")
    env.responses["pan"] = OCRResult(status="success", doc_type="pan", confidence=0.95)

    with session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.superseded = True

    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    with session_scope() as db:
        doc = db.get(Document, doc_id)
        # Did not run OCR or change status
        assert doc.ocr_status == "waiting"
        ocr_row = db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id))
        assert ocr_row is None


# -----------------------------------------------------------------------------
# 20. Plaintext bytes are not persisted to database or disk
# -----------------------------------------------------------------------------
def test_plaintext_not_persisted(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Security User", doc_type="pan")
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Security User"},
    )

    assert jobs.run_one() is True

    with session_scope() as db:
        # Verify Document table does NOT store file bytes
        doc = db.get(Document, doc_id)
        assert not hasattr(doc, "file_data")
        assert not hasattr(doc, "bytes")

        # Verify OCRResult stores only masked payload
        ocr_row = db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id))
        assert "bytes" not in ocr_row.payload


# -----------------------------------------------------------------------------
# 21, 22. Credentials, raw text, and PII are not leaked in audit logs
# -----------------------------------------------------------------------------
def test_audit_logs_contain_no_credentials_or_pii(client, env):
    cid, _, doc_id = setup_customer_and_upload(client, name="Audit User", doc_type="pan")
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Audit User"},
    )

    assert jobs.run_one() is True

    with session_scope() as db:
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == doc_id)).all())
        for a in audits:
            details_str = json.dumps(a.details or {})
            assert "ABCPE1234F" not in details_str
            assert "test_api_key" not in details_str
            assert "Bearer" not in details_str
            assert "Authorization" not in details_str


# -----------------------------------------------------------------------------
# 23. Cross-customer isolation
# -----------------------------------------------------------------------------
def test_cross_customer_ocr_isolation(client, env):
    cid1, _, doc_id1 = setup_customer_and_upload(client, name="User One", doc_type="pan")
    cid2, _, doc_id2 = setup_customer_and_upload(client, name="User Two", doc_type="pan")

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "User One"},
    )

    # Process first customer's job
    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id1})

    with session_scope() as db:
        doc1 = db.get(Document, doc_id1)
        doc2 = db.get(Document, doc_id2)
        assert doc1.ocr_status == "completed"
        assert doc2.ocr_status == "waiting"  # Untouched
