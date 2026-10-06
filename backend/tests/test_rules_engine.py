from datetime import date, timedelta
from sqlalchemy import select
from app.masking import create_redacted_evidence
from app.ocr_client import OCRResult
from app.rules import DecisionState, RulesEngine, evaluate

KW = {"min_overall": 0.90, "min_field": 0.80, "min_review": 0.60}
CUSTOMER_NAME = "Rajesh Kumar Sharma"


# -----------------------------------------------------------------------------
# 1. Valid Document -> VERIFIED
# -----------------------------------------------------------------------------
def test_valid_document_verified():
    res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
    )
    # Test both raw OCRResult and Redacted Evidence from Phase 3 Gateway
    for input_data in (res, create_redacted_evidence(res)):
        decision = evaluate(input_data, "pan", CUSTOMER_NAME, **KW)
        assert decision.outcome == "VERIFIED"
        assert decision.outcome == "verified"
        assert decision.state == "VERIFIED"
        assert decision.is_verified() is True
        assert decision.reason == "rules_passed"
        assert len(decision.flags) == 0


# -----------------------------------------------------------------------------
# 2. Invalid Document -> REJECTED
# -----------------------------------------------------------------------------
def test_invalid_document_rejected():
    # Slot mismatch: customer uploaded a PAN into an Aadhaar slot
    res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
    )
    decision = evaluate(res, "aadhaar", CUSTOMER_NAME, **KW)
    assert decision.outcome == "REJECTED"
    assert decision.outcome == "rejected"
    assert decision.state == "REJECTED"
    assert decision.is_rejected() is True
    assert "wrong_document_type" in decision.flags
    assert decision.reason == "wrong_document_type"

    # Reason code explicitly flagged by OCR service as doc_type_mismatch
    mismatch_res = OCRResult(
        status="error",
        doc_type="aadhaar",
        confidence=0.0,
        reason="doc_type_mismatch",
        extracted_fields={},
    )
    d_mismatch = evaluate(mismatch_res, "aadhaar", CUSTOMER_NAME, **KW)
    assert d_mismatch.outcome == "REJECTED"
    assert d_mismatch.state == "REJECTED"


# -----------------------------------------------------------------------------
# 3. Low Confidence -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_low_confidence_manual_review():
    # Overall confidence is below min_review (e.g. 0.45 < 0.60)
    low_res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.45,
        field_confidences={"pan_number": 0.50, "name": 0.50},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
    )
    decision = evaluate(low_res, "pan", CUSTOMER_NAME, **KW)
    assert decision.outcome == "MANUAL_REVIEW"
    assert decision.outcome == "manual_review"
    assert decision.state == "MANUAL_REVIEW"
    assert decision.is_manual_review() is True
    assert "low_confidence" in decision.flags


# -----------------------------------------------------------------------------
# 4. Expired Document -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_expired_document_manual_review():
    past_date = (date.today() - timedelta(days=90)).strftime("%d/%m/%Y")
    expired_res = OCRResult(
        status="success",
        doc_type="driving_licence",
        confidence=0.95,
        field_confidences={"licence_number": 0.95, "name": 0.95, "valid_until": 0.95},
        extracted_fields={
            "licence_number": "DL-1420110012345",
            "name": "RAJESH KUMAR SHARMA",
            "valid_until": past_date,
        },
    )
    decision = evaluate(expired_res, "driving_licence", CUSTOMER_NAME, **KW)
    assert decision.outcome == "MANUAL_REVIEW"
    assert decision.state == "MANUAL_REVIEW"
    assert "document_expired" in decision.flags


# -----------------------------------------------------------------------------
# 5. Name Mismatch -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_name_mismatch_manual_review():
    res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "SURESH MEHTA"},
    )
    decision = evaluate(res, "pan", CUSTOMER_NAME, **KW)
    assert decision.outcome == "MANUAL_REVIEW"
    assert decision.state == "MANUAL_REVIEW"
    assert "holder_name_mismatch" in decision.flags


