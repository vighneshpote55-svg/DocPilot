# Prompts for Antigravity

## Setup (once)
1. Unzip the kit and open the `docpilot-antigravity-kit` folder in Antigravity as the workspace.
2. `AGENTS.md` is in the root. Antigravity reads rules from `AGENTS.md`, with a limit of 12,000 characters per rules file (this one is under it). Check the Rules panel shows it as active.
3. Create a **new** Supabase project for this app (not the OCR app's project): private bucket `case-documents`, session-pooler `DATABASE_URL`, `service_role` key, JWT secret, and your admin user.
4. In `backend/`, copy `.env.example` to `.env` and fill it. Do not paste `.env` into the agent chat.
5. Give each phase to one agent at a time. Run a second agent in parallel only after phase B3 is done, so the frontend builds against a stable API.

Start every prompt with: "Read AGENTS.md and docs/SPEC.md first. Plan briefly, then implement. Run the tests and report the real results."

---

## Backend

**B0: get it running.**
"The backend is in `backend/`. The Postgres driver is already `pg8000`. Help me run `python -m app.db_init`, then apply `supabase_rls.sql`, then start the API and worker. If anything fails, diagnose from the error and fix the code or tell me the exact `.env` change. Done when `/health` returns ok and the tables exist in Supabase."

**B1: smoke test.**
"Write `backend/scripts/smoke_test.py`: create a dummy customer directly through the service layer, record consent, upload a generated dummy PAN image, run the worker once against my OCR service, and print the outcome. Verify the encrypted object exists in Supabase Storage and decrypts back to the same bytes. Then upload the same image into the Aadhaar slot and confirm it is rejected. Fix any Storage bug found. No real documents."

**B2: all 13 document types.**
"Read my OCR service's responses for each document type (I will paste one dummy response per type). Fill `REQUIRED_FIELDS` in `app/rules.py` and `OCR_TYPE_NAMES` in `app/doc_types.py`, map every OCR status and reason code to a risk flag, and add one passing and one failing test per type. Do not rely on confidence alone."

**B3: admin completeness.**
"Add: admin close-case and delete-customer-data routes (audited), customer search and pagination, and an admin 'mark file deleted' action. Every route needs `require_admin` and a test. Update `docs/SPEC.md` section 6."

**B4: security.**
"Add rate limiting on the portal, consent, and privacy routes; magic-byte file validation; an optional email OTP before upload (setting `UPLOAD_OTP_ENABLED`); and admin auth through Supabase JWKS so the legacy HS256 secret is not needed. Add tests for forwarded-link abuse and expired tokens."

**B5: migrations and ops.**
"Replace `create_all` with Alembic migrations and an initial migration matching the current models. Add structured logs with no PII and an alert hook for failed jobs. Add a Dockerfile target for the worker. Document SMTP setup and test the three emails (consent, upload link, reminder)."

**B6: lifecycle proof.**
"Write an integration test with a fake clock that walks a case through reminders at 3, 7, 14 days, expiry at 30 days, completion, retention at 7 days, and deletion. Assert Storage, OCR data, hashes, and tokens are all gone afterward."

---

## Frontend

**F1: scaffold.**
"Create `frontend/` with React, TypeScript (strict), Vite, and React Router. Use `frontend-v1-reference/index.html` as the behaviour reference for API calls. Create `src/api.ts` (one place for fetch, base URL from `VITE_API_URL`, errors mapped to plain messages) and an `.env.example` with `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Done when `npm run build` passes."

**F2: customer pages.**
"Build the consent page, the upload portal, and the privacy pages per SPEC section 7. One card per document with its own upload, a progress bar, polling after upload, and clear closed, completed, and expired-link states. Plain language only. Mobile first, light and dark, keyboard accessible."

**F3: admin.**
"Build the staff area per SPEC section 7: sign in with Supabase email and password, summary, customer list with search, add-customer form, customer page with the Documents tab and Secure View (fetch with the token, open as a blob), review queue with approve and reject notes, audit log. Show no raw PII and no internal risk flags to customers."

**F4: end-to-end test.**
"Add Playwright tests for the acceptance list in SPEC section 8 that apply to the UI (items 1 to 3, 4, 6, 7). Use dummy documents only."

---

## Final check
"Run all tests, then go through `docs/SPEC.md` section 8 item by item and tell me which are proven by a test and which are not."
