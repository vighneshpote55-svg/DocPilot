import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getConsent, submitConsent } from "../api";
import type { ConsentInfo } from "../types";
import {
  IconShieldCheck,
  IconLock,
  IconFileText,
  IconCheck,
  IconAlertCircle,
  IconClock,
  IconArrowRight,
} from "../components/admin/AdminIcons";

export const ConsentPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [consentGranted, setConsentGranted] = useState<boolean | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const tokenError = !token ? "Missing consent link token." : null;

  useEffect(() => {
    if (!token) return;
    let ignore = false;

    getConsent(token)
      .then((data) => {
        if (!ignore) {
          setInfo(data);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!ignore) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [token]);

  const handleDecision = async (granted: boolean) => {
    if (!token) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      await submitConsent(token, granted);
      setConsentGranted(granted);
      setStatusMsg({
        text: granted
          ? "Thank you. We have sent a secure document upload link to your email."
          : "Understood. We will not process any documents for your case.",
        ok: true,
      });
      setSubmitting(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to record response.";
      setStatusMsg({ text: msg, ok: false });
      setSubmitting(false);
    }
  };

  const displayError = tokenError || error;

  if (loading && !tokenError) {
    return (
      <div className="customer-app-root">
        <div className="customer-content-wrap customer-content-narrow">
          <div className="consent-panel-card" id="consent-loading" style={{ textAlign: "center", padding: "48px 24px" }}>
            <div className="processing-spinner" style={{ margin: "0 auto 16px", width: 28, height: 28 }} />
            <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Retrieving Case Details…</h2>
            <p className="customer-hero-desc" style={{ fontSize: 14 }}>
              Connecting to secure enclave and verifying digital access token…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (displayError || !info) {
    return (
      <div className="customer-app-root">
        <div className="customer-content-wrap customer-content-narrow">
          <div className="consent-panel-card" id="consent-error">
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--adm-danger, #ef4444)", marginBottom: 12 }}>
              <IconAlertCircle size={24} />
              <h2 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>Verification Access Error</h2>
            </div>
            <p style={{ color: "var(--adm-text-secondary, #94a3b8)", fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
              {displayError || "Unable to load consent information. Your token may have expired or been revoked."}
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <Link to="/" className="customer-access-btn" style={{ textDecoration: "none" }}>
                Return to DocPilot Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Post-decision screens ---
  if (statusMsg && statusMsg.ok) {
    if (consentGranted) {
      return (
        <div className="customer-app-root">
          <div className="customer-content-wrap customer-content-narrow">
            <div className="consent-panel-card" id="consent-granted-view" style={{ textAlign: "center", padding: "40px 32px" }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  background: "var(--adm-success-bg, rgba(16, 185, 129, 0.15))",
                  border: "2px solid var(--adm-success, #10b981)",
                  color: "var(--adm-success, #10b981)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 20px",
                }}
              >
                <IconCheck size={32} />
              </div>
              <h2 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 10px", color: "var(--adm-text, #f8fafc)" }}>
                Consent Recorded Successfully
              </h2>
              <p style={{ color: "var(--adm-text-secondary, #94a3b8)", fontSize: 14, lineHeight: 1.6, maxWidth: 480, margin: "0 auto 24px" }}>
                Thank you, <strong>{info.first_name}</strong>. Your consent has been cryptographically recorded. A secure verification link has also been dispatched to your email.
              </p>

              <div
                style={{
                  background: "var(--adm-card-elevated, #14203a)",
                  border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                  borderRadius: 10,
                  padding: "14px 18px",
                  maxWidth: 480,
                  margin: "0 auto 28px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13,
                  color: "var(--adm-text-secondary, #cbd5e1)",
                  textAlign: "left",
                }}
              >
                <IconLock size={20} color="var(--adm-primary, #3b82f6)" style={{ flexShrink: 0 }} />
                <span>
                  All documents you upload will be encrypted with <strong>AES-256-GCM</strong> and automatically deleted within 7 days.
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
                <Link
                  to={`/portal/${encodeURIComponent(token || "")}`}
                  id="proceed-portal-btn"
                  className="customer-access-btn"
                  style={{ textDecoration: "none", fontSize: 15, padding: "14px 28px" }}
                >
                  Proceed to Secure Upload Portal
                  <IconArrowRight size={16} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      );
    } else {
      return (
        <div className="customer-app-root">
          <div className="customer-content-wrap customer-content-narrow">
            <div className="consent-panel-card" id="consent-declined-view" style={{ textAlign: "center", padding: "40px 32px" }}>
              <div
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: "50%",
                  background: "rgba(245, 158, 11, 0.15)",
                  border: "2px solid #f59e0b",
                  color: "#f59e0b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 20px",
                }}
              >
                <IconAlertCircle size={30} />
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 10px", color: "var(--adm-text, #f8fafc)" }}>
                Verification Request Declined
              </h2>
              <p style={{ color: "var(--adm-text-secondary, #94a3b8)", fontSize: 14, lineHeight: 1.6, maxWidth: 460, margin: "0 auto 24px" }}>
                Understood. We will not collect or process any documents for your case. If this was an accident, you may re-open the link provided in your notification.
              </p>
              <Link to="/" className="customer-access-btn" style={{ textDecoration: "none" }}>
                Return to DocPilot Home
              </Link>
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="customer-app-root">
      <div className="customer-content-wrap customer-content-narrow" id="main-content">
        <div className="consent-panel-card" id="consent-card">
          <div className="consent-header-badge">
            <IconShieldCheck size={14} />
            <span>Digital Identity Verification • DPDP Act 2023 Compliant</span>
          </div>

          <h1 className="consent-greeting-title">Hello, {info.first_name}</h1>
          <p className="consent-greeting-desc">
            To securely establish and verify your profile, we require the collection of specific verified documents. Please review the requested items and data processing terms below.
          </p>

          {/* Requested Documents Manifest */}
          <div className="consent-manifest-box">
            <div className="consent-manifest-title">
              Requested Documents ({info.documents.length})
            </div>
            <ul className="consent-manifest-list">
              {info.documents.map((doc, idx) => (
                <li key={idx} className="consent-manifest-item">
                  <IconFileText size={18} color="var(--adm-primary, #3b82f6)" />
                  <span>{doc}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Purpose & Legal Disclosure Box */}
          <div className="consent-disclosure-box">
            <div className="consent-disclosure-title">
              <IconLock size={15} />
              <span>Purpose & Processing Terms</span>
            </div>
            <p className="consent-disclosure-text">
              {info.purpose}
            </p>
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid rgba(59, 130, 246, 0.15)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--adm-text-muted, #94a3b8)",
              }}
            >
              <IconClock size={14} color="var(--adm-primary, #60a5fa)" />
              <span>
                <strong>7-Day Permanent Purge Guarantee:</strong> All document files and OCR extracts are cryptographically protected and permanently deleted within 7 days.
              </span>
            </div>
          </div>

          {/* Error Message if submit failed */}
          {statusMsg && !statusMsg.ok && (
            <div
              className="msg err"
              role="alert"
              style={{
                marginBottom: 20,
                padding: "12px 16px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "var(--adm-danger, #ef4444)",
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              {statusMsg.text}
            </div>
          )}

          {/* Interactive Consent Confirmation Checkbox */}
          <label className="consent-checkbox-wrap" htmlFor="consent-checkbox">
            <input
              type="checkbox"
              id="consent-checkbox"
              checked={consentConfirmed}
              onChange={(e) => setConsentConfirmed(e.target.checked)}
            />
            <span className="consent-checkbox-label">
              I confirm that I am <strong>{info.first_name}</strong>, and I consent to the collection and verification of the requested documents strictly for the purposes described above.
            </span>
          </label>

          {/* Action Bar */}
          <div className="consent-actions-row">
            <button
              className="consent-btn-agree"
              onClick={() => handleDecision(true)}
              disabled={!consentConfirmed || submitting}
              id="consent-agree-btn"
            >
              {submitting ? (
                <>
                  <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                  Recording Consent…
                </>
              ) : (
                <>
                  <IconCheck size={16} />
                  I Agree &amp; Proceed
                </>
              )}
            </button>

            <button
              className="consent-btn-decline"
              onClick={() => handleDecision(false)}
              disabled={submitting}
              id="consent-decline-btn"
            >
              I Do Not Agree (Decline)
            </button>
          </div>
        </div>

        {/* Security Trust Micro-Footer */}
        <div style={{ textAlign: "center", marginTop: 20, color: "var(--adm-text-muted, #64748b)", fontSize: 12 }}>
          🔒 Protected by DocPilot Bank-Grade 256-Bit SSL Enclave • India DPDP Act 2023 Compliant
        </div>
      </div>
    </div>
  );
};
