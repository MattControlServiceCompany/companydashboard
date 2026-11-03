/**
 * test-report-download-buttons.js
 *
 * Every report has two one-click buttons, Download Word (.docx) and Download PDF, and never a print dialog.
 * Opens a SYNTHETIC quarterly report in the preview (toolbar #rptPreviewToolbar) and in the overlay
 * (#reportOverlay toolbar), clicks both buttons in each, and asserts: a .docx download (zip) and a .pdf
 * download (%PDF), the toolbars have no Print button, window.print is never called, no dialog opens.
 * Headless bundled Chromium (never Edge). Network to supabase/netlify is blocked.
 *
 * Usage: node tools/test-report-download-buttons.js   (env APP_ROOT=<checkout> to test another tree)
 */
const fs = require('fs');
const os = require('os');
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
  const ctx = await launchBrowser('report-download-buttons', { acceptDownloads: true });
  const tmp = fs.mkdtempSync(path.join(process.env.CH_TMP_ROOT || os.tmpdir(), 'rpt-dl-buttons-'));
  try {
    const page = await ctx.newPage();
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      d.dismiss();
    });
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.addInitScript(() => {
      window.__printCalls = 0;
      window.print = () => {
        window.__printCalls++;
      };
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const login = document.getElementById('loginScreen');
      if (login) login.remove();
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
      const html = _rptQuarterReportHTML(d, { appendixD: false, environmentalImpact: false, approvedChanges: false });
      window._currentReportData = d;
      window.__testHtml = html;
      window.__testD = d;
    });

    async function clickAndCheck(scope, selector, label, ext, magic) {
      const btn = page.locator(selector, { hasText: label });
      ok((await btn.count()) === 1, scope + ': exactly one "' + label + '" button');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), btn.click()]);
      const f = path.join(tmp, scope + '-' + dl.suggestedFilename());
      await dl.saveAs(f);
      const head = fs.readFileSync(f).subarray(0, 4).toString('latin1');
      ok(dl.suggestedFilename().endsWith(ext), scope + ': ' + label + ' saves a ' + ext + ' file (' + dl.suggestedFilename() + ')');
      ok(head.startsWith(magic), scope + ': ' + label + ' file starts with ' + magic);
      ok(fs.statSync(f).size > 2000, scope + ': ' + label + ' file is not empty');
    }

    // 1. Preview toolbar (Quarterly / Annual / Cumulative / Custom reports)
    await page.evaluate(() => {
      _showPreview({ reportType: 'quarterly', clientName: 'Test Client', periodLabel: 'Q3 2026' }, window.__testHtml);
    });
    await page.waitForTimeout(500);
    const tb = '#rptPreviewToolbar button';
    ok((await page.locator(tb, { hasText: /^\s*Print\s*$/ }).count()) === 0, 'preview: no Print button');
    await clickAndCheck('preview', tb, 'Download Word', '.docx', 'PK');
    await clickAndCheck('preview', tb, 'Download PDF', '.pdf', '%PDF');
    await page.evaluate(() => {
      document.getElementById('reportPreviewContainer').style.display = 'none';
    });

    // 2. Overlay toolbar (every other report; Report History re-opens saved reports here too)
    await page.evaluate(() => {
      window._currentReportData = window.__testD;
      showReportOverlay(window.__testHtml, 'Test report');
    });
    await page.waitForTimeout(500);
    const ob = '#reportOverlay .rpt-toolbar-btn';
    ok((await page.locator(ob, { hasText: /Print/ }).count()) === 0, 'overlay: no Print button');
    await clickAndCheck('overlay', ob, 'Download Word', '.docx', 'PK');
    await clickAndCheck('overlay', ob, 'Download PDF', '.pdf', '%PDF');

    ok(dialogs === 0, 'no dialog opened (' + dialogs + ')');
    const prints = await page.evaluate(() => window.__printCalls);
    ok(prints === 0, 'window.print never called (' + prints + ')');
  } finally {
    await ctx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails ? '=== FAILED: ' + fails + ' ===' : '=== report download buttons: all passed ===');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
