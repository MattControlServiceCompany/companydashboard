// tools/test-a36-exec-summary.js - the Executive Summary of the Detailed style of the ASHRAE 36 Audit Report, and the Point Inventory box of
// the audit modal. SYNTHETIC project, headless bundled Chromium (never Edge).
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-exec-summary.js
//   1. The Detailed Executive Summary has the subheadings Overall Result, Key Findings and Recommendations, and the old text
//      ("still need this programmed", "Occupancy-Based Ventilation" item, "Summary" block) is gone.
//   2. Every number in it equals the shared value it comes from (portfolio scores, _a36ConsolidatedCounts, dcv counts, the sequence counts of the
//      priced scope, the point inventory, _a36SetpointNeedsChangeCount).
//   3. A zero count drops its sentence or bullet (no "0 of"); the setpoint bullet prints only when Appendix A prints and the count is above 0.
//   4. The Key Findings are a real <ul>, at most 4 bullets, ordered by equipment count.
//   5. The whole Executive Summary is on one page; the Building Readiness table starts on the next page.
//   6. The Simple style keeps its old Executive Summary text.
//   7. Audit modal: the Point Inventory row is hidden (and unchecked) in the Detailed style and visible again in Simple.
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
  const ctx = await launchBrowser('a36-exec-summary');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    // ---- synthetic project: three libraries, fake names ----
    const PID = await page.evaluate(async () => {
      const PID = 900002;
      const ahu = (id, b, name, p) => ({ id, building: b, category: 'ahu', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const vav = (id, b, name, p) => ({ id, building: b, category: 'vav', equipName: name, location: '', controllerType: 'Sample Controller', points: p });
      const full = { 'Supply Air Temp': '55.2 °F', 'Return Air Temp': '72.1 °F', 'Duct Static Pressure': '1.1 in H2O', 'Outside Air Temp': '61 °F' };
      const zone = { 'Zone Temp': '72.4 °F', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70' };
      const rows = [
        ahu('r1', 'Alpha Library', 'AHU-1', full),
        ahu('r2', 'Alpha Library', 'AHU-2', { 'Supply Air Temp': '56.0 °F' }),
        vav('r3', 'Alpha Library', 'VAV-101', zone),
        vav('r4', 'Alpha Library', 'VAV-102', zone),
        ahu('r5', 'Beta Library', 'AHU-3', full),
        vav('r6', 'Beta Library', 'VAV-201', zone),
        ahu('r7', 'Gamma Library', 'AHU-4', full),
        vav('r8', 'Gamma Library', 'VAV-301', zone),
      ];
      projects.push({ id: PID, name: 'Synthetic Library District', client: 'Synthetic Library District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library', 'Gamma Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      return PID;
    });

    // One Executive Summary build with controlled shared values. opts mutate the collected data BEFORE the report reads it.
    // Returns the text of the executive pages, the pages' HTML, and the shared values read back from the same data object.
    async function build(opts) {
      return page.evaluate(
        ({ PID, opts }) => {
          const data = collectASHRAE36Data(PID, '2026-11-10', null);
          const p = data.portfolio;
          p.totalBuildings = 13;
          p.totalEquip = 342;
          p.composite = 84;
          p.pointPct = opts.pointPct != null ? opts.pointPct : 88;
          p.seqPct = opts.seqPct != null ? opts.seqPct : 72;
          p.dcv = opts.dcv || { totalAHU: 20, ahuMissingCO2: 5, totalZones: 232, zonesMissingCO2: 203 };
          data.pointInventory = { totalAll: opts.inv != null ? opts.inv : 16195, totalASHRAE: 0, totalOther: 0, byBuilding: [] };
          // the priced scope: the one source of the sequence counts and of the two work counts
          data._a36CatalogRowsCache = opts.rows || [
            { phase: 1, qty: 258 },
            { phase: 2, seqKey: 'ahu_sat_reset', qty: 9 },
            { phase: 2, seqKey: 'ahu_min_oa', qty: 9 },
            { phase: 2, seqKey: 'ahu_economizer', qty: 7 },
            { phase: 2, seqKey: 'ahu_dsp_reset', qty: 3 },
            { phase: 2, seqKey: 'demandCtrl', qty: 20 },
            { phase: 2, seqKey: 'vav_dcv', qty: 220 },
          ];
          // the Executive Summary reads the setpoint count of the Setpoint Programming Review through this one function
          if (opts.spNeed != null) window._a36SetpointNeedsChangeCount = function () { return opts.spNeed; };
          const counts = _a36ConsolidatedCounts(data);
          const sel = { cover: true, executive: true, costEstimate: true, setpointReview: opts.setpointReview !== false, detailed: opts.simple ? undefined : true };
          if (opts.simple) { sel.building = true; sel.pointInventory = true; }
          const html = generateASHRAE36AuditHTML(data, sel);
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const exec = Array.from(doc.querySelectorAll('.rpt-page[data-section="executive"]'));
          return {
            html,
            pages: exec.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
            execHtml: exec.map((e) => e.innerHTML).join(''),
            lis: exec.flatMap((e) => Array.from(e.querySelectorAll('ul > li')).map((l) => l.textContent.replace(/\s+/g, ' ').trim())),
            counts,
            low: data.buildings.slice().sort((a, c) => a.composite - c.composite).slice(0, 3).map((b) => b.composite),
            nBuildings: data.buildings.length,
            hasAppendix: sel.setpointReview !== false && !opts.simple && data.buildings.some((b) => (b.equipResults || []).some((e) => e.spCompliance && e.spCompliance.hasAnyData)),
          };
        },
        { PID, opts },
      );
    }

    // ---- 1 + 2 + 4. the full Detailed summary, with a mocked Appendix A count of 9 ----
    const a = await build({ spNeed: 9 });
    const t = a.pages[0] || '';
    ok(a.pages.length >= 1 && /Executive Summary/.test(t), 'Detailed: Executive Summary page found');
    ok(/Overall Result/.test(t) && /Key Findings/.test(t) && !/Recommendations/.test(t) && !/Install 258 sensors/.test(t), 'Detailed: subheadings Overall Result and Key Findings; no Recommendations heading or paragraph (2026-11-17, facts only)');
    ok(!/still need this programmed/.test(t) && !/Occupancy-Based Ventilation/.test(t) && !/industry standard for how a building automation/.test(t) && !/The largest gaps are/.test(t), 'Detailed: the old text is gone (no "still need this programmed", no old intro, no old Summary)');
    ok(/Control Service Company audited the building automation system at 13 libraries\. The audit covered 342 pieces of equipment and 16,195 control points: its sensors, setpoints, schedules and control sequences\. The equipment audited is 4 Air Handlers and 4 Variable Air Volume Terminals\./.test(t) && !/ASHRAE/.test(t), 'Detailed: first paragraph carries the building, equipment, equipment types and point counts, and names no standard');
    ok(/Overall ResultThe audit recorded/.test(t) && !/ASHRAE|Sensor coverage is|composite/.test(t), 'Detailed: Overall Result states the findings count of the audit; the readiness scores are not in the base Executive Summary');
    ok(/Key Findings/.test(t) && a.lis.length >= 2 && a.lis.length <= 4, 'Key Findings: ' + a.lis.length + ' bullets (2 to 4)');
    ok(/<ul[^>]*>\s*<li/.test(a.execHtml), 'Key Findings: a real <ul> with <li> items');
    ok(a.lis[0] && /^Ventilation does not follow occupancy\. 203 of 232 zones and 5 of 20 air handlers have no carbon dioxide \(CO2\) sensor\. These units bring in a fixed amount of outdoor air whether a space is full or empty\./.test(a.lis[0]), 'Key Findings: ventilation first, with the dcv counts (203 of 232 zones, 5 of 20 air handlers)');
    ok(a.lis[0] && /In all, 240 units need this sequence programmed/.test(a.lis[0]) && /This finding affects the most equipment in the audit\./.test(a.lis[0]), 'Key Findings: ventilation total = demandCtrl 20 + vav_dcv 220 = 240, the largest count, so "affects the most equipment"');
    ok(a.lis[1] && /^Air handler sequences are incomplete\. Air handlers lack these control sequences: supply air temperature reset \(9 units\), minimum outdoor air \(9\), economizer \(7\) and duct static pressure reset \(3\)\. These sequences adjust the equipment to what the building needs, which lowers fan, heating and cooling energy\./.test(a.lis[1]), 'Key Findings: one air handler bullet with the four ahu counts of the priced scope (9, 9, 7, 3)');
    ok(a.lis[2] && /^Zone setpoints\. 9 of 13 libraries have zone setpoints that differ from the recommended setpoints in Appendix A\.$/.test(a.lis[2]), 'Key Findings: setpoint bullet uses _a36SetpointNeedsChangeCount (9 of 13) and is last');
    ok(a.counts.sensors === 258 && a.counts.sequences === 9 + 9 + 7 + 3 + 20 + 220, 'shared: _a36ConsolidatedCounts = 258 devices, 268 sequences (' + a.counts.sensors + ', ' + a.counts.sequences + ')');
    ok(!/Install 258 sensors|The Service Proposal gives the cost|ASHRAE 36 standard for the equipment in scope/.test(t), 'Recommendations paragraph is gone (2026-11-17)');

    // ---- 3. zero counts drop sentences and bullets ----
    const z = await build({
      dcv: { totalAHU: 20, ahuMissingCO2: 0, totalZones: 232, zonesMissingCO2: 0 },
      inv: 0,
      rows: [],
      spNeed: 0,
    });
    const zt = z.pages[0] || '';
    ok(!/carbon dioxide/.test(zt) && !/Ventilation does not follow occupancy/.test(zt), 'zero carbon dioxide counts: the ventilation bullet is gone');
    ok(!/Zone setpoints\./.test(zt) && !/change the zone setpoints/.test(zt), 'zero setpoint count: no setpoint bullet and no setpoint recommendation');
    ok(!/control points/.test(zt) && /342 pieces of equipment/.test(zt), 'zero point count: the points are dropped from the first paragraph');
    ok(!/ 0 of /.test(zt) && !/\b0 (sensors|units|control)/.test(zt), 'no "0 of" and no zero count anywhere in the text');
    const zno = await build({ setpointReview: false, spNeed: 9 });
    ok(!/Zone setpoints\./.test(zno.pages[0] || ''), 'Appendix A not printed: no setpoint bullet even when the count is above 0');
    const gap = await build({ pointPct: 60, seqPct: 80 });
    ok(!/ASHRAE|Sequence readiness is|Sensor coverage is/.test(gap.pages[0] || ''), 'opposite gap: the base Executive Summary prints no readiness comparison, whatever the two percentages are');

    // ---- 5. one page ----
    await page.evaluate(async (PID) => {
      const data = collectASHRAE36Data(PID, '2026-11-10', null);
      const html = generateASHRAE36AuditHTML(data, { cover: true, executive: true, costEstimate: true, setpointReview: true, detailed: true });
      showReportOverlay(html, 'Exec');
      await new Promise((r) => setTimeout(r, 400));
    }, PID);
    const fit = await page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll('#reportPages .rpt-page')).filter((p) => p.getAttribute('data-section') === 'executive');
      return pages.map((p) => {
        const body = p.querySelector('.rpt-body');
        const foot = p.querySelector('.rpt-pg-footer');
        let mb = 0;
        body.querySelectorAll('*').forEach((e) => { const r = e.getBoundingClientRect(); if (r.height > 0) mb = Math.max(mb, r.bottom); });
        return { text: p.textContent.replace(/\s+/g, ' ').slice(0, 80), bottom: mb, footTop: foot ? foot.getBoundingClientRect().top : null, overflow: body.scrollHeight > body.clientHeight + 1, hasReadiness: /Building Readiness/.test(p.textContent), hasSummary: /Overall Result/.test(p.textContent) };
      });
    });
    ok(fit.length >= 1 && fit[0].hasSummary && !fit[0].hasReadiness && fit.every((f) => !f.hasReadiness), 'page 2 holds the whole summary; the Building Readiness table is not in the base Executive Summary (' + fit.map((f) => (f.hasSummary ? 'summary' : '') + (f.hasReadiness ? 'readiness' : '')).join(' | ') + ')');
    ok(fit[0] && !fit[0].overflow && (fit[0].footTop === null || fit[0].bottom <= fit[0].footTop), 'page 2 content ends above the footer (bottom ' + (fit[0] && Math.round(fit[0].bottom)) + ', footer ' + (fit[0] && Math.round(fit[0].footTop)) + ')');

    // ---- 6. Simple style unchanged ----
    const s = await build({ simple: true });
    const st = s.pages.join(' ');
    ok(/This audit reviewed the building automation system of each building/.test(st) && !/ASHRAE/.test(st) && /Occupancy-Based Ventilation\./.test(st) && /pieces of equipment still need this programmed\./.test(st) && !/Overall Result|Key Findings/.test(st), 'Simple: new intro without the standard, the Occupancy-Based Ventilation paragraph and the "still need this programmed" paragraphs; no new subheadings');
    ok(!/<ul/.test(s.execHtml), 'Simple: no bullet list');

    // ---- 7. audit modal: Point Inventory row ----
    const m = await page.evaluate((PID) => {
      openASHRAE36ReportModal(PID, 'audit');
      const cb = document.querySelector('.a36SecCheck[data-key="pointInventory"]');
      const row = cb.closest('label');
      const shown = () => getComputedStyle(row).display !== 'none' && row.offsetParent !== null;
      const radio = (v) => { document.querySelector('input[name="a36Style"][value="' + v + '"]').checked = true; _a36StyleChanged(); };
      const out = { simpleStart: shown(), simpleChecked: cb.checked, simpleDisabled: cb.disabled };
      cb.checked = true;
      radio('detailed');
      out.detShown = shown();
      out.detChecked = cb.checked;
      out.detDisabled = cb.disabled;
      radio('simple');
      out.simpleAgain = shown();
      out.simpleAgainChecked = cb.checked;
      out.simpleAgainDisabled = cb.disabled;
      document.getElementById('ashrae36ReportModal').classList.remove('open');
      return out;
    }, PID);
    ok(m.simpleStart && !m.simpleChecked && !m.simpleDisabled, 'modal Simple: Point Inventory row visible, unchecked by default, enabled');
    ok(!m.detShown && !m.detChecked, 'modal Detailed: the Point Inventory row is hidden and its box is unchecked (never sent)');
    ok(m.simpleAgain && !m.simpleAgainDisabled && !m.simpleAgainChecked, 'modal back to Simple: the row is visible again, enabled, default unchecked');

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
