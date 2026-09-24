// tools/test-hvac-load-heating-fixes.js — SYNTHETIC-fixture regression gate for the 2026-09-23
// BAS Savings Calc / HVAC Load Estimation heating fixes (items 1 and 2):
//   1. hvacComputeGasThermsForBuilding — Existing Heating Gas Therms for the BAS Savings Calc,
//      computed directly from a building's own gas/propane bills WITHOUT requiring the HVAC Load
//      Estimation tab to have been opened first.
//   2. _hvlBuildingHasElectricHeat / _hvlDefaultGasPct — the Equipment Matrix-sourced
//      electric-heat detection that replaced the old p.heatType (project-level, essentially never
//      set) signal, so the "Heating % of HVAC kWh (electric heat only)" default is never 0 when a
//      real electric-heat unit is classified for the building.
//
// Loads the REAL functions (app/calculators.js _hvlMonthlyBaseline/_hvlDefaultGasPct/
// _hvlBuildingHasElectricHeat/hvacComputeGasThermsForBuilding — extracted verbatim, not
// reimplemented) into a Node vm sandbox. getNormRows/buildMoMap (computations/normalization.js —
// weather normalization, that module's own domain/coverage) are duck-typed stand-ins here, same
// technique tools/test-calc-autofill.js uses for equipment-matrix.js.
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

const CALC = path.join(REPO, 'app', 'calculators.js');
const src = [
  loadFn(CALC, '_hvlMonthlyBaseline'),
  loadFn(CALC, '_hvlDefaultGasPct'),
  loadFn(CALC, '_hvlBuildingHeatingSignals'),
  loadFn(CALC, '_hvlBuildingHasElectricHeat'),
  loadFn(CALC, 'hvacComputeGasThermsForBuilding'),
].join('\n\n');

// Fixture: a building with 12 months of gas bills (100 therms/mo = 1200/yr) and one propane
// bill equivalent (per the 0.9153 gal->therms factor hvacLoadCalc/hvacComputeGasThermsForBuilding
// both use). getNormRows/buildMoMap are stubbed to hand back a fixed monthly map — this test is
// about hvacComputeGasThermsForBuilding's OWN gathering + percentage logic, not normalization.js's
// weather-normalization math (that module's own coverage).
function makeSandbox(opts) {
  opts = opts || {};
  const gasMonthly = opts.gasMonthly; // {therms} per month, or undefined for "no gas meter"
  const propaneMonthly = opts.propaneMonthly; // {gallons} per month, or undefined
  const emHeatTypeRows = opts.emHeatTypeRows || null; // [{building,key,known}]
  const bldg = {
    id: 'b1',
    name: opts.bldgName || 'Synthetic Elementary',
    meters: [
      ...(gasMonthly ? [{ commodity: 'Gas', bills: [{}], baseline: { months: ['2026-01'] } }] : []),
      ...(propaneMonthly ? [{ commodity: 'Propane', bills: [{}], baseline: { months: ['2026-01'] } }] : []),
    ],
  };
  const sandbox = {
    console,
    getUDBldg: () => bldg,
    getWeatherForBuilding: () => ({ byYm: {} }),
    getNormRows: () => [{ ym: '2026-01' }], // any non-empty array; buildMoMap stub below ignores it
    buildMoMap: (meter) => {
      if (meter.commodity === 'Gas') {
        const gasByMo = {};
        for (let mo = 0; mo < 12; mo++) gasByMo[mo] = { therms: gasMonthly.therms };
        return { gasByMo };
      }
      if (meter.commodity === 'Propane') {
        const propaneByMo = {};
        for (let mo = 0; mo < 12; mo++) propaneByMo[mo] = { gallons: propaneMonthly.gallons };
        return { propaneByMo };
      }
      return {};
    },
  };
  if (emHeatTypeRows) {
    sandbox.emLoadMatrix = () => ({ rows: emHeatTypeRows.map((r, i) => ({ building: r.building, _i: i })) });
    sandbox.emGetNormalizedPoints = () => ({});
    sandbox._emDeriveHeatingType = (row) => {
      const r = emHeatTypeRows[row._i];
      return { key: r.key, known: r.known };
    };
    sandbox._emNormBldgNameForJoin = (name) => (name || '').toLowerCase().trim();
  }
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'hvac-load-heating-fixes.js' });
  return sandbox;
}

console.log('--- 1. _hvlDefaultGasPct ---');
{
  const sb = makeSandbox({ gasMonthly: { therms: 100 } });
  assert(sb._hvlDefaultGasPct(true) === 15, 'electric-heat building, gasHeat omitted -> 15% (back-compat 1-arg call)');
  assert(sb._hvlDefaultGasPct(false) === 80, 'gas-heat building -> 80% gas heating share default');
  // 2026-09-23 fix: a building with BOTH known gas/hydronic heat AND known electric heat (e.g. a
  // central gas boiler + a few standalone electric vestibule unit heaters) stays gas-dominant —
  // a small amount of electric heat does not mean the building's gas bill is mostly DHW/kitchen.
  assert(sb._hvlDefaultGasPct(true, true) === 80, 'electric heat present but gas/hydronic ALSO present -> stays 80%');
  assert(sb._hvlDefaultGasPct(true, false) === 15, 'electric heat present, NO gas/hydronic evidence at all -> 15%');
}

