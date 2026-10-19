/**
 * Utility E detached-amount reader, label repair and "propose, never fill" rules (2026-10-15).
 *
 * Node test, real functions from app/*.js and computations/*.js in a vm, SYNTHETIC pages only (no client name,
 * address, account or meter id). Covers:
 *  1. Tax exempt / franchise / sales-tax readers take amounts only from _evgChargeAmounts: a rate on the next
 *     line ("... kWh at $0.07852 per kWh") is never cut to "$0.07".
 *  2. Detached amount block: each amount goes to the one charge line whose qty x rate (x day proration) equals it
 *     to the cent; a split demand charge is the sum of its two printed parts; a line whose rate was misread
 *     leaves its amount unassigned and its charge null; the Customer charge is the first amount only when the
 *     block has one amount per label and every other amount was matched; the one negative amount is the Bill
 *     offset and its twin the Tax exempt delivery.
 *  3. No printed Subtotal / Current Charges: TotalCurrentCharges stays null, _proposed_TotalCurrentCharges is
 *     set and the bill is held with that reason.
 *  4. A charge with qty and rate but no printed amount: the charge stays null, _proposed_<field> is set.
 *  5. Bill offset label without an amount: filled from Tax exempt delivery (the two lines cancel), marked
 *     _mirror_filled_BillOffset, no hold for it.
 *  6. An unlabeled "Sum <qty> kWh at $x" line between On Pk Win and Off Pk Win becomes Off Pk Sum only when the
 *     four tier quantities add up to kWh Used; otherwise nothing changes and the bill stays held.
 *  7. RateSchedule reads through an OCR "Billing De Details" header.
 * Usage: node <path to this file>
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

// Bill-1 shape: labels with qty x rate on one side, every dollar amount in one block after the form text.
// Quantities: 21,001.5 kWh = 8,000.5 + 2,000.25 on peak + 7,000.125 + 4,000.625 off peak; ECA/EER segments
// 16,001 + 5,000.5. (A whole number above 10,000 is not a valid Utility E kWh, so the quantities carry decimals.)
const detachedLabels = (ecaOctRate) =>
  [
    'Customer Chg',
    'Facilities Chg 300.0000 kW at $2.979 per kW .',
    'Demand Chg 200.0000 kW at $9.82 per kW',
    '(for 23 of 29 days) ..',
    'Demand Chg 200.0000 kW at $3.624 per kW',
    '(for 6 of 29 days) ..',
    'Energy Chg On Pk Sum 8,000.5000 kWh at',
    '$0.07852 per kWh .',
    'Energy Chg On Pk Win 2,000.2500 kWh at',
    '$0.03417 per kWh .',
    'Energy Chg Off Pk Sum 7,000.1250 kWh at',
    '$0.04182 per kWh .',
    'Energy Chg Off Pk Win 4,000.6250 kWh at',
    '$0.02915 per kWh .',
    'RkVA Chg 30.0000 kW at $0.663 per kW',
    'Tax exempt delivery cost from bill .....',
    'ECA Chg 09-08-2026-09-30-2026 for',
    '16,001.0000 kWh at $0.01917 per kWh',
    'ECA Chg 10-01-2026-10-06-2026 for',
    '5,000.5000 kWh at $' + ecaOctRate + ' per kWh',
    'EER Chg 09-08-2026-09-30-2026 for',
    '16,001.0000 kWh at $0.00056 per kWh',
    'EER Chg 10-01-2026-10-06-2026 for',
    '5,000.5000 kWh at $0.00153 per kWh',
    'PTS Chg 09-08-2026-10-06-2026 for',
    '21,001.5000 kWh at $0.00103 per kWh',
    'TDC Chg 09-08-2026-10-06-2026 for 200.0000',
    'KW at $2.48947 per kW .',
    'Bill offset',
    'kWh Used 21,001.5000',
  ].join('\n');
// Printed amounts in bill order: Customer, Facilities, Demand 23/29, Demand 6/29, On Sum, On Win, Off Sum, Off Win,
// RkVA, Tax exempt, ECA Sep, ECA Oct, EER Sep, EER Oct, PTS, TDC, Bill offset.
const DETACHED_AMOUNTS = [
  102.86, 893.7, 1557.66, 149.96, 628.2, 68.35, 292.75, 116.62, 19.89, 1395.32, 306.74, 85.11, 8.96, 7.65, 21.63,
  497.89, -1395.32,
];
const detachedPage = (ecaOctRate) =>
  HEAD(
    'Large General All Electric Secondary Voltage - 2LGAE   ‘Billing De Details - service from 09/07/2026 to 10/06/2026',
  ) +
  '\n' +
  detachedLabels(ecaOctRate) +
  '\n' +
  FORM +
  '\n\n' +
  amtLines(DETACHED_AMOUNTS) +
  '\n';

// Bill-4 shape: a normal two-column page; the Off Pk Sum label is OCR noise. kWh Used 2,000 = 400 + 100 + 1,200 + 300.
const labeledPage = (o) => {
  const kwh = o.kwh || '2,000.0000';
  return (
    HEAD('MGS Secondary Voltage Commercial - 2MGSE   Billing Details - service from 09/07/2026 to 10/06/2026') +
    '\n' +
    [
      'Customer Chg ..........   $48.90',
      'Facilities Chg 40.0000 kW at $2.854 per kW ..   $114.16',
      'Demand Chg 40.0000 kW at $11.54 per kW',
      '(for 23 of 29 days) ........   $366.11',
      'Demand Chg 40.0000 kW at $2.171 per kW',
      '(for 6 of 29 days) ........   $17.97',
      'Energy Chg On Pk Sum 400.0000 kWh at',
      '$0.10304 per kWh ........   $41.22',
      'Energy Chg On Pk Win 100.0000 kWh at',
      '$0.05436 per kWh ........   $5.44',
      o.offSumLine || 'Energy Chg Off Pk Sum 1,200.0000 kWh at $0.05734 per kWh ....  $68.81',
      'Energy Chg Off Pk Win 300.0000 kWh at',
      '$0.04769 per kWh ........   $14.31',
      'Tax exempt delivery cost from bill ........   $150.00',
      'ECA Chg 09-08-2026-09-30-2026 for',
      '1,600.0000 kWh at $0.01917 per kWh .....   $30.67',
      'ECA Chg 10-01-2026-10-06-2026 for 400.0000',
      'kWh at $0.01702 per kWh .....   $6.81',
      'EER Chg 09-08-2026-09-30-2026 for',
      '1,600.0000 kWh at $0.00056 per kWh .....   ' + (o.eerNoAmount ? '' : '$0.90'),
      'EER Chg 10-01-2026-10-06-2026 for 400.0000',
      'kWh at $0.00153 per kWh .....   ' + (o.eerNoAmount ? '' : '$0.61'),
      'PTS Chg 09-08-2026-10-06-2026 for',
      '2,000.0000 kWh at $0.00103 per kWh .....   ' + (o.ptsNoAmount ? '' : '$2.06'),
      'TDC Chg 09-08-2026-10-06-2026 for 40.0000',
      'KW at $2.43891 per kW .....   $97.56',
      o.offsetLine || 'Bill offset ........   -$150.00',
      o.noTotal ? '' : 'Subtotal ........   $815.53',
      o.noTotal ? '' : 'Current Charges ........   $815.53',
      'Start End Days Read Read Difference Multiplier kWh Used KW Used RKVA Used',
      'kWh Used ' + kwh,
    ].join('\n') +
    '\n' +
    FORM +
    '\n'
  );
};

async function main() {
  // ---- 1. amount readers never cut a rate -------------------------------------------------------------------
  {
    const r = extractOnly(
      HEAD('MGA Secondary Voltage Commercial - 2MGAE   Billing Details - service from 09/07/2026 to 10/06/2026') +
        '\nCustomer Chg ....  $48.90\nTax exempt delivery cost from bill .....\n14,397.6017 kWh at $0.07852 per kWh\nkWh Used 2,000.0000\n',
    );
    check(
      'tax exempt: a rate on the next line is not a charge',
      r.TaxExemptDelivery === null,
      String(r.TaxExemptDelivery),
    );
    check('tax exempt: nothing mirrored into Bill offset', r.BillOffset === null, String(r.BillOffset));
    // OCR prints "$" as "§" on the Tax exempt line; the next line is the ECA charge with its own amount.
    const x = extractOnly(
      HEAD('MGA Secondary Voltage Commercial - 2MGAE   Billing Details - service from 09/07/2026 to 10/06/2026') +
        '\nCustomer Chg ....  $48.90\nTax exempt delivery cost from bill ....  §274.23\n' +
        'ECA Chg 09-08-2026-09-30-2026 for 6,850.7609 kWh at $0.02059 per kWh .... $143.12\nBill offset\nkWh Used 2,000.0000\n',
    );
    check('tax exempt: "§274.23" on its own line reads 274.23', near(n(x.TaxExemptDelivery), 274.23), String(x.TaxExemptDelivery));
    check('tax exempt: Bill offset twin is -274.23', near(n(x.BillOffset), -274.23), String(x.BillOffset));
    const y = extractOnly(
      HEAD('MGA Secondary Voltage Commercial - 2MGAE   Billing Details - service from 09/07/2026 to 10/06/2026') +
        '\nCustomer Chg ....  $48.90\nTax exempt delivery cost from bill ....\n' +
        'ECA Chg 09-08-2026-09-30-2026 for 6,850.7609 kWh at $0.02059 per kWh .... $143.12\nkWh Used 2,000.0000\n',
    );
    check('tax exempt: amountless label never takes the next charge line amount', y.TaxExemptDelivery === null, String(y.TaxExemptDelivery));
    const f = extractOnly(
      HEAD('MGA Secondary Voltage Commercial - 2MGAE   Billing Details - service from 09/07/2026 to 10/06/2026') +
        '\nCustomer Chg ....  $48.90\nFranchise Fee\n500.0000 kWh at $0.03288 per kWh\nkWh Used 500.0000\nSubtotal $48.90\n',
    );
    check('franchise: a rate on the next line is not a charge', f.FranchiseFee === null, String(f.FranchiseFee));
    const s = extractOnly(
      HEAD('MGA Secondary Voltage Commercial - 2MGAE   Billing Details - service from 09/07/2026 to 10/06/2026') +
        '\nCustomer Chg ....  $48.90\nSubtotal $48.90\nKansas State Sales Tax @ 6.5%\n500.0000 kWh at $0.03288 per kWh\nCurrent Charges $48.90\nkWh Used 500.0000\n',
    );
    check('sales tax: a rate on the next line is not a charge', s.SalesTax === null, String(s.SalesTax));
  }

  // ---- 2 + 3 + 7. detached amount block ----------------------------------------------------------------------
  {
    const [b] = await pipeline(detachedPage('0.01702'));
    check(
      'detached: RateSchedule read through "Billing De Details"',
      b.RateSchedule === '2LGAE',
      String(b.RateSchedule),
    );
    check('detached: Facilities = its one amount', near(n(b.FacilitiesCharge), 893.7), String(b.FacilitiesCharge));
    check('detached: Demand = the two prorated parts', near(n(b.BilledKWCharge), 1707.62), String(b.BilledKWCharge));
    check('detached: On peak = Sum + Win amounts', near(n(b.EnergyOnPeakCharge), 696.55), String(b.EnergyOnPeakCharge));
    check(
      'detached: Off peak = Sum + Win amounts',
      near(n(b.EnergyOffPeakCharge), 409.37),
      String(b.EnergyOffPeakCharge),
    );
    check('detached: ECA = both segments', near(n(b.ECACharge), 391.85), String(b.ECACharge));
    check('detached: EER = both segments', near(n(b.EERCharge), 16.61), String(b.EERCharge));
    check('detached: PTS', near(n(b.PTSCharge), 21.63), String(b.PTSCharge));
    check('detached: TDC', near(n(b.TDCCharge), 497.89), String(b.TDCCharge));
    check('detached: RkVA', near(n(b.RkVACharge), 19.89), String(b.RkVACharge));
    check('detached: Bill offset is the one negative amount', near(n(b.BillOffset), -1395.32), String(b.BillOffset));
    check(
      'detached: Tax exempt is the twin of the offset',
      near(n(b.TaxExemptDelivery), 1395.32),
      String(b.TaxExemptDelivery),
    );
    check(
      'detached: Customer = first amount (one amount per label, all others matched)',
      near(n(b.CustomerCharge), 102.86),
      String(b.CustomerCharge),
    );
    check('detached: OnPeakKWh = printed tier quantities', near(n(b.OnPeakKWh), 10000.75, 0.001), String(b.OnPeakKWh));
    check(
      'detached: OffPeakKWh = printed tier quantities',
      near(n(b.OffPeakKWh), 11000.75, 0.001),
      String(b.OffPeakKWh),
    );
    check(
      'no total: TotalCurrentCharges stays null',
      b.TotalCurrentCharges === null || b.TotalCurrentCharges === undefined,
      String(b.TotalCurrentCharges),
    );
    check(
      'no total: _proposed_TotalCurrentCharges carries the sum of the read charges',
      !!b._proposed_TotalCurrentCharges && near(n(b._proposed_TotalCurrentCharges.value), 4757.97),
      JSON.stringify(b._proposed_TotalCurrentCharges),
    );
    check(
      'no total: the bill is held with that reason',
      b._gateTripped === true &&
        (b._gateReasons || []).some((r) => /TotalCurrentCharges/.test(r) && /NOT applied/.test(r)),
      JSON.stringify(b._gateReasons),
    );
    check(
      'no total: no other field is proposed',
      !Object.keys(b).some((k) => k.startsWith('_proposed_') && k !== '_proposed_TotalCurrentCharges'),
      Object.keys(b)
        .filter((k) => k.startsWith('_proposed_'))
        .join(),
    );
  }
  {
    // The ECA October rate misread (0.07852 for 0.01702): its amount $85.11 matches no line.
    const [b] = await pipeline(detachedPage('0.07852'));
    check('detached misread: ECA stays null', b.ECACharge === null, String(b.ECACharge));
    check(
      'detached misread: ECA is proposed, not stored',
      !!b._proposed_ECACharge,
      JSON.stringify(b._proposed_ECACharge),
    );
    check(
      'detached misread: no stored charge equals the unmatched $85.11',
      !Object.keys(b).some((k) => !k.startsWith('_') && near(n(b[k]), 85.11)),
    );
    check(
      'detached misread: Customer is not taken (not every other amount matched)',
      b.CustomerCharge === null,
      String(b.CustomerCharge),
    );
    check('detached misread: Facilities still read', near(n(b.FacilitiesCharge), 893.7), String(b.FacilitiesCharge));
    check('detached misread: the bill is held', b._gateTripped === true);
  }

  // ---- 4. qty and rate without an amount: proposed, never stored -------------------------------------------------
  {
    const [b] = await pipeline(labeledPage({ eerNoAmount: true, ptsNoAmount: true }));
    check('no amount: EER stays null', b.EERCharge === null, String(b.EERCharge));
    check('no amount: PTS stays null', b.PTSCharge === null, String(b.PTSCharge));
    check(
      'no amount: EER proposed from its two lines',
      !!b._proposed_EERCharge && near(n(b._proposed_EERCharge.value), 1.51),
      JSON.stringify(b._proposed_EERCharge),
    );
    check(
      'no amount: PTS proposed',
      !!b._proposed_PTSCharge && near(n(b._proposed_PTSCharge.value), 2.06),
      JSON.stringify(b._proposed_PTSCharge),
    );
    check('no amount: printed total kept', near(n(b.TotalCurrentCharges), 815.53), String(b.TotalCurrentCharges));
    check(
      'no amount: held with the proposals',
      b._gateTripped === true && (b._gateReasons || []).some((r) => /EERCharge/.test(r)),
      JSON.stringify(b._gateReasons),
    );
  }

  // ---- 5. offset label without an amount ---------------------------------------------------------------------------
  {
    const [b] = await pipeline(labeledPage({ offsetLine: 'Bill offset ........' }));
    check('mirror: Bill offset filled from Tax exempt delivery', near(n(b.BillOffset), -150), String(b.BillOffset));
    check('mirror: marked _mirror_filled_BillOffset', !!b._mirror_filled_BillOffset);
    check(
      'mirror: no hold for it',
      !(b._gateReasons || []).some((r) => /BillOffset/.test(r)),
      JSON.stringify(b._gateReasons),
    );
    check('mirror: total unchanged', near(n(b.TotalCurrentCharges), 815.53), String(b.TotalCurrentCharges));
  }

  // ---- 6. unlabeled Off Pk Sum line ------------------------------------------------------------------------------
  {
    const [b] = await pipeline(labeledPage({ offSumLine: 'oy rg Sum 1,200.0000 kWh at   $68.81' }));
    check(
      'label repair: Off Pk Sum label restored',
      !!b._label_repaired_EnergyOffPeakCharge,
      JSON.stringify(b._label_repaired_EnergyOffPeakCharge),
    );
    check(
      'label repair: Off peak charge = Sum + Win amounts',
      near(n(b.EnergyOffPeakCharge), 83.12),
      String(b.EnergyOffPeakCharge),
    );
    check('label repair: OffPeakKWh = Sum + Win quantities', near(n(b.OffPeakKWh), 1500, 0.001), String(b.OffPeakKWh));
    check('label repair: OnPeakKWh unchanged', near(n(b.OnPeakKWh), 500, 0.001), String(b.OnPeakKWh));
    check('label repair: not held', !b._gateTripped, JSON.stringify(b._gateReasons));
    // The candidate qty reads 1,100 (one digit off): 400 + 100 + 1,100 + 300 = 1,900, not the 2,000 kWh of the bill.
    const [h] = await pipeline(labeledPage({ offSumLine: 'oy rg Sum 1,100.0000 kWh at   $68.81' }));
    check('label repair: identity open (1,900 of 2,000 kWh), no repair', !h._label_repaired_EnergyOffPeakCharge);
    check(
      'label repair: identity open, OffPeakKWh is not the sum',
      !near(n(h.OffPeakKWh), 1400, 0.001),
      String(h.OffPeakKWh),
    );
    check('label repair: identity open, the bill is held', h._gateTripped === true, JSON.stringify(h._gateReasons));
  }

  // ---- clean labeled page: nothing proposed, nothing held ----------------------------------------------------------
  {
    const [b] = await pipeline(labeledPage({}));
    check('clean page: not held', !b._gateTripped, JSON.stringify(b._gateReasons));
    check(
      'clean page: nothing proposed',
      !Object.keys(b).some((k) => k.startsWith('_proposed_')),
      Object.keys(b)
        .filter((k) => k.startsWith('_proposed_'))
        .join(),
    );
    check('clean page: Off peak read as printed', near(n(b.EnergyOffPeakCharge), 83.12), String(b.EnergyOffPeakCharge));
  }

  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => {
  console.log('FAIL harness: ' + (e && e.stack));
  process.exit(1);
});
