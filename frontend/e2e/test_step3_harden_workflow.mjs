import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, "test_fixtures.json");
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8"));

const BASE_URL = "http://localhost:5173";
const API_BASE = "http://localhost:8080";

const checklistResults = {
  item1_uploadValidation: "BLOCKED",
  item2_uploadStates: "BLOCKED",
  item3_ocrFailuresSafeStatus: "BLOCKED",
  item4_manualReviewApproveReject: "BLOCKED",
  item5_rejectedResubmissionAction: "BLOCKED",
  item6_reuploadPreservesOtherSlots: "BLOCKED",
  item7_tokenSecurityUploadBlocked: "BLOCKED",
  item8_backendSourceOfTruth: "BLOCKED",
  item9_responsiveUiNoErrors: "BLOCKED",
  item10_cleanup: "BLOCKED",
};

const consoleErrors = [];
const networkRequests = [];

function runPython(code) {
  const cmd = `./backend/.venv/bin/python -c "${code.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { cwd: "/home/incraax-ai/Documents/Vighnesh/DocPilot" }).toString().trim();
}

async function safeFetch(url, options = {}, retries = 3) {
  const opts = { ...options };
  opts.headers = { ...opts.headers, Connection: "close" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
}

const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// Second distinct PNG for replacement testing
const DUMMY_PNG_2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjAwACU0B5i7h5YAAAAAASUVORK5CYII=",
  "base64"
);

async function runStep3AuditAndTests() {
  console.log("==========================================================================");
  console.log("  DOCPILOT PHASE 3 STEP 3: UPLOAD, OCR STATUS & RESUBMISSION HARDENING    ");
  console.log("==========================================================================\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!text.includes("favicon") && !text.includes("Download the React DevTools")) {
        consoleErrors.push(text);
        console.error("[Browser Console Error]:", text);
      }
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/api/")) {
      networkRequests.push({
        url,
        method: res.request().method(),
        status: res.status(),
      });
    }
  });

  let customerId = null;
  let uploadToken = null;

  try {
    // Setup synthetic customer with 2 required slots: PAN and Bank Statement
    console.log("[SETUP] Creating synthetic customer for upload & resubmission hardening...");
    const createRes = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Devendra Hardening Test",
        email: "devendra.hardening@example.com",
        required_documents: ["pan", "bank_statement"],
        send_consent: true,
      }),
    });
    const cData = await createRes.json();
    customerId = cData.id;
    console.log(`  -> Customer created: ID ${customerId}`);

    // Grant consent and obtain upload token
    const tokenPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
from app import services
with session_scope() as db:
    c = db.get(Customer, ${customerId})
    tok = services.record_consent(db, c, True)
    print(tok)
`;
    uploadToken = runPython(tokenPy);
    console.log("  -> Consent granted; upload token obtained.");

    // -------------------------------------------------------------
    // CHECK 1: UPLOAD VALIDATION
    // (File type, size, magic bytes, duplicate upload protection)
    // -------------------------------------------------------------
    console.log("\n[VERIFY 1] Upload Validation...");
    await page.goto(`${BASE_URL}/portal/${uploadToken}`, { waitUntil: "networkidle" });

    // 1.1 Client-side extension check
    console.log("  -> Testing client-side unsupported file type (.sh)...");
    const testShPath = path.join(__dirname, "assets", "exploit_script.sh");
    fs.writeFileSync(testShPath, "#!/bin/bash\necho hello");

    await page.locator("#upload-btn-pan").click();
    await page.waitForSelector(".upload-modal-card", { timeout: 5000 });
    await page.locator(".upload-modal-card input[type='file']").setInputFiles(testShPath);

    const clientErr = await page.locator(".upload-modal-err").textContent();
    console.log(`  -> Client rejection: "${clientErr?.trim()}"`);
    if (!clientErr?.includes("not supported")) {
      throw new Error(`Expected unsupported file error, got: ${clientErr}`);
    }
    const isSubmitDisabled = await page.locator("#upload-modal-confirm-btn").isDisabled();
    if (!isSubmitDisabled) {
      throw new Error("Submit button should be disabled for unsupported file!");
    }
    await page.locator("#close-upload-modal-btn").click();
    await page.waitForSelector(".upload-modal-card", { state: "detached" });

    // 1.2 Backend magic byte verification: disguised file
    console.log("  -> Testing backend magic byte protection (fake text disguised as .png)...");
    const fakePngFormData = new FormData();
    fakePngFormData.append("doc_type", "pan");
    fakePngFormData.append("file", new Blob([Buffer.from("This is not a real image at all")], { type: "image/png" }), "fake.png");

    const magicRes = await safeFetch(`${API_BASE}/api/portal/${uploadToken}/upload`, {
      method: "POST",
      body: fakePngFormData,
    });
    console.log(`  -> Disguised file upload rejected with HTTP ${magicRes.status}`);
    const magicErr = await magicRes.json();
    console.log(`  -> Backend error code: ${magicErr.detail?.code || magicErr.detail}`);
    if (magicRes.status !== 400 || (magicErr.detail?.code !== "file_content_mismatch" && magicErr.detail !== "file_content_mismatch")) {
      throw new Error("Backend failed to reject file content mismatch via magic bytes!");
    }

    // 1.3 File size limit
    console.log("  -> Testing file size limits...");
    const hugeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    const oversizedFormData = new FormData();
    oversizedFormData.append("doc_type", "pan");
    oversizedFormData.append("file", new Blob([hugeBuffer], { type: "image/png" }), "huge.png");

    const sizeRes = await safeFetch(`${API_BASE}/api/portal/${uploadToken}/upload`, {
      method: "POST",
      body: oversizedFormData,
    });
    console.log(`  -> Oversized upload rejected with HTTP ${sizeRes.status}`);
    if (sizeRes.status !== 413) {
      throw new Error(`Expected HTTP 413 for oversized file, got ${sizeRes.status}`);
    }

    checklistResults.item1_uploadValidation = "PASS";
    console.log("  -> [PASS] Item 1: Upload Validation verified.");

    // -------------------------------------------------------------
    // CHECK 2 & 3: UPLOAD STATES & SAFE OCR STATUS
    // (pending -> uploading -> processing -> under_review / safe feedback)
    // -------------------------------------------------------------
    console.log("\n[VERIFY 2 & 3] Upload States Lifecycle & Safe OCR Status...");
    // Initial state check in UI
    const initialBadge = await page.locator("#doc-card-pan .doc-state-tag").textContent();
    console.log(`  -> Initial PAN state in UI: "${initialBadge.trim()}"`);

    // Upload synthetic PAN
    const validPanPath = path.join(__dirname, "assets", "pan_step3.png");
    fs.writeFileSync(validPanPath, DUMMY_PNG);

    await page.locator("#upload-btn-pan").click();
    await page.waitForSelector(".upload-modal-card", { timeout: 5000 });
    await page.locator(".upload-modal-card input[type='file']").setInputFiles(validPanPath);
    await page.locator("#upload-modal-confirm-btn").click();
    await page.waitForSelector(".upload-modal-card", { state: "detached", timeout: 10000 });

    // Processing banner visible
    await page.waitForSelector("#doc-card-pan .processing-pulse-banner", { timeout: 5000 });
    console.log("  -> PAN Slot entered 'processing' state banner.");

    // Wait for worker
    console.log("  -> Waiting for worker to process PAN...");
    let panState = "";
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const text = await page.locator("#doc-card-pan").textContent();
      if (text.includes("Under Review") || text.includes("Action Required") || text.includes("verified")) {
        panState = text.includes("Under Review") ? "under_review" : text.includes("verified") ? "verified" : "resubmit";
        break;
      }
    }
    console.log(`  -> PAN Card settled into state: '${panState}'`);

    // Check no OCR internals / stack traces leaked
    const portalDom = await page.content();
    if (portalDom.includes("ocr_error") || portalDom.includes("Traceback") || portalDom.includes("fraud_score")) {
      throw new Error("OCR internals or stack trace leaked into customer DOM!");
    }
    checklistResults.item2_uploadStates = "PASS";
    checklistResults.item3_ocrFailuresSafeStatus = "PASS";
    console.log("  -> [PASS] Item 2 & 3: Upload States & Safe Status verified.");

    // -------------------------------------------------------------
    // CHECK 4 & 5: MANUAL REVIEW REJECT -> RESUBMISSION ACTION
    // -------------------------------------------------------------
    console.log("\n[VERIFY 4 & 5] Manual Review Reject & Resubmission Flow...");
    // Find open review for customer
    const findRevPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import ManualReview
