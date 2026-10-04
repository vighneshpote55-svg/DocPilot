import time
"""Smoke test for DocPilot end-to-end service layer, Supabase Storage, and OCR.

Usage:
    python -m scripts.smoke_test
"""
import io
import os
import sys
from pathlib import Path

# Ensure backend root is on python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw

from sqlalchemy import delete, select

from app import jobs, services
from app.config import get_settings
from app.db import init_db, session_scope
from app.models import AccessToken, Customer, Document, ManualReview, OcrResult, RequiredDocument
from app.security import decrypt
from app.storage import delete_file, get_file, get_storage


def generate_dummy_pan_image(name: str = "VIKRAM SHARMA", pan_number: str = "ABCPE1234F") -> bytes:
    """Generate a synthetic dummy PAN card image for testing."""
    img = Image.new("RGB", (700, 450), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((50, 30), "INCOME TAX DEPARTMENT", fill=(0, 0, 0))
    draw.text((50, 60), "GOVT. OF INDIA", fill=(0, 0, 0))
    draw.text((50, 110), "Permanent Account Number Card", fill=(0, 0, 0))
    draw.text((50, 160), f"Name: {name.upper()}", fill=(0, 0, 0))
    draw.text((50, 200), "Father's Name: DUMMY FATHER", fill=(0, 0, 0))
    draw.text((50, 240), "Date of Birth: 15/08/1985", fill=(0, 0, 0))
    draw.text((50, 290), f"PAN: {pan_number}", fill=(0, 0, 0))

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def run_smoke_test(mock_ocr: bool = False):
    settings = get_settings()
    init_db()

    print("==================================================")
    print("           DOCPILOT SMOKE TEST (PHASE B1)         ")
    print("==================================================")
    print(f"Storage Backend : {settings.storage_backend}")
    print(f"OCR URL         : {settings.ocr_url} {'(MOCKED)' if mock_ocr else '(LIVE)'}")
    print("==================================================\n")

    if mock_ocr:
        from unittest.mock import MagicMock
        from app.ocr_client import OCRResult
        import app.ocr_client

        mock_client = MagicMock()
        def _mock_extract(data, filename, mime, slot, expected=None):
            # PAN image always identifies as PAN
            return OCRResult(
                status="success",
                doc_type="pan",
                confidence=0.96,
                field_confidences={"name": 0.95, "pan_number": 0.95},
                extracted_fields={"name": "VIKRAM SHARMA", "pan_number": "ABCPE1234F"},
                reason=None,
            )
        mock_client.extract.side_effect = _mock_extract
        app.ocr_client._client = mock_client


    dummy_name = "VIKRAM SHARMA"
    dummy_email = "dummy-smoke-test@example.com"
    dummy_pan_bytes = generate_dummy_pan_image(name=dummy_name, pan_number="ABCPE1234F")

    customer_id = None
    pan_storage_key = None
    aadhaar_storage_key = None

    try:
        # Step 1: Create dummy customer
        print("[Step 1] Creating dummy customer directly through service layer...")
        with session_scope() as db:
            customer = services.create_customer(
                db,
                name=dummy_name,
                email=dummy_email,
                mobile=None,
                required=["pan", "aadhaar"],
                actor="smoke_test",
            )
            customer_id = customer.id
            print(f" -> Customer created: ID={customer_id}, Status={customer.case_status}")

            # Step 2: Record consent
            print("[Step 2] Recording consent...")
            services.record_consent(db, customer, granted=True)
            print(f" -> Consent recorded: Status={customer.consent_status}, CaseStatus={customer.case_status}")

        # Step 3: Upload generated dummy PAN image into PAN slot
        print("\n[Step 3] Uploading dummy PAN image into 'pan' slot...")
        with session_scope() as db:
            customer = db.get(Customer, customer_id)
            pan_doc = services.accept_upload(db, customer, "pan", "dummy_pan.png", dummy_pan_bytes)
            pan_storage_key = pan_doc.storage_key
            pan_doc_id = pan_doc.id
            print(f" -> Upload accepted: Document ID={pan_doc_id}, StorageKey={pan_storage_key}")

        # Step 4: Verify encrypted object in Supabase Storage and roundtrip decryption
        print("\n[Step 4] Verifying encryption & Supabase Storage...")
        storage_impl = get_storage()
        raw_ciphertext = storage_impl.get(pan_storage_key)
        print(f" -> Retrieved raw ciphertext: {len(raw_ciphertext)} bytes (begins with 12-byte AES nonce)")
        assert raw_ciphertext != dummy_pan_bytes, "Error: Storage content is not encrypted!"

        decrypted_bytes = get_file(pan_storage_key)
        assert decrypted_bytes == dummy_pan_bytes, "Error: Decrypted bytes do not match original plaintext!"
        print(" -> Decryption verified: Decrypted object matches original image bytes exactly!")

        # Step 5: Run worker once against OCR service
        print("\n[Step 5] Running worker once against OCR service...")
        for _ in range(30):
            with session_scope() as db:
                doc = db.get(Document, pan_doc_id)
                if doc and doc.ocr_status == "completed":
                    break
            jobs.run_one()
            time.sleep(0.5)

        # Inspect outcome of PAN verification
        with session_scope() as db:
            doc = db.get(Document, pan_doc_id)
            print(f" -> PAN OCR status          : {doc.ocr_status}")
            print(f" -> PAN Verification status  : {doc.verification_status}")
            print(f" -> Confidence               : {doc.confidence}")
            print(f" -> Flags                    : {doc.flags}")
            print(f" -> Reason                   : {doc.reason}")

            assert doc.ocr_status == "completed", f"Expected ocr_status='completed', got {doc.ocr_status}"
            assert doc.verification_status == "verified", f"Expected verification_status='verified', got {doc.verification_status}"
            print(" -> SUCCESS: Dummy PAN was automatically verified by rules!")

            # Verify pending list shrunk
            cust = db.get(Customer, customer_id)
            pending = services.pending_keys(db, customer_id)
            print(f" -> Remaining pending slots  : {pending} (expected ['aadhaar'])")
            assert pending == ["aadhaar"], f"Expected ['aadhaar'] pending, got {pending}"

        # Step 6: Upload the SAME PAN image into the 'aadhaar' slot
        print("\n[Step 6] Uploading same PAN image into 'aadhaar' slot...")
        with session_scope() as db:
            customer = db.get(Customer, customer_id)
            aadhaar_doc = services.accept_upload(db, customer, "aadhaar", "dummy_aadhaar.png", dummy_pan_bytes)
            aadhaar_storage_key = aadhaar_doc.storage_key
            aadhaar_doc_id = aadhaar_doc.id
            print(f" -> Upload accepted: Document ID={aadhaar_doc_id}, StorageKey={aadhaar_storage_key}")

        # Step 7: Run worker once for the Aadhaar slot
        print("\n[Step 7] Running worker once for 'aadhaar' slot...")
        job_ran = False
        for _ in range(30):
            with session_scope() as db:
                doc = db.get(Document, aadhaar_doc_id)
                if doc and doc.ocr_status == "completed":
                    job_ran = True
                    break
            if jobs.run_one():
                job_ran = True
            time.sleep(0.5)
        print(f" -> Worker job execution result: {job_ran}")

        # Inspect outcome of wrong document type
        with session_scope() as db:
            doc = db.get(Document, aadhaar_doc_id)
            assert job_ran or (doc and doc.ocr_status == "completed"), "Expected second 'process_document' job to run or be completed!"
            print(f" -> Aadhaar OCR status          : {doc.ocr_status}")
            print(f" -> Aadhaar Verification status  : {doc.verification_status}")
            print(f" -> Flags                        : {doc.flags}")
            print(f" -> Reason                       : {doc.reason}")

            assert doc.ocr_status == "completed", f"Expected ocr_status='completed', got {doc.ocr_status}"
            assert doc.verification_status == "rejected", f"Expected verification_status='rejected', got {doc.verification_status}"
            assert "wrong_document_type" in doc.flags, f"Expected 'wrong_document_type' flag, got {doc.flags}"
            print(" -> SUCCESS: Wrong document type (PAN into Aadhaar slot) was correctly rejected!")

        print("\n==================================================")
        print("       ALL SMOKE TEST ASSERTIONS PASSED!          ")
        print("==================================================")

    finally:
        if customer_id:
            with session_scope() as db:
                customer = db.get(Customer, customer_id)
                if customer:
                    services.delete_customer_files(db, customer)
                    db.execute(delete(AccessToken).where(AccessToken.customer_id == customer_id))
                    db.execute(delete(RequiredDocument).where(RequiredDocument.customer_id == customer_id))
                    doc_ids = list(db.execute(select(Document.id).where(Document.customer_id == customer_id)).scalars().all())
                    if doc_ids:
                        db.execute(delete(OcrResult).where(OcrResult.document_id.in_(doc_ids)))
                        db.execute(delete(ManualReview).where(ManualReview.document_id.in_(doc_ids)))
                    db.execute(delete(Document).where(Document.customer_id == customer_id))
                    db.delete(customer)
                print(f" -> Cleaned up customer data and records for ID={customer_id}")

        print("[Cleanup] Completed.")


if __name__ == "__main__":
    mock_mode = "--mock-ocr" in sys.argv or os.environ.get("MOCK_OCR", "").lower() in ("1", "true")
    run_smoke_test(mock_ocr=mock_mode)
