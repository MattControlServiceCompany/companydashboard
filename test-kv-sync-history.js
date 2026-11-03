'use strict';
// Synthetic test: kv-sync.js keeps the previous value in kv_history on every changing write.
// No network: global fetch is an in-memory fake of the Supabase REST calls; jose is stubbed.
const assert = require('assert');
const Module = require('module');
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SECRET_KEY = 'test-key';
process.env.AUTHORIZED_USERS = 'tester@example.invalid';
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'jose') return { jwtVerify: async () => ({ payload: { email: 'tester@example.invalid' } }), createRemoteJWKSet: () => ({}) };
  return origLoad.call(this, req, ...a);
};
const { handler } = require('./netlify/functions/kv-sync.js');

const db = { kv: [], kv_history: [], nextId: 1 };
const jr = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const m = (opts.method || 'GET').toUpperCase();
  const q = (n) => u.searchParams.get(n);
  const eq = (n) => (q(n) || '').replace(/^eq\./, '');
  let rows = db[table];
  const match = (r) => ['key', 'version'].every((c) => q(c) === null || !/^eq\./.test(q(c)) || String(r[c]) === eq(c));
  if (m === 'GET') {
    let out = rows.filter(match);
    if (q('order') === 'replaced_at.desc') out = out.slice().sort((a, b) => b.replaced_at.localeCompare(a.replaced_at));
    if (q('offset')) out = out.slice(Number(q('offset')));
    if (q('limit')) out = out.slice(0, Number(q('limit')));
    return jr(200, JSON.parse(JSON.stringify(out)));
  }
  if (m === 'POST') {
    const body = JSON.parse(opts.body);
    for (const r of body) { if (table === 'kv_history') r.id = db.nextId++; rows.push(r); }
    return jr(201, body);
  }
  if (m === 'PATCH') {
    const hit = rows.filter(match);
    hit.forEach((r) => Object.assign(r, JSON.parse(opts.body)));
    return jr(200, JSON.parse(JSON.stringify(hit)));
  }
  if (m === 'DELETE') {
    const idq = q('id'); const rq = q('replaced_at');
    db[table] = rows.filter((r) => {
      if (idq && idq.startsWith('in.(')) return !idq.slice(4, -1).split(',').includes(String(r.id));
      if (rq && rq.startsWith('lt.')) return !(r.replaced_at < rq.slice(3));
      return true;
    });
    return jr(204, []);
  }
  throw new Error('unexpected ' + m + ' ' + url);
};

