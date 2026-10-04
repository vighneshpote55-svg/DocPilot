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
  delete_after: new Date(Date.now() + 3600000 * 24 * 4).toISOString(), // 4 days remaining
  data_deleted_at: null,
  required_count: 4,
  received_count: 2,
  pending_count: 2,
  allow_download: true,
  required: [
    { doc_type: "pan", label: "PAN Card", state: "verified", document_id: "doc-pan-01" },
    { doc_type: "aadhaar", label: "Aadhaar Card", state: "verified", document_id: "doc-aadhaar-02" },
    { doc_type: "bank_statement", label: "Bank Statement", state: "under_review", document_id: "doc-bank-03" },
    { doc_type: "salary_slip", label: "Salary Slip", state: "pending_upload", document_id: null },
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
      review_reason: "Name discrepancy",
      flags: ["name_mismatch"],
      confidence: 0.78,
      superseded: false,
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
    },
  ],
};

const MOCK_AUDIT = [
  {
    id: 901,
    at: new Date(Date.now() - 3600000 * 71).toISOString(),
    actor: "customer_portal",
    action: "consent_granted",
    entity_type: "customer",
    entity_id: "101",
    details: { customer_id: 101, customer_code: "CUST-98214" },
  },
  {
    id: 902,
    at: new Date(Date.now() - 3600000 * 48).toISOString(),
    actor: "system_rules_engine",
    action: "document_verified",
    entity_type: "document",
    entity_id: "doc-pan-01",
    details: { doc_type: "pan", customer_id: 101 },
  },
  {
    id: 903,
    at: new Date(Date.now() - 3600000 * 20).toISOString(),
    actor: "customer_privacy_portal",
    action: "privacy_withdraw",
    entity_type: "customer",
    entity_id: "101",
    details: { customer_id: 101, reason: "Customer requested withdrawal of consent under DPDP Act" },
  },
  {
    id: 904,
    at: new Date(Date.now() - 3600000 * 12).toISOString(),
    actor: "compliance_admin",
    action: "case_closed",
    entity_type: "customer",
    entity_id: "101",
    details: { customer_id: 101, reason: "Manual closure" },
  },
];

const MOCK_PORTAL_STATE = {
  customer_code: "CUST-98214",
  first_name: "Vikram",
  case_status: "in_progress",
  consent_status: "granted",
  otp_verified: true,
  allowed_types: ["png", "jpg", "pdf"],
  max_upload_mb: 15,
  pending_count: 2,
  delete_after: new Date(Date.now() + 3600000 * 24 * 4).toISOString(),
  documents: [
    { doc_type: "pan", label: "PAN Card", state: "verified", filename: "pan.png", uploaded_at: new Date().toISOString() },
    { doc_type: "aadhaar", label: "Aadhaar Card", state: "processing", filename: "aadhaar.pdf", uploaded_at: new Date().toISOString() },
    { doc_type: "bank_statement", label: "Bank Statement", state: "under_review", filename: "statement.pdf", uploaded_at: new Date().toISOString() },
    { doc_type: "salary_slip", label: "Salary Slip", state: "pending_upload", filename: null, uploaded_at: null },
  ],
};

