"""
Safe CLI script for verifying SMTP email dispatch and consent link generation.
Usage:
  python -m scripts.send_test_consent --email your_email@example.com --name "Test User"

Features:
- Never sends emails to real customers (strictly uses the user-provided test email).
- Probes SMTP connectivity (test_smtp_connection) before sending.
- Verifies PUBLIC_BASE_URL resolution.
- Separates live SMTP socket dispatch from development in-memory outbox mode.
- Never prints or leaks passwords, API keys, or raw secrets.
"""
import argparse
import sys
from datetime import timedelta

from app import emailer, services
from app.config import get_settings
from app.db import session_scope
from app.models import Customer
from app.security import hash_token, new_token


def main():
    parser = argparse.ArgumentParser(description="Send a safe test consent email to an inbox you control.")
    parser.add_argument("--email", required=True, help="Recipient email address that you control.")
    parser.add_argument("--name", default="Test User", help="Recipient display name.")
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

    # Generate test consent token & URL
    print("\n[STEP 2] Generating Secure Consent Link...")
    raw_token = new_token()
    token_hash = hash_token(raw_token)
    consent_url = services.build_consent_url(s.public_base_url, raw_token)

    print(f"  -> Consent Link  : {consent_url}")
    if "localhost" in s.public_base_url or "127.0.0.1" in s.public_base_url:
        print("  -> NOTE: Link uses 'localhost'. It will work in your PC browser, but mobile devices")
        print("           on your Wi-Fi cannot resolve localhost. Set PUBLIC_BASE_URL to your LAN IP")
        print("           (e.g., http://192.168.1.107:5173) to open this link on your phone.")

    # Dispatch email
    print("\n[STEP 3] Sending Test Consent Email...")
    sample_docs = ["PAN Card", "Aadhaar Card", "Bank Statement"]
    sent = emailer.consent_request(recipient, args.name, sample_docs, consent_url)

    if sent:
        if s.smtp_host:
            print("\n==========================================================================")
            print("  >>> LIVE SMTP DELIVERY: Email dispatched to SMTP relay server! <<<     ")
            print("==========================================================================")
            print(f"  - Message sent to: {recipient}")
            print("  - Please check your inbox (and Spam/Junk folder if this is a personal address).")
            print("  - Verify that the consent link opens and displays the consent form.")
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
