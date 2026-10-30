#!/usr/bin/env node
// tools/test-v189-fixes.js -- SYNTHETIC only. (1) pending-weather month regex in graphics-setpoints.js,
// (2) review bar link cap by width in bill-analysis.js, (3) manual event edits redraw both panels in district-calendar.js.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').split('\r\n').join('\n');
const fn = (src, name) => {
  let a = src.indexOf('async function ' + name + '(');
  if (a < 0) a = src.indexOf('function ' + name + '(');
  assert(a >= 0, 'missing ' + name);
  const b = src.indexOf('\n}\n', a) + 3;
  return src.slice(a, b);
};
let n = 0;
const ok = (m) => { n++; console.log('PASS ' + m); };
(async () => {
  // 1. regex literal on the wxPendingMonths line is a real year-month test
  const gs = read('app/graphics-setpoints.js');
  const line = gs.split('\n').find((l) => l.includes('wxPendingMonths(wx.cache'));
  const lit = line.match(/filter\(\(ym\) => (\/.*\/)\.test\(ym\)\)/);
  assert(lit, 'regex not found');
  const re = vm.runInNewContext(lit[1]);
  assert(re.test('2026-09') && !re.test('2026-9') && !re.test('d{4}-d{2}'));
  ok('pending weather month regex matches 2026-09');

  // 2. review bar cap
  const ba = read('app/bill-analysis.js');
  const links = [0, 1, 2].map((i) => ({ i, k: 0, it: { text: 'issue' + i, level: 'err', kind: 'x' } }));
  const ctx = {
    window: { innerWidth: 640 },
    _mbReviewSummary: () => ({ total: 3, ready: 1, issues: 3, saved: 0, skipped: 0, links, disabled: false, title: 't', toSave: 1 }),
    _pdfCountWord: (c, w) => c + ' ' + w, _pdfBuildingName: () => 'B', _pdfCommOf: () => 'Elec', _billPeriodLabel: () => 'Jan', _mbBillNo: (i) => i + 1,
    _escHtml: (s) => String(s), _pdfMultiBills: [],
  };
  ctx.window._pdfMultiBills = [{}, {}, {}];
  vm.createContext(ctx);
  vm.runInContext(fn(ba, '_mbReviewMax') + fn(ba, '_mbReviewBarHtml'), ctx);
  const count = (w) => { ctx.window.innerWidth = w; const h = vm.runInContext('_mbReviewBarHtml()', ctx); return [(h.match(/class="pdf-rb-link[ "]/g) || []).length, /\+(\d+) more issues/.exec(h)]; };
  let r = count(640); assert.strictEqual(r[0], 1); assert.strictEqual(r[1][1], '2');
  r = count(799); assert.strictEqual(r[0], 1);
  r = count(800); assert.strictEqual(r[0], 3); assert.strictEqual(r[1], null);
  r = count(1280); assert.strictEqual(r[0], 3);
  ok('review bar: 1 link under 800 px, 3 at 800 and wider');

  // 3. manual event add/edit/delete redraw both panels
  const dc = read('app/district-calendar.js');
  const calls = [];
  const c3 = {
    projects: [{ id: 5, districtCalendar: [{ id: 1, date: '2026-01-01' }] }], sset() {}, renderDistCalTable: () => calls.push('table'),
    distCalRefreshBas: () => calls.push('bas'), Date, Promise,
    window: { sactRender: (p) => calls.push('sact' + p), basRender: (p) => calls.push('hist' + p), sactPersist: async () => calls.push('persist') },
  };
  vm.createContext(c3);
  vm.runInContext(fn(dc, 'distCalRefreshPanels') + fn(dc, 'distCalAddRow') + fn(dc, 'distCalUpdate') + fn(dc, 'distCalRemove'), c3);
  await vm.runInContext('distCalUpdate(5,0,"name","x")', c3);
  assert(calls.includes('sact5') && calls.includes('hist5') && calls.indexOf('persist') < calls.indexOf('sact5'));
  calls.length = 0; vm.runInContext('distCalAddRow(5)', c3);
  assert(calls.includes('sact5') && calls.includes('hist5'));
  calls.length = 0; await vm.runInContext('distCalRemove(5,0)', c3);
  assert(calls.includes('sact5') && calls.includes('hist5'));
  ok('manual event add/edit/delete redraws What needs to change and History');
  console.log(n + ' passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
