import React, { useState } from "react";
import type { AdminAuditItem } from "../../types";
import {
  IconActivity,
  IconEye,
  IconCheckCircle2,
  IconXCircle,
  IconTrash2,
  IconUsers,
  IconShield,
} from "./AdminIcons";

interface RecentActivityFeedProps {
  logs: AdminAuditItem[];
  onViewAllAudit: () => void;
}

export const RecentActivityFeed: React.FC<RecentActivityFeedProps> = ({
  logs,
  onViewAllAudit,
}) => {
  const [filterCategory, setFilterCategory] = useState<"all" | "reviews" | "files" | "cases">("all");
  const [currentTimestamp] = useState(() => Date.now());

  const getActionDetails = (action: string) => {
    switch (action) {
      case "review_approved":
        return {
          label: "Review Approved",
          category: "reviews",
          icon: <IconCheckCircle2 size={16} color="#10b981" />,
          colorClass: "act-green",
        };
      case "review_rejected":
        return {
          label: "Review Rejected",
          category: "reviews",
          icon: <IconXCircle size={16} color="#ef4444" />,
          colorClass: "act-red",
        };
      case "document_viewed":
      case "document_file_viewed":
        return {
          label: "Secure View Accessed",
          category: "files",
          icon: <IconEye size={16} color="#3b82f6" />,
          colorClass: "act-blue",
        };
      case "file_deleted":
      case "document_file_deleted":
        return {
          label: "File Purged",
          category: "files",
          icon: <IconTrash2 size={16} color="#f59e0b" />,
          colorClass: "act-amber",
        };
      case "customer_created":
        return {
          label: "Case Created",
          category: "cases",
          icon: <IconUsers size={16} color="#06b6d4" />,
          colorClass: "act-cyan",
        };
      case "case_closed":
        return {
          label: "Case Closed",
          category: "cases",
          icon: <IconShield size={16} color="#8b5cf6" />,
          colorClass: "act-purple",
        };
      default:
        return {
          label: (action || "activity").replace(/_/g, " "),
          category: "all",
          icon: <IconShield size={16} color="var(--mut)" />,
          colorClass: "act-neutral",
        };
    }
  };

  const filteredLogs = logs.filter((log) => {
    if (filterCategory === "all") return true;
    const details = getActionDetails(log.action);
    return details.category === filterCategory;
  });

  const displayLogs = filteredLogs.slice(0, 8);

  const formatRelativeTime = (timeStr: string) => {
    try {
      const dateMs = new Date(timeStr).getTime();
      const diffMs = currentTimestamp - dateMs;
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) return "Just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 7) return `${diffDays}d ago`;
      return new Date(timeStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return timeStr;
    }
  };

  return (
    <div className="activity-feed-card" id="recent-activity-feed-card">
      <div className="activity-card-header">
        <div className="activity-title-group">
          <div className="activity-icon-box">
            <IconActivity size={18} />
          </div>
          <div>
            <h2 className="activity-title">Live Audit & Activity</h2>
            <span className="activity-subtitle">Real-time record of staff operations and system jobs</span>
          </div>
        </div>

        {/* Filter chips */}
        <div className="activity-filter-chips">
          <button
            type="button"
            className={`activity-chip ${filterCategory === "all" ? "active" : ""}`}
            onClick={() => setFilterCategory("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`activity-chip ${filterCategory === "reviews" ? "active" : ""}`}
            onClick={() => setFilterCategory("reviews")}
          >
            Reviews
          </button>
          <button
            type="button"
            className={`activity-chip ${filterCategory === "files" ? "active" : ""}`}
            onClick={() => setFilterCategory("files")}
          >
            Files
          </button>
          <button
            type="button"
            className={`activity-chip ${filterCategory === "cases" ? "active" : ""}`}
            onClick={() => setFilterCategory("cases")}
          >
            Cases
          </button>
        </div>
      </div>

      <div className="activity-list-container">
        {displayLogs.length === 0 ? (
          <div className="activity-empty-state">
            <p className="empty-text">No recent activity matching filter</p>
          </div>
        ) : (
          <ul className="activity-stream">
            {displayLogs.map((item) => {
              const details = getActionDetails(item.action);
              return (
                <li key={item.id} className="activity-item">
                  <div className={`activity-item-icon ${details.colorClass}`}>
                    {details.icon}
                  </div>
                  <div className="activity-item-content">
                    <div className="activity-item-top">
                      <span className="activity-action-name">{details.label}</span>
                      <span className="activity-time">{formatRelativeTime(item.at)}</span>
                    </div>
                    <div className="activity-item-meta">
                      <span className="activity-actor">{item.actor}</span>
                      {item.entity_type && (
                        <span className="activity-entity">
                          · {item.entity_type} {item.entity_id ? `#${item.entity_id}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="activity-card-footer">
        <button
          type="button"
          className="activity-view-all-btn"
          onClick={onViewAllAudit}
        >
          View Complete Audit Log →
        </button>
      </div>
    </div>
  );
};
