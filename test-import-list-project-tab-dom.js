// test-import-list-project-tab-dom.js
// Acceptance test: the PROJECT's own Utility Data tab shows "+ Add Building" and "Import List"
// with 0 and with 1+ buildings, Import List imports into THAT project, and saving the first
// building keeps the tab showing the building list. 100% SYNTHETIC data, headless bundled Chromium.
// Run: node test-import-list-project-tab-dom.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const SHOT = process.env.IMPORTLIST_SHOT_DIR || '';
const PID = 999000444;
const PID2 = 999000445;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

(async () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'importlist-tab-'));
  const csv = path.join(tmp, 'synth-building-list.csv');
  fs.writeFileSync(
    csv,
    'Building Name,Building SQFT,Address\nSynth Hall,10000,"1 Test St, Synthville"\nSynth Annex,2500,2 Test St\nSynth Gym,40000,3 Test St\n',
  );
  const context = await launchBrowser('importlist-projtab', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const mk = (id, name) => ({
      id, name, client: 'Synth', customerId: 'cust_' + id, status: 'active',
      scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] },
    });
    const seed = {
      en_projects: [mk(PID, 'SYNTH TAB ONE'), mk(PID2, 'SYNTH TAB TWO')],
      en_customers: [{ id: CID, name: 'Synth Customer' }, { id: 'cust_' + PID2, name: 'Synth Customer 2' }],
      ch_qs_seen: 1,
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    await context.addInitScript((d) => {
      if (!window.localStorage.getItem('__seeded')) {
        for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
        window.localStorage.setItem('__seeded', '1');
      }
    }, seed);
    await page.goto(SITE);
    await page.waitForTimeout(2500);
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('utility', document.querySelector('.pdt[data-tab="utility"]'));
    }, PID);
    await page.waitForTimeout(600);
    const tab = page.locator('#ptab-utility');
    const addBtn = () => tab.locator('button', { hasText: '+ Add Building' });
    const impBtn = () => tab.locator('button', { hasText: 'Import List' });
    eq(await addBtn().count(), 1, 'embedded tab: + Add Building shown with 0 buildings');
    eq(await impBtn().count(), 1, 'embedded tab: Import List shown with 0 buildings');
    ok(/Import buildings/.test((await impBtn().getAttribute('title')) || ''), 'embedded Import List has hover text');
    eq(await tab.locator('button', { hasText: /^\+ Add$/ }).count(), 0, 'old lone "+ Add" removed');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, 'fix-1-embedded-empty.png') });

    // save the first building from the embedded tab
    await addBtn().click();
    await page.fill('#bm-name', 'Synth First');
    await page.evaluate(() => saveBuilding());
    await page.waitForTimeout(800);
    eq(await page.evaluate(() => getComputedStyle(document.getElementById('ptab-utility')).display !== 'none'), true, 'Utility Data tab still visible after first building saved');
    eq(JSON.stringify(await tab.locator('.ud-nav-bldg-name').allTextContents()), JSON.stringify(['Synth First']), 'tab lists the first building');
    eq(await impBtn().count(), 1, 'Import List shown with 1 building');
    eq(await addBtn().count(), 1, '+ Add Building shown with 1 building');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, 'fix-2-embedded-after-first-building.png') });

    // import into THIS project from the embedded tab
    await impBtn().click();
    await page.setInputFiles('#bldgImportInput', csv);
    await page.waitForTimeout(600);
    eq(await page.locator('#bldgImportCount').textContent(), '3', 'preview finds 3 buildings');
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(900);
    eq(
      JSON.stringify(await tab.locator('.ud-nav-bldg-name').allTextContents()),
      JSON.stringify(['Synth First', 'Synth Hall', 'Synth Annex', 'Synth Gym']),
      'embedded tab lists imported buildings',
    );
    const counts = await page.evaluate(([a, b]) => [getUDBldgs(a).length, getUDBldgs(b).length], [PID, PID2]);
    eq(counts[0], 4, 'imported into the open project');
    eq(counts[1], 0, 'other project untouched');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, 'fix-3-embedded-after-import.png') });

    // sidebar page still shows both buttons
    await page.evaluate((pid) => {
      sv('utility', document.querySelector('.s-item[onclick*="utility"]'));
      loadUtilityData();
      udSelectProj(pid);
    }, PID);
    await page.waitForTimeout(500);
    eq(await page.locator('#udNavList button', { hasText: 'Import List' }).count(), 1, 'sidebar Import List shown');
    eq(await page.locator('#udNavList button', { hasText: '+ Add Building' }).count(), 1, 'sidebar + Add Building shown');
  } catch (e) {
    failures.push('SCRIPT ERROR ' + e.message);
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(pass + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})();
