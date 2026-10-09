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
const uSrc = fs.readFileSync(path.join(root, 'app/utility-data.js'), 'utf8');
function grabU(head, endRe) {
  const i = uSrc.indexOf(head);
  if (i < 0) throw new Error(head + ' not found');
  const m = endRe.exec(uSrc.slice(i));
  return uSrc.slice(i, i + m.index + m[0].length);
}
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/formatting.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(root, 'lib/date-helpers.js'), 'utf8'), sb);
vm.runInContext(
  grabU('const _dupNorm =', /;\r?\n/) + grabU('const _dupNum =', /\r?\n};\r?\n/) + grabU('function _dupBillKeys(', /\r?\n}\r?\n/),
  sb,
);
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

// 92e2f54d: a real 0 stays 0, a missing value stays blank
r = costs({ kWh: 0, TotalCurrentCharges: 0 });
check('numeric 0 usage and total stay 0', r.kwh === 0 && r.totalCost === 0, JSON.stringify(r));
r = costs({ kWh: '0', TotalCurrentCharges: '0.00', TotalAmountDue: '5' });
check('text 0 stays 0, not the next field', r.kwh === 0 && r.totalCost === 0, JSON.stringify(r));
r = costs({ kWhConsumed: '', kWh: 0 });
check('blank first field falls to a real 0', r.kwh === 0, JSON.stringify(r));

// 775f3d5f follow-on: old text and new number of the same bill give the same duplicate key
const keys = vm.runInContext('_dupBillKeys', sb);
const oldB = { start: '2025-01-01', end: '2025-01-31', totalCost: '1,200.50', kwh: '12,000', naturalGasTherms: '' };
const newB = { start: '2025-01-01', end: '2025-01-31', totalCost: 1200.5, kwh: 12000, naturalGasTherms: '' };
check('"1,200.50" and 1200.5 are one key', keys(oldB).join() === keys(newB).join(), keys(oldB) + ' vs ' + keys(newB));
check('"306.50" and 306.5 are one key', keys({ start: 'a', end: 'b', totalCost: '306.50' }).join() === keys({ start: 'a', end: 'b', totalCost: 306.5 }).join());
check('different totals stay different', keys({ start: 'a', end: 'b', totalCost: '306.50' }).join() !== keys({ start: 'a', end: 'b', totalCost: 306.6 }).join());
check('blank total gives no period key', keys({ start: 'a', end: 'b', totalCost: '' }).length === 0);
check('zero total gives a key', keys({ start: 'a', end: 'b', totalCost: 0 }).length === 1);

// a5cfe2a6: shared local ISO parser
const pld = vm.runInContext('parseLocalISODate', sb);
check('ISO parsed as local', pld('2025-01-01').getDate() === 1 && pld('2025-01-01').getMonth() === 0);
check('ISO with time part parsed by date', pld('2025-03-01T00:00:00Z').getDate() === 1);
check('non-ISO returns null', pld('1/5/2025') === null && pld('') === null && pld(null) === null);
check('impossible date returns null', pld('2025-02-31') === null);
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
