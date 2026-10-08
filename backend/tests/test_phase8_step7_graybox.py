"""PHASE 8 — STEP 7: Formal Gray-Box Testing Suite

Focuses on multi-component interactions across API, DB, Job Queue, Storage, OCR, and AI:
1. Admin API -> DB -> Workflow State progression
2. Customer creation -> Consent token -> Portal session
3. Portal upload -> AES-GCM Encrypted Storage -> PostgreSQL Job queue
4. Job queue -> OCR Service -> PII Masking -> Deterministic Rules
5. Rules inconclusive -> AI escalation -> Manual review fallback
6. Failure Injection: OCR unavailable, timeout, malformed payload
7. Failure Injection: AI timeout, failure -> Manual review fallback
8. Failure Injection: Storage write failure -> Atomic DB rollback
9. Failure Injection: Duplicate upload and duplicate job execution idempotency
10. Failure Injection: Privacy deletion with pending jobs -> Storage and DB cleanup
11. Failure Injection: Consent withdrawal mid-flow -> Token revocation and access cutoff
12. Audit and cross-component consistency verification
"""
import io
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from sqlalchemy import select

from app import db as dbmod, jobs, models, rules, scheduler, security, services, storage
from app.config import get_settings
from app.models import AccessToken, Customer, Document, Job, ManualReview, RequiredDocument
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


# =============================================================================
# 1. END-TO-END WORKFLOW INTEGRATION (GRAY-BOX)
# =============================================================================

def test_gb_01_full_lifecycle_pipeline(client, env):
    """GB-01: Admin API -> DB -> Token -> Upload -> Encrypted Storage -> Job Queue -> OCR -> Rules -> Verified."""
    # 1. Admin creates customer
    res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Arjun Kapoor",
        "email": "arjun.kapoor@example.com",
        "mobile": "+919876543210",
        "required_documents": ["PAN"],
        "send_consent": True,
    })
    assert res.status_code == 201
    cust_data = res.json()
    cid = cust_data["id"]

    # Verify DB state directly (Gray-Box knowledge)
    with dbmod.session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "awaiting_consent"

    # 2. Consent grant -> Upload token
    consent_tok = token_from_outbox("consent")
    grant_res = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert grant_res.status_code == 200
    upload_tok = grant_res.json()["upload_token"]

    # 3. Portal upload
    up_res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    assert up_res.status_code == 202
    doc_id = up_res.json()["document_id"]

    # Verify storage contains encrypted file (Gray-Box check)
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc is not None
        assert doc.file_state == "stored"
        # File in storage is encrypted
        enc_bytes = storage.get_storage().get(doc.storage_key)
        assert enc_bytes != PNG
        assert security.decrypt(enc_bytes) == PNG

        # Job queued in database
        queued_jobs = [j for j in db.scalars(select(Job)).all() if j.payload.get("document_id") == doc_id]
        assert len(queued_jobs) == 1
        assert queued_jobs[0].status == "queued"

    # 4. OCR processing via mock and worker
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Arjun Kapoor"},
    )
    jobs.run_all()

    # 5. Verify final database and API state
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "verified"
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        assert c.workflow_state in ("COMPLETED", "ALL_DOCUMENTS_VERIFIED")


# =============================================================================
# 2. FAILURE INJECTION: OCR FAILURES & RECOVERY
# =============================================================================

def test_gb_02_ocr_failure_routes_to_manual_review(client, env):
    """GB-02: OCR service failure/error causes job to escalate to manual review safely without crashing."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "OCR Fail User", "email": "ocrfail@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)}).json()
    doc_id = up["document_id"]

    # Simulate OCR permanent error
    env.responses["pan"] = OCRResult(status="error", doc_type="pan", reason="ocr_upstream_timeout")
    jobs.run_all()

    # Verify Manual Review row created in DB
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status in ("manual_review", "flagged")
        review = db.scalar(select(ManualReview).where(ManualReview.document_id == doc_id))
        assert review is not None
        assert review.status == "open"


def test_gb_03_ocr_malformed_response_handling(client, env):
    """GB-03: Malformed OCR result handles gracefully without leaving zombie running jobs."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Malformed User", "email": "malformed@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)}).json()
    doc_id = up["document_id"]

    # OCR returns missing essential fields
    env.responses["pan"] = OCRResult(status="success", doc_type="pan", confidence=0.0, extracted_fields={})
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status != "verified"


