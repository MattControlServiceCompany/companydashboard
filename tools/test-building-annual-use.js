// tools/test-building-annual-use.js: buildingAnnualUse (app/utility-data.js), the one reader of the 12-month utility use of a building for reports
// (2026-11-18). SYNTHETIC buildings only; headless bundled Chromium; no network.
// Rules tested: the newest 12 complete bill months; fewer than 12 months, or a commodity with a missing month, gives null (no partial year);
// a building with no gas meter has therms null; a meter in project.scope.meterExcludeIds is still counted (the exclusion is for baselines);
// EUI = computePeriodEUI(computeKBtu(...), 12, sqft); the label ("2025" or "Jun 2024 to May 2025"); estimatedMonthly.
// Run: CH_TMP_ROOT=<scratch> node tools/test-building-annual-use.js   (exit 0 = all pass)
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const { launchBrowser } = require(path.join(ROOT, 'tools', 'launch-browser.js'));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) fails++;
};

(async () => {
  const ctx = await launchBrowser('building-annual-use');
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/supabase|\.netlify|netlify\.app|localhost/, (r) => r.abort());
    await page.goto(pathToFileURL(path.join(ROOT, 'energy-department.html')).href);
    await page.waitForFunction(() => typeof buildingAnnualUse === 'function' && typeof computePeriodEUI === 'function' && typeof billMonth === 'function', null, { timeout: 30000 });

    const r = await page.evaluate(() => {
      // months 'YYYY-MM' from a to z; one bill per month
      const mk = (a, z) => presentedMonthRange(a, z);
      const last = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
      const eBills = (a, z, est) => mk(a, z).map((ym, i) => ({ start: ym + '-01', end: ym + '-' + last(ym), kwh: 1000 + i, totalCost: 100 + i, estimated: !!est }));
      const gBills = (a, z, est) => mk(a, z).map((ym, i) => ({ start: ym + '-01', end: ym + '-' + last(ym), naturalGasTherms: 50 + i, totalCost: 40 + i, estimated: !!est }));
      const bldgs = {};
      const add = (id, sqft, meters) => (bldgs[id] = { id, name: id, sqft, meters });
      const E = (bills) => ({ id: 'e', commodity: 'Electric', bills });
      const G = (bills) => ({ id: 'g', commodity: 'Gas', bills });
      const P = (bills) => ({ id: 'p', commodity: 'Propane', bills });
      // A: Nov 2024 to Dec 2025 (14 months) electric + gas, all estimated
      add('A', 10000, [E(eBills('2024-11', '2025-12', true)), G(gBills('2024-11', '2025-12', true))]);
      add('B11', 10000, [E(eBills('2025-02', '2025-12')), G(gBills('2025-02', '2025-12'))]); // 11 months
      add('C', 5000, [E(eBills('2025-01', '2025-12'))]); // no gas meter
      add('D', 8000, [E(eBills('2024-06', '2025-05')), G(gBills('2024-06', '2025-05'))]); // Jun 2024 to May 2025
      add('E', 8000, [E(eBills('2025-01', '2025-12')), G(gBills('2025-02', '2025-12'))]); // gas lacks January
      add('F', 0, [E(eBills('2025-01', '2025-12'))]); // no floor area
      add('G', 6000, []); // no meters
      // 2026-11-19: gas billed one month behind the electric (electric to Jan 2026, gas to Dec 2025): the window is Jan to Dec 2025, not null
      add('LAG', 7000, [E(eBills('2025-01', '2026-01')), G(gBills('2025-01', '2025-12'))]);
      // 2026-11-19: propane by delivery (3 deliveries), electric every month: propane never makes a month incomplete; gallons in the window summed
      add('PRO', 7000, [E(eBills('2025-01', '2025-12')), P([{ start: '2024-11-01', end: '2024-11-30', gallonsDelivered: 300, totalCost: 600 }, { start: '2025-02-01', end: '2025-02-28', gallonsDelivered: 400, totalCost: 800 }, { start: '2025-10-01', end: '2025-10-31', gallonsDelivered: 250, totalCost: 500 }])]);
      window.getUDBldg = (pid, bid) => bldgs[bid];
      const out = {};
      const sumE = (a, z) => mk(a, z).reduce((s, ym, i) => s + 1000 + i, 0);
      out.A = buildingAnnualUse('p', 'A');
      // the newest 12 of 14 months are Jan to Dec 2025: bill index 2..13
      out.expA = {
        kwh: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].reduce((s, i) => s + 1000 + i, 0),
        therms: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].reduce((s, i) => s + 50 + i, 0),
        cost: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].reduce((s, i) => s + 100 + i + 40 + i, 0),
      };
      out.kBtuA = computeKBtu(out.A.kwh, out.A.therms, 0);
      out.euiA = computePeriodEUI(out.kBtuA, 12, 10000);
      out.B11 = buildingAnnualUse('p', 'B11');
      out.C = buildingAnnualUse('p', 'C');
      out.euiC = computePeriodEUI(computeKBtu(out.C.kwh, 0, 0), 12, 5000);
      out.D = buildingAnnualUse('p', 'D');
      out.E = buildingAnnualUse('p', 'E');
      out.F = buildingAnnualUse('p', 'F');
      out.G = buildingAnnualUse('p', 'G');
      out.missing = buildingAnnualUse('p', 'nope');
      out.LAG = buildingAnnualUse('p', 'LAG');
      out.PRO = buildingAnnualUse('p', 'PRO');
      out.byPRO = buildingUseByYear('p', 'PRO');
      out.sum12 = mk('2025-01', '2025-12').reduce((s, ym, i) => s + 1000 + i, 0);
      // buildingUseByYear: H has 2022 (complete), 2023 (gas lacks March: partial, left out), 2024 (complete), 2025 (Jan to Oct only: partial)
      add('H', 9000, [E(eBills('2022-01', '2022-12').concat(eBills('2023-01', '2023-12'), eBills('2024-01', '2024-12'), eBills('2025-01', '2025-10'))), G(gBills('2022-01', '2022-12').concat(gBills('2023-01', '2023-02'), gBills('2023-04', '2023-12'), gBills('2024-01', '2024-12'), gBills('2025-01', '2025-10')))]);
      add('I', 4000, [E(eBills('2023-01', '2024-12'))]); // electric only, 2 years
      out.byH = buildingUseByYear('p', 'H');
      out.byI = buildingUseByYear('p', 'I');
      out.byG = buildingUseByYear('p', 'G');
      out.byMissing = buildingUseByYear('p', 'nope');
      out.byA = buildingUseByYear('p', 'A'); // 2024: Nov, Dec only (partial); 2025 complete
      out.byC = buildingUseByYear('p', 'C');
      out.annualH = buildingAnnualUse('p', 'H');
      // every meter excluded from the baseline: the same answer
      window.isBaselineExcluded = () => true;
      out.AExcl = buildingAnnualUse('p', 'A');
      return out;
    });

    const A = r.A;
    ok(A && A.months === 12 && A.startMonth === '2025-01' && A.endMonth === '2025-12', 'newest 12 of 14 months: ' + JSON.stringify(A && [A.months, A.startMonth, A.endMonth]));
    ok(A.label === '2025', 'Jan to Dec of one year is labeled "2025": ' + A.label);
    ok(A.kwh === r.expA.kwh && A.therms === r.expA.therms && A.cost === r.expA.cost, 'kWh, therms and cost are the sums of the 12 months: ' + JSON.stringify([A.kwh, A.therms, A.cost]) + ' vs ' + JSON.stringify(r.expA));
    ok(A.sqft === 10000 && A.hasGas === true, 'floor area and gas flag');
    ok(A.eui === r.euiA && Math.abs(A.kBtu - r.kBtuA) < 1e-9, 'EUI equals computePeriodEUI(computeKBtu(...), 12, sqft): ' + A.eui);
    ok(Math.abs(A.costPerSqft - A.cost / 10000) < 1e-9, 'cost per ft2');
    ok(A.estimatedMonthly === true, 'every bill estimated: estimatedMonthly true');
    ok(r.B11 === null, 'only 11 bill months: null (no partial year)');
    ok(r.C && r.C.hasGas === false && r.C.therms === null, 'no gas meter: therms null, hasGas false');
    ok(r.C.eui === r.euiC, 'no gas meter: EUI from kWh only');
    ok(r.C.estimatedMonthly === false, 'bills not estimated: estimatedMonthly false');
    ok(r.D && r.D.label === 'Jun 2024 to May 2025' && r.D.startMonth === '2024-06' && r.D.endMonth === '2025-05', 'a window that is not a calendar year is labeled by its months: ' + (r.D && r.D.label));
    ok(r.E === null, 'a gas meter with a missing month in the window: null');
    ok(r.F && r.F.eui === null && r.F.costPerSqft === null && r.F.kwh > 0, 'no floor area: EUI and cost per ft2 null, use still returned');
    ok(r.G === null, 'no meters: null');
    ok(r.missing === null, 'unknown building: null');
    ok(r.LAG && r.LAG.startMonth === '2025-01' && r.LAG.endMonth === '2025-12' && r.LAG.kwh === r.sum12, 'gas one month behind electric: the window ends at the newest month with both (Jan to Dec 2025), not null: ' + JSON.stringify(r.LAG && [r.LAG.startMonth, r.LAG.endMonth, r.LAG.kwh]));
    // 400 + 250 gallons delivered in Jan to Dec 2025 (the Nov 2024 delivery is outside); electric 12 months
    ok(r.PRO && r.PRO.endMonth === '2025-12' && r.PRO.propaneGal === 650 && r.PRO.kwh === r.sum12, 'propane by delivery: the year is complete and the gallons in the window are summed (650): ' + JSON.stringify(r.PRO && [r.PRO.endMonth, r.PRO.propaneGal]));
    ok(r.byPRO.length === 1 && r.byPRO[0].year === 2025 && r.byPRO[0].gal === 650, 'by year: propane deliveries do not make a year partial');
    ok(r.AExcl && JSON.stringify(r.AExcl) === JSON.stringify(r.A), 'meters excluded from the baseline are still counted');
    ok(r.byH.length === 2 && r.byH[0].year === 2022 && r.byH[1].year === 2024, 'by year: only the complete years, oldest first: ' + JSON.stringify(r.byH.map((y) => y.year)));
    ok(r.byH[0].kwh === Array.from({ length: 12 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0) && r.byH[0].therms === Array.from({ length: 12 }, (_, i) => 50 + i).reduce((a, b) => a + b, 0) && r.byH[0].hasGas === true, 'by year: kWh and therms are the sums of the 12 months: ' + JSON.stringify(r.byH[0]));
    ok(r.byI.length === 2 && r.byI[0].therms === null && r.byI[0].hasGas === false && r.byI[0].kwh > 0 && r.byI[0].cost > 0, 'by year: electric only gives therms null, hasGas false');
    ok(r.byA.length === 1 && r.byA[0].year === 2025 && r.byA[0].kwh === r.A.kwh && r.byA[0].therms === r.A.therms && r.byA[0].cost === r.A.cost, 'by year: a complete year equals buildingAnnualUse of the same months');
    ok(r.byC.length === 1 && r.byC[0].kwh === r.C.kwh, 'by year: one year gives one entry');
    ok(r.byG.length === 0 && r.byMissing.length === 0, 'by year: no meters or unknown building gives an empty list');
    ok(r.annualH && r.annualH.startMonth === '2024-11' && r.annualH.endMonth === '2025-10' && r.annualH.label === 'Nov 2024 to Oct 2025', 'buildingAnnualUse is unchanged: newest 12 months, a partial calendar year does not change it: ' + (r.annualH && r.annualH.label));
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
