// tools/test-fan-savings.js - SYNTHETIC-fixture test of the fan end use and the Fan Savings template (Phase 6, 2026-10-14).
// No real client data: invented building, invented units. Runs in the regression gate by glob.
//   1. physics: motorKwFromAmps, fanKwFromCfm, fanMeanPowerFraction
//   2. trend import: the new fan point types are detected, summarised per day (no raw rows) and read back by fanTrendSummary
//   3. fanUnitModel: each input shows its data level; a better level replaces a worse one
//   4. getEndUse(.., 'fans'): sum, cap (total electricity less cooling and electric heating), monthly profile, data levels, no-data answers
//   5. fanSavingsForUnits and the template: three measures, lever switches, selection, quantities only
//   6. the measure map and ecmBuildMeasure: the savings are shaped by the fan end use, not divided by 12
//   7. hostile input: unit names and building names with HTML are escaped in the picker and the result table
//   8. the gate (tools/gate-single-fan-model.js) passes on the tree and FAILS on a copy with a second fan rule
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const gate = require('./gate-single-fan-model.js');

let passed = 0;
let failed = 0;
function ok(cond, msg, info) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL ' + msg + (info !== undefined ? '  [' + info + ']' : ''));
  }
}
const near = (a, b, t) => Math.abs(a - b) <= (t === undefined ? 1e-6 : t);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---- synthetic project: one building with six Equipment Matrix rows (+ one other building, one non-fan row) ----
const BLDG = 'Synthetic Hall';
const HOSTILE = '<img src=x onerror=alert(1)>';
const COOL = [0, 0, 1000, 3000, 8000, 15000, 22000, 20000, 12000, 4000, 1000, 0];
// hvacKwh = cooling above baseload; capKwh = the rest of the building total (total = hvacKwh + capKwh), which is the fan cap.
const SYN_EST = (hvacKwh, capKwh) => {
  const scale = hvacKwh / sum(COOL);
  const monthly = COOL.map((v) => v * scale);
  return {
    basis: {
      hvacKwh: 'measured',
      coolKwh: 'measured',
      heatKwh: 'measured',
      hvacGas: 'measured',
      nonHvacKwh: 'measured',
      hvacKw: 'rule',
      nonHvacKw: 'rule',
    },
    dataSource: 'bills',
    monthly: true,
    coolKwhTotal: hvacKwh,
    monthlyCoolKwh: monthly,
    heatKwhTotal: 0,
    monthlyHeatKwh: Array(12).fill(0),
    hvacKwh: hvacKwh,
    monthlyHvacKwh: monthly,
    nonHvacKwh: capKwh,
    monthlyNonHvacKwh: Array(12).fill(capKwh / 12),
    totalKwh: hvacKwh + capKwh,
    hvacGasT: 0,
    monthlyHvacGas: Array(12).fill(0),
    hvacKw: 100,
    monthlyHvacKw: Array(12).fill(100 / 12),
    nonHvacKw: 1,
    monthlyNonHvacKw: Array(12).fill(1 / 12),
  };
};

function makeRows(extra) {
  const row = (id, name, cat, pts, more) =>
    Object.assign(
      { id: id, building: BLDG, equipName: name, category: cat, pts: pts || {}, pointsRaw: {} },
      more || {},
    );
  return [
    row('r1', 'AHU-1', 'ahu', { supplyFanCFM: '12000' }, { voltage: '480', phase: '3-phase' }),
    row(
      'r2',
      'AHU-2',
      'ahu',
      { supplyFanCFM: '10000' },
      { pointsRaw: { 'Supply Fan High Enable': '0', 'Supply Fan Low Enable': '1' } },
    ),
    row(
      'r3',
      'RTU-1',
      'rtu',
      { supplyFanAmps: '20', supplyFanStatus: 'On', scheduledOccupied: '0' },
      { voltage: '208', phase: '1' },
    ),
    row('r4', 'AHU-3', 'ahu', { supplyFanCFM: '8000', supplyFanSpeed: '55' }),
    row('r5', 'DOAS-1', 'doas', {}),
    row('r6', 'AHU-9', 'ahu', { supplyFanCFM: '9000' }, { building: 'Other Hall' }),
    row('r7', 'VAV-1', 'vav', { supplyFanCFM: '500' }),
  ].concat(extra || []);
}

// ---- sandbox: real physics, fan-savings, end-use, ecm-calculators, bas-trends and formatting files ----
function makeSandbox(opts) {
  const store = {};
  const sb = {
    console,
    setTimeout,
    window: {},
    document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    sget: (k, d) => (store[k] === undefined ? d : JSON.parse(JSON.stringify(store[k]))),
    sset: (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
    },
    DB: { get: (k, d) => d },
    getUDBldg: (p, b) =>
      b === 'b1'
        ? { id: 'b1', name: BLDG, sqft: 50000 }
        : b === 'b2'
          ? { id: 'b2', name: 'Empty Hall' }
          : b === 'b3'
            ? { id: 'b3', name: 'Other Hall' }
            : null,
    getUDBldgs: () => [
      { id: 'b1', name: BLDG },
      { id: 'b2', name: 'Empty Hall' },
      { id: 'b3', name: 'Other Hall' },
    ],
    hvacEstimateForBuilding: (p, b) =>
      b === 'b1' && opts.hvacKwh
        ? {
            est: SYN_EST(opts.hvacKwh, opts.capKwh || opts.hvacKwh),
            resolved: { source: 'bills', label: 'From 12 months of baseline bills' },
            estimate: 'saved',
            savedAt: 1790000000000,
          }
        : null,
    resolveHvacLoadData: () => ({ source: 'none', label: 'No utility data yet' }),
    hvlBasisLabel: () => 'Measured',
    emLoadMatrix: () => ({ rows: opts.rows || makeRows(), edits: opts.edits || {} }),
    emGetNormalizedPoints: (row) => row.pts || {},
    emGetCellValByDef: (row, def, edits) =>
      edits && edits[row.id + '::' + def.key] !== undefined
        ? edits[row.id + '::' + def.key]
        : row[def.key] != null
          ? row[def.key]
          : '',
    _emNormBldgNameForJoin: (n) => String(n).toLowerCase().trim(),
  };
  sb.btGetData = (p) => sb.sget('en_bas_' + p, { buildings: {} });
  if (opts.projType) store['en_projects'] = [{ id: 'p', type: opts.projType }];
  vm.createContext(sb);
  ['lib/formatting.js', 'computations/physics.js', 'computations/fan-savings.js', 'computations/end-use.js'].forEach(
    (f) => vm.runInContext(read(f).replace(/\r\n/g, '\n'), sb, { filename: f }),
  );
  vm.runInContext(read('app/bas-trends.js').replace(/\r\n/g, '\n'), sb, { filename: 'app/bas-trends.js' });
  vm.runInContext(
    read('app/ecm-calculators.js')
      .replace(/\bconst\s+(ECM_TEMPLATES|ECM_MEASURE_FIELD_MAP)\b/g, 'var $1')
      .replace(/\r\n/g, '\n'),
    sb,
    { filename: 'app/ecm-calculators.js' },
  );
  return sb;
}

