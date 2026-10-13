#!/usr/bin/env node
// tools/test-utility-seasons.js — 2026-10-13. SYNTHETIC data only (no client data).
// SEASON_TABLE (computations/rates.js) is the one season rule: summer Jun 1 - Sep 30 by SERVICE DATE, per provider.
//   1. seasonOfDate / seasonOfMonth / seasonSummerMonthIdx / seasonDaysOfPeriod read the table.
//   2. A bill that crosses a season edge counts in both seasons, weighted by days; with split charge lines
//      (_chargeParts) each season takes its own printed rate, without them the blended rate is prorated.
//   3. A provider with no seasonal tariff (gas) gets summer = winter = annual mean, and a month-by-month array.
//   4. measureRateAt prices each calendar month at the summer / winter rate, or at that month's own rate.
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
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);

const S = { console };
S.window = S;
vm.createContext(S);
for (const rel of ['lib/date-helpers.js', 'lib/formatting.js', 'computations/rates.js', 'computations/savings.js', 'computations/normalization.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
require('./bill-flags-sandbox.js').addBillFlagEngine(S); // computeSeasonalBldgRates asks the flag engine which bills to leave out
const P = S.SEASON_UTILITY; // the one utility name the season table tests
const es = fs.readFileSync(path.join(REPO, 'app/energy-savings.js'), 'utf8');
vm.runInContext(es.slice(es.indexOf('function measureRateAt'), es.indexOf('// calcMeasureDollars(m, rates, opts)')), S);

console.log('1. the table');
assert(S.seasonOfDate(P, '2025-05-31') === 'winter', 'May 31 winter');
assert(S.seasonOfDate(P, '2025-06-01') === 'summer', 'Jun 1 summer');
assert(S.seasonOfDate(P + ' Missouri West', '2025-09-30') === 'summer', 'Sep 30 summer (MO West)');
assert(S.seasonOfDate(P + ' Kansas Central', '2025-10-01') === 'winter', 'Oct 1 winter');
assert(S.seasonOfDate('Kansas Gas Service', '2025-07-01') === 'none', 'gas provider has no season');
assert(
  [4, 5, 8, 9].map((i) => S.seasonOfMonth(P, i)).join() === 'winter,summer,summer,winter',
  'month indexes May, Jun, Sep, Oct',
);
const d = S.seasonDaysOfPeriod(P, '2025-05-29', '2025-06-29', true);
assert(d.winter === 3 && d.summer === 29 && d.total === 32, 'May 29 - Jun 29 inclusive = 3 winter + 29 summer');
const dx = S.seasonDaysOfPeriod(P, '2025-05-29', '2025-06-29', false);
assert(dx.winter === 3 && dx.summer === 28, 'exclusive leaves the last day out');
assert(S.seasonDaysOfPeriod('Kansas Gas Service', '2025-05-29', '2025-06-29', true) === null, 'no season: null');

console.log('2. straddling electric bills');
function elecBill(start, end, withParts) {
  // 30,000 kWh, 100 kW. Summer energy 0.10, winter energy 0.04 per kWh, ECA 0.02 flat; demand 10 summer / 5 winter + 2 other.
  const b = { start, end, kwh: '30000', billedKW: '100' };
  const dd = S.seasonDaysOfPeriod(P, start, end, true);
  const fs_ = dd.summer / dd.total;
  const kS = 30000 * fs_,
    kW = 30000 - kS;
  const energy = kS * 0.1 + kW * 0.04;
  const eca = 30000 * 0.02;
  const dem = 100 * (10 * fs_ + 5 * (1 - fs_));
  b.onPeakCost = String(energy);
  b.offPeakCost = '0';
  b.ecaCharge = String(eca);
  b.kwCost = String(dem + 200);
  if (withParts)
    b._chargeParts = {
      EnergyOnPeakCharge: [
        { qty: kW, rate: 0.04, unit: 'kWh', charge: kW * 0.04 },
        { qty: kS, rate: 0.1, unit: 'kWh', charge: kS * 0.1 },
      ],
      EnergyOffPeakCharge: [
        { qty: 0, rate: 0.03, unit: 'kWh', charge: 0 },
        { qty: 0, rate: 0.09, unit: 'kWh', charge: 0 },
      ],
      BilledKWCharge: [
        { qty: 100, rate: 10, unit: 'kW', charge: 1000 * fs_ },
        { qty: 100, rate: 5, unit: 'kW', charge: 500 * (1 - fs_) },
      ],
    };
  return b;
}
const dayShare = S.seasonDaysOfPeriod(P, '2025-05-29', '2025-06-29', true);
const sS = dayShare.summer / dayShare.total;
const withLines = elecBill('2025-05-29', '2025-06-29', true);
const sp = S._billSeasonRates(withLines, 'kwh', dayShare, P);
assert(
  sp && near(sp.summer, 0.1 + 0.02, 1e-9) && near(sp.winter, 0.04 + 0.02, 1e-9),
  'kWh: season rate = printed line rate + ECA',
);
const spk = S._billSeasonRates(withLines, 'kw', dayShare, P);
assert(
  spk && near(spk.summer, 10 + 2, 1e-9) && near(spk.winter, 5 + 2, 1e-9),
  'kW: season line rate + other demand charges per kW',
);
const bad = elecBill('2025-05-29', '2025-06-29', true);
bad._chargeParts.BilledKWCharge[0].charge = 100; // quantity split no longer matches the day split
assert(S._billSeasonRates(bad, 'kw', dayShare, P) === null, 'kW split that disagrees with the days is not used');
assert(
  S._billSeasonRates(elecBill('2025-05-29', '2025-06-29', false), 'kwh', dayShare, P) === null,
  'no _chargeParts: null',
);

// Evidence for which line is summer: the printed date range, else the quantities. Never the higher rate.
const swapped = elecBill('2025-05-29', '2025-06-29', true); // summer line is the LOWER rate (a rate guess would be wrong)
const ep = swapped._chargeParts;
ep.EnergyOnPeakCharge = ep.EnergyOnPeakCharge.map((l) => ({ ...l, rate: l.rate === 0.1 ? 0.03 : 0.09 }));
ep.EnergyOffPeakCharge = ep.EnergyOffPeakCharge.map((l) => ({ ...l, rate: l.rate === 0.09 ? 0.02 : 0.08 }));
ep.EnergyOnPeakCharge.forEach((l) => (l.charge = l.qty * l.rate));
ep.BilledKWCharge = [
  { qty: 100, rate: 4, unit: 'kW', charge: 400 * sS },
  { qty: 100, rate: 9, unit: 'kW', charge: 900 * (1 - sS) },
];
swapped.kwCost = String(400 * sS + 900 * (1 - sS) + 200);
const sw = S._billSeasonRates(swapped, 'kw', dayShare, P);
assert(
  sw && sw.how === 'qty' && near(sw.summer, 4 + 2, 1e-9) && near(sw.winter, 9 + 2, 1e-9),
  'kW: summer line with the lower rate is still summer (quantities)',
);
const lbl = elecBill('2025-05-29', '2025-06-29', true);
const lk = lbl._chargeParts.BilledKWCharge; // line 1 = the rate 10 line with the summer share of the kW
[lk[0].from, lk[0].to, lk[1].from, lk[1].to] = ['2025-06-01', '2025-06-29', '2025-05-29', '2025-05-31'];
const lb = S._billSeasonRates(lbl, 'kw', dayShare, P);
assert(lb && lb.how === 'label' && near(lb.summer, 12, 1e-9), 'kW: printed date range sets the season (label)');
const lblBad = elecBill('2025-05-29', '2025-06-29', true);
const lq = lblBad._chargeParts.BilledKWCharge; // labels say line 1 is winter, but its quantity is the summer share
[lq[0].from, lq[0].to, lq[1].from, lq[1].to] = ['2025-05-29', '2025-05-31', '2025-06-01', '2025-06-29'];
assert(
  S._billSeasonRates(lblBad, 'kw', dayShare, P) === null,
  'a label that disagrees with the quantity split is not used',
);
const half = S.seasonDaysOfPeriod(P, '2025-05-17', '2025-06-15', true); // 15 winter + 15 summer
const hb = elecBill('2025-05-17', '2025-06-15', true);
assert(
  S._billSeasonRates(hb, 'kw', half, P) === null,
  'a 50/50 day split cannot tell the lines apart: prorate by days',
);

function building(provider, bills) {
  const meter = { id: 'm1', commodity: 'Electric', provider, inclusive: true, bills, baseline: { months: ['x'] } };
  return { meters: [meter] };
}
function run(bld, gasBld) {
  S.getUDBldg = () => bld;
  S.getUDBldgs = () => [bld];
  S._dashGetBaselineBills = (m) => m.bills;
  S._udProjBaselineMonthsFallback = () => null;
  S.normMonth = (s, e) => e.slice(0, 7);
  return S.computeSeasonalBldgRates(1, 'b');
}
// Whole-summer bill + whole-winter bill + one straddling bill with split lines.
const wholeS = elecBill('2025-07-01', '2025-07-31', false);
const wholeW = elecBill('2025-01-01', '2025-01-31', false);
const r = run(building(P, [wholeW, wholeS, withLines]));
assert(
  r.straddle.kwh.bills === 1 && r.straddle.kwh.qty === 1 && r.straddle.kwh.days === 0,
  'straddle count kWh (1 by quantities)',
);
assert(
  r.straddle.kw.bills === 1 && r.straddle.kw.qty === 1 && r.straddle.kw.label === 0,
  'straddle count kW (1 by quantities)',
);
assert(r.kwhSummer > 0 && r.kwhWinter > 0, 'summer and winter rates exist');
const noLines = elecBill('2025-05-29', '2025-06-29', false);
const r2 = run(building(P, [noLines]));
assert(
  r2.straddle.kwh.days === 1 && r2.straddle.kw.days === 1 && r2.kwhSummer > 0 && near(r2.kwhSummer, r2.kwhWinter, 1e-9),
  'no lines: one blended rate in both seasons',
);
assert(r.kwhSummer > r.kwhWinter, 'summer energy rate is above winter');

console.log('3. provider with no seasonal tariff');
function gasBill(start, end, therms, cost) {
  return { start, end, naturalGasTherms: String(therms), gasCharge: String(cost) };
}
const gasMeter = {
  id: 'g1',
  commodity: 'Gas',
  provider: 'Kansas Gas Service',
  inclusive: true,
  bills: [gasBill('2025-01-01', '2025-01-31', 100, 80), gasBill('2025-07-01', '2025-07-31', 100, 40)],
  baseline: { months: ['x'] },
};
const rg = run({ meters: [gasMeter] });
assert(
  near(rg.thermRate, 0.6, 1e-3) && near(rg.gasSummer, 0.6, 1e-3) && near(rg.gasWinter, 0.6, 1e-3),
  'gas: summer = winter = annual mean',
);
assert(
  rg.gasMonthly.length === 12 && near(rg.gasMonthly[0], 0.8, 1e-9) && near(rg.gasMonthly[6], 0.4, 1e-9),
  'gas: January 0.80, July 0.40',
);
assert(near(rg.gasMonthly[3], 0.6, 1e-9), 'gas: a month with no baseline bill takes the annual mean');
assert(r.gasMonthly.length === 0 && r.kwhMonthly.length === 0, 'seasonal utility: no monthly arrays');

console.log('4. measureRateAt');
const rt = (rates, mo) => S.measureRateAt(rates, mo);
assert(
  rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 5).kwh === 0.1 && rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 4).kwh === 0.05,
  'June summer, May winter',
);
assert(
  rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 8).summer && !rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 9).summer,
  'Sep summer, Oct winter',
);
const mr = { gasSummer: 0.6, gasWinter: 0.6, gasMonthly: rg.gasMonthly };
assert(near(rt(mr, 0).gas, 0.8) && near(rt(mr, 6).gas, 0.4), 'gas priced at its own month');
assert(near(rt({ gasSummer: 0.3, gasWinter: 0.5 }, 0).gas, 0.5), 'no monthly array: seasonal rate');

