// test-savings-methods-internal.js - the internal savings-methods section (computations/savings.js
// getProjectSavingsMethods, app/savings-methods.js):
//   1. the four-method math and the bridge identity (synthetic rows, no client data);
//   2. a month with no weather is "waiting", never 0;
//   3. the contract rule flag does not change the earlier-months rule unless asked;
//   4. NO report, export, portal or print module can reach the section (static scan of the whole repo).
// Run: node test-savings-methods-internal.js   Exit 0 = pass.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let fails = 0;
const ok = (c, msg) => {
  if (!c) {
    fails++;
    console.error('FAIL: ' + msg);
  } else console.log('ok: ' + msg);
};
const near = (a, b) => Math.abs(a - b) < 1e-6;

// ---- load the pure functions out of savings.js ----
const src = fs.readFileSync(path.join(ROOT, 'computations', 'savings.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  src +
    '\nthis.savingsMethodsForRow = savingsMethodsForRow; this.expectedUsageForMonth = expectedUsageForMonth; this.smProjectMethods = smProjectMethods; this.floorQuarterSavings = floorQuarterSavings;',
  sandbox,
);
const { savingsMethodsForRow, expectedUsageForMonth, smProjectMethods } = sandbox;
// the ONE shared projection (computations/csc.js), loaded the same way
const cscSandbox = {};
vm.createContext(cscSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'computations', 'csc.js'), 'utf8') + '\nthis.computeContractProjection = computeContractProjection;', cscSandbox);
const { computeContractProjection } = cscSandbox;

// ---- 1. math ----
const row = {
  weatherMissing: false,
  kwhRate: 0.1, unitRate: 0,
  actUsage: 1000, expUsage: 1100, blRawUsage: 900, blFitUsage: 800,
  kwRate: 10, bilKW: 50, blExpKW: 60, blRawKW: 45, blFitKW: 40,
};
const r = savingsMethodsForRow(row, true);
ok(near(r.E.m1, (900 - 1000) * 0.1), 'M1 energy = (raw baseline - actual) x rate');
ok(near(r.E.m2, (800 - 1000) * 0.1), 'M2 energy = (fitted at baseline weather - actual) x rate');
ok(near(r.E.m3, (900 - (1000 - (1100 - 800))) * 0.1), 'M3 energy = raw baseline vs actual moved to baseline weather');
ok(near(r.E.m4, (1100 - 1000) * 0.1), 'M4 energy = (fitted at actual weather - actual) x rate');
ok(near(r.K.m1, (45 - 50) * 10), 'M1 kW');
ok(near(r.K.m2, (40 - 50) * 10), 'M2 kW');
ok(near(r.K.m3, (45 - (50 - (60 - 40))) * 10), 'M3 kW');
ok(near(r.K.m4, (60 - 50) * 10), 'M4 kW');
const tot = (k) => r.E[k] + r.K[k];
ok(near(tot('m1') + (tot('m2') - tot('m1')) + (tot('m4') - tot('m2')), tot('m4')), 'bridge: M1 + fit gap + weather credit = M4');
ok(near(tot('m3') - tot('m1'), tot('m4') - tot('m2')), 'M3 - M1 equals the weather credit (M4 - M2)');
const g = savingsMethodsForRow({ weatherMissing: false, unitRate: 2, actUsage: 10, expUsage: 30, blRawUsage: 25, blFitUsage: 20 }, false);
ok(near(g.E.m4, 40) && near(g.K.m4, 0), 'gas row: M4 = (30 - 10) x 2, kW 0');

// ---- 2. waiting ----
const w = savingsMethodsForRow({ weatherMissing: true, expUsage: null, actUsage: 5 }, true);
ok(w.waiting === true && w.E === undefined && w.K === undefined, 'a month with no weather is waiting, with no dollars (never 0)');

// ---- 3. rule flag ----
const ctx = { blByCalMo: { 1: 500 }, blAvg: 400, weatherDriven: true, hasRegr: true };
const early = { ym: '2026-02', regrBaseline: 700, hdd: 1, cdd: 0 };
ok(expectedUsageForMonth(early, ctx).usage === 500, 'before 2026-07 the earlier rule is unchanged without the flag');
ok(expectedUsageForMonth(early, Object.assign({ allMonthsAtReportingWeather: true }, ctx)).usage === 700, 'with the flag the contract rule applies to an earlier month');
ok(expectedUsageForMonth({ ym: '2026-02', regrBaseline: null, hdd: null, cdd: 0 }, Object.assign({ allMonthsAtReportingWeather: true }, ctx)).weatherMissing === true, 'flag: missing weather is flagged, not read as 0');
ok(expectedUsageForMonth({ ym: '2026-08', regrBaseline: 900, hdd: 0, cdd: 5 }, ctx).usage === 900, 'from 2026-07 the contract rule applies without the flag');

