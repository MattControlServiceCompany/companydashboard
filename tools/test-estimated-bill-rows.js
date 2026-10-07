// tools/test-estimated-bill-rows.js — regression gate for backlog d5b815dc
// (Utility Data → meter Bills → "Estimate missing period" flag/count + day-count fix, 2026-09-25).
// Run: node tools/test-estimated-bill-rows.js
//
// Loads the REAL app functions — computeMeterFlagSummary (computations/bill-flags.js) and calcDays/
// _fixISO/_parseISO (app/utility-data.js) — extracted verbatim into a Node vm sandbox, and
// proves against SYNTHETIC fixtures only (never real client data in the repo):
//
//   1. An estimated bill (estimated:true) is never flagged as statistically unusual and
//      never counts toward any review count — computeMeterFlagSummary gives it no flags,
//      even when a stored facilities-kW flag is on it.
//   1b. An estimated bill's value must not shift another (real) bill's flag — removing the
//       estimated bill from the meter must not change the flags computed for the real bills.
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
  loadFn(REPO + '/lib/formatting.js', 'parseBillNumber'),
  loadFn(REPO + '/lib/formatting.js', 'parseBillNumberOrZero'),
  loadFn(REPO + '/lib/formatting.js', 'billValueOrNull'),
  // _analyzeMeterBills reads bill dollars through the one accessors in computations/rates.js.
  loadFn(REPO + '/computations/rates.js', 'getBillFacKWCost'),
  loadFn(REPO + '/computations/rates.js', 'getBillKwCost'),
  loadFn(REPO + '/computations/rates.js', 'getBillKwhCost'),
  loadFn(REPO + '/computations/rates.js', 'getBillGasCostOrNull'),
  loadFn(REPO + '/computations/rates.js', 'getBillGasCost'),
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  loadFn(REPO + '/computations/normalization.js', 'detectGap'),
];
vm.runInContext(
  fs.readFileSync(REPO + '/lib/date-helpers.js', 'utf8') +
    '\n' +
    fs.readFileSync(REPO + '/computations/normalization.js', 'utf8'),
  sandbox,
);
vm.runInContext(fns.join('\n\n'), sandbox);
const flagCtx = require('./bill-flags-sandbox.js').makeContext();

console.log('=== 1. computeMeterFlagSummary — an estimated bill is never flagged / never counted ===');
{
  const estBill = {
    id: 'estBill1',
    estimated: true,
    estimatedNote: 'test',
    // A stored facilities-kW flag, NOT dismissed: would flag a real bill, never an estimated one.
    _flags: [{ id: 'facKWMissing_warn', label: 'x', severity: 'warning', dismissed: false }],
  };
  const sum = flagCtx.computeMeterFlagSummary({ commodity: 'Electric', bills: [estBill] }, null);
  assert(sum.flaggedBills === 0 && sum.flagCount === 0, 'estimated bill -> no flag, no count');
}
{
  const realBill = { id: 'realBill1', _flags: [{ id: 'facKWMissing_warn', label: 'x', dismissed: false }] };
  const sum = flagCtx.computeMeterFlagSummary({ commodity: 'Electric', bills: [realBill] }, null);
  assert(sum.perBill.realBill1.some((f) => f.rule === 'fac_kw_missing'), 'non-estimated bill with the same stored flag is flagged');
}

