import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from .doc_types import canonical_key, DOCS_WITH_PERSONAL_HOLDER_NAME
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

FIELD_ALIASES: dict[str, list[str]] = {
    "fssai_licence_number": ["fssai_licence_number", "fssai_registration_number", "registration_number", "license_number"],
    "business_name": ["business_name", "enterprise_name", "fbo_name", "name"],
    "account_holder": ["account_holder", "account_holder_name", "name", "holder_name"],
    "licence_number": ["licence_number", "license_number", "dl_number"],
    "epic_number": ["epic_number", "voter_id", "voter_id_number", "card_number"],
    "legal_name": ["legal_name", "trade_name", "entity_name", "name"],
    "enterprise_name": ["enterprise_name", "business_name", "entity_name"],
    "firm_name": ["firm_name", "business_name", "entity_name"],
    "company_name": ["company_name", "entity_name", "legal_name"],
    "monthly_rent": ["monthly_rent", "rent_amount", "rent"],
    "ifsc": ["ifsc", "ifsc_code"],
    "registration_number": ["registration_number", "certificate_number", "license_number"],
    "entity_name": ["entity_name", "firm_name", "business_name", "name"],
    "property_id": ["property_id", "property_number", "assessment_number"],
    "tax_amount_paid": ["tax_amount_paid", "amount_paid", "tax_paid", "paid_amount"],
}


def _has_field(fields: dict, f: str) -> bool:
    for alias in FIELD_ALIASES.get(f, [f]):
        v = fields.get(alias)
        if v is not None and str(v).strip():
            return True
    return False


def _get_field_conf(field_confs: dict, fields: dict, f: str) -> float:
    for alias in FIELD_ALIASES.get(f, [f]):
        if alias in field_confs:
            return _num(field_confs[alias])
        if fields.get(alias) is not None:
            return 1.0
    return 1.0


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
TITLES = {
    "mr", "mrs", "ms", "miss", "dr", "prof", "shri", "shree", "smt", "kumari", "km",
    "er", "adv", "ca", "capt", "major", "col", "m/s", "the", "late", "sri"
}
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
    "unsupported_document_type",
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


def flag_sort_key(f: str) -> tuple[int, str]:
    """Hierarchical sorting key ensuring specific root causes precede generic flags."""
    if f == "unsupported_document_type":
        return (0, f)
    if f == "wrong_document_type":
        return (1, f)
    if f == "holder_name_mismatch":
        return (2, f)
    if f == "document_expired":
        return (3, f)
    if f == "demo_or_non_official_document":
        return (4, f)
    if f.startswith("invalid_structural_identifier:"):
        return (5, f)
    if f.startswith("missing_fields:"):
        return (6, f)
    if f == "qr_disagreement":
        return (7, f)
    if f.startswith("risk:") or f in ("risk_score_high", "risk_detected"):
        return (8, f)
    if f == "ocr_error" or f.startswith("ocr_reason:"):
        return (9, f)
    if f == "cross_check_failed":
        return (10, f)
    if f == "review_required":
        return (11, f)
    if f.startswith("low_field_confidence:"):
        return (12, f)
    if f == "low_confidence":
        return (13, f)
    if f in ("rules_inconclusive", "ai_uncertain"):
        return (14, f)
    return (15, f)


def prioritize_flags(flags: list[str]) -> list[str]:
    """Deduplicate and sort flags so the most specific diagnostic root cause appears first."""
    seen = set()
    unique = []
    for f in flags:
        if f not in seen:
            seen.add(f)
            unique.append(f)
    return sorted(unique, key=flag_sort_key)


@dataclass
class Decision:
    outcome: OutcomeStr | str  # verified | rejected | manual_review | needs_ai
    flags: list[str] = field(default_factory=list)
    reason: str = ""
    confidence: float = 0.0

    def __post_init__(self):
        if not isinstance(self.outcome, OutcomeStr):
            self.outcome = OutcomeStr(str(self.outcome))
        self.flags = prioritize_flags(self.flags)

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
    """Tokenize a name string into normalized words and initials, stripping titles."""
    n = re.sub(r"[^a-z0-9]+", " ", str(v or "").lower()).strip()
    return [t for t in n.split() if t not in TITLES]


