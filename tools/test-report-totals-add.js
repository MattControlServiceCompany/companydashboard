// tools/test-report-totals-add.js - every total row of the quarterly report adds from the rows shown above it (v256).
// SYNTHETIC data only (fractional usage, so a naive Math.round of each row does not add to the rounded total).
// Run: node tools/test-report-totals-add.js
//   1. _rptShownRows / _rptApportion: the one display rule (largest remainder, whole numbers and 0.1 kW).
//   2. The whole generated report: for every table, each total row of a rounded column equals the sum of the rows above it.
//      Exempt columns (named in EXEMPT): percent, rate, average, EUI, days, and exact dollar savings (the savings rule, +/-$1).
//   3. The total keeps its true value: every total printed equals Math.round of the exact sum (never moved to fit the rows).
//   4. The quarter months (8,048 / -5,294 / -9,250 shape) still add to the quarter and the helper is the one source.
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
      const usage = kwhOrTherms + i * 10 + (i % 7) * 0.37 + (kwhOrTherms % 3) * 0.19;
      const b = { id: 'bill' + ym + kwhOrTherms, start: ym + '-01', end: ym + '-' + last, totalCost: usage * 0.1 };
      if (isElec) {
        b.kwh = usage;
        b.demandKW = 50;
        // 2026-11-08: the bill total holds energy lines and other lines; the report cost is the energy lines only
        b.onPeakCost = usage * 0.06;
        b.customerCharge = usage * 0.04;
      } else {
        b.therms = usage;
        b.gasCharge = usage * 0.08;
      }
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
    'lib/perf-table.js',
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


const ctx = buildCtx();
console.log('\n--- 1. the one display rule ---');
const SR = run(ctx, '_rptShownRows');
const eq = (a, b) => JSON.stringify(Array.from(a)) === JSON.stringify(b);
const sum = (a) => Array.from(a).reduce((s, v) => s + v, 0);
assert(eq(SR([0.4, 0.4, 0.4]), [1, 0, 0]), 'three rows of 0.4 print 1,0,0 and add to the rounded total 1');
assert(sum(SR([1.6, 1.6, 1.8])) === 5, 'rows 1.6, 1.6, 1.8 add to 5');
assert(eq(SR([10.04, 10.04, 10.04]), [10, 10, 10]), 'rows that already round to the total keep their own rounding');
const kw = SR([580.66, 582.52, 560.14], 1);
assert(eq(kw, [580.7, 582.5, 560.1]) && Math.abs(sum(kw) - 1723.3) < 1e-9, 'billed kW rows with one decimal add to the one-decimal total: ' + Array.from(kw).join(','));
const MS = run(ctx, '_rptMonthsShown')({ '2026-07': 8047.88, '2026-08': -5293.61, '2026-09': -9249.81 }, 3, -6496);
assert(MS['2026-07'] === 8048 && MS['2026-08'] === -5294 && MS['2026-09'] === -9250, 'quarter months 8,048 / -5,294 / -9,250 add to -6,496 (unchanged by v256): ' + JSON.stringify(MS));

