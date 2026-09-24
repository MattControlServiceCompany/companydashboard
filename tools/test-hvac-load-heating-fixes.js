// tools/test-hvac-load-heating-fixes.js — SYNTHETIC-fixture regression gate for the 2026-09-23
// BAS Savings Calc / HVAC Load Estimation heating fixes (items 1 and 2), plus the 2026-09-23
// single-source heating-share fix (item 3):
//   1. hvacComputeGasThermsForBuilding — Existing Heating Gas Therms for the BAS Savings Calc,
//      computed directly from a building's own gas/propane bills WITHOUT requiring the HVAC Load
//      Estimation tab to have been opened first.
//   2. _hvlBuildingHasElectricHeat / _hvlDefaultGasPct — the Equipment Matrix-sourced
//      electric-heat detection that replaced the old p.heatType (project-level, essentially never
//      set) signal, so the "Heating % of HVAC kWh (electric heat only)" default is never 0 when a
//      real electric-heat unit is classified for the building.
//   3. _hvlGasHeatShare — the ONE computation (shared by hvacComputeGasThermsForBuilding and the
//      HVAC Load Estimation "Rules of Thumb" tab) that prefers the real, data-driven 3-lowest-
//      month baseload subtraction method (computeHvacEnduse, computations/hvac-enduse.js) over
//      the fixed 80%/15% Rules-of-Thumb percentage default, falling back to that default only
//      when there isn't enough bill history (<6 populated calendar months) to compute a split.
//
// Loads the REAL functions (app/calculators.js _hvlMonthlyBaseline/_hvlDefaultGasPct/
// _hvlBuildingHasElectricHeat/_hvlGasHeatShare/hvacComputeGasThermsForBuilding, and
// computations/hvac-enduse.js computeHvacEnduse — extracted verbatim, not reimplemented) into a
// Node vm sandbox. getNormRows/buildMoMap (computations/normalization.js — weather normalization,
// that module's own domain/coverage) are duck-typed stand-ins here, same technique
// tools/test-calc-autofill.js uses for equipment-matrix.js.
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
const HVAC_ENDUSE = path.join(REPO, 'computations', 'hvac-enduse.js');
const src = [
  loadFn(HVAC_ENDUSE, '_hvacLowestNAvg'),
  loadFn(HVAC_ENDUSE, '_hvacPopulatedCount'),
  loadFn(HVAC_ENDUSE, 'computeHvacEnduse'),
  loadFn(CALC, '_hvlMonthlyBaseline'),
  loadFn(CALC, '_hvlDefaultGasPct'),
  loadFn(CALC, '_hvlBuildingHeatingSignals'),
  loadFn(CALC, '_hvlBuildingHasElectricHeat'),
  loadFn(CALC, '_hvlGasHeatShare'),
  loadFn(CALC, 'hvacComputeGasThermsForBuilding'),
].join('\n\n');

// Fixture: a building with 12 months of gas bills — either a flat {therms} figure applied to
// every month (used for the <6-populated-months fallback-path tests, where only a handful of
// months are populated so no seasonal shape is possible anyway) or a seasonal {byMo:[12 values]}
// array (used to exercise the real 3-lowest-month baseload computation path) — and one propane
// bill equivalent (per the 0.9153 gal->therms factor hvacLoadCalc/hvacComputeGasThermsForBuilding
// both use). getNormRows/buildMoMap are stubbed to hand back a fixed monthly map — this test is
// about hvacComputeGasThermsForBuilding's/_hvlGasHeatShare's OWN gathering + selection logic, not
// normalization.js's weather-normalization math (that module's own coverage).
function makeSandbox(opts) {
  opts = opts || {};
  const gasMonthly = opts.gasMonthly; // {therms} flat every month, {byMo:[12]}, or {months:N} (populate first N only)
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
        if (gasMonthly.byMo) {
          for (let mo = 0; mo < 12; mo++)
            if (gasMonthly.byMo[mo] != null) gasByMo[mo] = { therms: gasMonthly.byMo[mo] };
        } else {
          const n = gasMonthly.months != null ? gasMonthly.months : 12;
          for (let mo = 0; mo < n; mo++) gasByMo[mo] = { therms: gasMonthly.therms };
        }
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

console.log('--- 3. hvacComputeGasThermsForBuilding — FALLBACK path, <6 populated months (item 1) ---');
{
  // Gas-heat building (no known electric-heat EM rows), only 5 populated calendar months — not
  // enough bill history (MIN_POPULATED_MONTHS=6) for computeHvacEnduse to compute a real baseload
  // split, so this exercises the _hvlDefaultGasPct fallback: 5 x 100 = 500 Therms/yr x 80% default.
  let sb = makeSandbox({
    gasMonthly: { therms: 100, months: 5 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'hydronic', known: true }],
  });
  let r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(!!r, 'returns a result when gas bills exist');
  assert(r.totalGas === 500, `totalGas gathered from bills: got ${r && r.totalGas}, want 500`);
  assert(r.source === 'default', 'fewer than 6 populated months -> falls back to the percentage default');
  assert(r.hvacGasPct === 80, 'gas-heat building uses the 80% default (matches _hvlDefaultGasPct(false))');
  assert(near(r.hvacGasT, 400, 0.01), `hvacGasT = totalGas * gasPct/100: got ${r && r.hvacGasT}, want 400`);

  // Mixed building (Woodland Spring Middle's real pattern, 2026-09-23 fix): a central gas
  // boiler/hydronic reheat system (known hydronic rows) PLUS a few standalone electric unit
  // heaters (known electric rows) — stays gas-dominant (80%), since the school's gas bill is
  // still overwhelmingly space heating, not a few small vestibule heaters' worth of DHW/kitchen.
  sb = makeSandbox({
    gasMonthly: { therms: 100, months: 5 },
    emHeatTypeRows: [
      { building: 'Synthetic Elementary', key: 'hydronic', known: true },
      { building: 'Synthetic Elementary', key: 'electric', known: true },
    ],
  });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r.hvacGasPct === 80, 'mixed gas+electric building stays at the 80% gas-dominant default');
  assert(near(r.hvacGasT, 400, 0.01), `hvacGasT for mixed building: got ${r && r.hvacGasT}, want 400`);

  // Genuinely all-electric building (known electric/electricReheat/heatpump rows, ZERO known
  // hydronic rows) — the 15% DHW/kitchen-only default applies, proving the SAME shared default
  // (_hvlDefaultGasPct/_hvlBuildingHeatingSignals) the HVAC Load Estimation tab's own UI uses.
  sb = makeSandbox({
    gasMonthly: { therms: 100, months: 5 },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'electricReheat', known: true }],
  });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r.hvacGasPct === 15, 'all-electric building (no known hydronic rows) uses the 15% default');
  assert(near(r.hvacGasT, 75, 0.01), `hvacGasT for all-electric building: got ${r && r.hvacGasT}, want 75`);

  // No gas bills at all -> null, never invents a number.
  sb = makeSandbox({});
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r === null, 'no gas/propane bills -> null, never invented');

  // Propane-only building, <6 months: gallons -> therms via the SAME 0.9153 factor hvacLoadCalc uses.
  sb = makeSandbox({ propaneMonthly: { gallons: 50 } });
  // propaneByMo fixture above always fills all 12 months, so this exercises the COMPUTED baseload
  // path (see section 4) rather than the fallback — kept here only to prove totalGas gathering
  // (gal->therms conversion) is correct regardless of which pct-source is chosen.
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(near(r.totalGas, 12 * 50 * 0.9153, 0.01), `propane gal->therms conversion: got ${r && r.totalGas}`);

  // No bldgId at all -> getUDBldg stub still resolves the fixture building in this harness, but
  // hvacComputeGasThermsForBuilding's own `if (!b) return null;` guard (real getUDBldg returns
  // null for an unmatched id — already covered by chCalcAutofillFields's own test) means an
  // unknown building never throws or invents a number in the real app.
}

