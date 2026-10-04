"""Dedicated integration test suite for DocPilot -> Company OCR Service pipeline.

Tests:
1. Success flow (upload -> OCR -> mask -> verified -> pending shrinks).
2. Document type mismatch (slot mismatch -> rejected -> resubmit).
3. Failure handling (unreadable file -> failed OCR -> not verified).
4. Timeout & retry behavior (transient error -> exponential backoff retry).
5. Exhausted retries (outage -> job marked failed -> routed to human review without data loss).
6. Idempotency (re-running job produces identical state without unique constraint violations).
7. Invariant: Failed OCR can NEVER become verified.
"""
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app import jobs, ocr_client, pipeline, services
from app.db import session_scope, utcnow
from app.models import Customer, Document, Job, ManualReview, OcrResult, RequiredDocument
from app.ocr_client import OCRResult, OCRUnavailable, set_ocr_client
from app.rules import Decision, evaluate

PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"


def _create_test_customer(db, name="VIKRAM SHARMA", req_docs=None):
    if req_docs is None:
        req_docs = ["pan", "bank_statement"]
    c = services.create_customer(
        db,
        name=name,
        email=f"test_{name.lower().replace(' ', '_')}@example.com",
        mobile="+919876543210",
        required=req_docs,
        actor="test",
    )
    services.record_consent(db, c, granted=True)
    return c


# --------------------------------------------------------------------------
# Test 1: Full Success Flow
# --------------------------------------------------------------------------
def test_ocr_pipeline_success_flow(client, env):
    """Uploaded valid PAN verifies automatically and shrinks the pending document list."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["pan", "bank_statement"])
        cid = c.id
        doc = services.accept_upload(db, c, "pan", "pan_card.png", PNG_BYTES)
        doc_id = doc.id

    # Programmable OCR returns high-confidence valid PAN
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.98, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
        reason=None,
    )

    # Worker executes process_document
    assert jobs.run_one() is True

    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "completed"
        assert d.verification_status == "verified"
        assert d.confidence == 0.96
        assert d.flags == []
        assert d.reason == "rules_passed"

        # Verify PII masking in database
        ocr_row = db.scalar(select(OcrResult).where(OcrResult.document_id == doc_id))
        assert ocr_row is not None
        assert ocr_row.payload["status"] == "success"
        # PAN number is partially masked in stored ocr_results
        assert "XXXX" in ocr_row.payload["extracted_fields"]["pan_number"]

        # Verify pending list shrunk
        pending = services.pending_keys(db, cid)
        assert pending == ["bank_statement"]


# --------------------------------------------------------------------------
# Test 2: Document Type Mismatch Rejection
# --------------------------------------------------------------------------
def test_ocr_pipeline_wrong_document_type(client, env):
    """Uploading a PAN into the Aadhaar slot is rejected and flagged for resubmission."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["aadhaar"])
        cid = c.id
        doc = services.accept_upload(db, c, "aadhaar", "my_id.png", PNG_BYTES)
        doc_id = doc.id

    # OCR detects mismatch (uploaded PAN into Aadhaar slot)
    env.responses["aadhaar"] = OCRResult(
        status="error",
        reason="doc_type_mismatch",
        doc_type="aadhaar",
        detected_type="pan",
        confidence=0.0,
        field_confidences={},
        extracted_fields={},
        message="Uploaded document appears to be 'pan' rather than 'aadhaar'",
    )

    assert jobs.run_one() is True

    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "completed"
        assert d.verification_status == "rejected"
        assert "wrong_document_type" in d.flags
        assert d.reason == "wrong_document_type"

        # Slot is still pending resubmission
        pending = services.pending_keys(db, cid)
        assert "aadhaar" in pending


# --------------------------------------------------------------------------
# Test 3: Unreadable Document Failure
# --------------------------------------------------------------------------
def test_ocr_pipeline_unreadable_file_failure(client, env):
    """Blank or corrupted image fails OCR and routes to human review (never verified)."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["pan"])
        cid = c.id
        doc = services.accept_upload(db, c, "pan", "blank.png", PNG_BYTES)
        doc_id = doc.id

    env.responses["pan"] = OCRResult(
        status="error",
        reason="ocr_engine_returned_no_text",
        doc_type="pan",
        confidence=0.0,
        field_confidences={},
        extracted_fields={},
        message="No text detected on page",
    )

    assert jobs.run_one() is True

    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.verification_status == "manual_review"
        assert "ocr_error" in d.flags

        # Invariant: Failed OCR is NEVER verified
        assert d.verification_status != "verified"


# --------------------------------------------------------------------------
# Test 4: Transient Timeout and Exponential Backoff Retry
# --------------------------------------------------------------------------
def test_ocr_pipeline_transient_timeout_and_retry(client, env):
    """Network timeouts raise OCRUnavailable and re-queue with exponential backoff delay."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["pan"])
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG_BYTES)
        doc_id = doc.id

    # Configure FakeOCR to fail once with transient OCRUnavailable
    env.fail_times = 1
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.98, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    # First execution attempt triggers retry
    assert jobs.run_one() is True

    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job is not None
        assert job.attempts == 1
        assert job.status == "queued"
        # Run-at time has exponential backoff delay (30s * 2^1 = 60s)
        assert job.run_at > utcnow()

        # Document is still waiting
        d = db.get(Document, doc_id)
        assert d.verification_status == "not_started"

        # Fast forward time to make job due again
        job.run_at = utcnow() - timedelta(seconds=1)

    # Second execution attempt succeeds
    assert jobs.run_one() is True

    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job.status == "done"
        d = db.get(Document, doc_id)
        assert d.ocr_status == "completed"
        assert d.verification_status == "verified"


