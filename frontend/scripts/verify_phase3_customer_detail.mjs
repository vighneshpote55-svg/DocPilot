import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

const MOCK_CUSTOMER_101 = {
  id: 101,
  code: "CUST-98214",
  name: "Vikram Malhotra",
  email: "vikram.malhotra@example.com",
  mobile: "+91 98765 43210",
  consent_status: "granted",
  case_status: "in_progress",
  created_at: new Date(Date.now() - 3600000 * 72).toISOString(),
  completed_at: null,
  delete_after: new Date(Date.now() + 3600000 * 24 * 5).toISOString(),
  data_deleted_at: null,
  required_count: 4,
  received_count: 2,
  pending_count: 2,
  allow_download: true,
  required: [
    {
      doc_type: "pan",
      label: "PAN Card",
      state: "verified",
      document_id: "doc-pan-01",
    },
    {
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      state: "verified",
      document_id: "doc-aadhaar-02",
    },
    {
      doc_type: "bank_statement",
      label: "Bank Statement",
      state: "under_review",
      document_id: "doc-bank-03",
    },
    {
      doc_type: "salary_slip",
      label: "Salary Slip",
      state: "pending_upload",
      document_id: null,
    },
  ],
  documents: [
    {
      id: "doc-bank-03",
      doc_type: "bank_statement",
      label: "Bank Statement",
      filename: "hdfc_statement_q3.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "manual_review",
      uploaded_at: new Date(Date.now() - 3600000 * 5).toISOString(),
      review_reason: "Name on statement appears as 'V. Malhotra' vs customer profile 'Vikram Malhotra'",
      flags: ["name_mismatch", "unclear_stamp"],
      confidence: 0.78,
      superseded: false,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
    },
    {
      id: "doc-pan-01",
      doc_type: "pan",
      label: "PAN Card",
      filename: "pan_card_vikram.png",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 48).toISOString(),
      review_reason: null,
      flags: [],
      confidence: 0.98,
      superseded: false,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
    },
    {
      id: "doc-aadhaar-02",
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      filename: "aadhaar_card_front.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 36).toISOString(),
      review_reason: null,
      flags: [],
      confidence: 0.96,
      superseded: false,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
    },
    {
      id: "doc-aadhaar-old",
      doc_type: "aadhaar",
      label: "Aadhaar Card (Damaged)",
      filename: "aadhaar_blurry_scan.png",
      file_state: "stored",
      ocr_status: "failed",
      verification_status: "rejected",
      uploaded_at: new Date(Date.now() - 3600000 * 70).toISOString(),
      review_reason: "Blurred QR code and damaged bottom corner prevented validation",
      flags: ["face_blur", "damaged_edge"],
      confidence: 0.42,
      superseded: true,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
    },
  ],
};

const MOCK_AUDIT = [
  {
    id: 901,
    at: new Date(Date.now() - 3600000 * 4).toISOString(),
    actor: "system_rules_engine",
    action: "document_flagged_for_review",
    entity_type: "document",
    entity_id: "doc-bank-03",
    details: { reason: "name_mismatch", customer_id: 101, customer_code: "CUST-98214" },
  },
  {
    id: 902,
    at: new Date(Date.now() - 3600000 * 5).toISOString(),
    actor: "customer_portal",
    action: "document_uploaded",
    entity_type: "document",
    entity_id: "doc-bank-03",
    details: { doc_type: "bank_statement", customer_id: 101 },
  },
  {
    id: 903,
    at: new Date(Date.now() - 3600000 * 35).toISOString(),
    actor: "system_rules_engine",
    action: "document_verified",
    entity_type: "document",
    entity_id: "doc-aadhaar-02",
    details: { doc_type: "aadhaar", customer_id: 101 },
  },
  {
    id: 904,
    at: new Date(Date.now() - 3600000 * 47).toISOString(),
    actor: "system_rules_engine",
    action: "document_verified",
    entity_type: "document",
    entity_id: "doc-pan-01",
    details: { doc_type: "pan", customer_id: 101 },
  },
  {
    id: 905,
    at: new Date(Date.now() - 3600000 * 71).toISOString(),
    actor: "customer_portal",
    action: "consent_granted",
    entity_type: "customer",
    entity_id: "101",
    details: { customer_id: 101, customer_code: "CUST-98214" },
  },
];

