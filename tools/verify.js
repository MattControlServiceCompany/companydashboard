// verify.js — Headless screenshot tool for CompanyHub agents
// Usage: node tools/verify.js [url-or-filepath] [output-screenshot-path]
//
// Examples:
//   node tools/verify.js
//   node tools/verify.js "https://mattcontrolservicecompany.github.io/companydashboard/" "C:/Users/Matt Miller/AI/_context/temp/verify-deploy.png"
//   node tools/verify.js "file:///C:/Users/Matt Miller/AI/companydashboard/index.html" "C:/Users/Matt Miller/AI/_context/temp/verify-local.png"
//
// Uses installed Edge (no browser download required).
// Opens in a separate user-data-dir — never touches user's open Edge windows.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args[0] || 'file:///C:/Users/Matt Miller/AI/companydashboard/index.html';
const outPath = args[1] || 'C:/Users/Matt Miller/AI/_context/temp/verify-screenshot.png';

(async () => {
  // launchPersistentContext required for user-data-dir isolation (Playwright 1.49+
  // rejects --user-data-dir passed as a launch arg; must be the first positional param here)
  const context = await chromium.launchPersistentContext('C:\\Temp\\edge-verify-profile', {
    channel: 'msedge', // uses installed Edge — no download needed
    headless: true,
    args: ['--disable-gpu'],
    viewport: { width: 1920, height: 1080 },
  });

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
  await context.close();
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
