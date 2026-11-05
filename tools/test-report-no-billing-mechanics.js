/**
 * test-report-no-billing-mechanics.js
 *
 * Client report rule (Matt, 2026-11-04): client output never shows contract-billing mechanics or a
 * shortfall amount. No "below baseline", "not billed", "contract minimum" text. Rendered with a quarter that
 * measured below baseline (the case that used to print "Amount below baseline (not billed; contract minimum $0)").
 * Covers the quarterly report render and a scan of every string in app/*.js. SYNTHETIC data only.
 * Headless bundled Chromium (never Edge), file:// page.
 *
 * Usage: node tools/test-report-no-billing-mechanics.js   (env APP_ROOT=<checkout> to test another tree)
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
  const ctx = await launchBrowser('report-no-mechanics');
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
        totals: { savings: 0, shortfallNotBilled: 400, blCost: 6000, pctBase: 6000, kwhBl: 600, kwhCur: 660, thermsBl: 600, thermsCur: 800, peakKwBl: 60, peakKwCur: 66, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Q3 2026', cumulativeSavings: 0 },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [{ ym: '2026-07', building: 'Building A', commodity: 'Electric', account: 'A1', amount: 5 }],
      };
      const strip = (h) => h.replace(/<[^>]+>/g, ' ');
      const q = strip(_rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false, buildingSummaries: false, electricDetail: false, gasDetail: false, propaneDetail: false, yearToDate: false, appendixB: false, appendixC: false }));
      return { q };
    });
    const bad = /below baseline|not billed|contract minimum/i;
    ok(out.q.length > 1000, 'quarterly report renders (' + out.q.length + ' chars)');
    ok(!bad.test(out.q), 'quarterly report has none of "below baseline", "not billed", "contract minimum"');
    ok(!/shortfall/i.test(out.q), 'quarterly report has no "shortfall"');
    // Every report page of every report type: no contract-billing text in any string the code can print.
    const fs = require('fs');
    const src = fs.readdirSync(path.join(ROOT, 'app')).filter((f) => /\.js$/.test(f) && f !== 'site-functions.js');
    const hits = [];
    src.forEach((f) => {
      fs.readFileSync(path.join(ROOT, 'app', f), 'utf8')
        .split(String.fromCharCode(10))
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/below baseline|contract minimum|shortfall not billed|amount below/i.test(line.replace(/\/\/.*$/, ''))) hits.push(f + ':' + (i + 1));
        });
    });
    ok(hits.length === 0, 'no report code prints "below baseline", "contract minimum", "shortfall not billed" or "amount below"' + (hits.length ? ': ' + hits.join(', ') : ''));
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL ' + e.message);
  process.exit(1);
});
