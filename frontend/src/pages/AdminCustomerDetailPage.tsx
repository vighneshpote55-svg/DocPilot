import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  closeAdminCase,
  deleteAdminCustomerData,
  deleteAdminDocumentFile,
  fetchDocumentFile,
  getAdminCustomer,
  resendConsentEmail,
  resendUploadLink,
} from "../api";
import type { AdminCustomerDetail } from "../types";

export const AdminCustomerDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<AdminCustomerDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyAction, setBusyAction] = useState<boolean>(false);

  // Secure View modal & URL cleanup state
  const [activeViewUrl, setActiveViewUrl] = useState<string | null>(null);
  const [viewingDocTitle, setViewingDocTitle] = useState<string>("Document Preview");

  const loadCustomer = useCallback(() => {
    if (!id) return;
    getAdminCustomer(Number(id))
      .then((data) => {
        setCustomer(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    loadCustomer();
  }, [loadCustomer]);

  // Clean up object URL when activeViewUrl changes or component unmounts
  useEffect(() => {
    return () => {
      if (activeViewUrl) {
        URL.revokeObjectURL(activeViewUrl);
      }
    };
  }, [activeViewUrl]);

  const handleAction = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusyAction(true);
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ text: successMsg, ok: true });
      setBusyAction(false);
      loadCustomer();
    } catch (err: unknown) {
      setActionMsg({
        text: err instanceof Error ? err.message : "Action failed.",
        ok: false,
      });
      setBusyAction(false);
    }
  };

  const closePreview = () => {
    if (activeViewUrl) {
      URL.revokeObjectURL(activeViewUrl);
      setActiveViewUrl(null);
    }
  };

  const handleSecureView = async (docId: string, title?: string) => {
    try {
      if (activeViewUrl) {
        URL.revokeObjectURL(activeViewUrl);
      }
      const blob = await fetchDocumentFile(docId, false);
      const url = URL.createObjectURL(blob);
      setActiveViewUrl(url);
      setViewingDocTitle(title || "Document Preview");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to open document file.");
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
      alert(err instanceof Error ? err.message : "Failed to download document file.");
    }
  };

  if (loading) {
    return (
      <div className="narrow card">
        <p className="mut">Loading customer details...</p>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="narrow card">
        <div className="msg err">{error || "Customer not found."}</div>
        <Link to="/admin" className="btn sec">
          ← Back to cases
        </Link>
      </div>
    );
  }

  return (
    <div id="customer-detail-page">
      <Link to="/admin" className="btn sec" style={{ marginBottom: 16 }}>
        ← Back to cases
      </Link>

      <div className="card">
        <div className="row">
          <div>
            <h2 style={{ margin: 0 }}>
              {customer.name} <span className="mut">({customer.code})</span>
            </h2>
            <div className="mut" style={{ marginTop: 4 }}>
              {customer.email} {customer.mobile ? `• ${customer.mobile}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className={`tag ${customer.consent_status}`}>{customer.consent_status}</span>
            <span className={`tag ${customer.case_status}`}>{customer.case_status}</span>
          </div>
        </div>

        <div style={{ margin: "14px 0", fontSize: 13 }} className="mut">
          Created: {new Date(customer.created_at).toLocaleString()}
          {customer.delete_after && ` • Retention deletion scheduled: ${new Date(customer.delete_after).toLocaleString()}`}
          {customer.data_deleted_at && ` • Data permanently deleted: ${new Date(customer.data_deleted_at).toLocaleString()}`}
        </div>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", margin: "16px 0 12px" }}>
          <div className="card" style={{ background: "var(--card-subtle)", padding: 12 }}>
            <div className="stat" style={{ fontSize: 20 }}>{customer.required_count}</div>
            <div className="mut" style={{ fontSize: 12 }}>Required docs</div>
          </div>
          <div className="card" style={{ background: "var(--card-subtle)", padding: 12 }}>
            <div className="stat" style={{ fontSize: 20, color: "var(--good, #2ecc71)" }}>{customer.received_count}</div>
            <div className="mut" style={{ fontSize: 12 }}>Received & verified</div>
          </div>
          <div className="card" style={{ background: "var(--card-subtle)", padding: 12 }}>
            <div className="stat" style={{ fontSize: 20, color: customer.pending_count > 0 ? "var(--warn, #e67e22)" : "inherit" }}>{customer.pending_count}</div>
            <div className="mut" style={{ fontSize: 12 }}>Pending docs</div>
          </div>
          <div className="card" style={{ background: "var(--card-subtle)", padding: 12 }}>
            <div className="stat" style={{ fontSize: 15 }}>
              <span className={`tag ${customer.case_status}`} style={{ margin: 0 }}>
                {customer.case_status === "completed" ? "Completed" : "In progress"}
              </span>
            </div>
            <div className="mut" style={{ fontSize: 12 }}>Completion state</div>
          </div>
        </div>

        {customer.case_status === "completed" && (
          <div className="msg ok" role="status" style={{ margin: "12px 0" }}>
            <b>Case completed!</b> All {customer.required_count} required documents have been successfully verified.
          </div>
        )}

        <p>
          <b>Verification progress:</b> {customer.received_count} of {customer.required_count} documents verified
        </p>

        {customer.required && customer.required.length > 0 && (
          <div style={{ margin: "10px 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 13, fontWeight: 600 }}>Required checklist:</span>
            {customer.required.map((r) => {
              const labelMap: Record<string, string> = {
                resubmit: "Please upload again",
                received: "Received and verified",
                verified: "Received and verified",
                waiting: "Waiting for upload",
                processing: "Checking validity",
              };
              const displayState = labelMap[r.state] || r.state;
              return (
                <span key={r.doc_type} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--card-subtle)", padding: "2px 8px", borderRadius: 6, fontSize: 12 }}>
                  <span>{r.label}:</span>
                  <span className={`tag ${r.state}`} style={{ fontSize: 11, padding: "1px 6px" }}>{displayState}</span>
                </span>
              );
            })}
          </div>
        )}

        {actionMsg && (
          <div className={`msg ${actionMsg.ok ? "ok" : "err"}`} role="status">
            {actionMsg.text}
          </div>
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-start" }}>
          {customer.consent_status === "pending" && (
            <button
              className="sec"
              disabled={busyAction}
              onClick={() => handleAction(() => resendConsentEmail(customer.id), "Consent email resent successfully.")}
            >
              Resend consent email
            </button>
          )}

          {customer.case_status === "in_progress" && customer.consent_status === "granted" && (
            <button
              className="sec"
              disabled={busyAction}
              onClick={() => handleAction(() => resendUploadLink(customer.id), "Upload link email resent successfully.")}
            >
              Resend upload link
            </button>
          )}

          {customer.case_status === "in_progress" && (
            <button
              className="sec"
              disabled={busyAction}
              onClick={() => {
                const reason = prompt("Optional reason for closing this case:") || undefined;
                handleAction(() => closeAdminCase(customer.id, reason), "Case closed by admin.");
              }}
            >
              Close case
            </button>
          )}

          {customer.case_status !== "deleted" && (
            <button
              className="no"
              disabled={busyAction}
              onClick={() => {
                if (confirm("Are you sure you want to permanently delete all files and data for this customer?")) {
                  handleAction(() => deleteAdminCustomerData(customer.id), "Customer data and files deleted.");
                }
              }}
            >
              Delete customer data
            </button>
          )}
        </div>
      </div>

      <h3>Documents</h3>
      <div className="card wrap" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Uploaded</th>
              <th>OCR Status</th>
              <th>Verification</th>
              <th>Reason</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customer.documents.length === 0 ? (
              <tr>
                <td colSpan={6} className="mut" style={{ padding: 20 }}>
                  No document files uploaded yet.
                </td>
              </tr>
            ) : (
              customer.documents.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.label}</b>
                    <div className="mut" style={{ fontSize: 13 }}>
                      {d.filename}
                    </div>
                    {d.superseded && <span className="tag" style={{ marginTop: 4 }}>Superseded</span>}
                  </td>
                  <td className="mut" style={{ fontSize: 13 }}>
                    {new Date(d.uploaded_at).toLocaleString()}
                  </td>
                  <td>
                    <span className={`tag ${d.ocr_status}`}>{d.ocr_status}</span>
                  </td>
                  <td>
                    <span className={`tag ${d.verification_status}`}>{d.verification_status}</span>
                  </td>
                  <td className="mut" style={{ fontSize: 13 }}>
                    {d.review_reason || "—"}
                  </td>
                  <td>
                    {d.file_state === "stored" ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          className="sec"
                          style={{ padding: "4px 10px", fontSize: 13 }}
                          onClick={() => handleSecureView(d.id, `${d.label} - ${d.filename}`)}
                        >
                          Secure view
                        </button>
                        {(customer.allow_download || import.meta.env.VITE_ALLOW_DOWNLOAD === "true") && (
                          <button
                            className="sec"
                            style={{ padding: "4px 10px", fontSize: 13 }}
                            onClick={() => handleDownload(d.id, d.filename)}
                          >
                            Download
                          </button>
                        )}
                        <button
                          className="sec"
                          style={{ padding: "4px 8px", fontSize: 13, color: "var(--bad)" }}
                          onClick={() => {
                            if (confirm("Mark this document file as deleted?")) {
                              handleAction(() => deleteAdminDocumentFile(d.id), "File deleted.");
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <span className="tag deleted">Deleted</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Secure Document Viewer Modal */}
      {activeViewUrl && (
        <div
          className="modal-backdrop"
          onClick={closePreview}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 900,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              padding: 20,
              background: "var(--card-bg, #fff)",
              borderRadius: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            }}
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>{viewingDocTitle}</h3>
              <button
                type="button"
                className="sec"
                onClick={closePreview}
              >
                Close preview
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 450, overflow: "hidden", display: "flex" }}>
              <iframe
                src={activeViewUrl}
                title="Secure Document Preview"
                style={{ width: "100%", height: "100%", border: "none", borderRadius: 4 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminCustomerDetailPage;
