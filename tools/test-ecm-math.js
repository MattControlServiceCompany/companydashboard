// WP-17 acceptance test: ECM calculator math (synthetic data only).
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/ecm-calculators.js'), 'utf8')
  .replace(/\bconst\s+ECM_TEMPLATES\b/, 'var ECM_TEMPLATES')
  .replace(/\bconst\s+ECM_MEASURE_FIELD_MAP\b/, 'var ECM_MEASURE_FIELD_MAP');
const measures = [];
// Synthetic project: one building, one electric meter, one gas meter. Newest bill ends 2026-03-15.
const elecBills = [];
for (let m = 1; m <= 15; m++) {
  const d = new Date(2025, m - 1 + 0, 15); // Jan 2025 .. Mar 2026
  const iso = (x) => x.toISOString().slice(0, 10);
  const s = new Date(d.getFullYear(), d.getMonth(), 1);
  elecBills.push({ start: iso(new Date(s.getTime() + 43200000)), end: iso(new Date(d.getTime() + 43200000)),
    kwh: 100000, kwhCost: m <= 3 ? 9000 : 6000, kwCost: 2000, billedKW: 250, otherCost: 500, taxCost: 200 });
}
const sb = {
  console, window: {},
  document: { getElementById: () => ({}), createElement: () => ({ style: {} }), head: { appendChild() {} }, addEventListener() {}, readyState: 'complete', body: { appendChild() {} } },
  projects: [{ id: 'p1' }], getProjSavingsData: () => ({ measures }), getUDBldg: () => null, sset() {}, showToast() {}, _svRecalcFrom() {},
  getUDBldgs: () => [{ id: 'b1', meters: [{ commodity: 'Electric', bills: elecBills }] }],
  resolveGasUsageTherms: () => 0,
};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/formatting.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/rates.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/normalization.js'), 'utf8'), sb);
// Real functions, cut out of their files: the baseline-bill filter, the project baseline fallback, the matrix pricing.
const cut = (rel, startMark, endMark) => { const t = fs.readFileSync(path.join(root, rel), 'utf8'); const a = t.indexOf(startMark); return t.slice(a, t.indexOf(endMark, a)); };
vm.runInContext(cut('app/utility-data.js', 'function _fixISO', '// The ONE day-count function'), sb);
vm.runInContext(cut('app/core.js', 'function _dashGetBaselineBills', 'function initDashboardTab'), sb);
vm.runInContext(cut('app/utility-data.js', 'function _udProjBaselineMonthsFallback', '// Per-meter baseline totals'), sb);
vm.runInContext('const SUMMER_MOS = [5, 6, 7, 8];' + cut('app/energy-savings.js', 'const RATE_WRITE_FIELDS', 'function getProjMatrixSavingsTotal'), sb);
vm.runInContext(src, sb);
const T = sb.ECM_TEMPLATES;
// Rate inputs have no default (blank until Utility Data fills them); the test supplies a manual value.
const defs = (id) => { const o = {}; T[id].inputs.forEach((i) => (o[i.id] = i.default)); if (o.elec_rate === null) o.elec_rate = 0.085; if (o.btm_rate === null) o.btm_rate = 0.085; return o; };
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  [' + info + ']' : '')); if (!cond) fail++; };

// 1. ERW: efficiency 0 -> zero savings
{ const d = defs('oa_erw'); d.erw_winter_eff = 0; d.erw_summer_eff = 0; const r = T.oa_erw.calculate(d);
  ok('ERW eff 0 -> heating savings 0', r.heating_savings_therms === 0, r.heating_savings_therms);
  ok('ERW eff 0 -> cooling savings 0', r.cooling_savings_kwh === 0, r.cooling_savings_kwh); }
// 2. ERW: cooling kWh = Btu/(EER*1000) with recovered fraction; better wheel saves more
{ const d = defs('oa_erw'); d.erw_derate = 0; d.erw_summer_eff = 70; d.erw_winter_eff = 70;
  const dh = Math.max(0, d.summer_oa_enthalpy - d.target_enthalpy);
  const exp = Math.round((4.5 * d.oa_cfm * dh * 0.7 * d.cooling_hours) / (d.eer * 1000));
  const r = T.oa_erw.calculate(d);
  ok('ERW cooling kWh = recovered Btu/(EER*1000)', r.cooling_savings_kwh === exp, r.cooling_savings_kwh + ' vs ' + exp);
  const dt = Math.max(0, d.heating_setpoint - d.design_winter_temp);
  const expT = Math.round((1.08 * d.oa_cfm * dt * 0.7 * d.heating_hours) / (100000 * d.afue));
  ok('ERW heating therms = recovered fraction', r.heating_savings_therms === expT, r.heating_savings_therms + ' vs ' + expT);
  d.erw_winter_eff = 80; ok('better wheel saves more', T.oa_erw.calculate(d).heating_savings_therms > r.heating_savings_therms); }
