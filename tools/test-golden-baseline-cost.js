// tools/test-golden-baseline-cost.js - golden known-value test. SYNTHETIC data only (fake ids, no client data).
// Run: node tools/test-golden-baseline-cost.js
// _rptBaselineCostOfRow(m, bills, blMonths, row, ym) (app/report-engine.js ~84): the baseline COST shown in reports
//   gas / propane: expUsage x baseline-year rate of the same calendar month (getMonthBillRate over the baseline-year bills of that month)
//   electric:      expUsage x kWh rate + blExpKW x kW rate; kW rate = 'kw' type before 2026-07 (kwBasisForYm 'billed'), 'kwTotal' from 2026-07
//   a month with no baseline-year bill of its own uses the rate of the WHOLE baseline year (all baseline-year bills, usage-weighted)
// Every expected value is hand-computed in the comments.
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
const mb = (ym, extra) => {
  const y = +ym.slice(0, 4),
    m = +ym.slice(5, 7);
  return Object.assign({ start: ym + '-01', end: ym + '-' + p2(ld(y, m)) }, extra);
};

const sb = { console };
sb.window = sb;
vm.createContext(sb);
const pre = [
  'var projects = [{ id: 1, contractType: "fixedProject" }];',
  'var udSelProjId = 1;',
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
].join('\n');
const files = ['lib/formatting.js', 'lib/date-helpers.js', 'computations/regression.js', 'computations/rates.js', 'computations/normalization.js', 'computations/csc.js', 'computations/savings.js'];
vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
// _rptBaselineCostOfRow only needs getMonthBillRate, kwBasisForYm and billMonth (all loaded above)
vm.runInContext(loadFn(REPO + '/app/report-engine.js', '_rptBaselineCostOfRow'), sb);
const cost = (m, bills, blMonths, row, ym) => {
  sb.__a = [m, bills, blMonths, row, ym];
  return vm.runInContext('_rptBaselineCostOfRow.apply(null, __a)', sb);
};

console.log('1. gas: month with its own baseline-year rate, month without (whole-year rate)');
// baseline-year bills: 2025-03 200 th $240 (1.20); 2025-04 100 th $90 (0.90); 2025-06 300 th $270 (0.90).
// A 2026-03 bill ($500 / 100 th) is NOT a baseline-year bill and must not count.
const gasBills = [
  mb('2025-03', { therms: 200, gasCharge: 240 }),
  mb('2025-04', { therms: 100, gasCharge: 90 }),
  mb('2025-06', { therms: 300, gasCharge: 270 }),
  mb('2026-03', { therms: 100, gasCharge: 500 }),
];
const gasM = { commodity: 'Gas' };
const blYear = Array.from({ length: 12 }, (_, i) => '2025-' + p2(i + 1));
// 2026-03: baseline use 150 th x March 2025 rate (240 / 200 = 1.20) = 180.00
check(near(cost(gasM, gasBills, blYear, { expUsage: 150 }, '2026-03'), 180), 'gas March: 150 x 1.20 = 180.00');
// 2026-04: 50 th x (90 / 100 = 0.90) = 45.00
check(near(cost(gasM, gasBills, blYear, { expUsage: 50 }, '2026-04'), 45), 'gas April: 50 x 0.90 = 45.00');
// 2026-08: no 2025-08 bill, so the whole-year rate = (240 + 90 + 270) / (200 + 100 + 300) = 600 / 600 = 1.00 ; 80 th x 1.00 = 80.00
check(near(cost(gasM, gasBills, blYear, { expUsage: 80 }, '2026-08'), 80), 'gas August (no own rate): 80 x 1.00 = 80.00');
// no baseline use: 0
check(cost(gasM, gasBills, blYear, { expUsage: 0 }, '2026-03') === 0, 'gas, expUsage 0 -> 0');

console.log('2. propane: usage x all-in baseline rate');
// 2025-02 delivery 100 gal, total $250 => 2.50 $/gal ; 2026-02: 40 gal x 2.50 = 100.00
const propBills = [{ start: '2025-02-10', end: '2025-02-10', gallonsDelivered: 100, totalCost: 250 }];
check(near(cost({ commodity: 'Propane' }, propBills, blYear, { expUsage: 40 }, '2026-02'), 100), 'propane: 40 x 2.50 = 100.00');

