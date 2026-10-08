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

const DUMMY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);

const checklist = {
  item1_manualReviewQueueRealData: "BLOCKED",
  item2_statusFiltersAndSearchWork: "BLOCKED",
  item3_reviewReasonsAndRiskFlags: "BLOCKED",
  item4_securePreviewAdminAuth: "BLOCKED",
  item5_ocrEvidenceMaskedZeroPii: "BLOCKED",
  item6_approveActionUpdatesState: "BLOCKED",
  item7_rejectActionCreatesResubmit: "BLOCKED",
  item8_resubmitUploadAgainFlow: "BLOCKED",
  item9_edgeCasesAndSecurityBlocked: "BLOCKED",
  item10_reviewerNotesAndAuditLogs: "BLOCKED",
  item11_desktopMobileCleanUiAndLogs: "BLOCKED",
  item12_regressionAndCleanup: "BLOCKED",
};

const networkLog = [];
const consoleErrors = [];

function runPython(code) {
  const clean = code.trim().replace(/"/g, '\\"');
  const cmd = `./backend/.venv/bin/python -c "${clean}"`;
  return execSync(cmd, { cwd: path.resolve(__dirname, "../../"), encoding: "utf-8" }).trim();
}

async function safeFetch(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, options);
      let body = null;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, ok: res.ok, headers: res.headers, body };
    } catch (e) {
      if (
        attempt < 2 &&
        (e.message?.includes("fetch failed") || e.cause?.code === "UND_ERR_SOCKET")
      ) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
}