// 3. Add as measure: kW per month = full kW reduction (matrix sums 12 months)
{ const d = defs('lighting_replacement'); const r = sb.calculateEcm('lighting_replacement', d);
  sb.ecmAddAsMeasure('p1', '', 'lighting_replacement', d, r);
  const m = measures[0]; const sum = (a) => a.reduce((x, y) => x + y, 0);
  const demand = sum(m.kw) * d.demand_rate; const calc = r.demand_savings_kw * d.demand_rate * 12;
  ok('measure demand $ equals calc demand $', Math.abs(demand - calc) < 0.5, demand.toFixed(0) + ' vs ' + calc.toFixed(0));
  ok('measure kWh sums to annual', Math.abs(sum(m.kwh) - r.total_savings_kwh) < 0.001, sum(m.kwh)); }
// 4. Rate autofill: the ONE rate function (computeSeasonalBldgRates) supplies the single kWh/kW rate
{ const baselineMeter = { commodity: 'Electric', bills: elecBills, baseline: { months: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'] } };
  sb.getUDBldgs = () => [{ id: 'b1', meters: [baselineMeter] }];
  sb.getUDBldg = () => ({ id: 'b1', meters: [baselineMeter] });
  const r = sb.computeSeasonalBldgRates('p1', 'b1');
  ok('building kWh rate from the one rate function > 0', r.kwhRate > 0 && r.kwhRate < 0.2, r.kwhRate);
  ok('kwhRate lies between seasonal rates', r.kwhRate >= Math.min(r.kwhSummer, r.kwhWinter) - 1e-9 && r.kwhRate <= Math.max(r.kwhSummer, r.kwhWinter) + 1e-9, r.kwhRate);
  ok('getProjectRates copy is gone', typeof sb.getProjectRates === 'undefined');
  ok('elec rate inputs have no invented default', T.lighting_replacement.inputs.find((i) => i.id === 'elec_rate').default === null); }
// 4b. Baseline period only: a 2026 bill outside the baseline months does not move the rate
{ const meter = sb.getUDBldg().meters[0]; const before = sb.computeSeasonalBldgRates('p1', 'b1');
  const extra = elecBills.slice(); extra.push({ start: '2026-04-01', end: '2026-04-30', kwh: 100000, kwhCost: 90000, kwCost: 2000, billedKW: 250, otherCost: 500, taxCost: 200 });
  meter.bills = extra; const after = sb.computeSeasonalBldgRates('p1', 'b1'); meter.bills = elecBills;
  ok('bill outside the baseline months does not change the rates', after.kwhWinter === before.kwhWinter && after.kwhRate === before.kwhRate, before.kwhWinter + ' vs ' + after.kwhWinter);
  ok('summer and winter kWh rates differ (Jan-Mar bills cost more)', before.kwhWinter > before.kwhSummer, before.kwhWinter + ' / ' + before.kwhSummer);
  const keep = meter.baseline; meter.baseline = { months: [] };
  ok('no baseline anywhere -> rate 0, not all-history', sb.computeSeasonalBldgRates('p1', 'b1').kwhRate === 0);
  meter.baseline = keep; }
// 4c. ecmPrice: seasonal rate on an even 12-month profile equals the matrix sum; typed rate stays flat
{ const r = sb.computeSeasonalBldgRates('p1', 'b1'); const q = 120000;
  const exp = sb.calcMeasureDollars({ kwh: Array(12).fill(q / 12) }, r).total;
  ok('ecmPrice seasonal == calcMeasureDollars monthly sum', Math.abs(sb.ecmPrice({ __seasonal: { elec_rate: r }, elec_rate: 0.5 }, 'elec', q) - exp) < 1e-6, exp.toFixed(2));
  ok('ecmPrice typed rate is flat', sb.ecmPrice({ __seasonal: null, elec_rate: 0.5 }, 'elec', q) === q * 0.5);
  ok('ecmPrice demand typed = kW x rate x 12', sb.ecmPrice({ demand_rate: 10 }, 'demand', 5) === 600); }
// 5. 0.3 VAV factor is labelled in plain words
{ const f = T.vav_reheat;
  const o = f.outputs.find((x) => x.id === 'cool_kwh_saved');
  ok('VAV 30% factor labelled as assumption', /assum/i.test(o.assumption || ''), o.assumption); }
// 6. E-ECM-2 / E-ECM-4 assumption labels, behaviour unchanged
{ const a = T.oa_dampers.outputs.find((x) => x.id === 'excess_cfm'); ok('damper assumption label', a && /assum/i.test((a && a.assumption) || ''), a && a.assumption);
  const b = T.boiler_replacement.outputs.find((x) => x.id === 'existing_therms'); ok('boiler assumption label', b && /assum/i.test((b && b.assumption) || ''), b && b.assumption); }
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
