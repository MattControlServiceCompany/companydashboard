/**
 * test-layout-facts.js
 *
 * The field format facts (computations/bill-layout.js fieldFormats) and the page identities used as autofix
 * sources (app/energy-savings.js): the format filter of the one fill-or-hold rule, the KGS Mcf and balance chain,
 * the second city lost charge, the gas supplier site lines. A value fills only when 2 or more sources agree; otherwise
 * the hold names the missing second source.
 *
 * SYNTHETIC data only (accounts 'SAMPLE-ACCT-*'). Loads the real functions via vm.
 *
 * Usage: node tools/test-layout-facts.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const BL = require(path.join(root, 'computations', 'bill-layout.js'));
const sandbox = { window: {}, calcDays: () => 30, BILL_LAYOUT: BL, convertUnit: (v) => v * 10 /* 1 Dth = 10 Therms (app/utility-data.js, a page module) */, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js'])
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', lib), 'utf8'), sandbox, { filename: lib });
{
  const udSrc = fs.readFileSync(path.join(root, 'app', 'utility-data.js'), 'utf8');
  const fn = (name) => {
    const m = udSrc.match(new RegExp('\\r?\\nfunction ' + name + '\\([\\s\\S]*?\\r?\\n}\\r?\\n'));
    return m ? m[0].replace(/\r\n/g, '\n') : '';
  };
  vm.runInContext(fn('_fixISO') + fn('_parseISO') + fn('calcDays'), sandbox);
}
for (const f of ['computations/normalization.js', 'computations/rates.js', 'app/energy-savings.js'])
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
const run = (name) => vm.runInContext(name, sandbox);
const digitRepairs = run('_lbg_digitRepairs');
const autofix = run('_lbg_autofix');
const kgsApply = run('_kgsApplyIdentities');
const baldwinFix = run('_baldwinAutofixCharge');
const wreFix = run('_wreAutofixLines');

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const J = (x) => JSON.stringify(x);

// F1: the format filter of the scan's one-digit repairs
const money = BL.fieldFormat('city-new', 'WaterCharge');
check('F1 flag: City money is 2 decimals, never negative', money && money.decimals === 2 && money.credit === 'never', J(money));
check('F1 flag: fuel adjustment may print negative', BL.fieldFormat('city-new', 'FuelAdjustment').credit === 'lead', '');
check('F1 flag: electric Bill offset leads with a minus, Tax Exempt never', BL.fieldFormat('utility-e-bd', 'BillOffset').credit === 'lead' && BL.fieldFormat('utility-e-bd', 'TaxExemptDelivery').credit === 'never', '');
check('F1 flag: electric quantity has 4 decimals', BL.fieldFormat('utility-e-bd', 'kWhConsumed').decimals === 4, '');
check('F1 flag: KGS dial reads print 1 to 4 digits (no leading zero: "590" for 0590)', J(BL.fieldFormat('kgs', 'MeterReadCurrent').digits) === '[1,4]', '');
check('F1 no flag, no filter: "2.5" offers 52.5', digitRepairs('2.5').includes(52.5), '');
const r25 = digitRepairs('2.5', money);
check('F1 money format: "2.5" does not offer 52.5; offers 2.51', !r25.includes(52.5) && r25.includes(2.51), J(r25));
check('F1 read digits [1,4]: "590" offers 5900 and 1590, no 5-digit read', (() => { const r = digitRepairs('590', { decimals: 0, digits: [1, 4] }); return r.includes(5900) && r.includes(1590) && r.every((n) => String(n).length <= 4); })(), '');
const neg = autofix({ field: 'x', sources: [{ label: 'a', values: [-5] }, { label: 'b', values: [-5] }], format: { credit: 'never' } });
check('F1 a never-negative field takes no negative value', neg.value === null, J(neg));
const posCredit = autofix({ field: 'x', sources: [{ label: 'a', values: [-5] }, { label: 'b', values: [-5] }], format: { credit: 'lead' } });
check('F1 a credit field takes a negative value', posCredit.value === -5, J(posCredit));

