/**
 * test-wre-parser-regression.js
 *
 * Standalone regression test for the WRE (gas supplier) parser in
 * app/energy-savings.js - no browser required. Loads the real UTILITY_RULES
 * array via Node's vm module (same source, same code path as production -
 * NOT a reimplementation) and runs WRE.extractAll() against SYNTHETIC
 * raw-OCR-text fixtures (tools/synthetic-fixtures/wre-synth-*.txt).
 *
 * The fixtures are committed to git. They hold invented names, addresses,
 * account numbers and amounts only, in the same layout as a real bill.
 * EXPECTED below is the parser output on those files.
 *
 * Fixtures:
 *   - wre-synth-clean.txt    Clean digital text. Every site reconciles.
 *   - wre-synth-swe.txt      Every site prints a Special Weather Event line.
 *                            Trigger + Index + SWE must reconcile with the
 *                            printed Sub-Total (SWE-omitted-from-validation fix).
 *   - wre-synth-dropout.txt  Index line reads "6557" (decimal dropped) while
 *                            the Sub-Total line reads "65.57". The sum/100
 *                            reconciliation must suppress the false mismatch
 *                            flag. GasCharge stays null (no cents captured).
 *   - wre-synth-corrupt.txt  Index line is corrupted, digits scrambled. The
 *                            site MUST stay null and flagged. No digit
 *                            reconstruction.
 *
 * A check on real bills is a local-only job. Keep real fixtures outside the
 * repo (the reference folder, outside git). Never commit them.
 *
 * Usage: node tools/test-wre-parser-regression.js [path-to-energy-savings.js]
 *   (defaults to ../app/energy-savings.js relative to this file)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');
const FIXTURE_DIR = path.join(__dirname, 'synthetic-fixtures');

function loadWRE(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'formatting.js'), 'utf8'), sandbox, {
    filename: 'formatting.js',
  });
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  if (!rules) throw new Error('UTILITY_RULES not found in ' + scriptPath);
  const wre = rules.find((r) => r.name === 'Wood River Energy');
  if (!wre) throw new Error('Wood River Energy parser not found in ' + scriptPath);
  return wre;
}

function run(wre, fixtureFile) {
  const text = fs.readFileSync(path.join(FIXTURE_DIR, fixtureFile), 'utf8');
  return wre.extractAll(text);
}

// Expected per-site results. mmbtu/charge are `null` sentinel-compared as
// strict equality against the string/number the parser actually returns
// (NaturalGasMMbtu is stored as a String; GasCharge/TotalCurrentCharges are
// numbers since 2026-10-08 (shared parseBillNumber), so charge strings below are
// compared as parseFloat(charge)).
const EXPECTED = {
  'wre-synth-clean.txt': [
    { addr: 'Site One - 1 Alpha St', mmbtu: '13', charge: '54.52' },
    { addr: 'Site Two - 2 Beta St', mmbtu: '26', charge: '109.00' },
    { addr: 'Site Three - 3 Gamma St', mmbtu: '30', charge: '126.92' },
  ],
  'wre-synth-swe.txt': [
    { addr: 'Site One - 1 Alpha St', mmbtu: '120', charge: '620.84' },
    { addr: 'Site Two - 2 Beta St', mmbtu: '180', charge: '931.52' },
  ],
  'wre-synth-dropout.txt': [
    { addr: 'Site One - 1 Alpha St', mmbtu: '13', charge: '54.59' },
    { addr: 'Site Two - 2 Beta St', mmbtu: '65.57', charge: null },
  ],
  'wre-synth-corrupt.txt': [
    { addr: 'Site One - 1 Alpha St', mmbtu: '13', charge: '54.59' },
    { addr: 'Site Two - 2 Beta St', mmbtu: null, charge: null, manualReview: true, mmbtuRateMismatch: true },
  ],
};

function eq(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  return actual === expected;
}

let totalFail = 0;
let totalPass = 0;
const missingFixtures = Object.keys(EXPECTED).filter((f) => !fs.existsSync(path.join(FIXTURE_DIR, f)));
if (missingFixtures.length) {
  console.log('FAIL: fixture(s) missing: ' + missingFixtures.join(', '));
  process.exit(1);
}

const wre = loadWRE(jsPath);
console.log('Loaded WRE parser from: ' + jsPath + '\n');

for (const [fixtureFile, expected] of Object.entries(EXPECTED)) {
  const results = run(wre, fixtureFile);
  console.log('--- ' + fixtureFile + ' (' + results.length + ' sites) ---');
  if (results.length !== expected.length) {
    console.log('  FAIL: expected ' + expected.length + ' sites, got ' + results.length);
    totalFail++;
    continue;
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const act = results[i];
    const expCharge = exp.charge === null ? null : parseFloat(exp.charge);
    const checks = [
      ['mmbtu', eq(act.NaturalGasMMbtu, exp.mmbtu)],
      ['charge', eq(act.GasCharge, expCharge) && eq(act.TotalCurrentCharges, expCharge)],
      ['manualReview', !!act._manualReview === !!(exp.manualReview || false)],
      ['mmbtuRateMismatch', !!act._mmbtuRateMismatch === !!(exp.mmbtuRateMismatch || false)],
    ];
    const failed = checks.filter((c) => !c[1]);
    const addrOk = exp.addr === '' || (act.ServiceAddress || '').indexOf(exp.addr.slice(0, 10)) !== -1;
    if (failed.length === 0 && addrOk) {
      totalPass++;
      console.log('  PASS #' + (i + 1) + ' ' + exp.addr);
    } else {
      totalFail++;
      console.log(
        '  FAIL #' +
          (i + 1) +
          ' ' +
          exp.addr +
          ' | addrOk=' +
          addrOk +
          ' | failed=' +
          failed.map((f) => f[0]).join(',') +
          ' | actual: mmbtu=' +
          act.NaturalGasMMbtu +
          ' charge=' +
          act.GasCharge +
          ' manualReview=' +
          !!act._manualReview +
          ' mmbtuRateMismatch=' +
          !!act._mmbtuRateMismatch,
      );
    }
  }
  console.log('');
}

console.log('='.repeat(50));
console.log('TOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed');
process.exit(totalFail > 0 ? 1 : 0);
