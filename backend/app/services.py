"""Case logic: customers, consent, tokens, uploads, pending recalculation, deletion, privacy requests."""
import hashlib
import re
import secrets
from datetime import timedelta

from sqlalchemy import delete, select, update

from . import emailer
from .config import get_settings
from .db import utcnow
from .doc_types import CANONICAL, canonical_key, label
from .jobs import enqueue
from .models import (
    AccessToken, AuditLog, ConsentLedger, Customer, Document, ManualReview, OcrResult,
    PrivacyRequest, RequiredDocument,
)
from .security import hash_token, new_token
from .storage import delete_file, put_file

SINGLE_USE = {"consent", "privacy"}
ALLOWED_EXT = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


class UploadError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ------------------------------------------------------------------ audit
def audit(db, actor: str, action: str, entity_type: str | None = None, entity_id=None, details: dict | None = None):
    db.add(AuditLog(actor=actor, action=action, entity_type=entity_type,
                    entity_id=None if entity_id is None else str(entity_id), details=details or {}))


# ------------------------------------------------------------------ customers
def create_customer(db, name: str, email: str, mobile: str | None, required: list[str], actor: str) -> Customer:
    keys: list[str] = []
    for r in required:
        k = canonical_key(r)
        if k is None:
            raise ValueError(f"Unsupported document type: {r}")
        if k not in keys:
            keys.append(k)
    if not keys:
        raise ValueError("At least one required document is needed")
    c = Customer(name=name.strip(), email=email.strip().lower(), mobile=mobile)
    db.add(c)
    db.flush()
    for k in keys:
        db.add(RequiredDocument(customer_id=c.id, doc_type=k))
    audit(db, actor, "customer_created", "customer", c.id)
    db.flush()
    return c


def required_rows(db, customer_id: int) -> list[RequiredDocument]:
    return list(db.scalars(select(RequiredDocument).where(RequiredDocument.customer_id == customer_id)
                           .order_by(RequiredDocument.doc_type)))


def sync_required_and_pending(db, customer: Customer) -> list[RequiredDocument]:
    """
    Reconciles RequiredDocument rows in PostgreSQL against current Document states.
    A requirement is satisfied (verified_document_id set) ONLY IF there exists an active,
    stored, non-superseded Document with verification_status == 'verified' matching that doc_type.
    All other states (not_started, processing, manual_review, rejected, failed, deleted, superseded)
    mean verified_document_id is None (pending).
    """
    reqs = required_rows(db, customer.id)
    verified_docs = list(db.scalars(
        select(Document)
        .where(
            Document.customer_id == customer.id,
            Document.verification_status == "verified",
            Document.superseded.is_(False),
        )
        .order_by(Document.created_at.desc())
    ))
    verified_by_type: dict[str, Document] = {}
    for d in verified_docs:
        if d.doc_type not in verified_by_type:
            verified_by_type[d.doc_type] = d

    for r in reqs:
        matching_doc = verified_by_type.get(r.doc_type)
        new_doc_id = matching_doc.id if matching_doc else None
        if r.verified_document_id != new_doc_id:
            r.verified_document_id = new_doc_id

    db.flush()
    return reqs


def pending_keys(db, customer_id: int) -> list[str]:
    c = db.get(Customer, customer_id)
    if c:
        sync_required_and_pending(db, c)
    return [r.doc_type for r in required_rows(db, customer_id) if not r.verified_document_id]


def customer_state_for_doc(doc: Document | None) -> str:
    """What the *customer* sees for an uploaded document (no internal reasons)."""
    if doc is None:
        return "pending_upload"
    if doc.verification_status == "verified":
        return "verified"
    if doc.verification_status == "rejected":
        return "resubmit"
    if doc.verification_status == "manual_review":
        return "under_review"
    return "processing"


def latest_docs(db, customer_id: int) -> dict[str, Document]:
    docs = db.scalars(select(Document).where(Document.customer_id == customer_id, Document.superseded.is_(False))
                      .order_by(Document.created_at, Document.id))
    out: dict[str, Document] = {}
    for d in docs:
        out[d.doc_type] = d
    return out


