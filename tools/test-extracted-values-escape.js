/**
 * test-extracted-values-escape.js
 *
 * Extracted Values grid (renderPDFFields): OCR text, labels, hover reasons and Data analysis bar links are
 * HTML-escaped (_escHtml). SYNTHETIC hostile values only. Fails when an injected <img onerror> becomes an element,
 * when the handler runs, or when a hostile value does not round-trip through the input.
 *
 * Usage: node tools/test-extracted-values-escape.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const { launchBrowser } = require('./launch-browser');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const EVIL = '"><img src=x onerror="window.__xss=1">';
const BILL = {
  UtilityCompany: 'Sample Electric Co',
  Commodity: 'Electric',
  CustomerName: EVIL,
  AccountNumber: 'SAMPLE-ACCT',
  BillingPeriodStart: null,
  kWhConsumed: '1000',
  ActualKW: '10',
  CustomerCharge: '50.00',
  TotalCurrentCharges: '123.45',
};
BILL['Bad' + EVIL] = EVIL;
BILL['_auto_corrected_CustomerCharge'] = { original: EVIL, corrected: '50.00', reason: EVIL };
const WARNINGS = [
  { level: 'error', field: 'BillingPeriodStart', message: EVIL },
  { level: 'info', field: 'ActualKW', message: EVIL },
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
  const ctx = await launchBrowser('ev-escape');
  try {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    await page.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      localStorage.setItem('ch_backend_mode', 'off');
      localStorage.setItem('ch_user', JSON.stringify({ name: 'Demo', email: 'demo@example.com', demo: true }));
    });
    await page.goto(origin + '/energy-department.html');
    await page.waitForTimeout(3000);
    await page.evaluate(() => sv('pdf'));
    await page.waitForTimeout(500);
    await page.evaluate(([b, w]) => {
      window._pdfRawText = 'SAMPLE';
      window._pdfMultiBills = [b];
      window._pdfMultiIdx = 0;
      window._pdfSrcKey = 'SAMPLE';
      window._pdfBillWarnings = [{ warnings: w }];
      renderPDFFields(b, w);
      renderMultiBillUI(window._pdfMultiBills);
    }, [BILL, WARNINGS]);
    await page.waitForTimeout(800);
    const r = await page.evaluate((evil) => {
      const root = document.getElementById('extractedFieldsGrid');
      const hdr = document.getElementById('extractedFieldsHdr');
      const all = [...root.querySelectorAll('*'), ...hdr.querySelectorAll('*')];
      return {
        xss: window.__xss === 1,
        imgs: all.filter((e) => e.tagName === 'IMG').length,
        onerr: all.filter((e) => e.hasAttribute('onerror')).length,
        nameValue: (root.querySelector('.ef-input[data-key="CustomerName"]') || {}).value,
        hasEvilKey: !![...root.querySelectorAll('.ef-input')].find((i) => i.getAttribute('data-key') === 'Bad' + evil),
        tooltips: [...root.querySelectorAll('.ef-ac-tooltip')].length,
      };
    }, EVIL);
    if (r.xss) problems.push('injected onerror ran');
    if (r.imgs || r.onerr) problems.push('injected element in the grid: img ' + r.imgs + ', onerror ' + r.onerr);
    if (r.nameValue !== EVIL) problems.push('hostile value did not round-trip: ' + r.nameValue);
    if (!r.hasEvilKey) problems.push('hostile field key not kept as an attribute value');
    if (!r.tooltips) problems.push('setup: no hover box drawn');
  } finally {
    await ctx.close();
    srv.close();
  }
  if (problems.length) {
    console.error('FAIL test-extracted-values-escape\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('PASS test-extracted-values-escape');
})().catch((e) => {
  console.error('FAIL test-extracted-values-escape: ' + e.message);
  process.exit(1);
});
