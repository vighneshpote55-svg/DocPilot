import type {
  AdminAuditItem,
  AdminCustomerListItem,
  AdminDocumentItem,
  AdminReviewItem,
  AdminSummary,
} from "../types";

export type DateRangePreset = "7d" | "14d" | "30d" | "90d" | "all";

export interface ReportFilters {
  dateRange: DateRangePreset;
  caseStatus: string; // "all" or specific CaseStatus
  docType: string; // "all" or specific doc_type
}

export interface ReportKpiSummary {
  // Cases & Turnaround
  totalCases: number;
  completedCases: number;
  inProgressCases: number;
  withdrawnCases: number;
  expiredCases: number;
  deletedCases: number;
  completionRate: number; // percentage (0 - 100)
  avgTurnaroundHours: number;
  avgTurnaroundDisplay: string;

  // Documents
  totalDocs: number;
  verifiedDocs: number;
  underReviewDocs: number;
  rejectedDocs: number;
  processingDocs: number;
  autoVerifyRate: number; // percentage (0 - 100)
  supersededCount: number;

  // OCR Intelligence
  ocrSuccessCount: number;
  ocrProcessingCount: number;
  ocrFailureCount: number;
  ocrSuccessRate: number; // percentage (0 - 100)
  ocrErrorRate: number; // percentage (0 - 100)

  // Manual Reviews & SLA
  totalReviews: number;
  openReviews: number;
  approvedReviews: number;
  rejectedReviews: number;
  reviewEscalationRate: number; // percentage (0 - 100)
  reviewApprovalRate: number; // percentage (0 - 100)

  // Reminders & Compliance
  remindersActive: number;
  remindersStopped: number;
  retentionActive: number;
  retentionDue: number;
  retentionPurged: number;
}

export interface DailyTrendPoint {
  dateStr: string; // YYYY-MM-DD
  displayDate: string; // "Oct 4"
  newCases: number;
  completedCases: number;
  uploadedDocs: number;
  verifiedDocs: number;
  ocrFailures: number;
}

export interface DonutSegment {
  key: string;
  label: string;
  count: number;
  percentage: number;
  color: string;
  strokeDasharray?: string;
  strokeDashoffset?: number;
}

export interface DocTypePerformanceRow {
  docType: string;
  label: string;
  totalUploaded: number;
  verifiedCount: number;
  verifiedRate: number;
  reviewCount: number;
  reviewRate: number;
  ocrFailureCount: number;
  ocrFailureRate: number;
  storedCount: number;
  purgedCount: number;
}

/**
 * Format document type slug into human-readable label
 */
