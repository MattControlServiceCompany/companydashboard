// tools/test-contract-baseline-freeze.js - synthetic data only (fake ids, no client names).
// Run: node tools/test-contract-baseline-freeze.js
// Under a signed contract the baseline (usage and cost per meter-month) is stored once on the meter
// (m.baseline.contractFrozen, freezeContractBaseline in computations/savings.js) and only read after that
// (getContractFrozenBaseline + buildMoMap in computations/normalization.js). A project with no contract
// still recomputes from its bills.
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
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const p2 = (n) => String(n).padStart(2, '0');
const ld = (y, m) => new Date(y, m, 0).getDate();
const mkBills = () => {
  const out = [];
  [2029, 2030].forEach((y) => {
    for (let m = 1; m <= 12; m++) {
      if (y === 2030 && m > 6) break;
      const base = y === 2029;
      out.push({ start: y + '-' + p2(m) + '-01', end: y + '-' + p2(m) + '-' + p2(ld(y, m)), therms: base ? 100 : 80, totalCost: base ? 150 : 110 });
    }
  });
  return out;
};
const mkMeter = (id) => ({
  id,
  commodity: 'Gas',
  inclusive: true,
  bills: mkBills(),
  baseline: { months: Array.from({ length: 12 }, (_, i) => '2029-' + p2(i + 1)) },
});
const projects = [
  { id: 1, sa: 'SA-TEST' },
  { id: 2, sa: '' },
];
const bldgs = { 1: { id: 'b1', meters: [mkMeter('mC')] }, 2: { id: 'b2', meters: [mkMeter('mN')] } };
const sb = { console };
sb.window = sb;
vm.createContext(sb);
sb.__projects = projects;
sb.__bldgs = bldgs;
const pre = [
  'var projects = __projects;',
  'var udSelProjId = 1;',
  'var __store = {}; function sget(k, d){ return k in __store ? __store[k] : d; } function sset(k, v){ __store[k] = v; }',
  'function getWeatherForBuilding(){ return { byYm: null, cache: [] }; }',
  'function getUDBldg(p, b){ return __bldgs[p]; }',
  'function getUDBldgs(p){ return [__bldgs[p]]; }',
  'function isBaselineExcluded(){ return false; } function isCalcCommodity(){ return true; }',
  'var DELIVERY_COMMODITIES = new Set(["Propane"]);',
  'function _rptUnit(s){ return s; }',
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
].join('\n');
const files = ['lib/formatting.js', 'lib/date-helpers.js', 'computations/regression.js', 'computations/rates.js', 'computations/normalization.js', 'computations/csc.js', 'computations/savings.js'];
vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
const ev = (e) => vm.runInContext(e, sb);

const moMapOf = (pid) =>
  ev(`(function(){const m=__bldgs[${pid}].meters[0];const rows=getNormRows(m,m.bills,true,null);
    const bl=rows.filter(r=>m.baseline.months.includes(r.ym));return JSON.stringify(buildMoMap(m,bl,m.bills,true).gasByMo);})()`);
const savOf = (pid) =>
  ev(`(function(){const m=__bldgs[${pid}].meters[0];delete m._savingsCache;delete m._savingsCacheKey;
    return JSON.stringify(getMeterSavings(m,m.bills,true,${pid},__bldgs[${pid}].id).rows.map(r=>[r.ym,r.expUsage,r.savings]));})()`);
const editBaselineBill = (pid) =>
  ev(`(function(){const m=__bldgs[${pid}].meters[0];const b=m.bills.find(x=>x.start==='2029-03-01');b.therms=999;b.totalCost=1500;})()`);

console.log('=== contracted project: baseline stored once, bill edit changes nothing ===');
const sav1 = savOf(1); // first compute stores the baseline
assert(ev('!!__bldgs[1].meters[0].baseline.contractFrozen'), 'contracted: baseline stored by the first savings compute');
assert(JSON.parse(sav1).length === 6 && JSON.parse(sav1).every((r) => r[1] > 0 && r[2] !== 0), 'fixture: 6 post-baseline months with savings');
const map1 = moMapOf(1);
editBaselineBill(1);
assert(ev('__bldgs[1].meters[0].bills.find(x=>x.start==="2029-03-01").therms') === 999, 'fixture: the baseline bill was edited');
assert(moMapOf(1) === map1, 'contracted: baseline rows (usage and cost per month) unchanged after a baseline bill edit');
assert(savOf(1) === sav1, 'contracted: expected usage and savings (projections) unchanged after the edit');
ev(`__bldgs[1].meters[0].bills.push({start:'2030-07-01',end:'2030-07-31',therms:70,totalCost:100});`);
assert(JSON.parse(savOf(1)).length === 7 && JSON.stringify(JSON.parse(savOf(1)).slice(0, 6)) === JSON.stringify(JSON.parse(sav1)), 'contracted: a new bill adds its own month and leaves earlier months unchanged');
assert(ev('freezeContractBaselines()') === 0, 'freeze runs once: nothing written the second time');

console.log('=== project with no contract: still recomputes ===');
savOf(2);
assert(ev('!__bldgs[2].meters[0].baseline.contractFrozen'), 'no contract: nothing stored');
const map2 = moMapOf(2);
editBaselineBill(2);
assert(moMapOf(2) !== map2, 'no contract: baseline rows recompute after the same edit');

console.log('=== a new baseline selection replaces the stored one ===');
ev(`(function(){const m=__bldgs[1].meters[0];m.baseline.months=m.baseline.months.slice(0,6);})()`);
assert(ev('getContractFrozenBaseline(__bldgs[1].meters[0])') === null, 'stored record for other baseline months is not used');
assert(moMapOf(1) !== map1, 'with other baseline months the rows follow the bills');
savOf(1);
assert(ev('__bldgs[1].meters[0].baseline.contractFrozen.months.length') === 6, 'a new record is stored for the new months');

console.log('=== freezeContractBaselines writes only contracted projects ===');
ev('delete __bldgs[1].meters[0].baseline.contractFrozen; delete __bldgs[1].meters[0]._savingsCache; delete __bldgs[1].meters[0]._savingsCacheKey;');
assert(ev('freezeContractBaselines()') === 1, 'one meter frozen (the contracted one)');
assert(ev('!!__bldgs[1].meters[0].baseline.contractFrozen && !__bldgs[2].meters[0].baseline.contractFrozen'), 'contracted stored, non-contracted not');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
