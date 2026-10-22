/**
 * test-extracted-values-grid.js
 *
 * PDF / OCR extracted values: boxed cells (.ef-item) in a 2-column .ef-grid, grouped by the layout sections, with the
 * "Data analysis" bar above them. SYNTHETIC bill only (fake ids). Checks:
 *  - the grid, the section titles and the title line draw; no .ef-list is left;
 *  - the bar counts and the chip counts come from one list (they are equal);
 *  - a missing value has a red edge and an icon, a warning value has an amber edge and an icon;
 *  - a pane under 560 px wide drops the grid to one column; no horizontal scroll;
 *  - typing in a cell saves through _pdfApplyFieldEdit and the cell re-draws with the new value.
 *
 * Usage: node tools/test-extracted-values-grid.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { launchBrowser } = require('./launch-browser');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const BILL = {
  UtilityCompany: 'Sample Electric Co',
  Commodity: 'Electric',
  CustomerName: 'Sample Customer',
  AccountNumber: 'SAMPLE-ACCT',
  MeterNumber: 'SAMPLE-MTR',
  BillingPeriodStart: null,
  BillingPeriodEnd: null,
  NumberOfDays: null,
  kWhConsumed: '1000',
  ActualKW: '10',
  CustomerCharge: '50.00',
  TotalCurrentCharges: '123.45',
};
const WARNINGS = [
  { level: 'error', field: 'BillingPeriodStart', message: 'Missing: the period start is normally printed on this bill' },
  { level: 'error', field: 'BillingPeriodEnd', message: 'Missing: the period end is normally printed on this bill' },
  { level: 'warn', field: 'NumberOfDays', message: 'Missing: usually present' },
  { level: 'warn', field: 'ActualKW', message: 'Sample warning: check this value' },
];

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
  const ctx = await launchBrowser('ev-grid');
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('ch_settings', JSON.stringify({ showQuickStart: false }));
      localStorage.setItem('ch_backend_mode', 'off');
      localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo', email: 'demo@example.com', demo: true }));
    });
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(3000);
    await page.evaluate(() => sv('pdf'));
    await page.waitForTimeout(500);
    await page.evaluate(([b, w]) => {
      window._pdfRawText = 'SAMPLE RAW OCR TEXT';
      window._pdfMultiBills = [b];
      window._pdfMultiIdx = 0;
      window._pdfSrcKey = 'SAMPLE';
      window._pdfBillWarnings = [{ warnings: w }];
      renderPDFFields(b, w);
      renderMultiBillUI(window._pdfMultiBills);
    }, [BILL, WARNINGS]);
    await page.waitForTimeout(500);
    const read = () =>
      page.evaluate(() => {
        const g = document.getElementById('extractedFieldsGrid');
        const grid = g.querySelector('.ef-grid');
        const item = (k) => g.querySelector('.ef-input[data-key="' + k + '"]')?.closest('.ef-item');
        const title = (document.querySelector('.ef-bar-title') || {}).textContent || '';
        const num = (re) => ((title.match(re) || [])[1] ? Number(title.match(re)[1]) : 0);
        const chip = (re) => {
          const c = [...document.querySelectorAll('#pdfTopChips .pdf-chip')].map((x) => x.textContent).find((t) => re.test(t));
          return c ? Number(c.match(/^(\d+)/)[1]) : 0;
        };
        return {
          hasGrid: !!grid,
          oldList: !!g.querySelector('.ef-list, details.ef-group'),
          sections: [...g.querySelectorAll('.ef-section')].map((s) => s.textContent),
          hdr: document.getElementById('extractedFieldsHdr').textContent,
          barMissing: num(/(\d+) missing/),
          barWarn: num(/(\d+) warning/),
          chipReview: chip(/to review/),
          chipWarn: chip(/warning/),
          manual: !!document.querySelector('.ef-ma-btn'),
          startCls: item('BillingPeriodStart')?.className || '',
          startIcon: !!item('BillingPeriodStart')?.querySelector('.ef-ico'),
          kwCls: item('ActualKW')?.className || '',
          kwIcon: !!item('ActualKW')?.querySelector('.ef-ico'),
          cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
          paneW: g.clientWidth,
          hscroll: g.scrollWidth > g.clientWidth + 1,
        };
      });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(400);
    const wide = await read();
    if (!wide.hasGrid) problems.push('no .ef-grid');
    if (wide.oldList) problems.push('old .ef-list / details group still drawn');
    if (!wide.sections.includes('Account Info') || !wide.sections.includes('Billing Period & Meter') || !wide.sections.includes('Charges'))
      problems.push('section titles missing: ' + JSON.stringify(wide.sections));
    if (!/Extracted/.test(wide.hdr) || !/click values to edit/i.test(wide.hdr)) problems.push('title line missing: ' + wide.hdr);
    if (!wide.barMissing) problems.push('bar shows no missing count');
    if (!wide.barWarn) problems.push('bar shows no warning count');
    if (wide.barMissing !== wide.chipReview || wide.barWarn !== wide.chipWarn)
      problems.push('bar counts ' + wide.barMissing + '/' + wide.barWarn + ' differ from chips ' + wide.chipReview + '/' + wide.chipWarn);
    if (!wide.manual) problems.push('Manual Assign button missing');
    if (!/is-error/.test(wide.startCls) || !wide.startIcon) problems.push('missing value has no red edge and icon: ' + wide.startCls);
    if (!/is-warn/.test(wide.kwCls) || !wide.kwIcon) problems.push('warning value has no amber edge and icon: ' + wide.kwCls);
    if (wide.cols !== 2) problems.push('wide pane: expected 2 columns, got ' + wide.cols + ' (pane ' + wide.paneW + ')');
    if (wide.hscroll) problems.push('wide pane scrolls sideways');
    // the values pane beside the PDF is narrower than the window: force a 400 px pane
    await page.evaluate(() => (document.getElementById('extractedFieldsGrid').style.width = '400px'));
    await page.waitForTimeout(500);
    const narrow = await read();
    if (narrow.paneW >= 560) problems.push('setup: narrow pane is ' + narrow.paneW + ' px, expected under 560');
    if (narrow.cols !== 1) problems.push('narrow pane (' + narrow.paneW + ' px): expected 1 column, got ' + narrow.cols);
    if (narrow.hscroll) problems.push('narrow pane scrolls sideways');
    // typing in a cell: the one edit path saves it and the cell re-draws
    const loc = page.locator('#extractedFieldsGrid .ef-input[data-key="CustomerName"]');
    await loc.click();
    await loc.fill('SAMPLE EDITED NAME');
    await loc.press('Tab');
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      stored: window._pdfMultiBills[0].CustomerName,
      shown: document.querySelector('#extractedFieldsGrid .ef-input[data-key="CustomerName"]').value,
    }));
    if (after.stored !== 'SAMPLE EDITED NAME' || after.shown !== 'SAMPLE EDITED NAME')
      problems.push('edit did not save: ' + JSON.stringify(after));
    if (errs.length) problems.push('page errors: ' + errs.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
    srv.close();
  }
  if (problems.length) {
    console.error('FAIL test-extracted-values-grid\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('PASS test-extracted-values-grid');
})().catch((e) => {
  console.error('FAIL test-extracted-values-grid: ' + e.message);
  process.exit(1);
});
