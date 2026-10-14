// tools/test-hvac-quick-annual.js — SYNTHETIC tests for Phase 3 (2026-10-13): quick annual entry +
// the one data-source resolver the HVAC Load Estimate reads.
//   1. resolveHvacLoadData order: baseline bills (full year) -> annual entry -> nothing; fewer than 6
//      bill months still use the bills unless the user entered annual totals; the annual entry is
//      reported as not used when bills win.
//   2. Annual path in hvacLoadCalc: Rules of Thumb on the annual totals, NO monthly arrays (never
//      faked), propane gallons rolled into Therms, entered peak kW used as-is.
//   3. Static gate: hvacLoadCalc reads data only through resolveHvacLoadData (no direct
//      _hvlMonthlyBaseline / quickAnnual / bill reads); b.quickAnnual is touched only by the
//      resolver, its reader, and the entry-box functions.
// Real functions are extracted verbatim from app/calculators.js into a Node vm. Fixtures are synthetic.
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

function fnSource(src, fnName) {
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  const p = src.indexOf('(', m.index);
  let d = 0;
  let e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  const i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}

const CALC_SRC = fs.readFileSync(path.join(REPO, 'app', 'calculators.js'), 'utf8');
const ENDUSE_SRC = fs.readFileSync(path.join(REPO, 'computations', 'hvac-enduse.js'), 'utf8');
const code = [
  fs.readFileSync(path.join(REPO, 'computations', 'physics.js'), 'utf8'),
  fnSource(ENDUSE_SRC, '_hvacLowestNAvg'),
  fnSource(ENDUSE_SRC, '_hvacPopulatedCount'),
  fnSource(ENDUSE_SRC, 'computeHvacEnduse'),
  'var _hvlSelBldg = {}; var _hvlMethod = {};',
  fnSource(CALC_SRC, '_hvlKey'),
  fnSource(CALC_SRC, '_hvlMonthlyBaseline'),
  fnSource(CALC_SRC, '_hvlMeterMoMap'),
  fnSource(CALC_SRC, 'getHvacQuickAnnual'),
  fnSource(CALC_SRC, 'resolveHvacLoadData'),
  fnSource(CALC_SRC, 'hvacLoadCalc'),
].join('\n\n');

// Synthetic building: elecMonths / gasMonths bill months populated (kWh 10,000 and Therms 500 each).
function makeSandbox(bldgOverrides, elecMonths, gasMonths, fields) {
  const bldg = Object.assign(
    {
      id: 'b1',
      name: 'Synthetic Test Building',
      sqft: 50000,
      meters: [
        ...(elecMonths ? [{ commodity: 'Electric', bills: [{}], baseline: { months: ['2026-01'] } }] : []),
        ...(gasMonths ? [{ commodity: 'Gas', bills: [{}], baseline: { months: ['2026-01'] } }] : []),
      ],
    },
    bldgOverrides || {},
  );
  const projects = [{ id: 7, name: 'Synthetic Project' }];
  const f = Object.assign({ kwhPct: 45, coolKwhPct: 65, heatKwhPct: 0, kwPct: 55, gasPct: 80 }, fields || {});
  const sb = {
    console,
    projects,
    getUDBldg: () => bldg,
    getUDBldgs: () => [bldg],
    getWeatherForBuilding: () => ({ byYm: {} }),
    getNormRows: () => [{ ym: '2026-01' }],
    sset: () => {},
    buildMoMap: (meter) => {
      if (meter.commodity === 'Electric') {
        const elecByMo = {};
        for (let mo = 0; mo < elecMonths; mo++) elecByMo[mo] = { kwh: 10000, billedKW: 100 };
        return { elecByMo };
      }
      const gasByMo = {};
      for (let mo = 0; mo < gasMonths; mo++) gasByMo[mo] = { therms: 500 };
      return { gasByMo };
    },
    document: {
      getElementById: (id) => {
        const m = /^hvl-t-(\w+)-7$/.exec(id);
        return m && f[m[1]] != null ? { value: String(f[m[1]]) } : null;
      },
    },
  };
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'hvac-quick-annual.js' });
  sb._bldg = bldg;
  return sb;
}

console.log('--- 1. resolver order ---');
{
  const quick = { year: '2025', kwh: 600000, therms: 20000, propaneGal: 0, peakKw: 250 };
  let sb = makeSandbox({ quickAnnual: quick }, 12, 12);
  let r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(r.source === 'bills', 'bills + annual entry -> bills win');
  assert(r.label === 'From 12 baseline bills', 'bills label: ' + r.label);
  assert(near(r.kwh, 120000) && near(r.therms, 6000) && near(r.kw, 1200), 'bills totals are the monthly sums');
  assert(r.quickUsed === false && r.quick && r.quick.kwh === 600000, 'annual entry kept but reported not used');

  sb = makeSandbox({ quickAnnual: quick }, 0, 0);
  r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(r.source === 'annual', 'no bills + annual entry -> annual');
  assert(r.label === 'From annual totals you entered (2025)', 'annual label: ' + r.label);
  assert(r.kwh === 600000 && r.therms === 20000 && r.kw === 250, 'annual totals returned as entered');
  assert(r.quickUsed === true, 'annual entry reported used');
  assert(Object.keys(r.elecByMo).length === 0 && Object.keys(r.gasByMo).length === 0, 'no fake monthly maps');

  sb = makeSandbox({}, 0, 0);
  r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(r.source === 'none' && r.kwh === 0 && r.therms === 0, 'nothing -> none');

  sb = makeSandbox({ quickAnnual: quick }, 3, 3);
  r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(r.source === 'annual', '3 bill months + annual entry -> annual (3 bills are not a baseline)');
  sb = makeSandbox({}, 3, 3);
  r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(
    r.source === 'bills' && /less than 6 months/.test(r.label),
    '3 bill months, no annual entry -> bills, flagged short',
  );

  sb = makeSandbox({ quickAnnual: { year: '2025', kwh: 0, therms: 0, propaneGal: 0, peakKw: 5 } }, 0, 0);
  assert(sb.resolveHvacLoadData(7, sb._bldg).source === 'none', 'annual entry with no kWh/Therms/propane -> ignored');

  sb = makeSandbox({ quickAnnual: { year: '2024', kwh: 1000, therms: 100, propaneGal: 100, peakKw: 0 } }, 0, 0);
  r = sb.resolveHvacLoadData(7, sb._bldg);
  assert(near(r.therms, 100 + 100 * sb.THERMS_PER_GAL_PROPANE), 'propane gallons added as Therms (shared factor)');
}

