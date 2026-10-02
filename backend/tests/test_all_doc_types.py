"""Tests for all 13 document types: 1 passing and 1 failing/review test per type.

Verifies:
1. REQUIRED_FIELDS evaluation
2. Name matching where applicable
3. Expiry and demo markers
4. OCR reason codes (not relying on confidence alone)
5. Type mapping (e.g. voter -> voter_id)
"""
import pytest
from app.doc_types import OCR_TYPE_NAMES, canonical_key
from app.ocr_client import OCRResult
from app.rules import evaluate

KW = dict(min_overall=0.90, min_field=0.80)
CUSTOMER_NAME = "Rajesh Kumar Sharma"


def mk_res(doc_type: str, fields: dict, conf: float = 0.95, field_confs: dict | None = None,
           reason: str | None = None, cross_check: dict | None = None) -> OCRResult:
    f_confs = {k: 0.95 for k in fields}
    if field_confs:
        f_confs.update(field_confs)
    return OCRResult(
        status="success" if not reason else "low_confidence",
        doc_type=doc_type,
        confidence=conf,
        field_confidences=f_confs,
        extracted_fields=fields,
        reason=reason,
        cross_check=cross_check,
    )


# ------------------------------------------------------------------ 1. Aadhaar
def test_aadhaar_pass():
    r = mk_res("aadhaar", {"aadhaar_number": "123456789012", "name": "Rajesh Sharma"})
    d = evaluate(r, "aadhaar", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_aadhaar_fail_invalid_checksum():
    r = mk_res("aadhaar", {"aadhaar_number": "123456789012", "name": "Rajesh Sharma"},
               conf=0.95, reason="invalid_aadhaar_checksum")
    d = evaluate(r, "aadhaar", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "ocr_reason:invalid_aadhaar_checksum" in d.flags


# ------------------------------------------------------------------ 2. PAN
def test_pan_pass():
    r = mk_res("pan", {"pan_number": "ABCPE1234F", "name": "Rajesh Sharma"})
    d = evaluate(r, "pan", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_pan_fail_invalid_entity_type():
    r = mk_res("pan", {"pan_number": "ABCDE1234F", "name": "Rajesh Sharma"},
               conf=0.95, reason="invalid_pan_entity_type_D")
    d = evaluate(r, "pan", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "ocr_reason:invalid_pan_entity_type_D" in d.flags


# ------------------------------------------------------------------ 3. Passport
def test_passport_pass():
    r = mk_res("passport", {"passport_number": "Z1234567", "name": "Rajesh Sharma", "expiry_date": "01/01/2035"})
    d = evaluate(r, "passport", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_passport_fail_expired():
    r = mk_res("passport", {"passport_number": "Z1234567", "name": "Rajesh Sharma", "expiry_date": "01/01/2020"})
    d = evaluate(r, "passport", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "document_expired" in d.flags


# ------------------------------------------------------------------ 4. Voter ID
def test_voter_pass():
    # OCR service returns voter_id, DocPilot slot is voter
    r = mk_res("voter_id", {"epic_number": "ABC1234567", "name": "Rajesh Sharma"})
    d = evaluate(r, "voter", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_voter_fail_missing_epic():
    r = mk_res("voter_id", {"name": "Rajesh Sharma"})
    d = evaluate(r, "voter", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:epic_number" in d.flags


# ------------------------------------------------------------------ 5. Driving Licence
def test_driving_licence_pass():
    r = mk_res("driving_licence", {"licence_number": "DL1420110012345", "name": "Rajesh Sharma", "valid_till": "01/01/2035"})
    d = evaluate(r, "driving_licence", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_driving_licence_fail_expired():
    r = mk_res("driving_licence", {"licence_number": "DL1420110012345", "name": "Rajesh Sharma", "valid_till": "01/01/2021"})
    d = evaluate(r, "driving_licence", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "document_expired" in d.flags


# ------------------------------------------------------------------ 6. Bank Statement
def test_bank_statement_pass():
    r = mk_res("bank_statement", {"account_number": "123456789012", "bank_name": "HDFC Bank", "account_holder": "Rajesh Sharma"})
    d = evaluate(r, "bank_statement", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_bank_statement_fail_low_field_confidence():
    r = mk_res("bank_statement", {"account_number": "123456789012", "bank_name": "HDFC Bank", "account_holder": "Rajesh Sharma"},
               field_confs={"account_number": 0.45})
    d = evaluate(r, "bank_statement", CUSTOMER_NAME, **KW)
    assert "low_field_confidence:account_number" in d.flags
    assert d.outcome in ("needs_ai", "manual_review")


# ------------------------------------------------------------------ 7. Salary Slip
def test_salary_slip_pass():
    r = mk_res("salary_slip", {"employee_name": "Rajesh Sharma", "employer_name": "Acme Tech Solutions", "net_pay": "65000"})
    d = evaluate(r, "salary_slip", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_salary_slip_fail_name_mismatch():
    r = mk_res("salary_slip", {"employee_name": "Vikram Sethi", "employer_name": "Acme Tech Solutions"})
    d = evaluate(r, "salary_slip", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "holder_name_mismatch" in d.flags


# ------------------------------------------------------------------ 8. Cancelled Cheque
def test_cancelled_cheque_pass():
    r = mk_res("cancelled_cheque", {"account_holder": "Rajesh Sharma", "ifsc": "HDFC0001234"})
    d = evaluate(r, "cancelled_cheque", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_cancelled_cheque_fail_invalid_ifsc():
    r = mk_res("cancelled_cheque", {"account_holder": "Rajesh Sharma", "ifsc": "INVALID_IFSC"},
               reason="invalid_ifsc_format")
    d = evaluate(r, "cancelled_cheque", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "ocr_reason:invalid_ifsc_format" in d.flags


# ------------------------------------------------------------------ 9. ITR
def test_itr_pass():
    r = mk_res("itr", {"acknowledgement_number": "123456789012345", "name": "Rajesh Sharma"})
    d = evaluate(r, "itr", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_itr_fail_missing_ack():
    r = mk_res("itr", {"name": "Rajesh Sharma"})
    d = evaluate(r, "itr", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:acknowledgement_number" in d.flags


# ------------------------------------------------------------------ 10. Udyam
def test_udyam_pass():
    r = mk_res("udyam", {"udyam_registration_number": "UDYAM-MH-01-0012345", "enterprise_name": "Sharma Logistics"})
    d = evaluate(r, "udyam", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_udyam_fail_missing_number():
    r = mk_res("udyam", {"enterprise_name": "Sharma Logistics"})
    d = evaluate(r, "udyam", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:udyam_registration_number" in d.flags


# ------------------------------------------------------------------ 11. Shop & Establishment
def test_shop_establishment_pass():
    r = mk_res("shop_establishment", {"registration_number": "REG-12345", "establishment_name": "Sharma Enterprises"})
    d = evaluate(r, "shop_establishment", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_shop_establishment_fail_demo_document():
    r = mk_res("shop_establishment", {"registration_number": "REG-12345", "establishment_name": "Sharma Enterprises",
                                       "note": "SYNTHETIC DEMO DOCUMENT"})
    d = evaluate(r, "shop_establishment", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "demo_or_non_official_document" in d.flags


# ------------------------------------------------------------------ 12. FSSAI
def test_fssai_pass():
    r = mk_res("fssai", {"fssai_licence_number": "10012011000123", "business_name": "Sharma Foods", "valid_till": "01/01/2030"})
    d = evaluate(r, "fssai", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_fssai_fail_expired():
    r = mk_res("fssai", {"fssai_licence_number": "10012011000123", "business_name": "Sharma Foods", "valid_till": "01/01/2021"})
    d = evaluate(r, "fssai", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "document_expired" in d.flags


# ------------------------------------------------------------------ 13. Utility Bill
def test_utility_bill_pass():
    r = mk_res("utility_bill", {"consumer_number": "100234567", "bill_amount": "1250.00"})
    d = evaluate(r, "utility_bill", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_utility_bill_fail_missing_consumer_number():
    r = mk_res("utility_bill", {"bill_amount": "1250.00"})
    d = evaluate(r, "utility_bill", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:consumer_number" in d.flags


# ------------------------------------------------------------------ 14. GST Certificate
def test_gst_certificate_pass():
    r = mk_res("gst_certificate", {"gstin": "27ABCDE1234F1Z5", "legal_name": "Sharma Enterprises Pvt Ltd"})
    d = evaluate(r, "gst_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_gst_certificate_fail_missing_gstin():
    r = mk_res("gst_certificate", {"legal_name": "Sharma Enterprises Pvt Ltd"})
    d = evaluate(r, "gst_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:gstin" in d.flags


# ------------------------------------------------------------------ 15. Certificate of Incorporation
def test_certificate_of_incorporation_pass():
    r = mk_res("certificate_of_incorporation", {"cin": "U72900MH2025PTC123456", "company_name": "Sharma Tech Solutions Pvt Ltd"})
    d = evaluate(r, "certificate_of_incorporation", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_certificate_of_incorporation_fail_missing_cin():
    r = mk_res("certificate_of_incorporation", {"company_name": "Sharma Tech Solutions Pvt Ltd"})
    d = evaluate(r, "certificate_of_incorporation", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:cin" in d.flags


# ------------------------------------------------------------------ 16. Partnership Deed
def test_partnership_deed_pass():
    r = mk_res("partnership_deed", {"firm_name": "Sharma & Associates"})
    d = evaluate(r, "partnership_deed", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_partnership_deed_fail_missing_firm():
    r = mk_res("partnership_deed", {})
    d = evaluate(r, "partnership_deed", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:firm_name" in d.flags


# ------------------------------------------------------------------ 17. Rent Agreement
def test_rent_agreement_pass():
    r = mk_res("rent_agreement", {"monthly_rent": "25000", "lessor_name_masked": "R. K****"})
    d = evaluate(r, "rent_agreement", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_rent_agreement_fail_missing_rent():
    r = mk_res("rent_agreement", {"lessor_name_masked": "R. K****"})
    d = evaluate(r, "rent_agreement", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:monthly_rent" in d.flags


# ------------------------------------------------------------------ 18. Form 16
def test_form_16_pass():
    r = mk_res("form_16", {"employer_name": "Tech Corp Pvt Ltd", "pan_number": "ABCPE1234F"})
    d = evaluate(r, "form_16", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_form_16_fail_missing_employer():
    r = mk_res("form_16", {"pan_number": "ABCPE1234F"})
    d = evaluate(r, "form_16", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:employer_name" in d.flags


# ------------------------------------------------------------------ 19. Bank Passbook
def test_bank_passbook_pass():
    r = mk_res("bank_passbook", {"bank_name": "State Bank of India", "ifsc": "SBIN0001234"})
    d = evaluate(r, "bank_passbook", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_bank_passbook_fail_invalid_ifsc():
    r = mk_res("bank_passbook", {"bank_name": "State Bank of India", "ifsc": "INVALID001"},
               conf=0.95, reason="invalid_ifsc_format")
    d = evaluate(r, "bank_passbook", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "ocr_reason:invalid_ifsc_format" in d.flags


# ------------------------------------------------------------------ 20. Property Tax Receipt
def test_property_tax_receipt_pass():
    r = mk_res("property_tax_receipt", {"property_id": "PID-12345678", "tax_amount_paid": "5000.00"})
    d = evaluate(r, "property_tax_receipt", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_property_tax_receipt_fail_missing_id():
    r = mk_res("property_tax_receipt", {"tax_amount_paid": "5000.00"})
    d = evaluate(r, "property_tax_receipt", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:property_id" in d.flags


# ------------------------------------------------------------------ 21. IEC Certificate
def test_iec_certificate_pass():
    r = mk_res("iec_certificate", {"iec_number": "0123456789", "entity_name": "Sharma Global Exports"})
    d = evaluate(r, "iec_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_iec_certificate_fail_missing_iec():
    r = mk_res("iec_certificate", {"entity_name": "Sharma Global Exports"})
    d = evaluate(r, "iec_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:iec_number" in d.flags


# ------------------------------------------------------------------ 22. Income Certificate
def test_income_certificate_pass():
    r = mk_res("income_certificate", {"certificate_number": "MH-INC-2025-123456", "annual_income": "250000"})
    d = evaluate(r, "income_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "verified"


def test_income_certificate_fail_missing_number():
    r = mk_res("income_certificate", {"annual_income": "250000"})
    d = evaluate(r, "income_certificate", CUSTOMER_NAME, **KW)
    assert d.outcome == "manual_review"
    assert "missing_fields:certificate_number" in d.flags


# ------------------------------------------------------------------ Type Mismatch Rejections
def test_wrong_type_rejected_by_slot():
    r = mk_res("pan", {"pan_number": "ABCPE1234F", "name": "Rajesh Sharma"})
    d = evaluate(r, "aadhaar", CUSTOMER_NAME, **KW)
    assert d.outcome == "rejected"
    assert "wrong_document_type" in d.flags


def test_wrong_type_rejected_by_reason_code():
    r = mk_res("aadhaar", {}, conf=0.0, reason="doc_type_mismatch")
    d = evaluate(r, "aadhaar", CUSTOMER_NAME, **KW)
    assert d.outcome == "rejected"
    assert "wrong_document_type" in d.flags
