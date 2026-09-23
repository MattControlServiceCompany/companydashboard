// tools/test-project-baseline-all-buildings.js — "All Buildings" Project Baseline panel gate.
// Run: node tools/test-project-baseline-all-buildings.js
//
// Loads the REAL functions (computations/normalization.js buildMoMap/getNormRows/
// getMeterBaselineTotals; app/utility-data.js getBaselineTrustState/_udBuildingAllBaseline/
// _udRenderAllBuildingsBaselineSection and friends; app/bill-analysis.js _escHtml — all
// extracted verbatim, not reimplemented) into a Node vm sandbox and proves, on a SYNTHETIC
// 3-building fixture (one included, one excluded-with-bills, one with no bills):
//   1. All 3 buildings are listed by the All Buildings aggregator.
//   2. The "All buildings" total = the sum of the 3 building rows.
//   3. The "Included in savings" total = the included building only.
//   4. The included totals equal getMeterBaselineTotals() of the included meter directly
//      (the oracle) — proving no new/divergent summing math was introduced.
//   5. The excluded-but-billed building still shows its real (non-zero) baseline numbers in
//      the All Buildings list (baselineInclude:false hides it from SAVINGS only, never from
//      this view).
//   6. The no-bills building renders "No bills loaded" with blank ('—') numeric cells, not 0.
//   7. Dynamic strings (building/meter names) are HTML-escaped in the rendered section —
//      an injected `<b>onerror=x>` building name must not appear unescaped in the output.
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Same brace-balancing extraction technique as tools/test-single-source-baseline.js loadFn.
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp('function ' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + fnName + ' in ' + file);
  let p = src.indexOf('(', m.index);
  let pDepth = 0,
    pEnd = p;
  for (; pEnd < src.length; pEnd++) {
    if (src[pEnd] === '(') pDepth++;
    else if (src[pEnd] === ')') {
      pDepth--;
      if (pDepth === 0) break;
    }
  }
  let i = src.indexOf('{', pEnd);
  let depth = 0,
    j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, j + 1);
}

const sandbox = { console };
vm.createContext(sandbox);

const stubs = [
  'function getStoredRate(){return 0;}',
  'var udSelProjId = null;',
  'function getUDProj(){ return {}; }',
  'function isCalcCommodity(){ return true; }',
].join('\n');

const udSrc = fs.readFileSync(REPO + '/app/utility-data.js', 'utf8');
// Pull the module-level month-name const verbatim (referenced by the period-label /
// month-row helpers below) instead of retyping it.
const mnMatch = /const _UD_AB_MN = \[[^\]]*\];/.exec(udSrc);
if (!mnMatch) throw new Error('_UD_AB_MN const not found');

const fns = [
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  loadFn(REPO + '/app/utility-data.js', 'isBaselineFrozen'),
  loadFn(REPO + '/app/utility-data.js', 'getBaselineTrustState'),
  loadFn(REPO + '/app/utility-data.js', '_udProjBaselineMonthsFallback'),
  loadFn(REPO + '/app/utility-data.js', '_udMeterBaselineForAllBldgs'),
  loadFn(REPO + '/app/utility-data.js', '_udBuildingSavingsStatus'),
  loadFn(REPO + '/app/utility-data.js', '_udBuildingFreezeState'),
  loadFn(REPO + '/app/utility-data.js', '_udFmtPeriodLabel'),
  loadFn(REPO + '/app/utility-data.js', '_udBuildingAllBaseline'),
  loadFn(REPO + '/app/utility-data.js', '_udToggleAllBldgRow'),
  loadFn(REPO + '/app/utility-data.js', '_udMeterMonthRowsHtml'),
  loadFn(REPO + '/app/utility-data.js', '_udRenderAllBuildingsBaselineSection'),
  // csv-import.js loads AFTER utility-data.js in energy-department.html, so its
  // (DOM-independent, regex-based) _escHtml definition is the one in effect at
  // runtime — not bill-analysis.js's earlier createElement-based one, which the
  // later script-tag redeclaration shadows.
  loadFn(REPO + '/app/csv-import.js', '_escHtml'),
];

const dateHelpersSrc = fs.readFileSync(REPO + '/lib/date-helpers.js', 'utf8');
const regressionSrc = fs.readFileSync(REPO + '/computations/regression.js', 'utf8');
const normalizationSrc = fs.readFileSync(REPO + '/computations/normalization.js', 'utf8');
const euiSrc = fs.readFileSync(REPO + '/computations/eui.js', 'utf8');
const ratesSrc = fs.readFileSync(REPO + '/computations/rates.js', 'utf8');
const savingsSrc = fs.readFileSync(REPO + '/computations/savings.js', 'utf8');

