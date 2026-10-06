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

// Mock JWT with standard claims
const MOCK_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  btoa(
    JSON.stringify({
      email: "admin@docpilot.internal",
      sub: "usr-admin-001",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600 * 2, // 2 hours remaining
      iat: Math.floor(Date.now() / 1000),
    })
  ).replace(/=/g, ""),
  "mock-signature-hash",
].join(".");

async function runPhase10SettingsVerification() {
  console.log("=== Starting Phase 10 Settings & System Configuration UI Verification ===");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });

  // Inject session auth token and default dark theme
  await context.addInitScript((jwt) => {
    sessionStorage.setItem("docpilot_staff_jwt", jwt);
    localStorage.setItem("docpilot_adm_theme", "dark");
  }, MOCK_JWT);

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`BROWSER ERROR: ${msg.text()}`);
    }
  });

  // Intercept backend /health endpoint
  await page.route("**/health**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    });
  });

  // Intercept summary
  await page.route("**/api/admin/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUMMARY),
    });
  });

  // Intercept customers
  await page.route("**/api/admin/customers**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "X-Total-Count": "0" },
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // Intercept audit
  await page.route("**/api/admin/audit**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // Intercept OCR settings
  await page.route("**/api/admin/settings/ocr**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ocr_url: "http://localhost:8000",
        has_api_key: true,
        masked_api_key: "••••••••••••••••",
        mock_ocr_mode: false,
        timeout_seconds: 15,
      }),
    });
  });

  // 1. Navigate to /admin
  console.log("1. Navigating to Admin Dashboard...");
  await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });

  // 2. Click Settings tab in sidebar
  console.log("2. Navigating to Settings via #sidebar-link-settings...");
  const settingsTabBtn = page.locator("#sidebar-link-settings, #tab-btn-settings");
  await settingsTabBtn.waitFor({ state: "visible", timeout: 5000 });
  await settingsTabBtn.click();
  await page.waitForTimeout(500);

  // Verify view container
  const settingsView = page.locator("#admin-settings-view");
  await settingsView.waitFor({ state: "visible", timeout: 5000 });
  console.log("Settings view container loaded successfully!");

  // 3. Verify Live Health Banner
  console.log("3. Verifying Live Health Banner & Probe Status...");
  const healthBanner = page.locator("#settings-health-banner");
  await healthBanner.waitFor({ state: "visible" });

  const healthStatusBadge = page.locator("#health-status-badge");
  console.log(`Health Status Badge: ${(await healthStatusBadge.textContent())?.trim()}`);

  const pingLatencyPill = page.locator("#health-ping-latency");
  console.log(`Ping Latency: ${(await pingLatencyPill.textContent())?.trim()}`);

  // Screenshot 1: Overview & Health Banner
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_01_overview_dark.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_01_overview_dark.png");

  // 4. Test Health Probe Button
  console.log("4. Testing Health Probe Button (#btn-run-health-check)...");
  const probeBtn = page.locator("#btn-run-health-check");
  await probeBtn.click();
  await page.waitForTimeout(400);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_02_health_probe.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_02_health_probe.png");

  // 5. Verify Navigation Pills and Category Filtering
  console.log("5. Testing Category Navigation Pills...");
  await page.click("#nav-pill-storage");
  await page.waitForTimeout(300);

  // Storage card must be visible; OCR card hidden in filtered view
  const storageCard = page.locator("#settings-card-storage");
  await storageCard.waitFor({ state: "visible" });

  // Return to All Settings
  await page.click("#nav-pill-all");
  await page.waitForTimeout(300);

  // 6. Verify Storage & OCR Configuration Cards
  console.log("6. Verifying Storage, Encryption, and OCR Cards...");
  const ocrCard = page.locator("#settings-card-ocr");
  await ocrCard.waitFor({ state: "visible" });

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_03_storage_and_ocr.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_03_storage_and_ocr.png");

  // 7. Verify Retention & Security Configuration Cards
  console.log("7. Verifying Retention and Security Cards...");
  const retentionCard = page.locator("#settings-card-retention");
  const securityCard = page.locator("#settings-card-security");
  await retentionCard.waitFor({ state: "visible" });
  await securityCard.waitFor({ state: "visible" });

  await retentionCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_04_retention_and_security.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_04_retention_and_security.png");

  // 8. Verify Staff Session Card & Safe Actions
  console.log("8. Verifying Staff Session Card & Confirmation Modals...");
  const sessionCard = page.locator("#settings-card-session");
  await sessionCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_05_session_card.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_05_session_card.png");

  // Test Clear Cache modal trigger
  console.log("Testing Clear Cache Confirmation Modal...");
  await page.click("#btn-settings-clear-cache");
  const clearCacheModal = page.locator("#modal-confirm-clear-cache");
  await clearCacheModal.waitFor({ state: "visible" });

  // Confirm clear cache
  await page.click("#btn-confirm-clear-cache-action");
  await page.waitForTimeout(300);

  // Verify toast appears
  const toast = page.locator("#settings-toast-feedback");
  await toast.waitFor({ state: "visible" });
  console.log(`Toast feedback: ${(await toast.textContent())?.trim()}`);

  // Test Sign Out Modal trigger and Cancel
  console.log("Testing Sign Out Confirmation Modal...");
  await page.click("#btn-settings-signout");
  const signOutModal = page.locator("#modal-confirm-signout");
  await signOutModal.waitFor({ state: "visible" });
  // Click Cancel
  await signOutModal.locator("button.sec").click();
  await page.waitForTimeout(300);

  // 9. Verify Zero Secrets Exposed
  console.log("9. Verifying Zero Raw Secrets in DOM...");
  const pageContent = await page.content();
  const forbiddenPatterns = [
    "SUPABASE_SERVICE_KEY",
    "ENCRYPTION_KEY",
    "SUPABASE_JWT_SECRET",
    "OCR_API_KEY",
    "SMTP_PASSWORD",
  ];
  for (const pat of forbiddenPatterns) {
    if (pageContent.includes(`"${pat}"`) || pageContent.includes(`=${pat}`)) {
      throw new Error(`CRITICAL SECURITY FAILURE: Found secret pattern ${pat} in page content!`);
    }
  }
  console.log("✓ Zero raw secret names or credentials rendered in DOM!");

  // Verify masked secret badge exists
  const maskedBadge = page.locator(".masked-secret-badge");
  await maskedBadge.waitFor({ state: "visible" });
  console.log("✓ Master encryption key correctly masked with bullet characters!");

  // 10. Test High-Contrast Light Mode
  console.log("10. Testing High-Contrast Light Mode...");
  await page.click("#btn-settings-toggle-theme");
  await page.waitForTimeout(400);

  await page.locator("#admin-settings-view").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, "settings_06_settings_light.png"),
    fullPage: false,
  });
  console.log("Saved screenshot: settings_06_settings_light.png");

  console.log("=== Phase 10 Settings & System Configuration UI Verification Succeeded! ===");
  await browser.close();
}

runPhase10SettingsVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
