// tools/test-sched-grouping.js - the "What needs to change" list groups its lines. Run: node tools/test-sched-grouping.js
// Rules a-e: inside the schedule = no line; overlapping/touching events = one line; repeats = one line; same group = one line;
// coverage uses the date's effective schedule. SYNTHETIC data only (made-up buildings and names).
'use strict';
const SA = require('../computations/sched-actions.js');
let fails = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fails++;
    console.log('FAIL: ' + msg + '\n  got  ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b));
  }
}
const TZ = 'America/Chicago';
const L = '/Test District/Test Alpha Hall/Area 1';
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
const z = (d, h, m) => new Date(d + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-06:00').toISOString();
const rowsFor = (end) => ({
  [L + '|Zone Gym']: occ(360, end),
  [L + '|Zone Cafe']: occ(360, end),
  [L + '|Zone Hall']: occ(360, end),
  [L + '|AHU-2']: occ(360, end),
});
// Mondays and Wednesdays of Nov 2026: 2, 4, 9, 11. 7 PM = 1140.
const snaps = {};
['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-09', '2026-11-11'].forEach((d) => (snaps[d] = { rows: rowsFor(1140) }));
snaps['2026-11-09'] = { rows: Object.assign(rowsFor(1140), { [L + '|Zone Gym']: [[0, 0, 'occ']] }) }; // date exception: occupied all day
const map = {
  spaces: {
    'tah gym': { space: 'TAH Gym', programs: [L + '|Zone Gym'], confirmed: true },
    'tah cafe': { space: 'TAH Cafe', programs: [L + '|Zone Cafe'], confirmed: true },
    'tah hall': { space: 'TAH Hall', programs: [L + '|Zone Hall'], confirmed: true },
    'tah plant': { space: 'TAH Plant', programs: [L + '|AHU-2'], confirmed: true },
  },
};
const groups = { 'Test Alpha Hall|Evening': { building: 'Test Alpha Hall', group: 'Evening', schedules: [], members: ['Area 1 / Zone Gym', 'Area 1 / Zone Cafe'] } };
const run = (events, extra) => SA.computeActions(Object.assign({ events, map, snaps, groups, tz: TZ, today: '2026-11-01' }, extra || {}));
const ev = (t, sp, d, h1, h2, m1, m2) => [t, z(d, h1, m1), z(d, h2, m2), 0, sp];

// a) inside the schedule: no line; a partial overlap gives only the uncovered span
eq(run({ a: ev('Meet - TAH Hall', '', '2026-11-02', 9, 11) }).length, 0, 'a: inside the occupied time, no line');
const part = run({ a: ev('Game - TAH Hall', '', '2026-11-02', 17, 21) });
eq(part.length, 1, 'a: partly outside gives one line');
eq(part[0].text.split(': ')[1], 'Zone Hall unoccupied 7:00 PM - 9:00 PM -> add 7:00 PM - 9:00 PM', 'a: only the uncovered span');
eq(run({ a: ev('Meet - TAH Plant', '', '2026-11-02', 20, 22) }).length, 0, 'a: a serving unit is never checked');

// b) overlapping and touching events in one area: one line, merged span
const ovl = run({ x: ev('Game - TAH Hall', '', '2026-11-02', 19, 21), y: ev('Prep - TAH Hall', '', '2026-11-02', 20, 22), w: ev('Tidy - TAH Hall', '', '2026-11-02', 22, 23) });
eq(ovl.length, 1, 'b: three overlapping or touching events, one line');
eq(ovl[0].text.split(': ')[1], 'Zone Hall unoccupied 7:00 PM - 11:00 PM -> add 7:00 PM - 11:00 PM', 'b: merged span');
eq(ovl[0].eventIds.sort(), ['w', 'x', 'y'], 'b: the line lists all the events');

// c) same area on several days: one grouped line
const rep = run({
  r1: ev('Practice - TAH Hall', '', '2026-11-02', 18, 21), r2: ev('Practice - TAH Hall', '', '2026-11-04', 18, 21), r3: ev('Practice - TAH Hall', '', '2026-11-11', 18, 21),
});
eq(rep.length, 1, 'c: three practices, one line');
eq(rep[0].text.split(' Practice')[0], 'Mon/Wed Nov 2 - Nov 11 (3 dates)', 'c: weekdays and range');
eq(rep[0].dates, ['2026-11-02', '2026-11-04', '2026-11-11'], 'c: the dates are kept');

// d) two spaces in one scheduling group: one line listing both events; a space outside the group is its own line
const grp = run({ g1: ev('Game - TAH Gym', '', '2026-11-02', 19, 21), g2: ev('Dinner - TAH Cafe', '', '2026-11-02', 19, 21), h: ev('Class - TAH Hall', '', '2026-11-02', 19, 21) });
eq(grp.length, 2, 'd: group of two spaces plus one other = two lines');
const gl = grp.find((a) => a.group === 'Evening');
eq(gl.eventIds.sort(), ['g1', 'g2'], 'd: the group line lists both events');
eq(/to group Evening/.test(gl.text), true, 'd: the line names the group');

// e) effective schedule of the date: a date with an exception (Nov 9 Gym occupied all day) makes no line; a weekday copy is used for a date with no copy
eq(run({ e: ev('Game - TAH Gym', '', '2026-11-09', 19, 21) }).length, 0, 'e: the date effective schedule (exception) covers the event');
eq(run({ e: ev('Game - TAH Gym', '', '2026-11-18', 19, 21) }).length, 1, 'e: no copy for the date uses the same weekday copy');
const rec = SA.reconcile({ events: { r1: rep[0] && ev('Practice - TAH Hall', '', '2026-11-02', 18, 21) }, map, snaps, groups, tz: TZ, today: '2026-11-01', stored: null, now: '2026-11-01T12:00:00Z', latestImport: '' });
eq(Object.keys(rec.stored.actions).length, 1, 'reconcile stores one grouped action');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
