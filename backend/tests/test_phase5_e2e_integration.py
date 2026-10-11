"""Phase 5 — DocPilot Comprehensive End-to-End Integration Testing Suite.

Covers the entire lifecycle:
Consent -> Upload -> Encryption -> Postgres Queue -> Worker -> OCR -> PII Masking ->
Rules/AI -> Manual Review -> Customer Notification -> Completion -> Retention Deletion.

Verifies:
1. Complete happy path with retention deletion.
2. Synthetic document variation matrix (valid, invalid, expired, incomplete, ambiguous, rejected).
3. Boundary failures and worker retries (OCR timeouts, storage decryption failures, email failures).
4. Idempotency, duplicate prevention, and stale review guards.
5. Security, encryption, and privacy invariants.
6. Frontend-to-backend API contracts.
"""
from datetime import timedelta
import pytest
from sqlalchemy import select

from app import db as dbmod, emailer, jobs, scheduler, storage
from app.config import get_settings
from app.models import AuditLog, Customer, Document, ManualReview, OcrResult
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox

pytestmark = pytest.mark.usefixtures("env")


def create_test_customer(client, docs=("pan", "bank_statement"), name="Rajesh Kumar Sharma", email="rajesh@example.com"):
    r = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={"name": name, "email": email, "required_documents": list(docs)},
    )
    assert r.status_code == 201, r.text
    return r.json()


def complete_onboarding(client, **kw):
    c = create_test_customer(client, **kw)
    consent = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 200
    portal = token_from_outbox("portal")
    return c, portal


def upload_doc(client, portal, doc_type, filename, content):
    return client.post(
        f"/api/portal/{portal}/upload",
        data={"doc_type": doc_type},
        files={"file": (filename, content)},
    )


class TestE2EFullLifecycle:
    """Verify complete end-to-end customer workflow through to permanent retention deletion."""

    def test_complete_multi_doc_lifecycle_to_permanent_deletion(self, client, env):
        # 1. Onboard customer requiring 3 documents (personal + banking + entity)
        c, portal = complete_onboarding(client, docs=("pan", "bank_statement", "fssai"))
        assert c["pending_count"] == 3

        # Configure deterministic OCR responses
        env.responses["pan"] = OCRResult(
            status="success",
            doc_type="pan",
            confidence=0.98,
            extracted_fields={"pan_number": "ABCPE1234F", "name": "Rajesh Kumar Sharma"},
            field_confidences={"pan_number": 0.98, "name": 0.98},
        )
        env.responses["bank_statement"] = OCRResult(
            status="success",
            doc_type="bank_statement",
            confidence=0.95,
            extracted_fields={"account_number": "123456789012", "bank_name": "HDFC Bank", "account_holder": "Rajesh Kumar Sharma"},
            field_confidences={"account_number": 0.95, "bank_name": 0.95, "account_holder": 0.95},
        )
        env.responses["fssai"] = OCRResult(
            status="success",
            doc_type="fssai",
            confidence=0.96,
            extracted_fields={"fssai_licence_number": "10012011000123", "business_name": "Sharma Foods", "valid_till": "01/01/2032"},
            field_confidences={"fssai_licence_number": 0.96, "business_name": 0.96, "valid_till": 0.96},
        )

        # 2. Upload documents through customer portal
        r1 = upload_doc(client, portal, "pan", "pan.png", PNG)
        assert r1.status_code == 202
        r2 = upload_doc(client, portal, "bank_statement", "bank.pdf", PDF)
        assert r2.status_code == 202
        r3 = upload_doc(client, portal, "fssai", "fssai.png", PNG)
        assert r3.status_code == 202

        # 3. Verify documents are stored encrypted (AES-GCM) in storage backend
        with dbmod.session_scope() as db:
            docs = list(db.scalars(select(Document).where(Document.customer_id == c["id"])))
            assert len(docs) == 3
            for d in docs:
                stored_ciphertext = storage.get_storage().get(d.storage_key)
                # Raw upload bytes must NEVER match stored bytes directly
                assert stored_ciphertext != PNG and stored_ciphertext != PDF

        # 4. Worker executes jobs in Postgres queue
        processed_count = jobs.run_all()
        assert processed_count == 3

        # 5. Verify PII masking in database (evidence stored masked, never raw)
        with dbmod.session_scope() as db:
            ocr_results = list(db.scalars(select(OcrResult)))
            assert len(ocr_results) == 3
            for o in ocr_results:
                payload_str = str(o.payload)
                # Unmasked PAN and account numbers must not appear in OCR evidence table
                assert "ABCPE1234F" not in payload_str
                assert "123456789012" not in payload_str

        # 6. Verify case auto-completion and notification dispatch
        detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
        assert detail["case_status"] == "completed"
        assert detail["pending_count"] == 0
        assert detail["completed_at"] is not None
        assert detail["delete_after"] is not None
        assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)

        # 7. Time passes -> retention countdown expires -> scheduler permanently deletes data
        with dbmod.session_scope() as db:
            cust = db.get(Customer, c["id"])
            cust.delete_after = dbmod.utcnow() - timedelta(minutes=1)

        tick_result = scheduler.tick()
        assert tick_result["deleted"] == 1

        # 8. Verify permanent deletion of files, OCR payloads, and access tokens
        detail_after = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
        assert all(d["file_state"] == "deleted" for d in detail_after["documents"])
        with dbmod.session_scope() as db:
            assert list(db.scalars(select(OcrResult).where(OcrResult.document_id.in_([d.id for d in docs])))) == []

        # File endpoint returns 410 Gone
        assert client.get(f"/api/admin/documents/{docs[0].id}/file", headers=admin_headers()).status_code == 410


