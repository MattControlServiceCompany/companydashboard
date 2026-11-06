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
assert(/\$26,948 billed through Q3 2026 plus the \$100 contract target for the remaining quarter\./.test(contract), 'basis line printed under the contract totals table');

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
  assert(/Baseline is the use a meter would have had with no savings measures/.test(sp) && /Savings billed is the amount invoiced under the contract/.test(sp), 'page 1 defines baseline and savings billed in plain words');
  assert(/It is a weather model of the use of the meter, [A-Za-z]+ \d{4} through [A-Za-z]+ \d{4}, evaluated at the \d{4} weather \(billed kW: the weather of the month reported\)\./.test(sp) && !/weather normalized|weather-adjusted|adjusted for weather/.test(sp), 'baseline term: "a weather model of the use of the meter, <start> through <end>, evaluated at the <year> weather"; the words "weather normalized" and "weather-adjusted" are gone');
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
  assert(/Baseline billed kW for a month = 100\.0000 \+ 0\.2500 x cooling degree days\. R&sup2; 0\.500; 12 baseline months; CV\(RMSE\) 10\.0%\./.test(String(kwBlock).replace(/&times;/g, 'x')), 'Appendix B prints the kW formula per meter: ' + String(kwBlock).slice(0, 160));
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
  assert((appBtxt.match(/R² 0\.912; 12 baseline months; CV\(RMSE\) 8\.4%\./g) || []).length === 3, 'Appendix B: the electricity model prints R2, n and CV(RMSE) (3 buildings)');
  assert((appBtxt.match(/R² 0\.970; 12 baseline months; CV\(RMSE\) 5\.2%\./g) || []).length === 3, 'Appendix B: the gas model prints R2, n and CV(RMSE) (3 buildings)');
  assert((appBtxt.match(/R² 0\.463; 12 baseline months; CV\(RMSE\) 13\.1%\./g) || []).length === 3, 'Appendix B: the billed kW model prints R2, n and CV(RMSE) (3 buildings)');
  assert(!/NMBE/.test(appBtxt), 'NMBE is not printed (0 by construction after the bias correction)');
  assert(/- 0\.50 x cooling degree days/.test(appBtxt), 'the wrong-sign term stays in the formula, unchanged');

  // Terms: points 3, 15, 22 (page 1 and Appendix A use the same term strings)
  const dT = { project: { blStart: 'January 2025', blEnd: 'December 2025' }, period: { year: 2026 } };
  const T = run(ctx, '_rptQTerms')(dT);
  assert(T.baseline === 'Baseline is the use a meter would have had with no savings measures. It is a weather model of the use of the meter, January 2025 through December 2025, evaluated at the 2025 weather (billed kW: the weather of the month reported).', 'baseline term states the weather model and the 2025 weather: ' + T.baseline);
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
  assert(/Contract Totals/.test(ctPage) && /Billed to date plus contract targets/.test(ctPage) && !/Projection|projected|if remaining targets are met|Savings target/.test(ctPage), 'contract page: "Contract Totals", "Billed to date plus contract targets", no projection wording');
  assert(/contract target at the 3\.5% annual energy cost escalation stated in the Agreement/.test(ctPage) && !/escalated 3\.5% a year/.test(ctPage), 'contract page: the 3.5% is attributed to the Agreement');
  assert(/Allocated target/.test(ctPage), 'contract page: column "Allocated target"');

  // CBECS edition (point 13): printed for a K-12 school at 48.5 only
  const dC = pageData();
  dC.buildings.forEach((b) => { b.type = 'K-12 School'; b.eui = { baseline: 50, current: 48, cbecs: 48.5 }; });
  const benchK = plain(run(ctx, '_rptQBenchmarkPage')(10, dC, f));
  assert(/National median, K-12 schools: 48\.5 kBtu\/ft²\/yr, from the U\.S\. Energy Information Administration 2012 Commercial Buildings Energy Consumption Survey \(CBECS\), as published in the ENERGY STAR Portfolio Manager U\.S\. national median table/.test(benchK), 'benchmark note names the 2012 CBECS and the ENERGY STAR table for K-12 at 48.5: ' + benchK.slice(benchK.indexOf('National median'), benchK.indexOf('National median') + 260));
  dC.buildings.forEach((b) => { b.type = 'Office Building'; b.eui = { baseline: 50, current: 48, cbecs: 52.9 }; });
  const benchO = plain(run(ctx, '_rptQBenchmarkPage')(10, dC, f));
  assert(!/2012/.test(benchO) && /\(CBECS\)/.test(benchO), 'no survey year is printed for a value whose edition is not confirmed');

  // Entered months (point 20): a baseline month whose bill has no bill file says "entered"
  const bData = { name: 'Alpha Building', sqft: 10000, blMonths: ['2025-03', '2025-04'], baselineEntered: { 3: ['Gas'] },
    baselineMaps: { elecByMo: {}, propaneByMo: {}, gasByMo: { 2: { therms: 300, cost: 240, hdd: 200, cdd: 0 }, 3: { therms: 200, cost: 160, hdd: 100, cdd: 5 } } } };
  const blTxt = plain(run(ctx, '_rptQBaselineDataBody')(bData, d));
  assert(/April 2025, gas entered/.test(blTxt) && !/March 2025, /.test(blTxt) && !/Entered:/.test(blTxt), 'Baseline Data: "April 2025, gas entered", no note; March (bill file attached) is not marked');
  bData.baselineEntered = {};
  assert(!/entered/i.test(plain(run(ctx, '_rptQBaselineDataBody')(bData, d))), 'Baseline Data: nothing is marked when every bill has a bill file');

  // Old wording is gone from the whole quarterly report text (all sections) and from the report source (release notes keep their history)
  assert(!/weather[- ](adjusted|normali[sz]ed)/i.test(flat), 'the quarterly report, all sections, has no "weather-adjusted" or "weather normalized"');
  const reSrc = fs.readFileSync(path.join(REPO, 'app/report-engine.js'), 'utf8');
  ['weather normalized', 'Savings target', 'Saved, below target', "'Met target'", 'Savings if remaining targets are met'].forEach((w) =>
    assert(reSrc.indexOf(w) < 0, 'report-engine.js no longer contains "' + w + '"'),
  );
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