console.log('--- 2. annual path in hvacLoadCalc ---');
{
  const quick = { year: '2025', kwh: 600000, therms: 20000, propaneGal: 0, peakKw: 250 };
  let sb = makeSandbox({ quickAnnual: quick }, 0, 0);
  sb._hvlSelBldg[7] = 'b1';
  sb.hvacLoadCalc(7, { persist: false });
  let e = sb.projects[0].hvacLoadEst;
  assert(
    e && e.dataSource === 'annual' && e.monthly === false,
    'estimate stored with dataSource annual, monthly false',
  );
  assert(near(e.totalKwh, 600000) && near(e.totalGas, 20000) && near(e.totalKw, 250), 'totals are the annual entry');
  assert(near(e.hvacKwh, 270000), 'HVAC kWh = 45% of annual kWh');
  assert(near(e.coolKwhTotal, 270000) && near(e.heatKwhTotal, 0), 'cooling = remainder of HVAC kWh, heating 0');
  assert(near(e.hvacGasT, 16000), 'HVAC Therms = 80% of annual Therms');
  assert(near(e.hvacKw, 137.5), 'HVAC kW = 55% of entered peak kW');
  assert(
    e.monthlyCoolKwh === null && e.monthlyHvacGas === null && e.monthlyTotalKw === null,
    'no monthly arrays (not faked)',
  );

  sb = makeSandbox({ quickAnnual: quick }, 12, 12);
  sb._hvlSelBldg[7] = 'b1';
  sb.hvacLoadCalc(7, { persist: false });
  e = sb.projects[0].hvacLoadEst;
  assert(e.dataSource === 'bills' && e.monthly === true, 'with 12 bills the estimate switches to bills');
  assert(near(e.totalKwh, 120000) && near(e.totalGas, 6000), 'bills totals replace the annual entry');
  assert(Array.isArray(e.monthlyCoolKwh) && e.monthlyCoolKwh.length === 12, 'bills path keeps monthly arrays');
  assert(
    near(
      e.monthlyTotalKw.reduce((s, v) => s + v, 0),
      1200,
    ),
    'bills kW is the sum of 12 billed months',
  );
}

console.log('--- 3. static gate: HVAC Load Estimate reads data only through the resolver ---');
{
  const calc = fnSource(CALC_SRC, 'hvacLoadCalc');
  assert(/resolveHvacLoadData\(/.test(calc), 'hvacLoadCalc calls resolveHvacLoadData');
  assert(!/_hvlMonthlyBaseline\(/.test(calc), 'hvacLoadCalc does not call _hvlMonthlyBaseline');
  assert(!/quickAnnual/.test(calc), 'hvacLoadCalc does not touch quickAnnual');
  assert(
    !/\.bills\b|getNormRows|buildMoMap|getMeterBaselineTotals|annualBenchmarks/.test(calc),
    'hvacLoadCalc reads no bill data',
  );
  const exp = fnSource(CALC_SRC, '_hvlBuildExportData');
  assert(!/_hvlMonthlyBaseline\(/.test(exp) && /resolveHvacLoadData\(/.test(exp), 'export reads through the resolver');
  const allowed = new Set([
    'getHvacQuickAnnual',
    'resolveHvacLoadData',
    '_hvlRenderSourceCard',
    'hvacQuickAnnualSave',
    'hvacQuickAnnualClear',
  ]);
  const re = /^function (\w+)\s*\(/gm;
  let m;
  const starts = [];
  while ((m = re.exec(CALC_SRC))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    const body = CALC_SRC.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : CALC_SRC.length);
    // Comment lines between functions belong to the previous slice; strip them before testing.
    if (/quickAnnual/.test(body.replace(/^\s*\/\/.*$/gm, ''))) {
      assert(allowed.has(s.name), 'quickAnnual used only by the resolver and entry box (found in ' + s.name + ')');
    }
  });
  // Nothing outside calculators.js reads b.quickAnnual either.
  const others = ['app', 'computations'].flatMap((d) =>
    fs
      .readdirSync(path.join(REPO, d))
      .filter((f) => f.endsWith('.js') && f !== 'calculators.js')
      .map((f) => ({ f: d + '/' + f, s: fs.readFileSync(path.join(REPO, d, f), 'utf8') })),
  );
  others.forEach((o) => assert(!/quickAnnual/.test(o.s), 'no other file reads quickAnnual (' + o.f + ')'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
