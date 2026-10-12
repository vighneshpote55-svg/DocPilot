"""
tests/test_ocr_auth_security_repair.py
Regression tests for DocPilot-to-OCR authenticated connection test and request flow:
1. test_ocr_connection distinguishes network reachability from authentication authorization.
2. test_ocr_connection correctly reports failure (connected=False, reachable=True, authenticated=False) on HTTP 401/403.
3. test_ocr_connection handles offline OCR service cleanly.
4. HTTPOCRClient passes dual authentication headers (Authorization: Bearer and X-API-Key).
5. HTTPOCRClient handles 401/403 upstream errors securely without leaking secrets.
"""

import httpx
import pytest

from app.config import get_settings
from app.ocr_client import HTTPOCRClient, OCRUnavailable
from tests.conftest import admin_headers


def test_ocr_connection_success_when_authenticated(client, monkeypatch):
    """When both /health and /api/v1/ping succeed, test returns connected=True, reachable=True, authenticated=True."""
    def mock_get(url, *args, **kwargs):
        if url.endswith("/health"):
            return httpx.Response(200, json={"status": "healthy"})
        if url.endswith("/api/v1/ping"):
            return httpx.Response(200, json={
                "status": "connected",
                "service": "DocPilot Offline OCR Engine",
                "authenticated_client": {"email": "client@docpilot.ai"},
            })
        return httpx.Response(404)

    monkeypatch.setattr(httpx, "get", mock_get)

    res = client.post(
        "/api/admin/settings/ocr/test",
        headers=admin_headers(),
        json={"ocr_url": "http://mock-ocr:8001", "ocr_api_key": "dp_live_valid_test_key_123"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["connected"] is True
    assert data["reachable"] is True
    assert data["authenticated"] is True
    assert data["status_code"] == 200
    assert "authenticated successfully" in data["message"].lower()


def test_ocr_connection_reachable_but_unauthenticated(client, monkeypatch):
    """When /health is 200 but /api/v1/ping returns 401, test returns connected=False, reachable=True, authenticated=False."""
    def mock_get(url, *args, **kwargs):
        if url.endswith("/health"):
            return httpx.Response(200, json={"status": "healthy"})
        if url.endswith("/api/v1/ping"):
            return httpx.Response(401, json={"detail": "Invalid or revoked API key."})
        return httpx.Response(404)

    monkeypatch.setattr(httpx, "get", mock_get)

    res = client.post(
        "/api/admin/settings/ocr/test",
        headers=admin_headers(),
        json={"ocr_url": "http://mock-ocr:8001", "ocr_api_key": "dp_live_invalid_bad_key"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["connected"] is False
    assert data["reachable"] is True
    assert data["authenticated"] is False
    assert data["status_code"] == 401
    assert "authentication failed" in data["message"].lower()


def test_ocr_connection_service_offline(client, monkeypatch):
    """When service is unreachable, test returns connected=False, reachable=False, authenticated=False."""
    def mock_get(url, *args, **kwargs):
        raise httpx.ConnectError("Connection refused")

    monkeypatch.setattr(httpx, "get", mock_get)

    res = client.post(
        "/api/admin/settings/ocr/test",
        headers=admin_headers(),
        json={"ocr_url": "http://offline-ocr:8001", "ocr_api_key": "any_key"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["connected"] is False
    assert data["reachable"] is False
    assert data["authenticated"] is False
    assert "connection failed" in data["message"].lower()


def test_ocr_client_dual_header_dispatch(monkeypatch):
    """HTTPOCRClient sends both Authorization: Bearer and X-API-Key headers."""
    captured_headers = {}

    def mock_post(url, *args, **kwargs):
        nonlocal captured_headers
        captured_headers = kwargs.get("headers", {})
        return httpx.Response(200, json={
            "status": "success",
            "doc_type": "pan",
            "confidence": 0.95,
            "extracted_fields": {"pan_number": "ABCDE1234F"},
        })

    monkeypatch.setattr(httpx, "post", mock_post)

    s = get_settings()
    old_key = s.ocr_api_key
    s.ocr_api_key = "dp_live_test_pipeline_key_secret"

    try:
        client_instance = HTTPOCRClient()
        dummy_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        result = client_instance.extract(
            data=dummy_png,
            filename="test_pan.png",
            mime="image/png",
            doc_type="pan",
        )
        assert result.status == "success"
        assert captured_headers.get("Authorization") == "Bearer dp_live_test_pipeline_key_secret"
        assert captured_headers.get("X-API-Key") == "dp_live_test_pipeline_key_secret"
    finally:
        s.ocr_api_key = old_key


def test_ocr_client_handles_401_without_credential_leak(monkeypatch):
    """HTTPOCRClient handles 401 response by raising OCRUnavailable without exposing raw secrets."""
    def mock_post(url, *args, **kwargs):
        return httpx.Response(401, json={"detail": "Invalid or revoked API key."})

    monkeypatch.setattr(httpx, "post", mock_post)

    s = get_settings()
    old_key = s.ocr_api_key
    s.ocr_api_key = "dp_live_secret_key_value_to_never_leak"

    try:
        client_instance = HTTPOCRClient()
        dummy_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        with pytest.raises(OCRUnavailable) as exc_info:
            client_instance.extract(
                data=dummy_png,
                filename="test_pan.png",
                mime="image/png",
                doc_type="pan",
            )
        assert "dp_live_secret_key_value_to_never_leak" not in str(exc_info.value)
        assert "401" in str(exc_info.value)
    finally:
        s.ocr_api_key = old_key
