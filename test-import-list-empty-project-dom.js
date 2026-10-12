// test-import-list-empty-project-dom.js
// Acceptance test: Utility Data "Import List" must show for a project with 0 buildings,
// import a building list from CSV, and keep the buildings after reload.
// 100% SYNTHETIC data. Real app code, headless bundled Chromium, unique profile.
// Run: node test-import-list-empty-project-dom.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const SHOT = process.env.IMPORTLIST_SHOT_DIR || '';
const PID = 999000333;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

(async () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'importlist-'));
  const csv = path.join(tmp, 'synth-building-list.csv');
  fs.writeFileSync(
    csv,
    'Building Name,Building SQFT,Address\nSynth Hall,10000,"1 Test St, Synthville"\nSynth Annex,2500,2 Test St\nSynth Gym,40000,3 Test St\n',
  );
  const context = await launchBrowser('importlist-empty', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [
        { id: PID, name: 'SYNTH EMPTY', client: 'Synth', customerId: CID, status: 'active',
          scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } },
      ],
      en_customers: [{ id: CID, name: 'Synth Customer' }],
      ch_qs_seen: 1,
      ch_theme: 'dark',
      ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    };
    // seed once only, so the reload keeps what the import wrote
    await context.addInitScript((d) => {
      if (!window.localStorage.getItem('__seeded')) {
        for (const k in d) window.localStorage.setItem(k, JSON.stringify(d[k]));
        window.localStorage.setItem('__seeded', '1');
      }
    }, seed);
    const open = async () => {
      await page.goto(SITE);
      await page.waitForTimeout(2500);
      await page.evaluate((pid) => {
        sv('utility', document.querySelector('.s-item[onclick*="utility"]'));
        loadUtilityData();
        udSelectProj(pid);
      }, PID);
      await page.waitForTimeout(500);
    };
    await open();
    const importBtn = page.locator('#udNavList button', { hasText: 'Import List' });
    eq(await importBtn.count(), 1, 'Import List shown with 0 buildings');
    eq(await page.locator('#udNavList button', { hasText: '+ Add Building' }).count(), 1, '+ Add Building shown with 0 buildings');
    ok(/Import buildings/.test((await importBtn.getAttribute('title')) || ''), 'Import List has hover text');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, '2026-10-12-importlist-empty-project.png') });

    await importBtn.click();
    await page.setInputFiles('#bldgImportInput', csv);
    await page.waitForTimeout(600);
    eq(await page.locator('#bldgImportCount').textContent(), '3', 'preview finds 3 buildings');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, '2026-10-12-importlist-preview.png') });
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(800);
    const names = () => page.locator('#udNavList .ud-nav-bldg-name').allTextContents();
    eq(JSON.stringify(await names()), JSON.stringify(['Synth Hall', 'Synth Annex', 'Synth Gym']), 'buildings listed after import');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, '2026-10-12-importlist-after-import.png') });

    await open();
    eq(JSON.stringify(await names()), JSON.stringify(['Synth Hall', 'Synth Annex', 'Synth Gym']), 'buildings survive reload');
    eq(await page.locator('#udNavList button', { hasText: 'Import List' }).count(), 1, 'Import List still shown with buildings');
    if (SHOT) await page.screenshot({ path: path.join(SHOT, '2026-10-12-importlist-after-reload.png') });
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
