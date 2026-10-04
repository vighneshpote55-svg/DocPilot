import React, { useEffect, useState, useTransition } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  approveReview,
  clearAdminToken,
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
import { AdminSidebar, type AdminNavTab } from "../components/admin/AdminSidebar";
import { AdminTopNav } from "../components/admin/AdminTopNav";
import { KpiCardGrid } from "../components/admin/KpiCardGrid";
import { VerificationTrendChart } from "../components/admin/VerificationTrendChart";
import { DocumentStatusChart } from "../components/admin/DocumentStatusChart";
import { RecentActivityFeed } from "../components/admin/RecentActivityFeed";
import { AdminReportsView } from "../components/admin/AdminReportsView";
import { AdminSettingsView } from "../components/admin/AdminSettingsView";
import { AdminCustomersView } from "../components/admin/AdminCustomersView";
import { AddCustomerDrawer } from "../components/admin/AddCustomerDrawer";
import { BulkImportModal } from "../components/admin/BulkImportModal";
import { CustomerDetailDrawer } from "../components/admin/CustomerDetailDrawer";
import { AdminDocumentsView } from "../components/admin/AdminDocumentsView";
import {
  IconEye,
  IconUsers,
} from "../components/admin/AdminIcons";

function getAdminEmail(): string {
  const token = getAdminToken();
  if (token) {
    try {
      const parts = token.split(".");
      if (parts.length > 1) {
        const payload = JSON.parse(atob(parts[1]));
        if (payload && typeof payload.email === "string") return payload.email;
      }
    } catch {}
  }
  return "admin@docpilot.internal";
}

