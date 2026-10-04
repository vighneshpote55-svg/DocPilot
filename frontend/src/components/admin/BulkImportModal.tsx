import React, { useState, useRef, useEffect } from "react";
import { createAdminCustomer } from "../../api";
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
import {
  downloadSampleExcelTemplate,
  parseExcelBuffer,
  type ExcelParseResult,
} from "../../utils/excelImport";
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
  existingEmails = new Set(),
}) => {
  const [step, setStep] = useState<ImportStep>("upload");
  const [isDragOver, setIsDragOver] = useState(false);
  const [parseResult, setParseResult] = useState<ExcelParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Preview filtering
  const [previewFilter, setPreviewFilter] = useState<"all" | "valid" | "issues">("all");
  const [skipInvalid, setSkipInvalid] = useState(true);

  // Batch progress state
  const [progressIndex, setProgressIndex] = useState(0);
  const [totalToImport, setTotalToImport] = useState(0);
  const [currentImportName, setCurrentImportName] = useState("");
  const [successCount, setSuccessCount] = useState(0);
  const [failureCount, setFailureCount] = useState(0);
  const [failureDetails, setFailureDetails] = useState<Array<{ name: string; email: string; error: string }>>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when opened
  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      setStep("upload");
      setParseResult(null);
      setParseError(null);
      setPreviewFilter("all");
      setSkipInvalid(true);
      setProgressIndex(0);
      setTotalToImport(0);
      setSuccessCount(0);
      setFailureCount(0);
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

    try {
      const buffer = await file.arrayBuffer();
      const result = parseExcelBuffer(buffer, file.name, existingEmails);
      setParseResult(result);
      setStep("preview");
    } catch (err: unknown) {
      setParseError(
        err instanceof Error ? err.message : "Failed to parse the uploaded Excel file."
      );
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleProcessFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
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
    if (!parseResult) return;

    // Filter candidate rows
    const rowsToImport = parseResult.rows.filter((r) => {
      if (r.status === "valid" || r.status === "warning") {
        return true;
      }
      return !skipInvalid; // only if not skipping invalid
    });

    if (rowsToImport.length === 0) {
      alert("No valid rows available to import.");
      return;
    }

    setStep("importing");
    setTotalToImport(rowsToImport.length);
    setProgressIndex(0);
    setSuccessCount(0);
    setFailureCount(0);
    setFailureDetails([]);

    let ok = 0;
    let fail = 0;
    const failures: Array<{ name: string; email: string; error: string }> = [];

    for (let i = 0; i < rowsToImport.length; i++) {
      const row = rowsToImport[i];
      setProgressIndex(i + 1);
      setCurrentImportName(row.name);

      try {
        await createAdminCustomer({
          name: row.name,
          email: row.email,
          mobile: row.mobile || null,
          required_documents: row.requiredDocuments,
          send_consent: row.sendConsent,
        });
        ok++;
        setSuccessCount(ok);
      } catch (err: unknown) {
        fail++;
        setFailureCount(fail);
        failures.push({
          name: row.name,
          email: row.email,
          error: err instanceof Error ? err.message : "Failed to create",
        });
        setFailureDetails([...failures]);
      }
    }

    setStep("complete");
    onImportComplete(ok);
  };

  const filteredPreviewRows = (parseResult?.rows || []).filter((r) => {
    if (previewFilter === "valid") return r.status === "valid";
    if (previewFilter === "issues") return r.status === "warning" || r.status === "invalid";
    return true;
  });

  const importableCount =
    (parseResult?.validRows || 0) + (parseResult?.warningRows || 0);

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
              Import multiple customer KYC & business cases using standard Excel spreadsheets
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
                onClick={() => fileInputRef.current?.click()}
                id="excel-dropzone"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".xlsx, .xls"
                  style={{ display: "none" }}
                />
                <div className="dropzone-icon-circle">
                  <IconUploadCloud size={38} color="var(--adm-primary)" />
                </div>
                <h4 className="dropzone-title">Drag & drop your .xlsx workbook here</h4>
                <p className="dropzone-subtitle">or click to browse from your computer</p>
                <div className="dropzone-badge">
                  Supports Microsoft Excel (.xlsx, .xls) • Max 500 rows per batch
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
          {step === "preview" && parseResult && (
            <div className="bulk-preview-step">
              {/* Summary Stats Row */}
              <div className="preview-metrics-row">
                <div className="preview-metric-pill total">
                  <span className="preview-metric-val">{parseResult.totalRows}</span>
                  <span className="preview-metric-lbl">Total Rows</span>
                </div>
                <div className="preview-metric-pill valid">
                  <IconFileCheck size={16} color="var(--adm-success)" />
                  <span className="preview-metric-val">{parseResult.validRows}</span>
                  <span className="preview-metric-lbl">Ready to Import</span>
                </div>
                <div className="preview-metric-pill warning">
                  <IconFileWarning size={16} color="var(--adm-warn)" />
                  <span className="preview-metric-val">{parseResult.warningRows}</span>
                  <span className="preview-metric-lbl">Warnings / Duplicates</span>
                </div>
                <div className="preview-metric-pill invalid">
                  <IconAlertCircle size={16} color="var(--adm-danger)" />
                  <span className="preview-metric-val">{parseResult.invalidRows}</span>
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
                    All Rows ({parseResult.totalRows})
                  </button>
                  <button
                    type="button"
                    className={`preview-tab-btn ${previewFilter === "valid" ? "active" : ""}`}
                    onClick={() => setPreviewFilter("valid")}
                  >
                    Ready ({parseResult.validRows})
                  </button>
                  <button
                    type="button"
                    className={`preview-tab-btn ${previewFilter === "issues" ? "active" : ""}`}
                    onClick={() => setPreviewFilter("issues")}
                  >
                    Issues ({parseResult.warningRows + parseResult.invalidRows})
                  </button>
                </div>

                {parseResult.invalidRows > 0 && (
                  <label className="skip-invalid-toggle">
                    <input
                      type="checkbox"
                      checked={skipInvalid}
                      onChange={(e) => setSkipInvalid(e.target.checked)}
                    />
                    <span>Skip invalid rows automatically</span>
                  </label>
                )}
              </div>

              {/* Preview Table */}
              <div className="preview-table-container">
                <table className="preview-data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>Row</th>
                      <th style={{ width: 110 }}>Status</th>
                      <th>Customer Name</th>
                      <th>Email</th>
                      <th>Mobile</th>
                      <th>Required Docs</th>
                      <th>Validation Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPreviewRows.map((row) => (
                      <tr key={row.id} className={`preview-row-${row.status}`}>
                        <td className="row-num">{row.rowNumber}</td>
                        <td>
                          <span className={`status-badge ${row.status}`}>
                            {row.status === "valid" && <IconCheck size={12} />}
                            {row.status === "warning" && <IconAlertTriangle size={12} />}
                            {row.status === "invalid" && <IconAlertCircle size={12} />}
                            {row.status.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <b>{row.name || <span className="mut">(Empty)</span>}</b>
                        </td>
                        <td>
                          <span className="email-cell">
                            {row.email || <span className="mut">(Empty)</span>}
                          </span>
                        </td>
                        <td>
                          <span className="mut">{row.mobile || "—"}</span>
                        </td>
                        <td>
                          <div className="doc-pill-wrap">
                            {row.requiredDocuments.map((d) => (
                              <span key={d} className="doc-tag-sm">
                                {d}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          {row.issues.length > 0 ? (
                            <ul className="row-issues-list">
                              {row.issues.map((issue, idx) => (
                                <li key={idx}>{issue}</li>
                              ))}
                            </ul>
                          ) : (
                            <span className="row-issue-ok">Passed all checks</span>
                          )}
                        </td>
                      </tr>
                    ))}
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
                <h3 className="import-progress-title">Importing Customers…</h3>
                <p className="import-progress-subtitle">
                  Processing <b>{currentImportName}</b> ({progressIndex} of {totalToImport})
                </p>
              </div>

              {/* Progress Bar */}
              <div className="import-progress-bar-container">
                <div
                  className="import-progress-bar-fill"
                  style={{
                    width: `${Math.round((progressIndex / Math.max(1, totalToImport)) * 100)}%`,
                  }}
                />
              </div>

              <div className="import-progress-footer">
                <span className="mut">
                  {Math.round((progressIndex / Math.max(1, totalToImport)) * 100)}% Complete
                </span>
                <span className="import-counter-stat">
                  <span style={{ color: "var(--adm-success)" }}>{successCount} created</span>
                  {failureCount > 0 && (
                    <span style={{ color: "var(--adm-danger)", marginLeft: 12 }}>
                      {failureCount} failed
                    </span>
                  )}
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
                Finished processing the customer batch from <b>{parseResult?.fileName}</b>.
              </p>

              <div className="complete-stats-card">
                <div className="complete-stat-item">
                  <span className="stat-number ok">{successCount}</span>
                  <span className="stat-label">Successfully Created</span>
                </div>
                <div className="complete-stat-item">
                  <span className="stat-number err">{failureCount}</span>
                  <span className="stat-label">Failed Requests</span>
                </div>
                <div className="complete-stat-item">
                  <span className="stat-number mut">
                    {skipInvalid ? parseResult?.invalidRows || 0 : 0}
                  </span>
                  <span className="stat-label">Skipped Invalid</span>
                </div>
              </div>

              {failureDetails.length > 0 && (
                <div className="complete-failures-box">
                  <h4 className="failures-title">Failures Breakdown:</h4>
                  <ul className="failures-list">
                    {failureDetails.map((f, i) => (
                      <li key={i}>
                        <b>{f.name}</b> ({f.email}): {f.error}
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
            <button type="button" className="sec" onClick={onClose}>
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
                  setParseResult(null);
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
