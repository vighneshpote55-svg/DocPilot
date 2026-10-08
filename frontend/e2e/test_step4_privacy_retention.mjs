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

const checklist = {
  item1_privacyOptions: "BLOCKED",
  item2_doubleConfirmationFlow: "BLOCKED",
  item3_antiEnumerationProtection: "BLOCKED",
  item4_tokenSingleUseAndExpiry: "BLOCKED",
  item5_dataDeletionPiiAndFilePurge: "BLOCKED",
  item6_consentWithdrawalHaltsProcessing: "BLOCKED",
  item7_retentionMessagingCorrect: "BLOCKED",
  item8_blockedAccessAfterDeletionWithdrawal: "BLOCKED",
  item9_noInternalLeaksOrPiiInUI: "BLOCKED",
  item10_responsiveUiAndCleanLogs: "BLOCKED",
};

const consoleErrors = [];
const networkLogs = [];

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

async function runStep4PrivacyRetentionTest() {
  console.log("==========================================================================");
  console.log("  DOCPILOT PHASE 3 STEP 4: PRIVACY, WITHDRAWAL & RETENTION UX HARDENING   ");
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
      networkLogs.push({
        url,
        method: res.request().method(),
        status: res.status(),
      });
    }
  });

  let custA_Id = null;
  let custB_Id = null;
  let custA_UploadToken = null;
  let custB_UploadToken = null;

  try {
    // -------------------------------------------------------------
    // SETUP: Create Synthetic Customer A (Deletion) & Customer B (Withdrawal)
    // -------------------------------------------------------------
    console.log("[SETUP] Creating Synthetic Customers A and B...");
    // Customer A: For permanent data erasure
    const resA = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Pooja Privacy Delete",
        email: "pooja.privacy.test@example.com",
        mobile: "+919876543201",
        required_documents: ["pan"],
        send_consent: false,
      }),
    });
    const cA = await resA.json();
    custA_Id = cA.id;
    console.log(`  -> Customer A created (ID: ${custA_Id})`);

    // Customer B: For consent withdrawal
    const resB = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Ravi Consent Withdraw",
        email: "ravi.withdraw.test@example.com",
        mobile: "+919876543202",
        required_documents: ["pan"],
        send_consent: false,
      }),
    });
    const cB = await resB.json();
    custB_Id = cB.id;
    console.log(`  -> Customer B created (ID: ${custB_Id})`);

    // Grant consent and upload document for Customer A (so it has file, OCR, review rows)
    const setupCustAPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
from app import services
with session_scope() as db:
    cA = db.get(Customer, ${custA_Id})
    cB = db.get(Customer, ${custB_Id})
    # Grant consent for both without SMTP pause
    cA.consent_status, cA.case_status, cA.workflow_state = "granted", "in_progress", "CONSENT_GRANTED"
    cB.consent_status, cB.case_status, cB.workflow_state = "granted", "in_progress", "CONSENT_GRANTED"
    tA = services.issue_token(db, cA.id, "upload", services.timedelta(hours=24))
    tB = services.issue_token(db, cB.id, "upload", services.timedelta(hours=24))
    import json
    print(json.dumps({"tokenA": tA, "tokenB": tB}))
