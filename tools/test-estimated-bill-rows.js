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
//   2. One missing-day method: gapMissingPeriod (days strictly between the last covered day
//      and the next covered day) gives 29 for the Spring Hill High June-2025 gap (2025-05-20 ->
//      2025-06-19, missing 05/21..06/18), 1 for a 1-day gap — and a source-text sweep proves the
//      Bills-table gap line (app/utility-data.js) and estimateMissingPeriod (app/csv-import.js)
//      both use it, so they cannot silently diverge again.
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
  loadFn(REPO + '/app/utility-data.js', 'gapMissingPeriod'),
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

console.log('=== 2. One missing-day method — gapMissingPeriod (cold-review High 1, 2026-09-28) ===');
{
  // Missing days = days strictly between the last covered day and the next covered day.
  const shh = sandbox.gapMissingPeriod('2025-05-20', '2025-06-19'); // Spring Hill High June-2025 gap
  assert(shh && shh.days === 29, 'SHH 05/20 -> 06/19 = 29 missing days (got ' + (shh && shh.days) + ')');
  assert(shh && shh.start === '2025-05-21' && shh.end === '2025-06-18', 'SHH estimate period is 05/21..06/18');
  assert(shh && sandbox.calcDays(shh.start, shh.end, true) === shh.days, 'row period counted inclusive = gap-line count');
  const one = sandbox.gapMissingPeriod('2025-05-20', '2025-05-22');
  assert(one && one.days === 1 && one.start === '2025-05-21' && one.end === '2025-05-21', '1-day gap = 1 day, 05/21..05/21');
  assert(sandbox.gapMissingPeriod('2025-05-20', '2025-05-21') === null, 'adjacent bills: no missing days -> null');
  const yr = sandbox.gapMissingPeriod('2024-02-27', '2024-03-02'); // leap year, month rollover
  assert(yr && yr.days === 3 && yr.start === '2024-02-28' && yr.end === '2024-03-01', 'leap-year rollover = 3 days');
  // Estimate kWh math uses that same day count (synthetic bills; SHH dates).
  const prevKwh = 300000, prevDays = sandbox.calcDays('2025-04-20', '2025-05-20', true);
  const nextKwh = 330000, nextDays = sandbox.calcDays('2025-06-19', '2025-07-21', true);
  const est = Math.round(((prevKwh + nextKwh) / (prevDays + nextDays)) * shh.days * 10000) / 10000;
  const expect = ((prevKwh + nextKwh) / (prevDays + nextDays)) * 29;
  assert(Math.abs(est - expect) < 0.0001, 'estimate kWh = avg daily x 29 (got ' + est + ')');
  console.log('  SHH-style estimate: ' + est.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' kWh over ' + shh.days + ' days');

  // Source sweep: gap line and estimate row both read gapMissingPeriod; no private day math.
  const udSrc = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  assert(/const gapDays = gapMissingPeriod\(gapEarlier, gapLater\)\.days/.test(udSrc), 'gap line uses gapMissingPeriod');
  const csvSrc = fs.readFileSync(path.join(REPO, 'app/csv-import.js'), 'utf8');
  assert(/const gap = gapMissingPeriod\(gapStart, gapEnd\)/.test(csvSrc), 'estimateMissingPeriod uses gapMissingPeriod');
  assert(!/calcDays\(gapStart, gapEnd/.test(csvSrc), 'estimateMissingPeriod has no calcDays(gapStart, gapEnd)');
}

console.log('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
