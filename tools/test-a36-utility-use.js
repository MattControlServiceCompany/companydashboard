// tools/test-a36-utility-use.js: the 12-month utility use in the Audit Report (2026-11-18). SYNTHETIC names and values only; headless bundled
// Chromium; no network.
// Rules tested: each per-building page has one prose line "<period> utility use: N kWh and N therms, $N. Floor area N ft2. Energy Use Intensity
// (EUI) N kBtu/ft2." (no gas meter: "(electric only)"; no utility data: no line); ONE comparison page "Utility Use by <noun>" follows the last
// per-building page: a sentence, one table sorted by EUI high to low, a total row whose EUI is computePeriodEUI of the summed kBtu and area;
// with fewer than 2 buildings that have data there is no comparison page.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-utility-use.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('a36-utility-use');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app|localhost/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && typeof buildingAnnualUse === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const r = await page.evaluate(async () => {
      const PID = 900031;
      const ahu = (id, b, name) => ({ id, building: b, category: 'ahu', equipName: name, location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F' } });
      const rows = [ahu('r1', 'Alpha Library', 'AHU-1'), ahu('r2', 'Beta Library', 'AHU-2'), ahu('r3', 'Gamma Library', 'AHU-3'), ahu('r4', 'Delta Library', 'AHU-4')];
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library', 'Gamma Library', 'Delta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const last = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
      const bills = (kind, a, z, perMonth, cost) =>
        presentedMonthRange(a, z).map((ym) => {
          const b = { start: ym + '-01', end: ym + '-' + last(ym), totalCost: cost / 12, estimated: true };
          if (kind === 'g') b.naturalGasTherms = perMonth;
          else b.kwh = perMonth;
          return b;
        });
      const mk = (name, sqft, kwhYear, thermsYear, cost, months) => ({
        id: 'b' + name,
        name,
        sqft,
        meters: [{ id: 'e' + name, commodity: 'Electric', bills: bills('e', months[0], months[1], kwhYear / 12, cost * 0.8) }].concat(
          thermsYear == null ? [] : [{ id: 'g' + name, commodity: 'Gas', bills: bills('g', months[0], months[1], thermsYear / 12, cost * 0.2) }],
        ),
      });
      // Alpha: gas; Beta: no gas meter; Gamma: 11 months only (no use shown); Delta: no meters at all
      const ud = [mk('Alpha Library', 20000, 240000, 6000, 36000, ['2023-01', '2025-12']), mk('Beta Library', 10000, 60000, null, 9000, ['2025-01', '2025-12']), mk('Gamma Library', 5000, 30000, 1200, 5000, ['2025-02', '2025-12']), { id: 'bDelta', name: 'Delta Library', sqft: 8000, meters: [] }];
      const realGet = getUDBldgs;
      window.getUDBldgs = (pid) => (pid === PID ? ud : realGet(pid));
      window.getUDBldg = (pid, bid) => getUDBldgs(pid).find((b) => b.id === bid);
      const out = { PID };
      const build = () => {
        const data = collectASHRAE36Data(PID, '2026-11-10', null);
        const html = generateASHRAE36AuditHTML(data, { cover: true, executive: true, building: true, costEstimate: false });
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const secs = Array.from(doc.querySelectorAll('.rpt-page')).map((p) => ({ sec: p.getAttribute('data-section'), text: p.textContent.replace(/\s+/g, ' ').trim(), html: p.innerHTML }));
        return { data, secs };
      };
      const a = build();
      out.secs = a.secs.map((s) => s.sec);
      out.pages = a.secs.map((s) => s.text);
      out.htmls = a.secs.map((s) => s.html);
      const alpha = buildingAnnualUse(PID, 'bAlpha Library');
      const beta = buildingAnnualUse(PID, 'bBeta Library');
      out.alpha = alpha;
      out.beta = beta;
      // Word: the history charts of a building page become pictures (the shared chart swap), gauge rings untouched
      const alphaHtml = out.htmls.find((h, i) => out.secs[i] === 'building' && /Alpha Library/.test(out.pages[i]) && /Annual Energy Use/.test(out.pages[i]));
      const holder = document.createElement('div');
      holder.innerHTML = alphaHtml;
      document.body.appendChild(holder);
      out.bars = Array.from(holder.querySelectorAll('svg[data-use-history]')).map((s) => s.querySelectorAll('rect').length);
      out.svgBefore = holder.querySelectorAll('svg[data-use-history]').length;
      await _rptSwapUseHistoryChartsForPng([holder]);
      out.svgAfter = holder.querySelectorAll('svg[data-use-history]').length;
      out.imgAfter = holder.querySelectorAll('img[src^="data:image/png"]').length;
      holder.remove();
      out.expTotEui = computePeriodEUI(computeKBtu(alpha.kwh + beta.kwh, alpha.therms, 0), 12, alpha.sqft + beta.sqft);
      // only one building with data: no comparison page
      ud.splice(1, 1);
      const b = build();
      out.secs1 = b.secs.map((s) => s.sec);
      out.pages1 = b.secs.map((s) => s.text);
      out.rowsOf = (i) => null;
      const cmp = out.htmls.findIndex((h, i) => /Utility Use by Library/.test(out.pages[i]));
      const dd = new DOMParser().parseFromString('<div>' + out.htmls[cmp] + '</div>', 'text/html');
      out.trs = Array.from(dd.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent.trim()));
      delete out.rowsOf;
      return out;
    });

    const bldPages = r.pages.filter((t, i) => r.secs[i] === 'building');
    const titleIdx = r.pages.findIndex((t) => /Utility Use by Library/.test(t));
    ok(titleIdx >= 0, 'the comparison page "Utility Use by Library" exists');
    ok(r.secs[titleIdx] === 'building' && r.secs.lastIndexOf('building') === titleIdx, 'it is the last page of the per-building group (after every building page)');
    ok(r.pages.slice(0, titleIdx).filter((t) => /Alpha Library/.test(t) && /Energy Use Intensity \(2025\)/.test(t)).length === 1, 'Alpha Library page has the utility card');
    const histPages = r.htmls.filter((h, i) => r.secs[i] === 'building');
    const alphaHist = r.htmls.find((h, i) => r.secs[i] === 'building' && /Alpha Library/.test(r.pages[i]) && /Annual Energy Use/.test(r.pages[i]));
    const bars = r.bars;
    ok(/Annual Energy Use, 2023–2025/.test(r.pages.find((t, i) => r.secs[i] === 'building' && /Annual Energy Use/.test(t))), 'building with 3 years: heading "Annual Energy Use, 2023-2025"');
    ok(bars.length === 2 && bars[0] === 3 && bars[1] === 3, 'building with 3 years and gas: two charts of 3 bars each: ' + JSON.stringify(bars));
    ok(r.pages.filter((t, i) => r.secs[i] === 'building' && /Annual Energy Use/.test(t)).length === 1, 'only the building with 2 or more complete years has the chart (1 year, 11 months, no meters: none)');
    ok(r.svgBefore === 2 && r.svgAfter === 0 && r.imgAfter === 2, 'Word: both history charts become PNG pictures: ' + JSON.stringify([r.svgBefore, r.svgAfter, r.imgAfter]));
    ok(!/finding/i.test(r.pages.find((t, i) => r.secs[i] === 'building' && /Annual Energy Use/.test(t)) || ''), 'the chart page has no "finding" text');
    void histPages;
    const alphaPage = r.pages.find((t, i) => r.secs[i] === 'building' && /Alpha Library/.test(t) && /Energy Use Intensity \(2025\)/.test(t));
    ok(/240,000 kWh, 6,000 therms\s*\$36,000, [\d,]+ ft²/.test(alphaPage) && !/Outdoor air sensors/.test(alphaPage), 'card with gas replaces the outdoor air card: ' + (alphaPage.match(/Energy Use Intensity[\s\S]{0,120}/) || [''])[0]);
    ok(/Energy Use Intensity \(2025\)\s*\d+\.\d kBtu\/ft²/.test(alphaPage) && /20,000 ft²/.test(alphaPage), 'card value is the intensity; the floor area is in the note');
    const betaPage = r.pages.find((t, i) => r.secs[i] === 'building' && /Beta Library/.test(t) && /Energy Use Intensity \(2025\)/.test(t));
    ok(/60,000 kWh, electric only\s*\$7,200, [\d,]+ ft²/.test(betaPage) && !/Outdoor air sensors/.test(betaPage), 'card with no gas meter replaces the outdoor air card');
    ok(!r.pages.some((t, i) => r.secs[i] === 'building' && /Gamma Library/.test(t) && /Energy Use Intensity \(/.test(t)), 'an 11-month building has no utility card');
    ok(!r.pages.some((t, i) => r.secs[i] === 'building' && /Delta Library/.test(t) && /Energy Use Intensity \(/.test(t)), 'a building with no meters has no utility card');
    const t = r.pages[titleIdx];
    ok(/In 2025 the 2 libraries used 300,000 kWh of electricity and 6,000 therms of gas, at a cost of \$43,200\./.test(t), 'context sentence: ' + (t.match(/In 2025.*?\./) || [''])[0]);
    ok(/Energy Use Intensity \(EUI\) ranges from [\d.]+ kBtu\/ft² at \w+ Library to [\d.]+ at \w+ Library\./.test(t), 'range sentence');
    const html = r.htmls[titleIdx];
    const trs = r.trs;
    ok(trs.length === 3 && trs[2][0] === 'Total', 'two library rows and a total row: ' + JSON.stringify(trs.map((x) => x[0])));
    const euis = trs.slice(0, 2).map((x) => parseFloat(x[6]));
    ok(euis[0] >= euis[1], 'sorted by EUI high to low: ' + euis.join(', '));
    ok(trs[2][6] === r.expTotEui.toFixed(1), 'total EUI = computePeriodEUI of the summed kBtu and area: ' + trs[2][6] + ' vs ' + r.expTotEui.toFixed(1));
    const noGasRow = trs.find((x) => x[0] === 'Beta Library');
    ok(noGasRow && noGasRow[3] === '—' && /No gas meter on file/.test(t), 'no gas meter: dash in the gas cell and a footnote');
    ok(/Floor area \(ft²\)/.test(t) && /Electric \(kWh\)/.test(t) && /Gas \(therms\)/.test(t) && /Cost \(\$\)/.test(t) && /Cost per ft² \(\$\)/.test(t) && /EUI \(kBtu\/ft²\)/.test(t), 'column headers with symbols');
    ok(/background:var\(--rpt-blue\)/.test(html) && /text-align:right/.test(html), 'blue header row and right-aligned numbers');
    ok(!/finding|ASHRAE/i.test(t), 'the page has no "finding" and no "ASHRAE" text');
    ok(!r.pages1.some((x) => /Utility Use by Library/.test(x)), 'one building with data: no comparison page');
    ok(r.pages1.some((x, i) => r.secs1[i] === 'building' && /Energy Use Intensity \(2025\)/.test(x)), 'one building with data: its card still prints');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    void bldPages;
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
