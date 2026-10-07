import type {
  AdminAuditItem,
  AdminCustomerDetail,
  AdminCustomerListItem,
  AdminDocumentItem,
  AdminReviewItem,
  AdminSummary,
  ConsentInfo,
  DocumentStatusResponse,
  PortalState,
  PrivacyResponse,
  UploadResponse,
} from "./types";


const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8080";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link: "This link is invalid or has expired. Ask for a new link by email.",
  consent_required: "We need your consent before you can upload documents.",
  case_not_open: "This case is closed, so uploads are no longer accepted.",
  consent_already_recorded: "Your response has already been recorded.",
  missing_token: "Please sign in to continue.",
  invalid_token: "Your session has expired. Please sign in again.",
  not_an_admin: "This account is not authorized to access the staff portal.",
  file_deleted: "This file has already been permanently deleted.",
  download_disabled: "File downloads are disabled by policy.",
  already_decided: "This review has already been decided.",
  not_found: "The requested item was not found.",
  otp_required: "Email verification code required before uploading documents.",
  invalid_or_expired_otp: "The verification code is invalid or has expired. Please request a new one.",
  file_content_mismatch: "The file content does not match its expected type.",
  unsafe_file: "Active script or unsafe content detected. Please upload a standard document.",
  unsafe_pdf: "This PDF contains active scripting and cannot be accepted.",
  password_protected_pdf: "This PDF is password protected. Please upload an unprotected copy.",
  file_too_large: "The file exceeds the allowed size limit.",
  empty_file: "The uploaded file is empty.",
  unsupported_file_type: "Only PDF, PNG, and JPG files are accepted.",
  rate_limited: "Too many requests. Please wait a moment and try again.",
  case_already_closed: "This case is already closed.",
  data_already_deleted: "This customer's data has already been permanently deleted.",
};

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function formatErrorMessage(raw: unknown): string {
  if (typeof raw === "string") {
    return ERROR_MESSAGES[raw] || raw;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const code = typeof obj.code === "string" ? obj.code : undefined;
    const msg = typeof obj.message === "string" ? obj.message : undefined;
    if (code && ERROR_MESSAGES[code]) {
      return ERROR_MESSAGES[code];
    }
    if (msg) {
      return ERROR_MESSAGES[msg] || msg;
    }
  }
  return "An unexpected error occurred. Please try again.";
}

// ---------------- Admin JWT session handling ----------------
const JWT_STORAGE_KEY = "docpilot_staff_jwt";

export function getAdminToken(): string | null {
  return sessionStorage.getItem(JWT_STORAGE_KEY);
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(JWT_STORAGE_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(JWT_STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return !!getAdminToken();
}

// ---------------- Core request handler ----------------
interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  isAdmin?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers || {}) };

  if (options.isAdmin) {
    const token = getAdminToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers,
      body,
    });
  } catch {
    throw new ApiError(0, "Unable to reach the server. Please check your internet connection.");
  }

  if (!response.ok) {
    let errorDetail: unknown = null;
    try {
      const errJson = await response.json();
      errorDetail = errJson.detail || errJson;
    } catch {
      // response wasn't JSON
    }

    if (options.isAdmin && response.status === 401) {
      clearAdminToken();
    }

    const plainMessage = formatErrorMessage(errorDetail);
    const code = typeof errorDetail === "object" && errorDetail && "code" in errorDetail
      ? String((errorDetail as { code: unknown }).code)
      : undefined;

    throw new ApiError(response.status, plainMessage, code);
  }

  // Handle empty responses (e.g. 204)
  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

// ---------------- Customer Public Endpoints ----------------
export async function getConsent(token: string): Promise<ConsentInfo> {
  return request<ConsentInfo>(`/api/public/consent/${encodeURIComponent(token)}`);
}

export async function submitConsent(
  token: string,
  granted: boolean
): Promise<{ consent: string; upload_token?: string }> {
  return request<{ consent: string; upload_token?: string }>(`/api/public/consent/${encodeURIComponent(token)}`, {
    method: "POST",
    json: { granted },
  });
}

export async function getPortal(token: string): Promise<PortalState> {
  return request<PortalState>(`/api/portal/${encodeURIComponent(token)}`);
}

