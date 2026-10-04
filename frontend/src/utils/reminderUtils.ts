import type { AdminCustomerListItem, AdminCustomerDetail, AdminAuditItem } from "../types";

export type ReminderMilestoneStage = 3 | 7 | 14;

export type MilestoneStatus = "sent" | "scheduled" | "stopped" | "overdue" | "not_due";

export type CustomerReminderOverallStatus =
  | "active"
  | "stopped_completed"
  | "stopped_withdrawn"
  | "awaiting_consent"
  | "completed_schedule";

export interface MilestoneInfo {
  stage: ReminderMilestoneStage;
  label: string;
  status: MilestoneStatus;
  sentAt?: string;
  targetDate?: string;
  daysRemaining?: number;
}

export interface CustomerNotificationEvent {
  id: string | number;
  at: string;
  action: string;
  actionLabel: string;
  actor: string;
  stage?: number;
  pendingCount?: number;
  details?: Record<string, unknown>;
}

export interface CustomerReminderState {
  customerId: number;
  customerName: string;
  customerCode: string;
  customerEmail: string;
  caseStatus: string;
  consentStatus: string;
  pendingCount: number;
  overallStatus: CustomerReminderOverallStatus;
  overallLabel: string;
  stoppedReason?: string;
  consentAt?: string | null;
  stages: {
    stage3: MilestoneInfo;
    stage7: MilestoneInfo;
    stage14: MilestoneInfo;
  };
  lastReminder: {
    stage: number;
    sentAt: string;
    type: string;
  } | null;
  nextReminder: {
    stage: number;
    targetDate: string;
    daysRemaining: number;
  } | null;
  notificationHistory: CustomerNotificationEvent[];
}

