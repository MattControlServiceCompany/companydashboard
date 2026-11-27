// Test: the engineering energy of each Service Proposal measure (computations/measure-savings.js) (Matt 2026-11-23, 8c5bfd4a).
// SYNTHETIC data, hand-computed values (no client names). Run: node tools/test-measure-savings.js   (exit 0 = all pass)
//
// Fixture "Test Hall" (B): 30,000 ft2; gas heat (AFUE 0.82); cooling COP 3.5; balance point 55 F; 2 air handlers, 20 terminal units, VAV.
//   Fan units (both have a variable-speed drive, default run hours 3,640, constant part-load fraction 1): A 5 kW, B 3 kW (8 kW).
//   End-use base: cooling 150,000 kWh; gas heating 6,000 therms.
//   Occupied-window bins (outdoor F: hours): 32.5: 1,000; 47.5: 1,000; 57.5: 1,000; 62.5: 500; 67.5: 500; 77.5: 500.
//   Occupied degree hours: heat 300,000 F h, cool 50,000 F h.
// Hand values of the LIKELY case (the formula in each line; every other case changes only the stated default inputs):
//   Design supply airflow = 30,000 / 300 x 400 = 40,000 cfm; average airflow = 40,000 x 0.6 = 24,000 cfm.
//   1. Duct static reset, 2 of 2 units: fraction saved = 1 - (0.10 + 0.90 x sqrt(1 - 0.20)^3) = 1 - (0.10 + 0.90 x 0.715542) = 0.256012;
//      fan kWh = (5 + 3) x 3,640 = 29,120; saved = 29,120 x 0.256012 x pass 0.7 = 5,218.6 kWh. Low (cut 0.15, 2,600 h, pass 0.5):
//      20,800 x 0.194705 x 0.5 = 2,024.9 kWh.
//   2. Supply air reset: reheat cfm = 40,000 x 0.40 (zones in reheat) x 0.35 (their minimum airflow) = 5,600. dSAT = 10 F in the 32.5, 47.5 and 57.5 bins, 7.5 F at 62.5, 2.5 F at 67.5, 0 at 77.5.
//      Reheat Btu = 1.08 x 5,600 x (10 x 3,000 + 7.5 x 500 + 2.5 x 500) = 1.08 x 5,600 x 35,000 = 211.68e6 -> / (100,000 x 0.82) = 2,581.5 therms.
//      Coil load: 57.5 bin 2.5 F x 1,000; 62.5 bin 7.5 F x 500; 67.5 bin (12.5 - 10) = 2.5 F x 500 -> 1.08 x 24,000 x 7,500 = 194.4e6 Btu
//      -> / (3.5 x 3,412.14) = 16,278.3 kWh. Fan: 0.
//   3. Economizer: outdoor air share = 3,000 / 40,000 = 0.075; mixed air = 69.375 + 0.075 t. Bins 57.5, 62.5, 67.5 (55 F up to the 70 F limit):
//      coil F h = (73.6875 - 55 - 2.5) x 1,000 + (74.0625 - 55 - 7.5) x 500 + (74.4375 - 55 - 12.5) x 500 = 16,187.5 + 5,781.25 + 3,468.75 = 25,437.5
//      -> 1.08 x 24,000 x 25,437.5 = 659.34e6 Btu -> / (3.5 x 3,412.14) = 55,209.6 kWh.
//   4. Air handler CO2, 2 of 2: outdoor air = 0.1 x 30,000 = 3,000 cfm; per-person share = 0.05 / (0.12 + 0.05) = 0.294118; occupancy 0.5 ->
//      cfm saved = 3,000 x 0.294118 x 0.5 = 441.18; heat = 1.08 x 441.18 x 300,000 / (100,000 x 0.82) = 1,743.2 therms;
//      cooling = 1.08 x 441.18 x 50,000 / (3.5 x 3,412.14) = 1,994.8 kWh.
//   5. Terminal minimum airflow, 10 of 20 boxes: box cfm = 40,000 / 20 = 2,000; delta cfm = 10 x 2,000 x (0.35 - 0.15) x 0.40 (boxes in reheat) = 1,600;
//      hours below 55 F = 2,000. Reheat = 1.08 x 1,600 x 20 F x 2,000 = 69.12e6 Btu -> / 82,000 = 842.9 therms. Fan kW = 8 x 10 / 20 x 0.40 = 1.6;
//      fan kWh = 1.6 x (0.35^3 - 0.15^3) x 2,000 = 1.6 x 0.0395 x 2,000 = 126.4 kWh.
//   6. Hot water pump reset: gpm = 30,000 x 30 / (500 x 20) = 90; BHP = 90 x 60 / (3,960 x 0.72) = 1.89394; kW = 1.89394 x 0.746 / 0.91 = 1.55266;
//      speed = sqrt(1 - 0.20) = 0.894427, cube 0.715542; hours below 55 F = 2,000 -> 1.55266 x (1 - 0.715542) x 2,000 = 883.4 kWh.
//      Chilled water: hours at or above 55 F = 2,500 -> 1.55266 x 0.284458 x 2,500 = 1,104.2 kWh.
//   7. Photocell, 2 circuits: 300 W x 2 / 1,000 x 2,000 h = 1,200 kWh. Occupancy sensors, 2 spaces: 32 W x 8 x 2 / 1,000 = 0.512 kW x 2,200 h x 0.30 x 0.85 = 287.2 kWh.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};
const near = (a, b, m, rel) => assert.ok(Math.abs(a - b) <= Math.abs(b) * (rel || 0.0001) + 1e-9, m + ': ' + a + ' vs ' + b);

