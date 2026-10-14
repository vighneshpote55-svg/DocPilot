# DocPilot + company-ocr-service — Document Privacy and Leakage Security Audit

**Date**: 2026-10-14  
**Audit Scope**: End-to-end document processing lifecycle from customer upload through AES-256-GCM storage, worker processing, OCR service extraction, database persistence, admin retrieval, and retention purge.  
**Audited Repositories**:
* **DocPilot Orchestrator**: `/home/incraax-ai/Documents/Vighnesh/DocPilot` (`HEAD: d63537da807d`)
* **Company OCR Service**: `/home/incraax-ai/Documents/Vighnesh/company-ocr-service` (`HEAD: b07bb48`, running on `127.0.0.1:8001`)

---

## 1. End-to-End Data Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer (Browser)
    participant Portal as DocPilot Portal API (:8080)
    participant Storage as Supabase Storage (Private Bucket)
    participant DB as PostgreSQL 17 (RLS Protected)
    participant Worker as DocPilot Worker Daemon
    participant OCR as Company OCR Service (:8001)
    participant RapidOCR as RapidOCR Engine (Local ONNX)
    participant Rules as Rules Engine & Privacy Gateway
    actor Admin as Staff Admin (Dashboard)

    Customer->>Portal: 1. POST /api/portal/{token}/upload (multipart file)
    Note over Portal: Token hash verified, MIME & size validated
    Portal->>Portal: 2. AES-256-GCM encrypt(data) [RAM only]
    Portal->>Storage: 3. put_file(storage_key, ciphertext)
    Portal->>DB: 4. INSERT INTO documents, INSERT INTO jobs (status='queued')
    Portal-->>Customer: 201 Created (document_id, file_state='stored')

    Worker->>DB: 5. SELECT job FOR UPDATE SKIP LOCKED (status='running')
    Worker->>Storage: 6. get_file(storage_key) [ciphertext]
    Worker->>Worker: 7. AES-256-GCM decrypt(ciphertext) [RAM only]
    Worker->>OCR: 8. POST /ocr/{doc_type} (Authorization: Bearer <API_KEY>)
    
    Note over OCR: authenticate_request() validates API_KEY
    OCR->>OCR: 9. Write temp file: /tmp/company_ocr_temp/ocr_{uuid}.ext
    OCR->>RapidOCR: 10. process_file(temp_path) [Local ONNX]
    RapidOCR-->>OCR: Extracted text & bounding boxes
    OCR->>OCR: 11. Regex extract, Verhoeff/Luhn checksums, sanitize_extracted_fields()
    OCR->>OCR: 12. finally: os.remove(temp_path) [Unlinked immediately]
    OCR-->>Worker: 13. HTTP 200 JSON (sanitized_fields, confidences) [No raw text]

    Worker->>Rules: 14. create_redacted_evidence(res) [PrivacyGateway]
    Worker->>DB: 15. INSERT INTO ocr_results (masked payload only)
    Worker->>Rules: 16. rules.evaluate(masked_payload)
    alt Rules Inconclusive & AI Enabled
        Worker->>Worker: 17. verify_ai_payload_safety(masked_payload) [Strict PII Gate]
    end
    Worker->>DB: 18. UPDATE documents SET verification_status, UPDATE jobs SET status='done'

    Admin->>Portal: 19. GET /api/admin/documents/{id}/file (require_admin JWT)
    Portal->>DB: 20. Check consent != 'withdrawn' & allow_download policy
    Portal->>Storage: 21. get_file(storage_key) & decrypt in memory
    Portal->>DB: 22. INSERT INTO audit_logs ('document_viewed')
    Portal-->>Admin: 23. Stream bytes (Cache-Control: no-store, inline)
