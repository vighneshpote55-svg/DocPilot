import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { confirmPrivacy } from "../api";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle2,
  IconLock,
  IconMoon,
  IconShield,
  IconShieldCheck,
  IconSun,
  IconTrash2,
} from "../components/admin/AdminIcons";

export const PrivacyConfirmPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("docpilot_theme") as "dark" | "light") || "dark";
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [completedAction, setCompletedAction] = useState<"delete" | "withdraw" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [executedAt, setExecutedAt] = useState<string>("");

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

  const handleExecute = async () => {
    if (!token) return;
    setShowConfirmModal(false);
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await confirmPrivacy(token);
      setCompletedAction(res.completed || "delete");
      setExecutedAt(new Date().toUTCString());
      setSubmitting(false);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Invalid or expired link. This token may have already been consumed or timed out."
      );
      setSubmitting(false);
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
              <div className="portal-brand-badge">Privacy Confirmation Enclave</div>
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
        <div className="privacy-page-container">
          {/* State 1: Completed Success State */}
          {completedAction ? (
            <div className="privacy-success-box" id="privacy-confirm-success-card">
              <div className="privacy-success-icon">
                <IconCheckCircle2 size={36} color="var(--adm-success, #10b981)" />
              </div>

              <h2 className="privacy-hero-title" style={{ fontSize: 24 }}>
                {completedAction === "delete"
                  ? "Customer Data Permanently Erased"
                  : "Consent Successfully Withdrawn"}
              </h2>

              <p className="privacy-hero-desc" style={{ maxWidth: 520, margin: "0 auto 20px" }}>
                {completedAction === "delete"
                  ? "All encrypted document files in private storage, temporary OCR results, and active session tokens have been permanently purged. Your customer profile has been anonymized."
                  : "Consent has been officially revoked. Document verification workflows and reminder schedulers have been stopped immediately. Retained records will be purged per the statutory retention timeline."}
              </p>

              {/* Immutable Ledger Certificate Box */}
              <div
                style={{
                  background: "var(--adm-card, #10192d)",
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                  borderRadius: 12,
                  padding: "16px 20px",
                  textAlign: "left",
                  maxWidth: 480,
                  margin: "0 auto 24px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--adm-success, #10b981)" }}>
                    ✓ Cryptographic Execution Confirmed
                  </span>
                  <span style={{ fontSize: 11, color: "var(--adm-text-muted, #94a3b8)", fontFamily: "monospace" }}>
                    EVENT: {completedAction === "delete" ? "privacy_delete" : "privacy_withdraw"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--adm-text-secondary, #94a3b8)", lineHeight: 1.6 }}>
                  • Immutable consent ledger record recorded.
                  <br />
                  • Active customer access tokens revoked.
                  <br />
                  • Completed at: <strong style={{ color: "var(--adm-text, #f1f5f9)" }}>{executedAt}</strong>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
                <Link to="/" className="consent-btn-accept" style={{ textDecoration: "none", fontSize: 13 }} id="privacy-success-home-link">
                  Return to DocPilot Home
                </Link>
              </div>
            </div>
          ) : errorMessage ? (
            /* State 2: Error / Expired Token State */
            <div className="privacy-error-box" id="privacy-confirm-error-card">
              <div className="privacy-error-icon">
                <IconAlertCircle size={36} />
              </div>

              <h2 className="privacy-hero-title" style={{ fontSize: 24, color: "var(--adm-danger, #ef4444)" }}>
                Verification Link Invalid or Expired
              </h2>

              <p className="privacy-hero-desc" style={{ maxWidth: 520, margin: "0 auto 20px" }}>
                {errorMessage}
              </p>

              <div
                style={{
                  background: "var(--adm-card, #10192d)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  borderRadius: 12,
                  padding: "16px 20px",
                  textAlign: "left",
                  maxWidth: 480,
                  margin: "0 auto 24px",
                  fontSize: 12,
                  color: "var(--adm-text-secondary, #94a3b8)",
                  lineHeight: 1.5,
                }}
              >
                <strong>Security Protection:</strong> For your safety, privacy verification tokens are strictly single-use and expire within <strong>30 minutes</strong> of issuance. If your link has expired, you can request a new one at any time.
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
                <Link to="/privacy" className="consent-btn-accept" style={{ textDecoration: "none", fontSize: 13 }} id="btn-request-new-privacy-link">
                  Request New Verification Link
                </Link>
                <Link to="/" className="consent-btn-decline" style={{ textDecoration: "none", fontSize: 13 }}>
                  Return to Home
                </Link>
              </div>
            </div>
          ) : (
            /* State 3: Ready for Confirmation */
            <div className="privacy-hero-card" id="privacy-confirm-card">
              <div className="privacy-badge-group">
                <span className="privacy-trust-pill amber">
                  <IconAlertTriangle size={13} />
                  <span>Irreversible Privacy Action</span>
                </span>
                <span className="privacy-trust-pill">
                  <IconLock size={12} />
                  <span>Cryptographic Token Verified</span>
                </span>
              </div>

              <h1 className="privacy-hero-title">Confirm Your Privacy Request</h1>
              <p className="privacy-hero-desc">
                You have accessed a secure, single-use privacy authorization link. Confirming this action will immediately execute your requested privacy directive.
              </p>

              {/* Warning Box */}
              <div
                style={{
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  borderRadius: 12,
                  padding: "18px 20px",
                  marginBottom: 24,
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--adm-danger, #ef4444)", marginBottom: 8 }}>
                  <IconAlertTriangle size={16} />
                  <span>Important Confirmation Notice</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--adm-text-secondary, #94a3b8)", lineHeight: 1.6 }}>
                  Once executed, this action cannot be revoked or undone. If your request is for <strong>Data Erasure</strong>, all stored encrypted files and OCR evidence will be permanently destroyed.
                  If your request is for <strong>Consent Withdrawal</strong>, all active verification pipelines will be stopped immediately.
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", gap: 14, justifyContent: "flex-end" }}>
                <Link to="/" className="consent-btn-decline" style={{ textDecoration: "none", fontSize: 13 }}>
                  Cancel &amp; Go Back
                </Link>
                <button
                  type="button"
                  className="consent-btn-accept"
                  style={{
                    background: "linear-gradient(135deg, #ef4444, #b91c1c)",
                    boxShadow: "0 4px 14px rgba(239, 68, 68, 0.4)",
                    fontSize: 13,
                  }}
                  onClick={() => setShowConfirmModal(true)}
                  disabled={submitting}
                  id="privacy-confirm-btn"
                >
                  <IconShieldCheck size={16} />
                  <span>Confirm Privacy Action</span>
                </button>
              </div>
            </div>
          )}

          {/* Interactive Modal Confirmation Dialog */}
          {showConfirmModal && (
            <div className="privacy-dialog-backdrop" id="privacy-confirm-execute-modal" role="dialog" aria-modal="true">
              <div className="privacy-dialog-card">
                <div className="privacy-dialog-icon">
                  <IconTrash2 size={26} />
                </div>

                <h3 className="privacy-dialog-title">Execute Privacy Directive?</h3>

                <p className="privacy-dialog-desc">
                  Are you absolutely certain you want to proceed? This will immediately consume your one-time token and execute the privacy action in our secure enclave.
                </p>

                <div className="admin-dialog-actions">
                  <button
                    type="button"
                    className="consent-btn-decline"
                    onClick={() => setShowConfirmModal(false)}
                    id="btn-cancel-execute-dialog"
                    style={{ fontSize: 13, padding: "8px 16px" }}
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    className="consent-btn-accept"
                    style={{ background: "#ef4444", fontSize: 13, padding: "8px 18px" }}
                    onClick={handleExecute}
                    disabled={submitting}
                    id="confirm-privacy-execute-btn"
                  >
                    {submitting ? (
                      <>
                        <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                        Executing…
                      </>
                    ) : (
                      <>
                        <IconCheck size={14} />
                        Yes, Execute Now
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