export async function sendPortalOtp(
  token: string
): Promise<{ sent: boolean; masked_email?: string }> {
  return request<{ sent: boolean; masked_email?: string }>(
    `/api/portal/${encodeURIComponent(token)}/otp/send`,
    { method: "POST" }
  );
}

export async function verifyPortalOtp(
  token: string,
  code: string
): Promise<{ verified: boolean }> {
  return request<{ verified: boolean }>(
    `/api/portal/${encodeURIComponent(token)}/otp/verify`,
    {
      method: "POST",
      json: { code },
    }
  );
}

export async function uploadDocument(
  token: string,
  docType: string,
  file: File
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("doc_type", docType);
  formData.append("file", file);

  return request<UploadResponse>(`/api/portal/${encodeURIComponent(token)}/upload`, {
    method: "POST",
    body: formData,
  });
}

export async function getDocumentStatus(
  token: string,
  documentId: string
): Promise<DocumentStatusResponse> {
  return request<DocumentStatusResponse>(
    `/api/portal/${encodeURIComponent(token)}/documents/${encodeURIComponent(documentId)}/status`
  );
}

export async function requestPrivacy(
  email: string,
  action: "delete" | "withdraw"
): Promise<PrivacyResponse> {
  return request<PrivacyResponse>("/api/public/privacy/request", {
    method: "POST",
    json: { email, action },
  });
}

export async function confirmPrivacy(token: string): Promise<PrivacyResponse> {
  return request<PrivacyResponse>(`/api/public/privacy/confirm/${encodeURIComponent(token)}`, {
    method: "POST",
  });
}

// ---------------- Admin Authentication ----------------
export async function loginAdmin(email: string, password: string): Promise<string> {
  if (!SUPABASE_ANON_KEY || !SUPABASE_ANON_KEY.trim()) {
    throw new ApiError(400, "Supabase Anon Key is missing. Please add VITE_SUPABASE_ANON_KEY to frontend/.env");
  }

  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email.trim(), password }),
    });
  } catch {
    throw new ApiError(0, "Unable to reach authentication server. Check your connection.");
  }

  if (!res.ok) {
    let message = "Sign in failed. Please check your email and password.";
    try {
      const errJson = await res.json();
      if (errJson.error_description) {
        message = errJson.error_description;
      } else if (errJson.msg) {
        message = errJson.msg;
      } else if (errJson.message) {
        message = errJson.message;
      }
    } catch {}
    throw new ApiError(res.status, message);
  }

  const data = (await res.json()) as { access_token: string };
  setAdminToken(data.access_token);
  return data.access_token;
}

export function logoutAdmin(): void {
  clearAdminToken();
}

// ---------------- Admin Management Endpoints ----------------
export async function getAdminSummary(): Promise<AdminSummary> {
  return request<AdminSummary>("/api/admin/summary", { isAdmin: true });
}

export async function getAdminCustomers(
  query: string = "",
  limit: number = 50,
  offset: number = 0,
  status: string = ""
): Promise<{ customers: AdminCustomerListItem[]; totalCount?: number }> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (status.trim()) params.set("status", status.trim());
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const url = `/api/admin/customers?${params.toString()}`;
  const headers: Record<string, string> = {};
  const token = getAdminToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${url}`, { headers });
  if (!res.ok) {
    let errorDetail: unknown = null;
    try {
      errorDetail = (await res.json()).detail;
    } catch {}
    throw new ApiError(res.status, formatErrorMessage(errorDetail));
  }

  const totalHeader = res.headers.get("X-Total-Count");
  const totalCount = totalHeader ? parseInt(totalHeader, 10) : undefined;
  const customers = (await res.json()) as AdminCustomerListItem[];

  return { customers, totalCount };
}

export async function getAdminDocuments(
  query: string = "",
  docType: string = "",
  verificationStatus: string = "",
  limit: number = 50,
  offset: number = 0,
  ocrStatus: string = ""
): Promise<{ documents: AdminDocumentItem[]; totalCount: number }> {
  const token = getAdminToken();
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (query.trim()) params.set("q", query.trim());
  if (docType.trim()) params.set("doc_type", docType.trim());
  if (verificationStatus.trim()) params.set("verification_status", verificationStatus.trim());
  if (ocrStatus.trim()) params.set("ocr_status", ocrStatus.trim());

  const url = `${API_BASE}/api/admin/documents?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token || ""}`,
      },
    });
  } catch {
    throw new ApiError(0, "Unable to reach server. Please check your connection.");
  }

  if (!res.ok) {
    if (res.status === 401) clearAdminToken();
    throw new ApiError(res.status, "Failed to load documents.");
  }

  const totalHeader = res.headers.get("X-Total-Count");
  const totalCount = totalHeader ? parseInt(totalHeader, 10) : 0;
  const documents = (await res.json()) as AdminDocumentItem[];

  return { documents, totalCount };
}

export async function getAdminCustomer(id: number): Promise<AdminCustomerDetail> {

  return request<AdminCustomerDetail>(`/api/admin/customers/${id}`, { isAdmin: true });
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  mobile?: string | null;
  required_documents: string[];
  send_consent?: boolean;
}

export async function createAdminCustomer(
  input: CreateCustomerInput
): Promise<AdminCustomerListItem> {
  return request<AdminCustomerListItem>("/api/admin/customers", {
    method: "POST",
    json: input,
    isAdmin: true,
  });
}

export async function closeAdminCase(
  customerId: number,
  reason?: string
): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/customers/${customerId}/close`, {
    method: "POST",
    json: reason ? { reason } : {},
    isAdmin: true,
  });
}

