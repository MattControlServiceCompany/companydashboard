// tools/test-scope-tree-report-filter.js — building/meter selection on report outputs (item 5e60fae2).
// Run: node tools/test-scope-tree-report-filter.js
//
// Loads the REAL app files into a Node vm sandbox (same pattern as test-baseline-savings-report.js)
// seeded with a SYNTHETIC project (fake names, round numbers — never client data) and proves:
//   A. collectReportData(meterIds): unchecking ONE meter removes exactly that meter's usage from
//      the report totals (kWh current / baseline, and the Building Baseline Data table input),
//      and nothing else changes.
//   B. Every eligible meter checked == no meterIds at all == today's building-only path.
//      An excluded meter (baselineInclude:false) never enters, even when its id is passed.
//   C. collectASHRAE36Data(buildingNames): one building selected => only that building's rows.
//   D. scopeTreeHTML (shared picker): default checks follow _rptMeterEligible, ineligible rows are
//      disabled with a reason, meter rows carry data-bid for the config reader.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
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
const near = (a, b) => Math.abs(a - b) < 1e-6;

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
  sandbox.DB = { get: (k, d) => d, set: () => Promise.resolve(), isReady: () => true };
  const ctx = vm.createContext(sandbox);
  const load = (rel) =>
    new vm.Script(fs.readFileSync(path.join(REPO, rel), 'utf8'), { filename: rel }).runInContext(ctx);
  [
    'lib/date-helpers.js',
    'computations/regression.js',
    'computations/rates.js',
    'computations/normalization.js',
    'computations/savings.js',
    'computations/eui.js',
    'computations/hvac-enduse.js',
    'app/scope-tree.js',
    'app/utility-data.js',
    'app/core.js',
    'app/calculators.js',
    'app/energy-savings.js',
    'app/report-engine.js',
    'app/equipment-matrix.js',
  ].forEach(load);
  run(
    ctx,
    `projects = JSON.parse(localStorage.getItem('en_projects')) || []; projects.forEach(function(p){ var ud = JSON.parse(localStorage.getItem('en_utility_' + p.id) || 'null'); if (ud) utilityData[p.id] = ud; });`,
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
const collect = (meterIds, buildingIds) =>
  run(
    ctx,
    'collectReportData(' +
      PROJ +
      ',' +
      JSON.stringify(buildingIds || null) +
      ",null,'cumulative',null," +
      JSON.stringify(meterIds || null) +
      ')',
  );
// Sum of one synthetic meter's usage over the report's own period months.
function meterUsage(mid, yms) {
  const b = fixture['en_utility_' + PROJ].buildings.find((x) => x.meters.some((m) => m.id === mid));
  const m = b.meters.find((x) => x.id === mid);
  return m.bills
    .filter((bl) => yms.includes(bl.start.slice(0, 7)))
    .reduce((s, bl) => s + (parseFloat(bl.kwh) || parseFloat(bl.therms) || 0), 0);
}
function meterBaseline(mid) {
  return meterUsage(mid, BL_MONTHS);
}

// ─── A. Unchecking one meter removes exactly that meter ───────────────────────
console.log('\n--- A. meterIds filter: drop mA1 only ---');
const full = collect(null);
assert(full && full.buildings.length === 2, 'full report has both buildings');
const yms = full.period.yearMonths;
assert(yms.length === 6 && yms[0] === '2025-01', 'period = the 6 post-baseline months (' + yms.join(',') + ')');
const noA1 = collect(['mA2', 'mB1']);
assert(noA1 && noA1.buildings.length === 2, 'Alpha still present (its Gas meter is checked)');
const alphaFull = full.buildings.find((b) => b.id === 'bA');
const alphaNoA1 = noA1.buildings.find((b) => b.id === 'bA');
assert(
  JSON.stringify(alphaFull.meterIds) === JSON.stringify(['mA1', 'mA2']) &&
    JSON.stringify(alphaNoA1.meterIds) === JSON.stringify(['mA2']),
  'building record meterIds: [mA1,mA2] -> [mA2]',
);
assert(
  near(full.totals.kwhCur - noA1.totals.kwhCur, meterUsage('mA1', yms)),
  'totals.kwhCur drops by exactly mA1 period kWh (' + meterUsage('mA1', yms) + ')',
);
// Baseline kWh for the period = the baseline-year usage of the same calendar months (Jan..Jun 2024).
const blSameMonths = meterUsage(
  'mA1',
  yms.map((ym) => '2024-' + ym.slice(5)),
);
assert(
  near(full.totals.kwhBl - noA1.totals.kwhBl, blSameMonths),
  'totals.kwhBl drops by exactly mA1 baseline kWh for the same calendar months (' +
    blSameMonths +
    ', actual ' +
    (full.totals.kwhBl - noA1.totals.kwhBl) +
    ')',
);
assert(near(full.totals.thermsCur, noA1.totals.thermsCur), 'therms unchanged (Gas meter untouched)');
assert(
  near(alphaNoA1.electric.kwhCur, 0),
  'Alpha electric current kWh is 0 with its only eligible electric meter unchecked',
);
assert(
  Object.keys(alphaNoA1.baselineMaps.elecByMo).length === 0 &&
    Object.keys(alphaNoA1.baselineMaps.gasByMo).length === 12,
  'Building Baseline Data table input (baselineMaps): no electric months, 12 gas months',
);
assert(
  noA1.rawBills.every((r) => r.account !== 'A-mA1') && full.rawBills.some((r) => r.account === 'A-mA1'),
  'Appendix D raw bills exclude the unchecked meter',
);
const betaOnlyMeters = collect(['mB1']);
assert(
  betaOnlyMeters && betaOnlyMeters.buildings.length === 1 && betaOnlyMeters.buildings[0].id === 'bB',
  'a building with none of its meters checked drops out entirely',
);

// ─── B. All eligible checked == today's totals; excluded meter never enters ───
console.log('\n--- B. all-checked == no-filter; excluded meter cannot be forced in ---');
const allChecked = collect(['mA1', 'mA2', 'mB1']);
const bldgOnly = collect(null, ['bA', 'bB']);
const strip = (d) => JSON.stringify({ t: d.totals, b: d.buildings.map((b) => [b.id, b.meterIds, b.electric, b.gas]) });
assert(strip(allChecked) === strip(full), 'meterIds=[every eligible meter] == meterIds=null');
assert(strip(bldgOnly) === strip(full), 'buildingIds-only path (pre-tree callers) == meterIds=null');
const forced = collect(['mA1', 'mA2', 'mA3', 'mB1']);
assert(
  strip(forced) === strip(full) && !forced.buildings.some((b) => b.meterIds.includes('mA3')),
  'baselineInclude:false meter (mA3) never enters even when its id is passed',
);
assert(
  run(ctx, '_rptMeterEligible(' + PROJ + ", {baselineInclude:false, commodity:'Electric'})") ===
    'excluded on Utility Data' && run(ctx, '_rptMeterEligible(' + PROJ + ", {commodity:'Electric'})") === '',
  '_rptMeterEligible: excluded -> reason string, eligible -> empty',
);

// ─── C. ASHRAE 36 building filter ─────────────────────────────────────────────
console.log('\n--- C. collectASHRAE36Data(buildingNames) ---');
const a36All = run(ctx, 'collectASHRAE36Data(' + PROJ + ', null, null)');
const a36Alpha = run(ctx, 'collectASHRAE36Data(' + PROJ + ", null, ['Alpha Building'])");
const names = (d) => (d && d.buildings ? d.buildings.map((b) => b.name).sort() : null);
assert(
  JSON.stringify(names(a36All)) === JSON.stringify(['Alpha Building', 'Beta Building']),
  'no filter -> both buildings',
);
assert(JSON.stringify(names(a36Alpha)) === JSON.stringify(['Alpha Building']), '1 building -> only that building');
assert(
  a36Alpha.buildings[0].equipCount === 2 && a36All.portfolio.totalEquip === 3 && a36Alpha.portfolio.totalEquip === 2,
  'equipment counts follow the filter (2 of 3)',
);
assert(
  run(ctx, 'collectASHRAE36Data(' + PROJ + ", null, ['No Such Building'])") === null,
  'unknown building -> null (nothing to report)',
);

// ─── D. Shared picker HTML (pure string builder) ──────────────────────────────
console.log('\n--- D. scopeTreeHTML via _rptV2ScopeNodes ---');
const treeHtml = run(ctx, 'scopeTreeHTML(_rptV2ScopeNodes(' + PROJ + ', getUDBldgs(' + PROJ + ')))');
const cbs = treeHtml.match(/<input type="checkbox" class="st-cb"[^>]*>/g) || [];
const byId = {};
cbs.forEach((s) => {
  byId[/data-id="([^"]*)"/.exec(s)[1]] = s;
});
assert(cbs.length === 6, '2 building rows + 4 meter rows rendered (' + cbs.length + ')');
assert(
  / checked/.test(byId.mA1) && / checked/.test(byId.mA2) && / checked/.test(byId.mB1),
  'eligible meters checked by default',
);
assert(/ disabled/.test(byId.mA3) && !/ checked/.test(byId.mA3), 'excluded meter rendered disabled + unchecked');
assert(treeHtml.includes('excluded on Utility Data'), 'disabled row shows the reason');
assert(
  /data-bid="bA"/.test(byId.mA1) && /data-kind="meter"/.test(byId.mA1),
  'meter rows carry data-kind=meter and data-bid',
);
assert(
  /data-kind="bldg"/.test(byId.bA) && / checked/.test(byId.bA),
  'building row is kind=bldg and checked (has eligible meters)',
);
assert(treeHtml.includes('Electric · Acct A-mA1 · Meter M-mA1'), 'meter label = meterLabel()');
const a36Tree = run(ctx, 'scopeTreeHTML(_a36ScopeNodes(' + PROJ + '))');
assert(
  (a36Tree.match(/data-kind="bldg"/g) || []).length === 2 &&
    a36Tree.includes('2 equipment') &&
    a36Tree.includes('data-id="Alpha Building" checked'),
  'ASHRAE tree: one checked row per building name with equipment count',
);

console.log('\n=== scope-tree report filter gate: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
