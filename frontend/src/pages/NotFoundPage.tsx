import React from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../utils/useDocumentTitle";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconShield,
} from "../components/admin/AdminIcons";

export const NotFoundPage: React.FC = () => {
  useDocumentTitle("Page Not Found (404)");

  return (
    <div className="customer-app-root">
      <div className="customer-content-wrap customer-content-narrow" style={{ paddingTop: 40 }}>
        <div className="customer-hero-card" id="not-found-card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(239, 68, 68, 0.12)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 20,
              color: "var(--adm-danger, #ef4444)",
            }}
          >
            <IconAlertTriangle size={32} />
          </div>

          <div
            style={{
              display: "inline-block",
              background: "var(--adm-primary-subtle, rgba(7, 94, 91, 0.1))",
              color: "var(--adm-primary, #075e5b)",
              fontWeight: 700,
              fontSize: 12,
              padding: "4px 12px",
              borderRadius: 20,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            Error 404
          </div>

          <h1 style={{ fontSize: 28, fontWeight: 800, margin: "0 0 12px", color: "var(--adm-text)" }}>
            Requested Page Not Found
          </h1>

          <p
            style={{
              maxWidth: 500,
              margin: "0 auto 28px",
              color: "var(--adm-text-secondary, #64748b)",
              fontSize: 15,
              lineHeight: 1.6,
            }}
          >
            The link you accessed may have expired, been revoked, or does not exist. If you were accessing a customer verification case, please verify the secure token in your invitation email.
          </p>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Link
              to="/"
              className="customer-access-btn"
              id="btn-return-home"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
                padding: "10px 20px",
                fontSize: 14,
              }}
            >
              <span>Return to Portal Home</span>
              <IconArrowRight size={15} />
            </Link>

            <Link
              to="/admin"
              className="customer-nav-link"
              id="btn-goto-admin"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "10px 18px",
                fontSize: 14,
                borderRadius: 8,
                border: "1px solid var(--adm-border, #e2e8f0)",
                textDecoration: "none",
              }}
            >
              <IconShield size={15} />
              <span>Staff Ops Sign In</span>
            </Link>
          </div>
        </div>

        <div
          style={{
            textAlign: "center",
            marginTop: 24,
            color: "var(--adm-text-muted, #94a3b8)",
            fontSize: 12,
          }}
        >
          🔒 DocPilot Bank-Grade Secure Enclave • India DPDP Act 2023 Compliant
        </div>
      </div>
    </div>
  );
};
export default NotFoundPage;
