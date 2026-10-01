"""Customer upload portal. The random token is the identity; only that customer's data is visible."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import services
from .config import get_settings
from .db import get_db
from .doc_types import label
from .models import AccessToken, Customer, Document
from .rate_limiter import rate_limit_portal, rate_limit_upload

router = APIRouter(prefix="/api/portal/{token}", tags=["portal"])

FRIENDLY = {"resubmit": "Please upload a clear, valid copy again."}


class OtpVerifyBody(BaseModel):
    code: str


def _customer_and_token(db: Session, token: str, *, require_open: bool = False) -> tuple[Customer, AccessToken]:
    t = services.resolve_token(db, token, "upload")
    if not t:
        raise HTTPException(404, "invalid_or_expired_link")
    c = db.get(Customer, t.customer_id)
    if not c:
        raise HTTPException(404, "invalid_or_expired_link")
    if c.consent_status != "granted":
        raise HTTPException(403, "consent_required")
    if require_open and c.case_status != "in_progress":
        raise HTTPException(409, "case_not_open")
    return c, t


def _customer(db: Session, token: str, *, require_open: bool = False) -> Customer:
    c, _ = _customer_and_token(db, token, require_open=require_open)
    return c


@router.get("", dependencies=[Depends(rate_limit_portal)])
def portal_state(token: str, db: Session = Depends(get_db)):
    s = get_settings()
    c, t = _customer_and_token(db, token)
    items = services.required_status(db, c.id)
    otp_verified = True
    if s.upload_otp_enabled:
        otp_verified = services.is_upload_otp_verified(db, c.id, t.id)
    return {
        "first_name": c.name.split()[0],
        "case_status": c.case_status,
        "documents": items,
        "pending_count": sum(1 for i in items if i["state"] != "verified"),
        "allowed_types": ["pdf", "png", "jpg", "jpeg"],
        "max_upload_mb": s.max_upload_mb,
        "otp_required": s.upload_otp_enabled and not otp_verified,
        "otp_verified": otp_verified,
        "masked_email": services.mask_email(c.email) if s.upload_otp_enabled else None,
    }


@router.post("/otp/send", dependencies=[Depends(rate_limit_portal)])
def send_otp(token: str, db: Session = Depends(get_db)):
    s = get_settings()
    if not s.upload_otp_enabled:
        return {"sent": False, "message": "Upload OTP is not enabled"}
    c, t = _customer_and_token(db, token, require_open=True)
    masked = services.generate_and_send_upload_otp(db, c, t.id)
    db.commit()
    return {"sent": True, "masked_email": masked}


@router.post("/otp/verify", dependencies=[Depends(rate_limit_portal)])
def verify_otp(token: str, body: OtpVerifyBody, db: Session = Depends(get_db)):
    s = get_settings()
    if not s.upload_otp_enabled:
        return {"verified": True}
    c, t = _customer_and_token(db, token, require_open=True)
    ok = services.verify_upload_otp(db, c, t, body.code)
    if not ok:
        raise HTTPException(400, {"code": "invalid_or_expired_otp", "message": "Invalid or expired verification code."})
    db.commit()
    return {"verified": True}


@router.post("/upload", status_code=202, dependencies=[Depends(rate_limit_upload)])
def upload(token: str, doc_type: str = Form(...), file: UploadFile = File(...), db: Session = Depends(get_db)):
    s = get_settings()
    c, t = _customer_and_token(db, token, require_open=True)
    if s.upload_otp_enabled and not services.is_upload_otp_verified(db, c.id, t.id):
        raise HTTPException(403, {"code": "otp_required", "message": "Email OTP verification required before uploading."})
    data = file.file.read(s.max_upload_mb * 1024 * 1024 + 1)
    try:
        doc = services.accept_upload(db, c, doc_type, file.filename or "upload", data)
    except services.UploadError as e:
        db.rollback()
        raise HTTPException(e.status, {"code": e.code, "message": e.message})
    db.commit()
    return {"document_id": doc.id, "doc_type": doc.doc_type, "label": label(doc.doc_type),
            "state": services.customer_state_for_doc(doc)}


@router.get("/documents/{doc_id}/status", dependencies=[Depends(rate_limit_portal)])
def document_status(token: str, doc_id: str, db: Session = Depends(get_db)):
    c = _customer(db, token)
    doc = db.get(Document, doc_id)
    if not doc or doc.customer_id != c.id:
        raise HTTPException(404, "not_found")
    state = services.customer_state_for_doc(doc)
    return {"document_id": doc.id, "state": state, "message": FRIENDLY.get(state)}