// K: KGS layout
const kgs = (o) => Object.assign({ UtilityCompany: 'Kansas Gas Service', AccountNumber: 'SAMPLE-ACCT-K1', MeterReadPrevious: '8698', MeterReadCurrent: '8894', MeterMultiplier: '1.0', McfBilled: '19.600', NaturalGasTherms: '196', WNAPerMcf: null, CostOfGasPerMcf: '7.0117', GasCharge: '137.43', WeatherNormalization: null, PreviousBalance: '100.00', PaymentsReceived: '100.00', TotalCurrentCharges: '240.30', TotalAmountDue: '240.30' }, o);
let b = kgs({});
kgsApply([b]);
check('K0 a bill that fits every identity is not changed', b.McfBilled === '19.600' && !b._auto_corrected_McfBilled && !b._auto_corrected_TotalAmountDue && !b._manualReview, J(b));
b = kgs({ McfBilled: '196.000' });
kgsApply([b]);
check('K1 Mcf 196.000 -> 19.600 (reads + Cost of Gas = Mcf x rate); therms follow', b.McfBilled === '19.600' && b.NaturalGasTherms === '196' && /meter reads 8894 - 8698/.test(b._auto_corrected_McfBilled.reason) && /Cost of Gas/.test(b._auto_corrected_McfBilled.reason), J(b));
b = kgs({ MeterReadPrevious: '9979', MeterReadCurrent: '590', McfBilled: '61.100', CostOfGasPerMcf: null, GasCharge: null });
kgsApply([b]);
check('K3 dial rolled over, no second source: Mcf held, never derived', b.McfBilled === '61.100' && b._manualReview === true && /dial rolled over/.test(b._gateReasons[0]) && /second source missing/.test(b._gateReasons[0]), J(b._gateReasons));
b = kgs({ MeterReadPrevious: '9979', MeterReadCurrent: '590', McfBilled: '61.100', CostOfGasPerMcf: '7.0117', GasCharge: '428.41' });
kgsApply([b]);
check('K3b dial rolled over but Cost of Gas = Mcf x rate fits: kept, not held', b.McfBilled === '61.100' && !b._manualReview, J(b));
b = kgs({ TotalAmountDue: '249.30' });
kgsApply([b]);
check('K2 Total Amount Due 249.30 -> 240.30 (balance chain + one-digit repair)', b.TotalAmountDue === '240.30' && /Previous Balance 100\.00 - Payments 100\.00/.test(b._auto_corrected_TotalAmountDue.reason), J(b));
b = kgs({ TotalAmountDue: '999.99' });
kgsApply([b]);
check('K2b Total Amount Due 999.99: balance chain alone, held and named', b.TotalAmountDue === '999.99' && b._manualReview === true && /second source missing/.test(b._gateReasons[0]), J(b._gateReasons));

// B: Baldwin lost charge
const pageB = { waFranchiseFee: 2.67, swFranchiseFee: 2.14, waDebtPmt: 14.94, totalAmountDue: '274.87', othersSum: 245.32 };
let fx = baldwinFix({ commodity: 'Water' }, pageB);
check('B1 Water charge 29.55 = Amount Due Now minus the other lines + 6% franchise fee', fx.value === 29.55 && fx.labels.length === 2, J(fx));
fx = baldwinFix({ commodity: 'Water' }, Object.assign({}, pageB, { waFranchiseFee: null }));
check('B1b no franchise fee line: held, names the missing second source', fx.value === null && /second source missing for Water charge 29\.55/.test(fx.reason), J(fx));
fx = baldwinFix({ commodity: 'Water' }, Object.assign({}, pageB, { waFranchiseFee: 3.5 }));
check('B1c franchise fee that is not 6% of the line: held', fx.value === null, J(fx));

