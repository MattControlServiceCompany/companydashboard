#!/usr/bin/env node
// tools/test-weather-on-load.js -- SYNTHETIC only (fake ZIP 00000). Owner: computations/weather-refresh.js + app/utility-data.js.
// Cases: pending-month notice text; skip rule makes no API call; wddRefreshAllProjectsWeather covers every project ZIP once.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const REPO = path.join(__dirname, '..');
const sb = { console, Math, Date, JSON, parseFloat, parseInt, Number, Promise, Set, Map, String, Array, Object, RegExp };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/weather-refresh.js'), 'utf8'), sb);
const label = (ym) => ym;
let n = 0; const ok = (m, f) => { f(); n++; console.log('PASS ' + m); };
ok('pending months: only months newer than newest stored', () => {
  const p = sb.wxPendingMonths([{ ym: '2026-07' }, { ym: '2026-08' }], ['2026-06', '2026-08', '2026-09', '2026-09']);
  assert.deepStrictEqual(Array.from(p), ['2026-09']);
  assert.strictEqual(sb.wxPendingNotice(p, (y) => 'Sep 2026'), 'Weather for Sep 2026 not yet available');
  assert.strictEqual(sb.wxPendingNotice([], label), '');
  assert.deepStrictEqual(Array.from(sb.wxPendingMonths([], ['2026-09'])), []);
});
ok('skip rule: newest stored = last complete month -> no fetch', async () => {});
(async () => {
  let calls = 0;
  const now = new Date(2026, 9, 30);
  const deps = { loadFn: () => [{ ym: '2026-09', hdd: 0, cdd: 1, avgTemp: 70 }], saveFn() {}, fetchFn: async () => { calls++; throw new Error('x'); }, now };
  assert.strictEqual(await sb.wxRefreshZip('00000', deps), null);
  assert.strictEqual(calls, 0); n++; console.log('PASS skip rule makes no call');
  // wddRefreshAllProjectsWeather: load the real functions from app/utility-data.js with stubs
  const src = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8').split('\r\n').join('\n');
  const a = src.indexOf('const _wddRefreshTried'), b = src.indexOf('function wddSetStatus(');
  const fetched = [];
  const ctx = { console, Set, Promise, Date, String, Array, RegExp, wxProjectZips: sb.wxProjectZips, wxRefreshZip: async (z) => { fetched.push(z); return null; },
    sget: () => [{ id: 1 }, { id: 2 }, { id: 3 }], getUDBldgs: (pid) => ({ 1: [{ zip: '00000' }], 2: [{ zip: '00000' }, { zip: '00001' }], 3: [] })[pid],
    wddLoadCache() { return []; }, wddSaveCache() {}, fetch() {}, projects: [], window: undefined, renderMeterWorkspace() {} };
  vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx);
  await ctx.wddRefreshAllProjectsWeather();
  assert.deepStrictEqual(fetched.sort(), ['00000', '00001']);
  await ctx.wddRefreshAllProjectsWeather();
  assert.strictEqual(fetched.length, 2); n++; console.log('PASS all-project ZIPs once per page load (2 ZIPs, repeat = 0 more)');
  console.log(n + ' passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
