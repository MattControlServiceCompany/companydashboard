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
const GHEAD = 'screenshot,building,group,schedule_description,priority,type,source,mon,tue,wed,thu,fri,sat,sun,period_mode,start,end,dates,note\n';
const GROUPS =
  GHEAD +
  '1,Alpha School,Gyms,Practice,Normal,Weekly,src,Y,Y,Y,Y,Y,N,N,Occupied,3:20 PM,5:00 PM,,\n' +
  '1,Alpha School,Gyms,Camp,Normal,Exception,src,N,N,N,N,N,N,N,Occupied,8:00 AM,12:00 PM,"Jun 1, 2027",\n' +
  '2,Beta School,Lights,Lights,Normal,Weekly,src,Y,Y,Y,Y,Y,Y,Y,Occupied,4:00 AM,8:00 AM,,"a note, with comma"\n';
const MEMBERS = 'screenshot,building,group,member\n1,Alpha School,Gyms,Roof / RTU-1\n1,Alpha School,Gyms,First Floor / Room 1\n2,Beta School,Lights,Pole 1\n\n';
function readG(txt) {
  return BasDiff.readGroupRows(sandbox.emParseCSVText(txt));
}
function gImport(stored, sched, mem, n, hist) {
  return BasDiff.applyGroupsImport({ hist: hist, groups: stored, scheduleItems: sched, memberItems: mem, now: '2026-10-29T16:00:00.000Z', by: 'Test User', id: 'bash_g' + n });
}

t('groups: both files read, days shown as text, quoted commas kept', () => {
  const s = readG(GROUPS);
  const m = readG(MEMBERS);
  assert.strictEqual(s.kind, 'schedules');
  assert.strictEqual(m.kind, 'members');
  assert.strictEqual(s.items.length, 3);
  assert.strictEqual(m.items.length, 3);
  assert.strictEqual(s.items[0].schedule.days, 'Mon-Fri');
  assert.strictEqual(s.items[1].schedule.days, 'No days');
  assert.strictEqual(s.items[1].schedule.dates, 'Jun 1, 2027');
  assert.strictEqual(s.items[2].schedule.days, 'Every day');
  assert.strictEqual(s.items[2].schedule.note, 'a note, with comma');
  assert.strictEqual(readG(csv(alphaRows)).kind, '');
});

t('groups: first import stores groups with schedules and members; same files again = 0 changes', () => {
  const s = readG(GROUPS).items;
  const m = readG(MEMBERS).items;
  const r1 = gImport(null, s, m, 1);
  assert(!r1.error);
  assert.strictEqual(Object.keys(r1.groups.groups).length, 2);
  assert.strictEqual(r1.groups.groups['Alpha School|Gyms'].schedules.length, 2);
  assert.strictEqual(r1.groups.groups['Alpha School|Gyms'].members.length, 2);
  assert.strictEqual(r1.rec.first, true);
  const r2 = gImport(r1.groups, s, m, 2, r1.hist);
  assert.deepStrictEqual([r2.rec.counts.added, r2.rec.counts.removed, r2.rec.counts.changed], [0, 0, 0]);
  assert.strictEqual(r2.hist.length, 2);
});

t('groups: one edited schedule = 1 changed; importing only the members file keeps the schedules', () => {
  const s = readG(GROUPS).items;
  const m = readG(MEMBERS).items;
  const r1 = gImport(null, s, m, 1);
  const s2 = readG(GROUPS.replace('3:20 PM,5:00 PM', '3:20 PM,6:00 PM')).items;
  const r2 = gImport(r1.groups, s2, m, 2);
  assert.strictEqual(r2.rec.counts.changed, 1);
  assert(/5:00 PM/.test(r2.rec.changed[0].before) && /6:00 PM/.test(r2.rec.changed[0].after));
  const m3 = readG(MEMBERS + '2,Beta School,Lights,Pole 2\n').items;
  const r3 = gImport(r2.groups, null, m3, 3);
  assert.strictEqual(r3.rec.counts.changed, 1);
  assert.strictEqual(r3.groups.groups['Alpha School|Gyms'].schedules.length, 2);
  assert.strictEqual(r3.groups.groups['Beta School|Lights'].members.length, 2);
});

t('groups: empty import is refused', () => {
  assert(gImport(null, [], [], 1).error);
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
  store['en_bas_groups_7'] = { importedAt: '2026-10-29T15:00:00Z', importedBy: '<u>u</u>', groups: { 'b|g': { building: 'B<script>alert(7)</script>', group: 'G"\'', schedules: [{ description: '<script>alert(8)</script>', type: 'Weekly', days: 'Mon-Fri', mode: 'Occupied', start: '1:00 AM', end: '2:00 AM', dates: '', priority: 'Normal', note: '' }], members: ['<script>alert(9)</script>'] } } };
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
