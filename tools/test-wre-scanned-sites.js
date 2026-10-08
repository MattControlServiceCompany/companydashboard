/**
 * test-wre-scanned-sites.js
 *
 * Regression test for the Wood River Energy site reader (app/energy-savings.js) on a SCANNED
 * invoice. The scan cuts off the right-hand $ columns and garbles some row labels. Every site must
 * still give its Mmbtu and its charge. The charge is rebuilt from the invoice's printed formula
 * (Mmbtu + Fuel) x Rate. Four sites: (1) no $ columns; (2) rate misread; (3) Sub-Total label lost,
 * numbers kept; (4) Index and Sub-Total labels both garbled.
 * SYNTHETIC text only (fake district, addresses, accounts, round figures).
 *
 * Usage: node tools/test-wre-scanned-sites.js [path-to-energy-savings.js]
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
Index (FOM)                                              100.00                 1.60           $5.0000
Sub-Total:                                                                      100.00                 1.60
Service Address: Test Middle - 200 Test Ave                                      Acct/Meter: 9001/M000002B
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Index (FOM)                                              10.00                  0.16           £50000
Sub-Total:                                                                      10.00                  0.16
Service Address: Test High - 300 Test Blvd                                       Acct/Meter: 9002/M000003C
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Index (FOM)                                              20.00                  0.32           $5.0000
E       -                                                                       20.00                  0.32
Service Address: Test Annex - 400 Test Ct                                        Acct/Meter: 9003/M000004D
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
dex (FOM                                                 30.00                  0.48           $5.0000
b-Total:                                                                        30.00                  0.48
Mmbtu Fuel $
Total Natural Gas: 160.00 2.56 $812.80
Total Fees: $0.00
Total Tax: $0.00
Total Current Charges: $812.80
`;

const rule = loadRule(jsPath, 'Wood River Energy');
const sites = rule.extractAll(text);
check('four sites', sites.length === 4, 'got ' + sites.length);
if (sites.length === 4) {
  for (const [i, mm, want] of [
    [0, 100, 508.0],
    [1, 10, 50.8],
    [2, 20, 101.6],
    [3, 30, 152.4],
  ]) {
    const s = sites[i];
    const n = 'site ' + (i + 1);
    check(n + ' NaturalGasMMbtu is ' + mm, Math.abs(Number(s.NaturalGasMMbtu) - mm) < 0.005, 'got ' + JSON.stringify(s.NaturalGasMMbtu));
    check(n + ' TotalCurrentCharges is ' + want, Math.abs(Number(s.TotalCurrentCharges) - want) < 0.005, 'got ' + JSON.stringify(s.TotalCurrentCharges));
  }
}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
