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
  ['hyphen in word', { title: 'Teacher in-service' }, { text: '', fromTitle: false }],
  ['K-12 night', { title: 'K-12 Parent Night' }, { text: '', fromTitle: false }],
  ['Pre-K screening', { title: 'Pre-K Screening' }, { text: '', fromTitle: false }],
  ['Mid-Winter concert', { title: 'Mid-Winter Concert' }, { text: '', fromTitle: false }],
  ['JV/Varsity', { title: 'JV/Varsity Game' }, { text: '', fromTitle: false }],
  ['in-service at place', { title: 'Teacher in-service @ Library' }, { text: 'Library', fromTitle: true }],
  ['glued capital place', { title: 'Cheer Practice-Cheer Area' }, { text: 'Cheer Area', fromTitle: true }],
  ['hyphen then space', { title: 'Open Gym- Main Gym' }, { text: 'Main Gym', fromTitle: true }],
  ['word hyphen then place', { title: 'Pre-K Night- Room 4' }, { text: 'Room 4', fromTitle: true }],
  ['at sign', { title: 'Concert @ Auditorium' }, { text: 'Auditorium', fromTitle: true }],
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
