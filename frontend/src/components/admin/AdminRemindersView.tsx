import React, { useState, useMemo, useRef } from "react";
import type { AdminCustomerListItem, AdminAuditItem } from "../../types";
import { useDialogA11y } from "../../utils/a11yUtils";
import {
  computeCustomerReminderState,
  type CustomerReminderState,
} from "../../utils/reminderUtils";
import {
  IconBell,
  IconCheck,
  IconClock,
  IconEye,
  IconMail,
  IconRefreshCw,
  IconSearch,
  IconSend,
  IconX,
} from "./AdminIcons";

interface AdminRemindersViewProps {
  customers: AdminCustomerListItem[];
  auditLogs: AdminAuditItem[];
  loading: boolean;
  onRefresh: () => void;
  onOpenCustomerDetail: (customerId: number) => void;
  onResendReminder: (customerId: number) => Promise<void>;
}

export const AdminRemindersView: React.FC<AdminRemindersViewProps> = ({
  customers,
  auditLogs,
  loading,
  onRefresh,
  onOpenCustomerDetail,
  onResendReminder,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "scheduled" | "stopped_completed" | "stopped_withdrawn"
  >("all");
  const [stageFilter, setStageFilter] = useState<"all" | "3" | "7" | "14">("all");
  const [selectedTimelineCustomer, setSelectedTimelineCustomer] =
    useState<CustomerReminderState | null>(null);
  const timelineDrawerRef = useRef<HTMLDivElement>(null);
  useDialogA11y(selectedTimelineCustomer !== null, () => setSelectedTimelineCustomer(null), timelineDrawerRef, {
    initialFocusSelector: "#btn-close-notification-drawer",
  });
  const [resendingId, setResendingId] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; ok: boolean } | null>(
    null
  );

  // Compute reminder states for all customers
  const computedList = useMemo(() => {
    return customers.map((c) => computeCustomerReminderState(c, auditLogs));
  }, [customers, auditLogs]);

  // Aggregate KPI metrics
  const kpis = useMemo(() => {
    let totalInCycle = 0;
    let day3Sent = 0;
    let day7Sent = 0;
    let day14Sent = 0;
    let totalStopped = 0;

    for (const item of computedList) {
      if (item.overallStatus === "active") totalInCycle++;
      if (item.stages.stage3.status === "sent") day3Sent++;
      if (item.stages.stage7.status === "sent") day7Sent++;
      if (item.stages.stage14.status === "sent") day14Sent++;
      if (
        item.overallStatus === "stopped_completed" ||
        item.overallStatus === "stopped_withdrawn"
      ) {
        totalStopped++;
      }
    }

    return { totalInCycle, day3Sent, day7Sent, day14Sent, totalStopped };
  }, [computedList]);

  // Filtered list
  const filteredList = useMemo(() => {
    return computedList.filter((item) => {
      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchName = item.customerName.toLowerCase().includes(q);
        const matchEmail = item.customerEmail.toLowerCase().includes(q);
        const matchCode = item.customerCode.toLowerCase().includes(q);
        if (!matchName && !matchEmail && !matchCode) return false;
      }

      // Status filter
      if (statusFilter === "active" && item.overallStatus !== "active") return false;
      if (
        statusFilter === "scheduled" &&
        (!item.nextReminder || item.overallStatus !== "active")
      ) {
        return false;
      }
      if (
        statusFilter === "stopped_completed" &&
        item.overallStatus !== "stopped_completed"
      ) {
        return false;
      }
      if (
        statusFilter === "stopped_withdrawn" &&
        item.overallStatus !== "stopped_withdrawn"
      ) {
        return false;
      }

      // Stage filter
      if (stageFilter === "3" && item.stages.stage3.status !== "sent") return false;
      if (stageFilter === "7" && item.stages.stage7.status !== "sent") return false;
      if (stageFilter === "14" && item.stages.stage14.status !== "sent") return false;

      return true;
    });
  }, [computedList, searchQuery, statusFilter, stageFilter]);

  const handleResend = async (customerId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setResendingId(customerId);
    setToastMsg(null);
    try {
      await onResendReminder(customerId);
      setToastMsg({
        text: `Upload link & reminder successfully dispatched to customer.`,
        ok: true,
      });
      setTimeout(() => setToastMsg(null), 4000);
    } catch (err: unknown) {
      setToastMsg({
        text: err instanceof Error ? err.message : "Failed to dispatch reminder.",
        ok: false,
      });
    } finally {
      setResendingId(null);
    }
  };

  const getInitials = (name: string): string => {
    return (
      name
        .split(" ")
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase() || "CU"
    );
  };

  return (
    <div className="admin-reminders-view" id="admin-reminders-center">
      {/* Toast Feedback */}
      {toastMsg && (
        <div
          className={`msg ${toastMsg.ok ? "ok" : "err"}`}
          role="alert"
          style={{
            position: "fixed",
            top: 24,
            right: 24,
            zIndex: 1000,
            maxWidth: 420,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {toastMsg.text}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="reminders-kpi-grid">
        <div className="reminders-kpi-card" id="kpi-reminders-active">
          <div className="reminders-kpi-header">
            <span>Active in Cycle</span>
            <IconBell size={18} color="var(--adm-primary, #60a5fa)" />
          </div>
          <div className="reminders-kpi-value">{kpis.totalInCycle}</div>
          <div className="reminders-kpi-desc">
            Cases awaiting pending documents
          </div>
        </div>

        <div className="reminders-kpi-card" id="kpi-reminders-day3">
          <div className="reminders-kpi-header">
            <span>Day 3 Reminders</span>
            <span style={{ color: "#34d399", fontWeight: 700 }}>Stage 1</span>
          </div>
          <div className="reminders-kpi-value">{kpis.day3Sent}</div>
          <div className="reminders-kpi-desc">
            Dispatched 3 days post-consent
          </div>
        </div>

        <div className="reminders-kpi-card" id="kpi-reminders-day7">
          <div className="reminders-kpi-header">
            <span>Day 7 Reminders</span>
            <span style={{ color: "#60a5fa", fontWeight: 700 }}>Stage 2</span>
          </div>
          <div className="reminders-kpi-value">{kpis.day7Sent}</div>
          <div className="reminders-kpi-desc">
            Dispatched 7 days post-consent
          </div>
        </div>

        <div className="reminders-kpi-card" id="kpi-reminders-day14">
          <div className="reminders-kpi-header">
            <span>Day 14 Final Notice</span>
            <span style={{ color: "#f59e0b", fontWeight: 700 }}>Stage 3</span>
          </div>
          <div className="reminders-kpi-value">{kpis.day14Sent}</div>
          <div className="reminders-kpi-desc">
            Final reminder before case expiry
          </div>
        </div>

        <div className="reminders-kpi-card" id="kpi-reminders-stopped">
          <div className="reminders-kpi-header">
            <span>Reminders Stopped</span>
            <IconCheck size={18} color="var(--adm-success, #10b981)" />
          </div>
          <div className="reminders-kpi-value">{kpis.totalStopped}</div>
          <div className="reminders-kpi-desc">
            Verified or consent revoked
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="reminders-filter-dock">
        <div className="reminders-filter-left">
          <div className="reminders-search-wrap">
            <IconSearch size={16} />
            <input
              type="text"
              placeholder="Search by name, email, or code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="reminders-search-input"
              id="reminder-search-input"
            />
          </div>

          <div
            className="reminders-segmented-tabs"
            role="tablist"
            aria-label="Reminder Status Filters"
          >
            <button
              type="button"
              className={`reminders-tab-btn ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
              id="filter-reminders-all"
            >
              All ({computedList.length})
            </button>
            <button
              type="button"
              className={`reminders-tab-btn ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
              id="filter-reminders-active"
            >
              Active ({kpis.totalInCycle})
            </button>
            <button
              type="button"
              className={`reminders-tab-btn ${statusFilter === "scheduled" ? "active" : ""}`}
              onClick={() => setStatusFilter("scheduled")}
              id="filter-reminders-scheduled"
            >
              Upcoming Due
            </button>
            <button
              type="button"
              className={`reminders-tab-btn ${statusFilter === "stopped_completed" ? "active" : ""}`}
              onClick={() => setStatusFilter("stopped_completed")}
              id="filter-reminders-stopped-completed"
            >
              Stopped: Completed
            </button>
            <button
              type="button"
              className={`reminders-tab-btn ${statusFilter === "stopped_withdrawn" ? "active" : ""}`}
              onClick={() => setStatusFilter("stopped_withdrawn")}
              id="filter-reminders-stopped-withdrawn"
            >
              Stopped: Withdrawn
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value as "all" | "3" | "7" | "14")}
            className="reminders-tab-btn"
            style={{
              background: "rgba(15, 23, 42, 0.4)",
              border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
              padding: "7px 12px",
              color: "var(--adm-text, #f1f5f9)",
              cursor: "pointer",
            }}
            id="reminder-stage-select"
            aria-label="Filter by Reminder Stage"
          >
            <option value="all">All Stages</option>
            <option value="3">Stage 1: Day 3</option>
            <option value="7">Stage 2: Day 7</option>
            <option value="14">Stage 3: Day 14</option>
          </select>

          <button
            type="button"
            className="consent-btn-decline"
            onClick={onRefresh}
            id="btn-refresh-reminders"
            title="Refresh reminder records"
            style={{ fontSize: 12, padding: "7px 12px", display: "flex", alignItems: "center", gap: 6 }}
          >
            <IconRefreshCw size={14} className={loading ? "spin" : ""} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Reminders Table */}
      <div className="table-wrap" style={{ overflowX: "auto" }}>
        <table className="customers-table" id="admin-reminders-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Pending Docs</th>
              <th>3 / 7 / 14-Day Cycle</th>
              <th>Status</th>
              <th>Last Sent</th>
              <th>Next Due</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px 20px" }}>
                  <div className="processing-spinner" style={{ margin: "0 auto 12px", width: 28, height: 28 }} />
                  <div style={{ color: "var(--adm-text-secondary, #94a3b8)", fontSize: 13 }}>
                    Loading reminders and schedule timelines…
                  </div>
                </td>
              </tr>
            ) : filteredList.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "48px 20px" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔔</div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--adm-text, #f1f5f9)", marginBottom: 4 }}>
                    {searchQuery || statusFilter !== "all" || stageFilter !== "all"
                      ? "No Matching Reminders Found"
                      : "No active reminders."}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--adm-text-muted, #94a3b8)", maxWidth: 360, margin: "0 auto" }}>
                    {searchQuery || statusFilter !== "all" || stageFilter !== "all"
                      ? "No customer records matched your selected search criteria or filter tabs."
                      : "All customers have completed document intake or are outside reminder windows."}
                  </div>
                </td>
              </tr>
            ) : (
              filteredList.map((item) => {
                const s3 = item.stages.stage3;
                const s7 = item.stages.stage7;
                const s14 = item.stages.stage14;

                return (
                  <tr
                    key={item.customerId}
                    id={`reminder-row-${item.customerId}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => onOpenCustomerDetail(item.customerId)}
                  >
                    {/* Customer Info */}
                    <td>
                      <div className="customer-info-cell">
                        <div className="customer-avatar-initials">
                          {getInitials(item.customerName)}
                        </div>
                        <div>
                          <div className="customer-name-link" style={{ fontWeight: 600 }}>
                            {item.customerName}
                          </div>
                          <div className="customer-sub-text">
                            <span className="customer-code-badge">{item.customerCode}</span>
                            <span style={{ marginLeft: 6 }}>{item.customerEmail}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Pending Documents */}
                    <td>
                      <span
                        className={`doc-count-badge ${
                          item.pendingCount === 0 ? "complete" : "pending"
                        }`}
                      >
                        {item.pendingCount === 0
                          ? "✓ None (Verified)"
                          : `${item.pendingCount} pending`}
                      </span>
                    </td>

                    {/* 3 / 7 / 14-Day Cycle Stepper */}
                    <td>
                      <div className="reminder-stepper">
                        {/* Day 3 */}
                        <span
                          className={`stepper-node ${s3.status}`}
                          title={`Day 3: ${s3.status} ${s3.sentAt ? `(${new Date(s3.sentAt).toLocaleDateString()})` : ""}`}
                          id={`node-stage3-${item.customerId}`}
                        >
                          {s3.status === "sent" ? (
                            <IconCheck size={12} />
                          ) : s3.status === "scheduled" ? (
                            <IconClock size={12} />
                          ) : (
                            <span>•</span>
                          )}
                          <span>3d</span>
                        </span>

                        <span className={`stepper-line ${s3.status === "sent" ? "active" : ""}`} />

                        {/* Day 7 */}
                        <span
                          className={`stepper-node ${s7.status}`}
                          title={`Day 7: ${s7.status} ${s7.sentAt ? `(${new Date(s7.sentAt).toLocaleDateString()})` : ""}`}
                          id={`node-stage7-${item.customerId}`}
                        >
                          {s7.status === "sent" ? (
                            <IconCheck size={12} />
                          ) : s7.status === "scheduled" ? (
                            <IconClock size={12} />
                          ) : (
                            <span>•</span>
                          )}
                          <span>7d</span>
                        </span>

                        <span className={`stepper-line ${s7.status === "sent" ? "active" : ""}`} />

                        {/* Day 14 */}
                        <span
                          className={`stepper-node ${s14.status}`}
                          title={`Day 14: ${s14.status} ${s14.sentAt ? `(${new Date(s14.sentAt).toLocaleDateString()})` : ""}`}
                          id={`node-stage14-${item.customerId}`}
                        >
                          {s14.status === "sent" ? (
                            <IconCheck size={12} />
                          ) : s14.status === "scheduled" ? (
                            <IconClock size={12} />
                          ) : (
                            <span>•</span>
                          )}
                          <span>14d</span>
                        </span>
                      </div>
                    </td>

                    {/* Overall Status Badge */}
                    <td>
                      {item.overallStatus === "active" ? (
                        <span className="reminder-status-pill active">
                          <span className="status-beacon live" style={{ width: 6, height: 6 }} />
                          <span>Active Cycle</span>
                        </span>
                      ) : item.overallStatus === "stopped_completed" ? (
                        <span className="reminder-status-pill stopped-completed">
                          <IconCheck size={12} />
                          <span>Stopped: Verified</span>
                        </span>
                      ) : item.overallStatus === "stopped_withdrawn" ? (
                        <span className="reminder-status-pill stopped-withdrawn">
                          <IconX size={12} />
                          <span>Stopped: Withdrawn</span>
                        </span>
                      ) : item.overallStatus === "awaiting_consent" ? (
                        <span className="reminder-status-pill awaiting">
                          <IconClock size={12} />
                          <span>Awaiting Consent</span>
                        </span>
                      ) : (
                        <span className="reminder-status-pill completed-schedule">
                          <span>Schedule Finished</span>
                        </span>
                      )}
                    </td>

                    {/* Last Sent */}
                    <td style={{ fontSize: 12, color: "var(--adm-text-secondary, #94a3b8)" }}>
                      {item.lastReminder ? (
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--adm-text, #f1f5f9)" }}>
                            {item.lastReminder.type}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--adm-text-muted, #64748b)" }}>
                            {new Date(item.lastReminder.sentAt).toLocaleDateString()}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: "var(--adm-text-muted, #64748b)" }}>None yet</span>
                      )}
                    </td>

                    {/* Next Due */}
                    <td style={{ fontSize: 12 }}>
                      {item.overallStatus === "active" && item.nextReminder ? (
                        <div>
                          <span style={{ color: "var(--adm-primary, #60a5fa)", fontWeight: 600 }}>
                            Day {item.nextReminder.stage}
                          </span>
                          <span style={{ marginLeft: 6, fontSize: 11, color: "var(--adm-text-muted, #64748b)" }}>
                            (in {item.nextReminder.daysRemaining}d)
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: "var(--adm-text-muted, #64748b)" }}>
                          {item.overallStatus === "stopped_completed"
                            ? "All Verified"
                            : item.overallStatus === "stopped_withdrawn"
                            ? "Revoked"
                            : "—"}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.overallStatus === "active" && (
                          <button
                            type="button"
                            className="consent-btn-accept"
                            style={{ fontSize: 11, padding: "5px 10px" }}
                            title="Resend upload link and reminder immediately"
                            onClick={(e) => handleResend(item.customerId, e)}
                            disabled={resendingId === item.customerId}
                            id={`btn-resend-reminder-${item.customerId}`}
                          >
                            <IconSend size={12} />
                            <span>
                              {resendingId === item.customerId ? "Sending…" : "Resend"}
                            </span>
                          </button>
                        )}

                        <button
                          type="button"
                          className="consent-btn-decline"
                          style={{ fontSize: 11, padding: "5px 8px" }}
                          title="View customer notification timeline"
                          onClick={() => setSelectedTimelineCustomer(item)}
                          id={`btn-view-timeline-${item.customerId}`}
                        >
                          <IconMail size={13} />
                        </button>

                        <button
                          type="button"
                          className="consent-btn-decline"
                          style={{ fontSize: 11, padding: "5px 8px" }}
                          title="Open Customer Detail Page"
                          onClick={() => onOpenCustomerDetail(item.customerId)}
                          id={`btn-open-customer-${item.customerId}`}
                        >
                          <IconEye size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Customer Notification Timeline Drawer */}
      {selectedTimelineCustomer && (
        <div
          className="notification-timeline-drawer-backdrop"
          onClick={() => setSelectedTimelineCustomer(null)}
          id="customer-notification-timeline-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notification-drawer-title"
        >
          <div
            ref={timelineDrawerRef}
            className="notification-timeline-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notification-drawer-header">
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--adm-primary, #60a5fa)", textTransform: "uppercase" }}>
                  Customer Notification Timeline
                </div>
                <h3 id="notification-drawer-title" style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700, color: "var(--adm-text, #f1f5f9)" }}>
                  {selectedTimelineCustomer.customerName} ({selectedTimelineCustomer.customerCode})
                </h3>
              </div>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => setSelectedTimelineCustomer(null)}
                id="btn-close-notification-drawer"
                aria-label="Close notification drawer"
              >
                <IconX size={18} />
              </button>
            </div>

            <div className="notification-drawer-body">
              {/* Summary Status Header */}
              <div
                style={{
                  background: "rgba(15, 23, 42, 0.4)",
                  border: "1px solid var(--adm-border, rgba(59, 130, 246, 0.2))",
                  borderRadius: 10,
                  padding: "12px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: "var(--adm-text-muted, #94a3b8)" }}>
                    Current Schedule Status
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--adm-text, #f1f5f9)", marginTop: 2 }}>
                    {selectedTimelineCustomer.overallLabel}
                  </div>
                </div>
                <div>
                  <span
                    className={`doc-count-badge ${
                      selectedTimelineCustomer.pendingCount === 0 ? "complete" : "pending"
                    }`}
                  >
                    {selectedTimelineCustomer.pendingCount} pending
                  </span>
                </div>
              </div>

              {selectedTimelineCustomer.stoppedReason && (
                <div
                  style={{
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px solid rgba(239, 68, 68, 0.2)",
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 12,
                    color: "var(--adm-text-secondary, #94a3b8)",
                    lineHeight: 1.5,
                  }}
                >
                  {selectedTimelineCustomer.stoppedReason}
                </div>
              )}

              {/* Event Timeline List */}
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--adm-text-secondary, #94a3b8)", textTransform: "uppercase", marginBottom: 16 }}>
                  Chronological Notification Audit Log
                </div>

                {selectedTimelineCustomer.notificationHistory.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: "var(--adm-text-muted, #94a3b8)", fontSize: 13 }}>
                    No notification events recorded yet for this customer.
                  </div>
                ) : (
                  selectedTimelineCustomer.notificationHistory.map((event) => {
                    const isReminder = event.action === "reminder_sent";
                    const isSuccess = event.action === "case_completed" || event.action === "consent_granted";
                    const isWarning = event.action === "retention_deleted" || event.action === "privacy_deleted";

                    return (
                      <div className="timeline-event-card" key={event.id}>
                        <div
                          className={`timeline-event-dot ${
                            isReminder
                              ? ""
                              : isSuccess
                              ? "green"
                              : isWarning
                              ? "rose"
                              : "amber"
                          }`}
                        />
                        <div className="timeline-event-title">
                          {event.actionLabel}
                        </div>
                        <div className="timeline-event-meta">
                          <span>{new Date(event.at).toLocaleString()}</span>
                          <span>•</span>
                          <span style={{ textTransform: "capitalize" }}>
                            Actor: {event.actor}
                          </span>
                          {event.pendingCount !== undefined && (
                            <>
                              <span>•</span>
                              <span>{event.pendingCount} pending doc(s)</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
