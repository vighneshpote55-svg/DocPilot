import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  approveReview,
  createAdminCustomer,
  deleteAdminDocumentFile,
  fetchDocumentFile,
  getAdminAudit,
  getAdminCustomers,
  getAdminDocuments,
  getAdminReviews,
  getAdminSummary,
  getAdminToken,
  loginAdmin,
  rejectReview,
} from "../api";
import type {
  AdminAuditItem,
  AdminCustomerListItem,
  AdminDocumentItem,
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

  // Tab State: "cases" | "documents" | "reviews" | "audit"
  const [tab, setTab] = useState<"cases" | "documents" | "reviews" | "audit">("cases");

  // Cases Tab State
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [customers, setCustomers] = useState<AdminCustomerListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [loadingCases, setLoadingCases] = useState(true);

  // Documents Tab State (PDF Section 8)
  const [documents, setDocuments] = useState<AdminDocumentItem[]>([]);
  const [docsTotalCount, setDocsTotalCount] = useState(0);
  const [docSearchQuery, setDocSearchQuery] = useState("");
  const [activeDocSearch, setActiveDocSearch] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState("");
  const [docStatusFilter, setDocStatusFilter] = useState("");
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [activeViewUrl, setActiveViewUrl] = useState<string | null>(null);
  const [viewingDocTitle, setViewingDocTitle] = useState("");

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
      getAdminSummary()
        .then((sumRes) => {
          if (!ignore) setSummary(sumRes);
        })
        .catch((err: Error) => {
          if (!ignore) setAuthError(err.message);
        });

      getAdminCustomers(activeSearch, 20, 0)
        .then((custRes) => {
          if (!ignore) {
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
    } else if (tab === "documents") {
      setLoadingDocs(true);
      getAdminDocuments(activeDocSearch, docTypeFilter, docStatusFilter, 25, 0)
        .then((res) => {
          if (!ignore) {
            setDocuments(res.documents);
            setDocsTotalCount(res.totalCount);
            setLoadingDocs(false);
          }
        })
        .catch((err: Error) => {
          if (!ignore) {
            setAuthError(err.message);
            setLoadingDocs(false);
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
  }, [token, tab, activeSearch, activeDocSearch, docTypeFilter, docStatusFilter]);


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

  const handleSecureView = async (docId: string, title?: string) => {
    try {
      const blob = await fetchDocumentFile(docId);
      const url = URL.createObjectURL(blob);
      setActiveViewUrl(url);
      setViewingDocTitle(title || "Document Preview");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to open document file.");
    }
  };

  const handleDocSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveDocSearch(docSearchQuery);
  };

  const handleDeleteFile = async (docId: string) => {
    if (!window.confirm("Are you sure you want to permanently delete this stored file?")) return;
    try {
      await deleteAdminDocumentFile(docId);
      setDocuments((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, file_state: "deleted" } : d))
      );
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete file.");
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
          className={tab === "documents" ? "on" : ""}
          onClick={() => setTab("documents")}
          id="tab-btn-documents"
        >
          All documents {docsTotalCount > 0 ? `(${docsTotalCount})` : ""}
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
            <div className="grid" id="summary-stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
              <div className="card">
                <div className="stat">{summary.cases?.in_progress || 0}</div>
                <div className="mut">In progress</div>
              </div>
              <div className="card">
                <div className="stat">{summary.cases?.completed || 0}</div>
                <div className="mut">Completed</div>
              </div>
              <div className="card">
                <div className="stat" style={{ color: "var(--acc)" }}>
                  {summary.metrics?.completion_rate !== undefined ? `${summary.metrics.completion_rate}%` : "—"}
                </div>
                <div className="mut">Completion rate</div>
              </div>
              <div className="card">
                <div className="stat">{summary.metrics?.total_documents || 0}</div>
                <div className="mut">Total documents</div>
              </div>
              <div className="card">
                <div className="stat">{summary.metrics?.verified_documents || 0}</div>
                <div className="mut">Verified docs</div>
              </div>
              <div className="card">
                <div className="stat" style={{ color: summary.open_reviews ? "var(--warn)" : "inherit" }}>
                  {summary.open_reviews || 0}
                </div>
                <div className="mut">Open reviews</div>
              </div>
              <div className="card">
                <div className="stat" style={{ color: summary.jobs?.failed ? "var(--bad)" : "inherit" }}>
                  {summary.jobs?.failed || 0}
                </div>
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

      {/* --- TAB: ALL DOCUMENTS (PDF Section 8) --- */}
      {tab === "documents" && (
        <div id="tab-pane-documents">
          <div className="card" style={{ marginBottom: 20 }}>
            <form onSubmit={handleDocSearch} className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <input
                type="search"
                placeholder="Search by customer name, email, or filename…"
                value={docSearchQuery}
                onChange={(e) => setDocSearchQuery(e.target.value)}
                style={{ flex: "1 1 260px", maxWidth: 360 }}
                id="doc-search-input"
              />
              <select
                value={docTypeFilter}
                onChange={(e) => setDocTypeFilter(e.target.value)}
                style={{ flex: "0 0 160px" }}
                id="doc-type-filter"
              >
                <option value="">All Document Types</option>
                {ALL_DOC_TYPES.map((dt) => (
                  <option key={dt.key} value={dt.key}>
                    {dt.label}
                  </option>
                ))}
              </select>
              <select
                value={docStatusFilter}
                onChange={(e) => setDocStatusFilter(e.target.value)}
                style={{ flex: "0 0 170px" }}
                id="doc-status-filter"
              >
                <option value="">All Statuses</option>
                <option value="verified">Verified</option>
                <option value="under_review">Under Review</option>
                <option value="unverified">Unverified</option>
                <option value="rejected">Rejected</option>
              </select>
              <button type="submit" className="sec" id="doc-search-btn">
                Filter
              </button>
              {(activeDocSearch || docTypeFilter || docStatusFilter) && (
                <button
                  type="button"
                  className="sec"
                  onClick={() => {
                    setDocSearchQuery("");
                    setActiveDocSearch("");
                    setDocTypeFilter("");
                    setDocStatusFilter("");
                  }}
                >
                  Reset
                </button>
              )}
            </form>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>
                Documents list <span className="mut" style={{ fontSize: 14 }}>({docsTotalCount} total)</span>
              </h3>
            </div>

            {loadingDocs ? (
              <p className="mut">Loading documents…</p>
            ) : documents.length === 0 ? (
              <p className="mut">No documents found matching the filter criteria.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }} id="all-documents-table">
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "8px 6px" }}>Customer</th>
                    <th style={{ padding: "8px 6px" }}>Document</th>
                    <th style={{ padding: "8px 6px" }}>Uploaded</th>
                    <th style={{ padding: "8px 6px" }}>OCR</th>
                    <th style={{ padding: "8px 6px" }}>Verification</th>
                    <th style={{ padding: "8px 6px" }}>File State</th>
                    <th style={{ padding: "8px 6px" }}>Flags</th>
                    <th style={{ padding: "8px 6px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((d) => (
                    <tr key={d.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 6px" }}>
                        <div>
                          <Link to={`/admin/customers/${d.customer_id}`} style={{ fontWeight: 600 }}>
                            {d.customer_name || `Customer #${d.customer_id}`}
                          </Link>
                        </div>
                        <span className="mut" style={{ fontSize: 12 }}>{d.customer_code}</span>
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <b>{d.label}</b>
                        <div className="mut" style={{ fontSize: 12 }}>{d.filename}</div>
                      </td>
                      <td style={{ padding: "10px 6px", fontSize: 13 }}>
                        {d.uploaded_at ? new Date(d.uploaded_at).toLocaleString() : "—"}
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <span className={`tag ${d.ocr_status}`}>{d.ocr_status}</span>
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <span className={`tag ${d.verification_status}`}>{d.verification_status}</span>
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <span className={`tag ${d.file_state}`}>{d.file_state}</span>
                      </td>
                      <td style={{ padding: "10px 6px", fontSize: 12 }}>
                        {d.flags && d.flags.length > 0 ? (
                          <span style={{ color: "var(--warn)" }}>{d.flags.join(", ")}</span>
                        ) : (
                          <span className="mut">—</span>
                        )}
                      </td>
                      <td style={{ padding: "10px 6px" }}>
                        <div className="row" style={{ gap: 6 }}>
                          {d.file_state === "stored" ? (
                            <>
                              <button
                                type="button"
                                className="btn sec"
                                style={{ padding: "4px 8px", fontSize: 12 }}
                                onClick={() => handleSecureView(d.id, `${d.label} - ${d.customer_name || d.customer_code}`)}
                                title="Stream decrypted document safely"
                              >
                                View
                              </button>
                              <button
                                type="button"
                                className="btn bad"
                                style={{ padding: "4px 8px", fontSize: 12 }}
                                onClick={() => handleDeleteFile(d.id)}
                                title="Permanently delete stored file"
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <span className="mut" style={{ fontSize: 12 }}>Purged</span>
                          )}
                        </div>
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

      {/* Secure Document Viewer Modal */}
      {activeViewUrl && (
        <div
          className="modal-backdrop"
          onClick={() => {
            URL.revokeObjectURL(activeViewUrl);
            setActiveViewUrl(null);
          }}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 900,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              padding: 20,
              background: "var(--card-bg, #fff)",
              borderRadius: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            }}
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>{viewingDocTitle}</h3>
              <button
                type="button"
                className="sec"
                onClick={() => {
                  URL.revokeObjectURL(activeViewUrl);
                  setActiveViewUrl(null);
                }}
              >
                Close preview
              </button>
            </div>
            <div style={{ flex: 1, overflow: "auto", minHeight: 450, display: "flex", justifyContent: "center", alignItems: "center", background: "#f8f9fa", borderRadius: 4 }}>
              <iframe
                src={activeViewUrl}
                title={viewingDocTitle}
                style={{ width: "100%", height: "100%", minHeight: 500, border: "none" }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
