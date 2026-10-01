-- Run once in the Supabase SQL editor AFTER `python -m app.db_init`.
-- Enables Row Level Security with no policies, so the public anon/authenticated API keys
-- cannot read or write any of these tables. The backend connects with the database
-- connection string (a privileged role), which is not affected.
ALTER TABLE customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE required_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_ledger      ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_reviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                ENABLE ROW LEVEL SECURITY;
