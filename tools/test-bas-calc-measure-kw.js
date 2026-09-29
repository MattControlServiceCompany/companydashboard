// tools/test-bas-calc-measure-kw.js — WP-13 acceptance test (synthetic data only).
// Run: node tools/test-bas-calc-measure-kw.js
// Loads the REAL functions from app/ into a vm. Proves:
//   1. BAS measure kW = AVERAGE kW reduction per month = peak kWh / (days in month x peak hours),
//      not the monthly SUM of kW (old: peak kWh / peak hours, 756 kW in July vs about 24 kW).
//   2. Gas measure (heat source 1, thousand cubic feet) is written in therms using the ONE unit
//      table (UNIT_TO_BASE.MCF), not read as therms (old: 10x low, no new literal here).
//   3. bcApplyToMeasure m.totalDollar includes the kW term (same as the savings matrix).
//   4. D-15: unoccupied heating default by heating type (gas/hydronic 55, electric reheat 60);
//      "Both" (gas + electric) = 55 (gas/hydronic heat source), and each default is labeled.
//   5. D-14: hour convention = workbook (label h+1, occupied when on <= label <= off).
//      Workbook values for its default Kansas City scenario (BAS Savings Calc Template.xlsm).
//   6. One avgSetpoint(values, dp).
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
function near(a, b, tol, l) {
  assert(Math.abs(a - b) <= tol, `${l}: got ${a}, want ${b} (tol ${tol})`);
}

function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')') {
      d--;
      if (!d) break;
    }
  }
  let i = src.indexOf('{', e),
    dd = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') dd++;
    else if (src[j] === '}') {
      dd--;
      if (!dd) break;
    }
  }
  return src.slice(m.index, j + 1);
}
function loadConst(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('(?:const|var) ' + name + ' =').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let d = 0,
    j = m.index;
  for (; j < src.length; j++) {
    const c = src[j];
    if ('[{('.includes(c)) d++;
    else if (']})'.includes(c)) d--;
    else if (c === ';' && !d) break;
  }
  return src.slice(m.index, j + 1);
}
const CALC = REPO + '/app/calculators.js',
  AUTO = REPO + '/app/calc-autofill.js',
  UD = REPO + '/app/utility-data.js',
  EM = REPO + '/app/equipment-matrix.js',
  WEATHER = REPO + '/app/data/bas-weather-bins.js';

const src = [
  fs.readFileSync(WEATHER, 'utf8'),
  loadConst(EM, 'EM_SP_DEFAULTS'),
  loadConst(UD, 'UNIT_TO_BASE'),
  loadConst(UD, 'UNIT_TO_BASE_BY_COMMODITY'),
  loadFn(UD, '_unitInfo'),
  loadFn(UD, 'convertUnit'),
  loadFn(AUTO, 'avgSetpoint'),
  loadConst(CALC, 'BAS_COOL_CURVE'),
  loadConst(CALC, 'BAS_HEAT_CURVE'),
  loadConst(CALC, 'BAS_VRF_COP'),
  loadConst(CALC, 'BAS_TEMP_BINS'),
  loadConst(CALC, 'BAS_MO'),
  loadConst(CALC, 'BAS_MO_DAYS'),
  loadFn(CALC, '_bcInterp'),
  loadFn(CALC, '_bcUnoccHeatType'),
  loadFn(CALC, '_bcDefaultUnoccHeat'),
  loadFn(CALC, '_bcDefaultUnoccHeatLabel'),
  loadConst(CALC, 'BAS_CITIES'),
  loadFn(CALC, '_basCityWeather'),
  loadFn(CALC, '_bcGv'),
  loadFn(CALC, '_bcCalibrateHeatAdj'),
  loadFn(CALC, '_bcDoCalc'),
  loadFn(CALC, '_bcMeasureArrays'),
  loadFn(CALC, 'bcAddAsMeasure'),
  loadFn(CALC, 'bcApplyToMeasure'),
]
  .join('\n\n')
  .replace(/\bconst\s+/g, 'var ');

