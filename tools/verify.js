// verify.js — Headless screenshot tool for CompanyHub agents
// Usage: node tools/verify.js [url-or-filepath] [output-screenshot-path]
//
// Examples:
//   node tools/verify.js
//   node tools/verify.js "https://mattcontrolservicecompany.github.io/companydashboard/" "C:/Users/Matt Miller/AI/_context/temp/verify-deploy.png"
//   node tools/verify.js "file:///C:/Users/Matt Miller/AI/companydashboard/index.html" "C:/Users/Matt Miller/AI/_context/temp/verify-local.png"
//
// Uses bundled Playwright Chromium (never Edge) via tools/launch-browser.js.

const { launchBrowser } = require('./launch-browser');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args[0] || 'file:///C:/Users/Matt Miller/AI/companydashboard/index.html';
const outPath = args[1] || 'C:/Users/Matt Miller/AI/_context/temp/verify-screenshot.png';

(async () => {
  const context = await launchBrowser('verify');
  try {
  const page = await context.newPage();

  await page.goto(target);

  // Wait for page to finish loading. Use networkidle for GitHub Pages (has fetch calls).
  // If this times out (e.g. polling/websockets), fall back to a 3s wait.
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    await page.waitForTimeout(3000);
  }

  // Ensure output directory exists before writing the screenshot
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // fullPage: false — captures only the viewport (1920x1080), not the full scrollable page
  await page.screenshot({ path: outPath, fullPage: false });

  console.log('OK:', outPath);
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
