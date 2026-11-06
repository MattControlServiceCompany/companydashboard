// tools/test-report-observations-one-page.js — the Observations page breaks only when its content does not fit.
// Run: CH_TMP_ROOT=<scratch> node tools/test-report-observations-one-page.js
// Builds the Observations page from SYNTHETIC buildings in headless bundled Chromium (the page height is measured in
// the DOM). Seven short building paragraphs plus Weather must stay on ONE page; forty must go to more pages and every
// page body must stay inside the quarterly body budget.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
(async () => {
  const ctx = await launchBrowser('report-observations-one-page');
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof rptPageObservations === 'function' && typeof rptPage === 'function', null, { timeout: 30000 });
    const res = await page.evaluate(() => {
      const mk = (count) => {
        const buildings = [];
        for (let i = 0; i < count; i++)
          buildings.push({ name: 'Test Building ' + (i + 1), sqft: 10000, commodities: ['Electric'], electric: { costSaved: -100 }, totals: { savings: -100, baselineCost: 5000, actualCost: 5100, pct: -2 }, savings: -100, baselineCost: 5000, actualCost: 5100, kind: 'building' });
        return {
          period: { type: 'quarterly', year: 2026, quarter: 3, label: 'Q3 2026' },
          project: { client: 'Test District' },
          buildings,
          totals: { savings: -100 * count },
          contract: { quarterlyTargets: [1, 1, 1000, 1], annualTarget: 4000 },
          weather: { hdd: 0, cdd: 100, baseHdd: 0, baseCdd: 90 },
        };
      };
      const out = {};
      [7, 40].forEach((c) => {
        const r = rptPageObservations(1, mk(c));
        const host = document.createElement('div');
        host.innerHTML = r.html;
        out[c] = { pages: r.pageCount, weatherOnLast: /Weather/.test(host.querySelectorAll('.rpt-page')[r.pageCount - 1].textContent), budget: RPT_Q_PAGE_BODY_PX };
      });
      return out;
    });
    console.log(JSON.stringify(res));
    ok(res[7].pages === 1, '7 short building paragraphs and the Weather paragraph stay on one Observations page');
    ok(res[7].weatherOnLast && res[40].weatherOnLast, 'Weather is on the last Observations page');
    ok(res[40].pages > 1, '40 buildings go to more than one page');
  } finally {
    await ctx.close();
  }
  if (fails) process.exit(1);
})();
