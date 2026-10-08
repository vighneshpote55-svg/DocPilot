"""PHASE 7 — STEP 5: Full OCR -> Rules -> AI -> Manual Review End-to-End Regression Suite

Validates complete workflow regression:
1. Valid document -> OCR -> Rules -> Verified
2. Invalid document -> Manual Review
3. Wrong document type -> Rejected/Resubmit
4. Low OCR confidence -> Manual Review
5. OCR failure -> Retry -> Manual Review
6. Rules INCONCLUSIVE -> AI
7. AI >=90% with zero risk -> Verified
8. AI failure/timeout/invalid response -> Manual Review
9. Deterministic RISK cannot be overridden by AI
10. Multiple documents and pending recalculation
11. Completion and retention
12. Customer-facing privacy protection
13. Admin review and resubmission
"""
from datetime import timedelta
import pytest
from sqlalchemy import select

from app import ai_service, db as dbmod, emailer, jobs, models, pipeline, rules, services
from app.ai_service import AIResponse, MockAIProvider, reset_ai_provider, set_ai_provider
from app.config import get_settings
from app.models import Customer, Document, Job, ManualReview, OcrResult
from app.ocr_client import OCRResult, set_ocr_client
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


@pytest.fixture(autouse=True)
def clean_pipeline_state():
    reset_ai_provider()
    yield
    reset_ai_provider()


def onboard_customer(client, name="Sunita Rao", email="sunita@example.com", docs=("PAN",)):
    """Helper to onboard a customer and return customer dict and portal token."""
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "required_documents": list(docs)},
    )
    assert r.status_code == 201, r.text
    c = r.json()
    consent = token_from_outbox("consent")
    res = client.post(f"/api/public/consent/{consent}", json={"granted": True})
    assert res.status_code == 200
    portal_token = res.json()["upload_token"]
    return c, portal_token


def upload_portal_doc(client, portal_token, doc_type, content=PNG, filename="doc.png"):
    """Helper to upload a document via portal endpoint."""
    return client.post(
        f"/api/portal/{portal_token}/upload",
        data={"doc_type": doc_type},
        files={"file": (filename, content)},
    )


# -----------------------------------------------------------------------------
# 1. Valid document -> OCR -> Rules -> Verified
# -----------------------------------------------------------------------------
def test_1_valid_document_rules_verified(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.98, "name": 0.95},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao", "dob": "12/04/1985"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    assert jobs.run_all() == 1

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "verified"
        assert doc.ocr_status == "completed"

    portal_state = client.get(f"/api/portal/{portal}").json()
    assert portal_state["documents"][0]["state"] == "verified"
    assert portal_state["pending_count"] == 0


