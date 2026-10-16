import { chromium } from 'playwright';
import { injectAxe } from 'axe-playwright';

export async function crawlSite(startUrl: string) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const allResults: { url: string; violations: any[] }[] = [];

  const parsedBase = new URL(startUrl);

  while (queue.length > 0) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;

    console.log(`\n🔍 Crawling and auditing: ${currentUrl}`);
    visited.add(currentUrl);

    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
      
      // Inject and evaluate axe-core
      await injectAxe(page);
      const results = await page.evaluate(async () => {
        // @ts-ignore
        return await window.axe.run();
      });

      allResults.push({ url: currentUrl, violations: results.violations });
      console.log(`   Found ${results.violations.length} violations.`);

      // Discover internal page links
      const links = await page.$$eval('a[href]', (elements) =>
        elements.map((el) => (el as HTMLAnchorElement).href)
      );

      for (const link of links) {
        try {
          const linkUrl = new URL(link, currentUrl);
          if (
            linkUrl.origin === parsedBase.origin &&
            !visited.has(linkUrl.href) &&
            !queue.includes(linkUrl.href)
          ) {
            queue.push(linkUrl.href);
          }
        } catch (e) {
          // Ignore invalid URLs
        }
      }
    } catch (error) {
      console.error(`❌ Failed to process ${currentUrl}:`, error);
    }
  }

  await browser.close();
  return allResults;
}