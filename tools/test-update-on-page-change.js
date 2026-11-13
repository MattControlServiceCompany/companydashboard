// Real-browser test (synthetic data, headless bundled Chromium, local HTTP server): update on page change (Matt 2026-11-12).
// The app runs in the frame of the update shell (energy-department.html?shell=1). A new version is pending and the user
// changes page inside the site (sv() sends chViewChanged):
//   (a) safe = the new version takes the place of the old frame (swap, no reload) and the page the user went to is open; no login, no What's New;
//   (b) unsafe (edited view) = no swap;
//   (c) the internal redraw (window._chRefreshing) = no swap and no version check;
//   (d) the version check on a page change keeps the 60 s gap; a version found by that check swaps at once;
//   (e) the same version does not swap twice in one tab session.
// The swap itself, the frame-by-frame check, input during the start, away and the link: tools/test-update-frame-swap.js.
// Run: node tools/test-update-on-page-change.js [screenshot.png]   (CH_TMP_ROOT must be set)
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
  const ctx = await launchBrowser('update-on-page-change', { viewport: { width: 1400, height: 900 } });
  try {
    await ctx.addInitScript(seed, SEED);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource/.test(m.text()) && errs.push(m.text()));
    const { kids, app, waitApp, waitSwap, markOld } = frameTools(page);
    await page.goto(srv.base + '/energy-department.html?shell=1');
    await waitApp();
    await page.waitForTimeout(1500);
    await app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    await app().evaluate((pid) => {
      openDetail(pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'), 'setpoints');
    }, PID);
    await page.waitForTimeout(800);
    await markOld();
    const quiet = async (ms) => {
      await page.waitForTimeout(ms);
      return kids().length === 1 && (await app().evaluate(() => !!window.__oldFrame));
    };
    // (c) internal redraw: a pending version, chViewChanged sent while _chRefreshing = no swap
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.1';
      window._chRefreshing = true;
      sv('home');
      window._chRefreshing = false;
    });
    eq(await quiet(1500), true, '(c) internal redraw: no swap');
    // (b) unsafe: an edited view blocks the swap on a user page change
    await app().evaluate(() => {
      window.__realDirty = window.chViewIsDirty;
      window.chViewIsDirty = () => true;
      sv('projects');
    });
    eq(await quiet(1500), true, '(b) unsafe (edited view): no swap on page change');
    await app().evaluate(() => {
      window.chViewIsDirty = window.__realDirty;
      _chPendingVer = null;
    });
    // (d) check on page change keeps the 60 s gap
    const fetches = async (gapAgoMs) =>
      app().evaluate((gap) => {
        window.__fetches = 0;
        window.__origFetch = window.__origFetch || window.fetch;
        const loaded = RELEASE_NOTES[0].v;
        window.fetch = () => {
          window.__fetches++;
          return Promise.resolve({ status: 206, text: () => Promise.resolve("const CH_VERSION = '" + loaded + "';") });
        };
        _chVerLastCheck = Date.now() - gap;
        sv('utility');
        return new Promise((r) => setTimeout(() => r(window.__fetches), 400));
      }, gapAgoMs);
    eq(await fetches(10000), 0, '(d) page change 10 s after the last check: no version check');
    eq(await fetches(61000), 1, '(d) page change 61 s after the last check: one version check');
    eq(await quiet(800), true, '(d) same version found: no swap');
    // (d) a version found by the check of a page change swaps at once, on the page the user went to
    await app().evaluate(() => {
      window.fetch = window.__origFetch; // the real fetch again
      _chVerLastCheck = Date.now() - 61000;
    });
    srv.liveVer = 'v9999.01.01.2';
    await app().evaluate(() => sv('home'));
    eq(await waitSwap(), true, '(d) found by the page-change check: the new frame takes over');
    let after = await app().evaluate(appState);
    eq([after.view, after.loginShown, after.whatsNewOpen], ['view-home', false, false], "(d) the new frame is on the new page, no login, no What's New");
    eq(after.loginFrames, 0, '(d) the new frame drew no frame with the login screen');
    // (a) pending version + user page change + safe = swap, lands on the new page
    await markOld();
    await app().evaluate(() => localStorage.setItem('ch_seen_version', 'v0.0.0.0'));
    srv.liveVer = 'v9999.01.01.3';
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('utility');
    });
    eq(await waitSwap(), true, '(a) the new frame takes over on the page change');
    await page.waitForTimeout(1500);
    after = await app().evaluate(appState);
    eq([after.view, after.loginShown, after.whatsNewOpen], ['view-utility', false, false], "(a) the new frame is on the page the user went to, no login, no What's New");
    eq(after.loginFrames, 0, '(a) the new frame drew no frame with the login screen');
    eq(/[Uu]pdated|new version|What's New/.test(after.toast), true, '(a) the new version is announced by a toast (' + after.toast + ')');
    // (e) loop guard: the same version does not swap twice in one tab session
    await markOld();
    await app().evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('home');
    });
    eq(await quiet(1500), true, '(e) same version: no second swap');
    eq(await app().evaluate(() => document.querySelector('.view.active')?.id), 'view-home', '(e) the page change itself still works');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
    srv.server.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