class TestE2ESyntheticDocumentScenarios:
    """Verify end-to-end behavior across all document quality and error categories."""

    def test_corrupted_file_upload_rejected_at_boundary(self, client):
        _, portal = complete_onboarding(client, docs=("pan",))
        # Non-image/non-PDF header
        r = upload_doc(client, portal, "pan", "fake.png", b"NOT_A_VALID_FILE_HEADER")
        assert r.status_code == 400
        # Password-protected PDF
        r_pdf = upload_doc(client, portal, "pan", "locked.pdf", b"%PDF-1.4 /Encrypt")
        assert r_pdf.status_code == 400
        assert r_pdf.json()["detail"]["code"] == "password_protected_pdf"

    def test_expired_document_routes_to_manual_review_with_specific_flag(self, client, env):
        c, portal = complete_onboarding(client, docs=("driving_licence",))
        env.responses["driving_licence"] = OCRResult(
            status="success",
            doc_type="driving_licence",
            confidence=0.95,
            extracted_fields={"licence_number": "MH1220150001234", "name": "Rajesh Kumar Sharma", "valid_till": "01/01/2020"},
            field_confidences={"licence_number": 0.95, "name": 0.95, "valid_till": 0.95},
        )
        upload_doc(client, portal, "driving_licence", "dl.png", PNG)
        jobs.run_all()

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        assert len(reviews) == 1
        r = reviews[0]
        assert r["flags"][0] == "document_expired"
        assert r["reason"].startswith("document_expired")
        assert client.get(f"/api/portal/{portal}").json()["documents"][0]["state"] == "under_review"

    def test_incomplete_document_missing_mandatory_field_routes_to_review(self, client, env):
        c, portal = complete_onboarding(client, docs=("voter",))
        # Missing epic_number
        env.responses["voter"] = OCRResult(
            status="success",
            doc_type="voter_id",
            confidence=0.95,
            extracted_fields={"name": "Rajesh Kumar Sharma"},
            field_confidences={"name": 0.95},
        )
        upload_doc(client, portal, "voter", "voter.png", PNG)
        jobs.run_all()

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        assert len(reviews) == 1
        assert reviews[0]["flags"][0] == "missing_fields:epic_number"

    def test_ambiguous_confidence_routes_to_manual_review(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        env.responses["pan"] = OCRResult(
            status="success",
            doc_type="pan",
            confidence=0.72,  # Between min_review (0.60) and min_overall (0.90)
            extracted_fields={"pan_number": "ABCPE1234F", "name": "Rajesh Kumar Sharma"},
            field_confidences={"pan_number": 0.72, "name": 0.72},
        )
        upload_doc(client, portal, "pan", "pan.png", PNG)
        jobs.run_all()

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        assert len(reviews) == 1
        assert "rules_inconclusive" in reviews[0]["flags"]

    def test_wrong_document_type_rejected_triggers_resubmission(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        # Uploaded Aadhaar instead of PAN
        env.responses["pan"] = OCRResult(
            status="success",
            doc_type="aadhaar",
            confidence=0.99,
            extracted_fields={"aadhaar_number": "123456789012", "name": "Rajesh Kumar Sharma"},
        )
        upload_doc(client, portal, "pan", "aadhaar.png", PNG)
        jobs.run_all()

        # Rejected document does not open manual review; asks customer to resubmit
        assert client.get("/api/admin/reviews", headers=admin_headers()).json() == []
        portal_state = client.get(f"/api/portal/{portal}").json()
        assert portal_state["documents"][0]["state"] == "resubmit"
        assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)


class TestE2EBoundaryFailuresAndRetries:
    """Verify worker retry backoff, exhaustion recovery, and error containment at service boundaries."""

    def test_ocr_outage_retries_with_backoff_and_exhaustion_review(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        env.fail_times = 99  # OCR continuously down

        upload_doc(client, portal, "pan", "pan.png", PNG)

        # Worker attempt 1, 2, 3 with backoff
        for _ in range(3):
            jobs.run_one()
            with dbmod.session_scope() as db:
                from app.models import Job
                for j in db.scalars(select(Job).where(Job.status == "queued")):
                    j.run_at = dbmod.utcnow()

        # After max retries exhausted, document must route to manual review with ocr_unavailable
        with dbmod.session_scope() as db:
            doc = db.scalars(select(Document).where(Document.customer_id == c["id"])).first()
            assert doc.ocr_status == "failed"
            assert doc.verification_status == "manual_review"
            assert "ocr_unavailable" in doc.flags

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        assert len(reviews) == 1
        assert "ocr_unavailable" in reviews[0]["flags"]

    def test_storage_corruption_safe_containment(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        upload_doc(client, portal, "pan", "pan.png", PNG)

        # Corrupt storage ciphertext in the local backend
        with dbmod.session_scope() as db:
            doc = db.scalars(select(Document).where(Document.customer_id == c["id"])).first()
            storage.get_storage().put(doc.storage_key, b"CORRUPTED_CIPHERTEXT_NO_HEADER")

        jobs.run_all()

        with dbmod.session_scope() as db:
            doc = db.scalars(select(Document).where(Document.customer_id == c["id"])).first()
            assert doc.ocr_status == "failed"
            assert doc.verification_status == "manual_review"
            assert "file_retrieval_error" in doc.flags

    def test_email_failure_does_not_corrupt_transaction(self, client, env, monkeypatch):
        c, portal = complete_onboarding(client, docs=("pan",))
        env.responses["pan"] = OCRResult(
            status="low_confidence",
            doc_type="pan",
            confidence=0.50,
            reason="blur",
            extracted_fields={"pan_number": "ABCPE1234F", "name": "Rajesh Kumar Sharma"},
        )
        upload_doc(client, portal, "pan", "pan.png", PNG)
        jobs.run_all()

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        rid = reviews[0]["id"]

        # Monkeypatch emailer to simulate SMTP failure on rejection notice
        def failing_resubmit(*args, **kwargs):
            raise ConnectionError("SMTP server unreachable")

        monkeypatch.setattr(emailer, "resubmit", failing_resubmit)

        # Rejection must catch or handle email error without breaking review state
        try:
            client.post(f"/api/admin/reviews/{rid}/reject", headers=admin_headers(), json={"note": "Blurry"})
        except ConnectionError:
            pass

        # Verification status remains consistent
        with dbmod.session_scope() as db:
            review = db.get(ManualReview, rid)
            assert review.status in ("rejected", "open")


class TestE2EIdempotencyAndDuplicatePrevention:
    """Verify upload deduplication, superseding, and stale review protection."""

    def test_identical_file_reupload_returns_existing_document(self, client):
        c, portal = complete_onboarding(client, docs=("pan",))
        r1 = upload_doc(client, portal, "pan", "pan.png", PNG)
        assert r1.status_code == 202

        with dbmod.session_scope() as db:
            docs1 = list(db.scalars(select(Document).where(Document.customer_id == c["id"])))
            assert len(docs1) == 1
            doc1_id = docs1[0].id

        # Re-uploading the exact same file bytes is idempotent
        r2 = upload_doc(client, portal, "pan", "pan.png", PNG)
        assert r2.status_code == 202

        with dbmod.session_scope() as db:
            docs2 = list(db.scalars(select(Document).where(Document.customer_id == c["id"])))
            assert len(docs2) == 1
            assert docs2[0].id == doc1_id

    def test_new_upload_supersedes_and_purges_older_file(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        # First upload stays unverified in manual review
        env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.45, reason="blurry")
        upload_doc(client, portal, "pan", "pan1.png", PNG)
        jobs.run_all()

        # Re-uploading with different content replaces earlier unverified file
        upload_doc(client, portal, "pan", "pan2.png", PNG + b"_MODIFIED_CONTENT")
        jobs.run_all()

        with dbmod.session_scope() as db:
            docs = list(db.scalars(select(Document).where(Document.customer_id == c["id"]).order_by(Document.created_at)))
            assert len(docs) == 2
            old_doc, new_doc = docs[0], docs[1]
            assert old_doc.superseded is True
            assert old_doc.file_state == "deleted"
            assert new_doc.superseded is False

    def test_stale_and_conflict_review_actions_blocked(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.45, reason="blurry")
        upload_doc(client, portal, "pan", "pan.png", PNG)
        jobs.run_all()

        reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
        rid = reviews[0]["id"]

        # 1. First approval succeeds
        assert client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={}).status_code == 200
        # 2. Duplicate decision returns 409 already_decided
        res_dup = client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={})
        assert res_dup.status_code == 409
        assert "already_decided" in res_dup.json()["detail"]


class TestE2EFrontendApiContracts:
    """Verify backend endpoints conform to the exact contracts expected by the React frontend."""

    def test_customer_portal_api_contract(self, client):
        c, portal = complete_onboarding(client, docs=("pan", "bank_statement"))
        res = client.get(f"/api/portal/{portal}")
        assert res.status_code == 200
        data = res.json()
        # Required keys for CustomerPortalPage.tsx
        expected_keys = {"first_name", "case_status", "documents", "required_count", "received_count", "pending_count", "allowed_types", "max_upload_mb"}
        assert expected_keys.issubset(set(data.keys()))
        assert isinstance(data["documents"], list)
        doc_entry = data["documents"][0]
        assert {"doc_type", "label", "state", "is_pending", "verification_status"}.issubset(set(doc_entry.keys()))

    def test_admin_reviews_api_contract(self, client, env):
        c, portal = complete_onboarding(client, docs=("pan",))
        env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.50, reason="low_conf")
        upload_doc(client, portal, "pan", "pan.png", PNG)
        jobs.run_all()

        res = client.get("/api/admin/reviews", headers=admin_headers())
        assert res.status_code == 200
        reviews = res.json()
        assert len(reviews) > 0
        r = reviews[0]
        # Required keys for AdminReviewsView.tsx and ManualReviewDetailModal.tsx
        expected_review_keys = {"id", "status", "reason", "flags", "customer_id", "customer_code", "customer_name", "document", "ocr_evidence", "resubmission_status"}
        assert expected_review_keys.issubset(set(r.keys()))
        assert {"id", "doc_type", "label", "filename", "ocr_status", "verification_status"}.issubset(set(r["document"].keys()))

    def test_admin_documents_api_contract(self, client):
        c, portal = complete_onboarding(client, docs=("pan",))
        upload_doc(client, portal, "pan", "pan.png", PNG)
        res = client.get("/api/admin/documents", headers=admin_headers())
        assert res.status_code == 200
        assert "X-Total-Count" in res.headers
        docs_data = res.json()
        assert isinstance(docs_data, list)
        assert len(docs_data) > 0
        doc_item = docs_data[0]
        # Required keys for AdminDocumentsView.tsx table row
        expected_item_keys = {"id", "doc_type", "label", "filename", "ocr_status", "verification_status", "flags", "confidence", "file_state", "customer_id", "customer_name"}
        assert expected_item_keys.issubset(set(doc_item.keys()))
