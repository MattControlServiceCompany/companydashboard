// tools/test-pinned-month-row.js - gate test: a pinned (presented) month always has a table row.
// SYNTHETIC data only. Loads the REAL repo files into a vm sandbox (same loader as test-perf-table-equals-savings.js).
// Run: node tools/test-pinned-month-row.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.005 : tol);

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
const rdOpt = (rel) => (fs.existsSync(path.join(REPO, rel)) ? rd(rel) : '');

function build(projects) {
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  const pre = [
    'var projects = ' + JSON.stringify(projects) + ';',
    'var udSelProjId = 1;',
    'var _bldg = { id: "b1", meters: [] };',
    'var __store = {}; function sget(k, d){ return k in __store ? __store[k] : d; }',
    'function sset(k, v){ __store[k] = v; }',
    'function getWeatherForBuilding(){ return { byYm: null, cache: [] }; }',
    'function getUDBldg(){ return _bldg; }',
    'function _rptUnit(s){ return s; }',
    loadFn(REPO + '/app/utility-data.js', '_fixISO'),
    loadFn(REPO + '/app/utility-data.js', '_parseISO'),
    loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  ].join('\n');
  const files = [
    'lib/formatting.js',
    'lib/date-helpers.js',
    'computations/regression.js',
    'computations/rates.js',
    'computations/normalization.js',
    'computations/savings.js',
    'lib/perf-table.js',
  ];
  vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
  return sb;
}
const ev = (sb, e) => vm.runInContext(e, sb);
const ld = (y, m) => new Date(y, m, 0).getDate();
const p2 = (n) => String(n).padStart(2, '0');
const mb = (y, m, f) => Object.assign({ start: y + '-' + p2(m) + '-01', end: y + '-' + p2(m) + '-' + p2(ld(y, m)) }, f);
const blMonths = (y) => Array.from({ length: 12 }, (_, i) => y + '-' + p2(i + 1));
const PROJ = [{ id: 1, sa: 'SA-1', name: 'T' }];
// parse table cells of every <tr>
const cells = (html) =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((r) =>
    [...r[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => c[1].replace(/<[^>]+>/g, '')),
  );
const money = (s) => {
  const neg = /\u2212|-/.test(s);
  const v = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(v) ? NaN : neg ? -v : v;
};
const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);


// Propane: monthly deliveries all of 2029 (baseline) and Jan-Mar 2030. The spread gives no usage to 2030-03
// (after the last delivery, in the future so no zero-fill row). 2030-03 is pinned to $250.
(function () {
  const sb = build(PROJ);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push({ start: '2029-' + p2(m) + '-01', end: '2029-' + p2(m) + '-01', gallonsDelivered: '100', totalCost: '169' });
  for (let m = 1; m <= 3; m++)
    bills.push({ start: '2030-' + p2(m) + '-01', end: '2030-' + p2(m) + '-01', gallonsDelivered: '80', totalCost: '135.2' });
  const months = [];
  for (let m = 2; m <= 12; m++) months.push('2029-' + p2(m));
  sb.M = { id: 'p1', commodity: 'Propane', inclusive: true, bills, baseline: { months, costSavOverrides: { '2030-03': 250 } } };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const row = s.rows.find((r) => r.ym === '2030-03');
  assert(!!row, 'pinned month 2030-03 has a row in getMeterSavings rows');
  assert(row && row.pinned === true && near(row.savings, 250), 'pinned row carries the pinned $250, got ' + (row && row.savings));
  assert(row && row.actUsage === 0, 'pinned row usage is the real 0 from the spread, got ' + (row && row.actUsage));
  assert(near(s.byYM['2030-03'], 250), 'byYM keeps the pinned $250');
  assert(s.rows.every((r, i, a) => i === 0 || a[i - 1].ym < r.ym), 'rows stay in month order');
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'tab', projId:1, bldgId:'b1'})");
  const r3 = cells(p.html).find((r) => /Mar 2030/.test(r[0]));
  assert(!!r3, 'table shows a Mar 2030 row');
  assert(r3 && /250\.00/.test(r3[r3.length - 1]), 'Mar 2030 row shows $250.00, got ' + (r3 && r3[r3.length - 1]));
  assert(r3 && r3[3] === '0', 'Mar 2030 actual gal shows 0, got ' + (r3 && r3[3]));
  assert(r3 && !/NaN|null|undefined/.test(r3.join(' ')), 'no NaN/null text in the pinned row');
})();

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
