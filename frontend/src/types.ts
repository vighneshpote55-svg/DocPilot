export type DocumentSlot =
  | "aadhaar"
  | "pan"
  | "passport"
  | "voter"
  | "driving_licence"
  | "bank_statement"
  | "salary_slip"
  | "cancelled_cheque"
  | "itr"
  | "udyam"
  | "shop_establishment"
  | "fssai"
  | "utility_bill"
  | "gst_certificate"
  | "certificate_of_incorporation"
  | "partnership_deed"
  | "rent_agreement"
  | "form_16"
  | "bank_passbook"
  | "property_tax_receipt"
  | "iec_certificate"
  | "income_certificate";

export type CustomerDocState =
  | "pending_upload"
  | "processing"
  | "under_review"
  | "resubmit"
  | "verified";

export type CaseStatus =
  | "in_progress"
  | "completed"
  | "expired"
  | "withdrawn"
  | "deleted";

export type ConsentStatus = "pending" | "granted" | "declined" | "withdrawn";

export interface PortalDocument {
  doc_type: string;
  label: string;
  state: CustomerDocState;
  document_id: string | null;
}

export interface PortalState {
  first_name: string;
  case_status: CaseStatus;
  documents: PortalDocument[];
  required_count?: number;
  received_count?: number;
  pending_count: number;
  allowed_types: string[];
  max_upload_mb: number;
  otp_required: boolean;
  otp_verified: boolean;
  masked_email: string | null;
}

export interface UploadResponse {
  document_id: string;
  doc_type: string;
  label: string;
  state: CustomerDocState;
}

export interface DocumentStatusResponse {
  document_id: string;
  state: CustomerDocState;
  message?: string;
}

export interface ConsentInfo {
  first_name: string;
  documents: string[];
  purpose: string;
}

export interface PrivacyResponse {
  message?: string;
  completed?: "delete" | "withdraw";
}

export interface AdminMetrics {
  total_customers: number;
  completed_customers: number;
  completion_rate: number;
  total_documents: number;
  verified_documents: number;
  pending_review_documents: number;
  processing_documents: number;
  ocr_failures: number;
}

export interface AdminSummary {
  cases: {
    in_progress?: number;
    completed?: number;
    expired?: number;
    withdrawn?: number;
    deleted?: number;
  };
  documents?: Record<string, number>;
  open_reviews: number;
  jobs: {
    queued?: number;
    running?: number;
    failed?: number;
  };
  metrics?: AdminMetrics;
}

export interface AdminDocumentItem {
  id: string;
  doc_type: string;
  label: string;
  filename: string;
  uploaded_at: string;
  ocr_status: string;
  verification_status: string;
  needs_manual_review: boolean;
  review_reason: string | null;
  flags: string[];
  confidence: number | null;
  file_state: "stored" | "deleted";
  delete_after: string | null;
  superseded: boolean;
  customer_id: number;
  customer_name: string;
  customer_code: string;
  customer_email: string;
}


export interface AdminCustomerListItem {
  id: number;
  code: string;
  name: string;
  email: string;
  mobile: string | null;
  consent_status: ConsentStatus;
  case_status: CaseStatus;
  required_count: number;
  received_count: number;
  pending_count?: number;
  created_at: string;
}

export interface AdminDocumentItem {
  id: string;
  doc_type: string;
  label: string;
  filename: string;
  file_state: "stored" | "deleted";
  ocr_status: string;
  verification_status: string;
  uploaded_at: string;
  review_reason: string | null;
  superseded: boolean;
}

export interface AdminCustomerDetail {
  id: number;
  code: string;
  name: string;
  email: string;
  mobile: string | null;
  consent_status: ConsentStatus;
  case_status: CaseStatus;
  created_at: string;
  completed_at: string | null;
  delete_after: string | null;
  data_deleted_at: string | null;
  required_count: number;
  received_count: number;
  pending_count: number;
  allow_download?: boolean;
  required: Array<{
    doc_type: string;
    label: string;
    state: CustomerDocState;
    is_pending?: boolean;
    verification_status?: string;
    document_id: string | null;
  }>;
  documents: AdminDocumentItem[];
}

export interface AdminReviewItem {
  id: string;
  customer_id: number;
  customer_name: string;
  customer_code: string;
  reason: string | null;
  flags: string[];
  created_at: string;
  document: {
    id: string;
    doc_type: string;
    label: string;
    ocr_status?: string;
    verification_status?: string;
  };
  ocr_evidence?: Record<string, any>;
  resubmission_status?: string;
}

export interface AdminAuditItem {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown>;
}

export interface ApiError {
  status: number;
  code?: string;
  message: string;
}
