import React from "react";
import {
  IconDashboard,
  IconUsers,
  IconFileText,
  IconAlertTriangle,
  IconShield,
  IconBarChart3,
  IconSettings,
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconBell,
  IconTrash2,
  IconUser,
} from "./AdminIcons";

export type AdminNavTab =
  | "dashboard"
  | "cases"
  | "documents"
  | "reviews"
  | "reminders"
  | "retention"
  | "audit"
  | "reports"
  | "settings";

interface AdminSidebarProps {
  activeTab: AdminNavTab;
  onSelectTab: (tab: AdminNavTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
  openReviewsCount?: number;
  failedCount?: number;
  activeRemindersCount?: number;
  retentionCount?: number;
  adminEmail?: string;
  adminName?: string;
}

export const AdminSidebar: React.FC<AdminSidebarProps> = ({
  activeTab,
  onSelectTab,
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onCloseMobile,
  openReviewsCount = 0,
  failedCount = 0,
  activeRemindersCount = 0,
  retentionCount = 0,
  adminEmail = "admin@docpilot.internal",
  adminName = "Admin",
}) => {
  interface NavGroup {
    title: string;
    items: Array<{
      key: AdminNavTab;
      label: string;
      icon: React.ReactNode;
      badge?: number;
      badgeType?: "warn" | "bad" | "info";
    }>;
  }

  const navGroups: NavGroup[] = [
    {
      title: "OPERATIONS",
      items: [
        {
          key: "dashboard",
          label: "Dashboard",
          icon: <IconDashboard size={20} />,
        },
        {
          key: "cases",
          label: "Customers",
          icon: <IconUsers size={20} />,
        },
        {
          key: "documents",
          label: "Documents",
          icon: <IconFileText size={20} />,
        },
        {
          key: "reviews",
          label: "Manual Reviews",
          icon: <IconAlertTriangle size={20} />,
          badge: openReviewsCount > 0 ? openReviewsCount : undefined,
          badgeType: "warn",
        },
        {
          key: "reminders",
          label: "Reminders",
          icon: <IconBell size={20} />,
          badge: activeRemindersCount > 0 ? activeRemindersCount : undefined,
          badgeType: "info",
        },
      ],
    },
    {
      title: "DATA & COMPLIANCE",
      items: [
        {
          key: "retention",
          label: "Retention & Purge",
          icon: <IconTrash2 size={20} />,
          badge: retentionCount > 0 ? retentionCount : undefined,
          badgeType: "warn",
        },
        {
          key: "audit",
          label: "Audit Log",
          icon: <IconShield size={20} />,
        },
      ],
    },
    {
      title: "INSIGHTS",
      items: [
        {
          key: "reports",
          label: "Reports",
          icon: <IconBarChart3 size={20} />,
        },
      ],
    },
    {
      title: "SYSTEM",
      items: [
        {
          key: "settings",
          label: "Settings",
          icon: <IconSettings size={20} />,
        },
      ],
    },
  ];

  const showLabels = !isCollapsed || isMobileOpen;

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileOpen && (
        <div
          className="admin-mobile-backdrop"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`admin-sidebar ${isCollapsed && !isMobileOpen ? "collapsed" : ""} ${
          isMobileOpen ? "mobile-open" : ""
        }`}
        id="admin-sidebar"
        aria-label="Admin Navigation Sidebar"
      >
        {/* Sidebar Brand Header */}
        <div className="sidebar-brand">
          <div className="brand-logo-container">
            <div className="brand-mark">
              <span className="brand-mark-inner">DP</span>
            </div>
            {showLabels && (
              <div className="brand-text">
                <span className="brand-name">DocPilot</span>
                <span className="brand-tag">Ops Center</span>
              </div>
            )}
          </div>
          {/* Mobile close button */}
          <button
            type="button"
            className="sidebar-mobile-close"
            onClick={onCloseMobile}
            aria-label="Close navigation drawer"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Navigation List Organized into Sections */}
        <nav className="sidebar-nav">
          {navGroups.map((group, gIdx) => (
            <div key={group.title} className="sidebar-group" style={{ marginBottom: gIdx === navGroups.length - 1 ? 0 : 12 }}>
              {showLabels && (
                <div className="sidebar-section-title">
                  {group.title}
                </div>
              )}
              <ul className="sidebar-menu">
                {group.items.map((item) => {
                  const isActive = activeTab === item.key;
                  return (
                    <li key={item.key} className="sidebar-item">
                      <button
                        type="button"
                        className={`sidebar-link ${isActive ? "active" : ""}`}
                        onClick={() => {
                          onSelectTab(item.key);
                          onCloseMobile();
                        }}
                        title={!showLabels ? item.label : undefined}
                        aria-label={item.label}
                        id={`sidebar-link-${item.key}`}
                      >
                        <span className="sidebar-icon">{item.icon}</span>
                        {showLabels && (
                          <span className="sidebar-label">{item.label}</span>
                        )}
                        {item.badge !== undefined && (
                          <span
                            className={`sidebar-badge badge-${item.badgeType || "info"} ${
                              !showLabels ? "badge-dot" : ""
                            }`}
                          >
                            {!showLabels ? "" : item.badge}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Sidebar Footer with Admin Profile Chip & Collapse Toggle */}
        <div className="sidebar-footer">
          {failedCount > 0 && showLabels && (
            <div className="sidebar-alert-card">
              <div className="sidebar-alert-title">
                <span>Attention Required</span>
              </div>
              <p className="sidebar-alert-desc">
                {failedCount} failed OCR or job event{failedCount > 1 ? "s" : ""}.
              </p>
            </div>
          )}

          {/* Admin Profile User Chip matching reference layout */}
          <div className="sidebar-user-chip" title={adminEmail}>
            <div className="sidebar-user-avatar">
              <IconUser size={16} />
            </div>
            {showLabels && (
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{adminName || "Admin"}</span>
                <span className="sidebar-user-email">{adminEmail || "admin@docpilot.internal"}</span>
              </div>
            )}
          </div>

          {!isMobileOpen && (
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={onToggleCollapse}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isCollapsed ? (
                <IconChevronRight size={18} />
              ) : (
                <>
                  <IconChevronLeft size={18} />
                  <span className="collapse-label">Collapse Menu</span>
                </>
              )}
            </button>
          )}
        </div>
      </aside>
    </>
  );
};
