/**
 * test-kgs-weather-delayed-lines.js
 *
 * Synthetic test: the gas reader extracts Weather Normalization and Delayed Payment Charge
 * (plain, minus sign, CR suffix), and the saved-row field list and the row builders carry
 * weatherNormalization and delayedPaymentCharge. Fake account 900123, invented amounts.
 *
 * Usage: node tools/test-kgs-weather-delayed-lines.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function load() {
  const sandbox = {
    window: {},
    convertUnit: (v) => v * 10, // Mcf to therms only; this test checks charge lines, not usage
    document: { getElementById: () => null, addEventListener: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    navigator: { userAgent: 'node' },
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
  for (const rel of ['lib/formatting.js', 'computations/rates.js', 'app/energy-savings.js', 'app/bill-analysis.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  vm.runInContext('function forEachCustomerBuilding(projectsList, fn) {}', sandbox);
  return vm.runInContext('({ rules: UTILITY_RULES, verify: _postExtractionVerify })', sandbox);
}


const env = load();
const rule = env.rules.find((r) => /^Gas Utility/.test(r.name));
function text(wna, delayed, total) {
  return [
    'DEMO CUSTOMER                          Account Number            100200300 900123 45',
    'Rate          General Service Sm',
    'Active Deposit   NONE | Statement Date   01-20-26',
    'Service Charge                     30.00',
    'Delivery Charge                     20.00',
    wna,
    'Cost of Gas                           40.00',
    delayed,
    total,
    'Meter Number        From        To       of Days Previous Present   Constant   Billed     Mcf    Gas/Mcf',
    'A1B2C3D4E5    12-19-25   01-19-26    31    100    200   1.0000   10.000   0.2500   4.0000',
  ].join('\n');
}
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name);
  else { failures++; console.error('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}
const ex = (w, d) => rule.extractAll.call(rule, text(w, d, 'Total Current Charges                 £92.00'))[0];
let b = ex('Weather Normalization                 2.50', 'Delayed Payment Charge               1.27');
check('WNA plain positive', b.WeatherNormalization === '2.50', String(b.WeatherNormalization));
check('Delayed plain positive', b.DelayedPaymentCharge === '1.27', String(b.DelayedPaymentCharge));
b = ex('Weather Normalization                 0.16CR', 'Delayed Payment Charge               1.27CR');
check('WNA CR negative', b.WeatherNormalization === '-0.16', String(b.WeatherNormalization));
check('Delayed CR negative', b.DelayedPaymentCharge === '-1.27', String(b.DelayedPaymentCharge));
b = ex('Weather Normalization                 -0.16', 'Delayed Payment Charge               -1.34');
check('WNA minus negative', b.WeatherNormalization === '-0.16', String(b.WeatherNormalization));
check('Delayed minus negative', b.DelayedPaymentCharge === '-1.34', String(b.DelayedPaymentCharge));
b = ex('Weather Normalization                 $-5.00', 'Delayed Payment Charge               $-5.00');
check('WNA $- negative', b.WeatherNormalization === '-5.00', String(b.WeatherNormalization));
check('Delayed $- negative', b.DelayedPaymentCharge === '-5.00', String(b.DelayedPaymentCharge));
b = ex('Weather Normalization                 -$5.00', 'Delayed Payment Charge               -$5.00');
check('WNA -$ negative', b.WeatherNormalization === '-5.00', String(b.WeatherNormalization));
check('Delayed -$ negative', b.DelayedPaymentCharge === '-5.00', String(b.DelayedPaymentCharge));
b = ex('Weather Normalization                 $0.16', 'Cost of Gas again');
check('Delayed absent is null', b.DelayedPaymentCharge === null, String(b.DelayedPaymentCharge));

const gate = fs.readFileSync(path.join(ROOT, 'computations/bill-save-fields.gate.js'), 'utf8');
const ba = fs.readFileSync(path.join(ROOT, 'app/bill-analysis.js'), 'utf8');
check('one saved-field table', ba.includes('const KGS_GAS_SAVED_FIELDS = ['));
check('table has both keys', /extractedKey: 'WeatherNormalization', savedKey: 'weatherNormalization'/.test(ba) && /extractedKey: 'DelayedPaymentCharge', savedKey: 'delayedPaymentCharge'/.test(ba));
check('three paths use the table', (ba.match(/kgsGasSavedEntries\(/g) || []).length === 3 && ba.includes('...KGS_GAS_STATEMENT_FIELDS].map'));
check('no literal copy of the keys', !/^\s*weatherNormalization: /m.test(ba) && !/^\s*WeatherNormalization: 'weatherNormalization'/m.test(ba));
check('gate derives from the table', gate.includes('KGS_GAS_SAVED_FIELDS') && !gate.includes("'weatherNormalization'"));
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('All KGS weather/delayed line tests passed');
