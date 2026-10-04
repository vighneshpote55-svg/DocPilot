import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { clearAdminToken, getAdminToken } from "../api";
import { IconShieldCheck, IconSun, IconMoon } from "./admin/AdminIcons";

export const Header: React.FC = () => {
  const navigate = useNavigate();
  const token = getAdminToken();

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("docpilot_customer_theme") as "dark" | "light") ||
      (localStorage.getItem("docpilot_admin_theme") as "dark" | "light") ||
      "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "light") {
      document.documentElement.classList.add("admin-theme-light");
    } else {
      document.documentElement.classList.remove("admin-theme-light");
    }
    localStorage.setItem("docpilot_customer_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const handleSignOut = () => {
    clearAdminToken();
    navigate("/admin");
  };

  return (
    <header className="customer-header">
      <Link to="/" className="customer-brand-group" id="brand-logo">
        <div className="customer-brand-logo">
          <IconShieldCheck size={20} />
        </div>
        <div className="customer-brand-text">
          <span className="customer-brand-name">DocPilot</span>
          <span className="customer-brand-sub">Secure Enclave</span>
        </div>
      </Link>

      <div className="customer-header-right">
        <div className="customer-security-pill" title="End-to-End Encrypted Session">
          <IconShieldCheck size={13} />
          <span>256-Bit SSL Enclave</span>
        </div>

        <button
          type="button"
          className="customer-theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          aria-label="Toggle visual theme"
          id="customer-theme-toggle"
        >
          {theme === "dark" ? (
            <IconSun size={18} color="#f59e0b" />
          ) : (
            <IconMoon size={18} color="#3b82f6" />
          )}
        </button>

        <Link to="/privacy" className="customer-nav-link" id="nav-privacy-link">
          Data Rights
        </Link>

        <div id="who" style={{ display: "inline-flex", alignItems: "center" }}>
          {token ? (
            <span style={{ fontSize: 13, color: "var(--adm-text-muted)" }}>
              Staff ·{" "}
              <button
                type="button"
                className="customer-nav-link"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                onClick={handleSignOut}
                id="staff-sign-out"
              >
                Sign out
              </button>
            </span>
          ) : (
            <Link to="/admin" className="customer-nav-link" id="nav-staff-login">
              Staff sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
};