export async function deleteAdminCustomerData(
  customerId: number
): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/customers/${customerId}/delete-data`, {
    method: "POST",
    isAdmin: true,
  });
}

export async function resendConsentEmail(customerId: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/customers/${customerId}/send-consent`, {
    method: "POST",
    isAdmin: true,
  });
}

export async function resendUploadLink(customerId: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/customers/${customerId}/send-upload-link`, {
    method: "POST",
    isAdmin: true,
  });
}

export async function fetchDocumentFile(
  docId: string,
  download: boolean = false
): Promise<Blob> {
  const token = getAdminToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = `${API_BASE}/api/admin/documents/${encodeURIComponent(docId)}/file${
    download ? "?download=true" : ""
  }`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    let errorDetail: unknown = null;
    try {
      errorDetail = (await res.json()).detail;
    } catch {}
    throw new ApiError(res.status, formatErrorMessage(errorDetail));
  }

  return res.blob();
}

export async function deleteAdminDocumentFile(docId: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/api/admin/documents/${encodeURIComponent(docId)}/delete-file`,
    {
      method: "POST",
      isAdmin: true,
    }
  );
}

export async function getAdminReviews(status: string = "open"): Promise<AdminReviewItem[]> {
  return request<AdminReviewItem[]>(`/api/admin/reviews?status=${encodeURIComponent(status)}`, {
    isAdmin: true,
  });
}

export async function approveReview(id: string, note?: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/reviews/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    json: note ? { note } : {},
    isAdmin: true,
  });
}

export async function rejectReview(id: string, note?: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/admin/reviews/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    json: note ? { note } : {},
    isAdmin: true,
  });
}

export async function getAdminAudit(limit: number = 200): Promise<AdminAuditItem[]> {
  return request<AdminAuditItem[]>(`/api/admin/audit?limit=${limit}`, { isAdmin: true });
}

export interface OcrSettingsData {
  ocr_url: string;
  has_api_key: boolean;
  masked_api_key: string;
  mock_ocr_mode?: boolean;
  timeout_seconds?: number;
}

export async function getAdminOcrSettings(): Promise<OcrSettingsData> {
  return request<OcrSettingsData>("/api/admin/settings/ocr", { isAdmin: true });
}

export async function updateAdminOcrSettings(payload: { ocr_url?: string; ocr_api_key?: string }): Promise<OcrSettingsData> {
  return request<OcrSettingsData>("/api/admin/settings/ocr", {
    method: "PUT",
    json: payload,
    isAdmin: true,
  });
}

export async function testAdminOcrConnection(payload?: { ocr_url?: string; ocr_api_key?: string }): Promise<{ connected: boolean; status_code: number; message: string }> {
  return request<{ connected: boolean; status_code: number; message: string }>("/api/admin/settings/ocr/test", {
    method: "POST",
    json: payload || {},
    isAdmin: true,
  });
}

