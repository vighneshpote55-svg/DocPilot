"""PHASE 7 — STEP 2: Comprehensive OCR Document Scenario Validation Suite

Validates all 20 realistic synthetic document scenarios:
1. Valid PAN
2. Invalid PAN
3. Valid Aadhaar
4. Invalid Aadhaar
5. Bank Statement
6. Salary Slip/Payslip
7. Passport
8. Voter ID
9. Driving Licence
10. Cancelled Cheque
11. Utility Bill
12. Wrong document uploaded into a required slot
13. Blurry/unreadable document
14. Low OCR confidence
15. OCR service failure
16. Missing required fields
17. Holder/customer name mismatch
18. Expired document
19. Cross-document name mismatch
20. Document requiring AI escalation
"""
from datetime import date, timedelta
from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import select

from app import ai_service, db as dbmod, jobs, models, pipeline, rules, services
from app.ai_service import AIResponse, MockAIProvider, set_ai_provider, reset_ai_provider
from app.masking import create_redacted_evidence
from app.models import Customer, Document, ManualReview
from app.ocr_client import OCRResult, OCRUnavailable, set_ocr_client
from tests.conftest import PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")
CUSTOMER_NAME = "Rajesh Kumar Sharma"
KW = {"min_overall": 0.90, "min_field": 0.80, "min_review": 0.60}


# -----------------------------------------------------------------------------
# Scenario 1: Valid PAN
# -----------------------------------------------------------------------------
def test_scenario_01_valid_pan():
    """Valid PAN with matching holder name deterministically verifies without AI."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.96,
        "field_confidences": {"pan_number": 0.96, "name": 0.95},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["pan_number"] == "XXXX234F"
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_verified()
    assert decision.outcome == "verified"
    assert decision.reason == "rules_passed"


# -----------------------------------------------------------------------------
# Scenario 2: Invalid PAN
# -----------------------------------------------------------------------------
def test_scenario_02_invalid_pan():
    """Invalid PAN structure (bad format or length) routes to manual review; AI cannot override."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "12345INVALID", "name": "RAJESH KUMAR SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert any("invalid_structural_identifier:pan" in f for f in decision.flags)

    # Even high-confidence AI cannot override structural invalidity
    mock_ai = AIResponse(verdict="verified", confidence=99.0, reason="looks ok")
    final_decision = rules.apply_ai(decision, mock_ai)
    assert final_decision.is_manual_review()


