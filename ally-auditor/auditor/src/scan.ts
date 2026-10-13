import { crawlSite } from './crawler';

async function main() {
  const targetUrl = process.argv[2] || 'http://localhost:3000/';
  console.log(`🚀 Starting automated accessibility crawl from: ${targetUrl}`);

  const scanReports = await crawlSite(targetUrl);

  console.log('\n========================================');
  console.log('📊 CRAWL & AUDIT SUMMARY REPORT');
  console.log('========================================');
  
  for (const report of scanReports) {
    console.log(`\nPage: ${report.url}`);
    console.log(`Total Violations: ${report.violations.length}`);
    report.violations.forEach((v) => {
      console.log(` - [${v.impact}] ${v.id}: ${v.description}`);
    });
  }
}

main().catch(console.error);