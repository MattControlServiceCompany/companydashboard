// tools/test-incomplete-rate-flag.js — a67db8ce regression gate.
// Run: node tools/test-incomplete-rate-flag.js [path-to-alternate-savings.js]
//
// Proves getMeterSavings() (computations/savings.js) flags a month as rate-incomplete
// instead of silently returning a bare $0.00 when a rate cannot be resolved, using a
// SYNTHETIC fixture only (never real client data in the repo).
//
// Cases:
//   1. Gas month, billed charge present, therms + totalGasRate both blank (mirrors the
//      backlog item's "Middle School gas Jul 2026" evidence) -> flagged, byYM stays 0.
//   2. Electric month, real kWh usage, kWh rate unresolvable -> flagged, byYM stays 0.
//   3. Gas month with a COMPLETE rate -> never flagged, and its $ value is untouched
//      (proves the fix never changes a number that has complete rate data).
//   4. Water meter reusing the same code branch as gas, with blank gas-only fields (its
//      normal, by-design state) -> must NOT be flagged (regression guard for the
//      Water/Sewer/Stormwater/Steam false-positive found and fixed during this item).
//   5. A month with an explicit costSavOverride and no resolvable rate -> not flagged
//      (a human already resolved it).
//   6. Same gas case (1) run through the multi-baseline path (_getMeterSavingsMulti).
//
// Pass "node tools/test-incomplete-rate-flag.js /path/to/old-savings.js" to run the SAME
// assertions against a different computations/savings.js (e.g. `git show origin/main:...`
// dumped to a temp file) — this is how the fix was proven to fail on the pre-fix source.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

const savingsPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, 'computations/savings.js');
console.log('Testing savings.js at:', savingsPath);

// Extract one top-level function verbatim from a source file (same technique as
// tools/test-single-source-baseline.js loadFn — real app code, not reimplemented).
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('function ' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + fnName + ' in ' + file);
  let p = src.indexOf('(', m.index);
  let pDepth = 0,
    pEnd = p;
  for (; pEnd < src.length; pEnd++) {
    if (src[pEnd] === '(') pDepth++;
    else if (src[pEnd] === ')') {
      pDepth--;
      if (pDepth === 0) break;
    }
  }
  let i = src.indexOf('{', pEnd);
  let depth = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, j + 1);
}

const sandbox = { console };
vm.createContext(sandbox);

// projHasContract needs a `projects` array with a truthy `sa` on the test project.
const stubs = [
  'var projects = [{ id: 1, sa: "SA-TEST-001" }];',
  'function getWeatherForBuilding(){ return { byYm: {}, cache: [] }; }',
  'function getUDProj(){ return { id: 1, sa: "SA-TEST-001", inclMonths: {} }; }',
  'function getUDBldg(){ return { meters: [] }; }',
  'var udSelProjId = 1;',
].join('\n');

const dateFns = [
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
].join('\n\n');

const normalizationSrc = fs.readFileSync(REPO + '/computations/normalization.js', 'utf8');
const regressionSrc = fs.readFileSync(REPO + '/computations/regression.js', 'utf8');
const ratesSrc = fs.readFileSync(REPO + '/computations/rates.js', 'utf8');
const dateHelpersSrc = fs.readFileSync(REPO + '/lib/date-helpers.js', 'utf8');
const savingsSrc = fs.readFileSync(savingsPath, 'utf8');

vm.runInContext(
  [stubs, dateFns, dateHelpersSrc, regressionSrc, ratesSrc, normalizationSrc, savingsSrc].join('\n\n'),
  sandbox,
);

const getMeterSavings = sandbox.getMeterSavings;
if (typeof getMeterSavings !== 'function') {
  console.log('FATAL: getMeterSavings did not load from', savingsPath);
  process.exit(1);
}