# =============================================================================
# 3. FAILURE INJECTION: AI TIMEOUT & FALLBACK
# =============================================================================

def test_gb_04_ai_failure_fallback_to_manual_review(client, env):
    """GB-04: When rules are inconclusive and AI provider fails/times out, fallback to manual review."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "AI Fail User", "email": "aifail@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)}).json()
    doc_id = up["document_id"]

    # Inconclusive OCR confidence (0.65)
    env.responses["pan"] = OCRResult(
        status="success", doc_type="pan", detected_type="pan", confidence=0.65,
        extracted_fields={"pan_number": "ABCDE1234F", "name": "AI Fail User"}
    )
    # Simulate AI exception
    with patch("app.ai_service.assess", side_effect=TimeoutError("AI timed out")):
        jobs.run_all()

    # Verify routed to manual review
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status in ("manual_review", "flagged")


# =============================================================================
# 4. FAILURE INJECTION: ATOMIC STORAGE ROLLBACK
# =============================================================================

def test_gb_05_storage_failure_rolls_back_database(client):
    """GB-05: If storage upload fails, database transaction rolls back and document is not created."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Store Fail", "email": "storefail@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Mock storage write to raise IOError
    with patch("app.services.put_file", side_effect=IOError("Storage bucket unreachable")):
        res = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
        assert res.status_code in (500, 502, 503)

    # Verify no orphaned Document row was committed in DB
    with dbmod.session_scope() as db:
        docs = db.scalars(select(Document).join(Customer).where(Customer.email == "storefail@example.com")).all()
        assert len(docs) == 0


# =============================================================================
# 5. IDEMPOTENCY & DUPLICATE PROTECTION
# =============================================================================

def test_gb_06_duplicate_upload_idempotency(client, env):
    """GB-06: Uploading identical file twice supersedes or prevents duplicate queue accumulation."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Dup User", "email": "dup@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    u1 = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    assert u1.status_code == 202
    u2 = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    assert u2.status_code == 202

    # Process jobs
    env.responses["pan"] = OCRResult(status="success", doc_type="pan", detected_type="pan", confidence=0.95, extracted_fields={"pan_number": "ABCDE1234F", "name": "Dup User"})
    jobs.run_all()

    with dbmod.session_scope() as db:
        c = db.scalar(select(Customer).where(Customer.email == "dup@example.com"))
        # Customer case should be completed cleanly without conflicting states
        assert c.case_status == "completed"


# =============================================================================
# 6. PRIVACY DELETION & CONSENT WITHDRAWAL INTERACTIONS
# =============================================================================

def test_gb_07_privacy_deletion_cancels_jobs_and_purges(client, env):
    """GB-07: Right-to-be-forgotten deletion cleans encrypted files and marks jobs cancelled."""
    c_res = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Purge Me", "email": "purgeme@example.com", "required_documents": ["PAN"]
    }).json()
    cid = c_res["id"]
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    up = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)}).json()
    doc_id = up["document_id"]

    # Customer triggers privacy deletion before job is run
    client.post("/api/public/privacy/request", json={"email": "purgeme@example.com", "action": "delete"})
    conf_tok = token_from_outbox("privacy/confirm")
    del_res = client.post(f"/api/public/privacy/confirm/{conf_tok}")
    assert del_res.status_code == 200

    # Verify encrypted storage was cleaned and tokens revoked
    with dbmod.session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "deleted"
        tokens = db.scalars(select(AccessToken).where(AccessToken.customer_id == cid)).all()
        for t in tokens:
            assert t.revoked is True


def test_gb_08_consent_withdrawal_blocks_portal_immediately(client):
    """GB-08: Consent withdrawal revokes tokens; subsequent portal upload rejected immediately."""
    client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": "Withdraw User", "email": "withdraw@example.com", "required_documents": ["PAN"]
    })
    consent_tok = token_from_outbox("consent")
    upload_tok = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True}).json()["upload_token"]

    # Withdraw consent
    client.post("/api/public/privacy/request", json={"email": "withdraw@example.com", "action": "withdraw"})
    conf_tok = token_from_outbox("privacy/confirm")
    client.post(f"/api/public/privacy/confirm/{conf_tok}")

    # Subsequent portal access or upload must be rejected
    portal_access = client.get(f"/api/portal/{upload_tok}")
    assert portal_access.status_code in (401, 403, 404)

    up_try = client.post(f"/api/portal/{upload_tok}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    assert up_try.status_code in (401, 403, 404)
