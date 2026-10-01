import React, { useState } from "react";
import { requestPrivacy } from "../api";

export const PrivacyPage: React.FC = () => {
  const [email, setEmail] = useState<string>("");
  const [action, setAction] = useState<"delete" | "withdraw">("delete");
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setSubmitting(true);
    setStatusMsg(null);
    try {
      const res = await requestPrivacy(email.trim(), action);
      setStatusMsg({
        text: res.message || "If this email is registered, a confirmation link has been sent.",
        ok: true,
      });
      setSubmitting(false);
    } catch (err: unknown) {
      setStatusMsg({
        text: err instanceof Error ? err.message : "Failed to submit request.",
        ok: false,
      });
      setSubmitting(false);
    }
  };

  return (
    <div className="narrow card" id="privacy-card">
      <h1>Your privacy & data</h1>
      <p className="mut">
        Enter the email address associated with your case. We will send a secure confirmation link to verify your identity.
      </p>

      <form onSubmit={handleSubmit} style={{ marginTop: 20 }}>
        <label htmlFor="privacy-email">Registered email address</label>
        <input
          id="privacy-email"
          type="email"
          autoComplete="email"
          required
          placeholder="your.email@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="privacy-action">Action requested</label>
        <select
          id="privacy-action"
          value={action}
          onChange={(e) => setAction(e.target.value as "delete" | "withdraw")}
        >
          <option value="delete">Permanently delete my documents and data now</option>
          <option value="withdraw">Withdraw consent and stop case processing</option>
        </select>

        {statusMsg && (
          <div className={`msg ${statusMsg.ok ? "ok" : "err"}`} role="status">
            {statusMsg.text}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <button type="submit" className="ok" disabled={submitting} id="privacy-submit-btn">
            {submitting ? "Sending link…" : "Send confirmation link"}
          </button>
        </div>
      </form>
    </div>
  );
};
