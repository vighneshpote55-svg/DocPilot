"""PII masking. Applied before anything is stored in ocr_results or sent to an AI provider."""
import re
from typing import Any

AADHAAR = re.compile(r"\b(\d{4})\s?(\d{4})\s?(\d{4})\b")
PAN = re.compile(r"\b([A-Z]{5})(\d{4})([A-Z])\b")
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)")
ACCOUNT = re.compile(r"((?:ACCOUNT|A/C|ACCT)(?:\s+(?:NO|NUMBER))?\s*[:\-]?\s*)([0-9X* -]{6,24})", re.I)
DOB = re.compile(r"((?:DATE OF BIRTH|DOB)\s*[:\-]?\s*)(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", re.I)

FULL_MASK_TOKENS = {"dob", "birth", "address", "phone", "mobile", "email", "contact"}
PARTIAL_MASK_TOKENS = {"pan", "aadhaar", "aadhar", "account", "passport", "voter", "epic", "licence", "license", "dl", "uan"}
NOT_SENSITIVE_TOKENS = {"name", "holder", "type", "status", "confidence", "confidences"}


def mask_text(text: str) -> str:
    text = ACCOUNT.sub(lambda m: m.group(1) + _last4(m.group(2)), text)
    text = AADHAAR.sub(lambda m: f"XXXX XXXX {m.group(3)}", text)
    text = PAN.sub(lambda m: f"{m.group(1)[:3]}****{m.group(3)}", text)
    text = DOB.sub(lambda m: m.group(1) + "[REDACTED]", text)
    text = PHONE.sub("[MASKED]", text)
    text = EMAIL.sub("[MASKED-EMAIL]", text)
    return text


def _last4(value: str) -> str:
    digits = re.sub(r"\W", "", str(value))
    return f"XXXX{digits[-4:]}" if len(digits) > 4 else "[MASKED]"


def _tokens(key: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", key.lower()) if t}


def _key_class(key: str | None) -> str | None:
    if not key:
        return None
    t = _tokens(key)
    if t & NOT_SENSITIVE_TOKENS:
        return None
    if t & FULL_MASK_TOKENS:
        return "full"
    if t & PARTIAL_MASK_TOKENS:
        return "partial"
    return None


def mask_fields(obj: Any, key: str | None = None) -> Any:
    """Recursively mask a JSON-like structure using both key names and value patterns."""
    if isinstance(obj, dict):
        return {k: mask_fields(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_fields(v, key) for v in obj]
    cls = _key_class(key)
    if obj is None or isinstance(obj, bool):
        return obj
    if cls == "full":
        return "[MASKED]" if str(obj).strip() else obj
    if cls == "partial":
        return _last4(str(obj)) if str(obj).strip() else obj
    if isinstance(obj, str):
        return mask_text(obj)
    return obj
