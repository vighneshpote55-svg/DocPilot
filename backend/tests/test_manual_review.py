import logging
import pytest
from sqlalchemy import select

from app import db as dbmod
from app import emailer, jobs
from app.models import AuditLog, Customer, Document, ManualReview, OcrResult
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def onboard(client, docs=("PAN",), name="Rajesh Kumar Sharma", email="rajesh@example.com"):
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": name, "email": email, "required_documents": list(docs)})
    assert r.status_code == 201
    c = r.json()
    consent = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 200
    portal = token_from_outbox("portal")
    return c, portal


def upload(client, portal, doc_type, filename="doc.png", content=PNG):
    return client.post(f"/api/portal/{portal}/upload", data={"doc_type": doc_type},
                       files={"file": (filename, content)})


# 1. Authorized reviewer can access review
def test_authorized_reviewer_can_access_review(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.45,
        reason="low_confidence",
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Rajesh Kumar Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    resp = client.get("/api/admin/reviews", headers=admin_headers())
    assert resp.status_code == 200
    reviews = resp.json()
    assert len(reviews) == 1
    r = reviews[0]
    assert r["customer_name"] == "Rajesh Kumar Sharma"
    assert r["customer_code"] == c["code"]
    assert r["document"]["doc_type"] == "pan"
    assert "ocr_evidence" in r
    assert r["ocr_evidence"] is not None
    # Masked OCR evidence present (PAN masked with XXXX)
    assert r["ocr_evidence"]["extracted_fields"]["pan_number"] == "XXXX234F"


# 2. Unauthorized user is denied
def test_unauthorized_user_is_denied(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.45, reason="low_conf")
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]

    # 401 without auth header
    assert client.get("/api/admin/reviews").status_code == 401
    assert client.post(f"/api/admin/reviews/{rid}/approve", json={}).status_code == 401
    assert client.post(f"/api/admin/reviews/{rid}/reject", json={}).status_code == 401

    # 403 with non-admin auth token
    non_admin = admin_headers("unauthorized_user@example.com")
    assert client.get("/api/admin/reviews", headers=non_admin).status_code == 403
    assert client.post(f"/api/admin/reviews/{rid}/approve", headers=non_admin, json={}).status_code == 403
    assert client.post(f"/api/admin/reviews/{rid}/reject", headers=non_admin, json={}).status_code == 403


# 3. Review reason is displayed
def test_review_reason_is_displayed(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.40,
        reason="document_blurred",
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Rajesh Kumar Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1
    r = reviews[0]
    assert r["reason"] is not None
    assert "document_blurred" in r["reason"] or "low_confidence" in r["reason"]
    assert any("low_confidence" in f or "document_blurred" in f for f in r["flags"])


# 4. Approve -> VERIFIED
def test_approve_sets_verified(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.55,
        reason="marginal_scan",
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Rajesh Kumar Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    doc_id = reviews[0]["document"]["id"]

    res = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={"note": "Approved by senior reviewer"})
    assert res.status_code == 200
    assert res.json()["status"] == "approved"

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "verified"
        review = db.get(ManualReview, rid)
        assert review.status == "approved"
        assert review.decided_by == "admin@example.com"
        assert review.note == "Approved by senior reviewer"

    # Customer portal sees it verified
    portal_state = client.get(f"/api/portal/{portal}").json()
    assert portal_state["documents"][0]["state"] == "verified"


# 5. Reject -> REJECTED
def test_reject_sets_rejected(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.35,
        reason="illegible_scan",
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Rajesh Kumar Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    doc_id = reviews[0]["document"]["id"]

    res = client.post(f"/api/admin/reviews/{rid}/reject", headers=admin_headers(), json={"note": "Scan is unreadable"})
    assert res.status_code == 200
    assert res.json()["status"] == "rejected"

    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        assert doc.verification_status == "rejected"
        review = db.get(ManualReview, rid)
        assert review.status == "rejected"
        assert review.decided_by == "admin@example.com"
        assert review.note == "Scan is unreadable"

    # Customer portal sees it as resubmit
    portal_state = client.get(f"/api/portal/{portal}").json()
    assert portal_state["documents"][0]["state"] == "resubmit"


# 6. Reject -> document becomes eligible for resubmission
def test_reject_allows_resubmission(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.30,
        reason="bad_lighting"
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    client.post(f"/api/admin/reviews/{rid}/reject", headers=admin_headers(), json={"note": "Please retake under bright light"})

    # Check that resubmission email was sent with new portal link
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)
    resubmit_portal_token = token_from_outbox("portal")
    assert resubmit_portal_token is not None

    # Customer re-uploads clean document via portal
    del env.responses["pan"]
    upload_res = upload(client, resubmit_portal_token, "PAN", "clean_pan.png", PNG + b"_clean")
    assert upload_res.status_code == 202
    jobs.run_all()

    # Document verifies and case finishes
    customer_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert customer_detail["case_status"] == "completed"
    assert customer_detail["pending_count"] == 0


# 7. Pending documents are recalculated
def test_pending_documents_recalculated(client, env):
    # Customer requires 2 documents: PAN and Bank Statement
    c, portal = onboard(client, docs=("PAN", "Bank Statement"))
    assert c["pending_count"] == 2

    # Upload clean Bank Statement -> auto-verified
    upload(client, portal, "bank_statement", "bank.pdf", PDF)
    jobs.run_all()

    c_state = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert c_state["pending_count"] == 1
    assert c_state["case_status"] == "in_progress"

    # Upload PAN with low confidence -> goes to manual review
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.50, reason="needs_review")
    upload(client, portal, "PAN")
    jobs.run_all()

    # Still 1 pending
    c_state = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert c_state["pending_count"] == 1

    # Reviewer approves PAN
    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})

    # Case now has 0 pending and completes!
    c_state = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert c_state["pending_count"] == 0
    assert c_state["case_status"] == "completed"
    assert c_state["completed_at"] is not None


