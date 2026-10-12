// Real-browser test (synthetic data, headless bundled Chromium, file://): the sidebar "Projects" button must show the
// project list even when a project is open (any tab, or after a visit to Home). A reload inside a project re-opens it.
// Run: node test-sidebar-projects-shows-list.js [screenshot.png]
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000444;
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
const view = () =>
  document.getElementById('projListView').style.display !== 'none' &&
  document.getElementById('projDetailView').style.display === 'none'
    ? 'list'
    : document.getElementById('projDetailView').style.display === 'flex'
      ? 'detail'
      : 'other';
const sess = () => JSON.parse(sessionStorage.getItem('ch_proj') || '{}').view;
(async () => {
  const ctx = await launchBrowser('sbproj', { viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await ctx.addInitScript(
      (data) => {
        if (window.localStorage.getItem('en_projects')) return; // seed once; a reload keeps the test state
        for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
        window.localStorage.setItem('ch_activeView', 'projects'); // plain string, as sv() stores it
      },
      {
        en_projects: [
          {
            id: PID,
            name: 'SYNTHETIC',
            client: 'S',
            addr: '',
            type: 'Test',
            status: 'active',
            phase: '',
            contacts: [],
            savingsData: { measures: [] },
          },
        ],
        ch_qs_seen: 1,
        ch_theme: 'dark',
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      },
    );
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    const clickSb = () => page.evaluate(() => document.querySelector('#sb-proj-btn .s-proj-toggle').click());
    // 1. project open on several tabs: sidebar Projects shows the list
    for (const tab of ['dashboard', 'contacts', 'savings']) {
      await page.evaluate(
        (a) => {
          openDetail(a.pid);
          const b = document.querySelector('.pdt[data-tab="' + a.tab + '"]');
          if (b) sPTab(a.tab, b);
        },
        { pid: PID, tab },
      );
      eq(await page.evaluate(view), 'detail', tab + ': project open');
      await clickSb();
      eq(await page.evaluate(view), 'list', tab + ': sidebar Projects shows list');
      eq(await page.evaluate(sess), 'list', tab + ': ch_proj.view is list');
    }
    // 2. Home then Projects
    await page.evaluate((pid) => openDetail(pid), PID);
    await page.evaluate(() => document.querySelector('[onclick^="sv(\'home\'"]').click());
    await clickSb();
    eq(await page.evaluate(view), 'list', 'home then Projects: list');
    eq(await page.evaluate(sess), 'list', 'home then Projects: ch_proj.view is list');
    // 3. reload inside a project re-opens it
    await page.evaluate((pid) => openDetail(pid), PID);
    await page.reload();
    await page.waitForTimeout(2500);
    eq(await page.evaluate(view), 'detail', 'reload in project: project re-opened');
    // 4. New Energy Project form: the address field label says "Project Address" (not "Building Address")
    await page.evaluate(() => openProjModal());
    const lbl = await page.evaluate(() => document.getElementById('mp-addr').parentElement.querySelector('label').textContent.trim());
    eq(lbl, 'Project Address', 'new project form address label');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    eq(errs.length, 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log('sidebar-projects-shows-list: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
