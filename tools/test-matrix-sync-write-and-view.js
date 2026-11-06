// tools/test-matrix-sync-write-and-view.js: Equipment Matrix sync regression test (2026-11-06).
// Run: node tools/test-matrix-sync-write-and-view.js
// Headless bundled Chromium against a static server of THIS checkout, demo mode, SYNTHETIC matrix only.
//
// Defect 1 and 2: a click on a button inside a project tab (Clear All Data, Delete All, Save Edits) was
//   treated as page navigation by db.js (NAV_SELECTOR matched the tab panel class "ptab"), so the write
//   had no user cause and stayed in this browser (DB.getAutoLocalCount() went up). It must not go up.
// Defect 3: after a remote update (dbRemoteApplied -> chRefreshFromStore) the open matrix redrew in Audit
//   View, edit mode off. It must keep the user's view and edit mode.
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const REPO = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require('./launch-browser.js');

let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  PASS: ' + msg);
  } else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(REPO, urlPath);
      if (!filePath.startsWith(REPO)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PID = 900001;
const CSV_LINES = [
  'Location,Control Program,Name,Value,Type,COV Increment,I/O Type,Sensor/Actuator Type,Min/Max,Locked,Path',
  'Fixture Bldg,AHU-1,Supply Temp,55,BAV,,,,,,/Fixture/Bldg/Roof#ahu1/st',
  'Fixture Bldg,AHU-1,Fan Status,1,BAV,,,,,,/Fixture/Bldg/Roof#ahu1/fs',
  'Fixture Bldg,VAV-1,Zone Temp,72,BAV,,,,,,/Fixture/Bldg/Roof#vav1/zt',
];

async function seedMatrix(page) {
  await page.evaluate(
    ({ pid, lines }) => {
      const parsed = emParseCSVText(lines.join('\n'));
      const colMap = emDetectColMap(parsed[0]);
      const groups = emExtractEquipmentGroups(parsed.slice(1), colMap, []);
      const rows = [];
      groups.forEach((g, k) => rows.push(emGroupToMatrixRow(k, g)));
      return sset('en_eqmatrix_' + pid, { rows: rows, importedAt: new Date().toISOString(), buildings: [], edits: {} });
    },
    { pid: PID, lines: CSV_LINES },
  );
}
async function redraw(page) {
  await page.evaluate((pid) => {
    emRenderMatrix(document.getElementById('em-proj-wrap'), emLoadMatrix(pid), pid);
  }, PID);
  await page.waitForTimeout(400);
}
const autoCount = (page) => page.evaluate(() => DB.getAutoLocalCount());
// End any earlier user action: the click under test must be the only cause of the write.
async function expireAction(page) {
  await page.evaluate(() => DB.noteUserAction('test: expired', 1));
  await page.waitForTimeout(80);
}

(async () => {
  const server = await startServer();
  const SITE = 'http://127.0.0.1:' + server.address().port + '/energy-department.html';
  const context = await launchBrowser('matrix-sync-write-and-view', { viewport: { width: 1600, height: 1000 } });
  const page = context.pages()[0] || (await context.newPage());
  page.on('dialog', (d) => d.accept());
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  try {
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => typeof closeQuickStart === 'function' && closeQuickStart());
    const demo = page.locator('button.btn-demo, button:has-text("Continue as Demo"), button:has-text("Continue in Demo Mode")');
    if ((await demo.count()) > 0) await demo.first().click({ force: true });
    await page.waitForTimeout(1500);
    await page.evaluate(() => typeof closeQuickStart === 'function' && closeQuickStart());

    // Synthetic project + matrix, then open the project's Equipment Matrix tab.
    await page.evaluate((pid) => {
      return DB.set('en_projects', [{ id: pid, name: 'Fixture Project', client: 'Fixture', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] }, notes: '', pm: '', tech: '' }]);
    }, PID);
    await page.evaluate(() => { loadCoreLists(true); });
    await seedMatrix(page);
    await page.evaluate(() => { sv('projects'); renderProjTable(); });
    await page.waitForTimeout(800);
    await page.locator('#projTableBody tr', { hasText: 'Fixture Project' }).first().locator('td').first().click();
    await page.waitForTimeout(1500);
    await page.locator('button:has-text("Equipment Matrix")').first().click();
    await page.waitForTimeout(2000);
    assert((await page.locator('#em-clear-all-btn').count()) === 1, 'matrix toolbar is shown for the synthetic project');

    // ---- Defect 3: view and edit mode survive a remote refresh ----
    await page.locator('#em-raw-btn').click();
    await page.waitForTimeout(500);
    await page.locator('#em-edit-mode-btn').click();
    await page.waitForTimeout(800);
    const state = () =>
      page.evaluate(() => ({
        rawActive: (document.getElementById('em-raw-btn') || {}).style && document.getElementById('em-raw-btn').style.background.indexOf('accent') >= 0,
        auditActive: document.getElementById('em-audit-btn').style.background.indexOf('accent') >= 0,
        editText: document.getElementById('em-edit-mode-btn').textContent,
        delShown: document.getElementById('em-delete-all-btn').style.display !== 'none',
        notesCol: !!document.querySelector('td[data-em-ek="notes"]'),
      }));
    let s = await state();
    assert(s.rawActive && !s.auditActive && s.editText === 'Lock' && s.notesCol, 'before refresh: Raw View, edit mode on, notes column shown');
    await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('dbRemoteApplied', { detail: { keys: ['en_eqmatrix_' + pid] } })), PID);
    await page.waitForTimeout(1500);
    s = await state();
    assert(s.rawActive && !s.auditActive, 'defect 3: Raw View still active after remote refresh');
    assert(s.editText === 'Lock' && s.delShown, 'defect 3: edit mode still on after remote refresh');
    assert(s.notesCol, 'defect 3: notes column still shown after remote refresh');
    // The kept view is for the redraw only: a later normal render starts from the default Audit View.
    await redraw(page);
    s = await state();
    assert(s.auditActive && !s.rawActive, 'a normal render later starts from Audit View');

    // ---- Defect 2: Save Edits click is a user action ----
    await page.locator('#em-raw-btn').click();
    await page.locator('#em-edit-mode-btn').click();
    await page.waitForTimeout(500);
    await expireAction(page);
    let n0 = await autoCount(page);
    await page.getByRole('button', { name: 'Save Edits' }).click();
    await page.waitForTimeout(600);
    assert((await autoCount(page)) === n0, 'defect 2: Save Edits click is not counted as a write with no user cause');

    // ---- Defect 1: Delete All and Clear All Data clicks are user actions ----
    await expireAction(page);
    n0 = await autoCount(page);
    await page.locator('#em-delete-all-btn').click();
    await page.waitForTimeout(600);
    assert((await autoCount(page)) === n0, 'defect 1: Delete All click is not counted as a write with no user cause');
    await seedMatrix(page);
    await page.evaluate(() => { window._emActivePid = 900001; });
    await page.evaluate((pid) => { sv('projects'); }, PID);
    await page.locator('#projTableBody tr', { hasText: 'Fixture Project' }).first().locator('td').first().click();
    await page.waitForTimeout(1200);
    await page.locator('button:has-text("Equipment Matrix")').first().click();
    await page.waitForTimeout(1500);
    await expireAction(page);
    n0 = await autoCount(page);
    await page.locator('#em-clear-all-btn').click();
    await page.waitForTimeout(600);
    assert((await autoCount(page)) === n0, 'defect 1: Clear All Data click is not counted as a write with no user cause');
    assert(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } catch (e) {
    failed++;
    console.log('  FAIL: test crashed: ' + e.message);
  } finally {
    await context.close();
    server.close();
  }
  console.log(failed ? 'FAILED ' + failed + ' / ' + (passed + failed) : 'PASSED ' + passed + ' / ' + passed);
  process.exit(failed ? 1 : 0);
})();
