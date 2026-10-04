import React from "react";
import type { AdminSummary } from "../../types";
import {
  IconUsers,
  IconCheckCircle2,
  IconClock,
  IconAlertTriangle,
  IconAlertCircle,
  IconTrendingUp,
} from "./AdminIcons";

interface KpiCardGridProps {
  summary: AdminSummary | null;
  activeFilter?: string;
  onFilterCaseStatus: (status: string) => void;
  onNavigateTab: (tab: "cases" | "documents" | "reviews") => void;
  onFilterDocFailed: () => void;
}

export const KpiCardGrid: React.FC<KpiCardGridProps> = ({
  summary,
  activeFilter,
  onFilterCaseStatus,
  onNavigateTab,
  onFilterDocFailed,
}) => {
  const totalCases = summary?.metrics?.total_customers ??
    Object.values(summary?.cases || {}).reduce((a, b) => a + (b || 0), 0);

  const completedCases = summary?.metrics?.completed_customers ??
    (summary?.cases?.completed || 0);

  const inProgressCases = summary?.cases?.in_progress || 0;

  const openReviews = summary?.open_reviews ??
    (summary?.metrics?.pending_review_documents || 0);

  const failedCount = (summary?.metrics?.ocr_failures || 0) + (summary?.jobs?.failed || 0);

  const completionRate = summary?.metrics?.completion_rate !== undefined
    ? summary.metrics.completion_rate
    : totalCases > 0
    ? Math.round((completedCases / totalCases) * 100)
    : 0;

  return (
    <div className="kpi-grid-container" id="summary-stats-grid">
      {/* 1. Total Customers */}
      <div
        className="kpi-card interactive"
        onClick={() => {
          onNavigateTab("cases");
          onFilterCaseStatus("");
        }}
        role="button"
        tabIndex={0}
        id="kpi-total-customers"
        title="View all customer cases"
      >
        <div className="kpi-card-header">
          <span className="kpi-card-title">Total Customers</span>
          <div className="kpi-icon-wrapper icon-blue">
            <IconUsers size={20} />
          </div>
        </div>
        <div className="kpi-card-body">
          <div className="stat kpi-value">{totalCases}</div>
          <div className="kpi-meta">
            <span className="kpi-subtext">Across all case states</span>
            <span className="kpi-trend trend-neutral">
              {summary?.cases?.deleted ? `${summary.cases.deleted} purged` : "Active"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Completed */}
      <div
        className={`kpi-card interactive ${activeFilter === "completed" ? "active-kpi" : ""}`}
        onClick={() => {
          onNavigateTab("cases");
          onFilterCaseStatus(activeFilter === "completed" ? "" : "completed");
        }}
        role="button"
        tabIndex={0}
        id="kpi-completed-customers"
        title="Filter cases by Completed status"
      >
        <div className="kpi-card-header">
          <span className="kpi-card-title">Completed Cases</span>
          <div className="kpi-icon-wrapper icon-green">
            <IconCheckCircle2 size={20} />
          </div>
        </div>
        <div className="kpi-card-body">
          <div className="stat kpi-value stat-success">{completedCases}</div>
          <div className="kpi-meta">
            <span className="kpi-subtext">All docs verified</span>
            <span className="kpi-trend trend-up">
              <IconTrendingUp size={13} />
              {completionRate}% rate
            </span>
          </div>
        </div>
      </div>

      {/* 3. In Progress */}
      <div
        className={`kpi-card interactive ${activeFilter === "in_progress" ? "active-kpi" : ""}`}
        onClick={() => {
          onNavigateTab("cases");
          onFilterCaseStatus(activeFilter === "in_progress" ? "" : "in_progress");
        }}
        role="button"
        tabIndex={0}
        id="kpi-in-progress"
        title="Filter cases by In Progress status"
      >
        <div className="kpi-card-header">
          <span className="kpi-card-title">In Progress</span>
          <div className="kpi-icon-wrapper icon-amber">
            <IconClock size={20} />
          </div>
        </div>
        <div className="kpi-card-body">
          <div className="stat kpi-value stat-warning">{inProgressCases}</div>
          <div className="kpi-meta">
            <span className="kpi-subtext">Awaiting uploads / OCR</span>
            <span className="kpi-trend trend-amber">
              {summary?.metrics?.processing_documents
                ? `${summary.metrics.processing_documents} processing`
                : "Active"}
            </span>
          </div>
        </div>
      </div>

      {/* 4. Manual Review */}
      <div
        className={`kpi-card interactive ${openReviews > 0 ? "kpi-attention" : ""}`}
        onClick={() => onNavigateTab("reviews")}
        role="button"
        tabIndex={0}
        id="kpi-manual-reviews"
        title="View manual review queue"
      >
        <div className="kpi-card-header">
          <span className="kpi-card-title">Manual Review</span>
          <div className={`kpi-icon-wrapper ${openReviews > 0 ? "icon-warn-active" : "icon-amber"}`}>
            <IconAlertTriangle size={20} />
          </div>
        </div>
        <div className="kpi-card-body">
          <div className={`stat kpi-value ${openReviews > 0 ? "stat-warn" : ""}`}>
            {openReviews}
          </div>
          <div className="kpi-meta">
            <span className="kpi-subtext">Flagged documents</span>
            <span className={`kpi-trend ${openReviews > 0 ? "trend-alert" : "trend-neutral"}`}>
              {openReviews > 0 ? "Action required" : "Queue clear"}
            </span>
          </div>
        </div>
      </div>

      {/* 5. Failed / Errors */}
      <div
        className={`kpi-card interactive ${failedCount > 0 ? "kpi-danger" : ""}`}
        onClick={() => {
          onNavigateTab("documents");
          onFilterDocFailed();
        }}
        role="button"
        tabIndex={0}
        id="kpi-failed-errors"
        title="Filter documents by failed OCR or processing errors"
      >
        <div className="kpi-card-header">
          <span className="kpi-card-title">OCR Failures</span>
          <div className={`kpi-icon-wrapper ${failedCount > 0 ? "icon-danger-active" : "icon-rose"}`}>
            <IconAlertCircle size={20} />
          </div>
        </div>
        <div className="kpi-card-body">
          <div className={`stat kpi-value ${failedCount > 0 ? "stat-bad" : ""}`}>
            {failedCount}
          </div>
          <div className="kpi-meta">
            <span className="kpi-subtext">Needs re-upload / check</span>
            <span className={`kpi-trend ${failedCount > 0 ? "trend-danger" : "trend-success"}`}>
              {failedCount > 0 ? "Inspect errors" : "Zero errors"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
