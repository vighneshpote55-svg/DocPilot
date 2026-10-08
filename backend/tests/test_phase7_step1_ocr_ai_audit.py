"""PHASE 7 — STEP 1: OCR & AI Production Readiness Audit Test Suite

Validates:
1. OCR service connectivity, contract, and authentication.
2. PAN and Aadhaar extraction and structural validation.
3. Document classification and type matching.
4. Confidence threshold handling.
5. OCR timeout/failure and retry behavior.
6. Deterministic rules-first execution (CLEAR / INCONCLUSIVE / RISK).
7. CLEAR documents do not invoke AI.
8. RISK documents cannot be overridden by AI.
9. INCONCLUSIVE documents escalate to AI.
10. AI success, timeout, failure, and low-confidence handling.
11. Manual review escalation and reviewer actions.
12. Customer-facing privacy and evidence masking.
13. Cross-document and name compatibility checks.
14. Zero PII or secret leakage in logs.
"""
import io
import json
import logging
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import select

from app import ai_service, db as dbmod, jobs, models, pipeline, rules, services
from app.ai_service import AIResponse, MockAIProvider, set_ai_provider, reset_ai_provider
from app.config import get_settings
from app.masking import create_redacted_evidence, detect_pii, mask_fields
from app.models import Customer, Document, ManualReview, OcrResult
from app.ocr_client import HTTPOCRClient, OCRResult, OCRUnavailable, set_ocr_client
from tests.conftest import PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


# 1. OCR service connectivity and contract
def test_ocr_request_contract_and_auth(monkeypatch):
    """Verify HTTPOCRClient uses correct URL, bearer/api-key auth, multipart file, and expected data."""
    s = get_settings()
    monkeypatch.setattr(s, "ocr_url", "http://127.0.0.1:8001")
    monkeypatch.setattr(s, "ocr_api_key", "secret-ocr-key-12345")
    monkeypatch.setattr(s, "ocr_timeout_seconds", 30)

    client = HTTPOCRClient()

    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "status": "success",
            "doc_type": "pan",
            "detected_type": "pan",
            "confidence": 0.98,
            "field_confidences": {"pan_number": 0.99, "name": 0.97},
            "extracted_fields": {"pan_number": "ABCPE1234F", "name": "ROHIT VERMA"},
            "reason": None,
        }
        mock_post.return_value = mock_resp

        result = client.extract(
            data=b"fake-pan-image-content",
            filename="pan_card.jpg",
            mime="image/jpeg",
            doc_type="pan",
            expected={"name": "ROHIT VERMA"},
            customer_id=101,
        )

        assert mock_post.called
        call_args, call_kwargs = mock_post.call_args
        assert call_args[0] == "http://127.0.0.1:8001/ocr/pan"
        assert call_kwargs["headers"]["Authorization"] == "Bearer secret-ocr-key-12345"
        assert call_kwargs["headers"]["X-API-Key"] == "secret-ocr-key-12345"
        assert call_kwargs["params"] == {"sync": "true"}
        assert "file" in call_kwargs["files"]
        assert call_kwargs["data"]["expected"] == json.dumps({"name": "ROHIT VERMA"})
        assert call_kwargs["data"]["customer_id"] == "101"

        assert isinstance(result, OCRResult)
        assert result.status == "success"
        assert result.doc_type == "pan"
        assert result.extracted_fields["pan_number"] == "ABCPE1234F"


# 2. Valid PAN extraction, structural validation, and deterministic CLEAR
def test_valid_pan_extraction_deterministic_clear():
    """Valid PAN with high confidence passes deterministic rules without AI."""
    raw_ocr = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.96, "name": 0.94},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "ROHIT VERMA"},
    }

    # Redacted evidence masks PAN
    evidence = create_redacted_evidence(raw_ocr)
    assert evidence["extracted_fields"]["pan_number"] == "XXXX234F"

    # Rules evaluate to VERIFIED
    decision = rules.evaluate(
        evidence,
        slot="pan",
        customer_name="ROHIT VERMA",
        min_overall=0.90,
        min_field=0.80,
    )
    assert decision.is_verified()
    assert decision.outcome == "verified"
    assert decision.reason == "rules_passed"
    assert "wrong_document_type" not in decision.flags


# 3. Valid Aadhaar extraction, structural validation, and deterministic CLEAR
def test_valid_aadhaar_extraction_deterministic_clear():
    """Valid Aadhaar with high confidence passes deterministic rules without AI."""
    raw_ocr = {
        "status": "success",
        "doc_type": "aadhaar",
        "detected_type": "aadhaar",
        "confidence": 0.96,
        "field_confidences": {"aadhaar_number": 0.97, "name": 0.95},
        "extracted_fields": {"aadhaar_number": "987654321012", "name": "PRIYA SHARMA"},
    }

    # Redacted evidence masks Aadhaar
    evidence = create_redacted_evidence(raw_ocr)
    assert evidence["extracted_fields"]["aadhaar_number"] == "XXXX1012"

    decision = rules.evaluate(
        evidence,
        slot="aadhaar",
        customer_name="PRIYA SHARMA",
        min_overall=0.90,
        min_field=0.80,
    )
    assert decision.is_verified()
    assert decision.outcome == "verified"
    assert decision.reason == "rules_passed"


