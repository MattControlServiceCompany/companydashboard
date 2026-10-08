/**
 * test-pdf-batch-key.js
 * Gate: _ensureBatchPdfStored must key a PDF by its content hash, never by the clock.
 * Two different PDFs saved in the same millisecond (Date.now stubbed) get different keys and each
 * loads its own bytes. The same PDF twice gets one key and one upload. SYNTHETIC data only.
 * Usage: node tools/test-pdf-batch-key.js   (env APP_ROOT=<checkout>, CH_PLAYWRIGHT_NODE_MODULES)
 */
const path = require('path');
const fs = require('fs');
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
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}/energy-department.html`;
  const ctx = await launchBrowser('pdf-batch-key');
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR ' + e.message));
    await ctx.addInitScript(() => {
      localStorage.setItem('ch_qs_seen', '1');
      const u = JSON.stringify({ name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false });
      localStorage.setItem('ch_user', u);
      sessionStorage.setItem('ch_user', u);
    });
    await page.goto(url);
    await page.waitForTimeout(3000);
    for (const syncOn of [true, false]) {
      const w = syncOn ? 'sync ON' : 'sync OFF';
      const r = await page.evaluate(async (on) => {
        window.__enq = [];
        window._pdfEnqueue = (t, k) => window.__enq.push(t + ':' + k);
        window.CH_AUTH.isSyncHost = () => on;
        window.CH_AUTH.backendMode = () => (on ? 'on' : 'off');
        const realNow = Date.now;
        Date.now = () => 1790000000000;
        const tag = on ? 'ON' : 'OFF';
        const b64A = btoa('%PDF-1.4 SYNTHETIC A ' + tag);
        const b64B = btoa('%PDF-1.4 SYNTHETIC B ' + tag);
        const billA = [{ id: 'a' }];
        const billB = [{ id: 'b' }];
        const billA2 = [{ id: 'a2' }];
        try {
          pdfB64 = b64A;
          const kA = await _ensureBatchPdfStored(billA);
          pdfB64 = b64B;
          const kB = await _ensureBatchPdfStored(billB);
          pdfB64 = b64A;
          const kA2 = await _ensureBatchPdfStored(billA2);
          return {
            kA, kB, kA2,
            loadA: (await pdfLoad(billA[0]._pdfSharedKey)) === b64A,
            loadB: (await pdfLoad(billB[0]._pdfSharedKey)) === b64B,
            enq: window.__enq.slice(),
          };
        } finally {
          Date.now = realNow;
        }
      }, syncOn);
      ok(r.kA && r.kB && r.kA !== r.kB, w + ': two different PDFs, same millisecond, get different keys (' + r.kA + ' / ' + r.kB + ')');
      ok(r.loadA && r.loadB, w + ': each bill opens its own PDF');
      ok(r.kA === r.kA2, w + ': the same PDF twice gets one key');
      const n = syncOn ? 2 : 0;
      ok(r.enq.length === n, w + ': uploads queued = ' + n + ' (' + r.enq.join(',') + ')');
    }
  } finally {
    await ctx.close();
    srv.close();
  }
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
