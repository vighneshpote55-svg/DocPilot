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
import { UploadModal } from "../components/UploadModal";
import {
  IconShieldCheck,
  IconLock,
  IconFileText,
  IconCheck,
  IconCheckCircle2,
  IconAlertCircle,
  IconAlertTriangle,
  IconUploadCloud,
} from "../components/admin/AdminIcons";

// Customer-friendly state configuration
const CUSTOMER_STATE_CONFIG: Record<
  string,
  { label: string; badgeClass: string; desc: string }
> = {
  pending_upload: {
    label: "Upload required",
    badgeClass: "pending_upload",
    desc: "Please upload your document to continue verification",
  },
  uploading: {
    label: "Uploading…",
    badgeClass: "uploading",
    desc: "Securing and uploading document…",
  },
  processing: {
    label: "Processing",
    badgeClass: "processing",
    desc: "We're securely processing your document.",
  },
  verified: {
    label: "Document verified",
    badgeClass: "verified",
    desc: "Document successfully verified and accepted",
  },
  under_review: {
    label: "Under Review",
    badgeClass: "under_review",
    desc: "Your document is being reviewed. Our compliance team is completing a standard quality check.",
  },
  manual_review: {
    label: "Under Review",
    badgeClass: "manual_review",
    desc: "Your document is being reviewed. Our compliance team is completing a standard quality check.",
  },
  resubmit: {
    label: "Action Required",
    badgeClass: "resubmit",
    desc: "Please upload a replacement document.",
  },
  rejected: {
    label: "Action Required",
    badgeClass: "rejected",
    desc: "Please upload a replacement document.",
  },
  failed: {
    label: "Action Required",
    badgeClass: "failed",
    desc: "Unable to process the file. Please upload a clear replacement document.",
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

  // Modal upload state
  const [activeUploadDoc, setActiveUploadDoc] = useState<PortalDocument | null>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false);
  const [modalUploading, setModalUploading] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isModalResubmission, setIsModalResubmission] = useState<boolean>(false);

  // Upload & status messages per slot
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);
  const [docMessages, setDocMessages] = useState<
    Record<string, { text: string; ok: boolean }>
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
              text: res.message || "Please upload a replacement document.",
              ok: false,
            },
          }));
        } else {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: "Your document is being reviewed.", ok: true },
          }));
        }
      } catch {
        clearInterval(interval);
        delete pollTimers.current[docType];
      }
    }, 3000);

    pollTimers.current[docType] = interval;
  };

  // Open upload modal for a specific document
  const openUploadModal = (doc: PortalDocument, isResubmit = false) => {
    setActiveUploadDoc(doc);
    setIsModalResubmission(isResubmit);
    setModalError(null);
    setIsUploadModalOpen(true);
  };

  // Upload handler called from UploadModal
  const handleModalUpload = async (file: File) => {
    if (!token || !activeUploadDoc) return;
    setModalUploading(true);
    setModalError(null);
    setUploadingDoc(activeUploadDoc.doc_type);

    try {
      const res = await uploadDocument(token, activeUploadDoc.doc_type, file);
      setModalUploading(false);
      setIsUploadModalOpen(false);
      setUploadingDoc(null);

      // Immediately reflect processing state in local UI
      setPortal((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          documents: prev.documents.map((d) =>
            d.doc_type === activeUploadDoc.doc_type
              ? { ...d, state: "processing", document_id: res.document_id }
              : d
          ),
        };
      });

      setDocMessages((prev) => ({
        ...prev,
        [activeUploadDoc.doc_type]: {
          text: "We're securely processing your document.",
          ok: true,
        },
      }));

      // Initiate status polling
      pollStatus(activeUploadDoc.doc_type, res.document_id);
    } catch (err: unknown) {
      setModalUploading(false);
      setUploadingDoc(null);
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setModalError(msg);
      setDocMessages((prev) => ({
        ...prev,
        [activeUploadDoc.doc_type]: { text: msg, ok: false },
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
            style={{ textAlign: "center", padding: "56px 24px" }}
          >
            <div
              className="processing-spinner"
              style={{ margin: "0 auto 16px", width: 32, height: 32 }}
            />
            <h2 style={{ fontSize: 18, margin: "0 0 8px", fontWeight: 700 }}>
              Accessing Secure Portal…
            </h2>
            <p className="customer-hero-desc" style={{ fontSize: 14, margin: "0 auto" }}>
              Verifying encrypted session and retrieving document checklist…
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
                gap: 12,
                color: "var(--bad, #D95757)",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "var(--bad-bg, rgba(217, 87, 87, 0.12))",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <IconAlertCircle size={24} />
              </div>
              <h2 style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
                Unable to Access Portal
              </h2>
            </div>
            <p
              style={{
                color: "var(--ink-secondary, #526866)",
                fontSize: 14,
                lineHeight: 1.6,
                margin: "0 0 24px",
              }}
            >
              {error ||
                "Unable to access the verification portal. Your link may have expired or been completed."}
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
                width: 60,
                height: 60,
                borderRadius: "50%",
                background: "var(--acc-bg, rgba(7, 94, 91, 0.12))",
                color: "var(--acc, #075E5B)",
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
                color: "var(--ink, #123B3A)",
                margin: "0 0 8px",
              }}
            >
              Email Verification
            </h1>
            <p
              style={{
                color: "var(--ink-secondary, #526866)",
                fontSize: 14,
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              For your privacy and security, please enter the one-time passcode sent to your registered email before uploading documents.
            </p>

            {portal.masked_email && (
              <div
                style={{
                  background: "var(--card-subtle, #FAF7F0)",
                  border: "1px solid var(--line, #DDE5DE)",
                  padding: "10px 16px",
                  borderRadius: 8,
                  fontSize: 13,
                  color: "var(--ink, #123B3A)",
                  marginBottom: 18,
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
                    color: "var(--mut, #687F7D)",
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
                <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
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
    <div className="customer-app-root" id="main-content">
      <main className="customer-content-wrap" id="portal-container">
        {/* Verification Completed Screen */}
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
              Thank you, <strong>{portal.first_name}</strong>. All requested identity and business documents have been verified and confirmed. No further action is required from you.
            </p>

            {/* Checklist Summary */}
            <div className="complete-checklist-summary">
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--mut, #687F7D)",
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
                      color: "var(--ink, #123B3A)",
                    }}
                  >
                    <IconCheckCircle2 size={16} color="var(--acc, #075E5B)" />
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
                color="var(--acc, #075E5B)"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--ink, #123B3A)",
                    marginBottom: 4,
                  }}
                >
                  🔒 AES-256-GCM Encryption &amp; Automated 7-Day Purge
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-secondary, #526866)",
                    lineHeight: 1.5,
                  }}
                >
                  All uploaded document files and OCR data extracts are cryptographically isolated and scheduled for permanent deletion within 7 days.
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
                marginTop: 14,
                fontSize: 13,
              }}
            >
              <IconCheck size={16} />
              <span>Case verified. Secure customer session finalized.</span>
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
          /* Active Case Workspace */
          <>
            {/* PART 2 WELCOME SECTION */}
            <div className="portal-welcome-section">
              <div className="portal-welcome-meta">
                <span className="portal-welcome-badge">
                  <IconShieldCheck size={13} />
                  <span>Secure Document Workspace</span>
                </span>
                <h1 className="portal-welcome-title">
                  Welcome, {portal.first_name}
                </h1>
                <p className="portal-welcome-desc">
                  Complete your document submission below. Your documents are securely transmitted, verified, and protected under the DPDP Act 2023.
                </p>
              </div>

              <div className="portal-welcome-status-pill">
                <span
                  className={`portal-case-badge ${portal.case_status}`}
                  id="portal-case-status-badge"
                >
                  {portal.case_status === "in_progress"
                    ? "Case In Progress"
                    : portal.case_status}
                </span>
              </div>
            </div>

            {/* PART 2 PROGRESS SECTION */}
            <div className="portal-progress-card" id="portal-progress-section">
              <div className="portal-progress-meta-row">
                <div className="portal-progress-count-headline">
                  <strong>{verifiedCount} of {total} documents completed</strong>
                  <span className="portal-progress-percent-chip">
                    {progressPercent}% Complete
                  </span>
                </div>
                <div className="portal-progress-remaining-text">
                  {portal.pending_count === 0 ? (
                    <span style={{ color: "var(--acc, #075E5B)", fontWeight: 700 }}>
                      All documents verified
                    </span>
                  ) : (
                    <span>
                      <strong>{portal.pending_count}</strong> {portal.pending_count === 1 ? "document" : "documents"} remaining
                    </span>
                  )}
                </div>
              </div>

              {/* Visual Progress Bar */}
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

              {/* Progress Detail Badges */}
              <div className="portal-progress-breakdown">
                <div className="progress-stat-item">
                  <span className="stat-label">Total Required</span>
                  <span className="stat-val">{total}</span>
                </div>
                <div className="progress-stat-item verified-stat">
                  <span className="stat-label">Verified</span>
                  <span className="stat-val">{verifiedCount}</span>
                </div>
                <div className="progress-stat-item pending-stat">
                  <span className="stat-label">Pending</span>
                  <span className="stat-val">{portal.pending_count}</span>
                </div>
              </div>

              {!isOpen && (
                <div
                  className="msg err"
                  role="alert"
                  style={{
                    marginTop: 16,
                    padding: "12px 16px",
                    borderRadius: 8,
                  }}
                >
                  This verification case has expired or closed. Further uploads are no longer permitted.
                </div>
              )}
            </div>

            {/* PART 2 DOCUMENT CHECKLIST */}
            <div id="document-cards-list" className="customer-docs-list">
              <div className="customer-docs-header-row">
                <h2 className="customer-docs-section-title">
                  Required Documents
                </h2>
                <span className="customer-docs-section-hint">
                  PDF, PNG, JPG (up to {portal.max_upload_mb} MB)
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
                const isPending = doc.state === "pending_upload";

                const statusConfig =
                  CUSTOMER_STATE_CONFIG[doc.state] || {
                    label: doc.state,
                    badgeClass: doc.state,
                    desc: "",
                  };

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
                        : isRejection || isFailed
                        ? "state-resubmit"
                        : ""
                    }`}
                  >
                    <div className="doc-card-header">
                      <div className="doc-card-title-group">
                        <div
                          className={`doc-card-icon-wrap ${
                            isVerified
                              ? "verified"
                              : isRejection || isFailed
                              ? "resubmit"
                              : isUnderReview
                              ? "review"
                              : "default"
                          }`}
                        >
                          <IconFileText size={20} />
                        </div>
                        <div>
                          <h3 className="doc-card-title">{doc.label}</h3>
                          <div className="doc-card-slot-meta">
                            Slot: <span className="doc-card-slot-chip">{doc.doc_type}</span>
                          </div>
                        </div>
                      </div>

                      <div className="doc-card-status-action-group">
                        <span
                          className={`doc-state-tag ${
                            isUploading ? "uploading" : statusConfig.badgeClass
                          }`}
                        >
                          {isUploading ? "Uploading…" : statusConfig.label}
                        </span>

                        {/* Primary Upload CTA Button */}
                        {isOpen && isPending && (
                          <button
                            type="button"
                            className="customer-access-btn doc-card-action-btn"
                            onClick={() => openUploadModal(doc, false)}
                            id={`upload-btn-${doc.doc_type}`}
                          >
                            <IconUploadCloud size={15} />
                            <span>Upload Document</span>
                          </button>
                        )}

                        {/* Resubmit CTA Button */}
                        {isOpen && (isRejection || isFailed) && (
                          <button
                            type="button"
                            className="resubmit-btn doc-card-action-btn"
                            onClick={() => openUploadModal(doc, true)}
                            id={`resubmit-btn-${doc.doc_type}`}
                          >
                            <IconUploadCloud size={15} />
                            <span>Upload Again</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* State: Verified */}
                    {isVerified && (
                      <div className="verified-success-box">
                        <div className="verified-icon-check">
                          <IconCheck size={16} />
                        </div>
                        <div>
                          <div className="state-headline success">
                            Document verified
                          </div>
                          <div className="state-subtext">
                            Transmitted securely and encrypted with AES-256-GCM. Scheduled for automated purge in 7 days.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* State: Processing & OCR */}
                    {isProcessing && (
                      <div className="processing-pulse-banner">
                        <div className="processing-spinner" />
                        <div>
                          <div className="state-headline processing">
                            We're securely processing your document.
                          </div>
                          <div className="state-subtext">
                            Checking document readability and validity. This typically takes 5–15 seconds.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* State: Manual Review (Calm amber, zero fraud scores) */}
                    {isUnderReview && (
                      <div className="manual-review-box">
                        <IconAlertTriangle
                          size={20}
                          color="var(--warn, #C58A2B)"
                          style={{ flexShrink: 0, marginTop: 2 }}
                        />
                        <div>
                          <div className="state-headline warning">
                            Your document is being reviewed.
                          </div>
                          <div className="state-subtext">
                            Our compliance team is completing a standard quality check. No action is needed right now.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* State: Resubmit Required / Rejected */}
                    {(isRejection || isFailed) && (
                      <div className="rejection-guidance-box" role="alert">
                        <div className="rejection-title-row">
                          <IconAlertCircle size={18} />
                          <span>Please upload a replacement document.</span>
                        </div>
                        <p className="rejection-text">
                          Ensure the document is clear, well-lit, all text is legible, and it matches the requested <strong>{doc.label}</strong>.
                        </p>
                      </div>
                    )}

                    {/* Per-document status or error message */}
                    {statusMessage && (
                      <div
                        className={`msg ${statusMessage.ok ? "ok" : "err"}`}
                        style={{
                          marginTop: 12,
                          padding: "8px 14px",
                          borderRadius: 8,
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

            {/* PART 2 SECURITY & TRUST MESSAGE */}
            <div className="customer-trust-section">
              <div className="trust-indicator-card">
                <div className="trust-indicator-icon">
                  <IconLock size={18} color="var(--acc, #075E5B)" />
                </div>
                <div>
                  <h4 className="trust-indicator-title">🔒 Encrypted</h4>
                  <p className="trust-indicator-desc">
                    All document bytes are encrypted with AES-256-GCM before reaching storage.
                  </p>
                </div>
              </div>

              <div className="trust-indicator-card">
                <div className="trust-indicator-icon">
                  <IconShieldCheck size={18} color="var(--acc, #075E5B)" />
                </div>
                <div>
                  <h4 className="trust-indicator-title">🛡 Private</h4>
                  <p className="trust-indicator-desc">
                    Private enclave processing compliant with India's DPDP Act 2023.
                  </p>
                </div>
              </div>

              <div className="trust-indicator-card">
                <div className="trust-indicator-icon">
                  <IconCheckCircle2 size={18} color="var(--acc, #075E5B)" />
                </div>
                <div>
                  <h4 className="trust-indicator-title">✓ Secure Processing</h4>
                  <p className="trust-indicator-desc">
                    Stateless OCR verification with automatic permanent deletion within 7 days.
                  </p>
                </div>
              </div>
            </div>

            {/* PART 4 PRIVACY / DATA DELETION FOOTER */}
            <div className="portal-privacy-footer-card" id="portal-privacy-card">
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div className="privacy-footer-icon-badge">
                  <IconShieldCheck size={22} />
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink, #123B3A)" }}>
                      Privacy &amp; Data Rights • DPDP Act 2023
                    </span>
                    <span className="privacy-trust-pill green" style={{ fontSize: 10, padding: "2px 8px" }}>
                      Active Consent
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-secondary, #526866)", marginTop: 2 }}>
                    You maintain the legal right to inspect your processing records, withdraw consent, or request permanent deletion at any time.
                  </div>
                </div>
              </div>

              <Link
                to="/privacy"
                className="consent-btn-decline"
                id="portal-manage-privacy-link"
                style={{
                  textDecoration: "none",
                  fontSize: 13,
                  padding: "9px 16px",
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  fontWeight: 600,
                }}
              >
                Request Data Deletion
              </Link>
            </div>
          </>
        )}

        {/* Security & Retention Micro-Notice */}
        <p
          className="customer-footer"
          style={{
            marginTop: 28,
            justifyContent: "center",
            textAlign: "center",
            color: "var(--mut, #687F7D)",
            fontSize: 12,
          }}
        >
          Accepted formats: {portal.allowed_types.join(", ").toUpperCase()} (up to {portal.max_upload_mb} MB each). All files are encrypted using AES-256-GCM and permanently deleted after verification.
        </p>
      </main>

      {/* DEDICATED UPLOAD MODAL */}
      <UploadModal
        isOpen={isUploadModalOpen}
        doc={activeUploadDoc}
        maxUploadMb={portal.max_upload_mb}
        allowedTypes={portal.allowed_types}
        onClose={() => {
          if (!modalUploading) {
            setIsUploadModalOpen(false);
            setModalError(null);
          }
        }}
        onUpload={handleModalUpload}
        isUploading={modalUploading}
        errorMessage={modalError}
        isResubmission={isModalResubmission}
      />
    </div>
  );
};
