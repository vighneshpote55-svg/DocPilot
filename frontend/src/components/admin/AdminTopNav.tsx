import React from "react";
import {
  IconMenu,
  IconSun,
  IconMoon,
  IconPlus,
  IconLogOut,
} from "./AdminIcons";
import type { AdminNavTab } from "./AdminSidebar";

interface AdminTopNavProps {
  activeTab: AdminNavTab;
  onOpenMobile: () => void;
  onAddCustomer: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  onSignOut: () => void;
  adminEmail?: string;
  isSystemLive?: boolean;
}

const TAB_TITLES: Record<AdminNavTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Operations Dashboard",
    subtitle: "Real-time document verification and case lifecycle overview",
  },
  cases: {
    title: "Customer Cases",
    subtitle: "Manage customer document collections, statuses, and verification progress",
  },
  documents: {
    title: "Documents Registry",
    subtitle: "Inspect uploaded documents, OCR outcomes, and audit file states",
  },
  reviews: {
    title: "Manual Review Queue",
    subtitle: "Review flagged documents with masked OCR evidence and decide actions",
  },
  audit: {
    title: "Audit & Compliance Log",
    subtitle: "Cryptographic, tamper-evident record of all staff and system operations",
  },
  reports: {
    title: "Reports & Analytics",
    subtitle: "Operational throughput, verification SLA rates, and retention health",
  },
  settings: {
    title: "System & Privacy Settings",
    subtitle: "Configured retention schedules, encryption standards, and OCR policies",
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
  isSystemLive = true,
}) => {
  const { title, subtitle } = TAB_TITLES[activeTab] || {
    title: "Admin Portal",
    subtitle: "DocPilot Operations Center",
  };

  const getInitials = (emailStr: string) => {
    const parts = emailStr.split("@")[0].split(/[._-]/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return emailStr.slice(0, 2).toUpperCase();
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
        {/* System Status Pill */}
        <div className="system-status-pill" title="Postgres background job worker & OCR pipeline active">
          <span className={`status-beacon ${isSystemLive ? "live" : "offline"}`} />
          <span className="status-label">{isSystemLive ? "Live Monitoring" : "Worker Offline"}</span>
        </div>

        {/* Quick Action Button: Add Customer */}
        <button
          type="button"
          className="topnav-add-btn"
          onClick={onAddCustomer}
          id="btn-add-customer-topnav"
          title="Create a new customer verification case"
        >
          <IconPlus size={16} />
          <span>New Case</span>
        </button>

        {/* Theme Toggle */}
        <button
          type="button"
          className="topnav-icon-btn"
          onClick={onToggleTheme}
          aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark blue mode"}
          title={isDarkMode ? "Switch to Light Enterprise theme" : "Switch to Dark Blue theme"}
          id="theme-toggle-btn"
        >
          {isDarkMode ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>

        {/* Admin Profile & Sign Out */}
        <div className="admin-profile-menu">
          <div className="admin-avatar" title={adminEmail}>
            {getInitials(adminEmail)}
          </div>
          <div className="admin-info">
            <span className="admin-name">Staff Admin</span>
            <span className="admin-email">{adminEmail}</span>
          </div>
          <button
            type="button"
            className="topnav-signout-btn"
            onClick={onSignOut}
            title="Sign out of Admin Dashboard"
            id="staff-sign-out"
          >
            <IconLogOut size={16} />
            <span className="signout-text">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
};