# 8. Audit event is created
def test_audit_event_is_created(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.40)
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    doc_id = reviews[0]["document"]["id"]

    client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={"note": "Document physically verified"})

    with dbmod.session_scope() as db:
        logs = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == doc_id)))
        review_audit = next((l for l in logs if l.action == "review_approved"), None)
        assert review_audit is not None
        assert review_audit.actor == "admin@example.com"
        assert review_audit.details.get("note") == "Document physically verified"


# 9. Raw PII is not exposed in logs
def test_raw_pii_not_in_logs(client, env, caplog):
    caplog.set_level(logging.DEBUG)
    raw_pan = "ABCPE9999F"
    raw_acc = "987654321098"

    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.50,
        extracted_fields={"pan_number": raw_pan, "account_number": raw_acc, "name": "Rajesh Kumar Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]

    # Verify that in reviews payload the raw PAN and account are masked
    assert reviews[0]["ocr_evidence"]["extracted_fields"]["pan_number"] == "XXXX999F"
    assert reviews[0]["ocr_evidence"]["extracted_fields"]["account_number"] == "XXXX1098"

    # Approve the review
    client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={"note": "Clean approval"})

    # Assert raw PII never appears in any application logs
    for record in caplog.records:
        assert raw_pan not in record.message
        assert raw_acc not in record.message

    # Assert raw PII never appears in audit logs
    with dbmod.session_scope() as db:
        for audit_entry in db.scalars(select(AuditLog)):
            details_str = str(audit_entry.details or {})
            assert raw_pan not in details_str
            assert raw_acc not in details_str


# 10. Duplicate review actions are safely handled
def test_duplicate_review_actions_safely_handled(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.40)
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]

    # First approve succeeds
    resp1 = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})
    assert resp1.status_code == 200

    # Second approve returns 409 already_decided
    resp2 = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})
    assert resp2.status_code == 409
    assert resp2.json()["detail"] == "already_decided"

    # Rejecting an already approved review also returns 409
    resp3 = client.post(f"/api/admin/reviews/{rid}/reject", headers=admin_headers(), json={})
    assert resp3.status_code == 409
    assert resp3.json()["detail"] == "already_decided"


# Manual Review Triggers: Low confidence, expired document, name mismatch, unreadable document, risk flag
@pytest.mark.parametrize("trigger_type,ocr_kwargs,expected_match", [
    ("low_confidence", {"status": "low_confidence", "doc_type": "pan", "confidence": 0.45}, "low_confidence"),
    ("expired_document", {
        "status": "success",
        "doc_type": "driving_licence",
        "confidence": 0.95,
        "extracted_fields": {"valid_till": "2020-01-01", "name": "Rajesh Kumar Sharma", "licence_number": "DL1234567890123"}
    }, "document_expired"),
    ("name_mismatch", {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "extracted_fields": {"name": "Vikram Adithya Seth", "pan_number": "ABCPE1234F"}
    }, "holder_name_mismatch"),
    ("unreadable_document", {"status": "error", "doc_type": "pan", "confidence": 0.1, "reason": "unreadable"}, "ocr_could_not_read_document"),
    ("risk_flag", {
        "status": "success",
        "doc_type": "pan",
        "confidence": 0.95,
        "extracted_fields": {"name": "Rajesh Kumar Sharma", "pan_number": "ABCPE1234F"},
        "risk_flags": ["tampering_detected"]
    }, "risk:tampering_detected"),
])
def test_manual_review_triggers(client, env, trigger_type, ocr_kwargs, expected_match):
    doc_type = ocr_kwargs["doc_type"]
    c, portal = onboard(client, docs=(doc_type,))
    env.responses[doc_type] = OCRResult(**ocr_kwargs)
    upload(client, portal, doc_type)
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1, f"Expected 1 review item for {trigger_type}, got {len(reviews)}"
    r = reviews[0]
    assert r["document"]["needs_manual_review"] is True
    matched = any(expected_match in f for f in r["flags"]) or (r.get("reason") and expected_match in r["reason"])
    assert matched, f"Expected {expected_match} in flags {r['flags']} or reason {r.get('reason')}"