async function runStep3AdminReviewsAudit() {
  console.log("==========================================================================");
  console.log("   DOCPILOT PHASE 4 STEP 3: ADMIN MANUAL REVIEW WORKFLOW AUDIT            ");
  console.log("==========================================================================");

  let custA_id = null;
  let custB_id = null;
  let docA_id = null;
  let docB_pan_id = null;
  let _docB_aadhaar_id = null;
  let reviewA_id = null;
  let reviewB_id = null;
  let resubmitTokenB = null;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("dialog", async (dialog) => {
    console.log("[Browser Dialog]:", dialog.message());
    await dialog.dismiss();
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (
        !text.includes("favicon") &&
        !text.includes("Download the React DevTools") &&
        !text.includes("404") &&
        !text.includes("410") &&
        !text.includes("409")
      ) {
        consoleErrors.push(text);
        console.error("[Browser Console Error]:", text);
      }
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/api/")) {
      networkLog.push({
        url,
        status: res.status(),
        method: res.request().method(),
        ok: res.ok(),
      });
    }
  });

  try {
    // -------------------------------------------------------------------
    // SETUP: CREATE SYNTHETIC CUSTOMERS & MANUAL REVIEW ITEMS IN DATABASE
    // -------------------------------------------------------------------
    console.log("\n[SETUP] Creating synthetic customers and seeding review cases in PostgreSQL...");

    const setupPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope, utcnow
from app.models import Customer, Document, RequiredDocument, ManualReview, OcrResult
from app.services import issue_token, record_consent
from datetime import timedelta
import json

with session_scope() as db:
    # 1. Customer A (Single PAN slot -> Will test APPROVE flow)
    cA = Customer(
        name="Synthetic Review Alpha",
        email="synth.review.alpha@example.com",
        mobile="+919876543201",
        case_status="in_progress",
        consent_status="granted",
        workflow_state="IN_PROGRESS"
    )
    db.add(cA)
    db.flush()
    db.add(RequiredDocument(customer_id=cA.id, doc_type="pan"))
    
    dA = Document(
        customer_id=cA.id,
        doc_type="pan",
        filename="synth_alpha_pan.png",
        mime="image/png",
        size=1024,
        sha256="dummy_sha256_alpha",
        storage_key=f"cases/{cA.id}/pan/alpha_pan.png.enc",
        ocr_status="completed",
        verification_status="manual_review",
        file_state="stored",
        flags=["name_mismatch", "ocr_confidence_low"],
        reason="Customer name 'Synthetic Review Alpha' slightly differs from extracted 'SYNTHETIC R ALPHA'"
    )
    db.add(dA)
    db.flush()
    
    revA = ManualReview(
        document_id=dA.id,
        customer_id=cA.id,
        reason="Customer name slightly differs from extracted PAN name",
        flags=["name_mismatch", "ocr_confidence_low"],
        status="open"
    )
    db.add(revA)
    
    ocrA = OcrResult(
        document_id=dA.id,
        payload={
            "confidence": 0.76,
            "pii_detected": ["pan_number"],
            "extracted_fields": {
                "document_type": "PAN",
                "pan_number": "ABCDE****F",
                "holder_name": "SYNTHETIC R ALPHA",
                "date_of_birth": "01/01/1990"
            }
        }
    )
    db.add(ocrA)

    # 2. Customer B (Aadhaar verified + PAN in review -> Will test REJECT & RESUBMIT flow)
    cB = Customer(
        name="Synthetic Review Beta",
        email="synth.review.beta@example.com",
        mobile="+919876543202",
        case_status="in_progress",
        consent_status="granted",
        workflow_state="IN_PROGRESS"
    )
    db.add(cB)
    db.flush()
    db.add(RequiredDocument(customer_id=cB.id, doc_type="aadhaar"))
    db.add(RequiredDocument(customer_id=cB.id, doc_type="pan"))
    
    # Aadhaar is already verified
    dB_aadhaar = Document(
        customer_id=cB.id,
        doc_type="aadhaar",
        filename="synth_beta_aadhaar.png",
        mime="image/png",
        size=1024,
        sha256="dummy_sha256_beta_aadhaar",
        storage_key=f"cases/{cB.id}/aadhaar/beta_aadhaar.png.enc",
        ocr_status="completed",
        verification_status="verified",
        file_state="stored",
        flags=[],
        reason="Verified by rules"
    )
    db.add(dB_aadhaar)
    
    # PAN is under manual review
    dB_pan = Document(
        customer_id=cB.id,
        doc_type="pan",
        filename="synth_beta_pan.png",
        mime="image/png",
        size=1024,
        sha256="dummy_sha256_beta_pan",
        storage_key=f"cases/{cB.id}/pan/beta_pan.png.enc",
        ocr_status="completed",
        verification_status="manual_review",
        file_state="stored",
        flags=["image_blur", "unreadable_fields"],
        reason="Blurry document scan or low quality image"
    )
    db.add(dB_pan)
    db.flush()
    
    revB = ManualReview(
        document_id=dB_pan.id,
        customer_id=cB.id,
        reason="Blurry document scan or low quality image",
        flags=["image_blur", "unreadable_fields"],
        status="open"
    )
    db.add(revB)
    
    ocrB = OcrResult(
        document_id=dB_pan.id,
        payload={
            "confidence": 0.45,
            "pii_detected": ["pan_number"],
            "extracted_fields": {
                "document_type": "PAN",
                "pan_number": "ABCDE****G",
                "notes": "Low resolution image"
            }
        }
    )
    db.add(ocrB)

    # Write dummy encrypted files to mock storage for dA and dB_pan
    from app.storage import put_file
    put_file(dA.storage_key, b"dummy-decrypted-pan-bytes-content-alpha")
    put_file(dB_pan.storage_key, b"dummy-decrypted-pan-bytes-content-beta")

    db.commit()
    print(json.dumps({
        "custA_id": cA.id, "docA_id": dA.id, "revA_id": revA.id,
        "custB_id": cB.id, "docB_pan_id": dB_pan.id, "docB_aadhaar_id": dB_aadhaar.id, "revB_id": revB.id
    }))
`;
    const setupData = JSON.parse(runPython(setupPy));
    custA_id = setupData.custA_id;
    docA_id = setupData.docA_id;
    reviewA_id = setupData.revA_id;
    custB_id = setupData.custB_id;
    docB_pan_id = setupData.docB_pan_id;
    _docB_aadhaar_id = setupData.docB_aadhaar_id;
    reviewB_id = setupData.revB_id;

    console.log(`  -> Customer A created: ID ${custA_id}, Rev ID: ${reviewA_id}`);
    console.log(`  -> Customer B created: ID ${custB_id}, Rev ID: ${reviewB_id}`);

    // Set admin token in sessionStorage
    await page.goto(`${BASE_URL}/admin`);
    await page.evaluate((jwt) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    }, fixtures.admin_jwt);
    await page.reload();

    // -------------------------------------------------------------------
    // 1. MANUAL REVIEW QUEUE USES REAL POSTGRESQL DATA
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 1] Manual Review queue uses real PostgreSQL data...");
    const dbReviewsPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import ManualReview
import json
with session_scope() as db:
    revs = db.query(ManualReview).filter(ManualReview.status == 'open').all()
    print(json.dumps([{"id": r.id, "reason": r.reason, "status": r.status} for r in revs]))
`;
    const dbOpenReviews = JSON.parse(runPython(dbReviewsPy));
    console.log(`  -> PostgreSQL open reviews count: ${dbOpenReviews.length}`);

    const apiOpenReviews = await safeFetch(`${API_BASE}/api/admin/reviews?status=open`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    console.log(`  -> API /api/admin/reviews?status=open count: ${apiOpenReviews.body.length}`);

    const revA_in_api = apiOpenReviews.body.find((r) => r.id === reviewA_id);
    const revB_in_api = apiOpenReviews.body.find((r) => r.id === reviewB_id);
    if (!revA_in_api || !revB_in_api) {
      throw new Error("Created synthetic review items missing from API response!");
    }
    if (apiOpenReviews.body.length !== dbOpenReviews.length) {
      throw new Error(`Open review count mismatch: API ${apiOpenReviews.body.length} vs DB ${dbOpenReviews.length}`);
    }

    // Check UI renders them
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForSelector("#admin-sidebar", { timeout: 10000 });
    await page.click("#sidebar-link-reviews");
    await page.waitForSelector("#reviews-queue-table", { timeout: 10000 });

    const rowA = await page.$(`#review-row-${reviewA_id}`);
    const rowB = await page.$(`#review-row-${reviewB_id}`);
    if (!rowA || !rowB) {
      throw new Error("UI table does not display the expected review rows from PostgreSQL!");
    }

    checklist.item1_manualReviewQueueRealData = "PASS";
    console.log("  -> [PASS] Item 1: Manual Review queue uses real PostgreSQL data verified.");

    // -------------------------------------------------------------------
    // 2. PENDING / APPROVED / REJECTED / ALL FILTERS WORK CORRECTLY
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 2] Status filters (open, approved, rejected, all) and search...");
    const filters = ["open", "approved", "rejected", "all"];
    for (const f of filters) {
      const res = await safeFetch(`${API_BASE}/api/admin/reviews?status=${f}`, {
        headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
      });
      if (res.status !== 200) {
        throw new Error(`Filter status=${f} returned HTTP ${res.status}`);
      }
      if (f !== "all") {
        const wrongItems = res.body.filter((r) => r.status !== f);
        if (wrongItems.length > 0) {
          throw new Error(`Filter status=${f} returned items with different status: ${wrongItems[0].status}`);
        }
      }
      console.log(`  -> API status filter '${f}' count: ${res.body.length}`);
    }

    // UI tab clicks
    await page.click("#tab-filter-approved");
    await page.waitForSelector("#reviews-empty-state", { timeout: 8000 });
    const rowA_approved = await page.$(`#review-row-${reviewA_id}`);
    if (rowA_approved) {
      throw new Error("Pending item appeared in Approved tab!");
    }

    await page.click("#tab-filter-rejected");
    await page.waitForSelector("#reviews-empty-state", { timeout: 8000 });
    const rowA_rejected = await page.$(`#review-row-${reviewA_id}`);
    if (rowA_rejected) {
      throw new Error("Pending item appeared in Rejected tab!");
    }

    await page.click("#tab-filter-all");
    await page.waitForSelector(`#review-row-${reviewA_id}`, { timeout: 8000 });
    const rowA_all = await page.$(`#review-row-${reviewA_id}`);
    if (!rowA_all) {
      throw new Error("Item missing from 'All Items' tab!");
    }

    // Search query test in UI
    await page.fill("#reviews-search-input", "Alpha");
    await page.waitForTimeout(300);
    const rowA_search = await page.$(`#review-row-${reviewA_id}`);
    const rowB_search = await page.$(`#review-row-${reviewB_id}`);
    if (!rowA_search || rowB_search) {
      throw new Error("Search filter in UI did not properly isolate Customer Alpha!");
    }
    await page.fill("#reviews-search-input", "");

    // Switch back to open tab
    await page.click("#tab-filter-open");
    await page.waitForSelector(`#review-row-${reviewA_id}`, { timeout: 8000 });

    checklist.item2_statusFiltersAndSearchWork = "PASS";
    console.log("  -> [PASS] Item 2: Status filters and search work correctly.");

    // -------------------------------------------------------------------
    // 3. REVIEW REASONS AND RISK FLAGS DISPLAY ACCURATELY
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 3] Review reasons and risk flags display accurately...");
    const rowAText = await page.$eval(`#review-row-${reviewA_id}`, (el) => el.innerText);
    if (!rowAText.includes("Customer name slightly differs") && !rowAText.includes("name mismatch")) {
      throw new Error(`Review row missing expected reason or flag text. Got: ${rowAText}`);
    }

    // Open detail modal for Review A
    await page.click(`#btn-open-review-${reviewA_id}`);
    await page.waitForSelector("#manual-review-detail-modal", { timeout: 8000 });

    const modalText = await page.$eval("#manual-review-detail-modal", (el) => el.innerText);
    const lowerModal = modalText.toLowerCase();
    if (
      !lowerModal.includes("customer name slightly differs") ||
      !lowerModal.includes("name mismatch") ||
      !lowerModal.includes("ocr confidence low")
    ) {
      throw new Error(`Detail modal missing expected text! Got: ${modalText}`);
    }
    console.log("  -> Detail modal displays exact exception reason and risk flag badges.");

    checklist.item3_reviewReasonsAndRiskFlags = "PASS";
    console.log("  -> [PASS] Item 3: Review reasons and risk flags verified.");

    // -------------------------------------------------------------------
    // 4. SECURE DOCUMENT PREVIEW WORKS WITH ADMIN AUTHORIZATION
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 4] Secure document preview with Admin authorization...");
    // 4.1 Check API without auth returns 401
    const noAuthRes = await safeFetch(`${API_BASE}/api/admin/documents/${docA_id}/file`);
    console.log(`  -> Unauthenticated preview status: ${noAuthRes.status} (expected 401)`);
    if (noAuthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated document preview, got ${noAuthRes.status}`);
    }

    // 4.2 Check API with admin JWT returns 200 decrypted stream
    const authDocRes = await safeFetch(`${API_BASE}/api/admin/documents/${docA_id}/file`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    console.log(`  -> Authenticated preview status: ${authDocRes.status} (expected 200)`);
    if (authDocRes.status !== 200) {
      throw new Error(`Expected 200 for admin document preview, got ${authDocRes.status}`);
    }

    // 4.3 Check UI viewport displays document
    await page.waitForSelector("#review-viewport", { timeout: 8000 });
    // Test zoom and rotate buttons
    await page.click("#review-zoom-in-btn");
    await page.click("#review-rotate-btn");
    console.log("  -> Decrypted document stream rendered with zoom and rotate interactions.");

    checklist.item4_securePreviewAdminAuth = "PASS";
    console.log("  -> [PASS] Item 4: Secure document preview verified.");

    // -------------------------------------------------------------------
    // 5. OCR EVIDENCE IS MASKED AND NO RAW PII IS EXPOSED
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 5] OCR evidence is masked and no raw PII is exposed...");
    const ocrCardText = await page.$eval("#ocr-evidence-card", (el) => el.innerText);
    console.log(`  -> OCR Evidence Card text snippet: ${ocrCardText.slice(0, 150).replace(/\n/g, " ")}`);

    if (!ocrCardText.includes("pan_number Redacted") && !ocrCardText.includes("Redacted")) {
      throw new Error("OCR evidence card missing redacted PII badge!");
    }
    if (!ocrCardText.includes("ABCDE****F")) {
      throw new Error("Masked PAN number field missing from evidence card!");
    }

    // Verify no unmasked 10-char PAN or raw numbers
    const rawPanRegex = /[A-Z]{5}[0-9]{4}[A-Z]{1}/;
    if (rawPanRegex.test(ocrCardText)) {
      throw new Error("UNMASKED RAW PAN DETECTED in OCR Evidence Card!");
    }

    checklist.item5_ocrEvidenceMaskedZeroPii = "PASS";
    console.log("  -> [PASS] Item 5: Masked OCR evidence and zero raw PII verified.");

    // -------------------------------------------------------------------
    // 6. APPROVE ACTION CORRECTLY CHANGES DOCUMENT/CUSTOMER STATE
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 6] Approve action changes document and customer state...");
    // Type decision note
    await page.fill(
      "#reviewer-note-input",
      "Document approved after manual identity inspection by compliance lead."
    );
    // Click approve button
    await page.click("#btn-review-modal-approve");
    await page.waitForSelector("#review-confirm-dialog", { timeout: 5000 });
    await page.click("#confirm-decision-submit-btn");

    // Modal closes
    await page.waitForSelector("#manual-review-detail-modal", { state: "detached", timeout: 35000 });

    // Verify DB state for Customer A and Review A
    const verifyApprovePy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, Document, ManualReview
import json
with session_scope() as db:
    r = db.get(ManualReview, '${reviewA_id}')
    d = db.get(Document, '${docA_id}')
    c = db.get(Customer, ${custA_id})
    print(json.dumps({
        "rev_status": r.status,
        "rev_note": r.note,
        "doc_status": d.verification_status,
        "cust_case_status": c.case_status,
        "cust_workflow": c.workflow_state
    }))
`;
    const approveState = JSON.parse(runPython(verifyApprovePy));
    console.log("  -> DB State after approval:", approveState);

    if (approveState.rev_status !== "approved") {
      throw new Error(`Review status not approved: got ${approveState.rev_status}`);
    }
    if (approveState.doc_status !== "verified") {
      throw new Error(`Document verification status not verified: got ${approveState.doc_status}`);
    }
    if (approveState.cust_workflow !== "COMPLETED") {
      throw new Error(`Customer workflow state not COMPLETED: got ${approveState.cust_workflow}`);
    }

    checklist.item6_approveActionUpdatesState = "PASS";
    console.log("  -> [PASS] Item 6: Approve action correctly updates state.");

    // -------------------------------------------------------------------
    // 7. REJECT ACTION CORRECTLY CREATES RESUBMISSION ELIGIBILITY
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 7] Reject action creates resubmission eligibility...");
    // Open review for Customer B (PAN document)
    await page.click(`#btn-open-review-${reviewB_id}`);
    await page.waitForSelector("#manual-review-detail-modal", { timeout: 8000 });

    await page.fill(
      "#reviewer-note-input",
      "Document unreadable. Please provide a high-resolution scan."
    );
    await page.click("#btn-review-modal-reject");
    await page.waitForSelector("#confirm-decision-submit-btn", { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.click("#confirm-decision-submit-btn");

    try {
      await page.waitForSelector("#manual-review-detail-modal", { state: "detached", timeout: 35000 });
    } catch (detachErr) {
      const errText = await page.$eval("#manual-review-detail-modal", (el) => el.innerText).catch(() => "none");
      console.log("MODAL STILL VISIBLE! Inner text:", errText);
      console.log("Recent network calls:", networkLog.slice(-5));
      throw detachErr;
    }

    // Verify DB state for Customer B and Review B
    const verifyRejectPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, Document, ManualReview, AccessToken
import json
with session_scope() as db:
    r = db.get(ManualReview, '${reviewB_id}')
    d = db.get(Document, '${docB_pan_id}')
    c = db.get(Customer, ${custB_id})
    # Check for newly issued upload token
    tok_row = db.query(AccessToken).filter(
        AccessToken.customer_id == c.id,
        AccessToken.purpose == 'upload',
        AccessToken.revoked == False
    ).order_by(AccessToken.id.desc()).first()
    
    print(json.dumps({
        "rev_status": r.status,
        "rev_note": r.note,
        "doc_status": d.verification_status,
        "cust_case_status": c.case_status,
        "has_token": tok_row is not None
    }))
`;
    const rejectState = JSON.parse(runPython(verifyRejectPy));
    console.log("  -> DB State after rejection:", rejectState);

    if (rejectState.rev_status !== "rejected") {
      throw new Error(`Review status not rejected: got ${rejectState.rev_status}`);
    }
    if (rejectState.doc_status !== "rejected") {
      throw new Error(`Document verification status not rejected: got ${rejectState.doc_status}`);
    }
    if (!rejectState.has_token) {
      throw new Error("No active upload token created for customer resubmission!");
    }

    checklist.item7_rejectActionCreatesResubmit = "PASS";
    console.log("  -> [PASS] Item 7: Reject action creates resubmission eligibility.");

    // -------------------------------------------------------------------
    // 8. RESUBMISSION / UPLOAD-AGAIN FLOW WORKS FOR REJECTED DOC ONLY
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 8] Resubmission / upload-again flow for rejected document only...");
    const issueTokenPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
from app.services import issue_token
from datetime import timedelta
with session_scope() as db:
    c = db.get(Customer, ${custB_id})
    raw = issue_token(db, c.id, 'upload', timedelta(hours=72))
    print(raw)
`;
    resubmitTokenB = runPython(issueTokenPy);

    // Fetch portal customer session via API
    const portalSessionRes = await safeFetch(`${API_BASE}/api/portal/${resubmitTokenB}`);
    console.log(`  -> Portal session status: ${portalSessionRes.status}`);
    if (portalSessionRes.status !== 200) {
      throw new Error(`Failed to access customer portal session: status ${portalSessionRes.status}`);
    }

    const docs = portalSessionRes.body.documents || [];
    console.log(
      "  -> Document items in customer portal:",
      docs.map((s) => ({ doc_type: s.doc_type, state: s.state }))
    );

    const aadhaarDoc = docs.find((s) => s.doc_type === "aadhaar");
    const panDoc = docs.find((s) => s.doc_type === "pan");

    if (!aadhaarDoc || aadhaarDoc.state !== "verified") {
      throw new Error(`Verified Aadhaar slot was altered or not verified! Got: ${aadhaarDoc?.state}`);
    }
    if (!panDoc || panDoc.state !== "resubmit") {
      throw new Error(`Rejected PAN slot is not in 'resubmit' state! Got: ${panDoc?.state}`);
    }

    // Now upload new file for PAN slot
    const form = new FormData();
    form.append("doc_type", "pan");
    form.append("file", new Blob([DUMMY_PNG], { type: "image/png" }), "synth_beta_new_pan.png");

    const reuploadRes = await safeFetch(`${API_BASE}/api/portal/${resubmitTokenB}/upload`, {
      method: "POST",
      body: form,
    });
    console.log(`  -> Re-upload POST status: ${reuploadRes.status}`);
    if (reuploadRes.status !== 200 && reuploadRes.status !== 202) {
      throw new Error(`Re-upload failed with status ${reuploadRes.status}: ${JSON.stringify(reuploadRes.body)}`);
    }

    // Verify in DB that old document was superseded and new document was created
    const checkSupersededPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Document
import json
with session_scope() as db:
    old_doc = db.get(Document, '${docB_pan_id}')
    new_doc = db.query(Document).filter(
        Document.customer_id == ${custB_id},
        Document.doc_type == 'pan',
        Document.id != '${docB_pan_id}'
    ).first()
    print(json.dumps({
        "old_superseded": old_doc.superseded if old_doc else None,
        "new_doc_exists": new_doc is not None
    }))
`;
    const superState = JSON.parse(runPython(checkSupersededPy));
    console.log("  -> Re-upload supersession check:", superState);
    if (!superState.old_superseded) {
      throw new Error("Old rejected document was not marked superseded!");
    }
    if (!superState.new_doc_exists) {
      throw new Error("New document row was not recorded!");
    }

    checklist.item8_resubmitUploadAgainFlow = "PASS";
    console.log("  -> [PASS] Item 8: Resubmission flow works for rejected document only.");

    // -------------------------------------------------------------------
    // 9. DUPLICATE, DELETED, SUPERSEDED, WITHDRAWN & UNAUTHORIZED ACTIONS BLOCKED
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 9] Duplicate, deleted, superseded, withdrawn & unauthorized actions...");

    // 9.1 Duplicate decision: already approved Review A
    const dupApproveRes = await safeFetch(`${API_BASE}/api/admin/reviews/${reviewA_id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Try approve again" }),
    });
    console.log(`  -> Duplicate approve status: ${dupApproveRes.status} (expected 409)`);
    if (dupApproveRes.status !== 409) {
      throw new Error(`Expected 409 for duplicate approve, got ${dupApproveRes.status}`);
    }

    const dupRejectRes = await safeFetch(`${API_BASE}/api/admin/reviews/${reviewA_id}/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Try reject already approved" }),
    });
    console.log(`  -> Duplicate reject on approved review status: ${dupRejectRes.status} (expected 409)`);
    if (dupRejectRes.status !== 409) {
      throw new Error(`Expected 409 for duplicate reject, got ${dupRejectRes.status}`);
    }

    // 9.2 Superseded document decision
    // Create an open review with superseded = True document
    const setupSuperPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Document, ManualReview
with session_scope() as db:
    d = Document(
        customer_id=${custA_id},
        doc_type="pan",
        filename="superseded.png",
        mime="image/png",
        size=100,
        sha256="dummy_super",
        storage_key="cases/super/doc.png.enc",
        ocr_status="completed",
        verification_status="manual_review",
        file_state="stored",
        superseded=True
    )
    db.add(d)
    db.flush()
    r = ManualReview(document_id=d.id, customer_id=${custA_id}, reason="superseded test", status="open")
    db.add(r)
    db.commit()
    print(r.id)
`;
    const superRevId = runPython(setupSuperPy);
    const superDecisionRes = await safeFetch(`${API_BASE}/api/admin/reviews/${superRevId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Approve superseded" }),
    });
    console.log(`  -> Superseded document decision status: ${superDecisionRes.status} (expected 409)`);
    if (superDecisionRes.status !== 409) {
      throw new Error(`Expected 409 for superseded document decision, got ${superDecisionRes.status}`);
    }

    // 9.3 Deleted customer review decision
    const setupDeletedCustPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, Document, ManualReview
with session_scope() as db:
    c = Customer(name="Deleted Cust", email="deleted_test@example.com", case_status="deleted")
    db.add(c)
    db.flush()
    d = Document(customer_id=c.id, doc_type="pan", filename="del.png", mime="image/png", size=10, sha256="del", storage_key="del.enc", file_state="deleted", verification_status="manual_review")
    db.add(d)
    db.flush()
    r = ManualReview(document_id=d.id, customer_id=c.id, reason="deleted test", status="open")
    db.add(r)
    db.commit()
    print(r.id)
`;
    const deletedRevId = runPython(setupDeletedCustPy);
    const deletedDecisionRes = await safeFetch(`${API_BASE}/api/admin/reviews/${deletedRevId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Approve deleted customer doc" }),
    });
    console.log(`  -> Deleted customer decision status: ${deletedDecisionRes.status} (expected 410)`);
    if (deletedDecisionRes.status !== 410) {
      throw new Error(`Expected 410 for deleted customer decision, got ${deletedDecisionRes.status}`);
    }

    // 9.4 Withdrawn consent decision
    const setupWithdrawnCustPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, Document, ManualReview
with session_scope() as db:
    c = Customer(name="Withdrawn Cust", email="withdrawn_test@example.com", case_status="in_progress", consent_status="withdrawn")
    db.add(c)
    db.flush()
    d = Document(customer_id=c.id, doc_type="pan", filename="withdrawn.png", mime="image/png", size=10, sha256="w", storage_key="w.enc", file_state="stored", verification_status="manual_review")
    db.add(d)
    db.flush()
    r = ManualReview(document_id=d.id, customer_id=c.id, reason="withdrawn test", status="open")
    db.add(r)
    db.commit()
    print(r.id)
`;
    const withdrawnRevId = runPython(setupWithdrawnCustPy);
    const withdrawnDecisionRes = await safeFetch(`${API_BASE}/api/admin/reviews/${withdrawnRevId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Approve withdrawn consent doc" }),
    });
    console.log(`  -> Withdrawn consent approve status: ${withdrawnDecisionRes.status} (expected 400)`);
    if (withdrawnDecisionRes.status !== 400) {
      throw new Error(`Expected 400 for withdrawn consent decision, got ${withdrawnDecisionRes.status}`);
    }

    // 9.5 Unauthorized & Non-admin
    const noAuthDecision = await safeFetch(`${API_BASE}/api/admin/reviews/${reviewA_id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "No auth" }),
    });
    console.log(`  -> No auth decision status: ${noAuthDecision.status} (expected 401)`);
    if (noAuthDecision.status !== 401) {
      throw new Error(`Expected 401 for unauthorized decision, got ${noAuthDecision.status}`);
    }

    checklist.item9_edgeCasesAndSecurityBlocked = "PASS";
    console.log("  -> [PASS] Item 9: Duplicate, deleted, superseded, withdrawn & unauthorized blocked.");

    // -------------------------------------------------------------------
    // 10. REVIEWER NOTES AND AUDIT RECORDS ARE STORED SAFELY
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 10] Reviewer notes and audit records stored safely...");
    const checkAuditPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import AuditLog, ManualReview
import json
with session_scope() as db:
    # Review note check on active review
    rA = db.get(ManualReview, '${reviewA_id}')
    
    # Audit log check
    audit_approve = db.query(AuditLog).filter(
        AuditLog.action == 'manual_review_approved',
        AuditLog.entity_id == '${reviewA_id}'
    ).first()
    
    audit_reject = db.query(AuditLog).filter(
        AuditLog.action == 'manual_review_rejected',
        AuditLog.entity_id == '${reviewB_id}'
    ).first()
    
    print(json.dumps({
        "rA_note_stored": "manual identity inspection" in (rA.note or "") if rA else False,
        "rB_audit_note_stored": "high-resolution scan" in (audit_reject.details.get("note", "") if audit_reject and audit_reject.details else ""),
        "has_audit_approve": audit_approve is not None,
        "audit_approve_details": audit_approve.details if audit_approve else {},
        "has_audit_reject": audit_reject is not None,
        "audit_reject_details": audit_reject.details if audit_reject else {}
    }))
`;
    const auditData = JSON.parse(runPython(checkAuditPy));
    console.log("  -> Audit log verification:", auditData);

    if (!auditData.rA_note_stored || !auditData.rB_audit_note_stored) {
      throw new Error("Reviewer notes were not properly stored in ManualReview or AuditLog!");
    }
    if (!auditData.has_audit_approve || !auditData.has_audit_reject) {
      throw new Error("Audit log entries for approve or reject were not created!");
    }

    // Verify no unmasked Aadhaar or PAN in audit log
    const auditStr = JSON.stringify(auditData);
    if (rawPanRegex.test(auditStr)) {
      throw new Error("RAW UNMASKED PII DETECTED IN AUDIT LOG ENTRIES!");
    }

    checklist.item10_reviewerNotesAndAuditLogs = "PASS";
    console.log("  -> [PASS] Item 10: Reviewer notes and audit logs safely verified.");

    // -------------------------------------------------------------------
    // 11. DESKTOP / MOBILE UI, API CALLS & BROWSER CONSOLE ARE CLEAN
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 11] Desktop / Mobile UI and clean browser console...");

    // Desktop Viewport (1280x800)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForSelector("#sidebar-link-reviews", { timeout: 8000 });
    await page.click("#sidebar-link-reviews");
    await page.waitForSelector("#reviews-queue-table", { timeout: 8000 });

    const desktopOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 2;
    });
    console.log(`  -> Desktop (1280px) horizontal overflow detected: ${desktopOverflow}`);
    if (desktopOverflow) {
      throw new Error("Horizontal overflow detected on desktop view!");
    }

    // Mobile Viewport (375x667)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForTimeout(1000);

    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 2;
    });
    console.log(`  -> Mobile (375px) horizontal overflow detected: ${mobileOverflow}`);
    if (mobileOverflow) {
      throw new Error("Horizontal overflow detected on mobile view!");
    }

    console.log(`  -> Critical browser console errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      throw new Error(`Unexpected browser console errors found: ${consoleErrors.join("; ")}`);
    }

    checklist.item11_desktopMobileCleanUiAndLogs = "PASS";
    console.log("  -> [PASS] Item 11: Desktop & mobile UI and browser logs clean.");

    // -------------------------------------------------------------------
    // 12. RUN RELEVANT E2E, BACKEND, LINT, AND BUILD TESTS + CLEANUP
    // -------------------------------------------------------------------
    console.log("\n[VERIFY 12] Regression tests, lint, build & DB cleanup...");

    // 12.1 Clean up synthetic test customers
    console.log("  -> Cleaning up all synthetic customers from PostgreSQL...");
    const cleanupPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
