/**
 * test-pdf-view-after-reload.js
 * Gate: after a page reload (twice), the extraction page must show the View PDF button and open the PDF dock
 * with the RIGHT PDF. Drives the REAL flow: synthetic PDFs go through the real file input (setInputFiles)
 * and the real extraction. Covers one file (3 bill tabs) and a 2-file batch (each row has its own PDF).
 * Also checks that ch_queue_state holds no base64 PDF. SYNTHETIC data only. Headless bundled Chromium.
 * Usage: node tools/test-pdf-view-after-reload.js   (env APP_ROOT=<checkout>, CH_PLAYWRIGHT_NODE_MODULES)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/energy-department.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.normalize(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    r.writeHead(404);
    return r.end();
  }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

// One PDF page per entry; each entry is an array of text lines.
function makePdf(pageLines) {
  const n = pageLines.length;
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(3 + i * 2 + ' 0 R');
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    let ops = 'BT /F1 14 Tf 40 740 Td 18 TL\n';
    pageLines[i].forEach((l) => (ops += `(${l}) Tj T*\n`));
    ops += 'ET';
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + n * 2} 0 R >> >> >>`;
    objs[4 + i * 2] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  objs[3 + n * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let s = '%PDF-1.4\n';
  const o = [];
  const N = 3 + n * 2;
  for (let i = 1; i <= N; i++) {
    o[i] = s.length;
    s += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const x = s.length;
  s += `xref\n0 ${N + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= N; i++) s += String(o[i]).padStart(10, '0') + ' 00000 n \n';
  s += `trailer\n<< /Size ${N + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(s, 'latin1');
}
const billPage = (acct, from, to, amt) => [
  'SYNTHETIC EVERGY BILL TEST', 'Account Number ' + acct, 'Service Address 202 TEST ST',
  'Billing Details - service from ' + from + ' to ' + to, 'Customer Chg 25.00', 'Energy Chg 1000 kWh 80.00',
  'Demand Chg 10 kW 90.00', 'TDC Chg 5.00', 'Current Charges ' + amt, 'Total Amount Due ' + amt,
];
const pdfA = makePdf([
  billPage('1000001', '01/01/2026', '01/31/2026', '200.00'),
  billPage('1000001', '02/01/2026', '02/28/2026', '200.00'),
  billPage('1000001', '03/01/2026', '03/31/2026', '200.00'),
]);
const pdfB = makePdf([billPage('2000002', '04/01/2026', '04/30/2026', '300.00')]);

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

// State of the page: button, dock with an embedded PDF, and the PDF the app would show right now.
const probe = (page) =>
  page.evaluate(async () => {
    const btn = document.getElementById('pdfViewBtn');
    const view = !!(btn && getComputedStyle(btn).display !== 'none' && btn.getBoundingClientRect().width > 0);
    let dock = false;
    if (view) {
      localStorage.setItem('ch_pdf_side_by_side', '1');
      if (_pdfDock.open) closePdfDock();
      await viewCurrentExtractionPDF();
      await new Promise((r) => setTimeout(r, 800));
      dock = _pdfDock.open === true && !!document.querySelector('#pdfDockBody iframe, #pdfDockBody embed, #pdfDockBody object');
    }
    return {
      view, dock, b64: _pdfCurrentB64(),
      tabs: document.querySelectorAll('.ef-pill-btn').length,
      queueHasB64: /JVBER/.test(sessionStorage.getItem('ch_queue_state') || ''),
      queueLen: (sessionStorage.getItem('ch_queue_state') || '').length,
    };
  });

async function extract(page, url, files) {
  await page.goto(url);
  await page.waitForTimeout(3000);
  await page.evaluate(() => sv('pdf', null));
  await page.waitForTimeout(500);
  await page.setInputFiles('#pdfInput', files);
  await page.waitForFunction(
    () => (window._pdfMultiBills && window._pdfMultiBills.length) || (window._pdfQueue && window._pdfQueue.status === 'done'),
    null, { timeout: 90000 },
  );
  await page.waitForTimeout(3000);
}

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}/energy-department.html`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfview-files-'));
  const fA = path.join(dir, 'synthA.pdf');
  const fB = path.join(dir, 'synthB.pdf');
  fs.writeFileSync(fA, pdfA);
  fs.writeFileSync(fB, pdfB);
  const b64A = pdfA.toString('base64');
  const b64B = pdfB.toString('base64');
  const ctx = await launchBrowser('pdf-view-after-reload');
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR ' + e.message));
    await ctx.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    });

    // ---- One file, 3 bill tabs ----
    await extract(page, url, fA);
    for (let n = 0; n <= 2; n++) {
      if (n > 0) {
        await page.reload();
        await page.waitForTimeout(4500);
      }
      const r = await probe(page);
      const w = n === 0 ? 'single, after extraction' : 'single, after reload ' + n;
      ok(r.view, w + ': View PDF button visible');
      ok(r.dock, w + ': dock shows a PDF');
      ok(r.b64 === b64A, w + ': the PDF is the right file');
      ok(r.tabs > 1, w + ': bill tabs present (' + r.tabs + ')');
    }

    // ---- 2-file batch ----
    await extract(page, url, [fA, fB]);
    for (let n = 0; n <= 2; n++) {
      if (n > 0) {
        await page.reload();
        await page.waitForTimeout(4500);
      }
      const w = n === 0 ? 'batch, after extraction' : 'batch, after reload ' + n;
      for (const [idx, want, name] of [[0, b64A, 'file A'], [1, b64B, 'file B']]) {
        await page.evaluate((i) => selectQueueFile(i), idx);
        await page.waitForTimeout(800);
        const r = await probe(page);
        ok(r.view, w + ', ' + name + ': View PDF button visible');
        ok(r.dock, w + ', ' + name + ': dock shows a PDF');
        ok(r.b64 === want, w + ', ' + name + ': the PDF is the right file');
        if (n === 0 && idx === 0) ok(!r.queueHasB64, 'batch: ch_queue_state holds no base64 PDF (' + r.queueLen + ' chars)');
      }
    }
  } finally {
    await ctx.close();
    srv.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