// Synthetic typical year (city 4): bins 32.5, 57.5 and 77.5 F with 1,000 occupied hours each (8 to 18 h), the weather the vav_reheat template cooling reads.
const _hourly = (v) => Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? v / 10 : 0));
const SYN_WEATHER = { bins: [32.5, 57.5, 77.5], cities: { 4: { temp: Array.from({ length: 12 }, (_, m) => [_hourly(m === 0 ? 1000 : 0), _hourly(m === 0 ? 1000 : 0), _hourly(m === 0 ? 1000 : 0)]) } } };
const sb = {
  console, Math, JSON, Object, Array, String, Number, isFinite, parseFloat, parseInt, Date, window: {}, BAS_WEATHER_BINS: SYN_WEATHER,
  document: { getElementById: () => ({}), createElement: () => ({ style: {} }), head: { appendChild() {} }, addEventListener() {}, readyState: 'complete', body: { appendChild() {} } },
};
vm.createContext(sb);
['computations/physics.js', 'computations/fan-savings.js', 'app/ecm-calculators.js', 'computations/measure-savings.js'].forEach((f) =>
  vm.runInContext(read(f), sb, { filename: f }),
);
sb.fanReadUnits = () => ({ units: [], note: 'No Equipment Matrix rows for this project' }); // the Equipment Matrix reader: no fan row
sb.getUDBldg = () => ({ id: 'b', name: 'Test Hall', type: '', sqft: 30000 });
sb.sget = () => [];
const run = (code) => vm.runInContext(code, sb);
const fan = (id, kw) => ({ id, kw, hours: 3640, hoursLevel: 'default', kwLevel: 'default', kwh: kw * 3640, baselineFraction: 1, driveStatus: 'has', reset: { pass: 0.7, level: 'default' } });
const mkB = () => ({
  sqft: 30000, heatFuel: 'gas', afue: 0.82, cop: 3.5, heatBalanceF: 55,
  counts: { ahu: 2, box: 20, hasVav: true },
  fanUnits: [fan('a', 5), fan('b', 3)],
  fanCapKwh: null,
  base: { cool: 150000, heatEl: 0, heatGas: 6000 },
  bins: [{ t: 32.5, hours: 1000 }, { t: 47.5, hours: 1000 }, { t: 57.5, hours: 1000 }, { t: 62.5, hours: 500 }, { t: 67.5, hours: 500 }, { t: 77.5, hours: 500 }],
  degreeHours: { heat: 300000, cool: 50000 },
});
sb.B = mkB();
const est = (key, qty, B) => {
  sb._B = B || sb.B;
  sb._q = qty;
  return JSON.parse(JSON.stringify(run('msEstimate(' + JSON.stringify(key) + ', _B, _q)')));
};

