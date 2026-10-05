import { chromium } from "@playwright/test";
import * as path from "path";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";

const MOCK_REVIEWS_OPEN = [
  {
    id: 501,
    document_id: "doc-bank-03",
    status: "open",
    priority: "high",
    created_at: new Date(Date.now() - 3600000 * 2.5).toISOString(),
    customer_id: 101,
    customer_name: "Vikram Malhotra",
    customer_code: "CUST-98214",
    reason: "Name on statement appears as 'V. Malhotra' vs customer profile 'Vikram Malhotra'",
    flags: ["name_mismatch", "unclear_stamp"],
    decided_by: null,
    decided_at: null,
    note: null,
    ocr_evidence: {
      confidence: 0.78,
      extracted_fields: {
        "Account Holder Name": "V. Malhotra",
        "Bank Name": "HDFC Bank Ltd.",
        "Account Number": "•••• •••• 4812",
        "Statement Period": "01-Jul-2026 to 30-Sep-2026",
        "IFSC Code": "HDFC0001234",
        "Branch": "Bandra Kurla Complex, Mumbai",
        "Average Balance": "₹3,45,200.00",
        "Closing Balance": "₹4,25,890.00",
        "Tamper Detection": "PASS",
        "Document Authenticity Score": "0.89 / 1.00",
      },
    },
    document: {
      id: "doc-bank-03",
      doc_type: "bank_statement",
      label: "Bank Statement",
      filename: "hdfc_bank_statement_q3.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "manual_review",
      uploaded_at: new Date(Date.now() - 3600000 * 3).toISOString(),
      review_reason: "Name on statement appears as 'V. Malhotra' vs customer profile 'Vikram Malhotra'",
      flags: ["name_mismatch", "unclear_stamp"],
      confidence: 0.78,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
      case_status: "in_progress",
      ocr_masked_data: {
        "Account Holder Name": "V. Malhotra",
        "Bank Name": "HDFC Bank Ltd.",
        "Account Number": "•••• •••• 4812",
        "Statement Period": "01-Jul-2026 to 30-Sep-2026",
        "IFSC Code": "HDFC0001234",
        "Branch": "Bandra Kurla Complex, Mumbai",
        "Average Balance": "₹3,45,200.00",
        "Closing Balance": "₹4,25,890.00",
        "Tamper Detection": "PASS",
        "Document Authenticity Score": "0.89 / 1.00",
      },
    },
  },
  {
    id: 502,
    document_id: "doc-salary-04",
    status: "open",
    priority: "medium",
    created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    customer_id: 102,
    customer_name: "Priya Sharma",
    customer_code: "CUST-48192",
    reason: "Net pay figure partially obscured by corporate stamp watermark",
    flags: ["low_confidence", "watermark_obstruction"],
    decided_by: null,
    decided_at: null,
    note: null,
    ocr_evidence: {
      confidence: 0.64,
      extracted_fields: {
        "Employee Name": "Priya Sharma",
        "Employer": "TechCorp Global Solutions Pvt Ltd",
        "Designation": "Senior Systems Engineer",
        "Pay Period": "August 2026",
        "Gross Pay": "₹1,85,000.00",
        "Net Deductions": "₹32,450.00",
        "Net Disbursed": "₹1,52,550.00 (Unverified)",
        "PAN": "•••••••891P",
      },
    },
    document: {
      id: "doc-salary-04",
      doc_type: "salary_slip",
      label: "Salary Slip",
      filename: "techcorp_paystub_aug2026.png",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "manual_review",
      uploaded_at: new Date(Date.now() - 3600000 * 6.5).toISOString(),
      review_reason: "Net pay figure partially obscured by corporate stamp watermark",
      flags: ["low_confidence", "watermark_obstruction"],
      confidence: 0.64,
      customer_id: 102,
      customer_name: "Priya Sharma",
      customer_code: "CUST-48192",
      customer_email: "priya.sharma@example.com",
      case_status: "in_progress",
      ocr_masked_data: {
        "Employee Name": "Priya Sharma",
        "Employer": "TechCorp Global Solutions Pvt Ltd",
        "Designation": "Senior Systems Engineer",
        "Pay Period": "August 2026",
        "Gross Pay": "₹1,85,000.00",
        "Net Deductions": "₹32,450.00",
        "Net Disbursed": "₹1,52,550.00 (Unverified)",
        "PAN": "•••••••891P",
      },
    },
  },
];

