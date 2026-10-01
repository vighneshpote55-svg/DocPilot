# Docpilot: project rules

Secure document collection for customers. Customers upload identity and business documents through a secure portal; the backend runs OCR, verifies with rules, queues risky cases for human review, reminds customers by email, and permanently deletes everything after a short retention period. Read `docs/SPEC.md` before any task. It is the source of truth.

## Repo layout
- `backend/`: FastAPI, SQLAlchemy, Supabase Postgres and Storage, a Postgres-backed job worker. Already built; extend it, do not rewrite it.
- `frontend/`: React + TypeScript + Vite (create in phase F1). `frontend-v1-reference/index.html` is a working single-file prototype; reuse its API calls and copy.
- `docs/`: `SPEC.md` (requirements) and `PROMPTS.md` (phase plan).

## Hard rules (never break these)
1. No n8n, no Redis. Jobs live in the Postgres `jobs` table; one worker also runs the schedulers.
2. Never log, print, store or return raw PII (Aadhaar, PAN, account numbers, phone, email, DOB, addresses, document images). OCR output is masked before it is stored. Logs and audit `details` contain IDs only.
3. Never put secrets in code, tests, logs or chat. `.env` is git-ignored. `SUPABASE_SERVICE_KEY`, `ENCRYPTION_KEY`, `SUPABASE_JWT_SECRET`, `OCR_API_KEY` live only in the backend `.env`. The frontend gets only the public Supabase anon key.
4. Documents are encrypted (AES-GCM) before they reach Storage. The bucket is private. No public or long-lived URLs. Staff view files only through `GET /api/admin/documents/{id}/file`, which streams the decrypted file and writes an audit row.
5. The backend owns storage and retention. The OCR service is stateless: send bytes, get JSON, persist nothing there.
6. The URL token is the customer identity. Never accept a customer ID from the client. Store only SHA-256 token hashes.
7. Keep four separate state fields: `ocr_status`, `verification_status`, `case_status`, `file_state`. "Pending" is derived (required minus verified), never a stored status.
8. Rules decide first. AI is off by default, runs only when rules are inconclusive, and sees masked data only. A verified result needs no AI when rules are clear and no risk flag exists.
9. Deletion must cover everything: encrypted files, OCR data, hashes, review rows, tokens. Test it.
10. Use dummy documents and dummy customers in every test. Never open real customer files.

## Conventions
- Python 3.11+, type hints, small modules in `backend/app/`. Postgres driver is `pg8000` (psycopg binaries are blocked on the developer's PC; do not switch back).
- Every new route needs an auth dependency (`require_admin` or token resolution) and a test. Return `{code, message}` errors, never stack traces.
- Frontend: TypeScript strict, no `any`, API calls in one `api.ts`, no secrets, no `dangerouslySetInnerHTML`, sentence-case copy, plain language for customers (never show internal reasons like fraud flags; show "under review").
- Accessibility: labels on all inputs, keyboard focus visible, works on a phone, supports light and dark.
- Dates are UTC in the database; format in the browser.

## Commands (Windows PowerShell)
```
cd backend
python -m venv venv ; .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.security          # prints a new ENCRYPTION_KEY
python -m app.db_init
uvicorn app.main:app --reload --port 8080
python -m app.worker            # second terminal
pytest -q
cd ../frontend ; npm install ; npm run dev
```

## How to work
- One phase at a time from `docs/PROMPTS.md`. Start each phase with a short plan, then implement.
- Run `pytest -q` (and `npm run build` for the frontend) before saying a phase is done. Report what you ran and what failed. Do not claim success on untested code.
- Ask before changing the data model, the retention defaults, or the auth approach. Record the decision in `docs/SPEC.md`.
- Do not touch the OCR service. Its contract is in `docs/SPEC.md` section 5.

## Definition of done
Tests pass, no PII or secret in output, new behaviour is in `docs/SPEC.md`, and the README commands still work from a clean checkout.
