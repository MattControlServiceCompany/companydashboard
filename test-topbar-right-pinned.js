// Real-browser test (synthetic data, headless, file://): the initials button and the bell sit in the top-right
// corner of the header on every page (Home, PDF/OCR, Utility Data, an open project), at 1920/1280/640.
// Run: node test-topbar-right-pinned.js [shots-dir]   (Chromium always; Firefox when installed)
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000444;
const SEED = {
  en_projects: [{ id: PID, name: 'SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
  ch_settings: { showQuickStart: false }, ch_theme: 'dark', ch_activeView: 'home',
  ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
};
let pass = 0, fail = 0;
async function run(label, ctx, shotsDir) {
  const page = await ctx.newPage();
  await page.addInitScript((d) => { for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k])); }, SEED);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(SITE);
  await page.waitForTimeout(2500);
  const pages = [
    ['home', () => sv('home')], ['pdf', () => sv('pdf')], ['utility', () => sv('utility')],
    ['project', (pid) => { sv('projects'); openDetail(pid); }],
  ];
  for (const [name, fn] of pages) {
    await page.evaluate(fn, PID);
    await page.waitForTimeout(800);
    for (const w of [1920, 1280, 640]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
        const u = r('topUser'), b = r('notifBtn');
        return { vw: document.documentElement.clientWidth, uR: u && u.right, bR: b && b.right, uW: u && u.width };
      });
      const gapB = m.vw - m.bR, ok = m.bR != null && gapB >= 0 && gapB <= 24 && m.uR <= m.bR;
      if (ok) pass++; else { fail++; console.log('FAIL ' + label + ' ' + name + '@' + w + ' ' + JSON.stringify(m)); }
      if (w === 1920 && shotsDir && label === 'chromium') {
        await page.screenshot({ path: path.join(shotsDir, 'topbar-' + name + '-1920.png'), clip: { x: 0, y: 0, width: 1920, height: 110 } });
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
  }
  await page.close();
}
(async () => {
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const ctx = await launchBrowser('topbar-right');
  try { await run('chromium', ctx, shots); } finally { await ctx.close(); }
  let ff;
  try { ff = require('playwright').firefox; if (!fs.existsSync(ff.executablePath())) ff = null; } catch (e) { ff = null; }
  if (ff) {
    const dir = 'C:/Temp/topbar-right-ff-profile-' + Date.now() + '-' + process.pid;
    const c2 = await ff.launchPersistentContext(dir, { headless: true, viewport: { width: 1920, height: 1080 } });
    try { await run('firefox', c2, shots); } finally { await c2.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
  } else console.log('NOTE firefox not installed for playwright; skipped');
  console.log(fail ? 'FAILED ' + fail + ' (passed ' + pass + ')' : 'PASS ' + pass);
  process.exit(fail ? 1 : 0);
})();
