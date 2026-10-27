/**
 * test-kgs-therms-constant.js
 *
 * KGS "Billed Mcf" already includes the meter constant: Mcf = (present - previous) / 10 x constant.
 * Therms must be Mcf x 10 with no second constant. SYNTHETIC values only.
 * Checks _kgsThermsOf, the Mcf-from-reads rule, and that no call site passes a constant.
 *
 * Usage: node tools/test-kgs-therms-constant.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, detail) {
  if (!cond) {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}

const sandbox = {
  window: {},
  convertUnit: (v) => v * 10, // DTh to Therms factor (utility-data.js)
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
for (const rel of ['lib/formatting.js', 'computations/rates.js', 'app/energy-savings.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const fn = vm.runInContext('_kgsThermsOf', sandbox);

// Synthetic reads 1000 -> 1420, constant 1.0171: Mcf = 420 / 10 x 1.0171 = 42.718
const mcf1 = ((1420 - 1000) / 10) * 1.0171;
check('printed Mcf from reads and constant 1.0171', Math.abs(mcf1 - 42.718) < 0.0005, mcf1);
check('constant 1.0171 gives 427.18 therms', fn('42.718', '1.0171') === '427.18', fn('42.718', '1.0171'));
check('constant 1.0000 gives 427.18 therms', fn('42.718', '1.0000') === '427.18', fn('42.718', '1.0000'));
check('Mcf 51.567 gives 515.67 therms', fn('51.567') === '515.67', fn('51.567'));
check('zero Mcf gives null', fn('0') === null);
check('_kgsThermsOf has one parameter', fn.length === 1, fn.length);

const src = fs.readFileSync(path.join(ROOT, 'app/energy-savings.js'), 'utf8');
check('no call site passes a constant', !/_kgsThermsOf\([^)]*,/.test(src));

if (failed) {
  console.log(failed + ' check(s) failed');
  process.exit(1);
}
console.log('test-kgs-therms-constant: all checks passed');
