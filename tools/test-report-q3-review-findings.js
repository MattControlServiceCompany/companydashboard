// tools/test-report-q3-review-findings.js — quarterly report review findings (Matt, 2026-11-02). SYNTHETIC data only.
// Run: node tools/test-report-q3-review-findings.js
//   1. "Savings billed to date" is the sum of the quarter actuals on the cover, the compensation table and
//      the contract table (one value); the 60/40 split follows it.
//   2. Rounding: building targets add to the total, month cells add to the quarter, one rule (_rptApportion).
//   3. EUI period ends at the report quarter end, not at the newest bill month.
//   4. Percent denominator = amount billed + savings, stated in the page note.
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

// ─── Synthetic fixture ─────────────────────────────────────────────────────────
const PROJ = 900001;
function monthlyBills(kwhOrTherms, isElec) {
  // 2024-01 .. 2025-06, one whole-month bill each; usage = base + month index so months differ.
  const bills = [];
  let i = 0;
  for (let y = 2024; y <= 2025; y++) {
    for (let mo = 1; mo <= 12; mo++) {
      if (y === 2025 && mo > 6) break;
      const ym = y + '-' + String(mo).padStart(2, '0');
      const last = new Date(y, mo, 0).getDate();
      const usage = kwhOrTherms + i * 10;
      const b = { id: 'bill' + ym + kwhOrTherms, start: ym + '-01', end: ym + '-' + last, totalCost: usage * 0.1 };
      if (isElec) {
        b.kwh = usage;
        b.demandKW = 50;
      } else b.therms = usage;
      bills.push(b);
      i++;
    }
  }
  return bills;
}
const BL_MONTHS = [];
for (let mo = 1; mo <= 12; mo++) BL_MONTHS.push('2024-' + String(mo).padStart(2, '0'));
const meter = (id, commodity, base, extra) =>
  Object.assign(
    {
      id,
      commodity,
      account: 'A-' + id,
      meter: 'M-' + id,
      bills: monthlyBills(base, commodity === 'Electric'),
      baseline: { months: BL_MONTHS.slice() },
      inclusive: false,
    },
    extra || {},
  );
const fixture = {
  en_projects: [
    { id: PROJ, name: 'Synthetic District', client: 'Synthetic District', type: 'K-12', start: '2025-01-01' },
  ],
  ['en_utility_' + PROJ]: {
    buildings: [
      {
        id: 'bA',
        name: 'Alpha Building',
        sqft: 50000,
        meters: [
          meter('mA1', 'Electric', 10000),
          meter('mA2', 'Gas', 1000),
          meter('mA3', 'Electric', 5000, { baselineInclude: false }), // excluded on Utility Data
        ],
      },
      { id: 'bB', name: 'Beta Building', sqft: 30000, meters: [meter('mB1', 'Electric', 8000)] },
    ],
  },
  ['en_eqmatrix_' + PROJ]: {
    rows: [
      { id: 'r1', building: 'Alpha Building', category: 'ahu', equipName: 'AHU-1', points: [] },
      { id: 'r2', building: 'Alpha Building', category: 'vav', equipName: 'VAV-101', points: [] },
      { id: 'r3', building: 'Beta Building', category: 'ahu', equipName: 'AHU-2', points: [] },
    ],
    importedAt: null,
    buildings: ['Alpha Building', 'Beta Building'],
  },
};