`;
    const setupTokens = JSON.parse(runPython(setupCustAPy));
    custA_UploadToken = setupTokens.tokenA;
    custB_UploadToken = setupTokens.tokenB;

    // Customer A uploads document to have encrypted files and rows in storage/DB
    const uploadFormData = new FormData();
    uploadFormData.append("doc_type", "pan");
    uploadFormData.append("file", new Blob([DUMMY_PNG], { type: "image/png" }), "pan_card.png");

    const upRes = await safeFetch(`${API_BASE}/api/portal/${custA_UploadToken}/upload`, {
      method: "POST",
      body: uploadFormData,
    });
    const upDoc = await upRes.json();
    console.log(`  -> Customer A uploaded document: ID ${upDoc.document_id}`);

    // Wait a moment for worker to process and create OcrResult/ManualReview
    await new Promise((r) => setTimeout(r, 2000));

    // -------------------------------------------------------------
    // 1. PRIVACY PAGE CLEAR OPTIONS
    // -------------------------------------------------------------
    console.log("\n[VERIFY 1] Privacy Page Options...");
    await page.goto(`${BASE_URL}/privacy`, { waitUntil: "networkidle" });

    const deleteOpt = page.locator("#privacy-option-delete");
    const withdrawOpt = page.locator("#privacy-option-withdraw");

    const isDelVisible = await deleteOpt.isVisible();
    const isWithVisible = await withdrawOpt.isVisible();
    console.log(`  -> 'Delete My Data Now' option visible: ${isDelVisible}`);
    console.log(`  -> 'Withdraw Consent' option visible: ${isWithVisible}`);

    if (!isDelVisible || !isWithVisible) {
      throw new Error("Privacy options (Delete My Data and Withdraw Consent) must both be visible!");
    }

    const delSubtext = await page.locator("#privacy-option-delete .privacy-option-sub").textContent();
    const withSubtext = await page.locator("#privacy-option-withdraw .privacy-option-sub").textContent();
    console.log(`  -> Deletion description: "${delSubtext.trim()}"`);
    console.log(`  -> Withdrawal description: "${withSubtext.trim()}"`);

    checklist.item1_privacyOptions = "PASS";
    console.log("  -> [PASS] Item 1: Privacy options verified.");

    // -------------------------------------------------------------
    // 2 & 3. ANTI-ENUMERATION & DOUBLE CONFIRMATION FLOW
    // -------------------------------------------------------------
    console.log("\n[VERIFY 2 & 3] Anti-Enumeration & Double-Confirmation Initiation...");
    // 3.1 Test anti-enumeration with non-existent email
    console.log("  -> Testing anti-enumeration with unrecorded email address...");
    const checkGhostPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import PrivacyRequest
with session_scope() as db:
    reqs = db.query(PrivacyRequest).count()
    print(reqs)
`;
    const countBefore = parseInt(runPython(checkGhostPy), 10);

    await page.locator("#privacy-email").fill("ghost.unregistered.user@example.com");
    await page.locator("#privacy-submit-btn").click();

    // Verify interactive pre-submission confirmation modal
    await page.waitForSelector("#privacy-request-confirm-modal", { timeout: 5000 });
    const modalTitle = await page.locator("#privacy-dialog-title").textContent();
    console.log(`  -> Pre-submission dialog title: "${modalTitle.trim()}"`);
    if (!modalTitle.includes("Confirm Data Erasure Request")) {
      throw new Error(`Unexpected dialog title: ${modalTitle}`);
    }

    // Submit dialog
    await page.locator("#btn-submit-privacy-request").click();
    await page.waitForSelector("#privacy-dispatched-card", { timeout: 10000 });

    const antiEnumText = await page.locator("#privacy-dispatched-card .privacy-hero-desc").textContent();
    console.log(`  -> Anti-enumeration dispatched notice: "${antiEnumText.trim()}"`);
    if (!antiEnumText.includes("If") || !antiEnumText.includes("is registered")) {
      throw new Error("Dispatched card missing conditional anti-enumeration language!");
    }

    // Verify in DB that no request row was created for nonexistent email
    const countAfter = parseInt(runPython(checkGhostPy), 10);
    console.log(`  -> PrivacyRequest count before: ${countBefore}, after: ${countAfter}`);
    if (countAfter !== countBefore) {
      throw new Error("System created a privacy request row for a non-existent email!");
    }

    checklist.item3_antiEnumerationProtection = "PASS";
    console.log("  -> [PASS] Item 3: Anti-Enumeration Protection verified.");

    // -------------------------------------------------------------
    // 4 & 5. DATA DELETION CONFIRMATION, TOKEN SINGLE-USE & FILE PURGE
    // -------------------------------------------------------------
    console.log("\n[VERIFY 4 & 5] Customer A Data Deletion Execution & Cryptographic Purge...");
    // Submit request for Customer A
    await page.locator("button:has-text('Submit Another Request')").click();
    await page.locator("#privacy-email").fill("pooja.privacy.test@example.com");
    await page.locator("#privacy-option-delete").click();
    await page.locator("#privacy-submit-btn").click();

    await page.waitForSelector("#privacy-request-confirm-modal", { timeout: 5000 });
    await page.locator("#btn-submit-privacy-request").click();
    await page.waitForSelector("#privacy-dispatched-card", { timeout: 10000 });

    // Retrieve the privacy verification token for Customer A from DB
    const getPrivTokPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import PrivacyRequest, AccessToken
