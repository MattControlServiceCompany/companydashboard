/**
 * test-baldwin-metered-line.js
 *
 * Regression test for the City of Baldwin City metered charge line reader (app/energy-savings.js,
 * _parseMeteredLine and its callers). A charge is accepted only from a token printed with cents.
 * A row whose charge column is lost keeps its usage and is FLAGGED (_manualReview), never read as
 * a charge and never dropped. SYNTHETIC text only (fake accounts, round figures).
 *
 * Usage: node tools/test-baldwin-metered-line.js [repo-root]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
vm.createContext(sandbox);
for (const f of ['lib/formatting.js', 'app/energy-savings.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
const rule = rules.find((r) => r.name === 'City of Baldwin City');
if (!rule) throw new Error('Baldwin rule not found');

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}

function page(lines, split) {
  return (
    '%%PAGE_2%%\n4/10/25\nACCOUNT NUMBER\nBAKER UNIVERSITY/TEST GYM\n' +
    'ACCOUNT #: 100200300     DUE DATE AFTER DUE DATE\nSERVICE\nADDRESS: 100 TEST ST       4/25/25  100.00  90.00\n' +
    'Current Reading Previous Reading\n' +
    (split ? lines.labels.join('\n') + '\nTO CITY HALL\n' + lines.data.join('\n') + '\nCOPY ONLY - BANK PAID\n'
           : lines.join('\n') + '\nCOPY ONLY - BANK PAID\n')
  );
}
const bill = (bills, com) => (bills || []).find((b) => b.Commodity === com);
const run = (p) => {
  const r = rule._extractPage(p);
  return r ? (Array.isArray(r) ? r : [r]) : [];
};

console.log('1. no charge column: usage kept, charge null, flagged');
{
  const b = run(page(['SW - SEWER 1000000 1002000 2001', 'WA - WATER 500000 502000 2001 40.00']));
  const s = bill(b, 'Sewer');
  check('sewer row exists', !!s);
  check('sewer usage is 2001', s && s.SewerUsage === 2001, s && s.SewerUsage);
  check('sewer charge is null', s && s.SewerCharge === null, s && s.SewerCharge);
  check('sewer row is flagged', s && s._manualReview === true);
}
console.log('2. charge with cents: usage and charge read');
{
  const b = run(page(['SW - SEWER 100 200 98 12.34']));
  const s = bill(b, 'Sewer');
  check('sewer usage 98', s && s.SewerUsage === 98, s && s.SewerUsage);
  check('sewer charge 12.34', s && s.SewerCharge === 12.34, s && s.SewerCharge);
  check('not flagged', s && !s._manualReview);
}
console.log('3. cut charge ".93": never read as 93');
{
  const b = run(page(['SW - SEWER 100 200 98 6&7 .93']));
  const s = bill(b, 'Sewer');
  check('sewer row exists', !!s);
  check('sewer charge is not 93', s && s.SewerCharge !== 93, s && s.SewerCharge);
  check('sewer charge null and flagged', s && s.SewerCharge === null && s._manualReview === true);
  check('sewer usage 98', s && s.SewerUsage === 98, s && s.SewerUsage);
}
console.log('4. split-column page');
{
  const labels = ['SW - SEWER', 'WA - WATER'];
  let b, s;
  b = run(page({ labels, data: ['100 200 98 6&7 .93', '500000 502000 2001 40.00'] }, true));
  s = bill(b, 'Sewer');
  check('split: cut charge is not 93', s && s.SewerCharge !== 93, s && s.SewerCharge);
  b = run(page({ labels, data: ['2280 349.59', '500000 502000 2001 40.00'] }, true));
  s = bill(b, 'Sewer');
  check('split: "usage charge" row still reads 2280 / 349.59', s && s.SewerUsage === 2280 && s.SewerCharge === 349.59, JSON.stringify(s && [s.SewerUsage, s.SewerCharge]));
}
console.log('5. trailing page-edge noise digit after the charge');
{
  const b = run(page(['EL - ELECTRIC 305080 307280 2200 1259.07 1']));
  const e = bill(b, 'Electric');
  check('electric charge 1259.07 (not the noise 1)', e && e.ElectricCharge === 1259.07, e && e.ElectricCharge);
}
console.log('6. garbled water "+13" / ".37" lines');
{
  const b = run(page(['SW - SEWER 2706084 3072630 36655 +13', 'WA - WATER 89270608 29307263 36655 .37']));
  const s = bill(b, 'Sewer');
  const w = bill(b, 'Water');
  check('sewer charge is not 13', !s || s.SewerCharge !== 13, s && s.SewerCharge);
  check('water charge is not 37', !w || w.WaterCharge !== 37, w && w.WaterCharge);
  check('both rows flagged', s && w && s._manualReview && w._manualReview);
}
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
