// tools/test-calendar-escaping.js - feed and user text must never reach the page as raw tags.
// SYNTHETIC data only. Run: node tools/test-calendar-escaping.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL: ' + m); } };
const EVIL = '"><img src=x onerror=alert(1)>';
const els = {};
const el = (id) => (els[id] = els[id] || { innerHTML: '', style: {}, value: '' });
const sb = {
  window: {},
  document: { getElementById: el },
  projects: [{ id: 1, districtCalendar: [
    { id: EVIL, date: EVIL, start: EVIL, end: EVIL, name: EVIL, space: EVIL, type: EVIL },
    { id: 'b', date: '2026-10-05', name: EVIL, type: 'Holiday' },
  ] }],
  DB: { get: (k, d) => d },
  CalendarDiff: { manualRows: () => ({}) },
  pcalBasCell: () => '',
  pcalHasFeed: () => false,
  console,
};
vm.createContext(sb);
vm.runInContext(read('lib/formatting.js'), sb);
vm.runInContext(read('app/district-calendar.js') + '\nthis.renderDistCalTable = renderDistCalTable; this.dcEventsSet = (a) => { dcEvents = a; };', sb);
const raw = /<img\s/i;
sb.renderDistCalTable(1);
ok(els['distcal-table-1'] && els['distcal-table-1'].innerHTML.length > 100, 'list view rendered');
ok(!raw.test(els['distcal-table-1'].innerHTML), 'list view has no raw tag from id/date/summary/space');
ok(els['distcal-table-1'].innerHTML.includes('&lt;img'), 'list view shows the text escaped');
sb.window._distCalView = { 1: 'calendar' };
sb.projects[0].districtCalendar[0].date = '2026-10-04';
sb.renderDistCalTable(1);
ok(!raw.test(els['distcal-table-1'].innerHTML), 'calendar view has no raw tag');
// other files: every feed/user text insert goes through esc()
for (const f of ['app/space-map.js', 'app/sched-actions.js']) {
  const src = read(f);
  ok(/function esc\(s\)[\s\S]{0,80}_escHtml/.test(src), f + ' esc() calls _escHtml');
  ok(!/\+\s*(r\.space|a\.text|a\.note|who|f\.program|f\.building)\s*\+/.test(src), f + ' has no bare text concatenation');
}
console.log(fails ? fails + ' FAILED' : 'calendar escaping: all passed');
process.exit(fails ? 1 : 0);