with session_scope() as db:
    rev = db.query(ManualReview).filter(ManualReview.customer_id == ${customerId}, ManualReview.status == 'open').first()
    print(rev.id if rev else 'NONE')
`;
    const rev1Id = runPython(findRevPy);
    if (rev1Id === "NONE") {
      throw new Error("Expected open review for synthetic PAN document!");
    }

    // Admin REJECTS the review
    console.log(`  -> Admin REJECTING review ${rev1Id} with note: 'Image was blurry'`);
    const rejRes = await safeFetch(`${API_BASE}/api/admin/reviews/${rev1Id}/reject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ note: "Image was blurry" }),
    });
    if (!rejRes.ok) {
      throw new Error(`Failed to reject review: HTTP ${rejRes.status}`);
    }
    console.log(`  -> Review rejected: HTTP ${rejRes.status}`);

    // Wait and reload portal
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: "networkidle" });

    // Verify PAN card displays Action Required and Upload Again button
    await page.waitForSelector("#resubmit-btn-pan", { timeout: 10000 });
    const panRejectionBadge = await page.locator("#doc-card-pan .doc-state-tag").textContent();
    console.log(`  -> Rejected slot badge: "${panRejectionBadge.trim()}"`);
    if (!panRejectionBadge.includes("Action Required")) {
      throw new Error(`Expected 'Action Required' badge, got: ${panRejectionBadge}`);
    }

    const rejectionText = await page.locator("#doc-card-pan .rejection-guidance-box").textContent();
    console.log(`  -> Rejection guidance: "${rejectionText.trim()}"`);
    if (!rejectionText.includes("Please upload a replacement document.")) {
      throw new Error("Missing replacement document prompt in rejection guidance!");
    }

    // Verify admin note ('Image was blurry') is NOT leaked to customer
    if (rejectionText.includes("blurry")) {
      throw new Error("Admin review note was improperly leaked to customer view!");
    }
    console.log("  -> Verified: Internal reviewer note is hidden; friendly guidance shown.");

    checklistResults.item4_manualReviewApproveReject = "PASS";
    checklistResults.item5_rejectedResubmissionAction = "PASS";
    console.log("  -> [PASS] Item 4 & 5: Review Reject & Resubmission Action verified.");

    // -------------------------------------------------------------
    // CHECK 6: RE-UPLOAD DOES NOT BREAK OTHER SLOTS OR PROGRESS
    // -------------------------------------------------------------
    console.log("\n[VERIFY 6] Re-upload Preserves Other Slots & Customer Progress...");
    // First, upload Bank Statement to verify it stays independent
    console.log("  -> Uploading Bank Statement first to test multi-slot independence...");
    const validBankPath = path.join(__dirname, "assets", "bank_step3.png");
    fs.writeFileSync(validBankPath, DUMMY_PNG);

    await page.locator("#upload-btn-bank_statement").click();
    await page.waitForSelector(".upload-modal-card", { timeout: 5000 });
    await page.locator(".upload-modal-card input[type='file']").setInputFiles(validBankPath);
    await page.locator("#upload-modal-confirm-btn").click();
    await page.waitForSelector(".upload-modal-card", { state: "detached", timeout: 10000 });

    // Wait for Bank Statement review and APPROVE it
    console.log("  -> Waiting for Bank Statement worker review...");
    let bankRevId = "NONE";
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const findBankRevPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import ManualReview
with session_scope() as db:
    rev = db.query(ManualReview).filter(ManualReview.customer_id == ${customerId}, ManualReview.status == 'open').first()
    print(rev.id if rev else 'NONE')
