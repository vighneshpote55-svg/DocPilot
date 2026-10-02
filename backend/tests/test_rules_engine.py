from datetime import date, timedelta
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
