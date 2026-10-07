// tools/test-perf-table-equals-savings.js - WP-04 acceptance test (math-02 H1, H2, H3, H12, D1, D3, D6, M1, M14, D-9, D-10, L1, L4, L7).
// Run: node tools/test-perf-table-equals-savings.js
// SYNTHETIC data only. Loads the REAL repo files into a vm sandbox.
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.005 : tol);

function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const rdOpt = (rel) => (fs.existsSync(path.join(REPO, rel)) ? rd(rel) : '');

function build(projects) {
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  const pre = [
    'var projects = ' + JSON.stringify(projects) + ';',
    'var udSelProjId = 1;',
    'var _bldg = { id: "b1", meters: [] };',
    'var __store = {}; function sget(k, d){ return k in __store ? __store[k] : d; }',
    'function sset(k, v){ __store[k] = v; }',
    'function getWeatherForBuilding(){ return { byYm: null, cache: [] }; }',
    'function getUDBldg(){ return _bldg; }',
    'function _rptUnit(s){ return s; }',
    loadFn(REPO + '/app/utility-data.js', '_fixISO'),
    loadFn(REPO + '/app/utility-data.js', '_parseISO'),
    loadFn(REPO + '/app/utility-data.js', 'calcDays'),
  ].join('\n');
  const files = [
    'lib/formatting.js',
    'lib/date-helpers.js',
    'computations/regression.js',
    'computations/rates.js',
    'computations/normalization.js',
    'computations/savings.js',
    'lib/perf-table.js',
  ];
  vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
  return sb;
}
const ev = (sb, e) => vm.runInContext(e, sb);
const ld = (y, m) => new Date(y, m, 0).getDate();
const p2 = (n) => String(n).padStart(2, '0');
const mb = (y, m, f) => Object.assign({ start: y + '-' + p2(m) + '-01', end: y + '-' + p2(m) + '-' + p2(ld(y, m)) }, f);
const blMonths = (y) => Array.from({ length: 12 }, (_, i) => y + '-' + p2(i + 1));
const PROJ = [{ id: 1, sa: 'SA-1', name: 'T' }];
// parse table cells of every <tr>
const cells = (html) =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((r) =>
    [...r[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => c[1].replace(/<[^>]+>/g, '')),
  );
const money = (s) => {
  const neg = /\u2212|-/.test(s);
  const v = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(v) ? NaN : neg ? -v : v;
};
const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// -- 1. gas bills with only naturalGasTherms: table $ == getMeterSavings $ (H1, D1) ---------------
(function () {
  const sb = build(PROJ);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(mb(2024, m, { naturalGasTherms: '100', gasCharge: '100', totalGasRate: '1.00000', totalCost: '110' }));
  for (let m = 1; m <= 3; m++)
    bills.push(mb(2025, m, { naturalGasTherms: '50', gasCharge: '50', totalGasRate: '1.00000', totalCost: '55' }));
  sb.M = { id: 'g1', commodity: 'Gas', inclusive: true, bills, baseline: { months: blMonths(2024) } };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'report', projId:1, bldgId:'b1'})");
  assert(near(sumOf(s.byYM), 150), '1: getMeterSavings gas total is 150, got ' + sumOf(s.byYM));
  assert(p.rows.length === 3, '1: three rows');
  p.rows.forEach((r) =>
    assert(
      near(r.savings, s.byYM[r.ym]),
      '1: row ' + r.ym + ' equals byYM (' + r.savings + ' vs ' + s.byYM[r.ym] + ')',
    ),
  );
  assert(near(p.totals.savings, sumOf(s.byYM)), '1: perf total equals byYM total, got ' + p.totals.savings);
})();

