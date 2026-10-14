// tools/test-end-use.js - SYNTHETIC-fixture test of getEndUse (computations/end-use.js) and of how the calc templates
// use it (Phase 5, 2026-10-14). No real client data. Runs in the regression gate by glob.
//   1. getEndUse: stored estimate (saved / calculated), estimate calculated now, annual-only data, no data,
//      end uses not modeled yet.
//   2. getEndUseWeights / spread*: months add up, fall-through to the next end use, annual-only has no profile.
//   3. Every template input marked endUse and every ECM_MEASURE_FIELD_MAP entry points at a real end use / output.
//   4. The gate (tools/gate-ecm-templates-no-dollars.js) passes on the tree and FAILS on a copy that brings back
//      a dollar, a payback, a divide by 12, a second end-use reader or the saved-versus-measured fork.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const gate = require('./gate-ecm-templates-no-dollars.js');

let passed = 0;
let failed = 0;
function ok(cond, msg, info) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL ' + msg + (info !== undefined ? '  [' + info + ']' : ''));
  }
}
const near = (a, b, t) => Math.abs(a - b) <= (t === undefined ? 1e-6 : t);
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---- synthetic estimate (what computeHvacLoadEstimate returns) ----
const COOL = [0, 0, 1000, 3000, 8000, 15000, 22000, 20000, 12000, 4000, 1000, 0];
const OTHER = [9000, 9000, 9000, 8500, 8000, 6000, 5500, 5500, 8000, 9000, 9000, 9000];
const GAS = [9000, 7000, 4000, 1500, 400, 0, 0, 0, 300, 2000, 5000, 8000];
const estMonthly = () => ({
  method: 'thumb',
  dataSource: 'bills',
  dataSourceLabel: 'From 12 months of baseline bills',
  monthly: true,
  coolKwhTotal: sum(COOL),
  monthlyCoolKwh: COOL,
  heatKwhTotal: 0,
  monthlyHeatKwh: Array(12).fill(0),
  hvacKwh: sum(COOL),
  monthlyHvacKwh: COOL,
  nonHvacKwh: sum(OTHER),
  monthlyNonHvacKwh: OTHER,
  hvacGasT: sum(GAS),
  monthlyHvacGas: GAS,
  hvacKw: 300,
  monthlyHvacKw: COOL.map((v) => v / 100),
  nonHvacKw: 100,
  monthlyNonHvacKw: OTHER.map((v) => v / 100),
});
const estAnnual = () => ({
  method: 'thumb',
  dataSource: 'annual',
  dataSourceLabel: 'From annual totals you entered (2025)',
  monthly: false,
  coolKwhTotal: 90000,
  monthlyCoolKwh: null,
  heatKwhTotal: 0,
  monthlyHeatKwh: null,
  hvacKwh: 90000,
  monthlyHvacKwh: null,
  nonHvacKwh: 110000,
  monthlyNonHvacKwh: null,
  hvacGasT: 12000,
  monthlyHvacGas: null,
  hvacKw: 80,
  monthlyHvacKw: null,
  nonHvacKw: 60,
  monthlyNonHvacKw: null,
});

const BASIS = { hvacKwh: 'measured', coolKwh: 'measured', heatKwh: 'measured', hvacGas: 'measured', nonHvacKwh: 'measured', hvacKw: 'rule', nonHvacKw: 'rule' };
const calcOf = (est, source, label, over) =>
  Object.assign(
    { est, resolved: { source, label }, estimate: 'default', savedAt: null, method: 'thumb' },
    over || {},
  );

function makeSandbox(world) {
  const sb = {
    console,
    getUDBldg: (p, b) => (world.bldgs && world.bldgs[b]) || null,
    hvacEstimateForBuilding: (p, b) => (world.calc && world.calc[b]) || null,
    resolveHvacLoadData: (p, b) => world.resolved[b.id],
  };
  vm.createContext(sb);
  const calcSrc = fs.readFileSync(path.join(root, 'app/calculators.js'), 'utf8');
  const a = calcSrc.indexOf('function hvlBasisLabel');
  vm.runInContext(calcSrc.slice(a, calcSrc.indexOf('// One line under', a)), sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'computations/end-use.js'), 'utf8'), sb);
  return sb;
}

const bldgs = {
  b1: { id: 'b1', name: 'Building One', sqft: '40000' },
  b2: { id: 'b2', name: 'Building Two' },
  b3: { id: 'b3', name: 'No Data' },
};

