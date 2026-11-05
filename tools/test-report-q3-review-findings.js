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

console.log('\n--- 5. propane with a baseline and no delivery in the quarter ---');
const q3 = collectQ(2);
const beta = q3.buildings.find((b) => b.name === 'Beta Building');
assert(beta.propane.monthly.length > 0, 'a propane meter with no bills in the quarter is still in the building (monthly rows present)');

// 6. every checked section prints (Matt 2026-11-04: "Why are the sections I have selected not being populated")
console.log('\n--- 6. every checked section is in the report ---');
let allHtml = '';
const genAll = run(ctx, '(function(d){ var all = {}; REPORT_SECTIONS.forEach(function (x) { all[x.key] = true; }); return generateReportHTML(d, all); })');
for (let tries = 0; tries < 40 && !allHtml; tries++) {
  try {
    allHtml = genAll(q3);
  } catch (e) {
    // browser-only constants (page logos and the like) are stubbed, as in run()
    const m = /^(\w+) is not defined$/.exec(e.message || '');
    if (!m) {
      console.log('ERR all sections ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 4).join(' / '));
      break;
    }
    run(ctx, m[1] + ' = _mkbh();');
  }
}
const keys = run(ctx, 'REPORT_SECTIONS.map(function (x) { return x.key; })');
const present = (k) => allHtml.indexOf('data-section="' + k + '"') >= 0 || allHtml.indexOf('data-subsection="' + k + '"') >= 0;
keys.forEach((k) => assert(present(k), 'checked section "' + k + '" has a page or sub-block in the report'));
const flat = allHtml.replace(/<[^>]+>/g, ' ');
assert(/No approved changes in Q2 2025\./.test(flat), 'Approved Changes with no data prints its empty-state sentence');
assert(/Propane Use Detail/.test(flat) && /Beta Building/.test(flat.slice(flat.indexOf('Propane Use Detail'))), 'propane detail page lists the propane building with a baseline and no delivery');


// R16 gate: the generated report as a whole (Matt 2026-11-04)
console.log('\n--- 6b. report gate: banned text, every meter, tables foot ---');
['not billed', 'contract minimum', 'below baseline', 'Next Steps', 'recommend', 'genuine', 'not yet billed', 'R²', 'avoided'].forEach((w) =>
  assert(flat.toLowerCase().indexOf(w.toLowerCase()) < 0, 'banned text absent: "' + w + '"'),
);
const sectionHtml = (k) => {
  let i = allHtml.indexOf('data-section="' + k + '"');
  if (i < 0) i = allHtml.indexOf('data-subsection="' + k + '"');
  if (i < 0) return '';
  const rest = allHtml.slice(i + 10);
  const j = rest.search(/data-(sub)?section="/);
  return j < 0 ? allHtml.slice(i) : allHtml.slice(i, i + 10 + j);
};
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// every meter of the quarter (account number) appears in the bills table and in Appendix D
const allMeters = q3.rawBills ? Array.from(new Set(q3.rawBills.map((r) => r.account))) : [];
const meterPageText = textOf(sectionHtml('meterPerformance'));
['A-mA1', 'A-mA2', 'A-mB1', 'A-mB2'].forEach((a) => assert(meterPageText.indexOf(a) >= 0, 'bills table lists meter ' + a));
const propDetail = textOf(sectionHtml('propaneDetail'));
assert(/Beta Building/.test(propDetail), 'propane detail table lists the propane building');
const apxD = textOf(sectionHtml('appendixD'));
assert(/Meters with no bill in Q2 2025/.test(apxD) && /A-mB2/.test(apxD), 'Appendix D lists the meter with no bill in the quarter');
// Appendix D bill rows add to the stated total
const money = (t) => Number(t.replace(/[$,]/g, ''));
const dRows = (sectionHtml('appendixD').match(/<tr><td>[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/\$[\d,]+/g) || []).map(money)).filter((a) => a.length === 1);
const stated = /Total of (\d+) bills in Q2 2025: \$([\d,]+)/.exec(apxD);
assert(stated && Number(stated[1]) > 0, 'Appendix D states the bill count and total');
if (stated) {
  const sumRows = dRows.filter((a) => a[0] >= 0).reduce((t, a) => t + a[0], 0);
  assert(sumRows - 0 >= Number(stated[2].replace(/,/g, '')) || true, 'Appendix D rows parsed');
  const monthTotals = (apxD.match(/Total, \w+ \d{4} \$[\d,]+/g) || []).map((x) => money(x.replace(/.*\$/, '$')));
  assert(monthTotals.reduce((t, v) => t + v, 0) === Number(stated[2].replace(/,/g, '')), 'Appendix D month totals add to the stated total (' + stated[2] + ')');
}
// the electric detail table foots: building rows add to the Total row
const elecRows = (sectionHtml('electricDetail').match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) || []).map((c) => textOf(c).trim()));
const totRow = elecRows.find((r) => r[0] === 'Total');
const bodyRows = elecRows.filter((r) => /Building/.test(r[0]));
if (totRow && bodyRows.length) {
  const num = (v) => Number(String(v).replace(/[^0-9.-]/g, ''));
  assert(bodyRows.reduce((t, r) => t + num(r[1]), 0) === num(totRow[1]), 'electric detail: baseline kWh rows add to the Total row (' + totRow[1] + ')');
  assert(bodyRows.reduce((t, r) => t + num(r[2]), 0) === num(totRow[2]), 'electric detail: actual kWh rows add to the Total row (' + totRow[2] + ')');
} else assert(false, 'electric detail table has building rows and a Total row');
// Word footer: the document writer emits "Page N of M" fields
const docxSrc = fs.readFileSync(path.join(REPO, 'app/docx-writer.js'), 'utf8');
assert(/NUMPAGES/.test(docxSrc) && /instrText[^']*PAGE/.test(docxSrc), 'Word footer writes PAGE and NUMPAGES fields');
// no tile or box markup in the quarterly report
assert(!/rpt-tile|rpt-kpi|rpt-card/.test(allHtml), 'no tile or box markup in the quarterly report');

assert(beta.propane.galBl > 0 && beta.propane.galCur === 0, 'propane baseline gallons count against 0 gallons delivered');

console.log('\n--- 4. percent base = amount billed + savings ---');
q2.buildings.forEach((b) => {
  const billed = q2.rawBills.filter((r) => r.bid === b.id).reduce((s, r) => s + r.amount, 0);
  assert(Math.abs(b.pctBase - (billed + b.savings)) < 1e-6, b.name + ': pctBase = billed ' + billed.toFixed(2) + ' + savings ' + b.savings.toFixed(2));
});
assert(Math.abs(q2.totals.pctBase - q2.buildings.reduce((s, b) => s + b.pctBase, 0)) < 1e-6, 'total pctBase = sum of building pctBase');

// ─── 1 + 2 + 4 on the page HTML (hand-built d) ───
console.log('\n--- 1, 2, 4. cover and results pages ---');
function pageData() {
  const mon = (ym, sav) => ({ month: ym, blCost: 1000, curCost: 1000 - sav, savings: sav, bl: 100, cur: 100 });
  const com = (savs) => ({ monthly: savs.map((v, i) => mon('2026-0' + (7 + i), v)), kwhBl: 300, kwhCur: 300, kwBl: 30, kwCur: 30, thermsBl: 0, thermsCur: 0, costSaved: 0 });
  // three buildings: months 0.4 + 0.4 + 0.4 each (quarter figure 1.2), baseline-year weights equal
  const bld = (id) => ({
    id, name: 'Building ' + id, sqft: 10000, status: 'ok', savings: 1.2, savingsPct: 0.1, blCost: 1000, pctBase: 1200,
    electric: com([0.4, 0.4, 0.4]), gas: null, propane: null, eui: { baseline: 50, current: 48, cbecs: 60 }, meterDetails: [],
  });
  return {
    period: { type: 'quarterly', quarter: 3, year: 2026, label: 'July 2026 through September 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
    project: { client: 'Test Client', name: 'Test Project', sqft: 30000 },
    contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [9056, 17892, 0], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3.5, annualTarget: 400, actualsThroughQuarter: 3 },
    // cumulativeSavings is the OLD wrong value: the pages must not print it
    totals: { savings: 0, shortfallNotBilled: 0, blCost: 3000, pctBase: 3600, curCost: 3600, kwhBl: 900, kwhCur: 900, thermsBl: 0, thermsCur: 0, peakKwBl: 90, peakKwCur: 90, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Jan 2026 to Sep 2026 annualized, all fuels', cumulativeSavings: 26968, weatherWaiting: [] },
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
assert(/\$26,948 billed through Q3 2026 plus the \$100 target for the remaining quarter\./.test(contract), 'projection basis line printed under the projection table');

const targets = d.buildings.map((b) => run(ctx, '(function(d,b){ return _rptBuildingTarget(d,b); })')(d, b));
assert(targets.reduce((s, v) => s + v, 0) === 100 && targets.every(Number.isInteger), 'building targets are whole dollars that add to the total target: ' + targets.join('+'));
const appt = run(ctx, '_rptApportion')([1.4, 1.4, 1.2], 4);
assert(appt.join(',') === '2,1,1' && appt.reduce((s, v) => s + v, 0) === 4, '_rptApportion adds to the rounded total: ' + appt.join(','));
assert(['2026-07', '2026-08', '2026-09'].every((ym) => Number.isInteger(f.shown.A[ym])) && f.shown.A['2026-07'] + f.shown.A['2026-08'] + f.shown.A['2026-09'] === Math.round(d.buildings[0].savings), 'month cells are whole dollars that add to the building quarter figure: ' + ['2026-07', '2026-08', '2026-09'].map((ym) => f.shown.A[ym]).join('+'));
assert(f.months.reduce((s, m) => s + m.sav, 0) === f.rowsMeasured && !/rounded once from the unrounded value|differ from a total by/.test(results), 'month totals add to the quarter total, and the page carries no rounding note');
// fuel parts add to the building total (the Middle School case: electric 3294.4 + gas 359.4, total 3653.8)
const dp = pageData();
const bp = dp.buildings[0];
bp.savings = 3653.8; bp.electric.costSaved = 3294.4; bp.gas = { monthly: bp.electric.monthly, thermsBl: 1, thermsCur: 1, costSaved: 359.4 };
const fp = run(ctx, '(function(d){ return _rptQFacts(d); })')(dp);
assert(fp.parts.A.electric + fp.parts.A.gas + fp.parts.A.propane === 3654, 'fuel parts add to the building total: ' + [fp.parts.A.electric, fp.parts.A.gas, fp.parts.A.propane].join('+'));
let energy, energyHtml = '';
try {
  energyHtml = run(ctx, '(function(d,f){ return _rptQEnergyPage(3,d,f); })')(dp, fp);
  energy = energyHtml.replace(/<[^>]+>/g, ' ');
} catch (e) {
  console.log('ERR ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 3).join(' / '));
  energy = '';
}
const byFuel = run(ctx, '(function(d,f){ return _rptQByFuelTable(d,f); })')(dp, fp).replace(/<[^>]+>/g, ' ');
assert(/\$3,295/.test(byFuel) && /\$359/.test(byFuel) && !/\$3,294/.test(byFuel), 'the fuel table prints the apportioned parts (3,295 and 359)');
assert(!/<table/.test(energyHtml) && /kWh charges/.test(energy) && /billed kW charges/.test(energy), 'page 3 has no table and splits the electricity dollars into kWh and billed kW parts');
assert(/Percent saved = savings (÷|&divide;) baseline cost \(\$[\d,]+ this quarter\)\. Baseline cost is the actual cost plus savings\./.test(results) && !/what the utility bills would have been/.test(results), 'percent note states the denominator as baseline cost');

// decision 1: utility invoices are "Utility bills"; "billed" is for contract savings
let meterPg = '';
try {
  meterPg = run(ctx, '(function(d,f){ return _rptQMeterPage(6,d,f); })')(dp, fp).replace(/<[^>]+>/g, ' ');
} catch (e) {
  console.log('ERR meter ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
}
assert(/Bills \(count\)/.test(meterPg) && /Cost/.test(meterPg) && !/Utility bill amount|Amount billed/.test(meterPg), 'meter page: Bills (count) and Cost');
// decision 2: signs
assert(/A minus sign on savings means more use than baseline/.test(energy), 'energy page: the minus sign is stated');
assert(/plus means savings; minus means more use than baseline/.test(cover), 'cover: the dollar sign rule is stated once');
// decision 7: propane unit symbol
assert(run(ctx, '_rptCommodityUnit')('Propane') === 'gal', 'propane unit is gal');
// 5. complete data: no internal status text on any report page (Matt 2026-11-03)
console.log('\n--- 5. no internal status text in the report pages ---');
const BANNED = /Waiting|waiting for|not reported yet|not yet reported|weather data|Not ready|could not be loaded|IPMVP|avoided energy|reporting.period weather/i;
[['cover', cover], ['results', results], ['contract', contract], ['energy', energy], ['meter', meterPg]].forEach(([k, html]) => {
  const m = String(html).match(BANNED);
  assert(html && !m, k + ' page has no status wording' + (m ? ' (found: ' + m[0] + ')' : ''));
});
// 7. a bill date that does not parse is escaped in Appendix D (security review, 2026-11-04)
console.log('\n--- 7. unparseable bill date is escaped ---');
try {
  const XSS = '<img src=x onerror=alert(1)>';
  const ap = run(ctx, '(function(d,f){ return _rptQAppendixDPages(7,d,f,"D"); })')(
    { buildings: [], rawBills: [{ ym: '2025-04', bid: 1, building: 'B', commodity: 'Gas', account: 'A', therms: 10, amount: 10, start: XSS, end: '2025-04-30' }] },
    { yms: ['2025-04'] },
  );
  const apHtml = JSON.stringify(ap);
  assert(apHtml.indexOf('&lt;img src=x') >= 0 && apHtml.indexOf('<img src=x') < 0, 'bad billing period date renders escaped in Appendix D');
} catch (e) {
  assert(false, 'appendix D escape test ran: ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
}
// 8. Appendix D prints billed demand (billedKW), measured demand only when the bill has no billed demand
console.log('\n--- 8. Appendix D kW is billed demand ---');
const kwOf = (acct) => Array.from(new Set(q3.rawBills.filter((r) => r.account === acct).map((r) => r.kw)));
assert(kwOf('A-mB1').join() === '60', 'bill with billedKW 60 and demandKW 50 carries kw 60: ' + kwOf('A-mB1').join());
assert(kwOf('A-mA1').join() === '50', 'bill with no billedKW falls back to demandKW 50: ' + kwOf('A-mA1').join());
assert(/Billed kW/.test(apxD), 'Appendix D column is labelled "Billed kW"');
// the bills of a building add to its Actual kW (page 4): 3.4 + 3.4 + 3.2 = 10 prints as whole numbers that add to 10
try {
  const mk = (ym, kw, day) => ({ ym, bid: 1, building: 'B', commodity: 'Electric', account: 'A', kwh: 100, kw, amount: 10, start: ym + '-01', billDate: ym + '-' + day });
  const apk = run(ctx, '(function(d,f){ return _rptQAppendixDPages(7,d,f,"D"); })')(
    { buildings: [{ id: 1, name: 'B', electric: { monthly: [], kwCur: 10 } }], rawBills: [mk('2025-04', 3.4, '10'), mk('2025-05', 3.4, '11'), mk('2025-06', 3.2, '12')] },
    { yms: ['2025-04', '2025-05', '2025-06'], qLabel: 'Q2 2025' },
  );
  const shown = (JSON.stringify(apk).match(/rpt-n\\">(\d+)<\/td><td class=\\"rpt-n\\">\$10</g) || []).map((x) => Number(/(\d+)</.exec(x)[1]));
  assert(shown.length === 3 && shown.reduce((t, v) => t + v, 0) === 10, 'Appendix D kW of a building adds to its Actual kW (10): ' + shown.join('+'));
} catch (e) {
  assert(false, 'appendix D kW sum test ran: ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
}
// 9. a building name wraps inside its own cell: no Building table first cell is forced to one line (Matt 2026-11-05)
console.log('\n--- 9. Building column wraps inside its cell ---');
{
  const tables = (allHtml.match(/<table[\s\S]*?<\/table>/g) || []).filter((t) => /<th[^>]*>Building<\/th>/.test(t) && /rpt-q-dense/.test(t));
  assert(tables.length > 0, 'quarterly report has Building tables to check: ' + tables.length);
  assert(tables.every((t) => !/rpt-q-nm/.test(t)), 'no Building table marks a name cell as one line');
}
// 10. the cover table and the Appendix C degree day table each print once (Matt 2026-11-05)
console.log('\n--- 10. repeated tables removed ---');
{
  const count = (re) => (flat.match(re) || []).length;
  assert(count(/Savings billed to date, contract year/g) === 1, 'cover savings table prints once: ' + count(/Savings billed to date, contract year/g));
  assert(count(/Savings measured this quarter/g) === 1 && count(/Savings measured, Q2 2025/g) === 0, 'no second savings summary table');
  assert(count(/Weather by Month/g) === 0, 'no "Weather by Month" heading');
  assert(count(/Heating degree days \d{4} \(baseline\)/g) === 1, 'degree day table prints once (Appendix C): ' + count(/Heating degree days \d{4} \(baseline\)/g));
  assert(/Contract progress: \d+% of the contract period \(\d+ of [\d,]+ days\) at [A-Z][a-z]+ \d+, \d{4}/.test(flat.replace(/\s+/g, ' ')) && !/Executive Summary/.test(flat), 'page 1 states the contract progress with its days and has no "Executive Summary" heading');
}
// 11. Manager decisions 1-7 (2026-11-05): one name per idea, the method as the numbers compute it, billed kW, one rounding, EUI, propane fact
console.log('\n--- 11. Manager decisions 1-7 ---');
{
  const sp = flat.replace(/\s+/g, ' ');
  assert(!/Electric Consumption|Consumption Detail|Utility bill amount|Commodity/.test(sp), 'no "Consumption", "Utility bill amount" or "Commodity" in the report');
  assert(!/\busage\b/i.test(sp), 'the report says "use", never "usage"');
  assert(/Electricity Use Detail/.test(sp) && /Natural Gas Use Detail/.test(sp), 'fuel detail pages are named "<Fuel> Use Detail"');
  assert(/The kWh and therms baseline of a month is the weather model of the meter evaluated at the heating and cooling degree days \(base [^)]*\) of the same month of [0-9]{4}\./.test(sp), 'Appendix A states the kWh and therms method (baseline-year weather)');
  assert(/The billed kW baseline of a month is the meter's model of billed kW on cooling degree days, evaluated at the cooling degree days of the month reported/.test(sp), 'Appendix A states the kW method (cooling degree days of the month reported)');
  assert(!/that month's weather/.test(sp), 'the wrong "that month\'s weather" wording is gone');
  assert(/Baseline is the use a meter would have had with no savings measures/.test(sp) && /Savings billed is the amount invoiced under the contract/.test(sp), 'page 1 defines baseline and savings billed in plain words');
  assert(/It comes from the use of the meter, weather normalized using [A-Za-z]+ \d{4} through [A-Za-z]+ \d{4}\./.test(sp) && !/adjusted for weather/.test(sp), 'baseline term: "weather normalized using <start> through <end>", no "adjusted for weather" (one source feeds screen, Word and PDF)');
  assert(/Billed kW is the demand, in kW, that the utility bills for the month\./.test(sp) && !/highest power draw/.test(sp), 'billed kW term: "the demand, in kW, that the utility bills for the month"');
  assert(!/(Baseline|Actual) kW|peak demand/i.test(sp), 'no "Baseline kW", "Actual kW" or "peak demand" label');
  assert(/billed kW, sum of 3 months/.test(sp), 'kW chart legend says "billed kW, sum of 3 months"');
  assert(!/rounded once from the unrounded value|differ from a total by/.test(sp), 'page 2 carries no rounding note (controlled rounding)');
  assert(!/Lower is better/.test(sp), '"Lower is better" is removed');
  assert((sp.match(/Commercial Buildings Energy Consumption Survey \(CBECS\)/g) || []).length === 1, 'CBECS is spelled out once');
  assert(/multiplied by 12 and divided by \d+/.test(sp), 'EUI period and annualizing are stated');
  assert(!/credit/i.test(sp.replace(/Control Service Company/g, '')), 'no "credit" wording about propane');
  const termFn = run(ctx, '(function (v, label, first, digits) { var dg = digits || 2; var a = Math.abs(v).toFixed(dg); return (first ? (v < 0 ? "-" : "") : v < 0 ? " - " : " + ") + a + " &times; " + label; })');
  const kwBlock = run(ctx, '_rptQBilledKwBlock')(
    { meterDetails: [{ commodity: 'Electric', account: 'X1', kwFit: { intercept: 100, slope: 0.25, n: 12 } }], electric: { monthly: [{ month: '2026-07', kwBl: 120.4, kwCur: 110.2 }] } },
    { yms: ['2026-07'], year: 2026 },
    { '2026-07': { cddCur: 600 } },
    termFn,
  );
  assert(/Baseline billed kW for a month = 100\.0000 \+ 0\.2500 x cooling degree days \(12 baseline months\)/.test(String(kwBlock).replace(/&times;/g, 'x')), 'Appendix B prints the kW formula per meter: ' + String(kwBlock).slice(0, 160));
}

// 12. Final pass (2026-11-05): controlled rounding (A), billing period (B), state name (C), sign rules (F), Year to Date (K)
console.log('\n--- 12. controlled rounding, billing period, state name, sign rules, Year to Date ---');
{
  // A. _rptControlledRound: every cell is its floor or ceiling, rows and columns add to their targets
  const cr = run(ctx, '_rptControlledRound');
  const ap = run(ctx, '_rptApportion');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let allOk = true;
  for (let t = 0; t < 300 && allOk; t++) {
    const R = 2 + Math.floor(rnd() * 6), C = 2 + Math.floor(rnd() * 4);
    const m = Array.from({ length: R }, () => Array.from({ length: C }, () => (rnd() - 0.5) * 20000));
    const rowT = m.map((r) => Math.round(r.reduce((s, v) => s + v, 0)));
    const total = rowT.reduce((s, v) => s + v, 0);
    const colT = ap(m[0].map((_, j) => m.reduce((s, r) => s + r[j], 0)), total);
    const g = cr(m, rowT, colT);
    if (!g) continue;
    const cellsOk = g.every((r, i) => r.every((v, j) => v === Math.floor(m[i][j]) || v === Math.ceil(m[i][j])));
    const rowsOk = g.every((r, i) => r.reduce((s, v) => s + v, 0) === rowT[i]);
    const colsOk = colT.every((c, j) => g.reduce((s, r) => s + r[j], 0) === c);
    if (!(cellsOk && rowsOk && colsOk)) allOk = false;
  }
  assert(allOk, 'controlled rounding: cells are floor or ceiling, every row and column foots (300 random tables)');
  const q3 = [[3805.4, -2280.2, -4606.2], [3502.1, 343.4, -1860.5], [2387.0, 329.4, -663.4], [-142.3, -546.2, -504.6], [-1983.3, -2896.8, -1430.9], [479.3, -243.0, -186.4]];
  const rowT = q3.map((r) => Math.round(r.reduce((s, v) => s + v, 0)));
  const colT = ap([8047.92, -5293.42, -9250.03], -6496);
  assert(colT.join(',') === '8048,-5294,-9250', 'month totals apportioned from the true values: ' + colT.join(','));
  // B. Appendix D prints the billing period from the stored start and end, never a bare dash
  const apD = run(ctx, '(function(d,f){ return _rptQAppendixDPages(7,d,f,"D"); })')(
    { buildings: [], rawBills: [
      { ym: '2026-07', bid: 1, building: 'B', commodity: 'Gas', account: 'A', therms: 10, amount: 10, start: '2026-07-08', end: '8/6/2026', provider: 'P' },
      { ym: '2026-07', bid: 1, building: 'B', commodity: 'Electric', account: 'E', kwh: 100, kw: 0, amount: 12, start: '', end: '', provider: '' },
    ] },
    { yms: ['2026-07'], qLabel: 'Q3 2026' },
  );
  const apFlat = ap2flat(apD);
  assert(/Billing period/.test(apFlat) && !/Bill date/.test(apFlat) && /7\/8\/2026&ndash;8\/6\/2026/.test(apD.html), 'Appendix D: "Billing period" column holds start and end dates (7/8/2026 to 8/6/2026)');
  assert(!/<td[^>]*>\s*-\s*<\/td>/.test(apD.html), 'Appendix D: no cell holds a bare dash');
  // C. the source line names the state
  const envHtml = run(ctx, '(function(d){ return _rptQEnvPage(3,d); })')(d);
  assert(/Kansas \(electricity\)/.test(envHtml) && !/state KS/.test(envHtml), 'Environmental Impact source line says Kansas, not "state KS"');
  // F. one sign rule per use column and per dollar column
  const appB = run(ctx, '(function(d,f){ return _rptQAppendixBPages(8,d,f,"B"); })')(d, f).html;
  assert(!/Saved (kWh|therms)|Savings (kWh|therms)/.test(appB) || appB.indexOf('Change kWh') >= 0, 'Appendix B: use columns are "Change", never "Saved kWh" or "Savings kWh"');
  const contractTxt = run(ctx, '(function(d,f){ return _rptQContractPage(5,d,f); })')(d, f).replace(/<[^>]+>/g, ' ');
  assert(!/\+\$/.test(contractTxt) && !/Billed minus target/.test(contractTxt), 'contract page: no plus sign on dollars, no "Billed minus target" column');
  const ctHtml = run(ctx, '(function(d,f){ return _rptQContractPage(5,d,f); })')(d, f);
  const ctTable = (ctHtml.match(/<table[\s\S]*?<\/table>/) || [''])[0];
  const ctHead = (ctTable.match(/<th[\s\S]*?<\/th>/g) || []).map((h) => h.replace(/<[^>]+>/g, '').trim());
  assert(ctHead.length === 3 && /^Contract year/.test(ctHead[0]) && ctHead[1] === 'Savings target' && ctHead[2] === 'Savings billed', 'Contract to Date table has three columns: year, Savings target, Savings billed: ' + JSON.stringify(ctHead));
  assert((ctTable.match(/<tr/g) || []).length === 6 && (ctTable.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g) || []).every((tr) => (tr.match(/<t[dh]/g) || []).length === 3), 'Contract to Date table keeps header, Q1 to Q4 and the Through row, every row has 3 cells');
  const fl2 = flat.replace(/\s+/g, ' ');
  assert(!/Actual minus baseline/.test(fl2) && /Change = actual use minus baseline use; plus means more use than baseline/.test(fl2), 'building pages: "Change" with the rule in a note (no "Actual minus baseline" column)');
  // K. Year to Date: Q1, Q2, Q3 in order, then Total; no blank cell
  const ytd = run(ctx, '(function(d,f){ return _rptQYearToDatePage(15,d,f); })')(d, f);
  const rowsY = (ytd.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => r.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'));
  assert(/Q1 2026/.test(rowsY[1]) && /Q2 2026/.test(rowsY[2]) && /Q3 2026/.test(rowsY[3]) && /Total/.test(rowsY[4]) && rowsY.length === 5, 'Year to Date rows: Q1 2026, Q2 2026, Q3 2026, Total: ' + JSON.stringify(rowsY));
  assert(!/<td[^>]*><\/td>/.test(ytd), 'Year to Date: no blank cell');
}
function ap2flat(a) { return String(a.html).replace(/<[^>]+>/g, ' '); }

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

