// tools/test-sched-actions.js - the "What needs to change" list: actions, Done, closing, reopening, waste. Run: node tools/test-sched-actions.js
// SYNTHETIC data only (made-up buildings and names).
'use strict';
const fs = require('fs');
const path = require('path');
const SA = require('../computations/sched-actions.js');
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
const allDay = [[0, 0, 'occ']];
const mkRows = (gymEnd) => ({
  [L + '|AHU-1 - Gym']: occ(300, gymEnd),
  [L + '|AHU-2']: occ(300, 960),
  [L + '|Pole Lights']: allDay,
  [R + '|Hall Lights']: allDay,
  [R + '|HW-1 Boiler']: allDay,
  [R + '|DHW Recirc']: allDay,
  [R + '|Air Handler ERV-1']: allDay,
});
const mkSnaps = (gymEnd, importedAt) => ({
  '2026-10-30': { importedAt: importedAt, rows: mkRows(gymEnd) },
  '2026-10-31': { importedAt: importedAt, rows: mkRows(gymEnd) },
});
const z = (d, h, m) => new Date(d + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-05:00').toISOString();
const events = {
  g1: ['Game - TAH Gym', z('2026-10-30', 18, 0), z('2026-10-30', 21, 0), 0, ''],
  old: ['Game - TAH Gym', z('2026-10-29', 18, 0), z('2026-10-29', 21, 0), 0, ''],
  hv: ['Meet - TAH Plant', z('2026-10-30', 18, 0), z('2026-10-30', 21, 0), 0, ''],
  day: ['Trip - TAH Gym', '2026-10-30', '2026-10-31', 1, ''],
};
const map = {
  spaces: {
    'tah gym': { space: 'TAH Gym', programs: [L + '|AHU-1 - Gym'], confirmed: true },
    'tah plant': { space: 'TAH Plant', programs: [R + '|HW-1 Boiler', L + '|AHU-2'], confirmed: true },
  },
};
const groups = { 'Test Alpha Hall|Gyms': { building: 'Test Alpha Hall', group: 'Gyms', schedules: [], members: ['Area 1 / AHU-1 - Gym', 'Area 1 / Room 9 v1 : 2'] } };
const base = { events, map, groups, tz: TZ, today: '2026-10-30' };
const o = (gymEnd, extra) => Object.assign({}, base, { snaps: mkSnaps(gymEnd, '2026-10-29T20:00:00Z') }, extra || {});

// the list: only a Not covered event, today or later, never a serving unit or all-day event
let a = SA.computeActions(o(1080));
eq(a.length, 1, 'one action: the Not covered game (past game, plant event and all-day event make none)');
eq(a[0].id, 'g1', 'the action is the game');
eq(a[0].text, 'Fri Oct 30 Game - TAH Gym 6:00 PM – 9:00 PM: AHU-1 - Gym unoccupied for the whole event -> add 6:00 PM - 9:00 PM to group Gyms', 'action line');
const part = SA.computeActions(o(1140, { events: { p: ['Game - TAH Gym', z('2026-10-30', 18, 0), z('2026-10-30', 21, 0), 0, ''] } }));
eq(part[0].text.split(': ')[1], 'AHU-1 - Gym unoccupied after 7:00 PM -> add 7:00 PM - 9:00 PM to group Gyms', 'part of the event short');
eq(SA.computeActions(o(1260)).length, 0, 'covered: no action');
const two = Object.assign({}, events, { g2: ['Late - TAH Gym', z('2026-10-31', 19, 0), z('2026-10-31', 21, 0), 0, ''] });
const s2 = SA.computeActions(o(1080, { events: two }));
eq(s2[0].id, 'g2', 'newest event first, Oct 31 before Oct 30');

// status over time
const t1 = '2026-10-30T15:00:00Z';
let r = SA.reconcile(o(1080, { stored: null, now: t1, latestImport: '2026-10-29T20:00:00Z' }));
eq(r.changes.map((c) => c.what), ['New action'], 'first look opens the action');
eq(r.stored.actions.g1.status, 'open', 'status open');
// nothing new
eq(SA.reconcile(o(1080, { stored: r.stored, now: t1, latestImport: '2026-10-29T20:00:00Z' })).changes, [], 'second look changes nothing');
// done by a person
let d = SA.setStatus(r.stored, 'g1', 'done', 'TST User', '2026-10-30T16:00:00Z');
eq([d.stored.actions.g1.status, d.stored.actions.g1.doneBy, d.stored.actions.g1.doneAt], ['done', 'TST User', '2026-10-30T16:00:00Z'], 'done records who and when');
eq(d.changes.map((c) => c.what), ['Marked done'], 'done is a change for the history');
eq(SA.setStatus(d.stored, 'g1', 'done', 'x', 'y').changes, [], 'done twice changes nothing');
// no new import yet: stays done
eq(SA.reconcile(o(1080, { stored: d.stored, now: '2026-10-30T17:00:00Z', latestImport: '2026-10-29T20:00:00Z' })).stored.actions.g1.status, 'done', 'done stays done until the next import');
// a newer import still short: reopens with a note
let re = SA.reconcile(o(1080, { stored: d.stored, now: '2026-10-31T01:00:00Z', latestImport: '2026-10-30T22:00:00Z' }));
eq(re.stored.actions.g1.status, 'open', 'done and still not covered reopens');
eq(/Marked done by TST User on Fri Oct 30, 2026, still not covered after the update of Fri Oct 30, 2026/.test(re.stored.actions.g1.note), true, 'reopen note names who and when');
// a newer import fixes it: closes with the date
let cl = SA.reconcile(o(1260, { stored: r.stored, now: '2026-10-30T23:00:00Z', latestImport: '2026-10-30T22:00:00Z' }));
eq([cl.stored.actions.g1.status, cl.stored.actions.g1.note], ['closed', 'Fixed in BAS on Fri Oct 30, 2026'], 'covered closes itself');
eq(SA.reconcile(o(1260, { stored: d.stored, now: '2026-10-30T23:00:00Z', latestImport: '2026-10-30T22:00:00Z' })).stored.actions.g1.status, 'closed', 'a done action closes too when fixed');
// closed, then not covered again
eq(SA.reconcile(o(1080, { stored: cl.stored, now: '2026-10-31T02:00:00Z', latestImport: '2026-10-31T01:00:00Z' })).stored.actions.g1.status, 'open', 'closed then short again reopens');
// event removed from the calendar
const gone = SA.reconcile(o(1080, { events: {}, stored: r.stored, now: t1, latestImport: '' }));
eq(gone.stored.actions.g1.note, 'Event removed from the calendar', 'removed event closes');
// space turned Off-site
const off = SA.reconcile(o(1080, { map: { spaces: { 'tah gym': { space: 'TAH Gym', programs: [], offsite: true, confirmed: true } } }, stored: r.stored, now: t1, latestImport: '' }));
eq(off.stored.actions.g1.note, 'No longer checked (Off-site)', 'off-site closes with the reason');
// the input is not changed
eq(r.stored.actions.g1.status, 'open', 'reconcile does not change the stored object it was given');
// history record
const h = SA.historyRecord(d.changes, t1, 'TST User', 'bash_x');
eq([h.kind, h.by, h.counts.total, h.changes[0].what], ['action', 'TST User', 1, 'Marked done'], 'history record');

// waste: occupied all day, no event of that building that day; serving units never
let w = SA.wasteFindings(o(1080));
eq(w.map((f) => f.building + ':' + f.program + ':' + f.dates.join('+')).sort(), ['Test Alpha Hall:Pole Lights:2026-10-31', 'Test Beta School:Hall Lights:2026-10-30+2026-10-31'], 'a building with an event that day is left out; serving units are left out');
eq(SA.wasteFindings(Object.assign(o(1080), { today: '2026-12-31' })).length, 0, 'old saved days are not checked');

// one place for the rules: the tab file draws only; no network
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ui = read('app/sched-actions.js');
eq(/computeActions|reconcile\(/.test(ui) && !/eventCoverage|minutesShort|isServingProgram/.test(ui), true, 'the tab calls SchedActions only');
eq(/fetch\(|XMLHttpRequest/.test(ui) || /fetch\(/.test(read('computations/sched-actions.js')), false, 'no network call');
eq(/BasCoverage\.eventCoverage|BC\.eventCoverage/.test(read('computations/sched-actions.js')), true, 'coverage comes from bas-coverage.js');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
