'use strict';
// Tests for scheduling group members: the members CSV, the import, and the one membership rule (BasCoverage.groupsFor / locationsFor)
// that coverage and the "What needs to change" card use. SYNTHETIC names only. Run: node tools/test-group-members.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const BD = require(path.join(ROOT, 'app', 'bas-diff.js'));
const BC = require(path.join(ROOT, 'computations', 'bas-coverage.js'));
const SA = require(path.join(ROOT, 'computations', 'sched-actions.js'));

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
const src = fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const from = src.indexOf('\nfunction emParseCSVText(');
const sb = {};
vm.createContext(sb);
vm.runInContext(src.slice(from + 1, src.indexOf('\nfunction ', from + 5)), sb);
const csv = (text) => BD.readGroupRows(sb.emParseCSVText(text));

// --- fixtures ----------------------------------------------------------------------------------
const mk = (name, days, a, b, priority) => ({ name, priority: priority || 'Normal', type: 'weekly', days, dates: [], from: '', to: '', recur: null, periods: [{ mode: 'occ', from: a, to: b }], raw: days.join(',') });
const mkU = (name, days, a, b, priority) => {
  const s = mk(name, days, a, b, priority);
  s.periods[0].mode = 'unocc';
  return s;
};
const WK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const grp = (name, schedules, members, groupMembers) => ({ building: 'Test School', group: name, schedules: schedules || [], members: members || [], groupMembers: groupMembers || [] });
const mapOf = (list) => {
  const o = {};
  list.forEach((g) => { o[g.building + '|' + g.group] = g; });
  return o;
};
const KEY_Q1 = "/Test District/Test School/AREA 'Q' SUMMARY|Room Q101 W";
const KEY_Q2 = "/Test District/Test School/AREA 'Q' SUMMARY|Room Q102";
const KEY_R1 = "/Test District/Test School/AREA 'R' SUMMARY|Room R101";
const TZ = 'America/Chicago';
const at = (ymd, h, m) => new Date(ymd + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-06:00').toISOString();
const DAY = '2026-11-11'; // Wednesday
const blocks = [[0, 300, 'unocc'], [300, 600, 'occ'], [600, 0, 'unocc']]; // BAS copy: 5 AM - 10 AM
const snaps = { [DAY]: { importedAt: DAY + 'T19:00:00Z', rows: { [KEY_Q1]: blocks, [KEY_Q2]: blocks, [KEY_R1]: blocks } } };
const map = { spaces: { 'test room q1': { space: 'Test Room Q1', programs: [KEY_Q1], confirmed: true } } };
const cov = (groups, locations, h1, h2) => BC.eventCoverage(['Club', at(DAY, h1), at(DAY, h2), 0, 'Test Room Q1'], { tz: TZ, map, snaps, groups, locations: locations || [] });
const names = (list) => list.map((g) => g.group).sort();

// --- the members CSV -------------------------------------------------------------------------------
const MEM_NEW =
  'screenshot,building,group,member,kind,source_screenshot,notes\n' +
  '1,Test School,Alpha,Beta,group,s.png,n\n' +
  '1,Test School,Alpha,Gamma,group,s.png,n\n' +
  "2,Test School,Beta,Test School / AREA 'Q' SUMMARY,equipment,s.png,n\n" +
  "3,Test School,Gamma,Test School / AREA 'R' SUMMARY / Room R101,equipment,s.png,n\n" +
  '4,Test School,Empty One,,,s.png,no members\n';
const MEM_OLD = 'building,group,member\nTest School,Alpha,Beta\nTest School,Beta,Roof / RTU-1\nTest School,Empty One,\n';

t('members CSV (new format): kind is taken from the column; an empty member row keeps an empty group', () => {
  const r = csv(MEM_NEW);
  assert.strictEqual(r.kind, 'members');
  assert.strictEqual(r.items.length, 5);
  assert.deepStrictEqual(r.items[0], { building: 'Test School', group: 'Alpha', member: 'Beta', kind: 'group' });
  assert.strictEqual(r.items[2].kind, 'equipment');
  assert.strictEqual(r.items[4].member, '');
  assert.deepStrictEqual(BD.memberCounts(r.items), { groups: 4, equipment: 2, nested: 2 });
});

t('members CSV (old format, no kind column): a member that equals another group name is a group', () => {
  const r = csv(MEM_OLD);
  assert.strictEqual(r.kind, 'members');
  assert.deepStrictEqual(r.items.map((x) => x.kind), ['group', 'equipment', 'equipment']);
});

t('a Schedule Instances report is still read as a report; other files are not read', () => {
  assert.strictEqual(csv('"Location","Priority","Description"\n"Schedule Groups:"\n').kind, 'schedules');
  assert.strictEqual(csv('a,b\n1,2\n').kind, '');
});

// --- the import ----------------------------------------------------------------------------------
const REPORT =
  '"Location","Priority","Description"\n' +
  '"Schedule Groups:"\n' +
  '"Test School / Alpha","Normal","Club Night\nMon,Tue,Wed\nOccupied from 5:00 PM to 9:00 PM"\n' +
  '"Test School / Beta","Normal","Beta Hours\nMon,Tue,Wed\nOccupied from 1:00 PM to 3:00 PM"\n';
const importWith = (stored, files, id) => {
  const rep = files.filter((f) => f.kind === 'schedules');
  const mem = files.filter((f) => f.kind === 'members');
  return BD.applyGroupsImport({
    hist: [],
    groups: stored,
    scheduleItems: [].concat(...rep.map((f) => f.items)),
    locationItems: [].concat(...rep.map((f) => f.locations)),
    memberItems: [].concat(...mem.map((f) => f.items)),
    now: '2026-11-10T12:00:00Z',
    by: 't',
    id: id || 'x',
  });
};

t('import: report and members file in one pick; both kinds are counted and stored', () => {
  const r = importWith(null, [csv(REPORT), csv(MEM_NEW)]);
  assert(!r.error);
  const g = r.groups.groups;
  assert.deepStrictEqual(g['Test School|Alpha'].members, ['Beta', 'Gamma']);
  assert.deepStrictEqual(g['Test School|Alpha'].groupMembers, ['Beta', 'Gamma']);
  assert.deepStrictEqual(g['Test School|Beta'].groupMembers, []);
  assert.strictEqual(g['Test School|Alpha'].schedules.length, 1);
  assert.deepStrictEqual(r.rec.members, { groups: 4, equipment: 2, nested: 2 });
  assert(!g['Test School|Empty One'], 'a group with no schedule and no member is not kept');
});

t('import: members-only keeps the stored schedules and locations; report-only keeps the stored members', () => {
  const first = importWith(null, [csv(REPORT), csv(MEM_NEW)]).groups;
  first.locations = [{ location: '/Test District/Test School', building: 'Test School', area: '', schedule: mk('Loc', WK, 0, 60) }];
  const membersOnly = importWith(first, [csv(MEM_NEW.replace('Beta,group', 'Beta,group'))]);
  assert.strictEqual(membersOnly.groups.groups['Test School|Alpha'].schedules.length, 1, 'schedules stay');
  assert.strictEqual(membersOnly.groups.locations.length, 1, 'locations stay');
  assert.strictEqual(membersOnly.rec.locations, 1);
  const reportOnly = importWith(first, [csv(REPORT)]);
  assert.deepStrictEqual(reportOnly.groups.groups['Test School|Alpha'].members, ['Beta', 'Gamma'], 'members stay');
  assert.strictEqual(reportOnly.groups.locations.length, 0, 'a report replaces the locations');
});

t('import: a members file replaces the members of the groups it names; other groups keep theirs', () => {
  const first = importWith(null, [csv(REPORT), csv(MEM_NEW)]).groups;
  const only = csv('building,group,member,kind\nTest School,Beta,Room Z9,equipment\n');
  const r = importWith(first, [only]);
  assert.deepStrictEqual(r.groups.groups['Test School|Beta'].members, ['Room Z9']);
  assert.deepStrictEqual(r.groups.groups['Test School|Alpha'].members, ['Beta', 'Gamma'], 'Alpha is not in the file');
});

t('import: nothing readable is refused', () => {
  assert(importWith(null, []).error);
});

// --- the one membership rule -----------------------------------------------------------------------
t('membership: an area member covers every program below it and not a sibling area', () => {
  const g = mapOf([grp('Q Group', [], ["Test School / AREA 'Q' SUMMARY"])]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), ['Q Group']);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q2)), ['Q Group']);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_R1)), []);
});