def match_name(customer_name: str, doc_name: str) -> dict[str, Any]:
    """Compare document holder name against customer registered name deterministically.
    
    Supports Indian naming conventions:
    - Initials (e.g. 'V. Pote' matches 'Vighnesh Pote')
    - Name reordering (e.g. 'Pote Vighnesh' matches 'Vighnesh Pote')
    - Optional middle / paternal names (e.g. 'Vighnesh Suresh Pote' matches 'Vighnesh Pote')
    - Extended professional & honorific titles (e.g. 'Adv. Vighnesh Pote' matches 'Vighnesh Pote')
    - Rejects genuinely conflicting distinct names (e.g. 'Vikram Sharma' vs 'Rohit Sharma')
    """
    c_tokens = _tokens(customer_name)
    d_tokens = _tokens(doc_name)
    if not c_tokens or not d_tokens:
        return {"match": True, "type": "empty_tokens"}

    # Exact token match regardless of order
    if set(c_tokens) == set(d_tokens) and len(c_tokens) == len(d_tokens):
        return {"match": True, "type": "exact"}

    def _tok_compat(a: str, b: str) -> bool:
        if a == b:
            return True
        if len(a) == 1 and b.startswith(a):
            return True
        if len(b) == 1 and a.startswith(b):
            return True
        return False

    # Find matched token pairs
    matched_c: set[int] = set()
    matched_d: set[int] = set()
    for di, d in enumerate(d_tokens):
        for ci, c in enumerate(c_tokens):
            if ci not in matched_c and _tok_compat(c, d):
                matched_c.add(ci)
                matched_d.add(di)
                break

    # Conflicting full tokens (len >= 2) that could not be matched
    conflicting_d = [d for di, d in enumerate(d_tokens) if di not in matched_d and len(d) >= 2]
    conflicting_c = [c for ci, c in enumerate(c_tokens) if ci not in matched_c and len(c) >= 2]

    # No overlapping tokens at all -> genuine mismatch
    if len(matched_c) == 0:
        return {"match": False, "type": "mismatch"}

    # Conflicting distinct full names present on both sides (e.g. Vikram vs Rohit)
    if conflicting_d and conflicting_c:
        return {"match": False, "type": "conflicting_name"}

    min_tokens = min(len(c_tokens), len(d_tokens))
    total_matched = len(matched_c)

    # All tokens of the smaller side matched (e.g. initial expansion or middle name omission)
    if total_matched >= min_tokens:
        return {"match": True, "type": "acceptable_fuzzy"}

    # At least 2 tokens matched and at most one side has extra tokens
    if total_matched >= 2 and (not conflicting_d or not conflicting_c):
        return {"match": True, "type": "acceptable_fuzzy"}

    # Defensive fallback
    common = len(set(c_tokens) & set(d_tokens))
    smallest = min(len(c_tokens), len(d_tokens))
    compatible = (common == 1 if smallest == 1 else common >= min(2, smallest))
    return {
        "match": compatible,
        "type": "acceptable_fuzzy" if compatible else "mismatch",
    }


def names_compatible(a: str, b: str) -> bool:
    return match_name(a, b)["match"]


def _parse_date(s: str) -> date | None:
    s = str(s or "").strip()
    if not s:
        return None
    if "T" in s:
        s = s.split("T")[0]
    # Strip common ordinal indicators like 1st, 2nd, 3rd, 4th
    s_clean = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", s, flags=re.IGNORECASE).strip()
    for fmt in (
        "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%Y/%m/%d",
        "%d.%m.%Y", "%Y.%m.%d",
        "%d %b %Y", "%d-%b-%Y", "%d %B %Y", "%d-%B-%Y",
        "%b %d, %Y", "%B %d, %Y"
    ):
        for cand in (s, s_clean):
            try:
                return datetime.strptime(cand, fmt).date()
            except ValueError:
                pass
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


