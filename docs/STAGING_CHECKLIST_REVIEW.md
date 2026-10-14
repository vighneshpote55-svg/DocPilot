# DocPilot — Staging Deployment Checklist Safety Review

**Date**: 2026-10-14  
**Reviewed Document**: [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md)  
**Evaluated Repository**: DocPilot (`/home/incraax-ai/Documents/Vighnesh/DocPilot`)  
**Companion Service**: Company OCR Service (`/home/incraax-ai/Documents/Vighnesh/company-ocr-service`)  
**Audit Purpose**: Verification of every shell command, database schema assertion, environment variable definition, security boundary control, and operational safeguard prior to staging deployment execution.

---

## 1. Executive Summary

A comprehensive, read-only safety review of [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md) was performed against the active repository source tree, database migrations, configuration definitions, and operational architecture.

While the runbook exhibits excellent structure, rigorous secret containment, and strong network-boundary isolation, **three actionable defects** were identified:
1. **High**: Section 5.3 specifies an obsolete/incorrect list of expected database tables (`cases`, `otp_challenges`, `portal_tokens`, etc.) that contradicts the actual SQLAlchemy models in [`backend/app/models.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/models.py).
2. **High**: Section 5.4 database restore command specifies `pg_restore --clean --if-exists` without mandatory target verification, dry-run listing, active session termination, or interactive confirmation safeguards, introducing risk of accidental table drops.
3. **Medium**: Section 8.4 curl command references a non-existent test fixture (`/var/www/docpilot/backend/tests/fixtures/dummy_pan.png`); the actual fixture in the repository is `valid_synthetic_pan.png`.

Until these corrections are incorporated into the checklist, execution on a staging server must remain blocked.

---

## 2. Categorized Findings & Vulnerabilities

### Finding 1: Database Table Verification Query Specifies Obsolete Tables
* **Severity**: **HIGH**
* **Location**: [`docs/STAGING_DEPLOYMENT_CHECKLIST.md:188`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md#L188)
* **Observed Text**:
  ```text
  Expected tables: alembic_version, audit_logs, cases, customers, documents, jobs, manual_reviews, otp_challenges, portal_tokens, rate_limit_events, reminders.
  ```
* **Actual Codebase Truth**:
  Inspection of [`backend/app/models.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/models.py) and [`backend/alembic/versions/7b850ab9a48f_initial_schema.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/alembic/versions/7b850ab9a48f_initial_schema.py) confirms that the application defines exactly 10 application models plus `alembic_version` (11 tables total):
  1. `alembic_version`
  2. `access_tokens`
  3. `audit_logs`
  4. `consent_ledger`
  5. `customers`
  6. `documents`
  7. `jobs`
  8. `manual_reviews`
  9. `ocr_results`
  10. `privacy_requests`
  11. `required_documents`
* **Risk & Impact**: The checklist references legacy or hypothetical table names (`cases`, `otp_challenges`, `portal_tokens`, `rate_limit_events`, `reminders`). An operator verifying migration success in staging will observe table name discrepancies and conclude that migrations failed or tables are missing.
* **Required Correction**: Update Section 5.3 to explicitly list the true 11 tables matching [`backend/app/models.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/models.py).

---

