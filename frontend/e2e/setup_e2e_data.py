"""
Setup E2E Test Fixtures for Playwright Acceptance Tests (SPEC Section 8)
Generates:
- dummy_pan.png asset
- Test database rows and access tokens
- test_fixtures.json with tokens and IDs
"""
import io
import json
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Add backend directory to sys.path
backend_dir = Path(__file__).resolve().parent.parent.parent / "backend"
sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv
load_dotenv(backend_dir / ".env")

from PIL import Image, ImageDraw
import jwt

from app.config import get_settings
from app.db import init_db, session_scope
from app.models import AccessToken, Customer, Document, ManualReview, RequiredDocument
from app.security import hash_token, new_token


def generate_dummy_pan_file(dest_path: Path):
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (700, 450), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((50, 30), "INCOME TAX DEPARTMENT", fill=(0, 0, 0))
    draw.text((50, 60), "GOVT. OF INDIA", fill=(0, 0, 0))
    draw.text((50, 110), "Permanent Account Number Card", fill=(0, 0, 0))
    draw.text((50, 160), "Name: VIKRAM SHARMA", fill=(0, 0, 0))
    draw.text((50, 200), "Father's Name: DUMMY FATHER", fill=(0, 0, 0))
    draw.text((50, 240), "Date of Birth: 15/08/1985", fill=(0, 0, 0))
    draw.text((50, 290), "PAN: ABCPE1234F", fill=(0, 0, 0))
    img.save(str(dest_path), format="PNG")
    print(f"Generated dummy PAN file at {dest_path}")


