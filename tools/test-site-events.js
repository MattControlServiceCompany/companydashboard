// Real-browser test (synthetic data, headless bundled Chromium, local HTTP server) of the site event log (app/site-events.js).
// Events are written to the local data store key en_site_events_YYYY-MM (DB.set); this test reads that key. This host never
// syncs, and every call to the real project is blocked: nothing leaves the browser. Checks: event shape (id, ts, email, host,
// version, page, event, detail); page-load; a thrown error (page-error); a swap with no user action (version-swap, auto-idle);
// a click on the update link (version-swap, user-click-update-link); no data request carries events; the limit of 200 events
// per tab per hour; the log key is not in a backup. Needs about 3 minutes (30 s batches).
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
async function open(srv, task) {
  const ctx = await launchBrowser(task, { viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(seed, SEED);
  const reqs = [];
  await ctx.route('**/*.supabase.co/**', (r) => (reqs.push(r.request().url()), r.abort())); // every call to the real project: blocked
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/site-ui\.js|favicon|Failed to load resource|WebSocket/.test(m.text()) && errs.push(m.text()));
  const ft = frameTools(page);
  await page.goto(srv.base + '/energy-department.html?shell=1');
  await ft.waitApp();
  await page.waitForTimeout(1500);
  await ft.app().getByText('Got it', { exact: true }).click({ timeout: 2000 }).catch(() => {});
  return { ctx, page, errs, reqs, ...ft };
}
// The events of this month in the local store (the key the page writes).
const readEvents = (A) => A.app().evaluate(() => DB.get(SyncClassification.EVENT_LOG_PREFIX + new Date().toISOString().slice(0, 7), [])).catch(() => []);
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const has = (A, f) => async () => (await readEvents(A)).some(f);
(async () => {
  const srv = await startServer();
  const A = await open(srv, 'site-events-a');
  try {
    eq(await waitFor(has(A, (e) => e.event === 'page-load'), 45000), true, 'page-load event is in the local store within 45 s');
    const got = await readEvents(A);
    const pl = got.find((e) => e.event === 'page-load') || {};
    eq(Object.keys(pl).sort(), ['detail', 'email', 'event', 'host', 'id', 'page', 'ts', 'version'], 'event has id, ts, email, host, version, page, event, detail');
    eq(pl.email, 'demo@example.com', 'email of the signed-in user');
    eq(pl.host, new URL(srv.base).host, 'site host');
    eq(/^v\d/.test(pl.version), true, 'CH_VERSION loaded is set (' + pl.version + ')');
    eq(pl.detail, { trigger: 'first-load' }, 'page-load trigger first-load');
    eq(/^ev/.test(pl.id), true, 'event id');
    eq(await A.app().evaluate(() => Object.keys(DB.getAllForExport()).some((k) => k.indexOf('en_site_events_') === 0)), false, 'the log key is not in the backup export');
    // thrown error
    await A.app().evaluate(() => setTimeout(() => { throw new Error('boom-test-site-events'); }, 0));
    eq(await waitFor(has(A, (e) => e.event === 'page-error'), 45000), true, 'page-error event written');
    const pe = (await readEvents(A)).find((e) => e.event === 'page-error') || { detail: {} };
    eq(/boom-test-site-events/.test(pe.detail.message) && pe.detail.line === 1 && typeof pe.detail.file === 'string', true, 'page-error has message, file and line');
    eq(A.errs.length, 1, 'only the deliberate error reached pageerror');
    A.errs.length = 0;
    // swap with no user action: idle
    await A.markOld();
    await A.app().evaluate(() => { _chLastInputAt = Date.now() - 31000; });
    srv.liveVer = 'v9999.01.01.3';
    await A.app().evaluate(() => _checkForVersionUpdate());
    eq(await A.waitSwap(20000), true, 'idle: the new frame takes the place');
    // the old frame wrote at pagehide; the new frame reads the same store
    eq(await waitFor(has(A, (e) => e.event === 'version-swap'), 45000), true, 'version-swap event written');
    const evs = await readEvents(A);
    const sw = evs.find((e) => e.event === 'version-swap') || { detail: {} };
    eq(sw.detail.trigger, 'auto-idle', 'swap by idle: trigger auto-idle');
    eq(sw.detail.to, 'v9999.01.01.3', 'swap event has the new version');
    eq(/^v\d/.test(sw.detail.from) && sw.detail.from !== sw.detail.to, true, 'swap event has the old version (' + sw.detail.from + ')');
    eq(evs.some((e) => e.event === 'update-link-shown'), true, 'update-link-shown event');
    eq(await waitFor(has(A, (e) => e.event === 'page-load' && e.detail.trigger === 'after-version-swap'), 45000), true, 'new frame: page-load trigger after-version-swap');
    // swap by a click on the update link: the user is active (not idle), the page is safe
    await A.markOld();
    srv.liveVer = 'v9999.01.01.4';
    await A.app().evaluate(() => { _chLastInputAt = Date.now(); _checkForVersionUpdate(); });
    await A.app().waitForFunction(() => { const l = document.getElementById('ch-ver-update-link'); return l && l.style.display !== 'none' && l.offsetParent; }, null, { timeout: 8000 });
    await A.app().locator('#ch-ver-update-link').click();
    eq(await A.waitSwap(20000), true, 'click: the new frame takes the place');
    eq(await waitFor(has(A, (e) => e.event === 'version-swap' && e.detail.trigger === 'user-click-update-link'), 45000), true, 'click on the update link: version-swap trigger user-click-update-link');
    eq((await readEvents(A)).some((e) => e.event === 'update-link-click'), true, 'update-link-click event');
    eq(A.reqs.filter((u) => /rest\/v1|site_events/.test(u)).length, 0, 'no data request to the project carries events');
    eq(A.errs, [], 'run A: no console or page errors');
  } finally {
    await A.ctx.close();
  }
  // C: 300 events in one tab: at most 200 accepted in the hour
  const C = await open(srv, 'site-events-c');
  try {
    await C.app().evaluate(() => { for (let i = 0; i < 300; i++) chLog('rate-test', { i }); });
    await C.page.waitForTimeout(32000);
    await C.app().evaluate(() => { for (let i = 0; i < 10; i++) chLog('rate-test-late', { i }); });
    await C.page.waitForTimeout(32000);
    const rows = await readEvents(C);
    const n = rows.filter((e) => e.event === 'rate-test').length;
    eq(rows.length <= 200, true, 'rate limit: at most 200 events in the hour (' + rows.length + ' written)');
    eq(n > 100, true, 'rate limit: events up to the limit are written (' + n + ')');
    eq(rows.filter((e) => e.event === 'rate-test-late').length, 0, 'rate limit: events after the limit are dropped');
    eq(C.errs, [], 'run C: no console or page errors');
  } finally {
    await C.ctx.close();
  }
  srv.server.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
