"""Database-backed job queue. Workers claim jobs with FOR UPDATE SKIP LOCKED (Postgres)."""
import logging
from datetime import timedelta

from sqlalchemy import func, select

from .config import get_settings
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


def _dispatch_webhook_alert(info: dict) -> None:
    webhook_url = get_settings().alert_webhook_url
    if not webhook_url:
        return
    try:
        import httpx
        httpx.post(webhook_url, json=info, timeout=httpx.Timeout(5.0, connect=2.0))
    except Exception:
        log.exception("Failed to dispatch alert to webhook: %s", webhook_url)


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
    _dispatch_webhook_alert(info)
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
            job = db.get(Job, jid)
            if job:
                job.status = "done"
                job.locked_at = None
    except Exception as e:
        log.exception("job %s (%s) failed", jid, kind)
        with session_scope() as db:
            job = db.get(Job, jid)
            if not job:
                return True
            job.last_error = str(e)[:500]
            job.locked_at = None
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


def recover_stuck(minutes: int = 15) -> int:
    """Recover jobs stuck in 'running' state past the lease cutoff.

    If a job has reached or exceeded max_attempts (e.g. from repeated worker crashes
    or timeouts), it is marked 'failed', alerted, and its exhaustion handler is invoked.
    Otherwise, it is requeued with exponential backoff and its timeout recorded.
    """
    from . import pipeline

    recovered = 0
    with session_scope() as db:
        cutoff = utcnow() - timedelta(minutes=minutes)
        stuck_jobs = list(db.scalars(
            select(Job).where(
                Job.status == "running",
                (Job.locked_at < cutoff) | (Job.locked_at.is_(None))
            ).order_by(Job.id).with_for_update(skip_locked=True)
        ))
        for job in stuck_jobs:
            recovered += 1
            jid, kind, payload = job.id, job.kind, dict(job.payload or {})
            err_msg = f"stuck_job_timeout: execution exceeded {minutes}m lease"
            job.last_error = err_msg
            job.locked_at = None
            if job.attempts >= job.max_attempts:
                job.status = "failed"
                log.error("Job %s (%s) exceeded max_attempts (%d) via crash/timeout", job.id, job.kind, job.max_attempts)
                alert_failed_job(job, err_msg)
                handler = pipeline.ON_EXHAUSTED.get(kind)
                if handler:
                    try:
                        handler(db, payload, err_msg)
                    except Exception:
                        log.exception("on_exhausted handler failed during stuck job recovery for %s", job.id)
            else:
                job.status = "queued"
                job.run_at = utcnow() + timedelta(seconds=30 * (2 ** job.attempts))
                log.warning("Job %s (%s) recovered to queued (attempt %d/%d, run_at=%s)",
                            job.id, job.kind, job.attempts, job.max_attempts, job.run_at)
    return recovered


def get_queue_metrics(db) -> dict:
    """Compute queue observability metrics: depth, latency, running duration, and stalled count."""
    s = get_settings()
    now = utcnow()
    cutoff = now - timedelta(minutes=s.job_stuck_timeout_minutes)

    queued_count = db.scalar(select(func.count()).select_from(Job).where(Job.status == "queued")) or 0
    running_count = db.scalar(select(func.count()).select_from(Job).where(Job.status == "running")) or 0
    stalled_count = db.scalar(select(func.count()).select_from(Job).where(
        Job.status == "running",
        (Job.locked_at < cutoff) | (Job.locked_at.is_(None))
    )) or 0
    failed_count = db.scalar(select(func.count()).select_from(Job).where(Job.status == "failed")) or 0
    done_count = db.scalar(select(func.count()).select_from(Job).where(Job.status == "done")) or 0

    oldest_run_at = db.scalar(select(func.min(Job.run_at)).where(Job.status == "queued"))
    if oldest_run_at and oldest_run_at < now:
        oldest_queued_age_seconds = round((now - oldest_run_at).total_seconds(), 1)
    else:
        oldest_queued_age_seconds = 0.0

    oldest_running_locked_at = db.scalar(select(func.min(Job.locked_at)).where(Job.status == "running"))
    if oldest_running_locked_at and oldest_running_locked_at < now:
        oldest_running_duration_seconds = round((now - oldest_running_locked_at).total_seconds(), 1)
    else:
        oldest_running_duration_seconds = 0.0

    return {
        "queued_jobs": queued_count,
        "running_jobs": running_count,
        "stalled_jobs": stalled_count,
        "failed_jobs": failed_count,
        "done_jobs": done_count,
        "oldest_queued_age_seconds": oldest_queued_age_seconds,
        "oldest_running_duration_seconds": oldest_running_duration_seconds,
        "lease_timeout_minutes": s.job_stuck_timeout_minutes,
    }
