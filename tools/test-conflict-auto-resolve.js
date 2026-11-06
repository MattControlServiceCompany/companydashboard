// Same-field conflict resolves with no dialog: the later save wins and the replaced value is archived.
// Loads the REAL app/db.js in a node vm with a fake kv-sync server. SYNTHETIC data only. No network.
// The fake server copies the replaced row to a history list on every changing write, like kv-sync.js
// (kv_history). A dialog stub counts every call: it must stay at 0.
// Run: node tools/test-conflict-auto-resolve.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const clone = (v) => JSON.parse(JSON.stringify(v));

function makeServer(initial) {
  const rows = {};
  const history = []; // { key, value, version }: the row replaced by a changing write
  const puts = [];
  Object.keys(initial).forEach((k) => (rows[k] = { value: initial[k], version: 1, hash: 'h' + k + '1' }));
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (u, o) => {
    if (o && o.method === 'PUT') {
      const b = JSON.parse(o.body);
      puts.push(b);
      const cur = rows[b.key];
      if (cur && b.baseVersion !== cur.version) {
        return { ok: false, status: 409, json: async () => ({ conflict: true, current: Object.assign({ key: b.key, deleted: false }, cur) }) };
      }
      if (cur) history.push({ key: b.key, value: cur.value, version: cur.version });
      const version = cur ? cur.version + 1 : 1;
      rows[b.key] = { value: b.value, version, hash: 'h' + b.key + version };
      return ok({ version, hash: rows[b.key].hash, deleted: false });
    }
    if (/manifest=1/.test(u)) {
      return ok(Object.keys(rows).map((k) => ({ key: k, version: rows[k].version, hash: rows[k].hash, deleted: false })));
    }
    const keys = decodeURIComponent(String(u).split('keys=')[1] || '').split(',').filter(Boolean);
    return ok(keys.filter((k) => rows[k]).map((k) => Object.assign({ key: k, deleted: false }, rows[k])));
  };
  return { rows, history, puts, fetchImpl };
}