def required_status(db, customer_id: int) -> list[dict]:
    c = db.get(Customer, customer_id)
    if c:
        sync_required_and_pending(db, c)
    latest = latest_docs(db, customer_id)
    rows = []
    for r in required_rows(db, customer_id):
        doc = db.get(Document, r.verified_document_id) if r.verified_document_id else latest.get(r.doc_type)
        state = "verified" if r.verified_document_id else customer_state_for_doc(doc)
        rows.append({
            "doc_type": r.doc_type,
            "label": label(r.doc_type),
            "state": state,
            "is_pending": r.verified_document_id is None,
            "verification_status": doc.verification_status if doc else "missing",
            "document_id": doc.id if doc else None,
        })
    return rows


def recalc_case(db, customer: Customer) -> dict:
    """
    Pending = Required - Verified.
    - Syncs RequiredDocument rows in PostgreSQL.
    - If all required documents are verified and customer.case_status == "in_progress":
        transitions to "completed", sets completed_at, schedules retention delete_after,
        records audit log, and emails customer.
    - Idempotent: repeated calls when already completed will not re-audit or re-email.
    - If any required document is missing or not verified:
        keeps case_status in_progress (or reopens if a verified doc was rejected/deleted).
    """
    reqs = sync_required_and_pending(db, customer)
    pending = [r for r in reqs if not r.verified_document_id]

    if not pending:
        if customer.case_status == "in_progress":
            now = utcnow()
            customer.case_status = "completed"
            customer.completed_at = now
            customer.delete_after = now + timedelta(days=get_settings().retention_days)
            audit(db, "system", "case_completed", "customer", customer.id)
            emailer.completed(customer.email, customer.name)
    else:
        # Some required documents are still pending / not verified
        if customer.case_status == "completed":
            customer.case_status = "in_progress"
            customer.completed_at = None
            customer.delete_after = None
            audit(db, "system", "case_reopened", "customer", customer.id, {"pending_count": len(pending)})

    db.flush()
    return {
        "required_count": len(reqs),
        "received_count": len(reqs) - len(pending),
        "pending_count": len(pending),
        "pending_keys": [r.doc_type for r in pending],
        "case_status": customer.case_status,
        "completed": customer.case_status == "completed",
    }


# ------------------------------------------------------------------ tokens
def issue_token(db, customer_id: int, purpose: str, ttl: timedelta, ref_id: str | None = None) -> str:
    raw = new_token()
    db.add(AccessToken(customer_id=customer_id, purpose=purpose, token_hash=hash_token(raw),
                       ref_id=ref_id, expires_at=utcnow() + ttl))
    db.flush()
    return raw


def resolve_token(db, raw: str, purpose: str, consume: bool = False) -> AccessToken | None:
    if not raw or len(raw) < 20:
        return None
    t = db.scalar(select(AccessToken).where(AccessToken.token_hash == hash_token(raw), AccessToken.purpose == purpose))
    if not t or t.revoked or t.expires_at <= utcnow():
        return None
    if purpose in SINGLE_USE and t.used_at:
        return None
    if consume:
        t.used_at = utcnow()
    return t


# ------------------------------------------------------------------ consent & emails
def send_consent_email(db, customer: Customer) -> None:
    s = get_settings()
    raw = issue_token(db, customer.id, "consent", timedelta(hours=s.consent_token_hours))
    labels = [label(k) for k in pending_keys(db, customer.id)]
    emailer.consent_request(customer.email, customer.name, labels, f"{s.public_base_url}/consent/{raw}")


def send_upload_link(db, customer: Customer, reminder: bool = False) -> None:
    s = get_settings()
    raw = issue_token(db, customer.id, "upload", timedelta(hours=s.upload_token_hours))
    labels = [label(k) for k in pending_keys(db, customer.id)]
    emailer.pending_documents(customer.email, customer.name, labels, f"{s.public_base_url}/portal/{raw}", reminder)


def record_consent(db, customer: Customer, granted: bool) -> None:
    s = get_settings()
    if customer.consent_status != "pending":
        raise ValueError("consent already recorded")
    db.add(ConsentLedger(customer_id=customer.id, event="granted" if granted else "declined"))
    if granted:
        now = utcnow()
        customer.consent_status, customer.case_status = "granted", "in_progress"
        customer.consent_at = now
        customer.case_expires_at = now + timedelta(days=s.case_expiry_days)
        send_upload_link(db, customer)
    else:
        customer.consent_status, customer.case_status = "declined", "consent_declined"
    audit(db, "customer", "consent_" + ("granted" if granted else "declined"), "customer", customer.id)


