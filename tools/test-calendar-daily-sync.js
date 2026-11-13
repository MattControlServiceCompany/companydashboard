'use strict';
// Tests for the daily calendar update (scripts/calendar-daily-sync.js). Synthetic feed, in-memory fake of the database
// REST API. No network, no real data, no client names.
// Run: node tools/test-calendar-daily-sync.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CD = require(path.join(ROOT, 'app/calendar-diff.js'));
const SA = require(path.join(ROOT, 'computations/sched-actions.js'));
const CS = require(path.join(ROOT, 'computations/calendar-sync.js'));
const BAL = require(path.join(ROOT, 'app/bas-audit-log.js'));
const { canonicalJSON, sha256Hex } = require(path.join(ROOT, 'netlify/lib/kv-hash.js'));
const daily = require(path.join(ROOT, 'scripts/calendar-daily-sync.js'));

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL ' + name + ' -> ' + (e && e.message));
  }
}

const FEED_URL = 'https://calendar.google.com/' + 'calendar/ical/example.test_fake/public/basic.ics';
const SECRET = 'test-secret-value-123';
const NOW = new Date('2026-11-13T11:00:00Z');
const PID = '1';
const K = (kind) => kind + PID;

// --- synthetic feed ------------------------------------------------------------------------------
function vevent(e) {
  return ['BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:20260101T000000Z', 'DTSTART:' + e.start, 'DTEND:' + e.end, 'SUMMARY:' + e.title, 'LOCATION:' + (e.location || ''), 'SEQUENCE:0', 'END:VEVENT'].join('\r\n');
}
const ics = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Test//EN', ...events.map(vevent), 'END:VCALENDAR', ''].join('\r\n');
const ev = (n, over) => Object.assign({ uid: 'evt-00' + n + '@example.test', title: 'Example Event ' + n, start: '2026112' + n + 'T150000Z', end: '2026112' + n + 'T160000Z', location: 'Room ' + n }, over || {});
const FEED_V0 = [ev(1), ev(2), ev(3)];
// v1: event 1 canceled (removed), event 2 moved to another room, event 4 added.
const FEED_V1 = [ev(2, { location: 'Room 9' }), ev(3), ev(4)];

// --- fake database (the REST calls the script makes) ---------------------------------------------
function makeServer(feedRef) {
  const srv = { kv: {}, hist: [], calls: [], feedCalls: 0, hooks: { beforePatch: null }, patches: 0 };
  srv.put = (key, value, by) => {
    const old = srv.kv[key];
    srv.kv[key] = { key, value: JSON.parse(JSON.stringify(value)), version: old ? old.version + 1 : 1, hash: sha256Hex(canonicalJSON(value)), deleted: false, updated_by: by || 'someone', updated_at: '2026-11-12T00:00:00Z' };
  };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) });
  srv.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url);
    if (u.hostname === 'calendar.google.com') {
      srv.feedCalls++;
      if (feedRef.fail) return { status: 500, ok: false, headers: { get: () => null }, body: null, text: async () => '' };
      return { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => ics(feedRef.events) };
    }
    assert.ok(init.headers && init.headers.apikey === SECRET, 'the key is sent');
    const rel = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const q = u.searchParams;
    const method = init.method || 'GET';
    srv.calls.push(method + ' ' + rel + (q.get('key') ? ' ' + q.get('key') : ''));
    const body = init.body ? JSON.parse(init.body) : null;
    if (rel === 'kv' && method === 'GET') {
      let rows = Object.values(srv.kv);
      const kf = q.get('key');
      if (kf && kf.startsWith('in.(')) {
        const ks = kf.slice(4, -1).split(',');
        rows = rows.filter((r) => ks.includes(r.key));
      } else if (kf && kf.startsWith('like.')) {
        const re = new RegExp('^' + kf.slice(5).replace(/\*/g, '.*'));
        rows = rows.filter((r) => re.test(r.key));
      }
      if (q.get('deleted') === 'eq.false') rows = rows.filter((r) => !r.deleted);
      return json(200, rows);
    }
    if (rel === 'kv' && method === 'POST') {
      const r = body[0];
      if (srv.kv[r.key]) return json(409, {});
      srv.kv[r.key] = Object.assign({}, r);
      return json(201, []);
    }
    if (rel === 'kv' && method === 'PATCH') {
      srv.patches++;
      if (srv.hooks.beforePatch) srv.hooks.beforePatch(q.get('key').slice(3), srv);
      const key = q.get('key').slice(3);
      const ver = Number(q.get('version').slice(3));
      const row = srv.kv[key];
      if (!row || row.version !== ver) return json(200, []);
      Object.assign(row, body);
      return json(200, [row]);
    }
    if (rel === 'kv_history' && method === 'GET') {
      const key = q.get('key').slice(3);
      const ver = Number(q.get('version').slice(3));
      return json(200, srv.hist.filter((h) => h.key === key && h.version === ver).map((h) => ({ id: 1 })));
    }
    if (rel === 'kv_history' && method === 'POST') {
      srv.hist.push(body[0]);
      return json(201, []);
    }
    throw new Error('unexpected call ' + method + ' ' + rel);
  };
  return srv;
}