async function run() {
  console.log("=== Starting Phase 3 Customer Detail & Document Inspection Verification ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  // Setup route intercepts
  await page.route(/\/api\/admin\/customers/, async (route) => {
    const url = route.request().url();
    if (url.includes("/customers/101")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_CUSTOMER_101),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([MOCK_CUSTOMER_101]),
    });
  });

  await page.route(/\/api\/admin\/documents/, async (route) => {
    const url = route.request().url();
    if (url.includes("/file")) {
      const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
        <rect width="600" height="400" fill="#0f1b38" rx="16"/>
        <rect x="30" y="30" width="540" height="340" fill="#132246" stroke="#3b82f6" stroke-width="2" rx="12"/>
        <text x="50" y="80" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="bold">CONFIDENTIAL IDENTITY DOCUMENT</text>
        <text x="50" y="120" fill="#93c5fd" font-family="sans-serif" font-size="14">GOVERNMENT OF INDIA • PERMANENT ACCOUNT NUMBER</text>
        <rect x="50" y="150" width="120" height="150" fill="#1e3a8a" stroke="#3b82f6" rx="8"/>
        <text x="80" y="235" fill="#ffffff" font-family="sans-serif" font-size="14">PHOTO</text>
        <text x="200" y="180" fill="#cbd5e1" font-family="sans-serif" font-size="14">NAME: VIKRAM MALHOTRA</text>
        <text x="200" y="215" fill="#cbd5e1" font-family="sans-serif" font-size="14">NUMBER: ABCPM1234F</text>
        <text x="200" y="250" fill="#cbd5e1" font-family="sans-serif" font-size="14">DOB: 15/08/1988</text>
        <text x="200" y="285" fill="#10b981" font-family="sans-serif" font-size="14">STATUS: VERIFIED BY DOCPILOT RULES</text>
      </svg>`;
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: Buffer.from(svgData),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Total-Count": String(MOCK_CUSTOMER_101.documents.length) },
      body: JSON.stringify(MOCK_CUSTOMER_101.documents),
    });
  });

  await page.route(/\/api\/admin\/audit/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_AUDIT),
    });
  });

  await page.route(/\/api\/admin\/summary/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { in_progress: 2, completed: 1 },
        open_reviews: 1,
        jobs: { queued: 0, running: 0, failed: 0 },
        metrics: {
          total_customers: 3,
          completed_customers: 1,
          completion_rate: 33.3,
          total_documents: 4,
          verified_documents: 2,
          pending_review_documents: 1,
          processing_documents: 0,
          ocr_failures: 1,
        },
      }),
    });
  });

  page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));

  // Inject session
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

  // 1. Navigate to Customer Detail Page
  console.log("1. Navigating to /admin/customers/101 (Customer Detail Page)...");
  await page.goto("http://localhost:5180/admin/customers/101");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.waitForTimeout(600);

  const detailDarkPath = path.join(ARTIFACT_DIR, "phase3_customer_detail_dark.png");
  await page.screenshot({ path: detailDarkPath });
  console.log(`Saved screenshot: ${detailDarkPath}`);

  // 2. Open Document Details Drawer on Bank Statement (Manual Review)
  console.log("2. Opening Document Details Drawer on Bank Statement...");
  const inspectBtn = page.locator("tr:has-text('hdfc_statement_q3.pdf') button:has-text('Inspect')");
  await inspectBtn.click();
  await page.waitForSelector("#document-details-drawer", { timeout: 5000 });
  await page.waitForTimeout(500);

  const drawerPath = path.join(ARTIFACT_DIR, "phase3_document_details_drawer.png");
  await page.screenshot({ path: drawerPath });
  console.log(`Saved screenshot: ${drawerPath}`);

  // Close drawer
  const closeDrawerBtn = page.locator(".drawer-close-btn");
  await closeDrawerBtn.click();
  await page.waitForTimeout(300);

  // 3. Open Secure Document Viewer Modal on PAN Card
  console.log("3. Opening Secure Document Viewer Modal on PAN Card...");
  const viewBtn = page.locator("tr:has-text('pan_card_vikram.png') button:has-text('View')");
  await viewBtn.click();
  await page.waitForSelector("#secure-doc-viewer-modal", { timeout: 5000 });
  await page.waitForTimeout(600);

  const viewerPath = path.join(ARTIFACT_DIR, "phase3_secure_document_viewer.png");
  await page.screenshot({ path: viewerPath });
  console.log(`Saved screenshot: ${viewerPath}`);

  // Close viewer modal
  const closeViewerBtn = page.locator("#close-secure-viewer-btn");
  await closeViewerBtn.click();
  await page.waitForTimeout(300);

  // 4. Open Document Details Drawer on Superseded Document
  console.log("4. Opening Document Details Drawer on Superseded Document...");
  const supersededInspectBtn = page.locator("tr:has-text('aadhaar_blurry_scan.png') button:has-text('Inspect')");
  await supersededInspectBtn.click();
  await page.waitForSelector("#document-details-drawer", { timeout: 5000 });
  await page.waitForTimeout(400);

  const supersededPath = path.join(ARTIFACT_DIR, "phase3_superseded_document_drawer.png");
  await page.screenshot({ path: supersededPath });
  console.log(`Saved screenshot: ${supersededPath}`);

  await page.locator(".drawer-close-btn").click();
  await page.waitForTimeout(300);

  // 5. Navigate to Documents Tab in Admin Page
  console.log("5. Navigating to Documents Repository View...");
  await page.goto("http://localhost:5180/admin");
  await page.waitForSelector("#admin-dashboard", { timeout: 8000 });
  await page.click("#tab-btn-documents");
  await page.waitForSelector("#tab-pane-documents", { timeout: 5000 });
  await page.waitForTimeout(500);

  const repoPath = path.join(ARTIFACT_DIR, "phase3_documents_repository_view.png");
  await page.screenshot({ path: repoPath });
  console.log(`Saved screenshot: ${repoPath}`);

  // 6. Test Light Mode on Customer Detail Page
  console.log("6. Testing Light Theme on Customer Detail Page...");
  await page.goto("http://localhost:5180/admin/customers/101");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(500);

  // 7. Capture Scrolled Documents Table & Audit Trail Feed
  console.log("7. Capturing Scrolled Documents Table & Audit Trail Feed...");
  await page.click("#theme-toggle-btn"); // Return to dark
  await page.waitForTimeout(300);
  const auditFeed = page.locator(".customer-audit-feed");
  await auditFeed.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const auditPath = path.join(ARTIFACT_DIR, "phase3_customer_audit_and_documents.png");
  await page.screenshot({ path: auditPath });
  console.log(`Saved screenshot: ${auditPath}`);

  console.log("=== Phase 3 Verification Completed Successfully! ===");
  await browser.close();
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