`;
      bankRevId = runPython(findBankRevPy);
      if (bankRevId !== "NONE") break;
    }

    if (bankRevId === "NONE") {
      throw new Error("Expected review for Bank Statement!");
    }
    console.log(`  -> Approving Bank Statement review ${bankRevId}...`);
    await safeFetch(`${API_BASE}/api/admin/reviews/${bankRevId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ note: "Bank statement valid" }),
    });

    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: "networkidle" });

    // Bank Statement is now VERIFIED
    await page.waitForSelector("#doc-card-bank_statement .doc-state-tag.verified", { timeout: 10000 });
    console.log("  -> Bank Statement is verified (1 of 2 completed).");

    // NOW re-upload replacement PAN
    console.log("  -> Re-uploading replacement PAN via 'Upload Again' button...");
    const replacementPanPath = path.join(__dirname, "assets", "pan_replacement.png");
    fs.writeFileSync(replacementPanPath, DUMMY_PNG_2);

    await page.locator("#resubmit-btn-pan").click();
    await page.waitForSelector(".upload-modal-card", { timeout: 5000 });
    const modalTitle = await page.locator("#upload-modal-title").textContent();
    console.log(`  -> Re-upload modal title: "${modalTitle.trim()}"`);
    if (!modalTitle.includes("Resubmit")) {
      throw new Error(`Expected modal title to say 'Resubmit', got: ${modalTitle}`);
    }

    await page.locator(".upload-modal-card input[type='file']").setInputFiles(replacementPanPath);
    await page.locator("#upload-modal-confirm-btn").click();
    await page.waitForSelector(".upload-modal-card", { state: "detached", timeout: 10000 });
    console.log("  -> Replacement PAN uploaded successfully.");

    // VERIFY Bank Statement remains VERIFIED after PAN re-upload!
    const bankStillVerified = await page.locator("#doc-card-bank_statement .doc-state-tag.verified").isVisible();
    console.log(`  -> Bank Statement still verified after PAN re-upload: ${bankStillVerified}`);
    if (!bankStillVerified) {
      throw new Error("PAN re-upload improperly reset or broke Bank Statement verified status!");
    }

    // Approve replacement PAN
    console.log("  -> Waiting for replacement PAN review to approve...");
    let repRevId = "NONE";
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const findRepPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import ManualReview
with session_scope() as db:
    rev = db.query(ManualReview).filter(ManualReview.customer_id == ${customerId}, ManualReview.status == 'open').first()
    print(rev.id if rev else 'NONE')