# -----------------------------------------------------------------------------
# 6. Risk Flag -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_risk_flag_manual_review():
    # 6a. Explicit risk_flags from company-ocr-service integrity checker
    risk_dict = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
        "risk_flags": ["tampering_detected", "cloned_stamp"],
    }
    d1 = evaluate(risk_dict, "pan", CUSTOMER_NAME, **KW)
    assert d1.outcome == "MANUAL_REVIEW"
    assert d1.state == "MANUAL_REVIEW"
    assert any("risk:tampering_detected" in f for f in d1.flags)

    # 6b. Elevated risk_score from company-ocr-service (score >= 30 is review_required)
    scored_dict = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
        "risk_score": 45,
    }
    d2 = evaluate(scored_dict, "pan", CUSTOMER_NAME, **KW)
    assert d2.outcome == "MANUAL_REVIEW"
    assert "risk_score_high" in d2.flags

    # 6c. Authenticity verification_status == review_required
    review_status_dict = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
        "verification_status": "review_required",
    }
    d3 = evaluate(review_status_dict, "pan", CUSTOMER_NAME, **KW)
    assert d3.outcome == "MANUAL_REVIEW"
    assert "review_required" in d3.flags


# -----------------------------------------------------------------------------
# 7. Inconclusive Rules -> AI_REQUIRED
# -----------------------------------------------------------------------------
def test_inconclusive_rules_ai_required():
    # Confidence is borderline: 0.80 (>= min_review 0.60, but < min_overall 0.90)
    borderline_res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.80,
        field_confidences={"pan_number": 0.85, "name": 0.85},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
    )
    decision = evaluate(borderline_res, "pan", CUSTOMER_NAME, **KW)
    assert decision.outcome == "AI_REQUIRED"
    assert decision.outcome == "needs_ai"
    assert decision.state == "AI_REQUIRED"
    assert decision.is_ai_required() is True
    assert decision.reason == "rules_inconclusive"


# -----------------------------------------------------------------------------
# 8. Failed OCR -> Never VERIFIED
# -----------------------------------------------------------------------------
def test_failed_ocr_never_verified():
    # 8a. OCR returned error
    err_res = OCRResult(
        status="error",
        doc_type="pan",
        confidence=0.0,
        reason="ocr_engine_returned_no_text",
        extracted_fields={},
    )
    d_err = evaluate(err_res, "pan", CUSTOMER_NAME, **KW)
    assert d_err.outcome != "VERIFIED"
    assert d_err.outcome != "verified"
    assert d_err.is_verified() is False
    assert d_err.outcome == "MANUAL_REVIEW"
    assert "ocr_error" in d_err.flags

    # 8b. Unreadable image
    failed_res = OCRResult(
        status="failed",
        doc_type="passport",
        confidence=0.10,
        reason="unreadable_image",
        extracted_fields={},
    )
    d_failed = evaluate(failed_res, "passport", CUSTOMER_NAME, **KW)
    assert d_failed.outcome != "VERIFIED"
    assert d_failed.is_verified() is False
    assert d_failed.outcome == "MANUAL_REVIEW"


# -----------------------------------------------------------------------------
# 9. Valid Aadhaar -> VERIFIED (CLEAR outcome)
# -----------------------------------------------------------------------------
def test_valid_aadhaar_verified_clear():
    res = OCRResult(
        status="success",
        doc_type="aadhaar",
        confidence=0.96,
        field_confidences={"aadhaar_number": 0.95, "name": 0.95},
        extracted_fields={"aadhaar_number": "123456789012", "name": "RAJESH KUMAR SHARMA"},
    )
    redacted = create_redacted_evidence(res)
    decision = evaluate(redacted, "aadhaar", CUSTOMER_NAME, **KW)
    assert decision.outcome == "verified"
    assert decision.state == "VERIFIED"
    assert decision.is_verified() is True
    assert decision.reason == "rules_passed"
    assert len(decision.flags) == 0


# -----------------------------------------------------------------------------
# 10. QR Disagreement -> RISK -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_qr_disagreement_risk_manual_review():
    res = {
        "status": "success",
        "doc_type": "aadhaar",
        "confidence": 0.95,
        "field_confidences": {"aadhaar_number": 0.95, "name": 0.95},
        "extracted_fields": {"aadhaar_number": "XXXX9012", "name": "RAJESH KUMAR SHARMA"},
        "qr_disagreements": ["name_mismatch_with_qr", "qr_signature_invalid"],
    }
    decision = evaluate(res, "aadhaar", CUSTOMER_NAME, **KW)
    assert decision.outcome == "manual_review"
    assert decision.is_verified() is False
    assert "qr_disagreement" in decision.flags


