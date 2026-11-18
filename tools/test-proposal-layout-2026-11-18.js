// tools/test-proposal-layout-2026-11-18.js - the whole Service Proposal on a SYNTHETIC project (no client data), headless bundled Chromium.
// Checks (Matt 2026-11-18):
//   1. page 1: the Cost Summary table ends at least 24px above the footer zone;
//   2. no page ends short before the last page (each page except the last is filled to 70 % of the body or more);
//   3. Full Scope includes the room CO2 work: its total on page 1 and on the Cost Estimate page is the one number
//      _rptA36TierCostData returns, there is no Optional row and no optional block, and the sentence says what is included;
//   4. "What you get:" is bold and has space above it; there is no "What the names mean" block; Step 1 is the company's work.
// Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-layout-2026-11-18.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('proposal-layout');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36ProposalHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });
    const res = await page.evaluate(async () => {
      const ahu = (id, b, name, sub, p) => ({ id, building: b, category: 'ahu', subtype: sub, equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const vav = (id, b, name, p) => ({ id, building: b, category: 'vav', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const p2 = { 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F', 'Duct Static Pressure': '1' };
      const zone = { 'Zone Temp': '72.4 F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const rows = [];
      ['Alpha Hall', 'Beta Hall', 'Gamma Hall'].forEach((b, bi) => {
        for (let a = 1; a <= 3; a++) rows.push(ahu('a' + bi + a, b, 'AHU-' + bi + a, 'mz', p2));
        for (let v = 1; v <= 10; v++) rows.push(vav('v' + bi + '_' + v, b, 'VAV-' + bi + '_' + v, zone));
      });
      const pid = 900201;
      projects.push({ id: pid, name: 'Synthetic Layout', client: 'Synthetic Layout', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + pid, { rows, importedAt: null, buildings: ['Alpha Hall', 'Beta Hall', 'Gamma Hall'] });
      const d = collectASHRAE36Data(pid, '2026-11-10', null);
      const sec = {};
      (ASHRAE36_SECTIONS.proposal || []).forEach((s) => (sec[s.key] = s.defaultOn !== false));
      sec.complianceScope = true;
      sec.fullScope = true;
      sec.costEstimate = true;
      sec.costEstimatePhaseSplit = true;
      const html = generateASHRAE36ProposalHTML(d, sec);
      const host = document.createElement('div');
      host.id = 'reportPages';
      host.innerHTML = html;
      document.body.appendChild(host);
      if (typeof _rptApplyMinFontFloor === 'function') _rptApplyMinFontFloor(host); // the real overlay applies the 10pt floor (showReportOverlay) before the pages are measured
      host.querySelectorAll('[id^="rpt-tier-detail-"]').forEach((p) => (p.style.display = 'block'));
      const g = _rptGeometry();
      const pages = [...host.querySelectorAll('.rpt-page')].map((pg) => {
        const pr = pg.getBoundingClientRect();
        let bottom = 0;
        (pg.querySelector('.rpt-body') || pg.querySelector('.rpt-hero-body') || pg).querySelectorAll('*').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.height > 0) bottom = Math.max(bottom, r.bottom - pr.top);
        });
        return { bottom: Math.round(bottom), limit: Math.round(pr.height - g.ftrH), text: pg.innerText };
      });
      const p1 = host.querySelector('.rpt-page');
      const pr1 = p1.getBoundingClientRect();
      const tbl = p1.querySelector('table');
      const cost = _rptA36TierCostData(d);
      const wy = [...host.querySelectorAll('span')].find((e) => /^What you get:/.test(e.textContent));
      const wyDiv = wy && wy.parentElement;
      const wyTable = wyDiv && wyDiv.previousElementSibling;
      const out = {
        pages,
        tableBottom: tbl ? Math.round(tbl.getBoundingClientRect().bottom - pr1.top) : null,
        cost,
        all: host.textContent,
        wyWeight: wy ? getComputedStyle(wy).fontWeight : null,
        wyParentWeight: wyDiv ? getComputedStyle(wyDiv).fontWeight : null,
        wyGap: wyDiv && wyTable ? Math.round(wyDiv.getBoundingClientRect().top - wyTable.getBoundingClientRect().bottom) : null,
      };
      host.remove();
      return out;
    });
    const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
    console.log('pages:', res.pages.map((p) => p.bottom + '/' + p.limit).join(' '), ' table bottom:', res.tableBottom, ' tiers:', JSON.stringify(res.cost));
    ok(res.pages.length >= 2, 'proposal has pages: ' + res.pages.length);
    ok(res.tableBottom !== null && res.tableBottom <= res.pages[0].limit - 24, 'page 1: the Cost Summary table ends at least 24px above the footer zone (table bottom ' + res.tableBottom + ', footer zone top ' + res.pages[0].limit + ')');
    res.pages.forEach((p, i) => {
      ok(p.bottom <= p.limit, 'page ' + (i + 1) + ': content stays above the footer zone (' + p.bottom + '/' + p.limit + ')');
      if (i < res.pages.length - 1) {
        // A page may end short only when the next page opens with the Cost Estimate (one block that never splits) and that block is taller than the free space.
        const nx = res.pages[i + 1];
        const unsplittable = /^\s*Cost Estimate/.test(nx.text) && nx.bottom - 60 > p.limit - p.bottom;
        ok(p.bottom >= 0.7 * p.limit || unsplittable, 'page ' + (i + 1) + ' of ' + res.pages.length + ' is not short: filled to ' + Math.round((100 * p.bottom) / p.limit) + ' % (>= 70 %' + (unsplittable ? ', or the Cost Estimate that follows does not fit' : '') + ')');
      }
    });
    const fs = res.cost.tiers.find((t) => t.key === 'full-scope');
    ok(res.cost.roomCo2 && res.cost.roomCo2.qty > 0, 'the synthetic project has room CO2 sensors in Full Scope: ' + JSON.stringify(res.cost.roomCo2));
    ok(fs && res.pages[0].text.indexOf(usd(fs.total)) >= 0, 'page 1 prints the Full Scope total from _rptA36TierCostData: ' + (fs && usd(fs.total)));
    ok(fs && res.all.split(usd(fs.total)).length - 1 >= 2, 'the Cost Estimate page prints the same Full Scope total');
    ok(!/Optional/i.test(res.all), 'no "Optional" row or block in the proposal');
    ok(!/The options below do not include/.test(res.all) && /Full Scope includes [\d,]+ carbon dioxide \(CO2\) sensors? in rooms/.test(res.all.replace(/\s+/g, ' ')), 'one plain sentence says Full Scope includes the room CO2 sensors');
    ok(res.pages[0].text.indexOf('optional, priced separately') < 0, 'no gap line says "(optional, priced separately)"');
    ok(/Compliance Work/.test(res.all) && /Full Scope Work/.test(res.all) && /Recommended Work/.test(res.all), 'scope headings: Recommended Work, Compliance Work, Full Scope Work');
    ok(!/What the names mean/.test(res.all), 'no "What the names mean" block');
    ok(Number(res.wyWeight) >= 700 && Number(res.wyParentWeight) < 600, 'the label "What you get:" is bold, the sentence is not (' + res.wyWeight + ' / ' + res.wyParentWeight + ')');
    ok(res.wyGap !== null && res.wyGap >= 14 && res.wyGap <= 18, 'space above "What you get:" is 14-18px: ' + res.wyGap);
    ok(/Control Service Company checks the equipment/.test(res.all), 'Step 1 says Control Service Company does the work');
    ok(!/Check the equipment and confirm|Reset zone setpoints/.test(res.all), 'no client-work wording for Step 1');
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
