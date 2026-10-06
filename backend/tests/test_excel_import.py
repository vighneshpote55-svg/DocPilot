"""STEP 3: Excel customer import. Workbooks are built in memory with dummy data."""
from io import BytesIO

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app import db as dbmod
from app import emailer, services
from app.models import AccessToken, AuditLog, Customer, RequiredDocument
from tests.conftest import admin_headers

PREVIEW = "/api/admin/customers/import/preview"
IMPORT = "/api/admin/customers/import"
TEMPLATE = ["Full Name", "Email Address", "Mobile Number", "Required Documents", "Send Consent Email"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx(rows, header=TEMPLATE) -> bytes:
    wb = Workbook()
    ws = wb.active
    if header is not None:
        ws.append(header)
    for r in rows:
        ws.append(r)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def post(client, url, data, name="customers.xlsx", headers=None):
    return client.post(url, headers=admin_headers() if headers is None else headers,
                       files={"file": (name, data, XLSX)})


def count(model):
    with dbmod.session_scope() as s:
        return s.scalar(select(func.count()).select_from(model))


ROW_A = ["Asha Test", "asha@example.com", "+91 98765 43210", "pan, aadhaar, bank_statement", "No"]
ROW_B = ["Ravi Test", "ravi@example.com", "9812345678", "PAN Card; Salary Slip / Payslip", "No"]


def by_row(body):
    return {r["row"]: r for r in body["rows"]}


# 1, 18
def test_preview_valid_no_writes_no_email(client):
    r = post(client, PREVIEW, xlsx([ROW_A + [], ["Yes Test", "yes@example.com", "", "pan", "Yes"]]))
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["total_rows"], b["valid_rows"], b["invalid_rows"], b["duplicate_rows"]) == (2, 2, 0, 0)
    row = by_row(b)[2]
    assert row["email"] == "asha@example.com" and row["mobile"] == "+919876543210"
    assert row["required_documents"] == ["pan", "aadhaar", "bank_statement"]
    assert b["document_types_detected"] == ["aadhaar", "bank_statement", "pan"]
    assert count(Customer) == 0 and count(RequiredDocument) == 0 and count(AccessToken) == 0
    assert emailer.OUTBOX == []


# 2, 3, 4
def test_import_multiple_customers_and_docs(client):
    r = post(client, IMPORT, xlsx([ROW_A, ROW_B]))
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["imported"] == 2 and b["rejected"] == 0 and b["duplicates"] == 0 and b["failed"] == 0
    assert [c["row"] for c in b["created"]] == [2, 3]
    assert all(c["code"].startswith("CUS-") for c in b["created"])
    with dbmod.session_scope() as s:
        custs = list(s.scalars(select(Customer).order_by(Customer.id)))
        assert [c.workflow_state for c in custs] == ["NOT_STARTED"] * 2
        assert [c.consent_status for c in custs] == ["pending"] * 2
        docs = sorted(s.scalars(select(RequiredDocument.doc_type).where(RequiredDocument.customer_id == custs[1].id)))
        assert docs == ["pan", "salary_slip"]
        audit = s.scalars(select(AuditLog).where(AuditLog.action == "customers_imported")).one()
        assert audit.details == {"total": 2, "imported": 2, "rejected": 0, "duplicates": 0, "failed": 0}
    assert count(RequiredDocument) == 5
    assert emailer.OUTBOX == []


def test_snake_case_headers_accepted(client):
    r = post(client, PREVIEW, xlsx([ROW_A[:4]], header=["name", "email", "mobile", "required_documents"]))
    assert r.status_code == 200 and r.json()["valid_rows"] == 1


# 5
def test_missing_header(client):
    r = post(client, PREVIEW, xlsx([ROW_A[:3]], header=["Full Name", "Email Address", "Mobile Number"]))
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "missing_headers"


@pytest.mark.parametrize("row,code", [
    (["Bad Email", "not-an-email", "", "pan", ""], "invalid_email"),          # 6
    (["Bad Mobile", "m@example.com", "12345", "pan", ""], "invalid_mobile"),  # 7
    (["", "n@example.com", "", "pan", ""], "invalid_name"),                   # 8
    (["No Docs", "d@example.com", "", "", ""], "required_documents_empty"),   # 9
    (["Fuzzy", "f@example.com", "", "pan, Passport of Mars", ""], "unsupported_document_type"),  # 10
    (["Consent", "c@example.com", "", "pan", "maybe"], "invalid_send_consent"),
])
def test_invalid_rows(client, row, code):
    r = post(client, IMPORT, xlsx([row, ROW_B]))
    assert r.status_code == 200
    b = r.json()
    bad = by_row(b)[2]
    assert bad["status"] == "invalid"
    assert code in [e["code"] for e in bad["errors"]]
    assert bad["email"] is None  # malformed input not echoed
    assert b["imported"] == 1 and b["rejected"] == 1
    assert count(Customer) == 1


