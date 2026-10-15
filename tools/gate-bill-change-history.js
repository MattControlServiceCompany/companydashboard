/**
 * gate-bill-change-history.js
 *
 * Gate: the Change history section of the Edit Billing Period window (_billChangeHistoryHtml, app/csv-import.js,
 * built from _billChangeHistory, app/utility-data.js). SYNTHETIC values only.
 *
 * Fails when:
 *   1. a bill with no correction records gets a Change history section
 *   2. a label, note or text value is not escaped
 *   3. a number is not formatted like the form fields (_billFmtNumber), or a currency like _billFmtCurrency
 *   4. a value with no schema label gets a split-letter label ("k Wh Consumed") instead of the schema label
 *
 * Usage: node tools/gate-bill-change-history.js [repo-root]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').split(String.fromCharCode(13)).join('');
const grab = (src, re) => {
  const m = re.exec(src);
  if (!m) throw new Error('source not found: ' + re);
  return m[0];
};
const ud = rd('app/utility-data.js');
const ci = rd('app/csv-import.js');
const code = [
  rd('lib/formatting.js'),
  'function _rcIsReadChainRecord(rec){ return !!rec && !!rec.reason; }',
  "function _billSchemaFor(){ return [{key:'kwh',label:'kWh Consumed',type:'number',pdfKey:'kWhConsumed'},{key:'total',label:'Total',type:'currency',pdfKey:'TotalCurrentCharges'}]; }",
  grab(ud, /const _READ_CORRECTION_LABELS[^\n]*\n/),
  grab(ud, /function _readCorrectionRecords[\s\S]*?\n\}\n/),
  grab(ud, /function _billChangeHistory\([\s\S]*?\n\}\n/),
  grab(ci, /function _billFmtCurrency[\s\S]*?\n\}\n/),
  grab(ci, /function _billFmtNumber[\s\S]*?\n\}\n/),
  grab(ci, /function _billChangeHistoryHtml[\s\S]*?\n\}\n/),
].join('\n');
const ctx = vm.createContext({ console });
vm.runInContext(code, ctx);
const html = (row) => vm.runInContext('_billChangeHistoryHtml', ctx)(row, 'Electric');
const problems = [];

if (html({ id: 'x', startRead: '10' }) !== '') problems.push('1: section shown for a bill with no records');

const h = html({
  id: 'x',
  startRead: '1880',
  _auto_corrected_startRead: { original: '18800', corrected: '1880', reason: 'x<b>y' },
  _userCorrected_kWhConsumed: { original: 1234567, corrected: '9876', ts: Date.UTC(2026, 0, 5) },
  _userCorrected_TotalCurrentCharges: { original: '1234.5', corrected: '<i>n/a</i>', ts: Date.UTC(2026, 0, 5) },
  _userCorrected_Odd_Field: { original: 1, corrected: 2 },
});
if (!/Change history/.test(h)) problems.push('1: section missing when records exist');
if (/<i>|<\/i>/.test(h)) problems.push('2: a text value is not escaped');
if (/<b>y/.test(h)) problems.push('2: a note is not escaped');
if (!/original value 18,800, changed to 1,880/.test(h)) problems.push('3: read value not formatted as a number');
if (!/original value 1,234,567, changed to 9,876/.test(h)) problems.push('3: kWh not formatted as a number');
if (!/original value \$1,234\.50, changed to &lt;i&gt;n\/a&lt;\/i&gt;/.test(h)) problems.push('3: currency not formatted or text not kept as escaped text');
if (!/<b>kWh Consumed<\/b>/.test(h)) problems.push('4: label for kWhConsumed is not the schema label');

if (problems.length) {
  console.error('gate-bill-change-history FAIL\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('gate-bill-change-history PASS');
