import React, { useCallback, useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  getDocumentStatus,
  getPortal,
  sendPortalOtp,
  uploadDocument,
  verifyPortalOtp,
} from "../api";
import type { CustomerDocState, PortalDocument, PortalState } from "../types";

const STATE_LABELS: Record<CustomerDocState, string> = {
  pending_upload: "Waiting for your upload",
  processing: "Checking",
  under_review: "Under review by our team",
  resubmit: "Please upload again",
  verified: "Received and verified",
};

export const PortalPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [portal, setPortal] = useState<PortalState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // OTP state
  const [otpCode, setOtpCode] = useState<string>("");
  const [otpSent, setOtpSent] = useState<boolean>(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState<boolean>(false);

  // Upload & polling state per document type
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);
  const [dragOverDoc, setDragOverDoc] = useState<string | null>(null);
  const [docMessages, setDocMessages] = useState<Record<string, { text: string; ok: boolean }>>({});
  const pollTimers = useRef<Record<string, number>>({});


  const loadPortal = useCallback(async () => {
    if (!token) return;
    try {
      const data = await getPortal(token);
      setPortal(data);
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load portal.");
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let ignore = false;

    // Reset messages and states on token change
    setDocMessages({});
    setError(null);
    setLoading(true);

    getPortal(token)
      .then((data) => {
        if (!ignore) {
          setPortal(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Unable to load portal.");
          setLoading(false);
        }
      });

    const activeTimers = pollTimers.current;
    return () => {
      ignore = true;
      Object.values(activeTimers).forEach((t) => clearInterval(t));
      pollTimers.current = {};
    };
  }, [token]);

  const handleSendOtp = async () => {
    if (!token) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      await sendPortalOtp(token);
      setOtpSent(true);
      setOtpLoading(false);
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Failed to send code.");
      setOtpLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !otpCode.trim()) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      await verifyPortalOtp(token, otpCode.trim());
      setOtpLoading(false);
      await loadPortal();
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Verification failed.");
      setOtpLoading(false);
    }
  };

  const pollStatus = (docType: string, docId: string) => {
    if (!token) return;
    let attempts = 0;
    const interval = window.setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await getDocumentStatus(token, docId);
        if (res.state === "processing") return;

        clearInterval(interval);
        delete pollTimers.current[docType];

        setPortal((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            documents: prev.documents.map((d) =>
              d.doc_type === docType
                ? { ...d, state: res.state, document_id: res.document_id }
                : d
            ),
          };
        });

        if (res.state === "verified") {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: "Document verified successfully.", ok: true },
          }));
          setTimeout(loadPortal, 1200);
        } else if (res.state === "resubmit") {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: res.message || "Please upload a clear, valid copy.", ok: false },
          }));
        } else {
          setDocMessages((prev) => ({
            ...prev,
            [docType]: { text: "Under review by our team.", ok: true },
          }));
        }
      } catch {
        clearInterval(interval);
        delete pollTimers.current[docType];
      }
    }, 3000);

    pollTimers.current[docType] = interval;
  };

  const handleUpload = async (doc: PortalDocument, file: File | null) => {
    if (!token || !file) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: { text: "Please select a file first.", ok: false },
      }));
      return;
    }

    if (file.size === 0) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: "The selected file is empty. Please select a valid document.",
          ok: false,
        },
      }));
      return;
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const allowed = ["pdf", "png", "jpg", "jpeg"];
    if (ext && !allowed.includes(ext)) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: "Only PDF, PNG, and JPG files are accepted.",
          ok: false,
        },
      }));
      return;
    }

    if (portal && file.size > portal.max_upload_mb * 1024 * 1024) {
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: `File exceeds maximum allowed size of ${portal.max_upload_mb} MB.`,
          ok: false,
        },
      }));
      return;
    }

    setUploadingDoc(doc.doc_type);
    setDocMessages((prev) => ({
      ...prev,
      [doc.doc_type]: { text: "Uploading and securing document…", ok: true },
    }));

    try {
      const res = await uploadDocument(token, doc.doc_type, file);
      setUploadingDoc(null);
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: { text: "Uploaded. Checking document validity…", ok: true },
      }));
      pollStatus(doc.doc_type, res.document_id);
    } catch (err: unknown) {
      setUploadingDoc(null);
      setDocMessages((prev) => ({
        ...prev,
        [doc.doc_type]: {
          text: err instanceof Error ? err.message : "Upload failed.",
          ok: false,
        },
      }));
    }
  };

  if (loading) {
    return (
      <div className="narrow card" id="portal-loading">
        <p className="mut">Loading your document collection portal…</p>
      </div>
    );
  }

  if (error || !portal) {
    return (
      <div className="narrow card" id="portal-error">
        <div className="msg err" role="alert">
          {error || "Unable to access portal."}
        </div>
      </div>
    );
  }

  // --- Render OTP Verification if required ---
  if (portal.otp_required) {
    return (
      <div className="narrow card" id="portal-otp-screen">
        <h1>Email verification</h1>
        <p className="mut">
          For your security, please verify your email before uploading documents.
        </p>

        {portal.masked_email && (
          <p>
            A one-time code will be sent to <b>{portal.masked_email}</b>.
          </p>
        )}

        {otpError && (
          <div className="msg err" role="alert">
            {otpError}
          </div>
        )}

        {!otpSent ? (
          <button
            className="ok"
            onClick={handleSendOtp}
            disabled={otpLoading}
            id="portal-otp-send-btn"
          >
            {otpLoading ? "Sending code…" : "Send verification code"}
          </button>
        ) : (
          <form onSubmit={handleVerifyOtp} style={{ marginTop: 16 }}>
            <label htmlFor="otp-input">6-digit verification code</label>
            <input
              id="otp-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              required
              autoFocus
            />
            <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
              <button type="submit" className="ok" disabled={otpLoading} id="portal-otp-submit-btn">
                {otpLoading ? "Verifying…" : "Verify and continue"}
              </button>
              <button
                type="button"
                className="sec"
                onClick={handleSendOtp}
                disabled={otpLoading}
                id="portal-otp-resend-btn"
              >
                Resend code
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  // --- Render Active Document Portal ---
  const total = portal.documents.length;
  const verifiedCount = total - portal.pending_count;
  const isOpen = portal.case_status === "in_progress";
  const progressPercent = total > 0 ? Math.round((verifiedCount / total) * 100) : 0;

  return (
    <div className="narrow" id="portal-container">
      <div className="card">
        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>Hello {portal.first_name}</h1>
          <span className={`tag ${portal.case_status}`} id="portal-case-status-badge">
            {portal.case_status === "completed" ? "Completed" : portal.case_status === "in_progress" ? "In progress" : portal.case_status}
          </span>
        </div>

        <div style={{ display: "flex", gap: 10, margin: "14px 0", flexWrap: "wrap" }}>
          <div style={{ background: "var(--card-subtle)", padding: "6px 12px", borderRadius: 8, fontSize: 13 }}>
            <span className="mut">Required: </span><b>{total}</b>
          </div>
          <div style={{ background: "var(--card-subtle)", padding: "6px 12px", borderRadius: 8, fontSize: 13 }}>
            <span className="mut">Received & verified: </span><b style={{ color: "var(--good, #2ecc71)" }}>{verifiedCount}</b>
          </div>
          <div style={{ background: "var(--card-subtle)", padding: "6px 12px", borderRadius: 8, fontSize: 13 }}>
            <span className="mut">Pending: </span><b style={{ color: portal.pending_count > 0 ? "var(--warn, #e67e22)" : "inherit" }}>{portal.pending_count}</b>
          </div>
        </div>

        <p className="mut" style={{ margin: "8px 0" }}>
          {verifiedCount} of {total} documents verified
        </p>
        <div
          className="bar"
          role="progressbar"
          aria-valuenow={verifiedCount}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Document verification progress"
        >
          <i style={{ width: `${progressPercent}%` }} />
        </div>

        {portal.case_status === "completed" && (
          <div className="msg ok" role="status" id="portal-completed-banner" style={{ marginTop: 14 }}>
            <div>
              <b>Application complete!</b> All documents have been verified. Thank you, nothing further is needed.
              <div style={{ marginTop: 4, fontSize: 13, opacity: 0.9 }}>
                🔒 Your files are securely encrypted and will be automatically and permanently deleted within 7 days.
              </div>
            </div>
          </div>
        )}

        {!isOpen && portal.case_status !== "completed" && (
          <div className="msg err" role="alert">
            This case is closed. Uploads are no longer accepted.
          </div>
        )}
      </div>

      <div id="document-cards-list">
        {portal.documents.map((doc) => {
          const canUpload = isOpen && doc.state !== "verified" && doc.state !== "processing";
          const isBusy = uploadingDoc === doc.doc_type;
          const statusMessage = docMessages[doc.doc_type];

          return (
            <div
              className={`card ${doc.state === "verified" ? "verified" : ""} ${doc.state === "resubmit" ? "resubmit" : ""}`}
              key={doc.doc_type}
              id={`doc-card-${doc.doc_type}`}
            >
              <div className="row">
                <b style={{ fontSize: 16 }}>{doc.label}</b>
                <span className={`tag ${doc.state}`}>{STATE_LABELS[doc.state] || doc.state}</span>
              </div>

              {doc.state === "resubmit" && (
                <div className="resubmit-guidance" role="alert">
                  <strong>Resubmission required:</strong> Please upload a clear, legible copy. Ensure all text is readable and the document matches the requested type.
                </div>
              )}

              {doc.state === "verified" && (
                <div className="verified-card-summary">
                  <span>✓</span>
                  <span>Document received and verified</span>
                </div>
              )}

              {canUpload && (
                <div style={{ marginTop: 14 }}>
                  <label
                    htmlFor={`file-${doc.doc_type}`}
                    className="mut"
                    style={{ fontWeight: 400, display: "block", marginBottom: 8 }}
                  >
                    {doc.state === "resubmit"
                      ? "Upload a clear, valid copy again"
                      : "Choose file to upload"}
                  </label>
                  <div
                    role="button"
                    tabIndex={!isBusy ? 0 : -1}
                    aria-label={`Upload ${doc.label}`}
                    className={`dropzone ${dragOverDoc === doc.doc_type ? "active" : ""}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const inputEl = document.getElementById(
                          `file-${doc.doc_type}`
                        ) as HTMLInputElement | null;
                        inputEl?.click();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!isBusy) setDragOverDoc(doc.doc_type);
                    }}
                    onDragLeave={() => setDragOverDoc(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverDoc(null);
                      if (isBusy) return;
                      const file = e.dataTransfer.files?.[0] || null;
                      if (file) handleUpload(doc, file);
                    }}
                    onClick={() => {
                      const inputEl = document.getElementById(
                        `file-${doc.doc_type}`
                      ) as HTMLInputElement | null;
                      inputEl?.click();
                    }}
                  >
                    <span className="dropzone-icon">📄</span>
                    <div className="dropzone-text">
                      {dragOverDoc === doc.doc_type
                        ? "Drop file to upload"
                        : doc.state === "resubmit"
                        ? "Drop a clear, valid copy here, or click to browse"
                        : "Drag & drop document here, or click to browse"}
                    </div>
                    <div className="dropzone-hint">
                      PDF, PNG, JPG (up to {portal.max_upload_mb || 10} MB)
                    </div>
                  </div>

                  <div className="row" style={{ marginTop: 10, display: "flex", alignItems: "center" }}>
                    <input
                      type="file"
                      id={`file-${doc.doc_type}`}
                      accept=".pdf,.png,.jpg,.jpeg"
                      style={{ flex: 1 }}
                      disabled={isBusy}
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null;
                        if (file) handleUpload(doc, file);
                      }}
                    />
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        const inputEl = document.getElementById(
                          `file-${doc.doc_type}`
                        ) as HTMLInputElement | null;
                        const file = inputEl?.files?.[0] || null;
                        handleUpload(doc, file);
                      }}
                      id={`upload-btn-${doc.doc_type}`}
                      style={{ marginLeft: 8 }}
                    >
                      {isBusy ? "Uploading…" : "Upload"}
                    </button>
                  </div>

                  {isBusy && (
                    <div className="upload-progress-indicator" role="progressbar" aria-label="Uploading file">
                      <i />
                    </div>
                  )}
                </div>
              )}

              {statusMessage && (
                <div
                  className={`msg ${statusMessage.ok ? "ok" : "err"}`}
                  style={{ marginTop: 12 }}
                  role="status"
                >
                  {statusMessage.text}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mut" style={{ fontSize: 13, marginTop: 24, textAlign: "center" }}>
        Accepted file types: {portal.allowed_types.join(", ").toUpperCase()} (up to{" "}
        {portal.max_upload_mb} MB each). Your documents are encrypted and permanently deleted after verification.
      </p>
    </div>
  );
};
