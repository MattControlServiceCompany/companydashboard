/**
 * test-wre-total-is-number.js
 *
 * Regression test for the gas supplier site reader (app/energy-savings.js). A site total of
 * 1,000 or more was kept as text with its thousands comma ("1,020.00"). A reader that uses
 * parseFloat on that text gets 1. The totals must be numbers (shared parser parseBillNumber).
 * SYNTHETIC text only (fake district, addresses, accounts, round figures). Same layout shape as the
 * WRE invoice: Item/Mmbtu/Fuel/Rate/$ lines, Sub-Total per site, Total Natural Gas summary.
 *
 * Usage: node tools/test-wre-total-is-number.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadRule(scriptPath, ruleName) {
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'formatting.js'), 'utf8'), sandbox, {
    filename: 'formatting.js',
  });
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  const rule = rules && rules.find((r) => r.name.indexOf(ruleName) === 0);
  if (!rule) throw new Error(ruleName + ' rule not found in ' + scriptPath);
  return rule;
}

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}

const text = `
WoodRiver Energy
Natural Gas Invoice
Customer #: 900000
Fake School District 999                                                          Invoice #: 900001
Attn: Fake Contact                                                                Production Month: January 2099
100 Fake Pkwy                                                          Acct Rep: Fake Rep
Faketown, KS 00000                                                                Bill Date: 01/01/2099
Pmt Due Date: 01/16/2099
Item Mmbtu Fuel Rate $
Service Address: Test Elementary - 100 Test St                                   Acct/Meter: A0001/M000001A
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Index (FOM)   200.00   4.00   $5.0000   $1,020.00
Sub-Total:   200.00   4.00   $1,020.00
Service Address: Test Middle - 200 Test Ave                                      Acct/Meter: 9001/M000002B
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Index (FOM)   8.20   0.13   $5.0000   $41.65
Sub-Total:   8.20   0.13   $41.65
Mmbtu Fuel $
Total Natural Gas: 208.20 4.13 $1,061.65
Total Fees: $0.00
Total Tax: $0.00
Total Current Charges: $1,061.65
`;

const rule = loadRule(jsPath, 'Wood River Energy');
const sites = rule.extractAll(text);
check('two sites', sites.length === 2, 'got ' + sites.length);
if (sites.length === 2) {
  for (const [i, want] of [
    [0, 1020],
    [1, 41.65],
  ]) {
    const s = sites[i];
    const n = 'site ' + (i + 1);
    check(
      n + ' TotalCurrentCharges is a number',
      typeof s.TotalCurrentCharges === 'number',
      'got ' + JSON.stringify(s.TotalCurrentCharges),
    );
    check(
      n + ' TotalCurrentCharges is ' + want,
      Math.abs(Number(s.TotalCurrentCharges) - want) < 0.005,
      'got ' + JSON.stringify(s.TotalCurrentCharges),
    );
    check(
      n + ' TotalAmountDue is a number',
      typeof s.TotalAmountDue === 'number',
      'got ' + JSON.stringify(s.TotalAmountDue),
    );
  }
}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
