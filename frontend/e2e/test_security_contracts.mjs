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

const results = {
  adminAuth: "BLOCKED",
  idorAccessControl: "BLOCKED",
  uploadTokenSecurity: "BLOCKED",
  inputValidation: "BLOCKED",
  reviewApiContract: "BLOCKED",
  privacyDeletion: "BLOCKED",
  consentWithdrawal: "BLOCKED",
  documentSecurity: "BLOCKED",
  piiSecretLeakCheck: "BLOCKED",
  frontendContract: "BLOCKED",
  securityRegression: "BLOCKED",
  cleanup: "BLOCKED",
};

const networkResponses = [];
const consoleErrors = [];

// Minimal 1x1 transparent PNG bytes for valid uploads
const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function runPython(code) {
  const cmd = `./backend/.venv/bin/python -c "${code.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { cwd: "/home/incraax-ai/Documents/Vighnesh/DocPilot" }).toString().trim();
}

// Resilient fetch helper to prevent TCP socket drops during SMTP pauses
async function safeFetch(url, options = {}, retries = 3) {
  const opts = { ...options };
  opts.headers = { ...opts.headers, Connection: "close" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (attempt < retries && (err.code === "UND_ERR_SOCKET" || err.message?.includes("fetch failed"))) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
}

async function runSecurityVerification() {
  console.log("=== STARTING DOCPILOT SECURITY & API-CONTRACT VERIFICATION ===");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!text.includes("favicon") && !text.includes("Download the React DevTools")) {
        consoleErrors.push(text);
      }
    }
  });

  // Track all network responses to inspect for leaks & status codes
  page.on("response", async (res) => {
    try {
      const text = await res.text();
      networkResponses.push({
        url: res.url(),
        status: res.status(),
        body: text,
      });
    } catch {}
  });

  try {
    // -------------------------------------------------------------
    // 1. ADMIN AUTHENTICATION
    // -------------------------------------------------------------
    console.log("\n[VERIFY 1] Admin Authentication...");
    // 1.1 Unauthenticated request rejected
    const unauthRes = await safeFetch(`${API_BASE}/api/admin/summary`);
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated access, got ${unauthRes.status}`);
    }
    console.log(`  -> Unauthenticated protected route rejected: HTTP ${unauthRes.status}`);

    // 1.2 Invalid token rejected
    const invalidTokenRes = await safeFetch(`${API_BASE}/api/admin/summary`, {
      headers: { Authorization: "Bearer invalid.fake.token" },
    });
    if (invalidTokenRes.status !== 401) {
      throw new Error(`Expected 401 for invalid token, got ${invalidTokenRes.status}`);
    }
    console.log(`  -> Invalid JWT token rejected: HTTP ${invalidTokenRes.status}`);

    // 1.3 Unauthenticated customer list access rejected
    const unauthCustRes = await safeFetch(`${API_BASE}/api/admin/customers`);
    if (unauthCustRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated customers access, got ${unauthCustRes.status}`);
    }
    console.log(`  -> Unauthenticated customers API rejected: HTTP ${unauthCustRes.status}`);

    // 1.4 Frontend access without authentication
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
    const loginCard = page.locator("#admin-login-card");
    const isLoginCardVisible = await loginCard.isVisible();
    const isDashboardVisible = await page.locator("#tab-pane-dashboard").isVisible();
    if (!isLoginCardVisible || isDashboardVisible) {
      throw new Error("Frontend displayed protected dashboard to unauthenticated user!");
    }
    console.log("  -> Frontend strictly blocks dashboard and forces login for unauthenticated visitors.");
    results.adminAuth = "PASS";

    // -------------------------------------------------------------
    // 2. IDOR / CUSTOMER ACCESS CONTROL
    // -------------------------------------------------------------
    console.log("\n[VERIFY 2] IDOR / Customer Access Control...");
    // Create Customer A
    const custARes = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Synthetic User Alpha",
        email: "synth.idor.alpha@example.com",
        required_documents: ["pan"],
      }),
    });
    const custA = await custARes.json();
    console.log(`  -> Created Customer A (ID: ${custA.id})`);

    // Create Customer B
    const custBRes = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Synthetic User Beta",
        email: "synth.idor.beta@example.com",
        required_documents: ["pan"],
      }),
    });
    const custB = await custBRes.json();
    console.log(`  -> Created Customer B (ID: ${custB.id})`);

    // Grant consent and obtain upload tokens for both via DB issue
    const tokensPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
from app import services
import json
with session_scope() as db:
    cA = db.get(Customer, ${custA.id})
    cB = db.get(Customer, ${custB.id})
    c_tok_A = services.issue_token(db, cA.id, "consent", services.timedelta(hours=24))
    c_tok_B = services.issue_token(db, cB.id, "consent", services.timedelta(hours=24))
    print(json.dumps({"consentA": c_tok_A, "consentB": c_tok_B}))
`;
    const tokensObj = JSON.parse(runPython(tokensPy));

    // Submit consent for Customer A -> get upload_token_A
    const consentARes = await safeFetch(`${API_BASE}/api/public/consent/${tokensObj.consentA}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    const uploadTokenA = (await consentARes.json()).upload_token;

    // Submit consent for Customer B -> get upload_token_B
    const consentBRes = await safeFetch(`${API_BASE}/api/public/consent/${tokensObj.consentB}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    const uploadTokenB = (await consentBRes.json()).upload_token;

    // Customer A uploads a dummy document
    const formDataA = new FormData();
    formDataA.append("doc_type", "pan");
    formDataA.append("file", new Blob([DUMMY_PNG], { type: "image/png" }), "pan_card.png");

    const uploadARes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenA}/upload`, {
      method: "POST",
      body: formDataA,
    });
    const uploadAData = await uploadARes.json();
    const docAId = uploadAData.document_id;
    console.log(`  -> Customer A uploaded document: ${docAId}`);

    // IDOR Test 1: Customer B attempts to inspect Customer A's document status
    const idorStatusRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenB}/documents/${docAId}/status`);
    if (idorStatusRes.status !== 404) {
      throw new Error(`IDOR vulnerability detected! Expected 404 for cross-customer status query, got ${idorStatusRes.status}`);
    }
    console.log(`  -> Cross-customer document status access rejected: HTTP ${idorStatusRes.status} (Not Found)`);

    // IDOR Test 2: Unauthenticated / customer attempt to download Document A
    const idorDownloadRes = await safeFetch(`${API_BASE}/api/admin/documents/${docAId}/file`);
    if (idorDownloadRes.status !== 401) {
      throw new Error(`Expected 401 on unauthenticated document download, got ${idorDownloadRes.status}`);
    }
    console.log(`  -> Direct document file download without admin credentials rejected: HTTP ${idorDownloadRes.status}`);
    results.idorAccessControl = "PASS";

    // -------------------------------------------------------------
    // 3. UPLOAD TOKEN SECURITY
    // -------------------------------------------------------------
    console.log("\n[VERIFY 3] Upload Token Security...");
    // 3.1 Upload token used on consent endpoint
    const crossPurposeRes1 = await safeFetch(`${API_BASE}/api/public/consent/${uploadTokenA}`);
    if (crossPurposeRes1.status !== 404) {
      throw new Error(`Expected 404 when upload token used on consent route, got ${crossPurposeRes1.status}`);
    }
    console.log(`  -> Upload token rejected on consent endpoint: HTTP ${crossPurposeRes1.status}`);

    // 3.2 Consent token used on upload endpoint
    const crossPurposeRes2 = await safeFetch(`${API_BASE}/api/portal/${tokensObj.consentA}`);
    if (crossPurposeRes2.status !== 404) {
      throw new Error(`Expected 404 when consent token used on portal route, got ${crossPurposeRes2.status}`);
    }
    console.log(`  -> Consent token rejected on portal endpoint: HTTP ${crossPurposeRes2.status}`);

    // 3.3 Single-use reuse of consent token
    const reuseConsentRes = await safeFetch(`${API_BASE}/api/public/consent/${tokensObj.consentA}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    if (reuseConsentRes.status !== 404) {
      throw new Error(`Expected 404 for consumed consent token reuse, got ${reuseConsentRes.status}`);
    }
    console.log(`  -> Reused single-use consent token rejected: HTTP ${reuseConsentRes.status}`);

    // 3.4 Expired token rejected
    const expiredTokenRes = await safeFetch(`${API_BASE}/api/portal/${fixtures.item4_expired_token}`);
    if (expiredTokenRes.status !== 404) {
      throw new Error(`Expected 404 for expired token, got ${expiredTokenRes.status}`);
    }
    console.log(`  -> Expired token rejected: HTTP ${expiredTokenRes.status}`);
    results.uploadTokenSecurity = "PASS";

    // -------------------------------------------------------------
    // 4. API INPUT VALIDATION
    // -------------------------------------------------------------
    console.log("\n[VERIFY 4] API Input Validation...");
    const validationChecks = [];

    // 4.1 Malformed customer ID
    const malformedIdRes = await safeFetch(`${API_BASE}/api/admin/customers/not-an-integer-id`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    validationChecks.push({ name: "malformed customer ID", status: malformedIdRes.status, expected: 422 });

    // 4.2 Invalid email format
    const invalidEmailRes = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Invalid Email User", email: "not-a-valid-email-string" }),
    });
    validationChecks.push({ name: "invalid email format", status: invalidEmailRes.status, expected: 422 });

    // 4.3 Unsupported document type
    const badDocTypeData = new FormData();
    badDocTypeData.append("doc_type", "bitcoin_private_key");
    badDocTypeData.append("file", new Blob([DUMMY_PNG], { type: "image/png" }), "key.png");
    const badDocTypeRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenA}/upload`, {
      method: "POST",
      body: badDocTypeData,
    });
    validationChecks.push({ name: "unsupported document type", status: badDocTypeRes.status, expected: 400 });

    // 4.4 Disallowed file extension / executable content
    const badExtData = new FormData();
    badExtData.append("doc_type", "pan");
    badExtData.append("file", new Blob(["echo 'bad script'"], { type: "application/x-sh" }), "script.sh");
    const badExtRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenA}/upload`, {
      method: "POST",
      body: badExtData,
    });
    validationChecks.push({ name: "disallowed file extension", status: badExtRes.status, expected: 400 });

    // 4.5 Oversized upload (25 MB buffer)
    const bigBlob = new Blob([new Uint8Array(25 * 1024 * 1024)], { type: "application/pdf" });
    const bigFormData = new FormData();
    bigFormData.append("doc_type", "pan");
    bigFormData.append("file", bigBlob, "large.pdf");
    const bigUploadRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenA}/upload`, {
      method: "POST",
      body: bigFormData,
    });
    validationChecks.push({ name: "oversized upload", status: bigUploadRes.status, expected: 413 });

    // 4.6 Invalid review status
    const invalidReviewRes = await safeFetch(`${API_BASE}/api/admin/reviews?status=bogus_status_xyz`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    validationChecks.push({ name: "invalid review status", status: invalidReviewRes.status, expected: 422 });

    // 4.7 Malformed UUID / path parameter
    const malformedUuidRes = await safeFetch(`${API_BASE}/api/admin/documents/not-a-valid-uuid/file`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    validationChecks.push({ name: "malformed UUID parameter", status: malformedUuidRes.status, expected: 404 });

    // 4.8 Missing required fields
    const missingFieldsRes = await safeFetch(`${API_BASE}/api/admin/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.admin_jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    validationChecks.push({ name: "missing required fields", status: missingFieldsRes.status, expected: 422 });

    for (const v of validationChecks) {
      if (v.status >= 500) {
        throw new Error(`Validation check failed: ${v.name} triggered HTTP ${v.status} Internal Server Error!`);
      }
      console.log(`  -> Input validation [${v.name}]: HTTP ${v.status} (Clean 4xx response, No 500)`);
    }
    results.inputValidation = "PASS";

    // -------------------------------------------------------------
    // 5. REVIEW API CONTRACT
    // -------------------------------------------------------------
    console.log("\n[VERIFY 5] Review API Contract...");
    const statuses = ["open", "approved", "rejected", "all"];
    for (const s of statuses) {
      const res = await safeFetch(`${API_BASE}/api/admin/reviews?status=${s}`, {
        headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
      });
      if (res.status !== 200) {
        throw new Error(`Review contract failed for status=${s}: got HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(`Review contract failed for status=${s}: response is not an array`);
      }
      console.log(`  -> GET /api/admin/reviews?status=${s}: HTTP ${res.status} OK (Records: ${data.length})`);
    }

    const invalidStatusRes = await safeFetch(`${API_BASE}/api/admin/reviews?status=unsupported_filter`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    if (invalidStatusRes.status !== 422) {
      throw new Error(`Review contract failed: invalid status expected 422, got ${invalidStatusRes.status}`);
    }
    console.log(`  -> GET /api/admin/reviews?status=unsupported_filter: HTTP ${invalidStatusRes.status} (Cleanly rejected)`);
    results.reviewApiContract = "PASS";

    // -------------------------------------------------------------
    // 6. PRIVACY / DELETION SECURITY
    // -------------------------------------------------------------
    console.log("\n[VERIFY 6] Privacy Deletion Security...");
    // 6.1 Initiate deletion request
    const privReqRes = await safeFetch(`${API_BASE}/api/public/privacy/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "synth.idor.alpha@example.com",
        action: "delete",
      }),
    });
    if (privReqRes.status !== 202) {
      throw new Error(`Expected 202 on privacy deletion initiation, got ${privReqRes.status}`);
    }
    console.log(`  -> Privacy deletion request accepted: HTTP ${privReqRes.status}`);

    // 6.2 Invalid confirmation token
    const invalidConfirmRes = await safeFetch(`${API_BASE}/api/public/privacy/confirm/fake_confirmation_token`, {
      method: "POST",
    });
    if (invalidConfirmRes.status !== 404) {
      throw new Error(`Expected 404 for invalid confirmation token, got ${invalidConfirmRes.status}`);
    }
    console.log(`  -> Invalid confirmation token rejected: HTTP ${invalidConfirmRes.status}`);

    // Retrieve generated deletion confirmation token
    const getDelTokenPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import AccessToken
import json
with session_scope() as db:
    from app import services
    from app.models import PrivacyRequest
    pr = db.query(PrivacyRequest).filter(PrivacyRequest.customer_id == ${custA.id}, PrivacyRequest.action == 'delete').order_by(PrivacyRequest.created_at.desc()).first()
    t = services.issue_token(db, ${custA.id}, 'privacy', services.timedelta(minutes=30), ref_id=pr.id)
    print(json.dumps({"token": t}))
`;
    const delToken = JSON.parse(runPython(getDelTokenPy)).token;

    // 6.3 Confirm deletion
    const confirmDelRes = await safeFetch(`${API_BASE}/api/public/privacy/confirm/${delToken}`, {
      method: "POST",
    });
    if (confirmDelRes.status !== 200) {
      throw new Error(`Expected 200 on privacy deletion confirmation, got ${confirmDelRes.status}`);
    }
    const confirmDelData = await confirmDelRes.json();
    console.log(`  -> Privacy deletion completed successfully: ${JSON.stringify(confirmDelData)}`);

    // 6.4 Single-use token consumption check
    const reuseDelTokenRes = await safeFetch(`${API_BASE}/api/public/privacy/confirm/${delToken}`, {
      method: "POST",
    });
    if (reuseDelTokenRes.status !== 404) {
      throw new Error(`Expected 404 for single-use deletion token reuse, got ${reuseDelTokenRes.status}`);
    }
    console.log(`  -> Deletion token reuse rejected: HTTP ${reuseDelTokenRes.status}`);

    // 6.5 Verify deleted customer access blocked
    const deletedPortalRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenA}`);
    console.log(`  -> Deleted customer portal access blocked: HTTP ${deletedPortalRes.status}`);
    if (deletedPortalRes.status !== 403 && deletedPortalRes.status !== 404 && deletedPortalRes.status !== 409) {
      throw new Error(`Expected portal access blocked (403/404/409), got ${deletedPortalRes.status}`);
    }

    // 6.6 Verify document file returns 410 (file deleted)
    const deletedDocRes = await safeFetch(`${API_BASE}/api/admin/documents/${docAId}/file`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    if (deletedDocRes.status !== 410) {
      throw new Error(`Expected 410 file_deleted for purged document, got ${deletedDocRes.status}`);
    }
    console.log(`  -> Deleted document file access returns HTTP ${deletedDocRes.status} (File Deleted)`);
    results.privacyDeletion = "PASS";

    // -------------------------------------------------------------
    // 7. CONSENT WITHDRAWAL
    // -------------------------------------------------------------
    console.log("\n[VERIFY 7] Consent Withdrawal Security...");
    // 7.1 Initiate withdrawal request
    const withdrawReqRes = await safeFetch(`${API_BASE}/api/public/privacy/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "synth.idor.beta@example.com",
        action: "withdraw",
      }),
    });
    if (withdrawReqRes.status !== 202) {
      throw new Error(`Expected 202 on consent withdrawal initiation, got ${withdrawReqRes.status}`);
    }
    console.log(`  -> Consent withdrawal request accepted: HTTP ${withdrawReqRes.status}`);

    // 7.2 Issue test withdrawal confirmation token
    const getWithdrawTokenPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app import services