const put = (body) => handler({ httpMethod: 'PUT', headers: { authorization: 'Bearer fake' }, body: JSON.stringify(body) });
const get = (k) => handler({ httpMethod: 'GET', headers: { authorization: 'Bearer fake' }, queryStringParameters: { key: k } });
const hist = (k) => db.kv_history.filter((r) => r.key === k);
(async () => {
  const K = 'en_fake_proj_1';
  let r = await put({ key: K, value: { a: 1 }, baseVersion: null });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(hist(K).length, 0, 'a new key has no previous value');

  r = await put({ key: K, value: { a: 2 }, baseVersion: 1 });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(hist(K).length, 1, 'normal PUT keeps the previous value');
  assert.deepStrictEqual(hist(K)[0].value, { a: 1 });
  assert.strictEqual(hist(K)[0].version, 1);
  assert.strictEqual(hist(K)[0].updated_by, 'tester@example.invalid · unknown (old page)', 'history copies the stored writer text');
  assert.ok(hist(K)[0].replaced_at);

  // save cause: stored in updated_by as "<account> . <cause>", no new column; a missing cause never fails the save
  r = await put({ key: K + '-c', value: { a: 1 }, baseVersion: null, cause: 'Projects: Save' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(db.kv.find((x) => x.key === K + '-c').updated_by, 'tester@example.invalid · Projects: Save');
  assert.ok(!('updated_cause' in db.kv.find((x) => x.key === K + '-c')), 'no new column is written');
  r = await put({ key: K + '-c', value: { a: 2 }, baseVersion: 1, cause: 'auto: test' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(hist(K + '-c')[0].updated_by, 'tester@example.invalid · Projects: Save', 'history keeps the cause of the replaced version');
  r = await put({ key: K + '-c', value: { a: 3 }, baseVersion: 2, cause: 12345 });
  assert.strictEqual(r.statusCode, 200, 'a non-text cause is not refused');
  r = await get(K + '-c');
  const g = JSON.parse(r.body);
  assert.strictEqual(g.updatedBy, 'tester@example.invalid', 'GET returns the plain account in updatedBy');
  assert.strictEqual(g.updatedCause, 'unknown (old page)');
  r = await put({ key: K + '-c', value: { a: 4 }, baseVersion: 1, cause: 'x' });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(JSON.parse(r.body).current.updatedBy, 'tester@example.invalid', 'the 409 body returns the plain account');

  r = await put({ key: K, value: { a: 2 }, baseVersion: 2 });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(hist(K).length, 1, 'equal value adds no history row');

  r = await put({ key: K, value: { a: 2 }, baseVersion: 1 });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(hist(K).length, 1, 'stale write adds no row');

  r = await put({ key: K, deleted: true, baseVersion: 3 });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(hist(K).length, 2, 'delete keeps the previous value');
  assert.deepStrictEqual(hist(K)[1].value, { a: 2 });

  // history insert fails -> write refused, row unchanged
  const realFetch = global.fetch;
  global.fetch = async (u, o) => (String(u).includes('/kv_history') && o && o.method === 'POST' ? jr(500, {}) : realFetch(u, o));
  const before = JSON.stringify(db.kv);
  r = await put({ key: K, value: { a: 9 }, baseVersion: 4 });
  global.fetch = realFetch;
  assert.strictEqual(r.statusCode, 502);
  assert.strictEqual(JSON.stringify(db.kv), before, 'refused write leaves the row alone');

  // retention: count cap 20, size cap 5, age cap 30 days
  const day = 86400000;
  db.kv_history.length = 0;
  for (let i = 0; i < 25; i++) db.kv_history.push({ id: db.nextId++, key: K, value: { i }, version: 100 + i, updated_by: 'x', replaced_at: new Date(Date.now() - (i + 1) * 1000).toISOString() });
  db.kv_history.push({ id: db.nextId++, key: 'en_fake_other', value: {}, version: 1, updated_by: 'x', replaced_at: new Date(Date.now() - 40 * day).toISOString() });
  const cur = db.kv.find((x) => x.key === K);
  r = await put({ key: K, value: { a: 10 }, baseVersion: cur.version });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(hist(K).length <= 20, 'count cap: ' + hist(K).length);
  assert.strictEqual(hist('en_fake_other').length, 0, 'age cap removes rows older than 30 days');

  const L = 'en_fake_large';
  const big = { blob: 'x'.repeat(1100000) };
  await put({ key: L, value: big, baseVersion: null });
  for (let i = 0; i < 8; i++) {
    const v = db.kv.find((x) => x.key === L).version;
    await put({ key: L, value: Object.assign({ n: i }, big), baseVersion: v });
  }
  assert.strictEqual(hist(L).length, 5, 'large value keeps 5: ' + hist(L).length);
  // Trim requests: none when no snapshot row was inserted, some when one was.
  const trimCalls = [];
  const f0 = global.fetch;
  global.fetch = async (u, o = {}) => {
    const m = (o.method || 'GET').toUpperCase();
    if (String(u).includes('/kv_history') && (m === 'DELETE' || String(u).includes('offset='))) trimCalls.push(m + ' ' + u);
    return f0(u, o);
  };
  const T = 'en_fake_trim';
  await put({ key: T, value: { a: 1 }, baseVersion: null });
  assert.strictEqual(trimCalls.length, 0, 'new key: zero trim requests');
  await put({ key: T, value: { a: 1 }, baseVersion: 1 });
  assert.strictEqual(trimCalls.length, 0, 'equal value: zero trim requests');
  await put({ key: T, value: { a: 2 }, baseVersion: 2 });
  assert.ok(trimCalls.length >= 2, 'snapshot inserted: trim runs, got ' + trimCalls.length);
  global.fetch = f0;

  // Size cap counts UTF-8 bytes: 400000 x 3-byte chars = 1.2 MB bytes, 400000 chars.
  const M = 'en_fake_multibyte';
  const wide = { t: '€'.repeat(400000) };
  await put({ key: M, value: wide, baseVersion: null });
  for (let i = 0; i < 8; i++) {
    const v = db.kv.find((x) => x.key === M).version;
    await put({ key: M, value: Object.assign({ n: i }, wide), baseVersion: v });
  }
  assert.strictEqual(hist(M).length, 5, 'multibyte value counted in bytes, keeps 5: ' + hist(M).length);
  console.log('kv-sync history: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
