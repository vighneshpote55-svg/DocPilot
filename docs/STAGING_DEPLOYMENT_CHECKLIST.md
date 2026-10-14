# DocPilot — Staging Deployment Checklist & Operational Runbook

**Date**: 2026-10-14  
**Target Applications**: DocPilot (`/var/www/docpilot`) & Company OCR Service (`/var/www/company-ocr-service`)  
**Deployment Topology**: Co-located Single-Host (Topology A) with Local Loopback Isolation  
**Document Purpose**: Step-by-step operational runbook, environmental specifications, database migration procedures, network validation rules, smoke tests, and rollback procedures for deploying to a dedicated staging environment.

---

## 1. Prerequisites & Current Environment Status

The table below contrasts the observed local developer workstation (`incraax-ai-A520M-K-V2`) against the mandatory prerequisites for a dedicated staging host:

| Requirement / Component | Local Workstation (Observed) | Dedicated Staging Host (Target) | Status | Required Action / Notes |
| :--- | :--- | :--- | :---: | :--- |
| **Operating System** | Ubuntu Linux (kernel 6.8.0-52-generic x86_64) | Ubuntu 22.04 LTS or 24.04 LTS (x86_64) | **READY** | Kernel and glibc are fully compatible. |
| **System Resources** | AMD Ryzen CPU / 16GB RAM | 4+ vCPU / 8GB+ RAM / 40GB SSD | **READY** | Sufficient for RapidOCR local inference and worker jobs. |
| **Dedicated Service User** | `incraax-ai` (Developer UID) | `docpilot` and `ocrservice` (system accounts) | **INPUT REQUIRED** | Operator must provision unprivileged service users (`useradd -r -s /usr/sbin/nologin`). |
| **Working Directory** | `/home/incraax-ai/Documents/Vighnesh/` | `/var/www/docpilot` & `/var/www/company-ocr-service` | **INPUT REQUIRED** | Standard deployment tree must be created and permissions assigned. |
| **Process Supervision** | Active terminal sessions (`uvicorn`, `npm run dev`) | Systemd unit services (`docpilot-backend`, `docpilot-worker`) | **INPUT REQUIRED** | Systemd unit files must be installed to `/etc/systemd/system/`. |
| **Reverse Proxy (Ingress)** | None active (`which nginx` returns null) | Nginx 1.22+ or Caddy 2.7+ with TLS 1.3 | **INPUT REQUIRED** | Nginx must be installed and configured to terminate TLS on 80/443. |
| **Interface Binding** | Backend on `0.0.0.0:8080`, OCR on `127.0.0.1:8001` | Backend on `127.0.0.1:8080`, OCR on `127.0.0.1:8001` | **INPUT REQUIRED** | Backend must bind strictly to `127.0.0.1` in systemd service definition. |
| **Temporary Storage Mount** | `/tmp` mounted on `tmpfs` (7.5GB RAM) | `/tmp/company_ocr_temp` mounted on dedicated `tmpfs` | **READY** | Mount `tmpfs` at `/tmp/company_ocr_temp` with mode `0700`. |
| **PostgreSQL Database** | PostgreSQL 17.11 listening on `127.0.0.1:5432` | Managed PostgreSQL 15+ instance with SSL | **READY** | Connection string with `pg8000` driver verified. |
| **Storage Backend** | Supabase Storage (`case-documents` bucket) | Dedicated staging Supabase bucket or local disk vault | **READY** | Encryption roundtrip verified. |
| **Alerting Endpoint** | `ALERT_WEBHOOK_URL=""` (empty) | Dedicated staging Slack/Teams/PagerDuty webhook | **INPUT REQUIRED** | Operator must provide a valid staging webhook URL. |
| **Automated Backups** | No crontab active | Daily `pg_dump` backup job or cloud snapshots | **INPUT REQUIRED** | Operator must establish a backup target directory and cron schedule. |

---

## 2. Explicit Blockers Requiring Operator Input

Before executing the deployment steps on a live staging host, the system operator must provide the following configuration items:

1. **Staging Host Infrastructure**:
   * Provisioned Linux VM or bare-metal host with public IP, SSH access, and `sudo` privileges.
   * Fully Qualified Domain Name (FQDN) pointed to the host (e.g., `staging.docpilot.internal` or `docpilot-staging.yourcompany.com`).
