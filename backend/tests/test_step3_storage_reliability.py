"""
Phase 5 Step 3: Audit File & Storage Reliability Test Suite.

Verifies:
1. Encrypted file upload/storage/retrieval (AES-256-GCM, ciphertext-only on disk/storage).
2. Large-file handling and upload limits (HTTP 413 file_too_large).
3. Interrupted/failed uploads do not leave corrupt or orphan files.
4. Duplicate uploads are handled safely (idempotent, no orphan objects).
5. Re-upload/superseded documents clean up correctly (old file deleted, state updated).
6. Missing/corrupt/deleted storage objects fail safely (410, 404, 500 safe errors, pipeline safe routing).
7. Encryption/decryption failures never expose plaintext or crash unexpectedly.
8. Temporary files are cleaned after processing (in-memory processing, no temp leaks).
9. Retention/deletion removes encrypted files correctly (storage deleted, sha256 wiped, tokens revoked).
"""
from datetime import timedelta
from pathlib import Path
import pytest
from sqlalchemy import select

from app import db as dbmod, pipeline, rules, services, storage
from app.config import get_settings
from app.models import AccessToken, Customer, Document, ManualReview, OcrResult
from app.security import decrypt, encrypt
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def setup_portal_customer(client, name="Storage Test User", email="storage_test@example.com", docs=("pan", "aadhaar")):
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "required_documents": list(docs), "send_consent": True},
    )
    assert r.status_code == 201
    cid = r.json()["id"]
    consent_tok = token_from_outbox("consent")
    r_c = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert r_c.status_code == 200
    portal_tok = r_c.json()["upload_token"]
    return cid, portal_tok


# 1. Encrypted file upload, storage, and retrieval
def test_encrypted_file_upload_storage_retrieval(client):
    cid, portal_tok = setup_portal_customer(client, name="Enc User", email="enc_user@example.com", docs=["pan"])
    secret_marker = b"TOP_SECRET_PLAINTEXT_VERIFICATION_STRING_998877"
    raw_file = PNG + secret_marker

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("my_pan.png", raw_file, "image/png")},
    )
    assert r.status_code == 202
    doc_id = r.json()["document_id"]

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.file_state == "stored"
        storage_key = doc.storage_key
        assert storage_key.startswith(f"{cid}/")
        assert storage_key.endswith(".enc")

    # Read raw storage backend file
    store_dir = Path(get_settings().local_storage_dir)
    disk_bytes = (store_dir / storage_key).read_bytes()

    # Plaintext marker MUST NOT be present anywhere in the raw stored bytes
    assert secret_marker not in disk_bytes

    # Admin retrieval decrypts and returns the exact original plaintext
    r_view = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r_view.status_code == 200
    assert r_view.content == raw_file


# 2. Large-file handling and upload limits
def test_large_file_handling_and_upload_limits(client, monkeypatch):
    cid, portal_tok = setup_portal_customer(client, name="Big User", email="big_user@example.com", docs=["pan"])
    s = get_settings()
    monkeypatch.setattr(s, "max_upload_mb", 2)

    # Oversized file: 2MB + 10 bytes
    oversized = PNG + b"A" * (2 * 1024 * 1024 + 10)
    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("too_big.png", oversized, "image/png")},
    )
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "file_too_large"

    # Within limit file: accepted
    within_limit = PNG + b"A" * (1024 * 1024)
    r_ok = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("within_limit.png", within_limit, "image/png")},
    )
    assert r_ok.status_code == 202


# 3. Interrupted/failed uploads do not leave corrupt or orphan files
def test_interrupted_upload_cleans_up_storage(client, monkeypatch):
    cid, portal_tok = setup_portal_customer(client, name="Fail User", email="fail_user@example.com", docs=["pan"])

    def broken_audit(*args, **kwargs):
        raise RuntimeError("Simulated DB commit error during upload")

    monkeypatch.setattr(services, "audit", broken_audit)

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 500
    assert r.json()["detail"]["code"] == "upload_failed"

    # Ensure no storage file was left behind
    store_dir = Path(get_settings().local_storage_dir) / str(cid)
    assert not store_dir.exists() or len(list(store_dir.glob("*.enc"))) == 0


# 4. Duplicate uploads are handled safely (idempotent, no orphan objects)
def test_duplicate_uploads_handled_idempotently(client):
    cid, portal_tok = setup_portal_customer(client, name="Dup User", email="dup_user@example.com", docs=["pan"])

    # First upload
    r1 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r1.status_code == 202
    doc1_id = r1.json()["document_id"]

    # Re-upload the exact same file
    r2 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r2.status_code == 202
    doc2_id = r2.json()["document_id"]

    # Identical document returned idempotently
    assert doc1_id == doc2_id

    # Exactly one storage file exists
    store_dir = Path(get_settings().local_storage_dir) / str(cid)
    enc_files = list(store_dir.glob("*.enc"))
    assert len(enc_files) == 1


