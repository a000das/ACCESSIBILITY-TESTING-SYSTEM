import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { crawl } from "./crawler.js";
import { findDilemmas } from "./dilemmas.js";
import { captureDilemmas, type CapturedDilemma } from "./screenshots.js";

// Usage: npx tsx auditor/src/scan.ts [startUrl] [--max-pages 50] [--max-depth 3]
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-pages": { type: "string", default: "50" },
    "max-depth": { type: "string", default: "3" },
  },
});

const START_URL = positionals[0] ?? "http://localhost:3000";
const MAX_PAGES = Number(values["max-pages"]);
const MAX_DEPTH = Number(values["max-depth"]);

interface NodeRecord {
  selector: string;
  html: string;
}

interface ViolationRecord {
  ruleId: string;
  impact: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: NodeRecord[];
}

interface PageResult {
  url: string;
  title: string;
  depth: number;
  violations: ViolationRecord[];
  incompleteCount: number;
  dilemmas: CapturedDilemma[];
}

async function main() {
  console.log(`\nCrawling ${START_URL} (max ${MAX_PAGES} pages, depth ${MAX_DEPTH})\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const pageResults: PageResult[] = [];
  // Right after creating your page or context:
  await context.addInitScript(() => {
  if (!(window as any).__name) {
    (window as any).__name = (fn: any) => fn;
  }
  });

  const crawled = await crawl({
    context,
    startUrl: START_URL,
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    onPage: async ({ page, url, title, depth }) => {
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze();

      const violations: ViolationRecord[] = axe.violations.map((v) => ({
        ruleId: v.id,
        impact: v.impact ?? "unknown",
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes.map((n) => ({ selector: n.target.join(" "), html: n.html })),
      }));

      // Must run after axe: it tags elements in the DOM so screenshots can find them again.
      const dilemmas = await captureDilemmas(page, await findDilemmas(page, axe.incomplete));

      pageResults.push({ url, title, depth, violations, incompleteCount: axe.incomplete.length, dilemmas });

      console.log(`> ${url}  (depth ${depth})  "${title}"`);
      console.log(`  ${violations.length} violations, ${axe.incomplete.length} need review`);
      for (const v of violations) {
        console.log(`  [${v.impact.toUpperCase()}] ${v.ruleId}: ${v.help}`);
        for (const node of v.nodes) console.log(`      ${node.selector}`);
      }
      if (dilemmas.length > 0) {
        console.log(`  ${dilemmas.length} flagged for visual review:`);
        for (const d of dilemmas) {
          console.log(`  ? [${d.type}] ${d.selector}`);
          console.log(`      ${d.reason}`);
          if (d.elementShot) console.log(`      screenshot: ${d.elementShot}`);
        }
      }
      console.log("");
    },
  });

  await browser.close();

  // Summary
  const byImpact: Record<string, number> = {};
  let total = 0;
  for (const p of pageResults) {
    for (const v of p.violations) {
      byImpact[v.impact] = (byImpact[v.impact] ?? 0) + v.nodes.length;
      total += v.nodes.length;
    }
  }
  const failed = crawled.filter((c) => c.error);

  console.log("----------------------------------------");
  console.log(`Pages scanned : ${pageResults.length}`);
  console.log(`Pages failed  : ${failed.length}`);
  console.log(`Flagged for visual review: ${pageResults.reduce((sum, p) => sum + p.dilemmas.length, 0)}`);
  console.log(`Affected elements: ${total}`);
  for (const level of ["critical", "serious", "moderate", "minor"]) {
    console.log(`  ${level.padEnd(9)} ${byImpact[level] ?? 0}`);
  }

  // Save results as JSON (this becomes the input for Postgres in Step 3)
  await mkdir("reports", { recursive: true });
  const outPath = "reports/latest-scan.json";
  await writeFile(
    outPath,
    JSON.stringify({ startedAt: new Date().toISOString(), startUrl: START_URL, pages: pageResults }, null, 2),
  );
  console.log(`\nSaved: ${outPath}\n`);
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});