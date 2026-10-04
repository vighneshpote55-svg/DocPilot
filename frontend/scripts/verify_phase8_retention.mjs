import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

// Mock dataset for comprehensive 7-day retention & deletion testing
const MOCK_CUSTOMERS = [
  {
    id: 101,
    code: "CUST-98214",
    name: "Vikram Malhotra",
    email: "vikram.malhotra@example.com",
    mobile: "+91 98765 43210",
    consent_status: "granted",
    case_status: "in_progress",
    created_at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    completed_at: null,
    delete_after: new Date(Date.now() + 3600000 * 24 * 3).toISOString(), // 3 days remaining in 7-day window
    data_deleted_at: null,
    required_count: 4,
    received_count: 2,
    pending_count: 2,
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
    created_at: new Date(Date.now() - 3600000 * 24 * 8).toISOString(),
    completed_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    delete_after: new Date(Date.now() + 3600000 * 24 * 6.5).toISOString(), // ~6.5 days remaining
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
    created_at: new Date(Date.now() - 3600000 * 24 * 10).toISOString(),
    completed_at: null,
    delete_after: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    data_deleted_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(), // Purged 2 days ago
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
    consent_status: "pending",
    case_status: "awaiting_consent",
    created_at: new Date(Date.now() - 3600000 * 8).toISOString(),
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
    required_count: 3,
    received_count: 0,
    pending_count: 3,
    allow_download: true,
  },
  {
    id: 105,
    code: "CUST-98218",
    name: "Siddharth Rao",
    email: "siddharth.rao@example.com",
    mobile: "+91 98765 43214",
    consent_status: "withdrawn",
    case_status: "consent_withdrawn",
    created_at: new Date(Date.now() - 3600000 * 24 * 7).toISOString(),
    completed_at: null,
    delete_after: new Date(Date.now() - 3600000 * 2).toISOString(), // Overdue / due today
    data_deleted_at: null,
    required_count: 2,
    received_count: 1,
    pending_count: 1,
    allow_download: true,
  }
];

const MOCK_AUDIT = [
  {
    id: 901,
    at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    actor: "system",
    action: "retention_deleted",
    entity_type: "customer",
    entity_id: "103",
    details: { reason: "7-day statutory retention expiry" },
  },
  {
    id: 902,
    at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
    actor: "admin",
    action: "customer_data_deleted",
    entity_type: "customer",
    entity_id: "103",
    details: {},
  },
  {
    id: 903,
    at: new Date(Date.now() - 3600000 * 12).toISOString(),
    actor: "system",
    action: "case_completed",
    entity_type: "customer",
    entity_id: "102",
    details: {},
  },
  {
    id: 904,
    at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    actor: "system",
    action: "reminder_sent",
    entity_type: "customer",
    entity_id: "101",
    details: { stage: 3, pending_count: 2 },
  },
  {
    id: 905,
    at: new Date(Date.now() - 3600000 * 24 * 5).toISOString(),
    actor: "customer",
    action: "consent_withdrawn",
    entity_type: "customer",
    entity_id: "105",
    details: {},
  },
];

const MOCK_DOCUMENTS = [
  {
    id: "doc-101-pan",
    customer_id: 101,
    doc_type: "pan",
    label: "PAN Card",
    filename: "pan_vikram.pdf",
    uploaded_at: new Date(Date.now() - 3600000 * 48).toISOString(),
    ocr_status: "verified",
    verification_status: "verified",
    needs_manual_review: false,
    review_reason: null,
    flags: [],
    confidence: 0.98,
    file_state: "stored",
    delete_after: new Date(Date.now() + 3600000 * 24 * 3).toISOString(),
    superseded: false,
    customer_name: "Vikram Malhotra",
    customer_code: "CUST-98214",
    customer_email: "vikram.malhotra@example.com",
  },
  {
    id: "doc-101-aadhaar",
    customer_id: 101,
    doc_type: "aadhaar",
    label: "Aadhaar Card",
    filename: "aadhaar_vikram.pdf",
    uploaded_at: new Date(Date.now() - 3600000 * 46).toISOString(),
    ocr_status: "verified",
    verification_status: "verified",
    needs_manual_review: false,
    review_reason: null,
    flags: [],
    confidence: 0.96,
    file_state: "stored",
    delete_after: new Date(Date.now() + 3600000 * 24 * 3).toISOString(),
    superseded: false,
    customer_name: "Vikram Malhotra",
    customer_code: "CUST-98214",
    customer_email: "vikram.malhotra@example.com",
  },
  {
    id: "doc-102-pan",
    customer_id: 102,
    doc_type: "pan",
    label: "PAN Card",
    filename: "pan_ananya.pdf",
    uploaded_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    ocr_status: "verified",
    verification_status: "verified",
    needs_manual_review: false,
    review_reason: null,
    flags: [],
    confidence: 0.99,
    file_state: "stored",
    delete_after: new Date(Date.now() + 3600000 * 24 * 6.5).toISOString(),
    superseded: false,
    customer_name: "Ananya Roy",
    customer_code: "CUST-98215",
    customer_email: "ananya.roy@example.com",
  },
  {
    id: "doc-103-purged",
    customer_id: 103,
    doc_type: "pan",
    label: "PAN Card",
    filename: "pan_rajesh.pdf",
    uploaded_at: new Date(Date.now() - 3600000 * 24 * 10).toISOString(),
    ocr_status: "verified",
    verification_status: "verified",
    needs_manual_review: false,
    review_reason: null,
    flags: [],
    confidence: 0.95,
    file_state: "deleted",
    delete_after: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    superseded: false,
    customer_name: "[deleted]",
    customer_code: "CUST-98216",
    customer_email: "deleted-103@invalid.local",
  }
];

