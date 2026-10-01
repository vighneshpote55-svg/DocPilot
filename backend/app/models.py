import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, utcnow


def _uuid() -> str:
    return str(uuid.uuid4())


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)  # atomic ID
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), index=True)
    mobile: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # consent_status: pending | granted | declined | withdrawn
    consent_status: Mapped[str] = mapped_column(String(20), default="pending")
    # case_status: awaiting_consent | in_progress | completed | expired |
    #              consent_declined | consent_withdrawn | deleted
    case_status: Mapped[str] = mapped_column(String(24), default="awaiting_consent", index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    consent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    case_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    delete_after: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    data_deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_reminder_stage: Mapped[int] = mapped_column(Integer, default=0)

    @property
    def code(self) -> str:
        return f"CUS-{self.id:06d}"


class RequiredDocument(Base):
    """One row per required document. Pending = rows with verified_document_id NULL."""

    __tablename__ = "required_documents"
    __table_args__ = (UniqueConstraint("customer_id", "doc_type"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(40))
    verified_document_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ConsentLedger(Base):
    """Append-only. event: granted | declined | withdrawn | deleted"""

    __tablename__ = "consent_ledger"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)  # no FK: survives deletion, holds no PII
    event: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AccessToken(Base):
    """Only a SHA-256 hash of the token is stored. purpose: consent | upload | privacy"""

    __tablename__ = "access_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    purpose: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    ref_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Document(Base):
    """Independent states: ocr_status, verification_status, file_state (+ the customer's case_status)."""

    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(40))  # the slot the customer uploaded into
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(200))

    ocr_status: Mapped[str] = mapped_column(String(12), default="waiting")  # waiting|processing|completed|failed
    verification_status: Mapped[str] = mapped_column(String(14), default="not_started")
    # not_started | verified | rejected | manual_review
    file_state: Mapped[str] = mapped_column(String(10), default="stored")  # stored | deleted
    superseded: Mapped[bool] = mapped_column(Boolean, default=False)

    flags: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class OcrResult(Base):
    """Temporary. Payload is PII-masked before it is stored. Deleted with the files."""

    __tablename__ = "ocr_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), unique=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ManualReview(Base):
    __tablename__ = "manual_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), index=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    flags: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(10), default="open")  # open | approved | rejected
    decided_by: Mapped[str | None] = mapped_column(String(320), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PrivacyRequest(Base):
    __tablename__ = "privacy_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(10))  # delete | withdraw
    status: Mapped[str] = mapped_column(String(24), default="verification_pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuditLog(Base):
    """Minimal audit. Never put PII or document content in details."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(320))
    action: Mapped[str] = mapped_column(String(60))
    entity_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)


class Job(Base):
    """Database-backed job queue (no Redis needed)."""

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(10), default="queued", index=True)  # queued|running|done|failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    run_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
