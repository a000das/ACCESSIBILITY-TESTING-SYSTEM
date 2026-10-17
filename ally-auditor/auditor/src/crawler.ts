import type { BrowserContext, Page } from "playwright";

export interface PageInfo {
  page: Page;
  url: string;
  title: string;
  depth: number;
}

export interface CrawlOptions {
  context: BrowserContext;
  startUrl: string;
  maxPages?: number;
  maxDepth?: number;
  /** Called while each page is loaded. Run axe, take screenshots, etc. here. */
  onPage?: (info: PageInfo) => Promise<void>;
}

export interface CrawledPage {
  url: string;
  depth: number;
  title: string;
  status: number | null;
  error?: string;
}

const SKIP_EXTENSIONS =
  /\.(pdf|zip|gz|png|jpe?g|gif|svg|webp|ico|mp4|mp3|css|js|json|xml|docx?|xlsx?|pptx?)$/i;

/** Strip hashes and tracking params so the same page isn't visited twice. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid" || key === "gclid") {
        u.searchParams.delete(key);
      }
    }
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function isCrawlable(url: string, origin: string): boolean {
  const u = new URL(url);
  return u.origin === origin && !SKIP_EXTENSIONS.test(u.pathname);
}

/** Optional: seed the queue from /sitemap.xml if the site has one. */
async function readSitemap(context: BrowserContext, origin: string): Promise<string[]> {
  try {
    const res = await context.request.get(`${origin}/sitemap.xml`, { timeout: 5000 });
    if (!res.ok()) return [];
    const xml = await res.text();
    const urls: string[] = [];
    for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const raw = match[1];
      if (!raw) continue;
      const normalized = normalizeUrl(raw);
      if (normalized && isCrawlable(normalized, origin)) urls.push(normalized);
    }
    return urls;
  } catch {
    return [];
  }
}

export async function crawl(options: CrawlOptions): Promise<CrawledPage[]> {
  const { context, maxPages = 50, maxDepth = 3, onPage } = options;

  const start = normalizeUrl(options.startUrl);
  if (!start) throw new Error(`Invalid start URL: ${options.startUrl}`);
  const origin = new URL(start).origin;

  const visited = new Set<string>();
  const queued = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const results: CrawledPage[] = [];

  for (const url of await readSitemap(context, origin)) {
    if (!queued.has(url)) {
      queued.add(url);
      queue.push({ url, depth: 0 });
    }
  }

  const page = await context.newPage();

  try {
    while (queue.length > 0 && results.length < maxPages) {
      const { url, depth } = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const response = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
        const status = response?.status() ?? null;

        // Handle redirects, e.g. /about.html -> /about
        const finalUrl = normalizeUrl(page.url()) ?? url;
        if (finalUrl !== url) {
          if (visited.has(finalUrl) || new URL(finalUrl).origin !== origin) continue;
          visited.add(finalUrl);
        }

        const contentType = response?.headers()["content-type"] ?? "";
        if (status !== null && status >= 400) {
          results.push({ url: finalUrl, depth, title: "", status, error: `HTTP ${status}` });
          continue;
        }
        if (!contentType.includes("text/html")) continue;

        const title = await page.title();

        // Collect links before onPage, in case the callback changes the page.
        if (depth < maxDepth) {
          const hrefs = await page.$$eval("a[href]", (els) =>
            els.map((el) => (el as HTMLAnchorElement).href),
          );
          for (const href of hrefs) {
            const next = normalizeUrl(href, finalUrl);
            if (next && isCrawlable(next, origin) && !queued.has(next)) {
              queued.add(next);
              queue.push({ url: next, depth: depth + 1 });
            }
          }
        }

        await onPage?.({ page, url: finalUrl, title, depth });
        results.push({ url: finalUrl, depth, title, status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  ! Failed on ${url}: ${message}`);
        results.push({ url, depth, title: "", status: null, error: message });
      }
    }
  } finally {
    await page.close();
  }

  return results;
}