export function formatDocTypeLabel(docType: string): string {
  if (!docType) return "Unknown Document";
  const map: Record<string, string> = {
    aadhaar: "Aadhaar Card",
    pan: "PAN Card",
    passport: "Passport",
    voter: "Voter ID Card",
    driving_licence: "Driving Licence",
    bank_statement: "Bank Statement",
    salary_slip: "Salary Slip",
    cancelled_cheque: "Cancelled Cheque",
    itr: "ITR Acknowledgement",
    udyam: "Udyam Registration",
    shop_establishment: "Shop & Establishment",
    fssai: "FSSAI License",
    utility_bill: "Utility Bill",
    gst_certificate: "GST Certificate",
    certificate_of_incorporation: "Certificate of Incorporation",
    partnership_deed: "Partnership Deed",
    rent_agreement: "Rent Agreement",
    form_16: "Form 16",
    bank_passbook: "Bank Passbook",
    property_tax_receipt: "Property Tax Receipt",
  };
  if (map[docType.toLowerCase()]) return map[docType.toLowerCase()];
  return docType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Return cutoff timestamp in ms for the chosen date range preset
 */
export function getDateRangeCutoff(preset: DateRangePreset, nowMs = Date.now()): number {
  const dayMs = 86400000;
  switch (preset) {
    case "7d":
      return nowMs - 7 * dayMs;
    case "14d":
      return nowMs - 14 * dayMs;
    case "30d":
      return nowMs - 30 * dayMs;
    case "90d":
      return nowMs - 90 * dayMs;
    case "all":
    default:
      return 0; // Epoch
  }
}

/**
 * Filter customers by date range, case status, and document type
 */
export function filterCustomersForReport(
  customers: AdminCustomerListItem[],
  filters: ReportFilters,
  nowMs = Date.now()
): AdminCustomerListItem[] {
  const cutoff = getDateRangeCutoff(filters.dateRange, nowMs);

  return customers.filter((c) => {
    // Date filter: check created_at or completed_at
    if (cutoff > 0) {
      const cDate = new Date(c.created_at || "").getTime();
      const compDate = c.completed_at ? new Date(c.completed_at).getTime() : 0;
      if (cDate < cutoff && compDate < cutoff) {
        return false;
      }
    }

    // Status filter
    if (filters.caseStatus && filters.caseStatus !== "all") {
      if (filters.caseStatus === "under_review") {
        // under_review cases are in_progress with all documents uploaded awaiting decision
        if (c.case_status !== "in_progress" || c.pending_count !== 0) return false;
      } else if (filters.caseStatus === "deleted_expired") {
        if (c.case_status !== "deleted" && c.case_status !== "expired") return false;
      } else if (c.case_status !== filters.caseStatus) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Filter documents by date range and document type
 */
export function filterDocumentsForReport(
  documents: AdminDocumentItem[],
  filters: ReportFilters,
  allowedCustomerIds?: Set<number>,
  nowMs = Date.now()
): AdminDocumentItem[] {
  const cutoff = getDateRangeCutoff(filters.dateRange, nowMs);

  return documents.filter((doc) => {
    // If customers are filtered, check customer_id
    if (allowedCustomerIds && "customer_id" in doc) {
      const custId = (doc as unknown as { customer_id?: number }).customer_id;
      if (custId && !allowedCustomerIds.has(custId)) {
        return false;
      }
    }

    // Date filter
    if (cutoff > 0 && doc.uploaded_at) {
      const uDate = new Date(doc.uploaded_at).getTime();
      if (uDate < cutoff) return false;
    }

    // Doc type filter
    if (filters.docType && filters.docType !== "all") {
      if (doc.doc_type.toLowerCase() !== filters.docType.toLowerCase()) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Calculate full KPI summary metrics from filtered records
 */
export function calculateReportKpis(
  summary: AdminSummary | null,
  filteredCustomers: AdminCustomerListItem[],
  filteredDocs: AdminDocumentItem[],
  reviews: AdminReviewItem[] = [],
  _auditLogs: AdminAuditItem[] = []
): ReportKpiSummary {
  const nowMs = Date.now();

  // 1. Cases
  const totalCases = filteredCustomers.length;
  let completedCases = 0;
  let inProgressCases = 0;
  let withdrawnCases = 0;
  let expiredCases = 0;
  let deletedCases = 0;
  let totalTurnaroundHours = 0;
  let turnaroundCount = 0;

  filteredCustomers.forEach((c) => {
    if (c.case_status === "completed") {
      completedCases++;
      if (c.completed_at && c.created_at) {
        const start = new Date(c.created_at).getTime();
        const end = new Date(c.completed_at).getTime();
        if (end > start) {
          const diffHours = (end - start) / (1000 * 3600);
          totalTurnaroundHours += diffHours;
          turnaroundCount++;
        }
      }
    } else if (c.case_status === "in_progress") {
      inProgressCases++;
    } else if (c.case_status === "withdrawn") {
      withdrawnCases++;
    } else if (c.case_status === "expired") {
      expiredCases++;
    } else if (c.case_status === "deleted") {
      deletedCases++;
    }
  });

  // If no customers passed through filter, fallback to summary data
  const finalTotalCases = totalCases > 0 ? totalCases : (summary?.metrics?.total_customers ?? 0);
  const finalCompletedCases = totalCases > 0 ? completedCases : (summary?.metrics?.completed_customers ?? 0);
  const completionRate = finalTotalCases > 0 ? Math.round((finalCompletedCases / finalTotalCases) * 100) : 0;

  const avgTurnaroundHours = turnaroundCount > 0 ? Math.round((totalTurnaroundHours / turnaroundCount) * 10) / 10 : 0;
  let avgTurnaroundDisplay = "N/A";
  if (avgTurnaroundHours > 0) {
    if (avgTurnaroundHours < 24) {
      avgTurnaroundDisplay = `${avgTurnaroundHours}h`;
    } else {
      const days = Math.round((avgTurnaroundHours / 24) * 10) / 10;
      avgTurnaroundDisplay = `${days}d`;
    }
  }

  // 2. Documents & Verification
  const totalDocs = filteredDocs.length;
  let verifiedDocs = 0;
  let underReviewDocs = 0;
  let rejectedDocs = 0;
  let processingDocs = 0;
  let supersededCount = 0;

  let ocrSuccessCount = 0;
  let ocrProcessingCount = 0;
  let ocrFailureCount = 0;

  filteredDocs.forEach((doc) => {
    if (doc.superseded) supersededCount++;

    // Verification
    const vStat = (doc.verification_status || "").toLowerCase();
    if (vStat === "verified") verifiedDocs++;
    else if (vStat === "under_review" || vStat === "manual_review") underReviewDocs++;
    else if (vStat === "rejected" || vStat === "failed") rejectedDocs++;
    else processingDocs++;

    // OCR
    const oStat = (doc.ocr_status || "").toLowerCase();
    if (oStat === "completed" || oStat === "success" || oStat === "verified") ocrSuccessCount++;
    else if (oStat === "failed" || oStat === "error") ocrFailureCount++;
    else ocrProcessingCount++;
  });

  // Fallbacks if filteredDocs empty but summary available
  const finalTotalDocs = totalDocs > 0 ? totalDocs : (summary?.metrics?.total_documents ?? 0);
  const finalVerifiedDocs = totalDocs > 0 ? verifiedDocs : (summary?.metrics?.verified_documents ?? 0);
  const finalReviewDocs = totalDocs > 0 ? underReviewDocs : (summary?.open_reviews ?? 0);
  const finalOcrFailures = totalDocs > 0 ? ocrFailureCount : (summary?.metrics?.ocr_failures ?? 0);

  const autoVerifyRate = finalTotalDocs > 0 ? Math.round((finalVerifiedDocs / finalTotalDocs) * 100) : 0;
  const ocrSuccessRate = finalTotalDocs > 0
    ? Math.round(((finalTotalDocs - finalOcrFailures) / finalTotalDocs) * 100)
    : 100;
  const ocrErrorRate = finalTotalDocs > 0 ? Math.round((finalOcrFailures / finalTotalDocs) * 100) : 0;

  // 3. Manual Reviews
  const totalReviews = reviews.length;
  let openReviews = 0;
  let approvedReviews = 0;
  let rejectedReviews = 0;

  reviews.forEach((r) => {
    const st = (r.status || "open").toLowerCase();
    if (st === "approved") approvedReviews++;
    else if (st === "rejected") rejectedReviews++;
    else openReviews++;
  });

  const decidedReviews = approvedReviews + rejectedReviews;
  const reviewApprovalRate = decidedReviews > 0 ? Math.round((approvedReviews / decidedReviews) * 100) : 0;
  const reviewEscalationRate = finalTotalDocs > 0 ? Math.round((finalReviewDocs / finalTotalDocs) * 100) : 0;

  // 4. Reminders & Retention Compliance
  let remindersActive = 0;
  let remindersStopped = 0;
  let retentionActive = 0;
  let retentionDue = 0;
  let retentionPurged = 0;

  filteredCustomers.forEach((c) => {
    // Reminders
    if (c.case_status === "completed" || c.consent_status === "withdrawn") {
      remindersStopped++;
    } else if (c.case_status === "in_progress") {
      remindersActive++;
    }

    // Retention
    if (c.case_status === "deleted" || c.data_deleted_at) {
      retentionPurged++;
    } else if (c.delete_after) {
      const delTime = new Date(c.delete_after).getTime();
      if (delTime <= nowMs) {
        retentionDue++;
      } else {
        retentionActive++;
      }
    }
  });

  return {
    totalCases: finalTotalCases,
    completedCases: finalCompletedCases,
    inProgressCases,
    withdrawnCases,
    expiredCases,
    deletedCases,
    completionRate,
    avgTurnaroundHours,
    avgTurnaroundDisplay,

    totalDocs: finalTotalDocs,
    verifiedDocs: finalVerifiedDocs,
    underReviewDocs: finalReviewDocs,
    rejectedDocs,
    processingDocs,
    autoVerifyRate,
    supersededCount,

    ocrSuccessCount,
    ocrProcessingCount,
    ocrFailureCount: finalOcrFailures,
    ocrSuccessRate,
    ocrErrorRate,

    totalReviews,
    openReviews: openReviews || (summary?.open_reviews ?? 0),
    approvedReviews,
    rejectedReviews,
    reviewEscalationRate,
    reviewApprovalRate,

    remindersActive,
    remindersStopped,
    retentionActive,
    retentionDue,
    retentionPurged,
  };
}

/**
 * Generate daily time-series buckets for the chosen date range
 */
export function generateDailyTrendData(
  customers: AdminCustomerListItem[],
  documents: AdminDocumentItem[],
  auditLogs: AdminAuditItem[],
  preset: DateRangePreset,
  nowMs = Date.now()
): DailyTrendPoint[] {
  const dayMs = 86400000;
  let daysCount = 7;
  if (preset === "14d") daysCount = 14;
  else if (preset === "30d") daysCount = 30;
  else if (preset === "90d") daysCount = 90;
  else if (preset === "all") daysCount = 30; // 30-day default window for "all" time trend

  const points: DailyTrendPoint[] = [];

  for (let i = daysCount - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * dayMs);
    const dateStr = d.toISOString().split("T")[0];
    const displayDate = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    points.push({
      dateStr,
      displayDate,
      newCases: 0,
      completedCases: 0,
      uploadedDocs: 0,
      verifiedDocs: 0,
      ocrFailures: 0,
    });
  }

  const pointMap = new Map(points.map((p) => [p.dateStr, p]));

  // Customer timestamps
  customers.forEach((c) => {
    if (c.created_at) {
      const dt = c.created_at.split("T")[0];
      const p = pointMap.get(dt);
      if (p) p.newCases++;
    }
    if (c.completed_at) {
      const dt = c.completed_at.split("T")[0];
      const p = pointMap.get(dt);
      if (p) p.completedCases++;
    }
  });

  // Document timestamps
  documents.forEach((doc) => {
    if (doc.uploaded_at) {
      const dt = doc.uploaded_at.split("T")[0];
      const p = pointMap.get(dt);
      if (p) {
        p.uploadedDocs++;
        if (doc.verification_status === "verified") p.verifiedDocs++;
        if (doc.ocr_status === "failed") p.ocrFailures++;
      }
    }
  });

  // Audit logs supplemental
  auditLogs.forEach((a) => {
    if (!a.at) return;
    const dt = a.at.split("T")[0];
    const p = pointMap.get(dt);
    if (p) {
      if (a.action === "document_verified" || a.action === "review_approved") {
        p.verifiedDocs++;
      }
      if (a.action === "ocr_failed") {
        p.ocrFailures++;
      }
    }
  });

  return points;
}

/**
 * Generate donut chart segments for Case Lifecycle Distribution
 */
export function generateCaseDistributionSegments(
  customers: AdminCustomerListItem[]
): DonutSegment[] {
  let completed = 0;
  let inProgress = 0;
  let underReview = 0;
  let withdrawn = 0;
  let deletedOrExpired = 0;

  customers.forEach((c) => {
    if (c.case_status === "completed") completed++;
    else if (c.case_status === "in_progress") {
      if (c.pending_count === 0 && c.received_count > 0) underReview++;
      else inProgress++;
    } else if (c.case_status === "withdrawn") withdrawn++;
    else deletedOrExpired++;
  });

  const total = completed + inProgress + underReview + withdrawn + deletedOrExpired;

  const raw: Array<{ key: string; label: string; count: number; color: string }> = [
    { key: "completed", label: "Completed", count: completed, color: "var(--adm-success, #10b981)" },
    { key: "in_progress", label: "Active Intake", count: inProgress, color: "var(--adm-primary, #3b82f6)" },
    { key: "under_review", label: "Under Review", count: underReview, color: "var(--adm-warn, #f59e0b)" },
    { key: "withdrawn", label: "Withdrawn", count: withdrawn, color: "var(--adm-text-muted, #64748b)" },
    { key: "deleted_expired", label: "Purged / Expired", count: deletedOrExpired, color: "var(--adm-danger, #ef4444)" },
  ];

  return computeDonutOffsets(raw, total);
}

/**
 * Generate donut chart segments for Document Types
 */
export function generateDocTypeDistributionSegments(
  documents: AdminDocumentItem[]
): DonutSegment[] {
  const counts: Record<string, number> = {};
  documents.forEach((d) => {
    const dt = d.doc_type || "other";
    counts[dt] = (counts[dt] || 0) + 1;
  });

  const total = documents.length;
  const colors = [
    "#3b82f6", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#8b5cf6", // purple
    "#06b6d4", // cyan
    "#ec4899", // pink
    "#64748b", // slate
  ];

  const sortedKeys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const raw: Array<{ key: string; label: string; count: number; color: string }> = sortedKeys.slice(0, 6).map((k, idx) => ({
    key: k,
    label: formatDocTypeLabel(k),
    count: counts[k],
    color: colors[idx % colors.length],
  }));

  // Group remainder into "other"
  if (sortedKeys.length > 6) {
    const otherCount = sortedKeys.slice(6).reduce((acc, k) => acc + counts[k], 0);
    raw.push({
      key: "other",
      label: "Other Document Types",
      count: otherCount,
      color: "#94a3b8",
    });
  }

  return computeDonutOffsets(raw, total);
}

/**
 * Generate donut chart segments for Review Escalation Reasons
 */
export function generateReviewReasonsSegments(
  reviews: AdminReviewItem[]
): DonutSegment[] {
  const counts: Record<string, number> = {};
  reviews.forEach((r) => {
    const reason = r.reason || (r.flags && r.flags[0]) || "Low OCR Confidence";
    counts[reason] = (counts[reason] || 0) + 1;
  });

  const total = reviews.length;
  const colors = ["#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#64748b"];

  const sortedKeys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const raw: Array<{ key: string; label: string; count: number; color: string }> = sortedKeys.map((k, idx) => ({
    key: k,
    label: k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    count: counts[k],
    color: colors[idx % colors.length],
  }));

  return computeDonutOffsets(raw, total);
}

/**
 * Helper to compute circumference and dash offsets for SVG donut chart
 */
function computeDonutOffsets(
  raw: Array<{ key: string; label: string; count: number; color: string }>,
  total: number,
  radius = 68
): DonutSegment[] {
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return raw.map((item) => {
    const percentage = total > 0 ? (item.count / total) * 100 : 0;
    const strokeDash = (percentage / 100) * circumference;
    const strokeDasharray = `${strokeDash} ${circumference}`;
    const strokeDashoffset = -cumulative;
    cumulative += strokeDash;

    return {
      ...item,
      percentage: Math.round(percentage),
      strokeDasharray,
      strokeDashoffset,
    };
  });
}

/**
 * Generate Document-Type Performance Matrix Table Rows
 */
export function generateDocTypePerformanceMatrix(
  documents: AdminDocumentItem[]
): DocTypePerformanceRow[] {
  const groups: Record<
    string,
    {
      total: number;
      verified: number;
      reviews: number;
      ocrFailures: number;
      stored: number;
      purged: number;
    }
  > = {};

  documents.forEach((d) => {
    const dt = (d.doc_type || "other").toLowerCase();
    if (!groups[dt]) {
      groups[dt] = {
        total: 0,
        verified: 0,
        reviews: 0,
        ocrFailures: 0,
        stored: 0,
        purged: 0,
      };
    }
    const g = groups[dt];
    g.total++;
    if (d.verification_status === "verified") g.verified++;
    if (d.verification_status === "under_review" || d.verification_status === "manual_review") g.reviews++;
    if (d.ocr_status === "failed") g.ocrFailures++;
    if (d.file_state === "deleted") g.purged++;
    else g.stored++;
  });

  return Object.entries(groups)
    .map(([docType, g]) => {
      const verifiedRate = g.total > 0 ? Math.round((g.verified / g.total) * 100) : 0;
      const reviewRate = g.total > 0 ? Math.round((g.reviews / g.total) * 100) : 0;
      const ocrFailureRate = g.total > 0 ? Math.round((g.ocrFailures / g.total) * 100) : 0;

      return {
        docType,
        label: formatDocTypeLabel(docType),
        totalUploaded: g.total,
        verifiedCount: g.verified,
        verifiedRate,
        reviewCount: g.reviews,
        reviewRate,
        ocrFailureCount: g.ocrFailures,
        ocrFailureRate,
        storedCount: g.stored,
        purgedCount: g.purged,
      };
    })
    .sort((a, b) => b.totalUploaded - a.totalUploaded);
}