# -----------------------------------------------------------------------------
# 2. Invalid document -> Manual Review
# -----------------------------------------------------------------------------
def test_2_invalid_document_manual_review(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.92,
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Completely Different Person"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "manual_review"
        assert "name_mismatch" in doc.reason

        review = db.scalar(select(ManualReview).where(ManualReview.document_id == doc.id))
        assert review is not None
        assert review.status == "open"


# -----------------------------------------------------------------------------
# 3. Wrong document type -> Rejected/Resubmit
# -----------------------------------------------------------------------------
def test_3_wrong_document_type_rejected_resubmit(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="error",
        doc_type="pan",
        detected_type="passport",
        confidence=0.95,
        reason="wrong_document_type",
        extracted_fields={"passport_number": "P1234567"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "rejected"

    portal_state = client.get(f"/api/portal/{portal}").json()
    assert portal_state["documents"][0]["state"] == "resubmit"
    assert portal_state["pending_count"] == 1


# -----------------------------------------------------------------------------
# 4. Low OCR confidence -> Manual Review
# -----------------------------------------------------------------------------
def test_4_low_ocr_confidence_manual_review(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.45,
        reason="low_confidence",
        field_confidences={"pan_number": 0.40, "name": 0.50},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "manual_review"
        assert "low_confidence" in doc.reason


# -----------------------------------------------------------------------------
# 5. OCR failure -> Retry -> Manual Review
# -----------------------------------------------------------------------------
def test_5_ocr_failure_retry_to_manual_review(client):
    class FailingOCR:
        def __init__(self):
            self.attempts = 0
        def extract(self, *args, **kwargs):
            self.attempts += 1
            raise ConnectionError("OCR upstream server unreachable")

    failing_ocr = FailingOCR()
    set_ocr_client(failing_ocr)

    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202

    # Simulate retries exhausting max_attempts
    with dbmod.session_scope() as db:
        job = db.scalar(select(Job).where(Job.kind == "process_document"))
        assert job is not None
        job.attempts = job.max_attempts - 1

    jobs.run_one()  # This attempt reaches max_attempts and triggers exhaustion handler

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.ocr_status == "failed"
        assert doc.verification_status == "manual_review"
        assert "ocr_service_unavailable" in doc.reason


# -----------------------------------------------------------------------------
# 6. Rules INCONCLUSIVE -> AI
# -----------------------------------------------------------------------------
def test_6_rules_inconclusive_triggers_ai(client, env):
    called = []
    class RecordingAI:
        def assess(self, req):
            called.append(req)
            return AIResponse(verdict="verified", confidence=92.0, reason="Typography clear")

    set_ai_provider(RecordingAI())

    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    # Borderline confidence (0.76) triggers inconclusive -> AI
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.76,
        field_confidences={"pan_number": 0.78, "name": 0.76},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    assert len(called) == 1
    req = called[0]
    assert req.doc_type == "pan"
    # PII safely masked before AI sees it
    assert req.ocr["extracted_fields"]["pan_number"].startswith("XXXX")


# -----------------------------------------------------------------------------
# 7. AI >=90% with zero risk -> Verified
# -----------------------------------------------------------------------------
def test_7_ai_high_confidence_zero_risk_verified(client, env):
    mock = MockAIProvider()
    mock.next_response = {"verdict": "verified", "confidence": 95.0, "reason": "Typography consistent"}
    set_ai_provider(mock)

    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.75,
        field_confidences={"pan_number": 0.76, "name": 0.75},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "verified"


# -----------------------------------------------------------------------------
# 8. AI failure/timeout/invalid response -> Manual Review
# -----------------------------------------------------------------------------
def test_8_ai_failure_manual_review(client, env):
    class ErrorAI:
        def assess(self, req):
            raise TimeoutError("AI provider timeout after 30s")

    set_ai_provider(ErrorAI())
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.75,
        field_confidences={"pan_number": 0.76, "name": 0.75},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "manual_review"


# -----------------------------------------------------------------------------
# 9. Deterministic RISK cannot be overridden by AI
# -----------------------------------------------------------------------------
def test_9_deterministic_risk_cannot_be_overridden_by_ai(client, env):
    ai_called = []
    class OverridingAI:
        def assess(self, req):
            ai_called.append(req)
            return AIResponse(verdict="verified", confidence=99.0)

    set_ai_provider(OverridingAI())
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    # Synthetic tampering flag triggers deterministic hard RISK
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.95,
        risk_flags=["tampering_suspected"],
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    assert resp.status_code == 202
    jobs.run_all()

    with dbmod.session_scope() as db:
        doc = db.get(Document, resp.json()["document_id"])
        assert doc.verification_status == "manual_review"
        assert "tamper" in doc.reason or any("tamper" in f for f in (doc.reason or ""))

    # AI must never be called or allowed to override risk
    assert len(ai_called) == 0


# -----------------------------------------------------------------------------
# 10. Multiple documents and pending recalculation
# -----------------------------------------------------------------------------
def test_10_multiple_documents_pending_recalculation(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN", "Bank Statement"))
    assert c["pending_count"] == 2

    # Upload PAN
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96, "name": 0.95},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    r1 = upload_portal_doc(client, portal, "PAN")
    assert r1.status_code == 202
    jobs.run_all()

    state1 = client.get(f"/api/portal/{portal}").json()
    assert state1["pending_count"] == 1

    # Upload Bank Statement
    env.responses["bank_statement"] = OCRResult(
        status="success",
        doc_type="bank_statement",
        detected_type="bank_statement",
        confidence=0.95,
        field_confidences={"account_number": 0.95, "bank_name": 0.95},
        extracted_fields={"account_number": "1234567890", "bank_name": "State Bank of India", "name": "Sunita Rao"},
    )
    r2 = upload_portal_doc(client, portal, "bank_statement", content=PDF, filename="bank.pdf")
    assert r2.status_code == 202
    jobs.run_all()

    state2 = client.get(f"/api/portal/{portal}").json()
    assert state2["pending_count"] == 0
    assert state2["case_status"] == "completed"


# -----------------------------------------------------------------------------
# 11. Completion and retention
# -----------------------------------------------------------------------------
def test_11_completion_and_retention(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.96, "name": 0.95},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    upload_portal_doc(client, portal, "PAN")
    jobs.run_all()

    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["case_status"] == "completed"
    assert detail["workflow_state"] == "COMPLETED"
    assert detail["delete_after"] is not None
    # Completion email dispatched
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)


# -----------------------------------------------------------------------------
# 12. Customer-facing privacy protection
# -----------------------------------------------------------------------------
def test_12_customer_facing_privacy_protection(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    # Put document in manual review with risk flag
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.95,
        risk_flags=["tampering_suspected"],
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    resp = upload_portal_doc(client, portal, "PAN")
    doc_id = resp.json()["document_id"]
    jobs.run_all()

    # Customer portal state should only show user-friendly "under_review", never "fraud" or "tampering"
    p_state = client.get(f"/api/portal/{portal}").json()
    doc_state = p_state["documents"][0]
    assert doc_state["state"] == "under_review"
    assert "tamper" not in str(doc_state).lower()
    assert "fraud" not in str(doc_state).lower()

    # Document status endpoint
    d_status = client.get(f"/api/portal/{portal}/documents/{doc_id}/status").json()
    assert d_status["state"] == "under_review"
    assert "tamper" not in str(d_status).lower()


# -----------------------------------------------------------------------------
# 13. Admin review and resubmission
# -----------------------------------------------------------------------------
def test_13_admin_review_and_resubmission(client, env):
    c, portal = onboard_customer(client, name="Sunita Rao", docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.40,
        reason="document_blurred",
    )
    upload_portal_doc(client, portal, "PAN")
    jobs.run_all()

    # Admin fetches reviews
    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1
    rid = reviews[0]["id"]

    # Admin rejects document, requesting resubmission
    rej = client.post(
        f"/api/admin/reviews/{rid}/reject",
        headers=admin_headers(),
        json={"note": "Document image is too blurry. Please re-upload a clear photo."},
    )
    assert rej.status_code == 200

    # Resubmission email generated with new portal link
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)
    new_token = token_from_outbox("portal")
    assert new_token is not None

    # Customer re-uploads high-quality copy
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.98,
        field_confidences={"pan_number": 0.98, "name": 0.96},
        extracted_fields={"pan_number": "ABCPS1234F", "name": "Sunita Rao"},
    )
    r_reupload = upload_portal_doc(client, new_token, "PAN", content=PNG + b"_resubmit")
    assert r_reupload.status_code == 202
    jobs.run_all()

    # Re-uploaded document is verified and case finishes
    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["case_status"] == "completed"
    assert detail["pending_count"] == 0