# -----------------------------------------------------------------------------
# Scenario 3: Valid Aadhaar
# -----------------------------------------------------------------------------
def test_scenario_03_valid_aadhaar():
    """Valid 12-digit Aadhaar card deterministically verifies with masked evidence."""
    raw = {
        "status": "success",
        "doc_type": "aadhaar",
        "detected_type": "aadhaar",
        "confidence": 0.95,
        "field_confidences": {"aadhaar_number": 0.95, "name": 0.95},
        "extracted_fields": {"aadhaar_number": "987654321012", "name": "RAJESH SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["aadhaar_number"] == "XXXX1012"
    decision = rules.evaluate(evidence, "aadhaar", CUSTOMER_NAME, **KW)
    assert decision.is_verified()
    assert decision.reason == "rules_passed"


# -----------------------------------------------------------------------------
# Scenario 4: Invalid Aadhaar
# -----------------------------------------------------------------------------
def test_scenario_04_invalid_aadhaar():
    """Invalid Aadhaar (non-12 digits or checksum failure) routes to manual review."""
    raw = {
        "status": "success",
        "doc_type": "aadhaar",
        "detected_type": "aadhaar",
        "confidence": 0.95,
        "field_confidences": {"aadhaar_number": 0.95, "name": 0.95},
        "extracted_fields": {"aadhaar_number": "12345", "name": "RAJESH SHARMA"},
        "reason": "invalid_aadhaar_checksum",
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "aadhaar", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert any("invalid_structural_identifier:aadhaar" in f or "ocr_reason:invalid_aadhaar_checksum" in f for f in decision.flags)


# -----------------------------------------------------------------------------
# Scenario 5: Bank Statement
# -----------------------------------------------------------------------------
def test_scenario_05_bank_statement():
    """Valid Bank Statement verifies with masked account number."""
    raw = {
        "status": "success",
        "doc_type": "bank_statement",
        "detected_type": "bank_statement",
        "confidence": 0.94,
        "field_confidences": {"account_number": 0.95, "bank_name": 0.95},
        "extracted_fields": {"account_number": "123456789012", "bank_name": "State Bank of India"},
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["account_number"] == "XXXX9012"
    decision = rules.evaluate(evidence, "bank_statement", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 6: Salary Slip / Payslip
# -----------------------------------------------------------------------------
def test_scenario_06_salary_slip():
    """Valid Salary Slip verifies with employee and employer details."""
    raw = {
        "status": "success",
        "doc_type": "salary_slip",
        "detected_type": "salary_slip",
        "confidence": 0.93,
        "field_confidences": {"employee_name": 0.94, "employer_name": 0.93},
        "extracted_fields": {"employee_name": "RAJESH KUMAR SHARMA", "employer_name": "Infosys Ltd"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "salary_slip", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 7: Passport
# -----------------------------------------------------------------------------
def test_scenario_07_passport():
    """Valid unexpired Passport with holder name verifies deterministically."""
    raw = {
        "status": "success",
        "doc_type": "passport",
        "detected_type": "passport",
        "confidence": 0.96,
        "field_confidences": {"passport_number": 0.97, "name": 0.96},
        "extracted_fields": {
            "passport_number": "A1234567",
            "name": "RAJESH SHARMA",
            "expiry_date": (date.today() + timedelta(days=365)).strftime("%d/%m/%Y"),
        },
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["passport_number"] == "XXXX4567"
    decision = rules.evaluate(evidence, "passport", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 8: Voter ID
# -----------------------------------------------------------------------------
def test_scenario_08_voter_id():
    """Valid Voter ID with EPIC number and matching name auto-verifies."""
    raw = {
        "status": "success",
        "doc_type": "voter",
        "detected_type": "voter",
        "confidence": 0.95,
        "field_confidences": {"epic_number": 0.96, "name": 0.95},
        "extracted_fields": {"epic_number": "XYZ1234567", "name": "RAJESH SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["epic_number"] == "XXXX4567"
    decision = rules.evaluate(evidence, "voter", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 9: Driving Licence
# -----------------------------------------------------------------------------
def test_scenario_09_driving_licence():
    """Valid Driving Licence with DL number and unexpired date auto-verifies."""
    raw = {
        "status": "success",
        "doc_type": "driving_licence",
        "detected_type": "driving_licence",
        "confidence": 0.95,
        "field_confidences": {"licence_number": 0.95, "name": 0.95},
        "extracted_fields": {
            "licence_number": "DL-1420110012345",
            "name": "RAJESH SHARMA",
            "valid_upto": (date.today() + timedelta(days=730)).strftime("%d/%m/%Y"),
        },
    }
    evidence = create_redacted_evidence(raw)
    assert evidence["extracted_fields"]["licence_number"] == "XXXX2345"
    decision = rules.evaluate(evidence, "driving_licence", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 10: Cancelled Cheque
# -----------------------------------------------------------------------------
def test_scenario_10_cancelled_cheque():
    """Valid Cancelled Cheque with account holder and valid IFSC format auto-verifies."""
    raw = {
        "status": "success",
        "doc_type": "cancelled_cheque",
        "detected_type": "cancelled_cheque",
        "confidence": 0.95,
        "field_confidences": {"account_holder": 0.95, "ifsc": 0.95},
        "extracted_fields": {"account_holder": "RAJESH KUMAR SHARMA", "ifsc": "HDFC0001234"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "cancelled_cheque", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 11: Utility Bill
# -----------------------------------------------------------------------------
def test_scenario_11_utility_bill():
    """Valid Utility Bill with consumer number and bill amount auto-verifies."""
    raw = {
        "status": "success",
        "doc_type": "utility_bill",
        "detected_type": "utility_bill",
        "confidence": 0.93,
        "field_confidences": {"consumer_number": 0.94, "bill_amount": 0.93},
        "extracted_fields": {"consumer_number": "1234567890", "bill_amount": "1250.00"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "utility_bill", CUSTOMER_NAME, **KW)
    assert decision.is_verified()


# -----------------------------------------------------------------------------
# Scenario 12: Wrong Document Uploaded into Required Slot
# -----------------------------------------------------------------------------
def test_scenario_12_wrong_document_slot_rejected(client):
    """Uploading a Passport into a required PAN slot strictly rejects the document."""
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": "Slot Test", "email": "slottest@example.com", "required_documents": ["PAN"]})
    consent = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent}", json={"granted": True})
    portal = token_from_outbox("portal")

    class WrongTypeOCR:
        def extract(self, *args, **kwargs):
            return OCRResult(
                status="success",
                doc_type="passport",
                detected_type="passport",
                confidence=0.96,
                extracted_fields={"passport_number": "A1234567", "name": "SLOT TEST"},
            )

    set_ocr_client(WrongTypeOCR())
    client.post(f"/api/portal/{portal}/upload", data={"doc_type": "PAN"}, files={"file": ("passport.png", PNG)})
    jobs.run_all()

    portal_res = client.get(f"/api/portal/{portal}")
    data = portal_res.json()
    assert data["documents"][0]["state"] == "resubmit"
    assert data["case_status"] == "in_progress"


# -----------------------------------------------------------------------------
# Scenario 13: Blurry / Unreadable Document
# -----------------------------------------------------------------------------
def test_scenario_13_blurry_unreadable_document():
    """Blurry unreadable image causing OCR failure routes to manual review with ocr_error flag."""
    raw = {
        "status": "error",
        "doc_type": "pan",
        "confidence": 0.0,
        "reason": "ocr_could_not_read_document",
        "extracted_fields": {},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert "ocr_error" in decision.flags


# -----------------------------------------------------------------------------
# Scenario 14: Low OCR Confidence
# -----------------------------------------------------------------------------
def test_scenario_14_low_ocr_confidence():
    """Overall OCR confidence below minimum review threshold (0.45 < 0.60) routes to manual review."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.45,
        "field_confidences": {"pan_number": 0.45, "name": 0.45},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert "low_confidence" in decision.flags


# -----------------------------------------------------------------------------
# Scenario 15: OCR Service Failure / Timeout
# -----------------------------------------------------------------------------
def test_scenario_15_ocr_service_exhausted_failure():
    """Exhausted OCR retries safely escalate to manual review instead of dropping the document."""
    class FailOCR:
        def extract(self, *args, **kwargs):
            raise OCRUnavailable("OCR network connection timeout")

    with dbmod.session_scope() as s:
        c = models.Customer(name="OCR Fail User", email="ocrfail@example.com", consent_status="granted", case_status="in_progress")
        s.add(c)
        s.flush()
        doc = models.Document(
            customer_id=c.id,
            doc_type="pan",
            filename="doc.png",
            mime="image/png",
            size=1024,
            sha256="dummy_sha256_hash",
            storage_key="test/doc.png",
            file_state="stored",
        )
        s.add(doc)
        s.commit()
        doc_id = doc.id

    with dbmod.session_scope() as s:
        # Emulate job exhaustion callback
        pipeline.on_exhausted_process_document(s, {"document_id": doc_id}, "exhausted")
        s.commit()

    with dbmod.session_scope() as s:
        d = s.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.verification_status == "manual_review"
        rev = s.scalar(select(ManualReview).where(ManualReview.document_id == doc_id))
        assert rev is not None
        assert "ocr_unavailable" in rev.flags


# -----------------------------------------------------------------------------
# Scenario 16: Missing Required Fields
# -----------------------------------------------------------------------------
def test_scenario_16_missing_required_fields():
    """Missing required identifier field (e.g. pan_number is missing) routes to manual review."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"name": 0.95},
        "extracted_fields": {"name": "RAJESH SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert any("missing_fields:pan_number" in f for f in decision.flags)


# -----------------------------------------------------------------------------
# Scenario 17: Holder / Customer Name Mismatch
# -----------------------------------------------------------------------------
def test_scenario_17_holder_name_mismatch():
    """Document holder name does not match registered customer name -> manual review."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.95,
        "field_confidences": {"pan_number": 0.95, "name": 0.95},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "SUNIL GUPTA"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert "holder_name_mismatch" in decision.flags


# -----------------------------------------------------------------------------
# Scenario 18: Expired Document
# -----------------------------------------------------------------------------
def test_scenario_18_expired_document():
    """Document with validity date in the past is flagged as expired."""
    raw = {
        "status": "success",
        "doc_type": "driving_licence",
        "detected_type": "driving_licence",
        "confidence": 0.95,
        "field_confidences": {"licence_number": 0.95, "name": 0.95},
        "extracted_fields": {
            "licence_number": "DL-1420110012345",
            "name": "RAJESH SHARMA",
            "valid_upto": (date.today() - timedelta(days=30)).strftime("%d/%m/%Y"),
        },
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "driving_licence", CUSTOMER_NAME, **KW)
    assert decision.is_manual_review()
    assert "document_expired" in decision.flags


# -----------------------------------------------------------------------------
# Scenario 19: Cross-Document Name Mismatch
# -----------------------------------------------------------------------------
def test_scenario_19_cross_document_name_mismatch():
    """Fuzzy token comparison accepts middle initials/titles but flags cross-person mismatches."""
    assert rules.names_compatible("Rajesh Kumar Sharma", "Rajesh Sharma") is True
    assert rules.names_compatible("Mr Rajesh Sharma", "Rajesh Kumar Sharma") is True
    assert rules.names_compatible("Rajesh Kumar Sharma", "Amit Patel") is False


# -----------------------------------------------------------------------------
# Scenario 20: Document Requiring AI Escalation
# -----------------------------------------------------------------------------
def test_scenario_20_document_ai_escalation():
    """Inconclusive document confidence (0.75) escalates to AI; verifies if AI confidence >= 90."""
    raw = {
        "status": "success",
        "doc_type": "pan",
        "detected_type": "pan",
        "confidence": 0.75,
        "field_confidences": {"pan_number": 0.75, "name": 0.75},
        "extracted_fields": {"pan_number": "ABCPE1234F", "name": "RAJESH SHARMA"},
    }
    evidence = create_redacted_evidence(raw)
    decision = rules.evaluate(evidence, "pan", CUSTOMER_NAME, **KW)
    assert decision.is_ai_required()
    assert decision.outcome == "needs_ai"

    # AI assesses and passes
    ai_resp = AIResponse(verdict="verified", confidence=95.0, reason="Typography and alignment verified")
    final_decision = rules.apply_ai(decision, ai_resp)
    assert final_decision.is_verified()
    assert "ai_verified" in final_decision.flags
