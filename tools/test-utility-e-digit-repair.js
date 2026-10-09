/**
 * test-utility-e-digit-repair.js
 *
 * Regression tests for Utility E meter-table digit repair (app/energy-savings.js) and the bill checks
 * that follow it (app/bill-analysis.js). SYNTHETIC text only: fake account numbers, addresses, dates and
 * round numbers. Each case names the defect it guards.
 *
 * Usage: node tools/test-utility-e-digit-repair.js [repo-root]
 *   Pass the root of a PRE-FIX checkout to confirm the tests fail on the old code.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/eui.js',
  'computations/hvac-enduse.js',
  'computations/pollution.js',
  'computations/csc.js',
  'computations/savings.js',
  'computations/bill-flags.js',
  'computations/anomaly-detection.js',
  'lib/perf-table.js',
  'lib/shared-charts.js',
  'computations/report-data.js',
  'computations/data-quality.js',
  'extraction/pdf-engine.js',
  'app/sync-classification.js',
  'app/db.js',
  'app/core.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
  'extraction/bill-validation.js',
  'app/utility-data.js',
];
const names = [
  'UTILITY_RULES',
  '_postExtractionVerify',
  'validateBillData',
  'countCriticalMissing',
  '_findAltPassBill',
  '_isMultiMeterBill',
];
function load() {
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, getContext: () => null }),
    },
    navigator: { userAgent: 'n' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Tesseract: {},
    pdfjsLib: {},
    Chart: function () {},
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    performance: { now: () => Date.now() },
    Image: function () {},
  };
  sb.globalThis = sb;
  sb.self = sb;
  const ctx = vm.createContext(sb);
  for (const r of ORDER) {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, r), 'utf8'), ctx, { filename: r });
    } catch (e) {
      /* a page-only file may not load headless; the engine files above are enough */
    }
  }
  vm.runInContext(names.map((n) => `this.__${n} = typeof ${n} !== "undefined" ? ${n} : null;`).join('\n'), ctx);
  const out = {};
  for (const n of names) out[n] = ctx['__' + n];
  return out;
}

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log('  PASS ' + label);
  else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' - ' + detail : ''));
  }
}
const eq = (a, b) => a != null && b != null && Math.abs(parseFloat(a) - parseFloat(b)) < 0.00051;

const L = load();

const HEAD =
  'Meter                   Start        End      Days         End               Start             Read             Meter\n' +
  'Read Date Read Date                Read (+)        Read (=) Difference (x)      Multiplier (=)      kWh Used          KW Used        RKVA Used\n';
function doc(rows, extra) {
  return (
    '%%PAGE_1%%\nCustomer Name : TEST DISTRICT\nAccount Number : 1000001\n100 FIRST ST TESTVILLE KS\n' +
    'LGS Secondary Voltage - 2LGSE        Billing Details - service from 01/09/2030 to 02/09/2030\n' +
    'Customer Chg ..................... $10.00\n' +
    (extra || '') +
    HEAD +
    // Rows use two spaces between values (the commit scan reads one-space digit runs as phone numbers).
    // A tilde marks the one single space inside a split value.
    rows.map((r) => r.replace('~', ' ')).join('\n') +
    '\nCurrent Charges $500.00\n'
  );
}
const rule = L.UTILITY_RULES.find((r) => r.detect(doc([])));
if (!rule) throw new Error('Utility E rule not found under ' + ROOT);

async function run(rows, extra) {
  const text = doc(rows, extra);
  const bills = rule.extractAll(text);
  const v = await L._postExtractionVerify(bills, rule.name, text);
  return v.bills[0];
}

