/**
 * test-clear-pdf-resets-all.js
 *
 * Loads a synthetic extraction with one held bill into the PDF/OCR page (headless bundled Chromium,
 * SYNTHETIC data only), checks the held bill shows a plain Save (no Save Anyway), then calls the one
 * Clear function and requires that nothing from the extraction stays in the DOM: values, warnings,
 * the top row (selectors, chips, Save), the held-bill line, the OCR text tab.
 *
 * Usage: node tools/test-clear-pdf-resets-all.js [repo-root] [screenshot-dir]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null;
const { launchBrowser } = require('./launch-browser');

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function bill(start, end, held) {
  const b = {
    UtilityCompany: 'Sample Electric Co',
    Commodity: 'Electric',
    CustomerName: 'Sample Customer',
    AccountNumber: 'SAMPLE-ACCT',
    MeterNumber: 'SAMPLE-MTR',
    BillingPeriodStart: start,
    BillingPeriodEnd: end,
    NumberOfDays: '30',
    kWhConsumed: '1000',
    ActualKW: '10',
    TotalCurrentCharges: '123.45',
    PreviouslyBilled: '100.00',
  };
  if (held) {
    b._gateTripped = true;
    b._gateReasons = ['Total does not match the sum of the charges'];
  }
  return b;
}

(async () => {
  const problems = [];
  const srv = http.createServer((q, r) => {
    const p = decodeURIComponent(q.url.split('?')[0]);
    fs.readFile(path.join(REPO, p === '/' ? '/index.html' : p), (e, b) => {
      if (e) { r.writeHead(404); r.end(); return; }
      r.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
      r.end(b);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const ctx = await launchBrowser('clear-pdf');
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      localStorage.setItem('ch_backend_mode', 'off');
      localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo', email: 'demo@example.com', demo: true }));
    });
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(3000);
    await page.evaluate(() => sv('pdf'));
    await page.waitForTimeout(500);
    const state = () =>
      page.evaluate(() => {
        const vis = (id) => {
          const e = document.getElementById(id);
          return !!e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null;
        };
        const txt = (id) => (document.getElementById(id) || { textContent: '' }).textContent.trim();
        return {
          fieldsGrid: txt('extractedFieldsGrid').length,
          fieldsHdr: txt('extractedFieldsHdr').length,
          topBarVisible: vis('pdfTopBar'),
          topBarText: txt('pdfTopSel') + txt('pdfTopChips') + txt('pdfTopSave'),
          topSaveText: txt('pdfTopSave'),
          moreSaveText: txt('pdfMoreSave'),
          saveRowVisible: vis('pdfSaveRow'),
          mbPanelVisible: vis('pdfMultiBldgPanel'),
          mbPanelText: txt('pdfMultiBldgPanel'),
          heldLine: txt('pdfMoreSave').includes('held out of Save all'),
          saveAnyway: document.body.innerText.includes('Save Anyway') || !!document.getElementById('pdfSaveAnywayBtn'),
          saveBtn: !!document.querySelector('#pdfTopBar [data-fb="energy.pdf.save-btn"]'),
          ocrText: txt('pdfDockOcr'),
          dockVisible: vis('pdfDockCol'),
          dropZoneCollapsed: document.getElementById('dropZone').classList.contains('collapsed'),
          raw: window._pdfRawText || null,
          bills: window._pdfMultiBills || null,
        };
      });
    await page.evaluate(([a, b]) => {
      window._pdfRawText = 'SAMPLE RAW OCR TEXT';
      window._pdfMultiBills = [a, b];
      window._pdfMultiIdx = 1;
      window._pdfSrcKey = 'SAMPLE';
      window._pdfBillWarnings = [];
      renderPDFFields(window._pdfMultiBills[1], []);
      renderMultiBillUI(window._pdfMultiBills);
      document.getElementById('pdfSaveRow').style.display = 'block';
      document.getElementById('pdfDockOcr').textContent = 'SAMPLE RAW OCR TEXT';
    }, [bill('01/01/2026', '01/31/2026', false), bill('08/04/2026', '09/02/2026', true)]);
    await page.waitForTimeout(500);
    const before = await state();
    if (before.fieldsGrid === 0) problems.push('setup: no extracted values rendered');
    if (!before.topSaveText) problems.push('setup: no Save control rendered in the top row');
    if (!before.heldLine) problems.push('setup: no held-bill line rendered');
    if (before.saveAnyway) problems.push('held bill still shows Save Anyway');
    if (!before.saveBtn) problems.push('plain Save button missing');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '2026-10-20-held-bill-plain-save.png') });
    await page.evaluate(() => clearPDFOCR());
    await page.waitForTimeout(400);
    const after = await state();
    const bad = [];
    if (after.fieldsGrid) bad.push('values');
    if (after.fieldsHdr) bad.push('warnings/held banner');
    if (after.topBarVisible || after.topBarText) bad.push('top row (selectors, chips, Save)');
    if (after.saveRowVisible) bad.push('save row');
    if (after.moreSaveText) bad.push('other ways to save (Overwrite all / Merge all / Attach)');
    if (after.mbPanelVisible || after.mbPanelText) bad.push('multi-account panel');
    if (after.heldLine) bad.push('held-bill line');
    if (after.saveAnyway) bad.push('Save Anyway');
    if (after.ocrText) bad.push('OCR text');
    if (after.dockVisible) bad.push('PDF dock');
    if (after.dropZoneCollapsed) bad.push('drop zone still collapsed');
    if (after.raw || after.bills) bad.push('extraction memory');
    if (bad.length) problems.push('after Clear still present: ' + bad.join(', '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '2026-10-20-after-clear.png') });
    if (errs.length) problems.push('page errors: ' + errs.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
    srv.close();
  }
  if (problems.length) {
    console.error('FAIL\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('PASS clear-pdf-resets-all');
})();
