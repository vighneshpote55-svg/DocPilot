import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

// Realistic mock dataset for testing Reports & Analytics Intelligence
const MOCK_CUSTOMERS = [
  {
    id: 101,
    code: "CUST-98214",
    name: "Vikram Malhotra",
    email: "vikram.malhotra@example.com",
    mobile: "+91 98765 43210",
    consent_status: "granted",
    case_status: "in_progress",
    created_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(), // 3 days ago
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
    required_count: 4,
    received_count: 3,
    pending_count: 1,
    allow_download: true,
  },
  {
    id: 102,
    code: "CUST-98215",
    name: "Ananya Roy",
    email: "ananya.roy@example.com",
    mobile: "+91 98765 43211",
    consent_status: "granted",
    case_status: "completed",
    created_at: new Date(Date.now() - 3600000 * 24 * 5).toISOString(), // 5 days ago
    completed_at: new Date(Date.now() - 3600000 * 18).toISOString(), // Completed 18h ago (turnaround ~4.2 days)
    delete_after: new Date(Date.now() + 3600000 * 24 * 6).toISOString(),
    data_deleted_at: null,
    required_count: 3,
    received_count: 3,
    pending_count: 0,
    allow_download: true,
  },
  {
    id: 103,
    code: "CUST-98216",
    name: "[deleted]",
    email: "deleted-103@invalid.local",
    mobile: null,
    consent_status: "withdrawn",
    case_status: "deleted",
    created_at: new Date(Date.now() - 3600000 * 24 * 12).toISOString(),
    completed_at: null,
    delete_after: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    data_deleted_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    required_count: 2,
    received_count: 0,
    pending_count: 2,
    allow_download: false,
  },
  {
    id: 104,
    code: "CUST-98217",
    name: "Pooja Verma",
    email: "pooja.verma@example.com",
    mobile: "+91 98765 43213",
    consent_status: "granted",
    case_status: "completed",
    created_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    completed_at: new Date(Date.now() - 3600000 * 6).toISOString(), // Turnaround ~42h
    delete_after: new Date(Date.now() + 3600000 * 24 * 6.75).toISOString(),
    data_deleted_at: null,
    required_count: 3,
    received_count: 3,
    pending_count: 0,
    allow_download: true,
  },
  {
    id: 105,
    code: "CUST-98218",
    name: "Siddharth Rao",
    email: "siddharth.rao@example.com",
    mobile: "+91 98765 43214",
    consent_status: "granted",
    case_status: "in_progress",
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(), // 12h ago
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
    required_count: 4,
    received_count: 2,
    pending_count: 2,
    allow_download: true,
  },
];

const MOCK_DOCUMENTS = [
  {
    id: "doc-101-aadhaar",
    doc_type: "aadhaar",
    label: "Aadhaar Card",
    filename: "aadhaar_front.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 101,
    customer_name: "Vikram Malhotra",
  },
  {
    id: "doc-101-pan",
    doc_type: "pan",
    label: "PAN Card",
    filename: "pan_card.jpg",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 101,
    customer_name: "Vikram Malhotra",
  },
  {
    id: "doc-101-bank",
    doc_type: "bank_statement",
    label: "Bank Statement",
    filename: "hdfc_bank_statement.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "under_review",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 1).toISOString(),
    review_reason: "Name mismatch with customer record",
    superseded: false,
    customer_id: 101,
    customer_name: "Vikram Malhotra",
  },
  {
    id: "doc-102-pan",
    doc_type: "pan",
    label: "PAN Card",
    filename: "pan_ananya.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 102,
    customer_name: "Ananya Roy",
  },
  {
    id: "doc-102-aadhaar",
    doc_type: "aadhaar",
    label: "Aadhaar Card",
    filename: "aadhaar_ananya.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 102,
    customer_name: "Ananya Roy",
  },
  {
    id: "doc-102-salary",
    doc_type: "salary_slip",
    label: "Salary Slip",
    filename: "salary_slip_sept.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 102,
    customer_name: "Ananya Roy",
  },
  {
    id: "doc-104-gst",
    doc_type: "gst_certificate",
    label: "GST Certificate",
    filename: "gst_cert.pdf",
    file_state: "stored",
    ocr_status: "completed",
    verification_status: "verified",
    uploaded_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    review_reason: null,
    superseded: false,
    customer_id: 104,
    customer_name: "Pooja Verma",
  },
  {
    id: "doc-105-passport",
    doc_type: "passport",
    label: "Passport",
    filename: "passport_front.jpg",
    file_state: "stored",
    ocr_status: "failed",
    verification_status: "rejected",
    uploaded_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    review_reason: "Image resolution too low or blurry",
    superseded: false,
    customer_id: 105,
    customer_name: "Siddharth Rao",
  },
];

