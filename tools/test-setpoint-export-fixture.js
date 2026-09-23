// tools/test-setpoint-export-fixture.js — Setpoint & Schedule export regression gate.
// Run: node tools/test-setpoint-export-fixture.js
//
// Loads the REAL app/equipment-matrix.js source (verbatim, not reimplemented) into a Node vm
// sandbox and exercises the real emBuildSetpointExportRows / emGetSetpointExportOptions /
// EM_SETPOINT_EXPORT_HEADERS against a SYNTHETIC fixture (no real client data in the repo):
// one building with matching Equipment Matrix + Utility Data + BAS Savings Calc names, one
// building with a deliberately non-matching Equipment Matrix building name (to prove the
// join fails safe — every Proposed cell shows '?', never a wrong building's numbers), one
// row missing BAS Points (must show '?' in every Existing column, never a fabricated value),
// and one row with a heating/cooling ADJUST mismatch (must show the combined 'H:x / C:y' form).
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

// ── Minimal in-memory stand-ins for the cross-file APIs equipment-matrix.js calls into.
// These are NOT the real utility-data.js/energy-savings.js/core.js implementations — this test
// is scoped to equipment-matrix.js's own setpoint-export logic, exercised with fixture data. ──
const kvStore = {};
function sget(k, fb) {
  return Object.prototype.hasOwnProperty.call(kvStore, k) ? kvStore[k] : fb;
}
function sset(k, v) {
  kvStore[k] = v;
  return Promise.resolve();
}

// Synthetic fixture — no real client names, buildings, or point data.
const FIXTURE_PID = 'fx-proj-1';
const BLDG_MATCH = { id: 'bldg-match-1', name: 'Fixture Elementary' };
const BLDG_MISMATCH_UD = { id: 'bldg-mismatch-1', name: 'Fixture Annex' };
const udBuildings = [BLDG_MATCH, BLDG_MISMATCH_UD];

const emRows = [
  {
    id: 'r1',
    building: 'Fixture Elementary', // exact match to BLDG_MATCH.name
    location: 'Zone 101 - Classroom',
    equipName: 'VAV-1',
    category: 'vav',
    points: {
      zoneHtgSetpoint: 68,
      zoneCoolSetpoint: 72,
      zoneUnoccHtgSetpoint: 60,
      zoneUnoccCoolSetpoint: 85,
      zoneHtgAdjust: 2,
      zoneCoolAdjust: 2,
    },
  },
  {
    id: 'r2',
    building: 'Fixture Elementary',
    location: 'Zone 102 - Office',
    equipName: 'VAV-2',
    category: 'vav',
    points: {
      zoneHtgSetpoint: 66,
      zoneCoolSetpoint: 74,
      zoneUnoccHtgSetpoint: 58,
      zoneUnoccCoolSetpoint: 86,
      zoneHtgAdjust: 1,
      zoneCoolAdjust: 3, // deliberately different from heat adjust -> 'H:1 / C:3'
    },
  },
  {
    id: 'r3',
    building: 'Fixture Elementary',
    location: '',
    equipName: 'AHU-1', // no location text -> falls back to equipName
    category: 'ahu',
    points: {}, // no BAS points at all -> every Existing cell must be '?'
  },
  {
    id: 'r4',
    // Deliberate mismatch: this building name does NOT exactly match any Utility Data
    // building name (real-world case found 2026-09-22: Equipment Matrix "Woodland Spring
    // Middle School" vs Utility Data "Woodland Spring Middle"). The join must fail SAFE —
    // Proposed columns '?', never silently borrowing another building's saved option.
    building: 'Fixture Annex Building', // note: NOT 'Fixture Annex' (BLDG_MISMATCH_UD.name)
    location: 'Zone 201',
    equipName: 'VAV-3',
    category: 'vav',
    points: { zoneHtgSetpoint: 70, zoneCoolSetpoint: 75 },
  },
];

kvStore['en_eqmatrix_' + FIXTURE_PID] = { rows: emRows, importedAt: null, buildings: [] };

function getUDBldgs(pid) {
  return pid === FIXTURE_PID ? udBuildings : [];
}
function getProjSavingsData(pid) {
  if (pid !== FIXTURE_PID) return { measures: [], blRates: {} };
  return {
    measures: [],
    blRates: {},
    basSetpoint: {
      [BLDG_MATCH.id]: {
        curOccHeat: 68,
        curOccCool: 72,
        options: [
          { letter: 'A', heatSP: 69, coolSP: 73 },
          { letter: 'B', heatSP: 70, coolSP: 74 },
          { letter: 'C', heatSP: null, coolSP: null }, // empty option -> must not count toward "available letters"
        ],
      },
      // BLDG_MISMATCH_UD intentionally has NO basSetpoint entry — the mismatched EM row (r4)
      // must never resolve to it or any other building's option data.
    },
  };
}
function showToast() {}

