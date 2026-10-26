// Node-only check of the presented-client savings entries in the regression oracle (no browser).
// Runs the gate's own probeInPage (single source) over the app files in a vm, from a backup file, and compares the
// savings / presented entries with the gate's own compareNumbers.
// USAGE: node scripts/test-savings-oracle.js --data <backup.json> [--oracle <oracle.json>]
// EXIT: 0 = every checked entry passes and the input has the keys the oracle needs; 1 = otherwise.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const gate = require('./regression-gate.js');

const REPO = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k) => (argv.indexOf('--' + k) >= 0 ? argv[argv.indexOf('--' + k) + 1] : null);
const dataPath = arg('data');
const ctxDir = process.env.CH_CONTEXT_DIR || path.join(os.homedir(), 'AI', '_context');
const oraclePath = arg('oracle') || path.join(ctxDir, 'reference', 'known-good-values', 'regression-oracle.json');
if (!dataPath) {
  console.error('usage: --data <backup.json> [--oracle <oracle.json>]');
  process.exit(1);
}
const backup = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));

const bh = () =>
  new Proxy(function () {}, {
    get(t, p) {
      if (!(p in t)) t[p] = bh();
      return t[p];
    },
    apply: () => bh(),
    construct: () => bh(),
  });
const sandbox = {};
Object.assign(sandbox, {
  console, global: sandbox, globalThis: sandbox, window: sandbox, document: bh(), navigator: {},
  fetch: () => Promise.reject(new Error('fetch disabled')), setTimeout, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: (f) => setTimeout(f, 0), addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  location: { href: 'file:///t', search: '', pathname: '/t' }, matchMedia: () => ({ matches: false }),
  MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
  CustomEvent: class {}, performance: { now: () => Date.now() }, crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder, showToast() {}, indexedDB: undefined,
});
const val = (k, d) => {
  const v = backup[k];
  if (v === undefined || v === null) return d;
  return typeof v === 'string' ? JSON.parse(v) : v;
};
sandbox.DB = { get: val, set: () => Promise.resolve(), isReady: () => true };
const store = new Map(Object.entries(backup).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
sandbox.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), key: (i) => Array.from(store.keys())[i] || null, get length() { return store.size; },
};
const ctx = vm.createContext(sandbox);
const load = (rel) => new vm.Script(fs.readFileSync(path.join(REPO, rel), 'utf8'), { filename: rel }).runInContext(ctx);
// load order copied from energy-department.html (same as the other node harnesses)
['lib/date-helpers.js','lib/formatting.js','lib/unit-conversion.js','computations/physics.js','computations/fan-savings.js',
 'computations/cost-lines.js','computations/rates.js','computations/regression.js','computations/normalization.js',
 'computations/eui.js','computations/hvac-enduse.js','computations/end-use.js','computations/pollution.js',
 'computations/csc.js','computations/savings.js','computations/bill-flags.js','app/utility-data.js','app/core.js'].forEach(load);
new vm.Script(
  "projects=sget('en_projects',[])||[]; sget('en_customers',[]).forEach(function(c){var d=sget('en_utility_'+c.id,null); if(d) utilityData[c.id]=d;});",
).runInContext(ctx);
const probe = JSON.parse(
  new vm.Script('JSON.stringify((' + gate.probeInPage.toString() + ')())', { filename: 'probe' }).runInContext(ctx),
);

let fail = 0;
const missing = gate.missingInputKeys(oracle, backup);
if (missing.length) {
  fail++;
  console.log('FAIL input: ' + gate.inputKeyMessage(oracle, missing));
} else console.log('PASS input: backup has ' + ((oracle._input && oracle._input.requiresKeys) || []).join(', '));

const subset = { values: oracle.values.filter((e) => /^[^.]+\.(savings|presented)/.test(e.key)) };
gate.compareNumbers(probe, subset);
gate.results.forEach((r) => {
  if (r.status === 'FAIL') fail++;
  console.log(r.status + ' ' + r.name + ' ' + r.detail);
});
const n = (re) => gate.results.filter((r) => re.test(r.name));
const cnt = (re) => { const a = n(re); return a.filter((r) => r.status === 'PASS').length + '/' + a.length; };
console.log('SUMMARY recalculated ' + cnt(/savings-recalculated/) + '  presented-figures ' + cnt(/\.savings\.|\.presented\./) + '  data=' + path.basename(dataPath));
process.exit(fail ? 1 : 0);
