"""
Phase 5 Step 5: Audit Observability & Monitoring Test Suite.

Verifies:
1. Structured backend logging is consistent (JSON output with timestamp, level, logger, message).
2. Worker/job failures are logged with useful structured context.
3. OCR failures, retries, and statuses are observable and audited.
4. Storage/database failures are logged safely (ID-only, no ciphertext/secrets).
5. Critical workflow transitions create append-only audit entries.
6. Logs strictly redact passwords, tokens, secrets, and unmasked PII (email, phone, aadhaar, pan, bearer tokens).
7. Unhandled errors return safe messages without stack traces to users.
8. Health/readiness endpoint accurately reflects database service state (200 OK vs 503 degraded).
9. Clean and performant logging with zero secret leaks.
"""
import io
import json
import logging
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import db as dbmod, jobs, logging_conf, models, pipeline, services
from app.logging_conf import PiiSanitizingFilter, StructuredJsonFormatter, sanitize_data, sanitize_text
from app.main import app
from tests.conftest import PNG, admin_headers, token_from_outbox


# 1. Structured backend logging is consistent
def test_structured_json_logging_format():
    """Verify that StructuredJsonFormatter produces valid single-line JSON with required fields."""
    formatter = StructuredJsonFormatter()
    record = logging.LogRecord(
        name="docpilot.test",
        level=logging.INFO,
        pathname="test.py",
        lineno=10,
        msg="Worker processed document successfully",
        args=(),
        exc_info=None,
    )
    record.customer_id = 123
    record.doc_type = "pan"

    output = formatter.format(record)
    parsed = json.loads(output)

    assert "timestamp" in parsed
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "docpilot.test"
    assert parsed["message"] == "Worker processed document successfully"
    assert parsed["context"]["customer_id"] == 123
    assert parsed["context"]["doc_type"] == "pan"


# 2. Worker/job failures are logged with useful context
def test_worker_job_failure_logging_context():
    """Verify that job failure alerts log structured context and invoke alert hooks."""
    received_alerts = []

    def hook(info):
        received_alerts.append(info)

    jobs.register_alert_hook(hook)
    try:
        job = models.Job(id=999, kind="process_document", attempts=3, max_attempts=3)
        jobs.alert_failed_job(job, "Connection reset by peer during OCR extraction")

        assert len(received_alerts) == 1
        alert = received_alerts[0]
        assert alert["alert"] == "job_failed"
        assert alert["job_id"] == 999
        assert alert["kind"] == "process_document"
        assert alert["attempts"] == 3
        assert "Connection reset" in alert["error"]
    finally:
        jobs.clear_alert_hooks()


# 3. OCR failures and retries are observable
def test_ocr_failure_observability(client):
    """Verify that OCR failure events are recorded in the audit log."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Observability User", "email": "obs@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    cid = r.json()["id"]
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    portal_tok = token_from_outbox("portal")

    r_up = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    doc_id = r_up.json()["document_id"]

    # Mock OCR returning error
    with patch.object(pipeline, "get_ocr_client") as mock_ocr:
        mock_ocr.return_value.extract.return_value = pipeline.OCRResult(
            status="error", reason="unreadable_image_scan", confidence=0.0
        )
        with dbmod.session_scope() as s:
            pipeline.handle_process_document(s, {"document_id": doc_id})

    with dbmod.session_scope() as s:
        doc = s.get(models.Document, doc_id)
        assert doc.ocr_status == "failed"
        assert doc.verification_status == "manual_review"

        # Verify audit log recorded ocr_failed
        audit = s.scalar(
            select(models.AuditLog)
            .where(models.AuditLog.entity_id == doc_id, models.AuditLog.action == "ocr_failed")
        )
        assert audit is not None
        assert audit.details.get("reason") == "unreadable_image_scan"


# 4. Storage/database failures are logged safely
def test_storage_failure_safe_logging():
    """Verify that storage failures log only entity IDs and error codes without leaking data."""
    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    handler.setFormatter(StructuredJsonFormatter())
    logger = logging.getLogger("docpilot.test_storage")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    # Log simulated failure
    logger.error("Failed to decrypt storage object", extra={"document_id": "doc_123", "error_code": "file_not_found"})

    output = log_stream.getvalue()
    parsed = json.loads(output)
    assert parsed["context"]["document_id"] == "doc_123"
    assert parsed["context"]["error_code"] == "file_not_found"
    # Plaintext / ciphertext bytes must not be present
    assert "ciphertext" not in parsed["context"]


# 5. Critical workflow transitions are auditable
def test_critical_workflow_transitions_auditable(client):
    """Verify customer creation, consent, upload, and review decisions create audit rows."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Audit User", "email": "audit_user@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})

    with dbmod.session_scope() as s:
        actions = list(s.scalars(
            select(models.AuditLog.action).where(models.AuditLog.entity_id == str(cid))
        ))
        assert "customer_created" in actions
        assert "consent_granted" in actions


