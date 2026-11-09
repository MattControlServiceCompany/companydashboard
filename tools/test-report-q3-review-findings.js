// tools/test-report-q3-review-findings.js — quarterly report review findings (Matt, 2026-11-02). SYNTHETIC data only.
// Run: node tools/test-report-q3-review-findings.js
//   1. "Savings billed to date" is the sum of the quarter actuals on the cover, the compensation table and
//      the contract table (one value); the 60/40 split follows it.
//   2. Rounding: building targets add to the total, month cells add to the quarter, one rule (_rptApportion).
//   3. EUI period ends at the report quarter end, not at the newest bill month.
//   4. Percent denominator = amount billed + savings, stated in the page note.
//   5. (2026-11-08) Q3 Word review fixes: dollars rounded from their own value, one actual cost on every page,
//      meter names on one line, thousands separators in the Baseline Data kW cells, propane baseline price.
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
// The sections of the Q2-format quarterly report (Matt 2026-11-06: same pages as the presented Q2 report)
['cover', 'financial', 'savingsPerformance', 'environmentalImpact', 'observations', 'meterPerformance', 'appendixA', 'appendixB'].forEach((k) => assert(present(k), 'checked section "' + k + '" has a page or sub-block in the report'));
const flat = allHtml.replace(/<[^>]+>/g, ' ');
// R16 gate: the generated report as a whole (Matt 2026-11-04)
console.log('\n--- 6b. report gate: banned text, every meter, tables foot ---');
['not billed', 'contract minimum', 'below baseline', 'Next Steps', 'recommend', 'genuine', 'not yet billed', 'avoided'].forEach((w) =>
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
// Word footer: the document writer emits "Page N of M" fields
const docxSrc = fs.readFileSync(path.join(REPO, 'app/docx-writer.js'), 'utf8');
assert(/NUMPAGES/.test(docxSrc) && /instrText[^']*PAGE/.test(docxSrc), 'Word footer writes PAGE and NUMPAGES fields');
// no tile or box markup in the quarterly report
assert(!/rpt-tile|rpt-kpi|rpt-card/.test(allHtml), 'no tile or box markup in the quarterly report');

assert(beta.propane.galBl > 0 && beta.propane.galCur === 0, 'propane baseline gallons count against 0 gallons delivered');

console.log('\n--- 4. percent base = amount billed + savings ---');
q2.buildings.forEach((b) => {
  const billed = q2.rawBills.filter((r) => r.bid === b.id).reduce((s, r) => s + r.amount, 0);
  assert(Math.abs(b.pctBase - b.blCost) < 1e-6, b.name + ': pctBase = the baseline cost ' + b.blCost.toFixed(2) + ' (billed ' + billed.toFixed(2) + ')');
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
    electric: com([0.4, 0.4, 0.4]), gas: null, propane: null, eui: { baseline: 50, current: 48, cbecs: 60 }, euiQ: { baseline: 10, current: 11 }, meterDetails: [],
  });
  return {
    period: { type: 'quarterly', quarter: 3, year: 2026, label: 'July 2026 through September 2026', yearMonths: ['2026-07', '2026-08', '2026-09'] },
    project: { client: 'Test Client', name: 'Test Project', sqft: 30000 },
    contract: { quarterlyTargets: [100, 100, 100, 100], quarterlyActuals: [9056, 17892, 0], currentYear: 1, years: 3, hasCsc: true, cscPct: 60, clientPct: 40, escalation: 3.5, annualTarget: 400, actualsThroughQuarter: 3 },
    // cumulativeSavings is the OLD wrong value: the pages must not print it
    totals: { euiBaselineQ: 10, euiCurrentQ: 11, savings: 0, shortfallNotBilled: 0, blCost: 3000, pctBase: 3600, curCost: 3600, kwhBl: 900, kwhCur: 900, thermsBl: 0, thermsCur: 0, peakKwBl: 90, peakKwCur: 90, euiBaseline: 50, euiCurrent: 48, euiPeriodLabel: 'Jan 2026 to Sep 2026 annualized, all fuels', cumulativeSavings: 26968, weatherWaiting: [] },
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
assert(!/billed through Q3 2026 plus the/.test(contract) && /Year 1 \(billed \+ targets\)/.test(contract), 'no explanation prose under the contract totals table; the Year 1 row names its parts');

const targets = d.buildings.map((b) => run(ctx, '(function(d,b){ return _rptBuildingTarget(d,b); })')(d, b));
assert(targets.reduce((s, v) => s + v, 0) === 100 && targets.every(Number.isInteger), 'building targets are whole dollars that add to the total target: ' + targets.join('+'));
const appt = run(ctx, '_rptApportion')([1.4, 1.4, 1.2], 4);
assert(appt.join(',') === '2,1,1' && appt.reduce((s, v) => s + v, 0) === 4, '_rptApportion adds to the rounded total: ' + appt.join(','));
assert(['2026-07', '2026-08', '2026-09'].every((ym) => Math.abs(f.shown.A[ym] - 0.4) < 1e-9), 'each month keeps its own exact value (0.4); a cell prints round(exact), no forced sum');
assert(!/rounded once from the unrounded value|differ from a total by/.test(results), 'the results page carries no rounding note');
// fuel parts add to the building total (the Middle School case: electric 3294.4 + gas 359.4, total 3653.8)
const dp = pageData();
const bp = dp.buildings[0];
bp.savings = 3653.8; bp.electric.costSaved = 3294.4; bp.gas = { monthly: bp.electric.monthly, thermsBl: 1, thermsCur: 1, costSaved: 359.4 };
const fp = run(ctx, '(function(d){ return _rptQFacts(d); })')(dp);
// Matt 2026-11-08: every printed dollar value is rounded from its own unrounded value (not apportioned to add up)
assert(fp.parts.A.electric === 3294 && fp.parts.A.gas === 359 && fp.parts.A.total === 3654, 'fuel parts and total each rounded from their own value: ' + [fp.parts.A.electric, fp.parts.A.gas, fp.parts.A.total].join(', '));
let energy, energyHtml = '';
try {
  energyHtml = run(ctx, '(function(d,f){ return _rptQEnergyPage(3,d,f); })')(dp, fp);
  energy = energyHtml.replace(/<[^>]+>/g, ' ');
} catch (e) {
  console.log('ERR ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 3).join(' / '));
  energy = '';
}
const byFuel = run(ctx, '(function(d,f){ return _rptQByFuelTable(d,f); })')(dp, fp).replace(/<[^>]+>/g, ' ');
assert(/\$3,294/.test(byFuel) && /\$359/.test(byFuel) && /\$3,654/.test(byFuel) && !/\$3,295/.test(byFuel), 'the fuel table prints each part rounded from its own value (3,294 and 359) and the total from its own value (3,654)');
assert(!/<table/.test(energyHtml) && /kWh charges/.test(energy) && /billed kW charges/.test(energy), 'page 3 has no table and splits the electricity dollars into kWh and billed kW parts');
assert(/Percent saved = savings (÷|&divide;) baseline cost \(\$[\d,]+ this quarter\)./.test(results) && !/what the utility bills would have been/.test(results), 'percent note states the denominator as baseline cost');

// decision 1: utility invoices are "Utility bills"; "billed" is for contract savings
let meterPg = '';
try {
  meterPg = run(ctx, '(function(d,f){ return _rptQMeterPage(6,d,f); })')(dp, fp).replace(/<[^>]+>/g, ' ');
} catch (e) {
  console.log('ERR meter ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
}
assert(/Bills\s+\(count\)/.test(meterPg) && /Cost/.test(meterPg) && !/Utility bill amount|Amount billed/.test(meterPg), 'meter page: Bills (count) and Cost');
// decision 2: signs
assert(!/minus sign on savings/.test(energy), 'energy page: no sign explanation under the table');
assert(!/plus means|minus means/.test(cover), 'cover: no sign explanation');
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
// 9. a building name wraps inside its own cell: no Building table first cell is forced to one line (Matt 2026-11-05)
// 11. Manager decisions 1-7 (2026-11-05): one name per idea, the method as the numbers compute it, billed kW, one rounding, EUI, propane fact
console.log('\n--- 11. Manager decisions 1-7 ---');
{
  const sp = flat.replace(/\s+/g, ' ');
  assert(!/Electric Consumption|Consumption Detail|Utility bill amount|Commodity/.test(sp), 'no "Consumption", "Utility bill amount" or "Commodity" in the report');
  assert(/The kWh and therms baseline of a month is the weather model of the meter evaluated at the heating and cooling degree days \(base [^)]*\) of the same month of [0-9]{4}\./.test(sp), 'Appendix A states the kWh and therms method (baseline-year weather)');
  assert(/The billed kW baseline of a month is the meter's model of billed kW on cooling degree days, evaluated at the cooling degree days of the month reported/.test(sp), 'Appendix A states the kW method (cooling degree days of the month reported)');
  assert(!/that month's weather/.test(sp), 'the wrong "that month\'s weather" wording is gone');
  assert(/Baseline is the \d{4} use in the same month/.test(sp) && /Savings billed is the amount invoiced under the contract/.test(sp), 'page 1 defines baseline and savings billed in plain words');
  assert(/it comes from the weather model of the meter, [A-Za-z]+ \d{4} through [A-Za-z]+ \d{4}, at the \d{4} weather \(billed kW: the weather of the month reported\)\./.test(sp) && !/weather normalized|adjusted for weather/.test(sp) && !/weather-adjusted/.test(sp.replace(/not weather-adjusted/g, '')), 'baseline term: "a weather model of the use of the meter, <start> through <end>, evaluated at the <year> weather"; the words "weather normalized" and "weather-adjusted" are gone');
  assert(/Billed kW is the demand, in kW, that the utility bills for the month\./.test(sp) && !/highest power draw/.test(sp), 'billed kW term: "the demand, in kW, that the utility bills for the month"');
  assert(!/(Baseline|Actual) kW|peak demand/i.test(sp), 'no "Baseline kW", "Actual kW" or "peak demand" label');
  assert(!/rounded once from the unrounded value|differ from a total by/.test(sp), 'page 2 carries no rounding note (controlled rounding)');
  assert(!/Lower is better/.test(sp), '"Lower is better" is removed');
  assert(!/credit/i.test(sp.replace(/Control Service Company/g, '')), 'no "credit" wording about propane');
  const termFn = run(ctx, '(function (v, label, first, digits) { var dg = digits || 2; var a = Math.abs(v).toFixed(dg); return (first ? (v < 0 ? "-" : "") : v < 0 ? " - " : " + ") + a + " &times; " + label; })');
  const kwBlock = run(ctx, '_rptQBilledKwBlock')(
    { meterDetails: [{ commodity: 'Electric', account: 'X1', kwFit: { intercept: 100, slope: 0.25, n: 12, r2: 0.5, cvrmse: 0.1 } }], electric: { monthly: [{ month: '2026-07', kwBl: 120.4, kwCur: 110.2 }] } },
    { yms: ['2026-07'], year: 2026 },
    { '2026-07': { cddCur: 600 } },
    termFn,
  );
  assert(/Baseline billed kW for a month = 100\.0000 \+ 0\.2500 x cooling degree days\. R&sup2;&nbsp;=&nbsp;0\.500; 12 baseline months; CV\(RMSE\) 10\.0%\./.test(String(kwBlock).replace(/&times;/g, 'x')), 'Appendix B prints the kW formula per meter: ' + String(kwBlock).slice(0, 160));
}

// 12. Final pass (2026-11-05): controlled rounding (A), billing period (B), state name (C), sign rules (F), Year to Date (K)
console.log('\n--- 12. controlled rounding, billing period, state name, sign rules, Year to Date ---');
{
  // A. (Matt 2026-11-08) every month cell is the whole-dollar rounding of its own exact value; no forced sum
  assert(typeof _rptControlledRoundGone === 'undefined' && run(ctx, "typeof _rptControlledRound") === 'undefined', '_rptControlledRound is removed');
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
  assert(ctHead.length === 3 && /^Contract year/.test(ctHead[0]) && ctHead[1] === 'Allocated target' && ctHead[2] === 'Savings billed', 'Contract to Date table has three columns: year, Allocated target, Savings billed: ' + JSON.stringify(ctHead));
  assert((ctTable.match(/<tr/g) || []).length === 6 && (ctTable.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g) || []).every((tr) => (tr.match(/<t[dh]/g) || []).length === 3), 'Contract to Date table keeps header, Q1 to Q4 and the Through row, every row has 3 cells');
  const fl2 = flat.replace(/\s+/g, ' ');
  assert(!/Actual minus baseline/.test(fl2) && !/Change = actual use minus baseline use|plus means|minus means/.test(fl2), 'building pages: no sign explanation note under the tables (no "Actual minus baseline" column)');
  // K. Year to Date: Q1, Q2, Q3 in order, then Total; no blank cell
  const ytd = run(ctx, '(function(d,f){ return _rptQYearToDatePage(15,d,f); })')(d, f);
  const rowsY = (ytd.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => r.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'));
  assert(/Q1 2026/.test(rowsY[1]) && /Q2 2026/.test(rowsY[2]) && /Q3 2026/.test(rowsY[3]) && /Total/.test(rowsY[4]) && rowsY.length === 5, 'Year to Date rows: Q1 2026, Q2 2026, Q3 2026, Total: ' + JSON.stringify(rowsY));
  assert(!/<td[^>]*><\/td>/.test(ytd), 'Year to Date: no blank cell');
}
function ap2flat(a) { return String(a.html).replace(/<[^>]+>/g, ' '); }

// 13. Expert review points 3, 7, 8, 13, 15, 17, 20, 22 (Matt 2026-11-06). SYNTHETIC data only.
console.log('\n--- 13. model fit, wording, entered months, allocated target ---');
{
  const plain = (h) => String(h).replace(/&sup2;/g, '²').replace(/&times;/g, 'x').replace(/&minus;/g, '-').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // regression.js: ONE CV(RMSE) (cvRmse) and one line fit; values checked by hand.
  const cv = run(ctx, 'cvRmse');
  // actual 10, 12, 14, 16; predicted 11, 11, 15, 15: residuals +-1, SS = 4, n - 2 = 2 -> RMSE sqrt(2); mean 13
  const c1 = cv([10, 12, 14, 16], [11, 11, 15, 15], 2);
  assert(Math.abs(c1 - Math.sqrt(2) / 13) < 1e-12, 'cvRmse = sqrt(SS / (n - p)) / mean: ' + c1);
  assert(cv([10, 12], [10, 12], 2) === null, 'cvRmse is null when n <= parameters');
  // modelCvRmse on a model that fits exactly: 0; on a model off by 1 per month: known value
  const mrows = [1, 2, 3, 4, 5].map((i) => ({ usage: 100 * 30 + 2 * i * 10, normDays: 30, hdd: i * 10, cdd: 0 }));
  const exact = run(ctx, 'modelCvRmse')(mrows, { intercept: 100, slope: 2 }, 'hdd');
  assert(exact === 0, 'modelCvRmse is 0 for a model that reproduces the months: ' + exact);
  const off = run(ctx, 'modelCvRmse')(mrows, { intercept: 100 + 1 / 30, slope: 2 }, 'hdd');
  // every month is over-predicted by 1 -> RMSE sqrt(5 / 3), mean use = 3000 + 60
  assert(Math.abs(off - Math.sqrt(5 / 3) / 3060) < 1e-9, 'modelCvRmse uses month residuals: ' + off);
  // kW fit: r2 and CV(RMSE) beside intercept, slope and n; the coefficients are the same as before
  const kwBills = [], kwRows = [];
  [[1, 100, 40], [2, 200, 52], [3, 300, 58], [4, 400, 71]].forEach(([mo, cdd, kw]) => {
    const ym = '2025-0' + mo;
    kwRows.push({ ym, cdd });
    kwBills.push({ id: 'k' + mo, start: ym + '-01', end: ym + '-28', billedKW: String(kw) });
  });
  const kf = run(ctx, 'fitKwCdd')(kwRows, kwBills);
  // hand fit: x mean 250, y mean 55.25; Sxx 50000, Sxy 4950 -> slope 0.099, intercept 30.5
  assert(kf && Math.abs(kf.slope - 0.099) < 1e-9 && Math.abs(kf.intercept - 30.5) < 1e-9 && kf.n === 4, 'kW fit coefficients unchanged: ' + JSON.stringify(kf));
  assert(kf && kf.r2 > 0.9 && kf.r2 < 1 && kf.cvrmse > 0 && kf.cvrmse < 0.1, 'kW fit carries r2 and cvrmse: ' + JSON.stringify(kf));

  // Appendix B prints R2, n and CV(RMSE) for every model, kW included (points 7 and 8)
  const dB = pageData();
  dB.buildings.forEach((b) => {
    b.meterDetails = [
      { commodity: 'Electric', account: 'E1', regrCoeffs: { type: 'dual', intercept: 100, slopeHDD: 2, slopeCDD: -0.5, r2: 0.912, n: 12, cvrmse: 0.0843 }, kwFit: { intercept: 40, slope: 0.07, n: 12, r2: 0.463, cvrmse: 0.131 } },
      { commodity: 'Gas', account: 'G1', regrCoeffs: { type: 'hdd', intercept: 5, slope: 0.3, r2: 0.97, n: 12, cvrmse: 0.052 } },
    ];
    b.electric = { monthly: [{ month: '2026-07', bl: 100, cur: 90, kwBl: 40, kwCur: 41 }] };
    b.gas = { monthly: [{ month: '2026-07', bl: 20, cur: 18 }] };
  });
  dB.weather = { monthly: [{ month: '2026-07', hddBl: 0, cddBl: 600, cddCur: 650 }], totals: {} };
  const fB = Object.assign({}, run(ctx, '_rptQFacts')(dB), { yms: ['2026-07'], year: 2026 });
  const appBraw = run(ctx, '_rptQAppendixBPages')(8, dB, fB, 'B');
  const appBtxt = plain(appBraw.html);
  assert((appBtxt.match(/R²(?:&nbsp;| )=(?:&nbsp;| )0\.912; 12 baseline months; CV\(RMSE\) 8\.4%\./g) || []).length === 3, 'Appendix B: the electricity model prints R2, n and CV(RMSE) (3 buildings)');
  assert((appBtxt.match(/R²(?:&nbsp;| )=(?:&nbsp;| )0\.970; 12 baseline months; CV\(RMSE\) 5\.2%\./g) || []).length === 3, 'Appendix B: the gas model prints R2, n and CV(RMSE) (3 buildings)');
  assert((appBtxt.match(/R²(?:&nbsp;| )=(?:&nbsp;| )0\.463; 12 baseline months; CV\(RMSE\) 13\.1%\./g) || []).length === 3, 'Appendix B: the billed kW model prints R2, n and CV(RMSE) (3 buildings)');
  assert(!/NMBE/.test(appBtxt), 'NMBE is not printed (0 by construction after the bias correction)');
  assert(/- 0\.50 x cooling degree days/.test(appBtxt), 'the wrong-sign term stays in the formula, unchanged');

  // Terms: points 3, 15, 22 (page 1 and Appendix A use the same term strings)
  const dT = { project: { blStart: 'January 2025', blEnd: 'December 2025' }, period: { year: 2026 } };
  const T = run(ctx, '_rptQTerms')(dT);
  assert(T.baseline === 'Baseline is the 2025 use in the same month. For an electricity or gas meter it comes from the weather model of the meter, January 2025 through December 2025, at the 2025 weather (billed kW: the weather of the month reported).', 'baseline term states the weather model and the 2025 weather: ' + T.baseline);
  assert(T.billed === 'Savings billed is the amount invoiced under the contract.', 'billed term gets no new sentence');
  assert(/^Allocated target is /.test(T.target) && !T.fit, 'target term is "Allocated target"; no new fit term');
  const p1Terms = run(ctx, '_rptQTermsText')(dT);
  assert(!/billed at \$0/.test(p1Terms) && /Allocated target/.test(p1Terms), 'page 1 definitions carry "Allocated target" and no new sentence');
  const methodHtml = plain(run(ctx, '_rptQMethodPage')(9, d, f, 'A'));
  assert(!/billed at \$0/.test(methodHtml) && /Allocated target\./.test(methodHtml) && !/Savings target/.test(methodHtml), 'Appendix A: "Allocated target", no "Savings target", no new sentence');

  // Results words (point 22)
  const rk = run(ctx, '_rptResultKind');
  assert(rk(500, 5, 1000).word === 'Below Target' && rk(500, 5, 1000).cls === 'rpt-r' && rk(1500, 5, 1000).word === 'On Track' && rk(1500, 5, 1000).cls === 'rpt-g', 'result words are On Track (green) and Below Target (red) only');

  // Savings colour (Matt, 2026-11-06): a savings figure is green above zero, red below zero; the status word keeps its status colour.
  const sv = run(ctx, '_rptSavVar');
  assert(sv(500, true) === 'var(--rpt-green-dark)' && sv(500, false) === 'var(--rpt-green)' && sv(-500, true) === 'var(--rpt-red)' && sv(0, true) === 'var(--rpt-page-text)', '_rptSavVar: green above zero, red below zero, page text at zero');
  const dS = pageData();
  dS.buildings[0].savings = 3654; dS.buildings[0].savingsPct = 5.5; // saved money, but under its target
  dS.contract.quarterlyTargets = [90000, 90000, 90000, 90000]; // each building target is 30000, above the 3654 saved
  dS.buildings[1].savings = -800; dS.buildings[1].savingsPct = -2.1;
  const pg2 = run(ctx, 'rptPageCover')(1, dS).html;
  const cardOf = (nm) => { const i = pg2.indexOf('>' + nm + '<'); return pg2.slice(i, pg2.indexOf('</div></div>', pg2.indexOf('rpt-sc-label', i)) + 12); };
  const cA = cardOf('Building A'), cB = cardOf('Building B');
  assert(/Below Target/.test(cA) && /rpt-sc-val" style="color:var\(--rpt-green-dark\)"[^>]*>5\.5%/.test(cA) && /rpt-sc-label" style="color:var\(--rpt-red\)"[^>]*>[^<]*Below Target/.test(cA), 'page 2 card: positive savings with Below Target status shows the savings green and the status red: ' + cA.replace(/contenteditable="true"/g, ''));
  assert(/Below Target/.test(cB) && /rpt-sc-val" style="color:var\(--rpt-red\)"[^>]*>-2\.1%/.test(cB) && /rpt-sc-label" style="color:var\(--rpt-red\)"/.test(cB), 'page 2 card: negative savings shows the savings red');

  // Contract page (point 17): contract facts, no prediction, no "Projection"
  const ctPage = plain(run(ctx, '_rptQContractPage')(5, d, f));
  assert(/Contract Totals/.test(ctPage) && /Billed to date plus contract targets/.test(ctPage) && !/Projection|projected|if remaining targets are met|Savings target/.test(ctPage), 'contract page: "Billed to date plus contract targets", no projection wording');
  const mPage = plain(run(ctx, '_rptQMethodPage')(5, d, f, 'A'));
  assert(/contract target at the 3\.5% annual energy cost escalation stated in the Agreement/.test(mPage) && !/escalated 3\.5% a year/.test(ctPage + mPage) && !/escalation stated in the Agreement/.test(ctPage), 'Appendix A (not the contract page) attributes the 3.5% to the Agreement');
  assert(/Allocated target/.test(ctPage), 'contract page: column "Allocated target"');

  // CBECS edition (point 13): printed for a K-12 school at 48.5 only
  const dC = pageData();
  dC.buildings.forEach((b) => { b.type = 'K-12 School'; b.eui = { baseline: 50, current: 48, cbecs: 48.5 }; });
  const benchK = plain(run(ctx, '_rptQMethodPage')(10, dC, f, 'A'));
  assert(/National median\. K-12 schools: 48\.5 kBtu\/ft²\/yr, from the U\.S\. Energy Information Administration 2012 Commercial Buildings Energy Consumption Survey \(CBECS\), as published in the ENERGY STAR Portfolio Manager U\.S\. national median table/.test(benchK), 'benchmark note names the 2012 CBECS and the ENERGY STAR table for K-12 at 48.5: ' + benchK.slice(benchK.indexOf('National median'), benchK.indexOf('National median') + 260));
  dC.buildings.forEach((b) => { b.type = 'Office Building'; b.eui = { baseline: 50, current: 48, cbecs: 52.9 }; });
  const benchO = plain(run(ctx, '_rptQMethodPage')(10, dC, f, 'A'));
  assert(!/2012/.test(benchO) && /\(CBECS\)/.test(benchO), 'no survey year is printed for a value whose edition is not confirmed');

  // Entered months (point 20): a baseline month whose bill has no bill file says "entered"
  const bData = { name: 'Alpha Building', sqft: 10000, blMonths: ['2025-03', '2025-04'], baselineEntered: { 3: ['Gas'] },
    baselineMaps: { elecByMo: {}, propaneByMo: {}, gasByMo: { 2: { therms: 300, cost: 240, hdd: 200, cdd: 0 }, 3: { therms: 200, cost: 160, hdd: 100, cdd: 5 } } } };
  const blTxt = plain(run(ctx, '_rptQBaselineDataBody')(bData, d));
  assert(/April 2025, gas entered/.test(blTxt) && !/March 2025, /.test(blTxt) && !/Entered:/.test(blTxt), 'Baseline Data: "April 2025, gas entered", no note; March (bill file attached) is not marked');
  bData.baselineEntered = {};
  assert(!/entered/i.test(plain(run(ctx, '_rptQBaselineDataBody')(bData, d))), 'Baseline Data: nothing is marked when every bill has a bill file');

  // Old wording is gone from the whole quarterly report text (all sections) and from the report source (release notes keep their history)
  assert(!/weather[- ](adjusted|normali[sz]ed)/i.test(flat.replace(/not weather-adjusted/g, '')), 'the quarterly report, all sections, has no "weather-adjusted" or "weather normalized"');
  const reSrc = fs.readFileSync(path.join(REPO, 'app/report-engine.js'), 'utf8');
  ['weather normalized', 'Savings target', 'Saved, below target', "'Met target'", 'Savings if remaining targets are met'].forEach((w) =>
    assert(reSrc.indexOf(w) < 0, 'report-engine.js no longer contains "' + w + '"'),
  );
}

// 14. Q3 Word review fixes (Matt 2026-11-08): one rounding rule, one actual cost on every page, meter names on one line,
//     thousands separators in the Baseline Data kW cells, a price on every propane baseline month that has gallons
console.log('\n--- 14. rounding, actual cost on every page, meter names, kW separators, propane baseline price ---');
{
  const usd = (v) => run(ctx, '_fmtUSD')(v, '$0');
  const rowLast = (html, label) => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('<tr[^>]*><td[^>]*>' + esc + '[^<]*</td>(.*?)</tr>', 's').exec(html);
    if (!m) return null;
    const tds = Array.from(m[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs));
    return tds.length ? tds[tds.length - 1][1].replace(/<[^>]+>/g, '').trim() : null;
  };
  // 13a. the High School case of the review: electricity -2,678.37, gas -402.30, total -3,080.67
  const dr = pageData();
  const bh = dr.buildings[0];
  bh.savings = -3080.67;
  bh.electric.costSaved = -2678.37;
  bh.electric.kwCostSaved = -92.54;
  bh.gas = { monthly: bh.electric.monthly, thermsBl: 1, thermsCur: 1, costSaved: -402.3 };
  const fr = run(ctx, '_rptQFacts')(dr);
  assert(fr.parts.A.electric === -2679 && fr.parts.A.gas === -402 && fr.parts.A.total === -3081, 'electricity is its printed kWh row plus its printed billed kW row (-2,586 + -93), gas and total each rounded from their own value: electricity ' + fr.parts.A.electric + ', gas ' + fr.parts.A.gas + ', total ' + fr.parts.A.total);
  assert(fr.parts.A.elecEnergy === -2586 && fr.parts.A.elecDemand === -93, 'the kWh and billed kW parts are each rounded from their own value: ' + fr.parts.A.elecEnergy + ', ' + fr.parts.A.elecDemand);
  const rawElec = dr.buildings.reduce((s, b) => s + ((b.electric && b.electric.costSaved) || 0), 0);
  assert(fr.partsTotal.electric === Math.round(rawElec), 'the site total of a fuel is the rounded sum of the unrounded values: ' + fr.partsTotal.electric + ' = round(' + rawElec.toFixed(2) + ')');
  const sumPage = run(ctx, '_rptQBuildingSummaryPage');
  let sumHtml = '';
  try {
    sumHtml = sumPage(1, dr, bh, fr);
  } catch (e) {
    console.log('ERR building summary page ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
  }
  const byFuelHtml = run(ctx, '_rptQByFuelTable')(dr, fr);
  assert(/Building A\s+-\$2,679/.test(byFuelHtml.replace(/<[^>]+>/g, ' ')), 'data 1 (v254): Savings by building and utility prints electricity -$2,679 (the -$2,586 kWh row plus the -$93 billed kW row) for the review case');
  if (sumHtml) assert(rowLast(sumHtml, 'Electricity use (kWh)') === '-$2,586' && rowLast(sumHtml, 'Electricity demand (billed') === '-$93', 'Building Summary electricity is two rows, use -$2,586 and demand -$93: ' + rowLast(sumHtml, 'Electricity use (kWh)') + ' / ' + rowLast(sumHtml, 'Electricity demand (billed kW, sum of 3 months)'));
  // The Building Summary and the "by Building" table of every building print the same savings (collected data)
  const fq = run(ctx, '_rptQFacts')(q3);
  const detail = run(ctx, '_rptQFuelDetailPages');
  q3.buildings.forEach((b) => {
    ['electric', 'gas', 'propane'].forEach((kind, ki) => {
      if (!b[kind] || !b[kind].monthly || !b[kind].monthly.length) return;
      assert(fq.parts[b.id][kind] === Math.round(b[kind].costSaved), b.name + ' ' + kind + ' part = round of its own unrounded savings: ' + fq.parts[b.id][kind]);
      let dh = '';
      let sh = '';
      try {
        dh = detail(1, q3, fq, kind).html;
        sh = sumPage(1, q3, b, fq);
      } catch (e) {
        console.log('ERR summary/detail ' + kind + ' ' + String(e.stack).split(String.fromCharCode(10)).slice(0, 2).join(' / '));
      }
      const label = ['Electricity use (kWh)', 'Natural gas (therms)', 'Propane delivered (gal)'][ki];
      if (dh && sh && kind !== 'electric') assert(rowLast(sh, label) === rowLast(dh, b.name), b.name + ' ' + kind + ': Building Summary ' + rowLast(sh, label) + ' = detail table ' + rowLast(dh, b.name));
    });
  });
  // 13b. one actual cost = ENERGY CHARGES only (Matt 2026-11-08), the basis of the baseline cost and of the presented
  //      Q1/Q2 reports: electric kWh + billed kW + facilities dollars, gas charge, propane delivered cost. A building's
  //      actual cost on the first pages = the sum of its commodity costs on the meter pages = the sum of its bills.
  const billRaw = {};
  q3.buildings.forEach((b) => {
    const billed = q3.rawBills.filter((r) => r.bid === b.id).reduce((s, r) => s + r.amount, 0);
    const fuels = ['electric', 'gas', 'propane'].reduce((s, k) => s + ((b[k] && b[k].costCur) || 0), 0);
    assert(Math.abs(b.curCost - billed) < 1e-6, b.name + ': actual cost on the Financial Summary = the energy charges of the bills (' + b.curCost.toFixed(2) + ' = ' + billed.toFixed(2) + ')');
    assert(Math.abs(fuels - billed) < 1e-6, b.name + ': the fuel actual costs add to the same total (' + fuels.toFixed(2) + ')');
    assert(flat.indexOf(usd(billed)) >= 0, b.name + ': the report prints ' + usd(billed));
    billRaw[b.id] = billed;
  });
  const sumTotals = q3.buildings.reduce((s, b) => s + b.curCost, 0);
  assert(Math.abs(q3.totals.curCost - sumTotals) < 1e-6, 'the site actual cost = the sum of the buildings (' + q3.totals.curCost.toFixed(2) + ')');
  const bl1 = run(ctx, '_rptBillAmount');
  assert(Math.abs(bl1({ totalCost: 100, onPeakCost: 60, customerCharge: 30, franchiseFee: 10 }, 'Electric') - 60) < 1e-9, 'electric: energy lines only (60 of a 100 bill)');
  assert(Math.abs(bl1({ totalCost: 100, demandCharge: 20, onPeakCost: 50, facilitiesCharge: 5, customerCharge: 25 }, 'Electric') - 75) < 1e-9, 'electric: kWh + billed kW + facilities dollars (75)');
  assert(Math.abs(bl1({ totalCost: 100, gasCharge: 70, therms: 50 }, 'Gas') - 70) < 1e-9, 'gas: the gas charge (70 of a 100 bill)');
  assert(bl1({ totalCost: 200, gallonsDelivered: 100 }, 'Propane') === 200, 'propane: the delivered cost');
  // the meter pages print the same energy-charge amounts: per building and commodity, the meter amounts add to the page 3 value
  const fq2 = run(ctx, '_rptQFacts')(q3);
  const bg2 = run(ctx, '_rptQBillGroups')(q3, fq2);
  q3.buildings.forEach((b) => {
    ['Electric', 'Gas', 'Propane'].forEach((c) => {
      const kind = c.toLowerCase();
      const meters = bg2.order.map((k) => bg2.groups[k]).filter((g) => g.building === b.name && g.commodity === c).reduce((s, g) => s + g.amount, 0);
      const page3 = (b[kind] && b[kind].costCur) || 0;
      assert(Math.abs(meters - page3) < 1e-6, b.name + ' ' + c + ': meter pages ' + meters.toFixed(2) + ' = Building Performance ' + page3.toFixed(2));
    });
  });
  // 13c. a meter name is one line in the PDF (nowrap) and in Word (the nowrap cell widens the Word column)
  const meterHtml = run(ctx, '(function(d,f){ return _rptQMeterPage(6,d,f); })')(q3, fq);
  const nNames = (meterHtml.match(/Acct#/g) || []).length;
  const nNowrap = (meterHtml.match(/<td style="white-space:nowrap">[A-Za-z ]+, Acct#/g) || []).length;
  assert(nNames > 0 && nNames === nNowrap, 'every meter name cell is white-space:nowrap (' + nNowrap + ' of ' + nNames + ')');
  const detailMeters = detail(1, q3, fq, 'electric').html;
  assert(/<td style="white-space:nowrap">Electricity, Acct#/.test(detailMeters), 'the meters under the fuel table also keep each name on one line');
  const wM = run(ctx, '_RPT_Q_W_METERS');
  assert(wM.reduce((s, v) => s + v, 0) === 100 && wM[1] >= 30 && wM[0] >= 28, 'the meter name column is at least 30% and the building column 28% of the meter table: ' + wM.join(','));
  // 13d. Baseline Data kW cells use thousands separators (a total of 3,600.0 kW, not 3600.0)
  run(ctx, "getUDBldg(" + PROJ + ", 'bB').meters[0].bills.forEach(function (b) { b.billedKW = 300; b.demandKW = 300; })");
  const blHtml = run(ctx, '(function(){ return _buildBaselineDataHtml(getUDBldg(' + PROJ + ", 'bB'), " + PROJ + '); })')();
  assert(/>3,600\.0</.test(blHtml) && !/>3600\.0</.test(blHtml), 'Baseline Data: the kW total prints 3,600.0');
  // 13e. a propane baseline month with gallons and no cost is priced at the all-in $/gal of the baseline-year deliveries
  const blBills = propaneBills();
  const map = { 0: { gallons: 100, cost: 50 }, 6: { gallons: 20, cost: 0 }, 7: { gallons: 0, cost: 0 } };
  const priced = run(ctx, '_rptPropaneBlCostMap')(map, blBills, BL_MONTHS);
  assert(Math.abs(priced[6].cost - 40) < 1e-9, 'propane baseline: 20 gal x $2.00 = $40 (' + priced[6].cost + ')');
  assert(priced[0].cost === 50 && priced[7].cost === 0, 'a month with a cost keeps it; a month with no gallons stays $0');
  assert(map[6].cost === 0, 'the stored baseline map is not changed');
  const none = run(ctx, '_rptPropaneBlCostMap')(map, [{ id: 'x', start: '2024-03-01', end: '2024-03-01', gallonsDelivered: 50 }], BL_MONTHS);
  assert(none === map, 'no priced delivery in the baseline year: no rate is made up, the map is unchanged');
}


// 14. v245 review fixes (Matt 2026-11-08): D1 month rounding, D2 percent base, D3 true month savings, D4 footing,
//     D6 baseline energy cost, L1 dials, L2 two electricity rows, L3 district wording
console.log('\n--- 14. v245 review fixes ---');
{
  // D1: a month prints round(its own exact value): -5293.41 prints $5,293, not $5,294
  const dm = pageData();
  dm.buildings.forEach((b, i) => {
    b.electric.monthly.forEach((m, k) => (m.savings = i === 0 ? [8047.92, -5293.41, -9250.03][k] : 0));
    b.savings = i === 0 ? -6495.52 : 0;
  });
  const fm = run(ctx, '_rptQFacts')(dm);
  const coverH = run(ctx, '(function(d,f){ return _rptQCoverPage(1,d,f); })')(dm, fm).replace(/<[^>]+>/g, ' ');
  assert(/8,048/.test(coverH) && /5,294/.test(coverH) && /9,250/.test(coverH) && !/5,293/.test(coverH), 'D1: the three months print 8,048, -5,294 and -9,250, which add to the quarter total -6,496 (largest remainder)');
  // D2: percent of baseline cost = savings / the baseline cost printed
  q2.buildings.forEach((b) => assert(Math.abs(b.pctBase - b.blCost) < 1e-6, 'D2: ' + b.name + ' percent denominator is its baseline cost'));
  assert(!/actual cost plus savings|billed cost plus savings/i.test(flat), 'D2: no page names the old denominator');
  // D3: every month row carries the formula savings apart from a pinned override
  const mo = q3.buildings.find((b) => b.electric && b.electric.monthly.length).electric.monthly;
  assert(mo.every((m) => typeof m.formulaSav === 'number'), 'D3: each month carries formulaSav (the contract formula result)');
  // D4: a dollar column total in a meter table is the sum of the cents printed above it
  const money = (t) => { const x = /^[-\u2212]?\$([\d,]+\.\d\d)$/.exec(t.trim()); return x ? (/^[-\u2212]/.test(t.trim()) ? -1 : 1) * parseFloat(x[1].replace(/,/g, '')) : null; };
  let tabs = 0, tabsOk = 0;
  const mp = run(ctx, '(function(){ var m = getUDBldg(' + PROJ + ", 'bA').meters[0]; return buildMeterPerfTableHTML(m, m.bills, true, { mode: 'report', filterYMs: ['2025-01', '2025-02', '2025-03'] }).html; })")();
  if (process.env.DBG) console.log('DBG', mp.length, mp.replace(/<[^>]+>/g,'|').replace(/\|+/g,'|').slice(0,600));
  [mp].forEach((tb) => {
    const rows = (tb.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '')));
    const body = rows.filter((r) => r.length > 3);
    if (body.length < 3) return;
    const tot = body[body.length - 1], data = body.slice(0, -1);
    for (let c = 1; c < tot.length; c++) {
      const tv = money(tot[c]);
      if (tv === null || !data.every((r) => money(r[c]) !== null)) continue;
      tabs++;
      if (Math.abs(data.reduce((a, r) => a + money(r[c]), 0) - tv) < 0.005) tabsOk++;
    }
  });
  assert(tabs > 0 && tabs === tabsOk, 'D4: every dollar total in the meter tables foots to its rows (' + tabsOk + ' of ' + tabs + ')');
  // D6: the report Baseline Data cost is the energy charges (a bill total of 1000 holds 600 of energy lines)
  const blSite = run(ctx, '(function(){ return _buildBaselineDataHtml(getUDBldg(' + PROJ + ", 'bA'), " + PROJ + '); })')();
  const blRep = run(ctx, '(function(){ return _buildBaselineDataHtml(getUDBldg(' + PROJ + ", 'bA'), " + PROJ + ', { report: true }); })')();
    assert(/\$600\.00</.test(blRep) && !/\$1,000\.00</.test(blRep) && /\$1,000\.00</.test(blSite), 'D6: the report Baseline Data month cost is the energy charges ($600 of a $1,000 bill)');
  // L1: dials say what changed
  assert(/Electricity Use Change/i.test(flat) && /Site EUI Change/i.test(flat), 'L1: dial labels are Electricity Use Change and Site EUI Change');
  // L2: electricity is two rows in the Building Summary
  const sumH2 = run(ctx, '_rptQBuildingSummaryPage')(1, q3, q3.buildings[0], run(ctx, '_rptQFacts')(q3)).replace(/<[^>]+>/g, ' ');
  assert(/Electricity use \(kWh\)/.test(sumH2) && /Electricity demand \(billed(&nbsp;| )kW, sum of 3(&nbsp;| )months\)/.test(sumH2), 'L2: Building Summary has an electricity use row and a demand row');
  // L3: the district, not the client
  assert(/District share/.test(results + contract) && !/Client share|Client Net|the client/.test(flat + results + contract), 'L3: District share and District net wording, no "client"');
}


// 15. v247 (Matt 2026-11-08): the Baseline Data "Average $" columns divide cost by the BILLED quantity
console.log('\n--- 15. Baseline Data average price uses billed usage ---');
{
  // stub the monthly baseline: billed kWh 1000 (normalized 2000), billed kW 50 (actual kW 40), billed therms 100 (normalized 500)
  run(ctx, 'var _hvlRealMonthly = _hvlMonthlyBaseline; _hvlMonthlyBaseline = function () { return { elecM: {}, gasM: {}, propaneM: null, pByMo: {},' +
    ' eByMo: { 0: { kwh: 1000, kwhPredicted: 2000, demandKW: 40, billedKW: 50, facKW: 0, kwCost: 400, energyCost: 100, totalCost: 500 } },' +
    ' gByMo: { 0: { therms: 100, thermsPredicted: 500, cost: 80 }, 1: { therms: 0, thermsPredicted: 300, cost: 25 } } }; }');
  let html = '';
  try {
    html = run(ctx, '(function(){ return _buildBaselineDataHtml({ id: "x", name: "T", sqft: 1000, meters: [] }, ' + PROJ + '); })')();
  } finally {
    run(ctx, '_hvlMonthlyBaseline = _hvlRealMonthly');
  }
  const rows = (html.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '').trim()));
  const jan = rows.find((r) => r[0] === 'Jan') || [], feb = rows.find((r) => r[0] === 'Feb') || [], tot = rows.find((r) => r[0] === 'TOTAL') || [];
  if (process.env.DBG) console.log('DBG15', JSON.stringify({ jan, feb, tot }));
  assert(jan.indexOf('$0.1000') >= 0 && !jan.some((c) => c === '$0.0500'), 'Jan Average $/kWh = 100 / billed 1,000 kWh = $0.1000 (not / normalized 2,000)');
  assert(jan.indexOf('$8.00') >= 0 && !jan.some((c) => c === '$10.00'), 'Jan Average $/kW = 400 / billed 50 kW = $8.00 (not / actual 40 kW)');
  assert(jan.indexOf('$0.800') >= 0 && !jan.some((c) => c === '$0.160'), 'Jan Average $/therm = 80 / billed 100 therms = $0.800 (not / normalized 500)');
  assert(feb.length > 0 && !feb.some((c) => /^\$0\.0[0-9]{2}$|^\$0\.083$/.test(c)) && feb.filter((c) => c === '—').length >= 2, 'Feb with 0 billed therms and $25 shows a dash for Average $/therm');
  assert(tot.indexOf('$0.1000') >= 0 && tot.indexOf('$8.00') >= 0 && tot.indexOf('$1.050') >= 0 && tot.indexOf('$0.131') < 0, 'TOTAL row divides by billed kWh, billed kW and billed therms (105 / 100 therms = $1.050): ' + JSON.stringify(tot));
}

// 16. v248 (Matt 2026-11-08): the gas usage column holds weather-normalized therms, so its header says so (like "Normalized kWh")
console.log('\n--- 16. Baseline Data gas column header ---');
{
  run(ctx, 'var _hvlRealMonthly16 = _hvlMonthlyBaseline; _hvlMonthlyBaseline = function () { return { elecM: {}, gasM: {}, propaneM: null, pByMo: {}, eByMo: {}, gByMo: { 0: { therms: 65, thermsPredicted: 455, cost: 51.88 }, 6: { therms: 0, thermsPredicted: 0, cost: 0 } } }; }');
  let html16 = '';
  try {
    html16 = run(ctx, '(function(){ return _buildBaselineDataHtml({ id: "x", name: "T", sqft: 1000, meters: [] }, ' + PROJ + '); })')();
  } finally {
    run(ctx, '_hvlMonthlyBaseline = _hvlRealMonthly16');
  }
  assert(/>Normalized therms<\/th><th[^>]*>Average \$\/Therm</.test(html16), 'gas column header says "Normalized therms"');
  const rows16 = (html16.match(/<tr[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '').trim()));
  const jul16 = rows16.find((r) => r[0] === 'Jul') || [], aug16 = rows16.find((r) => r[0] === 'Aug') || [];
  const gi16 = (html16.match(/<th[^>]*>[^<]*<\/th>/g) || []).map((h) => h.replace(/<[^>]+>/g, '')).indexOf('Normalized therms');
  assert(gi16 > 0 && jul16[gi16] === '0' && jul16[gi16 + 1] === '—' && jul16[gi16 + 2] === '—', 'a month with a normalized value of 0 shows 0 therms and a dash for the price');
  assert(gi16 > 0 && aug16[gi16] === '—', 'a month with no baseline row shows a dash');
  assert(!/>Therms<\/th>/.test(html16), 'no plain "Therms" gas header');
  // the report cuts the site table into Electricity / Natural Gas and Total Utility by the gas header name (rptBuildSiteBaselineData):
  // the name the site table prints must be the name the report splitter looks for
  const reSrc = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  const fn16 = reSrc.slice(reSrc.indexOf('function rptBuildSiteBaselineData'), reSrc.indexOf('function _rptQHoursPage'));
  assert(/h === 'Normalized therms'/.test(fn16) && /heads\.indexOf\('Normalized therms'\)/.test(fn16) && !/'Therms'/.test(fn16), 'report split (rptBuildSiteBaselineData) looks for the gas header "Normalized therms", the name the site table prints');
}

console.log('\n--- 17. v250 display fixes (v249 reviews) ---');
{
  const re17 = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  const pt17 = fs.readFileSync(path.join(REPO, 'lib', 'perf-table.js'), 'utf8');
  const po17 = fs.readFileSync(path.join(REPO, 'computations', 'pollution.js'), 'utf8');
  const thCase = run(ctx, '_rptQThSameCase')('<th>Baseline Cost</th><th>Propane Gal</th><th>$/Gallon</th><th>Gal<br>saved</th><th>Load Factor</th><th>Total Utility</th><th>Percent of<br>Baseline Cost</th>').replace(/ style="[^"]*"/g, '');
  assert(/>Baseline cost</.test(thCase) && />Propane delivered \(gal\)</.test(thCase) && />\$\/gal</.test(thCase) && />gal<br>saved</.test(thCase) && />Load factor</.test(thCase) && />Total utility</.test(thCase) && />Percent of<br>baseline cost</.test(thCase), 'one header case: sentence case, "gal" in one form: ' + thCase);
  assert(/tankerTrucks: Math\.floor\(mt \* eq\.tankerTrucks\)/.test(po17) && /railcarsCoal: Math\.floor\(mt \* eq\.railcarsCoal\)/.test(po17) && /coalPlants: Math\.floor\(mt \* eq\.coalPlants\)/.test(po17), 'tanker truck, railcar and power plant never round up from below 1');
  const envFn = re17.slice(re17.indexOf('function rptPageEnvironmentalImpact'), re17.indexOf('function rptPageObservations'));
  assert(!/deforestation|_eqYrSuffix/.test(envFn) && /of U\.S\. forest in one year/.test(envFn), 'p6 equivalents: forest carbon wording, no "this quarter" on an annual EPA basis');
  assert(!/current costs at/.test(re17) && /actual costs at/.test(re17), '"current costs" is "actual costs"');
  assert(/H_BL_KW = rpt \? 'Baseline' \+ BR \+ 'billed' \+ NB \+ 'kW'/.test(pt17), 'meter table header says Baseline billed kW with the unit not split');
  assert(/Math\.round\(\(d\.savings \|\| 0\) \* 100\) - fl\[0\] - fl\[1\]/.test(pt17), 'meter table kWh $ and kW $ cents are apportioned to the Total $');
  const T17 = run(ctx, '_rptQTerms')({ project: { blStart: 'January 2025', blEnd: 'December 2025' }, period: { year: 2026 } });
  assert(/^Facilities kW is /.test(T17.facilitiesKw) && /^Normalized use is /.test(T17.normalized) && /^Load factor is /.test(T17.loadFactor), 'Appendix A defines Facilities kW, Normalized use and Load factor');
  assert(/A quarterly EUI covers only the quarter and is not annualized. Site EUI:/.test(T17.eui) && /Site EUI: the baseline uses the weather-model use at the 2025 weather; the actual uses the billed use\./.test(T17.eui), 'the EUI term states the quarter and annualized forms and the baseline/actual split (v256)');
  assert(!/_rptQLaterYears|Degree days compare each day/.test(re17), 'no explanation prose left on the contract totals or the weather appendix page');
}

console.log('\n--- 18. v251 display fixes ---');
{
  const re18 = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  const pt18 = fs.readFileSync(path.join(REPO, 'lib', 'perf-table.js'), 'utf8');
  const ca18 = fs.readFileSync(path.join(REPO, 'app', 'calculators.js'), 'utf8');
  assert(!/'No approved changes in ' \+ periodYear/.test(re18), 'Year-to-Date page prints no "No approved changes" line (the Approved Changes page states it)');
  assert(/r\.expUsage > 0 \? \(sav \/ r\.expUsage\) \* 100 : null/.test(pt18) && /d\.savPc == null \? '&mdash;'/.test(pt18), 'meter table: Saved % is a dash when the baseline is 0');
  assert(!/'n\/a'/.test(ca18.slice(ca18.indexOf('avgTherm ?'), ca18.indexOf('avgPropGal ?') + 200)), 'Baseline Data: empty average price cells are a dash, not n/a');
  assert(/lead2\[2\] === title/.test(re18), 'a packed page whose first heading equals the page title prints it once');
  assert(/split\(\/\[\^\\S\\u00a0\]\+\//.test(fs.readFileSync(path.join(REPO, 'app', 'docx-writer.js'), 'utf8')) && /data-dx-fscale="0\.95"/.test(re18), 'Word: a no-break space keeps "billed kW" whole when the column widths are set, and the electricity by building table has room for it');
}

console.log('\n--- 19. v252 release: Q3 2026 report fixes ---');
{
  const re19 = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  const pt19 = fs.readFileSync(path.join(REPO, 'lib', 'perf-table.js'), 'utf8');
  const pol19 = fs.readFileSync(path.join(REPO, 'computations', 'pollution.js'), 'utf8');
  // Months add to the quarter total (one rule)
  const ms = run(ctx, '_rptMonthsShown')({ '2026-07': 8047.92, '2026-08': -5293.41, '2026-09': -9250.03 }, 3, -6496);
  assert(ms['2026-07'] === 8048 && ms['2026-08'] === -5294 && ms['2026-09'] === -9250 && ms['2026-07'] + ms['2026-08'] + ms['2026-09'] === -6496, 'the three printed months add to the quarter total -6,496 (one apportion rule)');
  assert(run(ctx, '_rptUseChange')(100.4, 162.7) === 63 && run(ctx, '_rptUseChange')(0, 5) === 5, 'one use change rule: the printed actual minus the printed baseline (v253)');
  // One cost header source
  const ch = run(ctx, '_rptCostHeads')({ project: { blEnd: 'December 2025' }, period: { year: 2026 } });
  assert(/^Baseline cost<br>\(2025&nbsp;rates\)$/.test(ch.bl) && /^Actual cost<br>\(2026&nbsp;rates\)$/.test(ch.cur) && /^Savings measured<br>\(2026&nbsp;rates\)$/.test(ch.sav), 'cost headers name the rate year, from one function');
  assert((re19.match(/_rptCostHeads\(d\)/g) || []).length >= 8, 'pages 3, 4, 5, 21, 22 and 23 take their cost headers from _rptCostHeads');
  // Labels
  assert(/Propane delivered \(gal\)/.test(re19) && /Propane Gal\(lons\)\?/.test(re19), 'propane headers read "Propane delivered (gal)"');
  assert(/<h2>Site EUI, annualized<\/h2>/.test(re19) && /National median<br>\(12-month,<br>kBtu\/ft&sup2;\/yr\)/.test(re19), 'p23 EUI table labels');
  assert(/white-space:nowrap">' \+ shortMo\(first\)/.test(re19), 'p23 EUI header month range does not break at the dash');
  assert(/Electricity demand \(billed&nbsp;kW, sum of /.test(re19) && /wxYear \? BR \+ '\(' \+ wxYear \+ BR \+ 'weather\)'/.test(pt19), 'kW row and meter table labels');
  const T19 = run(ctx, '_rptQTerms')({ project: { blStart: 'January 2025', blEnd: 'December 2025' }, period: { year: 2026 } });
  assert(/kWh is the unit of electricity use/.test(T19.units) && /kW is the unit of electricity demand/.test(T19.units) && !/kilowatt/i.test(T19.units) && /therm is/i.test(T19.units) && /gal is a gallon/.test(T19.units) && /kBtu\/ft/.test(T19.units) && /set point/i.test(T19.setPoint) && /Acct#/.test(T19.setPoint) && /Site EUI/.test(T19.eui), 'Appendix A defines kWh, kW, therm, gal, kBtu/ft2, set point, Acct# and Site EUI');
  assert(/replace\(\/National median, \/g, ''\)/.test(re19), 'Appendix A National median label is not repeated in its text');
  assert(/<p style="font-size:9\.5px;margin:6px 0 0">/.test(re19), 'the Baseline Data summary line has the table text size');
  // Equivalents from the EPA calculator table
  assert(/EQUIV_SOURCE/.test(pol19) && /1 \/ 4\.29/.test(pol19) && /1 \/ 0\.43/.test(pol19) && /1 \/ 7\.45/.test(pol19) && /1 \/ 0\.022/.test(pol19), 'p6 equivalents use the EPA Calculations and References factors from one table');
  assert(/_RPT_Q_W_FUEL = \[25, /.test(re19), 'fuel detail tables give the Building column 25% or more');
}

console.log('\n--- 20. v253 release: every printed change equals printed actual minus printed baseline ---');
{
  const re20 = fs.readFileSync(path.join(REPO, 'app', 'report-engine.js'), 'utf8');
  const uc = run(ctx, '_rptUseChange');
  // The v253 example cells (fractions chosen so the shown values round as in the Q3 2026 report)
  assert(uc(536.4, 808.6) === 273, 'p26 building 1 gas July 536 -> 809 prints +273');
  assert(uc(1210.6, 1213.5) === 3, 'p27 building 2 gas August 1,211 -> 1,214 prints +3');
  assert(uc(66874.6, 92390.4) === 25515, 'p27 building 2 kWh September 66,875 -> 92,390 prints +25,515');
  assert(uc(43.4, 54.4) === 11 && uc(44.4, 58.6) === 15, 'p29 building 4 kW August 43 -> 54 prints +11; September 44 -> 59 prints +15');
  assert(uc(129.4, 163.6) === 35, 'p29 building 4 kW total 129 -> 164 prints +35');
  assert(uc(167675.6, 229992.5) === 62317, 'p29/p11/p14 building 5 kWh total 167,676 -> 229,993 prints +62,317');
  assert(uc(781.7, 913.3) === 131, 'p30/p11 building 5 kW total 782 -> 913 prints +131');
  // Every table of the generated report: change = shown actual - shown baseline ("saved" = baseline - actual)
  const num = (t) => {
    const x = String(t).replace(/<[^>]+>/g, '').replace(/&minus;|\u2212/g, '-').replace(/&nbsp;|\u00a0|[$,+\s]/g, '').replace(/&mdash;|\u2014/g, '');
    return /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : null;
  };
  const head = (t) => String(t).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  let checked = 0;
  const bad = [];
  (allHtml.match(/<table[\s\S]*?<\/table>/g) || []).forEach((tb) => {
    const ths = (tb.match(/<th[\s\S]*?<\/th>/g) || []).map(head);
    const bi = ths.findIndex((h) => /^Baseline (kWh|therms|gal|billed kW)/i.test(h) || /^Baseline$/i.test(h));
    const ai = ths.findIndex((h) => /^Actual( |$)/.test(h) && !/cost/i.test(h));
    const ci = ths.findIndex((h) => /^Use change( kWh| therms| gal| kW)?$/.test(h) || /^(kWh|Therms|gal|kW) saved$/i.test(h));
    if (bi < 0 || ai < 0 || ci < 0) return;
    const saved = /saved$/i.test(ths[ci]);
    (tb.match(/<tr[\s\S]*?<\/tr>/g) || []).forEach((tr) => {
      if (/<th/.test(tr)) return;
      const cells = tr.match(/<td[\s\S]*?<\/td>/g) || [];
      const b = num(cells[bi]), a = num(cells[ai]), c = num(cells[ci]);
      if (b == null || a == null || c == null) return;
      checked++;
      if (c !== (saved ? b - a : a - b)) bad.push(head(cells[0]) + ': ' + b + ' ' + a + ' ' + c);
    });
  });
  assert(checked >= 20, 'the change check read the Building Summary, meter and Appendix B rows (' + checked + ' rows)');
  assert(bad.length === 0, 'every printed change equals the printed actual minus the printed baseline' + (bad.length ? ': ' + bad.slice(0, 5).join(' | ') : ''));
  const sp20 = flat.replace(/\s+/g, ' ');
  assert(!/Q1\+Q2 billed \(presented to the district\)/.test(sp20), 'p23: the billed figure is not printed twice (one row, on the last line)');
  assert(/Contract time elapsed: \d+% of the contract period/.test(sp20), 'p25 Terms: "Contract time elapsed"');
  assert(/white-space:nowrap;color:var\(--rpt-page-text\)/.test(re20) && /table-layout:fixed' : ''\) \+ '"' \+ \(_uq \? ' data-dx-widths="16,17,10,9,9,13,14,12"'/.test(re20), 'p5: the Period cells never wrap and the Period column has width');
  assert(/\(x == null \? '&mdash;' : _rptQN\(x\)\)/.test(re20), 'p31 Degree Days: an empty cell is an em dash');
}

console.log('\n--- 21. v254 release: one value for one figure (building electricity, meter total percent) ---');
{
  const fq21 = run(ctx, '_rptQFacts')(q3);
  // Data 1: a building electricity figure is its printed kWh row plus its printed billed kW row, for every building
  const allSum = q3.buildings.every((b) => fq21.parts[b.id].electric === fq21.parts[b.id].elecEnergy + fq21.parts[b.id].elecDemand);
  assert(allSum, 'data 1: each building electricity dollars = its kWh row + its billed kW row (one rule for all buildings)');
  const byFuel = run(ctx, '_rptQByFuelTable')(q3, fq21).replace(/<tr/g, '\n<tr');
  const usd = (t) => Number(String(t).replace(/[$,\s]/g, '').replace(/\u2212/g, '-'));
  const sumHtml21 = run(ctx, '_rptQBuildingSummaryPage')(1, q3, q3.buildings[0], fq21);
  const rowCells = (re) => {
    const r = re.exec(sumHtml21);
    return r ? (r[0].match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '')) : null;
  };
  const kwhCells = rowCells(/<tr><td>Electricity use \(kWh\)[\s\S]*?<\/tr>/);
  const kwCells = rowCells(/<tr><td>Electricity demand[\s\S]*?<\/tr>/);
  const fuelLine = byFuel.split('\n').find((l) => l.indexOf(q3.buildings[0].name) >= 0);
  const fuelCells = fuelLine ? (fuelLine.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map((c) => c.replace(/<[^>]+>/g, '')) : null;
  assert(kwhCells && kwCells && fuelCells && usd(kwhCells[kwhCells.length - 1]) + usd(kwCells[kwCells.length - 1]) === usd(fuelCells[1]), 'data 1: the Electricity by Building cell equals the two Building Summary rows (' + (kwhCells && kwCells ? kwhCells[kwhCells.length - 1] + ' + ' + kwCells[kwCells.length - 1] : '?') + ' = ' + (fuelCells && fuelCells[1]) + ')');
  // Data 2 and 3: the Total percent of a meter table is the exact saved use over the exact baseline (the figure of every row)
  const meterTotalCells = (rows, commodity) => {
    vm.runInContext('var __gmsOrig = getMeterSavings;', ctx);
    ctx.__rows = rows;
    vm.runInContext('getMeterSavings = function () { return { rows: __rows }; };', ctx);
    try {
      const m = { id: 'mx', commodity: commodity, baseline: { months: ['2024-07', '2024-08', '2024-09'] } };
      const html = vm.runInContext('buildMeterPerfTableHTML', ctx)(m, [], true, { mode: 'report', filterYMs: rows.map((r) => r.ym) }).html;
      const trs = html.match(/<tr[\s\S]*?<\/tr>/g).filter((r) => /<td/.test(r));
      return trs[trs.length - 1].match(/<td[^>]*>[\s\S]*?<\/td>/g).map((c) => c.replace(/<[^>]+>/g, '').replace(/\u2212/g, '-'));
    } finally {
      vm.runInContext('getMeterSavings = __gmsOrig;', ctx);
    }
  };
  const mk = (ym, e, a, rate) => ({ ym: ym, normDays: 30, expUsage: e, actUsage: a, unitRate: rate, savings: (e - a) * rate, kwhRate: 0, kwhCostSav: 0, blExpKW: 0, demKW: 0, bilKW: 0, kwRate: 0, kwCostSav: 0 });
  // propane: exact baseline 23.72 gal, none delivered; 24 gal printed; the percent is never above 100%
  const tp = meterTotalCells([mk('2026-07', 10.0, 0, 1.69), mk('2026-08', 7.72, 0, 1.69), mk('2026-09', 6.0, 0, 1.69)], 'Propane');
  assert(tp.some((c) => c === '+100.0%'), 'data 2: a propane total of 24 -> 0 gal prints +100.0% (' + tp.join(' | ') + ')');
  // gas: exact baseline 130.9, exact actual 3.4 -> 97.4%, the use change percent of the building page
  const tg = meterTotalCells([mk('2026-07', 0.4, 1.4, 0.9), mk('2026-08', 10.8, 0, 0.9), mk('2026-09', 119.7, 2.0, 0.9)], 'Gas');
  const exactPct = (((130.9 - 3.4) / 130.9) * 100).toFixed(1);
  assert(exactPct === '97.4' && tg.some((c) => c === '+97.4%'), 'data 3: a gas total prints the exact saved use over the exact baseline (+97.4%), the value of the building page (' + tg.join(' | ') + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

