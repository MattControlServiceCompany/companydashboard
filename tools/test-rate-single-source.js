#!/usr/bin/env node
// tools/test-rate-single-source.js — 2026-10-05 duplicate-bill-fields audit, step 5.
// getStoredRate(bill, type) and getStoredKwRate(bill) (computations/rates.js) are the ONE rate per
// bill. They compute from the bill's own cost and usage (through the one cost accessors and the one
// gas usage resolver). The old stored copies (total*Rate) are read only when the bill has no cost or
// no usage. Nothing writes them any more.
//   1. A stale stored rate never wins over cost / usage (the Site H Sewer 2026-03-15 shape: stored
//      totalSewerRate 0.99407 while sewerCharge / sewerUsage says otherwise).
//   2. camelCase (saved) and PascalCase (extractor) fields both resolve.
//   3. Stored copy only when nothing can be computed; nothing at all -> 0.
//   4. Propane is the all-in rate (total / gallons), the savings-engine rule.
//   5. STRUCTURAL: no writer of total*Rate in app/ or computations/ (ensureBillRates, the PDF save
//      paths, the CSV import, the one-time backfills are gone) and the Bills table reads every rate
//      column through _billReadValue -> getStoredRate / getStoredKwRate.
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
for (const rel of ['lib/formatting.js', 'computations/rates.js', 'computations/savings.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
{
  const ud = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
  const a = ud.indexOf('const UNIT_TO_BASE = {');
  const b = ud.indexOf('function getMeterBillUnit');
  vm.runInContext(ud.slice(a, b), S, { filename: 'utility-data.js (unit table extract)' });
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const R = (b, t) => S.getStoredRate(b, t);

console.log('1. a stale stored rate never wins over cost / usage');
assert(
  near(R({ sewerUsage: '10000', sewerCharge: '87.50', totalSewerRate: '0.99407' }, 'sewer'), 0.00875),
  'sewer: sewerCharge/sewerUsage, not the stored copy',
);
assert(
  near(R({ waterUsage: '20000', waterCharge: '150', totalWaterRate: '9' }, 'water'), 0.0075),
  'water: waterCharge/waterUsage',
);
assert(
  near(R({ kwh: '1000', onPeakCost: '60', offPeakCost: '20', totalKwhRate: '0.5' }, 'kwh'), 0.08),
  'kwh: kWh dollars / kWh',
);
assert(
  near(R({ naturalGasTherms: '100', gasCharge: '52', totalGasRate: '31.8' }, 'gas'), 0.52),
  'gas: gasCharge / therms',
);
assert(
  near(
    S.getStoredKwRate({
      billedKW: '100',
      demandCharge: '900',
      tdcCharge: '50',
      facilitiesCharge: '50',
      totalKwRate: '99',
    }),
    10,
  ),
  'kW: (demand + tdc + facilities) / billed kW',
);

console.log('2. saved (camelCase) and extractor (PascalCase) shapes both resolve');
assert(near(R({ SewerUsage: '10000', SewerCharge: '87.50' }, 'sewer'), 0.00875), 'sewer PascalCase');
assert(near(R({ WaterUsage: '20000', WaterCharge: '150' }, 'water'), 0.0075), 'water PascalCase');
assert(near(R({ kWhConsumed: '1000', onPeakCost: '80' }, 'kwh'), 0.08), 'kwh PascalCase usage');
assert(near(R({ NaturalGasMMbtu: '5', GasCharge: '200' }, 'gas'), 4), 'gas MMBtu x10');
assert(near(S.getStoredKwRate({ BilledKW: '100', demandCharge: '1000' }), 10), 'kW PascalCase');

console.log('3. stored copy only when nothing can be computed; nothing -> 0');
assert(near(R({ totalSewerRate: '0.99407' }, 'sewer'), 0.99407), 'sewer: stored when no usage/charge');
assert(near(R({ kwh: '1000', totalKwhRate: '0.07' }, 'kwh'), 0.07), 'kwh: stored when no dollars');
assert(near(S.getStoredKwRate({ totalKwRate: '12.5' }), 12.5), 'kW: stored when no kW');
assert(
  R({}, 'sewer') === 0 &&
    R({}, 'water') === 0 &&
    R({}, 'kwh') === 0 &&
    R({}, 'gas') === 0 &&
    S.getStoredKwRate({}) === 0,
  'nothing: 0',
);
assert(
  R(null, 'gas') === 0 && S.getStoredKwRate(null) === 0 && R({ a: 1 }, 'nope') === 0,
  'null bill / unknown type: 0',
);

console.log('4. propane is the all-in rate; stormwater is the charge');
assert(
  near(R({ gallonsDelivered: '500', totalCost: '1250', unitPrice: '2.1', totalPropaneRate: '2.1' }, 'propane'), 2.5),
  'propane: total / gallons, not unit price',
);
assert(near(R({ stormWaterCharge: '42.5', totalStormwaterRate: '1' }, 'stormwater'), 42.5), 'stormwater: the charge');

console.log('5. structural: nothing writes a stored rate; the Bills table reads through the rate functions');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
const writers = [];
for (const dir of ['app', 'computations', 'lib']) {
  for (const f of fs.readdirSync(path.join(REPO, dir))) {
    if (!f.endsWith('.js') || f.endsWith('.gate.js')) continue; // gate fixtures hold stored rates on purpose
    const rel = dir + '/' + f;
    stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'))
      .split('\n')
      .forEach((l, i) => {
        if (
          /(^|[^\w.])(\w+\.)?total(Kwh|Kw|Gas|Water|Sewer|Propane|Stormwater)Rate\s*[:=][^=]/.test(l) &&
          !/^\s*(key|pdfKey):/.test(l.trim()) &&
          !/:\s*'(kwh|gas|water|sewer|propane|stormwater)'/.test(l)
        )
          writers.push(rel + ':' + (i + 1) + ' ' + l.trim());
      });
  }
}
assert(writers.length === 0, 'stored-rate writers:' + writers.map((w) => '\n    ' + w).join(''));
const csv = stripComments(fs.readFileSync(path.join(REPO, 'app/csv-import.js'), 'utf8'));
assert(
  !/function ensureBillRates/.test(fs.readFileSync(path.join(REPO, 'computations/rates.js'), 'utf8')),
  'ensureBillRates is gone',
);
const brv = csv.slice(csv.indexOf('function _billReadValue('), csv.indexOf('function _billFormatValue('));
for (const k of [
  'totalKwhRate',
  'totalGasRate',
  'totalWaterRate',
  'totalSewerRate',
  'totalPropaneRate',
  'totalStormwaterRate',
])
  assert(brv.indexOf(k) > 0, '_billReadValue routes ' + k + ' through getStoredRate');
assert(/getStoredKwRate\(row\)/.test(brv), '_billReadValue routes totalKwRate through getStoredKwRate');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
