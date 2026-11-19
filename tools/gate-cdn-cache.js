// gate-cdn-cache.js — test-only. One disk cache for CDN files, shared by every test process of the gate.
// Use:  node --require tools/gate-cdn-cache.js <test>   (the gate does this for every job).
// It wraps Playwright so every BrowserContext serves cdn.jsdelivr.net, cdnjs.cloudflare.com, fonts.googleapis.com and
// fonts.gstatic.com from CH_CDN_CACHE (key = sha1 of the URL). The network is used once per URL per cache.
// Without CH_CDN_CACHE the cache lives in memory of the process only. Also exports cdnRoute(ctx) and prefetch(html).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const CDN_RE = /^https?:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const stats = { hits: 0, disk: 0, network: 0 };
const mem = new Map();
const pending = new Map();
const routed = new WeakSet();

function dir() {
  const d = process.env.CH_CDN_CACHE;
  if (d) fs.mkdirSync(d, { recursive: true });
  return d || null;
}
function keyOf(u) {
  return crypto.createHash('sha1').update(u).digest('hex');
}
function readDisk(u) {
  const d = dir();
  if (!d) return null;
  const k = path.join(d, keyOf(u));
  try {
    const meta = JSON.parse(fs.readFileSync(k + '.json', 'utf8'));
    return { status: meta.status, headers: meta.headers, body: fs.readFileSync(k + '.body') };
  } catch (e) {
    return null;
  }
}
function writeAtomic(file, data) {
  const t = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(t, data);
  fs.renameSync(t, file);
}
function writeDisk(u, e) {
  const d = dir();
  if (!d) return;
  const k = path.join(d, keyOf(u));
  writeAtomic(k + '.body', e.body); // body first, then meta: meta present = entry complete
  writeAtomic(k + '.json', JSON.stringify({ url: u, status: e.status, headers: e.headers }));
}
const PASS_HEADERS = ['content-type', 'access-control-allow-origin', 'cache-control'];
function pickHeaders(h) {
  const o = {};
  for (const n of PASS_HEADERS) if (h[n]) o[n] = h[n];
  return o;
}

async function cdnRoute(ctx) {
  if (routed.has(ctx)) return;
  routed.add(ctx);
  await ctx.route(CDN_RE, async (route) => {
    const u = route.request().url();
    stats.hits++;
    try {
      let e = mem.get(u);
      if (!e) {
        e = readDisk(u);
        if (e) stats.disk++;
      }
      if (!e) {
        if (!pending.has(u)) {
          pending.set(
            u,
            (async () => {
              const r = await route.fetch();
              stats.network++;
              const got = { status: r.status(), headers: pickHeaders(r.headers()), body: await r.body() };
              if (got.status >= 200 && got.status < 300) writeDisk(u, got);
              return got;
            })().finally(() => pending.delete(u))
          );
        }
        e = await pending.get(u);
      }
      if (!(e.status >= 200 && e.status < 300)) return route.abort();
      mem.set(u, e);
      return route.fulfill({ status: e.status, headers: e.headers, body: e.body });
    } catch (err) {
      return route.abort();
    }
  });
}

// Gate side: fetch the CDN URLs named in an HTML file once. Returns { total, fetched }.
async function prefetch(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const urls = Array.from(new Set(html.match(/https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/[^\s"'<>)]+/g) || []));
  let fetched = 0;
  await Promise.all(
    urls.map(async (u) => {
      if (readDisk(u)) return;
      try {
        const r = await fetch(u, { redirect: 'follow' });
        if (!r.ok) return;
        const body = Buffer.from(await r.arrayBuffer());
        writeDisk(u, { status: r.status, headers: pickHeaders(Object.fromEntries(r.headers)), body });
        fetched++;
      } catch (e) {}
    })
  );
  const ready = urls.filter((u) => readDisk(u)).length;
  return { total: urls.length, ready, fetched };
}

// ---- Playwright wrap (only when loaded with --require) ----
const WRAPPED = Symbol('gateCdnWrapped');
function wrapChromium(chromium) {
  if (!chromium || chromium[WRAPPED]) return;
  chromium[WRAPPED] = true;
  const wrapBrowser = (b) => {
    if (!b || b[WRAPPED]) return b;
    b[WRAPPED] = true;
    const nc = b.newContext.bind(b);
    b.newContext = async (...a) => {
      const c = await nc(...a);
      await cdnRoute(c);
      return c;
    };
    const np = b.newPage.bind(b);
    b.newPage = async (...a) => {
      const p = await np(...a);
      await cdnRoute(p.context());
      return p;
    };
    return b;
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...a) => wrapBrowser(await launch(...a));
  const lpc = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (...a) => {
    const c = await lpc(...a);
    await cdnRoute(c);
    return c;
  };
  const co = chromium.connectOverCDP && chromium.connectOverCDP.bind(chromium);
  if (co) chromium.connectOverCDP = async (...a) => wrapBrowser(await co(...a));
}
if (process.execArgv.some((a) => /gate-cdn-cache\.js$/.test(a))) {
  const names = new Set(['playwright', 'playwright-core', '@playwright/test']);
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const m = origLoad.apply(this, arguments);
    if (names.has(request) && m) wrapChromium(m.chromium);
    return m;
  };
  if (process.env.CH_CDN_STATS) process.on('exit', () => console.error('cdn-stats ' + JSON.stringify(stats)));
}
module.exports = { cdnRoute, prefetch, stats, CDN_RE };
