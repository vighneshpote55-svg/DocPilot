import React, { useCallback, useEffect, useState } from "react";
import { clearAdminToken, getAdminToken } from "../../api";
import type { AdminSummary } from "../../types";
import {
  IconActivity,
  IconAlertTriangle,
  IconCheckCircle2,
  IconClock,
  IconCpu,
  IconKey,
  IconLock,
  IconLogOut,
  IconMoon,
  IconRefreshCw,
  IconServer,
  IconShield,
  IconSun,
  IconTrash2,
} from "./AdminIcons";
import {
  formatSessionRemaining,
  maskSecretValue,
  parseAdminJwt,
  probeSystemHealth,
  SYSTEM_CONFIG,
  type DecodedAdminJwt,
  type HealthProbeResult,
} from "../../utils/settingsUtils";

interface AdminSettingsViewProps {
  summary?: AdminSummary | null;
  isDarkMode?: boolean;
  onToggleTheme?: () => void;
  sidebarCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onSignOut?: () => void;
}

type SettingsCategory = "all" | "env" | "storage" | "ocr" | "retention" | "security" | "session";

export const AdminSettingsView: React.FC<AdminSettingsViewProps> = ({
  summary = null,
  isDarkMode = true,
  onToggleTheme,
  sidebarCollapsed = false,
  onToggleCollapse,
  onSignOut,
}) => {
  // Navigation & Category Filter
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("all");

  // Health Probe State
  const [health, setHealth] = useState<HealthProbeResult | null>(null);
  const [probing, setProbing] = useState<boolean>(false);

  // Decoded Session JWT (pure initializer)
  const [decodedJwt] = useState<DecodedAdminJwt | null>(() => parseAdminJwt(getAdminToken()));

  // Action Confirmation Modals
  const [confirmModal, setConfirmModal] = useState<"cache" | "signout" | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Health probe execution
  const runHealthProbe = useCallback(() => {
    setProbing(true);
    probeSystemHealth(SYSTEM_CONFIG.apiBaseUrl, summary)
      .then((res) => {
        setHealth(res);
      })
      .catch(() => {
        setHealth({
          status: "error",
          latencyMs: 0,
          timestamp: new Date().toLocaleTimeString(),
          apiConnected: false,
          dbConnected: false,
          workerActive: false,
          message: "Probe failed",
        });
      })
      .finally(() => {
        setProbing(false);
      });
  }, [summary]);

  // Initial load
  useEffect(() => {
    let ignore = false;
    probeSystemHealth(SYSTEM_CONFIG.apiBaseUrl, summary)
      .then((res) => {
        if (!ignore) setHealth(res);
      })
      .catch(() => {
        if (!ignore) {
          setHealth({
            status: "error",
            latencyMs: 0,
            timestamp: new Date().toLocaleTimeString(),
            apiConnected: false,
            dbConnected: false,
            workerActive: false,
            message: "Probe failed",
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [summary]);

  // Handle Cache Reset
  const handleClearCacheConfirm = () => {
    localStorage.removeItem("docpilot_adm_theme");
    localStorage.removeItem("docpilot_adm_sidebar_collapsed");
    setConfirmModal(null);
    setToastMessage({ text: "Local browser preference caches successfully cleared.", type: "success" });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Handle Sign Out Confirm
  const handleSignOutConfirm = () => {
    setConfirmModal(null);
    clearAdminToken();
    if (onSignOut) {
      onSignOut();
    } else {
      window.location.href = "/admin";
    }
  };

  const isVisible = (cat: SettingsCategory) => activeCategory === "all" || activeCategory === cat;

  return (
    <div className="settings-view-container" id="admin-settings-view">
      {/* 1. Header Card with Live Status & Overview */}
      <div className="settings-header-card" id="settings-header-card">
        <div className="settings-header-text">
          <h2 className="settings-main-title">
            <IconShield size={24} color="var(--adm-primary, #3b82f6)" />
            System Policies & Security Controls
          </h2>
          <p className="settings-main-subtitle">
            Configuration parameters, encryption protocols, and zero-PII privacy boundaries enforced by the DocPilot engine.
          </p>
        </div>
      </div>

      {/* 2. Live System Health Probe Banner */}
      <div className="settings-health-banner" id="settings-health-banner">
        <div className="health-banner-left">
          <div className="health-banner-title">
            <IconActivity size={20} color="var(--adm-primary, #3b82f6)" />
            <span>Application Health & Connectivity</span>
          </div>
          <p className="health-banner-sub">
            Real-time latency check to the FastAPI gateway, Postgres database, and background job scheduler.
          </p>
          <div className="health-badges-row">
            <span
              id="health-status-badge"
              className={`health-status-chip ${
                health?.status === "ok" ? "chip-ok" : health?.status === "degraded" ? "chip-degraded" : "chip-error"
              }`}
            >
              <span className="live-dot" />
              <span>{health?.status === "ok" ? "Operational · All Systems Normal" : health?.message || "Checking status..."}</span>
            </span>

            <span id="health-ping-latency" className="health-ping-pill" title="API Gateway Roundtrip Latency">
              Latency: {health ? `${health.latencyMs} ms` : "Probing…"}
            </span>

            <span id="health-db-status" className="health-ping-pill" title="Database Connection Status">
              DB: {health?.dbConnected ? "Connected (Active)" : "Standby"}
            </span>

            <span id="health-worker-status" className="health-ping-pill" title="Postgres Job Worker Status">
              Worker: {summary?.jobs?.running ? `${summary.jobs.running} running` : "Idle (Polling)"}
            </span>
          </div>
        </div>

        <div className="health-banner-actions">
          <button
            type="button"
            id="btn-run-health-check"
            className="sec"
            onClick={runHealthProbe}
            disabled={probing}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px" }}
          >
            <IconRefreshCw size={15} className={probing ? "spin" : ""} />
            <span>{probing ? "Probing Gateway…" : "Probe Health"}</span>
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      {toastMessage && (
        <div
          id="settings-toast-feedback"
          style={{
            background: toastMessage.type === "success" ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
            border: `1px solid ${toastMessage.type === "success" ? "var(--adm-success, #10b981)" : "var(--adm-danger, #ef4444)"}`,
            color: toastMessage.type === "success" ? "var(--adm-success, #10b981)" : "var(--adm-danger, #ef4444)",
            borderRadius: 10,
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <IconCheckCircle2 size={18} />
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* 3. Category Navigation Pills */}
      <div className="settings-nav-pills" id="settings-nav-pills" role="tablist" aria-label="Settings categories">
        <button
          type="button"
          id="nav-pill-all"
          className={`settings-nav-pill ${activeCategory === "all" ? "active" : ""}`}
          onClick={() => setActiveCategory("all")}
        >
          All Settings
        </button>
        <button
          type="button"
          id="nav-pill-env"
          className={`settings-nav-pill ${activeCategory === "env" ? "active" : ""}`}
          onClick={() => setActiveCategory("env")}
        >
          <IconServer size={14} /> Environment
        </button>
        <button
          type="button"
          id="nav-pill-storage"
          className={`settings-nav-pill ${activeCategory === "storage" ? "active" : ""}`}
          onClick={() => setActiveCategory("storage")}
        >
          <IconShield size={14} /> Storage & Crypto
        </button>
        <button
          type="button"
          id="nav-pill-ocr"
          className={`settings-nav-pill ${activeCategory === "ocr" ? "active" : ""}`}
          onClick={() => setActiveCategory("ocr")}
        >
          <IconCpu size={14} /> OCR & AI
        </button>
        <button
          type="button"
          id="nav-pill-retention"
          className={`settings-nav-pill ${activeCategory === "retention" ? "active" : ""}`}
          onClick={() => setActiveCategory("retention")}
        >
          <IconClock size={14} /> Retention & Purge
        </button>
        <button
          type="button"
          id="nav-pill-security"
          className={`settings-nav-pill ${activeCategory === "security" ? "active" : ""}`}
          onClick={() => setActiveCategory("security")}
        >
          <IconKey size={14} /> Security & Limits
        </button>
        <button
          type="button"
          id="nav-pill-session"
          className={`settings-nav-pill ${activeCategory === "session" ? "active" : ""}`}
          onClick={() => setActiveCategory("session")}
        >
          <IconLock size={14} /> Staff Session
        </button>
      </div>

      {/* 4. Configuration Cards Grid */}
      <div className="settings-sections-grid" id="settings-sections-grid">
        {/* Card 1: Environment & Runtime */}
        {isVisible("env") && (
          <div className="settings-config-card" id="settings-card-environment">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-blue">
                  <IconServer size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Environment & Connectivity</h3>
                  <span className="settings-card-subtitle">FastAPI runtime host and origin topology</span>
                </div>
              </div>
              <span className="tag tag-good">Active</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Runtime Environment</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.environment.toUpperCase()}</span>
                </div>
                <p className="config-field-desc">Deployment profile loaded from client bundle environment</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">API Gateway Base URL</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.apiBaseUrl}</span>
                </div>
                <p className="config-field-desc">Target HTTP host for all admin, portal, and public endpoints</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">CORS Origins Whitelist</span>
                  <span className="config-field-value" style={{ fontSize: 11 }}>{SYSTEM_CONFIG.corsOrigins}</span>
                </div>
                <p className="config-field-desc">Authorized cross-origin domains allowed to query the API</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Public Customer Base URL</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.publicBaseUrl}</span>
                </div>
                <p className="config-field-desc">Base URL used to compose invitation and verification portal links</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Upload Payload Limit</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.maxUploadMb} MB per file</span>
                </div>
                <p className="config-field-desc">Strict upload ceiling enforced by FastAPI request streaming</p>
              </div>
            </div>
          </div>
        )}

        {/* Card 2: Storage & Cryptography */}
        {isVisible("storage") && (
          <div className="settings-config-card" id="settings-card-storage">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-green">
                  <IconShield size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Storage & Cryptography</h3>
                  <span className="settings-card-subtitle">Zero public storage URLs & AES-256-GCM cipher</span>
                </div>
              </div>
              <span className="tag tag-good">Enforced</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Encryption Standard</span>
                  <span className="config-field-value text-success">{SYSTEM_CONFIG.encryptionStandard}</span>
                </div>
                <p className="config-field-desc">Authenticated symmetric encryption applied before persisting to storage</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Master Encryption Key</span>
                  <span className="masked-secret-badge" title="Master 256-bit encryption key is masked">
                    <IconLock size={12} /> {maskSecretValue()}
                  </span>
                </div>
                <p className="config-field-desc">Protected server-side secret; never exposed to browser or client</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Storage Backend & Bucket</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.storageBucket} ({SYSTEM_CONFIG.storageBackend})</span>
                </div>
                <p className="config-field-desc">Private cloud storage bucket with blocked public access</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Secure Preview Streaming</span>
                  <span className="config-field-value text-blue">Audited Stream Gateway</span>
                </div>
                <p className="config-field-desc">Files are streamed decrypted on demand; each view generates an audit trail entry</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">File Download Policy</span>
                  <span className="config-field-value text-danger">Disabled by Policy</span>
                </div>
                <p className="config-field-desc">Direct file download endpoints blocked by security policy to prevent data exfiltration</p>
              </div>
            </div>
          </div>
        )}

        {/* Card 3: Stateless OCR & AI Fallback */}
        {isVisible("ocr") && (
          <div className="settings-config-card" id="settings-card-ocr">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-amber">
                  <IconCpu size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Stateless OCR & AI Engine</h3>
                  <span className="settings-card-subtitle">Deterministic rules engine with memory-only extraction</span>
                </div>
              </div>
              <span className="tag tag-good">Stateless</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">OCR Service Endpoint</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.ocrUrl}</span>
                </div>
                <p className="config-field-desc">External stateless document parser host (send bytes, receive JSON)</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Processing Persistence</span>
                  <span className="config-field-value text-success">RAM Only (Zero File Storage)</span>
                </div>
                <p className="config-field-desc">External OCR service persists zero document files or customer metadata</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Confidence Thresholds</span>
                  <span className="config-field-value">Overall: 90% · Field: 80%</span>
                </div>
                <p className="config-field-desc">Sub-threshold documents automatically escalate to human review queue</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">PII Masking Filter</span>
                  <span className="config-field-value text-blue">Mandatory Regex Redaction</span>
                </div>
                <p className="config-field-desc">Aadhaar, PAN, and account numbers redacted before saving to DB</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Optional AI Fallback</span>
                  <span className="config-field-value text-muted">Disabled (Rules Decide First)</span>
                </div>
                <p className="config-field-desc">AI fallback only invoked if deterministic rules are inconclusive and no fraud risk flag exists</p>
              </div>
            </div>
          </div>
        )}

        {/* Card 4: Retention & Reminders */}
        {isVisible("retention") && (
          <div className="settings-config-card" id="settings-card-retention">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-blue">
                  <IconClock size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Retention & Purge Schedule</h3>
                  <span className="settings-card-subtitle">DPDP Act, 2023 statutory compliance guarantees</span>
                </div>
              </div>
              <span className="tag tag-warn">7-Day Cap</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Post-Completion Retention</span>
                  <span className="config-field-value text-success">7 Days Strict</span>
                </div>
                <p className="config-field-desc">Encrypted files, OCR caches, tokens, and hashes permanently wiped after 7 days</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Unfinished Case Expiration</span>
                  <span className="config-field-value">30 Days</span>
                </div>
                <p className="config-field-desc">Incomplete customer portals expire automatically after 30 days without activity</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Automated Reminders Cadence</span>
                  <span className="config-field-value">Day 3, Day 7, Day 14</span>
                </div>
                <p className="config-field-desc">Notifications dispatched to pending customers via SMTP email channel</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Reminder Auto-Stop Guarantee</span>
                  <span className="config-field-value text-blue">Immediate on Case Closure</span>
                </div>
                <p className="config-field-desc">Completed cases or withdrawn consent permanently cancel all future notifications</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Background Purge Scheduler</span>
                  <span className="config-field-value">Every 300 Seconds (5 Min)</span>
                </div>
                <p className="config-field-desc">Worker runs continuous purge sweep to destroy elapsed documents</p>
              </div>
            </div>
          </div>
        )}

        {/* Card 5: Security & Rate Limiting */}
        {isVisible("security") && (
          <div className="settings-config-card" id="settings-card-security">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-green">
                  <IconKey size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Security & Rate Limiting</h3>
                  <span className="settings-card-subtitle">Abuse protection and zero customer ID exposure</span>
                </div>
              </div>
              <span className="tag tag-good">Guarded</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Customer Portal Identity</span>
                  <span className="config-field-value text-success">SHA-256 Hashed Tokens Only</span>
                </div>
                <p className="config-field-desc">Customer IDs never accepted from client; tokens resolved strictly by hash lookup</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Staff Authentication Standard</span>
                  <span className="config-field-value">Supabase JWT (HS256)</span>
                </div>
                <p className="config-field-desc">Cryptographically signed bearer tokens verified against authorized email whitelist</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">API Rate Limits (Per Client)</span>
                  <span className="config-field-value" style={{ fontSize: 11 }}>
                    Portal: 60/m · Upload: 15/m · Consent: 20/m
                  </span>
                </div>
                <p className="config-field-desc">Sliding window rate limiting to protect against brute-force and file exhaustion</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Upload OTP Verification</span>
                  <span className="config-field-value">{SYSTEM_CONFIG.uploadOtpEnabled ? "Active (10m TTL)" : "Optional (10m TTL)"}</span>
                </div>
                <p className="config-field-desc">6-digit email OTP protection before document upload is permitted</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Immutable Audit Trail</span>
                  <span className="config-field-value text-blue">Zero-PII Action Logs</span>
                </div>
                <p className="config-field-desc">Every view, upload, verification, and purge logged with timestamp and actor ID</p>
              </div>
            </div>
          </div>
        )}

        {/* Card 6: Staff Session & Local Preferences */}
        {isVisible("session") && (
          <div className="settings-config-card" id="settings-card-session">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="chart-icon-box text-blue">
                  <IconLock size={18} />
                </div>
                <div>
                  <h3 className="settings-card-title">Staff Session & Local Preferences</h3>
                  <span className="settings-card-subtitle">Active administrator context and workspace settings</span>
                </div>
              </div>
              <span className="tag tag-info">Authorized</span>
            </div>

            <div className="config-fields-list">
              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Active Staff Operator</span>
                  <span className="config-field-value text-blue">{decodedJwt?.email || "admin@docpilot.internal"}</span>
                </div>
                <p className="config-field-desc">Current administrator identity validated from authenticated JWT payload</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Session Token Validity</span>
                  <span className="config-field-value text-success">
                    {decodedJwt?.exp ? formatSessionRemaining(decodedJwt.exp) : "Active Session"}
                  </span>
                </div>
                <p className="config-field-desc">Remaining validity before JWT session expires and re-authentication is required</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Theme Mode Preference</span>
                  <button
                    type="button"
                    id="btn-settings-toggle-theme"
                    className="sec"
                    onClick={onToggleTheme}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", fontSize: 12 }}
                  >
                    {isDarkMode ? <IconSun size={14} /> : <IconMoon size={14} />}
                    <span>{isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}</span>
                  </button>
                </div>
                <p className="config-field-desc">Toggle between high-contrast light mode and dark theme</p>
              </div>

              <div className="config-field-row">
                <div className="config-field-top">
                  <span className="config-field-label">Sidebar Layout</span>
                  <button
                    type="button"
                    id="btn-settings-toggle-sidebar"
                    className="sec"
                    onClick={onToggleCollapse}
                    style={{ padding: "4px 10px", fontSize: 12 }}
                  >
                    {sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
                  </button>
                </div>
                <p className="config-field-desc">Configure default sidebar navigation menu width</p>
              </div>

              {/* Danger Zone Controls */}
              <div className="config-field-row" style={{ border: "1px solid rgba(239, 68, 68, 0.2)", background: "rgba(239, 68, 68, 0.04)" }}>
                <div className="config-field-top">
                  <span className="config-field-label" style={{ color: "var(--adm-danger, #ef4444)" }}>
                    Clear Local Preferences Cache
                  </span>
                  <button
                    type="button"
                    id="btn-settings-clear-cache"
                    className="sec"
                    onClick={() => setConfirmModal("cache")}
                    style={{ padding: "4px 10px", fontSize: 12, color: "var(--adm-danger, #ef4444)" }}
                  >
                    <IconTrash2 size={13} style={{ marginRight: 4 }} /> Clear Cache
                  </button>
                </div>
                <p className="config-field-desc">Reset browser theme and layout preferences back to defaults</p>
              </div>

              <div className="config-field-row" style={{ border: "1px solid rgba(239, 68, 68, 0.2)", background: "rgba(239, 68, 68, 0.04)" }}>
                <div className="config-field-top">
                  <span className="config-field-label" style={{ color: "var(--adm-danger, #ef4444)" }}>
                    End Administrative Session
                  </span>
                  <button
                    type="button"
                    id="btn-settings-signout"
                    className="sec"
                    onClick={() => setConfirmModal("signout")}
                    style={{ padding: "4px 10px", fontSize: 12, color: "var(--adm-danger, #ef4444)" }}
                  >
                    <IconLogOut size={13} style={{ marginRight: 4 }} /> Sign Out
                  </button>
                </div>
                <p className="config-field-desc">Safely terminate active staff operator session and return to sign-in portal</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Modal: Clear Cache */}
      {confirmModal === "cache" && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmModal(null)}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.75)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="card"
            id="modal-confirm-clear-cache"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 440, width: "100%", padding: 24 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <IconAlertTriangle size={24} color="var(--adm-danger, #ef4444)" />
              <h3 style={{ margin: 0 }}>Reset Local Preferences?</h3>
            </div>
            <p className="mut" style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
              This will clear your locally cached theme settings and navigation preferences from this browser. Your server authentication session will remain active.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="sec" onClick={() => setConfirmModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                id="btn-confirm-clear-cache-action"
                className="pri"
                onClick={handleClearCacheConfirm}
                style={{ background: "var(--adm-danger, #ef4444)", borderColor: "var(--adm-danger, #ef4444)" }}
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Sign Out */}
      {confirmModal === "signout" && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmModal(null)}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.75)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="card"
            id="modal-confirm-signout"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 440, width: "100%", padding: 24 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <IconLogOut size={24} color="var(--adm-danger, #ef4444)" />
              <h3 style={{ margin: 0 }}>Sign Out of Operations Center?</h3>
            </div>
            <p className="mut" style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
              Your current operator session token will be invalidated from this device. You will need your administrative credentials to log back in.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="sec" onClick={() => setConfirmModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                id="btn-confirm-signout-action"
                className="pri"
                onClick={handleSignOutConfirm}
                style={{ background: "var(--adm-danger, #ef4444)", borderColor: "var(--adm-danger, #ef4444)" }}
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
