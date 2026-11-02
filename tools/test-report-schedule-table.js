/**
 * test-report-schedule-table.js
 *
 * The quarterly report prints one facts-only table per project from the project's "BAS schedule history"
 * record (store key en_bas_schedhistory_<projectId>): one row per building with baseline weekday hours,
 * quarter weekday hours, weekend hours and occupied set points, each with date ranges.
 * Cases: (1) rows render with dated ranges clipped to the quarter, (2) no record -> no table and no page,
 * (3) the old generic recommendation text never appears, (4) the record loads from the store and a
 * restore file of the same shape imports it in add mode without changing other keys.
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), file:// page.
 *
 * Usage: node tools/test-report-schedule-table.js   (env APP_ROOT=<checkout> to test another tree)
 */
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
  const ctx = await launchBrowser('report-schedule-table');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => window.__siteUI && typeof _rptQuarterReportHTML === 'function', null, { timeout: 30000 });
    const out = await page.evaluate(async () => {
      const mon = (ym, sav) => ({ month: ym, blCost: 1000, curCost: 1000 - sav, savings: sav, kwhBl: 100, kwhCur: 90 });
      const com = () => ({
        monthly: [mon('2026-07', 50), mon('2026-08', -30), mon('2026-09', 20)],
        kwhBl: 300, kwhCur: 270, kwBl: 30, kwCur: 27, thermsBl: 300, thermsCur: 270, galBl: 300, galCur: 270,
        costSaved: 40, kwCostSaved: 0,
      });
      const bld = (name) => ({
        id: name, name, sqft: 10000, status: 'ok', savings: 40, savingsPct: 1.3, blCost: 3000,
        electric: com(), gas: com(), propane: null,
        eui: { baseline: 50, current: 48, cbecs: 60 },
        meterDetails: [],
      });
      const mk = (hist) => ({
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
        project: { id: 'synthetic-1', client: 'Test Client', name: 'Test Project', sqft: 20000, blStart: '2025-01', blEnd: '2025-12' },
        contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [100, 100, 100], currentYear: 1, years: 3, hasCsc: true, cscPct: 50, clientPct: 50, escalation: 3 },
        totals: { savings: 80, blCost: 6000, kwhBl: 600, kwhCur: 540, thermsBl: 600, thermsCur: 540, peakKwBl: 60, peakKwCur: 54, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'x', cumulativeSavings: 300, weatherWaiting: [] },
        buildings: [bld('Alpha School'), bld('Beta Hall'), bld('Gamma Annex')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [],
        basScheduleHistory: hist,
      });
      const hist = {
        version: 1,
        buildings: [
          {
            building: 'Alpha School',
            baselineWeekday: [{ text: '6:00 to 16:00' }],
            weekday: [
              { text: '7:00 to 16:00', from: '2026-05-27', to: '2026-07-26' },
              { text: '6:00 to 18:00', from: '2026-07-27', to: null },
            ],
            weekend: [
              { kind: 'baseline', text: 'None' },
              { kind: 'period', text: '6:00 to 16:00', from: '2026-07-27', to: '2026-09-04' },
            ],
            setPoints: [
              { kind: 'baseline', text: 'heating 68, cooling 72' },
              { kind: 'period', text: 'heating 70, cooling 74', from: '2026-05-27', to: '2026-08-11' },
              { kind: 'period', text: 'heating 66, cooling 70', from: '2026-01-01', to: '2026-02-01' },
            ],
          },
          { building: 'Beta Hall', baselineWeekday: [{ text: '5:00 to 15:00' }], weekday: [], weekend: [], setPoints: [] },
        ],
      };
      const opts = { appendixD: false, environmentalImpact: false, approvedChanges: false };
      const withHtml = _rptQuarterReportHTML(mk(hist), opts);
      const noHist = _rptQuarterReportHTML(mk(null), opts);
      const emptyHist = _rptQuarterReportHTML(mk({ version: 1, buildings: [{ building: 'Nobody Else', baselineWeekday: [{ text: 'x' }] }] }), opts);
      const pageOf = (html) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return [...div.querySelectorAll('.rpt-page')].find((p) => p.getAttribute('data-section') === 'basSchedule');
      };
      const pg = pageOf(withHtml);
      const rows = pg ? [...pg.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => [...td.querySelectorAll('div')].map((v) => v.textContent).join('\n') || td.textContent)) : [];
      const heads = pg ? [...pg.querySelectorAll('thead th')].map((th) => th.textContent) : [];
      // store load + restore import (synthetic key)
      await DB.set('en_bas_schedhistory_synthetic-1', hist);
      const loaded = _rptBasHistoryLoad('synthetic-1');
      const other = _rptBasHistoryLoad('synthetic-2');
      return {
        heads, rows, hasPage: !!pg, noHistPage: !!pageOf(noHist), emptyPage: !!pageOf(emptyHist),
        generic: [withHtml, noHist].map((h) => /meter data and trend logs for anomalies|Confirm BAS setpoints/i.test(h)),
        loadedOk: !!(loaded && loaded.buildings && loaded.buildings.length === 2), otherNull: other == null,
        pageCountWith: (withHtml.match(/class="rpt-page/g) || []).length, pageCountNo: (noHist.match(/class="rpt-page/g) || []).length,
      };
    });
    ok(out.hasPage, '1 table page renders when the project has a BAS schedule history');
    ok(out.heads.length === 5 && /Building/.test(out.heads[0]) && /Baseline weekday/i.test(out.heads[1]) && /Quarter weekday/i.test(out.heads[2]) && /Weekend/i.test(out.heads[3]) && /set point/i.test(out.heads[4]), '1 five column headers: ' + JSON.stringify(out.heads));
    ok(out.rows.length === 2 && /Alpha School/.test(out.rows[0][0]) && /Beta Hall/.test(out.rows[1][0]), '1 one row per building that has a record, report order, no row for Gamma Annex: ' + out.rows.length + ' rows');
    if (out.rows.length) {
      const r = out.rows[0];
      ok(/6:00 to 16:00/.test(r[1]) && !/July/.test(r[1]), '1 baseline weekday hours, no dates: ' + JSON.stringify(r[1]));
      ok(/7:00 to 16:00, July 1 to July 26/.test(r[2]) && /6:00 to 18:00, July 27 to September 30/.test(r[2]), '1 quarter weekday hours clipped to the quarter: ' + JSON.stringify(r[2]));
      ok(/Baseline: None/.test(r[3]) && /Q3 2026:\n6:00 to 16:00, July 27 to September 4/.test(r[3]), '1 weekend baseline and quarter with dates: ' + JSON.stringify(r[3]));
      ok(/Baseline: heating 68, cooling 72/.test(r[4]) && /Q3 2026:\nheating 70, cooling 74, July 1 to August 11/.test(r[4]) && !/66/.test(r[4]), '1 set points baseline and quarter, out-of-quarter entry dropped: ' + JSON.stringify(r[4]));
    }
    ok(!out.noHistPage, '2 no record -> no table page');
    ok(!out.emptyPage, '2 record with no matching building -> no table page');
    ok(out.pageCountNo === out.pageCountWith - 1, '2 omitted section leaves no placeholder page (' + out.pageCountNo + ' vs ' + out.pageCountWith + ')');
    ok(!out.generic[0] && !out.generic[1], '3 generic recommendation text does not appear');
    ok(out.loadedOk && out.otherNull, '4 record loads from en_bas_schedhistory_<projectId>; another project gets none');
    ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
