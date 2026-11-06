// tools/test-report-word-table-widths.js: the Word (.docx) column widths of the quarterly report tables are pinned for the Q2-structure quarterly report (rebuilt 2026-11-06): the results table, the quarterly usage summary, the annual summary by building and the Appendix B detail tables. The old meter, EUI and monthly-quarter tables are gone from the report.
// Run: CH_TMP_ROOT=<scratch> node tools/test-report-word-table-widths.js
// Builds the quarterly report from SYNTHETIC data in headless bundled Chromium, translates its pages to Word XML with the
// export's own functions, and compares each Building table's <w:tblGrid> with the pinned values. The PDF widths
// (tools/test-report-table-fit.js) are separate. The export sets data-dx-live-widths on every page, so the Word widths follow the widths the live page shows (data-dx-w), raised to the whole-word minimums.
'use strict';
const EXPECTED = {
 "Building|Square|||Feet|Baseline|||Cost|Projected|||Cost|Actual|||Cost|Q2 2025|||Savings Measured|Percent of|||Baseline Cost|Status": "1713,1008,1109,1311,1109,1210,1109,1511",
 "Quarter|Baseline|||kWh|Actual|||kWh|Baseline|||Therms|Actual|||Therms|Baseline|||Gallons|Actual|||Gallons|Baseline|||Cost|Actual|||Cost|Savings|||Measured": "1010,1031,927,1031,938,1031,1004,1031,926,1151",
 "Period|kWh|kW|Therms|Propane|||Gallons|Cost|Site EUI|||kBtu/ft\u00b2 (Q2 2025)|Savings vs|||Baseline": "1311,1210,1008,1109,1210,1210,1814,1208",
 "Building|Year|kWh|kW|Therms|Propane Gallons|Cost|Site EUI|||kBtu/ft\u00b2 (Q2 2025)": "2506,1078,635,496,927,1940,674,1824",
 "Month|Days|BL Therms|Act Therms|Therms Saved|%|$/Therm|Therm Sav $": "1260,1260,1260,1260,1260,1260,1260,1260",
 "Month|Days|BL Gal|Act Gal|Gal Saved|%|$/Gallon|Gallon Sav $": "1260,1260,1260,1260,1260,1260,1260,1260",
 "Month|Cooling degree days (2025)|Baseline billed kW|Actual billed kW|Change kW": "2418,2218,1814,1814,1816"
};
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
const PROJ = 900001;
function bills(base, elec) { const out = []; let i = 0; for (let y = 2024; y <= 2025; y++) for (let mo = 1; mo <= 12; mo++) { if (y === 2025 && mo > 6) break; const ym = y + '-' + String(mo).padStart(2, '0'); const last = new Date(y, mo, 0).getDate(); const u = base + i * 10; const b = { id: 'b' + ym + base, start: ym + '-01', end: ym + '-' + last, totalCost: u * 0.1 }; if (elec) { b.kwh = u; b.demandKW = 50; } else b.therms = u; out.push(b); i++; } return out; }
function prop() { const out = []; for (let y = 2024; y <= 2025; y++) for (let mo = 1; mo <= 12; mo++) { if (y === 2025 && mo > 3) break; const ym = y + '-' + String(mo).padStart(2, '0'); const last = new Date(y, mo, 0).getDate(); out.push({ id: 'p' + ym, start: ym + '-01', end: ym + '-' + last, gallonsDelivered: 100, totalCost: 200 }); } return out; }
const BL = []; for (let m = 1; m <= 12; m++) BL.push('2024-' + String(m).padStart(2, '0'));
const meter = (id, c, base, x) => Object.assign({ id, commodity: c, account: 'A-' + id, meter: 'M-' + id, bills: bills(base, c === 'Electric'), baseline: { months: BL.slice() }, inclusive: false }, x || {});
const names = ['Sample Valley Elementary School', 'Test Ridge High School', 'Demo Meadow Grove Elementary', 'Example Field House'];
const blds = names.map((n, i) => ({ id: 'b' + i, name: n, sqft: 40000 + i * 5000, meters: [meter('e' + i, 'Electric', 10000 + i * 900), meter('g' + i, 'Gas', 1000 + i * 70), meter('p' + i, 'Propane', 100, { bills: prop() })] }));
const fixture = { en_projects: [{ id: PROJ, name: 'Synthetic District', client: 'Synthetic District', type: 'K-12', start: '2025-01-01' }], ['en_utility_' + PROJ]: { buildings: blds }, ['en_eqmatrix_' + PROJ]: { rows: [], importedAt: null, buildings: names } };
(async () => {
  const ctx = await launchBrowser('word-table-widths');
  try {
    const page = await ctx.newPage();
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.addInitScript((fx) => { if (!sessionStorage.getItem('seeded')) { for (const k in fx) localStorage.setItem(k, JSON.stringify(fx[k])); sessionStorage.setItem('seeded', '1'); } }, fixture);
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateReportHTML === 'function' && typeof _docxTranslatePages === 'function' && typeof collectReportData === 'function', null, { timeout: 30000 });
    const res = await page.evaluate(async ([PROJ, fx]) => {
      let data = null;
      for (let i = 0; i < 50 && !data; i++) {
        for (const k in fx) localStorage.setItem(k, JSON.stringify(fx[k]));
        projects = JSON.parse(localStorage.getItem('en_projects')) || [];
        try { _selfHealCustomersAndScope(); } catch (e) {}
        projects = JSON.parse(localStorage.getItem('en_projects')) || [];
        (JSON.parse(localStorage.getItem('en_customers')) || []).forEach((c) => { const ud = JSON.parse(localStorage.getItem('en_utility_' + c.id) || 'null'); if (ud) utilityData[c.id] = ud; });
        try { data = collectReportData(PROJ, null, null, 'quarterly', { quarter: 2, year: 2025 }, null); } catch (e) {}
        if (!data) await new Promise((r) => setTimeout(r, 200));
      }
      window._currentReportData = data;
      let html = generateReportHTML(data, null);
      if (html && html.html) html = html.html;
      const host = document.createElement('div'); host.id = 'reportPages'; host.innerHTML = html; document.body.appendChild(host);
      const pages = [...host.querySelectorAll('.rpt-page')];
      const clones = pages.map((p) => { const c = p.cloneNode(true); _docxStampLiveStyles(p, c); c.setAttribute('data-dx-live-widths', '1'); ['.rpt-footer','.rpt-footer-label','.rpt-pg-footer-pagenum','.rpt-small-hdr','.csc-header-img','.sc-export-bar'].forEach((s) => c.querySelectorAll(s).forEach((e) => e.remove())); c.querySelectorAll('canvas,svg').forEach((e) => e.remove()); return c; });
      const tr = _docxTranslatePages(clones);
      const xml = tr.xml;
      const tables = [];
      const re = /<w:tbl>[\s\S]*?<\/w:tbl>/g; let m;
      while ((m = re.exec(xml))) {
        const t = m[0];
        const grid = (/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(t) || [,''])[1].match(/w:w="(\d+)"/g) || [];
        const firstRow = (/<w:tr[ >][\s\S]*?<\/w:tr>/.exec(t) || [''])[0];
        const tcw = (firstRow.match(/<w:tcW [^>]*>/g) || []);
        const lay = (/<w:tblLayout[^>]*>/.exec(t) || [''])[0];
        const w = (/<w:tblW [^>]*>/.exec(t) || [''])[0];
        const text = (firstRow.match(/<w:t[ >][^<]*/g) || []).map((x) => x.replace(/<w:t[^>]*>/, '')).join('|');
        // first body-row first cell text
        tables.push({ head: text, grid: grid.join(','), tcw: tcw.join(''), lay, w, nrows: (t.match(/<w:tr[ >]/g) || []).length });
      }
      return { tables, pages: pages.length };
    }, [PROJ, fixture]);
    let fails = 0;
    for (const k of Object.keys(EXPECTED)) {
      const t = res.tables.find((x) => x.head === k);
      const got = t ? t.grid.replace(/w:w="/g, '').replace(/"/g, '') : 'missing';
      const okk = got === EXPECTED[k];
      if (!okk) fails++;
      console.log((okk ? 'PASS ' : 'FAIL ') + k.slice(0, 50) + ' ' + got + (okk ? '' : ' expected ' + EXPECTED[k]));
    }
    console.log(fails ? fails + ' FAILED' : 'ALL PASS');
    process.exitCode = fails ? 1 : 0;
  } finally { await ctx.close(); }
})().catch((e) => { console.log('ERR', e); process.exit(1); });
