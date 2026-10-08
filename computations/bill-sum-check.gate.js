#!/usr/bin/env node
// computations/bill-sum-check.gate.js -- deploy gate for validateBillData charge-sum check.
// 1. A bill whose charges plus a miscellaneous charge equal the total gives no sum warning.
// 2. A bill whose charges really differ from the total still gives the sum warning.
// 3. Every field in the Utility E component list changes the sum (none is left out).
// All values are synthetic. Run: node computations/bill-sum-check.gate.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sb = { console, document: { addEventListener() {}, getElementById: () => null }, localStorage: { getItem: () => null, setItem() {} } };
sb.window = sb;
vm.createContext(sb);
for (const f of ['lib/formatting.js', 'computations/rates.js', 'app/bill-analysis.js']) {
  try { vm.runInContext(read(f), sb, { filename: f }); } catch (e) { /* browser-only tail code; the functions used here are already defined */ }
}
vm.runInContext('this.__V = validateBillData;', sb);
const UTIL = 'Evergy';
const sumWarn = (b) => (sb.__V(b, UTIL).warnings || sb.__V(b, UTIL)).filter((w) => /Charges sum/.test(w.message));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); } catch (e) { failures++; console.log('FAIL  ' + name + ' -- ' + e.message); }
}
const base = () => ({ Commodity: 'Electric', CustomerCharge: '100.00', BilledKWCharge: '200.00', ECACharge: '50.00' });
check('miscellaneous charge is part of the sum', () => {
  const b = Object.assign(base(), { MiscellaneousCharge: '25.00', TotalCurrentCharges: '375.00' });
  assert.strictEqual(sumWarn(b).length, 0, JSON.stringify(sumWarn(b)));
});
check('negative miscellaneous charge is part of the sum', () => {
  const b = Object.assign(base(), { MiscellaneousCharge: '-40.00', TotalCurrentCharges: '310.00' });
  assert.strictEqual(sumWarn(b).length, 0, JSON.stringify(sumWarn(b)));
});
check('real mismatch still warns', () => {
  const b = Object.assign(base(), { MiscellaneousCharge: '25.00', TotalCurrentCharges: '500.00' });
  assert.strictEqual(sumWarn(b).length, 1);
});
check('every component field is in the sum', () => {
  const fields = vm.runInContext('UTILITY_E_COMPONENT_CHARGE_FIELDS', sb);
  assert.ok(fields.length >= 17);
  for (const f of fields) {
    const b = { Commodity: 'Electric', TotalCurrentCharges: '1000.00' };
    b[f] = '1000.00';
    assert.strictEqual(sumWarn(b).length, 0, f + ' not summed');
  }
});
if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
