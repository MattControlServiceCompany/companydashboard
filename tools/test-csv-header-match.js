/**
 * test-csv-header-match.js  (fm-20261007-k8)
 *
 * The CSV import cost column must never land on an id, number or date header.
 *  1. Bill ID + Bill Amount ($) headers: totalCost comes from Bill Amount.
 *  2. Plain total_cost still works.
 *  3. A file whose only cost header is "Bill" still works.
 *  4. "Bill #", "Bill Number", "Bill Date" are never the cost column.
 *  5. One rule for ALL columns (ci() in app/csv-import.js): exact header first, then whole-word match;
 *     a cost/id/date header is claimed only by aliases of the same class. Energy Cost is not kWh,
 *     Demand Cost is not kW, Total is not an end date, Bill ID is not cost.
 * Synthetic data only. Usage: node tools/test-csv-header-match.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const REPO = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}
const noop = () => {};
const els = {};
const elFor = (id) => (els[id] = els[id] || { textContent: '', innerHTML: '', style: {}, classList: { add: noop, remove: noop } });
const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop, contains: () => false } : noop),
  apply: () => el,
});
const sb = {
  document: { getElementById: elFor, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => el, body: el },
  console: { log: noop, warn: noop, error: noop },
  navigator: { userAgent: 'node' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop, requestAnimationFrame: () => 0,
  addEventListener: noop, removeEventListener: noop, showToast: noop, fetch: () => Promise.reject(new Error('no fetch')),
  forEachCustomerBuilding: noop, sget: (k, d) => d, sset: noop, projects: [], TextEncoder, TextDecoder,
};
sb.window = sb;
sb.globalThis = sb;
vm.createContext(sb);
for (const rel of ['lib/formatting.js', 'computations/rates.js', 'computations/savings.js', 'app/utility-data.js', 'app/csv-import.js']) {
  try {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sb, { filename: rel });
  } catch (e) {
    check('load ' + rel, false, String(e && e.message).split('\n')[0]);
  }
}
const R = (s) => vm.runInContext(s, sb);
R(
  'var __t = { m: null, toasts: [] }; resolveUDMeter = function () { return { b: { id: "b1", meters: [] }, m: __t.m }; };' +
    '_syncEmbedUDContext = function () {}; saveUtilityData = function () {}; closeBillCsvModal = function () {};' +
    'renderMeterWorkspace = function () {}; addNotif = function () {};',
);
function freshMeter() {
  return {
    id: 'm1',
    commodity: 'Electric',
    bills: [
      { id: 'keep-id', start: '2026-01-01', end: '2026-01-31', kwh: '1000', demandKW: '412.5', totalCost: '9056.10', demandCharge: '2500.00', onPeakKwh: '500', fromPDF: true },
      { id: 'other', start: '2026-02-01', end: '2026-02-28', kwh: '900', demandKW: '400', totalCost: '8000' },
    ],
  };
}
function load(meter, csv) {
  sb.__meter = meter;
  R('__t.m = __meter; _csvImportMid = "m1"');
  R('parseBillCsv')(csv, 't.csv');
}
const num = (v) => (v == null ? v : +String(v).replace(/,/g, ''));

function costOf(csv) {
  const m = freshMeter();
  load(m, csv);
  R('importBillCsvRows')();
  const b = m.bills.find((x) => x.start === '2026-01-01');
  return b ? num(b.totalCost) : undefined;
}
const row = (h, v) => h + '\n' + v + '\n';
check('Bill ID + Bill Amount ($): cost = Bill Amount',
  costOf(row('Start Date,End Date,Bill ID,Usage (kWh),Peak Demand (kW),Bill Amount ($)', '2026-01-01,2026-01-31,B-1001,1000,50,1234.56')) === 1234.56);
check('Bill ID before total_cost: cost = total_cost',
  costOf(row('start_date,end_date,bill_id,kwh,total_cost', '2026-01-01,2026-01-31,77,1000,222.5')) === 222.5);
check('plain total_cost works', costOf(row('start_date,end_date,kwh,total_cost', '2026-01-01,2026-01-31,1000,333.25')) === 333.25);
check('only "Bill" header works', costOf(row('start_date,end_date,kwh,Bill', '2026-01-01,2026-01-31,1000,444.75')) === 444.75);
check('Bill # then Amount: cost = Amount', costOf(row('start_date,end_date,Bill #,kwh,Amount', '2026-01-01,2026-01-31,9,1000,555')) === 555);
check('Bill Number then Bill Amount', costOf(row('start_date,end_date,Bill Number,kwh,Bill Amount', '2026-01-01,2026-01-31,9,1000,666')) === 666);
check('Bill Date is never cost (stored cost kept)', costOf(row('start_date,end_date,Bill Date,kwh', '2026-01-01,2026-01-31,2026-02-05,1000')) === 9056.1);

// ---- one rule for every column: map a header set, read every field back ----
function mapped(h, v) {
  const m = { id: 'm1', commodity: 'Electric', bills: [] };
  load(m, row(h, v));
  R('importBillCsvRows')();
  const b = m.bills[0] || {};
  return { start: b.start, end: b.end, kwh: num(b.kwh), kw: num(b.demandKW), fac: num(b.facKW), cost: num(b.totalCost) };
}
const same = (a, e) => JSON.stringify(a) === JSON.stringify(e);
const E1 = { start: '2026-01-01', end: '2026-01-31', kwh: 1000, kw: 50, fac: undefined, cost: 1234.56 };
let g = mapped('Start Date,End Date,Bill ID,Energy Cost,Energy (kWh),Demand Cost,Demand (kW),Bill Amount ($)', '2026-01-01,2026-01-31,B-1,111,1000,222,50,1234.56');
check('Energy Cost / Energy (kWh) / Demand Cost / Demand (kW) / Bill ID / Bill Amount', same(g, E1), g);
g = mapped('Total,Start Date,To Date,kWh,Peak kW,Bill Amount', '999,2026-01-01,2026-01-31,1000,50,1234.56');
check('Total before To Date: end = To Date, not Total', same(g, E1), g);
g = mapped('Total,From,End Date,kWh,Peak kW,Bill Amount', '999,2026-01-01,2026-01-31,1000,50,1234.56');
check('Total before End Date: end = End Date', same(g, E1), g);
g = mapped('Energy Cost,Demand Cost,Start,End,Energy,Demand,Total', '111,222,2026-01-01,2026-01-31,1000,50,1234.56');
check('cost headers first, loose Energy / Demand / Total', same(g, E1), g);
const L = { start: '2026-01-01', end: '2026-01-31', kwh: 1000, kw: 50, fac: 45, cost: 1234.56 };
g = mapped('start_date,end_date,kwh,actual_kw,facilities_kw,total_cost', '2026-01-01,2026-01-31,1000,50,45,1234.56');
check('LSR7 header set maps every column', same(g, L), g);

console.log('test-csv-header-match: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
