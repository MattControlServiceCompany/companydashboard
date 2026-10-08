// test-account-plausibility.mjs — _isPlausibleAccountNumber guard (63a151a2)
// must accept multi-dash Client A-style accounts (synthetic values only) and
// keep rejecting garbled OCR / date-shaped text.
// Loads the REAL app/bill-analysis.js via the same vm technique as
// test-kwh-corroboration.mjs (no reimplementation of app logic).
//
// Run: node test-account-plausibility.mjs

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;

let pass = 0;
let fail = 0;

const LOAD_ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/eui.js',
  'computations/pollution.js',
  'computations/csc.js',
  'computations/savings.js',
  'computations/anomaly-detection.js',
  'lib/perf-table.js',
  'lib/shared-charts.js',
  'computations/report-data.js',
  'computations/data-quality.js',
  'app/db.js',
  'app/core.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
];

function loadRealPipeline() {
  const sandboxWindow = { addEventListener: () => {}, removeEventListener: () => {}, location: { href: '', search: '' } };
  const sandboxDocument = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, getContext: () => null }),
  };
  const sandbox = {
    console,
    window: sandboxWindow,
    document: sandboxDocument,
    navigator: { userAgent: 'node-eca-split-test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Chart: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    Image: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const skipped = [];
  for (const rel of LOAD_ORDER) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) { skipped.push(rel + ' (not found)'); continue; }
    try {
      vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      skipped.push(rel + ' (load error: ' + e.message + ')');
    }
  }
  vm.runInContext('this.__p = typeof _isPlausibleAccountNumber !== "undefined" ? _isPlausibleAccountNumber : null;', ctx);
  return { plausible: ctx.__p, skipped };
}

const { plausible, skipped } = loadRealPipeline();
if (!plausible) {
  console.log('FAIL: _isPlausibleAccountNumber not loaded', skipped);
  process.exit(1);
}
const accept = ['560001', '8000000001', '60-700001', '500000001 2000001 18', 'RG233590', 'BG-90001',
  '07-123456-01', '02-000001-00', '11-222333-44', '1-2-3-4'];
const reject = ['S601 RTS ToC', 'RAS 122474', 'a PN 1 edo', '', null, 'ToC', '09-15-2026', '9-5-26', '2026-09-15', '2026-9-5', '000-555-0100', '07-123456-AB', '07--123456', '-07-123456', '07-123456-'];
for (const a of accept) { if (plausible(a)) pass++; else { fail++; console.log('  should ACCEPT: ' + JSON.stringify(a)); } }
for (const r of reject) { if (!plausible(r)) pass++; else { fail++; console.log('  should REJECT: ' + JSON.stringify(r)); } }
console.log(pass + '/' + (pass + fail) + ' assertions passed');
process.exit(fail ? 1 : 0);
