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

const NETLIFY = 'chub-test.netlify.app';
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
    put: (v, k) => (data.set(k, JSON.parse(JSON.stringify(v))), mkReq(() => k)),
    delete: (k) => (data.delete(k), mkReq(() => undefined)),
    clear: () => (data.clear(), mkReq(() => undefined)),
    getAll: () => mkReq(() => Array.from(data.values())),
    getAllKeys: () => mkReq(() => Array.from(data.keys())),
  });
  const idb = {
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
      return res(
        200,
        Array.from(rows, ([key, r]) => ({
          key,
          version: r.version,
          hash: 'srvhash-' + key + '-' + r.version,
          deleted: r.deleted,
        })),
      );
    }
    if (method === 'GET') {
      const keys = decodeURIComponent(url.split('keys=')[1]).split(',');
      return res(
        200,
        keys.filter((k) => rows.has(k)).map((k) => Object.assign({ key: k }, rows.get(k))),
      );
    }
    if (method === 'PUT') {
      srv.puts.push(opts.body);
      if (srv.unauthorized401ForPut) return res(401, { error: 'unauthorized' });
      const b = JSON.parse(opts.body);
      if (b.deleted) srv.tombstones.push(b.key);
      const cur = rows.get(b.key);
      if (cur ? cur.version !== b.baseVersion : b.baseVersion !== null)
        return res(409, { error: 'conflict', current: cur });
      const version = cur ? cur.version + 1 : 1;
      rows.set(b.key, { value: b.deleted ? null : b.value, version, deleted: !!b.deleted });
      return res(200, { version, hash: 'h-' + b.key + '-' + version });
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

async function boot({ host, signedIn, storedMode, server, idbSeed, lsSeed }) {
  const listeners = {};
  const ls = new Map(Object.entries(lsSeed || {}));
  if (storedMode) ls.set('ch_backend_mode', storedMode);
  if (signedIn) {
    ls.set(
      'ch_sb_session',
      JSON.stringify(fakeSession()),
    );
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
  const idb = makeIdb(idbSeed);
  const ctx = {
    console: { log() {}, warn: process.env.DBG ? console.warn : () => {}, error() {}, info() {} },
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
  await ctx.window.DB.warmCache();
  return { ctx, DB: ctx.window.DB, idb, ls };
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

const SEED = () => ({ en_budget_a: { n: 1 }, en_budget_b: [1, 2, 3], en_budget_c: 'hello', en_budget_d: { deep: { x: 4 } }, en_budget_e: 5 });
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
    check('4 401 mid-session: value kept locally', same(DB.get('en_budget_a'), { n: 2 }), JSON.stringify(DB.get('en_budget_a')));
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
    const { ctx, DB } = await boot({ host: NETLIFY, signedIn: true, storedMode: 'shadow', server: srv });
    const want = SEED();
    check(
      '6 stored shadow on Netlify: mode is on',
      ctx.window.CH_AUTH.backendMode() === 'on',
      ctx.window.CH_AUTH.backendMode(),
    );
    check('6 stored shadow on Netlify: hydrated, not overwritten', same(cacheOf(DB, Object.keys(want)), want), '');
    check(
      '6 stored shadow on Netlify: setBackendMode(shadow) refused',
      DB.setBackendMode('shadow') === false && ctx.window.CH_AUTH.backendMode() === 'on',
      '',
    );
    check('6 stored shadow on Netlify: 0 PUTs', srv.puts.length === 0, srv.puts.length + ' PUTs');
  });

  await scenario('7', async () => {
    const srv = makeServer(SEED());
    const stale = { en_budget_a: { n: 'STALE-LOCAL' }, en_budget_local_only: { keep: true } };
    const { DB } = await boot({ host: NETLIFY, signedIn: true, storedMode: 'on', server: srv, idbSeed: stale });
    await tick(40);
    check(
      '7 drift (stale local, empty version map): 0 wholesale pushes',
      srv.puts.length === 0,
      srv.puts.length + ' PUTs',
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

  let fail = 0;
  results.forEach((r) => {
    if (!r.ok) fail++;
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '  -> ' + r.detail));
  });
  console.log(results.length - fail + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
