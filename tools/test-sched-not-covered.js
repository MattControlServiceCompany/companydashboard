// tools/test-sched-not-covered.js - the To do list of the District Calendar tab: SchedActions.todoView.
// Run: node tools/test-sched-not-covered.js     SYNTHETIC data only.
'use strict';
const assert = require('assert');
const SA = require('../computations/sched-actions.js');
const TZ = 'America/Chicago';
const L = '/Test District/Test Alpha Hall/Area 1';
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
const rows = { [L + '|AHU-1 - Gym']: occ(300, 960) };
const snaps = {};
['2026-11-13', '2026-11-14', '2026-11-15'].forEach((d) => (snaps[d] = { importedAt: '2026-11-14T20:00:00Z', rows }));
const z = (d, h) => new Date(d + 'T' + String(h).padStart(2, '0') + ':00:00-06:00').toISOString();
const sched = (name) => ({ name, type: 'weekly', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], periods: [{ mode: 'occ', from: 960, to: 1200 }] });
const events = {
  soon: ['Game - TAH Gym', z('2026-11-20', 18), z('2026-11-20', 20), 0, ''],
  later: ['Concert - TAH Gym', z('2027-03-05', 18), z('2027-03-05', 21), 0, ''],
  named: ['Cheer Practice Team - TAH Gym', z('2026-11-21', 16), z('2026-11-21', 19), 0, ''], // named like a schedule of ANOTHER group
  past: ['Old game - TAH Gym', z('2026-11-10', 18), z('2026-11-10', 20), 0, ''],
};
const map = { spaces: { 'tah gym': { space: 'TAH Gym', programs: [L + '|AHU-1 - Gym'], confirmed: true } } };
const groups = {
  'Test Alpha Hall|Gyms': { building: 'Test Alpha Hall', group: 'Gyms', schedules: [], members: ['Area 1 / AHU-1 - Gym'] },
  'Test Alpha Hall|Other': { building: 'Test Alpha Hall', group: 'Other', schedules: [sched('Cheer Practice Team - TAH Gym')], members: ['Area 1 / Elsewhere'] },
};
const inp = { events, map, snaps, groups, locations: [], tz: TZ, today: '2026-11-15', now: '2026-11-15T12:00:00Z', stored: { actions: {} } };
const view = (extra) => SA.todoView(Object.assign({}, inp, { from: '2026-11-15', to: '2026-11-21', rows: Object.keys(events).map((k) => events[k]).filter((r) => r[1] >= z('2026-11-15', 0) && r[1] < z('2026-11-22', 0)) }, extra || {}));

const v = view();
// the named schedule sits in a group that does not run the rooms: it does not cover the event, so the event is a to-do (one decision)
assert.strictEqual(v.todo.length, 2, 'two to-dos in the week: the game and the event named like a schedule of another group');
assert(v.todo.every((r) => r.head && r.doThis && r.why), 'each row has when/what, Do this and Why');
const cheer = v.todo.filter((r) => /Cheer Practice Team/.test(r.head))[0];
assert(/which does not run this room|which does not run this space/.test(cheer.why), 'why names the schedule of that name in the other group: ' + cheer.why);
assert(/in group Other/.test(cheer.why), cheer.why);
assert.strictEqual(cheer.doThis, 'Do this: in WebCTRL, group Gyms, add a one-day schedule Sat Nov 21, 4:00–7:00 PM.');
// only the period: the 2027 concert is not a row; it is one count
assert.strictEqual(v.later.count, 1, 'one later event');
assert.strictEqual(v.later.from, '2027-03-05');
assert(!v.todo.some((r) => /Concert/.test(r.head)), 'a far-future event is not a row');
// a past event is not a row
assert(!v.todo.some((r) => /Old game/.test(r.head)));
// Done: a Done line leaves the to-do rows and is listed as done
const first = v.todo[0];
const done = view({ stored: { actions: { [first.id]: { id: first.id, date: '2026-11-20', text: 'x', status: 'done', doneAt: '2026-11-15T13:00:00Z', doneBy: 't' } } } });
assert.strictEqual(done.todo.length, 1, 'a Done line leaves the to-do rows');
assert.strictEqual(done.done.length, 1, 'and is listed as done');
// the later week shows the 2027 event
const w2 = SA.todoView(Object.assign({}, inp, { from: '2027-03-01', to: '2027-03-07', today: '2026-11-15', rows: [events.later] }));
assert.strictEqual(w2.todo.length, 1);
assert.strictEqual(w2.later, null);
console.log('PASS test-sched-not-covered');