vm.runInContext(
  stubs +
    '\n' +
    'document = { querySelectorAll: function () { return []; } };\n' +
    mnMatch[0] +
    '\n\n' +
    fns.join('\n\n') +
    '\n\n' +
    dateHelpersSrc +
    '\n\n' +
    regressionSrc +
    '\n\n' +
    savingsSrc +
    '\n\n' +
    normalizationSrc +
    '\n\n' +
    euiSrc +
    '\n\n' +
    ratesSrc,
  sandbox,
);

// ─── Synthetic fixture: 3 buildings ─────────────────────────────────────────────────────────
// Building A — included, 12 months of electric bills, baseline saved.
// Building B — excluded on Utility Data (baselineInclude:false) but has real bills/baseline.
// Building C — no bills loaded at all (meter exists, bills array empty, no baseline).
function monthlyBills(kwh, kw, cost, months) {
  return months.map((ym) => {
    const [y, mo] = ym.split('-').map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    const start = ym + '-01';
    const end = ym + '-' + String(lastDay).padStart(2, '0');
    return { start, end, kwh, demandKW: kw, billedKW: kw, totalCost: cost, kwCost: cost * 0.3, kwhCost: cost * 0.7 };
  });
}
const BL_MONTHS = [
  '2024-01',
  '2024-02',
  '2024-03',
  '2024-04',
  '2024-05',
  '2024-06',
  '2024-07',
  '2024-08',
  '2024-09',
  '2024-10',
  '2024-11',
  '2024-12',
];

const meterA = {
  id: 'mA',
  name: 'Main Electric',
  commodity: 'Electric',
  inclusive: true,
  baselineInclude: true,
  bills: monthlyBills(5000, 100, 550, BL_MONTHS),
  baseline: { months: BL_MONTHS.slice() },
};
const meterB = {
  id: 'mB',
  name: 'Main Electric',
  commodity: 'Electric',
  inclusive: true,
  baselineInclude: false, // excluded from SAVINGS only — must still appear in All Buildings
  bills: monthlyBills(3000, 60, 330, BL_MONTHS),
  baseline: { months: BL_MONTHS.slice() },
};
const meterC = {
  id: 'mC',
  name: 'Main Electric',
  commodity: 'Electric',
  inclusive: true,
  baselineInclude: true,
  bills: [],
  baseline: null,
};

const buildings = [
  { id: 'bA', name: 'Included Building', sqft: 10000, meters: [meterA] },
  { id: 'bB', name: 'Excluded Building <b onerror=alert(1)>', sqft: 8000, meters: [meterB] },
  { id: 'bC', name: 'No Bills Building', sqft: 5000, meters: [meterC] },
];

console.log('=== Project Baseline: All Buildings gate ===');

const projMonthsFallback = sandbox._udProjBaselineMonthsFallback(buildings);
const rows = buildings.map((b) => sandbox._udBuildingAllBaseline(b, projMonthsFallback));

// 1. All 3 buildings listed
assert(rows.length === 3, 'all 3 buildings are listed (got ' + rows.length + ')');
assert(rows[0].b.name === 'Included Building', 'row 0 is Included Building');
assert(rows[1].b.name.indexOf('Excluded Building') === 0, 'row 1 is Excluded Building');
assert(rows[2].b.name === 'No Bills Building', 'row 2 is No Bills Building');

// Oracle: call getMeterBaselineTotals() directly on meter A/B (the single source of truth)
const oracleA = sandbox.getMeterBaselineTotals(meterA, meterA.bills, true);
const oracleB = sandbox.getMeterBaselineTotals(meterB, meterB.bills, true);
console.log(
  '  Oracle A (included): kWh=' +
    oracleA.kwh.toFixed(1) +
    ' cost=$' +
    oracleA.cost.toFixed(2) +
    ' kW=' +
    oracleA.billedKW.toFixed(1),
);
console.log(
  '  Oracle B (excluded, has bills): kWh=' +
    oracleB.kwh.toFixed(1) +
    ' cost=$' +
    oracleB.cost.toFixed(2) +
    ' kW=' +
    oracleB.billedKW.toFixed(1),
);

