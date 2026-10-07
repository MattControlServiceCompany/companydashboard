#!/usr/bin/env node
// tools/test-electric-cost-single-source.js — 2026-10-05 duplicate-bill-fields audit, step 6.
// The four electric dollar accessors in computations/rates.js are the ONE place that says what a
// bill's demand, energy, other and tax dollars are. They add the visible component fields; the old
// stored roll-ups (kwCost, kwhCost, otherCost, taxCost) are read only when a bill has no components.
//   1. Components win over the stored copy, and a real 0 component stays 0 (never falls back).
//   2. A bill with no components reads the stored copy; a bill with neither is 0.
//   3. The four accessors plus getBillFacKWCost add up to the whole bill on a full component row.
//   4. STRUCTURAL: no bill builder in app/bill-analysis.js stores the four roll-ups any more, and
//      no reader in app/, computations/ or lib/ reads bill.otherCost / bill.taxCost directly
//      (kwCost / kwhCost also appear as monthly roll-up object keys, so they are checked at the
//      builder level only).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const S = { console };
S.window = S;
vm.createContext(S);
for (const rel of ['lib/formatting.js', 'computations/rates.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('1. components win; a real 0 stays 0');
assert(near(S.getBillKwCost({ demandCharge: '100', tdcCharge: '5', kwCost: '999' }), 105), 'kW: demandCharge+tdcCharge, not kwCost');
assert(near(S.getBillKwCost({ demandCharge: '0', kwCost: '999' }), 0), 'kW: real 0 demandCharge stays 0');
assert(
  near(S.getBillKwhCost({ onPeakCost: '10', offPeakCost: '20', ecaCharge: '1', eerCharge: '2', ptsCharge: '3', kwhCost: '999' }), 36),
  'kWh: five components, not kwhCost',
);
assert(near(S.getBillKwhCost({ onPeakCost: '0', kwhCost: '999' }), 0), 'kWh: real 0 stays 0');
assert(
  near(S.getBillOtherCost({ customerCharge: '30', rkvaCharge: '4', taxExemptDelivery: '-2', billOffset: '1', miscellaneousCharge: '5', otherCost: '999' }), 38),
  'other: five components incl. miscellaneousCharge, not otherCost',
);
assert(near(S.getBillTaxCost({ franchiseFee: '7.5', taxCost: '999' }), 7.5), 'tax: franchiseFee, not taxCost');
assert(near(S.getBillTaxCost({ franchiseFee: '0', taxCost: '999' }), 0), 'tax: real 0 stays 0');

console.log('2. stored copy only when no component exists');
assert(near(S.getBillKwCost({ kwCost: '50' }), 50), 'kW: stored copy when no components');
assert(near(S.getBillKwhCost({ kwhCost: '60' }), 60), 'kWh: stored copy when no components');
assert(near(S.getBillOtherCost({ otherCost: '70' }), 70), 'other: stored copy when no components');
assert(near(S.getBillTaxCost({ taxCost: '8' }), 8), 'tax: stored copy when no components');
assert(S.getBillKwCost({}) === 0 && S.getBillKwhCost({}) === 0 && S.getBillOtherCost({}) === 0 && S.getBillTaxCost({}) === 0, 'nothing: 0');
assert(S.getBillKwCost(null) === 0 && S.getBillKwhCost(undefined) === 0, 'null bill: 0');

console.log('3. the five accessors add up to the whole bill');
const full = {
  demandCharge: '400.00',
  tdcCharge: '25.00',
  facilitiesCharge: '75.00',
  onPeakCost: '1000.00',
  offPeakCost: '500.00',
  ecaCharge: '40.00',
  eerCharge: '10.00',
  ptsCharge: '5.00',
  customerCharge: '35.00',
  rkvaCharge: '3.00',
  taxExemptDelivery: '-10.00',
  billOffset: '2.00',
  miscellaneousCharge: '1.00',
  franchiseFee: '20.86',
  totalCost: '2106.86',
};
const sum =
  S.getBillKwCost(full) + S.getBillKwhCost(full) + S.getBillOtherCost(full) + S.getBillTaxCost(full) + S.getBillFacKWCost(full);
assert(Math.abs(sum - 2106.86) < 0.005, 'sum of accessors = totalCost (got ' + sum + ')');

console.log('4. structural: builders do not store the roll-ups; readers use the accessors');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
const ba = stripComments(fs.readFileSync(path.join(REPO, 'app/bill-analysis.js'), 'utf8'));
const builderKeys = ba.match(/^\s+(kwCost|kwhCost|otherCost|taxCost),\s*$/gm) || [];
assert(builderKeys.length === 0, 'bill builders still store a roll-up: ' + builderKeys.map((l) => l.trim()).join(' '));
const rollupWrites = ba.match(/^\s*\w+\.(kwCost|kwhCost|otherCost|taxCost)\s*=[^=]/gm) || [];
assert(rollupWrites.length === 0, 'app/bill-analysis.js still writes a roll-up: ' + rollupWrites.map((l) => l.trim()).join(' | '));
const offenders = [];
for (const dir of ['app', 'computations', 'lib']) {
  for (const f of fs.readdirSync(path.join(REPO, dir))) {
    if (!f.endsWith('.js')) continue;
    const rel = dir + '/' + f;
    if (rel === 'computations/rates.js') continue;
    stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'))
      .split('\n')
      .forEach((l, i) => {
        if (/\b(bill|b|b2|r|row|sb|eb)\.(otherCost|taxCost)\b/.test(l) && !/billValueOrBlank\(sb\.(otherCost|taxCost)\)/.test(l))
          offenders.push(rel + ':' + (i + 1) + ' ' + l.trim());
      });
  }
}
assert(offenders.length === 0, 'direct otherCost/taxCost reads:' + offenders.map((o) => '\n    ' + o).join(''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
