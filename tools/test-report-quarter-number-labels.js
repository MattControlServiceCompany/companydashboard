// test-report-quarter-number-labels.js - quarterly report quarter labels use the number (Matt, 2026-11-02).
// Loads the real lib/formatting.js, app/report-engine.js and app/report-printed.js in a Node vm
// (no browser, no network). Checks that:
//   1. _rptQuarterLabel(q, 2026) returns "Q1 2026" .. "Q4 2026".
//   2. report-engine.js has no First/Second/Third/Fourth name arrays and no f.ordinal.
//   3. The cover, results and contract pages for a synthetic Q3 2026 report show "Q3 2026"
//      and contain no spelled-out quarter word.
// Run: node tools/test-report-quarter-number-labels.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log('  FAIL: ' + msg);
  }
}
function assertClose(actual, expected, tolDollars, msg) {
  assert(Math.abs(actual - expected) <= tolDollars, msg + ' (expected ' + expected + ', got ' + actual + ')');
}

const REPO = path.join(__dirname, '..');
if (!fs.existsSync(path.join(REPO, 'computations', 'csc.js'))) {
  console.error('FATAL: could not locate computations/csc.js relative to this test (expected repo root).');
  process.exit(1);
}

// ─── vm sandbox (black-hole proxy stands in for DOM/window — same pattern as
// test_eui_source_of_truth.js / tools/ Node harnesses in this repo) ──────────────────────
function makeBlackHole() {
  const target = function () {
    return makeBlackHole();
  };
  const handler = {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'toString') return () => '';
      if (!(p in t)) t[p] = makeBlackHole();
      return t[p];
    },
    apply() {
      return makeBlackHole();
    },
    construct() {
      return makeBlackHole();
    },
  };
  return new Proxy(target, handler);
}

const sandbox = {};
sandbox.console = console;
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.document = makeBlackHole();
sandbox.navigator = {};
sandbox.location = { href: 'file:///gate', search: '', pathname: '/gate' };
sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
sandbox.fetch = () => Promise.reject(new Error('fetch disabled in test'));
sandbox.CustomEvent = class {
  constructor(t, o) {
    this.type = t;
    this.detail = o && o.detail;
  }
};
sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
sandbox.setTimeout = setTimeout;
sandbox.setInterval = () => 0;
sandbox.clearInterval = () => {};
sandbox.indexedDB = undefined;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => {};
sandbox.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
sandbox.MutationObserver = class {
  observe() {}
  disconnect() {}
};
sandbox.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
sandbox.performance = { now: () => Date.now() };
sandbox.crypto = require('crypto').webcrypto;
sandbox.showToast = () => {};
sandbox.DB = { get: (k, d) => d, set: () => Promise.resolve(), isReady: () => false };
sandbox.__cscCallLog = [];
sandbox._mkbh = makeBlackHole;

const ctx = vm.createContext(sandbox);
function load(rel) {
  const code = fs.readFileSync(path.join(REPO, rel), 'utf8');
  new vm.Script(code, { filename: rel }).runInContext(ctx);
}
load('lib/formatting.js');

load('app/report-engine.js');
load('app/report-printed.js');

console.log('--- Quarter labels use the number, never the word (Matt, 2026-11-02) ---');
function run(code) {
  return new vm.Script(code, { filename: 'q' }).runInContext(ctx);
}
assert(
  typeof run('typeof _rptQuarterLabel') === 'string' && run('typeof _rptQuarterLabel') === 'function',
  '_rptQuarterLabel exists',
);
if (run('typeof _rptQuarterLabel') === 'function') {
  [1, 2, 3, 4].forEach((q) =>
    assert(run('_rptQuarterLabel(' + q + ',2026)') === 'Q' + q + ' 2026', 'formatter Q' + q + ' 2026'),
  );
}
const src = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
assert(!/\['First', 'Second', 'Third', 'Fourth'\]/.test(src), 'no First/Second/Third/Fourth array in report-engine.js');
assert(!/\['First quarter'/.test(src), 'no First quarter names array in report-engine.js');
assert(!/f\.ordinal/.test(src), 'no f.ordinal in report-engine.js');

const d = {
  project: { sqft: 100000, name: 'Synthetic' },
  period: { type: 'quarterly', quarter: 3, year: 2026, yearMonths: [] },
  totals: { savings: 1000, blCost: 50000, curCost: 49000, savingsPct: 2, cumulativeSavings: 1000 },
  buildings: [],
  contract: {
    annualTarget: 40000,
    escalation: 0,
    years: 3,
    cscPct: 60,
    hasCsc: true,
    clientPct: 40,
    currentYear: 1,
    quarterlyTargets: [10000, 10000, 10000, 10000],
    quarterlyActuals: [1, 2, 3],
  },
};
sandbox.__d = d;
const stubbed = [];
['_rptQCoverPage', '_rptQResultsPage', '_rptQContractPage'].forEach((fn) => {
  let html = '';
  try {
    sandbox.__args = [1, d, run('_rptQFacts(__d)')];
    html = (function () {
      for (let k = 0; k < 80; k++) {
        try {
          return run(fn + '.apply(null, __args)');
        } catch (e) {
          const m = /^(\w+) is not defined$/.exec(e.message || '');
          if (!m) throw e;
          stubbed.push(m[1]);
          run(m[1] + ' = _mkbh();');
        }
      }
      return '';
    })();
  } catch (e) {
    assert(false, fn + ' render threw: ' + e.message);
  }
  const text = String(html);
  assert(/Q3 2026/.test(text), fn + ' shows "Q3 2026"');
  assert(!/\b(First|Second|Third|Fourth)\b/i.test(text), fn + ' has no spelled-out quarter word');
});

assert(
  !stubbed.some((n) => /^(names|_rptQuarterLabel|qLabel|ordinal)$/.test(n)),
  'no quarter-label helper left undefined (stubbed: ' + stubbed.join(',') + ')',
);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