# -----------------------------------------------------------------------------
# 11. Invalid Structural Identifier -> RISK -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_invalid_structural_identifier_risk_manual_review():
    # 11a. Invalid PAN structure
    invalid_pan_res = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "12345ABCDE", "name": "RAJESH KUMAR SHARMA"},  # digits first
    }
    d1 = evaluate(invalid_pan_res, "pan", CUSTOMER_NAME, **KW)
    assert d1.outcome == "manual_review"
    assert "invalid_structural_identifier:pan" in d1.flags

    # 11b. Invalid masked PAN structure (less than 4 suffix chars)
    invalid_masked_pan = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "XXXX12", "name": "RAJESH KUMAR SHARMA"},
    }
    d2 = evaluate(invalid_masked_pan, "pan", CUSTOMER_NAME, **KW)
    assert d2.outcome == "manual_review"
    assert "invalid_structural_identifier:pan" in d2.flags

    # 11c. Invalid IFSC structure on cheque
    invalid_ifsc_res = {
        "status": "success",
        "doc_type": "cancelled_cheque",
        "confidence": 0.95,
        "field_confidences": {"account_holder": 0.95, "ifsc": 0.95},
        "extracted_fields": {"account_holder": "RAJESH KUMAR SHARMA", "ifsc": "1234INVALID"},
    }
    d3 = evaluate(invalid_ifsc_res, "cancelled_cheque", CUSTOMER_NAME, **KW)
    assert d3.outcome == "manual_review"
    assert "invalid_structural_identifier:ifsc" in d3.flags


# -----------------------------------------------------------------------------
# 12. Name Matching Deterministic Matrix
# -----------------------------------------------------------------------------
def test_name_matching_deterministic_matrix():
    from app.rules import match_name
    # Exact match
    m_exact = match_name("Rajesh Kumar Sharma", "RAJESH KUMAR SHARMA")
    assert m_exact["match"] is True
    assert m_exact["type"] == "exact"

    # Acceptable fuzzy / title variation
    m_fuzzy = match_name("Mr. Rajesh Kumar Sharma", "Rajesh Sharma")
    assert m_fuzzy["match"] is True
    assert m_fuzzy["type"] == "acceptable_fuzzy"

    # Mismatch
    m_mismatch = match_name("Rajesh Kumar Sharma", "Vikram Malhotra")
    assert m_mismatch["match"] is False
    assert m_mismatch["type"] == "mismatch"


# -----------------------------------------------------------------------------
# 13. Missing Required Fields -> RISK -> MANUAL_REVIEW
# -----------------------------------------------------------------------------
def test_missing_required_fields_risk_manual_review():
    missing_fields_res = {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"name": 0.95},
        "extracted_fields": {"name": "RAJESH KUMAR SHARMA"},  # missing pan_number
    }
    decision = evaluate(missing_fields_res, "pan", CUSTOMER_NAME, **KW)
    assert decision.outcome == "manual_review"
    assert "missing_fields:pan_number" in decision.flags


# -----------------------------------------------------------------------------
# 14. Rules Consume ONLY Privacy-Safe Evidence (No Raw PII)
# -----------------------------------------------------------------------------
def test_rules_receive_only_privacy_safe_evidence():
    raw_res = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.96,
        field_confidences={"pan_number": 0.95, "name": 0.95},
        extracted_fields={
            "pan_number": "ABCPE1234F",
            "aadhaar_number": "4793 3788 8508",
            "account_number": "123456789012",
            "name": "RAJESH KUMAR SHARMA",
        },
    )
    redacted = create_redacted_evidence(raw_res)

    # Invariants: raw PII strings must not exist in evidence
    evidence_str = str(redacted)
    assert "ABCPE1234F" not in evidence_str
    assert "4793 3788 8508" not in evidence_str
    assert "123456789012" not in evidence_str

    # Redacted values are preserved structurally
    assert "XXXX" in evidence_str

    # Rules evaluate cleanly on redacted evidence
    decision = evaluate(redacted, "pan", CUSTOMER_NAME, **KW)
    assert decision.outcome == "verified"
    assert decision.reason == "rules_passed"