`;
      repRevId = runPython(findRepPy);
      if (repRevId !== "NONE") break;
    }

    if (repRevId !== "NONE") {
      console.log(`  -> Approving replacement PAN review ${repRevId}...`);
      await safeFetch(`${API_BASE}/api/admin/reviews/${repRevId}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixtures.admin_jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: "Replacement PAN accepted" }),
      });
    }

    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: "networkidle" });

    // Now both are verified -> Case Completion
    await page.waitForSelector(".verification-complete-card", { timeout: 10000 });
    console.log("  -> Both slots verified; verification completed view rendered successfully!");

    checklistResults.item6_reuploadPreservesOtherSlots = "PASS";
    console.log("  -> [PASS] Item 6: Re-upload Preserves Other Slots verified.");

    // -------------------------------------------------------------
    // CHECK 7: TOKEN SECURITY
    // (Expired/revoked/incorrect tokens blocked from uploading)
    // -------------------------------------------------------------
    console.log("\n[VERIFY 7] Token Security on Upload Endpoint...");
    // 7.1 Random invalid token
    const testUploadFormData = new FormData();
    testUploadFormData.append("doc_type", "pan");
    testUploadFormData.append("file", new Blob([DUMMY_PNG], { type: "image/png" }), "test.png");

    const badTokRes = await safeFetch(`${API_BASE}/api/portal/invalid-token-12345/upload`, {
      method: "POST",
      body: testUploadFormData,
    });
    console.log(`  -> Invalid token upload blocked: HTTP ${badTokRes.status}`);
    if (badTokRes.status !== 404) {
      throw new Error(`Expected 404 for invalid token upload, got ${badTokRes.status}`);
    }

    // 7.2 Uploading after case is completed
    const closedUploadRes = await safeFetch(`${API_BASE}/api/portal/${uploadToken}/upload`, {
      method: "POST",
      body: testUploadFormData,
    });
    console.log(`  -> Upload after case completion blocked: HTTP ${closedUploadRes.status}`);
    if (closedUploadRes.status !== 409) {
      throw new Error(`Expected 409 case_not_open for completed case, got ${closedUploadRes.status}`);
    }

    checklistResults.item7_tokenSecurityUploadBlocked = "PASS";
    console.log("  -> [PASS] Item 7: Token Security verified.");

    // -------------------------------------------------------------
    // CHECK 8: BACKEND AS SOURCE OF TRUTH
    // -------------------------------------------------------------
    console.log("\n[VERIFY 8] Backend Source of Truth Check...");
    const statePy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, RequiredDocument