class FE {
  constructor(v, t) {
    this.value = v;
    this.tagName = t || 'INPUT';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
  }
}
const dom = new Map();
const set = (id, v, t) => dom.set(id, new FE(v, t));
dom.set('bc-coolAdjWarn', new FE('', 'DIV'));
const sb = { console, document: { getElementById: (id) => dom.get(id) || null }, window: {} };
const measures = [];
sb.getProjSavingsData = () => ({ measures });
sb.getUDBldgs = () => [{ id: 'b1' }];
sb._calcTemplateContext = { bldgId: 'b1', targetMeasureId: 'mT' };
sb._svRatesOrCanonical = () => ({ kwhSummer: 0.1, kwhWinter: 0.1, kwSummer: 10, kwWinter: 8, thermRate: 1 });
sb.SUMMER_MOS = [5, 6, 7, 8];
sb.showToast = () => {};
sb.sset = () => {};
sb.closeCalcTemplate = () => {};
vm.createContext(sb);
vm.runInContext(src, sb, { filename: 'bas-measure-kw-extracted.js' });
const project = { id: 'p1', basCalc: {} };
sb.projects = [project];

console.log('=== 1. average kW per month (synthetic results) ===');
const peak = Array(12).fill(0);
peak[6] = 1512;
peak[1] = 560; // July 1512 kWh / (31 d x 2 h) = 24.39 kW; Feb 560/(28x2) = 10
project._bcResults = {
  kwhSavings: Array(12).fill(1000),
  gasSavings: Array(12).fill(100),
  peakKwhSavings: peak,
  peakHours: 2,
  gasUnit: 'Therms',
};
sb.bcAddAsMeasure('p1');
const m1 = measures[0];
near(m1.kw[6], 24.4, 0.05, 'July average kW reduction');
near(m1.kw[1], 10, 0.05, 'February uses 28 days');
assert(m1.kw[0] === 0, 'zero peak kWh gives zero kW');
assert(Math.max(...m1.kw) < 30, 'no month exceeds a plausible average kW (old code wrote 756)');
assert(m1.gas[0] === 100, 'therms results stay therms');

console.log('=== 2. MCF gas written as therms via UNIT_TO_BASE ===');
project._bcResults = {
  kwhSavings: Array(12).fill(0),
  gasSavings: Array(12).fill(100),
  peakKwhSavings: Array(12).fill(0),
  peakHours: 2,
  gasUnit: 'MCF',
};
sb.bcAddAsMeasure('p1');
const f = sb.UNIT_TO_BASE.MCF.factor;
near(measures[1].gas[0], Math.round(100 * f), 0.5, 'MCF x UNIT_TO_BASE.MCF.factor');
assert(measures[1].gas[0] > 1000, 'MCF result is about 10x the raw number');

console.log('=== 3. bcApplyToMeasure totalDollar includes kW ===');
measures.push({ id: 'mT', bldgId: 'b1', kwh: [], kw: [], gas: [] });
project._bcResults = {
  kwhSavings: Array(12).fill(0),
  gasSavings: Array(12).fill(0),
  peakKwhSavings: peak,
  peakHours: 2,
  gasUnit: 'Therms',
};
sb.bcApplyToMeasure('p1');
const mT = measures[2];
const expect = mT.kw[6] * 10 + mT.kw[1] * 8;
near(mT.totalDollar, expect, 0.01, 'totalDollar = kW x seasonal demand rate');
assert(mT.totalDollar > 0, 'totalDollar not zero');

console.log('=== 4. D-15 unoccupied heat default by heating type, labeled ===');
assert(sb._bcDefaultUnoccHeat(1) === 55 && sb._bcDefaultUnoccHeat(3) === 55, 'gas -> 55');
assert(sb._bcDefaultUnoccHeat(2) === 60, 'electric reheat -> 60');
assert(sb._bcDefaultUnoccHeat(4) === 55, 'Both (gas + electric, gas/hydronic heat source) -> 55');
assert(sb._bcDefaultUnoccHeat(4) === sb.EM_SP_DEFAULTS.unocc.hydronic.heat, 'Both reads the hydronic table row');
assert(
  /gas or hot water/i.test(sb._bcDefaultUnoccHeatLabel(4)) && /55/.test(sb._bcDefaultUnoccHeatLabel(4)),
  'Both label names source and value',
);
assert(
  /electric reheat/i.test(sb._bcDefaultUnoccHeatLabel(2)) && /60/.test(sb._bcDefaultUnoccHeatLabel(2)),
  'electric label names source and value',
);

