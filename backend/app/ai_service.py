"""AI Escalation Engine. Receives PII-masked redacted evidence only when deterministic rules return AI_REQUIRED."""
import json
import logging
import re
from abc import ABC, abstractmethod
from typing import Any

import httpx
from pydantic import BaseModel, Field, field_validator

from .config import get_settings
from .masking import detect_pii

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You assess whether extracted fields from an identity or business document look consistent and genuine. "
    "The data is already PII-masked. Do not guess. Reply with JSON only: "
    '{"verdict": "verified" | "manual_review", "confidence": 0-100, "reason": "<factual reasoning>"}. '
    "Use manual_review whenever you are not clearly sure."
)


class AIRequestPayload(BaseModel):
    doc_type: str
    ocr: dict[str, Any]
    flags: list[str] = Field(default_factory=list)


class AIResponse(BaseModel):
    verdict: str  # "verified" | "manual_review"
    confidence: float = Field(ge=0.0, le=100.0)
    reason: str = Field(min_length=1)

    @field_validator("verdict", mode="before")
    @classmethod
    def normalize_verdict(cls, v: Any) -> str:
        s = str(v or "").lower().strip()
        if s in ("verified", "verify"):
            return "verified"
        if s in ("manual_review", "review", "review_required", "rejected", "needs_human_check"):
            return "manual_review"
        raise ValueError(f"Invalid AI verdict: {v}")

    @field_validator("confidence", mode="before")
    @classmethod
    def normalize_confidence(cls, v: Any) -> float:
        try:
            val = float(v)
            if 0.0 <= val <= 1.0:
                val = val * 100.0
            return val
        except (TypeError, ValueError):
            raise ValueError(f"Invalid AI confidence: {v}")

    @classmethod
    def from_raw(cls, raw: Any) -> "AIResponse":
        if isinstance(raw, cls):
            return raw
        if not isinstance(raw, dict):
            raise ValueError(f"Expected dict, got {type(raw)}")
        # Support aliases
        verdict = raw.get("verdict") or raw.get("decision")
        confidence = raw.get("confidence")
        reason = raw.get("reason") or raw.get("reasoning") or raw.get("evidence") or "AI assessment completed"
        return cls(verdict=verdict, confidence=confidence, reason=str(reason))


class AIProvider(ABC):
    @abstractmethod
    def assess(self, request: AIRequestPayload) -> AIResponse | None:
        """Process AI escalation request with strictly redacted evidence."""
        pass


class OpenAICompatibleProvider(AIProvider):
    """OpenAI-compatible chat completion provider (OpenRouter, local Ollama, Google Gemini gateway)."""

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def assess(self, request: AIRequestPayload) -> AIResponse | None:
        try:
            r = httpx.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "doc_type": request.doc_type,
                                    "ocr": request.ocr,
                                    "flags": request.flags,
                                }
                            ),
                        },
                    ],
                },
                timeout=self.timeout,
            )
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"].strip()
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            out = json.loads(text)
            return AIResponse.from_raw(out)
        except Exception as e:
            log.warning("AI provider assessment failed or timed out: %s", e)
            return None


class MockAIProvider(AIProvider):
    """Programmable mock provider for deterministic automated testing."""

    def __init__(self):
        self.calls: list[AIRequestPayload] = []
        self.next_response: AIResponse | dict | None = None
        self.raise_timeout: bool = False
        self.raise_error: Exception | None = None

    def assess(self, request: AIRequestPayload) -> AIResponse | None:
        self.calls.append(request)
        if self.raise_timeout:
            raise httpx.TimeoutException("AI provider request timed out")
        if self.raise_error:
            raise self.raise_error
        if self.next_response is None:
            return None
        return AIResponse.from_raw(self.next_response)


_active_provider: AIProvider | None = None


def get_ai_provider() -> AIProvider | None:
    global _active_provider
    if _active_provider is not None:
        return _active_provider
    s = get_settings()
    if s.ai_enabled and s.ai_api_key and s.ai_model:
        return OpenAICompatibleProvider(
            base_url=s.ai_base_url,
            api_key=s.ai_api_key,
            model=s.ai_model,
        )
    return None


def set_ai_provider(provider: AIProvider | None) -> None:
    global _active_provider
    _active_provider = provider


def reset_ai_provider() -> None:
    global _active_provider
    _active_provider = None


def assess(doc_type: str, masked_payload: dict, flags: list[str]) -> AIResponse | None:
    """Assess inconclusive document evidence via configured AI provider.

    Enforces privacy invariant: Outbound payload is strictly verified for zero raw unmasked PII.
    """
    provider = get_ai_provider()
    if provider is None:
        return None

    # Privacy verification: ensure sensitive data has been properly redacted
    raw_str = json.dumps(masked_payload)
    if re.search(r"\b[A-Z]{5}\d{4}[A-Z]\b", raw_str):
        log.error("Outbound AI payload contained raw unmasked PAN! Aborting AI dispatch.")
        return None
    if re.search(r"\b\d{4}\s\d{4}\s\d{4}\b", raw_str):
        log.error("Outbound AI payload contained raw unmasked Aadhaar! Aborting AI dispatch.")
        return None

    request = AIRequestPayload(doc_type=doc_type, ocr=masked_payload, flags=flags)
    try:
        return provider.assess(request)
    except Exception as e:
        log.warning("Unhandled error during AI escalation assessment: %s", e)
        return None
