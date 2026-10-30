/**
 * test-extracted-values-grid.js
 *
 * PDF / OCR extracted values: boxed cells (.ef-item) in an auto-fit .ef-grid (columns of at least 190 px), grouped by the layout sections, with the
 * "Data analysis" bar above them. SYNTHETIC bill only (fake ids). Checks:
 *  - the grid, the section titles and the title line draw; no .ef-list is left;
 *  - the bar counts and the chip counts come from one list (they are equal);
 *  - a missing value has a red edge and an icon, a warning value has an amber edge and an icon;
 *  - the grid fills the pane with as many 190 px columns as fit, and drops to one column in a narrow pane; no horizontal scroll;
 *  - a value has the plain text color unless it is flagged; a flagged value is colored; every value has hover text;
 *  - the title says "Extracted values" and no edit hint or "Saves to" paragraph is drawn;
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
        const rowsOf = (gr) => { const m = {}; gr.querySelectorAll(':scope > .ef-item, :scope > .ef-pair > .ef-item').forEach((e) => { const b = e.getBoundingClientRect(); (m[Math.round(b.top)] = m[Math.round(b.top)] || []).push(b.right); }); return m; };
        const title = (document.querySelector('.ef-bar-title') || {}).textContent || '';
        const num = (re) => ((title.match(re) || [])[1] ? Number(title.match(re)[1]) : 0);
        const chip = (re) => {
          const c = [...document.querySelectorAll('#pdfTopChips .pdf-chip')].map((x) => x.textContent).find((t) => re.test(t));
          return c ? Number(c.match(/^(\d+)/)[1]) : 0;
        };
        return {
          hasGrid: !!grid,
          oldList: !!g.querySelector('.ef-list, details.ef-group'),
          sections: [...g.querySelectorAll('.ef-section')].map((s) => s.firstChild.textContent),
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
          cols: grid ? Math.max(...Object.values(rowsOf(grid)).map((r) => r.length)) : 0,
          colMin: grid ? Math.min(...[...grid.querySelectorAll(':scope > .ef-item, :scope > .ef-pair > .ef-item')].map((e) => e.getBoundingClientRect().width)) : 0,
          rowsShort: grid ? Object.values(rowsOf(grid)).filter((r) => Math.abs(Math.max(...r) - grid.getBoundingClientRect().right) > 1).length : 0,
          textColor: getComputedStyle(item('CustomerName').querySelector('.ef-input')).color,
          flagColor: getComputedStyle(item('ActualKW').querySelector('.ef-input')).color,
          titleOf: item('CustomerName').querySelector('.ef-input').title,
          hint: /click any value|each bill goes to/i.test(document.getElementById('pdfLeftCol').textContent),
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
    if (!/Extracted values/.test(wide.hdr) || /click/i.test(wide.hdr)) problems.push('title line wrong: ' + wide.hdr);
    if (wide.hint) problems.push('the edit hint or the multi-bill Saves to paragraph is still in the page');
    if (wide.textColor !== 'rgb(255, 255, 255)') problems.push('plain value is not white on dark: ' + wide.textColor);
    if (wide.flagColor === wide.textColor) problems.push('a flagged value has the plain color: ' + wide.flagColor);
    if (!/edit/i.test(wide.titleOf)) problems.push('value has no edit hover text: "' + wide.titleOf + '"');
    if (!wide.barMissing) problems.push('bar shows no missing count');
    if (!wide.barWarn) problems.push('bar shows no warning count');
    if (wide.barMissing !== wide.chipReview || wide.barWarn !== wide.chipWarn)
      problems.push('bar counts ' + wide.barMissing + '/' + wide.barWarn + ' differ from chips ' + wide.chipReview + '/' + wide.chipWarn);
    if (!wide.manual) problems.push('Manual Assign button missing');
    if (!/is-error/.test(wide.startCls) || !wide.startIcon) problems.push('missing value has no red edge and icon: ' + wide.startCls);
    if (!/is-warn/.test(wide.kwCls) || !wide.kwIcon) problems.push('warning value has no amber edge and icon: ' + wide.kwCls);
    const expectCols = Math.max(1, Math.floor((wide.paneW + 2) / 192));
    if (wide.cols > expectCols) problems.push('wide pane: expected at most ' + expectCols + ' per row, got ' + wide.cols + ' (pane ' + wide.paneW + ')');
    if (wide.colMin < 189) problems.push('a column is narrower than 190 px: ' + wide.colMin);
    if (wide.rowsShort) problems.push('wide pane: ' + wide.rowsShort + ' rows of boxes stop short of the right edge');
    if (wide.hscroll) problems.push('wide pane scrolls sideways');
    // a narrow values pane (under two 190 px columns): force a 340 px pane
    await page.evaluate(() => (document.getElementById('extractedFieldsGrid').style.width = '340px'));
    await page.waitForTimeout(500);
    const narrow = await read();
    if (narrow.paneW >= 382) problems.push('setup: narrow pane is ' + narrow.paneW + ' px, expected under 382');
    if (narrow.cols !== 1) problems.push('narrow pane (' + narrow.paneW + ' px): expected 1 per row, got ' + narrow.cols);
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
