'use strict';
// Tests for the BAS schedule import: the CSV reader (multi-line cells), the one comparison (app/bas-diff.js),
// the choice of the earlier copy, the date rule, and the scheduling groups import.
// Synthetic data only (fake building and program names). No network, no browser.
// Run: node tools/test-bas-diff.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BasDiff = require(path.join(ROOT, 'app', 'bas-diff.js'));

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

// --- load the real CSV reader and block reader out of app/equipment-matrix.js (no copy) --------------
const src = fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
function fnSource(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  assert(start >= 0, 'function not found: ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 3);
}
const sandbox = {};
vm.createContext(sandbox);
['emParseCSVText', '_emFormatClockFromMinutes', 'emParseEffectiveSchedulesCSV', '_emParseClock12h', '_emScheduleBlocks'].forEach((n) =>
  vm.runInContext(fnSource(n), sandbox),
);
const parseCsv = (txt) => sandbox.emParseEffectiveSchedulesCSV(txt);
const blocksOf = (txt) => sandbox._emScheduleBlocks(txt);

// --- synthetic export (fake names) ---------------------------------------------------------------------
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
function cell(start, stop) {
  return 'Unoccupied from 12:00 AM to ' + start + '\nOccupied from ' + start + ' to ' + stop + '\nUnoccupied from ' + stop + ' to 12:00 AM';
}
function csv(rows) {
  return (
    '"Location","Control Program","Effective Schedule"\r\n' +
    rows.map((r) => [q(r[0]), q(r[1]), q(r[2])].join(',') + '\r\n').join('') +
    ',,\r\n\r\n'
  );
}
const ALPHA = '/Test District/Alpha School/Wing A';
const BETA = '/Test District/Beta School/Wing B';
const alphaRows = [
  [ALPHA, 'Room 1', cell('6:00 AM', '4:00 PM')],
  [ALPHA, 'Room 2', cell('6:00 AM', '4:00 PM')],
  [ALPHA, 'Gym', cell('5:00 AM', '9:00 PM')],
];
const betaRows = [[BETA, 'Hall', cell('7:00 AM', '3:30 PM')]];

function doImport(state, text, forDate, n) {
  const rows = BasDiff.rowsFromParsed(parseCsv(text), blocksOf);
  return BasDiff.applyScheduleImport({
    snaps: state.snaps,
    hist: state.hist,
    rows,
    forDate,
    now: '2026-10-29T15:41:00.000Z',
    by: 'Test User',
    id: 'bash_t' + n,
  });
}
function run(steps) {
  let state = { snaps: {}, hist: [] };
  const recs = [];
  steps.forEach((s, i) => {
    const r = doImport(state, s[0], s[1], i);
    assert(!r.error, 'import ' + i + ' failed: ' + r.error);
    state = { snaps: r.snaps, hist: r.hist };
    recs.push(r.rec);
  });
  return { state, recs };
}

t('parse: multi-line quoted cell gives 3 blocks, blank trailing rows are skipped', () => {
  const p = parseCsv(csv(alphaRows));
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(blocksOf(p[0].scheduleText))), [
    [0, 360, 'unocc'],
    [360, 960, 'occ'],
    [960, 0, 'unocc'], // 12:00 AM is minute 0
  ]);
});

t('building comes from the second part of the Location path', () => {
  assert.strictEqual(BasDiff.buildingOf(ALPHA), 'Alpha School');
  assert.strictEqual(BasDiff.buildingOf('/Test District/Gamma School '), 'Gamma School');
  assert.deepStrictEqual(BasDiff.buildingCounts(BasDiff.rowsFromParsed(parseCsv(csv(alphaRows.concat(betaRows))), blocksOf)), {
    'Alpha School': 3,
    'Beta School': 1,
  });
});

t('same row twice in a file keeps both rows', () => {
  const rows = BasDiff.rowsFromParsed(parseCsv(csv([alphaRows[0], alphaRows[0]])), blocksOf);
  assert.strictEqual(Object.keys(rows).length, 2);
});

t('date is required and must be a real date', () => {
  const rows = BasDiff.rowsFromParsed(parseCsv(csv(alphaRows)), blocksOf);
  ['', undefined, '2026-13-01', '10/29/2026', '2026-02-30'].forEach((d) => {
    const r = BasDiff.applyScheduleImport({ snaps: {}, hist: [], rows, forDate: d, now: 'x', by: 'a', id: 'i' });
    assert(r.error, 'accepted date ' + d);
    assert(!r.snaps);
  });
});

