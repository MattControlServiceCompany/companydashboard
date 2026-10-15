// test-import-list-billfile-dom.js
// Import List on a meter already in the project: a new or changed Bill file is stored; a blank one never clears it.
// Then Import Bills finds the meter by the new file name. 100% SYNTHETIC data, headless bundled Chromium.
// Run: node test-import-list-billfile-dom.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./tools/launch-browser.js');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PID = 999556;
const CID = 'cust_' + PID;
let pass = 0;
const failures = [];
const ok = (c, l) => (c ? pass++ : failures.push(l));
const eq = (a, e, l) => ok(a === e, l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));

(async () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bfupd-'));
  const w = (name, text) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const H = 'Building,Commodity,Provider,Account #,Meter #,Bill file\n';
  const first = w('first.csv', H + 'Synth Hall,Electric,Synth Power,ACCT-0001,MTR-0001,old-name.csv\nSynth Hall,Electric,Synth Power,ACCT-0002,MTR-0002,\n');
  const second = w('second.csv', H + 'Synth Hall,Electric,Synth Power,ACCT-0001,MTR-0001,new-name.csv\nSynth Hall,Electric,Synth Power,ACCT-0002,MTR-0002,<b>x</b>.csv\n');
  const blank = w('blank.csv', H + 'Synth Hall,Electric,Synth Power,ACCT-0001,MTR-0001,\n');
  const bill = w('new-name.csv', 'start_date,end_date,kwh,actual_kw,total_cost\n2024-01-01,2024-02-01,1000,50,100.50\n');

  const context = await launchBrowser('bfupd', { viewport: { width: 1600, height: 900 } });
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [
        { id: PID, name: 'SYNTH BILLFILE', client: 'Synth', customerId: CID, status: 'active', scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } },
      ],
      en_customers: [{ id: CID, name: 'Synth Customer' }],
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
    const files = () => page.evaluate((pid) => getUDBldgs(pid).flatMap((b) => b.meters.map((m) => [m.account, m.billFile || '', (m.bills || []).length, m.commodity, m.provider, m.meter].join('~'))), PID);
    const openImport = async (file) => {
      await tab.locator('button', { hasText: 'Import List' }).click();
      await page.setInputFiles('#bldgImportInput', file);
      await page.waitForTimeout(500);
    };

    await openImport(first);
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    let f = await files();
    eq(f[0], 'ACCT-0001~old-name.csv~0~Electric~Synth Power~MTR-0001', 'first import: old name stored');
    eq(f[1].split('~')[1], '', 'first import: blank stays blank');

    // changed + new Bill file on existing meters
    await openImport(second);
    const prev = await page.locator('#bldgImportPreviewTable').innerText();
    ok(/Bill file updated/.test(prev), 'preview says Bill file updated');
    eq(await page.locator('#bldgImportBtn').textContent(), 'Import 2 Bill file updates', 'button counts the updates');
    eq(await page.locator('#bldgImportPreviewTable').evaluate((t) => t.querySelectorAll('b').length), 0, 'CSV value is escaped in the preview');
    await page.click('#bldgImportBtn');
    await page.waitForTimeout(500);
    f = await files();
    eq(f[0], 'ACCT-0001~new-name.csv~0~Electric~Synth Power~MTR-0001', 'existing meter: Bill file replaced, other fields unchanged');
    eq(f[1].split('~')[1], '<b>x</b>.csv', 'blank value filled, kept as text');
    eq(f.length, 2, 'no new meters');

    // blank list value never clears
    await openImport(blank);
    eq(await page.locator('#bldgImportBtn').textContent(), 'Nothing new to import', 'blank Bill file: nothing to do');
    await page.evaluate(() => closeBldgImportModal());
    eq((await files())[0].split('~')[1], 'new-name.csv', 'blank list value did not clear the Bill file');

    // Import Bills matches by the new name
    await page.evaluate((pid) => openBillsMultiImportForProj(pid), PID);
    await page.setInputFiles('#billsMultiInput', [bill]);
    await page.waitForTimeout(600);
    const bp = await page.locator('#billsMultiPreviewTable').innerText();
    ok(!/No meter lists this file name/.test(bp), 'Import Bills: file matched a meter');
    await page.click('#billsMultiBtn');
    await page.waitForTimeout(600);
    eq((await files())[0].split('~')[2], '1', 'Import Bills stored 1 period on the meter');
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures.length ? 'FAIL\n' + failures.join('\n') : 'ok');
  console.log('passed ' + pass + ', failed ' + failures.length);
  process.exit(failures.length ? 1 : 0);
})();
