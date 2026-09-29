// tools/test-bas-calc-heating-oa-net.js - BAS Calc heating: OA add-back + bisection calibration.
// Run: node tools/test-bas-calc-heating-oa-net.js
//
// Oracle: BAS Savings Calc Template workbook, Existing!I2 = Z20 + AL12 (net setback + full OA),
// and Savings Calculator!K45 (= SUM of that column) is goal-sought to the billed figure (K46).
// So per month: heating = MAX(setback*adj - OA, 0) + OA, and adj is solved so the existing
// total equals the entered figure. v2026.09.25.5 dropped the "+ OA"; that gave negative savings
// when New conditions were strictly lower.
// Real _bcDoCalc / _bcCalibrateHeatAdj text is loaded into a vm. Synthetic inputs only.
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
function loadFn(file, fn) {
  const s = fs.readFileSync(file, 'utf8');
  const mi = s.indexOf('function ' + fn + '(');
  if (mi < 0) throw new Error('not found: ' + fn);
  let d = 0,
    e = s.indexOf('(', mi);
  for (; e < s.length; e++) {
    if (s[e] === '(') d++;
    else if (s[e] === ')' && --d === 0) break;
  }
  let dd = 0,
    j = s.indexOf('{', e);
  for (; j < s.length; j++) {
    if (s[j] === '{') dd++;
    else if (s[j] === '}' && --dd === 0) break;
  }
  return s.slice(mi, j + 1);
}
function loadConst(file, name) {
  const s = fs.readFileSync(file, 'utf8');
  let mi = s.indexOf('const ' + name + ' =');
  if (mi < 0) mi = s.indexOf('var ' + name + ' =');
  if (mi < 0) throw new Error('not found: ' + name);
  let d = 0,
    j = mi;
  for (; j < s.length; j++) {
    const c = s[j];
    if ('[{('.includes(c)) d++;
    else if (']})'.includes(c)) d--;
    else if (c === ';' && !d) break;
  }
  return s.slice(mi, j + 1);
}
const CALC = path.join(REPO, 'app', 'calculators.js');
const calcSrc = fs.readFileSync(CALC, 'utf8');
const hasKeeper = calcSrc.includes('function _bcCalibrateHeatAdj(');
const src = [
  fs.readFileSync(path.join(REPO, 'app', 'data', 'bas-weather-bins.js'), 'utf8'),
  loadConst(path.join(REPO, 'app', 'equipment-matrix.js'), 'EM_SP_DEFAULTS'),
  loadConst(CALC, 'BAS_COOL_CURVE'),
  loadConst(CALC, 'BAS_HEAT_CURVE'),
  loadConst(CALC, 'BAS_VRF_COP'),
  loadConst(CALC, 'BAS_TEMP_BINS'),
  loadConst(CALC, 'BAS_MO'),
  loadFn(CALC, '_bcInterp'),
  loadFn(CALC, '_bcDefaultUnoccHeat'),
  loadConst(CALC, 'BAS_CITIES'),
  loadFn(CALC, '_basCityWeather'),
  loadFn(CALC, '_bcGv'),
  hasKeeper ? loadFn(CALC, '_bcCalibrateHeatAdj') : '',
  loadFn(CALC, '_bcDoCalc'),
]
  .join('\n\n')
  // test-only hook in the vm copy: expose calibrated existing arrays and the factor
  .replace('p._bcResults = {', 'p._bcDbg={exHeatGasM,exHeatKwhM,heatAdj};p._bcResults = {')
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
function run(inp) {
  const dom = new Map();
  const sel = ['bc-heatSrc', 'bc-exOAShutoff', 'bc-newOAShutoff'];
  for (const k in inp) dom.set(k, new FE(String(inp[k]), sel.includes(k) ? 'SELECT' : 'INPUT'));
  ['bc-coolAdjWarn', 'bc-adjCool', 'bc-adjHeat', 'bc-results'].forEach((k) => dom.set(k, new FE('', 'DIV')));
  const sb = { console, document: { getElementById: (id) => dom.get(id) || null }, window: {} };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  const project = { id: 'p1', basCalc: {} };
  sb.projects = [project];
  sb._bcDoCalc('p1');
  return { r: project._bcResults, dbg: project._bcDbg };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
// Synthetic gas building (no client data).
const base = {
  'bc-sqft': 80000,
  'bc-heatSrc': 3,
  'bc-vrfPct': 0,
  'bc-coolEff': 0.86,
  'bc-afue': 0.8,
  'bc-elecCOP': 1,
  'bc-city': 4,
  'bc-exCoolOcc': 74,
  'bc-exCoolUnocc': 85,
  'bc-exHeatOcc': 70,
  'bc-exHeatUnocc': 55,
  'bc-exOAShutoff': 'yes',
  'bc-exMfOn': 0,
  'bc-exMfOff': 24,
  'bc-exSatOn': 0,
  'bc-exSatOff': 24,
  'bc-exSunOn': 0,
  'bc-exSunOff': 24,
  'bc-newCoolOcc': 74,
  'bc-newCoolUnocc': 85,
  'bc-newHeatOcc': 70,
  'bc-newHeatUnocc': 55,
  'bc-newOAShutoff': 'yes',
  'bc-newMfOn': 6,
  'bc-newMfOff': 18,
  'bc-newSatOn': 0,
  'bc-newSatOff': 0,
  'bc-newSunOn': 0,
  'bc-newSunOff': 0,
  'bc-calCoolKwh': 150000,
  'bc-calHeatKwh': '',
  'bc-calHeatGas': 15000,
  'bc-peakStart': 16,
  'bc-peakEnd': 18,
  'bc-humRatioSP': 0.0082,
};

console.log('--- 1. Source shape: add-back on all 4 lines, one bisection keeper ---');
for (const n of ['exHeatKwhM', 'newHeatKwhM', 'exHeatGasM', 'newHeatGasM']) {
  const re = new RegExp(
    n + ' = \\w+\\.map\\(\\(v, m\\) => Math\\.max\\(v \\* heatAdj - \\w+\\[m\\], 0\\) \\+ \\w+\\[m\\]\\)',
  );
  assert(re.test(calcSrc), n + ' combine must be MAX(setback*adj-OA,0)+OA');
}
assert(!/Math\.max\(v \* heatAdj - \w+\[m\], 0\)\)/.test(calcSrc), 'no-add-back combine must be gone');
assert(!/heatAdj = \(cal\w+ \+ rawEx\w+OATotal\) \//.test(calcSrc), 'closed-form heatAdj must be gone');
assert((calcSrc.match(/function _bcCalibrateHeatAdj\(/g) || []).length === 1, 'exactly one _bcCalibrateHeatAdj');
assert((calcSrc.match(/_bcCalibrateHeatAdj\(/g) || []).length === 4, 'keeper: 1 definition + 3 calls');

console.log('--- 2. New strictly less conditioning: no negative heating savings ---');
const cases = {
  'A: existing 24h all days, new 6-18 weekdays': base,
  'B: existing 24h Mon-Fri only, new 6-17': Object.assign({}, base, {
    'bc-exSatOff': 0,
    'bc-exSunOff': 0,
    'bc-newMfOff': 17,
  }),
};
for (const [name, inp] of Object.entries(cases)) {
  const { r, dbg } = run(inp);
  const neg = r.gasSavings.filter((x) => x < -1e-6);
  assert(neg.length === 0, name + ': negative months: ' + neg.map(Math.round).join(','));
  assert(r.annHeatGasSav > 0, name + ': annual therms saved positive, got ' + r.annHeatGasSav);
  const exTot = sum(dbg.exHeatGasM);
  assert(Math.abs(exTot - 15000) < 1, name + ': existing total ' + exTot + ' must equal entered 15000');
}

console.log('--- 3. Clamp month: calibration still hits the target ---');
{
  const { dbg } = run(Object.assign({}, base, { 'bc-calHeatGas': 14000 }));
  const exTot = sum(dbg.exHeatGasM);
  assert(Math.abs(exTot - 14000) < 1, 'existing total ' + exTot + ' must equal entered 14000');
}

console.log('--- 4. Keeper unit: monotone bisection ---');
if (hasKeeper) {
  const sb = { Math };
  vm.createContext(sb);
  vm.runInContext(loadFn(CALC, '_bcCalibrateHeatAdj'), sb);
  const S = [10, 50, 100, 5],
    OA = [20, 20, 20, 20];
  const a = sb._bcCalibrateHeatAdj(S, OA, 250);
  const tot = sum(S.map((v, m) => Math.max(v * a - OA[m], 0) + OA[m]));
  assert(Math.abs(tot - 250) < 1e-6, 'keeper total ' + tot + ' must equal 250');
} else assert(false, 'keeper missing');

console.log('--- 5. Existing OA shutoff default stays Yes ---');
assert(
  /exOAShutoff: \{ value: 'yes'/.test(fs.readFileSync(path.join(REPO, 'app', 'calc-autofill.js'), 'utf8')),
  'autofill Existing OA shutoff default is yes',
);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