t('first import: one snapshot, one first record, nothing to compare', () => {
  const { state, recs } = run([[csv(alphaRows), '2026-10-29']]);
  assert.deepStrictEqual(Object.keys(state.snaps), ['2026-10-29']);
  assert.strictEqual(state.snaps['2026-10-29'].importedBy, 'Test User');
  assert.strictEqual(recs[0].first, true);
  assert.strictEqual(recs[0].counts.total, 3);
});

t('same file twice for the same date = 0 changes', () => {
  const { recs } = run([[csv(alphaRows), '2026-10-29'], [csv(alphaRows), '2026-10-29']]);
  assert.strictEqual(recs[1].first, false);
  assert.deepStrictEqual([recs[1].counts.added, recs[1].counts.removed, recs[1].counts.changed, recs[1].counts.unchanged], [0, 0, 0, 3]);
});

t('same file for the next day = 0 changes (compared with the same day type)', () => {
  const { recs } = run([[csv(alphaRows), '2026-10-29'], [csv(alphaRows), '2026-10-30']]);
  assert.strictEqual(recs[1].comparedTo, '2026-10-29');
  assert.strictEqual(recs[1].counts.changed + recs[1].counts.added + recs[1].counts.removed, 0);
});

t('one edited row = 1 changed, with old and new times', () => {
  const edited = alphaRows.map((r) => r.slice());
  edited[2][2] = cell('5:00 AM', '10:00 PM');
  const { state, recs } = run([[csv(alphaRows), '2026-10-29'], [csv(edited), '2026-10-30']]);
  const c = recs[1].counts;
  assert.deepStrictEqual([c.changed, c.added, c.removed, c.unchanged], [1, 0, 0, 2]);
  const x = recs[1].changed[0];
  assert.strictEqual(BasDiff.keyBuilding(x.key), 'Alpha School');
  assert.strictEqual(BasDiff.blocksText(x.before), 'Occupied 5:00 AM - 9:00 PM');
  assert.strictEqual(BasDiff.blocksText(x.after), 'Occupied 5:00 AM - 10:00 PM');
  assert.deepStrictEqual(recs[1].byBuilding['Alpha School'], { added: 0, removed: 0, changed: 1 });
  assert.strictEqual(state.hist.length, 2);
  assert.strictEqual(state.hist[0].id, 'bash_t1', 'newest first');
});

t('added and removed programs are listed', () => {
  const next = alphaRows.slice(1).concat([[ALPHA, 'Room 9', cell('6:00 AM', '4:00 PM')]]);
  const { recs } = run([[csv(alphaRows), '2026-10-29'], [csv(next), '2026-10-30']]);
  assert.strictEqual(recs[1].counts.added, 1);
  assert.strictEqual(recs[1].counts.removed, 1);
  assert(/Room 9/.test(recs[1].added[0].key));
  assert(/Room 1/.test(recs[1].removed[0].key));
});

t('buildings imported on the same date merge; another building does not show as removed', () => {
  const { state, recs } = run([[csv(alphaRows), '2026-10-29'], [csv(betaRows), '2026-10-29']]);
  assert.strictEqual(Object.keys(state.snaps['2026-10-29'].rows).length, 4);
  assert.strictEqual(recs[1].first, true, 'Beta has no earlier copy');
  assert.strictEqual(recs[1].counts.removed, 0);
});

t('importing one building again replaces that building only', () => {
  const edited = [[BETA, 'Hall', cell('7:00 AM', '4:00 PM')]];
  const { state, recs } = run([[csv(alphaRows.concat(betaRows)), '2026-10-29'], [csv(edited), '2026-10-29']]);
  assert.strictEqual(Object.keys(state.snaps['2026-10-29'].rows).length, 4);
  assert.strictEqual(recs[1].counts.changed, 1);
  assert.strictEqual(recs[1].counts.total, 1);
});

t('earlier copy: same day type first, else latest other', () => {
  const snaps = { '2026-10-23': { forDate: '2026-10-23', rows: {} }, '2026-10-24': { forDate: '2026-10-24', rows: {} }, '2026-10-25': { forDate: '2026-10-25', rows: {} } };
  assert.strictEqual(BasDiff.pickBaseline(snaps, '2026-10-30').forDate, '2026-10-23'); // Fri vs Fri
  assert.strictEqual(BasDiff.pickBaseline(snaps, '2026-10-31').forDate, '2026-10-24'); // Sat vs Sat
  assert.strictEqual(BasDiff.pickBaseline({ '2026-10-23': snaps['2026-10-23'] }, '2026-10-31').forDate, '2026-10-23'); // none of type
  assert.strictEqual(BasDiff.pickBaseline({}, '2026-10-31'), null);
  assert.strictEqual(BasDiff.dayType('2026-10-29'), 'weekday');
});

