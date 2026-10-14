# DocPilot — Controlled Staging Deployment & Smoke Testing Report

**Date**: 2026-10-14  
**Evaluated Revision**: `d63537da807daa69a15761ae5137089dfffac2cf` (`docs: add staging readiness and deployment validation report`)  
**Evaluation Host**: `incraax-ai-A520M-K-V2` (Linux 7.0.0-38-generic x86_64)  
**Evaluation Scope**: Host infrastructure, reverse proxy ingress, service supervisor configuration, database/storage connectivity, end-to-end synthetic workflow, worker recovery, encryption, alerting, and regression suites.

---

## 1. Deployed Revision & Environment Identification

* **HEAD Commit**: `d63537da807daa69a15761ae5137089dfffac2cf`
* **Subject**: `docs: add staging readiness and deployment validation report`
* **Working Tree**: Clean (`git status` returned 0 uncommitted changes, `git diff --check` returned 0 errors).
* **Host Classification**: **Local Developer Workstation** (AMD Ryzen / Ubuntu 24.04-based kernel `7.0.0-38-generic`).
* **Staging Server Isolation**: A separate, isolated staging host / VM is **not provisioned**. The evaluation was performed directly on the local development environment using synthetic records and isolated tests.

---

## 2. Infrastructure & Configuration Verification

| Subsystem / Requirement | Target Staging Config (`DEPLOYMENT.md`) | Actual Host State | Status | Verification Evidence / Blocker |
| :--- | :--- | :--- | :---: | :--- |
| **Systemd Backend Unit** | `/etc/systemd/system/docpilot-backend.service` | File not found; service inactive | **BLOCKED** | Running in dev terminal (`uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload`). |
| **Systemd Worker Unit** | `/etc/systemd/system/docpilot-worker.service` (`TimeoutStopSec=210s`) | File not found; service inactive | **BLOCKED** | Worker run manually via terminal (`python -m app.worker`). |
| **Dedicated Service User** | `User=docpilot`, `Group=docpilot` | `id: 'docpilot': no such user` | **BLOCKED** | Running under developer UID `incraax-ai`. |
| **Working Directory** | `/var/www/docpilot` | `/var/www` does not exist | **BLOCKED** | Project located in `/home/incraax-ai/Documents/Vighnesh/DocPilot`. |
| **Reverse Proxy (Nginx/Caddy)** | TLS termination + header sanitization | `which nginx caddy` returns null | **BLOCKED** | No reverse proxy installed; ports 80 and 443 are not bound. |
| **Interface Binding** | `127.0.0.1:8080` | `0.0.0.0:8080` (active) | **BLOCKED** | Backend listening on all interfaces; unprotected against direct bypass. |
| **Forwarded-IP Overwrite** | Proxy sets `X-Forwarded-For $remote_addr` | No proxy active | **BLOCKED** | Direct access allows client-controlled `X-Forwarded-For` header spoofing. |
| **Database Connectivity** | PostgreSQL 17+ (pool recycle, SSL) | Connected to PostgreSQL 17.11 (`postgres` db) | **PASS** | `SELECT current_database(), version();` verified; 11 tables present. |
| **Storage Backend** | Private Supabase bucket (authenticated) | `SupabaseStorage` bucket connected | **PASS** | AES-256-GCM put/get/delete roundtrip verified with synthetic payload. |
| **Encryption Master Key** | AES-256-GCM (32 bytes urlsafe-base64) | Configured in environment (`has_key=True`) | **PASS** | Key verified programmatically without exposing secret; eager check tested. |
| **Database Backup Schedule** | Automated periodic dumps (pg_dump) | `no crontab for incraax-ai` | **BLOCKED** | No cron job or systemd backup timer configured. |
| **Alert Webhook Destination** | `ALERT_WEBHOOK_URL="https://..."` | `alert_webhook_url=""` (empty) | **BLOCKED** | No authorized staging webhook endpoint configured. |

---

## 3. End-to-End Synthetic Document Workflow

Executed an isolated live synthetic workflow test using synthetic customer ID `531` and a dummy PDF document payload (zero PII):

```
=== LIVE SYNTHETIC WORKFLOW VERIFICATION ===
1. Synthetic Customer: Created ID 531 with consent_status="granted", case_status="in_progress".
2. Document Storage: Stored 531/test_staging_doc.enc in Supabase storage with file_state="stored".
3. Queueing: Created Job(kind="process_document", status="queued", payload={"document_id": doc_id}).
4. Decryptability: Retrieved ciphertext from storage and decrypted using unchanged ENCRYPTION_KEY.
   Payload byte-for-byte match verified.
5. Failure Handling: Executed pipeline.on_exhausted_process_document(); document routed to manual_review
   with flag ["ocr_unavailable"] and ManualReview record opened.
6. Data Purge: Purged all synthetic test records (Customer, Document, Job, ManualReview) and deleted
   storage key cleanly.
```

* **Workflow Status**:
  - Upload & Storage Encryption: **PASS**
  - Queueing & Claim Isolation (`FOR UPDATE SKIP LOCKED`): **PASS**
  - Decryptability Continuity: **PASS**
  - Manual Review Routing on Failure: **PASS**
  - Strict Foreign Key Cascading & Isolation: **PASS**
  - Unauthorized Admin Access Rejection (HTTP 401/403): **PASS**

---

## 4. Worker Recovery & Concurrency

Evaluated worker supervision and multi-worker recovery mechanisms:

