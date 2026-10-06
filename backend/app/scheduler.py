"""Periodic tasks: reminders, case expiry, retention deletion, token cleanup. Run by the worker."""
import logging
from datetime import timedelta

from sqlalchemy import delete, select

from . import emailer
from .config import get_settings
from .db import session_scope, utcnow
from .models import AccessToken, Customer
from .services import audit, delete_customer_files, pending_keys, recalc_case, send_upload_link

log = logging.getLogger(__name__)


def send_reminders(db) -> int:
    """3/7/14-day reminders, counted from consent, only while documents remain pending."""
    s, now, sent = get_settings(), utcnow(), 0
    for c in db.scalars(select(Customer).where(Customer.case_status == "in_progress")):
        if c.consent_status != "granted" or not c.consent_at:
            continue
        recalc_case(db, c)
        if c.case_status != "in_progress":
            continue
        pending = pending_keys(db, c.id)
        if not pending:
            continue
        days = (now - c.consent_at).days
        due = [d for d in s.reminder_day_list if d <= days]
        if not due:
            continue
        stage = max(due)
        if stage > c.last_reminder_stage:
            send_upload_link(db, c, reminder=True)
            c.last_reminder_stage = stage
            audit(db, "system", "reminder_sent", "customer", c.id, {"stage": stage, "pending_count": len(pending)})
            sent += 1
    return sent


def expire_cases(db) -> int:
    """Cases that never complete are closed and queued for deletion (the report leaves this undefined)."""
    now, n = utcnow(), 0
    for c in db.scalars(select(Customer).where(Customer.case_status == "in_progress", Customer.case_expires_at <= now)):
        c.case_status, c.delete_after = "expired", now
        audit(db, "system", "case_expired", "customer", c.id)
        n += 1
    return n


def delete_due(db_factory=session_scope) -> int:
    """Delete files for every case whose delete_after has passed. One customer per transaction."""
    with db_factory() as db:
        ids = [c.id for c in db.scalars(select(Customer).where(
            Customer.delete_after.is_not(None), Customer.delete_after <= utcnow(),
            Customer.data_deleted_at.is_(None), Customer.case_status != "deleted"))]
    done = 0
    for cid in ids:
        try:
            with db_factory() as db:
                c = db.get(Customer, cid)
                delete_customer_files(db, c)
                # Step 11 specific audit event
                audit(db, "system", "data_permanently_deleted", "customer", c.id)
                # Backward compatibility audit event
                audit(db, "system", "retention_deleted", "customer", c.id)
                emailer.deletion_confirmation(c.email, c.name)
            done += 1
        except Exception:
            log.exception("retention deletion failed for customer %s (will retry)", cid)
    return done


def tick() -> dict:
    out = {}
    with session_scope() as db:
        out["reminders"] = send_reminders(db)
        out["expired"] = expire_cases(db)
        db.execute(delete(AccessToken).where(AccessToken.expires_at < utcnow() - timedelta(days=1)))
    out["deleted"] = delete_due()
    return out
