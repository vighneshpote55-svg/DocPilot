# DocPilot & Company OCR Service — Current State Audit

**Audit Date**: October 2, 2026  
**Audited Repositories**:
1. **DocPilot Application**: D:\DocPilot (Backend, Frontend, Docs, E2E)
2. **Company OCR Service**: c:\Users\sachi\Documents\company-ocr-service (FastAPI Microservice, RapidOCR Engine, AI Manager)

**Integrity Confirmation**: This audit is purely observational. **Zero source code, database tables, dependencies, or environment configurations were modified.**

---

## 1. Executive Summary

DocPilot and Company OCR Service represent two halves of a secure, compliant document collection and verification platform:
- **DocPilot** is the orchestration and customer-facing system (replacing the legacy 203-node n8n Gmail workflow): handling customer intake, consent ledgers, upload portals, AES-256-GCM encrypted file storage, staff administration, manual reviews, reminder schedules, and privacy/retention deletion cascades.
- **Company OCR Service** is the specialized, offline-first document extraction microservice: utilizing RapidOCR (ONNX runtime) and 22 Indian document extractors, checksum validators (Aadhaar Verhoeff, GSTIN Luhn, PAN entity check), PII masking, and multi-language Devanagari models.

**Key Finding**: The end-to-end workflow architecture is **exceptionally well-designed and largely complete** in code (86 DocPilot backend tests passing, 346 OCR service tests passing). However, DocPilot is currently running with MOCK_OCR_MODE=true in .env, only 13 of the 22 supported document types are recognized in DocPilot's canonical schema, and AI fallback is disabled (AI_ENABLED=false).

---

## 2. End-to-End Workflow Comparison Matrix

Required Lifecycle:
\text{Customer} \rightarrow \text{Consent} \rightarrow \text{Secure Upload} \rightarrow \text{Encrypted Storage} \rightarrow \text{OCR} \rightarrow \text{PII Masking} \rightarrow \text{Rules} \rightarrow \text{AI if needed} \rightarrow \text{Manual Review} \rightarrow \text{Pending Recalculation} \rightarrow \text{3/7/14 Reminders} \rightarrow \text{Completed} \rightarrow \text{7-Day Retention} \rightarrow \text{Deletion}

