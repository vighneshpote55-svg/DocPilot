# DocPilot — Production Deployment & Reverse Proxy Guide

This document outlines the deployment configuration, reverse proxy setup, header sanitization rules, and environment prerequisites for deploying DocPilot to a production environment.

---

## 1. Architecture Overview

In production, DocPilot runs as two internal services behind an SSL/TLS-terminating reverse proxy (e.g., Nginx, Caddy, or Cloudflare):
- **FastAPI API Backend**: Listening locally on port `8080`.
- **Postgres Job Worker**: Background daemon running `python -m app.worker`.
- **Frontend SPA**: Pre-built static bundle (`frontend/dist/`) served directly by the reverse proxy or a CDN.
- **External OCR Service**: Stateless internal OCR microservice on port `8001`.

```
[Client / Browser]
        │ HTTPS (443)
        ▼
[Nginx / Caddy / Cloudflare] ──(TLS Termination & Header Sanitization)
        │
        ├── /api/*  ──────> http://127.0.0.1:8080 (FastAPI Backend)
        └── /*      ──────> /var/www/docpilot/frontend/dist (Static SPA)
```

---

## 2. Reverse Proxy Configuration & Header Sanitization

> [!IMPORTANT]
> **Client IP Spoofing Prevention**: The reverse proxy **must sanitize** incoming `X-Forwarded-For` and `X-Forwarded-Proto` headers by overwriting them with the actual client remote address `$remote_addr` and the connection scheme. Failing to overwrite `X-Forwarded-For` allows malicious clients to spoof IPs and evade rate limiting.

### Recommended Nginx Configuration

```nginx
server {
    listen 80;
    server_name docpilot.yourcompany.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name docpilot.yourcompany.com;

    # SSL / TLS Configuration
    ssl_certificate /etc/letsencrypt/live/docpilot.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/docpilot.yourcompany.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Frontend Static Files
    root /var/www/docpilot/frontend/dist;
    index index.html;

    # Gzip Compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml image/svg+xml;

    # SPA Client Routing Fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API Proxy with Strict Header Sanitization
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # CRITICAL: Overwrite client-supplied headers to prevent IP spoofing
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $http_host;

        # Upload Buffering and Timeout Limits
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

### Caddy Alternative

```caddy
docpilot.yourcompany.com {
    # Automatic HTTPS via Let's Encrypt

    # Frontend Static Distribution
    root * /var/www/docpilot/frontend/dist
    file_server
    try_files {path} /index.html

    # Backend API Proxy
    handle /api/* {
        reverse_proxy http://127.0.0.1:8080 {
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }
}
```

---

## 3. Environment Variables (`backend/.env`)

Ensure the following variables are configured on the production host:

| Variable | Description | Example / Note |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/docpilot` (driver: `pg8000`) |
| `PUBLIC_BASE_URL` | Canonical public HTTPS base URL | `https://docpilot.yourcompany.com` (**Must not be localhost**) |
| `ENCRYPTION_KEY` | AES-256-GCM master key | 32 random bytes urlsafe-base64 (`python -m app.security`) |
| `STORAGE_BACKEND` | Storage target (`local` or `supabase`) | `supabase` (or `local` if persistent disk) |
| `SUPABASE_URL` | Supabase API endpoint | `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service-role secret | Private backend secret (never expose to client) |
| `SUPABASE_JWT_SECRET` | Supabase auth signing secret | Required for HS256 admin JWT verification |
| `ADMIN_EMAILS` | Comma-separated admin whitelist | `admin@yourcompany.com,ops@yourcompany.com` |
| `SMTP_HOST` | Transactional email SMTP host | `smtp.resend.com` or `smtp.sendgrid.net` |
| `SMTP_PORT` | SMTP port | `587` (STARTTLS) or `465` (SSL) |
| `SMTP_USER` | SMTP username | `apikey` |
| `SMTP_PASSWORD` | SMTP password / API token | Secret SMTP key |
| `SMTP_FROM` | Verified sender address | `support@yourcompany.com` |
| `OCR_URL` | Internal OCR service URL | `http://127.0.0.1:8001` |
| `MAX_UPLOAD_MB` | Maximum single-file upload size | `10` |
| `RETENTION_DAYS` | Statutory automated purge window | `7` |

---

## 4. DNS & Email Authentication Checklist

To ensure transactional consent requests and reminder emails reach customer inboxes:
- [ ] **SPF Record**: `v=spf1 include:<smtp-provider.com> ~all`
- [ ] **DKIM Record**: Add CNAME or TXT record provided by SMTP provider.
- [ ] **DMARC Record**: `v=DMARC1; p=reject; rua=mailto:dmarc-reports@yourcompany.com`

---

## 5. Service Management (Systemd Example)

### Backend API (`/etc/systemd/system/docpilot-backend.service`)
```ini
[Unit]
Description=DocPilot FastAPI Backend
After=network.target postgresql.service
Wants=postgresql.service

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

### Background Worker (`/etc/systemd/system/docpilot-worker.service`)
```ini
[Unit]
Description=DocPilot Postgres Background Worker
After=network.target postgresql.service
Wants=postgresql.service

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
