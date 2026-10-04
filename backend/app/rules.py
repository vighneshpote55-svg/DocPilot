import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from .doc_types import canonical_key
from .ocr_client import OCRResult

# Fields that must be present for a document type to auto-verify. Matches your OCR service extractors.
REQUIRED_FIELDS: dict[str, list[str]] = {
    "aadhaar": ["aadhaar_number", "name"],
    "pan": ["pan_number", "name"],
    "passport": ["passport_number", "name"],
    "voter": ["epic_number", "name"],
    "driving_licence": ["licence_number", "name"],
    "bank_statement": ["account_number", "bank_name"],
    "salary_slip": ["employee_name", "employer_name"],
    "cancelled_cheque": ["account_holder", "ifsc"],
    "itr": ["acknowledgement_number", "name"],
    "udyam": ["udyam_registration_number", "enterprise_name"],
    "shop_establishment": ["establishment_name", "registration_number"],
    "fssai": ["fssai_licence_number", "business_name"],
    "utility_bill": ["consumer_number", "bill_amount"],
    "gst_certificate": ["gstin", "legal_name"],
    "certificate_of_incorporation": ["cin", "company_name"],
    "partnership_deed": ["firm_name"],
    "rent_agreement": ["monthly_rent"],
    "form_16": ["employer_name", "pan_number"],
    "bank_passbook": ["bank_name", "ifsc"],
    "property_tax_receipt": ["property_id", "tax_amount_paid"],
    "iec_certificate": ["iec_number", "entity_name"],
    "income_certificate": ["certificate_number", "annual_income"],
}

NAME_KEYS = {
    "name", "holder_name", "cardholder_name", "account_holder", "account_holder_name",
    "employee_name", "applicant_name", "consumer_name", "owner_name", "customer_name",
}
EXPIRY_KEY_PARTS = ("expiry", "expires", "valid_until", "valid_till", "valid_upto", "validity")
DEMO_MARKERS = (
    "SYNTHETIC DEMO", "SYNTHETIC DOCUMENT", "NOT VALID FOR OFFICIAL USE", "FOR TESTING PURPOSES",
    "ALL VALUES FICTIONAL", "DEMO PASSPORT", "DEMO DRIVING LICENCE", "DEMO DRIVING LICENSE",
    "DEMO VOTER ID", "DEMO DOCUMENT",
)
TITLES = {"mr", "mrs", "ms", "dr", "shri", "smt", "the"}
HARD_FLAGS = {
    "holder_name_mismatch",
    "document_expired",
    "demo_or_non_official_document",
    "cross_check_failed",
    "qr_disagreement",
    "low_confidence",
    "ocr_error",
    "review_required",
    "risk_score_high",
    "risk_detected",
}


class DecisionState:
    VERIFIED = "verified"
    AI_REQUIRED = "needs_ai"
    MANUAL_REVIEW = "manual_review"
    REJECTED = "rejected"


class OutcomeStr(str):
    """String subclass supporting case-insensitive comparison and enum aliases (e.g. AI_REQUIRED == needs_ai)."""

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, str):
            s_up = self.upper()
            o_up = other.upper()
            if s_up == o_up:
                return True
            if (s_up in ("NEEDS_AI", "AI_REQUIRED")) and (o_up in ("NEEDS_AI", "AI_REQUIRED")):
                return True
            return False
        return super().__eq__(other)

    def __hash__(self) -> int:
        return super().__hash__()


@dataclass
class Decision:
    outcome: OutcomeStr | str  # verified | rejected | manual_review | needs_ai
    flags: list[str] = field(default_factory=list)
    reason: str = ""
    confidence: float = 0.0

    def __post_init__(self):
        if not isinstance(self.outcome, OutcomeStr):
            self.outcome = OutcomeStr(str(self.outcome))

    @property
    def state(self) -> str:
        mapping = {
            "verified": "VERIFIED",
            "needs_ai": "AI_REQUIRED",
            "manual_review": "MANUAL_REVIEW",
            "rejected": "REJECTED",
        }
        return mapping.get(str(self.outcome).lower(), str(self.outcome).upper())

    def is_verified(self) -> bool:
        return self.state == "VERIFIED"

    def is_rejected(self) -> bool:
        return self.state == "REJECTED"

    def is_manual_review(self) -> bool:
        return self.state == "MANUAL_REVIEW"

    def is_ai_required(self) -> bool:
        return self.state == "AI_REQUIRED"