| Workflow Stage | Status | Primary Code Locations | Audit Findings & Details |
| :--- | :---: | :--- | :--- |
| **1. Customer** | **IMPLEMENTED** | DocPilot/backend/app/routes_admin.py<br>DocPilot/backend/app/services.py | Staff creates customer with email, mobile, and required documents. Generates unique customer code (CUST-...) and initializes case as pending. |
| **2. Consent** | **IMPLEMENTED** | DocPilot/backend/app/routes_public.py<br>DocPilot/frontend/src/pages/ConsentPage.tsx | Single-use 32-byte URL-safe token (/consent/:token). Decline stops processing immediately; accept records IP/User-Agent in consent_ledger, stamps consent_at, and emails upload link. |
| **3. Secure Upload** | **IMPLEMENTED** | DocPilot/backend/app/routes_portal.py<br>DocPilot/frontend/src/pages/PortalPage.tsx | Per-document cards, 3s status polling, progress bar. Hardened upload validation: magic byte verification, rejection of active PDF scripting (/JavaScript, /Launch), password-protected PDF rejection, and email OTP gate against forwarded link abuse. |
| **4. Encrypted Storage** | **IMPLEMENTED** | DocPilot/backend/app/storage.py<br>DocPilot/backend/app/security.py | Uploaded files encrypted at rest with AES-256-GCM (12-byte random nonce) before persisting to private Supabase case-documents bucket or local disk. Never exposes public URLs. |
| **5. OCR** | **PARTIAL** | DocPilot/backend/app/ocr_client.py<br>company-ocr-service/main.py | **Live integration is implemented but bypassed**: HTTPOCRClient is fully coded to call POST /ocr/{doc_type}?sync=true, but .env has MOCK_OCR_MODE=true. Furthermore, DocPilot recognizes only 13 doc types while OCR service supports 22. |
| **6. PII Masking** | **IMPLEMENTED** | DocPilot/backend/app/masking.py<br>company-ocr-service/extractors.py | Full PII redaction: Aadhaar (XXXX XXXX 1234), bank account masking, address redaction. Raw OCR text exists in memory only; persisted OcrResult.payload contains exclusively masked fields. |
| **7. Rules** | **IMPLEMENTED** | DocPilot/backend/app/rules.py<br>company-ocr-service/verifier.py | Deterministic verification: mandatory fields check, fuzzy name compatibility (
ames_compatible), expiry check, synthetic demo document markers (DEMO_MARKERS), and mismatch detection (wrong_document_type). High-confidence documents auto-verify with zero AI dependency. |
| **8. AI if needed** | **PARTIAL** | DocPilot/backend/app/ai_service.py<br>company-ocr-service/ai_service.py | DocPilot includes an OpenAI-compatible fallback (i_service.py) with strict prompt guardrails (can only upgrade uncertain to verified at $\ge 90\%$ confidence). However, AI_ENABLED=false in .env. Additionally, company-ocr-service has its own comprehensive multi-provider AI engine (Ollama/Qwen2.5-VL/Gemini). |
| **9. Manual Review** | **IMPLEMENTED** | DocPilot/backend/app/routes_admin.py<br>DocPilot/frontend/src/pages/AdminPage.tsx<br>AdminCustomerDetailPage.tsx | Inconclusive or hard-flagged documents enter manual_reviews. Reviewers inspect files via authenticated Secure View (URL.createObjectURL blob). Reviewer can Approve (updates to verified) or Reject (requests customer resubmission). |
| **10. Pending Recalc** | **IMPLEMENTED** | DocPilot/backend/app/services.py (
ecalc_case) | Explicit invariant: $\text{Pending} = \text{Required} - \text{Verified}$. Recalculated on every verification, rejection, approval, or deletion. When pending reaches 0, case advances to completed and schedules retention. |
| **11. 3/7/14 Reminders**| **IMPLEMENTED** | DocPilot/backend/app/scheduler.py<br>DocPilot/backend/app/emailer.py | Periodic task checks days elapsed from consent_at. Sends upload link reminders at days 3, 7, and 14 while pending documents remain. Ceases immediately upon case completion. |
| **12. Completed** | **IMPLEMENTED** | DocPilot/backend/app/services.py<br>DocPilot/backend/app/models.py | Marks case_status = 'completed', stamps completed_at, dispatches completion email to customer, and locks upload portal against further submissions. |
| **13. 7-Day Retention** | **IMPLEMENTED** | DocPilot/backend/app/scheduler.py<br>DocPilot/backend/app/services.py | Sets delete_after = completed_at + 7 days. Unfinished cases expire at 30 days (case_expires_at) and are queued for deletion. |
| **14. Deletion** | **IMPLEMENTED** | DocPilot/backend/app/scheduler.py (delete_due)<br>DocPilot/backend/app/services.py | Scheduled purge wipes encrypted Storage objects, deletes ocr_results payloads, purges tokens, stamps data_deleted_at, and sends deletion confirmation email. Privacy requests trigger this cascade immediately. |

---

## 3. Subsystem Breakdown & Component Analysis

### A. Frontend Applications
1. **DocPilot Frontend (D:\DocPilot\frontend)**:
   - Modern React 19 + TypeScript + Vite architecture.
   - Clean route hierarchy: /consent/:token, /portal/:token, /privacy, /privacy/confirm/:token, /admin, /admin/customers/:id.
   - **Customer Portal**: Per-card upload states (Waiting for your upload, Checking, Under review, Please upload again, Received and verified), email OTP challenge, animated progress bars, live polling every 3 seconds.
   - **Admin Portal**: Supabase authentication, summary stats cards, customer search & pagination, customer creation modal, review decision actions, audit log viewer, and Secure View modal for decrypted document inspection.
