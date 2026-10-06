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

Admin (Supabase JWT, email in `ADMIN_EMAILS`): `POST|GET /api/admin/customers` (supports `?q=` search and `limit`/`offset` pagination with `X-Total-Count` header), `GET /api/admin/customers/{id}` (Documents tab data), `POST /api/admin/customers/{id}/close` (admin manual case closure, audited), `POST /api/admin/customers/{id}/delete-data` (admin immediate customer data & storage deletion cascade, audited), `POST .../send-consent`, `POST .../send-upload-link`, `GET /api/admin/reviews`, `POST /api/admin/reviews/{id}/approve|reject`, `GET /api/admin/documents/{id}/file` (Secure View; `?download=true` only if `ALLOW_DOWNLOAD=true`), `POST /api/admin/documents/{id}/delete-file` (admin mark file deleted, audited), `GET /api/admin/audit`, `GET /api/admin/summary`, `GET|PUT /api/admin/settings/ocr` (stateless OCR model endpoint & API key configuration, audited), `POST /api/admin/settings/ocr/test` (connectivity probe).
Customer: `GET|POST /api/public/consent/{token}`, `GET /api/portal/{token}`, `POST /api/portal/{token}/upload`, `POST /api/portal/{token}/otp/send` (optional upload OTP send), `POST /api/portal/{token}/otp/verify` (optional upload OTP verify), `GET /api/portal/{token}/documents/{id}/status`, `POST /api/public/privacy/request`, `POST /api/public/privacy/confirm/{token}`.

Customer creation (`POST /api/admin/customers`, workflow STEP 2):
- Body: `{name, email, mobile?, required_documents[], send_consent?=true}`. Name whitespace collapsed (1-200 chars); email trimmed + lowercased; mobile optional, Indian 10-digit (6-9 start, optional `+91`/spaces/dashes), stored as `+91XXXXXXXXXX`; document types resolved via `doc_types.canonical_key` (aliases accepted, deduplicated); empty list rejected.
- Duplicate rule: 409 `duplicate_customer` if the normalized email already has an open case (`case_status` in `awaiting_consent|in_progress`, not data-deleted). Closed cases do not block. No DB unique constraint on email.
- Customer + `RequiredDocument` checklist + audit row commit in one transaction; any failure rolls back everything (500 `create_failed`). Initial state: `workflow_state=NOT_STARTED`, `consent_status=pending`, `case_status=awaiting_consent`, no completion/retention/deletion timestamps; pending = checklist rows with no verified document.
- The consent email (if `send_consent`) is issued only after that commit; if it fails the customer remains and the admin can use `send-consent`.
- Errors: `{"detail": {"code", "message"}}` with codes `invalid_name`, `invalid_email`, `invalid_mobile`, `unsupported_document_type`, `required_documents_empty` (422), `duplicate_customer` (409). Response is the standard customer object (includes `code` `CUS-000123`, `workflow_state`, `required`, `pending_count`).

Excel customer import (workflow STEP 3), stateless two-step, admin only, multipart field `file`:
- `POST /api/admin/customers/import/preview`: validates only; no DB writes, no emails. Returns `total_rows, valid_rows, invalid_rows, duplicate_rows, document_types_detected, rows[]`.
- `POST /api/admin/customers/import`: same file re-uploaded and fully re-validated; all `valid` rows are created in ONE transaction (`insert_customer` per row + one `customers_imported` audit row with counts only). Any DB error rolls back everything → 500 `import_failed` (a `customers_import_failed` count-only audit row is written). Consent emails are sent only after commit, per row with `send_consent`; failures don't roll back and are reported in `email_failures`. Returns `total_rows, imported, rejected, duplicates, failed, email_sent, email_failed, email_failures, created[{row,id,code}], rows[]`.
- File rules: `.xlsx` only (`invalid_file_type`), ≤ 5 MB (413 `file_too_large`), ≤ 1000 data rows (`too_many_rows`), unreadable (`invalid_file`), no sheet/header/data (`empty_workbook`), missing columns (`missing_headers`). Opened in memory with openpyxl `read_only=True, data_only=True` (formulas/macros never evaluated); never stored or logged.
- Columns (first sheet, header row 1, case/space/underscore-insensitive): `Full Name`|`name`, `Email Address`|`email`, `Mobile Number`|`mobile`, `Required Documents`|`required_documents` (required); `Send Consent Email`|`send_consent` (optional; blank/Yes/True/1 = true, No/False/0 = false, else `invalid_send_consent`). Documents separated by `,` `;` or `|`; each must equal a canonical key or label exactly (`doc_types.strict_key`, no fuzzy match) else `unsupported_document_type`. Blank rows are skipped. Row numbers match Excel.
- Row validation reuses `services.validate_customer_input` (STEP 2 rules and codes). Row `status`: `valid | invalid | duplicate_customer` (STEP 2 open-case rule) `| duplicate_excel_row` (every occurrence of an email repeated in the file; none imported). Only valid rows are imported.

