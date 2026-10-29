// Synthetic-data test (headless bundled Chromium, file://) for the Cost Estimate "Price list" view.
// Checks: CSC price equals _pricingUnitPriceFor (the estimate-row resolver) for 3 SKUs; search, category filter, sort,
// count text, toggle button, empty-catalog message, money format. Run: node test-pricing-price-list.js [shotDir]
const { launchBrowser } = require('./tools/launch-browser.js');
const path = require('path');
const SITE = 'file:///' + __dirname.split(path.sep).join('/') + '/energy-department.html';
const PID = 999000444;
let pass = 0, fail = 0;
function eq(a, b, l) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.log('FAIL ' + l + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
}
const CAT = {
  'AAA-100': { list: 100, net: 18.1, desc: 'Test Sensor One', category: 'Sensors' },
  'BBB-200': { list: 1234.56, net: 223.46, desc: 'Test Controller Two', category: 'Controllers' },
  'TM-300': { list: 489, net: 88.51, desc: 'Modbus Stat Std', category: 'Sensors' },
  'ZZZ-400': { list: null, net: null, desc: 'No price item', category: 'Misc' },
};
(async () => {
  const ctx = await launchBrowser('pricelist', { viewport: { width: 1920, height: 1080 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await ctx.addInitScript((data) => { for (var k in data) window.localStorage.setItem(k, JSON.stringify(data[k])); }, {
      en_projects: [{ id: PID, name: 'SYNTHETIC', client: 'S', addr: '', type: 'Test', status: 'active', phase: '', contacts: [], savingsData: { measures: [] } }],
      ch_settings: { showQuickStart: false }, ch_theme: 'dark', ch_activeView: 'projects',
      ch_user: { name: 'Demo User', email: 'demo@example.com', initials: 'DU', isReal: false },
      en_pricing_catalog: CAT, ['en_pricing_est_type_' + PID]: 'retrofit',
      en_pricing_meta: { skuCount: 4, importedAt: '2026-06-22T12:00:00Z', file: 'x.csv' },
    });
    await page.goto(SITE);
    await page.waitForTimeout(2000);
    // pure functions
    const r = await page.evaluate((cat) => {
      const rows = _pricingPriceListRows(cat);
      const cfg = { priceBasis: 'contract' };
      const same = ['AAA-100', 'BBB-200', 'TM-300'].map((s) => rows.find((x) => x.sku === s).csc === _pricingUnitPriceFor(cat[s], cfg));
      const q = _pricingPriceListFilter(rows, 'tm', '', 'sku', true).map((x) => x.sku);
      const c = _pricingPriceListFilter(rows, '', 'Sensors', 'sku', true).map((x) => x.sku);
      const d = _pricingPriceListFilter(rows, 'st', 'Sensors', 'csc', false).map((x) => x.sku);
      const n = _pricingPriceListFilter(rows, '', '', 'csc', true).map((x) => x.sku);
      return { same, q, c, d, n, vals: rows.filter((x) => x.sku !== 'ZZZ-400').map((x) => x.csc) };
    }, CAT);
    eq(r.same, [true, true, true], 'CSC price == estimate resolver for 3 SKUs');
    eq(r.vals, [40, 493.82, 195.6], 'CSC prices = 0.4 x list');
    eq(r.q, ['TM-300'], 'search by SKU (case-insensitive)');
    eq(r.c, ['AAA-100', 'TM-300'], 'category filter');
    eq(r.d, ['TM-300', 'AAA-100'], 'search+category, csc desc');
    eq(r.n, ['AAA-100', 'TM-300', 'BBB-200', 'ZZZ-400'], 'asc sort, missing price last');
    // DOM
    await page.evaluate((pid) => { openDetail(pid); sPTab('cost-estimate', document.querySelector('.pdt[data-tab="cost-estimate"]')); }, PID);
    await page.waitForTimeout(2500);
    const lab = await page.evaluate((pid) => document.getElementById('ptab-cost-estimate-body-' + pid).innerText, PID);
    eq(/Price list: 4 items, imported Jun 2[12], 2026/.test(lab), true, 'label text');
    await page.click('#pricing-pl-btn-' + PID);
    await page.waitForTimeout(300);
    eq(await page.textContent('#pricing-pl-count-' + PID), 'Showing 4 of 4', 'count open');
    eq(await page.textContent('#pricing-pl-btn-' + PID), 'Hide price list', 'button label open');
    await page.fill('#pricing-pl-q-' + PID, 'TM');
    eq(await page.textContent('#pricing-pl-count-' + PID), 'Showing 1 of 4', 'count after search');
    const cells = await page.$$eval('#pricing-pl-body-' + PID + ' tr td', (t) => t.map((x) => x.textContent));
    eq(cells, ['TM-300', 'Modbus Stat Std', 'Sensors', '$489.00', '$195.60', '$88.51'], 'row cells and money format');
    const hdr = await page.textContent('#pricing-pl-' + PID + ' > div:first-child');
    eq(hdr, 'CSC price = 40% of list. Labor $170/hr.', 'header line from config');
    await page.click('#pricing-pl-head-' + PID + ' th:nth-child(6)');
    eq(await page.$$eval('#pricing-pl-head-' + PID + ' th', (t) => t[5].textContent.indexOf('\u25B2') >= 0), true, 'sort arrow');
    await page.click('#pricing-pl-btn-' + PID);
    eq(await page.isVisible('#pricing-pl-' + PID), false, 'closes');
    // empty catalog
    await page.evaluate(async (pid) => { await sset('en_pricing_catalog', null); await sset('en_pricing_meta', null); _pricingPLGetState(pid).open = true; document.getElementById('pricing-pl-' + pid) && (document.getElementById('pricing-pl-' + pid).innerHTML = _pricingPriceListInnerHTML(pid)); }, PID);
    eq(await page.textContent('#pricing-pl-' + PID), 'No price list loaded. Use Import Pricing CSV.', 'empty message');
    eq(errs, [], 'no page errors');
  } finally { await ctx.close(); }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
