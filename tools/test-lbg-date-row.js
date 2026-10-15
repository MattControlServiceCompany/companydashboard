/**
 * test-lbg-date-row.js -- regression for backlog d178c906.
 * A new-format City bill whose OCR date row had one garbled token ("711512026" for 7/15/2026)
 * shifted every date column: the period read 8/15 to 8/21 (6 days) and the bill date 9/11.
 * Also checks "Total Amount Due $2,584,70" (comma for the decimal point) reads 2584.70.
 * SYNTHETIC fixture only: fake name, address, account and amounts.
 * Loads the real city utility-bill rule via vm, found by the date-row reader it calls, same as tools/test-newformat-billdate.js.
 * Usage: node tools/test-lbg-date-row.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

// calcDays is the shared day counter (app/utility-data.js); load only it and its two helpers.
function loadSharedDayFns(sandbox) {
  const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'utility-data.js'), 'utf8');
  const ud2 = ud.replace(new RegExp(String.fromCharCode(13), 'g'), '');
  for (const n of ['_fixISO', '_parseISO', 'calcDays']) {
    const i = ud2.indexOf(String.fromCharCode(10) + 'function ' + n + '(');
    const j = ud2.indexOf(String.fromCharCode(10) + '}' + String.fromCharCode(10), i);
    if (i < 0 || j < 0) throw new Error('shared function not found: ' + n);
    vm.runInContext(ud2.slice(i, j + 3), sandbox);
  }
}

function loadCityRule(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'formatting.js'), 'utf8'), sandbox, {
    filename: 'formatting.js',
  });
  loadSharedDayFns(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  if (!rules) throw new Error('UTILITY_RULES not found in ' + scriptPath);
  // Find the rule by the date-row reader its new-format reader calls, not by its display name.
  const rule = rules.find((r) => typeof r._extractNew === 'function' && r._extractNew.toString().includes('_lbg_readDateRow('));
  if (!rule) throw new Error('city bill rule not found in ' + scriptPath);
  return rule;
}

function page(row, total) {
  return [
    '%%PAGE_1%%',
    'City Utility Bill',
    '100 TEST ST 00-000000-00',
    'TEST TOWN, KS 00000 Total Amount Due',
    'Amount Due After 9/10/2026 $1.00',
    'Please return this portion with your payment.',
    'Customer Account Information - Retain for your records',
    'TEST SCHOOL 100 TEST ST 00-000000-00',
    row,
    '100- Water Utility Bill Previous Balance: $45.00',
    'Payments: ($45.00)',
    'Adjustments: $0.00',
    'Penalty: $0.00',
    'Previous Current',
    'Reading Reading Usage',
    '1000 1100 100 WATER 45.67',
    'Current Bill $45.67',
    'Total Amount Due ' + total,
    '',
  ].join('\n');
}
function one(rule, row, total) {
  const r = rule.extract(page(row, total));
  return Array.isArray(r) ? r[0] : r;
}
let fails = 0;
function eq(label, got, want) {
  if (got === want) console.log('PASS: ' + label + ' = ' + got);
  else {
    fails++;
    console.error('FAIL: ' + label + ' expected ' + want + ', got ' + got);
  }
}
const rule = loadCityRule(jsPath);
function loadFn(name) {
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'formatting.js'), 'utf8'), sandbox);
  loadSharedDayFns(sandbox);
  vm.runInContext(fs.readFileSync(jsPath, 'utf8'), sandbox);
  return vm.runInContext(name, sandbox);
}
const GOOD = '7/15/2026 8/15/2026 8/21/2026 9/11/2026 9/10/2026';
const BAD = '711512026            8/15/2026     8/21/2026         9/11/2026          9/10/2026';
let b = one(rule, BAD, '$2,584,70');
eq('garbled row start', b.BillingPeriodStart, '7/15/2026');
eq('garbled row end', b.BillingPeriodEnd, '8/15/2026');
eq('garbled row bill date', b.BillDate, '8/21/2026');
eq('garbled row days', String(b.NumberOfDays || calcDaysOf(b)), '31');
eq('amount reader', loadFn('_lbg_labeledAmount')('Total Amount Due $2,584,70', /Total\s*Amount\s*Due/i), '2584.70');
eq(
  'amount reader, clean',
  loadFn('_lbg_labeledAmount')('Total Amount Due $2,584.70', /Total\s*Amount\s*Due/i),
  '2584.70',
);
eq(
  'amount reader, thousands only',
  loadFn('_lbg_labeledAmount')('Total Amount Due $2,584', /Total\s*Amount\s*Due/i),
  null,
);
b = one(rule, GOOD, '$45.67');
eq('clean row start', b.BillingPeriodStart, '7/15/2026');
eq('clean row bill date', b.BillDate, '8/21/2026');
// two-digit month and day: 10/15/2026 garbled as 10115 12026 -> "101151 2026" is not used; test 1011512026
b = one(rule, '1011512026 11/15/2026 11/21/2026 12/11/2026 12/10/2026', '$45.67');
eq('MM1DD1YYYY start', b.BillingPeriodStart, '10/15/2026');
// an unreadable (not repairable) first column must not shift the others
b = one(rule, '7/1 5/2026x 8/15/2026 8/21/2026 9/11/2026 9/10/2026', '$45.67');
eq('unreadable column does not shift: end', b.BillingPeriodEnd, null);
eq('unreadable column: start', b.BillingPeriodStart, null);
// 4 date-like tokens: the missing column is assigned only when its place is proven.
// Garbled bill date in the middle (5 raw tokens, 1 unreadable): the other columns keep their places.
b = one(rule, '7/15/2026 8/15/2026 8/2l/2026 9/11/2026 9/10/2026', '$45.67');
eq('4-token garbled bill: start', b.BillingPeriodStart, '7/15/2026');
eq('4-token garbled bill: end', b.BillingPeriodEnd, '8/15/2026');
eq('4-token garbled bill: bill date not guessed', b.BillDate === '9/11/2026' ? 'WRONG' : b.BillDate, null);
eq('4-token garbled bill: held', heldAll('7/15/2026 8/15/2026 8/2l/2026 9/11/2026 9/10/2026'), true);
// Garbled end with a 34-day span to the wrong neighbor: nothing assigned by position.
b = one(rule, '2/15/2026 8x#q 3/21/2026 4/11/2026 4/10/2026', '$45.67');
eq('4-token garbled end: end not guessed', b.BillingPeriodEnd === '3/21/2026' ? 'WRONG' : b.BillingPeriodEnd, null);
eq('4-token garbled end: bill date', b.BillDate, '3/21/2026');
// A column that vanished (position unknown): all three stay empty and the bill is held.
b = one(rule, '2/15/2026 3/21/2026 4/11/2026 4/10/2026', '$45.67');
eq('4-token vanished: start empty', b.BillingPeriodStart, null);
eq('4-token vanished: end empty', b.BillingPeriodEnd, null);
eq('4-token vanished: bill empty', b.BillDate, null);
eq('4-token vanished: held', heldAll('2/15/2026 3/21/2026 4/11/2026 4/10/2026'), true);
eq('amount reader, comma before 2 digits', loadFn('_lbg_labeledAmount')('Total Amount Due $45,00', /Total\s*Amount\s*Due/i), '45.00');
function heldAll(row) {
  const all = rule.extractAll(page(row, '$45.67'));
  return all.length > 0 && all.every((x) => x._manualReview);
}
function calcDaysOf(x) {
  return Math.round((new Date(x.BillingPeriodEnd) - new Date(x.BillingPeriodStart)) / 86400000);
}
if (fails) {
  console.error(fails + ' failure(s)');
  process.exit(1);
}
console.log('All city bill date-row tests passed');