t('membership: an equipment path covers that program only; case and spacing do not matter; the district root may be written', () => {
  const g = mapOf([grp('One', [], ["test school /  area 'q' summary / ROOM Q101 w"]), grp('Two', [], ["Test District / Test School / AREA 'Q' SUMMARY / Room Q102"])]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), ['One']);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q2)), ['Two']);
});

t('membership: the short forms "<area> / <program>" and "<program>" still match', () => {
  const g = mapOf([grp('Short', [], ["AREA 'Q' SUMMARY / Room Q101 W"]), grp('Bare', [], ['Room R101'])]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), ['Short']);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_R1)), ['Bare']);
});

t('membership: nested groups, two levels', () => {
  const g = mapOf([
    grp('Top', [], ['Middle'], ['Middle']),
    grp('Middle', [], ['Leaf'], ['Leaf']),
    grp('Leaf', [], ["Test School / AREA 'Q' SUMMARY"]),
    grp('Other', [], ["Test School / AREA 'R' SUMMARY"]),
  ]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), ['Leaf', 'Middle', 'Top']);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_R1)), ['Other']);
});

t('membership: a cycle A -> B -> A ends and lists each group once', () => {
  const g = mapOf([grp('A', [], ['B', "Test School / AREA 'Q' SUMMARY"], ['B']), grp('B', [], ['A'], ['A'])]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), ['A', 'B']);
  const self = mapOf([grp('S', [], ['S', "Test School / AREA 'Q' SUMMARY"], ['S'])]);
  assert.deepStrictEqual(names(BC.groupsFor(self, KEY_Q1)), ['S']);
});

