import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(__dirname, "test_fixtures.json");
const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8"));
const jwt = fixtures.admin_jwt;

async function run() {
  const browser = await chromium.launch({ headless: true });

  const viewports = [
    {
      name: "scale150_1280x720",
      width: 1280,
      height: 720,
      deviceScaleFactor: 1.5,
      isMobile: false,
    },
    {
      name: "scale150_1280x580_chrome",
      width: 1280,
      height: 580,
      deviceScaleFactor: 1.5,
      isMobile: false,
    },
    {
      name: "laptop_1366x768",
      width: 1366,
      height: 768,
      deviceScaleFactor: 1.0,
      isMobile: false,
    },
    {
      name: "tablet_820x1180",
      width: 820,
      height: 1180,
      deviceScaleFactor: 2.0,
      isMobile: true,
    },
    {
      name: "mobile_390x844",
      width: 390,
      height: 844,
      deviceScaleFactor: 3.0,
      isMobile: true,
    },
  ];

  for (const vp of viewports) {
    console.log(`Testing viewport: ${vp.name} (${vp.width}x${vp.height} dpr:${vp.deviceScaleFactor})`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
    });

    const page = await context.newPage();
    await page.addInitScript((token) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", token);
      window.sessionStorage.setItem("jwt", token);
    }, jwt);

    try {
      await page.goto("http://localhost:5180/admin", { waitUntil: "networkidle" });
      await page.waitForTimeout(600);

      // Capture dashboard
      await page.screenshot({
        path: path.join(ARTIFACT_DIR, `verify_${vp.name}_dashboard.png`),
        fullPage: false,
      });

      // Navigate to customers tab
      const customersBtn = page.locator("#sidebar-link-cases, text='Customers'").first();
      if (await customersBtn.isVisible()) {
        await customersBtn.click();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: path.join(ARTIFACT_DIR, `verify_${vp.name}_customers.png`),
          fullPage: false,
        });
      }

      // If this is the 1280x580 viewport (user's height scenario with toolbars) or 1280x720, test "+ Add Customer" modal
      if (vp.name.includes("1280")) {
        const addBtn = page.locator("#btn-add-customer-topnav, #btn-add-customer, text='+ Add Customer'").first();
        if (await addBtn.isVisible()) {
          await addBtn.click();
          await page.waitForSelector(".add-customer-modal", { timeout: 4000 });
          await page.waitForTimeout(400);
          await page.screenshot({
            path: path.join(ARTIFACT_DIR, `verify_${vp.name}_modal.png`),
            fullPage: false,
          });
          // Close modal
          const closeBtn = page.locator(".modal-close-btn, .btn-modal-cancel").first();
          if (await closeBtn.isVisible()) {
            await closeBtn.click();
            await page.waitForTimeout(300);
          }
        }
      }

      // Also check Documents tab on 1280x720
      if (vp.name === "scale150_1280x720") {
        const docsBtn = page.locator("#sidebar-link-documents, text='Documents'").first();
        if (await docsBtn.isVisible()) {
          await docsBtn.click();
          await page.waitForTimeout(600);
          await page.screenshot({
            path: path.join(ARTIFACT_DIR, `verify_${vp.name}_documents.png`),
            fullPage: false,
          });
        }
      }
    } catch (err) {
      console.error(`Error capturing for ${vp.name}:`, err);
    } finally {
      await context.close();
    }
  }

  await browser.close();
  console.log("All viewport captures finished successfully!");
}

run();
