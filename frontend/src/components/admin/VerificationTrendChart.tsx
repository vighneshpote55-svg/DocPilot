import React, { useMemo, useState } from "react";
import type { AdminAuditItem, AdminCustomerListItem } from "../../types";
import { IconTrendingUp } from "./AdminIcons";

interface VerificationTrendChartProps {
  auditLogs?: AdminAuditItem[];
  customers?: AdminCustomerListItem[];
}

interface DataPoint {
  dateStr: string;
  displayDate: string;
  verifiedCount: number;
  uploadCount: number;
}

export const VerificationTrendChart: React.FC<VerificationTrendChartProps> = ({
  auditLogs = [],
  customers = [],
}) => {
  const [nowMs] = useState(() => Date.now());
  const [timeRange, setTimeRange] = useState<7 | 14 | 30>(7);
  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Group events by day over the chosen timeframe
  const chartData = useMemo<DataPoint[]>(() => {
    const days: DataPoint[] = [];
    const dayMs = 86400000;

    // Create daily slots from (now - timeRange) to today
    for (let i = timeRange - 1; i >= 0; i--) {
      const d = new Date(nowMs - i * dayMs);
      const dateStr = d.toISOString().split("T")[0];
      const displayDate = d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      days.push({
        dateStr,
        displayDate,
        verifiedCount: 0,
        uploadCount: 0,
      });
    }

    const dayMap = new Map(days.map((item) => [item.dateStr, item]));

    // Aggregate from audit logs
    auditLogs.forEach((log) => {
      if (!log.at) return;
      const logDate = log.at.split("T")[0];
      const target = dayMap.get(logDate);
      if (target) {
        if (
          log.action === "review_approved" ||
          log.action === "document_verified" ||
          log.action === "verification_completed"
        ) {
          target.verifiedCount += 1;
        }
        if (log.action === "document_uploaded" || log.action === "document_received") {
          target.uploadCount += 1;
        }
      }
    });

    // Also factor customer case completions
    customers.forEach((cust) => {
      if (cust.completed_at) {
        const cDate = cust.completed_at.split("T")[0];
        const target = dayMap.get(cDate);
        if (target) {
          target.verifiedCount += 1;
        }
      } else if (cust.created_at) {
        const crDate = cust.created_at.split("T")[0];
        const target = dayMap.get(crDate);
        if (target) {
          target.uploadCount += 1;
        }
      }
    });

    return days;
  }, [auditLogs, customers, timeRange, nowMs]);

  const maxVal = Math.max(
    ...chartData.map((d) => Math.max(d.verifiedCount, d.uploadCount)),
    5 // Minimum scale height
  );

  // Dimensions
  const width = 640;
  const height = 220;
  const paddingLeft = 36;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const points = chartData.map((d, idx) => {
    const x = paddingLeft + (idx / Math.max(chartData.length - 1, 1)) * chartW;
    const yVer = paddingTop + chartH - (d.verifiedCount / maxVal) * chartH;
    const yUp = paddingTop + chartH - (d.uploadCount / maxVal) * chartH;
    return { ...d, x, yVer, yUp };
  });

  // Generate smooth SVG paths
  const createPath = (key: "yVer" | "yUp") => {
    if (points.length === 0) return "";
    let d = `M ${points[0].x} ${points[0][key]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      const mx = (curr.x + next.x) / 2;
      d += ` C ${mx} ${curr[key]}, ${mx} ${next[key]}, ${next.x} ${next[key]}`;
    }
    return d;
  };

  const verPath = createPath("yVer");
  const upPath = createPath("yUp");

  const verAreaPath = points.length > 0
    ? `${verPath} L ${points[points.length - 1].x} ${paddingTop + chartH} L ${points[0].x} ${paddingTop + chartH} Z`
    : "";

  const totalVerifiedInPeriod = chartData.reduce((acc, d) => acc + d.verifiedCount, 0);
  const totalUploadsInPeriod = chartData.reduce((acc, d) => acc + d.uploadCount, 0);

  return (
    <div className="chart-card" id="verification-trend-chart-card">
      <div className="chart-card-header">
        <div className="chart-title-group">
          <div className="chart-icon-box">
            <IconTrendingUp size={18} />
          </div>
          <div>
            <h2 className="chart-title">Verification & Intake Velocity</h2>
            <span className="chart-subtitle">
              {totalVerifiedInPeriod} verified / {totalUploadsInPeriod} ingested in this timeframe
            </span>
          </div>
        </div>

        <div className="chart-controls">
          <div className="chart-legend">
            <span className="legend-item">
              <span className="legend-dot dot-verified" /> Verified
            </span>
            <span className="legend-item">
              <span className="legend-dot dot-uploads" /> Uploads
            </span>
          </div>

          <div className="chart-tabs">
            <button
              type="button"
              className={`chart-tab ${timeRange === 7 ? "active" : ""}`}
              onClick={() => setTimeRange(7)}
            >
              7D
            </button>
            <button
              type="button"
              className={`chart-tab ${timeRange === 14 ? "active" : ""}`}
              onClick={() => setTimeRange(14)}
            >
              14D
            </button>
            <button
              type="button"
              className={`chart-tab ${timeRange === 30 ? "active" : ""}`}
              onClick={() => setTimeRange(30)}
            >
              30D
            </button>
          </div>
        </div>
      </div>

      <div className="chart-svg-container">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="trend-chart-svg"
          preserveAspectRatio="none"
          onMouseLeave={() => {
            setHoveredPoint(null);
            setHoverPos(null);
          }}
        >
          <defs>
            {/* Emerald Gradient for Verified Area */}
            <linearGradient id="verifiedGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>

            {/* Blue Gradient for Uploads Stroke */}
            <linearGradient id="uploadsGradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#06b6d4" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
            const y = paddingTop + chartH * pct;
            const val = Math.round(maxVal * (1 - pct));
            return (
              <g key={pct} className="chart-grid-line">
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="var(--line)"
                  strokeDasharray="3 3"
                />
                <text
                  x={paddingLeft - 6}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--mut)"
                >
                  {val}
                </text>
              </g>
            );
          })}

          {/* Bottom X-axis labels */}
          {points.map((p, idx) => {
            const showLabel =
              timeRange === 7 ||
              idx % (timeRange === 14 ? 2 : 4) === 0 ||
              idx === points.length - 1;
            if (!showLabel) return null;
            return (
              <text
                key={p.dateStr}
                x={p.x}
                y={height - 8}
                textAnchor="middle"
                fontSize="11"
                fill="var(--mut)"
              >
                {p.displayDate}
              </text>
            );
          })}

          {/* Area Fill for Verified */}
          <path d={verAreaPath} fill="url(#verifiedGradient)" />

          {/* Lines */}
          <path
            d={upPath}
            fill="none"
            stroke="url(#uploadsGradient)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d={verPath}
            fill="none"
            stroke="#10b981"
            strokeWidth="2.5"
            strokeLinecap="round"
          />

          {/* Interactive Data Points and Hover Targets */}
          {points.map((p) => (
            <g key={p.dateStr} className="chart-datapoint-group">
              {/* Invisible wide hover target bar */}
              <rect
                x={p.x - chartW / (points.length * 2)}
                y={paddingTop}
                width={chartW / points.length}
                height={chartH}
                fill="transparent"
                onMouseEnter={(e) => {
                  setHoveredPoint(p);
                  const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  if (rect) {
                    setHoverPos({
                      x: p.x,
                      y: Math.min(p.yVer, p.yUp),
                    });
                  }
                }}
              />

              {/* Point dots */}
              <circle
                cx={p.x}
                cy={p.yVer}
                r="4"
                fill="#10b981"
                stroke="var(--card)"
                strokeWidth="2"
                className="point-dot dot-verified"
              />
              <circle
                cx={p.x}
                cy={p.yUp}
                r="3.5"
                fill="#3b82f6"
                stroke="var(--card)"
                strokeWidth="2"
                className="point-dot dot-uploads"
              />
            </g>
          ))}
        </svg>

        {/* Hover Floating Tooltip */}
        {hoveredPoint && hoverPos && (
          <div
            className="chart-tooltip"
            style={{
              left: `${(hoverPos.x / width) * 100}%`,
              top: `${(hoverPos.y / height) * 100}%`,
            }}
          >
            <div className="tooltip-date">{hoveredPoint.displayDate}</div>
            <div className="tooltip-row text-success">
              <span className="tooltip-dot dot-verified" /> Verified:{" "}
              <b>{hoveredPoint.verifiedCount}</b>
            </div>
            <div className="tooltip-row text-blue">
              <span className="tooltip-dot dot-uploads" /> Uploads:{" "}
              <b>{hoveredPoint.uploadCount}</b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
