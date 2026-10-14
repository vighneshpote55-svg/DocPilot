# DocPilot 🚀

> **Enterprise Secure Customer Document Collection, Verification & Automated Retention**

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18%20%7C%2019-61DAFB.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.0+-646CFF.svg)](https://vitejs.dev/)
[![Database](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E.svg)](https://supabase.com)
[![Encryption](https://img.shields.io/badge/Security-AES--256--GCM-red.svg)](#security--privacy-invariants)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

DocPilot replaces fragile no-code workflows (such as n8n) with a production-grade, privacy-first document intake portal. Customers upload identity and business documents through an encrypted portal; the backend extracts structured data using OCR, validates with strict business rules, routes anomalies to human reviewers, schedules customer email reminders, and permanently crypto-shreds all customer files post-retention.

---

## 🏗️ System Architecture & Data Flow

```mermaid
flowchart TD
    A[Admin Staff / API] -->|1. Intake Customer| B(DocPilot Backend)
    B -->|2. Send Magic Link| C[Customer Email]
    C -->|3. View Terms| D[Consent Portal]
    D -->|4. Grant Consent| E[Upload Portal]

    subgraph Client-Side Security
        E -->|5. Validate & Upload| F[Secure API Endpoint]
    end

    subgraph Secure Backend Pipeline
        F -->|6. AES-256-GCM Encrypt| G[(Private Supabase Bucket)]
        F -->|7. Enqueue Task| H[(PostgreSQL Jobs Queue)]
        H -->|8. Dequeue Task| I[Background Worker]
        I -->|9. Stateless OCR Request| J[Company OCR Microservice]
        J -->|10. Return JSON & Mask PII| I
        I -->|11. Business Rules Check| K{Auto-Verified?}
        K -->|Yes| L[Mark Verified]
        K -->|Inconclusive / High Risk| M[Manual Review Queue]
    end

    subgraph Human-in-the-Loop
        M -->|Review via Staff Console| N[Admin Staff]
        N -->|Approve / Reject| L
    end

    subgraph Retention & Crypto-Shredding
        L -->|Case Completed| O[7-Day Retention Timer]
        O -->|Deletion Triggered| P[Delete Encrypted Files & Scrub PII]
        P -->|Append Compliance Event| Q[(Consent Audit Ledger)]
    end
```

---

## 🔒 Security & Privacy Invariants

DocPilot is engineered to adhere to strict global privacy standards (GDPR, India DPDP Act):

1. **Zero Raw PII Persistence**: Aadhaar, PAN, bank accounts, and phone numbers are never stored in plaintext or logged. All OCR outputs are masked (`XXXX-XXXX-1234`) prior to database persistence.
2. **AES-256-GCM Encryption at Rest**: Every uploaded file is encrypted with AES-256-GCM before it hits storage. The storage bucket is private; files cannot be accessed via public or permanent URLs.
3. **Ephemeral Streaming for Staff**: Administrative file inspection decrypts files on-the-fly via `GET /api/admin/documents/{id}/file` and creates an immutable audit row.
4. **Token-as-Identity**: Customer identity is established strictly via single-use, high-entropy URL tokens. Only **SHA-256 token hashes** are stored in the database.
5. **No Redis, No External Queue Dependency**: The task queue lives in the transactional PostgreSQL `jobs` table with `SKIP LOCKED` concurrency control. A single background worker process handles document jobs, automated reminders, and retention schedulers.
6. **Stateless OCR Service**: The OCR integration sends bytes and receives JSON. No files or customer records are persisted on the OCR microservice.
7. **Four Independent State Fields**: DocPilot decouples `ocr_status`, `verification_status`, `case_status`, and `file_state`. "Pending" is a derived metric, never an ambiguous static state.
8. **Crypto-Shredding & Automatic Deletion**: Once a case is completed and the retention window expires (default: 7 days), documents, OCR results, and customer records are permanently deleted.

---

## 📂 Repository Structure

```text
DocPilot/
├── backend/                       # FastAPI application & worker
│   ├── app/
│   │   ├── config.py              # Pydantic environment configuration
│   │   ├── db.py                  # SQLAlchemy engine & session management
│   │   ├── models.py              # Declarative database models
│   │   ├── ocr_client.py          # Stateless HTTP OCR adapter
│   │   ├── rules.py               # Document validation & cross-check rules
│   │   ├── services.py            # Business logic, tokens, and encryption
│   │   ├── worker.py              # Postgres-backed background worker
│   │   └── scheduler.py           # Reminders & retention expiry scheduler
│   ├── alembic/                   # Database migrations
│   ├── tests/                     # Pytest automated test suite
│   └── requirements.txt           # Python dependencies
├── frontend/                      # React + TypeScript + Vite portal
│   ├── src/
│   │   ├── pages/                 # Admin console, Consent portal, Upload portal
│   │   ├── components/            # UI components (Dropzone, Review Drawer, etc.)
│   │   └── api.ts                 # Strongly typed API client
│   └── e2e/                       # Playwright browser integration tests
├── docs/                          # Comprehensive architecture documentation
│   ├── DATABASE_SCHEMA.md         # Detailed ERD & relational specification
│   ├── SPEC.md                    # Core requirements specification
│   └── DEPLOYMENT.md              # Production deployment & hardening guide
├── schema.sql                     # Full PostgreSQL DDL database schema
└── AGENTS.md                      # Engineering principles & repository rules
```

---

## 🗄️ Database Schema

The database runs on standard PostgreSQL (optimized for Supabase).

- **Full SQL DDL**: [schema.sql](schema.sql)
- **Detailed Schema & ERD Documentation**: [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)

### Core Relational Tables
| Table | Description |
| :--- | :--- |
| `customers` | Core case entity, contact info, lifecycle and retention timers. |
| `required_documents` | Document requirements mandated per customer case. |
| `documents` | Metadata, SHA-256 hash, encryption key path, and independent states. |
| `ocr_results` | PII-masked OCR extraction output (deleted upon retention deletion). |
| `manual_reviews` | Human-in-the-loop audit queue for low-confidence documents. |
| `access_tokens` | SHA-256 hashed magic tokens for customer authentication. |
| `consent_ledger` | Append-only compliance log (survives customer deletion). |
| `privacy_requests` | Self-serve GDPR/DPDP right-to-erasure and withdrawal records. |
| `jobs` | Postgres-backed transactional task queue for background worker. |
| `audit_logs` | Immutable audit log of administrative actions (IDs only). |

---

## 🚀 Quickstart & Local Setup

### Prerequisites
- **Python 3.11+**
- **Node.js 18+** & **npm**
- **PostgreSQL 15+** or a free [Supabase](https://supabase.com) project

---

### 1. Backend Setup

```bash
cd backend

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Generate AES-256 encryption key and copy to .env
python -m app.security
cp .env.example .env

# Initialize database schema
python -m app.db_init
```

#### Configure `.env` (`backend/.env`)
```ini
DATABASE_URL=postgresql+pg8000://user:password@host:5432/postgres
PUBLIC_BASE_URL=http://localhost:5173
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
ENCRYPTION_KEY=your-generated-base64-32byte-key
SUPABASE_JWT_SECRET=your-supabase-jwt-secret
ADMIN_EMAILS=admin@yourdomain.com
OCR_URL=http://127.0.0.1:8001
OCR_API_KEY=your-ocr-integration-key
STORAGE_BACKEND=supabase           # or 'local' for offline dev
```

#### Run Services (4 Local Terminals)

| Service | Local URL / Binding | Command |
| :--- | :--- | :--- |
| **DocPilot Backend** | `http://127.0.0.1:8080` | `uvicorn app.main:app --reload --port 8080` |
| **Background Worker** | N/A (polls DB queue) | `python -m app.worker` |
| **Company OCR Microservice** | `http://127.0.0.1:8001` | `uvicorn main:app --port 8001` (in OCR repo) |
| **Frontend Dev Server** | `http://127.0.0.1:5173` | `npm run dev` (in `frontend/`) |

```bash
# Terminal 1: DocPilot FastAPI API
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8080

# Terminal 2: Background Task Worker
cd backend
source .venv/bin/activate
python -m app.worker

# Terminal 3: Company OCR Microservice
cd ../company-ocr-service
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8001

# Terminal 4: Frontend Portal
cd ../DocPilot/frontend
npm run dev
```

---

### 2. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

# Start Vite dev server
npm run dev
```

Visit the application:
- **Admin Console**: `http://localhost:5173/admin`
- **Customer Portal**: Accessed via magic links generated during intake (`/portal/:token` or `/consent/:token`).

---

## 🧪 Testing & Verification

DocPilot includes comprehensive automated tests covering unit logic, integration boundaries, security invariants, and browser workflows:

```bash
# 1. Run standard backend test suite
cd backend
./.venv/bin/pytest tests/ -q

# 2. Run focused OCR integration and auth tests
./.venv/bin/pytest tests/test_ocr_integration.py tests/test_company_ocr_integration.py tests/test_ocr_auth_security_repair.py -v

# 3. Run live E2E paired OCR pipeline tests (requires active OCR service on port 8001)
./.venv/bin/pytest tests/test_live_paired_e2e.py -m live_e2e -v

# 4. Run frontend lint & production build validation
cd ../frontend
npm run lint
npm run build

# 5. Run Playwright E2E browser tests
npm run test:e2e
```

---

## 🛠️ Troubleshooting & Operational Guide

| Issue / Error | Probable Cause | Resolution |
| :--- | :--- | :--- |
| `[Errno 111] Connection refused` in worker | OCR service not listening on expected port | Ensure OCR service is running on `127.0.0.1:8001` and verify `OCR_URL=http://127.0.0.1:8001` in `backend/.env`. |
| Worker not picking up configuration changes | `@lru_cache` on `get_settings()` | Restart the background worker (`python -m app.worker`) so it loads the updated `.env`. |
| `SSL connection error` with Supabase pooler | Missing SSL context on PostgreSQL driver | The backend uses `pg8000` with `ssl_context=True` enabled by default in `app/db.py`. Ensure the connection string uses port `5432` or session pooler `6543`. |
| `401 Unauthorized` on OCR requests | Integration key mismatch or revoked key | Pair `OCR_API_KEY` in `DocPilot/backend/.env` with the active `API_KEY` from `company-ocr-service/.env`. |
| `403 Forbidden: consent_required` | Upload accessed before customer consented | By design, customers cannot upload files until consent is recorded via `/consent/:token`. |

---

## 📡 API Reference Summary

### Admin Endpoints (Require Supabase JWT)
- `POST /api/admin/customers`: Create synthetic customer intake case.
- `GET /api/admin/customers`: List and filter active cases.
- `GET /api/admin/customers/{id}`: Customer case detail, documents, and ledger.
- `GET /api/admin/documents/{id}/file`: Ephemeral decryption stream for file viewing.
- `POST /api/admin/reviews/{id}/decision`: Approve or reject manual review item.
- `POST /api/admin/customers/{id}/delete-data`: Immediate right-to-erasure execution.

### Customer Portal Endpoints (Token-Authenticated)
- `GET /api/portal/{token}`: Fetch scoped customer checklist (first name only, masked email).
- `POST /api/portal/{token}/upload`: Upload document for a required slot.
- `GET /api/portal/{token}/documents/{doc_id}/status`: Poll document processing status.

### Public Consent & Privacy Endpoints
- `GET /api/public/consent/{token}`: Retrieve consent text and required document slots.
- `POST /api/public/consent/{token}`: Record consent grant or decline.
- `POST /api/public/privacy/{token}`: Submit customer data erasure or withdrawal request.

---

## ⚠️ Development Status & Limitations

> [!NOTE]
> **Active Development & Synthetic Data Disclaimer**:
> This codebase is under active development. The current configuration is calibrated for local and staging demonstration using **synthetic test data only**.
> - Live customer email delivery is by default routed through the in-memory outbox sink unless an authenticated SMTP server (`SMTP_HOST`) is explicitly configured.
> - Document storage defaults to local encrypted disk storage unless private Supabase Storage credentials are provided.
> - Do not deploy to public infrastructure without rotating default development JWT secrets and enforcing HTTPS across all service endpoints.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