// ── Load the real source into a sandbox ─────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8');
assert(src.includes('function emBuildSetpointExportRows'), 'source contains emBuildSetpointExportRows');
assert(src.includes('function emGetSetpointExportOptions'), 'source contains emGetSetpointExportOptions');
assert(src.includes('var EM_SETPOINT_EXPORT_HEADERS'), 'source contains EM_SETPOINT_EXPORT_HEADERS');

const sandbox = {
  console,
  window: {},
  sget,
  sset,
  getUDBldgs,
  getProjSavingsData,
  showToast,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app/equipment-matrix.js' });

// ── 1. Exact 20 headings, exact order (Matt's spec, 2026-09-22) ─────────────────────────────
const EXPECTED_HEADERS = [
  'Building Name',
  'Building location or equipment affected',
  'Type of Equipment',
  'Existing Occupied Heating',
  'Existing Occupied Cooling',
  'Existing Unoccupied Heating',
  'Existing Unoccupied Cooling',
  'Existing Adjustment',
  'Existing Occupied Time Monday-Friday',
  'Existing Occupied Start Time Monday-Friday',
  'Existing Occupied Stop Time Monday-Friday',
  'Existing Occupied Sat & Sun',
  'Proposed Occupied Heating',
  'Proposed Occupied Cooling',
  'Proposed Unoccupied Heating',
  'Proposed Unoccupied Cooling',
  'Proposed Adjustment Range +-',
  'Proposed Occupied Start Time Monday-Friday',
  'Proposed Occupied Stop Time Monday-Friday',
  'Proposed Occupied Sat & Sun',
];
assert(sandbox.EM_SETPOINT_EXPORT_HEADERS.length === 20, 'exactly 20 headers');
assert(
  JSON.stringify(sandbox.EM_SETPOINT_EXPORT_HEADERS) === JSON.stringify(EXPECTED_HEADERS),
  "headers match Matt's spec exactly, in order",
);

// ── 2. Row count == equipment count (all buildings, no option letter) ───────────────────────
const allRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, '', '');
assert(allRows.length === emRows.length, 'row count equals equipment row count (' + emRows.length + ')');
allRows.forEach((r) => assert(r.length === 20, 'row has exactly 20 cells'));

// ── 3. Row 1 (matched building, full BAS points, option A) traces back to its BAS points ────
const optionLetters = sandbox.emGetSetpointExportOptions(FIXTURE_PID, [BLDG_MATCH.id]);
assert(
  JSON.stringify(optionLetters) === JSON.stringify(['A', 'B']),
  'empty option C excluded from available letters, got ' + JSON.stringify(optionLetters),
);

const matchRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_MATCH.id, 'A');
assert(matchRows.length === 3, 'building filter returns only Fixture Elementary rows (3)');
const r1 = matchRows[0];
assert(r1[0] === 'Fixture Elementary', 'r1 Building Name traces to row.building');
assert(r1[1] === 'Zone 101 - Classroom', 'r1 Location traces to row.location');
assert(r1[3] === '68', 'r1 Existing Occupied Heating traces to points.zoneHtgSetpoint (68)');
assert(r1[4] === '72', 'r1 Existing Occupied Cooling traces to points.zoneCoolSetpoint (72)');
assert(r1[5] === '60', 'r1 Existing Unoccupied Heating traces to points.zoneUnoccHtgSetpoint (60)');
assert(r1[6] === '85', 'r1 Existing Unoccupied Cooling traces to points.zoneUnoccCoolSetpoint (85)');
assert(r1[7] === '2', 'r1 Existing Adjustment traces to matching heat/cool adjust (2)');
assert(r1[12] === '69', 'r1 Proposed Occupied Heating traces to basSetpoint option A heatSP (69)');
assert(r1[13] === '73', 'r1 Proposed Occupied Cooling traces to basSetpoint option A coolSP (73)');

const r2 = matchRows[1];
assert(r2[7] === 'H:1 / C:3', 'r2 Existing Adjustment shows combined H/C form when heat != cool adjust');

const r3 = matchRows[2];
assert(r3[1] === 'AHU-1', 'r3 Location falls back to equipName when row.location is blank');
[3, 4, 5, 6, 7].forEach((ci) => assert(r3[ci] === '?', 'r3 (no BAS points) column ' + ci + ' is "?" — never invented'));

// ── 4. Mismatched building name (r4) fails SAFE: Proposed columns '?', never another building's
//      saved option — this is the real-world naming-drift case found 2026-09-22.               */
const r4 = allRows.find((r) => r[0] === 'Fixture Annex Building');
assert(!!r4, 'mismatched-name row is still exported (never dropped)');
assert(r4[3] === '70' && r4[4] === '75', 'mismatched row still reads its OWN Existing BAS points');
assert(
  r4[12] === '?' && r4[13] === '?',
  'mismatched row Proposed columns are "?", never borrowed from another building',
);

// ── 5. Unknown-option request never invents a value ──────────────────────────────────────────
const noOptRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_MATCH.id, 'Z');
assert(
  noOptRows.every((r) => r[12] === '?' && r[13] === '?'),
  'requesting a non-existent option letter leaves Proposed columns "?"',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