```

---

## 2. Confirmed Controls with File Paths & Line Numbers

### A. DocPilot Orchestrator
| Control | Implementation File & Lines | Verification Evidence |
| :--- | :--- | :--- |
| **AES-256-GCM Encryption** | [`backend/app/security.py:27-37`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/security.py#L27-L37) | Uses `AESGCM(key)`. Generates 12-byte cryptographically secure random nonce (`os.urandom(12)`). Prepend nonce to ciphertext; tag appended automatically. Bit-flip tampering verified to raise `cryptography.exceptions.InvalidTag`. |
| **Key Validation Precondition** | [`backend/app/worker.py:32`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/worker.py#L32) | Invokes `security._key()` eagerly at startup before opening DB sessions or claiming jobs; exits with code `1` if invalid. |
| **Encrypted Storage Invariant** | [`backend/app/storage.py:83-89`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/storage.py#L83-L89) | `put_file()` encrypts before writing to Supabase; `get_file()` decrypts only upon read. Bucket is private; no public or signed URLs are ever generated. |
| **Zero Intermediate Disk Files** | [`backend/app/ocr_client.py:107`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/ocr_client.py#L107) | Streams in-memory `data: bytes` directly into `httpx.post(files={"file": ...})`. DocPilot never writes decrypted files to `/tmp` or disk. |
| **Privacy Gateway & Masking** | [`backend/app/pipeline.py:93-110`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/pipeline.py#L93-L110) | `create_redacted_evidence()` deterministically masks all extracted fields before writing to `ocr_results.payload`. Raw extracted text is never persisted. |
| **AI Pre-Dispatch Privacy Gate** | [`backend/app/ai_service.py:189-237`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/ai_service.py#L189-L237) | `verify_ai_payload_safety()` scans outbound payload with regexes for unmasked PAN, Aadhaar, email, phone, and account numbers. Aborts AI dispatch if raw PII is detected. |
| **Secure Admin File Streaming** | [`backend/app/routes_admin.py:653-705`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/routes_admin.py#L653-L705) | Protected by `require_admin`. Checks that consent is not withdrawn, checks `allow_download` policy, inserts audit log, streams in-memory decrypted bytes with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. |
| **Log PII Redaction** | [`backend/app/logging_conf.py:52-64`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/logging_conf.py#L52-L64) | `PiiSanitizingFilter` automatically redacts PAN, Aadhaar, phone, email, account numbers, and bearer tokens from all log output. |
| **Statutory Retention Purge** | [`backend/app/services.py:270-310`](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/backend/app/services.py#L270-L310) | `purge_customer_data()` completely deletes storage files, OCR records, documents, manual reviews, access tokens, and anonymizes customer records. |

### B. Company OCR Service
| Control | Implementation File & Lines | Verification Evidence |
| :--- | :--- | :--- |
| **Loopback Binding** | Terminal / Service process | Verified listening on `127.0.0.1:8001` (`ss -tulpn`). Not bound to public interfaces. |
| **Route Authentication Enforcement** | `company-ocr-service/security.py:264-320` | `authenticate_request()` strictly validates `API_KEY` or JWT. Tested via curl: unauthenticated requests and invalid bearer tokens return HTTP 401. |
| **Stateless Microservice Route** | `company-ocr-service/main.py:843-930` | `POST /ocr/{doc_type}` processes file without writing to database or document repository. |
| **Temp File Lifecycle & Cleanup** | `company-ocr-service/main.py:882-920` | Saves to `TEMP_DIR/ocr_{uuid}.ext`, processes via RapidOCR, and unlinks file in `finally:` block. |
| **Orphaned Temp Sweeper** | `company-ocr-service/main.py:126-152` | `sweep_orphaned_temp_files()` sweeps files older than 15 minutes. Runs on service startup and as periodic background worker every 5 minutes. |
| **PII Minimization Allowlist** | `company-ocr-service/main.py:785` | `sanitize_extracted_fields()` masks PAN, Aadhaar, account numbers, and names prior to generating response payload. |
| **Zero External AI Telemetry** | `company-ocr-service/main.py:814` | `execute_ocr_pipeline()` sets `ai_model="none"`. OCR runs 100% offline using local ONNX weights; zero outbound telemetry. |
| **Structured Log Scrubbing** | `company-ocr-service/logging_utils.py:65-120` | Formats logs as JSON and redacts PAN, Aadhaar, GSTIN, IFSC, account numbers, and encryption keys. |

---

## 3. Prioritized Security Findings

### Finding 1: Temporary Plaintext File Persistence During OCR Execution
* **Severity**: **MEDIUM**
* **Location**: `company-ocr-service/main.py:877`
* **Description**: When `DocPilot` dispatches a decrypted document to `company-ocr-service` via `POST /ocr/{doc_type}`, the OCR service writes the file to disk at `temp_path = os.path.join(TEMP_DIR, f"ocr_{uuid.uuid4()}{ext}")` (default: `/tmp/company_ocr_temp/`). While the file is unlinked in a `finally:` block and swept periodically every 5 minutes, plaintext customer documents reside on disk for the duration of OCR processing.
* **Potential Exposure & Realistic Attack Scenario**: If a worker crashes ungracefully (`SIGKILL`, OOM killer, power failure), files remain in `/tmp/company_ocr_temp/` for up to 15 minutes until the sweeper runs. On shared multi-tenant hosts or environments with world-readable `/tmp` permissions, local unprivileged users could inspect residual identity documents.
* **Remediation**:
  1. Restrict directory permissions: ensure `chmod 0700` on `TEMP_DIR`.
  2. For images and single-page PDFs, process directly in-memory via `io.BytesIO` and PyMuPDF `fitz.open(stream=file_bytes, filetype="pdf")` without touching disk.
  3. Mount `TEMP_DIR` on an in-memory `tmpfs` RAM-disk (`mount -t tmpfs -o size=256M,mode=0700 tmpfs /tmp/company_ocr_temp`).

---

### Finding 2: Unencrypted HTTP over Local Loopback
* **Severity**: **MEDIUM**
* **Location**: `DocPilot/backend/app/config.py:37` (`ocr_url = "http://127.0.0.1:8001"`)
* **Description**: DocPilot transmits decrypted document payloads to `company-ocr-service` over unencrypted HTTP. In the current single-host developer environment, traffic traverses the kernel loopback interface (`lo`), which is not exposed to the local network. However, if deployed in a distributed container architecture (e.g. separate Kubernetes pods or Docker bridge networks) without mTLS, decrypted documents would traverse virtual switches in plaintext.
* **Potential Exposure & Realistic Attack Scenario**: A compromised container or packet sniffer on an unencrypted Docker bridge network could capture decrypted customer documents in transit.
* **Remediation**:
  1. Enforce strict loopback binding (`127.0.0.1`) on the same host or pod (localhost pod sharing).
  2. If separated across network nodes, enforce HTTPS with mutual TLS (mTLS) or WireGuard VPN encryption.

---

### Finding 3: DocPilot Backend Listening on All Interfaces (`0.0.0.0:8080`)
* **Severity**: **MEDIUM**
* **Location**: Active runtime configuration (`ss -tulpn | grep 8080`)
* **Description**: DocPilot uvicorn server is bound to `0.0.0.0:8080` rather than loopback `127.0.0.1:8080`.
* **Potential Exposure & Realistic Attack Scenario**: If deployed on a network without host firewall rules, untrusted external clients could reach port 8080 directly, bypassing the reverse proxy. In this state, an attacker can supply arbitrary `X-Forwarded-For` headers to circumvent portal rate limits.
* **Remediation**: Bind uvicorn strictly to `127.0.0.1:8080` in systemd unit files and container entrypoints.

---

### Finding 4: DocPilot allow_download Policy Disabled by Default
* **Severity**: **LOW** (Informational / Defense-in-Depth)
* **Location**: `backend/app/config.py:57` (`allow_download: bool = False`), `backend/app/routes_admin.py:678`
* **Description**: When `allow_download = False`, admin staff can only view inline previews of documents; file downloads with `Content-Disposition: attachment` are rejected with HTTP 403 and audited (`document_download_denied`).
* **Assessment**: This is a strong privacy-preserving control that prevents bulk exfiltration of documents to staff workstations.

---

## 4. Verification Tests & Actual Results

### Live Automated Probes (Executed on 2026-10-14)
```
1. OCR Authentication Probes:
   - Unauthenticated POST http://127.0.0.1:8001/ocr/pan -> HTTP 401 Unauthorized [PASS]
   - Invalid Bearer POST http://127.0.0.1:8001/ocr/pan   -> HTTP 401 Unauthorized [PASS]

