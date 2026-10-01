import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  approveReview,
  createAdminCustomer,
  fetchDocumentFile,
  getAdminAudit,
  getAdminCustomers,
  getAdminReviews,
  getAdminSummary,
  getAdminToken,
  loginAdmin,
  rejectReview,
} from "../api";
import type {
  AdminAuditItem,
  AdminCustomerListItem,
  AdminReviewItem,
  AdminSummary,
} from "../types";

const ALL_DOC_TYPES = [
  { key: "pan", label: "PAN Card" },
  { key: "aadhaar", label: "Aadhaar Card" },
  { key: "passport", label: "Passport" },
  { key: "voter", label: "Voter ID" },
  { key: "driving_licence", label: "Driving Licence" },
  { key: "bank_statement", label: "Bank Statement" },
  { key: "salary_slip", label: "Salary Slip / Payslip" },
  { key: "cancelled_cheque", label: "Cancelled Cheque" },
  { key: "itr", label: "ITR Acknowledgement" },
  { key: "udyam", label: "Udyam Registration" },
  { key: "shop_establishment", label: "Shop & Establishment" },
  { key: "fssai", label: "FSSAI Certificate" },
  { key: "utility_bill", label: "Utility Bill" },
];

export const AdminPage: React.FC = () => {
  const navigate = useNavigate();
  const token = getAdminToken();

  // Auth State
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // Tab State: "cases" | "reviews" | "audit"
  const [tab, setTab] = useState<"cases" | "reviews" | "audit">("cases");

  // Cases Tab State
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [customers, setCustomers] = useState<AdminCustomerListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [loadingCases, setLoadingCases] = useState(true);

  // Add Customer Form Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newMobile, setNewMobile] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<string[]>(["pan"]);
  const [sendConsentNow, setSendConsentNow] = useState(true);
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // Reviews Tab State
  const [reviews, setReviews] = useState<AdminReviewItem[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewActionLoading, setReviewActionLoading] = useState<string | null>(null);

  // Audit Tab State
  const [auditLogs, setAuditLogs] = useState<AdminAuditItem[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Load dashboard data when tab, token or search changes
  useEffect(() => {
    if (!token) return;
    let ignore = false;

    if (tab === "cases") {
      Promise.all([getAdminSummary(), getAdminCustomers(activeSearch, 100, 0)])
        .then(([sumRes, custRes]) => {
          if (!ignore) {
            setSummary(sumRes);
            setCustomers(custRes.customers);
            setLoadingCases(false);
          }
        })
        .catch((err: Error) => {
          if (!ignore) {
            setAuthError(err.message);
            setLoadingCases(false);
          }
        });
    } else if (tab === "reviews") {
      getAdminReviews("open")
        .then((items) => {
          if (!ignore) setReviews(items);
        })
        .catch((err: Error) => {
          if (!ignore) setAuthError(err.message);
        });
    } else if (tab === "audit") {
      getAdminAudit(200)
        .then((items) => {
          if (!ignore) {
            setAuditLogs(items);
            setLoadingAudit(false);
          }
        })
        .catch((err: Error) => {
          if (!ignore) {
            setAuthError(err.message);
            setLoadingAudit(false);
          }
        });
    }

    return () => {
      ignore = true;
    };
  }, [token, tab, activeSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setLoadingCases(true);
    setActiveSearch(searchQuery);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    setAuthError(null);
    try {
      await loginAdmin(email, password);
      setSigningIn(false);
      navigate("/admin");
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Sign in failed.");
      setSigningIn(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim() || selectedDocs.length === 0) {
      setAddCustomerError("Name, email, and at least one required document are required.");
      return;
    }

    setCreatingCustomer(true);
    setAddCustomerError(null);
    try {
      await createAdminCustomer({
        name: newName.trim(),
        email: newEmail.trim(),
        mobile: newMobile.trim() || null,
        required_documents: selectedDocs,
        send_consent: sendConsentNow,
      });
      setCreatingCustomer(false);
      setShowAddModal(false);
      // Reset form
      setNewName("");
      setNewEmail("");
      setNewMobile("");
      setSelectedDocs(["pan"]);
      // Refresh cases list
      const res = await getAdminCustomers(searchQuery, 100, 0);
      setCustomers(res.customers);
    } catch (err: unknown) {
      setAddCustomerError(err instanceof Error ? err.message : "Failed to create customer.");
      setCreatingCustomer(false);
    }
  };

  const handleReviewDecision = async (id: string, action: "approve" | "reject") => {
    setReviewActionLoading(id);
    try {
      const note = reviewNotes[id] || undefined;
      if (action === "approve") {
        await approveReview(id, note);
      } else {
        await rejectReview(id, note);
      }
      setReviews((prev) => prev.filter((r) => r.id !== id));
      setReviewActionLoading(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Review action failed.");
      setReviewActionLoading(null);
    }
  };

  const handleSecureView = async (docId: string) => {
    try {
      const blob = await fetchDocumentFile(docId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to open document file.");
    }
  };

  // --- Render Login Form if unauthenticated ---
  if (!token) {
    return (
      <div className="narrow card" id="admin-login-card">
        <h1>Staff sign in</h1>
        <p className="mut">Enter your Supabase credentials to manage cases.</p>

        {authError && (
          <div className="msg err" role="alert">
            {authError}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ marginTop: 20 }}>
          <label htmlFor="staff-email">Email</label>
          <input
            id="staff-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label htmlFor="staff-password">Password</label>
          <input
            id="staff-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <div style={{ marginTop: 24 }}>
            <button type="submit" className="ok" disabled={signingIn} id="staff-login-btn">
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // --- Render Admin Dashboard ---
  return (
    <div id="admin-dashboard">
      <div className="row">
        <h1>Cases & Operations</h1>
        <button className="ok" onClick={() => setShowAddModal(true)} id="btn-add-customer">
          + Add customer
        </button>
      </div>

      <nav className="tabs" id="admin-nav-tabs">
        <button
          className={tab === "cases" ? "on" : ""}
          onClick={() => setTab("cases")}
          id="tab-btn-cases"
        >
          Customer cases
        </button>
        <button
          className={tab === "reviews" ? "on" : ""}
          onClick={() => setTab("reviews")}
          id="tab-btn-reviews"
        >
          Manual reviews {summary?.open_reviews ? `(${summary.open_reviews})` : ""}
        </button>
        <button
          className={tab === "audit" ? "on" : ""}
          onClick={() => setTab("audit")}
          id="tab-btn-audit"
        >
          Audit log
        </button>
      </nav>

      {/* --- TAB 1: CASES --- */}
      {tab === "cases" && (
        <div id="tab-pane-cases">
          {summary && (
            <div className="grid" id="summary-stats-grid">
              <div className="card">
                <div className="stat">{summary.cases?.in_progress || 0}</div>
                <div className="mut">In progress</div>
              </div>
              <div className="card">
                <div className="stat">{summary.cases?.completed || 0}</div>
                <div className="mut">Completed</div>
              </div>
              <div className="card">
                <div className="stat">{summary.open_reviews || 0}</div>
                <div className="mut">Open reviews</div>
              </div>
              <div className="card">
                <div className="stat">{summary.jobs?.failed || 0}</div>
                <div className="mut">Failed jobs</div>
              </div>
            </div>
          )}

          <form onSubmit={handleSearch} className="row" style={{ margin: "20px 0 12px" }}>
            <input
              type="search"
              placeholder="Search by name, email, or code…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ maxWidth: 360 }}
              id="customer-search-input"
            />
            <button type="submit" className="sec" id="customer-search-btn">
              Search
            </button>
          </form>

          <div className="card wrap" style={{ padding: 0 }}>
            {loadingCases ? (
              <p style={{ padding: 20 }} className="mut">
                Loading customer list…
              </p>
            ) : customers.length === 0 ? (
              <p style={{ padding: 20 }} className="mut">
                No customers found matching search criteria.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Customer</th>
                    <th>Consent</th>
                    <th>Case status</th>
                    <th>Verified</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600, fontFamily: "monospace" }}>{c.code}</td>
                      <td>
                        <b>{c.name}</b>
                        <div className="mut" style={{ fontSize: 13 }}>
                          {c.email}
                        </div>
                      </td>
                      <td>
                        <span className={`tag ${c.consent_status}`}>{c.consent_status}</span>
                      </td>
                      <td>
                        <span className={`tag ${c.case_status}`}>{c.case_status}</span>
                      </td>
                      <td>
                        {c.received_count} of {c.required_count}
                      </td>
                      <td>
                        <Link
                          to={`/admin/customers/${c.id}`}
                          className="btn sec"
                          style={{ padding: "5px 12px", fontSize: 13 }}
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* --- TAB 2: MANUAL REVIEWS --- */}
      {tab === "reviews" && (
        <div id="tab-pane-reviews">
          {reviews.length === 0 ? (
            <div className="card mut">No pending documents require manual review.</div>
          ) : (
            reviews.map((r) => (
              <div className="card" key={r.id}>
                <div className="row">
                  <div>
                    <b>
                      {r.customer_name} <span className="mut">({r.customer_code})</span>
                    </b>
                    <div style={{ marginTop: 4, fontWeight: 600 }}>{r.document.label}</div>
                  </div>
                  <span className="tag under_review">Requires review</span>
                </div>
                <p className="mut" style={{ marginTop: 8 }}>
                  Reason: {r.reason || "Confidence below auto-verification threshold"}
                </p>
                <p className="mut" style={{ fontSize: 13, marginTop: 4 }}>
                  Flags: {r.flags && r.flags.length > 0 ? r.flags.join(", ") : "none"} · Queued:{" "}
                  {new Date(r.created_at).toLocaleString()}
                </p>
                <div style={{ margin: "14px 0" }}>
                  <label htmlFor={`review-note-${r.id}`}>Reviewer note (optional)</label>
                  <input
                    id={`review-note-${r.id}`}
                    placeholder="Enter reason or approval notes"
                    value={reviewNotes[r.id] || ""}
                    onChange={(e) =>
                      setReviewNotes({ ...reviewNotes, [r.id]: e.target.value })
                    }
                  />
                </div>
                <div className="row" style={{ justifyContent: "flex-start", gap: 10 }}>
                  <button
                    type="button"
                    className="sec"
                    onClick={() => handleSecureView(r.document.id)}
                    id={`btn-review-view-${r.id}`}
                  >
                    Secure view
                  </button>
                  <button
                    className="ok"
                    disabled={reviewActionLoading === r.id}
                    onClick={() => handleReviewDecision(r.id, "approve")}
                    id={`btn-review-approve-${r.id}`}
                  >
                    Approve
                  </button>
                  <button
                    className="no"
                    disabled={reviewActionLoading === r.id}
                    onClick={() => handleReviewDecision(r.id, "reject")}
                    id={`btn-review-reject-${r.id}`}
                  >
                    Reject & ask resubmit
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* --- TAB 3: AUDIT LOG --- */}
      {tab === "audit" && (
        <div id="tab-pane-audit" className="card wrap" style={{ padding: 0 }}>
          {loadingAudit ? (
            <p style={{ padding: 20 }} className="mut">
              Loading audit records…
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Timestamp (UTC)</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td className="mut" style={{ fontSize: 13 }}>
                      {new Date(a.at).toLocaleString()}
                    </td>
                    <td>
                      <b>{a.actor}</b>
                    </td>
                    <td>
                      <span className="tag">{a.action}</span>
                    </td>
                    <td className="mut">
                      {a.entity_type} #{a.entity_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* --- ADD CUSTOMER MODAL --- */}
      {showAddModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div className="card" style={{ maxWidth: 540, width: "100%", maxHeight: "90vh", overflowY: "auto" }}>
            <h2>Create new customer case</h2>

            {addCustomerError && (
              <div className="msg err" role="alert">
                {addCustomerError}
              </div>
            )}

            <form onSubmit={handleCreateCustomer}>
              <label htmlFor="new-cust-name">Full name</label>
              <input
                id="new-cust-name"
                required
                placeholder="Jane Doe"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />

              <label htmlFor="new-cust-email">Email address</label>
              <input
                id="new-cust-email"
                type="email"
                required
                placeholder="jane.doe@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />

              <label htmlFor="new-cust-mobile">Mobile number (optional)</label>
              <input
                id="new-cust-mobile"
                placeholder="+919876543210"
                value={newMobile}
                onChange={(e) => setNewMobile(e.target.value)}
              />

              <label style={{ marginTop: 14 }}>Required documents</label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  background: "var(--card-subtle)",
                  padding: 12,
                  borderRadius: 8,
                }}
              >
                {ALL_DOC_TYPES.map((dt) => (
                  <label key={dt.key} className="chk">
                    <input
                      type="checkbox"
                      checked={selectedDocs.includes(dt.key)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedDocs([...selectedDocs, dt.key]);
                        } else {
                          setSelectedDocs(selectedDocs.filter((x) => x !== dt.key));
                        }
                      }}
                    />
                    <span>{dt.label}</span>
                  </label>
                ))}
              </div>

              <div style={{ marginTop: 14 }}>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={sendConsentNow}
                    onChange={(e) => setSendConsentNow(e.target.checked)}
                  />
                  <span>Send consent email request immediately</span>
                </label>
              </div>

              <div className="row" style={{ marginTop: 24 }}>
                <button type="submit" className="ok" disabled={creatingCustomer}>
                  {creatingCustomer ? "Creating…" : "Create customer"}
                </button>
                <button
                  type="button"
                  className="sec"
                  onClick={() => setShowAddModal(false)}
                  disabled={creatingCustomer}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
