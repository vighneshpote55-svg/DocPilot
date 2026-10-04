from app.doc_types import canonical_key, family
from app.masking import mask_fields, mask_text
from app.ocr_client import OCRResult
from app.rules import apply_ai, evaluate, names_compatible

KW = dict(min_overall=0.90, min_field=0.80)


def test_family_normalises_spellings():
    assert family("PAN Card") == "pan" and family("pan") == "pan"
    assert family("Adhar card") == "aadhaar" and family("Aadhaar") == "aadhaar"
    assert family("Salary Slip / Payslip") == "salary_slip"
    assert family("Shop & Establishment Certificate") == "shop_establishment"
    assert canonical_key("shop_establishment") == "shop_establishment"
    assert canonical_key("random thing") is None


def test_mask_text_patterns():
    out = mask_text("Aadhaar 4793 3788 8508 PAN ABCPE1234F phone 9665856368 a@b.com DOB: 15/08/1990")
    assert "8508" in out and "4793" not in out
    assert "ABC****F" in out and "1234" not in out
    assert "9665856368" not in out and "a@b.com" not in out and "15/08/1990" not in out


def test_mask_fields_by_key_keeps_names():
    f = mask_fields({"pan_number": "ABCPE1234F", "name": "RAJESH SHARMA", "dob": "15/08/1990",
                     "account_number": "123456789012", "account_holder_name": "RAJESH SHARMA",
                     "email": "x@y.com", "nested": {"mobile": "9876543210"}})
    assert f["name"] == "RAJESH SHARMA" and f["account_holder_name"] == "RAJESH SHARMA"
    assert f["pan_number"] == "XXXX234F" or f["pan_number"].startswith("XXXX")
    assert f["dob"] == "[MASKED]" and f["email"] == "[MASKED]" and f["nested"]["mobile"] == "[MASKED]"
    assert f["account_number"] == "XXXX9012"


def test_names_compatible():
    assert names_compatible("Rajesh Kumar Sharma", "RAJESH SHARMA")
    assert not names_compatible("Rajesh Kumar Sharma", "Amit Verma")
    assert names_compatible("Rajesh", "Rajesh Sharma")


def good_pan():
    return OCRResult(status="success", doc_type="pan", confidence=0.97,
                     field_confidences={"pan_number": 0.95, "name": 0.95},
                     extracted_fields={"pan_number": "ABCPE1234F", "name": "RAJESH KUMAR SHARMA"})


def test_clean_document_verifies_without_ai():
    d = evaluate(good_pan(), "pan", "Rajesh Sharma", **KW)
    assert d.outcome == "verified"


def test_wrong_document_is_rejected():
    r = good_pan()
    r.doc_type = "aadhaar"
    assert evaluate(r, "pan", "Rajesh Sharma", **KW).outcome == "rejected"


def test_name_mismatch_goes_to_manual_review():
    d = evaluate(good_pan(), "pan", "Amit Verma", **KW)
    assert d.outcome == "manual_review" and "holder_name_mismatch" in d.flags


def test_ocr_reason_blocks_auto_verify_even_with_high_confidence():
    r = good_pan()
    r.status, r.reason = "low_confidence", "invalid_pan_entity_type_D"
    d = evaluate(r, "pan", "Rajesh Sharma", **KW)
    assert d.outcome == "manual_review" and any(f.startswith("ocr_reason:") for f in d.flags)


def test_missing_required_field_goes_to_manual_review():
    r = good_pan()
    r.extracted_fields["pan_number"] = ""
    assert evaluate(r, "pan", "Rajesh Sharma", **KW).outcome == "manual_review"


def test_expired_and_demo_flags():
    r = OCRResult(status="success", doc_type="passport", confidence=0.99,
                  extracted_fields={"name": "Rajesh Sharma", "expiry_date": "01/01/2020"})
    assert "document_expired" in evaluate(r, "passport", "Rajesh Sharma", **KW).flags
    r2 = OCRResult(status="success", doc_type="passport", confidence=0.99,
                   extracted_fields={"name": "Rajesh Sharma", "note": "SYNTHETIC DEMO"})
    assert "demo_or_non_official_document" in evaluate(r2, "passport", "Rajesh Sharma", **KW).flags


def test_cross_check_failure_flag():
    r = good_pan()
    r.cross_check = {"name": {"match": False}}
    assert "cross_check_failed" in evaluate(r, "pan", "Rajesh Sharma", **KW).flags


