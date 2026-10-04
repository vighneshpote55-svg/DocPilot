import React, { useCallback, useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import {
  getDocumentStatus,
  getPortal,
  sendPortalOtp,
  uploadDocument,
  verifyPortalOtp,
} from "../api";
import type { CustomerDocState, PortalDocument, PortalState } from "../types";
import {
  IconShieldCheck,
  IconLock,
  IconFileText,
  IconCheck,
  IconCheckCircle2,
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowRight,
} from "../components/admin/AdminIcons";

const STATE_CONFIG: Record<
  string,
  { label: string; badgeClass: string; desc: string }
> = {
  pending_upload: {
    label: "Pending Upload",
    badgeClass: "pending_upload",
    desc: "Waiting for your upload",
  },
  uploading: {
    label: "Uploading…",
    badgeClass: "uploading",
    desc: "Securing and uploading document…",
  },
  processing: {
    label: "Processing & OCR",
    badgeClass: "processing",
    desc: "Checking document validity and readability…",
  },
  verified: {
    label: "Verified",
    badgeClass: "verified",
    desc: "Received and verified successfully",
  },
  under_review: {
    label: "Manual Review",
    badgeClass: "under_review",
    desc: "Under review by our compliance team",
  },
  manual_review: {
    label: "Manual Review",
    badgeClass: "manual_review",
    desc: "Under review by our compliance team",
  },
  resubmit: {
    label: "Resubmit Required",
    badgeClass: "resubmit",
    desc: "Please upload a clear, valid copy again",
  },
  rejected: {
    label: "Rejected",
    badgeClass: "rejected",
    desc: "Please upload a clear, valid copy again",
  },
  failed: {
    label: "Failed",
    badgeClass: "failed",
    desc: "Processing error. Please retry upload.",
  },
};

export const PortalPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [portal, setPortal] = useState<PortalState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // OTP state
  const [otpCode, setOtpCode] = useState<string>("");
  const [otpSent, setOtpSent] = useState<boolean>(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState<boolean>(false);

  // Upload & polling state per document type
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);
  const [dragOverDoc, setDragOverDoc] = useState<string | null>(null);
  const [docMessages, setDocMessages] = useState<
    Record<string, { text: string; ok: boolean }>
  >({});
  const [resubmittingSlots, setResubmittingSlots] = useState<
    Record<string, boolean>
  >({});
  const pollTimers = useRef<Record<string, number>>({});

  const loadPortal = useCallback(async () => {
    if (!token) return;
    try {
      const data = await getPortal(token);
      setPortal(data);
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load portal.");
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let ignore = false;

    queueMicrotask(() => {
      setDocMessages({});
      setError(null);
      setLoading(true);
    });

    getPortal(token)
      .then((data) => {
        if (!ignore) {
          setPortal(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Unable to load portal.");
          setLoading(false);
        }
      });

    const activeTimers = pollTimers.current;
    return () => {
      ignore = true;
      Object.values(activeTimers).forEach((t) => clearInterval(t));
      pollTimers.current = {};
    };
  }, [token]);

  const handleSendOtp = async () => {
    if (!token) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      await sendPortalOtp(token);
      setOtpSent(true);
      setOtpLoading(false);
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Failed to send code.");
      setOtpLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !otpCode.trim()) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      await verifyPortalOtp(token, otpCode.trim());
      setOtpLoading(false);
      await loadPortal();
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Verification failed.");
      setOtpLoading(false);
    }
  };

  const pollStatus = (docType: string, docId: string) => {
    if (!token) return;
    let attempts = 0;
    const interval = window.setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await getDocumentStatus(token, docId);
        if (res.state === "processing") return;

        clearInterval(interval);
        delete pollTimers.current[docType];

        setPortal((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            documents: prev.documents.map((d) =>
              d.doc_type === docType
                ? {
                    ...d,
                    state: res.state as CustomerDocState,
                    document_id: res.document_id,
                  }
                : d
            ),
          };
        });

        if (res.state === "verified") {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: "Document verified successfully.", ok: true },
          }));
          setTimeout(loadPortal, 1200);
        } else if (res.state === "resubmit" || (res.state as string) === "rejected") {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: {
              text: res.message || "Please upload a clear, valid copy.",
              ok: false,
            },
          }));
        } else {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: "Under review by our team.", ok: true },
          }));
        }
      } catch {
        clearInterval(interval);
        delete pollTimers.current[docType];
      }
    }, 3000);

    pollTimers.current[docType] = interval;
  };

  const handleUpload = async (doc: PortalDocument, file: File | null) => {
    if (!token || !file) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: { text: "Please select a file first.", ok: false },
      }));
      return;
    }

    if (file.size === 0) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: "The selected file is empty. Please select a valid document.",
          ok: false,
        },
      }));
      return;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const allowed = ["pdf", "png", "jpg", "jpeg"];
    if (ext && !allowed.includes(ext)) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: "Only PDF, PNG, and JPG files are accepted.",
          ok: false,
        },
      }));
      return;
    }

    if (portal && file.size > portal.max_upload_mb * 1024 * 1024) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: `File exceeds maximum allowed size of ${portal.max_upload_mb} MB.`,
          ok: false,
        },
      }));
      return;
    }

    setUploadingDoc(doc.doc_type);
    setDocMessages((prev) => ({
      ...prev,
      [doc.doc_type]: { text: "Encrypting and uploading document…", ok: true },
    }));

    try {
      const res = await uploadDocument(token, doc.doc_type, file);
      setUploadingDoc(null);
      // Reset resubmitting state for this slot
      setResubmittingSlots((prev) => ({ ...prev, [doc.doc_type]: false }));
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: "Uploaded. Checking document validity…",
          ok: true,
        },
      }));
      pollStatus(doc.doc_type, res.document_id);
    } catch (err: unknown) {
      setUploadingDoc(null);
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: err instanceof Error ? err.message : "Upload failed.",
          ok: false,
        },
      }));
    }
  };

  if (loading) {
    return (
      <div className="customer-app-root">
        <div className="customer-content-wrap customer-content-narrow">
          <div
            className="consent-panel-card"
            id="portal-loading"
            style={{ textAlign: "center", padding: "48px 24px" }}
          >
            <div
              className="processing-spinner"
              style={{ margin: "0 auto 16px", width: 32, height: 32 }}
            />
            <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>
              Accessing Secure Portal…
            </h2>
            <p className="customer-hero-desc" style={{ fontSize: 14 }}>
              Loading your encrypted document manifest and session tokens…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !portal) {
    return (
      <div className="customer-app-root">
        <div className="customer-content-wrap customer-content-narrow">
          <div className="consent-panel-card" id="portal-error">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                color: "var(--adm-danger, #ef4444)",
                marginBottom: 12,
              }}
            >
              <IconAlertCircle size={24} />
              <h2 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>
                Unable to Access Portal
              </h2>
            </div>
            <p
              style={{
                color: "var(--adm-text-secondary, #94a3b8)",
                fontSize: 14,
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              {error ||
                "Unable to access the verification portal. Please verify your token link or contact support."}
            </p>
            <Link
              to="/"
              className="customer-access-btn"
              style={{ textDecoration: "none" }}
            >
              Return to DocPilot Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // --- Render OTP Verification if required ---
  if (portal.otp_required) {
    return (
      <div className="customer-app-root">
        <div className="customer-content-wrap customer-content-narrow">
          <div className="otp-panel-card" id="portal-otp-screen">
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "var(--adm-primary-bg, rgba(59, 130, 246, 0.12))",
                color: "var(--adm-primary, #3b82f6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 16px",
              }}
            >
              <IconLock size={28} />
            </div>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "var(--adm-text, #f8fafc)",
                margin: "0 0 8px",
              }}
            >
              Email Verification
            </h1>
            <p
              style={{
                color: "var(--adm-text-secondary, #94a3b8)",
                fontSize: 14,
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              For your privacy and security, please enter the one-time passcode
              sent to your registered email before uploading documents.
            </p>

            {portal.masked_email && (
              <div
                style={{
                  background: "var(--adm-card-elevated, #14203a)",
                  border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                  padding: "10px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                  color: "var(--adm-text, #ffffff)",
                  marginBottom: 16,
                  display: "inline-block",
                }}
              >
                Passcode destination: <strong>{portal.masked_email}</strong>
              </div>
            )}

            {otpError && (
              <div
                className="msg err"
                role="alert"
                style={{
                  marginBottom: 16,
                  padding: "10px 14px",
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--adm-danger, #ef4444)",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {otpError}
              </div>
            )}

            {!otpSent ? (
              <button
                className="customer-access-btn"
                onClick={handleSendOtp}
                disabled={otpLoading}
                id="portal-otp-send-btn"
                style={{ width: "100%", justifyContent: "center" }}
              >
                {otpLoading ? (
                  <>
                    <div
                      className="processing-spinner"
                      style={{ width: 14, height: 14 }}
                    />
                    Sending Code…
                  </>
                ) : (
                  "Send Verification Code"
                )}
              </button>
            ) : (
              <form onSubmit={handleVerifyOtp}>
                <label
                  htmlFor="otp-input"
                  style={{
                    display: "block",
                    fontSize: 13,
                    color: "var(--adm-text-muted, #94a3b8)",
                    textAlign: "left",
                    marginBottom: 6,
                  }}
                >
                  Enter 6-Digit Passcode
                </label>
                <input
                  id="otp-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="• • • • • •"
                  className="otp-digit-input"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  required
                  autoFocus
                />
                <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
                  <button
                    type="submit"
                    className="customer-access-btn"
                    disabled={otpLoading || otpCode.length < 6}
                    id="portal-otp-submit-btn"
                    style={{ flex: 1, justifyContent: "center" }}
                  >
                    {otpLoading ? "Verifying…" : "Verify & Continue"}
                  </button>
                  <button
                    type="button"
                    className="consent-btn-decline"
                    onClick={handleSendOtp}
                    disabled={otpLoading}
                    id="portal-otp-resend-btn"
                  >
                    Resend Code
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Calculations for Portal Progress ---
  const total = portal.documents.length;
  const verifiedCount = total - portal.pending_count;
  const isOpen = portal.case_status === "in_progress";
  const isCompleted =
    portal.case_status === "completed" ||
    (total > 0 && verifiedCount === total);
  const progressPercent =
    total > 0 ? Math.round((verifiedCount / total) * 100) : 0;

  return (
    <div className="customer-app-root">
      <div className="customer-content-wrap" id="portal-container">
        {/* Verification Completed Screen (Screen 5) */}
        {isCompleted ? (
          <div
            className="verification-complete-card"
            style={{ marginBottom: 28 }}
          >
            <div className="complete-shield-glow">
              <IconShieldCheck size={38} />
            </div>
            <h1 className="complete-hero-title">
              Verification Completed Successfully!
            </h1>
            <p className="complete-hero-desc">
              Thank you, <strong>{portal.first_name}</strong>. All requested
              identity and business documents have been thoroughly verified and
              confirmed. No further action is required from you.
            </p>

            {/* Checklist Summary */}
            <div className="complete-checklist-summary">
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--adm-text-muted, #94a3b8)",
                  marginBottom: 12,
                }}
              >
                Verified Document Records ({total})
              </div>
              {portal.documents.map((doc) => (
                <div key={doc.doc_type} className="complete-summary-item">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--adm-text, #f1f5f9)",
                    }}
                  >
                    <IconCheckCircle2 size={16} color="var(--adm-success, #10b981)" />
                    <span>{doc.label}</span>
                  </div>
                  <span
                    className="doc-state-tag verified"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    ✓ Verified
                  </span>
                </div>
              ))}
            </div>

            {/* 7-Day Purge & Encryption Guarantee Box */}
            <div className="complete-retention-box">
              <IconLock
                size={22}
                color="var(--adm-primary, #3b82f6)"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--adm-text, #ffffff)",
                    marginBottom: 4,
                  }}
                >
                  🔒 AES-256-GCM Encryption &amp; Automated 7-Day Purge
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--adm-text-secondary, #94a3b8)",
                    lineHeight: 1.5,
                  }}
                >
                  All uploaded document files, OCR data extracts, and session
                  keys are cryptographically isolated in private storage and
                  scheduled for automated, permanent deletion within 7 days.
                </div>
              </div>
            </div>

            {/* Existing Completed Banner ID anchor */}
            <div
              className="msg ok"
              role="status"
              id="portal-completed-banner"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                marginTop: 10,
                fontSize: 13,
              }}
            >
              <IconCheck size={16} />
              <span>
                Case verified. Secure customer session finalized.
              </span>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 14,
                marginTop: 24,
                flexWrap: "wrap",
              }}
            >
              <Link
                to="/privacy"
                className="consent-btn-decline"
                style={{ textDecoration: "none", fontSize: 13 }}
              >
                Review Data Privacy Rights
              </Link>
              <Link
                to="/"
                className="customer-access-btn"
                style={{ textDecoration: "none", fontSize: 13 }}
              >
                Return to DocPilot Home
              </Link>
            </div>
          </div>
        ) : (
          /* Active Case Overview Hero */
          <div className="portal-hero-card">
            <div className="portal-hero-top">
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--adm-primary, #60a5fa)",
                    fontWeight: 700,
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  <IconShieldCheck size={14} />
                  <span>Secure Document Verification Portal</span>
                </div>
                <h1 className="portal-customer-name">
                  Hello, {portal.first_name}
                </h1>
              </div>

              <div className="portal-status-pills-wrap">
                <span
                  className={`portal-case-badge ${portal.case_status}`}
                  id="portal-case-status-badge"
                >
                  {portal.case_status === "in_progress"
                    ? "Case In Progress"
                    : portal.case_status}
                </span>
                <span className="customer-security-pill">
                  <IconLock size={12} />
                  <span>256-Bit SSL Enclave</span>
                </span>
              </div>
            </div>

            {/* Progress Bar Card */}
            <div className="portal-progress-card">
              <div className="portal-progress-meta-row">
                <span
                  style={{
                    color: "var(--adm-text, #f1f5f9)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>Verification Progress</span>
                  <span
                    style={{
                      background: "var(--adm-primary-bg, rgba(59, 130, 246, 0.15))",
                      color: "var(--adm-primary, #60a5fa)",
                      padding: "2px 8px",
                      borderRadius: 12,
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {progressPercent}% Complete
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--adm-text-muted, #94a3b8)",
                  }}
                >
                  <strong>{verifiedCount}</strong> of <strong>{total}</strong>{" "}
                  documents verified
                </span>
              </div>

              <div
                className="portal-progress-bar-track"
                role="progressbar"
                aria-valuenow={verifiedCount}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-label="Document verification progress"
              >
                <div
                  className="portal-progress-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 16,
                  marginTop: 12,
                  fontSize: 12,
                  color: "var(--adm-text-secondary, #94a3b8)",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  Required:{" "}
                  <strong style={{ color: "var(--adm-text, #ffffff)" }}>
                    {total}
                  </strong>
                </span>
                <span>
                  Verified:{" "}
                  <strong style={{ color: "var(--adm-success, #10b981)" }}>
                    {verifiedCount}
                  </strong>
                </span>
                <span>
                  Pending:{" "}
                  <strong
                    style={{
                      color:
                        portal.pending_count > 0
                          ? "var(--adm-warning, #f59e0b)"
                          : "inherit",
                    }}
                  >
                    {portal.pending_count}
                  </strong>
                </span>
              </div>
            </div>

            {!isOpen && (
              <div
                className="msg err"
                role="alert"
                style={{
                  marginTop: 16,
                  padding: "12px 16px",
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--adm-danger, #ef4444)",
                  borderRadius: 8,
                }}
              >
                This verification case has expired or closed. Further uploads
                are no longer permitted.
              </div>
            )}
          </div>
        )}

        {/* Document Cards List */}
        <div id="document-cards-list" className="customer-docs-list">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 4,
            }}
          >
            <h2
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: "var(--adm-text, #f1f5f9)",
                margin: 0,
              }}
            >
              Required Documents
            </h2>
            <span
              style={{
                fontSize: 12,
                color: "var(--adm-text-muted, #94a3b8)",
              }}
            >
              Max {portal.max_upload_mb} MB per file • PDF, PNG, JPG
            </span>
          </div>

          {portal.documents.map((doc) => {
            const isUploading = uploadingDoc === doc.doc_type;
            const isProcessing = doc.state === "processing";
            const isVerified = doc.state === "verified";
            const isUnderReview =
              doc.state === "under_review" ||
              (doc.state as string) === "manual_review";
            const isRejection =
              doc.state === "resubmit" ||
              (doc.state as string) === "rejected";
            const isFailed = (doc.state as string) === "failed";
            const statusConfig =
              STATE_CONFIG[doc.state] || {
                label: doc.state,
                badgeClass: doc.state,
                desc: "",
              };

            // Can upload if case is open, not verified, not processing, and not currently under review
            const isSlotResubmitting = !!resubmittingSlots[doc.doc_type];
            const canUpload =
              isOpen &&
              !isVerified &&
              !isProcessing &&
              !isUnderReview &&
              (!isRejection || isSlotResubmitting);

            const statusMessage = docMessages[doc.doc_type];

            return (
              <div
                key={doc.doc_type}
                id={`doc-card-${doc.doc_type}`}
                className={`doc-upload-card ${
                  isVerified
                    ? "state-verified"
                    : isUnderReview
                    ? "state-review"
                    : isRejection
                    ? "state-resubmit"
                    : ""
                }`}
              >
                <div className="doc-card-header">
                  <div className="doc-card-title-group">
                    <IconFileText
                      size={20}
                      color={
                        isVerified
                          ? "var(--adm-success, #10b981)"
                          : isRejection
                          ? "var(--adm-danger, #ef4444)"
                          : isUnderReview
                          ? "var(--adm-warning, #f59e0b)"
                          : "var(--adm-primary, #3b82f6)"
                      }
                    />
                    <div>
                      <h3 className="doc-card-title">{doc.label}</h3>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--adm-text-muted, #94a3b8)",
                          marginTop: 2,
                        }}
                      >
                        Slot:{" "}
                        <span className="doc-card-slot-chip">
                          {doc.doc_type}
                        </span>
                      </div>
                    </div>
                  </div>

                  <span
                    className={`doc-state-tag ${
                      isUploading ? "uploading" : statusConfig.badgeClass
                    }`}
                  >
                    {isUploading ? "Uploading…" : statusConfig.label}
                  </span>
                </div>

                {/* State: Verified */}
                {isVerified && (
                  <div className="verified-success-box">
                    <div className="verified-icon-check">
                      <IconCheck size={16} />
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--adm-success, #10b981)",
                        }}
                      >
                        Document verified and accepted
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--adm-text-secondary, #94a3b8)",
                        }}
                      >
                        Cryptographically encrypted with AES-256-GCM. Scheduled
                        for auto-purge in 7 days.
                      </div>
                    </div>
                  </div>
                )}

                {/* State: Processing & OCR */}
                {isProcessing && (
                  <div className="processing-pulse-banner">
                    <div className="processing-spinner" />
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--adm-primary, #60a5fa)",
                        }}
                      >
                        Analyzing Document &amp; Checking Validity…
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--adm-text-secondary, #94a3b8)",
                        }}
                      >
                        Running stateless OCR extraction and rule validation.
                        This typically takes 5–15 seconds.
                      </div>
                    </div>
                  </div>
                )}

                {/* State: Manual Review (Calm amber, zero fraud scores) */}
                {isUnderReview && (
                  <div className="manual-review-box">
                    <IconAlertTriangle
                      size={20}
                      color="var(--adm-warning, #f59e0b)"
                      style={{ flexShrink: 0, marginTop: 2 }}
                    />
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--adm-warning, #f59e0b)",
                        }}
                      >
                        Under Review by Verification Team
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--adm-text-secondary, #cbd5e1)",
                          lineHeight: 1.5,
                        }}
                      >
                        Your document was securely received. Our compliance
                        specialists are conducting a standard quality review. No
                        immediate action is needed on your part.
                      </div>
                    </div>
                  </div>
                )}

                {/* State: Resubmit Required / Rejected */}
                {isRejection && (
                  <div className="rejection-guidance-box" role="alert">
                    <div className="rejection-title-row">
                      <IconAlertCircle size={18} />
                      <span>Resubmission Required</span>
                    </div>
                    <p className="rejection-text">
                      Please upload a clear, valid copy. Ensure the document is
                      unobscured, well-lit, all text is legible, and it matches
                      the requested <strong>{doc.label}</strong> type.
                    </p>
                    {!isSlotResubmitting && isOpen && (
                      <button
                        type="button"
                        className="resubmit-btn"
                        onClick={() =>
                          setResubmittingSlots((prev) => ({
                            ...prev,
                            [doc.doc_type]: true,
                          }))
                        }
                      >
                        Resubmit Document
                        <IconArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}

                {/* State: Failed */}
                {isFailed && (
                  <div className="rejection-guidance-box" role="alert">
                    <div className="rejection-title-row">
                      <IconAlertCircle size={18} />
                      <span>Processing Failed</span>
                    </div>
                    <p className="rejection-text">
                      We were unable to process the uploaded file. Please verify
                      the file is not password-protected and upload a fresh
                      copy.
                    </p>
                    {!isSlotResubmitting && isOpen && (
                      <button
                        type="button"
                        className="resubmit-btn"
                        onClick={() =>
                          setResubmittingSlots((prev) => ({
                            ...prev,
                            [doc.doc_type]: true,
                          }))
                        }
                      >
                        Retry Upload
                        <IconArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}

                {/* Upload Dropzone (for Pending Upload or active Resubmit) */}
                {canUpload && (
                  <div style={{ marginTop: 14 }}>
                    <div
                      role="button"
                      tabIndex={!isUploading ? 0 : -1}
                      aria-label={`Upload ${doc.label}`}
                      className={`customer-dropzone ${
                        dragOverDoc === doc.doc_type ? "active" : ""
                      }`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          const inputEl = document.getElementById(
                            `file-${doc.doc_type}`
                          ) as HTMLInputElement | null;
                          inputEl?.click();
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (!isUploading) setDragOverDoc(doc.doc_type);
                      }}
                      onDragLeave={() => setDragOverDoc(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverDoc(null);
                        if (isUploading) return;
                        const file = e.dataTransfer.files?.[0] || null;
                        if (file) handleUpload(doc, file);
                      }}
                      onClick={() => {
                        const inputEl = document.getElementById(
                          `file-${doc.doc_type}`
                        ) as HTMLInputElement | null;
                        inputEl?.click();
                      }}
                    >
                      <div className="customer-dropzone-icon">
                        <IconFileText size={22} />
                      </div>
                      <div className="customer-dropzone-label">
                        {dragOverDoc === doc.doc_type
                          ? "Drop file to upload immediately"
                          : isSlotResubmitting
                          ? "Drop a clear, legible replacement file here"
                          : `Drag & drop ${doc.label} here, or click to browse`}
                      </div>
                      <div className="customer-dropzone-hint">
                        Accepted formats: PDF, PNG, JPG (up to{" "}
                        {portal.max_upload_mb} MB)
                      </div>
                    </div>

                    {/* File input and upload button row */}
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <input
                        type="file"
                        id={`file-${doc.doc_type}`}
                        accept=".pdf,.png,.jpg,.jpeg"
                        style={{
                          flex: 1,
                          fontSize: 13,
                          color: "var(--adm-text-secondary, #94a3b8)",
                        }}
                        disabled={isUploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0] || null;
                          if (file) handleUpload(doc, file);
                        }}
                      />
                      <button
                        type="button"
                        disabled={isUploading}
                        onClick={() => {
                          const inputEl = document.getElementById(
                            `file-${doc.doc_type}`
                          ) as HTMLInputElement | null;
                          const file = inputEl?.files?.[0] || null;
                          handleUpload(doc, file);
                        }}
                        id={`upload-btn-${doc.doc_type}`}
                        className="customer-access-btn"
                        style={{
                          padding: "8px 16px",
                          fontSize: 13,
                          borderRadius: 6,
                        }}
                      >
                        {isUploading ? "Uploading…" : "Upload"}
                      </button>
                    </div>

                    {/* Upload progress shimmer bar */}
                    {isUploading && (
                      <div
                        className="upload-shimmer-bar"
                        role="progressbar"
                        aria-label="Uploading file"
                      >
                        <i />
                      </div>
                    )}
                  </div>
                )}

                {/* Per-document status or error message */}
                {statusMessage && (
                  <div
                    className={`msg ${statusMessage.ok ? "ok" : "err"}`}
                    style={{
                      marginTop: 12,
                      padding: "8px 12px",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    role="status"
                  >
                    {statusMessage.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Security & Retention Micro-Notice */}
        <p
          className="customer-footer"
          style={{
            marginTop: 32,
            justifyContent: "center",
            textAlign: "center",
          }}
        >
          Accepted formats: {portal.allowed_types.join(", ").toUpperCase()} (up
          to {portal.max_upload_mb} MB each). All files are encrypted using
          AES-256-GCM and permanently deleted after verification.
        </p>
      </div>
    </div>
  );
};
