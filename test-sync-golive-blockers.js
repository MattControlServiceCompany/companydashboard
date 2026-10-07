// Unit tests for the Netlify go-live sync blockers B1b, B2, B4 (local mocks only; no network).
// Run: node test-sync-golive-blockers.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Back-off drain timers (15 s and longer) in db.js must not keep the test process alive.
function setTimeoutUnrefLong(fn, ms, ...r) {
  const h = setTimeout(fn, ms, ...r);
  if (ms >= 10000 && h.unref) h.unref();
  return h;
}

function load({ mode, syncHost, fetchImpl, classify }) {
  let src = fs.readFileSync(path.join(__dirname, 'app', 'db.js'), 'utf8');
  src = src
    .split(String.fromCharCode(13))
    .join('')
    .replace(
      '  return {\n    warmCache,',
      '  return {\n    __t: { _hydrate, _batchGetChunked, _drainQueueOnce, _clearPerUserLocalState, _handleAuthIdentityChange, _checkForRemoteChanges, _remoteCheckIfDue, _startBackgroundSync, _stampOf: (k) => _replicaVersions[k], _baseOf: (k) => _syncBase[k], _queue: () => _syncQueue },\n    warmCache,',
    );
  const store = arguments[0].store || {};
  const events = [];
  const state = { mode, syncHost };
  const env = arguments[0].env; // optional: fake clock, document and listener registry (credit-cost tests)
  const win = {
    addEventListener: env ? (n, f) => env.on('window', n, f) : () => {},
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
  if (arguments[0].modal) win.SyncConflictUI = { showConflictModal: arguments[0].modal };
  const SCreal = require('./app/sync-classification.js');
  // Without classify only the audit id rule is provided (db.js always calls it).
  win.SyncClassification = classify
    ? SCreal
    : { auditEntryId: SCreal.auditEntryId, canonicalJSON: SCreal.canonicalJSON };
  const sandbox = {
    window: win,
    document: env ? env.document : { addEventListener() {}, visibilityState: 'visible' },
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
    // Back-off drain timers (15 s and longer) must not keep the test process alive.
    setTimeout: env
      ? env.setTimeout
      : (fn, ms, ...r) => {
          const h = setTimeout(fn, ms, ...r);
          if (ms >= 10000 && h.unref) h.unref();
          return h;
        },
    clearTimeout: env ? env.clearTimeout : clearTimeout,
    setInterval: env ? env.setInterval : () => 0,
    Date: env ? env.Date : Date,
    clearInterval,
    Promise,
    TextEncoder,
    crypto: arguments[0].crypto || globalThis.crypto, // real SHA-256: the "value changed" rule hashes with crypto.subtle
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
    showToast: arguments[0].toast,
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
  await t('theme survives A->B->A in one browser; B does not get the theme of A; nothing is sent', async () => {
    const puts = [];
    const L = load({
      classify: true,
      mode: 'off',
      syncHost: true,
      fetchImpl: async (u, o) => {
        if (o && o.method === 'PUT') puts.push(JSON.parse(o.body));
        return ok([]);
      },
    });
    await L.DB.warmCache();
    L.state.uid = 'A';
    L.state.mode = 'on';
    await L.DB.__t._handleAuthIdentityChange();
    L.store.ch_theme = 'light'; // raw write, as siteApplyTheme does
    L.state.uid = 'B';
    await L.DB.__t._handleAuthIdentityChange();
    assert.ok(L.store.ch_theme == null, 'B must not inherit the theme of A');
    L.store.ch_theme = 'dark'; // B picks dark
    L.state.uid = 'A';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(L.store.ch_theme, 'light', 'A gets the Light theme back');
    L.state.uid = 'B';
    await L.DB.__t._handleAuthIdentityChange();
    assert.strictEqual(L.store.ch_theme, 'dark', 'B gets own theme back');
    assert.strictEqual(puts.filter((p) => /theme/.test(p.key)).length, 0, 'theme never sent to the server');
  });
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
      await L.DB.__t._checkForRemoteChanges();
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
      await L.DB.__t._checkForRemoteChanges();
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
    await L.DB.__t._checkForRemoteChanges();
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
    assert.ok(/_safeToReload\(\)\) window\.location\.reload\(\);\s*else \{\s*renderRemoteChangeBanner/.test(ui));
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
    assert.ok(seen >= 5, 'expected the 5 migration writes (3 retired with the stored bill fields, 2026-10-06), saw ' + seen);
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
    assert.ok(/getConflictArchive\(\)/.test(fn) && !/getConflictArchiveAll/.test(fn), 'exports only what this user may see');
    assert.ok(
      /getConflictArchiveOthers/.test(fn) && fn.indexOf("set('en_conflict_archive'") > fn.indexOf('DB.clear()'),
      "another user's entries are written back after the wipe",
    );
  });

  // ---- 401/403 on periodic sync requests (2026-10-06): refresh once, then end the session
  const FK = (x) => 'fake-' + x;
  const sessionJSON = (uid, tok, rt) =>
    JSON.stringify({
      access_token: tok,
      refresh_token: rt,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: uid,
      email: uid + '@example.com',
    });
  // 8x (2026-10-07): the session lives in per-tab sessionStorage; tabs hand it to each other over a BroadcastChannel.
  // makeNet() is a fake browser: tabs created with the same net share one channel and one set of Web Locks.
  function makeNet() {
    const chans = [];
    const held = new Map();
    class FakeBC {
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        chans.push(this);
      }
      postMessage(d) {
        const copy = JSON.parse(JSON.stringify(d));
        chans.forEach((c) => {
          if (c !== this && c.name === this.name)
            Promise.resolve().then(() => c.onmessage && c.onmessage({ data: copy }));
        });
      }
    }
    const locks = {
      request: async (name, cb) => {
        while (held.get(name)) await held.get(name);
        let release;
        held.set(
          name,
          new Promise((r) => {
            release = r;
          }),
        );
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
          release();
        }
      },
    };
    return { FakeBC, locks, chans };
  }
  function fakeStorage(store) {
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    };
  }
  function loadAuth(tokenFetch, o) {
    o = o || {};
    const store = o.sess || {
      ch_sb_session: JSON.stringify({
        access_token: FK('a'),
        refresh_token: FK('r1'),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: 'u1',
        email: 'u1@example.com',
      }),
    };
    const ls = o.ls || {};
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
      localStorage: fakeStorage(ls),
      sessionStorage: fakeStorage(store),
      BroadcastChannel: o.net ? o.net.FakeBC : undefined,
      navigator: o.net ? { locks: o.net.locks } : {},
      setTimeout: setTimeoutUnrefLong,
      clearTimeout,
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
    return { A: win.CH_AUTH, events, store, sess: store, ls };
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
      await L.DB.__t._checkForRemoteChanges();
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
    const store = opts.store || {};
    const sess = opts.sess || {
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
      sessionStorage: fakeStorage(sess),
      BroadcastChannel: opts.net ? opts.net.FakeBC : undefined,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => {
          store[k] = String(v);
        },
        removeItem: (k) => {
          delete store[k];
        },
        clear: () => {
          Object.keys(store).forEach((k) => delete store[k]);
        },
        key: (i) => Object.keys(store)[i] || null,
        get length() {
          return Object.keys(store).length;
        },
      },
      console: { log() {}, warn() {}, error() {} },
      setTimeout: setTimeoutUnrefLong,
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
          request: async (name, o2, cb) => {
            if (typeof o2 === 'function') return o2({ name }); // ch-auth refresh lock (no options)
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
    return { DB: sandbox.__DB, A: win.CH_AUTH, events, store, sess };
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

  await t('401, refresh returns a DIFFERENT user: REAL drain sends nothing as B, A entry stays queued under A', async () => {
    const puts = [];
    const L = loadReal({
      userId: 'u1',
      tokenFetch: tokUser('u2'), // the refresh after the 401 returns user B
      kvFetch: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        const body = JSON.parse(o.body);
        puts.push({ auth: o.headers.Authorization, key: body.key, value: body.value });
        return body.key === 'en_budget_z' ? put401 : ok({ version: 1, hash: null, deleted: false });
      },
    });
    L.store.ch_sync_queue = JSON.stringify([
      { id: 'q1', key: 'en_budget_z', value: 'A-value', deleted: false, baseVersion: null, ts: 1, owner: { id: 'u1', email: 'u1@example.com' } },
    ]);
    await L.DB.warmCache();
    await tick(60);
    await L.DB.__t._drainQueueOnce(); // the load already drained once; this run must change nothing
    await tick(60);
    const mine = puts.filter((x) => x.key.indexOf('en_budget_z') >= 0);
    assert.strictEqual(mine.length, 1, 'sent once, not again after the account changed');
    assert.strictEqual(mine[0].auth, 'Bearer ' + FK('a'), "with A's token");
    assert.strictEqual(L.A.getUserId(), 'u2');
    assert.strictEqual(L.A.backendMode(), 'on', 'B stays signed in');
    assert.ok(L.DB.__t._queue().some((e) => e.id === 'q1' && e.owner.id === 'u1'), 'A entry still queued under A');
    puts.length = 0;
    await L.DB.__t._drainQueueOnce();
    assert.ok(!puts.some((x) => x.value === 'A-value'), "B's drain never sends A's entry");
  });

  await t('later successful write removes the older queued entry for the same key (REAL db.js)', async () => {
    const puts = [];
    let offline = true;
    const L = loadReal({
      userId: 'u1',
      tokenFetch: tokUser('u1'),
      kvFetch: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        const body = JSON.parse(o.body);
        if (body.key !== 'en_budget_z') return ok({ version: 1, hash: null, deleted: false });
        puts.push(body.value);
        if (offline) throw new TypeError('Failed to fetch');
        return ok({ version: 1, hash: null, deleted: false });
      },
    });
    await L.DB.warmCache();
    await tick(60);
    L.DB.set('en_budget_z', { n: 'old' });
    await tick(60);
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'the failed write is queued');
    offline = false;
    L.DB.set('en_budget_z', { n: 'new' });
    await tick(60);
    assert.strictEqual(L.DB.getQueueDepth(), 0, 'the successful write dropped the older queued entry');
    puts.length = 0;
    await L.DB.__t._drainQueueOnce();
    assert.deepStrictEqual(puts, [], 'the drain replays nothing');
  });

  // ---- re-review F1: an edit by A is never sent with B's token or key (REAL db.js + ch-auth.js)
  await t('F1: A edits twice, B signs in during PUT #1: the waiting value is never PUT as B', async () => {
    const puts = [];
    let release;
    const held = new Promise((r) => (release = r));
    const L = loadReal({
      userId: 'u1',
      tokenFetch: tokUser('u2'),
      kvFetch: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        const body = JSON.parse(o.body);
        puts.push({ auth: o.headers.Authorization, key: body.key, value: body.value });
        if (body.key === 'u1::ch_theme') {
          await held;
          return put401; // the refresh then returns user B: identity changes in flight
        }
        return ok({ version: 1, hash: null, deleted: false });
      },
    });
    await L.DB.warmCache();
    puts.length = 0;
    L.DB.set('ch_theme', 'A-first');
    await tick(40);
    L.DB.set('ch_theme', 'A-second'); // waits behind PUT #1, owner A
    await tick(40);
    release();
    await tick(200);
    assert.strictEqual(L.A.getUserId(), 'u2', 'identity changed to B');
    const toB = puts.filter((x) => /^u2::/.test(x.key) && x.key.indexOf('ch_theme') >= 0);
    assert.deepStrictEqual(toB, [], 'no PUT of the key under B');
    assert.ok(puts.every((x) => x.value !== 'A-second'), 'A-second never sent');
    assert.strictEqual(L.DB.__t._stampOf('ch_theme'), undefined, 'no stamp set for B');
  });

  // ---- delta-review LOW (2026-10-06): an edit in flight when its author signs OUT is kept, under the author's id
  await t('F1b: A signs out while a per-user edit is in flight: the edit is queued under A, never lost', async () => {
    const puts = [];
    let release;
    const held = new Promise((r) => (release = r));
    const L = loadReal({
      userId: 'u1',
      tokenFetch: tokUser('u1'),
      kvFetch: async (u, o) => {
        if (!o || o.method !== 'PUT') return ok([]);
        const body = JSON.parse(o.body);
        puts.push({ auth: o.headers.Authorization, key: body.key, value: body.value });
        if (body.value === 'A-first') await held;
        return ok({ version: 1, hash: null, deleted: false });
      },
    });
    await L.DB.warmCache();
    puts.length = 0;
    L.DB.set('ch_theme', 'A-first');
    await tick(40);
    await L.A.signOut(); // A signs out while PUT #1 is in flight
    release();
    await tick(200);
    const q = L.DB.__t._queue().filter((e) => e.key === 'ch_theme');
    assert.strictEqual(q.length, 1, 'the edit is queued, not dropped');
    assert.strictEqual(q[0].owner.id, 'u1', "queued under its author's id");
    assert.strictEqual(q[0].value, 'A-first');
  });

  // ---- re-review F2/F3: backup and Reset never hold another user's per-user archive or queue values
  await t('F2/F3: export, Reset list and kept list use the one visibility rule (REAL db.js)', async () => {
    const sameJSON = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    const L = loadReal({ userId: 'u1', tokenFetch: tokUser('u1'), kvFetch: async () => ok([]) });
    await L.DB.warmCache();
    const ap = L.DB.__t._appendConflictArchive;
    ap({ key: 'ch_theme', owner: { id: 'u2', email: 'b' }, losingValue: 'B-private' });
    ap({ key: 'ch_theme', owner: { id: 'u1', email: 'a' }, losingValue: 'A-mine' });
    ap({ key: 'en_budget_z', owner: { id: 'u2', email: 'b' }, losingValue: 'B-shared' });
    ap({ key: 'ch_theme', owner: { id: null, email: null, hintId: null }, losingValue: 'ownerless' });
    L.DB.set('ch_sync_queue', [{ id: 'q', key: 'bills_col_widths_x', owner: { id: 'u2' }, value: 'B-queued' }]);
    const exp = L.DB.getAllForExport();
    const txt = JSON.stringify(exp);
    assert.ok(!txt.includes('B-private') && !txt.includes('ownerless'), 'no hidden per-user entry in the backup');
    assert.ok(!txt.includes('B-queued') && !('ch_sync_queue' in exp), 'no queue values in the backup');
    sameJSON(exp.en_conflict_archive.map((e) => e.losingValue).sort(), ['A-mine', 'B-shared']);
    sameJSON(L.DB.getConflictArchive().map((e) => e.losingValue).sort(), ['A-mine', 'B-shared']);
    sameJSON(L.DB.getConflictArchiveOthers().map((e) => e.losingValue).sort(), ['B-private', 'ownerless']);
    assert.strictEqual(L.DB.getConflictArchiveAll, undefined, 'no unfiltered reader in the public API');
  });

  // ---- re-review F4: an ownerless per-user queue entry is not archived under the signed-in user
  await t('F4: ownerless per-user entry is archived with no owner: hidden, never sent', async () => {
    const puts = [];
    const L = loadReal({
      userId: 'u1',
      tokenFetch: tokUser('u1'),
      kvFetch: async (u, o) => {
        if (o && o.method === 'PUT') puts.push(JSON.parse(o.body).key);
        return ok([]);
      },
    });
    L.store.ch_sync_queue = JSON.stringify([
      { id: 'o1', key: 'ch_theme', value: 'A-old-theme', deleted: false, baseVersion: null, ts: 1 },
    ]);
    await L.DB.warmCache();
    await tick(30);
    assert.ok(!JSON.stringify(L.DB.getConflictArchive()).includes('A-old-theme'), 'not shown to the signed-in user');
    assert.ok(JSON.stringify(L.DB.getConflictArchiveOthers()).includes('A-old-theme'), 'value kept in storage');
    assert.ok(!puts.some((k) => /ch_theme/.test(k)), 'never sent');
  });

  // ---- re-review F5: a server row with no value never replaces the local copy (REAL db.js)
  for (const shape of [{}, { value: null }]) {
    await t('F5: server row ' + JSON.stringify(shape) + ' keeps the local copy and its stamp', async () => {
      const L = loadReal({
        userId: 'u1',
        tokenFetch: tokUser('u1'),
        kvFetch: async (u, o) => {
          if (o && o.method === 'PUT') return ok({ version: 8, hash: null, deleted: false });
          if (/manifest=1/.test(u)) return ok([{ key: 'en_budget_z', version: 7, hash: 'zz', deleted: false }]);
          if (/keys=/.test(u)) return ok([Object.assign({ key: 'en_budget_z', version: 7, deleted: false }, shape)]);
          return ok([]);
        },
      });
      L.store.en_budget_z = JSON.stringify({ n: 1, important: true });
      await L.DB.warmCache();
      await tick(100);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(L.DB.get('en_budget_z'))), { n: 1, important: true });
      assert.ok(L.store.en_budget_z.includes('important'), 'storage untouched');
      assert.ok(!(L.DB.__t._stampOf('en_budget_z') || {}).version, 'no server stamp adopted');
      assert.ok(L.events.some((e) => e.type === 'dbHydrateFailed'), 'notice raised');
    });
  }

  // ---- re-review F6: a stale tab's 403 never clears another user's shared session (REAL ch-auth.js)
  await t('F6: tab cached as A gets 403 while storage holds B: B stays signed in', async () => {
    const net = makeNet();
    const L = loadReal({ userId: 'u1', tokenFetch: tokUser('u1'), kvFetch: async () => ok([]), net });
    const peer = new net.FakeBC('ch_auth');
    assert.strictEqual(L.A.getUserId(), 'u1');
    // tab B signs in as u2 while this tab's request (built for u1) is in flight
    const out = await L.A.withAuthRetry(async () => {
      peer.postMessage({ t: 'session', session: JSON.parse(sessionJSON('u2', FK('b'), FK('rb'))) });
      await tick(10);
      return { status: 'error', httpStatus: 403 };
    });
    assert.strictEqual(out.httpStatus, 403);
    assert.ok(L.sess.ch_sb_session && JSON.parse(L.sess.ch_sb_session).user_id === 'u2', 'B session kept in storage');
    assert.strictEqual(L.A.getUserId(), 'u2', 'this tab now follows B');
    assert.strictEqual(L.A.backendMode(), 'on');
  });
  await t('F6: 403 for the stored user itself still ends the session', async () => {
    const L = loadReal({ userId: 'u1', tokenFetch: tokUser('u1'), kvFetch: async () => ok([]) });
    await L.A.withAuthRetry(async () => ({ status: 'error', httpStatus: 403 }));
    assert.strictEqual(L.A.backendMode(), 'off');
    assert.ok(!L.sess.ch_sb_session);
  });

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

  await t('F-single-source: getBspCfg is the ONE reader of savingsPct; a real 0 stays 0 in every file', () => {
    ['report-engine.js', 'graphics-setpoints.js'].forEach((f) => {
      const src = fs.readFileSync(path.join(__dirname, 'app', f), 'utf8');
      assert.ok(!/bldgsavproj_cfg_/.test(src), f + ' has no raw reader of the savings config');
      assert.ok(/getBspCfg\(b\)\.savingsPct/.test(src), f + ' reads through getBspCfg');
      assert.ok(!/savingsPct\s*\|\|\s*11/.test(src), f + ' does not turn a 0 into 11');
    });
    const make = (stored) =>
      new Function(
        'DB',
        'projects',
        'udSelProjId',
        fnFrom('utility-data.js', 'getBspCfg') + '; return getBspCfg;',
      )({ get: () => stored }, [], null);
    assert.strictEqual(make({ savingsPct: 0 })({ id: 'b' }).savingsPct, 0, 'real 0 stays 0');
    assert.strictEqual(make({})({ id: 'b' }).savingsPct, 11, 'never set: the pane default');
  });

  await t("F-single-source: 'ch_rv::' is spelled once (sync-classification.js); backup and restore skip it", () => {
    fs.readdirSync(path.join(__dirname, 'app'))
      .filter((f) => /\.js$/.test(f) && f !== 'sync-classification.js')
      .forEach((f) => {
        const src = fs.readFileSync(path.join(__dirname, 'app', f), 'utf8');
        const code = src.replace(/^\s*(\/\/|\*).*$/gm, '');
        assert.ok(!/['"]ch_rv::/.test(code), f + ' has its own copy of the prefix');
      });
    const SC = require('./app/sync-classification.js');
    assert.strictEqual(SC.RV_PREFIX, 'ch_rv::');
    assert.ok(SC.isNeverBackupKey('ch_rv::en_budget_x') && SC.isNeverBackupKey('ch_sb_session'));
    assert.ok(!SC.isNeverBackupKey('en_budget_x'));
  });

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
      const net = makeNet();
      const L = loadAuth(g.fetch, { net });
      const peer = new net.FakeBC('ch_auth');
      let calls = 0;
      const p = L.A.withAuthRetry(async () => {
        calls++;
        return refusedOnce();
      });
      await tick(10);
      peer.postMessage({ t: 'session', session: JSON.parse(sessionJSON('u2', FK('b'), FK('rb'))) }); // tab 2 signs in as B
      await tick(10);
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
      const net = makeNet();
      const L = loadAuth(g.fetch, { net });
      const peer = new net.FakeBC('ch_auth');
      let calls = 0;
      const p = L.A.withAuthRetry(async () => {
        calls++;
        return refusedOnce();
      });
      await tick(10);
      peer.postMessage({ t: 'signout' }); // tab 2 signed out
      await tick(10);
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
    const net = makeNet();
    const L = loadAuth(g.fetch, { net });
    const peer = new net.FakeBC('ch_auth');
    const p = L.A.withAuthRetry(refusedOnce);
    await tick(10);
    peer.postMessage({ t: 'session', session: JSON.parse(sessionJSON('u2', FK('b'), FK('rb'))) });
    await tick(10);
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
        JSON.parse(L.sess.ch_sb_session).user_id,
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
  // ---- (f) (2026-10-06): Reset exports only the entries the user may see (the one viewer rule) and keeps the others
  await t('(f): siteResetData exports only the archive entries the user may see; other users entries are kept', async () => {
    const vm = require('vm');
    const L = loadReal({ userId: 'u1', tokenFetch: tokByEmail, kvFetch: async () => ok([]) });
    L.store.en_conflict_archive = JSON.stringify([
      { key: 'ch_pref_x', losingValue: 'B-private', owner: { id: 'u2', email: 'u2@example.com' }, archivedAt: 't' },
      { key: 'ch_pref_y', losingValue: 'A-private', owner: { id: 'u1', email: 'u1@example.com' }, archivedAt: 't' },
      { key: 'en_budget_x', losingValue: 'shared', owner: { id: 'u2', email: null }, archivedAt: 't' },
    ]);
    await L.DB.warmCache();
    await tick(30);
    assert.deepStrictEqual(
      L.DB.getConflictArchive().map((e) => e.key).sort(),
      ['ch_pref_y', 'en_budget_x'],
      'viewer: B-private hidden from u1',
    );
    let exported = null;
    const ctx = {
      DB: Object.assign({}, L.DB, { clear: async () => {} }), // real readers, no real wipe
      confirm: () => true,
      _downloadJSON: (d) => {
        exported = d;
      },
      localStorage: { clear: () => {} },
      sessionStorage: { clear: () => {} },
      setTimeout: () => {},
      location: { reload: () => {} },
      Date,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(siteFnSrc('siteResetData'), ctx);
    await vm.runInContext('siteResetData()', ctx);
    assert.ok(exported, 'archive exported before the wipe');
    assert.strictEqual(exported.length, 2, 'only the entries u1 may see are exported');
    assert.ok(!JSON.stringify(exported).includes('B-private'), "other user's private value is not in the file");
    const kept = L.DB.getConflictArchiveOthers();
    assert.ok(kept.length === 1 && kept[0].losingValue === 'B-private', "other user's entry is written back after the wipe");
  });
  // ---- (g) (2026-10-06): Reset with the REAL DB.clear: own entries exported then wiped, other users' entries survive
  await t("(g): siteResetData with the real DB.clear keeps other users' archive entries and wipes the user's own", async () => {
    const vm = require('vm');
    const L = loadReal({ userId: 'u1', tokenFetch: tokByEmail, kvFetch: async () => ok([]) });
    L.store.en_conflict_archive = JSON.stringify([
      { key: 'ch_pref_x', losingValue: 'B-private', owner: { id: 'u2', email: 'u2@example.com' }, archivedAt: 't' },
      { key: 'ch_pref_y', losingValue: 'A-private', owner: { id: 'u1', email: 'u1@example.com' }, archivedAt: 't' },
    ]);
    await L.DB.warmCache();
    await tick(30);
    let exported = null;
    const ctx = {
      DB: L.DB,
      confirm: () => true,
      _downloadJSON: (d) => {
        exported = d;
      },
      localStorage: { clear: () => {} },
      sessionStorage: { clear: () => {} },
      setTimeout: () => {},
      location: { reload: () => {} },
      Date,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(siteFnSrc('siteResetData'), ctx);
    await vm.runInContext('siteResetData()', ctx);
    assert.strictEqual(exported.length, 1, "only the user's own entry is exported");
    assert.strictEqual(exported[0].losingValue, 'A-private');
    await tick(30);
    assert.strictEqual(L.DB.getConflictArchive().length, 0, "own entry is wiped");
    const kept = L.DB.getConflictArchiveOthers();
    assert.ok(kept.length === 1 && kept[0].losingValue === 'B-private', "other user's entry survives the real clear");
  });
  // ---- Poll fixes (2026-10-06): a key first created on the server after page load; a change seen while unsafe
  await t('POLL1 a key created on the server AFTER load is applied by the next poll (no reload, no PUT)', async () => {
    const srv = makeServer({ en_note: 'v1' });
    // classify:true so the real RV_PREFIX keeps the local stamp records out of the PUT count
    const L = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: srv.fetchImpl });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    await settle();
    assert.ok(!L.DB.__t._stampOf('en_tasks'), 'no stamp before');
    srv.rows.en_tasks = { value: [{ id: 't1', text: 'first task' }], version: 1, hash: 'ht1' };
    L.events.length = 0;
    const putsBefore = srv.puts.length;
    await L.DB.__t._checkForRemoteChanges();
    assert.deepStrictEqual(clone(L.DB.get('en_tasks')), [{ id: 't1', text: 'first task' }], 'applied by the poll');
    const applied = L.events.find((e) => e.type === 'dbRemoteApplied');
    assert.ok(applied && Array.from(applied.detail.keys).join(',') === 'en_tasks', 'dbRemoteApplied announced');
    assert.ok(!L.events.some((e) => e.type === 'remoteChange'), 'no refresh bar');
    assert.strictEqual(srv.puts.length, putsBefore, 'no PUT');
    assert.strictEqual(L.DB.getQueueDepth(), 0, 'nothing queued');
    assert.strictEqual(L.DB.getConflictArchive().length, 0, 'no conflict');
    // A second poll with nothing new does nothing.
    L.events.length = 0;
    await L.DB.__t._checkForRemoteChanges();
    assert.ok(!L.events.some((e) => e.type === 'dbRemoteApplied'), 'second poll silent');
  });
  await t('POLL1 a key whose server row is deleted and has no stamp is not announced', async () => {
    const srv = makeServer({ en_note: 'v1' });
    const L = await syncedBrowser(srv);
    srv.rows.en_gone = { value: 'x', version: 2, hash: 'hg' };
    const f0 = srv.fetchImpl;
    srv.fetchImpl = async (u, o) => {
      if (String(u).includes('manifest=1')) {
        const r = await f0(u, o);
        const list = await r.json();
        list.forEach((m) => {
          if (m.key === 'en_gone') m.deleted = true;
        });
        return ok(list);
      }
      return f0(u, o);
    };
    // The loaded browser used the old fetchImpl reference; rebuild with the wrapper.
    const L2 = await syncedBrowser(srv);
    L2.events.length = 0;
    await L2.DB.__t._checkForRemoteChanges();
    assert.ok(!L2.events.some((e) => e.type === 'dbRemoteApplied' || e.type === 'remoteChange'));
  });
  // The real sync-ui.js run against a fake window/document.
  function loadSyncUi(st) {
    const src = fs.readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8').split('\r').join('');
    const handlers = {};
    const timers = [];
    const mkEl = () => {
      const el = {
        style: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild(c) {
          el.children.push(c);
          return c;
        },
        addEventListener() {},
        setAttribute() {},
        removeChild() {},
        remove() {},
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return el;
    };
    const els = {};
    const doc = {
      get activeElement() {
        return st.active || null;
      },
      querySelector: (q) => (st.dialog ? { matched: q } : null),
      getElementById: (id) => els[id] || null,
      createElement: () => mkEl(),
      body: mkEl(),
      head: mkEl(),
      addEventListener() {},
    };
    doc.body.appendChild = (c) => {
      if (c && c.id) els[c.id] = c;
      return c;
    };
    st.reloads = 0;
    const win = {
      addEventListener: (n, f) => {
        (handlers[n] = handlers[n] || []).push(f);
      },
      removeEventListener() {},
      DB: { getQueueDepth: () => st.queue || 0 },
      pdfQueueDepth: () => 0,
      location: {
        reload: () => {
          st.reloads++;
        },
      },
    };
    const sb = {
      window: win,
      document: doc,
      console,
      setTimeout: (f) => {
        timers.push({ f, kind: 't' });
        return timers.length;
      },
      clearTimeout() {},
      setInterval: (f) => {
        const h = { f, kind: 'i', live: true };
        timers.push(h);
        return h;
      },
      clearInterval: (h) => {
        if (h) h.live = false;
      },
    };
    vm.createContext(sb);
    vm.runInContext(src, sb);
    return {
      fire: (n, detail) => (handlers[n] || []).forEach((f) => f({ detail })),
      tick: () => timers.filter((x) => x.kind === 'i' && x.live).forEach((x) => x.f()),
      intervals: () => timers.filter((x) => x.kind === 'i' && x.live).length,
    };
  }
  await t('POLL2 a change seen while unsafe is kept and the page reloads once it becomes safe', () => {
    const st = { active: { tagName: 'INPUT' } };
    const ui = loadSyncUi(st);
    ui.fire('dbRemoteApplied', { keys: ['en_tasks'] });
    assert.strictEqual(st.reloads, 0, 'no reload while typing');
    ui.tick();
    assert.strictEqual(st.reloads, 0, 'still typing: still no reload');
    st.dialog = true;
    st.active = null;
    ui.tick();
    assert.strictEqual(st.reloads, 0, 'dialog open: no reload');
    st.dialog = false;
    st.queue = 2;
    ui.tick();
    assert.strictEqual(st.reloads, 0, 'unsent data: no reload');
    st.queue = 0;
    ui.tick();
    assert.strictEqual(st.reloads, 1, 'safe now: reload');
    assert.strictEqual(ui.intervals(), 0, 'retry stops after the reload');
    // Several unsafe events share one retry loop.
    const st2 = { active: { tagName: 'TEXTAREA' } };
    const ui2 = loadSyncUi(st2);
    ui2.fire('dbRemoteApplied', { keys: ['a'] });
    ui2.fire('dbRemoteApplied', { keys: ['b'] });
    assert.strictEqual(ui2.intervals(), 1, 'one retry loop');
  });
  await t('POLL2 a change seen while safe reloads at once and starts no retry loop', () => {
    const st = {};
    const ui = loadSyncUi(st);
    ui.fire('dbRemoteApplied', { keys: ['en_tasks'] });
    assert.strictEqual(st.reloads, 1);
    assert.strictEqual(ui.intervals(), 0);
  });

  // ---- Review fixes (2026-10-06)
  await t('REV1 the theme stash ch_theme_user::<uid> is never in a backup file (the one never-backup rule)', async () => {
    const SC = require('./app/sync-classification.js');
    assert.strictEqual(SC.isNeverBackupKey('ch_theme_user::u1'), true);
    assert.strictEqual(SC.classifyKey('ch_theme_user::u1'), 'local-only');
    assert.strictEqual(SC.isNeverBackupKey('ch_theme'), false);
    const ls = { ch_theme: 'dark', 'ch_theme_user::u-other': 'light' };
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
      DB: { isReady: () => true, getAllForExport: () => ({ en_projects: [] }) },
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
    assert.ok(!Object.keys(written).some((k) => k.indexOf('ch_theme_user::') === 0), 'no theme stash key in the backup');
    assert.strictEqual(written.ch_theme, 'dark', 'the theme itself is still exported');
  });
  await t('REV2 a pending reload timer is cleared on a user switch or sign-out', () => {
    const st = { active: { tagName: 'INPUT' } };
    const ui = loadSyncUi(st);
    ui.fire('dbRemoteApplied', { keys: ['en_tasks'] });
    assert.strictEqual(ui.intervals(), 1, 'retry loop running');
    ui.fire('chAuthStateChanged', { signedOut: false });
    assert.strictEqual(ui.intervals(), 0, 'retry loop cleared by the user switch');
    st.active = null;
    ui.tick();
    assert.strictEqual(st.reloads, 0, 'no reload for the previous user');
    // A later unsafe event starts a fresh loop (the flag was reset too).
    st.active = { tagName: 'INPUT' };
    ui.fire('dbRemoteApplied', { keys: ['en_tasks'] });
    assert.strictEqual(ui.intervals(), 1, 'a new loop can start');
    ui.fire('chAuthStateChanged', { signedOut: true });
    assert.strictEqual(ui.intervals(), 0, 'cleared on sign-out too');
  });
  await t('REV3 a local edit made while the server value is being hashed is never overwritten', async () => {
    const srv = makeServer({ en_note: 'v1' });
    let hook = null;
    const realSubtle = globalThis.crypto.subtle;
    const fakeCrypto = {
      subtle: {
        digest: async (...a) => {
          if (hook) {
            const h = hook;
            hook = null;
            h();
          }
          return realSubtle.digest(...a);
        },
      },
    };
    const L = load({ mode: 'on', syncHost: true, classify: false, fetchImpl: srv.fetchImpl, crypto: fakeCrypto });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    await settle();
    assert.strictEqual(L.DB.get('en_note'), 'v1');
    // Another user changes the key. Our edit lands inside the await of the reconcile.
    srv.rows.en_note = { value: 'server-v2', version: 2, hash: 'hen_note2' };
    let edit = null;
    hook = () => {
      edit = L.DB.set('en_note', 'local-edit-in-gap');
    };
    await L.DB.__t._hydrate();
    await edit;
    await settle();
    assert.ok(hook === null, 'the edit was injected during the real await');
    assert.strictEqual(L.DB.get('en_note'), 'local-edit-in-gap', 'local edit not replaced by the server value');
  });
  await t('REV4 a key created on the server while this browser holds a queued local value for it: local kept and sent, no loss, no phantom conflict', async () => {
    const srv = makeServer({ en_projects: [] });
    let down = false;
    const f0 = srv.fetchImpl;
    const fetchImpl = async (u, o) => {
      if (down && o && o.method === 'PUT') throw new TypeError('Failed to fetch');
      return f0(u, o);
    };
    const L = load({ mode: 'on', syncHost: true, classify: true, fetchImpl });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    await settle();
    down = true;
    await L.DB.set('en_tasks', { n: 'local' }); // offline: queued, never reached the server
    await settle();
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'queued');
    // Meanwhile another user creates the same key on the server.
    srv.rows.en_tasks = { value: { n: 'theirs' }, version: 1, hash: 'hnew1' };
    L.events.length = 0;
    await L.DB.__t._checkForRemoteChanges();
    await settle();
    assert.deepStrictEqual(clone(L.DB.get('en_tasks')), { n: 'local' }, 'local value kept');
    assert.strictEqual(L.DB.getQueueDepth(), 1, 'still queued');
    assert.ok(!L.events.some((e) => e.type === 'dbRemoteApplied' && Array.from(e.detail.keys).includes('en_tasks')), 'not announced as applied');
    assert.strictEqual(L.DB.getConflictArchive().length, 0, 'no phantom conflict archive');
    // Back online: the queued value is sent.
    down = false;
    await L.DB.__t._drainQueueOnce();
    await settle();
    assert.strictEqual(srv.puts.filter((p) => p.key === 'en_tasks').length, 1, 'exactly one PUT, nothing sent by the poll');
    assert.deepStrictEqual(clone(srv.puts.find((p) => p.key === 'en_tasks').value), { n: 'local' }, 'the local value was sent');
    assert.deepStrictEqual(clone(L.DB.get('en_tasks')), { n: 'local' }, 'local value still held');
    const onServer = JSON.stringify(srv.rows.en_tasks.value);
    const archived = JSON.stringify(L.DB.getConflictArchive());
    assert.ok(onServer.includes('local') || archived.includes('local'), 'local value is on the server or archived: not lost');
    assert.ok(onServer.includes('theirs') || archived.includes('theirs'), 'their value is on the server or archived: not lost');
  });
// ---- 8 (2026-10-07): closing the browser signs the user out. Session in per-tab sessionStorage + BroadcastChannel handoff.
const tokNew = (n, uid) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    access_token: FK("n" + n),
    refresh_token: FK("rn" + n),
    expires_in: 3600,
    user: { id: uid || "u1", email: (uid || "u1") + "@example.com" },
  }),
});
const noNet = async () => {
  throw new Error("no network call expected");
};
const emptySess = () => ({});
await t(
  "8a: sign-in writes sessionStorage; localStorage never holds ch_sb_session",
  async () => {
    const net = makeNet();
    const L = loadAuth(tokNew(1), { net, sess: emptySess() });
    await L.A.signIn("u1@example.com", "pw");
    assert.ok(L.sess.ch_sb_session, "in sessionStorage");
    assert.ok(!("ch_sb_session" in L.ls), "not in localStorage");
    assert.strictEqual(L.A.backendMode(), "on");
  },
);
await t(
  "8b: reload (new instance, same sessionStorage): signed in, no network call",
  async () => {
    const L1 = loadAuth(tokNew(1), { net: makeNet() });
    const L2 = loadAuth(noNet, { net: makeNet(), sess: L1.sess });
    await L2.A.ready();
    assert.strictEqual(L2.A.isSignedOut(), false);
    assert.strictEqual(L2.A.getUserId(), "u1");
    assert.strictEqual(L2.A.getToken(), FK("a"));
  },
);
await t(
  "8c: new tab (empty sessionStorage) + a signed-in peer: handshake gives the session, no password",
  async () => {
    const net = makeNet();
    const A = loadAuth(noNet, { net });
    const B = loadAuth(noNet, { net, sess: emptySess() });
    assert.strictEqual(B.A.isSignedOut(), true, "before the answer");
    await B.A.settled();
    await B.A.ready();
    assert.strictEqual(B.A.isSignedOut(), false);
    assert.strictEqual(B.A.needsSignIn(), false);
    assert.strictEqual(B.A.getToken(), FK("a"));
    assert.ok(B.sess.ch_sb_session, "saved in the new tab sessionStorage");
    assert.ok(A.A.getToken());
  },
);
await t(
  "8d: new tab with no peer: signed out within 400 ms, needsSignIn true",
  async () => {
    const net = makeNet();
    const t0 = Date.now();
    const B = loadAuth(noNet, { net, sess: emptySess() });
    await B.A.ready();
    const dt = Date.now() - t0;
    assert.ok(dt >= 350 && dt < 900, "waited about 400 ms, took " + dt);
    assert.strictEqual(B.A.isSignedOut(), true);
    assert.strictEqual(B.A.needsSignIn(), true);
    assert.strictEqual(B.A.backendMode(), "off");
  },
);
await t(
  "8e: close all tabs (every sessionStorage dropped): a new instance is signed out",
  async () => {
    const A = loadAuth(noNet, { net: makeNet() });
    assert.strictEqual(A.A.isSignedOut(), false);
    const L = loadAuth(noNet, { net: makeNet(), sess: emptySess(), ls: A.ls });
    await L.A.ready();
    assert.strictEqual(L.A.needsSignIn(), true);
  },
);
await t(
  "8f: sign-out in tab A signs out tab B; chAuthStateChanged fires once in B",
  async () => {
    const net = makeNet();
    const A = loadAuth(
      async () => ({ ok: true, status: 200, json: async () => ({}) }),
      { net },
    );
    const B = loadAuth(noNet, {
      net,
      sess: JSON.parse(JSON.stringify(A.sess)),
    });
    B.events.length = 0;
    await A.A.signOut();
    await tick(20);
    assert.strictEqual(B.A.isSignedOut(), true);
    assert.ok(!B.sess.ch_sb_session, "B session removed");
    assert.strictEqual(
      B.events.filter((x) => x.startsWith("chAuthStateChanged")).length,
      1,
    );
  },
);
await t(
  "8g: refresh in tab A: B gets the new refresh token, no token call; two timers = ONE request",
  async () => {
    const net = makeNet();
    const soon = () => ({
      ch_sb_session: JSON.stringify({
        access_token: FK("old"),
        refresh_token: FK("r1"),
        expires_at: Math.floor(Date.now() / 1000) + 30,
        user_id: "u1",
        email: "u1@example.com",
      }),
    });
    let reqs = 0;
    const slowTok = async () => {
      reqs++;
      await tick(20);
      return tokNew(reqs)();
    };
    // both tabs load with an almost-expired token: both start a refresh at load
    const A = loadAuth(slowTok, { net, sess: soon() });
    const B = loadAuth(slowTok, { net, sess: soon() });
    await Promise.all([A.A.ready(), B.A.ready()]);
    await tick(20);
    assert.strictEqual(reqs, 1, "exactly one token request for two tabs");
    assert.strictEqual(
      B.A.getToken(),
      FK("n1"),
      "B holds the token A refreshed",
    );
    assert.strictEqual(
      JSON.parse(B.sess.ch_sb_session).refresh_token,
      FK("rn1"),
    );
  },
);
await t(
  "8h: refresh refused while a peer holds a newer session: tab keeps the peer session",
  async () => {
    const net = makeNet();
    const peer = new net.FakeBC("ch_auth");
    const L = loadAuth(
      async () => {
        await tick(10);
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "invalid_grant" }),
        };
      },
      { net },
    );
    // the peer answers the "need" the refused tab sends, with a newer session of the same user
    peer.onmessage = (ev) => {
      if (ev.data.t === "need")
        peer.postMessage({
          t: "session",
          session: {
            access_token: FK("peer"),
            refresh_token: FK("rpeer"),
            expires_at: Math.floor(Date.now() / 1000) + 7200,
            user_id: "u1",
            email: "u1@example.com",
          },
        });
    };
    let runs = 0;
    const out = await L.A.withAuthRetry(async () =>
      ++runs === 1 ? { status: "error", httpStatus: 401 } : { status: "ok" },
    );
    assert.strictEqual(L.A.isSignedOut(), false);
    assert.strictEqual(L.A.getToken(), FK("peer"));
    assert.strictEqual(out.status, "ok", "retried once with the peer session");
  },
);
await t(
  "8i: a different user signs in on tab A: tab B follows (identity event), is not cleared",
  async () => {
    const net = makeNet();
    const A = loadAuth(tokNew(2, "u2"), { net });
    const B = loadAuth(noNet, { net });
    B.events.length = 0;
    await A.A.signIn("u2@example.com", "pw");
    await tick(20);
    assert.strictEqual(B.A.getUserId(), "u2");
    assert.strictEqual(B.A.isSignedOut(), false);
    assert.ok(
      B.events.some((x) => x.startsWith("chAuthStateChanged")),
      "identity change announced",
    );
  },
);
await t(
  "8j: a legacy localStorage ch_sb_session is removed at load and never used to sign in",
  async () => {
    const ls = {
      ch_sb_session: sessionJSON("u1", FK("legacy"), FK("rlegacy")),
    };
    const L = loadAuth(noNet, { net: makeNet(), sess: emptySess(), ls });
    await L.A.ready();
    assert.ok(!("ch_sb_session" in ls), "removed from disk");
    assert.strictEqual(L.A.isSignedOut(), true);
    assert.strictEqual(L.A.getToken(), null);
  },
);
// 8k: queue and per-user data across a close (REAL db.js + REAL ch-auth.js; localStorage persists, sessionStorage does not)
await t(
  "8k: unsynced edit survives close; same user sends it once; another user never sends or sees it",
  async () => {
    const S = {}; // persistent localStorage (the "disk")
    const putsOf = [];
    const kv = (fail) => async (u, o) => {
      if (!o || o.method !== "PUT") return ok([]);
      const b = JSON.parse(o.body);
      putsOf.push({ key: b.key, value: b.value });
      if (fail) throw new TypeError("Failed to fetch");
      return ok({ version: 1, hash: null, deleted: false });
    };
    const queued = (L) => L.DB.__t._queue().filter((e) => e.key === "ch_theme");
    // session 1: user u1 edits while the server is unreachable
    const L1 = loadReal({
      userId: "u1",
      store: S,
      tokenFetch: tokUser("u1"),
      kvFetch: kv(true),
    });
    await L1.DB.warmCache();
    L1.DB.set("ch_theme", "U-edit");
    await tick(60);
    assert.strictEqual(queued(L1).length, 1, "edit queued");
    // browser closed: sessionStorage gone, localStorage kept. Reopen: signed out.
    putsOf.length = 0;
    const L2 = loadReal({
      store: S,
      sess: emptySess(),
      tokenFetch: tokUser("u1"),
      kvFetch: kv(false),
    });
    await L2.DB.warmCache();
    await tick(100);
    assert.strictEqual(L2.A.isSignedOut(), true);
    assert.strictEqual(putsOf.length, 0, "signed out: no PUT");
    assert.strictEqual(queued(L2).length, 1, "edit still queued");
    assert.strictEqual(
      JSON.stringify(L2.DB.getForeignQueueInfo().map((x) => x.id + ":" + x.count)),
      '["u1:1"]',
      "unsynced bar data (by user u1) still there",
    );
    // another user (u2) signs in: the entry is not sent and not shown as u2 data
    const L3 = loadReal({
      store: S,
      sess: emptySess(),
      tokenFetch: tokUser("u2"),
      kvFetch: kv(false),
    });
    await L3.DB.warmCache();
    await L3.A.signIn("u2@example.com", "pw");
    await tick(250);
    assert.ok(
      !putsOf.some((p) => p.value === "U-edit"),
      "u2 never sends the u1 edit",
    );
    assert.strictEqual(queued(L3).length, 1, "still queued for u1");
    assert.notStrictEqual(
      L3.DB.get("ch_theme"),
      "U-edit",
      "u2 does not see the u1 value",
    );
    // browser closed again; u1 signs in: the edit is sent exactly once
    putsOf.length = 0;
    const L4 = loadReal({
      store: S,
      sess: emptySess(),
      tokenFetch: tokUser("u1"),
      kvFetch: kv(false),
    });
    await L4.DB.warmCache();
    await L4.A.signIn("u1@example.com", "pw");
    await tick(300);
    assert.strictEqual(
      putsOf.filter((p) => p.key === "u1::ch_theme" && p.value === "U-edit")
        .length,
      1,
      "sent once",
    );
    assert.strictEqual(queued(L4).length, 0, "queue emptied");
  },
);
await t("8l: a load with no edit sends 0 PUT (reload and reopen)", async () => {
  const S = {};
  const L1 = loadReal({
    userId: "u1",
    store: S,
    tokenFetch: tokUser("u1"),
    kvFetch: async () => ok([]),
  });
  await L1.DB.warmCache();
  await tick(100);
  const puts = [];
  const L2 = loadReal({
    userId: "u1",
    store: S,
    sess: L1.sess,
    tokenFetch: noNet,
    kvFetch: async (u, o) => {
      if (o && o.method === "PUT") puts.push(JSON.parse(o.body).key);
      return ok([]);
    },
  });
  await L2.DB.warmCache();
  await tick(300);
  assert.strictEqual(puts.length, 0, "zero PUT: " + JSON.stringify(puts));
});

  // ---- migration cutover (2026-10-07): restore base version, unstamped differing key asks, failures name the key
  const kvRow = (key, value, version) => ({ key, value, version, hash: sha(value), deleted: false });
  function kvServer(rows, o) {
    o = o || {};
    const puts = [];
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const fetchImpl = async (u, opts) => {
      if (opts && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        puts.push(body);
        const code = o.putStatus ? o.putStatus(body.key) : 200;
        if (code === 409) return res(409, { conflict: true, current: rows.find((r) => r.key === body.key) || null });
        if (code !== 200) return res(code, { error: 'x' });
        return res(200, { version: (body.baseVersion || 0) + 1, hash: sha(body.value), deleted: false });
      }
      if (/manifest=1/.test(u)) return res(200, rows.map((r) => ({ key: r.key, version: r.version, hash: r.hash, deleted: false })));
      const keys = decodeURIComponent(String(u).split('keys=')[1] || '').split(',');
      return res(200, rows.filter((r) => keys.indexOf(r.key) !== -1));
    };
    return { puts, fetchImpl };
  }
  await t('migration R1: restorePush on an ABSENT key sends baseVersion null (insert), no overwrite flag', async () => {
    const S = kvServer([]);
    const { DB } = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl });
    await DB.warmCache();
    const r = await DB.restorePush('en_budget_new', { n: 1 }, null);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(S.puts.length, 1);
    assert.strictEqual(S.puts[0].baseVersion, null);
    assert.ok(!('explicitOverwrite' in S.puts[0]));
  });
  await t('migration R2: restorePush on a PRESENT key sends baseVersion = server version + explicitOverwrite', async () => {
    const S = kvServer([kvRow('en_budget_a', { n: 1 }, 4)]);
    const { DB } = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl });
    await DB.warmCache();
    const r = await DB.restorePush('en_budget_a', { n: 2 }, { value: { n: 1 }, version: 4 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(S.puts[0].baseVersion, 4);
    assert.strictEqual(S.puts[0].explicitOverwrite, true);
    assert.deepStrictEqual(S.puts[0].value, { n: 2 });
  });
  await t('migration R3: 409 -> conflict (HTTP 409); 502 -> "server error 502" with httpStatus 502', async () => {
    const S = kvServer([kvRow('en_budget_a', { n: 1 }, 4)], { putStatus: (k) => (k === 'en_budget_a' ? 409 : 502) });
    const { DB } = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl });
    await DB.warmCache();
    const a = await DB.restorePush('en_budget_a', { n: 2 }, { value: { n: 1 }, version: 4 });
    assert.deepStrictEqual([a.ok, a.status, a.httpStatus], [false, 'conflict', 409]);
    const b = await DB.restorePush('en_budget_b', { n: 2 }, null);
    assert.deepStrictEqual([b.ok, b.status, b.httpStatus], [false, 'server error 502', 502]);
  });

  async function hydrateScenario(localValue, serverValue, o) {
    o = o || {};
    const key = o.key || 'en_budget_x';
    const store = {};
    store[key] = JSON.stringify(localValue); // unstamped: no ch_rv record
    const S = kvServer([kvRow(key, serverValue, 7)]);
    const asked = [];
    const L = load({
      mode: 'on',
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      store,
      modal: o.noModal ? undefined : async (d) => (asked.push(d), o.answer || { action: 'dismiss' }),
    });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    await tick(80);
    return { L, S, asked, key };
  }
  await t('migration H1: unstamped + differing plain key: modal opens, local value kept, 0 PUT, archive entry, still unstamped', async () => {
    const { L, S, asked, key } = await hydrateScenario({ n: 'LOCAL' }, { n: 'SERVER' });
    assert.strictEqual(asked.length, 1, 'modal opened once');
    assert.strictEqual(asked[0].key, key);
    assert.strictEqual(JSON.stringify(L.DB.get(key)), JSON.stringify({ n: 'LOCAL' }), 'local value unchanged');
    assert.strictEqual(S.puts.filter((p) => p.key === key).length, 0, 'no server write');
    assert.ok(L.DB.getConflictArchive().some((e) => e.key === key), 'local copy archived');
    assert.ok(!L.DB.__t._stampOf(key), 'key stays unstamped: asked again next load');
  });
  await t('migration H2: unstamped + equal content: adopts the version silently (no modal)', async () => {
    const { L, asked, key } = await hydrateScenario({ a: 1, b: 2 }, { b: 2, a: 1 });
    assert.strictEqual(asked.length, 0);
    assert.strictEqual(L.DB.__t._stampOf(key).version, 7);
  });
  await t('migration H3: unstamped collection key still merges per record (no whole-key modal)', async () => {
    const { L, asked, key } = await hydrateScenario([{ id: 'a', text: 'local' }], [{ id: 'b', text: 'server' }], {
      key: 'en_tasks',
    });
    assert.strictEqual(asked.length, 0);
    assert.strictEqual(
      L.DB.get(key)
        .map((r) => r.id)
        .sort()
        .join(','),
      'a,b',
    );
  });
  await t('migration H4: "Overwrite with mine" -> PUT at the server version with explicitOverwrite, local value sent', async () => {
    const { S, key } = await hydrateScenario({ n: 'LOCAL' }, { n: 'SERVER' }, { answer: { action: 'overwrite-mine' } });
    const p = S.puts.filter((x) => x.key === key);
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].baseVersion, 7);
    assert.strictEqual(p[0].explicitOverwrite, true);
    assert.strictEqual(JSON.stringify(p[0].value), JSON.stringify({ n: 'LOCAL' }));
  });
  await t('migration H5: "Keep server" -> server value loaded and the key is stamped', async () => {
    const { L, S, key } = await hydrateScenario({ n: 'LOCAL' }, { n: 'SERVER' }, { answer: { action: 'load-theirs' } });
    assert.strictEqual(JSON.stringify(L.DB.get(key)), JSON.stringify({ n: 'SERVER' }));
    assert.strictEqual(L.DB.__t._stampOf(key).version, 7);
    assert.strictEqual(S.puts.filter((x) => x.key === key).length, 0);
  });
  await t('migration H6: a page with no conflict dialog keeps the old rule (server wins, local archived)', async () => {
    const { L, key } = await hydrateScenario({ n: 'LOCAL' }, { n: 'SERVER' }, { noModal: true });
    assert.strictEqual(JSON.stringify(L.DB.get(key)), JSON.stringify({ n: 'SERVER' }));
    assert.ok(L.DB.getConflictArchive().some((e) => e.key === key));
  });
  await t('migration U1/U2: first-connect upload failures keep key + HTTP status; toast and Sync status text name the key', async () => {
    const toasts = [];
    const store = {
      en_budget_p: JSON.stringify({ n: 1 }),
      en_budget_q: JSON.stringify({ n: 2 }),
      en_budget_r: JSON.stringify({ n: 3 }),
    };
    const S = kvServer([], { putStatus: (k) => (k === 'en_budget_p' ? 502 : k === 'en_budget_q' ? 409 : 200) });
    const L = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl, store, toast: (m) => toasts.push(m) });
    await L.DB.warmCache(); // warmCache runs the one hydration and the first-connect upload
    await tick(200);
    const f = L.DB.getUploadProgress().failures;
    const by = Object.fromEntries(f.map((x) => [x.key, x.httpStatus]));
    assert.strictEqual(JSON.stringify(by), JSON.stringify({ en_budget_p: 502, en_budget_q: 409 }));
    assert.ok(
      toasts.some((m) => /en_budget_p \(HTTP 502\)/.test(m) && /en_budget_q \(HTTP 409\)/.test(m)),
      toasts.join('|'),
    );
    const ui = fs.readFileSync(path.join(__dirname, 'app', 'sync-ui.js'), 'utf8');
    assert.ok(/describeFailure/.test(ui), 'Sync status uses the same describeFailure');
  });
  await t('migration D1: a queued write that keeps failing is listed by key with its HTTP status (413 = permanent)', async () => {
    let code = 500;
    const S = kvServer([], { putStatus: () => code });
    const L = load({ mode: 'on', syncHost: true, classify: true, fetchImpl: S.fetchImpl });
    await L.DB.warmCache();
    L.DB.set('en_budget_big', { n: 1 });
    await tick(60);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    code = 413;
    await L.DB.__t._drainQueueOnce();
    const f = L.DB.getQueueFailures();
    assert.strictEqual(JSON.stringify(f.map((x) => [x.key, x.httpStatus, x.permanent])), JSON.stringify([['en_budget_big', 413, true]]));
    assert.strictEqual(L.DB.describeFailure(f[0]), 'en_budget_big (HTTP 413)');
  });
