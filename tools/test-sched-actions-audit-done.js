// tools/test-sched-actions-audit-done.js - the "What needs to change" list must not call a change "To do" when the data shows it done:
//   (B) a Weekly scheduling-group schedule that lists the event weekday and spans the event covers it (BasCoverage.eventCoverage);
//   (A) a schedule added or changed in the imported WebCTRL audit log AFTER the BAS copy, in the same building, that spans the event
//       gives the status "Added in WebCTRL ..."; a set point edit never does; an edit dated before the BAS copy is ignored;
//   (C) the copy note names the newest BAS copy, the newest audit log day and the schedule edits since.
// SYNTHETIC data only (Test School, Test Gym RTU, Test Group). Run: node tools/test-sched-actions-audit-done.js
'use strict';
const SA = require('../computations/sched-actions.js');
const BC = require('../computations/bas-coverage.js');
const BAL = require('../app/bas-audit-log.js');
let fails = 0;
let passes = 0;
function eq(got, want, msg) {
  const x = JSON.stringify(got);
  const y = JSON.stringify(want);
  if (x !== y) {
    fails++;
    console.log('FAIL: ' + msg + '\n  got  ' + x + '\n  want ' + y);
  } else passes++;
}

const TZ = 'America/Chicago';
const LOC = '/Test District/Test School/Gym';
const PROGRAM = 'Test Gym RTU';
const KEY = LOC + '|' + PROGRAM;
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
const snaps = { '2026-10-29': { importedAt: '2026-11-03T19:00:00Z', rows: { [KEY]: occ(300, 1080) } } }; // Thu 5:00 AM - 6:00 PM
const at = (ymd, h) => new Date(ymd + 'T' + String(h).padStart(2, '0') + ':00:00-06:00').toISOString();
const map = { spaces: { 'test gym': { space: 'Test Gym', programs: [KEY], confirmed: true } } };
const mins = (t) => { const m = t.match(/(\d+):(\d+) (AM|PM)/); return (+m[1] % 12) * 60 + +m[2] + (m[3] === 'PM' ? 720 : 0); };
const DAYN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const weekly = (days, start, end) => ({ name: 'Test Evening', priority: 'Normal', type: 'weekly', days: days === 'Mon-Fri' ? DAYN.slice() : days.split(/\s*,\s*/), dates: [], from: '', to: '', recur: null, periods: [{ mode: 'occ', from: mins(start), to: mins(end) }] });
const groupWith = (schedules) => ({ 'Test School|Test Group': { building: 'Test School', group: 'Test Group', schedules, members: ['Gym / ' + PROGRAM] } });
const wedEvent = { wed: ['Test Game - Test Gym', at('2026-11-11', 18), at('2026-11-11', 20), 0, ''] }; // Wed 6-8 PM
const thuEvent = { thu: ['Test Game - Test Gym', at('2026-11-12', 18), at('2026-11-12', 20), 0, ''] }; // Thu 6-8 PM
const today = '2026-11-09';
const input = (events, groups, scheduleEdits) => ({ events, map, snaps, groups, tz: TZ, today, scheduleEdits: scheduleEdits || [] });

// the audit log comes from the stored log through BasAuditLog.changeList, like the page
const us = (ymd, time) => { const [y, m, d] = ymd.split('-'); return +m + '/' + +d + '/' + y + ' ' + time; };
const block = (nm, days, a, b) => 'schedule "' + nm + '"\nType "Weekly"\ndays: ' + days + '\nAt "' + a + '" set "Occupied"\nAt "' + b + '" set "Unoccupied"';
function auditEdits(rowsNewestFirst) {
  const parsed = BAL.parseRows([['Date', 'Description', 'Details', 'Location', 'Operator']].concat(rowsNewestFirst));
  const store = BAL.mergeStore(null, parsed.events, parsed.lastDay);
  const list = BAL.changeList(store, {});
  return { store, list, edits: list.rows.filter((r) => /^Schedule/.test(r.type)) };
}
const addThuEvening = [us('2026-11-02', '9:15:00 AM'), 'Add schedule', block('Test Evening', 'Thu', '17:30', '20:30'), '/Test District/Test School', 'Test Operator'];
const setPointOnly = [us('2026-11-02', '9:15:00 AM'), 'Edit', 'x/occupied_heating changed from "68" to "66"', '/Test District/Test School/Gym/Room 1', 'Test Operator'];
const addBeforeCopy = [us('2026-10-28', '9:15:00 AM'), 'Add schedule', block('Test Evening', 'Thu', '17:30', '20:30'), '/Test District/Test School', 'Test Operator'];

