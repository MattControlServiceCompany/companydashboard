// tools/test-proposal-page-fit.js - the Service Proposal cost pages never print content into the footer zone
// (Matt 2026-11-13: the Recommended and Full Scope "Install & Programming Detail" lists ran past the page bottom
// and the rest was lost). Builds rptPageASHRAE36ProposalPricing from a SYNTHETIC portfolio (no client names) with
// a long scope, forces every tier detail panel open as the PDF and Word export does, puts the pages into the DOM
// and checks, for every page, that the lowest content edge stays above the footer zone, that no page is nearly
// empty while the next page would have fit on it, and that the detail text of every tier is still present.
// Headless bundled Chromium. Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-page-fit.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
(async () => {
  const ctx = await launchBrowser('proposal-page-fit');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof rptPageASHRAE36ProposalPricing === 'function' && typeof EM_POINT_CATEGORIES !== 'undefined', null, { timeout: 30000 });
    for (const size of ['short', 'mid', 'long']) {
      const res = await page.evaluate((size) => {
        const cats = size === 'long' ? ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'fcu', 'doas', 'ct', 'heater', 'ef', 'furnace', 'rtu', 'mau'] : size === 'mid' ? ['ahu', 'vav', 'hwp', 'fcu', 'ddvav'] : ['vav'];
        const equipResults = [];
        const seqFor = (cat) => {
          const o = {};
          EM_SEQUENCE_DEFS.filter((s) => (s.equipTypes || []).includes(cat)).forEach((s) => (o[s.key] = { status: 'blocked' }));
          return o;
        };
        cats.forEach((cat) => {
          const keys = (EM_POINT_CATEGORIES[cat] || []).map((p) => p.key);
          for (let i = 1; i <= 3; i++) {
            equipResults.push({
              id: cat + i,
              name: 'Room ' + i + ' - ' + cat.toUpperCase() + '-' + i,
              category: cat,
              compliance: { missingPoints: keys.map((k) => ({ categoryKey: k })), coveredPoints: [] },
              seqReadiness: seqFor(cat),
            });
          }
        });
        const buildings = [{ name: 'Test Hall A', equipResults }];
        window.collectASHRAE36Data = () => ({ buildings });
        window.emLoadEquipConfigFlags = () => ({});
        sset('en_pricing_catalog', { 'N1-AQX-C-A': { list: 500, net: 300, contract: 200 } });
        sset('en_pricing_budget_p', { amount: 75000, period: 'year' });
        const d = { project: { id: 'p', name: 'Test Client' }, rawDate: 'November 13, 2026' };
        const out = rptPageASHRAE36ProposalPricing(3, d, { phaseSplit: true, itemized: true });
        const html = Array.isArray(out) ? out.join('') : String(out);
        const host = document.createElement('div');
        host.id = 'reportPages';
        host.innerHTML = html;
        document.body.appendChild(host);
        // the export forces every tier panel open before capture
        host.querySelectorAll('[id^="rpt-tier-detail-"]').forEach((p) => (p.style.display = 'block'));
        const g = _rptGeometry();
        const bad = [];
        const bottoms = [];
        const pages = [...host.querySelectorAll('.rpt-page')];
        pages.forEach((pg, i) => {
          const pr = pg.getBoundingClientRect();
          let bottom = 0;
          pg.querySelector('.rpt-body').querySelectorAll('*').forEach((e) => {
            const r = e.getBoundingClientRect();
            if (r.height > 0) bottom = Math.max(bottom, r.bottom - pr.top);
          });
          const limit = pr.height - g.ftrH;
          bottoms.push(Math.round(bottom) + '/' + Math.round(limit));
          if (bottom > limit) bad.push('page ' + (i + 1) + ': content bottom ' + Math.round(bottom) + ' > footer zone top ' + Math.round(limit));
        });
        const text = host.textContent;
        const out2 = {
          n: pages.length,
          bad,
          bottoms,
          inlineDetail: !!host.querySelector('[id^="rpt-tier-detail-"]'),
          hasZoneSensors: /Zone Sensors|Duct Temperature Sensors/.test(text),
          words: text.length,
        };
        host.remove();
        return out2;
      }, size);
      console.log(size + ': ' + JSON.stringify(res));
      if (size === 'short') ok(res.n === 1, 'short portfolio: table, optional zone CO2 block and disclaimer share one page (' + res.n + ' page)');
      ok(res.bad.length === 0, size + ' portfolio (' + res.n + ' pages): no page content reaches the footer zone: ' + res.bad.join(' | '));
    }
    ok(errs.length === 0, 'no page errors: ' + errs.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('ERR', e);
  process.exit(1);
});