def setup_all_fixtures():
    init_db()
    settings = get_settings()

    fixtures_dir = Path(__file__).resolve().parent
    assets_dir = fixtures_dir / "assets"
    pan_path = assets_dir / "dummy_pan.png"
    generate_dummy_pan_file(pan_path)

    fixtures = {
        "pan_image_path": str(pan_path),
        "admin_jwt": "",
        "item1_pan_token": "",
        "item1_customer_id": 0,
        "item2_aadhaar_token": "",
        "item2_customer_id": 0,
        "item3_partial_token": "",
        "item3_customer_id": 0,
        "item4_expired_token": "expired_token_" + uuid.uuid4().hex[:8],
        "item4_unknown_token": "unknown_token_" + uuid.uuid4().hex[:8],
        "item6_customer_id": 0,
        "item6_review_id": "",
        "item6_reject_customer_id": 0,
        "item6_reject_review_id": "",
        "item7_customer_id": 0,
        "item7_doc_id": "",
    }


    # Generate admin JWT
    admin_email = settings.admin_email_list[0] if settings.admin_email_list else "admin@docpilot.test"
    token_payload = {
        "sub": "admin-test-e2e-user",
        "email": admin_email,
        "aud": "authenticated",
        "role": "authenticated"
    }
    jwt_secret = settings.supabase_jwt_secret or "test-secret"
    mock_jwt = jwt.encode(token_payload, jwt_secret, algorithm="HS256")
    fixtures["admin_jwt"] = mock_jwt

    with session_scope() as db:
        # --- Item 1: Auto-verify PAN ---
        c1 = Customer(
            name="VIKRAM SHARMA",
            email=f"vikram_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543211",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c1)
        db.flush()
        db.add(RequiredDocument(customer_id=c1.id, doc_type="pan"))

        tok1_raw = new_token()
        db.add(AccessToken(
            customer_id=c1.id,
            purpose="upload",
            token_hash=hash_token(tok1_raw),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=72)
        ))
        fixtures["item1_pan_token"] = tok1_raw
        fixtures["item1_customer_id"] = c1.id

        # --- Item 2: PAN into Aadhaar Slot (mismatch / resubmit) ---
        c2 = Customer(
            name="VIKRAM SHARMA",
            email=f"vikram2_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543212",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c2)
        db.flush()
        db.add(RequiredDocument(customer_id=c2.id, doc_type="aadhaar"))

        tok2_raw = new_token()
        db.add(AccessToken(
            customer_id=c2.id,
            purpose="upload",
            token_hash=hash_token(tok2_raw),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=72)
        ))
        fixtures["item2_aadhaar_token"] = tok2_raw
        fixtures["item2_customer_id"] = c2.id

        # --- Item 3: Partial Uploads (PAN + Aadhaar) ---
        c3 = Customer(
            name="VIKRAM SHARMA",
            email=f"vikram3_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543213",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c3)
        db.flush()
        db.add(RequiredDocument(customer_id=c3.id, doc_type="pan"))
        db.add(RequiredDocument(customer_id=c3.id, doc_type="salary_slip"))

        tok3_raw = new_token()
        db.add(AccessToken(
            customer_id=c3.id,
            purpose="upload",
            token_hash=hash_token(tok3_raw),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=72)
        ))
        fixtures["item3_partial_token"] = tok3_raw
        fixtures["item3_customer_id"] = c3.id

        # --- Item 6: Manual Review Queue ---
        c6 = Customer(
            name="ANITA VERMA",
            email=f"anita_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543216",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c6)
        db.flush()
        req6 = RequiredDocument(customer_id=c6.id, doc_type="pan")
        db.add(req6)

        d6 = Document(
            customer_id=c6.id,
            doc_type="pan",
            filename="anita_pan_card.jpg",
            mime="image/jpeg",
            size=2048,
            sha256="dummy_sha256_anita",
            storage_key=f"cases/{c6.id}/pan/anita_pan.jpg.enc",
            ocr_status="completed",
            verification_status="manual_review",
            file_state="stored",
            flags=["name_mismatch"],
            reason="Customer name 'ANITA VERMA' slightly differs from extracted 'ANITA S VERMA'"
        )
        db.add(d6)
        db.flush()

        rev6 = ManualReview(
            document_id=d6.id,
            customer_id=c6.id,
            reason="Customer name slightly differs from extracted PAN name",
            flags=["name_mismatch"],
            status="open"
        )
        db.add(rev6)
        db.flush()
        fixtures["item6_customer_id"] = c6.id
        fixtures["item6_review_id"] = rev6.id

        # Item 6b: Manual Review Queue for Reject
        c6_rej = Customer(
            name="RAHUL KHANNA",
            email=f"rahul_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543218",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c6_rej)
        db.flush()
        req6_rej = RequiredDocument(customer_id=c6_rej.id, doc_type="pan")
        db.add(req6_rej)

        d6_rej = Document(
            customer_id=c6_rej.id,
            doc_type="pan",
            filename="rahul_blurry_pan.jpg",
            mime="image/jpeg",
            size=2048,
            sha256="dummy_sha256_rahul",
            storage_key=f"cases/{c6_rej.id}/pan/rahul_pan.jpg.enc",
            ocr_status="completed",
            verification_status="manual_review",
            file_state="stored",
            flags=["low_field_confidence:pan_number"],
            reason="PAN number illegible"
        )
        db.add(d6_rej)
        db.flush()

        rev6_rej = ManualReview(
            document_id=d6_rej.id,
            customer_id=c6_rej.id,
            reason="PAN number illegible or corrupted",
            flags=["low_field_confidence:pan_number"],
            status="open"
        )
        db.add(rev6_rej)
        db.flush()
        fixtures["item6_reject_customer_id"] = c6_rej.id
        fixtures["item6_reject_review_id"] = rev6_rej.id

        # --- Item 7: Retention & File Deleted ---

        c7 = Customer(
            name="DELETED FILE TEST",
            email=f"del_{uuid.uuid4().hex[:6]}@example.com",
            mobile="+919876543217",
            case_status="in_progress",
            consent_status="granted"
        )
        db.add(c7)
        db.flush()
        db.add(RequiredDocument(customer_id=c7.id, doc_type="pan"))

        d7 = Document(
            customer_id=c7.id,
            doc_type="pan",
            filename="purged_document.pdf",
            mime="application/pdf",
            size=4096,
            sha256="",
            storage_key="",
            ocr_status="completed",
            verification_status="verified",
            file_state="deleted",
            flags=[]
        )
        db.add(d7)
        db.flush()
        fixtures["item7_customer_id"] = c7.id
        fixtures["item7_doc_id"] = d7.id

        db.commit()

    out_file = fixtures_dir / "test_fixtures.json"
    with open(out_file, "w") as f:
        json.dump(fixtures, f, indent=2)

    print(f"E2E test fixtures saved to {out_file}")


if __name__ == "__main__":
    setup_all_fixtures()