// The saved state before the update: a copy of FEED_V0, an open action for event 1, empty history lists.
async function seed(srv, buildSnapshot) {
  const snap0 = await buildSnapshot({ icsUrl: FEED_URL, timezone: 'America/Chicago' }, { fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => ics(FEED_V0) }), now: new Date('2026-11-12T11:00:00Z') });
  srv.put('en_projects', [{ id: 1, name: 'Example Project', districtCalendar: [] }], 'seed');
  srv.put(K('en_cal_cfg_'), { icsUrl: FEED_URL, timezone: 'America/Chicago' }, 'seed');
  srv.put(K('en_cal_snap_'), snap0, 'seed');
  srv.put(K('en_cal_hist_'), [], 'seed');
  const e1 = snap0.events['evt-001@example.test'];
  srv.put(K('en_sched_actions_'), { actions: { 'evt-001@example.test': { id: 'evt-001@example.test', date: '2026-11-21', text: 'Example action', program: 'AHU-1', eventIds: ['evt-001@example.test'], status: 'open', openedAt: '2026-11-12T00:00:00Z', note: '' } } }, 'seed');
  srv.put(K('en_bas_acthist_'), [], 'seed');
  assert.ok(e1, 'seed event exists');
  return snap0;
}

const CAL_KEYS = ['en_cal_hist_', 'en_cal_snap_', 'en_sched_actions_', 'en_bas_acthist_'].map(K);