// ─── Case 1: Gas month, real billed charge, therms + totalGasRate both blank ───────────
(function () {
  const m = {
    id: 'm-gas-1',
    commodity: 'Gas',
    baseline: { months: ['2025-01', '2025-02', '2025-03'] },
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', therms: 500, totalGasRate: 0.9, gasCharge: 450 },
    { start: '2025-02-01', end: '2025-02-28', therms: 480, totalGasRate: 0.9, gasCharge: 432 },
    { start: '2025-03-01', end: '2025-03-31', therms: 510, totalGasRate: 0.9, gasCharge: 459 },
    // post-baseline month with a real charge but therms AND totalGasRate blank —
    // the exact shape of the "Middle School gas Jul 2026" evidence in a67db8ce.
    { start: '2025-07-01', end: '2025-07-31', therms: '', totalGasRate: '', gasCharge: 1097 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(r.byYM['2025-07'] === 0, 'Case 1: byYM stays $0.00 (number itself never changes)');
  assert(!!r.incompleteYM['2025-07'], 'Case 1: 2025-07 is flagged in incompleteYM');
  assert(
    r.incompleteYM['2025-07'] && /gas/i.test(r.incompleteYM['2025-07'].reason),
    'Case 1: reason names the gas rate',
  );
})();

// ─── Case 2: Electric month, real kWh usage, kWh rate unresolvable ─────────────────────
(function () {
  const m = {
    id: 'm-elec-1',
    commodity: 'Electric',
    baseline: { months: ['2025-01', '2025-02', '2025-03'] },
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', kwh: 10000, totalKwhRate: 0.11, kwhCost: 1100, demandKW: 30 },
    { start: '2025-02-01', end: '2025-02-28', kwh: 9500, totalKwhRate: 0.11, kwhCost: 1045, demandKW: 29 },
    { start: '2025-03-01', end: '2025-03-31', kwh: 10200, totalKwhRate: 0.11, kwhCost: 1122, demandKW: 31 },
    // post-baseline: real usage, but no stored rate AND no kwhCost fallback — mirrors the
    // "Circle Grove electric May 2026" evidence (real usage/reduction, $0 shown).
    { start: '2025-05-01', end: '2025-05-31', kwh: 8000, totalKwhRate: '', kwhCost: '', demandKW: 27 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(r.byYM['2025-05'] === 0, 'Case 2: byYM stays $0.00');
  assert(!!r.incompleteYM['2025-05'], 'Case 2: 2025-05 is flagged in incompleteYM');
  assert(
    r.incompleteYM['2025-05'] && /kWh/i.test(r.incompleteYM['2025-05'].reason),
    'Case 2: reason names the kWh rate',
  );
})();

// ─── Case 3: Gas month with a COMPLETE rate — number must be untouched, never flagged ──
(function () {
  const m = {
    id: 'm-gas-2',
    commodity: 'Gas',
    baseline: { months: ['2025-01', '2025-02', '2025-03'] },
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', therms: 500, totalGasRate: 0.9, gasCharge: 450 },
    { start: '2025-02-01', end: '2025-02-28', therms: 480, totalGasRate: 0.9, gasCharge: 432 },
    { start: '2025-03-01', end: '2025-03-31', therms: 510, totalGasRate: 0.9, gasCharge: 459 },
    { start: '2025-07-01', end: '2025-07-31', therms: 400, totalGasRate: 0.9, gasCharge: 360 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(!r.incompleteYM['2025-07'], 'Case 3: a complete-rate month is never flagged');
  assert(typeof r.byYM['2025-07'] === 'number' && r.byYM['2025-07'] !== 0, 'Case 3: complete-rate $ value present');
})();

// ─── Case 4: Water meter — same code branch as gas, blank gas-only fields BY DESIGN ────
(function () {
  const m = {
    id: 'm-water-1',
    commodity: 'Water',
    baseline: { months: ['2025-01', '2025-02', '2025-03'] },
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', waterUsage: 1000, cost: 50 },
    { start: '2025-02-01', end: '2025-02-28', waterUsage: 950, cost: 48 },
    { start: '2025-03-01', end: '2025-03-31', waterUsage: 1020, cost: 51 },
    { start: '2025-07-01', end: '2025-07-31', waterUsage: 900, cost: 45 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(
    !r.incompleteYM['2025-07'],
    'Case 4: Water meter (no gas rate concept) is never flagged — false-positive regression guard',
  );
})();

// ─── Case 5: costSavOverride present — a human already resolved this month ─────────────
(function () {
  const m = {
    id: 'm-gas-3',
    commodity: 'Gas',
    baseline: { months: ['2025-01', '2025-02', '2025-03'], costSavOverrides: { '2025-07': 275 } },
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', therms: 500, totalGasRate: 0.9, gasCharge: 450 },
    { start: '2025-02-01', end: '2025-02-28', therms: 480, totalGasRate: 0.9, gasCharge: 432 },
    { start: '2025-03-01', end: '2025-03-31', therms: 510, totalGasRate: 0.9, gasCharge: 459 },
    { start: '2025-07-01', end: '2025-07-31', therms: '', totalGasRate: '', gasCharge: 1097 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(!r.incompleteYM['2025-07'], 'Case 5: an overridden month is never flagged');
  assert(r.byYM['2025-07'] === 275, 'Case 5: overridden $ value is used, untouched');
})();

// ─── Case 6: same as Case 1, but through the multi-baseline path ───────────────────────
(function () {
  const m = {
    id: 'm-gas-multi-1',
    commodity: 'Gas',
    baselines: [
      {
        months: ['2025-01', '2025-02', '2025-03'],
        savingsWindow: { start: '2025-04' },
      },
    ],
    inclusive: true,
  };
  const bills = [
    { start: '2025-01-01', end: '2025-01-31', therms: 500, totalGasRate: 0.9, gasCharge: 450 },
    { start: '2025-02-01', end: '2025-02-28', therms: 480, totalGasRate: 0.9, gasCharge: 432 },
    { start: '2025-03-01', end: '2025-03-31', therms: 510, totalGasRate: 0.9, gasCharge: 459 },
    { start: '2025-07-01', end: '2025-07-31', therms: '', totalGasRate: '', gasCharge: 1097 },
  ];
  const r = getMeterSavings(m, bills, true, 1, 'b1');
  assert(r.byYM['2025-07'] === 0, 'Case 6 (multi-baseline): byYM stays $0.00');
  assert(!!r.incompleteYM['2025-07'], 'Case 6 (multi-baseline): 2025-07 is flagged in incompleteYM');
})();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
