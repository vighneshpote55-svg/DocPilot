import * as XLSX from "xlsx";

export interface SupportedDocType {
  key: string;
  label: string;
  category: "Identity" | "Financial" | "Business" | "Address & Other";
  description: string;
}

export const SUPPORTED_DOC_TYPES: SupportedDocType[] = [
  { key: "pan", label: "PAN Card", category: "Identity", description: "Permanent Account Number issued by Income Tax Dept" },
  { key: "aadhaar", label: "Aadhaar Card", category: "Identity", description: "UIDAI 12-digit Aadhaar Card (front or combined)" },
  { key: "passport", label: "Passport", category: "Identity", description: "Indian or International Passport biodata page" },
  { key: "voter", label: "Voter ID", category: "Identity", description: "Election Commission Electoral Photo Identity Card (EPIC)" },
  { key: "driving_licence", label: "Driving Licence", category: "Identity", description: "State Transport Dept Issued Driving Licence" },
  { key: "bank_statement", label: "Bank Statement", category: "Financial", description: "3-6 months official bank account statement (PDF/scan)" },
  { key: "salary_slip", label: "Salary Slip / Payslip", category: "Financial", description: "Recent employer pay voucher or salary statement" },
  { key: "cancelled_cheque", label: "Cancelled Cheque", category: "Financial", description: "Personal or business bank cheque with account & IFSC" },
  { key: "itr", label: "ITR Acknowledgement", category: "Financial", description: "Income Tax Return Verification / ITR-V Ack" },
  { key: "form_16", label: "Form 16", category: "Financial", description: "Certificate of tax deducted at source by employer" },
  { key: "bank_passbook", label: "Bank Passbook", category: "Financial", description: "Bank passbook front page with account details" },
  { key: "udyam", label: "Udyam Registration", category: "Business", description: "MSME Udyam Registration Certificate" },
  { key: "gst_certificate", label: "GST Registration", category: "Business", description: "GST Form REG-06 Registration Certificate" },
  { key: "shop_establishment", label: "Shop & Establishment", category: "Business", description: "Municipal Trade License or Gumasta Certificate" },
  { key: "certificate_of_incorporation", label: "Cert. of Incorporation", category: "Business", description: "MCA Certificate of Incorporation (CIN)" },
  { key: "partnership_deed", label: "Partnership Deed", category: "Business", description: "Registered Partnership Agreement / LLP Deed" },
  { key: "fssai", label: "FSSAI Certificate", category: "Business", description: "Food Safety and Standards Authority of India License" },
  { key: "iec_certificate", label: "IEC Certificate", category: "Business", description: "Importer Exporter Code Certificate from DGFT" },
  { key: "utility_bill", label: "Utility Bill", category: "Address & Other", description: "Electricity, Water, or Piped Gas Bill within 90 days" },
  { key: "rent_agreement", label: "Rent Agreement", category: "Address & Other", description: "Registered Lease or Rental Agreement" },
  { key: "property_tax_receipt", label: "Property Tax Receipt", category: "Address & Other", description: "Municipal Property or House Tax Paid Receipt" },
  { key: "income_certificate", label: "Income Certificate", category: "Address & Other", description: "Revenue Authority or Tehsildar Income Certificate" },
];

// Map lookup table for quick matching by key and normalized label
const DOC_LOOKUP: Map<string, string> = new Map();
SUPPORTED_DOC_TYPES.forEach((d) => {
  DOC_LOOKUP.set(d.key.toLowerCase(), d.key);
  DOC_LOOKUP.set(d.label.toLowerCase().replace(/[^a-z0-9]/g, ""), d.key);
});
// Common aliases
DOC_LOOKUP.set("pancard", "pan");
DOC_LOOKUP.set("aadhaarcard", "aadhaar");
DOC_LOOKUP.set("aadhar", "aadhaar");
DOC_LOOKUP.set("aadharcard", "aadhaar");
DOC_LOOKUP.set("dl", "driving_licence");
DOC_LOOKUP.set("drivinglicense", "driving_licence");
DOC_LOOKUP.set("gst", "gst_certificate");
DOC_LOOKUP.set("msme", "udyam");
DOC_LOOKUP.set("cheque", "cancelled_cheque");
DOC_LOOKUP.set("payslip", "salary_slip");

