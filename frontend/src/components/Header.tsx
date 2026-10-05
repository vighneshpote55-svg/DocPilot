import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { clearAdminToken, getAdminToken } from "../api";
import { IconShieldCheck } from "./admin/AdminIcons";
import { ThemeToggle } from "./ThemeToggle";

export const Header: React.FC = () => {
  const navigate = useNavigate();
  const token = getAdminToken();

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("docpilot_customer_theme") as "dark" | "light") ||
      (localStorage.getItem("docpilot_admin_theme") as "dark" | "light") ||
      (localStorage.getItem("docpilot_theme") as "dark" | "light") ||
      "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "light") {
      document.documentElement.classList.add("admin-theme-light");
      document.documentElement.classList.add("customer-theme-light");
    } else {
      document.documentElement.classList.remove("admin-theme-light");
      document.documentElement.classList.remove("customer-theme-light");
    }
    localStorage.setItem("docpilot_customer_theme", theme);
    localStorage.setItem("docpilot_admin_theme", theme);
    localStorage.setItem("docpilot_theme", theme);
    window.dispatchEvent(new CustomEvent("docpilot_theme_changed", { detail: theme }));
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

        <ThemeToggle
          id="theme-toggle-btn"
          className="customer-theme-toggle"
          theme={theme}
          onToggle={toggleTheme}
        />

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
