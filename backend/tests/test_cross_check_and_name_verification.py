"""Comprehensive regression test suite for cross-check evaluation, name matching,
and verification across all 22 supported document types in DocPilot.
"""
import pytest
from app.doc_types import (
    CANONICAL,
    DOCS_WITH_PERSONAL_HOLDER_NAME,
    DOCS_WITH_ENTITY_NAME,
)
from app.rules import (
    REQUIRED_FIELDS,
    DecisionState,
    evaluate,
    match_name,
    names_compatible,
    _parse_date,
    _tokens,
    _evaluate_cross_check,
)


# Standard canonical test fixtures for each of the 22 document types
CLEAN_DOC_FIXTURES: dict[str, dict] = {
    "aadhaar": {"aadhaar_number": "987654321012", "name": "Vighnesh Pote"},
    "pan": {"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"},
    "passport": {"passport_number": "A1234567", "name": "Vighnesh Pote"},
    "voter": {"epic_number": "XYZ1234567", "name": "Vighnesh Pote"},
    "driving_licence": {"licence_number": "MH1220150001234", "name": "Vighnesh Pote"},
    "bank_statement": {"account_number": "1234567890", "bank_name": "State Bank of India"},
    "salary_slip": {"employee_name": "Vighnesh Pote", "employer_name": "Acme Technologies"},
    "cancelled_cheque": {"account_holder": "Vighnesh Pote", "ifsc": "SBIN0001234"},
    "itr": {"acknowledgement_number": "123456789012345", "name": "Vighnesh Pote"},
    "udyam": {"udyam_registration_number": "UDYAM-MH-01-0012345", "enterprise_name": "Vighnesh Enterprises"},
    "shop_establishment": {"establishment_name": "Pote Trading", "registration_number": "SEA-123456"},
    "fssai": {"fssai_licence_number": "11521012345678", "business_name": "Pote Foods"},
    "utility_bill": {"consumer_number": "0123456789", "bill_amount": "1450.00"},
    "gst_certificate": {"gstin": "27ABCDE1234F1Z5", "legal_name": "Pote Enterprises"},
    "certificate_of_incorporation": {"cin": "U12345MH2020PTC123456", "company_name": "DocPilot Solutions Pvt Ltd"},
    "partnership_deed": {"firm_name": "Pote & Associates"},
    "rent_agreement": {"monthly_rent": "25000"},
    "form_16": {"employer_name": "Acme Corp", "pan_number": "ABCPE1234F", "employee_name": "Vighnesh Pote"},
    "bank_passbook": {"bank_name": "HDFC Bank", "ifsc": "HDFC0001234", "account_holder": "Vighnesh Pote"},
    "property_tax_receipt": {"property_id": "PMC-12345-67", "tax_amount_paid": "4500"},
    "iec_certificate": {"iec_number": "0123456789", "entity_name": "Pote Global Exports"},
    "income_certificate": {"certificate_number": "INC/2026/1234", "annual_income": "600000", "name": "Vighnesh Pote"},
}


class TestAll22DocumentTypesVerification:
    """Audit that all 22 supported document types evaluate cleanly when valid."""

    @pytest.mark.parametrize("doc_type", list(CANONICAL.keys()))
    def test_clean_extraction_auto_verifies_all_22_doc_types(self, doc_type):
        fields = CLEAN_DOC_FIXTURES[doc_type]
        ocr_res = {
            "status": "success",
            "confidence": 0.96,
            "doc_type": doc_type,
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }

        decision = evaluate(
            ocr_res,
            doc_type,
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )

        assert decision.outcome == DecisionState.VERIFIED, (
            f"Doc type '{doc_type}' failed verification with flags: {decision.flags}, reason: {decision.reason}"
        )
        assert len(decision.flags) == 0