// One browser: the real db.js with auth, a dialog stub that counts calls, and a toast list.
function browser(srv, store) {
  let src = fs.readFileSync(path.join(ROOT, 'app', 'db.js'), 'utf8').split('\r').join('');
  src = src.replace(
    '  return {\n    warmCache,',
    '  return {\n    __t: { _hydrate, _drainQueueOnce, _stampOf: (k) => _replicaVersions[k] },\n    warmCache,',
  );
  store = store || {};
  const dialogCalls = [];
  const toasts = [];
  const win = {
    addEventListener() {},
    dispatchEvent() {},
    location: { hostname: 'x' },
    CH_AUTH: {
      backendMode: () => 'on',
      isSyncHost: () => true,
      getToken: () => 'tok',
      ready: () => Promise.resolve(),
      getUserId: () => 'u1',
      getEmail: () => 'u1@example.invalid',
    },
    SyncClassification: require(path.join(ROOT, 'app', 'sync-classification.js')),
    // If any code path still opened a dialog, it would land here and the test would fail.
    SyncConflictUI: {
      showConflictModal: async (d) => {
        dialogCalls.push(d);
        return { action: 'dismiss' };
      },
    },
  };
  const sandbox = {
    window: win,
    document: { addEventListener() {}, visibilityState: 'visible' },
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
    showToast: (m) => toasts.push(m),
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
  return { DB: sandbox.__DB, dialogCalls, toasts, store };
}

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
async function syncedBrowser(srv) {
  const B = browser(srv);
  await B.DB.warmCache();
  await B.DB.__t._hydrate();
  return B;
}

(async () => {
  await t('plain key: same field changed on both sides -> no dialog, later save wins, replaced value archived', async () => {
    const KEY = 'en_budget_plain';
    const srv = makeServer({ [KEY]: { note: 'base' } });
    const B = await syncedBrowser(srv);
    // The other user saves first, then this user saves from a stale copy.
    srv.rows[KEY] = { value: { note: 'THEIRS' }, version: 2, hash: 'h2' };
    await B.DB.set(KEY, { note: 'MINE' });
    await tick(60);
    assert.strictEqual(B.dialogCalls.length, 0, 'no dialog opened');
    assert.deepStrictEqual(clone(srv.rows[KEY].value), { note: 'MINE' }, 'the later save is on the server');
    assert.deepStrictEqual(clone(B.DB.get(KEY)), { note: 'MINE' }, 'the page shows it');
    assert.strictEqual(B.DB.getQueueDepth(), 0, 'nothing left waiting');
    assert.ok(srv.history.some((h) => h.key === KEY && h.value.note === 'THEIRS'), 'the replaced server value is in kv_history');
    const arch = B.DB.getConflictArchive().filter((e) => e.key === KEY);
    assert.strictEqual(arch.length, 1, 'one conflict history entry');
    assert.deepStrictEqual(clone(arch[0].losingValue), { note: 'THEIRS' }, 'the conflict history holds the replaced value');
    assert.strictEqual(arch[0].losingSide, 'server');
    const conflictToasts = B.toasts.filter((m) => /Nothing was lost/.test(m)); // the sandbox has no IndexedDB: ignore its storage notice
    assert.strictEqual(conflictToasts.length, 1, 'one short toast: ' + JSON.stringify(B.toasts));
  });

  await t('record in a list: same field of the same record on both sides -> no dialog, later save wins, replaced record archived', async () => {
    const KEY = 'en_projects';
    const base = () => [
      { id: 'p1', name: 'Alpha', note: 'base' },
      { id: 'p2', name: 'Beta', note: 'base' },
    ];
    const srv = makeServer({ [KEY]: base() });
    const B = await syncedBrowser(srv);
    const theirs = base();
    theirs[0].note = 'THEIRS';
    theirs[1].name = 'Beta by them';
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    const mine = B.DB.get(KEY);
    mine[0].note = 'MINE';
    await B.DB.set(KEY, mine);
    await tick(80);
    assert.strictEqual(B.dialogCalls.length, 0, 'no dialog opened');
    const onServer = clone(srv.rows[KEY].value);
    assert.strictEqual(onServer[0].note, 'MINE', 'the later save wins the conflicting field');
    assert.strictEqual(onServer[1].name, 'Beta by them', 'the other record keeps the other user change (merged)');
    assert.strictEqual(B.DB.getQueueDepth(), 0);
    assert.ok(
      srv.history.some((h) => h.key === KEY && h.value[0].note === 'THEIRS'),
      'the replaced server list is in kv_history',
    );
    const arch = B.DB.getConflictArchive().filter((e) => e.reason === 'record-conflict');
    assert.strictEqual(arch.length, 1);
    assert.strictEqual(arch[0].losingValue.note, 'THEIRS', 'the conflict history holds the replaced record');
    assert.strictEqual(arch[0].losingSide, 'server');
  });

  await t('first load: unstamped local value that differs from the server -> no dialog, server copy kept, local value archived, nothing sent', async () => {
    const KEY = 'en_budget_x';
    const srv = makeServer({ [KEY]: { n: 'SERVER' } });
    const store = {};
    store[KEY] = JSON.stringify({ n: 'LOCAL' }); // never synced from this browser: no version stamp
    const B = browser(srv, store);
    await B.DB.warmCache();
    await B.DB.__t._hydrate();
    await tick(60);
    assert.strictEqual(B.dialogCalls.length, 0, 'no dialog opened');
    assert.deepStrictEqual(clone(B.DB.get(KEY)), { n: 'SERVER' });
    assert.strictEqual(srv.puts.filter((p) => p.key === KEY).length, 0, 'the stale local copy is never written over the server');
    const arch = B.DB.getConflictArchive().filter((e) => e.key === KEY);
    assert.strictEqual(arch.length, 1);
    assert.deepStrictEqual(clone(arch[0].losingValue), { n: 'LOCAL' }, 'the local value is kept in the conflict history');
  });

  await t('source check: no dialog code is left in db.js or sync-ui.js', () => {
    const db = fs.readFileSync(path.join(ROOT, 'app', 'db.js'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'app', 'sync-ui.js'), 'utf8');
    assert.ok(!/showConflictModal|_presentConflictModal|_driftNeedsAsk|_holdLocalDraft/.test(db), 'db.js has no dialog call');
    assert.ok(!/showConflictModal|ch-conflict-overlay|You both changed/.test(ui), 'sync-ui.js has no dialog');
  });

  console.log('\n' + pass + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
