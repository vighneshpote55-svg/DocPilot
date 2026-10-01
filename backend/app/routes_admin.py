"""Admin API (Supabase JWT + ADMIN_EMAILS). Staff never touch the storage bucket directly."""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import services
from .config import get_settings
from .db import get_db
from .doc_types import label
from .models import AuditLog, Customer, Document, Job, ManualReview
from .security import require_admin
from .storage import get_file

router = APIRouter(prefix="/api/admin", tags=["admin"])
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class CustomerIn(BaseModel):
    name: str
    email: str
    mobile: str | None = None
    required_documents: list[str]
    send_consent: bool = True

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        if not EMAIL_RE.match(v.strip()):
            raise ValueError("invalid email")
        return v.strip().lower()


class ReviewIn(BaseModel):
    note: str | None = None


class CloseCaseIn(BaseModel):
    reason: str | None = None


def doc_out(d: Document, customer: Customer | None = None) -> dict:
    """Everything the Documents tab needs: file, OCR state, verification, review reason, deletion date."""
    return {
        "id": d.id, "doc_type": d.doc_type, "label": label(d.doc_type), "filename": d.filename,
        "uploaded_at": d.created_at, "ocr_status": d.ocr_status, "verification_status": d.verification_status,
        "needs_manual_review": d.verification_status == "manual_review", "review_reason": d.reason
        if d.verification_status in ("manual_review", "rejected") else None,
        "flags": d.flags, "confidence": d.confidence, "file_state": d.file_state,
        "delete_after": customer.delete_after if customer else None, "superseded": d.superseded,
    }


def customer_out(db: Session, c: Customer, with_docs: bool = False) -> dict:
    req = services.required_status(db, c.id)
    out = {
        "id": c.id, "code": c.code, "name": c.name, "email": c.email, "mobile": c.mobile,
        "consent_status": c.consent_status, "case_status": c.case_status, "created_at": c.created_at,
        "completed_at": c.completed_at, "delete_after": c.delete_after, "data_deleted_at": c.data_deleted_at,
        "required": req, "required_count": len(req),
        "received_count": sum(1 for r in req if r["state"] == "verified"),
        "pending_count": sum(1 for r in req if r["state"] != "verified"),
    }
    if with_docs:
        docs = db.scalars(select(Document).where(Document.customer_id == c.id).order_by(Document.created_at.desc()))
        out["documents"] = [doc_out(d, c) for d in docs]
    return out


