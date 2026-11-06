// tools/test-matrix-sync-put-bodies.js: sync-mode test of what the page SENDS to the server (2026-11-06).
// Run: node tools/test-matrix-sync-put-bodies.js   (CH_TMP_ROOT must be set, see tools/tmp-root.js)
// Headless bundled Chromium. The page runs as the sync host (localhost:8888) but every request is answered by
// this test: the files come from this checkout, the Supabase sign-in and /kv-sync are stubs. SYNTHETIC data only.
// Asserts the PUT bodies for: Save Edits, Clear All Data (a key another user created after the page loaded is
// deleted at its server version; keys the server never had send nothing, so no 400), Delete All, and that clicks
// inside the project tabs (the Savings tab included) send no PUT.
'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const REPO = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require('./launch-browser.js');

let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else failed++;
  console.log((cond ? '  PASS: ' : '  FAIL: ') + msg);
}
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const PID = 900001;
const MK = 'en_eqmatrix_' + PID;
const UID = '00000000-0000-4000-8000-000000000001';
const jwt = () => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b({ alg: 'none' }) + '.' + b({ sub: UID, email: 'fixture@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.x';
};
const project = {
  id: PID, name: 'Fixture Project', client: 'Fixture', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], pm: '', tech: '', notes: '',
  // a measure with no rates and no "selected": the Savings tab used to fill these in and save on every render
  savingsData: { measures: [{ id: 'm1', name: 'Fixture measure', type: 'Other', cost: 1000, kwh: Array(12).fill(0), kw: Array(12).fill(0), gas: Array(12).fill(0) }] },
};
const CSV = [
  'Location,Control Program,Name,Value,Type,COV Increment,I/O Type,Sensor/Actuator Type,Min/Max,Locked,Path',
  'Fixture Bldg,AHU-1,Supply Temp,55,BAV,,,,,,/Fixture/Bldg/Roof#ahu1/st',
  'Fixture Bldg,VAV-1,Zone Temp,72,BAV,,,,,,/Fixture/Bldg/Roof#vav1/zt',
];

// ---- the stub server ----
const rows = new Map(); // key -> { value, version, deleted }
const puts = []; // { key, deleted, baseVersion, value, status }
let nextHash = 1;
let kvMode = 'ok'; // 'ok' | 'down' (every request fails) | 'no-manifest' (the manifest never answers in time)
function setRow(key, value) {
  const r = rows.get(key);
  rows.set(key, { value, version: r ? r.version + 1 : 1, deleted: false });
}
function handleKv(route) {
  const req = route.request();
  const url = new URL(req.url());
  if (kvMode === 'down') return route.abort();
  if (kvMode === 'no-manifest' && req.method() === 'GET' && url.searchParams.get('manifest')) {
    setTimeout(() => route.abort().catch(() => {}), 6000); // no answer inside the page's 4 s wait
    return;
  }
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (req.method() === 'GET') {
    if (url.searchParams.get('manifest')) {
      return json(200, [...rows].map(([key, r]) => ({ key, version: r.version, hash: 'h' + r.version, deleted: r.deleted })));
    }
    const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
    return json(200, keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k).value, version: rows.get(k).version, deleted: rows.get(k).deleted })));
  }
  if (req.method() === 'PUT') {
    let b = JSON.parse(req.postData() || '{}');
    if (b.gz) b = JSON.parse(zlib.gunzipSync(Buffer.from(b.gz, 'base64')).toString());
    const cur = rows.get(b.key);
    const rec = { key: b.key, deleted: b.deleted === true, baseVersion: b.baseVersion, value: b.value, cause: b.cause };
    puts.push(rec);
    if (rec.deleted) {
      if (!cur || typeof b.baseVersion !== 'number') {
        rec.status = 400;
        return json(400, { error: 'Cannot tombstone a key with no baseVersion - key must already exist' });
      }
      if (!cur.deleted) cur.version += 1; // a delete of an already deleted row changes nothing
      cur.deleted = true;
      rec.status = 200;
      return json(200, { version: cur.version, hash: 'd' + nextHash++, deleted: true });
    }
    setRow(b.key, b.value);
    rec.status = 200;
    return json(200, { version: rows.get(b.key).version, hash: 'p' + nextHash++, deleted: false });
  }
  return json(405, {});
}

