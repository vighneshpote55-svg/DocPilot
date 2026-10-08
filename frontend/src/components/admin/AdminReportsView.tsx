import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAdminAudit,
  getAdminCustomers,
  getAdminDocuments,
  getAdminReviews,
  getAdminSummary,
} from "../../api";
import type {
  AdminAuditItem,
  AdminCustomerListItem,
  AdminDocumentItem,
  AdminReviewItem,
  AdminSummary,
} from "../../types";
import {
  IconActivity,
  IconAlertTriangle,
  IconBarChart3,
  IconCheck,
  IconCheckCircle2,
  IconClock,
  IconFileText,
  IconFilter,
  IconPieChart,
  IconRefreshCw,
  IconShield,
  IconTrendingUp,
  IconUsers,
} from "./AdminIcons";
import {
  calculateReportKpis,
  filterCustomersForReport,
  filterDocumentsForReport,
  generateCaseDistributionSegments,
  generateDailyTrendData,
  generateDocTypeDistributionSegments,
  generateDocTypePerformanceMatrix,
  generateReviewReasonsSegments,
  type DailyTrendPoint,
  type DateRangePreset,
  type DocTypePerformanceRow,
  type DonutSegment,
  type ReportFilters,
} from "../../utils/reportsUtils";

interface AdminReportsViewProps {
  summary?: AdminSummary | null;
  initialCustomers?: AdminCustomerListItem[];
  initialAuditLogs?: AdminAuditItem[];
}

