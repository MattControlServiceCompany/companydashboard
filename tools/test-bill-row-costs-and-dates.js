/**
 * test-bill-row-costs-and-dates.js
 * Items 775f3d5f and a5cfe2a6 (app/bill-analysis.js).
 *  - _extractedToBillRowCosts stores totalCost and kwh as parsed numbers (no thousands comma).
 *  - _fmtShortDate reads an ISO date as a LOCAL date, in any time zone.
 * SYNTHETIC values only.
 * Usage: TZ=America/Chicago node tools/test-bill-row-costs-and-dates.js [repo-root]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/bill-analysis.js'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  const m = /\r?\n}\r?\n/.exec(src.slice(i));
  return src.slice(i, i + m.index + m[0].length);
}
const sb = { console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/formatting.js'), 'utf8'), sb);
vm.runInContext(grab('_extractedToBillRowCosts') + grab('_fmtShortDate'), sb);
let fail = 0;
const check = (l, ok, d) => {
  if (!ok) fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + l + (ok ? '' : ' - ' + d));
};
const costs = vm.runInContext('_extractedToBillRowCosts', sb);
const fmt = vm.runInContext('_fmtShortDate', sb);

let r = costs({ TotalCurrentCharges: '1,200.50', kWhConsumed: '12,000' });
check('total with comma stored as number', r.totalCost === 1200.5, JSON.stringify(r.totalCost));
check('usage with comma stored as number', r.kwh === 12000, JSON.stringify(r.kwh));
r = costs({ TotalCurrentCharges: '', TotalAmountDue: '300.25', kWh: 40 });
check('falls through to TotalAmountDue', r.totalCost === 300.25 && r.kwh === 40, JSON.stringify(r));
r = costs({ TotalCurrentCharges: 'n/a' });
check('unreadable total stores blank', r.totalCost === '' && r.kwh === '', JSON.stringify(r));
r = costs({});
check('missing values store blank', r.totalCost === '' && r.kwh === '', JSON.stringify(r));

check('Jan 1 shows 1/1', fmt('2025-01-01') === '1/1', fmt('2025-01-01'));
check('Jan 31 shows 1/31', fmt('2025-01-31') === '1/31', fmt('2025-01-31'));
check('Feb 28 shows 2/28', fmt('2025-02-28') === '2/28', fmt('2025-02-28'));
check('mid-year shows 7/15', fmt('2025-07-15') === '7/15', fmt('2025-07-15'));
check('blank shows dash', fmt('') === '\u2014');
check('text kept as is', fmt('n/a') === 'n/a', fmt('n/a'));
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
