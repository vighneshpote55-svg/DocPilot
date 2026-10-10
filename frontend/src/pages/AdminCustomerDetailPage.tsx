import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  getAdminCustomer,
  getAdminAudit,
  closeAdminCase,
  deleteAdminCustomerData,
  deleteAdminDocumentFile,
  resendConsentEmail,
  resendUploadLink,
  fetchDocumentFile,
  getAdminToken,
} from "../api";
import type { AdminCustomerDetail, AdminDocumentItem, AdminAuditItem } from "../types";
import { useDialogA11y } from "../utils/a11yUtils";
import { AdminSidebar } from "../components/admin/AdminSidebar";
import { AdminTopNav } from "../components/admin/AdminTopNav";
import { SecureDocViewerModal } from "../components/admin/SecureDocViewerModal";
import { DocumentDetailsDrawer } from "../components/admin/DocumentDetailsDrawer";
import {
  IconCheck,
  IconAlertTriangle,
  IconAlertCircle,
  IconBell,
  IconClock,
  IconShieldCheck,
  IconMail,
  IconPhone,
  IconCopy,
  IconEye,
  IconTrash2,
  IconRefreshCw,
  IconSearch,
  IconSend,
  IconFileText,
  IconChevronRight,
  IconHistory,
  IconArchive,
  IconInfo,
} from "../components/admin/AdminIcons";
import { computeCustomerReminderState } from "../utils/reminderUtils";

import {
  computeRetentionInfo,
  filterRetentionAuditEvents,
  formatRetentionDateTime,
} from "../utils/retentionUtils";


