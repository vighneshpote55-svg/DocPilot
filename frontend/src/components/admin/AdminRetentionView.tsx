import React, { useMemo, useState } from "react";
import type {
  AdminAuditItem,
  AdminCustomerListItem,
  AdminDocumentItem,
} from "../../types";
import {
  computeRetentionInfo,
  calculateRetentionSummary,
  filterRetentionAuditEvents,
  formatRetentionDateTime,
  type CustomerRetentionInfo,
} from "../../utils/retentionUtils";
import {
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconClock,
  IconFileCheck,
  IconHistory,
  IconRefreshCw,
  IconSearch,
  IconShield,
  IconTrash2,
  IconX,
} from "./AdminIcons";


interface AdminRetentionViewProps {
  customers: AdminCustomerListItem[];
  documents?: AdminDocumentItem[];
  auditLogs: AdminAuditItem[];
  loading: boolean;
  onRefresh: () => void;
  onOpenCustomerDetail: (id: number) => void;
  onManualPurge: (id: number) => Promise<void>;
}

type RetentionFilterTab = "all" | "scheduled" | "due" | "deleted" | "withdrawn";

export const AdminRetentionView: React.FC<AdminRetentionViewProps> = ({
  customers,
  documents = [],
  auditLogs,
  loading,
  onRefresh,
  onOpenCustomerDetail,
  onManualPurge,
}) => {
  const [activeFilterTab, setActiveFilterTab] = useState<RetentionFilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [drawerCustomer, setDrawerCustomer] = useState<{
    customer: AdminCustomerListItem;
    info: CustomerRetentionInfo;
  } | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<AdminCustomerListItem | null>(null);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  // Calculate high-level summary KPIs
  const summaryMetrics = useMemo(() => {
    return calculateRetentionSummary(customers, documents);
  }, [customers, documents]);

  // Compute enriched customer retention models
  const enrichedCustomers = useMemo(() => {
    return customers.map((c) => {
      const customerDocs = documents.filter((d) => d.customer_id === c.id);
      return {
        customer: c,
        info: computeRetentionInfo(c, customerDocs),
      };
    });
  }, [customers, documents]);

  // Filter and search
  const filteredCustomers = useMemo(() => {
    return enrichedCustomers.filter(({ customer, info }) => {
      // Status tab filter
      if (activeFilterTab === "scheduled" && info.state !== "scheduled") return false;
      if (activeFilterTab === "due" && info.state !== "due") return false;
      if (activeFilterTab === "deleted" && info.state !== "deleted") return false;
      if (activeFilterTab === "withdrawn" && info.lifecycleTrigger !== "consent_withdrawn" && info.lifecycleTrigger !== "expired") {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = customer.name.toLowerCase().includes(q);
        const matchesCode = customer.code.toLowerCase().includes(q);
        const matchesEmail = customer.email.toLowerCase().includes(q);
        if (!matchesName && !matchesCode && !matchesEmail) return false;
      }

      return true;
    });
  }, [enrichedCustomers, activeFilterTab, searchQuery]);

  // Execute manual purge
  const handleExecutePurge = async () => {
    if (!purgeTarget || !purgeConfirmed) return;
    setPurging(true);
    setPurgeError(null);
    try {
      await onManualPurge(purgeTarget.id);
      setPurgeTarget(null);
      setPurgeConfirmed(false);
      setPurging(false);
    } catch (err: unknown) {
      setPurgeError(err instanceof Error ? err.message : "Failed to execute purge.");
      setPurging(false);
    }
  };

  // Drawer audit events
  const drawerAuditEvents = useMemo(() => {
    if (!drawerCustomer) return [];
    return filterRetentionAuditEvents(auditLogs, drawerCustomer.customer.id);
  }, [drawerCustomer, auditLogs]);

  return (
    <div className="admin-retention-view" id="admin-retention-center">
      {/* 4 KPI Summary Cards */}
      <div className="retention-kpi-grid">
        <div className="retention-kpi-card" id="kpi-retention-active">
          <div className="retention-kpi-icon blue">
            <IconClock size={22} />
          </div>
          <div className="retention-kpi-content">
            <span className="retention-kpi-label">Active in 7-Day Retention</span>
            <span className="retention-kpi-val">{summaryMetrics.activeRetentionCount}</span>
          </div>
        </div>

        <div className="retention-kpi-card" id="kpi-retention-due">
          <div className="retention-kpi-icon amber">
            <IconAlertTriangle size={22} />
          </div>
          <div className="retention-kpi-content">
            <span className="retention-kpi-label">Due for Purge Today</span>
            <span className="retention-kpi-val">{summaryMetrics.duePurgeCount}</span>
          </div>
        </div>

        <div className="retention-kpi-card" id="kpi-retention-purged">
          <div className="retention-kpi-icon rose">
            <IconTrash2 size={22} />
          </div>
          <div className="retention-kpi-content">
            <span className="retention-kpi-label">Permanently Purged</span>
            <span className="retention-kpi-val">{summaryMetrics.permanentlyPurgedCount}</span>
          </div>
        </div>

        <div className="retention-kpi-card" id="kpi-retention-files">
          <div className="retention-kpi-icon emerald">
            <IconArchive size={22} />
          </div>
          <div className="retention-kpi-content">
            <span className="retention-kpi-label">Files Queued for Erasure</span>
            <span className="retention-kpi-val">{summaryMetrics.pendingFilesCount}</span>
          </div>
        </div>
      </div>

      {/* Action Dock: Search & Segmented Filter Tabs */}
      <div className="retention-filter-dock" id="retention-filter-dock">
        <div className="retention-dock-left">
          <div className="retention-search-box">
            <IconSearch size={15} className="retention-search-icon" />
            <input
              type="text"
              id="retention-search-input"
              className="retention-search-input"
              placeholder="Search by customer, case code, or email…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="retention-segmented-tabs">
            <button
              type="button"
              id="tab-filter-all"
              className={`retention-tab-btn ${activeFilterTab === "all" ? "active" : ""}`}
              onClick={() => setActiveFilterTab("all")}
            >
              All Records ({customers.length})
            </button>
            <button
              type="button"
              id="tab-filter-scheduled"
              className={`retention-tab-btn ${activeFilterTab === "scheduled" ? "active" : ""}`}
              onClick={() => setActiveFilterTab("scheduled")}
            >
              Scheduled (7-Day) ({summaryMetrics.activeRetentionCount})
            </button>
            <button
              type="button"
              id="tab-filter-due"
              className={`retention-tab-btn ${activeFilterTab === "due" ? "active" : ""}`}
              onClick={() => setActiveFilterTab("due")}
            >
              Due for Purge ({summaryMetrics.duePurgeCount})
            </button>
            <button
              type="button"
              id="tab-filter-purged"
              className={`retention-tab-btn ${activeFilterTab === "deleted" ? "active" : ""}`}
              onClick={() => setActiveFilterTab("deleted")}
            >
              Permanently Purged ({summaryMetrics.permanentlyPurgedCount})
            </button>
            <button
              type="button"
              id="tab-filter-withdrawn"
              className={`retention-tab-btn ${activeFilterTab === "withdrawn" ? "active" : ""}`}
              onClick={() => setActiveFilterTab("withdrawn")}
            >
              Withdrawn / Expired
            </button>
          </div>
        </div>

        <button
          type="button"
          id="btn-refresh-retention"
          className="btn sec"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
          onClick={onRefresh}
          disabled={loading}
        >
          <IconRefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      {/* Main Retention Queue Table */}
      <div className="card wrap" style={{ padding: 0 }}>
        {loading ? (
          <div id="retention-loading-state" style={{ padding: 40, textAlign: "center" }} className="mut">
            <IconRefreshCw size={24} className="spin" style={{ marginBottom: 8 }} />
            <p>Loading statutory retention records and purge pipeline…</p>
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div id="retention-empty-state" style={{ padding: 48, textAlign: "center" }}>
            <div style={{ margin: "0 auto 12px", width: 44, height: 44, borderRadius: "50%", background: "rgba(16, 185, 129, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#10b981" }}>
              <IconShield size={24} />
            </div>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>No Retention Queue Records</h3>
            <p className="mut" style={{ fontSize: 13, maxWidth: 440, margin: "0 auto" }}>
              No customer records match the active filter. All data is either in active intake or complies with 7-day retention deletion policies.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="retention-table" id="retention-queue-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Customer & Case</th>
                  <th>Lifecycle Trigger</th>
                  <th>7-Day Retention Progress</th>
                  <th>Scheduled Deletion</th>
                  <th>Pending Data</th>
                  <th>Deletion State</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map(({ customer, info }) => {
                  const formattedDates = formatRetentionDateTime(customer.delete_after);
                  return (
                    <tr key={customer.id} id={`retention-row-${customer.id}`}>
                      {/* Customer Info */}
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span
                            style={{ fontWeight: 700, cursor: "pointer", color: "var(--adm-primary, #60a5fa)" }}
                            onClick={() => onOpenCustomerDetail(customer.id)}
                          >
                            {customer.name}
                          </span>
                          <span className="mut" style={{ fontSize: 11 }}>
                            Case: <b>{customer.code}</b>
                          </span>
                        </div>
                      </td>

                      {/* Lifecycle Trigger */}
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {info.lifecycleTrigger === "completed" && <IconFileCheck size={14} color="#10b981" />}
                          {info.lifecycleTrigger === "consent_withdrawn" && <IconAlertTriangle size={14} color="#f59e0b" />}
                          {info.lifecycleTrigger === "expired" && <IconClock size={14} color="#ef4444" />}
                          {info.lifecycleLabel}
                        </span>
                      </td>

                      {/* 7-Day Retention Progress */}
                      <td style={{ minWidth: 170 }}>
                        {info.state === "deleted" ? (
                          <span className="retention-state-pill deleted">
                            <IconCheck size={12} /> Purged 100%
                          </span>
                        ) : info.scheduledAt ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                              <span style={{ fontWeight: 700, color: info.isUrgent ? "#fbbf24" : "var(--adm-text)" }}>
                                {info.remainingFormatted}
                              </span>
                              <span className="mut">{info.progressPercent}%</span>
                            </div>
                            <div className="retention-progress-track" style={{ height: 6 }}>
                              <div
                                className={`retention-progress-bar ${info.isUrgent ? "urgent" : ""}`}
                                style={{ width: `${info.progressPercent}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="mut" style={{ fontSize: 12 }}>
                            Pre-retention
                          </span>
                        )}
                      </td>

                      {/* Scheduled Deletion Timestamp */}
                      <td>
                        {customer.data_deleted_at ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontSize: 12, color: "#f87171", fontWeight: 600 }}>
                              Purged on {new Date(customer.data_deleted_at).toLocaleDateString()}
                            </span>
                            <span className="mut" style={{ fontSize: 11 }}>
                              {new Date(customer.data_deleted_at).toLocaleTimeString()}
                            </span>
                          </div>
                        ) : customer.delete_after ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>
                              {formattedDates.local}
                            </span>
                            <span className="mut" style={{ fontSize: 11 }}>
                              {formattedDates.relative}
                            </span>
                          </div>
                        ) : (
                          <span className="mut">—</span>
                        )}
                      </td>

                      {/* Pending Data Inventory */}
                      <td>
                        <div className="retention-inventory-tags">
                          {info.state === "deleted" ? (
                            <span className="inventory-pill wiped">All Data Wiped</span>
                          ) : (
                            <>
                              <span className={`inventory-pill ${info.pendingInventory.storedFilesCount > 0 ? "active" : ""}`}>
                                {info.pendingInventory.storedFilesCount} file{info.pendingInventory.storedFilesCount === 1 ? "" : "s"}
                              </span>
                              <span className="inventory-pill">
                                {info.pendingInventory.ocrRecordsCount} OCR
                              </span>
                              <span className="inventory-pill">
                                {info.pendingInventory.activeTokensCount > 0 ? "1 token" : "0 tokens"}
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* Deletion State Badge */}
                      <td>
                        {info.state === "scheduled" && (
                          <span className="retention-state-pill scheduled">
                            <IconClock size={12} /> Scheduled
                          </span>
                        )}
                        {info.state === "due" && (
                          <span className="retention-state-pill due">
                            <IconAlertTriangle size={12} /> Due / In Sweep
                          </span>
                        )}
                        {info.state === "deleted" && (
                          <span className="retention-state-pill deleted">
                            <IconArchive size={12} /> Permanently Purged
                          </span>
                        )}
                        {info.state === "failed" && (
                          <span className="retention-state-pill failed">
                            <IconAlertTriangle size={12} /> Failed (Retrying)
                          </span>
                        )}
                        {info.state === "none" && (
                          <span className="retention-state-pill" style={{ background: "rgba(148, 163, 184, 0.15)", color: "#94a3b8" }}>
                            Active Intake
                          </span>
                        )}
                      </td>

                      {/* Action Buttons */}
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <button
                            type="button"
                            id={`btn-retention-timeline-${customer.id}`}
                            className="btn sec"
                            style={{ padding: "4px 9px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}
                            onClick={() => setDrawerCustomer({ customer, info })}
                            title="Inspect Retention Timeline & Audit Events"
                          >
                            <IconHistory size={13} /> Timeline
                          </button>

                          {info.state !== "deleted" && (
                            <button
                              type="button"
                              id={`btn-retention-purge-${customer.id}`}
                              className="btn"
                              style={{
                                padding: "4px 9px",
                                fontSize: 12,
                                background: "rgba(239, 68, 68, 0.15)",
                                borderColor: "rgba(239, 68, 68, 0.4)",
                                color: "#f87171",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                              onClick={() => {
                                setPurgeTarget(customer);
                                setPurgeConfirmed(false);
                                setPurgeError(null);
                              }}
                              title="Trigger immediate permanent data wipe"
                            >
                              <IconTrash2 size={13} /> Purge Now
                            </button>
                          )}

                          <button
                            type="button"
                            id={`btn-retention-view-${customer.id}`}
                            className="btn sec"
                            style={{ padding: "4px 9px", fontSize: 12 }}
                            onClick={() => onOpenCustomerDetail(customer.id)}
                          >
                            View Case
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Slide-Over Drawer: Customer Retention Timeline & Audit Ledger */}
      {drawerCustomer && (
        <>
          <div
            className="retention-drawer-backdrop"
            onClick={() => setDrawerCustomer(null)}
            aria-hidden="true"
          />
          <aside className="retention-timeline-drawer" id="customer-retention-timeline-drawer">
            <div className="retention-drawer-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, background: "rgba(59, 130, 246, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#60a5fa" }}>
                  <IconHistory size={18} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Retention Lifecycle & Audit Ledger</h3>
                  <span className="mut" style={{ fontSize: 12 }}>
                    Case: <b>{drawerCustomer.customer.code}</b> • {drawerCustomer.customer.name}
                  </span>
                </div>
              </div>
              <button
                type="button"
                id="btn-close-retention-drawer"
                className="drawer-close-btn"
                onClick={() => setDrawerCustomer(null)}
                aria-label="Close retention drawer"
              >
                <IconX size={18} />
              </button>
            </div>

            <div className="retention-drawer-body">
              {/* 5-Step Lifecycle Stepper */}
              <div className="card" style={{ padding: 18, background: "rgba(15, 23, 42, 0.5)" }}>
                <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--adm-text-muted)" }}>
                  Statutory 7-Day Lifecycle Progression
                </span>

                <div className="retention-lifecycle-stepper">
                  {/* Step 1: Case Completed */}
                  <div className={`retention-stepper-node ${drawerCustomer.customer.case_status === "completed" || drawerCustomer.customer.consent_status === "withdrawn" ? "completed" : "active"}`}>
                    <div className="retention-node-circle">
                      <IconCheck size={14} />
                    </div>
                    <span className="retention-node-label">Case Closed</span>
                  </div>

                  {/* Step 2: 7-Day Lock */}
                  <div className={`retention-stepper-node ${drawerCustomer.customer.delete_after ? "completed" : ""}`}>
                    <div className="retention-node-circle">
                      <IconClock size={14} />
                    </div>
                    <span className="retention-node-label">7-Day Lock</span>
                  </div>

                  {/* Step 3: Grace Period */}
                  <div className={`retention-stepper-node ${drawerCustomer.info.state === "scheduled" ? "active" : drawerCustomer.info.state === "due" || drawerCustomer.info.state === "deleted" ? "completed" : ""}`}>
                    <div className="retention-node-circle">
                      <IconShield size={14} />
                    </div>
                    <span className="retention-node-label">Audited Grace</span>
                  </div>

                  {/* Step 4: Purge Sweep */}
                  <div className={`retention-stepper-node ${drawerCustomer.info.state === "due" ? "active" : drawerCustomer.info.state === "deleted" ? "completed" : ""}`}>
                    <div className="retention-node-circle">
                      <IconTrash2 size={14} />
                    </div>
                    <span className="retention-node-label">Auto-Purge</span>
                  </div>

                  {/* Step 5: Ledger Proof */}
                  <div className={`retention-stepper-node ${drawerCustomer.info.state === "deleted" ? "purged" : ""}`}>
                    <div className="retention-node-circle">
                      <IconFileCheck size={14} />
                    </div>
                    <span className="retention-node-label">Ledger Proof</span>
                  </div>
                </div>
              </div>

              {/* Retention Metrics Summary */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="customer-retention-stat-card">
                  <span className="mut" style={{ fontSize: 11 }}>Scheduled Erasure (Local)</span>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>
                    {drawerCustomer.customer.delete_after ? new Date(drawerCustomer.customer.delete_after).toLocaleString() : "—"}
                  </span>
                </div>
                <div className="customer-retention-stat-card">
                  <span className="mut" style={{ fontSize: 11 }}>Permanent Deletion Date</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: drawerCustomer.customer.data_deleted_at ? "#f87171" : "inherit" }}>
                    {drawerCustomer.customer.data_deleted_at ? new Date(drawerCustomer.customer.data_deleted_at).toLocaleString() : "Pending sweep"}
                  </span>
                </div>
              </div>

              {/* Chronological Deletion & Retention Audit Events */}
              <div>
                <h4 style={{ margin: "0 0 10px", fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                  <IconHistory size={16} /> Privacy & Deletion Audit Trail ({drawerAuditEvents.length})
                </h4>

                {drawerAuditEvents.length === 0 ? (
                  <p className="mut" style={{ fontSize: 13, padding: 12, background: "rgba(15, 23, 42, 0.4)", borderRadius: 8 }}>
                    No deletion or retention audit events recorded for this customer yet.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {drawerAuditEvents.map((evt) => (
                      <div
                        key={evt.id}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: "rgba(15, 23, 42, 0.6)",
                          border: "1px solid rgba(255, 255, 255, 0.06)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span className="tag" style={{ fontSize: 11, background: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" }}>
                            {evt.action}
                          </span>
                          <span className="mut" style={{ fontSize: 11 }}>
                            {new Date(evt.at).toLocaleString()}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                          <span>
                            Actor: <b>{evt.actor}</b>
                          </span>
                          <span className="mut">
                            {evt.entity_type} #{evt.entity_id}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </>
      )}

      {/* Manual Purge Modal */}
      {purgeTarget && (
        <div className="admin-modal-backdrop" id="admin-retention-purge-modal" style={{ display: "flex" }}>
          <div className="admin-modal-card" style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(239, 68, 68, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444" }}>
                <IconTrash2 size={22} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, color: "#f87171" }}>Permanent Data Purge</h3>
                <span className="mut" style={{ fontSize: 12 }}>Irreversible Right to Erasure / Immediate Purge</span>
              </div>
            </div>

            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--adm-text)" }}>
              You are about to permanently delete all data for customer <strong>{purgeTarget.name}</strong> ({purgeTarget.code}).
            </p>

            <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.25)", borderRadius: 8, padding: 12, margin: "14px 0", fontSize: 12, color: "#fca5a5" }}>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                <li>All AES-256-GCM ciphertext in Supabase Storage will be purged.</li>
                <li>OCR text extractions, manual review notes, and hashes will be wiped.</li>
                <li>Customer tokens revoked; customer record pseudonymized to <code>[deleted]</code>.</li>
              </ul>
            </div>

            {purgeError && (
              <div style={{ padding: "8px 12px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.4)", borderRadius: 6, color: "#f87171", fontSize: 12, marginBottom: 12 }}>
                {purgeError}
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "16px 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                id="retention-confirm-purge-checkbox"
                checked={purgeConfirmed}
                onChange={(e) => setPurgeConfirmed(e.target.checked)}
              />
              <span>I confirm irreversible permanent deletion under DPDP Act rules</span>
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button
                type="button"
                id="btn-retention-cancel-purge"
                className="btn sec"
                onClick={() => setPurgeTarget(null)}
                disabled={purging}
              >
                Cancel
              </button>
              <button
                type="button"
                id="btn-retention-confirm-purge-execute"
                className="btn"
                style={{ background: "#dc2626", borderColor: "#dc2626", color: "#ffffff" }}
                disabled={!purgeConfirmed || purging}
                onClick={handleExecutePurge}
              >
                {purging ? "Purging Data…" : "Permanently Purge Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
