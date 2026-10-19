/**
 * test-utility-e-billing-details.js
 *
 * Utility E "Billing Details" reader (app/energy-savings.js + app/bill-analysis.js Stage 3), 2026-10-19:
 *  1. A cut end year on the "service from MM/DD/YYYY to MM/DD/YY" line is completed from the start year
 *     (+1 when the end month is before the start month). _evgServicePeriod is the one reader.
 *  2. NumberOfDays comes from the meter read dates (read to read, calcDays exclusive), with the year from the
 *     billing period or the bill date. The printed Days column is only a check. _evgNumberOfDays is the one rule.
 *  3. A Customer Chg line whose cents OCR lost ("$41}") never takes the next line's amount; the cents come only
 *     from Subtotal minus the other printed lines, only when the result starts with the read dollars, and the
 *     value is marked derived.
 *  4. TotalCurrentCharges is the printed Current Charges; lines = Subtotal and Subtotal + fee = Current Charges
 *     are checked (checkElectricPrintedTotals); a computed sum is never stored over a printed total.
 *
 * Node test, real functions from app/*.js and computations/*.js in a vm, SYNTHETIC pages only (no client name,
 * account, address or amount from a real bill).
 * Usage: node tools/test-utility-e-billing-details.js   (expect "ALL PASSED", exit 0)
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
  'this.__rules = UTILITY_RULES; this.__verify = _postExtractionVerify; this.__gates = _applyExtractionGates;' +
    'this.__days = _evgNumberOfDays; this.__period = _evgServicePeriod;',
  sb,
);
// The rule that owns a page is the one whose own detect accepts it (same choice as tools/test-utility-e-detached-amounts.js).
const ruleFor = (text) => sb.__rules.find((r) => r.detect(text));

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

// ---- synthetic page ------------------------------------------------------------------------------------------
// Printed lines above the Subtotal: 41.50 + 142.70 + 553.92 + 160.00 + 400.00 + 300.00 + 197.10 + 5.60 + 10.30 +
// 117.07 - 300.00 = 1,628.19 (Subtotal). Franchise fee 81.41. Current Charges 1,709.60.
function page(o) {
  o = Object.assign(
    {
      from: '03/04/2030',
      to: '04/02/20.', // cut end year, as the scan prints it
      readStart: '03/05',
      readEnd: '04/03',
      customer: '$41}', // cents lost
      subtotalLine: 'SUBLOLA irrreeveerresseoneses ersten essere     $1,628.19',
      billDate: 'Billing Date: 04/10/2030',
      extra: '',
      header: 'Billing Details - service from ',
    },
    o || {},
  );
  return [
    'Customer Name : SAMPLE DISTRICT',
    'Account Number : SAMPLE-ACCT',
    o.billDate,
    '100 SAMPLE DR EXAMPLETON KS',
    'MGS Secondary Voltage Commercial - 2MGSE                             ' + o.header + o.from + ' to ' + o.to,
    'Customer Chg ..........ccoimrmmmesiisereosniesiiaivnnn      ' + o.customer,
    'kon                      Energy Use                                           Facilties Chg 50.0000 kW at $2.854 per kW ..            $142.70',
    '15000                                                                        Demand Chg 48.0000 kW at $11.54 per kW ....            $553.92',
    'Energy Chg On Pk Win 2,000.0000 kWh at',
    '10000 —                                                                            $0.08000 per kWh...             $160.00',
    'Energy Chg Off Pk Win 8,000.0000 kWh at',
    '5000 —                                                        $0.05000 per KWH ....icvmrecimnesiassieneniis          $400.00',
    'Tax exempt delivery cost from bill ...................           $300.00',
    'ECA Chg 03-05-2030-04-02-2030 for',
    '10,000.0000 kWh at $0.01971 per kWh ..........           $197.10',
    o.extra,
    'EER Chg 03-05-2030-04-02-2030 for',
    '10,000.0000 kWh at $0.00056 per kWh ..........              $5.60',
    'PTS Chg 03-05-2030-04-02-2030 for',
    '10,000.0000 kWh at $0.00103 per kWh ..........            $10.30',
    'TDC Chg 03-05-2030-04-02-2030 for 48.0000                         Eg',
    'KW at $2.43891 per kW .....cccciveionmnniiniiennennnns         $117.07',
    'Bill OffSet ovement       -$300.00',
    o.subtotalLine,
    'Exampleton Franchise Fee ..........iee lites          $81.41',
    'Current Charges .........usimsessmemssssisennes      $1,709.60',
    'Start          End                       End             Start            Read            Meter',
    'Read Date     Read Date      Days        Read (9)       Read (=)    Difference (x)     Multiplier . (=)    kWh Used        KW Used        RKVA Used',
    o.readStart + '   ' + o.readEnd + '   2   11,250.0000   10,000.0000   1,250.0000   8.0000   10,000.0000   48.0000   15.0000   E',
  ].join('\n');
}
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
  return bills[0];
};

(async () => {
  // ---- 1. cut end year ------------------------------------------------------------------------------------
  console.log('-- 1. cut end year on the service-from line');
  let b = extractOnly(page());
  check('1a start date read', b.BillingPeriodStart === '03/04/2030', b.BillingPeriodStart);
  check('1b end year taken from the start year', b.BillingPeriodEnd === '04/02/2030', b.BillingPeriodEnd);
  check(
    '1c the fill is recorded (original = what the page shows)',
    b._auto_corrected_BillingPeriodEnd &&
      b._auto_corrected_BillingPeriodEnd.original === '04/02/20' &&
      b._auto_corrected_BillingPeriodEnd.corrected === '04/02/2030' &&
      b._auto_corrected_BillingPeriodEnd.derived === true,
    JSON.stringify(b._auto_corrected_BillingPeriodEnd),
  );
  b = extractOnly(page({ from: '12/04/2029', to: '01/02/20', readStart: '12/05', readEnd: '01/03' }));
  check('1d end month before start month: year + 1', b.BillingPeriodEnd === '01/02/2030', b.BillingPeriodEnd);
  b = extractOnly(page({ to: '04/02/2030' }));
  check('1e a full end year is read as printed, no record', b.BillingPeriodEnd === '04/02/2030' && !b._auto_corrected_BillingPeriodEnd);
  const p3 = sb.__period('service from 03/04/2030 to 04/02/203');
  check('1f three-digit cut year is completed', p3 && p3.end === '04/02/2030' && p3.endYearFilled === true, JSON.stringify(p3));
  b = await pipeline(page());
  check('1g the fill record survives the verify pass', !!b._auto_corrected_BillingPeriodEnd && b.BillingPeriodEnd === '04/02/2030');

  // ---- 2. NumberOfDays from the meter read dates ----------------------------------------------------------
  console.log('-- 2. NumberOfDays from the meter read dates');
  b = extractOnly(page());
  check('2a 29 days from 03/05 to 04/03 (printed Days column "2" is not used)', b.NumberOfDays === '29', b.NumberOfDays);
  check(
    '2b the source and the printed-column check are recorded',
    b._numberOfDaysCheck &&
      b._numberOfDaysCheck.source === 'meter read dates' &&
      b._numberOfDaysCheck.readStart === '03/05/2030' &&
      b._numberOfDaysCheck.readEnd === '04/03/2030' &&
      b._numberOfDaysCheck.readDays === 29 &&
      b._numberOfDaysCheck.periodDays === 29 &&
      b._numberOfDaysCheck.printedDays === '2' &&
      b._numberOfDaysCheck.printedDaysAgree === false,
    JSON.stringify(b._numberOfDaysCheck),
  );
  // Read dates give 28, the billing period 29, the printed Days column is cut ("2", implausible): the read dates win.
  b = extractOnly(page({ readEnd: '04/02' }));
  check('2h read dates (28) disagree with the billing period (29), printed Days unreadable: the read dates win', b.NumberOfDays === '28' && b._numberOfDaysCheck.source === 'meter read dates', b.NumberOfDays + ' ' + JSON.stringify(b._numberOfDaysCheck));
  // The printed Days column confirms the read dates (40) against the billing period (39): the read dates win.
  b = extractOnly(page({ from: '03/03/2030', readEnd: '04/02' }).replace(/04\/02\s+2\s+11,250/, '04/02   28   11,250')); // period 03/03-04/02 = 30, read 03/05-04/02 = 28, printed 28
  check('2i the printed Days column confirms the read dates (28) against the billing period (30): read dates win', b.NumberOfDays === '28' && b._numberOfDaysCheck.source === 'meter read dates' && b._numberOfDaysCheck.printedDaysAgree === true, b.NumberOfDays + ' ' + JSON.stringify(b._numberOfDaysCheck));
  b = extractOnly(page({ readEnd: '04/02' }).replace(/04\/02\s+2\s+11,250/, '04/02   29   11,250')); // read 28, period 29, printed 29
  check('2j a valid printed Days (29) that contradicts the read dates (28) and equals the billing period: the billing period, reason recorded', b.NumberOfDays === '29' && b._numberOfDaysCheck.printedDaysAgree === true && /billing period/.test(b._numberOfDaysCheck.source), b.NumberOfDays + ' ' + JSON.stringify(b._numberOfDaysCheck));
  b = await pipeline(page({ readEnd: '04/02' }));
  check('2k the check is written once, after the read dates are validated, and survives the pipeline', b.NumberOfDays === '28' && b._numberOfDaysCheck && b._numberOfDaysCheck.periodDays === 29 && b._numberOfDaysCheck.readDays === 28, JSON.stringify(b._numberOfDaysCheck));
  b = extractOnly(page({ header: 'Billing Details - servlce frum ' }));
  check('2c no billing period read: the read dates still give 29 days (year from the bill date)', b.BillingPeriodStart === null && b.NumberOfDays === '29', b.BillingPeriodStart + ' ' + b.NumberOfDays);
  b = extractOnly(page({ header: 'Billing Details - servlce frum ', readStart: '12/05', readEnd: '01/03', billDate: 'Billing Date: 01/10/2030' }));
  check('2d read dates across New Year with only the bill date: 29 days', b.NumberOfDays === '29', b.NumberOfDays);
  let d = sb.__days('03/05', '04/03', '03/04/2030', '04/02/2030', null);
  check('2e one rule: _evgNumberOfDays gives 29 from the read dates', d && d.days === '29' && d.source === 'meter read dates', JSON.stringify(d));
  d = sb.__days(null, null, '03/04/2030', '04/02/2030', null);
  check('2f no read dates: the billing period gives the days, marked as such', d && d.days === '29' && d.source === 'billing period', JSON.stringify(d));
  d = sb.__days('03/05', '04/02', '03/04/2030', '04/02/2030', null, '3647');
  check('2l implausible printed Days (3647): the read dates (28) win', d && d.days === '28' && d.source === 'meter read dates', JSON.stringify(d));
  d = sb.__days('03/05', '04/02', '03/04/2030', '04/02/2030', null, '50');
  check('2m printed Days outside 1-45 (50): the read dates win', d && d.days === '28', JSON.stringify(d));
  d = sb.__days('03/05', '04/03', null, null, null);
  check('2g no year anywhere: no days', d === null, JSON.stringify(d));

  // ---- 3. Customer Chg with unreadable cents --------------------------------------------------------------
  console.log('-- 3. Customer Chg cents');
  b = await pipeline(page());
  check('3a the cents come from Subtotal minus the other lines: 41.50', b.CustomerCharge === '41.50', b.CustomerCharge);
  check('3b the Facilities amount is not taken as the Customer Charge', b.FacilitiesCharge === '142.70', b.FacilitiesCharge);
  check(
    '3c marked derived, with the read dollars and the arithmetic in the reason',
    b._auto_corrected_CustomerCharge &&
      b._auto_corrected_CustomerCharge.derived === true &&
      b._auto_corrected_CustomerCharge.original === null &&
      /\$41/.test(b._auto_corrected_CustomerCharge.reason) &&
      /Subtotal \$1628\.19/.test(b._auto_corrected_CustomerCharge.reason),
    JSON.stringify(b._auto_corrected_CustomerCharge),
  );
  b = await pipeline(page({ subtotalLine: 'Subtotal ..........     $1,700.19' }));
  check('3d Subtotal that gives 113.50 (does not start with 41.): no Customer Charge, nothing taken from another line', b.CustomerCharge === null || b.CustomerCharge === undefined, b.CustomerCharge);
  check('3e the partial read is recorded', b._customerChargePartial && b._customerChargePartial.read === '$41', JSON.stringify(b._customerChargePartial));
  b = await pipeline(page({ subtotalLine: 'Subtolal' }));
  check(
    '3f no Subtotal amount: the printed Current Charges gap (41.50, starts with the read $41) fills it, marked recovered; never the Facilities amount',
    b.CustomerCharge === '41.50' && !!b._auto_recovered_CustomerCharge && b.FacilitiesCharge === '142.70',
    b.CustomerCharge + ' ' + JSON.stringify(b._auto_recovered_CustomerCharge),
  );
  b = await pipeline(page({ subtotalLine: 'Subtolal', customer: '$43}' }));
  check('3h no Subtotal and the gap (41.50) does not start with the read $43: no Customer Charge', b.CustomerCharge === null || b.CustomerCharge === undefined, b.CustomerCharge);
  b = await pipeline(page({ customer: '$41.50' }));
  check('3g a readable Customer Chg is read as printed, no derived record', b.CustomerCharge === '41.50' && !b._auto_corrected_CustomerCharge, JSON.stringify(b._auto_corrected_CustomerCharge));

  // ---- 4. printed totals ----------------------------------------------------------------------------------
  console.log('-- 4. printed totals');
  b = await pipeline(page());
  check('4a TotalCurrentCharges is the printed Current Charges', b.TotalCurrentCharges === '1709.60', b.TotalCurrentCharges);
  check('4b Subtotal read through the OCR label "SUBLOLA"', b._subtotal === '1628.19', b._subtotal);
  check(
    '4c lines = Subtotal and Subtotal + fee = Current Charges, to the cent',
    b._printedTotalCheck &&
      b._printedTotalCheck.linesMatchSubtotal === true &&
      b._printedTotalCheck.subtotalPlusFeesMatchTotal === true &&
      b._printedTotalCheck.belowSubtotal === 81.41,
    JSON.stringify(b._printedTotalCheck),
  );
  check('4d no pending total correction, no charge-sum total', !b._correction_pending_TotalCurrentCharges && !b._totalFromChargeSum);
  // A doubled line (OCR printed the ECA line twice): the charge sum exceeds the printed total.
  const doubled = 'ECA Chg 03-05-2030-04-02-2030 for 10,000.0000 kWh at $0.01971 per kWh ..........           $197.10';
  b = await pipeline(page({ extra: doubled }));
  check('4e with a corroborated Subtotal the printed total is kept and the mismatch is flagged', b.TotalCurrentCharges === '1709.60' && !!b._sum_mismatch && !b._totalFromChargeSum, b.TotalCurrentCharges + ' ' + JSON.stringify(b._sum_mismatch));
  b = await pipeline(page({ extra: doubled, subtotalLine: 'Subtolal', customer: '$41.50' }));
  check(
    '4f without a Subtotal the printed total is still never replaced: proposed and held',
    b.TotalCurrentCharges === '1709.60' && !b._totalFromChargeSum && (!!b._correction_pending_TotalCurrentCharges || !!b._sum_mismatch),
    b.TotalCurrentCharges + ' ' + JSON.stringify(b._correction_pending_TotalCurrentCharges || b._sum_mismatch),
  );

  // The printed Current Charges is the total even when the read charges add up to far less (a charge line not read):
  // the sum is never stored in its place. Shape 1: Subtotal label lost, dot/letter leader before the amount.
  const dropLines = (text, res) => text.split('\n').filter((l) => !res.some((r) => r.test(l))).join('\n');
  const partial = (text) => dropLines(text, [/Demand Chg 48/, /Energy Chg Off Pk Win/, /\$0\.05000/, /^5000/]);
  const noisyCc = (text) => text.replace(/Current Charges \.+\s+\$1,709\.60/, 'Current Charges ..........msssssss      $1,709.60');
  b = await pipeline(noisyCc(partial(page({ subtotalLine: 'Subtolal', customer: '$41.50' }))));
  check(
    '4g Subtotal label lost, leader noise, read charges far below the page: TotalCurrentCharges is the printed 1709.60',
    b.TotalCurrentCharges === '1709.60' && !b._totalFromChargeSum,
    b.TotalCurrentCharges + ' sum=' + (b._printedTotalCheck && b._printedTotalCheck.linesSum),
  );
  // Shape 2: a record whose read lines are only part of the page (meter-change segment): Subtotal = Current Charges
  // = 1,628.19 printed, no fee line. The total is the printed one, never the sum of the lines read.
  const noFee = (text) => text.replace(/^Exampleton Franchise Fee.*$/m, '').replace(/\$1,709\.60/, '$1,628.19');
  b = await pipeline(noFee(partial(page())));
  check(
    '4h partial-line record: TotalCurrentCharges is the printed 1628.19 (not the partial line sum)',
    b.TotalCurrentCharges === '1628.19' && !b._totalFromChargeSum,
    b.TotalCurrentCharges + ' ' + JSON.stringify(b._printedTotalCheck),
  );
  check('4i the Current Charges reader has no sum substitution (no "calcSum * 1.5")', !/calcSum \* 1\.5/.test(fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8')));

  // ---- 5. one copy of each rule ---------------------------------------------------------------------------
  console.log('-- 5. single source');
  const es = fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8');
  const ba = fs.readFileSync(path.join(root, 'app', 'bill-analysis.js'), 'utf8');
  check(
    '5a one Subtotal label pattern (energy-savings.js): no second copy, no plain /Subtotal/i test',
    (es.match(/Sub\[tl\]\?\[o0\]/g) || []).length === 1 && !/Sub\[tl\]\?ota/.test(es) && !/\/Subtotal\/i/.test(es),
  );
  check(
    '5b every service-from reader goes through _evgServicePeriod (the one .match is inside it)',
    (es.match(/\.match\(_EVG_SERVICE_FROM\)/g) || []).length === 1 && !/\.match\(_EVG_SERVICE_FROM\)/.test(ba),
  );
  check('5c NumberOfDays is not computed from the billing period in the Utility E reader', !/calcDays\(winner\.start, winner\.end/.test(es) && !/calcDays\(bpMatch/.test(es));
  check('5d the charge sum is never written over the printed total (no _totalFromChargeSum write)', !/_totalFromChargeSum = true/.test(ba));

  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();
