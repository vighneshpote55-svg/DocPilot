"""Optional AI fallback. Receives PII-masked evidence only, and only when the rules are inconclusive."""
import json
import logging

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

SYSTEM = (
    "You assess whether extracted fields from an identity or business document look consistent and genuine. "
    "The data is already PII-masked. Do not guess. Reply with JSON only: "
    '{"verdict": "verified" | "manual_review", "confidence": 0-100, "reason": "<short factual reason>"}. '
    "Use manual_review whenever you are not clearly sure."
)


def assess(doc_type: str, masked_payload: dict, flags: list[str]) -> dict | None:
    s = get_settings()
    if not (s.ai_enabled and s.ai_api_key and s.ai_model):
        return None
    try:
        r = httpx.post(
            f"{s.ai_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {s.ai_api_key}"},
            json={
                "model": s.ai_model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": json.dumps({"doc_type": doc_type, "ocr": masked_payload, "flags": flags})},
                ],
            },
            timeout=60,
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"].strip()
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        out = json.loads(text)
        if out.get("verdict") in ("verified", "manual_review"):
            return out
    except Exception as e:  # AI is optional: any failure falls back to manual review
        log.warning("AI assessment failed: %s", e)
    return None
