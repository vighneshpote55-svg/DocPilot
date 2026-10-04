import React from "react";
import type { AdminSummary } from "../../types";
import {
  IconBarChart3,
  IconCheckCircle2,
  IconClock,
  IconShield,
  IconAlertTriangle,
  IconCheck,
} from "./AdminIcons";

interface AdminReportsViewProps {
  summary: AdminSummary | null;
}

export const AdminReportsView: React.FC<AdminReportsViewProps> = ({ summary }) => {
  const totalCases = summary?.metrics?.total_customers ??
    Object.values(summary?.cases || {}).reduce((a, b) => a + (b || 0), 0);
  const completedCases = summary?.metrics?.completed_customers ?? (summary?.cases?.completed || 0);
  const inProgressCases = summary?.cases?.in_progress || 0;
  const deletedCases = summary?.cases?.deleted || 0;
  const expiredCases = summary?.cases?.expired || 0;

  const totalDocs = summary?.metrics?.total_documents || 0;
  const verifiedDocs = summary?.metrics?.verified_documents || 0;
  const reviewDocs = summary?.open_reviews || 0;
  const failedDocs = summary?.metrics?.ocr_failures || 0;

  const completionRate = summary?.metrics?.completion_rate ??
    (totalCases > 0 ? Math.round((completedCases / totalCases) * 100) : 0);

  const autoVerifyRate = totalDocs > 0 ? Math.round((verifiedDocs / totalDocs) * 100) : 0;
  const escalationRate = totalDocs > 0 ? Math.round((reviewDocs / totalDocs) * 100) : 0;
  const errorRate = totalDocs > 0 ? Math.round((failedDocs / totalDocs) * 100) : 0;

  return (
    <div className="reports-view-container" id="admin-reports-view">
      <div className="reports-header-card">
        <div className="reports-header-text">
          <h2 className="reports-main-title">Operations & Verification Intelligence</h2>
          <p className="reports-main-subtitle">
            Lifecycle health, deterministic rules engine throughput, and data retention compliance.
          </p>
        </div>
      </div>

      {/* SLA & Throughput Metrics Grid */}
      <div className="reports-metrics-row">
        <div className="report-metric-card">
          <div className="report-card-top">
            <span className="report-metric-name">Case Completion Rate</span>
            <div className="report-icon-box text-success">
              <IconCheckCircle2 size={18} />
            </div>
          </div>
          <div className="report-metric-value">{completionRate}%</div>
          <div className="report-metric-bar">
            <div className="bar-fill fill-green" style={{ width: `${completionRate}%` }} />
          </div>
          <span className="report-metric-hint">
            {completedCases} of {totalCases} total customer cases completed
          </span>
        </div>

        <div className="report-metric-card">
          <div className="report-card-top">
            <span className="report-metric-name">Deterministic Verification</span>
            <div className="report-icon-box text-blue">
              <IconCheck size={18} />
            </div>
          </div>
          <div className="report-metric-value">{autoVerifyRate}%</div>
          <div className="report-metric-bar">
            <div className="bar-fill fill-blue" style={{ width: `${autoVerifyRate}%` }} />
          </div>
          <span className="report-metric-hint">
            {verifiedDocs} of {totalDocs} documents verified by rules engine
          </span>
        </div>

        <div className="report-metric-card">
          <div className="report-card-top">
            <span className="report-metric-name">Human Review Escalation</span>
            <div className="report-icon-box text-amber">
              <IconAlertTriangle size={18} />
            </div>
          </div>
          <div className="report-metric-value">{escalationRate}%</div>
          <div className="report-metric-bar">
            <div className="bar-fill fill-amber" style={{ width: `${escalationRate}%` }} />
          </div>
          <span className="report-metric-hint">
            {reviewDocs} documents flagged for risk or low confidence
          </span>
        </div>

        <div className="report-metric-card">
          <div className="report-card-top">
            <span className="report-metric-name">OCR Failure Rate</span>
            <div className="report-icon-box text-red">
              <IconShield size={18} />
            </div>
          </div>
          <div className="report-metric-value">{errorRate}%</div>
          <div className="report-metric-bar">
            <div className="bar-fill fill-red" style={{ width: `${errorRate}%` }} />
          </div>
          <span className="report-metric-hint">
            {failedDocs} documents with unreadable photos or corrupted files
          </span>
        </div>
      </div>

      {/* Case Lifecycle Funnel */}
      <div className="card report-section-card">
        <h3 className="section-title">
          <IconBarChart3 size={18} /> Case Intake & Verification Funnel
        </h3>
        <p className="section-subtitle">
          Conversion stages from initial customer case creation to final automated data purge.
        </p>

        <div className="funnel-container">
          <div className="funnel-step">
            <div className="funnel-step-header">
              <span className="funnel-step-number">1</span>
              <span className="funnel-step-title">Registered Cases</span>
            </div>
            <div className="funnel-step-count">{totalCases}</div>
            <div className="funnel-step-desc">All customer records created</div>
          </div>

          <div className="funnel-arrow">→</div>

          <div className="funnel-step">
            <div className="funnel-step-header">
              <span className="funnel-step-number">2</span>
              <span className="funnel-step-title">Active Intake</span>
            </div>
            <div className="funnel-step-count">{inProgressCases}</div>
            <div className="funnel-step-desc">Awaiting customer uploads</div>
          </div>

          <div className="funnel-arrow">→</div>

          <div className="funnel-step">
            <div className="funnel-step-header">
              <span className="funnel-step-number">3</span>
              <span className="funnel-step-title">Verified & Closed</span>
            </div>
            <div className="funnel-step-count">{completedCases}</div>
            <div className="funnel-step-desc">All required documents verified</div>
          </div>

          <div className="funnel-arrow">→</div>

          <div className="funnel-step">
            <div className="funnel-step-header">
              <span className="funnel-step-number">4</span>
              <span className="funnel-step-title">Files Purged</span>
            </div>
            <div className="funnel-step-count">{deletedCases}</div>
            <div className="funnel-step-desc">Storage purged after 7-day retention</div>
          </div>
        </div>
      </div>

      {/* Retention & Privacy Compliance Overview */}
      <div className="card report-section-card">
        <h3 className="section-title">
          <IconClock size={18} /> Data Retention & Purge Compliance
        </h3>
        <p className="section-subtitle">
          DocPilot implements zero-long-term-storage: sensitive customer files are automatically destroyed 7 days after case completion.
        </p>

        <div className="compliance-grid">
          <div className="compliance-box">
            <span className="comp-label">Storage Retention Policy</span>
            <span className="comp-val">7 Days Max</span>
            <span className="comp-desc">Encrypted blobs deleted after case complete</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Unfinished Case Expiry</span>
            <span className="comp-val">30 Days</span>
            <span className="comp-desc">Incomplete customer portals expire automatically</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Cases Fully Purged</span>
            <span className="comp-val">{deletedCases}</span>
            <span className="comp-desc">Files removed from private Supabase bucket</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Expired Cases</span>
            <span className="comp-val">{expiredCases}</span>
            <span className="comp-desc">Exceeded 30 days without completion</span>
          </div>
        </div>
      </div>
    </div>
  );
};
