// launch-browser.js — shared headless launcher: bundled Playwright Chromium (never Edge),
// unique C:\Temp profile per run. Caller must close the returned context in try/finally.
const { chromium } = require('playwright');

function launchBrowser(task) {
  return chromium.launchPersistentContext('C:\\Temp\\' + task + '-profile-' + Date.now(), {
    headless: true,
    args: ['--disable-gpu'],
    viewport: { width: 1920, height: 1080 },
  });
}

module.exports = { launchBrowser };
