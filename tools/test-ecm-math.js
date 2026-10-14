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
// Monthly profiles (Jan..Dec) of the synthetic estimate: cooling peaks in July, lighting/other is nearly flat.
const COOL = [0, 0, 1000, 3000, 8000, 15000, 22000, 20000, 12000, 4000, 1000, 0];
const OTHER = [9000, 9000, 9000, 8500, 8000, 6000, 5500, 5500, 8000, 9000, 9000, 9000];
const GAS = [9000, 7000, 4000, 1500, 400, 0, 0, 0, 300, 2000, 5000, 8000];
const sumArr = (a) => a.reduce((x, y) => x + y, 0);
const SYN_BASIS = { hvacKwh: 'measured', coolKwh: 'measured', heatKwh: 'measured', hvacGas: 'measured', nonHvacKwh: 'measured', hvacKw: 'rule', nonHvacKw: 'rule' };
const SYN_EST = {
  basis: SYN_BASIS, dataSource: 'bills', dataSourceLabel: 'From 12 months of baseline bills', monthly: true,
  coolKwhTotal: sumArr(COOL), monthlyCoolKwh: COOL, heatKwhTotal: 0, monthlyHeatKwh: Array(12).fill(0),
  hvacKwh: sumArr(COOL), monthlyHvacKwh: COOL, nonHvacKwh: sumArr(OTHER), monthlyNonHvacKwh: OTHER,
  hvacGasT: sumArr(GAS), monthlyHvacGas: GAS, hvacKw: 300, monthlyHvacKw: COOL.map((v) => v / 100), nonHvacKw: 100, monthlyNonHvacKw: OTHER.map((v) => v / 100),
};
const sb = {
  console, window: {},
  document: { getElementById: () => ({}), createElement: () => ({ style: {} }), head: { appendChild() {} }, addEventListener() {}, readyState: 'complete', body: { appendChild() {} } },
  projects: [{ id: 'p1' }], getProjSavingsData: () => ({ measures }), getUDBldg: (p, b) => (b === 'b1' ? { id: 'b1', name: 'Synthetic Building', sqft: 1000 } : null), sset() {}, showToast() {}, _svRecalcFrom() {},
  // Synthetic stored HVAC Load Estimate of building b1 (the owner of the end-use split), saved by a person.
  hvacEstimateForBuilding: (p, b) => (b === 'b1' ? { est: SYN_EST, resolved: { source: 'bills', label: 'From 12 months of baseline bills' }, estimate: 'saved', savedAt: 1790000000000, method: 'thumb' } : null),
  resolveHvacLoadData: () => ({ source: 'none', label: 'No utility data yet' }),
  getUDBldgs: () => [{ id: 'b1', meters: [{ commodity: 'Electric', provider: sb.SEASON_UTILITY, bills: elecBills }] }],
  resolveGasUsageTherms: () => 0,
};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/date-helpers.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/formatting.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/physics.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/fan-savings.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/cost-lines.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/rates.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/normalization.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/savings.js'), 'utf8'), sb);
require('./bill-flags-sandbox.js').addBillFlagEngine(sb); // computeSeasonalBldgRates asks the flag engine which bills to leave out
// Real functions, cut out of their files: the baseline-bill filter, the project baseline fallback, the matrix pricing.
const cut = (rel, startMark, endMark) => { const t = fs.readFileSync(path.join(root, rel), 'utf8'); const a = t.indexOf(startMark); return t.slice(a, t.indexOf(endMark, a)); };
vm.runInContext(cut('app/utility-data.js', 'function _fixISO', '// The ONE day-count function'), sb);
vm.runInContext(cut('app/core.js', 'function _dashGetBaselineBills', 'function initDashboardTab'), sb);
vm.runInContext(cut('app/utility-data.js', 'function _udProjBaselineMonthsFallback', '// Per-meter baseline totals'), sb);
vm.runInContext(cut('app/energy-savings.js', 'const RATE_WRITE_FIELDS', 'function getProjMatrixSavingsTotal'), sb);
vm.runInContext(cut('app/calculators.js', 'function hvlBasisLabel', '// One line under'), sb);
vm.runInContext(cut('app/calculators.js', 'function solarMonthlyProduction', 'function solarAddAsMeasure'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'computations/end-use.js'), 'utf8'), sb);
vm.runInContext(src, sb);
const T = sb.ECM_TEMPLATES;
// Rate inputs have no default (blank until Utility Data fills them); the test supplies a manual value.
const defs = (id) => { const o = {}; T[id].inputs.forEach((i) => (o[i.id] = i.default)); return o; };
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
// 3. Add as measure: MONTHLY quantities shaped by the end use's profile from the load estimate (not annual / 12)
{ const d = defs('lighting_replacement'); const r = sb.calculateEcm('lighting_replacement', d);
  ok('no building -> measure is not added', sb.ecmAddAsMeasure('p1', '', 'lighting_replacement', d, r) === false && measures.length === 0);
  ok('lighting add as measure succeeds with a building', sb.ecmAddAsMeasure('p1', 'b1', 'lighting_replacement', d, r) === true);
  const m = measures[0]; const sum = sumArr;
  ok('measure kWh sums to the yearly quantity', Math.abs(sum(m.kwh) - r.total_savings_kwh) < 0.001, sum(m.kwh));
  const w = OTHER.map((v) => v / sumArr(OTHER));
  ok('measure kWh follows the non-HVAC electric profile, month by month', m.kwh.every((v, i) => Math.abs(v - r.total_savings_kwh * w[i]) < 1e-6));
  ok('measure kWh is not annual / 12', Math.abs(m.kwh[0] - r.total_savings_kwh / 12) > 1 && Math.abs(m.kwh[5] - r.total_savings_kwh / 12) > 1);
  ok('kW reduction is the full reduction in the peak month, lower in the others', Math.abs(Math.max(...m.kw) - r.demand_savings_kw) < 1e-9 && Math.min(...m.kw) < r.demand_savings_kw);
  ok('measure carries no dollars of its own before the matrix prices it', m.totalDollar === 0 && m.rateSource === 'owner');
  measures.length = 0; }