// W: gas supplier site lines
const wre = (o) => Object.assign({ GasCharge: '33.22', _wreTriggerMMbtu: '6.24', _wreTriggerFuelMMbtu: '0.07', _wreTriggerRate: '5.265', _wreTriggerCharge: null, _wreIndexMMbtu: null, _wreIndexCharge: null, _wreSWECharge: null, _wreSWEMMbtu: null }, o);
let w = wre({});
wreFix(w);
check('W1 missing Trigger line = (6.24 + 0.07) x 5.265 = 33.22 (qty x rate + Sub-Total)', w._wreTriggerCharge === '33.22' && w._wreIndexCharge === null, J(w));
w = wre({ _wreTriggerCharge: '33.21' });
wreFix(w);
check('W2 Trigger line read 33.21 -> 33.22 (qty x rate + Sub-Total agree)', w._wreTriggerCharge === '33.22', J(w));
w = wre({ GasCharge: '33.27', _wreTriggerCharge: '33.27' });
wreFix(w);
check('W2b printed line agrees with the Sub-Total, qty x rate off a nickel: printed kept', w._wreTriggerCharge === '33.27' && !w._auto_corrected__wreTriggerCharge, J(w));
w = wre({ GasCharge: null });
wreFix(w);
check('W2c no Sub-Total: qty x rate alone, line stays empty', w._wreTriggerCharge === null, J(w));

// G: the facts the 2026-10-21 real-page check proved or disproved (synthetic checks of the data itself)
const kf = (f) => BL.fieldFormat('kgs', f);
check('G1 KGS credit prints with a CR suffix, never a minus', kf('GasSystemReliability').credit === 'CR' && kf('WeatherNormalization').credit === 'CR', J(kf('GasSystemReliability')));
check('G1b KGS payment prints "CR" after the figure and is stored positive', kf('PaymentsReceived').suffix === 'CR' && kf('PaymentsReceived').credit === 'never', J(kf('PaymentsReceived')));
check('G2 KGS: "$" on the first charge line only; Total Amount Due, Previous Balance, Total Current Charges have it', kf('CustomerCharge').glyph === 'first' && kf('DeliveryCharge').glyph === 'none' && kf('TotalAmountDue').glyph === '$' && kf('PreviousBalance').glyph === '$' && kf('TotalCurrentCharges').glyph === '$', '');
check('G3 KGS Mcf 3 decimals; WNA and Cost of Gas per Mcf 4 decimals', kf('McfBilled').decimals === 3 && kf('WNAPerMcf').decimals === 4 && kf('CostOfGasPerMcf').decimals === 4, '');
const bf = (f) => BL.fieldFormat('baldwin', f);
check('G4 City 2 amounts print with no "$"', ['WaterCharge', 'SewerCharge', 'WaterDebtPayment', 'WaterFranchiseFee', 'SewerFranchiseFee', 'TotalAmountDue'].every((f) => bf(f).glyph === 'none'), '');
check('G4b City 2 fuel adjustment credit prints with a trailing minus', bf('FuelAdjustment').credit === 'trail', J(bf('FuelAdjustment')));
const wf = (f) => BL.fieldFormat('wre', f);
check('G5 supplier rates print 4 decimals with "$"; amounts print "$" and 2 decimals; quantities no "$"', wf('_wreTriggerRate').decimals === 4 && wf('_wreIndexRate').decimals === 4 && wf('_wreTriggerRate').glyph === '$' && wf('_wreTriggerCharge').glyph === '$' && wf('_wreTriggerCharge').decimals === 2 && wf('_wreTriggerMMbtu').glyph === 'none', '');
check('G5b supplier special weather credit sign is not asserted (never seen on a real page)', wf('_wreSWECharge').credit === undefined, J(wf('_wreSWECharge')));
const trail = autofix({ field: 'x', sources: [{ label: 'a', values: [-2.04] }, { label: 'b', values: [-2.04] }], format: bf('FuelAdjustment') });
check('G6 a trailing-minus credit field takes a negative value', trail.value === -2.04, J(trail));