t('history keeps 50 records', () => {
  let state = { snaps: {}, hist: [] };
  for (let i = 0; i < 55; i++) {
    const r = doImport(state, csv(alphaRows), '2026-10-29', i);
    state = { snaps: r.snaps, hist: r.hist };
  }
  assert.strictEqual(state.hist.length, 50);
});

// --- scheduling groups ---------------------------------------------------------------------------------
// Synthetic WebCTRL Schedules report: made-up names only. Continuation rows keep the odd '"" ,' spacing of the real export.
const REPORT =
  '"Location","Priority","Description"\n' +
  '"/Test District/Alpha School/Gym Wing","Normal","Open Gym\nMon,Wed\nOccupied from 4:00 PM to 6:00 PM"\n' +
  '"/Test District/Alpha School","Normal","Pole Lights\nMon,Tue,Wed,Thu,Fri,Sat,Sun\nOccupied from 4:00 AM to 7:00 AM\nOccupied from 4:45 PM to 12:00 AM"\n' +
  '"Schedule Groups:"\n' +
  '"Alpha School / Gyms","Normal","Practice A\nMon,Tue\nOccupied from 3:20 PM to 5:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Practice B\nTue,Wed\nOccupied from 5:00 PM to 8:30 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Awards Night\n11/12/2026\nOccupied from 3:00 PM to 9:00 PM"\n' +
  '"Alpha School / Lights","Normal","Lights\nMon,Tue,Wed,Thu,Fri,Sat,Sun\nOccupied from 12:00 AM to 8:00 AM\nOccupied from 4:45 PM to 12:00 AM"\n' +
  '"Beta School / Games","Override","Game Day\nEvery 2/28/* *\nOccupied from 8:00 AM to 8:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Board Meeting\nEvery 2nd */*/* Mon\nOccupied from 4:00 PM to 9:00 PM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Cheer\nWed,Thu  9/24/2026 - 2/26/2027\nOccupied from 5:00 AM to 10:00 AM"\n' +
  '"" ,"" ,"" ,"" ,"" ,"Normal","Church\n11/15/2026, 11/22/2026, 11/29/2026\nOccupied from 6:00 AM to 12:30 PM"\n' +
  '"Beta School / Energy","Holiday","Temp Unoccupied\n2/16/2026 - 12/31/2026\nUnoccupied from 12:00 AM to 5:00 AM\nUnoccupied from 3:00 PM to 12:00 AM"\n' +
  '"Beta School / Fans","Normal","Reg\nOccupied from 8:00 AM to 3:30 PM"\n';
const MEMBERS_OLD = { 'Alpha School|Gyms': { building: 'Alpha School', group: 'Gyms', schedules: [], members: ['Roof / RTU-1', 'First Floor / Room 1'] } };
function readG(txt) {
  return BasDiff.readGroupRows(sandbox.emParseCSVText(txt));
}
function gImport(stored, rep, n, hist) {
  return BasDiff.applyGroupsImport({ hist: hist, groups: stored, scheduleItems: rep.items, locationItems: rep.locations, now: '2026-10-29T16:00:00.000Z', by: 'Test User', id: 'bash_g' + n });
}
const sch = (rep, name) => rep.items.filter((x) => x.schedule.name === name)[0].schedule;

t('groups: the WebCTRL Schedules report is read: location part, group part, continuation rows', () => {
  const r = readG(REPORT);
  assert.strictEqual(r.kind, 'schedules');
  assert.strictEqual(r.locations.length, 2);
  assert.strictEqual(r.locations[0].building, 'Alpha School');
  assert.strictEqual(r.locations[0].area, 'Gym Wing');
  assert.strictEqual(r.items.length, 10);
  assert.deepStrictEqual(r.items.filter((x) => x.group === 'Gyms').map((x) => x.schedule.name), ['Practice A', 'Practice B', 'Awards Night']);
  assert.strictEqual(r.items[1].building, 'Alpha School');
  assert.strictEqual(readG(csv(alphaRows)).kind, '');
  assert.strictEqual(readG('building,group,schedule_description\nA,B,C\n').kind, '', 'the old custom columns are not read');
});