# 5. Re-upload/superseded documents clean up correctly
def test_reupload_supersedes_and_deletes_old_storage(client):
    cid, portal_tok = setup_portal_customer(client, name="Reupload User", email="reup_user@example.com", docs=["pan"])

    r1 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan_v1.png", PNG + b"_v1", "image/png")},
    )
    assert r1.status_code == 202
    doc1_id = r1.json()["document_id"]

    # Create a dummy manual review for doc1 to verify cleanup
    with dbmod.session_scope() as db:
        db.add(ManualReview(document_id=doc1_id, customer_id=cid, reason="test_review", flags=["test"]))

    # Upload different file to same slot
    r2 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan_v2.png", PNG + b"_v2", "image/png")},
    )
    assert r2.status_code == 202
    doc2_id = r2.json()["document_id"]
    assert doc1_id != doc2_id

    with dbmod.session_scope() as db:
        d1 = db.get(Document, doc1_id)
        d2 = db.get(Document, doc2_id)
        assert d1.superseded is True
        assert d1.file_state == "deleted"
        assert d2.superseded is False
        assert d2.file_state == "stored"

        # Verify old manual review record was purged
        old_reviews = list(db.scalars(select(ManualReview).where(ManualReview.document_id == doc1_id)))
        assert len(old_reviews) == 0

        # Old file deleted from storage, new file exists
        store_dir = Path(get_settings().local_storage_dir)
        assert not (store_dir / d1.storage_key).exists()
        assert (store_dir / d2.storage_key).exists()


# 6. Missing/corrupt/deleted storage objects fail safely
def test_missing_or_corrupted_storage_objects_fail_safely(client):
    cid, portal_tok = setup_portal_customer(client, name="Corrupt User", email="corrupt_user@example.com", docs=["pan"])

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    doc_id = r.json()["document_id"]

    # Test 6a: If marked deleted (file_state != 'stored'), returns 410
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.file_state = "deleted"
    r_deleted = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r_deleted.status_code == 410

    # Reset file_state to stored
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.file_state = "stored"
        storage_key = doc.storage_key

    # Test 6b: If storage file is physically missing from disk, returns 404
    store_dir = Path(get_settings().local_storage_dir)
    file_path = store_dir / storage_key
    file_path.unlink()
    r_missing = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r_missing.status_code == 404

    # Test 6c: If storage file is corrupted (tampered ciphertext), returns 500 safely
    file_path.write_bytes(b"CORRUPTED_CIPHERTEXT_BYTES_THAT_FAIL_AESGCM_TAG")
    r_corrupt = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert r_corrupt.status_code == 500

    # Test 6d: In background pipeline, corrupted storage object routes safely to manual review
    with dbmod.session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})
        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.verification_status == "manual_review"
        assert "file_retrieval_error" in d.flags


# 7. Encryption/decryption failures never expose plaintext
def test_encryption_failures_never_expose_plaintext():
    plaintext = b"SENSITIVE_PII_AADHAAR_9999_8888_7777"
    ciphertext = encrypt(plaintext)
    assert plaintext not in ciphertext

    # Tampered ciphertext raises exception and never returns partial plaintext
    tampered = bytearray(ciphertext)
    tampered[-5] ^= 0xFF
    with pytest.raises(Exception):
        decrypt(bytes(tampered))

    # Truncated ciphertext raises exception
    with pytest.raises(Exception):
        decrypt(ciphertext[:10])


# 8. Temporary files are cleaned / not leaked after processing
def test_no_temporary_file_leaks(client, tmp_path):
    cid, portal_tok = setup_portal_customer(client, name="Temp User", email="temp_user@example.com", docs=["pan"])
    store_dir = Path(get_settings().local_storage_dir)

    # Count initial files in storage
    initial_files = list(store_dir.rglob("*"))

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 202
    doc_id = r.json()["document_id"]

    with dbmod.session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    # Only the encrypted file should exist in the customer directory
    customer_files = list((store_dir / str(cid)).iterdir())
    assert len(customer_files) == 1
    assert customer_files[0].name.endswith(".enc")


# 9. Retention and deletion removes encrypted files correctly
def test_retention_and_deletion_removes_files(client):
    cid, portal_tok = setup_portal_customer(client, name="Purge User", email="purge_user@example.com", docs=["pan"])

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 202
    doc_id = r.json()["document_id"]

    with dbmod.session_scope() as db:
        c = db.get(Customer, cid)
        d = db.get(Document, doc_id)
        assert (Path(get_settings().local_storage_dir) / d.storage_key).exists()

        # Execute customer data deletion
        services.delete_customer_files(db, c)

        assert d.file_state == "deleted"
        assert d.sha256 == ""
        assert not (Path(get_settings().local_storage_dir) / d.storage_key).exists()

        # Access tokens deleted
        tokens = list(db.scalars(select(AccessToken).where(AccessToken.customer_id == cid)))
        assert len(tokens) == 0