// T: KGS Total Amount Due. "Total Amount Due" prints in the charges block; the top block and the stub print "Amount Due";
// "Current Charges Due" is a date; "Amount Due After Due Date" is larger.
const NL = String.fromCharCode(10);
// The readers by their place in UTILITY_RULES: 2 gas supplier, 3 gas utility, 5 second city (a moved rule fails W3, T1 and B2 below).
const rules = run('UTILITY_RULES');
const kgsPage = (extra, topFirst) =>
  ['%%PAGE_1%%']
    .concat(topFirst || [])
    .concat([
      'SAMPLE ORG    Account Number    100200300 900123 45',
      'Active Deposit    NONE Statement Date    02-20-26',
      'Previous Balance    $100.00',
      'Payments Received    100.00CR',
      'Service Charge    $32.20',
      'Delivery Charge    10.00',
      'Gas System Reliability Surcharge    0.48CR',
      'Franchise Fee    1.00',
      'Current Charges    42.72',
      'Winter Event Securitized Cost    9.00',
      'Franchise Fee    0.27',
      'Total Current Charges    $51.99',
    ])
    .concat(extra)
    .concat(['Service Period    Number    Meter Readings', '0321A00000    01-19-26    02-17-26    29    1100    1200    1.0000    10.000    $0.2034    7.0117', '%%PAGE_2%%', '', '%%PAGE_3%%', ''])
    .join(NL);
const kgsRead = (text) => rules[3].extractAll(text)[0] || {};
b = kgsRead(kgsPage(['Total Amount Due    $51.99', 'Amount Due    $51.99', 'Amount Due After Due Date    $53.35']));
check('T1 Total Amount Due is the charges-block figure', b.TotalAmountDue === '51.99', J(b.TotalAmountDue));
b = kgsRead(kgsPage(['Total Amount Due    $51.99'], ['Amount Due After Due Date    $53.35', 'Current Charges Due    03-10-26', 'Amount Due    $51.99']));
check('T2 a top block with "Amount Due After Due Date" first does not change it', b.TotalAmountDue === '51.99', J(b.TotalAmountDue));
b = kgsRead(kgsPage(['Amount Due    $51.99', 'Amount Due After Due Date    $53.35']));
check('T3 "Total Amount Due" line lost: the bare "Amount Due" is taken, never the After Due Date figure', b.TotalAmountDue === '51.99', J(b.TotalAmountDue));
b = kgsRead(kgsPage(['Amount Due After Due Date    $53.35', 'Current Charges Due    03-10-26']));
check('T4 only the After Due Date figure and the due date printed: no Total Amount Due, never a date or the larger figure', b.TotalAmountDue === null, J(b.TotalAmountDue));
b = kgsRead(kgsPage(['Total Amount Due    03-10-26']));
check('T5 a date after the label is never a figure', b.TotalAmountDue === null, J(b.TotalAmountDue));
b = kgsRead(kgsPage(['Total Amount Due    $51.99']));
check('T6 a CR credit line is stored negative, a CR payment positive', b.GasSystemReliability === '-0.48' && b.PaymentsReceived === '100.00', J([b.GasSystemReliability, b.PaymentsReceived]));

// FR: KGS Franchise Fee line (the 2nd franchise line read 0.34 for 0.31)
const frBill = (o) => kgs(Object.assign({ CustomerCharge: '32.20', DeliveryCharge: '4.54', GasSystemReliability: null, WeatherNormalization: '0.31', GasCharge: '9.96', WinterEventCost: '10.43', FranchiseFeeItems: ['1.42', '0.34'], TotalCurrentCharges: '59.17', PreviousBalance: '101.21', PaymentsReceived: '101.21', TotalAmountDue: '59.17' }, o));
b = frBill({});
kgsApply([b]);
check('FR1 Franchise Fee line 0.34 -> 0.31 (Total Current Charges minus the other lines + one-digit repair)', b.FranchiseFeeItems[1] === '0.31' && b.FranchiseFee === '1.73' && /Total Current Charges 59\.17/.test(b._auto_corrected_FranchiseFee.reason), J(b));
b = frBill({ FranchiseFeeItems: ['1.42', '0.31'] });
kgsApply([b]);
check('FR2 a sum that fits: nothing changes', !b._auto_corrected_FranchiseFee && b.FranchiseFeeItems[1] === '0.31', J(b));
b = frBill({ TotalCurrentCharges: '59.77', TotalAmountDue: '59.77' });
kgsApply([b]);
check('FR3 the sum breaks and no repair of the scan fits: nothing changes here', !b._auto_corrected_FranchiseFee && b.FranchiseFeeItems[1] === '0.34', J(b));

