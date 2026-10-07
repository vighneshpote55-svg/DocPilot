import React, { useState, useRef, useEffect } from "react";
import { previewCustomerImport, executeCustomerImport } from "../../api";
import type { ImportPreviewResponse, ImportBatchResponse, ImportRowResult } from "../../types";
import {
  IconX,
  IconFileSpreadsheet,
  IconUploadCloud,
  IconCheck,
  IconAlertTriangle,
  IconAlertCircle,
  IconRefreshCw,
  IconDownload,
  IconFileCheck,
  IconFileWarning,
} from "./AdminIcons";
import { downloadSampleExcelTemplate } from "../../utils/excelImport";
import { useDialogA11y } from "../../utils/a11yUtils";

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: (count: number) => void;
  existingEmails?: Set<string>;
}

type ImportStep = "upload" | "preview" | "importing" | "complete";

export const BulkImportModal: React.FC<BulkImportModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  existingEmails: _existingEmails,
}) => {
  const [step, setStep] = useState<ImportStep>("upload");
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewResult, setPreviewResult] = useState<ImportPreviewResponse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Preview filtering
  const [previewFilter, setPreviewFilter] = useState<"all" | "valid" | "issues">("all");

  // Batch import result state
  const [successCount, setSuccessCount] = useState(0);
  const [failureCount, setFailureCount] = useState(0);
  const [emailSentCount, setEmailSentCount] = useState(0);
  const [failureDetails, setFailureDetails] = useState<Array<{ name: string; email: string; error: string }>>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when opened
  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setStep("upload");
      setSelectedFile(null);
      setPreviewResult(null);
      setParseError(null);
      setIsAnalyzing(false);
      setPreviewFilter("all");
      setSuccessCount(0);
      setFailureCount(0);
      setEmailSentCount(0);
      setFailureDetails([]);
    });
  }, [isOpen]);

  const modalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(isOpen && step !== "importing", onClose, modalRef, {
    initialFocusSelector: ".modal-close-btn",
  });

  if (!isOpen) return null;

  const handleProcessFile = async (file: File) => {
    setParseError(null);
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setParseError("Please select a valid Excel file (.xlsx or .xls).");
      return;
    }

    setIsAnalyzing(true);
    try {
      const res = await previewCustomerImport(file);
      setSelectedFile(file);
      setPreviewResult(res);
      setStep("preview");
    } catch (err: unknown) {
      setParseError(
        err instanceof Error ? err.message : "Failed to analyze the uploaded Excel file."
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isAnalyzing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleProcessFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isAnalyzing) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleProcessFile(file);
    }
  };

  const handleStartImport = async () => {
    if (!selectedFile || !previewResult) return;

    if (previewResult.valid_rows === 0) {
      alert("No valid rows available to import.");
      return;
    }

    setStep("importing");
    setParseError(null);

    try {
      const res: ImportBatchResponse = await executeCustomerImport(selectedFile);
      setSuccessCount(res.imported);
      setFailureCount(res.rejected + res.duplicates + res.failed);
      setEmailSentCount(res.email_sent);

      const failures: Array<{ name: string; email: string; error: string }> = [];
      for (const row of res.rows) {
        if (row.status !== "valid") {
          failures.push({
            name: row.name || `Row ${row.row}`,
            email: row.email || "—",
            error: row.errors.map((e) => e.message).join("; ") || row.status,
          });
        }
      }
      for (const ef of res.email_failures) {
        failures.push({
          name: `Customer ID ${ef.customer_id}`,
          email: `Row ${ef.row}`,
          error: `Consent email dispatch failed (${ef.code})`,
        });
      }
      setFailureDetails(failures);
      setStep("complete");
      onImportComplete(res.imported);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Batch import failed.";
      setParseError(msg);
      setFailureCount(previewResult.valid_rows);
      setFailureDetails([
        {
          name: "Batch Import Error",
          email: selectedFile.name,
          error: msg,
        },
      ]);
      setStep("complete");
    }
  };

  const filteredPreviewRows = (previewResult?.rows || []).filter((r: ImportRowResult) => {
    if (previewFilter === "valid") return r.status === "valid";
    if (previewFilter === "issues") return r.status !== "valid";
    return true;
  });

  const importableCount = previewResult?.valid_rows || 0;

  return (
    <div
      className="modal-backdrop"
      onClick={step === "importing" ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-import-modal-title"
    >
      <div
        ref={modalRef}
        className="modal-box modal-xl"
        id="bulk-import-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-icon">
            <IconFileSpreadsheet size={22} color="var(--adm-primary)" />
          </div>
          <div className="modal-header-text">
            <h2 id="bulk-import-modal-title" className="modal-title">
              Bulk Customer Intake (.xlsx)
            </h2>
            <p className="modal-subtitle">
              Import multiple customer KYC & business cases via atomic backend batch validation
            </p>
          </div>
          {step !== "importing" && (
            <button
              type="button"
              className="modal-close-btn"
              onClick={onClose}
              aria-label="Close modal"
            >
              <IconX size={18} />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="modal-body">
          {/* STEP 1: UPLOAD */}
          {step === "upload" && (
            <div className="bulk-upload-step">
              {parseError && (
                <div className="msg err" role="alert" style={{ marginBottom: 16 }}>
                  <IconAlertCircle size={16} />
                  <span>{parseError}</span>
                </div>
              )}

              {/* Template Download Banner */}
              <div className="template-download-card">
                <div className="template-card-info">
                  <div className="template-icon-wrap">
                    <IconFileSpreadsheet size={24} color="var(--adm-success)" />
                  </div>
                  <div>
                    <h3 className="template-card-title">Need the DocPilot intake format?</h3>
                    <p className="template-card-desc">
                      Download our pre-formatted sample Excel workbook with headers, demo data,
                      and a reference sheet for all 22 supported document types.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="sec template-download-btn"
                  onClick={downloadSampleExcelTemplate}
                  id="btn-download-sample-template"
                >
                  <IconDownload size={15} /> Download Sample Template (.xlsx)
                </button>
              </div>

              {/* Drag and Drop Zone */}
              <div
                className={`dropzone-box ${isDragOver ? "drag-active" : ""}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => !isAnalyzing && fileInputRef.current?.click()}
                id="excel-dropzone"
                style={{ opacity: isAnalyzing ? 0.7 : 1, pointerEvents: isAnalyzing ? "none" : "auto" }}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".xlsx, .xls"
                  style={{ display: "none" }}
                  disabled={isAnalyzing}
                />
                <div className="dropzone-icon-circle">
                  {isAnalyzing ? (
                    <span className="spinner-lg" />
                  ) : (
                    <IconUploadCloud size={38} color="var(--adm-primary)" />
                  )}
                </div>
                <h4 className="dropzone-title">
                  {isAnalyzing
                    ? "Validating workbook with DocPilot server…"
                    : "Drag & drop your .xlsx workbook here"}
                </h4>
                <p className="dropzone-subtitle">
                  {isAnalyzing
                    ? "Executing schema validation, duplicate detection, and integrity checks"
                    : "or click to browse from your computer"}
                </p>
                <div className="dropzone-badge">
                  Supports Microsoft Excel (.xlsx) • Up to 1,000 rows per atomic batch
                </div>
              </div>

              {/* Format Guide Checklist */}
              <div className="intake-format-guide">
                <div className="format-guide-header">
                  <IconCheck size={16} color="var(--adm-primary)" />
                  <span>Expected Columns:</span>
                </div>
                <div className="format-tags-list">
                  <span className="format-col-tag required">Full Name *</span>
                  <span className="format-col-tag required">Email Address *</span>
                  <span className="format-col-tag optional">Mobile Number</span>
                  <span className="format-col-tag required">Required Documents (e.g. pan, aadhaar)</span>
                  <span className="format-col-tag optional">Send Consent Email (Yes/No)</span>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: PREVIEW & VALIDATION */}
          {step === "preview" && previewResult && (
            <div className="bulk-preview-step">
              {parseError && (
                <div className="msg err" role="alert" style={{ marginBottom: 16 }}>
                  <IconAlertCircle size={16} />
                  <span>{parseError}</span>
                </div>
              )}

              {/* Summary Stats Row */}
              <div className="preview-metrics-row">
                <div className="preview-metric-pill total">
                  <span className="preview-metric-val">{previewResult.total_rows}</span>
                  <span className="preview-metric-lbl">Total Rows</span>
                </div>
                <div className="preview-metric-pill valid">
                  <IconFileCheck size={16} color="var(--adm-success)" />
                  <span className="preview-metric-val">{previewResult.valid_rows}</span>
                  <span className="preview-metric-lbl">Ready to Import</span>
                </div>
                <div className="preview-metric-pill warning">
                  <IconFileWarning size={16} color="var(--adm-warn)" />
                  <span className="preview-metric-val">{previewResult.duplicate_rows}</span>
                  <span className="preview-metric-lbl">Duplicates</span>
                </div>
                <div className="preview-metric-pill invalid">
                  <IconAlertCircle size={16} color="var(--adm-danger)" />
                  <span className="preview-metric-val">{previewResult.invalid_rows}</span>
                  <span className="preview-metric-lbl">Invalid Rows</span>
                </div>
              </div>

              {/* Filter Tabs & Options Bar */}
              <div className="preview-controls-bar">
                <div className="preview-filter-tabs">
                  <button
                    type="button"
                    className={`preview-tab-btn ${previewFilter === "all" ? "active" : ""}`}
                    onClick={() => setPreviewFilter("all")}
                  >
                    All Rows ({previewResult.total_rows})
                  </button>
                  <button
                    type="button"
                    className={`preview-tab-btn ${previewFilter === "valid" ? "active" : ""}`}
                    onClick={() => setPreviewFilter("valid")}
                  >
                    Ready ({previewResult.valid_rows})
                  </button>
                  <button
                    type="button"
                    className={`preview-tab-btn ${previewFilter === "issues" ? "active" : ""}`}
                    onClick={() => setPreviewFilter("issues")}
                  >
                    Issues ({previewResult.duplicate_rows + previewResult.invalid_rows})
                  </button>
                </div>

                {previewResult.document_types_detected.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }} className="mut">
                    <span>Types detected:</span>
                    {previewResult.document_types_detected.map((t) => (
                      <span key={t} className="doc-tag-sm">{t}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Preview Table */}
              <div className="preview-table-container">
                <table className="preview-data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>Row</th>
                      <th style={{ width: 130 }}>Status</th>
                      <th>Customer Name</th>
                      <th>Email</th>
                      <th>Mobile</th>
                      <th>Required Docs</th>
                      <th>Validation Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPreviewRows.map((row) => {
                      const isDup = row.status === "duplicate_customer" || row.status === "duplicate_excel_row";
                      const statusClass = row.status === "valid" ? "valid" : (isDup ? "warning" : "invalid");
                      const statusLabel = row.status === "valid"
                        ? "VALID"
                        : (row.status === "duplicate_customer"
                            ? "DUPLICATE"
                            : (row.status === "duplicate_excel_row" ? "IN-FILE DUP" : "INVALID"));

                      return (
                        <tr key={row.row} className={`preview-row-${statusClass}`}>
                          <td className="row-num">{row.row}</td>
                          <td>
                            <span className={`status-badge ${statusClass}`}>
                              {row.status === "valid" && <IconCheck size={12} />}
                              {isDup && <IconAlertTriangle size={12} />}
                              {row.status === "invalid" && <IconAlertCircle size={12} />}
                              {statusLabel}
                            </span>
                          </td>
                          <td>
                            <b>{row.name || <span className="mut">(Empty / Invalid)</span>}</b>
                          </td>
                          <td>
                            <span className="email-cell">
                              {row.email || <span className="mut">(Empty / Invalid)</span>}
                            </span>
                          </td>
                          <td>
                            <span className="mut">{row.mobile || "—"}</span>
                          </td>
                          <td>
                            <div className="doc-pill-wrap">
                              {row.required_documents.map((d) => (
                                <span key={d} className="doc-tag-sm">
                                  {d}
                                </span>
                              ))}
                              {row.required_documents.length === 0 && (
                                <span className="mut" style={{ fontSize: 12 }}>—</span>
                              )}
                            </div>
                          </td>
                          <td>
                            {row.errors.length > 0 ? (
                              <ul className="row-issues-list">
                                {row.errors.map((issue, idx) => (
                                  <li key={idx}>{issue.message}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="row-issue-ok">Passed all server checks</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* STEP 3: IMPORTING PROGRESS */}
          {step === "importing" && (
            <div className="bulk-importing-step">
              <div className="import-progress-header">
                <div className="import-spinner-wrap">
                  <span className="spinner-lg" />
                </div>
                <h3 className="import-progress-title">Executing Batch Import…</h3>
                <p className="import-progress-subtitle">
                  Performing atomic PostgreSQL transaction for <b>{selectedFile?.name}</b> ({previewResult?.valid_rows} customer{previewResult?.valid_rows === 1 ? "" : "s"})
                </p>
              </div>

              {/* Indeterminate Animated Progress Bar */}
              <div className="import-progress-bar-container">
                <div
                  className="import-progress-bar-fill"
                  style={{
                    width: "100%",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>

              <div className="import-progress-footer">
                <span className="mut">
                  Single atomic transaction — safe against partial import failures
                </span>
                <span className="import-counter-stat">
                  <span style={{ color: "var(--adm-primary)" }}>{previewResult?.valid_rows} rows queued</span>
                </span>
              </div>
            </div>
          )}

          {/* STEP 4: COMPLETED SUMMARY */}
          {step === "complete" && (
            <div className="bulk-complete-step">
              <div className="complete-icon-wrap">
                <IconCheck size={42} color="var(--adm-success)" />
              </div>
              <h3 className="complete-title">Bulk Intake Completed!</h3>
              <p className="complete-desc">
                Finished processing the customer batch from <b>{selectedFile?.name}</b>.
              </p>

              <div className="complete-stats-card">
                <div className="complete-stat-item">
                  <span className="stat-number ok">{successCount}</span>
                  <span className="stat-label">Successfully Created</span>
                </div>
                <div className="complete-stat-item">
                  <span className="stat-number err">{failureCount}</span>
                  <span className="stat-label">Skipped / Issues</span>
                </div>
                <div className="complete-stat-item">
                  <span className="stat-number mut">{emailSentCount}</span>
                  <span className="stat-label">Consent Emails Sent</span>
                </div>
              </div>

              {failureDetails.length > 0 && (
                <div className="complete-failures-box">
                  <h4 className="failures-title">Items Breakdown / Rejections:</h4>
                  <ul className="failures-list">
                    {failureDetails.map((f, i) => (
                      <li key={i}>
                        <b>{f.name}</b> {f.email !== "—" ? `(${f.email})` : ""}: {f.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="modal-footer">
          {step === "upload" && (
            <button type="button" className="sec" onClick={onClose} disabled={isAnalyzing}>
              Cancel
            </button>
          )}

          {step === "preview" && (
            <>
              <button
                type="button"
                className="sec"
                onClick={() => {
                  setStep("upload");
                  setSelectedFile(null);
                  setPreviewResult(null);
                }}
              >
                <IconRefreshCw size={14} /> Re-upload File
              </button>
              <button
                type="button"
                className="ok"
                disabled={importableCount === 0}
                onClick={handleStartImport}
                id="btn-confirm-import-excel"
              >
                <IconFileSpreadsheet size={16} /> Import {importableCount} Customers
              </button>
            </>
          )}

          {step === "complete" && (
            <button
              type="button"
              className="ok"
              onClick={onClose}
              id="btn-close-import-summary"
              style={{ width: "100%", justifyContent: "center" }}
            >
              Done & Refresh Customer Directory
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
