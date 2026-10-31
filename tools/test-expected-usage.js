// Node-only unit test (no browser) for the one expected-usage rule (Matt, 2026-10-31):
//   expectedUsageForMonth / baselineUsageByCalMo (computations/savings.js), regressionBaseline and
//   computeKwCddRegression (computations/regression.js).
// Checks: (1) the reporting month's own weather is used from Q3-2026 on, (2) a month without weather is
// left out and never read as 0 degree days, (3) months before Q3-2026 (the presented quarters) keep the
// baseline-year value whatever the weather.
// USAGE: node tools/test-expected-usage.js     EXIT: 0 = all pass.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.resolve(__dirname, '..');
// billMonth (computations/normalization.js) is stubbed: one bill = the month it starts in.
const ctx = vm.createContext({ console, billMonth: (b) => b.start.slice(0, 7) });
['lib/date-helpers.js', 'lib/formatting.js', 'computations/regression.js', 'computations/savings.js'].forEach((f) =>
  new vm.Script(fs.readFileSync(path.join(REPO, f), 'utf8'), { filename: f }).runInContext(ctx),
);
const get = (name) => new vm.Script(name).runInContext(ctx);
const expectedUsageForMonth = get('expectedUsageForMonth');
const baselineUsageByCalMo = get('baselineUsageByCalMo');
const regressionBaseline = get('regressionBaseline');
const computeKwCddRegression = get('computeKwCddRegression');
const FROM = get('REPORTING_WEATHER_FROM_YM');

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
};

// Electric regression: kWh = 100*days + 10*CDD
const regE = { cdd: { intercept: 100, slope: 10 }, hdd: null };
const row = (ym, cdd, hdd) => ({ ym, days: 30, cdd, hdd });
const rb = (r) => regressionBaseline(r, regE, 'Electric', 'calendar');

eq('cutover is Q3-2026', FROM, '2026-07');
eq('baseline regression uses the month CDD', rb(row('2026-08', 500, 0)), 100 * 31 + 10 * 500);
eq('missing weather gives no baseline (not CDD 0)', rb(row('2026-09', null, null)), null);
eq('CDD 0 is a real value', rb(row('2026-05', 0, 0)), 100 * 31);
const regD = { dual: { intercept: 100, slopeHDD: 2, slopeCDD: 10 } };
eq('dual regression: missing weather gives null', regressionBaseline(row('2026-09', null, null), regD, 'Electric', 'calendar'), null);

// baselineUsageByCalMo reads the right map per commodity
eq(
  'baselineUsageByCalMo electric',
  baselineUsageByCalMo({ commodity: 'Electric' }, { elecByMo: { 7: { kwhPredicted: 5 } }, gasByMo: {}, propaneByMo: {}, waterByMo: {} }),
  { 7: 5 },
);
eq(
  'baselineUsageByCalMo gas',
  baselineUsageByCalMo({ commodity: 'Gas' }, { elecByMo: {}, gasByMo: { 7: { thermsPredicted: 9 } }, propaneByMo: {}, waterByMo: {} }),
  { 7: 9 },
);

// expectedUsageForMonth
const exCtx = { blByCalMo: { 7: 3000, 8: 2500 }, blAvg: 1111, weatherDriven: true, hasRegr: true };
const augRow = { ym: '2026-08', regrBaseline: 3600, cdd: 500, hdd: 0 };
eq('Q3 month uses the current weather, not the baseline-year value', expectedUsageForMonth(augRow, exCtx), { usage: 3600, weatherMissing: false });
const sepRow = { ym: '2026-09', regrBaseline: null, cdd: null, hdd: null };
eq('Q3 month without weather is left out', expectedUsageForMonth(sepRow, exCtx), { usage: null, weatherMissing: true });
const junRow = { ym: '2026-06', regrBaseline: 2222, cdd: 100, hdd: 0 };
eq('presented quarter month keeps the baseline-year value', expectedUsageForMonth(junRow, { blByCalMo: { 5: 2000 }, blAvg: 1, weatherDriven: true, hasRegr: true }), { usage: 2000, weatherMissing: false });
eq('presented quarter month: weather does not matter', expectedUsageForMonth({ ym: '2026-06', regrBaseline: null, cdd: null, hdd: null }, { blByCalMo: { 5: 2000 }, blAvg: 1, weatherDriven: true, hasRegr: true }), { usage: 2000, weatherMissing: false });
eq('no regression and weather present: baseline-year value', expectedUsageForMonth({ ym: '2026-08', regrBaseline: null, cdd: 500, hdd: 0 }, exCtx), { usage: 3000, weatherMissing: false });

eq('water meter (not weather driven) is never flagged', expectedUsageForMonth(sepRow, { blByCalMo: { 8: 77 }, blAvg: 1, weatherDriven: false, hasRegr: true }), { usage: 77, weatherMissing: false });
eq('meter with no fitted regression is never flagged', expectedUsageForMonth(sepRow, { blByCalMo: { 8: 77 }, blAvg: 1, weatherDriven: true, hasRegr: false }), { usage: 77, weatherMissing: false });

// kW regression: missing weather is left out of the fit and the prediction
const bills = (ym, kw) => [{ start: ym + '-01', end: ym + '-28', billedKW: kw, demandKW: kw, kwh: 1000 }];
const blRows = [
  { ym: '2025-06', cdd: 100 },
  { ym: '2025-07', cdd: 200 },
  { ym: '2025-08', cdd: 300 },
  { ym: '2025-09', cdd: null },
];
const allBills = [].concat(bills('2025-06', 110), bills('2025-07', 120), bills('2025-08', 130), bills('2025-09', 500));
const kw = computeKwCddRegression(blRows, blRows.concat([{ ym: '2026-09', cdd: null }, { ym: '2026-08', cdd: 400 }]), allBills, true);
eq('kW: weather-less baseline month is not a CDD-0 fit point', Math.round(kw['2026-08']), 140);
eq('kW: month without weather has no prediction', kw['2026-09'], undefined);

console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
