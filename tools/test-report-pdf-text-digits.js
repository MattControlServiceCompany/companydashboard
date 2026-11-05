/**
 * test-report-pdf-text-digits.js
 *
 * The quarterly report prints to a PDF whose text layer must keep every digit (a reader that copies text or a
 * screen reader gets "1" as well as the other digits). Prints a synthetic quarterly report headless with the
 * browser's own print-to-PDF (the path "Save as PDF" uses), extracts the text with pdftotext and compares the
 * digit counts of the page with the digit counts of the PDF text layer. SYNTHETIC data only.
 * Headless bundled Chromium (never Edge). Skips (exit 0) when pdftotext is not installed.
 *
 * Usage: node tools/test-report-pdf-text-digits.js   (env APP_ROOT=<checkout> to test another tree)
 */
const fs = require('fs');
const TMP = require('./tmp-root.js');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

if (spawnSync('pdftotext', ['-v']).error) {
  console.log('SKIP pdftotext is not installed');
  process.exit(0);
}

(async () => {
  const ctx = await launchBrowser('report-pdf-digits');
  const tmp = TMP.mkTmpDir('rpt-pdf-digits-');
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    const domText = await page.evaluate(() => {
      const mon = (ym, sav) => ({ month: ym, blCost: 1111, curCost: 1111 - sav, savings: sav, kwhBl: 111, kwhCur: 121 });
      const com = () => ({
        monthly: [mon('2026-07', 11), mon('2026-08', 101), mon('2026-09', 111)],
        kwhBl: 1111, kwhCur: 1211, kwBl: 111, kwCur: 121, thermsBl: 1011, thermsCur: 1101, galBl: 0, galCur: 0,
        costSaved: 1111, kwCostSaved: 111,
      });
      const bld = (name) => ({
        id: name, name, sqft: 110000, status: 'ok', savings: 1111, savingsPct: 11.1, blCost: 11111,
        electric: com(), gas: com(), propane: null, eui: { baseline: 41.1, current: 31.1, cbecs: 51.1 }, meterDetails: [],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
        project: { client: 'Test Client', name: 'Test Project', sqft: 220000, blStart: '2024-01', blEnd: '2024-12' },
        contract: { quarterlyTargets: [1111, 1111, 1111, 1111], quarterlyActuals: [1111, 1111, 1111], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3, actualsThroughQuarter: 3 },
        totals: { savings: 2222, blCost: 22222, kwhBl: 2222, kwhCur: 2422, thermsBl: 2022, thermsCur: 2202, peakKwBl: 222, peakKwCur: 242, euiBaseline: 41.1, euiCurrent: 31.1, euiPeriodLabel: 'Jan 2026 to Sep 2026 annualized, all fuels', weatherWaiting: [] },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [],
      };
      const html = _rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false, buildingSummaries: false, electricDetail: false, gasDetail: false, propaneDetail: false, yearToDate: false, appendixB: false, appendixC: false });
      Array.from(document.body.children).forEach((el) => (el.style.display = 'none'));
      document.documentElement.style.cssText = 'height:auto;overflow:visible';
      document.body.style.cssText = 'height:auto;overflow:visible;display:block';
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.appendChild(host);
      return host.innerText;
    });
    await page.emulateMedia({ media: 'screen' });
    const pdf = path.join(tmp, 'report.pdf');
    await page.pdf({ path: pdf, format: 'Letter', printBackground: true, preferCSSPageSize: true });
    const pdfText = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
    const count = (t, ch) => t.split(ch).length - 1;
    const domOnes = count(domText, '1');
    const pdfOnes = count(pdfText, '1');
    ok(domOnes > 50, 'the report text has many "1" digits (' + domOnes + ')');
    ok(pdfOnes >= domOnes, 'the PDF text layer keeps every "1" (page ' + domOnes + ', PDF ' + pdfOnes + ')');
    for (const ch of '0123456789') ok(count(pdfText, ch) >= count(domText, ch), 'PDF text layer keeps every "' + ch + '" (' + count(pdfText, ch) + ' of ' + count(domText, ch) + ')');
  } finally {
    await ctx.close();
    TMP.rmTmp(tmp);
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL ' + e.message);
  process.exit(1);
});
