// WP-07 acceptance test: portal savings use numeric project ids, skip excluded meters,
// and progress divides by the savings target. SYNTHETIC data only.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const REPO = path.join(__dirname, '..');
let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

function build(projList) {
  const sb = { console, projects: projList, udSelProjId: projList[0].id, utilityData: {}, Math, Date, JSON, Number, String, Object, Array };
  sb.window = sb;
  sb._store = { en_projects: projList };
  vm.createContext(sb);
  vm.runInContext(`
    function _fixISO(d){ return d; }
    function _parseISO(d){ return new Date(d + 'T12:00:00'); }
    function calcDays(s,e,inc){ const a=_parseISO(s),b=_parseISO(e); const diff=Math.round((b-a)/86400000); return inc? diff+1 : diff; }
    function getUDProj(pid){ return utilityData[pid] || (utilityData[pid]={buildings:[]}); }
    function getUDBldgs(pid){ return getUDProj(pid).buildings; }
    function getUDBldg(pid,bid){ return getUDBldgs(pid).find(function(b){return b.id===bid;}); }
    function getWeatherForBuilding(){ return { byYm: null, cache: [], zip: '' }; }
    function sget(k,d){ return _store[k] !== undefined ? _store[k] : d; }
    function sset(k,v){ _store[k]=v; }
    function _rptUnit(s){ return s; }
  `, sb);
  // real isBaselineExcluded, cut from source
  const ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  const i = ud.indexOf('function isBaselineExcluded');
  vm.runInContext(ud.slice(i, ud.indexOf('function setBaselineExcluded')), sb);
  ['lib/date-helpers.js', 'computations/regression.js', 'computations/normalization.js', 'computations/rates.js',
    'computations/savings.js', 'computations/eui.js', 'computations/csc.js']
    .forEach((rel) => vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sb, { filename: rel }));
  return sb;
}
const ym = (y, m) => y + '-' + String(m).padStart(2, '0');
function bill(y, m, f) {
  const d = new Date(y, m, 0).getDate();
  return Object.assign({ start: ym(y, m) + '-01', end: ym(y, m) + '-' + String(d).padStart(2, '0') }, f);
}
function meter(id) {
  const bills = [];
  for (let m = 1; m <= 12; m++) bills.push(bill(2024, m, { kwh: '10000', totalCost: '1000', kwhCost: '800', totalKwhRate: '0.08', demandKW: '100', billedKW: '100' }));
  for (let m = 1; m <= 3; m++) bills.push(bill(2025, m, { kwh: '8000', totalCost: '800', kwhCost: '640', totalKwhRate: '0.08', demandKW: '100', billedKW: '100' }));
  return { id, commodity: 'Electric', inclusive: true, bills, baseline: { months: Array.from({ length: 12 }, (_, i) => ym(2024, i + 1)) } };
}
function setup(projId, excludeIds) {
  // exclusion checks below use a string id so they do not depend on the numeric-id fix
  const proj = { id: projId, sa: 'SA-1', name: 'T', contract: 300000, savings: 100000, scope: { meterExcludeIds: excludeIds } };
  const sb = build([proj]);
  vm.runInContext(`utilityData[${JSON.stringify(projId)}]={buildings:[{id:'b1',name:'B',meters:[]}]};`, sb);
  sb.m1 = meter('m1'); sb.m2 = meter('m2');
  vm.runInContext(`utilityData[${JSON.stringify(projId)}].buildings[0].meters.push(m1, m2);`, sb);
  return sb;
}
const total = (o) => Object.values(o).reduce((s, v) => s + v, 0);

// 1. numeric id (portal passes String(id))
let sb = setup(7, []);
let r = vm.runInContext('getProjectSavingsByYM(String(7))', sb);
check('numeric project id returns savings', Object.keys(r).length === 3, JSON.stringify(r));
const both = total(r);

// 2. excluded meter is skipped
sb = setup('p1', []);
const bothS = total(vm.runInContext("getProjectSavingsByYM('p1')", sb));
sb = setup('p1', ['m2']);
r = vm.runInContext("getProjectSavingsByYM('p1')", sb);
check('excluded meter skipped (one of two meters left)', bothS > 0 && Math.abs(total(r) - bothS / 2) < 0.01, 'both=' + bothS + ' now=' + total(r));
sb = setup('p1', ['m1', 'm2']);
r = vm.runInContext("getProjectSavingsByYM('p1')", sb);
check('all meters excluded -> nothing', Object.keys(r).length === 0, JSON.stringify(r));

// 3. portal export: progress uses savings target, exports target, no placeholder contact, skips excluded units
sb = setup(7, ['m2']);
let blobText = null;
vm.runInContext(`
  var crypto = { randomUUID: function(){ return 'tok'; } };
  function showToast(){}
  function extractStateFromAddress(){ return 'KS'; }
  function calculatePollutionCredits(){ return { totalCO2: 0 }; }
  var EQUIV_PER_MT_CO2E = {};
  var location = { pathname: '/x.html', origin: 'http://t', protocol: 'file:' };
  var navigator = {};
  var URL = { createObjectURL: function(){ return 'x'; }, revokeObjectURL: function(){} };
  var Blob = function(parts){ this.text = parts[0]; };
  var document = { createElement: function(){ return { click: function(){} }; }, body: { appendChild: function(){}, removeChild: function(){} } };
`, sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/portal-export.js'), 'utf8'), sb);
sb.URL.createObjectURL = (b) => { blobText = b.text; return 'x'; };
vm.runInContext('publishClientPortal(7)', sb);
const snap = JSON.parse(blobText);
const half = Math.round(bothS / 2);
check('summary total counts only included meters', snap.summary.totalSavingsDollars === half, snap.summary.totalSavingsDollars + ' vs ' + half);
check('exports annualTargetDollars = project savings target', snap.summary.annualTargetDollars === 100000, String(snap.summary.annualTargetDollars));
check('progress = savings / target (not contract)', snap.summary.contractProgressPct === Math.round((half / 100000) * 1000) / 10, String(snap.summary.contractProgressPct));
check('placeholder contact removed', snap.contact === undefined);
console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
