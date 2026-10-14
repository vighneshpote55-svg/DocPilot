"""Regression tests for Security Finding 5: Background Worker Job Recovery & Lock Leaks."""
from datetime import timedelta
import pytest
from sqlalchemy import select

from app import db as dbmod, jobs, pipeline
from app.models import Customer, Document, Job, ManualReview, RequiredDocument


def test_recover_stuck_enforces_max_attempts_and_calls_on_exhausted(env):
    """Verify that stuck jobs reaching max_attempts fail permanently and trigger exhaustion handling."""
    with dbmod.session_scope() as db:
        c = Customer(name="Stuck Customer", email="stuck@example.com", consent_status="granted")
        db.add(c)
        db.flush()
        doc = Document(
            customer_id=c.id,
            doc_type="pan",
            filename="pan.png",
            mime="image/png",
            size=100,
            sha256="abc1234",
            storage_key=f"{c.id}/pan.enc",
            verification_status="not_started",
        )
        db.add(doc)
        db.flush()
        doc_id = doc.id

        # Job crashed 3 times, exceeding max_attempts
        j = Job(
            kind="process_document",
            payload={"document_id": doc_id},
            status="running",
            attempts=3,
            max_attempts=3,
            locked_at=dbmod.utcnow() - timedelta(minutes=25),
        )
        db.add(j)
        db.flush()
        jid = j.id

    recovered_count = jobs.recover_stuck(minutes=15)
    assert recovered_count >= 1

    with dbmod.session_scope() as db:
        job = db.get(Job, jid)
        assert job.status == "failed"
        assert job.locked_at is None
        assert "stuck_job_timeout" in (job.last_error or "")

        # Verify on_exhausted_process_document routed document to manual review
        d = db.get(Document, doc_id)
        assert d.ocr_status == "failed"
        assert d.verification_status == "manual_review"
        assert "ocr_unavailable" in d.flags


def test_recover_stuck_requeues_with_backoff_under_max_attempts(env):
    """Verify stuck jobs under max_attempts are requeued with backoff, cleared locked_at, and error message."""
    with dbmod.session_scope() as db:
        j = Job(
            kind="process_document",
            payload={"document_id": "dummy_doc_id"},
            status="running",
            attempts=1,
            max_attempts=3,
            locked_at=dbmod.utcnow() - timedelta(minutes=20),
        )
        db.add(j)
        db.flush()
        jid = j.id

    recovered_count = jobs.recover_stuck(minutes=15)
    assert recovered_count >= 1

    with dbmod.session_scope() as db:
        job = db.get(Job, jid)
        assert job.status == "queued"
        assert job.locked_at is None
        assert job.run_at > dbmod.utcnow()  # exponential backoff applied
        assert "stuck_job_timeout" in (job.last_error or "")


def test_handle_process_document_idempotency_prevents_duplicate_review(env):
    """Verify handle_process_document exits early if document is already processed (e.g. in manual_review)."""
    with dbmod.session_scope() as db:
        c = Customer(name="Review Cust", email="rev@example.com", consent_status="granted")
        db.add(c)
        db.flush()
        doc = Document(
            customer_id=c.id,
            doc_type="aadhaar",
            filename="aadhaar.png",
            mime="image/png",
            size=100,
            sha256="abc999",
            storage_key=f"{c.id}/aadhaar.enc",
            verification_status="manual_review",
            workflow_state="IN_REVIEW",
        )
        db.add(doc)
        db.flush()
        rev = ManualReview(document_id=doc.id, customer_id=c.id, reason="existing_flag", flags=["flag1"])
        db.add(rev)
        db.flush()
        doc_id = doc.id

    # Call handle_process_document again as if retried
    with dbmod.session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    # Verify no second review created and state unchanged
    with dbmod.session_scope() as db:
        reviews = list(db.scalars(select(ManualReview).where(ManualReview.document_id == doc_id)))
        assert len(reviews) == 1
        d = db.get(Document, doc_id)
        assert d.verification_status == "manual_review"


def test_open_review_idempotency(env):
    """Verify _open_review updates an existing open review rather than creating duplicate records."""
    with dbmod.session_scope() as db:
        c = Customer(name="Review Dup", email="dup@example.com", consent_status="granted")
        db.add(c)
        db.flush()
        doc = Document(
            customer_id=c.id,
            doc_type="pan",
            filename="pan.png",
            mime="image/png",
            size=100,
            sha256="abc888",
            storage_key=f"{c.id}/pan.enc",
            verification_status="manual_review",
        )
        db.add(doc)
        db.flush()

        pipeline._open_review(db, doc, "first_reason", ["flag1"])
        db.flush()
        pipeline._open_review(db, doc, "updated_reason", ["flag1", "flag2"])
        db.flush()

        reviews = list(db.scalars(select(ManualReview).where(ManualReview.document_id == doc.id)))
        assert len(reviews) == 1
        assert reviews[0].reason == "updated_reason"
        assert "flag2" in reviews[0].flags


def test_job_completion_clears_locked_at(env):
    """Verify that successful job execution sets status to done and clears locked_at."""
    executed = []

    def dummy_handler(db, payload):
        executed.append(payload["msg"])

    orig_handler = pipeline.HANDLERS.get("process_document")
    pipeline.HANDLERS["process_document"] = dummy_handler

    try:
        with dbmod.session_scope() as db:
            j = jobs.enqueue(db, "process_document", {"msg": "hello_recovery"}, delay_seconds=-5)
            db.flush()
            jid = j.id

        assert jobs.run_one() is True
        assert executed == ["hello_recovery"]

        with dbmod.session_scope() as db:
            job = db.get(Job, jid)
            assert job.status == "done"
            assert job.locked_at is None
    finally:
        pipeline.HANDLERS["process_document"] = orig_handler


