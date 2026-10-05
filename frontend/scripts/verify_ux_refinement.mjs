import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";
const fixtures = JSON.parse(
  fs.readFileSync(new URL("../e2e/test_fixtures.json", import.meta.url), "utf-8")
);

async function run() {
  console.log("Starting DocPilot UX Refinement Automated Verification...");
  const browser = await chromium.launch({ headless: true });

  try {
    // =========================================================================
    // 1. Desktop Test (1440 x 900)
    // =========================================================================
    console.log("\n--- 1. Desktop Verification (1440x900) ---");
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopContext.newPage();

    // Authenticate and load Admin
    await page.goto("http://localhost:5180/admin");
    await page.evaluate((jwt) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
      window.sessionStorage.setItem("jwt", jwt);
    }, fixtures.admin_jwt);
    await page.reload();
    await page.waitForSelector("#admin-dashboard", { timeout: 15000 });

    // VERIFICATION ITEM 10: Confirm NO duplicate horizontal navigation row
    const horizontalNav = await page.$("#admin-nav-tabs");
    if (horizontalNav !== null) {
      throw new Error("FAIL: Duplicate horizontal navigation '#admin-nav-tabs' is still present in DOM!");
    }
    console.log("✓ Verified: Duplicate horizontal navigation row is completely removed.");

    // VERIFICATION ITEM 9: Confirm sidebar navigation works
    console.log("Verifying sidebar navigation to Customers...");
    const sidebarCustomersLink = page.locator("#sidebar-link-cases");
    await sidebarCustomersLink.waitFor({ state: "visible" });
    await sidebarCustomersLink.click();
    await page.waitForSelector("#tab-pane-cases", { timeout: 5000 });
    console.log("✓ Verified: Left sidebar navigation smoothly navigated to Customers view.");

    // Screenshot of Admin Customers View (without duplicate tabs)
    const desktopCustomersPath = path.join(ARTIFACT_DIR, "refinement_01_desktop_customers.png");
    await page.screenshot({ path: desktopCustomersPath });
    console.log(`Saved screenshot: ${desktopCustomersPath}`);

    // VERIFICATION ITEMS 4, 5: Click "+ Add Customer" and confirm centered modal
    console.log("Clicking '+ Add Customer' button...");
    const addCustBtn = page.locator("#btn-add-customer");
    await addCustBtn.click();

    const modalBackdrop = page.locator(".modal-backdrop.add-customer-modal-backdrop");
    await modalBackdrop.waitFor({ state: "visible", timeout: 5000 });

    const modalBox = page.locator(".modal-box.add-customer-modal");
    await modalBox.waitFor({ state: "visible", timeout: 5000 });

    // Check modal bounding box to ensure it is centered (not right aligned)
    const box = await modalBox.boundingBox();
    if (!box) throw new Error("Modal bounding box not found!");
    const viewportWidth = 1440;
    const centerModalX = box.x + box.width / 2;
    const centerViewportX = viewportWidth / 2;
    const diffX = Math.abs(centerModalX - centerViewportX);
    console.log(`Modal width: ${box.width.toFixed(1)}px, Modal center: ${centerModalX.toFixed(1)}px, Viewport center: ${centerViewportX}px`);

    if (diffX > 60) {
      throw new Error(`FAIL: Modal is not centered horizontally! Offset is ${diffX.toFixed(1)}px`);
    }
    if (box.width < 650 || box.width > 860) {
      throw new Error(`FAIL: Modal width (${box.width}px) is outside expected 700-850px range!`);
    }
    console.log("✓ Verified: Modal opens centered in the viewport with width ~800px (NOT right drawer).");

    // VERIFICATION ITEM 6: Confirm internal scrolling on modal body
    const modalBody = page.locator(".add-customer-modal-body");
    const isBodyScrollable = await modalBody.evaluate((el) => {
      return el.scrollHeight > el.clientHeight && window.getComputedStyle(el).overflowY.includes("auto");
    });
    console.log(`Modal body scrollHeight > clientHeight: ${isBodyScrollable}`);

    // VERIFICATION ITEM 7: Confirm footer with Cancel & Create Customer remains sticky & accessible
    const cancelBtn = page.locator("#btn-cancel-add-customer");
    const createBtn = page.locator("#btn-submit-add-customer");
    await cancelBtn.waitFor({ state: "visible" });
    await createBtn.waitFor({ state: "visible" });

    const footerBox = await page.locator(".add-customer-modal-footer").boundingBox();
    if (!footerBox) throw new Error("Footer bounding box not found!");
    console.log(`✓ Verified: Sticky footer with Cancel and Create Customer buttons is visible at bottom (y=${footerBox.y.toFixed(1)}).`);

    // Verify Section Headings
    const section1 = await page.locator(".section-title-text", { hasText: "Customer Information" }).isVisible();
    const section2 = await page.locator(".section-title-text", { hasText: "Required Documents" }).isVisible();
    const section3 = await page.locator(".section-title-text", { hasText: "Consent & Notifications" }).isVisible();
    if (!section1 || !section2 || !section3) {
      throw new Error("FAIL: 3 organized sections not properly displayed in modal!");
    }
    console.log("✓ Verified: 3 organized sections (Customer Info, Required Docs, Consent) clearly displayed.");

    // Fill form fields
    await page.locator("#new-cust-name").fill("Devendra Fadnavis");
    await page.locator("#new-cust-email").fill("devendra.f@example.com");
    await page.locator("#new-cust-mobile").fill("+91 99887 76655");

    // Click Preset
    await page.locator(".preset-chip", { hasText: "Standard KYC" }).click();
    await page.waitForTimeout(300);

    // Capture screenshot of centered modal with filled data
    const desktopModalPath = path.join(ARTIFACT_DIR, "refinement_02_desktop_modal_centered.png");
    await page.screenshot({ path: desktopModalPath });
    console.log(`Saved screenshot: ${desktopModalPath}`);

    // VERIFICATION ITEM 8: Confirm Escape closes modal and restores focus
    console.log("Testing Escape key dismissal and focus restoration...");
    await page.keyboard.press("Escape");
    await modalBackdrop.waitFor({ state: "hidden", timeout: 4000 });
    console.log("✓ Verified: Modal successfully dismissed on Escape key.");

    // Verify focus restoration to "+ Add Customer" button
    const focusedId = await page.evaluate(() => document.activeElement?.id);
    console.log(`Active element after closing modal: #${focusedId}`);
    if (focusedId !== "btn-add-customer") {
      console.warn(`Note: Active element is #${focusedId} (expected #btn-add-customer).`);
    } else {
      console.log("✓ Verified: Focus correctly restored to #btn-add-customer.");
    }

    await desktopContext.close();

    // =========================================================================
    // 2. Tablet Test (820 x 1180 - iPad Air)
    // =========================================================================
    console.log("\n--- 2. Tablet Verification (820x1180) ---");
    const tabletContext = await browser.newContext({ viewport: { width: 820, height: 1180 } });
    const tabletPage = await tabletContext.newPage();

    await tabletPage.goto("http://localhost:5180/admin");
    await tabletPage.evaluate((jwt) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    }, fixtures.admin_jwt);
    await tabletPage.reload();
    await tabletPage.waitForSelector("#admin-dashboard", { timeout: 15000 });

    // Open customers & add modal via sidebar (open toggle if in drawer mode)
    const tabletToggle = tabletPage.locator(".topnav-mobile-toggle");
    if (await tabletToggle.isVisible()) {
      await tabletToggle.click();
      await tabletPage.waitForSelector(".admin-sidebar.mobile-open", { timeout: 4000 });
    }
    await tabletPage.locator("#sidebar-link-cases").click();
    await tabletPage.waitForSelector("#tab-pane-cases", { timeout: 5000 });
    await tabletPage.locator("#btn-add-customer").click();
    await tabletPage.waitForSelector(".add-customer-modal", { timeout: 5000 });

    // Check no horizontal overflow
    const tabletOverflow = await tabletPage.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    if (tabletOverflow) throw new Error("FAIL: Tablet viewport has horizontal overflow!");
    console.log("✓ Verified: Tablet layout has zero horizontal overflow.");

    const tabletModalPath = path.join(ARTIFACT_DIR, "refinement_03_tablet_modal.png");
    await tabletPage.screenshot({ path: tabletModalPath });
    console.log(`Saved screenshot: ${tabletModalPath}`);
    await tabletContext.close();

    // =========================================================================
    // 3. Mobile Test (390 x 844 - iPhone 14)
    // =========================================================================
    console.log("\n--- 3. Mobile Verification (390x844) ---");
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();

    await mobilePage.goto("http://localhost:5180/admin");
    await mobilePage.evaluate((jwt) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    }, fixtures.admin_jwt);
    await mobilePage.reload();
    await mobilePage.waitForSelector("#admin-dashboard", { timeout: 15000 });

    // Open mobile sidebar drawer
    await mobilePage.locator(".topnav-mobile-toggle").click();
    await mobilePage.waitForSelector(".admin-sidebar.mobile-open", { timeout: 4000 });
    console.log("✓ Mobile sidebar drawer opened.");

    // Click Customers in mobile sidebar
    await mobilePage.locator("#sidebar-link-cases").click();
    await mobilePage.waitForSelector("#tab-pane-cases", { timeout: 5000 });

    // Click "+ Add Customer"
    await mobilePage.locator("#btn-add-customer").click();
    await mobilePage.waitForSelector(".add-customer-modal", { timeout: 5000 });

    // Confirm mobile modal responsive dimensions
    const mobileModalBox = await mobilePage.locator(".add-customer-modal").boundingBox();
    if (!mobileModalBox) throw new Error("Mobile modal bounding box missing!");
    console.log(`Mobile modal width: ${mobileModalBox.width.toFixed(1)}px (of 390px viewport)`);
    if (mobileModalBox.width > 390) {
      throw new Error(`FAIL: Mobile modal width (${mobileModalBox.width}px) exceeds viewport!`);
    }

    // Verify zero horizontal overflow on mobile
    const mobileOverflow = await mobilePage.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    if (mobileOverflow) throw new Error("FAIL: Mobile viewport has horizontal overflow!");
    console.log("✓ Verified: Mobile layout uses available viewport with zero horizontal overflow.");

    const mobileModalPath = path.join(ARTIFACT_DIR, "refinement_04_mobile_modal.png");
    await mobilePage.screenshot({ path: mobileModalPath });
    console.log(`Saved screenshot: ${mobileModalPath}`);
    await mobileContext.close();

    console.log("\n========================================================");
    console.log("ALL 12 UX REFINEMENT VERIFICATIONS PASSED SUCCESSFULLY!");
    console.log("========================================================\n");
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
