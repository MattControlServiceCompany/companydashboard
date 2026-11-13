// Real-browser test (synthetic data, headless bundled Chromium, local HTTP server): item bd22df0d, now by frame swap.
// A signed-in user is on a project tab and sub-tab, in the frame of the update shell (energy-department.html?shell=1).
// A new version is found and the user leaves (another program has focus). The new frame takes the place of the old one
// (no reload). After the swap:
//   - no login screen is shown (also not while the new frame starts),
//   - no What's New dialog opens (the new version is announced by a toast; the sidebar button still opens it),
//   - the same page, project, main tab and sub-tab are open.
// A fresh visit (no update) still shows What's New, as today.
// Run: node tools/test-update-reload-state.js [screenshot.png]   (CH_TMP_ROOT must be set)
const { launchBrowser } = require('./launch-browser.js');
const { startServer, seed, SEED, appState, frameTools, PID } = require('./update-test-helpers.js');
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
(async () => {
  const srv = await startServer();
  const ctx = await launchBrowser('update-reload', { viewport: { width: 1400, height: 900 } });
  try {
    await ctx.addInitScript(seed, SEED);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource/.test(m.text()) && errs.push(m.text()));
    const { kids, app, waitApp, waitSwap, markOld } = frameTools(page);
    // 0. fresh visit: What's New opens as today
    await page.goto(srv.base + '/energy-department.html?shell=1');
    await waitApp();
    await page.waitForTimeout(2000);
    const fresh = await app().evaluate(appState);
    eq(fresh.whatsNewOpen, true, "fresh visit: What's New opens as today");
    await app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    // 1. open the synthetic project, Equipment Matrix tab, Set Points sub-tab
    await app().evaluate((pid) => {
      openDetail(pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'), 'setpoints');
    }, PID);
    await page.waitForTimeout(800);
    const before = await app().evaluate(appState);
    eq([before.view, before.detail, before.proj, before.tab, before.sub], ['view-projects', true, PID, 'eq-matrix', 'setpoints'], 'before update: project, tab, sub-tab');
    // 2. a new version is live: the real auto-update path
    await app().evaluate(() => localStorage.setItem('ch_seen_version', 'v0.0.0.0')); // user has not read the new notes
    await markOld();
    srv.liveVer = 'v9999.01.01.1';
    // While the user looks at the page, no swap happens (wait past the 3 s that follow a page change).
    await page.waitForTimeout(3300);
    const stayed = await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.1';
      _updateWhenSafe();
      return !sessionStorage.getItem('ch_update_reload');
    });
    eq(stayed, true, 'no swap while the user is on the page');
    eq(kids().length, 1, 'no second frame while the user is on the page');
    // The user leaves (another program takes focus): the swap runs then.
    await app().evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    eq(await waitSwap(), true, 'the user left: the new frame takes the place of the old one');
    await page.waitForTimeout(1500);
    const after = await app().evaluate(appState);
    eq(after.loginShown, false, 'after the swap: no login screen');
    eq(after.loginFrames, 0, 'after the swap: the new frame drew no frame with the login screen (' + after.loginFrames + ')');
    eq(after.whatsNewOpen, false, "after the swap: What's New dialog is not open");
    eq(/[Uu]pdated|new version|What's New/.test(after.toast), true, 'after the swap: the new version is announced by a toast (' + after.toast + ')');
    eq([after.view, after.detail, after.proj, after.tab, after.tabActive, after.sub], ['view-projects', true, PID, 'eq-matrix', 'eq-matrix', 'setpoints'], 'after the swap: same page, project, tab, sub-tab');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    // 3. the sidebar button still opens What's New
    await app().evaluate(() => window.__siteUI.openReleaseNotes());
    eq(await app().evaluate(() => !!document.querySelector('.rn-overlay.open')), true, "manual open of What's New works");
    await app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    // 4. a plain reload now (no update): no dialog (version seen), same place
    await page.reload();
    await waitApp();
    await page.waitForTimeout(2000);
    const plain = await app().evaluate(appState);
    eq([plain.detail, plain.proj, plain.tab, plain.sub, plain.whatsNewOpen], [true, PID, 'eq-matrix', 'setpoints', false], 'plain reload: same place, dialog closed');
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
    srv.server.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
