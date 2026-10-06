"""Customer-facing, token-protected endpoints (consent + privacy requests)."""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from . import services
from .db import get_db
from .doc_types import label
from .models import Customer
from .rate_limiter import rate_limit_consent, rate_limit_privacy

router = APIRouter(prefix="/api/public", tags=["public"])
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ConsentBody(BaseModel):
    granted: bool


class PrivacyBody(BaseModel):
    email: str
    action: Literal["delete", "withdraw"]

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        if not EMAIL_RE.match(v.strip()):
            raise ValueError("invalid email")
        return v.strip().lower()


@router.get("/consent/{token}", dependencies=[Depends(rate_limit_consent)])
def consent_info(token: str, db: Session = Depends(get_db)):
    t = services.resolve_token(db, token, "consent")
    if not t:
        raise HTTPException(404, "invalid_or_expired_link")
    c = db.get(Customer, t.customer_id)
    return {
        "first_name": c.name.split()[0],
        "documents": [label(k) for k in services.pending_keys(db, c.id)],
        "purpose": "Identity and business document verification. Files are stored encrypted, "
                   "processed automatically, and permanently deleted after your case is completed.",
    }


@router.post("/consent/{token}", dependencies=[Depends(rate_limit_consent)])
def consent_submit(token: str, body: ConsentBody, db: Session = Depends(get_db)):
    t = services.resolve_token(db, token, "consent", consume=True)
    if not t:
        raise HTTPException(404, "invalid_or_expired_link")
    c = db.get(Customer, t.customer_id)
    try:
        upload_tok = services.record_consent(db, c, body.granted)
    except ValueError:
        raise HTTPException(409, "consent_already_recorded")
    db.commit()
    res = {"consent": "granted" if body.granted else "declined"}
    if upload_tok:
        res["upload_token"] = upload_tok
    return res


@router.post("/privacy/request", status_code=202, dependencies=[Depends(rate_limit_privacy)])
def privacy_request(body: PrivacyBody, db: Session = Depends(get_db)):
    services.start_privacy_request(db, body.email, body.action)
    db.commit()
    return {"message": "If this email is registered, a confirmation link has been sent."}


@router.post("/privacy/confirm/{token}", dependencies=[Depends(rate_limit_privacy)])
def privacy_confirm(token: str, db: Session = Depends(get_db)):
    action = services.confirm_privacy_request(db, token)
    if not action:
        raise HTTPException(404, "invalid_or_expired_link")
    db.commit()
    return {"completed": action}
