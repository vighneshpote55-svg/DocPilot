import React, { useState, useEffect, useCallback, useTransition } from "react";
import { Link } from "react-router-dom";
import { getAdminDocuments, deleteAdminDocumentFile, fetchDocumentFile } from "../../api";
import type { AdminDocumentItem } from "../../types";
import {
  IconSearch,
  IconFilter,
  IconEye,
  IconTrash2,
  IconFileText,
  IconCheck,
  IconAlertTriangle,
  IconAlertCircle,
  IconClock,
  IconShieldCheck,
  IconRefreshCw,
  IconInfo,
} from "./AdminIcons";
import { SecureDocViewerModal } from "./SecureDocViewerModal";
import { DocumentDetailsDrawer } from "./DocumentDetailsDrawer";

const ALL_DOC_TYPES = [
  { key: "aadhaar", label: "Aadhaar Card" },
  { key: "pan", label: "PAN Card" },
  { key: "passport", label: "Passport" },
  { key: "voter", label: "Voter ID" },
  { key: "driving_licence", label: "Driving Licence" },
  { key: "bank_statement", label: "Bank Statement" },
  { key: "salary_slip", label: "Salary Slip" },
  { key: "cancelled_cheque", label: "Cancelled Cheque" },
  { key: "itr", label: "ITR Ack" },
  { key: "udyam", label: "Udyam Registration" },
  { key: "shop_establishment", label: "Shop & Establishment" },
  { key: "fssai", label: "FSSAI License" },
  { key: "utility_bill", label: "Utility Bill" },
  { key: "gst_certificate", label: "GST Certificate" },
  { key: "certificate_of_incorporation", label: "Certificate of Incorporation" },
  { key: "partnership_deed", label: "Partnership Deed" },
  { key: "rent_agreement", label: "Rent Agreement" },
  { key: "form_16", label: "Form 16" },
  { key: "bank_passbook", label: "Bank Passbook" },
  { key: "property_tax_receipt", label: "Property Tax Receipt" },
  { key: "iec_certificate", label: "IEC Certificate" },
  { key: "income_certificate", label: "Income Certificate" },
];

