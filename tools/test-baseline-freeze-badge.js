// tools/test-baseline-freeze-badge.js — Project Baseline "All Buildings" freeze badge gate.
// Run: node tools/test-baseline-freeze-badge.js
//
// Backlog P0 35105124: Louisburg's High School and Middle School showed "Auto-inherited —
// not frozen" on the Project Baseline "All Buildings" table even after their real,
// savings-included Electric/Gas meters were explicitly saved and frozen. Root cause:
// _udBuildingFreezeState() (app/utility-data.js) required EVERY meter with a baseline —
// including meters excluded from savings (Water/Sewer/Stormwater submeters, stray
// zero-usage duplicate meters) that were only ever auto-inherited and never explicitly
// saved — to be frozen before the building could show "Frozen". One excluded, never-saved
// meter permanently blocked the badge for the whole building.
//
// Fix: only meters actually counted in savings (d.included) gate the badge, matching the
// building-header "X of Y meters frozen" badge's existing, already-correct rule.
//
// SYNTHETIC fixture only — no real client data.
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

// Load the real function verbatim (no reimplementation) into an isolated vm sandbox —
// same technique as tools/test-project-baseline-all-buildings.js's loadFn+vm pattern.
// This only ever executes our own extracted, known-good repo source, never external
// or user-supplied input, so a sandboxed vm context (not a bare eval) is appropriate here.
const fnSrc = loadFn(path.join(REPO, 'app/utility-data.js'), '_udBuildingFreezeState');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext('var _udBuildingFreezeStateFn = ' + fnSrc + ';', sandbox);
const _udBuildingFreezeState = sandbox._udBuildingFreezeStateFn;

console.log('=== Project Baseline: All Buildings freeze badge gate (35105124) ===');

// ── Scenario 1: Louisburg High School shape ─────────────────────────────────────────
// Electric + Gas meters: real bills, explicitly saved, frozen (isBaselineFrozen true).
// A second, stray, zero-usage Electric meter: excluded from savings, auto-inherited
// (never explicitly saved) — trust = 'inherited', not frozen.
const hsMeterDetails = [
  { hasBaseline: true, included: true, trust: 'frozen' }, // Electric (real, saved)
  { hasBaseline: true, included: true, trust: 'frozen' }, // Gas (real, saved)
  { hasBaseline: true, included: false, trust: 'inherited' }, // stray excluded $0 Electric meter
];
const hsResult = _udBuildingFreezeState(hsMeterDetails);
assert(
  hsResult === 'Frozen',
  'High School shape: all SAVINGS-INCLUDED meters are frozen -> badge reads "Frozen" (got "' + hsResult + '")',
);

// ── Scenario 2: Louisburg Middle School shape ───────────────────────────────────────
// Electric + Gas: real, saved, frozen. Water/Sewer/Stormwater: excluded, auto-inherited.
const msMeterDetails = [
  { hasBaseline: true, included: true, trust: 'frozen' }, // Electric
  { hasBaseline: true, included: true, trust: 'frozen' }, // Gas
  { hasBaseline: true, included: false, trust: 'inherited' }, // Water (excluded)
  { hasBaseline: true, included: false, trust: 'inherited' }, // Sewer (excluded)
  { hasBaseline: true, included: false, trust: 'inherited' }, // Stormwater (excluded)
];
const msResult = _udBuildingFreezeState(msMeterDetails);
assert(msResult === 'Frozen', 'Middle School shape: badge reads "Frozen" (got "' + msResult + '")');

// ── Scenario 3: a genuinely NOT-frozen included meter must still show "not frozen" ──
// (this fix must never mask a real problem — an included meter that truly hasn't been
// saved/frozen yet must still block the badge)
const genuineNotFrozen = [
  { hasBaseline: true, included: true, trust: 'inherited' }, // included, never saved
  { hasBaseline: true, included: false, trust: 'frozen' }, // excluded, happens to be frozen
];
const gnfResult = _udBuildingFreezeState(genuineNotFrozen);
assert(
  gnfResult === 'Auto-inherited — not frozen',
  'a genuinely un-frozen INCLUDED meter still blocks the badge (got "' + gnfResult + '")',
);

// ── Scenario 4: no included meters at all (e.g. Maintenance Building — fully excluded) ──
const noIncluded = [{ hasBaseline: true, included: false, trust: 'inherited' }];
const niResult = _udBuildingFreezeState(noIncluded);
assert(
  niResult === 'No baseline',
  'building with zero savings-included meters reads "No baseline", not a misleading not-frozen (got "' +
    niResult +
    '")',
);

// ── Scenario 5: fully frozen, single-meter building (control) ──────────────────────
const allFrozen = [{ hasBaseline: true, included: true, trust: 'frozen' }];
assert(_udBuildingFreezeState(allFrozen) === 'Frozen', 'single fully-frozen included meter -> "Frozen"');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