t('groups: weekly, date, range, recurring and multi-period schedules are read in full', () => {
  const r = readG(REPORT);
  const w = sch(r, 'Practice B');
  assert.deepStrictEqual([w.type, w.days, w.priority], ['weekly', ['Tue', 'Wed'], 'Normal']);
  assert.deepStrictEqual(w.periods, [{ mode: 'occ', from: 1020, to: 1230 }]);
  assert.deepStrictEqual([sch(r, 'Awards Night').type, sch(r, 'Awards Night').dates], ['date', ['2026-11-12']]);
  assert.deepStrictEqual(sch(r, 'Church').dates, ['2026-11-15', '2026-11-22', '2026-11-29']);
  const rg = sch(r, 'Cheer');
  assert.deepStrictEqual([rg.type, rg.days, rg.from, rg.to], ['range', ['Wed', 'Thu'], '2026-09-24', '2027-02-26']);
  assert.deepStrictEqual(sch(r, 'Game Day').recur, { month: 2, day: 28, nth: 0, dow: '' });
  assert.strictEqual(sch(r, 'Game Day').priority, 'Override');
  assert.deepStrictEqual(sch(r, 'Board Meeting').recur, { month: 0, day: 0, nth: 2, dow: 'Mon' });
  const lights = sch(r, 'Lights');
  assert.strictEqual(lights.periods.length, 2, 'both periods of a day are kept');
  assert.strictEqual(BasDiff.periodsText(lights), '12:00 AM-8:00 AM and 4:45 PM-12:00 AM');
  assert.strictEqual(BasDiff.whenText(lights), 'every day');
  assert.strictEqual(BasDiff.whenText(sch(r, 'Awards Night')), '11/12/2026');
  assert.strictEqual(BasDiff.whenText(rg), 'Wed,Thu 9/24/2026 - 2/26/2027');
  assert.strictEqual(BasDiff.whenText(sch(r, 'Game Day')), 'every Feb 28');
  assert.strictEqual(BasDiff.whenText(sch(r, 'Board Meeting')), '2nd Mon of every month');
});

t('groups: a weekly schedule with no day selected is not active; a date range with no weekday runs every day of the range', () => {
  const r = readG(REPORT);
  const energy = sch(r, 'Temp Unoccupied');
  assert.strictEqual(energy.type, 'range');
  assert.strictEqual(BasDiff.scheduleActive(energy), true, 'range with no weekday is active');
  assert.strictEqual(BasDiff.whenText(energy), 'every day 2/16/2026 - 12/31/2026');
  assert.strictEqual(BasDiff.scheduleAppliesOn(energy, '2026-11-12'), true);
  assert.strictEqual(BasDiff.scheduleAppliesOn(energy, '2027-01-05'), false);
  assert.strictEqual(BasDiff.scheduleActive(sch(r, 'Reg')), false, 'weekly with no days line');
  assert.strictEqual(BasDiff.whenText(sch(r, 'Reg')), 'No days selected (not active)');
  assert.deepStrictEqual(BasDiff.scheduleBlocksOn(sch(r, 'Reg'), '2026-11-12'), []);
  assert.deepStrictEqual(BasDiff.scheduleBlocksOn(energy, '2026-11-12'), [], 'unoccupied periods give no occupied block');
  ['Practice A', 'Awards Night', 'Game Day', 'Board Meeting', 'Cheer', 'Church', 'Lights'].forEach((n) => assert.strictEqual(BasDiff.scheduleActive(sch(r, n)), true, n));
  assert.strictEqual(r.items.filter((x) => BasDiff.scheduleActive(x.schedule)).length, 9, 'active group schedules in the synthetic report');
});

t('groups: a schedule applies on the right dates', () => {
  const r = readG(REPORT);
  const on = (n, d) => BasDiff.scheduleAppliesOn(sch(r, n), d);
  assert.strictEqual(on('Awards Night', '2026-11-12'), true);
  assert.strictEqual(on('Awards Night', '2026-11-13'), false);
  assert.strictEqual(on('Cheer', '2026-11-12'), true); // Thu in range
  assert.strictEqual(on('Cheer', '2026-11-11'), true); // Wed
  assert.strictEqual(on('Cheer', '2026-11-13'), false); // Fri
  assert.strictEqual(on('Cheer', '2027-03-04'), false); // Thu after the range
  assert.strictEqual(on('Game Day', '2027-02-28'), true);
  assert.strictEqual(on('Game Day', '2027-03-01'), false);
  assert.strictEqual(on('Board Meeting', '2026-11-09'), true); // 2nd Monday
  assert.strictEqual(on('Board Meeting', '2026-11-02'), false);
  assert.strictEqual(on('Practice A', '2026-11-10'), true); // Tue
  assert.strictEqual(on('Practice A', '2026-11-12'), false); // Thu
});

