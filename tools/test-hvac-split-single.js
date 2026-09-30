// tools/test-hvac-split-single.js - WP-15 acceptance test. SYNTHETIC fixture only.
//
// Rule (Matt, 2026-09-20, settled): the HVAC split is the 3-lowest-month baseload method
// (computations/hvac-enduse.js computeHvacEnduse) EVERYWHERE. No regression HVAC split.
// The Baseline + BAS Savings report page 4, the report's setpoint options and the BAS Calc
// "Existing Cooling kWh" / "Existing Heating Gas Therms" must all read the same numbers.
// Electric heating that the baseload method cannot separate shows the plain label; nothing fills it.
//
// Before WP-15: page 4 used an electric HDD/CDD regression (different cooling kWh, plus an
// electric-heating kWh from the regression), BAS Calc calHeatKwh was filled from that regression,
// the Load Estimate used a fixed 0.65/0.35 split, and the Energy Graphics card kept its own copy
// of the monthly sums. This test fails on that code and passes on the fix.
//
// Run: node tools/test-hvac-split-single.js
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
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

function loadFn(file, fnName, optional) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) {
    if (optional) return '';
    throw new Error('not found: function ' + fnName + ' in ' + file);
  }
  let pDepth = 0,
    pEnd = src.indexOf('(', m.index);
  for (; pEnd < src.length; pEnd++) {
    if (src[pEnd] === '(') pDepth++;
    else if (src[pEnd] === ')' && --pDepth === 0) break;
  }
  let depth = 0,
    j = src.indexOf('{', pEnd);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, j + 1);
}
function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

const CALC = path.join(REPO, 'app', 'calculators.js');
const WD = path.join(REPO, 'app', 'report-engine-woodland.js');
const HV = path.join(REPO, 'computations', 'hvac-enduse.js');

// ---------------------------------------------------------------------------
// Synthetic building: 12 monthly bills, one bill per calendar month.
// ---------------------------------------------------------------------------
const KWH = [50000, 48000, 47000, 52000, 60000, 80000, 95000, 92000, 70000, 54000, 46000, 49000];
const THERMS = [9000, 8000, 5000, 2500, 1200, 600, 500, 550, 900, 2500, 5500, 8500];
const KW = [120, 118, 115, 130, 150, 190, 210, 205, 170, 140, 116, 119];
function lowest3Avg(a) {
  return (
    a
      .slice()
      .sort((x, y) => x - y)
      .slice(0, 3)
      .reduce((s, v) => s + v, 0) / 3
  );
}
const E_BASE = lowest3Avg(KWH); // 47000
const G_BASE = lowest3Avg(THERMS); // 550
const EXP_COOL = KWH.reduce((s, v) => s + Math.max(0, v - E_BASE), 0);
const EXP_HEAT = THERMS.reduce((s, v) => s + Math.max(0, v - G_BASE), 0);

const yms = KWH.map((_, i) => '2025-' + String(i + 1).padStart(2, '0'));
const elecBL = {
  months: yms,
  rows: yms.map((ym, i) => ({ ym, bill: { kwh: KWH[i], billedKW: KW[i], demandKW: KW[i] } })),
  // A regression with strong HDD and CDD terms: the old page 4 built cooling and electric heating from it.
  regrCoeffs: { type: 'dual', intercept: 20000, slopeHDD: 25.5, slopeCDD: 40.25 },
  regrType: 'dual',
  r2: 0.9,
};
const gasBL = {
  months: yms,
  rows: yms.map((ym, i) => ({ ym, bill: { therms: THERMS[i] } })),
  regrCoeffs: null,
  regrType: '-',
  r2: null,
};
const wxByYm = {};
yms.forEach((ym, i) => {
  wxByYm[ym] = {
    hdd: [900, 780, 600, 300, 100, 10, 0, 0, 40, 250, 550, 800][i],
    cdd: [0, 0, 0, 10, 60, 250, 380, 340, 150, 20, 0, 0][i],
  };
});

// ---------------------------------------------------------------------------
// Sandbox with the REAL functions (extracted verbatim).
// ---------------------------------------------------------------------------
const bldg = {
  id: 'b1',
  name: 'Synthetic School',
  meters: [
    { commodity: 'Electric', bills: [{}], baseline: { months: yms } },
    { commodity: 'Gas', bills: [{}], baseline: { months: yms } },
  ],
};
// Multi-meter building: two gas meters + one EXCLUDED gas meter, two electric meters.
const G1 = [900, 800, 500, 250, 120, 60, 50, 55, 90, 250, 550, 850];
const G2 = [90, 80, 50, 25, 12, 6, 5, 5, 9, 25, 55, 85];
const GX = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
const E1 = [30000, 29000, 28000, 31000, 36000, 46000, 55000, 53000, 42000, 32000, 27000, 29000];
const E2 = [3000, 2900, 2800, 3100, 3600, 4600, 5500, 5300, 4200, 3200, 2700, 2900];
const mm = (id, commodity, data) => ({ id, commodity, bills: [{}], data, baseline: { months: ['2025-01'] } });
const bldg2 = {
  id: 'b2',
  name: 'Synthetic Multi',
  meters: [mm('g1', 'Gas', G1), mm('g2', 'Gas', G2), mm('gExcl', 'Gas', GX), mm('e1', 'Electric', E1), mm('e2', 'Electric', E2)],
};

