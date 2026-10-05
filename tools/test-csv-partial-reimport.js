/**
 * test-csv-partial-reimport.js  (WP-03, math-audit 2026-09-28)
 *
 * Acceptance test: a partial CSV re-import must not erase stored bill values.
 *  1. A kWh-only row keeps demandKW, totalCost, demandCharge, onPeakKwh, and the bill id.
 *  2. A non-blank cell overwrites the stored value.
 *  3. The typed marker ERASE in a cell clears that one field (and only that field).
 *  4. The preview says "existing value will be kept" and names the ERASE marker.
 *  5. Warning row numbers are file line numbers (header or no header).
 * Synthetic data only. Usage: node tools/test-csv-partial-reimport.js
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

// 1. kWh-only row
let m = freshMeter();
load(m, 'start_date,end_date,kwh,actual_kw,total_cost\n2026-01-01,2026-01-31,1234,,\n');
R('importBillCsvRows')();
let b = m.bills.find((x) => x.start === '2026-01-01');
check('kWh-only re-import: kwh updated', num(b.kwh) === 1234, b.kwh);
check('kWh-only re-import: demandKW kept', num(b.demandKW) === 412.5, b.demandKW);
check('kWh-only re-import: totalCost kept', num(b.totalCost) === 9056.1, b.totalCost);
check('kWh-only re-import: demandCharge kept', num(b.demandCharge) === 2500, b.demandCharge);
check('kWh-only re-import: onPeakKwh kept', num(b.onPeakKwh) === 500, b.onPeakKwh);
check('kWh-only re-import: bill id kept', b.id === 'keep-id', b.id);
check('kWh-only re-import: no _erase field stored', b._erase === undefined);
check('other bill untouched', m.bills.find((x) => x.start === '2026-02-01').kwh === '900');

// 2. non-blank overwrites
m = freshMeter();
load(m, 'start_date,end_date,kwh,actual_kw,total_cost\n2026-01-01,2026-01-31,1234,450,9100\n');
R('importBillCsvRows')();
b = m.bills.find((x) => x.start === '2026-01-01');
check('non-blank cells overwrite', num(b.demandKW) === 450 && num(b.totalCost) === 9100, b);
check('non-blank re-import still keeps demandCharge', num(b.demandCharge) === 2500, b.demandCharge);

// 3. explicit erase marker
m = freshMeter();
load(m, 'start_date,end_date,kwh,actual_kw,total_cost\n2026-01-01,2026-01-31,1234,ERASE,\n');
R('importBillCsvRows')();
b = m.bills.find((x) => x.start === '2026-01-01');
check('ERASE clears demandKW', b.demandKW == null || b.demandKW === '', b.demandKW);
check('ERASE leaves totalCost', num(b.totalCost) === 9056.1, b.totalCost);
check('ERASE leaves kwh update', num(b.kwh) === 1234, b.kwh);
m = freshMeter();
load(m, 'start_date,end_date,kwh,actual_kw,total_cost\n2026-01-01,2026-01-31,1234,erase,\n');
R('importBillCsvRows')();
check('erase marker is case-insensitive', (m.bills[0].demandKW == null || m.bills[0].demandKW === ''), m.bills[0].demandKW);

// 4. preview text
m = freshMeter();
load(m, 'start_date,end_date,kwh,actual_kw,total_cost\n2026-01-01,2026-01-31,1234,,\n2026-03-01,2026-03-31,800,300,7000\n');
const all = Object.values(els).map((e) => e.textContent + ' ' + e.innerHTML).join(' | ');
check('preview says "existing value will be kept"', /existing value will be kept/.test(all), all.slice(0, 300));
check('preview names the ERASE marker', /ERASE/.test(all));

// 5. row numbers
let warnText = '';
function warnFor(csv) {
  m = freshMeter();
  load(m, csv);
  warnText = els.billCsvWarnings.innerHTML;
  return warnText;
}
check('header + bad date on data row 2 -> "Row 3"', /Row 3:/.test(warnFor('start_date,end_date,kwh\n2026-01-01,2026-01-31,5\nnotadate,2026-02-28,6\n')), warnText);
check('no header + bad date on 2nd line -> "Row 2"', /Row 2:/.test(warnFor('2026-01-01,2026-01-31,5\nnotadate,2026-02-28,6\n')), warnText);

console.log('test-csv-partial-reimport: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