export const AdminDocumentsView: React.FC = () => {
  const [documents, setDocuments] = useState<AdminDocumentItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeSearch, setActiveSearch] = useState<string>("");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [ocrFilter, setOcrFilter] = useState<string>("");
  const [, startTransition] = useTransition();

  // Modals & Drawers
  const [viewerDoc, setViewerDoc] = useState<{ id: string; label: string; filename: string } | null>(null);
  const [inspectDoc, setInspectDoc] = useState<AdminDocumentItem | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminDocuments(
        activeSearch,
        docTypeFilter,
        statusFilter,
        100,
        0,
        ocrFilter
      );
      setDocuments(res.documents || []);
      setTotalCount(res.totalCount || 0);
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load documents repository.");
      setLoading(false);
    }
  }, [activeSearch, docTypeFilter, statusFilter, ocrFilter]);

  useEffect(() => {
    queueMicrotask(() => {
      loadDocuments();
    });
  }, [loadDocuments]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(() => {
      setActiveSearch(searchQuery);
    });
  };

  const handleResetFilters = () => {
    setSearchQuery("");
    startTransition(() => {
      setActiveSearch("");
      setDocTypeFilter("");
      setStatusFilter("");
      setOcrFilter("");
    });
  };

  const handleDeleteFile = async (docId: string) => {
    if (!confirm("Are you sure you want to permanently delete the stored encrypted file for this document?")) {
      return;
    }
    try {
      await deleteAdminDocumentFile(docId);
      loadDocuments();
      if (inspectDoc && inspectDoc.id === docId) {
        setInspectDoc(null);
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete file.");
    }
  };

  const handleDownload = async (docId: string, filename: string) => {
    try {
      const blob = await fetchDocumentFile(docId, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to download document.");
    }
  };

  // Helper for status badge
  const renderVerificationBadge = (status: string, reason?: string | null) => {
    if (status === "verified") {
      return (
        <span className="badge-status-verified" title="Deterministic verification passed">
          <IconCheck size={12} /> Verified
        </span>
      );
    }
    if (status === "manual_review" || status === "under_review") {
      return (
        <span className="badge-status-review" title={reason || "Needs manual review"}>
          <IconAlertTriangle size={12} /> Under Review
        </span>
      );
    }
    if (status === "rejected") {
      return (
        <span className="badge-status-rejected" title={reason || "Verification rejected"}>
          <IconAlertCircle size={12} /> Rejected
        </span>
      );
    }
    return (
      <span className="badge-status-pending">
        <IconClock size={12} /> Unverified
      </span>
    );
  };

  const renderOcrBadge = (ocrStatus: string) => {
    if (ocrStatus === "completed") {
      return <span className="ocr-pill completed">OCR Done</span>;
    }
    if (ocrStatus === "failed") {
      return <span className="ocr-pill failed">OCR Failed</span>;
    }
    if (ocrStatus === "processing") {
      return <span className="ocr-pill processing">Processing</span>;
    }
    return <span className="ocr-pill waiting">Waiting</span>;
  };

  return (
    <div className="admin-documents-container" id="tab-pane-documents">
      {/* Title & Stats Bar */}
      <div className="documents-header-row">
        <div>
          <h2 className="admin-section-heading">Documents Repository</h2>
          <p className="admin-section-subheading">
            Inspect, filter, and stream customer documents across all verification pipelines
          </p>
        </div>

        <div className="doc-quick-stats">
          <div className="doc-quick-stat-pill">
            <span className="doc-stat-num">{totalCount}</span>
            <span className="doc-stat-lbl">Total Files</span>
          </div>
          <button
            type="button"
            className="btn sec"
            onClick={loadDocuments}
            title="Refresh documents list"
          >
            <IconRefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Filter Card */}
      <div className="admin-filter-card">
        <form onSubmit={handleSearchSubmit} className="doc-filter-form">
          <div className="filter-input-wrap" style={{ flex: "1 1 280px" }}>
            <IconSearch size={16} className="filter-input-icon" />
            <input
              type="search"
              placeholder="Search by customer name, email, code, or filename..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="admin-input-styled with-icon"
              id="doc-search-input"
            />
          </div>

          <select
            value={docTypeFilter}
            onChange={(e) => setDocTypeFilter(e.target.value)}
            className="admin-select-styled"
            id="doc-type-filter"
            style={{ flex: "0 0 180px" }}
          >
            <option value="">All Document Types</option>
            {ALL_DOC_TYPES.map((dt) => (
              <option key={dt.key} value={dt.key}>
                {dt.label}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="admin-select-styled"
            id="doc-status-filter"
            style={{ flex: "0 0 190px" }}
          >
            <option value="">All Verification States</option>
            <option value="verified">Verified</option>
            <option value="manual_review">Manual Review</option>
            <option value="under_review">Under Review</option>
            <option value="rejected">Rejected</option>
            <option value="unverified">Unverified / Pending</option>
          </select>

          <select
            value={ocrFilter}
            onChange={(e) => setOcrFilter(e.target.value)}
            className="admin-select-styled"
            id="doc-ocr-status-filter"
            style={{ flex: "0 0 160px" }}
          >
            <option value="">All OCR States</option>
            <option value="waiting">Waiting</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed / Errors</option>
          </select>

          <button type="submit" className="btn pri" id="doc-search-btn">
            <IconFilter size={14} /> Filter
          </button>

          {(activeSearch || docTypeFilter || statusFilter || ocrFilter) && (
            <button
              type="button"
              className="btn sec"
              onClick={handleResetFilters}
            >
              Reset
            </button>
          )}
        </form>
      </div>

      {/* Main Table Card */}
      <div className="admin-table-card">
        {loading ? (
          <div className="table-loading-state">
            <div className="spinner" />
            <p>Loading document records...</p>
          </div>
        ) : error ? (
          <div className="table-error-state">
            <IconAlertCircle size={32} color="var(--adm-danger)" />
            <p>{error}</p>
            <button type="button" className="btn sec" onClick={loadDocuments}>
              Retry
            </button>
          </div>
        ) : documents.length === 0 ? (
          <div className="table-empty-state">
            <IconFileText size={40} color="var(--adm-text-muted)" />
            <p className="empty-title">No documents found</p>
            <p className="empty-desc">
              {activeSearch || docTypeFilter || statusFilter || ocrFilter
                ? "Try adjusting your search query or clear filters to see more results."
                : "No customer documents have been uploaded yet."}
            </p>
          </div>
        ) : (
          <div className="admin-table-responsive">
            <table className="admin-data-table" id="all-documents-table">
              <thead>
                <tr>
                  <th>CUSTOMER</th>
                  <th>DOCUMENT</th>
                  <th>UPLOADED</th>
                  <th>OCR</th>
                  <th>VERIFICATION</th>
                  <th>STORAGE</th>
                  <th>RISK / REASON</th>
                  <th style={{ textAlign: "right" }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr
                    key={d.id}
                    className="table-row-hoverable"
                    onClick={() => setInspectDoc(d)}
                  >
                    <td>
                      <div>
                        <Link
                          to={`/admin/customers/${d.customer_id}`}
                          className="customer-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {d.customer_name || `Customer #${d.customer_id}`}
                        </Link>
                      </div>
                      <span className="customer-code-sub">
                        {d.customer_code}
                      </span>
                    </td>

                    <td>
                      <div className="doc-label-row">
                        <span className="doc-type-label">{d.label}</span>
                        {d.superseded && (
                          <span className="badge-superseded">Superseded</span>
                        )}
                      </div>
                      <span className="doc-filename-sub">{d.filename}</span>
                    </td>

                    <td>
                      <span className="text-secondary-sm">
                        {d.uploaded_at ? new Date(d.uploaded_at).toLocaleString() : "—"}
                      </span>
                    </td>

                    <td>{renderOcrBadge(d.ocr_status)}</td>

                    <td>{renderVerificationBadge(d.verification_status, d.review_reason)}</td>

                    <td>
                      {d.file_state === "stored" ? (
                        <span className="badge-storage-stored">
                          <IconShieldCheck size={11} /> Encrypted
                        </span>
                      ) : (
                        <span className="badge-storage-purged">Purged</span>
                      )}
                    </td>

                    <td>
                      {d.flags && d.flags.length > 0 ? (
                        <div className="risk-flag-mini-pill" title={d.flags.join(", ")}>
                          <IconAlertTriangle size={12} /> {d.flags[0]}
                          {d.flags.length > 1 && ` +${d.flags.length - 1}`}
                        </div>
                      ) : d.review_reason ? (
                        <span className="text-secondary-sm" title={d.review_reason}>
                          {d.review_reason.slice(0, 24)}...
                        </span>
                      ) : (
                        <span className="text-muted-sm">—</span>
                      )}
                    </td>

                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <div className="table-actions-cell" style={{ justifyContent: "flex-end" }}>
                        {d.file_state === "stored" && (
                          <button
                            type="button"
                            className="btn-action-view"
                            onClick={() =>
                              setViewerDoc({
                                id: d.id,
                                label: d.label,
                                filename: d.filename,
                              })
                            }
                            title="Stream decrypted file safely"
                          >
                            <IconEye size={13} /> View
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn-action-view"
                          onClick={() => setInspectDoc(d)}
                          title="Inspect document metadata & timeline"
                          style={{ background: "transparent", borderColor: "var(--adm-border)" }}
                        >
                          <IconInfo size={13} /> Inspect
                        </button>

                        {d.file_state === "stored" && (
                          <button
                            type="button"
                            className="btn-action-delete"
                            onClick={() => handleDeleteFile(d.id)}
                            title="Permanently delete file"
                          >
                            <IconTrash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Secure Document Viewer Modal */}
      {viewerDoc && (
        <SecureDocViewerModal
          isOpen={Boolean(viewerDoc)}
          docId={viewerDoc.id}
          label={viewerDoc.label}
          filename={viewerDoc.filename}
          allowDownload={true}
          onClose={() => setViewerDoc(null)}
        />
      )}

      {/* Document Details Drawer */}
      {inspectDoc && (
        <DocumentDetailsDrawer
          isOpen={Boolean(inspectDoc)}
          document={inspectDoc}
          customerName={inspectDoc.customer_name}
          customerCode={inspectDoc.customer_code}
          customerId={inspectDoc.customer_id}
          allowDownload={true}
          onClose={() => setInspectDoc(null)}
          onSecureView={(id) => {
            setViewerDoc({ id, label: inspectDoc.label, filename: inspectDoc.filename });
          }}
          onDownload={handleDownload}
          onDeleteFile={handleDeleteFile}
        />
      )}
    </div>
  );
};