const src = [
  loadFn(HV, '_hvacLowestNAvg'),
  loadFn(HV, '_hvacPopulatedCount'),
  loadFn(HV, 'computeHvacEnduse'),
  loadFn(WD, '_wdRoundHalfUp'),
  loadFn(WD, '_wdIsSummer'),
  loadFn(WD, '_wdBillTherms'),
  loadFn(WD, '_wdBaselineHvac', true),
  loadFn(WD, '_wdComputeHvacSplit'),
  loadFn(WD, 'wdComputeSetpointOptions'),
  loadFn(CALC, '_hvlMonthlyBaseline'),
  loadFn(CALC, '_hvlMeterMoMap', true),
  loadFn(CALC, '_hvlEnduseForBuilding', true),
  loadFn(CALC, '_hvlBuildingHeatingSignals'),
  loadFn(CALC, '_hvlDefaultGasPct'),
  loadFn(CALC, '_hvlGasHeatShare'),
  loadFn(CALC, 'hvacComputeGasThermsForBuilding'),
  loadFn(CALC, 'hvacComputeElecCoolKwhForBuilding'),
].join('\n\n');
const EXCLUDED = { gExcl: true };
const sandbox = {
  console,
  isBaselineExcluded: (pid, id) => !!EXCLUDED[id],
  SUMMER_MOS: [5, 6, 7, 8],
  resolveGasUsageTherms: (bill) => bill.therms || 0,
  getUDBldg: (pid, id) => (id === 'b2' ? bldg2 : bldg),
  getWeatherForBuilding: () => ({ byYm: {} }),
  getNormRows: () => [{ ym: '2025-01' }],
  buildMoMap: (meter) => {
    if (meter.data) {
      const e = {},
        g = {};
      for (let mo = 0; mo < 12; mo++) {
        if (meter.commodity === 'Electric') e[mo] = { kwh: meter.data[mo], billedKW: 1 };
        if (meter.commodity === 'Gas') g[mo] = { therms: meter.data[mo] };
      }
      return { elecByMo: e, gasByMo: g };
    }
    const elecByMo = {},
      gasByMo = {};
    for (let mo = 0; mo < 12; mo++) {
      if (meter.commodity === 'Electric') elecByMo[mo] = { kwh: KWH[mo], billedKW: KW[mo] };
      if (meter.commodity === 'Gas') gasByMo[mo] = { therms: THERMS[mo] };
    }
    return { elecByMo, gasByMo };
  },
  _parseISO: () => 0,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'hvac-split-single.js' });

// ---------------------------------------------------------------------------
// 1. Report page 4 = baseload method (not regression)
// ---------------------------------------------------------------------------
const h = sandbox._wdComputeHvacSplit(elecBL, gasBL, wxByYm);
assert(near(h.coolKwh, EXP_COOL, 0.5), 'page 4 cooling kWh = baseload method ' + EXP_COOL + ', got ' + h.coolKwh);
assert(near(h.gasHeatTherms, EXP_HEAT, 0.5), 'page 4 gas heating Therms = ' + EXP_HEAT + ', got ' + h.gasHeatTherms);
assert(h.heatKwh == null, 'page 4 electric heating kWh is not separated (null), got ' + h.heatKwh);
assert(h.heatKwhPct == null, 'page 4 electric heating share is null, got ' + h.heatKwhPct);
assert(h.slopeCDD == null && h.slopeHDD == null, 'page 4 carries no regression slope');

// ---------------------------------------------------------------------------
// 2. Report setpoint options read the same baseload numbers
// ---------------------------------------------------------------------------
const cfg = {
  zonesTotal: 10,
  zonesActive: 10,
  pctPerDegF: 3,
  curOccCool: 74,
  curOccHeat: 70,
  occCoolSharePct: 100,
  occHeatSharePct: 100,
  unoccNetTherms: 0,
  demandFloorKw: 100,
  options: [{ letter: 'A', heatSP: 70, coolSP: 76 }],
};
const so = sandbox.wdComputeSetpointOptions(cfg, elecBL, gasBL);
assert(
  near(so.baseline.sumCool, EXP_COOL, 0.5),
  'setpoint options cooling kWh = page 4 (' + EXP_COOL + '), got ' + so.baseline.sumCool,
);
assert(
  near(so.baseline.sumHeat, EXP_HEAT, 0.5),
  'setpoint options heating Therms = page 4 (' + EXP_HEAT + '), got ' + so.baseline.sumHeat,
);
assert(near(so.baseline.sumCool, h.coolKwh, 0.5), 'page 4 and setpoint options read the same cooling kWh');