// ---- 4. the section is internal: nothing client-facing reaches it ----
const NAMES = /getProjectSavingsMethods|smProjectMethods|smProjectionHtml|getMeterSavingsMethods|savingsMethodsForRow|savingsMethodsHtml|renderSavingsMethodsPanel|savingsMethodsPanel|allMonthsAtReportingWeather|app\/savings-methods\.js/;
const ALLOWED = new Set([
  'computations/savings.js', // the computation
  'app/savings-methods.js', // the panel
  'app/utility-data.js', // opens the panel from Utility Data (project panel bar)
  'energy-department.html', // button + script tag
  'test-savings-methods-internal.js', // this test
  'docs/OPERATIONS.md', // documentation
  'docs/companyhub-flows.json', // documentation
]);
const SKIP_DIR = new Set(['node_modules', '.git', 'weather-data']);
const hits = [];
(function walk(d) {
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) return SKIP_DIR.has(e.name) ? null : walk(path.join(d, e.name));
    if (!/\.(js|mjs|html|css|json)$/.test(e.name)) return;
    const rel = path.relative(ROOT, path.join(d, e.name)).split(path.sep).join('/');
    if (ALLOWED.has(rel)) return;
    let t;
    try {
      t = fs.readFileSync(path.join(d, e.name), 'utf8');
    } catch (x) {
      return;
    }
    if (NAMES.test(t) || /recomputed, internal/i.test(t)) hits.push(rel);
  });
})(ROOT);
ok(hits.length === 0, 'no other file refers to the internal section' + (hits.length ? ': ' + hits.join(', ') : ''));

// the allowed files that are NOT the panel opener must not be report code
const REPORT_FILES = fs
  .readdirSync(path.join(ROOT, 'app'))
  .filter((f) => /^(report-|docx-|soo-|estimate-workbook)/.test(f) || f === 'presented-savings.js')
  .map((f) => 'app/' + f);
REPORT_FILES.forEach((f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return;
  const t = fs.readFileSync(p, 'utf8');
  ok(!NAMES.test(t) && !/recomputed, internal/i.test(t) && !/Savings methods/i.test(t), f + ' does not contain the internal section');
});
// the panel is opened from the Utility Data project panel only, and only that dispatch calls it
const ud = fs.readFileSync(path.join(ROOT, 'app', 'utility-data.js'), 'utf8');
ok((ud.match(/renderSavingsMethodsPanel/g) || []).length === 1, 'utility-data.js calls the panel from exactly one place');
// the panel text is escaped
const panel = fs.readFileSync(path.join(ROOT, 'app', 'savings-methods.js'), 'utf8');
ok(/_escHtml\(b\.name\)/.test(panel) && /_escHtml\(q\.label/.test(panel), 'panel escapes building and quarter text');

// ---- 5. 3-year projection per method: synthetic quarters, the shared projection ----
// Contract: 3 years, annual target 4000 (Q targets 1000 each), escalation 10%, split 60/40.
const mkQ = (key, months, waiting, m) => ({
  key, label: key.replace('-Q', ' Q'), months, total: { waiting, E: { m1: m[0], m2: m[1], m3: m[2], m4: m[3] }, K: { m1: 0, m2: 0, m3: 0, m4: 0 } },
});
const M3 = ['01', '02', '03'].map((x) => '2026-' + x);
const quarters = [
  mkQ('2026-Q4', ['2026-10'], ['2026-10'], [0, 0, 0, 0]), // 1 month, waiting: left out and named
  mkQ('2026-Q3', M3, [], [-500, 100, -200, -300]), // negative: floored to 0
  mkQ('2026-Q2', M3, [], [1500, 1800, 1400, 1700]),
  mkQ('2026-Q1', M3, [], [800, 900, 700, 1000]),
];
const project = (acts, q) =>
  computeContractProjection({ annualTarget: 4000, escalationPct: 10, contractYears: 3, cscPct: 60, clientPct: 40, currentYear: 1, quarter: q, quarterlyActuals: acts, quarterlyTargets: [1000, 1000, 1000, 1000] });
const pr = smProjectMethods(quarters, project);
ok(pr && pr.year === '2026' && pr.quarter === 3, 'projection runs through the newest complete quarter (2026 Q3)');
ok(pr.excluded.length === 1 && pr.excluded[0].label === '2026 Q4' && /weather/.test(pr.excluded[0].why), 'a quarter waiting for weather is left out and named');
const yr2 = Math.round(4000 * 1.1), yr3 = Math.round(4000 * 1.21);
const byK = {};
pr.rows.forEach((x) => (byK[x.k] = x));
// M1: Q1 800 + Q2 1500 + Q3 floor(-500)=0, plus Q4 target 1000 in year 1
ok(byK.m1.toDate === 2300 && byK.m1.total === 2300 + 1000 + yr2 + yr3 && byK.m1.remaining === byK.m1.total - 2300, 'M1: to date 2300 (Q3 floored at $0); total = year 1 + year 2 + year 3');
ok(byK.m2.toDate === 900 + 1800 + 100 && byK.m4.toDate === 1000 + 1700, 'M2 and M4 sums of floored quarters');
ok(byK.m4.total === 2700 + 1000 + yr2 + yr3 && byK.m4.target === 4000 + yr2 + yr3, 'M4 total and the contract target (4000 + escalated years 2 and 3)');
const direct = project([1000, 1700, 0, null], 3).totalSavings;
ok(byK.m4.total === direct, 'M4 equals the shared projection called directly');
const billed = smProjectMethods(quarters, project, () => 1234);
ok(billed.rows.find((x) => x.k === 'm4').toDate === 3 * 1234 && billed.rows.find((x) => x.k === 'm1').toDate === 2300, 'billedOf replaces M4 quarters only');
ok(smProjectMethods([quarters[0]], project) === null, 'no complete quarter: no projection');
ok(/_escHtml\(basis\)/.test(panel) && /_escHtml\(usd\(v\)\)/.test(panel) && /_escHtml\(h\)/.test(panel), 'projection block escapes its text');

if (fails) {
  console.error(fails + ' check(s) failed');
  process.exit(1);
}
console.log('all checks passed');
