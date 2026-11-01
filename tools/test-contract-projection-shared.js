// tools/test-contract-projection-shared.js - synthetic data only.
// Run: node tools/test-contract-projection-shared.js
// The Financial Summary "3-Year Total" and the Contract Projection "Total" are ONE number: both pages call
// _rptContractProjection (app/report-engine.js) -> computeContractProjection (computations/csc.js).
// It is the expected value: actuals to date (each quarter floored) + remaining targets; never the pure target total.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
const assert = (c, m) => (c ? passed++ : (failed++, console.log('  FAIL: ' + m)));
const sb = {};
vm.createContext(sb);
vm.runInContext(
  'function floorQuarterSavings(x){return Math.max(0,x||0);}' + fs.readFileSync(REPO + '/computations/csc.js', 'utf8'),
  sb,
);
const base = { annualTarget: 60000, escalationPct: 0, contractYears: 3, cscPct: 60, clientPct: 40, currentYear: 1, quarter: 3,
  quarterlyTargets: [10000, 10000, 30000, 10000] };
const tgt = vm.runInContext('computeContractProjection', sb)(Object.assign({}, base, { quarterlyActuals: null }));
assert(tgt.totalSavings === 180000, 'no actuals: pure target total 180000');
const mix = vm.runInContext('computeContractProjection', sb)(Object.assign({}, base, { quarterlyActuals: [9000, 18000, 0, null] }));
assert(mix.years[0].savings === 37000 && mix.years[0].blended && mix.years[0].annual === 60000, 'year 1 = 9000+18000+0 + Q4 target 10000');
assert(mix.totalSavings === 37000 + 60000 + 60000, 'total = sum of printed rows');
assert(mix.totalSavings <= tgt.totalSavings, 'never above the expected value');
assert(mix.totalCsc === mix.years.reduce((s, y) => s + y.csc, 0), 'CSC column foots');
const src = fs.readFileSync(REPO + '/app/report-engine.js', 'utf8');
const fin = src.slice(src.indexOf('function rptPageFinancial('), src.indexOf('function rptPageFinancial(') + 9000);
const cp = src.slice(src.indexOf('function rptPageContractProjection('));
assert(/_rptContractProjection\(d\)/.test(fin) && /_rptContractProjection\(d\)/.test(cp), 'both pages call the shared projection');
assert(!/computeMultiYearCscTotals\(/.test(fin) && !/computeMultiYearCscTotals\(/.test(cp.slice(0, 20000)), 'neither page builds its own multi-year total');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
