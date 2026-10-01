from datetime import timedelta

from sqlalchemy import select

from app import db as dbmod
from app import emailer, jobs, scheduler
from app.models import Customer, Document, OcrResult
from app.ocr_client import OCRResult
from tests.conftest import PDF, PNG, admin_headers, token_from_outbox


def create_customer(client, docs=("PAN", "Bank Statement"), name="Rajesh Kumar Sharma"):
    r = client.post("/api/admin/customers", headers=admin_headers(),
                    json={"name": name, "email": "rajesh@example.com", "required_documents": list(docs)})
    assert r.status_code == 201, r.text
    return r.json()


def onboard(client, **kw):
    c = create_customer(client, **kw)
    consent = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 200
    return c, token_from_outbox("portal")


def upload(client, portal, doc_type, filename, content):
    return client.post(f"/api/portal/{portal}/upload", data={"doc_type": doc_type},
                       files={"file": (filename, content)})


def test_admin_endpoints_require_admin(client):
    assert client.get("/api/admin/customers").status_code == 401
    assert client.get("/api/admin/customers", headers=admin_headers("other@example.com")).status_code == 403


def test_full_happy_path_to_deletion(client, env):
    c, portal = onboard(client)
    assert c["code"] == "CUS-000001" and c["pending_count"] == 2

    state = client.get(f"/api/portal/{portal}").json()
    assert state["pending_count"] == 2

    r = upload(client, portal, "PAN", "pan.png", PNG)
    assert r.status_code == 202 and r.json()["state"] == "processing"
    assert jobs.run_all() == 1
    state = client.get(f"/api/portal/{portal}").json()
    assert state["pending_count"] == 1
    assert {d["doc_type"]: d["state"] for d in state["documents"]}["pan"] == "verified"
    assert env.calls[0][1] == {"name": "Rajesh Kumar Sharma"}  # expected name passed to OCR

    r = upload(client, portal, "bank_statement", "bank.pdf", PDF)
    assert r.status_code == 202
    jobs.run_all()
    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert detail["case_status"] == "completed" and detail["pending_count"] == 0
    assert detail["delete_after"] is not None
    assert all(d["verification_status"] == "verified" and d["ocr_status"] == "completed" for d in detail["documents"])
    assert any("All documents received" in m["subject"] for m in emailer.OUTBOX)

    # OCR payload stored masked, never raw
    with dbmod.session_scope() as db:
        payload = db.scalars(select(OcrResult)).first().payload
        assert "1234F" not in str(payload) and "ABCPE1234F" not in str(payload)

    # Secure view works, download is disabled by policy
    doc_id = detail["documents"][0]["id"]
    v = client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers())
    assert v.status_code == 200 and v.headers["cache-control"] == "no-store"
    assert client.get(f"/api/admin/documents/{doc_id}/file?download=true", headers=admin_headers()).status_code == 403

    # time passes: retention deletes files, OCR data and flips file state
    with dbmod.session_scope() as db:
        db.get(Customer, c["id"]).delete_after = dbmod.utcnow() - timedelta(minutes=1)
    assert scheduler.tick()["deleted"] == 1
    detail = client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()
    assert all(d["file_state"] == "deleted" for d in detail["documents"])
    assert client.get(f"/api/admin/documents/{doc_id}/file", headers=admin_headers()).status_code == 410
    with dbmod.session_scope() as db:
        assert db.scalars(select(OcrResult)).first() is None
    assert any("permanently deleted" in m["body"] for m in emailer.OUTBOX)
    audit = client.get("/api/admin/audit", headers=admin_headers()).json()
    assert "retention_deleted" in [a["action"] for a in audit]


def test_manual_review_then_approve_completes_case(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", confidence=0.94,
                                     extracted_fields={"pan_number": "ABCDE1234F", "name": "Rajesh Sharma"},
                                     reason="invalid_pan_entity_type_D")
    upload(client, portal, "pan", "pan.jpg", b"\xff\xd8\xff" + b"0" * 100)
    jobs.run_all()
    reviews = client.get("/api/admin/reviews", headers=admin_headers()).json()
    assert len(reviews) == 1 and reviews[0]["document"]["needs_manual_review"]
    assert client.get(f"/api/portal/{portal}").json()["documents"][0]["state"] == "under_review"

    rid = reviews[0]["id"]
    assert client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={}).status_code == 200
    assert client.post(f"/api/admin/reviews/{rid}/approve", headers=admin_headers(), json={}).status_code == 409
    assert client.get(f"/api/admin/customers/{c['id']}", headers=admin_headers()).json()["case_status"] == "completed"


def test_reject_requests_resubmission_and_reupload_replaces_file(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="low_confidence", doc_type="pan", reason="unreadable")
    upload(client, portal, "pan", "pan.png", PNG)
    jobs.run_all()
    rid = client.get("/api/admin/reviews", headers=admin_headers()).json()[0]["id"]
    client.post(f"/api/admin/reviews/{rid}/reject", headers=admin_headers(), json={"note": "blurry"})
    assert client.get(f"/api/portal/{portal}").json()["documents"][0]["state"] == "resubmit"
    assert any("re-upload" in m["subject"] for m in emailer.OUTBOX)

    del env.responses["pan"]
    upload(client, portal, "pan", "pan2.png", PNG + b"1")
    jobs.run_all()
    assert client.get(f"/api/portal/{portal}").json()["case_status"] == "completed"
    with dbmod.session_scope() as db:
        docs = list(db.scalars(select(Document).order_by(Document.created_at)))
        assert docs[0].superseded and docs[0].file_state == "deleted"


