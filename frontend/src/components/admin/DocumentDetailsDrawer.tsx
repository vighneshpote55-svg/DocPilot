import React, { useEffect } from "react";
import type { AdminDocumentItem } from "../../types";
import {
  IconX,
  IconShieldCheck,
  IconFileText,
  IconEye,
  IconDownload,
  IconTrash2,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconAlertCircle,
  IconArchive,
  IconExternalLink,
} from "./AdminIcons";

interface DocumentDetailsDrawerProps {
  isOpen: boolean;
  document: AdminDocumentItem | null;
  customerName?: string;
  customerCode?: string;
  customerId?: number;
  allowDownload?: boolean;
  onClose: () => void;
  onSecureView: (docId: string, title: string) => void;
  onDownload?: (docId: string, filename: string) => void;
  onDeleteFile?: (docId: string) => void;
}

export const DocumentDetailsDrawer: React.FC<DocumentDetailsDrawerProps> = ({
  isOpen,
  document: doc,
  customerName,
  customerCode,
  customerId,
  allowDownload = false,
  onClose,
  onSecureView,
  onDownload,
  onDeleteFile,
}) => {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !doc) return null;

  // Determine unified status
  let unifiedState: "verified" | "processing" | "pending_upload" | "manual_review" | "rejected" | "failed" = "processing";
  let statusLabel = "Processing";
  let statusBadgeClass = "tag-processing";
  let statusDescription = "Document is queued or undergoing automated extraction and rule checks.";

  if (doc.file_state === "deleted") {
    statusLabel = "File Purged";
    statusBadgeClass = "tag-deleted";
    statusDescription = "Encrypted file data has been permanently deleted in accordance with retention policy.";
  } else if (doc.verification_status === "verified") {
    unifiedState = "verified";
    statusLabel = "Verified";
    statusBadgeClass = "tag-verified";
    statusDescription = "Document meets all compliance criteria and verification rules passed successfully.";
  } else if (doc.verification_status === "manual_review") {
    unifiedState = "manual_review";
    statusLabel = "Manual Review Required";
    statusBadgeClass = "tag-review";
    statusDescription = doc.review_reason || "Flagged for manual review by automated rules engine.";
  } else if (doc.verification_status === "rejected") {
    unifiedState = "rejected";
    statusLabel = "Rejected";
    statusBadgeClass = "tag-rejected";
    statusDescription = doc.review_reason || "Document does not satisfy requirements. Customer must resubmit.";
  } else if (doc.ocr_status === "failed") {
    unifiedState = "failed";
    statusLabel = "OCR Extraction Failed";
    statusBadgeClass = "tag-failed";
    statusDescription = "OCR service was unable to parse text or image resolution was insufficient.";
  } else if (doc.ocr_status === "processing" || doc.ocr_status === "waiting") {
    unifiedState = "processing";
    statusLabel = "Processing";
    statusBadgeClass = "tag-processing";
    statusDescription = "Document is undergoing automated OCR entity extraction.";
  }

  // Stepped timeline states
  const step2Encrypted = doc.file_state === "stored";
  const step3Ocr = doc.ocr_status === "completed" ? "complete" : doc.ocr_status === "failed" ? "failed" : "in_progress";
  const step4Rules =
    doc.verification_status === "verified"
      ? "complete"
      : doc.verification_status === "rejected" || doc.verification_status === "manual_review"
      ? "flagged"
      : "in_progress";
  const step5Decision =
    doc.verification_status === "verified"
      ? "verified"
      : doc.verification_status === "rejected"
      ? "rejected"
      : doc.verification_status === "manual_review"
      ? "review"
      : "pending";

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      id="doc-details-backdrop"
    >
      <div
        className="drawer-panel"
        id="document-details-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 580 }}
      >
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="drawer-header-left">
            <div className="drawer-header-avatar">
              <IconFileText size={24} color="var(--adm-primary)" />
            </div>
            <div>
              <h2 className="drawer-title">{doc.label}</h2>
              <p className="drawer-subtitle">
                {doc.filename} {doc.superseded && "• (Superseded)"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="Close document details"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="drawer-body">
          {/* Superseded Warning Banner */}
          {doc.superseded && (
            <div
              className="drawer-banner-warn"
              style={{
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <IconArchive size={18} color="var(--adm-warning)" />
              <div style={{ fontSize: 13, color: "var(--adm-text)" }}>
                <b>Superseded Document:</b> A newer file was uploaded by the customer to replace this document.
              </div>
            </div>
          )}

          {/* Primary Status Card */}
          <div className="doc-status-hero-card">
            <div className="doc-status-hero-top">
              <span className={`status-badge-lg ${statusBadgeClass}`}>
                {unifiedState === "verified" && <IconCheck size={16} />}
                {unifiedState === "manual_review" && <IconAlertTriangle size={16} />}
                {unifiedState === "rejected" && <IconAlertCircle size={16} />}
                {unifiedState === "failed" && <IconAlertCircle size={16} />}
                {unifiedState === "processing" && <IconClock size={16} />}
                {statusLabel}
              </span>
              <span className="doc-id-pill">ID: {doc.id.slice(0, 8)}...</span>
            </div>
            <p className="doc-status-hero-desc">{statusDescription}</p>
          </div>

          {/* Stepped Document Status Timeline */}
          <div className="drawer-section">
            <h4 className="drawer-section-title">
              <IconClock size={15} /> Document Lifecycle Timeline
            </h4>
            <div className="doc-lifecycle-stepper">
              {/* Step 1: Upload */}
              <div className="stepper-step completed">
                <div className="stepper-marker">
                  <IconCheck size={12} />
                </div>
                <div className="stepper-content">
                  <div className="stepper-title">Uploaded by Customer</div>
                  <div className="stepper-desc">
                    {new Date(doc.uploaded_at).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Step 2: Encryption & Storage */}
              <div className={`stepper-step ${step2Encrypted ? "completed" : "active"}`}>
                <div className="stepper-marker">
                  {step2Encrypted ? <IconCheck size={12} /> : <IconClock size={12} />}
                </div>
                <div className="stepper-content">
                  <div className="stepper-title">AES-256-GCM Encrypted & Stored</div>
                  <div className="stepper-desc">
                    {doc.file_state === "stored"
                      ? "Encrypted at rest in private cloud storage bucket"
                      : "File data permanently purged"}
                  </div>
                </div>
              </div>

              {/* Step 3: OCR Extraction */}
              <div className={`stepper-step ${step3Ocr === "complete" ? "completed" : step3Ocr === "failed" ? "failed" : "active"}`}>
                <div className="stepper-marker">
                  {step3Ocr === "complete" ? (
                    <IconCheck size={12} />
                  ) : step3Ocr === "failed" ? (
                    <IconX size={12} />
                  ) : (
                    <IconClock size={12} />
                  )}
                </div>
                <div className="stepper-content">
                  <div className="stepper-title">OCR Text & Entity Extraction</div>
                  <div className="stepper-desc">
                    Status: <b style={{ textTransform: "capitalize" }}>{doc.ocr_status}</b>
                    {doc.confidence !== undefined && doc.confidence !== null && (
                      <span> • Confidence: {Math.round(doc.confidence * 100)}%</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Step 4: Rules Engine Verification */}
              <div className={`stepper-step ${step4Rules === "complete" ? "completed" : step4Rules === "flagged" ? "warning" : "active"}`}>
                <div className="stepper-marker">
                  {step4Rules === "complete" ? (
                    <IconCheck size={12} />
                  ) : step4Rules === "flagged" ? (
                    <IconAlertTriangle size={12} />
                  ) : (
                    <IconClock size={12} />
                  )}
                </div>
                <div className="stepper-content">
                  <div className="stepper-title">Rules Engine Verification</div>
                  <div className="stepper-desc">
                    {doc.verification_status === "verified"
                      ? "Deterministic validation rules passed with zero flags"
                      : doc.verification_status === "manual_review"
                      ? "Risk flag triggered • Queued for staff review"
                      : doc.verification_status === "rejected"
                      ? "Verification failed • Invalid entity or expired document"
                      : "Rules evaluation pending"}
                  </div>
                </div>
              </div>

              {/* Step 5: Final Decision / Retention */}
              <div className={`stepper-step ${step5Decision === "verified" ? "completed" : step5Decision === "review" ? "warning" : step5Decision === "rejected" ? "failed" : "pending"}`}>
                <div className="stepper-marker">
                  {step5Decision === "verified" ? (
                    <IconShieldCheck size={12} />
                  ) : step5Decision === "review" ? (
                    <IconAlertTriangle size={12} />
                  ) : step5Decision === "rejected" ? (
                    <IconX size={12} />
                  ) : (
                    <IconClock size={12} />
                  )}
                </div>
                <div className="stepper-content">
                  <div className="stepper-title">Verification Outcome & Retention</div>
                  <div className="stepper-desc">
                    {doc.delete_after
                      ? `Scheduled for automatic purge: ${new Date(doc.delete_after).toLocaleDateString()}`
                      : "Retained within standard case policy"}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Verification Details & Flags */}
          <div className="drawer-section">
            <h4 className="drawer-section-title">
              <IconShieldCheck size={15} /> Verification & OCR Intelligence
            </h4>
            <div className="doc-intel-grid">
              <div className="doc-intel-item">
                <span className="doc-intel-label">Document Slot</span>
                <span className="doc-intel-value font-mono">{doc.doc_type}</span>
              </div>
              <div className="doc-intel-item">
                <span className="doc-intel-label">OCR Status</span>
                <span className="doc-intel-value" style={{ textTransform: "capitalize" }}>
                  {doc.ocr_status}
                </span>
              </div>
              <div className="doc-intel-item">
                <span className="doc-intel-label">Verification State</span>
                <span className="doc-intel-value" style={{ textTransform: "capitalize" }}>
                  {(doc.verification_status || "").replace("_", " ")}
                </span>
              </div>
              <div className="doc-intel-item">
                <span className="doc-intel-label">File Storage State</span>
                <span className="doc-intel-value" style={{ textTransform: "capitalize" }}>
                  {doc.file_state}
                </span>
              </div>
            </div>

            {/* Risk Flags */}
            <div style={{ marginTop: 12 }}>
              <span className="doc-intel-label" style={{ display: "block", marginBottom: 6 }}>
                Active Risk Flags
              </span>
              {doc.flags && doc.flags.length > 0 ? (
                <div className="risk-flags-wrap">
                  {doc.flags.map((flag, idx) => (
                    <span key={idx} className="risk-flag-pill">
                      <IconAlertTriangle size={12} />
                      {flag}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="no-flags-text">
                  <IconCheck size={14} color="var(--adm-success)" /> No security or quality risk flags detected
                </span>
              )}
            </div>

            {/* Review Reason */}
            {doc.review_reason && (
              <div className="review-reason-box">
                <span className="review-reason-label">Reviewer / Policy Reason:</span>
                <p className="review-reason-text">{doc.review_reason}</p>
              </div>
            )}
          </div>

          {/* Associated Case Context */}
          {(customerName || customerCode) && (
            <div className="drawer-section">
              <h4 className="drawer-section-title">Associated Case</h4>
              <div className="drawer-case-pill">
                <div>
                  <div style={{ fontWeight: 600, color: "var(--adm-text)" }}>
                    {customerName || "Customer"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
                    {customerCode}
                  </div>
                </div>
                {customerId && (
                  <a
                    href={`/admin/customers/${customerId}`}
                    className="btn sec"
                    style={{ fontSize: 12, padding: "4px 8px" }}
                  >
                    View Case <IconExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer Actions */}
        <div className="drawer-footer">
          {doc.file_state === "stored" ? (
            <div className="drawer-footer-actions" style={{ display: "flex", gap: 8, width: "100%" }}>
              <button
                type="button"
                className="btn pri"
                style={{ flex: 1 }}
                onClick={() => onSecureView(doc.id, `${doc.label} - ${doc.filename}`)}
              >
                <IconEye size={15} /> Secure View
              </button>

              {allowDownload && onDownload && (
                <button
                  type="button"
                  className="btn sec"
                  onClick={() => onDownload(doc.id, doc.filename)}
                  title="Download decrypted file safely"
                >
                  <IconDownload size={15} /> Download
                </button>
              )}

              {onDeleteFile && (
                <button
                  type="button"
                  className="btn bad"
                  onClick={() => {
                    if (confirm("Are you sure you want to permanently delete the stored encrypted file for this document?")) {
                      onDeleteFile(doc.id);
                    }
                  }}
                  title="Permanently delete file from storage"
                >
                  <IconTrash2 size={15} /> Delete File
                </button>
              )}
            </div>
          ) : (
            <div style={{ width: "100%", textAlign: "center", color: "var(--adm-text-muted)", fontSize: 13 }}>
              File data permanently deleted from storage.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
