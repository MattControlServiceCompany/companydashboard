/**
 * test-backend-mode-default.js
 *
 * Acceptance test for the Netlify backend default (branch fix/netlify-backend-default).
 * Loads the REAL app/ch-auth.js, app/sync-classification.js and app/db.js in a
 * node vm with an in-memory IndexedDB, an in-memory localStorage, and a mocked
 * fetch that behaves like netlify/functions/kv-sync.js (manifest, batch GET,
 * CAS PUT, tombstone PUT, 401). SYNTHETIC data only. No network, no browser.
 *
 * Usage: node tools/test-backend-mode-default.js
 * Env:   APP_ROOT=<dir containing app/>  (default: repo root) - used to run
 *        the same test against another checkout, for example main.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
const SRC = { auth: read('ch-auth.js'), cls: read('sync-classification.js'), db: read('db.js') };

const NETLIFY = 'cscdashboard.netlify.app';
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
  ls.delete('ch_sb_session');
  if (signedIn) {
    ls.set('ch_sb_session', JSON.stringify(fakeSession()));
  }
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
    location: { hostname: host },
    localStorage,
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
  if (onCtx) onCtx(ctx);
  if (onIdb) onIdb(idb);
  if (!skipWarm) await ctx.window.DB.warmCache();
  return { ctx, DB: ctx.window.DB, idb, ls, toasts };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name + ' (threw)', false, e && e.message);
  }
}

const SEED = () => ({
  en_budget_a: { n: 1 },
  en_budget_b: [1, 2, 3],
  en_budget_c: 'hello',
  en_budget_d: { deep: { x: 4 } },
  en_budget_e: 5,
});
const cacheOf = (DB, keys) => Object.fromEntries(keys.map((k) => [k, DB.get(k)]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  await scenario('1', async () => {
    const seed = SEED();
    seed.en_budget_gone = { deleted: true };
    const srv = makeServer(seed);
    const { DB } = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const want = SEED();
    check('1 Netlify signed-in empty IDB: 0 PUTs', srv.puts.length === 0, srv.puts.length + ' PUTs');
    check(
      '1 Netlify signed-in empty IDB: cache equals server',
      same(cacheOf(DB, Object.keys(want)), want) && DB.get('en_budget_gone') === null,
      JSON.stringify(cacheOf(DB, Object.keys(want))),
    );
  });

  await scenario('2', async () => {
    const srv = makeServer(SEED());
    const { ctx, DB } = await boot({ host: PAGES, signedIn: true, server: srv });
    DB.set('en_budget_local', { z: 1 });
    await tick(20);
    check('2 github.io: mode off', ctx.window.CH_AUTH.backendMode() === 'off', ctx.window.CH_AUTH.backendMode());
    check('2 github.io: 0 network calls', srv.calls.length === 0, srv.calls.join(' | '));
  });

  await scenario('3', async () => {
    const srv = makeServer(SEED());
    const { ctx, DB } = await boot({ host: NETLIFY, signedIn: false, server: srv });
    DB.set('en_budget_a', { n: 99 });
    DB.set('en_budget_new', 1);
    DB.remove('en_budget_b');
    await tick(20);
    check('3 Netlify signed-out: 0 PUTs', srv.puts.length === 0, srv.puts.length + ' PUTs');
    check(
      '3 Netlify signed-out: mode off, nothing queued',
      ctx.window.CH_AUTH.backendMode() === 'off' && DB.getQueueDepth() === 0,
      ctx.window.CH_AUTH.backendMode() + ' q=' + DB.getQueueDepth(),
    );
  });

  await scenario('4', async () => {
    const srv = makeServer(SEED());
    const { DB } = await boot({ host: NETLIFY, signedIn: true, server: srv });
    srv.unauthorized401ForPut = true;
    DB.set('en_budget_a', { n: 2 });
    await tick(40);
    check(
      '4 401 mid-session: value kept locally',
      same(DB.get('en_budget_a'), { n: 2 }),
      JSON.stringify(DB.get('en_budget_a')),
    );
    check('4 401 mid-session: write stays queued', DB.getQueueDepth() === 1, 'queue=' + DB.getQueueDepth());
    check('4 401 mid-session: server unchanged', same(srv.rows.get('en_budget_a').value, { n: 1 }), '');
  });

  await scenario('5', async () => {
    const srv = makeServer(SEED());
    const { DB } = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const before = JSON.stringify(Array.from(srv.rows));
    DB.remove('en_budget_c');
    await tick(40);
    const others = ['en_budget_a', 'en_budget_b', 'en_budget_d', 'en_budget_e'];
    const want = SEED();
    check(
      '5 one-key delete: exactly one tombstone PUT',
      srv.puts.length === 1 && srv.tombstones.length === 1 && srv.tombstones[0] === 'en_budget_c',
      srv.puts.length + ' PUTs, ' + srv.tombstones.join(','),
    );
    check(
      '5 one-key delete: other keys unchanged (cache and server)',
      others.every((k) => same(DB.get(k), want[k]) && same(srv.rows.get(k).value, want[k])) && before !== '',
      '',
    );
  });

  await scenario('6', async () => {
    const srv = makeServer(SEED());
    const { ctx, DB, ls } = await boot({ host: NETLIFY, signedIn: true, storedMode: 'shadow', server: srv });
    const want = SEED();
    check(
      '6 stored shadow on Netlify: mode is on',
      ctx.window.CH_AUTH.backendMode() === 'on',
      ctx.window.CH_AUTH.backendMode(),
    );
    check('6 stored shadow on Netlify: hydrated, not overwritten', same(cacheOf(DB, Object.keys(want)), want), '');
    check(
      '6 stored shadow on Netlify: stored value removed, no setBackendMode API',
      ls.get('ch_backend_mode') === undefined && DB.setBackendMode === undefined,
      String(ls.get('ch_backend_mode')),
    );
    check('6 stored shadow on Netlify: 0 PUTs', srv.puts.length === 0, srv.puts.length + ' PUTs');
  });

  await scenario('7', async () => {
    const srv = makeServer(SEED());
    const stale = { en_budget_a: { n: 'STALE-LOCAL' }, en_budget_local_only: { keep: true } };
    const { DB } = await boot({ host: NETLIFY, signedIn: true, storedMode: 'on', server: srv, idbSeed: stale });
    await tick(40);
    const puts7 = srv.puts.map((p) => JSON.parse(p).key);
    check(
      '7 drift (stale local, empty version map): no push of the drifted key; only the local-only key is uploaded',
      puts7.length === 1 && puts7[0] === 'en_budget_local_only',
      puts7.join(','),
    );
    check('7 drift: server wins locally', same(DB.get('en_budget_a'), { n: 1 }), JSON.stringify(DB.get('en_budget_a')));
    check('7 drift: server value unchanged', same(srv.rows.get('en_budget_a').value, { n: 1 }), '');
    const arch = DB.get('en_conflict_archive', []);
    check(
      '7 drift: stale local value kept in conflict archive',
      arch.some((e) => e.key === 'en_budget_a' && same(e.losingValue, { n: 'STALE-LOCAL' })),
      'archive=' + arch.length,
    );
  });

  // Always-on: stored 'off' on the production host is ignored and removed.
  await scenario('11', async () => {
    const srv = makeServer(SEED());
    const b = await boot({ host: NETLIFY, signedIn: true, storedMode: 'off', server: srv });
    const want = SEED();
    check(
      '11 stored off + signed in on Netlify: mode on',
      b.ctx.window.CH_AUTH.backendMode() === 'on',
      b.ctx.window.CH_AUTH.backendMode(),
    );
    check(
      '11 stored off: removed from storage',
      b.ls.get('ch_backend_mode') === undefined && b.ls.get('ch_backend_enabled') === undefined,
      String(b.ls.get('ch_backend_mode')),
    );
    check('11 stored off: hydrated from server', same(cacheOf(b.DB, Object.keys(want)), want), '');
  });

  // First connect of a formerly-off browser: local-only key uploaded, differing key archived.
  await scenario('12', async () => {
    const srv = makeServer(SEED());
    const idbSeed = {
      en_budget_a: { n: 'OLD-LOCAL' },
      en_budget_local_only: { keep: [1, 2] },
      en_conflict_archive: [],
    };
    let fired = null;
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      storedMode: 'off',
      server: srv,
      idbSeed,
      onCtx: (c) => c.addEventListener('dbFirstConnect', (e) => (fired = e.detail)),
    });
    await tick(60);
    const row = srv.rows.get('en_budget_local_only');
    check(
      '12 local-only key uploaded to server',
      row && same(row.value, { keep: [1, 2] }) && row.version === 1,
      JSON.stringify(row),
    );
    check(
      '12 local-only key has a local version entry',
      !!(b.idb.data.get('ch_rv::en_budget_local_only') || {}).stamp,
      '',
    );
    check(
      '12 differing key: server wins locally',
      same(b.DB.get('en_budget_a'), { n: 1 }),
      JSON.stringify(b.DB.get('en_budget_a')),
    );
    check(
      '12 differing key: server value untouched',
      same(srv.rows.get('en_budget_a').value, { n: 1 }) && srv.rows.get('en_budget_a').version === 1,
      '',
    );
    const arch = b.DB.get('en_conflict_archive', []);
    check(
      '12 differing key: old local value archived',
      arch.some((e) => e.key === 'en_budget_a' && same(e.losingValue, { n: 'OLD-LOCAL' })),
      'archive=' + arch.length,
    );
    check('12 exactly one PUT (the local-only key)', srv.puts.length === 1, srv.puts.length + ' PUTs');
    check(
      '12 one-line result event: 1 uploaded, updated from server',
      fired && fired.uploaded === 1 && fired.updated >= 1,
      JSON.stringify(fired),
    );
    check('12 queue empty', b.DB.getQueueDepth() === 0, 'q=' + b.DB.getQueueDepth());
  });

  // Archive entry made during hydration must land in the DB (core.js sset writes to
  // localStorage while the DB is not ready, which hid the entry from the viewer).
  await scenario('12b', async () => {
    const srv = makeServer(SEED());
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_budget_a: { n: 'OLD-LOCAL' } },
      onCtx: (c) => {
        c.sset = (k, v) =>
          c.window.DB.isReady()
            ? c.window.DB.set(k, v)
            : (c.localStorage.setItem(k, JSON.stringify(v)), Promise.resolve());
      },
    });
    const arch = b.DB.getConflictArchive();
    check(
      '12b hydration archive entry is in the DB cache',
      arch.some((e) => e.key === 'en_budget_a'),
      'archive=' + arch.length,
    );
  });

  // Upload runs once: a second load makes no PUT; a server tombstone is never resurrected.
  await scenario('13', async () => {
    const seed = SEED();
    seed.en_budget_gone = { deleted: true };
    const srv = makeServer(seed);
    const b1 = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_budget_new: 7, en_budget_gone: { stale: 1 } },
    });
    await tick(60);
    const after1 = srv.puts.length;
    check(
      '13 first load: local-only key uploaded, tombstoned key not re-uploaded',
      after1 === 1 && srv.rows.get('en_budget_new').value === 7 && srv.rows.get('en_budget_gone').deleted === true,
      srv.puts.length + ' PUTs',
    );
    await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: b1 });
    await tick(60);
    check('13 second load: no further PUT', srv.puts.length === after1, srv.puts.length + ' PUTs');
  });

  // Sync status panel: no mode switch code at all.
  await scenario('14', async () => {
    const ui = read('sync-ui.js');
    check('14 sync-ui.js has no mode switch code', !/ch-sync-mode-btn|setBackendMode/.test(ui), '');
  });

  // Review fix 2: any non-production host is off even with a stored 'on'/'shadow'.
  for (const host of [
    'example.github.io',
    'localhost',
    'deploy-preview-3--chub-test.netlify.app',
    'chub-test.example.com',
  ]) {
    await scenario('2b', async () => {
      for (const mode of ['on', 'shadow']) {
        const srv = makeServer(SEED());
        const { ctx, DB } = await boot({ host, signedIn: true, storedMode: mode, server: srv });
        DB.set('en_budget_local', 1);
        await tick(20);
        check(
          '2b ' + host + ' stored ' + mode + ': off, 0 network calls',
          ctx.window.CH_AUTH.backendMode() === 'off' && srv.calls.length === 0,
          srv.calls.join('|'),
        );
      }
    });
  }

  // Review fix 1 + 5: sign in, sync, signed-out edit, other device bumps, sign in again.
  await scenario('8', async () => {
    const srv = makeServer(SEED());
    const b1 = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const b2 = await boot({ host: NETLIFY, signedIn: false, server: srv, reuse: b1 });
    b2.DB.set('en_budget_a', { n: 'SIGNED-OUT-EDIT' });
    await tick(30);
    srv.rows.set('en_budget_a', { value: { n: 'OTHER-DEVICE' }, version: 9, deleted: false });
    const putsBefore = srv.puts.length;
    const b3 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: b1 });
    await tick(2200);
    const arch = b3.DB.get('en_conflict_archive', []);
    check(
      '8 signed-out edit + other-device bump: edit archived',
      arch.some((e) => e.key === 'en_budget_a' && same(e.losingValue, { n: 'SIGNED-OUT-EDIT' })),
      'archive=' + JSON.stringify(arch.map((e) => e.key)),
    );
    check(
      '8 ...server value applied, 0 PUTs',
      same(b3.DB.get('en_budget_a'), { n: 'OTHER-DEVICE' }) && srv.puts.length === putsBefore,
      '',
    );
    check(
      '8 ...toast points to the archive',
      b3.toasts.some((t) => /conflict archive/.test(t)),
      JSON.stringify(b3.toasts),
    );
  });

  // Unchanged local + newer server = plain pull, no archive noise.
  await scenario('8b', async () => {
    const srv = makeServer(SEED());
    const b1 = await boot({ host: NETLIFY, signedIn: true, server: srv });
    srv.rows.set('en_budget_a', { value: { n: 'NEWER' }, version: 9, deleted: false });
    const b2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: b1 });
    check(
      '8b unchanged local + newer server: pulled, nothing archived',
      same(b2.DB.get('en_budget_a'), { n: 'NEWER' }) && b2.DB.get('en_conflict_archive', []).length === 0,
      JSON.stringify(b2.DB.get('en_budget_a')) + JSON.stringify(b2.DB.get('en_conflict_archive', [])).slice(0, 300),
    );
  });

  // Review fix 3: merge-function key merges in the drift branch.
  await scenario('9', async () => {
    const srv = makeServer({ en_customers: [{ id: 'c1', name: 'One' }] });
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_customers: [{ id: 'c2', name: 'Two' }] },
    });
    await tick(40);
    const ids = (b.DB.get('en_customers') || [])
      .map((c) => c.id)
      .sort()
      .join(',');
    const srvIds = srv.rows
      .get('en_customers')
      .value.map((c) => c.id)
      .sort()
      .join(',');
    check('9 en_customers drift: merged locally', ids === 'c1,c2', ids);
    check(
      '9 en_customers drift: one based PUT of the merged list, nothing archived',
      srv.puts.length === 1 && srvIds === 'c1,c2' && b.DB.get('en_conflict_archive', []).length === 0,
      srv.puts.length + ' PUTs, server=' + srvIds,
    );
  });

  // Round 2 D: nothing is ever dropped from the archive; past the cap a notice event fires.
  await scenario('10', async () => {
    const srv = makeServer(SEED());
    const old = Array.from({ length: 200 }, (_, i) => ({
      key: 'old' + i,
      archivedAt: 'x',
    }));
    let full = 0;
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_budget_a: { n: 'STALE' }, en_conflict_archive: old },
      onCtx: (c) => c.window.addEventListener('conflictArchiveFull', () => full++),
    });
    await tick(20);
    const arch = b.DB.get('en_conflict_archive', []);
    check(
      '10 archive over cap: every entry kept (oldest and newest)',
      arch.length === 201 && arch[0].key === 'old0' && arch.some((e) => e.key === 'en_budget_a'),
      'len=' + arch.length,
    );
    check(
      '10 archive over cap: full state reported and notice event fired',
      b.DB.isConflictArchiveFull() === true && full >= 1,
      'events=' + full,
    );
    b.DB.clearConflictArchive(150);
    const after = b.DB.get('en_conflict_archive', []);
    check(
      '10 clear removes only the exported entries',
      after.length === 51 && after[0].key === 'old150',
      'len=' + after.length,
    );
  });

  // Round 2 A: the archive entry is written BEFORE the local value is overwritten.
  await scenario('A', async () => {
    const srv = makeServer(SEED());
    const stale = {
      en_budget_a: { n: 'STALE-A' },
      en_budget_b: { n: 'STALE-B' },
      en_budget_c: { n: 'STALE-C' },
    };
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: stale,
      onIdb: (idb) => {
        // simulated tab close right after the first data key is overwritten
        idb.afterPut = (k) => {
          if (/^en_budget_[abc]$/.test(k)) idb.frozen = true;
        };
      },
    });
    const arch = b.idb.data.get('en_conflict_archive') || [];
    const overwritten = ['en_budget_a', 'en_budget_b', 'en_budget_c'].filter((k) => !same(b.idb.data.get(k), stale[k]));
    check(
      'A crash right after the first overwrite: that key is already in the persisted archive',
      overwritten.length >= 1 &&
        overwritten.every((k) => arch.some((e) => e.key === k && same(e.losingValue, stale[k]))),
      'overwritten=' + overwritten + ' archive=' + arch.length + ' log=' + b.idb.log.join(','),
    );
  });
  await scenario('A2', async () => {
    const srv = makeServer(SEED());
    const stale = {
      en_budget_a: { n: 'STALE-A' },
      en_budget_b: { n: 'STALE-B' },
    };
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: stale,
    });
    const log = b.idb.log;
    const ok = ['en_budget_a', 'en_budget_b'].every((k) => {
      const w = log.indexOf(k);
      return w > -1 && log.findIndex((x, i) => x === 'en_conflict_archive' && i < w) > -1;
    });
    check('A2 an archive put is issued before each overwrite put', ok, log.join(','));
  });

  // Round 2 B: overlapping hydrates share one run; no entries lost, no parallel manifest fetches.
  await scenario('B', async () => {
    const srv = makeServer(SEED());
    const stale = {
      en_budget_a: { n: 'S1' },
      en_budget_b: { n: 'S2' },
      en_budget_c: { n: 'S3' },
    };
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: stale,
      skipWarm: true,
    });
    await Promise.all([b.DB.warmCache(), b.DB.warmCache()]);
    await tick(60);
    const keys = b.DB.get('en_conflict_archive', [])
      .map((e) => e.key)
      .sort()
      .join(',');
    check(
      'B overlapping hydrates: all 3 stale values archived once each',
      keys === 'en_budget_a,en_budget_b,en_budget_c',
      keys,
    );
    check(
      'B overlapping hydrates: never two manifest fetches at once',
      srv.maxManifest === 1,
      'max=' + srv.maxManifest,
    );
    check('B overlapping hydrates: 0 PUTs', srv.puts.length === 0, srv.puts.length + '');
  });

  // Round 2 C: a version is always stamped with a hash, even if the server sends none.
  await scenario('C', async () => {
    const srv = makeServer(SEED());
    srv.noHash = true;
    const b1 = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const stampsOf = (bb) => {
      const m = {};
      for (const [k, v] of bb.idb.data) if (k.startsWith('ch_rv::') && v && v.stamp) m[k.slice(7)] = v.stamp;
      return m;
    };
    const st = stampsOf(b1);
    check(
      'C every stamped version has a hash (server sent none)',
      Object.keys(st).length >= 5 && Object.values(st).every((v) => typeof v.hash === 'string' && v.hash.length === 64),
      JSON.stringify(st).slice(0, 200),
    );
    srv.rows.set('en_budget_a', {
      value: { n: 'NEWER' },
      version: 9,
      deleted: false,
    });
    const b2 = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      reuse: b1,
    });
    check(
      'C unchanged local + newer server (no hash from server): pulled, no archive noise',
      same(b2.DB.get('en_budget_a'), { n: 'NEWER' }) && b2.DB.get('en_conflict_archive', []).length === 0,
      JSON.stringify(b2.DB.get('en_conflict_archive', [])).slice(0, 200),
    );
    b2.DB.set('en_budget_b', [9]);
    await tick(30);
    const st2 = stampsOf(b2);
    check(
      'C own PUT stamps a hash too',
      st2.en_budget_b && typeof st2.en_budget_b.hash === 'string' && st2.en_budget_b.hash.length === 64,
      JSON.stringify(st2.en_budget_b),
    );
  });

  // ---- F1: deletions must not be resurrected by a stale browser ----
  const proj = (id, name) => ({ id, name });
  const ids = (v) => (Array.isArray(v) ? v.map((p) => p.id).sort((a, b) => a - b) : null);
  await scenario('F1a', async () => {
    const srv = makeServer({ en_projects: [proj(1, 'P1'), proj(2, 'P2')] });
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    A.DB.set('en_projects', [proj(2, 'P2')]); // user A deletes P1
    await tick(60);
    const B = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_projects: [proj(1, 'P1'), proj(2, 'P2'), proj(3, 'P3-B-only')] }, // stale, never synced
    });
    await tick(120);
    check(
      'F1a server list keeps P1 deleted, keeps B-only P3',
      same(ids(srv.rows.get('en_projects').value), [2, 3]),
      JSON.stringify(ids(srv.rows.get('en_projects').value)),
    );
    check(
      'F1a stale B local: P1 stays deleted, P3 kept',
      same(ids(B.DB.get('en_projects')), [2, 3]),
      JSON.stringify(ids(B.DB.get('en_projects'))),
    );
    const A2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: A });
    check(
      'F1a A local after reload: [2,3]',
      same(ids(A2.DB.get('en_projects')), [2, 3]),
      JSON.stringify(ids(A2.DB.get('en_projects'))),
    );
    const tomb = srv.rows.get('en_deleted_records') && srv.rows.get('en_deleted_records').value;
    check(
      'F1a shared deletion record holds the stamp only (no item copy)',
      tomb &&
        tomb.en_projects &&
        tomb.en_projects['1'] &&
        typeof tomb.en_projects['1'].t === 'number' &&
        tomb.en_projects['1'].item === undefined,
      JSON.stringify(tomb).slice(0, 200),
    );
    const keptA = A.idb.data.get('ch_deleted_items') || {};
    check(
      'F1a deleting browser keeps the item copy locally (ch_deleted_items)',
      keptA.en_projects &&
        keptA.en_projects['1'] &&
        keptA.en_projects['1'].item &&
        keptA.en_projects['1'].item.name === 'P1',
      JSON.stringify(keptA).slice(0, 200),
    );
    check(
      'F1a stale B archived the local copy that held P1',
      JSON.stringify(B.DB.get('en_conflict_archive', [])).indexOf('P1') !== -1,
      '',
    );
  });

  await scenario('F1b', async () => {
    const srv = makeServer({ en_projects: [proj(1, 'P1'), proj(2, 'P2')] });
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const B = await boot({ host: NETLIFY, signedIn: true, server: srv });
    A.DB.set('en_projects', [proj(2, 'P2')]);
    await tick(60);
    const B2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: B });
    check(
      'F1b normal two-user: unedited B reload follows the delete',
      same(ids(B2.DB.get('en_projects')), [2]),
      JSON.stringify(ids(B2.DB.get('en_projects'))),
    );
    // D edits from a stale list: the merge must not bring P1 back, and a pure addition needs no modal.
    let modals = 0;
    const srv2 = makeServer({ en_projects: [proj(1, 'P1'), proj(2, 'P2')] });
    const D = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv2,
      onCtx: (ctx) => {
        ctx.window.SyncConflictUI = {
          showConflictModal: async () => {
            modals++;
            return { action: 'load-theirs' };
          },
        };
      },
    });
    const E = await boot({ host: NETLIFY, signedIn: true, server: srv2 });
    E.DB.set('en_projects', [proj(2, 'P2')]); // E deletes P1
    await tick(60);
    D.DB.set('en_projects', [proj(1, 'P1'), proj(2, 'P2'), proj(4, 'P4')]); // D still holds P1, adds P4
    await tick(200);
    check(
      'F1b stale edit (addition only): merged with no modal',
      modals === 0 && same(ids(D.DB.get('en_projects')), [2, 4]),
      'modals=' + modals + ' local=' + JSON.stringify(ids(D.DB.get('en_projects'))),
    );
    check(
      'F1b stale edit: final server list [2,4]',
      same(ids(srv2.rows.get('en_projects').value), [2, 4]),
      JSON.stringify(ids(srv2.rows.get('en_projects').value)),
    );
  });

  // ---- Re-review fixes (2026-10-05): two users, one shared list ----
  const modalStub = (log, answer) => (ctx) => {
    ctx.window.SyncConflictUI = {
      showConflictModal: async (d) => {
        log.push(d);
        return typeof answer === 'function' ? answer(d, ctx) : answer || { action: 'load-theirs' };
      },
    };
  };
  const pair = async (srv, answerA, answerB) => {
    const mA = [],
      mB = [];
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv, onCtx: modalStub(mA, answerA) });
    const B = await boot({ host: NETLIFY, signedIn: true, server: srv, onCtx: modalStub(mB, answerB) });
    return { A, B, mA, mB };
  };
  const four = () => ({ en_projects: [proj(1, 'P1'), proj(2, 'P2'), proj(3, 'P3'), proj(4, 'P4')] });
  const srvIds = (srv) => ids(srv.rows.get('en_projects').value);
  const tombIds = (srv) => {
    const t = srv.rows.get('en_deleted_records');
    return t && t.value && t.value.en_projects ? Object.keys(t.value.en_projects).map(Number).sort() : [];
  };
  const rename = (b, id, name) =>
    b.DB.set(
      'en_projects',
      JSON.parse(JSON.stringify(b.DB.get('en_projects'))).map((p) =>
        p.id === id ? Object.assign({}, p, { name }) : p,
      ),
    );
  const byId = (list, id) => (list || []).find((p) => p.id === id);

  // Finding 1: two users delete different projects at the same time.
  await scenario('R1', async () => {
    const srv = makeServer(four());
    const { A, B, mA, mB } = await pair(srv);
    A.DB.set(
      'en_projects',
      A.DB.get('en_projects').filter((p) => p.id !== 1),
    );
    B.DB.set(
      'en_projects',
      B.DB.get('en_projects').filter((p) => p.id !== 2),
    );
    await tick(400);
    check('R1 concurrent deletes: server list lost both', same(srvIds(srv), [3, 4]), JSON.stringify(srvIds(srv)));
    check(
      'R1 concurrent deletes: server deletion records hold both ids',
      same(tombIds(srv), [1, 2]),
      JSON.stringify(tombIds(srv)),
    );
    check(
      'R1 concurrent deletes: no modal on either side',
      mA.length === 0 && mB.length === 0,
      'A=' + mA.length + ' B=' + mB.length,
    );
    const A2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: A });
    const B2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: B });
    check(
      'R1 both browsers show [3,4] after reload',
      same(ids(A2.DB.get('en_projects')), [3, 4]) && same(ids(B2.DB.get('en_projects')), [3, 4]),
      JSON.stringify(ids(A2.DB.get('en_projects'))) + JSON.stringify(ids(B2.DB.get('en_projects'))),
    );
    check('R1 queue empty on both', A2.DB.getQueueDepth() === 0 && B2.DB.getQueueDepth() === 0, '');
  });

  // B1 (re-review): page globals hold the cache reference and are saved back as is.
  // A merge must land INSIDE that reference, so the next page save keeps the other
  // user's record (X1) and the other user's edit (X2).
  await scenario('X1', async () => {
    const srv = makeServer(four());
    const { A, B } = await pair(srv);
    const staleA = A.DB.get('en_projects'); // stands for the page global `projects` (core.js init)
    B.DB.set('en_projects', B.DB.get('en_projects').concat([proj(5, 'P5-from-B')]));
    await tick(300);
    staleA[0].name = 'P1-edited-by-A';
    A.DB.set('en_projects', staleA); // 409 -> merge brings P5 into A's list
    await tick(400);
    check(
      'X1 merge lands in the page global (same reference)',
      A.DB.get('en_projects') === staleA && same(ids(staleA), [1, 2, 3, 4, 5]),
      JSON.stringify(ids(staleA)),
    );
    staleA[1].name = 'P2-edited-by-A';
    A.DB.set('en_projects', staleA);
    await tick(400);
    check(
      'X1 B project 5 survives A second edit from the page list',
      srvIds(srv).includes(5) && same(tombIds(srv), []),
      JSON.stringify(srvIds(srv)) + ' tomb ' + JSON.stringify(tombIds(srv)),
    );
  });
  await scenario('X2', async () => {
    const srv = makeServer(four());
    const { A, B } = await pair(srv);
    const staleA = A.DB.get('en_projects');
    rename(B, 3, 'P3 by B');
    await tick(300);
    staleA[0].name = 'P1 by A';
    A.DB.set('en_projects', staleA); // 409 -> merge brings B's P3 edit into A's list
    await tick(400);
    staleA[1].name = 'P2 by A';
    A.DB.set('en_projects', staleA);
    await tick(400);
    const s = srv.rows.get('en_projects').value;
    check(
      'X2 other user edit survives a later save from the page list',
      byId(s, 3).name === 'P3 by B' && byId(s, 1).name === 'P1 by A' && byId(s, 2).name === 'P2 by A',
      JSON.stringify(s.map((p) => p.name)),
    );
  });
  await scenario('X5', async () => {
    const srv = makeServer(four());
    const { A, B } = await pair(srv);
    const list = A.DB.get('en_projects');
    const held = list.find((p) => p.id === 1); // the open project, held across a save
    B.DB.set(
      'en_projects',
      JSON.parse(JSON.stringify(B.DB.get('en_projects'))).map((p) =>
        p.id === 1 ? Object.assign({}, p, { client: 'Client by B' }) : p,
      ),
    );
    await tick(300);
    list.find((p) => p.id === 2).name = 'P2 by A';
    A.DB.set('en_projects', list); // 409 -> merge brings B's P1 client into A's list
    await tick(400);
    check(
      'X5 merge keeps the held object (same reference, B field copied in)',
      list.find((p) => p.id === 1) === held && held.client === 'Client by B',
      JSON.stringify(held),
    );
    held.name = 'P1 via held reference';
    A.DB.set('en_projects', list);
    await tick(400);
    const s1 = byId(srv.rows.get('en_projects').value, 1);
    check(
      'X5 edit through the held reference reaches the server with B field kept',
      s1.name === 'P1 via held reference' && s1.client === 'Client by B',
      JSON.stringify(s1),
    );
  });
  await scenario('X3', async () => {
    const srv = makeServer(four());
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const list = A.DB.get('en_projects');
    list.splice(0, 1); // page deletes P1 in place and saves the same array
    A.DB.set('en_projects', list);
    await tick(200);
    check(
      'X3 in-place delete on the same reference still records the deletion',
      same(srvIds(srv), [2, 3, 4]) && same(tombIds(srv), [1]),
      JSON.stringify(srvIds(srv)) + ' tomb ' + JSON.stringify(tombIds(srv)),
    );
  });
  await scenario('X4', async () => {
    const ev = (name) => ({ date: '2026-10-05', name, type: 'holiday' });
    const srv = makeServer({ en_dc_events: { events: [ev('E1')], viewYear: 2026, viewMonth: 9 } });
    const { A, B } = await pair(srv);
    const pageEvents = A.DB.get('en_dc_events').events; // district-calendar `dcEvents`
    B.DB.set('en_dc_events', { events: [ev('E1'), ev('E2-from-B')], viewYear: 2026, viewMonth: 9 });
    await tick(300);
    pageEvents.push(ev('E3-from-A'));
    A.DB.set('en_dc_events', { events: pageEvents, viewYear: 2026, viewMonth: 10 }); // 409 -> merge
    await tick(400);
    check(
      'X4 calendar merge lands in the page events array',
      pageEvents
        .map((e) => e.name)
        .sort()
        .join(',') === 'E1,E2-from-B,E3-from-A',
      pageEvents.map((e) => e.name).join(','),
    );
    A.DB.set('en_dc_events', { events: pageEvents, viewYear: 2026, viewMonth: 11 });
    await tick(400);
    const names = srv.rows
      .get('en_dc_events')
      .value.events.map((e) => e.name)
      .sort()
      .join(',');
    check(
      'X4 calendar: both users events on the server after a later page save',
      names === 'E1,E2-from-B,E3-from-A',
      names,
    );
  });

  // Finding 2: restore from backup (sync on) must survive a stale browser.
  await scenario('R2', async () => {
    const srv = makeServer({ en_projects: [proj(1, 'P1'), proj(2, 'P2')] });
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    A.DB.set('en_projects', [proj(2, 'P2')]); // A deletes P1
    await tick(60);
    const rows = await A.DB.restoreFetchServer(['en_projects']);
    const r = await A.DB.restorePush('en_projects', [proj(1, 'P1'), proj(2, 'P2')], rows.get('en_projects') || null);
    await tick(60);
    check(
      'R2 restorePush ok and server list has P1 again',
      r.ok && same(srvIds(srv), [1, 2]),
      JSON.stringify(r) + JSON.stringify(srvIds(srv)),
    );
    const C = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_projects: [proj(1, 'P1'), proj(2, 'P2')] },
    }); // stale, never synced
    await tick(200);
    check(
      'R2 stale browser after restore: server still has P1',
      same(srvIds(srv), [1, 2]),
      JSON.stringify(srvIds(srv)),
    );
    check(
      'R2 stale browser local has P1',
      same(ids(C.DB.get('en_projects')), [1, 2]),
      JSON.stringify(ids(C.DB.get('en_projects'))),
    );
    const A2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: A });
    check(
      'R2 restoring browser still has P1 after reload',
      same(ids(A2.DB.get('en_projects')), [1, 2]),
      JSON.stringify(ids(A2.DB.get('en_projects'))),
    );
  });

  // Finding 3: deletion-record fetch fails -> no merge/upload of lists until it succeeds.
  await scenario('R3', async () => {
    const srv = makeServer({ en_projects: [proj(1, 'P1'), proj(2, 'P2')] });
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    A.DB.set('en_projects', [proj(2, 'P2')]); // A deletes P1
    await tick(60);
    srv.failGetKeys = new Set(['en_deleted_records']);
    const putsBefore = srv.puts.length;
    let statusEvents = [];
    const C = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: { en_projects: [proj(1, 'P1'), proj(2, 'P2')] },
      onCtx: (c) => c.addEventListener('dbDeletionRecordsStatus', (e) => statusEvents.push(e.detail)),
    });
    await tick(300);
    check(
      'R3 fetch 500: no PUT of the list, server keeps P1 deleted',
      srv.puts.length === putsBefore && same(srvIds(srv), [2]),
      'puts=' + (srv.puts.length - putsBefore) + ' ' + JSON.stringify(srvIds(srv)),
    );
    const st = await C.DB.getSyncStatus();
    check(
      'R3 fetch 500: sync status reports the blocked deletion records',
      st.deletionRecords && st.deletionRecords.ok === false && statusEvents.some((e) => e.ok === false),
      JSON.stringify(st.deletionRecords),
    );
    srv.failGetKeys = null;
    await tick(5600); // first retry after 5 s
    check(
      'R3 after the server recovers: records loaded, stale list merged, P1 stays deleted',
      same(ids(C.DB.get('en_projects')), [2]) && same(srvIds(srv), [2]) && statusEvents.some((e) => e.ok === true),
      JSON.stringify(ids(C.DB.get('en_projects'))) + ' ' + JSON.stringify(statusEvents.map((e) => e.ok)),
    );
  });

  // Finding 4: deletion records hold stamps only and expire after 90 days.
  await scenario('R4', async () => {
    const old = Date.now() - 91 * 24 * 3600 * 1000;
    const srv = makeServer({
      en_projects: [proj(1, 'P1'), proj(2, 'P2')],
      en_deleted_records: { en_projects: { 9: { t: old, item: proj(9, 'old') } } },
    });
    const A = await boot({ host: NETLIFY, signedIn: true, server: srv });
    A.DB.set('en_projects', [proj(2, 'P2')]);
    await tick(100);
    const t = srv.rows.get('en_deleted_records').value;
    check(
      'R4 shared record: stamp only, 91-day-old entry pruned',
      t.en_projects && t.en_projects['1'] && t.en_projects['1'].item === undefined && t.en_projects['9'] === undefined,
      JSON.stringify(t),
    );
    const kept = A.idb.data.get('ch_deleted_items') || {};
    check(
      'R4 local copy of the deleted item kept (90 days)',
      kept.en_projects && kept.en_projects['1'] && kept.en_projects['1'].item.name === 'P1',
      JSON.stringify(kept),
    );
  });

  // Finding 5 (core goal): two users edit at the same time.
  await scenario('R5', async () => {
    const srv = makeServer(four());
    const { A, B, mA, mB } = await pair(srv);
    rename(A, 1, 'P1 by A');
    rename(B, 2, 'P2 by B');
    await tick(400);
    const s = srv.rows.get('en_projects').value;
    check(
      'R5 different projects at once: server has both edits',
      byId(s, 1).name === 'P1 by A' && byId(s, 2).name === 'P2 by B',
      JSON.stringify(s.map((p) => p.name)),
    );
    check('R5 different projects: no modal', mA.length === 0 && mB.length === 0, 'A=' + mA.length + ' B=' + mB.length);
    const A2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: A });
    const B2 = await boot({ host: NETLIFY, signedIn: true, server: srv, reuse: B });
    const a = A2.DB.get('en_projects'),
      b = B2.DB.get('en_projects');
    check(
      'R5 both browsers hold both edits after reload',
      byId(a, 1).name === 'P1 by A' &&
        byId(a, 2).name === 'P2 by B' &&
        byId(b, 1).name === 'P1 by A' &&
        byId(b, 2).name === 'P2 by B',
      JSON.stringify(a.map((p) => p.name)) + JSON.stringify(b.map((p) => p.name)),
    );
    check(
      'R5 nothing archived as lost',
      A2.DB.getConflictArchive().length === 0 && B2.DB.getConflictArchive().length === 0,
      A2.DB.getConflictArchive().length + '/' + B2.DB.getConflictArchive().length,
    );
  });
  await scenario('R5b', async () => {
    const srv = makeServer(four());
    const { A, B, mA, mB } = await pair(srv);
    rename(A, 1, 'P1 by A');
    B.DB.set(
      'en_projects',
      JSON.parse(JSON.stringify(B.DB.get('en_projects'))).map((p) =>
        p.id === 1 ? Object.assign({}, p, { client: 'Client by B' }) : p,
      ),
    );
    await tick(400);
    const s1 = byId(srv.rows.get('en_projects').value, 1);
    check(
      'R5b same project, different fields: both fields on the server, no modal',
      s1.name === 'P1 by A' && s1.client === 'Client by B' && mA.length === 0 && mB.length === 0,
      JSON.stringify(s1) + ' modals=' + (mA.length + mB.length),
    );
  });
  await scenario('R5c', async () => {
    const srv = makeServer(four());
    const answer = (d) => ({
      action: 'records',
      choices: Object.fromEntries(d.records.map((r) => [String(r.id), 'mine'])),
    });
    const { A, B, mA, mB } = await pair(srv, answer, answer);
    rename(A, 1, 'P1 by A');
    rename(B, 1, 'P1 by B');
    await tick(400);
    const m = mA.concat(mB);
    check(
      'R5c same field on both sides: one per-record prompt, only that record listed',
      m.length === 1 &&
        m[0].conflictClass === 'records' &&
        m[0].records.length === 1 &&
        String(m[0].records[0].id) === '1' &&
        same(m[0].records[0].fields, ['name']),
      JSON.stringify(m.map((d) => d.conflictClass + ':' + (d.records || []).map((r) => r.id))),
    );
    const loser = m.length === 1 ? (mA.length ? B : A) : null; // the side that did not get the prompt
    const winner = m.length === 1 ? (mA.length ? A : B) : null;
    const s1 = byId(srv.rows.get('en_projects').value, 1);
    check(
      'R5c "keep mine" wins on the server',
      winner && s1.name === (winner === A ? 'P1 by A' : 'P1 by B'),
      JSON.stringify(s1),
    );
    const arch = winner ? winner.DB.getConflictArchive() : [];
    check(
      'R5c the other version is archived (record-conflict), nothing silently dropped',
      loser &&
        arch.some(
          (e) =>
            e.reason === 'record-conflict' &&
            e.losingValue &&
            e.losingValue.name === (loser === A ? 'P1 by A' : 'P1 by B'),
        ),
      JSON.stringify(arch.map((e) => e.reason + ':' + (e.losingValue && e.losingValue.name))),
    );
    check('R5c other projects untouched', same(srvIds(srv), [1, 2, 3, 4]), JSON.stringify(srvIds(srv)));
  });

  // Finding 9: an edit to a project someone else deleted is archived, not dropped.
  await scenario('R9', async () => {
    const srv = makeServer(four());
    const { A, B, mA } = await pair(srv);
    B.DB.set(
      'en_projects',
      B.DB.get('en_projects').filter((p) => p.id !== 1),
    ); // B deletes P1
    await tick(120);
    rename(A, 1, 'P1 edited by A'); // A still holds P1
    await tick(300);
    const arch = A.DB.getConflictArchive();
    check(
      'R9 stale edit of a deleted project: archived as deleted-elsewhere, no modal',
      mA.length === 0 &&
        arch.some(
          (e) => e.reason === 'deleted-elsewhere' && JSON.stringify(e.losingValue).indexOf('P1 edited by A') !== -1,
        ),
      'modals=' + mA.length + ' ' + JSON.stringify(arch.map((e) => e.reason)),
    );
    check(
      'R9 P1 stays deleted on the server and locally',
      same(srvIds(srv), [2, 3, 4]) && same(ids(A.DB.get('en_projects')), [2, 3, 4]),
      JSON.stringify(srvIds(srv)) + JSON.stringify(ids(A.DB.get('en_projects'))),
    );
  });

  // Finding 6: a modal resolved after a user switch writes nothing.
  await scenario('R6', async () => {
    const srv = makeServer(SEED());
    const b = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      onCtx: (c) => {
        c.window.SyncConflictUI = {
          showConflictModal: async () => {
            // user switches while the modal is open
            c.window.CH_AUTH.getUserId = () => 'user-2';
            c.window.dispatchEvent({ type: 'chAuthStateChanged' });
            await tick(50);
            return { action: 'overwrite-mine' };
          },
        };
      },
    });
    srv.rows.set('en_budget_a', { value: { n: 'OTHER-DEVICE' }, version: 9, deleted: false });
    const putsBefore = srv.puts.length;
    b.DB.set('en_budget_a', { n: 'MINE' });
    await tick(400);
    const puts = srv.puts
      .slice(putsBefore)
      .map((p) => JSON.parse(p))
      .filter((p) => p.key === 'en_budget_a');
    check(
      'R6 overwrite chosen after a user switch: nothing sent, server untouched',
      puts.length === 1 && same(srv.rows.get('en_budget_a').value, { n: 'OTHER-DEVICE' }),
      puts.length + ' PUTs (1 = the original 409 attempt)',
    );
    // The new identity's own hydration pulled the server value; the local edit is archived, not lost.
    check(
      'R6 new identity holds the server value, the old edit is archived',
      same(b.DB.get('en_budget_a'), { n: 'OTHER-DEVICE' }) &&
        b.DB.getConflictArchive().some((e) => same(e.losingValue, { n: 'MINE' })),
      JSON.stringify(b.DB.get('en_budget_a')),
    );
  });

  // Finding 7: stale upload workers never touch the new identity's progress counter.
  await scenario('R7', async () => {
    const srv = makeServer({ en_budget_seed: 1 });
    srv.putLatency = 40;
    const idbSeed = {};
    for (let i = 0; i < 12; i++) idbSeed['en_budget_k' + i] = { i };
    const b = await boot({ host: NETLIFY, signedIn: true, server: srv, idbSeed });
    await tick(60); // first uploads in flight
    b.ctx.window.CH_AUTH.getUserId = () => 'user-2';
    b.ctx.window.dispatchEvent({ type: 'chAuthStateChanged' });
    await tick(900);
    const p = b.DB.getUploadProgress();
    check(
      'R7 progress after the switch belongs to the new identity (no stale increments)',
      p.running === false && p.done <= p.total,
      JSON.stringify(p),
    );
  });

  // Hardening: a batch-GET row that was not requested is ignored (no junk cache key).
  await scenario('R8', async () => {
    const srv = makeServer(SEED());
    srv.extraRows = [{ key: 'constructor', value: { junk: 1 }, version: 1, deleted: false }];
    const b = await boot({ host: NETLIFY, signedIn: true, server: srv });
    const junk = b.DB.getAllKeys().filter((k) => /function|constructor/.test(k));
    check('R8 unrequested batch row ignored', junk.length === 0, JSON.stringify(junk));
  });

  // ---- F2: first-connect upload is in the background ----
  await scenario('F2', async () => {
    const srv = makeServer({ en_budget_seed: 1 });
    srv.putLatency = 40;
    srv.failPutOnce = new Set(['en_budget_k3']);
    const idbSeed = {};
    for (let i = 0; i < 20; i++) idbSeed['en_budget_k' + i] = { i };
    const t0 = Date.now();
    const B = await boot({ host: NETLIFY, signedIn: true, server: srv, idbSeed });
    const tRender = Date.now() - t0;
    const rowsAtRender = srv.rows.size;
    check(
      'F2 warmCache (render) resolves before uploads finish',
      rowsAtRender < 21 && tRender < 400,
      'rows=' + rowsAtRender + ' ms=' + tRender,
    );
    await tick(600);
    check(
      'F2 background upload finished: 19 keys on server, 1 failed',
      srv.rows.size === 1 + 19 && !srv.rows.has('en_budget_k3'),
      'rows=' + srv.rows.size,
    );
    check(
      'F2 failed upload is queued (never lost)',
      B.DB.getQueueDepth() === 1 && B.DB.get('en_budget_k3') !== null,
      'q=' + B.DB.getQueueDepth(),
    );
    check(
      'F2 user sees the failure',
      B.toasts.some((m) => /could not|waiting/i.test(m)),
      JSON.stringify(B.toasts),
    );
    const pr = B.DB.getUploadProgress && B.DB.getUploadProgress();
    check(
      'F2 progress reported (total 20, failed 1)',
      pr && pr.total === 20 && pr.failed === 1 && pr.running === false,
      JSON.stringify(pr),
    );
    B.ctx.window.dispatchEvent({ type: 'online' });
    await tick(300);
    check(
      'F2 failed upload retried and lands',
      srv.rows.has('en_budget_k3') && B.DB.getQueueDepth() === 0,
      'q=' + B.DB.getQueueDepth(),
    );
  });

  await scenario('H', async () => {
    for (const h of [
      'other-site.netlify.app',
      'deploy-preview-3--cscdashboard.netlify.app',
      'cscdashboard.netlify.app.evil.com',
    ]) {
      const srv = makeServer(SEED());
      const { ctx } = await boot({ host: h, signedIn: true, server: srv });
      check(
        'H host ' + h + ': mode off, 0 calls',
        ctx.window.CH_AUTH.backendMode() === 'off' && srv.calls.length === 0,
        srv.calls.length + '',
      );
    }
  });

  // ---- Identity switch race + prototype keys ----
  await scenario('S1', async () => {
    const seedSrv = { en_budget_s: { n: 1 } };
    for (let i = 0; i < 30; i++) seedSrv['user-1::ch_pref_a' + i] = 'A-secret-' + i; // user A's per-user rows on the server
    const srv = makeServer(seedSrv);
    srv.getLatency = 150;
    const b = await boot({ host: NETLIFY, signedIn: true, server: srv, skipWarm: true });
    const hyd = b.DB.warmCache(); // user A hydrates: manifest, then a slow batch read
    await tick(220); // manifest done, batch read pending
    const s2 = JSON.parse(b.ls.get('ch_sb_session'));
    s2.user_id = 'user-2';
    b.ls.set('ch_sb_session', JSON.stringify(s2));
    b.ctx.window.CH_AUTH.getUserId = () => 'user-2';
    b.ctx.window.dispatchEvent({ type: 'chAuthStateChanged' });
    await hyd;
    await tick(900);
    const leaked = Object.keys(seedSrv).filter((k) => k.indexOf('user-1::') === 0 && b.DB.get(k.slice(8)) !== null);
    check(
      'S1 old user per-user rows are not written into the cache after the switch',
      leaked.length === 0,
      leaked.length + ' leaked, e.g. ' + leaked.slice(0, 2),
    );
    const puts = srv.puts
      .map((x) => JSON.parse(x))
      .filter((x) => JSON.stringify(x.value || '').indexOf('A-secret') !== -1);
    check('S1 old user values never PUT to the server', puts.length === 0, puts.length + '');
    check(
      'S1 upload progress not left running',
      !b.DB.getUploadProgress().running,
      JSON.stringify(b.DB.getUploadProgress()),
    );
  });

  await scenario('P1', async () => {
    const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"ok":{"t":5}}');
    const srv = makeServer({
      en_projects: [proj(1, 'P1')],
      en_deleted_records: { en_projects: evil, constructor: { x: 1 } },
    });
    const B = await boot({
      host: NETLIFY,
      signedIn: true,
      server: srv,
      idbSeed: {
        en_projects: [proj(1, 'P1')],
        en_deleted_records: { en_projects: { 9: { t: 3, item: proj(9, 'x') } } },
      },
    });
    await tick(100);
    check('P1 Object.prototype not polluted', {}.polluted === undefined && {}.x === undefined, String({}.polluted));
    const d = B.DB.get('en_deleted_records') || {};
    check(
      'P1 merged records hold no __proto__/constructor keys',
      !Object.prototype.hasOwnProperty.call(d, 'constructor') &&
        !Object.prototype.hasOwnProperty.call(d.en_projects || {}, '__proto__') &&
        !Object.prototype.hasOwnProperty.call(d.en_projects || {}, 'constructor'),
      JSON.stringify(d).slice(0, 200),
    );
    check(
      'P1 id "__proto__" in a list is not dropped as deleted',
      same(ids(B.DB.get('en_projects')), [1]),
      JSON.stringify(B.DB.get('en_projects')),
    );
  });

  let fail = 0;
  results.forEach((r) => {
    if (!r.ok) fail++;
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  -> ' + r.detail));
  });
  console.log(results.length - fail + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
