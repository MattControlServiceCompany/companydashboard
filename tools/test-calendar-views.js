// tools/test-calendar-views.js - District Calendar views: Day / Week / Month / Year periods, the period filter, the Moved mark,
// the weekly-pattern line, and the "cannot compare" message. Run: node tools/test-calendar-views.js
// SYNTHETIC data only (made-up buildings, spaces and events).
'use strict';
const CD = require('../app/calendar-diff.js');
const SA = require('../computations/sched-actions.js');
const BC = require('../computations/bas-coverage.js');
let fails = 0;
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fails++;
    console.log('FAIL: ' + msg + '\n  got  ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b));
  } else console.log('PASS ' + msg);
}
const TZ = 'America/Chicago';
const z = (d, h, m) => new Date(d + 'T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00-06:00').toISOString();
const ev = (t, sp, d, h1, h2, m1, m2) => [t, z(d, h1, m1), z(d, h2, m2), 0, sp];
const events = {
  mon: ev('Mon meet', 'Gym A', '2026-11-02', 9, 10),
  thu: ev('Thu practice', 'Gym A', '2026-11-05', 17, 20, 0, 30),
  dec: ev('December concert', 'Hall B', '2026-12-17', 18, 20),
  past: ev('Old game', 'Gym A', '2026-10-27', 18, 20),
  brk: ['Fall break', '2026-11-06', '2026-11-12', 1, ''], // all day, Nov 6 - Nov 11
};
const view = (per, extra) => CD.listView(Object.assign({ events, last: null, tz: TZ, q: '', changesOnly: false }, per, extra || {}));

const week = view(CD.periodRange('week', '2026-11-03'));
eq(week.items.map((i) => i.key), ['mon', 'thu', 'brk'], 'week view: this week only, the December event and the past event are out');
eq(view(CD.periodRange('week', '2026-11-03'), { q: 'december' }).items.map((i) => i.key), ['dec'], 'search still reaches any date');
eq(view(CD.periodRange('day', '2026-11-05')).items.map((i) => i.key), ['thu'], 'day view: one day');
eq(view(CD.periodRange('month', '2026-11-03')).items.map((i) => i.key), ['mon', 'thu', 'brk'], 'month view: November events');
eq(view(CD.periodRange('year', '2026-11-03')).items.map((i) => i.key), ['past', 'mon', 'thu', 'brk', 'dec'], 'year view: every event of the year');
eq(view(CD.periodRange('week', '2026-10-27')).items.map((i) => i.key), ['past'], 'stepping back one week shows the past event');
eq(view(CD.periodRange('week', '2026-11-09')).items.map((i) => i.key + ':' + i.day), ['brk:2026-11-09'], 'a running all-day event is listed on the first day of the week');

// --- the marks: New / Moved / Changed / Canceled -----------------------------
eq(CD.markLabel('new', []), 'New', 'mark: new');
eq(CD.markLabel('canceled', []), 'Canceled', 'mark: canceled');
eq(CD.markLabel('changed', ['Time 3:15 PM – 4:30 PM → 4:00 PM – 5:00 PM']), 'Moved', 'mark: a time change is Moved');
eq(CD.markLabel('changed', ['Date Thu, Nov 5 → Mon, Nov 9']), 'Moved', 'mark: a date change is Moved');
eq(CD.markLabel('changed', ['Location BES Gym → LHS Main Gym']), 'Changed', 'mark: a place change is Changed');
eq(CD.markLabel('', []), '', 'mark: none');

// --- weekly pattern: one line, not one for each date ---------------------------
const L = '/Test District/Test Alpha Hall/Area 1';
const occ = (a, b) => [[0, a, 'unocc'], [a, b, 'occ'], [b, 0, 'unocc']];
const prog = L + '|Zone Gym';
const snaps = { '2026-10-29': { rows: { [prog]: occ(360, 1020) } }, '2026-10-30': { rows: { [prog]: occ(360, 1020) } } }; // Thu, Fri only
const map = { spaces: { 'tah gym': { space: 'TAH Gym', programs: [prog], confirmed: true } } };
const groups = { 'Test Alpha Hall|Evening': { building: 'Test Alpha Hall', group: 'Evening', schedules: [], members: ['Area 1 / Zone Gym'] } };
const thu = {};
['2026-11-05', '2026-11-12', '2026-11-19', '2026-12-03', '2026-12-10', '2026-12-17'].forEach((d, i) => (thu['t' + i] = ev('Practice - TAH Gym', '', d, 17, 20, 0, 30)));
thu.once = ev('Meeting - TAH Gym', '', '2026-12-18', 17, 20, 0, 30); // a Friday in December, one time
const inp = { events: thu, map, snaps, groups, tz: TZ, today: '2026-11-03' };
const inWeek = (from, to) => SA.periodNeeds(Object.assign({}, inp, { from, to }));
const n1 = inWeek('2026-11-02', '2026-11-08');
eq(n1.length, 1, 'week with the first Thursday: one line for the whole weekly pattern');
eq(n1[0].repeats, true, 'the line is marked as repeating');
eq(/^Every Thu, Nov 5 - Dec 17 \(6 dates\)\. Add once as a repeating schedule/.test(n1[0].dates), true, 'the line says every Thu and the count: ' + n1[0].dates);
eq(n1[0].change, 'Add 5:00 PM - 8:30 PM to group Evening', 'the change names the group and the span');
eq(/^Occupied 6:00 AM - 5:00 PM\. Source: /.test(n1[0].inBas), true, 'the line shows what the BAS has now: ' + n1[0].inBas);
eq(inWeek('2026-11-09', '2026-11-15').length, 1, 'the next week still lists the pattern');
eq(inWeek('2026-11-23', '2026-11-29').length, 0, 'a week with none of the dates: no line');
const dec = inWeek('2026-12-14', '2026-12-20');
eq(dec.length, 1, 'December week: the pattern and the one-time meeting are the same BAS change, one line');
eq(/Fri Dec 18/.test(dec[0].dates), true, 'the one-time date is listed in its own week: ' + dec[0].dates);
eq(inWeek('2026-11-02', '2026-11-08').some((x) => /Dec 18/.test(x.dates)), false, 'a one-time December date is not listed in a November week');