// -- 2. Total row foots to the shown rows (H2) ---------------------------------------------------
(function () {
  const sb = build(PROJ);
  const bills = [];
  const ok = { totalKwhRate: '0.08000', demandKW: '100', billedKW: '100', kwCost: '500', totalKwRate: '5' };
  for (let m = 1; m <= 12; m++)
    bills.push(mb(2024, m, Object.assign({ kwh: '10000', totalCost: '1000', kwhCost: '800' }, ok)));
  bills.push(mb(2025, 1, Object.assign({ kwh: '8000', totalCost: '700', kwhCost: '640' }, ok)));
  bills.push(mb(2025, 2, { kwh: '7000', totalCost: '0', demandKW: '100', billedKW: '100' })); // no rate, no cost: false zero
  bills.push(mb(2025, 3, Object.assign({ kwh: '8000', totalCost: '700', kwhCost: '640' }, ok)));
  sb.M = { id: 'x', commodity: 'Electric', inclusive: true, bills, baseline: { months: blMonths(2024) } };
  ['report', 'tab'].forEach((mode) => {
    const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'" + mode + "', projId:1, bldgId:'b1'})");
    const rows = cells(p.html);
    const data = rows.slice(1).filter((r) => r.length > 2 && !/^Total$/i.test(r[0]));
    const tot = rows.find((r) => /^Total$/i.test(r[0]));
    const shown = data.filter((r) => !/Rate unavailable/.test(r.join(' ')));
    const col = (i) => shown.reduce((s, r) => s + parseFloat(r[i].replace(/[^0-9.]/g, '')), 0);
    assert(shown.length === 2, mode + ' 2: two rows shown, got ' + shown.length);
    assert(
      tot && near(parseFloat(tot[1]), col(1), 0.5),
      mode + ' 2: Days total = sum of shown rows (' + (tot && tot[1]) + ' vs ' + col(1) + ')',
    );
    assert(
      tot && near(parseFloat(tot[3].replace(/[^0-9.]/g, '')), col(3), 0.5),
      mode + ' 2: Actual kWh total = sum of shown rows (' + (tot && tot[3]) + ' vs ' + col(3) + ')',
    );
    const lastCol = tot ? tot.length - 1 : 0;
    const dollarSum = shown.reduce((s, r) => s + money(r[lastCol]), 0);
    assert(
      tot && near(money(tot[lastCol]), dollarSum, 0.02),
      mode + ' 2: Total $ = sum of shown row $ (' + (tot && tot[lastCol]) + ' vs ' + dollarSum.toFixed(2) + ')',
    );
  });
})();

// -- 3. $/kW single keeper (H12, D6) -------------------------------------------------------------
(function () {
  const sb = build(PROJ);
  sb.legacy = { billedKW: '100', demandKW: '100', kwCost: '1000', facKWCost: '300' };
  sb.granular = { billedKW: '100', demandKW: '100', demandCharge: '1000', tdcCharge: '0', facilitiesCharge: '300' };
  assert(
    near(ev(sb, 'getStoredKwRate(legacy)'), 13),
    '3: legacy bill $/kW is 13.00, got ' + ev(sb, 'getStoredKwRate(legacy)'),
  );
  assert(near(ev(sb, 'getStoredKwRate(granular)'), 13), '3: granular bill $/kW is 13.00');
  // 2026-10-05 (audit step 5): rates are computed on read, never stored. A stale stored copy loses.
  sb.b1 = Object.assign({ totalKwRate: '99' }, sb.legacy);
  sb.b2 = Object.assign({ totalKwRate: '99' }, sb.granular);
  assert(near(ev(sb, 'getStoredKwRate(b1)'), 13), '3: a stale stored totalKwRate never wins (legacy bill)');
  assert(near(ev(sb, 'getStoredKwRate(b2)'), 13), '3: a stale stored totalKwRate never wins (granular bill)');
  assert(
    !/function ensureBillRates/.test(fs.readFileSync(path.join(REPO, 'computations/rates.js'), 'utf8')),
    '3: ensureBillRates (the stored-rate writer) is gone',
  );
  assert(ev(sb, "getStoredRate(legacy, 'kw')") === 0, "3: getStoredRate has no 'kw' case any more");
})();