console.log('=== 5. D-14 workbook hour convention (Kansas City default scenario) ===');
// Workbook: hour columns are labels 1..24 (label = h + 1); occupied when on <= label <= off.
// The old site rule was h in [on, off). Workbook values below are from
// BAS Savings Calc Template.xlsm (Existing/New sheet totals, Savings Calculator N54 and K50).
const inp = {
  'bc-sqft': '19838',
  'bc-vrfPct': '0',
  'bc-coolEff': '0.86',
  'bc-afue': '0.8',
  'bc-elecCOP': '1',
  'bc-city': '4',
  'bc-exCoolOcc': '55',
  'bc-exCoolUnocc': '70',
  'bc-exHeatOcc': '70',
  'bc-exHeatUnocc': '60',
  'bc-exMfOn': '0',
  'bc-exMfOff': '24',
  'bc-exSatOn': '0',
  'bc-exSatOff': '24',
  'bc-exSunOn': '0',
  'bc-exSunOff': '24',
  'bc-newCoolOcc': '50',
  'bc-newCoolUnocc': '85',
  'bc-newHeatOcc': '60',
  'bc-newHeatUnocc': '55',
  'bc-newMfOn': '5',
  'bc-newMfOff': '21',
  'bc-newSatOn': '6',
  'bc-newSatOff': '19',
  'bc-newSunOn': '6',
  'bc-newSunOff': '19',
  'bc-calCoolKwh': '142872',
  'bc-calHeatKwh': '63166',
  'bc-peakStart': '16',
  'bc-peakEnd': '18',
  'bc-humRatioSP': '0.0082',
};
for (const k in inp) set(k, inp[k]);
set('bc-heatSrc', '1', 'SELECT');
set('bc-exOAShutoff', 'no', 'SELECT');
set('bc-newOAShutoff', 'no', 'SELECT');
['bc-adjCool', 'bc-adjHeat', 'bc-results'].forEach((k) => set(k, ''));
sb._bcDoCalc('p1');
const r = project._bcResults;
const annCool = r.coolKwhSavings.reduce((a, b) => a + b, 0);
const totalRow = dom.get('bc-results').innerHTML.split('TOTAL')[1] || '';
const cells = [...totalRow.matchAll(/>([\d,]+)</g)].map((x) => parseFloat(x[1].replace(/,/g, '')));
console.log(
  `  new cooling total ${cells[1]} (workbook 131,194); annual cooling savings ${annCool.toFixed(2)} (workbook 11,677.88); coolAdj ${dom.get('bc-adjCool').textContent} (workbook 2.608)`,
);
// NOT asserted: full workbook cooling parity (new cooling 131,194; savings 11,678; coolAdj 2.608).
// The workbook also uses step-table load percentages, a per-bin net of outside-air load and a
// different unoccupied ratio (audit math-04 E-BAS-3 a-c); those are separate model changes, not the
// hour convention. Before D-14 (hour rule h in [on, off)) the site gave new cooling 132,428, annual
// cooling savings 10,443.71; the numbers above are with the workbook hour rule.
// ASSERTED: the hour convention itself, against workbook New!I2 (Jan outside-air heating kWh
// 9,952.6, occupied hours only: OA shut off when unoccupied, New heat setpoint 60).
const rawSrc = src.replace('p._bcResults = {', 'p._bcRaw = { newHeatKwhOAM };p._bcResults = {');
const sb2 = { console, document: sb.document, window: {} };
vm.createContext(sb2);
vm.runInContext(rawSrc, sb2);
set('bc-heatSrc', '2', 'SELECT');
set('bc-newOAShutoff', 'yes', 'SELECT');
const p2 = { id: 'p2', basCalc: {} };
sb2.projects = [p2];
sb2._bcDoCalc('p2');
near(p2._bcRaw.newHeatKwhOAM[0], 9952.6, 0.1, 'New January outside-air heating kWh equals workbook New!I2 (hour label h+1, [on, off] inclusive)');
assert(r.peakHours === 2 && r.gasUnit === 'MCF', 'results carry peakHours and gasUnit');

console.log('=== 6. avgSetpoint ===');
near(sb.avgSetpoint([70, 71, 71], 0), 71, 0, 'dp 0');
near(sb.avgSetpoint([70, 71, 71], 1), 70.7, 0.001, 'dp 1');
assert(sb.avgSetpoint(['x', null], 0) === null, 'no numbers -> null');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
