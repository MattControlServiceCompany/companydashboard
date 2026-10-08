// Gate: Compact PDF Storage must keep any PDF key a stored record still uses.
// Seeds (synthetic): A = presented-report key, B = bill key of a customer that is
// stored but has no project (never walked), C = control in en_pdf_bills (remapped,
// old key unreferenced). After Compact: A and B still load, C old key is gone.
// Env: APP_ROOT=<dir> to run against another checkout (for example main).
const path = require('path'), fs = require('fs'), http = require('http');
process.env.CH_PLAYWRIGHT_NODE_MODULES = process.env.CH_PLAYWRIGHT_NODE_MODULES ||
  path.join(process.env.CH_CONTEXT_DIR || path.join(require('os').homedir(), 'AI', '_context'), 'tools', 'playwright-runtime', 'node_modules');
module.paths.unshift(process.env.CH_PLAYWRIGHT_NODE_MODULES);
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(__dirname, 'launch-browser.js'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/energy-department.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
const mk = (t) => Buffer.from('%PDF-1.4\n% SYNTHETIC ' + t + '\n%%EOF').toString('base64');
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const url = 'http://localhost:' + srv.address().port + '/';
  const ctx = await launchBrowser('compact-keeps-refs');
  let failed = 0;
  const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; };
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await page.goto(url);
    await page.waitForFunction(() => typeof compactPdfStorage === 'function' && typeof DB !== 'undefined' && DB.isReady(), null, { timeout: 30000 });
    const o = await page.evaluate(async (b) => {
      const log = {};
      await pdfStore('en_pdf_shared_legacyAAA', b.a);
      await pdfStore('en_pdf_shared_legacyBBB', b.b);
      await pdfStore('en_pdf_shared_legacyCCC', b.c);
      await sset('en_presented_savings', [{ projectId: 'p1', periodStart: '2026-01', periodEnd: '2026-03', presentedAt: '2026-04-05T00:00:00Z', totalDollars: 1, buildings: { x: { dollars: 1 } }, pdfKey: 'en_pdf_shared_legacyAAA', pdfName: 'Q1.pdf' }]);
      await sset('en_utility_cust_unloaded', { buildings: [{ id: 'bX', name: 'Unloaded', meters: [{ id: 'mX', account: '123', bills: [{ id: 'r1', hasPDF: true, pdfKey: 'en_pdf_shared_legacyBBB' }] }] }] });
      await sset('en_pdf_bills', [{ id: 'pbC', hasPDF: true, pdfKey: 'en_pdf_shared_legacyCCC' }]);
      await pdfStore('en_pdf_shared_legacyDDD', b.d);
      await sset('en_bare_ref', { bills: [{ id: 'bd', _pdfSharedKey: 'legacyDDD' }] });
      log.run1 = await compactPdfStorage();
      log.A = !!(await pdfLoad('en_pdf_shared_legacyAAA'));
      log.B = !!(await pdfLoad('en_pdf_shared_legacyBBB'));
      log.Cold = !!(await pdfLoad('en_pdf_shared_legacyCCC'));
      const cNew = sget('en_pdf_bills', [])[0].pdfKey;
      log.cNew = cNew;
      log.Cnew = !!(await pdfLoad(cNew));
      log.presentedKey = sget('en_presented_savings', [])[0].pdfKey;
      log.D = !!(await pdfLoad('en_pdf_shared_legacyDDD'));
      log.run2 = await compactPdfStorage();
      log.A2 = !!(await pdfLoad('en_pdf_shared_legacyAAA'));
      log.B2 = !!(await pdfLoad('en_pdf_shared_legacyBBB'));
      return log;
    }, { a: mk('A'), b: mk('B'), c: mk('C'), d: mk('D') });
    console.log(JSON.stringify(o));
    check('presented-report PDF still loads after Compact', o.A && o.presentedKey === 'en_pdf_shared_legacyAAA');
    check('unwalked-customer PDF still loads after Compact', o.B);
    check('unreferenced control old key is gone', !o.Cold);
    check('control record remapped to a loading canonical key', o.Cnew && o.cNew !== 'en_pdf_shared_legacyCCC');
    check('second Compact keeps A and B', o.A2 && o.B2 && !o.run2.scanFailed);
    // Corrupt record: Compact must delete nothing. Toast wording for 1 and 2.
    const o2 = await page.evaluate(async (b) => {
      const log = {};
      const toasts = [];
      window.showToast = (m) => toasts.push(m);
      window.confirmAsync = async () => true;
      await sset('en_bare_ref', []);
      await pdfStore('en_pdf_shared_legacyEEE', b.e);
      await sset('en_pdf_bills', [{ id: 'pbE', hasPDF: true, pdfKey: 'en_pdf_shared_legacyEEE' }]);
      await sset('en_corrupt_rec', '{"pdfKey": broken');
      log.runBad = await compactPdfStorage();
      log.E = !!(await pdfLoad('en_pdf_shared_legacyEEE'));
      log.Ekeyok = !!(await pdfLoad(sget('en_pdf_bills', [])[0].pdfKey));
      await sset('en_corrupt_rec', []);
      // Toast wording: drive the real UI wrapper with a stubbed result.
      const base = { aborted: false, hashed: 5, unique: 3, remapped: 0, scanFailed: false, alreadyBroken: [], failedVerify: [] };
      const realCompact = window.compactPdfStorage;
      for (const [name, del, kept] of [['toast1', 1, 1], ['toast2', 2, 2], ['toast0', 0, 0]]) {
        window.compactPdfStorage = async () => Object.assign({}, base, { deleted: del, keptReferenced: kept });
        toasts.length = 0;
        await compactPdfStorageUI();
        log[name] = toasts.filter((t) => /done/.test(t))[0] || toasts.join(' | ');
      }
      window.compactPdfStorage = realCompact;
      return log;
    }, { e: mk('E') });
    console.log(JSON.stringify(o2));
    check('bare-id reference keeps its PDF', o.D);
    check('corrupt record: scan fails, nothing deleted, record untouched', o2.runBad.scanFailed && o2.runBad.deleted === 0 && o2.E && o2.Ekeyok);
    check('toast singular: 1 copy', /deleted 1 redundant copy\./.test(o2.toast1) && /Kept 1 copy that/.test(o2.toast1));
    check('toast plural: 2 copies', /Kept 2 copies that/.test(o2.toast2) && /deleted 2 redundant copies\./.test(o2.toast2) && /deleted 0 redundant copies\./.test(o2.toast0));
  } finally {
    await ctx.close();
    srv.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