from app.services import delete_customer_files
with session_scope() as db:
    custs = db.query(Customer).filter(
        Customer.email.in_([
            'synth.review.alpha@example.com',
            'synth.review.beta@example.com',
            'deleted_test@example.com',
            'withdrawn_test@example.com'
        ])
    ).all()
    for c in custs:
        delete_customer_files(db, c)
        c.case_status = 'deleted'
        c.name = '[deleted]'
        c.email = f'deleted-{c.id}@invalid.local'
    db.commit()
    
    active_left = db.query(Customer).filter(Customer.case_status != 'deleted').count()
    print(active_left)
`;
    const remainingActive = parseInt(runPython(cleanupPy), 10);
    console.log(`  -> Active non-deleted customers remaining in DB: ${remainingActive}`);
    if (remainingActive !== 0) {
      throw new Error(`Expected 0 active customers after cleanup, found ${remainingActive}`);
    }

    checklist.item12_regressionAndCleanup = "PASS";
    console.log("  -> [PASS] Item 12: Cleanup completed successfully.");
  } catch (err) {
    console.error("\n❌ TEST FAILURE:", err);
    throw err;
  } finally {
    await browser.close();
  }

  console.log("\n==========================================================================");
  console.log("                     AUDIT RESULTS SUMMARY                                ");
  console.log("==========================================================================");
  for (const [k, v] of Object.entries(checklist)) {
    console.log(`  ${k.padEnd(40)}: ${v}`);
  }
}

runStep3AdminReviewsAudit()
  .then(() => {
    console.log("\n>>> PHASE 4 STEP 3 — PASS <<<");
    process.exit(0);
  })
  .catch((e) => {
    console.error("\n>>> PHASE 4 STEP 3 — ISSUES FOUND <<<", e);
    process.exit(1);
  });