2. **Company OCR Dashboard (company-ocr-service/frontend)**:
   - Standalone internal dashboard with Document Vault, live RapidOCR playground, AI chat inspector, and health status indicators.

### B. Backend Services
1. **DocPilot Backend (D:\DocPilot\backend)**:
   - FastAPI microservice with SQLAlchemy ORM, pg8000/Postgres support, Alembic migrations, and modular route structure (
outes_public, 
outes_portal, 
outes_admin).
   - Background worker (python -m app.worker) polling database-backed job queue with SKIP LOCKED concurrency control and self-healing stuck job recovery.
   - Centralized scheduler.py handling reminders, case expiry, and retention deletion sweeps.
2. **Company OCR Service Backend (company-ocr-service)**:
   - High-throughput FastAPI engine running RapidOCR (ONNX runtime) and PaddleOCR.
   - 22 document extractors with regex boundary parsing and mathematical checksums (Aadhaar Verhoeff, GSTIN Luhn, PAN entity character, IFSC bank registry).
   - Multi-language Devanagari recognition for regional Indian documents (Marathi / Hindi).
   - Async job queue (POST /ocr/{doc_type} returning 202 Accepted + poll_url) and synchronous execution (?sync=true).

### C. Database & Storage Architecture
1. **DocPilot Database**:
   - Well-normalized relational schema: Customer, RequiredDocument, Document, OcrResult, ManualReview, AccessToken, ConsentLedger, AuditLog, Job, PrivacyRequest.
   - Foreign key cascades ensure customer deletion cleanly removes documents, jobs, and tokens while preserving pseudonymized audit trails.
2. **Encrypted Storage**:
   - Both systems implement AES-256-GCM encryption at rest. DocPilot encrypts files in storage.py using cryptography.hazmat.primitives.ciphers.aead.AESGCM with a 32-byte key and 12-byte random nonce.
   - Supports dual backend: local filesystem directory (STORAGE_BACKEND=local) or private Supabase bucket (STORAGE_BACKEND=supabase).

### D. Authentication & Security
- **Admin Security**: Supabase JWT authentication verified via JWKS endpoint (PyJWKClient) or static secret, with explicit admin email allowlisting (ADMIN_EMAILS).
- **Customer Security**: Zero passwords. Cryptographic 32-byte URL-safe tokens stored as SHA-256 hashes in database. Single-use enforcement on consent and privacy tokens.
- **Upload Hardening**: Validation against file magic bytes, MIME types, and active scripting in PDFs (/JS, /JavaScript, /Launch, /Action).
- **Zero-PII Logging**: Audit loggers in both systems enforce strict formatting that strips document values, names, and phone numbers, logging only operational metadata (job_id, doc_type, status, duration_ms).

### E. Existing Test Suites
- **DocPilot Backend**: 86 unit and integration tests collected and passing via pytest (	est_admin_completeness.py, 	est_all_doc_types.py, 	est_core.py, 	est_flow.py, 	est_lifecycle_b6.py, 	est_ops_b5.py, 	est_security_b4.py).
- **DocPilot Frontend**: Playwright E2E test suite (cceptance.spec.ts, capture_updated_ui.spec.ts).
- **Company OCR Service**: 346 tests collected and passing across extraction, verification, multilingual OCR, PII minimisation, encryption, and async jobs.

---

## 4. Key Findings: Gaps, Duplications & Recommendations

### 1. Missing Features & Configuration Gaps
1. **Live OCR Connection Inactive (MOCK_OCR_MODE=true)**:
   - In D:\DocPilot\backend\.env, MOCK_OCR_MODE is currently set to 	rue. DocPilot is generating synthetic mock OCR results rather than invoking the live company-ocr-service on port 8000.
2. **Document Type Discrepancy (13 vs 22 Types)**:
   - DocPilot's doc_types.py only defines 13 document types from the legacy n8n specification.
   - company-ocr-service supports 22 document types (including certificate_of_incorporation, gst_certificate, orm_16, iec_certificate, partnership_deed, ank_passbook, 
ent_agreement, property_tax_receipt, income_certificate). DocPilot cannot currently request or auto-verify these 9 newer document types.
3. **Download Button UI Not Exposed**:
   - While 