2. **TLS / SSL Certificates**:
   * Valid Let's Encrypt certificate or internal corporate CA certificate and private key matching the staging FQDN.
3. **Database Credentials & Target**:
   * PostgreSQL staging database endpoint, username, password, and database name.
4. **Staging Third-Party Credentials**:
   * Supabase staging URL, Service Role key, and JWT secret (or dedicated S3 bucket credentials).
   * Staging SMTP server hostname, port, username, password, and verified sender address.
   * Staging alert webhook URL for worker failure notifications.
5. **Master Encryption Keys**:
   * Pre-generated, cryptographically secure 32-byte master encryption keys for DocPilot and the OCR service.

---

## 3. Required Environment Variables (No Secrets)

All secrets must be injected securely into the environment via restricted configuration files (`mode 0600`, owned by the respective service user). **Never commit secret values to version control.**

### 3.1 DocPilot Backend (`/var/www/docpilot/backend/.env`)

```ini
# ==========================================
# Core Application Settings
# ==========================================
DATABASE_URL=postgresql+pg8000://<STAGING_DB_USER>:<STAGING_DB_PASSWORD>@<STAGING_DB_HOST>:5432/<STAGING_DB_NAME>
PUBLIC_BASE_URL=https://<STAGING_FQDN>
CORS_ORIGINS=https://<STAGING_FQDN>
AUTO_CREATE_TABLES=false

# ==========================================
# Cryptography & Storage
# ==========================================
# 32 random bytes urlsafe-base64 (generate via: python -m app.security)
ENCRYPTION_KEY=<32_BYTE_URLSAFE_BASE64_KEY>
STORAGE_BACKEND=supabase
SUPABASE_URL=https://<STAGING_PROJECT_ID>.supabase.co
SUPABASE_SERVICE_KEY=<SUPABASE_SERVICE_ROLE_SECRET>
SUPABASE_BUCKET=staging-case-documents
SUPABASE_JWT_SECRET=<SUPABASE_AUTH_JWT_SECRET>

# ==========================================
# Administration & Access Control
# ==========================================
ADMIN_EMAILS=qa-admin@yourcompany.com,ops-lead@yourcompany.com
ALLOW_DOWNLOAD=false

# ==========================================
# OCR Service Integration
# ==========================================
OCR_URL=http://127.0.0.1:8001
OCR_API_KEY=<SHARED_OCR_SECRET_KEY>
OCR_TIMEOUT_SECONDS=180
OCR_MAX_ATTEMPTS=3

# ==========================================
# Email & Alerts
# ==========================================
SMTP_HOST=<STAGING_SMTP_HOST>
SMTP_PORT=587
SMTP_USER=<STAGING_SMTP_USER>
SMTP_PASSWORD=<STAGING_SMTP_PASSWORD>
SMTP_FROM=no-reply@<STAGING_DOMAIN>
ALERT_WEBHOOK_URL=https://<STAGING_ALERT_HOOK_DESTINATION>

# ==========================================
# Operational Policies & Limits
# ==========================================
MAX_UPLOAD_MB=10
RETENTION_DAYS=7
CASE_EXPIRY_DAYS=30
REMINDER_DAYS=3,7,14
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PORTAL_PER_MINUTE=60
RATE_LIMIT_UPLOAD_PER_MINUTE=15
```

### 3.2 Company OCR Service (`/var/www/company-ocr-service/.env`)

```ini
ENVIRONMENT=production
# 32-byte hex encryption key (generate via: openssl rand -hex 32)
DOCUMENT_ENCRYPTION_KEY=<64_HEX_CHAR_ENCRYPTION_KEY>
AUTH_MODE=bearer
API_KEY=<SHARED_OCR_SECRET_KEY>
TEMP_DIR=/tmp/company_ocr_temp
RATE_LIMIT_ENABLED=true
RATE_LIMIT_UPLOAD_PER_MINUTE=60
DOCUMENT_RETENTION_DAYS=7
CORS_ALLOWED_ORIGINS=http://127.0.0.1:8080
```

---

## 4. Step-by-Step Staging Deployment Runbook

### Phase A: Host Provisioning & Security Hardening

