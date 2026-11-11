'use strict';
// Tests for source and terminal units (app/air-source.js) and the "Air source" column of the room locator.
// Synthetic data only. No network, no browser.
// Run: node tools/test-air-source.js
const assert = require('assert');
const path = require('path');
const AS = require(path.join(__dirname, '..', 'app', 'air-source.js'));
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
const A = D + '/Alpha School /Roof';
const AF = D + '/Alpha School /Floor';
const B = D + '/Beta School';
const unit = (loc, name, category, withSource) => ({
  id: loc.split('/')[2].trim() + '||' + name,
  building: loc.split('/')[2].trim(),
  equipName: name,
  category,
  bacnetLocation: loc,
  pointsRaw: withSource ? { 'Air Source Static': '1.2', 'Air Source Supply': '55' } : { 'Zone Temp': '70' },
  pointPaths: ['#' + name.toLowerCase().replace(/\s+/g, '_') + '/x'],
});
const term = (loc, name, code, withSource) => {
  const r = unit(loc, name, 'vav', false);
  r.pointsRaw = withSource === false ? { 'Zone Temp': '70' } : { 'Air Source Mode': '2', 'Primary Air Source Run': 'On' };
  r.pointPaths = ['#' + code + '/airflow'];
  return r;
};
const rows = [
  unit(A, 'RTU-3', 'rtu', true),
  unit(A, 'RTU-4', 'rtu', true),
  unit(A, 'RTU-14 Kitchen', 'rtu', false),
  unit(A, 'RTU-8 Gym', 'rtu', false),
  unit(B, 'AHU-3 Lower Gym', 'ahu', true),
  term(AF, 'Classroom 1 v301', 'vav-03-01_alp'),
  term(AF, 'Classroom 2 v302', 'vav-03-02_alp'),
  term(AF, 'Classroom 3 v1401', 'vav-14-01_alp'),
  term(AF, 'Library v901', 'vav-09-01_alp'),
  term(B, 'Room G02', 'room_g02_beta'),
  term(B, 'Room G03', 'vav-03-05_beta'),
  term(B, 'Plain room', 'room_x', false),
];
const snaps = { '2026-10-29': { rows: {} }, '2026-10-30': { rows: { [A + '|RTU-8 Gym']: [], [A + '|RTU-14 Kitchen']: [] } } };
const audit = { locs: [A + '/RTU-14 Kitchen'] };
const ctx = { snaps, audit, links: null };
const key = (r) => AS.snapKey(r);
const byName = (n) => rows.find((r) => r.equipName === n);