2. Admin Authorization Probes:
   - Unauthenticated GET http://127.0.0.1:8080/api/admin/documents/.../file -> HTTP 401 Unauthorized [PASS]

3. AES-256-GCM Tampering Verification:
   - Bit-flip tampering of ciphertext payload -> cryptography.exceptions.InvalidTag raised [PASS]

4. AI Pre-Dispatch Redaction Gate:
   - Synthetic unmasked PAN detected     -> BLOCKED (unmasked_pan_detected) [PASS]
   - Synthetic unmasked Aadhaar detected -> BLOCKED (unmasked_aadhaar_detected) [PASS]
   - Synthetic unmasked Email detected   -> BLOCKED (unmasked_email_detected) [PASS]
   - Synthetic unmasked Phone detected   -> BLOCKED (unmasked_phone_detected) [PASS]
   - Properly masked payload             -> ALLOWED (PASS) [PASS]

5. Log Redaction Verification:
   - PII strings in logs (email, phone, PAN, Aadhaar, tokens) -> All replaced with [REDACTED_*] [PASS]
```

### Automated Test Suite Results
* **DocPilot Privacy & Security Suite**:
  ```bash
  .venv/bin/pytest tests/test_privacy_gateway.py tests/test_retention_and_privacy.py tests/test_step12_e2e_privacy_verification.py tests/test_upload_storage.py tests/test_ocr_auth_security_repair.py tests/test_workflow_integrity.py -v
  ```
  **Result**: **69 passed, 1 warning in 8.26s** (Exit code: 0)

* **Company OCR Service Privacy Suite**:
  ```bash
  /home/incraax-ai/Documents/Vighnesh/company-ocr-service/.venv/bin/pytest tests/test_pii_minimise.py tests/test_production_logging.py -q
  ```
  **Result**: **23 passed, 1 skipped, 5 warnings in 10.51s** (Exit code: 0)

* **DocPilot Full Backend Regression Suite**:
  ```bash
  .venv/bin/pytest tests/ -q
  ```
  **Result**: **783 passed, 4 deselected, 1 warning in 52.44s** (Exit code: 0)

---

## 5. Unverified Assumptions & Limitations

1. **Host-Level RAM Dump Inspection**: Process memory was not inspected via external memory dump tools (`gdb`/`coredumpctl`). Process-memory confidentiality relies on OS memory isolation between Linux UIDs.
2. **Third-Party ONNX Runtimes**: RapidOCR uses pre-compiled ONNX models for text detection and recognition. While network telemetry was verified absent, the binaries themselves are vendor-supplied.
3. **Database Disk Encryption**: At-rest database page encryption depends on PostgreSQL host storage (LUKS/dm-crypt or cloud provider EBS encryption). DocPilot encrypts documents at the application layer, but PostgreSQL metadata (masked strings) relies on host-level encryption.

---

## 6. Final Audit Decision

### **NO CRITICAL/HIGH FINDINGS IN THE AUDITED SCOPE**

**Justification**:  
The end-to-end data flow strictly enforces authenticated AES-256-GCM encryption at rest, private bucket storage with zero public URLs, memory-only decrypted streaming in DocPilot, deterministic PII masking before database persistence, pre-dispatch validation preventing raw PII from reaching AI providers, and automated statutory retention deletion. Three **Medium** findings were identified (temporary disk files in the OCR service, loopback plaintext HTTP, and `0.0.0.0` interface binding), each accompanied by concrete remediation recommendations. Zero Critical or High vulnerabilities were discovered in the audited document processing path.
