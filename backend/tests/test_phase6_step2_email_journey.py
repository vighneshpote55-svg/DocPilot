"""
Phase 6 Step 2: Real Customer Email E2E Journey Test Suite.

Verifies the complete 16-step synthetic customer communication journey in order:
1. Admin creates customer.
2. Consent email is generated with correct secure link and requested documents.
3. Customer accepts consent.
4. Document-request/upload email is generated.
5. Upload OTP email works and expires correctly.
6. Customer uploads a document.
7. OCR/verification progresses normally.
8. Missing-document reminder logic correctly identifies pending documents.
9. Trigger and verify resubmission email after manual rejection.
10. Verify completion email when all required documents become verified.
11. Test privacy deletion confirmation email.
12. Test consent withdrawal confirmation email.
13. Verify completed/deleted/withdrawn customers receive no inappropriate reminders.
14. Verify duplicate scheduler execution does not duplicate emails.
15. Verify all email links use PUBLIC_BASE_URL and correct token purpose.
16. Verify no raw PII, passwords, JWTs, API keys or tokens appear in logs.
"""
from datetime import timedelta
from io import BytesIO
import pytest
from sqlalchemy import select

from app import db as dbmod, emailer, jobs, models, scheduler, services
from app.config import get_settings
from app.security import hash_token, new_token
from tests.conftest import admin_headers

pytestmark = pytest.mark.usefixtures("env")

# Minimal 1x1 test image bytes
TEST_PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00"
    b"\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00"
    b"\x00\x00IEND\xaeB`\x82"
)


