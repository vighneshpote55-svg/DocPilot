"""Regression tests for Worker Supervision, Observability Metrics, and Failure Alerting."""
from datetime import timedelta
import signal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app import db as dbmod, jobs, worker
from app.config import get_settings
from app.main import create_app
from app.models import Job


def test_graceful_shutdown_signal_handler(env):
    """Verify that SIGTERM/SIGINT handler cleanly sets _running to False."""
    worker._running = True
    assert worker._running is True

    # Simulate receiving SIGTERM
    worker._handle_shutdown(signal.SIGTERM, None)
    assert worker._running is False

    # Reset
    worker._running = True


def test_eager_encryption_key_validation_failure(env):
    """Verify that worker startup immediately aborts if ENCRYPTION_KEY is invalid."""
    with patch("app.security._key", side_effect=RuntimeError("ENCRYPTION_KEY is not set")):
        with pytest.raises(SystemExit) as exc:
            worker.main()
        assert exc.value.code == 1


def test_get_queue_metrics_and_admin_summary(env):
    """Verify queue metrics calculation and inclusion in GET /api/admin/summary."""
    from tests.conftest import admin_headers

    with dbmod.session_scope() as db:
        # Clean existing jobs
        db.query(Job).delete()

        # 1 queued job due 30 seconds ago
        j_queued = Job(
            kind="process_document",
            payload={"doc": 1},
            status="queued",
            run_at=dbmod.utcnow() - timedelta(seconds=30),
        )
        # 1 running job active 10 seconds
        j_running = Job(
            kind="process_document",
            payload={"doc": 2},
            status="running",
            locked_at=dbmod.utcnow() - timedelta(seconds=10),
        )
        # 1 stalled job running 25 minutes (exceeds 15m lease)
        j_stuck = Job(
            kind="process_document",
            payload={"doc": 3},
            status="running",
            locked_at=dbmod.utcnow() - timedelta(minutes=25),
        )
        # 1 failed job
        j_failed = Job(
            kind="process_document",
            payload={"doc": 4},
            status="failed",
            attempts=3,
        )
        # 1 done job
        j_done = Job(
            kind="process_document",
            payload={"doc": 5},
            status="done",
        )
        db.add_all([j_queued, j_running, j_stuck, j_failed, j_done])

    with dbmod.session_scope() as db:
        metrics = jobs.get_queue_metrics(db)
        assert metrics["queued_jobs"] == 1
        assert metrics["running_jobs"] == 2
        assert metrics["stalled_jobs"] == 1
        assert metrics["failed_jobs"] == 1
        assert metrics["done_jobs"] == 1
        assert metrics["oldest_queued_age_seconds"] >= 25.0
        assert metrics["oldest_running_duration_seconds"] >= 1400.0  # > 23 mins

    # Verify admin summary API endpoint includes queue_metrics
    client = TestClient(create_app())
    res = client.get("/api/admin/summary", headers=admin_headers())
    assert res.status_code == 200
    data = res.json()
    assert "queue_metrics" in data
    qm = data["queue_metrics"]
    assert qm["queued_jobs"] == 1
    assert qm["stalled_jobs"] == 1
    assert qm["failed_jobs"] == 1


def test_webhook_alert_dispatch_mock(env):
    """Verify that alert_failed_job posts JSON to configured webhook without real external network calls."""
    dispatched = []

    def mock_post(url, json=None, timeout=None):
        dispatched.append({"url": url, "payload": json})
        resp = MagicMock()
        resp.status_code = 200
        return resp

    mock_job = MagicMock()
    mock_job.id = 999
    mock_job.kind = "process_document"
    mock_job.attempts = 3
    mock_job.max_attempts = 3

    with patch("app.jobs.get_settings") as mock_settings:
        s = get_settings()
        mock_settings.return_value = s
        s.alert_webhook_url = "http://internal-ops-webhook.local/alerts"

        with patch("httpx.post", side_effect=mock_post):
            jobs.alert_failed_job(mock_job, "critical OCR worker OOM failure")

    assert len(dispatched) == 1
    assert dispatched[0]["url"] == "http://internal-ops-webhook.local/alerts"
    payload = dispatched[0]["payload"]
    assert payload["alert"] == "job_failed"
    assert payload["job_id"] == 999
    assert payload["kind"] == "process_document"
    assert "critical OCR worker OOM failure" in payload["error"]