def test_wrong_document_type_is_rejected(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.responses["pan"] = OCRResult(status="success", doc_type="aadhaar", confidence=0.99)
    upload(client, portal, "pan", "x.png", PNG)
    jobs.run_all()
    assert client.get(f"/api/portal/{portal}").json()["documents"][0]["state"] == "resubmit"


def test_upload_validation(client):
    _, portal = onboard(client)
    assert upload(client, portal, "pan", "pan.exe", PNG).status_code == 400
    assert upload(client, portal, "pan", "pan.png", b"not really a png").status_code == 400
    assert upload(client, portal, "passport", "p.png", PNG).status_code == 400  # not on required list
    assert upload(client, portal, "pan", "pan.pdf", b"%PDF-1.4 /Encrypt").json()["detail"]["code"] == "password_protected_pdf"
    assert client.get("/api/portal/not-a-real-token-not-a-real-token").status_code == 404


def test_ocr_outage_retries_then_goes_to_manual_review(client, env):
    c, portal = onboard(client, docs=("PAN",))
    env.fail_times = 99
    upload(client, portal, "pan", "pan.png", PNG)
    for _ in range(3):
        jobs.run_one()
        with dbmod.session_scope() as db:  # skip the retry backoff
            from app.models import Job
            for j in db.scalars(select(Job).where(Job.status == "queued")):
                j.run_at = dbmod.utcnow()
    with dbmod.session_scope() as db:
        d = db.scalars(select(Document)).first()
        assert d.ocr_status == "failed" and d.verification_status == "manual_review"
        assert "ocr_unavailable" in d.flags


def test_consent_token_is_single_use_and_decline_stops_case(client):
    create_customer(client)
    consent = token_from_outbox("consent")
    assert client.post(f"/api/public/consent/{consent}", json={"granted": False}).status_code == 200
    assert client.post(f"/api/public/consent/{consent}", json={"granted": True}).status_code == 404
    with dbmod.session_scope() as db:
        assert db.get(Customer, 1).case_status == "consent_declined"


def test_reminders_follow_3_7_14_and_stop_when_complete(client):
    c, portal = onboard(client)
    emailer.OUTBOX.clear()

    def age(days):
        with dbmod.session_scope() as db:
            db.get(Customer, c["id"]).consent_at = dbmod.utcnow() - timedelta(days=days)

    age(2); assert scheduler.tick()["reminders"] == 0
    age(3); assert scheduler.tick()["reminders"] == 1
    assert scheduler.tick()["reminders"] == 0  # same stage is not re-sent
    age(8); assert scheduler.tick()["reminders"] == 1
    age(15); assert scheduler.tick()["reminders"] == 1
    age(20); assert scheduler.tick()["reminders"] == 0  # nothing after day 14
    assert sum("Reminder" in m["subject"] for m in emailer.OUTBOX) == 3


def test_unfinished_case_expires_and_files_are_deleted(client):
    c, portal = onboard(client)
    upload(client, portal, "pan", "pan.png", PNG)
    jobs.run_all()
    with dbmod.session_scope() as db:
        db.get(Customer, c["id"]).case_expires_at = dbmod.utcnow() - timedelta(minutes=1)
    out = scheduler.tick()
    assert out["expired"] == 1 and out["deleted"] == 1
    with dbmod.session_scope() as db:
        assert db.get(Customer, c["id"]).case_status == "expired"
        assert all(d.file_state == "deleted" for d in db.scalars(select(Document)))


def test_privacy_delete_request_wipes_data(client):
    c, portal = onboard(client, docs=("PAN",))
    upload(client, portal, "pan", "pan.png", PNG)
    jobs.run_all()
    assert client.post("/api/public/privacy/request", json={"email": "nobody@example.com", "action": "delete"}).status_code == 202
    n = len(emailer.OUTBOX)
    assert client.post("/api/public/privacy/request", json={"email": "rajesh@example.com", "action": "delete"}).status_code == 202
    assert len(emailer.OUTBOX) == n + 1
    tok = token_from_outbox("privacy/confirm")
    assert client.post(f"/api/public/privacy/confirm/{tok}").json() == {"completed": "delete"}
    assert client.post(f"/api/public/privacy/confirm/{tok}").status_code == 404  # single use
    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.name == "[deleted]" and cust.case_status == "deleted" and cust.mobile is None
        assert all(d.file_state == "deleted" for d in db.scalars(select(Document)))
    assert client.get(f"/api/portal/{portal}").status_code == 404 or client.get(f"/api/portal/{portal}").status_code == 403


def test_withdraw_consent_stops_processing(client, env):
    c, portal = onboard(client)
    upload(client, portal, "pan", "pan.png", PNG)  # queued but not yet processed
    client.post("/api/public/privacy/request", json={"email": "rajesh@example.com", "action": "withdraw"})
    client.post(f"/api/public/privacy/confirm/{token_from_outbox('privacy/confirm')}")
    jobs.run_all()
    assert env.calls == []  # OCR never ran
    with dbmod.session_scope() as db:
        cust = db.get(Customer, c["id"])
        assert cust.case_status == "consent_withdrawn" and cust.delete_after is not None