t('membership: a member listed as a group is never matched as a path', () => {
  const g = mapOf([grp('Holder', [], ['Room Q101 W'], ['Room Q101 W'])]);
  assert.deepStrictEqual(names(BC.groupsFor(g, KEY_Q1)), []);
});

// --- coverage -----------------------------------------------------------------------------------------
t('coverage: a program in two groups gets the schedules of both (10 AM - 12 PM from one, 12 PM - 2 PM from the other)', () => {
  const g = mapOf([grp('G1', [mk('Part 1', WK, 600, 720)], ["Test School / AREA 'Q' SUMMARY"]), grp('G2', [mk('Part 2', WK, 720, 840)], ['Room Q101 W'])]);
  assert.strictEqual(cov(g, [], 11, 13).status, 'covered', 'only the two together cover 11 AM - 1 PM');
  const one = mapOf([grp('G1', [mk('Part 1', WK, 600, 720)], ["Test School / AREA 'Q' SUMMARY"])]);
  assert.strictEqual(cov(one, [], 11, 13).status, 'short');
});

t('coverage: a Holiday period of one group beats the Normal schedule of the other (priority)', () => {
  const g = mapOf([grp('G1', [mk('Day', WK, 600, 840)], ["Test School / AREA 'Q' SUMMARY"]), grp('G2', [mkU('Closed', WK, 720, 780, 'Holiday')], ['Room Q101 W'])]);
  const c = cov(g, [], 11, 14);
  assert.strictEqual(c.status, 'short');
  assert.strictEqual(c.short, 60);
});

t('coverage: a group a program is NOT in does not cover it', () => {
  const g = mapOf([grp('Away', [mk('All day', WK, 0, 1440)], ["Test School / AREA 'R' SUMMARY"])]);
  assert.strictEqual(cov(g, [], 11, 13).status, 'short');
});

t('coverage: a location schedule on a parent area covers a child program; one on a sibling area does not', () => {
  const area = [{ location: "/Test District/Test School/AREA 'Q' SUMMARY", building: 'Test School', area: "AREA 'Q' SUMMARY", schedule: mk('Area hours', WK, 600, 840) }];
  const sib = [{ location: "/Test District/Test School/AREA 'R' SUMMARY", building: 'Test School', area: "AREA 'R' SUMMARY", schedule: mk('Area hours', WK, 600, 840) }];
  const bld = [{ location: '/Test District/Test School', building: 'Test School', area: '', schedule: mk('Building hours', WK, 600, 840) }];
  assert.strictEqual(cov({}, area, 11, 13).status, 'covered');
  assert.strictEqual(cov({}, sib, 11, 13).status, 'short');
  assert.strictEqual(cov({}, bld, 11, 13).status, 'covered');
  assert.deepStrictEqual(BC.locationsFor(area, KEY_Q1), [0]);
  assert.deepStrictEqual(BC.locationsFor(area, KEY_R1), []);
});

t('coverage: location and group schedules are read together, priority applies across them', () => {
  const g = mapOf([grp('G1', [mk('Day', WK, 600, 840)], ['Room Q101 W'])]);
  const hol = [{ location: '/Test District/Test School', building: 'Test School', area: '', schedule: mkU('Holiday closed', WK, 720, 780, 'Holiday') }];
  assert.strictEqual(cov(g, hol, 11, 14).short, 60);
});

// --- unknown members -------------------------------------------------------------------------------
t('unknown: a group with no saved members and a schedule that spans the event -> status unknown with the label; not a to-do', () => {
  const g = mapOf([grp('No List', [mk('Late Club', WK, 600, 1260)], [])]);
  const c = cov(g, [], 17, 20);
  assert.strictEqual(c.status, 'unknown');
  assert.strictEqual(c.label, 'Probably covered by No List: Late Club, Mon,Tue,Wed,Thu,Fri, 10:00 AM-9:00 PM. Group members are not saved; import them to confirm.');
  const input = { events: { e1: ['Club', at(DAY, 17), at(DAY, 20), 0, 'Test Room Q1'] }, map, snaps, groups: g, locations: [], tz: TZ, today: DAY, from: DAY, to: DAY };
  assert.strictEqual(SA.periodNeeds(input).length, 0, 'no to-do');
  const u = SA.periodUnknown(input);
  assert.strictEqual(u.length, 1);
  assert.strictEqual(u[0].group, 'No List');
  assert.strictEqual(SA.periodView(Object.assign({ rows: Object.values(input.events) }, input)).status.unknown, 1);
});

