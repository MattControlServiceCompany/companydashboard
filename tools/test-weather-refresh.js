#!/usr/bin/env node
// tools/test-weather-refresh.js -- 2026-10-27. SYNTHETIC data only (invented ZIPs, invented degree days).
// Owner: computations/weather-refresh.js (the ONE weather fetch + append rule).
// Cases: running totals -> single months; refresh only when newest stored month < last calendar month;
// stored months never change; unpublished month stays absent (never 0); current month never saved;
// FROZEN BASELINE: appending Sep 2026 weather changes no baseline-period row and no baseline regression.
// CONTRACTED PROJECT: filling weather (stale ZIP, and empty ZIP back-filled from 2020) changes no stored baseline.
// Run: node tools/test-weather-refresh.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const REPO = process.env.REPO || path.join(__dirname, '..');
const sb = { console, Math, Date, JSON, parseFloat, parseInt, Number, Promise, Set, Map };
vm.createContext(sb);
[
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'computations/physics.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/csc.js',
  'computations/weather-refresh.js',
].forEach((f) => vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sb, { filename: f }));
// _fixISO + _parseISO + calcDays (the one day-count function) lives in app/utility-data.js; load only that function's source.
const udSrc = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8').split('\r\n').join('\n');
const cdStart = udSrc.indexOf('function _fixISO(');
const cdEnd = udSrc.indexOf('\n}\n', udSrc.indexOf('function calcDays(')) + 3;
vm.runInContext(udSrc.slice(cdStart, cdEnd), sb);
vm.runInContext("var udSelProjId = 'p1'; function getProjectNormBasis() { return 'calendar'; }", sb); // stubs for the app globals getNormRows reads
const W = vm.runInContext(
  '({wxLastCompleteYm, wxNeedsRefresh, wxCumulativeToMonthly, wxRowsFromBlocks, wxMergeAppend, wxRefreshZip, wxProjectZips, getNormRows, computeMeterRegression, getProjectContract})',
  sb,
);
let n = 0;
const ok = (name, fn) => {
  fn();
  n++;
  console.log('ok  ' + name);
};
const J = (v) => JSON.parse(JSON.stringify(v));
const NOW = new Date(2026, 9, 27); // 27 Oct 2026 -> last calendar month = 2026-09
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (mo) => String(mo).padStart(2, '0');
// Synthetic source blocks: monthly values turned into running totals (HDD / CDD) or kept (average temp).
function blocks(monthly, key, cumulative, upToByYear) {
  return Object.keys(upToByYear).map((y) => {
    let total = 0;
    const data = [];
    for (let mo = 1; mo <= upToByYear[y]; mo++) {
      const v = monthly[y + '-' + pad(mo)][key];
      total += v;
      data.push({ month: MON[mo - 1], value: String(cumulative ? total : v) });
    }
    return { year: y, data };
  });
}
const truth = {};
for (const y of [2025, 2026])
  for (let mo = 1; mo <= 12; mo++)
    truth[y + '-' + pad(mo)] = {
      hdd: Math.max(0, 70 - 12 * Math.abs(mo - 7)),
      cdd: Math.max(0, 300 - 80 * Math.abs(mo - 7)),
      avg: 30 + 8 * (6 - Math.abs(mo - 7)) + (y === 2026 ? 1 : 0),
    };
const asRows = (yms) => yms.map((ym) => ({ ym, hdd: truth[ym].hdd, cdd: truth[ym].cdd, avgTemp: truth[ym].avg }));
const ymRange = (a, b) => Object.keys(truth).filter((k) => k >= a && k <= b);