Consent & secure token service (workflow STEP 4):
- Tokens: 32-byte cryptographically random string (`secrets.token_urlsafe(32)`); stored solely as SHA-256 hex digest (`token_hash`) in `access_tokens`. Tokens are single-purpose (`consent`, `upload`, `privacy`).
- TTLs: `consent_token_hours=168` (7 days), `upload_token_hours=72` (3 days), `privacy_token_minutes=60`. Expired, revoked, or non-existent tokens return generic 404 `invalid_or_expired_link` with zero PII or error leakage (strict anti-enumeration).
- `GET /api/public/consent/{token}`: resolves consent token, returns customer's first name, required document labels, and processing purpose. Exposes no DB IDs or customer emails.
- `POST /api/public/consent/{token}` (`granted: bool`):
  - Single-use consumption: consent token marked `used_at = utcnow()`; subsequent submissions return 404.
  - If `granted=True`: `consent_status="granted"`, `case_status="in_progress"`, `workflow_state="CONSENT_GRANTED"`, sets `consent_at` and `case_expires_at` (now + 30 days). Appends `ConsentLedger(event="granted")`. Issues expiring `upload` session token and dispatches upload link email. Returns `{"consent": "granted", "upload_token": "<token>"}`.
  - If `granted=False`: `consent_status="declined"`, `case_status="consent_declined"`, `workflow_state="CONSENT_WITHDRAWN"`. Appends `ConsentLedger(event="declined")`. Case stops.
- Consent withdrawal: customer requests withdrawal via `POST /api/public/privacy/request` (`action="withdraw"`) and confirms via single-use email token `POST /api/public/privacy/confirm/{token}`. Sets `consent_status="withdrawn"`, `case_status="consent_withdrawn"`, `workflow_state="CONSENT_WITHDRAWN"`, schedules retention purge `delete_after` (7 days), appends `ConsentLedger(event="withdrawn")`, immediately revokes all active customer access tokens, and blocks document uploads and scheduled reminders.

Secure document upload & encrypted storage (workflow STEP 5):
- Access & Token Isolation:
  - Token purpose must be `upload`, non-expired, non-revoked.
  - Customer workflow state must not be `CONSENT_WITHDRAWN`, `DELETED`, or `COMPLETED`. Customer `consent_status` must be `granted`.
  - Document slot must belong to customer checklist in `required_documents`. If already verified, re-upload is rejected (409 Conflict).
  - Anti-enumeration: invalid/expired/revoked tokens, non-existent customer cases, or cross-customer slot access return 404 `invalid_or_expired_link` with zero PII or case detail leakage.
- File validation (`validation.validate_file`):
  - Supported extensions & MIME types: `.pdf` (`application/pdf`), `.png` (`image/png`), `.jpg`/`.jpeg` (`image/jpeg`).
  - Size limits: 100 bytes minimum to reject empty/dummy files, 15 MB maximum (`MAX_UPLOAD_BYTES = 15 * 1024 * 1024`). Excess triggers 413 `file_too_large`.
  - Magic-byte inspection: enforces header byte signatures for PDF (`%PDF-`), PNG (`\x89PNG\r\n\x1a\n`), and JPEG (`\xff\xd8\xff`). Disallows executables, ZIP archives, shell scripts, and active PDF code (`/JavaScript`, `/Launch`).
  - Filename normalization: strips directory paths, null bytes, and non-printable characters (`re.sub(r'[^A-Za-z0-9._-]', '_', clean_name)`), preventing path traversal. Storage keys are strictly server-generated UUIDs (`{customer_id}/{doc_id}.enc`).
- AES-256-GCM Encryption before Storage:
  - Plaintext bytes never touch disk or remote object storage.
  - Symmetrically encrypted with server master `ENCRYPTION_KEY` using AES-256-GCM with a fresh 12-byte cryptographically secure random IV/nonce per file and authentication tag.
  - Storage keys are never stored with encryption keys. Ciphertext disk payload cannot be deciphered or recognized without the master key.
