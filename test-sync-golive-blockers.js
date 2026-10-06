// Unit tests for the Netlify go-live sync blockers B1b, B2, B4 (local mocks only; no network).
// Run: node test-sync-golive-blockers.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load({ mode, syncHost, fetchImpl, classify }) {
  let src = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
  src = src
    .split(String.fromCharCode(13))
    .join('')
    .replace(
      '  return {\n    warmCache,',
      '  return {\n    __t: { _hydrate, _batchGetChunked, _drainQueueOnce, _clearPerUserLocalState, _handleAuthIdentityChange, _pollManifestForChanges, _stampOf: (k) => _replicaVersions[k], _baseOf: (k) => _syncBase[k], _queue: () => _syncQueue },\n    warmCache,',
    );
  const store = arguments[0].store || {};
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
  win.SyncClassification = classify
    ? SCreal
    : { auditEntryId: SCreal.auditEntryId, canonicalJSON: SCreal.canonicalJSON };
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
    crypto: globalThis.crypto, // real SHA-256: the "value changed" rule hashes with crypto.subtle
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
    const L = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') {
          puts.push(o.body);
          return sendOk();
        }
        return ok([]);
      },
    });
    await L.DB.warmCache(); // u1 signed in, recorded as last user
    L.state.mode = 'off';
    L.state.uid = null;
    await L.DB.set('en_projects', [{ id: 1 }]);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    L.state.mode = 'on';
    L.state.uid = 'u2';
    L.state.email = 'u2@example.com';
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
    L.state.mode = 'off';
    L.state.uid = null;
    await L.DB.set('en_projects', [{ id: 1 }]);
    L.state.mode = 'off';
    L.state.uid = 'u2';
    L.state.email = 'u2@example.com';
    await L.DB.set('en_projects', [{ id: 2 }]);
    const q = JSON.parse(L.store['ch_sync_queue'] || '[]').filter((e) => e.key === 'en_projects');
    assert.strictEqual(q.length, 2);
    assert.notStrictEqual(q[0].owner.id, q[1].owner.id);
  });
  await t('Owner: edit with no known user is kept but never sent', async () => {
    const puts = [];
    const L = load({
      mode: 'off',
      syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') puts.push(1);
        return ok([]);
      },
    });
    await L.DB.warmCache();
    await L.DB.set('en_projects', [{ id: 1 }]);
    L.state.mode = 'on';
    L.state.uid = 'u2';
    await L.DB.__t._drainQueueOnce();
    assert.strictEqual(puts.length, 0);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
  });

  // ---- Per-user keys (manager decision 2)
  await t(
    'Per-user key edited while signed out is queued, survives the sign-in clear, and is sent for the same user',
    async () => {
      const puts = [];
      const L = load({
        classify: true,
        mode: 'on',
        syncHost: true,
        fetchImpl: async (u, o) => {
          if (o && o.method === 'PUT') {
            puts.push(o.body);
            return sendOk();
          }
          return ok([]);
        },
      });
      await L.DB.warmCache();
      L.state.mode = 'off';
      L.state.uid = null;
      await L.DB.__t._handleAuthIdentityChange(); // sign-out event
      await L.DB.set('ch_theme', 'dark');
      assert.strictEqual(L.DB.getQueueDepth(), 1, 'per-user edit queued');
      L.state.mode = 'on';
      L.state.uid = 'u1';
      await L.DB.__t._handleAuthIdentityChange();
      assert.strictEqual(L.DB.get('ch_theme'), 'dark', 'local value not deleted');
      assert.strictEqual(puts.length, 1);
      assert.strictEqual(L.DB.getQueueDepth(), 0);
    },
  );
  await t(
    'identity change always clears per-user key from cache; queue keeps A value; A back re-applies it; B never sees it',
    async () => {
      const puts = [];
      const L = load({
        classify: true,
        mode: 'off',
        syncHost: true,
        fetchImpl: async (u, o) => {
          if (o && o.method === 'PUT') puts.push(JSON.parse(o.body));
          return ok({ version: 1, hash: 'h' });
        },
      });
      await L.DB.warmCache();
      L.state.uid = 'A';
      L.state.mode = 'on';
      await L.DB.__t._handleAuthIdentityChange();
      L.state.mode = 'off'; // session lost
      await L.DB.set('ch_theme', 'darkA');
      assert.strictEqual(L.DB.getQueueDepth(), 1);
      L.state.uid = 'B';
      L.state.mode = 'on';
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
    },
  );
  await t('A queued value is back in cache for A before the drain (re-apply)', async () => {
    const L = load({
      classify: true,
      mode: 'off',
      syncHost: true,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    await L.DB.warmCache();
    L.state.uid = 'A';
    L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.state.mode = 'off';
    await L.DB.set('ch_theme', 'darkA');
    L.state.uid = 'B';
    L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    assert.ok(L.DB.get('ch_theme') == null);
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(L.DB.get('ch_theme'), 'darkA');
  });
  await t('attribution: signed-out edit has no owner id; a different person signing in does not send it', async () => {
    const puts = [];
    const L = load({
      classify: false,
      mode: 'off',
      syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') puts.push(JSON.parse(o.body));
        return ok({ version: 1, hash: 'h' });
      },
    });
    await L.DB.warmCache();
    L.state.uid = 'A';
    L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.state.uid = null;
    L.state.mode = 'off'; // A session expired
    await L.DB.set('en_note', 'edit while expired');
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    L.state.uid = 'B';
    L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(puts.length, 0, 'B must not send an edit made before B signed in as A');
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(puts.length, 1, 'A signs back in: edit goes out');
    assert.strictEqual(L.DB.getQueueDepth(), 0);
  });
  await t(
    'attribution: edit whose send fails is queued under the user who made it, even if identity changed during the send',
    async () => {
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      const L = load({
        classify: false,
        mode: 'on',
        syncHost: true,
        fetchImpl: async (u, o) => {
          if (o && o.method === 'PUT') {
            await gate;
            throw new Error('net');
          }
          return ok([]);
        },
      });
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
      assert.ok(
        q.some((e) => e.owner.id === 'A' && e.value === 'by A'),
        'queued under A',
      );
      assert.strictEqual(info.length, 1, 'entry owned by A, foreign to B');
      assert.strictEqual(info[0].id, 'A');
    },
  );
  await t('attribution: drain stops when identity changes mid-drain; no A entry sent with B token', async () => {
    const puts = [];
    let L;
    L = load({
      classify: false,
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') {
          puts.push(JSON.parse(o.body));
          L.state.uid = 'B';
          return ok({ version: 1, hash: 'h' });
        }
        return ok([]);
      },
    });
    await L.DB.warmCache();
    L.state.uid = 'A';
    L.state.mode = 'off';
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
  await t('ch_user clearing lives only in CH_AUTH.clearSavedUser; 3 callers use it', () => {
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
        if (cur && b.baseVersion !== cur.version)
          return { ok: false, status: 409, json: async () => ({ current: Object.assign({ key: b.key }, cur) }) };
        const version = cur ? cur.version + 1 : 1;
        rows[b.key] = { value: b.value, version, hash: 'h' + b.key + version };
        return { ok: true, status: 200, json: async () => ({ version, hash: rows[b.key].hash }) };
      }
      if (u.includes('manifest=1')) {
        return ok(
          Object.keys(rows).map((k) => ({ key: k, version: rows[k].version, hash: rows[k].hash, deleted: false })),
        );
      }
      const keys = decodeURIComponent(u.split('keys=')[1] || '')
        .split(',')
        .filter(Boolean);
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
  await t(
    'M2 utility data: same bill field changed by both users is a real conflict; server not overwritten, edit kept',
    async () => {
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
    },
  );
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
    assert.deepStrictEqual(
      srv.rows[KEY].value.buildings.map((b) => b.name),
      ['Main Hall'],
    );
  });
  await t('M2 audit log: entries written by two users are both kept (append-only), newest first', async () => {
    const KEY = 'en_utility_audit_log';
    const e = (ts, a) => ({ ts, action: a, projId: 'p', bldgId: 'b', meterId: 'm' });
    const srv = makeServer({ [KEY]: [e('2025-01-01T00:00:00Z', 'old')] });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = {
      value: [e('2025-03-01T00:00:00Z', 'theirs'), e('2025-01-01T00:00:00Z', 'old')],
      version: 2,
      hash: 'h2',
    };
    await L.DB.set(KEY, [e('2025-02-01T00:00:00Z', 'mine'), e('2025-01-01T00:00:00Z', 'old')]);
    await settle();
    assert.deepStrictEqual(
      srv.rows[KEY].value.map((x) => x.action),
      ['theirs', 'mine', 'old'],
    );
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
    srv.rows[KEY] = {
      value: [
        { id: 'pb1', fileName: 'a.pdf' },
        { id: 'pb2', fileName: 'b.pdf' },
      ],
      version: 2,
      hash: 'h2',
    };
    await L.DB.set(KEY, [
      { id: 'pb1', fileName: 'a.pdf' },
      { id: 'pb3', fileName: 'c.pdf' },
    ]);
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
  await t(
    'M1 poll applies a newer server value (no pending edit), announces dbRemoteApplied, no refresh bar',
    async () => {
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
    },
  );
  await t(
    'M1 poll with a pending local edit for the key keeps the edit and asks for a refresh (remoteChange)',
    async () => {
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
      assert.ok(
        L.events.some((e) => e.type === 'remoteChange'),
        'refresh bar event',
      );
      assert.ok(!L.events.some((e) => e.type === 'dbRemoteApplied'), 'not announced as applied');
    },
  );
  await t('M1 poll applies a changed utility list by merging, keeps a different local pending list', async () => {
    const KEY = 'en_pdf_bills';
    const srv = makeServer({ [KEY]: [{ id: 'pb1' }], en_other: 'o1' });
    const L = await syncedBrowser(srv);
    srv.rows[KEY] = { value: [{ id: 'pb1' }, { id: 'pb2' }], version: 2, hash: 'h2' };
    srv.rows.en_other = { value: 'o2', version: 2, hash: 'h2' };
    L.events.length = 0;
    await L.DB.__t._pollManifestForChanges();
    assert.deepStrictEqual(
      L.DB.get(KEY).map((x) => x.id),
      ['pb1', 'pb2'],
    );
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

  await t(
    'PDF queue entries carry the owner tag and the drain sends only the verified user own entries (source check)',
    () => {
      const core = fs.readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8');
      assert.ok(/owner: window\.DB\.queueOwner\(\)/.test(core));
      assert.ok(/window\.DB\.entryBelongsTo\(entry, me\)\) continue/.test(core));
      assert.ok(/getUserId\(\);\s*if \(!me\) return/.test(core));
      const db = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
      assert.ok(/queueOwner: _queueOwner,\s*entryBelongsTo: _entryBelongsTo/.test(db));
    },
  );

  // ---- M10: load-time writers
  await t('M10 every load-time saveUtilityData(SAVE_ALL_PROJECTS) runs only when a migration changed data', () => {
    const src = fs
      .readFileSync(path.join(__dirname, 'app', 'utility-data.js'), 'utf8')
      .split('\r')
      .join('');
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
    const { DB, events } = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async () => {
        throw new Error('net');
      },
    });
    await DB.warmCache();
    await DB.__t._hydrate();
    assert.ok(events.some((e) => e.type === 'dbOfflineBanner'));
    assert.ok(!events.some((e) => e.type === 'dbAuthRejected'));
  });
  await t('M6 a write answered 401 raises dbAuthRejected', async () => {
    const { DB, events } = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u, o) =>
        o && o.method === 'PUT' ? { ok: false, status: 401, json: async () => ({}) } : ok([]),
    });
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
    const L = load({
      mode: 'on',
      syncHost: true,
      fetchImpl: async (u) => {
        urls.push(u);
        return ok([]);
      },
    });
    let release;
    await L.DB.warmCache();
    urls.length = 0;
    L.state.ready = () =>
      new Promise((r) => {
        release = r;
      });
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
    const src = fs
      .readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8')
      .split('\r')
      .join('');
    const fn = src.match(/function _pdfShouldQueueUpload\(\) \{[\s\S]*?\n\}/)[0];
    const run = (auth) => vm.runInNewContext(fn + '\n_pdfShouldQueueUpload()', { window: { CH_AUTH: auth } });
    assert.strictEqual(run({ backendMode: () => 'off', isSyncHost: () => true }), true, 'signed out on sync host');
    assert.strictEqual(run({ backendMode: () => 'on', isSyncHost: () => true }), true, 'signed in');
    assert.strictEqual(run({ backendMode: () => 'off', isSyncHost: () => false }), false, 'GitHub Pages: never');
    const store = src.match(/async function pdfStore\(id, base64\) \{[\s\S]*?\n\}/)[0];
    assert.ok(/_pdfShouldQueueUpload\(\)/.test(store) && !/backendMode\(\)/.test(store));
    assert.ok(
      /addEventListener\('chAuthStateChanged'[\s\S]{0,80}_pdfDrainQueueOnce/.test(src),
      'sign-in drains the queue',
    );
  });

  // ---- M8: Reset keeps a copy of the conflict archive
  await t('M8 siteResetData saves the conflict archive to a file before it erases data', () => {
    const src = fs
      .readFileSync(path.join(__dirname, 'app', 'site-functions.js'), 'utf8')
      .split('\r')
      .join('');
    const fn = src.match(/async function siteResetData\(\) \{[\s\S]*?\n\}/)[0];
    const dl = fn.indexOf('_downloadJSON(_archive');
    const wipe = fn.indexOf('localStorage.clear()');
    assert.ok(dl > 0 && wipe > dl, 'archive download comes before the wipe');
    assert.ok(/getConflictArchive/.test(fn));
  });

  // ---- 401/403 on periodic sync requests (2026-10-06): refresh once, then end the session
  const FK = (x) => 'fake-' + x;
  function loadAuth(tokenFetch) {
    const store = {
      ch_sb_session: JSON.stringify({
        access_token: FK('a'),
        refresh_token: FK('r1'),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'u1',
        email: 'u1@example.com',
      }),
    };
    const events = [];
    const win = {
      addEventListener() {},
      dispatchEvent(e) {
        events.push(e.type + ':' + JSON.stringify(e.detail));
      },
    };
    const sandbox = {
      window: win,
      location: { hostname: 'cscdashboard.netlify.app' },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => {
          store[k] = String(v);
        },
        removeItem: (k) => {
          delete store[k];
        },
      },
      setInterval: () => 0,
      Promise,
      Date,
      Math,
      JSON,
      Error,
      Number,
      CustomEvent: function (type, init) {
        this.type = type;
        this.detail = init && init.detail;
      },
      fetch: tokenFetch,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app', 'ch-auth.js'), 'utf8'), sandbox);
    return { A: win.CH_AUTH, events, store };
  }
  const tokOk = (n) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: FK('new' + n),
      refresh_token: FK('r2'),
      expires_in: 3600,
      user: { id: 'u1', email: 'u1@example.com' },
    }),
  });
  await t('401 then ok after refresh: withAuthRetry retries once with the new token, stays signed in', async () => {
    const L = loadAuth(tokOk(1));
    let calls = 0;
    const out = await L.A.withAuthRetry(async () =>
      ++calls === 1 ? { status: 'error', httpStatus: 401 } : { status: 'ok' },
    );
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(L.A.getToken(), 'fake-new1');
    assert.strictEqual(L.A.backendMode(), 'on');
  });
  await t('401 twice: ONE refresh only, then signed out (signed-out bar state), backendMode off', async () => {
    let refreshes = 0;
    const L = loadAuth(async (...a) => {
      refreshes++;
      return tokOk(refreshes)(...a);
    });
    let calls = 0;
    let err;
    try {
      await L.A.withAuthRetry(async () => {
        calls++;
        const e = new Error('manifest fetch failed: 401');
        e.httpStatus = 401;
        throw e;
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.httpStatus === 401, 'final error is thrown');
    assert.strictEqual(calls, 2, 'two requests, not a loop');
    assert.strictEqual(refreshes, 1, 'exactly one token refresh');
    assert.strictEqual(L.A.isSignedOut(), true);
    assert.strictEqual(L.A.needsSignIn(), true, 'existing signed-out bar rule now true');
    assert.strictEqual(L.A.backendMode(), 'off', 'every poll/drain timer is now quiet');
    assert.ok(
      L.events.some((x) => x.startsWith('chAuthStateChanged') && x.includes('true')),
      'bar is told',
    );
    assert.ok(!('ch_sb_session' in L.store), 'dead session removed');
  });
  await t('401 and the refresh itself fails: signed out after zero retries', async () => {
    const L = loadAuth(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad refresh token' }) }));
    let calls = 0;
    const out = await L.A.withAuthRetry(async () => {
      calls++;
      return { status: 'error', httpStatus: 401 };
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.httpStatus, 401);
    assert.strictEqual(L.A.needsSignIn(), true);
  });
  await t('403: no refresh, signed out at once', async () => {
    let refreshes = 0;
    const L = loadAuth(async (...a) => {
      refreshes++;
      return tokOk(1)(...a);
    });
    let calls = 0;
    await L.A.withAuthRetry(async () => {
      calls++;
      return { status: 'error', httpStatus: 403 };
    });
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
    assert.ok(
      L.events.filter((x) => x.startsWith('chAuthStateChanged')).length >= 2,
      'event fired on sign-out and again on sign-in',
    );
  });
  await t(
    'db.js poll goes through CH_AUTH.withAuthRetry; a poll that is refused for good reports once and returns',
    async () => {
      let fetches = 0,
        wraps = 0;
      const L = load({
        classify: false,
        mode: 'on',
        syncHost: true,
        fetchImpl: async (u) => {
          if (/manifest=1/.test(u)) {
            fetches++;
            return { ok: false, status: 401, json: async () => ({}) };
          }
          return ok([]);
        },
      });
      L.state.ready = null;
      const real = vm.runInNewContext;
      // route through a wrapper that mimics CH_AUTH: one retry on 401, then give up
      const ctxAuth = L.DB;
      void ctxAuth;
      void real;
      const src = fs
        .readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8')
        .split('\r')
        .join('');
      assert.ok(/_withAuthRetry\(\(\) => _fetchManifestWithTimeout/.test(src), 'poll wrapped');
      assert.ok(
        /_putWithAuth\(entry\.key, payload\)/.test(src) &&
          /_withAuthRetry\(\(\) => _sendKvPut\(key, payload\)\)/.test(src),
        'kv drain wrapped',
      );
      const core = fs
        .readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8')
        .split('\r')
        .join('');
      assert.ok(
        /_pdfWithAuthRetry\(\(\) => _pdfUploadCommit/.test(core) &&
          /_pdfWithAuthRetry\(\(\) => _pdfDeleteCommit/.test(core),
        'pdf drain wrapped',
      );
      await L.DB.__t._pollManifestForChanges();
      assert.ok(fetches >= 1);
      assert.ok(
        L.events.some((e) => e.type === 'dbAuthRejected'),
        'existing not-authorized message is shown',
      );
      assert.strictEqual(wraps, 0);
    },
  );
  // ---- identity change on refresh (2026-10-06): A's queued edit must never go out as B
  const tokUser = (id) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: FK('t' + id),
      refresh_token: FK('r9'),
      expires_in: 3600,
      user: { id, email: id + '@example.com' },
    }),
  });
  await t('401, refresh returns the SAME user: retried exactly once', async () => {
    const L = loadAuth(tokUser('u1'));
    L.events.length = 0; // ignore load-time events
    let calls = 0;
    const out = await L.A.withAuthRetry(async () =>
      ++calls === 1 ? { status: 'error', httpStatus: 401 } : { status: 'ok' },
    );
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.status, 'ok');
    assert.ok(!L.events.some((x) => x.startsWith('chAuthStateChanged')), 'no identity event for the same user');
  });
  await t('401, refresh returns a DIFFERENT user: no retry, event fired, A entry stays queued under A', async () => {
    const L = loadAuth(tokUser('u2'));
    L.events.length = 0;
    const queue = [{ id: 'q1', key: 'pref', value: 'A-value', owner: { id: 'u1' } }];
    let sentAs = [];
    let calls = 0;
    // Mirrors the db.js drain: owner filter, send through withAuthRetry, delete only on ok.
    const me = L.A.getUserId();
    for (const e of queue.filter((x) => x.owner.id === me)) {
      const out = await L.A.withAuthRetry(async () => {
        calls++;
        sentAs.push(L.A.getUserId());
        return { status: 'error', httpStatus: 401 };
      });
      if (out.status === 'ok') queue.splice(queue.indexOf(e), 1);
    }
    assert.strictEqual(calls, 1, 'not sent again after the account changed');
    assert.deepStrictEqual(sentAs, ['u1']);
    assert.strictEqual(queue.length, 1, 'A entry still queued');
    assert.strictEqual(queue[0].owner.id, 'u1');
    assert.strictEqual(L.A.getUserId(), 'u2');
    assert.strictEqual(L.A.backendMode(), 'on', 'B stays signed in');
    assert.ok(
      L.events.some((x) => x.startsWith('chAuthStateChanged')),
      'identity-change event fired',
    );
    // the next drain pass for B skips A's entry (owner check)
    assert.strictEqual(queue.filter((x) => x.owner.id === L.A.getUserId()).length, 0);
  });

  // ---- phantom conflicts (2026-10-06): hash-gated PUT, one PUT in flight per key, base = sent body
  const sortDeep = (v) =>
    Array.isArray(v)
      ? v.map(sortDeep)
      : v && typeof v === 'object'
        ? Object.keys(v)
            .sort()
            .reduce((o, k) => ((o[k] = sortDeep(v[k])), o), {})
        : v;
  const sha = (v) =>
    require('crypto')
      .createHash('sha256')
      .update(JSON.stringify(sortDeep(v)))
      .digest('hex');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));
  // A mock server: every PUT is logged; answers can be held back (deferred) to overlap writes.
  function putServer(opts) {
    opts = opts || {};
    const puts = [];
    const pending = [];
    const fetchImpl = async (u, o) => {
      if (!o || o.method !== 'PUT') return ok([]);
      const body = JSON.parse(o.body);
      puts.push(body);
      const reply = ok({ version: puts.length, hash: sha(body.value), deleted: false });
      if (!opts.defer) return reply;
      return new Promise((resolve) => pending.push(() => resolve(reply)));
    };
    return { puts, pending, fetchImpl, release: () => pending.splice(0).forEach((f) => f()) };
  }
  await t('fix 1: a set whose canonical value equals the stamp sends no PUT; a changed value does', async () => {
    const S = putServer();
    const { DB } = load({ mode: 'on', syncHost: true, fetchImpl: S.fetchImpl, classify: true });
    await DB.warmCache();
    DB.set('en_budget_x', { a: 2, b: 1 });
    await tick();
    assert.strictEqual(S.puts.length, 1, 'first write is sent');
    assert.strictEqual(DB.__t._stampOf('en_budget_x').hash, sha({ a: 2, b: 1 }));
    DB.set('en_budget_x', { b: 1, a: 2 }); // same content, other key order (jsonb order)
    await tick();
    assert.strictEqual(S.puts.length, 1, 'unchanged value: no PUT');
    DB.set('en_budget_x', { a: 3, b: 1 });
    await tick();
    assert.strictEqual(S.puts.length, 2, 'changed value: PUT');
    assert.deepStrictEqual(S.puts[1].value, { a: 3, b: 1 });
    assert.strictEqual(S.puts[1].baseVersion, 1, 'sent at the version the first answer stamped');
  });
  await t('fix 1: writes to one key never overlap; later writes coalesce to the newest', async () => {
    const S = putServer({ defer: true });
    const { DB } = load({ mode: 'on', syncHost: true, fetchImpl: S.fetchImpl, classify: true });
    await DB.warmCache();
    DB.set('en_budget_y', { n: 1 });
    await tick();
    DB.set('en_budget_y', { n: 2 });
    DB.set('en_budget_y', { n: 3 });
    await tick();
    assert.strictEqual(S.puts.length, 1, 'second and third wait for the first answer');
    S.release();
    await tick();
    assert.strictEqual(S.puts.length, 2, 'one PUT for the waiting writes');
    assert.deepStrictEqual(S.puts[1].value, { n: 3 }, 'newest value wins');
    assert.strictEqual(S.puts[1].baseVersion, 1, 'sent at the new version, so no 409');
    S.release();
    await tick();
    assert.strictEqual(DB.__t._stampOf('en_budget_y').version, 2);
  });
  await t('fix 6: the merge base is the body the server received, not the live list', async () => {
    const S = putServer({ defer: true });
    const { DB } = load({ mode: 'on', syncHost: true, fetchImpl: S.fetchImpl, classify: true });
    await DB.warmCache();
    const tasks = [1, 2, 3].map((i) => ({ id: i, text: 't' + i }));
    DB.set('en_tasks', tasks);
    await tick();
    assert.strictEqual(S.puts.length, 1);
    // the page keeps adding tasks while the PUT is in flight (checkRecurringMeetings loop)
    for (let i = 4; i <= 11; i++) {
      tasks.push({ id: i, text: 't' + i });
      DB.set('en_tasks', tasks);
    }
    S.release(); // first answer arrives: version 1 holds 3 tasks
    await tick();
    assert.strictEqual(DB.__t._baseOf('en_tasks').length, 3, 'base = the 3 tasks the server has, not the 11 live ones');
    assert.strictEqual(S.puts.length, 2, 'the 8 new tasks go out in one coalesced PUT');
    assert.strictEqual(S.puts[1].value.length, 11);
    S.release();
    await tick();
    assert.strictEqual(DB.__t._baseOf('en_tasks').length, 11);
    assert.strictEqual(DB.get('en_tasks').length, 11, 'no task lost');
  });
  await t('fix 7: a 409 whose server value is the same content in jsonb key order is no conflict', async () => {
    let n = 0;
    const { DB } = load({
      mode: 'on',
      syncHost: true,
      classify: true,
      fetchImpl: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        n++;
        // jsonb orders keys by length then bytes: {years, escPct} comes back as {years, escPct} vs sent {escPct, years}
        return {
          ok: false,
          status: 409,
          json: async () => ({
            conflict: true,
            current: {
              key: 'bldgperf_cfg_b1',
              value: { years: 3, escPct: 3.5, cscMode: 'pct' },
              version: 7,
              hash: 'h7',
              deleted: false,
              updatedBy: 'other',
            },
          }),
        };
      },
    });
    await DB.warmCache();
    DB.set('bldgperf_cfg_b1', { cscMode: 'pct', escPct: 3.5, years: 3 });
    await tick();
    assert.strictEqual(n, 1);
    assert.strictEqual(DB.getConflictArchive().length, 0, 'no Conflict history entry for identical data');
    assert.strictEqual(DB.getQueueDepth(), 0, 'nothing queued');
    assert.strictEqual(DB.__t._stampOf('bldgperf_cfg_b1').version, 7, 'server version adopted');
  });
  await t('fix 7: one canonical-JSON function; db.js, restore-merge.js and the audit id all use it', () => {
    const SC = require('./app/sync-classification.js');
    assert.strictEqual(typeof SC.canonicalJSON, 'function');
    const db = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
    const rm = fs.readFileSync(path.join(__dirname, 'app', 'restore-merge.js'), 'utf8');
    assert.ok(
      !/function _sortKeysDeep|JSON\.stringify\(stripDerivedCaches/.test(db),
      'db.js has no private canonical form',
    );
    assert.ok(/SyncClassification\.canonicalJSON\(value\)/.test(db));
    assert.ok(
      /SC\.canonicalJSON\(/.test(rm) && !/\.sort\(\)\s*\.map\(\(k\) => JSON\.stringify\(k\)/.test(rm),
      'restore-merge.js delegates',
    );
    assert.strictEqual(SC.canonicalJSON({ b: [{ z: 1, a: 2 }], a: 1 }), '{"a":1,"b":[{"a":2,"z":1}]}');
    assert.strictEqual(SC.auditEntryId({ z: 1, a: 2 }), SC.canonicalJSON({ a: 2, z: 1 }));
  });

  // ---- the REAL ch-auth.js and the REAL db.js in one sandbox (fix 8, fix 9)
  function loadReal(opts) {
    const uid = opts.userId || 'u1';
    const store = {
      ch_sb_session: JSON.stringify({
        access_token: FK('a'),
        refresh_token: FK('r1'),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: uid,
        email: uid + '@example.com',
      }),
    };
    const events = [];
    const listeners = {};
    const heldLocks = new Set();
    const win = {
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatchEvent(e) {
        events.push(e);
        (listeners[e.type] || []).forEach((fn) => fn(e));
        return true;
      },
      location: { hostname: 'cscdashboard.netlify.app' },
    };
    const sandbox = {
      window: win,
      document: { addEventListener() {}, visibilityState: 'visible' },
      location: win.location,
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
      Date,
      Math,
      JSON,
      Error,
      Number,
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
      // Web Locks with ifAvailable semantics, as in a browser: two drains in one tab never overlap.
      navigator: {
        locks: {
          request: async (name, opts, cb) => {
            if (heldLocks.has(name)) return cb(null);
            heldLocks.add(name);
            try {
              return await cb({ name });
            } finally {
              heldLocks.delete(name);
            }
          },
        },
      },
      indexedDB: undefined,
      fetch: (u, o) => (String(u).indexOf('/auth/v1/token') >= 0 ? opts.tokenFetch(u, o) : opts.kvFetch(u, o)),
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app', 'ch-auth.js'), 'utf8'), sandbox);
    win.SyncClassification = require('./app/sync-classification.js');
    const src = fs
      .readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8')
      .split('\r')
      .join('')
      .replace(
        '  return {\n    warmCache,',
        '  return {\n    __t: { _drainQueueOnce, _queue: () => _syncQueue, _stampOf: (k) => _replicaVersions[k], _appendConflictArchive },\n    warmCache,',
      );
    vm.runInContext(src + '\n;this.__DB = DB;', sandbox);
    return { DB: sandbox.__DB, A: win.CH_AUTH, events, store };
  }
  const put401 = { ok: false, status: 401, json: async () => ({ error: 'expired' }) };
  await t('fix 8: a 401 that the token refresh fixes shows no "server refused" bar', async () => {
    const sent = [];
    const L = loadReal({
      tokenFetch: tokUser('u1'),
      kvFetch: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        if (JSON.parse(o.body).key !== 'en_budget_z') return ok({ version: 1, hash: null, deleted: false }); // first-connect uploads of other keys
        sent.push(o.headers.Authorization);
        return sent.length === 1 ? put401 : ok({ version: 1, hash: null, deleted: false });
      },
    });
    await L.DB.warmCache();
    L.events.length = 0;
    L.DB.set('en_budget_z', { n: 1 });
    await tick(80);
    assert.strictEqual(sent.length, 2, 'refreshed once, then sent again');
    assert.notStrictEqual(sent[0], sent[1], 'the retry carries the new token');
    assert.ok(!L.events.some((e) => e.type === 'dbAuthRejected'), 'no false "server refused" bar');
    assert.strictEqual(L.DB.getQueueDepth(), 0);
    assert.strictEqual(L.A.backendMode(), 'on');
    assert.strictEqual(L.DB.__t._stampOf('en_budget_z').version, 1);
  });
  await t(
    'fix 8: a write still refused after the refresh shows the bar once, ends the session, keeps the edit queued',
    async () => {
      let puts = 0;
      const L = loadReal({
        tokenFetch: tokUser('u1'),
        kvFetch: async (u, o) => {
          if (!o || o.method !== 'PUT') return ok([]);
          if (JSON.parse(o.body).key !== 'en_budget_z') return ok({ version: 1, hash: null, deleted: false }); // first-connect uploads of other keys
          puts++;
          return put401;
        },
      });
      await L.DB.warmCache();
      L.events.length = 0;
      L.DB.set('en_budget_z', { n: 1 });
      await tick(80);
      assert.strictEqual(puts, 2);
      assert.strictEqual(L.events.filter((e) => e.type === 'dbAuthRejected').length, 1, 'reported once, at the end');
      assert.strictEqual(L.A.backendMode(), 'off', 'session ended');
      assert.strictEqual(L.DB.getQueueDepth(), 1, 'the edit is kept in the queue');
    },
  );

  // ---- fix 3: a failed token refresh ends the session only when the server REFUSED it
  const refreshCase = async (tokenFetch) => {
    const L = loadAuth(tokenFetch);
    L.events.length = 0;
    let runs = 0;
    const out = await L.A.withAuthRetry(async () => {
      runs++;
      return { status: 'error', httpStatus: 401 };
    });
    return { L, runs, out };
  };
  await t('fix 3: refresh cannot reach Supabase (network error): session kept, no sign-out, no retry now', async () => {
    const { L, runs, out } = await refreshCase(async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.strictEqual(runs, 1);
    assert.strictEqual(out.httpStatus, 401, 'the caller gets the refusal back and retries later');
    assert.strictEqual(L.A.backendMode(), 'on', 'still signed in');
    assert.ok(L.store.ch_sb_session, 'session still stored');
    assert.ok(!L.events.some((x) => x.startsWith('chAuthStateChanged')), 'no sign-out event');
  });
  await t('fix 3: refresh answered 5xx (Supabase paused): session kept', async () => {
    const { L } = await refreshCase(async () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) }));
    assert.strictEqual(L.A.backendMode(), 'on');
    assert.ok(L.store.ch_sb_session);
  });
  await t('fix 3: refresh refused (400 invalid_grant): session ended', async () => {
    const { L } = await refreshCase(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }));
    assert.strictEqual(L.A.backendMode(), 'off');
    assert.ok(!L.store.ch_sb_session, 'session removed');
    assert.ok(
      L.events.some((x) => x.startsWith('chAuthStateChanged:{"signedOut":true')),
      'sign-out event',
    );
  });

  // ---- fix 4: queue entries with no owner (older build) are never sent under a guessed user
  await t(
    'fix 4: an ownerless queue entry is archived, leaves the queue, is never sent; owned entries still drain',
    async () => {
      const puts = [];
      const serverVal = { n: 'server' };
      const { DB, store } = load({
        mode: 'on',
        syncHost: true,
        classify: true,
        fetchImpl: async (u, o) => {
          if (o && o.method === 'PUT') {
            puts.push(JSON.parse(o.body));
            return ok({ version: 2, hash: sha(JSON.parse(o.body).value), deleted: false });
          }
          if (/manifest=1/.test(u))
            return ok([{ key: 'en_budget_q', version: 1, hash: sha(serverVal), deleted: false }]);
          if (/keys=/.test(u))
            return ok([
              {
                key: 'en_budget_q',
                value: serverVal,
                version: 1,
                hash: sha(serverVal),
                deleted: false,
                updatedBy: 'x',
              },
            ]);
          return ok([]);
        },
      });
      store.en_budget_q = JSON.stringify({ n: 'local-unsent' });
      store.ch_replica_state = JSON.stringify({ en_budget_q: { version: 1, hash: 'stale' } });
      store.ch_sync_queue = JSON.stringify([
        { id: 'old1', key: 'en_budget_q', value: { n: 'local-unsent' }, deleted: false, baseVersion: 1, ts: 1 }, // v83: no owner
        {
          id: 'new1',
          key: 'en_budget_r',
          value: { n: 'mine' },
          deleted: false,
          baseVersion: null,
          ts: 2,
          owner: { id: 'u1', email: null },
        },
      ]);
      await DB.warmCache();
      const arch = DB.getConflictArchive();
      const retired = arch.filter((e) => e.reason === 'queue-entry-no-owner');
      assert.strictEqual(retired.length, 1, 'ownerless entry archived once');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(retired[0].losingValue)), { n: 'local-unsent' }, 'value kept');
      assert.ok(!DB.__t._queue().some((e) => e.id === 'old1'), 'ownerless entry left the queue');
      assert.ok(!puts.some((p) => p.key === 'en_budget_q' || /::en_budget_q$/.test(p.key)), 'never sent, under nobody');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(DB.get('en_budget_q'))),
        serverVal,
        'server value adopted, local copy archived',
      );
      assert.ok(
        arch.some((e) => e.reason === 'hydration-server-wins' && e.key === 'en_budget_q'),
        'local copy archived by hydration',
      );
      await DB.__t._drainQueueOnce();
      assert.ok(
        puts.some((p) => p.key === 'en_budget_r'),
        'the owned entry drains',
      );
      assert.strictEqual(DB.getQueueDepth(), 0, 'queue count reaches 0');
    },
  );

  // ---- fix 2: no-action writers. The real functions, cut from the app files and run as is.
  const fnFrom = (file, name) => {
    const src = fs
      .readFileSync(path.join(__dirname, 'app', file), 'utf8')
      .split('\r')
      .join('');
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' exists in ' + file);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  await t(
    'fix 2: recurring-meeting agenda and task ids are deterministic numbers (same on two browsers), not Date.now',
    () => {
      const stableNumericId = new Function(fnFrom('csv-import.js', 'stableNumericId') + '; return stableNumericId;')();
      const a = stableNumericId('agenda', 1776960415854, '2026-10-14');
      assert.strictEqual(a, stableNumericId('agenda', 1776960415854, '2026-10-14'), 'same inputs, same id');
      assert.ok(Number.isSafeInteger(a) && a > 0);
      assert.notStrictEqual(a, stableNumericId('agenda', 1776960415854, '2026-11-11'));
      assert.notStrictEqual(a, stableNumericId('agenda', 1776960415855, '2026-10-14'));
      assert.notStrictEqual(a, stableNumericId('task', 1776960415854, a));
      const csv = fs.readFileSync(path.join(__dirname, 'app', 'csv-import.js'), 'utf8');
      const gen = csv.slice(
        csv.indexOf('function checkRecurringMeetings'),
        csv.indexOf('function openMtgTemplateSettings'),
      );
      assert.ok(!/Date\.now\(\)|new Date\(\)\.toISOString\(\)/.test(gen), 'no clock values in the generated agenda');
      const task = fnFrom('csv-import.js', 'createMeetingTask');
      assert.ok(!/Date\.now\(\)/.test(task) && /stableNumericId\('task', p\.id, m\.id\)/.test(task));
    },
  );
  await t('fix 2: project progress is computed from the dates on read; the dashboard writes nothing on load', () => {
    const core = fs
      .readFileSync(path.join(__dirname, 'app', 'core.js'), 'utf8')
      .split('\r')
      .join('');
    const src = fnFrom('core.js', 'calcAutoProgress') + '\n' + fnFrom('core.js', 'projectProgress');
    const today = new Date();
    const d = (off) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + off).toISOString().slice(0, 10);
    const projects = [
      { id: 1, start: d(-50), end: d(50), progress: 0 },
      { id: 2, start: d(-50), end: d(50), progress: 90 },
    ];
    const projectProgress = new Function('projects', src + '; return projectProgress;')(projects);
    assert.ok([50, 51].includes(projectProgress(projects[0])), 'from the dates (today is mid-way, rounded)');
    assert.strictEqual(projectProgress(projects[1]), 90, 'a higher typed value stays');
    assert.ok(!/_p\.progress = auto/.test(core), 'no auto progress write on the dashboard tab');
    assert.ok(!/\$\{p\.progress \|\| 0\}/.test(core), 'every bar and input reads projectProgress');
    const es = fs.readFileSync(path.join(__dirname, 'app', 'energy-savings.js'), 'utf8');
    assert.ok(/progress: projectProgress\(p\)/.test(es));
  });
  await t(
    'fix 2: the Performance and Savings Projection panes save only from user edits; readers share getBspCfg',
    () => {
      const ud = fs
        .readFileSync(path.join(__dirname, 'app', 'utility-data.js'), 'utf8')
        .split('\r')
        .join('');
      const body = (name) => fnFrom('utility-data.js', name);
      assert.ok(!/DB\.set\(/.test(body('bpRecalc')), 'bpRecalc does not save');
      assert.ok(!/DB\.set\(/.test(body('bspRecalc')), 'bspRecalc does not save');
      assert.ok(/DB\.set\(storeKey, cfg\)/.test(body('bpSave')) && /DB\.set\(storeKey, cfg\)/.test(body('bspSave')));
      assert.ok(
        /Object\.assign\(\{\}, DB\.get\(storeKey, \{\}\)/.test(body('bspSave')),
        'stored fields (cscPct, _customCsc) kept',
      );
      assert.ok(!/\* 100/.test(body('bspSave')), 'percent stored as typed, no float round trip');
      assert.ok(
        !/oninput="bspRecalc\(\)"|onchange="bspRecalc\(\)"|onclick="bspRecalc\(\)"/.test(ud),
        'inputs call bspChanged',
      );
      assert.strictEqual(
        (ud.match(/getBspCfg\(b/g) || []).length >= 5,
        true,
        'the pane and every savingsPct reader use getBspCfg',
      );
      assert.ok(!/bspCfg\.savingsPct != null/.test(ud), 'no private default rule left');
      const render = ud.slice(ud.indexOf('function renderBldgSavProjPane'), ud.indexOf('function getBspCfg'));
      assert.ok(!/DB\.set\(/.test(render), 'rendering the Savings Projection pane writes nothing');
    },
  );

  // ---- fix 5: one version-stamp record per key; a second tab never overwrites the first tab's stamps
  await t('fix 5: two tabs share one storage; each tab writes only the stamp of the key it synced', async () => {
    const store = {};
    const S = putServer();
    const mk = () => load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl, store });
    const A = mk();
    const B = mk();
    await A.DB.warmCache();
    await B.DB.warmCache(); // tab B loaded before tab A synced anything
    A.DB.set('en_budget_x', { n: 1 }); // tab A syncs X -> version 1
    await tick();
    B.DB.set('en_budget_y', { n: 1 }); // tab B syncs Y; B's memory never saw X's stamp
    await tick();
    assert.strictEqual(A.DB.__t._stampOf('en_budget_x').version, 1);
    assert.strictEqual(B.DB.__t._stampOf('en_budget_y').version, 2);
    assert.ok(store['ch_rv::en_budget_x'] && store['ch_rv::en_budget_y'], 'one record per key in storage');
    assert.ok(!('ch_replica_state' in store) && !('ch_sync_base' in store), 'no whole-map records');
    const C = mk(); // fresh load after both tabs
    await C.DB.warmCache();
    assert.strictEqual(C.DB.__t._stampOf('en_budget_x').version, 1, "tab B's write did not drop tab A's stamp for X");
    assert.strictEqual(C.DB.__t._stampOf('en_budget_y').version, 2);
  });
  await t(
    'fix 5: a collection key keeps its merge base in the same record; stamps of an older build are split once',
    async () => {
      const store = {};
      const S = putServer();
      const A = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl, store });
      await A.DB.warmCache();
      A.DB.set('en_tasks', [{ id: 1, text: 'a' }]);
      await tick();
      const rec = JSON.parse(store['ch_rv::en_tasks']);
      assert.strictEqual(rec.stamp.version, 1);
      assert.deepStrictEqual(rec.base, [{ id: 1, text: 'a' }], 'merge base = what the server received');
      // an older build left whole-map records
      const old = {
        ch_replica_state: JSON.stringify({
          en_budget_q: { version: 4, hash: 'h4' },
          en_tasks: { version: 9, hash: 'h9' },
        }),
        ch_sync_base: JSON.stringify({ en_tasks: [{ id: 9 }] }),
      };
      const store2 = Object.assign({}, old, { 'ch_rv::en_tasks': store['ch_rv::en_tasks'] });
      const B = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl, store: store2 });
      await B.DB.warmCache();
      assert.strictEqual(B.DB.__t._stampOf('en_budget_q').version, 4, 'old map entry migrated');
      assert.strictEqual(B.DB.__t._stampOf('en_tasks').version, 1, 'a per-key record wins over the old map');
      assert.ok(store2['ch_rv::en_budget_q'], 'migrated entry persisted per key');
      assert.ok(!('ch_replica_state' in store2) && !('ch_sync_base' in store2), 'old maps removed after the split');
      assert.ok(
        !Object.keys(B.DB.getAllForExport()).some((k) => k.indexOf('ch_rv::') === 0),
        'stamps never in a backup',
      );
    },
  );

  // ---- fix 9: behavior tests that run the REAL code
  // Cuts a top-level function (with its "async" prefix) out of an app file by brace matching.
  const cutFn = (file, name) => {
    const src = fs
      .readFileSync(path.join(__dirname, 'app', file), 'utf8')
      .split('\r')
      .join('');
    let start = src.indexOf('async function ' + name + '(');
    if (start < 0) start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' exists in ' + file);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  // The real core.js _pdfDrainQueueLocked with its collaborators stubbed; the owner rule is the real DB.entryBelongsTo.
  // opts.onSend(key, user) runs inside each commit (during its await) and may switch the signed-in user.
  const runPdfDrain = async (me, entries, opts) => {
    let queue = entries.map((e) => Object.assign({}, e));
    const sent = [];
    const user = { id: me, tag: 'tok-' + me };
    const onSend = (opts && opts.onSend) || (() => {});
    const { DB } = load({ mode: 'on', syncHost: true, fetchImpl: async () => ok([]) });
    const win = {
      CH_AUTH: { getUserId: () => user.id, backendMode: () => 'on' },
      DB: { entryBelongsTo: DB.entryBelongsTo },
    };
    const drain = new Function(
      'window',
      '_pdfQueueLoad',
      '_pdfQueueSave',
      'pdfLoad',
      '_pdfDeleteCommit',
      '_pdfUploadCommit',
      '_pdfWithAuthRetry',
      'console',
      cutFn('core.js', '_pdfUserChanged') + cutFn('core.js', '_pdfDrainQueueLocked') + '; return _pdfDrainQueueLocked;',
    )(
      win,
      () => queue.map((e) => Object.assign({}, e)),
      (q) => {
        queue = q;
      },
      async () => 'base64',
      async (k) => {
        sent.push('delete ' + k + ' as ' + user.tag);
        await onSend(k, user);
        return { status: 'ok' };
      },
      async (k) => {
        sent.push('upload ' + k + ' as ' + user.tag);
        await onSend(k, user);
        return { status: 'ok' };
      },
      (run) => run(),
      { warn() {} },
    );
    await drain();
    return { queue, sent: sent.map((s) => s.replace(/ as tok-\w+$/, '')), sentAs: sent };
  };
  await t(
    "fix 9: PDF drain claims no-owner and own-hint entries for the verified user; skips every other user's entry",
    async () => {
      const r = await runPdfDrain('u1', [
        { id: 'p1', type: 'upload', key: 'pdf-a' }, // older build: no owner tag
        { id: 'p2', type: 'upload', key: 'pdf-b', owner: { id: null, hintId: 'u1' } }, // queued signed out, u1 was last here
        { id: 'p3', type: 'delete', key: 'pdf-c', owner: { id: 'u2' } }, // another user's
        { id: 'p4', type: 'upload', key: 'pdf-d', owner: { id: null, hintId: 'u2' } }, // another user's hint
      ]);
      assert.deepStrictEqual(r.sent, ['upload pdf-a', 'upload pdf-b']);
      assert.deepStrictEqual(
        r.queue.map((e) => e.id),
        ['p3', 'p4'],
        "other users' entries stay queued",
      );
      assert.deepStrictEqual(r.queue[0].owner, { id: 'u2' }, 'owner tags untouched');
      assert.deepStrictEqual(r.queue[1].owner, { id: null, hintId: 'u2' });
    },
  );
  await t('fix 9: PDF drain with no verified user sends nothing and changes nothing', async () => {
    const entries = [
      { id: 'p1', type: 'upload', key: 'pdf-a' },
      { id: 'p2', type: 'upload', key: 'pdf-b', owner: { id: 'u1' } },
    ];
    const r = await runPdfDrain(null, entries);
    assert.deepStrictEqual(r.sent, []);
    assert.deepStrictEqual(r.queue, entries);
  });
  // ---- 7b (2026-10-06): the PDF drain stops when the signed-in user changes mid-drain (real core.js)
  await t(
    "7b: user switches A -> B during the first send: the rest of A's entries are never sent with B's token",
    async () => {
      const entries = [
        { id: 1, type: 'delete', key: 'pdf-1', owner: { id: 'A' } },
        { id: 2, type: 'delete', key: 'pdf-2', owner: { id: 'A' } },
        { id: 3, type: 'upload', key: 'pdf-3', owner: { id: 'A' } },
      ];
      const r = await runPdfDrain('A', entries, {
        onSend: async (k, user) => {
          await tick(10);
          if (k === 'pdf-1') {
            user.id = 'B';
            user.tag = 'tok-B';
          }
        },
      });
      assert.deepStrictEqual(r.sentAs, ['delete pdf-1 as tok-A'], 'only the send that started as A');
      assert.ok(!r.sentAs.some((s) => / as tok-B$/.test(s)), "nothing sent with B's token");
      assert.deepStrictEqual(
        r.queue.map((e) => e.id),
        [1, 2, 3],
        "nothing removed after the switch; A's entries wait for A",
      );
      assert.deepStrictEqual(
        r.queue.map((e) => e.owner.id),
        ['A', 'A', 'A'],
        'owner tags untouched',
      );
    },
  );
  await t('7b: user switches during the local PDF read (before the upload): the upload is not sent', async () => {
    let queue = [{ id: 1, type: 'upload', key: 'pdf-1', owner: { id: 'A' } }];
    const sent = [];
    const user = { id: 'A' };
    const { DB } = load({ mode: 'on', syncHost: true, fetchImpl: async () => ok([]) });
    const drain = new Function(
      'window',
      '_pdfQueueLoad',
      '_pdfQueueSave',
      'pdfLoad',
      '_pdfDeleteCommit',
      '_pdfUploadCommit',
      '_pdfWithAuthRetry',
      'console',
      cutFn('core.js', '_pdfUserChanged') + cutFn('core.js', '_pdfDrainQueueLocked') + '; return _pdfDrainQueueLocked;',
    )(
      { CH_AUTH: { getUserId: () => user.id, backendMode: () => 'on' }, DB: { entryBelongsTo: DB.entryBelongsTo } },
      () => queue.map((e) => Object.assign({}, e)),
      (q) => {
        queue = q;
      },
      async () => {
        user.id = 'B';
        return 'base64';
      }, // the switch lands while the blob is read
      async (k) => {
        sent.push('delete ' + k);
        return { status: 'ok' };
      },
      async (k) => {
        sent.push('upload ' + k);
        return { status: 'ok' };
      },
      (run) => run(),
      { warn() {} },
    );
    await drain();
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(queue.length, 1, "A's upload still queued");
  });
  await t('7b: same user throughout: every own entry is sent and removed (no regression)', async () => {
    const r = await runPdfDrain('A', [
      { id: 1, type: 'delete', key: 'pdf-1', owner: { id: 'A' } },
      { id: 2, type: 'upload', key: 'pdf-2', owner: { id: 'A' } },
    ]);
    assert.deepStrictEqual(r.sent, ['delete pdf-1', 'upload pdf-2']);
    assert.deepStrictEqual(r.queue, []);
  });
  // The real sync-ui.js _safeToReload with its OPEN_DIALOG_SELECTOR, run against a fake document/window.
  const safeToReload = (st) => {
    const src = fs
      .readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8')
      .split('\r')
      .join('');
    const sel = src.match(/var OPEN_DIALOG_SELECTOR =[\s\S]*?;\n/)[0];
    const doc = { activeElement: st.active || null, querySelector: (q) => (st.dialog ? { matched: q } : null) };
    const win = {
      DB: { getQueueDepth: () => st.queue || 0 },
      pdfQueueDepth: () => st.pdfQueue || 0,
    };
    return new Function('document', 'window', sel + cutFn('sync-ui.js', '_safeToReload') + '; return _safeToReload();')(
      doc,
      win,
    );
  };
  await t(
    'fix 9: _safeToReload blocks while typing, with an open dialog, or with unsent data; allows otherwise',
    () => {
      assert.strictEqual(safeToReload({}), true);
      assert.strictEqual(safeToReload({ active: { tagName: 'INPUT' } }), false, 'typing in an input');
      assert.strictEqual(
        safeToReload({ active: { tagName: 'DIV', isContentEditable: true } }),
        false,
        'typing in a contenteditable',
      );
      assert.strictEqual(safeToReload({ dialog: true }), false, 'an open dialog');
      assert.strictEqual(safeToReload({ queue: 1 }), false, 'unsent data writes');
      assert.strictEqual(safeToReload({ pdfQueue: 1 }), false, 'unsent PDFs');
      assert.strictEqual(safeToReload({ active: { tagName: 'BUTTON' } }), true, 'focus on a button is not typing');
    },
  );
  await t(
    "fix 9: real db.js drain, user id changes across the refresh: A's entry stays queued under A, nothing goes to B::key",
    async () => {
      const puts = [];
      const L = loadReal({
        userId: 'u1',
        tokenFetch: tokUser('u2'), // the refresh picks up the account another tab switched to
        kvFetch: async (u, o) => {
          if (!o || o.method !== 'PUT') return ok([]);
          const key = JSON.parse(o.body).key;
          puts.push({ key, auth: o.headers.Authorization });
          if (key === 'u1::ch_pref_x') return put401; // A's token was revoked
          return ok({ version: 1, hash: null, deleted: false });
        },
      });
      L.store.ch_local_identity = 'u1';
      L.store.ch_sync_queue = JSON.stringify([
        {
          id: 'qa',
          key: 'ch_pref_x',
          value: 'A-value',
          deleted: false,
          baseVersion: null,
          ts: 1,
          owner: { id: 'u1', email: null },
        },
      ]);
      await L.DB.warmCache(); // the startup drain (B1b) sends A's queued entry
      await tick(80);
      assert.strictEqual(L.DB.getQueueDepth(), 1);
      assert.strictEqual(L.A.getUserId(), 'u2', 'the refresh switched this tab to B');
      const pref = puts.filter((p) => /ch_pref_x$/.test(p.key));
      assert.strictEqual(pref.length, 1, 'sent once, as A, before the refresh');
      assert.strictEqual(pref[0].key, 'u1::ch_pref_x');
      assert.ok(!puts.some((p) => p.key === 'u2::ch_pref_x'), 'never written under B');
      const q = L.DB.__t._queue();
      assert.strictEqual(q.length, 1, "A's entry still queued");
      assert.strictEqual(q[0].owner.id, 'u1');
      assert.strictEqual(q[0].value, 'A-value');
      // B's own drain afterwards skips A's entry
      await L.DB.__t._drainQueueOnce();
      await tick(40);
      assert.strictEqual(puts.filter((p) => /ch_pref_x$/.test(p.key)).length, 1, "B's drain does not send A's entry");
      assert.strictEqual(L.A.backendMode(), 'on', 'B stays signed in');
    },
  );
  // ---- 7a (2026-10-06): a token refresh result belongs to the session it started from (real ch-auth.js)
  const gatedToken = (resp) => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    return {
      release,
      fetch: async () => {
        await gate;
        return resp;
      },
    };
  };
  const sessionJSON = (uid, tok, rt) =>
    JSON.stringify({
      access_token: tok,
      refresh_token: rt,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: uid,
      email: uid + '@example.com',
    });
  const refusedOnce = async () => ({ status: 'error', httpStatus: 401 });
  await t(
    "7a: refresh in flight, another tab signs in as B: A's result is dropped, B's session kept, this tab follows B, no retry",
    async () => {
      const g = gatedToken({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: FK('a2'),
          refresh_token: FK('r2'),
          expires_in: 3600,
          user: { id: 'u1', email: 'u1@example.com' },
        }),
      });
      const L = loadAuth(g.fetch);
      let calls = 0;
      const p = L.A.withAuthRetry(async () => {
        calls++;
        return refusedOnce();
      });
      await tick(10);
      L.store.ch_sb_session = sessionJSON('u2', FK('b'), FK('rb')); // tab 2 signs in as B
      g.release();
      const out = await p;
      const s = JSON.parse(L.store.ch_sb_session);
      assert.strictEqual(s.user_id, 'u2', 'B session not overwritten by A');
      assert.strictEqual(s.access_token, FK('b'));
      assert.strictEqual(L.A.getUserId(), 'u2', 'this tab follows storage');
      assert.strictEqual(L.A.getToken(), FK('b'));
      assert.strictEqual(calls, 1, "A's request never sent again as B");
      assert.strictEqual(out.httpStatus, 401);
      assert.ok(
        L.events.some((x) => x.startsWith('chAuthStateChanged')),
        'identity change announced',
      );
    },
  );
  await t(
    '7a: refresh in flight, another tab signs out: the session is not resurrected; this tab is signed out',
    async () => {
      const g = gatedToken({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: FK('a2'),
          refresh_token: FK('r2'),
          expires_in: 3600,
          user: { id: 'u1', email: 'u1@example.com' },
        }),
      });
      const L = loadAuth(g.fetch);
      let calls = 0;
      const p = L.A.withAuthRetry(async () => {
        calls++;
        return refusedOnce();
      });
      await tick(10);
      delete L.store.ch_sb_session; // tab 2 signed out
      g.release();
      await p;
      assert.ok(!('ch_sb_session' in L.store), 'signed-out session not written back');
      assert.strictEqual(L.A.isSignedOut(), true);
      assert.strictEqual(L.A.getToken(), null);
      assert.strictEqual(calls, 1);
    },
  );
  await t("7a: refresh REFUSED while another tab signed in as B: B's session is kept, this tab follows B", async () => {
    const g = gatedToken({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    const L = loadAuth(g.fetch);
    const p = L.A.withAuthRetry(refusedOnce);
    await tick(10);
    L.store.ch_sb_session = sessionJSON('u2', FK('b'), FK('rb'));
    g.release();
    await p;
    assert.strictEqual(JSON.parse(L.store.ch_sb_session).user_id, 'u2', "B not signed out by A's refusal");
    assert.strictEqual(L.A.getUserId(), 'u2');
    assert.strictEqual(L.A.backendMode(), 'on');
  });
  await t('7a: same session throughout: the refresh result is saved and applied as before', async () => {
    const L = loadAuth(tokOk(7));
    let calls = 0;
    const out = await L.A.withAuthRetry(async () =>
      ++calls === 1 ? { status: 'error', httpStatus: 401 } : { status: 'ok' },
    );
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(JSON.parse(L.store.ch_sb_session).access_token, FK('new7'));
    assert.strictEqual(L.A.getToken(), FK('new7'));
    assert.strictEqual(L.A.getUserId(), 'u1');
  });
  // ---- 7c (2026-10-06): Conflict history entries are owner-tagged; a per-user entry is shown only to its owner (real db.js)
  const tokByEmail = async (u, o) => {
    const b = o && o.body ? JSON.parse(o.body) : {};
    const id = b.email ? b.email.split('@')[0] : 'u1';
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: FK('t' + id),
        refresh_token: FK('r' + id),
        expires_in: 3600,
        user: { id, email: id + '@example.com' },
      }),
    };
  };
  // vm-realm arrays are not reference-equal to host arrays: compare by JSON.
  const sameJSON = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
  await t(
    "7c: A's per-user archive entry is hidden from B, kept in storage, shown again to A; shared-key entries show to both",
    async () => {
      const L = loadReal({ userId: 'u1', tokenFetch: tokByEmail, kvFetch: async () => ok([]) });
      await L.DB.warmCache();
      const raw = () => JSON.parse(L.store.en_conflict_archive || '[]');
      L.DB.__t._appendConflictArchive({
        key: 'ch_pref_x',
        reason: 'hydration-server-wins',
        losingSide: 'local',
        losingValue: 'A-private',
      });
      L.DB.__t._appendConflictArchive({
        key: 'en_budget_x',
        reason: 'hydration-server-wins',
        losingSide: 'local',
        losingValue: 'shared-loser',
      });
      await tick(20);
      sameJSON(
        L.DB.getConflictArchive().map((e) => e.key),
        ['ch_pref_x', 'en_budget_x'],
      );
      sameJSON(
        raw().map((e) => e.owner.id),
        ['u1', 'u1'],
        'every entry carries its owner',
      );
      await L.A.signOut();
      await L.A.signIn('u2@example.com', 'pw');
      await tick(40);
      assert.strictEqual(L.A.getUserId(), 'u2');
      sameJSON(
        L.DB.getConflictArchive().map((e) => e.key),
        ['en_budget_x'],
        'B sees the shared entry only',
      );
      assert.ok(!JSON.stringify(L.DB.getConflictArchive()).includes('A-private'), "A's losing value never shown to B");
      assert.strictEqual(raw().length, 2, "A's entry still stored");
      L.DB.__t._appendConflictArchive({
        key: 'ch_pref_x',
        reason: 'hydration-server-wins',
        losingSide: 'local',
        losingValue: 'B-private',
      });
      await tick(20);
      sameJSON(
        L.DB.getConflictArchive().map((e) => e.losingValue),
        ['shared-loser', 'B-private'],
      );
      // B exports and clears what B can see: A's entry is untouched
      L.DB.clearConflictArchive(2);
      await tick(20);
      sameJSON(L.DB.getConflictArchive(), []);
      sameJSON(
        raw().map((e) => [e.key, e.owner.id, e.losingValue]),
        [['ch_pref_x', 'u1', 'A-private']],
      );
      await L.A.signOut();
      await L.A.signIn('u1@example.com', 'pw');
      await tick(40);
      sameJSON(
        L.DB.getConflictArchive().map((e) => e.losingValue),
        ['A-private'],
        "A sees A's entry again",
      );
    },
  );
  await t(
    '7c: entries saved by an older build (no owner tag): shared key shown, per-user key hidden from everyone and kept',
    async () => {
      const L = loadReal({ userId: 'u1', tokenFetch: tokByEmail, kvFetch: async () => ok([]) });
      L.store.en_conflict_archive = JSON.stringify([
        { key: 'ch_pref_x', losingValue: 'someone-private', archivedAt: 'x' },
        { key: 'en_budget_x', losingValue: 'shared', archivedAt: 'x' },
      ]);
      await L.DB.warmCache();
      sameJSON(
        L.DB.getConflictArchive().map((e) => e.key),
        ['en_budget_x'],
      );
      L.DB.clearConflictArchive(5);
      await tick(20);
      sameJSON(
        JSON.parse(L.store.en_conflict_archive).map((e) => e.key),
        ['ch_pref_x'],
        'hidden entry kept',
      );
    },
  );
  await t('7c: sync-ui redraws Conflict history on an identity change', () => {
    const ui = fs
      .readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8')
      .split('\r')
      .join('');
    assert.ok(/addEventListener\('chAuthStateChanged', function \(\) \{[\s\S]{0,200}renderArchiveLink\(\);/.test(ui));
  });
  // ---- 7d (2026-10-06): local per-user stores never act across users (real db.js, localStorage fallback mode)
  const perUserServer = (uid, value) => {
    const puts = [];
    const wire = uid + '::ch_pref_x';
    const kvFetch = async (u, o) => {
      if (o && o.method === 'PUT') {
        puts.push(JSON.parse(o.body).key);
        return ok({ version: 2, hash: null, deleted: false });
      }
      if (/manifest=1/.test(u)) return ok([{ key: wire, version: 1, hash: sha(value), deleted: false }]);
      if (/keys=/.test(u))
        return ok([{ key: wire, value, version: 1, hash: sha(value), deleted: false, updatedBy: uid }]);
      return ok([]);
    };
    return { puts, kvFetch };
  };
  await t(
    "7d: A's queued per-user edit does not block B's hydration of B's own row; A's entry stays queued, nothing sent",
    async () => {
      const S = perUserServer('u2', 'B-value');
      const L = loadReal({ userId: 'u2', tokenFetch: tokByEmail, kvFetch: S.kvFetch });
      L.store.ch_local_identity = 'u2';
      L.store.ch_sync_queue = JSON.stringify([
        {
          id: 'qa',
          key: 'ch_pref_x',
          value: 'A-value',
          deleted: false,
          baseVersion: null,
          ts: 1,
          owner: { id: 'u1', email: null },
        },
      ]);
      await L.DB.warmCache();
      await tick(60);
      assert.strictEqual(L.DB.get('ch_pref_x'), 'B-value', "B's own server value applied");
      assert.strictEqual(L.DB.getQueueDepth(), 1, "A's entry still queued");
      assert.strictEqual(L.DB.__t._queue()[0].owner.id, 'u1');
      assert.ok(!S.puts.some((k) => /ch_pref_x$/.test(k)), 'nothing sent for the key');
      assert.strictEqual(L.DB.__t._stampOf('ch_pref_x').version, 1);
    },
  );
  await t(
    '7d: a queued edit for a SHARED key (any owner) still holds hydration of that key (unchanged rule)',
    async () => {
      const puts = [];
      const L = loadReal({
        userId: 'u2',
        tokenFetch: tokByEmail,
        kvFetch: async (u, o) => {
          if (o && o.method === 'PUT') {
            puts.push(JSON.parse(o.body).key);
            return ok({ version: 2, hash: null, deleted: false });
          }
          if (/manifest=1/.test(u))
            return ok([{ key: 'en_budget_x', version: 1, hash: sha('server'), deleted: false }]);
          if (/keys=/.test(u))
            return ok([{ key: 'en_budget_x', value: 'server', version: 1, hash: sha('server'), deleted: false }]);
          return ok([]);
        },
      });
      L.store.ch_local_identity = 'u2';
      L.store.en_budget_x = JSON.stringify('A-unsent');
      L.store.ch_sync_queue = JSON.stringify([
        {
          id: 'qa',
          key: 'en_budget_x',
          value: 'A-unsent',
          deleted: false,
          baseVersion: null,
          ts: 1,
          owner: { id: 'u1', email: null },
        },
      ]);
      await L.DB.warmCache();
      await tick(60);
      assert.strictEqual(L.DB.get('en_budget_x'), 'A-unsent', "held until A's entry is sent (same server row)");
      assert.strictEqual(L.DB.getQueueDepth(), 1);
      assert.ok(!puts.some((k) => /en_budget_x$/.test(k)), "A's unsent value never uploaded by B");
    },
  );
  await t(
    "7d: a per-user version stamp with no cached value is cleared on an identity change (hard refresh), so B's row loads",
    async () => {
      const S = perUserServer('u2', 'B-value');
      const L = loadReal({ userId: 'u2', tokenFetch: tokByEmail, kvFetch: S.kvFetch });
      L.store.ch_local_identity = 'u1'; // A was the last user on this browser
      L.store['ch_rv::ch_pref_x'] = JSON.stringify({ stamp: { version: 5, hash: 'h5' } }); // A's stamp, value already gone
      await L.DB.warmCache();
      await tick(60);
      assert.strictEqual(L.DB.get('ch_pref_x'), 'B-value');
      assert.strictEqual(L.DB.__t._stampOf('ch_pref_x').version, 1, "A's stale stamp replaced by B's");
      assert.strictEqual(JSON.parse(L.store['ch_rv::ch_pref_x']).stamp.version, 1);
      assert.strictEqual(JSON.parse(L.store.ch_local_identity), 'u2');
    },
  );
  // ---- (a) (2026-10-06): localStorage-fallback mode (no IndexedDB) never syncs the auth session (real db.js + classification)
  await t(
    '(a): fallback-mode first connect uploads local data but never ch_sb_session; identity change keeps the new session',
    async () => {
      const puts = [];
      const L = loadReal({
        userId: 'u1',
        tokenFetch: tokByEmail,
        kvFetch: async (u, o) => {
          if (o && o.method === 'PUT') {
            puts.push(JSON.parse(o.body).key);
            return ok({ version: 1, hash: null, deleted: false });
          }
          return ok([]); // fresh server: empty manifest
        },
      });
      L.store.en_budget_x = JSON.stringify({ n: 1 }); // local-only data of the old "off" mode
      await L.DB.warmCache();
      await tick(80);
      assert.ok(puts.includes('en_budget_x'), 'first-connect upload ran');
      assert.ok(
        !puts.some((k) => /ch_sb_session/.test(k)),
        'the session (tokens) is never uploaded: ' + JSON.stringify(puts),
      );
      const SC = require('./app/sync-classification.js');
      assert.strictEqual(SC.classifyKey('ch_sb_session'), 'local-only');
      assert.strictEqual(SC.shouldReplicate('ch_sb_session'), false);
      assert.strictEqual(SC.isPerUser('ch_sb_session'), false);
      // identity change in fallback mode: the per-user sweep must not remove the new user's session
      await L.A.signOut();
      await L.A.signIn('u2@example.com', 'pw');
      await tick(60);
      assert.strictEqual(
        JSON.parse(L.store.ch_sb_session).user_id,
        'u2',
        'new session kept through the per-user sweep',
      );
      assert.ok(!puts.some((k) => /ch_sb_session/.test(k)));
    },
  );
  // ---- (e) (2026-10-06): the backup file never holds the auth session; restore never writes it (real site-functions.js, sync-classification.js, restore-merge.js)
  const siteFnSrc = (name) =>
    fs
      .readFileSync(path.join(__dirname, 'app', 'site-functions.js'), 'utf8')
      .split('\r')
      .join('')
      .match(new RegExp('(?:async )?function ' + name + String.raw`\(\) \{[\s\S]*?\n\}`))[0];
  await t('(e): siteBackup leaves ch_sb_session out of the file; restore-merge treats it as never-restore', async () => {
    const vm = require('vm');
    const SC = require('./app/sync-classification.js');
    const RM = (() => {
      global.DB = { DERIVED_METER_FIELDS: [] };
      try {
        return require('./app/restore-merge.js');
      } finally {
        delete global.DB;
      }
    })();
    const ls = { ch_sb_session: '{"refresh_token":"SECRET-RT"}', ch_theme: 'dark' };
    let written = null;
    const ctx = {
      window: { SyncClassification: SC },
      localStorage: {
        get length() {
          return Object.keys(ls).length;
        },
        key: (i) => Object.keys(ls)[i],
        getItem: (k) => ls[k],
      },
      DB: { isReady: () => true, getAllForExport: () => ({ en_projects: [], ch_sb_session: '{"refresh_token":"SECRET-RT"}' }) },
      _waitForDBReadyForBackup: async () => {},
      _downloadJson: (f, d) => {
        written = d;
      },
      showToast: () => {},
      Date,
      Object,
      String,
    };
    vm.createContext(ctx);
    vm.runInContext(siteFnSrc('siteBackup'), ctx);
    await vm.runInContext('siteBackup()', ctx);
    assert.ok(written, 'backup written');
    assert.ok(!('ch_sb_session' in written), 'no ch_sb_session in the backup');
    assert.ok(!JSON.stringify(written).includes('SECRET-RT'), 'no token text in the backup');
    assert.strictEqual(written.ch_theme, 'dark', 'other keys still exported');
    assert.ok('en_projects' in written);
    assert.strictEqual(RM.isEngineKey('ch_sb_session'), true, 'restore skips the session key');
    assert.strictEqual(SC.isNeverBackupKey('ch_sb_session'), true);
    assert.strictEqual(SC.isNeverBackupKey('ch_theme'), false);
  });
  console.log(pass + ' passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
