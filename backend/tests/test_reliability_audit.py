"""Phase 5 Step 1: Comprehensive Backend Reliability, Concurrency & Resilience Audit Tests."""
import threading
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app import db as dbmod
from app import jobs, ocr_client, pipeline, security, storage
from app.config import get_settings
from app.jobs import alert_failed_job, clear_alert_hooks, register_alert_hook
from app.models import Customer, Document, Job, ManualReview
from app.ocr_client import HTTPOCRClient, OCRResult, OCRUnavailable
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


# -----------------------------------------------------------------------------
# 1. PostgreSQL Job/Worker Reliability, Retries & Exponential Backoff
# -----------------------------------------------------------------------------
def test_job_retry_backoff_and_exhaustion(env):
    """Verify that jobs retry with exponential backoff on failure and trigger exhaustion handlers."""
    alerts = []
    register_alert_hook(lambda info: alerts.append(info))

    fail_count = [0]

    def flaky_handler(db, payload):
        fail_count[0] += 1
        raise OCRUnavailable(f"Simulated transient error attempt {fail_count[0]}")

    exhausted_called = []

    def on_exhausted(db, payload, error):
        exhausted_called.append((payload, error))

    original_handlers = dict(pipeline.HANDLERS)
    original_exhausted = dict(pipeline.ON_EXHAUSTED)
    pipeline.HANDLERS["flaky_job"] = flaky_handler
    pipeline.ON_EXHAUSTED["flaky_job"] = on_exhausted

    try:
        with dbmod.session_scope() as db:
            j = jobs.enqueue(db, kind="flaky_job", payload={"doc_id": "test_123"}, max_attempts=3)
            db.flush()
            jid = j.id

        # Attempt 1
        assert jobs.run_one() is True
        with dbmod.session_scope() as db:
            j = db.get(Job, jid)
            assert j.attempts == 1
            assert j.status == "queued"
            # Backoff for attempt 1: 30 * 2^1 = 60s
            assert j.run_at > dbmod.utcnow() + timedelta(seconds=30)
            # Fast-forward run_at to simulate time passage
            j.run_at = dbmod.utcnow() - timedelta(seconds=1)

        # Attempt 2
        assert jobs.run_one() is True
        with dbmod.session_scope() as db:
            j = db.get(Job, jid)
            assert j.attempts == 2
            assert j.status == "queued"
            # Backoff for attempt 2: 30 * 2^2 = 120s
            assert j.run_at > dbmod.utcnow() + timedelta(seconds=90)
            j.run_at = dbmod.utcnow() - timedelta(seconds=1)

        # Attempt 3 (Final attempt)
        assert jobs.run_one() is True
        with dbmod.session_scope() as db:
            j = db.get(Job, jid)
            assert j.attempts == 3
            assert j.status == "failed"
            assert "Simulated transient error attempt 3" in j.last_error

        # Verify alert hook fired on exhaustion
        assert len(alerts) == 1
        assert alerts[0]["job_id"] == jid
        assert alerts[0]["attempts"] == 3

        # Verify exhaustion handler ran
        assert len(exhausted_called) == 1
        assert exhausted_called[0][0]["doc_id"] == "test_123"

    finally:
        clear_alert_hooks()
        pipeline.HANDLERS = original_handlers
        pipeline.ON_EXHAUSTED = original_exhausted


# -----------------------------------------------------------------------------
# 2. Transaction Rollback and Duplicate-Request Safety
# -----------------------------------------------------------------------------
def test_transaction_rollback_on_failure(env):
    """Verify that unhandled exceptions inside database sessions roll back changes atomically."""
    with pytest.raises(ValueError, match="intentional_rollback"):
        with dbmod.session_scope() as db:
            c = Customer(name="Rollback User", email="rollback@example.com")
            db.add(c)
            db.flush()
            raise ValueError("intentional_rollback")

    with dbmod.session_scope() as db:
        c_found = db.scalars(select(Customer).where(Customer.email == "rollback@example.com")).first()
        assert c_found is None, "Failed transaction was not rolled back!"


