import json
from datetime import date, timedelta
from unittest.mock import MagicMock

import httpx
import pytest
from sqlalchemy import select

from app import db as dbmod, jobs, services
from app.ai_service import (
    AIRequestPayload,
    AIResponse,
    MockAIProvider,
    assess,
    reset_ai_provider,
    set_ai_provider,
)
from app.models import AuditLog, Customer, Document, Job, ManualReview
from app.ocr_client import OCRResult
from app.rules import Decision, DecisionState, apply_ai, evaluate

PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"


@pytest.fixture(autouse=True)
def clean_ai_provider():
    reset_ai_provider()
    yield
    reset_ai_provider()


def setup_customer_and_doc(db, doc_type="pan", expected_name="VIKRAM SHARMA"):
    c = services.create_customer(
        db,
        name=expected_name,
        email=f"test_{expected_name.lower().replace(' ', '_')}@example.com",
        mobile="+919876543210",
        required=[doc_type],
        actor="test",
    )
    services.record_consent(db, c, granted=True)
    doc = services.accept_upload(db, c, doc_type, f"{doc_type}.png", PNG_BYTES)
    return c, doc.id


# -----------------------------------------------------------------------------
# 1. Rules VERIFIED -> AI is not called
# -----------------------------------------------------------------------------
def test_rules_verified_ai_not_called(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {"verdict": "verified", "confidence": 98, "reason": "AI approved"}
    set_ai_provider(mock_ai)

    # FakeOCR returns high-confidence clean PAN matching customer name
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.98, "name": 0.98},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "verified"
        assert doc.ocr_status == "completed"

    # AI must NOT be invoked when rules verify the document
    assert len(mock_ai.calls) == 0


# -----------------------------------------------------------------------------
# 2. Rules REJECTED -> AI is not called
# -----------------------------------------------------------------------------
def test_rules_rejected_ai_not_called(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {"verdict": "verified", "confidence": 98, "reason": "AI approved"}
    set_ai_provider(mock_ai)

    # Customer uploads PAN into aadhaar slot -> wrong_document_type
    env.responses["aadhaar"] = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "aadhaar")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "rejected"
        assert "wrong_document_type" in doc.flags

    # AI must NOT be invoked when rules reject the document
    assert len(mock_ai.calls) == 0


