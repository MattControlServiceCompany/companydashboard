/**
 * test-kgs-service-address.js
 *
 * Regression test for the Kansas Gas Service ServiceAddress reader (Gas Utility rule in
 * app/energy-savings.js). Before the fix every KGS bill got ServiceAddress = "Statement Date":
 *   1. the street-address regex had a typo quantifier that never matched;
 *   2. the mailing-stub fallback could start mid-line and take the label text "Statement Date".
 * SYNTHETIC text only (fake name, address, account, amounts). Same layout shape as a KGS page:
 * header line "NAME  Account Number ...", address line with "Active Deposit ... Statement Date",
 * then "BALDWIN CITY, KS" and a mailing stub that repeats the address.
 *
 * Usage: node tools/test-kgs-service-address.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadRule(scriptPath, ruleName) {
  // convertUnit (app/utility-data.js) only turns Mcf into therms here; this test checks the address only.
  const sandbox = { window: {}, convertUnit: (v) => v * 10, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
  }
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

const page = (addrLine) =>
  [
    '%%PAGE_1%%',
    'Kansas Gas Service',
    'PO Box 219046',
    'Amount Due                                        $100.00',
    'SYNTH CUSTOMER                                   Account Number                                   123456789 2059999 99',
    'DIRECTOR OF FACILITIES                         Rate                General Service Sm',
    addrLine,
    'BALDWIN CITY, KS 66006',
    'RATE SCHEDULE(S) AVAILABLE UPON REQUEST',
    'Previous Balance                                               $90.00',
    'Service Charge                                    $32.20',
    'Delivery Charge                                       40.00',
    'Cost of Gas                                            27.80',
    'Total Current Charges                                                           $100.00',
    'Total Amount Due                                                                         $100.00',
    'Service Period          Number Meter Readings                              Mcf           WNA/               Cost of',
    'Meter Number        From       To       of Days Previous Present    Constant     Billed        Mcf          Gas/Mcf',
    '0999A00000                01-19-26      02-17-26           29              100        150         1.0000          5.000           $0.2034                7.0117',
    'Please return this portion when paying by mail.',
    '100 SYNTH AVE      NE',
    'BALDWIN CITY, KS 66006',
  ].join('\n');

const rule = loadRule(jsPath, 'Gas Utility');
const cases = [
  [
    'clean address line',
    page(
      '100 SYNTH AVE                          Active Deposit                         NONE | Statement Date                      02-20-26',
    ),
  ],
  [
    'garbled address line (falls back to the mailing stub)',
    page('100 SYNTH AVE ABCDEFGH       ew  Di     it      Genera! A  Statement Date                 02-20-26'),
  ],
];
for (const [label, text] of cases) {
  const bills = rule.extractAll(text);
  check(label + ': one bill', bills.length === 1, 'got ' + bills.length);
  const addr = bills[0] && bills[0].ServiceAddress;
  check(
    label + ': ServiceAddress is the street address',
    /^100 SYNTH AVE/.test(addr || ''),
    'got ' + JSON.stringify(addr),
  );
  check(
    label + ': ServiceAddress is not label text',
    !/Statement|Date|Active/i.test(addr || ''),
    'got ' + JSON.stringify(addr),
  );
}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