# --------------------------------------------------------------------------
# Test 5: Exhausted Retries Preserves Document
# --------------------------------------------------------------------------
def test_ocr_pipeline_exhausted_retries_graceful_handling(client, env):
    """When all retries are exhausted, the document is flagged for manual review without data loss."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["pan"])
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG_BYTES)
        doc_id = doc.id

    # OCR service remains continuously down
    env.fail_times = 99

    # Run through all 3 attempts
    for attempt in range(1, 4):
        with session_scope() as db:
            job = db.scalar(select(Job).where(Job.kind == "process_document"))
            job.run_at = utcnow() - timedelta(seconds=1)
        assert jobs.run_one() is True

    with session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job.status == "failed"
        assert job.attempts == 3

        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.verification_status == "manual_review"
        assert "ocr_unavailable" in d.flags

        # File is still stored and not lost
        assert d.file_state == "stored"

        # Manual review ticket was opened
        review = db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id))
        assert review is not None
        assert review.status == "open"
        assert review.reason == "ocr_service_unavailable"


# --------------------------------------------------------------------------
# Test 6: Strict Idempotent Processing
# --------------------------------------------------------------------------
def test_ocr_pipeline_idempotent_execution(client, env):
    """Running handle_process_document multiple times does not duplicate records or violate DB constraints."""
    with session_scope() as db:
        c = _create_test_customer(db, "VIKRAM SHARMA", ["pan"])
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG_BYTES)
        doc_id = doc.id

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.98, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    # Run 1: initial process
    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    # Run 2: idempotent re-process
    with session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    with session_scope() as db:
        d = db.get(Document, doc_id)
        assert d.ocr_status == "completed"
        assert d.verification_status == "verified"

        # Exactly 1 row in ocr_results
        rows = list(db.scalars(select(OcrResult).where(OcrResult.document_id == doc_id)).all())
        assert len(rows) == 1


# --------------------------------------------------------------------------
# Test 7: Failed OCR Invariant: Never Verified
# --------------------------------------------------------------------------
def test_ocr_pipeline_failed_ocr_cannot_become_verified_invariant():
    """Verify that any error status, missing field, or low confidence never outcomes to 'verified'."""
    # Subtest A: Error status with high confidence
    r1 = OCRResult(status="error", doc_type="pan", confidence=0.99, extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"})
    d1 = evaluate(r1, "pan", "VIKRAM SHARMA", min_overall=0.90, min_field=0.80)
    assert d1.outcome != "verified"

    # Subtest B: Reason code doc_type_mismatch
    r2 = OCRResult(status="error", reason="doc_type_mismatch", doc_type="pan", detected_type="aadhaar", confidence=0.95)
    d2 = evaluate(r2, "pan", "VIKRAM SHARMA", min_overall=0.90, min_field=0.80)
    assert d2.outcome == "rejected"
    assert d2.outcome != "verified"

    # Subtest C: Low confidence
    r3 = OCRResult(status="success", doc_type="pan", confidence=0.60, field_confidences={"pan_number": 0.60, "name": 0.60}, extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"})
    d3 = evaluate(r3, "pan", "VIKRAM SHARMA", min_overall=0.90, min_field=0.80)
    assert d3.outcome != "verified"
    assert d3.outcome in ("needs_ai", "manual_review")

    # Subtest D: Missing required field
    r4 = OCRResult(status="success", doc_type="pan", confidence=0.95, field_confidences={"name": 0.95}, extracted_fields={"name": "VIKRAM SHARMA"})
    d4 = evaluate(r4, "pan", "VIKRAM SHARMA", min_overall=0.90, min_field=0.80)
    assert d4.outcome != "verified"
    assert "missing_fields:pan_number" in d4.flags
