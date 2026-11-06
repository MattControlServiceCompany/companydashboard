'use strict';
// Acceptance test (2026-11-03): a page saves only when a person makes a change, every save says why,
// and receiving newer server data is never a conflict. Synthetic data, local mock backend, no network,
// no browser store. Real app/db.js and app/project-calendar.js run in Node vm sandboxes.
//   Session A: a person saves. Session B: only has the page open (it never acts).
//   An outside write (a service-key import) lands on the server in between.
// Run: node test-no-auto-save.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split('\r').join('');
const DB_SRC = read('app/db.js').replace(
  '  return {\n    warmCache,',
  '  return {\n    __t: { _hydrate, _queue: () => _syncQueue },\n    warmCache,',
);
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const clone = (v) => JSON.parse(JSON.stringify(v));

// In-memory kv server with real version checks. It records every PUT body.
function makeServer(initial) {
  const rows = {};
  Object.keys(initial).forEach((k) => (rows[k] = { value: clone(initial[k]), version: 1, hash: 'h' + k + '1', cause: 'seed' }));
  const api = { rows, puts: [], feedCalls: 0 };
  api.service = (key, value, cause) => {
    // A write that does not come from a page (service key): version moves, nobody's page asked for it.
    const cur = rows[key];
    const version = cur ? cur.version + 1 : 1;
    rows[key] = { value: clone(value), version, hash: 'h' + key + version, cause };
  };
  api.fetchImpl = async (u, o) => {
    if (String(u).includes('calendar-fetch')) {
      api.feedCalls++;
      return ok({ ok: true, snapshot: { fetchedAt: new Date().toISOString(), count: 1, window: {}, events: { e1: ['Concert', '2026-11-20T18:00:00Z', '2026-11-20T19:00:00Z', false, 'Gym'] } } });
    }
    if (o && o.method === 'PUT') {
      const b = JSON.parse(o.body);
      api.puts.push(b);
      const cur = rows[b.key];
      if (cur && b.baseVersion !== cur.version) {
        return { ok: false, status: 409, json: async () => ({ current: Object.assign({ key: b.key }, cur) }) };
      }
      const version = cur ? cur.version + 1 : 1;
      rows[b.key] = { value: b.value, version, hash: 'h' + b.key + version, cause: b.cause };
      return ok({ version, hash: rows[b.key].hash });
    }
    if (String(u).includes('manifest=1')) {
      return ok(Object.keys(rows).map((k) => ({ key: k, version: rows[k].version, hash: rows[k].hash, deleted: false })));
    }
    const keys = decodeURIComponent(String(u).split('keys=')[1] || '').split(',').filter(Boolean);
    return ok(keys.filter((k) => rows[k]).map((k) => Object.assign({ key: k, deleted: false }, rows[k])));
  };
  return api;
}