console.log("=== 1b. computeMeterFlagSummary — an estimated bill must not shift a REAL bill's flag ===");
{
  const mk = (id, start, end, kwh) => ({ id, start, end, kwh, totalCost: '1000' });
  // Three real Januaries of 100,000 kWh. A fourth January of 3,000,000 kWh is a huge outlier.
  const realBills = [
    mk('j21', '2021-01-01', '2021-01-31', 100000),
    mk('j22', '2022-01-01', '2022-01-31', 100000),
    mk('j23', '2023-01-01', '2023-01-31', 100000),
  ];
  const outlier = mk('j24', '2024-01-01', '2024-01-31', 3000000);
  const sameMonth = (sum, id) => (sum.perBill[id] || []).some((f) => f.rule === 'usage_vs_same_month');
  // Control: as a REAL bill the outlier is flagged and the real Januaries are not changed by it.
  const control = flagCtx.computeMeterFlagSummary({ commodity: 'Electric', bills: [...realBills, outlier] }, null);
  assert(sameMonth(control, 'j24'), 'control: a real 3,000,000 kWh January is flagged against the other Januaries');
  // As an ESTIMATED bill it is neither flagged nor used as a comparison for the real bills.
  const est = Object.assign({}, outlier, { id: 'est1', estimated: true });
  const withEst = flagCtx.computeMeterFlagSummary({ commodity: 'Electric', bills: [...realBills, est] }, null);
  assert(!withEst.perBill.est1, 'the estimated bill itself carries no flag');
  realBills.forEach((b) => assert(!sameMonth(withEst, b.id), b.id + ': not flagged because of an estimated outlier'));
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

  // Read-to-read convention: consecutive bills share the meter-read date (prev end = next start),
  // so a gap runs prevEnd -> nextStart like a real bill. detectGap flags only > 3 days.
  assert(sandbox.detectGap('2025-05-20', '2025-05-20') === false, 'shared read date (05/20 -> 05/20) = no gap');
  assert(sandbox.detectGap('2025-05-20', '2025-05-23') === false, '3 days apart = not a gap');
  assert(sandbox.detectGap('2025-05-20', '2025-05-24') === true, '4 days apart = gap');
  assert(sandbox.calcDays('2025-05-20', '2025-05-20', false) === 0, 'shared read date, Exclusive = 0 days');
  // Estimate math: avg daily = (prev+next)/(prevDays+nextDays), x gap days, all via calcDays + toggle.
  [true, false].forEach((incl) => {
    const gd = sandbox.calcDays('2025-05-20', '2025-06-19', incl);
    const pd = sandbox.calcDays('2025-04-21', '2025-05-20', incl);
    const nd = sandbox.calcDays('2025-06-19', '2025-07-21', incl);
    assert(
      gd === (incl ? 31 : 30) && pd === (incl ? 30 : 29) && nd === (incl ? 33 : 32),
      'SHH days ' + (incl ? 'Inclusive' : 'Exclusive') + ': gap ' + gd + ', prev ' + pd + ', next ' + nd,
    );
  });
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

console.log('=== 3. Estimate precision + cost (synthetic; Matt 2026-09-29) ===');
{
  // loadFn throws when a function does not exist yet; turn that into a plain FAIL.
  const tryLoad = (file, name) => {
    try {
      vm.runInContext(loadFn(file, name), sandbox);
      return true;
    } catch (e) {
      assert(false, name + ' exists in ' + path.basename(file));
      return false;
    }
  };
  const csv = REPO + '/app/csv-import.js';
  const okAll = [
    tryLoad(csv, '_storedDecimals'),
    tryLoad(csv, '_usageColDecimals'),
    tryLoad(csv, '_estimateUsageField'),
    tryLoad(csv, '_estimateUsageValue'),
    tryLoad(csv, '_computeMissingPeriodEstimate'),
    tryLoad(csv, '_billFormatValue'),
    tryLoad(REPO + '/app/energy-savings.js', 'parseEvergyPreviouslyBilled'),
  ].every(Boolean);
  if (okAll) {
    // Extractor pads to 4 dp ("1000.1000"); the bill itself prints 2 dp (another real row has 2).
    const prev = { start: '2031-01-01', end: '2031-01-31', kwh: '1000.1000' };
    const next = { start: '2031-03-02', end: '2031-04-01', kwh: '2000.3000', previouslyBilled: '1234.50' };
    const other = { start: '2031-04-01', end: '2031-05-01', kwh: '3000.5500' };
    const real = [prev, next, other];
    assert(sandbox._storedDecimals('1000.1000') === 1, 'padding zeros do not count: "1000.1000" -> 1 dp');
    assert(sandbox._storedDecimals('112252.4400') === 2, '"112252.4400" -> 2 dp');
    assert(
      sandbox._storedDecimals('12') === 0 && sandbox._storedDecimals('12.50') === 1,
      'integer 0 dp, 12.50 is 1 dp',
    );
    assert(sandbox._usageColDecimals(real, 'kwh') === 2, 'column decimals = max meaningful among real rows (2)');
    assert(
      sandbox._usageColDecimals([...real, { kwh: '9.12345678', estimated: true }], 'kwh') === 2,
      'estimated rows never set the column precision',
    );
    const est = sandbox._computeMissingPeriodEstimate(prev, next, 'Electric', false, '2031-01-31', '2031-03-02', real);
    assert(!est.error, 'estimate computed (no error)');
    assert(typeof est.estUsage === 'string', 'estimate is stored as text');
    assert(est.estUsage === '1500.20', 'estimate rounded to the column precision, 2 dp (got ' + est.estUsage + ')');
    assert(est.estCost === '1234.50', 'cost = next bill Previously Billed (got ' + est.estCost + ')');
    const noCost = sandbox._computeMissingPeriodEstimate(
      prev,
      { start: '2031-03-02', end: '2031-04-01', kwh: '2000.3000' },
      'Electric',
      false,
      '2031-01-31',
      '2031-03-02',
      real,
    );
    assert(noCost.estCost === null, 'no Previously Billed on next bill -> cost stays null (never invented)');

    // Display: every row of the kWh column shows exactly the column decimals (fixed).
    const bills = [prev, { kwh: est.estUsage, estimated: true }, next, other];
    const colDp = (key) => (/kwh/i.test(key) ? sandbox._usageColDecimals(bills, key) : null);
    const entry = { type: 'number', key: 'kwh', pdfKey: 'kWhConsumed' };
    const shown = bills.map((b) => sandbox._billFormatValue(b.kwh, entry, colDp));
    assert(
      shown.every((t) => t.split('.')[1].length === 2),
      'every kWh row shows exactly 2 decimals: ' + shown.join(' | '),
    );
    assert(shown[1] === '1,500.20', 'estimate shows 1,500.20 (got ' + shown[1] + ')');
    assert(
      sandbox._billFormatValue('12.5', { type: 'number', key: 'kwh' }, () => 2) === '12.50',
      '12.5 shows as 12.50',
    );

    // Extractor: Evergy page-1 "Previously Billed" line.
    const pb = sandbox.parseEvergyPreviouslyBilled;
    assert(
      pb('Account Summary\nPreviously Billed.................. $1,234.50\nUtility .... $1,234.50') === '1234.50',
      'Previously Billed $1,234.50 -> "1234.50"',
    );
    assert(pb('Payment Received 07/07 - Thank you  -$9.00') === null, 'no Previously Billed line -> null');
  }
  const bcr = fs.readFileSync(path.join(REPO, 'app/bill-corrections-review.js'), 'utf8');
  assert(
    /_bcrScanEvergyPreviouslyBilled,\s*\n\s*_bcrScanStatisticalFlags/.test(bcr),
    'Review Bill Corrections runs the Previously Billed scan',
  );
  const ba = fs.readFileSync(path.join(REPO, 'app/bill-analysis.js'), 'utf8');
  assert(/previouslyBilled: extracted\.PreviouslyBilled/.test(ba), 'extracted PreviouslyBilled is saved on the bill');
  assert(/fields: \['PreviouslyBilled'\]/.test(ba), 'extraction detail shows Previously Billed (Charges section)');
}

console.log('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
