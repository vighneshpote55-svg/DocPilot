import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";
const fixtures = JSON.parse(
  fs.readFileSync(new URL("../e2e/test_fixtures.json", import.meta.url), "utf-8")
);

async function run() {
  console.log("Launching Chromium for dashboard verification...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Navigate to /admin
  console.log("Navigating to http://localhost:5180/admin...");
  await page.goto("http://localhost:5180/admin");

  // Inject JWT
  await page.evaluate((jwt) => {
    window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    window.sessionStorage.setItem("jwt", jwt);
  }, fixtures.admin_jwt);

  // Reload
  await page.reload();
  await page.waitForSelector("#admin-dashboard", { timeout: 15000 });
  console.log("Admin Dashboard loaded successfully!");

  // Wait a moment for charts to render
  await page.waitForTimeout(1000);

  // 1. Capture Dark-Blue Dashboard Overview
  const darkDashboardPath = path.join(ARTIFACT_DIR, "admin_dashboard_dark.png");
  await page.screenshot({ path: darkDashboardPath, fullPage: true });
  console.log(`Saved screenshot: ${darkDashboardPath}`);

  // 2. Test Sidebar Collapse
  console.log("Testing sidebar collapse...");
  await page.locator(".sidebar-collapse-btn").click();
  await page.waitForTimeout(500);
  const collapsedPath = path.join(ARTIFACT_DIR, "admin_dashboard_collapsed.png");
  await page.screenshot({ path: collapsedPath, fullPage: true });
  console.log(`Saved screenshot: ${collapsedPath}`);

  // Expand sidebar again
  await page.locator(".sidebar-collapse-btn").click();
  await page.waitForTimeout(500);

  // 3. Test Theme Toggle (Dark -> Light)
  console.log("Testing theme toggle to light mode...");
  await page.locator("#theme-toggle-btn").click();
  await page.waitForTimeout(500);
  const lightDashboardPath = path.join(ARTIFACT_DIR, "admin_dashboard_light.png");
  await page.screenshot({ path: lightDashboardPath, fullPage: true });
  console.log(`Saved screenshot: ${lightDashboardPath}`);

  // Switch back to Dark-Blue
  await page.locator("#theme-toggle-btn").click();
  await page.waitForTimeout(500);

  // 4. Test Reports View
  console.log("Navigating to Reports view...");
  await page.locator("#sidebar-link-reports").click();
  await page.waitForSelector("#admin-reports-view", { timeout: 10000 });
  await page.waitForTimeout(500);
  const reportsPath = path.join(ARTIFACT_DIR, "admin_reports_view.png");
  await page.screenshot({ path: reportsPath, fullPage: true });
  console.log(`Saved screenshot: ${reportsPath}`);

  // 5. Test Settings View
  console.log("Navigating to Settings view...");
  await page.locator("#sidebar-link-settings").click();
  await page.waitForSelector("#admin-settings-view", { timeout: 10000 });
  await page.waitForTimeout(500);
  const settingsPath = path.join(ARTIFACT_DIR, "admin_settings_view.png");
  await page.screenshot({ path: settingsPath, fullPage: true });
  console.log(`Saved screenshot: ${settingsPath}`);

  // 6. Test Customers View
  console.log("Navigating to Customers view...");
  await page.locator("#sidebar-link-cases").click();
  await page.waitForSelector("#tab-pane-cases", { timeout: 10000 });
  await page.waitForTimeout(500);
  const customersPath = path.join(ARTIFACT_DIR, "admin_customers_view.png");
  await page.screenshot({ path: customersPath, fullPage: true });
  console.log(`Saved screenshot: ${customersPath}`);

  // 7. Test Documents View
  console.log("Navigating to Documents view...");
  await page.locator("#sidebar-link-documents").click();
  await page.waitForSelector("#tab-pane-documents", { timeout: 10000 });
  await page.waitForTimeout(500);
  const documentsPath = path.join(ARTIFACT_DIR, "admin_documents_view.png");
  await page.screenshot({ path: documentsPath, fullPage: true });
  console.log(`Saved screenshot: ${documentsPath}`);

  // 8. Test Manual Reviews View
  console.log("Navigating to Manual Reviews view...");
  await page.locator("#sidebar-link-reviews").click();
  await page.waitForSelector("#tab-pane-reviews", { timeout: 10000 });
  await page.waitForTimeout(500);
  const reviewsPath = path.join(ARTIFACT_DIR, "admin_reviews_view.png");
  await page.screenshot({ path: reviewsPath, fullPage: true });
  console.log(`Saved screenshot: ${reviewsPath}`);

  console.log("All dashboard views tested and verified successfully!");
  await browser.close();
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
