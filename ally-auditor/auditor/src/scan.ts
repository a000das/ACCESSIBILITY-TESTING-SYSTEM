import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

// Usage: npx tsx auditor/src/scan.ts [url]
const TARGET_URL = process.argv[2] ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(TARGET_URL, { waitUntil: "networkidle" });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();

  console.log(`\nScanned: ${TARGET_URL}`);
  console.log(`Violations: ${results.violations.length}`);
  console.log(`Needs review (incomplete): ${results.incomplete.length}\n`);

  for (const violation of results.violations) {
    const impact = (violation.impact ?? "unknown").toUpperCase();
    console.log(`[${impact}] ${violation.id}: ${violation.help}`);
    for (const node of violation.nodes) {
      console.log(`   selector: ${node.target.join(" ")}`);
    }
    console.log(`   docs: ${violation.helpUrl}\n`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});