import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import type { AdminReviewItem } from "../../types";
import { ManualReviewDetailModal } from "./ManualReviewDetailModal";
import {
  IconAlertTriangle,
  IconShieldCheck,
  IconSearch,
  IconEye,
  IconRefreshCw,
  IconArrowRight,
  IconCheck,
} from "./AdminIcons";
import { Skeleton } from "./Skeleton";

interface AdminReviewsViewProps {
  reviews: AdminReviewItem[];
  loading: boolean;
  onRefresh: () => void;
  onApproveReview: (reviewId: string, note?: string) => Promise<void>;
  onRejectReview: (reviewId: string, note?: string) => Promise<void>;
  onSecureView?: (docId: string, title?: string) => void;
  activeStatusFilter: "open" | "approved" | "rejected" | "all";
  onStatusFilterChange: (status: "open" | "approved" | "rejected" | "all") => void;
}

export const AdminReviewsView: React.FC<AdminReviewsViewProps> = ({
  reviews,
  loading,
  onRefresh,
  onApproveReview,
  onRejectReview,
  onSecureView,
  activeStatusFilter,
  onStatusFilterChange,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [selectedReview, setSelectedReview] = useState<AdminReviewItem | null>(null);

  // Filter reviews client-side by search query and priority flags
  const filteredReviews = useMemo(() => {
    return reviews.filter((r) => {
      // 1. Text Search Filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const custName = (r.customer_name || r.document?.customer_name || "").toLowerCase();
        const custCode = (r.customer_code || "").toLowerCase();
        const docLabel = (r.document?.label || "").toLowerCase();
        const docType = (r.document?.doc_type || "").toLowerCase();
        const reason = (r.reason || r.document?.review_reason || "").toLowerCase();
        const flags = (r.flags || r.document?.flags || []).map((f) => f.toLowerCase());

        const matchesName = custName.includes(q);
        const matchesCode = custCode.includes(q);
        const matchesDoc = docLabel.includes(q) || docType.includes(q);
        const matchesReason = reason.includes(q);
        const matchesFlags = flags.some((f) => f.includes(q));

        if (!matchesName && !matchesCode && !matchesDoc && !matchesReason && !matchesFlags) {
          return false;
        }
      }

      // 2. Priority Filter
      if (priorityFilter !== "all") {
        if (priorityFilter === "multi_flags") {
          if (!r.flags || r.flags.length < 2) return false;
        } else if (priorityFilter === "name_mismatch") {
          const hasNameFlag = r.flags?.some((f) => f.includes("name") || f.includes("mismatch"));
          const hasNameReason = r.reason?.toLowerCase().includes("name");
          if (!hasNameFlag && !hasNameReason) return false;
        } else if (priorityFilter === "low_confidence") {
          const conf = r.ocr_evidence?.confidence !== undefined ? Number(r.ocr_evidence.confidence) : 1;
          const pct = conf <= 1 ? conf * 100 : conf;
          if (pct >= 80) return false;
        } else if (priorityFilter === "expired") {
          const hasExp = r.flags?.some((f) => f.includes("expir")) || r.reason?.toLowerCase().includes("expir");
          if (!hasExp) return false;
        } else if (priorityFilter === "tampering") {
          const hasTamper = r.flags?.some((f) => f.includes("blur") || f.includes("stamp") || f.includes("tamper") || f.includes("face"));
          if (!hasTamper) return false;
        }
      }

      return true;
    });
  }, [reviews, searchQuery, priorityFilter]);

  const openCount = useMemo(() => {
    return reviews.filter((r) => !r.status || r.status === "open").length;
  }, [reviews]);

  const formatTime = (isoString: string): string => {
    try {
      const d = new Date(isoString);
      return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch {
      return isoString;
    }
  };

  return (
    <div className="reviews-queue-container" id="admin-reviews-view">
      {/* Queue Header & Live Metrics Bar */}
      <div className="reviews-header-bar">
        <div className="reviews-title-group">
          <IconAlertTriangle size={24} color="#f59e0b" />
          <div>
            <h1 className="reviews-header-title">Manual Reviews</h1>
            <p className="admin-section-subheading" style={{ margin: "2px 0 0", fontSize: 12, color: "var(--adm-text-muted)" }}>
              Review documents requiring human verification
            </p>
          </div>
          <span
            className={`reviews-kpi-badge ${openCount === 0 ? "zero" : ""}`}
            id="reviews-pending-kpi"
          >
            <span className="pulse-dot" />
            <span>{openCount} Pending Review</span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="btn-toolbar-tool"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh review queue"
            id="btn-refresh-reviews"
            style={{ fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <IconRefreshCw size={14} className={loading ? "spin" : ""} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Toolbar: Status Tabs + Priority Filter + Search Bar */}
      <div className="reviews-toolbar">
        {/* Status Segmented Tabs */}
        <div className="reviews-status-tabs" role="tablist" aria-label="Review status filters">
          <button
            type="button"
            role="tab"
            aria-selected={activeStatusFilter === "open"}
            className={`reviews-tab-btn ${activeStatusFilter === "open" ? "active" : ""}`}
            onClick={() => onStatusFilterChange("open")}
            id="tab-filter-open"
          >
            <span>Pending Review</span>
            <span className="reviews-tab-count">{openCount}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeStatusFilter === "approved"}
            className={`reviews-tab-btn ${activeStatusFilter === "approved" ? "active" : ""}`}
            onClick={() => onStatusFilterChange("approved")}
            id="tab-filter-approved"
          >
            <span>Approved</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeStatusFilter === "rejected"}
            className={`reviews-tab-btn ${activeStatusFilter === "rejected" ? "active" : ""}`}
            onClick={() => onStatusFilterChange("rejected")}
            id="tab-filter-rejected"
          >
            <span>Rejected / Resubmit</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeStatusFilter === "all"}
            className={`reviews-tab-btn ${activeStatusFilter === "all" ? "active" : ""}`}
            onClick={() => onStatusFilterChange("all")}
            id="tab-filter-all"
          >
            <span>All Items</span>
          </button>
        </div>

        {/* Priority & Search Filters */}
        <div className="reviews-filter-group">
          {/* Priority Trigger Filter */}
          <select
            className="reviews-select-filter"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            aria-label="Filter by trigger priority"
            id="reviews-priority-select"
          >
            <option value="all">All Exception Triggers</option>
            <option value="multi_flags">High Priority (2+ Flags)</option>
            <option value="name_mismatch">Name Mismatch</option>
            <option value="low_confidence">OCR Low Confidence (&lt;80%)</option>
            <option value="expired">Expired Document Date</option>
            <option value="tampering">Image Quality / Tamper Warning</option>
          </select>

          {/* Search Box */}
          <div className="reviews-search-box">
            <IconSearch size={15} color="var(--adm-text-muted)" />
            <input
              type="text"
              placeholder="Search customer, code, slot..."
              className="reviews-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search manual reviews"
              id="reviews-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{ background: "none", border: "none", color: "var(--adm-text-muted)", cursor: "pointer", padding: 0 }}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Review Queue Table */}
      {loading ? (
        <div className="reviews-empty-card" id="reviews-loading-state" style={{ padding: 24, textAlign: "left" }}>
          <Skeleton variant="row" count={5} />
          <p className="mut" style={{ textAlign: "center", marginTop: 12 }}>Loading Manual Review Queue…</p>
        </div>
      ) : filteredReviews.length === 0 ? (
        /* Empty Queue State */
        <div className="reviews-empty-card" id="reviews-empty-state">
          <div className="reviews-empty-icon">
            <IconShieldCheck size={34} />
          </div>
          <h3 className="reviews-empty-title">
            {searchQuery || priorityFilter !== "all"
              ? "No Matching Review Items Found"
              : "No documents require manual review."}
          </h3>
          <p className="reviews-empty-sub">
            {searchQuery || priorityFilter !== "all"
              ? "Try adjusting your search criteria or resetting the priority filter to view other queue items."
              : "All flagged customer documents have been inspected and resolved. Incoming exceptions will automatically populate here."}
          </p>
          {(searchQuery || priorityFilter !== "all") && (
            <button
              type="button"
              className="customer-access-btn"
              onClick={() => {
                setSearchQuery("");
                setPriorityFilter("all");
              }}
              style={{ marginTop: 16, fontSize: 13, padding: "8px 16px" }}
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        /* Populated Review Table */
        <div className="reviews-table-wrap">
          <table className="reviews-table" id="reviews-queue-table">
            <thead>
              <tr>
                <th style={{ width: "24%" }}>Customer Profile</th>
                <th style={{ width: "18%" }}>Document Slot</th>
                <th style={{ width: "26%" }}>Review Reason &amp; Risk Flags</th>
                <th style={{ width: "12%" }}>Status</th>
                <th style={{ width: "10%" }}>Queued</th>
                <th style={{ width: "10%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredReviews.map((r) => {
                const confScore = r.ocr_evidence?.confidence !== undefined
                  ? Math.round(Number(r.ocr_evidence.confidence) * (Number(r.ocr_evidence.confidence) <= 1 ? 100 : 1))
                  : null;

                const isApproved = r.status === "approved";
                const isRejected = r.status === "rejected";

                return (
                  <tr key={r.id} id={`review-row-${r.id}`} className="review-item-row">
                    {/* Customer Info */}
                    <td>
                      <div className="reviews-customer-cell">
                        <div className="reviews-avatar">
                          {r.customer_name ? r.customer_name.slice(0, 2).toUpperCase() : "CU"}
                        </div>
                        <div>
                          <div className="reviews-customer-name">{r.customer_name}</div>
                          <Link
                            to={`/admin/customers/${r.customer_id}`}
                            className="reviews-code-chip"
                            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
                            title="Open customer case details"
                          >
                            <span>{r.customer_code}</span>
                            <IconArrowRight size={10} />
                          </Link>
                        </div>
                      </div>
                    </td>

                    {/* Document Slot */}
                    <td>
                      <div className="reviews-doc-cell">
                        <span className="reviews-doc-label">{r.document.label}</span>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span className="doc-card-slot-chip">{r.document.doc_type}</span>
                          {confScore !== null && (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: confScore >= 80 ? "#10b981" : "#f59e0b",
                              }}
                            >
                              {confScore}% Conf.
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Trigger Reason & Risk Flags */}
                    <td>
                      <div className="reviews-reason-cell">
                        <div className="reviews-reason-text">
                          {r.reason || "Confidence below auto-verification threshold"}
                        </div>
                        {r.flags && r.flags.length > 0 && (
                          <div className="reviews-flags-row">
                            {r.flags.map((flag, idx) => (
                              <span key={idx} className="review-flag-pill">
                                ⚠️ {flag.replace(/_/g, " ")}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Verification / Review Status */}
                    <td>
                      <span
                        className={`status-pill ${
                          isApproved
                            ? "case-completed"
                            : isRejected
                            ? "case-deleted"
                            : "consent-pending"
                        }`}
                        id={`review-status-badge-${r.id}`}
                      >
                        {isApproved ? (
                          <>
                            <IconCheck size={12} />
                            Verified
                          </>
                        ) : isRejected ? (
                          "Rejected"
                        ) : (
                          "Manual Review"
                        )}
                      </span>
                    </td>

                    {/* Queued Time */}
                    <td>
                      <span title={new Date(r.created_at).toUTCString()} style={{ color: "var(--adm-text-muted)" }}>
                        {formatTime(r.created_at)}
                      </span>
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: "right" }}>
                      <div className="review-actions-cell" style={{ justifyContent: "flex-end" }}>
                        {onSecureView && (
                          <button
                            type="button"
                            className="btn-toolbar-tool"
                            onClick={() => onSecureView(r.document.id, r.document.label)}
                            title="Stream decrypted document file"
                            id={`btn-review-view-${r.id}`}
                            style={{ padding: "6px 10px" }}
                          >
                            <IconEye size={14} />
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn-review-inspect"
                          onClick={() => setSelectedReview(r)}
                          id={`btn-open-review-${r.id}`}
                        >
                          <span>{isApproved || isRejected ? "View Decision" : "Review & Decide"}</span>
                          <IconArrowRight size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Manual Review Detail Modal */}
      {selectedReview && (
        <ManualReviewDetailModal
          isOpen={true}
          review={selectedReview}
          onClose={() => setSelectedReview(null)}
          onApprove={onApproveReview}
          onReject={onRejectReview}
          onOpenSecureViewer={onSecureView}
        />
      )}
    </div>
  );
};
