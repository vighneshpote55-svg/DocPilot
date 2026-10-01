"""Canonical document types and the name normaliser (ported from the n8n `family()` function)."""
import re

CANONICAL: dict[str, str] = {
    "aadhaar": "Aadhaar Card",
    "pan": "PAN Card",
    "passport": "Passport",
    "voter": "Voter ID",
    "driving_licence": "Driving Licence",
    "bank_statement": "Bank Statement",
    "salary_slip": "Salary Slip / Payslip",
    "cancelled_cheque": "Cancelled Cheque",
    "itr": "ITR / ITR Acknowledgement",
    "udyam": "Udyam Registration Certificate",
    "shop_establishment": "Shop & Establishment Certificate",
    "fssai": "FSSAI Certificate",
    "utility_bill": "Electricity / Utility Bill",
}


def _norm(v) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(v or "").lower()).strip()


def family(v) -> str:
    n = _norm(v)
    if "aadhaar" in n or "adhar" in n:
        return "aadhaar"
    if n == "pan" or "pan card" in n or "permanent account" in n:
        return "pan"
    if "passport" in n:
        return "passport"
    if "voter" in n or "epic" in n:
        return "voter"
    if "driving" in n:
        return "driving_licence"
    if "bank statement" in n:
        return "bank_statement"
    if "salary" in n or "payslip" in n or "pay slip" in n:
        return "salary_slip"
    if "cancelled cheque" in n or "canceled cheque" in n:
        return "cancelled_cheque"
    if re.search(r"\bitr\b", n) or "income tax return" in n:
        return "itr"
    if "udyam" in n or "msme" in n:
        return "udyam"
    if ("shop" in n and "establishment" in n) or "shop act" in n or "shops act" in n:
        return "shop_establishment"
    if "fssai" in n or "food safety" in n:
        return "fssai"
    if "electric" in n or "utility" in n:
        return "utility_bill"
    return n


def canonical_key(v) -> str | None:
    """Return the canonical key for any spelling of a supported document, else None."""
    f = family(v)
    return f if f in CANONICAL else None


def label(key: str) -> str:
    return CANONICAL.get(key, key)


# If your OCR service names a type differently from our canonical key, map it here.
OCR_TYPE_NAMES: dict[str, str] = {k: k for k in CANONICAL}
OCR_TYPE_NAMES["voter"] = "voter_id"
