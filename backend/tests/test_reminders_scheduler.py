from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app import emailer, jobs, scheduler, services
from app.db import session_scope
from app.models import AuditLog, Customer, Document
from tests.conftest import PNG, admin_headers, token_from_outbox


class FakeClock:
    """Controllable monotonic fake clock for reminder testing."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 2, 1, 10, 0, 0)

    def utcnow(self) -> datetime:
        return self.current

    def advance(self, days: int = 0, hours: int = 0, minutes: int = 0, seconds: int = 0) -> datetime:
        self.current += timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)
        return self.current


@pytest.fixture
def fake_clock(monkeypatch):
    clock = FakeClock()
    for mod in ("app.db", "app.services", "app.scheduler", "app.jobs", "app.pipeline", "app.models"):
        monkeypatch.setattr(f"{mod}.utcnow", clock.utcnow)
    return clock


def _create_and_consent_customer(client, name="Rahul Sharma", email="rahul@example.com", docs=None):
    if docs is None:
        docs = ["pan", "passport"]
    r = client.post("/api/admin/customers", headers=admin_headers(), json={
        "name": name,
        "email": email,
        "required_documents": docs,
        "send_consent": True,
    })
    assert r.status_code == 201
    cid = r.json()["id"]

    consent_tok = token_from_outbox("consent")
    c_res = client.post(f"/api/public/consent/{consent_tok}", json={"granted": True})
    assert c_res.status_code == 200

    portal_tok = token_from_outbox("portal")
    emailer.OUTBOX.clear()
    return cid, portal_tok


def test_reminders_3_7_14_day_timing(client, fake_clock):
    """Reminders are dispatched at 3, 7, and 14 days following consent, and stop after day 14."""
    cid, _ = _create_and_consent_customer(client, "Timing User", "timing@example.com", ["pan", "bank_statement"])

    # Day 0: No reminders
    tick0 = scheduler.tick()
    assert tick0["reminders"] == 0
    assert len(emailer.OUTBOX) == 0

    # Day 1: No reminders
    fake_clock.advance(days=1)
    assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 0

    # Day 2: No reminders
    fake_clock.advance(days=1)
    assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 0

    # Day 3: First reminder sent (stage 3)
    fake_clock.advance(days=1)
    tick3 = scheduler.tick()
    assert tick3["reminders"] == 1
    assert len(emailer.OUTBOX) == 1
    mail3 = emailer.OUTBOX[-1]
    assert mail3["to"] == "timing@example.com"
    assert "Reminder: documents still pending" in mail3["subject"]
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 3

    # Days 4, 5, 6: No duplicate reminders
    for _ in range(3):
        fake_clock.advance(days=1)
        assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 1

    # Day 7: Second reminder sent (stage 7)
    fake_clock.advance(days=1)
    tick7 = scheduler.tick()
    assert tick7["reminders"] == 1
    assert len(emailer.OUTBOX) == 2
    mail7 = emailer.OUTBOX[-1]
    assert "Reminder: documents still pending" in mail7["subject"]
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 7

    # Days 8 through 13: No duplicate reminders
    for _ in range(6):
        fake_clock.advance(days=1)
        assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 2

    # Day 14: Third reminder sent (stage 14)
    fake_clock.advance(days=1)
    tick14 = scheduler.tick()
    assert tick14["reminders"] == 1
    assert len(emailer.OUTBOX) == 3
    mail14 = emailer.OUTBOX[-1]
    assert "Reminder: documents still pending" in mail14["subject"]
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.last_reminder_stage == 14

    # Day 15+: Reminders stop permanently
    for _ in range(5):
        fake_clock.advance(days=1)
        assert scheduler.tick()["reminders"] == 0
    assert len(emailer.OUTBOX) == 3


def test_reminders_stop_when_completed(client, fake_clock):
    """Completed cases do not receive any reminders."""
    cid, portal_tok = _create_and_consent_customer(client, "Complete User", "complete@example.com", ["pan"])

    # Upload and verify PAN on Day 1
    fake_clock.advance(days=1)
    u = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u.status_code == 202
    assert jobs.run_one() is True

    # Case should now be completed
    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"

    emailer.OUTBOX.clear()

    # Advance to Day 3, 7, 14
    fake_clock.advance(days=2)  # Day 3
    assert scheduler.tick()["reminders"] == 0

    fake_clock.advance(days=4)  # Day 7
    assert scheduler.tick()["reminders"] == 0

    fake_clock.advance(days=7)  # Day 14
    assert scheduler.tick()["reminders"] == 0

    assert not any("Reminder" in m["subject"] for m in emailer.OUTBOX)


def test_reminders_stop_when_consent_withdrawn(client, fake_clock):
    """When a customer withdraws consent, reminders immediately cease."""
    cid, _ = _create_and_consent_customer(client, "Withdraw User", "withdraw@example.com", ["pan", "passport"])

    # Request and confirm consent withdrawal on Day 1
    fake_clock.advance(days=1)
    r_req = client.post("/api/public/privacy/request", json={"email": "withdraw@example.com", "action": "withdraw"})
    assert r_req.status_code == 202
    confirm_tok = token_from_outbox("privacy/confirm")

    r_conf = client.post(f"/api/public/privacy/confirm/{confirm_tok}")
    assert r_conf.status_code == 200

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.consent_status == "withdrawn"
        assert c.case_status in ("consent_withdrawn", "deleted")

    emailer.OUTBOX.clear()

    # Advance to Day 3, 7, 14
    fake_clock.advance(days=2)  # Day 3
    assert scheduler.tick()["reminders"] == 0

    fake_clock.advance(days=4)  # Day 7
    assert scheduler.tick()["reminders"] == 0

    fake_clock.advance(days=7)  # Day 14
    assert scheduler.tick()["reminders"] == 0

    assert not any("Reminder" in m["subject"] for m in emailer.OUTBOX)


def test_reminders_duplicate_prevention_on_multiple_ticks(client, fake_clock):
    """Multiple scheduler ticks within the same day or stage never send duplicate reminders."""
    cid, _ = _create_and_consent_customer(client, "Dedupe User", "dedupe@example.com", ["pan"])

    # Advance directly to Day 3
    fake_clock.advance(days=3)

    # First tick triggers reminder
    tick_first = scheduler.tick()
    assert tick_first["reminders"] == 1
    assert len(emailer.OUTBOX) == 1

    # Consecutive ticks on the exact same day trigger 0 reminders
    for _ in range(5):
        tick_repeat = scheduler.tick()
        assert tick_repeat["reminders"] == 0

    assert len(emailer.OUTBOX) == 1


def test_reminders_recalculate_pending_before_sending(client, fake_clock):
    """Scheduler recalculates pending documents before sending and lists only unverified documents."""
    import re
    cid, portal_tok = _create_and_consent_customer(client, "Recalc User", "recalc@example.com", ["pan", "bank_statement"])

    # Upload PAN on Day 1
    fake_clock.advance(days=1)
    u1 = client.post(f"/api/portal/{portal_tok}/upload", data={"doc_type": "pan"}, files={"file": ("pan.png", PNG, "image/png")})
    assert u1.status_code == 202
    assert jobs.run_one() is True

    # On Day 3, 1 document (Bank Statement) remains pending
    fake_clock.advance(days=2)
    assert scheduler.tick()["reminders"] == 1
    reminder_mail = emailer.OUTBOX[-1]
    # Bank Statement should be listed in the pending documents reminder
    assert "Bank Statement" in reminder_mail["body"]
    # Verified PAN should not be listed as pending
    assert "PAN Card" not in reminder_mail["body"]

    # Extract fresh portal upload token from reminder email
    match = re.search(r"/portal/([\w-]+)", reminder_mail["body"])
    assert match is not None
    active_portal_tok = match.group(1)

    # On Day 5, upload Bank Statement and verify using the refreshed upload token
    fake_clock.advance(days=2)
    u2 = client.post(f"/api/portal/{active_portal_tok}/upload", data={"doc_type": "bank_statement"}, files={"file": ("bank.png", PNG, "image/png")})
    assert u2.status_code == 202
    assert jobs.run_one() is True



    # Advance to Day 7: Recalculate detects completion and sends 0 reminders
    fake_clock.advance(days=2)
    assert scheduler.tick()["reminders"] == 0

    with session_scope() as db:
        c = db.get(Customer, cid)
        assert c.case_status == "completed"
        # Audit log contains reminder_sent with pending_count == 1
        audits = list(db.scalars(select(AuditLog).where(AuditLog.entity_type == "customer", AuditLog.entity_id == str(cid), AuditLog.action == "reminder_sent")))
        assert len(audits) == 1
        assert audits[0].details["stage"] == 3
        assert audits[0].details["pending_count"] == 1