# ------------------------------------------------------------------ uploads & otp
def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        masked_local = local + "***"
    else:
        masked_local = local[0] + "***"
    return f"{masked_local}@{domain}"


def generate_and_send_upload_otp(db, customer: Customer, upload_token_id: str) -> str:
    s = get_settings()
    # Revoke any prior unconsumed OTPs for this upload link
    db.execute(
        update(AccessToken)
        .where(
            AccessToken.customer_id == customer.id,
            AccessToken.purpose == "upload_otp",
            AccessToken.ref_id == upload_token_id,
            AccessToken.used_at.is_(None),
            AccessToken.revoked.is_(False),
        )
        .values(revoked=True)
    )
    code = f"{secrets.randbelow(900000) + 100000}"
    db.add(
        AccessToken(
            customer_id=customer.id,
            purpose="upload_otp",
            token_hash=hash_token(code),
            ref_id=upload_token_id,
            expires_at=utcnow() + timedelta(minutes=s.upload_otp_expiry_minutes),
        )
    )
    db.flush()
    emailer.send_upload_otp(customer.email, customer.name, code)
    audit(db, "customer", "upload_otp_sent", "customer", customer.id)
    return mask_email(customer.email)


def verify_upload_otp(db, customer: Customer, upload_token: AccessToken, code: str) -> bool:
    cleaned = code.strip()
    if not cleaned or len(cleaned) < 4:
        return False
    h = hash_token(cleaned)
    now = utcnow()
    otp_token = db.scalar(
        select(AccessToken)
        .where(
            AccessToken.customer_id == customer.id,
            AccessToken.purpose == "upload_otp",
            AccessToken.ref_id == upload_token.id,
            AccessToken.token_hash == h,
            AccessToken.revoked.is_(False),
            AccessToken.used_at.is_(None),
            AccessToken.expires_at > now,
        )
    )
    if not otp_token:
        return False

    otp_token.used_at = now
    db.add(
        AccessToken(
            customer_id=customer.id,
            purpose="otp_verified",
            token_hash=hash_token(f"verified:{upload_token.id}:{new_token()}"),
            ref_id=upload_token.id,
            expires_at=upload_token.expires_at,
        )
    )
    audit(db, "customer", "upload_otp_verified", "customer", customer.id)
    db.flush()
    return True


def is_upload_otp_verified(db, customer_id: int, upload_token_id: str) -> bool:
    now = utcnow()
    v = db.scalar(
        select(AccessToken)
        .where(
            AccessToken.customer_id == customer_id,
            AccessToken.purpose == "otp_verified",
            AccessToken.ref_id == upload_token_id,
            AccessToken.revoked.is_(False),
            AccessToken.expires_at > now,
        )
    )
    return v is not None


DANGEROUS_SIGNATURES = (
    b"MZ",            # DOS / Windows executable
    b"\x7fELF",       # Linux executable
    b"\xca\xfe\xba\xbe", # Mach-O / Java bytecode
    b"PK\x03\x04",    # Zip / Jar archives
    b"#!/",           # Unix shell script
    b"#!\n",
)


def _validate_file(filename: str, data: bytes) -> str:
    s = get_settings()
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXT:
        raise UploadError("unsupported_file_type", "Only PDF, PNG and JPG files are accepted.")
    if not data:
        raise UploadError("empty_file", "The file is empty.")
    if len(data) > s.max_upload_mb * 1024 * 1024:
        raise UploadError("file_too_large", f"Files must be {s.max_upload_mb} MB or smaller.", 413)

    # Magic byte verification
    is_pdf = data[:5] == b"%PDF-"
    is_png = data[:8] == b"\x89PNG\r\n\x1a\n"
    is_jpg = data[:3] == b"\xff\xd8\xff"
    ok = (ext == ".pdf" and is_pdf) or (ext == ".png" and is_png) or (ext in (".jpg", ".jpeg") and is_jpg)
    if not ok:
        raise UploadError("file_content_mismatch", "The file content does not match its type.")

    # Guard against disguised executables or scripts
    if any(data.startswith(sig) for sig in DANGEROUS_SIGNATURES):
        raise UploadError("file_content_mismatch", "The file content does not match its type.")

    snippet = data[:1024].lower()
    if any(sig in snippet for sig in (b"<script", b"<?php", b"<!doctype html", b"<html")):
        raise UploadError("unsafe_file", "The file contains active script content.")

    if is_pdf:
        if b"/Encrypt" in data:
            raise UploadError("password_protected_pdf", "This PDF is password protected. Please upload an unprotected copy.")
        if b"/JavaScript" in data or b"/Launch" in data or b"/JS" in data:
            raise UploadError("unsafe_pdf", "This PDF contains active content and cannot be accepted.")
    return ALLOWED_EXT[ext]


