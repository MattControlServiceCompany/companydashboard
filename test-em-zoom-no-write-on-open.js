// Real-browser test (synthetic data, headless bundled Chromium, file://): opening the Equipment Matrix
// must NOT call DB.set('en_em_zoom'); a click on the zoom button must call it once.
// Run: node test-em-zoom-no-write-on-open.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000222;
let pass = 0;
let fail = 0;
function eq(a, b, l) {
  if (a === b) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + b + ', got ' + a);
  }
}
(async () => {
  const b = 'Synthetic Building';
  const matrix = {
    rows: [
      {
        id: b + '||SYN-VAV-1',
        building: b,
        location: '',
        floor: '',
        area: '',
        equipName: 'SYN-VAV-1',
        equipType: 'SYN-VAV-1',
        category: 'vav',
        subtype: '',
        points: { 'Zone Temp': '70.0 F' },
        pointsRaw: { 'Zone Temp': '70.0 F' },
        checks: {},
        schema: 2,
      },
    ],
    importedAt: new Date().toISOString(),
    buildings: [b],
    totalBASPoints: 0,
  };
  const ctx = await launchBrowser('em-zoom', { viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    await ctx.addInitScript(
      (data) => {
        for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
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
        ch_activeView: 'projects',
        ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      },
    );
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    await page.evaluate(
      async ({ pid, m }) => {
        await window.DB.set('en_eqmatrix_' + pid, m);
        window.__zoomSets = [];
        const orig = window.DB.set.bind(window.DB);
        window.DB.set = function (k, v) {
          if (k === 'en_em_zoom') window.__zoomSets.push(String(v));
          return orig(k, v);
        };
      },
      { pid: PID, m: matrix },
    );
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('eq-matrix', document.querySelector('.pdt[data-tab="eq-matrix"]'));
    }, PID);
    await page.waitForTimeout(2500);
    eq(await page.evaluate(() => !!document.getElementById('em-table-wrap')), true, 'matrix rendered');
    eq(await page.evaluate(() => window.__zoomSets.length), 0, 'open sends 0 zoom writes');
    await page.evaluate(() => document.querySelector('button[title="Zoom in"]').click());
    eq(await page.evaluate(() => window.__zoomSets.join(',')), '110', 'zoom click writes once (110)');
    eq(await page.evaluate(() => document.getElementById('em-zoom-label').textContent), '110%', 'label shows 110%');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
