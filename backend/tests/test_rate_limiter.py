"""Unit tests for sliding-window rate limiter, bucket pruning, and IP extraction."""
import threading
import time
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.rate_limiter import (
    _MAX_BUCKETS_THRESHOLD,
    _buckets,
    check_rate_limit,
    get_client_ip,
    prune_expired_buckets,
    reset_rate_limits,
)


@pytest.fixture(autouse=True)
def clean_rate_limits(monkeypatch):
    reset_rate_limits()
    s = get_settings()
    monkeypatch.setattr(s, "rate_limit_enabled", True)
    yield
    reset_rate_limits()


def test_rate_limiter_threshold_enforced():
    key = "test_user_threshold"
    # Allow 3 requests in 10-second window
    check_rate_limit(key, limit=3, window_seconds=10)
    check_rate_limit(key, limit=3, window_seconds=10)
    check_rate_limit(key, limit=3, window_seconds=10)

    with pytest.raises(HTTPException) as exc_info:
        check_rate_limit(key, limit=3, window_seconds=10)
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["code"] == "rate_limited"


def test_rate_limiter_window_expiry(monkeypatch):
    key = "test_user_expiry"
    current_time = 1000.0
    monkeypatch.setattr(time, "time", lambda: current_time)

    # Use up limit (2 requests in 60s window)
    check_rate_limit(key, limit=2, window_seconds=60)
    check_rate_limit(key, limit=2, window_seconds=60)

    # 3rd request fails
    with pytest.raises(HTTPException):
        check_rate_limit(key, limit=2, window_seconds=60)

    # Advance time beyond the 60s window
    current_time = 1065.0
    # Next request must succeed
    check_rate_limit(key, limit=2, window_seconds=60)
    assert len(_buckets[key]) == 1


def test_prune_expired_buckets(monkeypatch):
    current_time = 2000.0
    monkeypatch.setattr(time, "time", lambda: current_time)

    # Create entries for 5 distinct IPs
    for i in range(5):
        check_rate_limit(f"ip_{i}", limit=10, window_seconds=60)
    assert len(_buckets) == 5

    # Advance time by 30 seconds (still within window)
    current_time = 2030.0
    purged = prune_expired_buckets(window_seconds=60)
    assert purged == 0
    assert len(_buckets) == 5

    # Advance time past 60 seconds
    current_time = 2065.0
    purged = prune_expired_buckets(window_seconds=60)
    assert purged == 5
    assert len(_buckets) == 0


def test_auto_pruning_on_threshold(monkeypatch):
    current_time = 3000.0
    monkeypatch.setattr(time, "time", lambda: current_time)

    # Populate stale entries
    for i in range(10):
        check_rate_limit(f"stale_ip_{i}", limit=10, window_seconds=60)
    assert len(_buckets) == 10

    # Advance time so they are stale
    current_time = 3070.0
    # Temporarily lower threshold to 5 to trigger auto-prune during check_rate_limit
    monkeypatch.setattr("app.rate_limiter._MAX_BUCKETS_THRESHOLD", 5)

    # Making a new request triggers auto-prune of stale entries
    check_rate_limit("new_active_ip", limit=10, window_seconds=60)
    # Stale 10 were pruned, leaving only the new active IP
    assert "new_active_ip" in _buckets
    assert len(_buckets) == 1


def test_concurrent_access():
    errors = []

    def make_requests(thread_id: int):
        try:
            for j in range(15):
                check_rate_limit(f"thread_{thread_id}", limit=20, window_seconds=10)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=make_requests, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(errors) == 0
    assert len(_buckets) == 8


def test_get_client_ip():
    req1 = MagicMock()
    req1.headers = {"x-forwarded-for": "203.0.113.195, 198.51.100.1"}
    req1.client.host = "10.0.0.1"
    assert get_client_ip(req1) == "203.0.113.195"

    req2 = MagicMock()
    req2.headers = {}
    req2.client.host = "192.168.1.50"
    assert get_client_ip(req2) == "192.168.1.50"

    req3 = MagicMock()
    req3.headers = {}
    req3.client = None
    assert get_client_ip(req3) == "127.0.0.1"