def test_inconclusive_needs_ai_then_falls_back_to_human_without_ai():
    r = good_pan()
    r.status, r.confidence = "low_confidence", 0.80
    d = evaluate(r, "pan", "Rajesh Sharma", **KW)
    assert d.outcome == "needs_ai"
    assert apply_ai(d, None).outcome == "manual_review"
    assert apply_ai(d, {"verdict": "verified", "confidence": 95, "reason": "ok"}).outcome == "verified"
    assert apply_ai(d, {"verdict": "verified", "confidence": 60}).outcome == "manual_review"


# ------------------------------------------------------------------ Async OCR Queue & Polling
from unittest.mock import patch, MagicMock
from app.ocr_client import HTTPOCRClient, OCRUnavailable


def test_http_ocr_client_handles_202_and_polls():
    client = HTTPOCRClient()

    post_resp = MagicMock()
    post_resp.status_code = 202
    post_resp.json.return_value = {"job_id": "test-job-123", "poll_url": "/ocr/jobs/test-job-123"}

    poll_pending = MagicMock()
    poll_pending.status_code = 200
    poll_pending.json.return_value = {"status": "pending", "job_id": "test-job-123"}

    poll_completed = MagicMock()
    poll_completed.status_code = 200
    poll_completed.json.return_value = {
        "status": "completed",
        "job_id": "test-job-123",
        "result": {
            "status": "success",
            "doc_type": "bank_statement",
            "confidence": 0.98,
            "extracted_fields": {"bank_name": "HDFC", "account_number": "1234567890"},
        },
    }

    with patch("httpx.post", return_value=post_resp), \
         patch("httpx.get", side_effect=[poll_pending, poll_completed]):
        res = client.extract(b"dummy_bytes", "stmt.pdf", "application/pdf", "bank_statement")
        assert res.status == "success"
        assert res.doc_type == "bank_statement"
        assert res.extracted_fields["bank_name"] == "HDFC"


def test_http_ocr_client_multi_page_pdf_detection():
    client = HTTPOCRClient()

    # Generate synthetic 6-page PDF byte content with /Type /Page markers
    pdf_bytes = b"%PDF-1.4\n" + b"/Type /Page\n" * 6 + b"%%EOF"

    post_resp = MagicMock()
    post_resp.status_code = 200
    post_resp.json.return_value = {"status": "success", "doc_type": "bank_statement", "confidence": 0.95}

    with patch("httpx.post", return_value=post_resp) as mock_post:
        res = client.extract(pdf_bytes, "multipage.pdf", "application/pdf", "bank_statement")
        assert res.status == "success"
        # Verify params did NOT force sync=true due to heavy document detection
        call_kwargs = mock_post.call_args.kwargs
        assert call_kwargs.get("params") == {}


def test_ocr_contract_customer_id_propagation():
    client = HTTPOCRClient()
    post_resp = MagicMock()
    post_resp.status_code = 200
    post_resp.json.return_value = {"status": "success", "doc_type": "pan", "confidence": 0.95}

    with patch("httpx.post", return_value=post_resp) as mock_post:
        res = client.extract(
            b"dummy_bytes", "pan.png", "image/png", "pan",
            expected={"name": "Vikram Sharma"}, customer_id=42
        )
        assert res.status == "success"
        call_kwargs = mock_post.call_args.kwargs
        form_data = call_kwargs.get("data")
        assert form_data is not None
        assert form_data.get("customer_id") == "42"
        assert "Vikram Sharma" in form_data.get("expected")


def test_ocr_contract_qr_disagreement_and_detected_type():
    res = OCRResult(
        status="success",
        doc_type="aadhaar",
        detected_type="pan",
        confidence=0.95,
        field_confidences={"aadhaar_number": 0.95, "name": 0.95},
        extracted_fields={"aadhaar_number": "123456789012", "name": "Vikram Sharma"},
        qr_disagreements=[{"field": "name", "ocr_value": "Vikram Sharma", "qr_value": "V. Sharma"}],
        message="QR code content slightly disagreed with OCR text",
    )
    assert res.detected_type == "pan"
    assert len(res.qr_disagreements) == 1
    assert res.message is not None

    decision = evaluate(res, "aadhaar", "Vikram Sharma", min_overall=0.90, min_field=0.80)
    assert "qr_disagreement" in decision.flags
    assert "wrong_document_type" in decision.flags
    assert decision.outcome in ("rejected", "manual_review")
