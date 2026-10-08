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
const pdfC = makePdf([billPage('3000003', '05/01/2026', '05/31/2026', '400.00')]);

let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};


// Sync-queue stub: _pdfEnqueue is the only function that starts an upload. No server is called.
const stub = (page, syncOn) =>
  page.evaluate((on) => {
    window.__enq = [];
    window._pdfEnqueue = (t, k) => window.__enq.push(t + ':' + k);
    window.CH_AUTH.isSyncHost = () => on;
    window.CH_AUTH.backendMode = () => (on ? 'on' : 'off');
  }, syncOn);
const enq = (page) => page.evaluate(() => window.__enq.slice());
const reset = (page) => page.evaluate(() => (window.__enq = []));

async function extractOnly(page, url, files, syncOn) {
  await page.goto(url);
  await page.waitForTimeout(3000);
  await page.evaluate(async () => {
    sv('pdf', null);
    localStorage.removeItem('ch_pdf_local_only');
    for (const k of await _pdfExportAllKeys()) await pdfDelete(k);
  });
  await stub(page, syncOn);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfgate-files-'));
  const fA = path.join(dir, 'synthA.pdf');
  const fB = path.join(dir, 'synthB.pdf');
  const fD = path.join(dir, 'synthD.pdf');
  fs.writeFileSync(fA, pdfA);
  fs.writeFileSync(fB, pdfB);
  fs.writeFileSync(fD, pdfC);
  const ctx = await launchBrowser('pdf-upload-gating');
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR ' + e.message));
    await ctx.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    });
    for (const syncOn of [true, false]) {
      const w = syncOn ? 'sync ON' : 'sync OFF';
      const one = syncOn ? 1 : 0;
      // ---- single file ----
      await extractOnly(page, url, fA, syncOn);
      let e = await enq(page);
      ok(e.length === 0, w + ': single extraction enqueues 0 uploads (' + e.length + ')');
      const srcKey = await page.evaluate(() => window._pdfSrcKey || null);
      // Save: the shared store used by every save path
      const key = await page.evaluate(() => _ensureBatchPdfStored(window._pdfMultiBills));
      e = await enq(page);
      ok(e.length === one && (!syncOn || e[0] === 'upload:' + key), w + ': single save enqueues ' + one + ' upload for its key (' + e.join(',') + ')');
      await page.evaluate(() => _ensureBatchPdfStored(window._pdfMultiBills));
      ok((await enq(page)).length === one, w + ': saving again adds no upload (' + (await enq(page)).length + ')');
      await reset(page);
      // Attach the same file (blob already local from extraction on the branch)
      const att = await page.evaluate(async (b64) => {
        const bill = { id: 'x1' };
        const r = await bpaAttachFile({ b64, bills: [bill], deps: { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore, ensureUploaded: typeof pdfEnsureUploaded === "function" ? pdfEnsureUploaded : undefined } });
        const r2 = await bpaAttachFile({ b64, bills: [bill], deps: { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore, ensureUploaded: typeof pdfEnsureUploaded === "function" ? pdfEnsureUploaded : undefined } });
        return { key: r.key, stored: r.stored, again: window.__enq.length, r2: r2.stored };
      }, pdfA.toString('base64'));
      e = await enq(page);
      if (srcKey) {
        ok(att.key === srcKey, w + ': attach uses the extraction key');
        ok(e.length === one && (!syncOn || e[0] === 'upload:' + srcKey), w + ': attach of an extracted PDF, twice, enqueues ' + one + ' upload (' + e.join(',') + ')');
      } else {
        ok(e.length === one, w + ': (main) attach of a new PDF, twice, enqueues ' + one + ' upload (' + e.join(',') + ')');
      }
      // Attach a never-extracted file: normal store path = 1 upload, same as main
      await reset(page);
      await page.evaluate(async (b64) => {
        const d = { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore, ensureUploaded: typeof pdfEnsureUploaded === "function" ? pdfEnsureUploaded : undefined };
        await bpaAttachFile({ b64, bills: [{ id: 'x2' }], deps: d });
        await bpaAttachFile({ b64, bills: [{ id: 'x2' }], deps: d });
      }, pdfC.toString('base64'));
      e = await enq(page);
      ok(e.length === one, w + ': attach of a new PDF, twice, enqueues ' + one + ' upload, same as main (' + e.length + ')');

      // ---- 2-file batch ----
      await extractOnly(page, url, [fA, fB], syncOn);
      e = await enq(page);
      ok(e.length === 0, w + ': batch extraction enqueues 0 uploads (' + e.length + ')');
      const keys = await page.evaluate(async () => {
        const out = [];
        for (const r of window._pdfQueue.results) {
          const prev = pdfB64;
          pdfB64 = r.pdfB64;
          try { out.push(await _ensureBatchPdfStored(r.bills)); } finally { pdfB64 = prev; }
        }
        return out;
      });
      e = await enq(page);
      ok(e.length === one * 2 && (!syncOn || keys.every((k) => e.includes('upload:' + k))), w + ': batch save enqueues ' + one + ' upload per saved bill file (' + e.join(',') + ')');
    }
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
