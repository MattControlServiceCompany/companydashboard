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
vm.runInContext(fs.readFileSync(path.join(root, 'computations/rates.js'), 'utf8'), sb);
vm.runInContext(src, sb);
const T = sb.ECM_TEMPLATES;
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
// 3. Add as measure: kW per month = full kW reduction (matrix sums 12 months)
{ const d = defs('lighting_replacement'); const r = sb.calculateEcm('lighting_replacement', d);
  sb.ecmAddAsMeasure('p1', '', 'lighting_replacement', d, r);
  const m = measures[0]; const sum = (a) => a.reduce((x, y) => x + y, 0);
  const demand = sum(m.kw) * d.demand_rate; const calc = r.demand_savings_kw * d.demand_rate * 12;
  ok('measure demand $ equals calc demand $', Math.abs(demand - calc) < 0.5, demand.toFixed(0) + ' vs ' + calc.toFixed(0));
  ok('measure kWh sums to annual', Math.abs(sum(m.kwh) - r.total_savings_kwh) < 0.001, sum(m.kwh)); }
// 4. Rates: energy-only, 12-month window ending at newest bill
{ const r = sb.getProjectRates('p1');
  // newest bill Mar 2026; window Apr 2025..Mar 2026 -> all bills at 6000/100000 = 0.06
  ok('electric rate is energy-only 0.06', Math.abs(r.electric_rate - 0.06) < 1e-9, r.electric_rate);
  ok('demand rate = charge / kW = 8', Math.abs(r.demand_rate - 8) < 1e-9, r.demand_rate);
  ok('window counts 12 electric bills', r.billCount === 12, r.billCount); }
// 5. 0.3 VAV factor is labelled in plain words
{ const f = T.vav_reheat;
  const o = f.outputs.find((x) => x.id === 'cool_kwh_saved');
  ok('VAV 30% factor labelled as assumption', /assum/i.test(o.formula), o.formula); }
// 6. E-ECM-2 / E-ECM-4 assumption labels, behaviour unchanged
{ const a = T.oa_dampers.outputs.find((x) => x.id === 'excess_cfm'); ok('damper assumption label', a && /assum/i.test(a.formula + (a.label || '')), a && a.formula);
  const b = T.boiler_replacement.outputs.find((x) => x.id === 'existing_therms'); ok('boiler assumption label', b && /assum/i.test(b.formula + (b.label || '')), b && b.formula); }
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