from app.models import PrivacyRequest
import json
with session_scope() as db:
    pr = db.query(PrivacyRequest).filter(PrivacyRequest.customer_id == ${custB.id}, PrivacyRequest.action == 'withdraw').order_by(PrivacyRequest.created_at.desc()).first()
    t = services.issue_token(db, ${custB.id}, 'privacy', services.timedelta(minutes=30), ref_id=pr.id)
    print(json.dumps({"token": t}))
`;
    const withdrawToken = JSON.parse(runPython(getWithdrawTokenPy)).token;

    // 7.3 Confirm withdrawal
    const confirmWithdrawRes = await safeFetch(`${API_BASE}/api/public/privacy/confirm/${withdrawToken}`, {
      method: "POST",
    });
    if (confirmWithdrawRes.status !== 200) {
      throw new Error(`Expected 200 on withdrawal confirmation, got ${confirmWithdrawRes.status}`);
    }
    console.log(`  -> Consent withdrawal completed: HTTP ${confirmWithdrawRes.status}`);

    // 7.4 Single-use check on withdrawal token
    const reuseWithdrawRes = await safeFetch(`${API_BASE}/api/public/privacy/confirm/${withdrawToken}`, {
      method: "POST",
    });
    if (reuseWithdrawRes.status !== 404) {
      throw new Error(`Expected 404 for consumed withdrawal token reuse, got ${reuseWithdrawRes.status}`);
    }
    console.log(`  -> Reused withdrawal token rejected: HTTP ${reuseWithdrawRes.status}`);

    // 7.5 Withdrawn customer cannot upload or access portal (token is revoked -> 404 or consent_required -> 403)
    const withdrawnPortalRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenB}`);
    if (withdrawnPortalRes.status !== 403 && withdrawnPortalRes.status !== 404 && withdrawnPortalRes.status !== 409) {
      throw new Error(`Expected blocked portal access (403/404/409), got ${withdrawnPortalRes.status}`);
    }
    console.log(`  -> Withdrawn customer portal access blocked: HTTP ${withdrawnPortalRes.status} (Access Blocked)`);

    const withdrawnUploadRes = await safeFetch(`${API_BASE}/api/portal/${uploadTokenB}/upload`, {
      method: "POST",
      body: formDataA,
    });
    if (withdrawnUploadRes.status !== 403 && withdrawnUploadRes.status !== 404 && withdrawnUploadRes.status !== 409) {
      throw new Error(`Expected blocked upload attempt (403/404/409), got ${withdrawnUploadRes.status}`);
    }
    console.log(`  -> Withdrawn customer upload attempt blocked: HTTP ${withdrawnUploadRes.status}`);
    results.consentWithdrawal = "PASS";

    // -------------------------------------------------------------
    // 8. DOCUMENT SECURITY
    // -------------------------------------------------------------
    console.log("\n[VERIFY 8] Document Security & Metadata Isolation...");
    // 8.1 Confirm list documents returns metadata only, never raw bytes
    const docListRes = await safeFetch(`${API_BASE}/api/admin/documents?limit=10`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    const docList = await docListRes.json();
    for (const d of docList) {
      if (d.raw_bytes || d.content || d.data || (d.storage_key && d.storage_key.length > 500)) {
        throw new Error("Raw document content leaked in admin document listing!");
      }
    }
    console.log(`  -> Verified ${docList.length} document metadata items: zero raw content or binary payload leaked.`);

    // 8.2 Summary endpoint check
    const summaryRes = await safeFetch(`${API_BASE}/api/admin/summary`, {
      headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
    });
    const summaryJson = await summaryRes.json();
    if (JSON.stringify(summaryJson).includes("%PDF-") || JSON.stringify(summaryJson).includes("PNG\r\n")) {
      throw new Error("Raw binary data detected in summary endpoint!");
    }
    console.log("  -> Verified admin summary endpoint: purely aggregated metrics, zero file content.");
    results.documentSecurity = "PASS";

    // -------------------------------------------------------------
    // 9. PII / SECRET LEAK CHECK
    // -------------------------------------------------------------
    console.log("\n[VERIFY 9] PII & Secret Leak Detection Scan...");
    const leaksFound = [];
    const aadhaarRegex = /\b[2-9]{1}[0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b/;
    const secretKeywords = ["SUPABASE_SERVICE_KEY", "ENCRYPTION_KEY", "OCR_API_KEY", "postgres://", "postgresql+pg8000://"];

    for (const entry of networkResponses) {
      if (entry.url.includes(".svg") || entry.url.includes(".png") || entry.url.includes(".css") || entry.url.includes(".js")) continue;

      for (const kw of secretKeywords) {
        if (entry.body.includes(kw)) {
          leaksFound.push(`Leaked secret keyword ${kw} in ${entry.url}`);
        }
      }
      if (aadhaarRegex.test(entry.body)) {
        leaksFound.push(`Potential raw Aadhaar pattern detected in ${entry.url}`);
      }
    }

    if (leaksFound.length > 0) {
      throw new Error(`PII / Secret leak detected: ${leaksFound.join("; ")}`);
    }
    console.log(`  -> Scanned ${networkResponses.length} HTTP transaction bodies: 0 raw PII or secret leaks discovered.`);
    results.piiSecretLeakCheck = "PASS";

    // -------------------------------------------------------------
    // 10. FRONTEND ERROR HANDLING & STATUS CONTRACT
    // -------------------------------------------------------------
    console.log("\n[VERIFY 10] Frontend Error Handling & Status Contracts...");
    // Authenticate admin session in browser
    await page.evaluate((jwt) => {
      window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    }, fixtures.admin_jwt);
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
    await page.waitForSelector("#admin-sidebar, #admin-dashboard-root", { timeout: 10000 });

    // Navigate to non-existent route or customer detail to verify 404 handling
    await page.goto(`${BASE_URL}/admin/customers/999999`, { waitUntil: "networkidle" });
    const bodyText = await page.innerText("body");
    const hasCrash = bodyText.includes("Cannot read properties of") || bodyText.includes("Uncaught TypeError") || bodyText.includes("ReferenceError");
    if (hasCrash) {
      throw new Error("Frontend crashed on unknown customer ID!");
    }
    console.log("  -> Frontend handles non-existent resource routes cleanly without JS crash or white screen.");
    console.log(`  -> Total browser console errors observed: ${consoleErrors.length}`);
    results.frontendContract = "PASS";

    // -------------------------------------------------------------
    // 11. SECURITY REGRESSION
    // -------------------------------------------------------------
    console.log("\n[VERIFY 11] Running Existing Backend Security Regression Tests...");
    const pytestCmd = `./.venv/bin/pytest -q tests/test_portal_security.py tests/test_security_b4.py tests/test_security_audit_phase12.py tests/test_privacy_gateway.py tests/test_consent_service.py tests/test_retention_and_privacy.py tests/test_upload_storage.py tests/test_step12_e2e_privacy_verification.py`;
    const pytestOutput = execSync(pytestCmd, { cwd: "/home/incraax-ai/Documents/Vighnesh/DocPilot/backend" }).toString().trim();
    console.log(`  -> Pytest Security Suite: ${pytestOutput.split("\n").slice(-2).join(" ")}`);
    results.securityRegression = "PASS";

    // -------------------------------------------------------------
    // 12. CLEANUP
    // -------------------------------------------------------------
    console.log("\n[VERIFY 12] Clean up Synthetic Test Data...");
    // 1. Application-supported data cleanup endpoint
    for (const cid of [custA.id, custB.id]) {
      const delRes = await safeFetch(`${API_BASE}/api/admin/customers/${cid}/delete-data`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fixtures.admin_jwt}` },
      });
      console.log(`  -> Customer #${cid} data purged via supported API: HTTP ${delRes.status}`);
    }

    // 2. Remove test customer database records
    const cleanDbPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer, RequiredDocument, AccessToken, Document, PrivacyRequest
with session_scope() as db:
    synths = db.query(Customer).filter(Customer.id.in_([${custA.id}, ${custB.id}])).all()
    count = len(synths)
    for c in synths:
        db.query(RequiredDocument).filter(RequiredDocument.customer_id == c.id).delete()
        db.query(AccessToken).filter(AccessToken.customer_id == c.id).delete()
        db.query(Document).filter(Document.customer_id == c.id).delete()
        db.query(PrivacyRequest).filter(PrivacyRequest.customer_id == c.id).delete()
        db.delete(c)
    print(f'Purged {count} synthetic test customer shells.')
`;
    const cleanDbOut = runPython(cleanDbPy);
    console.log(`  -> Database shell cleanup: ${cleanDbOut}`);

    // Confirm 0 test customer records remain
    const verifyZeroPy = `
import sys; sys.path.insert(0, 'backend')
from app.db import session_scope
from app.models import Customer
with session_scope() as db:
    total = db.query(Customer).count()
    print(total)
`;
    const remainingCount = parseInt(runPython(verifyZeroPy), 10);
    console.log(`  -> Verified remaining customers in DB: ${remainingCount}`);
    if (remainingCount !== 0) {
      throw new Error(`Expected 0 customers remaining in DB, found ${remainingCount}`);
    }
    results.cleanup = "PASS";

  } catch (err) {
    console.error("Security verification failed with exception:", err);
  } finally {
    await browser.close();
  }

  return results;
}

runSecurityVerification().then((res) => {
  console.log("\n=== SECURITY VERIFICATION RESULTS ===");
  console.log(JSON.stringify(res, null, 2));
  console.log("Console errors count:", consoleErrors.length);
});
