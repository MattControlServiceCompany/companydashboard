'use strict';
// Tests for CalendarDiff.eventPlace. Synthetic titles only.
// Run: node tools/test-event-place.js
const assert = require('assert');
const path = require('path');
const { eventPlace } = require(path.join(__dirname, '..', 'app', 'calendar-diff.js'));
const cases = [
  ['location field present', { title: 'Band Practice- Room 1', location: ' Hall 9 ' }, { text: 'Hall 9', fromTitle: false }],
  ['Practice- Main Gym', { title: 'Team Practice- Main Gym', location: '' }, { text: 'Main Gym', fromTitle: true }],
  ['last hyphen wins', { title: 'A - B - Room 12' }, { text: 'Room 12', fromTitle: true }],
  ['no hyphen', { title: 'Open House', location: null }, { text: '', fromTitle: false }],
  ['hyphen at end', { title: 'Open House -  ' }, { text: '', fromTitle: false }],
];
let fail = 0;
for (const [n, ev, want] of cases) {
  try {
    assert.deepStrictEqual(eventPlace(ev), want);
    console.log('PASS ' + n);
  } catch (e) {
    fail++;
    console.log('FAIL ' + n + ' -> ' + e.message);
  }
}
console.log(cases.length - fail + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
