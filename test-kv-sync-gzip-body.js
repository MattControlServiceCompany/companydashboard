'use strict';
// Synthetic test: kv-sync.js PUT accepts a gzip envelope {"gz": base64} > 1 MB. No network: fetch is an in-memory fake; jose is stubbed.
const assert = require('assert');
const zlib = require('zlib');
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

const written = [];
const jr = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, opts = {}) => {
  const m = (opts.method || 'GET').toUpperCase();
  if (m === 'GET') return jr(200, []);
  if (m === 'POST') { const b = JSON.parse(opts.body); written.push(b); return jr(201, b); }
  return jr(200, []);
};

// Synthetic value, > 1 MB raw, with non-ASCII text and random-ish bytes so gzip output has bytes >= 0x80.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const rows = [];
for (let i = 0; i < 25000; i++) rows.push({ id: 'fake-' + i, note: 'caf\u00e9 ' + rnd().toString(36) + rnd().toString(36), kwh: rnd() % 100000 });
const value = { rows };
const raw = Buffer.from(JSON.stringify({ key: 'en_fake_proj_1', value, baseVersion: null }), 'utf8');
assert.ok(raw.length > 1024 * 1024, 'synthetic body is over 1 MB: ' + raw.length);
const gz = zlib.gzipSync(raw);
assert.ok(gz.slice(0, 2).equals(Buffer.from([0x1f, 0x8b])));

const env = JSON.stringify({ gz: gz.toString('base64') });
const mk = (body, b64) => ({ httpMethod: 'PUT', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body, isBase64Encoded: !!b64 });
const check = async (name, ev, want) => {
  written.length = 0;
  const r = await handler(ev);
  const got = r.statusCode === 200 && written.length === 1 && JSON.stringify(written[0][0].value) === JSON.stringify(value);
  const ok = want === 200 ? got : r.statusCode === want;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + r.statusCode + (r.statusCode === 200 ? ' value reached write intact=' + got : ' ' + r.body));
  return ok;
};
(async () => {
  const res = [];
  res.push(await check('gz envelope as text', mk(env, false), 200));
  res.push(await check('gz envelope delivered base64', mk(Buffer.from(env).toString('base64'), true), 200));
  res.push(await check('plain JSON body, not gzip', mk(raw.toString('utf8'), false), 200));
  res.push(await check('bad gz data answers 400', mk('{"gz":"AAAA"}', false), 400));
  if (res.includes(false)) { console.log(res.filter((x) => !x).length + ' FAIL'); process.exit(1); }
  console.log('all pass');
})();
