import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { fetchDocumentFile } from "../../api";
import type { AdminReviewItem } from "../../types";
import { useDialogA11y } from "../../utils/a11yUtils";
import {
  IconX,
  IconShieldCheck,
  IconZoomIn,
  IconZoomOut,
  IconRotateCw,
  IconAlertTriangle,
  IconCheck,
  IconFileText,
  IconLock,
  IconEye,
  IconRefreshCw,
  IconArrowRight,
} from "./AdminIcons";

interface ManualReviewDetailModalProps {
  isOpen: boolean;
  review: AdminReviewItem | null;
  onClose: () => void;
  onApprove: (reviewId: string, note?: string) => Promise<void>;
  onReject: (reviewId: string, note?: string) => Promise<void>;
  onOpenSecureViewer?: (docId: string, title?: string) => void;
}

export const ManualReviewDetailModal: React.FC<ManualReviewDetailModalProps> = ({
  isOpen,
  review,
  onClose,
  onApprove,
  onReject,
  onOpenSecureViewer,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState<boolean>(true);
  const [docError, setDocError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(100);
  const [rotation, setRotation] = useState<number>(0);
  const blobUrlRef = useRef<string | null>(null);

  const [reviewerNote, setReviewerNote] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Confirmation dialog state: null | "approve" | "reject"
  const [confirmAction, setConfirmAction] = useState<"approve" | "reject" | null>(null);

  const cleanupUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setBlobUrl(null);
  }, []);

  const loadDocument = useCallback(async (docId: string) => {
    setLoadingDoc(true);
    setDocError(null);
    cleanupUrl();

    try {
      const blob = await fetchDocumentFile(docId, false);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setBlobUrl(url);
      setMimeType(blob.type || "");
      setLoadingDoc(false);
    } catch (err: unknown) {
      setDocError(err instanceof Error ? err.message : "Failed to decrypt and load document stream.");
      setLoadingDoc(false);
    }
  }, [cleanupUrl]);

  useEffect(() => {
    if (isOpen && review?.document?.id) {
      queueMicrotask(() => {
        setReviewerNote(review.note || "");
        setActionError(null);
        setConfirmAction(null);
        loadDocument(review.document.id);
      });
    } else {
      queueMicrotask(() => {
        cleanupUrl();
        setZoom(100);
        setRotation(0);
        setConfirmAction(null);
        setActionError(null);
      });
    }
    return () => {
      cleanupUrl();
    };
  }, [isOpen, review, loadDocument, cleanupUrl]);

  const modalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(isOpen && !confirmAction, onClose, modalRef, {
    initialFocusSelector: "#manual-review-close-btn",
  });

  if (!isOpen || !review) return null;

  const doc = review.document;
  const isDecided = review.status === "approved" || review.status === "rejected";
  const confidenceScore = review.ocr_evidence?.confidence !== undefined
    ? Math.round(Number(review.ocr_evidence.confidence) * (Number(review.ocr_evidence.confidence) <= 1 ? 100 : 1))
    : null;

  const handleExecuteDecision = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    setActionError(null);

    try {
      if (confirmAction === "approve") {
        await onApprove(review.id, reviewerNote.trim() || undefined);
      } else {
        await onReject(review.id, reviewerNote.trim() || undefined);
      }
      setActionLoading(false);
      setConfirmAction(null);
      onClose();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to execute review decision.");
      setActionLoading(false);
      setConfirmAction(null);
    }
  };

  return (
    <div
      className="manual-review-backdrop"
      id="manual-review-detail-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-review-title"
    >
      <div ref={modalRef} className="manual-review-modal-card">
        {/* Modal Top Bar */}
        <div className="review-modal-header">
          <div className="review-modal-header-left">
            <span
              className={`reviews-kpi-badge ${review.status === "approved" ? "zero" : ""}`}
              style={{ fontSize: 11, padding: "3px 10px" }}
            >
              <span className="pulse-dot" />
              <span>
                {review.status === "approved"
                  ? "Approved • Verified"
                  : review.status === "rejected"
                  ? "Rejected • Resubmission"
                  : "Manual Review • In Inspection"}
              </span>
            </span>
            <h2 id="manual-review-title" className="review-modal-title">
              {doc.label || "Document Review"}
            </h2>
            <span className="reviews-code-chip">{review.customer_code}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onOpenSecureViewer && (
              <button
                type="button"
                className="btn-toolbar-tool"
                onClick={() => onOpenSecureViewer(doc.id, doc.label)}
                title="Open in full screen viewer"
                style={{ fontSize: 12 }}
              >
                <IconEye size={14} /> Full View
              </button>
            )}
            <button
              type="button"
              className="btn-icon-close"
              onClick={onClose}
              aria-label="Close review dialog"
              id="manual-review-close-btn"
            >
              <IconX size={20} />
            </button>
          </div>
        </div>

        {/* Master-Detail Split Layout */}
        <div className="review-split-layout">
          {/* Left Pane: Embedded Decrypted Viewer */}
          <div className="review-doc-pane">
            <div className="review-doc-toolbar">
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--adm-text-secondary)" }}>
                <IconShieldCheck size={14} color="var(--adm-success, #10b981)" />
                <span>AES-256-GCM Decrypted Stream</span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  className="btn-toolbar-tool"
                  onClick={() => setZoom((z) => Math.max(50, z - 25))}
                  title="Zoom Out"
                  aria-label="Zoom out document view"
                  id="review-zoom-out-btn"
                >
                  <IconZoomOut size={15} />
                </button>
                <span style={{ fontSize: 11, minWidth: 40, textAlign: "center", color: "var(--adm-text-muted)" }}>
                  {zoom}%
                </span>
                <button
                  type="button"
                  className="btn-toolbar-tool"
                  onClick={() => setZoom((z) => Math.min(250, z + 25))}
                  title="Zoom In"
                  aria-label="Zoom in document view"
                  id="review-zoom-in-btn"
                >
                  <IconZoomIn size={15} />
                </button>
                <button
                  type="button"
                  className="btn-toolbar-tool"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  title="Rotate 90°"
                  aria-label="Rotate document 90 degrees clockwise"
                  id="review-rotate-btn"
                >
                  <IconRotateCw size={15} />
                </button>
              </div>
            </div>

            <div className="review-doc-viewport" id="review-viewport">
              {loadingDoc && (
                <div style={{ textAlign: "center", color: "var(--adm-text-secondary)" }}>
                  <div className="processing-spinner" style={{ margin: "0 auto 12px", width: 28, height: 28 }} />
                  <p style={{ fontSize: 13 }}>Decrypting and loading document stream…</p>
                </div>
              )}

              {docError && !loadingDoc && (
                <div style={{ textAlign: "center", maxWidth: 360, padding: 20 }}>
                  <IconAlertTriangle size={32} color="var(--adm-danger, #ef4444)" style={{ margin: "0 auto 10px" }} />
                  <p style={{ color: "var(--adm-danger, #ef4444)", fontSize: 13, marginBottom: 12 }}>{docError}</p>
                  <button
                    type="button"
                    className="customer-access-btn"
                    onClick={() => loadDocument(doc.id)}
                    style={{ fontSize: 12, padding: "6px 14px", margin: "0 auto" }}
                  >
                    <IconRefreshCw size={13} /> Retry Decryption
                  </button>
                </div>
              )}

              {!loadingDoc && !docError && blobUrl && (
                mimeType.includes("pdf") ? (
                  <iframe
                    src={`${blobUrl}#toolbar=0&navpanes=0`}
                    title="Decrypted PDF Stream"
                    style={{
                      width: "100%",
                      height: "100%",
                      border: "none",
                      transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
                      transformOrigin: "center center",
                      transition: "transform 0.2s ease-out",
                    }}
                  />
                ) : (
                  <img
                    src={blobUrl}
                    alt={doc.label || "Customer Document"}
                    className="review-doc-img"
                    style={{
                      transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
                      transformOrigin: "center center",
                    }}
                  />
                )
              )}
            </div>
          </div>

          {/* Right Pane: Context, Evidence & Decision Dock */}
          <div className="review-evidence-pane">
            {actionError && (
              <div
                className="msg err"
                role="alert"
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--adm-danger, #ef4444)",
                  padding: "10px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {actionError}
              </div>
            )}

            {/* Customer & Case Summary */}
            <div className="review-section-box">
              <div className="review-section-title">
                <IconFileText size={15} color="var(--adm-primary, #3b82f6)" />
                <span>Customer &amp; Case Profile</span>
              </div>
              <div className="review-meta-grid">
                <div>
                  <div className="review-meta-item-label">Customer Name</div>
                  <div className="review-meta-item-value">{review.customer_name}</div>
                </div>
                <div>
                  <div className="review-meta-item-label">Case Identifier</div>
                  <div className="review-meta-item-value">
                    <Link
                      to={`/admin/customers/${review.customer_id}`}
                      style={{ color: "var(--adm-primary, #60a5fa)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <span>{review.customer_code}</span>
                      <IconArrowRight size={12} />
                    </Link>
                  </div>
                </div>
                <div>
                  <div className="review-meta-item-label">Document Slot</div>
                  <div className="review-meta-item-value">{doc.label} ({doc.doc_type})</div>
                </div>
                <div>
                  <div className="review-meta-item-label">Submitted Time</div>
                  <div className="review-meta-item-value">
                    {new Date(review.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* Review Trigger Reason & Active Risk Flags */}
            <div className="review-section-box" style={{ borderColor: "rgba(245, 158, 11, 0.3)" }}>
              <div className="review-section-title" style={{ color: "#fbbf24" }}>
                <IconAlertTriangle size={15} />
                <span>Trigger Reason &amp; Risk Flags</span>
              </div>

              <div
                style={{
                  background: "rgba(245, 158, 11, 0.08)",
                  border: "1px solid rgba(245, 158, 11, 0.25)",
                  borderRadius: 8,
                  padding: "10px 14px",
                  fontSize: 13,
                  color: "var(--adm-text)",
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}
              >
                <strong>Reason:</strong> {review.reason || "Confidence below auto-verification threshold"}
              </div>

              {review.flags && review.flags.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginBottom: 6, textTransform: "uppercase" }}>
                    Detected Risk Flags ({review.flags.length})
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {review.flags.map((flag, idx) => (
                      <span key={idx} className="review-flag-pill">
                        ⚠️ {flag.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {confidenceScore !== null && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: "var(--adm-text-muted)" }}>OCR Extraction Confidence</span>
                    <span style={{ fontWeight: 700, color: confidenceScore >= 80 ? "#10b981" : "#f59e0b" }}>
                      {confidenceScore}%
                    </span>
                  </div>
                  <div style={{ height: 6, background: "rgba(0,0,0,0.3)", borderRadius: 9999, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${confidenceScore}%`,
                        background: confidenceScore >= 80 ? "#10b981" : "#f59e0b",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Masked OCR Evidence (Privacy Protected) */}
            <div className="review-section-box" id="ocr-evidence-card">
              <div className="review-section-title">
                <IconShieldCheck size={15} color="var(--adm-success, #10b981)" />
                <span>Masked OCR Evidence (Privacy Protected)</span>
              </div>

              {review.ocr_evidence ? (
                <div>
                  {/* Redacted PII Chips */}
                  {review.ocr_evidence.pii_detected && review.ocr_evidence.pii_detected.length > 0 && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                      {review.ocr_evidence.pii_detected.map((p: string, idx: number) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: "rgba(16, 185, 129, 0.12)",
                            color: "#34d399",
                            border: "1px solid rgba(16, 185, 129, 0.25)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <IconLock size={10} />
                          <span>{p} Redacted</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Extracted Fields */}
                  {review.ocr_evidence.extracted_fields &&
                  Object.keys(review.ocr_evidence.extracted_fields).length > 0 ? (
                    <table className="ocr-evidence-table">
                      <tbody>
                        {Object.entries(review.ocr_evidence.extracted_fields).map(([k, v]) => (
                          <tr key={k}>
                            <td className="ocr-field-key">{k.replace(/_/g, " ")}</td>
                            <td className="ocr-field-val">{String(v ?? "—")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ fontSize: 12, color: "var(--adm-text-muted)", margin: 0 }}>
                      No extracted key-value fields available for this document slot.
                    </p>
                  )}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "var(--adm-text-muted)", margin: 0 }}>
                  No OCR evidence payload was recorded for this review item.
                </p>
              )}
            </div>

            {/* Decision Notes Input */}
            <div className="review-section-box">
              <label
                htmlFor="reviewer-note-input"
                style={{ display: "block", fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "var(--adm-text-muted)", marginBottom: 8 }}
              >
                Reviewer Decision Note (Optional)
              </label>
              <textarea
                id="reviewer-note-input"
                rows={3}
                placeholder="Document accepted after visual verification of signature and seal..."
                value={reviewerNote}
                onChange={(e) => setReviewerNote(e.target.value)}
                disabled={isDecided}
                style={{
                  width: "100%",
                  background: "var(--adm-card-elevated)",
                  border: "1px solid var(--adm-border)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  color: "var(--adm-text)",
                  fontSize: 13,
                  fontFamily: "inherit",
                  resize: "vertical",
                  outline: "none",
                }}
              />
            </div>
          </div>
        </div>

        {/* Modal Bottom Action Dock */}
        <div className="review-action-dock">
          <div style={{ fontSize: 12, color: "var(--adm-text-muted)" }}>
            🔒 Actions are permanently written to the immutable audit trail.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              className="consent-btn-decline"
              onClick={onClose}
              style={{ fontSize: 13, padding: "8px 16px" }}
              id="btn-review-modal-cancel"
            >
              Cancel
            </button>

            {!isDecided && (
              <>
                <button
                  type="button"
                  className="btn-decision-reject"
                  onClick={() => setConfirmAction("reject")}
                  id="btn-review-modal-reject"
                >
                  <IconAlertTriangle size={15} />
                  <span>Reject &amp; Request Resubmit</span>
                </button>

                <button
                  type="button"
                  className="btn-decision-approve"
                  onClick={() => setConfirmAction("approve")}
                  id="btn-review-modal-approve"
                >
                  <IconCheck size={16} />
                  <span>Approve Document</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Confirmation Dialog Overlay */}
        {confirmAction && (
          <div className="decision-confirm-dialog-backdrop">
            <div className="decision-confirm-dialog-card" id="review-confirm-dialog">
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: confirmAction === "approve" ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                  color: confirmAction === "approve" ? "#10b981" : "#f59e0b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 16px",
                }}
              >
                {confirmAction === "approve" ? <IconCheck size={28} /> : <IconAlertTriangle size={26} />}
              </div>

              <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px", color: "var(--adm-text)" }}>
                {confirmAction === "approve" ? "Confirm Document Approval" : "Confirm Rejection & Resubmission"}
              </h3>

              <p style={{ color: "var(--adm-text-secondary)", fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
                {confirmAction === "approve" ? (
                  <>
                    Are you sure you want to approve <strong>{doc.label}</strong> for <strong>{review.customer_name}</strong>? The document verification status will be updated to <strong>Verified</strong>.
                  </>
                ) : (
                  <>
                    Are you sure you want to reject <strong>{doc.label}</strong> for <strong>{review.customer_name}</strong>? The customer will be invited to resubmit a clear, valid copy through the portal.
                  </>
                )}
              </p>

              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button
                  type="button"
                  className="consent-btn-decline"
                  onClick={() => setConfirmAction(null)}
                  disabled={actionLoading}
                  style={{ fontSize: 13, padding: "8px 16px" }}
                  id="btn-confirm-dialog-cancel"
                >
                  Go Back
                </button>

                <button
                  type="button"
                  className={confirmAction === "approve" ? "btn-decision-approve" : "btn-decision-reject"}
                  onClick={handleExecuteDecision}
                  disabled={actionLoading}
                  id="confirm-decision-submit-btn"
                >
                  {actionLoading ? (
                    <>
                      <div className="processing-spinner" style={{ width: 14, height: 14 }} />
                      Recording Decision…
                    </>
                  ) : (
                    <>
                      {confirmAction === "approve" ? "Yes, Approve Document" : "Yes, Reject & Request Resubmit"}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
