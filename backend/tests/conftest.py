import re
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app import db as dbmod
from app import emailer, ocr_client, storage
from app.config import get_settings
from app.ocr_client import OCRResult
from app.rate_limiter import reset_rate_limits
from app.security import generate_key

JWT_SECRET = "test-secret-test-secret-test-secret-123456"


class FakeOCR:
    """Programmable OCR: set .responses[doc_type] to an OCRResult; default is a clean success."""

    def __init__(self):
        self.responses = {}
        self.calls = []
        self.fail_times = 0

    def extract(self, data, filename, mime, doc_type, expected=None, customer_id=None, **kwargs):
        self.calls.append((doc_type, expected))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise ocr_client.OCRUnavailable("down")
        if doc_type in self.responses:
            return self.responses[doc_type]
        name = (expected or {}).get("name", "")
        from app.rules import REQUIRED_FIELDS
        req = REQUIRED_FIELDS.get(doc_type, ["name"])
        fields = {f: "DUMMY_VALUE" for f in req}
        for k in ("name", "account_holder", "employee_name", "applicant_name"):
            if k in fields:
                fields[k] = name
        if "pan_number" in fields:
            fields["pan_number"] = "ABCPE1234F"
        if "account_number" in fields:
            fields["account_number"] = "123456789012"
        if "bank_name" in fields:
            fields["bank_name"] = "HDFC Bank"
        field_confs = {k: 0.95 for k in fields}
        return OCRResult(status="success", doc_type=doc_type, confidence=0.97,
                         field_confidences=field_confs, extracted_fields=fields)


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "sqlite://")
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("ENCRYPTION_KEY", generate_key())
    monkeypatch.setenv("LOCAL_STORAGE_DIR", str(tmp_path / "store"))
    monkeypatch.setenv("SUPABASE_JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://portal.test")
    monkeypatch.setenv("SMTP_HOST", "")
    get_settings.cache_clear()
    storage.reset_storage()
    emailer.OUTBOX.clear()
    reset_rate_limits()
    dbmod.init_db(create_tables=True)
    fake = FakeOCR()
    ocr_client.set_ocr_client(fake)
    yield fake
    ocr_client.set_ocr_client(None)
    get_settings.cache_clear()


@pytest.fixture
def client(env):
    from app.main import create_app

    return TestClient(create_app())


def admin_headers(email=None):
    s = get_settings()
    admin_email = email or (s.admin_email_list[0] if s.admin_email_list else "admin@example.com")
    secret = s.supabase_jwt_secret or JWT_SECRET
    tok = jwt.encode({"email": admin_email, "aud": "authenticated", "exp": int(time.time()) + 3600},
                     secret, algorithm="HS256")
    return {"Authorization": f"Bearer {tok}"}


def token_from_outbox(kind: str) -> str:
    """Find the latest link of a given kind (consent|portal|privacy/confirm) in the dev outbox."""
    for mail in reversed(emailer.OUTBOX):
        m = re.search(rf"http://portal\.test/{kind}/([\w-]+)", mail["body"])
        if m:
            return m.group(1)
    raise AssertionError(f"no {kind} link in outbox")


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 200
PDF = b"%PDF-1.4\n" + b"0" * 200