outes_admin.py supports policy-based downloads (ALLOW_DOWNLOAD=true), the frontend AdminCustomerDetailPage.tsx lacks a download button or toggle to trigger iew_document(doc_id, download=True).
4. **Synchronous OCR Call for Multi-Page Files**:
   - DocPilot calls POST /ocr/{doc_type}?sync=true. For large multi-page PDFs (e.g. 24-page bank statements or multi-page ITRs), synchronous HTTP calls can risk client timeouts (OCR_TIMEOUT_SECONDS=60). Wiring up the async polling/webhook queue pattern (POST /ocr/{doc_type} -> 202 Accepted -> poll GET /ocr/jobs/{job_id}) provides better resilience.

### 2. Security & Operational Observations
1. **Browser Object URL Leak in Secure View**:
   - In AdminCustomerDetailPage.tsx (lines 58-59), URL.createObjectURL(blob) is created for previewing decrypted documents, but URL.revokeObjectURL() is never invoked when closing the modal, leading to gradual browser memory retention.
2. **OTP Rate Limiting & Attempt Caps**:
   - 
ate_limiter.py limits overall portal IP requests, but per-token OTP verification attempt counters (e.g., maximum 3 incorrect OTP entries before invalidation) should be strictly enforced to prevent brute-forcing.

### 3. Duplicate Functionality
1. **PII Masking**: Both DocPilot (masking.py) and OCR Service (extractors.py) implement regex masking. (This is a benign defense-in-depth duplication, ensuring PII is masked even if one layer fails).
2. **AI Service Layer**: DocPilot has its own i_service.py pointing to a generic /chat/completions endpoint, while company-ocr-service already maintains an AI Provider Manager (i_providers.py) with vision LLM support (Qwen2.5-VL, Gemini).

### 4. Components That Should NOT Be Changed
- **Preserve Offline OCR Logic**: RapidOCR and the 22 rule extractors in company-ocr-service must remain offline and must not be replaced by cloud AI.
- **Pending Recalculation Invariant**: The rule $\text{Pending} = \text{Required} - \text{Verified}$ in DocPilot/backend/app/services.py is central to the entire case lifecycle.
- **Secure View Invariant**: Never store or return public storage URLs. Documents must remain encrypted at rest and streamed as authenticated decrypted blobs only.
- **Single-Use Tokens & Zero PII Logging**: Consent and privacy tokens must remain single-use; audit logs must never record raw document text or customer PII.

---

## 5. Recommended Implementation Roadmap

When the user approves moving forward to implementation, execute in this order:

1. **Step 1: Switch DocPilot to Live OCR Mode**:
   - Set MOCK_OCR_MODE=false in D:\DocPilot\backend\.env and point OCR_URL=http://localhost:8000.
   - Run D:\DocPilot\backend\scripts\smoke_test.py against live company-ocr-service to verify end-to-end communication.
2. **Step 2: Expand Document Type Parity (13 to 22 Types)**:
   - Add the 9 missing document types into DocPilot's doc_types.py and 
ules.py REQUIRED_FIELDS so DocPilot can request and verify the complete set of 22 documents.
3. **Step 3: Frontend Cleanup & UI Polish**:
   - Add URL.revokeObjectURL cleanup in AdminCustomerDetailPage.tsx.
   - Conditionally render Document Download button in AdminCustomerDetailPage.tsx when ALLOW_DOWNLOAD=true.
4. **Step 4: Async Job Handling for Heavy Documents**:
   - Enhance DocPilot's ocr_client.py to optionally use the async queue pattern for PDFs exceeding 5 pages.
5. **Step 5: Full E2E & Lifecycle Verification**:
   - Run complete test suite (pytest in backend, Playwright in frontend) to verify the integrated stack.
