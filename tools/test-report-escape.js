/**
 * test-report-escape.js
 *
 * Regression test: free-text data (building name, client, period label, account, commodity, baseline
 * dates, EUI label, CSC percent) must render as TEXT in the quarterly report HTML, escaped ONCE.
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), file:// page.
 *
 * Usage: node tools/test-report-escape.js   (env APP_ROOT=<checkout> to test another tree)
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
const P = '<img src=x onerror=alert(1)>';
const PLAIN = 'Acme & Sons #416';

(async () => {
  const ctx = await launchBrowser('report-escape');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    const out = await page.evaluate(
      ([P, PLAIN]) => {
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
          meterDetails: [{ commodity: P, account: P, usagePerYear: 1000, r2: 0.9, regrCoeffs: { slopeHDD: 1, slopeCDD: 2 } }],
        });
        const d = {
          period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 ' + P, yearMonths: ['2026-07', '2026-08', '2026-09'] },
          project: { client: P, name: P, sqft: 20000, blStart: P, blEnd: P },
          contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [100, 100, 100], currentYear: 1, years: 3, hasCsc: true, cscPct: P, clientPct: 40, escalation: 3 },
          totals: { savings: 80, blCost: 6000, kwhBl: 600, kwhCur: 540, thermsBl: 600, thermsCur: 540, peakKwBl: 60, peakKwCur: 54, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: P, cumulativeSavings: 300, weatherWaiting: [] },
          buildings: [bld(P), bld(PLAIN)],
          weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
          rawBills: [{ ym: '2026-07', building: P, commodity: P, account: P, amount: 5 }],
        };
        const html = _rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false });
        return { html, rawImg: html.indexOf('<img src=x onerror') };
      },
      [P, PLAIN],
    );
    ok(out.rawImg < 0, 'payload <img onerror> never appears as a tag');
    ok(out.html.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0, 'payload appears as escaped text');
    ok(out.html.indexOf('Acme &amp; Sons #416') >= 0, 'plain name escaped once');
    ok(out.html.indexOf('&amp;amp;') < 0 && out.html.indexOf('&amp;lt;') < 0, 'nothing is escaped twice');
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
