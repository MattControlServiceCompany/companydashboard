#!/usr/bin/env node
// test-wre-mmbtu-unverified.js -- 2026-10-26. SYNTHETIC data only (fake customer, fake accounts, invented numbers).
// Gas supplier invoice, per-site MMbtu. A read figure that cannot be checked is kept and marked for review;
// a bare digit run gets 2 decimals; a figure that the math contradicts is removed; a shipped figure that no
// printed number confirms is marked for review (safety net). Run: node test-wre-mmbtu-unverified.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const REPO = process.env.REPO || __dirname;
const sb = { window: {}, console: { log() {}, warn() {}, error() {} } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'lib/formatting.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/energy-savings.js'), 'utf8'), sb);
const wre = vm.runInContext('UTILITY_RULES.find(r => r.extractAll && String(r.extractAll).indexOf("_parseWRESiteBlocks") >= 0)', sb);
const head = [
  '%%PAGE_1%%', 'Natural Gas Invoice', 'Customer #: 90001', 'Test District Invoice #: 900001 Production Month: April 2025',
  'Test Town, KS 66000 Bill Date: 5/14/2025', 'Item Mmbtu Fuel Rate $',
];
const site = (n, rows) => [
  'Service Address: Site' + n + ' - 1 Test St Acct/Meter: ACT' + n + '/MTR' + n + 'C',
  'Test Town, KS 66000 Pipeline: Test MKT', 'Utility: Test', ...rows,
];
const tail = ['Mmbtu Fuel $', 'Total Natural Gas: 266.90 4.00 $1,000.00', 'Total Current Charges: $1,000.00'];
function run(rows4) {
  const clean = ['Index (FOM) 13.49 0.13 $3.7000 $49.91', 'Sub-Total: 13.49 0.13 $49.91'];
  const lines = [...head, ...site(1, clean), ...site(2, clean),
    ...site(3, ['Sub-Total: 474 0.04 $17.70']),
    ...site(4, ['Sub-Total: 595 0.06']),
    ...site(5, rows4), ...tail];
  return wre.extractAll(lines.join('\n'));
}
const r = run(['Sub-Total: 1246.14 2.36']);
assert.strictEqual(r.length, 5, 'five sites');
// 1: clean, confirmed by its own rate and charge
assert.strictEqual(r[0].NaturalGasMMbtu, '13.49'); assert.ok(!r[0]._manualReview);
// 2: bare digits, repaired to 2 decimals and confirmed by the invoice rate
assert.strictEqual(r[2].NaturalGasMMbtu, '4.74'); assert.ok(!r[2]._manualReview);
// 3: bare digits, nothing to check against: kept, marked for review
assert.strictEqual(r[3].NaturalGasMMbtu, '5.95'); assert.strictEqual(r[3]._manualReview, true);
// 4: wrong figure with no charge: must not ship unmarked (totals do not reconcile)
assert.strictEqual(r[4]._manualReview, true);
assert.ok(/not confirmed/.test(r[4]._manualReviewLabel));
// contradicted figure is still removed
const r2 = run(['Index (FOM) 13.49 0.13 $3.7000', 'Sub-Total: 9.00 0.13 $49.91']);
assert.strictEqual(r2[4].NaturalGasMMbtu, null); assert.strictEqual(r2[4]._manualReview, true);
console.log('test-wre-mmbtu-unverified: PASS');
