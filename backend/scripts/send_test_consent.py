"""
Safe CLI script for verifying SMTP email dispatch and consent link generation.
Usage:
  python -m scripts.send_test_consent --email your_email@example.com --name "Test User"
  python -m scripts.send_test_consent --email your_email@example.com --probe-only

Features:
- Never sends emails to real customers (strictly uses the user-provided test email).
- By default, safely creates or attaches a synthetic test customer in PostgreSQL with
  a genuine database-backed single-use consent token.
- Mobile and browser verification: opening the generated link allows live DPDP consent
  acceptance, redirect to upload portal, and instant status updates in Admin Dashboard.
- '--probe-only' mode tests SMTP socket handshake with an ephemeral detached token.
- Never prints or leaks passwords, API keys, or raw secrets.
"""
import argparse
import sys
from datetime import timedelta

from sqlalchemy import select, func

from app import emailer, services
from app.config import get_settings
from app.db import session_scope
from app.doc_types import label
from app.models import AccessToken, Customer, RequiredDocument
from app.security import hash_token, new_token


def main():
    parser = argparse.ArgumentParser(description="Send a safe test consent email to an inbox you control.")
    parser.add_argument("--email", required=True, help="Recipient email address that you control.")
    parser.add_argument("--name", default="DocPilot Test User", help="Recipient display name.")
    parser.add_argument(
        "--probe-only",
        action="store_true",
        help="Only probe SMTP delivery with an ephemeral token without writing a customer to the database.",
    )
    args = parser.parse_args()

    recipient = args.email.strip().lower()
    if "@" not in recipient or "." not in recipient:
        print(f"Error: '{recipient}' is not a valid email address.", file=sys.stderr)
        sys.exit(1)

    s = get_settings()
    print("==========================================================================")
    print("               DOCPILOT: SMTP EMAIL VERIFICATION UTILITY                  ")
    print("==========================================================================")
    print(f"  Recipient Email  : {recipient}")
    print(f"  Recipient Name   : {args.name}")
    print(f"  Public Base URL  : {s.public_base_url}")
    print(f"  Configured Port  : {s.smtp_port}")
    print(f"  Configured Host  : {s.smtp_host or '(Not set - using in-memory outbox)'}")
    print(f"  Sender (From)    : {s.smtp_from}")
    print(f"  Mode             : {'Probe Only (No DB customer)' if args.probe_only else 'Live DB-Backed Synthetic Test Customer'}")

    # Check connection probe
    print("\n[STEP 1] Testing SMTP Server Connection Handshake...")
    probe = emailer.test_smtp_connection()
    if not probe.get("configured"):
        print("  -> SMTP is NOT configured (SMTP_HOST is empty).")
        print("  -> Emails will be captured in the local in-memory outbox instead of live delivery.")
    elif not probe.get("connected"):
        print(f"  -> WARNING: SMTP Connection Failed! Error: {probe.get('error')}")
        print("  -> Please check your SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in backend/.env.")
        sys.exit(1)
    else:
        print(f"  -> SUCCESS: Connected and authenticated with {probe.get('host')}:{probe.get('port')}.")

    # Generate consent token & URL
    print("\n[STEP 2] Generating Secure Consent Link...")
    raw_token = None
    customer_id = None
    sample_doc_labels = ["PAN Card", "Aadhaar Card"]

    if args.probe_only:
        raw_token = new_token()
        consent_url = services.build_consent_url(s.public_base_url, raw_token)
        print("  -> Ephemeral Token Generated (Not saved to database).")
    else:
        with session_scope() as db:
            # Check if an existing test customer with this email already exists
            existing_cust = db.scalar(
                select(Customer)
                .where(func.lower(Customer.email) == recipient)
                .order_by(Customer.created_at.desc())
                .limit(1)
            )

            if existing_cust and existing_cust.consent_status == "pending":
                customer = existing_cust
                # Revoke any prior consent tokens for clean testing
                old_tokens = db.scalars(
                    select(AccessToken).where(
                        AccessToken.customer_id == customer.id,
                        AccessToken.purpose == "consent",
                        AccessToken.used_at.is_(None),
                    )
                ).all()
                for ot in old_tokens:
                    ot.revoked = True
            else:
                customer = Customer(
                    name=args.name,
                    email=recipient,
                    mobile="+919876543210",
                    consent_status="pending",
                    case_status="awaiting_consent",
                    workflow_state="NOT_STARTED",
                )
                db.add(customer)
                db.flush()

                # Add sample required documents
                for dt in ["pan", "aadhaar"]:
                    db.add(RequiredDocument(customer_id=customer.id, doc_type=dt))

            customer_id = customer.id
            raw_token = services.issue_token(db, customer.id, "consent", timedelta(hours=s.consent_token_hours))
            consent_url = services.build_consent_url(s.public_base_url, raw_token)
            sample_doc_labels = [label(k) for k in services.pending_keys(db, customer.id)]
            db.commit()

        print(f"  -> Database-Backed Synthetic Customer ID: {customer_id}")
        print("  -> Single-Use Consent Token Saved in PostgreSQL `access_tokens` table.")

    print(f"  -> Consent Link  : {consent_url}")
    if "localhost" in s.public_base_url or "127.0.0.1" in s.public_base_url:
        print("  -> NOTE: Link uses 'localhost'. It will work in your PC browser, but mobile devices")
        print("           on your Wi-Fi cannot resolve localhost. Set PUBLIC_BASE_URL to your LAN IP")
        print("           (e.g., http://192.168.1.107:5173) to open this link on your phone.")

    # Dispatch email
    print("\n[STEP 3] Sending Test Consent Email...")
    sent = emailer.consent_request(recipient, args.name, sample_doc_labels, consent_url)

    if sent:
        if s.smtp_host:
            print("\n==========================================================================")
            print("  >>> LIVE SMTP DELIVERY: Email dispatched to SMTP relay server! <<<     ")
            print("==========================================================================")
            print(f"  - Message sent to: {recipient}")
            print("  - Please check your inbox (and Spam/Junk folder if this is a personal address).")
            print("  - When you open the link on your phone:")
            print("      1. You will see the consent agreement and requested documents.")
            print("      2. Check the confirmation box and tap 'Give Consent & Continue'.")
            print("      3. The browser will record consent and redirect you to the upload portal.")
            if customer_id:
                print(f"      4. You can see Customer #{customer_id} update to 'granted' in the Admin Dashboard.")
        else:
            print("\n==========================================================================")
            print("  >>> DEV OUTBOX MODE: Email captured in in-memory outbox (No live SMTP)  ")
            print("==========================================================================")
            print("  - Outbox entry logged in terminal.")
            print("  - To send real emails over the internet, add SMTP credentials to backend/.env.")
    else:
        print("\n  -> FAILED: Email dispatch returned False. Check logs for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()
