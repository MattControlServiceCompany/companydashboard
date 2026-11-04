// launch-browser.js — the ONE shared headless launcher for tests: bundled Playwright Chromium (never Edge),
// unique profile per run inside CH_TMP_ROOT (tools/tmp-root.js). The launcher owns the profile: ctx.close() closes the browser and then
// deletes the profile dir, so a test only has to call close() in try/finally. Do not build profiles elsewhere.
const { chromium } = require('playwright');
const { profilePath, rmTmp } = require('./tmp-root.js');

async function launchBrowser(task, opts) {
  const dir = profilePath(task);
  const ctx = await chromium.launchPersistentContext(
    dir,
    Object.assign({ headless: true, args: ['--disable-gpu'], viewport: { width: 1920, height: 1080 } }, opts),
  );
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    try {
      await close();
    } finally {
      rmTmp(dir);
    }
  };
  return ctx;
}

module.exports = { launchBrowser };
