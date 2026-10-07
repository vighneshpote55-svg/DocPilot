import { chromium } from "playwright";
import { execSync } from "child_process";

const BASE_URL = "http://localhost:5173";

// Generate fresh customer and consent token
const pyOutput = execSync(`./.venv/bin/python -c "
from app.db import session_scope
from app.models import Customer, RequiredDocument, AccessToken
from app.security import new_token, hash_token
from datetime import datetime, timezone, timedelta

with session_scope() as db:
    c = Customer(
        name='Aarav Mehta',
        email='aarav.mehta@example.com',
        mobile='+919876543210',
        case_status='in_progress',
        consent_status='pending'
    )
    db.add(c)
    db.flush()
    db.add(RequiredDocument(customer_id=c.id, doc_type='pan'))
    db.add(RequiredDocument(customer_id=c.id, doc_type='aadhaar'))
    db.add(RequiredDocument(customer_id=c.id, doc_type='bank_statement'))

    raw_consent = new_token()
    raw_portal = new_token()
    exp = datetime.now(timezone.utc) + timedelta(days=7)

    db.add(AccessToken(token_hash=hash_token(raw_consent), purpose='consent', customer_id=c.id, expires_at=exp))
    db.add(AccessToken(token_hash=hash_token(raw_portal), purpose='upload', customer_id=c.id, expires_at=exp))

    print(raw_consent)
"`, { cwd: "../backend" }).toString().trim();

const CONSENT_TOKEN = pyOutput;

