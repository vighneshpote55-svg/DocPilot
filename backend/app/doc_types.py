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
    "gst_certificate": "GST Registration Certificate",
    "certificate_of_incorporation": "Certificate of Incorporation",
    "partnership_deed": "Partnership Deed",
    "rent_agreement": "Rent Agreement",
    "form_16": "Form 16",
    "bank_passbook": "Bank Passbook",
    "property_tax_receipt": "Property Tax Receipt",
    "iec_certificate": "IEC Certificate",
    "income_certificate": "Income Certificate",
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
    if "gst" in n or "gstin" in n:
        return "gst_certificate"
    if "incorporation" in n or "cin" in n:
        return "certificate_of_incorporation"
    if "partnership" in n or "deed" in n:
        return "partnership_deed"
    if "rent" in n or "lease" in n or "tenancy" in n:
        return "rent_agreement"
    if "form 16" in n or "form16" in n:
        return "form_16"
    if "passbook" in n:
        return "bank_passbook"
    if "property tax" in n or "tax receipt" in n:
        return "property_tax_receipt"
    if "iec" in n or "import export" in n or "importer exporter" in n:
        return "iec_certificate"
    if "income cert" in n or "income certificate" in n:
        return "income_certificate"
    return n


def canonical_key(v) -> str | None:
    """Return the canonical key for any spelling of a supported document, else None."""
    f = family(v)
    return f if f in CANONICAL else None


def label(key: str) -> str:
    return CANONICAL.get(key, key)


def _squash(v) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(v or "").lower())


_STRICT: dict[str, str] = {}
for _k, _l in CANONICAL.items():
    _STRICT[_squash(_k)] = _k
    _STRICT[_squash(_l)] = _k


def strict_key(v) -> str | None:
    """Exact canonical key or exact label (case/punctuation ignored). No fuzzy matching."""
    return _STRICT.get(_squash(v))


# If your OCR service names a type differently from our canonical key, map it here.
OCR_TYPE_NAMES: dict[str, str] = {k: k for k in CANONICAL}
OCR_TYPE_NAMES["voter"] = "voter_id"

# Document types that represent individuals and expect the customer's personal name
DOCS_WITH_PERSONAL_HOLDER_NAME: set[str] = {
    "aadhaar",
    "pan",
    "passport",
    "voter",
    "driving_licence",
    "salary_slip",
    "cancelled_cheque",
    "bank_passbook",
    "itr",
    "form_16",
    "income_certificate",
    "bank_statement",
}

# Document types that represent business entities or non-personal accounts
DOCS_WITH_ENTITY_NAME: set[str] = {
    "gst_certificate",
    "certificate_of_incorporation",
    "partnership_deed",
    "udyam",
    "fssai",
    "shop_establishment",
    "iec_certificate",
    "utility_bill",
    "property_tax_receipt",
    "rent_agreement",
}

