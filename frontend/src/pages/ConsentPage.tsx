import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getConsent, submitConsent } from "../api";
import type { ConsentInfo } from "../types";

export const ConsentPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const tokenError = !token ? "Missing consent link token." : null;

  useEffect(() => {
    if (!token) return;
    let ignore = false;

    getConsent(token)
      .then((data) => {
        if (!ignore) {
          setInfo(data);
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
  }, [token]);

  const handleDecision = async (granted: boolean) => {
    if (!token) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      await submitConsent(token, granted);
      setStatusMsg({
        text: granted
          ? "Thank you. We have sent a secure document upload link to your email."
          : "Understood. We will not process any documents for your case.",
        ok: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to record response.";
      setStatusMsg({ text: msg, ok: false });
      setSubmitting(false);
    }
  };

  const displayError = tokenError || error;

  if (loading && !tokenError) {
    return (
      <div className="narrow card" id="consent-loading">
        <p className="mut">Loading consent information…</p>
      </div>
    );
  }

  if (displayError || !info) {
    return (
      <div className="narrow card" id="consent-error">
        <div className="msg err" role="alert">
          {displayError || "Unable to load consent information."}
        </div>
      </div>
    );
  }

  return (
    <div className="narrow card" id="consent-card">
      <h1>Hello {info.first_name}</h1>
      <p>We need the following documents from you to verify your identity and business:</p>
      <div className="card" style={{ background: "var(--card-subtle)" }}>
        <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
          {info.documents.map((doc, idx) => (
            <li key={idx} style={{ margin: "6px 0", fontWeight: 500 }}>
              {doc}
            </li>
          ))}
        </ul>
      </div>
      <p className="mut" style={{ fontSize: 13, lineHeight: 1.6 }}>
        {info.purpose}
      </p>

      {statusMsg ? (
        <div className={`msg ${statusMsg.ok ? "ok" : "err"}`} role="status">
          {statusMsg.text}
        </div>
      ) : (
        <div className="row" style={{ justifyContent: "flex-start", marginTop: 24 }}>
          <button
            className="ok"
            onClick={() => handleDecision(true)}
            disabled={submitting}
            id="consent-agree-btn"
          >
            I agree
          </button>
          <button
            className="sec"
            onClick={() => handleDecision(false)}
            disabled={submitting}
            id="consent-decline-btn"
          >
            I do not agree
          </button>
        </div>
      )}
    </div>
  );
};