// -- 4. kW regression fits on billed kW (H3, D3) -------------------------------------------------
(function () {
  function run(withWeather) {
    const sb = build(PROJ);
    const cdd = [0, 0, 10, 40, 120, 250, 330, 300, 180, 50, 5, 0];
    const bills = [];
    [2024, 2025].forEach((y) => {
      for (let m = 1; m <= 12; m++) {
        bills.push(
          mb(
            y,
            m,
            Object.assign(
              {
                kwh: '50000',
                totalCost: '5000',
                kwhCost: '4000',
                totalKwhRate: '0.08000',
                demandKW: String(200 + 0.5 * cdd[m - 1]),
                billedKW: '450',
                kwCost: '2250',
                totalKwRate: '5.00000',
              },
              withWeather ? { cdd: String(cdd[m - 1]), hdd: '0' } : {},
            ),
          ),
        );
      }
    });
    sb.M = {
      id: 'x',
      commodity: 'Electric',
      inclusive: true,
      bills: bills.slice(0, 15),
      baseline: { months: bills.slice(0, 12).map((b) => b.start.slice(0, 7)) },
    };
    return ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  }
  const a = run(false),
    b = run(true);
  assert(near(sumOf(a.byYM), 0, 0.01), '4: no-weather path saves $0, got ' + sumOf(a.byYM));
  // The kWh part of the weather path moves with days per month (calendar-day basis), so compare only the kW dollars.
  const kwDollars = (b.rows || []).reduce((t, r) => t + r.kwCostSav, 0);
  assert(
    (b.rows || []).length === 3 && near(kwDollars, 0, 0.01),
    '4: regression path books $0 kW savings when billed kW is flat, got ' + kwDollars.toFixed(2),
  );
})();

// -- 5. rate blend ignores bills with no rate (M1) -----------------------------------------------
['Electric', 'Gas'].forEach((commodity) => {
  const sb = build(PROJ);
  const elec = commodity === 'Electric';
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(
      mb(
        2024,
        m,
        elec
          ? {
              kwh: '12000',
              totalCost: '1200',
              kwhCost: '800',
              totalKwhRate: '0.08000',
              demandKW: '100',
              billedKW: '100',
              kwCost: '500',
              totalKwRate: '5',
            }
          : { naturalGasTherms: '1200', therms: '1200', gasCharge: '800', totalGasRate: '0.80000', totalCost: '900' },
      ),
    );
  bills.push({
    start: '2025-02-01',
    end: '2025-02-28',
    ...(elec
      ? {
          kwh: '5000',
          totalCost: '500',
          kwhCost: '500',
          totalKwhRate: '0.10000',
          demandKW: '100',
          billedKW: '100',
          kwCost: '500',
          totalKwRate: '5',
        }
      : { naturalGasTherms: '500', therms: '500', gasCharge: '500', totalGasRate: '1.00000', totalCost: '520' }),
  });
  bills.push({
    start: '2025-02-01',
    end: '2025-02-28',
    ...(elec
      ? {
          kwh: '5000',
          totalCost: '400',
          kwhCost: '400',
          demandKW: '100',
          billedKW: '100',
          kwCost: '500',
          totalKwRate: '5',
        }
      : { naturalGasTherms: '500', therms: '500', gasCharge: '400', totalCost: '420' }),
  });
  sb.M = { id: 'x', commodity, inclusive: true, bills, baseline: { months: blMonths(2024) } };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'report', projId:1, bldgId:'b1'})");
  const row = p.rows.find((r) => r.ym === '2025-02');
  assert(row && near(row.savings, s.byYM['2025-02']), '5 ' + commodity + ': perf row equals byYM');
  // (baseline 12000 or 1200 minus actual 10000 or 1000) x blended rate; blended = mean(0.10, derived 0.08) or mean(1.00, 0.80)
  const expect = elec ? (12000 - 10000) * 0.09 : (1200 - 1000) * 0.9;
  assert(
    near(s.byYM['2025-02'], expect, 0.5),
    '5 ' + commodity + ': blended rate ignores the blank (expect ' + expect + ', got ' + s.byYM['2025-02'] + ')',
  );
});