(async () => {
  let b;

  console.log('Case 1: decimal point of StartRead OCR-read as a space shifts every later column');
  b = await run(['01/09  02/09  31  7,246.5170  5,931~2048  1,315.3122  40.0000  52,612.4880  61.3840  14.7360']);
  check('StartRead joined', eq(b.StartRead, 5931.2048), 'StartRead=' + b.StartRead);
  check('Multiplier stays 40', eq(b.MeterMultiplier, 40), 'mult=' + b.MeterMultiplier);
  check('ActualKW is the KW column', eq(b.ActualKW, 61.384), 'ActualKW=' + b.ActualKW);
  check('ActualRKVA is the RKVA column', eq(b.ActualRKVA, 14.736), 'ActualRKVA=' + b.ActualRKVA);
  check('kWhConsumed is the kWh column', eq(b.kWhConsumed, 52612.488), 'kWh=' + b.kWhConsumed);

  console.log('Case 2: decimal point of the kWh, KW and RKVA columns OCR-read as a comma');
  b = await run(['01/09  02/09  31  7,246.5000  5,931.2000  1,315.3000  1.0000  1,315,3000  61,3840  14,7360']);
  check('kWhConsumed', eq(b.kWhConsumed, 1315.3), 'kWh=' + b.kWhConsumed);
  check('ActualKW', eq(b.ActualKW, 61.384), 'ActualKW=' + b.ActualKW);
  check('ActualRKVA', eq(b.ActualRKVA, 14.736), 'ActualRKVA=' + b.ActualRKVA);

  console.log('Case 3: meter id glued to the first date must not shift the row');
  b = await run(['Abcdef900123  01/09  0209  31  485954010  45,423.0010  3,172.4000  1.0000  3,172.4000  9.3140  1.0000']);
  check('EndRead', eq(b.EndRead, 48595.401), 'EndRead=' + b.EndRead);
  check('StartRead', eq(b.StartRead, 45423.001), 'StartRead=' + b.StartRead);
  check('ActualKW', eq(b.ActualKW, 9.314), 'ActualKW=' + b.ActualKW);

  console.log('Case 4: Difference, kWh and KW lose their decimal point (bare digits)');
  b = await run(['01/09  02/09  31  7,246.5000  5,931.2000  13153000  1.0000  13153000  613840  147360']);
  check('ReadDifference', eq(b.ReadDifference, 1315.3), 'diff=' + b.ReadDifference);
  check('kWhConsumed', eq(b.kWhConsumed, 1315.3), 'kWh=' + b.kWhConsumed);
  check('ActualKW', eq(b.ActualKW, 61.384), 'ActualKW=' + b.ActualKW);

  console.log('Case 5: Difference and kWh both lose the point, and EndRead has one misread digit');
  b = await run(['01/09  02/09  31  14,362.6418  13,907.2563  4753855  80.0000  380308400  31.5280  19.4640']);
  check('ReadDifference', eq(b.ReadDifference, 475.3855), 'diff=' + b.ReadDifference);
  check('EndRead repaired from the two agreeing columns', eq(b.EndRead, 14382.6418), 'EndRead=' + b.EndRead);
  check('kWhConsumed', eq(b.kWhConsumed, 38030.84), 'kWh=' + b.kWhConsumed);

  console.log('Case 6 (3c56032b): a correct EndRead is not rewritten to fit a misread StartRead');
  // True row: End 62,418.7000 / Start 61,121.4000 / Diff 1,297.3000 / kWh 1,297.3000. OCR misread
  // StartRead (0 -> 5 is not a known confusion) and the kWh column (0 -> 8).
  b = await run(['01/09  02/09  31  62,418.7000  61,121.4050  1,297.3000  1.0000  1,297.3080  11.2840  5.0000']);
  check('EndRead untouched', eq(b.EndRead, 62418.7), 'EndRead=' + b.EndRead);
  check('ReadDifference untouched', eq(b.ReadDifference, 1297.3), 'diff=' + b.ReadDifference);

  console.log('Case 7 (control): two misread reads and a misread Difference are still repaired');
  // True row: End 31,426.0600 / Start 29,865.1510 / Diff 1,560.9090 / kWh 1,560.9090.
  b = await run(['01/09  02/09  31  31,426.0800  29,866.1510  1,560.8080  1.0000  1,560.9090  4.2650  1.0000']);
  check('EndRead repaired', eq(b.EndRead, 31426.06), 'EndRead=' + b.EndRead);
  check('StartRead repaired', eq(b.StartRead, 29865.151), 'StartRead=' + b.StartRead);
  check('ReadDifference repaired', eq(b.ReadDifference, 1560.909), 'diff=' + b.ReadDifference);

  console.log('Case 8: two meter rows, one kWh column misread, reads and Difference agree');
  b = await run([
    '01/09  02/09  31  15,500.5000  5,000.0000  10,500.5000  1.0000  10,500.5000  5.0000  1.0000',
    '01/09  02/09  31  13,100.2500  3,000.0000  10,100.2500  1.0000  10,190.2500  2.0000  0.5000',
  ]);
  check('kWhConsumed sums the repaired row', eq(b.kWhConsumed, 20600.75), 'kWh=' + b.kWhConsumed);
  check('Meter2_kWh', eq(b.Meter2_kWh, 10100.25), 'Meter2_kWh=' + b.Meter2_kWh);

  console.log('Case 9: ActualKW within 0.001 of BilledKW = TDCkW is aligned');
  b = await run(
    ['01/09  02/09  31  7,246.5000  5,931.2000  1,315.3000  1.0000  1,315.3000  38,4120  14.7360'],
    'Demand Chg 38.4126 kW at $2.246 per kW ...           $86.27\n' +
      'TDC Chg 01-09-2030-02-09-2030 for 38.4126 kW at $2.17 per kW        $83.36\n' +
      'Facilities Chg 61.3840 kW at $2.931 per kW        $179.92\n',
  );
  check('ActualKW equals BilledKW', eq(b.ActualKW, 38.4126), 'ActualKW=' + b.ActualKW + ' BilledKW=' + b.BilledKW);

  // ── bill-analysis checks ──
  console.log('Case 10 (3cdf53ff): kWh ceiling scales with the number of summed meter rows');
  const mk = (o) =>
    Object.assign(
      {
        UtilityCompany: rule.name,
        AccountNumber: '1000001',
        ServiceAddress: '100 FIRST ST TESTVILLE KS',
        BillingPeriodStart: '01/09/2030',
        BillingPeriodEnd: '02/09/2030',
        TotalCurrentCharges: '500.00',
      },
      o,
    );
  let r = await L._postExtractionVerify(
    [mk({ kWhConsumed: '750000.0000', _meterInfo: { type: 'meter_change', rows: 2 } })],
    rule.name,
    '',
  );
  check('two-row bill keeps 750000', eq(r.bills[0].kWhConsumed, 750000), 'kWh=' + r.bills[0].kWhConsumed);
  r = await L._postExtractionVerify([mk({ kWhConsumed: '750000.0000' })], rule.name, '');
  check('one-row bill above 500000 is still rejected', r.bills[0].kWhConsumed == null, 'kWh=' + r.bills[0].kWhConsumed);
  check(
    '_isMultiMeterBill: one row is not multi-meter',
    !L._isMultiMeterBill({ _meterInfo: { type: 'meter_change', rows: 1 } }),
  );

  console.log('Case 11 (af0b7fe6): an alternate-pass bill is matched by account AND period, never by position');
  const alt = [
    { AccountNumber: '999000', BillingPeriodStart: '01/09/2030', BillingPeriodEnd: '02/09/2030' },
    { AccountNumber: '1000001', BillingPeriodStart: '01/09/2030', BillingPeriodEnd: '02/09/2030' },
  ];
  const me = { AccountNumber: '1000-001', BillingPeriodStart: '01/09/2030', BillingPeriodEnd: '02/09/2030' };
  check('same account is chosen over the first bill', L._findAltPassBill(alt, me) === alt[1]);
  check('no same-account bill returns null', L._findAltPassBill([alt[0]], me) === null);
  check(
    'bill without an account matches nothing',
    L._findAltPassBill(alt, { BillingPeriodStart: '01/09/2030' }) === null,
  );

  console.log('Case 12 (446b569b): a neighbor read fills a missing read only when the neighbor is proven');
  const good = (o) =>
    mk(
      Object.assign(
        {
          StartRead: '1000.0000',
          EndRead: '1100.0000',
          ReadDifference: '100.0000',
          MeterMultiplier: '10.0000',
          kWhConsumed: '1000.0000',
        },
        o,
      ),
    );
  const next = (o) =>
    mk(Object.assign({ BillingPeriodStart: '02/09/2030', BillingPeriodEnd: '03/09/2030', EndRead: '1250.0000' }, o));
  r = await L._postExtractionVerify([good(), next({ StartRead: null })], rule.name, '');
  check('proven neighbor fills StartRead', eq(r.bills[1].StartRead, 1100), 'StartRead=' + r.bills[1].StartRead);
  r = await L._postExtractionVerify([good({ ReadDifference: '120.0000' }), next({ StartRead: null })], rule.name, '');
  check(
    'neighbor whose own table fails is not copied',
    !eq(r.bills[1].StartRead, 1100),
    'StartRead=' + r.bills[1].StartRead,
  );
  r = await L._postExtractionVerify(
    [
      good({ _digitCorrections: [{ field: 'EndRead', original: '1190.0000', corrected: '1100.0000' }] }),
      next({ StartRead: null }),
    ],
    rule.name,
    '',
  );
  check(
    'neighbor read that was digit-guessed is not copied',
    !eq(r.bills[1].StartRead, 1100),
    'StartRead=' + r.bills[1].StartRead,
  );
  r = await L._postExtractionVerify(
    [good(), next({ StartRead: null, ServiceAddress: '200 SECOND ST TESTVILLE KS' })],
    rule.name,
    '',
  );
  check(
    'neighbor at another address is not copied',
    !eq(r.bills[1].StartRead, 1100),
    'StartRead=' + r.bills[1].StartRead,
  );

  console.log('Case 13 (06fc5cc8): a bill that has its total is not flagged as missing it');
  const cityTotalOnly = {
    BillingPeriodStart: '01/09/2030',
    BillingPeriodEnd: '02/09/2030',
    TotalCurrentCharges: '50.00',
  };
  check('no critical field missing', L.countCriticalMissing(cityTotalOnly, 'City of Baldwin City') === 0);
  check(
    'no error warning',
    !L.validateBillData(cityTotalOnly, 'City of Baldwin City').some((w) => w.level === 'error'),
  );
  check(
    'a bill with no total is still flagged',
    L.countCriticalMissing(
      { BillingPeriodStart: '01/09/2030', BillingPeriodEnd: '02/09/2030' },
      'City of Baldwin City',
    ) === 1,
  );

  console.log('Case 16: a read is misprinted; one digit repair explains Difference, none explains the kWh column');
  b = await run([
    '01/09  02/09  31  20,000.5000  10,000.0000  10,000.5000  1.0000  10,000.5000  5.0000  1.0000',
    '01/09  02/09  31  58,695.4010  65,533.0010  3,162.4000  1.0000  3,152.4000  9.3140  1.0000',
  ]);
  check('Meter2_kWh is Difference x Multiplier', eq(b.Meter2_kWh, 3162.4), 'Meter2_kWh=' + b.Meter2_kWh);
  check('kWhConsumed sums it', eq(b.kWhConsumed, 13162.9), 'kWh=' + b.kWhConsumed);

  console.log('Case 17 (control): a read is misprinted and no digit repair explains Difference: column stays');
  b = await run([
    '01/09  02/09  31  20,000.5000  10,000.0000  10,000.5000  1.0000  10,000.5000  5.0000  1.0000',
    '01/09  02/09  31  48,695.4010  80,000.0000  3,162.4000  1.0000  3,152.4000  9.3140  1.0000',
  ]);
  check('Meter2_kWh stays as printed', eq(b.Meter2_kWh, 3152.4), 'Meter2_kWh=' + b.Meter2_kWh);

  console.log('Case 18: new meter, End, Start, Difference and kWh all lose the point; Start has 5 digits');
  // Printed End - Start = 2740.9770, printed Difference = 2740.9800 (the bill is off by 0.0030).
  b = await run(['04/22  06/01  40  27483920  74150  27409800  1.0000  27409800  68.2500  0.6500']);
  check('StartRead keeps its point position', eq(b.StartRead, 7.415), 'StartRead=' + b.StartRead);
  check('EndRead', eq(b.EndRead, 2748.392), 'EndRead=' + b.EndRead);
  check('ReadDifference', eq(b.ReadDifference, 2740.98), 'diff=' + b.ReadDifference);

  const CHG = (on, off, tot) =>
    'Energy Chg On Pk Win ' + on[0] + ' kWh at\n   $0.03723 per kWh ........  $' + on[1] + '\n' +
    'Energy Chg Off Pk Win ' + off[0] + ' kWh at\n   $0.03266 per kWh ........  $' + off[1] + '\n' +
    'EER Chg 01-09-2030-02-09-2030 for\n   ' + tot[0] + ' kWh at $0.00056 per kWh ........  $' + tot[1] + '\n' +
    'PTS Chg 01-09-2030-02-09-2030 for\n   ' + tot[0] + ' kWh at $0.00103 per kWh ........  $' + tot[2] + '\n';
  const CHG_TEXT = CHG(['2,165.0000', '80.60'], ['900.0000', '29.39'], ['3,065.0000', '1.72', '3.16']);
  console.log('Case 19: a sum with a repaired row defers to the printed charge-line total that agrees');
  b = await run(
    [
      '01/09  02/09  31  11,600.0000  10,000.0000  1,600.0000  1.0000  1,600.0000  5.0000  1.0000',
      '01/09  02/09  31  11,465.2000  10,000.0000  1,465.2000  1.0000  1,455.2000  9.3140  1.0000',
    ],
    CHG_TEXT,
  );
  check('kWhConsumed is the charge-line total', eq(b.kWhConsumed, 3065), 'kWh=' + b.kWhConsumed);
  check('Meter2_kWh keeps the repaired row', eq(b.Meter2_kWh, 1465.2), 'Meter2_kWh=' + b.Meter2_kWh);

  console.log('Case 20 (control): a sum of rows read as printed is not replaced by the charge-line total');
  b = await run(
    [
      '01/09  02/09  31  11,600.0000  10,000.0000  1,600.0000  1.0000  1,600.0000  5.0000  1.0000',
      '01/09  02/09  31  11,465.2000  10,000.0000  1,465.2000  1.0000  1,465.2000  9.3140  1.0000',
    ],
    CHG_TEXT,
  );
  check('kWhConsumed is the meter sum', eq(b.kWhConsumed, 3065.2), 'kWh=' + b.kWhConsumed);

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})();
