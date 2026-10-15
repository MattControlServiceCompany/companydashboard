/**
 * test-lbg-printed-gas-line.js
 *
 * Client A gas: the PRINTED GAS line always wins over usage x rate.
 * GasCharge = printed GAS line - customer charge (23.33). Usage x rate is only
 * a check. A failed check is reconciled against the printed Current Bill; if
 * that cannot prove a printed value, the bill is held. The computed value is
 * never stored.
 *
 * SYNTHETIC numbers only (no client bill values). Loads the real
 * _lbg_buildGasBill from app/energy-savings.js via vm.
 *
 * Usage: node tools/test-lbg-printed-gas-line.js [path-to-energy-savings.js]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');
const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'formatting.js'), 'utf8'), sandbox);
const src = fs.readFileSync(jsPath, 'utf8');
vm.runInContext(src, sandbox, { filename: 'energy-savings.js' });
const build = vm.runInContext('_lbg_buildGasBill', sandbox);

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
}
const shared = { UtilityCompany: 'City of Louisburg' };
const META = { lineSeen: true, otherCommoditiesConfident: true, unresolvedCommodities: [] };
const USAGE = 1214.164; // x 0.798062 = 968.98 (synthetic)
const DATE = '2/18/2026';
const run = (printedGas, currentBill, others, fa) =>
  build(shared, { charge: printedGas, usage: USAGE, prevRead: 1, currRead: 2 }, true, others, currentBill, fa, DATE, META);

// 1. printed 992.33 -> 969.00, printed field stored, no computed substitution.
let b = run(992.33, 1002.33, 20.0, -10.0);
check('1 GasCharge is printed 992.33 - 23.33 = 969.00', b && b.GasCharge === 969.0, JSON.stringify(b && b.GasCharge));
check('1 printed GAS line stored', b && b.PrintedGasLine === 992.33, JSON.stringify(b && b.PrintedGasLine));
check('1 no auto-correction marker', b && !b._auto_corrected_GasCharge, 'marker present');
check('1 total = printed GAS + fuel adjustment', b && b.TotalCurrentCharges === '982.33', b && b.TotalCurrentCharges);

// 2. misread GAS cell (off by more than $1), readable Current Bill -> reconciled printed value.
b = run(934.33, 1002.33, 20.0, -10.0);
check('2 reconciled GasCharge 969.00', b && b.GasCharge === 969.0, JSON.stringify(b && b.GasCharge));
check('2 reconciled printed GAS line 992.33', b && b.PrintedGasLine === 992.33, JSON.stringify(b && b.PrintedGasLine));
check('2 marker names Current Bill', b && b._auto_corrected_GasCharge && /Current Bill/.test(b._auto_corrected_GasCharge.reason), '');
check('2 not held', b && !b._gateTripped, '');

// 3. misread and no Current Bill -> held with plain reason; never usage x rate.
b = run(934.33, null, 0, -10.0);
check('3 held', b && b._gateTripped === true && b._manualReview === true, JSON.stringify(b));
check('3 GasCharge null (never 968.98)', b && b.GasCharge === null, JSON.stringify(b && b.GasCharge));
check('3 reason plain', b && b._gateReasons && /Gas charge on the bill \(\$934\.33\) does not match usage x rate \(\$\d+\.\d\d\) - verify/.test(b._gateReasons[0]), b && b._gateReasons && b._gateReasons[0]);

// 5. (2026-10-15) ONE charge-token picker: last cents token; else last bare 4+ digits (point lost);
// else first token. A cents token that does not start with a digit is a broken read -> null.
const pick = vm.runInContext('_lbg_pickChargeToken', sandbox);
const pickCases = [
  [['9', '99233'], undefined, '99233'],
  [['248', '321.33'], undefined, '321.33'],
  [['335:33'], undefined, '335:33'],
  [['1460-87'], undefined, '1460-87'],
  [['12', ',254.80'], undefined, null],
  [['2333'], undefined, '2333'],
  [['1', '1'], undefined, '1'],
  [['7', '4,', '0', '4032'], false, '4032'],
  [['28'], false, null],
  [[], undefined, null],
];
for (const [toks, firstIfNone, want] of pickCases) {
  const got = pick(toks, firstIfNone);
  check('5 pick ' + JSON.stringify(toks) + ' -> ' + JSON.stringify(want), got === want, JSON.stringify(got));
}

// 6. (2026-10-15) Therms garbled, printed Gas proven by the page to the cent: charge kept, therms
// null and flagged. Printed 100.00; Current Bill 180.00 - others 90.00 - fuel adj (-10.00) = 100.00.
const runUsage = (printedGas, usage, currentBill, others, fa) =>
  build(shared, { charge: printedGas, usage, prevRead: 1, currRead: 2 }, true, others, currentBill, fa, DATE, META);
b = runUsage(100.0, 9999, 180.0, 90.0, -10.0);
check('6 charge kept: 100.00 - 23.33 = 76.67', b && b.GasCharge === 76.67, JSON.stringify(b && b.GasCharge));
check('6 total = printed + fuel adjustment', b && b.TotalCurrentCharges === '90.00', b && b.TotalCurrentCharges);
check('6 therms null, never charge / rate', b && b.NaturalGasTherms === null, JSON.stringify(b && b.NaturalGasTherms));
check('6 flagged for therms by name', b && b._gateTripped === true && /therms/i.test(b._manualReviewLabel) && !!b._correction_pending_NaturalGasTherms, JSON.stringify(b && b._manualReviewLabel));
b = runUsage(100.0, 9999, 181.0, 90.0, -10.0);
check('6 page off by a cent: held, charge null', b && b._manualReview === true && b.GasCharge === null, JSON.stringify(b && b.GasCharge));
b = runUsage(100.0, 9999, 180.0, 90.0, null);
check('6 fuel adjustment unread: not proven, held', b && b._manualReview === true && b.GasCharge === null, JSON.stringify(b && b.GasCharge));

// 4. Source shape: overwrite function gone, no therms x rate substitution left.
check('4 _lbg_correctGasCharge removed', !/_lbg_correctGasCharge\s*\(/.test(src), '');
check('4 one resolver, three call sites', (src.match(/_lbg_resolveGasLine\(/g) || []).length === 4, String((src.match(/_lbg_resolveGasLine\(/g) || []).length)); // 1 def + 3 calls

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