export interface ExcelImportRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  name: string;
  email: string;
  mobile: string;
  requiredDocuments: string[];
  sendConsent: boolean;
  status: "valid" | "warning" | "invalid";
  issues: string[];
  isDuplicateInFile?: boolean;
  isDuplicateInDb?: boolean;
}

export interface ExcelParseResult {
  fileName: string;
  totalRows: number;
  validRows: number;
  warningRows: number;
  invalidRows: number;
  rows: ExcelImportRow[];
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/**
 * Normalizes a list of document strings or tokens into supported document keys.
 */
export function normalizeDocTypes(input: string | string[]): {
  valid: string[];
  unknown: string[];
} {
  const tokens = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[,;\n\r|]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const valid: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const rawClean = token.trim();
    if (!rawClean) continue;

    const normalized = rawClean.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matchedKey = DOC_LOOKUP.get(rawClean.toLowerCase()) || DOC_LOOKUP.get(normalized);

    if (matchedKey) {
      if (!seen.has(matchedKey)) {
        seen.add(matchedKey);
        valid.push(matchedKey);
      }
    } else {
      unknown.push(rawClean);
    }
  }

  // If nothing provided at all, fallback to PAN
  if (valid.length === 0 && unknown.length === 0) {
    valid.push("pan");
  }

  return { valid, unknown };
}

/**
 * Generates and triggers download of a pre-formatted .xlsx template.
 */
export function downloadSampleExcelTemplate(): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Customers Template
  const sampleData = [
    {
      "Full Name": "Vikram Malhotra",
      "Email Address": "vikram.malhotra@example.com",
      "Mobile Number": "+91 98765 43210",
      "Required Documents": "pan, aadhaar, bank_statement",
      "Send Consent Email": "Yes",
    },
    {
      "Full Name": "Priya Sharma",
      "Email Address": "priya.sharma@example.com",
      "Mobile Number": "+91 98123 45678",
      "Required Documents": "pan, aadhaar, salary_slip, bank_statement",
      "Send Consent Email": "Yes",
    },
    {
      "Full Name": "Apex Enterprises (Ramesh Patel)",
      "Email Address": "ramesh@apexenterprises.in",
      "Mobile Number": "+91 99000 11222",
      "Required Documents": "pan, gst_certificate, udyam, bank_statement",
      "Send Consent Email": "No",
    },
  ];

  const wsCustomers = XLSX.utils.json_to_sheet(sampleData);
  // Column widths
  wsCustomers["!cols"] = [
    { wch: 32 }, // Full Name
    { wch: 34 }, // Email Address
    { wch: 20 }, // Mobile Number
    { wch: 45 }, // Required Documents
    { wch: 20 }, // Send Consent Email
  ];

  XLSX.utils.book_append_sheet(wb, wsCustomers, "Customers");

  // Sheet 2: Supported Documents Reference
  const docRefData = SUPPORTED_DOC_TYPES.map((d) => ({
    "Document Key": d.key,
    "Document Name": d.label,
    Category: d.category,
    Description: d.description,
  }));

  const wsDocs = XLSX.utils.json_to_sheet(docRefData);
  wsDocs["!cols"] = [
    { wch: 28 }, // Document Key
    { wch: 28 }, // Document Name
    { wch: 18 }, // Category
    { wch: 55 }, // Description
  ];

  XLSX.utils.book_append_sheet(wb, wsDocs, "Supported Documents");

  XLSX.writeFile(wb, "DocPilot_Customer_Intake_Template.xlsx");
}

/**
 * Parses an uploaded .xlsx file ArrayBuffer into structured rows with validation.
 */
