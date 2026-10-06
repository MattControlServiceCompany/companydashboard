// test-constellation-account-id.mjs (item 62a38985): Constellation per-site account id.
// Synthetic fixture only (no client data). Loads the REAL app files via vm, calls the REAL
// UTILITY_RULES Constellation extractAll and _applyExtractionGates.
// Covers: dotted id, damaged label, one-digit slip (snaps only when the service address matches the
// known id's address), a clean new id one digit from a known id (no snap), the site-1 collision, and the unreadable-id row.
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

// ---- synthetic invoice builder -------------------------------------------------------
// idLines[k] = the exact "Customer ID" text printed before site k+1 (null = label lost).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
function invoice(n, idLines) {
  let s = '%%PAGE_1%%\nMonthly Invoice\nConstellation   Invoice Date: 0' + (n + 1) + '/16/30   Account ID: BG-000001\n' +
    'Invoice Number: ' + (7000 + n) + '\nSample Customer\n1 Sample Way\n';
  // Real layout: the service address is printed BEFORE the Customer ID, then "Service for".
  s += '1 Test St, Baldwin City, KS 66006\n';
  if (idLines[0]) s += idLines[0] + '\n';
  for (let k = 0; k < 3; k++) {
    const total = (100 * (k + 1) + n + 1).toFixed(2);
    s += 'Service for ' + MON[n] + '-2030 - Actual\n';
    s += 'Incremental Costs  10.00 MMBtu  $4.00000  $40.00\nSubtotal Gas Supply Charges  10.00 MMBtu  $40.00\n';
    s += 'Total Current Site Charges $' + total + '\n';
    if (k < 2) {
      s += (k + 2) + ' Test St, Baldwin City, KS 66006\n';
      if (idLines[k + 1]) s += idLines[k + 1] + '\n';
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
  [C('900001'), 'Customer ID: RG.900009', C('900003')], // Jun: 3 neighbours; address "2 Test St" matches only 900002 -> snaps
  [C('900001'), 'Customer ID: RG.900009', 'Customer ID: RG.900008'], // Jul: both snap by address (2 -> 900002, 3 -> 900003)
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
ok(tot('RG900002', 6) === 206, 'three-neighbour slip id snapped by service address -> RG900002 (Jun 206), got ' + tot('RG900002', 6));
ok(tot('RG900002', 7) === 207 && tot('RG900003', 7) === 307, 'Jul slips snap by address to RG900002 / RG900003, got ' + tot('RG900002', 7) + '/' + tot('RG900003', 7));
ok(tot('RG900001', 8) === 108, 'collision: site 1 Aug total survives (108), got ' + tot('RG900001', 8));
const unread = bills.find((b) => b._acctIdUnread);
ok(!!unread && unread.AccountNumber !== 'RG900001' && Number(unread.TotalCurrentCharges) === 308, 'unreadable id row kept, marked, own account, own total 308');
ok(bills.filter((b) => b._acctIdUnread).length === 1, 'exactly one unreadable row');
for (const b of bills) ok(b._acctIdUnread || /^RG\d+$/.test(b.AccountNumber), 'no LDC/other fallback account: ' + b.AccountNumber);
const keys = new Set(bills.map((b) => b.AccountNumber + '|' + b.BillingPeriodStart));
ok(keys.size === bills.length, 'no duplicate (account, month)');

// ServiceAddress (review 3): each bill carries its OWN site address (non-null, no leak from another site).
for (const b of bills) {
  const siteNo = Math.floor(Number(b.TotalCurrentCharges) / 100);
  ok(b.ServiceAddress === siteNo + ' Test St, Baldwin City, KS 66006', 'ServiceAddress is own site ' + siteNo + ' address, got ' + b.ServiceAddress + ' (' + b.AccountNumber + ' ' + b.BillingPeriodStart + ')');
}

// gate: the bill review must hold the unreadable row
if (unread) {
  const g = { ...unread };
  T.gates([g], null, null, null);
  ok(g._gateTripped === true && /not guessed/.test((g._gateReasons || []).join(' ')), 'unreadable id row trips a review gate with a reason');
}

// Review case (bb5947a): a REAL new account RG-900012 (clean read, only 2 times in the file) is one digit
// from known RG-900002. It must keep its own account and must not overwrite real site 2.
{
  const idsNew = [C('900001'), C('900002'), C('900012')];
  const t2 = [clean, clean, clean, clean, clean, clean, idsNew, idsNew].map((l, n) => invoice(n, l)).join('\n');
  const b2 = rule.extractAll(t2);
  const g = (acct, mon) => { const b = b2.find((x) => x.AccountNumber === acct && x.BillingPeriodStart === '0' + mon + '/01/2030'); return b ? Number(b.TotalCurrentCharges) : null; };
  ok(b2.length === 24, 'new-account case keeps all 24 rows, got ' + b2.length);
  ok(g('RG900002', 7) === 207 && g('RG900002', 8) === 208, 'real site 2 Jul/Aug NOT overwritten');
  ok(g('RG900012', 7) === 307 && g('RG900012', 8) === 308, 'clean new id RG900012 keeps its own account (not snapped)');
}

// Review rule (Manager 2026-10-05): a one-digit-near id whose service address is NOT the known id's
// address keeps its own id, even when the read is damaged (dotted).
{
  const idsDot = [C('900001'), C('900002'), 'Customer ID: RG.900012'];
  const t3 = [clean, clean, clean, clean, clean, idsDot].map((l, n) => invoice(n, l)).join('\n');
  const b3 = rule.extractAll(t3);
  ok(b3.length === 18, 'dotted new-id case keeps all 18 rows, got ' + b3.length);
  const x = b3.find((b) => b.AccountNumber === 'RG900012' && b.BillingPeriodStart === '06/01/2030');
  ok(!!x && Number(x.TotalCurrentCharges) === 306, 'dotted RG.900012 at site 3 address keeps own id (306)');
}

// ServiceAddress: every bill gets its OWN site address (never null, never another site's).
// Site k prints "k Test St" before its Customer ID; the unreadable-id row (Aug site 3) too.
for (const b of bills) {
  const want = b._acctIdUnread ? '3 Test St, Baldwin City, KS 66006' : null;
  const site = Math.round((Number(b.TotalCurrentCharges) - 1) / 100);
  ok(b.ServiceAddress === (want || site + ' Test St, Baldwin City, KS 66006'), 'ServiceAddress own site, got ' + b.ServiceAddress + ' for total ' + b.TotalCurrentCharges);
}
ok(bills.every((b) => b.ServiceAddress), 'no null ServiceAddress');

// normalizer unit cases
const known = new Map([['900001', new Set(['1 test'])], ['900002', new Set(['2 test'])], ['900003', new Set(['3 test'])]]);
const A2 = '2 Test St, Baldwin City, KS 66006';
ok(T.norm('RG.900002', known) === 'RG900002', 'norm: dotted');
ok(T.norm('RG900002', known) === 'RG900002', 'norm: no separator');
ok(T.norm('RG-900082', known, A2) === 'RG900002', 'norm: one-digit slip + matching address snaps');
ok(T.norm('RG-900082', known) === 'RG900082', 'norm: no address -> no snap');
ok(T.norm('RG-900082', known, '3 Test St, Baldwin City, KS 66006') === 'RG900082', 'norm: other account address -> no snap');
ok(T.norm('RG-9000000', known, A2) === 'RG9000000', 'norm: different length -> raw');
ok(T.norm('RG-900082', null, A2) === 'RG900082', 'norm: no known set -> raw');
ok(T.norm('Customer', known, A2) === null, 'norm: not an RG id -> null');
const kk = T.known('1 Main St, Baldwin City, KS 66006\nCustomer ID: RG-1\nCustomer ID: RG-1\nCustomer ID: RG.2\nCustomer ID: RG-1');
ok([...kk.keys()].join() === '1' && kk.get('1').has('1 main'), 'known set: hyphen form 3+ only, with address key');

// Review 2 (2026-10-05): address line with an extra facility-name segment, and the window stops at the previous block.
{
  const AB = T.addr;
  const mab = 'Total Current Site Charges $1.00\n\nTest Facility KS\n\n5 Test St, Gym Name, Baldwin City, KS 66006-4202\n\nCustomer ID: RG-900579\n';
  ok(AB(mab, mab.indexOf('Customer ID')) === '5 Test St, Gym Name, Baldwin City, KS 66006-4202', 'addr: extra comma segment parsed');
  const leak = '9 Old St, Baldwin City, KS 66006\nCustomer ID: RG-900001\nTotal Current Site Charges $2.00\n\nNo address here\nCustomer ID: RG-900002\n';
  ok(AB(leak, leak.lastIndexOf('Customer ID')) === null, 'addr: window stops at previous block (no leak from prior site)');
  const known2 = new Map([['900579', new Set(['5 test'])], ['900001', new Set(['9 test'])]]);
  ok(T.norm('RG-900679', known2, AB(mab, mab.indexOf('Customer ID'))) === 'RG900579', 'norm: Mabee-style misread snaps to its known id');
  const blk = '5 Test St, Gym Name, Baldwin City, KS 66006\nCustomer ID: RG-900579\nTotal Current Site Charges $1.00\n';
  const kn = T.known(blk + blk + blk + '7 Other St, Baldwin City, KS 66006\nCustomer ID: RG-90000046\nTotal Current Site Charges $1.00\n');
  ok(kn.get('900579') && kn.get('900579').has('5 test') && kn.get('900579').size === 1, 'known: Mabee-style id bound to its own address only');
  ok(T.norm('RG90000046', kn, '7 Other St, Baldwin City') === 'RG90000046', 'norm: real distinct id stays unsnapped');
}

console.log(pass + '/' + (pass + fail) + ' assertions passed');
process.exit(fail ? 1 : 0);