def _tokens(v: str) -> list[str]:
    n = re.sub(r"[^a-z0-9]+", " ", str(v or "").lower()).strip()
    return [t for t in n.split() if len(t) >= 2 and t not in TITLES]


def names_compatible(a: str, b: str) -> bool:
    aa, bb = _tokens(a), _tokens(b)
    if not aa or not bb:
        return True
    common = len(set(aa) & set(bb))
    smallest = min(len(aa), len(bb))
    return common == 1 if smallest == 1 else common >= min(2, smallest)


def _parse_date(s: str) -> date | None:
    s = str(s or "").strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _expired(fields: dict) -> bool:
    today = date.today()
    for k, v in fields.items():
        if any(p in k.lower() for p in EXPIRY_KEY_PARTS):
            d = _parse_date(v)
            if d and d < today:
                return True
    return False


def _demo(fields: dict) -> bool:
    blob = json.dumps(fields, ensure_ascii=False).upper()
    return any(m in blob for m in DEMO_MARKERS)


def _name_mismatch(fields: dict, customer_name: str) -> bool:
    for k, v in fields.items():
        if k.lower() in NAME_KEYS and isinstance(v, str) and v.strip():
            if not names_compatible(customer_name, v):
                return True
    return False


def _cross_check_failed(cc) -> bool:
    """Defensive: the exact cross_check shape is not documented, so look for common failure markers."""
    if isinstance(cc, dict):
        for k, v in cc.items():
            if k in ("match", "matched", "passed", "ok", "valid") and v is False:
                return True
            if k in ("mismatches", "mismatch") and v:
                return True
            if _cross_check_failed(v):
                return True
    elif isinstance(cc, list):
        return any(_cross_check_failed(x) for x in cc)
    return False


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 1.0  # unknown confidence is not treated as low


class RulesEngine:
    """Centralized verification engine implementing deterministic rules-first verification."""

    @classmethod
    def evaluate(
        cls,
        res: Any,
        slot: str,
        customer_name: str,
        *,
        min_overall: float,
        min_field: float,
        min_review: float = 0.60,
    ) -> Decision:
        def _val(attr, default=None):
            if isinstance(res, dict):
                return res.get(attr, default)
            return getattr(res, attr, default)

        fields = _val("extracted_fields") or {}
        flags: list[str] = []

        status = _val("status")
        reason = _val("reason")
        conf = float(_val("confidence", 0.0) or 0)

        # 1. Document type and structure matching
        doc_type = _val("doc_type")
        returned_type = canonical_key(doc_type) if doc_type else None
        if returned_type and returned_type != slot:
            flags.append("wrong_document_type")
        if reason in ("doc_type_mismatch", "wrong_document_type", "type_mismatch"):
            flags.append("wrong_document_type")
        detected_type = _val("detected_type")
        if detected_type and canonical_key(detected_type) != slot:
            flags.append("wrong_document_type")

        # 2. Failed OCR status handling (Failed OCR must NEVER become VERIFIED)
        if status in ("error", "failed"):
            flags.append("ocr_error")

        # 3. Upstream OCR reason codes
        if reason:
            flags.append(f"ocr_reason:{reason}")

        # 4. Cryptographic QR disagreements
        if _val("qr_disagreements"):
            flags.append("qr_disagreement")

        # 5. Cross-check failure
        if _cross_check_failed(_val("cross_check")):
            flags.append("cross_check_failed")

        # 6. Demo / non-official document markers
        if _demo(fields):
            flags.append("demo_or_non_official_document")

        # 7. Document expiry check
        if _expired(fields):
            flags.append("document_expired")

        # 8. Customer name compatibility
        if _name_mismatch(fields, customer_name):
            flags.append("holder_name_mismatch")

        # 9. Risk flags & authenticity results from company-ocr-service
        risk_flags = _val("risk_flags")
        if isinstance(risk_flags, list):
            for rf in risk_flags:
                flags.append(f"risk:{rf}")
        elif isinstance(risk_flags, str) and risk_flags.strip():
            flags.append(f"risk:{risk_flags}")

        risk_score = _val("risk_score")
        if risk_score is not None and _num(risk_score) >= 30:
            flags.append("risk_score_high")

        verification_status = _val("verification_status")
        if verification_status in ("review_required", "unsupported"):
            flags.append("review_required")

        if fields.get("risk_flag") or fields.get("risk_flags"):
            flags.append("risk_detected")

        # 10. Required fields presence
        needed = REQUIRED_FIELDS.get(slot, [])
        missing = [f for f in needed if not fields.get(f)]
        field_confs = _val("field_confidences") or {}
        low_fields = [f for f in needed if fields.get(f) and _num(field_confs.get(f)) < min_field]
        if missing:
            flags.append("missing_fields:" + ",".join(missing))
        if low_fields:
            flags.append("low_field_confidence:" + ",".join(low_fields))

        # 11. Low confidence detection (strictly routes to manual review)
        if conf < min_review:
            flags.append("low_confidence")

        # Wrong document type strictly REJECTS (preserves all accumulated flags)
        if "wrong_document_type" in flags:
            return Decision(DecisionState.REJECTED, flags, "wrong_document_type", conf)

        # Failed or unreadable OCR strictly routes to manual review
        if status in ("error", "failed"):
            return Decision(DecisionState.MANUAL_REVIEW, flags, "ocr_could_not_read_document", conf)

        # Check for hard flags requiring human review
        hard = [
            f for f in flags
            if f in HARD_FLAGS
            or f.startswith("ocr_reason:")
            or f.startswith("missing_fields:")
            or f.startswith("risk:")
            or f.startswith("risk_")
        ]
        if hard:
            return Decision(DecisionState.MANUAL_REVIEW, flags, ", ".join(hard), conf)

        # 12. Valid document auto-verification (clean status, conf >= threshold, no low fields)
        if status == "success" and conf >= min_overall and not low_fields:
            return Decision(DecisionState.VERIFIED, flags, "rules_passed", conf)

        # 13. Borderline / inconclusive rules -> AI_REQUIRED
        return Decision(DecisionState.AI_REQUIRED, flags, "rules_inconclusive", conf)


