"""Input normalization for customer data. Pure functions; never log the values."""
import re

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
MOBILE_RE = re.compile(r"^(?:\+?91)?([6-9]\d{9})$")


def normalize_email(v: str) -> str:
    v = (v or "").strip().lower()
    if not v or len(v) > 320 or not EMAIL_RE.match(v):
        raise ValueError("invalid email")
    return v


def normalize_name(v: str) -> str:
    v = " ".join((v or "").split())
    if not v or len(v) > 200:
        raise ValueError("invalid name")
    return v


def normalize_mobile(v: str | None) -> str | None:
    if v is None:
        return None
    digits = re.sub(r"[\s\-()]", "", v)
    if not digits:
        return None
    m = MOBILE_RE.match(digits)
    if not m:
        raise ValueError("invalid mobile")
    return f"+91{m.group(1)}"
