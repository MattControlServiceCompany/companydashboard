// tools/test-estimated-bill-rows.js — regression gate for backlog d5b815dc
// (Utility Data → meter Bills → "Estimate missing period" flag/count + day-count fix, 2026-09-25).
// Run: node tools/test-estimated-bill-rows.js
//
// Loads the REAL app functions — computeLiveBillFlags (extraction/bill-validation.js),
// _analyzeMeterBills/_billNormMonth/_monthToSeason (app/bill-analysis.js), and calcDays/
// _fixISO/_parseISO (app/utility-data.js) — extracted verbatim into a Node vm sandbox, and
// proves against SYNTHETIC fixtures only (never real client data in the repo):
//
//   1. An estimated bill (estimated:true) is never flagged as statistically unusual and
//      never counts toward any review count — computeLiveBillFlags returns [] for one,
//      even when liveFlagsRaw and persisted cross-meter flags say otherwise.
//   1b. An estimated bill's value must not shift another (real) bill's flag — removing the
//       estimated bill from the bills array passed to _analyzeMeterBills must not change the
//       flags _analyzeMeterBills computes for the real bills.
//   2. One day-count method: calcDays (respecting the Inclusive/Exclusive toggle) gives the
//      same number for the Spring Hill High June-2025 gap (2025-05-20 → 2025-06-19) that the
//      "Estimate missing period" row shows (31 days, inclusive) — and a source-text sweep
//      proves both the Bills-table gap line (app/utility-data.js) and estimateMissingPeriod
//      (app/csv-import.js) call this same calcDays function, so they cannot silently diverge
//      again.
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

const sandbox = { console, Date, Math, isNaN, parseFloat, Array };
vm.createContext(sandbox);

const fns = [
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  loadFn(REPO + '/app/bill-analysis.js', '_billNormMonth'),
  loadFn(REPO + '/app/bill-analysis.js', '_monthToSeason'),
  loadFn(REPO + '/app/bill-analysis.js', '_analyzeMeterBills'),
  loadFn(REPO + '/extraction/bill-validation.js', 'computeLiveBillFlags'),
];
// computeLiveBillFlags reads _PERSISTED_UI_FLAG_IDS (app/utility-data.js module const).
// _analyzeMeterBills reads _MONTH_LABELS (app/bill-analysis.js module const).
vm.runInContext(
  "const _PERSISTED_UI_FLAG_IDS = ['waterSewerParity_warn', 'facKWMissing_warn'];\n" +
    "const _MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];",
  sandbox,
);
vm.runInContext(fns.join('\n\n'), sandbox);

console.log('=== 1. computeLiveBillFlags — an estimated bill is never flagged / never counted ===');
{
  const estBill = {
    id: 'estBill1',
    estimated: true,
    estimatedNote: 'test',
    // Cross-meter flag present and NOT dismissed — would normally survive into the result.
    _flags: [{ id: 'waterSewerParity_warn', label: 'x', severity: 'warning', dismissed: false }],
  };
  // liveFlagsRaw says this bill IS statistically unusual — must still be suppressed.
  const liveFlagsRaw = [{ field: 'kwh', msg: 'kWh (999) is 9.00x of Jun avg 111', level: 'warn' }];
  const flags = sandbox.computeLiveBillFlags(estBill, liveFlagsRaw);
  assert(
    Array.isArray(flags) && flags.length === 0,
    'estimated bill -> computeLiveBillFlags returns [] (no flag, no count)',
  );
}
{
  // Sanity: a normal (non-estimated) bill with the same inputs is NOT suppressed.
  const realBill = { id: 'realBill1', _flags: [] };
  const liveFlagsRaw = [{ field: 'kwh', msg: 'kWh (999) is 9.00x of Jun avg 111', level: 'warn' }];
  const flags = sandbox.computeLiveBillFlags(realBill, liveFlagsRaw);
  assert(flags.length === 1, 'non-estimated bill with a live flag is still flagged (suppression is estimated-only)');
}

