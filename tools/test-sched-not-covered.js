// tools/test-sched-not-covered.js - the "Not covered by a BAS schedule" lists: SchedActions.notCoveredLists.
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
  later: ['Concert - TAH Gym', z('2027-03-05', 18), z('2027-03-05', 21), 0, ''], // after Dec 31 of this year
  named: ['Cheer Practice Team - TAH Gym', z('2026-11-21', 16), z('2026-11-21', 19), 0, ''],
  past: ['Old game - TAH Gym', z('2026-11-10', 18), z('2026-11-10', 20), 0, ''],
};
const map = { spaces: { 'tah gym': { space: 'TAH Gym', programs: [L + '|AHU-1 - Gym'], confirmed: true } } };
const groups = {
  'Test Alpha Hall|Gyms': { building: 'Test Alpha Hall', group: 'Gyms', schedules: [], members: ['Area 1 / AHU-1 - Gym'] },
  'Test Alpha Hall|Other': { building: 'Test Alpha Hall', group: 'Other', schedules: [sched('Cheer Practice Team - TAH Gym')], members: ['Area 1 / Elsewhere'] },
};
const inp = { events, map, snaps, groups, locations: [], tz: TZ, today: '2026-11-15', now: '2026-11-15T12:00:00Z', stored: { actions: {} } };
// a same-name schedule of a date that is not the event date does not cover the event
const dateSched = Object.assign(sched('Concert - TAH Gym'), { days: ['Mon'] });
const groups2 = Object.assign({}, groups, { 'Test Alpha Hall|Other': Object.assign({}, groups['Test Alpha Hall|Other'], { schedules: [sched('Cheer Practice Team - TAH Gym'), dateSched] }) });
const r0 = SA.notCoveredLists(Object.assign({}, inp, { groups: groups2 }));
assert(r0.open.some((n) => n.forText === 'Concert - TAH Gym'), 'a schedule of that name that is not active on the event day leaves the event a to-do');
const r = SA.notCoveredLists(inp);
const titles = (l) => l.map((n) => n.forText);

assert.deepStrictEqual(titles(r.open).sort(), ['Concert - TAH Gym', 'Game - TAH Gym'], 'open list: an event in 2027 is listed; the past event is not');
assert.deepStrictEqual(titles(r.other), ['Cheer Practice Team - TAH Gym'], 'an event already in a WebCTRL schedule is in the other list, not in the open count');
assert.strictEqual(r.open.length, 2, 'the count is the open list only');
assert(r.open.every((n) => n.action.short > 0 && n.where && n.unit), 'each open row has minutes, place and unit');
const v = SA.reconcile(inp);
r.open.concat(r.other).forEach((n) => {
  assert.strictEqual(v.stored.actions[n.id].text.split(' -> ')[1], n.change, 'displayed change equals the end of the stored text: ' + n.change);
});
console.log('change text:', r.open.map((n) => n.change).join(' | '));
const first = r.open[0];
const done = Object.assign({}, inp, { stored: { actions: { [first.id]: { id: first.id, date: first.action.date, text: 'x', status: 'done', doneAt: '2026-11-15T13:00:00Z', doneBy: 't' } } } });
const r2 = SA.notCoveredLists(done);
assert.strictEqual(r2.open.length, 1, 'a Done line leaves the open list');
assert.strictEqual(r2.done.length, 1, 'and is listed as done');
console.log('PASS test-sched-not-covered');
