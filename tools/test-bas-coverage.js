// tools/test-bas-coverage.js - event x BAS coverage and the space map rules. Run: node tools/test-bas-coverage.js
// SYNTHETIC data only (TST ids, made-up buildings).
'use strict';
const path = require('path');
const fs = require('fs');
const C = require('../computations/bas-coverage.js');
let fails = 0;
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) {
    fails++;
    console.log('FAIL: ' + msg + '\n  got  ' + x + '\n  want ' + y);
  }
}

const TZ = 'America/Chicago';
const L = '/Test District/Test Alpha Hall/Area 1';
const R = '/Test District/Test Beta School/Roof';
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
// Thu 2026-10-29: gym AHU 5:00-20:00, room 5:00-16:00. Fri 2026-10-30: gym until 18:00.
const rows = (gymEnd) => ({
  [L + '|AHU-1 - Gym']: occ(300, gymEnd),
  [L + '|AHU-2']: occ(300, 1200), // bare tag: serves boxes
  [L + '|Room 114']: occ(300, 960),
  [R + '|RTU-1 Gym']: occ(420, 1020),
  [R + '|HW-1 Boiler']: occ(0, 1440),
  [R + '|Air Handler ERV-1']: occ(0, 1440),
});
const snaps = { '2026-10-29': { rows: rows(1200) }, '2026-10-30': { rows: rows(1080) } };
const keys = Object.keys(snaps['2026-10-30'].rows);

// serving units
eq(
  ['AHU-2', 'RTU-3A', 'HW-1 Boiler', 'CHW Pump 2', 'Air Handler ERV-1', 'DOAS-1', 'AHU-1 - Gym', 'RTU-1 Gym', 'Room 114', 'AHU-1A W Gymnasium'].map(C.isServingProgram),
  [true, true, true, true, true, true, false, false, false, false],
  'serving units are plants, ERV/DOAS, and bare air handler tags',
);

// matching a mapped program to rows
eq(C.matchKeys(keys, L, 'AHU-1 - Gym'), [L + '|AHU-1 - Gym'], 'exact program');
eq(C.matchKeys(keys, L + ' ', 'ahu-1').length, 1, 'name inside a program, location case and spaces ignored');
eq(C.matchKeys(keys, '', 'AHU-1 - Gym'), [], 'no location, no match');
eq(C.resolveKeys(snaps['2026-10-30'].rows, [L + '|AHU-2', R + '|HW-1 Boiler']), [], 'serving units are dropped');
eq(C.resolveKeys(snaps['2026-10-30'].rows, [L + '|Room 114', L + '|Room 114']), [L + '|Room 114'], 'no repeats');

// name suggestions: first word = initials of the building
eq(C.suggestPrograms('TAH Gym', keys), [L + '|AHU-1 - Gym'], 'initials match building, gym matches program');
eq(C.suggestPrograms('LTAH Room 114', keys), [L + '|Room 114'], 'prefix with one extra letter, room number');
eq(C.suggestPrograms('TBS Gym', keys), [R + '|RTU-1 Gym'], 'second building');
eq(C.suggestPrograms('Nowhere Gym', keys), [], 'unknown building');
eq(C.suggestPrograms('TAH', keys), [], 'one word is too vague');

