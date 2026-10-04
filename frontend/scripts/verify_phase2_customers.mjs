import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

const ARTIFACT_DIR = "/home/incraax-ai/.gemini/antigravity-ide/brain/935b26c1-5432-42a5-9645-3e8c7c6b91a9";
const fixtures = JSON.parse(
  fs.readFileSync(new URL("../e2e/test_fixtures.json", import.meta.url), "utf-8")
);

const MOCK_CUSTOMERS = [
  {
    id: 101,
    code: "CUST-98214",
    name: "Vikram Malhotra",
    email: "vikram.malhotra@example.com",
    mobile: "+91 98765 43210",
    consent_status: "granted",
    case_status: "in_progress",
    required_count: 3,
    received_count: 2,
    pending_count: 1,
    created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
  },
  {
    id: 102,
    code: "CUST-98215",
    name: "Priya Sharma",
    email: "priya.sharma@example.com",
    mobile: "+91 98123 45678",
    consent_status: "granted",
    case_status: "completed",
    required_count: 4,
    received_count: 4,
    pending_count: 0,
    created_at: new Date(Date.now() - 3600000 * 96).toISOString(),
    completed_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    delete_after: new Date(Date.now() + 3600000 * 24 * 6).toISOString(),
    data_deleted_at: null,
  },
  {
    id: 103,
    code: "CUST-98216",
    name: "Apex Enterprises (Ramesh Patel)",
    email: "ramesh@apexenterprises.in",
    mobile: "+91 99000 11222",
    consent_status: "pending",
    case_status: "in_progress",
    required_count: 4,
    received_count: 0,
    pending_count: 4,
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    completed_at: null,
    delete_after: null,
    data_deleted_at: null,
  },
  {
    id: 104,
    code: "CUST-98217",
    name: "Ananya Deshmukh",
    email: "ananya.d@fintech.co",
    mobile: "+91 97777 88888",
    consent_status: "granted",
    case_status: "expired",
    required_count: 2,
    received_count: 1,
    pending_count: 1,
    created_at: new Date(Date.now() - 3600000 * 24 * 32).toISOString(),
    completed_at: null,
    delete_after: null,
    data_deleted_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
  },
];

const MOCK_DETAIL_101 = {
  id: 101,
  code: "CUST-98214",
  name: "Vikram Malhotra",
  email: "vikram.malhotra@example.com",
  mobile: "+91 98765 43210",
  consent_status: "granted",
  case_status: "in_progress",
  created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
  completed_at: null,
  delete_after: null,
  data_deleted_at: null,
  required_count: 3,
  received_count: 2,
  pending_count: 1,
  allow_download: false,
  required: [
    { doc_type: "pan", label: "PAN Card", state: "verified", document_id: "doc-101-pan" },
    { doc_type: "aadhaar", label: "Aadhaar Card", state: "verified", document_id: "doc-101-aadhaar" },
    { doc_type: "bank_statement", label: "Bank Statement", state: "pending_upload", document_id: null },
  ],
  documents: [
    {
      id: "doc-101-pan",
      doc_type: "pan",
      label: "PAN Card",
      filename: "pan_card_vikram.png",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 40).toISOString(),
      review_reason: null,
      superseded: false,
    },
    {
      id: "doc-101-aadhaar",
      doc_type: "aadhaar",
      label: "Aadhaar Card",
      filename: "aadhaar_front.jpg",
      file_state: "stored",
      ocr_status: "completed",
      verification_status: "verified",
      uploaded_at: new Date(Date.now() - 3600000 * 36).toISOString(),
      review_reason: null,
      superseded: false,
    },
  ],
};