const MOCK_REVIEWS_RESOLVED = [
  {
    id: 489,
    document_id: "doc-aadhaar-02",
    status: "approved",
    priority: "low",
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    customer_id: 101,
    customer_name: "Vikram Malhotra",
    customer_code: "CUST-98214",
    reason: "Pincode mismatch flagged automatically",
    flags: ["address_check"],
    decided_by: "vighneshpote.info@gmail.com",
    decided_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    note: "Verified residential address matches Aadhaar record cross-referenced with utility bill.",
    ocr_evidence: {
      confidence: 0.94,
      extracted_fields: {
        "Aadhaar Number": "•••• •••• 1290",
        "Full Name": "Vikram Malhotra",
        "DOB": "15/08/1988",
        "Gender": "Male",
        "Address": "•••••••••••• Mumbai 400051",
      },
    },
    document: {
      id: "doc-aadhaar-02",
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      filename: "aadhaar_front_card.pdf",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 25).toISOString(),
      review_reason: "Pincode mismatch flagged automatically",
      flags: ["address_check"],
      confidence: 0.94,
      customer_id: 101,
      customer_name: "Vikram Malhotra",
      customer_code: "CUST-98214",
      customer_email: "vikram.malhotra@example.com",
      case_status: "in_progress",
      ocr_masked_data: {
        "Aadhaar Number": "•••• •••• 1290",
        "Full Name": "Vikram Malhotra",
        "DOB": "15/08/1988",
        "Gender": "Male",
        "Address": "•••••••••••• Mumbai 400051",
      },
    },
  },
  {
    id: 488,
    document_id: "doc-pan-01-old",
    status: "rejected",
    priority: "high",
    created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
    customer_id: 103,
    customer_name: "Rohan Varma",
    customer_code: "CUST-31054",
    reason: "Image resolution below minimum threshold; severe motion blur",
    flags: ["face_blur", "unreadable_text"],
    decided_by: "vighneshpote.info@gmail.com",
    decided_at: new Date(Date.now() - 3600000 * 46).toISOString(),
    note: "Image excessively blurred; signature band and permanent account number unreadable.",
    ocr_evidence: {
      confidence: 0.42,
      extracted_fields: {
        "PAN Number": "•••••••••• (Unreadable)",
        "Cardholder Name": "Rohan V••••",
        "Date of Birth": "••••••••",
      },
    },
    document: {
      id: "doc-pan-01-old",
      doc_type: "pan",
      label: "PAN Card",
      filename: "pan_card_blurry.jpg",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "rejected",
      uploaded_at: new Date(Date.now() - 3600000 * 49).toISOString(),
      review_reason: "Image resolution below minimum threshold; severe motion blur",
      flags: ["face_blur", "unreadable_text"],
      confidence: 0.42,
      customer_id: 103,
      customer_name: "Rohan Varma",
      customer_code: "CUST-31054",
      customer_email: "rohan.varma@example.com",
      case_status: "in_progress",
      ocr_masked_data: {
        "PAN Number": "•••••••••• (Unreadable)",
        "Cardholder Name": "Rohan V••••",
        "Date of Birth": "••••••••",
      },
    },
  },
];