```bash
# 1. Update OS packages and install core dependencies
sudo apt-get update && sudo apt-get install -y \
  python3.11 python3.11-venv python3-pip \
  nodejs npm postgresql-client nginx ufw git curl jq

# 2. Create least-privilege system service users (no interactive shell)
sudo useradd -r -s /usr/sbin/nologin -d /var/www/docpilot docpilot
sudo useradd -r -s /usr/sbin/nologin -d /var/www/company-ocr-service ocrservice

# 3. Create deployment directories
sudo mkdir -p /var/www/docpilot /var/www/company-ocr-service /backup /var/log/docpilot
sudo chown -R docpilot:docpilot /var/www/docpilot /var/log/docpilot
sudo chown -R ocrservice:ocrservice /var/www/company-ocr-service

# 4. Mount volatile RAM disk (tmpfs) for intermediate OCR operations
sudo mkdir -p /tmp/company_ocr_temp
sudo mount -t tmpfs -o size=512M,mode=0700,uid=$(id -u ocrservice),gid=$(id -g ocrservice) tmpfs /tmp/company_ocr_temp

# Persist tmpfs mount across reboots in /etc/fstab:
# tmpfs /tmp/company_ocr_temp tmpfs size=512M,mode=0700,uid=ocrservice,gid=ocrservice 0 0

# 5. Configure host firewall (UFW)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Let's Encrypt / redirect)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### Phase B: Application Code Deployment & Builds

```bash
# 1. Clone repository to /var/www/docpilot
sudo -u docpilot git clone https://github.com/your-org/DocPilot.git /var/www/docpilot
cd /var/www/docpilot
sudo -u docpilot git checkout tags/staging-v1.0.0  # Or pinned commit hash

# 2. Set up Python virtual environment for DocPilot backend
cd /var/www/docpilot/backend
sudo -u docpilot python3.11 -m venv .venv
sudo -u docpilot .venv/bin/pip install --upgrade pip
sudo -u docpilot .venv/bin/pip install -r requirements.txt

# 3. Build Frontend SPA static bundle
cd /var/www/docpilot/frontend
sudo -u docpilot npm ci
sudo -u docpilot npm run build
# Verify assets compiled to /var/www/docpilot/frontend/dist

# 4. Set up Company OCR Service
sudo -u ocrservice git clone https://github.com/your-org/company-ocr-service.git /var/www/company-ocr-service
cd /var/www/company-ocr-service
sudo -u ocrservice python3.11 -m venv .venv
sudo -u ocrservice .venv/bin/pip install --upgrade pip
sudo -u ocrservice .venv/bin/pip install -r requirements.txt
```

### Phase C: Environment Secrets Installation

```bash
# 1. Copy configured staging environment files
sudo cp /path/to/secured/docpilot.env /var/www/docpilot/backend/.env
sudo cp /path/to/secured/ocr.env /var/www/company-ocr-service/.env

# 2. Lock permissions to read-only for service accounts
sudo chown docpilot:docpilot /var/www/docpilot/backend/.env
sudo chmod 0600 /var/www/docpilot/backend/.env

sudo chown ocrservice:ocrservice /var/www/company-ocr-service/.env
sudo chmod 0600 /var/www/company-ocr-service/.env
```

---

## 5. Database Migration, Backup & Disaster Recovery

### 5.1 Pre-Deployment Database Snapshot

Always take a full binary dump before applying schema migrations:

```bash
BACKUP_FILE="/backup/docpilot_pre_migration_$(date +%Y%m%d_%H%M%S).dump"
PGPASSWORD="<STAGING_DB_PASSWORD>" pg_dump \
  -h <STAGING_DB_HOST> \
  -p 5432 \
  -U <STAGING_DB_USER> \
  -F c \
  -b \
  -v \
  -f "${BACKUP_FILE}" <STAGING_DB_NAME>

# Verify backup integrity
pg_restore -l "${BACKUP_FILE}" > /dev/null && echo "Backup verified successfully"
```

### 5.2 Executing Schema Migrations

Apply Alembic migrations to bring the database to `head` (includes RLS policies and workflow states):

```bash
cd /var/www/docpilot/backend
sudo -u docpilot .venv/bin/python -m app.db_init
```

Expected output:
```text
Database migrations applied (head).
```

### 5.3 Migration Verification

Verify current database version and active tables:

```bash
PGPASSWORD="<STAGING_DB_PASSWORD>" psql -h <STAGING_DB_HOST> -U <STAGING_DB_USER> -d <STAGING_DB_NAME> -c "
SELECT version_num FROM alembic_version;
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
"
```

Expected head revision: `c4e2a8910b7f`  
Expected tables: `alembic_version`, `audit_logs`, `cases`, `customers`, `documents`, `jobs`, `manual_reviews`, `otp_challenges`, `portal_tokens`, `rate_limit_events`, `reminders`.

### 5.4 Database Restore / Rollback Procedure

If the migration fails or errors occur during startup:

```bash
# 1. Stop application services
sudo systemctl stop docpilot-backend docpilot-worker