t('classify: schedule row -> direct', () => {
  assert.strictEqual(AS.classify(byName('RTU-8 Gym'), AS.scheduledKeysOf(snaps), AS.auditLocsOf(audit)), 'direct');
});
t('classify: audit events only -> direct', () => {
  assert.strictEqual(AS.classify(byName('RTU-14 Kitchen'), {}, AS.auditLocsOf(audit)), 'direct');
});
t('classify: only the newest saved day counts', () => {
  const sk = AS.scheduledKeysOf({ '2026-10-29': { rows: { [A + '|RTU-3']: [] } }, '2026-10-30': { rows: { x: [] } } });
  assert.strictEqual(AS.classify(byName('RTU-3'), sk, {}), 'source');
});
t('classify: no schedule, no events, air source points -> source', () => {
  assert.strictEqual(AS.classify(byName('RTU-3'), AS.scheduledKeysOf(snaps), AS.auditLocsOf(audit)), 'source');
  assert.strictEqual(AS.classify(byName('AHU-3 Lower Gym'), AS.scheduledKeysOf(snaps), AS.auditLocsOf(audit)), 'source');
});
t('classify: air handler with no schedule and no air source points -> unknown', () => {
  const r = unit(B, 'Makeup Air Unit AHU', 'ahu', false);
  assert.strictEqual(AS.classify(r, AS.scheduledKeysOf(snaps), AS.auditLocsOf(audit)), 'unknown');
});
t('classify: no schedule data saved at all -> unknown (not source)', () => {
  assert.strictEqual(AS.classify(byName('RTU-3'), {}, {}), 'unknown');
});
t('classify: terminal and none', () => {
  assert.strictEqual(AS.classify(byName('Room G02'), {}, {}), 'terminal');
  assert.strictEqual(AS.classify(byName('Plain room'), {}, {}), 'none');
});
t('groupNumber reads vav-NN-MM and ignores other codes', () => {
  assert.strictEqual(AS.groupNumber(byName('Classroom 1 v301')), 3);
  assert.strictEqual(AS.groupNumber(byName('Library v901')), 9);
  assert.strictEqual(AS.groupNumber(byName('Room G02')), null);
});
t('number rule: vav-03 is fed by RTU-3 in the same building', () => {
  assert.strictEqual(AS.sourceOf(byName('Classroom 1 v301'), rows, ctx), 'RTU-3');
  assert.strictEqual(AS.sourceOf(byName('Classroom 2 v302'), rows, ctx), 'RTU-3');
});
t('number rule: the unit must be a source (RTU-14 is direct, RTU-9 is missing -> unknown)', () => {
  assert.strictEqual(AS.sourceOf(byName('Classroom 3 v1401'), rows, ctx), '');
  assert.strictEqual(AS.sourceOf(byName('Library v901'), rows, ctx), '');
});
t('number rule: only the same building', () => {
  assert.strictEqual(AS.sourceOf(byName('Room G03'), rows, ctx), 'AHU-3 Lower Gym');
});
t('no number in the code -> unknown', () => {
  assert.strictEqual(AS.sourceOf(byName('Room G02'), rows, ctx), '');
});
t('number 1 does not match RTU-14', () => {
  const extra = term(AF, 'T v101', 'vav-01-01_alp');
  const r2 = rows.concat([unit(A, 'RTU-14 Big', 'rtu', true), extra]);
  assert.strictEqual(AS.sourceOf(extra, r2, ctx), '');
});
t('stored link wins over the number rule', () => {
  const links = { links: { [byName('Classroom 1 v301').id]: { source: 'RTU-4', basis: 'confirmed' } } };
  const a = AS.analyze(rows, { snaps, audit, links });
  assert.strictEqual(a.byKey[key(byName('Classroom 1 v301'))].source, 'RTU-4');
  assert.strictEqual(a.byKey[key(byName('Classroom 1 v301'))].basis, 'confirmed');
  assert.strictEqual(a.byKey[key(byName('Classroom 2 v302'))].source, 'RTU-3');
  assert.strictEqual(a.byKey[key(byName('RTU-4'))].feeds, 1);
  assert.strictEqual(a.byKey[key(byName('RTU-3'))].feeds, 1);
});
t('stored link by location and program key fills a terminal the rule cannot link', () => {
  const links = { links: { [key(byName('Room G02'))]: { source: 'AHU-3 Lower Gym', basis: 'confirmed' } } };
  assert.strictEqual(AS.sourceOf(byName('Room G02'), rows, { snaps, audit, links }), 'AHU-3 Lower Gym');
});
t('counts', () => {
  const c = AS.analyze(rows, ctx).counts;
  assert.deepStrictEqual(c, { source: 3, terminal: 6, direct: 2, linked: 3, notLinked: 3 });
});
t('text: all cases in plain words', () => {
  const a = AS.analyze(rows, ctx).byKey;
  assert.strictEqual(AS.text(a[key(byName('RTU-8 Gym'))]).text, 'Serves its space directly');
  assert.strictEqual(AS.text(a[key(byName('RTU-3'))]).text, 'Feeds 2 terminal units');
  assert.strictEqual(AS.text(a[key(byName('RTU-4'))]).text, 'Feeds terminal units (list not known)');
  assert.strictEqual(AS.text(a[key(byName('Classroom 1 v301'))]).text, 'Fed by RTU-3');
  const nk = AS.text(a[key(byName('Room G02'))]);
  assert.strictEqual(nk.text, 'Not known');
  assert.strictEqual(nk.hint, 'The BAS data does not name its air handler');
  assert.strictEqual(AS.text(a[key(byName('Plain room'))]).text, '');
});
t('room locator: Air source column filled with context, empty without', () => {
  const find = (r) => r.groups.reduce((x, g) => x.concat(g.items), []);
  const withCtx = find(RL.search(rows, null, 'classroom 1', ctx));
  assert.strictEqual(withCtx[0].airText, 'Fed by RTU-3');
  const without = find(RL.search(rows, null, 'classroom 1'));
  assert.strictEqual(without[0].airText, '');
});