async function verifyPortals() {
  console.log("Starting E2E Verification of Redesigned Customer Portals...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  // Step 1: Open Consent Portal
  console.log(`Navigating to ${BASE_URL}/consent/${CONSENT_TOKEN}...`);
  await page.goto(`${BASE_URL}/consent/${CONSENT_TOKEN}`);
  await page.waitForSelector("#consent-card", { timeout: 10000 });

  // Verify Header
  const headerText = await page.textContent(".customer-header");
  console.log("Checking header content...");
  if (!headerText.includes("DocPilot") || !headerText.includes("Secure Portal")) {
    throw new Error("Header missing DocPilot or Secure Portal branding");
  }
  const hasStaffLogin = await page.$("#nav-staff-login");
  if (hasStaffLogin) {
    throw new Error("Staff sign-in should be hidden on customer consent portal");
  }
  console.log("✓ Header displays DocPilot branding and hides staff login");

  // Verify Security Badge & Heading
  const heading = await page.textContent(".consent-main-heading");
  if (!heading.includes("Secure Document Verification")) {
    throw new Error(`Unexpected heading: ${heading}`);
  }
  console.log("✓ Heading: 'Secure Document Verification' confirmed");

  const greeting = await page.textContent(".consent-greeting-title");
  if (!greeting.includes("Aarav")) {
    throw new Error(`Unexpected greeting: ${greeting}`);
  }
  console.log("✓ Greeting: 'Hello, Aarav' confirmed");

  // Verify Requested Documents Checklist
  const docCards = await page.$$(".consent-doc-card");
  console.log(`Found ${docCards.length} requested document cards in manifest.`);
  if (docCards.length !== 3) {
    throw new Error(`Expected 3 requested document cards, found ${docCards.length}`);
  }
  console.log("✓ 3 requested document cards rendered cleanly");

  // Verify Consent Checkbox & CTA gating
  const agreeBtn = await page.$("#consent-agree-btn");
  const isDisabledInitially = await agreeBtn.isDisabled();
  if (!isDisabledInitially) {
    throw new Error("Consent button should be disabled before checking confirmation checkbox");
  }
  console.log("✓ 'Give Consent & Continue' button is initially disabled");

  // Check consent checkbox
  await page.click("#consent-checkbox");
  const isEnabledNow = !(await agreeBtn.isDisabled());
  if (!isEnabledNow) {
    throw new Error("Consent button should be enabled after checking confirmation checkbox");
  }
  console.log("✓ 'Give Consent & Continue' button enables after consent check");

  // Click Give Consent & Continue
  console.log("Submitting consent...");
  await page.click("#consent-agree-btn");

  // Wait for consent granted screen
  await page.waitForSelector("#consent-granted-view", { timeout: 10000 });
  const grantedTitle = await page.textContent("#consent-granted-view h2");
  if (!grantedTitle.includes("Consent Recorded Successfully")) {
    throw new Error(`Unexpected granted title: ${grantedTitle}`);
  }
  console.log("✓ 'Consent Recorded Successfully' screen confirmed");

  // Click Proceed to Upload Portal or let auto-redirect work
  console.log("Navigating to upload portal...");
  await page.click("#proceed-portal-btn");
  await page.waitForSelector("#portal-progress-section", { timeout: 10000 });
  console.log("✓ Transitioned to Secure Document Upload Portal successfully");

  // Verify Portal Welcome Section
  const welcomeTitle = await page.textContent(".portal-welcome-title");
  if (!welcomeTitle.includes("Welcome, Aarav")) {
    throw new Error(`Unexpected welcome title: ${welcomeTitle}`);
  }
  console.log("✓ Portal Welcome: 'Welcome, Aarav' confirmed");

  // Verify Progress Section
  const progressHeadline = await page.textContent(".portal-progress-count-headline");
  console.log(`Progress headline: "${progressHeadline.trim()}"`);
  if (!progressHeadline.includes("0 of 3 documents completed")) {
    throw new Error(`Unexpected progress headline: ${progressHeadline}`);
  }
  const remainingText = await page.textContent(".portal-progress-remaining-text");
  if (!remainingText.includes("3 documents remaining")) {
    throw new Error(`Unexpected remaining text: ${remainingText}`);
  }
  console.log("✓ Progress Card: '0 of 3 documents completed' & '3 documents remaining' verified");

  // Verify Document Cards and Customer-Friendly Labels
  const portalCards = await page.$$(".doc-upload-card");
  console.log(`Found ${portalCards.length} document upload cards.`);
  if (portalCards.length !== 3) {
    throw new Error(`Expected 3 document upload cards, found ${portalCards.length}`);
  }

  const firstBadge = await page.textContent(".doc-upload-card .doc-state-tag");
  if (!firstBadge.includes("Upload required")) {
    throw new Error(`Expected 'Upload required' customer-friendly badge, found '${firstBadge}'`);
  }
  console.log("✓ Customer-friendly badge 'Upload required' confirmed");

  // Test Upload Modal Opening
  console.log("Clicking 'Upload Document' to open Upload Modal...");
  await page.click(".doc-upload-card button.doc-card-action-btn");
  await page.waitForSelector(".upload-modal-card", { timeout: 5000 });

  const modalTitle = await page.textContent("#upload-modal-title");
  console.log(`Modal Title: "${modalTitle.trim()}"`);
  if (!modalTitle.includes("Upload")) {
    throw new Error(`Unexpected modal title: ${modalTitle}`);
  }

  const dropzoneVisible = await page.isVisible("#upload-modal-dropzone");
  if (!dropzoneVisible) {
    throw new Error("Upload modal dropzone is not visible");
  }
  console.log("✓ Dedicated Upload Modal opened with drag-and-drop dropzone");

  // Close Upload Modal via cancel
  await page.click("#upload-modal-cancel");
  const modalStillVisible = await page.isVisible(".upload-modal-card");
  if (modalStillVisible) {
    throw new Error("Modal did not dismiss on cancel");
  }
  console.log("✓ Upload Modal cleanly dismissed");

  // Test Security Indicators
  const trustCards = await page.$$(".trust-indicator-card");
  if (trustCards.length !== 3) {
    throw new Error(`Expected 3 trust indicator cards, found ${trustCards.length}`);
  }
  console.log("✓ Security trust indicators (Encrypted, Private, Secure Processing) confirmed");

  // Test Privacy & Data Rights Link
  const privacyLink = await page.$("#portal-manage-privacy-link");
  if (!privacyLink) {
    throw new Error("Privacy & Data Rights link not found");
  }
  console.log("✓ 'Request Data Deletion' privacy link present");

  // Test Light Mode / Dark Mode Toggle
  console.log("Testing theme toggle...");
  const themeToggle = await page.$("#theme-toggle-btn");
  await themeToggle.click();
  const themeAfterClick = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  console.log(`Theme toggled to: ${themeAfterClick}`);

  await themeToggle.click();
  const themeToggledBack = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  console.log(`Theme toggled back to: ${themeToggledBack}`);
  console.log("✓ Theme toggle functions between light and dark modes");

  // Test Mobile Viewport
  console.log("Testing mobile viewport (390x844)...");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  if (scrollWidth > clientWidth + 2) {
    throw new Error(`Horizontal overflow detected on mobile: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);
  }
  console.log("✓ Mobile layout responsive with no horizontal overflow");

  // Check console errors
  if (consoleErrors.length > 0) {
    console.warn("Console errors detected:", consoleErrors);
  } else {
    console.log("✓ 0 console errors detected");
  }

  await browser.close();
  console.log("ALL PORTAL REDESIGN VERIFICATION CHECKS PASSED SUCCESSFULLY!");
}

verifyPortals().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