console.log('3. electric, own month rate, Billed kW basis (2026-06) and Actual kW basis (2026-07)');
// 2025-06 and 2025-07 bills (identical): 10000 kWh, onPeakCost $1100 => kWh rate 0.11 ;
//   Billed kW 100, Actual kW 90 ; demand $800, tdc $200 (tdcKW 50), facilities $150 (facKW 75).
//   'kw' rate (Billed basis)  = (800 + 200 + 150) / 100 = 11.50 $/kW
//   'kwTotal' rate (Actual)   = 800/100 + 200/50 + 150/75 = 8 + 4 + 2 = 14.00 $/kW
const eBill = { kwh: 10000, onPeakCost: 1100, billedKW: 100, demandKW: 90, demandCharge: 800, tdcCharge: 200, tdcKW: 50, facilitiesCharge: 150, facKW: 75 };
const elecBills1 = [mb('2025-06', eBill), mb('2025-07', eBill)];
const elecM = { commodity: 'Electric' };
const bl2 = ['2025-06', '2025-07'];
// 2026-06 (Billed basis): 9000 kWh x 0.11 = 990.00 ; kW 95 x 11.50 = 1092.50 ; total 2082.50
check(near(cost(elecM, elecBills1, bl2, { expUsage: 9000, blExpKW: 95 }, '2026-06'), 2082.5), 'electric 2026-06: 990.00 + 1092.50 = 2082.50');
// 2026-07 (Actual basis): 9000 x 0.11 = 990.00 ; kW 95 x 14.00 = 1330.00 ; total 2320.00
check(near(cost(elecM, elecBills1, bl2, { expUsage: 9000, blExpKW: 95 }, '2026-07'), 2320), 'electric 2026-07: 990.00 + 1330.00 = 2320.00');
// no kW baseline: the kW term is 0 (990.00)
check(near(cost(elecM, elecBills1, bl2, { expUsage: 9000, blExpKW: 0 }, '2026-06'), 990), 'electric, blExpKW 0: kWh term only = 990.00');

console.log('4. electric, month without its own rate uses the whole baseline-year rate');
// baseline-year bills: the 2025-06 bill above and a 2025-09 bill:
//   5000 kWh, onPeakCost $450 (0.09) ; Billed kW 50, Actual kW 40 ; demand $300, tdc $100 (tdcKW 40), facilities $100 (facKW 50)
//   'kw' (Billed)  = (300 + 100 + 100) / 50 = 10.00 ; 'kwTotal' = 300/50 + 100/40 + 100/50 = 6 + 2.5 + 2 = 10.5 => charge 10.5 x 50 = 525 over 50 kW
const sep = { kwh: 5000, onPeakCost: 450, billedKW: 50, demandKW: 40, demandCharge: 300, tdcCharge: 100, tdcKW: 40, facilitiesCharge: 100, facKW: 50 };
const elecBills2 = [mb('2025-06', eBill), mb('2025-09', sep)];
const bl3 = ['2025-06', '2025-09'];
// own month 2026-09 (Actual basis): 4000 x 0.09 = 360.00 ; 40 kW x 10.50 = 420.00 ; total 780.00
check(near(cost(elecM, elecBills2, bl3, { expUsage: 4000, blExpKW: 40 }, '2026-09'), 780), 'electric 2026-09 own month: 360.00 + 420.00 = 780.00');
// whole-year kWh rate = (1100 + 450) / (10000 + 5000) = 1550 / 15000 = 0.1033333...
// whole-year 'kwTotal' = (14 x 100 + 10.5 x 50) / (100 + 50) = (1400 + 525) / 150 = 1925 / 150 = 12.8333333...
// 2026-08 (no 2025-08 bill, Actual basis): 8000 x 0.1033333 = 826.666667 ; 60 kW x 12.833333 = 770.000000 ; total 1596.666667
check(near(cost(elecM, elecBills2, bl3, { expUsage: 8000, blExpKW: 60 }, '2026-08'), 1596.666667, 1e-5), 'electric 2026-08 whole-year rate: 826.67 + 770.00 = 1596.67');
// whole-year 'kw' (Billed) = (1150 + 500) / (100 + 50) = 1650 / 150 = 11.00
// 2026-05 (no 2025-05 bill, Billed basis): 1000 x 0.1033333 = 103.333333 ; 10 kW x 11.00 = 110.00 ; total 213.333333
check(near(cost(elecM, elecBills2, bl3, { expUsage: 1000, blExpKW: 10 }, '2026-05'), 213.333333, 1e-5), 'electric 2026-05 whole-year Billed rate: 103.33 + 110.00 = 213.33');

console.log('5. other commodity returns 0');
check(cost({ commodity: 'Water' }, gasBills, blYear, { expUsage: 50 }, '2026-03') === 0, 'water -> 0');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
