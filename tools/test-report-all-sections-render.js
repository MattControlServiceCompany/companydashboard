// tools/test-report-all-sections-render.js - the quarterly report prints a page for every checked section of REPORT_SECTIONS,
// in the order of the table, and an unchecked section prints no page. SYNTHETIC data, headless bundled Chromium.
// Run: CH_TMP_ROOT=<scratch> node tools/test-report-all-sections-render.js
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
  const ctx = await launchBrowser('report-all-sections');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptQuarterReportHTML === 'function' && typeof REPORT_SECTIONS !== 'undefined', null, { timeout: 30000 });
    const res = await page.evaluate(() => {
      const yms = ['2026-07', '2026-08', '2026-09'];
      const mon = (ym, sav) => ({ month: ym, bl: 1000, cur: 1100, blCost: 900, curCost: 800, savings: sav, kwhBl: 1000, kwhCur: 1100, kwBl: 10, kwCur: 11 });
      const com = (k) => ({
        monthly: yms.map((ym, i) => mon(ym, 10 + i)),
        kwhBl: 3000, kwhCur: 3300, kwBl: 30, kwCur: 33, thermsBl: 3000, thermsCur: 3300, galBl: 3000, galCur: 3300,
        costBl: 2700, costCur: 2400, costSaved: 33, kwCostSaved: 3,
      });
      const bld = (name) => ({
        id: name, name, sqft: 100000, status: 'on_track', savings: 33, savingsPct: 3, blCost: 8100, curCost: 7200, type: 'K-12 School',
        commodities: ['Electric', 'Gas', 'Propane'],
        electric: com(), gas: com(), propane: com(),
        eui: { baseline: 41.1, current: 31.1, cbecs: 48.5 }, euiQ: { baseline: 10, current: 11 },
        euiWindow: { first: '2026-01', last: '2026-09', months: 9 }, meterDetails: [], baselineMaps: { elecByMo: {}, gasByMo: {}, propaneByMo: {}, waterByMo: {} }, blMonths: [],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: yms, start: '2026-07', end: '2026-09' },
        project: { id: 'p1', client: 'Test Client', name: 'Test Project', sqft: 200000, blStart: '2025-01', blEnd: '2025-12' },
        contract: { quarterlyTargets: [1111, 1111, 1111, 1111], quarterlyActuals: [1111, 1111, 1111], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3, actualsThroughQuarter: 3 },
        totals: { savings: 99, blCost: 16200, curCost: 14400, kwhBl: 6000, kwhCur: 6600, thermsBl: 6000, thermsCur: 6600, propaneBl: 6000, propaneCur: 6600, euiBaseline: 41.1, euiCurrent: 31.1, euiBaselineQ: 10, euiCurrentQ: 11, euiPeriodLabel: 'Jan 2026 to Sep 2026', weatherWaiting: [] },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [{ bid: 'Building A', building: 'Building A', commodity: 'Electric', account: 'ZZ9', ym: '2026-07', kwh: 1100, amount: 800, kw: 11 }], approvedChanges: [{ completedDate: '2026-08-01', building: 'Building A', proposedChange: 'Set point change', approvedBy: 'Test', source: 'Change Order' }],
      };
      const on = {};
      REPORT_SECTIONS.forEach((s) => (on[s.key] = !s.defaultOff));
      const keysOf = (html) => [...html.matchAll(/data-(?:sub)?section="([^"]+)"/g)].map((m) => m[1]);
      let html;
      try {
        html = _rptQuarterReportHTML(d, on);
      } catch (e) {
        return { error: e.stack };
      }
      const keys = keysOf(html);
      const off = {};
      REPORT_SECTIONS.filter((s) => !s.sameAs && !s.defaultOff).forEach((s) => {
        const s2 = Object.assign({}, on);
        s2[s.key] = false;
        if (s.key === 'cover') s2.boardSummary = false;
        let h2;
        try {
          h2 = _rptQuarterReportHTML(d, s2);
        } catch (e) {
          off[s.key] = 'error ' + e.message;
          return;
        }
        // the section's own page is gone (the cover page also carries the Board Executive Summary row)
        off[s.key] = s.key === 'cover' ? keysOf(h2).indexOf('cover') >= 0 : keysOf(h2).indexOf(s.key) >= 0;
      });
      const pageCount = (html.match(/<div class="rpt-page/g) || []).length;
      return {
        rows: REPORT_SECTIONS.map((s) => ({ key: s.key, defaultOff: !!s.defaultOff, sameAs: s.sameAs || '' })),
        keys, off, pageCount,
        fuelText: html.replace(/<[^>]+>/g, ' '),
      };
    });
    ok(!res.error, 'report builds with every section on' + (res.error ? ': ' + res.error : ''));
    if (!res.error) {
      const order = res.rows.filter((r) => !r.sameAs && !r.defaultOff).map((r) => r.key);
      order.forEach((k) => ok(res.keys.indexOf(k) >= 0, 'section "' + k + '" prints a page'));
      res.rows.filter((r) => r.sameAs).forEach((r) => ok(res.keys.indexOf(r.sameAs) >= 0, 'row "' + r.key + '" shows the page of "' + r.sameAs + '"'));
      ok(res.rows.filter((r) => r.defaultOff).every((r) => res.keys.indexOf(r.key) < 0), 'a section that is off by default prints no page');
      const first = order.map((k) => res.keys.indexOf(k));
      ok(first.every((v, i) => i === 0 || v > first[i - 1]), 'pages follow the order of the section table: ' + order.map((k, i) => k + '@' + first[i]).join(' '));
      Object.keys(res.off).forEach((k) => ok(res.off[k] === false, 'with "' + k + '" unchecked its page is gone'));
      ok(!/Baseline cost is the actual cost plus savings/.test(res.fuelText), 'no page says the baseline cost is the actual cost plus savings');
      ok(new RegExp('Electricity-Acct' + String.fromCharCode(35) + 'ZZ9').test(res.fuelText), 'a Use Detail meter is named Electricity-Acct#<account>');
      ok(/\$2,700/.test(res.fuelText), 'the baseline cost of a Use Detail row is the baseline-month cost of the building (costBl), not actual cost plus savings');
    }
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