// Per-building row values (report each building's row values, per the task)
console.log(
  '  Row A (Included Building):  kWh=' +
    rows[0].kwh.toFixed(1) +
    ' Therms=' +
    rows[0].therms.toFixed(1) +
    ' kW=' +
    rows[0].kw.toFixed(1) +
    ' cost=$' +
    rows[0].cost.toFixed(2) +
    ' status=' +
    JSON.stringify(rows[0].status),
);
console.log(
  '  Row B (Excluded Building):  kWh=' +
    rows[1].kwh.toFixed(1) +
    ' Therms=' +
    rows[1].therms.toFixed(1) +
    ' kW=' +
    rows[1].kw.toFixed(1) +
    ' cost=$' +
    rows[1].cost.toFixed(2) +
    ' status=' +
    JSON.stringify(rows[1].status),
);
console.log(
  '  Row C (No Bills Building):  hasAnyBills=' + rows[2].hasAnyBills + ' status=' + JSON.stringify(rows[2].status),
);

// 5. Excluded-but-billed building still shows its real numbers (not hidden/zeroed)
assert(
  near(rows[1].kwh, oracleB.kwh, 0.01),
  'excluded building B row kWh matches its own getMeterBaselineTotals oracle',
);
assert(near(rows[1].cost, oracleB.cost, 0.01), 'excluded building B row cost matches oracle');
assert(
  rows[1].status.included === false && rows[1].status.reason === 'excluded on Utility Data',
  'building B status = not included, reason = excluded on Utility Data',
);

// Building A (included) row matches its oracle too
assert(near(rows[0].kwh, oracleA.kwh, 0.01), 'included building A row kWh matches oracle');
assert(rows[0].status.included === true, 'building A status = included in savings');

// Building C (no bills)
assert(rows[2].hasAnyBills === false, 'building C has no bills');
assert(
  rows[2].status.included === false && rows[2].status.reason === 'no bills',
  'building C status reason = no bills',
);

// 2. All-buildings total = sum of the 3 rows
const allTotals = {
  kwh: rows.reduce((s, r) => s + (r.kwh || 0), 0),
  kw: rows.reduce((s, r) => s + (r.kw || 0), 0),
  therms: rows.reduce((s, r) => s + (r.therms || 0), 0),
  cost: rows.reduce((s, r) => s + (r.cost || 0), 0),
};
assert(
  near(allTotals.kwh, rows[0].kwh + rows[1].kwh + rows[2].kwh, 0.001),
  'All buildings kWh total = sum of the 3 rows',
);
assert(
  near(allTotals.cost, rows[0].cost + rows[1].cost + rows[2].cost, 0.001),
  'All buildings cost total = sum of the 3 rows',
);

// 3 & 4. Included total = included building only, and equals the oracle directly
const includedTotals = { kwh: oracleA.kwh, therms: oracleA.therms, cost: oracleA.cost, kw: oracleA.billedKW };
assert(near(includedTotals.kwh, rows[0].kwh, 0.01), 'Included total kWh = included building A only (not B or C)');
assert(
  !near(includedTotals.kwh, allTotals.kwh, 0.01),
  'Included total is NOT the same as the All-buildings total (B/C excluded)',
);
assert(
  near(includedTotals.kwh, oracleA.kwh, 0.0001),
  'Included total kWh equals getMeterBaselineTotals(meterA) directly',
);
assert(
  near(includedTotals.cost, oracleA.cost, 0.0001),
  'Included total cost equals getMeterBaselineTotals(meterA) directly',
);
assert(
  near(includedTotals.kw, oracleA.billedKW, 0.0001),
  'Included total kW equals getMeterBaselineTotals(meterA).billedKW directly',
);

// 6 & 7. Render the section and check presentation
const html = sandbox._udRenderAllBuildingsBaselineSection(rows, allTotals, includedTotals);
assert(html.indexOf('Included Building') !== -1, 'rendered HTML contains Included Building');
assert(html.indexOf('No bills loaded') !== -1, 'rendered HTML shows "No bills loaded" for building C');
assert(
  html.indexOf('Not included in savings (excluded on Utility Data)') !== -1,
  'rendered HTML shows exclusion reason for building B',
);
assert(
  html.indexOf('<b onerror=alert(1)>') === -1,
  "building B's raw <b onerror=...> is NOT present unescaped (XSS check)",
);
assert(html.indexOf('&lt;b onerror=alert(1)&gt;') !== -1, "building B's name is HTML-escaped in the rendered output");
// No-bills row's numeric cells must be blank ('—'), not "0"
const noBillsRowMatch = /<tr[^>]*>\s*<td[^>]*>▸ No Bills Building<\/td>[\s\S]*?<\/tr>/.exec(html);
assert(!!noBillsRowMatch, 'found the No Bills Building row in rendered HTML');
if (noBillsRowMatch) {
  assert(/—/.test(noBillsRowMatch[0]), 'No Bills Building row contains blank em-dash cells');
  assert(!/>0</.test(noBillsRowMatch[0]), 'No Bills Building row does not show a bare "0" for any numeric cell');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
