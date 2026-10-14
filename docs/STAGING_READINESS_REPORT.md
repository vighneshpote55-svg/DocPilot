# DocPilot — Staging Readiness & Deployment Validation Report

**Date**: 2026-10-14  
**Evaluated Revision**: `bc1da26a927ed18db42800e26343dd0e1b00de9c` (`docs: increase TimeoutStopSec to 210s in deployment configuration`)  
**Audit Type**: Pre-Staging Operational Readiness & Verification  
**Evaluation Scope**: Worker process lifecycle, AES-GCM encryption, failure alerting, queue observability, reverse proxy header trust, and automated regression suite.

---

## 1. Tested Commit and Working-Tree State

* **HEAD Commit**: `bc1da26a927ed18db42800e26343dd0e1b00de9c`
* **Commit Subject**: `docs: increase TimeoutStopSec to 210s in deployment configuration`
* **Git Status**: Working tree clean (`nothing to commit, working tree clean`).
* **Git Diff Check**: `git diff --check` executed with return code `0` (clean, zero trailing whitespace or formatting defects).
* **Uncommitted Changes**: None. All previous fixes (graceful SIGTERM/SIGINT shutdown, eager key validation, queue metrics, multi-worker recovery, and systemd timeout alignment) are committed.

---

## 2. Configuration & Infrastructure Audit

| Parameter / Component | Configuration Value | Verification Method | Status | Notes |
| :--- | :--- | :--- | :---: | :--- |
| **Worker Stop Timeout** | `TimeoutStopSec=210s` | `docs/DEPLOYMENT.md:190` | **PASS** | Properly aligned to exceed `ocr_timeout_seconds=180s` + 30s grace period. |
| **Worker Kill Signal** | `KillSignal=SIGTERM` | `docs/DEPLOYMENT.md:191` | **PASS** | Worker traps `SIGTERM` and shuts down gracefully without dropping active jobs. |
| **Worker Restart Policy** | `Restart=always`, `RestartSec=5s` | `docs/DEPLOYMENT.md:188-189` | **PASS** | Throttles crash loops. |
| **Systemd Service Install** | Not installed on host (`/etc/systemd/system/docpilot*`) | File system check | **NOT VERIFIED** | Running locally via developer terminal session; systemd service is a staging deployment prerequisite. |
| **Host Interface Binding** | `0.0.0.0:8080` (active process) | `ss -tulpn` | **ACTION REQUIRED** | Staging/production must bind exclusively to `127.0.0.1:8080` behind the reverse proxy. |
| **Reverse Proxy Installation** | None active on local host | `which nginx caddy` | **NOT VERIFIED** | Reverse proxy (Nginx/Caddy) must be provisioned on staging VM before ingress traffic. |
| **Forwarded IP Header Trust** | `X-Forwarded-For` parsed directly | `app/rate_limiter.py:67-70` | **PASS (CONDITIONAL)** | Proxy **must overwrite** `X-Forwarded-For` with `$remote_addr` as documented in `DEPLOYMENT.md` to prevent IP spoofing. |

---

## 3. Encryption Configuration

* **`ENCRYPTION_KEY` Status**: Configured and valid in environment (`has_key=True`, length = 32 bytes AES-256-GCM).
* **Startup Validation**: `worker.main()` invokes `security._key()` eagerly on line 32. If unset or invalid, the process terminates immediately with exit code `1` before opening database sessions or polling queues.
* **Ciphertext Persistence & Decryptability**: Tested live against stored documents in database (`Document.file_state == "stored"`). Retained documents decrypted successfully without key mismatch.
* **Key Safety**: The key value was verified programmatically without printing or copying secrets.

---

## 4. Controlled Staging Recovery & Worker Behavior

### Observed Automated Behaviors (Synthetic Test Environment)
1. **Queued & Running Transitions**: Jobs claimed via `FOR UPDATE SKIP LOCKED`, incrementing `attempts` and committing `status = "running"`, `locked_at = utcnow()` in an isolated transaction.
2. **Graceful Worker Stop**: When `SIGTERM` or `SIGINT` is received, `_handle_shutdown` sets `_running = False`. The worker completes the in-flight `run_one()` job, commits results to `done`, and exits cleanly with code 0 (`test_graceful_shutdown_signal_handler`).
3. **Lease Expiry & Stuck Job Recovery**: If a worker terminates mid-job (simulated crash), `recover_stuck(minutes=15)` recovers jobs past the lease cutoff with exponential backoff (`30 * 2^attempts`) and clears `locked_at`.
4. **Poison-Pill Protection**: Jobs that reach `max_attempts` fail permanently and trigger `pipeline.ON_EXHAUSTED`, routing the document to `manual_review` with flag `["ocr_unavailable"]` (`test_recover_stuck_enforces_max_attempts_and_calls_on_exhausted`).
5. **Idempotency**: Retried or recovered jobs exit early if `doc.verification_status != 'not_started'`, and `_open_review` updates existing reviews instead of creating duplicates.

