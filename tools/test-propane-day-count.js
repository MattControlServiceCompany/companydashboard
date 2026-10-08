// Gate test: propane delivery spreading gives each calendar day to exactly ONE delivery period.
// SYNTHETIC data only. With no HDD data, a delivery of N gallons over an N-day period spreads 1 gal/day,
// so each month must hold exactly its day count inside [first delivery, last delivery).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const REPO = path.join(__dirname, '..');
const sandbox = { console, Date, Math, parseFloat, parseInt, String, Object, Number, isNaN };
const ctx = vm.createContext(sandbox);
const run = (src, fn) => new vm.Script(src, { filename: fn }).runInContext(ctx);
run(fs.readFileSync(path.join(REPO, 'lib/date-helpers.js'), 'utf8'), 'date-helpers.js');
// Take the real _fixISO, _parseISO and calcDays from utility-data.js (it needs a browser to load whole).
const ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
function grab(name) {
  const i = ud.indexOf('function ' + name + '(');
  assert(i >= 0, 'missing ' + name);
  let d = 0, j = ud.indexOf('{', i);
  for (let k = j; k < ud.length; k++) {
    if (ud[k] === '{') d++;
    else if (ud[k] === '}' && --d === 0) return ud.slice(i, k + 1);
  }
}
['_fixISO', '_parseISO', 'calcDays'].forEach((n) => run(grab(n), n));
run(fs.readFileSync(path.join(REPO, 'computations/normalization.js'), 'utf8'), 'normalization.js');

const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const dates = ['2030-01-16', '2030-03-10', '2030-04-29', '2030-06-02'];
const bills = dates.map((d, i) => ({
  start: d, end: d,
  gallonsDelivered: i === 0 ? 50 : dayNum(d) - dayNum(dates[i - 1]),
  totalCost: 1,
}));
const res = ctx.normalizePropaneDeliveries(bills, {});
const got = {};
(Array.isArray(res) ? res : []).forEach((r) => (got[r.month] = r.gallons));
// expected: days of each month inside [dates[0], dates[last])
const first = dayNum(dates[0]), last = dayNum(dates[3]);
const exp = {};
for (let n = first; n < last; n++) {
  const dt = new Date(n * 864e5);
  const ym = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
  exp[ym] = (exp[ym] || 0) + 1;
}
let fail = 0;
['2030-02', '2030-03', '2030-04', '2030-05'].forEach((ym) => {
  const g = got[ym] || 0;
  if (Math.abs(g - exp[ym]) > 1e-9) { fail++; console.log('FAIL', ym, 'got', g, 'expected', exp[ym]); }
});
// The three delivery periods (1 gal/day) must sum to the span length exactly (Mar..Jun, ignoring Jan first-delivery estimate)
const total = Object.keys(got).filter((k) => k >= '2030-02' && k <= '2030-06').reduce((s, k) => s + got[k], 0);
const spanLen = last - dayNum(dates[0]) - (exp['2030-01'] || 0);
if (Math.abs(total - spanLen) > 1e-9) { fail++; console.log('FAIL total', total, 'expected', spanLen); }
if (fail) { console.log(fail + ' failed'); process.exit(1); }
console.log('propane day count: PASS');