def accept_upload(db, customer: Customer, doc_type_raw: str, filename: str, data: bytes) -> Document:
    slot = canonical_key(doc_type_raw)
    required = {r.doc_type: r for r in required_rows(db, customer.id)}
    if slot is None or slot not in required:
        raise UploadError("not_required", "That document is not on your required list.", 400)
    if required[slot].verified_document_id:
        raise UploadError("already_verified", "That document is already verified.", 409)
    safe_name = re.sub(r"[^\w.\- ]", "_", filename.rsplit("/", 1)[-1])[:200] or "upload"
    mime = _validate_file(safe_name, data)
    sha = hashlib.sha256(data).hexdigest()

    same = db.scalar(select(Document).where(Document.customer_id == customer.id, Document.sha256 == sha,
                                            Document.doc_type == slot, Document.superseded.is_(False),
                                            Document.file_state == "stored"))
    if same:  # idempotent re-upload of the same file
        return same

    doc = Document(customer_id=customer.id, doc_type=slot, filename=safe_name, mime=mime, size=len(data),
                   sha256=sha, storage_key="")
    db.add(doc)
    db.flush()
    doc.storage_key = f"{customer.id}/{doc.id}.enc"
    put_file(doc.storage_key, data)

    # a new upload for the slot replaces any earlier unverified one (and removes its file)
    for old in db.scalars(select(Document).where(Document.customer_id == customer.id, Document.doc_type == slot,
                                                 Document.id != doc.id, Document.superseded.is_(False))):
        old.superseded = True
        if old.file_state == "stored":
            delete_file(old.storage_key)
            old.file_state = "deleted"
        db.execute(delete(ManualReview).where(ManualReview.document_id == old.id))
        db.execute(delete(OcrResult).where(OcrResult.document_id == old.id))

    audit(db, "customer", "document_uploaded", "document", doc.id, {"doc_type": slot})
    enqueue(db, "process_document", {"document_id": doc.id}, max_attempts=get_settings().ocr_max_attempts)
    recalc_case(db, customer)
    db.flush()
    return doc


# ------------------------------------------------------------------ verification outcomes
def mark_verified(db, doc: Document) -> None:
    doc.verification_status = "verified"
    req = db.scalar(select(RequiredDocument).where(RequiredDocument.customer_id == doc.customer_id,
                                                   RequiredDocument.doc_type == doc.doc_type))
    if req:
        req.verified_document_id = doc.id


def request_resubmission(db, customer: Customer, doc: Document) -> None:
    s = get_settings()
    raw = issue_token(db, customer.id, "upload", timedelta(hours=s.upload_token_hours))
    emailer.resubmit(customer.email, customer.name, label(doc.doc_type), f"{s.public_base_url}/portal/{raw}")


def decide_review(db, review: ManualReview, approve: bool, admin: str, note: str | None) -> None:
    if review.status != "open":
        raise ValueError("review already decided")
    doc = db.get(Document, review.document_id)
    customer = db.get(Customer, review.customer_id)
    review.status = "approved" if approve else "rejected"
    review.decided_by, review.decided_at, review.note = admin, utcnow(), note
    if approve:
        mark_verified(db, doc)
    else:
        doc.verification_status = "rejected"
        request_resubmission(db, customer, doc)
    audit(db, admin, "review_approved" if approve else "review_rejected", "document", doc.id, details={"note": note} if note else None)
    db.flush()
    recalc_case(db, customer)