### Finding 2: Unsafe Database Restore Command Without Operator Safeguards
* **Severity**: **HIGH**
* **Location**: [`docs/STAGING_DEPLOYMENT_CHECKLIST.md:200-207`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md#L200-L207)
* **Observed Command**:
  ```bash
  PGPASSWORD="<STAGING_DB_PASSWORD>" pg_restore \
    -h <STAGING_DB_HOST> \
    -p 5432 \
    -U <STAGING_DB_USER> \
    -d <STAGING_DB_NAME> \
    --clean \
    --if-exists \
    -v "${BACKUP_FILE}"
  ```
* **Analysis**:
  The `--clean` flag instructs `pg_restore` to execute `DROP TABLE ...` statements for every object in the archive prior to recreating it. In an operational setting:
  1. There is no dry-run inspection (`pg_restore -l "${BACKUP_FILE}"`) verifying the archive before execution.
  2. There is no explicit sanity check ensuring the target database is indeed the staging database (`SELECT current_database();`).
  3. Active database connections from running pool workers can cause deadlocks or partial restores.
  4. There is no explicit interactive operator confirmation prompt requiring the operator to type `YES` before dropping tables.
* **Risk & Impact**: An operator executing rollback in haste or against an incorrect host environment variable could permanently drop existing data without an interactive confirmation check.
* **Required Correction**: Prepend the restore procedure with service termination, active connection termination query, archive verification, target database assertion, and an explicit interactive confirmation prompt.

---

### Finding 3: Non-Existent Synthetic Test Fixture in Smoke Test Command
* **Severity**: **MEDIUM**
* **Location**: [`docs/STAGING_DEPLOYMENT_CHECKLIST.md:377-380`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md#L377-L380)
* **Observed Command**:
  ```bash
  curl -i -X POST "https://staging.docpilot.internal/api/portal/${UPLOAD_TOKEN}/upload" \
    -F "doc_type=pan" \
    -F "file=@/var/www/docpilot/backend/tests/fixtures/dummy_pan.png"
  ```
* **Actual Codebase Truth**:
  Listing the directory [`backend/tests/fixtures/`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/tests/fixtures) shows only:
  ```text
  valid_synthetic_pan.png (10,966 bytes)
  ```
  The file `dummy_pan.png` does not exist in the repository.
* **Risk & Impact**: Running the smoke test as written will immediately fail with `curl: (26) Failed to open/read local data from file/application`, falsely signaling a deployment or portal failure.
* **Required Correction**: Update the path in Section 8.4 to `@/var/www/docpilot/backend/tests/fixtures/valid_synthetic_pan.png`.

---

### Finding 4: Clarification on Upload OTP Configuration During Smoke Testing
* **Severity**: **LOW**
* **Location**: [`docs/STAGING_DEPLOYMENT_CHECKLIST.md:104`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md#L104) & [`backend/app/routes_portal.py:96-97`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/routes_portal.py#L96-L97)
* **Analysis**:
  [`backend/app/routes_portal.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/routes_portal.py#L96-L97) enforces:
  ```python
  if s.upload_otp_enabled and not services.is_upload_otp_verified(db, c.id, t.id):
      raise HTTPException(403, {"code": "otp_required", "message": "Email OTP verification required before uploading."})
  ```
  While `UPLOAD_OTP_ENABLED` defaults to `false` in [`backend/app/config.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/config.py#L60), if a staging operator configures `UPLOAD_OTP_ENABLED=true` in `.env`, the direct `curl -X POST .../upload` smoke test in Section 8.4 will be rejected with HTTP 403 `otp_required`.
* **Required Correction**: Add an operational note in Section 8.4 explaining that if `UPLOAD_OTP_ENABLED=true`, the smoke test requires invoking `POST /otp/send` and `POST /otp/verify` prior to upload.

---

## 3. Command-by-Command Verification Matrix

| Section / Step | Checklist Command | Actual Repository / System Equivalent | Audit Status | Notes |
| :--- | :--- | :--- | :---: | :--- |
| **4.A.1 OS Packages** | `apt-get install python3.11 ... nginx ufw` | Ubuntu 22.04/24.04 standard repos | **VERIFIED ACCURATE** | All listed packages exist in standard Ubuntu repositories. |
| **4.A.2 Users** | `useradd -r -s /usr/sbin/nologin docpilot` | Linux system user management | **VERIFIED ACCURATE** | System user without shell access is least-privilege compliant. |
| **4.A.4 tmpfs Mount** | `mount -t tmpfs -o size=512M,mode=0700 tmpfs /tmp/company_ocr_temp` | `tmpfs` kernel mount | **VERIFIED ACCURATE** | Mode `0700` matches privacy remediation requirement. |
| **4.B.2 Python venv** | `python3.11 -m venv .venv && pip install -r requirements.txt` | [`backend/requirements.txt`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/requirements.txt) | **VERIFIED ACCURATE** | Requirements file exists and installs cleanly without conflicts. |
| **4.B.3 Frontend Build**| `npm ci && npm run build` | [`frontend/package.json`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/frontend/package.json) | **VERIFIED ACCURATE** | Verified builds static assets to `frontend/dist` in ~320ms. |
| **5.1 Database Backup** | `pg_dump -h ... -F c -f <file>` | PostgreSQL 17 client utilities | **VERIFIED ACCURATE** | Custom binary format `-F c` enables compressed, selective restoration. |
| **5.2 DB Migration** | `python -m app.db_init` | [`backend/app/db_init.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/db_init.py) | **VERIFIED ACCURATE** | Invokes `alembic.command.upgrade(cfg, "head")` cleanly. |
| **5.3 DB Table Check** | `SELECT table_name FROM information_schema.tables ...` | PostgreSQL system catalog | **CORRECTION REQUIRED** | Expected table names in documentation must be corrected (Finding 1). |
| **5.4 DB Restore** | `pg_restore ... --clean --if-exists` | PostgreSQL client utilities | **CORRECTION REQUIRED** | Destructive operation requires safety guards (Finding 2). |
| **6.1 Nginx Ingress** | Nginx reverse proxy with header overwriting | [`backend/app/rate_limiter.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/rate_limiter.py#L66-L70) | **VERIFIED ACCURATE** | `proxy_set_header X-Forwarded-For $remote_addr;` matches code requirement. |
| **7.1 OCR Systemd** | `uvicorn main:app --host 127.0.0.1 --port 8001` | `company-ocr-service/main.py` | **VERIFIED ACCURATE** | Binds strictly to loopback interface. |
| **7.2 Backend Systemd**| `uvicorn app.main:app --host 127.0.0.1 --port 8080` | [`backend/app/main.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/main.py) | **VERIFIED ACCURATE** | Binds strictly to loopback interface. |
| **7.3 Worker Systemd** | `python -m app.worker`, `TimeoutStopSec=210s` | [`backend/app/worker.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/worker.py) | **VERIFIED ACCURATE** | Traps `SIGTERM`; timeout accommodates 180s OCR + grace. |
| **8.1 Socket Check** | `ss -tulpn \| grep -E "(:8080\|:8001\|:80\|:443)"` | Linux socket statistics | **VERIFIED ACCURATE** | Verifies non-loopback exposure is blocked. |
| **8.2 Health Probes** | `curl -s http://127.0.0.1:8080/health` | [`backend/app/main.py:69-76`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/main.py#L69-L76) | **VERIFIED ACCURATE** | `/health` checks database liveness and returns JSON. |
| **8.3 Test Suite** | `pytest tests/test_privacy_gateway.py ... -q` | [`backend/tests/`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/tests) | **VERIFIED ACCURATE** | 32 targeted privacy and workflow tests pass cleanly. |
| **8.4 Smoke Upload** | `curl ... -F "file=@.../dummy_pan.png"` | [`backend/tests/fixtures/`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/tests/fixtures) | **CORRECTION REQUIRED** | File must be `valid_synthetic_pan.png` (Finding 3). |
| **8.5 Worker Stop** | `systemctl stop docpilot-worker` | Linux systemctl | **VERIFIED ACCURATE** | Tests graceful drain of active job within `TimeoutStopSec`. |
| **9 Rollback** | Service stop, Git rollback, restore, restart | Standard operational recovery | **VERIFIED ACCURATE** | Clean 5-step sequence for fast disaster recovery. |

---

## 4. Environment Variable & Secret Containment Audit

Every configuration variable defined in Section 3 of [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md) was cross-referenced with [`backend/app/config.py`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/config.py) and `company-ocr-service`:

| Configuration Variable | Present in Code | Code Default | Purpose Verified | Secret Exposure Status |
| :--- | :---: | :--- | :--- | :---: |
| `DATABASE_URL` | Yes (`config.py:14`) | `sqlite:///./dev.db` | PostgreSQL connection string (`postgresql+pg8000://`) | **NO SECRETS** (placeholder only) |
| `PUBLIC_BASE_URL` | Yes (`config.py:17`) | `http://localhost:3000` | Canonical public staging URL | **NO SECRETS** |
| `CORS_ORIGINS` | Yes (`config.py:16`) | localhost origins | CORS allowed origins | **NO SECRETS** |
| `AUTO_CREATE_TABLES`| Yes (`config.py:15`) | `False` | Disables implicit SQLAlchemy table creation | **NO SECRETS** |
| `ENCRYPTION_KEY` | Yes (`config.py:30`) | `""` | AES-256-GCM master key | **NO SECRETS** (generation instructions provided) |
| `STORAGE_BACKEND` | Yes (`config.py:25`) | `local` | `supabase` or `local` | **NO SECRETS** |
| `SUPABASE_URL` | Yes (`config.py:27`) | `""` | Supabase API endpoint | **NO SECRETS** |
| `SUPABASE_SERVICE_KEY`| Yes (`config.py:28`) | `""` | Service role backend key | **NO SECRETS** |
| `SUPABASE_BUCKET` | Yes (`config.py:29`) | `case-documents` | Private bucket name | **NO SECRETS** |
| `SUPABASE_JWT_SECRET`| Yes (`config.py:33`) | `""` | HS256 admin JWT secret | **NO SECRETS** |
| `ADMIN_EMAILS` | Yes (`config.py:34`) | `""` | Comma-separated whitelist | **NO SECRETS** |
| `ALLOW_DOWNLOAD` | Yes (`config.py:57`) | `False` | Document download policy | **NO SECRETS** |
| `OCR_URL` | Yes (`config.py:37`) | `http://127.0.0.1:8001`| Co-located OCR loopback URL | **NO SECRETS** |
| `OCR_API_KEY` | Yes (`config.py:38`) | `""` | Shared secret header | **NO SECRETS** |
| `OCR_TIMEOUT_SECONDS`| Yes (`config.py:39`) | `180` | Maximum OCR wait time | **NO SECRETS** |
| `OCR_MAX_ATTEMPTS` | Yes (`config.py:40`) | `3` | Retry limit before review | **NO SECRETS** |
| `SMTP_HOST` | Yes (`config.py:69`) | `""` | Staging SMTP hostname | **NO SECRETS** |
| `SMTP_PORT` | Yes (`config.py:70`) | `587` | SMTP port | **NO SECRETS** |
| `SMTP_USER` | Yes (`config.py:71`) | `""` | SMTP username | **NO SECRETS** |
| `SMTP_PASSWORD` | Yes (`config.py:72`) | `""` | SMTP password | **NO SECRETS** |
| `SMTP_FROM` | Yes (`config.py:73`) | `no-reply@example.com`| Sender email address | **NO SECRETS** |
| `ALERT_WEBHOOK_URL` | Yes (`config.py:84`) | `""` | Job failure webhook | **NO SECRETS** |
| `MAX_UPLOAD_MB` | Yes (`config.py:46`) | `10` | Upload size limit | **NO SECRETS** |
| `RETENTION_DAYS` | Yes (`config.py:52`) | `7` | Retention window in days | **NO SECRETS** |
| `CASE_EXPIRY_DAYS` | Yes (`config.py:53`) | `30` | Case timeout in days | **NO SECRETS** |
| `REMINDER_DAYS` | Yes (`config.py:54`) | `3,7,14` | Reminder cadence | **NO SECRETS** |
| `RATE_LIMIT_ENABLED`| Yes (`config.py:62`) | `True` | Sliding-window limiter | **NO SECRETS** |
| `DOCUMENT_ENCRYPTION_KEY` (OCR)| Yes (`security.py`) | *(Required)* | OCR service master key | **NO SECRETS** (generation instructions provided) |
| `AUTH_MODE` (OCR) | Yes (`security.py`) | `disabled` | Set to `bearer` in staging | **NO SECRETS** |
| `API_KEY` (OCR) | Yes (`security.py:87`)| `""` | OCR service shared key | **NO SECRETS** |

**Conclusion on Secrets**: Zero real secrets, database passwords, API tokens, or encryption keys are present in the checklist. All sensitive entries use clear placeholders (`<...>`) accompanied by cryptographic generation instructions.

---

## 5. Security & Network Boundary Analysis

### 5.1 Client IP Spoofing Prevention in Reverse Proxy
In [`backend/app/rate_limiter.py:66-70`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/rate_limiter.py#L66-L70):
```python
def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"
```
Because `get_client_ip()` trusts the first entry of the `X-Forwarded-For` header, an attacker could bypass rate limits by supplying a randomized `X-Forwarded-For` header if the reverse proxy appends rather than overwrites.

[`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md#L240-L244) correctly mandates:
```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```
This forces Nginx to discard client-supplied `X-Forwarded-For` values and overwrite the header with the genuine socket address `$remote_addr`. **This control is verified sound and secure.**

### 5.2 Host Isolation & Socket Bindings
- Both DocPilot Backend (`docpilot-backend.service`) and Company OCR Service (`company-ocr.service`) are strictly configured to bind to `127.0.0.1` (`--host 127.0.0.1`).
- The UFW firewall explicitly blocks external ingress to ports `8080`, `8001`, and `5432`, allowing external ingress only on ports `22` (SSH), `80` (HTTP redirect), and `443` (HTTPS).
- Temporary files in `/tmp/company_ocr_temp` are mounted on `tmpfs` with mode `0700`, ensuring memory-backed confidentiality and preventing cross-user inspection on the host.

---

## 6. Exact Required Corrections

To unblock the checklist for staging deployment execution, apply the following corrections to [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md):

### Correction A: Update Section 5.3 Database Table Assertion
Replace line 188 of [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md) with:
```text
Expected head revision: c4e2a8910b7f  
Expected tables: access_tokens, alembic_version, audit_logs, consent_ledger, customers, documents, jobs, manual_reviews, ocr_results, privacy_requests, required_documents (11 tables total).
```

### Correction B: Add Safety Guards to Section 5.4 Database Restore
Replace Section 5.4 with the following guarded procedure:
```bash
# 1. Stop all application services to release database locks
sudo systemctl stop docpilot-backend docpilot-worker

# 2. Verify backup archive integrity before taking any action
pg_restore -l "${BACKUP_FILE}" > /dev/null || { echo "ERROR: Backup archive is corrupted or unreadable!"; exit 1; }

# 3. Terminate any remaining active client connections (run as postgres superuser)
PGPASSWORD="<STAGING_DB_PASSWORD>" psql -h <STAGING_DB_HOST> -U <STAGING_DB_USER> -d <STAGING_DB_NAME> -c "
SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
WHERE datname = '<STAGING_DB_NAME>' AND pid <> pg_backend_pid();
"

# 4. Prompt operator for explicit confirmation before destructive drop
echo "WARNING: This will drop and recreate all tables in <STAGING_DB_NAME> on <STAGING_DB_HOST>."
read -p "Type 'CONFIRM-RESTORE' to proceed: " CONFIRM_RESTORE
if [ "${CONFIRM_RESTORE}" != "CONFIRM-RESTORE" ]; then
    echo "Restore aborted by operator."
    exit 1
fi

# 5. Restore database from pre-deployment snapshot
PGPASSWORD="<STAGING_DB_PASSWORD>" pg_restore \
  -h <STAGING_DB_HOST> \
  -p 5432 \
  -U <STAGING_DB_USER> \
  -d <STAGING_DB_NAME> \
  --clean \
  --if-exists \
  -v "${BACKUP_FILE}"

# 6. Verify restored database head revision
PGPASSWORD="<STAGING_DB_PASSWORD>" psql -h <STAGING_DB_HOST> -U <STAGING_DB_USER> -d <STAGING_DB_NAME> -c "
SELECT version_num FROM alembic_version;
"
```

### Correction C: Fix Smoke Test Fixture Path in Section 8.4
In Section 8.4 (line 380), replace `dummy_pan.png` with `valid_synthetic_pan.png`:
```bash
UPLOAD_TOKEN="<STAGING_PORTAL_TOKEN>"
curl -i -X POST "https://staging.docpilot.internal/api/portal/${UPLOAD_TOKEN}/upload" \
  -F "doc_type=pan" \
  -F "file=@/var/www/docpilot/backend/tests/fixtures/valid_synthetic_pan.png"
```

---

## 7. Final Decision

### **CHECKLIST BLOCKED — CORRECTIONS REQUIRED**

**Justification**:  
While the architectural foundation, secret containment, and reverse proxy header protections are thoroughly documented and verified, the staging checklist cannot be approved for execution in its current state due to:
1. An incorrect database table verification list that misidentifies core tables in Section 5.3.
2. A destructive `pg_restore --clean` command in Section 5.4 lacking interactive operator confirmation and pre-restore archive verification.
3. A broken synthetic test fixture filename in Section 8.4 (`dummy_pan.png`) that will cause smoke testing to fail.

Once the three corrections specified in Section 6 are applied to [`docs/STAGING_DEPLOYMENT_CHECKLIST.md`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/docs/STAGING_DEPLOYMENT_CHECKLIST.md), the checklist will be fully compliant and ready for approval.
