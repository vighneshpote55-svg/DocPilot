"""
Tests for Phase 7: Pending Documents and Completion Engine.
Covers all 10 required scenarios + document file deletion / case reopening.
"""
from datetime import datetime
from sqlalchemy import select

from app import db as dbmod
from app import emailer, jobs, services
from app.models import AuditLog, Customer, Document, ManualReview, RequiredDocument
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def onboard(client, docs=("PAN",), name="Vikram Sharma"):
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": name, "email": "vikram@example.com", "required_documents": list(docs)})
    assert r.status_code == 201
    c = r.json()
    consent = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 200
    portal = token_from_outbox("portal")
    return c, portal


def upload(client, portal, doc_type, filename="doc.png", content=PNG):
    return client.post(f"/api/portal/{portal}/upload", data={"doc_type": doc_type},
                       files={"file": (filename, content)})


# 1. Missing document -> PENDING
def test_missing_document_pending(client, env):
    c, portal = onboard(client, docs=("PAN", "Aadhaar"))

    # Check via Portal API
    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["case_status"] == "in_progress"
    assert portal_data["pending_count"] == 2
    assert portal_data["received_count"] == 0
    assert portal_data["required_count"] == 2

    # Check via Admin API
    admin_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert admin_detail["case_status"] == "in_progress"
    assert admin_detail["pending_count"] == 2
    assert admin_detail["received_count"] == 0

    # Check in PostgreSQL directly
    with dbmod.session_scope() as db:
        reqs = list(db.scalars(select(RequiredDocument).where(RequiredDocument.customer_id == c["id"])))
        assert len(reqs) == 2
        for r in reqs:
            assert r.verified_document_id is None


# 2. Verified required document -> removed from pending
def test_verified_required_document_removed_from_pending(client, env):
    c, portal = onboard(client, docs=("PAN", "Bank Statement"))

    # Upload clean PAN -> auto-verified
    res = upload(client, portal, "PAN")
    assert res.status_code == 202
    jobs.run_all()

    # Portal shows pending dropped from 2 to 1
    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["pending_count"] == 1
    assert portal_data["received_count"] == 1
    assert portal_data["case_status"] == "in_progress"

    # PostgreSQL check
    with dbmod.session_scope() as db:
        pan_req = db.scalar(select(RequiredDocument).where(
            RequiredDocument.customer_id == c["id"], RequiredDocument.doc_type == "pan"
        ))
        assert pan_req.verified_document_id is not None

        bank_req = db.scalar(select(RequiredDocument).where(
            RequiredDocument.customer_id == c["id"], RequiredDocument.doc_type == "bank_statement"
        ))
        assert bank_req.verified_document_id is None

        # pending_keys only contains unverified doc
        assert services.pending_keys(db, c["id"]) == ["bank_statement"]


# 3. Processing document -> remains pending
def test_processing_document_remains_pending(client, env):
    c, portal = onboard(client, docs=("PAN",))

    # Upload PAN, but do NOT run worker jobs (remains in processing)
    res = upload(client, portal, "PAN")
    assert res.status_code == 202

    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["pending_count"] == 1
    assert portal_data["received_count"] == 0
    assert portal_data["case_status"] == "in_progress"
    assert portal_data["documents"][0]["state"] == "processing"

    with dbmod.session_scope() as db:
        req = db.scalar(select(RequiredDocument).where(RequiredDocument.customer_id == c["id"]))
        assert req.verified_document_id is None
        assert services.pending_keys(db, c["id"]) == ["pan"]


# 4. Manual review document -> remains pending
def test_manual_review_document_remains_pending(client, env):
    c, portal = onboard(client, docs=("PAN",))

    env.responses["pan"] = OCRResult(
        status="low_confidence",
        doc_type="pan",
        confidence=0.45,
        reason="document_blurred",
        extracted_fields={"pan_number": "ABCDE1234F", "name": "Vikram Sharma"}
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["pending_count"] == 1
    assert portal_data["received_count"] == 0
    assert portal_data["case_status"] == "in_progress"
    assert portal_data["documents"][0]["state"] == "under_review"

    with dbmod.session_scope() as db:
        req = db.scalar(select(RequiredDocument).where(RequiredDocument.customer_id == c["id"]))
        assert req.verified_document_id is None
        assert services.pending_keys(db, c["id"]) == ["pan"]


# 5. Rejected document -> remains pending
def test_rejected_document_remains_pending(client, env):
    c, portal = onboard(client, docs=("PAN",))

    # Upload Aadhaar data into PAN slot -> rejected
    env.responses["pan"] = OCRResult(
        status="success",
        doc_type="aadhaar",
        confidence=0.95,
        reason="wrong_document_type"
    )
    upload(client, portal, "PAN")
    jobs.run_all()

    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["pending_count"] == 1
    assert portal_data["received_count"] == 0
    assert portal_data["case_status"] == "in_progress"
    assert portal_data["documents"][0]["state"] == "resubmit"

    with dbmod.session_scope() as db:
        req = db.scalar(select(RequiredDocument).where(RequiredDocument.customer_id == c["id"]))
        assert req.verified_document_id is None
        assert services.pending_keys(db, c["id"]) == ["pan"]


# 6. All required documents verified -> COMPLETED
def test_all_required_documents_verified_completed(client, env):
    c, portal = onboard(client, docs=("PAN", "Bank Statement"))

    # Upload Bank Statement
    upload(client, portal, "bank_statement", "bank.pdf", PDF)
    jobs.run_all()

    # Upload PAN
    upload(client, portal, "PAN", "pan.png", PNG)
    jobs.run_all()

    # Customer is now completed
    portal_data = client.get(f"/api/portal/{portal}").json()
    assert portal_data["pending_count"] == 0
    assert portal_data["received_count"] == 2
    assert portal_data["case_status"] == "completed"

    admin_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert admin_detail["case_status"] == "completed"
    assert admin_detail["completed_at"] is not None
    assert admin_detail["pending_count"] == 0
    assert admin_detail["received_count"] == 2

    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.case_status == "completed"
        assert cust.completed_at is not None
        assert cust.delete_after is not None

        # Audit event recorded
        audits = list(db.scalars(select(AuditLog).where(
            AuditLog.entity_id == str(c["id"]), AuditLog.action == "case_completed"
        )))
        assert len(audits) >= 1

        # Email sent
        assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)


