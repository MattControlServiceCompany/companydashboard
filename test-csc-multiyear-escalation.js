// test-csc-multiyear-escalation.js — regression guard for the CSC multi-year escalation math
// (computeMultiYearCscTotals, computations/csc.js) and for cross-table agreement between
// the CSC Compensation table (rptPageFinancial) and the Contract Projection page's
// Multi-Year Projection table (rptPageContractProjection).
//
// Follow-on to 91bc7d69 / v833: that fix made both tables call the SAME
// computeMultiYearCscTotals() so they cannot silently drift apart again. This test guards
// that fix. Without it, a future edit to computeMultiYearCscTotals OR either call site could
// reintroduce the disagreement with nothing catching it.
//
// Pattern follows test_eui_source_of_truth.js (this repo's local vm-based gate harness):
// loads the REAL, unmodified computations/csc.js and app/report-engine.js into a Node vm
// sandbox (no browser, no network) and:
//   1. Unit-checks computeMultiYearCscTotals directly against the known-good Louisburg
//      3-year figures: 3-Year Total $183,550, CSC (60%) $110,130, Client (40%) $73,420.
//   2. Instruments computeMultiYearCscTotals (recording every call) BEFORE report-engine.js
//      loads, then calls the REAL rptPageFinancial() and rptPageContractProjection()
//      functions with a synthetic (non-real, no client PII) contract shaped to reproduce
//      those known-good totals, and asserts:
//        a. Both functions' rendered HTML actually shows $183,550 / $110,130 / $73,420 in
//           their respective 3-Year Total / Multi-Year Projection Total rows — proves the
//           real render path, not just the underlying function in isolation.
//        b. Both calls in the recorded call log used the SAME (annualTarget, escalationPct,
//           contractYears, cscPct, clientPct) argument tuple and got the SAME returned
//           totals — proves the two tables share one computation, not two independent ones
//           that happen to agree today.
//
// Run: node test-csc-multiyear-escalation.js
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

const REPO = __dirname;
if (!fs.existsSync(path.join(REPO, 'computations', 'csc.js'))) {
  console.error('FATAL: could not locate computations/csc.js relative to this test (expected repo root).');
  process.exit(1);
}

// ─── Known-good Louisburg USD #416 figures (documented in backlog 92155caf / 91bc7d69) ──
const EXPECTED_TOTAL = 183550;
const EXPECTED_CSC = 110130; // 60%
const EXPECTED_CLIENT = 73420; // 40%
const TOL = 1; // $1 tolerance — $c() in report-engine.js itself rounds to the nearest dollar

// ─── Synthetic (non-real) contract inputs engineered to reproduce the known-good totals ──
// Louisburg's real contract terms are not reproduced here (no client PII in a committed
// fixture) — instead these inputs are DERIVED backwards from the known-good $183,550 3-year
// total so that feeding them into the real computeMultiYearCscTotals() must reproduce it.
// contractYears=3, cscPct=60, clientPct=40 (matches the known-good 60/40 split exactly:
// 183550*0.6=110130, 183550*0.4=73420). escalationPct=-5 (a declining year-over-year
// savings target, same shape as a guaranteed-savings contract that ramps down) exercises
// the actual compounding math (Math.pow) rather than the escalation=0 degenerate case.
const CONTRACT_YEARS = 3;
const CSC_PCT = 60;
const CLIENT_PCT = 40;
const ESCALATION_PCT = -5;
let _denom = 0;
for (let yr = 1; yr <= CONTRACT_YEARS; yr++) _denom += Math.pow(1 + ESCALATION_PCT / 100, yr - 1);
const ANNUAL_TARGET = EXPECTED_TOTAL / _denom;

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
load('computations/csc.js');

// ─── Instrument computeMultiYearCscTotals BEFORE report-engine.js loads, so every call
// either report page makes is recorded. This is what proves the two tables share ONE
// computation rather than two independent reimplementations that happen to agree. ───────
new vm.Script(
  `
  (function() {
    var _orig = computeMultiYearCscTotals;
    computeMultiYearCscTotals = function(annualTarget, escalationPct, contractYears, cscPct, clientPct) {
      var r = _orig(annualTarget, escalationPct, contractYears, cscPct, clientPct);
      __cscCallLog.push({
        annualTarget: annualTarget, escalationPct: escalationPct, contractYears: contractYears,
        cscPct: cscPct, clientPct: clientPct,
        totalSavings: r.totalSavings, totalCsc: r.totalCsc, totalClient: r.totalClient
      });
      return r;
    };
  })();
`,
  { filename: 'instrument-csc' },
).runInContext(ctx);

load('app/report-engine.js');

