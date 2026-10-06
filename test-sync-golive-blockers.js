// Unit tests for the Netlify go-live sync blockers B1b, B2, B4 (local mocks only; no network).
// Run: node test-sync-golive-blockers.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load({ mode, syncHost, fetchImpl, classify }) {
  let src = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
  src = src.split(String.fromCharCode(13)).join("").replace(
    '  return {\n    warmCache,',
    '  return {\n    __t: { _hydrate, _batchGetChunked, _drainQueueOnce, _clearPerUserLocalState, _handleAuthIdentityChange },\n    warmCache,',
  );
  const store = {};
  const events = [];
  const state = { mode, syncHost };
  const win = {
    addEventListener() {},
    dispatchEvent(e) {
      events.push(e);
    },
    location: { hostname: 'x' },
    CH_AUTH: {
      backendMode: () => state.mode,
      isSyncHost: () => state.syncHost,
      getToken: () => 'tok',
      getUserId: () => (state.uid !== undefined ? state.uid : state.mode === 'on' ? 'u1' : null),
      getEmail: () => state.email || 'u1@example.com',
    },
  };
  if (classify) win.SyncClassification = require('./app/sync-classification.js');
  const sandbox = {
    window: win,
    document: { addEventListener() {}, visibilityState: 'visible' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
      key: (i) => Object.keys(store)[i] || null,
      get length() {
        return Object.keys(store).length;
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    Promise,
    TextEncoder,
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
    fetch: fetchImpl,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
  return { DB: sandbox.__DB, state, events, store };
}
let pass = 0;
async function t(name, fn) {
  await fn();
  pass++;
  console.log('PASS ' + name);
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

(async () => {
  // ---- B4: chunking + retry + failure reporting
  await t('B4 chunks keys, never one huge GET', async () => {
    const urls = [];
    const { DB } = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u) => {
        urls.push(u);
        return ok([]);
      },
    });
    const keys = Array.from({ length: 20 }, (_, i) => 'k' + i);
    const r = await DB.__t._batchGetChunked(keys);
    assert.strictEqual(urls.length, Math.ceil(20 / 6));
    urls.forEach((u) => assert.ok(decodeURIComponent(u.split('keys=')[1]).split(',').length <= 6));
    assert.strictEqual(r.failedKeys.length, 0);
  });
  await t('B4 retries a failed chunk once and succeeds', async () => {
    let calls = 0;
    const { DB } = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? { ok: false, status: 500 } : ok([{ key: 'a' }]);
      },
    });
    const r = await DB.__t._batchGetChunked(['a']);
    assert.strictEqual(calls, 2);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.failedKeys.length, 0);
  });
  await t('B4 chunk failing twice is reported in failedKeys; other chunks still load', async () => {
    const { DB } = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u) => (decodeURIComponent(u).includes('k0') ? { ok: false, status: 500 } : ok([{ key: 'k9' }])),
    });
    const r = await DB.__t._batchGetChunked(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    assert.strictEqual(r.failedKeys.join(','), 'k0,k1,k2,k3,k4,k5');
    assert.strictEqual(r.rows.length, 1);
  });
  await t('B4 hydrate dispatches dbHydrateFailed when a chunk fails', async () => {
    const fetchImpl = async (u) => {
      if (u.includes('manifest=1')) return ok([{ key: 'en_a', version: 1, hash: 'h', deleted: false }]);
      return { ok: false, status: 500 };
    };
    const { DB, events } = load({ mode: 'on', syncHost: true, fetchImpl });
    await DB.warmCache();
    await DB.__t._hydrate();
    const ev = events.find((e) => e.type === 'dbHydrateFailed');
    assert.ok(ev, 'dbHydrateFailed not dispatched');
    assert.strictEqual(Array.from(ev.detail.keys).join(','), 'en_a');
  });

  // ---- B1b: edits while signed out upload after sign-in, via CAS (baseVersion), never blind
  await t('B1b edit while signed out on sync host is queued', async () => {
    const { DB } = load({
      mode: 'off',
      syncHost: true,
      fetchImpl: async () => {
        throw new Error('no network expected');
      },
    });
    await DB.warmCache();
    await DB.set('en_projects', [{ id: 1 }]);
    assert.strictEqual(DB.getQueueDepth(), 1);
  });
  await t('B1b edit on a non-sync host is NOT queued (zero sync)', async () => {
    const { DB } = load({
      mode: 'off',
      syncHost: false,
      fetchImpl: async () => {
        throw new Error('no network expected');
      },
    });
    await DB.warmCache();
    await DB.set('en_projects', [{ id: 1 }]);
    assert.strictEqual(DB.getQueueDepth(), 0);
  });
  await t('B1b queued edit is PUT once sync is back; a 409 is not overwritten', async () => {
    const puts = [];
    let respond = { ok: true, status: 200, json: async () => ({ version: 1, hash: 'h' }) };
    const fetchImpl = async (u, o) => {
      if (o && o.method === 'PUT') {
        puts.push(o.body);
        return respond;
      }
      return ok([]);
    };
    const L = load({ mode: 'on', syncHost: true, fetchImpl });
    await L.DB.warmCache();
    L.state.mode = 'off';
    await L.DB.set('en_projects', [{ id: 1 }]);
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 0, 'nothing sent while off');
    L.state.mode = 'on';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
    // server has a newer row -> 409 goes to the conflict path (CAS), never a blind overwrite
    L.state.mode = 'off';
    await L.DB.set('en_other', [{ id: 2 }]);
    respond = { ok: false, status: 409, json: async () => ({ error: 'conflict', currentVersion: 5 }) };
    L.state.mode = 'on';
    const before = puts.length;
    await L.DB.__t._drainQueueOnce();
    assert.ok(puts.length - before >= 1);
    puts.slice(before).forEach((b) => assert.ok(!/"force"\s*:\s*true/.test(String(b))));
  });

  // ---- B2: Sign Out calls CH_AUTH.signOut; one needsSignIn rule
  await t('B2 core.js signOut awaits CH_AUTH.signOut before redirect', () => {
    const core = fs.readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8');
    const m = core.match(/async function signOut\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'signOut not async');
    assert.ok(m[0].indexOf('await window.CH_AUTH.signOut()') > -1);
    assert.ok(m[0].indexOf('await window.CH_AUTH.signOut()') < m[0].indexOf('window.location.href'));
  });
  await t('B2 ch-auth: needsSignIn only on the sync host while signed out', () => {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'ch-auth.js'), 'utf8');
    for (const [host, expectNeeds] of [
      ['cscdashboard.netlify.app', true],
      ['example.github.io', false],
    ]) {
      const win = { addEventListener() {}, dispatchEvent() {}, location: { hostname: host } };
      const sb = {
        window: win,
        location: { hostname: host },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        CustomEvent: function () {},
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        setInterval: () => 0,
        Math,
        Date,
        JSON,
        Promise,
        console,
      };
      vm.createContext(sb);
      vm.runInContext(src, sb);
      assert.strictEqual(win.CH_AUTH.needsSignIn(), expectNeeds);
      assert.strictEqual(win.CH_AUTH.isSyncHost(), expectNeeds);
    }
  });

  // ---- Owner tags (manager decision 1)
  const sendOk = () => ({ ok: true, status: 200, json: async () => ({ version: 1, hash: 'h' }) });
  await t('Owner: entries of another user are never sent and never deleted; bar info reports them', async () => {
    const puts = [];
    const L = load({ mode: 'on', syncHost: true, fetchImpl: async (u, o) => { if (o && o.method === 'PUT') { puts.push(o.body); return sendOk(); } return ok([]); } });
    await L.DB.warmCache(); // u1 signed in, recorded as last user
    L.state.mode = 'off'; L.state.uid = null;
    await L.DB.set('en_projects', [{ id: 1 }]);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    L.state.mode = 'on'; L.state.uid = 'u2'; L.state.email = 'u2@example.com';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 0, 'user u2 must not send u1 edit');
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'entry kept');
    const info = L.DB.getForeignQueueInfo();
    assert.strictEqual(info.length, 1);
    assert.strictEqual(info[0].email, 'u1@example.com');
    assert.strictEqual(info[0].count, 1);
    // u1 signs back in: it drains
    L.state.uid = 'u1';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('Owner: same key from two users coalesces per owner, not across owners', async () => {
    const L = load({ mode: 'on', syncHost: true, fetchImpl: async () => ok([]) });
    await L.DB.warmCache();
    L.state.mode = 'off'; L.state.uid = null;
    await L.DB.set('en_projects', [{ id: 1 }]);
    L.state.mode = 'off'; L.state.uid = 'u2'; L.state.email = 'u2@example.com';
    await L.DB.set('en_projects', [{ id: 2 }]);
    const q = JSON.parse(L.store['ch_sync_queue'] || '[]').filter((e) => e.key === 'en_projects');
    assert.strictEqual(q.length, 2);
    assert.notStrictEqual(q[0].owner.id, q[1].owner.id);
  });
  await t('Owner: edit with no known user is kept but never sent', async () => {
    const puts = [];
    const L = load({ mode: 'off', syncHost: true, fetchImpl: async (u, o) => { if (o && o.method === 'PUT') puts.push(1); return ok([]); } });
    await L.DB.warmCache();
    await L.DB.set('en_projects', [{ id: 1 }]);
    L.state.mode = 'on'; L.state.uid = 'u2';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 0);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
  });

  // ---- Per-user keys (manager decision 2)
  await t('Per-user key edited while signed out is queued, survives the sign-in clear, and is sent for the same user', async () => {
    const puts = [];
    const L = load({ classify: true, mode: 'on', syncHost: true, fetchImpl: async (u, o) => { if (o && o.method === 'PUT') { puts.push(o.body); return sendOk(); } return ok([]); } });
    await L.DB.warmCache();
    L.state.mode = 'off'; L.state.uid = null;
    await L.DB.__t._handleAuthIdentityChange(); // sign-out event
    await L.DB.set('ch_theme', 'dark');
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'per-user edit queued');
    L.state.mode = 'on'; L.state.uid = 'u1';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(L.DB.get('ch_theme'), 'dark', 'local value not deleted');
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('_clearPerUserLocalState keeps a per-user key with a pending queued edit', async () => {
    const L = load({ classify: true, mode: 'on', syncHost: true, fetchImpl: async () => ok([]) });
    await L.DB.warmCache();
    L.state.mode = 'off'; L.state.uid = null;
    await L.DB.set('ch_theme', 'dark');
    await L.DB.set('ch_sidebar_pref', 'x');
    const cleared = L.DB.__t._clearPerUserLocalState();
    assert.ok(!cleared.includes('ch_theme'));
    assert.strictEqual(L.DB.get('ch_theme'), 'dark');
    assert.strictEqual(L.DB.getQueueDepth(), 2);
  });

  // ---- Demo (manager decision 3) and one ch_user clear function (decision 4)
  await t('Demo is disabled and hidden on the sync host (index.html + energy-department.html)', () => {
    const idx = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const m = idx.match(/function loginDemo\(\) \{[\s\S]*?\n      \}/);
    assert.ok(/isSyncHost\(\)\) return;/.test(m[0]), 'loginDemo guard');
    assert.ok(/chDemoBtn[\s\S]{0,200}display = 'none'/.test(idx), 'index hides demo button');
    const ed = fs.readFileSync(path.join(__dirname, 'energy-department.html'), 'utf8');
    assert.ok(/id="chDemoBtn"/.test(ed) && /isSyncHost\(\)\) return;/.test(ed));
    assert.ok(/isSyncHost\(\)\) document\.getElementById\('chDemoBtn'\)\.style\.display = 'none'/.test(ed));
  });
  await t("ch_user clearing lives only in CH_AUTH.clearSavedUser; 3 callers use it", () => {
    const rd = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const f of ['app/core.js', 'app/sync-ui.js', 'index.html']) {
      assert.ok(rd(f).includes('CH_AUTH.clearSavedUser'), f);
      assert.ok(!/removeItem\('ch_user'\)/.test(rd(f)), f + ' still clears ch_user itself');
    }
    assert.ok(/removeItem\('ch_user'\)/.test(rd('app/ch-auth.js')));
  });
  console.log(pass + ' passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