// ─── vm sandbox (black-hole proxy for DOM) ─────────────────────────────────────
function makeBlackHole() {
  const t = function () {};
  return new Proxy(t, {
    get(o, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (!(p in o)) o[p] = makeBlackHole();
      return o[p];
    },
    apply() {
      return makeBlackHole();
    },
    construct() {
      return makeBlackHole();
    },
  });
}
function buildCtx() {
  const sandbox = {};
  sandbox.console = console;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = makeBlackHole();
  sandbox.navigator = {};
  sandbox.fetch = () => Promise.reject(new Error('fetch disabled'));
  sandbox.CustomEvent = class {
    constructor(t, o) {
      this.type = t;
      this.detail = o && o.detail;
    }
  };
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => {};
  sandbox.location = { href: 'file:///gate', search: '', pathname: '/gate' };
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  sandbox.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  sandbox.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  sandbox.performance = { now: () => Date.now() };
  sandbox.crypto = require('crypto').webcrypto;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.URL = URL;
  sandbox.Blob = Blob;
  sandbox.showToast = () => {};
  sandbox._mkbh = makeBlackHole;

  const store = new Map();
  Object.keys(fixture).forEach((k) => store.set(k, JSON.stringify(fixture[k])));
  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() {
      return store.size;
    },
  };
  // Customer/Multi-Project: self-heal WRITES en_projects/en_customers (via sset) as well
  // as reads — a no-op set() silently dropped those writes so a later read never saw
  // them. Persist through to the same store the localStorage stub reads from.
  sandbox.DB = {
    get: (k, d) => d,
    set: (k, v) => {
      store.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
    isReady: () => true,
  };
  const ctx = vm.createContext(sandbox);
  const load = (rel) =>
    new vm.Script(fs.readFileSync(path.join(REPO, rel), 'utf8'), { filename: rel }).runInContext(ctx);
  [
    'lib/date-helpers.js',
    'lib/formatting.js',
    'computations/regression.js',
    'computations/physics.js', 'computations/rates.js',
    'computations/normalization.js',
    'computations/savings.js',
    'computations/report-data.js',
    'computations/eui.js',
    'computations/csc.js',
    'computations/hvac-enduse.js',
    'app/scope-tree.js',
    'app/utility-data.js',
    'app/core.js',
    'app/data/bas-weather-bins.js',
    'app/calculators.js',
    'app/energy-savings.js',
    'app/report-engine.js',
    'app/report-printed.js',
    'app/equipment-matrix.js',
  ].forEach(load);
  // Customer/Multi-Project (2026-09-24): buildings/meters/bills now live per-customer
  // (en_utility_<customerId>) — mirrors loadUtilityData()'s self-heal-then-load sequence
  // without running its OTHER one-time bill-content migrations (rate fixes, dedupe, etc.),
  // which are unrelated to this test and could alter the fixture's numbers.
  run(
    ctx,
    `projects = JSON.parse(localStorage.getItem('en_projects')) || [];
     _selfHealCustomersAndScope();
     projects = JSON.parse(localStorage.getItem('en_projects')) || [];
     (JSON.parse(localStorage.getItem('en_customers')) || []).forEach(function(c){ var ud = JSON.parse(localStorage.getItem('en_utility_' + c.id) || 'null'); if (ud) utilityData[c.id] = ud; });`,
  );
  return ctx;
}
function run(ctx, src) {
  for (let attempts = 0; attempts < 80; attempts++) {
    try {
      return new vm.Script(src, { filename: 'run' }).runInContext(ctx);
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      new vm.Script(m[1] + ' = _mkbh();', { filename: 'stub' }).runInContext(ctx);
    }
  }
  throw new Error('Too many self-heal retries');
}

const ctx = buildCtx();

// ─── 3 + 4. collectReportData on the synthetic project (bills run to 2025-06, baseline 2024) ───
const collectQ = (quarter) =>
  run(ctx, 'collectReportData(' + PROJ + ',null,null,"quarterly",' + JSON.stringify({ quarter, year: 2025 }) + ',null)');
console.log('\n--- 3. EUI period ends at the report quarter end ---');
const q1 = collectQ(1);
assert(/to Mar 2025/.test(q1.totals.euiPeriodLabel), 'Q1 EUI label ends Mar 2025 although bills run to Jun 2025: ' + q1.totals.euiPeriodLabel);
assert(!/Jun 2025/.test(q1.totals.euiPeriodLabel), 'Q1 EUI label names no month after the quarter');
const q2 = collectQ(2);
assert(/to Jun 2025/.test(q2.totals.euiPeriodLabel), 'Q2 EUI label ends Jun 2025: ' + q2.totals.euiPeriodLabel);

console.log('\n--- 4. baseline cost = amount billed + savings ---');
q2.buildings.forEach((b) => {
  const billed = q2.rawBills.filter((r) => r.bid === b.id).reduce((s, r) => s + r.amount, 0);
  assert(Math.abs(b.blCost - (billed + b.savings)) < 1e-6, b.name + ': blCost = billed ' + billed.toFixed(2) + ' + savings ' + b.savings.toFixed(2));
});
assert(Math.abs(q2.totals.blCost - q2.buildings.reduce((s, b) => s + b.blCost, 0)) < 1e-6, 'total blCost = sum of building blCost');