async function run() {
  console.log("=== Starting Phase 2 Customers & Intake Verification ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Mock API routes to ensure deterministic rendering with real data models
  await page.route(/\/api\/admin\/customers/, async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === "GET") {
      if (url.includes("/api/admin/customers/101")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DETAIL_101),
        });
      }
      return route.fulfill({
        status: 200,
        headers: { "X-Total-Count": String(MOCK_CUSTOMERS.length) },
        contentType: "application/json",
        body: JSON.stringify(MOCK_CUSTOMERS),
      });
    }

    if (method === "POST") {
      const postData = route.request().postDataJSON();
      const newCust = {
        id: 105,
        code: `CUST-${Math.floor(10000 + Math.random() * 90000)}`,
        name: postData.name,
        email: postData.email,
        mobile: postData.mobile || null,
        consent_status: postData.send_consent ? "pending" : "granted",
        case_status: "in_progress",
        required_count: postData.required_documents?.length || 1,
        received_count: 0,
        pending_count: postData.required_documents?.length || 1,
        created_at: new Date().toISOString(),
      };
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(newCust),
      });
    }

    route.continue();
  });

  await page.route("**/api/admin/summary", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { in_progress: 2, completed: 1, expired: 1 },
        open_reviews: 2,
        jobs: { queued: 0, running: 1, failed: 0 },
        metrics: {
          total_customers: 4,
          completed_customers: 1,
          completion_rate: 25.0,
          total_documents: 8,
          verified_documents: 6,
          pending_review_documents: 2,
          processing_documents: 0,
          ocr_failures: 0,
        },
      }),
    });
  });

  // 1. Navigate to /admin/customers
  console.log("1. Navigating to http://localhost:5180/admin/customers...");
  await page.goto("http://localhost:5180/admin/customers");

  // Inject staff JWT
  await page.evaluate((jwt) => {
    window.sessionStorage.setItem("docpilot_staff_jwt", jwt);
    window.sessionStorage.setItem("jwt", jwt);
  }, fixtures.admin_jwt);

  // Reload to activate session
  await page.reload();
  await page.waitForSelector("#admin-dashboard", { timeout: 15000 });
  await page.waitForSelector(".customers-data-table", { timeout: 15000 });
  console.log("Customers Directory loaded with customer records!");

  await page.waitForTimeout(600);

  // Screenshot 1: Customers Directory (Dark Mode)
  const dirDarkPath = path.join(ARTIFACT_DIR, "phase2_customers_directory_dark.png");
  await page.screenshot({ path: dirDarkPath, fullPage: true });
  console.log(`Saved screenshot: ${dirDarkPath}`);

  // 2. Open Customer Detail Slide-Over Drawer
  console.log("2. Testing Customer Detail Slide-Over Drawer...");
  const firstRow = page.locator(".customer-table-row").first();
  await firstRow.click();
  await page.waitForSelector("#customer-detail-drawer", { timeout: 5000 });
  await page.waitForTimeout(600);

  // Screenshot 2: Customer Detail Drawer
  const detailDrawerPath = path.join(ARTIFACT_DIR, "phase2_customer_detail_drawer.png");
  await page.screenshot({ path: detailDrawerPath });
  console.log(`Saved screenshot: ${detailDrawerPath}`);

  // Close drawer
  await page.locator("#customer-detail-drawer .drawer-close-btn").click();
  await page.waitForTimeout(400);

  // 3. Open Add Customer Slide-Over Drawer
  console.log("3. Testing Add Customer Drawer...");
  const addBtn = page.locator("#btn-add-customer");
  await addBtn.click();
  await page.waitForSelector("#add-customer-drawer", { timeout: 5000 });
  await page.waitForTimeout(400);

  // Fill in sample data
  await page.locator("#new-cust-name").fill("Rohan Singhania");
  await page.locator("#new-cust-email").fill("rohan.s@singhaniagroup.in");
  await page.locator("#new-cust-mobile").fill("+91 98222 33445");

  // Click preset "Salaried Individual"
  const salariedPreset = page.locator(".preset-chip", { hasText: "Salaried Individual" });
  if (await salariedPreset.isVisible()) {
    await salariedPreset.click();
    console.log("Applied 'Salaried Individual' preset");
  }
  await page.waitForTimeout(400);

  // Screenshot 3: Add Customer Drawer
  const addDrawerPath = path.join(ARTIFACT_DIR, "phase2_add_customer_drawer.png");
  await page.screenshot({ path: addDrawerPath });
  console.log(`Saved screenshot: ${addDrawerPath}`);

  // Close drawer
  await page.locator(".drawer-close-btn").click();
  await page.waitForTimeout(400);

  // 4. Open Bulk Excel Import Modal
  console.log("4. Testing Bulk Excel Import Modal...");
  const importBtn = page.locator("#btn-open-bulk-import");
  await importBtn.click();
  await page.waitForSelector("#bulk-import-modal", { timeout: 5000 });
  await page.waitForTimeout(500);

  // Screenshot 4: Bulk Import Dropzone / Step 1
  const importUploadPath = path.join(ARTIFACT_DIR, "phase2_bulk_import_upload_step.png");
  await page.screenshot({ path: importUploadPath });
  console.log(`Saved screenshot: ${importUploadPath}`);

  // Generate a test .xlsx file with valid, duplicate, and invalid rows
  const testWb = XLSX.utils.book_new();
  const testRows = [
    {
      "Full Name": "Aditi Sharma",
      "Email Address": "aditi.sharma.test@example.com",
      "Mobile Number": "+91 98765 43210",
      "Required Documents": "pan, aadhaar, bank_statement",
      "Send Consent Email": "Yes",
    },
    {
      "Full Name": "Kavita Rao",
      "Email Address": "kavita.rao.test@example.com",
      "Mobile Number": "+91 98123 45678",
      "Required Documents": "pan, gst_certificate, udyam",
      "Send Consent Email": "Yes",
    },
    {
      "Full Name": "Aditi Duplicate Entry",
      "Email Address": "aditi.sharma.test@example.com", // duplicate in file
      "Mobile Number": "+91 98765 43210",
      "Required Documents": "pan",
      "Send Consent Email": "No",
    },
    {
      "Full Name": "Bad Email User",
      "Email Address": "invalid-email-format", // invalid email
      "Mobile Number": "+91 99000 11111",
      "Required Documents": "pan",
      "Send Consent Email": "Yes",
    },
    {
      "Full Name": "", // missing name
      "Email Address": "missingname@example.com",
      "Mobile Number": "",
      "Required Documents": "pan",
      "Send Consent Email": "Yes",
    },
  ];
  const testWs = XLSX.utils.json_to_sheet(testRows);
  XLSX.utils.book_append_sheet(testWb, testWs, "Customers");

  const tempFilePath = path.join(ARTIFACT_DIR, "test_intake_preview.xlsx");
  XLSX.writeFile(testWb, tempFilePath);

  // Upload test .xlsx file to input
  const fileInput = page.locator("#bulk-import-modal input[type='file']");
  await fileInput.setInputFiles(tempFilePath);
  console.log("Uploaded test .xlsx workbook to modal");

  // Wait for step 2 preview
  await page.waitForSelector(".bulk-preview-step", { timeout: 5000 });
  await page.waitForTimeout(600);

  // Screenshot 5: Bulk Import Preview & Validation Table
  const importPreviewPath = path.join(ARTIFACT_DIR, "phase2_bulk_import_preview_step.png");
  await page.screenshot({ path: importPreviewPath });
  console.log(`Saved screenshot: ${importPreviewPath}`);

  // Test filter tabs
  await page.locator(".preview-tab-btn", { hasText: "Ready" }).click();
  await page.waitForTimeout(300);
  await page.locator(".preview-tab-btn", { hasText: "Issues" }).click();
  await page.waitForTimeout(300);
  await page.locator(".preview-tab-btn", { hasText: "All Rows" }).click();
  await page.waitForTimeout(300);

  // Close modal
  await page.locator(".modal-close-btn").click();
  await page.waitForTimeout(400);

  // 5. Test Theme Toggle (Dark -> Light Mode)
  console.log("5. Testing Light Mode on Customers Directory...");
  await page.locator("#theme-toggle-btn").click();
  await page.waitForTimeout(500);

  // Screenshot 6: Customers Directory (Light Mode)
  const dirLightPath = path.join(ARTIFACT_DIR, "phase2_customers_directory_light.png");
  await page.screenshot({ path: dirLightPath, fullPage: true });
  console.log(`Saved screenshot: ${dirLightPath}`);

  // Switch back to Dark-Blue
  await page.locator("#theme-toggle-btn").click();
  await page.waitForTimeout(300);

  await browser.close();
  console.log("=== Phase 2 Verification Completed Successfully! ===");
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
