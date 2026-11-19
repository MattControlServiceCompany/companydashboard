// tools/test-proposal-no-setpoint-schedule.js - the Service Proposal has no setpoint or schedule work (Matt 2026-11-18). SYNTHETIC data only,
// headless bundled Chromium.
//   1. No priced row, line or price in Compliance, Recommended or Full Scope is a zone setpoint or schedule reprogramming (no sprg_ row, no
//      isSetpointReprogram, no oppKey zoneSetpoints / schedules / lightingSchedule); the removed builder, plan and constants no longer exist.
//   2. The Cost Summary data total of each option equals the total of its rows.
//   3. The rendered Service Proposal text (all options, Order of Work, steps, cost lines) has no setpoint or schedule sentence.
//   4. The Audit Report still reports the setpoints: Appendix A (Setpoint Programming Review) prints "N of M zones differ from the standard
//      setpoints" for the same libraries, and the Audit Report text does not say that the Service Proposal covers the work.
// Run: CH_TMP_ROOT=<scratch> node tools/test-proposal-no-setpoint-schedule.js   (exit 0 = all pass)
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
const near = (a, b) => Math.abs(a - b) < 0.006;

(async () => {
  const ctx = await launchBrowser('proposal-no-setpoint');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const mk = (id, b, cat, name, p, sub) => ({ id, building: b, category: cat, subtype: sub || '', equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      const sp = (heat, cool) => ({ 'Zone Temp': '72 F', 'Air Flow': '200', 'Damper Position': '40', 'Zone Heating Setpoint': String(heat), 'Zone Cooling Setpoint': String(cool) });
      // Alpha Hall: 3 of 4 zones off the defaults (70 heating / 75 cooling). Beta Hall: 2 of 3 off. Gamma Hall: all match (N = 0).
      // Delta Hall: single-zone air handling units only (no zone review).
      const rows = [
        mk('a1', 'Alpha Hall', 'vav', 'Room 1 - VAV-1', sp(72, 74)),
        mk('a2', 'Alpha Hall', 'vav', 'Room 2 - VAV-2', sp(73, 74)),
        mk('a3', 'Alpha Hall', 'vav', 'Room 3 - VAV-3', sp(68, 77)),
        mk('a4', 'Alpha Hall', 'vav', 'Room 4 - VAV-4', sp(70, 75)),
        mk('b1', 'Beta Hall', 'vav', 'Room 5 - VAV-5', sp(72, 74)),
        mk('b2', 'Beta Hall', 'vav', 'Room 6 - VAV-6', sp(66, 80)),
        mk('b3', 'Beta Hall', 'vav', 'Room 7 - VAV-7', sp(70, 75)),
        mk('g1', 'Gamma Hall', 'vav', 'Room 8 - VAV-8', sp(70, 75)),
        mk('g2', 'Gamma Hall', 'vav', 'Room 9 - VAV-9', sp(70, 75)),
        mk('d1', 'Delta Hall', 'ahu', 'AHU-1', Object.assign({ 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F' }, sp(60, 85)), 'sz'),
      ];
      const SP_KEYS = ['zoneSetpoints', 'schedules', 'lightingSchedule'];
      const isSp = (r) => /^sprg_/.test(r.id || '') || r.isSetpointReprogram || SP_KEYS.indexOf(r.oppKey) > -1;
      const pid = 900801;
      projects.push({ id: pid, name: 'Synthetic mixed', client: 'Synthetic mixed', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + pid, { rows: rows, importedAt: null, buildings: ['Alpha Hall', 'Beta Hall', 'Gamma Hall', 'Delta Hall'] });
      const d = collectASHRAE36Data(pid, '2026-11-10', null);
      const sb = _a36SetpointBuildingRows(d);
      // the N the Audit Report prints, read from the printed page text
      const html = rptPageASHRAE36SetpointReview(1, d).join(' ');
      const printed = [];
      const re = /(\d+) of (\d+) zones? differ from the standard setpoints/g;
      let m;
      while ((m = re.exec(html))) printed.push([Number(m[1]), Number(m[2])]);
      const est = _pricingGetEstimate(pid);
      const tiers = {};
      ['compliance', 'recommended', 'full-scope'].forEach((t) => {
        const s = _pricingTierRowsSplit(pid, t);
        const all = s.base.concat(s.optional);
        tiers[t] = {
          rows: all.length,
          spRows: all.filter(isSp).length,
          items: all.map((r) => String(r.item || '') + ' ' + String(r.note || '')).filter((x) => /set ?point|schedul/i.test(x)).length,
          grand: _pricingComputeTotals(s.base, est, pid).grand,
        };
      });
      const summary = _pricingComputeSummaryData(pid, est);
      const summaryGrand = { compliance: summary.tierTotals.compliance.grand, recommended: summary.tierTotals.recommended.grand, 'full-scope': summary.tierTotals['full-scope'].grand };
      // the rendered Service Proposal (all pages) and the Audit Report text
      const prop = generateASHRAE36ProposalHTML(d, { costEstimate: true, costEstimateItemized: true });
      const propText = new DOMParser().parseFromString('<div>' + prop + '</div>', 'text/html').body.textContent.replace(/\s+/g, ' ');
      const aud = generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true });
      const audText = new DOMParser().parseFromString('<div>' + aud + '</div>', 'text/html').body.textContent.replace(/\s+/g, ' ');
      return {
        rows: sb.buildingRows.map((r) => ({ name: r.name, n: r.deviatorCount, m: r.totalZones, single: r.singleZone })),
        printed,
        tiers,
        summaryGrand,
        propLen: propText.length,
        propHits: propText.match(/.{0,40}(set ?point|schedul).{0,40}/gi) || [],
        audPricesSp: /Service Proposal[^.]{0,80}(setpoint|schedule)|(setpoint|schedule)[^.]{0,80}Service Proposal/i.test(audText),
        removed: { builder: typeof buildSetpointReprogramRows, plan: typeof _a36SetpointReprogramPlan, sched: typeof SCHEDULE_HOURS_PER_UNIT, sp: typeof SETPOINT_REPROGRAM_HOURS_PER_ZONE },
        step1: _rptA36Step1Text(),
      };
    });

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    const TIERS = ['compliance', 'recommended', 'full-scope'];
    const byName = (n) => out.rows.find((r) => r.name === n);
    // ---- 4. the Audit Report still reports the setpoints ----
    ok(byName('Alpha Hall').n === 3 && byName('Alpha Hall').m === 4, 'Alpha Hall: 3 of 4 zones differ: ' + JSON.stringify(byName('Alpha Hall')));
    ok(byName('Beta Hall').n === 2 && byName('Beta Hall').m === 3, 'Beta Hall: 2 of 3 zones differ: ' + JSON.stringify(byName('Beta Hall')));
    const printedSum = out.printed.reduce((a, p) => a + p[0], 0);
    ok(out.printed.length === 2 && printedSum === 5, 'the Audit Report Appendix A still prints "N of M zones differ from the standard setpoints" for 2 buildings, 5 zones: ' + JSON.stringify(out.printed));
    ok(!out.audPricesSp, 'the Audit Report text does not say that the Service Proposal covers setpoints or schedules');
    // ---- 1. nothing priced ----
    ok(out.removed.builder === 'undefined' && out.removed.plan === 'undefined' && out.removed.sched === 'undefined' && out.removed.sp === 'undefined', 'the setpoint pricing builder, plan and constants no longer exist: ' + JSON.stringify(out.removed));
    TIERS.forEach((t) => {
      const T = out.tiers[t];
      ok(T.rows > 0 && T.spRows === 0, t + ': no setpoint or schedule row (' + T.rows + ' rows)');
      ok(T.items === 0, t + ': no row text names a setpoint or schedule');
      ok(near(out.summaryGrand[t], T.grand), t + ': the Cost Summary data total equals the tier total (' + out.summaryGrand[t] + ')');
    });
    // ---- 3. the rendered proposal ----
    ok(out.propLen > 500, 'the Service Proposal rendered (' + out.propLen + ' characters)');
    ok(out.propHits.length === 0, 'the Service Proposal text has no setpoint or schedule word: ' + JSON.stringify(out.propHits));
    // ---- Step 1 text: one text for the step table and the Order of Work, with no setpoint sentence ----
    ok(out.step1 === 'Equipment check: Control Service Company confirms each unit works and what to program.', 'Step 1 text: ' + out.step1);
    const src = require('fs').readFileSync(path.join(ROOT, 'app', 'report-engine.js'), 'utf8');
    ok((src.match(/_rptA36Step1Text\(\)/g) || []).length === 2, 'the Order of Work uses _rptA36Step1Text (1 definition + 1 use + the test; Matt 2026-11-19: the step table is gone)');
    ok(!/setpointZones|isSetpointReprogram/.test(src), 'report-engine.js has no setpointZones or isSetpointReprogram');
  } finally {
    await ctx.close();
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
