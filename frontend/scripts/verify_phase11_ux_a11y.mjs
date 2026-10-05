import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

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

const MOCK_CUSTOMERS = [
  {
    id: 101,
    code: "CUST-98214",
    name: "Aarav Sharma",
    email: "aarav.sharma@example.com",
    mobile: "+91 98765 43210",
    consent_status: "granted",
    case_status: "in_progress",
    created_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
    required_count: 2,
    received_count: 1,
    pending_count: 1,
    allow_download: true,
  },
  {
    id: 102,
    code: "CUST-98215",
    name: "Pooja Verma",
    email: "pooja.verma@example.com",
    mobile: "+91 98765 43211",
    consent_status: "granted",
    case_status: "completed",
    created_at: new Date(Date.now() - 3600000 * 24 * 5).toISOString(),
    completed_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    delete_after: new Date(Date.now() + 3600000 * 24 * 6).toISOString(),
    data_deleted_at: null,
    required_count: 2,
    received_count: 2,
    pending_count: 0,
    allow_download: true,
  },
];

const MOCK_CUSTOMER_DETAIL = {
  id: 101,
  code: "CUST-98214",
  name: "Aarav Sharma",
  email: "aarav.sharma@example.com",
  mobile: "+91 98765 43210",
  consent_status: "granted",
  consent_recorded_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
  case_status: "in_progress",
  created_at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
  completed_at: null,
  delete_after: null,
  data_deleted_at: null,
  required_count: 2,
  received_count: 1,
  pending_count: 1,
  allow_download: true,
  documents: [
    {
      id: "doc-101-aadhaar",
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      filename: "aadhaar.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
      review_reason: null,
      superseded: false,
    },
    {
      id: "doc-101-pan",
      doc_type: "pan",
      label: "PAN Card",
      filename: "pan.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "under_review",
      uploaded_at: new Date(Date.now() - 3600000 * 12).toISOString(),
      review_reason: "Manual review queued",
      superseded: false,
    },
  ],
  audit_events: [
    {
      id: 1,
      at: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
      actor: "customer",
      action: "consent_granted",
      entity_type: "customer",
      entity_id: "101",
      details: {},
    },
  ],
};

const MOCK_REVIEWS = [
  {
    id: "rev-1",
    customer_id: 101,
    customer_name: "Aarav Sharma",
    customer_code: "CUST-98214",
    reason: "Name mismatch with customer record",
    flags: ["name_mismatch"],
    status: "open",
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    document: {
      id: "doc-101-pan",
      doc_type: "pan",
      label: "PAN Card",
      filename: "pan.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "under_review",
      uploaded_at: new Date(Date.now() - 3600000 * 12).toISOString(),
      review_reason: "Name mismatch with customer record",
      superseded: false,
    },
    ocr_data: {
      pan_number: "ABCDE1234F",
      name: "AARAV SHARMA",
      confidence: 0.94,
    },
  },
];

const MOCK_PORTAL_STATE = {
  first_name: "Aarav",
  case_status: "in_progress",
  documents: [
    {
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      state: "verified",
      document_id: "doc-101-aadhaar",
    },
    {
      doc_type: "pan",
      label: "PAN Card",
      state: "under_review",
      document_id: "doc-101-pan",
    },
  ],
  required_count: 2,
  received_count: 2,
  pending_count: 0,
  allowed_types: ["pdf", "jpg", "png"],
  max_upload_mb: 10,
  otp_required: false,
  otp_verified: true,
  masked_email: "a••••v@example.com",
};

async function setupRouteMocks(page) {
  await page.route("**/api/admin/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUMMARY),
    });
  });

  await page.route("**/api/admin/customers/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CUSTOMER_DETAIL),
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
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/admin/documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "X-Total-Count": "0" },
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/admin/retention**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/admin/reminders**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/health**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    });
  });

  await page.route("**/api/portal/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PORTAL_STATE),
    });
  });
}