// ---------------- 1. getEndUse ----------------
console.log('--- 1. getEndUse ---');
{
  const withBasis = (e) => Object.assign(e, { basis: BASIS });
  const sb = makeSandbox({
    bldgs,
    calc: {
      b1: calcOf(withBasis(estMonthly()), 'bills', 'From 12 months of baseline bills', {
        estimate: 'saved',
        savedAt: 1790000000000,
      }),
      b2: calcOf(withBasis(estMonthly()), 'bills', 'From 12 months of baseline bills'),
    },
    resolved: { b3: { source: 'none', label: 'No utility data yet' } },
  });
  const cool = sb.getEndUse('p', 'b1', 'cooling');
  ok(
    cool.modeled && cool.unit === 'kWh' && cool.source === 'bills' && cool.estimate === 'saved',
    'saved inputs: modeled kWh from bills',
    JSON.stringify(cool).slice(0, 120),
  );
  ok(cool.basis === 'measured', 'the end use says which method produced it: measured');
  ok(
    near(cool.annual, sum(COOL)) && near(sum(cool.monthly), cool.annual),
    'annual = sum of the 12 monthly values',
  );
  ok(
    /HVAC Load Estimate \(saved .*\), Measured from your bills .*, From 12 months of baseline bills/.test(
      cool.sourceLabel,
    ),
    'source label names the estimate, its save state, the method and the data',
    cool.sourceLabel,
  );
  ok(
    near(cool.kw.annual, 300) && near(cool.kw.peak, 220) && cool.kw.monthly.length === 12,
    'cooling kW: annual and peak month from the HVAC kW series',
  );
  const gas = sb.getEndUse('p', 'b1', 'heatingGas');
  ok(gas.unit === 'Therms' && near(gas.annual, sum(GAS)) && gas.kw === null, 'heating gas: Therms, no kW');
  const he = sb.getEndUse('p', 'b1', 'heatingElectric');
  ok(he.annual === 0 && sum(he.monthly) === 0, 'electric heating: a real 0 when the building has none');
  const nh = sb.getEndUse('p', 'b1', 'nonHvacElectric');
  ok(near(nh.annual, sum(OTHER)) && near(nh.kw.annual, 100), 'non-HVAC electric: lighting, plug and other together');

  const fresh = sb.getEndUse('p', 'b2', 'cooling');
  ok(
    fresh.estimate === 'default' && fresh.source === 'bills' && near(fresh.annual, sum(COOL)),
    'nobody saved anything: calculated now from the building data',
  );
  ok(
    /HVAC Load Estimate \(not saved yet\), Measured from your bills .*, From 12 months of baseline bills/.test(
      fresh.sourceLabel,
    ),
    'not-saved label',
    fresh.sourceLabel,
  );

  const rule = makeSandbox({
    bldgs,
    calc: { b1: calcOf(Object.assign(estMonthly(), { basis: Object.assign({}, BASIS, { coolKwh: 'rule' }) }), 'bills', 'x') },
    resolved: {},
  });
  const rc = rule.getEndUse('p', 'b1', 'cooling');
  ok(rc.basis === 'rule' && /Rule of thumb/.test(rc.sourceLabel), 'a rule-of-thumb number is labelled as one', rc.sourceLabel);

  const none = sb.getEndUse('p', 'b3', 'cooling');
  ok(
    none.source === 'none' &&
      none.annual === null &&
      none.monthly === null &&
      none.sourceLabel === 'No utility data yet',
    'no data: source none, no numbers',
    JSON.stringify(none),
  );
  const nobldg = sb.getEndUse('p', 'zzz', 'cooling');
  ok(nobldg.source === 'none' && nobldg.annual === null, 'unknown building: nothing');
  const nob = sb.getEndUse('p', null, 'cooling');
  ok(nob.source === 'none', 'no building chosen: nothing');

  ['lighting', 'plug'].forEach((k) => {
    const r = sb.getEndUse('p', 'b1', k);
    ok(
      r.modeled === false && r.source === 'none' && r.annual === null && /Not modeled yet/.test(r.sourceLabel),
      k + ': not modeled yet',
    );
  });
  ok(sb.getEndUse('p', 'b1', 'nonsense').modeled === false, 'unknown end use is not modeled');
}

