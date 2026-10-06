import React, { useState, useRef, useEffect } from "react";
import {
  IconMenu,
  IconPlus,
  IconLogOut,
  IconCheck,
  IconBell,
  IconChevronDown,
} from "./AdminIcons";
import { ThemeToggle } from "../ThemeToggle";
import type { AdminNavTab } from "./AdminSidebar";
import { probeSystemHealth, type HealthProbeResult } from "../../utils/settingsUtils";

interface AdminTopNavProps {
  activeTab: AdminNavTab;
  onOpenMobile: () => void;
  onAddCustomer?: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  onSignOut: () => void;
  adminEmail?: string;
  adminName?: string;
  isSystemLive?: boolean;
  customTitle?: string;
  customSubtitle?: string;
}

const TAB_TITLES: Record<AdminNavTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Operations Dashboard",
    subtitle: "Real-time document verification and case lifecycle overview",
  },
  cases: {
    title: "Customers",
    subtitle: "Manage customer verification cases and document collection",
  },
  documents: {
    title: "Documents",
    subtitle: "Review uploaded documents, OCR processing and verification status",
  },
  reviews: {
    title: "Manual Reviews",
    subtitle: "Review documents requiring human verification",
  },
  reminders: {
    title: "Reminders",
    subtitle: "Monitor consent-based document collection reminders",
  },
  retention: {
    title: "7-Day Retention & Deletion",
    subtitle: "Monitor document retention and permanent deletion lifecycle",
  },
  audit: {
    title: "Audit Log",
    subtitle: "Review security-sensitive activity across the platform",
  },
  reports: {
    title: "Reports & Analytics",
    subtitle: "Monitor operational throughput, verification, OCR and compliance metrics",
  },
  settings: {
    title: "Settings",
    subtitle: "Manage application configuration and administrator preferences",
  },
};

