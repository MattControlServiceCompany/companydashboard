/**
 * test-lbg-fuel-adj-sign.js
 *
 * Regression test for the city utility parser (the Client A rule): the ONE sign rule for the gas
 * Fuel Adjustment (_lbg_fuelAdjSign) and the number shapes that broke the page sum on the bill
 * where the credit read positive (backlog 166ee5bf). SYNTHETIC text only (fake school, fake street,
 * fake account ids, amounts in pounds). Loads the REAL rule from app/energy-savings.js through vm.
 *
 *   A  a cent sign where the minus is printed ("FUEL ADR ¢ 30.00") is a minus, lines unread
 *   B  an unsigned Fuel Adjustment is a credit
 *   C  an unsigned Fuel Adjustment stays positive ONLY when the page sum fits only the positive
 *   D  no Fuel Adjustment label printed: no value derived, the hold names the page-sum gap
 *   E  number shapes: Water ",254.80" after a stray "12", Stormwater "4,00", Gas "23.337"
 *   F  the legacy forced-credit copies call the same rule
 *
 * Usage: node tools/test-lbg-fuel-adj-sign.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');
const sandbox = { window: {}, calcDays: () => 30, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
for (const lib of ['date-helpers.js', 'formatting.js', 'unit-conversion.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', lib), 'utf8'), sandbox, { filename: lib });
}
vm.runInContext(fs.readFileSync(jsPath, 'utf8'), sandbox, { filename: path.basename(jsPath) });
const rule = vm.runInContext("UTILITY_RULES.find((r) => typeof r._extractNew === 'function')", sandbox);
const faSign = vm.runInContext('_lbg_fuelAdjSign', sandbox);

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const j = (v) => JSON.stringify(v);

// Synthetic page. Gas 1000 therms: 1000 x 0.798062 + 23.33 = 821.39 (the printed GAS line).
// Defaults: water 100.00, fee 1.00, sewer 80.00, storm 4.00 -> 185.00 beside the gas line.
const ACCT = '01-900123-00';
const GAS_LINE = 821.39;
const OTHERS = 185;
const cents = (n) => (Math.round(n * 100) / 100).toFixed(2);
function page(n, o) {
  o = o || {};
  const cb = o.cb === undefined ? 'Current Bill ' + cents(o.cbValue) : o.cb;
  return [
    '%%PAGE_' + n + '%%',
    'Customer Account Information - Retain for your records',
    'SD 999 TEST SCHOOL        1 TEST ST        ' + (o.acct || ACCT),
    '5/15/2026   6/15/2026   31   6/23/2026   7/13/2026   7/10/2026',
    'Previous Balance: 0.00',
    o.water === undefined ? '4,000 4,500 500 WATER 100.00' : o.water,
    o.gas === undefined ? '2,000 3,000 1,000.00 GAS 821.39' : o.gas,
    o.fa === undefined ? 'FUEL ADJUSTMENT -30.00' : o.fa,
    o.wpf === undefined ? 'WATER PROTECTION 1.00' : o.wpf,
    o.sewer === undefined ? 'SEWER 80.00' : o.sewer,
    o.storm === undefined ? 'STORMWATER 4.00' : o.storm,
    cb,
    'Total Amount Due ' + cents(o.cbValue || 0),
  ].join('\n');
}
const byCommodity = (bills, c) => (bills || []).find((b) => b.Commodity === c);
const held = (bills) => (bills || []).some((b) => b._manualReview);

// A. The minus is read as a cent sign; Water and Stormwater are unread on the page.
let bills = rule.extractAll(
  page(1, {
    fa: 'J FUEL ADR ¢ 30.00',
    water: '4,000 4,500 500 WATE! Sz _ 12 ,',
    storm: 'STORMWATER :',
    cbValue: GAS_LINE - 30 + OTHERS,
  }),
);
let gas = byCommodity(bills, 'Gas');
check('A cent sign is a minus: Fuel Adjustment -30', gas && gas.FuelAdjustment === -30, j(gas && gas.FuelAdjustment));
check('A gas charge is the variable part 798.06', gas && gas.GasCharge === 798.06, j(gas && gas.GasCharge));
check(
  'A gas total is the printed line less the credit (791.39)',
  gas && gas.TotalCurrentCharges === '791.39',
  j(gas && gas.TotalCurrentCharges),
);
check('A unread Water and Stormwater lines hold the page', held(bills), '');
check('A total current charges and amount due agree', gas && gas.TotalCurrentCharges === gas.TotalAmountDue, '');

// B. An unsigned Fuel Adjustment on a page that adds up only with the credit.
bills = rule.extractAll(page(1, { fa: 'FUEL ADJUSTMENT 40.00', cbValue: GAS_LINE - 40 + OTHERS }));
gas = byCommodity(bills, 'Gas');
check(
  'B unsigned and the page fits the credit: -40',
  gas && gas.FuelAdjustment === -40 && !held(bills),
  j(gas && [gas.FuelAdjustment, held(bills)]),
);
// B2. Unsigned, nothing on the page can prove a positive (no Current Bill, no balance lines).
bills = rule.extractAll(
  page(1, { fa: 'FUEL ADJUSTMENT 40.00', cb: 'Current Bill', cbValue: 0 }).replace('Previous Balance: 0.00', 'x'),
);
gas = byCommodity(bills, 'Gas');
check('B2 unsigned, no proof of a positive: credit', gas && gas.FuelAdjustment === -40, j(gas && gas.FuelAdjustment));

// C. The page adds up only with the positive: it stays positive and is not held.
bills = rule.extractAll(page(1, { fa: 'FUEL ADJUSTMENT 30.00', cbValue: GAS_LINE + 30 + OTHERS }));
gas = byCommodity(bills, 'Gas');
check(
  'C proven positive stays +30, not held',
  gas && gas.FuelAdjustment === 30 && !held(bills),
  j(gas && [gas.FuelAdjustment, held(bills)]),
);
check('C proven positive carries no sign-correction marker', gas && !gas._auto_corrected_FuelAdjustment, '');
// C2. A printed minus is never turned positive, even when the page would add up with the positive.
bills = rule.extractAll(page(1, { fa: 'FUEL ADJUSTMENT -30.00', cbValue: GAS_LINE + 30 + OTHERS }));
gas = byCommodity(bills, 'Gas');
check('C2 printed minus stays negative', gas && gas.FuelAdjustment === -30, j(gas && gas.FuelAdjustment));

// D. No Fuel Adjustment label on the page. Water is read as 1 (a stray digit), so the lines are
// 40.10 short of the printed Current Bill. Nothing is derived; the hold names the page-sum gap.
const noLabel = page(1, {
  water: '150,986 152,518 1,532 /WATER SUR ) 1 1',
  gas: '10,649 10,649 0 GAS oo 23.33',
  fa: 'NOTE: PLEASE PAY BY THE DUE DATE',
  wpf: 'WATER PROTECTION 0.05',
  sewer: 'SEWER 32.19',
  storm: 'STORMWATER 4.00',
  cbValue: 100.67,
});
bills = rule.extractAll(noLabel);
gas = byCommodity(bills, 'Gas');
check(
  'D no label: Fuel Adjustment stays null',
  gas && gas.FuelAdjustment === null && !gas._auto_derived_FuelAdjustment,
  j(gas && [gas.FuelAdjustment, gas._auto_derived_FuelAdjustment]),
);
check('D no label: held', held(bills), '');
const dReason = (gas && (gas._gateReasons || []).join(' | ')) || '';
check(
  'D hold reason names the lines not adding up to the Current Bill',
  /do not add up|add up to/.test(dReason) && /100\.67/.test(dReason),
  dReason,
);
check(
  'D hold reason is not "Fuel Adjustment unreadable"',
  !/Fuel Adjustment unreadable/i.test(dReason + ' ' + (gas && gas._manualReviewLabel)),
  dReason,
);

// E. Number shapes.
// E1. Water ",254.80" after a stray "12": printed 1,254.80, proven by the page sum (Stormwater read).
bills = rule.extractAll(page(1, { water: '4,000 4,500 500 WATER _ 12 ,254.80', cbValue: GAS_LINE - 30 + 1254.8 + 85 }));
let water = byCommodity(bills, 'Water');
check(
  'E1 Water _ 12 ,254.80 reads 1254.80 when the page sum proves it',
  water && water.WaterCharge === 1254.8 && !held(bills),
  j(water && [water.WaterCharge, held(bills)]),
);
check('E1 repair is marked', water && !!water._auto_corrected_WaterCharge, '');
// E1b. When the page sum does not prove either value, Water stays unread and the page is held.
bills = rule.extractAll(page(1, { water: '4,000 4,500 500 WATER _ 12 ,254.80', cbValue: GAS_LINE - 30 + 1300 + 85 }));
water = byCommodity(bills, 'Water');
check(
  'E1b no value proven: Water stays unread, held',
  (!water || water.WaterCharge == null) && held(bills),
  j(water && water.WaterCharge),
);
// E2. Stormwater "4,00" (comma for the point) on a line that shares its row with a chart header.
bills = rule.extractAll(
  page(1, { storm: '300 - Gas   lL 1 24 \\  STORMWATER      4,00', cbValue: GAS_LINE - 30 + OTHERS }),
);
const storm = byCommodity(bills, 'Stormwater');
check(
  'E2 Stormwater 4,00 reads 4.00, page not held',
  storm && storm.StormWaterCharge === 4 && !held(bills),
  j(storm && [storm.StormWaterCharge, held(bills)]),
);
// E3. Gas "23.337" (one stray digit after the cents) with 0 therms: the base charge 23.33.
bills = rule.extractAll(
  page(1, { gas: '10,649 10,649 0 GAS oo 23.337', fa: 'NOTE: PLEASE PAY BY THE DUE DATE', cbValue: 23.33 + OTHERS }),
);
gas = byCommodity(bills, 'Gas');
check(
  'E3 Gas 23.337 reads the 23.33 printed line',
  gas && gas.PrintedGasLine === 23.33 && gas.GasCharge === 0,
  j(gas && [gas.PrintedGasLine, gas.GasCharge]),
);
check('E3 page not held', !held(bills), '');

// F. The one rule, called directly. The legacy forced-credit copies call it with no page context.
check('F positive, no context: credit', faSign(30) === -30, j(faSign(30)));
check('F negative: unchanged', faSign(-30) === -30, '');
check('F null: unchanged', faSign(null) === null, '');
check('F zero: unchanged', faSign(0) === 0, '');
const ctxPos = { currentBill: 100, gas: 40, water: 30, wpf: 0, sewer: 0, storm: 0 };
check('F page fits only the positive: kept', faSign(30, ctxPos) === 30, j(faSign(30, ctxPos)));
const ctxNeg = { currentBill: 40, gas: 40, water: 30, wpf: 0, sewer: 0, storm: 0 };
check('F page fits only the negative: credit', faSign(30, ctxNeg) === -30, j(faSign(30, ctxNeg)));
const src = fs.readFileSync(jsPath, 'utf8');
check(
  'F no forced credit (positive then -abs) left in the gas readers',
  !/(?:signedFuelAdj|fuelAdj)\s*(?:!= null\s*&&\s*\w+\s*)?>\s*0\)\s*\{?\s*\w+\s*=\s*-Math\.abs\(/.test(src),
  '',
);

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