// 1. duct static pressure reset
{
  const e = est('ahu_dsp_reset', 2);
  near(e.likely.kwh, 5218.6, 'duct static reset likely kWh', 0.0002);
  near(e.low.kwh, 2024.9, 'low kWh', 0.0005);
  assert.ok(e.low.kwh < e.likely.kwh && e.likely.kwh < e.high.kwh, 'low < likely < high');
  near(est('ahu_dsp_reset', 1).likely.kwh, 5218.6 / 2, '1 of 2 units = the mean of the units counted x 1', 0.0002);
  near(est('spOverride', null).likely.kwh, 5218.6, 'the override covers every unit: the same saving', 0.0002);
  assert.ok(e.likely.inputs.length >= 4 && e.likely.steps.length === 3, 'inputs and steps are returned');
  assert.ok(e.likely.inputs.every((i) => i.name && i.level && i.source !== undefined && 'value' in i), 'every input has name, value, level, source');
  assert.strictEqual(e.likely.therms, 0);
  ok('duct static pressure reset = fan kWh x affinity fraction x pass (hand value 5,218.6 kWh); coverage by units; override = same');
}
// 1b. (Matt 2026-11-23 8c5bfd4a) no estimate holes: unknown drive status counts in the likely and high cases; a known "none" is 0 with a reason; a Matrix without VAV rows is unknown input, never a zero
{
  const B = mkB();
  B.fanUnits.forEach((u) => (u.driveStatus = 'unknown'));
  const e = est('ahu_dsp_reset', 2, B);
  assert.strictEqual(e.low.kwh, 0, 'unknown drive: 0 in the low case');
  near(e.likely.kwh, 5218.6, 'unknown drive: counted in the likely case', 0.0002);
  assert.ok(e.high.kwh > e.likely.kwh, 'and in the high case');
  const N = mkB();
  N.fanUnits.forEach((u) => (u.driveStatus = 'none'));
  const z = est('ahu_dsp_reset', 2, N);
  assert.ok(z.likely.kwh === 0 && /no variable-speed drive/.test(z.reason), 'drive known to be none: 0 with the reason');
  // a Matrix with no terminal units is missing input, not proof of no VAV: the reset still has its estimate, the terminal item takes the stated box airflow
  const B2 = mkB();
  B2.counts.box = 0;
  near(est('ahu_dsp_reset', 2, B2).likely.kwh, 5218.6, 'no terminal units in the Matrix: the reset estimate is unchanged', 0.0002);
  // 5 terminal units x 1,000 cfm (default) x (0.35 - 0.15) x 0.40 = 400 cfm; 1.08 x 400 x 20 x 2,000 = 17.28e6 Btu / 82,000 = 210.73 therms
  near(est('terminalStandard', 5, B2).likely.therms, 210.73, 'terminal units from the item quantity at the default box airflow', 0.0003);
  assert.ok(!est('terminalStandard', 5, B2).reason, 'with no reason of zero');
  // no fan unit: the fan model default (national ventilation share, drive unknown) stands in
  const B5 = mkB();
  B5.fanUnits = sb.fanBuildingUnitModels('p', 'b', 100000);
  assert.strictEqual(B5.fanUnits.length, 1, 'one default fan unit');
  assert.strictEqual(B5.fanUnits[0].sizeBasis, 'national', 'sized by the national ventilation share');
  assert.strictEqual(B5.fanUnits[0].driveStatus, 'unknown');
  const e5 = est('ahu_dsp_reset', 2, B5);
  assert.ok(e5.likely.kwh > 0 && e5.low.kwh === 0 && !e5.reason, 'no fan unit: likely and high estimated, low 0 (drive unknown), no reason of zero');
  const B6 = mkB();
  B6.fanUnits = [];
  assert.strictEqual(est('ahu_dsp_reset', 2, B6), null, 'no fan unit and no electricity: unknown, not 0');
  const B3 = mkB();
  B3.fanUnits[0].reset = { pass: 1, level: 'trend' };
  B3.fanUnits[1].reset = { pass: 0, level: 'trend' };
  near(est('ahu_dsp_reset', 2, B3).likely.kwh, 18200 * 0.256012 * 1, 'a trend pass (flat setpoint = 1, moving = 0) replaces the default', 0.0002);
  const B4 = mkB();
  B4.fanCapKwh = 14560; // half of the 29,120 kWh of fans
  near(est('ahu_dsp_reset', 2, B4).likely.kwh, 5218.6 / 2, 'the fan cap scales the unit energy', 0.0002);
  near(est('ahu_dsp_reset', 2, B4).likely.baseByUse.fan, 14560, 'the base is the capped fan end use');
  ok('reset: unknown drive counts in likely and high; known none: 0 with a reason; no Matrix VAV rows: still estimated; no fan unit: the fan model default; a trend pass replaces the default; the fan cap applies');
}
// 2. supply air temperature reset
{
  const e = est('ahu_sat_reset', 2);
  near(e.likely.therms, 2581.46, 'reheat therms', 0.0002);
  near(e.likely.byUse.cool, 16278.3, 'cooling kWh', 0.0002);
  assert.strictEqual(e.likely.byUse.fan, undefined, 'no fan saving from a supply air temperature reset');
  near(est('satOverride', null).likely.therms, 2581.46, 'the override frees the same saving', 0.0002);
  near(est('ahu_sat_reset', 1).likely.therms, 2581.46 / 2, 'coverage 1 of 2 air handlers', 0.0002);
  const el = mkB();
  el.heatFuel = 'electric';
  el.base.heatEl = 200000;
  const ee = est('ahu_sat_reset', 2, el);
  near(ee.likely.byUse.heatEl, 211.68e6 / 3412.14, 'electric reheat: Btu / 3,412.14 kWh', 0.0002);
  assert.strictEqual(ee.likely.therms, 0);
  const nb = mkB();
  nb.bins = null;
  assert.strictEqual(est('ahu_sat_reset', 2, nb), null, 'no weather: no estimate');
  ok('supply air temperature reset: bin method (hand values 2,581.5 therms, 16,278.3 kWh); no fan saving; electric reheat in kWh');
}
// 3. economizer
{
  const e = est('ahu_economizer', 2);
  near(e.likely.byUse.cool, 55209.6, 'free cooling kWh', 0.0002);
  assert.ok(e.low.byUse.cool < e.likely.byUse.cool && e.likely.byUse.cool < e.high.byUse.cool, 'low < likely < high');
  const small = mkB();
  small.base.cool = 10000;
  near(est('ahu_economizer', 2, small).likely.byUse.cool, 10000, 'a measure never saves more than its end use', 0.0001);
  ok('economizer: free cooling bins from the balance point to the high limit (hand value 55,209.6 kWh); capped at the cooling base');
}
// 4. demand controlled ventilation
{
  const e = est('demandCtrl', 2);
  near(e.likely.therms, 1743.2, 'heating therms', 0.0003);
  near(e.likely.byUse.cool, 1994.8, 'cooling kWh', 0.0003);
  const nd = mkB();
  nd.degreeHours = null;
  assert.strictEqual(est('demandCtrl', 2, nd), null, 'no weather: no estimate');
  ok('air handler CO2: dcvEnergySaved at 0.1 cfm per ft2 (hand values 1,743.2 therms, 1,994.8 kWh)');
}
// 5. terminal minimum airflow
{
  const e = est('terminalStandard', 10);
  near(e.likely.therms, 842.93, 'reheat therms', 0.0003);
  near(e.likely.byUse.fan, 126.4, 'fan kWh', 0.0003);
  near(est('terminalStandard', 20).likely.therms, 842.93 * 2, 'all 20 boxes', 0.0003);
  assert.ok(e.likely.steps.some((s) => /Cooling energy/.test(s.name) && s.value === 0), 'cooling is stated as 0 with the reason');
  ok('terminal minimum airflow: reheat and fan by the affinity law (hand values 842.9 therms, 126.4 kWh)');
}
// 6. pumps
{
  const hw = est('hwp_pump_dp_reset', 1);
  near(hw.likely.byUse.pumpHw, 883.4, 'hot water pump kWh', 0.0003);
  near(est('hwDpOverride', null).likely.byUse.pumpHw, 883.4, 'the override frees the same saving', 0.0003);
  near(est('chwp_pump_dp_reset', 1).likely.byUse.pumpChw, 1104.2, 'chilled water pump kWh', 0.0003);
  assert.ok(hw.likely.baseByUse.pumpHw > hw.likely.byUse.pumpHw, 'the base is the pump energy before the reset');
  ok('pump pressure reset: pumpVfdEnergySaved at speed sqrt(1 - cut) (hand values 883.4 and 1,104.2 kWh)');
}
// 7. lighting, hot water reset
{
  near(est('lightingPhotocell', 2).likely.byUse.lightExt, 1200, 'photocell kWh');
  near(est('lightingOccupancy', 2).likely.byUse.lightInt, 287, 'occupancy sensors kWh (template rounds to 1 kWh)', 0.01);
  const hwr = est('hwOverride', null);
  assert.strictEqual(hwr.none, true);
  assert.ok(/boiler/.test(hwr.reason), 'no formula: the reason names the missing boiler data');
  assert.strictEqual(est('powerMeter', 1), null, 'a key with no owner has no estimate');
  assert.strictEqual(run("msClaims('powerMeter')"), false);
  assert.strictEqual(run("msReleases('spOverride')"), 'ahu_dsp_reset');
  ok('photocell and occupancy sensors (hand values 1,200 and 287 kWh); hot water reset has no formula and says why; keys without an owner claim nothing');
}
// 8. the weather reader and the one-source rules
{
  const w = { bins: [32.5, 62.5], cities: { 4: { temp: Array.from({ length: 12 }, (_, m) => [Array.from({ length: 24 }, (_, h) => (m === 0 && h >= 8 && h < 18 ? 2 : 0)), Array.from({ length: 24 }, (_, h) => (h === 3 ? 5 : 0))]) } } };
  sb._w = w;
  const bins = JSON.parse(JSON.stringify(run('msOccupiedBins(_w, 4, 8, 18)')));
  assert.deepStrictEqual(bins, [{ t: 32.5, hours: 20 }], 'hours inside the window only; empty bins left out');
  assert.strictEqual(run('msOccupiedBins(_w, 9, 8, 18)'), null, 'an unknown city has no bins');
  const src = read('computations/measure-savings.js') + read('app/pricing-estimator.js');
  assert.ok(!/PRICING_OPTION_SAVINGS_ESTIMATE\.fractions|\.endUse\.cool|photocellKwh/.test(src), 'no judged share saved table is left');
  const code = read('computations/measure-savings.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'[^'\n]*'/g, "''");
  assert.ok(!/0\.746|3960|fanPowerFraction\(|Math\.pow/.test(code), 'no second copy of the pump or fan affinity formula');
  ok('weather reader: hours in the window only; no judged share table; no second affinity formula');
}
// 9. the ECM templates still give the old numbers (the shared functions were extracted, not changed)
{
  const r = JSON.parse(JSON.stringify(run("ECM_TEMPLATES.pump_vfd.calculate({ gpm: 200, head_ft: 60, pump_eff: 72, motor_eff: 91, avg_speed_ratio: 0.7, op_hours: 1800 })")));
  // BHP = 200 x 60 / (3960 x 0.72) = 4.20875; kW = 4.20875 x 0.746 / 0.91 = 3.45029; kWh = 6,210.4; new = x 0.343 = 2,130.1; saved 4,080.3
  assert.deepStrictEqual(r, { bhp_design: 4.21, kw_design: 3.45, kwh_existing: 6210, kwh_new: 2130, savings_kwh: 4080 });
  const v = JSON.parse(JSON.stringify(run("ECM_TEMPLATES.vav_reheat.calculate({ system_cfm: 20000, pct_zones_heat: 40, avg_dt_reheat: 8, season_hours: 1000, reheat_type: 'gas', boiler_afue: 82, cooling_cop: 3.5, min_flow_old: 35, min_flow_new: 15, fan_kw_design: 15, unocc_hours: 2000 })")));
  // fan = 15 x (0.35^3 - 0.15^3) x 2,000 = 15 x 0.0395 x 2,000 = 1,185
  // 2026-11-27: the cooling part is msSatResetCooling (decision of the single source): average airflow 20,000 x 0.6 = 12,000 cfm; bin 57.5 F: supply air
  // 65 F after the reset, coil load saved 2.5 F; the other two bins save 0. 1.08 x 12,000 x 2.5 x 1,000 h / (3.5 x 3,412.14) = 2,713 kWh (was 4,341 with the typed 0.30 factor).
  assert.deepStrictEqual(v, { reheat_saved_qty: 843, cool_kwh_saved: 2713, fan_kwh_saved: 1185 }, 'reheat and fan as before; cooling = msSatResetCooling');
  ok('pump_vfd and vav_reheat templates: pump, reheat and fan as before; the cooling part is the shared supply air temperature reset function');
}
console.log(n + ' checks passed');