- Storage & Atomic Failure Cleanup:
  - Supports `LocalStorage` and `SupabaseStorage` private bucket backends.
  - Storage keys remain hidden from clients.
  - If database metadata persistence fails after ciphertext is written, the newly stored object is immediately cleaned up (`storage.delete_file`), preventing storage orphans.
- Document State & Resubmissions:
  - On upload: `workflow_state="UPLOADED"`, `verification_status="not_started"`, `ocr_status="waiting"`, `file_state="stored"`. The document is never marked verified in STEP 5.
  - Resubmission/superseding: re-uploading an unverified slot supersedes prior upload rows (`superseded=True`, `file_state="deleted"`) and purges their physical encrypted storage objects while updating customer workflow state to `IN_PROGRESS`.

Company OCR service integration (workflow STEP 6):
- Asynchronous PostgreSQL Job System:
  - Upload endpoint enqueues a background job `process_document` (`attempts=0`, `max_attempts=3`).
  - Document initial state: `workflow_state="UPLOADED"`, `ocr_status="waiting"`, `verification_status="not_started"`.
  - Worker claims job via `FOR UPDATE SKIP LOCKED`.
  - Verifies document is not superseded or deleted. If superseded, processing is safely aborted.
- Controlled Decryption & Plaintext Boundaries:
  - Retrieves AES-256-GCM ciphertext from storage, decrypts strictly in memory.
  - Plaintext bytes never touch disk, temporary storage, logs, or API responses.
- Upstream Microservice Integration (`company-ocr-service`):
  - Calls `POST {OCR_URL}/ocr/{doc_type}?sync=true` with multipart file and optional expected metadata (`{"name": customer.name}`).
  - Dual authentication: passes `Authorization: Bearer <OCR_API_KEY>` and `X-API-Key: <OCR_API_KEY>`.
  - For heavy multi-page documents (>5 pages or multi-page bank statements/ITRs), automatically switches to async queue mode and polls `/ocr/jobs/{job_id}` until completed.
- Result Storage & Audit Logging:
  - Received structured output (`status`, `confidence`, `field_confidences`, `extracted_fields`, `reason`, `qr_disagreements`) is mapped to `OCRResult`.
  - Persists masked/redacted evidence into `ocr_results` table.
  - Updates document `ocr_status="completed"` (or `"failed"`).
  - Emits structured audit events: `ocr_processing_started`, `ocr_completed`, `ocr_failed` (strictly ID-based, zero PII, zero tokens, zero raw text).
  - **The document is not marked verified in STEP 6** (verification awaits subsequent deterministic rules & AI evaluation stages).
- Resilience & Retries:
  - Transient network timeouts and HTTP 5xx/429 errors raise `OCRUnavailable` and trigger exponential backoff retry ($30 \times 2^{\text{attempts}}$ seconds).
  - Permanent 4xx errors mark `ocr_status="failed"` and route to human review without infinite loops.
  - When all 3 attempts are exhausted, `on_exhausted_process_document` routes the document to `ManualReview` (`ocr_service_unavailable`), preserving the document without data loss.

Step 7: PII Privacy Gateway / Deterministic Masking:
- **Boundary & Placement**:
  - Sits strictly between raw OCR output ingestion (Step 6) and downstream rules/AI evaluation (Step 8+).
  - Normalizes extracted OCR fields/evidence into a privacy-safe representation.
  - Raw unmasked OCR text (`raw_text`, `full_text`, `extracted_text`) is stripped from the privacy-safe evidence bundle.
- **Deterministic Masking**:
  - Full redaction (`[MASKED]` / `[REDACTED]` / `[MASKED-EMAIL]`): Aadhaar full numbers, date of birth, phone/mobile numbers, email addresses, passwords, CVVs, pins.
  - Partial / Structural preservation (`XXXX<last4>`): PAN numbers (`XXXX123F`), bank account numbers (`XXXX9012`), passport, voter ID, driving licence, UAN.
  - Non-sensitive fields preserved intact: customer names, holder names, employer/business names, document types, IFSC codes, dates/validity, OCR confidence scores, field confidences, and diagnostics.
  - Supports multi-page documents (`pages` array elements sanitized and stripped of raw text).
- **Storage & Isolation**:
  - Plaintext document bytes never touch disk.
  - Encrypted documents remain AES-256-GCM encrypted in private storage and are never mutated.
  - Redacted evidence is persisted into `ocr_results` and represents the only evidence made available to future AI, human review, and API routes.