// annual-only data
{
  const sb = makeSandbox({
    bldgs,
    calc: {
      b1: calcOf(
        Object.assign(estAnnual(), { basis: { hvacKwh: 'rule', coolKwh: 'rule', hvacGas: 'rule', hvacKw: 'rule' } }),
        'annual',
        'From annual totals you entered (2025)',
      ),
    },
    resolved: {},
  });
  const c = sb.getEndUse('p', 'b1', 'cooling');
  ok(
    c.source === 'annual' && c.annual === 90000 && c.monthly === null && c.basis === 'rule',
    'annual entry: annual value, rule of thumb, NO monthly values made up',
    JSON.stringify(c).slice(0, 140),
  );
  ok(c.kw.monthly === null && near(c.kw.annual, 80), 'annual entry: kW annual only');
  const w = sb.getEndUseWeights('p', 'b1', ['cooling']);
  ok(
    w.ok === false && /annual totals only/.test(w.reason),
    'annual entry: no monthly profile, so no weights',
    w.reason,
  );
}

// ---------------- 2. weights and spreads ----------------
console.log('--- 2. weights and spreads ---');
{
  const sb = makeSandbox({
    bldgs,
    calc: { b1: calcOf(Object.assign(estMonthly(), { basis: BASIS }), 'bills', 'x') },
    resolved: {},
  });
  const w = sb.getEndUseWeights('p', 'b1', ['cooling']);
  ok(w.ok && near(sum(w.weights), 1) && w.endUse === 'cooling', 'weights add up to 1');
  ok(near(w.weights[6], COOL[6] / sum(COOL)) && w.weights[0] === 0, 'weights follow the monthly profile');
  const q = 120000;
  const e = sb.spreadEnergyByWeights(w.weights, q);
  ok(
    near(sum(e), q) && e[6] > e[2] && Math.abs(e[0] - q / 12) > 1,
    'energy is shaped (July > March, January is not annual / 12) and adds up to the yearly quantity',
  );
  const d = sb.spreadDemandByWeights(w.weights, 50);
  ok(
    near(Math.max(...d), 50) && d[6] === 50 && d[0] === 0,
    'kW reduction: full in the peak month, 0 where the end use is 0',
  );
  const f = sb.getEndUseWeights('p', 'b1', ['heatingElectric', 'heatingGas']);
  ok(f.ok && f.endUse === 'heatingGas', 'a zero end use (no electric heating) falls through to the next end use');
  const g = sb.getEndUseWeights('p', 'b1', ['heatingElectric']);
  ok(
    g.ok === false && /none for this building/.test(g.reason),
    'only a zero end use: no weights, plain reason',
    g.reason,
  );
  const n = sb.getEndUseWeights('p', 'b1', ['lighting']);
  ok(n.ok === false && /Not modeled yet/.test(n.reason), 'not-modeled end use: no weights, plain reason', n.reason);
}