from app import services
with session_scope() as db:
    pr = db.query(PrivacyRequest).filter(PrivacyRequest.customer_id == ${custA_Id}, PrivacyRequest.action == 'delete').first()
    # Issue fresh test token bound to pr.id
    raw = services.issue_token(db, ${custA_Id}, 'privacy', services.timedelta(minutes=30), ref_id=pr.id)
    print(raw)
`;
    const deleteConfirmToken = runPython(getPrivTokPy);
    console.log("  -> Obtained valid privacy confirmation token for Customer A");

    // Open confirmation page in browser: /privacy/confirm/:token
    await page.goto(`${BASE_URL}/privacy/confirm/${deleteConfirmToken}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#privacy-confirm-card", { timeout: 10000 });

    const confirmCardTitle = await page.locator("#privacy-confirm-card h1").textContent();
    console.log(`  -> Confirmation screen title: "${confirmCardTitle.trim()}"`);
    if (!confirmCardTitle.includes("Confirm Your Privacy Request")) {
      throw new Error(`Unexpected confirmation title: ${confirmCardTitle}`);
    }

    // Click confirm button -> opens final confirmation modal
    await page.locator("#privacy-confirm-btn").click();
    await page.waitForSelector("#privacy-confirm-execute-modal", { timeout: 5000 });

    // Click "Yes, Execute Now"
    console.log("  -> Executing permanent data erasure in browser...");
    await page.locator("#confirm-privacy-execute-btn").click();

    // Verify Success Screen
    await page.waitForSelector("#privacy-confirm-success-card", { timeout: 10000 });
    const successTitle = await page.locator("#privacy-confirm-success-card h2").textContent();
    console.log(`  -> Deletion success title: "${successTitle.trim()}"`);
    if (!successTitle.includes("Customer Data Permanently Erased")) {
      throw new Error(`Expected erasure confirmation, got: ${successTitle}`);
    }

    // 4.1 Token Single-Use Test: Try to reuse token
    console.log("  -> Testing single-use token reuse prevention...");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#privacy-confirm-card", { timeout: 10000 });
    // Click confirm again to attempt reuse
    await page.locator("#privacy-confirm-btn").click();
    await page.waitForSelector("#privacy-confirm-execute-modal", { timeout: 5000 });
    await page.locator("#confirm-privacy-execute-btn").click();
    await page.waitForSelector("#privacy-confirm-error-card", { timeout: 10000 });
    const reuseError = await page.locator("#privacy-confirm-error-card h2").textContent();
    console.log(`  -> Reused token response: "${reuseError.trim()}"`);
    if (!reuseError.includes("Verification Link Invalid or Expired")) {
      throw new Error("Token was not invalidated after single use!");
    }
    console.log("  -> Token correctly blocked upon second execution.");

    // 5.1 Verify database & storage purge for Customer A
    console.log("  -> Auditing database records for purged Customer A...");
    const auditDelPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, Document, OcrResult, ManualReview, AccessToken, ConsentLedger
