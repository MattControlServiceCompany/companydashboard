// tools/test-appendix-b-setpoint-price.js - the Service Proposal prices the Appendix B setpoint and schedule reprogramming (2026-11-15).
// SYNTHETIC data only, headless bundled Chromium.
//   1. The line quantity is the Appendix B zone count: the sum of N over the buildings that print "Change the setpoints of N of M zones".
//   2. Hours = 0.15 x zones + 2 x buildings with N > 0; price = hours x the project hourly rate.
//   3. The line is in the Programming part (phase 2) of Compliance, Recommended and Full Scope, and in each option total. It is not in the optional CO2 section.
//   4. A project with N = 0 (and a building of single-zone units only) has no line and the totals do not change.
//   5. A building with single-zone units only adds nothing.
// Run: CH_TMP_ROOT=<scratch> node tools/test-appendix-b-setpoint-price.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('appendix-b-price');
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
      const sets = {
        // Alpha Hall: 3 of 4 zones off the defaults (70 heating / 75 cooling). Beta Hall: 2 of 3 off. Gamma Hall: all match (N = 0).
        // Delta Hall: single-zone air handling units only (no zone review).
        mixed: [
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
        ],
        // no zone to reprogram: every zone matches; one building of single-zone units
        none: [
          mk('g1', 'Gamma Hall', 'vav', 'Room 8 - VAV-8', sp(70, 75)),
          mk('g2', 'Gamma Hall', 'vav', 'Room 9 - VAV-9', sp(70, 75)),
          mk('d1', 'Delta Hall', 'ahu', 'AHU-1', Object.assign({ 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F' }, sp(60, 85)), 'sz'),
        ],
      };
      const res = {};
      let pid = 900800;
      for (const k of Object.keys(sets)) {
        pid++;
        projects.push({ id: pid, name: 'Synthetic ' + k, client: 'Synthetic ' + k, type: 'K-12', start: '2025-01-01' });
        await sset('en_eqmatrix_' + pid, { rows: sets[k], importedAt: null, buildings: ['Alpha Hall', 'Beta Hall', 'Gamma Hall', 'Delta Hall'] });
        const d = collectASHRAE36Data(pid, '2026-11-10', null);
        const sb = _a36SetpointBuildingRows(d);
        // the N the Audit Report prints, read from the printed page text
        const pages = rptPageASHRAE36SetpointReview(1, d);
        const html = pages.join(' ');
        const printed = [];
        const re = /Change the setpoints of (\d+) of (\d+) zones?/g;
        let m;
        while ((m = re.exec(html))) printed.push([Number(m[1]), Number(m[2])]);
        const est = _pricingGetEstimate(pid);
        const rate = _pricingGetConfig().hourlyRate || COST_LABOR_RATE_DEFAULT;
        const tiers = {};
        const tierTotals = (t) => {
          const s = _pricingTierRowsSplit(pid, t);
          const total = _pricingComputeTotals(s.base, est, pid);
          const without = _pricingComputeTotals(s.base.filter((r) => !r.isSetpointReprogram), est, pid);
          return { s, total, without };
        };
        ['compliance', 'recommended', 'full-scope'].forEach((t) => {
          const { s, total, without } = tierTotals(t);
          const line = s.base.filter((r) => r.isSetpointReprogram);
          const inOptional = s.optional.filter((r) => r.isSetpointReprogram).length;
          tiers[t] = {
            lines: line.map((r) => ({ item: r.item, qty: r.qty, phase: r.phase, total: r.lineTotal, hrsPerUnit: r.hrsPerUnit, label: _rptA36PlainRowLabel(r) })),
            inOptional,
            // project method: the Estimate Workbook (the default)
            grand: total.grand,
            grandWithout: without.grand,
            p2: total.phase2,
            p2Without: without.phase2,
            p1: total.phase1,
            p1Without: without.phase1,
          };
        });
        const summary = _pricingComputeSummaryData(pid, est);
        const summaryGrand = { compliance: summary.tierTotals.compliance.grand, recommended: summary.tierTotals.recommended.grand, 'full-scope': summary.tierTotals['full-scope'].grand };
        // hourly method: option total = sum of line totals, so the total moves by exactly the line price
        await sset('en_pricing_workbook_' + pid, { method: 'hourly' });
        ['compliance', 'recommended', 'full-scope'].forEach((t) => {
          const { total, without } = tierTotals(t);
          tiers[t].hourlyGrand = total.grand;
          tiers[t].hourlyGrandWithout = without.grand;
          tiers[t].hourlyP2 = total.phase2;
          tiers[t].hourlyP2Without = without.phase2;
          tiers[t].hourlyP1 = total.phase1;
          tiers[t].hourlyP1Without = without.phase1;
        });
        res[k] = {
          rows: sb.buildingRows.map((r) => ({ name: r.name, n: r.deviatorCount, m: r.totalZones, single: r.singleZone })),
          plan: _a36SetpointReprogramPlan(d),
          printed,
          rate,
          tiers,
          summaryGrand,
          intro: /The cost of this work is in the Service Proposal\./.test(html),
        };
      }
      return res;
    });

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    const TIERS = ['compliance', 'recommended', 'full-scope'];
    const near = (a, b) => Math.abs(a - b) < 0.006;

    // ---- the mixed project ----
    const mx = out.mixed;
    const byName = (n) => mx.rows.find((r) => r.name === n);
    ok(byName('Alpha Hall').n === 3 && byName('Alpha Hall').m === 4, 'mixed. Alpha Hall: 3 of 4 zones to reprogram: ' + JSON.stringify(byName('Alpha Hall')));
    ok(byName('Beta Hall').n === 2 && byName('Beta Hall').m === 3, 'mixed. Beta Hall: 2 of 3 zones to reprogram: ' + JSON.stringify(byName('Beta Hall')));
    ok(byName('Gamma Hall').n === 0, 'mixed. Gamma Hall: 0 zones to reprogram');
    ok(byName('Delta Hall').single === true && byName('Delta Hall').n === 0, 'mixed. Delta Hall (single-zone units only): no zone review, 0 zones');
    const printedSum = mx.printed.reduce((a, p) => a + p[0], 0);
    ok(mx.printed.length === 2 && printedSum === 5, 'mixed. the Audit Report prints 2 buildings to reprogram, 5 zones in all: ' + JSON.stringify(mx.printed));
    ok(mx.plan.zones === 5 && mx.plan.buildings === 2, 'mixed. the plan (_a36SetpointReprogramPlan): 5 zones, 2 buildings: ' + JSON.stringify(mx.plan));
    ok(mx.intro, 'mixed. the Appendix B intro says the cost of this work is in the Service Proposal');
    const hours = 0.15 * 5 + 2 * 2;
    const price = Math.round(hours * mx.rate * 100) / 100;
    TIERS.forEach((t) => {
      const T = mx.tiers[t];
      ok(T.lines.length === 1, 'mixed. ' + t + ': one setpoint line: ' + JSON.stringify(T.lines));
      const L = T.lines[0] || {};
      ok(L.item === 'Setpoint and Schedule Reprogramming' && L.label === 'Setpoint and Schedule Reprogramming', 'mixed. ' + t + ': the label is "Setpoint and Schedule Reprogramming"');
      ok(L.qty === printedSum, 'mixed. ' + t + ': quantity ' + L.qty + ' = the Appendix B N sum ' + printedSum);
      ok(L.phase === 2, 'mixed. ' + t + ': the line is in the Programming part (phase 2)');
      ok(near(L.hrsPerUnit * L.qty, hours), 'mixed. ' + t + ': hours ' + (L.hrsPerUnit * L.qty) + ' = 0.15 x 5 + 2 x 2 = ' + hours);
      ok(near(L.total, price), 'mixed. ' + t + ': price ' + L.total + ' = ' + hours + ' h x $' + mx.rate + ' = ' + price);
      ok(T.inOptional === 0, 'mixed. ' + t + ': the line is not in the optional CO2 section');
      ok(near(T.hourlyGrand - T.hourlyGrandWithout, price), 'mixed. ' + t + ': hourly method: the option total is higher by the line price: ' + T.hourlyGrand + ' - ' + T.hourlyGrandWithout);
      ok(near(T.hourlyP2 - T.hourlyP2Without, price) && near(T.hourlyP1, T.hourlyP1Without), 'mixed. ' + t + ': hourly method: only the programming subtotal moves');
      ok(T.grand > T.grandWithout && T.p2 > T.p2Without, 'mixed. ' + t + ': workbook method (the default): the option total and the programming subtotal go up: ' + T.grandWithout + ' -> ' + T.grand);
      ok(near(mx.summaryGrand[t], T.grand), 'mixed. ' + t + ': the Cost Summary data total equals the tier total (' + mx.summaryGrand[t] + ')');
    });

    // ---- the project with nothing to reprogram ----
    const nn = out.none;
    ok(nn.plan.zones === 0 && nn.plan.buildings === 0, 'none. the plan has 0 zones: ' + JSON.stringify(nn.plan));
    ok(nn.printed.length === 0, 'none. the Audit Report prints no "Change the setpoints" line');
    ok(!nn.intro, 'none. the Appendix B intro does not mention the Service Proposal');
    TIERS.forEach((t) => ok(nn.tiers[t].lines.length === 0 && near(nn.tiers[t].grand, nn.tiers[t].grandWithout), 'none. ' + t + ': no setpoint line, total unchanged'));
    ok(nn.rows.some((r) => r.single), 'none. a building of single-zone units is in Appendix B and adds nothing');

    // ---- 6. one Step 1 text for the step table and the Order of Work; it names the Audit Report ----
    const s1 = await page.evaluate(() => [_rptA36Step1Text(273), _rptA36Step1Text(1), _rptA36Step1Text(0)]);
    ok(s1[0] === 'Check the equipment and confirm what to program. Reset zone setpoints and schedules (273 zones, Audit Report Appendix B).', 'Step 1 text: ' + s1[0]);
    ok(/\(1 zone, Audit Report Appendix B\)\.$/.test(s1[1]), 'Step 1 text, 1 zone: ' + s1[1]);
    ok(s1[2] === 'Check the equipment and confirm what to program.', 'Step 1 text, 0 zones: no setpoint sentence');
    const src = require('fs').readFileSync(path.join(ROOT, 'app', 'report-engine.js'), 'utf8');
    ok((src.match(/_rptA36Step1Text\(plan\.setpointZones\)/g) || []).length === 2, 'the step table and the Order of Work both use _rptA36Step1Text');
  } finally {
    await ctx.close();
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
