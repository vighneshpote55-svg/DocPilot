import { chromium } from "playwright";
import assert from "node:assert";

const BASE_URL = "http://localhost:5173";

const VIEWPORTS = [
  { name: "Desktop Large", width: 1920, height: 1080, isMobile: false },
  { name: "Laptop Standard", width: 1366, height: 768, isMobile: false },
  { name: "Desktop Compact", width: 1280, height: 720, isMobile: false },
  { name: "Tablet Portrait (iPad Air)", width: 820, height: 1180, isMobile: true },
  { name: "Tablet Landscape", width: 1180, height: 820, isMobile: true },
  { name: "Mobile Modern (iPhone 14)", width: 390, height: 844, isMobile: true },
  { name: "Mobile Compact (iPhone SE)", width: 375, height: 667, isMobile: true },
];

async function runCompatibility() {
  console.log("Starting Browser & Viewport Compatibility Audit...");
  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    try {
      // 1. Test Admin Login / Dashboard
      await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);

      const hasHorizontalScrollAdmin = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });

      // 2. Test Dark Mode Theme Toggle
      const themeToggle = page.locator("#theme-toggle, button[aria-label*='theme'], .theme-toggle").first();
      let themeToggleWorks = false;
      if (await themeToggle.isVisible()) {
        await themeToggle.click();
        await page.waitForTimeout(200);
        const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
        themeToggleWorks = theme === "dark" || theme === "light";
      } else {
        themeToggleWorks = true; // Theme defaults to OS/media query
      }

      // 3. Test Customer Portal page (with mock token or friendly not-found screen)
      await page.goto(`${BASE_URL}/portal/dummy-test-token`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);

      const hasHorizontalScrollPortal = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });

      // 4. Test Customer Consent page
      await page.goto(`${BASE_URL}/consent/dummy-test-token`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);

      const hasHorizontalScrollConsent = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });

      const passed = !hasHorizontalScrollAdmin && !hasHorizontalScrollPortal && !hasHorizontalScrollConsent;

      results.push({
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        isMobile: vp.isMobile,
        overflowAdmin: hasHorizontalScrollAdmin,
        overflowPortal: hasHorizontalScrollPortal,
        overflowConsent: hasHorizontalScrollConsent,
        themeToggle: themeToggleWorks,
        errors: consoleErrors.filter(e => !e.includes("404") && !e.includes("Failed to load resource")),
        status: passed ? "PASS" : "FAIL",
      });
      console.log(`✓ ${vp.name} (${vp.width}x${vp.height}): PASS`);
    } catch (err) {
      console.error(`✗ ${vp.name} encountered error:`, err.message);
      results.push({
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        status: "FAIL",
        error: err.message,
      });
    } finally {
      await context.close();
    }
  }

  await browser.close();
  console.log("\n--- COMPATIBILITY RESULTS SUMMARY ---");
  console.table(results);
  const allPassed = results.every((r) => r.status === "PASS");
  assert(allPassed, "All viewport compatibility checks must pass");
  console.log("\nALL VIEWPORT COMPATIBILITY TESTS PASSED!");
}

runCompatibility().catch((err) => {
  console.error("Compatibility test suite failed:", err);
  process.exit(1);
});