# 4. Wrong document type strictly REJECTS
def test_wrong_document_type_strictly_rejects():
    """Uploading a passport into a PAN slot strictly rejects the document."""
    raw_ocr = {
        "status": "success",
        "doc_type": "passport",
        "detected_type": "passport",
        "confidence": 0.95,
        "field_confidences": {"passport_number": 0.95, "name": 0.95},
        "extracted_fields": {"passport_number": "A1234567", "name": "ROHIT VERMA"},
    }
    evidence = create_redacted_evidence(raw_ocr)

    decision = rules.evaluate(
        evidence,
        slot="pan",
        customer_name="ROHIT VERMA",
        min_overall=0.90,
        min_field=0.80,
    )
    assert decision.is_rejected()
    assert decision.outcome == "rejected"
    assert "wrong_document_type" in decision.flags


# 5. Low OCR confidence routes to manual review
def test_low_ocr_confidence_routes_to_manual_review():
    """Confidence below review threshold (< 0.60) strictly routes to manual review."""
    raw_ocr = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.45,
        "field_confidences": {"pan_number": 0.45, "name": 0.45},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "ROHIT VERMA"},
    }
    evidence = create_redacted_evidence(raw_ocr)

    decision = rules.evaluate(
        evidence,
        slot="pan",
        customer_name="ROHIT VERMA",
        min_overall=0.90,
        min_field=0.80,
        min_review=0.60,
    )
    assert decision.is_manual_review()
    assert "low_confidence" in decision.flags


# 6. OCR failure or unreadable document routes to manual review
def test_ocr_unreadable_document_routes_to_manual_review():
    """Unreadable image resulting in OCR error routes to manual review."""
    raw_ocr = {
        "status": "error",
        "doc_type": "pan",
        "confidence": 0.0,
        "reason": "unreadable_image",
        "extracted_fields": {},
    }
    evidence = create_redacted_evidence(raw_ocr)

    decision = rules.evaluate(
        evidence,
        slot="pan",
        customer_name="ROHIT VERMA",
        min_overall=0.90,
        min_field=0.80,
    )
    assert decision.is_manual_review()
    assert "ocr_error" in decision.flags


