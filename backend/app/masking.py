"""PII masking. Applied before anything is stored in ocr_results or sent to an AI provider."""
import re
from typing import Any

AADHAAR = re.compile(r"\b(\d{4})\s?(\d{4})\s?(\d{4})\b")
PAN = re.compile(r"\b([A-Z]{5})(\d{4})([A-Z])\b")
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)")
ACCOUNT = re.compile(r"((?:ACCOUNT|A/C|ACCT)(?:\s+(?:NO|NUMBER))?\s*[:\-]?\s*)([0-9X* -]{6,24})", re.I)
DOB = re.compile(r"((?:DATE OF BIRTH|DOB)\s*[:\-]?\s*)(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", re.I)

FULL_MASK_TOKENS = {
    "dob", "birth", "address", "phone", "mobile", "cell", "contact",
    "email", "mail", "pin", "password", "secret", "cvv"
}
PARTIAL_MASK_TOKENS = {
    "pan", "aadhaar", "aadhar", "uidai", "account", "acc", "acct",
    "passport", "voter", "epic", "licence", "license", "dl", "uan",
    "cheque", "serial", "cin", "din"
}
NOT_SENSITIVE_TOKENS = {
    "name", "holder", "type", "status", "confidence", "confidences",
    "reason", "employer", "enterprise", "business", "bank", "ifsc",
    "amount", "rent", "date", "valid", "expiry"
}


def mask_text(text: str) -> str:
    if not isinstance(text, str):
        return text
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
    # If the key explicitly designates a holder or person/entity name, it is NOT sensitive identifiers
    if "holder" in t or "name" in t:
        return None
    if t & FULL_MASK_TOKENS:
        return "full"
    if t & PARTIAL_MASK_TOKENS:
        return "partial"
    if t & NOT_SENSITIVE_TOKENS:
        return None
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


def detect_pii(data: Any) -> list[str]:
    """Detect presence of PII categories in text or structured dictionaries/lists."""
    detected = set()
    text = ""
    if isinstance(data, dict):
        for k, v in data.items():
            kl = str(k).lower()
            if any(t in kl for t in ("aadhaar", "aadhar", "uidai")):
                detected.add("aadhaar")
            if "pan" in kl and "company" not in kl:
                detected.add("pan")
            if any(t in kl for t in ("account", "acct", "a_c")):
                detected.add("account_number")
            if any(t in kl for t in ("dob", "birth")):
                detected.add("dob")
            if any(t in kl for t in ("phone", "mobile", "cell", "contact")):
                detected.add("phone")
            if any(t in kl for t in ("email", "mail")):
                detected.add("email")
            if isinstance(v, (dict, list)):
                detected.update(detect_pii(v))
            elif isinstance(v, str):
                text += f" {v}"
    elif isinstance(data, list):
        for item in data:
            detected.update(detect_pii(item))
    elif isinstance(data, str):
        text = data

    if text:
        if AADHAAR.search(text):
            detected.add("aadhaar")
        if PAN.search(text):
            detected.add("pan")
        if ACCOUNT.search(text):
            detected.add("account_number")
        if PHONE.search(text):
            detected.add("phone")
        if EMAIL.search(text):
            detected.add("email")
        if DOB.search(text):
            detected.add("dob")

    return sorted(list(detected))


def create_redacted_evidence(res: Any) -> dict[str, Any]:
    """Generate a clean, standardized redacted evidence bundle from an OCRResult or dict.

    Preserves non-sensitive operational metadata (names, document types, confidences, dates)
    while strictly masking all sensitive identifiers (PAN, Aadhaar, Account numbers, DOB, Contact).
    Raw OCR text is explicitly stripped from the returned evidence bundle.
    """
    if res is None:
        return {
            "status": "error",
            "confidence": 0.0,
            "field_confidences": {},
            "extracted_fields": {},
            "pii_detected": [],
            "reason": "empty_ocr_result",
        }

    raw_dict = res.model_dump() if hasattr(res, "model_dump") else (dict(res) if isinstance(res, dict) else {})

    extracted = raw_dict.get("extracted_fields") or {}
    detected_pii_types = detect_pii(extracted)

    # Clean raw unmasked text fields before masking
    sanitized_source = {k: v for k, v in raw_dict.items() if k not in ("raw_text", "full_text", "extracted_text")}

    # Mask the entire dictionary recursively
    masked_payload = mask_fields(sanitized_source)

    # Preserve pages structure if present (e.g. multi-page documents) but ensure content is masked
    masked_pages = masked_payload.get("pages")
    if isinstance(masked_pages, list):
        clean_pages = []
        for p in masked_pages:
            if isinstance(p, dict):
                clean_pages.append({k: v for k, v in p.items() if k not in ("full_text", "raw_text")})
            else:
                clean_pages.append(p)
    else:
        clean_pages = None

    # Safely convert confidence to float
    raw_conf = raw_dict.get("confidence", 0.0)
    try:
        conf_val = float(raw_conf) if raw_conf is not None else 0.0
    except (ValueError, TypeError):
        conf_val = 0.0

    # Bundle into standardized Redacted Evidence schema
    evidence = {
        "status": raw_dict.get("status", "error"),
        "doc_type": raw_dict.get("doc_type"),
        "detected_type": raw_dict.get("detected_type"),
        "confidence": conf_val,
        "field_confidences": raw_dict.get("field_confidences", {}) if isinstance(raw_dict.get("field_confidences"), dict) else {},
        "extracted_fields": masked_payload.get("extracted_fields", {}) if isinstance(masked_payload.get("extracted_fields"), dict) else {},
        "pii_detected": detected_pii_types,
        "reason": raw_dict.get("reason"),
        "cross_check": masked_payload.get("cross_check"),
        "qr_disagreements": masked_payload.get("qr_disagreements", []) if isinstance(masked_payload.get("qr_disagreements"), list) else [],
        "risk_flags": raw_dict.get("risk_flags"),
        "risk_score": raw_dict.get("risk_score"),
        "verification_status": raw_dict.get("verification_status"),
    }
    if clean_pages is not None:
        evidence["pages"] = clean_pages

    return evidence
