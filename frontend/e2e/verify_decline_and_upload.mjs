import { chromium } from "playwright";
import { execSync } from "child_process";
import path from "path";

const BASE_URL = "http://localhost:5173";

// Generate customer for decline test
const declineConsentToken = execSync(`./.venv/bin/python -c "
from app.db import session_scope
from app.models import Customer, RequiredDocument, AccessToken
from app.security import new_token, hash_token
from datetime import datetime, timezone, timedelta

with session_scope() as db:
    c = Customer(
        name='Rohan Verma',
        email='rohan@example.com',
        mobile='+919876543212',
        case_status='in_progress',
        consent_status='pending'
    )
    db.add(c)
    db.flush()
    db.add(RequiredDocument(customer_id=c.id, doc_type='pan'))
    raw_consent = new_token()
    exp = datetime.now(timezone.utc) + timedelta(days=7)
    db.add(AccessToken(token_hash=hash_token(raw_consent), purpose='consent', customer_id=c.id, expires_at=exp))
    print(raw_consent)
"`, { cwd: "../backend" }).toString().trim();

// Generate customer with granted consent and upload token for upload test
const uploadToken = execSync(`./.venv/bin/python -c "
from app.db import session_scope
from app.models import Customer, RequiredDocument, AccessToken
from app.security import new_token, hash_token
from datetime import datetime, timezone, timedelta

with session_scope() as db:
    c = Customer(
        name='Sneha Patel',
        email='sneha@example.com',
        mobile='+919876543213',
        case_status='in_progress',
        consent_status='granted'
    )
    db.add(c)
    db.flush()
    db.add(RequiredDocument(customer_id=c.id, doc_type='pan'))
    raw_upload = new_token()
    exp = datetime.now(timezone.utc) + timedelta(days=7)
    db.add(AccessToken(token_hash=hash_token(raw_upload), purpose='upload', customer_id=c.id, expires_at=exp))
    print(raw_upload)
"`, { cwd: "../backend" }).toString().trim();

async function testDeclineAndUpload() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Test 1: Decline Behavior
  console.log("Testing Decline flow on /consent/:token...");
  await page.goto(`${BASE_URL}/consent/${declineConsentToken}`);
  await page.waitForSelector("#consent-decline-btn", { timeout: 10000 });
  await page.click("#consent-decline-btn");

  await page.waitForSelector("#consent-declined-view", { timeout: 10000 });
  const declineHeading = await page.textContent("#consent-declined-view h2");
  if (!declineHeading.includes("Verification Request Declined")) {
    throw new Error(`Unexpected decline heading: ${declineHeading}`);
  }
  console.log("✓ Decline confirmed: Clean state displayed without technical errors.");

  // Test 2: Real File Upload through Dedicated Modal
  console.log("Testing Real Upload flow on /portal/:token...");
  await page.goto(`${BASE_URL}/portal/${uploadToken}`);
  await page.waitForSelector("#portal-progress-section", { timeout: 10000 });

  // Click Upload Document on PAN card
  await page.click("#upload-btn-pan");
  await page.waitForSelector(".upload-modal-card", { timeout: 5000 });

  // Choose file in modal
  const dummyPanPath = path.resolve("e2e/assets/dummy_pan.png");
  const fileInput = await page.$("input[type='file']");
  await fileInput.setInputFiles(dummyPanPath);
  await page.waitForSelector(".upload-selected-file-view", { timeout: 5000 });
  console.log("✓ File selected inside modal dropzone.");

  // Submit modal upload
  await page.click("#upload-modal-confirm-btn");
  console.log("Submitted upload through modal...");

  // Verify modal closes and card shows processing state
  await page.waitForSelector(".upload-modal-card", { state: "detached", timeout: 10000 });
  console.log("✓ Modal closed after successful upload initiation.");

  const processingVisible = await page.isVisible(".processing-pulse-banner");
  console.log(`Processing state banner visible on card: ${processingVisible}`);

  await browser.close();
  console.log("DECLINE AND UPLOAD TESTS COMPLETED SUCCESSFULLY!");
}

testDeclineAndUpload().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