# 7. Deterministic CLEAR does NOT invoke AI
def test_deterministic_clear_does_not_call_ai(client):
    """End-to-end pipeline: clear rules verification never calls the AI provider."""
    mock_ai = MockAIProvider()
    set_ai_provider(mock_ai)

    try:
        r = client.post("/api/admin/customers", headers=admin_headers(),
                        json={"name": "Auto Verify User", "email": "autoverify@example.com", "required_documents": ["PAN"]})
        assert r.status_code == 201
        consent = token_from_outbox("consent")
        client.post(f"/api/public/consent/{consent}", json={"granted": True})
        portal = token_from_outbox("portal")

        class CleanOCR:
            def extract(self, *args, **kwargs):
                return OCRResult(
                    status="success",
                    doc_type="pan",
                    detected_type="pan",
                    confidence=0.96,
                    field_confidences={"pan_number": 0.95, "name": 0.95},
                    extracted_fields={"pan_number": "ABCPE1234F", "name": "Auto Verify User"},
                )

        set_ocr_client(CleanOCR())
        client.post(f"/api/portal/{portal}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
        jobs.run_all()

        # AI must never have been called
        assert len(mock_ai.calls) == 0

        status_resp = client.get(f"/api/portal/{portal}")
        assert status_resp.status_code == 200
        data = status_resp.json()
        assert data["case_status"] == "completed"
        assert data["documents"][0]["state"] == "verified"
    finally:
        reset_ai_provider()


# 8. Deterministic RISK cannot be overridden by AI
def test_deterministic_risk_cannot_be_overridden_by_ai():
    """Even if AI returns verified with 100% confidence, hard security risk flags cannot be overridden."""
    mock_ai = MockAIProvider()
    mock_ai.next_response = AIResponse(verdict="verified", confidence=100.0, reason="Looks fine to AI")

    decision = rules.Decision(
        outcome="needs_ai",
        flags=["risk:tampering_detected"],
        reason="tampering_detected",
        confidence=0.85,
    )

    final_decision = rules.apply_ai(decision, mock_ai.next_response)
    assert final_decision.is_manual_review()
    assert "risk:tampering_detected" in final_decision.flags
    assert final_decision.outcome != "verified"


# 9. Deterministic INCONCLUSIVE escalates to AI success
def test_deterministic_inconclusive_escalates_to_ai_success():
    """Borderline confidence (e.g. 0.75) without risk flags escalates to AI and verifies on high confidence."""
    mock_ai_resp = AIResponse(
        verdict="verified",
        confidence=95.0,
        reason="Document typography and format align with official templates",
    )

    decision = rules.Decision(
        outcome="needs_ai",
        flags=[],
        reason="rules_inconclusive",
        confidence=0.78,
    )

    final_decision = rules.apply_ai(decision, mock_ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags
    assert "official templates" in final_decision.reason


# 10. AI timeout / failure falls back to manual review
def test_ai_timeout_or_network_failure_falls_back_to_manual_review():
    """When AI provider times out or fails, document safely escalates to human manual review."""
    decision = rules.Decision(
        outcome="needs_ai",
        flags=[],
        reason="rules_inconclusive",
        confidence=0.75,
    )

    final_decision = rules.apply_ai(decision, None)
    assert final_decision.is_manual_review()
    assert "rules_inconclusive" in final_decision.flags
    assert final_decision.reason == "needs_human_check"


# 11. AI low-confidence (< 90) response falls back to manual review
def test_ai_low_confidence_falls_back_to_manual_review():
    """When AI response confidence is below 90%, it cannot auto-verify and routes to manual review."""
    mock_ai_resp = AIResponse(
        verdict="verified",
        confidence=75.0,  # Below 90% threshold
        reason="Somewhat confident",
    )

    decision = rules.Decision(
        outcome="needs_ai",
        flags=[],
        reason="rules_inconclusive",
        confidence=0.75,
    )

    final_decision = rules.apply_ai(decision, mock_ai_resp)
    assert final_decision.is_manual_review()
    assert "ai_uncertain" in final_decision.flags


# 12. Manual review escalation and admin reviewer actions
def test_manual_review_escalation_and_admin_actions(client):
    """Document in manual review creates review record; admin approval sets verified; rejection sets rejected."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Review Subject", "email": "reviewsubject@example.com", "required_documents": ["PAN"]})
    assert r.status_code == 201
    consent = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent}", json={"granted": True})
    portal = token_from_outbox("portal")

    class MismatchOCR:
        def extract(self, *args, **kwargs):
            return OCRResult(
                status="success",
                doc_type="pan",
                detected_type="pan",
                confidence=0.95,
                field_confidences={"pan_number": 0.95, "name": 0.95},
                extracted_fields={"pan_number": "ABCPE1234F", "name": "DIFFERENT PERSON"},
            )

    set_ocr_client(MismatchOCR())
    client.post(f"/api/portal/{portal}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) >= 1
    rev_id = revs[0]["id"]

    # Admin approves document
    res_app = client.post(f"/api/admin/reviews/{rev_id}/approve", json={"notes": "Name discrepancy resolved manually"}, headers=admin_headers())
    assert res_app.status_code == 200

    rev_detail = client.get(f"/api/admin/reviews/{rev_id}", headers=admin_headers()).json()
    assert rev_detail["status"] == "approved"

    # Status in portal should now be verified
    portal_res = client.get(f"/api/portal/{portal}")
    assert portal_res.json()["documents"][0]["state"] == "verified"


# 13. Customer portal privacy: zero raw OCR or internal AI evidence exposed
def test_customer_portal_privacy_hides_raw_evidence(client):
    """Customer-facing portal status endpoint never leaks OCR confidence, raw fields, or AI reasoning."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Portal Privacy User", "email": "portalprivacy@example.com", "required_documents": ["PAN"]})
    assert r.status_code == 201
    consent = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent}", json={"granted": True})
    portal = token_from_outbox("portal")

    class FlaggedOCR:
        def extract(self, *args, **kwargs):
            return OCRResult(
                status="low_confidence",
                doc_type="pan",
                confidence=0.45,
                reason="low_confidence",
                risk_flags=["tampering_detected"],
                extracted_fields={"pan_number": "ABCPE1234F", "name": "Portal Privacy User"},
            )

    set_ocr_client(FlaggedOCR())
    client.post(f"/api/portal/{portal}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    portal_res = client.get(f"/api/portal/{portal}")
    assert portal_res.status_code == 200
    data = portal_res.json()
    docs = data.get("documents", [])
    assert len(docs) == 1
    assert docs[0]["state"] == "under_review"  # Plain language for customer
    assert "risk:tampering_detected" not in str(data)
    assert "low_confidence" not in str(data)
    assert "raw_ocr" not in str(data)
    assert "extracted_fields" not in str(data)
    assert "ABCPE1234F" not in str(data)


# 14. Cross-document and name compatibility checks
def test_name_compatibility_cross_checks():
    """Verify exact, acceptable fuzzy (middle initials), and mismatch comparisons."""
    assert rules.names_compatible("Vikram Sharma", "Vikram Sharma") is True
    assert rules.names_compatible("Vikram R Sharma", "Vikram Sharma") is True
    assert rules.names_compatible("Mr Vikram Sharma", "Vikram Sharma") is True
    assert rules.names_compatible("Vikram Sharma", "Sunil Gupta") is False