(async () => {
  const { buildSnapshot } = await import(require('url').pathToFileURL(path.join(ROOT, 'netlify/functions/lib/calendar/snapshot.mjs')).href);
  const run = (srv, over) => {
    const logs = [];
    return daily.run(Object.assign({ store: daily.remoteStore('https://db.example.test', SECRET, srv.fetch), now: NOW, fetchImpl: srv.fetch, log: (m) => logs.push(m) }, over || {})).then((r) => Object.assign(r, { logs }));
  };

  await t('run 1: changed feed writes the 4 calendar keys, each version + 1, with a history row of the replaced copy', async () => {
    const feed = { events: FEED_V1 };
    const srv = makeServer(feed);
    await seed(srv, buildSnapshot);
    const before = JSON.parse(JSON.stringify(srv.kv));
    const r = await run(srv);
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.results[0].status, 'written');
    assert.deepStrictEqual(r.results[0].counts, { added: 1, removed: 1, changed: 1, unchanged: 1, total: 3 });
    CAL_KEYS.forEach((k) => {
      assert.strictEqual(srv.kv[k].version, before[k].version + 1, k + ' version');
      assert.strictEqual(srv.kv[k].updated_by, 'daily-calendar-sync');
      assert.strictEqual(srv.kv[k].hash, sha256Hex(canonicalJSON(srv.kv[k].value)), k + ' hash');
      const h = srv.hist.filter((x) => x.key === k);
      assert.strictEqual(h.length, 1, k + ' one history row');
      assert.strictEqual(h[0].version, before[k].version);
      assert.deepStrictEqual(h[0].value, before[k].value, k + ' history row holds the replaced copy');
    });
    assert.strictEqual(srv.kv[K('en_cal_snap_')].value.fetchedAt, NOW.toISOString());
    assert.strictEqual(srv.kv[K('en_sched_actions_')].value.actions['evt-001@example.test'].status, 'closed', 'the action of the removed event is closed');
    assert.strictEqual(srv.kv.en_projects.version, before.en_projects.version, 'no other key is written');
    assert.ok(r.logs.join('\n').indexOf('read back OK') >= 0);
  });

  await t('run 2: the same feed again writes nothing', async () => {
    const srv = makeServer({ events: FEED_V1 });
    await seed(srv, buildSnapshot);
    await run(srv);
    const kvAfter1 = JSON.stringify(srv.kv);
    const histAfter1 = srv.hist.length;
    const r2 = await run(srv, { now: new Date('2026-11-14T11:00:00Z') });
    assert.strictEqual(r2.results[0].status, 'no-change');
    assert.strictEqual(JSON.stringify(srv.kv), kvAfter1, 'no row changed');
    assert.strictEqual(srv.hist.length, histAfter1, 'no history row added');
    assert.ok(r2.logs.join('\n').indexOf('no change') >= 0, 'logs "no change"');
  });

  await t('dry run writes nothing and prints the plan', async () => {
    const srv = makeServer({ events: FEED_V1 });
    await seed(srv, buildSnapshot);
    const before = JSON.stringify(srv.kv);
    const r = await run(srv, { dryRun: true });
    assert.strictEqual(r.results[0].status, 'dry-run');
    assert.strictEqual(JSON.stringify(srv.kv), before);
    assert.strictEqual(srv.hist.length, 0);
    assert.ok(!srv.calls.some((c) => /^(PATCH|POST)/.test(c)), 'no write call');
    assert.ok(/v1 -> v2/.test(r.logs.join('\n')));
  });

  await t('same input, same result as the page: pcalSync and the script save the same four values', async () => {
    const srv = makeServer({ events: FEED_V1 });
    const snap0 = await seed(srv, buildSnapshot);
    const store = {};
    Object.keys(srv.kv).forEach((k) => (store[k] = JSON.parse(JSON.stringify(srv.kv[k].value))));
    const snapNew = await buildSnapshot({ icsUrl: FEED_URL, timezone: 'America/Chicago' }, { fetchImpl: srv.fetch, now: NOW });
    // The page: the real project-calendar.js and sched-actions.js in a sandbox; the feed read is answered with the same snapshot.
    const els = {};
    const win = { CH_AUTH: { getToken: () => 'tok' }, addEventListener() {} };
    const ctx = {
      window: win, CalendarDiff: CD, CalendarSync: CS, SchedActions: SA, BasAuditLog: BAL, console, Date, Math, JSON, Object, Array, Promise, Intl, isNaN, Number, String, parseInt, parseFloat, setTimeout,
      _escHtml: (x) => String(x),
      document: { getElementById: (id) => (els[id] = els[id] || { innerHTML: '', textContent: '', value: '', style: {} }), createElement: () => ({ style: {}, setAttribute() {} }), head: { appendChild() {} }, querySelector: () => null },
      DB: { get: (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapNew }) }),
    };
    win.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/project-calendar.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/sched-actions.js'), 'utf8'), ctx);
    await win.pcalSync(1);
    const r = await run(srv);
    assert.strictEqual(r.results[0].status, 'written');
    // Ids and the clock stamps differ by run; every other byte must be equal.
    const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (['at', 'openedAt', 'closedAt'].includes(k) ? 'T' : typeof x === 'string' && /^(calh_|bash_)/.test(x) ? 'ID' : x)));
    CAL_KEYS.forEach((k) => assert.deepStrictEqual(clean(srv.kv[k].value), clean(store[k]), k + ' is the same from the page and from the script'));
    assert.ok(snap0);
  });

  await t('a version conflict once: read again, retry, written; a newer row is never overwritten', async () => {
    const srv = makeServer({ events: FEED_V1 });
    await seed(srv, buildSnapshot);
    let done = false;
    srv.hooks.beforePatch = (key, s) => {
      if (done) return;
      done = true;
      s.put(K('en_cal_hist_'), [{ id: 'calh_other', at: 'x', counts: { added: 0, removed: 0, changed: 0, unchanged: 1, total: 1 }, added: [], removed: [], changed: [] }], 'other-user'); // another writer saves first
    };
    const r = await run(srv);
    assert.strictEqual(r.exitCode, 0, r.logs.join('\n'));
    assert.strictEqual(r.results[0].status, 'written');
    const hist = srv.kv[K('en_cal_hist_')].value;
    assert.ok(hist.some((x) => x.id === 'calh_other'), 'the other writer record is kept in the new list');
    assert.strictEqual(srv.kv[K('en_cal_hist_')].version, 3);
  });

  await t('a conflict that stays: stop with exit 2, the newer row is not overwritten', async () => {
    const srv = makeServer({ events: FEED_V1 });
    await seed(srv, buildSnapshot);
    let n = 0;
    srv.hooks.beforePatch = (key, s) => {
      if (key === K('en_cal_hist_')) s.put(K('en_cal_hist_'), [{ id: 'calh_other' + ++n }], 'other-user');
    };
    const r = await run(srv);
    assert.strictEqual(r.exitCode, 2);
    assert.strictEqual(r.results[0].status, 'conflict');
    assert.strictEqual(srv.kv[K('en_cal_hist_')].updated_by, 'other-user');
    assert.ok(srv.kv[K('en_cal_hist_')].value[0].id.startsWith('calh_other'));
    assert.strictEqual(srv.kv[K('en_cal_snap_')].version, 1, 'the copy was not written');
  });

  await t('a feed error writes nothing, exits 1, and the log has no feed address', async () => {
    const srv = makeServer({ events: FEED_V1, fail: true });
    await seed(srv, buildSnapshot);
    const before = JSON.stringify(srv.kv);
    const r = await run(srv);
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(JSON.stringify(srv.kv), before);
    assert.ok(!/example\.test_fake|calendar\.google/.test(r.logs.join('\n')));
  });

  await t('no log line holds the key or the feed address', async () => {
    const srv = makeServer({ events: FEED_V1 });
    await seed(srv, buildSnapshot);
    const r = await run(srv);
    const text = r.logs.join('\n');
    assert.ok(text.indexOf(SECRET) < 0 && !/example\.test_fake/.test(text));
  });

  await t('one source of truth: the script and kv-sync use the shared hash, the script has no copy of the diff or action rules', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/calendar-daily-sync.js'), 'utf8');
    const kvsync = fs.readFileSync(path.join(ROOT, 'netlify/functions/kv-sync.js'), 'utf8');
    assert.ok(/require\('\.\.\/lib\/kv-hash'\)/.test(kvsync) && !/function sha256Hex/.test(kvsync));
    assert.ok(/netlify\/lib\/kv-hash\.js/.test(script));
    assert.ok(!/diffSnapshots\(|historyRecord\(|reconcile\(/.test(script.replace(/\/\/.*$/gm, '')), 'no diff, history or action rule in the script');
    const page = fs.readFileSync(path.join(ROOT, 'app/project-calendar.js'), 'utf8');
    assert.ok(/CalendarSync\.historyRecord/.test(page) && !/CalendarDiff\.historyRecord/.test(page));
  });

  await t('stale rule: older than 26 hours is stale; fresh, missing copy and no feed are not', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    const at = (h) => ({ fetchedAt: new Date(now - h * 3600e3).toISOString() });
    assert.strictEqual(CD.isStale({ snap: at(25.9), nowMs: now }), false);
    assert.strictEqual(CD.isStale({ snap: at(26.1), nowMs: now }), true);
    assert.strictEqual(CD.isStale({ snap: null, nowMs: now }), false);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