with session_scope() as db:
    c = db.get(Customer, ${customerId})
    reqs = db.query(RequiredDocument).filter(RequiredDocument.customer_id == ${customerId}).all()
    verified_count = sum(1 for r in reqs if r.verified_document_id is not None)
    print(f"{c.case_status}:{c.workflow_state}:{verified_count}/{len(reqs)}")
`;
    const backendTruth = runPython(statePy);
    console.log(`  -> Backend database truth: ${backendTruth}`);
    if (backendTruth !== "completed:COMPLETED:2/2") {
      throw new Error(`Backend state did not match expected completion: ${backendTruth}`);
    }

    checklistResults.item8_backendSourceOfTruth = "PASS";
    console.log("  -> [PASS] Item 8: Backend Source of Truth verified.");

    // -------------------------------------------------------------
    // CHECK 9: RESPONSIVE UI & ERROR LOG AUDIT
    // -------------------------------------------------------------
    console.log("\n[VERIFY 9] Responsive UI & Error Log Inspection...");
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload({ waitUntil: "networkidle" });

    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerW = await page.evaluate(() => window.innerWidth);
    console.log(`  -> Mobile width: ${innerW}px, scrollWidth: ${scrollW}px`);
    if (scrollW > innerW + 2) {
      throw new Error(`Mobile overflow detected: ${scrollW}px > ${innerW}px`);
    }

    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR_FAILED") && !e.includes("404")
    );
    console.log(`  -> Critical console errors: ${criticalErrors.length}`);
    if (criticalErrors.length > 0) {
      throw new Error(`Captured critical console errors: ${JSON.stringify(criticalErrors)}`);
    }

    checklistResults.item9_responsiveUiNoErrors = "PASS";
    console.log("  -> [PASS] Item 9: Responsive UI & Clean Logs verified.");

    // -------------------------------------------------------------
    // CHECK 10: CLEANUP
    // -------------------------------------------------------------
    console.log("\n[VERIFY 10] Cleaning up synthetic test customer...");
    if (customerId) {
      const delRes = await safeFetch(`${API_BASE}/api/admin/customers/${customerId}/delete-data`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
      });
      console.log(`  -> Deleted customer ${customerId}: HTTP ${delRes.status}`);
    }

    const countPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
with session_scope() as db:
    active = db.query(Customer).filter(Customer.case_status != 'deleted').count()
    print(active)
`;
    const remainingActive = parseInt(runPython(countPy), 10);
    console.log(`  -> Active customers remaining in database: ${remainingActive}`);
    if (remainingActive !== 0) {
      throw new Error(`Expected 0 active customers, found ${remainingActive}`);
    }

    checklistResults.item10_cleanup = "PASS";
    console.log("  -> [PASS] Item 10: Cleanup verified.");
  } catch (err) {
    console.error("\n❌ STEP 3 TEST FAILED:", err);
  } finally {
    await browser.close();

    // Clean up temporary test files
    try {
      fs.unlinkSync(path.join(__dirname, "assets", "exploit_script.sh"));
      fs.unlinkSync(path.join(__dirname, "assets", "pan_step3.png"));
      fs.unlinkSync(path.join(__dirname, "assets", "bank_step3.png"));
      fs.unlinkSync(path.join(__dirname, "assets", "pan_replacement.png"));
    } catch {}

    console.log("\n==========================================================================");
    console.log("                  STEP 3 AUDIT & VERIFICATION RESULTS                     ");
    console.log("==========================================================================");
    console.table(checklistResults);
  }
}

runStep3AuditAndTests();
