import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, "test_fixtures.json"), "utf-8")
);

const ARTIFACT_DIR = "C:/Users/sachi/.gemini/antigravity-ide/brain/fe7231fc-0868-4325-9eee-49f992f42862";

test("1. Capture Customer Portal screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/portal/${fixtures.item3_partial_token}`);
  await page.waitForSelector("#portal-container", { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "customer_portal.png"), fullPage: true });
});

test("2. Capture Admin Dashboard screenshots", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript((jwt) => {
    window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    window.sessionStorage.setItem("jwt", jwt);
  }, fixtures.admin_jwt);

  await page.goto("/admin");
  await page.waitForSelector("#summary-stats-grid", { timeout: 30000 });
  await page.waitForSelector("table tbody tr", { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "admin_dashboard.png"), fullPage: true });

  // Switch to All documents tab
  await page.locator("#sidebar-link-documents, #tab-btn-documents").click();
  await page.waitForSelector("#tab-pane-documents", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "admin_documents_tab.png"), fullPage: true });

  // Switch to Manual Reviews tab
  await page.locator("#sidebar-link-reviews, #tab-btn-reviews").click();
  await page.waitForSelector("#tab-pane-reviews", { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "admin_reviews_tab.png"), fullPage: true });
});
