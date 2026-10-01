# Docpilot spec (source of truth)

## 1. What the study found

**The design report (PDF)** keeps the existing business process and changes one thing: sensitive documents move from email attachments to a secure upload portal. Email stays as the notification and reminder channel. Key ideas: the random expiring token is the identity; partial uploads are normal and `Pending = Required - Verified`; OCR for every supported document but AI only when rules are not enough; privacy by lifecycle (consent, encrypted storage, masking, 7-day retention, deletion, minimal audit); staff see documents only through a Documents tab with Secure View.

**The n8n workflow (203 nodes)** is a Gmail-attachment system. Its parts: Google Sheet as the customer table (44 code nodes, 37 data-table nodes, 23 Drive nodes, 18 Gmail nodes, 17 Sheets nodes), a consent form and ledger, OCR by vision LLMs (Gemini for PDFs, Qwen3-VL for images) before any masking, a file-hash registry for duplicates, a manual-review queue with a reviewer decision form, a daily 3/7/14-day reminder schedule, a retention sweep, and a privacy-request flow (confirmation token, deletion cascade, ledger pseudonymisation). No sample test data is pinned in the export.

**Logic to keep exactly:** the 13-type document normaliser (`family()`), deterministic evidence scoring, risk rules (demo markers, expiry, name mismatch), PII masking regexes, the status vocabulary, the deletion cascade.

**What changes:** Gmail intake becomes the portal; Sheet and Drive become Postgres and Storage; OCR becomes your own service; rules can verify clear cases without an LLM (the workflow required an AI score of 90 plus a rules score of 75, so rules alone never verified anything).

## 2. Gaps in the report and the defaults chosen

| Gap | Default (change by editing here) |
|---|---|
| Unfinished cases keep files forever | Case expires after 30 days; files deleted |
| Rejected file: kept or deleted? | Kept until re-upload (then deleted) or case end |
| What "eligible deletion" means | Deletes all customer data now; consent ledger keeps IDs only. Legal retention duties need counsel sign-off |
| Reminders counted from what? | From consent; 3, 7, 14 days; none after day 14 |
| Token lifetime, reuse, forwarding | Upload link 72 h, reusable; consent and privacy links single-use. Add rate limits and optional email OTP (phase B6) |
| Raw OCR text is unmasked PII | Mask before storing; OCR service is stateless and private |
| Staff actions not audited | Audit every view, download, review decision |
| "Verified" means plausible, not issuer-checked | UI says "received and verified", never "authentic" |
| Name check needs a reference name | Customer name from the database, sent as `expected` |
| Wrong document in a slot | Reject when OCR `doc_type` differs from the slot |
| Password-protected PDFs, multi-file, bad photos, OCR failure | Friendly resubmit message; OCR failure retries 3 times then manual review |
| Report examples use 3 and 4 required documents | Required list is per customer, set by staff at creation |
| "Pending" means two things | Separate fields: verification result vs not yet received |

## 3. Domain model

Four independent state machines (never merge into one status column):

| Field | Values |
|---|---|
| `documents.ocr_status` | waiting, processing, completed, failed |
| `documents.verification_status` | not_started, verified, rejected, manual_review |
| `customers.case_status` | in_progress, completed, expired, withdrawn |
| `documents.file_state` | stored, deleted (plus `delete_after` on the customer) |

Customer-visible state per document: pending_upload, processing, under_review, resubmit, verified.

Tables in `backend/app/models.py`: customers, required documents, documents, access_tokens (hashed), consents (append-only ledger), manual_reviews, jobs, retention, privacy_requests, audit_log.

## 4. Verification pipeline

upload, validate (type, size, magic bytes), encrypt, store, enqueue job, OCR, mask PII, rules, optional AI, decide, recalculate pending, complete or wait.

| Condition | Outcome |
|---|---|
| OCR `success`, type matches slot, no reason or flags, overall confidence at least 0.90, required fields present at least 0.80, name compatible, not expired | Verified, no AI |
| OCR `doc_type` differs from slot | Rejected, customer asked to resubmit |
| Risk flag, `low_confidence` with a reason, expired, name mismatch | Manual review |
| Rules inconclusive and no risk flag, AI enabled | Masked evidence to AI; AI can only upgrade at confidence at least 90 |
| OCR error or outage after 3 attempts | ocr_status failed, manual review |

Rule: never decide on OCR confidence alone. The test PAN scored 0.94 but came back `low_confidence` (`invalid_pan_entity_type_D`).

## 5. OCR service contract

`POST {OCR_URL}/ocr/{doc_type}?sync=true`, multipart `file`, optional `expected` JSON form field, `Authorization: Bearer <service key>`. Stateless: nothing written to Supabase.
Response: `status` (success, low_confidence, error), `doc_type`, `confidence`, `field_confidences`, `extracted_fields` (not masked, mask in the backend), optional `reason`, optional `cross_check`. No raw text is returned. Open items: wrong-document response shape, full list of status and reason codes, per-type field names (needed for `REQUIRED_FIELDS`), whether raw text can be requested.

## 6. API (built)