function buildCustomerDetail(id) {
  const base = MOCK_CUSTOMERS.find((c) => c.id === id) || MOCK_CUSTOMERS[0];
  const docs = MOCK_DOCUMENTS.filter((d) => d.customer_id === id);

  return {
    ...base,
    documents: docs,
    required: [
      { doc_type: "pan", label: "PAN Card", state: id === 103 ? "pending_upload" : "verified", document_id: docs.find((d) => d.doc_type === "pan")?.id || null },
      { doc_type: "aadhaar", label: "Aadhaar Card", state: id === 102 ? "verified" : (id === 101 ? "verified" : "pending_upload"), document_id: docs.find((d) => d.doc_type === "aadhaar")?.id || null },
      { doc_type: "bank_statement", label: "Bank Statement", state: id === 102 ? "verified" : "pending_upload", document_id: null },
    ],
  };
}

async function runPhase8Verification() {
  console.log("=== Starting Phase 8 Retention & Data Deletion UI Verification ===");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  // Initial navigation to set domain localStorage and sessionStorage
  await page.goto("http://localhost:5180/admin");
  await page.evaluate(() => {
    window.sessionStorage.setItem("docpilot_staff_jwt", "mock-session-token");
    window.localStorage.setItem(
      "docpilot_admin_session",
      JSON.stringify({
        token: "mock-session-token",
        email: "vighneshpote.info@gmail.com",
        role: "admin",
        name: "Staff Admin",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      })
    );
    window.localStorage.setItem("docpilot_admin_theme", "dark");
  });


  // Intercept and mock API routes
  await page.route("**/api/admin/summary", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { in_progress: 2, completed: 1, withdrawn: 1, deleted: 1 },
        open_reviews: 0,
        jobs: { queued: 0, running: 0, failed: 0 },
        metrics: {
          total_customers: 5,
          completed_customers: 1,
          completion_rate: 20,
          total_documents: 4,
          verified_documents: 3,
          pending_review_documents: 0,
          processing_documents: 0,
          ocr_failures: 0,
        },
      }),
    });
  });

  await page.route(/\/api\/admin\/customers(\?.*)?$/, async (route) => {
    return route.fulfill({
      status: 200,
      headers: { "X-Total-Count": String(MOCK_CUSTOMERS.length) },
      contentType: "application/json",
      body: JSON.stringify(MOCK_CUSTOMERS),
    });
  });


  await page.route("**/api/admin/customers/*", async (route) => {
    const url = route.request().url();
    const parts = url.split("/");
    const id = parseInt(parts[parts.length - 1], 10);
    const detail = buildCustomerDetail(isNaN(id) ? 101 : id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    });
  });

  await page.route("**/api/admin/audit?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_AUDIT),
    });
  });

  await page.route("**/api/admin/documents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_DOCUMENTS),
    });
  });

  page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err));


  // 1. Dashboard: Verify #dashboard-retention-card
  console.log("1. Navigating to Operations Dashboard to inspect #dashboard-retention-card...");
  await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });
  console.log("Current URL:", page.url());
  const bodyText = await page.innerText("body");
  console.log("Page snippet:", bodyText.slice(0, 300));
  await page.waitForSelector("#dashboard-retention-card", { timeout: 6000 });


  const dashboardCardPath = path.join(ARTIFACT_DIR, "retention_01_dashboard_card.png");
  await page.screenshot({ path: dashboardCardPath });
  console.log(`Saved screenshot: ${dashboardCardPath}`);

  // 2. Click button to jump to Retention Center
  console.log("2. Clicking #btn-dashboard-to-retention to navigate to Retention Center...");
  await page.click("#btn-dashboard-to-retention");
  await page.waitForSelector("#admin-retention-center", { timeout: 6000 });

  const centerDarkPath = path.join(ARTIFACT_DIR, "retention_02_center_dark.png");
  await page.screenshot({ path: centerDarkPath });
  console.log(`Saved screenshot: ${centerDarkPath}`);

  // 3. Verify KPI Summary Cards
  console.log("3. Verifying Retention KPI Summary Cards...");
  const activeCount = await page.locator("#kpi-retention-active .retention-kpi-val").innerText();
  const dueCount = await page.locator("#kpi-retention-due .retention-kpi-val").innerText();
  const purgedCount = await page.locator("#kpi-retention-purged .retention-kpi-val").innerText();
  const filesCount = await page.locator("#kpi-retention-files .retention-kpi-val").innerText();
  console.log(`KPIs -> Active: ${activeCount}, Due: ${dueCount}, Purged: ${purgedCount}, Files: ${filesCount}`);

  // 4. Test Filter Tabs and Search
  console.log("4. Testing status tabs and search filtering...");
  await page.click("#tab-filter-scheduled");
  await page.waitForTimeout(300);
  const scheduledRows = await page.locator("#retention-queue-table tbody tr").count();
  console.log(`Filtered Scheduled Rows: ${scheduledRows}`);

  await page.click("#tab-filter-purged");
  await page.waitForTimeout(300);
  const purgedRows = await page.locator("#retention-queue-table tbody tr").count();
  console.log(`Filtered Purged Rows: ${purgedRows}`);

  await page.click("#tab-filter-all");
  await page.fill("#retention-search-input", "Vikram");
  await page.waitForTimeout(300);
  const searchRows = await page.locator("#retention-queue-table tbody tr").count();
  console.log(`Search 'Vikram' Rows: ${searchRows}`);

  // Clear search
  await page.fill("#retention-search-input", "");
  await page.waitForTimeout(300);

  // 5. Open Retention Timeline Drawer
  console.log("5. Opening Customer Retention Timeline Drawer for customer 101...");
  await page.click("#btn-retention-timeline-101");
  await page.waitForSelector("#customer-retention-timeline-drawer", { timeout: 6000 });

  const drawerPath = path.join(ARTIFACT_DIR, "retention_03_timeline_drawer.png");
  await page.screenshot({ path: drawerPath });
  console.log(`Saved screenshot: ${drawerPath}`);

  // Close drawer
  await page.click("#btn-close-retention-drawer");
  await page.waitForTimeout(300);

  // 6. Customer Detail: Active in Retention (101)
  console.log("6. Navigating to Customer Detail (101 - Vikram Malhotra - Active Retention)...");
  await page.goto("http://localhost:5180/admin/customers/101", { waitUntil: "networkidle" });
  await page.waitForSelector("#customer-retention-section", { timeout: 6000 });
  await page.waitForSelector("#retention-countdown-panel", { timeout: 6000 });

  const detailActivePath = path.join(ARTIFACT_DIR, "retention_04_customer_detail_active.png");
  await page.screenshot({ path: detailActivePath });
  console.log(`Saved screenshot: ${detailActivePath}`);

  // 7. Customer Detail: Completed Case (102)
  console.log("7. Navigating to Customer Detail (102 - Ananya Roy - Completed Case)...");
  await page.goto("http://localhost:5180/admin/customers/102", { waitUntil: "networkidle" });
  await page.waitForSelector("#customer-retention-section", { timeout: 6000 });

  const detailCompletedPath = path.join(ARTIFACT_DIR, "retention_05_customer_detail_completed.png");
  await page.screenshot({ path: detailCompletedPath });
  console.log(`Saved screenshot: ${detailCompletedPath}`);

  // 8. Customer Detail: Permanently Purged Case (103)
  console.log("8. Navigating to Customer Detail (103 - Rajesh Kumar - Permanently Purged)...");
  await page.goto("http://localhost:5180/admin/customers/103", { waitUntil: "networkidle" });
  await page.waitForSelector("#retention-purged-panel", { timeout: 6000 });

  const detailPurgedPath = path.join(ARTIFACT_DIR, "retention_06_customer_detail_purged.png");
  await page.screenshot({ path: detailPurgedPath });
  console.log(`Saved screenshot: ${detailPurgedPath}`);

  // 9. Test Manual Purge Action Modal Trigger
  console.log("9. Testing Manual Purge modal trigger and confirmation checkbox...");
  await page.goto("http://localhost:5180/admin/customers/101", { waitUntil: "networkidle" });
  await page.click("#btn-customer-retention-purge");
  await page.waitForSelector("#admin-delete-data-modal", { timeout: 6000 });
  const isChecked = await page.isChecked("#confirm-delete-data-checkbox");
  console.log(`Is delete checkbox checked initially: ${isChecked}`);
  await page.click("#btn-cancel-delete-data");
  await page.waitForTimeout(300);


  // 10. High-Contrast Light Mode
  console.log("10. Testing High-Contrast Light Mode on Retention Center...");
  await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });
  await page.click("#tab-btn-retention");
  await page.waitForSelector("#admin-retention-center", { timeout: 6000 });
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(400);

  const centerLightPath = path.join(ARTIFACT_DIR, "retention_07_center_light.png");
  await page.screenshot({ path: centerLightPath });
  console.log(`Saved screenshot: ${centerLightPath}`);

  await browser.close();
  console.log("=== Phase 8 Retention & Data Deletion UI Verification Succeeded! ===");
}

runPhase8Verification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
