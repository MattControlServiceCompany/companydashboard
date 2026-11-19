// tools/test-a36-utility-use.js: the 12-month utility use in the Audit Report (2026-11-18). SYNTHETIC names and values only; headless bundled
// Chromium; no network.
// Rules tested: each per-building page has the Energy Use Intensity card (no gas meter: "electric only"; no utility data: no card; no per-building
// yearly chart); ONE comparison page "Utility Use by <noun>" follows the last per-building page: a sentence, one table sorted by EUI high to low, a
// total row whose EUI is computePeriodEUI of the summed kBtu and area, footnote "Electric only."; with fewer than 2 buildings that have data there is
// no comparison page. (Matt 2026-11-18) ONE page "Utility Use Across the <nouns>" at the end (before the appendices): ranking bars of the EUI of the
// last complete year (highest first, value labels, median line, axis from zero, electric-only marked), a heat map of the percent change of the total
// energy against the first complete year (cells with % text), result titles computed from the data, no monthly values; both charts become pictures in Word.
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
      // fac = a use factor per year (the other years use the stated yearly value)
      const bills = (kind, a, z, perMonth, cost, fac) =>
        presentedMonthRange(a, z).map((ym) => {
          const b = { start: ym + '-01', end: ym + '-' + last(ym), totalCost: cost / 12, estimated: true };
          const v = perMonth * ((fac && fac[ym.slice(0, 4)]) || 1);
          if (kind === 'g') b.naturalGasTherms = v;
          else b.kwh = v;
          return b;
        });
      const mk = (name, sqft, kwhYear, thermsYear, cost, months, fac) => ({
        id: 'b' + name,
        name,
        sqft,
        meters: [{ id: 'e' + name, commodity: 'Electric', bills: bills('e', months[0], months[1], kwhYear / 12, cost * 0.8, fac) }].concat(
          thermsYear == null ? [] : [{ id: 'g' + name, commodity: 'Gas', bills: bills('g', months[0], months[1], thermsYear / 12, cost * 0.2, fac) }],
        ),
      });
      // Alpha: gas, 2023 to 2025 (2023 uses 1.25 and 2024 uses 1.1 times 2025: 2025 is -20 percent against 2023); Beta: no gas meter, 2024 uses 0.8 times
      // 2025 (+25 percent); Gamma: 11 months only (no use shown); Delta: no meters at all
      const ud = [mk('Alpha Library', 20000, 240000, 6000, 36000, ['2023-01', '2025-12'], { 2023: 1.25, 2024: 1.1 }), mk('Beta Library', 10000, 60000, null, 9000, ['2024-01', '2025-12'], { 2024: 0.8 }), mk('Gamma Library', 5000, 30000, 1200, 5000, ['2025-02', '2025-12']), { id: 'bDelta', name: 'Delta Library', sqft: 8000, meters: [] }];
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
      // Word: both charts of the utility page become pictures (the shared chart swap)
      const uaIdx = out.pages.findIndex((t) => /Utility Use Across the Libraries/.test(t));
      const holder = document.createElement('div');
      holder.innerHTML = out.htmls[uaIdx];
      document.body.appendChild(holder);
      out.svgBefore = holder.querySelectorAll('svg[data-audit-chart]').length;
      const rankSvg = holder.querySelectorAll('svg[data-audit-chart]')[0];
      const heatSvg = holder.querySelectorAll('svg[data-audit-chart]')[1];
      out.rankBars = Array.from(rankSvg.querySelectorAll('rect[fill="var(--rpt-blue)"]')).map((r) => ({ w: parseFloat(r.getAttribute('width')), x: parseFloat(r.getAttribute('x')) }));
      out.rankTexts = Array.from(rankSvg.querySelectorAll('text')).map((t) => t.textContent);
      out.dash = rankSvg.querySelectorAll('line[stroke-dasharray]').length;
      out.heatTexts = Array.from(heatSvg.querySelectorAll('text')).map((t) => t.textContent);
      out.heatFills = Array.from(heatSvg.querySelectorAll('rect[fill-opacity]')).map((r) => r.getAttribute('fill'));
      await _rptSwapAuditChartsForPng([holder]);
      out.svgAfter = holder.querySelectorAll('svg[data-audit-chart]').length;
      out.imgAfter = holder.querySelectorAll('img[src^="data:image/png"]').length;
      holder.remove();
      out.uaIdx = uaIdx;
      out.allSecsText = out.pages.join(' ');
      // the ranking value of Alpha is the intensity of buildingAnnualUse (one source)
      out.expTotEui = computePeriodEUI(computeKBtu(alpha.kwh + beta.kwh, alpha.therms, 0), 12, alpha.sqft + beta.sqft);
      // Detailed: the page is the next section number
      const det = generateASHRAE36AuditHTML(collectASHRAE36Data(PID, '2026-11-10', null), { detailed: true, cover: true, executive: true, building: true, costEstimate: false });
      out.detUA = Array.from(new DOMParser().parseFromString(det, 'text/html').querySelectorAll('.rpt-page')).map((p) => p.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /Utility Use Across the Libraries/.test(t));
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
    ok(r.secs[titleIdx] === 'building' && r.secs.lastIndexOf('building') === r.uaIdx && titleIdx === r.uaIdx - 1, 'it follows the last building page and the utility page "Utility Use Across" follows it (Matt 2026-11-18)');
    ok(r.pages.slice(0, titleIdx).filter((t) => /Alpha Library/.test(t) && /Energy Use Intensity \(2025\)/.test(t)).length === 1, 'Alpha Library page has the utility card');
    ok(!r.pages.some((t, i) => r.secs[i] === 'building' && /Annual Energy Use/.test(t)), 'no per-building yearly chart (Annual Energy Use) on any building page');
    ok(r.uaIdx >= 0 && r.secs[r.uaIdx] === 'building', 'the page "Utility Use Across the Libraries" exists, with the section key of the building pages (same toggle)');
    ok(r.uaIdx > titleIdx, 'it comes after the Utility Use table page');
    ok(r.svgBefore === 2 && r.svgAfter === 0 && r.imgAfter === 2, 'Word: both charts become PNG pictures: ' + JSON.stringify([r.svgBefore, r.svgAfter, r.imgAfter]));
    const ua = r.pages[r.uaIdx];
    ok(/The highest-use library uses 3\.5× the energy per ft² of the lowest/.test(ua), 'ranking title computed from the data (70.9 / 20.5): ' + (ua.match(/The highest-use.*?lowest/) || [''])[0]);
    ok(/1 of 2 libraries use less energy than in their first year on file/.test(ua), 'heat map title computed from the data: ' + (ua.match(/\d+ of \d+ libraries use less[^C]*/) || [''])[0]);
    ok(r.rankBars.length >= 2 && r.rankBars[0].x === r.rankBars[1].x && r.rankBars[0].w > r.rankBars[1].w, 'ranking bars start at one zero line and are sorted high to low');
    ok(r.rankTexts.indexOf('Alpha Library') < r.rankTexts.indexOf('Beta Library') && r.rankTexts.indexOf('70.9') >= 0 && r.rankTexts.some((x) => /^20\.5/.test(x)), 'bars carry the value labels and the names in order: ' + r.rankTexts.join(' | '));
    ok(r.rankTexts.filter((x) => /electric only/.test(x)).length === 1 && /^20\.5.*electric only/.test(r.rankTexts.find((x) => /electric only/.test(x))), 'only the electric-only building is marked in the ranking');
    ok(r.dash === 1 && r.rankTexts.indexOf('Median 45.7') >= 0, 'one dashed median line, labelled with the median of the intensities (45.7)');
    ok(r.alpha.eui.toFixed(1) === '70.9', 'the ranking value is the buildingAnnualUse intensity (70.9)');
    ok(r.heatTexts.indexOf('2023') >= 0 && r.heatTexts.indexOf('2025') >= 0 && r.heatTexts.indexOf('Change') < 0, 'heat map has a column per year and no Change column (the last year already is the change)');
    ok(r.heatTexts.filter((x) => x === 'base').length === 2 && r.heatTexts.indexOf('-12%') >= 0 && r.heatTexts.indexOf('-20%') >= 0 && r.heatTexts.indexOf('+25%') >= 0, 'heat map cells print their percent text: ' + r.heatTexts.join(' | '));
    ok(r.heatTexts.filter((x) => x === '-20%').length === 1 && r.heatFills.indexOf('var(--rpt-green)') >= 0 && r.heatFills.indexOf('var(--rpt-red)') >= 0, 'less energy is green, more energy is red');
    ok(!/Annual totals only\.[^]*monthly/i.test(ua) && !/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/.test(ua) && !/240,000|60,000|kWh/.test(ua), 'no monthly values and no raw kWh on the page');
    ok(/Annual totals only\./.test(ua) && /floor area on file/.test(ua), 'note: annual totals only and the floor area on file');
    ok(!/finding|ASHRAE/i.test(ua), 'the page has no "finding" and no "ASHRAE" text');
    ok(r.detUA.length === 1 && /\d+\. Utility Use Across the Libraries/.test(r.detUA[0]), 'Detailed: the page title is numbered as a section: ' + (r.detUA[0] || '').slice(0, 80));
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
    ok(noGasRow && noGasRow[3] === '—' && /Electric only\./.test(t) && !/No gas meter on file/.test(t), 'no gas meter: dash in the gas cell and the footnote "Electric only." (Matt 2026-11-18)');
    ok(/Floor area \(ft²\)/.test(t) && /Electric \(kWh\)/.test(t) && /Gas \(therms\)/.test(t) && /Cost \(\$\)/.test(t) && /Cost per ft² \(\$\)/.test(t) && /EUI \(kBtu\/ft²\)/.test(t), 'column headers with symbols');
    ok(/background:var\(--rpt-blue\)/.test(html) && /text-align:right/.test(html), 'blue header row and right-aligned numbers');
    ok(!/finding|ASHRAE/i.test(t), 'the page has no "finding" and no "ASHRAE" text');
    ok(!r.pages1.some((x) => /Utility Use by Library|Utility Use Across/.test(x)), 'one building with data: no comparison page and no utility page');
    ok(r.pages1.some((x, i) => r.secs1[i] === 'building' && /Energy Use Intensity \(2025\)/.test(x)), 'one building with data: its card still prints');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    void bldPages;
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