# 11
def test_duplicate_against_existing_customer(client):
    assert post(client, IMPORT, xlsx([ROW_A])).json()["imported"] == 1
    row = ["Asha Again", " ASHA@example.com ", "", "pan", "No"]
    b = post(client, IMPORT, xlsx([row, ROW_B])).json()
    assert by_row(b)[2]["status"] == "duplicate_customer"
    assert b["duplicates"] == 1 and b["imported"] == 1
    assert count(Customer) == 2


# 12
def test_duplicate_inside_excel(client):
    dup = ["Asha Twin", "Asha@Example.com", "", "pan", "No"]
    b = post(client, PREVIEW, xlsx([ROW_A, dup, ROW_B])).json()
    rows = by_row(b)
    assert rows[2]["status"] == rows[3]["status"] == "duplicate_excel_row"
    assert b["duplicate_rows"] == 2 and b["valid_rows"] == 1
    b = post(client, IMPORT, xlsx([ROW_A, dup, ROW_B])).json()
    assert b["imported"] == 1 and count(Customer) == 1


# 13
def test_empty_rows_skipped(client):
    b = post(client, PREVIEW, xlsx([ROW_A, [None] * 5, ["", "", "", "", ""], ROW_B])).json()
    assert b["total_rows"] == 2
    assert sorted(by_row(b)) == [2, 5]


def test_header_only_is_empty_workbook(client):
    r = post(client, PREVIEW, xlsx([]))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "empty_workbook"


def test_blank_sheet_is_empty_workbook(client):
    r = post(client, PREVIEW, xlsx([], header=None))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "empty_workbook"


# 14
def test_corrupt_workbook(client):
    r = post(client, PREVIEW, b"PK\x03\x04 this is not really a workbook")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_file"


# 15
@pytest.mark.parametrize("name", ["customers.csv", "customers.xls", "customers.xlsm", "customers"])
def test_non_xlsx_rejected(client, name):
    r = post(client, PREVIEW, xlsx([ROW_A]), name=name)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "invalid_file_type"


def test_file_too_large(client):
    r = post(client, PREVIEW, b"0" * (5 * 1024 * 1024 + 10))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "file_too_large"


def test_formulas_not_evaluated(client):
    row = ["=1+1", "formula@example.com", "", "pan", "No"]
    b = post(client, PREVIEW, xlsx([row])).json()
    # no cached value -> cell read as empty, never computed
    assert by_row(b)[2]["status"] == "invalid"


# 16
def test_transaction_rollback(client, monkeypatch):
    real = services.insert_customer
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise SQLAlchemyError("simulated")
        return real(*a, **k)

    monkeypatch.setattr(services, "insert_customer", flaky)
    yes_a, yes_b = ROW_A[:4] + ["Yes"], ROW_B[:4] + ["Yes"]
    r = post(client, IMPORT, xlsx([yes_a, yes_b]))
    assert r.status_code == 500 and r.json()["detail"]["code"] == "import_failed"
    assert count(Customer) == 0 and count(RequiredDocument) == 0
    assert emailer.OUTBOX == [] and count(AccessToken) == 0
    with dbmod.session_scope() as s:
        a = s.scalars(select(AuditLog).where(AuditLog.action == "customers_import_failed")).one()
        assert a.details["failed"] == 2 and a.details["imported"] == 0


# 17
def test_admin_auth(client):
    data = xlsx([ROW_A])
    for url in (PREVIEW, IMPORT):
        assert client.post(url, files={"file": ("c.xlsx", data, XLSX)}).status_code == 401
        assert post(client, url, data, headers=admin_headers("someone@example.com")).status_code == 403
    assert count(Customer) == 0


# 19
def test_consent_email_after_commit(client, monkeypatch):
    seen = []
    real = services.send_consent_email

    def spy(db, c):
        with dbmod.session_scope() as s:  # separate session: data must already be committed
            seen.append(s.get(Customer, c.id) is not None)
        return real(db, c)

    monkeypatch.setattr(services, "send_consent_email", spy)
    b = post(client, IMPORT, xlsx([ROW_A[:4] + ["Yes"], ROW_B[:4] + [""], ["No Mail", "nm@example.com", "", "pan", "No"]])).json()
    assert b["imported"] == 3 and b["email_sent"] == 2 and b["email_failed"] == 0
    assert seen == [True, True]
    assert len(emailer.OUTBOX) == 2


# 20
def test_email_failure_keeps_customers(client, monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(services, "send_consent_email", fail)
    b = post(client, IMPORT, xlsx([ROW_A[:4] + ["Yes"], ROW_B[:4] + ["Yes"]])).json()
    assert b["imported"] == 2 and b["email_failed"] == 2 and b["email_sent"] == 0
    assert {f["code"] for f in b["email_failures"]} == {"email_failed"}
    assert count(Customer) == 2 and count(RequiredDocument) == 5


def test_response_has_no_secrets(client):
    b = post(client, IMPORT, xlsx([ROW_A[:4] + ["Yes"]])).json()
    text = str(b).lower()
    for bad in ("token", "hash", "secret", "password", "http://portal.test"):
        assert bad not in text
