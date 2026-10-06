"""Per-document processing: OCR -> mask -> rules -> (AI if needed) -> verified / manual review / rejected."""
import logging

from sqlalchemy import select

from . import ai_service, rules
from .config import get_settings
from .db import utcnow
from .masking import create_redacted_evidence, mask_fields
from .models import Customer, Document, ManualReview, OcrResult
from .ocr_client import OCRResult, get_ocr_client
from .services import audit, mark_verified, recalc_case, request_resubmission
from .storage import get_file

log = logging.getLogger(__name__)


def _open_review(db, doc: Document, reason: str, flags: list[str]) -> None:
    db.add(ManualReview(document_id=doc.id, customer_id=doc.customer_id, reason=reason, flags=flags))


def apply_decision(db, doc: Document, customer: Customer, d: rules.Decision) -> None:
    doc.flags, doc.reason, doc.confidence, doc.processed_at = d.flags, d.reason, d.confidence, utcnow()
    if d.outcome == "verified":
        mark_verified(db, doc)
    elif d.outcome == "rejected":
        doc.verification_status = "rejected"
        request_resubmission(db, customer, doc)
    else:
        doc.verification_status = "manual_review"
        _open_review(db, doc, d.reason, d.flags)
    audit(db, "system", "document_" + doc.verification_status, "document", doc.id, {"flags": d.flags})
    db.flush()
    recalc_case(db, customer)


def handle_process_document(db, payload: dict) -> None:
    s = get_settings()
    doc = db.get(Document, payload["document_id"])
    if not doc or doc.file_state != "stored" or doc.superseded:
        return
    if doc.verification_status == "verified":
        return
    customer = db.get(Customer, doc.customer_id)
    if customer.consent_status != "granted" or customer.case_status != "in_progress":
        doc.ocr_status, doc.reason = "failed", "processing_stopped"  # consent withdrawn / case closed
        return

    doc.ocr_status = "processing"
    audit(db, "system", "ocr_processing_started", "document", doc.id, {"doc_type": doc.doc_type})
    db.commit()

    data = get_file(doc.storage_key)
    expected = {"name": customer.name} if s.ocr_pass_expected_name else None
    try:
        res: OCRResult = get_ocr_client().extract(
            data, doc.filename, doc.mime, doc.doc_type, expected, customer_id=customer.id
        )
    except TypeError:
        res = get_ocr_client().extract(data, doc.filename, doc.mime, doc.doc_type, expected)  # may raise -> retry

    masked = create_redacted_evidence(res)  # raw values live in memory only
    ocr_rec = db.scalar(select(OcrResult).where(OcrResult.document_id == doc.id))
    if ocr_rec:
        ocr_rec.payload = masked
    else:
        db.add(OcrResult(document_id=doc.id, payload=masked))

    if res.status == "error":
        if res.reason in ("doc_type_mismatch", "wrong_document_type", "type_mismatch"):
            doc.ocr_status = "completed"
            audit(db, "system", "ocr_completed", "document", doc.id, {"status": "completed", "doc_type": doc.doc_type, "detected_type": res.detected_type})
            flags = ["wrong_document_type"] + ([f"ocr_reason:{res.reason}"] if res.reason else [])
            apply_decision(db, doc, customer, rules.Decision("rejected", flags, "wrong_document_type"))
            return
        doc.ocr_status = "failed"
        audit(db, "system", "ocr_failed", "document", doc.id, {"reason": res.reason or "ocr_error"})
        flags = ["ocr_error"] + ([f"ocr_reason:{res.reason}"] if res.reason else [])
        apply_decision(db, doc, customer, rules.Decision("manual_review", flags, "ocr_could_not_read_document"))
        return

    doc.ocr_status = "completed"
    audit(db, "system", "ocr_completed", "document", doc.id, {"status": "completed", "doc_type": doc.doc_type, "confidence": res.confidence})
    decision = rules.evaluate(masked, doc.doc_type, customer.name,
                              min_overall=s.min_overall_confidence, min_field=s.min_field_confidence)
    if decision.outcome in ("needs_ai", "AI_REQUIRED"):
        ai = ai_service.assess(doc.doc_type, masked, decision.flags)
        if ai:
            v = getattr(ai, "verdict", None) or (ai.get("verdict") if isinstance(ai, dict) else None)
            c = getattr(ai, "confidence", None) or (ai.get("confidence") if isinstance(ai, dict) else None)
            audit(db, "system", "ai_assessment_completed", "document", doc.id,
                  {"verdict": v, "confidence": c})
        decision = rules.apply_ai(decision, ai)
    apply_decision(db, doc, customer, decision)


def on_exhausted_process_document(db, payload: dict, error: str) -> None:
    """OCR stayed unavailable after all retries: send the document to a human instead of losing it."""
    doc = db.get(Document, payload["document_id"])
    if not doc or doc.file_state != "stored" or doc.verification_status != "not_started":
        return
    customer = db.get(Customer, doc.customer_id)
    doc.ocr_status = "failed"
    apply_decision(db, doc, customer, rules.Decision("manual_review", ["ocr_unavailable"], "ocr_service_unavailable"))


HANDLERS = {"process_document": handle_process_document}
ON_EXHAUSTED = {"process_document": on_exhausted_process_document}
