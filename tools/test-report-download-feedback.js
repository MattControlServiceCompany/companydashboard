// tools/test-report-download-feedback.js - Download PDF gives visible feedback while the audit report overlay is open.
// SYNTHETIC project, headless bundled Chromium. Run: CH_TMP_ROOT=<scratch> node tools/test-report-download-feedback.js
//   1. The toast sits above the report overlay: document.elementFromPoint at the toast centre is inside #toast while it reads "Building PDF".
//   2. While the PDF builds the Download PDF buttons are disabled and read "Building PDF..."; they are restored when it ends.
//   3. A second call during the build shows "A PDF is already being built. Please wait." (toast).
//   4. The download still happens, with the report file name.
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
  const ctx = await launchBrowser('report-download-feedback', { acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36Preview === 'function' && typeof downloadReportPdf === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    await page.evaluate(() => {
      const l = document.getElementById('loginScreen');
      if (l) l.remove();
      const q = document.getElementById('qsOverlay');
      if (q) q.remove();
      document.getElementById('app').classList.add('visible');
    });
    const built = await page.evaluate(async () => {
      const PID = 900003;
      const rows = [
        { id: 'r1', building: 'Alpha Library', category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F' } },
        { id: 'r2', building: 'Alpha Library', category: 'vav', equipName: 'VAV-101', location: '', controllerType: 'Sample Controller', points: { 'Zone Temp': '72.4 °F' } },
      ];
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      openASHRAE36ReportModal(PID, 'audit');
      generateASHRAE36Preview();
      for (let i = 0; i < 100 && !document.querySelector('#reportPages .rpt-page'); i++) await new Promise((r) => setTimeout(r, 100));
      return { pages: document.querySelectorAll('#reportPages .rpt-page').length, overlayOpen: !!document.querySelector('.report-overlay.open, .report-overlay.show') || getComputedStyle(document.querySelector('.report-overlay')).display !== 'none' };
    });
    ok(built.pages > 0 && built.overlayOpen, 'synthetic audit report overlay is open (' + built.pages + ' pages)');

    const buttonSel = '.report-overlay button[onclick="downloadReportPdf()"]';
    // the synthetic report builds in a second: slow each page down so the build can be watched
    await page.evaluate(() => {
      const original = window.html2canvas;
      window.html2canvas = async function (...args) {
        await new Promise((r) => setTimeout(r, 1500));
        return original.apply(this, args);
      };
    });
    const label = await page.textContent(buttonSel);
    const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
    await page.click(buttonSel);
    // wait for the first page toast
    await page.waitForFunction(() => /^Building PDF: page/.test(document.getElementById('toastMsg').textContent), null, { timeout: 20000 });
    await page.waitForTimeout(900); // the toast slides in
    const during = await page.evaluate(() => {
      const toast = document.getElementById('toast');
      const rect = toast.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const button = document.querySelector('.report-overlay button[onclick="downloadReportPdf()"]');
      return {
        text: document.getElementById('toastMsg').textContent,
        zIndex: getComputedStyle(toast).zIndex,
        hitInToast: !!hit && toast.contains(hit),
        hitTag: hit ? hit.id || hit.className || hit.tagName : null,
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        buttonDisabled: button.disabled,
        buttonText: button.textContent,
      };
    });
    ok(during.hitInToast, 'toast is on top of the overlay: elementFromPoint at the toast centre is inside #toast ("' + during.text + '", z-index ' + during.zIndex + ', hit ' + during.hitTag + ')');
    ok(during.buttonDisabled && during.buttonText === 'Building PDF...', 'during the build the button is disabled and reads "' + during.buttonText + '"');
    // screenshots only on request (CH_SHOT_DIR); the gate fails a test that leaves files in its temp folder
    if (process.env.CH_SHOT_DIR) await page.screenshot({ path: path.join(process.env.CH_SHOT_DIR, 'download-toast-visible.png') });
    const second = await page.evaluate(() => {
      downloadReportPdf();
      return document.getElementById('toastMsg').textContent;
    });
    ok(second === 'A PDF is already being built. Please wait.', 'second call during the build: "' + second + '"');
    const download = await downloadPromise;
    const fileName = download.suggestedFilename();
    ok(/ASHRAE 36 Audit Report .*\.pdf$/.test(fileName), 'the download happens with the report file name: "' + fileName + '"');
    await page.waitForFunction(() => /^PDF saved/.test(document.getElementById('toastMsg').textContent), null, { timeout: 30000 });
    const after = await page.evaluate(() => {
      const button = document.querySelector('.report-overlay button[onclick="downloadReportPdf()"]');
      return { disabled: button.disabled, text: button.textContent, busy: !!window._rptPdfBusy };
    });
    ok(!after.disabled && after.text === label && !after.busy, 'after the build the button is restored: "' + after.text + '"');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