export const AdminCustomerDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Auth & Session
  const [adminEmail] = useState<string>(() => {
    try {
      const raw = localStorage.getItem("docpilot_admin_session");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.email) return s.email;
      }
    } catch {}
    return "admin@docpilot.internal";
  });
  const [adminName] = useState<string>(() => {
    try {
      const raw = localStorage.getItem("docpilot_admin_session");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.name) return s.name;
      }
    } catch {}
    return "Staff Admin";
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("docpilot_admin_theme") as "dark" | "light") ||
      (localStorage.getItem("docpilot_adm_theme") as "dark" | "light") ||
      "dark";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [now] = useState<number>(() => Date.now());

  // Customer Data & State
  const [customer, setCustomer] = useState<AdminCustomerDetail | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busyAction, setBusyAction] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Document Filtering
  const [docSearch, setDocSearch] = useState<string>("");
  const [docStatusFilter, setDocStatusFilter] = useState<string>("all");

  // Modals & Drawers
  const [viewerDoc, setViewerDoc] = useState<{ id: string; label: string; filename: string } | null>(null);
  const [inspectDoc, setInspectDoc] = useState<AdminDocumentItem | null>(null);

  // Phase 6: Privacy & Lifecycle Action Modals
  const [showCloseCaseModal, setShowCloseCaseModal] = useState<boolean>(false);
  const [closeCaseReason, setCloseCaseReason] = useState<string>("");
  const [showDeleteDataModal, setShowDeleteDataModal] = useState<boolean>(false);
  const [confirmDeleteChecked, setConfirmDeleteChecked] = useState<boolean>(false);
  const [privacyAuditOnly, setPrivacyAuditOnly] = useState<boolean>(false);

  // Modal Accessibility Hooks (WCAG AA Focus & Escape)
  const closeCaseModalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(showCloseCaseModal && !busyAction, () => setShowCloseCaseModal(false), closeCaseModalRef, {
    initialFocusSelector: "#btn-cancel-close-case",
  });

  const deleteDataModalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(showDeleteDataModal && !busyAction, () => setShowDeleteDataModal(false), deleteDataModalRef, {
    initialFocusSelector: "#btn-cancel-delete-data",
  });

  // Guard & Hydrate Admin Session
  useEffect(() => {
    const raw = localStorage.getItem("docpilot_admin_session");
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (s.token && !getAdminToken()) {
          sessionStorage.setItem("docpilot_staff_jwt", s.token);
        }
      } catch {}
    } else if (!getAdminToken()) {
      navigate("/admin");
    }
  }, [navigate]);

  // Sync theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "light") {
      document.documentElement.classList.add("admin-theme-light");
    } else {
      document.documentElement.classList.remove("admin-theme-light");
    }
    localStorage.setItem("docpilot_admin_theme", theme);
    localStorage.setItem("docpilot_adm_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const handleSignOut = () => {
    localStorage.removeItem("docpilot_admin_session");
    navigate("/admin");
  };

  // Load customer data
  const loadCustomer = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getAdminCustomer(Number(id));
      setCustomer(Array.isArray(data) ? data[0] : data);
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load customer details.");
      setLoading(false);
    }
  }, [id]);

  // Load audit logs
  const loadAudit = useCallback(async () => {
    try {
      const logs = await getAdminAudit(200);
      setAuditLogs(logs || []);
    } catch {
      // Audit log failures should not block customer view
    }
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [id]);

  useEffect(() => {
    queueMicrotask(() => {
      loadCustomer();
      loadAudit();
    });
  }, [loadCustomer, loadAudit]);

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleAction = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusyAction(true);
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ text: successMsg, ok: true });
      setBusyAction(false);
      loadCustomer();
      loadAudit();
    } catch (err: unknown) {
      setActionMsg({
        text: err instanceof Error ? err.message : "Action failed.",
        ok: false,
      });
      setBusyAction(false);
    }
  };

  const handleDeleteFile = async (docId: string) => {
    if (!confirm("Are you sure you want to permanently delete the stored encrypted file for this document?")) {
      return;
    }
    await handleAction(() => deleteAdminDocumentFile(docId), "Encrypted file deleted permanently.");
    if (inspectDoc && inspectDoc.id === docId) {
      setInspectDoc(null);
    }
  };

  const handleDownload = async (docId: string, filename: string) => {
    try {
      const blob = await fetchDocumentFile(docId, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to download document file.");
    }
  };

  // Filter audit logs for this customer and customer's documents
  const customerAuditLogs = useMemo(() => {
    if (!customer) return [];
    const docIds = new Set((customer.documents || []).map((d) => d.id));
    return auditLogs.filter((a) => {
      if (a.entity_id === String(customer.id)) return true;
      if (a.details && (a.details.customer_id === customer.id || a.details.customer_code === customer.code)) return true;
      if (a.entity_id && docIds.has(a.entity_id)) return true;
      return false;
    });
  }, [customer, auditLogs]);

  // Filter uploaded documents
  const filteredDocuments = useMemo(() => {
    if (!customer || !customer.documents) return [];
    return customer.documents.filter((d) => {
      const matchesSearch =
        !docSearch.trim() ||
        d.label.toLowerCase().includes(docSearch.toLowerCase()) ||
        d.filename.toLowerCase().includes(docSearch.toLowerCase()) ||
        d.doc_type.toLowerCase().includes(docSearch.toLowerCase());

      if (!matchesSearch) return false;

      if (docStatusFilter === "all") return true;
      if (docStatusFilter === "verified") return d.verification_status === "verified";
      if (docStatusFilter === "review") return d.verification_status === "manual_review" || d.verification_status === "under_review";
      if (docStatusFilter === "rejected") return d.verification_status === "rejected";
      if (docStatusFilter === "processing") return d.ocr_status === "processing" || d.ocr_status === "waiting";
      if (docStatusFilter === "superseded") return d.superseded === true;
      return true;
    });
  }, [customer, docSearch, docStatusFilter]);

  // Calculate retention countdown text
  const retentionCountdown = useMemo(() => {
    if (!customer || !customer.delete_after) return null;
    const diffMs = new Date(customer.delete_after).getTime() - now;
    if (diffMs <= 0) return "Purge overdue / pending execution";
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d ${hours}h remaining`;
    return `${hours} hours remaining`;
  }, [customer, now]);

  // Phase 6: Calculate retention timeline percentage (7-day window)
  const retentionProgressPercent = useMemo(() => {
    if (!customer || !customer.delete_after) return 0;
    const target = new Date(customer.delete_after).getTime();
    const totalRetentionMs = 7 * 24 * 60 * 60 * 1000;
    const remainingMs = target - now;
    if (remainingMs <= 0) return 100;
    const elapsedMs = Math.max(0, totalRetentionMs - remainingMs);
    return Math.min(100, Math.round((elapsedMs / totalRetentionMs) * 100));
  }, [customer, now]);

  // Phase 7: Compute 3/7/14-day reminder state
  const reminderState = useMemo(() => {
    if (!customer) return null;
    return computeCustomerReminderState(customer, auditLogs);
  }, [customer, auditLogs]);

  // Phase 8: Compute retention info & pending data inventory
  const retentionInfo = useMemo(() => {
    if (!customer) return null;
    return computeRetentionInfo(customer, customer.documents || []);
  }, [customer]);

  // Phase 8: Filter customer-specific retention & deletion audit logs
  const customerRetentionAuditLogs = useMemo(() => {
    if (!customer) return [];
    return filterRetentionAuditEvents(customerAuditLogs, customer.id);
  }, [customer, customerAuditLogs]);


  // Phase 6: Privacy & Consent Audit Filter
  const privacyAuditLogs = useMemo(() => {
    return customerAuditLogs.filter((a) => {
      const act = (a.action || "").toLowerCase();
      return (
        act.includes("consent") ||
        act.includes("privacy") ||
        act.includes("delete") ||
        act.includes("close")
      );
    });
  }, [customerAuditLogs]);

  const displayedAuditLogs = privacyAuditOnly ? privacyAuditLogs : customerAuditLogs;

  return (
    <div className={`admin-dashboard-root ${theme === "light" ? "admin-theme-light" : ""}`}>
      {/* Sidebar */}
      <AdminSidebar
        activeTab="cases"
        onSelectTab={(tab) => {
          if (tab === "cases") navigate("/admin/customers");
          else if (tab === "documents") navigate("/admin");
          else navigate(`/admin`);
        }}
        openReviewsCount={0}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        isMobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className={`admin-main-container ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        {/* Top Navigation */}
        <AdminTopNav
          activeTab="cases"
          customTitle="Customer Case Details"
          customSubtitle={customer ? `${customer.name} (${customer.code})` : "Case inspection & documents"}
          adminEmail={adminEmail}
          adminName={adminName}
          isDarkMode={theme === "dark"}
          onToggleTheme={toggleTheme}
          onSignOut={handleSignOut}
          onOpenMobile={() => setMobileMenuOpen(true)}
        />

        {/* Content Area */}
        <main className="admin-content" id="main-content">
          <div className="customer-detail-page-layout" id="customer-detail-page">
            {/* Breadcrumbs */}
            <div className="customer-detail-breadcrumbs">
              <Link to="/admin" className="breadcrumb-link">
                Dashboard
              </Link>
              <IconChevronRight size={13} />
              <Link to="/admin/customers" className="breadcrumb-link">
                Customers
              </Link>
              <IconChevronRight size={13} />
              <span className="breadcrumb-active">
                {customer ? `${customer.name} (${customer.code})` : "Case Details"}
              </span>
            </div>

            {loading ? (
              <div className="admin-table-card" style={{ padding: 60, textAlign: "center" }}>
                <div className="spinner" style={{ margin: "0 auto 16px" }} />
                <p style={{ color: "var(--adm-text-secondary)", fontSize: 15 }}>
                  Loading customer case details and documents...
                </p>
              </div>
            ) : error || !customer ? (
              <div className="admin-table-card" style={{ padding: 40, textAlign: "center" }}>
                <IconAlertCircle size={40} color="var(--adm-danger)" style={{ margin: "0 auto 12px" }} />
                <h3 style={{ color: "var(--adm-text)", margin: "0 0 8px" }}>Customer Not Found</h3>
                <p style={{ color: "var(--adm-text-secondary)", marginBottom: 20 }}>
                  {error || "The requested customer case record does not exist or has been permanently purged."}
                </p>
                <Link to="/admin/customers" className="btn pri">
                  ← Back to Customer Directory
                </Link>
              </div>
            ) : (
              <>
                {/* Action Feedback Banner */}
                {actionMsg && (
                  <div
                    className={`msg ${actionMsg.ok ? "ok" : "err"}`}
                    role="alert"
                    style={{ marginBottom: 4 }}
                  >
                    {actionMsg.ok ? <IconCheck size={16} /> : <IconAlertCircle size={16} />}
                    <span>{actionMsg.text}</span>
                  </div>
                )}

                {/* 1. CUSTOMER PROFILE HERO CARD */}
                <div className="customer-profile-hero">
                  <div className="profile-hero-top">
                    <div className="profile-avatar-wrap">
                      <div className="profile-avatar">
                        {(customer.name || "Customer")
                          .split(" ")
                          .filter(Boolean)
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase() || "CU"}
                      </div>
                      <div>
                        <h2 className="profile-name">{customer.name}</h2>
                        <button
                          type="button"
                          className="profile-code-copy"
                          onClick={() => handleCopyCode(customer.code)}
                          title="Click to copy case identifier"
                        >
                          <IconCopy size={12} />
                          <span>{customer.code}</span>
                          {copiedCode && <span style={{ color: "var(--adm-success)" }}>• Copied!</span>}
                        </button>
                      </div>
                    </div>

                    <div className="profile-status-badges">
                      <span className={`status-pill case-${customer.case_status || "in_progress"}`}>
                        {customer.case_status === "completed" && <IconCheck size={12} />}
                        {customer.case_status === "in_progress" && <IconClock size={12} />}
                        {customer.case_status === "deleted" && <IconArchive size={12} />}
                        Case: {(customer.case_status || "in_progress").replace("_", " ")}
                      </span>

                      <span className={`status-pill consent-${customer.consent_status || "pending"}`}>
                        <IconShieldCheck size={12} />
                        Consent: {customer.consent_status || "pending"}
                      </span>
                    </div>
                  </div>

                  {/* Profile Meta Info Grid */}
                  <div className="profile-meta-grid">
                    <div className="profile-meta-item">
                      <span className="profile-meta-label">Email Address</span>
                      <span className="profile-meta-value font-mono">
                        <IconMail size={13} style={{ display: "inline", marginRight: 4, verticalAlign: "-2px" }} />
                        {customer.email}
                      </span>
                    </div>

                    <div className="profile-meta-item">
                      <span className="profile-meta-label">Mobile Number</span>
                      <span className="profile-meta-value font-mono">
                        <IconPhone size={13} style={{ display: "inline", marginRight: 4, verticalAlign: "-2px" }} />
                        {customer.mobile || "Not specified"}
                      </span>
                    </div>

                    <div className="profile-meta-item">
                      <span className="profile-meta-label">Created At</span>
                      <span className="profile-meta-value">
                        {new Date(customer.created_at).toLocaleString()}
                      </span>
                    </div>

                    <div className="profile-meta-item">
                      <span className="profile-meta-label">Completed At</span>
                      <span className="profile-meta-value">
                        {customer.completed_at ? new Date(customer.completed_at).toLocaleString() : "Pending completion"}
                      </span>
                    </div>
                  </div>

                  {/* Phase 6: Consent Withdrawn Notice Banner */}
                  {customer.consent_status === "withdrawn" && (
                    <div className="retention-countdown-banner" style={{ background: "rgba(245, 158, 11, 0.1)", borderColor: "rgba(245, 158, 11, 0.35)", marginBottom: 14 }}>
                      <div className="retention-banner-text">
                        <IconAlertTriangle size={16} color="#f59e0b" />
                        <span>
                          <b>Consent Withdrawn by Customer:</b> Under India DPDP Act 2023, automated verification pipelines, reminder schedulers, and active links have been halted.
                        </span>
                      </div>
                      <span className="retention-countdown-pill" style={{ background: "rgba(245, 158, 11, 0.2)", color: "#fbbf24" }}>
                        Consent Withdrawn
                      </span>
                    </div>
                  )}

                  {/* Phase 8: Data Retention & Cryptographic Deletion Section */}
                  <div className="customer-retention-section" id="customer-retention-section">
                    <div className="customer-retention-top">
                      <div className="customer-retention-title-row">
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: "rgba(59, 130, 246, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#60a5fa" }}>
                          <IconArchive size={18} />
                        </div>
                        <div>
                          <h3 style={{ margin: 0, fontSize: 16 }}>Data Retention & Cryptographic Erasure</h3>
                          <span className="mut" style={{ fontSize: 12 }}>
                            Statutory 7-day retention countdown, data wipe inventory, and permanent erasure controls
                          </span>
                        </div>
                      </div>

                      {customer.data_deleted_at ? (
                        <span className="retention-state-pill deleted">
                          <IconCheck size={12} /> Permanently Purged
                        </span>
                      ) : customer.delete_after ? (
                        <span className={`retention-state-pill ${retentionProgressPercent > 80 ? "due" : "scheduled"}`}>
                          <IconClock size={12} /> {retentionProgressPercent > 80 ? "Due for Purge" : "In 7-Day Retention"}
                        </span>
                      ) : (
                        <span className="retention-state-pill" style={{ background: "rgba(148, 163, 184, 0.15)", color: "#94a3b8" }}>
                          Active Intake
                        </span>
                      )}
                    </div>

                    {/* Retention Countdown Banner with Progress Meter (Preserving IDs for Phase 6 test suite) */}
                    {customer.data_deleted_at ? (
                      <div className="retention-countdown-banner deleted" id="retention-purged-panel">
                        <div className="retention-banner-text">
                          <IconArchive size={16} color="var(--adm-danger)" />
                          <span>
                            <b>Data Permanently Purged:</b> Customer documents and PII were deleted on{" "}
                            {new Date(customer.data_deleted_at).toLocaleString()} in compliance with 7-day privacy retention policy.
                          </span>
                        </div>
                        <span className="retention-countdown-pill">Purged</span>
                      </div>
                    ) : customer.delete_after ? (
                      <div className="retention-countdown-banner" id="retention-countdown-panel">
                        <div style={{ width: "100%" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <div className="retention-banner-text">
                              <IconClock size={16} color="var(--adm-primary)" />
                              <span>
                                <b>Retention Deletion Policy:</b> Scheduled for automatic permanent purge on{" "}
                                {new Date(customer.delete_after).toLocaleString()}
                              </span>
                            </div>
                            <span className="retention-countdown-pill">
                              {retentionCountdown}
                            </span>
                          </div>
                          <div className="retention-progress-track">
                            <div
                              className={`retention-progress-bar ${retentionProgressPercent > 80 ? "urgent" : ""}`}
                              style={{ width: `${retentionProgressPercent}%` }}
                            />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--adm-text-muted)" }}>
                            <span>Elapsed: {retentionProgressPercent}%</span>
                            <span>Auto-Purge Window: 7 Days</span>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* 5-Step Completed-Case Retention Lifecycle Stepper */}
                    <div style={{ padding: "14px 18px", background: "rgba(15, 23, 42, 0.4)", borderRadius: 10, border: "1px solid rgba(255, 255, 255, 0.05)" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--adm-text-muted)" }}>
                        Statutory 7-Day Lifecycle Progression
                      </span>

                      <div className="retention-lifecycle-stepper">
                        <div className={`retention-stepper-node ${customer.case_status === "completed" || customer.consent_status === "withdrawn" ? "completed" : "active"}`}>
                          <div className="retention-node-circle">
                            <IconCheck size={14} />
                          </div>
                          <span className="retention-node-label">Case Closed</span>
                        </div>

                        <div className={`retention-stepper-node ${customer.delete_after ? "completed" : ""}`}>
                          <div className="retention-node-circle">
                            <IconClock size={14} />
                          </div>
                          <span className="retention-node-label">7-Day Lock</span>
                        </div>

                        <div className={`retention-stepper-node ${customer.delete_after && !customer.data_deleted_at && retentionProgressPercent < 100 ? "active" : customer.data_deleted_at || retentionProgressPercent >= 100 ? "completed" : ""}`}>
                          <div className="retention-node-circle">
                            <IconShieldCheck size={14} />
                          </div>
                          <span className="retention-node-label">Audited Grace</span>
                        </div>

                        <div className={`retention-stepper-node ${customer.delete_after && retentionProgressPercent >= 100 && !customer.data_deleted_at ? "active" : customer.data_deleted_at ? "completed" : ""}`}>
                          <div className="retention-node-circle">
                            <IconTrash2 size={14} />
                          </div>
                          <span className="retention-node-label">Auto-Purge</span>
                        </div>

                        <div className={`retention-stepper-node ${customer.data_deleted_at ? "purged" : ""}`}>
                          <div className="retention-node-circle">
                            <IconCheck size={14} />
                          </div>
                          <span className="retention-node-label">Ledger Proof</span>
                        </div>
                      </div>
                    </div>

                    {/* Retention Metrics & Pending Data Grid */}
                    <div className="customer-retention-grid">
                      <div className="customer-retention-stat-card">
                        <span className="mut" style={{ fontSize: 11, textTransform: "uppercase" }}>Scheduled Erasure Date</span>
                        <span style={{ fontSize: 13, fontWeight: 700 }} id="val-scheduled-deletion">
                          {customer.delete_after ? new Date(customer.delete_after).toLocaleString() : "Not scheduled"}
                        </span>
                        <span className="mut" style={{ fontSize: 11 }}>
                          {customer.delete_after ? formatRetentionDateTime(customer.delete_after).utc : "Case still in progress"}
                        </span>
                      </div>

                      <div className="customer-retention-stat-card">
                        <span className="mut" style={{ fontSize: 11, textTransform: "uppercase" }}>Retention Countdown</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: retentionProgressPercent > 80 ? "#fbbf24" : "inherit" }} id="val-retention-remaining">
                          {retentionCountdown || (customer.data_deleted_at ? "Purged" : "Active Intake")}
                        </span>
                        <span className="mut" style={{ fontSize: 11 }}>
                          Policy: 7 Days after completion
                        </span>
                      </div>

                      <div className="customer-retention-stat-card" id="customer-retention-inventory">
                        <span className="mut" style={{ fontSize: 11, textTransform: "uppercase" }}>Data & Document Inventory</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
                          {customer.data_deleted_at ? (
                            <span className="inventory-pill wiped">All Storage Ciphertext Wiped</span>
                          ) : (
                            <>
                              <span className="inventory-pill active">
                                {retentionInfo?.pendingInventory.storedFilesCount || 0} file{(retentionInfo?.pendingInventory.storedFilesCount || 0) === 1 ? "" : "s"} stored
                              </span>
                              <span className="inventory-pill">
                                {customer.documents.length} OCR caches
                              </span>
                              <span className="inventory-pill">
                                {customer.consent_status === "withdrawn" ? "Tokens revoked" : "Tokens active"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Customer-Specific Deletion & Retention Audit Trail */}
                    {customerRetentionAuditLogs.length > 0 && (
                      <div style={{ marginTop: 6 }} id="customer-retention-audit-trail">
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--adm-text)" }}>
                          Recent Retention & Deletion Ledger Events ({customerRetentionAuditLogs.length})
                        </span>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                          {customerRetentionAuditLogs.slice(0, 3).map((evt) => (
                            <div
                              key={evt.id}
                              style={{
                                padding: "8px 12px",
                                borderRadius: 6,
                                background: "rgba(15, 23, 42, 0.5)",
                                border: "1px solid rgba(255, 255, 255, 0.05)",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                fontSize: 12,
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span className="tag" style={{ fontSize: 11, background: "rgba(239, 68, 68, 0.15)", color: "#f87171" }}>
                                  {evt.action}
                                </span>
                                <span>Actor: <b>{evt.actor}</b></span>
                              </div>
                              <span className="mut" style={{ fontSize: 11 }}>
                                {new Date(evt.at).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Permanent Purge Trigger Button */}
                    {!customer.data_deleted_at && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                        <button
                          type="button"
                          id="btn-customer-retention-purge"
                          className="btn"
                          style={{
                            background: "rgba(239, 68, 68, 0.15)",
                            borderColor: "rgba(239, 68, 68, 0.4)",
                            color: "#f87171",
                            fontSize: 12,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                          onClick={() => setShowDeleteDataModal(true)}
                        >
                          <IconTrash2 size={13} /> Execute Immediate Permanent Purge
                        </button>

                      </div>
                    )}
                  </div>


                  {/* Customer Lifecycle Action Toolbar */}
                  <div className="customer-actions-toolbar">
                    {customer.consent_status === "pending" && (
                      <button
                        type="button"
                        className="btn sec"
                        disabled={busyAction}
                        onClick={() =>
                          handleAction(
                            () => resendConsentEmail(customer.id),
                            "Consent email resent successfully."
                          )
                        }
                      >
                        <IconMail size={14} /> Resend Consent Email
                      </button>
                    )}

                    {customer.case_status === "in_progress" && customer.consent_status === "granted" && (
                      <button
                        type="button"
                        className="btn sec"
                        disabled={busyAction}
                        onClick={() =>
                          handleAction(
                            () => resendUploadLink(customer.id),
                            "Upload link email resent successfully."
                          )
                        }
                      >
                        <IconMail size={14} /> Resend Upload Link
                      </button>
                    )}

                    {customer.case_status === "in_progress" && (
                      <button
                        type="button"
                        className="btn sec"
                        disabled={busyAction}
                        onClick={() => {
                          setCloseCaseReason("");
                          setShowCloseCaseModal(true);
                        }}
                        id="btn-trigger-close-case"
                      >
                        Close Case
                      </button>
                    )}

                    {customer.case_status !== "deleted" && (
                      <button
                        type="button"
                        className="btn bad"
                        disabled={busyAction}
                        onClick={() => {
                          setConfirmDeleteChecked(false);
                          setShowDeleteDataModal(true);
                        }}
                        id="btn-trigger-delete-data"
                      >
                        <IconTrash2 size={14} /> Delete Customer Data
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn sec"
                      onClick={() => {
                        loadCustomer();
                        loadAudit();
                      }}
                      title="Reload latest case status"
                      style={{ marginLeft: "auto" }}
                    >
                      <IconRefreshCw size={14} /> Refresh
                    </button>
                  </div>
                </div>

                {/* 1.5 PHASE 7: AUTOMATED REMINDERS & NOTIFICATION STATUS */}
                {reminderState && (
                  <div className="customer-reminders-card" id="customer-reminders-panel">
                    <div className="customer-reminders-header">
                      <div className="customer-reminders-title-group">
                        <IconBell size={18} color="var(--adm-primary, #60a5fa)" />
                        <h3>Automated Reminders &amp; Schedule (3 / 7 / 14 Days)</h3>
                      </div>
                      <div>
                        {reminderState.overallStatus === "active" ? (
                          <span className="reminder-status-pill active" id="badge-reminder-status">
                            <span className="status-beacon live" style={{ width: 6, height: 6 }} />
                            <span>Active (3/7/14-Day Cycle)</span>
                          </span>
                        ) : reminderState.overallStatus === "stopped_completed" ? (
                          <span className="reminder-status-pill stopped-completed" id="badge-reminder-status">
                            <IconCheck size={12} />
                            <span>Reminders Stopped • All Documents Verified</span>
                          </span>
                        ) : reminderState.overallStatus === "stopped_withdrawn" ? (
                          <span className="reminder-status-pill stopped-withdrawn" id="badge-reminder-status">
                            <IconAlertTriangle size={12} />
                            <span>Reminders Stopped • Consent Withdrawn</span>
                          </span>
                        ) : reminderState.overallStatus === "awaiting_consent" ? (
                          <span className="reminder-status-pill awaiting" id="badge-reminder-status">
                            <IconClock size={12} />
                            <span>Reminders Paused • Awaiting Consent</span>
                          </span>
                        ) : (
                          <span className="reminder-status-pill completed-schedule" id="badge-reminder-status">
                            <span>Schedule Completed</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 3 / 7 / 14-Day Milestone Stepper */}
                    <div
                      style={{
                        background: "rgba(15, 23, 42, 0.4)",
                        border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                        borderRadius: 10,
                        padding: "14px 18px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: 12,
                      }}
                      id="customer-reminder-stepper"
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--adm-text-secondary, #94a3b8)", textTransform: "uppercase" }}>
                          Milestone Progression:
                        </span>
                        <div className="reminder-stepper">
                          {/* Day 3 */}
                          <span
                            className={`stepper-node ${reminderState.stages.stage3.status}`}
                            id="customer-stepper-stage3"
                          >
                            {reminderState.stages.stage3.status === "sent" ? (
                              <IconCheck size={12} />
                            ) : reminderState.stages.stage3.status === "scheduled" ? (
                              <IconClock size={12} />
                            ) : (
                              <span>•</span>
                            )}
                            <span>Day 3</span>
                          </span>

                          <span className={`stepper-line ${reminderState.stages.stage3.status === "sent" ? "active" : ""}`} />

                          {/* Day 7 */}
                          <span
                            className={`stepper-node ${reminderState.stages.stage7.status}`}
                            id="customer-stepper-stage7"
                          >
                            {reminderState.stages.stage7.status === "sent" ? (
                              <IconCheck size={12} />
                            ) : reminderState.stages.stage7.status === "scheduled" ? (
                              <IconClock size={12} />
                            ) : (
                              <span>•</span>
                            )}
                            <span>Day 7</span>
                          </span>

                          <span className={`stepper-line ${reminderState.stages.stage7.status === "sent" ? "active" : ""}`} />

                          {/* Day 14 */}
                          <span
                            className={`stepper-node ${reminderState.stages.stage14.status}`}
                            id="customer-stepper-stage14"
                          >
                            {reminderState.stages.stage14.status === "sent" ? (
                              <IconCheck size={12} />
                            ) : reminderState.stages.stage14.status === "scheduled" ? (
                              <IconClock size={12} />
                            ) : (
                              <span>•</span>
                            )}
                            <span>Day 14 Final</span>
                          </span>
                        </div>
                      </div>

                      {reminderState.overallStatus === "active" && (
                        <button
                          type="button"
                          className="consent-btn-accept"
                          style={{ fontSize: 12, padding: "6px 14px" }}
                          disabled={busyAction}
                          onClick={() =>
                            handleAction(
                              () => resendUploadLink(customer.id),
                              "Upload link and reminder dispatched to customer."
                            )
                          }
                          id="btn-customer-resend-reminder"
                        >
                          <IconSend size={13} />
                          <span>Resend Reminder Link</span>
                        </button>
                      )}
                    </div>

                    {/* Rationale Banner when Stopped */}
                    {reminderState.stoppedReason && (
                      <div
                        style={{
                          background: reminderState.overallStatus === "stopped_completed"
                            ? "rgba(16, 185, 129, 0.08)"
                            : "rgba(239, 68, 68, 0.08)",
                          border: `1px solid ${
                            reminderState.overallStatus === "stopped_completed"
                              ? "rgba(16, 185, 129, 0.25)"
                              : "rgba(239, 68, 68, 0.25)"
                          }`,
                          borderRadius: 8,
                          padding: "10px 14px",
                          fontSize: 12,
                          color: "var(--adm-text, #f1f5f9)",
                          lineHeight: 1.5,
                        }}
                        id="reminder-stopped-banner"
                      >
                        <strong>Policy Status:</strong> {reminderState.stoppedReason}
                      </div>
                    )}

                    {/* Metrics Grid */}
                    <div className="customer-reminders-grid">
                      <div className="customer-reminders-metric-box">
                        <span className="customer-reminders-metric-label">Last Reminder Sent</span>
                        <span className="customer-reminders-metric-value" id="val-last-reminder">
                          {reminderState.lastReminder
                            ? `${reminderState.lastReminder.type} (${new Date(reminderState.lastReminder.sentAt).toLocaleDateString()})`
                            : "None dispatched yet"}
                        </span>
                      </div>

                      <div className="customer-reminders-metric-box">
                        <span className="customer-reminders-metric-label">Next Reminder Due</span>
                        <span className="customer-reminders-metric-value" id="val-next-reminder">
                          {reminderState.overallStatus === "active" && reminderState.nextReminder
                            ? `Day ${reminderState.nextReminder.stage} (in ${reminderState.nextReminder.daysRemaining} days)`
                            : reminderState.overallStatus === "stopped_completed"
                            ? "Stopped (Verified)"
                            : reminderState.overallStatus === "stopped_withdrawn"
                            ? "Stopped (Withdrawn)"
                            : "—"}
                        </span>
                      </div>

                      <div className="customer-reminders-metric-box">
                        <span className="customer-reminders-metric-label">Pending Document Triggers</span>
                        <span className="customer-reminders-metric-value" id="val-pending-docs-count">
                          {customer.pending_count > 0
                            ? `${customer.pending_count} document(s) remaining`
                            : "All documents verified"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. VERIFICATION PROGRESS CARD */}
                <div className="progress-metrics-card">
                  <div className="progress-metrics-top">
                    <div className="progress-title-row">
                      <h3 className="progress-title">Verification Intake Progress</h3>
                      <span className="progress-pct-badge">
                        {customer.required_count > 0
                          ? Math.round((customer.received_count / customer.required_count) * 100)
                          : 0}
                        % Complete
                      </span>
                    </div>
                    <span className="progress-counts-text">
                      {customer.received_count} of {customer.required_count} verified
                      {customer.pending_count > 0 && ` • ${customer.pending_count} pending`}
                    </span>
                  </div>

                  <div className="progress-bar-track-lg">
                    <div
                      className="progress-bar-fill-lg"
                      style={{
                        width: `${
                          customer.required_count > 0
                            ? (customer.received_count / customer.required_count) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>

                  {customer.case_status === "completed" && (
                    <div
                      className="msg ok"
                      role="status"
                      style={{ marginTop: 16, marginBottom: 0 }}
                    >
                      <IconCheck size={16} />
                      <span>
                        <b>Case verification complete!</b> All {customer.required_count} required documents have been verified and validated.
                      </span>
                    </div>
                  )}
                </div>

                {/* 3. REQUIRED DOCUMENTS CHECKLIST */}
                <div className="admin-section-block">
                  <div className="section-title-row" style={{ marginBottom: 12 }}>
                    <h3 className="admin-section-heading" style={{ fontSize: 18 }}>
                      Required Documents Checklist
                    </h3>
                    <span className="text-secondary-sm">
                      {customer.required?.length || 0} slots configured for this customer
                    </span>
                  </div>

                  <div className="required-checklist-grid">
                    {(customer.required || []).map((req) => {
                      let slotClass = "waiting";
                      let slotStatusLabel = "Pending Upload";
                      if (req.state === "verified") {
                        slotClass = "verified";
                        slotStatusLabel = "Verified";
                      } else if (req.state === "under_review") {
                        slotClass = "review";
                        slotStatusLabel = "Under Review";
                      } else if (req.state === "processing") {
                        slotClass = "processing";
                        slotStatusLabel = "Processing";
                      } else if (req.state === "resubmit") {
                        slotClass = "resubmit";
                        slotStatusLabel = "Resubmit Required";
                      }

                      // Find matching uploaded document if exists
                      const matchingDoc = (customer.documents || []).find(
                        (d) => d.doc_type === req.doc_type && !d.superseded
                      );

                      return (
                        <div
                          key={req.doc_type}
                          className={`checklist-slot-card ${slotClass}`}
                          onClick={() => {
                            if (matchingDoc) setInspectDoc(matchingDoc);
                          }}
                          style={{ cursor: matchingDoc ? "pointer" : "default" }}
                        >
                          <div className="checklist-slot-left">
                            <div className="checklist-slot-icon">
                              {slotClass === "verified" && <IconCheck size={16} />}
                              {slotClass === "waiting" && <IconClock size={16} />}
                              {slotClass === "processing" && <IconClock size={16} />}
                              {slotClass === "review" && <IconAlertTriangle size={16} />}
                              {slotClass === "resubmit" && <IconAlertCircle size={16} />}
                            </div>
                            <div>
                              <div className="checklist-slot-title">{req.label}</div>
                              <div className="checklist-slot-sub">{req.doc_type}</div>
                            </div>
                          </div>

                          <div style={{ textAlign: "right" }}>
                            <span className={`badge-status-${slotClass === "verified" ? "verified" : slotClass === "review" ? "review" : slotClass === "resubmit" ? "rejected" : "pending"}`}>
                              {slotStatusLabel}
                            </span>
                            {matchingDoc && (
                              <div style={{ fontSize: 11, color: "var(--adm-primary)", marginTop: 4 }}>
                                Inspect <IconChevronRight size={10} style={{ display: "inline" }} />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 4. UPLOADED DOCUMENTS REPOSITORY */}
                <div className="admin-section-block">
                  <div className="documents-header-row" style={{ marginBottom: 14 }}>
                    <div>
                      <h3 className="admin-section-heading" style={{ fontSize: 18 }}>
                        Uploaded Document Files ({customer.documents?.length || 0})
                      </h3>
                      <p className="admin-section-subheading">
                        Decrypted on demand with AES-256-GCM. Active and superseded upload history.
                      </p>
                    </div>

                    {/* Filter controls */}
                    <div className="doc-filter-form" style={{ gap: 10 }}>
                      <div className="search-input-wrap" style={{ minWidth: 220, maxWidth: 300, height: 36 }}>
                        <IconSearch size={14} className="search-icon" />
                        <input
                          type="search"
                          placeholder="Filter files by name or type..."
                          value={docSearch}
                          onChange={(e) => setDocSearch(e.target.value)}
                        />
                      </div>

                      <select
                        value={docStatusFilter}
                        onChange={(e) => setDocStatusFilter(e.target.value)}
                        className="admin-select-styled"
                        style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 120 }}
                      >
                        <option value="all">All States</option>
                        <option value="verified">Verified</option>
                        <option value="review">Under Review</option>
                        <option value="rejected">Rejected</option>
                        <option value="processing">Processing</option>
                        <option value="superseded">Superseded</option>
                      </select>
                    </div>
                  </div>

                  {filteredDocuments.length === 0 ? (
                    <div className="admin-table-card" style={{ padding: 40, textAlign: "center" }}>
                      <IconFileText size={36} color="var(--adm-text-muted)" style={{ margin: "0 auto 8px" }} />
                      <p style={{ color: "var(--adm-text)", fontWeight: 600, margin: "0 0 4px" }}>
                        No documents match criteria
                      </p>
                      <p style={{ color: "var(--adm-text-secondary)", fontSize: 13, margin: 0 }}>
                        {!customer.documents || customer.documents.length === 0
                          ? "Customer has not uploaded any document files yet."
                          : "Try resetting your search query or filter selection."}
                      </p>
                    </div>
                  ) : (
                    <div className="admin-table-card" style={{ padding: 0 }}>
                      <div className="admin-table-responsive">
                        <table className="admin-data-table">
                          <thead>
                            <tr>
                              <th>DOCUMENT</th>
                              <th>UPLOADED</th>
                              <th>OCR STATUS</th>
                              <th>VERIFICATION</th>
                              <th>STORAGE</th>
                              <th>RISK / REASON</th>
                              <th style={{ textAlign: "right" }}>ACTIONS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDocuments.map((d) => (
                              <tr
                                key={d.id}
                                className="table-row-hoverable"
                                onClick={() => setInspectDoc(d)}
                              >
                                <td>
                                  <div className="doc-label-row">
                                    <span className="doc-type-label">{d.label}</span>
                                    {d.superseded && (
                                      <span className="badge-superseded">Superseded</span>
                                    )}
                                  </div>
                                  <span className="doc-filename-sub">{d.filename}</span>
                                </td>

                                <td>
                                  <span className="text-secondary-sm">
                                    {new Date(d.uploaded_at).toLocaleString()}
                                  </span>
                                </td>

                                <td>
                                  <span className={`ocr-pill ${d.ocr_status}`}>
                                    {d.ocr_status}
                                  </span>
                                </td>

                                <td>
                                  {d.verification_status === "verified" ? (
                                    <span className="badge-status-verified">
                                      <IconCheck size={12} /> Verified
                                    </span>
                                  ) : d.verification_status === "manual_review" || d.verification_status === "under_review" ? (
                                    <span className="badge-status-review">
                                      <IconAlertTriangle size={12} /> Under Review
                                    </span>
                                  ) : d.verification_status === "rejected" ? (
                                    <span className="badge-status-rejected">
                                      <IconAlertCircle size={12} /> Rejected
                                    </span>
                                  ) : (
                                    <span className="badge-status-pending">
                                      <IconClock size={12} /> Unverified
                                    </span>
                                  )}
                                </td>

                                <td>
                                  {d.file_state === "stored" ? (
                                    <span className="badge-storage-stored">
                                      <IconShieldCheck size={12} /> Encrypted
                                    </span>
                                  ) : (
                                    <span className="badge-storage-purged">Purged</span>
                                  )}
                                </td>

                                <td>
                                  {d.flags && d.flags.length > 0 ? (
                                    <div className="risk-flag-mini-pill" title={d.flags.join(", ")}>
                                      <IconAlertTriangle size={12} /> {d.flags[0]}
                                      {d.flags.length > 1 && ` +${d.flags.length - 1}`}
                                    </div>
                                  ) : d.review_reason ? (
                                    <span className="text-secondary-sm" title={d.review_reason}>
                                      {d.review_reason.slice(0, 24)}...
                                    </span>
                                  ) : (
                                    <span className="text-muted-sm">—</span>
                                  )}
                                </td>

                                <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                                  <div className="table-actions-cell" style={{ justifyContent: "flex-end" }}>
                                    {d.file_state === "stored" && (
                                      <button
                                        type="button"
                                        className="btn-action-view"
                                        onClick={() =>
                                          setViewerDoc({
                                            id: d.id,
                                            label: d.label,
                                            filename: d.filename,
                                          })
                                        }
                                        title="Stream decrypted document safely"
                                      >
                                        <IconEye size={13} /> View
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      className="btn-action-view"
                                      onClick={() => setInspectDoc(d)}
                                      title="Inspect document metadata & timeline"
                                      style={{ background: "transparent", borderColor: "var(--adm-border)" }}
                                    >
                                      <IconInfo size={13} /> Inspect
                                    </button>

                                    {(d.verification_status === "manual_review" || d.verification_status === "under_review") && (
                                      <Link
                                        to="/admin/reviews"
                                        className="btn-action-view"
                                        style={{ background: "rgba(245, 158, 11, 0.15)", color: "#fbbf24", borderColor: "rgba(245, 158, 11, 0.35)", textDecoration: "none" }}
                                        title="Open in Manual Review Queue"
                                        id={`btn-open-queue-${d.id}`}
                                      >
                                        <IconAlertTriangle size={13} /> Review Queue
                                      </Link>
                                    )}

                                    {d.file_state === "stored" && (
                                      <button
                                        type="button"
                                        className="btn-action-delete"
                                        onClick={() => handleDeleteFile(d.id)}
                                        title="Permanently delete file"
                                      >
                                        <IconTrash2 size={13} />
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                {/* 5. CASE ACTIVITY & AUDIT TIMELINE */}
                <div className="admin-section-block">
                  <div className="section-title-row" style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <h3 className="admin-section-heading" style={{ fontSize: 18, margin: 0 }}>
                        <IconHistory size={18} style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
                        Case Activity &amp; Audit Trail
                      </h3>
                      <div style={{ display: "inline-flex", borderRadius: 8, padding: 2, background: "var(--adm-card-elevated)" }}>
                        <button
                          type="button"
                          className={`btn-toolbar-tool ${!privacyAuditOnly ? "active" : ""}`}
                          onClick={() => setPrivacyAuditOnly(false)}
                          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6 }}
                          id="btn-audit-all"
                        >
                          All ({customerAuditLogs.length})
                        </button>
                        <button
                          type="button"
                          className={`btn-toolbar-tool ${privacyAuditOnly ? "active" : ""}`}
                          onClick={() => setPrivacyAuditOnly(true)}
                          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6 }}
                          id="btn-audit-privacy"
                        >
                          Privacy &amp; Consent ({privacyAuditLogs.length})
                        </button>
                      </div>
                    </div>
                    <span className="text-secondary-sm">
                      {displayedAuditLogs.length} compliance event records
                    </span>
                  </div>

                  {displayedAuditLogs.length === 0 ? (
                    <div className="admin-table-card" style={{ padding: 24, textAlign: "center" }}>
                      <p style={{ color: "var(--adm-text-secondary)", margin: 0, fontSize: 13 }}>
                        {privacyAuditOnly
                          ? "No privacy or consent lifecycle events recorded yet for this customer."
                          : "No specific audit events recorded yet for this customer case."}
                      </p>
                    </div>
                  ) : (
                    <div className="customer-audit-feed">
                      {displayedAuditLogs.map((log) => {
                        let iconColor = "var(--adm-primary)";
                        const rawAction = log.action || "";
                        let actionLabel = rawAction.replace(/_/g, " ") || "Event";

                        const isPrivacyAction =
                          rawAction.includes("consent") ||
                          rawAction.includes("privacy") ||
                          rawAction.includes("delete") ||
                          rawAction.includes("close");

                        if (rawAction.includes("verified") || rawAction.includes("approved")) {
                          iconColor = "var(--adm-success)";
                        } else if (rawAction.includes("rejected") || rawAction.includes("deleted")) {
                          iconColor = "var(--adm-danger)";
                        } else if (rawAction.includes("review") || rawAction.includes("flagged")) {
                          iconColor = "var(--adm-warning)";
                        }

                        return (
                          <div key={log.id} className="audit-feed-item">
                            <div className="audit-feed-icon">
                              <IconShieldCheck size={16} color={iconColor} />
                            </div>
                            <div className="audit-feed-content">
                              <div className="audit-feed-action-row">
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  <span className="audit-feed-action-text" style={{ textTransform: "capitalize" }}>
                                    {actionLabel}
                                  </span>
                                  {isPrivacyAction && (
                                    <span
                                      className={`privacy-audit-pill ${
                                        rawAction.includes("delete")
                                          ? "danger"
                                          : rawAction.includes("granted")
                                          ? "success"
                                          : ""
                                      }`}
                                    >
                                      Privacy Directive
                                    </span>
                                  )}
                                </div>
                                <span className="audit-feed-time">
                                  {new Date(log.at).toLocaleString()}
                                </span>
                              </div>
                              <div className="audit-feed-actor">
                                Actor: <span className="font-mono">{log.actor}</span>
                                {log.entity_type && (
                                  <span> • Target: {log.entity_type} {log.entity_id ? `(#${log.entity_id})` : ""}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {/* Secure Document Viewer Modal */}
      {viewerDoc && (
        <SecureDocViewerModal
          isOpen={Boolean(viewerDoc)}
          docId={viewerDoc.id}
          label={viewerDoc.label}
          filename={viewerDoc.filename}
          allowDownload={Boolean(customer?.allow_download)}
          onClose={() => setViewerDoc(null)}
        />
      )}

      {/* Document Details Drawer */}
      {inspectDoc && customer && (
        <DocumentDetailsDrawer
          isOpen={Boolean(inspectDoc)}
          document={inspectDoc}
          customerName={customer.name}
          customerCode={customer.code}
          customerId={customer.id}
          allowDownload={Boolean(customer.allow_download)}
          onClose={() => setInspectDoc(null)}
          onSecureView={(id) => {
            setViewerDoc({ id, label: inspectDoc.label, filename: inspectDoc.filename });
          }}
          onDownload={handleDownload}
          onDeleteFile={handleDeleteFile}
        />
      )}

      {/* Phase 6: Close Case Confirmation Modal */}
      {showCloseCaseModal && customer && (
        <div
          className="admin-action-dialog-backdrop"
          id="admin-close-case-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="title-close-case-modal"
          onClick={() => { if (!busyAction) setShowCloseCaseModal(false); }}
        >
          <div ref={closeCaseModalRef} className="admin-action-dialog-card" onClick={(e) => e.stopPropagation()}>
            <div className="admin-dialog-icon-circle warn">
              <IconAlertTriangle size={26} />
            </div>

            <h3 id="title-close-case-modal" className="admin-dialog-title">Close Customer Case</h3>
            <p className="admin-dialog-desc">
              Closing case <strong>{customer.code}</strong> will immediately revoke customer upload credentials and initiate the <strong>7-day retention countdown</strong> towards automated data purging.
            </p>

            <label htmlFor="admin-close-case-reason" style={{ display: "block", textAlign: "left", fontSize: 12, fontWeight: 700, color: "var(--adm-text-muted)", marginBottom: 6 }}>
              Closure Reason (Optional)
            </label>
            <textarea
              id="admin-close-case-reason"
              rows={3}
              placeholder="e.g., Verification manually finalized; customer opted out of further processing."
              value={closeCaseReason}
              onChange={(e) => setCloseCaseReason(e.target.value)}
              className="admin-dialog-textarea"
            />

            <div className="admin-dialog-actions">
              <button
                type="button"
                className="consent-btn-decline"
                onClick={() => setShowCloseCaseModal(false)}
                disabled={busyAction}
                id="btn-cancel-close-case"
                style={{ fontSize: 13, padding: "8px 16px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="consent-btn-accept"
                onClick={async () => {
                  setShowCloseCaseModal(false);
                  await handleAction(
                    () => closeAdminCase(customer.id, closeCaseReason.trim() || undefined),
                    "Case marked as closed by admin."
                  );
                }}
                disabled={busyAction}
                id="btn-confirm-close-case"
                style={{ fontSize: 13, padding: "8px 18px" }}
              >
                Confirm Close Case
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 6: Delete Customer Data Confirmation Modal */}
      {showDeleteDataModal && customer && (
        <div
          className="admin-action-dialog-backdrop"
          id="admin-delete-data-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="title-delete-data-modal"
          onClick={() => { if (!busyAction) setShowDeleteDataModal(false); }}
        >
          <div ref={deleteDataModalRef} className="admin-action-dialog-card danger" onClick={(e) => e.stopPropagation()}>
            <div className="admin-dialog-icon-circle danger">
              <IconTrash2 size={26} />
            </div>

            <h3 id="title-delete-data-modal" className="admin-dialog-title" style={{ color: "var(--adm-danger, #ef4444)" }}>
              Permanent Data Deletion &amp; Anonymization
            </h3>
            <p className="admin-dialog-desc">
              You are about to permanently purge all data for <strong>{customer.name}</strong> ({customer.code}).
              This action executes immediate cryptographic deletion of all AES-256 encrypted documents from Storage, wipes OCR payloads, and anonymizes customer PII.
            </p>

            <label className="admin-dialog-checkbox-label">
              <input
                type="checkbox"
                checked={confirmDeleteChecked}
                onChange={(e) => setConfirmDeleteChecked(e.target.checked)}
                id="confirm-delete-data-checkbox"
                style={{ width: 16, height: 16, accentColor: "#ef4444" }}
              />
              <span>I confirm that this action is irreversible and compliant with DPDP Act erasure policies.</span>
            </label>

            <div className="admin-dialog-actions">
              <button
                type="button"
                className="consent-btn-decline"
                onClick={() => setShowDeleteDataModal(false)}
                disabled={busyAction}
                id="btn-cancel-delete-data"
                style={{ fontSize: 13, padding: "8px 16px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="consent-btn-accept"
                disabled={busyAction || !confirmDeleteChecked}
                onClick={async () => {
                  setShowDeleteDataModal(false);
                  await handleAction(
                    () => deleteAdminCustomerData(customer.id),
                    "Customer data and files have been permanently purged."
                  );
                }}
                id="btn-confirm-delete-data"
                style={{
                  fontSize: 13,
                  padding: "8px 18px",
                  background: confirmDeleteChecked ? "#ef4444" : "#475569",
                  cursor: confirmDeleteChecked ? "pointer" : "not-allowed",
                }}
              >
                {busyAction ? "Purging Data…" : "Permanently Purge Data"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminCustomerDetailPage;