t('groups: first import stores groups and location schedules, keeps stored members; same report again = 0 changes', () => {
  const rep = readG(REPORT);
  const r1 = gImport({ importedAt: 'x', importedBy: '', groups: MEMBERS_OLD }, rep, 1);
  assert(!r1.error);
  assert.strictEqual(Object.keys(r1.groups.groups).length, 5);
  assert.strictEqual(r1.groups.groups['Alpha School|Gyms'].schedules.length, 3);
  assert.strictEqual(r1.groups.groups['Alpha School|Gyms'].members.length, 2, 'members stay as they were');
  assert.strictEqual(r1.groups.locations.length, 2);
  assert.strictEqual(r1.rec.locations, 2);
  const r2 = gImport(r1.groups, rep, 2, r1.hist);
  assert.deepStrictEqual([r2.rec.counts.added, r2.rec.counts.removed, r2.rec.counts.changed], [0, 0, 0]);
  assert.strictEqual(r2.hist.length, 2);
});

t('groups: one edited schedule = 1 changed', () => {
  const r1 = gImport(null, readG(REPORT), 1);
  const r2 = gImport(r1.groups, readG(REPORT.replace('3:20 PM to 5:00 PM', '3:20 PM to 6:00 PM')), 2);
  assert.strictEqual(r2.rec.counts.changed, 1);
  assert(/5:00 PM/.test(r2.rec.changed[0].before) && /6:00 PM/.test(r2.rec.changed[0].after));
});

t('groups: empty import is refused', () => {
  assert(gImport(null, { items: [], locations: [] }, 1).error);
});

// --- the card page text: untrusted names and keys never reach HTML or inline script ---------------------
t('card: quotes and <script> in keys, programs, dates and groups are escaped; a bad date key is skipped', () => {
  const store = {};
  const host = { innerHTML: '' };
  const sb = {
    console,
    DB: { get: (k, d) => (k in store ? store[k] : d), set: () => Promise.resolve() },
    document: {
      getElementById: (id) => (id === 'bas-panel-7' ? host : id === 'bas-style' || id === 'pcal-style' ? {} : null),
      createElement: () => ({}),
      head: { appendChild() {} },
    },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'formatting.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'bas-diff.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'project-calendar.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'bas-schedules.js'), 'utf8'), sb);
  const evil = `/D/B"><script>alert(1)</script>/A'x`;
  const blk = [[360, 960, 'occ']];
  store['en_bas_snap_7'] = {
    '2026-10-29': { forDate: '2026-10-29', importedAt: '2026-10-29T15:00:00Z', importedBy: '<img src=x onerror=alert(2)>', rows: { [evil + '|P"\'<script>alert(3)</script>']: blk } },
    "2026-10-30'+alert(4)+'": { forDate: 'x', importedAt: '2026-10-29T15:00:00Z', rows: {} },
    '2026-10-31"><script>alert(5)</script>': { forDate: 'x', importedAt: '2026-10-29T15:00:00Z', rows: {} },
  };
  store['en_bas_hist_7'] = [
    { id: 'h1', kind: 'schedules', at: '2026-10-29T15:00:00Z', by: '<b>x</b>', forDate: '2026-10-29', comparedTo: '2026-10-28', first: false, buildings: [], counts: { added: 0, removed: 0, changed: 1, unchanged: 0, total: 1 }, byBuilding: { '<i>b</i>': { added: 0, removed: 0, changed: 1 } }, added: [], removed: [], changed: [{ key: evil + '|P<script>alert(6)</script>', before: blk, after: [[300, 960, 'occ']] }] },
  ];
  store['en_bas_groups_7'] = { importedAt: '2026-10-29T15:00:00Z', importedBy: '<u>u</u>', groups: { 'b|g': { building: 'B<script>alert(7)</script>', group: 'G"\'', schedules: [{ name: '<script>alert(8)</script>', type: 'weekly', days: ['Mon', 'Tue'], dates: [], from: '', to: '', recur: null, priority: 'Normal', periods: [{ mode: 'occ', from: 60, to: 120 }] }], members: ['<script>alert(9)</script>'] } }, locations: [{ location: '/D/L', building: '<b>L</b>', area: 'A', schedule: { name: '<img src=x onerror=alert(10)>', type: 'weekly', days: ['Mon'], dates: [], from: '', to: '', recur: null, priority: 'Normal', periods: [] } }] };
  sb.basRender(7);
  const html = host.innerHTML;
  assert(html.length > 500, 'card did not render');
  assert(!/<script/i.test(html), 'raw <script> in page text');
  assert(!/<img |<b>x<|<i>b|<u>u/i.test(html), 'raw tag from data in page text');
  assert(!/alert\(4\)|alert\(5\)/.test(html), 'bad date key shown');
  assert(!/basView\([^)]*'/.test(html), 'data inside inline script');
  assert(/data-date="2026-10-29"/.test(html));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
