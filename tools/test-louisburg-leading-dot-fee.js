/**
 * test-louisburg-leading-dot-fee.js
 *
 * Regression test for the City of Louisburg old-format line reader (parseLine / _lbg_tokens in
 * app/energy-savings.js). A charge printed with no leading zero (".45") was read as 45, so the
 * water total was wrong by about $44. SYNTHETIC text only (fake account, address, amounts). Same
 * layout shape as an old-format page: GAS, FUEL ADJUSTMENT, STORM WATER, SEWER,
 * WATER PROTECTION FEE (".45"), WATER lines with Present, Previous, Usage and charge columns.
 *
 * Usage: node tools/test-louisburg-leading-dot-fee.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadRule(scriptPath, ruleName) {
  const sandbox = { window: {}, TextEncoder, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
  }
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: path.basename(scriptPath) });
  // convertUnit and calcDays live in app/utility-data.js (function declarations; its page-start code may throw in Node).
  try {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'utility-data.js'), 'utf8'), sandbox, { filename: 'utility-data.js' });
  } catch (e) {
    /* declarations are already defined */
  }
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

const text = [
  '%%PAGE_1%%',
  'ACCOUNT SUMMARY',
  'Louisburg, KS 66053',
  'Service Address 100 S. SYNTH ST Account # 999000 Bill Date: 2/01/25',
  '12/15/24 1/15/25',
  'GAS 5100 4500 600 120.50',
  'FUEL ADJUSTMENT 10.25-',
  'STORM WATER 3.00',
  'SEWER 7000100 6990100 10000 80.00',
  'WATER PROTECTION FEE 7000100 6990100 10000 .45',
  'WATER 7000100 6990100 10000 90.25',
  'Past due balance: $.00',
  'Amount due on or before 2/10/25: $300.00',
  'Amount due after 2/10/25: $300.00',
].join('\n');

const rule = loadRule(jsPath, 'City of Louisburg');
const bills = rule.extractAll(text);
const water = bills.find((b) => b.Commodity === 'Water');
check('water bill found', !!water, 'commodities: ' + bills.map((b) => b.Commodity).join(','));
if (water) {
  check(
    'WaterProtectionFee is 0.45',
    Math.abs(Number(water.WaterProtectionFee) - 0.45) < 0.001,
    'got ' + water.WaterProtectionFee,
  );
  check(
    'water total is 90.70',
    Math.abs(Number(water.TotalCurrentCharges) - 90.70) < 0.005,
    'got ' + water.TotalCurrentCharges,
  );
}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
