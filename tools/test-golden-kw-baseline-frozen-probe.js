// tools/test-golden-kw-baseline-frozen-probe.js - PROBE. SYNTHETIC data only (fake ids, no client data).
// Run: node tools/test-golden-kw-baseline-frozen-probe.js
// Question (registry N3/N4): the kWh baseline of a contracted meter is frozen once (freezeContractBaseline, savings.js:245) and
// never recomputed. The kW baseline fit (fitKwCdd / computeKwCddRegression, regression.js) is not part of the stored record
// (savings.js:252-257 stores months, blAvg, moMap, moMapWx only). Does the kW baseline of a post-baseline month change when a
// baseline-year (2025) bill is edited? This file asserts the CURRENT behavior and prints the answer. It does not judge it.
//
// Scenario A (weather present, the kW-vs-CDD fit is used): 2026-08 is on the Actual kW basis, so its kW baseline is the fit of
//   2025 Actual kW on 2025 CDD, evaluated at the CDD of the same calendar month of 2025 (August 2025).
// Scenario B (no weather, no fit): the kW baseline is the baseline-year kW of the same calendar month, read from the stored moMap.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);
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

// 2025 CDD by month (Jan..Dec); Actual kW = 50 + 0.1 x CDD exactly (so the fit is exact: intercept 50, slope 0.1)
const CDD = [0, 0, 5, 20, 80, 200, 300, 280, 120, 30, 5, 0];
const mkBills = () => {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const cdd = CDD[m - 1];
    out.push(monthBill(2025, m, { kwh: 8000 + 10 * cdd, billedKW: 50 + 0.1 * cdd + 10, demandKW: 50 + 0.1 * cdd }));
  }
  // one post-baseline bill, 2026-08 (Actual kW basis): 8500 kWh at $0.10, Actual kW 60, demand $600 over Billed kW 70 (rate not under test)
  out.push(monthBill(2026, 8, { kwh: 8500, onPeakCost: 850, billedKW: 70, demandKW: 60, demandCharge: 600 }));
  return out;
};
// weather by month: 2025 from CDD above; 2026-08 CDD 250 (HDD 0)
const mkWx = () => {
  const wx = {};
  for (let m = 1; m <= 12; m++) wx['2025-' + p2(m)] = { hdd: 0, cdd: CDD[m - 1], avgTemp: 60 };
  wx['2026-08'] = { hdd: 0, cdd: 250, avgTemp: 80 };
  return wx;
};

