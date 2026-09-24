// test-equipment-matrix-heating-type-classifier.js
// Unit tests for the 2026-09-23 heating-type classifier fix (backlog: Woodland Spring Middle
// HVAC Load Est showed 0% electric heating even though standalone electric unit heaters exist
// in the Equipment Matrix — root cause: _emDeriveHeatingType had no rule at all for
// category:'heater' rows, so a real "Unit Heater Amps"/"Tube Heater Amperage" BAS point (a
// direct electrical-current signal) fell into the unclassified fallback bucket and was never
// counted as electric evidence).
//
// Loads the REAL app/equipment-matrix.js source into a Node vm sandbox (same technique as
// test-equipment-matrix-meters-lighting-classifier.js) — no reimplementation of classifier
// logic, every assertion calls the real _emDeriveHeatingType / emGetNormalizedPoints.
//
// Fixtures are 100% SYNTHETIC — no real client/project/building names.
//
// Run: node test-equipment-matrix-heating-type-classifier.js   (from the repo root)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, 'app', 'equipment-matrix.js');

function loadSandbox() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const sandbox = {
    console: console,
    document: {
      addEventListener: function () {},
      getElementById: function () {
        return null;
      },
      querySelector: function () {
        return null;
      },
      createElement: function () {
        return { style: {}, classList: { add: function () {} } };
      },
    },
    localStorage: {
      getItem: function () {
        return null;
      },
      setItem: function () {},
    },
    navigator: {},
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: SRC_PATH });
  return sandbox;
}

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const sb = loadSandbox();

function deriveFor(row, hasGas) {
  const pts = sb.emGetNormalizedPoints(row) || {};
  return sb._emDeriveHeatingType(row, pts, hasGas);
}

// ── 1. Standalone electric unit heater — real "Unit Heater Amps" point (Woodland pattern) ──
const synUnitHeater = {
  category: 'heater',
  equipName: 'SYN-A109 Vestibule Unit Heater',
  pointsRaw: {
    'Unit Heater Amps': '0.0 A',
    'Unit Heater Enable': 'Off',
    'Unit Heater Disabled, Status Is On': 'Normal',
    'Unit Heater Runtime Hours Exceeded': 'Normal',
    'Outside Air Dry Bulb': '75.6',
  },
};
const r1 = deriveFor(synUnitHeater, true);
assertEqual(r1.key, 'electric', 'Unit Heater Amps -> electric key');
assertEqual(r1.known, true, 'Unit Heater Amps -> known true');

// ── 2. Standalone electric tube heater — "Tube Heater Amperage" (JOCO pattern) ──────────────
const synTubeHeater = {
  category: 'heater',
  equipName: 'SYN Bay - TH-9',
  pointsRaw: {
    'Tube Heater Amperage': '0.0 A',
    'Tube Heater Enable': 'Off',
    'Tube Heater 1 Status': 'Off',
  },
};
const r2 = deriveFor(synTubeHeater, true);
assertEqual(r2.key, 'electric', 'Tube Heater Amperage -> electric key');
assertEqual(r2.known, true, 'Tube Heater Amperage -> known true');

// ── 3. Gas-fired unit heater (burner point, no Amps) — must stay hydronic, never electric ───
const synGasHeater = {
  category: 'heater',
  equipName: 'SYN-GUH-East',
  pointsRaw: {
    'Gas Heat Stage 1': 'Off',
    'Burner Status': 'Normal',
  },
};
const r3 = deriveFor(synGasHeater, true);
assertEqual(r3.key, 'hydronic', 'gas-fired heater (burner) stays hydronic');
assertEqual(r3.known, true, 'gas-fired heater burner point is a known signal');

// ── 4. Amps point on a NON-heater category (e.g. an RTU supply fan motor amps) must NEVER be
//      mistaken for heating evidence — the rule is restricted to cat==='heater' on purpose. ──
const synRtuFanAmps = {
  category: 'rtu',
  equipName: 'SYN RTU-1',
  pointsRaw: {
    'Supply Fan Motor Amps': '4.2 A',
    'Heating Signal': '0.0 V', // ambiguous, must not be guessed either
  },
};
const r4 = deriveFor(synRtuFanAmps, true);
assertEqual(r4.known, false, 'RTU fan-motor Amps point is never treated as heater-electric evidence');

