// Tests for the District Calendar view logic: CalendarDiff.listView (date range, badges, canceled rows).
// Run: node tools/test-calendar-upcoming.js   (synthetic events only)
const path = require('path');
const D = require(path.join(__dirname, '..', 'app', 'calendar-diff.js'));
let fails = 0;
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + msg + (ok ? '' : '  got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)));
}
const TZ = 'America/Chicago';
const T = '2026-10-29';
const z = (d, h, m) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00-05:00`).toISOString();
const old = {
  window: { start: '2025-01-01T00:00:00.000Z', end: '2028-01-01T00:00:00.000Z' },
  events: {
    a: ['Past game', z('2026-10-27', 15), z('2026-10-27', 16), 0, 'Gym'],
    b: ['Concert', z('2026-10-30', 15, 15), z('2026-10-30', 16, 30), 0, 'BES Gym'],
    c: ['Staff day', '2026-11-02', '2026-11-03', 1, ''],
    d: ['Cut event', z('2026-10-31', 10), z('2026-10-31', 11), 0, 'Room 1'],
    e: ['Far event', z('2026-12-10', 10), z('2026-12-10', 11), 0, ''],
    f: ['Today meet', z('2026-10-29', 9), z('2026-10-29', 10), 0, 'Office'],
  },
};
const cur = JSON.parse(JSON.stringify(old));
cur.events.b = ['Concert', z('2026-10-30', 16), z('2026-10-30', 17), 0, 'LHS Main Gym'];
cur.events.f = ['Today meet', z('2026-10-29', 9), z('2026-10-29', 10), 0, 'Annex'];
delete cur.events.d;
cur.events.g = ['New thing', z('2026-10-29', 18), z('2026-10-29', 19), 0, ''];
cur.events.h = ['New later', z('2026-11-20', 18), z('2026-11-20', 19), 0, ''];
const rec = D.historyRecord(D.diffSnapshots(old, cur), 'x', 'id1');
const base = { events: cur.events, last: rec, tz: TZ, today: T, mode: 'next14', month: '2026-10', q: '', changesOnly: false };

let v = D.listView(base);
eq(v.items.map((i) => i.key), ['f', 'g', 'b', 'd', 'c'], 'next 14 days: today forward, canceled in its slot, no past, no far dates');
eq(v.counts, { new: 1, changed: 2, canceled: 1 }, 'counts in the next 14 days (h is outside)');
eq(v.items.map((i) => i.status), ['changed', 'new', 'changed', 'canceled', ''], 'badges per event');
eq(v.items[2].lines, ['Time 3:15 PM \u2013 4:30 PM \u2192 4:00 PM \u2013 5:00 PM', 'Location BES Gym \u2192 LHS Main Gym'], 'changed event lines (time, location)');
eq(v.items[0].lines, ['Location Office \u2192 Annex'], 'location only change');
eq(D.timeText(cur.events.c, TZ), 'All day', 'all-day text');
eq(D.dayLabel(T), 'Thu, Oct 29', 'day header');
v = D.listView(Object.assign({}, base, { changesOnly: true }));
eq(v.items.map((i) => i.key), ['f', 'g', 'b', 'd'], 'changes only: just the badged events');
eq(v.items.every((i) => i.status), true, 'changes only: every row has a badge');
v = D.listView(Object.assign({}, base, { mode: 'past' }));
eq(v.items.map((i) => i.key), ['a'], 'past: only before today');
v = D.listView(Object.assign({}, base, { mode: 'month', month: '2026-11' }));
eq(v.items.map((i) => i.key), ['c', 'h'], 'month view: November only');
v = D.listView(Object.assign({}, base, { q: 'far' }));
eq(v.items.map((i) => i.key), ['e'], 'search reaches any date');
v = D.listView(Object.assign({}, base, { last: { first: true, counts: {} } }));
eq([v.compared, v.items.every((i) => !i.status)], [false, true], 'first sync: no compare, no badges');
// multi-day all-day event that began before today still shows
const ev2 = { m: ['Break', '2026-10-27', '2026-10-31', 1, ''] };
v = D.listView({ events: ev2, last: null, tz: TZ, today: T, mode: 'next14', month: '', q: '', changesOnly: false });
eq([v.items.length, v.items[0] && v.items[0].day], [1, T], 'running all-day event listed under today');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
