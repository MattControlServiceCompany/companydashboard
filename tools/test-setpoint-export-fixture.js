// tools/test-setpoint-export-fixture.js — Setpoint & Schedule export regression gate.
// Run: node tools/test-setpoint-export-fixture.js
//
// Loads the REAL app/equipment-matrix.js source (verbatim, not reimplemented) into a Node vm
// sandbox and exercises the real emBuildSetpointExportRows / emGetSetpointExportOptions /
// EM_SETPOINT_EXPORT_HEADERS / _emDeriveHeatingType / _emComputeProposedSchedule /
// _emNormBldgNameForJoin against a SYNTHETIC fixture (no real client data in the repo):
// one building with matching Equipment Matrix + Utility Data + BAS Savings Calc names, one
// building whose Equipment Matrix name only matches Utility Data after normalization (trailing
// "School" — the real-world 2026-09-22 case), one building with a genuinely non-matching name
// (must still fail safe to company standard defaults, never another building's numbers), one
// row missing BAS Points (must show '?' in every Existing column, never a fabricated value),
// one row with a heating/cooling ADJUST mismatch (must show the combined 'H:x / C:y' form),
// and one row per heating-type bucket (hydronic/gas, electric reheat, heat pump/VRF, unknown).
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
// Utility Data name has NO trailing "School" — Equipment Matrix rows below use
// 'Fixture Middle School' to prove the normalized join (case/whitespace/trailing "School").
const BLDG_NORM = { id: 'bldg-norm-1', name: 'Fixture Middle' };
const BLDG_MISMATCH_UD = { id: 'bldg-mismatch-1', name: 'Fixture Annex' };
const udBuildings = [BLDG_MATCH, BLDG_NORM, BLDG_MISMATCH_UD];

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
    // Genuine mismatch: this building name does NOT match any Utility Data building name even
    // after normalization — the join must fail SAFE to company standard defaults, never
    // another building's saved option.
    building: 'Fixture Annex Building', // note: NOT 'Fixture Annex' (BLDG_MISMATCH_UD.name)
    location: 'Zone 201',
    equipName: 'VAV-3',
    category: 'vav',
    points: { zoneHtgSetpoint: 70, zoneCoolSetpoint: 75 },
  },
  {
    id: 'r5',
    // Real-world 2026-09-22 case: Equipment Matrix carries the trailing "School" that Utility
    // Data's building name (BLDG_NORM = 'Fixture Middle') does not.
    building: 'Fixture Middle School',
    location: 'Zone 301',
    equipName: 'VAV-4',
    category: 'vav',
    points: { zoneHtgSetpoint: 69, zoneCoolSetpoint: 73 },
  },
  {
    id: 'r6',
    // Electric reheat — name signal, no heatSourceSupplyTemp point.
    building: 'Fixture Elementary',
    location: 'Zone 401',
    equipName: 'Electric Reheat VAV-5',
    category: 'vav',
    points: { zoneHtgSetpoint: 68, zoneCoolSetpoint: 74 },
  },
  {
    id: 'r7',
    // Heat pump / VRF — category signal.
    building: 'Fixture Elementary',
    location: 'Zone 402',
    equipName: 'VRF Indoor Unit-1',
    category: 'vrf',
    points: { zoneHtgSetpoint: 70, zoneCoolSetpoint: 74 },
  },
  {
    id: 'r8',
    // Hydronic hot water — heatSourceSupplyTemp point present, category otherwise unremarkable.
    building: 'Fixture Elementary',
    location: 'Zone 403',
    equipName: 'VAV-6',
    category: 'vav',
    points: { zoneHtgSetpoint: 68, zoneCoolSetpoint: 74, heatSourceSupplyTemp: 140 },
  },
  {
    id: 'r9',
    // No classification signal at all -> unknown, hydronic default used, flagged.
    building: 'Fixture Elementary',
    location: 'Zone 404',
    equipName: 'Zone Terminal-7',
    category: 'zone',
    points: { zoneHtgSetpoint: 68, zoneCoolSetpoint: 74 },
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
      // BLDG_NORM and BLDG_MISMATCH_UD intentionally have NO basSetpoint entry — their rows must
      // fall back to the company standard default, never borrow another building's option data.
    },
  };
}
function showToast() {}