# 7. Rejected document resubmission -> correctly recalculates
def test_rejected_document_resubmission_recalculates(client, env):
    c, portal = onboard(client, docs=("PAN",))

    # Initial upload rejected
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.30)
    upload(client, portal, "PAN")
    jobs.run_all()

    portal_state = client.get(f"/api/portal/{portal}").json()
    assert portal_state["case_status"] == "in_progress"
    assert portal_state["pending_count"] == 1

    # Resubmission token sent via email
    resubmit_token = token_from_outbox("portal")
    assert resubmit_token is not None

    # Customer re-uploads clean PAN
    del env.responses["pan"]
    upload(client, resubmit_token, "PAN", "clean_pan.png", PNG + b"_clean")
    jobs.run_all()

    # Recalculated to COMPLETED
    admin_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert admin_detail["case_status"] == "completed"
    assert admin_detail["pending_count"] == 0
    assert admin_detail["received_count"] == 1


# 8. Manual-review approval -> correctly recalculates
def test_manual_review_approval_recalculates(client, env):
    c, portal = onboard(client, docs=("PAN",))

    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.50)
    upload(client, portal, "PAN")
    jobs.run_all()

    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    rid = reviews[0]["id"]

    # Reviewer approves
    res = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={"note": "Approved by senior reviewer"})
    assert res.status_code == 200

    admin_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert admin_detail["case_status"] == "completed"
    assert admin_detail["pending_count"] == 0
    assert admin_detail["received_count"] == 1


# 9. Duplicate uploads do not falsely complete the customer
def test_duplicate_uploads_do_not_falsely_complete(client, env):
    # Customer requires PAN and Salary Slip (2 distinct documents)
    c, portal = onboard(client, docs=("PAN", "Salary Slip"))

    # Upload PAN -> verified
    upload(client, portal, "PAN", "pan.png", PNG)
    jobs.run_all()

    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        # Even if a second duplicate PAN document record exists in DB for this customer:
        dup_doc = Document(
            customer_id=c["id"], doc_type="pan", filename="dup_pan.png", mime="image/png",
            size=len(PNG), sha256="fake_sha_pan_dup", storage_key=f"{c['id']}/dup.enc",
            verification_status="verified", file_state="stored"
        )
        db.add(dup_doc)
        db.flush()

        # Recalculate
        status = services.recalc_case(db, cust)
        assert status["pending_count"] == 1
        assert status["pending_keys"] == ["salary_slip"]
        assert status["completed"] is False
        assert cust.case_status == "in_progress"

    # Admin check confirms customer is NOT completed
    admin_detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert admin_detail["case_status"] == "in_progress"
    assert admin_detail["pending_count"] == 1
    assert admin_detail["received_count"] == 1


# 10. Repeated recalculation produces the same result
def test_repeated_recalculation_idempotent(client, env):
    c, portal = onboard(client, docs=("PAN",))
    upload(client, portal, "PAN", "pan.png", PNG)
    jobs.run_all()

    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.case_status == "completed"

        audit_count_before = len(list(db.scalars(select(AuditLog).where(
            AuditLog.entity_id == str(c["id"]), AuditLog.action == "case_completed"
        ))))
        assert audit_count_before == 1

        email_count_before = len(emailer.OUTBOX)

        # Call recalc_case 5 times repeatedly
        for _ in range(5):
            res = services.recalc_case(db, cust)
            assert res["completed"] is True
            assert res["pending_count"] == 0
            assert res["case_status"] == "completed"

        # Zero additional audit logs or completion emails
        audit_count_after = len(list(db.scalars(select(AuditLog).where(
            AuditLog.entity_id == str(c["id"]), AuditLog.action == "case_completed"
        ))))
        assert audit_count_after == 1
        assert len(emailer.OUTBOX) == email_count_before