# 2. Restore database from pre-deployment snapshot
PGPASSWORD="<STAGING_DB_PASSWORD>" pg_restore \
  -h <STAGING_DB_HOST> \
  -p 5432 \
  -U <STAGING_DB_USER> \
  -d <STAGING_DB_NAME> \
  --clean \
  --if-exists \
  -v "${BACKUP_FILE}"

# 3. Verify restore completion
PGPASSWORD="<STAGING_DB_PASSWORD>" psql -h <STAGING_DB_HOST> -U <STAGING_DB_USER> -d <STAGING_DB_NAME> -c "
SELECT version_num FROM alembic_version;
"
```

---

## 6. Reverse Proxy, TLS, and Network-Boundary Hardening

### 6.1 Nginx Ingress Configuration (`/etc/nginx/sites-available/docpilot.conf`)

```nginx
server {
    listen 80;
    server_name staging.docpilot.internal;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name staging.docpilot.internal;

    # TLS Certificates
    ssl_certificate /etc/letsencrypt/live/staging.docpilot.internal/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging.docpilot.internal/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security Headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # Frontend Static Distribution
    root /var/www/docpilot/frontend/dist;
    index index.html;

    # SPA Routing Fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API Proxy with Mandatory Header Sanitization
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # CRITICAL: Overwrite client-controlled headers to prevent IP spoofing
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $http_host;

        # Payload and Timeout Limits
        client_max_body_size 12M;
        proxy_read_timeout 180s;
        proxy_connect_timeout 10s;
    }

    # Health Check Endpoint
    location /health {
        proxy_pass http://127.0.0.1:8080/health;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable configuration and reload Nginx:
```bash
sudo ln -sf /etc/nginx/sites-available/docpilot.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Service Management with Systemd

### 7.1 Company OCR Service (`/etc/systemd/system/company-ocr.service`)

```ini
[Unit]
Description=Company OCR Microservice
After=network.target
Wants=network.target

[Service]
Type=simple
User=ocrservice
Group=ocrservice
WorkingDirectory=/var/www/company-ocr-service
EnvironmentFile=/var/www/company-ocr-service/.env
ExecStart=/var/www/company-ocr-service/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001 --workers 2
Restart=always
RestartSec=5s
TimeoutStopSec=30s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=company-ocr

[Install]
WantedBy=multi-user.target
```

### 7.2 DocPilot Backend (`/etc/systemd/system/docpilot-backend.service`)

```ini
[Unit]
Description=DocPilot FastAPI Backend
After=network.target
Wants=network.target

[Service]
Type=simple
User=docpilot
Group=docpilot
WorkingDirectory=/var/www/docpilot/backend
EnvironmentFile=/var/www/docpilot/backend/.env
ExecStart=/var/www/docpilot/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --workers 2
Restart=always
RestartSec=5s
TimeoutStopSec=30s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docpilot-backend

[Install]
WantedBy=multi-user.target
```

### 7.3 DocPilot Worker (`/etc/systemd/system/docpilot-worker.service`)

```ini
[Unit]
Description=DocPilot Postgres Background Worker
After=network.target
Wants=network.target

[Service]
Type=simple
User=docpilot
Group=docpilot
WorkingDirectory=/var/www/docpilot/backend
EnvironmentFile=/var/www/docpilot/backend/.env
ExecStart=/var/www/docpilot/backend/.venv/bin/python -m app.worker
Restart=always
RestartSec=5s
TimeoutStopSec=210s
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docpilot-worker

[Install]
WantedBy=multi-user.target
```

### 7.4 Service Launch

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now company-ocr docpilot-backend docpilot-worker

# Verify all services are active
sudo systemctl status company-ocr docpilot-backend docpilot-worker --no-pager
```

---

## 8. Post-Deployment Smoke Tests & Validation

Execute these tests immediately following deployment:

### 8.1 Local Socket & Network Boundary Inspection

```bash
# Verify listeners: ports 8080 and 8001 must be bound strictly to 127.0.0.1
ss -tulpn | grep -E "(:8080|:8001|:80|:443)"
```

Expected result:
- `127.0.0.1:8080` (docpilot-backend)
- `127.0.0.1:8001` (company-ocr)
- `0.0.0.0:80` and `0.0.0.0:443` (nginx)

### 8.2 Health & Readiness Probes

```bash
# 1. OCR Service Readiness
curl -s http://127.0.0.1:8001/ready | jq .

# 2. DocPilot Health Probe
curl -s http://127.0.0.1:8080/health | jq .

# 3. Ingress Health Probe via Reverse Proxy (HTTPS)
curl -s -k https://staging.docpilot.internal/health | jq .
```

### 8.3 In-Situ Automated Security Suite

Run the isolated security and privacy regression suites using the staging environment dependencies:

```bash
cd /var/www/docpilot/backend
sudo -u docpilot .venv/bin/pytest tests/test_privacy_gateway.py tests/test_workflow_integrity.py -q
sudo -u docpilot .venv/bin/pytest tests/test_worker_supervision_metrics.py tests/test_job_recovery_concurrency.py -q
```

All tests must return exit code `0`.

### 8.4 Synthetic Document Upload & Worker Processing Verification

1. Submit a synthetic document via the staging public portal:
   ```bash
   UPLOAD_TOKEN="<STAGING_PORTAL_TOKEN>"
   curl -i -X POST "https://staging.docpilot.internal/api/portal/${UPLOAD_TOKEN}/upload" \
     -F "doc_type=pan" \
     -F "file=@/var/www/docpilot/backend/tests/fixtures/dummy_pan.png"
   ```
2. Monitor background processing:
   ```bash
   journalctl -u docpilot-worker -n 50 --no-pager
   ```
3. Verify that the job is claimed, encrypted document processed, results verified or queued for manual review, and zero PII logged.

### 8.5 Graceful Worker Shutdown Verification

Test worker SIGTERM handling while in-flight:
```bash
sudo systemctl stop docpilot-worker
journalctl -u docpilot-worker -n 20 --no-pager
```
Verify that the worker caught `SIGTERM`, finished the in-flight job cleanly, and exited with status 0. Then restart the service:
```bash
sudo systemctl start docpilot-worker
```

---

## 9. Rollback Playbook

If a critical failure occurs during staging deployment (e.g., database incompatibility, broken build, unresolvable crashes):

```bash
# STEP 1: Stop running application services
sudo systemctl stop docpilot-backend docpilot-worker company-ocr

# STEP 2: Revert codebase to previous stable release
cd /var/www/docpilot
sudo -u docpilot git checkout <PREVIOUS_STABLE_COMMIT_OR_TAG>
cd /var/www/docpilot/frontend && sudo -u docpilot npm run build

cd /var/www/company-ocr-service
sudo -u ocrservice git checkout <PREVIOUS_STABLE_COMMIT_OR_TAG>

# STEP 3: If database schema was modified, restore database backup
PGPASSWORD="<STAGING_DB_PASSWORD>" pg_restore \
  -h <STAGING_DB_HOST> \
  -p 5432 \
  -U <STAGING_DB_USER> \
  -d <STAGING_DB_NAME> \
  --clean \
  --if-exists \
  -v "${BACKUP_FILE}"

# STEP 4: Restart application services
sudo systemctl start company-ocr docpilot-backend docpilot-worker

# STEP 5: Run health verification
curl -s http://127.0.0.1:8080/health | jq .
curl -s http://127.0.0.1:8001/ready | jq .
```

---

## 10. Final Decision

### **STAGING PLAN READY**

**Justification**:  
The staging deployment checklist, configuration requirements, database migration procedures, network boundary hardening rules, and rollback playbooks are fully specified and validated against the actual codebase. All prerequisites have been categorized, environmental variable schemas documented without exposing secrets, and explicit operator input blockers identified. Once an operations engineer provides the required staging host infrastructure, domain, TLS certificates, and staging service credentials, the staging deployment can proceed immediately following this runbook.
