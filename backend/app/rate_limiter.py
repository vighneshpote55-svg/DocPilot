"""In-memory sliding-window rate limiter (zero Redis requirement)."""
import time
from collections import defaultdict
from threading import Lock

from fastapi import HTTPException, Request

from .config import get_settings

_lock = Lock()
_buckets: dict[str, list[float]] = defaultdict(list)
_MAX_BUCKETS_THRESHOLD = 5000
_PRUNE_INTERVAL_SECONDS = 15.0
_last_prune_time: float = 0.0


def prune_expired_buckets(window_seconds: int = 60) -> int:
    """Purge stale rate-limit buckets whose entries have all expired. Returns count of purged keys."""
    global _last_prune_time
    now = time.time()
    cutoff = now - window_seconds
    with _lock:
        stale = [k for k, timestamps in _buckets.items() if not timestamps or timestamps[-1] <= cutoff]
        for k in stale:
            _buckets.pop(k, None)
        _last_prune_time = now
        return len(stale)


def check_rate_limit(key: str, limit: int, window_seconds: int = 60) -> None:
    global _last_prune_time
    s = get_settings()
    if not s.rate_limit_enabled:
        return

    now = time.time()
    cutoff = now - window_seconds

    with _lock:
        # Throttled bounded eviction: runs at most once every _PRUNE_INTERVAL_SECONDS
        if len(_buckets) > _MAX_BUCKETS_THRESHOLD and (now - _last_prune_time) >= _PRUNE_INTERVAL_SECONDS:
            stale = [k for k, timestamps in _buckets.items() if not timestamps or timestamps[-1] <= cutoff]
            for k in stale:
                _buckets.pop(k, None)
            _last_prune_time = now

        timestamps = _buckets[key]
        valid = [t for t in timestamps if t > cutoff]
        if len(valid) >= limit:
            _buckets[key] = valid
            raise HTTPException(
                status_code=429,
                detail={"code": "rate_limited", "message": "Too many requests. Please try again later."},
            )
        valid.append(now)
        _buckets[key] = valid


def reset_rate_limits() -> None:
    global _last_prune_time
    with _lock:
        _buckets.clear()
        _last_prune_time = 0.0


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


def rate_limit_portal(request: Request) -> None:
    s = get_settings()
    ip = get_client_ip(request)
    check_rate_limit(f"portal:{ip}", limit=s.rate_limit_portal_per_minute, window_seconds=60)


def rate_limit_upload(request: Request) -> None:
    s = get_settings()
    ip = get_client_ip(request)
    check_rate_limit(f"upload:{ip}", limit=s.rate_limit_upload_per_minute, window_seconds=60)


def rate_limit_consent(request: Request) -> None:
    s = get_settings()
    ip = get_client_ip(request)
    check_rate_limit(f"consent:{ip}", limit=s.rate_limit_consent_per_minute, window_seconds=60)


def rate_limit_privacy(request: Request) -> None:
    s = get_settings()
    ip = get_client_ip(request)
    check_rate_limit(f"privacy:{ip}", limit=s.rate_limit_privacy_per_minute, window_seconds=60)
