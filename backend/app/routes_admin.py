"""Admin API (Supabase JWT + ADMIN_EMAILS). Staff never touch the storage bucket directly."""

import re

from typing import Literal



from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from fastapi.responses import Response

from pydantic import BaseModel

from sqlalchemy import func, select

from sqlalchemy.exc import SQLAlchemyError

import logging

from sqlalchemy.orm import Session



from . import excel_import, services

from .config import get_settings

from .db import get_db

from .doc_types import label

from .models import AuditLog, Customer, Document, Job, ManualReview, OcrResult

from .security import require_admin

from .storage import get_file



router = APIRouter(prefix="/api/admin", tags=["admin"])

log = logging.getLogger("docpilot.admin")


class CustomerIn(BaseModel):
    """Shape only; normalization and business validation live in services.create_customer."""

    name: str

    email: str

    mobile: str | None = None

    required_documents: list[str]

    send_consent: bool = True





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
    if with_docs:
        docs = list(db.scalars(select(Document).where(Document.customer_id == c.id).order_by(Document.created_at.desc())))
        req = services.required_status(db, c.id, customer=c, all_docs=docs)
    else:
        docs = []
        req = services.required_status(db, c.id, customer=c)
    out = {
        "id": c.id, "code": c.code, "name": c.name, "email": c.email, "mobile": c.mobile,
        "consent_status": c.consent_status, "case_status": c.case_status, "workflow_state": c.workflow_state,
        "created_at": c.created_at,
        "completed_at": c.completed_at, "delete_after": c.delete_after, "data_deleted_at": c.data_deleted_at,
        "required": req, "required_count": len(req),
        "received_count": sum(1 for r in req if r["state"] == "verified"),
        "pending_count": sum(1 for r in req if r["state"] != "verified"),
        "allow_download": get_settings().allow_download,
    }
    if with_docs:
        out["documents"] = [doc_out(d, c) for d in docs]
    return out





@router.get("/summary")

def summary(db: Session = Depends(get_db), admin: str = Depends(require_admin)):

    by_case = dict(db.execute(select(Customer.case_status, func.count()).group_by(Customer.case_status)).all())

    by_ver = dict(db.execute(select(Document.verification_status, func.count())

                             .where(Document.superseded.is_(False)).group_by(Document.verification_status)).all())

    open_reviews = db.scalar(select(func.count()).select_from(ManualReview).where(ManualReview.status == "open")) or 0

    jobs = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())



    total_cases = sum(by_case.values())

    completed_cases = by_case.get("completed", 0)

    completion_rate = round((completed_cases / total_cases) * 100, 1) if total_cases > 0 else 0.0



    total_docs = db.scalar(select(func.count()).select_from(Document).where(Document.superseded.is_(False))) or 0

    processing_docs = db.scalar(select(func.count()).select_from(Document)

                                .where(Document.ocr_status == "processing", Document.superseded.is_(False))) or 0

    ocr_failures = db.scalar(select(func.count()).select_from(Document)

                             .where(Document.ocr_status == "failed", Document.superseded.is_(False))) or 0



    return {

        "cases": by_case,

        "documents": by_ver,

        "open_reviews": open_reviews,

        "jobs": jobs,

        "metrics": {

            "total_customers": total_cases,

            "completed_customers": completed_cases,

            "completion_rate": completion_rate,

            "total_documents": total_docs,

            "verified_documents": by_ver.get("verified", 0),

            "pending_review_documents": open_reviews,

            "processing_documents": processing_docs,

            "ocr_failures": ocr_failures,

        },

    }





@router.get("/documents")

