// tools/test-bas-point-count-by-path.js: BAS point total counts DISTINCT points by WebCTRL Path.
// Run: node tools/test-bas-point-count-by-path.js
// Loads the real app/equipment-matrix.js into a vm sandbox. SYNTHETIC fixture only.
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
function importCsv(lines, header) {
  const text = [header || HDR].concat(lines).join(NL);
  const parsed = sandbox.emParseCSVText(text);
  const colMap = sandbox.emDetectColMap(parsed[0]);
  const groups = sandbox.emExtractEquipmentGroups(parsed.slice(1), colMap);
  const out = [];
  groups.forEach((g, k) => out.push(sandbox.emGroupToMatrixRow(k, g)));
  return out;
}
const L = '/Fixture District/Fixture School/First Floor';
function line(cp, name, val, p) {
  return [L, cp, name, val, 'BAV', '', '', '', '', '', p].join(',');
}

// 1. Exact repeat lines (same Path) count once.
let rows = importCsv([
  line('Rooftop Unit 1', 'Zone Temp', '70', '#rtu1/zt'),
  line('Rooftop Unit 1', 'Zone Temp', '70', '#rtu1/zt'),
  line('Rooftop Unit 1', 'Fan', 'On', '#rtu1/fan'),
]);
assert(rows.length === 1, 'one row');
assert(
  sandbox.emRowPointCount(rows[0]) === 2,
  'repeat line counts once: expected 2, got ' + sandbox.emRowPointCount(rows[0]),
);
assert(sandbox.emPointTotal(rows).total === 2 && sandbox.emPointTotal(rows).approxRows === 0, 'total exact, 2');

// 2. Same point name on two Paths in one control program counts twice; pointsRaw (mapping input) is unchanged.
rows = importCsv([
  line('Rooftop Unit 1', 'System Mode', '1', '#rtu1/hsmodeav'),
  line('Rooftop Unit 1', 'System Mode', 'Auto', '#rtu1/hsmodemsv'),
]);
assert(
  sandbox.emRowPointCount(rows[0]) === 2,
  'same name, two Paths: expected 2, got ' + sandbox.emRowPointCount(rows[0]),
);
assert(
  Object.keys(rows[0].pointsRaw).length === 1 && rows[0].pointsRaw['System Mode'] === 'Auto',
  'pointsRaw keeps one entry per name (mapping unchanged, last value wins)',
);

// 3. Legacy row (no pointPaths): falls back to pointsRaw count, then to points; flagged approximate.
const legacy = {
  id: 'L1',
  category: 'ahu',
  pointsRaw: { a: '1', b: '2', c: '3' },
  points: { a: '1', b: '2', c: '3', alias: '1' },
  checks: {},
};
assert(sandbox.emRowPointCount(legacy) === 3, 'legacy falls back to pointsRaw names: 3');
assert(sandbox.emRowPointCount({ points: { a: 1, b: 2 } }) === 2, 'legacy with only points: 2');
const lt = sandbox.emPointTotal([legacy]);
assert(
  lt.approxRows === 1 && /approximate until re-import/i.test(lt.title),
  'legacy total is labelled approximate until re-import',
);
assert(!/approximate/i.test(sandbox.emPointTotal(rows).title), 'exact total has no approximate label');

// 4. Re-import merge: legacy row gets paths, total becomes exact; second identical import changes nothing.
const csv = [
  line('Rooftop Unit 1', 'Zone Temp', '70', '#rtu1/zt'),
  line('Rooftop Unit 1', 'Zone Temp', '70', '#rtu1/zt'),
  line('Rooftop Unit 1', 'System Mode', '1', '#rtu1/hsmodeav'),
  line('Rooftop Unit 1', 'System Mode', 'Auto', '#rtu1/hsmodemsv'),
];
const fresh = importCsv(csv);
const legacyStored = JSON.parse(JSON.stringify(fresh));
legacyStored.forEach((r) => delete r.pointPaths);
let m = sandbox.emMergeIntoMatrix({ rows: legacyStored, buildings: [] }, importCsv(csv));
assert(m.updatedCount === 1, 'first re-import onto legacy row: 1 updated, got ' + m.updatedCount);
assert(
  sandbox.emPointTotal(m.rows).total === 3 && sandbox.emPointTotal(m.rows).approxRows === 0,
  'after re-import: exact 3 distinct points',
);
const total1 = sandbox.emPointTotal(m.rows).total;
m = sandbox.emMergeIntoMatrix(m, importCsv(csv));
assert(m.updatedCount === 0 && m.addedCount === 0, 'second identical re-import: 0 updated, got ' + m.updatedCount);
assert(sandbox.emPointTotal(m.rows).total === total1, 'second identical re-import: total unchanged');

// 5. Same equipment in two files of one import: values of the first stay, but the points of both count.
const fileA = importCsv([line('Rooftop Unit 1', 'Zone Temp', '70', '#rtu1/zt')]);
const fileB = importCsv([line('Rooftop Unit 1', 'Fan', 'On', '#rtu1/fan')]);
m = sandbox.emMergeIntoMatrix({ rows: [], buildings: [] }, fileA.concat(fileB));
assert(m.addedCount === 1 && m.ambiguousCount === 1, '2 files same equipment: 1 added, 1 ambiguous');
assert(
  sandbox.emPointTotal(m.rows).total === 2,
  'both files points count: expected 2, got ' + sandbox.emPointTotal(m.rows).total,
);
assert(!m.rows[0].pointsRaw['Fan'], 'ambiguous file does not change the stored point values (mapping input)');

// 6. No Path column: the point name is the id, so repeats still count once.
rows = importCsv(
  [
    [L, 'Rooftop Unit 1', 'Zone Temp', '70', 'BAV'].join(','),
    [L, 'Rooftop Unit 1', 'Zone Temp', '70', 'BAV'].join(','),
  ],
  'Location,Control Program,Name,Value,Type',
);
assert(sandbox.emRowPointCount(rows[0]) === 1, 'no Path column: repeat counts once');

// 7. Alias keys in points are never counted.
const alias = {
  id: 'a',
  pointsRaw: { x: '1' },
  pointPaths: ['p1'],
  points: { x: '1', outdoorAirTemp: '1', zoneStatus: '2' },
};
assert(sandbox.emRowPointCount(alias) === 1, 'alias keys not counted');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
