/** Usage: node tools/test-supabase-keepalive.js  (mocked fetch, synthetic data, no network) */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const fn = require(path.join(__dirname, '..', 'netlify', 'functions', 'supabase-keepalive.js'));
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_SYNTHETIC' };
Object.assign(process.env, env);
const SECRET_ROW = 'SYNTHETIC-ROW-KEY-xyz';

async function run(mock) {
  const calls = [], logs = [];
  const oLog = console.log, oErr = console.error;
  console.log = console.error = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await fn.keepAlive(env, (u, o) => { calls.push({ u, o }); return mock(); }); }
  finally { console.log = oLog; console.error = oErr; }
  return { r, calls, logs };
}
(async () => {
  const ok = await run(async () => ({ ok: true, status: 200, json: async () => [{ key: SECRET_ROW }] }));
  assert.strictEqual(ok.calls.length, 1, 'a: exactly one request');
  assert.strictEqual(ok.calls[0].o.method, 'GET', 'a: GET');
  assert.ok(/\/rest\/v1\/kv\?select=key&limit=1$/.test(ok.calls[0].u), 'a: kv table, limit 1');
  assert.ok(!ok.calls[0].o.body, 'b: no body');
  assert.ok(!/POST|PUT|PATCH|DELETE/i.test(ok.calls[0].o.method), 'b: no write method');
  assert.ok(ok.logs.length > 0 && ok.logs.every((l) => !l.includes(SECRET_ROW) && !l.includes('sb_secret')), 'c: no values logged');
  assert.ok(ok.logs.some((l) => /HTTP 200 \d+ms/.test(l)), 'c: status and duration logged');
  const bad = await run(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.strictEqual(bad.r.ok, false, 'd: failure result');
  const thrown = await run(async () => { throw new Error('boom'); });
  assert.strictEqual(thrown.r.ok, false, 'd: throw is failure');
  const orig = global.fetch; global.fetch = async () => ({ ok: false, status: 503 });
  const h1 = await fn.handler(); global.fetch = orig;
  assert.strictEqual(h1.statusCode, 500, 'd: handler 500 on failure');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  const h2 = await fn.handler(); global.fetch = orig;
  assert.strictEqual(h2.statusCode, 200, 'handler 200 on success');
  assert.ok(/schedule = "@daily"/.test(fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8')), 'schedule daily');
  console.log('PASS test-supabase-keepalive');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
