import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { clearAdminToken, getAdminToken } from "../api";

export const Header: React.FC = () => {
  const navigate = useNavigate();
  const token = getAdminToken();

  const handleSignOut = () => {
    clearAdminToken();
    navigate("/admin");
  };

  return (
    <header className="app-header">
      <Link to="/" className="brand" id="brand-logo">
        <b>DocPilot</b>
        <span className="brand-badge">Secure</span>
      </Link>
      <div id="who" className="mut">
        {token ? (
          <span>
            Staff logged in ·{" "}
            <button className="link" onClick={handleSignOut} id="staff-sign-out">
              Sign out
            </button>
          </span>
        ) : (
          <Link to="/admin" className="link" id="nav-staff-login">
            Staff sign in
          </Link>
        )}
      </div>
    </header>
  );
};
