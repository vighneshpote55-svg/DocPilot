import React from "react";
import type { AdminSummary } from "../../types";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconBell,
  IconClock,
  IconCheckCircle2,
  IconArrowRight,
} from "./AdminIcons";

interface NeedsAttentionBannerProps {
  summary: AdminSummary | null;
  activeRemindersCount: number;
  retentionDueCount: number;
  onNavigateTab: (tab: "documents" | "reviews" | "reminders" | "retention") => void;
}

export const NeedsAttentionBanner: React.FC<NeedsAttentionBannerProps> = ({
  summary,
  activeRemindersCount,
  retentionDueCount,
  onNavigateTab,
}) => {
  const ocrFailures =
    (summary?.metrics?.ocr_failures || 0) + (summary?.jobs?.failed || 0);
  const openReviews =
    summary?.open_reviews ?? (summary?.metrics?.pending_review_documents || 0);

  const hasAttentionItems =
    ocrFailures > 0 || openReviews > 0 || activeRemindersCount > 0 || retentionDueCount > 0;

  if (!hasAttentionItems) {
    return (
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          marginBottom: 16,
          borderRadius: 8,
          background: "var(--adm-success-bg)",
          border: "1px solid var(--adm-success-border)",
          color: "var(--adm-success)",
          fontSize: 13,
          fontWeight: 600,
        }}
        id="needs-attention-clear"
      >
        <IconCheckCircle2 size={18} />
        <span>No action required — All document pipelines, OCR queues, and verification tasks are running normally.</span>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        padding: "12px 16px",
        marginBottom: 16,
        borderRadius: 10,
        border: "1px solid var(--adm-border)",
        background: "var(--adm-card)",
      }}
      id="needs-attention-section"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--adm-text-muted)",
            }}
          >
            Needs Attention
          </span>
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--adm-danger-bg)",
              color: "var(--adm-danger)",
              fontWeight: 700,
            }}
          >
            Action Required
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
        }}
      >
        {/* 1. OCR Failures */}
        {ocrFailures > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--adm-danger-bg)",
              border: "1px solid var(--adm-danger-border)",
              color: "var(--adm-danger)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconAlertCircle size={16} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {ocrFailures} OCR Failure{ocrFailures > 1 ? "s" : ""}
                </div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>Documents needing check</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab("documents")}
              className="btn"
              style={{
                padding: "3px 8px",
                fontSize: 11.5,
                fontWeight: 600,
                background: "var(--adm-danger)",
                color: "#ffffff",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              Inspect <IconArrowRight size={12} />
            </button>
          </div>
        )}

        {/* 2. Manual Reviews */}
        {openReviews > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--adm-warn-bg)",
              border: "1px solid var(--adm-warn-border)",
              color: "var(--adm-warn)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconAlertTriangle size={16} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {openReviews} Manual Review{openReviews > 1 ? "s" : ""}
                </div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>Flagged for human check</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab("reviews")}
              className="btn"
              style={{
                padding: "3px 8px",
                fontSize: 11.5,
                fontWeight: 600,
                background: "var(--adm-warn)",
                color: "#ffffff",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              Review <IconArrowRight size={12} />
            </button>
          </div>
        )}

        {/* 3. Upcoming Reminders */}
        {activeRemindersCount > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--adm-primary-bg)",
              border: "1px solid var(--adm-primary-border)",
              color: "var(--adm-primary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconBell size={16} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {activeRemindersCount} Active Reminder{activeRemindersCount > 1 ? "s" : ""}
                </div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>Pending document intake</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab("reminders")}
              className="btn"
              style={{
                padding: "3px 8px",
                fontSize: 11.5,
                fontWeight: 600,
                background: "var(--adm-primary)",
                color: "#ffffff",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              View <IconArrowRight size={12} />
            </button>
          </div>
        )}

        {/* 4. Approaching Retention / Purge Due */}
        {retentionDueCount > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--adm-warn-bg)",
              border: "1px solid var(--adm-warn-border)",
              color: "var(--adm-warn)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconClock size={16} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {retentionDueCount} Due for Purge
                </div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>7-day window elapsed</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab("retention")}
              className="btn"
              style={{
                padding: "3px 8px",
                fontSize: 11.5,
                fontWeight: 600,
                background: "var(--adm-warn)",
                color: "#ffffff",
                border: "none",
                borderRadius: 5,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              Purge <IconArrowRight size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
