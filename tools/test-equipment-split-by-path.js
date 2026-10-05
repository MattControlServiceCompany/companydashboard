// tools/test-equipment-split-by-path.js: same-name equipment under different WebCTRL paths is split into
// separate Equipment Matrix rows (item f329c4c6). Run: node tools/test-equipment-split-by-path.js
// Loads the real app/equipment-matrix.js into a vm sandbox. SYNTHETIC fixture only.
// Rules under test: a unique name keeps the plain id; a shared name splits by full path; the stored row
// that owns the plain id keeps it (and all user data) if its stored path is one of the paths, else the
// lowest path takes it; re-import is stable and independent of CSV order; nothing is deleted or copied.
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
const sandbox = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => (Object.prototype.hasOwnProperty.call(kvStore, k) ? kvStore[k] : fb),
  sset: (k, v) => ((kvStore[k] = v), Promise.resolve()),
  DB: { get() {}, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8'), sandbox, {
  filename: 'app/equipment-matrix.js',
});

const NL = String.fromCharCode(10);
const HDR = 'Location,Control Program,Name,Value,Type,COV Increment,I/O Type,Sensor/Actuator Type,Min/Max,Locked,Path';
const BASE = '/Fixture District/Fixture School/';
const P1 = BASE + 'Penthouse A';
const P2 = BASE + 'Penthouse C';
function line(loc, cp, name, val, p) {
  return [loc, cp, name, val, 'BAV', '', '', '', '', '', p].join(',');
}
// storedRows: rows already in the stored matrix (optional)
function importCsv(lines, storedRows) {
  const text = [HDR].concat(lines).join(NL);
  const parsed = sandbox.emParseCSVText(text);
  const colMap = sandbox.emDetectColMap(parsed[0]);
  const groups = sandbox.emExtractEquipmentGroups(parsed.slice(1), colMap, storedRows || []);
  const out = [];
  groups.forEach((g, k) => out.push(sandbox.emGroupToMatrixRow(k, g)));
  return out;
}
const CSV = [
  line(BASE + 'Roof', 'AHU-1', 'Supply Temp', '55', '#ahu1/st'),
  line(P1, 'UH-4', 'Space Temp', '70', '#a/uh4/st'),
  line(P1, 'UH-4', 'Fan Status', 'On', '#a/uh4/fan'),
  line(P2, 'UH-4', 'Space Temp', '65', '#c/uh4/st'),
  line(P2, 'UH-4', 'Fan Status', 'Off', '#c/uh4/fan'),
];
const ids = (rows) => rows.map((r) => r.id).sort();
const byLoc = (rows, p) => rows.find((r) => r.bacnetLocation === p);

// 1. Fresh import: unique name keeps plain id; shared name splits in two; lowest path owns plain id.
let rows = importCsv(CSV);
assert(rows.length === 3, 'fresh import: 3 rows (AHU-1 + 2 x UH-4), got ' + rows.length);
assert(
  rows.some((r) => r.id === 'Fixture School||AHU-1'),
  'unique name keeps plain id',
);
assert(byLoc(rows, P1) && byLoc(rows, P1).id === 'Fixture School||UH-4', 'lowest path owns the plain id');
assert(byLoc(rows, P2) && byLoc(rows, P2).id === 'Fixture School||UH-4||@' + P2, 'other path gets ||@path id');
assert(byLoc(rows, P1) && byLoc(rows, P1).pointsRaw['Space Temp'] === '70', 'path A holds its own value');
assert(
  byLoc(rows, P2) && byLoc(rows, P2).pointsRaw['Space Temp'] === '65',
  'path C holds its own value, not last-written on both',
);

// 2. Order independence.
const rev = importCsv(CSV.slice().reverse());
assert(JSON.stringify(ids(rev)) === JSON.stringify(ids(rows)), 'reversed CSV order gives identical ids');
assert(
  byLoc(rev, P2) && byLoc(rev, P2).pointsRaw['Space Temp'] === '65',
  'reversed order: values stay on their own path',
);

