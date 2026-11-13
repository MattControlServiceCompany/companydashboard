// Real-browser test (synthetic data, headless bundled Chromium): update on page change (Matt 2026-11-12).
// A new version is pending and the user changes page inside the site (sv() sends chViewChanged):
//   (a) safe = the new version loads and the page the user went to is open; no login frame, no What's New dialog;
//   (b) unsafe (edited view) = no reload;
//   (c) the internal redraw (window._chRefreshing) = no reload and no version check;
//   (d) the version check on a page change keeps the 60 s gap; a version found by that check loads at once.
// Run: node tools/test-update-on-page-change.js [screenshot.png]   (CH_TMP_ROOT must be set; CH_TEST_BASE = optional http base URL)
const { launchBrowser } = require('./launch-browser.js');
const path = require('path');
const SITE = process.env.CH_TEST_BASE ? process.env.CH_TEST_BASE + '/energy-department.html' : 'file:///' + path.join(__dirname, '..').split(path.sep).join('/') + '/energy-department.html';
const PID = 999000416;
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
const state = () => ({
  view: document.querySelector('.view.active')?.id,
  detail: document.getElementById('projDetailView').style.display === 'flex',
  proj: window._activeProjId,
  tab: window._activeProjTab,
  tabActive: document.querySelector('#pdTabBar .pdt.active')?.dataset.tab,
  sub: document.querySelector('.ptab.active .ptpill.sel')?.dataset.sub,
  loginShown: getComputedStyle(document.getElementById('loginScreen')).display !== 'none',
  whatsNewOpen: !!document.querySelector('.rn-overlay.open'),
  toast: (window.__toasts || []).join('|'),
});
(async () => {
  const ctx = await launchBrowser('update-on-page-change', { viewport: { width: 1400, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js/.test(m.text()) && errs.push(m.text()));
    await ctx.addInitScript(
      (data) => {
        // frames drawn while the login screen was visible (any load)
        window.__loginFrames = 0;
        window.__toasts = [];
        document.addEventListener('DOMContentLoaded', () => {
          const m = document.getElementById('toastMsg');
          if (m) new MutationObserver(() => m.textContent && window.__toasts.push(m.textContent)).observe(m, { childList: true, characterData: true, subtree: true });
        });
        const tick = () => {
          const l = document.getElementById('loginScreen');
          if (l && getComputedStyle(l).display !== 'none') window.__loginFrames++;
          if (document.readyState !== 'complete') requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // a signed-in session (fake token; file:// never syncs, so no network call is made)
        if (!window.sessionStorage.getItem('ch_sb_session'))
          window.sessionStorage.setItem('ch_sb_session', JSON.stringify({ access_token: ['fake', 'a'].join('-'), refresh_token: ['fake', 'r'].join('-'), expires_at: 4102444800, user_id: 'u1', email: 'demo@example.com' }));
        if (window.sessionStorage.getItem('__seeded')) return; // seed once per tab (the app clears localStorage once while it moves data to IndexedDB)
        window.sessionStorage.setItem('__seeded', '1');
        for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
        window.localStorage.setItem('ch_activeView', 'projects');
      },
      {
        en_projects: [
          { id: 999000416, name: 'Alpha SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } },
        ],
        ch_settings: { showQuickStart: false },
        ch_theme: 'dark',
        ch_seen_version: 'v0.0.0.0', // an older version was seen: What's New would open on a fresh visit
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      },
    );
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    await page.getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'), 'setpoints');
    }, PID);
    await page.waitForTimeout(800);
    const marker = () => page.evaluate(() => sessionStorage.getItem('ch_update_reload'));
    // (c) internal redraw: a pending version, chViewChanged sent while _chRefreshing = no reload
    await page.evaluate(() => {
      _chPendingVer = 'v9999.01.01.1';
      window._chRefreshing = true;
      sv('home');
      window._chRefreshing = false;
    });
    await page.waitForTimeout(600);
    eq(await marker(), null, '(c) internal redraw: no reload');
    // (b) unsafe: an edited view blocks the reload on a user page change
    await page.evaluate(() => {
      window.__realDirty = window.chViewIsDirty;
      window.chViewIsDirty = () => true;
      sv('projects');
    });
    await page.waitForTimeout(600);
    eq(await marker(), null, '(b) unsafe (edited view): no reload on page change');
    await page.evaluate(() => {
      window.chViewIsDirty = window.__realDirty;
      _chPendingVer = null;
    });
    // (d) check on page change keeps the 60 s gap
    const fetches = async (gapAgoMs) =>
      page.evaluate((gap) => {
        window.__fetches = 0;
        const loaded = RELEASE_NOTES[0].v;
        window.fetch = () => {
          window.__fetches++;
          return Promise.resolve({ status: 206, text: () => Promise.resolve("const CH_VERSION = '" + (window.__liveVer || loaded) + "';") });
        };
        _chVerLastCheck = Date.now() - gap;
        sv('utility');
        return new Promise((r) => setTimeout(() => r(window.__fetches), 400));
      }, gapAgoMs);
    eq(await fetches(10000), 0, '(d) page change 10 s after the last check: no version check');
    eq(await fetches(61000), 1, '(d) page change 61 s after the last check: one version check');
    eq(await marker(), null, '(d) same version found: no reload');
    // (d) a version found by the check of a page change loads at once, on the page the user went to
    let nav = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => {
      window.__liveVer = 'v9999.01.01.2';
      _chVerLastCheck = Date.now() - 61000;
      sv('home');
    });
    await nav;
    let after = await page.evaluate(state);
    eq([after.view, after.loginShown, after.whatsNewOpen], ['view-home', false, false], '(d) found by the page-change check: reload lands on the new page, no login, no What\'s New');
    eq(await page.evaluate(() => window.__loginFrames), 0, '(d) after the reload: no frame drawn with the login screen');
    // (a) pending version + user page change + safe = reload, lands on the new page
    await page.evaluate(() => localStorage.setItem('ch_seen_version', 'v0.0.0.0'));
    nav = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('utility');
    });
    await nav;
    await page.waitForTimeout(3000);
    after = await page.evaluate(state);
    eq([after.view, after.loginShown, after.whatsNewOpen], ['view-utility', false, false], '(a) reload lands on the page the user went to, no login, no What\'s New');
    eq(await page.evaluate(() => window.__loginFrames), 0, '(a) after the reload: no frame drawn with the login screen');
    eq(/[Uu]pdated|new version|What's New/.test(after.toast), true, '(a) the new version is announced by a toast (' + after.toast + ')');
    // loop guard: the same version does not reload twice in one tab session
    await page.evaluate(() => {
      _chPendingVer = 'v9999.01.01.3';
      sv('home');
    });
    await page.waitForTimeout(800);
    eq(await page.evaluate(() => document.querySelector('.view.active')?.id), 'view-home', 'loop guard: same version, no second reload');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
