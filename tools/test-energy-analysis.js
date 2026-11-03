// tools/test-energy-analysis.js - kWh vs kW analysis math (computations/energy-analysis.js). SYNTHETIC data only.
// Checks: load factor, equivalent full-load hours, baseload per day, use per degree day, percent change,
// month grouping (two meters), same-months comparison, the one-line reading, and that getEnergyAnalysis
// reads bills through billMonth / calcDays / resolveGasUsageTherms and skips excluded meters.
// Run: node tools/test-energy-analysis.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

// ---- load the two computation files into one context, with stubs for the app functions they call ----
const ctx = { console };
vm.createContext(ctx);
const days = (s, e, incl) => Math.round((Date.parse(e) - Date.parse(s)) / 86400000) + (incl ? 1 : 0);
ctx.calcDays = days;
ctx.billMonth = (bill) => String(bill.end).slice(0, 7); // stub: the month of the bill end
ctx.resolveGasUsageTherms = (bill) => parseFloat(bill.therms) || 0;
ctx.isBaselineExcluded = (projId, id) => id === 'm-excl';
ctx.isCalcCommodity = () => true;
ctx.getWeatherForBuilding = () => ({
  byYm: { '2025-01': { hdd: 800, cdd: 0 }, '2025-07': { hdd: 0, cdd: 300 }, '2026-01': { hdd: 700, cdd: 0 }, '2026-07': { hdd: 0, cdd: 360 } },
});
vm.runInContext(fs.readFileSync(path.join(REPO, 'computations', 'hvac-enduse.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'computations', 'energy-analysis.js'), 'utf8'), ctx);

// ---- 1. plain math ----
ok(near(ctx.eaLoadFactor(300000, 1000, 720), 300000 / (1000 * 720)), 'load factor = kWh / (kW x hours)');
ok(near(ctx.eaLoadFactor(432000, 1000, 720), 0.6), 'load factor 0.6');
ok(ctx.eaLoadFactor(0, 1000, 720) === null && ctx.eaLoadFactor(100, 0, 720) === null && ctx.eaLoadFactor(100, 10, 0) === null, 'load factor null when a part is 0');
ok(ctx.eaLoadFactor(null, 10, 10) === null && ctx.eaLoadFactor(NaN, 10, 10) === null, 'load factor null when a part is missing');
ok(near(ctx.eaFullLoadHours(300000, 1000), 300), 'full-load hours = kWh / kW');
ok(ctx.eaFullLoadHours(300000, 0) === null && ctx.eaFullLoadHours(0, 10) === null, 'full-load hours null when kW or kWh is 0');
ok(near(ctx.eaPerDegreeDay(90000, 300), 300), 'kWh per cooling degree day');
ok(ctx.eaPerDegreeDay(90000, 0) === null && ctx.eaPerDegreeDay(90000, null) === null, 'per degree day null when no degree days');
const N = ctx.EA_MIN_DEGREE_DAYS;
ok(N === 50, 'minimum degree days is 50');
ok(ctx.eaPerDegreeDay(90000, N - 1) === null, 'per degree day null below the minimum');
ok(near(ctx.eaPerDegreeDay(90000, N), 90000 / N) && near(ctx.eaPerDegreeDay(90000, N + 1), 90000 / (N + 1)), 'per degree day computed at and above the minimum');
const lowMonths = [{ kwh: 100000, cdd: 300, therms: 5000, hdd: 500 }, { kwh: 700000, cdd: 10, therms: 900, hdd: 20 }];
const lowSum = ctx.eaYearSummary(lowMonths, [0, 1], [0]);
ok(near(lowSum.kwhPerCdd, 100000 / 300) && near(lowSum.thermsPerHdd, 5000 / 500), 'same-months ratio leaves out months below the minimum (both kWh and degree days)');
ok(near(ctx.eaPctChange(118, 100), 0.18) && near(ctx.eaPctChange(80, 100), -0.2), 'percent change');
ok(ctx.eaPctChange(5, 0) === null, 'percent change null when the earlier value is 0');

// ---- 2. baseload = lowest month in kWh per day (month length does not matter) ----
const bl = ctx.eaBaseloadPerDay([
  { mo: 0, kwh: 31000, days: 31 }, // 1000 / day
  { mo: 1, kwh: 25200, days: 28 }, // 900 / day  <- lowest per day, not the lowest kWh
  { mo: 2, kwh: 62000, days: 31 },
  { mo: 3, kwh: 0, days: 30 }, // no use: not a candidate
]);
ok(bl && near(bl.perDay, 900) && bl.mo === 1 && bl.kwh === 25200 && bl.days === 28, 'baseload picks the lowest kWh per day (Feb 900)');
ok(ctx.eaBaseloadPerDay([]) === null && ctx.eaBaseloadPerDay([{ mo: 0, kwh: 100, days: 0 }]) === null, 'baseload null with no usable month');

// ---- 3. a building month from two meters: kWh and kW add, hours are weighted by kW ----
const two = ctx.eaMonthFromMeterParts([
  { kwh: 100000, kw: 200, hours: 720 },
  { kwh: 50000, kw: 100, hours: 744 },
]);
ok(two.kwh === 150000 && two.kw === 300, 'two meters: kWh and kW add');
ok(near(two.kwHours, 200 * 720 + 100 * 744), 'two meters: kW x hours add');
ok(near(ctx.eaLoadFactor(two.kwh, two.kw, two.hours), 150000 / (200 * 720 + 100 * 744)), 'two meters: load factor = total kWh / sum of (kW x hours)');
const none = ctx.eaMonthFromMeterParts([]);
ok(none.kwh === 0 && none.hours === 0 && none.hasElec === false, 'no meters: empty month');

// ---- 4. months label ----
ok(ctx.eaMonthsLabel([0, 1, 2, 3]) === 'Jan to Apr', 'run of months is "Jan to Apr"');
ok(ctx.eaMonthsLabel([0, 2, 3]) === 'Jan, Mar, Apr', 'broken run is listed');
ok(ctx.eaMonthsLabel([5]) === 'Jun' && ctx.eaMonthsLabel([]) === '', 'one month / none');

// ---- 5. getEnergyAnalysis on a synthetic building (bills read through billMonth, calcDays, gas rule) ----
const bill = (s, e, kwh, kw) => ({ start: s, end: e, kwh: kwh, demandKW: kw });
const b = {
  id: 'b1',
  meters: [
    {
      id: 'm-e',
      commodity: 'Electric',
      inclusive: true,
      bills: [
        bill('2025-01-01', '2025-01-31', 300000, 1000), // 31 days (inclusive) = 744 hours
        bill('2025-07-01', '2025-07-31', 450000, 1200),
        bill('2026-01-01', '2026-01-31', 360000, 1000), // same peak, more kWh
        bill('2026-07-01', '2026-07-31', 540000, 1200),
      ],
    },
    { id: 'm-g', commodity: 'Gas', inclusive: true, bills: [{ start: '2025-01-01', end: '2025-01-31', therms: 8000 }, { start: '2026-01-01', end: '2026-01-31', therms: 7000 }] },
    { id: 'm-excl', commodity: 'Electric', inclusive: true, bills: [bill('2025-01-01', '2025-01-31', 999999, 9999)] },
  ],
};
const ea = ctx.getEnergyAnalysis('p1', b);
ok(JSON.stringify(Array.from(ea.years)) === '[2025,2026]', 'years found: 2025 and 2026');
const j25 = ea.byYear[2025].months[0];
ok(j25.kwh === 300000 && j25.kw === 1000 && j25.hours === 31 * 24, 'Jan 2025: kWh, kW and 31 days x 24 hours (excluded meter ignored)');
ok(near(ctx.eaLoadFactor(j25.kwh, j25.kw, j25.hours), 300000 / (1000 * 744)), 'Jan 2025 load factor from the gathered month');
ok(j25.hdd === 800 && j25.cdd === 0 && j25.therms === 8000 && j25.hasGas, 'Jan 2025: degree days from the weather and gas therms from the gas rule');
ok(ea.hasGas === true, 'building has gas');
ok(ea.byYear[2026].months[6].cdd === 360, 'Jul 2026 cooling degree days');

// ---- 6. same-months comparison and the reading ----
const S = ctx.eaCommonMonths(ea.byYear[2026].months, ea.byYear[2025].months, (m) => m && m.kwh > 0 && m.kw > 0);
ok(JSON.stringify(Array.from(S)) === '[0,6]', 'months in both years: Jan and Jul');
const prev = ctx.eaYearSummary(ea.byYear[2025].months, S, [0]);
const cur = ctx.eaYearSummary(ea.byYear[2026].months, S, [0]);
ok(prev.kwh === 750000 && cur.kwh === 900000, 'summary kWh over the shared months');
ok(prev.peakKw === 1200 && cur.peakKw === 1200 && cur.peakMo === 6, 'summary peak kW (highest month)');
ok(near(prev.fullLoadHours, 750000 / 1200) && near(cur.fullLoadHours, 900000 / 1200), 'summary full-load hours = total kWh / peak kW');
ok(near(cur.loadFactor, 900000 / (1200 * (744 * 2))), 'summary load factor = total kWh / (peak kW x total hours)');
ok(cur.baseload && near(cur.baseload.perDay, 360000 / 31) && cur.baseload.mo === 0, 'summary baseload = lowest month kWh per day (Jan 2026)');
ok(near(prev.kwhPerCdd, 450000 / 300) && near(cur.kwhPerCdd, 540000 / 360), 'summary kWh per cooling degree day uses months with cooling degree days only');
ok(near(prev.thermsPerHdd, 8000 / 800) && near(cur.thermsPerHdd, 7000 / 700), 'summary therms per heating degree day');
const text = ctx.eaReadingText(2026, 2025, cur, prev, 'Jan, Jul');
ok(text === 'Same peak kW, +20% full-load hours, +20% kWh in 2026 vs 2025 (Jan, Jul).', 'reading says only what the numbers show: ' + text);
ok(ctx.eaReadingText(2026, 2025, null, null, '') === 'Not enough months in both years to compare.', 'reading with no data');
const down = ctx.eaReadingText(2026, 2025, { peakKw: 900, fullLoadHours: 1000, kwh: 900000 }, { peakKw: 1000, fullLoadHours: 1000, kwh: 1000000 }, 'Jan to Sep');
ok(down === '-10% peak kW, same full-load hours, -10% kWh in 2026 vs 2025 (Jan to Sep).', 'reading with a decrease: ' + down);

const page = fs.readFileSync(path.join(REPO, 'app', 'graphics-setpoints.js'), 'utf8');
// ---- 8. Where the energy goes: parts of the yearly bill totals (computeHvacEnduse) ----
// Gas by month (therms): three lowest months 500, 550, 600 -> baseload 550. Total = real sum of the 12 months.
const GAS = [9000, 8000, 5000, 2500, 1200, 600, 500, 550, 900, 2500, 5500, 8500];
const KWH = [50000, 48000, 47000, 52000, 60000, 80000, 95000, 92000, 70000, 54000, 46000, 49000];
const KW = [120, 118, 115, 130, 150, 190, 210, 205, 170, 140, 116, 119];
const en = ctx.computeHvacEnduse(KWH, KW, GAS);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const base3 = (a) => a.slice().sort((x, y) => x - y).slice(0, 3).reduce((x, y) => x + y, 0) / 3;
const bg = base3(GAS);
ok(near(bg, 550) && near(en.baseloadGas, 550), 'gas baseload = average of the 3 lowest months (550)');
ok(near(en.totalGas, sum(GAS)), 'totalGas is the real sum of the monthly gas bills (' + sum(GAS) + ')');
ok(near(en.heatingTherms, sum(GAS.map((v) => Math.max(0, v - bg)))), 'heating therms = sum of use above the baseload');
ok(near(en.yearRoundGas, sum(GAS.map((v) => Math.min(v, bg)))), 'year-round gas = sum of use at or below the baseload');
ok(near(en.heatingTherms + en.yearRoundGas, en.totalGas, 1e-6), 'heating + year-round = total (gas)');
ok(near(en.heatingTherms / en.totalGas, en.heatingPct), 'heating share = heating / real total');
const be = base3(KWH);
ok(near(en.totalKwh, sum(KWH)) && near(en.coolingKwh + en.yearRoundKwh, en.totalKwh, 1e-6), 'electric: total is the real sum and cooling + year-round = total');
ok(near(en.yearRoundKwh, sum(KWH.map((v) => Math.min(v, be)))), 'year-round kWh = sum of use at or below the baseload');
ok(near(en.coolingKwh / en.totalKwh, en.coolingPct), 'cooling share = cooling / real total');
ok(near(en.peakKw, 210) && near(en.winterDemandBase, (119 + 120 + 118) / 3), 'peak kW 210; winter level = average of Dec, Jan, Feb');
ok(near(en.coolingDemandKw, 210 - (119 + 120 + 118) / 3) && near(en.coolingDemandKw + en.winterDemandBase, en.peakKw), 'cooling kW + winter kW = summer peak kW');
// a month with no bill (null) is not in the total, and fewer than 6 months gives no split
const few = ctx.computeHvacEnduse(KWH.map((v, i) => (i < 5 ? v : null)), KW, GAS.map((v, i) => (i < 5 ? v : null)));
ok(few.gasValid === false && few.totalGas === 0 && few.yearRoundGas === 0, 'under 6 months of gas: no split, totals stay 0');
const gaps = ctx.computeHvacEnduse(KWH, KW, GAS.map((v, i) => (i === 3 ? null : v)));
ok(near(gaps.totalGas, sum(GAS) - GAS[3]), 'a month with no bill is left out of the total');
// the page builds the table from those fields only (no private percent or total)
ok(/r\.totalGas/.test(page) && /r\.yearRoundGas/.test(page) && /r\.totalKwh/.test(page) && /r\.yearRoundKwh/.test(page), 'page table reads totalGas / yearRoundGas / totalKwh / yearRoundKwh from computeHvacEnduse');
ok(/Where the energy goes/.test(page) && !/HVAC End-Use Estimate —/.test(page), 'page box is titled Where the energy goes');
ok(/\$\{pct\(r\.heatingTherms, r\.totalGas\)\} of gas goes to heating\./.test(page), 'reading line says the heating share of gas');

// ---- 7. every function has one definition (no private copy of the rule in the page file) ----
ok(!/function\s+\w*[lL]oadFactor\w*\s*\(/.test(page), 'page file has no load factor function of its own');
ok(/eaLoadFactor\(/.test(page) && /eaFullLoadHours\(/.test(page) && /eaBaseloadPerDay|eaYearSummary\(/.test(page), 'page file reads the shared functions');
ok(/energy-analysis\.js/.test(fs.readFileSync(path.join(REPO, 'energy-department.html'), 'utf8')), 'energy-department.html loads computations/energy-analysis.js');

console.log('energy-analysis: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
