'use strict';
// Tests for the "Where is it?" room locator (app/room-locator.js) and the shared area rule (BasDiff.areaOf).
// Synthetic data only. No network, no browser.
// Run: node tools/test-room-locator.js
const assert = require('assert');
const path = require('path');
const BasDiff = require(path.join(__dirname, '..', 'app', 'bas-diff.js'));
const RL = require(path.join(__dirname, '..', 'app', 'room-locator.js'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}
const D = '/Test District';
const row = (building, equipName, loc, category) => ({ building, equipName, bacnetLocation: loc, category: category || 'other' });
const rows = [
  row('Alpha High', 'Room F114', D + '/Alpha High/AREA \'F\' SUMMARY', 'fpb'),
  row('Alpha High', 'AHU-1A W Gymnasium', D + '/Alpha High/AREA \'G\' SUMMARY', 'ahu'),
  row('Alpha High', 'AHU-3 Lower Gym', D + '/Alpha High', 'ahu'),
  row('Alpha High', 'Library Office', D + '/Alpha High/AREA \'A\' SUMMARY', 'fpb'),
  row('Beta Middle', 'Math 114', D + '/Beta Middle/Area A'),
  row('Beta Middle', 'Library AHU-6 RF-3', D + '/Beta Middle/Area A', 'ahu'),
  row('Gamma Elementary', 'Classroom 114 v105 2419 : 15', D + '/Gamma Elementary School /First Floor/Area A', 'vav'),
  row('Delta Grove', 'Classroom A114', D + '/Delta Grove'),
  row('Delta Grove', 'North Gym RTU-3', D + '/Delta Grove', 'rtu'),
  row('Delta Grove', 'Room 214', D + '/Delta Grove/Roof'),
];
const flat = (r) => r.groups.reduce((a, g) => a.concat(g.items), []);

t('areaOf: no area, one area, floor and area, trailing space', () => {
  assert.strictEqual(BasDiff.areaOf(D + '/Alpha High'), '');
  assert.strictEqual(BasDiff.areaOf(D + '/Alpha High/Area A'), 'Area A');
  assert.strictEqual(BasDiff.areaOf(D + '/Gamma Elementary School /First Floor/Area A'), 'First Floor / Area A');
  assert.strictEqual(BasDiff.areaOf(''), '');
});
t('114 finds four buildings (and Roof room 214 is not a hit)', () => {
  const r = RL.search(rows, null, '114');
  assert.deepStrictEqual(r.groups.map((g) => g.building), ['Alpha High', 'Beta Middle', 'Delta Grove', 'Gamma Elementary School']);
  assert.strictEqual(r.total, 4);
  const byName = {};
  flat(r).forEach((i) => (byName[i.name] = i));
  assert.strictEqual(byName['Room F114'].area, "AREA 'F' SUMMARY");
  assert.strictEqual(byName['Math 114'].area, 'Area A');
  assert.strictEqual(byName['Classroom A114'].area, 'Building level');
});
t('trailing space in a building path', () => {
  const i = flat(RL.search(rows, null, 'classroom 114')).filter((x) => x.building.indexOf('Gamma') === 0)[0];
  assert.strictEqual(i.building, 'Gamma Elementary School');
  assert.strictEqual(i.area, 'First Floor / Area A');
  assert.strictEqual(i.path, 'Test District / Gamma Elementary School / First Floor / Area A');
});
t('gym matches gym units in several buildings, case-insensitive', () => {
  const names = flat(RL.search(rows, null, 'GYM')).map((i) => i.name);
  ['AHU-1A W Gymnasium', 'AHU-3 Lower Gym', 'North Gym RTU-3'].forEach((n) => assert(names.indexOf(n) !== -1, n));
});
t('building-level row', () => {
  const i = flat(RL.search(rows, null, 'lower gym'))[0];
  assert.strictEqual(i.area, 'Building level');
});
t('library', () => {
  const names = flat(RL.search(rows, null, 'library')).map((i) => i.name);
  assert.deepStrictEqual(names.sort(), ['Library AHU-6 RF-3', 'Library Office']);
});
t('space map adds a program under its calendar space name, without a double row', () => {
  const sm = { spaces: { 'lhs main gym': { space: 'LHS Main Gym', programs: [D + '/Alpha High/AREA \'G\' SUMMARY|AHU-1A W Gymnasium', D + '/Alpha High/AREA \'G\' SUMMARY|Gym Restrooms'] } } };
  const r = RL.search(rows, sm, 'main gym');
  assert.strictEqual(r.total, 2);
  const r2 = RL.search(rows, sm, 'gymnasium');
  assert.strictEqual(r2.total, 1);
});
t('air handler note flag only when an air handler is listed', () => {
  assert.strictEqual(RL.search(rows, null, 'Math 114').hasAirHandler, false);
  assert.strictEqual(RL.search(rows, null, 'library').hasAirHandler, true);
});
t('empty search and no match', () => {
  assert.strictEqual(RL.search(rows, null, '  ').total, 0);
  assert.strictEqual(RL.search(rows, null, 'zzzz').total, 0);
});
t('a row with no path says it is not in the tree', () => {
  const r = RL.search([row('Alpha High', 'Boiler 9', '')], null, 'boiler');
  assert.strictEqual(flat(r)[0].building, 'Alpha High');
  assert(/Not in/.test(flat(r)[0].area));
});
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