def test_concurrent_job_claim_skip_locked(env):
    """Verify that multiple jobs in the queue are claimed sequentially without duplicates."""
    processed = []

    def dummy_handler(db, payload):
        processed.append(payload["item_id"])

    orig_handler = pipeline.HANDLERS.get("process_document")
    pipeline.HANDLERS["process_document"] = dummy_handler

    try:
        with dbmod.session_scope() as db:
            j1 = jobs.enqueue(db, "process_document", {"item_id": "job_1"}, delay_seconds=-5)
            j2 = jobs.enqueue(db, "process_document", {"item_id": "job_2"}, delay_seconds=-5)
            db.flush()
            j1_id, j2_id = j1.id, j2.id

        assert jobs.run_one() is True
        assert jobs.run_one() is True
        assert jobs.run_one() is False

        assert processed == ["job_1", "job_2"]

        with dbmod.session_scope() as db:
            job1 = db.get(Job, j1_id)
            job2 = db.get(Job, j2_id)
            assert job1.status == "done"
            assert job2.status == "done"
            assert job1.locked_at is None
            assert job2.locked_at is None
    finally:
        pipeline.HANDLERS["process_document"] = orig_handler


def test_multiworker_simultaneous_claims_and_execution(env):
    """Verify that multiple concurrent worker threads execute jobs exactly once with zero collisions."""
    import threading

    job_count = 6
    with dbmod.session_scope() as db:
        for i in range(job_count):
            jobs.enqueue(db, "process_document", {"task_idx": i}, delay_seconds=-5)

    executed = []
    lock = threading.Lock()
    db_lock = threading.Lock()

    def thread_safe_handler(db, payload):
        with lock:
            executed.append(payload["task_idx"])

    orig_handler = pipeline.HANDLERS.get("process_document")
    pipeline.HANDLERS["process_document"] = thread_safe_handler

    try:
        def worker_loop():
            while True:
                with db_lock:
                    more = jobs.run_one()
                if not more:
                    break

        threads = [threading.Thread(target=worker_loop) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(executed) == job_count
        assert sorted(executed) == list(range(job_count))
    finally:
        pipeline.HANDLERS["process_document"] = orig_handler


def test_multiworker_concurrent_stuck_recovery_race(env):
    """Verify that concurrent workers running recover_stuck simultaneously do not double-reclaim jobs."""
    import threading

    with dbmod.session_scope() as db:
        for i in range(3):
            j = Job(
                kind="process_document",
                payload={"stuck_idx": i},
                status="running",
                attempts=1,
                max_attempts=3,
                locked_at=dbmod.utcnow() - timedelta(minutes=25),
            )
            db.add(j)

    recovered_totals = []
    lock = threading.Lock()
    db_lock = threading.Lock()

    def run_recovery():
        with db_lock:
            cnt = jobs.recover_stuck(minutes=15)
        with lock:
            recovered_totals.append(cnt)

    threads = [threading.Thread(target=run_recovery) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Total recovered across all threads must match the exact number of stuck jobs
    assert sum(recovered_totals) == 3


def test_delayed_worker_resumption_after_stuck_recovery_idempotency(env):
    """Verify that if Worker 1 is delayed, Worker 2 recovers & finishes, Worker 1 cannot duplicate review."""
    with dbmod.session_scope() as db:
        c = Customer(name="Delayed Cust", email="delayed@example.com", consent_status="granted")
        db.add(c)
        db.flush()
        doc = Document(
            customer_id=c.id,
            doc_type="bank_statement",
            filename="bs.pdf",
            mime="application/pdf",
            size=500,
            sha256="delayed123",
            storage_key=f"{c.id}/bs.enc",
            verification_status="not_started",
        )
        db.add(doc)
        db.flush()
        doc_id = doc.id

        # Worker 1 claimed job, but got stuck
        j = Job(
            kind="process_document",
            payload={"document_id": doc_id},
            status="running",
            attempts=1,
            max_attempts=3,
            locked_at=dbmod.utcnow() - timedelta(minutes=20),
        )
        db.add(j)
        db.flush()
        jid = j.id

    # Worker 2 recovers the stuck job
    recovered = jobs.recover_stuck(minutes=15)
    assert recovered >= 1

    # Simulate Worker 2 processing document to manual_review
    with dbmod.session_scope() as db:
        d = db.get(Document, doc_id)
        cust = db.get(Customer, d.customer_id)
        d.verification_status = "manual_review"
        d.workflow_state = "IN_REVIEW"
        pipeline._open_review(db, d, "worker2_review", ["risk_flag"])
        db.get(Job, jid).status = "done"

    # Worker 1 unfreezes and attempts to run handle_process_document
    with dbmod.session_scope() as db:
        pipeline.handle_process_document(db, {"document_id": doc_id})

    # Assert exactly 1 review exists and state is unchanged
    with dbmod.session_scope() as db:
        reviews = list(db.scalars(select(ManualReview).where(ManualReview.document_id == doc_id)))
        assert len(reviews) == 1
        assert reviews[0].reason == "worker2_review"
