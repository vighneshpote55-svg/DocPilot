import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, "test_fixtures.json"), "utf-8")
);

const ARTIFACT_DIR = "C:/Users/sachi/.gemini/antigravity-ide/brain/5637c45d-8b81-42f3-8817-6e3b34f5b04a";

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
  await page.locator("#tab-btn-documents").click();
  await page.waitForSelector("#tab-pane-documents", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "admin_documents_tab.png"), fullPage: true });
});
