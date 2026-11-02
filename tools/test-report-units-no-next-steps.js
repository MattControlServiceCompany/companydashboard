/**
 * test-report-units-no-next-steps.js
 *
 * Client quarterly report rules (Matt, 2026-11-02): units print as standard symbols (kWh, kW), never spelled
 * out ("kilowatt-hours", "kilowatts", "British thermal units", "degrees Fahrenheit", "hundred cubic feet");
 * the client report has no "Next Steps" section and no generic review/trend-log advice.
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), file:// page.
 *
 * Usage: node tools/test-report-units-no-next-steps.js   (env APP_ROOT=<checkout> to test another tree)
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
  const ctx = await launchBrowser('report-units');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    const out = await page.evaluate(() => {
      const mon = (ym, sav) => ({ month: ym, blCost: 1000, curCost: 1000 - sav, savings: sav, kwhBl: 100, kwhCur: 110 });
      const com = () => ({
        monthly: [mon('2026-07', -50), mon('2026-08', -30), mon('2026-09', -20)],
        kwhBl: 300, kwhCur: 330, kwBl: 30, kwCur: 33, thermsBl: 300, thermsCur: 400, galBl: 300, galCur: 270,
        costSaved: -100, kwCostSaved: -300,
      });
      const bld = (name) => ({
        id: name, name, sqft: 10000, status: 'ok', savings: -200, savingsPct: -6, blCost: 3000,
        electric: com(), gas: com(), propane: null,
        eui: { baseline: 50, current: 48, cbecs: 60 },
        meterDetails: [{ commodity: 'Electric', account: 'A1', usagePerYear: 1000, r2: 0.9, regrCoeffs: { slopeHDD: 1, slopeCDD: 2 } }],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
        project: { client: 'Test Client', name: 'Test Project', sqft: 20000, blStart: '2024-01', blEnd: '2024-12' },
        contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [100, 100, 100], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3 },
        totals: { savings: -400, blCost: 6000, kwhBl: 600, kwhCur: 660, thermsBl: 600, thermsCur: 800, peakKwBl: 60, peakKwCur: 66, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Q3 2026', cumulativeSavings: 300, weatherWaiting: [] },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [{ ym: '2026-07', building: 'Building A', commodity: 'Electric', account: 'A1', amount: 5 }],
      };
      const html = _rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false });
      const text = html.replace(/<[^>]+>/g, ' ');
      window.__html = html;
      const wd = rptPageWoodlandCharts(7, {
        cfg: { clientSharePct: 60 },
        project: { name: 'Test Project' },
        options: [{ letter: 'A', annualGas$: 100, annualElec$: 50, annualDem$: 20, clientShare$: 100, cscShare$: 70 }],
      });
      return { text, wdText: wd.replace(/<[^>]+>/g, ' '), pages: (html.match(/class="rpt-page/g) || []).length };
    });
    const t = out.text;
    ok(/\bkWh\b/.test(t), 'report text contains "kWh"');
    ok(/\bkW\b/.test(t), 'report text contains "kW"');
    ok(!/kilowatt/i.test(t), 'report text has no "kilowatt"');
    ok(!/british thermal/i.test(t), 'report text has no "British thermal"');
    ok(!/degrees fahrenheit/i.test(t), 'report text has no "degrees Fahrenheit"');
    ok(!/hundred cubic feet/i.test(t), 'report text has no "hundred cubic feet"');
    ok(!/next steps/i.test(t), 'report text has no "Next Steps"');
    ok(!/trend logs for anomalies/i.test(t), 'report text has no "trend logs for anomalies"');
    ok(!/trend logs/i.test(t), 'report text has no "trend logs" advice');
    ok(out.wdText.length > 100 && /Savings Options Comparison/.test(out.wdText), 'savings options charts page renders');
    ok(!/next steps/i.test(out.wdText) && !/To proceed, choose Option/i.test(out.wdText), 'savings options charts page has no "Next Steps"');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
    console.log('INFO pages=' + out.pages);
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL ' + e.message);
  process.exit(1);
});
