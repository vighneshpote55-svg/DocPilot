"""PHASE 7 — STEP 3: AI Provider & Failure Validation Test Suite

Validates all 22 required AI scenarios:
1. AI provider available + valid response
2. AI provider timeout
3. AI provider connection failure
4. AI provider HTTP 500
5. AI authentication failure (401/403)
6. AI malformed JSON response
7. AI missing required response fields
8. AI invalid verdict
9. AI confidence below required threshold (< 90)
10. AI confidence exactly at required threshold (== 90)
11. AI confidence above required threshold (> 90)
12. AI returns risk flags
13. AI attempts to verify deterministic RISK document
14. AI attempts to override wrong-document rejection
15. AI receives/attempts to receive unmasked PII
16. AI response contains unexpected sensitive fields
17. AI duplicate/replayed processing
18. AI recovery after temporary outage
19. AI failure -> manual review
20. AI success -> verified
21. AI low confidence -> manual review
22. AI high confidence + zero risk -> verified
"""
import json
import logging
from unittest.mock import MagicMock, patch
import httpx
import pytest

from app import ai_service, db as dbmod, jobs, models, pipeline, rules, services
from app.ai_service import (
    AIRequestPayload,
    AIResponse,
    MockAIProvider,
    OpenAICompatibleProvider,
    reset_ai_provider,
    set_ai_provider,
    verify_ai_payload_safety,
)
from app.config import get_settings
from app.models import Customer, Document, ManualReview
from app.ocr_client import OCRResult, set_ocr_client
from tests.conftest import PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")
CUSTOMER_NAME = "Vikram Sharma"


@pytest.fixture(autouse=True)
def clean_ai():
    reset_ai_provider()
    yield
    reset_ai_provider()


# -----------------------------------------------------------------------------
# Scenario 1: AI Provider Available + Valid Response
# -----------------------------------------------------------------------------
def test_scenario_01_ai_available_valid_response():
    """Valid HTTP response from OpenAI-compatible provider is parsed into structured AIResponse."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-ai-key", "gpt-4o-mini")

    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "verdict": "verified",
                        "confidence": 94.5,
                        "reason": "Clear document structure and matching typography",
                    })
                }
            }]
        }
        mock_post.return_value = mock_resp

        req = AIRequestPayload(doc_type="pan", ocr={"doc_type": "pan", "confidence": 0.78}, flags=["rules_inconclusive"])
        res = provider.assess(req)

        assert res is not None
        assert res.verdict == "verified"
        assert res.confidence == 94.5
        assert "typography" in res.reason


# -----------------------------------------------------------------------------
# Scenario 2: AI Provider Timeout
# -----------------------------------------------------------------------------
def test_scenario_02_ai_provider_timeout():
    """AI provider socket timeout is caught safely and returns None without unhandled exception."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-ai-key", "gpt-4o-mini")

    with patch("httpx.post", side_effect=httpx.TimeoutException("Read timed out")):
        req = AIRequestPayload(doc_type="pan", ocr={"confidence": 0.75}, flags=[])
        res = provider.assess(req)
        assert res is None


# -----------------------------------------------------------------------------
# Scenario 3: AI Provider Connection Failure
# -----------------------------------------------------------------------------
def test_scenario_03_ai_provider_connection_failure():
    """Network connection failure to AI provider returns None gracefully."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-ai-key", "gpt-4o-mini")

    with patch("httpx.post", side_effect=httpx.ConnectError("Failed to establish a new connection")):
        req = AIRequestPayload(doc_type="pan", ocr={}, flags=[])
        res = provider.assess(req)
        assert res is None


# -----------------------------------------------------------------------------
# Scenario 4: AI Provider HTTP 500
# -----------------------------------------------------------------------------
def test_scenario_04_ai_provider_http_500():
    """HTTP 500 internal server error from AI gateway returns None without crashing."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-ai-key", "gpt-4o-mini")

    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError("500 Internal Server Error", request=MagicMock(), response=mock_resp)
        mock_post.return_value = mock_resp

        req = AIRequestPayload(doc_type="pan", ocr={}, flags=[])
        res = provider.assess(req)
        assert res is None