t('unknown: not when the schedule does not span the event, or another building, or the group has members', () => {
  assert.strictEqual(cov(mapOf([grp('No List', [mk('Short', WK, 600, 1080)], [])]), [], 17, 20).status, 'short');
  const other = grp('No List', [mk('Late Club', WK, 600, 1260)], []);
  other.building = 'Other School';
  assert.strictEqual(cov(mapOf([other]), [], 17, 20).status, 'short');
  assert.strictEqual(cov(mapOf([grp('Has List', [mk('Late Club', WK, 600, 1260)], ['Room R101'])]), [], 17, 20).status, 'short');
});

// --- room number -> Area -------------------------------------------------------------------------------
const roomInput = (title, extra) =>
  Object.assign(
    { events: { e1: [title, at(DAY, 17), at(DAY, 18), 0, 'Test Room Q1'] }, map, snaps, groups: {}, locations: [], tz: TZ, today: DAY, from: DAY, to: DAY },
    extra || {},
  );

t('room number: "Room 101" names one Room <letter>101 in the building -> "Room 101 = Area Q (Room Q101 W)"', () => {
  const snapOne = { [DAY]: { rows: { [KEY_Q1]: blocks, [KEY_R1.replace('R101', 'R202')]: blocks } } };
  const lines = SA.roomLines(roomInput('Club in Room 101', { snaps: snapOne }), Object.values(roomInput('Club in Room 101').events));
  assert.deepStrictEqual(lines, ['Room 101 = Area Q (Room Q101 W)']);
});

t('room number: "Rm 101" in the location works; several matches are all listed; no match gives no line', () => {
  const both = SA.roomLines(roomInput('Club'), [['Club', at(DAY, 17), at(DAY, 18), 0, 'TS Rm 101']]);
  assert.deepStrictEqual(both, ['Room 101 = Area Q (Room Q101 W) or Area R (Room R101)']);
  assert.deepStrictEqual(SA.roomLines(roomInput('Club'), [['Club in Room 999', at(DAY, 17), at(DAY, 18), 0, 'Test Room Q1']]), []);
  assert.deepStrictEqual(SA.roomLines(roomInput('Club'), [['Club', at(DAY, 17), at(DAY, 18), 0, 'Test Room Q1']]), []);
});

t('room number: Equipment Matrix rows (matrixRooms) count like programs', () => {
  const lines = SA.roomLines(roomInput('Club in Room 305', { matrixRooms: [{ location: "/Test District/Test School/AREA 'S' SUMMARY", name: 'Room S305' }] }), [['Club in Room 305', at(DAY, 17), at(DAY, 18), 0, 'Test Room Q1']]);
  assert.deepStrictEqual(lines, ['Room 305 = Area S (Room S305)']);
});

t('card: a to-do line carries the Area in Where and the room line', () => {
  const pn = SA.periodNeeds(roomInput('Club in Room 101'));
  assert.strictEqual(pn.length, 1);
  assert.strictEqual(pn[0].where, 'Test School / Area Q / Room Q101 W');
  assert.strictEqual(pn[0].rooms.length, 1);
  assert(/^Room 101 = /.test(pn[0].rooms[0]), pn[0].rooms[0]);
});

t('one BAS context: both calendar tables use pcalBasCtx (groups and locations included), no second copy', () => {
  const pc = fs.readFileSync(path.join(ROOT, 'app', 'project-calendar.js'), 'utf8');
  const dc = fs.readFileSync(path.join(ROOT, 'app', 'district-calendar.js'), 'utf8');
  assert(/function basCtxFor\(pid, tz\)[\s\S]{0,400}groups: bg\.groups[\s\S]{0,80}locations: bg\.locations/.test(pc), 'basCtxFor reads groups and locations');
  assert.strictEqual((pc.match(/en_bas_snap_/g) || []).length, 1, 'project-calendar.js reads the BAS copies in basCtxFor only');
  assert(!/en_bas_snap_/.test(dc), 'district-calendar.js builds no BAS context of its own');
  assert.strictEqual((dc.match(/pcalBasCtx\(projId/g) || []).length, 2, 'both manual-table paths use pcalBasCtx');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
