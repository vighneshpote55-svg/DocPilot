import React, { useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { requestPrivacy } from "../api";
import { useDialogA11y } from "../utils/a11yUtils";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconLock,
  IconMail,
  IconMoon,
  IconShield,
  IconShieldCheck,
  IconSun,
  IconTrash2,
} from "../components/admin/AdminIcons";

export const PrivacyPage: React.FC = () => {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("docpilot_theme") as "dark" | "light") || "dark";
  });
  const [email, setEmail] = useState<string>("");
  const [action, setAction] = useState<"withdraw" | "delete">("delete");
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submittedEmail, setSubmittedEmail] = useState<string>("");
  const [submittedAction, setSubmittedAction] = useState<"withdraw" | "delete">("delete");
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [directToken, setDirectToken] = useState<string>("");

  const confirmModalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(showConfirmModal, () => {
    if (!submitting) setShowConfirmModal(false);
  }, confirmModalRef);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("docpilot_theme", next);
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  };

  const handleOpenConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatusMsg(null);
    setShowConfirmModal(true);
  };

  const handleExecuteRequest = async () => {
    setShowConfirmModal(false);
    setSubmitting(true);
    setStatusMsg(null);

    try {
      const res = await requestPrivacy(email.trim(), action);
      setSubmittedEmail(email.trim());
      setSubmittedAction(action);
      setStatusMsg({
        text: res.message || "If this email is registered, a confirmation link has been sent.",
        ok: true,
      });
      setSubmitting(false);
    } catch (err: unknown) {
      setStatusMsg({
        text: err instanceof Error ? err.message : "Failed to submit privacy request.",
        ok: false,
      });
      setSubmitting(false);
    }
  };

  const handleDirectTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const token = directToken.trim().replace(/^.*\/privacy\/confirm\//, "");
    if (token) {
      navigate(`/privacy/confirm/${encodeURIComponent(token)}`);
    }
  };

  return (
    <div className={`customer-app-root ${theme === "light" ? "customer-theme-light" : ""}`} data-theme={theme}>
      <div className="customer-content-wrap">
        <header className="customer-header" style={{ maxWidth: 760, margin: "0 auto 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="portal-brand-block" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="portal-brand-icon">
              <IconShield size={20} />
            </div>
            <div>
              <div className="portal-brand-name">DocPilot</div>
              <div className="portal-brand-badge">Privacy &amp; Data Rights</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              id="theme-toggle-btn"
              onClick={toggleTheme}
              className="admin-topbar-btn"
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-label="Toggle theme"
              style={{
                background: "var(--adm-card, #10192d)",
                border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                borderRadius: 8,
                padding: "8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--adm-text, #f1f5f9)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </button>
          </div>
        </header>
        <div className="privacy-page-container" id="main-content">
          {/* Success Dispatched State */}
          {statusMsg?.ok ? (
            <div className="privacy-success-box" id="privacy-dispatched-card">
              <div className="privacy-success-icon">
                <IconMail size={32} />
              </div>
              <h2 className="privacy-hero-title" style={{ fontSize: 24 }}>
                Verification Link Dispatched
              </h2>
              <p className="privacy-hero-desc" style={{ maxWidth: 520, margin: "0 auto 20px" }}>
                If <strong>{submittedEmail}</strong> is registered in our secure enclave, a cryptographic confirmation link has been dispatched.
                For your protection, the link will expire in <strong>30 minutes</strong>.
              </p>

              <div
                style={{
                  background: "var(--adm-card, #10192d)",
                  border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                  borderRadius: 12,
                  padding: "16px 20px",
                  textAlign: "left",
                  maxWidth: 480,
                  margin: "0 auto 24px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--adm-text, #f1f5f9)", marginBottom: 6 }}>
                  {submittedAction === "delete" ? (
                    <>
                      <IconTrash2 size={16} color="var(--adm-danger, #ef4444)" />
                      <span>Pending Action: Immediate Permanent Erasure</span>
                    </>
                  ) : (
                    <>
                      <IconAlertTriangle size={16} color="var(--adm-warn, #f59e0b)" />
                      <span>Pending Action: Consent Withdrawal &amp; Halt</span>
                    </>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--adm-text-secondary, #94a3b8)", lineHeight: 1.5 }}>
                  {submittedAction === "delete"
                    ? "Clicking the link in your email will cryptographically purge all encrypted document files, temporary OCR extracts, and active credentials."
                    : "Clicking the link in your email will stop all verification workflows and suppress future automated reminder emails."}
                </div>
              </div>

              {/* Direct Token Jump Utility */}
              <div
                style={{
                  background: "rgba(15, 23, 42, 0.4)",
                  border: "1px dashed var(--adm-border, rgba(59, 130, 246, 0.2))",
                  borderRadius: 12,
                  padding: "18px 20px",
                  maxWidth: 480,
                  margin: "0 auto 24px",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--adm-text-muted, #94a3b8)", textTransform: "uppercase", marginBottom: 8 }}>
                  Already have your confirmation token or link?
                </div>
                <form onSubmit={handleDirectTokenSubmit} style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    placeholder="Paste confirmation token or URL"
                    value={directToken}
                    onChange={(e) => setDirectToken(e.target.value)}
                    className="privacy-email-input"
                    id="direct-privacy-token-input"
                    style={{ fontSize: 13, padding: "8px 12px" }}
                  />
                  <button
                    type="submit"
                    className="consent-btn-accept"
                    disabled={!directToken.trim()}
                    id="direct-privacy-token-submit"
                    style={{ fontSize: 12, padding: "8px 14px", flexShrink: 0 }}
                  >
                    Confirm
                  </button>
                </form>
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
                <Link to="/" className="consent-btn-decline" style={{ textDecoration: "none", fontSize: 13 }}>
                  Return to Home
                </Link>
                <button
                  type="button"
                  className="customer-access-btn"
                  onClick={() => {
                    setStatusMsg(null);
                    setEmail("");
                  }}
                  style={{ fontSize: 13 }}
                >
                  Submit Another Request
                </button>
              </div>
            </div>
          ) : (
            /* Request Initiation Card */
            <div className="privacy-hero-card" id="privacy-card">
              <div className="privacy-badge-group">
                <span className="privacy-trust-pill green">
                  <IconShieldCheck size={13} />
                  <span>India DPDP Act 2023 Compliant</span>
                </span>
                <span className="privacy-trust-pill">
                  <IconLock size={12} />
                  <span>256-Bit SSL Enclave</span>
                </span>
                <span className="privacy-trust-pill amber">
                  <IconShield size={12} />
                  <span>Automated 7-Day Purge</span>
                </span>
              </div>

              <h1 className="privacy-hero-title">Data Privacy &amp; Customer Rights</h1>
              <p className="privacy-hero-desc">
                DocPilot protects your privacy through hardware-grade encryption, zero clear-text persistence, and automated data destruction.
                Under the <strong>Digital Personal Data Protection Act, 2023</strong>, you retain absolute authority to withdraw consent or demand immediate erasure.
              </p>

              <form onSubmit={handleOpenConfirm}>
                {/* Action Selector Grid */}
                <div className="privacy-input-label" style={{ marginBottom: 10 }}>
                  Select Privacy Right to Exercise
                </div>

                <div className="privacy-action-grid" role="radiogroup" aria-label="Privacy Action Options">
                  {/* Option 1: Withdraw Consent */}
                  <div
                    className={`privacy-action-option ${action === "withdraw" ? "active" : ""}`}
                    onClick={() => setAction("withdraw")}
                    role="radio"
                    aria-checked={action === "withdraw"}
                    id="privacy-option-withdraw"
                  >
                    <div className="privacy-option-header">
                      <div className="privacy-option-icon">
                        <IconAlertTriangle size={20} color="var(--adm-primary, #60a5fa)" />
                      </div>
                      <div className="privacy-radio-circle">
                        {action === "withdraw" && <div className="privacy-radio-dot" />}
                      </div>
                    </div>
                    <div className="privacy-option-title">Withdraw Consent</div>
                    <div className="privacy-option-sub">
                      Immediately halts document verification and stops reminder emails. Files are scheduled for deletion after statutory retention.
                    </div>
                  </div>

                  {/* Option 2: Permanently Delete Data Now */}
                  <div
                    className={`privacy-action-option ${action === "delete" ? "danger-active" : ""}`}
                    onClick={() => setAction("delete")}
                    role="radio"
                    aria-checked={action === "delete"}
                    id="privacy-option-delete"
                  >
                    <div className="privacy-option-header">
                      <div className="privacy-option-icon danger">
                        <IconTrash2 size={20} />
                      </div>
                      <div className="privacy-radio-circle">
                        {action === "delete" && <div className="privacy-radio-dot" />}
                      </div>
                    </div>
                    <div className="privacy-option-title" style={{ color: action === "delete" ? "var(--adm-danger, #ef4444)" : undefined }}>
                      Delete My Data Now
                    </div>
                    <div className="privacy-option-sub">
                      Immediate cryptographic wipe of all encrypted files, temporary OCR text extracts, and customer credentials from storage.
                    </div>
                  </div>
                </div>

                {/* Registered Email Input */}
                <div className="privacy-input-group">
                  <label htmlFor="privacy-email" className="privacy-input-label">
                    Registered Email Address
                  </label>
                  <input
                    id="privacy-email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="Enter the email address provided during onboarding"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="privacy-email-input"
                  />
                </div>

                {/* Anti-Enumeration Notice */}
                <div className="privacy-enumeration-notice">
                  <IconLock size={16} color="var(--adm-primary, #60a5fa)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <strong>Anti-Enumeration Protection:</strong> To prevent third-party profiling, DocPilot will never disclose whether an email exists in our records.
                    If valid, a secure one-time cryptographic confirmation link will be sent to the address provided.
                  </div>
                </div>

                {/* Error Banner */}
                {statusMsg && !statusMsg.ok && (
                  <div className="msg err" role="alert" style={{ marginBottom: 18 }} id="privacy-error-banner">
                    {statusMsg.text}
                  </div>
                )}

                {/* Submit Action */}
                <button
                  type="submit"
                  className={action === "delete" ? "consent-btn-accept" : "consent-btn-accept"}
                  style={{
                    width: "100%",
                    padding: "14px 20px",
                    fontSize: 14,
                    background: action === "delete" ? "linear-gradient(135deg, #ef4444, #b91c1c)" : undefined,
                    boxShadow: action === "delete" ? "0 4px 14px rgba(239, 68, 68, 0.4)" : undefined,
                  }}
                  id="privacy-submit-btn"
                >
                  <IconMail size={16} />
                  <span>Send Secure Confirmation Link</span>
                  <IconArrowRight size={16} />
                </button>
              </form>
            </div>
          )}

          {/* Pre-Submission Interactive Confirmation Dialog Modal */}
          {showConfirmModal && (
            <div
              className="privacy-dialog-backdrop"
              id="privacy-request-confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="privacy-dialog-title"
              onClick={(e) => {
                if (e.target === e.currentTarget && !submitting) setShowConfirmModal(false);
              }}
            >
              <div className="privacy-dialog-card" ref={confirmModalRef}>
                <div className={`privacy-dialog-icon ${action === "delete" ? "" : "amber"}`}>
                  {action === "delete" ? <IconTrash2 size={26} /> : <IconAlertTriangle size={26} />}
                </div>

                <h3 className="privacy-dialog-title" id="privacy-dialog-title">
                  {action === "delete" ? "Confirm Data Erasure Request" : "Confirm Consent Withdrawal"}
                </h3>

                <p className="privacy-dialog-desc">
                  You are requesting to <strong>{action === "delete" ? "permanently delete all documents and data" : "withdraw consent and stop processing"}</strong> for:
                  <br />
                  <span style={{ display: "inline-block", marginTop: 8, padding: "4px 12px", borderRadius: 6, background: "var(--adm-card, #10192d)", color: "var(--adm-primary, #60a5fa)", fontFamily: "monospace", fontSize: 13 }}>
                    {email}
                  </span>
                </p>

                <p style={{ fontSize: 12, color: "var(--adm-text-muted, #94a3b8)", lineHeight: 1.5, margin: "0 0 20px" }}>
                  A secure single-use verification token will be sent to this email. The action will only execute once confirmed via that link.
                </p>

                <div className="admin-dialog-actions">
                  <button
                    type="button"
                    className="consent-btn-decline"
                    onClick={() => setShowConfirmModal(false)}
                    id="btn-cancel-privacy-dialog"
                    style={{ fontSize: 13, padding: "8px 16px" }}
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    className={action === "delete" ? "consent-btn-accept" : "consent-btn-accept"}
                    onClick={handleExecuteRequest}
                    disabled={submitting}
                    id="btn-submit-privacy-request"
                    style={{
                      fontSize: 13,
                      padding: "8px 18px",
                      background: action === "delete" ? "#ef4444" : undefined,
                    }}
                  >
                    {submitting ? (
                      <>
                        <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                        Sending Link…
                      </>
                    ) : (
                      <>
                        <IconCheck size={14} />
                        Yes, Send Verification Link
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Quick Footer Links */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 32,
              fontSize: 12,
              color: "var(--adm-text-muted, #94a3b8)",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <Link to="/" style={{ color: "var(--adm-text-muted, #94a3b8)", textDecoration: "none" }}>
              ← Return to DocPilot Home
            </Link>
            <div style={{ display: "flex", gap: 16 }}>
              <Link to="/admin" style={{ color: "var(--adm-text-muted, #94a3b8)", textDecoration: "none" }}>
                Staff Enclave Sign In
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
