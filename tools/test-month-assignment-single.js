// tools/test-month-assignment-single.js - WP-09 (math-audit 2026-09-28): ONE month assignment.
// Run: node tools/test-month-assignment-single.js
// SYNTHETIC data only. Loads the REAL functions from the app files, never a copy.
//   P2a  the keeper normMonth chain gives Dec/Jan/Feb/Mar, and the bill-flag engine (computations/bill-flags.js) takes its month from it
//   V1   Appendix D month grouping uses each bill's own per-meter month (ym), never a pooled re-run
//   N1   project normBasis is found when the project id is a number in one place and a string in another
//   N2   getNormRows day split: a reversed-date bill is excluded with a warning, a runaway period is capped
//   A1   addMonth is the one month-add helper (date-helpers.js); calDaysInMonth is the one days-in-month
//   G    gate: the duplicate month-chain, majority-month and days-in-month copies are gone
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

function loadFn(file, name) {
  const src = read(file);
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name + ' in ' + file);
  const p = src.indexOf('(', m.index);
  let d = 0,
    pe = p;
  for (; pe < src.length; pe++) {
    if (src[pe] === '(') d++;
    else if (src[pe] === ')' && --d === 0) break;
  }
  let depth = 0,
    j = src.indexOf('{', pe);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, j + 1);
}

const ctx = { console, warned: [] };
ctx.console = { log() {}, warn: (...a) => ctx.warned.push(a.join(' ')), error() {} };
vm.createContext(ctx);
vm.runInContext(read('lib/date-helpers.js'), ctx);
vm.runInContext(read('computations/normalization.js'), ctx);
vm.runInContext(['_fixISO', '_parseISO'].map((n) => loadFn('app/utility-data.js', n)).join('\n'), ctx);
for (const [file, fn] of [
  ['app/report-engine.js', '_rptBillsByPeriodMonth'],
]) {
  try {
    vm.runInContext(loadFn(file, fn) + ' this.' + fn + ' = ' + fn + ';', ctx);
  } catch (e) {
    assert(false, 'cannot load ' + fn + ' from ' + file + ': ' + e.message);
  }
}

// P2a: continuous chain where the majority-days month and the chain month differ
{
  const bills = [
    { start: '2025-12-15', end: '2026-01-14' },
    { start: '2026-01-14', end: '2026-02-20' },
    { start: '2026-02-20', end: '2026-03-20' },
    { start: '2026-03-20', end: '2026-04-19' },
  ];
  const chain = bills.map((b) => ctx.normMonth(b.start, b.end, true, bills));
  assert(chain.join() === '2025-12,2026-01,2026-02,2026-03', 'keeper chain Dec/Jan/Feb/Mar, got ' + chain.join());
  const flagSrc = read('computations/bill-flags.js');
  assert(/normMonth\(b\.start, b\.end, incl, sortedAll\)/.test(flagSrc), 'P2a the flag engine month is the keeper normMonth over the meter bills');
  assert(!/function _billNormMonth|_monthToSeason/.test(read('app/bill-analysis.js')), 'P2a no second month rule in bill-analysis.js');
}

// V1: two meters, own months Jan/Feb/Mar each; Appendix D must keep them
{
  const mk = (b, ym) => ({ building: b, ym, start: ym + '-01', end: ym + '-28' });
  const raw = [
    mk('A', '2026-01'),
    mk('A', '2026-02'),
    mk('A', '2026-03'),
    mk('B', '2026-01'),
    mk('B', '2026-02'),
    mk('B', '2026-03'),
  ];
  if (!ctx._rptBillsByPeriodMonth) ctx._rptBillsByPeriodMonth = () => ({ '2026-01': [], '2026-02': [], '2026-03': [] });
  const g = ctx._rptBillsByPeriodMonth(raw, ['2026-01', '2026-02', '2026-03']);
  assert(g['2026-01'].length === 2 && g['2026-02'].length === 2 && g['2026-03'].length === 2, 'V1 two bills per month');
  assert(
    g['2026-03'].every((b) => b.ym === '2026-03'),
    'V1 March holds only March bills',
  );
  const g2 = ctx._rptBillsByPeriodMonth(raw, ['2026-02']);
  assert(Object.keys(g2).join() === '2026-02' && g2['2026-02'].length === 2, 'V1 only the reported months appear');
}

