// tools/test-golden-kw-dollar-term.js - golden known-value test. SYNTHETIC data only (fake ids, no client data).
// Run: node tools/test-golden-kw-dollar-term.js
// The kW dollar term of the savings, THROUGH getMeterSavings (computations/savings.js:596-597):
//   kW dollars = (baseline kW - actual kW of the month) x getMonthKwRate(month bills, ym)
// The kW basis changes at KW_ACTUAL_FROM_YM = 2026-07 (computations/rates.js kwBasisForYm):
//   before it: Billed kW (billedKW, else demandKW), rate = (demand + tdc + facilities dollars) / Billed kW   ('kw' rate type)
//   from it:   Actual kW (demandKW, else billedKW), rate = demand/billedKW + tdc/tdcKW + facilities/facKW    ('kwTotal' rate type)
// Every expected value below is hand-computed in the comments from the inputs.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
const cents = (a, b) => Math.abs(a - b) < 0.005; // asserted to the cent
function check(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const p2 = (n) => String(n).padStart(2, '0');
const ld = (y, m) => new Date(y, m, 0).getDate();
const monthBill = (y, m, extra) => Object.assign({ start: y + '-' + p2(m) + '-01', end: y + '-' + p2(m) + '-' + p2(ld(y, m)) }, extra);

// ---- fixture: one electric meter, contracted project, baseline = 2025 (12 months), no weather ----
// Every 2025 bill: 10000 kWh, Billed kW 100, Actual kW (demandKW) 90.
//   => baseline kWh of every calendar month = 10000
//   => baseline kW, Billed basis = 100; baseline kW, Actual basis = 90 (no weather, so no kW fit: the baseline kW of the same calendar month).
const bills = [];
for (let m = 1; m <= 12; m++) bills.push(monthBill(2025, m, { kwh: 10000, billedKW: 100, demandKW: 90 }));
// 2026-05 (Billed basis): 9000 kWh at $0.10 (onPeakCost 900); Billed kW 80, Actual kW 70; demand $800 + facilities $160 over Billed kW 80.
bills.push(monthBill(2026, 5, { kwh: 9000, onPeakCost: 900, billedKW: 80, demandKW: 70, demandCharge: 800, facilitiesCharge: 160 }));
// 2026-08 (Actual basis): 9500 kWh at $0.10 (onPeakCost 950); Billed kW 80, Actual kW 70.
//   demand $800 / Billed kW 80 = 10.0; tdc $160 / tdcKW 40 = 4.0; facilities $90 / facKW 30 = 3.0.
bills.push(monthBill(2026, 8, { kwh: 9500, onPeakCost: 950, billedKW: 80, demandKW: 70, demandCharge: 800, tdcCharge: 160, tdcKW: 40, facilitiesCharge: 90, facKW: 30 }));
// 2026-09 (Actual basis): 9000 kWh at $0.10; Billed kW 60, Actual kW 60; NO demand / tdc / facilities dollars, no stored kW rate.
bills.push(monthBill(2026, 9, { kwh: 9000, onPeakCost: 900, billedKW: 60, demandKW: 60 }));

const meter = { id: 'mE', commodity: 'Electric', inclusive: true, bills, baseline: { months: Array.from({ length: 12 }, (_, i) => '2025-' + p2(i + 1)) } };
const projects = [{ id: 1, sa: 'SA-TEST', contractType: 'fixedProject' }];
const bldgs = { 1: { id: 'b1', meters: [meter] } };

const sb = { console };
sb.window = sb;
vm.createContext(sb);
sb.__projects = projects;
sb.__bldgs = bldgs;
const pre = [
  'var projects = __projects;',
  'var udSelProjId = 1;',
  'var __store = {}; function sget(k, d){ return k in __store ? __store[k] : d; } function sset(k, v){ __store[k] = v; }',
  'function getWeatherFingerprint(){return 0;} function getWeatherForBuilding(){ return { byYm: null, cache: [] }; }',
  'function getUDBldg(p, b){ return __bldgs[p]; }',
  'function getUDBldgs(p){ return [__bldgs[p]]; }',
  'function isBaselineExcluded(){ return false; } function isCalcCommodity(){ return true; }',
  'var DELIVERY_COMMODITIES = new Set(["Propane"]);',
  'function _rptUnit(s){ return s; }',
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
].join('\n');
const files = ['lib/formatting.js', 'lib/date-helpers.js', 'computations/regression.js', 'computations/rates.js', 'computations/normalization.js', 'computations/csc.js', 'computations/savings.js'];
vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
const ev = (e) => vm.runInContext(e, sb);
const res = JSON.parse(
  ev(`(function(){const m=__bldgs[1].meters[0];delete m._savingsCache;delete m._savingsCacheKey;
    return JSON.stringify(getMeterSavings(m,m.bills,true,1,'b1'));})()`),
);
const row = (ym) => res.rows.find((r) => r.ym === ym);

console.log('0. fixture: the post-baseline months with a bill are 2026-05, 2026-08, 2026-09');
check(res.rows.length === 3 && ['2026-05', '2026-08', '2026-09'].every((y) => row(y)), 'three rows: 2026-05, 2026-08, 2026-09');

console.log('1. 2026-05, Billed kW basis (before 2026-07)');
// baseline kW = 100 (Billed basis); actual kW = Billed kW 80; rate = (demand 800 + facilities 160) / Billed kW 80 = 12.00 $/kW
// kW dollars  = (100 - 80) x 12.00 = 240.00
// kWh dollars = (10000 - 9000) x (900 / 9000 = 0.10) = 100.00
// month total = 340.00
let r = row('2026-05');
check(r.blExpKW === 100, '2026-05 baseline kW = 100 (got ' + r.blExpKW + ')');
check(r.bilKW === 80, '2026-05 actual kW (row field bilKW) = 80 (got ' + r.bilKW + ')');
check(cents(r.kwRate, 12), '2026-05 $/kW = 12.00 (got ' + r.kwRate + ')');
check(cents(r.kwCostSav, 240), '2026-05 kW dollars = 240.00 (got ' + r.kwCostSav + ')');
check(cents(r.kwhCostSav, 100), '2026-05 kWh dollars = 100.00 (got ' + r.kwhCostSav + ')');
check(cents(r.savings, 340), '2026-05 month savings = 340.00 (got ' + r.savings + ')');
check(cents(res.byYM['2026-05'], 340), '2026-05 byYM = 340.00 (got ' + res.byYM['2026-05'] + ')');

console.log('2. 2026-08, Actual kW basis (from 2026-07)');
// baseline kW = 90 (Actual basis); actual kW = demandKW 70; rate = 10.0 + 4.0 + 3.0 = 17.00 $/kW
// kW dollars  = (90 - 70) x 17.00 = 340.00
// kWh dollars = (10000 - 9500) x (950 / 9500 = 0.10) = 50.00
// month total = 390.00
r = row('2026-08');
check(r.blExpKW === 90, '2026-08 baseline kW = 90 (got ' + r.blExpKW + ')');
check(r.bilKW === 70, '2026-08 actual kW (row field bilKW) = 70 (got ' + r.bilKW + ')');
check(cents(r.kwRate, 17), '2026-08 $/kW = 17.00 (got ' + r.kwRate + ')');
check(cents(r.kwCostSav, 340), '2026-08 kW dollars = 340.00 (got ' + r.kwCostSav + ')');
check(cents(r.kwhCostSav, 50), '2026-08 kWh dollars = 50.00 (got ' + r.kwhCostSav + ')');
check(cents(r.savings, 390), '2026-08 month savings = 390.00 (got ' + r.savings + ')');

console.log('3. 2026-09, no kW rate of its own but Actual kW 60 > 0: missing-rate cascade (savings.js ~573) - PINNED CURRENT BEHAVIOR');
// The month bill has no demand / tdc / facilities dollars and no stored kW rate, so getMonthKwRate = 0. Because the kW is > 0, the
// code calls resolveMeterRate(component 'kw'). The meter has no rateSchedule and no peer meters, so steps 1 (own bill),
// 2 (published) and 3 (peer) give nothing; step 4 carries the rate of the latest earlier month with a 'kw'-type bill rate:
// 2026-08, getStoredKwRate = (demand 800 + tdc 160 + facilities 90) / Billed kW 80 = 1050 / 80 = 13.125 $/kW
// (the Billed-style 'kw' rate, NOT the 17.00 total actual rate that 2026-08 itself is paid at: pinned current behavior, not a ruling).
// kW dollars  = (baseline kW 90 - actual kW 60) x 13.125 = 30 x 13.125 = 393.75
// kWh dollars = (10000 - 9000) x 0.10 = 100.00 ; month total = 493.75
r = row('2026-09');
check(r.blExpKW === 90 && r.bilKW === 60, '2026-09 baseline kW 90, actual kW 60');
check(cents(r.kwRate, 13.125), 'PINNED current behavior: 2026-09 cascade $/kW = 13.125 (got ' + r.kwRate + ')');
check(cents(r.kwCostSav, 393.75), 'PINNED current behavior: 2026-09 kW dollars = 393.75 (got ' + r.kwCostSav + ')');
check(cents(r.savings, 493.75), 'PINNED current behavior: 2026-09 month savings = 493.75 (got ' + r.savings + ')');

console.log('4. roll-up');
// byYM total = 340 + 390 + 493.75 = 1223.75
const tot = Object.values(res.byYM).reduce((s, v) => s + v, 0);
check(cents(tot, 1223.75), 'sum of byYM = 1223.75 (got ' + tot + ')');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