console.log('5. propane, blank provider, mixed building, long bill');
const propMeter = {
  id: 'p1',
  commodity: 'Propane',
  provider: 'Synthetic Propane Supplier',
  inclusive: true,
  bills: [
    { start: '2025-01-05', end: '2025-01-05', gallonsDelivered: '100', totalCost: '180' },
    { start: '2025-07-05', end: '2025-07-05', gallonsDelivered: '100', totalCost: '160' },
  ],
  baseline: { months: ['x'] },
};
const rp = run({ meters: [propMeter] });
assert(near(rp.gallonRate, 1.7, 1e-3), 'propane: flat rate is the annual mean');
assert(
  rp.gallonMonthly.length === 12 && near(rp.gallonMonthly[0], 1.8, 1e-9) && near(rp.gallonMonthly[6], 1.6, 1e-9),
  'propane: January 1.80, July 1.60',
);
assert(near(rp.gallonMonthly[3], 1.7, 1e-9), 'propane: a month with no baseline bill takes the annual mean');
assert(
  near(rt({ gallonRate: 1.7, gallonMonthly: rp.gallonMonthly }, 0).propane, 1.8),
  'propane priced at its own month',
);
assert(near(rt({ gallonRate: 1.7 }, 0).propane, 1.7), 'no propane array: the flat rate');