// -- 6. propane: all-in $/gal, table equals savings (D-9, L4) -------------------------------------
(function () {
  const sb = build(PROJ);
  const d = (y, m, day) => y + '-' + p2(m) + '-' + p2(day);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push({
      start: d(2024, m, 15),
      end: d(2024, m, 15),
      gallonsDelivered: '100',
      totalCost: '230',
      totalPropaneRate: '2.00000',
    });
  for (let m = 1; m <= 4; m++)
    bills.push({
      start: d(2025, m, 15),
      end: d(2025, m, 15),
      gallonsDelivered: '60',
      totalCost: '138',
      totalPropaneRate: '2.00000',
    });
  sb.M = {
    id: 'p1',
    commodity: 'Propane',
    inclusive: true,
    bills,
    baseline: {
      months: [
        '2024-02',
        '2024-03',
        '2024-04',
        '2024-05',
        '2024-06',
        '2024-07',
        '2024-08',
        '2024-09',
        '2024-10',
        '2024-11',
        '2024-12',
        '2025-01',
      ],
    },
  };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'report', projId:1, bldgId:'b1'})");
  assert(p.rows.length > 0, '6: propane table has rows');
  p.rows.forEach((r) => assert(near(r.savings, s.byYM[r.ym]), '6: propane row ' + r.ym + ' equals byYM'));
  assert(
    near(p.totals.savings, sumOf(s.byYM), 0.01),
    '6: propane perf total equals byYM total (' + p.totals.savings + ' vs ' + sumOf(s.byYM) + ')',
  );
  p.rows.forEach((r) => {
    if (r.rawUsage > 0)
      assert(near(r.thermRate, 2.3, 0.0001), '6: propane rate is all-in $2.30/gal, got ' + r.thermRate + ' in ' + r.ym);
  });
})();

// -- 7. electric per-month $ equals byYM, kW columns included (D1) ---------------------------------
(function () {
  const sb = build(PROJ);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(
      mb(2024, m, {
        kwh: '10000',
        kwhCost: '800',
        totalKwhRate: '0.08000',
        totalCost: '1000',
        demandKW: '100',
        billedKW: '110',
        kwCost: '550',
        totalKwRate: '5.00000',
      }),
    );
  for (let m = 1; m <= 4; m++)
    bills.push(
      mb(2025, m, {
        kwh: String(8000 + m * 100),
        kwhCost: '700',
        totalKwhRate: '0.08500',
        totalCost: '900',
        demandKW: '90',
        billedKW: '95',
        kwCost: '522.50', // 522.50 / 95 billed kW = $5.50/kW (rates are computed on read since 2026-10-05)
        totalKwRate: '5.50000',
      }),
    );
  sb.M = { id: 'e1', commodity: 'Electric', inclusive: true, bills, baseline: { months: blMonths(2024) } };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'tab', projId:1, bldgId:'b1'})");
  assert(
    p.rows.length === Object.keys(s.byYM).length && p.rows.length === 4,
    '7: table months equal savings months (' + p.rows.length + ')',
  );
  p.rows.forEach((r) => assert(near(r.savings, s.byYM[r.ym]), '7: row ' + r.ym + ' equals byYM'));
  assert(near(p.totals.savings, sumOf(s.byYM)), '7: total equals byYM total');
  assert((s.rows || []).length === 4, '7: getMeterSavings returns one detail row per month');
  assert(/\$5\.5000</.test(p.html), '7: $/kW shows 4 decimals (was 2)');
})();

// -- 8. project without a service agreement: $ zero, usage columns still shown ----------------------
(function () {
  const sb = build([{ id: 1, sa: '', name: 'T' }]);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(mb(2024, m, { naturalGasTherms: '100', gasCharge: '100', totalGasRate: '1.00000', totalCost: '110' }));
  for (let m = 1; m <= 3; m++)
    bills.push(mb(2025, m, { naturalGasTherms: '50', gasCharge: '50', totalGasRate: '1.00000', totalCost: '55' }));
  sb.M = { id: 'g1', commodity: 'Gas', inclusive: true, bills, baseline: { months: blMonths(2024) } };
  const s = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const p = ev(sb, "buildMeterPerfTableHTML(M, M.bills, true, {mode:'tab', projId:1, bldgId:'b1'})");
  assert(Object.keys(s.byYM).length === 0, '8: no-SA project: byYM stays empty');
  assert(
    p.rows.length === 3 && p.rows.every((r) => r.savings === 0 && r.rawUsage === 50 && r.expUsage === 100),
    '8: no-SA project: rows show usage, $ is 0',
  );
})();

