// tools/test-a36-round7-coverage.js - round 7 classification and coverage fixes R1-R4 (2026-11-14). SYNTHETIC data only, headless bundled Chromium.
//   R1 a zone terminal (vav, fpb) with no heating device is cooling-only: reheat valve and discharge air temperature are N/A (source 'noHeat'),
//      the reheat sequence is N/A, no finding, no price row. A terminal fed hot deck air: reheat valve N/A, reheat sequence N/A.
//      A terminal with a heating valve or a heat source keeps today's behavior. "Setpoint / Heating ..." points are not heating evidence.
//   R2 an offline unit gets no sensor investigation rows and one offline-check line; an online unit with a bad reading keeps its row.
//   R3 the Building Readiness note says the portfolio scores weight each building by its amount of equipment.
//   R4 a hot water plant with no pump drive point gets a priced pump drive ($3,000 covering price + 5.0 h install labor) per plant unit, in every
//      tier that programs the differential pressure reset; a plant with a drive status or speed point stays $0; the audit text says
//      "Install a variable frequency drive on the hot water pump" exactly where the price is a drive.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-round7-coverage.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};
const RE = fs.readFileSync(path.join(ROOT, 'app', 'report-engine.js'), 'utf8');

(async () => {
  const ctx = await launchBrowser('a36-round7');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof generateASHRAE36AuditHTML === 'function' && window.DB && DB.isReady(), null, { timeout: 30000 });

    const out = await page.evaluate(async () => {
      const mk = (id, b, cat, name, p, sub) => ({ id, building: b, category: cat, subtype: sub || '', equipName: name, location: '', controllerType: 'Sample Controller', points: p, pointsRaw: Object.assign({}, p) });
      // a terminal that is cooling-only on evidence: zone points, the "Setpoint / Heating ..." set points and a cooling request only
      const coolOnly = { 'Zone Temp': '72.4 F', 'Air Flow': '210', 'Damper Position': '40', 'Zone Cooling Setpoint': '74', 'Zone Heating Setpoint': '70', 'Setpoint / Heating Occupied Setpoint': '70', 'Setpoint / Effective Heating Setpoint': '70', 'Primary Air Source Cool Request': '0' };
      const hotDeck = Object.assign({}, coolOnly, { 'Air Source Hot Deck Supply Temp': '110 F', 'Air Source Hot Deck Duct Static': '1', 'Heating Air Source Minimum': '100', 'Primary Air Source Heat Request': '0' });
      const valve = Object.assign({}, coolOnly, { 'Heating Valve': '20 %' });
      const heatSrc = Object.assign({}, coolOnly, { 'Heat Source Status': 'On' });
      const sets = {
        // R1: five terminals of the three kinds
        r1cool: [mk('c1', 'Alpha Hall', 'vav', 'Room 1 - VAV-1', coolOnly), mk('c2', 'Alpha Hall', 'fpb', 'Room 2 - FPB-2', coolOnly), mk('c3', 'Alpha Hall', 'vav', 'Room 3 - VAV-3', hotDeck)],
        // (the hot water plant is there so that the building has a hot water plant: no plant is a different, older N/A evidence)
        r1heat: [mk('h1', 'Alpha Hall', 'vav', 'Room 4 - VAV-4', valve), mk('h2', 'Alpha Hall', 'vav', 'Room 5 - VAV-5', heatSrc), mk('h3', 'Alpha Hall', 'hwp', 'Hot Water System', { 'Hot Water Pump 1 Speed': '50', 'Boiler 1 Status': 'On' }), mk('h4', 'Alpha Hall', 'vav', 'Room 8 - VAV-8', { 'Damper Position': '40' })],
        // R2: one offline unit (every point reads "?"), one online unit with a bad zone temperature reading
        r2: [
          mk('o1', 'Alpha Hall', 'fpb', 'Room 6 - FPB-6', Object.fromEntries(['Zone Temp', 'Air Flow', 'Damper Position', 'Heating Valve', 'Zone Cooling Setpoint', 'Zone Heating Setpoint', 'Low Zone Temperature', 'High Zone Temperature', 'Virtual Zone Temperature', 'Fan Status', 'Supply Temperature', 'Fan Speed Command'].map((k) => [k, '?']))),
          mk('o2', 'Beta Hall', 'vav', 'Room 7 - VAV-7', Object.assign({}, valve, { 'Zone Temp': '? F', 'Supply Temperature': '55 F' })),
        ],
        // R4: plant with no pump drive point (two plant units), plant with a drive status, plant with a speed point
        r4: [
          mk('p1', 'Alpha Hall', 'hwp', 'Hot Water System A1', { 'Hot Water Pump 1 Enable': 'On', 'Hot Water Pump 1 H-O-A': 'Auto', 'Hot Water Pump 1 Status': 'On', 'Boiler 1 Status': 'On', 'Hot Water Supply Temp': '150 F' }),
          mk('p2', 'Alpha Hall', 'hwp', 'Hot Water System A2', { 'Hot Water Pump 2 Enable': 'On', 'Hot Water Pump 2 Status': 'On', 'Boiler 2 Status': 'On', 'Hot Water Supply Temp': '150 F' }),
          mk('p3', 'Beta Hall', 'hwp', 'Hot Water System B', { 'HWP-1 Enable': 'On', 'HWP-1 VFD Status': 'On', 'HWP-2 VFD Status': 'On', 'Boiler 1 Status': 'On', 'Hot Water Supply Temp': '150 F' }),
          mk('p4', 'Gamma Hall', 'hwp', 'Hot Water System C', { 'Hot Water Pump 1 Speed': '60', 'Hot Water Pump 1 Amperage': '1.7', 'Boiler 1 Status': 'On', 'Hot Water Supply Temp': '150 F' }),
          // one plant row with two pumps and no pump drive; the boiler burner fan speed is not a pump drive
          mk('p5', 'Delta Hall', 'hwp', 'Hot Water System D', { 'HWP-1 Enable': 'On', 'HWP-1 H-O-A': 'Auto', 'HWP-2 Enable': 'Off', 'Hot Water Pump 2 Status': 'Off', 'Boiler 1 Fan Speed': '40', 'Hot Water Supply Temp': '150 F' }),
        ],
        // the wording rule of the supply fan drive: a single-zone air handler that reads its fan speed has the drive
        szSpeed: [
          mk('s1', 'Alpha Hall', 'ahu', 'AHU-1', { 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F', 'Supply Fan Speed Feedback': '60 %' }, 'sz'),
          mk('s2', 'Alpha Hall', 'ahu', 'AHU-2', { 'Supply Air Temp': '55 F', 'Return Air Temp': '72 F', 'Supply Fan Speed Feedback': '60 %' }, 'sz'),
        ],
      };
      const res = {};
      let pid = 900700;
      for (const k of Object.keys(sets)) {
        pid++;
        projects.push({ id: pid, name: 'Synthetic ' + k, client: 'Synthetic ' + k, type: 'K-12', start: '2025-01-01' });
        await sset('en_eqmatrix_' + pid, { rows: sets[k], importedAt: null, buildings: ['Alpha Hall', 'Beta Hall', 'Gamma Hall', 'Delta Hall'] });
        const d = collectASHRAE36Data(pid, '2026-11-10', null);
        const eqs = [];
        d.buildings.forEach((b) => b.equipResults.forEach((e) => eqs.push(e)));
        const c = _a36DetContext(d);
        const slim = (r) => ({ b: r.building, item: r.item, pk: r._pointKey, seq: r.seqKey, qty: r.qty, unit: r.unitPrice, total: r.lineTotal, io: !!r.ioOnly, inv: !!r.isSensorInvestigation, off: !!r.isOfflineCheck, eq: r.equipment, label: typeof _rptA36PlainRowLabel === 'function' ? _rptA36PlainRowLabel(r) : '' });
        const tiers = {};
        ['compliance', 'recommended', 'full-scope'].forEach((t) => {
          const s = _pricingTierRowsSplit(pid, t);
          tiers[t] = s.base.concat(s.optional).map(slim);
        });
        res[k] = {
          units: eqs.map((e) => ({
            name: e.name,
            cat: e.category,
            naEv: Object.fromEntries(Object.entries(e.compliance.naEvidence || {}).map(([kk, v]) => [kk, v.source])),
            naPts: (e.compliance.naPoints || []).map((p) => p.categoryKey + ':' + p.source),
            reheat: e.seqReadiness && e.seqReadiness.vav_reheat ? e.seqReadiness.vav_reheat.status : null,
            pumpDrive: e.compliance.pumpDrive,
            pumpCount: e.compliance.pumpCount,
            pumpSeq: e.seqReadiness && e.seqReadiness.hwp_pump_dp_reset ? e.seqReadiness.hwp_pump_dp_reset.status : null,
          })),
          findings: c.model.findings.map((f) => ({ lib: f.lib, g: f.groupLabel, kind: f.kind, key: f.key, rec: f.recommendation, impact: f.impact, observed: f.observed, affected: f.affected })),
          tiers,
          rate: typeof COST_LABOR_RATE_DEFAULT !== 'undefined' ? _pricingGetConfig().hourlyRate || COST_LABOR_RATE_DEFAULT : null,
        };
      }
      return res;
    });

    const U = (k, name) => out[k].units.find((u) => u.name === name);
    const rowsOf = (k, t, f) => out[k].tiers[t].filter(f);
    const TIERS = ['compliance', 'recommended', 'full-scope'];

    // ---- R1 ----
    const cv = U('r1cool', 'Room 1 - VAV-1');
    ok(cv.naEv.reheatValve === 'noHeat' && cv.naEv.dat === 'noHeat', 'R1. a cooling-only vav: reheat valve and discharge air temperature N/A, source noHeat: ' + JSON.stringify(cv.naEv));
    ok(cv.naPts.indexOf('dat:noHeat') > -1, 'R1. the discharge air temperature is a required point that is N/A (not missing): ' + cv.naPts);
    ok(cv.reheat === 'na', 'R1. the reheat sequence of a cooling-only vav is N/A: ' + cv.reheat);
    const fp = U('r1cool', 'Room 2 - FPB-2');
    ok(fp.naEv.reheatValve === 'noHeat' && fp.naEv.dat === 'noHeat' && fp.reheat === 'na', 'R1. a cooling-only fan-powered box: same: ' + JSON.stringify(fp.naEv) + ' ' + fp.reheat);
    const hd = U('r1cool', 'Room 3 - VAV-3');
    ok(hd.naEv.reheatValve === 'hotDeck' && !hd.naEv.dat && hd.reheat === 'na', 'R1. a terminal fed hot deck air: reheat valve N/A (hotDeck), reheat sequence N/A, discharge air temperature still asked: ' + JSON.stringify(hd.naEv) + ' ' + hd.reheat);
    ok(out.r1cool.findings.every((f) => f.key !== 'vav_reheat' && f.key !== 'reheatValve'), 'R1. no reheat or reheat valve finding on the cooling-only and hot deck terminals: ' + out.r1cool.findings.map((f) => f.key));
    ok(out.r1cool.findings.filter((f) => f.key === 'dat').every((f) => f.affected.length === 1 && /VAV-3/.test(f.affected[0])), 'R1. the only discharge air temperature finding is for the hot deck terminal (VAV-3): ' + out.r1cool.findings.filter((f) => f.key === 'dat').map((f) => f.affected));
    TIERS.forEach((t) => {
      const bad = rowsOf('r1cool', t, (r) => r.pk === 'reheatValve' || r.seq === 'vav_reheat').concat(rowsOf('r1cool', t, (r) => r.pk === 'dat' && /VAV-1|FPB-2/.test(r.item + r.label)));
      ok(bad.length === 0, 'R1. ' + t + ': no reheat or reheat valve price row for the cooling-only terminals');
    });
    ok(out.r1cool.tiers.compliance.filter((r) => r.pk === 'dat').reduce((n, r) => n + r.qty, 0) === 1, 'R1. compliance: one discharge air temperature row unit (the hot deck terminal), none for the two cooling-only terminals: ' + out.r1cool.tiers.compliance.filter((r) => r.pk === 'dat').map((r) => r.qty));
    const hv = U('r1heat', 'Room 4 - VAV-4');
    const hs = U('r1heat', 'Room 5 - VAV-5');
    ok(!hv.naEv.reheatValve && !hv.naEv.dat && hv.reheat !== 'na', 'R1. a terminal with a heating valve keeps today\'s behavior: ' + JSON.stringify(hv.naEv) + ' ' + hv.reheat);
    ok(!hs.naEv.reheatValve && !hs.naEv.dat && hs.reheat !== 'na', 'R1. a terminal with a heat source point keeps today\'s behavior (reheat valve and discharge air temperature still asked): ' + JSON.stringify(hs.naEv) + ' ' + hs.reheat);
    const unk = U('r1heat', 'Room 8 - VAV-8');
    ok(!unk.naEv.reheatValve && !unk.naEv.dat && unk.reheat !== 'na', 'R1. a terminal that shows no zone temperature point proves nothing: not N/A: ' + JSON.stringify(unk.naEv) + ' ' + unk.reheat);
    ok(out.r1heat.findings.some((f) => f.key === 'vav_reheat' || f.key === 'dat'), 'R1. a heated terminal keeps its finding: ' + out.r1heat.findings.map((f) => f.key));
    ok(out.r1heat.tiers['full-scope'].some((r) => r.seq === 'vav_reheat') && out.r1heat.tiers.compliance.some((r) => r.pk === 'dat'), 'R1. a heated terminal keeps its reheat sequence row (Full Scope) and discharge air temperature row (Compliance)');
    ok(/emTerminalHeating\(rawNames\) === 'none'/.test(fs.readFileSync(path.join(ROOT, 'app', 'equipment-matrix.js'), 'utf8')), 'R1. the one rule lives in emNaEvidence (equipment-matrix.js)');

    // ---- R2 ----
    TIERS.forEach((t) => {
      const inv = rowsOf('r2', t, (r) => r.inv);
      if (t === 'compliance') return ok(inv.length === 0, 'R2. compliance carries no investigation rows (unchanged)');
      const offRows = inv.filter((r) => /FPB-6/.test(r.label + r.item) || r.off);
      const wrong = inv.filter((r) => !r.off);
      ok(inv.filter((r) => r.off).length === 1 && inv.filter((r) => r.off)[0].label === 'Check an offline unit (power and network)', 'R2. ' + t + ': exactly one offline-check line: ' + inv.filter((r) => r.off).map((r) => r.label));
      ok(wrong.length === 1 && /zone air temperature sensor that reads wrong/.test(wrong[0].label), 'R2. ' + t + ': the online unit keeps its "reads wrong" row, the offline unit has none: ' + wrong.map((r) => r.label));
      const line = inv.find((r) => r.off);
      ok(line && line.unit === wrong[0].unit && line.total === line.unit, 'R2. ' + t + ': the offline line is one hour at the existing investigation price ' + (line && line.unit));
    });

    // ---- R3 ----
    ok(/The portfolio scores weight each building by its amount of equipment, so they can differ a little from the totals of the counts in this table\./.test(RE), 'R3. the Building Readiness note is in the table footnote');
    const html = await page.evaluate(() => {
      const d = collectASHRAE36Data(900701, '2026-11-10', null);
      return generateASHRAE36AuditHTML(d, { cover: true, executive: true, costEstimate: true, building: true }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    });
    ok(/portfolio scores weight each building by its amount of equipment/.test(html), 'R3. the rendered audit prints the note');

    // ---- R4 ----
    const pa = ['p1', 'p2'].map((n, i) => U('r4', 'Hot Water System A' + (i + 1)));
    ok(pa.every((u) => u.pumpDrive === false), 'R4. a plant with only enable, hand-off-auto and status points shows no pump drive (an amps point is drive evidence, Matt 2026-11-17)');
    ok(U('r4', 'Hot Water System D').pumpDrive === false && U('r4', 'Hot Water System D').pumpCount === 2, 'R4. a boiler fan speed point is not a pump drive; HWP-1 and HWP-2 are 2 pumps');
    ok(U('r4', 'Hot Water System A1').pumpCount === 1 && U('r4', 'Hot Water System B').pumpCount === 2, 'R4. pump count from the pump numbers in the point names');
    ok(U('r4', 'Hot Water System B').pumpDrive === true && U('r4', 'Hot Water System C').pumpDrive === true, 'R4. a plant with a drive status point, and a plant with a speed point, show a pump drive');
    const want = 3000 + 5 * out.r4.rate;
    TIERS.forEach((t) => {
      const drv = rowsOf('r4', t, (r) => r.pk === 'hwPumpSpeed' && !r.io && r.b === 'Alpha Hall');
      const qty = drv.reduce((n, r) => n + r.qty, 0);
      ok(qty === 2 && drv.every((r) => Math.abs(r.unit - want) < 0.01), 'R4. ' + t + ': the no-drive plant units are priced: qty 2 (one per plant unit as the data counts them), each $3,000 + 5.0 h install = ' + want + ': ' + drv.map((r) => r.qty + 'x' + r.unit));
      const two = rowsOf('r4', t, (r) => r.pk === 'hwPumpSpeed' && !r.io && r.b === 'Delta Hall');
      ok(two.reduce((n, r) => n + r.qty, 0) === 2, 'R4. ' + t + ': one plant row with two pumps (HWP-1, HWP-2) is priced 2 drives: ' + two.map((r) => r.qty));
      ok(two.length && two.every((r) => r.eq === '2 hot water pumps'), 'R4. ' + t + ': the drive line counts pumps ("2 hot water pumps", not "2 of 1 Hot Water Plant"): ' + two.map((r) => r.eq));
      const free = rowsOf('r4', t, (r) => r.pk === 'hwPumpSpeed' && r.b !== 'Alpha Hall' && r.b !== 'Delta Hall');
      ok(free.every((r) => r.total === 0), 'R4. ' + t + ': the plant with a drive status point is $0 I/O only: ' + free.map((r) => r.b + ':' + r.total));
    });
    ok(out.r4.tiers.recommended.some((r) => r.seq === 'hwp_pump_dp_reset'), 'R4. Recommended programs the differential pressure reset');
    const blk = await page.evaluate(() => SEQUENCE_BLOCKING_SENSORS.hwp_pump_dp_reset);
    ok(blk.indexOf('hwPumpSpeed') > -1, 'R4. the pump speed point blocks the sequence: ' + blk);
    const pf = (lib) => out.r4.findings.filter((f) => f.lib === lib && (f.key === 'hwp_pump_dp_reset' || f.key === 'hwPumpSpeed'));
    const drvText = (f) => /Install a variable frequency drive on the hot water pump of/.test(f.rec);
    ok(pf('Delta Hall').length > 0 && pf('Delta Hall').some((f) => /each of the 2 hot water pumps/.test(f.rec)), 'R4. a plant row with two pumps: the text says "each of the 2 hot water pumps": ' + pf('Delta Hall').map((f) => f.rec));
    ok(pf('Alpha Hall').length > 0 && pf('Alpha Hall').every(drvText), 'R4. the no-drive plant: the text says "Install a variable frequency drive on the hot water pump": ' + pf('Alpha Hall').map((f) => f.rec));
    ok(pf('Beta Hall').length > 0 && pf('Beta Hall').every((f) => !drvText(f) && /^Add the .* point/.test(f.rec)), 'R4. the plant with a drive status point: the plain "Add the ... point" text: ' + pf('Beta Hall').map((f) => f.rec));

    // ---- extra: the fan drive wording follows the price ----
    const szf = out.szSpeed.findings;
    ok(szf.length > 0 && szf.every((f) => !/variable frequency drive/i.test(f.rec + ' ' + f.impact)) && szf.filter((f) => f.kind === 'seq').every((f) => /^Add the .* point/.test(f.rec)), 'EXTRA. a single-zone group that reads its fan speed (sfSpeed) but has no speed command: no finding says "variable frequency drive", sequence findings say "Add the ... point": ' + szf.map((f) => f.key + ': ' + f.rec));
    ok(out.szSpeed.tiers.compliance.filter((r) => r.pk === 'sfSpeedCmd').every((r) => r.total === 0), 'EXTRA. and the speed command is $0 in the price: ' + out.szSpeed.tiers.compliance.filter((r) => r.pk === 'sfSpeedCmd').map((r) => r.total));

    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
