// tools/test-calendar-todo.js - the To do card and the event badge read ONE coverage decision (BasCoverage.coverageOf).
// Run: node tools/test-calendar-todo.js     SYNTHETIC data only (made-up school, rooms, events).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BC = require('../computations/bas-coverage.js');
const SA = require('../computations/sched-actions.js');
const CD = require('../app/calendar-diff.js');
const TZ = 'America/Chicago';
const AREA = '/Test District/Test School/AREA \'F\' SUMMARY';
const ROOMS = ['F101A', 'F101B', 'F101C', 'F102A', 'F102B', 'F102C'].map((n) => AREA + '|Room ' + n);
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
const rowsOf = () => {
  const r = {};
  ROOMS.forEach((k) => (r[k] = occ(360, 960))); // 6:00 AM - 4:00 PM
  return r;
};
const snaps = {};
['2026-11-12', '2026-11-13'].forEach((d) => (snaps[d] = { importedAt: '2026-11-13T20:00:00Z', rows: rowsOf() }));
const map = { spaces: { 'ts commons': { space: 'TS Commons', programs: ROOMS, confirmed: true } } };
const sched = (name, days, a, b) => ({ name, type: 'weekly', days, dates: [], from: '', to: '', recur: null, periods: [{ mode: 'occ', from: a, to: b }], priority: 'Normal', raw: days.join(',') });
const ALL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const groups = {
  'Test School|Area F': { building: 'Test School', group: 'Area F', schedules: [], members: ["Test School / AREA 'F' SUMMARY"], groupMembers: [] },
  'Test School|Gyms': { building: 'Test School', group: 'Gyms', schedules: [sched('Awards Night- TS Commons', ALL, 1110, 1200)], members: ['Gym / Elsewhere'], groupMembers: [] },
};
const at = (ymd, h, m) => new Date(ymd + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-06:00').toISOString();
const events = {
  awards: ['Awards Night- TS Commons', at('2026-11-16', 18, 30), at('2026-11-16', 20), 0, ''], // named like a Gyms schedule; the Gyms group does not run the rooms
  day: ['Open House- TS Commons', at('2026-11-17', 9), at('2026-11-17', 11), 0, ''], // inside 6 AM - 4 PM: covered
  banquet: ['Banquet- TS Commons', at('2026-11-23', 18), at('2026-11-23', 19, 30), 0, ''],
  far: ['Spring Show- TS Commons', at('2027-03-02', 18), at('2027-03-02', 20), 0, ''],
  w1: ['Club- TS Commons', at('2026-11-19', 18), at('2026-11-19', 20), 0, ''],
  w2: ['Club- TS Commons', at('2026-11-26', 18), at('2026-11-26', 20), 0, ''],
  w3: ['Club- TS Commons', at('2026-12-03', 18), at('2026-12-03', 20), 0, ''],
  w4: ['Club- TS Commons', at('2026-12-10', 18), at('2026-12-10', 20), 0, ''],
};
const inp = { events, map, snaps, groups, locations: [], tz: TZ, today: '2026-11-16', now: '2026-11-16T19:41:00Z', stored: { actions: {} }, scheduleEdits: [] };
const ctx = { tz: TZ, map, snaps, groups, locations: [] };
const periodOf = (view, anchor, from) => {
  const per = CD.periodRange(view, anchor, from || '');
  const rows = CD.listView({ events, last: null, tz: TZ, from: per.from, to: per.to, q: '', changesOnly: false }).items.map((x) => x.row);
  return { per, rows, v: SA.todoView(Object.assign({}, inp, { from: per.from, to: per.to, rows })) };
};
let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('PASS ' + name);
};
const all = (v) => JSON.stringify(v);
const BANNED = /BAS cop(y|ies)|Least covered|Probably covered|check the group|another group/i;