// ---------------------------------------------------------------------------
// 3. BAS Calc autofill reads the same numbers
// ---------------------------------------------------------------------------
const cool = sandbox.hvacComputeElecCoolKwhForBuilding('p1', 'b1');
assert(
  cool && near(cool.coolingKwh, EXP_COOL, 0.5),
  'BAS Calc cooling kWh = ' + EXP_COOL + ', got ' + (cool && cool.coolingKwh),
);
const gas = sandbox.hvacComputeGasThermsForBuilding('p1', 'b1');
assert(
  gas && near(gas.hvacGasT, EXP_HEAT, 0.5),
  'BAS Calc gas heating Therms = ' + EXP_HEAT + ', got ' + (gas && gas.hvacGasT),
);

// ---------------------------------------------------------------------------
// 3b. Multi-meter building: every INCLUDED meter counts, an excluded meter does not
// ---------------------------------------------------------------------------
const sumArr = (a, b) => a.map((v, i) => v + b[i]);
const expGas = sumArr(G1, G2);
const expElec = sumArr(E1, E2);
const expMultiHeat = expGas.reduce((s, v) => s + Math.max(0, v - lowest3Avg(expGas)), 0);
const expMultiCool = expElec.reduce((s, v) => s + Math.max(0, v - lowest3Avg(expElec)), 0);
const mgas = sandbox.hvacComputeGasThermsForBuilding('p1', 'b2');
assert(mgas && near(mgas.hvacGasT, expMultiHeat, 0.5), 'multi-meter gas heating sums included meters (' + expMultiHeat + '), got ' + (mgas && mgas.hvacGasT));
const mcool = sandbox.hvacComputeElecCoolKwhForBuilding('p1', 'b2');
assert(mcool && near(mcool.coolingKwh, expMultiCool, 0.5), 'multi-meter cooling kWh sums both electric meters (' + expMultiCool + '), got ' + (mcool && mcool.coolingKwh));

// ---------------------------------------------------------------------------
// 3c. 24-month baseline: Page 4 and setpoint options average the two years (one 12-month year)
// ---------------------------------------------------------------------------
const yms24 = [];
[2024, 2025].forEach((y) => KWH.forEach((_, i) => yms24.push(y + '-' + String(i + 1).padStart(2, '0'))));
const elec24 = {
  months: yms24,
  rows: yms24.map((ym, i) => ({ ym, bill: { kwh: KWH[i % 12] * (i < 12 ? 0.9 : 1.1), billedKW: 100 } })),
  regrCoeffs: null,
};
const gas24 = { months: yms24, rows: yms24.map((ym, i) => ({ ym, bill: { therms: THERMS[i % 12] * (i < 12 ? 0.9 : 1.1) } })), regrCoeffs: null };
const h24 = sandbox._wdComputeHvacSplit(elec24, gas24);
assert(near(h24.coolKwh, EXP_COOL, 1), '24-month Page 4 cooling = one averaged year (' + EXP_COOL + '), got ' + h24.coolKwh);
assert(near(h24.elecKwh, KWH.reduce((s, v) => s + v, 0), 1), '24-month Page 4 annual kWh is one year, got ' + h24.elecKwh);
assert(near(h24.gasHeatTherms, EXP_HEAT, 1), '24-month Page 4 gas heating = one averaged year (' + EXP_HEAT + '), got ' + h24.gasHeatTherms);
const so24 = sandbox.wdComputeSetpointOptions(cfg, elec24, gas24);
assert(near(so24.baseline.sumCool, EXP_COOL, 1), '24-month setpoint cooling = one averaged year, got ' + so24.baseline.sumCool);

// ---------------------------------------------------------------------------
// 4. Obsolete regression HVAC paths are gone (static)
// ---------------------------------------------------------------------------
const calcSrc = read('app/calculators.js');
const wdSrc = read('app/report-engine-woodland.js');
const gfxSrc = read('app/graphics-setpoints.js');
assert(!/wdComputeHvacSplitForBuilding/.test(calcSrc + wdSrc), 'wdComputeHvacSplitForBuilding is deleted');
assert(!/slopeHDD/.test(loadFn(WD, '_wdComputeHvacSplit')), '_wdComputeHvacSplit does not read a regression slope');
assert(!/coolPctOfHvac\s*=\s*0\.65/.test(calcSrc), 'Load Estimate has no fixed 0.65/0.35 cooling/heating split');
assert(!/kwhSum|gasSum|kwSum/.test(gfxSrc), 'Energy Graphics HVAC card has no private monthly sums');
assert(
  calcSrc.indexOf(
    'Electric heating is not separated by the baseload method. Enter a value, or save an HVAC Load Estimate.',
  ) >= 0,
  'BAS Calc heating kWh label text is present',
);
assert(!/Not found in the electric bills/.test(calcSrc), 'old regression "not found" label is gone');

console.log(`\ntest-hvac-split-single: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
