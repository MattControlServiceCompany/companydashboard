/**
 * test-report-pdf-letterhead-footer.js
 *
 * The file the real "Download PDF" button saves must carry the Control Service Company letterhead on page 1 and the
 * wave footer ("<period> Quarterly Report" and "Page N of M") on every page, and its text must be selectable.
 * The test clicks the real button in the report preview, renders the saved PDF with pdftoppm (poppler) and checks:
 *   1. page 1 top band holds the colored logo, the last page and page 2 carry the wave in the bottom band,
 *   2. pdftotext returns "Q3 2026 Quarterly Report" and "Page 1 of" (a text layer exists, not only an image).
 * SYNTHETIC data only. Headless bundled Chromium (never Edge), file:// page. Needs pdftoppm and pdftotext on PATH.
 *
 * Usage: node tools/test-report-pdf-letterhead-footer.js   (env APP_ROOT=<checkout> to test another tree)
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

// Share of the pixels of a horizontal band (y0..y1 as a fraction of the height) that carry color.
function colorShare(file, y0, y1) {
  const b = fs.readFileSync(file);
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 30));
  const w = +m[1], h = +m[2], o = m[0].length;
  let n = 0, t = 0;
  for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
    for (let x = 0; x < w; x++) {
      const i = o + (y * w + x) * 3;
      t++;
      if (Math.max(b[i], b[i + 1], b[i + 2]) - Math.min(b[i], b[i + 1], b[i + 2]) > 40) n++;
    }
  return n / t;
}

(async () => {
  const ctx = await launchBrowser('report-pdf-letterhead', { acceptDownloads: true });
  const tmp = require('./tmp-root').mkTmpDir('rpt-pdf-letterhead-');
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
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
        electric: com(), gas: com(), propane: com(), eui: { baseline: 41.1, current: 31.1, cbecs: 51.1 }, euiQ: { baseline: 10, current: 11 }, meterDetails: [],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
        project: { client: 'Test Client', name: 'Test Project', sqft: 220000, blStart: '2024-01', blEnd: '2024-12' },
        contract: { quarterlyTargets: [1111, 1111, 1111, 1111], quarterlyActuals: [1111, 1111, 1111], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3, actualsThroughQuarter: 3 },
        totals: { euiBaselineQ: 10, euiCurrentQ: 11, savings: 2222, blCost: 22222, kwhBl: 2222, kwhCur: 2422, thermsBl: 2022, thermsCur: 2202, peakKwBl: 222, peakKwCur: 242, euiBaseline: 41.1, euiCurrent: 31.1, euiPeriodLabel: 'x', weatherWaiting: [] },
        buildings: [bld('Building A'), bld('Building B')],
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [],
      };
      const secs = {};
      REPORT_SECTIONS.forEach((s) => (secs[s.key] = true));
      const html = generateReportHTML(d, secs);
      window._currentReportData = d;
      _showPreview({ reportType: 'quarterly', clientName: 'Test Client', periodLabel: 'Q3 2026' }, html);
    });
    await page.waitForTimeout(500);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      page.locator('#rptPreviewToolbar button', { hasText: 'Download PDF' }).click(),
    ]);
    const pdf = path.join(tmp, 'report.pdf');
    await dl.saveAs(pdf);
    const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' });
    const pages = Number((/Pages:\s+(\d+)/.exec(info.stdout || '') || [0, 0])[1]);
    ok(pages >= 2, 'the PDF has at least 2 pages (' + pages + ')');
    const last = String(pages);
    for (const pg of ['1', '2', last]) spawnSync('pdftoppm', ['-r', '40', '-f', pg, '-l', pg, pdf, path.join(tmp, 'p' + pg)]);
    const f = (pg) => fs.readdirSync(tmp).filter((n) => /^p\d+-\d+\.ppm$/.test(n) && Number(/-(\d+)\.ppm$/.exec(n)[1]) === Number(pg)).map((n) => path.join(tmp, n))[0];
    ok(!!f(1) && colorShare(f(1), 0, 0.15) > 0.04, 'page 1 top band carries the colored letterhead logo (share ' + (f(1) ? colorShare(f(1), 0, 0.15).toFixed(3) : 'no image') + ')');
    for (const pg of ['1', '2', last]) {
      const s = f(pg) ? colorShare(f(pg), 0.88, 1) : 0;
      ok(s > 0.3, 'page ' + pg + ' bottom band carries the wave footer (share ' + s.toFixed(3) + ')');
    }
    const txt = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout || '';
    ok(/Q3 2026 Quarterly Report/.test(txt), 'text layer: footer label "Q3 2026 Quarterly Report" is selectable text');
    ok(new RegExp('Page 1 of ' + pages).test(txt) && new RegExp('Page ' + pages + ' of ' + pages).test(txt), 'text layer: "Page N of M" on the first and the last page');
    ok(/Test Client/.test(txt), 'text layer: report body text is selectable');
  } finally {
    await ctx.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(fails ? '=== FAILED: ' + fails + ' ===' : '=== report PDF letterhead and footer: all passed ===');
  process.exit(fails ? 1 : 0);
})();
