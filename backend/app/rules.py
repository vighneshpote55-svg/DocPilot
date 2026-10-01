"""Rules-first verification. Deterministic checks decide clear cases; the AI sees only uncertain ones."""
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime

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
HARD_FLAGS = {"holder_name_mismatch", "document_expired", "demo_or_non_official_document", "cross_check_failed"}


@dataclass
class Decision:
    outcome: str  # verified | rejected | manual_review | needs_ai
    flags: list[str] = field(default_factory=list)
    reason: str = ""
    confidence: float = 0.0


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


def evaluate(res: OCRResult, slot: str, customer_name: str, *, min_overall: float, min_field: float) -> Decision:
    fields = res.extracted_fields or {}
    flags: list[str] = []

    returned_type = canonical_key(res.doc_type) if res.doc_type else None
    if returned_type and returned_type != slot:
        flags.append("wrong_document_type")
    if res.reason in ("doc_type_mismatch", "wrong_document_type", "type_mismatch"):
        flags.append("wrong_document_type")
    if res.reason:
        flags.append(f"ocr_reason:{res.reason}")
    if _demo(fields):
        flags.append("demo_or_non_official_document")
    if _expired(fields):
        flags.append("document_expired")
    if _name_mismatch(fields, customer_name):
        flags.append("holder_name_mismatch")
    if _cross_check_failed(res.cross_check):
        flags.append("cross_check_failed")

    needed = REQUIRED_FIELDS.get(slot, [])
    missing = [f for f in needed if not fields.get(f)]
    low = [f for f in needed if fields.get(f) and _num(res.field_confidences.get(f)) < min_field]
    if missing:
        flags.append("missing_fields:" + ",".join(missing))
    if low:
        flags.append("low_field_confidence:" + ",".join(low))

    conf = float(res.confidence or 0)

    if "wrong_document_type" in flags:
        return Decision("rejected", flags, "wrong_document_type", conf)

    hard = [f for f in flags if f in HARD_FLAGS or f.startswith("ocr_reason:") or f.startswith("missing_fields:")]
    if hard:
        return Decision("manual_review", flags, ", ".join(hard), conf)

    if res.status == "success" and conf >= min_overall and not low:
        return Decision("verified", flags, "rules_passed", conf)

    return Decision("needs_ai", flags, "rules_inconclusive", conf)


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 1.0  # unknown confidence is not treated as low


def apply_ai(decision: Decision, ai: dict | None) -> Decision:
    """AI can only upgrade an inconclusive case to verified, and only with high confidence."""
    if ai and ai.get("verdict") == "verified" and _num(ai.get("confidence")) >= 90:
        return Decision("verified", decision.flags + ["ai_verified"], str(ai.get("reason", ""))[:300], decision.confidence)
    flag = "ai_uncertain" if ai else "rules_inconclusive"
    return Decision("manual_review", decision.flags + [flag], "needs_human_check", decision.confidence)