async function run() {
  console.log("=== Starting Phase 5 Manual Review UI Playwright Verification ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();

  let reviewsData = [...MOCK_REVIEWS_OPEN];

  // Intercept Admin Summary
  await page.route(/\/api\/admin\/summary/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { in_progress: 2, completed: 1 },
        open_reviews: reviewsData.filter((r) => r.status === "open").length,
        jobs: { queued: 0, running: 0, failed: 0 },
        metrics: {
          total_customers: 4,
          completed_customers: 1,
          completion_rate: 25.0,
          total_documents: 6,
          verified_documents: 3,
          pending_review_documents: reviewsData.filter((r) => r.status === "open").length,
          processing_documents: 0,
          ocr_failures: 0,
        },
      }),
    });
  });

  // Intercept Admin Customers list for other views
  await page.route(/\/api\/admin\/customers/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: 101,
          code: "CUST-98214",
          name: "Vikram Malhotra",
          email: "vikram.malhotra@example.com",
          mobile: "+91 98765 43210",
          consent_status: "granted",
          case_status: "in_progress",
          created_at: new Date().toISOString(),
          required_count: 4,
          received_count: 2,
          pending_count: 2,
          allow_download: true,
        },
      ]),
    });
  });

  // Intercept Admin Audit
  await page.route(/\/api\/admin\/audit/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // Intercept Admin Reviews
  await page.route(/\/api\/admin\/reviews/, async (route) => {
    const request = route.request();
    const url = request.url();

    // Check for approve
    if (url.includes("/approve")) {
      const match = url.match(/\/reviews\/(\d+)\/approve/);
      const reviewId = match ? parseInt(match[1]) : 501;
      const review = reviewsData.find((r) => r.id === reviewId);
      if (review) {
        review.status = "approved";
        review.decided_by = "vighneshpote.info@gmail.com";
        review.decided_at = new Date().toISOString();
        if (review.document) {
          review.document.verification_status = "verified";
        }
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: `Review ${reviewId} approved`, status: "verified" }),
      });
    }

    // Check for reject
    if (url.includes("/reject")) {
      const match = url.match(/\/reviews\/(\d+)\/reject/);
      const reviewId = match ? parseInt(match[1]) : 501;
      const review = reviewsData.find((r) => r.id === reviewId);
      if (review) {
        review.status = "rejected";
        review.decided_by = "vighneshpote.info@gmail.com";
        review.decided_at = new Date().toISOString();
        if (review.document) {
          review.document.verification_status = "rejected";
        }
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: `Review ${reviewId} rejected`, status: "rejected" }),
      });
    }

    // GET /api/admin/reviews?status=...
    const urlObj = new URL(url);
    const statusQuery = urlObj.searchParams.get("status") || "open";

    let filtered = [];
    if (statusQuery === "all") {
      filtered = [...reviewsData, ...MOCK_REVIEWS_RESOLVED];
    } else if (statusQuery === "approved") {
      filtered = MOCK_REVIEWS_RESOLVED.filter((r) => r.status === "approved");
    } else if (statusQuery === "rejected") {
      filtered = MOCK_REVIEWS_RESOLVED.filter((r) => r.status === "rejected");
    } else {
      // open
      filtered = reviewsData.filter((r) => r.status === "open");
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(filtered),
    });
  });

  // Intercept Document File streaming
  await page.route(/\/api\/admin\/documents\/.*\/file/, async (route) => {
    const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900" viewBox="0 0 700 900">
      <rect width="700" height="900" fill="#0b1329" rx="16"/>
      <rect x="24" y="24" width="652" height="852" fill="#0f1b38" stroke="#3b82f6" stroke-width="2" rx="12"/>
      
      <!-- Bank Header -->
      <rect x="50" y="50" width="600" height="70" fill="#1e3a8a" rx="8"/>
      <text x="75" y="92" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="bold">HDFC BANK LIMITED</text>
      <text x="75" y="110" fill="#93c5fd" font-family="sans-serif" font-size="12">ACCOUNT STATEMENT • PRIVATE &amp; CONFIDENTIAL</text>

      <!-- Account Info -->
      <rect x="50" y="140" width="600" height="120" fill="#132246" stroke="#1e293b" rx="8"/>
      <text x="70" y="170" fill="#94a3b8" font-family="sans-serif" font-size="12">ACCOUNT HOLDER</text>
      <text x="70" y="195" fill="#f8fafc" font-family="sans-serif" font-size="16" font-weight="bold">V. MALHOTRA</text>
      <text x="70" y="220" fill="#f59e0b" font-family="sans-serif" font-size="12">⚠️ FLAG: Discrepancy with Customer Profile "Vikram Malhotra"</text>

      <text x="350" y="170" fill="#94a3b8" font-family="sans-serif" font-size="12">ACCOUNT NUMBER</text>
      <text x="350" y="195" fill="#38bdf8" font-family="monospace" font-size="15">•••• •••• 4812</text>
      <text x="350" y="220" fill="#94a3b8" font-family="sans-serif" font-size="12">IFSC: HDFC0001234 • BANDRA WEST</text>

      <!-- Transactions sample table -->
      <rect x="50" y="280" width="600" height="340" fill="#132246" stroke="#1e293b" rx="8"/>
      <text x="70" y="310" fill="#ffffff" font-family="sans-serif" font-size="14" font-weight="bold">Recent Transactions (Redacted Sample)</text>
      <line x1="50" y1="325" x2="650" y2="325" stroke="#334155" stroke-width="1"/>
      
      <text x="70" y="355" fill="#94a3b8" font-family="sans-serif" font-size="13">01-Sep-2026</text>
      <text x="170" y="355" fill="#cbd5e1" font-family="sans-serif" font-size="13">SALARY CREDIT - TECHCORP</text>
      <text x="520" y="355" fill="#10b981" font-family="monospace" font-size="13">+₹1,52,550.00</text>

      <text x="70" y="395" fill="#94a3b8" font-family="sans-serif" font-size="13">05-Sep-2026</text>
      <text x="170" y="395" fill="#cbd5e1" font-family="sans-serif" font-size="13">MUTUAL FUND SIP - HDFC AMC</text>
      <text x="520" y="395" fill="#f43f5e" font-family="monospace" font-size="13">-₹25,000.00</text>

      <text x="70" y="435" fill="#94a3b8" font-family="sans-serif" font-size="13">12-Sep-2026</text>
      <text x="170" y="435" fill="#cbd5e1" font-family="sans-serif" font-size="13">ELECTRICITY BILL PAYMENT</text>
      <text x="520" y="435" fill="#f43f5e" font-family="monospace" font-size="13">-₹4,250.00</text>

      <text x="70" y="475" fill="#94a3b8" font-family="sans-serif" font-size="13">30-Sep-2026</text>
      <text x="170" y="475" fill="#cbd5e1" font-family="sans-serif" font-size="13">CLOSING BALANCE</text>
      <text x="520" y="475" fill="#38bdf8" font-family="monospace" font-size="14" font-weight="bold">₹4,25,890.00</text>

      <!-- Security Stamp -->
      <circle cx="560" cy="740" r="55" fill="none" stroke="#f59e0b" stroke-width="3" stroke-dasharray="6,4"/>
      <text x="520" y="735" fill="#f59e0b" font-family="sans-serif" font-size="11" font-weight="bold">AUDIT QUEUE</text>
      <text x="522" y="755" fill="#f59e0b" font-family="sans-serif" font-size="10">STAFF REVIEW</text>
      
      <!-- Footer -->
      <text x="70" y="840" fill="#64748b" font-family="sans-serif" font-size="11">STREAMED VIA DOCPILOT SECURE AES-GCM PROXY • ZERO PERSISTED CLEAR-TEXT</text>
    </svg>`;
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: Buffer.from(svgData),
    });
  });

  page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
  page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));

  // Initialize session
  await page.goto("http://localhost:5180/admin");
  await page.evaluate(() => {
    window.sessionStorage.setItem("docpilot_staff_jwt", "mock-staff-jwt-token");
    window.localStorage.setItem(
      "docpilot_admin_session",
      JSON.stringify({
        token: "mock-staff-jwt-token",
        email: "vighneshpote.info@gmail.com",
        role: "admin",
        name: "Staff Admin",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      })
    );
    window.localStorage.setItem("docpilot_admin_theme", "dark");
  });

  // Step 1: Open Admin Reviews tab
  console.log("1. Navigating to Admin Manual Review Queue...");
  await page.goto("http://localhost:5180/admin");
  await page.waitForSelector("#admin-dashboard", { timeout: 8000 });
  await page.click("#sidebar-link-reviews, #tab-btn-reviews");
  await page.waitForSelector("#admin-reviews-view", { timeout: 6000 });
  await page.waitForTimeout(600);

  // Take screenshot of Review Queue (Dark mode)
  const queueDarkPath = path.join(ARTIFACT_DIR, "admin_09_reviews_queue_dark.png");
  await page.screenshot({ path: queueDarkPath });
  console.log(`Saved screenshot: ${queueDarkPath}`);

  // Step 2: Test Search Filtering
  console.log("2. Testing Search filter in review queue...");
  const searchInput = page.locator("#reviews-search-input");
  await searchInput.fill("Vikram");
  await page.waitForTimeout(300);

  const rowCountAfterSearch = await page.locator(".review-item-row").count();
  console.log(`Rows matching 'Vikram': ${rowCountAfterSearch} (expected 1)`);
  if (rowCountAfterSearch !== 1) {
    throw new Error(`Expected 1 row after search filter, found ${rowCountAfterSearch}`);
  }
  await searchInput.fill("");
  await page.waitForTimeout(300);

  // Step 3: Test Status Tabs Filtering
  console.log("3. Testing status tab switching...");
  await page.click("#tab-filter-approved");
  await page.waitForTimeout(400);
  const approvedCount = await page.locator(".review-item-row").count();
  console.log(`Approved reviews count: ${approvedCount} (expected 1)`);

  await page.click("#tab-filter-rejected");
  await page.waitForTimeout(400);
  const rejectedCount = await page.locator(".review-item-row").count();
  console.log(`Rejected reviews count: ${rejectedCount} (expected 1)`);

  // Return to open reviews
  await page.click("#tab-filter-open");
  await page.waitForTimeout(400);

  // Step 4: Open Manual Review Detail Modal on first item (Bank Statement)
  console.log("4. Opening Manual Review Detail Modal on Bank Statement...");
  const inspectBtn = page.locator("#btn-open-review-501");
  await inspectBtn.click();
  await page.waitForSelector("#manual-review-detail-modal", { timeout: 8000 });
  await page.waitForTimeout(800);

  // Verify elements in detail modal
  await page.waitForSelector("#review-viewport", { timeout: 5000 });
  await page.waitForSelector("#ocr-evidence-card", { timeout: 5000 });
  await page.waitForSelector("#reviewer-note-input", { timeout: 5000 });

  // Test zoom controls
  console.log("5. Testing embedded document viewer controls (Zoom & Rotate)...");
  await page.click("#review-zoom-in-btn");
  await page.waitForTimeout(200);
  await page.click("#review-rotate-btn");
  await page.waitForTimeout(200);

  // Capture Screenshot of Manual Review Detail Modal
  const modalDarkPath = path.join(ARTIFACT_DIR, "admin_10_manual_review_modal_dark.png");
  await page.screenshot({ path: modalDarkPath });
  console.log(`Saved screenshot: ${modalDarkPath}`);

  // Step 6: Test Approve confirmation flow
  console.log("6. Testing Approve confirmation flow...");
  const notesArea = page.locator("#reviewer-note-input");
  await notesArea.fill("Account name verified against passport and HDFC authorization mandate. Clear match.");
  await page.click("#btn-review-modal-approve");
  await page.waitForSelector("#review-confirm-dialog", { timeout: 5000 });
  await page.waitForTimeout(400);

  // Capture Screenshot of Confirmation Dialog
  const confirmPath = path.join(ARTIFACT_DIR, "admin_11_review_confirm_dialog.png");
  await page.screenshot({ path: confirmPath });
  console.log(`Saved screenshot: ${confirmPath}`);

  // Cancel approval
  await page.click("#btn-confirm-dialog-cancel");
  await page.waitForTimeout(300);

  // Step 7: Test Reject & Resubmission flow
  console.log("7. Testing Reject & Request Resubmission flow...");
  await notesArea.fill("Name mismatch on bank statement. Customer must re-upload statement with complete name or submit joint account declaration.");
  await page.click("#btn-review-modal-reject");
  await page.waitForSelector("#review-confirm-dialog", { timeout: 5000 });
  await page.waitForTimeout(300);

  // Confirm rejection
  await page.click("#confirm-decision-submit-btn");
  await page.waitForTimeout(800);

  console.log("8. Review decision executed. Checking queue update...");
  // Modal should close automatically after successful decision
  const modalClosed = (await page.locator("#manual-review-detail-modal").count()) === 0;
  console.log(`Modal closed after decision: ${modalClosed}`);

  // Step 8: Test Empty Queue Celebration State
  console.log("9. Testing Empty Queue Celebration State...");
  // Now clear all open reviews
  reviewsData = [];
  await page.click("#tab-filter-open");
  await page.waitForTimeout(500);

  await page.waitForSelector("#reviews-empty-state", { timeout: 5000 });
  const emptyStatePath = path.join(ARTIFACT_DIR, "admin_12_reviews_queue_empty.png");
  await page.screenshot({ path: emptyStatePath });
  console.log(`Saved screenshot: ${emptyStatePath}`);

  // Step 9: Test Light Mode Theme
  console.log("10. Testing Light Mode on Manual Review Queue...");
  // Restore reviews data for light mode capture
  reviewsData = [...MOCK_REVIEWS_OPEN];
  await page.click("#tab-filter-open");
  await page.waitForTimeout(300);

  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(500);

  const queueLightPath = path.join(ARTIFACT_DIR, "admin_13_reviews_queue_light.png");
  await page.screenshot({ path: queueLightPath });
  console.log(`Saved screenshot: ${queueLightPath}`);

  // Restore dark theme
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(300);

  console.log("=== Phase 5 Manual Review UI Verification Succeeded! ===");
  await browser.close();
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