console.log('--- 2. _hvlBuildingHasElectricHeat — sourced from Equipment Matrix, never p.heatType ---');
{
  // All-gas classified rows -> false (matches Woodland Spring Middle's real 2026-09-23 data:
  // 151/151 rows classified hydronic, 0 electricReheat/heatpump).
  let sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [
      { building: 'Synthetic Elementary', key: 'hydronic', known: true },
      { building: 'Synthetic Elementary', key: 'hydronic', known: true },
    ],
  });
  assert(sb._hvlBuildingHasElectricHeat(1, 'b1') === false, 'all-gas EM rows -> no electric heat detected');

  // One electric-reheat row among many gas rows -> true (never 0% when a real electric-heat
  // unit is classified — the literal ask: "There is at least 1 electric heating unit").
  sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [
      { building: 'Synthetic Elementary', key: 'hydronic', known: true },
      { building: 'Synthetic Elementary', key: 'electricReheat', known: true },
    ],
  });
  assert(
    sb._hvlBuildingHasElectricHeat(1, 'b1') === true,
    'one known electricReheat row among many -> electric heat detected',
  );

  // A heat-pump/VRF row also counts.
  sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'heatpump', known: true }],
  });
  assert(sb._hvlBuildingHasElectricHeat(1, 'b1') === true, 'known heatpump/VRF row -> electric heat detected');

  // Unclassified fallback bucket (known:false) never counts as real evidence, even if its key
  // happens to be electricReheat (the all-electric-building fallback case).
  sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'electricReheat', known: false }],
  });
  assert(
    sb._hvlBuildingHasElectricHeat(1, 'b1') === false,
    'unclassified (known:false) row never counts, even if key is electricReheat',
  );

  // No Equipment Matrix data at all for this building -> false (no invented signal), never throws.
  sb = makeSandbox({ gasMonthly: { therms: 100 } });
  assert(sb._hvlBuildingHasElectricHeat(1, 'b1') === false, 'no Equipment Matrix hooks at all -> false, no throw');
}

console.log('--- 3. hvacComputeGasThermsForBuilding — headless BAS Savings Calc autofill (item 1) ---');
{
  // Gas-heat building (no known electric-heat EM rows): 12 x 100 = 1200 Therms/yr x 80% default.
  let sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'hydronic', known: true }],
  });
  let r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(!!r, 'returns a result when gas bills exist');
  assert(r.totalGas === 1200, `totalGas gathered from bills: got ${r && r.totalGas}, want 1200`);
  assert(r.hvacGasPct === 80, 'gas-heat building uses the 80% default (matches _hvlDefaultGasPct(false))');
  assert(near(r.hvacGasT, 960, 0.01), `hvacGasT = totalGas * gasPct/100: got ${r && r.hvacGasT}, want 960`);

  // Mixed building (Woodland Spring Middle's real pattern, 2026-09-23 fix): a central gas
  // boiler/hydronic reheat system (known hydronic rows) PLUS a few standalone electric unit
  // heaters (known electric rows) — stays gas-dominant (80%), since the school's gas bill is
  // still overwhelmingly space heating, not a few small vestibule heaters' worth of DHW/kitchen.
  sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [
      { building: 'Synthetic Elementary', key: 'hydronic', known: true },
      { building: 'Synthetic Elementary', key: 'electric', known: true },
    ],
  });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r.hvacGasPct === 80, 'mixed gas+electric building stays at the 80% gas-dominant default');
  assert(near(r.hvacGasT, 960, 0.01), `hvacGasT for mixed building: got ${r && r.hvacGasT}, want 960`);

  // Genuinely all-electric building (known electric/electricReheat/heatpump rows, ZERO known
  // hydronic rows) — the 15% DHW/kitchen-only default applies, proving the SAME shared default
  // (_hvlDefaultGasPct/_hvlBuildingHeatingSignals) the HVAC Load Estimation tab's own UI uses.
  sb = makeSandbox({
    gasMonthly: { therms: 100 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'electricReheat', known: true }],
  });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r.hvacGasPct === 15, 'all-electric building (no known hydronic rows) uses the 15% default');
  assert(near(r.hvacGasT, 180, 0.01), `hvacGasT for all-electric building: got ${r && r.hvacGasT}, want 180`);

  // No gas bills at all -> null, never invents a number.
  sb = makeSandbox({});
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r === null, 'no gas/propane bills -> null, never invented');

  // Propane-only building: gallons -> therms via the SAME 0.9153 factor hvacLoadCalc uses.
  sb = makeSandbox({ propaneMonthly: { gallons: 50 } });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(near(r.totalGas, 12 * 50 * 0.9153, 0.01), `propane gal->therms conversion: got ${r && r.totalGas}`);

  // No bldgId at all -> getUDBldg stub still resolves the fixture building in this harness, but
  // hvacComputeGasThermsForBuilding's own `if (!b) return null;` guard (real getUDBldg returns
  // null for an unmatched id — already covered by chCalcAutofillFields's own test) means an
  // unknown building never throws or invents a number in the real app.
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
