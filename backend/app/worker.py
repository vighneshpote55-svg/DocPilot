"""Background worker:  python -m app.worker   (runs jobs and the periodic scheduler)"""
import logging
import time

from . import jobs, scheduler
from .config import get_settings
from .db import init_db
from .logging_conf import setup_logging

setup_logging(level="INFO", structured=True)
log = logging.getLogger("worker")


def main() -> None:
    s = get_settings()
    init_db(create_tables=s.auto_create_tables)
    last_tick = 0.0
    log.info("worker started")
    while True:
        try:
            if time.time() - last_tick >= s.scheduler_interval_seconds:
                jobs.recover_stuck()
                log.info("tick: %s", scheduler.tick())
                last_tick = time.time()
            if not jobs.run_one():
                time.sleep(2)
        except Exception:
            log.exception("worker loop error")
            time.sleep(5)


if __name__ == "__main__":
    main()