# ------------------------------------------------------------------ deletion & privacy
def delete_customer_files(db, customer: Customer) -> None:
    """Delete raw files, temporary OCR data, review evidence, hashes, and access tokens."""
    docs = list(db.scalars(select(Document).where(Document.customer_id == customer.id)))
    for d in docs:
        if d.file_state == "stored":
            delete_file(d.storage_key)
            d.file_state = "deleted"
        d.sha256 = ""
    ids = [d.id for d in docs]
    if ids:
        db.execute(delete(OcrResult).where(OcrResult.document_id.in_(ids)))
        db.execute(delete(ManualReview).where(ManualReview.document_id.in_(ids)))
    db.execute(delete(AccessToken).where(AccessToken.customer_id == customer.id))
    customer.data_deleted_at = utcnow()


def start_privacy_request(db, email: str, action: str) -> None:
    """Always silent to the caller (no account enumeration)."""
    c = db.scalar(select(Customer).where(Customer.email == email.strip().lower(), Customer.case_status != "deleted")
                  .order_by(Customer.id.desc()))
    if not c:
        return
    pr = PrivacyRequest(customer_id=c.id, action=action)
    db.add(pr)
    db.flush()
    s = get_settings()
    raw = issue_token(db, c.id, "privacy", timedelta(minutes=s.privacy_token_minutes), ref_id=pr.id)
    emailer.privacy_verification(c.email, c.name, action, f"{s.public_base_url}/privacy/confirm/{raw}")


def confirm_privacy_request(db, raw: str) -> str | None:
    t = resolve_token(db, raw, "privacy", consume=True)
    if not t:
        return None
    pr, c = db.get(PrivacyRequest, t.ref_id), db.get(Customer, t.customer_id)
    if not pr or not c or pr.status == "completed":
        return None
    if pr.action == "delete":
        emailer.deletion_confirmation(c.email, c.name)  # send before the email address is wiped
        delete_customer_files(db, c)
        db.add(ConsentLedger(customer_id=c.id, event="deleted"))
        c.name, c.email, c.mobile = "[deleted]", f"deleted-{c.id}@invalid.local", None
        c.case_status, c.consent_status = "deleted", "withdrawn"
        db.execute(update(AccessToken).where(AccessToken.customer_id == c.id).values(revoked=True))
    else:
        db.add(ConsentLedger(customer_id=c.id, event="withdrawn"))
        c.consent_status, c.case_status = "withdrawn", "consent_withdrawn"
        c.delete_after = utcnow() + timedelta(days=get_settings().retention_days)
        emailer.withdrawal_confirmation(c.email, c.name)
    pr.status, pr.completed_at = "completed", utcnow()
    audit(db, "customer", "privacy_" + pr.action, "customer", c.id)
    return pr.action


def close_case_by_admin(db, customer: Customer, admin: str, reason: str | None = None) -> None:
    if customer.case_status in ("completed", "deleted"):
        raise ValueError("case_already_closed")
    now = utcnow()
    customer.case_status = "completed"
    customer.completed_at = now
    customer.delete_after = now + timedelta(days=get_settings().retention_days)
    db.execute(update(AccessToken).where(AccessToken.customer_id == customer.id, AccessToken.purpose == "upload").values(revoked=True))
    audit(db, admin, "case_closed", "customer", customer.id, {"reason": reason} if reason else None)


def delete_customer_data_by_admin(db, customer: Customer, admin: str) -> None:
    if customer.case_status == "deleted":
        raise ValueError("data_already_deleted")
    delete_customer_files(db, customer)
    db.add(ConsentLedger(customer_id=customer.id, event="deleted"))
    customer.name, customer.email, customer.mobile = "[deleted]", f"deleted-{customer.id}@invalid.local", None
    customer.case_status, customer.consent_status = "deleted", "withdrawn"
    db.execute(update(AccessToken).where(AccessToken.customer_id == customer.id).values(revoked=True))
    audit(db, admin, "customer_data_deleted", "customer", customer.id)


def mark_document_file_deleted(db, doc: Document, admin: str) -> None:
    if doc.file_state == "stored":
        delete_file(doc.storage_key)
        doc.file_state = "deleted"
        doc.sha256 = ""
    audit(db, admin, "file_marked_deleted", "document", doc.id, {"customer_id": doc.customer_id, "doc_type": doc.doc_type})
    c = db.get(Customer, doc.customer_id)
    if c:
        recalc_case(db, c)