def list_documents(response: Response, q: str | None = None, doc_type: str | None = None,

                   verification_status: str | None = None, ocr_status: str | None = None,

                   customer_id: int | None = None,

                   limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),

                   db: Session = Depends(get_db), admin: str = Depends(require_admin)):

    """Global documents list with filtering per PDF Section 8."""

    from sqlalchemy import or_

    query = select(Document, Customer).join(Customer, Document.customer_id == Customer.id)

    if customer_id:

        query = query.where(Document.customer_id == customer_id)

    if doc_type:

        query = query.where(Document.doc_type == doc_type)

    if verification_status:

        query = query.where(Document.verification_status == verification_status)

    if ocr_status:

        query = query.where(Document.ocr_status == ocr_status)

    if q and q.strip():

        term = f"%{q.strip().lower()}%"

        query = query.where(or_(

            func.lower(Customer.name).like(term),

            func.lower(Customer.email).like(term),

            func.lower(Document.filename).like(term),

        ))



    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0

    response.headers["X-Total-Count"] = str(total)

    rows = db.execute(query.order_by(Document.created_at.desc()).limit(limit).offset(offset)).all()



    out = []

    for doc, cust in rows:

        item = doc_out(doc, cust)

        item["customer_id"] = cust.id

        item["customer_name"] = cust.name

        item["customer_code"] = cust.code

        item["customer_email"] = cust.email

        out.append(item)

    return out







@router.post("/customers", status_code=201)

def create_customer(body: CustomerIn, db: Session = Depends(get_db), admin: str = Depends(require_admin)):

    try:
        c = services.create_customer(db, body.name, body.email, body.mobile, body.required_documents, admin)
        db.commit()  # customer + checklist + audit commit atomically
    except services.CustomerError as e:
        db.rollback()
        raise HTTPException(e.status, {"code": e.code, "message": e.message})
    except SQLAlchemyError:
        db.rollback()
        log.error("customer_create_failed")
        raise HTTPException(500, {"code": "create_failed", "message": "Could not create customer."})
    if body.send_consent:
        try:
            services.send_consent_email(db, c)
            db.commit()
        except Exception:
            db.rollback()
            log.warning("consent_email_failed customer_id=%s", c.id)
    return customer_out(db, c)


def _read_import(file: UploadFile, db: Session) -> list[excel_import.RowResult]:
    data = file.file.read(excel_import.MAX_BYTES + 1)  # bounded read, kept in memory only
    try:
        rows = excel_import.parse_workbook(file.filename, data)
    except excel_import.ImportFileError as e:
        raise HTTPException(e.status, {"code": e.code, "message": e.message})
    finally:
        del data
    return excel_import.evaluate(db, rows)


