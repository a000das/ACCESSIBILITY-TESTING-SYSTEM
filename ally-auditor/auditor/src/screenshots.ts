import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { Dilemma } from "./dilemmas.js";

export interface CapturedDilemma extends Dilemma {
  elementShot: string | null; // tight crop of just the element
  contextShot: string | null; // the element plus surrounding page, for the vision model
  imageHash: string | null; // identical images share a hash, so we only pay to analyse them once
}

/** "http://localhost:3000/blog/post-1" -> "blog-post-1" */
export function pageSlug(url: string): string {
  const u = new URL(url);
  const slug = (u.pathname + u.search).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "home";
}

const CONTEXT_PADDING = 80;

export async function captureDilemmas(
  page: Page,
  dilemmas: Dilemma[],
  outDir = "screenshots"
): Promise<CapturedDilemma[]> {
  const dir = path.join(outDir, pageSlug(page.url()));
  await mkdir(dir, { recursive: true });

  const captured: CapturedDilemma[] = [];

  for (const [index, dilemma] of dilemmas.entries()) {
    const base = `${String(index + 1).padStart(2, "0")}-${dilemma.type}`;
    let elementShot: string | null = null;
    let contextShot: string | null = null;
    let imageHash: string | null = null;

    try {
      const element = page.locator(dilemma.locator).first();
      await element.scrollIntoViewIfNeeded({ timeout: 3000 });

      const elementBuffer = await element.screenshot({ timeout: 5000 });
      elementShot = path.join(dir, `${base}.png`);
      await writeFile(elementShot, elementBuffer);
      imageHash = createHash("sha256").update(elementBuffer).digest("hex");

      // Wider crop: the vision model judges much better with surrounding context.
      const box = await element.boundingBox();
      if (box) {
        const scroll = await page.evaluate(() => {
          if (!(window as any).__name) 
          {
          (window as any).__name = (fn: any) => fn;
          }
          return { x: window.scrollX, y: window.scrollY };
        });
        const contextBuffer = await page.screenshot({
          fullPage: true,
          clip: {
            x: Math.max(0, box.x + scroll.x - CONTEXT_PADDING),
            y: Math.max(0, box.y + scroll.y - CONTEXT_PADDING),
            width: box.width + CONTEXT_PADDING * 2,
            height: box.height + CONTEXT_PADDING * 2,
          },
        });
        contextShot = path.join(dir, `${base}-context.png`);
        await writeFile(contextShot, contextBuffer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.warn(`    ! screenshot failed for ${dilemma.selector}: ${message}`);
    }

    captured.push({ ...dilemma, elementShot, contextShot, imageHash });
  }

  return captured;
}