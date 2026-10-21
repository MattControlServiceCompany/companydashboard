#!/usr/bin/env node
// tools/test-next-quarter-to-present.js — SYNTHETIC data only (fake ids, no client data).
// nextQuarterToPresent (computations/savings.js) picks the headline quarter of the project card.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

const S = { console };
S.window = S;
vm.createContext(S);
for (const rel of ['lib/date-helpers.js', 'lib/formatting.js', 'computations/savings.js', 'computations/normalization.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
// The two real date helpers, cut from app/utility-data.js (the page file needs a browser to load).
const _ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
vm.runInContext(_ud.slice(_ud.indexOf('function _fixISO('), _ud.indexOf('// The ONE day-count function')), S);

const bill = (y, m, lastDay) => {
  const p = (n) => String(n).padStart(2, '0');
  return { start: y + '-' + p(m) + '-01', end: y + '-' + p(m) + '-' + p(lastDay || 28) };
};
const months = (fromY, fromM, toY, toM) => {
  const out = [];
  for (let y = fromY, m = fromM; y < toY || (y === toY && m <= toM); m++) {
    if (m > 12) { m = 1; y++; if (y > toY) break; }
    out.push(bill(y, m));
  }
  return out;
};
function setup(meters, presented) {
  S.getUDBldgs = () => [{ id: 'b-fake', meters }];
  S.isBaselineExcluded = (pid, id) => id === 'm-excl';
  S.isCalcCommodity = () => true;
  S.sget = (k, fb) => (k === 'en_presented_savings' ? presented : fb);
  S.getPresentedRecords = (pid) => presented.filter((r) => String(r.projectId) === String(pid));
}
const rec = (a, z) => ({ projectId: 'p-fake', periodStart: a, periodEnd: z, presentedAt: '2026-07-01T00:00:00Z' });

console.log('1. presented Q1+Q2 2026, bills through Sep -> Q3 2026');
{
  setup([{ id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 9) }], [rec('2026-01', '2026-03'), rec('2026-04', '2026-06')]);
  const r = S.nextQuarterToPresent('p-fake');
  assert(r && r.label === 'Q3 2026' && r.year === 2026 && r.q === 2, 'label Q3 2026, got ' + (r && r.label));
  assert(r.complete === true && r.billsThrough === null, 'complete, no "through" date');
  assert(r.yms.join() === '2026-07,2026-08,2026-09', 'yms ' + r.yms);
}

console.log('2. incomplete quarter: earliest latest-bill end among meters');
{
  setup(
    [
      { id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 7) },
      { id: 'm2', commodity: 'Electric', bills: months(2025, 1, 2026, 9) },
      { id: 'm-excl', commodity: 'Electric', bills: months(2025, 1, 2026, 3) },
    ],
    [rec('2026-01', '2026-06')],
  );
  const r = S.nextQuarterToPresent('p-fake');
  assert(r.label === 'Q3 2026' && r.complete === false, 'Q3 2026 incomplete');
  assert(r.billsThrough === '2026-07-28', 'billsThrough 2026-07-28, got ' + r.billsThrough + ' (excluded meter ignored)');
}

console.log('3. no presented record -> latest billed quarter');
{
  setup([{ id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 5) }], []);
  const r = S.nextQuarterToPresent('p-fake');
  assert(r.label === 'Q2 2026', 'Q2 2026, got ' + r.label);
}

console.log('4. never a quarter after the newest bill month');
{
  setup([{ id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 5) }], [rec('2026-01', '2026-06')]);
  const r = S.nextQuarterToPresent('p-fake');
  assert(r.label === 'Q2 2026', 'clamped to Q2 2026, got ' + r.label);
}

console.log('5. two years of data -> yms are only the target year');
{
  setup([{ id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 9) }], [rec('2026-01', '2026-06')]);
  const r = S.nextQuarterToPresent('p-fake');
  assert(r.yms.every((y) => y.startsWith('2026-')), 'only 2026 months');
  setup([{ id: 'm1', commodity: 'Electric', bills: months(2025, 1, 2026, 9) }], [rec('2025-01', '2025-06')]);
  const r2 = S.nextQuarterToPresent('p-fake');
  assert(r2.label === 'Q3 2025', 'presented through Q2 2025 -> Q3 2025, got ' + r2.label);
}

console.log('6. no bills -> null');
{
  setup([{ id: 'm1', commodity: 'Electric', bills: [] }], []);
  assert(S.nextQuarterToPresent('p-fake') === null, 'null');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
