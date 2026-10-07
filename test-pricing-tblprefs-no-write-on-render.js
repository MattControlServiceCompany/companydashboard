// Real-browser test (synthetic data, headless bundled Chromium, file://): rendering the Cost Estimate
// table with no stored prefs must send 0 DB.set writes; a column resize/hide sends writes; stored prefs are kept.
// Run: node test-pricing-tblprefs-no-write-on-render.js [screenshot.png]
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const fs = require('fs');
const REPO = __dirname;
const SITE = 'file:///' + REPO.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000333;
let pass = 0,
  fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
(async () => {
  const ctx = await launchBrowser('tblprefs', { viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await ctx.addInitScript((data) => {
      for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k]));
    }, {
      en_projects: [{ id: PID, name: 'SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
      ch_qs_seen: 1, ch_theme: 'dark', ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
    });
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      window.__sets = [];
      const orig = window.DB.set.bind(window.DB);
      window.DB.set = function (k, v) {
        if (k.indexOf('ch_tbl_') === 0) window.__sets.push(k);
        return orig(k, v);
      };
    });
    const sets = () => page.evaluate(() => window.__sets.length);
    // 1. no stored prefs: render + migrate -> 0 writes
    await page.evaluate((pid) => {
      openDetail(pid);
      sPTab('cost-estimate', document.querySelector('.pdt[data-tab="cost-estimate"]'));
    }, PID);
    await page.waitForTimeout(2500);
    await page.evaluate((pid) => { _pricingMigrateColSchema(pid); initCostEstimateTab(pid); }, PID);
    await page.waitForTimeout(1000);
    eq(await sets(), 0, 'render with no stored prefs: 0 writes');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    // 2. user resize: one write to widths (and marks schema)
    await page.evaluate((pid) => { var w = _pricingGetColWidths(pid); w[2] = 150; _pricingSetColWidths(pid, w); }, PID);
    const w2 = await page.evaluate(() => window.__sets.filter((k) => k.indexOf('col_widths') > 0).length);
    eq(w2, 1, 'resize: 1 widths write');
    // 3. after user edit, render keeps the width and does not shift it
    await page.evaluate(() => { window.__sets.length = 0; });
    await page.evaluate((pid) => { _pricingMigrateColSchema(pid); initCostEstimateTab(pid); }, PID);
    eq(await sets(), 0, 'render after user edit: 0 writes');
    eq(await page.evaluate((pid) => _pricingGetColWidths(pid), PID), { 2: 150 }, 'stored width kept');
    // 4. legacy stored widths (no marker) are still migrated (existing prefs kept, relocated)
    await page.evaluate(async (pid) => {
      await window.DB.remove('ch_tbl_colschema_ver_pricing_tbl_' + pid);
      await window.DB.set('ch_tbl_col_widths_pricing_tbl_' + pid, { 2: 150, 10: 90 });
      window.__sets.length = 0;
    }, PID);
    await page.evaluate((pid) => _pricingMigrateColSchema(pid), PID);
    eq(await page.evaluate((pid) => _pricingGetColWidths(pid), PID), { 2: 150, 12: 90 }, 'legacy widths migrated v1->v3');
    eq(errs.filter((e) => e.indexOf('PHASE OVER') >= 0).length, 0, 'no console.error PHASE OVER');
  } finally {
    await ctx.close();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
