import type {
  AdminAuditItem,
  AdminCustomerDetail,
  AdminCustomerListItem,
  AdminDocumentItem,
} from "../types";

export type RetentionState =
  | "scheduled"
  | "due"
  | "deleted"
  | "failed"
  | "none";

export interface PendingDataInventory {
  storedFilesCount: number;
  ocrRecordsCount: number;
  activeTokensCount: number;
  reviewNotesCount: number;
}

export interface CustomerRetentionInfo {
  state: RetentionState;
  stateLabel: string;
  scheduledAt: Date | null;
  deletedAt: Date | null;
  remainingMs: number;
  remainingFormatted: string;
  progressPercent: number;
  isUrgent: boolean;
  lifecycleTrigger: "completed" | "consent_withdrawn" | "expired" | "admin_purge" | "privacy_request" | "none";
  lifecycleLabel: string;
  pendingInventory: PendingDataInventory;
}

export interface RetentionSummaryMetrics {
  activeRetentionCount: number;
  duePurgeCount: number;
  permanentlyPurgedCount: number;
  pendingFilesCount: number;
  completedInRetentionCount: number;
  withdrawnInRetentionCount: number;
  expiredInRetentionCount: number;
}

const TOTAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Calculates detailed retention status and metrics for a given customer.
 */
export function computeRetentionInfo(
  customer: AdminCustomerListItem | AdminCustomerDetail,
  customerDocs?: AdminDocumentItem[]
): CustomerRetentionInfo {
  const now = Date.now();
  const docs = ("documents" in customer && customer.documents) ? customer.documents : (customerDocs || []);

  // Check if permanently purged first
  const isDeleted = !!customer.data_deleted_at || customer.case_status === "deleted";
  if (isDeleted) {
    const deletedDate = customer.data_deleted_at ? new Date(customer.data_deleted_at) : new Date();
    return {
      state: "deleted",
      stateLabel: "Permanently Purged",
      scheduledAt: customer.delete_after ? new Date(customer.delete_after) : null,
      deletedAt: deletedDate,
      remainingMs: 0,
      remainingFormatted: "Purged",
      progressPercent: 100,
      isUrgent: false,
      lifecycleTrigger: customer.consent_status === "withdrawn" ? "consent_withdrawn" : "completed",
      lifecycleLabel: "Cryptographically Wiped",
      pendingInventory: {
        storedFilesCount: 0,
        ocrRecordsCount: 0,
        activeTokensCount: 0,
        reviewNotesCount: 0,
      },
    };
  }

  // If delete_after is configured
  if (customer.delete_after) {
    const scheduledDate = new Date(customer.delete_after);
    const scheduledMs = scheduledDate.getTime();
    const remainingMs = scheduledMs - now;

    // Calculate elapsed retention progress percentage based on 7 days window
    const elapsedMs = Math.max(0, TOTAL_RETENTION_MS - remainingMs);
    const progressPercent = Math.min(100, Math.max(0, Math.round((elapsedMs / TOTAL_RETENTION_MS) * 100)));

    // Lifecycle trigger categorization
    let trigger: CustomerRetentionInfo["lifecycleTrigger"] = "completed";
    let triggerLabel = "Case Completed";

    if (customer.consent_status === "withdrawn") {
      trigger = "consent_withdrawn";
      triggerLabel = "DPDP Consent Withdrawn";
    } else if (customer.case_status === "expired") {
      trigger = "expired";
      triggerLabel = "Case Expired (30-Day Limit)";
    } else if (customer.case_status === "completed") {
      trigger = "completed";
      triggerLabel = "Verification Completed";
    }

    // Pending data calculation
    const storedFiles = docs.filter((d) => d.file_state === "stored").length;
    const pendingInventory: PendingDataInventory = {
      storedFilesCount: storedFiles,
      ocrRecordsCount: docs.length,
      activeTokensCount: customer.consent_status === "withdrawn" ? 0 : 1,
      reviewNotesCount: docs.filter((d) => d.needs_manual_review || d.review_reason).length,
    };

    if (remainingMs <= 0) {
      return {
        state: "due",
        stateLabel: "Due for Purge",
        scheduledAt: scheduledDate,
        deletedAt: null,
        remainingMs: 0,
        remainingFormatted: "Due today (In sweep queue)",
        progressPercent: 100,
        isUrgent: true,
        lifecycleTrigger: trigger,
        lifecycleLabel: triggerLabel,
        pendingInventory,
      };
    }

    // Still in 7-day retention grace period
    const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const formatted = days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;

    return {
      state: "scheduled",
      stateLabel: "In 7-Day Retention",
      scheduledAt: scheduledDate,
      deletedAt: null,
      remainingMs,
      remainingFormatted: formatted,
      progressPercent,
      isUrgent: days < 1,
      lifecycleTrigger: trigger,
      lifecycleLabel: triggerLabel,
      pendingInventory,
    };
  }

  // Not in retention cycle yet
  return {
    state: "none",
    stateLabel: "Active Intake",
    scheduledAt: null,
    deletedAt: null,
    remainingMs: 0,
    remainingFormatted: "Not scheduled",
    progressPercent: 0,
    isUrgent: false,
    lifecycleTrigger: "none",
    lifecycleLabel: "In Progress (Pre-retention)",
    pendingInventory: {
      storedFilesCount: docs.filter((d) => d.file_state === "stored").length,
      ocrRecordsCount: docs.length,
      activeTokensCount: 1,
      reviewNotesCount: 0,
    },
  };
}