ok('last calendar month', () => {
  assert.strictEqual(W.wxLastCompleteYm(NOW), '2026-09');
  assert.strictEqual(W.wxLastCompleteYm(new Date(2026, 0, 5)), '2025-12');
});
ok('refresh needed only when newest stored month < last calendar month', () => {
  assert.strictEqual(W.wxNeedsRefresh(asRows(ymRange('2025-01', '2026-08')), NOW), true);
  assert.strictEqual(W.wxNeedsRefresh(asRows(ymRange('2025-01', '2026-09')), NOW), false);
  assert.strictEqual(W.wxNeedsRefresh([], NOW), true);
});
ok('running totals become single months (Jan as returned, gap month left out)', () => {
  const m = W.wxCumulativeToMonthly([
    {
      year: 2026,
      data: [
        { month: 'Jan', value: '100' },
        { month: 'Feb', value: '250' },
        { month: 'Apr', value: '400' },
      ],
    },
  ]);
  assert.deepStrictEqual(J(m), { '2026-01': 100, '2026-02': 150 });
});
const hddB = blocks(truth, 'hdd', true, { 2025: 12, 2026: 9 });
const cddB = blocks(truth, 'cdd', true, { 2025: 12, 2026: 9 });
const tmpB = blocks(truth, 'avg', false, { 2025: 12, 2026: 9 });
const fakeFetch = (series) => async (url) => {
  const body = /GetWeatherStation/.test(url)
    ? { stationID: 1 }
    : /heatingDegreeDays/.test(url)
      ? series.h
      : /coolingDegreeDays/.test(url)
        ? series.c
        : series.t;
  return { ok: true, status: 200, json: async () => body };
};
(async () => {
  const fetched = W.wxRowsFromBlocks(hddB, cddB, tmpB);
  ok('source rows equal the monthly truth', () => {
    assert.deepStrictEqual(J(fetched), asRows(ymRange('2025-01', '2026-09')));
  });
  ok('merge appends only newer months, never changes stored months', () => {
    const stored = asRows(ymRange('2025-01', '2026-08')).map((r) => ({ ...r, hdd: r.hdd + 1000 })); // different on purpose
    const before = JSON.stringify(stored);
    const { rows, added } = W.wxMergeAppend(stored, fetched, NOW);
    assert.strictEqual(JSON.stringify(stored), before);
    assert.deepStrictEqual(J(added.map((r) => r.ym)), ['2026-09']);
    assert.strictEqual(rows.length, stored.length + 1);
    stored.forEach((r, i) => assert.deepStrictEqual(J(rows[i]), J(r)));
  });
  ok('a month the source has not published is absent, never 0', () => {
    const noSepCdd = W.wxRowsFromBlocks(hddB, blocks(truth, 'cdd', true, { 2025: 12, 2026: 8 }), tmpB);
    const { added } = W.wxMergeAppend(asRows(ymRange('2025-01', '2026-08')), noSepCdd, NOW);
    assert.strictEqual(added.length, 0);
    assert.ok(!noSepCdd.some((r) => r.ym === '2026-09'));
  });
  ok('current calendar month is never saved', () => {
    const withOct = fetched.concat([{ ym: '2026-10', hdd: 5, cdd: 5, avgTemp: 60 }]);
    const { added } = W.wxMergeAppend(asRows(ymRange('2025-01', '2026-08')), withOct, NOW);
    assert.ok(!added.some((r) => r.ym === '2026-10'));
  });
  const saved = {};
  const store = { 11111: asRows(ymRange('2025-01', '2026-08')), 22222: asRows(ymRange('2025-01', '2026-09')) };
  const deps = {
    loadFn: (z) => store[z] || [],
    saveFn: (z, r) => {
      saved[z] = r;
      store[z] = r;
    },
    fetchFn: fakeFetch({ h: hddB, c: cddB, t: tmpB }),
    now: NOW,
  };
  const r1 = await W.wxRefreshZip('11111', deps);
  const r2 = await W.wxRefreshZip('22222', deps);
  await W.wxRefreshZip('33333', deps); // no stored months: history from 2020 (synthetic source has 2025 on)
  ok('refresh saves Sep 2026 for the stale ZIP, nothing for the current ZIP, all months for an empty ZIP', () => {
    assert.deepStrictEqual(J(r1.added.map((r) => r.ym)), ['2026-09']);
    assert.strictEqual(r2, null);
    assert.ok(!('22222' in saved));
    assert.strictEqual(saved['33333'][0].ym, '2025-01');
    assert.strictEqual(saved['33333'].length, 21);
  });
  ok('project ZIPs: distinct, 5 digits, project ZIP included, blanks dropped', () => {
    assert.deepStrictEqual(
      J(W.wxProjectZips({ zip: '33333' }, [{ zip: '11111' }, { zip: '11111' }, { zip: '' }, { zip: 'x' }])),
      ['11111', '33333'],
    );
  });
  ok('FROZEN BASELINE: appending Sep 2026 weather changes no baseline-period value', () => {
    const bills = ymRange('2025-01', '2026-09').map((ym) => {
      const last = new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
      return { start: ym + '-01', end: ym + '-' + last, kwh: 1000 + truth[ym].cdd * 3 + truth[ym].hdd * 2, totalCost: 100 };
    });
    const wBefore = {};
    asRows(ymRange('2025-01', '2026-08')).forEach((r) => (wBefore[r.ym] = r));
    const wAfter = { ...wBefore, '2026-09': asRows(['2026-09'])[0] };
    // Signed baseline: months 2025-01..2025-12 and the regression saved with them (what saveBaseline stores).
    const blMonths = ymRange('2025-01', '2025-12');
    const meter = { commodity: 'Electric' };
    const blRows0 = W.getNormRows(meter, bills, true, wBefore).filter((r) => blMonths.includes(r.ym));
    meter.baseline = { months: blMonths, reg: W.computeMeterRegression(blRows0) };
    const rowsB = W.getNormRows(meter, bills, true, wBefore);
    const rowsA = W.getNormRows(meter, bills, true, wAfter);
    const baseB = rowsB.filter((r) => r.ym <= '2025-12');
    const baseA = rowsA.filter((r) => r.ym <= '2025-12');
    assert.strictEqual(baseB.length, 12);
    assert.strictEqual(JSON.stringify(baseA), JSON.stringify(baseB));
    assert.strictEqual(JSON.stringify(W.computeMeterRegression(baseA)), JSON.stringify(W.computeMeterRegression(baseB)));
    const sepB = rowsB.find((r) => r.ym === '2026-09');
    const sepA = rowsA.find((r) => r.ym === '2026-09');
    assert.strictEqual(sepB.hdd, null); // no weather row: null, not 0
    assert.strictEqual(sepA.hdd, truth['2026-09'].hdd);
  });
  // A signed contract (getProjectContract.hasContract) freezes the baseline: m.baseline (months + reg) is written only by
  // the explicit Save Baseline action, never by a weather fill. The fill writes one thing: the ZIP's own weather key.
  const contractedBaselineCase = async (label, zip, storedRows) => {
    const contract = W.getProjectContract({ contractType: 'sharedSavings', cscCompensation: 60, sa: 'signed-agreement' });
    assert.strictEqual(contract.hasContract, true);
    const bills = ymRange('2025-01', '2026-09').map((ym) => {
      const last = new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
      return { start: ym + '-01', end: ym + '-' + last, kwh: 1000 + truth[ym].cdd * 3 + truth[ym].hdd * 2, totalCost: 100 };
    });
    const blMonths = ymRange('2025-01', '2025-12');
    const wFrozen = {};
    asRows(blMonths).forEach((r) => (wFrozen[r.ym] = r));
    const meter = { commodity: 'Electric' };
    meter.baseline = {
      months: blMonths,
      reg: W.computeMeterRegression(W.getNormRows(meter, bills, true, wFrozen).filter((r) => blMonths.includes(r.ym))),
    };
    assert.ok(meter.baseline.reg && meter.baseline.reg.cdd, 'frozen regression must be valid');
    const baselineBefore = JSON.stringify(meter.baseline);
    const wxStore = { [zip]: storedRows.slice() };
    const writes = [];
    await W.wxRefreshZip(zip, {
      loadFn: (z) => wxStore[z] || [],
      saveFn: (z, r) => {
        writes.push(z);
        wxStore[z] = r;
      },
      fetchFn: fakeFetch({ h: hddB, c: cddB, t: tmpB }),
      now: NOW,
    });
    assert.deepStrictEqual(writes, [zip], label + ': only the ZIP weather key is written');
    assert.strictEqual(JSON.stringify(meter.baseline), baselineBefore, label + ': stored baseline (months + reg) unchanged');
    const wAfter = {};
    wxStore[zip].forEach((r) => (wAfter[r.ym] = r));
    return { meter, wFrozen, wAfter, bills, baselineBefore };
  };
  {
    const r = await contractedBaselineCase('stale ZIP', '55501', asRows(ymRange('2025-01', '2026-08')));
    const blB = r.meter.baseline.months;
    const before = W.getNormRows(r.meter, r.bills, true, r.wFrozen).filter((x) => blB.includes(x.ym));
    const after = W.getNormRows(r.meter, r.bills, true, r.wAfter).filter((x) => blB.includes(x.ym));
    assert.strictEqual(before.length, 12);
    assert.strictEqual(JSON.stringify(after), JSON.stringify(before));
    n++;
    console.log('ok  CONTRACTED PROJECT: stale ZIP fill, 12 baseline-period rows identical');
  }
  {
    const r = await contractedBaselineCase('empty ZIP back-fill', '55502', []);
    assert.ok(r.wAfter['2025-01'] && r.wAfter['2025-12'], 'the back-fill did add baseline-period weather');
    assert.strictEqual(JSON.stringify(r.meter.baseline), r.baselineBefore);
    n++;
    console.log('ok  CONTRACTED PROJECT: empty ZIP back-fill added baseline-period weather and changed no stored baseline');
  }
  console.log('ALL PASSED (' + n + ' checks)');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