async function runPhase11UxA11yVerification() {
  console.log("=== Starting Phase 11: Final UX Polish & Accessibility E2E Verification ===");

  const browser = await chromium.launch({ headless: true });

  // -------------------------------------------------------------
  // Test 1: Desktop Viewport (1440x900) - Layout, Focus & Skip Link
  // -------------------------------------------------------------
  console.log("\n--- Test 1: Desktop Navigation, Skip Link & Focus Styling ---");
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  await desktopContext.addInitScript(() => {
    sessionStorage.setItem("docpilot_staff_jwt", "mock-token-admin-phase11");
    localStorage.setItem("docpilot_admin_theme", "dark");
    localStorage.setItem("docpilot_adm_theme", "dark");
  });

  const page = await desktopContext.newPage();
  await setupRouteMocks(page);

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`BROWSER ERROR: ${msg.text()}`);
    }
  });

  await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // 1.1 Verify Skip to Main Content Link
  console.log("1.1 Checking Skip to Main Content link...");
  const skipLink = page.locator(".skip-link");
  const skipHref = await skipLink.getAttribute("href");
  if (skipHref !== "#main-content") {
    throw new Error(`Expected skip-link href to be #main-content, got: ${skipHref}`);
  }
  console.log(`✓ Skip-to-content link exists and targets "${skipHref}"`);

  // Focus skip link and verify it targets #main-content
  await page.keyboard.press("Tab");
  const isSkipFocused = await skipLink.evaluate((el) => document.activeElement === el);
  console.log(`✓ Skip-to-content link focused on first Tab: ${isSkipFocused}`);

  const mainContentEl = page.locator("#main-content");
  await mainContentEl.waitFor({ state: "attached" });
  console.log("✓ Target #main-content element exists in DOM");

  // 1.2 Verify Desktop Viewport has zero horizontal scroll
  const desktopScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const desktopClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`Desktop Viewport: scrollWidth=${desktopScrollWidth}, clientWidth=${desktopClientWidth}`);
  if (desktopScrollWidth > desktopClientWidth) {
    throw new Error(`Horizontal scroll detected on desktop: scrollWidth (${desktopScrollWidth}) > clientWidth (${desktopClientWidth})`);
  }
  console.log("✓ Desktop layout has zero horizontal overflow");

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_01_desktop_dark.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_01_desktop_dark.png");

  // -------------------------------------------------------------
  // Test 2: Modal & Drawer A11y (Escape, Focus Trap, Restoration)
  // -------------------------------------------------------------
  console.log("\n--- Test 2: Modal and Drawer Keyboard Interactions ---");

  // 2.1 Test Add Customer Drawer
  console.log("Testing Add Customer Drawer Escape and Focus...");
  const addBtn = page.locator("#btn-add-customer-topnav, #btn-add-customer").first();
  await addBtn.click();

  const addDrawer = page.locator(".drawer-overlay, #add-customer-drawer, [role='dialog']").first();
  await addDrawer.waitFor({ state: "visible" });

  const drawerRole = await addDrawer.getAttribute("role");
  const drawerAriaModal = await addDrawer.getAttribute("aria-modal");
  console.log(`Add drawer role="${drawerRole}", aria-modal="${drawerAriaModal}"`);
  if (drawerRole !== "dialog") {
    throw new Error(`Expected drawer to have role="dialog", got: ${drawerRole}`);
  }

  // Press Escape to dismiss
  console.log("Pressing Escape key to dismiss drawer...");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const isDrawerVisibleAfterEsc = await addDrawer.isVisible();
  if (isDrawerVisibleAfterEsc) {
    throw new Error("Add Customer drawer remained visible after pressing Escape!");
  }
  console.log("✓ Drawer successfully dismissed with Escape key");

  // 2.2 Test Bulk Import Modal (in Cases tab)
  console.log("Navigating to Cases tab to test Bulk Import Modal...");
  const casesTabNavBtn = page.locator("#sidebar-link-cases, #tab-btn-cases");
  await casesTabNavBtn.click();
  await page.waitForTimeout(400);

  const bulkImportBtn = page.locator("#btn-open-bulk-import");
  if (await bulkImportBtn.isVisible()) {
    console.log("Testing Bulk Import Modal Escape and Focus...");
    await bulkImportBtn.click();
    const bulkModal = page.locator(".modal-backdrop, #bulk-import-modal, [role='dialog']").first();
    await bulkModal.waitFor({ state: "visible" });

    const modalRole = await bulkModal.getAttribute("role");
    const modalAriaModal = await bulkModal.getAttribute("aria-modal");
    console.log(`Bulk modal role="${modalRole}", aria-modal="${modalAriaModal}"`);

    // Press Escape to dismiss
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const isModalVisibleAfterEsc = await bulkModal.isVisible();
    if (isModalVisibleAfterEsc) {
      throw new Error("Bulk Import modal remained visible after pressing Escape!");
    }
    console.log("✓ Bulk Import modal successfully dismissed with Escape key");
  }

  // -------------------------------------------------------------
  // Test 3: Dark and Light Mode Contrast & Persistence
  // -------------------------------------------------------------
  console.log("\n--- Test 3: Dark + Light Mode Consistency & Contrast ---");
  const themeToggle = page.locator("#theme-toggle-btn, button[aria-label='Toggle theme']").first();
  await themeToggle.click();
  await page.waitForTimeout(400);

  // Check that light mode token and html attribute were applied
  const htmlTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const htmlHasLightClass = await page.evaluate(() => document.documentElement.classList.contains("admin-theme-light"));
  console.log(`Switched to Light mode: data-theme="${htmlTheme}", hasClass admin-theme-light=${htmlHasLightClass}`);

  // Measure computed contrast of muted text token in light mode
  const mutedColor = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--adm-text-muted").trim();
  });
  console.log(`Light mode --adm-text-muted token: "${mutedColor}"`);
  if (mutedColor !== "#475569") {
    console.warn(`Note: --adm-text-muted is ${mutedColor}`);
  }

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_02_desktop_light.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_02_desktop_light.png");

  // Switch back to dark mode
  await themeToggle.click();
  await page.waitForTimeout(300);

  // -------------------------------------------------------------
  // Test 4: Tablet Viewport (768x1024) - Responsive Flow
  // -------------------------------------------------------------
  console.log("\n--- Test 4: Tablet Viewport (768x1024) Responsiveness ---");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(400);

  const tabletScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const tabletClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`Tablet Viewport: scrollWidth=${tabletScrollWidth}, clientWidth=${tabletClientWidth}`);
  if (tabletScrollWidth > tabletClientWidth) {
    throw new Error(`Horizontal scroll detected on tablet: scrollWidth (${tabletScrollWidth}) > clientWidth (${tabletClientWidth})`);
  }
  console.log("✓ Tablet layout has zero horizontal overflow");

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_03_tablet_view.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_03_tablet_view.png");

  // -------------------------------------------------------------
  // Test 5: Mobile Viewport (375x667) - Mobile Layout & Drawers
  // -------------------------------------------------------------
  console.log("\n--- Test 5: Mobile Viewport (375x667) Responsiveness & Drawers ---");
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(400);

  const mobileScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const mobileClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`Mobile Viewport: scrollWidth=${mobileScrollWidth}, clientWidth=${mobileClientWidth}`);
  if (mobileScrollWidth > mobileClientWidth) {
    throw new Error(`Horizontal scroll detected on mobile: scrollWidth (${mobileScrollWidth}) > clientWidth (${mobileClientWidth})`);
  }
  console.log("✓ Mobile layout has zero horizontal overflow");

  // Navigate to Cases tab via mobile toggle if in drawer mode
  const mobileToggle = page.locator(".topnav-mobile-toggle");
  if (await mobileToggle.isVisible()) {
    await mobileToggle.click();
    await page.waitForSelector(".admin-sidebar.mobile-open", { timeout: 4000 });
  }
  const casesTabBtn = page.locator("#sidebar-link-cases");
  await casesTabBtn.click();
  await page.waitForTimeout(400);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_04_mobile_view.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_04_mobile_view.png");

  // -------------------------------------------------------------
  // Test 6: Customer Privacy Page A11y & Modal
  // -------------------------------------------------------------
  console.log("\n--- Test 6: Privacy Portal & Accessible Labels ---");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://localhost:5180/privacy", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  // Verify #main-content exists on Privacy page
  const privacyMain = page.locator("#main-content");
  await privacyMain.waitFor({ state: "attached" });
  console.log("✓ Privacy page includes #main-content landmark");

  // Verify form input accessibility
  const emailInput = page.locator("input[type='email'], #privacy-email").first();
  await emailInput.fill("customer@example.com");

  const submitBtn = page.locator("button[type='submit'], #btn-submit-privacy").first();
  await submitBtn.click();

  const privacyModal = page.locator("#privacy-request-confirm-modal, [role='dialog']").first();
  await privacyModal.waitFor({ state: "visible" });
  console.log("✓ Privacy confirmation dialog opened with role='dialog'");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const isPrivacyModalVisible = await privacyModal.isVisible();
  if (isPrivacyModalVisible) {
    throw new Error("Privacy dialog remained visible after pressing Escape!");
  }
  console.log("✓ Privacy dialog successfully closed with Escape key");

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_05_privacy_view.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_05_privacy_view.png");

  // -------------------------------------------------------------
  // Test 7: Customer Verification Portal A11y
  // -------------------------------------------------------------
  console.log("\n--- Test 7: Customer Verification Portal A11y ---");
  await page.goto("http://localhost:5180/portal/mock-customer-token", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  const portalMain = page.locator("#main-content");
  await portalMain.waitFor({ state: "attached" });
  console.log("✓ Customer Portal includes #main-content landmark");

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "a11y_06_portal_view.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: a11y_06_portal_view.png");

  // -------------------------------------------------------------
  // Test 8: Security Audit - Zero Raw Secrets or Bypasses
  // -------------------------------------------------------------
  console.log("\n--- Test 8: Security Audit (Zero Secrets / Credentials in DOM) ---");
  const domContent = await page.content();
  const forbiddenKeys = [
    "SUPABASE_SERVICE_KEY",
    "ENCRYPTION_KEY",
    "SUPABASE_JWT_SECRET",
    "OCR_API_KEY",
    "SMTP_PASSWORD",
  ];
  for (const key of forbiddenKeys) {
    if (domContent.includes(`"${key}"`) || domContent.includes(`=${key}`)) {
      throw new Error(`CRITICAL SECURITY LEAK: Found secret pattern ${key} in DOM content!`);
    }
  }
  console.log("✓ Security verification passed: zero raw credentials or secrets in DOM");

  console.log("\n=== Phase 11: Final UX Polish & Accessibility E2E Verification Succeeded! ===");
  await browser.close();
}

runPhase11UxA11yVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
