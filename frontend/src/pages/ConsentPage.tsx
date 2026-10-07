import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [consentGranted, setConsentGranted] = useState<boolean | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState<boolean>(false);
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<number>(3);

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

  // Auto-redirect timer when consent is successfully granted
  useEffect(() => {
    if (consentGranted === true && (uploadToken || token)) {
      const targetToken = uploadToken || token || "";
      if (countdown <= 0) {
        navigate(`/portal/${encodeURIComponent(targetToken)}`);
        return;
      }
      const timer = setTimeout(() => {
        setCountdown((prev) => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [consentGranted, countdown, uploadToken, token, navigate]);

  const handleDecision = async (granted: boolean) => {
    if (!token) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const res = await submitConsent(token, granted);
      setConsentGranted(granted);
      if (res.upload_token) {
        setUploadToken(res.upload_token);
      }
      setStatusMsg({
        text: granted
          ? "Thank you. Your consent has been recorded securely."
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
          <div
            className="consent-panel-card"
            id="consent-loading"
            style={{ textAlign: "center", padding: "56px 24px" }}
          >
            <div
              className="processing-spinner"
              style={{ margin: "0 auto 16px", width: 32, height: 32 }}
            />
            <h2 style={{ fontSize: 18, margin: "0 0 8px", fontWeight: 700 }}>
              Retrieving Verification Request…
            </h2>
            <p className="customer-hero-desc" style={{ fontSize: 14, margin: "0 auto" }}>
              Verifying digital access link and establishing a secure session…
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
                Verification Access Error
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
              {displayError ||
                "Unable to load consent information. Your link may have expired, already been completed, or been revoked."}
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
            <div
              className="consent-panel-card"
              id="consent-granted-view"
              style={{ textAlign: "center", padding: "48px 32px" }}
            >
              <div
                style={{
                  width: 68,
                  height: 68,
                  borderRadius: "50%",
                  background: "var(--acc-bg, rgba(7, 94, 91, 0.12))",
                  border: "2px solid var(--acc, #075E5B)",
                  color: "var(--acc, #075E5B)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 20px",
                }}
              >
                <IconCheck size={36} />
              </div>
              <h2
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  margin: "0 0 10px",
                  color: "var(--ink, #123B3A)",
                }}
              >
                Consent Recorded Successfully
              </h2>
              <p
                style={{
                  color: "var(--ink-secondary, #526866)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  maxWidth: 480,
                  margin: "0 auto 24px",
                }}
              >
                Thank you, <strong>{info.first_name}</strong>. Your consent has been cryptographically recorded under the DPDP Act 2023. You can now proceed to upload your verified documents.
              </p>

              <div
                style={{
                  background: "var(--card-subtle, #FAF7F0)",
                  border: "1px solid var(--line, #DDE5DE)",
                  borderRadius: 12,
                  padding: "16px 20px",
                  maxWidth: 480,
                  margin: "0 auto 28px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 13,
                  color: "var(--ink-secondary, #526866)",
                  textAlign: "left",
                }}
              >
                <IconLock
                  size={20}
                  color="var(--acc, #075E5B)"
                  style={{ flexShrink: 0 }}
                />
                <span>
                  All documents you upload will be protected with <strong>AES-256-GCM encryption</strong> and automatically purged within 7 days.
                </span>
              </div>

              {/* Auto redirect counter pill */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--mut, #687F7D)",
                  marginBottom: 20,
                }}
              >
                <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                <span>Redirecting to upload portal in {countdown}s…</span>
              </div>

              <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
                <Link
                  to={`/portal/${encodeURIComponent(uploadToken || token || "")}`}
                  id="proceed-portal-btn"
                  className="customer-access-btn"
                  style={{
                    textDecoration: "none",
                    fontSize: 15,
                    padding: "14px 28px",
                    fontWeight: 700,
                  }}
                >
                  Continue to Document Upload
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
            <div
              className="consent-panel-card"
              id="consent-declined-view"
              style={{ textAlign: "center", padding: "48px 32px" }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  background: "var(--warn-bg, rgba(197, 138, 43, 0.12))",
                  border: "2px solid var(--warn, #C58A2B)",
                  color: "var(--warn, #C58A2B)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 20px",
                }}
              >
                <IconAlertCircle size={32} />
              </div>
              <h2
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  margin: "0 0 10px",
                  color: "var(--ink, #123B3A)",
                }}
              >
                Verification Request Declined
              </h2>
              <p
                style={{
                  color: "var(--ink-secondary, #526866)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  maxWidth: 460,
                  margin: "0 auto 24px",
                }}
              >
                Understood. We will not collect or process any documents for your case. If you change your mind, you may reopen the secure link received in your notification.
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
          {/* Security Indicator Badge */}
          <div className="consent-header-badge" id="consent-security-badge">
            <IconShieldCheck size={14} />
            <span>Digital Identity Verification • DPDP Act 2023 Compliant</span>
          </div>

          <h1 className="consent-main-heading">Secure Document Verification</h1>

          {/* Friendly Greeting */}
          <div className="consent-greeting-title">Hello, {info.first_name}</div>
          <p className="consent-greeting-desc">
            To securely establish and verify your identity, we request the collection of the specific verified documents listed below. Please review the items and privacy terms before continuing.
          </p>

          {/* Purpose & Legal Disclosure Box */}
          <div className="consent-disclosure-box">
            <div className="consent-disclosure-title">
              <IconLock size={15} />
              <span>Purpose of Verification</span>
            </div>
            <p className="consent-disclosure-text">{info.purpose}</p>
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--line, #DDE5DE)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--mut, #687F7D)",
              }}
            >
              <IconClock size={14} color="var(--acc, #075E5B)" />
              <span>
                <strong>7-Day Retention Guarantee:</strong> Your documents are securely processed only for verification and permanently deleted within 7 days.
              </span>
            </div>
          </div>

          {/* Requested Documents Manifest in Clean Card Layout */}
          <div className="consent-manifest-box">
            <div className="consent-manifest-title">
              Requested Documents ({info.documents.length})
            </div>
            <div className="consent-doc-grid">
              {info.documents.map((doc, idx) => (
                <div key={idx} className="consent-doc-card">
                  <div className="consent-doc-icon">
                    <IconFileText size={18} color="var(--acc, #075E5B)" />
                  </div>
                  <div className="consent-doc-info">
                    <span className="consent-doc-name">{doc}</span>
                    <span className="consent-doc-status-badge">Required</span>
                  </div>
                </div>
              ))}
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

          {/* Action Row */}
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
                  Give Consent &amp; Continue
                </>
              )}
            </button>

            <button
              className="consent-btn-decline"
              onClick={() => handleDecision(false)}
              disabled={submitting}
              id="consent-decline-btn"
            >
              Decline
            </button>
          </div>
        </div>

        {/* Security Trust Micro-Footer */}
        <div
          style={{
            textAlign: "center",
            marginTop: 20,
            color: "var(--mut, #687F7D)",
            fontSize: 12,
          }}
        >
          🔒 Protected by DocPilot Bank-Grade 256-Bit SSL Enclave • India DPDP Act 2023 Compliant
        </div>
      </div>
    </div>
  );
};