# -----------------------------------------------------------------------------
# 3. Rules AI_REQUIRED -> AI is called
# -----------------------------------------------------------------------------
def test_rules_ai_required_ai_is_called(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {"verdict": "verified", "confidence": 95, "reason": "Fields genuine"}
    set_ai_provider(mock_ai)

    # Borderline confidence: 0.80 (>= min_review 0.60 but < min_overall 0.90) -> AI_REQUIRED
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    # AI MUST be called exactly once
    assert len(mock_ai.calls) == 1
    call = mock_ai.calls[0]
    assert call.doc_type == "pan"
    assert "ocr" in call.model_dump()


# -----------------------------------------------------------------------------
# 4. AI high-confidence result -> VERIFIED
# -----------------------------------------------------------------------------
def test_ai_high_confidence_result_verified(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {
        "verdict": "verified",
        "confidence": 94,
        "reason": "Document typography and format align with authentic PAN",
    }
    set_ai_provider(mock_ai)

    # Inconclusive rules
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "verified"
        assert "ai_verified" in doc.flags
        assert "Document typography" in doc.reason


# -----------------------------------------------------------------------------
# 5. AI low-confidence result -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_ai_low_confidence_result_manual_review(client, env):
    mock_ai = MockAIProvider()
    # Confidence is 65 (< 90 threshold)
    mock_ai.next_response = {
        "verdict": "verified",
        "confidence": 65,
        "reason": "Uncertain about header font consistency",
    }
    set_ai_provider(mock_ai)

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "manual_review"
        assert "ai_uncertain" in doc.flags


# -----------------------------------------------------------------------------
# 6. AI timeout -> MANUAL_REVIEW (never VERIFIED)
# -----------------------------------------------------------------------------
def test_ai_timeout_manual_review(client, env):
    mock_ai = MockAIProvider()
    mock_ai.raise_timeout = True
    set_ai_provider(mock_ai)

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "manual_review"
        assert doc.verification_status != "verified"
        assert "rules_inconclusive" in doc.flags


# -----------------------------------------------------------------------------
# 7. AI invalid response -> MANUAL_REVIEW (never VERIFIED)
# -----------------------------------------------------------------------------
def test_ai_invalid_response_manual_review():
    # 7a. Non-dictionary or malformed output
    res_none = assess("pan", {"name": "Test"}, ["flag"])
    assert res_none is None

    # 7b. Invalid verdict schema (e.g. unknown verdict string)
    with pytest.raises(ValueError):
        AIResponse.from_raw({"verdict": "super_verified", "confidence": 99, "reason": "ok"})

    # 7c. Missing confidence
    with pytest.raises(ValueError):
        AIResponse.from_raw({"verdict": "verified", "reason": "ok"})

    # 7d. rules.apply_ai on invalid response defaults safely to manual review
    base_decision = Decision(DecisionState.AI_REQUIRED, flags=["rules_inconclusive"], confidence=0.80)
    decision = apply_ai(base_decision, None)
    assert decision.outcome == "manual_review"
    assert decision.outcome != "verified"
    assert decision.state == "MANUAL_REVIEW"


# -----------------------------------------------------------------------------
# 8. Raw PII is not included in the AI payload
# -----------------------------------------------------------------------------
def test_raw_pii_not_in_ai_payload(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {"verdict": "verified", "confidence": 95, "reason": "ok"}
    set_ai_provider(mock_ai)

    raw_pan = "ABCPE1234F"
    raw_aadhaar = "4793 3788 8508"
    raw_account = "123456789012"

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={
            "pan_number": raw_pan,
            "aadhaar_number": raw_aadhaar,
            "account_number": raw_account,
            "name": "VIKRAM SHARMA",
        },
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    assert len(mock_ai.calls) == 1
    ai_ocr_payload = mock_ai.calls[0].ocr
    payload_str = json.dumps(ai_ocr_payload)

    # Raw PII must NOT appear in the payload sent to AI
    assert raw_pan not in payload_str
    assert raw_aadhaar not in payload_str
    assert raw_account not in payload_str

    # Only masked PII representations are present
    assert "XXXX" in payload_str


# -----------------------------------------------------------------------------
# 9. Hard risk failure cannot be overridden by AI
# -----------------------------------------------------------------------------
def test_hard_risk_failure_cannot_be_overridden_by_ai():
    # AI returns 100% confidence verified verdict
    ai_verdict = AIResponse(verdict="verified", confidence=100.0, reason="Looks completely authentic")

    # 9a. Name mismatch hard flag
    mismatch_decision = Decision(DecisionState.MANUAL_REVIEW, flags=["holder_name_mismatch"], reason="name_mismatch")
    d1 = apply_ai(mismatch_decision, ai_verdict)
    assert d1.outcome == "manual_review"
    assert d1.outcome != "verified"

    # 9b. Document expired hard flag
    expired_decision = Decision(DecisionState.MANUAL_REVIEW, flags=["document_expired"], reason="expired")
    d2 = apply_ai(expired_decision, ai_verdict)
    assert d2.outcome == "manual_review"
    assert d2.outcome != "verified"

    # 9c. Authenticity risk flag from company-ocr-service
    tampered_decision = Decision(DecisionState.MANUAL_REVIEW, flags=["risk:tampering_detected"], reason="tampered")
    d3 = apply_ai(tampered_decision, ai_verdict)
    assert d3.outcome == "manual_review"
    assert d3.outcome != "verified"

    # 9d. Wrong document type rejected
    rejected_decision = Decision(DecisionState.REJECTED, flags=["wrong_document_type"], reason="slot_mismatch")
    d4 = apply_ai(rejected_decision, ai_verdict)
    assert d4.outcome == "rejected"
    assert d4.outcome != "verified"


# -----------------------------------------------------------------------------
# 10. Duplicate processing does not create duplicate AI decisions
# -----------------------------------------------------------------------------
def test_duplicate_processing_no_duplicate_ai_decisions(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {"verdict": "verified", "confidence": 95, "reason": "AI verified"}
    set_ai_provider(mock_ai)

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    # First execution: worker processes document, invokes AI, marks verified
    assert jobs.run_one() is True
    assert len(mock_ai.calls) == 1

    # Second execution: re-invoke handle_process_document with db scope
    with dbmod.session_scope() as db:
        from app.pipeline import handle_process_document
        handle_process_document(db, {"document_id": doc_id})

    # AI provider MUST NOT be called again
    assert len(mock_ai.calls) == 1

    # Verify audit log contains only one AI event
    with dbmod.session_scope() as db:
        ai_audits = db.scalars(
            select(AuditLog).where(
                AuditLog.entity_id == str(doc_id),
                AuditLog.action == "ai_assessment_completed",
            )
        ).all()
        assert len(ai_audits) == 1


# -----------------------------------------------------------------------------
# 11. Step 9 Explicit Audit Events Sequence
# -----------------------------------------------------------------------------
def test_step9_ai_audit_events_sequence(client, env):
    mock_ai = MockAIProvider()
    mock_ai.next_response = {
        "decision": "verified",
        "confidence": 0.96,
        "reason": "AI verified with genuine layout",
        "reason_codes": ["layout_authentic"],
        "risk_flags": [],
        "evidence_summary": "Authentic structure",
    }
    set_ai_provider(mock_ai)

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(doc_id))).all())
        actions = [a.action for a in audits]

        assert "ai_verification_started" in actions
        assert "ai_verified" in actions

        # Verify zero PII in audit payloads
        for a in audits:
            det = str(a.details or "")
            assert "ABCPE1234F" not in det
            assert "VIKRAM SHARMA" not in det


# -----------------------------------------------------------------------------
# 12. Pre-Dispatch PII Leak Prevention Blocks AI Dispatch
# -----------------------------------------------------------------------------
def test_pre_dispatch_pii_leak_prevention_blocks_ai(client, env):
    mock_ai = MockAIProvider()
    set_ai_provider(mock_ai)

    from app.ai_service import verify_ai_payload_safety

    # Safe payload passes
    safe_payload = {"pan_number": "XXXX234F", "name": "VIKRAM SHARMA"}
    is_safe, err = verify_ai_payload_safety(safe_payload)
    assert is_safe is True
    assert err is None

    # Unsafe raw PAN payload is blocked
    unsafe_pan_payload = {"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"}
    is_safe_pan, err_pan = verify_ai_payload_safety(unsafe_pan_payload)
    assert is_safe_pan is False
    assert err_pan == "unmasked_pan_detected"

    # Unsafe raw phone payload is blocked
    unsafe_phone_payload = {"phone": "9876543210"}
    is_safe_ph, err_ph = verify_ai_payload_safety(unsafe_phone_payload)
    assert is_safe_ph is False
    assert err_ph == "unmasked_phone_detected"

    # Unsafe raw email payload is blocked
    unsafe_email_payload = {"email": "user@example.com"}
    is_safe_em, err_em = verify_ai_payload_safety(unsafe_email_payload)
    assert is_safe_em is False
    assert err_em == "unmasked_email_detected"

    # In pipeline, if pre-dispatch safety fails, AI is NOT called and routes to manual_review
    from unittest.mock import patch
    with patch("app.ai_service.verify_ai_payload_safety", return_value=(False, "test_pii_detected")):
        env.responses["pan"] = OCRResult(
            status="success",
            doc_type="pan",
            confidence=0.80,
            field_confidences={"pan_number": 0.85, "name": 0.85},
            extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
        )
        with dbmod.session_scope() as db:
            cust, doc_id = setup_customer_and_doc(db, "pan")

        assert jobs.run_one() is True

        # AI provider must NOT have been called
        assert len(mock_ai.calls) == 0

        with dbmod.session_scope() as db:
            doc = db.get(Document, doc_id)
            assert doc.verification_status == "manual_review"

            audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(doc_id))).all())
            actions = [a.action for a in audits]
            assert "ai_failed" in actions