# -----------------------------------------------------------------------------
# 15. Pipeline Integration & Audit Events for Step 8
# -----------------------------------------------------------------------------
def test_pipeline_step8_rules_audit_events(client, env):
    from app import jobs, services
    from app.db import session_scope
    from app.models import AuditLog, Document
    from tests.conftest import PNG

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.98, "name": 0.98},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"},
    )

    with session_scope() as db:
        c = services.create_customer(
            db,
            name="Vighnesh Pote",
            email="vighnesh@example.com",
            mobile="+919876543210",
            required=["pan"],
            actor="test",
        )
        services.record_consent(db, c, granted=True)
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG)
        doc_id = doc.id

    assert jobs.run_one() is True

    with session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "verified"

        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == doc_id)).all())
        actions = [a.action for a in audits]

        # Verify Step 8 rules audit sequence
        assert "rules_verification_started" in actions
        assert "rules_verified" in actions

        # Verify zero PII in audit details
        for a in audits:
            detail_str = str(a.details or "")
            assert "ABCPE1234F" not in detail_str
            assert "vighnesh@example.com" not in detail_str


# -----------------------------------------------------------------------------
# 16. Pipeline Idempotency: Verified, Superseded, and Inactive Skipped
# -----------------------------------------------------------------------------
def test_pipeline_idempotency_and_skipped_conditions(client, env):
    from app import services
    from app.db import session_scope
    from app.models import Document
    from app.pipeline import handle_process_document
    from tests.conftest import PNG

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.98, "name": 0.98},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"},
    )

    with session_scope() as db:
        c = services.create_customer(
            db,
            name="Vighnesh Pote",
            email="vighnesh2@example.com",
            mobile="+919876543211",
            required=["pan"],
            actor="test",
        )
        services.record_consent(db, c, granted=True)
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG)
        doc_id = doc.id

        # 16a. Already verified document is skipped idempotently
        doc.verification_status = "verified"
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        # ocr_status remained untouched (not transitioned to processing)
        assert doc.ocr_status == "waiting"

        # 16b. Superseded document is skipped
        doc.verification_status = "not_started"
        doc.superseded = True
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        assert doc.ocr_status == "waiting"

        # 16c. Consent withdrawn or customer inactive is skipped
        doc.superseded = False
        c.consent_status = "withdrawn"
        db.flush()
        handle_process_document(db, {"document_id": doc_id})
        assert doc.ocr_status == "failed"
        assert doc.reason == "processing_stopped"


# -----------------------------------------------------------------------------
# 17. Fail-Closed Rules Execution: Exceptions Route to Manual Review
# -----------------------------------------------------------------------------
def test_rules_failure_fails_closed_safely(client, env, monkeypatch):
    from app import jobs, services
    from app.db import session_scope
    from app.models import AuditLog, Document
    from tests.conftest import PNG

    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.98, "name": 0.98},
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Crash User"},
    )

    # Monkeypatch rules.evaluate to simulate an unexpected crash
    def crash_evaluate(*args, **kwargs):
        raise RuntimeError("simulated_unexpected_rules_crash")

    monkeypatch.setattr("app.rules.evaluate", crash_evaluate)

    with session_scope() as db:
        c = services.create_customer(
            db,
            name="Crash User",
            email="crash@example.com",
            mobile="+919876543212",
            required=["pan"],
            actor="test",
        )
        services.record_consent(db, c, granted=True)
        doc = services.accept_upload(db, c, "pan", "pan.png", PNG)
        doc_id = doc.id

    assert jobs.run_one() is True

    with session_scope() as db:
        doc = db.get(Document, doc_id)
        # Fails closed: NEVER verified
        assert doc.verification_status == "manual_review"
        assert doc.verification_status != "verified"
        assert "rules_engine_error" in doc.flags

        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == doc_id)).all())
        actions = [a.action for a in audits]
        assert "rules_failed" in actions