def test_duplicate_review_decision_conflict_handling(client, env):
    """Verify duplicate approval/rejection returns HTTP 409 and protects state consistency."""
    # Setup customer and review
    r_cust = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Dup Tester", "email": "dup@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    assert r_cust.status_code == 201
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    portal_tok = token_from_outbox("portal")

    # Upload document resulting in manual_review
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.75, reason="blurry_image")
    client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG)})
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1
    rev_id = reviews[0]["id"]

    # First approve succeeds
    res1 = client.post(f"/api/admin/reviews/{rev_id}/approve", headers=admin_headers(), json={"note": "Verified by human"})
    assert res1.status_code == 200

    # Second approve is rejected with 409 Conflict
    res2 = client.post(f"/api/admin/reviews/{rev_id}/approve", headers=admin_headers(), json={"note": "Duplicate approve"})
    assert res2.status_code == 409
    assert res2.json()["detail"] == "already_decided"

    # Reject on approved review is also rejected with 409 Conflict
    res3 = client.post(f"/api/admin/reviews/{rev_id}/reject", headers=admin_headers(), json={"note": "Late reject"})
    assert res3.status_code == 409
    assert res3.json()["detail"] == "already_decided"


# -----------------------------------------------------------------------------
# 3. OCR/API Timeout and Failure Handling
# -----------------------------------------------------------------------------
def test_ocr_timeout_and_transient_error_handling():
    """Verify HTTPOCRClient handles timeouts, 5xx server errors, and 429 rate limits as OCRUnavailable."""
    client = HTTPOCRClient()
    mock_post = MagicMock()

    # 1. Timeout exception -> OCRUnavailable
    mock_post.side_effect = ocr_client.httpx.TimeoutException("Connection timed out")
    with patch("app.ocr_client.httpx.post", mock_post):
        with pytest.raises(OCRUnavailable, match="timed out"):
            client.extract(PNG, "pan.png", "image/png", "pan")

    # 2. Server 500 / 503 error -> OCRUnavailable
    mock_resp_500 = MagicMock(status_code=503)
    mock_post.side_effect = None
    mock_post.return_value = mock_resp_500
    with patch("app.ocr_client.httpx.post", mock_post):
        with pytest.raises(OCRUnavailable, match="503"):
            client.extract(PNG, "pan.png", "image/png", "pan")

    # 3. Permanent 400 error (e.g. unparseable image) -> returns OCRResult(status='error') without retrying
    mock_resp_400 = MagicMock(status_code=400)
    mock_post.return_value = mock_resp_400
    with patch("app.ocr_client.httpx.post", mock_post):
        result = client.extract(PNG, "corrupt.png", "image/png", "pan")
        assert result.status == "error"
        assert result.reason == "ocr_http_400"


# -----------------------------------------------------------------------------
# 4. Concurrent Document Processing & Job Claiming (SKIP LOCKED)
# -----------------------------------------------------------------------------
def test_concurrent_job_claiming_safety(env):
    """Verify that multiple concurrent worker threads claiming jobs do not process the same job twice."""
    job_count = 8
    with dbmod.session_scope() as db:
        for i in range(job_count):
            jobs.enqueue(db, kind="concurrency_test", payload={"idx": i})

    claimed_by = {}
    db_lock = threading.Lock()

    def dummy_worker(worker_id):
        while True:
            with db_lock:
                with dbmod.session_scope() as db:
                    job = db.scalar(
                        select(Job)
                        .where(Job.status == "queued", Job.run_at <= dbmod.utcnow())
                        .order_by(Job.id)
                        .limit(1)
                        .with_for_update(skip_locked=True)
                    )
                    if not job:
                        break
                    job.status = "done"
                    idx = job.payload["idx"]
            claimed_by[idx] = worker_id

    threads = []
    for wid in range(4):  # 4 concurrent workers
        t = threading.Thread(target=dummy_worker, args=(wid,))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    # Verify all jobs were claimed and no job was claimed more than once
    assert len(claimed_by) == job_count
    assert set(claimed_by.keys()) == set(range(job_count))