# Step 10: Rules RISK and AI manual_review / failure unified into Manual Review
def test_rules_risk_and_audit_lifecycle(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.95,
        extracted_fields={"name": "Rajesh Kumar Sharma", "pan_number": "ABCPE1234F"},
        risk_flags=["suspected_alteration"]
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    # Verify review created and audit logged
    with dbmod.session_scope() as db:
        rev = db.scalar(select(ManualReview).where(ManualReview.customer_id == c["id"]))
        assert rev is not None
        assert rev.status == "open"
        assert any("suspected_alteration" in f for f in rev.flags)

        logs = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == rev.id)))
        created_audit = next((l for l in logs if l.action == "manual_review_created"), None)
        assert created_audit is not None
        assert created_audit.details.get("reason") is not None

    # Verify listing and single review endpoint emit manual_review_opened
    list_res = client.get("/api/admin/reviews", headers=admin_headers())
    assert list_res.status_code == 200
    rev_id = list_res.json()[0]["id"]

    detail_res = client.get(f"/api/admin/reviews/{rev_id}", headers=admin_headers())
    assert detail_res.status_code == 200
    assert detail_res.json()["id"] == rev_id

    with dbmod.session_scope() as db:
        logs = list(db.scalars(select(AuditLog).where(AuditLog.action == "manual_review_opened")))
        assert len(logs) >= 2


def test_ai_manual_review_and_ai_failure_route_to_review(client, env, monkeypatch):
    from app import ai_service
    # 1. AI manual_review outcome
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="pan",
        confidence=0.72,  # inconclusive, triggers AI
        extracted_fields={"pan_number": "ABCPE1234F", "name": "Rajesh Kumar Sharma"}
    )
    monkeypatch.setattr(ai_service, "assess", lambda *args, **kwargs: {
        "verdict": "manual_review",
        "confidence": 0.65,
        "reason_codes": ["ai_uncertain_layout"],
        "risk_flags": ["layout_anomaly"],
    })
    upload(client, portal, "PAN")
    jobs.run_all()

    revs = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(revs) == 1
    assert any("layout_anomaly" in f or "ai_uncertain_layout" in f for f in revs[0]["flags"])

    # 2. AI failure outcome
    monkeypatch.setattr(ai_service, "assess", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("AI Timeout")))
    c2, portal2 = onboard(client, docs=("driving_licence",), name="Sunil Sharma", email="sunil@example.com")
    env.responses["driving_licence"] = OCRResult(
        status="success",
        doc_type="driving_licence",
        confidence=0.72,
        extracted_fields={"licence_number": "DL1234567890123", "name": "Sunil Sharma", "valid_till": "2030-01-01"}
    )
    upload(client, portal2, "driving_licence")
    jobs.run_all()

    detail = client.get(f"/api/admin/customers/{c2['id']}", headers=admin_headers()).json()
    assert detail["documents"][0]["verification_status"] == "manual_review"


def test_prevent_approving_superseded_or_withdrawn_document(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.45)
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]
    doc_id = reviews[0]["document"]["id"]

    # Mark document superseded directly in db to test guardrail
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.superseded = True

    # Attempt to approve superseded document should fail with 409
    res = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})
    assert res.status_code == 409
    assert "document_superseded" in res.json()["detail"]

    # Reset superseded and withdraw customer consent
    with dbmod.session_scope() as db:
        doc = db.get(Document, doc_id)
        doc.superseded = False
        cust = db.get(Customer, c["id"])
        cust.consent_status = "withdrawn"

    # Attempt to approve document when consent is withdrawn should fail with 400
    res2 = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})
    assert res2.status_code == 400
    assert "consent_withdrawn" in res2.json()["detail"]


def test_list_reviews_status_all_and_filtering(client):
    # Test that status=all returns 200 and not 422
    res_all = client.get("/api/admin/reviews?status=all", headers=admin_headers())
    assert res_all.status_code == 200
    assert isinstance(res_all.json(), list)

    res_open = client.get("/api/admin/reviews?status=open", headers=admin_headers())
    assert res_open.status_code == 200
    assert isinstance(res_open.json(), list)

    res_app = client.get("/api/admin/reviews?status=approved", headers=admin_headers())
    assert res_app.status_code == 200
    assert isinstance(res_app.json(), list)

    res_rej = client.get("/api/admin/reviews?status=rejected", headers=admin_headers())
    assert res_rej.status_code == 200
    assert isinstance(res_rej.json(), list)

    res_invalid = client.get("/api/admin/reviews?status=invalid_status", headers=admin_headers())
    assert res_invalid.status_code == 422