Step 8: Deterministic Rules Verification:
- **Boundary & Inputs**:
  - Consumes exclusively the privacy-safe, redacted OCR evidence produced by Step 7 (`create_redacted_evidence`).
  - Raw OCR text and unmasked PII are strictly barred from rules evidence.
  - Original AES-256-GCM encrypted document remains safely stored in private storage.
- **Deterministic Rules Matrix & Checks**:
  - Document-type validation: ensures extracted document family matches customer slot; slot mismatches (e.g. PAN uploaded into Aadhaar slot) immediately trigger `REJECTED` and prompt customer resubmission.
  - Required fields presence: strictly checks all required structural fields per document type (defined in `REQUIRED_FIELDS`).
  - Name matching: deterministic token-based comparison (`match_name`) classifies exact matches, acceptable fuzzy/title variants, or mismatches without leaking customer names.
  - Structural identifier validity: validates format invariants for PAN, Aadhaar, and IFSC even on masked tokens (e.g. `XXXX<last4>`).
  - Expiry checking: parses multiple date formats and flags expired documents.
  - Integrity & Risk signals: checks QR disagreements (`qr_disagreements`), cross-check verification failures, high risk scores ($\ge 30$), and demo/synthetic markers.
  - Confidence thresholds: checks overall confidence against `min_overall` ($0.90$) and individual field confidences against `min_field` ($0.80$). Low confidence ($< 0.60$) triggers immediate review.
- **Outcome Classification & Mapping**:
  - **CLEAR**: All rules pass, sufficient confidence, zero risk flags $\rightarrow$ `doc.verification_status = "verified"` (case pending count decremented, triggers completion if checklist finished).
  - **INCONCLUSIVE**: Clean document with borderline confidence ($0.60 \le \text{conf} < 0.90$) or missing non-critical context $\rightarrow$ `verification_status` remains pending/`needs_ai` (queued for downstream AI evaluation in Step 9; never marked verified in Step 8).
  - **RISK**: Structural identifier invalidity, name mismatch, expired document, low confidence, missing required fields, or OCR risk flags $\rightarrow$ `verification_status = "manual_review"` (or `"rejected"` for slot mismatches).
- **Idempotency & Fail-Closed Safety**:
  - Automatically skips already verified documents, superseded documents, or customers with withdrawn consent.
  - Rules engine evaluation is wrapped in a fail-closed try/catch: on any unexpected exception, logs sanitized error, audits `rules_failed`, routes document to `manual_review` (`rules_engine_error`), and never marks verified.
Step 9: AI Verification / Redacted AI Escalation:
- **Boundary & Invocation**:
  - Invoked **ONLY** when Step 8 returns `INCONCLUSIVE` (`needs_ai` / `AI_REQUIRED`).
  - Documents with Step 8 `CLEAR` or `RISK` bypass AI entirely.
  - Consumes exclusively the privacy-safe, redacted OCR evidence produced by Step 7 (`create_redacted_evidence`).
  - Raw OCR text, document bytes, and raw PII are strictly barred from outbound AI prompts.
- **Pre-Dispatch PII Safety Gate**:
  - Runs automated pre-dispatch inspection (`verify_ai_payload_safety`) on the payload before dispatching to any AI provider.
  - Inspects against regex patterns for PAN, Aadhaar, email, phone, and unmasked bank account numbers.
  - If unsafe data is detected: aborts dispatch, emits audit event `ai_failed` (`{"reason": "pii_leak_prevented"}`), and routes document directly to `manual_review`.
- **Structured AI Output Schema**:
  - `decision` / `verdict`: `verified` | `inconclusive` | `manual_review`
  - `confidence`: float between `0.0` and `1.0` (or `0` – `100%`)
  - `reason_codes`: list of standardized reason code strings
  - `risk_flags`: list of identified risk flags
  - `evidence_summary`: factual explanation
- **Outcome Resolution Rules & Invariants**:
  - `verified` + `confidence >= 0.90` (and zero AI risk flags) $\rightarrow$ `doc.verification_status = "verified"`.
  - `inconclusive` or confidence $< 0.90$ $\rightarrow$ `doc.verification_status = "manual_review"`.
  - `manual_review` $\rightarrow$ `doc.verification_status = "manual_review"`.
  - Timeout, network exception, or invalid/malformed response $\rightarrow$ `doc.verification_status = "manual_review"`.
  - **AI can NEVER override a Step 8 RISK or REJECTED outcome** into `verified` (hard flags permanently block upgrade).
- **Audit Logging**:
  - Emits ID-based audit events: `ai_verification_started`, `ai_verified`, `ai_inconclusive`, `ai_manual_review`, `ai_failed`.
  - Prompts, raw responses, document bytes, and PII are never logged.



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