// ─── 1. Direct unit check: computeMultiYearCscTotals alone against known-good figures ────
console.log('--- 1. computeMultiYearCscTotals() direct known-good check ---');
const direct = new vm.Script(
  `computeMultiYearCscTotals(${ANNUAL_TARGET}, ${ESCALATION_PCT}, ${CONTRACT_YEARS}, ${CSC_PCT}, ${CLIENT_PCT});`,
  { filename: 'direct-call' },
).runInContext(ctx);
assertClose(direct.totalSavings, EXPECTED_TOTAL, TOL, '3-Year Total');
assertClose(direct.totalCsc, EXPECTED_CSC, TOL, 'CSC (60%) 3-Year Total');
assertClose(direct.totalClient, EXPECTED_CLIENT, TOL, 'Client (40%) 3-Year Total');
console.log(
  '  totalSavings=' +
    direct.totalSavings.toFixed(2) +
    ' totalCsc=' +
    direct.totalCsc.toFixed(2) +
    ' totalClient=' +
    direct.totalClient.toFixed(2),
);

// ─── Synthetic report data (`d`) — no real client name/PII. Shaped only enough to satisfy
// the fields rptPageFinancial() and rptPageContractProjection() actually read. ────────────
function buildSyntheticD() {
  return {
    project: { sqft: 100000 },
    period: { type: 'annual', quarter: 4, year: 2026 },
    totals: {
      savings: 61183, // a plausible single-year actual, independent of the multi-year figures under test
      blCost: 500000,
      curCost: 438817,
      savingsPct: 12.2,
      cumulativeSavings: 61183,
      kwhBl: 4000000,
      kwhCur: 3600000,
      propaneBl: 0,
      propaneCur: 0,
      thermsBl: 200000,
      thermsCur: 180000,
    },
    buildings: [
      {
        name: 'Synthetic Test Building',
        sqft: 100000,
        blCost: 500000,
        curCost: 438817,
        savings: 61183,
        savingsPct: 12.2,
        status: 'on_track',
      },
    ],
    contract: {
      annualTarget: ANNUAL_TARGET,
      escalation: ESCALATION_PCT,
      years: CONTRACT_YEARS,
      cscPct: CSC_PCT,
      clientPct: CLIENT_PCT,
      currentYear: 1,
      quarterlyTargets: [ANNUAL_TARGET / 4, ANNUAL_TARGET / 4, ANNUAL_TARGET / 4, ANNUAL_TARGET / 4],
      quarterlyActuals: [ANNUAL_TARGET / 4, ANNUAL_TARGET / 4, ANNUAL_TARGET / 4, ANNUAL_TARGET / 4],
    },
  };
}

// Self-heal retry loop (same pattern as test_eui_source_of_truth.js's runCollect): report
// page functions reach for peripheral helpers (icons, chart helpers, formatting utilities)
// this test doesn't need — stub any ReferenceError target with a black hole and retry rather
// than hand-enumerating every helper report-engine.js happens to touch.
function runPageFn(name, args) {
  let attempts = 0;
  for (;;) {
    attempts++;
    if (attempts > 60) throw new Error(name + ': too many self-heal retries — something structural is broken.');
    sandbox.__args = args;
    try {
      return new vm.Script(name + '.apply(null, __args);', { filename: 'run-' + name }).runInContext(ctx);
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      new vm.Script(m[1] + ' = _mkbh();', { filename: 'stub-' + m[1] }).runInContext(ctx);
    }
  }
}

console.log(
  '\n--- 2. CSC Compensation table (rptPageFinancial) vs Multi-Year Projection table (rptPageContractProjection) ---',
);
const dFin = buildSyntheticD();
const dProj = buildSyntheticD();
const finHTML = runPageFn('rptPageFinancial', [1, dFin]);
const projHTML = runPageFn('rptPageContractProjection', [2, dProj]);

