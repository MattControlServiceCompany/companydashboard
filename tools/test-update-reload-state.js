// Real-browser test (synthetic data, headless bundled Chromium, file://): item bd22df0d.
// A signed-in user is on a project tab and sub-tab. A new version is found. The page reloads by itself
// (the real _reloadForNewVersionWhenSafe path). After the reload:
//   - no login screen is shown (also not during the load),
//   - no What's New dialog opens (the new version is announced by a toast; the sidebar button still opens it),
//   - the same page, project, main tab and sub-tab are open.
// A fresh visit (no update reload) still shows What's New, as today.
// Run: node tools/test-update-reload-state.js [screenshot.png]   (CH_TMP_ROOT must be set)
const { launchBrowser } = require('./launch-browser.js');
const path = require('path');
const SITE = 'file:///' + path.join(__dirname, '..').split(path.sep).join('/') + '/energy-department.html';
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
  const ctx = await launchBrowser('update-reload', { viewport: { width: 1400, height: 900 } });
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
        if (window.localStorage.getItem('__seeded')) return; // seed once
        window.localStorage.setItem('__seeded', '1');
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
    // 0. fresh visit: What's New opens as today
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    const fresh = await page.evaluate(state);
    eq(fresh.whatsNewOpen, true, 'fresh visit: What\'s New opens as today');
    await page.getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    // 1. open the synthetic project, Equipment Matrix tab, Set Points sub-tab
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'), 'setpoints');
    }, PID);
    await page.waitForTimeout(800);
    const before = await page.evaluate(state);
    eq([before.view, before.detail, before.proj, before.tab, before.sub], ['view-projects', true, PID, 'eq-matrix', 'setpoints'], 'before update: project, tab, sub-tab');
    // 2. a new version is live: use the real auto-update path and wait for the reload
    await page.evaluate(() => localStorage.setItem('ch_seen_version', 'v0.0.0.0')); // user has not read the new notes
    // While the user looks at the page, no reload happens.
    const stayed = await page.evaluate(() => {
      _chPendingVer = 'v9999.01.01.1';
      _reloadForNewVersionWhenSafe();
      return !sessionStorage.getItem('ch_update_reload');
    });
    eq(stayed, true, 'no reload while the user is on the page');
    // The user leaves (another program takes focus): the reload runs then.
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await nav;
    await page.waitForTimeout(3500);
    const after = await page.evaluate(state);
    const frames = await page.evaluate(() => window.__loginFrames);
    eq(after.loginShown, false, 'after update reload: no login screen');
    eq(frames, 0, 'after update reload: no frame drawn with the login screen (' + frames + ')');
    eq(after.whatsNewOpen, false, 'after update reload: What\'s New dialog is not open');
    eq(/[Uu]pdated|new version|What's New/.test(after.toast), true, 'after update reload: the new version is announced by a toast (' + after.toast + ')');
    eq([after.view, after.detail, after.proj, after.tab, after.tabActive, after.sub], ['view-projects', true, PID, 'eq-matrix', 'eq-matrix', 'setpoints'], 'after update reload: same page, project, tab, sub-tab');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    // 3. the sidebar button still opens What's New
    await page.evaluate(() => window.__siteUI.openReleaseNotes());
    eq(await page.evaluate(() => !!document.querySelector('.rn-overlay.open')), true, 'manual open of What\'s New works');
    await page.getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    // 4. a plain reload now (no update): no dialog (version seen), same place
    await page.reload();
    await page.waitForTimeout(2500);
    const plain = await page.evaluate(state);
    eq([plain.detail, plain.proj, plain.tab, plain.sub, plain.whatsNewOpen], [true, PID, 'eq-matrix', 'setpoints', false], 'plain reload: same place, dialog closed');
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