// (B) Wed 6-8 PM: the BAS copy (Thu 5 AM - 6 PM, borrowed for Wednesday) does not cover it; a Mon-Wed 4-10 PM group schedule does
eq(SA.computeActions(input(wedEvent, groupWith([]))).length, 1, 'B: without the group schedule the Wed event needs a change');
eq(SA.computeActions(input(wedEvent, groupWith([weekly('Mon, Tue, Wed', '4:00 PM', '10:00 PM')]))), [], 'B: Wed event covered by the Mon-Wed weekly group schedule -> no action');
eq(SA.computeActions(input(thuEvent, groupWith([weekly('Mon, Tue, Wed', '4:00 PM', '10:00 PM')]))).length, 1, 'B: the same group schedule does not cover Thursday');
eq(SA.computeActions(input(wedEvent, groupWith([weekly('Mon, Tue, Wed', '4:00 PM', '7:00 PM')]))).map((a) => a.spanText), ['7:00 PM - 8:00 PM'], 'B: a group schedule that ends at 7 PM leaves only 7-8 PM to add');
eq(SA.computeActions(input(wedEvent, groupWith([weekly('Mon-Fri', '4:00 PM', '10:00 PM')]))), [], 'B: a Mon-Fri group schedule covers Wednesday');
const noDays = Object.assign(weekly('Mon', '4:00 PM', '10:00 PM'), { days: [] });
eq(SA.computeActions(input(wedEvent, groupWith([noDays]))).length, 1, 'B: a schedule with no day selected is not active and never covers');
const unocc = Object.assign(weekly('Mon, Tue, Wed', '4:00 PM', '10:00 PM'), { periods: [{ mode: 'unocc', from: 960, to: 1320 }] });
eq(SA.computeActions(input(wedEvent, groupWith([unocc]))).length, 1, 'B: unoccupied periods never count as coverage');
const onDate = Object.assign(weekly('Mon', '4:00 PM', '10:00 PM'), { type: 'date', days: [], dates: ['2026-11-11'] });
eq(SA.computeActions(input(wedEvent, groupWith([onDate]))), [], 'B: a schedule on that date covers the event');
eq(SA.computeActions(input(thuEvent, groupWith([onDate]))).length, 1, 'B: a schedule on another date does not');
const inRange = Object.assign(weekly('Wed', '4:00 PM', '10:00 PM'), { type: 'range', from: '2026-11-01', to: '2026-11-30' });
eq(SA.computeActions(input(wedEvent, groupWith([inRange]))), [], 'B: a date-range schedule with the weekday covers it');
eq(SA.computeActions(input(wedEvent, groupWith([Object.assign({}, inRange, { to: '2026-11-10' })]))).length, 1, 'B: a date-range schedule that ended does not');
eq(SA.computeActions(input(wedEvent, groupWith([Object.assign({}, inRange, { days: [] })]))), [], 'B: a date-range schedule with no weekday runs every day of the range, so it covers');
const eventCover = BC.eventCoverage(wedEvent.wed, { tz: TZ, map, snaps, groups: groupWith([weekly('Mon, Tue, Wed', '4:00 PM', '10:00 PM')]) });
eq(eventCover.status, 'covered', 'B: eventCoverage itself says covered (the events table uses the same function)');