// ── 5. Heater row with NO Amps/burner point at all — must stay in the honest "unknown" bucket
//      (never guess), same as before this fix. ──────────────────────────────────────────────
const synHeaterNoSignal = {
  category: 'heater',
  equipName: 'SYN Unit Heater No Points',
  pointsRaw: {
    'Outside Air Dry Bulb': '70.0',
  },
};
const r5 = deriveFor(synHeaterNoSignal, true);
assertEqual(r5.known, false, 'heater row with zero heat-fuel signal stays unknown (never guess)');

// ── 6. Pre-existing rules unaffected: VAV with a real Heating Valve point still -> hydronic ──
const synVav = {
  category: 'vav',
  equipName: 'SYN VAV-1',
  pointsRaw: { 'Heating Valve': '0.0 %' },
};
const r6 = deriveFor(synVav, true);
assertEqual(r6.key, 'hydronic', 'VAV heating-valve classification unaffected by this fix');
assertEqual(r6.known, true, 'VAV heating-valve classification unaffected by this fix (known)');

// ── 7. Pre-existing rule unaffected: VRF/heat-pump name match still -> heatpump ─────────────
const synVrf = { category: 'vrf', equipName: 'SYN VRF Indoor Unit 3', pointsRaw: {} };
const r7 = deriveFor(synVrf, true);
assertEqual(r7.key, 'heatpump', 'VRF category classification unaffected by this fix');

// ── 8. EM_SP_DEFAULTS.unocc carries the new 'electric' bucket at 65/85, grouped with heatpump,
//      distinct from electricReheat's 60/85 — per company standard (item 5). ───────────────
assertEqual(sb.EM_SP_DEFAULTS.unocc.electric.heat, 65, 'EM_SP_DEFAULTS.unocc.electric.heat = 65');
assertEqual(sb.EM_SP_DEFAULTS.unocc.electric.cool, 85, 'EM_SP_DEFAULTS.unocc.electric.cool = 85');
assertEqual(sb.EM_SP_DEFAULTS.unocc.heatpump.heat, 65, 'EM_SP_DEFAULTS.unocc.heatpump.heat = 65 (same bucket)');
assertEqual(sb.EM_SP_DEFAULTS.unocc.electricReheat.heat, 60, 'EM_SP_DEFAULTS.unocc.electricReheat.heat unchanged = 60');
assertEqual(sb.EM_SP_DEFAULTS.unocc.hydronic.heat, 55, 'EM_SP_DEFAULTS.unocc.hydronic.heat unchanged = 55');

// ── 9. emBuildSetpointExportRows: a building whose only heating-capable rows are hydronic +
//      one standalone electric unit heater produces a real (non-default-fallback) unocc value
//      for the electric row via EM_SP_DEFAULTS.unocc[heatType.key] — proves the export path
//      picks up the new bucket end-to-end, not just the raw classifier function. ─────────────
if (typeof sb.getUDBldgs === 'undefined')
  sb.getUDBldgs = function () {
    return [{ id: 'b1', name: 'Syn Building', meters: [{ commodity: 'Gas' }] }];
  };
if (typeof sb.getProjSavingsData === 'undefined')
  sb.getProjSavingsData = function () {
    return { basSetpoint: {} };
  };
sb.emLoadMatrix = function () {
  return {
    rows: [
      { building: 'Syn Building', category: 'vav', equipName: 'SYN VAV-1', pointsRaw: { 'Heating Valve': '0.0 %' } },
      Object.assign({ building: 'Syn Building' }, synUnitHeater),
    ],
  };
};
const exportRows = sb.emBuildSetpointExportRows('synProj', '', '');
assertEqual(exportRows.length, 2, 'emBuildSetpointExportRows returns one row per equipment row');
assertEqual(exportRows[1][14], '65', 'electric unit heater row -> Proposed Unoccupied Heating = 65 via export path');
assertEqual(exportRows[1][15], '85', 'electric unit heater row -> Proposed Unoccupied Cooling = 85 via export path');
assertEqual(exportRows.unknownHeatingCount, 0, 'both synthetic rows are now known (0 unknown) via the export path');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('All heating-type classifier tests passed.');
}
