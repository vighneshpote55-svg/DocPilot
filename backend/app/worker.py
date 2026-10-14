"""Background worker:  python -m app.worker   (runs jobs and the periodic scheduler)"""
import logging
import signal
import time

from . import jobs, scheduler, security
from .config import get_settings
from .db import init_db
from .logging_conf import setup_logging

setup_logging(level="INFO", structured=True)
log = logging.getLogger("worker")

_running = True


def _handle_shutdown(signum, frame) -> None:
    global _running
    log.info("Received termination signal %s. Shutting down worker gracefully...", signum)
    _running = False


def main() -> None:
    global _running
    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    s = get_settings()

    # Eagerly validate critical master encryption key precondition
    try:
        security._key()
    except Exception as e:
        log.critical("Worker startup aborted: %s", e)
        raise SystemExit(1)

    init_db(create_tables=s.auto_create_tables)
    last_tick = 0.0
    log.info("worker started")

    while _running:
        try:
            if time.time() - last_tick >= s.scheduler_interval_seconds:
                jobs.recover_stuck(minutes=s.job_stuck_timeout_minutes)
                log.info("tick: %s", scheduler.tick())
                last_tick = time.time()
            if not _running:
                break
            if not jobs.run_one():
                for _ in range(20):
                    if not _running:
                        break
                    time.sleep(0.1)
        except Exception:
            log.exception("worker loop error")
            for _ in range(50):
                if not _running:
                    break
                time.sleep(0.1)

    log.info("Worker stopped gracefully.")


if __name__ == "__main__":
    main()
