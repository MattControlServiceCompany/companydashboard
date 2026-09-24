// tools/test-facilities-kw-single-source.js — Facilities kW / Facilities kW Cost
// single-source-of-truth regression gate (2026-09-23 cold-review fix).
// Run: node tools/test-facilities-kw-single-source.js
//
// Loads the REAL app functions — getBillFacKWCost (computations/rates.js) and
// backfillFacilitiesKW/_flagFacKWMissingBills (app/csv-import.js) — extracted verbatim into a
// Node vm sandbox, and proves against SYNTHETIC fixtures only (never real client data in the
// repo — see tools/test-single-source-baseline.js's same convention):
//   1. getBillFacKWCost resolves facilitiesCharge OR facKWCost, whichever is present, and is
//      the ONE accessor — no reader anywhere in the app may still read either field directly
//      without going through it (source-text sweep below).
//   2. backfillFacilitiesKW's fill order never invents a number:
//        a. never overwrites a real facKW already on the bill
//        b. derives facKW from the bill's own charge / a known per-kW rate from sibling bills
//        c. falls back to a 12-month rolling peak ONLY when a full prior year of bills exists
//        d. otherwise leaves facKW blank and marks bill._facKWMissing (site-UI flag, never a
//           client report)
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);

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

const sandbox = { console, Date };
vm.createContext(sandbox);

const fns = [
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/computations/rates.js', 'getBillFacKWCost'),
  loadFn(REPO + '/app/csv-import.js', 'backfillFacilitiesKW'),
  loadFn(REPO + '/app/csv-import.js', '_flagFacKWMissingBills'),
];
vm.runInContext(fns.join('\n\n'), sandbox);

console.log('=== 1. getBillFacKWCost — single accessor ===');
assert(sandbox.getBillFacKWCost({ facilitiesCharge: 100 }) === 100, 'facilitiesCharge only -> 100');
assert(sandbox.getBillFacKWCost({ facKWCost: 100 }) === 100, 'facKWCost only -> 100');
assert(
  sandbox.getBillFacKWCost({ facilitiesCharge: 100, facKWCost: 50 }) === 100,
  'facilitiesCharge wins when both present',
);
assert(sandbox.getBillFacKWCost({}) === 0, 'neither field -> 0');
assert(sandbox.getBillFacKWCost(null) === 0, 'null bill -> 0, never throws');
assert(
  sandbox.getBillFacKWCost({ facilitiesCharge: '', facKWCost: 75 }) === 75,
  'empty-string facilitiesCharge falls through to facKWCost',
);

// Source-text sweep: every reader this fix touched must call the accessor, never read either
// field directly. (New readers introduced later are not covered by this sweep — this only
// guards regression on the files this fix explicitly changed.)
console.log('=== 1b. No remaining direct facKWCost/facilitiesCharge reads in the fixed readers ===');
const READER_FILES = [
  'app/core.js',
  'app/graphics-setpoints.js',
  'app/report-engine.js',
  'app/report-engine-woodland.js',
  'lib/perf-table.js',
];
// A raw bill object is never named eM/d/elecMonthly[..] (those are pre-built aggregate/rollup
// objects whose own .facKWCost field is legitimately assigned FROM getBillFacKWCost's output
// elsewhere) — those var names are the only allowed prefixes left on `.facKWCost`/
// `.facilitiesCharge` after this fix. Any other prefix (bill, b, b2, m, billRow, ...) reading
// either field directly, outside a getBillFacKWCost(...) call, is a regression.
const AGGREGATE_PREFIX = /\b(eM|d|elecMonthly\[[^\]]+\])\.(facKWCost|facilitiesCharge)\b/g;
READER_FILES.forEach((rel) => {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  // Strip comment lines (this fix's own doc-comments reference the field names by name).
  const codeOnly = src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/getBillFacKWCost\([^)]*\)/g, '') // the one allowed call site
    .replace(AGGREGATE_PREFIX, ''); // allowed: aggregate-object own field, not a raw bill read
  const leftover = codeOnly.match(/\b\w+\.(facKWCost|facilitiesCharge)\b/g) || [];
  assert(
    leftover.length === 0,
    rel +
      ' — no raw bill.facKWCost/facilitiesCharge reads outside getBillFacKWCost (found: ' +
      leftover.join(', ') +
      ')',
  );
});