// A blank provider name has no seasonal tariff: each calendar month takes its own baseline rate, no invented seasons.
const blank = building('', [wholeW, wholeS]);
const rb = run(blank);
assert(rb.kwhMonthly.length === 12 && rb.kwMonthly.length === 12, 'blank provider: month-by-month rates');
assert(near(rb.kwhSummer, rb.kwhWinter, 1e-9), 'blank provider: summer = winter = annual mean (no season)');
assert(rb.kwhMonthly[0] !== rb.kwhMonthly[6], 'blank provider: January and July carry their own rates');

// Mixed building: a seasonal meter plus a no-season electric meter. The month array must carry the seasonal meter too.
const mixed = {
  meters: [
    {
      id: 'e1',
      commodity: 'Electric',
      provider: P,
      inclusive: true,
      bills: [wholeS, wholeW],
      baseline: { months: ['x'] },
    },
    {
      id: 'e2',
      commodity: 'Electric',
      provider: '',
      inclusive: true,
      bills: [wholeS, wholeW],
      baseline: { months: ['x'] },
    },
  ],
};
const rm = run(mixed);
assert(rm.kwhMonthly.length === 12, 'mixed building: month array exists');
const onlySeasonal = run(building(P, [wholeS, wholeW]));
assert(
  near(rm.kwhMonthly[6], onlySeasonal.kwhSummer, 1e-4) && near(rm.kwhMonthly[0], onlySeasonal.kwhWinter, 1e-4),
  'mixed building: month array carries the seasonal meter season rates (same data on both meters)',
);

