/**
 * gate-bill-display-and-hover.js
 * 1. _billFormatValue (app/csv-import.js) shows a stored comma string "7,398.79" as $7,398.79 (parseBillNumber).
 * 2. billRowHoverText (computations/bill-flags.js): a bill with only an uncounted flag has NO hover text; a bill with
 *    counted flags gets the same text as billFlagLine over the counted flags (the banner text).
 * Synthetic data only. Usage: node tools/gate-bill-display-and-hover.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const problems = [];
const ctx = vm.createContext({ console });
vm.runInContext(read('lib/formatting.js'), ctx);
vm.runInContext(read('computations/bill-flags.js'), ctx);
const csv = read('app/csv-import.js');
const a = csv.indexOf('function _billFormatValue');
const b = csv.indexOf('\n}', a);
if (a < 0) problems.push('_billFormatValue not found');
vm.runInContext(csv.slice(a, b + 2), ctx);
const fmt = (v) => vm.runInContext('_billFormatValue(' + JSON.stringify(v) + ', {key:"totalCost",type:"currency"}, null)', ctx);
if (fmt('7,398.79') !== '$7,398.79') problems.push('comma string shows ' + fmt('7,398.79') + ', expected $7,398.79');
if (fmt(7398.79) !== '$7,398.79') problems.push('number shows ' + fmt(7398.79));
if (fmt('') !== '—') problems.push('blank must show a dash');
if (fmt('abc') !== '—') problems.push('unreadable text must show a dash');

const counted = { rule: 'cost_missing', message: 'Total cost is blank.', severity: 'warn' };
const uncounted = { rule: 'days_mismatch', message: 'Printed days differ from dates.', severity: 'warn' };
const hover = (fl) => vm.runInContext('billRowHoverText("Jan 2024", ' + JSON.stringify(fl) + ')', ctx);
if (hover([uncounted]) !== '') problems.push('uncounted-only bill has hover text: ' + hover([uncounted]));
if (hover([]) !== '') problems.push('no flags must give no hover text');
const both = hover([counted, uncounted]);
const banner = vm.runInContext('billFlagLine("Jan 2024", ' + JSON.stringify([counted]) + ')', ctx);
if (!both || both !== banner) problems.push('hover differs from banner text: ' + both);
if (/days differ/i.test(both)) problems.push('uncounted flag text leaked into hover');
const ud = read('app/utility-data.js');
if (!/billRowHoverText\(/.test(ud)) problems.push('row render does not call billRowHoverText');

if (problems.length) {
  console.log('FAIL gate-bill-display-and-hover');
  problems.forEach((p) => console.log(' - ' + p));
  process.exit(1);
}
console.log('PASS gate-bill-display-and-hover');
