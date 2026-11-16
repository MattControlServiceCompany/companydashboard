'use strict';
// Set Points schedule column: an empty zone schedule shows the schedule of the WebCTRL scheduling group(s) of the zone's equipment
// (display only; BasCoverage.groupsFor is the membership rule, BasDiff.scheduleText the formatter). SYNTHETIC names only.
// Run: node tools/test-setpoints-group-schedule.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const BasDiff = require(path.join(ROOT, 'app', 'bas-diff.js'));
const BasCoverage = require(path.join(ROOT, 'computations', 'bas-coverage.js'));
let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + (e && e.message)); }
}
const src = fs.readFileSync(path.join(ROOT, 'app', 'graphics-setpoints.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('var _spGroupSchedules');
const b = src.indexOf('  return `<tr style', a);
const slice = src.slice(a, b);
const mk = (name, from, to) => ({ name, priority: 'Normal', type: 'weekly', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], dates: [], from: '', to: '', recur: null, periods: [{ mode: 'occ', from, to }], raw: 'Mon,Tue,Wed,Thu,Fri' });
const grp = (name, schedules, members) => ({ building: 'Test School', group: name, schedules, members: members || [], groupMembers: [] });
const P = '/Test District/Test School/AREA \'Q\' SUMMARY';
const rows = [
  { building: 'Test School', location: 'Room Q101', equipName: 'Room Q101', bacnetLocation: P },
  { building: 'Test School', location: 'Room Q102', equipName: 'Room Q102', bacnetLocation: P },
  { building: 'Test School', location: 'Room Q103', equipName: 'Room Q103', bacnetLocation: P },
  { building: 'Other School', location: 'Room Q101', equipName: 'Room Q101', bacnetLocation: P },
];
const store = { en_bas_groups_p1: { importedAt: '2026-11-01T10:00:00Z', groups: {} } };
const sb = {
  BasCoverage, BasDiff,
  DB: { get: (k, d) => (store[k] === undefined ? d : store[k]) },
  getUDBldgs: () => [{ id: 'b1', name: 'Test School' }],
  _emNormBldgNameForJoin: (n) => String(n || '').toLowerCase().trim(),
  emLoadMatrix: () => ({ rows }),
  _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
};
vm.createContext(sb);
vm.runInContext(slice.slice(0, slice.indexOf('function _spZoneRow')), sb);
const map = () => sb._spGroupScheduleMap('p1', 'b1');
const setGroups = (list) => { const o = {}; list.forEach((g) => { o[g.building + '|' + g.group] = g; }); store.en_bas_groups_p1.groups = o; };

t('one group: its schedule text, group name, import date in the hover', () => {
  setGroups([grp('Group A', [mk('Day', 420, 960)], ['Test School / AREA \'Q\' SUMMARY'])]);
  const m = map();
  assert.strictEqual(m['Room Q101'].text, '(from WebCTRL group Group A) ' + BasDiff.scheduleText(mk('Day', 420, 960)));
  assert(/Group A/.test(m['Room Q101'].hover) && /2026-11-01/.test(m['Room Q101'].hover));
});
t('a zone of another building gets nothing', () => {
  assert.strictEqual(Object.keys(map()).length, 3);
});
t('a zone outside every group gets nothing (keeps No schedule imported)', () => {
  setGroups([grp('Group B', [mk('Day', 420, 960)], ["Test School / AREA 'Q' SUMMARY / Room Q101"])]);
  const m = map();
  assert(m['Room Q101'] && !m['Room Q102'] && !m['Room Q103']);
});
t('two groups with different schedules: Several schedules, list in the hover', () => {
  setGroups([grp('Group A', [mk('Day', 420, 960)], ["Test School / AREA 'Q' SUMMARY / Room Q101"]), grp('Group C', [mk('Late', 1020, 1260)], ["Test School / AREA 'Q' SUMMARY / Room Q101"])]);
  const m = map();
  assert.strictEqual(m['Room Q101'].text, 'Several schedules');
  assert(/Group A: /.test(m['Room Q101'].hover) && /Group C: /.test(m['Room Q101'].hover) && /5:00 PM/.test(m['Room Q101'].hover));
});
t('two groups with the same schedule: one text, both names', () => {
  setGroups([grp('Group A', [mk('Day', 420, 960)], ["Test School / AREA 'Q' SUMMARY / Room Q101"]), grp('Group D', [mk('Day', 420, 960)], ["Test School / AREA 'Q' SUMMARY / Room Q101"])]);
  assert(/^\(from WebCTRL group Group A, Group D\) /.test(map()['Room Q101'].text));
});
t('a schedule that never runs is not shown; a group with only such schedules is left out', () => {
  const off = Object.assign(mk('Off', 390, 960), { days: [] });
  setGroups([grp('Group A', [mk('Day', 420, 960), off], ["Test School / AREA 'Q' SUMMARY / Room Q101"]), grp('Group E', [off], ["Test School / AREA 'Q' SUMMARY / Room Q101", "Test School / AREA 'Q' SUMMARY / Room Q102"])]);
  const m = map();
  assert.strictEqual(m['Room Q101'].text, '(from WebCTRL group Group A) ' + BasDiff.scheduleText(mk('Day', 420, 960)));
  assert(!m['Room Q102'], 'only an inactive group: no schedule shown');
});
t('no groups imported: empty map', () => {
  setGroups([]);
  assert.strictEqual(Object.keys(map()).length, 0);
});
t('display only: the row template reads the map and writes no zone field', () => {
  const row = src.slice(src.indexOf('function _spZoneRow'), src.indexOf('function _spComputeAvgRow'));
  assert(/_spGroupSchedules\[/.test(row) && !/z\.schedule\s*=/.test(row));
  assert(!/z\.schedule\s*=/.test(slice));
});
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
