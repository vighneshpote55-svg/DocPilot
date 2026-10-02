import io
import json
import logging
from datetime import date, timedelta
from app.logging_conf import PiiSanitizingFilter, StructuredJsonFormatter, sanitize_text
from app.masking import (
    create_redacted_evidence,
    detect_pii,
    mask_fields,
    mask_text,
)
from app.ocr_client import OCRResult
from app.rules import evaluate
from app.storage import get_file, put_file


# -----------------------------------------------------------------------------
# 1. PAN Masking Tests
# -----------------------------------------------------------------------------
def test_pan_masking():
    # String pattern masking
    text = "Customer PAN is ABCDE1234F and company PAN is XYZPK9876Z"
    masked = mask_text(text)
    assert "1234" not in masked
    assert "9876" not in masked
    assert "ABC****F" in masked
    assert "XYZ****Z" in masked

    # Structured dictionary masking
    data = {
        "pan_number": "ABCDE1234F",
        "nested": {"pan": "XYZPK9876Z"}
    }
    m_dict = mask_fields(data)
    assert m_dict["pan_number"].startswith("XXXX")
    assert "1234" not in m_dict["pan_number"] or m_dict["pan_number"] == "XXXX234F"
    assert "ABCDE" not in m_dict["pan_number"]
    assert m_dict["nested"]["pan"].startswith("XXXX")


# -----------------------------------------------------------------------------
# 2. Aadhaar Masking Tests
# -----------------------------------------------------------------------------
def test_aadhaar_masking():
    # Aadhaar with spaces
    spaced = "UIDAI: 4793 3788 8508 valid"
    m_spaced = mask_text(spaced)
    assert "4793" not in m_spaced
    assert "3788" not in m_spaced
    assert "XXXX XXXX 8508" in m_spaced

    # Aadhaar without spaces
    unspaced = "Aadhaar number 479337888508 on card"
    m_unspaced = mask_text(unspaced)
    assert "4793" not in m_unspaced
    assert "XXXX XXXX 8508" in m_unspaced

    # Structured dictionary masking
    data = {
        "aadhaar_number": "4793 3788 8508",
        "uidai": "479337888508"
    }
    m_dict = mask_fields(data)
    assert m_dict["aadhaar_number"] == "XXXX8508"
    assert "4793" not in m_dict["aadhaar_number"]


# -----------------------------------------------------------------------------
# 3. Account-Number Masking Tests
# -----------------------------------------------------------------------------
def test_account_number_masking():
    # Text with Account prefix
    raw_text = "Primary Account: 123456789012 and A/C NO: 98765432101234"
    m_text = mask_text(raw_text)
    assert "123456789012" not in m_text
    assert "98765432101234" not in m_text
    assert "XXXX9012" in m_text
    assert "XXXX1234" in m_text

    # Structured dictionary masking
    acc_data = {
        "account_number": "123456789012",
        "bank_account": "98765432101234",
        "acc_no": "555566667777"
    }
    m_acc = mask_fields(acc_data)
    assert m_acc["account_number"] == "XXXX9012"
    assert m_acc["bank_account"] == "XXXX1234"
    assert m_acc["acc_no"] == "XXXX7777"


# -----------------------------------------------------------------------------
# 4. PII Detection Tests
# -----------------------------------------------------------------------------
def test_pii_detection():
    data = {
        "pan_number": "ABCDE1234F",
        "aadhaar_number": "4793 3788 8508",
        "account_number": "ACCOUNT NO: 123456789012",
        "phone": "+91 9876543210",
        "email": "customer@example.com",
        "dob": "DOB: 15/08/1990",
        "name": "RAJESH SHARMA"
    }
    pii = detect_pii(data)
    assert "pan" in pii
    assert "aadhaar" in pii
    assert "account_number" in pii
    assert "phone" in pii
    assert "email" in pii
    assert "dob" in pii


# -----------------------------------------------------------------------------
# 5. Redacted Evidence Generation Tests
# -----------------------------------------------------------------------------
def test_redacted_evidence_generation():
    ocr_res = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.97,
        field_confidences={"pan_number": 0.99, "name": 0.98, "dob": 0.95},
        extracted_fields={
            "pan_number": "ABCDE1234F",
            "name": "RAJESH SHARMA",
            "dob": "15/08/1990",
            "father_name": "RAMESH SHARMA",
        },
        raw_text="INCOME TAX DEPARTMENT GOVT OF INDIA\nPAN: ABCDE1234F\nNAME: RAJESH SHARMA\nDOB: 15/08/1990",
        cross_check={"status": "matched"},
        qr_disagreements=[]
    )

    evidence = create_redacted_evidence(ocr_res)

    # Standardized schema check
    assert evidence["status"] == "success"
    assert evidence["doc_type"] == "pan"
    assert evidence["detected_type"] == "pan"
    assert evidence["confidence"] == 0.97
    assert evidence["field_confidences"] == {"pan_number": 0.99, "name": 0.98, "dob": 0.95}

    # Operational data preserved for rules and review
    assert evidence["extracted_fields"]["name"] == "RAJESH SHARMA"

    # Sensitive fields masked
    assert "ABCDE1234F" not in json.dumps(evidence)
    assert "ABCDE" not in evidence["extracted_fields"]["pan_number"]
    assert evidence["extracted_fields"]["pan_number"].startswith("XXXX")
    assert evidence["extracted_fields"]["dob"] == "[MASKED]"

    # PII metadata recorded
    assert "pan" in evidence["pii_detected"]
    assert "dob" in evidence["pii_detected"]


