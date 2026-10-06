"""
STEP 5: Secure Document Upload & Encrypted Storage Test Suite.
Covers token verification, workflow guards, file and magic-byte validation,
AES-256-GCM encryption before persistent storage, storage key privacy,
database failure cleanup, re-upload/resubmission superseding, and rate limiting.
"""
from datetime import timedelta
from pathlib import Path
import pytest
from sqlalchemy import select

from app import db as dbmod
from app import storage
from app.config import get_settings
from app.models import AccessToken, AuditLog, Customer, Document, RequiredDocument
from app.rate_limiter import reset_rate_limits
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def setup_customer_and_portal(client, name="Kavita Rao", email="kavita@example.com", docs=("pan", "aadhaar")):
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


# 1, 2, 10. Valid upload with valid token (PDF, PNG)
def test_valid_document_uploads(client):
    cid, portal_tok = setup_customer_and_portal(client, name="Valid User", email="valid@example.com")
    # Upload PNG to pan slot
    r1 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("my_pan.png", PNG, "image/png")},
    )
    assert r1.status_code == 202
    b1 = r1.json()
    assert b1["doc_type"] == "pan"
    assert b1["label"] == "PAN Card"
    assert b1["state"] == "processing"
    assert "document_id" in b1

    # Upload PDF to aadhaar slot
    r2 = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "aadhaar"},
        files={"file": ("my_aadhaar.pdf", PDF, "application/pdf")},
    )
    assert r2.status_code == 202
    b2 = r2.json()
    assert b2["doc_type"] == "aadhaar"
    assert b2["label"] == "Aadhaar Card"


# 3. Expired upload token returns 404
def test_expired_upload_token_rejected(client):
    cid, portal_tok = setup_customer_and_portal(client, email="expired.upload@example.com")
    with dbmod.session_scope() as db:
        tok = db.scalar(select(AccessToken).where(AccessToken.customer_id == cid, AccessToken.purpose == "upload"))
        tok.expires_at = dbmod.utcnow() - timedelta(minutes=1)

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "invalid_or_expired_link"


# 4. Invalid or nonexistent upload token returns 404
def test_invalid_upload_token_rejected(client):
    r = client.post(
        "/api/portal/completely-random-fake-token-value/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "invalid_or_expired_link"


# 5. Revoked upload token returns 404
def test_revoked_upload_token_rejected(client):
    cid, portal_tok = setup_customer_and_portal(client, email="revoked.upload@example.com")
    with dbmod.session_scope() as db:
        tok = db.scalar(select(AccessToken).where(AccessToken.customer_id == cid, AccessToken.purpose == "upload"))
        tok.revoked = True

    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "invalid_or_expired_link"


# 6. Customer consent required
def test_consent_not_granted_blocks_upload(client):
    # Customer created, but consent NOT yet submitted
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "No Consent", "email": "noconsent.up@example.com", "required_documents": ["pan"], "send_consent": False},
    )
    cid = r.json()["id"]
    # Issue a rogue upload token for unconsented customer
    with dbmod.session_scope() as db:
        from app.services import issue_token
        tok = issue_token(db, cid, "upload", timedelta(hours=24))

    r_up = client.post(
        f"/api/portal/{tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r_up.status_code == 403
    assert r_up.json()["detail"] == "consent_required"


# 7. Withdrawn customer blocked from uploading
def test_withdrawn_customer_blocked(client):
    cid, portal_tok = setup_customer_and_portal(client, email="withdrawn.up@example.com")
    # Withdraw consent via privacy flow
    client.post("/api/public/privacy/request", json={"email": "withdrawn.up@example.com", "action": "withdraw"})
    priv_tok = token_from_outbox("privacy/confirm")
    client.post(f"/api/public/privacy/confirm/{priv_tok}")

    # Subsequent upload attempt is blocked
    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan.png", PNG, "image/png")},
    )
    assert r.status_code in (403, 404)


