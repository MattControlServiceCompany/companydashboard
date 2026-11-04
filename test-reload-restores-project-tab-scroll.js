// Real-browser test (synthetic data, headless bundled Chromium, file://): after a reload the user is back on the same
// project, the same project tab, and close to the same scroll position. The restore must cause no database write and
// no network request. A deleted project falls back to the normal page without an error.
// Run: node test-reload-restores-project-tab-scroll.js [screenshot.png]   (CH_TMP_ROOT must be set)
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000555;
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
  detail: document.getElementById('projDetailView').style.display === 'flex',
  proj: window._activeProjId,
  tab: window._activeProjTab,
  tabActive: document.querySelector('#pdTabBar .pdt.active')?.dataset.tab,
  scroll: Math.round(document.querySelector('#projDetailView .ptab.active')?.scrollTop || 0),
});
(async () => {
  const ctx = await launchBrowser('restore-pts', { viewport: { width: 1200, height: 500 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    const reqs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    // site-ui.js fetches itself and file:// refuses fetch: not related to this feature
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js/.test(m.text()) && errs.push(m.text()));
    // script/style/font loads from CDNs are not saves: count fetch/xhr/beacon and every non-GET
    page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && (r.method() !== 'GET' || /^(fetch|xhr|ping)$/.test(r.resourceType())) && reqs.push(r.method() + ' ' + r.url()));
    await ctx.addInitScript(
      (data) => {
        // count every DB.set / DB.setMany / DB.del call made by the page
        window.__dbWrites = [];
        let _db;
        Object.defineProperty(window, 'DB', {
          configurable: true,
          get() {
            return _db;
          },
          set(v) {
            _db = v;
            ['set', 'setMany', 'del', 'remove'].forEach((n) => {
              if (v && typeof v[n] === 'function') {
                const o = v[n].bind(v);
                v[n] = function () {
                  window.__dbWrites.push(n + ':' + String(arguments[0]));
                  return o.apply(null, arguments);
                };
              }
            });
          },
        });
        if (window.localStorage.getItem('en_projects') || window.localStorage.getItem('__seeded')) return; // seed once
        window.localStorage.setItem('__seeded', '1');
        for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
        window.localStorage.setItem('ch_activeView', 'projects');
      },
      {
        en_projects: [
          { id: PID, name: 'SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } },
        ],
        ch_settings: { showQuickStart: false },
        ch_theme: 'dark',
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      },
    );
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    // 1. open project, tab "settings" (tall), scroll
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('settings', document.querySelector('.pdt[data-tab="settings"]'));
    }, PID);
    await page.waitForTimeout(500);
    await page.evaluate(() => (document.querySelector('#projDetailView .ptab.active').scrollTop = 200));
    await page.waitForTimeout(600); // throttle window
    const before = await page.evaluate(state);
    eq([before.detail, before.proj, before.tab, before.scroll > 100], [true, PID, 'settings', true], 'before reload: project, tab, scrolled');
    // 2. reload
    reqs.length = 0;
    await page.reload();
    await page.waitForTimeout(3000);
    const after = await page.evaluate(state);
    eq([after.detail, after.proj, after.tab, after.tabActive], [true, PID, 'settings', 'settings'], 'after reload: same project and tab');
    eq(Math.abs(after.scroll - before.scroll) <= 20, true, 'after reload: scroll within 20px (' + before.scroll + ' -> ' + after.scroll + ')');
    eq(await page.evaluate(() => window.__dbWrites), [], 'restore causes zero database writes');
    eq(reqs, [], 'restore causes zero network requests');
    if (process.argv[2]) {
      await page.getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {}); // close the What's New dialog for the picture
      await page.waitForTimeout(500);
    }
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    // 3. deleted project: normal fallback, no error
    await page.evaluate(() => {
      localStorage.setItem('en_projects', '[]');
    });
    await page.evaluate(() => sessionStorage.setItem('ch_proj', JSON.stringify({ view: 'detail', projId: 424242, tab: 'settings', scroll: 200 })));
    errs.length = 0;
    await page.reload();
    await page.waitForTimeout(2500);
    const gone = await page.evaluate(() => ({
      detail: document.getElementById('projDetailView').style.display === 'flex',
      listShown: document.getElementById('projListView').style.display !== 'none',
    }));
    eq(gone.detail, false, 'deleted project: detail view not shown');
    eq(gone.listShown, true, 'deleted project: project list shown');
    // 4. bad saved tab: falls back to dashboard
    await page.evaluate(() => {
      localStorage.setItem('en_projects', JSON.stringify([{ id: 999000555, name: 'SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }]));
      sessionStorage.setItem('ch_proj', JSON.stringify({ view: 'detail', projId: 999000555, tab: 'no-such-tab', scroll: 'x' }));
    });
    await page.reload();
    await page.waitForTimeout(2500);
    const bad = await page.evaluate(state);
    eq([bad.detail, bad.proj, bad.tab], [true, PID, 'dashboard'], 'unknown tab: dashboard of the same project');
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