// N1: normBasis lookup with number vs string project id
{
  ctx.projects = [{ id: 7, normBasis: 'billing' }];
  assert(typeof ctx.getProjectNormBasis === 'function', 'N1 getProjectNormBasis exists');
  assert(ctx.getProjectNormBasis && ctx.getProjectNormBasis('7') === 'billing', 'N1 string id 7 finds numeric id 7');
  assert(ctx.getProjectNormBasis && ctx.getProjectNormBasis(7) === 'billing', 'N1 numeric id 7 finds numeric id 7');
  assert(ctx.getProjectNormBasis && ctx.getProjectNormBasis('9') === 'calendar', 'N1 unknown project reads calendar');
}

// N2: day split per calendar month
{
  assert(typeof ctx._nmMonthDays === 'function', 'N2 _nmMonthDays exists');
  const ok = ctx._nmMonthDays && ctx._nmMonthDays('2026-01-14', '2026-02-12');
  assert(ok && ok['2026-01'] === 18 && ok['2026-02'] === 12, 'N2 normal bill splits 18 + 12 days');
  ctx.warned.length = 0;
  const rev = ctx._nmMonthDays && ctx._nmMonthDays('2026-03-20', '2026-02-20');
  assert(rev === null && ctx.warned.length === 1, 'N2 reversed-date bill returns null and warns once');
  const longp = ctx._nmMonthDays && ctx._nmMonthDays('2020-01-01', '2026-01-01');
  assert(longp === null, 'N2 runaway period (more than 400 days) is excluded');
}

// A1: one month-add and one days-in-month
{
  assert(typeof ctx.addMonth === 'function', 'A1 addMonth exists in lib/date-helpers.js');
  assert(ctx.addMonth && ctx.addMonth('2025-12', 1) === '2026-01', 'A1 Dec + 1 = Jan next year');
  assert(ctx.addMonth && ctx.addMonth('2026-01', -1) === '2025-12', 'A1 Jan - 1 = Dec previous year');
  assert(ctx.addMonth && ctx.addMonth('2026-11', 14) === '2028-01', 'A1 Nov + 14 = Jan two years on');
  assert(ctx.calDaysInMonth('2024-02') === 29 && ctx.calDaysInMonth('2026-02') === 28, 'A1 calDaysInMonth leap year');
}

// G: duplicate copies are gone
{
  const files = [];
  for (const d of ['app', 'computations', 'lib'])
    for (const f of fs.readdirSync(path.join(REPO, d))) if (f.endsWith('.js')) files.push(d + '/' + f);
  const banned = [
    [/\b_nmNextMonth\b/, 'second add-one-month helper _nmNextMonth'],
    [/\bconst _nextMo\b|\bfunction _nextMo\b/, 'second add-one-month helper _nextMo'],
    [/\bconst _majMonth\b|\bfunction _majMonth\b/, 'second majority-month copy _majMonth'],
    [/\bfunction _wdDaysInMonth\b/, 'second days-in-month _wdDaysInMonth'],
    [/\bfunction _daysInMonth\b/, 'second days-in-month _daysInMonth'],
    [/\b_blNextMonth\b/, 'second add-one-month helper _blNextMonth'],
    [/new Date\(yA, mA, 0\)\.getDate\(\)|new Date\(yB, mB, 0\)\.getDate\(\)/, 'inline days-in-month sort copy'],
  ];
  for (const f of files) {
    const src = read(f);
    for (const [re, what] of banned) assert(!re.test(src), 'G ' + f + ' still has ' + what);
  }
  const re = read('app/report-engine.js');
  assert(
    !/normMonth\(bill\.start, bill\.end, true, d\.rawBills/.test(re),
    'G Appendix D does not re-run normMonth on pooled bills',
  );
}

console.log('test-month-assignment-single: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
