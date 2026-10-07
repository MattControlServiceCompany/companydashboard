// tools/test-presented-printed-values.js - WP-04b acceptance test: a presented period keeps EVERY printed figure.
// A synthetic presented record with full values (imported through the CSV parser) renders exactly those values in
// every section of the updated report; a cell the document did not print keeps the current math.
// SYNTHETIC data only (no client names or values). Loads the REAL repo files into a vm sandbox.
// Run: node tools/test-presented-printed-values.js
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
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

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

const REP = REPO + '/app/report-engine.js';
const store = {};
const pre = [
  'var __store = {}; function sget(k, d){ return k in __store ? JSON.parse(JSON.stringify(__store[k])) : d; }',
  'function sset(k, v){ __store[k] = JSON.parse(JSON.stringify(v)); }',
  'function _escHtml(s){ return String(s == null ? "" : s); }',
  'function rptPage(n, title, body){ return body; }',
  'function _rptPresentedLineHTML(){ return ""; }',
  'function _rptYtdKicker(){ return ""; }',
  'function _rptContentBudget(){ return 100000; }',
  'function _rptPaginateTokens(t){ return [t]; }',
  'function _rptTextLineH(){ return 16; }',
  'function getUDBldgs(){ return BLDGS; }',
  'var BLDGS = [{ id: "b1", name: "Alpha School" }, { id: "b2", name: "Beta School" }];',
].join('\n');
const sb = { console };
sb.window = sb;
vm.createContext(sb);
const files = [
  'lib/formatting.js',
  'lib/date-helpers.js',
  'computations/regression.js',
  'computations/rates.js',
  'computations/normalization.js',
  'computations/csc.js',
  'computations/eui.js',
  'computations/savings.js',
  'lib/perf-table.js',
  'app/report-printed.js',
];
const fns = [
  '_rptUnit',
  '_rptPeriodWords',
  '_rptContractProgressPct',
  'rptPageCover',
  'rptPageFinancial',
  'rptPageSavingsPerformance',
  'rptPageEnvironmentalImpact',
  'rptPageObservations',
  'rptPageEUI',
  'rptPageContractProjection',
  'rptPageAppendixWeather',
];
const utilFns = ['_fixISO', '_parseISO', 'calcDays'].map((f) => loadFn(REPO + '/app/utility-data.js', f));
vm.runInContext(
  [pre]
    .concat(utilFns)
    .concat(files.map(rd))
    .concat(fns.map((f) => loadFn(REP, f)))
    .join('\n\n'),
  sb,
);
const ev = (e) => vm.runInContext(e, sb);

// ---- the synthetic printed document ---------------------------------------------------------------
// One CSV in the import format: building,figure,value. Numbers are distinctive so a fallback to current math shows.
const rows = [];
const P = (row, section, comm, month, col, val) =>
  rows.push([row, 'printed:' + [section, comm, month, col].join('|'), val]);
const A = 'Alpha School',
  B = 'Beta School';