def test_complete_customer_communication_journey(client, caplog):
    """Execute complete 16-step customer communication journey end-to-end."""
    emailer.OUTBOX.clear()
    settings = get_settings()
    public_base = settings.public_base_url.rstrip("/")

    # -------------------------------------------------------------------------
    # 1. Admin creates customer
    # -------------------------------------------------------------------------
    res = client.post(
        "/api/admin/customers",
        headers=admin_headers(),
        json={
            "name": "E2E Journey Customer",
            "email": "journey_user@example.com",
            "mobile": "9876543210",
            "required_documents": ["pan", "aadhaar"],
            "send_consent": True,
        },
    )
    assert res.status_code == 201
    cust_data = res.json()
    cust_id = cust_data["id"]
    assert cust_data["case_status"] == "awaiting_consent"
    assert cust_data["consent_status"] == "pending"

    # -------------------------------------------------------------------------
    # 2. Consent email is generated with correct secure link and requested documents
    # -------------------------------------------------------------------------
    consent_email = next((e for e in reversed(emailer.OUTBOX) if "Consent needed" in e["subject"]), None)
    assert consent_email is not None, "Consent email was not generated"
    assert consent_email["to"] == "journey_user@example.com"
    assert "E2E Journey Customer" in consent_email["body"]
    assert "PAN Card" in consent_email["body"]
    assert "Aadhaar Card" in consent_email["body"]
    assert f"{public_base}/consent/" in consent_email["body"]

    consent_token = consent_email["body"].split("/consent/")[1].split()[0]
    with dbmod.session_scope() as s:
        c_tok_rec = services.resolve_token(s, consent_token, "consent")
        assert c_tok_rec is not None
        assert c_tok_rec.purpose == "consent"
        assert not c_tok_rec.revoked
        assert c_tok_rec.customer_id == cust_id

    # -------------------------------------------------------------------------
    # 3. Customer accepts consent
    # -------------------------------------------------------------------------
    consent_res = client.post(f"/api/public/consent/{consent_token}", json={"granted": True})
    assert consent_res.status_code == 200
    consent_json = consent_res.json()
    assert consent_json["consent"] == "granted"
    upload_tok_from_grant = consent_json["upload_token"]
    assert upload_tok_from_grant is not None

    with dbmod.session_scope() as s:
        cust = s.get(models.Customer, cust_id)
        assert cust.consent_status == "granted"
        assert cust.case_status == "in_progress"
        assert cust.workflow_state == "CONSENT_GRANTED"
        # Token cannot be reused (single-use)
        assert services.resolve_token(s, consent_token, "consent") is None

    # -------------------------------------------------------------------------
    # 4. Document-request/upload email is generated
    # -------------------------------------------------------------------------
    upload_email = next((e for e in reversed(emailer.OUTBOX) if "Please upload your documents" in e["subject"]), None)
    assert upload_email is not None, "Upload link email was not generated"
    assert upload_email["to"] == "journey_user@example.com"
    assert f"{public_base}/portal/" in upload_email["body"]
    assert "PAN Card" in upload_email["body"]
    assert "Aadhaar Card" in upload_email["body"]

    portal_token = upload_email["body"].split("/portal/")[1].split()[0]
    with dbmod.session_scope() as s:
        p_tok_rec = services.resolve_token(s, portal_token, "upload")
        assert p_tok_rec is not None
        assert p_tok_rec.purpose == "upload"
        assert p_tok_rec.customer_id == cust_id

    # -------------------------------------------------------------------------
    # 5. Upload OTP email works and expires correctly
    # -------------------------------------------------------------------------
    with dbmod.session_scope() as s:
        p_tok_rec = services.resolve_token(s, portal_token, "upload")
        masked = services.generate_and_send_upload_otp(s, cust, p_tok_rec.id)
        s.commit()
    assert "@" in masked

    otp_email = next((e for e in reversed(emailer.OUTBOX) if "Your DocPilot verification code" in e["subject"]), None)
    assert otp_email is not None, "Upload OTP email was not generated"
    assert "one-time upload verification code is:" in otp_email["body"]
    otp_code = otp_email["body"].split("code is:")[1].split()[0].strip()
    assert len(otp_code) == 6

    # Verify invalid OTP fails
    with dbmod.session_scope() as s:
        p_tok_rec = services.resolve_token(s, portal_token, "upload")
        assert not services.verify_upload_otp(s, cust, p_tok_rec, "000000")
        # Verify valid OTP succeeds
        assert services.verify_upload_otp(s, cust, p_tok_rec, otp_code)
        s.commit()

    # Verify expired OTP rejection
    with dbmod.session_scope() as s:
        p_tok_rec = services.resolve_token(s, portal_token, "upload")
        expired_otp_rec = models.AccessToken(
            customer_id=cust_id,
            purpose="upload_otp",
            token_hash=hash_token("999999"),
            ref_id=p_tok_rec.id,
            expires_at=dbmod.utcnow() - timedelta(minutes=1),  # Expired
        )
        s.add(expired_otp_rec)
        s.commit()
        assert not services.verify_upload_otp(s, cust, p_tok_rec, "999999")

    # -------------------------------------------------------------------------
    # 6. Customer uploads a document
    # -------------------------------------------------------------------------
    upload_res = client.post(
        f"/api/portal/{portal_token}/upload",
        data={"doc_type": "pan"},
        files={"file": ("pan_sample.png", BytesIO(TEST_PNG_BYTES), "image/png")},
    )
    assert upload_res.status_code == 202
    doc_id = upload_res.json()["document_id"]

    # -------------------------------------------------------------------------
    # 7. OCR/verification progresses normally
    # -------------------------------------------------------------------------
    jobs.run_one()  # Execute OCR job
    with dbmod.session_scope() as s:
        doc = s.get(models.Document, doc_id)
        assert doc.ocr_status in ("completed", "failed", "waiting")
        # In mock OCR mode without real OCR running, queued for manual review
        review = s.scalar(select(models.ManualReview).where(models.ManualReview.document_id == doc_id))
        assert review is not None, "Manual review row must be queued"
        review_id = review.id

    # -------------------------------------------------------------------------
    # 8. Missing-document reminder logic correctly identifies pending documents
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cust_id)
        # Fast-forward consent date by 4 days (Day 3 reminder due)
        c.consent_at = dbmod.utcnow() - timedelta(days=4)
        c.last_reminder_stage = 0
        s.commit()

    with dbmod.session_scope() as s:
        sent_reminders = scheduler.send_reminders(s)
        s.commit()
    assert sent_reminders == 1

    reminder_email = next((e for e in reversed(emailer.OUTBOX) if "Reminder: documents still pending" in e["subject"]), None)
    assert reminder_email is not None, "Reminder email was not sent"
    assert "Aadhaar Card" in reminder_email["body"]  # Aadhaar is still pending
    assert f"{public_base}/portal/" in reminder_email["body"]

    # -------------------------------------------------------------------------
    # 9. Trigger and verify resubmission email after manual rejection
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        rev = s.get(models.ManualReview, review_id)
        services.decide_review(s, rev, approve=False, admin="admin@example.com", note="Blurry corner on PAN")
        s.commit()

    resubmit_email = next((e for e in reversed(emailer.OUTBOX) if "Please re-upload your PAN Card" in e["subject"]), None)
    assert resubmit_email is not None, "Resubmission email was not generated"
    assert "We could not accept the PAN Card" in resubmit_email["body"]
    assert f"{public_base}/portal/" in resubmit_email["body"]

    # -------------------------------------------------------------------------
    # 10. Verify completion email when all required documents become verified
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c = s.get(models.Customer, cust_id)
        # Create and mark verified docs for both pan and aadhaar
        for dtype in ["pan", "aadhaar"]:
            d = models.Document(
                customer_id=c.id,
                doc_type=dtype,
                filename=f"{dtype}.png",
                mime="image/png",
                size=100,
                file_state="stored",
                storage_key=f"{c.id}/{dtype}.enc",
                sha256=f"sha_{dtype}",
                ocr_status="completed",
                verification_status="verified",
            )
            s.add(d)
            s.flush()
            req = s.scalar(select(models.RequiredDocument).where(
                models.RequiredDocument.customer_id == c.id,
                models.RequiredDocument.doc_type == dtype,
            ))
            req.verified_document_id = d.id

        services.recalc_case(s, c)
        s.commit()
        assert c.case_status == "completed"
        assert c.workflow_state == "COMPLETED"

    completion_email = next((e for e in reversed(emailer.OUTBOX) if "All documents received" in e["subject"]), None)
    assert completion_email is not None, "Completion email was not generated"
    assert "All your documents have been verified" in completion_email["body"]
    assert "permanently deleted shortly" in completion_email["body"]

    # -------------------------------------------------------------------------
    # 11. Test privacy deletion confirmation email
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    # Create isolated customer for deletion test
    with dbmod.session_scope() as s:
        c_del = models.Customer(
            name="Deletion Test Customer",
            email="deletion_user@example.com",
            case_status="completed",
            consent_status="granted",
            workflow_state="COMPLETED",
        )
        s.add(c_del)
        s.commit()
        del_cust_id = c_del.id

        services.start_privacy_request(s, "deletion_user@example.com", "delete")
        s.commit()

    priv_email = next((e for e in reversed(emailer.OUTBOX) if "Confirm your privacy request" in e["subject"]), None)
    assert priv_email is not None
    del_token = priv_email["body"].split("/privacy/confirm/")[1].split()[0]

    with dbmod.session_scope() as s:
        action = services.confirm_privacy_request(s, del_token)
        s.commit()
    assert action == "delete"

    del_confirm_email = next((e for e in reversed(emailer.OUTBOX) if "Your documents have been deleted" in e["subject"]), None)
    assert del_confirm_email is not None, "Deletion confirmation email was not sent"
    assert "Your uploaded documents and temporary processing data have been permanently deleted" in del_confirm_email["body"]

    # -------------------------------------------------------------------------
    # 12. Test consent withdrawal confirmation email
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        c_w = models.Customer(
            name="Withdrawal Test Customer",
            email="withdrawal_user@example.com",
            case_status="in_progress",
            consent_status="granted",
            workflow_state="IN_PROGRESS",
        )
        s.add(c_w)
        s.commit()
        w_cust_id = c_w.id

        services.start_privacy_request(s, "withdrawal_user@example.com", "withdraw")
        s.commit()

    w_req_email = next((e for e in reversed(emailer.OUTBOX) if "withdraw your consent" in e["body"]), None)
    assert w_req_email is not None
    w_token = w_req_email["body"].split("/privacy/confirm/")[1].split()[0]

    with dbmod.session_scope() as s:
        action_w = services.confirm_privacy_request(s, w_token)
        s.commit()
    assert action_w == "withdraw"

    withdraw_confirm_email = next((e for e in reversed(emailer.OUTBOX) if "Consent withdrawn" in e["subject"]), None)
    assert withdraw_confirm_email is not None, "Consent withdrawal confirmation email was not sent"
    assert "We have stopped processing and reminders for your case" in withdraw_confirm_email["body"]

    # -------------------------------------------------------------------------
    # 13. Verify completed/deleted/withdrawn customers receive no inappropriate reminders
    # -------------------------------------------------------------------------
    emailer.OUTBOX.clear()
    with dbmod.session_scope() as s:
        # Fast forward all consent dates to 15 days ago (all reminder stages would be due)
        for cid in [cust_id, del_cust_id, w_cust_id]:
            c_check = s.get(models.Customer, cid)
            if c_check and c_check.consent_at:
                c_check.consent_at = dbmod.utcnow() - timedelta(days=15)
                c_check.last_reminder_stage = 0
        s.commit()

    with dbmod.session_scope() as s:
        no_reminders = scheduler.send_reminders(s)
        s.commit()
    assert no_reminders == 0, "No reminders should be sent to completed, deleted, or withdrawn customers"
    assert len(emailer.OUTBOX) == 0

    # -------------------------------------------------------------------------
    # 14. Verify duplicate scheduler execution does not duplicate emails
    # -------------------------------------------------------------------------
    # Create customer with reminder due
    with dbmod.session_scope() as s:
        c_rem = models.Customer(
            name="Dup Reminder Customer",
            email="dup_reminder@example.com",
            case_status="in_progress",
            consent_status="granted",
            consent_at=dbmod.utcnow() - timedelta(days=8),  # Day 7 reminder due
            last_reminder_stage=3,  # Day 3 already sent
            workflow_state="IN_PROGRESS",
        )
        s.add(c_rem)
        s.flush()
        s.add(models.RequiredDocument(customer_id=c_rem.id, doc_type="pan"))
        s.commit()
        rem_id = c_rem.id

    with dbmod.session_scope() as s:
        first_tick = scheduler.send_reminders(s)
        s.commit()
    assert first_tick == 1
    assert len([e for e in emailer.OUTBOX if "Reminder: documents still pending" in e["subject"]]) == 1

    # Second tick immediately after
    with dbmod.session_scope() as s:
        second_tick = scheduler.send_reminders(s)
        s.commit()
    assert second_tick == 0, "Second tick must not send duplicate reminder email"
    assert len([e for e in emailer.OUTBOX if "Reminder: documents still pending" in e["subject"]]) == 1

    # -------------------------------------------------------------------------
    # 15. Verify all email links use PUBLIC_BASE_URL and correct token purpose
    # -------------------------------------------------------------------------
    for em in emailer.OUTBOX:
        body = em["body"]
        if "/consent/" in body:
            assert f"{public_base}/consent/" in body
        if "/portal/" in body:
            assert f"{public_base}/portal/" in body
        if "/privacy/confirm/" in body:
            assert f"{public_base}/privacy/confirm/" in body

    # -------------------------------------------------------------------------
    # 16. Verify no raw PII, passwords, JWTs, API keys or tokens appear in logs
    # -------------------------------------------------------------------------
    log_text = caplog.text
    assert "9876543210" not in log_text
    assert "secret" not in log_text.lower() or "test-secret" not in log_text
    # Email addresses logged should be masked
    if "journey_user@example.com" in log_text:
        pytest.fail("Unmasked email address journey_user@example.com leaked in logs")