# 8. Cross-customer isolation
def test_cross_customer_token_isolation(client):
    c1, tok1 = setup_customer_and_portal(client, name="User One", email="one.iso@example.com", docs=["pan"])
    c2, tok2 = setup_customer_and_portal(client, name="User Two", email="two.iso@example.com", docs=["aadhaar"])

    # tok1 uploading to c2's required slot ('aadhaar') should fail because c1 only requires 'pan'
    r = client.post(
        f"/api/portal/{tok1}/upload",
        data={"doc_type": "aadhaar"},
        files={"file": ("doc.pdf", PDF, "application/pdf")},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "not_required"


# 9. Document slot must belong to customer
def test_document_slot_not_required(client):
    _, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    r = client.post(
        f"/api/portal/{portal_tok}/upload",
        data={"doc_type": "passport"},
        files={"file": ("pass.pdf", PDF, "application/pdf")},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "not_required"


# 10. Already verified document slot cannot be re-uploaded
def test_already_verified_slot_rejected(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    # Upload PAN
    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("p.png", PNG, "image/png")})
    doc_id = r.json()["document_id"]
    # Mark verified in DB
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.verification_status = "verified"
        req = db.scalar(select(RequiredDocument).where(RequiredDocument.customer_id == cid, RequiredDocument.doc_type == "pan"))
        req.verified_document_id = doc.id

    r_again = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("p2.png", PNG + b"1", "image/png")})
    assert r_again.status_code == 409
    assert r_again.json()["detail"]["code"] == "already_verified"


# 11, 12, 13, 14. File validation: extension, magic-bytes, empty, oversized
def test_file_validation_rules(client, monkeypatch):
    _, portal_tok = setup_customer_and_portal(client, docs=["pan"])

    # 11. Disallowed extension
    r_ext = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("file.exe", PNG, "application/octet-stream")})
    assert r_ext.status_code == 400
    assert r_ext.json()["detail"]["code"] == "unsupported_file_type"

    # 12. Magic-byte mismatch (named .png but has invalid bytes)
    r_magic = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("file.png", b"not-a-png", "image/png")})
    assert r_magic.status_code == 400
    assert r_magic.json()["detail"]["code"] == "file_content_mismatch"

    # 13. Empty file
    r_empty = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("empty.png", b"", "image/png")})
    assert r_empty.status_code == 400
    assert r_empty.json()["detail"]["code"] == "empty_file"

    # 14. Oversized file
    s = get_settings()
    monkeypatch.setattr(s, "max_upload_mb", 1)
    huge_bytes = PNG + b"X" * (1024 * 1024 + 10)
    r_big = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("big.png", huge_bytes, "image/png")})
    assert r_big.status_code == 413
    assert r_big.json()["detail"]["code"] == "file_too_large"


# 15. Path traversal filename sanitization
def test_filename_path_traversal_sanitized(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    malicious_filename = "../../../etc/passwd.png"
    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": (malicious_filename, PNG, "image/png")})
    assert r.status_code == 202
    doc_id = r.json()["document_id"]
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert "/" not in doc.filename
        assert ".." not in doc.filename
        assert doc.filename == "passwd.png"


# 16, 17, 18. Encryption before persistent storage, plaintext never on disk, storage_key not exposed
def test_encrypted_storage_invariant(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    unique_payload = PNG + b"SECRET_PLAINTEXT_MARKER_12345"
    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("secret.png", unique_payload, "image/png")})
    assert r.status_code == 202
    resp_body = r.json()
    assert "storage_key" not in resp_body
    assert "key" not in resp_body
    doc_id = resp_body["document_id"]

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        key = doc.storage_key
        # Key must be server-controlled
        assert key.startswith(f"{cid}/")
        assert key.endswith(".enc")

    # Read raw ciphertext directly from local storage backend
    store_dir = Path(get_settings().local_storage_dir)
    raw_disk_bytes = (store_dir / key).read_bytes()
    # The plaintext secret marker MUST NOT appear in the stored ciphertext file
    assert b"SECRET_PLAINTEXT_MARKER_12345" not in raw_disk_bytes
    # Decrypting via storage.get_file recovers the exact plaintext
    assert storage.get_file(key) == unique_payload