// ── Load the real source into a sandbox ─────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8');
assert(src.includes('function emBuildSetpointExportRows'), 'source contains emBuildSetpointExportRows');
assert(src.includes('function emGetSetpointExportOptions'), 'source contains emGetSetpointExportOptions');
assert(src.includes('var EM_SETPOINT_EXPORT_HEADERS'), 'source contains EM_SETPOINT_EXPORT_HEADERS');
assert(src.includes('function _emDeriveHeatingType'), 'source contains _emDeriveHeatingType');
assert(src.includes('function _emComputeProposedSchedule'), 'source contains _emComputeProposedSchedule');
assert(src.includes('function _emNormBldgNameForJoin'), 'source contains _emNormBldgNameForJoin');
assert(src.includes('var EM_SP_DEFAULTS'), 'source contains EM_SP_DEFAULTS (one defaults constant)');
assert(
  src.includes('var EM_SP_STAFF_BUFFER_HOURS'),
  'source contains EM_SP_STAFF_BUFFER_HOURS (one named buffer value)',
);

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

// ── 3. Row 1 (matched building, full BAS points, option A) traces back to its BAS points,
//      and its Proposed columns use the project option where one is saved. ──────────────────
const optionLetters = sandbox.emGetSetpointExportOptions(FIXTURE_PID, [BLDG_MATCH.id]);
assert(
  JSON.stringify(optionLetters) === JSON.stringify(['A', 'B']),
  'empty option C excluded from available letters, got ' + JSON.stringify(optionLetters),
);

const matchRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_MATCH.id, 'A');
assert(matchRows.length === 7, 'building filter returns only Fixture Elementary rows (7: r1,r2,r3,r6,r7,r8,r9)');
const r1 = matchRows[0];
assert(r1[0] === 'Fixture Elementary', 'r1 Building Name traces to row.building');
assert(r1[1] === 'Zone 101 - Classroom', 'r1 Location traces to row.location');
assert(r1[3] === '68', 'r1 Existing Occupied Heating traces to points.zoneHtgSetpoint (68)');
assert(r1[4] === '72', 'r1 Existing Occupied Cooling traces to points.zoneCoolSetpoint (72)');
assert(r1[5] === '60', 'r1 Existing Unoccupied Heating traces to points.zoneUnoccHtgSetpoint (60)');
assert(r1[6] === '85', 'r1 Existing Unoccupied Cooling traces to points.zoneUnoccCoolSetpoint (85)');
assert(r1[7] === '2', 'r1 Existing Adjustment traces to matching heat/cool adjust (2)');
assert(r1[12] === '69', 'r1 Proposed Occupied Heating traces to basSetpoint option A heatSP (69) — project value wins');
assert(r1[13] === '73', 'r1 Proposed Occupied Cooling traces to basSetpoint option A coolSP (73) — project value wins');
// r1 is a 'vav' row with no heatSourceSupplyTemp point and no name signal -> hydronic default.
assert(r1[14] === '55' && r1[15] === '85', 'r1 Proposed Unoccupied falls back to hydronic default (55/85)');
assert(r1[16] === '2', 'r1 Proposed Adjustment Range is always the company standard default (2)');
assert(r1[17] === '6:00' && r1[18] === '17:00', 'r1 Proposed schedule is school hours (7:30-15:30) +-1.5h buffer');
assert(r1[19] === 'None', 'r1 Proposed Occupied Sat & Sun is always "None"');

const r2 = matchRows[1];
assert(r2[7] === 'H:1 / C:3', 'r2 Existing Adjustment shows combined H/C form when heat != cool adjust');

const r3 = matchRows[2];
assert(r3[1] === 'AHU-1', 'r3 Location falls back to equipName when row.location is blank');
[3, 4, 5, 6, 7].forEach((ci) => assert(r3[ci] === '?', 'r3 (no BAS points) column ' + ci + ' is "?" — never invented'));
// Even with no Existing BAS points, Proposed still defaults (no project option -> company standard).
assert(r3[12] === '69' && r3[13] === '73', 'r3 Proposed Occupied still uses option A even with no Existing points');

// ── 4. No option selected at all -> Proposed Occupied Heating/Cooling use the company standard
//      default (70/74), never '?'. ────────────────────────────────────────────────────────────
const noOptRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_MATCH.id, '');
assert(
  noOptRows.every((r) => r[12] === '70' && r[13] === '74'),
  'no option selected -> Proposed Occupied Heating/Cooling use company standard default (70/74)',
);