export function computeCustomerReminderState(
  customer: AdminCustomerListItem | AdminCustomerDetail,
  allAuditLogs: AdminAuditItem[] = []
): CustomerReminderState {
  const customerId = customer.id;
  const now = Date.now();

  // 1. Filter customer-related audit events
  const customerLogs = allAuditLogs.filter(
    (log) =>
      log.entity_type === "customer" &&
      String(log.entity_id) === String(customerId)
  );

  // Sort chronological descending (newest first)
  customerLogs.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );

  // 2. Identify consent timestamp
  let consentAtTime: number | null = null;
  const consentGrantedLog = customerLogs.find(
    (l) => l.action === "consent_granted"
  );
  if (consentGrantedLog) {
    consentAtTime = new Date(consentGrantedLog.at).getTime();
  } else if ("consent_at" in customer && typeof customer.consent_at === "string" && customer.consent_at) {
    consentAtTime = new Date(customer.consent_at).getTime();
  } else if (customer.consent_status === "granted") {
    consentAtTime = new Date(customer.created_at).getTime();
  }

  // 3. Determine Overall Status & Stopped Rationale
  let overallStatus: CustomerReminderOverallStatus = "active";
  let overallLabel = "Active (3/7/14-Day Cycle)";
  let stoppedReason: string | undefined = undefined;

  const isCompleted =
    customer.case_status === "completed" ||
    (customer.pending_count !== undefined && customer.pending_count === 0);

  const isWithdrawn =
    customer.consent_status === "withdrawn" ||
    (customer.case_status as string) === "consent_withdrawn";

  const isDeclined =
    customer.consent_status === "declined" ||
    (customer.case_status as string) === "consent_declined";

  const isAwaitingConsent = customer.consent_status === "pending";

  if (isCompleted) {
    overallStatus = "stopped_completed";
    overallLabel = "Reminders Stopped • All Documents Verified";
    stoppedReason = "All required documents have been verified. Automated reminder schedulers permanently stopped.";
  } else if (isWithdrawn) {
    overallStatus = "stopped_withdrawn";
    overallLabel = "Reminders Stopped • Consent Revoked";
    stoppedReason = "Consent was revoked under India DPDP Act 2023. Automated reminder schedulers and upload links halted.";
  } else if (isDeclined) {
    overallStatus = "stopped_withdrawn";
    overallLabel = "Reminders Stopped • Consent Declined";
    stoppedReason = "Customer declined consent. Automated reminders halted.";
  } else if (isAwaitingConsent) {
    overallStatus = "awaiting_consent";
    overallLabel = "Reminders Paused • Awaiting Consent";
    stoppedReason = "Customer has not yet granted consent. 3/7/14-day reminder schedule will begin upon consent.";
  }

  // 4. Find Sent Reminder Logs
  const reminderLogs = customerLogs.filter((l) => l.action === "reminder_sent");
  const stage3Log = reminderLogs.find(
    (l) => (l.details as { stage?: number })?.stage === 3
  );
  const stage7Log = reminderLogs.find(
    (l) => (l.details as { stage?: number })?.stage === 7
  );
  const stage14Log = reminderLogs.find(
    (l) => (l.details as { stage?: number })?.stage === 14
  );

  // 5. Calculate Milestones
  const calculateMilestone = (
    stage: ReminderMilestoneStage,
    label: string,
    sentLog?: AdminAuditItem
  ): MilestoneInfo => {
    if (sentLog) {
      return {
        stage,
        label,
        status: "sent",
        sentAt: sentLog.at,
      };
    }

    if (overallStatus === "stopped_completed" || overallStatus === "stopped_withdrawn") {
      return {
        stage,
        label,
        status: "stopped",
      };
    }

    if (overallStatus === "awaiting_consent" || !consentAtTime) {
      return {
        stage,
        label,
        status: "not_due",
      };
    }

    const targetTime = consentAtTime + stage * 24 * 60 * 60 * 1000;
    const diffMs = targetTime - now;
    const daysRemaining = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));

    if (diffMs <= 0) {
      return {
        stage,
        label,
        status: "overdue",
        targetDate: new Date(targetTime).toISOString(),
        daysRemaining: 0,
      };
    }

    return {
      stage,
      label,
      status: "scheduled",
      targetDate: new Date(targetTime).toISOString(),
      daysRemaining,
    };
  };

  const stage3 = calculateMilestone(3, "Day 3 Reminder", stage3Log);
  const stage7 = calculateMilestone(7, "Day 7 Reminder", stage7Log);
  const stage14 = calculateMilestone(14, "Day 14 Final Notice", stage14Log);

  // Check if schedule completed
  if (
    overallStatus === "active" &&
    stage14.status === "sent"
  ) {
    overallStatus = "completed_schedule";
    overallLabel = "Schedule Completed (14+ Days)";
    stoppedReason = "14-day maximum reminder cycle has completed. No further automated reminders will be dispatched.";
  }

  // 6. Calculate Last Reminder
  let lastReminder: { stage: number; sentAt: string; type: string } | null = null;
  if (stage14Log) {
    lastReminder = { stage: 14, sentAt: stage14Log.at, type: "Day 14 Final Notice" };
  } else if (stage7Log) {
    lastReminder = { stage: 7, sentAt: stage7Log.at, type: "Day 7 Reminder" };
  } else if (stage3Log) {
    lastReminder = { stage: 3, sentAt: stage3Log.at, type: "Day 3 Reminder" };
  } else {
    // Check initial upload link
    const uploadLinkLog = customerLogs.find(
      (l) => l.action === "upload_link_sent" || l.action === "upload_link_resent"
    );
    if (uploadLinkLog) {
      lastReminder = {
        stage: 0,
        sentAt: uploadLinkLog.at,
        type: uploadLinkLog.action === "upload_link_resent" ? "Upload Link (Re-sent)" : "Initial Upload Link",
      };
    }
  }

  // 7. Calculate Next Reminder
  let nextReminder: { stage: number; targetDate: string; daysRemaining: number } | null = null;
  if (overallStatus === "active") {
    if (stage3.status === "scheduled" || stage3.status === "overdue") {
      nextReminder = {
        stage: 3,
        targetDate: stage3.targetDate || new Date().toISOString(),
        daysRemaining: stage3.daysRemaining || 0,
      };
    } else if (stage7.status === "scheduled" || stage7.status === "overdue") {
      nextReminder = {
        stage: 7,
        targetDate: stage7.targetDate || new Date().toISOString(),
        daysRemaining: stage7.daysRemaining || 0,
      };
    } else if (stage14.status === "scheduled" || stage14.status === "overdue") {
      nextReminder = {
        stage: 14,
        targetDate: stage14.targetDate || new Date().toISOString(),
        daysRemaining: stage14.daysRemaining || 0,
      };
    }
  }

  // 8. Construct Chronological Notification History
  const notificationHistory: CustomerNotificationEvent[] = customerLogs
    .filter((log) =>
      [
        "reminder_sent",
        "upload_link_sent",
        "upload_link_resent",
        "consent_email_sent",
        "consent_requested",
        "case_completed",
        "retention_deleted",
        "privacy_deleted",
      ].includes(log.action)
    )
    .map((log) => {
      let actionLabel = "Notification Dispatched";
      const details = log.details as Record<string, unknown> | undefined;

      switch (log.action) {
        case "reminder_sent": {
          const stage = (details?.stage as number) || 0;
          actionLabel = `Automated Reminder (Day ${stage})`;
          break;
        }
        case "upload_link_sent":
          actionLabel = "Initial Upload Link Dispatched";
          break;
        case "upload_link_resent":
          actionLabel = "Upload Link & Reminder Re-sent by Staff";
          break;
        case "consent_email_sent":
        case "consent_requested":
          actionLabel = "Consent Request Email Dispatched";
          break;
        case "case_completed":
          actionLabel = "Verification Completion Confirmation";
          break;
        case "retention_deleted":
          actionLabel = "Statutory Retention Deletion Notice";
          break;
        case "privacy_deleted":
          actionLabel = "DPDP Erasure Confirmation Notice";
          break;
      }

      return {
        id: log.id,
        at: log.at,
        action: log.action,
        actionLabel,
        actor: log.actor || "system",
        stage: details?.stage as number | undefined,
        pendingCount: details?.pending_count as number | undefined,
        details,
      };
    });

  return {
    customerId,
    customerName: customer.name,
    customerCode: customer.code,
    customerEmail: customer.email,
    caseStatus: customer.case_status,
    consentStatus: customer.consent_status,
    pendingCount: customer.pending_count ?? 0,
    overallStatus,
    overallLabel,
    stoppedReason,
    consentAt: consentAtTime ? new Date(consentAtTime).toISOString() : null,
    stages: {
      stage3,
      stage7,
      stage14,
    },
    lastReminder,
    nextReminder,
    notificationHistory,
  };
}
