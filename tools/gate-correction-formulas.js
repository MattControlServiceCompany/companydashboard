/**
 * gate-correction-formulas.js: every automatic correction record shows a formula that is true.
 *
 * Rule (Matt, 2026-10-20): a printed charge line is its OWN printed qty x its OWN printed rate, to the cent; a date
 * range on a line only names the part-period; no day proration, no division by days. A correction record
 * _auto_corrected_<field> must carry a numeric corrected value equal to the cell, and when its reason shows
 * "qty unit x $rate = $charge" terms, each term's qty x rate equals its charge to the cent and the terms add up to
 * the corrected value. No record of another shape (ocrRate/derivedRate) may sit under _auto_corrected_.
 *
 * Runs the real Utility E reader and _postExtractionVerify over (1) SYNTHETIC pages built here (fake school, no
 * account id) and (2) when BILL_GT_UTILITY_E_FILE names the local ground-truth file, every real page text
 * (<BILL_GT_WORDS_DIR or the file's pagesDir>/<image>.ocr.json). Prints the number of real pages with a record
 * that is not true.
 * Usage: node tools/gate-correction-formulas.js [--root <repo dir>]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootIdx = process.argv.indexOf('--root');
const root = rootIdx >= 0 ? process.argv[rootIdx + 1] : path.join(__dirname, '..');
const LOAD_ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/physics.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/eui.js',
  'computations/pollution.js',
  'computations/csc.js',
  'computations/savings.js',
  'computations/bill-flags.js',
  'computations/bill-repair.js',
  'computations/anomaly-detection.js',
  'lib/perf-table.js',
  'lib/shared-charts.js',
  'computations/report-data.js',
  'computations/data-quality.js',
  'app/sync-classification.js',
  'app/db.js',
  'app/core.js',
  'app/utility-data.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
];
const sb = {
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
  document: {
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, getContext: () => null }),
  },
  navigator: { userAgent: 'node-test' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  Chart: function () {},
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval,
  TextEncoder,
  TextDecoder,
  performance: { now: () => Date.now() },
  Image: function () {},
};
sb.globalThis = sb;
sb.self = sb;
vm.createContext(sb);
for (const f of LOAD_ORDER) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f });
vm.runInContext(
  'this.__rules = UTILITY_RULES; this.__verify = _postExtractionVerify; this.__gates = _applyExtractionGates;',
  sb,
);
// The rule that owns a page is the one whose own detect accepts it (same choice as tools/test-utility-e-line-parser.js).
const ruleFor = (text) => sb.__rules.find((r) => r.detect(text));


// ---- synthetic page builder ------------------------------------------------------------------------------------
const HEAD = (rateLine) =>
  ['Customer Name : SAMPLE DISTRICT', 'Billing Date: 10/07/2026', '100 SAMPLE DR EXAMPLETON KS', rateLine].join('\n');
const FORM = [
  'Contact Information Change Form',
  'Account Number :',
  'Mailing Address changes only.',
  'Mailing Address Line 1:',
].join('\n');


const bad = [];
let records = 0;
const fnum = (v) => (v === null || v === undefined || v === '' ? NaN : parseFloat(String(v).replace(/[$,]/g, '')));
function checkBill(tag, b) {
  for (const k of Object.keys(b)) {
    if (!k.startsWith('_auto_corrected_')) continue;
    const rec = b[k];
    if (!rec || typeof rec !== 'object') continue;
    records++;
    const f = k.slice('_auto_corrected_'.length);
    const why = [];
    if (!isFinite(fnum(rec.corrected))) why.push('corrected is not a number: ' + JSON.stringify(rec.corrected));
    if (rec.original != null && !isFinite(fnum(rec.original))) why.push('original is not a number: ' + JSON.stringify(rec.original));
    if (/^rate_/.test(f)) why.push('rate record under _auto_corrected_');
    if (isFinite(fnum(rec.corrected)) && isFinite(fnum(b[f])) && Math.abs(fnum(rec.corrected) - fnum(b[f])) > 0.005 && /Charge$/.test(f))
      why.push('corrected ' + rec.corrected + ' is not the cell ' + b[f]);
    const re = /([\d,]+\.\d+) (kWh|kW) × \$([\d.]+) = \$([\d,]+\.\d\d)/g;
    let m;
    let sum = 0;
    let nTerms = 0;
    while ((m = re.exec(String(rec.reason || '')))) {
      nTerms++;
      const q = fnum(m[1]);
      const r = fnum(m[3]);
      const c = fnum(m[4]);
      sum += c;
      if (Math.abs(Math.round(q * r * 100) / 100 - c) > 0.005) why.push('term ' + m[0] + ' is ' + (Math.round(q * r * 100) / 100).toFixed(2));
    }
    if (nTerms && Math.abs(sum - fnum(rec.corrected)) > 0.005) why.push('terms add to ' + sum.toFixed(2) + ' not ' + rec.corrected);
    if (why.length) bad.push({ tag, field: f, why: why.join('; '), reason: rec.reason });
  }
  for (const k of Object.keys(b)) {
    if (!/^_rate_repair_/.test(k)) continue;
    const rec = b[k];
    if (!rec || !isFinite(rec.ocrRate) || !isFinite(rec.derivedRate)) bad.push({ tag, field: k, why: 'rate repair record with a non-number' });
  }
}
async function runText(tag, text) {
  const rule = ruleFor(text);
  if (!rule) return [];
  let bills = rule.extractAll.call(rule, '%%PAGE_1%%\n' + text);
  if (!Array.isArray(bills)) bills = [bills];
  const v = await sb.__verify(bills, rule.name, text);
  v.bills.forEach((b) => checkBill(tag, b));
  return v.bills;
}
const SVC = (a, z) => 'MGS Secondary Voltage Commercial - 2MGSE   Billing Details - service from ' + a + ' to ' + z;
// One synthetic page (fake school, no account): Off Pk rate misread (0.05784 for 0.05734), TDC line range read as
// one day, first ECA line rate lost.
const synth = (o) =>
  HEAD(SVC('08/06/2026', '09/07/2026')) +
  '\n' +
  [
    'Customer Chg ..........   $48.90',
    'Facilities Chg 39.3840 kW at $2.854 per kW ..   $112.40',
    'Demand Chg 36.9440 kW at $11.54 per kW ........   $426.33',
    'Energy Chg On Pk 129.7697 kWh at',
    '$0.10304 per kWh ........   $13.37',
    'Energy Chg Off Pk 1,999.9006 kWh at $' + o.offRate + ' per kWh ....  $114.67',
    'Tax exempt delivery cost from bill ........   $153.87',
    'ECA Chg 08-07-2026-08-31-2026 for',
    '1,663.8049 kWh at ' + o.ecaRate + ' per kWh .....   ' + (o.ecaAmt === undefined ? '$32.79' : o.ecaAmt),
    'ECA Chg 09-01-2026-09-07-2026 for 465.8654',
    'kWh at $0.01917 per kWh .....   $8.93',
    'EER Chg 08-07-2026-09-07-2026 for 2,129.6703 kWh at $0.00056 per kWh .....   $1.19',
    'PTS Chg 08-07-2026-09-07-2026 for',
    '2,129.6703 kWh at $0.00103 per kWh .....   $2.19',
    'TDC Chg ' + o.tdcRange + ' for 36.9440',
    'KW at $2.43891 per kW .....   $90.10',
    'Bill offset ........   -$153.87',
    'Subtotal ........   $850.87',
    'Current Charges ........   $850.87',
    'Start End Days Read Read Difference Multiplier kWh Used KW Used RKVA Used',
    'kWh Used 2,129.6703',
  ].join('\n') +
  '\n' +
  FORM +
  '\n';

async function main() {
  const cases = [
    ['clean', { offRate: '0.05734', ecaRate: '$0.01971', tdcRange: '08-07-2026-09-07-2026' }],
    ['off-pk rate misread', { offRate: '0.05784', ecaRate: '$0.01971', tdcRange: '08-07-2026-09-07-2026' }],
    ['off-pk rate misread, first ECA rate lost', { offRate: '0.05784', ecaRate: '', tdcRange: '08-07-2026-09-07-2026' }],
    ['off-pk rate misread, first ECA line lost', { offRate: '0.05784', ecaRate: '', ecaAmt: '', tdcRange: '08-07-2026-09-07-2026', ecaLost: true }],
    ['TDC range read as one day', { offRate: '0.05734', ecaRate: '$0.01971', tdcRange: '08-07-2026-08-07-2026' }],
  ];
  for (const [name, o] of cases) {
    const bs = await runText('synthetic ' + name, synth(o));
    const b = bs[0] || {};
    const offOk = Math.abs(fnum(b.EnergyOffPeakCharge) - 114.67) < 0.005;
    const tdcOk = Math.abs(fnum(b.TDCCharge) - 90.1) < 0.005 && !b._part_mismatches_TDCCharge;
    const ecaOk = o.ecaLost || Math.abs(fnum(b.ECACharge) - 41.72) < 0.005;
    const tag = 'synthetic ' + name;
    if (!offOk) bad.push({ tag, field: 'EnergyOffPeakCharge', why: 'printed 114.67, now ' + b.EnergyOffPeakCharge });
    if (!tdcOk) bad.push({ tag, field: 'TDCCharge', why: 'TDC 90.10 flagged or changed: ' + JSON.stringify(b._part_mismatches_TDCCharge || b.TDCCharge) });
    if (!ecaOk) bad.push({ tag, field: 'ECACharge', why: 'ECA is the sum of both dated lines 41.72, now ' + b.ECACharge });
  }
  const syntheticBad = bad.length;
  let realPages = 0;
  let realBadPages = 0;
  const gtFile = process.env.BILL_GT_UTILITY_E_FILE;
  if (gtFile && fs.existsSync(gtFile)) {
    const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
    const dir = process.env.BILL_GT_WORDS_DIR || gt.pagesDir;
    for (const pg of gt.pages) {
      const f = path.join(dir, pg.image + '.ocr.json');
      if (!fs.existsSync(f)) continue;
      realPages++;
      const before = bad.length;
      await runText('real ' + pg.id, JSON.parse(fs.readFileSync(f, 'utf8')).text || '');
      if (bad.length > before) realBadPages++;
    }
    console.log('real Utility E pages checked: ' + realPages + ', pages with a record that is not true: ' + realBadPages);
  } else console.log('real Utility E pages skipped (BILL_GT_UTILITY_E_FILE not set)');
  console.log('correction records checked: ' + records + ', synthetic failures: ' + syntheticBad);
  for (const x of bad) console.log('FAIL ' + x.tag + ' ' + x.field + ': ' + x.why + (x.reason ? '  [' + x.reason + ']' : ''));
  console.log(bad.length ? 'FAIL gate-correction-formulas' : 'PASS gate-correction-formulas');
  process.exit(bad.length ? 1 : 0);
}
main();
