import fs from 'fs';

try {
  const rawData = fs.readFileSync('reports/latest-scan.json', 'utf8');
  const report = JSON.parse(rawData);

  console.log('====================================');
  console.log('   ACCESSIBILITY REPORT SUMMARY     ');
  console.log('====================================');

  // Adjust keys based on your latest-scan.json structure
  const pagesScanned = report.pagesScanned || report.summary?.pagesScanned || 2;
  const critical = report.summary?.critical || 0;
  const serious = report.summary?.serious || 0;

  console.log(`Pages Scanned: ${pagesScanned}`);
  console.log(`Critical Violations: ${critical}`);
  console.log(`Serious Violations: ${serious}`);

  if (critical > 0) {
    console.error('\n❌ BUILD FAILED: Critical accessibility violations found!');
    process.exit(1);
  } else {
    console.log('\n✅ BUILD PASSED: No critical accessibility violations.');
    process.exit(0);
  }
} catch (err) {
  console.error('Error reading report file:', err.message);
  process.exit(1);
}