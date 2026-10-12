-- ==============================================================================
-- DocPilot Database Schema Export
-- Target: PostgreSQL 15+ / Supabase
-- Description: Standalone DDL export for fresh database setups.
-- Source of Truth: Alembic migrations located in backend/alembic/versions/
--                  (7b850ab9a48f_initial_schema.py, 07648b259a0d_add_workflow_state.py)
-- Runtime Execution: 'python -m app.db_init' or 'alembic upgrade head'
-- ==============================================================================

-- 0. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. Customers Table
-- Stores case intake information and lifecycle states.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(320) NOT NULL,
    mobile VARCHAR(32),
    
    -- Consent State: pending | granted | declined | withdrawn
    consent_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    
    -- Case State: awaiting_consent | in_progress | completed | expired | consent_declined | consent_withdrawn | deleted
    case_status VARCHAR(24) NOT NULL DEFAULT 'awaiting_consent',
    
    -- High-level Workflow State: NOT_STARTED | AWAITING_DOCUMENTS | IN_REVIEW | VERIFIED | COMPLETED | REJECTED
    workflow_state VARCHAR(30) NOT NULL DEFAULT 'NOT_STARTED',
    
    -- Timestamps (all UTC)
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    consent_at TIMESTAMP WITHOUT TIME ZONE,
    completed_at TIMESTAMP WITHOUT TIME ZONE,
    case_expires_at TIMESTAMP WITHOUT TIME ZONE,
    delete_after TIMESTAMP WITHOUT TIME ZONE,
    data_deleted_at TIMESTAMP WITHOUT TIME ZONE,
    last_reminder_stage INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS ix_customers_consent_status ON customers(consent_status);
CREATE INDEX IF NOT EXISTS ix_customers_case_status ON customers(case_status);
CREATE INDEX IF NOT EXISTS ix_customers_workflow_state ON customers(workflow_state);
CREATE INDEX IF NOT EXISTS ix_customers_delete_after ON customers(delete_after);

-- ------------------------------------------------------------------------------
-- 2. Required Documents Table
-- Maps which document types a customer must provide.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS required_documents (
    id VARCHAR(36) PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    doc_type VARCHAR(40) NOT NULL,
    verified_document_id VARCHAR(36),
    CONSTRAINT uq_customer_doctype UNIQUE (customer_id, doc_type)
);

CREATE INDEX IF NOT EXISTS ix_required_documents_customer_id ON required_documents(customer_id);

-- ------------------------------------------------------------------------------
-- 3. Consent Ledger Table
-- Append-only ledger of consent changes.
-- Note: customer_id does not have a foreign key so records survive customer
-- deletion for regulatory compliance without storing any PII.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_ledger (
    id VARCHAR(36) PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    event VARCHAR(20) NOT NULL, -- granted | declined | withdrawn | deleted
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS ix_consent_ledger_customer_id ON consent_ledger(customer_id);

-- ------------------------------------------------------------------------------
-- 4. Access Tokens Table
-- Ephemeral magic tokens for customer authentication.
-- Only the SHA-256 hash of the token is persisted.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_tokens (
    id VARCHAR(36) PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    purpose VARCHAR(20) NOT NULL, -- consent | upload | privacy
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    ref_id VARCHAR(36),
    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    used_at TIMESTAMP WITHOUT TIME ZONE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS ix_access_tokens_customer_id ON access_tokens(customer_id);
CREATE INDEX IF NOT EXISTS ix_access_tokens_token_hash ON access_tokens(token_hash);

-- ------------------------------------------------------------------------------
-- 5. Documents Table
-- Uploaded files metadata, encryption reference, and independent statuses.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(36) PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    doc_type VARCHAR(40) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime VARCHAR(100) NOT NULL,
    size INTEGER NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    storage_key VARCHAR(200) NOT NULL,
    
    -- Processing state: waiting | processing | completed | failed
    ocr_status VARCHAR(12) NOT NULL DEFAULT 'waiting',
    
    -- Rule verification state: not_started | verified | rejected | manual_review
    verification_status VARCHAR(14) NOT NULL DEFAULT 'not_started',
    
    -- Physical storage state: stored | deleted
    file_state VARCHAR(10) NOT NULL DEFAULT 'stored',
    
    superseded BOOLEAN NOT NULL DEFAULT FALSE,
    workflow_state VARCHAR(30) NOT NULL DEFAULT 'UPLOADED',
    flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    reason TEXT,
    confidence DOUBLE PRECISION,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    processed_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX IF NOT EXISTS ix_documents_customer_id ON documents(customer_id);
CREATE INDEX IF NOT EXISTS ix_documents_workflow_state ON documents(workflow_state);

-- ------------------------------------------------------------------------------
-- 6. OCR Results Table
-- Stateless OCR payload storage. Contains ONLY masked PII.
-- Crypto-shredded and deleted with the customer retention schedule.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_results (
    id VARCHAR(36) PRIMARY KEY,
    document_id VARCHAR(36) NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

-- ------------------------------------------------------------------------------
-- 7. Manual Reviews Table
-- Human-in-the-loop review queue for low-confidence or high-risk documents.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_reviews (
    id VARCHAR(36) PRIMARY KEY,
    document_id VARCHAR(36) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL,
    reason TEXT,
    flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(10) NOT NULL DEFAULT 'open', -- open | approved | rejected
    decided_by VARCHAR(320),
    decided_at TIMESTAMP WITHOUT TIME ZONE,
    note TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS ix_manual_reviews_customer_id ON manual_reviews(customer_id);
CREATE INDEX IF NOT EXISTS ix_manual_reviews_document_id ON manual_reviews(document_id);

-- ------------------------------------------------------------------------------
-- 8. Privacy Requests Table
-- Tracks GDPR / DPDP right-to-erasure and consent withdrawal requests.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_requests (
    id VARCHAR(36) PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    action VARCHAR(10) NOT NULL, -- delete | withdraw
    status VARCHAR(24) NOT NULL DEFAULT 'verification_pending',
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    completed_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX IF NOT EXISTS ix_privacy_requests_customer_id ON privacy_requests(customer_id);

-- ------------------------------------------------------------------------------
-- 9. Audit Logs Table
-- Immutable activity log. Details contain ONLY opaque IDs (no PII or secrets).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    actor VARCHAR(320) NOT NULL,
    action VARCHAR(60) NOT NULL,
    entity_type VARCHAR(30),
    entity_id VARCHAR(64),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs(created_at);

-- ------------------------------------------------------------------------------
-- 10. Jobs Table
-- Database-backed transactional job queue (replaces Redis / Celery).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(40) NOT NULL, -- e.g. process_document, send_reminder, purge_retention
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(10) NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    run_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
    locked_at TIMESTAMP WITHOUT TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS ix_jobs_run_at ON jobs(run_at);

-- ------------------------------------------------------------------------------
-- 11. Security & Row Level Security (RLS)
-- Enables RLS across all tables with no open public policies.
-- This ensures public anon / authenticated client keys cannot access or leak
-- customer data directly. The backend connects securely using the service role.
-- ------------------------------------------------------------------------------
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE required_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_reviews     ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs               ENABLE ROW LEVEL SECURITY;