// 3b. A cooling template is shaped by the cooling profile (zero in the months the estimate has no cooling)
{ const d = defs('chiller_replacement'); const r = sb.calculateEcm('chiller_replacement', d);
  const built = sb.ecmBuildMeasure('p1', 'b1', 'chiller_replacement', d, r);
  ok('chiller build ok', built.ok === true, built.reason);
  const m = built.measure; const w = COOL.map((v) => v / sumArr(COOL));
  ok('chiller kWh follows the cooling profile', m.kwh.every((v, i) => Math.abs(v - r.savings_kwh * w[i]) < 1e-6));
  ok('chiller kWh is 0 in January', m.kwh[0] === 0);
  ok('chiller kW is 0 in January and full in July', m.kw[0] === 0 && Math.abs(m.kw[6] - r.peak_kw_savings) < 1e-9); }
// 3c. Gas-or-electric choice picks the end use; a template with no month-by-month source is refused
{ const d = defs('vav_reheat'); d.reheat_type = 'gas'; const r = sb.calculateEcm('vav_reheat', d);
  const g = sb.ecmBuildMeasure('p1', 'b1', 'vav_reheat', d, r);
  ok('VAV gas reheat lands in the gas column on the gas-heating profile', g.ok && sumArr(g.measure.gas) > 0 && g.measure.gas[5] === 0 && g.measure.gas[0] > g.measure.gas[3]);
  d.reheat_type = 'electric'; const re = sb.calculateEcm('vav_reheat', d);
  const e = sb.ecmBuildMeasure('p1', 'b1', 'vav_reheat', d, re);
  ok('VAV electric reheat lands in the kWh column (heating profile when the estimate has no electric heating)', e.ok && sumArr(e.measure.gas) === 0);
  // Solar Production takes its months from the Solar calculator (one owner: solarMonthlyProduction)
  const sd = defs('solar_production'); const sr = sb.calculateEcm('solar_production', sd);
  const s0 = sb.ecmBuildMeasure('p1', 'b1', 'solar_production', sd, sr);
  ok('solar production with no Solar calculator months is refused with a plain reason', s0.ok === false && /Solar calculator/.test(s0.reason), s0.reason);
  const SOL = [8995, 9972, 12436, 13663, 17115, 17595, 17494, 16258, 14113, 12341, 9096, 7063];
  sb.projects[0].solarCalc = { production: SOL };
  const s1 = sb.ecmBuildMeasure('p1', 'b1', 'solar_production', sd, sr);
  const sw = SOL.map((v) => v / sumArr(SOL));
  ok('solar production builds a measure from the Solar calculator months', s1.ok === true, s1.reason);
  ok('solar measure kWh follows the Solar calculator monthly production and sums to year 1', s1.measure.kwh.every((v, i) => Math.abs(v - sr.year1_kwh * sw[i]) < 1e-6) && Math.abs(sumArr(s1.measure.kwh) - sr.year1_kwh) < 1e-6);
  sb.projects[0].solarArrays = [{ production: SOL.map((v) => v * 2) }, { production: SOL.map(() => 0) }];
  sb.projects[0].solarCalc = { production: SOL.map(() => 1) };
  ok('with arrays the Solar calculator production is the sum of the arrays (one owner)', sb.solarMonthlyProduction(sb.projects[0]).every((v, i) => v === SOL[i] * 2));
  delete sb.projects[0].solarArrays; delete sb.projects[0].solarCalc; }
