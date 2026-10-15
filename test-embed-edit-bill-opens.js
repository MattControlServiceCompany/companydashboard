// test-embed-edit-bill-opens.js
// Acceptance test: in Projects > project > Utility Data (the embed), a single-meter building's bill-row
// pencil opens "Edit Billing Period" with no "Could not find building" toast.
// 100% SYNTHETIC data, headless bundled Chromium. Run: node test-embed-edit-bill-opens.js (from the repo root)
const { launchBrowser } = require('./tools/launch-browser.js');
const SITE = 'file:///' + __dirname.split(String.fromCharCode(92)).join('/') + '/energy-department.html';
const PID = 999000555;
const failures = [];
const eq = (a, e, l) => { if (a !== e) failures.push(l + ': expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a)); };

(async () => {
  const context = await launchBrowser('embed-edit-bill');
  try {
    const page = await context.newPage();
    const seed = {
      en_projects: [{ id: PID, name: 'SYNTH EMBED EDIT', client: 'Synth', customerId: 'cust_' + PID, status: 'active',
        scope: { buildingIds: [], meterExcludeIds: [] }, savingsData: { measures: [] } }],
      en_customers: [{ id: 'cust_' + PID, name: 'Synth Customer' }],
      ch_qs_seen: 1, ch_theme: 'dark', ch_activeView: 'projects',
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
    // one building, ONE gas meter, one dated bill
    await page.evaluate((pid) => {
      addUDBldg('cust_' + pid, { id: 'synb1', name: 'Synth Hall', sqft: 1000, meters: [{ id: 'synm1', commodity: 'Gas', bills: [
        { id: 'synr1', start: '2025-01-01', end: '2025-01-31', commodity: 'Gas', naturalGasTherms: '500', gasCharge: '400.00', totalCost: '400.00', utilityCompany: 'Synth Gas' } ] }] });
      projects.find((x) => x.id === pid).scope.buildingIds.push('synb1');
      projUDSelectBldg(pid, 'synb1');
    }, PID);
    await page.waitForTimeout(1200);
    const pane = page.locator('#proj-ud-body-' + PID);
    eq(await pane.locator('button[title="Edit"]').count(), 1, 'one pencil in the embed');
    await pane.locator('button[title="Edit"]').click();
    await page.waitForTimeout(800);
    const out = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast,#toast,[class*=toast]')].map((e) => e.innerText).join('|'),
      modal: (document.body.innerText.match(/Edit Billing Period/g) || []).length,
    }));
    eq(/Could not find/.test(out.toast), false, 'no "Could not find" toast (got: ' + out.toast + ')');
    eq(out.modal > 0, true, 'Edit Billing Period window is open');
  } finally {
    await context.close();
  }
  if (failures.length) { console.error('FAIL test-embed-edit-bill-opens\n' + failures.join('\n')); process.exit(1); }
  console.log('PASS test-embed-edit-bill-opens');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