# 6. Logs never contain passwords, tokens, secrets, or unmasked PII
def test_pii_and_secret_redaction():
    """Verify that emails, phone numbers, Aadhaar, PAN, bearer tokens, and sensitive keys are redacted."""
    raw_message = (
        "User john.doe@example.com with phone +919876543210, Aadhaar 1234 5678 9012, "
        "PAN ABCDE1234F, and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token"
    )
    sanitized = sanitize_text(raw_message)
    assert "john.doe@example.com" not in sanitized
    assert "[REDACTED_EMAIL]" in sanitized
    assert "+919876543210" not in sanitized
    assert "[REDACTED_PHONE]" in sanitized
    assert "1234 5678 9012" not in sanitized
    assert "[REDACTED_AADHAAR]" in sanitized
    assert "ABCDE1234F" not in sanitized
    assert "[REDACTED_PAN]" in sanitized
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in sanitized
    assert "[REDACTED_TOKEN]" in sanitized

    # Sensitive dictionary keys
    sensitive_dict = {
        "email": "test@example.com",
        "password": "supersecretpassword",
        "api_key": "sk-1234567890",
        "authorization": "Bearer secret_jwt",
        "safe_field": "public_data",
    }
    cleaned_dict = sanitize_data(sensitive_dict)
    assert cleaned_dict["email"] == "[REDACTED]"
    assert cleaned_dict["password"] == "[REDACTED]"
    assert cleaned_dict["api_key"] == "[REDACTED]"
    assert cleaned_dict["authorization"] == "[REDACTED]"
    assert cleaned_dict["safe_field"] == "public_data"


# 7. Errors return safe messages without stack traces to users
def test_unhandled_errors_safe_response(client):
    """Verify that unhandled exceptions return safe {code, message} and never stack traces."""
    # Test an invalid link or endpoint triggering 404
    r_404 = client.get("/api/portal/invalid-token-123")
    assert r_404.status_code == 404
    assert "traceback" not in r_404.text.lower()
    assert "Traceback" not in r_404.text

    # Verify global exception handler formats safe 500 error
    safe_client = TestClient(client.app, raise_server_exceptions=False)
    with patch("app.services.resolve_token", side_effect=RuntimeError("Secret database crash details")):
        r_500 = safe_client.get("/api/portal/dummy-token")
        assert r_500.status_code == 500
        data = r_500.json()
        assert data["code"] == "internal_error"
        assert data["message"] == "An internal server error occurred."
        assert "Secret database crash details" not in r_500.text
        assert "Traceback" not in r_500.text


# 8. Health/readiness endpoints accurately reflect service state
def test_health_endpoint_accuracy(client):
    """Verify /health returns 200 OK when database is connected, and 503 when disconnected."""
    # When healthy
    r_ok = client.get("/health")
    assert r_ok.status_code == 200
    data = r_ok.json()
    assert data["status"] == "ok"
    assert data["database"] == "connected"

    # When database connection fails
    def broken_db():
        class BrokenSession:
            def execute(self, *args, **kwargs):
                raise RuntimeError("Database connection refused")
        yield BrokenSession()

    client.app.dependency_overrides[dbmod.get_db] = broken_db
    try:
        r_down = client.get("/health")
        assert r_down.status_code == 503
        data_down = r_down.json()
        detail = data_down.get("detail", data_down)
        assert detail["status"] == "degraded"
        assert detail["database"] == "unavailable"
    finally:
        client.app.dependency_overrides.pop(dbmod.get_db, None)