export const AdminPage: React.FC<{ initialTab?: AdminNavTab }> = ({
  initialTab = "dashboard",
}) => {
  const navigate = useNavigate();
  const token = getAdminToken();
  const [, startTransition] = useTransition();

  // Auth State
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // Shell Layout State
  const [activeTab, setActiveTab] = useState<AdminNavTab>(initialTab);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem("docpilot_adm_sidebar_collapsed") === "true";
  });
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem("docpilot_adm_theme");
    return saved !== "light"; // default to dark-blue
  });

  // Summary & Stats State
  const [summary, setSummary] = useState<AdminSummary | null>(null);

  // Cases Tab State
  const [customers, setCustomers] = useState<AdminCustomerListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [caseStatusFilter, setCaseStatusFilter] = useState("");
  const [casesPage, setCasesPage] = useState(0);
  const [casesTotalCount, setCasesTotalCount] = useState(0);
  const [loadingCases, setLoadingCases] = useState(false);
  const CASES_PAGE_SIZE = 20;

  const [activeViewUrl, setActiveViewUrl] = useState<string | null>(null);
  const [viewingDocTitle, setViewingDocTitle] = useState("");

  // Add Customer & Intake State
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [selectedDetailCustomerId, setSelectedDetailCustomerId] = useState<number | null>(null);

  // Reviews Tab State
  const [reviews, setReviews] = useState<AdminReviewItem[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewActionLoading, setReviewActionLoading] = useState<string | null>(null);

  // Audit Tab State
  const [auditLogs, setAuditLogs] = useState<AdminAuditItem[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Theme toggle handler
  const handleToggleTheme = () => {
    setIsDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem("docpilot_adm_theme", next ? "dark" : "light");
      return next;
    });
  };

  // Sidebar collapse toggle handler
  const handleToggleCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("docpilot_adm_sidebar_collapsed", next ? "true" : "false");
      return next;
    });
  };

  // Sign out handler
  const handleSignOut = () => {
    clearAdminToken();
    navigate("/admin");
  };

  // Load summary and overview data on token mount
  useEffect(() => {
    if (!token) return;
    let ignore = false;

    getAdminSummary()
      .then((sumRes) => {
        if (!ignore) setSummary(sumRes);
      })
      .catch((err: Error) => {
        if (!ignore) setAuthError(err.message);
      });

    // Also fetch audit logs for recent activity stream
    getAdminAudit(20)
      .then((logs) => {
        if (!ignore) setAuditLogs(logs);
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [token]);

  // Load view-specific data when tab or filters change
  useEffect(() => {
    if (!token) return;
    let ignore = false;

    queueMicrotask(() => {
      if (ignore) return;
      if (activeTab === "dashboard" || activeTab === "cases") setLoadingCases(true);
      if (activeTab === "audit") setLoadingAudit(true);
    });

    if (activeTab === "dashboard" || activeTab === "cases") {
      getAdminCustomers(activeSearch, CASES_PAGE_SIZE, casesPage * CASES_PAGE_SIZE, caseStatusFilter)
        .then((custRes) => {
          if (!ignore) {
            setCustomers(custRes.customers);
            setCasesTotalCount(custRes.totalCount ?? custRes.customers.length);
            setLoadingCases(false);
          }
        })
        .catch((err: Error) => {
          if (!ignore) {
            setAuthError(err.message);
            setLoadingCases(false);
          }
        });
    }

    if (activeTab === "reviews") {
      getAdminReviews("open")
        .then((items) => {
          if (!ignore) setReviews(items);
        })
        .catch((err: Error) => {
          if (!ignore) setAuthError(err.message);
        });
    } else if (activeTab === "audit") {
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
  }, [
    token,
    activeTab,
    activeSearch,
    caseStatusFilter,
    casesPage,
  ]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setCasesPage(0);
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


  const existingEmails = React.useMemo(() => {
    return new Set(customers.map((c) => c.email.toLowerCase().trim()));
  }, [customers]);

  const refreshCustomers = async () => {
    try {
      const [resCust, resSum] = await Promise.all([
        getAdminCustomers(activeSearch, CASES_PAGE_SIZE, casesPage * CASES_PAGE_SIZE, caseStatusFilter),
        getAdminSummary(),
      ]);
      setCustomers(resCust.customers);
      setCasesTotalCount(resCust.totalCount ?? resCust.customers.length);
      setSummary(resSum);
    } catch (err: unknown) {
      console.error("Failed to refresh customers", err);
    }
  };

  const handleCustomerCreated = (newCust: AdminCustomerListItem) => {
    setCustomers((prev) => [newCust, ...prev]);
    setCasesTotalCount((prev) => prev + 1);
    getAdminSummary().then((s) => setSummary(s)).catch(() => {});
  };

  const handleImportComplete = (_count: number) => {
    refreshCustomers();
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

      // Refresh summary
      getAdminSummary().then((s) => setSummary(s)).catch(() => {});
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

  // --- Render Login Form if unauthenticated ---
  if (!token) {
    return (
      <div className={`admin-dashboard-root ${isDarkMode ? "" : "admin-theme-light"}`} style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
        <div className="card" id="admin-login-card" style={{ maxWidth: 440, width: "100%", padding: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div className="brand-mark" style={{ width: 42, height: 42, borderRadius: 10 }}>
              <span className="brand-mark-inner" style={{ fontSize: 16 }}>DP</span>
            </div>
            <div>
              <h1 style={{ fontSize: 22, margin: 0 }}>DocPilot Admin</h1>
              <span className="mut" style={{ fontSize: 13 }}>Enterprise Document Operations</span>
            </div>
          </div>

          <p className="mut" style={{ fontSize: 14 }}>
            Enter your Supabase credentials to access the secure administrative console.
          </p>

          {authError && (
            <div className="msg err" role="alert" style={{ marginTop: 14 }}>
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
              placeholder="admin@docpilot.internal"
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
              <button
                type="submit"
                className="ok"
                disabled={signingIn}
                id="staff-login-btn"
                style={{ width: "100%", padding: "12px 18px", fontSize: 15 }}
              >
                {signingIn ? "Authenticating…" : "Sign in to Dashboard"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Helper to switch tabs
  const handleSelectTab = (newTab: AdminNavTab) => {
    startTransition(() => {
      setActiveTab(newTab);
    });
  };

  // --- Render Authenticated Admin Dashboard ---
  return (
    <div
      className={`admin-dashboard-root ${isDarkMode ? "" : "admin-theme-light"}`}
      id="admin-dashboard"
    >
      <div className="admin-shell">
        {/* Collapsible Sidebar */}
        <AdminSidebar
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleCollapse}
          isMobileOpen={sidebarMobileOpen}
          onCloseMobile={() => setSidebarMobileOpen(false)}
          openReviewsCount={summary?.open_reviews || 0}
          failedCount={(summary?.metrics?.ocr_failures || 0) + (summary?.jobs?.failed || 0)}
        />

        {/* Main Content View Container */}
        <div
          className={`admin-main-container ${
            sidebarCollapsed ? "sidebar-collapsed" : ""
          }`}
        >
          {/* Top Navigation */}
          <AdminTopNav
            activeTab={activeTab}
            onOpenMobile={() => setSidebarMobileOpen(true)}
            onAddCustomer={() => setShowAddDrawer(true)}
            isDarkMode={isDarkMode}
            onToggleTheme={handleToggleTheme}
            onSignOut={handleSignOut}
            adminEmail={getAdminEmail()}
            isSystemLive={true}
          />

          {/* Main Content Area */}
          <main className="admin-content">
            {/* Secondary / Test-Compatible Navigation Tabs */}
            <nav className="tabs" id="admin-nav-tabs" style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <button
                type="button"
                className={activeTab === "dashboard" ? "on" : ""}
                onClick={() => handleSelectTab("dashboard")}
                id="tab-btn-dashboard"
              >
                Dashboard
              </button>
              <button
                type="button"
                className={activeTab === "cases" ? "on" : ""}
                onClick={() => handleSelectTab("cases")}
                id="tab-btn-cases"
              >
                Customer cases
              </button>
              <button
                type="button"
                className={activeTab === "documents" ? "on" : ""}
                onClick={() => handleSelectTab("documents")}
                id="tab-btn-documents"
              >
                All documents {summary?.metrics?.total_documents ? `(${summary.metrics.total_documents})` : ""}
              </button>
              <button
                type="button"
                className={activeTab === "reviews" ? "on" : ""}
                onClick={() => handleSelectTab("reviews")}
                id="tab-btn-reviews"
              >
                Manual reviews {summary?.open_reviews ? `(${summary.open_reviews})` : ""}
              </button>
              <button
                type="button"
                className={activeTab === "audit" ? "on" : ""}
                onClick={() => handleSelectTab("audit")}
                id="tab-btn-audit"
              >
                Audit log
              </button>
              <button
                type="button"
                className={activeTab === "reports" ? "on" : ""}
                onClick={() => handleSelectTab("reports")}
                id="tab-btn-reports"
              >
                Reports
              </button>
              <button
                type="button"
                className={activeTab === "settings" ? "on" : ""}
                onClick={() => handleSelectTab("settings")}
                id="tab-btn-settings"
              >
                Settings
              </button>
            </nav>

            {/* --- TAB 0: DASHBOARD OVERVIEW --- */}
            {activeTab === "dashboard" && (
              <div id="tab-pane-dashboard">
                {/* 5 KPI Cards */}
                <KpiCardGrid
                  summary={summary}
                  activeFilter={caseStatusFilter}
                  onFilterCaseStatus={(status) => {
                    setCaseStatusFilter(status);
                    setCasesPage(0);
                    handleSelectTab("cases");
                  }}
                  onNavigateTab={(targetTab) => handleSelectTab(targetTab)}
                  onFilterDocFailed={() => {
                    handleSelectTab("documents");
                  }}
                />

                {/* SVG Visualizations Row: Verification Trend + Document Status */}
                <div className="charts-grid-row">
                  <VerificationTrendChart
                    auditLogs={auditLogs}
                    customers={customers}
                  />
                  <DocumentStatusChart summary={summary} />
                </div>

                {/* Bottom Grid: Live Recent Activity Stream + Recent Customer Cases */}
                <div className="dashboard-bottom-grid">
                  <RecentActivityFeed
                    logs={auditLogs}
                    onViewAllAudit={() => handleSelectTab("audit")}
                  />

                  {/* Recent Customer Cases */}
                  <div className="recent-cases-card">
                    <div className="activity-card-header">
                      <div className="activity-title-group">
                        <div className="activity-icon-box">
                          <IconUsers size={18} />
                        </div>
                        <div>
                          <h2 className="activity-title">Recent Customer Cases</h2>
                          <span className="activity-subtitle">
                            Latest active customer verification workflows
                          </span>
                        </div>
                      </div>
                    </div>

                    <div style={{ flex: 1, overflowX: "auto" }}>
                      {customers.length === 0 ? (
                        <p className="mut" style={{ padding: 16 }}>
                          No active customer cases found.
                        </p>
                      ) : (
                        <table style={{ width: "100%", fontSize: 13 }}>
                          <thead>
                            <tr>
                              <th>Customer</th>
                              <th>Status</th>
                              <th>Verified</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {customers.slice(0, 5).map((c) => (
                              <tr key={c.id}>
                                <td>
                                  <b>{c.name}</b>
                                  <div className="mut" style={{ fontSize: 11 }}>
                                    {c.code}
                                  </div>
                                </td>
                                <td>
                                  <span className={`tag ${c.case_status}`}>
                                    {c.case_status}
                                  </span>
                                </td>
                                <td>
                                  <span style={{ fontWeight: 600 }}>
                                    {c.received_count}/{c.required_count}
                                  </span>
                                </td>
                                <td>
                                  <Link
                                    to={`/admin/customers/${c.id}`}
                                    className="btn sec"
                                    style={{ padding: "3px 8px", fontSize: 12 }}
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

                    <div className="activity-card-footer">
                      <button
                        type="button"
                        className="activity-view-all-btn"
                        onClick={() => handleSelectTab("cases")}
                      >
                        View All Customers ({casesTotalCount}) →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* --- TAB 1: CASES (CUSTOMER DIRECTORY) --- */}
            {activeTab === "cases" && (
              <div id="tab-pane-cases">
                {/* KPI stats grid also rendered here for immediate filtering and test compatibility */}
                <KpiCardGrid
                  summary={summary}
                  activeFilter={caseStatusFilter}
                  onFilterCaseStatus={(status) => {
                    setCaseStatusFilter(status);
                    setCasesPage(0);
                  }}
                  onNavigateTab={(targetTab) => handleSelectTab(targetTab)}
                  onFilterDocFailed={() => {
                    handleSelectTab("documents");
                  }}
                />

                <AdminCustomersView
                  customers={customers}
                  totalCount={casesTotalCount}
                  loading={loadingCases}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchSubmit={handleSearch}
                  caseStatusFilter={caseStatusFilter}
                  onStatusFilterChange={(status) => {
                    setCaseStatusFilter(status);
                    setCasesPage(0);
                  }}
                  page={casesPage}
                  pageSize={CASES_PAGE_SIZE}
                  onPageChange={setCasesPage}
                  onResetFilters={() => {
                    setSearchQuery("");
                    setActiveSearch("");
                    setCaseStatusFilter("");
                    setCasesPage(0);
                  }}
                  onOpenAddCustomer={() => setShowAddDrawer(true)}
                  onOpenBulkImport={() => setShowBulkModal(true)}
                  onOpenCustomerDetail={(id) => setSelectedDetailCustomerId(id)}
                />
              </div>
            )}

            {/* --- TAB 2: ALL DOCUMENTS --- */}
            {activeTab === "documents" && (
              <AdminDocumentsView />
            )}


            {/* --- TAB 3: MANUAL REVIEWS --- */}
            {activeTab === "reviews" && (
              <div id="tab-pane-reviews">
                {reviews.length === 0 ? (
                  <div className="card mut" style={{ padding: 28, textAlign: "center" }}>
                    No pending documents require manual review.
                  </div>
                ) : (
                  reviews.map((r) => (
                    <div className="card" key={r.id} style={{ marginBottom: 16 }}>
                      <div className="row" style={{ alignItems: "flex-start" }}>
                        <div>
                          <b>
                            {r.customer_name}{" "}
                            <span className="mut">({r.customer_code})</span>
                          </b>
                          <div style={{ marginTop: 4, fontWeight: 600 }}>
                            {r.document.label}
                          </div>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                          }}
                        >
                          <span className="tag under_review">
                            Status: {r.document.verification_status || "requires_review"}
                          </span>
                          {r.resubmission_status && (
                            <span
                              className="tag"
                              style={{
                                background: "var(--info-bg)",
                                color: "var(--info)",
                                borderColor: "var(--info-border)",
                              }}
                            >
                              Resubmission:{" "}
                              {r.resubmission_status === "eligible_for_resubmission"
                                ? "Eligible"
                                : r.resubmission_status}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Review Reason & Flags */}
                      <div
                        style={{
                          marginTop: 12,
                          padding: "10px 14px",
                          background: "var(--warn-bg)",
                          border: "1px solid var(--warn-border)",
                          borderRadius: "6px",
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 600,
                            color: "var(--warn)",
                            fontSize: "13px",
                          }}
                        >
                          Review Trigger Reason:
                        </div>
                        <div
                          style={{
                            color: "var(--ink)",
                            fontSize: "14px",
                            marginTop: 2,
                          }}
                        >
                          {r.reason || "Confidence below auto-verification threshold"}
                        </div>
                        {r.flags && r.flags.length > 0 && (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: "12px",
                              display: "flex",
                              gap: "6px",
                              flexWrap: "wrap",
                              alignItems: "center",
                            }}
                          >
                            <span style={{ fontWeight: 600, color: "var(--mut)" }}>
                              Flags: {r.flags.join(", ")}
                            </span>
                            {r.flags.map((flag, idx) => (
                              <span
                                key={idx}
                                className="tag bad"
                                style={{ fontSize: "11px", padding: "1px 6px" }}
                              >
                                {flag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Masked OCR Evidence (Privacy Protected) */}
                      <div
                        style={{
                          marginTop: 12,
                          border: "1px solid var(--line)",
                          borderRadius: "6px",
                          background: "var(--card-subtle)",
                          padding: "12px 14px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 8,
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: "13px" }}>
                            Masked OCR Evidence (Privacy Protected)
                          </span>
                          {r.ocr_evidence?.confidence !== undefined && (
                            <span style={{ fontSize: "12px", color: "var(--mut)" }}>
                              Confidence:{" "}
                              <b>
                                {(Number(r.ocr_evidence.confidence) * 100).toFixed(0)}%
                              </b>
                            </span>
                          )}
                        </div>

                        {r.ocr_evidence ? (
                          <div>
                            {r.ocr_evidence.pii_detected &&
                              r.ocr_evidence.pii_detected.length > 0 && (
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "6px",
                                    marginBottom: 8,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  {r.ocr_evidence.pii_detected.map(
                                    (p: string, idx: number) => (
                                      <span
                                        key={idx}
                                        className="tag"
                                        style={{
                                          fontSize: "11px",
                                          background: "var(--acc-bg)",
                                          color: "var(--acc)",
                                          borderColor: "var(--acc-border)",
                                        }}
                                      >
                                        🛡️ {p} Redacted
                                      </span>
                                    )
                                  )}
                                </div>
                              )}

                            {r.ocr_evidence.extracted_fields &&
                            Object.keys(r.ocr_evidence.extracted_fields).length > 0 ? (
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns:
                                    "repeat(auto-fit, minmax(200px, 1fr))",
                                  gap: "8px",
                                  background: "var(--card)",
                                  padding: "8px 12px",
                                  borderRadius: "4px",
                                  border: "1px solid var(--line)",
                                }}
                              >
                                {Object.entries(r.ocr_evidence.extracted_fields).map(
                                  ([k, v]) => (
                                    <div key={k} style={{ fontSize: "12px" }}>
                                      <span
                                        className="mut"
                                        style={{ textTransform: "capitalize" }}
                                      >
                                        {k.replace(/_/g, " ")}:{" "}
                                      </span>
                                      <code style={{ fontWeight: 600 }}>
                                        {String(v ?? "—")}
                                      </code>
                                    </div>
                                  )
                                )}
                              </div>
                            ) : (
                              <div className="mut" style={{ fontSize: "12px" }}>
                                No extracted fields in OCR evidence payload.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="mut" style={{ fontSize: "12px" }}>
                            No OCR evidence available yet.
                          </div>
                        )}
                      </div>

                      <p className="mut" style={{ fontSize: 12, marginTop: 8 }}>
                        Queued: {new Date(r.created_at).toLocaleString()}
                      </p>

                      <div style={{ margin: "14px 0" }}>
                        <label htmlFor={`review-note-${r.id}`}>
                          Reviewer note (optional)
                        </label>
                        <input
                          id={`review-note-${r.id}`}
                          placeholder="Enter reason or approval notes"
                          value={reviewNotes[r.id] || ""}
                          onChange={(e) =>
                            setReviewNotes({ ...reviewNotes, [r.id]: e.target.value })
                          }
                        />
                      </div>

                      <div
                        className="row"
                        style={{ justifyContent: "flex-start", gap: 10 }}
                      >
                        <button
                          type="button"
                          className="sec"
                          onClick={() => handleSecureView(r.document.id)}
                          id={`btn-review-view-${r.id}`}
                        >
                          <IconEye size={14} /> Secure view
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

            {/* --- TAB 4: AUDIT LOG --- */}
            {activeTab === "audit" && (
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

            {/* --- TAB 5: REPORTS & ANALYTICS --- */}
            {activeTab === "reports" && <AdminReportsView summary={summary} />}

            {/* --- TAB 6: SETTINGS & POLICIES --- */}
            {activeTab === "settings" && <AdminSettingsView />}
          </main>
        </div>
      </div>

      {/* Add Customer Drawer */}
      <AddCustomerDrawer
        isOpen={showAddDrawer}
        onClose={() => setShowAddDrawer(false)}
        onCustomerCreated={handleCustomerCreated}
        existingEmails={existingEmails}
      />

      {/* Bulk Excel Import Modal */}
      <BulkImportModal
        isOpen={showBulkModal}
        onClose={() => setShowBulkModal(false)}
        onImportComplete={handleImportComplete}
        existingEmails={existingEmails}
      />

      {/* Customer Quick Detail Drawer */}
      <CustomerDetailDrawer
        customerId={selectedDetailCustomerId}
        isOpen={selectedDetailCustomerId !== null}
        onClose={() => setSelectedDetailCustomerId(null)}
        onSecureView={handleSecureView}
        onCustomerUpdated={refreshCustomers}
      />

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
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(6px)",
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
              maxWidth: 920,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              padding: 20,
              background: "var(--adm-card, #ffffff)",
              borderRadius: 12,
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
            }}
          >
            <div
              className="row"
              style={{ justifyContent: "space-between", marginBottom: 12 }}
            >
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
            <div
              style={{
                flex: 1,
                overflow: "auto",
                minHeight: 480,
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                background: "#0a0a0a",
                borderRadius: 8,
              }}
            >
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