def evaluate(
    res: Any,
    slot: str,
    customer_name: str,
    *,
    min_overall: float,
    min_field: float,
    min_review: float = 0.60,
) -> Decision:
    """Primary entry point for rules-first document evaluation."""
    return RulesEngine.evaluate(
        res,
        slot,
        customer_name,
        min_overall=min_overall,
        min_field=min_field,
        min_review=min_review,
    )


def apply_ai(decision: Decision, ai: Any) -> Decision:
    """AI can only upgrade an inconclusive case to verified, and only with high confidence (>= 90).

    Strict Invariants:
    1. AI can NEVER override hard security or risk failures.
    2. AI failures, timeouts, or low confidence (< 90) strictly route to MANUAL_REVIEW.
    """
    hard = [
        f for f in decision.flags
        if f in HARD_FLAGS
        or f.startswith("ocr_reason:")
        or f.startswith("missing_fields:")
        or f.startswith("risk:")
        or f.startswith("risk_")
    ]
    if hard or decision.outcome in (DecisionState.REJECTED, "rejected"):
        return Decision(
            DecisionState.REJECTED if decision.outcome in (DecisionState.REJECTED, "rejected") else DecisionState.MANUAL_REVIEW,
            decision.flags,
            decision.reason or ", ".join(hard),
            decision.confidence,
        )

    if ai is None:
        return Decision(
            DecisionState.MANUAL_REVIEW,
            decision.flags + ["rules_inconclusive"],
            "needs_human_check",
            decision.confidence,
        )

    verdict = getattr(ai, "verdict", None) if hasattr(ai, "verdict") else (ai.get("verdict") if isinstance(ai, dict) else None)
    confidence = getattr(ai, "confidence", None) if hasattr(ai, "confidence") else (ai.get("confidence") if isinstance(ai, dict) else None)
    reason = getattr(ai, "reason", None) if hasattr(ai, "reason") else (ai.get("reason") if isinstance(ai, dict) else "")

    conf_num = _num(confidence)
    if 0.0 <= conf_num <= 1.0:
        conf_num = conf_num * 100.0

    if str(verdict or "").lower() == "verified" and conf_num >= 90.0:
        return Decision(
            DecisionState.VERIFIED,
            decision.flags + ["ai_verified"],
            str(reason or "AI verified")[:300],
            decision.confidence,
        )

    flag = "ai_uncertain" if verdict else "rules_inconclusive"
    return Decision(
        DecisionState.MANUAL_REVIEW,
        decision.flags + [flag],
        str(reason or "needs_human_check")[:300],
        decision.confidence,
    )
