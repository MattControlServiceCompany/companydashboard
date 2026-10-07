/**
 * gate-single-day-count.js  (WP-08, math-audit 2026-09-28)
 *
 * Gate: a billing-period day count is made by ONE function, calcDays (app/utility-data.js), with the
 * meter's Inclusive/Exclusive toggle passed in. Fails when:
 *   1. app/utility-data.js does not define calcDays.
 *   2. A file in app/, computations/, extraction/ or lib/ does its own millisecond-to-day math
 *      (/ 86400000, / 864e5, / (1000 * 60 * 60 * 24), * 24 * 3600 * 1000 ...) on a line that is not in
 *      ALLOWED below. ALLOWED lists the few sites that are NOT a bill day count: a gap/overlap tolerance
 *      between two dates, a rolling time window, a countdown to a due date, or a ms-per-year constant.
 *      A new entry needs a reason.
 *   3. report-engine-woodland.js falls back to the calendar days of the month for a blank numberOfDays.
 *
 * Usage: node tools/gate-single-day-count.js [repo-root]
 */
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const DIRS = ['app', 'computations', 'extraction', 'lib'];
const MS_DAY =
  /\b86400000\b|\b864e5\b|\b1000\s*\*\s*60\s*\*\s*60\s*\*\s*24\b|\b24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\b|\b24\s*\*\s*3600\s*\*\s*1000\b/i;

// [file, exact text that must appear on the line, reason]
const ALLOWED = [
  ['app/utility-data.js', 'const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));', 'calcDays itself'],
  [
    'app/estimate-workbook-export.js',
    'Date.UTC(1899, 11, 30)) / 86400000',
    'Excel date serial, not a billing day count',
  ],
  ['app/bas-alarms.js', 'var msPerDay = 86400000;', 'time-window filter on alarm timestamps'],
  ['app/bill-analysis.js', 'Date.now() + 86400000 * 60', 'future-date sanity window'],
  ['app/bill-analysis.js', '(p1 - p2) / 86400000', 'meter-read date closeness (tolerance)'],
  ['app/bill-analysis.js', 'toDate(prevEnd)) / 86400000', 'gap between two bills (tolerance)'],
  ['app/bill-analysis.js', '(da - db) / 86400000', 'fuzzy period match (tolerance)'],
  ['app/core.js', '(due - NOW) / (1000 * 60 * 60 * 24)', 'countdown to a due date from now'],
  [
    'app/db.js',
    'DELETED_ITEM_RETENTION_MS = 90 * 24 * 60 * 60 * 1000',
    'deletion-record retention window (sync engine)',
  ],
  ['app/energy-savings.js', '180 * 86400000', 'year-boundary window'],
  ['app/energy-savings.js', 'Math.abs(mrd - bp) / 86400000', 'meter-read date closeness (tolerance)'],
  ['app/energy-savings.js', '(da - db) / 86400000', 'duplicate-period closeness (tolerance)'],
  ['app/energy-savings.js', '20 * 86400000', 'cluster window'],
  ['app/report-engine.js', '365.25 * 86400000', 'ms per year constant'],
  ['computations/data-quality.js', '(curDate - prevDate) / 86400000', 'gap between two bills (tolerance)'],
  [
    'computations/normalization.js',
    'const gapDays = (s - _parseISO(prevEnd))',
    'chain gap between two bills (tolerance)',
  ],
  ['computations/normalization.js', 'return (s - e) / (1000 * 60 * 60 * 24) > 3;', 'detectGap (tolerance)'],
  [
    'computations/normalization.js',
    'const days = Math.round((spanEnd - cur)',
    'propane delivery month split (half-open date span)',
  ],
];

const problems = [];
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.js$/.test(name) && !/\.gate\.js$/.test(name)) out.push(full);
  }
  return out;
}

const ud = path.join(REPO, 'app/utility-data.js');
if (!fs.existsSync(ud) || !/function\s+calcDays\s*\(/.test(fs.readFileSync(ud, 'utf8'))) {
  problems.push('app/utility-data.js does not define calcDays');
}

const used = new Set();
for (const d of DIRS) {
  for (const file of walk(path.join(REPO, d), [])) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!MS_DAY.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const hit = ALLOWED.findIndex((a) => a[0] === rel && line.includes(a[1]));
        if (hit >= 0) used.add(hit);
        else problems.push(rel + ':' + (i + 1) + ' inline day math (use calcDays): ' + line.trim().slice(0, 110));
      });
  }
}
ALLOWED.forEach((a, i) => {
  if (!used.has(i)) problems.push('stale ALLOWED entry (site is gone, delete it): ' + a[0] + ' :: ' + a[1]);
});

const wd = path.join(REPO, 'app/report-engine-woodland.js');
if (fs.existsSync(wd) && /numberOfDays\)\s*\|\|\s*_wdDaysInMonth/.test(fs.readFileSync(wd, 'utf8'))) {
  problems.push('app/report-engine-woodland.js substitutes calendar days for a blank numberOfDays');
}

if (problems.length) {
  console.log('FAIL gate-single-day-count');
  problems.forEach((p) => console.log('  ' + p));
  process.exit(1);
}
console.log('PASS gate-single-day-count (' + ALLOWED.length + ' allowed non-day-count sites)');
