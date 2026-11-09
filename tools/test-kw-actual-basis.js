#!/usr/bin/env node
// tools/test-kw-actual-basis.js — 2026-11-09. SYNTHETIC data only (no client data).
// The kW basis of the savings (computations/rates.js): from 2026-07 on the kW term compares the baseline kW with the Actual kW
// (demandKW) at the total actual kW rate (demand / billed kW + TDC / TDC kW + facilities / facilities kW).
// Months before 2026-07 keep the Billed kW basis and the old rate (demand + facilities dollars / billed kW).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-9);
function check(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const S = { console };
S.window = S;
vm.createContext(S);
for (const rel of ['lib/date-helpers.js', 'lib/formatting.js', 'computations/rates.js'])
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });

// billed 100 kW, Actual 80 kW, TDC 80 kW, facilities 90 kW; demand $1000 (10/kW), TDC $200 (2.5/kW), facilities $270 (3/kW)
const bill = { billedKW: '100', demandKW: '80', tdcKW: '80', facKW: '90', demandCharge: '1000', tdcCharge: '200', facilitiesCharge: '270' };
const bills = [bill, Object.assign({}, bill, { billedKW: '60', demandKW: '95' })];

console.log('1. basis switch month');
check(S.KW_ACTUAL_FROM_YM === '2026-07', 'switch month is 2026-07');
check(S.kwBasisForYm('2026-06') === 'billed', '2026-06 is the Billed kW basis');
check(S.kwBasisForYm('2026-07') === 'actual', '2026-07 is the Actual kW basis');
check(S.kwBasisForYm('2027-01') === 'actual', '2027-01 is the Actual kW basis');

console.log('2. kW of a month');
check(S.getBillSavingsKw(bill, 'actual') === 80, 'actual basis reads demandKW');
check(S.getBillSavingsKw(bill, 'billed') === 100, 'billed basis reads billedKW');
check(S.getBillSavingsKw({ billedKW: '70' }, 'actual') === 70, 'actual basis falls back to billedKW when demandKW is missing');
check(S.getBillSavingsKw({ demandKW: '70' }, 'billed') === 70, 'billed basis falls back to demandKW when billedKW is missing');
check(S.getMonthSavingsKw(bills, '2026-08') === 95, 'Q3 month: highest Actual kW of the bills');
check(S.getMonthSavingsKw(bills, '2026-05') === 100, 'Q2 month: highest Billed kW of the bills');

console.log('3. $/kW rate of a month');
check(near(S.getMonthKwRate([bill], '2026-08'), 15.5, 1e-9), 'Q3 rate = 10 + 2.5 + 3 = 15.5');
check(near(S.getMonthKwRate([bill], '2026-05'), 14.7, 1e-9), 'Q2 rate = (1000 + 200 + 270) / 100 = 14.7 (old basis)');

console.log('4. kW dollars = (baseline kW - Actual kW) x total actual rate, per basis');
// baseline 90 kW: Q3 (90 - 80) x 15.5 = 155; Q2 (90 - 100) x 14.7 = -147
check(near((90 - S.getMonthSavingsKw([bill], '2026-08')) * S.getMonthKwRate([bill], '2026-08'), 155, 1e-9), 'Q3 kW dollars = 155');
check(near((90 - S.getMonthSavingsKw([bill], '2026-05')) * S.getMonthKwRate([bill], '2026-05'), -147, 1e-9), 'Q2 kW dollars = -147');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
