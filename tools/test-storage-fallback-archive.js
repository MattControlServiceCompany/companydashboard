// Storage fallback + conflict archive size. Loads the REAL app/db.js in a node vm. SYNTHETIC data only. No network.
// A: indexedDB.open always fails and localStorage has a 5.2M-char quota (like a real browser). 12 MB of
//    server data must load with no QuotaExceededError, big keys stay in memory, a queued edit survives a reload.
// B: a 409 on a large non-list key adds a small archive entry that still rebuilds the losing value.
// Run: node tools/test-storage-fallback-archive.js
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
function browser(srv, store, opts) {
  opts = opts || {};
  const warns = [];
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
      setItem: (k, v) => {
        if (opts.quota) {
          let used = 0;
          Object.keys(store).forEach((x) => (used += x.length + String(store[x]).length));
          const old = k in store ? k.length + String(store[k]).length : 0;
          if (used - old + k.length + String(v).length > opts.quota) {
            const e = new Error('The quota has been exceeded.');
            e.name = 'QuotaExceededError';
            throw e;
          }
        }
        store[k] = String(v);
      },
      removeItem: (k) => delete store[k],
      key: (i) => Object.keys(store)[i] || null,
      get length() {
        return Object.keys(store).length;
      },
    },
    console: { log() {}, warn: (...a) => warns.push(a.map(String).join(' ')), error() {} },
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
    indexedDB: opts.failIdb
      ? {
          open() {
            opts.openCalls = (opts.openCalls || 0) + 1;
            const req = {};
            setTimeout(() => {
              req.error = new Error('UnknownError: Internal error');
              if (req.onerror) req.onerror();
            }, 0);
            return req;
          },
        }
      : undefined,
    fetch: srv.fetchImpl,
    showToast: (m) => toasts.push(m),
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
  return { DB: sandbox.__DB, dialogCalls, toasts, store, warns, opts };
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
const bigRows = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({ id: 'r' + i, name: tag + ' unit ' + i, notes: 'x'.repeat(700), pts: [i, i + 1, i + 2] }));
const offline = (srv) => ({
  fetchImpl: async (u, o) => {
    if (o && o.method === 'PUT') throw new Error('offline');
    return srv.fetchImpl(u, o);
  },
});

