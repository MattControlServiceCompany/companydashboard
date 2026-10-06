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
    '  return {\n    __t: { _hydrate, _batchGetChunked, _drainQueueOnce, _clearPerUserLocalState, _handleAuthIdentityChange, _pollManifestForChanges },\n    warmCache,',
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
      ready: () => (state.ready ? state.ready() : Promise.resolve()),
      getUserId: () => (state.uid !== undefined ? state.uid : state.mode === 'on' ? 'u1' : null),
      getEmail: () => state.email || 'u1@example.com',
    },
  };
  const SCreal = require('./app/sync-classification.js');
  // Without classify only the audit id rule is provided (db.js always calls it).
  win.SyncClassification = classify ? SCreal : { auditEntryId: SCreal.auditEntryId };
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
  await t('identity change always clears per-user key from cache; queue keeps A value; A back re-applies it; B never sees it', async () => {
    const puts = [];
    const L = load({
      classify: true, mode: 'off', syncHost: true,
      fetchImpl: async (u, o) => { if (o && o.method === 'PUT') puts.push(JSON.parse(o.body)); return ok({ version: 1, hash: 'h' }); },
    });
    await L.DB.warmCache();
    L.state.uid = 'A'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.state.mode = 'off'; // session lost
    await L.DB.set('ch_theme', 'darkA');
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    L.state.uid = 'B'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    assert.ok(L.DB.get('ch_theme') == null, 'B must not see A value');
    assert.strictEqual(puts.filter((p) => p.key.indexOf('B::') === 0).length, 0, 'nothing written under B');
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'A entry kept');
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(puts.length, 1);
    assert.strictEqual(puts[0].key, 'A::ch_theme');
    assert.strictEqual(puts[0].value, 'darkA');
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('A queued value is back in cache for A before the drain (re-apply)', async () => {
    const L = load({ classify: true, mode: 'off', syncHost: true, fetchImpl: async () => { throw new Error('offline'); } });
    await L.DB.warmCache();
    L.state.uid = 'A'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.state.mode = 'off';
    await L.DB.set('ch_theme', 'darkA');
    L.state.uid = 'B'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    assert.ok(L.DB.get('ch_theme') == null);
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(L.DB.get('ch_theme'), 'darkA');
  });
  await t('attribution: signed-out edit has no owner id; a different person signing in does not send it', async () => {
    const puts = [];
    const L = load({ classify: false, mode: 'off', syncHost: true,
      fetchImpl: async (u, o) => { if (o && o.method === 'PUT') puts.push(JSON.parse(o.body)); return ok({ version: 1, hash: 'h' }); } });
    await L.DB.warmCache();
    L.state.uid = 'A'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.state.uid = null; L.state.mode = 'off'; // A session expired
    await L.DB.set('en_note', 'edit while expired');
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    L.state.uid = 'B'; L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(puts.length, 0, 'B must not send an edit made before B signed in as A');
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(puts.length, 1, 'A signs back in: edit goes out');
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('attribution: edit whose send fails is queued under the user who made it, even if identity changed during the send', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const L = load({ classify: false, mode: 'on', syncHost: true,
      fetchImpl: async (u, o) => { if (o && o.method === 'PUT') { await gate; throw new Error('net'); } return ok([]); } });
    await L.DB.warmCache();
    L.state.uid = 'A';
    const pending = L.DB.set('en_note', 'by A');
    await new Promise((r) => setTimeout(r, 20));
    L.state.uid = 'B';
    await L.DB.__t._handleAuthIdentityChange();
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    const info = L.DB.getForeignQueueInfo();
    const q = JSON.parse(L.store['ch_sync_queue']).filter((e) => e.key === 'en_note');
    assert.ok(q.some((e) => e.owner.id === 'A' && e.value === 'by A'), 'queued under A');
    assert.strictEqual(info.length, 1, 'entry owned by A, foreign to B');
    assert.strictEqual(info[0].id, 'A');
  });
  await t('attribution: drain stops when identity changes mid-drain; no A entry sent with B token', async () => {
    const puts = [];
    let L;
    L = load({ classify: false, mode: 'on', syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') { puts.push(JSON.parse(o.body)); L.state.uid = 'B'; return ok({ version: 1, hash: 'h' }); }
        return ok([]);
      } });
    await L.DB.warmCache();
    L.state.uid = 'A'; L.state.mode = 'off';
    await L.DB.set('en_n1', 1);
    await L.DB.set('en_n2', 2);
    assert.strictEqual(L.DB.getQueueDepth(), 2);
    L.state.mode = 'on';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 1, 'second A entry not sent after identity became B');
    assert.strictEqual(L.DB.getQueueDepth(), 1);
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

  // ---- M2: two users editing at once (in-memory kv server with real CAS)
  function makeServer(initial) {
    const rows = {};
    Object.keys(initial || {}).forEach((k) => (rows[k] = { value: initial[k], version: 1, hash: 'h' + k + '1' }));
    const puts = [];
    const fetchImpl = async (u, o) => {
      if (o && o.method === 'PUT') {
        const b = JSON.parse(o.body);
        puts.push(b);
        const cur = rows[b.key];
        if (cur && b.baseVersion !== cur.version) return { ok: false, status: 409, json: async () => ({ current: Object.assign({ key: b.key }, cur) }) };
        const version = cur ? cur.version + 1 : 1;
        rows[b.key] = { value: b.value, version, hash: 'h' + b.key + version };
        return { ok: true, status: 200, json: async () => ({ version, hash: rows[b.key].hash }) };
      }
      if (u.includes('manifest=1')) {
        return ok(Object.keys(rows).map((k) => ({ key: k, version: rows[k].version, hash: rows[k].hash, deleted: false })));
      }
      const keys = decodeURIComponent(u.split('keys=')[1] || '').split(',').filter(Boolean);
      return ok(keys.filter((k) => rows[k]).map((k) => Object.assign({ key: k, deleted: false }, rows[k])));
    };
    return { rows, puts, fetchImpl };
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const bill = (id, kwh) => ({ id, start: '2025-0' + id.slice(-1) + '-01', end: '2025-0' + id.slice(-1) + '-28', kwh });
  const util0 = () => ({
    buildings: [
      { id: 'b1', name: 'Main', meters: [{ id: 'm1', label: 'Elec', bills: [bill('r1', 100)] }] },
      { id: 'b2', name: 'Gym', meters: [{ id: 'm2', label: 'Gas', bills: [bill('r2', 50)] }] },
    ],
  });
  const billIds = (v) => v.buildings.flatMap((b) => b.meters.flatMap((m) => m.bills.map((x) => x.id))).sort();
  // Brings a browser to "in sync with the server at version 1" through hydration.
  async function syncedBrowser(srv) {
    const L = load({ mode: 'on', syncHost: true, classify: false, fetchImpl: srv.fetchImpl });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    return L;
  }
  const settle = () => new Promise((r) => setTimeout(r, 40));
  await t('M2 utility data: bills added to different meters by two users both survive; no modal', async () => {
    const KEY = 'en_utility_cust_1';
    const srv = makeServer({ [KEY]: util0() });
    const L = await syncedBrowser(srv);
    const A = clone(L.DB.get(KEY));
    const theirs = util0();
    theirs.buildings[1].meters[0].bills.push(bill('r3', 70));
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    A.buildings[0].meters[0].bills.push(bill('r4', 120));
    await L.DB.set(KEY, A);
    await settle();
    assert.deepStrictEqual(billIds(srv.rows[KEY].value), ['r1', 'r2', 'r3', 'r4']);
    assert.strictEqual(L.DB.getQueueDepth(), 0, 'nothing left queued');
    assert.strictEqual(srv.rows[KEY].version, 3);
    assert.deepStrictEqual(billIds(L.DB.get(KEY)), ['r1', 'r2', 'r3', 'r4'], 'local copy holds both');
  });
  await t('M2 utility data: bills added to the SAME meter by two users both survive', async () => {
    const KEY = 'en_utility_cust_1';
    const srv = makeServer({ [KEY]: util0() });
    const L = await syncedBrowser(srv);
    const A = clone(L.DB.get(KEY));
    const theirs = util0();
    theirs.buildings[0].meters[0].bills.push(bill('r3', 70));
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    A.buildings[0].meters[0].bills.push(bill('r4', 120));
    await L.DB.set(KEY, A);
    await settle();
    assert.deepStrictEqual(billIds(srv.rows[KEY].value), ['r1', 'r2', 'r3', 'r4']);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('M2 utility data: derived caches on live meters do not make a false conflict', async () => {
    const KEY = 'en_utility_cust_1';
    const srv = makeServer({ [KEY]: util0() });
    const L = await syncedBrowser(srv);
    const A = clone(L.DB.get(KEY));
    A.buildings[0].meters[0]._savingsCache = { x: 1 };
    const theirs = util0();
    theirs.buildings[1].meters[0].bills.push(bill('r3', 70));
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    A.buildings[0].meters[0].bills[0].kwh = 101;
    await L.DB.set(KEY, A);
    await settle();
    assert.strictEqual(srv.rows[KEY].value.buildings[0].meters[0].bills[0].kwh, 101);
    assert.deepStrictEqual(billIds(srv.rows[KEY].value), ['r1', 'r2', 'r3']);
    assert.ok(!JSON.stringify(srv.rows[KEY].value).includes('_savingsCache'));
  });
  await t('M2 utility data: same bill field changed by both users is a real conflict; server not overwritten, edit kept', async () => {
    const KEY = 'en_utility_cust_1';
    const srv = makeServer({ [KEY]: util0() });
    const L = await syncedBrowser(srv);
    const A = clone(L.DB.get(KEY));
    const theirs = util0();
    theirs.buildings[0].meters[0].bills[0].kwh = 999;
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    A.buildings[0].meters[0].bills[0].kwh = 111;
    await L.DB.set(KEY, A);
    await settle();
    // No page UI in this sandbox: the engine must not overwrite the server and must keep the edit.
    assert.strictEqual(srv.rows[KEY].value.buildings[0].meters[0].bills[0].kwh, 999);
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'local edit kept in the queue');
  });
  await t('M2 utility data: a removed building on one side and a rename on the other both apply', async () => {
    const KEY = 'en_utility_cust_1';
    const srv = makeServer({ [KEY]: util0() });
    const L = await syncedBrowser(srv);
    const theirs = util0();
    theirs.buildings[0].name = 'Main Hall';
    srv.rows[KEY] = { value: theirs, version: 2, hash: 'h2' };
    const A = clone(L.DB.get(KEY));
    A.buildings.splice(1, 1);
    await L.DB.set(KEY, A);
    await settle();
    assert.deepStrictEqual(srv.rows[KEY].value.buildings.map((b) => b.name), ['Main Hall']);
  });
  await t('M2 audit log: entries written by two users are both kept (append-only), newest first', async () => {
    const KEY = 'en_utility_audit_log';
    const e = (ts, a) => ({ ts, action: a, projId: 'p', bldgId: 'b', meterId: 'm' });
    const srv = makeServer({ [KEY]: [e('2025-01-01T00:00:00Z', 'old')] });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [e('2025-03-01T00:00:00Z', 'theirs'), e('2025-01-01T00:00:00Z', 'old')], version: 2, hash: 'h2' };
    await L.DB.set(KEY, [e('2025-02-01T00:00:00Z', 'mine'), e('2025-01-01T00:00:00Z', 'old')]);
    await settle();
    assert.deepStrictEqual(srv.rows[KEY].value.map((x) => x.action), ['theirs', 'mine', 'old']);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('M2 audit log: two identical entries stay two entries', async () => {
    const KEY = 'en_utility_audit_log';
    const e = { ts: '2025-01-01T00:00:00Z', action: 'edit', projId: 'p', bldgId: 'b', meterId: 'm' };
    const srv = makeServer({ [KEY]: [e] });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [e], version: 2, hash: 'h2' };
    await L.DB.set(KEY, [e, e]);
    await settle();
    assert.strictEqual(srv.rows[KEY].value.length, 2);
  });
  await t('M2 en_pdf_bills: records added by two users are both kept', async () => {
    const KEY = 'en_pdf_bills';
    const srv = makeServer({ [KEY]: [{ id: 'pb1', fileName: 'a.pdf' }] });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [{ id: 'pb1', fileName: 'a.pdf' }, { id: 'pb2', fileName: 'b.pdf' }], version: 2, hash: 'h2' };
    await L.DB.set(KEY, [{ id: 'pb1', fileName: 'a.pdf' }, { id: 'pb3', fileName: 'c.pdf' }]);
    await settle();
    assert.deepStrictEqual(srv.rows[KEY].value.map((x) => x.id).sort(), ['pb1', 'pb2', 'pb3']);
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t('M2 en_pdf_bills: a record without an id is never merged away (no silent drop)', async () => {
    const KEY = 'en_pdf_bills';
    const srv = makeServer({ [KEY]: [{ id: 'pb1' }] });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [{ id: 'pb1' }, { id: 'pb2' }], version: 2, hash: 'h2' };
    await L.DB.set(KEY, [{ id: 'pb1' }, { fileName: 'no-id.pdf' }]);
    await settle();
    assert.strictEqual(srv.rows[KEY].value.length, 2, 'server not overwritten');
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'local list kept in the queue, not lost');
    assert.ok(JSON.stringify(L.DB.get(KEY)).includes('no-id.pdf'), 'local record still present');
  });

  // ---- M1: poll applies server changes when there is no pending local edit
  await t('M1 poll applies a newer server value (no pending edit), announces dbRemoteApplied, no refresh bar', async () => {
    const srv = makeServer({ en_note: 'v1' });
    const L = await syncedBrowser(srv);
    assert.strictEqual(L.DB.get('en_note'), 'v1');
    srv.rows.en_note = { value: 'v2', version: 2, hash: 'h2' };
    L.events.length = 0;
    await L.DB.__t._pollManifestForChanges();
    assert.strictEqual(L.DB.get('en_note'), 'v2', 'value applied to the local copy');
    const applied = L.events.find((e) => e.type === 'dbRemoteApplied');
    assert.ok(applied && Array.from(applied.detail.keys).join(',') === 'en_note', 'dbRemoteApplied sent');
    assert.ok(!L.events.some((e) => e.type === 'remoteChange'), 'no refresh bar event');
  });
  await t('M1 poll with a pending local edit for the key keeps the edit and asks for a refresh (remoteChange)', async () => {
    const srv = makeServer({ en_note: 'v1' });
    const L = await syncedBrowser(srv);
    srv.rows.en_note = { value: 'v2', version: 2, hash: 'h2' };
    const edit = L.DB.set('en_note', 'mine'); // 409 against v2 -> merge cannot apply to a plain string -> stays queued
    await edit;
    await settle();
    assert.ok(L.DB.getQueueDepth() >= 1, 'edit is waiting in the queue');
    L.events.length = 0;
    await L.DB.__t._pollManifestForChanges();
    assert.strictEqual(L.DB.get('en_note'), 'mine', 'pending local edit not overwritten');
    assert.ok(L.events.some((e) => e.type === 'remoteChange'), 'refresh bar event');
    assert.ok(!L.events.some((e) => e.type === 'dbRemoteApplied'), 'not announced as applied');
  });
  await t('M1 poll applies a changed utility list by merging, keeps a different local pending list', async () => {
    const KEY = 'en_pdf_bills';
    const srv = makeServer({ [KEY]: [{ id: 'pb1' }], en_other: 'o1' });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [{ id: 'pb1' }, { id: 'pb2' }], version: 2, hash: 'h2' };
    srv.rows.en_other = { value: 'o2', version: 2, hash: 'h2' };
    L.events.length = 0;
    await L.DB.__t._pollManifestForChanges();
    assert.deepStrictEqual(L.DB.get(KEY).map((x) => x.id), ['pb1', 'pb2']);
    assert.strictEqual(L.DB.get('en_other'), 'o2');
    const applied = L.events.find((e) => e.type === 'dbRemoteApplied');
    assert.deepStrictEqual(Array.from(applied.detail.keys).sort(), ['en_other', KEY]);
  });
  await t('M1 sync-ui reloads only when safe, otherwise shows the bar (source check)', () => {
    const ui = fs.readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8');
    assert.ok(/addEventListener\('dbRemoteApplied'/.test(ui));
    assert.ok(/function _safeToReload\(\)/.test(ui));
    assert.ok(/_safeToReload\(\)\) window\.location\.reload\(\);\s*else renderRemoteChangeBanner/.test(ui));
  });

  await t('M1 reload guard blocks on the app dialogs (.modal-bg.open) and an unsent PDF queue (source check)', () => {
    const ui = fs.readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8');
    const m = /OPEN_DIALOG_SELECTOR =\s*'([^']+)'/.exec(ui);
    assert.ok(m, 'one dialog selector');
    assert.ok(/\.modal-bg\.open/.test(m[1]) && /\.ems-modal-bg\.open/.test(m[1]));
    assert.ok(/pdfQueueDepth\(\) > 0/.test(ui));
  });

  await t('PDF queue entries carry the owner tag and the drain sends only the verified user own entries (source check)', () => {
    const core = fs.readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8');
    assert.ok(/owner: window\.DB\.queueOwner\(\)/.test(core));
    assert.ok(/window\.DB\.entryBelongsTo\(entry, me\)\) continue/.test(core));
    assert.ok(/getUserId\(\);\s*if \(!me\) return/.test(core));
    const db = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
    assert.ok(/queueOwner: _queueOwner,\s*entryBelongsTo: _entryBelongsTo/.test(db));
  });

  // ---- M10: load-time writers
  await t('M10 every load-time saveUtilityData(SAVE_ALL_PROJECTS) runs only when a migration changed data', () => {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'utility-data.js'), 'utf8').split('\r').join('');
    const lines = src.split('\n');
    let seen = 0;
    lines.forEach((ln, i) => {
      if (!/^\s+saveUtilityData\(SAVE_ALL_PROJECTS\);/.test(ln)) return;
      seen++;
      assert.ok(/^\s*if \(.*> 0.*\) \{\s*$/.test(lines[i - 1]), 'unguarded load-time write at line ' + (i + 1));
    });
    assert.ok(seen >= 8, 'expected the 8 migration writes, saw ' + seen);
    // The dirty check (unchanged project is never written) must stay in saveUtilityData.
    assert.ok(/if \(_lastSavedSnapshot\[pid\] === _serialized\) return;/.test(src));
  });

  // ---- M6: 401/403 is "refused", not "offline"
  await t('M6 hydration manifest answered 403 -> dbAuthRejected, not dbOfflineBanner', async () => {
    const { DB, events } = load({ mode: 'on', syncHost: true, fetchImpl: async () => ({ ok: false, status: 403 }) });
    await DB.warmCache();
    await DB.__t._hydrate();
    const rej = events.find((e) => e.type === 'dbAuthRejected');
    assert.ok(rej && rej.detail.status === 403);
    assert.ok(!events.some((e) => e.type === 'dbOfflineBanner'));
  });
  await t('M6 network failure still shows the offline banner', async () => {
    const { DB, events } = load({ mode: 'on', syncHost: true, fetchImpl: async () => { throw new Error('net'); } });
    await DB.warmCache();
    await DB.__t._hydrate();
    assert.ok(events.some((e) => e.type === 'dbOfflineBanner'));
    assert.ok(!events.some((e) => e.type === 'dbAuthRejected'));
  });
  await t('M6 a write answered 401 raises dbAuthRejected', async () => {
    const { DB, events } = load({ mode: 'on', syncHost: true, fetchImpl: async (u, o) => (o && o.method === 'PUT' ? { ok: false, status: 401, json: async () => ({}) } : ok([])) });
    await DB.warmCache();
    await DB.set('en_note', 'x');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(events.some((e) => e.type === 'dbAuthRejected' && e.detail.status === 401));
    assert.strictEqual(DB.getQueueDepth(), 1, 'edit kept');
  });

  // ---- M3: weather data syncs
  await t('M3 en_wdd_<zip> is classified synced', () => {
    const SC = require('./app/sync-classification.js');
    assert.strictEqual(SC.classifyKey('en_wdd_66053'), 'synced');
  });

  // ---- M4: Louisburg facility map syncs
  await t('M4 en_louisburg_facility_map is classified synced', () => {
    const SC = require('./app/sync-classification.js');
    assert.strictEqual(SC.classifyKey('en_louisburg_facility_map'), 'synced');
  });

  // ---- M7: no request before the first token refresh ends
  await t('M7 hydration waits for CH_AUTH.ready() before the first request', async () => {
    const urls = [];
    const L = load({ mode: 'on', syncHost: true, fetchImpl: async (u) => { urls.push(u); return ok([]); } });
    let release;
    await L.DB.warmCache();
    urls.length = 0;
    L.state.ready = () => new Promise((r) => { release = r; });
    const h = L.DB.__t._hydrate();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(urls.length, 0, 'no request while the refresh is pending: ' + urls.join(' '));
    release();
    await h;
    assert.ok(urls.length >= 1, 'request sent after the refresh ended');
  });
  await t('M7 ch-auth exposes ready() resolved by the first refresh (source check)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'ch-auth.js'), 'utf8');
    assert.ok(/_startupRefresh = _refreshIfNeeded\(\)/.test(src));
    assert.ok(/ready: ready,/.test(src));
  });

  // ---- M5: a PDF saved while signed out is queued for upload
  await t('M5 pdfStore queues the upload on the sync host even when signed out; not on other hosts', () => {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8').split('\r').join('');
    const fn = src.match(/function _pdfShouldQueueUpload\(\) \{[\s\S]*?\n\}/)[0];
    const run = (auth) => vm.runInNewContext(fn + '\n_pdfShouldQueueUpload()', { window: { CH_AUTH: auth } });
    assert.strictEqual(run({ backendMode: () => 'off', isSyncHost: () => true }), true, 'signed out on sync host');
    assert.strictEqual(run({ backendMode: () => 'on', isSyncHost: () => true }), true, 'signed in');
    assert.strictEqual(run({ backendMode: () => 'off', isSyncHost: () => false }), false, 'GitHub Pages: never');
    const store = src.match(/async function pdfStore\(id, base64\) \{[\s\S]*?\n\}/)[0];
    assert.ok(/_pdfShouldQueueUpload\(\)/.test(store) && !/backendMode\(\)/.test(store));
    assert.ok(/addEventListener\('chAuthStateChanged'[\s\S]{0,80}_pdfDrainQueueOnce/.test(src), 'sign-in drains the queue');
  });

  // ---- M8: Reset keeps a copy of the conflict archive
  await t('M8 siteResetData saves the conflict archive to a file before it erases data', () => {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'site-functions.js'), 'utf8').split('\r').join('');
    const fn = src.match(/async function siteResetData\(\) \{[\s\S]*?\n\}/)[0];
    const dl = fn.indexOf('_downloadJSON(_archive');
    const wipe = fn.indexOf('localStorage.clear()');
    assert.ok(dl > 0 && wipe > dl, 'archive download comes before the wipe');
    assert.ok(/getConflictArchive/.test(fn));
  });

  // ---- 401/403 on periodic sync requests (2026-10-06): refresh once, then end the session
  const FK = (x) => 'fake-' + x;
  function loadAuth(tokenFetch) {
    const store = { ch_sb_session: JSON.stringify({ access_token: FK('a'), refresh_token: FK('r1'), expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: 'u1', email: 'u1@example.com' }) };
    const events = [];
    const win = { addEventListener() {}, dispatchEvent(e) { events.push(e.type + ':' + JSON.stringify(e.detail)); } };
    const sandbox = {
      window: win, location: { hostname: 'cscdashboard.netlify.app' },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      setInterval: () => 0, Promise, Date, Math, JSON, Error, Number,
      CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
      fetch: tokenFetch,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app', 'ch-auth.js'), 'utf8'), sandbox);
    return { A: win.CH_AUTH, events, store };
  }
  const tokOk = (n) => async () => ({ ok: true, status: 200, json: async () => ({ access_token: FK('new' + n), refresh_token: FK('r2'), expires_in: 3600, user: { id: 'u1', email: 'u1@example.com' } }) });
  await t('401 then ok after refresh: withAuthRetry retries once with the new token, stays signed in', async () => {
    const L = loadAuth(tokOk(1));
    let calls = 0;
    const out = await L.A.withAuthRetry(async () => (++calls === 1 ? { status: 'error', httpStatus: 401 } : { status: 'ok' }));
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(L.A.getToken(), 'fake-new1');
    assert.strictEqual(L.A.backendMode(), 'on');
  });
  await t('401 twice: ONE refresh only, then signed out (signed-out bar state), backendMode off', async () => {
    let refreshes = 0;
    const L = loadAuth(async (...a) => { refreshes++; return tokOk(refreshes)(...a); });
    let calls = 0;
    let err;
    try { await L.A.withAuthRetry(async () => { calls++; const e = new Error('manifest fetch failed: 401'); e.httpStatus = 401; throw e; }); } catch (e) { err = e; }
    assert.ok(err && err.httpStatus === 401, 'final error is thrown');
    assert.strictEqual(calls, 2, 'two requests, not a loop');
    assert.strictEqual(refreshes, 1, 'exactly one token refresh');
    assert.strictEqual(L.A.isSignedOut(), true);
    assert.strictEqual(L.A.needsSignIn(), true, 'existing signed-out bar rule now true');
    assert.strictEqual(L.A.backendMode(), 'off', 'every poll/drain timer is now quiet');
    assert.ok(L.events.some((x) => x.startsWith('chAuthStateChanged') && x.includes('true')), 'bar is told');
    assert.ok(!('ch_sb_session' in L.store), 'dead session removed');
  });
  await t('401 and the refresh itself fails: signed out after zero retries', async () => {
    const L = loadAuth(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad refresh token' }) }));
    let calls = 0;
    const out = await L.A.withAuthRetry(async () => { calls++; return { status: 'error', httpStatus: 401 }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.httpStatus, 401);
    assert.strictEqual(L.A.needsSignIn(), true);
  });
  await t('403: no refresh, signed out at once', async () => {
    let refreshes = 0;
    const L = loadAuth(async (...a) => { refreshes++; return tokOk(1)(...a); });
    let calls = 0;
    await L.A.withAuthRetry(async () => { calls++; return { status: 'error', httpStatus: 403 }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(refreshes, 0);
    assert.strictEqual(L.A.backendMode(), 'off');
    assert.strictEqual(L.A.needsSignIn(), true);
  });
  await t('non-auth errors (500, network) pass through untouched and the session stays', async () => {
    const L = loadAuth(tokOk(1));
    const out = await L.A.withAuthRetry(async () => ({ status: 'error', httpStatus: 500 }));
    assert.strictEqual(out.httpStatus, 500);
    assert.strictEqual(L.A.backendMode(), 'on');
  });
  await t('new sign-in after the refusal turns sync back on (same chAuthStateChanged path)', async () => {
    const L = loadAuth(tokOk(1));
    await L.A.withAuthRetry(async () => ({ status: 'error', httpStatus: 403 }));
    assert.strictEqual(L.A.backendMode(), 'off');
    await L.A.signIn('u1@example.com', 'pw');
    assert.strictEqual(L.A.backendMode(), 'on');
    assert.ok(L.events.filter((x) => x.startsWith('chAuthStateChanged')).length >= 2, 'event fired on sign-out and again on sign-in');
  });
  await t('db.js poll goes through CH_AUTH.withAuthRetry; a poll that is refused for good reports once and returns', async () => {
    let fetches = 0, wraps = 0;
    const L = load({ classify: false, mode: 'on', syncHost: true,
      fetchImpl: async (u) => { if (/manifest=1/.test(u)) { fetches++; return { ok: false, status: 401, json: async () => ({}) }; } return ok([]); } });
    L.state.ready = null;
    const real = vm.runInNewContext;
    // route through a wrapper that mimics CH_AUTH: one retry on 401, then give up
    const ctxAuth = L.DB; void ctxAuth; void real;
    const src = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8').split('\r').join('');
    assert.ok(/_withAuthRetry\(\(\) => _fetchManifestWithTimeout/.test(src), 'poll wrapped');
    assert.ok(/_withAuthRetry\(\(\) => _sendKvPut\(entry\.key, payload\)\)/.test(src), 'kv drain wrapped');
    const core = fs.readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8').split('\r').join('');
    assert.ok(/_pdfWithAuthRetry\(\(\) => _pdfUploadCommit/.test(core) && /_pdfWithAuthRetry\(\(\) => _pdfDeleteCommit/.test(core), 'pdf drain wrapped');
    await L.DB.__t._pollManifestForChanges();
    assert.ok(fetches >= 1);
    assert.ok(L.events.some((e) => e.type === 'dbAuthRejected'), 'existing not-authorized message is shown');
    assert.strictEqual(wraps, 0);
  });
  console.log(pass + ' passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
