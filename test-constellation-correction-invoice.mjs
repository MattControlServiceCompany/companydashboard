// test-constellation-correction-invoice.mjs (item fm-20261008-k4): Constellation id on a CORRECTION invoice.
// Synthetic fixture only (fake ids, fake addresses). Loads the REAL app files via vm and calls the
// REAL UTILITY_RULES Constellation extractAll.
// A correction invoice has many "Service for" sections per site and ONE id header before them.
// The old 600-char tail missed that header (bill read ID-UNREAD, no address). The id window now
// runs from the last "Total Current Site Charges" line to the chunk.
// Run: node test-constellation-correction-invoice.mjs

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const LOAD_ORDER = [
  'lib/date-helpers.js', 'lib/formatting.js', 'lib/unit-conversion.js', 'lib/csv-parser.js',
  'computations/rates.js', 'computations/regression.js', 'computations/normalization.js',
  'computations/eui.js', 'computations/pollution.js', 'computations/csc.js', 'computations/savings.js',
  'computations/anomaly-detection.js', 'lib/perf-table.js', 'lib/shared-charts.js',
  'computations/report-data.js', 'computations/data-quality.js', 'app/db.js', 'app/core.js', 'app/utility-data.js',
  'app/energy-savings.js', 'app/bill-analysis.js',
];

function load() {
  const sandbox = {
    console,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
    document: {
      addEventListener() {}, getElementById: () => null, querySelector: () => null,
      createElement: () => ({ style: {}, getContext: () => null }),
    },
    navigator: { userAgent: 'node-constellation-id-test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Chart: function () {}, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }, Image: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const rel of LOAD_ORDER) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) continue;
    try { vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: rel }); } catch (e) { /* later files may need a DOM */ }
  }
  vm.runInContext(
    'this.__t = { rules: typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null,' +
      ' norm: typeof _constNormCustId !== "undefined" ? _constNormCustId : null,' +
      ' known: typeof _constKnownCustIds !== "undefined" ? _constKnownCustIds : null,' +
      ' addr: typeof _constAddrBefore !== "undefined" ? _constAddrBefore : null,' +
      ' gates: typeof _applyExtractionGates !== "undefined" ? _applyExtractionGates : null };',
    ctx,
  );
  return ctx.__t;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };

const T = load();
if (!T.rules || !T.norm || !T.known || !T.gates || !T.addr) { console.log('FAIL: app functions not loaded', Object.keys(T)); process.exit(1); }
const rule = T.rules.find((r) => /Constellation/.test(r.name));




const head = '%%PAGE_1%%\nMonthly Invoice\nConstellation   Invoice Date: 06/19/30   Account ID: BG-000001\nInvoice Number: 7001\nSample Customer\n';
const idBlock = (n, id) => n + ' Test St, Baldwin City, KS 66006\nCustomer ID: RG-' + id + '\n';
const sec = (mon, total) => 'Service for ' + mon + '-2030 - Actual\nIncremental Costs  10.00 MMBtu  $4.00000  $40.00\n' +
  (total ? 'Total Current Site Charges $' + total + '\n' : '');
const find = (bills, id) => bills.find((b) => b.AccountNumber === 'RG' + id);

// 1. Normal invoice: one section per site, ids map to their own sites.
{
  let t = head + idBlock(1, '111111') + sec('Mar', '101.00') + idBlock(2, '222222') + sec('Mar', '202.00') + idBlock(3, '333333') + sec('Mar', '303.00');
  const b = rule.extractAll(t);
  ok(b.length === 3, 'normal: 3 rows, got ' + b.length);
  for (const [id, tot, n] of [['111111', 101, 1], ['222222', 202, 2], ['333333', 303, 3]]) {
    const x = find(b, id);
    ok(!!x && Number(x.TotalCurrentCharges) === tot, 'normal: ' + id + ' total ' + tot);
    ok(!!x && x.ServiceAddress === n + ' Test St, Baldwin City, KS 66006', 'normal: ' + id + ' own address');
  }
}

// 2. Correction invoice: header id A + 4 sections for block A, header id B + 4 sections for block B.
{
  const block = (n, id, withHeader) => (withHeader ? idBlock(n, id) : '') + sec('Jan', null) + sec('Feb', null) + sec('Mar', null) + sec('Apr', n * 100 + '.00');
  let t = head + idBlock(1, '444444') + sec('Jan', null) + sec('Feb', null) + sec('Mar', null) + sec('Apr', '100.00') +
    block(2, '555555', true);
  const b = rule.extractAll(t);
  ok(b.filter((x) => x._acctIdUnread).length === 0, 'correction: 0 ID-UNREAD rows, got ' + b.filter((x) => x._acctIdUnread).length);
  const A = find(b, '444444');
  const B = find(b, '555555');
  ok(!!A && Number(A.TotalCurrentCharges) === 100, 'correction: block A id on block A total 100');
  ok(!!B && Number(B.TotalCurrentCharges) === 200, 'correction: block B id on block B total 200');
  ok(!!A && A.ServiceAddress === '1 Test St, Baldwin City, KS 66006', 'correction: block A address present, got ' + (A && A.ServiceAddress));
  ok(!!B && B.ServiceAddress === '2 Test St, Baldwin City, KS 66006', 'correction: block B address present, got ' + (B && B.ServiceAddress));
}

// 3. Guard: normal invoice, site 2 id removed -> ID-UNREAD for site 2, NOT site 1's id.
{
  let t = head + idBlock(1, '111111') + sec('Mar', '101.00') + '2 Test St, Baldwin City, KS 66006\n' + sec('Mar', '202.00') + idBlock(3, '333333') + sec('Mar', '303.00');
  const b = rule.extractAll(t);
  const u = b.filter((x) => x._acctIdUnread);
  ok(u.length === 1 && Number(u[0].TotalCurrentCharges) === 202, 'guard: site 2 stays ID-UNREAD with its own total');
  ok(b.filter((x) => x.AccountNumber === 'RG111111').length === 1, 'guard: site 1 id is not reused for site 2');
}

console.log(pass + '/' + (pass + fail) + ' assertions passed');
process.exit(fail ? 1 : 0);
