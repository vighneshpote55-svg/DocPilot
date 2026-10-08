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
    rev = ManualReview(document_id=doc.id, customer_id=doc.customer_id, reason=reason, flags=flags)
    db.add(rev)
    db.flush()
    audit(db, "system", "manual_review_created", "manual_review", rev.id, {"document_id": doc.id, "reason": reason, "flags": flags})


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

    try:
        data = get_file(doc.storage_key)
    except Exception as e:
        log.exception("Storage retrieval or decryption failed for document %s: %s", doc.id, e)
        doc.ocr_status = "failed"
        audit(db, "system", "file_retrieval_failed", "document", doc.id, {"reason": "storage_or_decryption_error"})
        apply_decision(db, doc, customer, rules.Decision("manual_review", ["file_retrieval_error"], "storage_or_decryption_error"))
        return
    expected = {"name": customer.name} if s.ocr_pass_expected_name else None
    try:
        res: OCRResult = get_ocr_client().extract(
            data, doc.filename, doc.mime, doc.doc_type, expected, customer_id=customer.id
        )
    except TypeError:
        res = get_ocr_client().extract(data, doc.filename, doc.mime, doc.doc_type, expected)  # may raise -> retry

    # Privacy Gateway: deterministically mask PII before storing evidence or running rules
    try:
        masked = create_redacted_evidence(res)  # raw values live in memory only
        audit(db, "system", "privacy_gateway_completed", "document", doc.id, {
            "pii_detected_count": len(masked.get("pii_detected", [])),
            "pii_categories": masked.get("pii_detected", []),
        })
    except Exception as e:
        log.exception("Privacy gateway masking failed for document %s: %s", doc.id, e)
        doc.ocr_status = "failed"
        audit(db, "system", "privacy_gateway_failed", "document", doc.id, {"reason": "masking_failure"})
        apply_decision(db, doc, customer, rules.Decision("manual_review", ["privacy_gateway_error"], "privacy_masking_failed"))
        return

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

    # Step 8: Deterministic Rules Verification
    audit(db, "system", "rules_verification_started", "document", doc.id, {"doc_type": doc.doc_type})
    try:
        decision = rules.evaluate(
            masked,
            doc.doc_type,
            customer.name,
            min_overall=s.min_overall_confidence,
            min_field=s.min_field_confidence,
        )
    except Exception as e:
        log.exception("Rules verification failed for document %s: %s", doc.id, e)
        audit(db, "system", "rules_failed", "document", doc.id, {"reason": "rules_evaluation_exception"})
        apply_decision(db, doc, customer, rules.Decision("manual_review", ["rules_engine_error"], "rules_evaluation_failed"))
        return

    # Audit outcome of deterministic rules
    if decision.outcome == "verified":
        audit(db, "system", "rules_verified", "document", doc.id, {"reason": decision.reason})
    elif decision.outcome in ("needs_ai", "AI_REQUIRED"):
        audit(db, "system", "rules_inconclusive", "document", doc.id, {"flags": decision.flags, "confidence": decision.confidence})
    else:
        audit(db, "system", "rules_risk_detected", "document", doc.id, {"flags": decision.flags, "reason": decision.reason})

    if decision.outcome in ("needs_ai", "AI_REQUIRED"):
        # Step 9: AI Verification / Redacted AI Escalation
        audit(db, "system", "ai_verification_started", "document", doc.id, {"doc_type": doc.doc_type})
        
        # Pre-dispatch safety check
        is_safe, pii_err = ai_service.verify_ai_payload_safety(masked)
        if not is_safe:
            log.error("Aborting AI dispatch for document %s: %s detected", doc.id, pii_err)
            audit(db, "system", "ai_failed", "document", doc.id, {"reason": "pii_leak_prevented", "error": pii_err})
            ai = None
        else:
            try:
                ai = ai_service.assess(doc.doc_type, masked, decision.flags)
            except Exception as e:
                log.exception("AI provider exception for document %s: %s", doc.id, e)
                audit(db, "system", "ai_failed", "document", doc.id, {"reason": "provider_error"})
                ai = None

        if ai:
            v = str(getattr(ai, "verdict", None) or (ai.get("verdict") if isinstance(ai, dict) else "")).lower()
            c = getattr(ai, "confidence", None) or (ai.get("confidence") if isinstance(ai, dict) else None)
            c_val = float(c) if c is not None else 0.0
            if c_val <= 1.0 and c_val > 0.0:
                c_val = c_val * 100.0

            # Backward-compatible audit event
            audit(db, "system", "ai_assessment_completed", "document", doc.id,
                  {"verdict": v, "confidence": c_val})

            # Step 9 explicit audit events
            if v == "verified" and c_val >= 90.0:
                audit(db, "system", "ai_verified", "document", doc.id, {"confidence": c_val, "verdict": v})
            elif v in ("inconclusive", "uncertain"):
                audit(db, "system", "ai_inconclusive", "document", doc.id, {"confidence": c_val, "verdict": v})
            else:
                audit(db, "system", "ai_manual_review", "document", doc.id, {"confidence": c_val, "verdict": v})
        elif is_safe:
            audit(db, "system", "ai_failed", "document", doc.id, {"reason": "no_ai_response"})

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