rows.push([A, 'savings_dollars', '4111']);
rows.push([B, 'savings_dollars', '2222']);
rows.push(['Portfolio total', 'savings_dollars', '6333']);
// cover
[
  ['pct_of_target', 71],
  ['ahead_of_projection', -777],
  ['buildings_exceeding', 1],
  ['buildings_total', 9],
  ['q_target', 8901],
  ['gauge_energy_reduced', 33],
  ['gauge_eui_improved', 44],
  ['gauge_contract_progress', 55],
].forEach(([c, v]) => P('Portfolio', 'cover', '', '', c, v));
// building table
const bt = {
  [A]: [123456, 91111, 81111, 71111, 4111, 4.4, 'Near Target'],
  [B]: [67890, 92222, 82222, 72222, 2222, 2.2, 'Below Target'],
};
Object.keys(bt).forEach((b) =>
  ['sqft', 'baseline_cost', 'projected_cost', 'actual_cost', 'savings', 'pct', 'status'].forEach((c, i) =>
    P(b, 'building table', '', '', c, bt[b][i]),
  ),
);
[
  ['sqft', 191346],
  ['baseline_cost', 183333],
  ['projected_cost', 163333],
  ['actual_cost', 143333],
  ['savings', 6333],
  ['pct', 3.3],
].forEach(([c, v]) => P('Total Portfolio', 'building table', '', '', c, v));
// quarterly table, csc table
[
  ['baseline_kwh', 5550001],
  ['actual_kwh', 5440002],
  ['baseline_therms', 66603],
  ['actual_therms', 55504],
  ['baseline_gal', 3305],
  ['actual_gal', 2206],
  ['baseline_cost', 183333],
  ['actual_cost', 143333],
  ['savings', 6333],
].forEach(([c, v]) => P('quarter', 'quarterly table', '', '', c, v));
[
  ['actual', 6333, 25333, 76999],
  ['csc', 3800, 15200, 46199],
  ['client', 2533, 10133, 30800],
].forEach(([r, q, a, y]) => {
  P(r, 'csc table', '', '', 'quarter', q);
  P(r, 'csc table', '', '', 'annualized', a);
  P(r, 'csc table', '', '', 'three_year', y);
});
// monthly cost, usage summary, annual summary
[
  ['2026-01', 30001, 20001],
  ['2026-02', 30002, 20002],
  ['2026-03', 30003, 20003],
].forEach(([m, b, a]) => {
  P('Portfolio', 'monthly cost', '', m, 'baseline_cost', b);
  P('Portfolio', 'monthly cost', '', m, 'actual_cost', a);
});
[
  ['baseline', 5550001, 4321, 66603, 3305, 183333, 61.5],
  ['current', 5440002, 4123, 55504, 2206, 143333, 51.6],
].forEach(([r, k, pk, t, g, c, e]) => {
  P(r, 'usage summary', '', '', 'kwh', k);
  P(r, 'usage summary', '', '', 'peak_kw', pk);
  P(r, 'usage summary', '', '', 'therms', t);
  P(r, 'usage summary', '', '', 'propane_gal', g);
  P(r, 'usage summary', '', '', 'cost', c);
  P(r, 'usage summary', '', '', 'site_eui', e);
});
[
  [A, 'baseline', 111111, 2222, 33333, 444, 91111, 77.7],
  [A, 'current', 100001, 2001, 30003, 400, 71111, 66.6],
  [B, 'baseline', 222222, 3333, 44444, 555, 92222, 88.8],
  [B, 'current', 200002, 3003, 40004, 500, 72222, 55.5],
].forEach(([b, w, k, kw, t, g, c, e]) => {
  P(b, 'annual summary', '', w, 'kwh', k);
  P(b, 'annual summary', '', w, 'kw', kw);
  P(b, 'annual summary', '', w, 'therms', t);
  P(b, 'annual summary', '', w, 'propane_gal', g);
  P(b, 'annual summary', '', w, 'cost', c);
  P(b, 'annual summary', '', w, 'site_eui', e);
});
P(A, 'annual summary', '', 'current', 'site_eui_change_pct', 13.4);
P(B, 'annual summary', '', 'current', 'site_eui_change_pct', 37.5);
// environmental
[
  ['co2', 987654],
  ['ch4', 321],
  ['n2o', 32],
  ['so2', 43],
  ['nox', 654],
  ['voc_oz', 76],
  ['co_oz', 1098],
  ['carsRemoved', 87],
  ['gallonsGasoline', 76543],
  ['tankerTrucks', 9],
  ['barrelsOil', 1234],
  ['households', 65],
  ['treeSeedlings', 23456],
  ['acresForest', 543],
  ['tonsRecycled', 234],
  ['propaneCylinders', 34567],
  ['kwhSaved', 845123],
  ['thermsSaved', 12321],
  ['propaneGalSaved', 567],
].forEach(([c, v]) => P('Portfolio', 'environmental', '', '', c, v));
// observations, key findings
[
  [A, 4.4, 4111, 'Gas', 'Electric'],
  [B, 2.2, 2222, 'Electric', null],
].forEach(([b, pct, sv, st, wk]) => {
  P(b, 'observations', '', '', 'pct', pct);
  P(b, 'observations', '', '', 'saved', sv);
  P(b, 'observations', '', '', 'strongest', st);
  if (wk) P(b, 'observations', '', '', 'weakest', wk);
});
P('Portfolio', 'key findings', '', '', 'kwh_avoided', 845123);
P('Portfolio', 'key findings', '', '', 'therms_reduced', 12321);
P(A, 'key findings', '', '', 'energy_star', 'Yes');
P(B, 'key findings', '', '', 'energy_star', 'No');
// EUI (rank, trend), weather, contract projection
[
  [A, 2, 31.1, 22.2, 48.5, -54.2, 'Top 25%', 0.61],
  [B, 1, 41.1, 32.2, 48.5, -33.6, '25-50th', 0.73],
].forEach(([b, rk, bl, cu, cb, vs, pc, cp]) => {
  P(b, 'eui rankings', '', '', 'rank', rk);
  P(b, 'eui rankings', '', '', 'baseline_eui', bl);
  P(b, 'eui rankings', '', '', 'current_eui', cu);
  P(b, 'eui rankings', '', '', 'cbecs', cb);
  P(b, 'eui rankings', '', '', 'vs_cbecs_pct', vs);
  P(b, 'eui rankings', '', '', 'percentile', pc);
  P(b, 'eui rankings', '', '', 'cost_per_sqft', cp);
});
P(A, 'eui trend', '', '', 'reduction_pct', 28.6);
P(B, 'eui trend', '', '', 'reduction_pct', 21.7);
[
  ['2025-01', 1111, 11],
  ['2025-02', 1222, 12],
  ['2026-01', 1333, 13],
  ['Baseline Period Avg', 5432, 45],
  ['Reporting Period Total', 1789, 103],
  ['Variance', -67.7, 130.1],
].forEach(([m, h, c]) => {
  P('Portfolio', 'weather table', '', m, 'hdd', h);
  P('Portfolio', 'weather table', '', m, 'cdd', c);
});
[
  ['hdd_period', 1789],
  ['hdd_baseline_avg', 2233],
  ['hdd_pct', -19],
  ['cdd_period', 103],
  ['cdd_baseline', 45],
  ['cdd_pct', 129],
].forEach(([c, v]) => P('Portfolio', 'weather summary', '', '', c, v));
[
  ['q1', 8901],
  ['q2', 12402],
  ['q3', 28403],
  ['q4', 8404],
  ['annual', 58110],
].forEach(([c, v]) => P('projected', 'quarterly targets', '', '', c, v));
[
  ['q1', 3561],
  ['q2', 4962],
  ['q3', 11363],
  ['q4', 3364],
  ['annual', 23244],
].forEach(([c, v]) => P('client', 'quarterly targets', '', '', c, v));
[
  ['q1', 5341],
  ['q2', 7442],
  ['q3', 17043],
  ['q4', 5044],
  ['annual', 34866],
].forEach(([c, v]) => P('csc', 'quarterly targets', '', '', c, v));
P('Portfolio', 'target vs actual', '', 'Q1', 'pct', 71);
[
  ['Year 1', 57001, 34201, 22800],
  ['Year 2', 60002, 36001, 24001],
  ['Year 3', 63003, 37802, 25201],
  ['Total', 180006, 108004, 72002],
].forEach(([y, p, c, l]) => {
  P(y, 'three year projection', '', '', 'projected', p);
  P(y, 'three year projection', '', '', 'csc', c);
  P(y, 'three year projection', '', '', 'client', l);
});
P('Year 1', 'three year projection', '', '', 'annual_projected_note', 58110);
P('Portfolio', 'contract projection', '', '', 'escalation_pct', 3.5);
// one meter table (Alpha School gas), one month row + total
const M = {
  '2026-01': [31, 1111, 999, 112, 10.1, 0.7771, 87.12],
  '2026-02': [28, 2222, 555, 1667, 75.0, 0.7772, 1295.63],
  Total: [59, 3333, 1554, 1779, 53.4, null, 1382.75],
};
Object.keys(M).forEach((mo) =>
  ['days', 'baseline', 'actual', 'saved', 'pct', 'per_unit', 'cost_sav_dollars'].forEach((c, i) => {
    if (M[mo][i] != null) P(A, 'meter table', 'Gas', mo, c, M[mo][i]);
  }),
);
P(A, 'meter table', 'Gas', '2026-03', 'saved', 4444);
const csv = 'building,figure,value\n' + rows.map((r) => r.join(',')).join('\n');

