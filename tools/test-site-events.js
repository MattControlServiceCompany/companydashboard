// Real-browser test (synthetic data, headless bundled Chromium, local HTTP server) of the site event log (app/site-events.js).
// The Supabase POST /rest/v1/ch_site_events is intercepted: nothing reaches the real project. Checks: event shape; page-load;
// a thrown error (page-error); a swap with no user action (version-swap, auto-idle); a click on the update link
// (version-swap, user-click-update-link); a failed POST is silent; the limit of 200 events per tab per hour.
// Run: CH_TMP_ROOT=<scratch> node tools/test-site-events.js
const { launchBrowser } = require('./launch-browser.js');
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
const POST = '**/rest/v1/ch_site_events';
async function open(srv, task, onPost) {
  const ctx = await launchBrowser(task, { viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(seed, SEED);
  await ctx.route('**/*.supabase.co/**', (r) => r.abort()); // every other call to the real project (auth refresh, realtime): blocked
  await ctx.route(POST, onPost);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource|WebSocket/.test(m.text()) && errs.push(m.text()));
  const ft = frameTools(page);
  await page.goto(srv.base + '/energy-department.html?shell=1');
  await ft.waitApp();
  await page.waitForTimeout(1500);
  await ft.app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
  return { ctx, page, errs, ...ft };
}
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
(async () => {
  const srv = await startServer();
  // A: shape, page-load, error, idle swap, link click swap
  const got = [];
  const posts = [];
  const okPost = (route) => {
    const rq = route.request();
    posts.push({ auth: rq.headers()['authorization'], apikey: rq.headers()['apikey'] });
    for (const e of JSON.parse(rq.postData())) got.push(e);
    return route.fulfill({ status: 201, body: '' });
  };
  const A = await open(srv, 'site-events-a', okPost);
  try {
    eq(await waitFor(() => got.some((e) => e.event === 'page-load'), 14000), true, 'page-load event posted within 14 s');
    const pl = got.find((e) => e.event === 'page-load') || {};
    eq(Object.keys(pl).sort(), ['detail', 'email', 'event', 'host', 'page', 'ts', 'version'], 'event row has ts, email, host, version, page, event, detail');
    eq(pl.email, 'demo@example.com', 'email of the signed-in user');
    eq(pl.host, new URL(srv.base).host, 'site host');
    eq(/^v\d/.test(pl.version), true, 'CH_VERSION loaded is set (' + pl.version + ')');
    eq(pl.detail, { trigger: 'first-load' }, 'page-load trigger first-load');
    eq(!!posts[0].auth && /^Bearer /.test(posts[0].auth) && !!posts[0].apikey, true, 'POST carries the session token and the publishable key');
    // thrown error
    await A.app().evaluate(() => setTimeout(() => { throw new Error('boom-test-site-events'); }, 0));
    eq(await waitFor(() => got.some((e) => e.event === 'page-error'), 14000), true, 'page-error event posted');
    const pe = got.find((e) => e.event === 'page-error') || { detail: {} };
    eq(/boom-test-site-events/.test(pe.detail.message) && pe.detail.line === 1 && typeof pe.detail.file === 'string', true, 'page-error has message, file and line');
    eq(A.errs.length, 1, 'only the deliberate error reached pageerror');
    A.errs.length = 0;
    // swap with no user action: idle
    await A.markOld();
    await A.app().evaluate(() => { _chLastInputAt = Date.now() - 31000; });
    srv.liveVer = 'v9999.01.01.3';
    await A.app().evaluate(() => _checkForVersionUpdate());
    eq(await A.waitSwap(20000), true, 'idle: the new frame takes the place');
    eq(await waitFor(() => got.some((e) => e.event === 'version-swap'), 14000), true, 'version-swap event posted (flushed when the old frame left)');
    const sw = got.find((e) => e.event === 'version-swap') || { detail: {} };
    eq(sw.detail.trigger, 'auto-idle', 'swap by idle: trigger auto-idle');
    eq(sw.detail.to, 'v9999.01.01.3', 'swap event has the new version');
    eq(/^v\d/.test(sw.detail.from) && sw.detail.from !== sw.detail.to, true, 'swap event has the old version (' + sw.detail.from + ')');
    eq(got.some((e) => e.event === 'update-link-shown'), true, 'update-link-shown event');
    eq(await waitFor(() => got.some((e) => e.event === 'page-load' && e.detail.trigger === 'after-version-swap'), 14000), true, 'new frame: page-load trigger after-version-swap');
    // swap by a click on the update link: the user is active (not idle), the page is safe
    await A.markOld();
    srv.liveVer = 'v9999.01.01.4';
    await A.app().evaluate(() => { _chLastInputAt = Date.now(); _checkForVersionUpdate(); });
    await A.app().waitForFunction(() => { const l = document.getElementById('ch-ver-update-link'); return l && l.style.display !== 'none' && l.offsetParent; }, null, { timeout: 8000 });
    await A.app().locator('#ch-ver-update-link').click();
    eq(await A.waitSwap(20000), true, 'click: the new frame takes the place');
    eq(await waitFor(() => got.some((e) => e.event === 'version-swap' && e.detail.trigger === 'user-click-update-link'), 14000), true, 'click on the update link: version-swap trigger user-click-update-link');
    eq(got.some((e) => e.event === 'update-link-click'), true, 'update-link-click event');
    eq(A.errs, [], 'run A: no console or page errors');
  } finally {
    await A.ctx.close();
  }
  // B: the POST fails (500, then aborted): silent
  let attempts = 0;
  const B = await open(srv, 'site-events-b', (route) => {
    attempts++;
    return attempts % 2 ? route.fulfill({ status: 500, body: 'x' }) : route.abort();
  });
  const bConsole = [];
  B.page.on('console', (m) => bConsole.push(m.text()));
  try {
    await B.app().evaluate(() => { chLog('fail-test', { n: 1 }); });
    await B.page.waitForTimeout(12500);
    await B.app().evaluate(() => { chLog('fail-test', { n: 2 }); });
    await B.page.waitForTimeout(12500);
    eq(attempts >= 2, true, 'failed POST was tried (' + attempts + ' tries)');
    eq(B.errs, [], 'failed POST: no page error and no console error from the site code');
    eq(bConsole.filter((t) => /site-events|ch_site_events/.test(t) && !/Failed to load resource/.test(t)).length, 0, 'failed POST: no site message in the console');
    eq(await B.app().evaluate(() => typeof chLog), 'function', 'failed POST: the page still runs');
  } finally {
    await B.ctx.close();
  }
  // C: 300 events in one tab: at most 200 accepted in the hour
  const rows = [];
  const C = await open(srv, 'site-events-c', (route) => {
    for (const e of JSON.parse(route.request().postData())) rows.push(e);
    return route.fulfill({ status: 201, body: '' });
  });
  try {
    await C.app().evaluate(() => { for (let i = 0; i < 300; i++) chLog('rate-test', { i }); });
    await C.page.waitForTimeout(12000);
    await C.app().evaluate(() => { for (let i = 0; i < 10; i++) chLog('rate-test-late', { i }); });
    await C.page.waitForTimeout(12000);
    const n = rows.filter((e) => e.event === 'rate-test').length;
    eq(rows.length <= 200, true, 'rate limit: at most 200 events in the hour (' + rows.length + ' posted)');
    eq(n > 100, true, 'rate limit: events up to the limit are posted (' + n + ')');
    eq(rows.filter((e) => e.event === 'rate-test-late').length, 0, 'rate limit: events after the limit are dropped');
    eq(C.errs, [], 'run C: no console or page errors');
  } finally {
    await C.ctx.close();
  }
  srv.server.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
