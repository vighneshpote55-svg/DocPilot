import { test, expect } from "@playwright/test";

import * as fs from "fs";

import * as path from "path";

import { fileURLToPath } from "url";



const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fixtures = JSON.parse(

  fs.readFileSync(path.join(__dirname, "test_fixtures.json"), "utf-8")

);



test.describe("DocPilot Acceptance Tests (SPEC Section 8)", () => {

  // --------------------------------------------------------------------------

  // Item 1: Dummy PAN goes from upload to verified with no manual step

  // --------------------------------------------------------------------------

  test("1. Dummy PAN goes from upload to verified with no manual step", async ({ page }) => {

    test.setTimeout(90000);

    await page.goto(`/portal/${fixtures.item1_pan_token}`);



    // Verify initial portal state

    await expect(page.locator("h1")).toContainText("Hello VIKRAM");

    const panCard = page.locator("#doc-card-pan");

    await expect(panCard).toBeVisible();

    await expect(panCard.locator(".tag")).toContainText("Waiting for your upload");



    // Upload dummy PAN image

    const fileInput = panCard.locator("input[type='file']");

    await fileInput.setInputFiles(fixtures.pan_image_path);

    await panCard.locator("button#upload-btn-pan").click();



    // Verify upload message and polling start

    await expect(panCard.locator(".msg")).toContainText("Uploaded. Checking document validity…");



    // Wait for worker OCR & verification to complete automatically

    await expect(panCard.locator(".tag")).toContainText("Received and verified", { timeout: 60000 });

    await expect(panCard.locator(".msg")).toContainText("Document verified successfully.");



    // Progress bar updates and completed banner displays

    await expect(page.locator("#portal-container")).toContainText("1 of 1 documents verified");

    await expect(page.locator("#portal-container")).toContainText(

      "All documents have been verified. Thank you, nothing further is needed."

    );

  });



  // --------------------------------------------------------------------------

  // Item 2: Same PAN into the Aadhaar slot is rejected and asked to resubmit

  // --------------------------------------------------------------------------

  test("2. Same PAN into the Aadhaar slot is rejected and customer is asked to resubmit", async ({ page }) => {

    test.setTimeout(90000);

    await page.goto(`/portal/${fixtures.item2_aadhaar_token}`);



    await expect(page.locator("h1")).toContainText("Hello VIKRAM");

    const aadhCard = page.locator("#doc-card-aadhaar");

    await expect(aadhCard).toBeVisible();



    // Upload PAN image into Aadhaar slot

    const fileInput = aadhCard.locator("input[type='file']");

    await fileInput.setInputFiles(fixtures.pan_image_path);

    await aadhCard.locator("button#upload-btn-aadhaar").click();



    await expect(aadhCard.locator(".msg")).toContainText("Uploaded. Checking document validity…");



    // Wait for worker OCR to detect mismatch and reject

    await expect(aadhCard.locator(".tag")).toContainText("Please upload again", { timeout: 60000 });

    await expect(aadhCard.locator("label")).toContainText("Upload a clear, valid copy again");



    // Upload button is re-enabled for resubmission

    await expect(aadhCard.locator("button#upload-btn-aadhaar")).toBeEnabled();

  });



  // --------------------------------------------------------------------------

  // Item 3: Partial uploads: pending list shrinks

  // --------------------------------------------------------------------------

  test("3. Partial uploads: pending list shrinks after verified upload", async ({ page }) => {

    test.setTimeout(90000);

    await page.goto(`/portal/${fixtures.item3_partial_token}`);



    // Initial state: 0 of 2 verified

    await expect(page.locator("#portal-container")).toContainText("0 of 2 documents verified");



    const panCard = page.locator("#doc-card-pan");

    const salaryCard = page.locator("#doc-card-salary_slip");

    await expect(panCard).toBeVisible();

    await expect(salaryCard).toBeVisible();



    // Upload PAN

    await panCard.locator("input[type='file']").setInputFiles(fixtures.pan_image_path);

    await panCard.locator("button#upload-btn-pan").click();



    // PAN verifies

    await expect(panCard.locator(".tag")).toContainText("Received and verified", { timeout: 60000 });



    // Progress shrinks pending list: 1 of 2 verified

    await expect(page.locator("#portal-container")).toContainText("1 of 2 documents verified", { timeout: 15000 });

    // Salary slip is still waiting for upload

    await expect(salaryCard.locator(".tag")).toContainText("Waiting for your upload");

  });



  // --------------------------------------------------------------------------

  // Item 4: Expired or unknown token returns generic error and leaks nothing

  // --------------------------------------------------------------------------

  test("4. Expired or unknown token returns generic error and leaks nothing", async ({ page }) => {

    // Unknown portal token

    await page.goto(`/portal/${fixtures.item4_unknown_token}`);

    const portalErr = page.locator("#portal-error");

    await expect(portalErr).toBeVisible();

    await expect(portalErr).toContainText("This link is invalid or has expired. Ask for a new link by email.");



    // Ensure zero customer PII is leaked

    const portalBody = await page.textContent("body");

    expect(portalBody).not.toContain("VIKRAM");

    expect(portalBody).not.toContain("@example.com");

    expect(portalBody).not.toContain("CUS-");



    // Expired / unknown consent token

    await page.goto(`/consent/${fixtures.item4_expired_token}`);

    const consentErr = page.locator("#consent-error");

    await expect(consentErr).toBeVisible();

    await expect(consentErr).toContainText("This link is invalid or has expired. Ask for a new link by email.");



    const consentBody = await page.textContent("body");

    expect(consentBody).not.toContain("VIKRAM");

    expect(consentBody).not.toContain("@example.com");

  });



  // --------------------------------------------------------------------------

  // Item 6: Reviewer approve and reject both update pending

  // --------------------------------------------------------------------------

  test("6. Reviewer approve and reject both update pending and verification status", async ({ page }) => {
    test.setTimeout(90000);

    // Inject admin JWT into sessionStorage before navigating

    await page.addInitScript((jwt) => {

      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);

      window.sessionStorage.setItem("jwt", jwt);

    }, fixtures.admin_jwt);



    await page.goto("/admin");

    await page.waitForSelector("#admin-nav-tabs", { timeout: 15000 });



    // Open Manual Reviews tab

    await page.locator("#tab-btn-reviews").click();



    // Verify open review for Anita Verma

    await expect(page.locator("#tab-pane-reviews")).toContainText("ANITA VERMA", { timeout: 15000 });

    await expect(page.locator("#tab-pane-reviews")).toContainText("Flags: name_mismatch", { timeout: 15000 });



    // Enter note and approve

    const noteInput = page.locator(`#review-note-${fixtures.item6_review_id}`);

    await noteInput.fill("Approved after manual inspection of name spelling.");



    await page.locator(`#btn-review-approve-${fixtures.item6_review_id}`).click();



    // Review item clears from open reviews

    await expect(page.locator(`#review-note-${fixtures.item6_review_id}`)).not.toBeVisible();



    // Visit customer detail page to confirm verified status

    await page.goto(`/admin/customers/${fixtures.item6_customer_id}`);

    await expect(page.locator("#customer-detail-page")).toContainText("1 of 1 documents verified");



    // Part B: Test Reviewer Reject flow

    await page.goto("/admin");

    await page.locator("#tab-btn-reviews").click();

    await expect(page.locator("#tab-pane-reviews")).toContainText("RAHUL KHANNA", { timeout: 15000 });



    const rejectNoteInput = page.locator(`#review-note-${fixtures.item6_reject_review_id}`);

    await rejectNoteInput.fill("Document blurry and unreadable. Please resubmit a clean photo.");

    await page.locator(`#btn-review-reject-${fixtures.item6_reject_review_id}`).click();



    // Rejected review item clears from open reviews

    await expect(page.locator(`#review-note-${fixtures.item6_reject_review_id}`)).not.toBeVisible();



    // Visit customer detail page to confirm rejected status & pending count

    await page.goto(`/admin/customers/${fixtures.item6_reject_customer_id}`);

    await expect(page.locator("#customer-detail-page")).toContainText("0 of 1 documents verified");

    await expect(page.locator("#customer-detail-page")).toContainText("Please upload again");

  });





  // --------------------------------------------------------------------------

  // Item 7: Retention deletion shows 'Deleted' on Documents tab

  // --------------------------------------------------------------------------

  test("7. Retention deletion: Documents tab shows 'Deleted' tag instead of file actions", async ({ page }) => {
    test.setTimeout(90000);

    await page.addInitScript((jwt) => {

      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);

      window.sessionStorage.setItem("jwt", jwt);

    }, fixtures.admin_jwt);



    await page.goto(`/admin/customers/${fixtures.item7_customer_id}`);
    await expect(page.locator("#customer-detail-page")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("h2")).toContainText("DELETED FILE TEST");



    // Locate the row for purged_document.pdf

    const docRow = page.locator("tr", { hasText: "purged_document.pdf" });

    await expect(docRow).toBeVisible();



    // Confirm that the Actions column displays "Deleted" badge instead of "Secure view"

    await expect(docRow.locator(".tag.deleted")).toHaveText("Deleted");

    await expect(docRow.locator("button", { hasText: "Secure view" })).not.toBeVisible();

  });



  // --------------------------------------------------------------------------

  // Item 8: Secure View modal opens preview and download button respects policy

  // --------------------------------------------------------------------------

  test("8. Secure View modal opens preview and download button respects policy", async ({ page }) => {
    test.setTimeout(90000);

    await page.addInitScript((jwt) => {

      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);

      window.sessionStorage.setItem("jwt", jwt);

    }, fixtures.admin_jwt);



    // Visit customer 1 (who uploaded verified PAN in Test 1)

    await page.goto(`/admin/customers/${fixtures.item1_customer_id}`);

    await expect(page.locator("#customer-detail-page")).toBeVisible();



    // Verify row with dummy_pan.png exists

    const docRow = page.locator("tr", { hasText: "dummy_pan.png" });

    await expect(docRow).toBeVisible();



    // With ALLOW_DOWNLOAD=false, download button should NOT be visible

    await expect(docRow.locator("button", { hasText: "Download" })).not.toBeVisible();



    // Click "Secure view" button

    const secureViewBtn = docRow.locator("button", { hasText: "Secure view" });

    await expect(secureViewBtn).toBeVisible();

    await secureViewBtn.click();



    // Modal opens with iframe title "Secure Document Preview"

    const iframe = page.locator("iframe[title='Secure Document Preview']");

    await expect(iframe).toBeVisible({ timeout: 10000 });



    // Close preview

    const closeBtn = page.locator("button", { hasText: "Close preview" });

    await expect(closeBtn).toBeVisible();

    await closeBtn.click();



    // Modal closes

    await expect(iframe).not.toBeVisible();

  });

});