@router.post("/customers/import/preview")
def import_preview(file: UploadFile = File(...), db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    """Validate an .xlsx without writing anything or sending any email."""
    results = _read_import(file, db)
    db.rollback()
    detected = sorted({k for r in results if r.status == "valid" for k in r.required_documents})
    return {**excel_import.summary(results), "document_types_detected": detected,
            "rows": [r.out() for r in results]}


@router.post("/customers/import")
def import_customers(file: UploadFile = File(...), db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    """Re-validate, then create all valid rows in one transaction; consent emails only after commit."""
    results = _read_import(file, db)
    s = excel_import.summary(results)
    valid = [r for r in results if r.status == "valid"]
    created: list[tuple[excel_import.RowResult, Customer]] = []
    try:
        for r in valid:
            created.append((r, services.insert_customer(db, r.name, r.email, r.mobile, r.required_documents, admin)))
        services.audit(db, admin, "customers_imported", "import", None, {
            "total": s["total_rows"], "imported": len(created), "rejected": s["invalid_rows"],
            "duplicates": s["duplicate_rows"], "failed": 0})
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        log.error("customer_import_failed rows=%s", len(valid))
        try:
            services.audit(db, admin, "customers_import_failed", "import", None, {
                "total": s["total_rows"], "imported": 0, "rejected": s["invalid_rows"],
                "duplicates": s["duplicate_rows"], "failed": len(valid)})
            db.commit()
        except SQLAlchemyError:
            db.rollback()
        raise HTTPException(500, {"code": "import_failed", "message": "Import failed. No customers were created."})
    log.info("customer_import_committed imported=%s total=%s", len(created), s["total_rows"])

    email_failures: list[dict] = []
    sent = 0
    for r, c in created:
        if not r.send_consent:
            continue
        try:
            services.send_consent_email(db, c)
            db.commit()
            sent += 1
        except Exception:
            db.rollback()
            log.warning("consent_email_failed customer_id=%s", c.id)
            email_failures.append({"row": r.row, "customer_id": c.id, "code": "email_failed"})
    return {
        "total_rows": s["total_rows"], "imported": len(created), "rejected": s["invalid_rows"],
        "duplicates": s["duplicate_rows"], "failed": 0,
        "email_sent": sent, "email_failed": len(email_failures), "email_failures": email_failures,
        "created": [{"row": r.row, "id": c.id, "code": c.code} for r, c in created],
        "rows": [r.out() for r in results],
    }





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
def list_reviews(status: Literal["open", "approved", "rejected", "all"] = "open", db: Session = Depends(get_db),
                 admin: str = Depends(require_admin)):
    query = select(ManualReview)
    if status != "all":
        query = query.where(ManualReview.status == status)
    reviews = list(db.scalars(query.order_by(ManualReview.created_at)))
    services.audit(db, admin, "manual_review_opened", "system", "review_queue", {"status": status})
    db.commit()
    if not reviews:
        return []

    doc_ids = [r.document_id for r in reviews]
    cust_ids = [r.customer_id for r in reviews]

    docs_map = {d.id: d for d in db.scalars(select(Document).where(Document.id.in_(doc_ids)))}
    custs_map = {c.id: c for c in db.scalars(select(Customer).where(Customer.id.in_(cust_ids)))}
    ocr_map = {o.document_id: o for o in db.scalars(select(OcrResult).where(OcrResult.document_id.in_(doc_ids)))}

    out = []
    for r in reviews:
        d = docs_map.get(r.document_id)
        c = custs_map.get(r.customer_id)
        if not d or not c:
            continue
        ocr_row = ocr_map.get(d.id)
        ocr_evidence = ocr_row.payload if ocr_row else None
        resub_status = "eligible_for_resubmission" if d.verification_status in ("rejected", "manual_review") else "none"
        out.append({
            "id": r.id,
            "status": r.status,
            "reason": r.reason,
            "flags": r.flags,
            "created_at": r.created_at,
            "customer_id": c.id,
            "customer_code": c.code,
            "customer_name": c.name,
            "document": doc_out(d, c),
            "ocr_evidence": ocr_evidence,
            "resubmission_status": resub_status,
        })
    return out


@router.get("/reviews/{review_id}")
def get_review(review_id: str, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    r = db.get(ManualReview, review_id)
    if not r:
        raise HTTPException(404, "not_found")
    d = db.get(Document, r.document_id)
    c = db.get(Customer, r.customer_id)
    if not d or not c:
        raise HTTPException(404, "not_found")
    ocr_row = db.scalar(select(OcrResult).where(OcrResult.document_id == d.id))
    ocr_evidence = ocr_row.payload if ocr_row else None
    resub_status = "eligible_for_resubmission" if d.verification_status in ("rejected", "manual_review") else "none"

    services.audit(db, admin, "manual_review_opened", "manual_review", r.id, {"document_id": d.id})
    db.commit()
    return {
        "id": r.id,
        "status": r.status,
        "reason": r.reason,
        "flags": r.flags,
        "created_at": r.created_at,
        "customer_id": c.id,
        "customer_code": c.code,
        "customer_name": c.name,
        "document": doc_out(d, c),
        "ocr_evidence": ocr_evidence,
        "resubmission_status": resub_status,
    }


def _decide(review_id: str, approve: bool, note: str | None, db: Session, admin: str):
    r = db.get(ManualReview, review_id)
    if not r:
        raise HTTPException(404, "not_found")
    if r.status != "open":
        raise HTTPException(409, "already_decided")
    try:
        services.decide_review(db, r, approve, admin, note)
    except ValueError as e:
        err_msg = str(e)
        if err_msg in ("already_decided", "document_superseded"):
            raise HTTPException(409, err_msg)
        elif err_msg in ("document_not_available", "customer_deleted"):
            raise HTTPException(410, err_msg)
        elif err_msg == "consent_withdrawn":
            raise HTTPException(400, err_msg)
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


class OCRConfigIn(BaseModel):
    ocr_url: str | None = None
    ocr_api_key: str | None = None


@router.get("/settings/ocr")
def get_ocr_settings(admin: str = Depends(require_admin)):
    """Return current OCR endpoint and masked API key status."""
    s = get_settings()
    has_key = bool(s.ocr_api_key)
    masked_key = f"{s.ocr_api_key[:4]}••••••••••••••••••••••••" if len(s.ocr_api_key) >= 4 else ("••••••••" if has_key else "")
    return {
        "ocr_url": s.ocr_url,
        "has_api_key": has_key,
        "masked_api_key": masked_key,
        "mock_ocr_mode": s.mock_ocr_mode,
        "timeout_seconds": s.ocr_timeout_seconds,
    }


@router.put("/settings/ocr")
def update_ocr_settings(payload: OCRConfigIn, db: Session = Depends(get_db), admin: str = Depends(require_admin)):
    """Update active OCR endpoint and API key in runtime and persist to .env."""
    from pathlib import Path
    s = get_settings()
    updated = {}

    if payload.ocr_url is not None:
        new_url = payload.ocr_url.strip()
        if new_url:
            s.ocr_url = new_url
            updated["ocr_url"] = new_url

    if payload.ocr_api_key is not None:
        new_key = payload.ocr_api_key.strip()
        s.ocr_api_key = new_key
        updated["ocr_api_key"] = "[UPDATED]"

    # Persist changes to .env file if it exists
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists() and (payload.ocr_url is not None or payload.ocr_api_key is not None):
        try:
            content = env_path.read_text(encoding="utf-8")
            if payload.ocr_url is not None and payload.ocr_url.strip():
                content = re.sub(r"^OCR_URL=.*$", f"OCR_URL={payload.ocr_url.strip()}", content, flags=re.MULTILINE)
            if payload.ocr_api_key is not None:
                content = re.sub(r"^OCR_API_KEY=.*$", f"OCR_API_KEY={payload.ocr_api_key.strip()}", content, flags=re.MULTILINE)
            env_path.write_text(content, encoding="utf-8")
        except Exception:
            pass

    services.audit(db, admin, "ocr_settings_updated", "system", None, details={"updated": list(updated.keys())})
    db.commit()

    has_key = bool(s.ocr_api_key)
    masked_key = f"{s.ocr_api_key[:4]}••••••••••••••••••••••••" if len(s.ocr_api_key) >= 4 else ("••••••••" if has_key else "")
    return {
        "status": "ok",
        "ocr_url": s.ocr_url,
        "has_api_key": has_key,
        "masked_api_key": masked_key,
    }


@router.post("/settings/ocr/test")
def test_ocr_connection(payload: OCRConfigIn | None = None, admin: str = Depends(require_admin)):
    """Test connectivity to the OCR model service."""
    import httpx
    s = get_settings()
    test_url = (payload.ocr_url.strip() if payload and payload.ocr_url else s.ocr_url).rstrip("/")
    test_key = (payload.ocr_api_key.strip() if payload and payload.ocr_api_key is not None else s.ocr_api_key)
    headers = {"Authorization": f"Bearer {test_key}"} if test_key else {}

    try:
        # Test either root / or /health or /ocr/pan ping
        r = httpx.get(f"{test_url}/health", headers=headers, timeout=httpx.Timeout(5.0, connect=3.0))
        if r.status_code == 200:
            return {"connected": True, "status_code": r.status_code, "message": "OCR service reachable (/health 200 OK)"}
    except Exception:
        pass

    try:
        r = httpx.get(test_url, headers=headers, timeout=httpx.Timeout(5.0, connect=3.0))
        if r.status_code < 500:
            return {"connected": True, "status_code": r.status_code, "message": f"OCR service reachable (HTTP {r.status_code})"}
        return {"connected": False, "status_code": r.status_code, "message": f"OCR service returned HTTP {r.status_code}"}
    except Exception as e:
        return {"connected": False, "status_code": 0, "message": f"Connection failed: {str(e)}"}

