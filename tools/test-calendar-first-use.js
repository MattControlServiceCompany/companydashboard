'use strict';
// Tests: feed address check, empty-state text, Delete All at 0, and sync / Sync history / Recent changes (synthetic feed only).
// Run: node tools/test-calendar-first-use.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'app', 'calendar-diff.js'));
let fails = 0;
function ok(c, msg) { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); }

// 1. feed address check
const GOOD = 'https://calendar.google.com/' + 'calendar/ical/example.test_fake/private-x/basic.ics';
ok(D.feedUrlProblem(GOOD) === '', 'real-shaped Google .ics address accepted');
ok(D.feedUrlProblem('https://example.com/district') !== '', 'example.com rejected');
ok(D.feedUrlProblem('https://calendar.google.com/calendar/u/0/r') !== '', 'google page without .ics rejected');
ok(D.feedUrlProblem('http://calendar.google.com/a.ics') !== '', 'http rejected');
ok(D.feedUrlProblem('not a url') !== '', 'non-address rejected');

// 2. save + sync + history in the real module
function boot(store, fetchImpl, token) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { innerHTML: '', textContent: '', value: '', style: {} });
  const win = { CH_AUTH: { getToken: () => token } };
  const ctx = {
    window: win, CalendarDiff: D, console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat, setTimeout,
    _escHtml: (x) => String(x),
    document: { getElementById: (id) => el(id), createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
    DB: { get: (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]), set: async (k, v) => { store[k] = v; } },
    fetch: fetchImpl,
  };
  win.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'project-calendar.js'), 'utf8'), ctx);
  return { win, el };
}
const mk = (title, hour) => ({ fetchedAt: new Date().toISOString(), count: 1, window: {}, leftOut: [], events: { e1: [title, '2099-11-05T' + hour + ':00:00.000Z', '2099-11-05T' + (hour + 1) + ':00:00.000Z', 0, ''] } });
(async () => {
  let calls = 0, snaps = [mk('Early Release', 15), mk('Early Release', 16)];
  const store = {};
  const f = async () => { const s = snaps[Math.min(calls++, 1)]; return { ok: true, json: async () => ({ ok: true, snapshot: s }) }; };
  const { win, el } = boot(store, f, 'tok');
  ok(win.pcalHasFeed(1) === false, 'no feed before save');
  win.pcalRender(1);
  el('pcal-url-1').value = 'https://example.com/district';
  await win.pcalSave(1);
  ok(!store.en_cal_cfg_1 && calls === 0, 'bad address not saved, no fetch');
  ok(/not a Google Calendar feed/.test(el('pcal-msg-1').textContent), 'message shown for bad address');
  ok(/Secret address in iCal format/.test(el('pcal-panel-1').innerHTML), 'help text shown');
  el('pcal-url-1').value = GOOD;
  await win.pcalSave(1);
  ok(!!store.en_cal_cfg_1 && calls === 1 && win.pcalHasFeed(1), 'good address saved, first sync ran');
  ok(store.en_cal_hist_1.length === 1 && store.en_cal_hist_1[0].first === true, 'first sync wrote a first history record');
  await win.pcalSync(1);
  const h = store.en_cal_hist_1;
  ok(h.length === 2 && h[0].counts.changed === 1 && h[0].counts.added === 0, 'second sync recorded 1 changed event, newest first');
  const html = el('pcal-panel-1').innerHTML;
  ok(/Sync history \(2\)/.test(html), 'Sync history lists 2 syncs');
  ok(/Changed|changed/.test(html), 'Recent changes / history shows the change');

  // 3. empty-state text and Delete All
  const dc = fs.readFileSync(path.join(ROOT, 'app', 'district-calendar.js'), 'utf8');
  function empty(hasFeed, n) {
    const wrap = { innerHTML: '' }, btn = { style: { display: '' } };
    const c = { projects: [{ id: 1, districtCalendar: new Array(n).fill(0).map((_, i) => ({ date: '2099-01-0' + (i + 1) })) }], document: { getElementById: (id) => (id.startsWith('distcal-delall') ? btn : wrap) }, pcalHasFeed: () => hasFeed, console, window: {}, Date };
    vm.createContext(c);
    vm.runInContext(dc.slice(dc.indexOf('function renderDistCalTable'), dc.indexOf('const rows = p.districtCalendar.sort')) + '}', c);
    c.renderDistCalTable(1);
    return { text: wrap.innerHTML, hidden: btn.style.display === 'none' };
  }
  let r = empty(false, 0);
  ok(!/shown above/.test(r.text) && /No calendar feed/.test(r.text), 'no feed: no "shown above" text');
  ok(r.hidden, 'Delete All hidden at 0 events');
  r = empty(true, 0);
  ok(/shown above/.test(r.text), 'with feed: "shown above" text kept');
  r = empty(true, 0); 
  const core = fs.readFileSync(path.join(ROOT, 'app', 'core.js'), 'utf8');
  ok(/id="distcal-delall-\$\{p\.id\}"/.test(core), 'Delete All button has id for toggling');
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
