/**
 * test-utility-e-line-parser.js
 *
 * Standalone regression test for the Utility E charge-line reader (group G2):
 *  - f260c39f: a 2-line energy charge where OCR reads "at" as "al" must not return the rate cut to
 *    2 decimals as the charge; a 1-decimal figure in bill prose is not a charge.
 *  - fdc85759: a rate whose digit 3 was read as 8 or 9 (or got an extra digit) is repaired only when
 *    the one-digit repair makes qty x rate equal the line's own charge.
 *  - b8123c92: the Utility E extractor sets Commodity 'Electric'.
 *
 * SYNTHETIC text only: invented lines and small invented amounts. No real bill data.
 * Loads the REAL extractor (app/energy-savings.js) with Node's vm module.
 *
 * Usage: node tools/test-utility-e-line-parser.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sandbox = {
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: '', search: '' } },
  document: { getElementById: () => null, addEventListener: () => {} },
  console: { log: () => {}, warn: () => {}, error: () => {} },
  navigator: { userAgent: 'node' },
  TextEncoder,
  TextDecoder,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  addEventListener: () => {},
  fetch: () => Promise.reject(new Error('no fetch in test sandbox')),
};
vm.createContext(sandbox);
for (const rel of ['lib/date-helpers.js', 'lib/formatting.js', 'computations/rates.js', 'app/utility-data.js', 'app/energy-savings.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const api = vm.runInContext(
  '({ amounts: _evgChargeAmounts, repair: _evgRateDigitRepair, rules: UTILITY_RULES })',
  sandbox,
);

let pass = 0;
const fails = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push(label + ': expected ' + e + ', got ' + a);
}

// --- f260c39f: charge amounts on one line
eq(api.amounts('Energy Chg Off Pk Win 1,000.0000 kWh at $0.06407'), [], 'rate after "at" is not a charge');
eq(api.amounts('Energy Chg Off Pk Win 1,000.0000 kWh al $0.03888'), [], 'rate after OCR "al" is not a charge');
eq(api.amounts('$0.03888 per kWh ..........  $12.34'), [12.34], 'charge after a rate on the same line');
eq(api.amounts('$0.03888 por kWh ..........  $12.34'), [12.34], 'OCR "por" rate is skipped');
eq(api.amounts('Facilities Chg 10.0000 kW at $2.501 per kW  $25.01'), [25.01], 'per kW rate is skipped');
eq(api.amounts('Subtotal $50.00'), [50], 'a word ending in "al" before the amount still counts');
eq(api.amounts('Customer Chg ........ $1,234.56'), [1234.56], 'thousands comma');
eq(api.amounts('results in a decrease of $32.9 million'), [], '1-decimal figure in prose is not a charge');
eq(api.amounts('kWh: October - $0.01677, November - $0.01619'), [], 'rates in prose are not charges');
eq(api.amounts('Charge $0.50'), [0.5], 'a real 2-decimal charge under 1 is kept');

// --- fdc85759: one-digit repair of a read rate
eq(api.repair(0.08266, 1000, 32.66), 0.03266, 'digit 8 read for 3');
eq(api.repair(0.02915, 1000, 29.15), null, 'correct rate: no repair');
eq(api.repair(0.038723, 400, 14.89), 0.03723, 'extra digit dropped');
eq(api.repair(0.09999, 1000, 77.0), null, 'no repair reconciles: null');
eq(api.repair(0.08266, 0, 32.66), null, 'no quantity: null');

// --- 2-line energy layout with "al" garble, whole extractor
const text = [
  'Customer Name  TEST SCHOOL DISTRICT',
  'Account Number 100200300',
  'Billing Details - service from 01/01/2026 to 01/31/2026',
  'Customer Chg ............................ $10.00',
  'Energy Chg Off Pk Win 1,000.0000 kWh al $0.03888',
  '1000 per kWh ........................ $38.88',
  'Subtotal .................................. $48.88',
  'Current Charges ........................... $48.88',
].join('\n');
const rule = api.rules.find((r) => r.detect(text));
const bill = rule ? [].concat(rule.extractAll ? rule.extractAll(text) : rule.extract(text))[0] : {};
eq(bill.Commodity, 'Electric', 'Utility E extractor sets Commodity');
eq(String(bill.EnergyOffPeakCharge), '38.88', '2-line "al" layout: full charge, not the cut rate');
eq(String(bill.CustomerCharge), '10.00', 'customer charge');

if (fails.length) {
  console.log('FAIL ' + fails.length + ' of ' + (pass + fails.length));
  fails.forEach((f) => console.log('  ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + ' of ' + pass);
