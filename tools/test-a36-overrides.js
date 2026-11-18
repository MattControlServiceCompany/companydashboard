// tools/test-a36-overrides.js - the manual override opportunities of the Audit Report and the value in the System Description sentence
// (2026-11-18, backlog bc1d9d95). SYNTHETIC names and values only; headless bundled Chromium; no network.
// Rules tested (each with a positive and a negative case):
//   - an ACTIVE manual override (row enabled + row.value) of A36_DET_OVERRIDE is ONE building-wide opportunity of the library for its kind
//     (hot water supply setpoint, hot water or chilled water differential pressure, supply air temperature, duct static pressure), an energy item;
//   - the sentence holds the value with its unit and the consequence (the reset does not run); air units are named; units with different values say so;
//   - the opportunity names its units, so the distinct-unit count (_a36AuditAffectedUnits) counts a unit once, and it is not an equipment device of
//     the Executive Summary (_a36ExecDeviceGroups);
//   - no value, a sequence that is not enabled, or a mode setpoint row (not an override id): no opportunity;
//   - the System Description sentence holds the value ("A manual override holds the differential pressure setpoint at 15 psi."); no value: no number.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-overrides.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('a36-overrides');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36DetDescriptionParas === 'function' && typeof _a36DetOverrideText === 'function' && typeof collectASHRAE36Data === 'function', null, { timeout: 30000 });

    await page.waitForFunction(() => !window.DB || window.DB.isReady(), null, { timeout: 30000 });

    // ---- the opportunities of the findings model ----
    const m = await page.evaluate(async () => {
      const PID = 900189;
      const rows = [
        { id: 'h1', building: 'Test Library', category: 'hwp', equipName: 'Hot Water System - Test', location: '', controllerType: 'Sample Controller', points: { 'Boiler 1 Enable': 'On', 'Hot Water Supply Temp': '120 °F' } },
        { id: 'c1', building: 'Test Library', category: 'chwp', equipName: 'Chilled Water System - Test', location: '', controllerType: 'Sample Controller', points: { 'Chiller 1 Enable': 'On', 'Chilled Water Supply Temp': '45 °F' } },
        { id: 'a1', building: 'Test Library', category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55 °F' } },
        { id: 'a2', building: 'Test Library', category: 'ahu', equipName: 'AHU-2', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '56 °F' } },
        { id: 'r1', building: 'Test Library', category: 'rtu', equipName: 'RTU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '57 °F' } },
        { id: 'r2', building: 'Test Library', category: 'rtu', equipName: 'RTU-2', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '58 °F' } },
      ];
      projects.push({ id: PID, name: 'Synthetic Override Project', client: 'Synthetic Override Project', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: [] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const L = 'Test Library';
      const seq = (equipName, id, extra) => Object.assign({ library: L, equipName, id, status: 'enabled', source: 'x.png' }, extra || {});
      const run = async (seqRows) => {
        await sset('en_auditseq_' + PID, { rows: seqRows, updated: 'x' });
        const d = collectASHRAE36Data(PID, '2026-11-18', null);
        const model = _a36DetContext(d).model;
        const list = model.findings
          .filter((f) => A36_DET_OVERRIDE_KEYS.indexOf(f.key) > -1)
          .map((f) => ({ key: f.key, label: f.label, observed: f.observed, headline: f.headline, effect: f.effect, kind: f.kind, category: f.category, units: f.units, total: f.total, affected: f.affected }));
        const dev = _a36ExecDeviceGroups(d).map((g) => g.label);
        return { list, units: _a36AuditAffectedUnits(model.findings.filter((f) => A36_DET_OVERRIDE_KEYS.indexOf(f.key) > -1)), dev, total: model.findings.length };
      };
      const out = {};
      out.base = await run([]);
      out.chw = await run([seq('Chilled Water System - Test', 'pump_dp_fixed', { value: 15 })]);
      out.hwdp = await run([seq('Hot Water System - Test', 'pump_dp_fixed', { value: 14 })]);
      out.hw = await run([seq('Hot Water System - Test', 'water_fixed_override', { value: 120 })]);
      out.sat = await run([seq('AHU-1', 'sat_fixed_override', { value: 60 })]);
      out.sp = await run([seq('RTU-1', 'sp_fixed', { value: 1 }), seq('RTU-2', 'sp_fixed', { value: 1 })]);
      out.spDiff = await run([seq('RTU-1', 'sp_fixed', { value: 1 }), seq('RTU-2', 'sp_fixed', { value: 1.2 })]);
      out.two = await run([seq('AHU-1', 'sat_fixed_override', { value: 60 }), seq('AHU-1', 'sp_fixed', { value: 1 }), seq('AHU-2', 'sat_fixed_override', { value: 55 })]);
      out.noValue = await run([seq('AHU-1', 'sat_fixed_override'), seq('Chilled Water System - Test', 'pump_dp_fixed')]);
      out.off = await run([seq('AHU-1', 'sat_fixed_override', { value: 60, status: 'available_not_enabled' })]);
      out.other = await run([seq('AHU-1', 'mode_fixed_setpoints', { value: 60 }), seq('Hot Water System - Test', 'hw_fixed_unocc', { value: 150 })]);
      // the text function: dual duct, several units
      const ov = A36_DET_OVERRIDE.filter((o) => o.key === 'satOverride')[0];
      out.dual = _a36DetOverrideText(ov, [{ name: 'AHU-1 - Test', dual: true, values: [60] }], 'Test Library');
      out.dualMixed = _a36DetOverrideText(ov, [{ name: 'AHU-1', dual: true, values: [60] }, { name: 'AHU-2', dual: false, values: [60] }], 'Test Library');
      return out;
    });
    const one = (r) => (r.list.length === 1 ? r.list[0] : null);
    ok(m.base.list.length === 0, 'no override recorded: no override opportunity');
    ok(one(m.chw) && one(m.chw).key === 'chwDpOverride' && one(m.chw).label === 'Chilled water pump pressure reset overridden' &&
      one(m.chw).observed === 'The chilled water differential pressure setpoint is held at 15 psi by a manual override, so the pump speed reset on requests does not run.', 'chilled water pump pressure override: one opportunity with the value in psi: ' + JSON.stringify(m.chw.list));
    ok(one(m.hwdp) && one(m.hwdp).key === 'hwDpOverride' && one(m.hwdp).observed === 'The hot water differential pressure setpoint is held at 14 psi by a manual override, so the pump speed reset on requests does not run.', 'hot water pump pressure override: ' + JSON.stringify(m.hwdp.list));
    ok(one(m.hw) && one(m.hw).key === 'hwOverride' && one(m.hw).observed === 'The hot water supply setpoint is held at 120°F by a manual override, so the outdoor air reset does not run.', 'hot water supply override: same sentence as before: ' + JSON.stringify(m.hw.list));
    ok(one(m.sat) && one(m.sat).key === 'satOverride' && one(m.sat).observed === 'The supply air temperature setpoint of AHU-1 is held at 60°F by a manual override, so the supply air temperature reset does not run.', 'supply air override names the unit and the value: ' + JSON.stringify(m.sat.list));
    ok(one(m.sp) && one(m.sp).key === 'spOverride' && one(m.sp).observed === 'The duct static pressure setpoints of RTU-1 and RTU-2 are held at 1 in. w.c. by a manual override, so the duct static pressure reset does not run.', 'two units with the same value: one opportunity, both named: ' + JSON.stringify(m.sp.list));
    ok(one(m.spDiff) && /held by a manual override \(RTU-1 at 1\u00a0in\.\u00a0w\.c\. and RTU-2 at 1\.2\u00a0in\.\u00a0w\.c\.\), so/.test(one(m.spDiff).observed), 'two units with different values: each value with its unit: ' + JSON.stringify(m.spDiff.list));
    ok(m.two.list.map((f) => f.key).sort().join() === 'satOverride,spOverride', 'one opportunity per kind: ' + JSON.stringify(m.two.list.map((f) => f.key)));
    ok(Object.keys(m.two.units).length === 2 && Object.keys(m.sp.units).length === 2 && Object.keys(m.base.units).length === 0, 'the units of the override opportunities are the distinct units named; a unit with two overrides counts once: ' + JSON.stringify(m.two.units));
    ok(one(m.sat) && one(m.sat).kind === 'building' && one(m.sat).effect === 'Energy use' && one(m.sat).category === 'ahu' && one(m.sat).headline === one(m.sat).observed, 'energy item on the row of its equipment type, headline = the fact');
    ok(one(m.sat) && one(m.sat).units === 1 && one(m.sat).total === 4 && one(m.sat).affected.join() === 'AHU-1', 'units = the affected units, total = the air units of the library (2 air handling + 2 rooftop): ' + JSON.stringify(one(m.sat)));
    ok(m.sat.total === m.base.total + 1, 'the override counts as one more opportunity');
    ok(m.chw.dev.join() === m.base.dev.join() && m.two.dev.join() === m.base.dev.join(), 'the Executive Summary device list holds no override: ' + m.two.dev.join(' | '));
    ok(m.noValue.list.length === 0 && m.off.list.length === 0 && m.other.list.length === 0, 'no value, not enabled, or a mode setpoint id: no opportunity');
    ok(m.dual === 'The cold deck setpoint of AHU-1 is held at 60°F by a manual override, so the cold deck reset does not run.', 'dual duct unit: the cold deck setpoint: ' + m.dual);
    ok(/^The supply air temperature setpoints of AHU-1 and AHU-2 are held at 60°F/.test(m.dualMixed), 'dual duct and single duct units together: the supply air wording: ' + m.dualMixed);

    // ---- the value in the System Description sentence ----
    const r = await page.evaluate(() => {
      const out = {};
      let seqTab = {};
      window._a36DetSequenceIds = function (name) { return seqTab[name] || []; };
      const mk = (cat, label, names) => {
        const rowsById = {};
        const eqs = names.map((nm, i) => {
          const id = cat + '-u' + i;
          const pts = { 'Supply Air Temp': '55', 'Boiler 1 Enable': 'On' };
          rowsById[id] = { id, pointsRaw: pts, points: pts };
          return { id, name: nm, compliance: { coveredPoints: [], missingPoints: [] } };
        });
        return _a36DetDescriptionParas({ category: cat, label, units: eqs, names: names, shown: [] }, { rowsById, setpointAppendix: false }, 0).join(' ');
      };
      const on = (id, extra) => Object.assign({ id, status: 'enabled' }, extra || {});
      seqTab = { 'Plant One': [on('pump_dp_fixed', { value: 15 }), on('water_fixed_override', { value: 120 })] };
      out.plant = mk('hwp', 'Hot Water Plant', ['Plant One']);
      seqTab = { 'Plant One': [on('pump_dp_fixed'), on('water_fixed_override')] };
      out.plantNone = mk('hwp', 'Hot Water Plant', ['Plant One']);
      seqTab = { 'Unit A': [on('sp_fixed', { value: 1 }), on('sat_fixed_override', { value: 60 })] };
      out.air = mk('ahu', 'Variable Air Volume Air Handling Unit', ['Unit A']);
      seqTab = { 'Unit A': [on('sat_fixed_override', { value: 60 })], 'Unit B': [on('sat_fixed_override', { value: 55 })] };
      out.airTwo = mk('ahu', 'Variable Air Volume Air Handling Unit', ['Unit A', 'Unit B']);
      seqTab = { 'Unit A': [on('sat_fixed_override', { value: 60 })], 'Unit B': [on('sat_fixed_override')] };
      out.airPart = mk('ahu', 'Variable Air Volume Air Handling Unit', ['Unit A', 'Unit B']);
      return out;
    });
    ok(r.plant.indexOf('A manual override holds the differential pressure setpoint at 15 psi.') > -1, 'pump: the differential pressure value prints: ' + r.plant);
    ok(r.plant.indexOf('A manual override holds the supply water temperature at 120°F.') > -1 && r.plant.indexOf('at a fixed value') < 0, 'plant: the supply water temperature value replaces "a fixed value"');
    ok(r.plantNone.indexOf('A manual override fixes the differential pressure setpoint.') > -1 && r.plantNone.indexOf('A manual override holds the supply water temperature at a fixed value.') > -1 && !/\d psi|\d°F/.test(r.plantNone), 'no value: no number, the base sentences stay: ' + r.plantNone);
    ok(r.air.indexOf('A manual override holds the duct static pressure setpoint at 1 in. w.c.') > -1 && r.air.indexOf('A manual override holds the supply air setpoint at 60°F.') > -1, 'air unit: duct static pressure and supply air values print: ' + r.air);
    ok(/at 55°F to 60°F, depending on the unit/.test(r.airTwo), 'units with different values: the range of values: ' + r.airTwo);
    ok(r.airPart.indexOf('A manual override fixes the supply air setpoint.') > -1 && !/\d°F/.test(r.airPart), 'a unit with no value: the value does not print for the group: ' + r.airPart);
    ok(!/ASHRAE/.test(r.plant + r.air), 'no ASHRAE word in the sentences');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
