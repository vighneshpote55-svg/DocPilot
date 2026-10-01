import logging
import smtplib
from email.message import EmailMessage

from .config import get_settings

log = logging.getLogger(__name__)
OUTBOX: list[dict] = []  # filled only when SMTP is not configured (development / tests)


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return f"{local[:1]}***@{domain}"


def send_email(to: str, subject: str, body: str) -> None:
    s = get_settings()
    if not s.smtp_host:
        OUTBOX.append({"to": to, "subject": subject, "body": body})
        log.info("EMAIL (dev outbox) to=%s subject=%s", mask_email(to), subject)
        return
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.smtp_from, to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=30) as smtp:
            smtp.starttls()
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_password)
            smtp.send_message(msg)
    except Exception:
        log.exception("Failed to send email (subject=%s)", subject)


def consent_request(to: str, name: str, labels: list[str], link: str) -> None:
    docs = "\n".join(f"  - {x}" for x in labels)
    send_email(to, "Consent needed to collect your documents", (
        f"Hello {name},\n\nWe need the following documents:\n{docs}\n\n"
        f"Please review how they will be used and give or decline consent here:\n{link}\n\n"
        "Documents are uploaded through a secure portal; please do not send them by email."))


def pending_documents(to: str, name: str, labels: list[str], link: str, reminder: bool) -> None:
    docs = "\n".join(f"  - {x}" for x in labels)
    subject = "Reminder: documents still pending" if reminder else "Please upload your documents"
    send_email(to, subject, (
        f"Hello {name},\n\nThe following documents are still pending:\n{docs}\n\n"
        f"Upload them securely here (you can upload one at a time):\n{link}\n\n"
        "Please do not reply with attachments."))


def resubmit(to: str, name: str, doc_label: str, link: str) -> None:
    send_email(to, f"Please re-upload your {doc_label}", (
        f"Hello {name},\n\nWe could not accept the {doc_label} you uploaded. "
        f"Please upload a clear, valid copy here:\n{link}"))


def completed(to: str, name: str) -> None:
    send_email(to, "All documents received", (
        f"Hello {name},\n\nAll your documents have been verified. Thank you. "
        "Your uploaded files will be permanently deleted shortly."))


def privacy_verification(to: str, name: str, action: str, link: str) -> None:
    what = "delete your data" if action == "delete" else "withdraw your consent"
    send_email(to, "Confirm your privacy request", (
        f"Hello {name},\n\nWe received a request to {what}. Confirm it within 30 minutes:\n{link}\n\n"
        "If you did not make this request, ignore this email."))


def deletion_confirmation(to: str, name: str) -> None:
    send_email(to, "Your documents have been deleted", (
        f"Hello {name},\n\nYour uploaded documents and temporary processing data have been permanently deleted."))


def withdrawal_confirmation(to: str, name: str) -> None:
    send_email(to, "Consent withdrawn", (
        f"Hello {name},\n\nWe have stopped processing and reminders for your case. "
        "Any files already uploaded will be deleted shortly."))


def send_upload_otp(to: str, name: str, otp: str) -> None:
    send_email(to, "Your DocPilot verification code", (
        f"Hello {name},\n\nYour one-time upload verification code is: {otp}\n\n"
        "This code will expire in 10 minutes. If you did not request this, please ignore this email."))