/**
 * Calculates aggregate retention summary metrics across all customers.
 */
export function calculateRetentionSummary(
  customers: AdminCustomerListItem[],
  allDocs: AdminDocumentItem[] = []
): RetentionSummaryMetrics {
  let activeRetention = 0;
  let duePurge = 0;
  let permanentlyPurged = 0;
  let pendingFiles = 0;
  let completedInRetention = 0;
  let withdrawnInRetention = 0;
  let expiredInRetention = 0;

  for (const c of customers) {
    const docs = allDocs.filter((d) => d.customer_id === c.id);
    const info = computeRetentionInfo(c, docs);

    if (info.state === "scheduled") {
      activeRetention++;
      pendingFiles += info.pendingInventory.storedFilesCount;
      if (info.lifecycleTrigger === "completed") completedInRetention++;
      if (info.lifecycleTrigger === "consent_withdrawn") withdrawnInRetention++;
      if (info.lifecycleTrigger === "expired") expiredInRetention++;
    } else if (info.state === "due") {
      duePurge++;
      pendingFiles += info.pendingInventory.storedFilesCount;
    } else if (info.state === "deleted") {
      permanentlyPurged++;
    }
  }

  return {
    activeRetentionCount: activeRetention,
    duePurgeCount: duePurge,
    permanentlyPurgedCount: permanentlyPurged,
    pendingFilesCount: pendingFiles,
    completedInRetentionCount: completedInRetention,
    withdrawnInRetentionCount: withdrawnInRetention,
    expiredInRetentionCount: expiredInRetention,
  };
}

/**
 * Filters audit logs down to privacy, retention, and deletion events.
 */
export function filterRetentionAuditEvents(
  logs: AdminAuditItem[],
  customerId?: number
): AdminAuditItem[] {
  const RETENTION_ACTIONS = new Set([
    "retention_deleted",
    "customer_data_deleted",
    "file_marked_deleted",
    "privacy_delete",
    "privacy_withdraw",
    "case_expired",
    "case_closed",
  ]);

  return logs.filter((log) => {
    if (!RETENTION_ACTIONS.has(log.action)) return false;
    if (customerId !== undefined && customerId !== null) {
      if (log.entity_type === "customer" && log.entity_id === String(customerId)) return true;
      if (log.details && typeof log.details === "object" && (log.details as any).customer_id === customerId) {
        return true;
      }
      return false;
    }
    return true;
  });
}

/**
 * Formats a timestamp into human-readable local, UTC, and relative strings.
 */
export function formatRetentionDateTime(isoString: string | null | undefined): {
  local: string;
  utc: string;
  relative: string;
} {
  if (!isoString) {
    return { local: "—", utc: "—", relative: "—" };
  }
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = date.getTime() - now;

  let relative = "";
  if (Math.abs(diffMs) < 60000) {
    relative = "Just now";
  } else if (diffMs > 0) {
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    relative = days > 0 ? `In ${days}d ${hours}h` : `In ${hours}h`;
  } else {
    const pastMs = Math.abs(diffMs);
    const days = Math.floor(pastMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((pastMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    relative = days > 0 ? `${days}d ago` : `${hours}h ago`;
  }

  return {
    local: date.toLocaleString(),
    utc: date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
    relative,
  };
}
