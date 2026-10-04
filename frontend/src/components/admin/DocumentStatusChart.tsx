import React, { useState } from "react";
import type { AdminSummary } from "../../types";
import { IconFileText } from "./AdminIcons";

interface DocumentStatusChartProps {
  summary: AdminSummary | null;
}

interface Segment {
  key: string;
  label: string;
  count: number;
  color: string;
  strokeDasharray?: string;
  strokeDashoffset?: number;
  percentage: number;
}

export const DocumentStatusChart: React.FC<DocumentStatusChartProps> = ({ summary }) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const docsMap = summary?.documents || {};
  const verifiedCount = summary?.metrics?.verified_documents ?? (docsMap.verified || 0);
  const underReviewCount =
    summary?.metrics?.pending_review_documents ??
    (docsMap.under_review || summary?.open_reviews || 0);
  const rejectedCount = docsMap.rejected || 0;
  const processingCount =
    summary?.metrics?.processing_documents ??
    ((docsMap.waiting || 0) + (docsMap.processing || 0) + (docsMap.not_started || 0));

  const totalDocs =
    summary?.metrics?.total_documents ??
    (verifiedCount + underReviewCount + rejectedCount + processingCount);

  // Calculate segment arcs for SVG circle (circumference = 2 * PI * r)
  const radius = 68;
  const circumference = 2 * Math.PI * radius;

  const rawSegments: Array<{ key: string; label: string; count: number; color: string }> = [
    { key: "verified", label: "Verified", count: verifiedCount, color: "#10b981" },
    { key: "under_review", label: "Under Review", count: underReviewCount, color: "#f59e0b" },
    { key: "rejected", label: "Rejected", count: rejectedCount, color: "#ef4444" },
    { key: "processing", label: "Processing / Pending", count: processingCount, color: "#06b6d4" },
  ];

  let cumulativeOffset = 0;
  const segments: Segment[] = rawSegments.map((seg) => {
    const percentage = totalDocs > 0 ? (seg.count / totalDocs) * 100 : 0;
    const strokeDash = (percentage / 100) * circumference;
    const strokeDasharray = `${strokeDash} ${circumference}`;
    const strokeDashoffset = -cumulativeOffset;
    cumulativeOffset += strokeDash;
    return {
      ...seg,
      percentage: Math.round(percentage),
      strokeDasharray,
      strokeDashoffset,
    };
  });

  const activeHovered = segments.find((s) => s.key === hoveredKey);

  return (
    <div className="chart-card" id="document-status-chart-card">
      <div className="chart-card-header">
        <div className="chart-title-group">
          <div className="chart-icon-box">
            <IconFileText size={18} />
          </div>
          <div>
            <h2 className="chart-title">Document Verification Status</h2>
            <span className="chart-subtitle">Breakdown across all active customer slots</span>
          </div>
        </div>
      </div>

      <div className="donut-chart-container">
        {totalDocs === 0 ? (
          <div className="donut-empty-state">
            <div className="empty-donut-ring">
              <span>0</span>
            </div>
            <p className="empty-text">No documents submitted yet</p>
          </div>
        ) : (
          <div className="donut-svg-wrapper">
            <svg
              viewBox="0 0 180 180"
              className="donut-svg"
              onMouseLeave={() => setHoveredKey(null)}
            >
              {/* Background ring */}
              <circle
                cx="90"
                cy="90"
                r={radius}
                fill="none"
                stroke="var(--line)"
                strokeWidth="18"
              />

              {/* Segment arcs */}
              {segments.map((seg) => {
                if (seg.count === 0) return null;
                const isHovered = hoveredKey === seg.key;
                return (
                  <circle
                    key={seg.key}
                    cx="90"
                    cy="90"
                    r={radius}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={isHovered ? 22 : 18}
                    strokeDasharray={seg.strokeDasharray}
                    strokeDashoffset={seg.strokeDashoffset}
                    strokeLinecap="round"
                    className="donut-segment"
                    style={{
                      transform: "rotate(-90deg)",
                      transformOrigin: "90px 90px",
                      transition: "stroke-width 0.2s ease, opacity 0.2s ease",
                      cursor: "pointer",
                      opacity: hoveredKey && !isHovered ? 0.45 : 1,
                    }}
                    onMouseEnter={() => setHoveredKey(seg.key)}
                  />
                );
              })}
            </svg>

            {/* Donut Center Display */}
            <div className="donut-center-info">
              {activeHovered ? (
                <>
                  <span className="center-value" style={{ color: activeHovered.color }}>
                    {activeHovered.percentage}%
                  </span>
                  <span className="center-label">{activeHovered.label}</span>
                </>
              ) : (
                <>
                  <span className="center-value">{totalDocs}</span>
                  <span className="center-label">Total Docs</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Legend & Breakdown List */}
        <div className="donut-legend-list">
          {segments.map((seg) => (
            <div
              key={seg.key}
              className={`donut-legend-row ${hoveredKey === seg.key ? "legend-hovered" : ""}`}
              onMouseEnter={() => setHoveredKey(seg.key)}
              onMouseLeave={() => setHoveredKey(null)}
            >
              <div className="legend-indicator">
                <span className="legend-badge-dot" style={{ backgroundColor: seg.color }} />
                <span className="legend-name">{seg.label}</span>
              </div>
              <div className="legend-values">
                <span className="legend-count">{seg.count}</span>
                <span className="legend-pct">({seg.percentage}%)</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