// coverage
const z = (d, h, m) => new Date(d + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00' + (d >= '2026-11-01' ? '-06:00' : '-05:00')).toISOString();
const map = {
  spaces: {
    'tah gym': { space: 'TAH Gym', programs: [L + '|AHU-1 - Gym'], confirmed: true },
    'tah rm': { space: 'TAH Rm', programs: [L + '|AHU-1 - Gym', L + '|Room 114'], confirmed: true },
    'away': { space: 'Away', programs: [], offsite: true, confirmed: true },
    'tah pending': { space: 'TAH Pending', programs: [L + '|Room 114'], confirmed: false },
    'tah plant': { space: 'TAH Plant', programs: [R + '|HW-1 Boiler'], confirmed: true },
  },
};
const ctx = { tz: TZ, map, snaps };
const ev = (title, d, h1, m1, h2, m2, loc) => [title, z(d, h1, m1), z(d, h2, m2), 0, loc || ''];
const st = (row) => C.eventCoverage(row, ctx);
eq(st(ev('Game - TAH Gym', '2026-10-29', 18, 0, 20, 0)).status, 'covered', 'inside occupied');
eq(st(ev('Game - TAH Gym', '2026-10-29', 18, 0, 20, 0)).label, 'Covered', 'covered label');
const sh = st(ev('Game - TAH Gym', '2026-10-30', 17, 0, 21, 0));
eq([sh.status, sh.short, sh.label], ['short', 180, 'Not covered, 180 min short'], 'Friday ends at 18:00: 3 hours short');
eq(st(ev('Meet', '2026-10-30', 17, 0, 19, 0, 'TAH Gym')).short, 60, 'location field is used when the title has no place');
eq(st(ev('Meet - TAH Rm', '2026-10-30', 15, 0, 19, 0)).short, 180, 'two programs: the least covered one counts (room ends 16:00, gym ends 18:00 on Friday)');
eq(st(ev('Meet - TAH Rm', '2026-10-29', 15, 0, 17, 0)).short, 60, 'two programs, Thursday: room ends 16:00');
eq(st(ev('Trip - Away', '2026-10-29', 15, 0, 17, 0)).status, 'offsite', 'off-site');
eq(st(ev('Meet - TAH Pending', '2026-10-29', 15, 0, 17, 0)).status, 'notmapped', 'unconfirmed space is not checked');
eq(st(ev('Meet - TAH Unknown', '2026-10-29', 15, 0, 17, 0)).status, 'notmapped', 'space not in the map');
eq(st(['No place here', z('2026-10-29', 9, 0), z('2026-10-29', 10, 0), 0, '']).status, 'notmapped', 'no space');
eq(st(ev('Meet - TAH Plant', '2026-10-29', 15, 0, 17, 0)).status, 'nobas', 'only serving units: no BAS schedule for this space');
eq(st(['Day off - TAH Gym', '2026-10-29', '2026-10-30', 1, '']).status, 'allday', 'all-day event has no times');
// a date with no copy uses the newest earlier copy of the same weekday; else nocopy
const wk = st(ev('Game - TAH Gym', '2026-11-05', 19, 0, 21, 0)); // Thu, Nov 5
eq([wk.status, wk.from, wk.exact, wk.short], ['short', '2026-10-29', false, 60], 'next Thursday uses the Oct 29 copy');
eq(st(ev('Game - TAH Gym', '2026-10-31', 10, 0, 12, 0)).status, 'nocopy', 'Saturday: no Saturday copy');
// event across midnight is checked to midnight; no end time is checked for one hour
eq(st(['Late - TAH Gym', z('2026-10-29', 19, 30), z('2026-10-30', 1, 0), 0, '']).short, 240, 'to midnight: 270 min, 30 covered');
eq(st(['Start - TAH Gym', z('2026-10-29', 19, 30), '', 0, '']).short, 30, 'no end: one hour checked');

// suggestions file
const csv = [
  ['calendar_space', 'building', 'bas_location', 'bas_program', 'source', 'confirmed'],
  ['TAH Gym', 'x', L, 'AHU-1 - Gym', 'a', 'yes'],
  ['TAH Two', 'x', L, 'Room 114; AHU-1', 'b', 'assumed'],
  ['TAH Three', 'x', '', 'AHU-9', 'c', 'no'],
  ['', 'x', '', '', '', ''],
];
const imp = C.entriesFromCsv(csv, keys, 'TST user', '2026-10-30T00:00:00Z');
eq(imp.count, 3, 'three spaces read, blank row skipped');
eq(imp.entries['tah gym'].programs, [L + '|AHU-1 - Gym'], 'program name turned into a row key');
eq([imp.entries['tah gym'].confirmed, imp.entries['tah two'].confirmed, imp.entries['tah three'].confirmed], [true, true, false], 'yes and assumed are confirmed, no is a suggestion');
eq(imp.entries['tah two'].programs, [L + '|Room 114', L + '|AHU-1 - Gym'], 'two programs, one loose name');
eq(C.entriesFromCsv([['a', 'b']], keys).error !== '', true, 'missing columns give a message');

// one coverage function: the events list and the space map card do not repeat the rules
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
eq(/eventCoverage\(/.test(read('app/project-calendar.js')) && !/minutesShort|isServingProgram/.test(read('app/project-calendar.js')), true, 'events list calls eventCoverage only');
eq(/suggestPrograms\(/.test(read('app/space-map.js')) && !/function suggest|function minutesShort/.test(read('app/space-map.js')), true, 'space map calls the shared suggestions');
eq(/https?:\/\/|fetch\(/.test(read('app/space-map.js')) || /fetch\(/.test(read('computations/bas-coverage.js')), false, 'no network call');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
