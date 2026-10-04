import { execSync } from "child_process";

const TEST_SUITES = [
  { phase: "Phase 1", file: "scripts/verify_dashboard.mjs", desc: "Admin Dashboard Overview, Theme & Sidebar" },
  { phase: "Phase 2", file: "scripts/verify_phase2_customers.mjs", desc: "Customer Intake, Presets & Excel Bulk Import" },
  { phase: "Phase 3", file: "scripts/verify_phase3_customer_detail.mjs", desc: "Customer Detail, Document Inspection & Viewer" },
  { phase: "Phase 4", file: "scripts/verify_phase4_customer_portal.mjs", desc: "Customer Landing, Consent, Upload & Resubmit" },
  { phase: "Phase 5", file: "scripts/verify_phase5_manual_review.mjs", desc: "Compliance Review Queue, Zoom/Rotate & Approvals" },
  { phase: "Phase 6", file: "scripts/verify_phase6_privacy.mjs", desc: "Privacy Rights, Token Enclave, Consent Revoke & Purge" },
  { phase: "Phase 7", file: "scripts/verify_phase7_reminders.mjs", desc: "Notification Center, 3/7/14-Day Lifecycle Stepper" },
  { phase: "Phase 8", file: "scripts/verify_phase8_retention.mjs", desc: "Statutory Retention, Countdown, Manual Purge & Audit" },
  { phase: "Phase 9", file: "scripts/verify_phase9_reports.mjs", desc: "Analytics Dashboard, 8 KPIs, Trends & Donut Charts" },
  { phase: "Phase 10", file: "scripts/verify_phase10_settings.mjs", desc: "System Settings, Health Probes, Zero Secret Leaks" },
  { phase: "Phase 11", file: "scripts/verify_phase11_ux_a11y.mjs", desc: "Final UX Polish, WCAG AA Contrast, Skip Links & A11y" },
];

console.log("======================================================================");
console.log("       DocPilot Phase 12: Automated Release Verification Runner       ");
console.log("======================================================================\n");

const results = [];
let allPassed = true;

for (const test of TEST_SUITES) {
  const startTime = Date.now();
  process.stdout.write(`Running ${test.phase}: ${test.desc}... `);
  try {
    execSync(`node ${test.file}`, {
      stdio: "pipe",
      timeout: 60000,
      env: { ...process.env, PATH: process.env.PATH },
    });
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ PASSED (${duration}s)`);
    results.push({ ...test, status: "PASSED", duration: `${duration}s` });
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✗ FAILED (${duration}s)`);
    console.error(err.stdout ? err.stdout.toString() : err.message);
    results.push({ ...test, status: "FAILED", duration: `${duration}s`, error: err.message });
    allPassed = false;
  }
}

console.log("\n======================================================================");
console.log("                      Final Verification Summary                      ");
console.log("======================================================================");
console.table(results, ["phase", "desc", "status", "duration"]);

if (allPassed) {
  console.log("\n>>> ALL 11 PHASE REGRESSION TESTS PASSED! APPLICATION IS RELEASE READY! <<<\n");
  process.exit(0);
} else {
  console.error("\n>>> VERIFICATION FAILED: ONE OR MORE TESTS FAILED! <<<\n");
  process.exit(1);
}
