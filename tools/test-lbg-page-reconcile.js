/**
 * test-lbg-page-reconcile.js
 *
 * Regression test for the city utility parser (the Client A rule): the page-total check and the
 * fixes that hang on it. SYNTHETIC text only (fake school, fake street, fake account ids,
 * amounts in pounds). Loads the REAL rule from app/energy-savings.js through vm.
 *
 *   913c02a9  Stormwater read "4.06" for "4.00": repaired from the other pages of the file
 *   90ec94e3  lines that do not add up to the printed Current Bill hold the page
 *   166ee5bf  a whole Water line lost to label noise is caught by the same check
 *   584491c2  a zero Gas charge beside real therms is recovered or held, never dropped
 *   fe61fac7  "Current Bill" label read as "Current Bin" still gives the page total
 *   8fe95f92  a letter glued to the front of the therms flags a possible lost first digit
 *   5cf51ea7  a fuel adjustment minus sign lost by OCR is restored from the page total
 *   96353986  small decimal therms (3.339) are kept, not rounded to 3
 *   b4a4a7b9  a residual fuel adjustment is held when the account prints a commodity elsewhere
 *   ceec5979  "Bill Date: 05/01/2025" (colon then space) is read; no month is dropped
 *
 * Usage: node tools/test-lbg-page-reconcile.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
}
vm.runInContext(fs.readFileSync(jsPath, 'utf8'), sandbox, { filename: path.basename(jsPath) });
const rule = vm.runInContext("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')", sandbox);

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const j = (v) => JSON.stringify(v);

// Synthetic page. Gas 1000 therms: 1000 x 0.798062 + 23.33 = 821.39. Lines add up to 976.39:
// 821.39 gas - 30.00 fuel adjustment + 100.00 water + 1.00 fee + 80.00 sewer + 4.00 storm.
const ACCT_A = '01-900123-00';
const ACCT_B = '01-900456-00';
function page(n, o) {
  o = o || {};
  return [
    '%%PAGE_' + n + '%%',
    'Customer Account Information - Retain for your records',
    'SD 999 TEST SCHOOL        1 TEST ST        ' + (o.acct || ACCT_A),
    o.dates || '5/15/2026   6/15/2026   31   6/23/2026   7/13/2026   7/10/2026',
    'Previous Balance: 0.00',
    o.water === undefined ? '4,000 4,500 500 WATER 100.00' : o.water,
    o.gas === undefined ? '2,000 3,000 1,000.00 GAS 821.39' : o.gas,
    o.fa === undefined ? 'FUEL ADJUSTMENT -30.00' : o.fa,
    'WATER PROTECTION 1.00',
    'SEWER 80.00',
    o.storm === undefined ? 'STORMWATER 4.00' : o.storm,
    o.cb === undefined ? 'Current Bill 976.39' : o.cb,
    'Total Amount Due 976.39',
  ].join('\n');
}
const byCommodity = (bills, c) => (bills || []).find((b) => b.Commodity === c);
const held = (bills) => (bills || []).some((b) => b._manualReview);

// 0. Control: a clean page is read in full and holds nothing.
let bills = rule.extractAll(page(1));
check('0 clean page: 4 bills, none held', bills.length === 4 && !held(bills), j(bills.map((b) => b.Commodity)));
check('0 clean page: gas total 791.39', byCommodity(bills, 'Gas').TotalCurrentCharges === '791.39', '');

// 913c02a9: Stormwater 4.06 with Current Bill printed for 4.00; three other pages say 4.00.
const doc3 = [
  page(1),
  page(2, { dates: '4/15/2026   5/15/2026   30   5/23/2026   6/13/2026   6/10/2026' }),
  page(3, { acct: ACCT_B }),
  page(4, {
    acct: ACCT_B,
    dates: '4/15/2026   5/15/2026   30   5/23/2026   6/13/2026   6/10/2026',
    storm: 'STORMWATER 4.06',
  }),
].join('\n');
bills = rule.extractAll(doc3);
let storm4 = bills.filter((b) => b.Commodity === 'Stormwater')[3];
check(
  '913c02a9 storm 4.06 repaired to 4.00',
  storm4 && storm4.StormWaterCharge === 4,
  j(storm4 && storm4.StormWaterCharge),
);
check('913c02a9 repair is marked', storm4 && !!storm4._auto_corrected_StormWaterCharge, '');
check('913c02a9 repaired page is not held', !held(bills.filter((b) => b._pageIndex === 4)), '');
// A lone page has no peers: the amount is NOT changed, the page is held for review.
bills = rule.extractAll(page(1, { storm: 'STORMWATER 4.06' }));
check('913c02a9 lone page: value kept as read', byCommodity(bills, 'Stormwater').StormWaterCharge === 4.06, '');
check('913c02a9 lone page: held with mismatch', held(bills) && !!bills[0]._pageTotalMismatch, '');

// 90ec94e3: the lines are $4.00 short of the printed Current Bill (Stormwater label lost to noise).
bills = rule.extractAll(page(1, { storm: '5T0RMWATFR 4.00' }));
check(
  '90ec94e3 dropped Stormwater line holds the page',
  held(bills) && bills[0]._pageTotalMismatch.diff === -4,
  j(bills[0]._pageTotalMismatch),
);
check('90ec94e3 reason names the gap', /4\.00/.test((bills[0]._gateReasons || []).join(' ')), j(bills[0]._gateReasons));

// 166ee5bf: the whole Water line is noise; its 100.00 never reaches a bill, but the page is held.
bills = rule.extractAll(page(1, { water: '4,000 4,500 500 WA1FR 100.00' }));
check(
  '166ee5bf lost Water line holds the page',
  held(bills) && !byCommodity(bills, 'Water'),
  j(bills.map((b) => b.Commodity)),
);
check(
  '166ee5bf gap is 100.00',
  bills[0]._pageTotalMismatch && bills[0]._pageTotalMismatch.diff === -100,
  j(bills[0]._pageTotalMismatch),
);

// 584491c2: a zero Gas charge beside 1000 therms. With a readable Current Bill it is recovered.
bills = rule.extractAll(page(1, { gas: '2,000 3,000 1,000.00 GAS 0.00' }));
let gas = byCommodity(bills, 'Gas');
check('584491c2 zero gas charge is not dropped', !!gas, j(bills.map((b) => b.Commodity)));
check(
  '584491c2 gas recovered from Current Bill',
  gas && gas.GasCharge === 798.06 && gas.TotalCurrentCharges === '791.39',
  j(gas && [gas.GasCharge, gas.TotalCurrentCharges]),
);
bills = rule.extractAll(page(1, { gas: '2,000 3,000 1,000.00 GAS 0.00', cb: 'Current Bill' }));
gas = byCommodity(bills, 'Gas');
check(
  '584491c2 no total on page: gas held, not dropped',
  gas && gas._manualReview === true,
  j(gas && gas._manualReview),
);

// fe61fac7: Current Bill label read as "Current Bin"; the garbled gas charge is recovered from it.
bills = rule.extractAll(page(1, { gas: '2,000 3,000 1,000.00 GAS 45.00', cb: 'Current Bin 976.39' }));
gas = byCommodity(bills, 'Gas');
check(
  'fe61fac7 fuzzy label gives the page total',
  gas && gas.GasCharge === 798.06 && !gas._manualReview,
  j(gas && [gas.GasCharge, gas._manualReview]),
);
bills = rule.extractAll(page(1, { cb: 'Current Billing 976.39' }));
check('fe61fac7 "Current Billing" is not a total', !bills[0]._pageTotalMismatch && !held(bills), '');
bills = rule.extractAll(page(1, { gas: '2,000 3,000 1,000.00 GAS 45.00', cb: 'Current Bin £976:39' }));
check(
  'fe61fac7 pound sign and colon decimal still read',
  byCommodity(bills, 'Gas').GasCharge === 798.06,
  j(byCommodity(bills, 'Gas')),
);

// 8fe95f92: a letter glued to the therms. Gas charge garbled and total unreadable: held, and the
// reason says the first digit may be missing.
bills = rule.extractAll(page(1, { gas: '2,000 3,000 T086.18/ GAS 45.00', cb: 'Current Bill' }));
gas = byCommodity(bills, 'Gas');
check('8fe95f92 glued letter holds the gas bill', gas && gas._manualReview === true, '');
check(
  '8fe95f92 reason names the missing first digit',
  gas && /first digit may be missing/.test(gas._gateReasons.join(' ')),
  j(gas && gas._gateReasons),
);
bills = rule.extractAll(page(1));
check('8fe95f92 clean therms carry no such note', !/first digit/.test(j(bills)), '');

// 5cf51ea7: minus sign of the fuel adjustment lost by OCR (prints 30.00 for -30.00).
bills = rule.extractAll(page(1, { fa: 'FUEL ADJUSTMENT 30.00' }));
gas = byCommodity(bills, 'Gas');
check(
  '5cf51ea7 fuel adjustment sign restored',
  gas && gas.FuelAdjustment === -30 && !!gas._auto_corrected_FuelAdjustment,
  j(gas && gas.FuelAdjustment),
);

// 96353986: small decimal therms are kept. 3.339 x 0.798062 + 23.33 = 25.99.
bills = rule.extractAll(
  page(1, { gas: '13,440 13,443 3.339 GAS 25.99', fa: 'FUEL ADJUSTMENT -0.17', cb: 'Current Bill 210.82' }),
);
gas = byCommodity(bills, 'Gas');
check('96353986 therms 3.339 kept', gas && gas.NaturalGasTherms === 3.339, j(gas && gas.NaturalGasTherms));

// b4a4a7b9: page 2 lost its Water line and its fuel adjustment label (both noise), so a residual
// "fuel adjustment" of +70.00 would absorb the missing 100.00. Page 1 shows the account prints Water.
const blind = page(2, {
  dates: '4/15/2026   5/15/2026   30   5/23/2026   6/13/2026   6/10/2026',
  water: '4,000 4,500 500 WA1FR 100.00',
  fa: 'kus apustvnt 30.00',
});
bills = rule.extractAll([page(1), blind].join('\n'));
gas = bills.filter((b) => b.Commodity === 'Gas')[1];
check(
  'b4a4a7b9 residual fuel adjustment held when Water is unaccounted for',
  gas && gas._manualReview === true && gas.FuelAdjustment === null,
  j(gas && [gas._manualReview, gas.FuelAdjustment]),
);
check(
  'b4a4a7b9 reason names Water',
  gas && /Water/.test(gas._manualReviewLabel || ''),
  j(gas && gas._manualReviewLabel),
);
bills = rule.extractAll(page(1, { fa: 'kus apustvnt 30.00' }));
gas = byCommodity(bills, 'Gas');
check(
  'b4a4a7b9 control: complete page still derives -30.00',
  gas && gas.FuelAdjustment === -30 && !gas._manualReview,
  j(gas && [gas.FuelAdjustment, gas._manualReview]),
);

// ceec5979: billing-detail page. "Bill Date: <date>" has a colon then a space.
const detail = (lines) =>
  ['%%PAGE_1%%', 'Billing Detail', 'Account Number: 4321', ...lines, 'BILL GS 10 20 1.0 10 100.00'].join('\n');
let d = rule.extractAll(detail(['Bill Date: 05/01/2025', 'Service From: 09/01/2025', 'Service To: 09/30/2025']));
check(
  'ceec5979 colon-space date labels read',
  d &&
    d[0] &&
    d[0].BillDate === '05/01/2025' &&
    d[0].BillingPeriodStart === '09/01/2025' &&
    d[0].BillingPeriodEnd === '09/30/2025',
  j(d && d[0] && [d[0].BillDate, d[0].BillingPeriodStart, d[0].BillingPeriodEnd]),
);
d = rule.extractAll(detail(['Bill Date: 12/05/2025', 'Due Date: 12/28/2025', 'Period 11/01/2025 11/30/2025']));
check(
  'ceec5979 November period survives the fallback',
  d && d[0] && d[0].BillingPeriodStart === '11/01/2025' && d[0].BillingPeriodEnd === '11/30/2025',
  j(d && d[0] && [d[0].BillingPeriodStart, d[0].BillingPeriodEnd]),
);

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
