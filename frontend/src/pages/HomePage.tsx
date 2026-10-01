import React from "react";
import { Link } from "react-router-dom";

export const HomePage: React.FC = () => {
  return (
    <div className="narrow card" id="home-card">
      <h1>Secure document upload</h1>
      <p className="mut">
        To upload your identity or business documents, please click the secure link sent to your registered email address.
      </p>
      <div style={{ marginTop: 24, display: "flex", gap: 16 }}>
        <Link to="/privacy" className="btn sec" id="home-privacy-link">
          Privacy & data management
        </Link>
        <Link to="/admin" className="btn sec" id="home-admin-link">
          Staff sign in
        </Link>
      </div>
    </div>
  );
};
