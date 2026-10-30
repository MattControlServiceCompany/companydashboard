'use strict';
// Tests for the misc first-use fixes (District Calendar BAS card, tab bar, Energy Savings headings).
// Synthetic data only. No network, no browser. Run: node tools/test-misc-first-use.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
let fail = 0;
function t(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL ' + name);
  }
}

// --- load the real BAS card with stubs ---
const host = { innerHTML: '' };
const store = {};
const win = {};
const ctx = {
  window: win,
  console,
  Date,
  _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  document: { getElementById: (id) => (id === 'bas-panel-7' ? host : null), createElement: () => ({}), head: { appendChild: () => {} } },
  DB: { get: (k, d) => (k in store ? store[k] : d), set: async (k, v) => { store[k] = v; } },
  BasDiff: require(path.join(ROOT, 'app', 'bas-diff.js')),
  emParseEffectiveSchedulesCSV: () => [{ scheduleText: 'x' }],
  _emScheduleBlocks: () => [[480, 1020, 'On']],
};
win.pcalUi = {
  num: (n) => String(n),
  ensureStyle: () => {},
  table: (cols, rows) => '<table>' + rows.map((r) => '<tr>' + r.join('|') + '</tr>').join('') + '</table>',
};
ctx.window = win;
vm.createContext(ctx);
vm.runInContext(rd('app/bas-schedules.js'), ctx);

// #7 date defaults to today and the message sits by the date field
const d = new Date();
const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fakeInput = { files: [{ name: 'a.csv', text: () => Promise.resolve('x') }], value: '' };
(async () => {
  win.basPick(7, fakeInput);
  await new Promise((r) => setTimeout(r, 20));
  t('7 date field starts at today', host.innerHTML.indexOf('type="date" id="bas-for-7" value="' + today + '"') >= 0);
  win.basSetDate(7, '');
  await win.basSave(7);
  const i = host.innerHTML.indexOf('id="bas-for-7"');
  const j = host.innerHTML.indexOf('Choose the date this export covers');
  t('7 error shown after the date field', i >= 0 && j > i);
  t('7 error is below the table not in top status line', host.innerHTML.indexOf('<table>') < i);

  // #19 program list closed by default
  store['en_bas_snap_7'] = { '2026-01-05': { forDate: '2026-01-05', rows: { 'Bldg A|Prog 1': [[480, 1020, 'On']], 'Bldg A|Prog 2': [[480, 1020, 'On']] } } };
  win.basCancel(7);
  t('19 program list is a closed details with a count label', /<details ontoggle=[^>]*><summary>2 programs<\/summary>/.test(host.innerHTML));
  win.basToggle(7, true);
  win.basCancel(7);
  t('19 stays open after the user opens it', /<details open ontoggle/.test(host.innerHTML));

  // #6 history heading
  store['en_bas_hist_7'] = [{ id: 'h', kind: 'schedules', at: '2026-01-06T10:00:00Z', forDate: '2026-01-06', comparedTo: '2026-01-05', counts: { total: 1, added: 0, removed: 0, changed: 1 }, buildings: [], byBuilding: {}, added: [], removed: [], changed: [] }];
  win.basCancel(7);
  t('6 heading says differences from the previous saved day', host.innerHTML.indexOf('<summary>Differences from the previous saved day (1)</summary>') >= 0);
  t('6 old BAS changes heading is gone', host.innerHTML.indexOf('>BAS changes (') < 0);

  // #5, #8 text on the District Calendar tab
  const core = rd('app/core.js');
  t('5 tab says what to do', core.indexOf('Check that each school event has a matching BAS schedule: compare the feed (top) with BAS schedules (below).') >= 0);
  t('8 manual card subtitle', core.indexOf('Only for events that are not in the feed') >= 0);
  t('8 no CORS wording', core.indexOf('If blocked by CORS') < 0 && core.indexOf('If the link does not load, use PDF Upload') >= 0);

  // #25 headings have hover text
  const es = rd('app/energy-savings.js');
  ['kWh $/S', 'kWh $/W', 'kW $/S', 'kW $/W', '$/Therm', '$/Gallon', 'Msr #'].forEach((h) => {
    t('25 ' + h + ' has title', new RegExp('title="[^"]+">' + h.split('').map((c) => (/[A-Za-z0-9 #]/.test(c) ? c : String.fromCharCode(92) + c)).join('') + '</th>').test(es));
  });
  console.log('test-misc-first-use: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