// ---- 1. CSV -> record -> printed map --------------------------------------------------------------
const parsed = ev('parsePresentedCsv(' + JSON.stringify(csv) + ', BLDGS)');
assert(parsed.bad.length === 0, '1: no unreadable rows, got ' + JSON.stringify(parsed.bad));
assert(parsed.unmatched.length === 0, '1: printed rows never count as unmatched buildings');
assert(parsed.printed['building table|b1|||sqft'] === 123456, '1: building name becomes the building id in the key');
assert(
  parsed.printed['building table|Total Portfolio|||savings'] === 6333,
  '1: a printed row label that is not a building stays as the label',
);
assert(parsed.printed['building table|b1|||status'] === 'Near Target', '1: text stays text');
assert(parsed.printed['cover|Portfolio|||ahead_of_projection'] === -777, '1: negative numbers keep their sign');
assert(
  parsed.buildings.b1 && parsed.buildings.b1.dollars === 4111 && parsed.totalDollars === 6333,
  '1: the legacy rows still fill the dollar figures',
);
const saved = ev(
  'savePresentedRecord(' +
    JSON.stringify({
      projectId: 7,
      periodStart: '2026-01',
      periodEnd: '2026-03',
      presentedAt: '2026-04-15T12:00:00.000Z',
      documentName: 'D',
      totalDollars: parsed.totalDollars,
      buildings: parsed.buildings,
      printed: parsed.printed,
    }) +
    ')',
);
assert(
  saved.ok && saved.record.printed && Object.keys(saved.record.printed).length === Object.keys(parsed.printed).length,
  '1: the record keeps every printed figure',
);
const Q1 = ['2026-01', '2026-02', '2026-03'];
assert(ev('getPresentedPrintedMap(7, ' + JSON.stringify(Q1) + ')') !== null, '1: exact period has printed figures');
assert(ev('getPresentedPrintedMap(7, ["2026-01","2026-02"])') === null, '1: a different period has none');
assert(
  ev(
    'getPresentedPrintedValue(getPresentedPrintedMap(7, ' +
      JSON.stringify(Q1) +
      '), "cover", "Portfolio", "", "", "pct_of_target")',
  ) === 71,
  '1: one printed figure by key',
);

