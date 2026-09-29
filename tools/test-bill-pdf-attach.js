// WP-31 acceptance test (synthetic data only): attach a PDF to existing bills without extraction.
const assert = require('assert');
const path = require('path');
let mod;
try { mod = require(path.join(__dirname, '..', 'app', 'bill-pdf-attach.js')); }
catch (e) { console.error('FAIL: app/bill-pdf-attach.js not loadable:', e.message); process.exit(1); }
const store = new Map();
let storeCalls = 0;
const deps = {
  hash: async (b64) => require('crypto').createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'),
  load: async (k) => store.get(k) || null,
  store: async (k, v) => { storeCalls++; store.set(k, v); return true; },
};
const mk = (i) => ({ id: 'b' + i, start: '2026-01-01', end: '2026-01-31', therms: 100 + i, totalCost: 50.5 + i, kwh: 7 });
(async () => {
  const bills = [mk(1), mk(2), mk(3)];
  const before = JSON.stringify(bills);
  const b64 = Buffer.from('%PDF-1.4 synthetic one').toString('base64');
  const r = await mod.bpaAttachFile({ b64, bills, deps });
  assert(r.key && /^en_pdf_shared_[0-9a-f]{16}$/.test(r.key), 'key form');
  assert(bills.every((b) => b.pdfKey === r.key && b.hasPDF === true), 'same pdfKey on 3 bills');
  assert.strictEqual(store.size, 1, 'one blob'); assert.strictEqual(storeCalls, 1);
  const strip = (b) => { const c = { ...b }; delete c.pdfKey; delete c.hasPDF; return c; };
  assert.strictEqual(JSON.stringify(bills.map(strip)), before, 'no other field changed');
  // same file again: no second store
  await mod.bpaAttachFile({ b64, bills: [mk(9)], deps });
  assert.strictEqual(storeCalls, 1, 'identical file stored once');
  // page range
  const b4 = mk(4);
  const r2 = await mod.bpaAttachFile({ b64: Buffer.from('%PDF second').toString('base64'), bills: [b4], pageStart: 2, pageEnd: 3, deps });
  assert.strictEqual(b4.pdfPageStart, 2); assert.strictEqual(b4.pdfPageEnd, 3); assert.strictEqual(store.size, 2);
  // replace with no range clears the old range
  await mod.bpaAttachFile({ b64, bills: [b4], deps });
  assert(b4.pdfPageStart === undefined && b4.pdfPageEnd === undefined && b4.pdfKey === r.key, 'range cleared on replace');
  // replace ask: conflicts listed; never deletes blobs
  const conflicts = mod.bpaFindConflicts([mk(5), { ...mk(6), pdfKey: 'en_pdf_shared_x' }, { ...mk(7), pdfKey: r.key }], r.key);
  assert.deepStrictEqual(conflicts.map((b) => b.id), ['b6'], 'only bills with a different PDF need a question');
  assert.strictEqual(store.size, 2, 'no blob deleted');
  // store failure leaves bills untouched
  const b8 = mk(8);
  const bad = await mod.bpaAttachFile({ b64: Buffer.from('zz').toString('base64'), bills: [b8], deps: { ...deps, store: async () => false } });
  assert.strictEqual(bad, null); assert(!('pdfKey' in b8));
  console.log('PASS test-bill-pdf-attach');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
