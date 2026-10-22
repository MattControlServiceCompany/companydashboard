/**
 * test-utility-e-prorated-demand.js
 *
 * Utility E demand charge printed with a day fraction "(for N of Y days)". The check (qty x rate x N / Y) must give no
 * warning when the bill is right, also when OCR ran the word "days" into the number, cut Y, or misread N or Y; the
 * misread N or Y is set only when the PRINTED charge equals qty x rate x N / Y to the cent (_evgResolveProrationDen).
 * A truly wrong printed charge must still warn. SYNTHETIC pages only (fake account, fake values).
 * Usage: node tools/test-utility-e-prorated-demand.js   (expect "ALL PASSED", exit 0)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
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

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}
const n = (v) => (v === null || v === undefined || v === '' ? null : parseFloat(String(v).replace(/,/g, '')));
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= (tol || 0.005);

// ---- synthetic page builder ------------------------------------------------------------------------------------
const HEAD = (rateLine) =>
  ['Customer Name : SAMPLE DISTRICT', 'Billing Date: 10/07/2026', '100 SAMPLE DR EXAMPLETON KS', rateLine].join('\n');
const FORM = [
  'Contact Information Change Form',
  'Account Number :',
  'Mailing Address changes only.',
  'Mailing Address Line 1:',
].join('\n');
const amtLines = (amts) =>
  amts
    .map(
      (a) =>
        (a < 0 ? '-$' : '$') +
        Math.abs(a)
          .toFixed(2)
          .replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    )
    .join('\n\n');
const extractOnly = (text) => {
  const rule = ruleFor(text);
  return [].concat(rule.extractAll.call(rule, '%%PAGE_1%%\n' + text))[0] || {};
};
const pipeline = async (text) => {
  const rule = ruleFor(text);
  let bills = rule.extractAll.call(rule, '%%PAGE_1%%\n' + text);
  if (!Array.isArray(bills)) bills = [bills];
  const v = await sb.__verify(bills, rule.name, text);
  bills = v.bills;
  sb.__gates(bills, null, null, null);
  return bills;
};


const page = (d1, d2, amt1, amt2) =>
  HEAD('MGS Secondary Voltage Commercial - 2MGSE   Billing Details - service from 09/07/2026 to 10/05/2026') +
  '\n' +
  [
    'Customer Chg ..........   $48.90',
    'Demand Chg 40.0000 kW at $9.82 per kW',
    d1 + ' ........   ' + amt1,
    'Demand Chg 40.0000 kW at $3.624 per kW',
    d2 + ' ........   ' + amt2,
    'kWh Used 2,000.0000',
  ].join('\n') +
  '\n' +
  FORM +
  '\n';
// 40 kW x 9.82 x 23/29 = 311.54; 40 kW x 3.624 x 6/29 = 29.99
const GOOD1 = '$311.54';
const GOOD2 = '$29.99';
const warns = (b) => Object.keys(b).filter((f) => /^_part_mismatches_BilledKWCharge$|^_rate_mismatch_BilledKWCharge$/.test(f) && b[f] && (!Array.isArray(b[f]) || b[f].length));

async function main() {
  const cases = [
    ['prorated demand, clean text', '(for 23 of 29 days)', '(for 6 of 29 days)', GOOD1, GOOD2, true],
    ['"days" run into the number', '(for 23 of 29days)', '(for 6 of 29days)', GOOD1, GOOD2, true],
    ['Y misread on one line (28), sibling shows 29', '(for 23 of 28 days)', '(for 6 of 29 days)', GOOD1, GOOD2, true],
    ['Y cut on one line', '(for 23 of 29 days)', '(for6 of 2M AAYS)', GOOD1, GOOD2, true],
    ['N misread on one line (22), Y shared', '(for 22 of 29 days)', '(for 6 of 29 days)', GOOD1, GOOD2, true],
    ['wrong printed charge still warns', '(for 23 of 29 days)', '(for 6 of 29 days)', '$400.00', GOOD2, false],
    ['wrong printed charge on the cut-Y line still warns', '(for 23 of 29 days)', '(for6 of 2M AAYS)', GOOD1, '$35.00', false],
  ];
  for (const [name, d1, d2, a1, a2, clean] of cases) {
    const bills = await pipeline(page(d1, d2, a1, a2));
    const b = bills[0] || {};
    const w = warns(b);
    check(name + (clean ? ': no warning' : ': warns'), clean ? w.length === 0 : w.length > 0, JSON.stringify(w) + ' ' + JSON.stringify(b._rates && b._rates.BilledKWCharge && b._rates.BilledKWCharge.parts));
  }
  // TDC split at a rate change: each line holds a date range and no printed fraction. The printed charge is
  // qty x rate x (range days / bill days). A match to the cent gives no warning; a wrong charge still warns; no
  // corrected value is built from the fraction.
  const tdcPage = (a1, a2) =>
    HEAD('MGS Secondary Voltage Commercial - 2MGSE   Billing Details - service from 09/07/2026 to 10/05/2026') +
    '\n' +
    [
      'Customer Chg ..........   $48.90',
      'TDC Chg 09-07-2026-09-08-2026 for 40.0000 kW at $2.51004 per kW .....   ' + a1,
      'TDC Chg 09-09-2026-10-05-2026 for 40.0000 kW at $2.46781 per kW .....   ' + a2,
      'kWh Used 2,000.0000',
    ].join('\n') +
    '\n' +
    FORM +
    '\n';
  // 40 x 2.51004 x 2/29 = 6.92; 40 x 2.46781 x 27/29 = 91.90
  const tdcWarns = (b) => Object.keys(b).filter((f) => /^_part_mismatches_TDCCharge$|^_rate_mismatch_TDCCharge$/.test(f) && b[f] && (!Array.isArray(b[f]) || b[f].length));
  for (const [name, a1, a2, clean] of [
    ['TDC range fraction matching to the cent', '$6.92', '$91.90', true],
    ['TDC wrong printed charge', '$6.92', '$95.00', false],
  ]) {
    const b = (await pipeline(tdcPage(a1, a2)))[0] || {};
    const w = tdcWarns(b);
    check(name + (clean ? ': no warning' : ': warns'), clean ? w.length === 0 : w.length > 0, 'days=' + b.NumberOfDays + ' ' + JSON.stringify(w) + ' ' + JSON.stringify(b._rates && b._rates.TDCCharge && b._rates.TDCCharge.parts));
    check(name + ': no correction from a fraction', !Object.keys(b).some((f) => /^_auto_corrected_(rate_)?TDCCharge$|^_rate_repair_TDCCharge$/.test(f)), Object.keys(b).filter((f) => /TDC/.test(f)).join());
    const parts = (b._rates && b._rates.TDCCharge && b._rates.TDCCharge.parts) || [];
    check(name + ': record keeps the printed qty and rate', parts.length === 2 && parts[0].qty === 40 && parts[0].rate === 2.51004 && parts[1].rate === 2.46781, JSON.stringify(parts));
  }
  // The day fraction is the printed one, read by one function.
  check('reader: glued days', JSON.stringify(sb._evgReadProration('(for 9 of 33days)')) === '{"num":9,"den":33}');
  check('reader: no fraction -> null', sb._evgReadProration('Demand Chg 40.0000 kW at $9.82 per kW ... $392.80') === null);
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
main();
