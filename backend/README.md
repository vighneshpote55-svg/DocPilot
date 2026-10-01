# Secure Document Collection: Backend

FastAPI + Supabase Postgres/Storage. Replaces the n8n workflow with code. Uses **your OCR service** through one adapter.

```
Customer added -> consent email -> consent -> upload link -> portal upload -> validate -> encrypt + store
-> queue -> OCR -> mask PII -> rules -> (AI only if inconclusive) -> verified / manual review / rejected
-> recalc pending -> 3/7/14-day reminders -> completed -> 7-day retention -> permanent deletion
```

No Redis, no n8n: jobs live in a Postgres table and a single worker process also runs the reminder, expiry and retention schedulers.

## 1. Supabase setup
1. **Database**: Project Settings > Database > Connection string > *Session pooler*. Put it in `DATABASE_URL`.
2. **Storage**: create a bucket named `case-documents`, set to **Private**. Put the `service_role` key in `SUPABASE_SERVICE_KEY` (backend only).
3. **Admin auth**: Authentication > Users > add yourself. Put your email in `ADMIN_EMAILS`. Put the project's *JWT Secret* in `SUPABASE_JWT_SECRET`.
   Note: admin login verifies HS256 tokens. If your project only uses the newer asymmetric signing keys, enable the legacy JWT secret or ask me to switch to JWKS verification.
4. After creating tables (step 3 below), run `supabase_rls.sql` in the SQL editor.

## 2. Configure
```bash
cp .env.example .env
python -m app.security          # prints a new ENCRYPTION_KEY: paste it into .env
```
Also set `OCR_URL`, `OCR_API_KEY` (create a dedicated service key in your OCR app), `PUBLIC_BASE_URL` (frontend URL) and SMTP.

### SMTP Setup
Configure SMTP in `.env`:
```ini
SMTP_HOST=smtp.sendgrid.net        # e.g. SendGrid, Amazon SES, Mailgun, Postmark
SMTP_PORT=587                      # 587 (STARTTLS)
SMTP_USER=apikey                   # SMTP username
SMTP_PASSWORD=your-smtp-password   # SMTP password
SMTP_FROM=documents@yourdomain.com # verified sender address
```
* **Development mode**: If `SMTP_HOST` is left empty, emails are not sent over the wire. Instead, they are stored in the in-memory outbox (`app.emailer.OUTBOX`) and logged to the console with the recipient's email address masked to prevent PII exposure.

## 3. Run
```bash
python -m venv venv && source venv/bin/activate     # Windows: .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.db_init                                # applies Alembic migrations (head)
uvicorn app.main:app --reload --port 8080            # API
python -m app.worker                                 # worker (second terminal)
pytest -q                                            # run all tests
```
Or with Docker:
```bash
docker compose up --build                            # runs api and worker via dedicated multi-stage targets
# or build targets directly:
docker build --target api -t docpilot-api .
docker build --target worker -t docpilot-worker .
```

## 4. Adapt to your OCR (two places)
* `app/doc_types.py` -> `OCR_TYPE_NAMES`: map our keys (`aadhaar`, `pan`, `voter`, `driving_licence`, ...) to the names your `/ocr/{doc_type}` endpoint expects.
* `app/rules.py` -> `REQUIRED_FIELDS`: per document type, the fields that must be present to auto-verify (only `pan` and `shop_establishment` are filled in). Use your OCR's real field names.
* The `expected` form field sends `{"name": "<customer name>"}`. Confirm your OCR reads that key; `cross_check` parsing is defensive because its shape is undocumented.

## 5. API summary
Admin (header `Authorization: Bearer <Supabase JWT>`):
`POST /api/admin/customers`, `GET /api/admin/customers[?status=]`, `GET /api/admin/customers/{id}` (includes the Documents-tab data),
`POST /api/admin/customers/{id}/send-consent`, `.../send-upload-link`, `GET /api/admin/reviews`, `POST /api/admin/reviews/{id}/approve|reject`,
`GET /api/admin/documents/{id}/file` (Secure View; `?download=true` only if `ALLOW_DOWNLOAD=true`), `GET /api/admin/audit`, `GET /api/admin/summary`.

Customer (token in the URL is the identity):
`GET|POST /api/public/consent/{token}`, `GET /api/portal/{token}`, `POST /api/portal/{token}/upload` (form: `doc_type`, `file`),
`GET /api/portal/{token}/documents/{id}/status`, `POST /api/public/privacy/request`, `POST /api/public/privacy/confirm/{token}`.

Frontend routes the emails link to (built next): `{PUBLIC_BASE_URL}/consent/{token}`, `/portal/{token}`, `/privacy/confirm/{token}`.

Quick check (mint nothing by hand: use a real Supabase login token):
```bash
curl -X POST localhost:8080/api/admin/customers -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Test Customer","email":"test@example.com","required_documents":["PAN","Bank Statement"]}'
```

## 6. Behaviour and decisions I made (all changeable)
* **Four independent states**: `ocr_status` (waiting/processing/completed/failed), `verification_status` (not_started/verified/rejected/manual_review), `case_status`, `file_state` (stored/deleted). "Pending" is derived: required documents without a verified file.
* **Rules first**: auto-verify only when OCR status is `success`, no OCR `reason`, confidence >= 0.90, required fields present and confident, name compatible, not expired, not a demo document. A wrong document type is rejected (resubmission email). Anything with a risk flag goes to manual review. Only inconclusive cases reach the AI, and AI can only upgrade to verified at confidence >= 90.
* **PII**: OCR responses are masked before they are stored; raw values exist only in memory. The AI receives masked data only.
* **Tokens**: random, stored as SHA-256 hashes. Consent and privacy links are single-use; upload links are reusable until expiry (72 h). Each email issues a fresh link.
* **Case expiry (not in the report)**: an unfinished case closes after 30 days and its files are deleted.
* **Reminders**: counted from consent, at 3/7/14 days, only while documents are pending; none after day 14.
* **Rejected files**: kept until the customer re-uploads (then deleted) or the case ends.
* **Withdraw consent**: stops processing and reminders immediately; files are deleted after the retention period. **Delete my data**: immediate deletion and the customer record is anonymised; the consent ledger keeps IDs only.
* **OCR outage**: 3 attempts with backoff, then the document goes to manual review rather than being lost.
* **Audit**: uploads, verification outcomes, staff views/downloads, review decisions, reminders, deletions. No PII in details.

## 7. Production Readiness & Remaining Items
* **Frontend**: Customer portal (`/consent`, `/portal`, `/privacy`) and Admin dashboard (`/admin`) are built in `frontend/` (React + TypeScript + Vite).
* **Storage & DB**: Verified with PostgreSQL (`pg8000`) and private Supabase Storage (`case-documents` bucket).
* **Security & Ops**: Rate limiting, magic-byte inspection, upload OTP, and Alembic migrations are implemented and tested.
* **External OCR Service**: Ensure your live OCR service is running at `OCR_URL` with valid `OCR_API_KEY`, and confirm document extractor field names match your model.
* **SMTP Provider**: Supply live `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASSWORD` to dispatch emails via TLS rather than local simulated outbox.
* **Compliance**: Confirm your regulatory retention obligations (e.g. KYC/AML statutory rules) with legal counsel before enabling automated 7-day retention deletion in production.