// B: second city: Meter Debt lines, franchise 6%
const bdPage = (lines) => ['%%PAGE_1%%', 'ACCOUNT NUMBER', 'AMOUNT DUE NOW    AFTER DUE DATE'].concat(lines, ['ACCOUNT #: 123456789', 'AMOUNT DUE NOW    1.00']).join(NL);
const bdLines = [
  'SW - SEWER    1000    1500    500    20.00',
  'SW - FRANCHISE FEE    1.20',
  'WA - WATER    2000    2500    500    30.00',
  'WA - METER DEBT PMT    5.00',
  'WA - WATER    3000    3300    300    10.00',
  'WA - METER DEBT PMT    5.00',
  'WA - FRANCHISE FEE    3.00',
];
const bdRead = (lines) => {
  const by = {};
  for (const x of rules[5].extractAll(bdPage(lines))) by[x.Commodity] = x;
  return by;
};
let bw = bdRead(bdLines);
check('B2 two water meters print two Meter Debt lines: the debt is their sum', bw.Water.WaterDebtPayment === 10 && bw.Water.WaterCharge === 40 && bw.Water.TotalCurrentCharges === 53, J(bw.Water));
bw = bdRead(bdLines.filter((l, i) => i !== 5));
check('B2b one Meter Debt line lost: debt total and bill total held with a reason, no guess', bw.Water.WaterDebtPayment === null && bw.Water.TotalCurrentCharges === null && bw.Water._manualReview === true && /Meter Debt/.test(bw.Water._gateReasons[0]) && /second source missing/.test(bw.Water._gateReasons[0]), J(bw.Water));
bw = bdRead(bdLines.map((l) => (l === 'WA - FRANCHISE FEE    3.00' ? 'WA - FRANCHISE FEE    3.01' : l)));
check('B3 franchise fee 3.01 -> 3.00 (6% of 50.00 + one-digit repair)', bw.Water.WaterFranchiseFee === 3 && /6% of the Water lines 50\.00/.test(bw.Water._auto_corrected_WaterFranchiseFee.reason), J(bw.Water));
bw = bdRead(bdLines.map((l) => (l === 'WA - FRANCHISE FEE    3.00' ? 'WA - FRANCHISE FEE    3.57' : l)));
check('B3b franchise fee that no one-digit repair makes 6%: unchanged', bw.Water.WaterFranchiseFee === 3.57 && !bw.Water._auto_corrected_WaterFranchiseFee, J(bw.Water));
bw = bdRead(bdLines.filter((l) => !/DEBT/.test(l)).map((l) => (l === 'WA - FRANCHISE FEE    3.00' ? 'WA - FRANCHISE FEE    2.70' : l)));
check('B3c no debt line printed at all: the Water franchise fee is not repaired (the base is unknown)', bw.Water.WaterFranchiseFee === 2.7 && !bw.Water._auto_corrected_WaterFranchiseFee, J(bw.Water));
bw = bdRead(bdLines.map((l) => (l === 'WA - METER DEBT PMT    5.00' ? 'WA - DEBT PMT    5.00' : l)));
check('B4 "DEBT PMT" without "METER" is the same line', bw.Water.WaterDebtPayment === 10, J(bw.Water));
fx = baldwinFix({ commodity: 'Water' }, Object.assign({}, pageB, { waFranchiseFee: 2.68 }));
check('B5 the 6% source is exact to the cent: a fee one cent off the 6% figure is not a source', fx.value === null, J(fx));
const trailRead = rules[5].extractAll(bdPage(['EL - ELECTRIC    100    200    100    10.00', 'FA - FUEL ADJUSTMENT    .57-']));
check('B6 a trailing-minus fuel adjustment (no leading zero) is negative', (trailRead.find((x) => x.Commodity === 'Electric') || {}).FuelAdjustment === -0.57, J(trailRead[0]));