console.log('=== 2. backfillFacilitiesKW — fill order ===');

// 2a. Never overwrites a real value already present.
{
  const bills = [{ start: '2025-01-01', facKW: 500, facilitiesCharge: 100 }];
  const filled = sandbox.backfillFacilitiesKW(bills);
  assert(bills[0].facKW === 500, '2a: real facKW never overwritten');
  assert(filled === 0, '2a: filled count is 0 when nothing needed filling');
}

// 2b. Derives from the bill's own charge and a known rate from a sibling bill (same meter).
{
  const bills = [
    { start: '2025-01-01', facKW: 200, facilitiesCharge: 596 }, // known rate = 596/200 = 2.98
    { start: '2025-02-01', facKW: null, facilitiesCharge: 894 }, // 894/2.98 = 300
  ];
  sandbox.backfillFacilitiesKW(bills);
  assert(
    near(bills[1].facKW, 300, 0.5),
    '2b: derives facKW from charge / known sibling rate (got ' + bills[1].facKW + ')',
  );
  assert(!bills[1]._facKWMissing, '2b: no missing-flag when derived successfully');
}

// 2c. Rolling 12-month peak — only fires when a full prior year of bills exists; never on a
// short history even when later months in that short history have higher billed kW (the exact
// Woodland Apr-Jun 2025 bug this fix closes — see the dashboardlogic entry for the real numbers).
{
  const bills = [
    { start: '2024-01-01', facKW: null, billedKW: 100 },
    { start: '2025-01-01', facKW: null, billedKW: 400 }, // exactly 12mo after the first bill
  ];
  sandbox.backfillFacilitiesKW(bills);
  assert(bills[0].facKW == null, '2c: first bill — no full prior year, stays blank (never a guess)');
  assert(bills[0]._facKWMissing === true, '2c: first bill flagged missing');
  assert(near(bills[1].facKW, 400, 0.01), '2c: second bill — full prior year exists, rolling peak fires');
}

// 2d. Short history (<12 months) + no known rate anywhere -> blank + flagged, never a guess.
// This is the exact class of bug the cold review found: a 3-row CSV with no rate info and no
// full year of history must NOT fabricate a number.
{
  const bills = [
    { start: '2025-04-01', facKW: null, billedKW: 289.8, facilitiesCharge: 1132.5 },
    { start: '2025-05-01', facKW: null, billedKW: 289.8, facilitiesCharge: 1132.5 },
    { start: '2025-06-01', facKW: null, billedKW: 333.0, facilitiesCharge: 1132.5 },
  ];
  const filled = sandbox.backfillFacilitiesKW(bills);
  assert(filled === 0, '2d: nothing filled — no known rate, no full year');
  bills.forEach((b, i) => {
    assert(b.facKW == null, '2d: bill ' + i + ' left blank, not fabricated as 289.8/333.0');
    assert(b._facKWMissing === true, '2d: bill ' + i + ' flagged missing');
  });
}

console.log('=== 3. _flagFacKWMissingBills — persists a site-UI-only flag ===');
{
  const meter = { bills: [{ id: 'b1', start: '2025-01-01', facKW: null, _facKWMissing: true }] };
  sandbox._flagFacKWMissingBills(meter);
  const bill = meter.bills[0];
  assert(
    Array.isArray(bill._flags) && bill._flags.some((f) => f.id === 'facKWMissing_warn'),
    'flag persisted to bill._flags',
  );
  assert(!bill._facKWMissing, 'transient marker cleared after flagging');
  // Idempotent — running twice does not duplicate the flag.
  sandbox._flagFacKWMissingBills(meter);
  assert(bill._flags.filter((f) => f.id === 'facKWMissing_warn').length === 1, 'flag not duplicated on a second pass');
}

console.log('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
