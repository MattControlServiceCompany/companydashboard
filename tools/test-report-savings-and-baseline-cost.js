// tools/test-report-savings-and-baseline-cost.js - SYNTHETIC data only. Run: node tools/test-report-savings-and-baseline-cost.js
// Matt 2026-11-06: savings = (2025 use - 2026 use) x 2026 rate, month by month, then added. Cost never enters savings.
// The baseline cost is the 2025 cost of the baseline months (2025 use x 2025 rate), a display figure only.
//   (a) savings do not move when the 2025 bill costs change (they use no 2025 cost and no 2025 rate), and gas and
//       propane savings equal (baseline use - actual use) x the rate of the 2026 month, for each month, building, total;
//   (b) the baseline cost of each month = the cost of the baseline-year bills of that calendar month, and it moves with them.
// No year is written in the checks: "baseline month" and "current month". The whole run repeats with every date moved
// two years later (baseline month and current month both), and must give the same result.

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
function propaneBills() {
  // one delivery a month, 2024-01 .. 2025-03, 100 gal at $2.00 a gallon
  const bills = [];
  for (let y = 2024; y <= 2025; y++)
    for (let mo = 1; mo <= 12; mo++) {
      if (y === 2025 && mo > 3) break;
      const ym = y + '-' + String(mo).padStart(2, '0');
      const last = new Date(y, mo, 0).getDate();
      bills.push({ id: 'prop' + ym, start: ym + '-01', end: ym + '-' + last, gallonsDelivered: 100, totalCost: 200 });
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
// mB1 bills are charged 60 kW while the meter measured 50 kW (billed demand above measured, as a minimum-demand charge)
const mB1 = meter('mB1', 'Electric', 8000);
mB1.bills.forEach((b) => (b.billedKW = 60));
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
      {
        id: 'bB',
        name: 'Beta Building',
        sqft: 30000,
        // a propane meter with a baseline and no delivery in Q2 2025 (deliveries stop after 2025-03; the other meters have bills to 2025-06)
        meters: [mB1, meter('mB2', 'Propane', 100, { bills: propaneBills() })],
      },
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


const BASE_JSON = JSON.stringify(fixture);

const fuels = ['electric', 'gas', 'propane'];
const loadFixture = (shiftYears, costFactor) => {
  const j = JSON.parse(BASE_JSON.replace(/\b(20\d\d)(-\d\d)/g, (m, y, r) => Number(y) + shiftYears + r));
  const pj = j['en_projects'][0];
  pj.contractType = 'sharedSavings';
  pj.cscCompensation = 60;
  j['en_utility_' + PROJ].buildings.forEach((b) =>
    b.meters.forEach((m) => m.bills.forEach((bl) => { if (m.baseline.months.indexOf(bl.start.slice(0, 7)) >= 0) bl.totalCost *= costFactor; })),
  );
  Object.keys(fixture).forEach((k) => delete fixture[k]);
  Object.assign(fixture, j);
};
const baseYear = Number(BASE_JSON.match(/"baseline":\{"months":\["(\d{4})/)[1]);
const eachMonth = (d, fn) => d.buildings.forEach((b) => fuels.forEach((k) => ((b[k] && b[k].monthly) || []).filter((m) => d.period.yearMonths.indexOf(m.month) >= 0).forEach((m) => fn(b, k, m))));
const baseCost = (c, b, k, calMo) => {
  const com = k === 'electric' ? 'Electric' : k === 'gas' ? 'Gas' : 'Propane';
  return run(c, '(function(){var ub=getUDBldg(' + PROJ + ',"' + b.id + '");var t=0;ub.meters.forEach(function(m){if(m.commodity!=="' + com + '"||m.baselineInclude===false)return;(m.baseline.months||[]).forEach(function(ym){if(ym.slice(5,7)!=="' + calMo + '")return;(m.bills||[]).forEach(function(bl){if(billMonth(bl,m.bills)!==ym)return;t+=parseFloat(bl.totalCost)||0;});});});return t;})()');
};
let nonZero = 0;
[0, 2].forEach((shift) => {
  loadFixture(shift, 1);
  const ctxA = buildCtx();
  const A = [1, 2].map((q) => run(ctxA, 'collectReportData(' + PROJ + ',null,null,"quarterly",' + JSON.stringify({ quarter: q, year: baseYear + 1 + shift }) + ',null)'));
  loadFixture(shift, 3);
  const ctxB = buildCtx();
  const B = [1, 2].map((q) => run(ctxB, 'collectReportData(' + PROJ + ',null,null,"quarterly",' + JSON.stringify({ quarter: q, year: baseYear + 1 + shift }) + ',null)'));
  const tag = ' [dates moved ' + shift + ' years]';
  [0, 1].forEach((i) => {
    const a = A[i], b2 = B[i];
    console.log('\n--- (a) savings use no baseline-month cost and no baseline-month rate: Q' + (i + 1) + tag + ' ---');
    let n = 0;
    eachMonth(a, (b, k, m) => {
      const mb = b2.buildings.find((x) => x.id === b.id)[k].monthly.find((x) => x.month === m.month);
      n++;
      if (Math.abs(m.savings) > 0.005) nonZero++;
      assert(Math.abs(m.savings - mb.savings) <= 0.005, b.name + ' ' + k + ' ' + m.month + ': savings ' + m.savings.toFixed(2) + ' unchanged when baseline bill costs x3 (' + mb.savings.toFixed(2) + ')');
      if (k !== 'electric' && m.cur > 0) {
        const want = (m.bl - m.cur) * (m.curCost / m.cur);
        assert(Math.abs(m.savings - want) <= 0.01, b.name + ' ' + k + ' ' + m.month + ': savings ' + m.savings.toFixed(2) + ' = (baseline use ' + m.bl.toFixed(1) + ' - current use ' + m.cur.toFixed(1) + ') x current-month rate ' + (m.curCost / m.cur).toFixed(4));
      }
    });
    a.buildings.forEach((b) => {
      const mo = [];
      fuels.forEach((k) => ((b[k] && b[k].monthly) || []).filter((m) => a.period.yearMonths.indexOf(m.month) >= 0).forEach((m) => mo.push(m.savings)));
      assert(Math.abs(mo.reduce((s, v) => s + v, 0) - b.savings) <= 0.01, b.name + ': the monthly savings add to the building savings ' + b.savings.toFixed(2));
      assert(Math.abs(b.savings - b2.buildings.find((x) => x.id === b.id).savings) <= 0.005, b.name + ': building savings unchanged when baseline bill costs x3');
    });
    assert(Math.abs(a.buildings.reduce((s, b) => s + b.savings, 0) - b2.buildings.reduce((s, b) => s + b.savings, 0)) <= 0.005, 'total savings unchanged when baseline bill costs x3');
    assert(n > 0, 'months checked: ' + n);
  });
  console.log('\n--- (b) baseline cost = cost of the baseline-month bills of that calendar month' + tag + ' ---');
  // Propane has its own baseline-cost rule (delivery based); it is checked only for the sum rule below.
  [[ctxA, A], [ctxB, B]].forEach(([c, set], ci) => {
    set.forEach((d, i) => {
      let n = 0, bad = 0;
      eachMonth(d, (b, k, m) => {
        if (k === 'propane') return;
        const want = k === 'gas' ? baseCost(c, b, k, m.month.slice(5, 7)) : null;
        if (want == null) return;
        n++;
        if (Math.abs(m.blCost - want) > 0.01) { bad++; console.log('  FAIL ' + b.name + ' ' + k + ' ' + m.month + ': baseline cost ' + m.blCost + ' vs baseline-month bills ' + want); }
      });
      assert(bad === 0 && n > 0, (ci ? 'baseline costs x3, ' : '') + 'Q' + (i + 1) + ': gas baseline cost of every month = the baseline-month bill cost (' + n + ' building-months)');
      d.buildings.forEach((b) => assert(Math.abs(b.blCost - fuels.reduce((s, k) => s + (b[k] ? b[k].monthly.filter((m) => d.period.yearMonths.indexOf(m.month) >= 0).reduce((t, m) => t + m.blCost, 0) : 0), 0)) <= 0.01, b.name + ': building baseline cost = its months added'));
      assert(Math.abs(d.totals.blCost - d.buildings.reduce((s, b) => s + b.blCost, 0)) <= 0.01, 'Q' + (i + 1) + ': total baseline cost = the buildings added');
    });
  });
  const sumBl = (set) => set[1].buildings.reduce((s, b) => s + b.gas.costBl, 0);
  assert(sumBl(B) > 2.9 * sumBl(A) && sumBl(B) < 3.1 * sumBl(A), 'the displayed baseline cost follows the baseline-month bills (x3 in, x3 out)');
});
assert(nonZero > 0, 'the fixture has months with savings other than $0 (' + nonZero + ')');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