# -----------------------------------------------------------------------------
# 6. PII Not Appearing In Logs Tests
# -----------------------------------------------------------------------------
def test_pii_not_appearing_in_logs():
    # Test sanitize_text
    log_msg = (
        "Processing user document with PAN ABCDE1234F, "
        "Aadhaar 4793 3788 8508, "
        "Account ACCOUNT NO: 123456789012, "
        "phone 9876543210, and email secret.user@domain.com"
    )
    clean_msg = sanitize_text(log_msg)

    assert "ABCDE1234F" not in clean_msg
    assert "4793 3788 8508" not in clean_msg
    assert "123456789012" not in clean_msg
    assert "secret.user@domain.com" not in clean_msg
    assert "9876543210" not in clean_msg

    # Test PiiSanitizingFilter & StructuredJsonFormatter
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(StructuredJsonFormatter())
    handler.addFilter(PiiSanitizingFilter())

    logger = logging.getLogger("test_pii_logger")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)

    logger.info(
        "Processing job for PAN %s and Aadhaar %s",
        "ABCDE1234F",
        "4793 3788 8508",
        extra={
            "account_number": "123456789012",
            "bank_account": "9876543210",
            "customer_id": "cust_123"
        }
    )

    log_output = stream.getvalue()
    assert "ABCDE1234F" not in log_output
    assert "4793 3788 8508" not in log_output
    assert "123456789012" not in log_output
    assert "9876543210" not in log_output
    assert "cust_123" in log_output  # Safe metadata remains intact


# -----------------------------------------------------------------------------
# 7. Original Document Remaining Protected In Storage Tests
# -----------------------------------------------------------------------------
def test_original_document_remaining_protected(env, tmp_path):
    secret_raw_pdf = b"%PDF-1.4 CONFIDENTIAL RAW AADHAAR 4793 3788 8508 NAME RAJESH SHARMA"
    storage_key = "confidential.pdf"
    put_file(storage_key, secret_raw_pdf)

    # The file on disk must exist in local storage dir and contain encrypted ciphertext, not plaintext
    store_dir = tmp_path / "store"
    disk_file = store_dir / storage_key
    assert disk_file.exists()

    # Reading the disk file directly must NOT reveal raw plaintext
    raw_disk_bytes = disk_file.read_bytes()
    assert secret_raw_pdf not in raw_disk_bytes
    assert b"CONFIDENTIAL" not in raw_disk_bytes
    assert b"4793 3788 8508" not in raw_disk_bytes
    assert b"RAJESH SHARMA" not in raw_disk_bytes

    # Reading via authorized storage API successfully decrypts
    retrieved_bytes = get_file(storage_key)
    assert retrieved_bytes == secret_raw_pdf


# -----------------------------------------------------------------------------
# 8. Rules Engine Compatibility With Redacted Evidence Tests
# -----------------------------------------------------------------------------
def test_rules_engine_compatibility_with_redacted_evidence():
    # Create OCR result with high confidence
    ocr_res = OCRResult(
        status="success",
        doc_type="pan",
        detected_type="pan",
        confidence=0.95,
        field_confidences={"pan_number": 0.95, "name": 0.96},
        extracted_fields={"pan_number": "ABCDE1234F", "name": "RAJESH SHARMA"},
        cross_check=None,
        qr_disagreements=[]
    )

    # Generate redacted evidence
    redacted = create_redacted_evidence(ocr_res)
    assert redacted["extracted_fields"]["pan_number"].startswith("XXXX")

    # Rules engine evaluates redacted evidence directly
    decision = evaluate(redacted, "pan", "Rajesh Sharma", min_overall=0.8, min_field=0.7)
    assert decision.outcome == "verified"
    assert decision.reason == "rules_passed"

    # Rules engine rejects mismatch on redacted evidence
    decision_mismatch = evaluate(redacted, "pan", "Vikram Malhotra", min_overall=0.8, min_field=0.7)
    assert decision_mismatch.outcome == "manual_review"
    assert "holder_name_mismatch" in decision_mismatch.flags

    # Rules engine handles expiry check on redacted evidence
    expired_res = OCRResult(
        status="success",
        doc_type="driving_licence",
        detected_type="driving_licence",
        confidence=0.92,
        field_confidences={"licence_number": 0.90, "name": 0.90, "valid_until": 0.90},
        extracted_fields={
            "licence_number": "DL-1234567890123",
            "name": "RAJESH SHARMA",
            "valid_until": (date.today() - timedelta(days=30)).strftime("%d/%m/%Y")
        }
    )
    redacted_expired = create_redacted_evidence(expired_res)
    d_expired = evaluate(redacted_expired, "driving_licence", "Rajesh Sharma", min_overall=0.8, min_field=0.7)
    assert "document_expired" in d_expired.flags
    assert d_expired.outcome == "manual_review"