// 4. Rate autofill: the ONE rate function (computeSeasonalBldgRates) supplies the single kWh/kW rate
{ const baselineMeter = { commodity: 'Electric', provider: sb.SEASON_UTILITY, bills: elecBills, baseline: { months: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'] } };
  sb.getUDBldgs = () => [{ id: 'b1', meters: [baselineMeter] }];
  sb.getUDBldg = () => ({ id: 'b1', meters: [baselineMeter] });
  const r = sb.computeSeasonalBldgRates('p1', 'b1');
  ok('building kWh rate from the one rate function > 0', r.kwhRate > 0 && r.kwhRate < 0.2, r.kwhRate);
  ok('kwhRate lies between seasonal rates', r.kwhRate >= Math.min(r.kwhSummer, r.kwhWinter) - 1e-9 && r.kwhRate <= Math.max(r.kwhSummer, r.kwhWinter) + 1e-9, r.kwhRate);
  ok('getProjectRates copy is gone', typeof sb.getProjectRates === 'undefined');
  ok('no template has a rate or cost input', Object.values(T).every((t) => (t.inputs || []).every((i) => !/_(rate|cost)$/.test(i.id)))); }
// 4b. Baseline period only: a 2026 bill outside the baseline months does not move the rate
{ const meter = sb.getUDBldg().meters[0]; const before = sb.computeSeasonalBldgRates('p1', 'b1');
  const extra = elecBills.slice(); extra.push({ start: '2026-04-01', end: '2026-04-30', kwh: 100000, kwhCost: 90000, kwCost: 2000, billedKW: 250, otherCost: 500, taxCost: 200 });
  meter.bills = extra; const after = sb.computeSeasonalBldgRates('p1', 'b1'); meter.bills = elecBills;
  ok('bill outside the baseline months does not change the rates', after.kwhWinter === before.kwhWinter && after.kwhRate === before.kwhRate, before.kwhWinter + ' vs ' + after.kwhWinter);
  ok('summer and winter kWh rates differ (Jan-Mar bills cost more)', before.kwhWinter > before.kwhSummer, before.kwhWinter + ' / ' + before.kwhSummer);
  const keep = meter.baseline; meter.baseline = { months: [] };
  ok('no baseline anywhere -> rate 0, not all-history', sb.computeSeasonalBldgRates('p1', 'b1').kwhRate === 0);
  meter.baseline = keep; }
// 4c. The dollars of a template are the matrix pricing of its monthly measure (calcMeasureDollars + measureRatesNow)
{ const d = defs('chiller_replacement'); const r = sb.calculateEcm('chiller_replacement', d);
  const built = sb.ecmBuildMeasure('p1', 'b1', 'chiller_replacement', d, r);
  const dollars = sb.ecmMeasureDollars('p1', built.measure);
  const rates = sb.computeSeasonalBldgRates('p1', 'b1');
  const hand = sb.calcMeasureDollars(built.measure, rates).total;
  ok('template dollars == calcMeasureDollars of the monthly measure at the baseline rates', dollars > 0 && Math.abs(dollars - hand) < 1e-6, dollars.toFixed(2));
  ok('results hold no dollar or payback field', !Object.keys(r).some((k) => /dollar|payback/.test(k)), Object.keys(r).join(','));
  const flat = { kwh: Array(12).fill(r.savings_kwh / 12), kw: Array(12).fill(r.peak_kw_savings), gas: [] };
  ok('shaped dollars differ from the old flat annual / 12 spread', Math.abs(sb.calcMeasureDollars(flat, rates).total - dollars) > 1, sb.calcMeasureDollars(flat, rates).total.toFixed(2)); }
// 5. 0.3 VAV factor is labelled in plain words
{ const f = T.vav_reheat;
  const o = f.outputs.find((x) => x.id === 'cool_kwh_saved');
  ok('VAV 30% factor labelled as assumption', /assum/i.test(o.assumption || ''), o.assumption); }
// 6. E-ECM-2 / E-ECM-4 assumption labels, behaviour unchanged
{ const a = T.oa_dampers.outputs.find((x) => x.id === 'excess_cfm'); ok('damper assumption label', a && /assum/i.test((a && a.assumption) || ''), a && a.assumption);
  const b = T.boiler_replacement.outputs.find((x) => x.id === 'existing_therms'); ok('boiler assumption label', b && /assum/i.test((b && b.assumption) || ''), b && b.assumption); }
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