// ---------------- 3. templates <-> end uses ----------------
console.log('--- 3. template inputs and measure map ---');
{
  const ecmSrc = fs
    .readFileSync(path.join(root, 'app/ecm-calculators.js'), 'utf8')
    .replace(/\bconst\s+(ECM_TEMPLATES|ECM_MEASURE_FIELD_MAP)\b/g, 'var $1');
  const sb = {
    console,
    document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'computations/physics.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'computations/fan-savings.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'computations/end-use.js'), 'utf8'), sb);
  vm.runInContext(ecmSrc, sb);
  const T = sb.ECM_TEMPLATES;
  const MAP = sb.ECM_MEASURE_FIELD_MAP;
  const euKeys = Object.keys(sb.END_USES).concat(['fans']); // fans: from the Equipment Matrix, tools/test-fan-savings.js
  const lines = [];
  Object.keys(T).forEach((id) => {
    const t = T[id];
    (t.inputs || []).forEach((inp) => {
      if (inp.endUse) {
        ok(euKeys.indexOf(inp.endUse) >= 0, id + '.' + inp.id + ' names a real end use', inp.endUse);
        lines.push(id + '.' + inp.id + ' <- ' + inp.endUse);
      }
    });
    if (!(t.inputs && t.calculate)) return; // solar and bas are full-page calcs
    ok(id in MAP, id + ' is in the measure map (null = no month-by-month source)');
    const outIds = (t.outputs || []).map((o) => o.id);
    (MAP[id] || []).forEach((e) => {
      const fields = [e.field];
      ok(outIds.indexOf(e.field) >= 0, id + ' map field ' + e.field + ' is an output of the template');
      [e.endUse].concat(e.by ? [e.by.electric.endUse, e.by.otherwise.endUse] : []).forEach((list) => {
        (list || []).forEach((k) => ok(euKeys.indexOf(k) >= 0, id + ' map end use ' + k + ' exists'));
      });
      ok(
        ['kwh', 'gas', 'kw'].indexOf(e.kind || (e.by && e.by.otherwise.kind)) >= 0,
        id + ' map kind is kwh, gas or kw',
      );
      void fields;
    });
    ok(!(t.outputs || []).some((o) => /_dollar$|payback/.test(o.id)), id + ' has no dollar or payback output');
    ok(!(t.inputs || []).some((i) => /_(rate|cost)$/.test(i.id)), id + ' has no rate or cost input');
    // A template result holds only quantities: run it on its defaults
    const d = {};
    t.inputs.forEach((i) => (d[i.id] = i.default));
    const r = t.calculate(d);
    ok(
      Object.keys(r).every((k) => !/dollar|payback/.test(k)),
      id + ' result has no dollar or payback field',
    );
  });
  ok(
    lines.length === 2 &&
      lines.indexOf('rtu_replacement.existing_cooling_kwh <- cooling') >= 0 &&
      lines.indexOf('rtu_replacement.existing_heating_therms <- heatingGas') >= 0,
    'the end-use-fed inputs are exactly the RTU cooling kWh and heating Therms',
    lines.join('; '),
  );
}

// ---------------- 4. the gate ----------------
console.log('--- 4. the gate ---');
{
  const files = gate.loadFiles();
  Object.keys(files).forEach((k) => (files[k] = files[k].split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10)))); // the patches below use LF
  const clean = gate.check(files);
  ok(clean.length === 0, 'gate passes on the tree', clean.join(' | '));
  const mut = (file, fn) => {
    const copy = Object.assign({}, files);
    copy[file] = fn(copy[file]);
    return gate.check(copy);
  };
  const inTemplate = (code) => (t) =>
    t.replace(
      'calculate(inp) {\n      const afue = inp.boiler_afue / 100;',
      'calculate(inp) {\n      ' + code + '\n      const afue = inp.boiler_afue / 100;',
    );
  ok(
    mut('app/ecm-calculators.js', inTemplate('const kwh_dollar = 5;')).some((b) => /dollar/.test(b)),
    'gate fails on a dollar inside a template',
  );
  ok(
    mut('app/ecm-calculators.js', inTemplate('const simple_payback = 3;')).some((b) => /payback/.test(b)),
    'gate fails on a payback inside a template',
  );
  ok(
    mut('app/ecm-calculators.js', inTemplate('const monthly = inp.unit_cfm / 12;')).some((b) =>
      /divides by 12/.test(b),
    ),
    'gate fails on a divide by 12 inside a template',
  );
  ok(
    mut('app/ecm-calculators.js', inTemplate('const d = ecmPrice(inp, "elec", 1);')).some((b) => /prices/.test(b)),
    'gate fails on ecmPrice inside a template',
  );
  ok(
    mut('app/ecm-calculators.js', (t) =>
      t.replace('const measure = {', 'const monthlyFlat = results.kwh / 12;\n  const measure = {'),
    ).some((b) => /measure builder: divides by 12/.test(b)),
    'gate fails on a divide by 12 in the measure builder',
  );
  ok(
    mut('app/energy-savings.js', (t) => t + '\nconst x = est.coolKwhTotal;\n').some((b) =>
      /app\/energy-savings.js: reads the load estimate end-use field/.test(b),
    ),
    'gate fails on a second reader of the estimate end-use fields',
  );
  ok(
    mut('app/calculators.js', (t) =>
      t.replace(
        'function openBASCalc(',
        'function openBASCalc(projId) { const useSavedEst = 1; }\nfunction openBASCalcOld(',
      ),
    ).some((b) => /openBASCalc/.test(b)),
    'gate fails on the BAS saved-versus-measured fork',
  );
  ok(
    mut('app/calculators.js', (t) => t + '\nfunction hvacComputeElecCoolKwhForBuilding() {}\n').some((b) =>
      /second end-use reader/.test(b),
    ),
    'gate fails on a returned hvacCompute reader',
  );
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
