// tools/detect-bas-heating-saved.js - READ-ONLY detector (WP-12).
// Lists saved "BAS HVAC Optimization" measures added on/after 2026-09-25 (the v2026.09.25.5
// heating combine, which dropped the OA add-back) and compares saved annual heating therms with
// therms recomputed from the project's saved BAS Calc inputs using the current _bcDoCalc.
// It never writes to the backup or to the app. Matt decides whether to re-apply.
// Run: node tools/detect-bas-heating-saved.js <backup-copy.json> [out.csv]
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const REPO = path.join(__dirname, '..');
const inFile = process.argv[2];
if (!inFile) {
  console.error('usage: node tools/detect-bas-heating-saved.js <backup-copy.json> [out.csv]');
  process.exit(2);
}
const CALC = path.join(REPO, 'app', 'calculators.js');
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
const src = [
  fs.readFileSync(path.join(REPO, 'app', 'data', 'bas-weather-bins.js'), 'utf8'),
  loadConst(path.join(REPO, 'app', 'equipment-matrix.js'), 'EM_SP_DEFAULTS'),
  loadConst(CALC, 'BAS_COOL_CURVE'),
  loadConst(CALC, 'BAS_HEAT_CURVE'),
  loadConst(CALC, 'BAS_VRF_COP'),
  loadConst(CALC, 'BAS_TEMP_BINS'),
  loadConst(CALC, 'BAS_MO'),
  loadFn(CALC, '_bcInterp'),
  loadFn(CALC, '_bcUnoccHeatType'),
  loadFn(CALC, '_bcDefaultUnoccHeat'),
  loadConst(CALC, 'BAS_CITIES'),
  loadFn(CALC, '_basCityWeather'),
  loadFn(CALC, '_bcGv'),
  loadFn(CALC, '_bcCalibrateHeatAdj'),
  loadFn(CALC, '_bcDoCalc'),
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
function recompute(bc) {
  const dom = new Map();
  for (const k in bc) {
    if (typeof bc[k] === 'object' && bc[k] !== null) continue;
    const sel = ['heatSrc', 'exOAShutoff', 'newOAShutoff'].includes(k);
    dom.set('bc-' + k, new FE(String(bc[k]), sel ? 'SELECT' : 'INPUT'));
  }
  ['bc-coolAdjWarn', 'bc-adjCool', 'bc-adjHeat', 'bc-results'].forEach((k) => dom.set(k, new FE('', 'DIV')));
  const sb = { console, document: { getElementById: (id) => dom.get(id) || null }, window: {} };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  const project = { id: 'p1', basCalc: bc };
  sb.projects = [project];
  sb._bcDoCalc('p1');
  return project._bcResults;
}

const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
let projects = data.en_projects;
if (typeof projects === 'string') projects = JSON.parse(projects);
const CUTOFF = Date.parse('2026-09-25T00:00:00');
const rows = [
  [
    'project',
    'measure_id',
    'added',
    'desc',
    'saved_annual_therms',
    'recomputed_annual_therms',
    'diff_therms',
    'saved_negative_months',
  ],
];
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
for (const p of projects || []) {
  const ms = (p.savingsData && p.savingsData.measures) || [];
  for (const m of ms) {
    if (m.source !== 'bas' || !/^BAS HVAC Optimization/.test(m.desc || '')) continue;
    const ts = parseInt(String(m.id).replace(/^m/, ''), 10);
    if (!(ts >= CUTOFF)) continue;
    const saved = (m.gas || []).reduce((a, b) => a + b, 0);
    let rec = '';
    if (p.basCalc) {
      try {
        rec = Math.round(recompute(p.basCalc).annHeatGasSav);
      } catch (e) {
        rec = 'error: ' + e.message;
      }
    }
    rows.push([
      p.name || p.id,
      m.id,
      new Date(ts).toISOString().slice(0, 10),
      m.desc,
      saved,
      rec,
      typeof rec === 'number' ? rec - saved : '',
      (m.gas || []).filter((g) => g < 0).length,
    ]);
  }
}
const csv = rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
if (process.argv[3]) fs.writeFileSync(process.argv[3], csv);
console.log(csv);
console.log('rows: ' + (rows.length - 1));
