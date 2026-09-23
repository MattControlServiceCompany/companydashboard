// tools/test-effective-schedules-import.js — Effective Schedules CSV import regression gate (item 5ar).
// Run: node tools/test-effective-schedules-import.js
//
// Acceptance test, in Matt's own words: "we still need a way to upload the Effective Schedules
// CSV file into like the Equipment Matrix or somewhere else so we can have that data in the
// export." This test walks that real workflow against the REAL app/equipment-matrix.js source
// (loaded verbatim into a Node vm sandbox, never reimplemented):
//   1. upload an Effective Schedules CSV for a project that already has Equipment Matrix rows
//   2. schedules attach to the MATCHING equipment rows (building + control program join)
//   3. unmatched rows are reported, never silently dropped
//   4. the Setpoint & Schedule export's Existing Occupied Time/Start/Stop/Sat & Sun columns show
//      the imported schedule instead of "?"
//   5. the imported schedule survives a later BAS Points CSV re-merge (emMergeIntoMatrix)
// Uses a SYNTHETIC fixture shaped exactly like the real Woodland Spring Middle School WebCTRL
// Effective Schedules export (Location/Control Program/Effective Schedule columns, multi-line
// "Occupied from X to Y" / "Unoccupied from X to Y" cell text) — no real client data in the repo.
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

const kvStore = {};
function sget(k, fb) {
  return Object.prototype.hasOwnProperty.call(kvStore, k) ? kvStore[k] : fb;
}
function sset(k, v) {
  kvStore[k] = v;
  return Promise.resolve();
}

const FIXTURE_PID = 'fx-sched-1';

// Equipment Matrix rows already imported for this project (as if from a prior BAS Points CSV
// import) — equipName carries the FULL control program string (Milestone 2 behavior).
const emRows = [
  {
    id: 'r1',
    building: 'Fixture Middle School',
    location: '/Fixture District/Fixture Middle School/Area A',
    equipName: 'A137 North Gym RTU-15',
    category: 'rtu',
    points: {},
  },
  {
    id: 'r2',
    building: 'Fixture Middle School',
    location: '/Fixture District/Fixture Middle School/Area A',
    equipName: 'A126 Instrumental RTU-13',
    category: 'rtu',
    points: {},
  },
  {
    id: 'r3',
    building: 'Fixture Middle School',
    location: '/Fixture District/Fixture Middle School/Area B',
    equipName: 'B103 Teacher Lounge',
    category: 'zone',
    points: {},
  },
  // No equipment row exists for the "Never Matched Fan" control program below — proves
  // unmatched rows are reported, not dropped.
];

kvStore['en_eqmatrix_' + FIXTURE_PID] = { rows: emRows, importedAt: null, buildings: ['Fixture Middle School'] };

function getUDBldgs(pid) {
  return pid === FIXTURE_PID ? [{ id: 'bldg-1', name: 'Fixture Middle', meters: [] }] : [];
}
function getProjSavingsData() {
  return { measures: [], blRates: {}, basSetpoint: {} };
}
function showToast() {}

const src = fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8');
assert(src.includes('function emAttachEffectiveSchedules'), 'source contains emAttachEffectiveSchedules');
assert(src.includes('function emParseEffectiveSchedulesCSV'), 'source contains emParseEffectiveSchedulesCSV');
assert(src.includes('function _emParseScheduleBlock'), 'source contains _emParseScheduleBlock');
assert(src.includes('function emTriggerEffectiveSchedulesImport'), 'source contains the import button handler');
assert(src.includes('function emShowEffectiveSchedulesResult'), 'source reports the import result (matched/unmatched)');
assert(
  src.includes('nr.existingSchedule = old.existingSchedule || nr.existingSchedule'),
  'emMergeIntoMatrix preserves existingSchedule across a later BAS Points CSV re-import',
);

