// Real-browser test (synthetic data, headless bundled Chromium, local HTTP server): a release is pushed to an open tab.
// (b) real Supabase Realtime round trip on a TEST topic; (a) the open, focused, idle tab swaps within 5 s of the broadcast,
// and site-ui.js is requested only once (by the broadcast), never by a timer; (d) offline: no console errors.
// Run: node tools/test-version-push.js   (CH_TMP_ROOT must be set; needs network for the real broadcast)
const { launchBrowser } = require('./launch-browser.js');
const { announce } = require('./announce-version.js');
const { startServer, seed, SEED, frameTools } = require('./update-test-helpers.js');
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
const siteUiReqs = (srv) => srv.reqs.filter((r) => r.startsWith('/site-ui.js')).length;
(async () => {
  // (b) round trip with the real project: a node socket on a test topic receives the REST broadcast
  const topic = 'ch-version:test-' + Math.random().toString(36).slice(2);
  const key = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'ch-auth.js'), 'utf8').match(/var SUPABASE_ANON_KEY = '([^']+)'/)[1];
  const got = await new Promise((resolve) => {
    const ws = new WebSocket('wss://rrdugvwxtddjywqykphf.supabase.co/realtime/v1/websocket?apikey=' + key + '&vsn=1.0.0');
    const t = setTimeout(() => resolve(null), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ topic: 'realtime:' + topic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } }, ref: '1' }));
    ws.onmessage = async (m) => {
      const d = JSON.parse(m.data);
      if (d.event === 'phx_reply' && d.payload.status === 'ok') await announce(topic.slice('ch-version:'.length), 'v-test-1');
      if (d.event === 'broadcast') (clearTimeout(t), ws.close(), resolve(d.payload.payload));
    };
  });
  eq(got, { version: 'v-test-1' }, 'real Supabase round trip: the socket receives the REST broadcast');

  const srv = await startServer();
  const ctx = await launchBrowser('version-push', { viewport: { width: 1400, height: 900 } });
  try {
    await ctx.addInitScript(seed, SEED);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource/.test(m.text()) && errs.push(m.text()));
    const { kids, app, waitApp, waitSwap, markOld } = frameTools(page);
    await page.goto(srv.base + '/energy-department.html?shell=1');
    await waitApp();
    await page.waitForTimeout(2000);
    await app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
    await markOld();
    // idle and focused, 65 s: no request for site-ui.js (no polling timer)
    const n0 = siteUiReqs(srv);
    await page.waitForTimeout(65000);
    eq(siteUiReqs(srv) - n0, 0, '65 s idle: 0 site-ui.js requests (no timer poll)');
    // a dialog is open, so the swap must wait; the broadcast is still received (one request)
    await app().evaluate(() => {
      window.chDialogIsOpen = () => true;
      _chLastInputAt = Date.now() - 31000;
    });
    srv.liveVer = 'v9999.01.01.3';
    await announce(new URL(srv.base).host, 'v9999.01.01.3');
    await page.waitForTimeout(3000);
    eq(siteUiReqs(srv) - n0, 1, 'broadcast: exactly 1 site-ui.js request');
    eq(await app().evaluate(() => _chPendingVer), 'v9999.01.01.3', 'broadcast: the new version is pending');
    eq(kids().length, 1, 'dialog open: no swap yet');
    const t0 = Date.now();
    await app().evaluate(() => (window.chDialogIsOpen = () => false));
    eq(await waitSwap(15000), true, 'dialog closed: the new frame takes the place');
    const dt = Date.now() - t0;
    eq(dt <= 5500, true, 'swap within 5 s of the tab being safe (' + dt + ' ms)');
    // (d) offline: block the socket host; no console errors; the check on load still works
    eq(errs, [], 'no console or page errors');
  } finally {
    await ctx.close();
    srv.server.close();
  }
  // (d) offline: a second run with the Supabase host blocked
  const srv2 = await startServer();
  const ctx2 = await launchBrowser('version-push-off', { viewport: { width: 1400, height: 900 } });
  try {
    await ctx2.addInitScript(seed, SEED);
    await ctx2.route('**/*.supabase.co/**', (r) => r.abort());
    const page = await ctx2.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource|WebSocket/.test(m.text()) && errs.push(m.text()));
    const { app, waitApp } = frameTools(page);
    await page.goto(srv2.base + '/energy-department.html?shell=1');
    await waitApp();
    await page.waitForTimeout(6000);
    eq(errs, [], 'offline: no console or page errors');
    eq(await app().evaluate(() => typeof window.chVersionPush), 'object', 'offline: page runs');
  } finally {
    await ctx2.close();
    srv2.server.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