// ---- 2. synthetic report data (current math is deliberately different from every printed figure) ----
function mkB(id, name) {
  return {
    id,
    name,
    type: 'K-12 School',
    sqft: 111,
    commodities: ['Electric', 'Gas'],
    electric: {
      kwhBl: 1,
      kwhCur: 2,
      kwhSaved: -1,
      kwBl: 3,
      kwCur: 4,
      costBl: 5,
      costCur: 6,
      costSaved: 100,
      monthly: [],
    },
    gas: { thermsBl: 7, thermsCur: 8, thermsSaved: -1, costBl: 9, costCur: 10, costSaved: 50, monthly: [] },
    propane: { galBl: 11, galCur: 12, galSaved: -1, costBl: 0, costCur: 0, costSaved: 0, monthly: [] },
    savings: 150,
    blCost: 999,
    curCost: 888,
    savingsPct: 15.0,
    targetPct: 10,
    status: 'on_track',
    hasBillsInPeriod: true,
    eui: {
      baseline: 10,
      current: 9,
      cbecs: 50,
      percentile: 'Top 25%',
      energyStar: false,
      costPerSqft: 1.11,
      trend: -10,
    },
  };
}
function mkD() {
  return {
    project: { id: 7, client: 'Synth', sqft: 222, blStart: 'Jan 2025', blEnd: 'Dec 2025' },
    contract: {
      years: 3,
      currentYear: 1,
      annualTarget: 1000,
      cscPct: 60,
      clientPct: 40,
      hasCsc: true,
      escalation: 2,
      start: '2026-01-01',
      end: null,
      quarterlyTargets: [100, 200, 300, 400],
      quarterlyActuals: [5000, null, null, null],
    },
    period: {
      type: 'quarterly',
      quarter: 1,
      year: 2026,
      label: 'January 2026 through March 2026',
      months: 3,
      yearMonths: Q1,
      end: '2026-03',
    },
    buildings: [mkB('b1', A), mkB('b2', B)],
    totals: {
      savings: 300,
      cumulativeSavings: 300,
      blCost: 1998,
      curCost: 1776,
      savingsPct: 15.0,
      kwhSaved: 5,
      kwhBl: 100,
      kwhCur: 90,
      thermsSaved: 5,
      thermsBl: 100,
      thermsCur: 90,
      propaneSaved: 0,
      propaneBl: 1,
      propaneCur: 1,
      peakKwBl: 10,
      peakKwCur: 9,
      euiBaseline: 10,
      euiCurrent: 9,
    },
    pollution: {
      pollutants: { co2: 10, ch4: 1, pm10_oz: 4242 },
      equivalents: { carsRemoved: 2 },
      stateCode: 'KS',
      inputs: { kwhSaved: 1, thermsSaved: 1, propaneGalSaved: 1 },
    },
    weather: {
      monthly: [
        { month: '2025-01', hddBl: 1, hddCur: 0, cddBl: 1, cddCur: 0, inPeriod: false },
        { month: '2025-02', hddBl: 2, hddCur: 0, cddBl: 2, cddCur: 0, inPeriod: false },
        { month: '2026-01', hddBl: 0, hddCur: 3, cddBl: 0, cddCur: 3, inPeriod: true },
      ],
      totals: { hddBl: 100, hddCur: 90, cddBl: 10, cddCur: 9 },
    },
    printed: ev('getPresentedPrintedMap(7, ' + JSON.stringify(Q1) + ')'),
  };
}
sb.__dApplied = mkD();
ev('rptApplyPrintedToData(__dApplied)');
const dA = sb.__dApplied;
const txt = (h) =>
  String(typeof h === 'string' ? h : h.html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;|&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');
const has = (h, s) => txt(h).includes(s);
const fmt = (n) => Number(n).toLocaleString('en-US');

// ---- 3. data-level overrides ------------------------------------------------------------------------
assert(
  dA.buildings[0].sqft === 123456 && dA.buildings[1].blCost === 92222 && dA.buildings[0].curCost === 71111,
  '3: building sqft / baseline / actual cost are the printed values',
);
assert(
  dA.buildings[0].status === 'near_target' && dA.buildings[1].status === 'below_target',
  '3: printed status text becomes the report status',
);
assert(
  dA.totals.kwhBl === 5550001 && dA.totals.thermsCur === 55504 && dA.totals.peakKwBl === 4321,
  '3: printed quarter totals replace the current totals',
);
assert(
  dA.contract.quarterlyTargets.join() === '8901,12402,28403,8404' && dA.contract.annualTarget === 58110,
  '3: printed quarterly targets',
);
assert(
  dA.pollution.pollutants.co2 === 987654 && dA.pollution.pollutants.pm10_oz === 4242,
  '3: printed pollutants replace; a pollutant the document did not print keeps the current value',
);
assert(dA.pollution.inputs.kwhSaved === 845123, '3: printed environmental inputs');
assert(
  dA.buildings[0].eui.energyStar === true && dA.buildings[1].eui.energyStar === false,
  '3: printed ENERGY STAR list',
);
const dNone = mkD();
dNone.printed = null;
const before = JSON.stringify(dNone);
sb.__dNone = dNone;
ev('rptApplyPrintedToData(__dNone)');
assert(JSON.stringify(sb.__dNone) === before, '3: a report with no printed figures is not touched');

// ---- 4. every section renders the printed values ------------------------------------------------------
sb.__d = dA;
const cover = ev('rptPageCover(1, __d)').html;
[
  ['$4,111', 'cover: Alpha savings'],
  ['71%', 'cover: percent of target'],
  ['$777 behind quarterly projection', 'cover: printed behind figure'],
  ['1 of 9 buildings', 'cover: printed building counts'],
  ['33%', 'cover: energy reduced gauge'],
  ['44%', 'cover: EUI gauge'],
  ['55%', 'cover: contract progress gauge'],
  ['$8,901', 'cover: printed Q1 target'],
  ['4.4%', 'cover: Alpha percent'],
  ['845,123 kWh', 'cover: kWh avoided finding'],
  ['12,321 therms', 'cover: therms finding'],
].forEach(([s, m]) => assert(has(cover, s), '4: ' + m + ' (' + s + ')'));
const fin = ev('rptPageFinancial(3, __d)');
[
  fmt(123456),
  '$91,111',
  '$81,111',
  '$71,111',
  '$4,111',
  '4.4%',
  'Near Target',
  fmt(191346),
  '$183,333',
  '$163,333',
  '$143,333',
  '$6,333',
  '3.3%',
  fmt(5550001),
  fmt(5440002),
  fmt(66603),
  fmt(55504),
  fmt(3305),
  fmt(2206),
  '$25,333',
  '$76,999',
  '$3,800',
  '$15,200',
  '$46,199',
  '$2,533',
  '$10,133',
  '$30,800',
].forEach((s) => assert(has(fin, s), '4: financial summary shows ' + s));
const sp = ev('rptPageSavingsPerformance(5, __d)').html;
[
  '$30,001',
  '$20,001',
  '$30,003',
  '$20,003',
  fmt(4321),
  fmt(4123),
  '61.5',
  '51.6',
  fmt(111111),
  fmt(2222),
  '77.7',
  '66.6',
  '13.4%',
  '37.5%',
  fmt(222222),
  '88.8',
  '55.5',
  fmt(200002),
  '$72,222',
].forEach((s) => assert(has(sp, s), '4: savings performance shows ' + s));
const env = ev('rptPageEnvironmentalImpact(7, __d)');
[fmt(987654), fmt(76543), fmt(23456), fmt(34567), fmt(845123), fmt(12321)].forEach((s) =>
  assert(has(env, s), '4: environmental shows ' + s),
);
const obs = ev('rptPageObservations(8, __d)');
[
  '4.4% savings ($4,111 saved)',
  '2.2% savings ($2,222 saved)',
  'Gas is the strongest performer. Electric is the weakest performer',
  'Electric is the primary commodity',
  '1789',
  '2233',
  '(-19%)',
  '103',
  '(+129%)',
].forEach((s) => assert(has(obs, s), '4: observations shows ' + s));
const eui = ev('rptPageEUI(32, __d)').html;
['31.1', '22.2', '-54.2%', '$0.61', '41.1', '32.2', '-33.6%', '$0.73', '28.6%', '21.7%', 'Top 25%', '25-50th'].forEach(
  (s) => assert(has(eui, s), '4: EUI shows ' + s),
);
const cp = ev('rptPageContractProjection(35, __d)');
[
  '$8,901',
  '$12,402',
  '$28,403',
  '$8,404',
  '$58,110',
  '$3,561',
  '$23,244',
  '$5,341',
  '$34,866',
  '(71%)',
  '$57,001',
  '$34,201',
  '$22,800',
  '$60,002',
  '$63,003',
  '$180,006',
  '$108,004',
  '$72,002',
  'Annual: $58,110',
].forEach((s) => assert(has(cp, s), '4: contract projection shows ' + s));
const wx = ev('rptPageAppendixWeather(47, __d, "C")').html;
['1,111', '1,222', '1,333', '5,432', '1,789', '103', '-67.7%', '130.1%', '2,233', '(-19%)', '(+129%)'].forEach((s) =>
  assert(has(wx, s), '4: weather appendix shows ' + s),
);

// ---- 5. meter table shows the printed cells; unprinted cells keep the current math --------------------
function meterHtml(printed) {
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push({
      start: '2024-' + String(m).padStart(2, '0') + '-01',
      end: '2024-' + String(m).padStart(2, '0') + '-28',
      naturalGasTherms: '100',
      gasCharge: '100',
      totalGasRate: '1.00000',
      totalCost: '110',
    });
  for (let m = 1; m <= 3; m++)
    bills.push({
      start: '2026-' + String(m).padStart(2, '0') + '-01',
      end: '2026-' + String(m).padStart(2, '0') + '-28',
      naturalGasTherms: '50',
      gasCharge: '50',
      totalGasRate: '1.00000',
      totalCost: '55',
    });
  sb.__meter = {
    id: 'g1',
    commodity: 'Gas',
    inclusive: true,
    bills,
    baseline: { months: Array.from({ length: 12 }, (_, i) => '2024-' + String(i + 1).padStart(2, '0')) },
  };
  sb.__printedFn = printed;
  return ev(
    'buildMeterPerfTableHTML(__meter, __meter.bills, true, {mode:"report", projId:7, bldgId:"b1", filterYMs:' +
      JSON.stringify(Q1) +
      ', printed: __printedFn})',
  );
}
ev(
  'var projects = [{ id: 7, sa: "SA-1" }]; var udSelProjId = 7; function getWeatherForBuilding(){ return { byYm: null, cache: [] }; } function getUDBldg(){ return { id: "b1", meters: [] }; }',
);
const cur = meterHtml(undefined);
const prt = meterHtml(ev('rptPrintedMeterCells(__dA, "b1", "Gas")'.replace('__dA', '__d')));
assert(
  prt.html.includes('999') && prt.html.includes('1,111') && prt.html.includes('$87.12') && prt.html.includes('0.7771'),
  '5: printed month row (actual 999, baseline 1,111, cost $87.12, price 0.7771)',
);
assert(
  prt.html.includes('3,333') &&
    prt.html.includes('1,554') &&
    prt.html.includes('1,779') &&
    prt.html.includes('53.4%') &&
    prt.html.includes('$1,382.75'),
  '5: printed total row',
);
assert(prt.html.includes('4,444'), '5: a single printed cell (March saved 4,444) replaces only that cell');
assert(
  !cur.html.includes('4,444') && !cur.html.includes('1,111'),
  '5: without printed figures the table is the current math',
);
assert(
  ev('rptPrintedMeterCells(__d, "b1", "Electric")') === undefined,
  '5: no printed table for a commodity the document did not print',
);

// ---- 6. observations of a presented period repeat the building's printed savings when the document has no observation figure ----
const dObs = mkD();
Object.keys(dObs.printed)
  .filter((k) => k.indexOf('observations|') === 0)
  .forEach((k) => delete dObs.printed[k]);
sb.__dObs = dObs;
ev('rptApplyPrintedToData(__dObs)');
const obs2 = ev('rptPageObservations(8, __dObs)');
assert(has(obs2, '4.4% savings ($4,111 saved)') && has(obs2, '2.2% savings ($2,222 saved)'), '6: observation text uses the printed building savings and percent');

console.log('presented printed values: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