// One browser session: the real db.js, plus a document stub so the test can act like a person.
function session(srv, o) {
  o = o || {};
  const store = {};
  Object.keys(o.local || {}).forEach((k) => (store[k] = JSON.stringify(o.local[k])));
  const listeners = {};
  const document = {
    documentElement: {},
    visibilityState: 'visible',
    addEventListener: (t, f) => (listeners[t] = (listeners[t] || []).concat([f])),
    querySelector: (sel) =>
      sel === '.view.active' ? { id: 'view-projects' } : sel === '.pdt.active' ? { textContent: 'District Calendar' } : null,
    getElementById: () => null,
  };
  const win = {
    addEventListener() {},
    dispatchEvent() {},
    location: { hostname: 'x' },
    CH_AUTH: {
      backendMode: () => 'on',
      isSyncHost: () => true,
      getToken: () => 'tok',
      ready: () => Promise.resolve(),
      getUserId: () => o.uid || 'u1',
      getEmail: () => o.email || 'mmiller@example.invalid',
    },
    SyncClassification: require('./app/sync-classification.js'),
  };
  if (o.modal) win.SyncConflictUI = { showConflictModal: o.modal };
  const sandbox = {
    window: win,
    document,
    location: { hostname: 'cscdashboard.netlify' + '.app' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
      key: (i) => Object.keys(store)[i] || null,
      get length() {
        return Object.keys(store).length;
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms, ...r) => {
      const h = setTimeout(fn, ms, ...r);
      if (ms >= 10000 && h.unref) h.unref();
      return h;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    TextEncoder,
    crypto: globalThis.crypto,
    URL,
    AbortController,
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    Event: function (t) {
      this.type = t;
    },
    navigator: {},
    indexedDB: undefined,
    fetch: srv.fetchImpl,
  };
  vm.createContext(sandbox);
  vm.runInContext(DB_SRC + '\n;this.DB = DB;', sandbox);
  // The person: a real button click with a label.
  const button = { type: 'button', textContent: 'Sync now', title: '', getAttribute: () => null };
  button.closest = (sel) => (sel.indexOf('button') === 0 ? button : null);
  const nav = { type: 'button', textContent: 'Projects', title: '', getAttribute: () => null };
  nav.closest = (sel) => (sel.indexOf('.nav-item') === 0 ? nav : null);
  return {
    DB: sandbox.DB,
    sandbox,
    store,
    click: () => (listeners.click || []).forEach((f) => f({ type: 'click', isTrusted: true, target: button })),
    clickNav: () => (listeners.click || []).forEach((f) => f({ type: 'click', isTrusted: true, target: nav })),
    scriptClick: () => (listeners.click || []).forEach((f) => f({ type: 'click', isTrusted: false, target: button })),
    async start() {
      await this.DB.warmCache();
      await this.DB.__t._hydrate();
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

let pass = 0;
const failed = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    failed.push(name);
    console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n     '));
  }
}

const projects0 = () => [
  { id: 1, name: 'Alpha', note: 'base' },
  { id: 2, name: 'Beta', note: 'base' },
];
const snap0 = () => ({ fetchedAt: '2026-10-01T00:00:00Z', count: 0, window: {}, events: {} });
const seed = () => ({
  en_projects: projects0(),
  en_cal_cfg_1: { icsUrl: 'https://example.invalid/a.ics', timezone: 'America/Chicago' },
  en_cal_snap_1: snap0(),
  en_cal_hist_1: [],
  en_sched_actions_1: { actions: {} },
  en_bas_acthist_1: [],
});

(async () => {
  await t('A person save carries the account page + action cause; the server row keeps it', async () => {
    const srv = makeServer(seed());
    const A = session(srv);
    await A.start();
    A.click(); // "District Calendar: Sync now"
    await A.DB.set('en_cal_snap_1', Object.assign(snap0(), { count: 1 }));
    await settle();
    assert.strictEqual(srv.puts.length, 1);
    assert.strictEqual(srv.puts[0].cause, 'District Calendar: Sync now');
    assert.strictEqual(srv.rows['en_cal_snap_1'].cause, 'District Calendar: Sync now');
  });

  await t('Page load, refresh and recompute write nothing: a save with no user action stays in this browser', async () => {
    const srv = makeServer(seed());
    const B = session(srv);
    await B.start();
    await B.DB.set('en_cal_snap_1', Object.assign(snap0(), { fetchedAt: '2026-11-03T20:00:00Z' })); // load-time re-save
    await B.DB.set('en_sched_actions_1', { actions: { a: 1 } });
    await B.DB.set('en_bas_acthist_1', [{ id: 'x' }]);
    await settle();
    assert.strictEqual(srv.puts.length, 0, 'zero PUTs');
    assert.strictEqual(B.DB.__t._queue().length, 0, 'nothing queued for later');
    assert.strictEqual(B.DB.getAutoLocalCount(), 3);
    assert.strictEqual(srv.rows['en_cal_snap_1'].version, 1);
  });

  await t('A click on a tab or menu item is navigation: it does not allow a save', async () => {
    const srv = makeServer(seed());
    const B = session(srv);
    await B.start();
    B.clickNav();
    await B.DB.set('en_projects', projects0().concat([{ id: 3 }]));
    await settle();
    assert.strictEqual(srv.puts.length, 0);
  });

  await t('A script-made event is not a person', async () => {
    const srv = makeServer(seed());
    const B = session(srv);
    await B.start();
    B.scriptClick();
    await B.DB.set('en_cal_snap_1', Object.assign(snap0(), { count: 5 }));
    await settle();
    assert.strictEqual(srv.puts.length, 0);
  });

  await t('Two sessions: B only has the page open while A saves and a service write lands. B: zero writes, no conflict entry', async () => {
    const srv = makeServer(seed());
    const A = session(srv, { email: 'a@example.invalid' });
    const B = session(srv, { email: 'mmiller@example.invalid', uid: 'u2' });
    await A.start();
    await B.start();
    // B's page filled in missing fields in memory when it loaded (no save), like core.js loadCoreLists.
    const bProjects = B.DB.get('en_projects');
    bProjects.forEach((p) => (p.meetings = []));
    // A saves (person), then the service-key import lands (different keys + en_projects).
    A.click();
    await A.DB.set('en_cal_snap_1', Object.assign(snap0(), { count: 7 }));
    await A.DB.set('en_cal_hist_1', [{ id: 'calh_1', at: '2026-11-03T19:12:00Z' }]);
    srv.service('en_bas_snap_1', { '2026-11-03': { rows: {} } }, 'script: import');
    srv.service('en_bas_hist_1', [{ id: 'bash_1' }], 'script: import');
    const imported = projects0();
    imported[0].note = 'imported';
    srv.service('en_projects', imported, 'script: import');
    await settle();
    const aPuts = srv.puts.length;
    // B: the page is open; it checks the feed (auto-check) and receives the newer server data.
    const calSrc = read('app/project-calendar.js');
    const calCtx = {
      window: { CH_AUTH: { getToken: () => 'tok' }, addEventListener() {} },
      CalendarDiff: require('./app/calendar-diff.js'),
      console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat, setTimeout,
      _escHtml: (x) => String(x),
      document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
      DB: B.DB,
      fetch: srv.fetchImpl,
    };
    calCtx.window.document = calCtx.document;
    vm.createContext(calCtx);
    vm.runInContext(calSrc, calCtx);
    await calCtx.window.pcalAutoSync(1); // stale copy: reads the feed, saves nothing
    assert.strictEqual(srv.feedCalls, 1, 'the feed was read');
    await B.DB.__t._hydrate();
    await settle();
    assert.strictEqual(srv.puts.length, aPuts, 'B made zero writes');
    assert.strictEqual(
      (B.DB.getConflictArchive() || []).length,
      0,
      'B logged no conflict entry: ' + JSON.stringify(B.DB.getConflictArchive()),
    );
    assert.strictEqual(B.DB.get('en_projects')[0].note, 'imported', 'B shows the imported data');
    assert.strictEqual(B.DB.get('en_cal_snap_1').count, 7, 'B shows the data A saved');
    assert.strictEqual(srv.rows['en_projects'].cause, 'script: import', 'the service row was not overwritten by B');
    assert.strictEqual(srv.rows['en_cal_snap_1'].cause, 'Page: Sync now'.replace('Page', 'District Calendar'));
  });

  await t('A page that only reads the feed saves no copy, no history record and no actions', async () => {
    const srv = makeServer(seed());
    const B = session(srv);
    await B.start();
    const sets = [];
    const realSet = B.DB.set;
    const wrapped = Object.assign({}, B.DB, { set: (k, v) => (sets.push(k), realSet(k, v)) });
    const ctx = {
      window: { CH_AUTH: { getToken: () => 'tok' }, addEventListener() {} },
      CalendarDiff: require('./app/calendar-diff.js'),
      console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat, setTimeout,
      _escHtml: (x) => String(x),
      document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
      DB: wrapped,
      fetch: srv.fetchImpl,
      sactPersist: async () => sets.push('sactPersist'),
    };
    ctx.window.document = ctx.document;
    ctx.window.sactPersist = ctx.sactPersist;
    vm.createContext(ctx);
    vm.runInContext(read('app/project-calendar.js'), ctx);
    await ctx.window.pcalAutoSync(1);
    assert.strictEqual(srv.feedCalls, 1);
    assert.deepStrictEqual(sets, [], 'no DB.set, no action save');
    // Sync now (a person) still saves the copy and the history record.
    await ctx.window.pcalSync(1);
    assert.ok(sets.includes('en_cal_snap_1') && sets.includes('en_cal_hist_1'), 'Sync now saves: ' + sets.join());
  });

  await t('A synced copy changed in memory with no pending save is not a conflict and is not merged back up', async () => {
    const srv = makeServer({ en_projects: projects0() });
    const B = session(srv);
    await B.start();
    B.DB.get('en_projects')[0].extra = 'filled in by the page';
    const theirs = projects0();
    theirs[1].note = 'theirs';
    srv.service('en_projects', theirs, 'script: import');
    await B.DB.__t._hydrate();
    await settle();
    assert.strictEqual(srv.puts.length, 0);
    assert.strictEqual(B.DB.getConflictArchive().length, 0);
    assert.strictEqual(B.DB.get('en_projects')[1].note, 'theirs');
    assert.strictEqual(B.DB.get('en_projects')[0].extra, undefined, 'server copy wins');
  });

  await t('A real collision (a person edits the field the other side also changed) still logs a conflict', async () => {
    const srv = makeServer({ en_projects: projects0() });
    const asked = [];
    const B = session(srv, { modal: async (d) => (asked.push(d), { action: 'dismiss' }) });
    await B.start();
    const theirs = projects0();
    theirs[0].note = 'THEIRS';
    srv.service('en_projects', theirs, 'script: import');
    B.click();
    const mine = B.DB.get('en_projects');
    mine[0].note = 'MINE';
    await B.DB.set('en_projects', mine);
    await settle();
    assert.strictEqual(asked.length, 0, 'nobody is asked: the later save wins');
    const entries = B.DB.getConflictArchive().filter((e) => e.reason === 'record-conflict');
    assert.strictEqual(entries.length, 1, 'one conflict entry');
    assert.strictEqual(entries[0].losingValue.note, 'THEIRS', 'the replaced server version is archived');
  });

  await t('A queued person edit is kept when newer server data arrives (it is a pending edit, not replaced)', async () => {
    const srv = makeServer({ en_projects: projects0() });
    const B = session(srv, { modal: async () => ({ action: 'cancel' }) });
    await B.start();
    B.click();
    const mine = B.DB.get('en_projects');
    mine[1].note = 'MINE';
    srv.fetchImpl0 = srv.fetchImpl;
    // The save fails (offline): the edit waits in the queue with its cause.
    const real = srv.fetchImpl;
    B.sandbox.fetch = async (u, o) => {
      if (o && o.method === 'PUT') throw new Error('offline');
      return real(u, o);
    };
    await B.DB.set('en_projects', mine);
    await settle();
    const q = B.DB.__t._queue();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].cause, 'District Calendar: Sync now', 'the queue keeps the cause');
  });

  await t('Old archive entries that were not real conflicts clear by themselves; real ones stay', async () => {
    const srv = makeServer({ en_projects: projects0() });
    const archive = [
      { archivedAt: '2026-11-02T16:41:04.000Z', key: 'en_projects', reason: 'hydration-server-wins', losingSide: 'local', losingValue: [{ id: 1 }], owner: { id: 'u1', email: null, hintId: null } },
      { archivedAt: '2026-11-02T16:42:04.000Z', key: 'en_projects', reason: 'hydration-server-wins', neverSynced: true, losingSide: 'local', losingValue: [{ id: 9 }], owner: { id: 'u1', email: null, hintId: null } },
      { archivedAt: '2026-11-02T17:00:00.000Z', key: 'en_projects', reason: 'record-conflict', recordId: 1, losingSide: 'local', losingValue: { id: 1 }, owner: { id: 'u1', email: null, hintId: null } },
      { archivedAt: '2026-11-02T18:00:00.000Z', key: 'ch_qs_seen', reason: 'hydration-server-wins', losingSide: 'local', losingValue: 1, owner: { id: 'u9', email: null, hintId: null } },
    ];
    const B = session(srv, { local: { en_conflict_archive: archive } });
    await B.start();
    await settle();
    const all = B.DB.getConflictArchive();
    assert.strictEqual(all.length, 2, 'the false one is gone: ' + all.map((e) => e.reason + (e.neverSynced ? '*' : '')).join());
    assert.deepStrictEqual(all.map((e) => e.reason).sort(), ['hydration-server-wins', 'record-conflict']);
    assert.ok(all.some((e) => e.neverSynced), 'the never-synced copy stays');
    // another user's entry is not touched
    assert.strictEqual(JSON.parse(B.store['en_conflict_archive']).length, 3, 'the other user entry stays in storage');
  });

  console.log('\n' + pass + ' passed, ' + failed.length + ' failed');
  if (failed.length) process.exit(1);
})();