// A bill of any length is split by day (no 400 day stop).
const longD = S.seasonDaysOfPeriod(P, '2023-01-01', '2025-12-31', true);
assert(
  longD.total === 1096 && longD.summer === 122 * 3 && longD.winter === 1096 - 122 * 3,
  'a 3 year period is counted in full: ' + JSON.stringify(longD),
);

// Water, sewer, stormwater: baseline mean in the bill's own unit, monthly like gas (synthetic bills).
S.getMeterBillUnit = (m) => m.billUnit || 'gal';
const wm = (id, commodity, unit, bills) => ({ id, commodity, provider: 'City Water', billUnit: unit, inclusive: true, bills, baseline: { months: ['x'] } });
const wb = (s, e, use, chg) => ({ start: s, end: e, waterUsage: String(use), waterCharge: String(chg) });
const sb = (s, e, use, chg) => ({ start: s, end: e, sewerUsage: String(use), sewerCharge: String(chg) });
const rw = run({
  meters: [
    wm('w', 'Water', 'kgal', [wb('2025-01-01', '2025-01-31', 10, 80), wb('2025-07-01', '2025-07-31', 10, 40)]),
    wm('s', 'Sewer', 'gal', [sb('2025-01-01', '2025-01-31', 1000, 5)]),
    wm('t', 'Stormwater', null, [{ start: '2025-01-01', end: '2025-01-31', stormWaterCharge: '12' }]),
  ],
});
assert(rw.waterUnit === 'kgal' && near(rw.waterRate, 6, 1e-6), 'water: 6 per kgal, own unit: ' + rw.waterRate + ' ' + rw.waterUnit);
assert(rw.waterMonthly.length === 12 && near(rw.waterMonthly[0], 8) && near(rw.waterMonthly[6], 4) && near(rw.waterMonthly[3], 6), 'water monthly: Jan 8, Jul 4, annual mean elsewhere');
assert(rw.sewerUnit === 'gal' && near(rw.sewerRate, 0.005, 1e-9), 'sewer: 0.005 per gal');
assert(rw.stormwaterUnit === 'bill' && near(rw.stormwaterRate, 12), 'stormwater: 12 per bill');
const rmix = run({ meters: [wm('a', 'Water', 'gal', [wb('2025-01-01', '2025-01-31', 1000, 9)]), wm('b', 'Water', 'kgal', [wb('2025-02-01', '2025-02-28', 1, 9)])] });
assert(rmix.waterRate === 0 && rmix.waterUnit === '', 'two bill units: no silent mix');

console.log(failed ? 'FAIL ' + failed + ' (passed ' + passed + ')' : 'PASS ' + passed);
process.exit(failed ? 1 : 0);
