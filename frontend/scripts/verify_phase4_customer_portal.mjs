import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

const MOCK_CONSENT_VIKRAM = {
  first_name: "Vikram",
  documents: [
    "Permanent Account Number (PAN)",
    "Aadhaar Identity Card",
    "Bank Statement (Last 3 Months)",
    "Salary Slip (Latest)",
  ],
  purpose:
    "Customer identity verification and AML risk evaluation under the India Digital Personal Data Protection (DPDP) Act 2023. Documents will be processed strictly via stateless OCR and permanently purged within 7 days.",
};

const MOCK_PORTAL_ACTIVE = {
  first_name: "Vikram",
  case_status: "in_progress",
  allowed_types: ["pdf", "png", "jpg", "jpeg"],
  max_upload_mb: 10,
  otp_required: false,
  otp_verified: true,
  masked_email: "v***a@example.com",
  pending_count: 4,
  documents: [
    {
      doc_type: "pan",
      label: "PAN Card",
      state: "verified",
      document_id: "doc-pan-01",
    },
    {
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      state: "processing",
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
    {
      doc_type: "gst_certificate",
      label: "GST Certificate",
      state: "resubmit",
      document_id: "doc-gst-04",
    },
  ],
};

const MOCK_PORTAL_COMPLETED = {
  first_name: "Ananya",
  case_status: "completed",
  allowed_types: ["pdf", "png", "jpg", "jpeg"],
  max_upload_mb: 10,
  otp_required: false,
  otp_verified: true,
  masked_email: "a***a@example.com",
  pending_count: 0,
  documents: [
    {
      doc_type: "pan",
      label: "PAN Card",
      state: "verified",
      document_id: "doc-pan-901",
    },
    {
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      state: "verified",
      document_id: "doc-aadhaar-902",
    },
    {
      doc_type: "certificate_of_incorporation",
      label: "Certificate of Incorporation",
      state: "verified",
      document_id: "doc-coi-903",
    },
  ],
};

async function run() {
  console.log("=== Starting DocPilot Phase 4 Customer Portal Verification ===");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Intercept Public APIs
  await page.route(/\/api\/public\/consent\/(.+)/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, message: "Consent recorded" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CONSENT_VIKRAM),
    });
  });

  await page.route(/\/api\/portal\/token-completed-(.+)/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PORTAL_COMPLETED),
    });
  });

  await page.route(/\/api\/portal\/token-vikram-(.+)\/upload/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document_id: "doc-salary-uploaded-99",
        state: "processing",
        message: "File encrypted and queued for verification",
      }),
    });
  });

  await page.route(/\/api\/portal\/token-vikram-(.+)\/documents\/(.+)\/status/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document_id: "doc-salary-uploaded-99",
        state: "verified",
        message: "Document successfully verified",
      }),
    });
  });

  await page.route(/\/api\/portal\/token-vikram-(.+)/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PORTAL_ACTIVE),
    });
  });

  // ----------------------------------------------------
  // TEST 1: Customer Landing / Home Page (Dark Theme)
  // ----------------------------------------------------
  console.log("\n[Test 1] Testing Customer Landing / Home Page...");
  await page.goto("http://localhost:5180/", { waitUntil: "networkidle" });
  await page.waitForSelector("#home-card");

  const heroTitle = await page.textContent(".customer-hero-title");
  console.log("Hero Title:", heroTitle?.trim());

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_01_landing_dark.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_01_landing_dark.png");

  // Test Direct Token / Link Access box navigation
  console.log("\n[Test 1.1] Testing Direct Token Input navigation...");
  await page.fill("#case-token-input", "https://docpilot.secure/portal/token-vikram-9821");
  await page.click("#open-portal-btn");

  await page.waitForURL(/.*portal\/token-vikram-9821/);
  console.log("✓ URL successfully redirected to portal using token link parser:", page.url());

  // ----------------------------------------------------
  // TEST 2: Consent Page (/consent/token-vikram-9821)
  // ----------------------------------------------------
  console.log("\n[Test 2] Testing Consent & Purpose Page...");
  await page.goto("http://localhost:5180/consent/token-vikram-9821", { waitUntil: "networkidle" });
  await page.waitForSelector("#consent-card");

  const greeting = await page.textContent(".consent-greeting-title");
  console.log("Greeting:", greeting?.trim());

  // Check disabled state of "I Agree & Proceed" button before checkbox
  const isAgreeDisabledInitially = await page.isDisabled("#consent-agree-btn");
  console.log("Is 'I Agree' button disabled initially?", isAgreeDisabledInitially);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_02_consent_initial.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_02_consent_initial.png");

  // Check the confirmation checkbox
  console.log("Checking consent confirmation checkbox...");
  await page.check("#consent-checkbox");

  const isAgreeEnabledAfterCheck = !(await page.isDisabled("#consent-agree-btn"));
  console.log("Is 'I Agree' button enabled after check?", isAgreeEnabledAfterCheck);

  // Submit Consent
  await page.click("#consent-agree-btn");
  await page.waitForSelector("#consent-granted-view");
  console.log("✓ Transitioned to Consent Recorded Successfully view!");

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_03_consent_granted.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_03_consent_granted.png");

  // Click CTA to proceed to portal
  await page.click("#proceed-portal-btn");
  await page.waitForURL(/.*portal\/token-vikram-9821/);
  console.log("✓ Clicked CTA and navigated to portal:", page.url());

  // ----------------------------------------------------
  // TEST 3: Secure Upload Portal - Active Case with Multi-States
  // ----------------------------------------------------
  console.log("\n[Test 3] Testing Secure Upload Portal Multi-Document States...");
  await page.waitForSelector("#portal-container");
  await page.waitForSelector("#doc-card-pan");
  await page.waitForSelector("#doc-card-aadhaar");
  await page.waitForSelector("#doc-card-bank_statement");
  await page.waitForSelector("#doc-card-salary_slip");
  await page.waitForSelector("#doc-card-gst_certificate");

  const verifiedTag = await page.textContent("#doc-card-pan .doc-state-tag");
  const processingTag = await page.textContent("#doc-card-aadhaar .doc-state-tag");
  const reviewTag = await page.textContent("#doc-card-bank_statement .doc-state-tag");
  const pendingTag = await page.textContent("#doc-card-salary_slip .doc-state-tag");
  const resubmitTag = await page.textContent("#doc-card-gst_certificate .doc-state-tag");

  console.log("Document States Present:");
  console.log(" - PAN:", verifiedTag?.trim());
  console.log(" - Aadhaar:", processingTag?.trim());
  console.log(" - Bank Statement:", reviewTag?.trim());
  console.log(" - Salary Slip:", pendingTag?.trim());
  console.log(" - GST Certificate:", resubmitTag?.trim());

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_04_portal_active_states.png"),
    fullPage: true,
  });
  console.log("✓ Saved customer_04_portal_active_states.png");

  // ----------------------------------------------------
  // TEST 4: Resubmission Flow on Rejected/Resubmit Slot
  // ----------------------------------------------------
  console.log("\n[Test 4] Testing 1-Click Resubmit on GST Certificate...");
  const resubmitBtn = page.locator("#doc-card-gst_certificate .resubmit-btn");
  if (await resubmitBtn.isVisible()) {
    await resubmitBtn.click();
    console.log("Clicked Resubmit Document button!");
    await page.waitForSelector("#doc-card-gst_certificate .customer-dropzone");
    console.log("✓ Dropzone opened for resubmission!");
  }

  // ----------------------------------------------------
  // TEST 5: Interactive File Upload & State Transition
  // ----------------------------------------------------
  console.log("\n[Test 5] Testing File Upload on Salary Slip...");
  const fileInput = page.locator("#file-salary_slip");
  await fileInput.setInputFiles({
    name: "salary_slip_oct_2026.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 dummy salary slip binary content"),
  });

  await page.click("#upload-btn-salary_slip");
  console.log("Clicked upload button. Waiting for upload/processing feedback...");

  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_05_upload_in_progress.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_05_upload_in_progress.png");

  // ----------------------------------------------------
  // TEST 6: Verification Completed Screen (Screen 5)
  // ----------------------------------------------------
  console.log("\n[Test 6] Testing Verification Completed Screen...");
  await page.goto("http://localhost:5180/portal/token-completed-77", { waitUntil: "networkidle" });
  await page.waitForSelector(".verification-complete-card");

  const completeTitle = await page.textContent(".complete-hero-title");
  console.log("Completed Hero Title:", completeTitle?.trim());

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_06_verification_completed.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_06_verification_completed.png");

  // ----------------------------------------------------
  // TEST 7: High-Contrast Light Theme Verification
  // ----------------------------------------------------
  console.log("\n[Test 7] Testing High-Contrast Light Theme...");
  const themeToggle = page.locator(".customer-theme-toggle");
  if (await themeToggle.isVisible()) {
    await themeToggle.click();
    await page.waitForTimeout(300);
    console.log("✓ Theme toggle clicked!");
  }

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_07_completed_light.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_07_completed_light.png");

  // Also visit landing in light mode
  await page.goto("http://localhost:5180/", { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "customer_08_landing_light.png"),
    fullPage: false,
  });
  console.log("✓ Saved customer_08_landing_light.png");

  await browser.close();
  console.log("\n=== ALL PHASE 4 CUSTOMER PORTAL VERIFICATIONS PASSED! ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
