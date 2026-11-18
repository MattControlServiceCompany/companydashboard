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
      // A: Nov 2024 to Dec 2025 (14 months) electric + gas, all estimated
      add('A', 10000, [E(eBills('2024-11', '2025-12', true)), G(gBills('2024-11', '2025-12', true))]);
      add('B11', 10000, [E(eBills('2025-02', '2025-12')), G(gBills('2025-02', '2025-12'))]); // 11 months
      add('C', 5000, [E(eBills('2025-01', '2025-12'))]); // no gas meter
      add('D', 8000, [E(eBills('2024-06', '2025-05')), G(gBills('2024-06', '2025-05'))]); // Jun 2024 to May 2025
      add('E', 8000, [E(eBills('2025-01', '2025-12')), G(gBills('2025-02', '2025-12'))]); // gas lacks January
      add('F', 0, [E(eBills('2025-01', '2025-12'))]); // no floor area
      add('G', 6000, []); // no meters
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
    ok(r.AExcl && JSON.stringify(r.AExcl) === JSON.stringify(r.A), 'meters excluded from the baseline are still counted');
    ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