Step 10: Manual Review & Exception Handling (built):
- Unified Ingestion: Deterministic rules `RISK`, AI `manual_review` verdicts, and unhandled AI/OCR failures route automatically into `ManualReview`.
- Secure Record: Contains `document_id`, `customer_id`, reason codes, risk flags, masked OCR evidence (`OcrResult`), and review status (`open`, `approved`, `rejected`).
- Reviewer Authorization & Access: `GET /api/admin/reviews` and `GET /api/admin/reviews/{id}` restricted to authorized staff (`require_admin`). Audits `manual_review_opened`. Returns zero unmasked PII; staff stream decrypted document through audited Secure View (`GET /api/admin/documents/{id}/file`) without public URLs.
- Approval Decision (`POST /api/admin/reviews/{id}/approve`): Marks document `verified`, closes manual review, recalculates case checklist (completing case if all docs verified), and emits sanitized audit events `manual_review_approved` and `review_approved`. Fails closed if document is superseded (409), deleted (410), or consent withdrawn (400).
- Rejection / Resubmission Decision (`POST /api/admin/reviews/{id}/reject`): Marks document `rejected`, issues a secure customer upload token, dispatches resubmission email, keeps checklist slot pending, closes manual review as `rejected`, and emits `manual_review_rejected` and `review_rejected`.
- Security & Concurrency: Duplicate decisions blocked (409 `already_decided`). Prevents approving superseded/withdrawn documents. Zero raw PII in review payloads, logs, or audit records.

Step 11: Reminders + Completion + 7-Day Retention + Permanent Deletion (built):
- Recalculate Pending: Evaluates checklist after every upload, verification, rejection, and resubmission. Pending count = required documents without a verified document.
- Completion & Retention Schedule: When pending drops to 0, transitions customer `workflow_state` to `COMPLETED`, `case_status` to `completed`, sets `completed_at`, schedules 7-day retention (`delete_after = completed_at + retention_days`), sends completion email, and records audit events `customer_completed`, `retention_started`, and `case_completed`.
- Idempotent Reminders (Day 3, 7, 14): Dispatches upload reminders at Day 3, 7, 14 while documents remain pending, only if consent is active and case is not completed, expired, withdrawn, or deleted. Enforces idempotency via `last_reminder_stage`; repeated runs never send duplicates. Emits `reminder_sent`.
- 7-Day Permanent Deletion Purge: When `delete_after <= utcnow()`, permanently wipes encrypted files in Storage, OCR results, manual review rows, access tokens, and wipes document hashes (`sha256 = ""`), flipping document file state to `deleted` and setting `data_deleted_at`. Emits `data_permanently_deleted` and `retention_deleted`. Sends deletion confirmation email.
- Access Restriction: Deleted files return 410 Gone; cannot be downloaded or viewed.
- Fail-Safe Isolation: Operates on one customer per transaction; failures log safely without raw PII and retry safely.

Step 12: Final Privacy Requests + End-to-End Workflow Verification (built):
- Right to be Forgotten (Privacy Deletion): Double opt-in via silent request (`POST /api/public/privacy/request`) + single-use verification token confirmation (`POST /api/public/privacy/confirm/{token}`). Anonymizes personal records (`name='[deleted]'`, `email='deleted-{id}@invalid.local'`), purges encrypted files in Storage, temporary OCR records, manual review records, and customer tokens. Preserves audit identifiers and `ConsentLedger(event='deleted')`. Sends deletion confirmation email.
- Consent Withdrawal: Double opt-in confirmation transitions case to `consent_withdrawn`, `workflow_state='CONSENT_WITHDRAWN'`, revokes active upload tokens, blocks future uploads (404/403), schedules 7-day retention, records `ConsentLedger(event='withdrawn')`, and dispatches withdrawal confirmation email.
- Job Queue Blocking: Worker pipeline automatically intercepts and terminates processing (`ocr_status='failed'`, `reason='processing_stopped'`) if customer consent is withdrawn or case is closed before job dispatch.
- Full E2E Workflow Verification: Validates customer creation -> consent -> upload -> encrypted storage -> OCR -> masking gateway -> rules engine -> redacted AI -> manual review -> pending recalculation -> reminders -> completion -> retention -> permanent deletion.
- Zero PII Leakage: Verified across all workflows that raw PAN, Aadhaar, account numbers, and mobile numbers never appear in logs, audit records, or HTTP error responses.

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
