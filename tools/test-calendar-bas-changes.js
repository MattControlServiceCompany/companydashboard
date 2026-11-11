// tools/test-calendar-bas-changes.js - the "BAS changes" section of the Calendar tab: rows from a stored audit log, order,
// the 30 day range, the empty state, set point words, operator names, escaping.
// SYNTHETIC data only (made-up district, buildings, rooms and people). Run: node tools/test-calendar-bas-changes.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BAL = require('../app/bas-audit-log.js');
const CD = require('../app/calendar-diff.js');
let fails = 0;
const ok = (c, m) => {
  if (!c) {
    fails++;
    console.log('FAIL: ' + m);
  } else console.log('PASS ' + m);
};

// Days are counted back from the real today, so the 30 day range is tested for real.
const TZ = 'America/Chicago';
const today = CD.calendarDay(new Date().toISOString(), TZ);
const back = (n) => {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// M/D/YYYY h:mm:ss AM/PM, the format of the WebCTRL export
const us = (ymd, hms) => {
  const [y, m, d] = ymd.split('-');
  let [h, mi, s] = hms.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return +m + '/' + +d + '/' + y + ' ' + h + ':' + String(mi).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ' ' + ap;
};
const D = '/Test District/';
const block = (nm, days, a, b) => 'schedule "' + nm + '"\nType "Weekly"\ndays: ' + days + '\nAt "' + a + '" set "Occupied"\nAt "' + b + '" set "Unoccupied"';
const rows = [
  ['Date', 'Description', 'Details', 'Location', 'Operator'],
  // the export is newest first
  [us(back(1), '17:35:02'), 'Edit', 'x/occupied_heating changed from "68" to "66"\nx/occupied_cooling changed from "72" to "73"', D + 'Alpha School/Area B/Room 12', 'Test Person One'],
  [us(back(3), '09:05:00'), 'Update schedule', block('Main', 'Mon Tue Wed Thu Fri', '6:00', '16:00') + '\nNew values:\n' + block('Main', 'Mon Tue Wed Thu Fri', '7:00', '17:30'), D + 'Beta Hall', 'Test Person Two'],
  [us(back(10), '08:00:00'), 'Add schedule', block('Gym', 'Sat', '8:00', '12:00'), D + 'Beta Hall', 'Test Person Two'],
  [us(back(20), '23:59:59'), 'Edit', 'x/occupied_heating changed from "70" to "69"', D + 'Alpha School/Area A/Room 3', 'Test Person One'],
  [us(back(45), '10:00:00'), 'Delete schedule', block('Old', 'Sun', '9:00', '10:00'), D + 'Alpha School', 'Test Person Two'],
  [us(back(2), '10:00:00'), 'Alarm Acknowledged', 'Something', D + 'Alpha School/Area A/Room 3', 'Test Person One'],
];
const parsed = BAL.parseRows(rows);
ok(!parsed.error, 'synthetic audit rows parse');
const store = BAL.mergeStore(null, parsed.events, parsed.lastDay);

// --- BasAuditLog.changeList (the one reader) ------------------------------------
const all = BAL.changeList(store, { today, days: 0 });
ok(all.has && all.rows.length === 5, 'all range lists the 5 schedule and set point events, not the alarm row (got ' + all.rows.length + ')');
const r30 = BAL.changeList(store, { today, days: 30 });
ok(r30.rows.length === 4, 'last 30 days drops the event 45 days old (got ' + r30.rows.length + ')');
ok(r30.rows.map((r) => r.ymd).join() === [back(1), back(3), back(10), back(20)].join(), 'newest first: ' + r30.rows.map((r) => r.ymd).join());
const r5 = BAL.changeList(store, { today, days: 5 });
ok(r5.rows.length === 2, 'last 5 days has 2 events');
ok(r30.rows[0].what === 'Occupied heating 68°F → 66°F; Occupied cooling 72°F → 73°F', 'set point words: ' + r30.rows[0].what);
ok(r30.rows[0].building === 'Alpha School' && r30.rows[0].area === 'Area B / Room 12', 'building and area from BasDiff: ' + r30.rows[0].building + ' | ' + r30.rows[0].area);
ok(r30.rows[0].operator === 'Test Person One' && r30.rows[1].operator === 'Test Person Two', 'operator names come back from the stored table');
ok(
  r30.rows[1].what === 'Main: Mon Tue Wed Thu Fri, occupied 6:00 AM to 4:00 PM → Main: Mon Tue Wed Thu Fri, occupied 7:00 AM to 5:30 PM',
  'schedule update words: ' + r30.rows[1].what,
);
ok(r30.rows[2].type === 'Schedule added' && r30.rows[2].what === 'Gym: Sat, occupied 8:00 AM to 12:00 PM', 'schedule add words: ' + r30.rows[2].what);
ok(all.rows[4].type === 'Schedule deleted', 'schedule delete type');
ok(BAL.changeList(null, { today, days: 30 }).has === false && BAL.changeList({ events: [] }, {}).has === false, 'no store or no events: has is false');
const oldStore = Object.assign({}, store);
delete oldStore.ops;
ok(BAL.changeList(oldStore, { today, days: 30 }).rows[0].operator === '', 'a store without names gives an empty operator');
const again = BAL.mergeStore(oldStore, parsed.events, parsed.lastDay);
ok(again.events.length === store.events.length && again.ops && Object.keys(again.ops).length === 2, 'import again: same events, names filled in');

// --- the rendered section ------------------------------------------------------
const els = {};
const el = (id) => (els[id] = els[id] || { innerHTML: '', style: {}, value: '' });
let kv = { en_bas_auditevents_7: store };
const sb = {
  window: { addEventListener() {}, BasAuditLog: BAL },
  document: { getElementById: el, createElement: () => ({}), head: { appendChild() {} }, querySelectorAll: () => [] },
  DB: { get: (k, d) => (k in kv ? kv[k] : d) },
  CalendarDiff: CD,
  BasAuditLog: BAL,
  BasDiff: require('../app/bas-diff.js'),
  console,
};
vm.createContext(sb);
vm.runInContext(read('lib/formatting.js'), sb);
vm.runInContext(read('app/project-calendar.js'), sb);
sb.window.pcalBasRender(7);
let html = els['pcal-bas-7'].innerHTML;
const bodyRows = (h) => (h.split('<tbody>')[1] || '').split('<tr>').length - 1;
ok(/BAS changes/.test(html), 'section title');
ok(bodyRows(html) === 4 && /selected>Last 30 days/.test(html), 'default range is 30 days: 4 body rows, range select shows "Last 30 days"');
const order = [...html.matchAll(/<td>([A-Z][a-z]{2} \d+, \d{4} [\d:]+ [AP]M)<\/td>/g)].map((m) => m[1]);
ok(order.length === 4 && /5:35 PM/.test(order[0]) && /9:05 AM/.test(order[1]) && /8:00 AM/.test(order[2]) && /11:59 PM/.test(order[3]), 'times in 12 hour text, newest first: ' + order.join(' | '));
ok(html.includes('Occupied heating 68°F → 66°F') && html.includes('Test Person One') && html.includes('Area B / Room 12'), 'row text shows set point change, operator and location');
ok(html.includes('Whole building'), 'a building level schedule shows "Whole building"');
sb.window.pcalBasRange(7, '0');
html = els['pcal-bas-7'].innerHTML;
ok(bodyRows(html) === 5, 'range "All stored changes" shows 5 rows');
kv = {};
sb.window.pcalBasRender(7);
html = els['pcal-bas-7'].innerHTML;
ok(/No WebCTRL audit log is imported/.test(html) && /Import audit log/.test(html) && !/<table/.test(html), 'empty state names the Import audit log button');
kv = { en_bas_auditevents_7: oldStore };
sb.window.pcalBasRange(7, '30');
html = els['pcal-bas-7'].innerHTML;
ok(/>Not saved<\/span>/.test(html) && /Import the audit log file again/.test(html), 'a store without names says Not saved and tells the person to import again');
const evil = BAL.parseRows([rows[0], [us(back(1), '10:00:00'), 'Edit', 'x/occupied_heating changed from "1" to "2"', D + '<img src=x onerror=1>/Room', '<b>Op</b>']]);
kv = { en_bas_auditevents_7: BAL.mergeStore(null, evil.events, back(1)) };
sb.window.pcalBasRender(7);
html = els['pcal-bas-7'].innerHTML;
ok(!/<img\s/i.test(html) && !/<b>Op/.test(html) && html.includes('&lt;img'), 'location and operator text is escaped');
sb.window.pcalBasRange(7, '90');
ok(/value="90" selected/.test(els['pcal-bas-7'].innerHTML), 'range change is remembered and drawn');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
