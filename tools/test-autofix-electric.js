/**
 * test-autofix-electric.js
 *
 * The one autofix rule (_lbg_autofix) with its Utility E sources (2026-10-20): a value whose read failed its
 * check is filled only when two independent sources agree; otherwise the bill keeps its hold or flag. The gas
 * path calls the same function (tools/test-lbg-printed-gas-line.js section 7).
 *
 * SYNTHETIC bills only (account 'SAMPLE-ACCT'). Loads the real functions from app/energy-savings.js via vm.
 *
 * Usage: node tools/test-autofix-electric.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', lib), 'utf8'), sandbox, { filename: lib });
const udSrc = fs.readFileSync(path.join(root, 'app', 'utility-data.js'), 'utf8');
const fn = (name) => {
  const m = udSrc.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
  return m ? m[0].replace(/\r\n/g, '\n') : '';
};
vm.runInContext(fn('_fixISO') + fn('_parseISO') + fn('calcDays'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'computations', 'rates.js'), 'utf8'), sandbox, { filename: 'rates.js' });
const src = fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8');
vm.runInContext(src, sandbox, { filename: 'energy-savings.js' });
const apply = vm.runInContext('_evgApplyAutofix', sandbox);
const autofix = vm.runInContext('_lbg_autofix', sandbox);

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const base = (extra) => Object.assign({ Commodity: 'Electric', AccountNumber: 'SAMPLE-ACCT', MeterMultiplier: '160.0000' }, extra);

// 1. kWh: the scan lost a digit (4800 for 48000). Reads x multiplier and the digit repair agree: filled.
let b = base({ StartRead: '1000.0000', EndRead: '1300.0000', kWhConsumed: '4800.0000', _kwhCrossCheck: { extracted: 4800, calculated: 48000, diff: 43200 } });
apply([b]);
check('1 kWh filled from reads x multiplier + digit repair', parseFloat(b.kWhConsumed) === 48000 && !b._kwhCrossCheck, JSON.stringify([b.kWhConsumed, b._kwhCrossCheck]));
check('1 kWh hover reason names the method and the scan', b._auto_corrected_kWhConsumed && /meter reads 300 x 160 = 48000/.test(b._auto_corrected_kWhConsumed.reason) && /4800/.test(b._auto_corrected_kWhConsumed.reason), JSON.stringify(b._auto_corrected_kWhConsumed));

// 1b. kWh: the multiplier is not printed; the same account's other bills share 160.
b = base({ MeterMultiplier: null, StartRead: '1000.0000', EndRead: '1300.0000', kWhConsumed: '4800.0000', _kwhCrossCheck: { extracted: 4800, calculated: 0, diff: 0 } });
const peer = (s, e, k) => base({ StartRead: s, EndRead: e, kWhConsumed: k });
apply([b, peer('100.0000', '200.0000', '16000.0000'), peer('200.0000', '300.0000', '16000.0000'), peer('300.0000', '400.0000', '15000.0000')]);
check('1b multiplier from the majority of the other bills', parseFloat(b.kWhConsumed) === 48000, b.kWhConsumed);
b = base({ MeterMultiplier: null, StartRead: '1000.0000', EndRead: '1300.0000', kWhConsumed: '4800.0000', _kwhCrossCheck: { extracted: 4800, calculated: 0, diff: 0 } });
apply([b, peer('100.0000', '200.0000', '16000.0000'), peer('200.0000', '300.0000', '15000.0000')]);
check('1b two other bills disagree: no multiplier, kWh unchanged', parseFloat(b.kWhConsumed) === 4800 && !!b._kwhCrossCheck, b.kWhConsumed);

// 1c. kWh: reads x multiplier alone (the scan is not a one-digit repair of it): one source, not filled.
b = base({ StartRead: '1000.0000', EndRead: '1300.0000', kWhConsumed: '9999.0000', _kwhCrossCheck: { extracted: 9999, calculated: 48000, diff: 38001 } });
apply([b]);
check('1c one source: kWh unchanged, flag kept', parseFloat(b.kWhConsumed) === 9999 && !!b._kwhCrossCheck, b.kWhConsumed);

// 1d. kWh: the energy charge / the one printed rate agrees with the reads (scan not near): two sources.
b = base({
  StartRead: '1000.0000', EndRead: '1300.0000', kWhConsumed: '9999.0000', EnergyOnPeakCharge: '2400.00',
  _rates: { EnergyOnPeakCharge: { qty: 9999, rate: 0.05, parts: [{ qty: 9999, rate: 0.05 }] } },
  _kwhCrossCheck: { extracted: 9999, calculated: 48000, diff: 38001 },
});
apply([b]);
check('1d reads x multiplier + energy charge / rate (cent-exact): filled', parseFloat(b.kWhConsumed) === 48000, b.kWhConsumed);

// 2. kW: the scan lost a digit (42.064 for 242.064); charge 2377.07 / printed rate 9.82 is cent-exact for 242.064.
b = base({
  BilledKW: '42.0640', BilledKWCharge: '2377.07', DemandRate: 56.6,
  _rates: { BilledKWCharge: { qty: 42.064, rate: 56.5, unit: 'kW', computed: 2377.07, parts: [{ qty: 42.064, rate: 56.5, unit: 'kW', computed: 2377.07, ocrCharge: 2377.07 }] } },
  _auto_corrected_rate_BilledKWCharge: { ocrRate: 9.82, derivedRate: 56.5, charge: 2377.07, qty: 42.064, reason: 'charge_div_qty' },
});
apply([b]);
check('2 kW filled from printed charge / printed rate + digit repair', parseFloat(b.BilledKW) === 242.064 && b._rates.BilledKWCharge.rate === 9.82 && !b._auto_corrected_rate_BilledKWCharge, JSON.stringify([b.BilledKW, b._rates.BilledKWCharge.rate]));
b = base({
  BilledKW: '42.0640', BilledKWCharge: '2377.07',
  _rates: { BilledKWCharge: { qty: 42.064, rate: 56.5, parts: [{ qty: 42.064, rate: 56.5, computed: 2377.07, ocrCharge: 2377.07 }] } },
  _auto_corrected_rate_BilledKWCharge: { ocrRate: 9.5, derivedRate: 56.5, charge: 2377.07, qty: 42.064, reason: 'charge_div_qty' },
});
apply([b]);
check('2 kW: charge / rate not near any repair of the scan: unchanged', parseFloat(b.BilledKW) === 42.064, b.BilledKW);

// 3. NumberOfDays: read end date misread (07/08 for 07/09). Period 29 days and the Billing Date 29 days from the
// first read date agree; the scanned Days "2" lost a digit.
const days = (extra) =>
  base(Object.assign({
    MeterReadStart: '06/10', MeterReadEnd: '07/08', BillingPeriodStart: '06/09/2026', BillingPeriodEnd: '07/08/2026', NumberOfDays: '28',
    _numberOfDaysCheck: { days: '28', readStart: '06/10/2026', readEnd: '07/08/2026', readDays: 28, periodDays: 29, printedDays: '2', printedDaysAgree: false },
  }, extra));
b = days({ _billDate: '07/09/2026' });
apply([b]);
check('3 NumberOfDays filled: period + Billing Date + scan', b.NumberOfDays === '29', b.NumberOfDays);
check('3 NumberOfDays hover reason', b._auto_corrected_NumberOfDays && /billing period/.test(b._auto_corrected_NumberOfDays.reason) && b._auto_corrected_NumberOfDays.original === '28', JSON.stringify(b._auto_corrected_NumberOfDays));
// the read dates are right and the period is off by one: the Billing Date and the read dates agree
b = days({ _billDate: '07/09/2026', MeterReadEnd: '07/09', NumberOfDays: '29', BillingPeriodEnd: '07/07/2026', _numberOfDaysCheck: { days: '29', readStart: '06/10/2026', readEnd: '07/09/2026', readDays: 29, periodDays: 28, printedDays: '2', printedDaysAgree: false } });
apply([b]);
check('3 NumberOfDays: read dates + Billing Date agree, kept', b.NumberOfDays === '29' && !b._auto_corrected_NumberOfDays, b.NumberOfDays);
// sources tie: read dates 28 vs period 29, no Billing Date: the reader's value stays
b = days({});
apply([b]);
check('3 NumberOfDays: sources tie, unchanged', b.NumberOfDays === '28' && !b._auto_corrected_NumberOfDays, b.NumberOfDays);

// 4. One held charge cell: Subtotal 700.00 - the other lines (100 + 200 + 0) = 400.00; the scan "4O0.00" repairs to it.
const cell = (reasonText, subtotal) =>
  base({
    CustomerCharge: '100.00', FacilitiesCharge: '200.00', BilledKWCharge: null, TotalCurrentCharges: subtotal, _subtotal: subtotal,
    _positionHeld: ['BilledKWCharge: ' + reasonText], _gateReasons: ['BilledKWCharge: ' + reasonText], _gateTripped: true, _manualReview: true, _manualReviewLabel: 'BilledKWCharge: ' + reasonText,
  });
b = cell('Demand charge could not be read. box read "4O0.00" on the page', '700.00');
apply([b]);
check('4 charge cell filled: Subtotal minus lines + digit repair', b.BilledKWCharge === '400.00', b.BilledKWCharge);
check('4 hold dropped', !b._positionHeld && !b._gateReasons && !b._manualReview && !b._gateTripped, JSON.stringify([b._positionHeld, b._gateReasons, b._manualReview]));
check('4 hover reason', b._auto_corrected_BilledKWCharge && /Subtotal minus the other lines is 400\.00/.test(b._auto_corrected_BilledKWCharge.reason), JSON.stringify(b._auto_corrected_BilledKWCharge));
b = cell('Demand charge could not be read. box read "5O0.00" on the page', '700.00');
apply([b]);
check('4 sources disagree (scan repairs to 500, totals give 400): held', b.BilledKWCharge === null && b._manualReview === true && b._positionHeld.length === 1, JSON.stringify(b.BilledKWCharge));
b = cell('Demand charge could not be read. no scan of the cell', '700.00');
apply([b]);
check('4 one source (no scan to repair): held', b.BilledKWCharge === null && b._manualReview === true, JSON.stringify(b.BilledKWCharge));
// two cells empty: no single cell can be derived
b = cell('Demand charge could not be read. box read "4O0.00" on the page', '700.00');
b.ECACharge = null;
b._positionHeld.push('ECACharge: ECA charge could not be read. box read "1O.00" on the page');
b._gateReasons.push('ECACharge: ECA charge could not be read. box read "1O.00" on the page');
apply([b]);
check('4 two held cells: held', b.BilledKWCharge === null && b._manualReview === true, JSON.stringify(b.BilledKWCharge));

// 5. The shared function: gas and electric both call it; no second copy of the rule.
check('5 gas-only autofix function removed', !/_lbg_autofixGasUsage/.test(src) && !/_lbg_usageDigitRepairs/.test(src) && !/_lbg_storedGasFactor/.test(src), '');
check('5 one rule function, five call sites', (src.match(/_lbg_autofix\(\{/g) || []).length === 5, String((src.match(/_lbg_autofix\(\{/g) || []).length));
check('5 shared function ties = hold', autofix({ sources: [{ label: 'a', values: [1] }, { label: 'b', values: [2] }] }) === null, '');
check('5 shared function two agree = fill', (autofix({ sources: [{ label: 'a', values: [2] }, { label: 'b', test: (v) => v === 2 }] }) || {}).value === 2, '');

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