t('name rules: Area in the air handler name, shared Areas, space words with room number, unnamed source blocks the Area rule', () => {
  const H = D + '/High';
  const HA = H + "/AREA 'A' SUMMARY";
  const HB = H + "/AREA 'B' SUMMARY";
  const hs = [
    unit(H, 'AHU-7 Area A', 'ahu', true),
    unit(H, 'AHU-6 Area B', 'ahu', true),
    unit(H, 'AHU-5 Areas B, C', 'ahu', true),
    unit(H, 'AHU-8 Media Center', 'ahu', true),
    term(HA, 'Room A300', 'a300'),
    term(HA, 'Room A111 Center', 'a111c'),
    term(HA, 'Room A111 W', 'a111w'),
    term(HB, 'Room B200', 'b200'),
  ];
  const a = AS.analyze(hs, { snaps: { '2026-10-30': { rows: { x: [] } } }, audit: null, links: null }).byKey;
  const src = (nm) => a[AS.snapKey(hs.find((r) => r.equipName === nm))];
  assert.strictEqual(src('Room A300').source, 'AHU-7 Area A');
  assert.strictEqual(src('Room A300').basis, 'name');
  assert.strictEqual(src('Room A111 Center').source, 'AHU-8 Media Center');
  assert.strictEqual(src('Room A111 W').source, 'AHU-8 Media Center');
  assert.strictEqual(src('Room A111 W').basis, 'space');
  assert.strictEqual(src('Room B200').source, 'AHU-6 Area B or AHU-5 Areas B, C');
  assert.strictEqual(src('AHU-7 Area A').feeds, 1);
  const withUnnamed = hs.concat([unit(H, 'AHU-2', 'ahu', true)]);
  const b = AS.analyze(withUnnamed, { snaps: { '2026-10-30': { rows: { x: [] } } }, audit: null, links: null }).byKey;
  assert.strictEqual(b[AS.snapKey(hs[4])].source, '');
  assert.strictEqual(b[AS.snapKey(hs[6])].source, 'AHU-8 Media Center');
});
t('library counts as the media center space; leftover source takes the one remaining Area', () => {
  const H = D + '/High';
  const HA = H + "/AREA 'A' SUMMARY";
  const HG = H + "/AREA 'G' SUMMARY";
  const hs = [
    unit(H, 'AHU-7 Area A', 'ahu', true),
    unit(H, 'AHU-8 Media Center', 'ahu', true),
    unit(H, 'AHU-3 Lower Gym', 'ahu', true),
    term(HA, 'Library Office', 'lib'),
    term(HA, 'Room A300', 'a300'),
    term(HG, 'Room G02', 'g02'),
    term(HG, 'Girls Locker Room', 'glr'),
  ];
  const a = AS.analyze(hs, { snaps: { '2026-10-30': { rows: { x: [] } } }, audit: null, links: null }).byKey;
  const src = (nm) => a[AS.snapKey(hs.find((r) => r.equipName === nm))];
  assert.strictEqual(src('Library Office').source, 'AHU-8 Media Center');
  assert.strictEqual(src('Room A300').source, 'AHU-7 Area A');
  assert.strictEqual(src('Room G02').source, 'AHU-3 Lower Gym');
  assert.strictEqual(src('Room G02').basis, 'leftover');
  assert.strictEqual(src('AHU-3 Lower Gym').feeds, 2);
  const two = hs.concat([term(HA.replace("'A'", "'C'"), 'Room C1', 'c1')]);
  const b = AS.analyze(two, { snaps: { '2026-10-30': { rows: { x: [] } } }, audit: null, links: null }).byKey;
  assert.strictEqual(b[AS.snapKey(two[5])].source, '');
});
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
