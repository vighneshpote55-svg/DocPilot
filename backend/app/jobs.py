"""Database-backed job queue. Workers claim jobs with FOR UPDATE SKIP LOCKED (Postgres)."""
import logging
from datetime import timedelta

from sqlalchemy import select

from .db import session_scope, utcnow
from .models import Job

log = logging.getLogger(__name__)


def enqueue(db, kind: str, payload: dict, max_attempts: int = 3, delay_seconds: int = 0) -> Job:
    job = Job(kind=kind, payload=payload, max_attempts=max_attempts, run_at=utcnow() + timedelta(seconds=delay_seconds))
    db.add(job)
    return job


ALERT_HOOKS: list = []


def register_alert_hook(fn) -> None:
    ALERT_HOOKS.append(fn)


def clear_alert_hooks() -> None:
    ALERT_HOOKS.clear()


def alert_failed_job(job: Job, error: str) -> None:
    info = {
        "alert": "job_failed",
        "job_id": job.id,
        "kind": job.kind,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "error": error[:500],
    }
    log.critical(
        "ALERT: job %s (%s) failed after %s attempts: %s",
        job.id, job.kind, job.attempts, error[:200],
        extra=info,
    )
    for hook in ALERT_HOOKS:
        try:
            hook(info)
        except Exception:
            log.exception("Alert hook failed")


def run_one() -> bool:
    """Run a single due job. Returns False when the queue is empty."""
    from . import pipeline

    with session_scope() as db:
        job = db.scalar(
            select(Job).where(Job.status == "queued", Job.run_at <= utcnow())
            .order_by(Job.id).limit(1).with_for_update(skip_locked=True)
        )
        if not job:
            return False
        job.status, job.locked_at = "running", utcnow()
        job.attempts += 1
        jid, kind, payload = job.id, job.kind, dict(job.payload or {})

    try:
        with session_scope() as db:
            pipeline.HANDLERS[kind](db, payload)
        with session_scope() as db:
            db.get(Job, jid).status = "done"
    except Exception as e:
        log.exception("job %s (%s) failed", jid, kind)
        with session_scope() as db:
            job = db.get(Job, jid)
            job.last_error = str(e)[:500]
            if job.attempts >= job.max_attempts:
                job.status = "failed"
                alert_failed_job(job, str(e))
                handler = pipeline.ON_EXHAUSTED.get(kind)
                if handler:
                    handler(db, payload, str(e))
            else:
                job.status = "queued"
                job.run_at = utcnow() + timedelta(seconds=30 * 2 ** job.attempts)
    return True


def run_all(limit: int = 1000) -> int:
    n = 0
    while n < limit and run_one():
        n += 1
    return n


def recover_stuck(minutes: int = 15) -> None:
    with session_scope() as db:
        cutoff = utcnow() - timedelta(minutes=minutes)
        for job in db.scalars(select(Job).where(Job.status == "running", Job.locked_at < cutoff)):
            job.status = "queued"