// 3. Stored merged row with user data, stored path = P2 (stored path claims the plain id even though P1 sorts first).
const stored = {
  rows: [
    {
      id: 'Fixture School||AHU-1',
      building: 'Fixture School',
      equipName: 'AHU-1',
      category: 'ahu',
      bacnetLocation: BASE + 'Roof',
      points: {},
      pointsRaw: { 'Supply Temp': '55' },
      checks: {},
      notes: 'keep AHU',
    },
    {
      id: 'Fixture School||UH-4',
      building: 'Fixture School',
      equipName: 'UH-4',
      category: 'unit-heater',
      bacnetLocation: P2,
      points: {},
      pointsRaw: { 'Space Temp': '65', 'Fan Status': 'Off' },
      checks: {},
      notes: 'user note on UH-4',
      editedAt: '2026-10-01T00:00:00Z',
    },
  ],
  edits: { 'Fixture School||UH-4::config': { hasVfd: true } },
  buildings: [],
};
const editsBefore = JSON.stringify(stored.edits);
const incoming = importCsv(CSV, stored.rows);
assert(byLoc(incoming, P2) && byLoc(incoming, P2).id === 'Fixture School||UH-4', 'stored path P2 keeps the plain id');
assert(byLoc(incoming, P1) && byLoc(incoming, P1).id === 'Fixture School||UH-4||@' + P1, 'P1 becomes the sibling');
const merged = sandbox.emMergeIntoMatrix(stored, incoming);
assert(merged.rows.length === 3, 'after import: exactly +1 row (3 total), got ' + merged.rows.length);
assert(merged.addedCount === 1, 'added count 1, got ' + merged.addedCount);
const claimed = merged.rows.find((r) => r.id === 'Fixture School||UH-4');
assert(
  claimed && claimed.notes === 'user note on UH-4' && claimed.editedAt === '2026-10-01T00:00:00Z',
  'claimed row keeps notes and editedAt',
);
assert(JSON.stringify(merged.edits) === editsBefore, 'edits store unchanged');
const sib = merged.rows.find((r) => r.id === 'Fixture School||UH-4||@' + P1);
assert(
  sib && !sib.notes && sib.pointsRaw['Space Temp'] === '70',
  'sibling starts empty (no copied notes) with its own values',
);
assert(merged.rows.find((r) => r.id === 'Fixture School||AHU-1').notes === 'keep AHU', 'unique-name row untouched');

// 4. Second import of the same CSV: nothing added, nothing updated.
const again = sandbox.emMergeIntoMatrix(merged, importCsv(CSV, merged.rows));
assert(
  again.rows.length === 3 && again.addedCount === 0 && again.updatedCount === 0,
  'second import: 0 added, 0 updated, got +' + again.addedCount + '/~' + again.updatedCount,
);
assert(
  again.rows.find((r) => r.id === 'Fixture School||UH-4').notes === 'user note on UH-4',
  'notes survive second import',
);

// 5. Stored path matches none (moved): lowest path takes the plain id.
const mv = importCsv(CSV, [Object.assign({}, stored.rows[1], { bacnetLocation: BASE + 'Gone' })]);
assert(
  byLoc(mv, P1) && byLoc(mv, P1).id === 'Fixture School||UH-4',
  'no stored path match: lowest path takes plain id',
);

// 6. Total distinct points: sum over paths, no double count.
const total = sandbox.emPointTotal(rows).total;
assert(total === 5, 'distinct points = 1 + 2 + 2 = 5, got ' + total);

// 6b. Effective Schedules: a schedule for one path attaches to that path's row only.
kvStore['en_eqmatrix_fx-split'] = JSON.parse(JSON.stringify(merged));
const schedCsv =
  '"Location","Control Program","Effective Schedule"' +
  NL +
  '"' + P1 + '","UH-4","Occupied from 6:00 AM to 6:00 PM"' +
  NL;
const sres = sandbox.emAttachEffectiveSchedules('fx-split', schedCsv, 'fx.csv');
const after = kvStore['en_eqmatrix_fx-split'].rows;
assert(sres.matchedCount === 1, 'schedule attaches to one row, got ' + sres.matchedCount);
assert(
  after.find((r) => r.id === 'Fixture School||UH-4||@' + P1).existingSchedule &&
    !after.find((r) => r.id === 'Fixture School||UH-4').existingSchedule,
  'schedule lands on the matching path only',
);

// 7. Audit consolidation key includes building and path (source check; report-engine needs the full app to run).
const re = fs.readFileSync(path.join(REPO, 'app/report-engine.js'), 'utf8');
const seg = (re.split('Same-name consolidation')[1] || '').slice(0, 2500);
assert(
  /var key = [^;]*building[^;]*bacnetLocation[^;]*;/.test(seg),
  'audit same-name consolidation key includes building and path',
);

console.log(failed ? 'FAILED ' + failed + ' / ' + (passed + failed) : 'PASS ' + passed + ' checks');
process.exit(failed ? 1 : 0);