console.log(
  '--- 4. _hvlGasHeatShare — COMPUTED baseload path, single source with hvacComputeGasThermsForBuilding (item 3) ---',
);
{
  // Seasonal 12-month gas fixture (Jan..Dec): a real heating-season shape, 3 lowest summer months
  // (Jun/Jul/Aug = 20/20/25) are the DHW/kitchen-only baseload. This is the SAME 3-lowest-month
  // subtraction method computeHvacEnduse implements for the Energy Graphics HVAC End-Use Estimate
  // card — proving hvacComputeGasThermsForBuilding/_hvlGasHeatShare route through that ONE
  // function instead of the fixed 80%/15% Rules-of-Thumb default whenever real bill history exists.
  const byMo = [300, 280, 200, 120, 60, 20, 20, 25, 60, 120, 220, 290];
  const totalGas = byMo.reduce((s, v) => s + v, 0); // 1715
  const baseload = (20 + 20 + 25) / 3; // 21.6667 — avg of 3 lowest populated months
  const heatingTherms = byMo.reduce((s, v) => s + Math.max(0, v - baseload), 0); // ~1458.33

  let sb = makeSandbox({
    gasMonthly: { byMo },
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'hydronic', known: true }],
  });
  let r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(!!r, 'returns a result for a full seasonal 12-month gas fixture');
  assert(r.totalGas === totalGas, `totalGas gathered from bills: got ${r && r.totalGas}, want ${totalGas}`);
  assert(r.source === 'baseload', '>=6 populated months -> computed baseload path, not the percentage default');
  assert(
    near(r.hvacGasT, heatingTherms, 1),
    `hvacGasT = 3-lowest-month baseload subtraction: got ${r && r.hvacGasT}, want ~${heatingTherms.toFixed(2)}`,
  );
  assert(
    near(r.hvacGasPct, (heatingTherms / totalGas) * 100, 0.2),
    `hvacGasPct matches heatingTherms/totalGas: got ${r && r.hvacGasPct}`,
  );

  // _hvlGasHeatShare is the SAME function hvacComputeGasThermsForBuilding calls — direct check
  // confirms there is only one computation, not two independent ones reaching the same number.
  const share = sb._hvlGasHeatShare(1, 'b1');
  assert(
    share.source === 'baseload' && near(share.heatingTherms, heatingTherms, 1),
    '_hvlGasHeatShare agrees with hvacComputeGasThermsForBuilding exactly',
  );

  // Fewer than 6 populated months even with a seasonal shape supplied -> still falls back (not
  // enough data to trust a 3-lowest-month average), proving the 6-month gate applies regardless
  // of fixture shape, not just the flat-value fixtures in section 3.
  sb = makeSandbox({
    gasMonthly: { byMo: byMo.map((v, i) => (i < 4 ? v : null)) }, // only Jan-Apr populated
    emHeatTypeRows: [{ building: 'Synthetic Elementary', key: 'hydronic', known: true }],
  });
  r = sb.hvacComputeGasThermsForBuilding(1, 'b1');
  assert(r.source === 'default', '<6 populated months, even seasonal -> falls back to the percentage default');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