// -- 9. same-commodity meters all feed the building rate (M14) -------------------------------------
(function () {
  const sb = build(PROJ);
  const mk = (id, rate) => ({
    id,
    commodity: 'Electric',
    bills: [1, 2, 3].map((m) => mb(2025, m, { kwh: '1000', kwhCost: String(1000 * rate), totalKwhRate: String(rate) })),
  });
  sb.bl = { id: 'b1', meters: [mk('a', 0.06), mk('b', 0.1)] };
  ev(sb, '_bldg = bl;');
  const r = ev(sb, "computeSeasonalBldgRates(1, 'b1')");
  assert(near(r.kwhWinter, 0.08, 0.00001), '9: winter $/kWh averages both electric meters (0.08), got ' + r.kwhWinter);
})();

// -- 10. cache key (L7) and dead multi-baseline path (D-10) ----------------------------------------
(function () {
  const sb = build([{ id: 1, sa: 'SA-1', name: 'T', normBasis: 'actual' }]);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(mb(2024, m, { naturalGasTherms: '100', gasCharge: '100', totalGasRate: '1.00000', totalCost: '110' }));
  for (let m = 1; m <= 3; m++)
    bills.push(mb(2025, m, { naturalGasTherms: '50', gasCharge: '50', totalGasRate: '1.00000', totalCost: '55' }));
  sb.M = {
    id: 'g1',
    commodity: 'Gas',
    inclusive: true,
    bills,
    baseline: { months: blMonths(2024) },
    baselines: [{ months: blMonths(2024), savingsWindow: { start: '2025-01' } }],
  };
  ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const key = ev(sb, 'M._savingsCacheKey') || '';
  assert(/\|p:1\|/.test(key), '10: cache key holds the project id, got ' + key.slice(0, 60));
  assert(/\|nb:actual\|/.test(key), '10: cache key holds the normalization basis');
  assert(/\|i:/.test(key), '10: cache key holds the inclusive setting');
  assert(ev(sb, 'typeof _getMeterSavingsMulti') === 'undefined', '10: _getMeterSavingsMulti is deleted');
  assert(!fs.existsSync(path.join(REPO, 'computations/baseline-manager.js')), '10: baseline-manager.js is deleted');
})();

