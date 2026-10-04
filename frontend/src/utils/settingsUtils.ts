import type { AdminSummary } from "../types";

export interface DecodedAdminJwt {
  email: string;
  sub: string;
  role: string;
  exp: number;
  iat: number;
  iss?: string;
}

export interface HealthProbeResult {
  status: "ok" | "degraded" | "error";
  latencyMs: number;
  timestamp: string;
  apiConnected: boolean;
  dbConnected: boolean;
  workerActive: boolean;
  message?: string;
}

/**
 * Probe API health and measure roundtrip network latency
 */
export async function probeSystemHealth(
  apiBaseUrl: string = "",
  summary?: AdminSummary | null
): Promise<HealthProbeResult> {
  const start = performance.now();
  const base = apiBaseUrl || import.meta.env.VITE_API_URL || "http://localhost:8080";

  let apiConnected = false;
  let status: "ok" | "degraded" | "error" = "ok";
  let message = "All systems operational";

  try {
    const res = await fetch(`${base}/health`, { method: "GET" });
    if (res.ok) {
      apiConnected = true;
    } else {
      status = "degraded";
      message = `API returned HTTP ${res.status}`;
    }
  } catch {
    status = "error";
    message = "Unable to reach API gateway";
  }

  const latencyMs = Math.round(performance.now() - start);

  // Derive database and worker status from summary if available
  const dbConnected = summary !== null && summary !== undefined;
  const workerActive = summary?.jobs?.running !== undefined || summary?.jobs?.queued !== undefined;

  if (!apiConnected) {
    status = "error";
  } else if (!dbConnected) {
    status = "degraded";
  }

  return {
    status,
    latencyMs,
    timestamp: new Date().toLocaleTimeString(),
    apiConnected,
    dbConnected,
    workerActive,
    message,
  };
}

/**
 * Safely parse a JWT payload without external libraries
 */
export function parseAdminJwt(token: string | null): DecodedAdminJwt | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    const parsed = JSON.parse(jsonPayload);
    return {
      email: parsed.email || "admin@docpilot.internal",
      sub: parsed.sub || parsed.id || "staff-admin-id",
      role: parsed.role || "authenticated",
      exp: typeof parsed.exp === "number" ? parsed.exp : Math.floor(Date.now() / 1000) + 3600,
      iat: typeof parsed.iat === "number" ? parsed.iat : Math.floor(Date.now() / 1000),
      iss: parsed.iss,
    };
  } catch {
    return null;
  }
}

/**
 * Format remaining session duration from JWT expiration timestamp
 */
export function formatSessionRemaining(expSeconds: number, nowMs: number = Date.now()): string {
  const expMs = expSeconds * 1000;
  const diffMs = expMs - nowMs;
  if (diffMs <= 0) return "Expired";

  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m remaining`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMins = totalMinutes % 60;
  return `${hours}h ${remainingMins}m remaining`;
}

/**
 * Mask sensitive credentials or secrets safely
 */
export function maskSecretValue(val?: string, visibleChars = 4): string {
  if (!val) return "••••••••••••••••••••••••••••••••";
  if (val.length <= visibleChars) return "••••••••";
  return `${val.slice(0, visibleChars)}••••••••••••••••••••••••`;
}

/**
 * Discovered backend configuration parameters mapped directly from backend/app/config.py
 */
export const SYSTEM_CONFIG = {
  // Core
  environment: import.meta.env.MODE || "development",
  apiBaseUrl: import.meta.env.VITE_API_URL || "http://localhost:8080",
  publicBaseUrl: "http://localhost:3000",
  corsOrigins: "http://localhost:3000, http://localhost:5180, http://localhost:5173",
  maxUploadMb: 10,

  // Storage & Cryptography
  storageBackend: "local | supabase",
  storageBucket: "case-documents",
  encryptionStandard: "AES-256-GCM",
  encryptionKeyStatus: "Active (256-bit symmetric key configured)",
  allowDownload: false, // File downloads strictly disabled by policy

  // OCR Service
  ocrUrl: "http://127.0.0.1:8000",
  ocrMode: "Stateless HTTP (Zero file storage on OCR server)",
  ocrTimeoutSeconds: 180,
  ocrMaxAttempts: 3,
  ocrOverallConfidence: 0.90, // 90%
  ocrFieldConfidence: 0.80, // 80%
  ocrPassExpectedName: true,
  ocrPiiMasking: "Mandatory Regex Redaction on Extraction",

  // AI Fallback
  aiEnabled: false, // AI fallback disabled by default (rules decide first)
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiPolicy: "Inconclusive rules fallback only; masked data only (zero image transmission)",

  // Retention Policies (DPDP Act, 2023)
  retentionDays: 7, // 7 days post-completion
  caseExpiryDays: 30, // 30 days incomplete case expiry
  uploadTokenHours: 72, // 72 hours
  consentTokenHours: 168, // 7 days (168 hours)
  privacyTokenMinutes: 30, // 30 minutes
  schedulerIntervalSeconds: 300, // 5 minutes sweep

  // Reminders Schedule
  reminderDays: "3, 7, 14",
  reminderChannel: "Email (SMTP / Outbox queue)",
  reminderAutoStop: "Immediate on Case Completion or Consent Withdrawal",

  // Security & Rate Limiting
  staffAuthStandard: "Supabase JWT (HS256) with Admin Email Whitelist",
  customerAuthStandard: "SHA-256 URL Token Hash Verification (Zero Customer IDs in URL)",
  rateLimitEnabled: true,
  rateLimitPortal: "60 req / min",
  rateLimitUpload: "15 req / min",
  rateLimitConsent: "20 req / min",
  rateLimitPrivacy: "10 req / min",
  uploadOtpEnabled: false,
  uploadOtpExpiryMinutes: 10,
  auditLogging: "Cryptographic, tamper-evident immutable log",
};
