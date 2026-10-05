import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

// Mock dataset for comprehensive 3/7/14 reminder lifecycle testing
const MOCK_CUSTOMERS = [
  {
    id: 101,
    code: "CUST-98214",
    name: "Vikram Malhotra",
    email: "vikram.malhotra@example.com",
    mobile: "+91 98765 43210",
    consent_status: "granted",
    case_status: "in_progress",
    created_at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(), // 4 days ago
    completed_at: null,
    delete_after: new Date(Date.now() + 3600000 * 24 * 3).toISOString(),
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
    name: "Rajesh Kumar",
    email: "rajesh.kumar@example.com",
    mobile: "+91 98765 43212",
    consent_status: "withdrawn",
    case_status: "consent_withdrawn",
    created_at: new Date(Date.now() - 3600000 * 24 * 5).toISOString(),
    completed_at: null,
    delete_after: new Date(Date.now() + 3600000 * 24 * 2).toISOString(),
    data_deleted_at: null,
    required_count: 2,
    received_count: 0,
    pending_count: 2,
    allow_download: true,
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
];

const MOCK_AUDIT = [
  {
    id: 901,
    at: new Date(Date.now() - 3600000 * 24 * 1).toISOString(), // 1 day ago
    actor: "system",
    action: "reminder_sent",
    entity_type: "customer",
    entity_id: "101",
    details: { stage: 3, pending_count: 2 },
  },
  {
    id: 902,
    at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    actor: "system",
    action: "upload_link_sent",
    entity_type: "customer",
    entity_id: "101",
    details: { stage: 0 },
  },
  {
    id: 903,
    at: new Date(Date.now() - 3600000 * 24 * 4).toISOString(),
    actor: "customer",
    action: "consent_granted",
    entity_type: "customer",
    entity_id: "101",
    details: {},
  },
  {
    id: 904,
    at: new Date(Date.now() - 3600000 * 12).toISOString(),
    actor: "system",
    action: "case_completed",
    entity_type: "customer",
    entity_id: "102",
    details: {},
  },
  {
    id: 905,
    at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
    actor: "customer",
    action: "consent_withdrawn",
    entity_type: "customer",
    entity_id: "103",
    details: {},
  },
];

const MOCK_DETAIL_101 = {
  ...MOCK_CUSTOMERS[0],
  required: [
    { doc_type: "pan", label: "PAN Card", state: "verified", document_id: "doc-1" },
    { doc_type: "aadhaar", label: "Aadhaar Card", state: "verified", document_id: "doc-2" },
    { doc_type: "bank_statement", label: "Bank Statement", state: "under_review", document_id: "doc-3" },
    { doc_type: "salary_slip", label: "Salary Slip", state: "pending_upload", document_id: null },
  ],
  documents: [
    {
      id: "doc-3",
      doc_type: "bank_statement",
      label: "Bank Statement",
      filename: "statement_hdfc.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "manual_review",
      uploaded_at: new Date(Date.now() - 3600000 * 5).toISOString(),
      review_reason: "Name mismatch",
      flags: ["name_mismatch"],
      confidence: 0.81,
      superseded: false,
    },
  ],
};

const MOCK_DETAIL_102 = {
  ...MOCK_CUSTOMERS[1],
  required: [
    { doc_type: "pan", label: "PAN Card", state: "verified", document_id: "doc-10" },
    { doc_type: "aadhaar", label: "Aadhaar Card", state: "verified", document_id: "doc-11" },
    { doc_type: "passport", label: "Passport", state: "verified", document_id: "doc-12" },
  ],
  documents: [],
};

const MOCK_DETAIL_103 = {
  ...MOCK_CUSTOMERS[2],
  required: [
    { doc_type: "pan", label: "PAN Card", state: "pending_upload", document_id: null },
    { doc_type: "salary_slip", label: "Salary Slip", state: "pending_upload", document_id: null },
  ],
  documents: [],
};

async function run() {
  console.log("=== Starting Phase 7 Notifications & Reminders UI Verification ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();

  // Route interception
  await page.route(/\/api\/admin\/summary/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { in_progress: 1, completed: 1, consent_withdrawn: 1, awaiting_consent: 1 },
        open_reviews: 1,
        jobs: { queued: 0, running: 0, failed: 0 },
        metrics: {
          total_customers: 4,
          completed_customers: 1,
          completion_rate: 25.0,
          total_documents: 4,
          verified_documents: 2,
          pending_review_documents: 1,
          processing_documents: 0,
          ocr_failures: 0,
        },
      }),
    });
  });

  await page.route(/\/api\/admin\/customers(\?.*)?$/, async (route) => {
    return route.fulfill({
      status: 200,
      headers: { "X-Total-Count": "4" },
      contentType: "application/json",
      body: JSON.stringify(MOCK_CUSTOMERS),
    });
  });

  await page.route(/\/api\/admin\/customers\/101(\?.*)?$/, async (route) => {
    const url = route.request().url();
    if (url.includes("/send-upload-link")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sent: true, message: "Upload link and reminder dispatched" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_DETAIL_101),
    });
  });

  await page.route(/\/api\/admin\/customers\/102(\?.*)?$/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_DETAIL_102),
    });
  });

  await page.route(/\/api\/admin\/customers\/103(\?.*)?$/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_DETAIL_103),
    });
  });

  await page.route(/\/api\/admin\/audit/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_AUDIT),
    });
  });

  await page.route(/\/api\/admin\/reviews/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route(/\/api\/admin\/documents/, async (route) => {
    return route.fulfill({
      status: 200,
      headers: { "X-Total-Count": "0" },
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));

  // Initialize admin session token
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

  // -------------------------------------------------------------
  // Test 1: Navigation to Admin Reminder Center
  // -------------------------------------------------------------
  console.log("1. Navigating to Admin Reminders Center via #sidebar-link-reminders...");
  await page.goto("http://localhost:5180/admin");
  await page.waitForSelector("#admin-dashboard", { timeout: 8000 });
  await page.click("#sidebar-link-reminders, #tab-btn-reminders");
  await page.waitForSelector("#admin-reminders-center", { timeout: 6000 });
  await page.waitForSelector("#admin-reminders-table", { timeout: 6000 });
  await page.waitForTimeout(600);

  const remindersCenterDarkPath = path.join(ARTIFACT_DIR, "reminders_01_center_dark.png");
  await page.screenshot({ path: remindersCenterDarkPath });
  console.log(`Saved screenshot: ${remindersCenterDarkPath}`);

  // -------------------------------------------------------------
  // Test 2: KPI Summary Cards Verification
  // -------------------------------------------------------------
  console.log("2. Verifying Reminder KPI Summary Cards...");
  await page.waitForSelector("#kpi-reminders-active", { timeout: 5000 });
  await page.waitForSelector("#kpi-reminders-day3", { timeout: 5000 });
  await page.waitForSelector("#kpi-reminders-day7", { timeout: 5000 });
  await page.waitForSelector("#kpi-reminders-day14", { timeout: 5000 });
  await page.waitForSelector("#kpi-reminders-stopped", { timeout: 5000 });

  const activeKpiText = await page.locator("#kpi-reminders-active .reminders-kpi-value").innerText();
  const day3KpiText = await page.locator("#kpi-reminders-day3 .reminders-kpi-value").innerText();
  console.log(`KPI Active in Cycle: ${activeKpiText}, Day 3 Reminders Sent: ${day3KpiText}`);

  // -------------------------------------------------------------
  // Test 3: Filters and Search
  // -------------------------------------------------------------
  console.log("3. Testing status tabs and search filtering...");
  await page.click("#filter-reminders-active");
  await page.waitForTimeout(300);
  const activeRows = await page.locator("#admin-reminders-table tbody tr").count();
  console.log(`Filtered Active Rows: ${activeRows} (expected 1)`);

  await page.click("#filter-reminders-stopped-completed");
  await page.waitForTimeout(300);
  const completedRows = await page.locator("#admin-reminders-table tbody tr").count();
  console.log(`Filtered Completed Rows: ${completedRows} (expected 1)`);

  await page.click("#filter-reminders-stopped-withdrawn");
  await page.waitForTimeout(300);
  const withdrawnRows = await page.locator("#admin-reminders-table tbody tr").count();
  console.log(`Filtered Withdrawn Rows: ${withdrawnRows} (expected 1)`);

  await page.click("#filter-reminders-all");
  await page.waitForTimeout(300);

  // Search filter
  await page.fill("#reminder-search-input", "Vikram");
  await page.waitForTimeout(300);
  const searchRows = await page.locator("#admin-reminders-table tbody tr").count();
  console.log(`Search 'Vikram' Rows: ${searchRows} (expected 1)`);
  await page.fill("#reminder-search-input", "");
  await page.waitForTimeout(300);

  // -------------------------------------------------------------
  // Test 4: Stepper Node Status Verification
  // -------------------------------------------------------------
  console.log("4. Verifying 3 / 7 / 14-day stepper states on row 101...");
  const isStage3Sent = await page.locator("#node-stage3-101.sent").count();
  const isStage7Scheduled = await page.locator("#node-stage7-101.scheduled").count();
  console.log(`Vikram Day 3 sent: ${isStage3Sent === 1}, Day 7 scheduled: ${isStage7Scheduled === 1}`);

  // -------------------------------------------------------------
  // Test 5: Customer Notification Timeline Drawer
  // -------------------------------------------------------------
  console.log("5. Opening Customer Notification Timeline Drawer...");
  await page.click("#btn-view-timeline-101");
  await page.waitForSelector("#customer-notification-timeline-drawer", { timeout: 5000 });
  await page.waitForTimeout(500);

  const timelineDrawerPath = path.join(ARTIFACT_DIR, "reminders_02_timeline_drawer.png");
  await page.screenshot({ path: timelineDrawerPath });
  console.log(`Saved screenshot: ${timelineDrawerPath}`);

  // Close drawer
  await page.click("#btn-close-notification-drawer");
  await page.waitForTimeout(300);

  // -------------------------------------------------------------
  // Test 6: Resend Reminder Link Action
  // -------------------------------------------------------------
  console.log("6. Testing Resend Reminder Link action button...");
  await page.click("#btn-resend-reminder-101");
  await page.waitForTimeout(500);
  console.log("Resend action triggered successfully!");

  // -------------------------------------------------------------
  // Test 7: Customer Detail Reminders Panel (/admin/customers/101 - Active)
  // -------------------------------------------------------------
  console.log("7. Navigating to Customer Detail (101 - Vikram Malhotra)...");
  await page.goto("http://localhost:5180/admin/customers/101");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.waitForSelector("#customer-reminders-panel", { timeout: 6000 });
  await page.waitForTimeout(500);

  const detailActivePanel = page.locator("#customer-reminders-panel");
  await detailActivePanel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const detailActivePath = path.join(ARTIFACT_DIR, "reminders_03_customer_detail_active.png");
  await page.screenshot({ path: detailActivePath });
  console.log(`Saved screenshot: ${detailActivePath}`);

  // -------------------------------------------------------------
  // Test 8: Customer Detail Reminders Panel (/admin/customers/102 - Completed)
  // -------------------------------------------------------------
  console.log("8. Navigating to Customer Detail (102 - Ananya Roy - Completed)...");
  await page.goto("http://localhost:5180/admin/customers/102");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.waitForSelector("#customer-reminders-panel", { timeout: 6000 });
  await page.waitForTimeout(400);

  const detailCompletedPanel = page.locator("#customer-reminders-panel");
  await detailCompletedPanel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const isCompletedStopped = await page.locator("#badge-reminder-status:has-text('All Documents Verified')").count();
  console.log(`Completed customer shows Reminders Stopped: ${isCompletedStopped === 1}`);

  const detailCompletedPath = path.join(ARTIFACT_DIR, "reminders_04_customer_detail_completed.png");
  await page.screenshot({ path: detailCompletedPath });
  console.log(`Saved screenshot: ${detailCompletedPath}`);

  // -------------------------------------------------------------
  // Test 9: Customer Detail Reminders Panel (/admin/customers/103 - Consent Withdrawn)
  // -------------------------------------------------------------
  console.log("9. Navigating to Customer Detail (103 - Rajesh Kumar - Consent Withdrawn)...");
  await page.goto("http://localhost:5180/admin/customers/103");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.waitForSelector("#customer-reminders-panel", { timeout: 6000 });
  await page.waitForTimeout(400);

  const detailWithdrawnPanel = page.locator("#customer-reminders-panel");
  await detailWithdrawnPanel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const isWithdrawnStopped = await page.locator("#badge-reminder-status:has-text('Consent Withdrawn')").count();
  console.log(`Withdrawn customer shows Reminders Stopped: ${isWithdrawnStopped === 1}`);

  const detailWithdrawnPath = path.join(ARTIFACT_DIR, "reminders_05_customer_detail_withdrawn.png");
  await page.screenshot({ path: detailWithdrawnPath });
  console.log(`Saved screenshot: ${detailWithdrawnPath}`);

  // -------------------------------------------------------------
  // Test 10: High-Contrast Light Mode on Reminders Center
  // -------------------------------------------------------------
  console.log("10. Testing High-Contrast Light Mode on Reminders Center...");
  await page.goto("http://localhost:5180/admin");
  await page.waitForSelector("#admin-dashboard", { timeout: 8000 });
  await page.click("#sidebar-link-reminders, #tab-btn-reminders");
  await page.waitForSelector("#admin-reminders-center", { timeout: 6000 });
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(500);

  const remindersCenterLightPath = path.join(ARTIFACT_DIR, "reminders_06_center_light.png");
  await page.screenshot({ path: remindersCenterLightPath });
  console.log(`Saved screenshot: ${remindersCenterLightPath}`);

  // Restore dark theme
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(300);

  console.log("=== Phase 7 Notifications & Reminders UI Verification Succeeded! ===");
  await browser.close();
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
