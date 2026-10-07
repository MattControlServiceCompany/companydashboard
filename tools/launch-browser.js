// launch-browser.js — the ONE shared headless launcher for tests: bundled Playwright Chromium (never Edge),
// unique C:\Temp profile per run. The launcher owns the profile: ctx.close() closes the browser and then
// deletes the profile dir, so a test only has to call close() in try/finally. Do not build profiles elsewhere.
const fs = require('fs');
const { chromium } = require('playwright');

async function launchBrowser(task, opts) {
  // CH_GATE_TAG (set by scripts/regression-gate.js) goes first so the gate can find and delete only its own leaks.
  const dir = 'C:/Temp/' + (process.env.CH_GATE_TAG ? process.env.CH_GATE_TAG + '-' : '') + task + '-profile-' + Date.now() + '-' + process.pid;
  const ctx = await chromium.launchPersistentContext(
    dir,
    Object.assign({ headless: true, args: ['--disable-gpu'], viewport: { width: 1920, height: 1080 } }, opts),
  );
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    try {
      await close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
  return ctx;
}

module.exports = { launchBrowser };
