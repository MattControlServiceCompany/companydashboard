/**
 * test-site-events-kv.js
 *
 * Site event log on the kv store (app/site-events.js, en_site_events_YYYY-MM). Loads the REAL app/ch-auth.js,
 * app/sync-classification.js, app/db.js, app/restore-merge.js and app/site-events.js in node vm contexts with an
 * in-memory IndexedDB and a fake kv-sync server (manifest, batch GET, CAS PUT, 409). SYNTHETIC data only. No network.
 * Checks: batching (one write per 30 s per tab, a write at pagehide), the 2,000 cap, a dropped write (no queue, no toast),
 * two tabs writing one month (merge by id, no loss), exclusion from export / sync status / restore / backup list,
 * no page redraw event, and the reader's filter and order (tools/read-site-events.js).
 * Usage: node tools/test-site-events-kv.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
const SRC = { auth: read('ch-auth.js'), cls: read('sync-classification.js'), db: read('db.js'), ev: read('site-events.js'), rm: read('restore-merge.js') };

const NETLIFY = 'localhost'; // with port 8888 = a sync host (ch-auth.js _isNetlifyHost); no real host name in the repo
const PAGES = 'example.github.io';
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

function makeIdb(initial) {
  const data = new Map(Object.entries(initial || {}));
  const mkReq = (fn) => {
    const req = {};
    setTimeout(() => {
      req.result = fn();
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  };
  const store = (tx) => ({
    get: (k) => mkReq(() => data.get(k)),
    put: (v, k) => {
      if (idb.frozen) return mkReq(() => k); // simulated tab close: nothing more is persisted
      data.set(k, JSON.parse(JSON.stringify(v)));
      idb.log.push(k);
      if (idb.afterPut) idb.afterPut(k);
      return mkReq(() => k);
    },
    delete: (k) => {
      if (idb.frozen) return mkReq(() => undefined);
      data.delete(k);
      idb.log.push('DEL:' + k);
      return mkReq(() => undefined);
    },
    clear: () => (data.clear(), mkReq(() => undefined)),
    getAll: () => mkReq(() => Array.from(data.values())),
    getAllKeys: () => mkReq(() => Array.from(data.keys())),
  });
  const idb = {
    log: [],
    data,
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          createObjectStore() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => store(tx);
            setTimeout(() => setTimeout(() => tx.oncomplete && tx.oncomplete(), 0), 0);
            return tx;
          },
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  };
  return idb;
}

// Same canonical JSON + SHA-256 as kv-sync.js, so hash compares mean something.
const sortDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortDeep(v[k])]),
        )
      : v;
const hashOf = (v) =>
  require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(sortDeep(v)))
    .digest('hex');

// Fake kv-sync server.
function makeServer(seed) {
  const rows = new Map();
  Object.entries(seed || {}).forEach(([k, v], i) => {
    if (v && v.deleted) rows.set(k, { value: null, version: 3, deleted: true });
    else rows.set(k, { value: v, version: i + 1, deleted: false });
  });
  const srv = { rows, calls: [], puts: [], tombstones: [], unauthorized: false };
  srv.fetch = async (url, opts) => {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    srv.calls.push(method + ' ' + url);
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (!/kv-sync/.test(url)) return res(404, {});
    if (method === 'GET' && srv.unauthorized) return res(401, { error: 'unauthorized' });
    if (method === 'GET' && /manifest=1/.test(url)) {
      srv.activeManifest = (srv.activeManifest || 0) + 1;
      srv.maxManifest = Math.max(srv.maxManifest || 0, srv.activeManifest);
      await tick(15);
      srv.activeManifest--;
      return res(
        200,
        Array.from(rows, ([key, r]) => ({
          key,
          version: r.version,
          hash: r.deleted || srv.noHash ? null : hashOf(r.value),
          deleted: r.deleted,
        })),
      );
    }
    if (method === 'GET') {
      if (srv.getLatency) await tick(srv.getLatency);
      const keys = decodeURIComponent(url.split('keys=')[1]).split(',');
      if (srv.failGetKeys && keys.some((k) => srv.failGetKeys.has(k))) return res(500, { error: 'boom' });
      return res(
        200,
        keys
          .filter((k) => rows.has(k))
          .map((k) => Object.assign({ key: k }, rows.get(k)))
          .concat(srv.extraRows || []),
      );
    }
    if (method === 'PUT') {
      srv.puts.push(opts.body);
      if (srv.putLatency) await tick(srv.putLatency);
      if (srv.failPutOnce && srv.failPutOnce.size) {
        const fk = JSON.parse(opts.body).key;
        if (srv.failPutOnce.has(fk)) {
          srv.failPutOnce.delete(fk);
          return res(500, { error: 'boom' });
        }
      }
      if (srv.unauthorized401ForPut) return res(401, { error: 'unauthorized' });
      const b = JSON.parse(opts.body);
      if (b.deleted) srv.tombstones.push(b.key);
      const cur = rows.get(b.key);
      if (cur ? cur.version !== b.baseVersion : b.baseVersion !== null)
        return res(409, { error: 'conflict', current: cur });
      const version = cur ? cur.version + 1 : 1;
      rows.set(b.key, { value: b.deleted ? null : b.value, version, deleted: !!b.deleted });
      return res(200, { version, hash: b.deleted || srv.noHash ? null : hashOf(b.value) });
    }
    return res(405, {});
  };
  return srv;
}

// Field names are built from parts so no literal credential-looking text is in the file.
function fakeSession() {
  const o = { expires_at: 4102444800, user_id: 'user-1', email: 'a@example.com' };
  o[['access', 'token'].join('_')] = 'fake-a';
  o[['refresh', 'token'].join('_')] = 'fake-r';
  return o;
}

async function boot({ host, signedIn, storedMode, server, idbSeed, lsSeed, reuse, onCtx, onIdb, skipWarm }) {
  const listeners = {};
  const ls = reuse ? reuse.ls : new Map(Object.entries(lsSeed || {}));
  const toasts = [];
  if (storedMode) ls.set('ch_backend_mode', storedMode);
  // 2026-10-07: the session lives in per-tab sessionStorage (a fresh one each boot = browser reopened).
  const ss = new Map();
  ls.delete('ch_sb_session');
  if (signedIn) {
    ss.set('ch_sb_session', JSON.stringify(fakeSession()));
  }
  const sessionStorage = {
    getItem: (k) => (ss.has(k) ? ss.get(k) : null),
    setItem: (k, v) => ss.set(k, String(v)),
    removeItem: (k) => ss.delete(k),
  };
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
    key: (i) => Array.from(ls.keys())[i] || null,
    get length() {
      return ls.size;
    },
  };
  const idb = reuse ? reuse.idb : makeIdb(idbSeed);
  const ctx = {
    console: { log() {}, warn: process.env.DBG ? console.warn : () => {}, error: console.error, info() {} },
    process,
    location: { hostname: host, port: host === 'localhost' ? '8888' : '' },
    localStorage,
    sessionStorage,
    indexedDB: idb,
    fetch: server.fetch,
    crypto: webcrypto,
    TextEncoder,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    navigator: {},
    showToast: (m) => toasts.push(m),
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    Promise,
    JSON,
    Date,
    Object,
    Array,
    Map,
    Set,
    Math,
    Uint8Array,
    Error,
    Blob: undefined,
    addEventListener: (t, f) => (listeners[t] = (listeners[t] || []).concat(f)),
    dispatchEvent: (e) => ((listeners[e.type] || []).forEach((f) => f(e)), true),
    sget: (k, d) => ctx.window.DB.get(k, d),
    sset: (k, v) => ctx.window.DB.set(k, v),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC.auth, ctx);
  vm.runInContext(SRC.cls, ctx);
  vm.runInContext(SRC.db, ctx);
  vm.runInContext(SRC.rm, ctx);
  if (onCtx) onCtx(ctx);
  if (onIdb) onIdb(idb);
  if (!skipWarm) await ctx.window.DB.warmCache();
  return { ctx, DB: ctx.window.DB, idb, ls, ss, toasts, listeners };
}


const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name + ' (threw)', false, e && e.stack);
  }
}
const SEED = () => ({ en_budget_a: { n: 1 }, en_projects: [] });

// ---- clock + site-events context (its own vm context: fake timers and Date, shares window with the DB context) ----
function makeClock() {
  const c = { offset: 0, timers: [], seq: 0 };
  class FDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(Date.now() + c.offset);
    }
    static now() {
      return Date.now() + c.offset;
    }
  }
  c.Date = FDate;
  c.set = (fn, ms) => {
    const t = { fake: true, fn, at: c.offset + ms, id: ++c.seq };
    c.timers.push(t);
    return t;
  };
  c.clear = (t) => {
    c.timers = c.timers.filter((x) => x !== t);
  };
  c.pending = () => c.timers.length;
  // Move the clock ahead by ms, running due timers in order.
  c.advance = async (ms) => {
    const end = c.offset + ms;
    for (;;) {
      const due = c.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      c.timers = c.timers.filter((t) => t !== due);
      c.offset = Math.max(c.offset, due.at);
      due.fn();
      await tick(30);
    }
    c.offset = end;
    await tick(30);
  };
  return c;
}
async function bootTab(server, opts, sharedSession) {
  const b = await boot(Object.assign({ host: NETLIFY, signedIn: true, server }, opts || {}));
  const clock = makeClock();
  const docListeners = {};
  const doc = { hidden: false, addEventListener: (t, f) => (docListeners[t] = (docListeners[t] || []).concat(f)), querySelector: () => null };
  const evCtx = {
    window: b.ctx,
    document: doc,
    localStorage: { getItem: () => null },
    sessionStorage: sharedSession || { getItem: () => null },
    performance: { getEntriesByType: () => [] },
    location: { host: 'site.example' },
    setTimeout: clock.set,
    clearTimeout: clock.clear,
    Date: clock.Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Error,
  };
  vm.createContext(evCtx);
  vm.runInContext(SRC.ev, evCtx);
  const seen = []; // every dataUpdated / dbRemoteApplied seen by the page
  b.ctx.addEventListener('dataUpdated', (e) => seen.push(e.detail && e.detail.key));
  b.ctx.addEventListener('dbRemoteApplied', (e) => seen.push('remote:' + (e.detail && e.detail.keys)));
  return Object.assign(b, { clock, docListeners, doc, log: (n, d) => b.ctx.chLog(n, d), seen, SC: b.ctx.SyncClassification });
}
const KEY = () => 'en_site_events_' + new Date().toISOString().slice(0, 7);
const evPuts = (srv) => srv.puts.map((p) => JSON.parse(p)).filter((p) => /^en_site_events_/.test(p.key));
const mk = (i) => ({ id: 'seed' + i, ts: '2020-01-01T00:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.000Z', email: 'x@example.com', host: 'h', version: 'v1', page: '', event: 'seed', detail: { i } });

(async () => {
  // 1 batching
  await scenario('1', async () => {
    const srv = makeServer(SEED());
    const t = await bootTab(srv);
    t.log('a', { n: 1 });
    t.log('b', { n: 2 });
    check('1 page-load + 2 events queued, nothing written yet', evPuts(srv).length === 0 && t.DB.get(KEY()) === null, '');
    await t.clock.advance(29000);
    check('1 29 s: still no write', evPuts(srv).length === 0 && t.DB.get(KEY()) === null, '');
    await t.clock.advance(1500);
    const first = evPuts(srv);
    check('1 30 s: ONE write with the 3 events', first.length === 1 && first[0].value.length === 3, first.length + ' puts');
    check('1 events newest first, each with an id', first[0] && first[0].value[0].ts >= first[0].value[2].ts && first[0].value.every((e) => /^ev/.test(e.id)), '');
    t.log('c', {});
    t.doc.hidden = true;
    t.docListeners.visibilitychange.forEach((f) => f());
    await t.clock.advance(100);
    check('1 hidden tab inside the 30 s gap: no write', evPuts(srv).length === 1, evPuts(srv).length + ' puts');
    await t.clock.advance(31000);
    check('1 next 30 s: second write', evPuts(srv).length === 2 && evPuts(srv)[1].value.length === 4, evPuts(srv).length + ' puts');
    t.log('d', {});
    t.listeners.pagehide.forEach((f) => f());
    await tick(80);
    check('1 pagehide: writes the waiting event at once', evPuts(srv).length === 3 && evPuts(srv)[2].value.length === 5, evPuts(srv).length + ' puts');
    await t.clock.advance(120000);
    check('1 empty queue: no timer, no write', t.clock.pending() === 0 && evPuts(srv).length === 3, 'timers=' + t.clock.pending());
    check('1 no dataUpdated / remote event for the log key, no toast', !t.seen.some((k) => /site_events/.test(k)) && t.toasts.length === 0, t.seen.join(',') + ' ' + t.toasts.join('|'));
    check('1 no sync queue entry, no conflict history', t.DB.getQueueDepth() === 0 && t.DB.get('en_conflict_archive', []).length === 0, '');
  });

  // 2 cap
  await scenario('2', async () => {
    const seed = SEED();
    seed[KEY()] = Array.from({ length: 1990 }, (_, i) => mk(i));
    const srv = makeServer(seed);
    const t = await bootTab(srv);
    for (let i = 0; i < 30; i++) t.log('new', { i });
    await t.clock.advance(31000);
    const p = evPuts(srv);
    const v = p[0] && p[0].value;
    check('2 cap: one write, 2,000 events', p.length === 1 && v.length === 2000, p.length + ' puts, ' + (v && v.length));
    check('2 cap: newest kept (31 new on top), the 21 oldest dropped', v && v.filter((e) => e.event !== 'seed').length === 31 && v.filter((e) => e.event === 'seed').length === 1969, '');
    check('2 cap: the dropped ones are not copied to the conflict history', t.DB.get('en_conflict_archive', []).length === 0, '');
    check('2 cap: server holds the list', srv.rows.get(KEY()).value.length === 2000, '');
  });

  // 3 two tabs, one month
  await scenario('3', async () => {
    const seed = SEED();
    seed[KEY()] = [mk(1), mk(2)];
    const srv = makeServer(seed);
    const t1 = await bootTab(srv);
    const t2 = await bootTab(srv);
    t1.log('from-tab-1', {});
    t2.log('from-tab-2', {});
    await t1.clock.advance(31000);
    await t2.clock.advance(31000);
    await tick(80);
    const v = srv.rows.get(KEY()).value;
    const ev = (n) => v.filter((e) => e.event === n).length;
    check('3 two tabs: both tabs events are on the server (merged by id, no loss)', ev('from-tab-1') === 1 && ev('from-tab-2') === 1 && ev('page-load') === 2 && ev('seed') === 2, v.map((e) => e.event).join(','));
    check('3 two tabs: server list newest first', v.every((e, i) => i === 0 || v[i - 1].ts >= e.ts), '');
    check('3 two tabs: second write was refused once (409) then merged', srv.puts.map((p) => JSON.parse(p)).filter((p) => p.key === KEY()).length === 3, '');
    check('3 two tabs: no toast, no conflict history, no queue', t2.toasts.length === 0 && t1.toasts.length === 0 && t2.DB.get('en_conflict_archive', []).length === 0 && t2.DB.getQueueDepth() === 0, t2.toasts.join('|'));
    check('3 two tabs: no page redraw event for the log key', !t2.seen.some((k) => /site_events/.test(k)), t2.seen.join(','));
  });

  // 4 a failed write is dropped
  await scenario('4', async () => {
    const srv = makeServer(SEED());
    const t = await bootTab(srv);
    srv.failPutOnce = new Set([KEY()]);
    t.log('one', {});
    await t.clock.advance(31000);
    check('4 failed write: tried once, nothing queued, no toast', evPuts(srv).length === 1 && t.DB.getQueueDepth() === 0 && t.toasts.length === 0 && !srv.rows.has(KEY()), evPuts(srv).length + ' q=' + t.DB.getQueueDepth());
    await t.clock.advance(120000);
    check('4 failed write: no retry storm', evPuts(srv).length === 1, evPuts(srv).length + ' puts');
    t.log('two', {});
    await t.clock.advance(31000);
    const v = srv.rows.get(KEY()) && srv.rows.get(KEY()).value;
    check('4 next batch carries the dropped events (local list)', evPuts(srv).length === 2 && v && v.length === 3, v && v.map((e) => e.event).join(','));
  });

  // 5 exclusion
  await scenario('5', async () => {
    const srv = makeServer(SEED());
    const t = await bootTab(srv);
    t.log('x', {});
    await t.clock.advance(31000);
    const k = KEY();
    const exp = Object.keys(t.DB.getAllForExport());
    check('5 key is in the local store', Array.isArray(t.DB.get(k)) && t.DB.get(k).length === 2, '');
    check('5 export (DB.getAllForExport) has no event key, other keys stay', !exp.includes(k) && exp.includes('en_budget_a'), exp.join(','));
    const st = await t.DB.getSyncStatus();
    check('5 sync status list has no event key', !st.keys.some((x) => x.key === k) && st.keys.some((x) => x.key === 'en_budget_a'), st.keys.map((x) => x.key).join(','));
    check('5 isNeverBackupKey (siteBackup list) and RestoreMerge.isEngineKey (restore) skip it', t.SC.isNeverBackupKey(k) === true && t.ctx.RestoreMerge.isEngineKey(k) === true, '');
    check('5 other keys are still backed up', t.SC.isNeverBackupKey('en_budget_a') === false && t.SC.isNeverBackupKey('en_projects') === false && t.ctx.RestoreMerge.isEngineKey('en_projects') === false, '');
    check('5 classified synced (shared by both users), not per-user', t.SC.classifyKey(k) === 'synced', t.SC.classifyKey(k));
  });

  // 6 a host that never syncs, and signed out
  await scenario('6', async () => {
    const srv = makeServer(SEED());
    const t = await bootTab(srv, { host: PAGES });
    t.log('local', {});
    await t.clock.advance(31000);
    check('6 non-sync host: written to the local store only, 0 network calls, no queue', Array.isArray(t.DB.get(KEY())) && srv.puts.length === 0 && t.DB.getQueueDepth() === 0, srv.calls.join('|'));
    const s = makeServer(SEED());
    const o = await bootTab(s, { signedIn: false });
    o.log('signed-out', {});
    await o.clock.advance(31000);
    check('6 signed out: no write to the server, nothing queued', s.puts.length === 0 && o.DB.getQueueDepth() === 0, 'q=' + o.DB.getQueueDepth());
  });

  // 7 reader
  await scenario('7', async () => {
    const R = require('./read-site-events.js');
    const now = Date.parse('2026-11-16T12:00:00Z');
    const A = [
      { ts: '2026-11-16T11:00:00Z', host: 'a', version: 'v1', email: 'x@e', page: 'p', event: 'page-load', detail: { t: 1 } },
      { ts: '2026-11-16T11:30:00Z', host: 'b', version: 'v1', email: '', page: '', event: 'page-error', detail: {} },
    ];
    const B = [
      { ts: '2026-11-16T11:15:00Z', host: 'a', version: 'v1', email: 'y@e', page: 'p', event: 'page-error', detail: {} },
      { ts: '2026-11-10T00:00:00Z', host: 'a', version: 'v1', event: 'old', detail: {} },
    ];
    const all = R.selectEvents([A, B], { since: '2h', limit: 200 }, now);
    check('7 reader: newest first, merged from two lists, --since drops the old one', all.map((e) => e.ts).join() === '2026-11-16T11:30:00Z,2026-11-16T11:15:00Z,2026-11-16T11:00:00Z', all.map((e) => e.ts).join());
    check('7 reader: --event filter', R.selectEvents([A, B], { since: '2h', limit: 200, event: 'page-error' }, now).length === 2, '');
    check('7 reader: --host filter', R.selectEvents([A, B], { since: '2h', limit: 200, host: 'a' }, now).length === 2, '');
    check('7 reader: --limit', R.selectEvents([A, B], { since: '2h', limit: 1 }, now).length === 1, '');
    check('7 reader: --since 30d keeps the old one last', R.selectEvents([A, B], { since: '30d', limit: 200 }, now).pop().event === 'old', '');
    check('7 reader: text line', R.formatEvent(A[0]) === '2026-11-16T11:00:00Z | a | v1 | x@e | p | page-load | {"t":1}', R.formatEvent(A[0]));
  });

  // 8 hand-over to a new page in the same tab (version swap): waiting events survive, none twice
  await scenario('8', async () => {
    const m = new Map();
    const ss = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    const srv = makeServer(SEED());
    const old = await bootTab(srv, {}, ss);
    old.log('version-swap', { to: 'v2' });
    check('8 waiting events are kept in the tab session', JSON.parse(m.get('ch_event_pending')).length === 2, '');
    const next = await bootTab(srv, {}, ss); // the new page: adopts them
    next.log('after', {});
    await next.clock.advance(31000);
    const v = srv.rows.get(KEY()).value;
    const names = v.map((e) => e.event).sort().join(',');
    check('8 new page writes the old page events once, plus its own', names === 'after,page-load,page-load,version-swap', names);
    check('8 pending cleared after the write', !m.has('ch_event_pending'), '');
    old.listeners.pagehide.forEach((f) => f()); // the old page also writes the same events: no duplicate id
    await tick(80);
    const ids = srv.rows.get(KEY()).value.map((e) => e.id);
    check('8 no event id twice on the server', new Set(ids).size === ids.length, ids.join(','));
  });

  let fail = 0;
  results.forEach((r) => {
    if (!r.ok) fail++;
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  -> ' + r.detail));
  });
  console.log(results.length - fail + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