// (A) 1: Thu event, no group schedule for Thursday; a later audit log "Add schedule" spans it
const withAdd = auditEdits([addThuEvening]);
let a = SA.computeActions(input(thuEvent, groupWith([]), withAdd.edits));
eq(a.length, 1, 'A1: one line');
eq(a[0].webctrl && a[0].webctrl.text, 'Added in WebCTRL on Mon Nov 2, 2026 by Test Operator - BAS copy not yet re-imported', 'A1: status words');
eq(a[0].webctrl && a[0].webctrl.ymd, '2026-11-02', 'A1: audit date');
eq(SA.periodNeeds(Object.assign(input(thuEvent, groupWith([]), withAdd.edits), { from: '2026-11-09', to: '2026-11-15' }))[0].webctrl.operator, 'Test Operator', 'A1: the period line carries it');
// an edit that does not span the whole event is not enough
const shortAdd = auditEdits([[us('2026-11-02', '9:15:00 AM'), 'Add schedule', block('Test Evening', 'Thu', '17:30', '19:00'), '/Test District/Test School', 'Test Operator']]);
eq(SA.computeActions(input(thuEvent, groupWith([]), shortAdd.edits))[0].webctrl, null, 'A1b: an edit that ends at 7 PM does not span a 6-8 PM event');
// another building does not count
const otherBuilding = auditEdits([[us('2026-11-02', '9:15:00 AM'), 'Add schedule', block('Test Evening', 'Thu', '17:30', '20:30'), '/Test District/Test Other', 'Test Operator']]);
eq(SA.computeActions(input(thuEvent, groupWith([]), otherBuilding.edits))[0].webctrl, null, 'A1c: an edit in another building does not count');
// (A) 2: only a set point edit -> stays To do
const withSetPoint = auditEdits([setPointOnly]);
eq(withSetPoint.edits.length, 0, 'A2: the set point row is not a schedule edit');
a = SA.computeActions(input(thuEvent, groupWith([]), withSetPoint.edits));
eq([a.length, a[0].webctrl], [1, null], 'A2: set point audit event only -> still To do (no webctrl status)');
eq(SA.computeActions(input(thuEvent, groupWith([]), withSetPoint.list.rows))[0].webctrl, null, 'A2: even when the set point rows are passed, they close nothing');
// (A) 4: an edit dated before the BAS copy is ignored
const beforeCopy = auditEdits([addBeforeCopy]);
a = SA.computeActions(input(thuEvent, groupWith([]), beforeCopy.edits));
eq([a.length, a[0].webctrl], [1, null], 'A4: audit edit dated before the BAS copy is ignored');

// the status is stable and the id differs from the To do line of the same event (running twice gives the same list)
eq(SA.computeActions(input(thuEvent, groupWith([]), withAdd.edits)), SA.computeActions(input(thuEvent, groupWith([]), withAdd.edits)), 'same input gives the same list');
const stored = SA.reconcile(Object.assign(input(thuEvent, groupWith([]), withAdd.edits), { stored: null, now: '2026-11-09T15:00:00Z', latestImport: '' }));
eq(Object.keys(stored.stored.actions).length, 1, 'reconcile stores one open action for the Added in WebCTRL line');

// (C) the copy note
const noteOf = (extra) => SA.copyNote(Object.assign({ snapFetchedAt: '2026-11-03T15:00:00Z', snaps, tz: TZ, today }, extra));
eq(
  noteOf({ auditLastDay: withAdd.store.lastDay, scheduleEdits: withAdd.edits }).split('BAS copies: ')[1],
  'Thu Oct 29, 2026. Newest BAS copy: Thu Oct 29, 2026. Newest audit log day: Mon Nov 2, 2026. Schedule edits in the audit log since the BAS copy: 1.',
  'C: copy note names the newest BAS copy, the newest audit log day and the edits since',
);
eq(noteOf({ auditLastDay: beforeCopy.store.lastDay, scheduleEdits: beforeCopy.edits }).endsWith(' Schedule edits in the audit log since the BAS copy: 0.'), true, 'C: an edit before the BAS copy is not counted');
eq(/Newest audit log day/.test(noteOf({})), false, 'C: with no audit log the line is left out');

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