# 19, 20, 21. Database Document metadata and initial states
def test_document_metadata_and_initial_states(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("test_pan.png", PNG, "image/png")})
    assert r.status_code == 202
    doc_id = r.json()["document_id"]

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.customer_id == cid
        assert doc.doc_type == "pan"
        assert doc.filename == "test_pan.png"
        assert doc.mime == "image/png"
        assert doc.size == len(PNG)
        assert doc.workflow_state == "UPLOADED"
        assert doc.verification_status == "not_started"
        assert doc.ocr_status == "waiting"
        assert doc.file_state == "stored"
        assert doc.superseded is False

        # Customer workflow_state progresses to IN_PROGRESS upon document arrival
        cust = db.get(Customer, cid)
        assert cust.workflow_state == "IN_PROGRESS"


# 22. Storage failure cleanup: if storage write fails, no document row is committed
def test_storage_failure_cleanup(client, monkeypatch):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])

    def broken_put(*args, **kwargs):
        raise OSError("Disk full")

    monkeypatch.setattr(storage.get_storage(), "put", broken_put)

    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert r.status_code == 500
    with dbmod.session_scope() as db:
        assert len(list(db.scalars(select(Document).where(Document.customer_id == cid)))) == 0


# 23. Database failure cleanup: if DB flush fails after put_file, uploaded storage object is deleted
def test_database_failure_cleans_up_storage(client, monkeypatch):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    from app import services
    real_audit = services.audit

    def flaky_audit(*args, **kwargs):
        raise RuntimeError("DB audit failed")

    monkeypatch.setattr(services, "audit", flaky_audit)

    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert r.status_code == 500

    # Ensure no orphan file left in storage
    store_dir = Path(get_settings().local_storage_dir) / str(cid)
    assert not store_dir.exists() or len(list(store_dir.glob("*.enc"))) == 0


# 24. Re-upload / resubmission replaces old unverified document & cleans up old storage file
def test_reupload_resubmission_supersedes_and_deletes_old_file(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])

    # 1st upload
    r1 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan1.png", PNG + b"_first", "image/png")})
    assert r1.status_code == 202
    doc1_id = r1.json()["document_id"]

    # 2nd upload for the same slot with different content
    r2 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan2.png", PNG + b"_second", "image/png")})
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

        # Old file deleted from storage, new file exists
        store_dir = Path(get_settings().local_storage_dir)
        assert not (store_dir / d1.storage_key).exists()
        assert (store_dir / d2.storage_key).exists()


# 25. Rate limiting on uploads
def test_upload_rate_limiting(client, monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    monkeypatch.setattr(s, "rate_limit_upload_per_minute", 2)

    _, portal_tok = setup_customer_and_portal(client, docs=["pan", "aadhaar"])
    r1 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("1.png", PNG + b"1", "image/png")})
    assert r1.status_code == 202
    r2 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "aadhaar"}, files={"file": ("2.png", PNG + b"2", "image/png")})
    assert r2.status_code == 202

    # 3rd upload gets rate limited (429)
    r3 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("3.png", PNG + b"3", "image/png")})
    assert r3.status_code == 429
    assert r3.json()["detail"]["code"] == "rate_limited"


# 26. Audit event recorded on upload
def test_upload_audit_event(client):
    cid, portal_tok = setup_customer_and_portal(client, docs=["pan"])
    r = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("audit.png", PNG, "image/png")})
    doc_id = r.json()["document_id"]

    with dbmod.session_scope() as db:
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == doc_id, AuditLog.action == "document_uploaded"))
        assert audit is not None
        assert audit.actor == "customer"
        assert audit.entity_type == "document"
        assert audit.details == {"doc_type": "pan"}
