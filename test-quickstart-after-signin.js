// Real-browser test (headless bundled Chromium, local http server with a fake kv-sync, fake users, no real data): the first-visit Quick Start guide
// must NOT open over the sign-in screen, must open once after sign-in, and must not open on a second visit.
// Run: node test-quickstart-after-signin.js
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const http = require('http');
const server = new Map(); // fake kv-sync store: wire key -> { value, version }
function kvSync(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const json = (b) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(b));
  };
  if (req.method === 'PUT') {
    const b = JSON.parse(body || '{}');
    const v = (server.get(b.key) || { version: 0 }).version + 1;
    server.set(b.key, { value: b.value, version: v });
    return json({ version: v });
  }
  if (url.searchParams.has('manifest')) return json([...server].map(([key, r]) => ({ key, version: r.version, hash: null, deleted: false })));
  const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
  return json(keys.filter((k) => server.has(k)).map((k) => ({ key: k, value: server.get(k).value, version: server.get(k).version, deleted: false })));
}
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const web = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p.indexOf('/.netlify/functions/kv-sync') === 0) return kvSync(req, res, Buffer.concat(chunks).toString());
    const f = path.join(__dirname, p);
    if (!f.startsWith(__dirname)) return res.writeHead(403).end();
    fs.readFile(f, (e, d) => {
      if (e) return res.writeHead(404).end();
      res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
      res.end(d);
    });
  });
});
let SITE = '';
let pass = 0;
let fail = 0;
function eq(a, b, l) {
  if (a === b) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + b + ', got ' + a);
  }
}
const state = () => ({
  open: document.getElementById('qsOverlay').classList.contains('open'),
  seen: DB.get('ch_qs_seen', null) ? '1' : null,
  app: document.getElementById('app').classList.contains('visible'),
});
const USER = { name: 'Test User', email: 'test@example.com', initials: 'TU', isReal: false };
(async () => {
  let ctx;
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  SITE = 'http://127.0.0.1:' + web.address().port + '/energy-department.html';
  try {
    ctx = await launchBrowser('qs-signin', { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Fetch API cannot load file:/.test(m.text()) && errs.push(m.text()));
    // 1. signed out: no modal, flag untouched
    await page.goto(SITE);
    await page.waitForTimeout(2200);
    let s = await page.evaluate(state);
    eq(s.app, false, 'signed out: app hidden');
    eq(s.open, false, 'signed out: no Quick Start modal');
    eq(s.seen, null, 'signed out: ch_qs_seen not set');
    // 2. sign in: one modal, flag set
    await page.evaluate((u) => {
      sessionStorage.setItem('ch_user', JSON.stringify(u));
      currentUser = u;
      enterApp();
    }, USER);
    await page.waitForTimeout(1800);
    s = await page.evaluate(state);
    eq(s.app, true, 'after sign-in: app visible');
    eq(s.open, true, 'after sign-in: Quick Start modal open');
    eq(s.seen, '1', 'after sign-in: ch_qs_seen set');
    eq(await page.evaluate(() => document.querySelectorAll('#qsOverlay.open').length), 1, 'exactly one modal');
    // 3. second visit (already signed in, seen=1): none
    await page.reload();
    await page.waitForTimeout(2500);
    s = await page.evaluate(state);
    eq(s.app, true, 'second visit: signed in');
    eq(s.open, false, 'second visit: no Quick Start modal');
    // 4. first visit already signed in: opens once by the timer
    await page.evaluate(async () => { DB.set('ch_qs_seen', false); await new Promise((r) => setTimeout(r, 300)); });
    await page.reload();
    await page.waitForTimeout(2500);
    s = await page.evaluate(state);
    eq(s.open, true, 'signed-in first visit: modal opens');
    eq(s.seen, '1', 'signed-in first visit: flag set');
    // 5. identity changes with backend mode 'on' (stubbed auth + in-memory fake server, fake users):
    // first sign-in shows tips once, same user again none, other user once, settings survive.
    await page.evaluate(async () => {
      window.__uid = null;
      window.CH_AUTH.getUserId = () => window.__uid;
      window.CH_AUTH.backendMode = () => (window.__uid ? 'on' : 'off');
      window.CH_AUTH.getToken = () => 'fake-token';
      window.__ev = async (u) => {
        window.__uid = u;
        window.dispatchEvent(new CustomEvent('chAuthStateChanged', { detail: {} }));
        await new Promise((r) => setTimeout(r, 1800));
      };
      document.getElementById('qsOverlay').classList.remove('open');
      // Count tip bubbles asked for: they follow the same first-sign-in rule as the overlay.
      window.__tipCalls = 0;
      window.showTooltip = function () { window.__tipCalls++; };
      ['ud-proj-perf-btn', 'ud-proj-baseline-btn', 'ud-proj-savproj-btn'].forEach(function (id) {
        var b = document.createElement('button');
        b.id = id;
        document.body.appendChild(b);
      });
      await window.__ev(null);
    });
    const sign = async (u) => {
      await page.evaluate(() => document.getElementById('qsOverlay').classList.remove('open'));
      await page.evaluate(() => { window.__tipCalls = 0; });
      await page.evaluate((id) => window.__ev(id), u);
      const open = await page.evaluate(() => document.getElementById('qsOverlay').classList.contains('open'));
      const tips = await page.evaluate(() => window.__tipCalls);
      eq(tips, open ? 3 : 0, 'tip bubbles follow the overlay for ' + u + ' (' + (open ? 'first' : 'later') + ' sign-in)');
      return open;
    };
    eq(await sign('fake-user-a'), true, 'user A first sign-in: tips open');
    await page.evaluate(() => { chDismissTip('tip_perf_tab'); return new Promise((r) => setTimeout(r, 1500)); });
    await page.evaluate(() => { chSetSetting('showTooltips', false); return window.__ev(null); });
    eq(await sign('fake-user-a'), false, 'user A signs out and in again: tips do not open');
    eq(await page.evaluate(() => chGetSetting('showTooltips', true)), false, 'user A settings toggle survives sign-in');
    eq(await page.evaluate(() => chIsDismissed('tip_perf_tab')), true, 'user A dismissed tip survives sign-in');
    await page.evaluate(() => window.__ev(null));
    eq(await sign('fake-user-b'), true, 'user B first sign-in: tips open');
    eq(await page.evaluate(() => chGetSetting('showTooltips', true)), true, 'user B does not inherit user A settings');
    await page.evaluate(() => window.__ev(null));
    eq(await sign('fake-user-b'), false, 'user B second sign-in: tips do not open');
    eq(errs.length, 0, 'no console errors: ' + errs.join(' | '));
  } finally {
    if (ctx) await ctx.close();
    web.close();
  }
  console.log('quickstart-after-signin: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