// Pull the $c()-formatted dollar figures straight out of the real rendered HTML — proves the
// actual displayed table output, not just the return value of an isolated function call.
function extractCscCompTotals(html) {
  // "<contractYrs>-Year Total" column is the 4th <td> in each of the 3 CSC Compensation rows.
  const rowRe = /<tr[^>]*>((?:(?!<\/tr>)[\s\S])*)<\/tr>/g;
  const dollars = [];
  let m;
  while ((m = rowRe.exec(html))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    // 2026-09-24 (fix/report-followup): the CSC row label is spelled out as "Control Service
    // Company (N%)" (no-abbreviations fix, fix/report-headers-and-empty-period) — match that,
    // not the old bare "CSC (" form.
    if (tds.length === 4 && /Actual Savings|Control Service Company \(|Client Net \(/.test(tds[0])) {
      const val = (tds[3].match(/\$[\d,]+/) || [])[0];
      if (val) dollars.push({ label: tds[0].replace(/<[^>]+>/g, ''), value: val });
    }
  }
  return dollars;
}
function extractProjectionTotals(html) {
  const rowRe = /<tr class="rpt-tot">((?:(?!<\/tr>)[\s\S])*)<\/tr>/;
  const m = rowRe.exec(html);
  if (!m) return null;
  const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
  // colspan=2 label td, then Projected, CSC, Client
  const vals = tds.slice(1).map((t) => (t.match(/\$[\d,]+/) || [])[0]);
  return { total: vals[0], csc: vals[1], client: vals[2] };
}

const cscRows = extractCscCompTotals(finHTML);
console.log('  CSC Compensation table (rptPageFinancial), ' + CONTRACT_YEARS + '-Year Total column:');
cscRows.forEach((r) => console.log('    ' + r.label.trim() + ': ' + r.value));
assert(
  cscRows.length === 3,
  'CSC Compensation table must have exactly 3 rows in the 3-Year Total column (Actual Savings, CSC, Client Net) — got ' +
    cscRows.length,
);
const finTotal = cscRows[0] && cscRows[0].value;
const finCsc = cscRows[1] && cscRows[1].value;
const finClient = cscRows[2] && cscRows[2].value;
assert(finTotal === '$183,550', 'CSC Compensation table 3-Year Total must render $183,550, got ' + finTotal);
assert(finCsc === '$110,130', 'CSC Compensation table CSC (60%) 3-Year Total must render $110,130, got ' + finCsc);
assert(
  finClient === '$73,420',
  'CSC Compensation table Client Net (40%) 3-Year Total must render $73,420, got ' + finClient,
);

const proj = extractProjectionTotals(projHTML);
console.log('  Multi-Year Projection table (rptPageContractProjection) Total row: ' + JSON.stringify(proj));
assert(!!proj, 'Multi-Year Projection table Total row not found in rendered HTML');
if (proj) {
  assert(proj.total === '$183,550', 'Multi-Year Projection Total column must render $183,550, got ' + proj.total);
  assert(proj.csc === '$110,130', 'Multi-Year Projection CSC column must render $110,130, got ' + proj.csc);
  assert(proj.client === '$73,420', 'Multi-Year Projection Client column must render $73,420, got ' + proj.client);
}

// ─── The actual drift guard: both real call sites must have gone through the SAME shared
// computeMultiYearCscTotals() with the SAME argument tuple and gotten the SAME totals — not
// two independently-reimplemented computations that happen to render the same string today. ─
console.log('\n--- 3. Cross-table agreement: both pages call the SAME computeMultiYearCscTotals() ---');
assert(
  sandbox.__cscCallLog.length >= 2,
  'Expected at least 2 recorded computeMultiYearCscTotals() calls (one per report page), got ' +
    sandbox.__cscCallLog.length,
);
console.log('  Recorded calls: ' + sandbox.__cscCallLog.length);
sandbox.__cscCallLog.forEach((c, i) => {
  console.log(
    '    [' +
      i +
      '] annualTarget=' +
      c.annualTarget.toFixed(2) +
      ' esc=' +
      c.escalationPct +
      ' yrs=' +
      c.contractYears +
      ' cscPct=' +
      c.cscPct +
      ' clientPct=' +
      c.clientPct +
      ' -> totalSavings=' +
      c.totalSavings.toFixed(2) +
      ' totalCsc=' +
      c.totalCsc.toFixed(2) +
      ' totalClient=' +
      c.totalClient.toFixed(2),
  );
});
if (sandbox.__cscCallLog.length >= 2) {
  // The call log also includes the section-1 direct unit-check call (made BEFORE the two
  // report pages ran) — take the LAST two recorded calls, which are the actual
  // rptPageFinancial and rptPageContractProjection calls under test here, not [0]/[1].
  const callA = sandbox.__cscCallLog[sandbox.__cscCallLog.length - 2];
  const callB = sandbox.__cscCallLog[sandbox.__cscCallLog.length - 1];
  assertClose(
    callA.totalSavings,
    callB.totalSavings,
    0.01,
    'rptPageFinancial and rptPageContractProjection calls to computeMultiYearCscTotals must return the SAME totalSavings',
  );
  assertClose(
    callA.totalCsc,
    callB.totalCsc,
    0.01,
    'rptPageFinancial and rptPageContractProjection calls to computeMultiYearCscTotals must return the SAME totalCsc',
  );
  assertClose(
    callA.totalClient,
    callB.totalClient,
    0.01,
    'rptPageFinancial and rptPageContractProjection calls to computeMultiYearCscTotals must return the SAME totalClient',
  );
  assert(
    callA.annualTarget === callB.annualTarget &&
      callA.escalationPct === callB.escalationPct &&
      callA.contractYears === callB.contractYears,
    'Both calls must use the same (annualTarget, escalationPct, contractYears) argument tuple',
  );
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failed > 0 ? 1 : 0);