export const AdminReportsView: React.FC<AdminReportsViewProps> = ({
  summary: propSummary = null,
  initialCustomers = [],
  initialAuditLogs = [],
}) => {
  // Filters State
  const [filters, setFilters] = useState<ReportFilters>({
    dateRange: "7d",
    caseStatus: "all",
    docType: "all",
  });

  // Data State
  const [summary, setSummary] = useState<AdminSummary | null>(propSummary);
  const [customers, setCustomers] = useState<AdminCustomerListItem[]>(initialCustomers);
  const [documents, setDocuments] = useState<AdminDocumentItem[]>([]);
  const [reviews, setReviews] = useState<AdminReviewItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditItem[]>(initialAuditLogs);

  // Status State
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(() => new Date());

  // Interactive Hover State for Trend Chart
  const [hoveredTrendPoint, setHoveredTrendPoint] = useState<DailyTrendPoint | null>(null);
  const [trendHoverPos, setTrendHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Interactive Hover State for Donut Segments
  const [hoveredDonutKey, setHoveredDonutKey] = useState<string | null>(null);

  // Performance Matrix Sorting
  const [sortKey, setSortKey] = useState<keyof DocTypePerformanceRow>("totalUploaded");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Fetch all live datasets
  const fetchAllData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getAdminSummary().catch(() => null),
      getAdminCustomers("", 50, 0, "").catch(() => ({ customers: [] })),
      getAdminDocuments("", "", "", 200, 0, "").catch(() => ({ documents: [], totalCount: 0 })),
      getAdminReviews("all").catch(() => []),
      getAdminAudit(200).catch(() => []),
    ])
      .then(([sumRes, custRes, docRes, revRes, auditRes]) => {
        if (sumRes) setSummary(sumRes);
        if (custRes && Array.isArray(custRes.customers)) setCustomers(custRes.customers);
        if (docRes && Array.isArray(docRes.documents)) setDocuments(docRes.documents);
        if (Array.isArray(revRes)) setReviews(revRes);
        if (Array.isArray(auditRes)) setAuditLogs(auditRes);
        setLastRefreshed(new Date());
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load report analytics.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  // Initial load
  useEffect(() => {
    let ignore = false;
    Promise.all([
      getAdminSummary().catch(() => null),
      getAdminCustomers("", 50, 0, "").catch(() => ({ customers: [] })),
      getAdminDocuments("", "", "", 200, 0, "").catch(() => ({ documents: [], totalCount: 0 })),
      getAdminReviews("all").catch(() => []),
      getAdminAudit(200).catch(() => []),
    ])
      .then(([sumRes, custRes, docRes, revRes, auditRes]) => {
        if (ignore) return;
        if (sumRes) setSummary(sumRes);
        if (custRes && Array.isArray(custRes.customers)) setCustomers(custRes.customers);
        if (docRes && Array.isArray(docRes.documents)) setDocuments(docRes.documents);
        if (Array.isArray(revRes)) setReviews(revRes);
        if (Array.isArray(auditRes)) setAuditLogs(auditRes);
        setLastRefreshed(new Date());
      })
      .catch((err) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load report analytics.");
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  const effectiveSummary = summary || propSummary;

  // Filtered records
  const filteredCustomers = useMemo(() => {
    return filterCustomersForReport(customers, filters);
  }, [customers, filters]);

  const allowedCustomerIds = useMemo(() => {
    return new Set(filteredCustomers.map((c) => c.id));
  }, [filteredCustomers]);

  const filteredDocuments = useMemo(() => {
    return filterDocumentsForReport(documents, filters, allowedCustomerIds);
  }, [documents, filters, allowedCustomerIds]);

  // KPI Summary calculation
  const kpis = useMemo(() => {
    return calculateReportKpis(effectiveSummary, filteredCustomers, filteredDocuments, reviews, auditLogs);
  }, [effectiveSummary, filteredCustomers, filteredDocuments, reviews, auditLogs]);

  // Daily Trend aggregation
  const dailyTrend = useMemo(() => {
    return generateDailyTrendData(filteredCustomers, filteredDocuments, auditLogs, filters.dateRange);
  }, [filteredCustomers, filteredDocuments, auditLogs, filters.dateRange]);

  // Distribution Donut Segments
  const caseSegments = useMemo(() => {
    return generateCaseDistributionSegments(filteredCustomers);
  }, [filteredCustomers]);

  const docTypeSegments = useMemo(() => {
    return generateDocTypeDistributionSegments(filteredDocuments);
  }, [filteredDocuments]);

  const reviewReasonSegments = useMemo(() => {
    return generateReviewReasonsSegments(reviews);
  }, [reviews]);

  // Document Type Performance Matrix
  const performanceMatrix = useMemo(() => {
    const rows = generateDocTypePerformanceMatrix(filteredDocuments);
    return rows.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (typeof valA === "number" && typeof valB === "number") {
        return sortOrder === "asc" ? valA - valB : valB - valA;
      }
      return 0;
    });
  }, [filteredDocuments, sortKey, sortOrder]);

  // Trend Chart max value scaling
  const maxTrendVal = useMemo(() => {
    return Math.max(
      ...dailyTrend.map((d) => Math.max(d.newCases, d.verifiedDocs, d.uploadedDocs)),
      5
    );
  }, [dailyTrend]);

  // Reset filters handler
  const handleResetFilters = () => {
    setFilters({
      dateRange: "7d",
      caseStatus: "all",
      docType: "all",
    });
  };

  // Matrix sorting handler
  const handleSortMatrix = (key: keyof DocTypePerformanceRow) => {
    if (sortKey === key) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
  };

  // Render SVG Donut Chart helper
  const renderDonutChart = (
    segments: DonutSegment[],
    totalCount: number,
    centerLabel: string,
    chartId: string
  ) => {
    const radius = 68;
    return (
      <div className="donut-chart-container" id={chartId}>
        {totalCount === 0 ? (
          <div className="donut-empty-state">
            <div className="empty-donut-ring">
              <span>0</span>
            </div>
            <p className="empty-text">No data for selected period</p>
          </div>
        ) : (
          <div className="donut-svg-wrapper">
            <svg
              viewBox="0 0 180 180"
              className="donut-svg"
              onMouseLeave={() => setHoveredDonutKey(null)}
            >
              <circle
                cx="90"
                cy="90"
                r={radius}
                fill="none"
                stroke="var(--adm-border, rgba(59, 130, 246, 0.15))"
                strokeWidth="18"
              />
              {segments.map((seg) => {
                const isHovered = hoveredDonutKey === seg.key;
                return (
                  <circle
                    key={seg.key}
                    cx="90"
                    cy="90"
                    r={radius}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={isHovered ? 24 : 18}
                    strokeDasharray={seg.strokeDasharray}
                    strokeDashoffset={seg.strokeDashoffset}
                    transform="rotate(-90 90 90)"
                    style={{
                      transition: "all 0.25s ease",
                      cursor: "pointer",
                      opacity: hoveredDonutKey && !isHovered ? 0.6 : 1,
                    }}
                    onMouseEnter={() => setHoveredDonutKey(seg.key)}
                  />
                );
              })}
            </svg>
            <div className="donut-center-stat">
              <span className="donut-center-value">{totalCount}</span>
              <span className="donut-center-label">{centerLabel}</span>
            </div>
          </div>
        )}

        <div className="distribution-legend-list">
          {segments.map((seg) => (
            <div
              key={seg.key}
              className="distribution-legend-item"
              onMouseEnter={() => setHoveredDonutKey(seg.key)}
              onMouseLeave={() => setHoveredDonutKey(null)}
              style={{
                cursor: "pointer",
                fontWeight: hoveredDonutKey === seg.key ? 700 : 500,
              }}
            >
              <div className="distribution-legend-left">
                <span className="distribution-color-dot" style={{ background: seg.color }} />
                <span>{seg.label}</span>
              </div>
              <div className="distribution-legend-right">
                <span style={{ marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{seg.count}</span>
                <span className="mut" style={{ fontSize: 11 }}>({seg.percentage}%)</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="reports-view-container" id="admin-reports-view">
      {/* 1. Header Card with Live Status & Date Selector */}
      <div className="reports-header-card" id="reports-header-card">
        <div className="reports-header-left">
          <h2 className="reports-main-title">
            <IconBarChart3 size={24} color="var(--adm-primary, #3b82f6)" />
            Reports & Analytics Intelligence
          </h2>
          <p className="reports-main-subtitle">
            Operational throughput, deterministic rules vs. manual review SLAs, OCR accuracy, and DPDP compliance metrics.
          </p>
        </div>

        <div className="reports-header-actions">
          {/* Date Range Selector Pills */}
          <div className="report-date-pills" id="reports-daterange-pills" role="group" aria-label="Date range selector">
            {(["7d", "14d", "30d", "90d", "all"] as DateRangePreset[]).map((range) => (
              <button
                key={range}
                type="button"
                id={`report-daterange-${range}`}
                className={`report-date-pill ${filters.dateRange === range ? "active" : ""}`}
                onClick={() => setFilters((prev) => ({ ...prev, dateRange: range }))}
              >
                {range === "all" ? "All Time" : `Last ${range.toUpperCase()}`}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            id="btn-refresh-reports"
            className="sec"
            onClick={fetchAllData}
            disabled={loading}
            title={`Last refreshed at ${lastRefreshed.toLocaleTimeString()}`}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px" }}
          >
            <IconRefreshCw size={15} className={loading ? "spin" : ""} />
            <span>{loading ? "Syncing…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* 2. Multi-Dimensional Filter Dock */}
      <div className="reports-filter-dock" id="reports-filter-dock">
        <div className="reports-filter-group">
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--adm-text-secondary, #94a3b8)" }}>
            <IconFilter size={16} /> Filters:
          </span>

          {/* Case Status Filter */}
          <select
            id="report-filter-status"
            className="report-filter-select"
            value={filters.caseStatus}
            onChange={(e) => setFilters((prev) => ({ ...prev, caseStatus: e.target.value }))}
            aria-label="Filter by case status"
          >
            <option value="all">All Case Statuses</option>
            <option value="completed">Completed Cases</option>
            <option value="in_progress">Active Intake (In Progress)</option>
            <option value="under_review">Under Review Cases</option>
            <option value="withdrawn">Withdrawn Cases</option>
            <option value="deleted_expired">Purged / Expired Cases</option>
          </select>

          {/* Document Type Filter */}
          <select
            id="report-filter-doctype"
            className="report-filter-select"
            value={filters.docType}
            onChange={(e) => setFilters((prev) => ({ ...prev, docType: e.target.value }))}
            aria-label="Filter by document type"
          >
            <option value="all">All Document Types</option>
            <option value="aadhaar">Aadhaar Card</option>
            <option value="pan">PAN Card</option>
            <option value="bank_statement">Bank Statement</option>
            <option value="salary_slip">Salary Slip</option>
            <option value="gst_certificate">GST Certificate</option>
            <option value="passport">Passport</option>
            <option value="voter">Voter ID</option>
            <option value="driving_licence">Driving Licence</option>
          </select>
        </div>

        <div>
          <button
            type="button"
            id="btn-reset-report-filters"
            className="sec"
            onClick={handleResetFilters}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            Reset Filters
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="reports-error-state" id="reports-error-state">
          <IconAlertTriangle size={32} color="var(--adm-danger, #ef4444)" />
          <h3 style={{ margin: 0, color: "var(--adm-danger, #ef4444)" }}>Error Loading Analytics</h3>
          <p className="mut" style={{ maxWidth: 480, margin: 0 }}>{error}</p>
          <button type="button" className="pri" onClick={fetchAllData}>
            Retry Data Sync
          </button>
        </div>
      )}

      {/* Empty State when zero records match */}
      {!loading && !error && filteredCustomers.length === 0 && filteredDocuments.length === 0 && (
        <div className="reports-empty-state" id="reports-empty-state">
          <IconFileText size={36} color="var(--adm-text-muted, #64748b)" />
          <h3 style={{ margin: 0 }}>No Data Found for Selected Filters</h3>
          <p className="mut" style={{ maxWidth: 440, margin: 0 }}>
            No customer cases or documents match your chosen date range and status filters.
          </p>
          <button type="button" className="sec" onClick={handleResetFilters}>
            Clear Filters & View All
          </button>
        </div>
      )}

      {/* 3. 8 High-Impact KPI Summary Cards Grid */}
      <div className="reports-kpi-grid" id="reports-kpi-grid">
        {/* Card 1: Total Registered Cases */}
        <div className="report-metric-card-p9" id="kpi-report-cases">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Total Registered Cases</span>
            <div className="report-icon-box text-blue">
              <IconUsers size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.totalCases}</div>
          <div className="report-metric-footer-p9">
            <span>{kpis.inProgressCases} active in intake</span>
            <span className="text-success">{kpis.completedCases} closed</span>
          </div>
        </div>

        {/* Card 2: Case Completion Rate */}
        <div className="report-metric-card-p9" id="kpi-report-completion-rate">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Case Completion Rate</span>
            <div className="report-icon-box text-success">
              <IconCheckCircle2 size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.completionRate}%</div>
          <div className="report-progress-bar-p9">
            <div className="report-progress-fill-p9 fill-green" style={{ width: `${kpis.completionRate}%` }} />
          </div>
          <div className="report-metric-footer-p9">
            <span>{kpis.completedCases} of {kpis.totalCases} cases completed</span>
          </div>
        </div>

        {/* Card 3: Avg Turnaround Time */}
        <div className="report-metric-card-p9" id="kpi-report-avg-time">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Avg Case Turnaround</span>
            <div className="report-icon-box text-amber">
              <IconClock size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.avgTurnaroundDisplay}</div>
          <div className="report-metric-footer-p9">
            <span>Intake to case closure SLA</span>
            <span className="text-blue">Target &lt; 24h</span>
          </div>
        </div>

        {/* Card 4: Total Documents Processed */}
        <div className="report-metric-card-p9" id="kpi-report-docs">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Documents Processed</span>
            <div className="report-icon-box text-blue">
              <IconFileText size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.totalDocs}</div>
          <div className="report-metric-footer-p9">
            <span>{kpis.supersededCount} resubmissions</span>
            <span className="text-success">{kpis.verifiedDocs} verified</span>
          </div>
        </div>

        {/* Card 5: Rules Auto-Verification Rate */}
        <div className="report-metric-card-p9" id="kpi-report-auto-verify">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Deterministic Auto-Verify</span>
            <div className="report-icon-box text-success">
              <IconCheck size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.autoVerifyRate}%</div>
          <div className="report-progress-bar-p9">
            <div className="report-progress-fill-p9 fill-blue" style={{ width: `${kpis.autoVerifyRate}%` }} />
          </div>
          <div className="report-metric-footer-p9">
            <span>Verified without human review</span>
          </div>
        </div>

        {/* Card 6: OCR Accuracy / Success Rate */}
        <div className="report-metric-card-p9" id="kpi-report-ocr-success">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">OCR Extraction Success</span>
            <div className="report-icon-box text-blue">
              <IconShield size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.ocrSuccessRate}%</div>
          <div className="report-progress-bar-p9">
            <div className="report-progress-fill-p9 fill-green" style={{ width: `${kpis.ocrSuccessRate}%` }} />
          </div>
          <div className="report-metric-footer-p9">
            <span className="text-danger">{kpis.ocrFailureCount} unreadable / corrupted</span>
          </div>
        </div>

        {/* Card 7: Manual Review Escalations */}
        <div className="report-metric-card-p9" id="kpi-report-reviews">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">Human Review Queue</span>
            <div className="report-icon-box text-amber">
              <IconAlertTriangle size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.openReviews}</div>
          <div className="report-metric-footer-p9">
            <span>{kpis.reviewEscalationRate}% of all docs flagged</span>
            <span className="text-success">{kpis.reviewApprovalRate}% approved</span>
          </div>
        </div>

        {/* Card 8: Retention Purged Cases */}
        <div className="report-metric-card-p9" id="kpi-report-purged">
          <div className="report-card-top-p9">
            <span className="report-metric-name-p9">DPDP Purged Cases</span>
            <div className="report-icon-box text-red">
              <IconShield size={18} />
            </div>
          </div>
          <div className="report-metric-value-p9">{kpis.retentionPurged}</div>
          <div className="report-metric-footer-p9">
            <span>{kpis.retentionActive} in 7-day retention</span>
            <span className="text-amber">{kpis.retentionDue} due today</span>
          </div>
        </div>
      </div>

      {/* 4. Dual-Series Interactive Trend Chart & Processing Performance */}
      <div className="reports-charts-grid">
        {/* Trend Chart */}
        <div className="report-chart-card" id="reports-trend-chart-card">
          <div className="report-chart-header">
            <div className="report-chart-title-group">
              <div className="chart-icon-box text-blue">
                <IconTrendingUp size={18} />
              </div>
              <div>
                <h3 className="report-chart-title">Intake & Verification Velocity</h3>
                <span className="report-chart-subtitle">
                  Daily registered cases vs. verified documents ({filters.dateRange === "all" ? "Last 30 Days" : filters.dateRange.toUpperCase()})
                </span>
              </div>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 3, background: "var(--adm-primary, #075E5B)", borderRadius: 2 }} />
                <span style={{ color: "var(--adm-text-secondary, #94a3b8)" }}>Case Intake</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 3, background: "#15966F", borderRadius: 2 }} />
                <span style={{ color: "var(--adm-text-secondary, #94a3b8)" }}>Verified Documents</span>
              </div>
            </div>
          </div>

          {/* SVG Line / Area Graph */}
          <div style={{ position: "relative", width: "100%", height: 220, overflow: "hidden" }}>
            <svg
              viewBox="0 0 640 220"
              style={{ width: "100%", height: "100%", display: "block" }}
              onMouseLeave={() => {
                setHoveredTrendPoint(null);
                setTrendHoverPos(null);
              }}
            >
              <defs>
                <linearGradient id="p9-gradient-blue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--adm-primary, #075E5B)" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="var(--adm-primary, #075E5B)" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="p9-gradient-green" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#15966F" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#15966F" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                const y = 20 + pct * 160;
                return (
                  <line
                    key={idx}
                    x1="40"
                    y1={y}
                    x2="620"
                    y2={y}
                    stroke="var(--adm-border)"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                );
              })}

              {/* Path generation */}
              {(() => {
                if (dailyTrend.length < 2) return null;
                const plotW = 580;
                const stepX = plotW / (dailyTrend.length - 1);

                const getPt = (idx: number, val: number) => {
                  const x = 40 + idx * stepX;
                  const y = 180 - (val / maxTrendVal) * 160;
                  return { x, y };
                };

                // Blue line (Intake)
                const blueCoords = dailyTrend.map((d, i) => getPt(i, d.newCases));
                const bluePath = blueCoords.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x},${pt.y}`, "");
                const blueArea = `${bluePath} L ${blueCoords[blueCoords.length - 1].x},180 L ${blueCoords[0].x},180 Z`;

                // Green line (Verified)
                const greenCoords = dailyTrend.map((d, i) => getPt(i, d.verifiedDocs));
                const greenPath = greenCoords.reduce((acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x},${pt.y}`, "");
                const greenArea = `${greenPath} L ${greenCoords[greenCoords.length - 1].x},180 L ${greenCoords[0].x},180 Z`;

                return (
                  <>
                    <path d={blueArea} fill="url(#p9-gradient-blue)" />
                    <path d={bluePath} fill="none" stroke="var(--adm-primary, #075E5B)" strokeWidth="2.5" />

                    <path d={greenArea} fill="url(#p9-gradient-green)" />
                    <path d={greenPath} fill="none" stroke="#15966F" strokeWidth="2.5" />

                    {/* Invisible hover capture zones */}
                    {dailyTrend.map((pt, i) => {
                      const coord = getPt(i, pt.newCases);
                      return (
                        <rect
                          key={pt.dateStr}
                          x={coord.x - stepX / 2}
                          y="10"
                          width={stepX}
                          height="180"
                          fill="transparent"
                          style={{ cursor: "pointer" }}
                          onMouseEnter={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setHoveredTrendPoint(pt);
                            setTrendHoverPos({ x: rect.left + rect.width / 2, y: rect.top });
                          }}
                        />
                      );
                    })}
                  </>
                );
              })()}
            </svg>

            {/* Hover Tooltip */}
            {hoveredTrendPoint && trendHoverPos && (
              <div
                style={{
                  position: "absolute",
                  bottom: 40,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "var(--adm-card-elevated, #1e293b)",
                  border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.3))",
                  borderRadius: 8,
                  padding: "8px 14px",
                  fontSize: 12,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
                  pointerEvents: "none",
                  zIndex: 20,
                  display: "flex",
                  gap: 16,
                }}
              >
                <div>
                  <span style={{ fontWeight: 700, color: "var(--adm-text, #ffffff)" }}>
                    {hoveredTrendPoint.displayDate}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <span style={{ color: "var(--adm-primary, #075E5B)", fontWeight: 600 }}>
                    Intake: {hoveredTrendPoint.newCases}
                  </span>
                  <span style={{ color: "#15966F", fontWeight: 600 }}>
                    Verified: {hoveredTrendPoint.verifiedDocs}
                  </span>
                  {hoveredTrendPoint.ocrFailures > 0 && (
                    <span style={{ color: "#ef4444", fontWeight: 600 }}>
                      Failures: {hoveredTrendPoint.ocrFailures}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Conversion Funnel Widget */}
        <div className="report-chart-card" id="reports-funnel-card">
          <div className="report-chart-header">
            <div className="report-chart-title-group">
              <div className="chart-icon-box text-green">
                <IconActivity size={18} />
              </div>
              <div>
                <h3 className="report-chart-title">Intake & Verification Funnel</h3>
                <span className="report-chart-subtitle">Case journey from registration to file purge</span>
              </div>
            </div>
          </div>

          <div className="funnel-container" style={{ padding: "8px 0" }}>
            <div className="funnel-step">
              <div className="funnel-step-header">
                <span className="funnel-step-number">1</span>
                <span className="funnel-step-title">Intake</span>
              </div>
              <div className="funnel-step-count">{kpis.totalCases}</div>
              <div className="funnel-step-desc">Registered cases</div>
            </div>

            <div className="funnel-arrow">→</div>

            <div className="funnel-step">
              <div className="funnel-step-header">
                <span className="funnel-step-number">2</span>
                <span className="funnel-step-title">Verified</span>
              </div>
              <div className="funnel-step-count">{kpis.completedCases}</div>
              <div className="funnel-step-desc">All slots verified</div>
            </div>

            <div className="funnel-arrow">→</div>

            <div className="funnel-step">
              <div className="funnel-step-header">
                <span className="funnel-step-number">3</span>
                <span className="funnel-step-title">Purged</span>
              </div>
              <div className="funnel-step-count">{kpis.retentionPurged}</div>
              <div className="funnel-step-desc">7-day destroyed</div>
            </div>
          </div>
        </div>
      </div>

      {/* 5. 3-Donut Composition Grid */}
      <div className="reports-distribution-grid" id="reports-distribution-grid">
        {/* Donut 1: Case Lifecycle */}
        <div className="distribution-donut-card" id="chart-case-distribution">
          <div className="report-chart-header">
            <div className="report-chart-title-group">
              <div className="chart-icon-box text-blue">
                <IconPieChart size={18} />
              </div>
              <div>
                <h3 className="report-chart-title">Case Lifecycle Distribution</h3>
                <span className="report-chart-subtitle">Customer cases across progress states</span>
              </div>
            </div>
          </div>
          {renderDonutChart(caseSegments, kpis.totalCases, "Cases", "donut-case-lifecycle")}
        </div>

        {/* Donut 2: Document Types */}
        <div className="distribution-donut-card" id="chart-doctype-distribution">
          <div className="report-chart-header">
            <div className="report-chart-title-group">
              <div className="chart-icon-box text-green">
                <IconFileText size={18} />
              </div>
              <div>
                <h3 className="report-chart-title">Document Type Mix</h3>
                <span className="report-chart-subtitle">Breakdown of uploaded document categories</span>
              </div>
            </div>
          </div>
          {renderDonutChart(docTypeSegments, kpis.totalDocs, "Documents", "donut-doctype-mix")}
        </div>

        {/* Donut 3: Manual Review Reasons */}
        <div className="distribution-donut-card" id="chart-review-reasons">
          <div className="report-chart-header">
            <div className="report-chart-title-group">
              <div className="chart-icon-box text-amber">
                <IconAlertTriangle size={18} />
              </div>
              <div>
                <h3 className="report-chart-title">Review Escalation Signals</h3>
                <span className="report-chart-subtitle">Root causes triggering human inspection</span>
              </div>
            </div>
          </div>
          {renderDonutChart(reviewReasonSegments, kpis.totalReviews || reviews.length, "Reviews", "donut-review-reasons")}
        </div>
      </div>

      {/* 6. Document-Type Performance Matrix Table */}
      <div className="reports-doc-performance-card" id="reports-doc-performance-card">
        <div className="report-chart-header">
          <div className="report-chart-title-group">
            <div className="chart-icon-box text-blue">
              <IconFileText size={18} />
            </div>
            <div>
              <h3 className="report-chart-title">Document Processing & SLA Performance Matrix</h3>
              <span className="report-chart-subtitle">
                Deterministic rules throughput, manual review frequency, and OCR quality by document slot
              </span>
            </div>
          </div>
        </div>

        <div className="report-table-wrapper" style={{ overflowX: "auto" }}>
          <table className="doc-performance-table" id="reports-doc-performance-table">
            <thead>
              <tr>
                <th onClick={() => handleSortMatrix("label")} style={{ cursor: "pointer" }}>
                  Document Type {sortKey === "label" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
                </th>
                <th onClick={() => handleSortMatrix("totalUploaded")} style={{ cursor: "pointer" }}>
                  Volume {sortKey === "totalUploaded" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
                </th>
                <th onClick={() => handleSortMatrix("verifiedRate")} style={{ cursor: "pointer" }}>
                  Auto-Verified Rate {sortKey === "verifiedRate" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
                </th>
                <th onClick={() => handleSortMatrix("reviewRate")} style={{ cursor: "pointer" }}>
                  Manual Review Rate {sortKey === "reviewRate" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
                </th>
                <th onClick={() => handleSortMatrix("ocrFailureRate")} style={{ cursor: "pointer" }}>
                  OCR Error Rate {sortKey === "ocrFailureRate" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
                </th>
                <th>Storage Status</th>
              </tr>
            </thead>
            <tbody>
              {performanceMatrix.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "24px", color: "var(--adm-text-muted)" }}>
                    No document activity recorded for this filter selection.
                  </td>
                </tr>
              ) : (
                performanceMatrix.map((row) => (
                  <tr key={row.docType} id={`doc-perf-row-${row.docType}`}>
                    <td style={{ fontWeight: 600 }}>{row.label}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{row.totalUploaded}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ minWidth: 32, fontVariantNumeric: "tabular-nums" }}>{row.verifiedRate}%</span>
                        <div style={{ flex: 1, height: 6, background: "rgba(148, 163, 184, 0.15)", borderRadius: 9999, overflow: "hidden", maxWidth: 100 }}>
                          <div style={{ width: `${row.verifiedRate}%`, height: "100%", background: "var(--adm-success, #10b981)" }} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`tag ${row.reviewRate > 30 ? "tag-warn" : ""}`}>
                        {row.reviewRate}% ({row.reviewCount})
                      </span>
                    </td>
                    <td>
                      <span className={`tag ${row.ocrFailureRate > 10 ? "tag-bad" : ""}`}>
                        {row.ocrFailureRate}% ({row.ocrFailureCount})
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: 11, color: "var(--adm-text-muted, #94a3b8)" }}>
                        {row.storedCount} stored · {row.purgedCount} purged
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 7. DPDP Retention & Reminders Compliance Grid */}
      <div className="card report-section-card" id="reports-compliance-card">
        <h3 className="section-title">
          <IconShield size={18} /> DPDP Statutory Data Retention & Notification Compliance
        </h3>
        <p className="section-subtitle">
          Audited regulatory guarantees: zero long-term file retention, automatic 7-day cryptographic erasure, and active reminder lifecycle controls.
        </p>

        <div className="compliance-grid">
          <div className="compliance-box">
            <span className="comp-label">Storage Retention Cap</span>
            <span className="comp-val">7 Days</span>
            <span className="comp-desc">Encrypted document blobs permanently erased after case completion</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Unfinished Portal Expiry</span>
            <span className="comp-val">30 Days</span>
            <span className="comp-desc">Incomplete customer portals expire automatically with audit log</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Permanently Purged Cases</span>
            <span className="comp-val">{kpis.retentionPurged}</span>
            <span className="comp-desc">Storage wiped with SHA-256 ledger proof preserved</span>
          </div>

          <div className="compliance-box">
            <span className="comp-label">Reminders Cycle Active</span>
            <span className="comp-val">{kpis.remindersActive}</span>
            <span className="comp-desc">Customers tracked in 3 / 7 / 14-day automated dispatch</span>
          </div>
        </div>
      </div>
    </div>
  );
};