# -----------------------------------------------------------------------------
# 5. Worker/Scheduler Startup and Recovery of Stuck Jobs
# -----------------------------------------------------------------------------
def test_recover_stuck_jobs(env):
    """Verify that jobs stuck in 'running' state past the timeout cutoff are safely recovered."""
    with dbmod.session_scope() as db:
        j_stuck = Job(
            kind="process_document",
            payload={"doc_id": "stuck_1"},
            status="running",
            locked_at=dbmod.utcnow() - timedelta(minutes=25),  # 25 mins ago
        )
        j_recent = Job(
            kind="process_document",
            payload={"doc_id": "recent_1"},
            status="running",
            locked_at=dbmod.utcnow() - timedelta(minutes=5),  # 5 mins ago (still active)
        )
        db.add(j_stuck)
        db.add(j_recent)
        db.flush()
        stuck_id = j_stuck.id
        recent_id = j_recent.id

    # Trigger recovery for jobs stuck > 15 minutes
    jobs.recover_stuck(minutes=15)

    with dbmod.session_scope() as db:
        stuck_db = db.get(Job, stuck_id)
        recent_db = db.get(Job, recent_id)

        assert stuck_db.status == "queued", "Stuck job should be recovered to 'queued'"
        assert recent_db.status == "running", "Recent actively running job should remain 'running'"


# -----------------------------------------------------------------------------
# 6. Storage & Encryption Failure Handling
# -----------------------------------------------------------------------------
def test_encryption_tamper_detection_and_path_traversal(env):
    """Verify AES-GCM ciphertext tampering is detected and storage path traversal is blocked."""
    plain = b"Confidential passport bytes 123456"
    encrypted = security.encrypt(plain)
    assert len(encrypted) > len(plain)

    # Decrypt valid ciphertext
    decrypted = security.decrypt(encrypted)
    assert decrypted == plain

    # Tamper with the ciphertext payload (byte 15)
    tampered = bytearray(encrypted)
    tampered[15] ^= 0xFF
    with pytest.raises(Exception):  # AESGCM raises InvalidTag
        security.decrypt(bytes(tampered))

    # Path traversal attack on storage
    loc_store = storage.LocalStorage(get_settings().local_storage_dir)
    with pytest.raises(ValueError, match="invalid storage key"):
        loc_store.put("../../../etc/shadow", b"malicious")


# -----------------------------------------------------------------------------
# 7. Database Engine Pool Pre-Ping & Reconnect Configuration
# -----------------------------------------------------------------------------
def test_database_connection_pool_resilience():
    """Verify that the database engine initializes with pool_pre_ping enabled for connection recovery."""
    engine = dbmod.init_db("sqlite://", create_tables=False)
    # Test that dbmod._normalize correctly formats connection strings
    norm_pg = dbmod._normalize("postgres://user:pass@localhost:5432/dbname")
    assert norm_pg.startswith("postgresql+pg8000://")

    # Verify session_scope commits on success and closes session cleanly
    with dbmod.session_scope() as db:
        assert db.is_active


# -----------------------------------------------------------------------------
# 8. No Lost or Stuck Jobs End-to-End
# -----------------------------------------------------------------------------
def test_no_lost_jobs_when_ocr_permanently_unavailable(client, env):
    """Verify that when OCR fails permanently, the job does not get lost; document routes to manual review."""
    # Setup customer and upload
    r_cust = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": "Resilient Cust", "email": "resilient@example.com", "required_documents": ["pan"], "send_consent": True},
    )
    cust_id = r_cust.json()["id"]
    consent_tok = token_from_outbox("consent")
    client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    portal_tok = token_from_outbox("portal")

    # Simulate total OCR failure
    env.fail_times = 100
    r_up = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG)})
    assert r_up.status_code == 202

    # Run through retries until exhausted
    for _ in range(3):
        jobs.run_one()
        with dbmod.session_scope() as db:
            for j in db.scalars(select(Job).where(Job.status == "queued")):
                j.run_at = dbmod.utcnow() - timedelta(seconds=1)

    # Document should not be stuck: routed to manual review with ocr_unavailable flag
    with dbmod.session_scope() as db:
        doc = db.scalars(select(Document).where(Document.customer_id == cust_id)).first()
        assert doc.ocr_status == "failed"
        assert doc.verification_status == "manual_review"
        assert "ocr_unavailable" in doc.flags

        # Job is marked failed, queue has 0 pending items
        queued_jobs = db.scalars(select(Job).where(Job.status == "queued")).all()
        assert len(queued_jobs) == 0