// --- cannot compare: never "nothing to change" when nothing was compared -------
const rows = (o) => Object.keys(o).map((k) => o[k]);
const real = { a: ev('Game - Gym A', '', '2026-11-02', 18, 20), b: ev('Game - Gym B', '', '2026-11-03', 18, 20), c: ev('Game - Gym B', '', '2026-11-05', 18, 20), d: ['Holiday', '2026-11-06', '2026-11-07', 1, ''] };
let st = BC.checkStatus(rows(real), { tz: TZ, map: null, snaps: {} });
eq([st.total, st.checked, st.uncheckable, st.copies], [4, 0, 3, 0], 'no map and no copy: nothing checked');
eq(st.reasons.some((r) => /^No BAS schedule copy is imported/.test(r)), true, 'reason: no BAS copy imported');
eq(st.reasons.some((r) => /^2 places are not matched to a BAS space \(3 events\)/.test(r)), true, 'reason: 2 places not mapped: ' + st.reasons.join(' | '));
eq(st.unmappedPlaces.map((u) => u.name + ':' + u.count), ['Gym B:2', 'Gym A:1'], 'unmapped places, most events first');
// copies for Thu and Fri only, a mapped place
const ctx = { tz: TZ, map, snaps };
const week2 = { m: ev('Mon - TAH Gym', '', '2026-11-02', 17, 19), t: ev('Thu - TAH Gym', '', '2026-11-05', 17, 19), f: ev('Fri - TAH Gym', '', '2026-11-06', 17, 19), s: ev('Sat - TAH Gym', '', '2026-11-07', 9, 11) };
st = BC.checkStatus(rows(week2), ctx);
eq([st.total, st.checked, st.noCopyDay, st.copyWeekdays], [4, 3, 1, ['Thu', 'Fri']], 'copies for Thu and Fri: Mon uses the Mon-Thu copy, Sat cannot be checked');
eq(st.reasons, ['Days with no BAS copy (Sat): 1 event cannot be checked. BAS copies exist for Thu, Fri (one copy covers Mon-Thu).'], 'reason: days with no BAS copy');
const sn = BC.snapshotForDate(snaps, '2026-11-03'); // a Tuesday, only Thu and Fri copies
eq([sn.date, sn.kind, BC.sourceText(sn)], ['2026-10-29', 'monthu', 'Mon-Thu schedule (Thu Oct 29, 2026 BAS copy)'], 'a Tuesday borrows the Thu copy and names it');
eq(BC.snapshotForDate({ '2026-10-29': snaps['2026-10-29'] }, '2026-11-06'), null, 'a Friday never borrows a Thursday copy');
eq(BC.snapshotForDate(snaps, '2026-11-07'), null, 'a Saturday never borrows a weekday copy');
st = BC.checkStatus([week2.t, week2.f], ctx);
eq([st.checked, st.uncheckable, st.reasons.length], [2, 0, 0], 'all events checkable: no reason');
// the whole view: the sentence must not say nothing needs to change
const pv = SA.periodView(Object.assign({}, inp, { events: week2, from: '2026-11-02', to: '2026-11-08', rows: rows(week2) }));
eq(pv.status.uncheckable > 0 || pv.status.noCopyDay > 0, true, 'periodView carries the cannot-compare counts');

// the cards never claim "Nothing needs to change" without a check: the UI text rule lives in app/sched-actions.js headline()
const fs = require('fs');
const ui = fs.readFileSync(__dirname + '/../app/sched-actions.js', 'utf8');
eq(/Nothing needs to change ' \+ where \+ '\. All/.test(ui), true, 'the all-clear text is built only after the checked count');
eq(/if \(!st\.checked\) return 'Cannot tell yet/.test(ui), true, 'nothing checked gives "Cannot tell yet"');
eq(ui.indexOf("if (!st.checked) return") < ui.indexOf("return 'Nothing needs to change"), true, 'the cannot-tell test runs before the all-clear text');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