(async () => {
  await t('A: IndexedDB fails, 12 MB of server data: no QuotaExceededError, open retried once, queued edit survives reload', async () => {
    const srv = makeServer({
      en_eqmatrix_s1: { rows: bigRows(6000, 'm') },
      en_alarms_s1: { rows: bigRows(6000, 'a') },
      en_big3_s1: { rows: bigRows(3700, 'b') },
      en_budget_small: { note: 'base' },
    });
    const total = Object.keys(srv.rows).reduce((n, k) => n + JSON.stringify(srv.rows[k].value).length, 0);
    assert.ok(total > 12000000, 'test data is over 12 MB: ' + total);
    const store = {};
    const B = browser(srv, store, { failIdb: true, quota: 5200000 });
    await B.DB.warmCache();
    await B.DB.__t._hydrate();
    assert.strictEqual(B.opts.openCalls, 2, 'indexedDB.open tried twice (one retry), then fallback');
    assert.strictEqual(B.DB.get('en_eqmatrix_s1').rows.length, 6000, 'big key is in memory');
    assert.strictEqual(B.DB.get('en_alarms_s1').rows.length, 6000, 'second big key is in memory');
    assert.ok(!B.warns.some((w) => /Quota/i.test(w)), 'no quota error: ' + B.warns.filter((w) => /Quota/i.test(w)).slice(0, 2));
    assert.ok(!('en_eqmatrix_s1' in store) && !('en_alarms_s1' in store), 'big data keys are not mirrored in localStorage');
    // Offline edit of a small key: the send fails, the queue entry must persist in localStorage.
    const B2 = browser(offline(srv), store, { failIdb: true, quota: 5200000 });
    await B2.DB.warmCache();
    await B2.DB.__t._hydrate();
    await B2.DB.set('en_budget_small', { note: 'EDITED OFFLINE' });
    await tick(60);
    assert.ok(B2.DB.getQueueDepth() >= 1, 'edit is queued');
    assert.ok(/EDITED OFFLINE/.test(store['ch_sync_queue'] || ''), 'the queue is saved in localStorage');
    assert.ok(!B2.warns.some((w) => /Quota/i.test(w)), 'no quota error on the offline edit');
    // Reload: a new browser on the same store still has the edit.
    const B3 = browser(srv, store, { failIdb: true, quota: 5200000 });
    await B3.DB.warmCache();
    assert.ok(B3.DB.getQueueDepth() >= 1, 'queued edit is still there after reload');
    // An edit of a 5 MB key while offline: no throw, the page keeps the value.
    const big = B2.DB.get('en_eqmatrix_s1');
    big.rows[0].name = 'EDIT BIG';
    await B2.DB.set('en_eqmatrix_s1', big);
    assert.strictEqual(B2.DB.get('en_eqmatrix_s1').rows[0].name, 'EDIT BIG', 'in-memory value updated');
    assert.ok(B2.toasts.filter((m) => /Save failed/.test(m)).length <= 1, 'save-failed toast at most once');
  });

  await t('B: 409 on a large non-list key adds a small archive entry that rebuilds the losing value', async () => {
    const KEY = 'en_eqmatrix_conflict';
    const base = { rows: bigRows(4000, 'm'), cols: ['a', 'b'] };
    const size = JSON.stringify(base).length;
    assert.ok(size > 3000000, 'about 3 MB: ' + size);
    const srv = makeServer({ [KEY]: base });
    const B = browser(srv);
    await B.DB.warmCache();
    await B.DB.__t._hydrate();
    const theirs = clone(base);
    theirs.rows[10].notes = 'THEIRS';
    theirs.rows[3999].name = 'THEIRS name';
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    const mine = B.DB.get(KEY);
    mine.rows[10].notes = 'MINE';
    mine.rows[3999].name = 'MINE name';
    await B.DB.set(KEY, mine);
    await tick(300);
    assert.strictEqual(B.dialogCalls.length, 0);
    assert.strictEqual(srv.rows[KEY].value.rows[10].notes, 'MINE', 'later save is on the server');
    const arch = B.DB.getConflictArchive().filter((e) => e.key === KEY);
    assert.strictEqual(arch.length, 1);
    const archBytes = JSON.stringify(arch[0]).length;
    assert.ok(archBytes < 5000, 'archive entry is small: ' + archBytes + ' chars (value was ' + size + ')');
    assert.strictEqual(arch[0].losingValue, undefined, 'whole value is not copied');
    assert.ok(!('winningValue' in arch[0]), 'winning value is not stored');
    const rebuilt = B.DB.recoverArchivedValue(arch[0], srv.rows[KEY].value);
    assert.deepStrictEqual(clone(rebuilt), clone(theirs), 'the losing (their) value is rebuilt exactly');
  });

  await t('B2: diff rebuilds a losing value with added, removed and shortened items', async () => {
    const KEY = 'en_eqmatrix_shape';
    const base = { rows: bigRows(3000, 'm'), extra: { a: 1 }, tail: [1, 2, 3, 4] };
    const srv = makeServer({ [KEY]: base });
    const B = browser(srv);
    await B.DB.warmCache();
    await B.DB.__t._hydrate();
    const theirs = clone(base);
    theirs.rows.push({ id: 'new', name: 'added by them' });
    theirs.rows.splice(5, 1, { id: 'r5', name: 'changed' });
    delete theirs.extra;
    theirs.tail = [1, 2];
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    const mine = B.DB.get(KEY);
    mine.rows[0].name = 'MINE';
    mine.tail = [1, 2, 3, 4, 5];
    mine.fresh = true;
    await B.DB.set(KEY, mine);
    await tick(300);
    const arch = B.DB.getConflictArchive().filter((e) => e.key === KEY);
    assert.strictEqual(arch.length, 1);
    assert.ok(arch[0].losingDiff, 'diff form used');
    assert.deepStrictEqual(clone(B.DB.recoverArchivedValue(arch[0], srv.rows[KEY].value)), clone(theirs));
  });

  console.log('\n' + pass + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
