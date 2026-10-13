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
for (const rel of ['lib/date-helpers.js', 'lib/formatting.js', 'computations/rates.js', 'computations/savings.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), S, { filename: rel });
}
const P = S.SEASON_UTILITY; // the one utility name the season table tests
const es = fs.readFileSync(path.join(REPO, 'app/energy-savings.js'), 'utf8');
vm.runInContext(
  es.slice(es.indexOf('function measureRateAt'), es.indexOf('// calcMeasureDollars(m, rates, opts)')),
  S,
);

console.log('1. the table');
assert(S.seasonOfDate(P, '2025-05-31') === 'winter', 'May 31 winter');
assert(S.seasonOfDate(P, '2025-06-01') === 'summer', 'Jun 1 summer');
assert(S.seasonOfDate(P + ' Missouri West', '2025-09-30') === 'summer', 'Sep 30 summer (MO West)');
assert(S.seasonOfDate(P + ' Kansas Central', '2025-10-01') === 'winter', 'Oct 1 winter');
assert(S.seasonOfDate('Kansas Gas Service', '2025-07-01') === 'none', 'gas provider has no season');
assert([4, 5, 8, 9].map((i) => S.seasonOfMonth(P, i)).join() === 'winter,summer,summer,winter', 'month indexes May, Jun, Sep, Oct');
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
const sp = S._billSeasonRates(withLines, 'kwh', dayShare);
assert(sp && near(sp.summer, 0.1 + 0.02, 1e-9) && near(sp.winter, 0.04 + 0.02, 1e-9), 'kWh: season rate = printed line rate + ECA');
const spk = S._billSeasonRates(withLines, 'kw', dayShare);
assert(spk && near(spk.summer, 10 + 2, 1e-9) && near(spk.winter, 5 + 2, 1e-9), 'kW: season line rate + other demand charges per kW');
const bad = elecBill('2025-05-29', '2025-06-29', true);
bad._chargeParts.BilledKWCharge[0].charge = 100; // quantity split no longer matches the day split
assert(S._billSeasonRates(bad, 'kw', dayShare) === null, 'kW split that disagrees with the days is not used');
assert(S._billSeasonRates(elecBill('2025-05-29', '2025-06-29', false), 'kwh', dayShare) === null, 'no _chargeParts: null');

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
assert(r.straddle.bills === 1 && r.straddle.byLines === 1 && r.straddle.byDays === 0, 'straddle count (1 by lines)');
assert(r.kwhSummer > 0 && r.kwhWinter > 0, 'summer and winter rates exist');
const noLines = elecBill('2025-05-29', '2025-06-29', false);
const r2 = run(building(P, [noLines]));
assert(r2.straddle.byDays === 1 && r2.kwhSummer > 0 && near(r2.kwhSummer, r2.kwhWinter, 1e-9), 'no lines: one blended rate in both seasons');
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
assert(near(rg.thermRate, 0.6, 1e-3) && near(rg.gasSummer, 0.6, 1e-3) && near(rg.gasWinter, 0.6, 1e-3), 'gas: summer = winter = annual mean');
assert(rg.gasMonthly.length === 12 && near(rg.gasMonthly[0], 0.8, 1e-9) && near(rg.gasMonthly[6], 0.4, 1e-9), 'gas: January 0.80, July 0.40');
assert(near(rg.gasMonthly[3], 0.6, 1e-9), 'gas: a month with no baseline bill takes the annual mean');
assert(r.gasMonthly.length === 0 && r.kwhMonthly.length === 0, 'seasonal utility: no monthly arrays');

console.log('4. measureRateAt');
const rt = (rates, mo) => S.measureRateAt(rates, mo);
assert(rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 5).kwh === 0.1 && rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 4).kwh === 0.05, 'June summer, May winter');
assert(rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 8).summer && !rt({ kwhSummer: 0.1, kwhWinter: 0.05 }, 9).summer, 'Sep summer, Oct winter');
const mr = { gasSummer: 0.6, gasWinter: 0.6, gasMonthly: rg.gasMonthly };
assert(near(rt(mr, 0).gas, 0.8) && near(rt(mr, 6).gas, 0.4), 'gas priced at its own month');
assert(near(rt({ gasSummer: 0.3, gasWinter: 0.5 }, 0).gas, 0.5), 'no monthly array: seasonal rate');

console.log(failed ? 'FAIL ' + failed + ' (passed ' + passed + ')' : 'PASS ' + passed);
process.exit(failed ? 1 : 0);
