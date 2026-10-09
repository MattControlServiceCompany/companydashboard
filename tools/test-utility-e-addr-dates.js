/**
 * test-utility-e-addr-dates.js
 *
 * Regression test for two Utility E extractAll defects in app/energy-savings.js:
 *  1. ADDRESS BLEED. A stray ":" after the state made _EVG_ADDR fail for that page, so the bill took the
 *     FIRST address in the document (another building) in a multi-account document.
 *  2. DROPPED BILL. OCR read "service from | 02/01/2030 to 03/01/2030". The "|" broke the date regexes,
 *     the bill was dropped, its page went to the next bill, and Customer Chg was summed twice.
 *
 * SYNTHETIC text only (fake accounts, addresses, dates, amounts).
 * Usage: node tools/test-utility-e-addr-dates.js [path-to-energy-savings.js]
 *   Pass a PRE-FIX copy to confirm the test fails on the old code.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadRule(scriptPath) {
  const calcDays = (s, e) => Math.round((new Date(e) - new Date(s)) / 864e5);
  const sandbox = { window: {}, calcDays, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
  }
  // energy-savings.js calls sumElectricEnergyCharges from computations/rates.js (loaded before it in production).
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'computations', 'rates.js'), 'utf8'), sandbox, { filename: 'rates.js' });
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  const rule = rules && rules.find((r) => r.name === 'Evergy');
  if (!rule) throw new Error('Rule not found in ' + scriptPath);
  return rule;
}

const front = (n, acct, addr, from, to, total) =>
  `%%PAGE_${n}%%\nAccount Number: ${acct}\n${addr}\nFor service from ${from} to ${to}\nCurrent Charges (details on back).......... $${total}\n`;
const details = (n, acct, addr, sep, from, to, kwh, rate) =>
  `%%PAGE_${n}%%\nAccount Number: ${acct}\n${addr}\nLGS Secondary Voltage - ${rate}      Billing Details - service from${sep}${from} to ${to}\n` +
  `Customer Chg $10.00\nEnergy Chg ${kwh}.0000 kWh at $0.08807 per kWh $${(kwh * 0.08807).toFixed(2)}\nCurrent Charges $${(10 + kwh * 0.08807).toFixed(2)}\n`;

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}
const rule = loadRule(jsPath);

// Two accounts. Account 1 prints first (so its address is the first in the document).
function addrText(addrB) {
  let t = '';
  t += front(5, '3000003', '300 THIRD ST TESTVILLE KS', '01/09/2030', '02/09/2030', '310.00');
  t += details(6, '3000003', '300 THIRD ST TESTVILLE KS', ' ', '01/09/2030', '02/09/2030', 3000, '2LGSE');
  t += front(1, '1000001', '100 FIRST ST TESTVILLE KS', '01/01/2030', '02/01/2030', '110.00');
  t += details(2, '1000001', '100 FIRST ST TESTVILLE KS', ' ', '01/01/2030', '02/01/2030', 1000, '2LGSE');
  t += front(3, '2000002', addrB, '01/05/2030', '02/05/2030', '210.00');
  t += details(4, '2000002', addrB, ' ', '01/05/2030', '02/05/2030', 2000, '2MGSE');
  return t;
}

console.log('Case 1: address line of bill B ends with a stray ":"');
let bills = rule.extractAll(addrText('200 SECOND ST TESTVILLE KS      :'));
check('three bills', bills.length === 3, 'got ' + bills.length);
let b = bills.find((x) => /2MGSE/.test(x.RateSchedule || ''));
check(
  'B keeps its own address',
  b && b.ServiceAddress === '200 SECOND ST TESTVILLE KS',
  'B addr=' + (b && b.ServiceAddress),
);
check('B rate is 2MGSE', b && b.RateSchedule === '2MGSE', 'B rate=' + (b && b.RateSchedule));

console.log('Case 2: address line of bill B is unreadable');
bills = rule.extractAll(addrText('2OO SECOND $T'));
b = bills.find((x) => /2MGSE/.test(x.RateSchedule || ''));
check(
  'B never takes the address of another building',
  b && b.ServiceAddress == null,
  'B addr=' + (b && b.ServiceAddress),
);

console.log('Case 3 (control): clean address lines');
bills = rule.extractAll(addrText('200 SECOND ST TESTVILLE KS'));
b = bills.find((x) => /2MGSE/.test(x.RateSchedule || ''));
check('B address', b && b.ServiceAddress === '200 SECOND ST TESTVILLE KS', 'B addr=' + (b && b.ServiceAddress));

// Three bills, one account, billing-details page only (no cover page), as in the real scans. The middle bill header reads "service from | <date>".
function dateText(sep) {
  const P = [
    ['01/01/2030', '02/01/2030', 1000],
    ['02/01/2030', '03/01/2030', 2000],
    ['03/01/2030', '04/01/2030', 3000],
  ];
  const A = '100 FIRST ST TESTVILLE KS';
  let t = '';
  P.forEach((p, i) => {
    const s = i === 1 ? sep : ' ';
    t += details(i + 1, '1000001', A, s, p[0], p[1], p[2], '2LGSE');
  });
  return t;
}
for (const sep of [' | ', ' ! ', ': ']) {
  const known = sep === ' ! ';
  console.log(
    'Case 4: middle header reads "service from' + sep + '02/01/2030"' + (known ? ' (negative: "!" is not read)' : ''),
  );
  bills = rule.extractAll(dateText(sep));
  if (known) {
    check('no false extra bill', bills.length <= 3, 'got ' + bills.length);
    continue;
  }
  check('three bills', bills.length === 3, 'got ' + bills.length);
  check(
    'every Customer Charge is 10.00',
    bills.every((x) => Number(x.CustomerCharge) === 10),
    bills.map((x) => x.CustomerCharge).join(','),
  );
  check(
    'each OnPeakKWh is its own value',
    bills.map((x) => Math.round(x.OnPeakKWh)).join(',') === '1000,2000,3000',
    bills.map((x) => x.OnPeakKWh).join(','),
  );
}

console.log('Case 5 (negative): garbled header with no dates adds no bill');
bills = rule.extractAll(
  dateText(' ').replace(
    /Billing Details - service from 02\/01\/2030 to 03\/01\/2030/,
    'Billing Details - service from ?? to ??',
  ),
);
check('no more than three bills', bills.length <= 3, 'got ' + bills.length);

console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASSED');
process.exit(fail ? 1 : 0);
