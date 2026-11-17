// tools/test-report-target-split.js - the Financial page prints each building target from ONE rule. SYNTHETIC data only.
// Run: node tools/test-report-target-split.js
// The "Target Cost" cell of a building = baseline cost - allocateTargetByBaselineCost(quarter target, baseline costs)[building].
// The whole-dollar targets add exactly to the quarter target (the total row).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.env.APP_ROOT || path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok   ' + msg);
  } else {
    failed++;
    console.log('  FAIL ' + msg);
  }
}
function bh() {
  const t = function () {};
  return new Proxy(t, {
    get(o, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (!(p in o)) o[p] = bh();
      return o[p];
    },
    apply() {
      return bh();
    },
    construct() {
      return bh();
    },
  });
}
const sb = {};
Object.assign(sb, {
  console,
  global: sb,
  globalThis: sb,
  window: sb,
  document: bh(),
  navigator: {},
  fetch: () => Promise.reject(new Error('fetch disabled')),
  CustomEvent: class {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  location: { href: 'file:///gate', search: '', pathname: '/gate' },
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  performance: { now: () => Date.now() },
  crypto: require('crypto').webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  showToast: () => {},
  _mkbh: bh,
});
const store = new Map();
sb.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => Array.from(store.keys())[i] || null,
  get length() {
    return store.size;
  },
};
sb.DB = { get: (k, d) => d, set: () => Promise.resolve(), isReady: () => true };
const ctx = vm.createContext(sb);
[
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/perf-table.js',
  'computations/regression.js',
  'computations/physics.js',
  'computations/rates.js',
  'computations/normalization.js',
  'computations/savings.js',
  'computations/report-data.js',
  'computations/eui.js',
  'computations/csc.js',
  'computations/pollution.js',
  'computations/weather-refresh.js',
  'computations/hvac-enduse.js',
  'app/scope-tree.js',
  'app/utility-data.js',
  'app/core.js',
  'app/data/bas-weather-bins.js',
  'app/calculators.js',
  'app/energy-savings.js',
  'app/report-engine.js',
  'app/report-printed.js',
  'app/presented-savings.js',
  'app/equipment-matrix.js',
].forEach((rel) => new vm.Script(fs.readFileSync(path.join(REPO, rel), 'utf8'), { filename: rel }).runInContext(ctx));
function run(src) {
  for (let i = 0; i < 80; i++) {
    try {
      return new vm.Script(src, { filename: 'run' }).runInContext(ctx);
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      new vm.Script(m[1] + ' = _mkbh();').runInContext(ctx);
    }
  }
  throw new Error('too many stubs');
}
run('rptPage = function (n, t, body) { return body; }'); // the page body only, no page chrome

// three buildings, whole-dollar baseline costs whose exact target shares are not whole dollars; quarter target 1000
const COSTS = [3333, 4444, 2223];
const TARGET = 1000;
function pageData() {
  const mon = (ym, sav) => ({ month: ym, blCost: 1000, curCost: 1000 - sav, savings: sav, bl: 100, cur: 100 });
  const com = { monthly: [0.4, 0.4, 0.4].map((v, i) => mon('2026-0' + (7 + i), v)), kwhBl: 300, kwhCur: 300, kwBl: 30, kwCur: 30, thermsBl: 0, thermsCur: 0, costSaved: 0 };
  const bld = (id, c) => ({
    id, name: 'Building ' + id, sqft: 10000, status: 'ok', savings: 1.2, savingsPct: 0.1, blCost: c, curCost: c, pctBase: c,
    electric: com, gas: null, propane: null, eui: { baseline: 50, current: 48, cbecs: 60 }, euiQ: { baseline: 10, current: 11 }, meterDetails: [],
  });
  return {
    period: { type: 'quarterly', quarter: 3, year: 2026, label: 'July 2026 through September 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
    project: { client: 'Test Client', name: 'Test Project', sqft: 30000 },
    contract: { quarterlyTargets: [TARGET, TARGET, TARGET, TARGET], quarterlyActuals: [0, 0, 0], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3.5, annualTarget: 4000, actualsThroughQuarter: 3 },
    totals: { euiBaselineQ: 10, euiCurrentQ: 11, savings: 0, shortfallNotBilled: 0, blCost: COSTS.reduce((s, v) => s + v, 0), pctBase: 10000, curCost: 10000, kwhBl: 900, kwhCur: 900, thermsBl: 0, thermsCur: 0, peakKwBl: 90, peakKwCur: 90, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Jan 2026 to Sep 2026', cumulativeSavings: 0, weatherWaiting: [] },
    buildings: [bld('A', COSTS[0]), bld('B', COSTS[1]), bld('C', COSTS[2])],
    weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
    rawBills: [],
  };
}
const owner = run('allocateTargetByBaselineCost')(TARGET, COSTS);
assert(owner.reduce((s, v) => s + v, 0) === TARGET && owner.every(Number.isInteger), 'owner function: whole dollars that add to the target: ' + owner.join('+'));
// a quarter not yet presented (no d.printed): target cost = baseline cost - owner target, rows apportioned to the rounded total
const html = run('rptPageFinancial')(3, pageData());
const cellsOf = (tr) => tr.split('</td>').map((c) => c.replace(/<[^>]+>/g, '').trim());
const money = (s) => Number(String(s).replace(/[$,]/g, ''));
const rows = html.split('<tr>').slice(1).map(cellsOf);
const bRows = rows.filter((r) => /^Building [ABC]$/.test(r[0]));
assert(bRows.length === 3, 'the page prints the three building rows');
const printed = bRows.map((r) => money(r[3]));
const expected = COSTS.map((c, i) => Math.round(c) - owner[i]);
const totCells = cellsOf(html.split('<tr class="rpt-tot">')[1]);
assert(printed.join() === expected.join(), 'building target cost = baseline cost - owner target: printed ' + printed.join('+') + ', expected ' + expected.join('+'));
assert(printed.reduce((s, v) => s + v, 0) === money(totCells[3]), 'building target costs add to the total row: ' + printed.reduce((s, v) => s + v, 0) + ' = ' + totCells[3]);
const targetsOut = printed.map((v, i) => Math.round(COSTS[i]) - v);
assert(targetsOut.join() === owner.join() && targetsOut.reduce((s, v) => s + v, 0) === TARGET, 'per-building targets (baseline - target cost) equal the owner output and add to ' + TARGET + ': ' + targetsOut.join('+'));
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