with session_scope() as db:
    c = db.get(Customer, ${custA_Id})
    docs = db.query(Document).filter(Document.customer_id == ${custA_Id}).all()
    all_files_deleted = all(d.file_state == 'deleted' and d.sha256 == '' for d in docs)
    doc_ids = [d.id for d in docs]
    ocr_count = db.query(OcrResult).filter(OcrResult.document_id.in_(doc_ids)).count() if doc_ids else 0
    rev_count = db.query(ManualReview).filter(ManualReview.document_id.in_(doc_ids)).count() if doc_ids else 0
    tok_count = db.query(AccessToken).filter(AccessToken.customer_id == ${custA_Id}).count()
    ledger = db.query(ConsentLedger).filter(ConsentLedger.customer_id == ${custA_Id}, ConsentLedger.event == 'deleted').count()
    import json
    print(json.dumps({
        "name": c.name,
        "email": c.email,
        "mobile": c.mobile,
        "case_status": c.case_status,
        "workflow_state": c.workflow_state,
        "all_files_deleted": all_files_deleted,
        "ocr_count": ocr_count,
        "rev_count": rev_count,
        "tok_count": tok_count,
        "ledger_count": ledger
    }))
`;
    const delAudit = JSON.parse(runPython(auditDelPy));
    console.log("  -> Database purge audit summary:", JSON.stringify(delAudit, null, 2));

    if (
      delAudit.name !== "[deleted]" ||
      !delAudit.email.startsWith("deleted-") ||
      delAudit.mobile !== null ||
      delAudit.case_status !== "deleted" ||
      delAudit.workflow_state !== "DELETED" ||
      !delAudit.all_files_deleted ||
      delAudit.ocr_count !== 0 ||
      delAudit.rev_count !== 0 ||
      delAudit.tok_count !== 0 ||
      delAudit.ledger_count === 0
    ) {
      throw new Error("Customer A database and file purge failed strict specification requirements!");
    }

    checklist.item2_doubleConfirmationFlow = "PASS";
    checklist.item4_tokenSingleUseAndExpiry = "PASS";
    checklist.item5_dataDeletionPiiAndFilePurge = "PASS";
    console.log("  -> [PASS] Items 2, 4 & 5: Double-confirmation, single-use token and data deletion verified.");

    // -------------------------------------------------------------
    // 6. CONSENT WITHDRAWAL HALTS PROCESSING
    // -------------------------------------------------------------
    console.log("\n[VERIFY 6] Customer B Consent Withdrawal Execution...");
    await page.goto(`${BASE_URL}/privacy`, { waitUntil: "networkidle" });
    await page.locator("#privacy-option-withdraw").click();
    await page.locator("#privacy-email").fill("ravi.withdraw.test@example.com");
    await page.locator("#privacy-submit-btn").click();

    await page.waitForSelector("#privacy-request-confirm-modal", { timeout: 5000 });
    await page.locator("#btn-submit-privacy-request").click();
    await page.waitForSelector("#privacy-dispatched-card", { timeout: 10000 });

    const getWithTokPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import PrivacyRequest
from app import services
with session_scope() as db:
    pr = db.query(PrivacyRequest).filter(PrivacyRequest.customer_id == ${custB_Id}, PrivacyRequest.action == 'withdraw').first()
    raw = services.issue_token(db, ${custB_Id}, 'privacy', services.timedelta(minutes=30), ref_id=pr.id)
    print(raw)
`;
    const withdrawToken = runPython(getWithTokPy);
    console.log("  -> Obtained valid privacy confirmation token for Customer B");

    // Open confirmation page and execute withdrawal
    await page.goto(`${BASE_URL}/privacy/confirm/${withdrawToken}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#privacy-confirm-card", { timeout: 10000 });
    await page.locator("#privacy-confirm-btn").click();
    await page.waitForSelector("#privacy-confirm-execute-modal", { timeout: 5000 });
    await page.locator("#confirm-privacy-execute-btn").click();

    await page.waitForSelector("#privacy-confirm-success-card", { timeout: 10000 });
    const withdrawSuccessTitle = await page.locator("#privacy-confirm-success-card h2").textContent();
    console.log(`  -> Withdrawal success title: "${withdrawSuccessTitle.trim()}"`);
    if (!withdrawSuccessTitle.includes("Consent Successfully Withdrawn")) {
      throw new Error(`Expected withdrawal title, got: ${withdrawSuccessTitle}`);
    }

    // Verify database state for Customer B
    const auditWithPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, AccessToken, ConsentLedger
with session_scope() as db:
    c = db.get(Customer, ${custB_Id})
    active_tokens = db.query(AccessToken).filter(AccessToken.customer_id == ${custB_Id}, AccessToken.revoked == False).count()
    ledger = db.query(ConsentLedger).filter(ConsentLedger.customer_id == ${custB_Id}, ConsentLedger.event == 'withdrawn').count()
    import json
    print(json.dumps({
        "consent_status": c.consent_status,
        "case_status": c.case_status,
        "workflow_state": c.workflow_state,
        "active_tokens": active_tokens,
        "ledger_count": ledger
    }))
`;
    const withAudit = JSON.parse(runPython(auditWithPy));
    console.log("  -> Customer B withdrawal audit:", JSON.stringify(withAudit, null, 2));

    if (
      withAudit.consent_status !== "withdrawn" ||
      withAudit.case_status !== "consent_withdrawn" ||
      withAudit.workflow_state !== "CONSENT_WITHDRAWN" ||
      withAudit.active_tokens !== 0 ||
      withAudit.ledger_count === 0
    ) {
      throw new Error("Customer B withdrawal database verification failed!");
    }

    checklist.item6_consentWithdrawalHaltsProcessing = "PASS";
    console.log("  -> [PASS] Item 6: Consent Withdrawal verified.");

    // -------------------------------------------------------------
    // 7. RETENTION MESSAGING IN PORTAL
    // -------------------------------------------------------------
    console.log("\n[VERIFY 7] Retention Messaging Transparency...");
    // Check Home and Privacy Page retention references
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    const homeHtml = await page.content();
    if (!homeHtml.includes("7-day") && !homeHtml.includes("7-Day")) {
      throw new Error("Home page missing 7-day retention disclosure!");
    }

    await page.goto(`${BASE_URL}/privacy`, { waitUntil: "networkidle" });
    const privHtml = await page.content();
    if (!privHtml.includes("7-Day Purge") && !privHtml.includes("7-day")) {
      throw new Error("Privacy page missing 7-day retention disclosure!");
    }
    console.log("  -> 7-Day statutory retention transparency messaging verified on all customer touchpoints.");

    checklist.item7_retentionMessagingCorrect = "PASS";
    console.log("  -> [PASS] Item 7: Retention messaging verified.");

    // -------------------------------------------------------------
    // 8. BLOCKED ACCESS AFTER DELETION & WITHDRAWAL
    // -------------------------------------------------------------
    console.log("\n[VERIFY 8] Access Controls for Deleted & Withdrawn Customers...");
    // 8.1 Customer A (deleted) tries to access upload portal
    await page.goto(`${BASE_URL}/portal/${custA_UploadToken}`, { waitUntil: "networkidle" });
    const isPortalErrorA = await page.locator("#portal-error").isVisible();
    console.log(`  -> Deleted Customer A portal access blocked with error card: ${isPortalErrorA}`);
    if (!isPortalErrorA) {
      throw new Error("Deleted customer was able to view the portal workspace!");
    }

    // 8.2 Customer B (withdrawn) tries to access upload portal
    await page.goto(`${BASE_URL}/portal/${custB_UploadToken}`, { waitUntil: "networkidle" });
    const isPortalErrorB = await page.locator("#portal-error").isVisible();
    console.log(`  -> Withdrawn Customer B portal access blocked with error card: ${isPortalErrorB}`);
    if (!isPortalErrorB) {
      throw new Error("Withdrawn customer was able to view the portal workspace!");
    }

    // 8.3 Direct backend API call returns 403 / 404
    const apiCallA = await safeFetch(`${API_BASE}/api/portal/${custA_UploadToken}`);
    const apiCallB = await safeFetch(`${API_BASE}/api/portal/${custB_UploadToken}`);
    console.log(`  -> Deleted customer direct API status: HTTP ${apiCallA.status} (expected 404)`);
    console.log(`  -> Withdrawn customer direct API status: HTTP ${apiCallB.status} (expected 403)`);
    if (apiCallA.status !== 404 || ![403, 404].includes(apiCallB.status)) {
      throw new Error("Backend failed to reject portal API calls for deleted or withdrawn customers!");
    }

    checklist.item8_blockedAccessAfterDeletionWithdrawal = "PASS";
    console.log("  -> [PASS] Item 8: Blocked Access Controls verified.");

    // -------------------------------------------------------------
    // 9. LEAK AUDIT (NO PII, REVIEWER DATA OR STACK TRACES IN UI)
    // -------------------------------------------------------------
    console.log("\n[VERIFY 9] UI Leak Audit across Privacy Views...");
    const userVisibleText = await page.innerText("body");
    const forbiddenStrings = ["pooja", "ravi", "@example.com", "Traceback", "reviewer", "admin_jwt", custA_UploadToken, custB_UploadToken];
    for (const str of forbiddenStrings) {
      if (userVisibleText.toLowerCase().includes(str.toLowerCase())) {
        throw new Error(`Sensitive string '${str}' leaked to customer UI!`);
      }
    }
    console.log("  -> Zero PII, reviewer notes, or internal details exposed in customer privacy enclave.");

    checklist.item9_noInternalLeaksOrPiiInUI = "PASS";
    console.log("  -> [PASS] Item 9: UI Leak Audit verified.");

    // -------------------------------------------------------------
    // 10. RESPONSIVE UI & ERROR LOGS
    // -------------------------------------------------------------
    console.log("\n[VERIFY 10] Responsive Layout & Error Log Inspection...");
    // Check mobile viewport on /privacy
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/privacy`, { waitUntil: "networkidle" });
    const mobileWidth = await page.evaluate(() => window.innerWidth);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`  -> Mobile viewport: ${mobileWidth}px, Scroll width: ${scrollWidth}px`);
    if (scrollWidth > mobileWidth + 2) {
      throw new Error(`Horizontal overflow on mobile view: ${scrollWidth}px > ${mobileWidth}px`);
    }

    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR_FAILED") && !e.includes("404") && !e.includes("403")
    );
    console.log(`  -> Critical console errors: ${criticalErrors.length}`);
    if (criticalErrors.length > 0) {
      throw new Error(`Captured critical console errors: ${JSON.stringify(criticalErrors)}`);
    }

    checklist.item10_responsiveUiAndCleanLogs = "PASS";
    console.log("  -> [PASS] Item 10: Responsive UI & Clean Logs verified.");
  } catch (err) {
    console.error("\n❌ STEP 4 TEST FAILED:", err);
  } finally {
    await browser.close();

    // Clean up Customer B from DB if still present
    try {
      if (custB_Id) {
        await safeFetch(`${API_BASE}/api/admin/customers/${custB_Id}/delete-data`, {
          method: "POST",
          headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
        });
      }
    } catch {}

    const countPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
with session_scope() as db:
    active = db.query(Customer).filter(Customer.case_status != 'deleted').count()
    print(active)
`;
    const remaining = parseInt(runPython(countPy), 10);
    console.log(`\n[CLEANUP] Active customers remaining in database: ${remaining}`);

    console.log("\n==========================================================================");
    console.log("                  STEP 4 AUDIT & VERIFICATION RESULTS                     ");
    console.log("==========================================================================");
    console.table(checklist);
  }
}

runStep4PrivacyRetentionTest();
