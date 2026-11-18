// tools/test-a36-reset-values.js - the reset limits of the System Descriptions (Audit Report) and the "Hot water reset overridden" opportunity
// (2026-11-18, backlog bc1d9d95). SYNTHETIC names and values only; headless bundled Chromium; no network.
// Rules tested (each with a positive and a negative case):
//   - row.reset { oaFrom, oaTo, spFrom, spTo, min, max, unit } prints in the reset sentence of the plant or the air unit, every value marked (adjustable);
//   - the limits only print when every unit of the group has the same limits (else no value, the base sentence stays);
//   - a unit with the sequence but no recorded limits prints no value; a sequence that is not enabled prints none;
//   - static pressure and differential pressure limits print with their unit (in. w.c., psi);
//   - an active manual override on a hot water plant (row.value of water_fixed_override) is ONE building-wide opportunity "Hot water reset overridden"
//     with the observed fact; no override value: no opportunity.
// Run: CH_TMP_ROOT=<scratch> node tools/test-a36-reset-values.js   (exit 0 = all pass)
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
  const ctx = await launchBrowser('a36-reset-values');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof _a36DetDescriptionParas === 'function' && typeof _a36DetResetText === 'function' && typeof collectASHRAE36Data === 'function', null, { timeout: 30000 });

    const r = await page.evaluate(() => {
      const out = {};
      const cp = (key) => ({ categoryKey: key, ashrae36PointName: key, categoryLabel: key, pointName: key });
      let seqTab = {};
      window._realSeqIds = _a36DetSequenceIds;
      window._a36DetSequenceIds = function (name) { return seqTab[name] || []; };
      const mk = (cat, label, names, extraKeys) => {
        const rowsById = {};
        const eqs = names.map((nm, i) => {
          const id = cat + '-u' + i;
          const pts = { 'Supply Air Temp': '55', 'Boiler 1 Enable': 'On' };
          rowsById[id] = { id, pointsRaw: pts, points: pts };
          return { id, name: nm, compliance: { coveredPoints: (extraKeys || []).map(cp), missingPoints: [] } };
        });
        return _a36DetDescriptionParas({ category: cat, label, units: eqs, names: names, shown: [] }, { rowsById, setpointAppendix: false }, 0).join(' ');
      };
      const on = (id, extra) => Object.assign({ id, status: 'enabled' }, extra || {});
      const hw = { oaFrom: 0, oaTo: 80, spFrom: 180, spTo: 100, unit: 'F' };
      const hwLim = { min: 120, max: 180, unit: 'F' };

      // 1. hot water plant: reset with an outdoor air limit and request limits (merged sentence), values printed
      seqTab = { 'Plant One': [on('water_request_reset', { reset: hwLim }), on('water_oa_limit', { reset: hw })] };
      out.hw = mk('hwp', 'Hot Water Plant', ['Plant One']);
      // 2. chilled water plant: its own noun
      seqTab = { 'Plant Two': [on('water_request_reset', { reset: { min: 44, max: 55, unit: 'F' } }), on('water_oa_limit', { reset: { oaFrom: 75, oaTo: 65, spFrom: 48, spTo: 57, unit: 'F' } })] };
      out.chw = mk('chwp', 'Chilled Water Plant', ['Plant Two']);
      // 3. no recorded limits: base sentence, no value
      seqTab = { 'Plant One': [on('water_request_reset'), on('water_oa_limit')] };
      out.none = mk('hwp', 'Hot Water Plant', ['Plant One']);
      // 4. two plants with different limits: no value; two plants with the same limits: value
      seqTab = { 'Plant One': [on('water_request_reset', { reset: hwLim }), on('water_oa_limit', { reset: hw })], 'Plant Two': [on('water_request_reset', { reset: { min: 115, max: 170, unit: 'F' } }), on('water_oa_limit', { reset: hw })] };
      out.differ = mk('hwp', 'Hot Water Plant', ['Plant One', 'Plant Two']);
      seqTab = { 'Plant One': [on('water_request_reset', { reset: hwLim }), on('water_oa_limit', { reset: hw })], 'Plant Two': [on('water_request_reset', { reset: hwLim }), on('water_oa_limit', { reset: hw })] };
      out.same = mk('hwp', 'Hot Water Plant', ['Plant One', 'Plant Two']);
      // 5. request limits only (no outdoor air row): the short sentence; static pressure unit in. w.c.
      seqTab = { 'Unit A': [on('sat_request_reset', { reset: { min: 55, max: 70, unit: 'F' } }), on('sp_reset_requests', { reset: { min: 0.8, max: 1.5, unit: 'in. w.c.' } })] };
      out.air = mk('ahu', 'Variable Air Volume Air Handling Unit', ['Unit A']);
      // 6. an air unit with the outdoor air limit: supply air noun
      seqTab = { 'Unit A': [on('sat_request_reset', { reset: { min: 55, max: 70, unit: 'F' } }), on('sat_oa_limit', { reset: { oaFrom: 10, oaTo: 50, spFrom: 70, spTo: 55, unit: 'F' } })] };
      out.airOa = mk('ahu', 'Variable Air Volume Air Handling Unit', ['Unit A']);
      // 7. a sequence that is not enabled: no value
      seqTab = { 'Plant One': [{ id: 'water_request_reset', status: 'available_not_enabled', reset: hwLim }] };
      out.off = mk('hwp', 'Hot Water Plant', ['Plant One']);
      // 8. the text function: a partial outdoor air range prints no range; a value with no unit prints nothing
      out.partial = _a36DetResetText([{ oaFrom: 0, oaTo: 80, unit: 'F' }], 'hot water supply setpoint');
      out.noUnit = _a36DetResetText([{ min: 1, max: 2 }], 'x');
      out.psi = _a36DetResetText([{ min: 2, max: 8, unit: 'psi' }], 'differential pressure setpoint');
      return out;
    });
    const HW = 'The hot water supply setpoint resets from 180°F at 0°F outdoor air to 100°F at 80°F outdoor air (adjustable), with trim and respond requests holding it between 120°F and 180°F (adjustable).';
    ok(r.hw.indexOf(HW) > -1, 'hot water plant: reset range and request limits print, each marked (adjustable): ' + r.hw);
    ok(/with an outdoor air high limit\./.test(r.hw) && r.hw.indexOf('with an outdoor air high limit.') < r.hw.indexOf(HW), 'hot water plant: the value sentence follows the reset sentence');
    ok(/The chilled water supply setpoint resets from 48°F at 75°F outdoor air to 57°F at 65°F outdoor air \(adjustable\), with trim and respond requests holding it between 44°F and 55°F \(adjustable\)\./.test(r.chw), 'chilled water plant: own noun and values: ' + r.chw);
    ok(!/\d°F/.test(r.none) && /resets the hot water supply temperature/.test(r.none), 'no recorded limits: no value, the base sentence stays: ' + r.none);
    ok(!/resets from/.test(r.differ) && /with an outdoor air high limit/.test(r.differ), 'two plants with different limits: no value printed: ' + r.differ);
    ok(r.same.indexOf(HW) > -1, 'two plants with the same limits: the value prints: ' + r.same);
    ok(/Trim and respond requests hold the supply air setpoint between 55°F and 70°F \(adjustable\)\./.test(r.air), 'request limits only: the short sentence: ' + r.air);
    ok(/Trim and respond requests hold the duct static pressure setpoint between 0\.8\u00a0in\.\u00a0w\.c\. and 1\.5\u00a0in\.\u00a0w\.c\. \(adjustable\)\./.test(r.air), 'static pressure limits print with the unit in. w.c.: ' + r.air);
    ok(/The supply air setpoint resets from 70°F at 10°F outdoor air to 55°F at 50°F outdoor air \(adjustable\), with trim and respond requests holding it between 55°F and 70°F \(adjustable\)\./.test(r.airOa), 'air unit with the outdoor air limit: range and limits: ' + r.airOa);
    ok(!/\d°F/.test(r.off), 'a sequence that is not enabled prints no value: ' + r.off);
    ok(r.partial === '' && r.noUnit === '', 'a partial range or a value with no unit prints nothing');
    ok(r.psi === 'Trim and respond requests hold the differential pressure setpoint between 2 psi and 8 psi (adjustable).', 'psi unit: ' + r.psi);
    ok(!/ASHRAE/.test(r.hw + r.chw + r.air + r.airOa), 'no ASHRAE word in the sentences');

    // ---- the override opportunity (one building-wide item, same pattern as the power meter) ----
    const m = await page.evaluate(async () => {
      const PID = 900188;
      window._a36DetSequenceIds = window._realSeqIds; // the real reader (en_auditseq_<pid>)
      const rows = [
        { id: 'p1', building: 'Test Library', category: 'hwp', equipName: 'Hot Water System - Test', location: '', controllerType: 'Sample Controller', points: { 'Boiler 1 Enable': 'On', 'Hot Water Supply Temp': '120 °F' } },
        { id: 'a1', building: 'Test Library', category: 'ahu', equipName: 'AHU-1', location: '', controllerType: 'Sample Controller', points: { 'Supply Air Temp': '55 °F' } },
      ];
      projects.push({ id: PID, name: 'Synthetic Reset Project', client: 'Synthetic Reset Project', type: 'K-12', start: '2025-01-01' });
      await sset('en_eqmatrix_' + PID, { rows: rows, importedAt: null, buildings: [] });
      await sset('en_audit_' + PID, { findings: [], edits: {}, evidence: {} });
      const run = async (seqRows) => {
        await sset('en_auditseq_' + PID, { rows: seqRows, updated: 'x' });
        const d = collectASHRAE36Data(PID, '2026-11-18', null);
        const model = _a36DetContext(d).model;
        return model.findings.filter((f) => f.key === 'hwOverride').map((f) => ({ label: f.label, observed: f.observed, headline: f.headline, effect: f.effect, kind: f.kind, lib: f.lib, issueShort: f.issueShort, category: f.category }));
      };
      const base = { library: 'Test Library', equipName: 'Hot Water System - Test', source: 'x.png' };
      const out = {};
      out.held = await run([Object.assign({ id: 'water_fixed_override', status: 'enabled', value: 120 }, base)]);
      out.noValue = await run([Object.assign({ id: 'water_fixed_override', status: 'enabled' }, base)]);
      out.notEnabled = await run([Object.assign({ id: 'water_fixed_override', status: 'available_not_enabled', value: 120 }, base)]);
      out.none = await run([]);
      return out;
    });
    ok(m.held.length === 1 && m.held[0].label === 'Hot water reset overridden' && m.held[0].observed === 'The hot water supply setpoint is held at 120°F by a manual override, so the outdoor air reset does not run.', 'override with a value: one opportunity with the observed fact: ' + JSON.stringify(m.held));
    ok(m.held[0] && m.held[0].kind === 'building' && m.held[0].effect === 'Energy use' && m.held[0].category === 'hwp' && m.held[0].headline === m.held[0].observed, 'the opportunity is an energy item on the hot water plant row of the building page');
    ok(m.noValue.length === 0 && m.notEnabled.length === 0 && m.none.length === 0, 'no override value, a sequence that is not enabled, or no record: no opportunity');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
