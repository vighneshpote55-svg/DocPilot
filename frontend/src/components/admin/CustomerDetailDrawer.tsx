import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  getAdminCustomer,
  resendConsentEmail,
  resendUploadLink,
  closeAdminCase,
} from "../../api";
import type { AdminCustomerDetail } from "../../types";
import {
  IconX,
  IconShield,
  IconCheck,
  IconClock,
  IconAlertCircle,
  IconEye,
  IconMail,
  IconPhone,
  IconCopy,
  IconExternalLink,
  IconFileText,
} from "./AdminIcons";

interface CustomerDetailDrawerProps {
  customerId: number | null;
  isOpen: boolean;
  onClose: () => void;
  onSecureView: (docId: string, title?: string) => void;
  onCustomerUpdated?: () => void;
}

export const CustomerDetailDrawer: React.FC<CustomerDetailDrawerProps> = ({
  customerId,
  isOpen,
  onClose,
  onSecureView,
  onCustomerUpdated,
}) => {
  const [customer, setCustomer] = useState<AdminCustomerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    if (!isOpen || customerId === null) {
      queueMicrotask(() => setCustomer(null));
      return;
    }

    let ignore = false;
    queueMicrotask(() => {
      if (ignore) return;
      setLoading(true);
      setError(null);
      setActionMsg(null);
    });

    getAdminCustomer(customerId)
      .then((data) => {
        if (!ignore) {
          setCustomer(data);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!ignore) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [isOpen, customerId]);

  // Handle ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !busyAction) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, busyAction, onClose]);

  if (!isOpen) return null;

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleAction = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusyAction(true);
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ text: successMsg, ok: true });
      setBusyAction(false);
      if (customerId !== null) {
        const refreshed = await getAdminCustomer(customerId);
        setCustomer(refreshed);
      }
      onCustomerUpdated?.();
    } catch (err: unknown) {
      setActionMsg({
        text: err instanceof Error ? err.message : "Action failed.",
        ok: false,
      });
      setBusyAction(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="drawer-panel"
        id="customer-detail-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(640px, 100vw)" }}
      >
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="drawer-title-group">
            <div className="drawer-icon-box">
              <IconFileText size={22} color="var(--adm-primary)" />
            </div>
            <div>
              <h2 className="drawer-title">
                {customer?.name || (loading ? "Loading customer…" : "Customer Details")}
              </h2>
              {customer && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    className="drawer-code-chip"
                    onClick={() => handleCopyCode(customer.code)}
                    title="Click to copy case code"
                  >
                    <span>{customer.code}</span>
                    <IconCopy size={12} />
                  </button>
                  {copiedCode && <span className="copy-notif">Copied!</span>}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="drawer-body">
          {actionMsg && (
            <div
              className={`msg ${actionMsg.ok ? "ok" : "err"}`}
              role="alert"
              style={{ marginBottom: 14 }}
            >
              {actionMsg.text}
            </div>
          )}

          {loading && (
            <div className="drawer-loading-state">
              <span className="spinner-lg" />
              <p className="mut" style={{ marginTop: 12 }}>
                Fetching customer verification profile…
              </p>
            </div>
          )}

          {error && (
            <div className="msg err" role="alert">
              <IconAlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {!loading && customer && (
            <div className="customer-drawer-content">
              {/* Badges Bar */}
              <div className="drawer-status-badges">
                <span className={`tag ${customer.case_status}`}>
                  Case: {customer.case_status}
                </span>
                <span className={`tag ${customer.consent_status}`}>
                  Consent: {customer.consent_status}
                </span>
                {customer.data_deleted_at && (
                  <span className="tag deleted">Files Purged</span>
                )}
              </div>

              {/* Contact Information Card */}
              <div className="drawer-section-card">
                <h4 className="drawer-section-title">Customer Contact</h4>
                <div className="drawer-info-grid">
                  <div className="drawer-info-item">
                    <span className="info-item-label">
                      <IconMail size={13} /> Email Address
                    </span>
                    <span className="info-item-value">{customer.email}</span>
                  </div>
                  <div className="drawer-info-item">
                    <span className="info-item-label">
                      <IconPhone size={13} /> Mobile Number
                    </span>
                    <span className="info-item-value">{customer.mobile || "Not specified"}</span>
                  </div>
                  <div className="drawer-info-item">
                    <span className="info-item-label">
                      <IconClock size={13} /> Created At
                    </span>
                    <span className="info-item-value">
                      {new Date(customer.created_at).toLocaleString()}
                    </span>
                  </div>
                  {customer.delete_after && (
                    <div className="drawer-info-item">
                      <span className="info-item-label">
                        <IconShield size={13} /> Retention Deletion
                      </span>
                      <span className="info-item-value">
                        {new Date(customer.delete_after).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Progress Summary Metrics */}
              <div className="drawer-progress-summary">
                <div className="progress-summary-header">
                  <span className="progress-title">Verification Intake Progress</span>
                  <span className="progress-fraction">
                    <b>{customer.received_count}</b> of <b>{customer.required_count}</b> verified
                  </span>
                </div>
                <div className="mini-bar" style={{ height: 8, margin: "8px 0" }}>
                  <i
                    style={{
                      width: `${
                        customer.required_count > 0
                          ? Math.round((customer.received_count / customer.required_count) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className="progress-legend-row">
                  <span className="legend-item ok">
                    <IconCheck size={12} /> {customer.received_count} Verified
                  </span>
                  <span className="legend-item warn">
                    <IconClock size={12} /> {customer.pending_count} Pending
                  </span>
                  {customer.case_status === "completed" && (
                    <span className="legend-item highlight">Completed</span>
                  )}
                </div>
              </div>

              {/* Required Documents Checklist */}
              <div className="drawer-section-card">
                <h4 className="drawer-section-title">Required Documents Checklist</h4>
                <div className="checklist-items-wrap">
                  {customer.required?.map((req) => {
                    const isVerified = req.state === "verified";
                    const isResubmit = req.state === "resubmit";
                    const isProcessing = req.state === "processing";
                    return (
                      <div key={req.doc_type} className="checklist-row">
                        <div className="checklist-info">
                          <span className="checklist-doc-name">{req.label}</span>
                          <span className="mut checklist-doc-key">{req.doc_type}</span>
                        </div>
                        <div>
                          <span className={`tag ${req.state}`}>
                            {isVerified && "Verified"}
                            {isResubmit && "Resubmit Needed"}
                            {isProcessing && "Processing OCR"}
                            {!isVerified && !isResubmit && !isProcessing && "Pending Upload"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Uploaded Documents List with Secure View */}
              <div className="drawer-section-card">
                <h4 className="drawer-section-title">
                  Uploaded Document Files ({customer.documents?.length || 0})
                </h4>
                {(!customer.documents || customer.documents.length === 0) ? (
                  <p className="mut" style={{ fontSize: 13, padding: "8px 0" }}>
                    No files have been uploaded yet by the customer.
                  </p>
                ) : (
                  <div className="drawer-docs-table-wrap">
                    <table style={{ width: "100%", fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>Document</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customer.documents.map((d) => (
                          <tr key={d.id}>
                            <td>
                              <b>{d.label}</b>
                              <div className="mut" style={{ fontSize: 11 }}>
                                {d.filename}
                              </div>
                            </td>
                            <td>
                              <span className={`tag ${d.verification_status}`}>
                                {d.verification_status}
                              </span>
                            </td>
                            <td>
                              {d.file_state === "deleted" ? (
                                <span className="tag deleted">Deleted</span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn sec"
                                  onClick={() => onSecureView(d.id, `${customer.name} - ${d.label}`)}
                                  style={{ padding: "4px 8px", fontSize: 11 }}
                                >
                                  <IconEye size={12} /> View
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Action Operations Bar */}
              <div className="drawer-actions-card">
                <h4 className="drawer-section-title">Case Operations</h4>
                <div className="drawer-action-buttons-grid">
                  <button
                    type="button"
                    className="sec"
                    disabled={busyAction}
                    onClick={() =>
                      handleAction(
                        () => resendConsentEmail(customer.id),
                        `Consent email resent to ${customer.email}.`
                      )
                    }
                  >
                    <IconMail size={14} /> Resend Consent Email
                  </button>
                  <button
                    type="button"
                    className="sec"
                    disabled={busyAction}
                    onClick={() =>
                      handleAction(
                        () => resendUploadLink(customer.id),
                        `Upload link email resent to ${customer.email}.`
                      )
                    }
                  >
                    <IconMail size={14} /> Resend Upload Link
                  </button>
                  {customer.case_status === "in_progress" && (
                    <button
                      type="button"
                      className="sec"
                      disabled={busyAction}
                      onClick={() => {
                        if (window.confirm("Close this customer case?")) {
                          handleAction(
                            () => closeAdminCase(customer.id, "Staff manual closure"),
                            "Case closed successfully."
                          );
                        }
                      }}
                    >
                      Close Case
                    </button>
                  )}
                  <Link
                    to={`/admin/customers/${customer.id}`}
                    className="btn sec"
                    style={{ justifyContent: "center" }}
                  >
                    <IconExternalLink size={14} /> Full Customer Details Page
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