const sandbox = {
  console,
  window: {},
  document: undefined, // this test never touches DOM-only functions (emTriggerEffectiveSchedulesImport, etc.)
  sget,
  sset,
  DB: { get: sget, set: sset, isReady: () => true },
  getUDBldgs,
  getProjSavingsData,
  showToast,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app/equipment-matrix.js' });

// ── Real Woodland-shaped CSV text (synthetic building/equipment names) ──────────────────────
const CSV_TEXT =
  '"Location","Control Program","Effective Schedule"\n' +
  '"/Fixture District/Fixture Middle School/Area A","A137 North Gym RTU-15","Unoccupied from 12:00 AM to 6:00 AM\n' +
  'Occupied from 6:00 AM to 6:00 PM\n' +
  'Unoccupied from 6:00 PM to 12:00 AM"\n' +
  '"/Fixture District/Fixture Middle School/Area A","A126 Instrumental RTU-13","Unoccupied from 12:00 AM to 6:00 AM\n' +
  'Occupied from 6:00 AM to 6:00 PM\n' +
  'Unoccupied from 6:00 PM to 12:00 AM"\n' +
  '"/Fixture District/Fixture Middle School/Area C","Never Matched Fan","Unoccupied from 12:00 AM to 12:00 AM"\n';

// ── 1. Parser reads the 3 data rows correctly (header skipped, multi-line cells intact) ──────
const parsedRows = sandbox.emParseEffectiveSchedulesCSV(CSV_TEXT);
assert(parsedRows.length === 3, 'parses 3 data rows, got ' + parsedRows.length);
assert(parsedRows[0].controlProgram === 'A137 North Gym RTU-15', 'control program parses correctly');
assert(
  parsedRows[0].scheduleText.indexOf('Occupied from 6:00 AM to 6:00 PM') !== -1,
  'multi-line Effective Schedule cell text is intact',
);

// ── 2. Upload -> attach: matched rows get the schedule, unmatched rows are reported ──────────
const result = sandbox.emAttachEffectiveSchedules(FIXTURE_PID, CSV_TEXT, 'Fixture Middle Effective Schedules.csv');
assert(result.matchedCount === 2, 'matches 2 of 3 control programs (r1, r2), got ' + result.matchedCount);
assert(result.totalCount === 3, 'total parsed rows is 3');
assert(result.unmatched.length === 1, 'exactly 1 unmatched row is reported, never dropped');
assert(
  result.unmatched[0].controlProgram === 'Never Matched Fan',
  'the unmatched row names the real control program that had no Equipment Matrix row',
);

// ── 3. Matched rows carry the parsed start/stop and a human-readable schedule text ───────────
const data = sandbox.emLoadMatrix(FIXTURE_PID);
const r1 = data.rows.find((r) => r.id === 'r1');
const r3 = data.rows.find((r) => r.id === 'r3'); // never in the CSV -> must stay untouched
assert(!!r1.existingSchedule, 'r1 (matched) has existingSchedule attached');
assert(r1.existingSchedule.startStr === '6:00', 'r1 existingSchedule start is 6:00 (6:00 AM)');
assert(r1.existingSchedule.stopStr === '18:00', 'r1 existingSchedule stop is 18:00 (6:00 PM)');
assert(r1.existingScheduleImportedAt, 'r1 existingScheduleImportedAt is set (import date stored)');
assert(r1.existingScheduleFileName === 'Fixture Middle Effective Schedules.csv', 'r1 stores the source file name');
assert(!r3.existingSchedule, 'r3 (not in the CSV) is left untouched — nothing invented');

// ── 4. Setpoint & Schedule export uses the imported schedule instead of "?" ───────────────────
const spRows = sandbox.emBuildSetpointExportRows(FIXTURE_PID, '', '');
const spR1 = spRows.find((r) => r[1] === 'A137 North Gym RTU-15' || r[0] === 'Fixture Middle School');
const spRow1 = spRows[data.rows.findIndex((r) => r.id === 'r1')];
assert(spRow1[8] === 'Yes', 'Existing Occupied Time Monday-Friday is "Yes" for a matched row with an occupied block');
assert(spRow1[9] === '6:00', 'Existing Occupied Start Time Monday-Friday reads the imported 6:00 AM');
assert(spRow1[10] === '18:00', 'Existing Occupied Stop Time Monday-Friday reads the imported 6:00 PM');
assert(spRow1[11] === 'None', 'Existing Occupied Sat & Sun defaults to None (calendar default) for a matched row');
const spRow3 = spRows[data.rows.findIndex((r) => r.id === 'r3')];
assert(
  spRow3[8] === '?' && spRow3[9] === '?' && spRow3[10] === '?' && spRow3[11] === '?',
  'unmatched row (r3) still shows "?" — never invented',
);

// ── 5. Imported schedule survives a later BAS Points CSV re-merge ────────────────────────────
const reimportedRows = [
  {
    id: 'r1',
    building: 'Fixture Middle School',
    location: emRows[0].location,
    equipName: 'A137 North Gym RTU-15',
    category: 'rtu',
    points: {},
  },
];
const merged = sandbox.emMergeIntoMatrix(data, reimportedRows);
const mergedR1 = merged.rows.find((r) => r.id === 'r1');
assert(!!mergedR1.existingSchedule, 'existingSchedule survives a later BAS Points CSV re-merge');
assert(
  mergedR1.existingSchedule.startStr === '6:00',
  'preserved schedule keeps its original 6:00 start after re-merge',
);

// ── 6. Export CSV column defs include the imported schedule text (Raw View / Export CSV) ─────
const colDefs = sandbox.emGetColDefs(FIXTURE_PID);
const eschCol = colDefs.find((d) => d.key === 'existingScheduleText');
assert(!!eschCol, 'emGetColDefs includes an existingScheduleText column for the Equipment Matrix export');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
