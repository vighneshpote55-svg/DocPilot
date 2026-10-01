import React, { useState } from "react";
import { useParams } from "react-router-dom";
import { confirmPrivacy } from "../api";

export const PrivacyConfirmPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const handleConfirm = async () => {
    if (!token) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const res = await confirmPrivacy(token);
      setStatusMsg({
        text:
          res.completed === "delete"
            ? "Your documents, temporary OCR data, and active tokens have been permanently deleted."
            : "Consent withdrawn. Processing and reminders for your case have stopped.",
        ok: true,
      });
    } catch (err: unknown) {
      setStatusMsg({
        text: err instanceof Error ? err.message : "Confirmation failed.",
        ok: false,
      });
      setSubmitting(false);
    }
  };

  return (
    <div className="narrow card" id="privacy-confirm-card">
      <h1>Confirm your privacy request</h1>
      <p className="mut">
        This action cannot be undone. Please confirm that you want to proceed with this request.
      </p>

      {statusMsg ? (
        <div className={`msg ${statusMsg.ok ? "ok" : "err"}`} role="status">
          {statusMsg.text}
        </div>
      ) : (
        <div style={{ marginTop: 24 }}>
          <button
            className="no"
            onClick={handleConfirm}
            disabled={submitting}
            id="privacy-confirm-btn"
          >
            {submitting ? "Processing…" : "Confirm request"}
          </button>
        </div>
      )}
    </div>
  );
};