// -- 11. one copy of each thing (source guards) -----------------------------------------------------
(function () {
  const perf = rd('lib/perf-table.js'),
    sav = rd('computations/savings.js'),
    reg = rd('computations/regression.js'),
    rates = rd('computations/rates.js');
  assert(
    !/getNormRows|buildMoMap|normMonth\(|getStoredRate|getStoredKwRate|resolveMeterRate/.test(perf),
    '11: perf-table.js has no money math of its own',
  );
  assert(!/ssxx/.test(perf) && !/ssxx/.test(sav), '11: kW regression fit is not copied in perf-table.js or savings.js');
  assert((reg.match(/ssxx/g) || []).length > 0, '11: kW regression fit lives in regression.js');
  const gsr = rates.slice(rates.indexOf('function getStoredRate('), rates.indexOf('function getStoredKwRate('));
  assert(gsr.length > 100 && !/case 'kw':/.test(gsr), '11: getStoredRate has no second $/kW case');
  assert(!/m\.baselines|_getMeterSavingsMulti/.test(sav), '11: savings.js has no multi-baseline path');
})();

// -- 12. normal-weather view: effectiveRows change the prediction, are not cached (Meter Performance tab) ----------
(function () {
  const sb = build(PROJ);
  const cdd = [0, 0, 10, 40, 120, 250, 330, 300, 180, 50, 5, 0];
  const bills = [];
  [2024, 2025].forEach((y) => {
    for (let m = 1; m <= 12; m++) {
      const c = cdd[m - 1];
      bills.push(
        mb(y, m, {
          kwh: String(30000 + 100 * c + (y === 2025 ? 50 : 0)),
          totalCost: '3000',
          kwhCost: '2400',
          totalKwhRate: '0.08000',
          demandKW: '100',
          billedKW: '100',
          kwCost: '500',
          totalKwRate: '5',
          cdd: String(c),
          hdd: '0',
        }),
      );
    }
  });
  sb.M = {
    id: 'x',
    commodity: 'Electric',
    inclusive: true,
    bills: bills.slice(0, 15),
    baseline: { months: bills.slice(0, 12).map((b) => b.start.slice(0, 7)) },
  };
  const plain = ev(sb, "getMeterSavings(M, M.bills, true, 1, 'b1')");
  const keyBefore = ev(sb, 'M._savingsCacheKey');
  const eff = ev(
    sb,
    `(function () {
      var rows = getNormRows(M, M.bills, true, null).map(function (r) {
        var p = Object.assign({}, r, { cdd: (r.cdd || 0) * 2 });
        p.regrBaseline = regressionBaseline(p, M._reg, 'Electric', 'calendar');
        return p;
      });
      return getMeterSavings(M, M.bills, true, 1, 'b1', { effectiveRows: rows });
    })()`,
  );
  assert(plain.rows.length === 3 && eff.rows.length === 3, '12: both calls return three rows');
  assert(
    eff.rows.some((r, i) => Math.abs(r.expUsage - plain.rows[i].expUsage) > 1),
    '12: effectiveRows change the baseline prediction',
  );
  assert(
    ev(sb, 'M._savingsCacheKey') === keyBefore && ev(sb, 'M._savingsCache') === plain,
    '12: an effectiveRows call does not touch the cache',
  );
})();

// -- 13. WP-04b: ONE kW fit, ONE kW basis in the report, parseBillNumber in rates.js (source guards) -------------------
(function () {
  const ud = rd("app/utility-data.js"),
    rep = rd("app/report-engine.js"),
    rates = rd("computations/rates.js");
  assert(
    !/ssxy/.test(ud) && !/_kwReg|_blKwReg/.test(ud),
    "13: utility-data.js has no kW fit of its own",
  );
  assert(
    /computeKwCddRegression\(/.test(ud),
    "13: utility-data.js calls the keeper computeKwCddRegression",
  );
  assert(
    !/kwCur \+= actDemKW/.test(rep),
    "13: report kW Actual is not the metered demandKW",
  );
  assert(
    (rep.match(/kwCur \+= actBilKW/g) || []).length === 2,
    "13: report kW Actual (period and monthly) is billed kW, same as the kW dollars",
  );
  assert(!/\bpf\(/.test(rates), "13: rates.js uses parseBillNumber, not pf(");
})();

// -- 14. WP-04b: meter tables sum to the building total (Meter Performance = getMeterSavings = getBuildingSavingsByYM) ----
(function () {
  const sb = build(PROJ);
  const gas = (id, incl) => {
    const bills = [];
    for (let m = 1; m <= 12; m++)
      bills.push(
        mb(2024, m, {
          naturalGasTherms: "100",
          gasCharge: "100",
          totalCost: "110",
        }),
      );
    for (let m = 1; m <= 6; m++)
      bills.push(
        mb(2025, m, {
          naturalGasTherms: "60",
          gasCharge: "60",
          totalCost: "66",
        }),
      );
    return {
      id,
      commodity: "Gas",
      inclusive: incl,
      bills,
      baseline: { months: blMonths(2024) },
    };
  };
  const elec = {
    id: "e1",
    commodity: "Electric",
    inclusive: true,
    bills: [].concat(
      Array.from({ length: 12 }, (_, i) =>
        mb(2024, i + 1, {
          kwh: "50000",
          kwhCost: "4000",
          totalKwhRate: "0.08000",
          totalCost: "5000",
        }),
      ),
      Array.from({ length: 6 }, (_, i) =>
        mb(2025, i + 1, {
          kwh: "40000",
          kwhCost: "3200",
          totalKwhRate: "0.08000",
          totalCost: "4000",
        }),
      ),
    ),
    baseline: { months: blMonths(2024) },
  };
  sb.BL = {
    id: "b1",
    name: "B",
    meters: [gas("g1", true), gas("g2", false), elec],
  };
  ev(
    sb,
    "_bldg = BL; function getUDBldgs(){ return [BL]; } function isBaselineExcluded(){ return false; }",
  );
  const bySum = {};
  [0, 1, 2].forEach((i) => {
    const t = ev(
      sb,
      "buildMeterPerfTableHTML(BL.meters[" +
        i +
        "], BL.meters[" +
        i +
        "].bills, BL.meters[" +
        i +
        "].inclusive !== false, {mode:'report', projId:1, bldgId:'b1'})",
    );
    t.rows.forEach((r) => (bySum[r.ym] = (bySum[r.ym] || 0) + r.savings));
  });
  const bld = ev(sb, "getBuildingSavingsByYM(BL, 1)");
  Object.keys(bySum).forEach((ym) =>
    assert(
      near(bySum[ym], bld[ym] || 0, 0.01),
      "14: " +
        ym +
        " meter tables " +
        bySum[ym].toFixed(2) +
        " == building " +
        (bld[ym] || 0).toFixed(2),
    ),
  );
  assert(
    Object.keys(bySum).length === 6,
    "14: six months compared, got " + Object.keys(bySum).length,
  );
  assert(
    Math.abs(sumOf(bySum)) > 1,
    "14: the test building has non-zero savings",
  );
})();

// -- 15. WP-04b: a presented (locked) period never changes; the tables still recompute --------------------------------
(function () {
  const sb = build(PROJ);
  const bills = [];
  for (let m = 1; m <= 12; m++)
    bills.push(
      mb(2024, m, {
        naturalGasTherms: "100",
        gasCharge: "100",
        totalCost: "110",
      }),
    );
  for (let m = 1; m <= 6; m++)
    bills.push(
      mb(2025, m, { naturalGasTherms: "60", gasCharge: "60", totalCost: "66" }),
    );
  sb.BL = {
    id: "b1",
    name: "B",
    meters: [
      {
        id: "g1",
        commodity: "Gas",
        inclusive: true,
        bills,
        baseline: { months: blMonths(2024) },
      },
    ],
  };
  ev(
    sb,
    "_bldg = BL; function getUDBldgs(){ return [BL]; } function isBaselineExcluded(){ return false; }",
  );
  const q1 = JSON.stringify(["2025-01", "2025-02", "2025-03"]),
    q2 = JSON.stringify(["2025-04", "2025-05", "2025-06"]);
  const tot = (q) =>
    ev(
      sb,
      "totalSavingsWithPresented(1, " +
        q +
        ", { b1: getBuildingSavingsByYM(BL, 1) })",
    ).total;
  const before2 = tot(q2);
  const rec = ev(
    sb,
    "savePresentedRecord({ projectId: 1, periodStart: '2025-01', periodEnd: '2025-03', presentedAt: '2025-04-05T12:00:00Z', documentName: 'Q1', totalDollars: 111, buildings: { b1: { dollars: 111 } } })",
  );
  assert(rec.ok, "15: presented record saved");
  ev(
    sb,
    "BL.meters[0].bills[12].naturalGasTherms = '10'; BL.meters[0].bills[15].naturalGasTherms = '10'; BL.meters[0]._savingsCache = null;",
  );
  assert(
    near(tot(q1), 111, 0.001),
    "15: presented Q1 stays at the printed 111 after a bill edit, got " +
      tot(q1),
  );
  assert(
    !near(tot(q2), before2, 0.5),
    "15: unpresented Q2 moves with the bill edit",
  );
  const t = ev(
    sb,
    "buildMeterPerfTableHTML(BL.meters[0], BL.meters[0].bills, true, {mode:'report', projId:1, bldgId:'b1'})",
  );
  const s = ev(
    sb,
    "getMeterSavings(BL.meters[0], BL.meters[0].bills, true, 1, 'b1')",
  );
  t.rows.forEach((r) =>
    assert(
      near(r.savings, s.byYM[r.ym]),
      "15: meter table row " + r.ym + " still equals getMeterSavings",
    ),
  );
})();
console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