console.log('\n--- 2 + 3. the generated report: total rows add ---');
const collectQ = (quarter) => run(ctx, 'collectReportData(' + PROJ + ',null,null,"quarterly",' + JSON.stringify({ quarter, year: 2025 }) + ',null)');
const q = collectQ(2);
let allHtml = '';
const genAll = run(ctx, '(function(d){ var all = {}; REPORT_SECTIONS.forEach(function (x) { all[x.key] = true; }); return generateReportHTML(d, all); })');
for (let tries = 0; tries < 40 && !allHtml; tries++) {
  try {
    allHtml = genAll(q);
  } catch (e) {
    const m = /^(\w+) is not defined$/.exec(e.message || '');
    if (!m) {
      console.log('ERR ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 4).join(' / '));
      break;
    }
    run(ctx, m[1] + ' = _mkbh();');
  }
}
assert(allHtml.length > 1000, 'the report was generated (' + allHtml.length + ' characters)');
const EXEMPT = /%|\$\/|rate|Average|EUI|median|Percent|Result|Status|Days|Bills|Savings|saved|Use change|Load factor|Cooling|Heating|degree/i;
const cellText = (c) => c.replace(/<[^>]*>/g, '').replace(/&[a-z0-9#]+;/g, ' ').replace(/\s+/g, ' ').trim();
const numOf = (s) => {
  const m = s.replace(/[\u2212\u2013]/g, '-').replace(/[$,\s]|kWh|kW|gal|therms/g, '');
  return /^[+-]?\d+(\.\d+)?$/.test(m) ? { v: parseFloat(m), dp: (m.split('.')[1] || '').length } : null;
};
let checked = 0;
const bad = [];
(allHtml.match(/<table[\s\S]*?<\/table>/g) || []).forEach((t, ti) => {
  const rows = (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => ({
    cls: (r.match(/<tr[^>]*class="([^"]*)"/) || [])[1] || '',
    th: /<th/.test(r),
    cells: (r.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText),
  }));
  const heads = (rows.find((r) => r.th) || { cells: [] }).cells;
  let start = 0;
  rows.forEach((r, i) => {
    if (r.th) {
      start = i + 1;
      return;
    }
    const isTot = /rpt-tot/.test(r.cls) || /^Total$/i.test(r.cells[0] || '');
    if (!isTot) return;
    const prev = rows.slice(start, i);
    start = i + 1;
    if (!prev.length || r.cells.length !== heads.length) return;
    for (let c = 1; c < r.cells.length; c++) {
      if (EXEMPT.test(heads[c])) continue;
      const tv = numOf(r.cells[c]);
      const vals = prev.map((p) => numOf(p.cells[c] || ''));
      if (!tv || vals.some((v) => !v)) continue;
      const dp = Math.max(tv.dp, ...vals.map((v) => v.dp));
      const s = vals.reduce((a, v) => a + v.v, 0);
      checked++;
      if (Math.abs(s - tv.v) > 0.5 * Math.pow(10, -dp)) bad.push('table ' + ti + ' "' + heads[c].replace(/\s+/g, ' ') + '": total ' + r.cells[c] + ' vs rows ' + s.toFixed(dp));
    }
  });
});
assert(checked > 20, 'many total-row columns were checked (' + checked + ')');
assert(bad.length === 0, 'every total row equals the sum of the rows shown' + (bad.length ? ': ' + bad.slice(0, 6).join('; ') : ''));

console.log('\n--- 3. the totals keep their true value ---');
const flat = allHtml.replace(/<[^>]+>/g, ' ');
const nf = (v) => Math.round(v).toLocaleString('en-US');
assert(flat.indexOf(nf(q.totals.kwhBl)) >= 0 && flat.indexOf(nf(q.totals.kwhCur)) >= 0, 'the kWh totals print Math.round of the exact sums (' + nf(q.totals.kwhBl) + ' / ' + nf(q.totals.kwhCur) + ')');
q.buildings.forEach((b) => {
  const e = b.electric;
  if (e && e.monthly && e.monthly.length) assert(flat.indexOf(nf(e.kwhBl)) >= 0 && flat.indexOf(nf(e.kwhCur)) >= 0, b.name + ': the building kWh totals are Math.round of the exact sums (' + nf(e.kwhBl) + ' / ' + nf(e.kwhCur) + ')');
});
assert(flat.indexOf('$' + nf(q.totals.blCost)) >= 0, 'the baseline cost total prints Math.round of the exact sum: $' + nf(q.totals.blCost));
const bl = run(ctx, '(function(d){ return d.buildings.map(function (b) { return _rptBldgCostShown(d, b, "blCost"); }); })')(q);
assert(sum(bl) === Math.round(q.totals.blCost), 'baseline cost by building adds to the total: ' + Array.from(bl).join('+'));

console.log('\n--- 3b. one printed value per figure on every page (v258) ---');
// The registry (_rptShown): portfolio -> buildings -> months, and portfolio -> buildings -> fuels, each level adds to its parent.
const reg = run(ctx, '(function(d){ var R = _rptShown(d); var out = { use: {}, cost: R.cost, ct: R.costTotal }; Object.keys(R.use).forEach(function (k) { out.use[k] = {}; Object.keys(R.use[k]).forEach(function (s) { var o = R.use[k][s]; out.use[k][s] = { total: o.total, b: Object.keys(o.b).map(function (id) { var r = o.b[id]; return { total: r.total, m: Object.keys(r.m).map(function (ym) { return r.m[ym]; }) }; }) }; }); }); return JSON.parse(JSON.stringify(out)); })')(q);
let tiers = 0;
Object.keys(reg.use).forEach((k) =>
  Object.keys(reg.use[k]).forEach((sk) => {
    const o = reg.use[k][sk];
    tiers++;
    assert(sum(o.b.map((r) => r.total)) === o.total, k + ' ' + sk + ': the building figures add to the portfolio figure ' + o.total);
    assert(o.b.every((r) => sum(r.m) === r.total), k + ' ' + sk + ': the months of every building add to its building figure');
  }),
);
assert(tiers >= 4, 'the use series were checked (' + tiers + ')');
['bl', 'cur'].forEach((c) => {
  const ids = Object.keys(reg.cost[c]);
  assert(sum(ids.map((id) => reg.cost[c][id].total)) === reg.ct[c], c + ' cost: the building figures add to the portfolio total $' + reg.ct[c]);
  assert(ids.every((id) => reg.cost[c][id].electric + reg.cost[c][id].gas + reg.cost[c][id].propane === reg.cost[c][id].total), c + ' cost: the fuels of every building add to its building figure');
});
// The printed pages: one value per (building, fuel, series, month) on every page that shows it. A table belongs to the
// building named last before it on its page.
const cellBr = (c) => cellText(c.replace(/<br\s*\/?>/gi, ' '));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const bnames = q.buildings.map((b) => b.name);
const seen = {};
const pagesHtml = allHtml.split(/<div class="rpt-page/).slice(1);
const SERIES = [
  [/^(Electricity baseline \(kWh\)|Baseline kWh)$/i, 'kwh-bl'],
  [/^(Electricity actual \(kWh\)|Actual kWh)$/i, 'kwh-cur'],
  [/^(Natural gas baseline \(therms\)|Baseline therms)$/i, 'th-bl'],
  [/^(Natural gas actual \(therms\)|Actual therms)$/i, 'th-cur'],
  [/^Propane delivered baseline \(gal\)|^Baseline delivered gal$/i, 'gal-bl'],
  [/^Propane delivered actual \(gal\)|^Actual delivered gal$/i, 'gal-cur'],
];
const owner = (before) => {
  const plain = cellBr(before);
  let best = null;
  bnames.forEach((n) => {
    const i = plain.lastIndexOf(n);
    if (i >= 0 && (!best || i > best.i)) best = { n, i };
  });
  return best && best.n;
};
pagesHtml.forEach((pg, pi) => {
  const re = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = re.exec(pg))) {
    const bld = owner(pg.slice(0, m.index));
    if (!bld) continue;
    const rows = (m[0].match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellBr));
    const heads = rows[0] || [];
    rows.slice(1).forEach((r) => {
      const mi = MONTHS.indexOf((r[0] || '').slice(0, 3).toLowerCase());
      if (mi < 0 || !/^[A-Za-z]+( \d{4})?$/.test(r[0])) return;
      heads.forEach((h, c) => {
        const ser = SERIES.filter((x) => x[0].test(h))[0];
        const nv = numOf(r[c] || '');
        if (!ser || !nv) return;
        const key = bld + '|' + ser[1] + '|' + mi;
        (seen[key] = seen[key] || { vals: new Set(), pages: new Set() }).vals.add(nv.v);
        seen[key].pages.add(pi);
      });
    });
  }
});
const keys = Object.keys(seen);
const multi = keys.filter((k) => seen[k].pages.size >= 2);
const diff = keys.filter((k) => seen[k].vals.size > 1);
assert(multi.length >= 6, 'figures shown on two or more pages were compared (' + multi.length + ' of ' + keys.length + ')');
assert(diff.length === 0, 'every figure reads the same on every page' + (diff.length ? ': ' + diff.slice(0, 5).map((k) => k + '=' + Array.from(seen[k].vals).join('/')).join('; ') : ''));
// The cost of a building: the fuel pages add to the building figure of the Financial Summary.
const costByFuel = {};
(allHtml.match(/<table[\s\S]*?<\/table>/g) || []).forEach((t) => {
  const rows = (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellBr));
  const heads = rows[0] || [];
  const ci = heads.findIndex((h) => /^Baseline cost/i.test(h));
  if (ci < 0 || heads[0] !== 'Building') return;
  const isFuel = heads.some((h) => /^(Baseline|Actual) (kWh|therms|delivered)/i.test(h));
  rows.slice(1).forEach((r) => {
    if (bnames.indexOf(r[0]) < 0) return;
    const nv = numOf(r[ci] || '');
    if (!nv) return;
    const e = (costByFuel[r[0]] = costByFuel[r[0]] || { fuel: 0, whole: new Set() });
    if (isFuel) e.fuel += nv.v;
    else e.whole.add(nv.v);
  });
});
const names = Object.keys(costByFuel).filter((n) => costByFuel[n].whole.size > 0);
assert(names.length >= 1, 'a building cost shown on the Financial Summary pages was found (' + names.length + ')');
assert(names.every((n) => costByFuel[n].whole.size === 1), 'the baseline cost of a building is one value on every page');
assert(names.every((n) => costByFuel[n].fuel === 0 || Array.from(costByFuel[n].whole)[0] === costByFuel[n].fuel), 'the baseline cost of a building = the sum of its fuel rows on the fuel pages');

console.log('\n--- 4. the same helper everywhere ---');
const eng = fs.readFileSync(path.join(REPO, 'app/report-engine.js'), 'utf8');
const lib = fs.readFileSync(path.join(REPO, 'lib/perf-table.js'), 'utf8');
assert(/function _rptApportion\(/.test(fs.readFileSync(path.join(REPO, 'lib/formatting.js'), 'utf8')) && !/function _rptApportion\(/.test(eng), '_rptApportion is defined once, in lib/formatting.js');
assert(/_rptShownRows\(/.test(lib) && /_rptShown\(d\)/.test(eng) && (eng.match(/_rptShownUse\(/g) || []).length >= 8, 'the meter tables use _rptShownRows and the report pages print the figures of _rptShown');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