export const AdminTopNav: React.FC<AdminTopNavProps> = ({
  activeTab,
  onOpenMobile,
  onAddCustomer,
  isDarkMode,
  onToggleTheme,
  onSignOut,
  adminEmail = "staff@docpilot.internal",
  adminName,
  isSystemLive = true,
  customTitle,
  customSubtitle,
}) => {
  const [showHealthPopover, setShowHealthPopover] = useState(false);
  const [healthData, setHealthData] = useState<HealthProbeResult | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showHealthPopover) {
      probeSystemHealth()
        .then((res) => setHealthData(res))
        .catch(() => {});
    }
  }, [showHealthPopover]);

  // Click outside to close health popover
  useEffect(() => {
    if (!showHealthPopover) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowHealthPopover(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showHealthPopover]);

  const tabInfo = TAB_TITLES[activeTab] || {
    title: "Admin Portal",
    subtitle: "DocPilot Operations Center",
  };
  const title = customTitle || tabInfo.title;
  const subtitle = customSubtitle || tabInfo.subtitle;

  const getInitials = (emailStr?: string) => {
    if (!emailStr) return "AD";
    const userPart = emailStr.split("@")[0] || "";
    const parts = userPart.split(/[._-]/).filter(Boolean);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return emailStr.slice(0, 2).toUpperCase() || "AD";
  };

  return (
    <header className="admin-topnav" id="admin-topnav">
      <div className="topnav-left">
        <button
          type="button"
          className="topnav-mobile-toggle"
          onClick={onOpenMobile}
          aria-label="Open navigation menu"
        >
          <IconMenu size={20} />
        </button>

        <div className="topnav-titles">
          <h1 className="topnav-page-title">{title}</h1>
          <p className="topnav-subtitle">{subtitle}</p>
        </div>
      </div>

      <div className="topnav-right">
        {/* System Health Status Pill & Diagnostic Popover */}
        <div style={{ position: "relative" }} ref={popoverRef}>
          <button
            type="button"
            className="system-status-pill"
            onClick={() => setShowHealthPopover((prev) => !prev)}
            style={{
              cursor: "pointer",
              border: isSystemLive ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid rgba(239, 68, 68, 0.3)",
              background: isSystemLive ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
              color: isSystemLive ? "var(--adm-success)" : "var(--adm-danger)",
              fontWeight: 600,
            }}
            title="Click to view real-time system health diagnostics"
            aria-expanded={showHealthPopover}
          >
            <span className={`status-beacon ${isSystemLive ? "live" : "offline"}`} />
            <span className="status-label">{isSystemLive ? "System Healthy" : "System Offline"}</span>
          </button>

          {showHealthPopover && (
            <div
              className="card"
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 8,
                width: 280,
                padding: "14px 16px",
                zIndex: 200,
                boxShadow: "var(--adm-shadow-lg)",
                borderRadius: 10,
                border: "1px solid var(--adm-border)",
                background: "var(--adm-surface)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--adm-text)" }}>
                  System Health
                </span>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: isSystemLive ? "var(--adm-success-bg)" : "var(--adm-danger-bg)",
                    color: isSystemLive ? "var(--adm-success)" : "var(--adm-danger)",
                    fontWeight: 600,
                  }}
                >
                  {isSystemLive ? "Operational" : "Offline"}
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "var(--adm-text-secondary)" }}>API Gateway</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: isSystemLive ? "var(--adm-success)" : "var(--adm-danger)", fontWeight: 600 }}>
                    <IconCheck size={14} /> Active
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "var(--adm-text-secondary)" }}>PostgreSQL DB</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--adm-success)", fontWeight: 600 }}>
                    <IconCheck size={14} /> Connected
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "var(--adm-text-secondary)" }}>Background Worker</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: isSystemLive ? "var(--adm-success)" : "var(--adm-warn)", fontWeight: 600 }}>
                    <IconCheck size={14} /> Active
                  </span>
                </div>
                {healthData?.latencyMs !== undefined && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4, borderTop: "1px solid var(--adm-border)" }}>
                    <span style={{ color: "var(--adm-text-muted)", fontSize: 11 }}>Probe Latency</span>
                    <span style={{ color: "var(--adm-text-muted)", fontSize: 11, fontWeight: 600 }}>{healthData.latencyMs} ms</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Notification Bell */}
        <div style={{ position: "relative", marginLeft: 4 }}>
          <button
            type="button"
            className="topnav-icon-btn"
            style={{ borderRadius: "50%", width: 36, height: 36, padding: 0, border: "1px solid var(--adm-border)" }}
            title="Notifications"
          >
            <IconBell size={18} color="var(--adm-text-secondary)" />
          </button>
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "#ef4444",
              color: "#fff",
              fontSize: 10,
              fontWeight: 800,
              borderRadius: "50%",
              minWidth: 16,
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid var(--adm-surface)",
              lineHeight: 1,
            }}
          >
            3
          </span>
        </div>

        {/* Theme Toggle */}
        <ThemeToggle
          id="theme-toggle-btn"
          className="admin-theme-toggle"
          theme={isDarkMode ? "dark" : "light"}
          onToggle={onToggleTheme}
        />

        {/* Quick Action Button: New Customer */}
        <button
          type="button"
          className="topnav-add-btn"
          onClick={onAddCustomer}
          id="btn-add-customer-topnav"
          title="Create a new customer verification case"
          style={{ background: "var(--c-primary)", borderColor: "var(--c-primary)", borderRadius: 8, boxShadow: "none" }}
        >
          <IconPlus size={16} />
          <span>New Customer</span>
        </button>

        {/* Vertical Divider */}
        <div style={{ width: 1, height: 28, background: "var(--adm-border)", margin: "0 4px" }} />

        {/* Admin Profile & Sign Out Dropdown */}
        <div className="admin-profile-menu" style={{ borderLeft: "none", paddingLeft: 0, cursor: "pointer" }}>
          <div className="admin-avatar" title={adminEmail} style={{ background: "var(--c-primary)", borderColor: "transparent" }}>
            {getInitials(adminEmail)}
          </div>
          <div className="admin-info">
            <span className="admin-name">{adminName || "Staff Admin"}</span>
            <span className="admin-email" style={{ fontSize: 11, color: "var(--adm-text-muted)" }}>Administrator</span>
          </div>
          <button
            type="button"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--adm-text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: "pointer",
              marginLeft: 4,
            }}
            onClick={onSignOut}
            title="Sign out"
          >
            <IconChevronDown size={16} />
          </button>
        </div>
      </div>
    </header>
  );
};