@router.get("/summary")
def summary(db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    by_case = dict(db.execute(select(Customer.case_status, func.count()).group_by(Customer.case_status)).all())
    by_ver = dict(db.execute(select(Document.verification_status, func.count())
                             .where(Document.superseded.is_(False)).group_by(Document.verification_status)).all())
    open_reviews = db.scalar(select(func.count()).select_from(ManualReview).where(ManualReview.status == "open"))
    jobs = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    return {"cases": by_case, "documents": by_ver, "open_reviews": open_reviews, "jobs": jobs}


@router.post("/customers", status_code=201)
def create_customer(body: CustomerIn, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    try:
        c = services.create_customer(db, body.name, body.email, body.mobile, body.required_documents, admin)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if body.send_consent:
        services.send_consent_email(db, c)
    db.commit()
    return customer_out(db, c)


@router.get("/customers")
def list_customers(response: Response, status: str | None = None, q: str | None = None,
                   limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                   db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    query = select(Customer)
    if status:
        query = query.where(Customer.case_status == status)
    if q and q.strip():
        term = f"%{q.strip().lower()}%"
        from sqlalchemy import or_
        conds = [
            func.lower(Customer.name).like(term),
            func.lower(Customer.email).like(term),
        ]
        digits = re.sub(r"[^\d]", "", q.strip())
        if digits:
            conds.append(Customer.id == int(digits))
        query = query.where(or_(*conds))

    total = db.scalar(select(func.count()).select_from(query.subquery()))
    response.headers["X-Total-Count"] = str(total or 0)
    rows = list(db.scalars(query.order_by(Customer.id.desc()).limit(limit).offset(offset)))
    return [customer_out(db, c) for c in rows]


@router.post("/customers/{customer_id}/close")
def close_case(customer_id: int, body: CloseCaseIn | None = None, db: Session = Depends(get_db),
               admin: str = Depends(require_admin)):
    c = db.get(Customer, customer_id)
    if not c:
        raise HTTPException(404, "not_found")
    try:
        services.close_case_by_admin(db, c, admin, body.reason if body else None)
    except ValueError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return customer_out(db, c)


@router.post("/customers/{customer_id}/delete-data")
def delete_customer_data(customer_id: int, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    c = db.get(Customer, customer_id)
    if not c:
        raise HTTPException(404, "not_found")
    try:
        services.delete_customer_data_by_admin(db, c, admin)
    except ValueError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return {"deleted": True, "customer_id": c.id}


@router.get("/customers/{customer_id}")
def get_customer(customer_id: int, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    c = db.get(Customer, customer_id)
    if not c:
        raise HTTPException(404, "not_found")
    return customer_out(db, c, with_docs=True)


@router.post("/customers/{customer_id}/send-consent")
def resend_consent(customer_id: int, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    c = db.get(Customer, customer_id)
    if not c or c.consent_status != "pending":
        raise HTTPException(409, "consent_not_pending")
    services.send_consent_email(db, c)
    services.audit(db, admin, "consent_email_sent", "customer", c.id)
    db.commit()
    return {"sent": True}


@router.post("/customers/{customer_id}/send-upload-link")
def resend_upload_link(customer_id: int, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    c = db.get(Customer, customer_id)
    if not c or c.case_status != "in_progress":
        raise HTTPException(409, "case_not_open")
    services.send_upload_link(db, c)
    services.audit(db, admin, "upload_link_sent", "customer", c.id)
    db.commit()
    return {"sent": True}


@router.get("/reviews")
def list_reviews(status: Literal["open", "approved", "rejected"] = "open", db: Session = Depends(get_db),
                 admin: str = Depends(require_admin)):
    out = []
    for r in db.scalars(select(ManualReview).where(ManualReview.status == status).order_by(ManualReview.created_at)):
        d, c = db.get(Document, r.document_id), db.get(Customer, r.customer_id)
        out.append({"id": r.id, "status": r.status, "reason": r.reason, "flags": r.flags,
                    "created_at": r.created_at, "customer_id": c.id, "customer_code": c.code,
                    "customer_name": c.name, "document": doc_out(d, c)})
    return out


def _decide(review_id: str, approve: bool, note: str | None, db: Session, admin: str):
    r = db.get(ManualReview, review_id)
    if not r:
        raise HTTPException(404, "not_found")
    try:
        services.decide_review(db, r, approve, admin, note)
    except ValueError:
        raise HTTPException(409, "already_decided")
    db.commit()
    return {"status": r.status}


@router.post("/reviews/{review_id}/approve")
def approve(review_id: str, body: ReviewIn, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    return _decide(review_id, True, body.note, db, admin)


@router.post("/reviews/{review_id}/reject")
def reject(review_id: str, body: ReviewIn, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    return _decide(review_id, False, body.note, db, admin)


@router.get("/documents/{doc_id}/file")
def view_document(doc_id: str, download: bool = False, db: Session = Depends(get_db),
                  admin: str = Depends(require_admin)):
    """Secure View streams the decrypted file (no public URL). Download only when policy allows."""
    d = db.get(Document, doc_id)
    if not d:
        raise HTTPException(404, "not_found")
    if d.file_state != "stored":
        raise HTTPException(410, "file_deleted")
    if download and not get_settings().allow_download:
        raise HTTPException(403, "download_disabled")
    data = get_file(d.storage_key)
    services.audit(db, admin, "document_downloaded" if download else "document_viewed", "document", d.id)
    db.commit()
    safe = re.sub(r"[^\w.\-]", "_", d.filename)
    return Response(content=data, media_type=d.mime, headers={
        "Content-Disposition": f'{"attachment" if download else "inline"}; filename="{safe}"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/documents/{doc_id}/delete-file")
@router.delete("/documents/{doc_id}/file")
def delete_document_file(doc_id: str, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    """Admin action: permanently delete the stored encrypted file for a document (e.g. rejected or obsolete)."""
    d = db.get(Document, doc_id)
    if not d:
        raise HTTPException(404, "not_found")
    services.mark_document_file_deleted(db, d, admin)
    db.commit()
    return {"id": d.id, "file_state": d.file_state}


@router.get("/audit")
def audit_log(limit: int = Query(100, le=500), db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit))
    return [{"id": a.id, "at": a.created_at, "actor": a.actor, "action": a.action,
             "entity_type": a.entity_type, "entity_id": a.entity_id, "details": a.details} for a in rows]