// ── 5. Genuinely mismatched building name (r4) fails SAFE to company standard defaults, never
//      another building's saved option — the real-world naming-drift class of bug. ────────────
const r4 = allRows.find((r) => r[0] === 'Fixture Annex Building');
assert(!!r4, 'mismatched-name row is still exported (never dropped)');
assert(r4[3] === '70' && r4[4] === '75', 'mismatched row still reads its OWN Existing BAS points');
assert(
  r4[12] === '70' && r4[13] === '74',
  'mismatched row Proposed Occupied Heating/Cooling use the company standard default, never borrowed',
);
assert(
  r4[14] === '55' && r4[15] === '85',
  'mismatched row Proposed Unoccupied still uses its own heating-type default',
);

// ── 6. Normalized join: "Fixture Middle School" (Equipment Matrix) resolves against Utility
//      Data's "Fixture Middle" (no trailing "School") — the real 2026-09-22 case. ─────────────
const r5 = allRows.find((r) => r[0] === 'Fixture Middle School');
assert(!!r5, 'normalized-join row is exported');
const normBldgOptions = sandbox.emGetSetpointExportOptions(FIXTURE_PID, [BLDG_NORM.id]);
assert(JSON.stringify(normBldgOptions) === JSON.stringify([]), 'BLDG_NORM has no saved options in the fixture');
// No project option exists for BLDG_NORM either way, but the join itself must resolve (proven by
// exercising emBuildSetpointExportRows with the BLDG_NORM id filter and getting the row back).
const normFilteredRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_NORM.id, '');
assert(
  normFilteredRows.length === 1 && normFilteredRows[0][0] === 'Fixture Middle School',
  'filtering by BLDG_NORM.id (Utility Data "Fixture Middle") returns the "Fixture Middle School" Equipment Matrix row — normalized join works',
);

// ── 7. Unknown-option request never invents an Occupied Heating/Cooling value beyond the
//      documented default (still resolves to the default, not '?', not another option's value). */
const noOptRows2 = sandbox.emBuildSetpointExportRows(FIXTURE_PID, BLDG_MATCH.id, 'Z');
assert(
  noOptRows2.every((r) => r[12] === '70' && r[13] === '74'),
  'requesting a non-existent option letter falls back to the company standard default (70/74)',
);

// ── 8. Per-heating-type Proposed Unoccupied buckets (item 1 of the 2026-09-23 fix) ────────────
const r6 = allRows.find((r) => r[0] === 'Fixture Elementary' && r[1] === 'Zone 401'); // electric reheat
assert(r6[14] === '60' && r6[15] === '85', 'electric reheat row -> Proposed Unoccupied 60/85');
const r7 = allRows.find((r) => r[1] === 'Zone 402'); // VRF
assert(r7[14] === '65' && r7[15] === '85', 'VRF/heat pump row -> Proposed Unoccupied 65/85');
const r8 = allRows.find((r) => r[1] === 'Zone 403'); // hydronic (heatSourceSupplyTemp point)
assert(
  r8[14] === '55' && r8[15] === '85',
  'hydronic hot water row (heatSourceSupplyTemp point) -> Proposed Unoccupied 55/85',
);
const r9 = allRows.find((r) => r[1] === 'Zone 404'); // unknown
assert(r9[14] === '55' && r9[15] === '85', 'unknown heating type row -> defaults to hydronic bucket (55/85)');

// ── 9. Heating-type-unknown count surfaces for the site UI (never in the exported row data).
//      Only rows with an explicit signal (heatSourceSupplyTemp point, vrf/hwp/furnace category,
//      or an "electric reheat" name) count as known; r1/r2/r3/r4/r5/r9 have none, so the default
//      bucket is still used for them but flagged unknown — this is expected on real data too,
//      since most Equipment Matrix zones carry no explicit heating-source signal. ─────────────
assert(
  allRows.unknownHeatingCount === 6,
  'six rows (r1,r2,r3,r4,r5,r9 — no heating-type signal) are flagged unknown, got ' + allRows.unknownHeatingCount,
);
assert(
  EXPECTED_HEADERS.every((h) => !h.toLowerCase().includes('unknown')),
  'headers never mention the unknown-heating-type note',
);

// ── 10. Proposed-source dialog note (item 3): names the source, never appears in export rows ──
const noteWithProject = sandbox._emSetpointExportNoteText(FIXTURE_PID, BLDG_MATCH.id, 'A');
assert(noteWithProject.indexOf('BAS Savings Calc option A') !== -1, 'note names the project option when one is used');
const noteDefaultsOnly = sandbox._emSetpointExportNoteText(FIXTURE_PID, BLDG_MISMATCH_UD.id, '');
assert(
  noteDefaultsOnly.indexOf('company standard defaults') !== -1,
  'note names company standard defaults when no project option is available',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