export function parseExcelBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  existingDbEmails: Set<string> = new Set()
): ExcelParseResult {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new Error("The uploaded Excel workbook contains no worksheets.");
  }

  const sheet = wb.Sheets[sheetName];
  // Parse rows as raw 2D array or objects
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  if (!rawRows || rawRows.length === 0) {
    throw new Error("No data rows found in the uploaded worksheet.");
  }

  const emailCountsInFile = new Map<string, number>();
  // Pre-scan emails to flag duplicates in file
  rawRows.forEach((row) => {
    const emailVal = extractField(row, ["email", "email address", "customer email", "e-mail"]);
    const cleaned = emailVal.trim().toLowerCase();
    if (cleaned) {
      emailCountsInFile.set(cleaned, (emailCountsInFile.get(cleaned) || 0) + 1);
    }
  });

  const parsedRows: ExcelImportRow[] = [];

  rawRows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for 0-index, +1 for header row
    const rawRecord: Record<string, string> = {};
    Object.entries(row).forEach(([k, v]) => {
      rawRecord[k] = String(v ?? "").trim();
    });

    const name = extractField(row, ["full name", "name", "customer name", "client name", "customer"]);
    const email = extractField(row, ["email address", "email", "customer email", "e-mail"]);
    const mobile = extractField(row, ["mobile number", "mobile", "phone", "phone number", "contact"]);
    const docsRaw = extractField(row, ["required documents", "required docs", "documents", "docs", "required"]);
    const consentRaw = extractField(row, ["send consent email", "send consent", "consent", "send_consent", "notify"]);

    const issues: string[] = [];
    let isWarning = false;
    let isInvalid = false;

    // Validate Name
    if (!name) {
      issues.push("Customer name is missing.");
      isInvalid = true;
    } else if (name.length < 2) {
      issues.push("Customer name is too short (minimum 2 characters).");
      isInvalid = true;
    }

    // Validate Email
    const cleanedEmail = email.toLowerCase().trim();
    if (!cleanedEmail) {
      issues.push("Email address is missing.");
      isInvalid = true;
    } else if (!EMAIL_REGEX.test(cleanedEmail)) {
      issues.push(`Invalid email format: "${email}".`);
      isInvalid = true;
    }

    // Check Duplicate in File
    let isDuplicateInFile = false;
    if (cleanedEmail && (emailCountsInFile.get(cleanedEmail) || 0) > 1) {
      issues.push("Duplicate email address appears multiple times in this spreadsheet.");
      isDuplicateInFile = true;
      isWarning = true;
    }

    // Check Duplicate in DB
    let isDuplicateInDb = false;
    if (cleanedEmail && existingDbEmails.has(cleanedEmail)) {
      issues.push("Customer with this email address already exists in DocPilot.");
      isDuplicateInDb = true;
      isWarning = true;
    }

    // Validate & Normalize Documents
    const { valid: docKeys, unknown: unknownDocs } = normalizeDocTypes(docsRaw);
    if (unknownDocs.length > 0) {
      issues.push(`Unknown document types: ${unknownDocs.join(", ")}.`);
      isWarning = true;
    }
    if (docKeys.length === 0) {
      issues.push("No valid required documents found. Defaulted to PAN Card.");
      docKeys.push("pan");
      isWarning = true;
    }

    // Parse Consent flag
    const consentClean = consentRaw.toLowerCase();
    const sendConsent = consentClean === "" || consentClean === "yes" || consentClean === "true" || consentClean === "1";

    const status: "valid" | "warning" | "invalid" = isInvalid ? "invalid" : isWarning ? "warning" : "valid";

    parsedRows.push({
      id: `row-${rowNumber}-${index}`,
      rowNumber,
      raw: rawRecord,
      name,
      email: cleanedEmail,
      mobile,
      requiredDocuments: docKeys,
      sendConsent,
      status,
      issues,
      isDuplicateInFile,
      isDuplicateInDb,
    });
  });

  const validRows = parsedRows.filter((r) => r.status === "valid").length;
  const warningRows = parsedRows.filter((r) => r.status === "warning").length;
  const invalidRows = parsedRows.filter((r) => r.status === "invalid").length;

  return {
    fileName,
    totalRows: parsedRows.length,
    validRows,
    warningRows,
    invalidRows,
    rows: parsedRows,
  };
}

/**
 * Extracts a value from a row object checking multiple possible key headers.
 */
function extractField(row: Record<string, unknown>, candidateKeys: string[]): string {
  const rowEntries = Object.entries(row);
  for (const candidate of candidateKeys) {
    const match = rowEntries.find(([k]) => {
      const normalizedKey = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedCandidate = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalizedKey === normalizedCandidate;
    });
    if (match && match[1] !== undefined && match[1] !== null) {
      return String(match[1]).trim();
    }
  }
  return "";
}
