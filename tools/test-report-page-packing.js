// tools/test-report-page-packing.js - the quarterly report packs the pages after the core pages (Matt 2026-11-06):
// a group starts a new page, units flow onto a page while they fit, no page of a group is left part empty when the next
// unit would have fit, every page body stays in the budget, and an unchecked section leaves no empty page.
// SYNTHETIC data, headless bundled Chromium. Run: CH_TMP_ROOT=<scratch> node tools/test-report-page-packing.js
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
  const ctx = await launchBrowser('report-page-packing');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _rptQuarterReportHTML === 'function' && typeof REPORT_SECTIONS !== 'undefined', null, { timeout: 30000 });
    const res = await page.evaluate(() => {
      const yms = ['2026-07', '2026-08', '2026-09'];
      const mon = (ym, sav) => ({ month: ym, bl: 1000, cur: 1100, blCost: 900, curCost: 800, savings: sav, kwhBl: 1000, kwhCur: 1100, kwBl: 10, kwCur: 11 });
      const com = (k) => ({
        monthly: yms.map((ym, i) => mon(ym, 10 + i)),
        kwhBl: 3000, kwhCur: 3300, kwBl: 30, kwCur: 33, thermsBl: 3000, thermsCur: 3300, galBl: 3000, galCur: 3300,
        costBl: 2700, costCur: 2400, costSaved: 33, kwCostSaved: 3,
      });
      const bld = (name) => ({
        id: name, name, sqft: 100000, status: 'on_track', savings: 33, savingsPct: 3, blCost: 8100, curCost: 7200, type: 'K-12 School',
        commodities: ['Electric', 'Gas', 'Propane'],
        electric: com(), gas: com(), propane: com(),
        eui: { baseline: 41.1, current: 31.1, cbecs: 48.5 }, euiQ: { baseline: 10, current: 11 },
        euiWindow: { first: '2026-01', last: '2026-09', months: 9 }, meterDetails: [], baselineMaps: { elecByMo: {}, gasByMo: {}, propaneByMo: {}, waterByMo: {} }, blMonths: [],
      });
      const d = {
        period: { type: 'quarterly', quarter: 3, year: 2026, label: 'Q3 2026', yearMonths: yms, start: '2026-07', end: '2026-09' },
        project: { id: 'p1', client: 'Test Client', name: 'Test Project', sqft: 200000, blStart: '2025-01', blEnd: '2025-12' },
        contract: { quarterlyTargets: [1111, 1111, 1111, 1111], quarterlyActuals: [1111, 1111, 1111], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3, actualsThroughQuarter: 3 },
        totals: { savings: 99, blCost: 16200, curCost: 14400, kwhBl: 6000, kwhCur: 6600, thermsBl: 6000, thermsCur: 6600, propaneBl: 6000, propaneCur: 6600, euiBaseline: 41.1, euiCurrent: 31.1, euiBaselineQ: 10, euiCurrentQ: 11, euiPeriodLabel: 'Jan 2026 to Sep 2026', weatherWaiting: [] },
        buildings: ['Building A', 'Building B', 'Building C', 'Building D', 'Building E', 'Building F'].map(bld),
        weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
        rawBills: [{ bid: 'Building A', building: 'Building A', commodity: 'Electric', account: 'ZZ9', ym: '2026-07', kwh: 1100, amount: 800, kw: 11 }], approvedChanges: [{ completedDate: '2026-08-01', building: 'Building A', proposedChange: 'Set point change', approvedBy: 'Test', source: 'Change Order' }],
      };
      const on = {};
      REPORT_SECTIONS.forEach((s) => (on[s.key] = true));
      const groupOf = {};
      REPORT_SECTIONS.forEach((s) => (groupOf[s.key] = s.group));
      const analyse = (opts) => {
        const html = _rptQuarterReportHTML(d, opts);
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-9999px;top:0;width:816px';
        host.innerHTML = html;
        document.body.appendChild(host);
        const pages = [...host.querySelectorAll('.rpt-page')].map((p) => {
          const body = p.querySelector('.rpt-body');
          const subs = body ? [...body.children].filter((c) => c.hasAttribute('data-subsection')) : [];
          return {
            title: (p.querySelector('.rpt-pg-title') || {}).textContent || '',
            keys: subs.map((c) => c.getAttribute('data-subsection')),
            h: body ? _rptQMeasureH(body.innerHTML) : 0,
            firstUnitH: subs.length ? _rptQMeasureH(subs[0].outerHTML) : 0,
            empty: body ? body.textContent.trim() === '' : false,
          };
        });
        host.remove();
        return { pages, html };
      };
      const r = analyse(on);
      const packed = r.pages.filter((p) => p.keys.length);
      const out = { count: r.pages.length, budget: RPT_Q_PAGE_BODY_PX, mixed: [], over: [], waste: [], low: [], unmade: [], pageNums: [] };
      packed.forEach((p, i) => {
        const g = new Set(p.keys.map((k) => groupOf[k]));
        if (g.size > 1) out.mixed.push(i);
        if (p.h > RPT_Q_PAGE_BODY_PX) out.over.push(i);
        const nx = packed[i + 1];
        if (nx && groupOf[nx.keys[0]] === groupOf[p.keys[0]]) {
          if (p.h + nx.firstUnitH <= RPT_Q_PAGE_BODY_PX) out.waste.push(p.title + ' then ' + nx.title);
          if (p.h < RPT_Q_PAGE_BODY_PX / 2) out.low.push(p.title + ' ' + Math.round(p.h));
        }
      });
      const total = (r.html.match(/Page \d+ of (\d+)/) || [])[1];
      out.total = Number(total);
      out.pageNums = [...r.html.matchAll(/Page (\d+) of \d+/g)].map((m) => Number(m[1]));
      out.packedCount = packed.length;
      out.titles = packed.map((p) => p.title);
      // unchecking a section removes its blocks and leaves no empty page
      REPORT_SECTIONS.filter((s) => s.flow).forEach((s) => {
        const o2 = Object.assign({}, on);
        o2[s.key] = false;
        const a = analyse(o2);
        const still = a.pages.some((p) => p.keys.indexOf(s.key) >= 0);
        if (still || a.pages.some((p) => p.empty)) out.unmade.push(s.key);
      });
      out.coreFirst = r.pages.slice(0, 7).map((p) => p.title);
      return out;
    });
    console.log(JSON.stringify({ count: res.count, packed: res.packedCount, titles: res.titles }));
    ok(res.packedCount > 0 && res.count < 7 + res.packedCount + 2, 'pages after the core pages are packed (' + res.packedCount + ' packed pages)');
    ok(res.mixed.length === 0, 'a page never mixes two sidebar groups: ' + res.mixed.join(','));
    ok(res.over.length === 0, 'every packed page body is inside the budget ' + res.budget + 'px: ' + res.over.join(','));
    ok(res.waste.length === 0, 'no page leaves room for the first block of the next page of its group: ' + res.waste.join(' | '));
    ok(res.low.length === 0, 'no page that is not the last of its group is under half full: ' + res.low.join(' | '));
    ok(res.unmade.length === 0, 'unchecking a section removes its blocks and leaves no empty page: ' + res.unmade.join(','));
    ok(res.pageNums.every((n, i) => n === i + 1) && res.pageNums.length === res.total, 'the page numbers run 1 to ' + res.total);
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
