import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

# PII Regex patterns
PHONE_PATTERN = re.compile(r"(?:\+91[\s-]?)?[6-9]\d{9}\b")
AADHAAR_PATTERN = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
PAN_PATTERN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")

SENSITIVE_KEYS = {
    "email", "mobile", "phone", "aadhaar", "pan", "account_number", "dob",
    "address", "password", "token", "secret", "key", "data", "image", "bytes",
}


def sanitize_text(text: str) -> str:
    if not isinstance(text, str):
        return text
    text = EMAIL_PATTERN.sub("[REDACTED_EMAIL]", text)
    text = PHONE_PATTERN.sub("[REDACTED_PHONE]", text)
    text = AADHAAR_PATTERN.sub("[REDACTED_AADHAAR]", text)
    text = PAN_PATTERN.sub("[REDACTED_PAN]", text)
    return text


def sanitize_data(data: Any) -> Any:
    if isinstance(data, dict):
        sanitized = {}
        for k, v in data.items():
            if str(k).lower() in SENSITIVE_KEYS:
                sanitized[k] = "[REDACTED]"
            else:
                sanitized[k] = sanitize_data(v)
        return sanitized
    elif isinstance(data, list):
        return [sanitize_data(x) for x in data]
    elif isinstance(data, str):
        return sanitize_text(data)
    return data


class PiiSanitizingFilter(logging.Filter):
    """Filters out any inadvertent raw PII in log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = sanitize_text(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = sanitize_data(record.args)
            elif isinstance(record.args, (list, tuple)):
                record.args = tuple(sanitize_data(a) for a in record.args)
        return True


class StructuredJsonFormatter(logging.Formatter):
    """Formats log records as single-line JSON with no raw PII."""

    STANDARD_ATTRS = {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "module", "msecs",
        "message", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "thread", "threadName",
    }

    def format(self, record: logging.LogRecord) -> str:
        record.message = record.getMessage()
        if self.usesTime():
            record.asctime = self.formatTime(record, self.datefmt)

        log_data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": sanitize_text(record.message),
        }

        # Include custom extra fields
        extra_fields = {}
        for key, val in record.__dict__.items():
            if key not in self.STANDARD_ATTRS and not key.startswith("_"):
                extra_fields[key] = val

        if extra_fields:
            log_data["context"] = sanitize_data(extra_fields)

        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_data)


def setup_logging(level: str = "INFO", structured: bool = True) -> None:
    root = logging.getLogger()
    root.setLevel(level)

    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    handler.addFilter(PiiSanitizingFilter())
    if structured:
        handler.setFormatter(StructuredJsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    root.addHandler(handler)
