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

  const handleSecureView = async (docId: string) => {
    try {
      const blob = await fetchDocumentFile(docId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to open document file.");
    }
  };

  if (loading) {
    return (
      <div className="narrow card">
        <p className="mut">Loading customer details…</p>
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
              {customer.email} {customer.mobile ? `· ${customer.mobile}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className={`tag ${customer.consent_status}`}>{customer.consent_status}</span>
            <span className={`tag ${customer.case_status}`}>{customer.case_status}</span>
          </div>
        </div>

        <div style={{ margin: "14px 0", fontSize: 13 }} className="mut">
          Created: {new Date(customer.created_at).toLocaleString()}
          {customer.delete_after && ` · Retention deletion scheduled: ${new Date(customer.delete_after).toLocaleString()}`}
          {customer.data_deleted_at && ` · Data permanently deleted: ${new Date(customer.data_deleted_at).toLocaleString()}`}
        </div>

        <p>
          <b>Verification progress:</b> {customer.received_count} of {customer.required_count} documents verified
        </p>

        {customer.required && customer.required.length > 0 && (
          <div style={{ margin: "10px 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 13, fontWeight: 600 }}>Required checklist:</span>
            {customer.required.map((r) => (
              <span key={r.doc_type} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--card-subtle)", padding: "2px 8px", borderRadius: 6, fontSize: 12 }}>
                <span>{r.label}:</span>
                <span className={`tag ${r.state}`} style={{ fontSize: 11, padding: "1px 6px" }}>{r.state}</span>
              </span>
            ))}
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

      <h2>Documents</h2>
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
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className="sec"
                          style={{ padding: "4px 10px", fontSize: 13 }}
                          onClick={() => handleSecureView(d.id)}
                        >
                          Secure view
                        </button>
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
    </div>
  );
};