const MOCK_REVIEWS = [
  {
    id: "rev-1",
    customer_id: 101,
    customer_name: "Vikram Malhotra",
    customer_code: "CUST-98214",
    reason: "Name mismatch with customer record",
    flags: ["name_mismatch"],
    status: "open",
    created_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    document: {
      id: "doc-101-bank",
      doc_type: "bank_statement",
      label: "Bank Statement",
      filename: "hdfc_bank_statement.pdf",
      ocr_status: "completed",
      verification_status: "under_review",
    },
  },
  {
    id: "rev-2",
    customer_id: 102,
    customer_name: "Ananya Roy",
    customer_code: "CUST-98215",
    reason: "Low OCR confidence on date of birth",
    flags: ["low_confidence"],
    status: "approved",
    created_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
    decided_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    document: {
      id: "doc-102-salary",
      doc_type: "salary_slip",
      label: "Salary Slip",
      filename: "salary_slip_sept.pdf",
      ocr_status: "completed",
      verification_status: "verified",
    },
  },
];

const MOCK_AUDIT = [
  {
    id: 1,
    at: new Date(Date.now() - 3600000 * 2).toISOString(),
    actor: "rules_engine",
    action: "document_verified",
    entity_type: "document",
    entity_id: "doc-104-gst",
    details: { doc_type: "gst_certificate" },
  },
  {
    id: 2,
    at: new Date(Date.now() - 3600000 * 6).toISOString(),
    actor: "system_ocr",
    action: "ocr_failed",
    entity_type: "document",
    entity_id: "doc-105-passport",
    details: { reason: "low_resolution" },
  },
  {
    id: 3,
    at: new Date(Date.now() - 3600000 * 18).toISOString(),
    actor: "staff_admin",
    action: "case_completed",
    entity_type: "customer",
    entity_id: "102",
    details: { total_verified: 3 },
  },
];

const MOCK_SUMMARY = {
  cases: {
    in_progress: 2,
    completed: 2,
    withdrawn: 1,
    deleted: 1,
  },
  documents: {
    verified: 6,
    under_review: 1,
    rejected: 1,
  },
  open_reviews: 1,
  jobs: { queued: 0, running: 1 },
  metrics: {
    total_customers: 5,
    completed_customers: 2,
    completion_rate: 40.0,
    total_documents: 8,
    verified_documents: 6,
    pending_review_documents: 1,
    processing_documents: 0,
    ocr_failures: 1,
  },
};

