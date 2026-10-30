'use strict';
// Tests: calendar auto-sync on tab open, and marks that last (synthetic data only).
// Run: node tools/test-calendar-auto-sync.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require(path.join(__dirname, '..', 'app', 'calendar-diff.js'));
let fails = 0;
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + msg + (ok ? '' : '  got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)));
}
const NOW = Date.parse('2026-10-29T18:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const SIGNED = 'x1';
const H = 3600000, DAY = 86400000;
const cfg = { icsUrl: 'https://example.test/none.ics', timezone: 'America/Chicago' };

// 1. needsAutoSync rule
eq(D.needsAutoSync({ cfg, token: SIGNED, snap: { fetchedAt: iso(2 * H) }, nowMs: NOW }), true, 'stale copy -> sync');
eq(D.needsAutoSync({ cfg, token: SIGNED, snap: { fetchedAt: iso(10 * 60000) }, nowMs: NOW }), false, 'fresh copy -> no sync');
eq(D.needsAutoSync({ cfg, token: SIGNED, snap: null, nowMs: NOW }), true, 'no copy -> sync');
eq(D.needsAutoSync({ cfg: null, token: SIGNED, snap: null, nowMs: NOW }), false, 'no feed -> no sync');
eq(D.needsAutoSync({ cfg, token: '', snap: null, nowMs: NOW }), false, 'not signed in -> no sync');

// 2. pcalAutoSync in the real module with stubs: counts fetch calls
function run(snap, cfgv, token, opens) {
  const store = { en_cal_cfg_1: cfgv, en_cal_snap_1: snap, en_cal_hist_1: [] };
  let calls = 0;
  const el = { innerHTML: '', textContent: '' };
  const win = { CH_AUTH: { getToken: () => token } };
  const ctx = {
    window: win, CalendarDiff: D, console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat, setTimeout,
    _escHtml: (x) => String(x),
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
    DB: { get: (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]), set: async (k, v) => { store[k] = v; } },
    fetch: async () => { calls++; return { ok: true, json: async () => ({ ok: true, snapshot: { fetchedAt: new Date().toISOString(), count: 0, window: {}, events: {} } }) }; },
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'project-calendar.js'), 'utf8'), ctx);
  return (async () => {
    for (let i = 0; i < opens; i++) await win.pcalAutoSync(1);
    return calls;
  })();
}
(async () => {
  eq(await run({ fetchedAt: iso(3 * H), count: 0, events: {} }, cfg, SIGNED, 1), 1, 'stale snapshot -> fetch called once');
  eq(await run({ fetchedAt: iso(3 * H), count: 0, events: {} }, cfg, SIGNED, 2), 1, 'double render -> still one call');
  eq(await run({ fetchedAt: new Date().toISOString(), count: 0, events: {} }, cfg, SIGNED, 1), 0, 'fresh snapshot -> no fetch');
  eq(await run(null, null, SIGNED, 1), 0, 'no feed -> no fetch');
  eq(await run({ fetchedAt: iso(3 * H), count: 0, events: {} }, cfg, '', 1), 0, 'signed out -> no fetch');

  // 2b. sync on load without the tab open (event dbFullPull), no timers
  async function load(projs, store0) {
    const store = Object.assign({ en_projects: projs, en_cal_hist_1: [] }, store0);
    let calls = 0, timers = 0, handler = null;
    const win = { CH_AUTH: { getToken: () => SIGNED }, addEventListener: (n, f) => { if (n === 'dbFullPull') handler = f; } };
    const ctx = {
      window: win, CalendarDiff: D, console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat,
      setTimeout: () => { timers++; }, setInterval: () => { timers++; },
      _escHtml: (x) => String(x),
      document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
      DB: { get: (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]), set: async (k, v) => { store[k] = v; } },
      fetch: async () => { calls++; return { ok: true, json: async () => ({ ok: true, snapshot: { fetchedAt: new Date().toISOString(), count: 0, window: {}, events: {} } }) }; },
    };
    ctx.window.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'project-calendar.js'), 'utf8'), ctx);
    if (!handler) return { calls: -1, timers };
    await handler();
    await new Promise((r) => setImmediate(r));
    return { calls, timers };
  }
  const stale = { fetchedAt: iso(3 * H), count: 0, events: {} };
  const fresh = { fetchedAt: new Date().toISOString(), count: 0, events: {} };
  let r = await load([{ id: 1 }], { en_cal_cfg_1: cfg, en_cal_snap_1: stale });
  eq(r, { calls: 1, timers: 0 }, 'load, tab closed, stale copy -> one sync, no timers');
  r = await load([{ id: 1 }], { en_cal_cfg_1: cfg, en_cal_snap_1: fresh });
  eq(r, { calls: 0, timers: 0 }, 'load, copy < 1 h old -> no sync');
  r = await load([{ id: 1 }], {});
  eq(r, { calls: 0, timers: 0 }, 'load, no feed -> no sync');
  r = await load([{ id: 1 }, { id: 2 }], { en_cal_cfg_1: cfg, en_cal_snap_1: stale, en_cal_cfg_2: cfg, en_cal_snap_2: stale });
  eq(r.calls, 2, 'two projects with feeds -> two syncs');

  // 3. mark persistence
  const TZ = 'America/Chicago';
  const ev = {
    a: ['New one', '2026-11-05T16:00:00.000Z', '2026-11-05T17:00:00.000Z', 0, ''],
    b: ['Old new', '2026-11-06T16:00:00.000Z', '2026-11-06T17:00:00.000Z', 0, ''],
    c: ['Past new', '2026-10-28T16:00:00.000Z', '2026-10-28T17:00:00.000Z', 0, ''],
    d: ['Moved', '2026-11-07T16:00:00.000Z', '2026-11-07T17:00:00.000Z', 0, 'B'],
  };
  const nothing = { id: 'h3', at: iso(1 * H), counts: {}, added: [], removed: [], changed: [] };
  const hist = [
    nothing,
    { id: 'h2', at: iso(2 * DAY), added: [{ key: 'a' }], removed: [{ key: 'z', title: 'Gone', start: '2026-11-08T16:00:00.000Z', row: ['Gone', '2026-11-08T16:00:00.000Z', '2026-11-08T17:00:00.000Z', 0, ''] }], changed: [{ key: 'd', fields: { location: ['A', 'B'] } }] },
    { id: 'h1', at: iso(9 * DAY), added: [{ key: 'b' }], removed: [], changed: [] },
    { id: 'h0', at: iso(20 * DAY), first: true, counts: {}, added: [], removed: [], changed: [] },
  ];
  hist[1].added.push({ key: 'c' });
  const o = { events: ev, tz: TZ, today: '2026-10-29', nowMs: NOW };
  const m = D.carriedMarks(hist, o);
  eq(m.added.map((x) => x.key), ['a'], 'empty latest sync keeps a 2-day-old New; drops 9-day-old and past-date marks');
  eq(m.changed.map((x) => x.key), ['d'], 'Changed kept');
  eq(m.removed.map((x) => x.key), ['z'], 'Canceled kept');
  const v = D.listView({ events: ev, last: m, tz: TZ, today: '2026-10-29', mode: 'next14', month: '2026-10', q: '', changesOnly: false });
  eq(v.items.map((i) => i.key + ':' + i.status), ['a:new', 'b:', 'd:changed', 'z:canceled'], 'listView runs on carried marks');
  eq(v.counts, { new: 1, changed: 1, canceled: 1 }, 'counts from carried marks');
  eq(D.carriedMarks([hist[3]], o).first, true, 'only first copy -> not compared');
  eq(D.carriedMarks([], o), null, 'no history -> null');
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
