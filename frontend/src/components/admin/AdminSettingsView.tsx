import React from "react";
import {
  IconShield,
  IconClock,
  IconCheckCircle2,
  IconFileText,
} from "./AdminIcons";

export const AdminSettingsView: React.FC = () => {
  return (
    <div className="settings-view-container" id="admin-settings-view">
      <div className="settings-header-card">
        <div className="settings-header-text">
          <h2 className="settings-main-title">System Policies & Security Controls</h2>
          <p className="settings-main-subtitle">
            Configuration parameters, encryption protocols, and zero-PII privacy boundaries enforced by the DocPilot engine.
          </p>
        </div>
      </div>

      <div className="settings-cards-grid">
        {/* Retention & Lifecycle */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon icon-blue">
              <IconClock size={20} />
            </div>
            <div>
              <h3 className="settings-card-title">Retention & Purge Schedule</h3>
              <span className="settings-card-subtitle">Automated deletion cascade</span>
            </div>
          </div>
          <div className="settings-card-body">
            <div className="policy-row">
              <span className="policy-name">Post-Completion Retention</span>
              <span className="policy-badge badge-green">7 Days Strict</span>
            </div>
            <p className="policy-desc">
              All encrypted files in Supabase Storage, raw OCR extractions, and hashes are permanently purged 7 days after the customer case completes.
            </p>

            <div className="policy-row">
              <span className="policy-name">Unfinished Case Expiration</span>
              <span className="policy-badge badge-neutral">30 Days</span>
            </div>
            <p className="policy-desc">
              Customer portals remain open for up to 30 days with automated reminder notifications at 3, 7, and 14 days. Unfinished cases expire automatically.
            </p>
          </div>
        </div>

        {/* Cryptography & Storage */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon icon-green">
              <IconShield size={20} />
            </div>
            <div>
              <h3 className="settings-card-title">Encryption & Storage Controls</h3>
              <span className="settings-card-subtitle">Zero public storage URLs</span>
            </div>
          </div>
          <div className="settings-card-body">
            <div className="policy-row">
              <span className="policy-name">Storage Encryption</span>
              <span className="policy-badge badge-blue">AES-256-GCM</span>
            </div>
            <p className="policy-desc">
              Every document is encrypted client-side/server-side using AES-GCM before writing to the private `case-documents` bucket.
            </p>

            <div className="policy-row">
              <span className="policy-name">Secure View Gateway</span>
              <span className="policy-badge badge-green">Audited Streaming</span>
            </div>
            <p className="policy-desc">
              Staff preview files exclusively via decrypted ephemeral streams. Every view event creates a non-repudiable audit row.
            </p>
          </div>
        </div>

        {/* OCR & Privacy Masking */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon icon-amber">
              <IconFileText size={20} />
            </div>
            <div>
              <h3 className="settings-card-title">Stateless OCR & Zero-PII Policy</h3>
              <span className="settings-card-subtitle">Deterministic rules first</span>
            </div>
          </div>
          <div className="settings-card-body">
            <div className="policy-row">
              <span className="policy-name">OCR Service Privacy</span>
              <span className="policy-badge badge-green">Stateless (No Storage)</span>
            </div>
            <p className="policy-desc">
              The external OCR service processes bytes into structured JSON in memory. Nothing is written or retained by the OCR service.
            </p>

            <div className="policy-row">
              <span className="policy-name">PII Masking Filter</span>
              <span className="policy-badge badge-blue">Regex Redaction Active</span>
            </div>
            <p className="policy-desc">
              Sensitive identifiers (Aadhaar, PAN, bank account numbers, phone numbers) are masked before persisting to the database.
            </p>
          </div>
        </div>

        {/* Token Authentication */}
        <div className="card settings-card">
          <div className="settings-card-header">
            <div className="settings-card-icon icon-purple">
              <IconCheckCircle2 size={20} />
            </div>
            <div>
              <h3 className="settings-card-title">Authentication & Access Control</h3>
              <span className="settings-card-subtitle">Cryptographic token security</span>
            </div>
          </div>
          <div className="settings-card-body">
            <div className="policy-row">
              <span className="policy-name">Customer Token Storage</span>
              <span className="policy-badge badge-green">SHA-256 Hashed Only</span>
            </div>
            <p className="policy-desc">
              Customer portal identity is determined strictly by URL token hash. No plain tokens or raw customer IDs are stored.
            </p>

            <div className="policy-row">
              <span className="policy-name">Staff Admin Authentication</span>
              <span className="policy-badge badge-blue">Supabase JWKS RS256</span>
            </div>
            <p className="policy-desc">
              Admin sessions are validated against Supabase public JWKS keys with role verification against authorized staff emails.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
