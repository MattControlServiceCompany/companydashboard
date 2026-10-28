'use strict';
// All-day event dates. Synthetic events only.
// Run: TZ=America/Chicago node tools/test-calendar-allday.js ; TZ=UTC node tools/test-calendar-allday.js
const assert = require('assert');
const path = require('path');
const { calendarDay, allDayLastDay } = require(path.join(__dirname, '..', 'app', 'calendar-diff.js'));
const CT = 'America/Chicago';
const cases = [
  ['date-only start is the same calendar day', () => assert.strictEqual(calendarDay('2026-10-20', CT, true), '2026-10-20')],
  ['server midnight Central (all-day) is Oct 20', () => assert.strictEqual(calendarDay('2026-10-20T05:00:00.000Z', CT, true), '2026-10-20')],
  ['timed 6:00 AM Central stays Oct 20', () => assert.strictEqual(calendarDay('2026-10-20T11:00:00.000Z', CT, false), '2026-10-20')],
  ['timed 11 PM Central stays Oct 20', () => assert.strictEqual(calendarDay('2026-10-21T04:00:00.000Z', CT, false), '2026-10-20')],
  ['1-day event: last day = start day (date-only)', () => assert.strictEqual(allDayLastDay('2026-10-20', '2026-10-21', CT), '2026-10-20')],
  ['1-day event: last day = start day (server ISO)', () => assert.strictEqual(allDayLastDay('2026-10-20T05:00:00.000Z', '2026-10-21T05:00:00.000Z', CT), '2026-10-20')],
  ['3-day break 12-21..12-23 (date-only)', () => assert.strictEqual(allDayLastDay('2026-12-21', '2026-12-24', CT), '2026-12-23')],
  ['3-day break 12-21..12-23 (server ISO)', () => assert.strictEqual(allDayLastDay('2026-12-21T06:00:00.000Z', '2026-12-24T06:00:00.000Z', CT), '2026-12-23')],
  ['no end: last day = start day', () => assert.strictEqual(allDayLastDay('2026-10-20', null, CT), '2026-10-20')],
];
let fail = 0;
for (const [n, f] of cases) {
  try { f(); console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + ' -> ' + e.message); }
}
console.log(cases.length - fail + ' passed, ' + fail + ' failed (TZ=' + (process.env.TZ || 'default') + ')');
process.exit(fail ? 1 : 0);