// A synthetic hourly trend file: 3 days, the fan runs 06:00-18:00.
function trendCsv(columns, valueFn) {
  let csv = 'Date/Time,' + columns.join(',') + '\n';
  for (let day = 1; day <= 3; day++)
    for (let h = 0; h < 24; h++) {
      const running = h >= 6 && h < 18;
      csv +=
        '2026-02-0' +
        day +
        ' ' +
        String(h).padStart(2, '0') +
        ':00,' +
        columns.map((c, i) => valueFn(c, running, h, i)).join(',') +
        '\n';
    }
  return csv;
}
function importTrend(sb, tag, csv) {
  return new Promise((resolve, reject) => {
    sb.btImportCSV(csv, 'p', 'b1', BLDG, tag, null, null, {
      onComplete: resolve,
      onError: (e) => reject(new Error(e)),
    });
  });
}

async function main() {
  // ---------------- 1. physics ----------------
  console.log('--- 1. physics ---');
  {
    const sb = makeSandbox({});
    ok(
      near(sb.motorKwFromAmps(12, 480, 3, 0.85), (Math.sqrt(3) * 12 * 480 * 0.85) / 1000, 1e-9),
      'three phase kW from amps',
    );
    ok(
      near(sb.motorKwFromAmps(12, 480, 3, 0.85), 8.4801, 1e-3),
      'three phase kW from amps, hand value',
      sb.motorKwFromAmps(12, 480, 3, 0.85),
    );
    ok(
      near(sb.motorKwFromAmps(20, 208, 1), (20 * 208 * sb.MOTOR_DEFAULT_POWER_FACTOR) / 1000),
      'single phase kW from amps, default power factor',
    );
    ok(near(sb.fanKwFromCfm(10000), 8.51), 'cfm x mid W per cfm', sb.fanKwFromCfm(10000));
    ok(near(sb.fanKwFromCfm(10000, sb.FAN_W_PER_CFM.low), 7.74), 'cfm x low W per cfm');
    const m = sb.fanMeanPowerFraction([
      { speed: 1, share: 1 },
      { speed: 0.5, share: 1 },
    ]);
    ok(near(m, (1 + 0.125) / 2), 'mean power fraction goes through the cube law', m);
    ok(sb.fanMeanPowerFraction([{ speed: 1, share: 0 }]) === null, 'no hours: no mean');
  }

  // ---------------- 2. trend import ----------------
  console.log('--- 2. trend import ---');
  const sb = makeSandbox({ hvacKwh: 90000 });
  // detection of the new point names
  const det = (n) => sb.btDetectPointType(n);
  ok(
    det('AHU-2 Supply Fan High Enable') === 'fanhienable',
    'High enable point type',
    det('AHU-2 Supply Fan High Enable'),
  );
  ok(det('AHU-2 Supply Fan Low Enable') === 'fanloenable', 'Low enable point type', det('AHU-2 Supply Fan Low Enable'));
  ok(det('AHU-1 Supply Fan Amps') === 'fanamps', 'fan amps point type', det('AHU-1 Supply Fan Amps'));
  ok(det('AHU-1 Supply Fan Amperage') === 'fanamps', 'fan amperage point type');
  ok(det('AHU-1 Supply Fan Status') === 'fanstatus', 'status still detected as before');
  ok(det('AHU-1 Supply Fan VFD Speed') === 'fanspeed', 'speed still detected as before');
  ok(det('AHU-1 Duct Static Pressure Setpoint') === 'staticpsp', 'static setpoint still detected');
  ok(det('AHU-1 Duct Static Pressure') === 'staticp', 'static pressure still detected');
  ok(
    sb.BT_POINT_LABELS.fanhienable && sb.BT_POINT_LABELS.fanloenable && sb.BT_POINT_LABELS.fanamps,
    'the new types have labels',
  );

  await importTrend(
    sb,
    'AHU-1',
    trendCsv(['AHU-1 Supply Fan Status', 'AHU-1 Supply Fan Amps', 'AHU-1 Duct Static Pressure Setpoint'], (c, run) =>
      /Status/.test(c) ? (run ? 1 : 0) : /Amps/.test(c) ? (run ? 12 : 0) : 1.2,
    ),
  );
  await importTrend(
    sb,
    'AHU-2',
    trendCsv(['AHU-2 Supply Fan High Enable', 'AHU-2 Supply Fan Low Enable', 'AHU-2 Supply Fan Status'], (c, run, h) =>
      /High/.test(c) ? (run && h < 9 ? 1 : 0) : /Low/.test(c) ? (run && h >= 9 ? 1 : 0) : run ? 1 : 0,
    ),
  );
  await importTrend(
    sb,
    'AHU-3',
    trendCsv(['AHU-3 Supply Fan VFD Speed', 'AHU-3 Duct Static Pressure Setpoint'], (c, run, h) =>
      /Speed/.test(c) ? (run ? (h < 10 ? 100 : h < 14 ? 60 : 45) : 0) : 0.8 + (h % 3) * 0.2,
    ),
  );
  const bas = sb.btGetData('p').buildings.b1.equipment;
  const day = bas['AHU-1'].days['2026-02-02'];
  ok(day.fanstatus.runtimeHours === 12, 'status run hours per day', day.fanstatus.runtimeHours);
  ok(
    day.fanamps.runtimeHours === 12 && day.fanamps.runAvg === 12,
    'amps run hours and running mean',
    JSON.stringify(day.fanamps),
  );
  const d3 = bas['AHU-3'].days['2026-02-02'];
  ok(
    d3.fanspeed.binHours.length === 4 && sum(d3.fanspeed.binHours) === d3.fanspeed.runtimeHours,
    'speed bins add up to the run hours',
    JSON.stringify(d3.fanspeed),
  );
  ok(
    d3.fanspeed.binHours[3] === 4 && d3.fanspeed.binHours[2] === 4 && d3.fanspeed.binHours[1] === 4,
    'speed bins: 4 h at 100, 4 h at 60, 4 h at 45',
    JSON.stringify(d3.fanspeed.binHours),
  );
  ok(JSON.stringify(bas['AHU-1']).length < 20000, 'the stored summaries stay small (no raw rows in the summary)');
  const ts1 = sb.fanTrendSummary(bas['AHU-1'].days);
  ok(
    ts1.runHoursPerDay === 12 && ts1.runSource === 'fan status' && ts1.runDays === 3,
    'trend summary: run hours',
    JSON.stringify(ts1).slice(0, 160),
  );
  ok(near(ts1.runAmps, 12) && near(ts1.setpoint.spread, 0), 'trend summary: running amps, flat setpoint');
  const ts2 = sb.fanTrendSummary(bas['AHU-2'].days);
  ok(
    ts2.hiHours === 9 && ts2.loHours === 27 && near(ts2.lowShare, 0.75),
    'trend summary: High/Low split',
    JSON.stringify([ts2.hiHours, ts2.loHours, ts2.lowShare]),
  );
  const ts3 = sb.fanTrendSummary(bas['AHU-3'].days);
  ok(
    ts3.speed.varies === true && ts3.speed.bins.length === 3,
    'trend summary: speed moves, 3 bins',
    JSON.stringify(ts3.speed),
  );
  ok(ts3.setpoint.spread > 0.3, 'trend summary: setpoint spread', ts3.setpoint.spread);
  // re-import of the same days with an extra point type adds the type, keeps the old ones
  const beforeFault = JSON.stringify(bas['AHU-3'].days['2026-02-02'].faults);
  await importTrend(sb, 'AHU-3', trendCsv(['AHU-3 Supply Fan Amps'], (c, run) => (run ? 9 : 0)));
  const after = sb.btGetData('p').buildings.b1.equipment['AHU-3'].days['2026-02-02'];
  ok(
    after.fanamps && after.fanspeed && after.staticpsp && JSON.stringify(after.faults) === beforeFault,
    'a later file adds the amps point to the same days and keeps the old ones',
  );

  // ---------------- 3. unit model and data levels ----------------
  console.log('--- 3. unit model ---');
  const units = sb.fanReadUnits('p', 'b1');
  ok(
    units.units.length === 5,
    'five supply-fan rows of this building (other building and VAV left out)',
    units.units.map((u) => u.name).join(),
  );
  const U = {};
  units.units.forEach((u) => (U[u.name] = sb.fanUnitModel(u)));
  ok(
    U['AHU-1'].kwLevel === 'trend' && near(U['AHU-1'].kw, 8.4801, 1e-3) && U['AHU-1'].kwBasis === 'operating',
    'AHU-1: kW from trend amps x matrix volts and phase',
    JSON.stringify([U['AHU-1'].kw, U['AHU-1'].kwLevel]),
  );
  ok(
    U['AHU-1'].hoursLevel === 'trend' && near(U['AHU-1'].hours, 12 * 365),
    'AHU-1: run hours from the trend',
    U['AHU-1'].hours,
  );
  ok(U['AHU-1'].vfd === 'no' && U['AHU-1'].vfdLevel === 'default', 'AHU-1: no speed point or trend: constant speed by default');
  ok(U['AHU-1'].reset.level === 'trend', 'AHU-1: setpoint trend present');
  ok(
    U['AHU-2'].kwLevel === 'matrix' && near(U['AHU-2'].kw, sb.fanKwFromCfm(10000)) && U['AHU-2'].kwBasis === 'full',
    'AHU-2: kW from the matrix airflow',
  );
  ok(
    U['AHU-2'].twoSpeed && U['AHU-2'].twoSpeed.level === 'trend' && near(U['AHU-2'].twoSpeed.lowShare, 0.75),
    'AHU-2: two-speed, Low share from the enable trend',
  );
  ok(
    U['RTU-1'].kwLevel === 'matrix' &&
      near(U['RTU-1'].kw, (20 * 208 * 0.85) / 1000) &&
      U['RTU-1'].hoursLevel === 'matrix' &&
      U['RTU-1'].hours === 8760,
    'RTU-1: matrix amps, volts, phase; fan on while unoccupied: all-year hours',
  );
  ok(
    U['AHU-3'].vfd === 'yes' && U['AHU-3'].vfdLevel === 'trend' && U['AHU-3'].profile.level === 'trend',
    'AHU-3: the speed trend moves: has a drive, measured profile',
  );
  ok(U['AHU-3'].hoursLevel === 'trend', 'AHU-3: run hours from the speed trend');
  ok(U['AHU-3'].reset.level === 'trend' && U['AHU-3'].reset.pass === 0, 'AHU-3: setpoint already moves: reset pass 0');
  ok(
    U['DOAS-1'].ok === false && /amps|airflow|cfm|horsepower/i.test(U['DOAS-1'].missing),
    'DOAS-1: nothing to size it: says what is missing',
    U['DOAS-1'].missing,
  );
  // amps with no voltage and phase in the matrix: the stated low-end voltage, labelled default
  const ampsOnly = sb.fanUnitModel({ id: 'a', name: 'A', category: 'ahu', ampsPoint: 10, trend: null });
  ok(
    ampsOnly.kwLevel === 'default' &&
      near(ampsOnly.kw, sb.motorKwFromAmps(10, sb.FAN_DEFAULT_VOLTS, sb.FAN_DEFAULT_PHASE)) &&
      /assumed/.test(ampsOnly.kwHow),
    'amps only: assumed voltage and phase, level default, says assumed',
    ampsOnly.kwHow,
  );
  const ampsAndCfm = sb.fanUnitModel({ id: 'a', name: 'A', category: 'ahu', ampsPoint: 10, cfm: 8000, trend: null });
  ok(ampsAndCfm.kwLevel === 'matrix' && near(ampsAndCfm.kw, sb.fanKwFromCfm(8000)), 'amps without voltage lose to an airflow');
  // levels move up by themselves: a default-hours unit gets a trend
  const noTrend = sb.fanUnitModel(Object.assign({}, units.units[0], { trend: null }));
  ok(
    noTrend.hoursLevel === 'default' && noTrend.hours === sb.FAN_DEFAULT_ANNUAL_HOURS,
    'without the trend: default hours, labelled',
  );
  ok(
    noTrend.kwLevel === 'matrix' && near(noTrend.kw, sb.fanKwFromCfm(12000)),
    'without the trend: kW falls back to the matrix airflow',
  );
  const hpUnit = sb.fanUnitModel({ id: 'x', name: 'x', category: 'ahu', hp: 10, trend: null });
  ok(
    near(hpUnit.kw, sb.hpToKw(10, sb.FAN_HP_MOTOR_EFF) * sb.FAN_HP_LOAD_FACTOR) && hpUnit.kwLevel === 'matrix',
    'horsepower is the last fallback',
  );

  // ---------------- 4. fan end use ----------------
  console.log('--- 4. fan end use ---');
  const eu = sb.getEndUse('p', 'b1', 'fans');
  ok(
    eu.modeled && eu.source === 'matrix' && eu.unit === 'kWh' && eu.endUse === 'fans',
    'fans are modeled, source matrix',
  );
  const sized = eu.units.filter((u) => u.ok);
  const rawSum = sum(sized.map((u) => u.kwh));
  ok(rawSum > 90000, 'the synthetic units add up to more than the cap', rawSum);
  ok(
    near(eu.annual, 90000, 1e-6) && near(eu.capFactor, 90000 / rawSum),
    'capped by total electricity less cooling and electric heating',
    JSON.stringify([eu.annual, eu.capFactor]),
  );
  ok(eu.capAnnual === 90000, 'cap reported');
  ok(eu.monthly.length === 12 && near(sum(eu.monthly), eu.annual, 1e-6), 'months add up to the annual');
  ok(near(eu.monthly[0] / eu.monthly[1], 31 / 28), 'month profile is days in month: January over February');
  ok(
    eu.levels.kw.trend === 1 &&
      eu.levels.kw.matrix === 3 &&
      eu.levels.hours.trend === 3 &&
      eu.levels.hours.matrix === 1 &&
      eu.levels.hours.default === 0,
    'data levels counted',
    JSON.stringify(eu.levels),
  );
  ok(
    /4 of 5|5 of 5/.test(eu.sourceLabel) || /sized/.test(eu.sourceLabel),
    'source label names the units sized',
    eu.sourceLabel,
  );
  ok(
    /scaled down/.test(eu.sourceLabel) && /measured trend/.test(eu.sourceLabel),
    'source label says it was scaled and names levels',
    eu.sourceLabel,
  );
  ok(eu.kw && eu.kw.monthly.length === 12 && eu.kw.peak > 0, 'running kW given');
  const w = sb.getEndUseWeights('p', 'b1', ['fans']);
  ok(w.ok && near(sum(w.weights), 1), 'getEndUseWeights works with the fan end use');
  // no cap when the HVAC end use is larger
  const sbBig = makeSandbox({ hvacKwh: 900000 });
  const euBig = sbBig.getEndUse('p', 'b1', 'fans');
  ok(
    euBig.capFactor === 1 && near(euBig.annual, sum(euBig.units.filter((u) => u.ok).map((u) => u.kwh))),
    'inside the cap: no scaling',
  );
  // no total electricity at all: no cap, said so
  const sbNo = makeSandbox({});
  const euNo = sbNo.getEndUse('p', 'b1', 'fans');
  ok(
    euNo.capAnnual === null && euNo.capFactor === 1 && /no total electricity to check against/.test(euNo.sourceLabel),
    'no bills: no cap, labelled',
    euNo.sourceLabel,
  );
  // no rows / no building / no data
  ok(makeSandbox({ rows: [] }).getEndUse('p', 'b1', 'fans').source === 'none', 'no matrix rows: none');
  ok(sb.getEndUse('p', 'zzz', 'fans').source === 'none', 'unknown building: none');
  ok(sb.getEndUse('p', 'b2', 'fans').source === 'none', 'building without fan rows: none');
  ok(
    makeSandbox({ rows: [makeRows()[4]] }).getEndUse('p', 'b1', 'fans').source === 'none',
    'rows with no sizing data: none, says why',
  );

  // ---------------- 5. measures and the template ----------------
  console.log('--- 5. measures and the template ---');
  const ALL = { vfd: true, twoSpeed: true, reset: true, resetCut: 0.2 };
  const models = eu.units;
  const f = eu.capFactor;
  const r = sb.fanSavingsForUnits(models, ALL, f);
  const R = {};
  r.units.forEach((u) => (R[u.name] = u));
  const fs0 = { fixedShare: sb.FAN_FIXED_POWER_SHARE };
  // a constant-speed fan with no speed trend: default profile
  const cs = sb.fanUnitModel({ id: 'c', name: 'C', category: 'ahu', cfm: 12000, trend: null });
  const rc = sb.fanSavingsForUnits([cs], ALL, f);
  const prof = sb.fanMeanPowerFraction(sb.FAN_DEFAULT_SPEED_BINS, fs0);
  ok(
    near(rc.units[0].vfd, cs.kw * cs.hours * (1 - prof) * f, 1e-6) && rc.units[0].vfd > 0,
    'constant-speed fan: kW x hours x (1 - profile fraction) x cap',
    rc.units[0].vfd,
  );
  ok(rc.units[0].twoSpeed === 0 && rc.units[0].reset === 0, 'constant-speed fan: no two-speed and no reset saving');
  ok(R['AHU-1'].vfd > 0 && U['AHU-1'].profile.level === 'default', 'AHU-1 has no speed trend: the default profile saves something');
  // AHU-2: two-speed
  const hi = sb.fanMeanPowerFraction(
    Array.from({ length: sb.FAN_TWO_SPEED_VFD_STEPS }, (_, i) => ({
      speed: 0.58 + (0.42 * (i + 0.5)) / sb.FAN_TWO_SPEED_VFD_STEPS,
      share: 1,
    })),
    fs0,
  );
  ok(
    near(R['AHU-2'].twoSpeed, U['AHU-2'].kw * U['AHU-2'].hours * 0.25 * (1 - hi) * f, 1e-6),
    'two-speed fan: High hours only',
    R['AHU-2'].twoSpeed,
  );
  ok(hi > 0.4 && hi < 0.7, 'mean power over Low to High is near the hand value 0.5', hi);
  ok(R['AHU-2'].vfd === 0 && R['AHU-2'].reset === 0, 'two-speed fan: no constant-speed drive or reset measure');
  // AHU-3: has a drive, setpoint moves -> no reset
  ok(
    R['AHU-3'].reset === 0 && /already running|moves|reset/.test(R['AHU-3'].why.reset),
    'drive with a moving setpoint: reset saves nothing, says why',
    R['AHU-3'].why.reset,
  );
  // reset on a drive fan without a setpoint trend: default pass
  const drv = sb.fanUnitModel({ id: 'd', name: 'D', category: 'ahu', cfm: 10000, speedPoint: true, trend: null });
  const rr = sb.fanSavingsForUnits([drv], ALL, 1);
  const saveFrac = sb.ductStaticResetPowerSavings(0.2, fs0);
  ok(
    near(rr.units[0].reset, drv.kwh * saveFrac * sb.FAN_RESET_DEFAULT_PASS, 1e-6) && rr.units[0].vfd === 0,
    'reset on a fan with a drive: baseline x reset fraction x default pass',
    rr.units[0].reset,
  );
  ok(
    near(drv.kwh, drv.kw * drv.hours * sb.fanMeanPowerFraction(sb.FAN_DEFAULT_SPEED_BINS, fs0)),
    'a fan with a drive and no trend: baseline uses the default speed profile',
  );
  // levers off
  const off = sb.fanSavingsForUnits(models, { vfd: false, twoSpeed: false, reset: false, resetCut: 0.2 }, f);
  ok(off.savingsKwh.total === 0, 'all measures off: nothing saved');
  const onlyV = sb.fanSavingsForUnits(models, { vfd: true, twoSpeed: false, reset: false, resetCut: 0.2 }, f);
  ok(near(onlyV.savingsKwh.total, r.savingsKwh.vfd) && onlyV.savingsKwh.twoSpeed === 0, 'measures switch on their own');
  ok(
    near(r.savingsKwh.total, r.savingsKwh.vfd + r.savingsKwh.twoSpeed + r.savingsKwh.reset),
    'total is the sum of the three',
  );
  ok(
    r.units.every((u) => u.total <= u.baselineKwh + 1e-9),
    'no unit saves more than its baseline',
  );
  // template
  const T = sb.ECM_TEMPLATES.fan_savings;
  const defs = {};
  T.inputs.forEach((i) => (defs[i.id] = i.default));
  ok(
    T.calculate(defs).savings_kwh === 0 && /building/i.test(T.calculate(defs).note),
    'no building: zero and says to choose one',
  );
  const ctx = { projId: 'p', buildingId: 'b1' };
  const all = sized.map((u) => u.id);
  const res = sb.calculateEcm('fan_savings', Object.assign({}, defs, { fan_units: all }), ctx);
  ok(
    Math.abs(res.savings_kwh - r.savingsKwh.total) <= res.units.length && Math.abs(res.baseline_kwh - r.baselineKwh) <= res.units.length,
    'template result = fanSavingsForUnits on the fan end use',
    JSON.stringify([res.savings_kwh, r.savingsKwh.total]),
  );
  ok(
    res.savings_kwh === res.savings_vfd_kwh + res.savings_twospeed_kwh + res.savings_reset_kwh &&
      res.savings_kwh === res.units.reduce((t, u) => t + u.total, 0) &&
      res.baseline_kwh === res.units.reduce((t, u) => t + u.baselineKwh, 0),
    'result lines and the unit table add up exactly',
  );
  ok(res.savings_kw > 0, 'average demand reduction while running', res.savings_kw);
  ok(
    Object.keys(res).every((k) => !/dollar|payback|cost|rate/i.test(k)),
    'quantities only: no dollar, payback, cost or rate in the result',
  );
  const one = sb.calculateEcm('fan_savings', Object.assign({}, defs, { fan_units: [U['AHU-2'].id] }), ctx);
  ok(
    one.units.length === 1 && one.units[0].name === 'AHU-2' && one.savings_vfd_kwh === 0,
    'only the chosen unit counts',
  );
  ok(
    Math.abs(one.baseline_kwh - U['AHU-2'].kwh * f) <= 0.5,
    "baseline = that unit's share of the fan end use (cap applied)",
    one.baseline_kwh,
  );
  const none = sb.calculateEcm('fan_savings', Object.assign({}, defs, { fan_units: [] }), ctx);
  ok(none.savings_kwh === 0 && /at least one/.test(none.note), 'nothing chosen: zero and says so');
  const noOffer = sb.calculateEcm('fan_savings', Object.assign({}, defs, { fan_units: [U['DOAS-1'].id] }), ctx);
  ok(noOffer.savings_kwh === 0, 'a unit that cannot be sized adds nothing');

  // ---------------- 6. measure map ----------------
  console.log('--- 6. measure map ---');
  ok(
    sb.ECM_MEASURE_FIELD_MAP.fan_savings.every(
      (e) => e.endUse[0] === 'fans' && T.outputs.some((o) => o.id === e.field),
    ),
    'the map shapes savings_kwh and savings_kw by the fan end use',
  );
  const built = sb.ecmBuildMeasure('p', 'b1', 'fan_savings', defs, res);
  ok(built.ok, 'measure builds', built.reason);
  if (built.ok) {
    const m = built.measure;
    ok(near(sum(m.kwh), res.savings_kwh, 1e-6), 'the 12 months add up to the yearly saving', sum(m.kwh));
    ok(
      near(m.kwh[0] / m.kwh[1], 31 / 28, 1e-9),
      'monthly shape = the fan end use profile (days in month), not a flat 1/12',
    );
    ok(near(Math.max(...m.kw), res.savings_kw, 1e-6), 'the kW reduction peaks at the yearly average-running kW');
    ok(m.gas.every((v) => v === 0) && m.source === 'ecm_fan_savings', 'measure source and no gas');
    ok(
      built.shapes.every((s) => s.endUse === 'fans' && /Equipment Matrix/.test(s.sourceLabel)),
      'the shape line names the Equipment Matrix and the data levels',
    );
  }

  // ---------------- 7. hostile input ----------------
  console.log('--- 7. hostile input ---');
  {
    const rows = makeRows([
      {
        id: 'h1',
        building: BLDG,
        equipName: HOSTILE,
        category: 'ahu',
        pts: { supplyFanCFM: '5000' },
        pointsRaw: {},
        voltage: '',
        phase: '',
      },
      { id: 'h2', building: BLDG, equipName: '"><script>alert(2)</script>', category: 'ahu', pts: {}, pointsRaw: {} },
    ]);
    const hs = makeSandbox({ rows: rows, hvacKwh: 900000 });
    hs.getUDBldg = (p, b) => (b === 'b1' ? { id: 'b1', name: BLDG } : null);
    const field = hs.ecmFanUnitsFieldHtml({ projId: 'p', buildingId: 'b1' });
    ok(
      field.indexOf(HOSTILE) < 0 && field.indexOf('<script>') < 0 && field.indexOf('&lt;img') >= 0,
      'picker: unit names are escaped',
      field.slice(0, 80),
    );
    ok(!/data-fan-id="[^"]*<[^"]*"/.test(field), 'picker: no raw < inside an attribute');
    const calc = hs.calculateEcm('fan_savings', Object.assign({}, defs, { fan_units: ['h1', 'r2'] }), {
      projId: 'p',
      buildingId: 'b1',
    });
    const detail = hs.ecmFanDetailHtml(calc);
    ok(
      calc.units.some((u) => u.name === HOSTILE) && detail.indexOf(HOSTILE) < 0 && detail.indexOf('&lt;img') >= 0,
      'result table: unit names are escaped',
    );
    ok(/<tfoot>/.test(detail) && /Total/.test(detail), 'result table has a totals row');
    const none2 = hs.ecmFanDetailHtml({ units: [], note: '<b>x</b>' });
    ok(none2.indexOf('<b>x</b>') < 0 && none2.indexOf('&lt;b&gt;') >= 0, 'note is escaped');
    // the building note of a hostile name
    const lv = hs.ecmFanLevelCell(HOSTILE, 'trend', HOSTILE);
    ok(lv.indexOf('<img') < 0, 'level cell escapes value and how');
    // the picker shows the data levels in words
    ok(
      /Measured trend|Equipment Matrix value|Default/.test(field) && /What would refine this estimate/.test(field),
      'picker names data levels and what would refine the estimate',
    );
  }

  // ---------------- 7b. unsized fans get a stated Default estimate; the drive is a Default unless the user sets it ----------------
  console.log('--- 7b. unsized fans and the drive field ---');
  {
    const ahu = (id, name, cfm, bldg) => ({
      id: id,
      building: bldg || BLDG,
      equipName: name,
      category: 'ahu',
      pts: cfm ? { supplyFanCFM: String(cfm) } : {},
      pointsRaw: {},
    });
    const unitX = (eu) => eu.units.find((u) => u.name === 'AHU-X');
    // (a) sibling: three sized AHUs (4000, 8000, 12000 cfm) and one unsized AHU in the same building
    const rowsA = [ahu('a1', 'AHU-A', 4000), ahu('a2', 'AHU-B', 8000), ahu('a3', 'AHU-C', 12000), ahu('a4', 'AHU-X', 0)];
    const sbA = makeSandbox({ rows: rowsA, hvacKwh: 900000 });
    const euA = sbA.getEndUse('p', 'b1', 'fans');
    const xA = unitX(euA);
    ok(
      xA.ok && xA.estimate === 'sibling' && xA.kwLevel === 'default',
      'unsized AHU: sibling estimate, tagged Default',
      JSON.stringify([xA.ok, xA.estimate, xA.kwLevel]),
    );
    ok(near(xA.kw, sbA.fanKwFromCfm(8000)), 'sibling estimate is the median kW of the sized AHUs', xA.kw);
    ok(
      /median of 3 sized AHU units in this building/.test(xA.kwHow) && /Default/.test(xA.kwHow),
      'sibling basis is shown',
      xA.kwHow,
    );
    ok(/1 of them a Default estimate/.test(euA.sourceLabel), 'the end use label counts the estimated units', euA.sourceLabel);
    const euA2 = makeSandbox({ rows: rowsA.concat([ahu('a5', 'AHU-Y', 0)]), hvacKwh: 900000 }).getEndUse('p', 'b1', 'fans');
    ok(near(euA2.units.find((u) => u.name === 'AHU-Y').kw, xA.kw), 'two unsized AHUs get the same sibling median');
    const euA3 = makeSandbox({
      rows: [ahu('a1', 'AHU-A', 4000), ahu('a2', 'AHU-B', 8000), ahu('a3', 'AHU-C', 12000), ahu('a4', 'AHU-X', 20000)],
      hvacKwh: 900000,
    }).getEndUse('p', 'b1', 'fans');
    ok(!unitX(euA3).estimate && unitX(euA3).kwLevel === 'matrix', 'with its own airflow the unit leaves the estimate');
    // (b) project: no sized DOAS here, one in another building
    const doas = (id, name, bldg, cfm) => ({
      id: id,
      building: bldg,
      equipName: name,
      category: 'doas',
      pts: cfm ? { supplyFanCFM: String(cfm) } : {},
      pointsRaw: {},
    });
    const sbB = makeSandbox({ rows: [doas('d1', 'AHU-X', BLDG, 0), doas('d2', 'DOAS-F', 'Other Hall', 3000)], hvacKwh: 900000 });
    const xB = unitX(sbB.getEndUse('p', 'b1', 'fans'));
    ok(
      xB.estimate === 'project' && near(xB.kw, sbB.fanKwFromCfm(3000)) && /other buildings of the project/.test(xB.kwHow),
      'project estimate: median of the same type in the other buildings',
      xB.kwHow,
    );
    // (d) national ventilation share: nothing of the type anywhere; the CBECS share of the building total electricity, split over the unsized units
    const sbD = makeSandbox({ rows: [ahu('e1', 'AHU-X', 0), ahu('e2', 'AHU-Y', 0)], hvacKwh: 100000, capKwh: 900000 });
    const euD = sbD.getEndUse('p', 'b1', 'fans');
    const xD = unitX(euD);
    const totalD = 1000000;
    ok(xD.estimate === 'area' && xD.kwLevel === 'default', 'area estimate when no sibling exists');
    ok(
      near(sbD.fanVentilationShare('Office').share, 213 / 1196, 1e-12) &&
        near(sbD.fanVentilationShare('K-12 School').share, 19 / 128, 1e-12) &&
        sbD.fanVentilationShare('Education').key === 'education',
      'CBECS 2018 Table E5 shares: All buildings 213/1196, Education 19/128',
    );
    ok(
      near(xD.kwh, (totalD * 213) / 1196 / 2, 1e-6) && near(euD.annual, (totalD * 213) / 1196, 1e-6),
      'no building type: the All buildings share of the total electricity, split equally',
      JSON.stringify([xD.kwh, euD.annual]),
    );
    ok(
      /^Default: national average ventilation share for all buildings \(EIA CBECS 2018\)/.test(xD.kwHow) &&
        /kWh per sq ft/.test(xD.kwHow) &&
        /split across 2 unsized units equally/.test(xD.kwHow),
      'area basis names the source, shows kWh per sq ft and the split',
      xD.kwHow,
    );
    // a school takes the Education share
    const sbSch = makeSandbox({ rows: [ahu('e1', 'AHU-X', 0), ahu('e2', 'AHU-Y', 0)], hvacKwh: 100000, capKwh: 900000, projType: 'K-12 School' });
    const euSch = sbSch.getEndUse('p', 'b1', 'fans');
    ok(
      near(euSch.annual, (totalD * 19) / 128, 1e-6) && /ventilation share for education buildings/.test(unitX(euSch).kwHow),
      'a school takes the Education share',
      JSON.stringify([euSch.annual, unitX(euSch).kwHow]),
    );
    // sized fans come out of the target; tons set the split
    const rtu = (id, name, tons) => ({ id: id, building: BLDG, equipName: name, category: 'rtu', pts: {}, pointsRaw: {}, hpTons: tons });
    const sbT = makeSandbox({
      rows: [ahu('g1', 'AHU-S', 8000), rtu('g2', 'RTU-A', '10'), rtu('g3', 'RTU-B', '30')],
      hvacKwh: 100000,
      capKwh: 900000,
    });
    const euT = sbT.getEndUse('p', 'b1', 'fans');
    const sizedT = euT.units.find((u) => u.name === 'AHU-S');
    const ra = euT.units.find((u) => u.name === 'RTU-A');
    const rb = euT.units.find((u) => u.name === 'RTU-B');
    ok(
      near(ra.kwh + rb.kwh, (totalD * 213) / 1196 - sizedT.kwh, 1e-6) && near(rb.kwh, ra.kwh * 3, 1e-6),
      'sized fans come out of the target; the unsized units split it by tons',
      JSON.stringify([ra.kwh, rb.kwh, sizedT.kwh]),
    );
    // double count: fans come out of the non-HVAC remainder
    const nhT = sbT.getEndUse('p', 'b1', 'nonHvacElectric');
    ok(
      near(nhT.annual + euT.annual, 900000, 1e-6) && near(sum(nhT.monthly), nhT.annual, 1e-6) && /less the .* kWh of supply fans/.test(nhT.sourceLabel),
      'non-HVAC electric = total less cooling and electric heating, less the fans (no double count)',
      JSON.stringify([nhT.annual, euT.annual]),
    );
    ok(
      near(
        sbT.getEndUse('p', 'b1', 'cooling').annual + sbT.getEndUse('p', 'b1', 'heatingElectric').annual + nhT.annual + euT.annual,
        1000000,
        1e-6,
      ),
      'cooling + electric heating + non-HVAC + fans = building total',
    );
    // no sibling and no total electricity: no number is invented, the answer says so
    const euNoHv = makeSandbox({ rows: [ahu('f1', 'AHU-X', 0)] }).getEndUse('p', 'b1', 'fans');
    ok(
      euNoHv.source === 'none' && /None of the 1 supply-fan rows/.test(euNoHv.sourceLabel),
      'no sibling and no total electricity: not sized, said so',
      euNoHv.sourceLabel,
    );
    // the cap still holds
    const euCap = makeSandbox({ rows: rowsA, hvacKwh: 100000, capKwh: 10000 }).getEndUse('p', 'b1', 'fans');
    ok(near(euCap.annual, 10000, 1e-6) && euCap.capFactor < 1, 'the fan end use stays capped by total electricity less cooling and electric heating');

    // drive: a speed point alone is a Default; the unit field decides; unknown falls back to the assumption
    const spd = (more) =>
      Object.assign(
        { id: 'v1', building: BLDG, equipName: 'AHU-S', category: 'ahu', pts: { supplyFanCFM: '5000', supplyFanSpeed: '60' }, pointsRaw: {} },
        more || {},
      );
    const firstUnit = (o) => makeSandbox(Object.assign({ hvacKwh: 900000 }, o)).getEndUse('p', 'b1', 'fans').units[0];
    const d0 = firstUnit({ rows: [spd()] });
    ok(
      d0.vfd === 'yes' && d0.vfdLevel === 'default' && /Drive assumed from speed point/.test(d0.vfdHow),
      'speed point alone: drive assumed, tagged Default',
      d0.vfdHow,
    );
    const d1 = firstUnit({ rows: [spd()], edits: { 'v1::hasVfd': 'no' } });
    ok(d1.vfd === 'no' && d1.vfdLevel === 'matrix' && d1.hasVfd === 'no', 'the user sets No: constant speed, Equipment Matrix level', d1.vfdHow);
    const d2 = firstUnit({ rows: [spd({ pts: { supplyFanCFM: '5000' } })], edits: { 'v1::hasVfd': 'yes' } });
    ok(d2.vfd === 'yes' && d2.vfdLevel === 'matrix', 'the user sets Yes with no speed point: has a drive');
    const d3 = firstUnit({ rows: [spd()], edits: { 'v1::hasVfd': 'unknown' } });
    ok(d3.vfd === 'yes' && d3.vfdLevel === 'default' && d3.hasVfd === null, 'Unknown: back to the assumption');
  }

  // ---------------- 8. the gate ----------------
  console.log('--- 8. the gate ---');
  {
    const files = gate.loadFiles();
    const clean = gate.check(files);
    ok(clean.length === 0, 'gate passes on the tree', clean.join(' | '));
    const mut = (file, fn) => {
      const copy = Object.assign({}, files);
      copy[file] = fn(copy[file]);
      return gate.check(copy);
    };
    ok(
      mut('app/bas-trends.js', (t) => t + '\nfunction estFanKw(cfm) { return cfm * 0.00085 * 8760; }\n').some((b) =>
        /fan run hours of its own/.test(b),
      ),
      'gate fails on a fan with its own 8760 hours',
    );
    ok(
      mut('app/audit-estimate.js', (t) => t + '\nfunction fanUnitModel(r) {}\n').some((b) =>
        /second definition of fanUnitModel/.test(b),
      ),
      'gate fails on a second unit model',
    );
    ok(
      mut('app/audit-estimate.js', (t) => t + '\nconst u = fanReadUnits(1, 2);\n').some((b) =>
        /reads the fan units directly/.test(b),
      ),
      'gate fails on a direct read of the fan units',
    );
    ok(
      mut('app/pricing-estimator.js', (t) => t + '\nconst w = FAN_W_PER_CFM.mid;\n').some((b) =>
        /outside its owner/.test(b),
      ),
      'gate fails on the W per cfm constant outside the owners',
    );
    ok(
      mut('app/ecm-calculators.js', (t) =>
        t.replace(
          "const eu = getEndUse(ctx.projId, ctx.buildingId, 'fans');",
          "const eu = getEndUse(ctx.projId, ctx.buildingId, 'fans');\n      const k = Math.pow(2, 3);",
        ),
      ).some((b) => /Math\.pow/.test(b)),
      'gate fails on fan math inside the template',
    );
    ok(
      mut('computations/end-use.js', (t) => t.replace('fanMonthWeights()', 'FAN_FLAT()')).some((b) =>
        /fanMonthWeights/.test(b),
      ),
      'gate fails when the end use stops using the one month profile',
    );
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.log('CRASH', e && e.stack ? e.stack : e);
  process.exit(1);
});