# -----------------------------------------------------------------------------
# 13. Structured AI Output Validation
# -----------------------------------------------------------------------------
def test_structured_ai_output_validation():
    # 13a. Valid structured schema with 0-1 confidence float
    resp = AIResponse.from_raw({
        "decision": "verified",
        "confidence": 0.95,
        "reason": "Typography consistent",
        "reason_codes": ["font_consistent"],
        "risk_flags": [],
        "evidence_summary": "Genuine typography",
    })
    assert resp.decision == "verified"
    assert resp.confidence == 95.0
    assert resp.reason_codes == ["font_consistent"]
    assert resp.evidence_summary == "Genuine typography"

    # 13b. Inconclusive AI decision
    resp_inconclusive = AIResponse.from_raw({
        "decision": "inconclusive",
        "confidence": 0.70,
        "reason": "Stamp partially blurred",
    })
    assert resp_inconclusive.decision == "inconclusive"
    assert resp_inconclusive.verdict == "inconclusive"

    # 13c. Manual review AI decision
    resp_review = AIResponse.from_raw({
        "decision": "manual_review",
        "confidence": 0.40,
        "reason": "High likelihood of forgery",
        "risk_flags": ["forgery_suspected"],
    })
    assert resp_review.decision == "manual_review"
    assert "forgery_suspected" in resp_review.risk_flags


