/**
 * test-gas-unit-conversion.js  (WP-02, math-audit 2026-09-28)
 *
 * Acceptance test: ONE gas unit resolver (resolveGasUsageTherms, computations/savings.js) and the
 * CSV gas column mapping. Synthetic data only. Loads the REAL app files through Node's vm module.
 *
 *  1. Resolver: therms, then CCF, then MMBtu. 1 MMBtu = 10 therms. CCF factor = the bill's printed
 *     ThermFactor when present, else UNIT_TO_BASE.CCF.factor. Test with ThermFactor present and absent.
 *  2. CSV header mapping: gas_ccf / ccf_used / naturalGasCCF -> CCF x factor; naturalGasMMbtu -> x10;
 *     ccf_used next to therm_cost never writes the cost into therms. The source unit is stored.
 *  3. Round trip: the app's export header names re-import to the same therms.
 *  4. No private conversion factor (1.037) is left outside UNIT_TO_BASE.
 *
 * Usage: node tools/test-gas-unit-conversion.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

function makeSandbox() {
  const noop = () => {};
  const el = new Proxy(function () {}, {
    get: (t, k) => (k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop, contains: () => false } : noop),
    apply: () => el,
  });
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      createElement: () => el,
      body: el,
    },
    console: { log: noop, warn: noop, error: noop },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    requestAnimationFrame: () => 0,
    addEventListener: noop,
    removeEventListener: noop,
    showToast: noop,
    fetch: () => Promise.reject(new Error('no fetch')),
    forEachCustomerBuilding: noop,
    sget: (k, d) => d,
    sset: noop,
    projects: [],
    TextEncoder,
    TextDecoder,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
const ctx = makeSandbox();
for (const rel of [
  'lib/formatting.js',
  'computations/rates.js',
  'computations/savings.js',
  'app/utility-data.js',
  'app/csv-import.js',
]) {
  try {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), ctx, { filename: rel });
  } catch (e) {
    check('load ' + rel, false, String(e && e.message).split('\n')[0]);
  }
}
const R = (s) => vm.runInContext(s, ctx);

// ── 1. Resolver ─────────────────────────────────────────────────────────────────────────────
const resolve = R('typeof resolveGasUsageTherms === "function" ? resolveGasUsageTherms : null');
check('resolveGasUsageTherms exists', typeof resolve === 'function');
const ccfFactor = R('UNIT_TO_BASE.CCF.factor');
check('UNIT_TO_BASE.CCF.factor is a positive number', ccfFactor > 0, ccfFactor);
if (typeof resolve === 'function') {
  check(
    'therms wins over CCF and MMBtu',
    resolve({ therms: '500', naturalGasCCF: '1000', naturalGasMMbtu: '9' }) === 500,
  );
  check('naturalGasTherms 750 -> 750', resolve({ naturalGasTherms: 750 }) === 750);
  check(
    'CCF 1000, no ThermFactor -> 1000 x UNIT_TO_BASE.CCF.factor',
    near(resolve({ naturalGasCCF: '1000' }), 1000 * ccfFactor),
    resolve({ naturalGasCCF: '1000' }),
  );
  check(
    'CCF 1000 -> 1037 (default factor)',
    near(resolve({ naturalGasCCF: 1000 }), 1037),
    resolve({ naturalGasCCF: 1000 }),
  );
  check(
    'CCF 1000 with printed ThermFactor 1.0421 -> 1042.1',
    near(resolve({ naturalGasCCF: 1000, thermFactor: '1.0421' }), 1042.1),
    resolve({ naturalGasCCF: 1000, thermFactor: '1.0421' }),
  );
  check(
    'extractor field names: NaturalGasCCF + ThermFactor',
    near(resolve({ NaturalGasCCF: '1,000', ThermFactor: '1.0421' }), 1042.1),
    resolve({ NaturalGasCCF: '1,000', ThermFactor: '1.0421' }),
  );
  check('meter multiplier 1 captured as ThermFactor is ignored', near(resolve({ naturalGasCCF: 1000, thermFactor: '1' }), 1037));
  check(
    'junk ThermFactor falls back to the constant',
    near(resolve({ naturalGasCCF: 1000, thermFactor: 'n/a' }), 1037),
  );
  check('MMBtu 100 -> 1000 therms', resolve({ naturalGasMMbtu: 100 }) === 1000, resolve({ naturalGasMMbtu: 100 }));
  check('extractor field name NaturalGasMMbtu 100 -> 1000', resolve({ NaturalGasMMbtu: '100' }) === 1000);
  check('CCF is used before MMBtu', near(resolve({ naturalGasCCF: 1000, naturalGasMMbtu: 5 }), 1037));
  check('empty bill -> 0', resolve({}) === 0);
}

// ── 2. CSV header mapping ───────────────────────────────────────────────────────────────────
let meter;
let captured;
R(
  'var __t = { m: null }; resolveUDMeter = function () { return { b: { id: "b1", meters: [] }, m: __t.m }; };' +
    'showBillCsvPreview = function (rows) { __t.rows = rows; }; _syncEmbedUDContext = function () {};',
);
function parse(csv) {
  meter = { id: 'm1', commodity: 'Gas', bills: [] };
  ctx.__meter = meter;
  R('__t.m = __meter; __t.rows = null; _csvImportMid = "m1"');
  try {
    R('parseBillCsv')(csv, 't.csv');
  } catch (e) {
    return { __err: String(e && e.message) };
  }
  captured = R('__t.rows');
  return captured && captured[0] ? captured[0] : {};
}
const D = '2026-01-01,2026-01-31,';
let r = parse('start_date,end_date,gas_ccf,therm_cost\n' + D + '1000,500');
check(
  'gas_ccf 1000 -> naturalGasCCF 1000 (source unit kept)',
  +r.naturalGasCCF === 1000 && r.naturalGasTherms == null,
  r,
);
check('gas_ccf 1000 -> therms 1037', near(+r.therms, 1037), r.therms);
check('gas_ccf 1000: therm_cost 500 stays a cost', +r.gasCharge === 500, r.gasCharge);

r = parse('start_date,end_date,ccf_used,therm_cost\n' + D + '1000,500');
check('ccf_used + therm_cost: CCF 1000 (cost not in usage)', +r.naturalGasCCF === 1000, r);
check('ccf_used + therm_cost: therms 1037, not 500', near(+r.therms, 1037), r.therms);
check('ccf_used + therm_cost: naturalGasTherms empty', r.naturalGasTherms == null, r.naturalGasTherms);
check('ccf_used + therm_cost: cost 500', +r.gasCharge === 500, r.gasCharge);

r = parse('start_date,end_date,ccf,therm_cost\n' + D + '1000,500');
check('ccf header still maps to CCF', +r.naturalGasCCF === 1000 && near(+r.therms, 1037), r);

r = parse('start,end,naturalGasCCF,gasCharge,totalCost\n' + D + '1000,500,500');
check(
  'export header naturalGasCCF 1000 -> CCF 1000, not therms',
  +r.naturalGasCCF === 1000 && r.naturalGasTherms == null,
  r,
);
check('export header naturalGasCCF 1000 -> therms 1037', near(+r.therms, 1037), r.therms);

r = parse('start,end,naturalGasMMbtu,gasCharge,totalCost\n' + D + '100,500,500');
check(
  'export header naturalGasMMbtu 100 -> MMBtu 100, not therms',
  +r.naturalGasMMbtu === 100 && r.naturalGasTherms == null,
  r,
);
check('export header naturalGasMMbtu 100 -> therms 1000', near(+r.therms, 1000), r.therms);

r = parse('start,end,naturalGasTherms,gasCharge,totalCost\n' + D + '1000,500,500');
check('export header naturalGasTherms 1000 -> therms 1000', +r.naturalGasTherms === 1000 && near(+r.therms, 1000), r);

r = parse('start_date,end_date,therms,therm_cost\n' + D + '1000,500');
check('therms header unchanged: 1000 therms, cost 500', +r.naturalGasTherms === 1000 && +r.gasCharge === 500, r);

r = parse('start_date,end_date,mmbtu,therm_cost\n' + D + '100,500');
check('mmbtu header -> naturalGasMMbtu 100, therms 1000', +r.naturalGasMMbtu === 100 && near(+r.therms, 1000), r);

// ── 3. Round trip: re-importing the exported values gives the same therms ───────────────────
const first = parse('start_date,end_date,gas_ccf,therm_cost\n' + D + '1000,500');
const exported =
  'start,end,naturalGasCCF,gasCharge,totalCost\n' +
  D +
  first.naturalGasCCF +
  ',' +
  first.gasCharge +
  ',' +
  first.totalCost;
const second = parse(exported);
check('round trip: same therms after export header re-import', near(+second.therms, +first.therms), {
  first: first.therms,
  second: second.therms,
});

// ── 4. No private conversion factor left ────────────────────────────────────────────────────
const SRC = ['app', 'computations', 'lib'];
const offenders = [];
for (const dir of SRC) {
  for (const f of fs.readdirSync(path.join(REPO, dir))) {
    if (!f.endsWith('.js') || f.endsWith('.gate.js') || f === 'site-functions.js') continue; // site-functions = release-note text
    const lines = fs.readFileSync(path.join(REPO, dir, f), 'utf8').split('\n');
    lines.forEach((ln, i) => {
      const code = ln.replace(/\/\/.*$/, '');
      if (/\b1\.037\b/.test(code) && !(f === 'utility-data.js' && /CCF:\s*\{\s*base/.test(code)))
        offenders.push(dir + '/' + f + ':' + (i + 1));
    });
  }
}
check('no 1.037 literal outside UNIT_TO_BASE', offenders.length === 0, offenders);

console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