### Dedicated Staging Execution Prerequisites (For Live Staging Host)
Since a separate remote staging host is not yet provisioned, execute the following staging verification procedure upon deploying to the staging server:
```bash
# 1. On staging host, start background worker under systemd
sudo systemctl start docpilot-worker

# 2. Submit synthetic dummy document via portal API
PORTAL_TOKEN="<staging-upload-token>"
curl -X POST "https://staging.docpilot.internal/api/portal/${PORTAL_TOKEN}/upload" \
  -F "doc_type=pan" -F "file=@tests/fixtures/dummy_pan.png"

# 3. Verify queue metrics reflect active job
curl -H "Authorization: Bearer <staging-admin-token>" \
  https://staging.docpilot.internal/api/admin/summary | jq .queue_metrics

# 4. Issue graceful termination to worker mid-job
sudo systemctl stop docpilot-worker

# 5. Verify worker completed active job cleanly in journalctl
journalctl -u docpilot-worker -n 50 --no-pager
```

---

## 5. Failure Alerting Verification

* **Configuration**: `alert_webhook_url` defaults to `""` in local environment.
* **Payload Verification**: Verified that `alert_failed_job()` generates JSON payloads containing only `job_id`, `kind`, `attempts`, `max_attempts`, and truncated `error`. **Zero customer PII or raw document bytes are emitted.**
* **Resilience to Unreachable Endpoints**: Tested against an unreachable local endpoint (`http://127.0.0.1:19999/unreachable_alert_test`). The connection refusal was caught and logged within `0.06s` without raising an uncaught exception or crashing the worker process.
* **Production / Staging Precondition**: Set `ALERT_WEBHOOK_URL="https://alerts.internal.company.com/docpilot"` in the staging `/var/www/docpilot/backend/.env`.

---

## 6. Fresh Test Execution & Results

Every test command was executed freshly on revision `bc1da26`:

```
Targeted Worker Supervision & Concurrency Suite:
.venv/bin/pytest tests/test_worker_supervision_metrics.py tests/test_job_recovery_concurrency.py tests/test_workflow_integrity.py -v
--> 30 passed in 6.06s (Exit code: 0)

Full Backend Regression Suite:
.venv/bin/pytest tests/ -q
--> 783 passed, 4 deselected, 1 warning in 52.05s (Exit code: 0)

Frontend Production Build:
PATH="/home/incraax-ai/.local/node/bin:$PATH" npm run build
--> built in 307ms (Exit code: 0)

Git Diff Formatting Check:
git diff --check
--> Exit code: 0 (clean)
```

### Verification Categories
- **Live Database Checks**: Verified multi-worker concurrency locking (`FOR UPDATE SKIP LOCKED`), transaction boundaries, and PostgreSQL 17.11 RLS isolation.
- **Automated Tests**: 783 unit, integration, and security tests passing.
- **Mocked Checks**: External OCR HTTP service and AI endpoints mocked via `FakeOCR` / deterministic stubs to prevent live third-party dependencies during testing.
- **Untested Operational Scenarios**: Live remote webhook delivery to an external operations sink (requires staging webhook endpoint).

---

## 7. Remaining Risks & Remediation Steps

1. **Direct Backend Exposure**:
   - *Risk*: Backend currently running locally with `--host 0.0.0.0`. In staging, if the port is not bound to `127.0.0.1`, untrusted external requests can bypass the reverse proxy.
   - *Remediation*: Ensure the staging systemd unit executes uvicorn with `--host 127.0.0.1 --port 8080`.
2. **Reverse Proxy Header Sanitization**:
   - *Risk*: `get_client_ip()` trusts `X-Forwarded-For`.
   - *Remediation*: The staging Nginx/Caddy proxy configuration must explicitly set `proxy_set_header X-Forwarded-For $remote_addr;` to prevent rate limit spoofing.
3. **Webhook Alert Destination**:
   - *Risk*: Without `ALERT_WEBHOOK_URL`, job failures only produce stdout logs.
   - *Remediation*: Provide a valid webhook URL in staging `.env`.

---

## 8. Final Decision

### **READY FOR CONTROLLED STAGING**

**Justification**: The core application logic, worker signal supervision, eager key validation, queue observability metrics, crash recovery, and multi-worker concurrency mechanisms are fully implemented, verified, and backed by 783 passing automated tests. All configuration prerequisites for staging are identified and documented. Deployment to a controlled staging environment may proceed following the staging deployment checklist.