// ─── 1 + 2 + 4 on the page HTML (hand-built d) ───
console.log('\n--- 1, 2, 4. cover and results pages ---');
function pageData() {
  const mon = (ym, sav) => ({ month: ym, blCost: 1000, curCost: 1000 - sav, savings: sav, bl: 100, cur: 100 });
  const com = (savs) => ({ monthly: savs.map((v, i) => mon('2026-0' + (7 + i), v)), kwhBl: 300, kwhCur: 300, kwBl: 30, kwCur: 30, thermsBl: 0, thermsCur: 0, costSaved: 0 });
  // three buildings: months 0.4 + 0.4 + 0.4 each (quarter figure 1.2), baseline-year weights equal
  const bld = (id) => ({
    id, name: 'Building ' + id, sqft: 10000, status: 'ok', savings: 1.2, savingsPct: 0.1, blCost: 1200, targetWeight: 1000,
    electric: com([0.4, 0.4, 0.4]), gas: null, propane: null, eui: { baseline: 50, current: 48, cbecs: 60 }, meterDetails: [],
  });
  return {
    period: { type: 'quarterly', quarter: 3, year: 2026, label: 'July 2026 through September 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
    project: { client: 'Test Client', name: 'Test Project', sqft: 30000 },
    contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [9056, 17892, 0], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3.5, annualTarget: 400, actualsThroughQuarter: 3 },
    // cumulativeSavings is the OLD wrong value: the pages must not print it
    totals: { savings: 0, shortfallNotBilled: 0, blCost: 3600, curCost: 3600, kwhBl: 900, kwhCur: 900, thermsBl: 0, thermsCur: 0, peakKwBl: 90, peakKwCur: 90, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Jan 2026 to Sep 2026 annualized, all fuels', cumulativeSavings: 26968, weatherWaiting: [] },
    buildings: [bld('A'), bld('B'), bld('C')],
    weather: { monthly: [], totals: { cddBl: 0, cddCur: 0 } },
    rawBills: [],
  };
}
run(ctx, 'rptPage = function (n, t, body) { return body; }'); // the page body only, no page chrome
const d = pageData();
const f = run(ctx, '(function(d){ return _rptQFacts(d); })').call(null, d);
assert(f.cumulative === 26948, 'billed to date is the sum of the quarter actuals (26948), not totals.cumulativeSavings: ' + f.cumulative);
const cover = run(ctx, '(function(d,f){ return _rptQCoverPage(1,d,f); })')(d, f).replace(/<[^>]+>/g, ' ');
const results = run(ctx, '(function(d,f){ return _rptQResultsPage(2,d,f); })')(d, f).replace(/<[^>]+>/g, ' ');
const contract = run(ctx, '(function(d,f){ return _rptQContractPage(5,d,f); })')(d, f).replace(/<[^>]+>/g, ' ');
assert(/\$26,948/.test(cover) && !/26,968/.test(cover), 'cover prints $26,948');
assert(/\$26,948/.test(results) && !/26,968/.test(results), 'results page prints $26,948');
assert(/\$26,948/.test(contract), 'contract page prints $26,948');
assert(/\$16,169/.test(results) && /\$10,779/.test(results), 'split is 60% $16,169 and 40% $10,779');
assert(/\$26,948 billed through Q3 2026 plus the \$100 target for the remaining quarters/.test(contract), 'projection basis line printed under the projection table');

const targets = d.buildings.map((b) => run(ctx, '(function(d,b){ return _rptBuildingTarget(d,b); })')(d, b));
assert(targets.reduce((s, v) => s + v, 0) === 100 && targets.every(Number.isInteger), 'building targets are whole dollars that add to the total target: ' + targets.join('+'));
const appt = run(ctx, '_rptApportion')([1.4, 1.4, 1.2], 4);
assert(appt.join(',') === '2,1,1' && appt.reduce((s, v) => s + v, 0) === 4, '_rptApportion adds to the rounded total: ' + appt.join(','));
assert(f.shown.A['2026-07'] + f.shown.A['2026-08'] + f.shown.A['2026-09'] === 1, 'month cells of a building add to its quarter figure (0.4+0.4+0.4 -> 1)');
assert(f.months.reduce((s, m) => s + m.sav, 0) === f.rowsMeasured, 'month totals add to the quarter total (' + f.rowsMeasured + ')');
assert(/billed cost plus savings/.test(results), 'percent note states the denominator');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