# -----------------------------------------------------------------------------
# 14. AI Inconclusive or Risk Flags Routes to Manual Review
# -----------------------------------------------------------------------------
def test_ai_inconclusive_or_risk_routes_to_manual_review(client, env):
    # 14a. AI returns inconclusive decision
    mock_ai = MockAIProvider()
    mock_ai.next_response = {
        "decision": "inconclusive",
        "confidence": 0.85,
        "reason": "Not enough evidence to confirm authenticity",
    }
    set_ai_provider(mock_ai)

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        cust, doc_id = setup_customer_and_doc(db, "pan")

    assert jobs.run_one() is True

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "manual_review"
        assert doc.verification_status != "verified"

        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == str(doc_id))).all())
        actions = [a.action for a in audits]
        assert "ai_inconclusive" in actions


# -----------------------------------------------------------------------------
# 15. Pipeline Idempotency: Verified / Superseded / Withdrawn Bypasses AI
# -----------------------------------------------------------------------------
def test_pipeline_idempotency_bypasses_ai(client, env):
    mock_ai = MockAIProvider()
    set_ai_provider(mock_ai)

    from app.pipeline import handle_process_document

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"},
    )

    with dbmod.session_scope() as db:
        c = services.create_customer(
            db,
            name="VIKRAM SHARMA",
            email="vikram_skip@example.com",
            mobile="+919876543210",
            required=["pan"],
            actor="test",
        )
        services.record_consent(db, c, granted=True)
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG_BYTES)
        doc_id = doc.id

        # Document already verified -> must not invoke AI
        doc.verification_status = "verified"
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        assert len(mock_ai.calls) == 0

        # Superseded document -> must not invoke AI
        doc.verification_status = "not_started"
        doc.superseded = True
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        assert len(mock_ai.calls) == 0

        # Consent withdrawn -> must not invoke AI
        doc.superseded = False
        c.consent_status = "withdrawn"
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        assert len(mock_ai.calls) == 0

