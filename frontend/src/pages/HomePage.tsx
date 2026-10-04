import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  IconShieldCheck,
  IconLock,
  IconFileText,
  IconArrowRight,
  IconClock,
  IconEye,
  IconShield,
} from "../components/admin/AdminIcons";

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [tokenInput, setTokenInput] = useState<string>("");
  const [inputError, setInputError] = useState<string | null>(null);

  const handleOpenCase = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = tokenInput.trim();
    if (!raw) {
      setInputError("Please enter your verification token or paste your link.");
      return;
    }
    setInputError(null);

    // Parse full URL or bare token
    let token = raw;
    let isConsent = false;

    if (raw.includes("/consent/")) {
      const parts = raw.split("/consent/");
      token = parts[1]?.split(/[?#]/)[0] || raw;
      isConsent = true;
    } else if (raw.includes("/portal/")) {
      const parts = raw.split("/portal/");
      token = parts[1]?.split(/[?#]/)[0] || raw;
    } else if (raw.includes("/privacy/confirm/")) {
      const parts = raw.split("/privacy/confirm/");
      token = parts[1]?.split(/[?#]/)[0] || raw;
      navigate(`/privacy/confirm/${encodeURIComponent(token)}`);
      return;
    }

    if (isConsent) {
      navigate(`/consent/${encodeURIComponent(token)}`);
    } else {
      navigate(`/portal/${encodeURIComponent(token)}`);
    }
  };

  return (
    <div className="customer-app-root">
      <div className="customer-content-wrap">
        {/* Hero Section */}
        <section className="customer-hero-card" id="home-card">
          <h1 className="customer-hero-title">
            Bank-Grade Secure Document Collection
          </h1>
          <p className="customer-hero-desc">
            DocPilot provides an isolated, zero-knowledge portal for customers to upload identity
            and business documents. All submissions are encrypted with AES-256-GCM, verified
            by automated rules, and permanently purged after a 7-day retention period.
          </p>

          <div className="customer-trust-badges-row">
            <div className="trust-badge-item">
              <IconShieldCheck size={14} />
              <span>AES-256-GCM Encrypted</span>
            </div>
            <div className="trust-badge-item">
              <IconLock size={14} />
              <span>Automatic 7-Day Purge</span>
            </div>
            <div className="trust-badge-item">
              <IconShield size={14} />
              <span>India DPDP Act 2023 Compliant</span>
            </div>
            <div className="trust-badge-item">
              <IconFileText size={14} />
              <span>Stateless OCR Verification</span>
            </div>
          </div>
        </section>

        {/* Direct Token / Link Access Box */}
        <section className="customer-access-card" id="access-case-section">
          <h2 className="customer-access-title">
            <IconLock size={18} color="var(--adm-primary)" />
            Access Your Verification Portal
          </h2>
          <p className="customer-access-subtitle">
            Enter the private access token or paste the secure invitation link sent to your registered email address.
          </p>

          <form onSubmit={handleOpenCase} className="customer-access-form">
            <input
              type="text"
              id="case-token-input"
              className="customer-access-input"
              placeholder="e.g. paste your email link or enter token..."
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value);
                if (inputError) setInputError(null);
              }}
              aria-label="Secure case token or invitation link"
            />
            <button
              type="submit"
              className="customer-access-btn"
              id="open-portal-btn"
            >
              <span>Access Case</span>
              <IconArrowRight size={16} />
            </button>
          </form>

          {inputError && (
            <p style={{ color: "var(--adm-danger, #ef4444)", fontSize: 13, marginTop: 10, marginBottom: 0 }}>
              {inputError}
            </p>
          )}

          <div style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 13 }}>
            <Link to="/privacy" className="customer-nav-link" id="home-privacy-link">
              Need to withdraw or delete your data? →
            </Link>
            <Link to="/admin" className="customer-nav-link" id="home-admin-link" style={{ marginLeft: "auto" }}>
              Staff Sign In
            </Link>
          </div>
        </section>

        {/* 3-Step Visual Process */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px", color: "var(--adm-text)" }}>
            How Verification Works
          </h3>

          <div className="customer-process-grid">
            <div className="process-step-card">
              <div className="process-step-num">1</div>
              <h4 className="process-step-title">Consent & Purpose</h4>
              <p className="process-step-desc">
                Review the exact list of required documents and the legal processing purpose before submitting any files.
              </p>
            </div>

            <div className="process-step-card">
              <div className="process-step-num">2</div>
              <h4 className="process-step-title">Drag & Drop Upload</h4>
              <p className="process-step-desc">
                Securely stream PDF documents or photos directly into an encrypted private storage enclave.
              </p>
            </div>

            <div className="process-step-card">
              <div className="process-step-num">3</div>
              <h4 className="process-step-title">Verify & Safe Purge</h4>
              <p className="process-step-desc">
                Automated OCR and rule checks verify authenticity in seconds. All files are permanently destroyed after 7 days.
              </p>
            </div>
          </div>
        </section>

        {/* Privacy & Security Guarantees Grid */}
        <section>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 16px", color: "var(--adm-text)" }}>
            Security & Compliance Guarantees
          </h3>

          <div className="customer-privacy-grid">
            <div className="privacy-card-item">
              <div className="privacy-card-icon">
                <IconLock size={16} />
              </div>
              <h4 className="privacy-card-title">Zero Permanent Storage</h4>
              <p className="privacy-card-desc">
                Completed files are strictly held for 7 days before an automated cascade wipes all blobs, OCR data, and hashes.
              </p>
            </div>

            <div className="privacy-card-item">
              <div className="privacy-card-icon">
                <IconShieldCheck size={16} />
              </div>
              <h4 className="privacy-card-title">Magic-Byte Validation</h4>
              <p className="privacy-card-desc">
                Every file is inspected for authentic PDF and image headers. Executables, scripts, and embedded macros are rejected.
              </p>
            </div>

            <div className="privacy-card-item">
              <div className="privacy-card-icon">
                <IconEye size={16} />
              </div>
              <h4 className="privacy-card-title">No Raw PII Storage</h4>
              <p className="privacy-card-desc">
                Extracted identity fields (Aadhaar, PAN, phone numbers) are masked before database records are saved.
              </p>
            </div>

            <div className="privacy-card-item">
              <div className="privacy-card-icon">
                <IconClock size={16} />
              </div>
              <h4 className="privacy-card-title">Stateless Processing</h4>
              <p className="privacy-card-desc">
                The extraction engine receives bytes in-memory and returns structured JSON without ever storing copies.
              </p>
            </div>
          </div>
        </section>

        {/* Customer Footer */}
        <footer className="customer-footer">
          <div>
            <span>© 2026 DocPilot Secure Document Collection System.</span>
          </div>
          <div className="customer-footer-links">
            <Link to="/privacy" className="customer-nav-link">
              Privacy Rights & Deletion
            </Link>
            <span>•</span>
            <Link to="/admin" className="customer-nav-link">
              Staff Ops
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
};