console.log("=== 1b. _analyzeMeterBills — an estimated bill must not shift a REAL bill's flag ===");
{
  const m = { commodity: 'Electric' };
  // 4 real bills, one per month, each in its OWN month AND its own season-peer-count (<3)
  // deliberately: this forces every real bill's ratio-band check down to the allStats
  // (whole-history MEAN) fallback — the path a single outlier value most easily distorts.
  // No totalCost/demandKW set (pf(undefined)=0 -> those field checks self-skip via
  // `if (val <= 0) continue`), so only the 'kwh' field's flag is meaningful here.
  const realBills = [
    { id: 'r1', start: '2021-01-01', end: '2021-01-30', kwh: 100000 },
    { id: 'r2', start: '2021-04-01', end: '2021-04-29', kwh: 100000 },
    { id: 'r3', start: '2021-07-01', end: '2021-07-30', kwh: 100000 },
    { id: 'r4', start: '2021-10-01', end: '2021-10-30', kwh: 100000 },
  ];
  // An estimated bill with a huge value: if it feeds the overall mean (old bug), mean jumps
  // from 100,000 to 680,000 and every real bill's ratio (100,000/680,000 = 0.15x) crosses the
  // 0.2x low-band threshold -> all 4 real bills would wrongly flag as "unusual".
  const estBill = {
    id: 'est1',
    start: '2021-02-01',
    end: '2021-02-27',
    kwh: 3000000,
    estimated: true,
    estimatedNote: 'test',
  };

  const withoutEst = sandbox._analyzeMeterBills(realBills.slice(), m);
  const withEst = sandbox._analyzeMeterBills([...realBills, estBill], m);

  ['r1', 'r2', 'r3', 'r4'].forEach((id) => {
    const a = JSON.stringify(withoutEst[id] || []);
    const b = JSON.stringify(withEst[id] || []);
    assert(
      a === b,
      id + ': flags unchanged whether or not the estimated outlier is present (was: ' + a + ' now: ' + b + ')',
    );
    assert(
      !(withEst[id] || []).some((f) => f.field === 'kwh'),
      id + ': not flagged on kwh just because an estimated outlier exists elsewhere in history',
    );
  });
}

console.log('=== 2. One day-count method — Spring Hill High June-2025 gap (2025-05-20 -> 2025-06-19) ===');
{
  // Real data (2026-09-25-companyhub-backup-copy.json): Spring Hill High Electric meter,
  // inclusive=true. Gap between the bill ending 2025-05-20 and the bill starting 2025-06-19.
  const gapStart = '2025-05-20';
  const gapEnd = '2025-06-19';
  const inclusive31 = sandbox.calcDays(gapStart, gapEnd, true);
  const exclusive30 = sandbox.calcDays(gapStart, gapEnd, false);
  assert(inclusive31 === 31, 'calcDays inclusive=true -> 31 days (matches the Estimate-missing-period row)');
  assert(
    exclusive30 === 30,
    'calcDays inclusive=false -> 30 days (the OLD gap-line raw-diff number, still correct for Exclusive mode)',
  );

  // Regression guard: the gap-line day count in app/utility-data.js and the estimate-row day
  // count in app/csv-import.js must both go through calcDays (the one shared, toggle-aware
  // function) — not a private raw ms-diff — so they can never independently drift again.
  const udSrc = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  assert(
    /const gapDays = calcDays\(gapEarlier, gapLater, incl\)/.test(udSrc),
    'app/utility-data.js gap line computes gapDays via calcDays(gapEarlier, gapLater, incl)',
  );
  assert(
    !/const gapDays = Math\.round\(Math\.abs\(_parseISO\(gapLater\)/.test(udSrc),
    'app/utility-data.js gap line no longer uses the old raw ms-diff (no toggle, no +1)',
  );
  const csvSrc = fs.readFileSync(path.join(REPO, 'app/csv-import.js'), 'utf8');
  assert(
    /const gapDays = calcDays\(gapStart, gapEnd, incl\)/.test(csvSrc),
    'app/csv-import.js estimateMissingPeriod computes gapDays via calcDays(gapStart, gapEnd, incl)',
  );
}

console.log('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
