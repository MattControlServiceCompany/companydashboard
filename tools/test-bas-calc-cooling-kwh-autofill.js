// tools/test-bas-calc-cooling-kwh-autofill.js — SYNTHETIC-fixture regression gate for the
// 2026-09-24 BAS Savings Calc "Existing Cooling kWh (from Utility Analysis)" autofill fix.
//
// Bug: Section D's "Existing Cooling kWh" field had NO fresh-compute fallback at all — unlike
// "Existing Heating Gas Therms" (calHeatGas), which got a live-from-bills fallback on 2026-09-23
// (hvacComputeGasThermsForBuilding), calCoolKwh only ever read a SAVED p.hvacLoadEst.coolKwhTotal
// snapshot. For a project/building nobody had opened the HVAC Load Estimation tab and clicked
// Save for — e.g. Spring Hill Schools / Woodland Spring Middle, reported 2026-09-24 — the field
// showed "0, Default value (not from building data)" even though the building has a full year of
// its own electric bills that could compute a real figure, exactly the gap the gas fix already
// closed for calHeatGas.
//
// Fix: hvacComputeElecCoolKwhForBuilding (app/calculators.js) — computes Existing Cooling kWh
// fresh from THIS building's own electric bills via computeHvacEnduse's 3-lowest-month baseload
// subtraction method (computations/hvac-enduse.js — the SAME canonical function
// hvacComputeGasThermsForBuilding already uses for gas, and the Energy Graphics HVAC End-Use
// Estimate card uses) — single source, no second re-implementation. openBASCalc prefers a real
// SAVED HVAC Load Estimation snapshot when one exists, exactly like the gas fallback's precedence.
//
// This test loads the REAL functions (app/calculators.js _hvlMonthlyBaseline/
// hvacComputeElecCoolKwhForBuilding, computations/hvac-enduse.js computeHvacEnduse — extracted
// verbatim) into a Node vm sandbox, same technique as tools/test-hvac-load-heating-fixes.js.
// getNormRows/buildMoMap are duck-typed stand-ins (normalization.js's own coverage, not this
// function's).
//
// Run: node tools/test-bas-calc-cooling-kwh-autofill.js
// Against the pre-fix source (hvacComputeElecCoolKwhForBuilding doesn't exist yet), loadFn throws
// "not found: function hvacComputeElecCoolKwhForBuilding" immediately — the test cannot pass on
// the broken code.
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('function ' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: function ' + fnName + ' in ' + file);
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

const CALC = path.join(REPO, 'app', 'calculators.js');
const HVAC_ENDUSE = path.join(REPO, 'computations', 'hvac-enduse.js');
const src = [
  loadFn(HVAC_ENDUSE, '_hvacLowestNAvg'),
  loadFn(HVAC_ENDUSE, '_hvacPopulatedCount'),
  loadFn(HVAC_ENDUSE, 'computeHvacEnduse'),
  loadFn(CALC, '_hvlMonthlyBaseline'),
  loadFn(CALC, 'hvacComputeElecCoolKwhForBuilding'),
].join('\n\n');

// Fixture: a building with 12 months of electric bills — either a flat {kwh} figure applied to
// every month ({months:N} populates only the first N, for the <6-populated-months fallback-path
// test) or a seasonal {byMo:[12 values]} array (used to exercise the real 3-lowest-month baseload
// computation path, e.g. a winter/summer-baseload + real cooling bump shape). getNormRows/
// buildMoMap are stubbed to hand back a fixed monthly map — this test is about
// hvacComputeElecCoolKwhForBuilding's OWN gathering + call-into-computeHvacEnduse logic, not
// normalization.js's weather-normalization math.
function makeSandbox(opts) {
  opts = opts || {};
  const elecMonthly = opts.elecMonthly; // {kwh}, {kwh, months:N}, or {byMo:[12]}
  const bldg = {
    id: 'b1',
    name: opts.bldgName || 'Synthetic Elementary',
    meters: [...(elecMonthly ? [{ commodity: 'Electric', bills: [{}], baseline: { months: ['2026-01'] } }] : [])],
  };
  const sandbox = {
    console,
    getUDBldg: () => bldg,
    getWeatherForBuilding: () => ({ byYm: {} }),
    getNormRows: () => [{ ym: '2026-01' }],
    buildMoMap: (meter) => {
      if (meter.commodity !== 'Electric') return {};
      const elecByMo = {};
      if (elecMonthly.byMo) {
        for (let mo = 0; mo < 12; mo++) if (elecMonthly.byMo[mo] != null) elecByMo[mo] = { kwh: elecMonthly.byMo[mo] };
      } else {
        const n = elecMonthly.months != null ? elecMonthly.months : 12;
        for (let mo = 0; mo < n; mo++) elecByMo[mo] = { kwh: elecMonthly.kwh };
      }
      return { elecByMo };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'bas-calc-cooling-kwh-autofill.js' });
  return sandbox;
}

console.log('--- 1. hvacComputeElecCoolKwhForBuilding — real baseload computation path ---');
{
  // Synthetic school-shaped electric load: flat 40,000 kWh/mo winter baseload, ramping up to a
  // clear 100,000 kWh summer peak (Jun/Jul/Aug) — a realistic cooling-driven seasonal shape, NOT
  // Woodland's real numbers (per the repo's synthetic-fixtures-only rule).
  const byMo = [40000, 40000, 42000, 48000, 65000, 95000, 100000, 92000, 60000, 45000, 41000, 40000];
  const sb = makeSandbox({ elecMonthly: { byMo } });
  const r = sb.hvacComputeElecCoolKwhForBuilding(1, 'b1');
  assert(!!r, 'returns a result with 12 populated months of seasonal electric bills');
  assert(r.source === 'baseload', 'enough bill history -> real 3-lowest-month baseload method, not a fallback');
  // Baseload = avg of 3 lowest months (40000,40000,40000) = 40000; coolingKwh = sum of
  // max(0, month - baseload) across all 12 months.
  const expectedBaseload = 40000;
  const expectedCoolingKwh = byMo.reduce((s, v) => s + Math.max(0, v - expectedBaseload), 0);
  assert(
    near(r.coolingKwh, expectedCoolingKwh, 0.01),
    `coolingKwh = sum(month - baseload) for month > baseload: got ${r && r.coolingKwh}, want ${expectedCoolingKwh}`,
  );
  assert(r.coolingKwh > 0, 'coolingKwh is a real positive number, not the "0, Default value" bug');
}

console.log('--- 2. hvacComputeElecCoolKwhForBuilding — fewer than 6 populated months -> null (never invents) ---');
{
  // Only 5 populated calendar months — not enough bill history (MIN_POPULATED_MONTHS=6 inside
  // computeHvacEnduse) to compute a baseload split. Must return null, not a guessed number.
  const sb = makeSandbox({ elecMonthly: { kwh: 50000, months: 5 } });
  const r = sb.hvacComputeElecCoolKwhForBuilding(1, 'b1');
  assert(r === null, "fewer than 6 populated months -> null, never invented (matches the gas fallback's own rule)");
}

console.log('--- 3. hvacComputeElecCoolKwhForBuilding — no electric bills at all -> null ---');
{
  const sb = makeSandbox({});
  const r = sb.hvacComputeElecCoolKwhForBuilding(1, 'b1');
  assert(r === null, 'no electric bills -> null, never invented');
}

console.log(
  '--- 4. hvacComputeElecCoolKwhForBuilding — flat load, no cooling signal -> null, not a fabricated 0-as-real value ---',
);
{
  // 12 months, perfectly flat (no seasonal bump at all) -> baseload = every month -> coolingKwh
  // sums to 0 -> the function must return null (guarded by `enduse.coolingKwh > 0`), not a
  // {coolingKwh: 0, source: 'baseload'} result that would look autofilled but carry no real signal.
  const sb = makeSandbox({ elecMonthly: { kwh: 40000, months: 12 } });
  const r = sb.hvacComputeElecCoolKwhForBuilding(1, 'b1');
  assert(r === null, 'flat 12-month load (no cooling signal) -> null, not a fake zero labeled as computed');
}

console.log('--- 5. A second, differently-shaped synthetic building — proves this is not Woodland-only ---');
{
  // A smaller, less cooling-dominant building (e.g. an admin building) — different sqft-scale
  // magnitude and a smaller summer bump, proving the function generalizes and is driven entirely
  // by THIS building's own bill data, not a hardcoded shape or magnitude.
  const byMo2 = [8000, 8000, 8200, 9000, 11000, 15000, 16000, 14500, 10500, 9200, 8300, 8000];
  const sb2 = makeSandbox({ elecMonthly: { byMo: byMo2 }, bldgName: 'Synthetic Admin Building' });
  const r2 = sb2.hvacComputeElecCoolKwhForBuilding(2, 'b1');
  assert(!!r2, 'second synthetic building with a different shape also returns a result');
  assert(r2.source === 'baseload', 'second building also uses the real baseload method');
  const expectedBaseload2 = 8000;
  const expectedCoolingKwh2 = byMo2.reduce((s, v) => s + Math.max(0, v - expectedBaseload2), 0);
  assert(
    near(r2.coolingKwh, expectedCoolingKwh2, 0.01),
    `second building coolingKwh: got ${r2 && r2.coolingKwh}, want ${expectedCoolingKwh2}`,
  );
  assert(
    r2.coolingKwh !== undefined && Math.abs(r2.coolingKwh - 141970) > 1,
    "second building result is NOT Woodland's real 141,970/216,230/332,662-style figure — proves no hardcoded value leaked in",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
