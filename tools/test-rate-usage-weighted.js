#!/usr/bin/env node
// tools/test-rate-usage-weighted.js — 2026-10-13. SYNTHETIC data only (no client data).
// Every baseline rate from computeSeasonalBldgRates (computations/rates.js) is usage-weighted:
// sum of the charges / sum of the usage over the bills in the bucket, never the plain mean of per-bill rates.
// A baseline bill that the bill-flag engine flags as a usage / charge mismatch (computeMeterRateExclusions,
// computations/bill-flags.js) gives no rate, is listed in `excluded`, and its data is never changed.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-9);

const S = { console };
S.window = S;
vm.createContext(S);
for (const rel of [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'computations/rates.js',
  'computations/savings.js',
  'computations/normalization.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
require('./bill-flags-sandbox.js').addBillFlagEngine(S);
const P = S.SEASON_UTILITY;

function rates(commodity, bills, provider) {
  const meter = { id: 'm1', commodity, provider: provider || '', inclusive: true, bills, baseline: { months: ['x'] } };
  const bld = { id: 'b', meters: [meter] };
  S.getUDBldg = () => bld;
  S.getUDBldgs = () => [bld];
  S._dashGetBaselineBills = (m) => m.bills;
  S._udProjBaselineMonthsFallback = () => null;
  S.normMonth = (s, e) => e.slice(0, 7);
  S.getMeterBillUnit = () => 'gal';
  return S.computeSeasonalBldgRates(1, 'b');
}
const month = (i) => {
  const m = ((i - 1) % 12) + 1;
  const y = 2024 + Math.floor((i - 1) / 12);
  const pad = (n) => String(n).padStart(2, '0');
  return { start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-28' };
};

console.log('1. gas: sum of cost / sum of therms, not the mean of the monthly rates');
{
  // 100 therms at 0.50 and 900 therms at 0.80: weighted = (50 + 720) / 1000 = 0.77; plain mean = 0.65.
  const bills = [
    Object.assign(month(1), { naturalGasTherms: '100', gasCharge: '50' }),
    Object.assign(month(2), { naturalGasTherms: '900', gasCharge: '720' }),
  ];
  const r = rates('Gas', bills, 'Kansas Gas Service');
  assert(
    near(r.thermRate, 0.77, 1e-9),
    'annual gas rate is the usage-weighted 0.77, not the mean 0.65 (' + r.thermRate + ')',
  );
  assert(
    near(r.gasSummer, 0.77, 1e-9) && near(r.gasWinter, 0.77, 1e-9),
    'no seasonal tariff: summer = winter = annual',
  );
  assert(
    r.gasMonthly.length === 12 && near(r.gasMonthly[0], 0.5, 1e-9) && near(r.gasMonthly[1], 0.8, 1e-9),
    'monthly array keeps each month rate',
  );
  assert(r.excluded.length === 0, 'two bills: nothing excluded');
  // two bills in the SAME calendar month: that month is weighted too
  const two = [
    { start: '2024-01-01', end: '2024-01-28', naturalGasTherms: '100', gasCharge: '50' },
    { start: '2025-01-01', end: '2025-01-28', naturalGasTherms: '900', gasCharge: '720' },
  ];
  const r2 = rates('Gas', two, 'Kansas Gas Service');
  assert(near(r2.gasMonthly[0], 0.77, 1e-9), 'a calendar month with two bills is weighted (' + r2.gasMonthly[0] + ')');
}

console.log('2. electric: season rate weighted by the kWh of the bills in the season');
{
  const bills = [
    { start: '2024-07-01', end: '2024-07-31', kwh: '1000', kwhCost: '100', billedKW: '10', kwCost: '100' },
    { start: '2024-08-01', end: '2024-08-31', kwh: '9000', kwhCost: '1350', billedKW: '30', kwCost: '600' },
  ];
  const r = rates('Electric', bills, P);
  assert(near(r.kwhSummer, 0.145, 1e-4), 'kWh summer = 1450 / 10000 = 0.145 (' + r.kwhSummer + ')');
  assert(near(r.kwSummer, 17.5, 1e-9), '$/kW summer = 700 / 40 kW = 17.5 (' + r.kwSummer + ')');
  assert(near(r.kwhRate, 0.145, 1e-4), 'all-season kWh rate is the same weighted value');
}

console.log('3. water and sewer: a wrong bill is left out, the rest are weighted');
{
  // 8 normal bills at about $0.01 per gal plus the two bad ones.
  const water = [];
  const sewer = [];
  for (let i = 1; i <= 8; i++) {
    const d = month(i);
    water.push(Object.assign({ id: 'w' + i, waterUsage: '100000', waterCharge: '1000', totalCost: '1000' }, d));
    sewer.push(Object.assign({ id: 's' + i, sewerUsage: '100000', sewerCharge: '1000', totalCost: '1000' }, d));
  }
  const clean = rates('Sewer', sewer);
  assert(
    near(clean.sewerRate, 0.01, 1e-9) && clean.excluded.length === 0,
    'clean meter: 0.01 per gal, nothing excluded',
  );
  const before = JSON.stringify(sewer);
  const dirty = sewer.slice();
  dirty.push(Object.assign({ id: 's9', sewerUsage: '291', sewerCharge: '313.08', totalCost: '313.08' }, month(9)));
  dirty.push(Object.assign({ id: 's10', sewerUsage: '4303400', sewerCharge: '700', totalCost: '700' }, month(10)));
  const r = rates('Sewer', dirty);
  assert(near(r.sewerRate, 0.01, 1e-9), 'sewer rate stays 0.01 with both bad bills present (' + r.sewerRate + ')');
  assert(r.excluded.length === 2, 'both bad bills are listed (' + r.excluded.length + ')');
  const ids = r.excluded
    .map((e) => e.billId)
    .sort()
    .join();
  assert(ids === 's10,s9', 'the two bad bills are the ones left out (' + ids + ')');
  const e9 = r.excluded.find((e) => e.billId === 's9');
  assert(
    e9 && e9.usage === 291 && near(e9.charge, 313.08) && e9.rules.length > 0 && e9.reason.length > 0,
    'a record carries usage, charge, rule and reason',
  );
  assert(JSON.stringify(sewer) === before, 'bill data is not changed');
  assert(
    S.formatExcludedBillsLabel(r.excluded) === '2 bills excluded: Sep 2024, Oct 2024',
    'label names the count and the months (' + S.formatExcludedBillsLabel(r.excluded) + ')',
  );
  assert(S.formatExcludedBillsLabel([]) === '', 'no exclusions: no label');
  // a dismissed flag means the user accepts the bill: it feeds the rate
  const kept = dirty.map((b) =>
    b.id === 's10'
      ? Object.assign({}, b, {
          _flags: [
            { id: 'charge_vs_usage', dismissed: true },
            { id: 'usage_charge_mismatch', dismissed: true },
          ],
        })
      : b,
  );
  const r2 = rates('Sewer', kept);
  assert(r2.excluded.length === 1 && r2.excluded[0].billId === 's9', 'a dismissed flag puts the bill back in the rate');
  // the shared predicate is the flag engine's
  const ex = S.computeMeterRateExclusions(
    { id: 'm1', commodity: 'Sewer', inclusive: true, bills: dirty },
    { meters: [] },
  );
  assert(Object.keys(ex).sort().join() === 's10,s9', 'computeMeterRateExclusions names the same two bills');
}

console.log('4. a bill with tiny usage cannot outweigh the rest (minimum-charge bill)');
{
  const water = [];
  for (let i = 1; i <= 8; i++)
    water.push(Object.assign({ id: 'w' + i, waterUsage: '20000', waterCharge: '200', totalCost: '200' }, month(i)));
  // 3 gal for the minimum charge $9.09: plain mean of rates would be about 0.4
  water.push(Object.assign({ id: 'w9', waterUsage: '3', waterCharge: '9.09', totalCost: '9.09' }, month(9)));
  const r = rates('Water', water);
  assert(
    r.waterRate < 0.0102 && r.waterRate > 0.0099,
    'one 3 gal bill moves the rate by under 2% (' + r.waterRate + ')',
  );
}

console.log('5. stormwater has no usage: the mean monthly charge');
{
  const bills = [1, 2, 3].map((i) =>
    Object.assign({ id: 'x' + i, stormWaterCharge: i === 3 ? '10' : '4', totalCost: '4' }, month(i)),
  );
  const r = rates('Stormwater', bills);
  assert(
    near(r.stormwaterRate, 6, 1e-9) && r.stormwaterUnit === 'bill',
    'stormwater rate = mean charge per bill (' + r.stormwaterRate + ')',
  );
}

console.log('6. one parts function behind getStoredRate');
{
  const g = { naturalGasTherms: '200', gasCharge: '100' };
  const p = S.getBillRateParts(g, 'gas');
  assert(
    p.usage === 200 && p.charge === 100 && near(S.getStoredRate(g, 'gas'), p.charge / p.usage),
    'gas parts and rate agree',
  );
  const k = { billedKW: '50', demandCharge: '500', facilitiesCharge: '50' };
  const pk = S.getBillRateParts(k, 'kw');
  assert(pk.usage === 50 && pk.charge === 550 && near(S.getStoredKwRate(k), 11), 'kW parts and rate agree');
  assert(S.getStoredRate({ totalWaterRate: '0.5' }, 'water') === 0.5, 'stored copy only when nothing can be computed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
