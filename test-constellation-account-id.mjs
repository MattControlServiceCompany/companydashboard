// test-constellation-account-id.mjs (item 62a38985): Constellation per-site account id.
// Synthetic fixture only (no client data). Loads the REAL app files via vm, calls the REAL
// UTILITY_RULES Constellation extractAll and _applyExtractionGates.
// Covers: dotted id, damaged label, one-digit slip, two candidates (ambiguous, and
// narrowed by "already read in this invoice"), the site-1 collision, and the unreadable-id row.
// Run: node test-constellation-account-id.mjs

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
      ' gates: typeof _applyExtractionGates !== "undefined" ? _applyExtractionGates : null };',
    ctx,
  );
  return ctx.__t;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };

const T = load();
if (!T.rules || !T.norm || !T.known || !T.gates) { console.log('FAIL: app functions not loaded', Object.keys(T)); process.exit(1); }
const rule = T.rules.find((r) => /Constellation/.test(r.name));

// ---- synthetic invoice builder -------------------------------------------------------
// idLines[k] = the exact "Customer ID" text printed before site k+1 (null = label lost).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
function invoice(n, idLines) {
  let s = '%%PAGE_1%%\nMonthly Invoice\nConstellation   Invoice Date: 0' + (n + 1) + '/16/30   Account ID: BG-000001\n' +
    'Invoice Number: ' + (7000 + n) + '\nSample Customer\n1 Sample Way\n';
  if (idLines[0]) s += idLines[0] + '\n';
  s += '1 Test St, Baldwin City, KS 66006\n';
  for (let k = 0; k < 3; k++) {
    const total = (100 * (k + 1) + n + 1).toFixed(2);
    s += 'Service for ' + MON[n] + '-2030 - Actual\n';
    s += 'Incremental Costs  10.00 MMBtu  $4.00000  $40.00\nSubtotal Gas Supply Charges  10.00 MMBtu  $40.00\n';
    s += 'Total Current Site Charges $' + total + '\n';
    if (k < 2) {
      if (idLines[k + 1]) s += idLines[k + 1] + '\n';
      s += (k + 2) + ' Test St, Baldwin City, KS 66006\n';
    }
  }
  return s;
}
const C = (d) => 'Customer ID: RG-' + d;
const clean = [C('900001'), C('900002'), C('900003')];
const invoices = [
  clean, // Jan (month 1) all clean
  [C('900001'), 'Customer ID: RG.900002', 'Customer I: RG-900003'], // Feb: dotted id, damaged label
  clean, // Mar
  clean, // Apr
  [C('900001'), 'Customer ID: RG.900082', C('900003')], // May: one-digit slip, one candidate
  [C('900001'), 'Customer ID: RG.900009', C('900003')], // Jun: 3 candidates, 2 already read here -> snaps to 900002
  [C('900001'), 'Customer ID: RG.900009', 'Customer ID: RG.900008'], // Jul: two candidates left -> NO snap
  [C('900001'), C('900002'), null], // Aug: site 3 label lost entirely
];
const text = invoices.map((l, n) => invoice(n, l)).join('\n');
const bills = rule.extractAll(text);
const find = (acct, mon) => bills.find((b) => b.AccountNumber === acct && b.BillingPeriodStart === '0' + mon + '/01/2030');
const tot = (acct, mon) => { const b = find(acct, mon); return b ? Number(b.TotalCurrentCharges) : null; };
// site k total in invoice n (month n+1) = 100*k + n + 1

ok(bills.length === 24, 'row count 24, got ' + bills.length);
ok(tot('RG900002', 2) === 202, 'dotted id (Feb site 2) -> RG900002 202, got ' + tot('RG900002', 2));
ok(tot('RG900003', 2) === 302, 'damaged label (Feb site 3) -> RG900003 302, got ' + tot('RG900003', 2));
ok(tot('RG900002', 5) === 205, 'one-digit slip 900082 -> RG900002 (May 205), got ' + tot('RG900002', 5));
ok(tot('RG900002', 6) === 206, 'two-candidate id narrowed by ids already read in invoice -> RG900002 (Jun 206), got ' + tot('RG900002', 6));
ok(tot('RG900009', 7) === 207 && tot('RG900008', 7) === 307, 'ambiguous id NOT snapped (Jul keeps raw RG900009 / RG900008)');
ok(tot('RG900001', 8) === 108, 'collision: site 1 Aug total survives (108), got ' + tot('RG900001', 8));
const unread = bills.find((b) => b._acctIdUnread);
ok(!!unread && unread.AccountNumber !== 'RG900001' && Number(unread.TotalCurrentCharges) === 308, 'unreadable id row kept, marked, own account, own total 308');
ok(bills.filter((b) => b._acctIdUnread).length === 1, 'exactly one unreadable row');
for (const b of bills) ok(b._acctIdUnread || /^RG\d+$/.test(b.AccountNumber), 'no LDC/other fallback account: ' + b.AccountNumber);
const keys = new Set(bills.map((b) => b.AccountNumber + '|' + b.BillingPeriodStart));
ok(keys.size === bills.length, 'no duplicate (account, month)');

// gate: the bill review must hold the unreadable row
if (unread) {
  const g = { ...unread };
  T.gates([g], null, null, null);
  ok(g._gateTripped === true && /not guessed/.test((g._gateReasons || []).join(' ')), 'unreadable id row trips a review gate with a reason');
}

// normalizer unit cases
const known = ['900001', '900002', '900003'];
ok(T.norm('RG.900002', known) === 'RG900002', 'norm: dotted');
ok(T.norm('RG900002', known) === 'RG900002', 'norm: no separator');
ok(T.norm('RG-900082', known) === 'RG900002', 'norm: one-digit slip snaps');
ok(T.norm('RG-900009', known) === 'RG900009', 'norm: three candidates, no seen set -> raw');
ok(T.norm('RG-9000000', known) === 'RG9000000', 'norm: different length -> raw');
ok(T.norm('RG-900082', null) === 'RG900082', 'norm: no known set -> raw');
ok(T.norm('Customer', known) === null, 'norm: not an RG id -> null');
ok(T.known('Customer ID: RG-1\nCustomer ID: RG-1\nCustomer ID: RG.2\nCustomer ID: RG-1').join() === '1', 'known set: hyphen form 3+ only');

console.log(pass + '/' + (pass + fail) + ' assertions passed');
process.exit(fail ? 1 : 0);
