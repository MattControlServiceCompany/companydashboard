/**
 * test-utility-e-bill-boundary.js
 *
 * Regression test for the Utility E page-first bill grouping in app/energy-savings.js (extractAll).
 * Before the fix, a bill whose "Billing Details - service from" header prints on TWO pages
 * (the second page marked "(Continued)") was anchored on its LAST such page. Its real front
 * page was then claimed by nobody and the CONTINUATION ABSORPTION step gave it to the
 * PREVIOUS bill. Result: the previous bill read the next bill's Miscellaneous line, and the
 * next bill lost its Miscellaneous charge, its total, and PreviouslyBilled.
 *
 * SYNTHETIC text only (fake account, dates, amounts). Layout:
 *   Bill A: page 1 front, page 2 billing details.
 *   Bill B: page 3 front (has Miscellaneous), page 4 billing details, page 5 billing details (Continued).
 *   Bill C: page 6 front, page 7 billing details.
 *
 * Usage: node tools/test-utility-e-bill-boundary.js [path-to-energy-savings.js]
 *   Pass a PRE-FIX copy to confirm the test fails on the old code.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadRule(scriptPath) {
  // calcDays lives in app/utility-data.js (needs a browser); a simple day count is enough here.
  const calcDays = (s, e) => Math.round((new Date(e) - new Date(s)) / 864e5);
  const sandbox = { window: {}, calcDays, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
  }
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  const rule = rules && rules.find((r) => r.name === 'Evergy');
  if (!rule) throw new Error('Rule not found in ' + scriptPath);
  return rule;
}

const ACCT = 'Account Number: 1000001';
const front = (n, from, to, total, utility, misc, prev) =>
  `%%PAGE_${n}%%\n${ACCT}\n1 TEST ST, TESTVILLE, KS\nFor service from ${from} to ${to}\n` +
  (prev ? `Previously Billed.......................... $${prev}\n` : '') +
  `Current Charges (details on back).......... $${total}\n` +
  (misc
    ? `Utility.................................... $${utility}\nMiscellaneous.......................... $${misc}\n`
    : '');
const details = (n, from, to, body, cont) =>
  `%%PAGE_${n}%%\n${ACCT}\n1 TEST ST, TESTVILLE, KS\n${cont ? '(Continued)\n' : ''}Billing Details - service from ${from} to ${to}\n${body}`;

function makeText(withContinued) {
  const A = ['06/07/2023', '07/09/2023'];
  const B = ['07/09/2023', '08/07/2023'];
  const C = ['08/07/2023', '09/06/2023'];
  let t = '';
  t += front(1, A[0], A[1], '100.00', null, null, null);
  t += details(2, A[0], A[1], 'Customer Chg $25.00\nCurrent Charges $100.00\n');
  t += front(3, B[0], B[1], '150.00', '140.00', '10.00', '100.00');
  t += details(
    4,
    B[0],
    B[1],
    'Customer Chg $25.00\nFacilities Chg 10.0000 kW at $5.000 per kW $50.00\nDemand Chg 5.0000 kW at $13.000 per kW $65.00\nCurrent Charges $140.00\n',
  );
  if (withContinued) t += details(5, B[0], B[1], 'Subtotal $140.00\nCurrent Charges $140.00\n', true);
  const n = withContinued ? 6 : 5;
  t += front(n, C[0], C[1], '90.00', null, null, '150.00');
  t += details(n + 1, C[0], C[1], 'Customer Chg $25.00\nCurrent Charges $90.00\n');
  return t;
}

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}

const rule = loadRule(jsPath);

console.log('Case 1: bill B has a Continued billing-details page');
let bills = rule.extractAll(makeText(true));
check('three bills', bills.length === 3, 'got ' + bills.length);
const [a, b] = bills;
check('A has no Miscellaneous charge', a && a.MiscellaneousCharge == null, 'A misc=' + (a && a.MiscellaneousCharge));
check(
  'B Miscellaneous = 10.00',
  b && String(b.MiscellaneousCharge) === '10.00',
  'B misc=' + (b && b.MiscellaneousCharge),
);
check('B total = 150.00', b && String(b.TotalCurrentCharges) === '150.00', 'B total=' + (b && b.TotalCurrentCharges));
check(
  'B PreviouslyBilled = 100.00',
  b && String(b.PreviouslyBilled) === '100.00',
  'B prev=' + (b && b.PreviouslyBilled),
);
check(
  'A pages 1-2',
  a && a._pageStart === 1 && a._pageEnd === 2,
  'A pages ' + (a && a._pageStart) + '-' + (a && a._pageEnd),
);
check(
  'B pages 3-5',
  b && b._pageStart === 3 && b._pageEnd === 5,
  'B pages ' + (b && b._pageStart) + '-' + (b && b._pageEnd),
);

console.log('Case 2 (control): no Continued page');
bills = rule.extractAll(makeText(false));
check('three bills', bills.length === 3, 'got ' + bills.length);
check('A has no Miscellaneous charge', bills[0] && bills[0].MiscellaneousCharge == null);
check('B Miscellaneous = 10.00', bills[1] && String(bills[1].MiscellaneousCharge) === '10.00');
check('B total = 150.00', bills[1] && String(bills[1].TotalCurrentCharges) === '150.00');

if (process.env.DBG)
  console.log(JSON.stringify(bills[1], (k, v) => (k[0] === '_' && k !== '_miscUnreconciled' ? undefined : v)));
console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASSED');
process.exit(fail ? 1 : 0);