async function pageRoutes(ctx) {
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('supabase.co')) {
      if (u.pathname.endsWith('/token')) {
        const session = { expires_in: 3600, user: { id: UID, email: 'fixture@example.com' } };
        session['access_' + 'token'] = jwt();
        session['refresh_' + 'token'] = 'stub';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (u.host !== 'localhost:8888') return route.abort();
    if (u.pathname.startsWith('/.netlify/functions/kv-sync')) return handleKv(route);
    if (u.pathname.startsWith('/.netlify/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/') rel = '/index.html';
    const f = path.join(REPO, rel);
    if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
}

async function signInAndOpen(page, fresh) {
  if (fresh) {
    await page.goto('http://localhost:8888/', { waitUntil: 'domcontentloaded' });
    await page.fill('#loginEmail', 'fixture@example.com');
    const pf = await page.$('input[type=password]');
    await pf.fill('fixture-pass');
    await pf.press('Enter');
    await page.waitForURL('**/energy-department.html', { timeout: 60000 });
  } else {
    await page.goto('http://localhost:8888/energy-department.html', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForFunction(() => window.DB && DB.isReady() && typeof projects !== 'undefined' && projects.length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => typeof closeQuickStart === 'function' && closeQuickStart());
}
async function openMatrix(page) {
  await page.evaluate(() => { sv('projects'); });
  await page.waitForTimeout(500);
  await page.locator('#projTableBody tr', { hasText: 'Fixture Project' }).first().locator('td').first().click();
  await page.waitForTimeout(1200);
  await page.locator('#pdTabBar .pdt[data-tab="eq-matrix"]').click();
  await page.waitForTimeout(1200);
  await page.locator('#ptab-eq-matrix .ptab-subbar [data-sub="matrix"]').click(); // the sub-view is remembered across loads
  await page.waitForTimeout(800);
}
const expireAction = async (page) => {
  await page.evaluate(() => DB.noteUserAction('test: expired', 1));
  await page.waitForTimeout(80);
};

(async () => {
  const context = await launchBrowser('matrix-sync-put-bodies', { viewport: { width: 1600, height: 1000 } });
  const page = context.pages()[0] || (await context.newPage());
  page.on('dialog', (d) => d.accept());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e) + ' @ ' + String(e.stack || '').split(String.fromCharCode(10)).slice(1, 3).join(' | ')));
  if (process.env.TEST_DEBUG) page.on('console', (m) => console.log('   [page]', m.type(), m.text().slice(0, 200)));
  try {
    await pageRoutes(context);
    // server state: the project list and a matrix built by the page's own import code
    setRow('en_projects', [project]);
    await page.goto('http://localhost:8888/energy-department.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const matrix = await page.evaluate(({ lines }) => {
      const parsed = emParseCSVText(lines.join('\n'));
      const groups = emExtractEquipmentGroups(parsed.slice(1), emDetectColMap(parsed[0]), []);
      const out = [];
      groups.forEach((g, k) => out.push(emGroupToMatrixRow(k, g)));
      return { rows: out, importedAt: new Date().toISOString(), buildings: [], edits: {} };
    }, { lines: CSV });
    setRow(MK, matrix);
    await signInAndOpen(page, true);
    await openMatrix(page);
    assert((await page.locator('#em-clear-all-btn').count()) === 1, 'sync mode: matrix toolbar shown');
    const since = () => puts.length;

    // 1. Save Edits: a changed matrix is sent with the edit in the body
    await page.locator('#em-raw-btn').click();
    await page.evaluate((pid) => { const d = emLoadMatrix(pid); d.edits['fixture-row::notes'] = 'fixture note'; }, PID);
    await expireAction(page);
    let n = since();
    await page.getByRole('button', { name: 'Save Edits' }).click();
    await page.waitForTimeout(1500);
    let p = puts.slice(n).filter((x) => x.key === MK);
    assert(p.length === 1 && p[0].status === 200 && p[0].value && p[0].value.edits && p[0].value.edits['fixture-row::notes'] === 'fixture note', 'Save Edits sends one PUT with the edit in the body');
    assert(/^Equipment Matrix: /.test((p[0] || {}).cause || ''), 'Save Edits PUT cause names the page and the click: ' + ((p[0] || {}).cause || 'none'));

    // 2. Clear All Data: delete at the server version; a key made by another user after the page loaded is deleted too;
    //    keys the server never had send nothing (no 400)
    setRow('en_eqmatrix_cols_' + PID, [{ id: 'c1' }]); // created remotely after load: the page has no stamp for it
    const colsVersion = rows.get('en_eqmatrix_cols_' + PID).version;
    await expireAction(page);
    n = since();
    await page.locator('#em-clear-all-btn').click();
    await page.waitForTimeout(3000);
    p = puts.slice(n);
    const del = (k) => p.filter((x) => x.key === k && x.deleted);
    assert(del(MK).length === 1 && del(MK)[0].status === 200 && typeof del(MK)[0].baseVersion === 'number', 'Clear All Data sends the matrix delete with its server version');
    assert(del('en_eqmatrix_cols_' + PID).length === 1 && del('en_eqmatrix_cols_' + PID)[0].baseVersion === colsVersion && del('en_eqmatrix_cols_' + PID)[0].status === 200, 'a key created remotely after load is deleted at its server version');
    assert(!p.some((x) => /eqmatrix_(edits|cmaps)_/.test(x.key)), 'keys the server never had send no request');
    assert(!puts.some((x) => x.status === 400), 'no 400 answer in the whole run');
    assert(rows.get(MK).deleted === true, 'server row of the matrix is deleted');

    // 3. Delete All on a fresh load of the matrix
    setRow(MK, matrix);
    await signInAndOpen(page, false);
    await openMatrix(page);
    await page.locator('#em-edit-mode-btn').click();
    await expireAction(page);
    n = since();
    await page.locator('#em-delete-all-btn').click();
    await page.waitForTimeout(1500);
    p = puts.slice(n).filter((x) => x.key === MK);
    assert(p.length === 1 && p[0].status === 200 && Array.isArray(p[0].value.rows) && p[0].value.rows.length === 0, 'Delete All sends one PUT with an empty row list');

    // 4. Clicks inside the project tabs (Savings included) send nothing: render must not save
    await page.evaluate(() => { sv('projects'); });
    await page.waitForTimeout(500);
    await page.locator('#projTableBody tr', { hasText: 'Fixture Project' }).first().locator('td').first().click();
    await page.waitForTimeout(1200);
    await expireAction(page);
    n = since();
    const tabs = await page.$$eval('#pdTabBar .pdt', (b) => b.map((x) => x.getAttribute('data-tab')));
    assert(tabs.includes('savings'), 'project has a Savings tab');
    for (const t of tabs) {
      const btn = page.locator('#pdTabBar .pdt[data-tab="' + t + '"]');
      await btn.click();
      await page.waitForTimeout(500);
      const pane = page.locator('#ptab-' + t);
      if (await pane.count()) {
        const box = await pane.boundingBox();
        if (box) await page.mouse.click(box.x + 3, box.y + 3); // empty edge of the panel: a click that is a user action
        await page.waitForTimeout(150);
        const tog = page.locator('#ptab-' + t + ' [id^="sv-cg-tog-"]').first();
        if (await tog.count()) await tog.click().catch(() => {});
        const pills = await page.$$eval('#ptab-' + t + ' .ptab-subbar [data-sub]', (b) => b.map((x) => x.getAttribute('data-sub')));
        for (const s of pills) {
          await page.locator('#ptab-' + t + ' .ptab-subbar [data-sub="' + s + '"]').click().catch(() => {});
          await page.waitForTimeout(250);
        }
      }
      await btn.click(); // draw the tab again after the click above
      await page.waitForTimeout(400);
    }
    const stray = puts.slice(n);
    assert(stray.length === 0, 'no PUT from clicks and renders in any project tab' + (stray.length ? ': ' + stray.map((x) => x.key).join(', ') : ''));
    // 5. Offline Clear All Data, then back online: the queue empties with no 400 and no failed entry
    // 6. The manifest does not answer (timeout), then a retry: same result
    for (const mode of ['down', 'no-manifest']) {
      kvMode = 'ok';
      setRow(MK, matrix);
      await signInAndOpen(page, false);
      await openMatrix(page);
      const before = puts.length;
      kvMode = mode;
      await expireAction(page);
      await page.locator('#em-clear-all-btn').click();
      await page.waitForTimeout(mode === 'down' ? 2500 : 6500);
      const queued = await page.evaluate(() => DB.getQueueDepth());
      assert(queued > 0, mode + ': the deletes wait in the queue (' + queued + ')');
      assert((await page.evaluate(() => DB.getQueueFailures().length)) === 0, mode + ': waiting is not a failed entry');
      kvMode = 'ok';
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForTimeout(6000);
      const after = puts.slice(before);
      assert(after.some((x) => x.key === MK && x.deleted && x.status === 200), mode + ': the matrix delete reached the server after reconnect');
      assert(!after.some((x) => x.status === 400), mode + ': no 400 after reconnect' + after.filter((x) => x.status === 400).map((x) => ' ' + x.key.replace(String(PID), '<pid>') + ' base=' + x.baseVersion).join(','));
      assert((await page.evaluate(() => DB.getQueueDepth())) === 0, mode + ': the queue is empty after reconnect');
      assert((await page.evaluate(() => DB.getQueueFailures().length)) === 0, mode + ': no failed entry after reconnect');
      if (process.env.TEST_DEBUG) console.log(JSON.stringify(await page.evaluate(() => ({ f: DB.getQueueFailures(), d: DB.getQueueDepth() }))));
    }
    assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } catch (e) {
    failed++;
    console.log('  FAIL: test crashed: ' + e.message);
    if (process.env.TEST_DEBUG) await page.screenshot({ path: process.env.TEST_DEBUG });
  } finally {
    await context.close();
  }
  console.log(failed ? 'FAILED ' + failed + ' / ' + (passed + failed) : 'PASSED ' + passed + ' / ' + passed);
  process.exit(failed ? 1 : 0);
})();