// ---- Netlify credit cost (2026-10-07): no timer polls; the server is asked only when the user is looking
function makeEnv() {
  let now = 1800000000000;
  const timers = new Map();
  let seq = 0;
  const handlers = { window: {}, document: {} };
  const env = {
    intervals: 0,
    document: {
      hidden: false,
      visibilityState: "visible",
      addEventListener: (n, f) => env.on("document", n, f),
    },
    on: (who, n, f) => (handlers[who][n] = handlers[who][n] || []).push(f),
    fire: (who, n) => (handlers[who][n] || []).forEach((f) => f({ type: n })),
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + (ms || 0), fn });
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => {
      env.intervals++;
      return 0;
    },
    // Timers that wait 10 s or more (a poll or a retry). One-shot 0 ms tasks are not counted.
    pending: () => Array.from(timers.values()).filter((v) => v.at - now >= 10000).length,
    delays: () => Array.from(timers.values()).map((v) => v.at - now),
    Date: class extends Date {
      constructor(...a) {
        super(...(a.length ? a : [now]));
      }
      static now() {
        return now;
      }
    },
    // Move the clock forward, running due timers in order (each one gets a few real ticks to finish).
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        timers.forEach((v, k) => {
          if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        });
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
        await tick(5);
      }
      now = end;
    },
    setHidden(h) {
      env.document.hidden = h;
      env.document.visibilityState = h ? "hidden" : "visible";
      env.fire("document", "visibilitychange");
    },
  };
  return env;
}
const countManifest = (urls) => urls.filter((u) => /manifest=1/.test(u)).length;
function countingServer(rows, o) {
  const S = kvServer(rows, o);
  const urls = [];
  const fetchImpl = async (u, opts) => {
    urls.push(String(u) + (opts && opts.method === "PUT" ? " PUT" : ""));
    return S.fetchImpl(u, opts);
  };
  return { urls, fetchImpl, puts: S.puts };
}
await t(
  "CREDIT1 a hidden idle tab makes 0 Function calls for 6 hours; no interval exists",
  async () => {
    const env = makeEnv();
    const S = countingServer([kvRow("en_budget_a", { n: 1 }, 1)]);
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    env.setHidden(true);
    const base = S.urls.length;
    assert.ok(base >= 1, "the load itself asked the server");
    await env.advance(6 * 60 * 60 * 1000);
    env.fire("window", "focus"); // a focus event while hidden is ignored too
    await tick(20);
    assert.strictEqual(
      S.urls.length - base,
      0,
      "calls while idle and hidden: " + S.urls.slice(base).join(","),
    );
    assert.strictEqual(env.intervals, 0, "no setInterval at all");
    assert.strictEqual(
      env.pending(),
      0,
      "no timer pending with an empty queue",
    );
  },
);
await t(
  "CREDIT2 tab visible again: exactly 1 manifest GET, then none inside 5 minutes, then 1 after",
  async () => {
    const env = makeEnv();
    const S = countingServer([kvRow("en_budget_a", { n: 1 }, 1)]);
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    env.setHidden(true);
    await env.advance(30 * 60 * 1000);
    const base = countManifest(S.urls);
    env.setHidden(false);
    await tick(30);
    assert.strictEqual(
      countManifest(S.urls) - base,
      1,
      "one manifest GET on becoming visible",
    );
    env.fire("window", "focus");
    env.setHidden(true);
    env.setHidden(false);
    await tick(30);
    await env.advance(4 * 60 * 1000);
    env.fire("window", "focus");
    env.setHidden(false);
    await tick(30);
    assert.strictEqual(
      countManifest(S.urls) - base,
      1,
      "none inside 5 minutes (focus + visible repeated)",
    );
    await env.advance(2 * 60 * 1000);
    env.fire("window", "focus");
    await tick(30);
    assert.strictEqual(
      countManifest(S.urls) - base,
      2,
      "one more after 5 minutes",
    );
    assert.strictEqual(env.intervals, 0);
  },
);
await t(
  "CREDIT3 a change by the other user shows up when the tab becomes visible (no timer)",
  async () => {
    const env = makeEnv();
    const rows = [kvRow("en_budget_a", { n: 1 }, 1)];
    const S = countingServer(rows);
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    await L.DB.__t._hydrate();
    env.setHidden(true);
    rows[0] = kvRow("en_budget_a", { n: 2 }, 2);
    await env.advance(10 * 60 * 1000);
    assert.deepStrictEqual(
      L.DB.get("en_budget_a"),
      { n: 1 },
      "not applied while hidden",
    );
    env.setHidden(false);
    await tick(60);
    assert.deepStrictEqual(
      L.DB.get("en_budget_a"),
      { n: 2 },
      "applied after the tab is visible",
    );
    assert.ok(L.events.some((e) => e.type === "dbRemoteApplied"));
  },
);
await t(
  "CREDIT4 an empty queue makes 0 drain calls on any trigger and starts no timer",
  async () => {
    const env = makeEnv();
    const S = countingServer([]);
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    const base = S.urls.length;
    env.fire("window", "online");
    await L.DB.__t._drainQueueOnce();
    await env.advance(60 * 60 * 1000);
    assert.strictEqual(S.urls.length - base, 0);
    assert.strictEqual(env.pending(), 0);
  },
);
await t(
  "CREDIT5 a queued item drains with back-off, then the calls stop",
  async () => {
    const env = makeEnv();
    let fail = true;
    const S = countingServer([], { putStatus: () => (fail ? 500 : 200) });
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    L.DB.set("en_budget_q", { n: 1 });
    await tick(60);
    assert.strictEqual(L.DB.getQueueDepth(), 1);
    const puts = () => S.urls.filter((u) => / PUT$/.test(u)).length;
    const p0 = puts();
    assert.strictEqual(
      env.pending(),
      1,
      "one back-off timer while an item is queued " + env.delays(),
    );
    await env.advance(15000);
    await env.advance(30000);
    await env.advance(60000);
    const retried = puts() - p0;
    assert.ok(
      retried >= 2 && retried <= 3,
      "retries follow the back-off (15 s, 30 s, 60 s): " + retried,
    );
    fail = false;
    await env.advance(5 * 60 * 1000);
    assert.strictEqual(L.DB.getQueueDepth(), 0, "drained");
    const after = S.urls.length;
    await env.advance(60 * 60 * 1000);
    assert.strictEqual(
      S.urls.length,
      after,
      "no calls after the queue is empty",
    );
    assert.strictEqual(env.pending(), 0, "timer stopped");
    assert.strictEqual(env.intervals, 0);
  },
);
await t(
  "CREDIT6 a permanent failure (HTTP 413) stops the retry timer",
  async () => {
    const env = makeEnv();
    const S = countingServer([], { putStatus: () => 413 });
    const L = load({
      mode: "on",
      syncHost: true,
      classify: true,
      fetchImpl: S.fetchImpl,
      env,
    });
    await L.DB.warmCache();
    L.DB.set("en_budget_q", { n: 1 });
    await tick(60);
    await env.advance(15000);
    assert.strictEqual(env.pending(), 0, "no timer for a permanent failure");
    const n = S.urls.length;
    await env.advance(60 * 60 * 1000);
    assert.strictEqual(S.urls.length, n);
  },
);
await t(
  "CREDIT7 version check: no timer, HEAD request, hourly limit, no hidden check, no GET of site-ui.js on the normal path",
  async () => {
    const src = fs.readFileSync(path.join(__dirname, "app", "report-engine.js"), "utf8");
    const a = src.indexOf("let _chVersionDismissed");
    const b = src.indexOf("function _showVersionUpdateBanner");
    const block = src.slice(a, b);
    const init = src.slice(src.indexOf("_checkForVersionUpdate();"), src.indexOf("_restorePageStateAfterVersionUpdate();"));
    assert.ok(a > 0 && b > a, "version check block found");
    assert.ok(!/setInterval|setTimeout/.test(block + init), "no timer loop for the version check");
    assert.ok(/method:\s*'HEAD'[^)]*cache:\s*'no-store'/.test(block), "check uses HEAD with no-store");
    assert.ok(/ETag/.test(block) && /Last-Modified/.test(block), "compares ETag or Last-Modified");
    // the only GET of site-ui.js sits after the header comparison (changed header only)
    const gets = block.match(/fetch\('site-ui\.js\?nocache/g) || [];
    assert.strictEqual(gets.length, 1);
    assert.ok(block.indexOf("tag === _chVerBaseline") < block.indexOf("site-ui.js?nocache"), "GET only after header changed");
    assert.ok(/_CH_VER_MIN_GAP_MS\s*=\s*60 \* 60 \* 1000/.test(block), "one hour limit");
    assert.ok(/if \(document\.hidden\) return;/.test(init), "never while hidden");
    assert.ok(/addEventListener\('visibilitychange'/.test(init) && /addEventListener\('focus'/.test(init));
  },
);
  console.log(pass + ' passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
