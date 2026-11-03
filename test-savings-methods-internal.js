// test-savings-methods-internal.js - the Savings Methods comparison (computations/savings.js
// normalizedBillsAtBaselineWeather, getMeterSavings opts.normalizedBills, getProjectSavingsComparison;
// app/savings-methods.js). Contract method = billed. Normalized bills = comparison only.
//   1. normalized bill math (synthetic, hand computed): fit the post-baseline months, read at the baseline weather;
//   2. no fit = no normalized value (the real bill stays);
//   3. the billed path never reads the comparison: the contract rule is unchanged, the option is off by default;
//   4. NO report, export, portal or print module can reach the section (static scan of the whole repo);
//   5. the panel labels and escapes its text.
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

// ---- load the pure functions the comparison uses ----
const sandbox = {};
vm.createContext(sandbox);
['lib/date-helpers.js', 'computations/regression.js', 'computations/savings.js'].forEach((f) =>
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }),
);
vm.runInContext('this.nb = normalizedBillsAtBaselineWeather; this.exp = expectedUsageForMonth;', sandbox);
const { nb, exp: expectedUsageForMonth } = sandbox;

// ---- 1. math: usage per day = 1 + 2 x (HDD per day), 30-day months, so the fit is exact ----
const mk = (ym, hdd) => ({ ym, days: 30, normDays: 30, hdd, cdd: 0, usage: 30 * 1 + 2 * hdd, partial: false });
const post = [mk('2026-04', 100), mk('2026-06', 20), mk('2026-09', 60), mk('2026-11', 300)];
const bl = [{ ym: '2025-04', hdd: 50, cdd: 0 }, { ym: '2025-06', hdd: 10, cdd: 0 }];
const r1 = nb(post, bl, 'Gas', 'calendar');
ok(near(r1.usageByYm['2026-04'], 30 + 2 * 50), 'April normalized bill = the post-baseline fit read at the April baseline weather (30 + 2 x 50)');
ok(near(r1.usageByYm['2026-06'], 30 + 2 * 10), 'June normalized bill = fit at the June baseline weather');
ok(r1.usageByYm['2026-09'] === undefined && r1.usageByYm['2026-11'] === undefined, 'a month with no baseline-year weather has no normalized bill (the real bill stays)');
// the baseline weather is the mean over baseline years of that calendar month
const bl2 = [{ ym: '2024-04', hdd: 40, cdd: 0 }, { ym: '2025-04', hdd: 60, cdd: 0 }];
ok(near(nb(post, bl2, 'Gas', 'calendar').usageByYm['2026-04'], 30 + 2 * 50), 'baseline weather = mean of the baseline years for that month');

// rows billed over 15 days of a 30-day month are scaled to the calendar month (usage x normDays / days) before the fit
const half = post.map((r) => Object.assign({}, r, { days: 15, usage: r.usage / 2 }));
ok(near(nb(half, bl, 'Gas', 'calendar').usageByYm['2026-04'], 30 + 2 * 50), 'bills over fewer days than the month are scaled to the calendar month before the fit');

// ---- 2. no fit ----
const r2 = nb([mk('2026-04', 100), mk('2026-06', 20)], bl, 'Gas', 'calendar');
ok(Object.keys(r2.usageByYm).length === 0, 'fewer than 3 usable months: no normalized values');

// ---- 3. the contract rule is unchanged ----
ok(expectedUsageForMonth({ ym: '2026-02', regrBaseline: 700, hdd: 1, cdd: 0 }, { blByCalMo: { 1: 500 }, blAvg: 400 }).usage === 500, 'contract rule: baseline-year value for the calendar month, not the reporting-month weather');
const sav = fs.readFileSync(path.join(ROOT, 'computations', 'savings.js'), 'utf8');
ok(!/REPORTING_WEATHER_FROM_YM|allMonthsAtReportingWeather|internalFittedUsageAtMonthWeather/.test(sav), 'no reporting-month-weather rule remains in savings.js');
const code = sav.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
ok((code.match(/opts\.normalizedBills/g) || []).length === 5 && /nz = opts\.normalizedBills\s*\?/.test(code),'getMeterSavings reads opts.normalizedBills in five places only: three cache bypasses, the setup, the extra row fields');
const cmpFn = sav.slice(sav.indexOf('function getMeterSavingsComparison'), sav.indexOf('function getProjectSavingsComparison'));
ok((sav.match(/normalizedBills: true/g) || []).length === 1 && cmpFn.indexOf('normalizedBills: true') > 0, 'only getMeterSavingsComparison turns the comparison on');

// ---- 4. the section is internal: nothing client-facing reaches it ----
const NAMES = /getProjectSavingsComparison|getMeterSavingsComparison|normalizedBillsAtBaselineWeather|savingsMethodsHtml|savingsMethodsPanel|opts\.normalizedBills|app\/savings-methods\.js/;
const ALLOWED = new Set([
  'computations/savings.js', // the computation
  'app/savings-methods.js', // the panel
  'app/utility-data.js', // draws the section in Project > Performance
  'energy-department.html', // script tag
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
    if (NAMES.test(t) ) hits.push(rel);
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
  ok(!NAMES.test(t) && !/Savings Methods Comparison/i.test(t), f + ' does not contain the internal section');
});
// Project > Performance draws the section from exactly one place
const ud = fs.readFileSync(path.join(ROOT, 'app', 'utility-data.js'), 'utf8');
ok((ud.match(/savingsMethodsHtml\(/g) || []).length === 1, 'utility-data.js draws the section from exactly one place');

// ---- 5. the panel ----
const panel = fs.readFileSync(path.join(ROOT, 'app', 'savings-methods.js'), 'utf8');
ok(/Contract method \(billed\)/.test(panel) && /Bills normalized for weather and dates \(comparison\)/.test(panel), 'panel uses the two plain labels');
ok(/not billed/i.test(panel) && !/reporting-month weather|reporting month weather/i.test(panel), 'panel says the comparison is not billed and never says reporting-month weather');
ok(/_escHtml\(q\.label/.test(panel) && /_escHtml\(tip\)/.test(panel), 'panel escapes quarter text and hover text');
ok(!/#[0-9a-fA-F]{3,6}/.test(panel), 'panel uses site colors only (no hex)');

if (fails) {
  console.error(fails + ' check(s) failed');
  process.exit(1);
}
console.log('all checks passed');