// W: supplier site lines
const wreHead = ['%%PAGE_1%%', 'Natural Gas Invoice', 'Customer #:    10001', 'SAMPLE SCHOOL DISTRICT    Invoice #:    900001', 'Production Month:    March 2025', 'Bill Date:    04/09/2025', 'Item    Mmbtu    Fuel    Rate    $'];
const wreSite = (idx, sub) => ['Service Address:    Site A - 1 Main St    Acct/Meter:    900123/M0000001A', 'Utility:    SAMPLE', 'Trigger - Fixed    6.00    0.10    $5.0000    $30.50', idx, sub];
const wreRead = (lines) => rules[2].extractAll(wreHead.concat(lines, ['Total Natural Gas:    9.00    0.20    $80.00']).join(NL))[0] || {};
let wr = wreRead(wreSite('Index (FOM)    3.00    0.05    $5.5000    $16.78', 'Sub-Total:    9.00    0.15    $47.28'));
check('W3 a site with both rows read: Sub-Total, rows and 4-decimal rates', wr.GasCharge === 47.28 && wr._wreTriggerRate === '5.0000' && wr._wreIndexRate === '5.5000' && wr._wreIndexCharge === '16.78', J(wr));
wr = wreRead(wreSite('Index gg (FOM)    85.5000    816.78', 'Sub-Total:    9.00    0.15    $47.28'));
check('W4 Index row garbled, Sub-Total read: the Sub-Total is kept; the Index line stays empty (one source)', wr.GasCharge === 47.28 && wr._wreIndexCharge == null && !wr._manualReview, J(wr));
wr = wreRead(wreSite('Index gg (FOM)    85.5000    816.78', 'jub-Total:    9.00    0.15    47.284'));
check('W5 Index row garbled and Sub-Total amount unread: the site charge is held (never the Trigger row alone), with a reason', wr.GasCharge == null && wr._wreChargeRowLost === true && wr._manualReview === true && /second source missing/.test(wr._manualReviewLabel), J(wr));
wr = wreRead(['Service Address:    Site A - 1 Main St    Acct/Meter:    900123/M0000001A', 'Trigger - Fixed    6.00    0.10    $5.0000    $30.50', 'Sub-Total:    6.00    0.10    $30.50']);
check('W6 a site with a Trigger row only (no Index row printed): the charge is the printed Sub-Total', wr.GasCharge === 30.5 && !wr._wreChargeRowLost, J(wr));


// A: account number fills only when 2 sources agree (printed reads; saved account numbers only confirm)
const acctPage = (top, stub) => ['%%PAGE_1%%', top ? 'ACCOUNT NUMBER    ' + top : 'ACCOUNT NUMBER', 'AMOUNT DUE NOW    AFTER DUE DATE', 'EL - ELECTRIC    100    200    100    10.00', 'ACCOUNT #: ' + stub, 'ADDRESS: 100 SAMPLE ST', 'AMOUNT DUE NOW    10.00'].join(NL);
const acctOf = (top, stub, saved) => {
  run('var utilityData = ' + JSON.stringify(saved ? { c: { buildings: [{ meters: [{ bills: saved.map((a) => ({ accountNumber: a, utilityCompany: 'City of Baldwin City', commodity: 'Electric' })) }] }] } } : {}) + ';');
  return (rules[5].extractAll(acctPage(top, stub)).find((x) => x.Commodity === 'Electric')) || {};
};
let ab = acctOf(null, '123456789', null);
check('A1 one printed read, no saved account numbers: held, names the missing source', ab.AccountNumber == null && /second source missing/.test(ab._accountHeld || ''), J(ab._accountHeld));
ab = acctOf(null, '123456789', ['100200300', '999000']);
check('A2 one printed read that is not a saved account number: held (history never fills, one read never fills)', ab.AccountNumber == null && !!ab._accountHeld, J(ab._accountHeld));
ab = acctOf('123456789', '123456789', null);
check('A3 the top box and the stub print the same number: filled', ab.AccountNumber === '123456789' && !ab._accountHeld, J(ab.AccountNumber));
ab = acctOf(null, '123456789', ['123456789']);
check('A4 one printed read that is a saved account number: filled', ab.AccountNumber === '123456789', J(ab.AccountNumber));
ab = acctOf('100200300', '123456789', null);
check('A5 two printed reads that disagree, no saved match: held', ab.AccountNumber == null && /disagree/.test(ab._accountHeld || ''), J(ab._accountHeld));
ab = acctOf('100200300', '123456789', ['100200300']);
check('A6 two printed reads disagree and one is saved: the saved one fills', ab.AccountNumber === '100200300', J(ab.AccountNumber));
run('var utilityData = {};');


console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