1. **Graceful Worker Shutdown**:
   - `_handle_shutdown()` traps `SIGTERM` and `SIGINT`, switching `_running = False`.
   - The worker completes active in-flight jobs and commits status to `done` before exiting cleanly (`test_graceful_shutdown_signal_handler`).
2. **Lease Expiry & Crash Recovery**:
   - `jobs.recover_stuck(minutes=15)` scans for jobs in `status="running"` with `locked_at` older than 15 minutes.
   - Stuck jobs under `max_attempts` are reset to `status="queued"` with exponential backoff (`30 * 2^attempts`) and cleared `locked_at`.
   - Stuck jobs reaching `max_attempts` trigger `on_exhausted_process_document()`, marking `status="failed"` and transitioning document to `manual_review`.
3. **Multi-Worker Concurrency**:
   - PostgreSQL `FOR UPDATE SKIP LOCKED` verified across concurrent worker claim attempts.
   - Zero duplicate jobs claimed, zero lock leaks, and idempotent `_open_review()` execution (`test_multiworker_simultaneous_claims_and_execution`, `test_delayed_worker_resumption_after_stuck_recovery_idempotency`).

---

## 5. Encryption & Alerting Delivery

* **Key Decryptability Across Restart**: Retained encrypted documents in the database remain decryptable with the unchanged key.
* **Eager Key Validation Failure**: Tested in an isolated test configuration with a mocked missing `ENCRYPTION_KEY`. `worker.main()` logged a critical error and aborted immediately with exit code `1` before polling the database queue:
  ```json
  {"level": "CRITICAL", "logger": "worker", "message": "Worker startup aborted: ENCRYPTION_KEY is not set"}
  ```
* **Alert Delivery Status**:
  - `ALERT_WEBHOOK_URL` is unset (`""`) in `.env`. Successful alert delivery is marked **BLOCKED** due to lack of a designated destination.
  - Connection timeout (2s connect, 5s total) and unreachable-endpoint resilience were tested against `http://127.0.0.1:19999/unreachable_alert_test`. The connection refusal was caught and logged in **0.047s** with zero uncaught exceptions and no worker crash.
  - Payloads contain only `alert`, `job_id`, `kind`, `attempts`, `max_attempts`, and truncated `error`. **Zero PII or document data is emitted.**

---

## 6. Automated Regression & Build Execution

Fresh automated verification executed on revision `d63537d`:

### Targeted Worker Supervision & Recovery Suite
```bash
.venv/bin/pytest tests/test_worker_supervision_metrics.py tests/test_job_recovery_concurrency.py tests/test_workflow_integrity.py -v
```
* **Result**: **30 passed, 1 warning in 5.73s** (Exit code: 0)

### Full Backend Regression Suite
```bash
.venv/bin/pytest tests/ -q
```
* **Result**: **783 passed, 4 deselected, 1 warning in 50.51s** (Exit code: 0)

### Frontend Production Build
```bash
PATH="/home/incraax-ai/.local/node/bin:$PATH" npm run build
```
* **Result**: **Built cleanly in 324ms** (Exit code: 0)
* **Bundle Output**:
  - `dist/index.html` (1.52 kB)
  - `dist/assets/index-DFb6ONt5.css` (193.93 kB)
  - `dist/assets/index-HzE56bG8.js` (367.99 kB)
  - `dist/assets/AdminPage-L-Uo-bZR.js` (548.21 kB)

### Code Hygiene
```bash
git diff --check
```
* **Result**: Clean (0 formatting or whitespace issues).

---

## 7. Outstanding Blockers & Remediation Steps

Before conducting a live staging smoke test on dedicated infrastructure, the following prerequisites must be provisioned:

1. **Dedicated Staging Host Provisioning**:
   - Provision an isolated Linux staging VM/container.
   - Create system user: `sudo useradd -r -s /bin/false docpilot`.
   - Deploy code to `/var/www/docpilot/backend` and `/var/www/docpilot/frontend/dist`.
2. **Reverse Proxy Installation & Configuration**:
   - Install Nginx or Caddy.
   - Configure TLS termination and enforce header overwriting:
     ```nginx
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $remote_addr;
     proxy_set_header X-Forwarded-Proto $scheme;
     ```
   - Bind FastAPI backend strictly to `127.0.0.1:8080`.
3. **Systemd Service Units Installation**:
   - Install `/etc/systemd/system/docpilot-backend.service` and `/etc/systemd/system/docpilot-worker.service` as documented in `docs/DEPLOYMENT.md`.
   - Ensure worker unit includes `TimeoutStopSec=210s` and `KillSignal=SIGTERM`.
   - Execute `sudo systemctl daemon-reload && sudo systemctl enable --now docpilot-backend docpilot-worker`.
4. **Staging Alert Webhook & Database Backups**:
   - Configure `ALERT_WEBHOOK_URL="https://alerts.staging.company.com/..."` in staging `.env`.
   - Configure daily automated PostgreSQL backups via cron or managed database snapshots.

---

## 8. Final Decision

### **STAGING VALIDATION INCOMPLETE — PREREQUISITES UNAVAILABLE**

**Justification**:  
The application codebase, database schemas, worker recovery algorithms, encryption mechanisms, and automated test suites (783 tests passing) are fully validated and functionally ready. However, the dedicated staging host infrastructure—specifically the systemd process supervisor units, Nginx/Caddy reverse proxy with client-IP sanitization, loopback interface binding, and alert webhook endpoint—is not installed or provisioned on this environment. Per the project deployment safety rules, live staging validation cannot be certified until these infrastructure prerequisites are provisioned.