function runScenario(label, withWeather, editFn) {
  const meter = { id: 'm' + label, commodity: 'Electric', inclusive: true, bills: mkBills(), baseline: { months: Array.from({ length: 12 }, (_, i) => '2025-' + p2(i + 1)) } };
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  sb.__bldgs = { 1: { id: 'b1', meters: [meter] } };
  sb.__wx = withWeather ? mkWx() : null;
  const pre = [
    'var projects = [{ id: 1, sa: "SA-TEST", contractType: "fixedProject" }];',
    'var udSelProjId = 1;',
    'function getWeatherFingerprint(){return 0;} function getWeatherForBuilding(){ return { byYm: __wx, cache: [] }; }',
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
  const sav = () =>
    JSON.parse(
      vm.runInContext(
        `(function(){const m=__bldgs[1].meters[0];delete m._savingsCache;delete m._savingsCacheKey;
        const r=getMeterSavings(m,m.bills,true,1,'b1');
        return JSON.stringify({row:r.rows.find(x=>x.ym==='2026-08'),frozen:!!m.baseline.contractFrozen,fit:r.blKwFits});})()`,
        sb,
      ),
    );
  const before = sav();
  vm.runInContext('(' + editFn.toString() + ')(__bldgs[1].meters[0])', sb);
  const after = sav();
  return { before, after };
}

// ---------------- Scenario A: weather present, kW fit in use ----------------
// Hand-computed baseline kW for 2026-08 BEFORE the edit: fit of Actual kW on CDD is exact: kW = 50 + 0.1 x CDD.
// Evaluated at the CDD of August 2025 (280): 50 + 0.1 x 280 = 78.0 kW.
// EDIT: raise the 2025-06 bill Actual kW (demandKW) by d = +20 (from 50 + 0.1 x 200 = 70 to 90). Billed kW is left alone.
// Hand-computed prediction AFTER the edit if the fit reads the edited live bill (n = 12 points, x = 2025 CDD):
//   sum x = 0+0+5+20+80+200+300+280+120+30+5+0 = 1040 ; xbar = 86.6667
//   sum x^2 = 25+400+6400+40000+90000+78400+14400+900+25 = 230550 ; Sxx = 230550 - 1040^2/12 = 230550 - 90133.3333 = 140416.6667
//   change in the fitted value at x0 = 280 for a change d at x_j = 200:  d x (1/n + (x0 - xbar)(x_j - xbar)/Sxx)
//     = 20 x (1/12 + (193.3333 x 113.3333)/140416.6667) = 20 x (0.0833333 + 0.1560418) = 20 x 0.2393751 = 4.787503
//   => 78.0 + 4.7875 = 82.7875 kW
const editA = (m) => {
  m.bills.find((b) => b.start === '2025-06-01').demandKW = 90;
};
const A = runScenario('A', true, editA);
const aRowB = A.before.row,
  aRowA = A.after.row;
console.log('Scenario A (weather present, kW-vs-CDD fit):');
console.log('  kW baseline 2026-08 (row blExpKW): before edit = ' + aRowB.blExpKW + ' ; after a 2025 bill edit = ' + aRowA.blExpKW);
console.log('  kWh baseline 2026-08 (row expUsage): before edit = ' + aRowB.expUsage + ' ; after = ' + aRowA.expUsage);
console.log('  kW dollars 2026-08: before = ' + aRowB.kwCostSav + ' ; after = ' + aRowA.kwCostSav);
check(A.before.frozen && A.after.frozen, 'A: the kWh baseline record is stored (contractFrozen) after the first compute');
check(near(aRowB.blExpKW, 78, 1e-6), 'A: kW baseline before the edit = 78.0 (hand value; got ' + aRowB.blExpKW + ')');
check(aRowB.expUsage === aRowA.expUsage, 'A: CURRENT behavior: kWh baseline (frozen) is unchanged by the 2025 bill edit (' + aRowB.expUsage + ' vs ' + aRowA.expUsage + ')');
const kwChangedA = Math.abs(aRowA.blExpKW - aRowB.blExpKW) > 1e-9;
// CURRENT behavior asserted: the kW baseline reads the live bills, so it moves to 82.7875
check(kwChangedA === true, 'A: CURRENT behavior: kW baseline changes after a 2025 bill edit');
check(near(aRowA.blExpKW, 82.7875, 1e-3), 'A: kW baseline after the edit = 82.7875 (hand value; got ' + aRowA.blExpKW + ')');
console.log('PROBE: kW baseline changes after a 2025 bill edit = ' + kwChangedA);

// ---------------- Scenario B: no weather, kW baseline = baseline-year kW of the same calendar month ----------------
// Actual kW of August 2025 = 50 + 0.1 x 280 = 78 -> kW baseline of 2026-08 = 78 (no fit without weather).
// EDIT: 2025-08 Actual kW to 100. If the stored moMap is what is read, the kW baseline stays 78; if live bills are read it becomes 100.
const editB = (m) => {
  m.bills.find((b) => b.start === '2025-08-01').demandKW = 100;
};
const B = runScenario('B', false, editB);
const bRowB = B.before.row,
  bRowA = B.after.row;
console.log('Scenario B (no weather, same-calendar-month baseline-year kW):');
console.log('  kW baseline 2026-08: before edit = ' + bRowB.blExpKW + ' ; after a 2025-08 bill edit = ' + bRowA.blExpKW);
const kwChangedB = Math.abs(bRowA.blExpKW - bRowB.blExpKW) > 1e-9;
check(near(bRowB.blExpKW, 78, 1e-6), 'B: kW baseline before the edit = 78 (hand value; got ' + bRowB.blExpKW + ')');
check(kwChangedB === false, 'B: CURRENT behavior: kW baseline (read from the stored moMap) is unchanged by the 2025 bill edit (' + bRowB.blExpKW + ' vs ' + bRowA.blExpKW + ')');
console.log('PROBE (no weather, no fit): kW baseline changes after a 2025 bill edit = ' + kwChangedB);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
