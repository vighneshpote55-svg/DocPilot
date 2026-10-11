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
        assert flags[0] == "holder_name_mismatch"  # Primary flag rendered in Admin UI table

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


class TestUnsupportedDocTypeFailSafe:
    """Verify unrecognized or unsupported document types fail safely rather than auto-verifying."""

    def test_unsupported_slot_rejected_with_unsupported_flag(self):
        fields = {"some_field": "some_value"}
        ocr_res = {
            "status": "success",
            "confidence": 0.99,
            "doc_type": "random_fake_slot",
            "extracted_fields": fields,
            "field_confidences": {"some_field": 0.99},
        }
        decision = evaluate(
            ocr_res,
            "random_fake_slot",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.REJECTED
        assert "unsupported_document_type" in decision.flags
        assert decision.reason == "unsupported_document_type"

    def test_alias_slot_resolves_to_canonical(self):
        # "voter_id" is an alias for "voter"
        fields = {"epic_number": "ABC1234567", "name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "voter_id",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "voter_id",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.VERIFIED
        assert "unsupported_document_type" not in decision.flags


class TestCommercialEntityNameMatchingIsolation:
    """Verify commercial/entity documents do not mistakenly flag holder_name_mismatch on business names."""

    def test_fssai_with_company_name_does_not_trigger_holder_name_mismatch(self):
        fields = {
            "fssai_licence_number": "10012011000123",
            "business_name": "Pote Agro Industries Pvt Ltd",
            "name": "Pote Agro Industries Pvt Ltd",
            "valid_till": "01/01/2030",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "fssai",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "fssai",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "holder_name_mismatch" not in decision.flags
        assert decision.outcome == DecisionState.VERIFIED

    def test_gst_certificate_with_legal_name_does_not_trigger_holder_name_mismatch(self):
        fields = {
            "gstin": "27ABCDE1234F1Z5",
            "legal_name": "Apex Trading Solutions Ltd",
            "name": "Apex Trading Solutions Ltd",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "gst_certificate",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "gst_certificate",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "holder_name_mismatch" not in decision.flags
        assert decision.outcome == DecisionState.VERIFIED

    def test_coi_with_company_name_does_not_trigger_holder_name_mismatch(self):
        fields = {
            "cin": "U72900MH2025PTC123456",
            "company_name": "Blue Horizon Software Private Limited",
            "name": "Blue Horizon Software Private Limited",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "certificate_of_incorporation",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "certificate_of_incorporation",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "holder_name_mismatch" not in decision.flags
        assert decision.outcome == DecisionState.VERIFIED

    def test_udyam_with_enterprise_name_does_not_trigger_holder_name_mismatch(self):
        fields = {
            "udyam_registration_number": "UDYAM-MH-01-0012345",
            "enterprise_name": "Western Precision Tools",
            "name": "Western Precision Tools",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "udyam",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "udyam",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "holder_name_mismatch" not in decision.flags
        assert decision.outcome == DecisionState.VERIFIED

    def test_personal_pan_with_mismatched_name_triggers_holder_name_mismatch(self):
        # Contrasted with personal documents where name mismatch MUST trigger review
        fields = {
            "pan_number": "ABCPE1234F",
            "name": "Apex Trading Solutions",
        }
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
        }
        decision = evaluate(
            ocr_res,
            "pan",
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert "holder_name_mismatch" in decision.flags
        assert decision.outcome == DecisionState.MANUAL_REVIEW


class TestStructuralIdentifierValidations:
    """Verify structural identifier validations for PAN, Aadhaar, IFSC, GSTIN, FSSAI, CIN, Udyam."""

    def test_gstin_valid_and_invalid(self):
        # Valid GSTIN
        fields_valid = {"gstin": "27ABCDE1234F1Z5", "legal_name": "Test Entity"}
        res_valid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_valid, "field_confidences": {k: 0.95 for k in fields_valid}}
        d_valid = evaluate(res_valid, "gst_certificate", "Test Entity", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:gstin" not in d_valid.flags
        assert d_valid.outcome == DecisionState.VERIFIED

        # Invalid GSTIN
        fields_invalid = {"gstin": "INVALID_GSTIN_123", "legal_name": "Test Entity"}
        res_invalid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_invalid, "field_confidences": {k: 0.95 for k in fields_invalid}}
        d_invalid = evaluate(res_invalid, "gst_certificate", "Test Entity", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:gstin" in d_invalid.flags
        assert d_invalid.outcome == DecisionState.MANUAL_REVIEW

    def test_fssai_valid_and_invalid(self):
        # Valid FSSAI (14 digits)
        fields_valid = {"fssai_licence_number": "10012011000123", "business_name": "Food Enterprise", "valid_till": "01/01/2030"}
        res_valid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_valid, "field_confidences": {k: 0.95 for k in fields_valid}}
        d_valid = evaluate(res_valid, "fssai", "Food Enterprise", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:fssai" not in d_valid.flags
        assert d_valid.outcome == DecisionState.VERIFIED

        # Invalid FSSAI (less than 14 digits)
        fields_invalid = {"fssai_licence_number": "12345", "business_name": "Food Enterprise", "valid_till": "01/01/2030"}
        res_invalid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_invalid, "field_confidences": {k: 0.95 for k in fields_invalid}}
        d_invalid = evaluate(res_invalid, "fssai", "Food Enterprise", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:fssai" in d_invalid.flags
        assert d_invalid.outcome == DecisionState.MANUAL_REVIEW

    def test_cin_valid_and_invalid(self):
        # Valid CIN (21 chars)
        fields_valid = {"cin": "U72900MH2025PTC123456", "company_name": "Test Tech Corp"}
        res_valid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_valid, "field_confidences": {k: 0.95 for k in fields_valid}}
        d_valid = evaluate(res_valid, "certificate_of_incorporation", "Test Tech Corp", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:cin" not in d_valid.flags
        assert d_valid.outcome == DecisionState.VERIFIED

        # Invalid CIN
        fields_invalid = {"cin": "INVALID_CIN", "company_name": "Test Tech Corp"}
        res_invalid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_invalid, "field_confidences": {k: 0.95 for k in fields_invalid}}
        d_invalid = evaluate(res_invalid, "certificate_of_incorporation", "Test Tech Corp", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:cin" in d_invalid.flags
        assert d_invalid.outcome == DecisionState.MANUAL_REVIEW

    def test_udyam_valid_and_invalid(self):
        # Valid Udyam
        fields_valid = {"udyam_registration_number": "UDYAM-MH-01-0012345", "enterprise_name": "Precision Tools"}
        res_valid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_valid, "field_confidences": {k: 0.95 for k in fields_valid}}
        d_valid = evaluate(res_valid, "udyam", "Precision Tools", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:udyam" not in d_valid.flags
        assert d_valid.outcome == DecisionState.VERIFIED

        # Invalid Udyam
        fields_invalid = {"udyam_registration_number": "UDYAM-12345", "enterprise_name": "Precision Tools"}
        res_invalid = {"status": "success", "confidence": 0.95, "extracted_fields": fields_invalid, "field_confidences": {k: 0.95 for k in fields_invalid}}
        d_invalid = evaluate(res_invalid, "udyam", "Precision Tools", min_overall=0.90, min_field=0.80)
        assert "invalid_structural_identifier:udyam" in d_invalid.flags
        assert d_invalid.outcome == DecisionState.MANUAL_REVIEW


class TestAll22DocTypesSyntheticMatrix:
    """Verify all 22 document types pass with valid synthetic fields and fail with missing fields."""

    @pytest.mark.parametrize("doc_type", list(CANONICAL.keys()))
    def test_doc_type_passes_with_valid_synthetic_data(self, doc_type):
        valid_fields = {
            "aadhaar": {"aadhaar_number": "123456789012", "name": "Vighnesh Pote"},
            "pan": {"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"},
            "passport": {"passport_number": "Z1234567", "name": "Vighnesh Pote", "expiry_date": "01/01/2035"},
            "voter": {"epic_number": "ABC1234567", "name": "Vighnesh Pote"},
            "driving_licence": {"licence_number": "MH1220150001234", "name": "Vighnesh Pote", "valid_till": "01/01/2035"},
            "bank_statement": {"account_number": "123456789012", "bank_name": "HDFC Bank", "account_holder": "Vighnesh Pote"},
            "salary_slip": {"employee_name": "Vighnesh Pote", "employer_name": "DocPilot Tech", "net_pay": "75000"},
            "cancelled_cheque": {"account_holder": "Vighnesh Pote", "ifsc": "HDFC0001234"},
            "itr": {"acknowledgement_number": "123456789012345", "name": "Vighnesh Pote"},
            "udyam": {"udyam_registration_number": "UDYAM-MH-01-0012345", "enterprise_name": "DocPilot Solutions"},
            "shop_establishment": {"registration_number": "REG-12345", "establishment_name": "DocPilot Tech Hub"},
            "fssai": {"fssai_licence_number": "10012011000123", "business_name": "DocPilot Kitchens", "valid_till": "01/01/2030"},
            "utility_bill": {"consumer_number": "100234567", "bill_amount": "1250.00"},
            "gst_certificate": {"gstin": "27ABCDE1234F1Z5", "legal_name": "DocPilot Technologies Pvt Ltd"},
            "certificate_of_incorporation": {"cin": "U72900MH2025PTC123456", "company_name": "DocPilot Technologies Private Limited"},
            "partnership_deed": {"firm_name": "DocPilot & Partners"},
            "rent_agreement": {"monthly_rent": "30000"},
            "form_16": {"employer_name": "DocPilot Technologies", "pan_number": "ABCPE1234F"},
            "bank_passbook": {"bank_name": "State Bank of India", "ifsc": "SBIN0001234"},
            "property_tax_receipt": {"property_id": "PID-12345678", "tax_amount_paid": "4500.00"},
            "iec_certificate": {"iec_number": "0123456789", "entity_name": "DocPilot Exports"},
            "income_certificate": {"certificate_number": "MH-INC-2025-123456", "annual_income": "350000", "applicant_name": "Vighnesh Pote"},
        }
        fields = valid_fields[doc_type]
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
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

    @pytest.mark.parametrize("doc_type", list(CANONICAL.keys()))
    def test_doc_type_flags_missing_required_fields(self, doc_type):
        # Empty extracted fields must trigger missing_fields
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": doc_type,
            "extracted_fields": {},
            "field_confidences": {},
        }
        decision = evaluate(
            ocr_res,
            doc_type,
            customer_name="Vighnesh Pote",
            min_overall=0.90,
            min_field=0.80,
        )
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert any(f.startswith("missing_fields:") for f in decision.flags)


class TestFlagPrioritizationHierarchy:
    """Verify specific diagnostic root causes precede generic flags in flags list and decision reason."""

    def test_missing_fields_precedes_generic_cross_check_failed(self):
        # Bank statement missing account number with cross check mismatch
        fields = {"bank_name": "HDFC Bank"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "bank_statement",
            "extracted_fields": fields,
            "field_confidences": {"bank_name": 0.95},
            "cross_check": {"dob": {"matched": False, "reason": "dob_mismatch"}},
        }
        decision = evaluate(ocr_res, "bank_statement", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        # Root cause must be first
        assert decision.flags[0] == "missing_fields:account_number"
        assert "cross_check_failed" in decision.flags
        assert decision.flags.index("missing_fields:account_number") < decision.flags.index("cross_check_failed")
        # Decision reason must lead with root cause
        assert decision.reason.startswith("missing_fields:account_number")

    def test_document_expired_precedes_generic_cross_check_failed(self):
        fields = {"licence_number": "MH1220150001234", "name": "Vighnesh Pote", "valid_till": "01/01/2020"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "driving_licence",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
            "cross_check": {"dob": {"matched": False, "reason": "dob_mismatch"}},
        }
        decision = evaluate(ocr_res, "driving_licence", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert decision.flags[0] == "document_expired"
        assert decision.flags.index("document_expired") < decision.flags.index("cross_check_failed")
        assert decision.reason.startswith("document_expired")

    def test_invalid_structural_identifier_precedes_generic_cross_check_failed(self):
        fields = {"pan_number": "INVALID_PAN_FORMAT", "name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
            "cross_check": {"dob": {"matched": False, "reason": "dob_mismatch"}},
        }
        decision = evaluate(ocr_res, "pan", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert decision.flags[0] == "invalid_structural_identifier:pan"
        assert decision.flags.index("invalid_structural_identifier:pan") < decision.flags.index("cross_check_failed")

    def test_holder_name_mismatch_precedes_generic_cross_check_failed(self):
        fields = {"pan_number": "ABCPE1234F", "name": "Suresh Gupta"}
        ocr_res = {
            "status": "success",
            "confidence": 0.95,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {k: 0.95 for k in fields},
            "cross_check": {"name": {"matched": False, "reason": "name_mismatch"}},
        }
        decision = evaluate(ocr_res, "pan", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert decision.flags[0] == "holder_name_mismatch"
        assert decision.flags.index("holder_name_mismatch") < decision.flags.index("cross_check_failed")


class TestHardFailuresCannotAutoVerify:
    """Verify that hard failures can never be auto-approved even with 100% confidence."""

    @pytest.mark.parametrize("flag_scenario", [
        {"name": "Suresh Gupta", "pan_number": "ABCPE1234F"},  # Name mismatch
        {"name": "Vighnesh Pote", "pan_number": "INVALID_PAN"},  # Structural invalid
        {"name": "Vighnesh Pote", "pan_number": "ABCPE1234F", "note": "SYNTHETIC DEMO"},  # Demo marker
    ])
    def test_hard_pan_failure_never_verifies(self, flag_scenario):
        ocr_res = {
            "status": "success",
            "confidence": 1.0,
            "doc_type": "pan",
            "extracted_fields": flag_scenario,
            "field_confidences": {k: 1.0 for k in flag_scenario},
        }
        decision = evaluate(ocr_res, "pan", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome != DecisionState.VERIFIED
        assert decision.outcome in (DecisionState.MANUAL_REVIEW, DecisionState.REJECTED)

    def test_expired_document_never_verifies_with_perfect_confidence(self):
        fields = {"passport_number": "Z1234567", "name": "Vighnesh Pote", "expiry_date": "01/01/2020"}
        ocr_res = {
            "status": "success",
            "confidence": 1.0,
            "doc_type": "passport",
            "extracted_fields": fields,
            "field_confidences": {k: 1.0 for k in fields},
        }
        decision = evaluate(ocr_res, "passport", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert "document_expired" in decision.flags

    def test_unsupported_slot_strictly_rejected(self):
        ocr_res = {
            "status": "success",
            "confidence": 1.0,
            "doc_type": "unsupported_slot_name",
            "extracted_fields": {"any_key": "any_val"},
            "field_confidences": {"any_key": 1.0},
        }
        decision = evaluate(ocr_res, "unsupported_slot_name", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        assert decision.outcome == DecisionState.REJECTED
        assert "unsupported_document_type" in decision.flags


class TestInconclusiveCasesEnterManualReview:
    """Verify that ambiguous cases enter manual review with clear diagnostic reasons."""

    def test_inconclusive_confidence_routes_to_ai_required_or_manual_review(self):
        # Clean fields, but overall confidence is 0.85 (below 0.90 threshold, above 0.60 manual review limit)
        fields = {"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.85,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {k: 0.85 for k in fields},
        }
        decision = evaluate(ocr_res, "pan", "Vighnesh Pote", min_overall=0.90, min_field=0.80)
        # Without AI, borderline rules are inconclusive
        assert decision.outcome == DecisionState.AI_REQUIRED
        assert decision.reason == "rules_inconclusive"

    def test_low_confidence_below_minimum_review_threshold_routes_to_manual_review(self):
        # Confidence 0.50 (below min_review=0.60)
        fields = {"pan_number": "ABCPE1234F", "name": "Vighnesh Pote"}
        ocr_res = {
            "status": "success",
            "confidence": 0.50,
            "doc_type": "pan",
            "extracted_fields": fields,
            "field_confidences": {k: 0.50 for k in fields},
        }
        decision = evaluate(ocr_res, "pan", "Vighnesh Pote", min_overall=0.90, min_field=0.80, min_review=0.60)
        assert decision.outcome == DecisionState.MANUAL_REVIEW
        assert "low_confidence" in decision.flags