Admin (Supabase JWT, email in `ADMIN_EMAILS`): `POST|GET /api/admin/customers` (supports `?q=` search and `limit`/`offset` pagination with `X-Total-Count` header), `GET /api/admin/customers/{id}` (Documents tab data), `POST /api/admin/customers/{id}/close` (admin manual case closure, audited), `POST /api/admin/customers/{id}/delete-data` (admin immediate customer data & storage deletion cascade, audited), `POST .../send-consent`, `POST .../send-upload-link`, `GET /api/admin/reviews`, `POST /api/admin/reviews/{id}/approve|reject`, `GET /api/admin/documents/{id}/file` (Secure View; `?download=true` only if `ALLOW_DOWNLOAD=true`), `POST /api/admin/documents/{id}/delete-file` (admin mark file deleted, audited), `GET /api/admin/audit`, `GET /api/admin/summary`.
Customer: `GET|POST /api/public/consent/{token}`, `GET /api/portal/{token}`, `POST /api/portal/{token}/upload`, `POST /api/portal/{token}/otp/send` (optional upload OTP send), `POST /api/portal/{token}/otp/verify` (optional upload OTP verify), `GET /api/portal/{token}/documents/{id}/status`, `POST /api/public/privacy/request`, `POST /api/public/privacy/confirm/{token}`.

Security & abuse protection (Phase B4 built):
- Rate limiting: sliding window limiter on portal (`GET`, `/otp/*`), upload (`POST /upload`), consent (`GET|POST /consent/*`), and privacy (`POST /privacy/*`) endpoints. Returns 429 `rate_limited`.
- Magic-byte file validation: inspects headers for PDF (`%PDF-`), PNG (`\x89PNG\r\n\x1a\n`), and JPEG (`\xff\xd8\xff`). Disguised executables (`MZ`, `\x7fELF`, `\xca\xfe\xba\xbe`), archives (`PK\x03\x04`), shell scripts (`#!/`), HTML/script tags (`<script`, `<?php`), and unsafe active PDFs (`/JavaScript`, `/Launch`, `/Encrypt`) are rejected.
- Optional upload email OTP (`UPLOAD_OTP_ENABLED`): requires 6-digit email OTP verification before any document upload. Prevents forwarded-link abuse.
- Admin auth via Supabase JWKS: verifies RS256/ES256 JWTs using `PyJWKClient` from Supabase well-known JWKS endpoint, removing reliance on legacy HS256 secret.
- Expiry & single-use: consent and privacy tokens are strictly single-use; expired or revoked tokens return generic 404 without leaking customer identity.

Migrations & Ops (Phase B5 built):
- Alembic database migrations: replaces `create_all` with versioned schema migrations (`python -m app.db_init` or `alembic upgrade head`).
- Structured logs with zero PII: JSON log records containing timestamp, level, logger, message, context, and automatic redaction filter for PAN, Aadhaar, phone, and emails.
- Failed job alert hook: invokes registered alert hooks and logs critical alert when background jobs fail permanently after maximum retries.
- Multi-target Dockerfile: builds dedicated `api` and `worker` targets (`docker compose up --build`).
- SMTP setup: documented environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`) and tested email flows for consent, upload links, reminders, and live TLS dispatch.

Lifecycle proof (Phase B6 built):
- Integration tests using a controllable monotonic fake clock verifying:
  - 3, 7, and 14-day reminders dispatched to customers while documents remain pending.
  - Case expiry after 30 days if uncompleted, queuing files for deletion.
  - Case completion when all required documents verify, triggering 7-day retention schedule.
  - Complete purge at retention expiry: encrypted Storage files deleted, OCR data wiped, document hashes cleared, review records removed, customer tokens deleted, and deletion confirmation emails dispatched.

## 7. Frontend (React + TypeScript + Vite)

Routes: `/consent/:token`, `/portal/:token`, `/privacy`, `/privacy/confirm/:token`, `/admin` (sign in), `/admin/customers`, `/admin/customers/:id` (Documents tab), `/admin/reviews`, `/admin/audit`.
Customer pages: one card per required document with a status tag and its own upload; progress bar; polls status every 3 s after upload; closed and completed states; plain language only.
Admin pages: summary counts, case list with search, add-customer form, Documents tab (file, upload time, OCR, verification, review reason, delete date, Secure View), review queue with note, audit log. Sign in with Supabase email and password using the anon key; keep the token in memory or session storage.
Not shown to customers: risk flags, scores, internal reasons. Download button appears only when `ALLOW_DOWNLOAD=true`.

## 8. Acceptance tests

1. Dummy PAN goes from upload to verified with no manual step.
2. Same PAN into the Aadhaar slot is rejected and the customer is asked to resubmit.
3. Partial uploads: after each verified upload the pending list shrinks; the last one completes the case and starts retention.
4. Expired or unknown token returns the same generic error and leaks nothing.
5. OCR down: 3 retries, then manual review, document not lost.
6. Reviewer approve and reject both update pending and send the right email.
7. Retention job deletes files in Storage, OCR data and hashes after `delete_after`; Documents tab shows Deleted.
8. Privacy delete removes everything for that customer; ledger keeps IDs only.
9. Every staff view, download and decision appears in the audit log, with no PII in it.
10. No endpoint returns a public Storage URL or raw PII.