async function run() {
  console.log("=== Starting Phase 6 Privacy, Consent & Data-Deletion UI Verification ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  // Setup route intercepts
  await page.route(/\/api\/public\/privacy\/request/, async (route) => {
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        message: "If this email is registered, a confirmation link has been sent.",
      }),
    });
  });

  await page.route(/\/api\/public\/privacy\/confirm\/token-privacy-delete-123/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ completed: "delete" }),
    });
  });

  await page.route(/\/api\/public\/privacy\/confirm\/token-expired-999/, async (route) => {
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "invalid_or_expired_link" }),
    });
  });

  await page.route(/\/api\/portal\/token-vikram-9821/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PORTAL_STATE),
    });
  });

  await page.route(/\/api\/admin\/customers\/101/, async (route) => {
    const url = route.request().url();
    if (url.includes("/close")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: "Case closed successfully" }),
      });
    }
    if (url.includes("/delete-data")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: "Customer data permanently purged" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CUSTOMER_101),
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
        cases: { in_progress: 1, completed: 0 },
        open_reviews: 1,
        jobs: { queued: 0, running: 0, failed: 0 },
        metrics: {
          total_customers: 1,
          completed_customers: 0,
          completion_rate: 0,
          total_documents: 2,
          verified_documents: 1,
          pending_review_documents: 1,
          processing_documents: 0,
          ocr_failures: 0,
        },
      }),
    });
  });

  page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));

  // Initialize admin session token in storage
  await page.goto("http://localhost:5180/privacy");
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
  // Test 1: Customer Privacy Page (/privacy) Rendering & Selection
  // -------------------------------------------------------------
  console.log("1. Navigating to Customer Privacy Page (/privacy)...");
  await page.goto("http://localhost:5180/privacy");
  await page.waitForSelector("#privacy-card", { timeout: 8000 });
  await page.waitForTimeout(500);

  // Test action card selection
  console.log("2. Testing action card selection (Withdraw vs Delete)...");
  await page.click("#privacy-option-withdraw");
  await page.waitForTimeout(200);
  const isWithdrawActive = await page.locator("#privacy-option-withdraw.active").count();
  console.log(`Withdraw option active: ${isWithdrawActive === 1}`);

  await page.click("#privacy-option-delete");
  await page.waitForTimeout(200);
  const isDeleteActive = await page.locator("#privacy-option-delete.danger-active").count();
  console.log(`Delete option danger-active: ${isDeleteActive === 1}`);

  // Fill email
  await page.fill("#privacy-email", "anita.sharma@example.com");
  await page.waitForTimeout(300);

  const requestDarkPath = path.join(ARTIFACT_DIR, "privacy_01_request_page_dark.png");
  await page.screenshot({ path: requestDarkPath });
  console.log(`Saved screenshot: ${requestDarkPath}`);

  // -------------------------------------------------------------
  // Test 2: Pre-Submission Interactive Confirmation Dialog Modal
  // -------------------------------------------------------------
  console.log("3. Submitting privacy request to trigger confirmation modal...");
  await page.click("#privacy-submit-btn");
  await page.waitForSelector("#privacy-request-confirm-modal", { timeout: 5000 });
  await page.waitForTimeout(400);

  const requestModalPath = path.join(ARTIFACT_DIR, "privacy_02_request_modal.png");
  await page.screenshot({ path: requestModalPath });
  console.log(`Saved screenshot: ${requestModalPath}`);

  // Confirm request execution
  console.log("4. Executing request from modal...");
  await page.click("#btn-submit-privacy-request");
  await page.waitForSelector("#privacy-dispatched-card", { timeout: 6000 });
  await page.waitForTimeout(500);

  const requestSuccessPath = path.join(ARTIFACT_DIR, "privacy_03_request_success.png");
  await page.screenshot({ path: requestSuccessPath });
  console.log(`Saved screenshot: ${requestSuccessPath}`);

  // -------------------------------------------------------------
  // Test 3: Privacy Confirmation Enclave (/privacy/confirm/:token)
  // -------------------------------------------------------------
  console.log("5. Navigating to Privacy Confirmation Enclave (/privacy/confirm/token-privacy-delete-123)...");
  await page.goto("http://localhost:5180/privacy/confirm/token-privacy-delete-123");
  await page.waitForSelector("#privacy-confirm-card", { timeout: 8000 });
  await page.waitForTimeout(500);

  // Click confirm button to open modal
  console.log("6. Opening confirmation modal in confirm enclave...");
  await page.click("#privacy-confirm-btn");
  await page.waitForSelector("#privacy-confirm-execute-modal", { timeout: 5000 });
  await page.waitForTimeout(400);

  const confirmModalPath = path.join(ARTIFACT_DIR, "privacy_04_confirm_delete_modal.png");
  await page.screenshot({ path: confirmModalPath });
  console.log(`Saved screenshot: ${confirmModalPath}`);

  // Confirm execution
  console.log("7. Confirming execution of privacy directive...");
  await page.click("#confirm-privacy-execute-btn");
  await page.waitForSelector("#privacy-confirm-success-card", { timeout: 6000 });
  await page.waitForTimeout(500);

  const confirmSuccessPath = path.join(ARTIFACT_DIR, "privacy_05_confirm_success.png");
  await page.screenshot({ path: confirmSuccessPath });
  console.log(`Saved screenshot: ${confirmSuccessPath}`);

  // -------------------------------------------------------------
  // Test 4: Expired / Invalid Token Error State
  // -------------------------------------------------------------
  console.log("8. Navigating to expired token (/privacy/confirm/token-expired-999)...");
  await page.goto("http://localhost:5180/privacy/confirm/token-expired-999");
  await page.waitForSelector("#privacy-confirm-card", { timeout: 8000 });
  await page.click("#privacy-confirm-btn");
  await page.waitForSelector("#privacy-confirm-execute-modal", { timeout: 5000 });
  await page.click("#confirm-privacy-execute-btn");
  await page.waitForSelector("#privacy-confirm-error-card", { timeout: 6000 });
  await page.waitForTimeout(500);

  const expiredPath = path.join(ARTIFACT_DIR, "privacy_06_expired_token_state.png");
  await page.screenshot({ path: expiredPath });
  console.log(`Saved screenshot: ${expiredPath}`);

  // -------------------------------------------------------------
  // Test 5: Customer Portal Privacy Integration (/portal/:token)
  // -------------------------------------------------------------
  console.log("9. Testing Customer Portal Data Privacy Card...");
  await page.goto("http://localhost:5180/portal/token-vikram-9821");
  await page.waitForSelector("#portal-privacy-card", { timeout: 8000 });
  await page.waitForTimeout(500);

  const portalPrivacyCard = page.locator("#portal-privacy-card");
  await portalPrivacyCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const portalPrivacyPath = path.join(ARTIFACT_DIR, "privacy_07_portal_privacy_card.png");
  await page.screenshot({ path: portalPrivacyPath });
  console.log(`Saved screenshot: ${portalPrivacyPath}`);

  // -------------------------------------------------------------
  // Test 6: Admin Privacy & Retention Center (/admin/customers/101)
  // -------------------------------------------------------------
  console.log("10. Navigating to Admin Customer Detail Privacy & Retention Panel...");
  await page.goto("http://localhost:5180/admin/customers/101");
  await page.waitForSelector("#customer-detail-page", { timeout: 8000 });
  await page.waitForSelector("#retention-countdown-panel", { timeout: 6000 });
  await page.waitForTimeout(500);

  const adminRetentionPath = path.join(ARTIFACT_DIR, "privacy_08_admin_privacy_retention_panel.png");
  await page.screenshot({ path: adminRetentionPath });
  console.log(`Saved screenshot: ${adminRetentionPath}`);

  // Test Delete Data modal
  console.log("11. Testing Admin Permanent Delete Data modal...");
  await page.click("#btn-trigger-delete-data");
  await page.waitForSelector("#admin-delete-data-modal", { timeout: 5000 });
  await page.waitForTimeout(400);

  const adminDeleteModalPath = path.join(ARTIFACT_DIR, "privacy_09_admin_delete_modal.png");
  await page.screenshot({ path: adminDeleteModalPath });
  console.log(`Saved screenshot: ${adminDeleteModalPath}`);

  // Close modal
  await page.click("#btn-cancel-delete-data");
  await page.waitForTimeout(300);

  // Test Privacy Audit Filter
  console.log("12. Testing Privacy & Consent Audit Trail filter...");
  await page.click("#btn-audit-privacy");
  await page.waitForTimeout(400);
  const privacyAuditCount = await page.locator(".privacy-audit-pill").count();
  console.log(`Filtered privacy events count: ${privacyAuditCount} (expected > 0)`);
  if (privacyAuditCount === 0) {
    throw new Error("Expected privacy audit pills to be rendered in filtered audit view");
  }

  // -------------------------------------------------------------
  // Test 7: High-Contrast Light Mode on Privacy Request Page
  // -------------------------------------------------------------
  console.log("13. Testing High-Contrast Light Mode on /privacy...");
  await page.goto("http://localhost:5180/privacy");
  await page.waitForSelector("#privacy-card", { timeout: 8000 });
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(500);

  const requestLightPath = path.join(ARTIFACT_DIR, "privacy_10_privacy_request_light.png");
  await page.screenshot({ path: requestLightPath });
  console.log(`Saved screenshot: ${requestLightPath}`);

  // Restore dark theme
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(300);

  console.log("=== Phase 6 Privacy, Consent & Data-Deletion UI Verification Succeeded! ===");
  await browser.close();
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