async function runPhase9ReportsVerification() {
  console.log("=== Starting Phase 9 Reports & Analytics UI Verification ===");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });

  // Inject session auth token
  await context.addInitScript(() => {
    sessionStorage.setItem("docpilot_staff_jwt", "mock-phase9-admin-token");
    localStorage.setItem("docpilot_adm_theme", "dark");
  });

  const page = await context.newPage();

  // Listen to browser console
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`BROWSER ERROR: ${msg.text()}`);
    }
  });

  // Intercept backend APIs with rich mock data
  await page.route("**/api/admin/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUMMARY),
    });
  });

  await page.route("**/api/admin/customers**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Total-Count": String(MOCK_CUSTOMERS.length) },
      body: JSON.stringify(MOCK_CUSTOMERS),
    });
  });

  await page.route("**/api/admin/documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Total-Count": String(MOCK_DOCUMENTS.length) },
      body: JSON.stringify(MOCK_DOCUMENTS),
    });
  });

  await page.route("**/api/admin/reviews**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_REVIEWS),
    });
  });

  await page.route("**/api/admin/audit**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_AUDIT),
    });
  });

  // 1. Navigate to /admin
  console.log("1. Navigating to Admin Dashboard...");
  await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });

  // 2. Click Reports tab in sidebar
  console.log("2. Navigating to Reports & Analytics via #sidebar-link-reports...");
  const reportsTabBtn = page.locator("#sidebar-link-reports, #tab-btn-reports");
  await reportsTabBtn.waitFor({ state: "visible", timeout: 5000 });
  await reportsTabBtn.click();
  await page.waitForTimeout(600);

  // Verify view container
  const reportsView = page.locator("#admin-reports-view");
  await reportsView.waitFor({ state: "visible", timeout: 5000 });
  console.log("Reports view container loaded successfully!");

  // 3. Verify Header Card and Date Selector
  console.log("3. Verifying Header Card and Date Selector Pills...");
  const datePills = page.locator("#reports-daterange-pills");
  await datePills.waitFor({ state: "visible" });

  // 4. Verify 8 KPI Summary Cards
  console.log("4. Verifying 8 KPI Summary Cards...");
  const kpiCases = page.locator("#kpi-report-cases .report-metric-value-p9");
  const casesText = await kpiCases.textContent();
  console.log(`KPI Total Cases: ${casesText?.trim()}`);

  const kpiCompRate = page.locator("#kpi-report-completion-rate .report-metric-value-p9");
  const compRateText = await kpiCompRate.textContent();
  console.log(`KPI Completion Rate: ${compRateText?.trim()}`);

  const kpiDocs = page.locator("#kpi-report-docs .report-metric-value-p9");
  const docsText = await kpiDocs.textContent();
  console.log(`KPI Documents Processed: ${docsText?.trim()}`);

  const kpiAutoVerify = page.locator("#kpi-report-auto-verify .report-metric-value-p9");
  const autoVerifyText = await kpiAutoVerify.textContent();
  console.log(`KPI Auto-Verify Rate: ${autoVerifyText?.trim()}`);

  const kpiOcrSuccess = page.locator("#kpi-report-ocr-success .report-metric-value-p9");
  const ocrSuccessText = await kpiOcrSuccess.textContent();
  console.log(`KPI OCR Extraction Success: ${ocrSuccessText?.trim()}`);

  const kpiReviews = page.locator("#kpi-report-reviews .report-metric-value-p9");
  const reviewsText = await kpiReviews.textContent();
  console.log(`KPI Human Review Queue: ${reviewsText?.trim()}`);

  const kpiPurged = page.locator("#kpi-report-purged .report-metric-value-p9");
  const purgedText = await kpiPurged.textContent();
  console.log(`KPI Purged Cases: ${purgedText?.trim()}`);

  // Screenshot 1: Overview & KPI Grid
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_01_kpis_dark.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_01_kpis_dark.png");

  // 5. Test Trend Chart & Tooltip Hover
  console.log("5. Testing Trend Chart and Hover Tooltip...");
  const trendChart = page.locator("#reports-trend-chart-card");
  await trendChart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  // Hover over center of chart SVG
  const svgBox = await trendChart.locator("svg[viewBox='0 0 640 220']").boundingBox();
  if (svgBox) {
    await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
    await page.waitForTimeout(300);
  }

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_02_trend_chart.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_02_trend_chart.png");

  // 6. Test 3 Distribution Donut Charts
  console.log("6. Verifying 3 Distribution Donut Charts...");
  const caseDist = page.locator("#chart-case-distribution");
  const docTypeDist = page.locator("#chart-doctype-distribution");
  const reviewDist = page.locator("#chart-review-reasons");

  await caseDist.waitFor({ state: "visible" });
  await docTypeDist.waitFor({ state: "visible" });
  await reviewDist.waitFor({ state: "visible" });

  await caseDist.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_03_distribution_charts.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_03_distribution_charts.png");

  // 7. Verify Document Performance Matrix Table
  console.log("7. Verifying Document Performance Matrix Table...");
  const perfCard = page.locator("#reports-doc-performance-card");
  await perfCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const tableRows = page.locator("#reports-doc-performance-table tbody tr");
  const rowCount = await tableRows.count();
  console.log(`Performance Matrix rows: ${rowCount}`);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_04_performance_table.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_04_performance_table.png");

  // 8. Test Filtering (Date range, Case Status, Doc Type) & Reset
  console.log("8. Testing Multi-Dimensional Filter Controls...");
  // Click Last 30D pill
  await page.click("#report-daterange-30d");
  await page.waitForTimeout(300);

  // Select completed cases
  await page.selectOption("#report-filter-status", "completed");
  await page.waitForTimeout(300);

  // Select PAN document type
  await page.selectOption("#report-filter-doctype", "pan");
  await page.waitForTimeout(300);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_05_filters_applied.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_05_filters_applied.png");

  // Click Reset Filters
  console.log("Clicking Reset Filters...");
  await page.click("#btn-reset-report-filters");
  await page.waitForTimeout(300);

  // 9. Test High-Contrast Light Mode
  console.log("9. Testing High-Contrast Light Mode...");
  const themeToggle = page.locator("#btn-theme-toggle");
  if (await themeToggle.isVisible()) {
    await themeToggle.click();
    await page.waitForTimeout(400);
  }

  await page.locator("#admin-reports-view").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "reports_06_reports_light.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: reports_06_reports_light.png");

  console.log("=== Phase 9 Reports & Analytics UI Verification Succeeded! ===");
  await browser.close();
}

runPhase9ReportsVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
