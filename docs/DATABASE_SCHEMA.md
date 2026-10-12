# DocPilot Database Architecture & Schema Specification

This document provides a comprehensive technical overview of the DocPilot relational database schema, state machines, entity relationships, and data protection policies.

The full executable PostgreSQL / Supabase DDL script is located in [schema.sql](file:///home/incraax-ai/Documents/Vighnesh/DocPilot/schema.sql).

---

## 1. Entity-Relationship Diagram (ERD)

```mermaid
erDiagram
    CUSTOMERS ||--o{ REQUIRED_DOCUMENTS : "mandates"
    CUSTOMERS ||--o{ DOCUMENTS : "uploads"
    CUSTOMERS ||--o{ ACCESS_TOKENS : "authenticated by"
    CUSTOMERS ||--o{ CONSENT_LEDGER : "logs consent"
    CUSTOMERS ||--o{ PRIVACY_REQUESTS : "initiates"
    DOCUMENTS ||--o| OCR_RESULTS : "extracts into"
    DOCUMENTS ||--o| MANUAL_REVIEWS : "escalates to"
    DOCUMENTS ||--o| REQUIRED_DOCUMENTS : "fulfills"

    CUSTOMERS {
        int id PK "Auto-increment primary key (CUS-000001)"
        string name "Customer full name"
        string email "Primary contact email (indexed)"
        string mobile "Mobile phone number (optional)"
        string consent_status "pending | granted | declined | withdrawn"
        string case_status "awaiting_consent | in_progress | completed | expired | consent_declined | consent_withdrawn | deleted"
        string workflow_state "NOT_STARTED | IN_PROGRESS | VERIFIED | COMPLETED | REJECTED"
        datetime created_at "Case creation timestamp (UTC)"
        datetime consent_at "Consent grant timestamp"
        datetime completed_at "Case completion timestamp"
        datetime case_expires_at "Deadline for customer upload"
        datetime delete_after "Retention expiration timestamp"
        datetime data_deleted_at "Purge execution timestamp"
        int last_reminder_stage "Reminder cadence tracking (3, 7, 14 days)"
    }

    REQUIRED_DOCUMENTS {
        string id PK "UUID"
        int customer_id FK "References customers.id"
        string doc_type "e.g. pan, aadhaar, bank_statement"
        string verified_document_id "Reference to verified document"
    }

    DOCUMENTS {
        string id PK "UUID"
        int customer_id FK "References customers.id"
        string doc_type "Slot type (pan, aadhaar, etc.)"
        string filename "Sanitized original filename"
        string mime "MIME content type"
        int size "File size in bytes"
        string sha256 "SHA-256 integrity hash"
        string storage_key "Encrypted storage path in private bucket"
        string ocr_status "waiting | processing | completed | failed"
        string verification_status "not_started | verified | rejected | manual_review"
        string file_state "stored | deleted"
        boolean superseded "True if customer uploaded replacement"
        string workflow_state "UPLOADED | IN_REVIEW | VERIFIED | REJECTED"
        jsonb flags "Risk flags from OCR and rules engine"
        string reason "Customer-safe summary of review state"
        float confidence "Overall OCR confidence score"
        datetime created_at "Upload timestamp (UTC)"
        datetime processed_at "OCR completion timestamp"
    }

    OCR_RESULTS {
        string id PK "UUID"
        string document_id FK "Unique 1:1 with documents.id"
        jsonb payload "PII-masked OCR payload"
        datetime created_at "Extraction timestamp (UTC)"
    }

    MANUAL_REVIEWS {
        string id PK "UUID"
        string document_id FK "References documents.id"
        int customer_id "Customer ID reference"
        string reason "Internal trigger rationale"
        jsonb flags "Risk triggers and rule discrepancies"
        string status "open | approved | rejected"
        string decided_by "Reviewer staff email"
        datetime decided_at "Decision timestamp"
        string note "Reviewer remarks"
        datetime created_at "Queue timestamp (UTC)"
    }

    ACCESS_TOKENS {
        string id PK "UUID"
        int customer_id "Scoped customer reference"
        string purpose "consent | upload | privacy"
        string token_hash "SHA-256 hash of plaintext token (indexed)"
        string ref_id "Optional document or session identifier"
        datetime expires_at "Token TTL expiration (UTC)"
        datetime used_at "Single-use redemption timestamp"
        boolean revoked "Immediate invalidation flag"
        datetime created_at "Issuance timestamp (UTC)"
    }

    CONSENT_LEDGER {
        string id PK "UUID"
        int customer_id "Survives customer deletion for audit"
        string event "granted | declined | withdrawn | deleted"
        datetime created_at "Audit timestamp (UTC)"
    }

    PRIVACY_REQUESTS {
        string id PK "UUID"
        int customer_id "Customer reference"
        string action "delete | withdraw"
        string status "verification_pending | completed | rejected"
        datetime created_at "Request timestamp (UTC)"
        datetime completed_at "Execution timestamp"
    }

    JOBS {
        int id PK "Job queue ID"
        string kind "process_document | send_reminder | purge_retention"
        jsonb payload "Job parameters (IDs only)"
        string status "queued | running | done | failed"
        int attempts "Attempt counter"
        int max_attempts "Maximum retry budget"
        datetime run_at "Scheduled execution timestamp"
        datetime locked_at "Worker concurrency lock"
        string last_error "Error diagnostic snippet"
        datetime created_at "Enqueued timestamp (UTC)"
    }

    AUDIT_LOGS {
        int id PK "Audit entry ID"
        datetime created_at "Event timestamp (UTC)"
        string actor "Staff email or system agent"
        string action "Specific operation name"
        string entity_type "customers | documents | manual_reviews"
        string entity_id "Entity identifier"
        jsonb details "Contextual metadata (IDs only, NO PII)"
    }
```

---

## 2. Core Architectural Principles

### 2.1 Four Independent State Engines
DocPilot maintains four explicit, decoupled state fields instead of combining disparate lifecycle concepts:
1. `ocr_status` (`documents.ocr_status`): Tracks raw extraction (`waiting` -> `processing` -> `completed` / `failed`).
2. `verification_status` (`documents.verification_status`): Evaluated by business rules and manual review (`not_started` -> `verified` / `rejected` / `manual_review`).
3. `case_status` (`customers.case_status`): Tracks customer lifecycle (`awaiting_consent` -> `in_progress` -> `completed` -> `expired` -> `deleted`).
4. `file_state` (`documents.file_state`): Physical storage status (`stored` -> `deleted`).

> [!NOTE]
> **Pending Status is Derived**: "Pending" is never stored in the database. A customer's pending items are dynamically calculated as required documents lacking a valid `verified_document_id`.

### 2.2 Token-as-Identity Security
* Customer portal authentication does **not** rely on passwords or sessions.
* Instead, customers access portals using cryptographically random URL tokens.
* Only the **SHA-256 hash** of the token is stored in `access_tokens`.
* Tokens are scoped by purpose (`consent`, `upload`, `privacy`) and expire automatically.

### 2.3 Strict Data Minimization & Crypto-Shredding
* Document bytes are **AES-256-GCM encrypted** before being written to Supabase private storage.
* `ocr_results.payload` contains **only PII-masked data** (e.g., `XXXX-XXXX-1234`).
* When a case reaches retention expiry (`delete_after`) or upon right-to-erasure:
  1. The encrypted storage file is deleted.
  2. The `ocr_results` rows are purged.
  3. The `access_tokens` rows are removed.
  4. The `customers` record is scrubbed of name, email, and mobile.
  5. The `consent_ledger` preserves an anonymous compliance audit record.

---

## 3. Database Indexes

To maintain sub-10ms query times at scale, the following strategic B-tree indexes are enforced:

| Table | Index Column(s) | Optimization Goal |
| :--- | :--- | :--- |
| `customers` | `email` | Rapid deduplication check during intake |
| `customers` | `consent_status` | Filter awaiting vs granted customers |
| `customers` | `case_status` | Dashboard aggregations & status counts |
| `customers` | `workflow_state` | High-level operations pipeline filtering |
| `customers` | `delete_after` | Worker retention purge sweep query |
| `required_documents` | `customer_id` | Customer required slots lookup |
| `documents` | `customer_id` | Fetching documents for a customer case |
| `documents` | `workflow_state` | Admin review and intake queue filtering |
| `access_tokens` | `token_hash` (UNIQUE) | Constant-time magic link verification |
| `access_tokens` | `customer_id` | Invalidating old tokens on new issuance |
| `manual_reviews` | `customer_id`, `document_id` | Review drawer lookup and staff resolution |
| `jobs` | `status`, `run_at` | Worker `SKIP LOCKED` job polling query |
| `audit_logs` | `created_at` | Chronological audit trail pagination |

---

## 4. Setup in Supabase / PostgreSQL

To initialize this schema:
1. **Via Standalone DDL Script**:
   Execute `schema.sql` directly in your PostgreSQL client (`psql`) or Supabase SQL Editor.
2. **Row Level Security (RLS) & Policies**:
   RLS is enabled and forced on all 10 application tables. Least-privilege policies grant administrative access to `service_role` and `postgres`, while non-privileged client roles (`anon` and `authenticated`) have no permissive policies (DENY ALL by default). This locks out unauthorized public queries via PostgREST and anon client keys.
3. **Privileged Backend Connection**:
   The DocPilot FastAPI backend connects via the privileged connection string (Session Pooler) to execute authorized operations under the `service_role` / `postgres` role.

---

## 5. Migrations as Source of Truth

The version-controlled source of truth for all schema modifications is the Alembic migration history located in `backend/alembic/versions/`:
- `7b850ab9a48f_initial_schema.py`: Initial schema definition creating all 10 core tables, foreign keys, and primary indexes.
- `07648b259a0d_add_workflow_state.py`: Addition of operational `workflow_state` columns on `customers` and `documents`.
- `c4e2a8910b7f_enable_rls_and_policies.py`: Forward-only migration enabling and forcing Row Level Security (RLS) across all 10 application tables with explicit least-privilege policies for `service_role` and `postgres`.

### Managing Migrations

```bash
cd backend
source .venv/bin/activate

# Apply migrations up to head (recommended)
python -m app.db_init
# or directly via Alembic CLI:
alembic upgrade head

# Check current revision status
alembic current

# Create a new migration after updating app/models.py
alembic revision --autogenerate -m "description_of_change"
```
