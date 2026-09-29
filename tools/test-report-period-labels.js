// test-report-period-labels.js — Financial Summary page labels follow the report period (synthetic data).
// Annual: "Annual Savings vs Baseline", column YEAR, CSC table = Year + N-Year Total (no ANNUALIZED).
// Quarterly: output unchanged (Quarterly heading, QUARTER + ANNUALIZED + N-Year Total).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const src = fs.readFileSync(path.join(root, 'app/report-engine.js'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let j = src.indexOf('{', src.indexOf(')', i)), depth = 0;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
}
const ctx = { console, Math, Number, String, Object, Array, Date, isFinite, parseFloat, JSON, parseInt,
  rptPage: (n, t, body) => body };
vm.createContext(ctx);
['computations/csc.js', 'lib/formatting.js', 'app/report-printed.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx));
['_rptUnit', '_rptPeriodWords', 'rptPageFinancial'].forEach((n) => vm.runInContext(grab(n), ctx));

function data(type) {
  const b = { name: 'Bldg A', sqft: 1000, blCost: 1000, curCost: 800, savings: 200, savingsPct: 20, status: 'on_track' };
  return {
    period: { type, quarter: type === 'quarterly' ? 2 : null, year: 2026, yearMonths: [] },
    contract: { hasCsc: true, cscPct: 60, clientPct: 40, years: 3, quarterlyTargets: [50, 50, 50, 50], annualTarget: 200,
      escalation: 0, quarterlyActuals: type === 'quarterly' ? [100, 100, null, null] : null },
    totals: { savings: 200, savingsPct: 20, blCost: 1000, curCost: 800, kwhBl: 1, kwhCur: 1, thermsBl: 1, thermsCur: 1, propaneBl: 0, propaneCur: 0 },
    buildings: [b], project: { sqft: 1000 },
  };
}
function run(type) { try { return ctx.rptPageFinancial(1, data(type)); } catch (e) { return 'ERR ' + e.message; } }
const a = run('annual'), q = run('quarterly');
ok(typeof a === 'string' && a.indexOf('ERR') !== 0, 'annual renders (' + String(a).slice(0, 60) + ')');
ok(/<h2>Annual Savings vs Baseline<\/h2>/.test(a), 'annual heading "Annual Savings vs Baseline"');
ok(!/Quarterly Savings/.test(a), 'annual has no "Quarterly Savings"');
ok(!/>Quarter</.test(a), 'annual has no "Quarter" column');
ok(/>Year</.test(a), 'annual has "Year" column');
ok(!/Annualized/.test(a), 'annual CSC table has no Annualized column');
ok(/3-Year Total/.test(a), 'annual CSC table keeps 3-Year Total');
ok(/<h2>Quarterly Savings vs Baseline<\/h2>/.test(q), 'quarterly heading unchanged');
ok(/>Quarter</.test(q) && /Annualized/.test(q) && /3-Year Total/.test(q), 'quarterly columns unchanged');
console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
process.exit(fails ? 1 : 0);