def _check_structural_identifier(slot: str, fields: dict) -> list[str]:
    """Deterministic structural validation of identifiers (handles both raw and masked values)."""
    flags = []
    # PAN structural format: e.g. ABCPE1234F or masked XXXX234F / ABC****F
    pan_val = str(fields.get("pan_number") or "").strip()
    if pan_val and slot in ("pan", "form_16"):
        # If masked with XXXX, check length and suffix
        if pan_val.startswith("XXXX"):
            digits_suffix = pan_val[4:]
            if len(digits_suffix) != 4 or not re.match(r"^[0-9]{3}[A-Z]$", digits_suffix):
                flags.append("invalid_structural_identifier:pan")
        elif not re.match(r"^[A-Z]{5}[0-9]{4}[A-Z]$", pan_val) and not re.match(r"^[A-Z]{3}\*{4}[A-Z]$", pan_val):
            flags.append("invalid_structural_identifier:pan")

    # Aadhaar structural format: 12 digits or masked XXXX...
    aadhaar_val = str(fields.get("aadhaar_number") or "").replace(" ", "").strip()
    if aadhaar_val and slot == "aadhaar":
        if aadhaar_val.startswith("XXXX"):
            digits_suffix = aadhaar_val[4:]
            if len(digits_suffix) != 4 or not digits_suffix.isdigit():
                flags.append("invalid_structural_identifier:aadhaar")
        elif not (aadhaar_val.isdigit() and len(aadhaar_val) == 12):
            flags.append("invalid_structural_identifier:aadhaar")

    # IFSC structural format: 11 chars (e.g. HDFC0001234)
    ifsc_val = str(fields.get("ifsc") or "").strip()
    if ifsc_val and slot in ("cancelled_cheque", "bank_passbook"):
        if not re.match(r"^[A-Z]{4}0[A-Z0-9]{6}$", ifsc_val, re.I):
            flags.append("invalid_structural_identifier:ifsc")

    # GSTIN structural format: 15 chars (e.g. 27ABCDE1234F1Z5) or masked XXXX...
    gstin_val = str(fields.get("gstin") or "").strip().upper()
    if gstin_val and slot == "gst_certificate":
        if gstin_val.startswith("XXXX"):
            digits_suffix = gstin_val[4:]
            if len(digits_suffix) != 4:
                flags.append("invalid_structural_identifier:gstin")
        elif not re.match(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", gstin_val):
            flags.append("invalid_structural_identifier:gstin")

    # FSSAI structural format: 14 digits (e.g. 10012011000123) or masked XXXX...
    fssai_val = str(
        fields.get("fssai_licence_number")
        or fields.get("fssai_registration_number")
        or fields.get("registration_number")
        or fields.get("license_number")
        or ""
    ).strip()
    if fssai_val and slot == "fssai":
        if fssai_val.startswith("XXXX"):
            digits_suffix = fssai_val[4:]
            if len(digits_suffix) != 4 or not digits_suffix.isdigit():
                flags.append("invalid_structural_identifier:fssai")
        elif not re.match(r"^\d{14}$", fssai_val):
            flags.append("invalid_structural_identifier:fssai")

    # CIN structural format: 21 alphanumeric chars (e.g. U72900MH2025PTC123456) or masked XXXX...
    cin_val = str(fields.get("cin") or "").strip().upper()
    if cin_val and slot == "certificate_of_incorporation":
        if cin_val.startswith("XXXX"):
            digits_suffix = cin_val[4:]
            if len(digits_suffix) != 4 or not digits_suffix.isalnum():
                flags.append("invalid_structural_identifier:cin")
        elif not re.match(r"^[UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$", cin_val):
            flags.append("invalid_structural_identifier:cin")

    # Udyam structural format: UDYAM-XX-00-0000000 or masked XXXX...
    udyam_val = str(fields.get("udyam_registration_number") or "").strip().upper()
    if udyam_val and slot == "udyam":
        if udyam_val.startswith("XXXX"):
            digits_suffix = udyam_val[4:]
            if len(digits_suffix) != 4:
                flags.append("invalid_structural_identifier:udyam")
        elif not re.match(r"^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$", udyam_val):
            flags.append("invalid_structural_identifier:udyam")

    return flags


def _name_mismatch(fields: dict, customer_name: str) -> bool:
    for k, v in fields.items():
        if k.lower() in NAME_KEYS and isinstance(v, str) and v.strip():
            m = match_name(customer_name, v)
            if not m["match"]:
                return True
    return False


def _evaluate_cross_check(cc: Any, fields: dict, customer_name: str) -> list[str]:
    """Evaluate cross_check payload defensively without false positives on missing fields.
    
    - Ignores unextracted/missing fields (reason: 'field_not_found_in_document').
    - Emits cross_check_failed on actual cross-check discrepancies.
    - If the failure is on name, also tags holder_name_mismatch for identity clarity.
    """
    if not cc:
        return []

    flags: list[str] = []

    if isinstance(cc, dict):
        # Shape A: {"match": false, "mismatches": [...], "fields": {...}}
        if "match" in cc or "matched" in cc:
            matched_flag = cc.get("match") if "match" in cc else cc.get("matched")
            if matched_flag is False:
                mismatches = [str(m).lower() for m in (cc.get("mismatches") or [])]
                fields_dict = cc.get("fields") or {}
                has_name_fail = "name" in mismatches or (isinstance(fields_dict, dict) and fields_dict.get("name") is False)
                if has_name_fail:
                    flags.append("holder_name_mismatch")
                flags.append("cross_check_failed")
            return list(dict.fromkeys(flags))

        # Shape B: {"name": {"matched": false, "reason": "..."}, "dob": {...}}
        for field_name, f_data in cc.items():
            if isinstance(f_data, dict):
                matched = f_data.get("matched")
                if matched is None:
                    matched = f_data.get("match")
                reason = str(f_data.get("reason") or "").lower()

                # If the field was simply not found in the document, it is NOT a cross-check failure
                if reason in ("field_not_found_in_document", "not_extracted", "field_missing", "field_not_found"):
                    continue

                if matched is False:
                    if field_name.lower() in ("name", "holder_name", "account_holder", "customer_name"):
                        flags.append("holder_name_mismatch")
                    flags.append("cross_check_failed")

            elif f_data is False and field_name in ("match", "matched", "valid", "passed", "ok"):
                flags.append("cross_check_failed")

    elif isinstance(cc, list):
        for item in cc:
            flags.extend(_evaluate_cross_check(item, fields, customer_name))

    return list(dict.fromkeys(flags))


def _cross_check_failed(cc) -> bool:
    """Backward-compatible helper."""
    flags = _evaluate_cross_check(cc, {}, "")
    return "cross_check_failed" in flags or "holder_name_mismatch" in flags


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

        # 0. Fail-safe for unsupported or unrecognized document slots
        canonical_slot = canonical_key(slot)
        if not canonical_slot:
            flags.append("unsupported_document_type")
            return Decision(DecisionState.REJECTED, flags, "unsupported_document_type", conf)
        slot = canonical_slot

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

        # 5. Cross-check evaluation (safely mapped and deduplicated)
        cc_flags = _evaluate_cross_check(_val("cross_check"), fields, customer_name)
        for cf in cc_flags:
            if cf not in flags:
                flags.append(cf)

        # 6. Demo / non-official document markers
        if _demo(fields):
            flags.append("demo_or_non_official_document")

        # 7. Document expiry check
        if _expired(fields):
            flags.append("document_expired")

        # 8. Customer name compatibility (evaluated for personal document categories only)
        if slot in DOCS_WITH_PERSONAL_HOLDER_NAME:
            if "holder_name_mismatch" not in flags and _name_mismatch(fields, customer_name):
                flags.append("holder_name_mismatch")

        # 8b. Structural identifier validity
        structural_flags = _check_structural_identifier(slot, fields)
        flags.extend(structural_flags)

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
        missing = [f for f in needed if not _has_field(fields, f)]
        field_confs = _val("field_confidences") or {}
        low_fields = [f for f in needed if _has_field(fields, f) and _get_field_conf(field_confs, fields, f) < min_field]
        if missing:
            flags.append("missing_fields:" + ",".join(missing))
        if low_fields:
            flags.append("low_field_confidence:" + ",".join(low_fields))

        # 11. Low confidence detection (strictly routes to manual review)
        if conf < min_review:
            flags.append("low_confidence")

        # Prioritize flags so specific root causes precede generic flags
        flags = prioritize_flags(flags)

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
            or f.startswith("invalid_structural_identifier:")
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
        or f.startswith("invalid_structural_identifier:")
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

    verdict = getattr(ai, "verdict", None) if hasattr(ai, "verdict") else (ai.get("decision") or ai.get("verdict") if isinstance(ai, dict) else None)
    confidence = getattr(ai, "confidence", None) if hasattr(ai, "confidence") else (ai.get("confidence") if isinstance(ai, dict) else None)
    reason = getattr(ai, "reason", None) if hasattr(ai, "reason") else (ai.get("reason") or ai.get("evidence_summary") if isinstance(ai, dict) else "")
    risk_flags = getattr(ai, "risk_flags", []) if hasattr(ai, "risk_flags") else (ai.get("risk_flags") or [] if isinstance(ai, dict) else [])

    conf_num = _num(confidence)
    if 0.0 <= conf_num <= 1.0:
        conf_num = conf_num * 100.0

    accumulated_flags = prioritize_flags(decision.flags)
    if risk_flags:
        accumulated_flags = prioritize_flags(accumulated_flags + [f"ai_risk:{rf}" for rf in risk_flags])

    if str(verdict or "").lower() == "verified" and conf_num >= 90.0 and not risk_flags:
        return Decision(
            DecisionState.VERIFIED,
            accumulated_flags + ["ai_verified"],
            str(reason or "AI verified")[:300],
            decision.confidence,
        )

    flag = "ai_uncertain" if verdict else "rules_inconclusive"
    return Decision(
        DecisionState.MANUAL_REVIEW,
        accumulated_flags + [flag],
        str(reason or "needs_human_check")[:300],
        decision.confidence,
    )