class TestCrossCheckDefensiveEvaluation:
    """Verify cross_check handles unextracted fields vs actual mismatches without false positives."""

    def test_missing_field_in_cross_check_does_not_fail(self):
        """When OCR cross_check reports field_not_found_in_document, do not flag cross_check_failed."""
        cc_payload = {
            "name": {
                "expected": "Vighnesh Pote",
                "extracted": None,
                "matched": False,
                "score": 0.0,
                "reason": "field_not_found_in_document",
            }
        }
        flags = _evaluate_cross_check(cc_payload, {}, "Vighnesh Pote")
        assert flags == [], f"Expected zero flags for missing field in cross_check, got: {flags}"

    def test_bank_statement_with_field_not_found_verifies_cleanly(self):
        """Real-world scenario: Bank statement with RapidOCR returning field_not_found_in_document."""
        fields = {"account_number": "6049286565", "bank_name": "State Bank of India"}
        ocr_res = {
            "status": "success",
            "confidence": 0.98,
            "doc_type": "bank_statement",
            "extracted_fields": fields,
            "field_confidences": {"account_number": 0.98, "bank_name": 0.97},
            "cross_check": {
                "name": {
                    "expected": "Vighnesh Pote",
                    "extracted": None,
                    "matched": False,
                    "score": 0.0,
                    "reason": "field_not_found_in_document",
                }
            },
        }
        decision = evaluate(
            ocr_res,
            "bank_statement",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.VERIFIED
        assert "cross_check_failed" not in decision.flags

    def test_fssai_certificate_with_unmatched_person_name_verifies_cleanly(self):
        """FSSAI business document with OCR returning field_not_found_in_document for customer name."""
        fields = {
            "fssai_licence_number": "11521012345678",
            "business_name": "Pote Agro Foods",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.97,
            "doc_type": "fssai",
            "extracted_fields": fields,
            "field_confidences": {"fssai_licence_number": 0.95, "business_name": 0.95},
            "cross_check": {
                "name": {
                    "expected": "Vighnesh Pote",
                    "extracted": None,
                    "matched": False,
                    "score": 0.0,
                    "reason": "field_not_found_in_document",
                }
            },
        }
        decision = evaluate(
            ocr_res,
            "fssai",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.VERIFIED
        assert "cross_check_failed" not in decision.flags

    def test_actual_name_mismatch_in_cross_check_emits_holder_name_mismatch(self):
        """When an actual name mismatch occurs, emit holder_name_mismatch, not generic cross_check_failed."""
        cc_payload = {
            "name": {
                "expected": "Vighnesh Pote",
                "extracted": "Rohit Verma",
                "matched": False,
                "score": 0.15,
                "reason": "name_mismatch",
            }
        }
        flags = _evaluate_cross_check(cc_payload, {"name": "Rohit Verma"}, "Vighnesh Pote")
        assert "holder_name_mismatch" in flags
        assert "cross_check_failed" in flags

    def test_non_name_cross_check_failure_emits_cross_check_failed(self):
        """Discrepancy in non-name cross-checked data correctly produces cross_check_failed."""
        cc_payload = {
            "dob": {
                "expected": "15/08/1985",
                "extracted": "01/01/2000",
                "matched": False,
                "reason": "dob_mismatch",
            }
        }
        flags = _evaluate_cross_check(cc_payload, {}, "Vighnesh Pote")
        assert "cross_check_failed" in flags


class TestIndianNameMatchingConventions:
    """Audit Indian naming conventions: initials, middle names, reversals, honorifics."""

    @pytest.mark.parametrize("customer,doc_name", [
        ("Vighnesh Pote", "V. Pote"),                      # Initial first name
        ("Vighnesh Pote", "V Pote"),                        # Initial without dot
        ("Vighnesh Pote", "Pote Vighnesh"),                 # Last name first
        ("Vighnesh Pote", "Pote V."),                       # Last name first with initial
        ("Vighnesh Pote", "Vighnesh Suresh Pote"),          # Middle name on document
        ("Vighnesh Suresh Pote", "Vighnesh Pote"),          # Middle name omitted on document
        ("Vighnesh Pote", "Adv. Vighnesh Pote"),            # Professional title Advocate
        ("Vighnesh Pote", "Dr. Vighnesh Pote"),             # Title Doctor
        ("Vighnesh Pote", "CA Vighnesh Pote"),              # Title Chartered Accountant
        ("Vighnesh Pote", "Shri Vighnesh Pote"),            # Honorific Shri
        ("Vighnesh Pote", "Mr. Vighnesh Pote"),             # Title Mr
        ("Rohit Kumar Verma", "Rohit K Verma"),             # Middle initial
        ("Vighnesh", "Vighnesh"),                           # Single name exact
    ])
    def test_name_variants_match(self, customer, doc_name):
        res = match_name(customer, doc_name)
        assert res["match"] is True, f"Expected match between '{customer}' and '{doc_name}'"
        assert names_compatible(customer, doc_name) is True

    @pytest.mark.parametrize("customer,doc_name", [
        ("Vighnesh Pote", "Rohit Sharma"),                 # Completely different
        ("Vikram Sharma", "Rohit Sharma"),                 # Same surname, different first name
        ("Rahul Verma", "Suresh Verma"),                   # Same surname, conflicting first name
        ("Vighnesh Pote", "Pote Anand"),                   # Conflicting first name
    ])
    def test_conflicting_names_fail(self, customer, doc_name):
        res = match_name(customer, doc_name)
        assert res["match"] is False, f"Expected mismatch between '{customer}' and '{doc_name}'"
        assert names_compatible(customer, doc_name) is False


class TestDateParsingAndNormalization:
    """Verify various date formats are parsed accurately for expiry checking."""

    @pytest.mark.parametrize("date_str", [
        "15/08/2030",
        "15-08-2030",
        "2030-08-15",
        "2030/08/15",
        "15.08.2030",
        "2030.08.15",
        "15 Aug 2030",
        "15-Aug-2030",
        "15th August 2030",
        "2030-08-15T00:00:00Z",
    ])
    def test_valid_future_dates_parsed(self, date_str):
        d = _parse_date(date_str)
        assert d is not None
        assert d.year == 2030
        assert d.month == 8
        assert d.day == 15

    def test_expired_date_triggers_flag(self):
        fields = {
            "licence_number": "MH1220150001234",
            "name": "Vighnesh Pote",
            "expiry_date": "01/01/2020",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "driving_licence",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "driving_licence",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "document_expired" in decision.flags
        assert decision.outcome == DecisionState.MANUAL_REVIEW


class TestFieldAliasesAndRequiredFields:
    """Verify common extractor field aliases are recognized."""

    def test_driving_licence_with_dl_number_alias(self):
        fields = {"license_number": "MH1220150001234", "name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "driving_licence",
            "extracted_fields": fields,
            "field_confidences": {"license_number": 0.95, "name": 0.95},
        }
        decision = evaluate(
            ocr_res,
            "driving_licence",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.VERIFIED
        assert "missing_fields:licence_number" not in decision.flags

    def test_missing_mandatory_field_still_flags_review(self):
        # PAN missing PAN number
        fields = {"name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {"name": 0.95},
        }
        decision = evaluate(
            ocr_res,
            "pan",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert any(f.startswith("missing_fields:pan_number") for f in decision.flags)
        assert decision.outcome == DecisionState.MANUAL_REVIEW


class TestDocTypeCategorizationCoverage:
    """Verify all 22 document types are categorized into personal vs entity sets."""

    def test_all_22_canonical_types_categorized(self):
        all_canonical = set(CANONICAL.keys())
        categorized = DOCS_WITH_PERSONAL_HOLDER_NAME | DOCS_WITH_ENTITY_NAME
        assert all_canonical == categorized, (
            f"Uncategorized doc types: {all_canonical - categorized}"
        )
