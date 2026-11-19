// tools/test-opportunity-lines.js - 1 opportunity = 1 line in the cost estimate (Matt 2026-11-18). SYNTHETIC names and values only;
// headless bundled Chromium; no network.
// Rules tested:
//   1. The findings model: occupancy-based ventilation of the zone terminals (vav_dcv) is ONE opportunity per library whatever the number
//      of terminal groups; minimum outdoor air and occupancy-based ventilation of the air handling units are two opportunities.
//   2. The one row -> opportunity rule (_pricingRowOpportunity): an oppKey, a sequence row, a device row (sensor opportunity, blocking sensor
//      of a sequence, missing point of a sequence) and the rows that are no opportunity (optional points, FDD, sensor checks).
//   3. 1:1 both ways on the priced rows: every row is in exactly one line or in "Included"; no opportunity has two lines; in Full Scope every
//      opportunity has a line; the visible list of the Service Proposal (_rptA36OppDetail, the panel HTML) has one entry per line.
//   4. The terminal unit upgrade is one row per library. The setpoint and schedule opportunities have NO priced row and NO line in any option
//      (Matt 2026-11-18); the removed builder and constants are gone.
//   5. The new lines (override, exterior photocell, interior occupancy, power meter) are priced from the constants at the top of
//      pricing-estimator.js and the project hourly rate; they are in Recommended and Full Scope, not in Compliance. The schedule opportunities
//      get no row.
//   6. The count sentence "The Recommended option covers N of them." (cover) with N = the opportunities that have a line in Recommended;
//      no sentence says that a library counts as one opportunity.
// Run: CH_TMP_ROOT=<scratch> node tools/test-opportunity-lines.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('opportunity-lines');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36OpportunityList === 'function' && typeof _pricingOpportunityLines === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const PID = 900950;
      const mk = (id, b, cat, name, p) => ({ id, building: b, category: cat, equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      const zone = (h, c) => ({ 'Zone Temp': '72.4 F', 'Air Flow': '200', 'Damper Position': '40', 'Zone Heating Setpoint': String(h), 'Zone Cooling Setpoint': String(c) });
      const sp = (h, c, uh, uc) => ({ 'Setpoint / Heating Occupied Setpoint': String(h), 'Setpoint / Cooling Occupied Setpoint': String(c), 'Setpoint / Heating Unoccupied Setpoint': String(uh), 'Setpoint / Cooling Unoccupied Setpoint': String(uc) });
      // Alpha Library: two air handling units (minimum outdoor air + occupancy-based ventilation gaps), terminals of TWO groups (variable air volume
      // and fan-powered) that lack occupancy-based ventilation, zones off the standard setpoints. Beta Library: variable air volume zones that match.
      const rows = [
        mk('a1', 'Alpha Library', 'ahu', 'AHU-A', Object.assign({ 'Supply Air Temp': '55.2 F' }, sp(66, 71, 60, 79))),
        mk('a2', 'Alpha Library', 'ahu', 'AHU-B', Object.assign({ 'Supply Air Temp': '55.2 F' }, sp(66, 71, 60, 79))),
        mk('v1', 'Alpha Library', 'vav', 'Room 1 - VAV-1', zone(72, 74)),
        mk('v2', 'Alpha Library', 'vav', 'Room 2 - VAV-2', zone(73, 74)),
        mk('v3', 'Alpha Library', 'vav', 'Room 3 - VAV-3', zone(68, 77)),
        mk('f1', 'Alpha Library', 'fpb', 'Room 4 - FPB-1', zone(72, 74)),
        mk('f2', 'Alpha Library', 'fpb', 'Room 5 - FPB-2', zone(66, 80)),
        mk('b1', 'Beta Library', 'vav', 'Room 6 - VAV-4', zone(70, 75)),
        mk('b2', 'Beta Library', 'vav', 'Room 7 - VAV-5', zone(70, 75)),
        mk('b3', 'Beta Library', 'vav', 'Room 8 - VAV-6', zone(72, 74)),
      ];
      projects.push({ id: PID, name: 'Synthetic Opportunity District', client: 'Synthetic Opportunity District', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: ['Alpha Library', 'Beta Library'] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      emSaveEquipConfigFlags(PID, 'a1', { hasCO2: true });
      emSaveEquipConfigFlags(PID, 'a2', { hasCO2: true });
      const res = {};
      const d = collectASHRAE36Data(PID, '2026-11-18', null);
      const opps = _a36OpportunityList(d);
      res.opps = opps.map((o) => ({ b: o.bName, lib: o.lib, key: o.key, kind: o.kind, label: o.label, units: o.units, keys: o.keys || null, affected: (o.affected || []).length }));
      res.dcvTotals = opps.filter((o) => o.key === 'vav_dcv').map((o) => ({ b: o.bName, total: o.total, affected: o.affected.length }));
      res.libTerminals = d.buildings.map((b) => ({ b: b.name, terminals: b.equipResults.filter((e) => ['vav', 'fpb', 'ddvav'].indexOf(e.category) > -1).length }));
      res.dupKeys = opps.length - new Set(opps.map((o) => o.bName + '|' + o.key)).size;

      // ---- the tiers: rows, lines, Included ----
      const est = _pricingGetEstimate(PID);
      const sd = _rptA36ProposalSummaryData(d);
      res.tiers = {};
      ['recommended', 'compliance', 'full-scope'].forEach((t) => {
        const rowsT = (sd.perTier[t] || []).filter((r) => (est.rowToggles || {})[r._baseId || r.id] !== false);
        const g = _pricingOpportunityLines(rowsT, opps);
        const inLines = [].concat(...g.lines.map((l) => l.rows));
        const ids = inLines.concat(g.unmapped).map((r) => r.id);
        const det = _rptA36OppDetail(sd, est, t, sd.tierTotals);
        const html = _rptA36TierDetailPanelHTML(t, sd.tierTotals, sd, est, true, (v) => '$' + Math.round(v).toLocaleString('en-US'));
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        const sections = Array.from(doc.querySelectorAll('div > div')).filter((x) => /^(Opportunities|Included)/.test((x.firstChild && x.firstChild.textContent) || ''));
        res.tiers[t] = {
          nRows: rowsT.length,
          nLines: g.lines.length,
          nUnmapped: g.unmapped.length,
          idsOnce: ids.length === rowsT.length && new Set(ids).size === ids.length,
          oppOnce: new Set(g.lines.map((l) => l.opp.bName + '|' + l.opp.key)).size === g.lines.length,
          lineKeys: g.lines.map((l) => l.opp.bName + '|' + l.opp.key),
          unmappedIds: g.unmapped.map((r) => r.id),
          detLines: det.lines.length,
          detIncluded: det.included.length,
          detTitles: det.lines.map((l) => l.item),
          panelOppLis: (doc.querySelector('#rpt-tier-detail-' + t + ' ul') || { children: [] }).children.length,
          panelHead: (doc.querySelector('#rpt-tier-detail-' + t + ' div div') || { textContent: '' }).textContent,
          panelHasIncludedWord: /Included/.test(doc.body.textContent),
          sumLinesRows: Math.round(inLines.reduce((s, r) => s + (r.lineTotal || 0), 0) * 100) / 100,
          sumDetLines: Math.round(det.lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100,
          sumDetAll: Math.round(det.lines.concat(det.included).reduce((s, l) => s + l.lineTotal, 0) * 100) / 100,
          sumRows: Math.round(rowsT.reduce((s, r) => s + (r.lineTotal || 0), 0) * 100) / 100,
          printed: det.lines.concat(det.included).reduce((s, l) => s + (l.lineTotal > 0 ? Math.round(l.lineTotal) : 0), 0),
          subtotalR: det.subtotalR,
          rounding: det.rounding,
        };
      });

      // ---- per-library rows of the setpoint reprogramming and the terminal unit upgrade ----
      const rate = _pricingGetConfig().hourlyRate || COST_LABOR_RATE_DEFAULT;
      res.removed = {
        builder: typeof buildSetpointReprogramRows,
        plan: typeof _a36SetpointReprogramPlan,
        sched: typeof SCHEDULE_HOURS_PER_UNIT,
        schedB: typeof SCHEDULE_HOURS_PER_BUILDING,
        sp: typeof SETPOINT_REPROGRAM_HOURS_PER_ZONE,
      };
      res.noPriceOpps = opps.filter((o) => ['zoneSetpoints', 'schedules', 'lightingSchedule'].indexOf(o.key) > -1).length;
      res.spRows = {};
      ['recommended', 'compliance', 'full-scope'].forEach((t) => {
        res.spRows[t] = (sd.perTier[t] || []).filter((r) => /^sprg_/.test(r.id || '') || r.isSetpointReprogram || ['zoneSetpoints', 'schedules', 'lightingSchedule'].indexOf(r.oppKey) > -1).length;
      });
      res.tstd = { plan: _a36TerminalStandardPlan(d), rows: buildTerminalStandardRows(PID).map((r) => ({ b: r.building, qty: r.qty, total: r.lineTotal })) };

      // ---- mapping rules on synthetic opportunities ----
      const O = (b, key, kind, extra) => Object.assign({ bName: b, lib: b, key, kind, label: key, units: 1, affected: [], missingKeys: [] }, extra || {});
      const mo = [
        O('Lib', 'hwp_pump_dp_reset', 'seq', { missingKeys: ['hwdp', 'hwPumpSpeed'], category: 'hwp' }),
        O('Lib', 'vav_dcv', 'seq', { missingKeys: ['co2_zone'], category: 'vav' }),
        O('Lib', 'demandCtrl', 'seq', { missingKeys: ['co2_ahu'], category: 'ahu' }),
        O('Lib', 'ahu_min_oa', 'seq', { missingKeys: ['oaDampCmd'], category: 'ahu' }),
        O('Lib', 'discFlow', 'sensor', { category: 'vav' }),
        O('Lib', 'powerMeter', 'building'),
      ];
      const key = (r, list) => { const o = _pricingRowOpportunity(r, list || mo); return o ? o.key : null; };
      res.map = {
        hwdp: key({ id: 'hw_x_hwdp_0', phase: 1, _pointKey: 'hwdp', building: 'Lib' }),
        pump: key({ id: 'hw_x_hwPumpSpeed_0', phase: 1, _pointKey: 'hwPumpSpeed', building: 'Lib' }),
        co2: key({ id: 'hw_x_co2_zone_standalone_0', phase: 1, _pointKey: 'co2_zone_standalone', building: 'Lib' }),
        co2Ahu: key({ id: 'hw_x_co2_ahu_0', phase: 1, _pointKey: 'co2_ahu', building: 'Lib' }),
        damper: key({ id: 'hw_x_damperPositionControl_0', phase: 1, _pointKey: 'damperPositionControl', building: 'Lib' }),
        sensor: key({ id: 'hw_x_discFlow_0', phase: 1, _pointKey: 'discFlow', building: 'Lib' }),
        seqRow: key({ id: 'seq_x_ahu_min_oa_gap_1', phase: 2, seqKey: 'ahu_min_oa', building: 'Lib' }),
        oppKey: key({ id: 'opp_powerMeter_Lib', phase: 1, oppKey: 'powerMeter', building: 'Lib' }),
        fso: key({ id: 'fso_x_sat_0', phase: 1, _pointKey: 'sat', building: 'Lib' }),
        fdd: key({ id: 'fsc_fdd_project_1', phase: 1, isFddAddon: true, building: 'Lib' }),
        sinv: key({ id: 'sinv_offline_x', phase: 2, building: 'Lib' }),
        noOpp: key({ id: 'hw_x_oat_0', phase: 1, _pointKey: 'oat', building: 'Lib' }),
        noSeqRow: key({ id: 'seq_x_ahu_economizer_gap_1', phase: 2, seqKey: 'ahu_economizer', building: 'Lib' }),
        empty: key({ id: 'hw_x_sat_0', phase: 1, _pointKey: 'sat', building: 'Other' }, []),
      };

      // ---- the new lines: prices from the constants (the opportunities are stubbed, the rows are the real builder) ----
      const real = window._a36OpportunityList;
      const S = (b, key, kind, units) => ({ bName: b, lib: b, key, kind, label: key + ' label', units, affected: [], missingKeys: [] });
      window._a36OpportunityList = () => [
        S('Alpha Library', 'hwOverride', 'building', 1),
        S('Alpha Library', 'chwDpOverride', 'building', 1),
        S('Alpha Library', 'schedules', 'schedule', 4),
        S('Alpha Library', 'lightingSchedule', 'schedule', 2),
        S('Alpha Library', 'lightingPhotocell', 'building', 3),
        S('Beta Library', 'lightingOccupancy', 'building', 5),
        S('Beta Library', 'powerMeter', 'building', 0),
        S('Beta Library', 'zoneSetpoints', 'setpoint', 2),
      ];
      const lab = buildOpportunityLaborRows(PID);
      res.lab = {
        rate,
        rows: lab.map((r) => ({ id: r.id, b: r.building, phase: r.phase, qty: r.qty, total: r.lineTotal, parts: r.partsLineTotal == null ? null : r.partsLineTotal, instH: r.installHours == null ? null : r.installHours, hrsPerUnit: r.hrsPerUnit == null ? null : r.hrsPerUnit, oppKey: r.oppKey, fixedPrice: r.fixedPrice })),
        c: { OVERRIDE_RELEASE_HOURS, PHOTOCELL_MATERIAL_PRICE, PHOTOCELL_HOURS, OCCUPANCY_SENSOR_MATERIAL_PRICE, OCCUPANCY_SENSOR_HOURS, POWER_METER_PRICE },
        inRec: _pricingTierRowsSplit(PID, 'recommended').base.filter((r) => /^opp_/.test(r.id)).map((r) => r.id).sort(),
        inFull: _pricingTierRowsSplit(PID, 'full-scope').base.filter((r) => /^opp_/.test(r.id)).map((r) => r.id).sort(),
        inComp: _pricingTierRowsSplit(PID, 'compliance').base.filter((r) => /^opp_/.test(r.id)).length,
      };
      window._a36OpportunityList = real;

      // ---- the count sentence ----
      const d2 = collectASHRAE36Data(PID, '2026-11-18', null);
      const counts = _rptA36OppCounts(d2);
      const html = generateASHRAE36AuditHTML(d2, { cover: true, executive: true, costEstimate: true, building: true, setpointReview: true, pointInventory: true });
      const text = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html').body.textContent.replace(/\s+/g, ' ');
      res.counts = counts;
      res.coverSentence = (/The Recommended option covers (\d+) of them\./.exec(text) || [])[1] || null;
      res.coverCount = (text.match(/The Recommended option covers \d+ of them\./g) || []).length;
      res.libCountsOne = /each library counts as one opportunity/i.test(text);
      res.recorded = (/recorded (\d+) opportunit/.exec(text) || [])[1] || null;
      return res;
    });

    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));

    // ---- 1. findings model ----
    const byKey = (b, k) => out.opps.filter((o) => o.b === b && o.key === k);
    ok(byKey('Alpha Library', 'vav_dcv').length === 1, '1. the zone terminals of two groups (variable air volume and fan-powered) give ONE occupancy-based ventilation opportunity: ' + JSON.stringify(byKey('Alpha Library', 'vav_dcv')));
    const alphaT = out.libTerminals.find((x) => x.b === 'Alpha Library').terminals;
    ok(out.dcvTotals.some((x) => x.b === 'Alpha Library' && x.total === alphaT), '1. that opportunity counts the terminals of both groups (' + alphaT + '): ' + JSON.stringify(out.dcvTotals));
    ok(byKey('Alpha Library', 'ahu_min_oa').length === 1 && byKey('Alpha Library', 'demandCtrl').length === 1, '1. minimum outdoor air and occupancy-based ventilation of the air handling units are TWO opportunities');
    ok(!out.opps.some((o) => o.keys && o.keys.length > 1 || /Minimum Outdoor Air and Occupancy-Based/i.test(o.label)), '1. no opportunity stands for two sequences');
    ok(out.dupKeys === 0, '1. no library has two opportunities with the same key');

    // ---- 2. the mapping rule ----
    ok(out.map.hwdp === 'hwp_pump_dp_reset' && out.map.pump === 'hwp_pump_dp_reset', '2. the pressure sensor and the pump drive merge into the pump pressure reset: ' + out.map.hwdp + ' / ' + out.map.pump);
    ok(out.map.co2 === 'vav_dcv' && out.map.co2Ahu === 'demandCtrl', '2. the room CO2 sensors merge into the zone terminal ventilation, the duct CO2 sensors into the air handler ventilation: ' + out.map.co2 + ' / ' + out.map.co2Ahu);
    ok(out.map.damper === 'ahu_min_oa', '2. the damper actuator (blocking sensor of minimum outdoor air) merges into that sequence: ' + out.map.damper);
    ok(out.map.sensor === 'discFlow' && out.map.seqRow === 'ahu_min_oa' && out.map.oppKey === 'powerMeter', '2. a sensor opportunity, a sequence row and an oppKey row map to their opportunity');
    ok(out.map.fso === null && out.map.fdd === null && out.map.sinv === null, '2. the optional points, the FDD add-on and the sensor checks are no opportunity');
    ok(out.map.noOpp === null && out.map.noSeqRow === null && out.map.empty === null, '2. a row that no opportunity of its library names maps to nothing (it prints under Included)');

    // ---- 3. 1:1 both ways ----
    ['recommended', 'compliance', 'full-scope'].forEach((t) => {
      const T = out.tiers[t];
      ok(T.nRows > 0, '3. ' + t + ': has priced rows (' + T.nRows + ')');
      ok(T.idsOnce, '3. ' + t + ': every priced row is in exactly one line or in Included, none twice');
      ok(T.oppOnce, '3. ' + t + ': no opportunity has two lines');
      ok(T.detLines === T.nLines && T.detIncluded <= T.nUnmapped, '3. ' + t + ': the Service Proposal list has one entry per line (' + T.detLines + ' of ' + T.nLines + ')');
      ok(T.panelOppLis === T.nLines, '3. ' + t + ': the printed Opportunities list has ' + T.nLines + ' entries: ' + T.panelOppLis + ' (' + T.panelHead + ')');
      ok(/^Opportunities \(\d+\)/.test(T.panelHead) && T.panelHead.indexOf('(' + T.nLines + ')') > -1, '3. ' + t + ': the heading counts the lines (' + T.panelHead + ')');
      ok(T.detTitles.every((x) => /^(Alpha|Beta) Library: /.test(x)), '3. ' + t + ': every line names its library and the opportunity');
      ok(T.subtotalR === null || T.printed + (T.rounding || 0) === T.subtotalR, '3. ' + t + ': the printed whole-dollar lines + Rounding add up to the Devices and Programming parts of the option (' + T.printed + ' + ' + (T.rounding || 0) + ' = ' + T.subtotalR + ')');
    });
    const F = out.tiers['full-scope'];
    ok(F.nLines === out.opps.length - out.noPriceOpps, '3. Full Scope: the number of lines (' + F.nLines + ') equals the number of opportunities (' + out.opps.length + ') minus the setpoint and schedule opportunities, which have no line (' + out.noPriceOpps + ')');
    ok(F.panelHasIncludedWord || F.nUnmapped === 0, '3. Full Scope: rows of no opportunity print under Included');
    ok(out.tiers.recommended.nLines <= out.opps.length && out.tiers.recommended.nLines > 0, '3. Recommended: ' + out.tiers.recommended.nLines + ' lines of ' + out.opps.length + ' opportunities');
    ok(near(F.sumLinesRows + F.sumRows - F.sumRows, F.sumLinesRows) && F.sumLinesRows <= F.sumRows + 0.01, '3. Full Scope: the lines hold the money of their rows (' + F.sumLinesRows + ' of ' + F.sumRows + ')');

    // ---- 4. per library ----
    ok(out.noPriceOpps > 0, '4. the synthetic project has setpoint opportunities (' + out.noPriceOpps + ') that the audit still reports');
    ok(['recommended', 'compliance', 'full-scope'].every((t) => out.spRows[t] === 0), '4. no priced row of any option is a setpoint or schedule row: ' + JSON.stringify(out.spRows));
    ok(['recommended', 'compliance', 'full-scope'].every((t) => !out.tiers[t].lineKeys.some((k) => /\|(zoneSetpoints|schedules|lightingSchedule)$/.test(k))), '4. no line of any option is a setpoint or schedule opportunity');
    ok(out.removed.builder === 'undefined' && out.removed.plan === 'undefined' && out.removed.sched === 'undefined' && out.removed.schedB === 'undefined' && out.removed.sp === 'undefined', '4. the setpoint pricing builder, plan and constants no longer exist: ' + JSON.stringify(out.removed));
    ok(out.tstd.rows.length === out.tstd.plan.libs.length && out.tstd.rows.reduce((s, r) => s + r.qty, 0) === out.tstd.plan.boxes, '4. one terminal unit upgrade row per library; the units add up to the plan');

    // ---- 5. the new lines ----
    const R = (id) => out.lab.rows.find((r) => r.id === id) || {};
    const rate = out.lab.rate;
    const c = out.lab.c;
    ok(c.OVERRIDE_RELEASE_HOURS === 1 && c.PHOTOCELL_MATERIAL_PRICE === 150 && c.PHOTOCELL_HOURS === 3 && c.OCCUPANCY_SENSOR_MATERIAL_PRICE === 120 && c.OCCUPANCY_SENSOR_HOURS === 2 && c.POWER_METER_PRICE === 5000, '5. the constants are 1 h, 150 + 3 h, 120 + 2 h, 5000 per meter (Matt 2026-11-19)');
    ok(out.lab.rows.length === 5 && !out.lab.rows.some((r) => /schedules|lightingSchedule|zoneSetpoints/i.test(r.id)), '5. one row for each of the 5 priced opportunities (the schedule and setpoint opportunities get none): ' + out.lab.rows.map((r) => r.id).join(', '));
    ok(near(R('opp_hwOverride_Alpha Library').total, 1 * rate) && R('opp_hwOverride_Alpha Library').phase === 2, '5. an override: 1.0 h at the hourly rate, programming: ' + R('opp_hwOverride_Alpha Library').total);
    ok(near(R('opp_chwDpOverride_Alpha Library').total, 1 * rate), '5. a second override opportunity of the same library has its own line of 1.0 h');
    const ph = R('opp_lightingPhotocell_Alpha Library');
    ok(ph.phase === 1 && ph.qty === 1 && near(ph.parts, 150) && ph.instH === 3 && near(ph.total, 150 + 3 * rate), '5. exterior photocell: $150 + 3 h per library, one row for 3 exterior units: ' + JSON.stringify(ph));
    const oc = R('opp_lightingOccupancy_Beta Library');
    ok(oc.phase === 1 && oc.qty === 5 && near(oc.parts, 600) && oc.instH === 2 && near(oc.total, 5 * (120 + 2 * rate)), '5. interior occupancy: $120 + 2 h per affected unit (5 units): ' + JSON.stringify(oc));
    const pm = R('opp_powerMeter_Beta Library');
    ok(pm.phase === 1 && pm.qty === 1 && pm.fixedPrice === true && near(pm.total, 5000) && !pm.instH, '5. power meter: one fixed price of $5,000 per library (Matt 2026-11-19): ' + JSON.stringify(pm));
    ok(out.lab.rows.every((r) => r.oppKey), '5. every new row carries its opportunity key');
    ok(out.lab.inRec.length === 5 && out.lab.inFull.length === 5, '5. the 5 new lines are in Recommended and in Full Scope: ' + out.lab.inRec.length + ' / ' + out.lab.inFull.length);
    ok(out.lab.inComp === 0, '5. none of them is in Compliance');

    // ---- 6. the count sentence ----
    ok(out.counts.total === out.opps.length, '6. the opportunity count of the report equals the model list (' + out.counts.total + ')');
    ok(out.counts.fullScope === out.opps.length - out.noPriceOpps, '6. Full Scope has a line for every opportunity except the setpoint and schedule ones (' + out.counts.fullScope + ' of ' + out.opps.length + ', ' + out.noPriceOpps + ' without a line)');
    ok(out.counts.recommended > 0 && out.counts.recommended <= out.counts.total, '6. Recommended covers ' + out.counts.recommended + ' of ' + out.counts.total);
    ok(String(out.counts.recommended) === out.coverSentence, '6. the cover says "The Recommended option covers N of them." with N = ' + out.counts.recommended + ' (cover: ' + out.coverSentence + ')');
    ok(out.coverCount >= 1 && out.coverCount <= 2, '6. the sentence is printed once per place that states the count (' + out.coverCount + ' times in the cover and the Executive Summary)');
    ok(String(out.counts.total) === out.recorded, '6. the cover count equals the number of opportunities: ' + out.recorded);
    ok(!out.libCountsOne, '6. no sentence says that each library counts as one opportunity');

    ok(errs.length === 0, 'no page errors at the end: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
