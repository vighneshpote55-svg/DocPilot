import React from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../utils/useDocumentTitle";
import {
  IconClock,
  IconFileText,
  IconLock,
  IconShield,
  IconShieldCheck,
  IconArrowRight,
} from "../components/admin/AdminIcons";

export const TermsPage: React.FC = () => {
  useDocumentTitle("Terms of Service");

  return (
    <div className="customer-app-root">
      <div className="customer-content-wrap" style={{ maxWidth: 840, padding: "32px 16px 60px" }}>
        {/* Header Block */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "var(--adm-primary, #075e5b)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#ffffff",
              }}
            >
              <IconFileText size={20} />
            </div>
            <div>
              <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, color: "var(--adm-text)" }}>
                Terms of Service &amp; Usage Policy
              </h1>
              <p style={{ margin: "2px 0 0", color: "var(--adm-text-secondary)", fontSize: 13 }}>
                Effective Date: October 2026 • DocPilot Document Verification System
              </p>
            </div>
          </div>
        </div>

        {/* Highlight Guarantee Card */}
        <div
          className="customer-hero-card"
          style={{
            padding: "20px 24px",
            marginBottom: 24,
            borderLeft: "4px solid var(--adm-primary, #075e5b)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <IconShieldCheck size={24} color="var(--adm-primary, #075e5b)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 6px", color: "var(--adm-text)" }}>
                Statutory Data Protection &amp; Minimal Retention Notice
              </h2>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
                DocPilot operates strictly as an identity and business document verification gateway under the India Digital Personal Data Protection (DPDP) Act 2023. Submitted documents are encrypted immediately upon intake with AES-256-GCM, evaluated by automated rule-based engines, and permanently deleted within 7 days.
              </p>
            </div>
          </div>
        </div>

        {/* Terms Sections */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Section 1: Scope of Use */}
          <section className="customer-access-card" style={{ padding: "20px 24px" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "var(--adm-text)", display: "flex", alignItems: "center", gap: 8 }}>
              <IconLock size={16} color="var(--adm-primary)" />
              1. Authorized Verification Scope
            </h3>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              Access to this document intake portal is restricted to individuals or business entities who have received a cryptographic, single-use invitation from an authorized verification team. You agree to submit only legitimate documents that belong to you or the organization you officially represent.
            </p>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              Providing forged, modified, or unauthorized third-party documents is strictly prohibited and constitutes grounds for immediate case rejection and statutory reporting.
            </p>
          </section>

          {/* Section 2: Permitted Formats & Integrity */}
          <section className="customer-access-card" style={{ padding: "20px 24px" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "var(--adm-text)", display: "flex", alignItems: "center", gap: 8 }}>
              <IconFileText size={16} color="var(--adm-primary)" />
              2. Acceptable Document Formats &amp; Safety Checks
            </h3>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              The portal accepts genuine PDF files and standard image formats (.PNG, .JPG, .JPEG) up to the configured size limit.
            </p>
            <ul style={{ margin: "0 0 10px", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              <li>Files undergo magic-byte signature validation to ensure type authenticity.</li>
              <li>Files containing executable payloads, embedded scripts, macros, or password protection are rejected automatically.</li>
              <li>Images must be clear, unobstructed, and legible to allow accurate optical character recognition (OCR).</li>
            </ul>
          </section>

          {/* Section 3: Stateless Processing & Encryption */}
          <section className="customer-access-card" style={{ padding: "20px 24px" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "var(--adm-text)", display: "flex", alignItems: "center", gap: 8 }}>
              <IconShield size={16} color="var(--adm-primary)" />
              3. Processing, PII Masking &amp; AI Governance
            </h3>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              Extracted personally identifiable information (Aadhaar numbers, PAN numbers, account numbers, dates of birth) is masked before storage in compliance databases.
            </p>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              Rule-based checks take precedence in all verification outcomes. Auxiliary AI assistance operates exclusively on masked data streams and is deployed only when rules require disambiguation.
            </p>
          </section>

          {/* Section 4: 7-Day Deletion & Erasure Rights */}
          <section className="customer-access-card" style={{ padding: "20px 24px" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: "var(--adm-text)", display: "flex", alignItems: "center", gap: 8 }}>
              <IconClock size={16} color="var(--adm-primary)" />
              4. Retention Period &amp; Erasure Rights
            </h3>
            <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              All uploaded files, raw data buffers, cryptographic tokens, and OCR metadata are permanently deleted 7 days after case creation or completion.
            </p>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--adm-text-secondary)" }}>
              You may also exercise your statutory right to withdraw consent or request immediate erasure prior to the 7-day retention window via the <Link to="/privacy" style={{ color: "var(--adm-primary)", fontWeight: 600 }}>Privacy &amp; Data Rights Portal</Link>.
            </p>
          </section>
        </div>

        {/* Footer Navigation */}
        <div style={{ marginTop: 32, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <Link
            to="/"
            className="customer-access-btn"
            style={{
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13.5,
              padding: "10px 18px",
            }}
          >
            <span>Back to Portal Home</span>
            <IconArrowRight size={15} />
          </Link>

          <Link
            to="/privacy"
            className="customer-nav-link"
            style={{ fontSize: 13.5, textDecoration: "none" }}
          >
            Exercise Privacy &amp; Deletion Rights →
          </Link>
        </div>
      </div>
    </div>
  );
};
export default TermsPage;