t('week of Nov 16: the awards row with day, time, group and reason; later events are one count', () => {
  const { v } = periodOf('week', '2026-11-16', '2026-11-16');
  assert.strictEqual(v.todo.length, 2, 'the awards event and the weekly Club');
  const r = v.todo.filter((x) => /Awards/.test(x.head))[0];
  assert.strictEqual(r.head, 'Mon Nov 16, 6:30–8:00 PM: Awards Night in TS Commons');
  assert.strictEqual(r.doThis, 'Do this: in WebCTRL, group Area F, add a one-day schedule Mon Nov 16, 6:30–8:00 PM.');
  assert(/TS Commons is run by rooms F101A–F102C \(6 rooms, group Area F\)\. The schedule ends 4:00 PM; the event ends 8:00 PM \(90 min uncovered\)\./.test(r.why), r.why);
  assert(/A schedule with this event's name is in group Gyms, which does not run these rooms\./.test(r.why), r.why);
  assert.deepStrictEqual(v.later, { count: 2, from: '2026-11-23' }, 'the banquet and the spring show; the other Club dates are in the weekly row');
  assert(!v.todo.some((x) => /Banquet|Spring Show/.test(x.head)), 'no later event in the rows');
});

t('week of Nov 23: the banquet and the weekly Club, not the Nov 16 item', () => {
  const { v } = periodOf('week', '2026-11-23');
  assert(v.todo.some((x) => /Banquet/.test(x.head)));
  assert(!v.todo.some((x) => /Awards Night/.test(x.head)));
});

t('a weekly repeat is one row with its date count', () => {
  const { v } = periodOf('week', '2026-11-16', '2026-11-16');
  const club = v.todo.filter((x) => /Club/.test(x.head));
  assert.strictEqual(club.length, 1);
  assert.strictEqual(club[0].count, 4);
  assert(/^Every Thu, 6:00–8:00 PM: Club in TS Commons$/.test(club[0].head), club[0].head);
  assert(/a weekly schedule on Thu, 6:00–8:00 PM \(4 dates, Nov 19 – Dec 10\)/.test(club[0].doThis), club[0].doThis);
});

t('day view: only that day; month view: only that month; headline numbers equal the rows', () => {
  const d = periodOf('day', '2026-11-16', '2026-11-16').v;
  assert.strictEqual(d.todo.length, 1);
  const m = periodOf('month', '2026-12-01').v;
  assert.strictEqual(m.todo.length, 1, 'December: the weekly Club row');
  assert.strictEqual(m.todo[0].count, 4);
  assert.strictEqual(m.later.count, 1, 'the 2027 show');
});

t('badge and list agree for every event of the week', () => {
  const { per, rows, v } = periodOf('week', '2026-11-16', '2026-11-16');
  const inRows = {};
  v.todo.concat(v.done).forEach((r) => r.eventIds.forEach((id) => (inRows[id] = 1)));
  Object.keys(events).forEach((id) => {
    const row = events[id];
    const day = CD.calendarDay(row[1], TZ);
    if (day < per.from || day > per.to) return;
    const c = BC.describe(BC.coverageOf(row, ctx), ctx);
    const badgeSaysNot = /^Not covered/.test(c.label) && !c.covered;
    assert.strictEqual(!!inRows[id], badgeSaysNot, id + ': badge "' + c.label + '" and the to-do list disagree');
    assert.strictEqual(c.state === 'todo', badgeSaysNot);
    if (c.state === 'covered') assert(v.covered.some((x) => x.title === row[0].replace(/-\s*TS Commons$/, '').trim()), 'a covered event is in the covered list');
  });
  assert.strictEqual(rows.length, 3);
});

t('badge color: amber only for a to-do (the To do card rows)', () => {
  const pc = fs.readFileSync(path.join(__dirname, '..', 'app', 'project-calendar.js'), 'utf8');
  assert(/c\.state === 'todo' \? ' pcal-changed'/.test(pc) && !/suggest' \? ' pcal-changed'/.test(pc));
});

t('hover: plain words, the whole space, never one room of several', () => {
  const todo = BC.describe(BC.coverageOf(events.awards, ctx), ctx);
  assert.strictEqual(
    todo.hover,
    'Not covered. TS Commons is run by rooms F101A–F102C (6 rooms, group Area F). The schedule ends 4:00 PM; the event ends 8:00 PM (90 min uncovered). Change: in WebCTRL, group Area F, add Mon Nov 16, 6:30–8:00 PM.',
  );
  ROOMS.forEach((k) => assert(!new RegExp('room ' + k.split('Room ')[1] + '\\b').test(todo.hover), 'no single room named: ' + k));
  const cov = BC.describe(BC.coverageOf(events.day, ctx), ctx);
  assert.strictEqual(cov.hover, 'Covered by the BAS schedule, 6:00 AM–4:00 PM.');
  const g2 = JSON.parse(JSON.stringify(groups));
  g2['Test School|Area F'].schedules = [sched('Banquet', ALL, 1080, 1200)];
  const cg = BC.describe(BC.coverageOf(events.banquet, Object.assign({}, ctx, { groups: g2 })), Object.assign({}, ctx, { groups: g2 }));
  assert.strictEqual(cg.hover, 'Covered by Banquet in group Area F, 6:00–8:00 PM.');
});

t('a schedule added in WebCTRL after the BAS import (audit log) covers it: badge and list agree', () => {
  const edit = { ymd: '2026-11-14', iso: '2026-11-14T10:00:00', operator: 'Test Operator', type: 'Schedule added', building: 'Test School', area: "AREA 'F' SUMMARY", block: { days: ['Mon'], iv: [[1080, 1200]] } };
  const c = BC.describe(BC.coverageOf(events.awards, Object.assign({}, ctx, { scheduleEdits: [edit] })), Object.assign({}, ctx, { scheduleEdits: [edit] }));
  assert.strictEqual(c.covered, true);
  assert.strictEqual(c.state, 'edited');
  const v = SA.todoView(Object.assign({}, inp, { events: { awards: events.awards, day: events.day }, scheduleEdits: [edit], from: '2026-11-16', to: '2026-11-22', rows: [events.awards, events.day] }));
  assert.strictEqual(v.todo.length, 0);
  assert(v.covered.some((x) => /Awards Night/.test(x.title) && /added in WebCTRL on Sat Nov 14, 2026 by Test Operator/.test(x.reason)), all(v.covered));
});

t('no banned words in any text of the card, the hovers or the reasons', () => {
  [['week', '2026-11-16', '2026-11-16'], ['week', '2026-11-23'], ['month', '2026-12-01'], ['day', '2026-11-17']].forEach((a) => {
    const { rows, v } = periodOf(a[0], a[1], a[2]);
    assert(!BANNED.test(all(v)), 'banned word in the view: ' + (all(v).match(BANNED) || [])[0]);
    rows.forEach((r) => assert(!BANNED.test(BC.describe(BC.coverageOf(r, ctx), ctx).hover)));
  });
  assert(!BANNED.test(SA.copyNote({ snapFetchedAt: '2026-11-14T10:00:00Z', snaps, tz: TZ, today: '2026-11-16', auditLastDay: '2026-11-15', scheduleEdits: [] })));
});

t('the page files hold one decision: no allNamed, no second coverage path, one Done list', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ui = read('app/sched-actions.js');
  assert(!/allNamed|notCoveredLists|renderNotCovered|sact-nc/.test(ui + read('computations/sched-actions.js')));
  assert((ui.match(/class="btn btn-em btn-sm" onclick="sactSet/g) || []).length === 1, 'one Done button builder (the to-do rows)');
  assert(!/webctrlMatch/.test(ui + read('app/project-calendar.js')));
  const pc = read('app/project-calendar.js');
  assert(/feed last checked/.test(pc) && /The last automatic read ran/.test(pc), 'the sync line and the not-saved text');
});

console.log(pass + ' passed');