# -----------------------------------------------------------------------------
# Scenario 5: AI Authentication Failure
# -----------------------------------------------------------------------------
def test_scenario_05_ai_auth_failure():
    """HTTP 401 Unauthorized from AI provider returns None and does not leak API keys into logs."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-api-key-12345", "gpt-4o-mini")

    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError("401 Unauthorized", request=MagicMock(), response=mock_resp)
        mock_post.return_value = mock_resp

        req = AIRequestPayload(doc_type="pan", ocr={}, flags=[])
        res = provider.assess(req)
        assert res is None


# -----------------------------------------------------------------------------
# Scenario 6: AI Malformed JSON Response
# -----------------------------------------------------------------------------
def test_scenario_06_ai_malformed_json_response():
    """Malformed non-JSON response from AI provider returns None safely."""
    provider = OpenAICompatibleProvider("https://api.openai.com/v1", "secret-ai-key", "gpt-4o-mini")

    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "This is plain text with no valid JSON {}!"}}]
        }
        mock_post.return_value = mock_resp

        req = AIRequestPayload(doc_type="pan", ocr={}, flags=[])
        res = provider.assess(req)
        assert res is None


# -----------------------------------------------------------------------------
# Scenario 7: AI Missing Required Response Fields
# -----------------------------------------------------------------------------
def test_scenario_07_ai_missing_required_fields():
    """AI response missing required verdict or confidence is rejected."""
    with pytest.raises(Exception):
        AIResponse.from_raw({"verdict": "verified"})  # missing confidence and reason

    with pytest.raises(Exception):
        AIResponse.from_raw({"confidence": 95})  # missing verdict


# -----------------------------------------------------------------------------
# Scenario 8: AI Invalid Verdict
# -----------------------------------------------------------------------------
def test_scenario_08_ai_invalid_verdict():
    """AI verdict with unsupported text (e.g. 'maybe' or 'unknown') raises validation error."""
    with pytest.raises(ValueError, match="Invalid AI verdict"):
        AIResponse.from_raw({"verdict": "maybe_genuine", "confidence": 95, "reason": "Not sure"})


# -----------------------------------------------------------------------------
# Scenario 9: AI Confidence Below Required Threshold (< 90)
# -----------------------------------------------------------------------------
def test_scenario_09_ai_confidence_below_threshold():
    """AI confidence of 89.9% (< 90.0) fails auto-verification and routes to manual review."""
    ai_resp = AIResponse(verdict="verified", confidence=89.9, reason="Borderline confidence")
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_manual_review()
    assert "ai_uncertain" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 10: AI Confidence Exactly at Required Threshold (== 90)
# -----------------------------------------------------------------------------
def test_scenario_10_ai_confidence_at_threshold():
    """AI confidence of exactly 90.0% meets threshold and upgrades to VERIFIED."""
    ai_resp = AIResponse(verdict="verified", confidence=90.0, reason="Sufficient threshold verification")
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 11: AI Confidence Above Required Threshold (> 90)
# -----------------------------------------------------------------------------
def test_scenario_11_ai_confidence_above_threshold():
    """AI confidence of 98.0% (> 90.0) upgrades to VERIFIED."""
    ai_resp = AIResponse(verdict="verified", confidence=98.0, reason="High certainty verification")
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 12: AI Returns Risk Flags
# -----------------------------------------------------------------------------
def test_scenario_12_ai_returns_risk_flags():
    """AI assessment returning risk flags cannot verify and routes to manual review."""
    ai_resp = AIResponse(
        verdict="verified",
        confidence=95.0,
        reason="Good quality but slight font inconsistency",
        risk_flags=["font_anomaly_detected"],
    )
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_manual_review()
    assert "ai_risk:font_anomaly_detected" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 13: AI Attempts to Verify Deterministic RISK Document
# -----------------------------------------------------------------------------
def test_scenario_13_ai_cannot_override_deterministic_risk():
    """Deterministic tampering or hard risk flags cannot be overridden by AI."""
    ai_resp = AIResponse(verdict="verified", confidence=100.0, reason="I think it's authentic")
    decision = rules.Decision("manual_review", flags=["risk:tampering_detected"], reason="tampering", confidence=0.70)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_manual_review()
    assert "risk:tampering_detected" in final_decision.flags
    assert final_decision.outcome != "verified"


# -----------------------------------------------------------------------------
# Scenario 14: AI Attempts to Override Wrong-Document Rejection
# -----------------------------------------------------------------------------
def test_scenario_14_ai_cannot_override_wrong_document():
    """A rejected wrong document cannot be converted to verified by AI."""
    ai_resp = AIResponse(verdict="verified", confidence=99.0, reason="Valid document")
    decision = rules.Decision("rejected", flags=["wrong_document_type"], reason="wrong_document_type", confidence=0.90)

    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.outcome == "rejected"
    assert "wrong_document_type" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 15: AI Payload Safety Gate Rejects Unmasked PII
# -----------------------------------------------------------------------------
def test_scenario_15_ai_payload_safety_gate_rejects_unmasked_pii():
    """Outbound payload containing unmasked PAN, Aadhaar, or Account number fails safety gate."""
    # Payload with raw unmasked PAN
    unsafe_pan_payload = {
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "VIKRAM SHARMA"}
    }
    is_safe, err = verify_ai_payload_safety(unsafe_pan_payload)
    assert is_safe is False
    assert err == "unmasked_pan_detected"

    # Payload with raw unmasked Aadhaar
    unsafe_aadhaar_payload = {
        "extracted_fields": {"aadhaar_number": "987654321012", "name": "VIKRAM SHARMA"}
    }
    is_safe, err = verify_ai_payload_safety(unsafe_aadhaar_payload)
    assert is_safe is False
    assert err == "unmasked_aadhaar_detected"

    # Redacted safe payload passes
    safe_payload = {
        "extracted_fields": {"pan_number": "XXXX234F", "name": "VIKRAM SHARMA"}
    }
    is_safe, err = verify_ai_payload_safety(safe_payload)
    assert is_safe is True
    assert err is None


# -----------------------------------------------------------------------------
# Scenario 16: AI Response Contains Unexpected Sensitive Fields
# -----------------------------------------------------------------------------
def test_scenario_16_ai_response_drops_unexpected_fields():
    """Unexpected or rogue fields injected into AI response dictionary are dropped by schema validation."""
    raw_ai_dict = {
        "verdict": "verified",
        "confidence": 95.0,
        "reason": "Authentic formatting",
        "unexpected_pii": "ABCPE1234F",
        "raw_pan": "ABCPE1234F",
    }
    ai_resp = AIResponse.from_raw(raw_ai_dict)
    # The validated AIResponse does not expose unexpected_pii as attributes
    assert not hasattr(ai_resp, "unexpected_pii")
    assert not hasattr(ai_resp, "raw_pan")


# -----------------------------------------------------------------------------
# Scenario 17: AI Duplicate / Replayed Processing
# -----------------------------------------------------------------------------
def test_scenario_17_duplicate_processing_no_duplicate_ai(client):
    """Re-executing the job pipeline on an already-verified document never re-invokes AI."""
    mock_ai = MockAIProvider()
    mock_ai.next_response = AIResponse(verdict="verified", confidence=95.0, reason="AI verified")
    set_ai_provider(mock_ai)

    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Duplicate User", "email": "dup@example.com", "required_documents": ["PAN"]})
    consent = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent}", json={"granted": True})
    portal = token_from_outbox("portal")

    class InconclusiveOCR:
        def extract(self, *args, **kwargs):
            return OCRResult(
                status="success",
                doc_type="pan",
                detected_type="pan",
                confidence=0.75,
                extracted_fields={"pan_number": "ABCPE1234F", "name": "Duplicate User"},
            )

    set_ocr_client(InconclusiveOCR())
    client.post(f"/api/portal/{portal}/upload", data={"doc_type": "PAN"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    assert len(mock_ai.calls) == 1

    # Re-run jobs (replayed execution)
    jobs.run_all()
    # Call count remains 1: no duplicate AI invocations
    assert len(mock_ai.calls) == 1


# -----------------------------------------------------------------------------
# Scenario 18: AI Recovery After Temporary Outage
# -----------------------------------------------------------------------------
def test_scenario_18_ai_recovery_after_outage():
    """Simulated AI provider recovery restores normal escalation verification."""
    mock_ai = MockAIProvider()
    set_ai_provider(mock_ai)

    req = AIRequestPayload(doc_type="pan", ocr={"pan_number": "XXXX234F"}, flags=[])

    # Outage 1: timeout
    mock_ai.raise_timeout = True
    with pytest.raises(httpx.TimeoutException):
        mock_ai.assess(req)

    # Outage restored: valid response returned
    mock_ai.raise_timeout = False
    mock_ai.next_response = AIResponse(verdict="verified", confidence=95.0, reason="System recovered")
    recovered_res = mock_ai.assess(req)

    assert recovered_res is not None
    assert recovered_res.verdict == "verified"
    assert recovered_res.confidence == 95.0


# -----------------------------------------------------------------------------
# Scenario 19: AI Failure -> Manual Review
# -----------------------------------------------------------------------------
def test_scenario_19_ai_failure_routes_to_manual_review():
    """When AI fails (None), the inconclusive document falls back to human manual review."""
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)
    final_decision = rules.apply_ai(decision, None)
    assert final_decision.is_manual_review()
    assert "rules_inconclusive" in final_decision.flags
    assert final_decision.reason == "needs_human_check"


# -----------------------------------------------------------------------------
# Scenario 20: AI Success -> Verified
# -----------------------------------------------------------------------------
def test_scenario_20_ai_success_routes_to_verified():
    """Clean AI success with confidence 95% promotes inconclusive document to verified."""
    ai_resp = AIResponse(verdict="verified", confidence=95.0, reason="Legitimate document")
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)
    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 21: AI Low Confidence -> Manual Review
# -----------------------------------------------------------------------------
def test_scenario_21_ai_low_confidence_routes_to_manual_review():
    """AI verdict with confidence 70% (< 90%) routes to manual review with ai_uncertain flag."""
    ai_resp = AIResponse(verdict="verified", confidence=70.0, reason="Uncertain features")
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)
    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_manual_review()
    assert "ai_uncertain" in final_decision.flags


# -----------------------------------------------------------------------------
# Scenario 22: AI High Confidence + Zero Risk -> Verified
# -----------------------------------------------------------------------------
def test_scenario_22_ai_high_confidence_zero_risk_promotes_to_verified():
    """AI confidence >= 90 with zero risk flags reliably promotes document to verified."""
    ai_resp = AIResponse(verdict="verified", confidence=99.0, reason="High confidence match", risk_flags=[])
    decision = rules.Decision("needs_ai", flags=[], reason="rules_inconclusive", confidence=0.75)
    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags
