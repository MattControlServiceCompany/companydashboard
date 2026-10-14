// tools/test-hvac-per-building.js — SYNTHETIC tests for the Phase 4 foundation (2026-10-13):
//   1. The HVAC Load Estimate is stored PER BUILDING (b.hvacLoad), so two buildings calculated in turn keep their
//      own estimate; the project roll-up is computed from the buildings and is never stored.
//   2. ONE data path: resolveHvacLoadData sums every included meter, ignores an excluded meter, and a month no
//      bill ends in is null (never a fake 0).
//   3. ONE demand function (computeHvacDemand): sum of monthly billed kW, highest month, Facilities kW sum,
//      and the month that set the Facilities kW (it follows the highest billed kW of the last 12 months).
//   4. The one-time data move (migrateHvacLoadToBuildings): project estimate -> per-building, recalculated from
//      the resolver, saved inputs moved, old project fields removed, runs once.
//   5. Static gates: no reader of the old project fields; bills are read only by _hvlMeterMoMap /
//      _hvlMonthlyBaseline; every HVAC end-use / baseline reader goes through resolveHvacLoadData; the peak is
//      decided in one place (_hvacPeakOf).
// Real functions are extracted verbatim from the app files into a Node vm. Fixtures are synthetic.
// Run: node tools/test-hvac-per-building.js
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
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const CALC = read('app/calculators.js');
const ENDUSE = read('computations/hvac-enduse.js');
// the report engine file that defines _wdBaselineHvac (found by content, not by a client-named path)
const WD = fs
  .readdirSync(path.join(REPO, 'app'))
  .filter((f) => /^report-engine-.*\.js$/.test(f))
  .map((f) => read('app/' + f))
  .find((s) => /function _wdBaselineHvac\s*\(/.test(s));

const code = [
  read('computations/physics.js'),
  fnSource(ENDUSE, '_hvacLowestNAvg'),
  fnSource(ENDUSE, '_hvacPopulatedCount'),
  fnSource(ENDUSE, '_hvacPeakOf'),
  fnSource(ENDUSE, 'computeHvacEnduse'),
  fnSource(ENDUSE, 'computeHvacDemand'),
  fnSource(ENDUSE, 'computeHvacMonthlyProfiles'),
  'var MO_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];',
  'var _hvlSelBldg = {}; var _hvlMethod = {}; var _hvlDirty = {}; const _hvlLive = {};',
  'const SAVE_ALL_PROJECTS = Symbol("all");',
  fnSource(CALC, '_hvlKey'),
  fnSource(CALC, '_hvlMeterMoMap'),
  require('./month-rule-src.js')(),
  fnSource(CALC, '_hvlMergeMoMaps'),
  fnSource(CALC, '_hvlMonthlyBaseline'),
  fnSource(CALC, 'getHvacQuickAnnual'),
  fnSource(WD, '_wdHvacFullYear'),
  fnSource(CALC, 'resolveHvacLoadData'),
  fnSource(CALC, 'computeHvacLoadEstimate'),
  fnSource(CALC, 'hvacLoadStoredFor'),
  fnSource(CALC, 'hvacEstimateForBuilding'),
  fnSource(CALC, 'hvlBasisLabel'),
  fnSource(CALC, 'hvacLoadProjectRollup'),
  'const _HVL_ROLLUP_FIELDS = ' + /const _HVL_ROLLUP_FIELDS = (\[[\s\S]*?\]);/.exec(CALC)[1] + ';',
  fnSource(CALC, '_hvlFieldsFor'),
  fnSource(CALC, '_hvlPrefix'),
  fnSource(CALC, '_hvlCaptureInputs'),
  fnSource(CALC, '_hvlSavedLabel'),
  fnSource(CALC, '_hvlUpdateSaveUI'),
  fnSource(CALC, '_hvlRenderRollup'),
  fnSource(CALC, 'hvacLoadCalc'),
  fnSource(CALC, 'hvacLoadSave'),
  fnSource(CALC, '_hvlDemandHtml'),
  fnSource(CALC, '_hvlDefaultGasPct'),
  fnSource(CALC, '_hvlBuildingHeatingSignals'),
  fnSource(CALC, '_hvlGasHeatShare'),
  fnSource(CALC, '_hvlThumbDefaults'),
  fnSource(CALC, '_hvlKeepTypedPercents'),
  fnSource(CALC, 'migrateHvacLoadToBuildings'),
].join('\n\n');

const YMS = Array.from({ length: 12 }, (_, i) => '2026-' + String(i + 1).padStart(2, '0'));
const billsFor = (yms) => yms.map((ym) => ({ start: ym + '-01', end: ym + '-28' }));

// Meter fixtures. `data` = per-calendar-month values the stubbed buildMoMap hands back.
const meter = (id, commodity, data, opts) =>
  Object.assign({ id, commodity, bills: billsFor(YMS), baseline: { months: YMS }, data }, opts || {});
const E_A = [9000, 8000, 8500, 9500, 11000, 14000, 16000, 15500, 12000, 9800, 8700, 9100];
const KW_A = [100, 98, 99, 110, 130, 160, 175, 170, 140, 112, 100, 101];
const FAC_A = [175, 175, 175, 175, 175, 175, 175, 175, 175, 175, 175, 175];
const G_A = [4000, 3500, 2500, 1200, 500, 300, 250, 260, 400, 1200, 2500, 3800];
const E_B = [3000, 2900, 3100, 3300, 3600, 4200, 4800, 4700, 3900, 3300, 3000, 3000];
const G_B = [900, 800, 600, 300, 150, 90, 80, 85, 120, 300, 600, 850];

function makeEnv() {
  const store = { en_projects: [{ id: 7, name: 'Synthetic District', scope: { meterExcludeIds: ['eX'] } }] };
  const bldgs = [
    {
      id: 'bA',
      name: 'Synthetic School A',
      sqft: 60000,
      meters: [
        meter('eA', 'Electric', { e: E_A, kw: KW_A, fac: FAC_A }),
        meter('gA', 'Gas', { g: G_A }),
        // an excluded electric meter: must add nothing
        meter('eX', 'Electric', { e: E_A, kw: KW_A, fac: FAC_A }),
      ],
    },
    {
      id: 'bB',
      name: 'Synthetic School B',
      sqft: 30000,
      meters: [
        meter('eB1', 'Electric', { e: E_B, kw: E_B.map((v) => v / 30) }),
        meter('eB2', 'Electric', { e: E_B, kw: E_B.map((v) => v / 30) }),
        meter('gB', 'Gas', { g: G_B }),
      ],
    },
    { id: 'bC', name: 'Synthetic Empty Building', sqft: 10000, meters: [] },
  ];
  const flags = {};
  const calls = { saveUtility: 0 };
  const fields = { kwhPct: 45, coolKwhPct: 65, heatKwhPct: 0, kwPct: 55, gasPct: 80 };
  const sb = {
    console,
    store,
    flags,
    calls,
    fields,
    shown: {},
    bldgs,
    getUDBldgs: () => bldgs,
    getUDBldg: (pid, id) => bldgs.find((b) => b.id === id),
    isBaselineExcluded: (pid, id) => id === 'eX',
    getWeatherForBuilding: () => ({ byYm: {} }),
    getNormRows: () => YMS.map((ym) => ({ ym })),
    _parseISO: (s) => new Date(s),
    buildMoMap: (m) => {
      const d = m.data || {};
      const out = {};
      if (m.commodity === 'Electric') {
        out.elecByMo = {};
        for (let mo = 0; mo < 12; mo++)
          out.elecByMo[mo] = { kwh: d.e[mo], billedKW: d.kw ? d.kw[mo] : 0, facKW: d.fac ? d.fac[mo] : 0 };
      } else if (m.commodity === 'Gas') {
        out.gasByMo = {};
        for (let mo = 0; mo < 12; mo++) out.gasByMo[mo] = { therms: d.g[mo] };
      } else if (m.commodity === 'Propane') {
        // like the real buildMoMap: an entry for EVERY baseline month, 0 gallons when no delivery ended there
        out.propaneByMo = {};
        for (let mo = 0; mo < 12; mo++) out.propaneByMo[mo] = { gallons: d.p[mo] };
      }
      return out;
    },
    sget: (k, fb) => (store[k] !== undefined ? store[k] : fb),
    sset: (k, v) => {
      store[k] = v;
    },
    DB: { get: (k) => flags[k], set: (k, v) => (flags[k] = v) },
    saveUtilityData: () => {
      calls.saveUtility++;
    },
    showToast: () => {},
    // DOM stub: method inputs by id, everything else (result boxes) absent
    document: {
      getElementById: (id) => {
        const m = /^hvl-t-(\w+)-7$/.exec(id);
        return m && sb.fields[m[1]] != null
          ? { value: String(sb.fields[m[1]]), dataset: { default: String(sb.shown[m[1]] != null ? sb.shown[m[1]] : sb.fields[m[1]]) } }
          : null;
      },
    },
    emLoadMatrix: undefined,
  };
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'hvac-per-building.js' });
  return sb;
}

// -------------------------------------------------------------------------------------------------
console.log('--- 1. computeHvacDemand: both bases, Facilities kW and the month that set it ---');
{
  const sb = makeEnv();
  const billed = [100, 98, 99, 110, 130, 160, 175, 170, 140, 112, 100, 101];
  const fac = Array(12).fill(null);
  [5, 6, 7, 8, 9, 10, 11].forEach((mo) => (fac[mo] = 175));
  [0, 1, 2, 3, 4].forEach((mo) => (fac[mo] = 150));
  const recs = [
    { ym: '2025-08', kw: 150 },
    { ym: '2026-07', kw: 175 },
    { ym: '2026-08', kw: 170 },
  ];
  const d = sb.computeHvacDemand(billed, fac, recs);
  assert(
    near(
      d.billedSum,
      billed.reduce((s, v) => s + v, 0),
    ),
    'billed sum is the sum of the 12 months, got ' + d.billedSum,
  );
  assert(d.billedPeak === 175 && d.billedPeakMonth === 6, 'billed peak 175 in July (index 6)');
  assert(near(d.facSum, 7 * 175 + 5 * 150), 'Facilities sum of the 12 monthly values, got ' + d.facSum);
  assert(d.facPeak === 175 && d.facPeakMonth === 5, 'Facilities highest 175, first in June');
  assert(d.facSetYm === '2026-07', 'Facilities kW 175 was set by the 2026-07 bill, got ' + d.facSetYm);
  assert(d.hasBilled && d.hasFac, 'flags set');
  const none = sb.computeHvacDemand(Array(12).fill(null), Array(12).fill(null), []);
  assert(!none.hasBilled && !none.hasFac && none.billedSum === 0 && none.facSetYm === null, 'no data -> empty');
  const zero = sb.computeHvacDemand([0, 5, null, 7], [], []);
  assert(
    zero.billedKw[0] === null && zero.billedSum === 12 && zero.billedPeak === 7,
    'a 0 kW reading is not a reading',
  );

  // Rolling-peak rule (same rule as backfillFacilitiesKW, app/csv-import.js): a bill's Facilities kW is the
  // highest billed kW of the bills that START within one year before this bill starts, through this bill.
  const bills = [];
  const kws = [300, 320, 310, 290, 400, 380, 350, 340, 330, 320, 310, 300, 295, 290, 285, 280, 275, 270];
  kws.forEach((kw, i) => {
    const y = 2024 + Math.floor(i / 12);
    const mo = (i % 12) + 1;
    bills.push({ start: y + '-' + String(mo).padStart(2, '0') + '-01', kw });
  });
  const ws = (s) => {
    const d0 = new Date(s);
    d0.setFullYear(d0.getFullYear() - 1);
    return d0;
  };
  bills.forEach((b, i) => {
    let peak = 0;
    for (let j = 0; j <= i; j++) if (new Date(bills[j].start) >= ws(b.start)) peak = Math.max(peak, bills[j].kw);
    b.fac = peak;
  });
  const late = bills[16]; // 2025-05: the 2024-05 bill (400) is still inside the one-year window
  assert(late.fac === 400, 'synthetic rolling peak: 400 (set 2024-05) is still the 12-month highest in 2025-05');
  assert(bills[17].fac === 380, 'one month later 2024-05 has dropped out of the window, the highest is 380');
  const dd = sb.computeHvacDemand(
    [null, null, null, null, null, late.kw, null, null, null, null, null, null],
    [null, null, null, null, null, late.fac, null, null, null, null, null, null],
    bills.map((b) => ({ ym: b.start.slice(0, 7), kw: b.kw })),
  );
  assert(
    dd.facPeak === 400 && dd.facSetYm === '2024-05',
    'Facilities kW 400 traced to the 2024-05 bill, got ' + dd.facSetYm,
  );
}

// -------------------------------------------------------------------------------------------------
console.log('--- 2. resolver: included meters summed, excluded meter ignored, no fake zero months ---');
{
  const sb = makeEnv();
  const a = sb.bldgs[0];
  let r = sb.resolveHvacLoadData(7, a);
  const sumE = E_A.reduce((s, v) => s + v, 0);
  assert(r.source === 'bills' && near(r.kwh, sumE), 'excluded second electric meter adds nothing, kWh ' + r.kwh);
  assert(
    near(
      r.kw,
      KW_A.reduce((s, v) => s + v, 0),
    ),
    'kw is the SUM of monthly billed kW',
  );
  assert(near(r.demand.billedSum, r.kw) && near(r.demand.billedPeak, 175), 'demand function agrees with the resolver');
  assert(near(r.demand.facSum, 12 * 175), 'Facilities kW sum from the same data path');
  const b = sb.bldgs[1];
  r = sb.resolveHvacLoadData(7, b);
  assert(near(r.kwh, 2 * E_B.reduce((s, v) => s + v, 0)), 'two included electric meters are added, kWh ' + r.kwh);
  assert(
    near(
      r.therms,
      G_B.reduce((s, v) => s + v, 0),
    ),
    'gas Therms summed',
  );
  assert(sb.resolveHvacLoadData(7, sb.bldgs[2]).source === 'none', 'building with no meters -> none');
  const onlyExcluded = { id: 'bX', name: 'Excluded Only', meters: [sb.bldgs[0].meters[2]] };
  r = sb.resolveHvacLoadData(7, onlyExcluded);
  assert(r.source === 'none' && /excluded/.test(r.label), 'a building whose meters are all excluded says so, got: ' + r.label);

  // A month no bill falls in stays null: the Feb bill is missing (one billMonth rule, the chain), so Feb has no bill.
  const feb = sb.bldgs[1];
  const shifted = billsFor(YMS).filter((x, i) => i !== 1);
  feb.meters[0].bills = shifted;
  feb.meters[1].bills = shifted;
  feb.meters[2].bills = shifted;
  r = sb.resolveHvacLoadData(7, feb);
  assert(r.kwhArr[1] === null, 'a month no bill falls in is null, not 0');
  assert(r.kwhArr[2] !== null, 'the month a bill falls in is populated');
  assert(r.billMonths === 11, '11 populated months, got ' + r.billMonths);
  assert(r.enduse.elecValid, '11 populated months still give a valid baseload');
}

// -------------------------------------------------------------------------------------------------
console.log('--- 3. two buildings calculated in turn each keep their own estimate ---');
{
  const sb = makeEnv();
  sb._hvlSelBldg[7] = 'bA';
  sb.hvacLoadSave(7);
  sb._hvlSelBldg[7] = 'bB';
  sb.hvacLoadSave(7);
  const A = sb.bldgs[0].hvacLoad;
  const B = sb.bldgs[1].hvacLoad;
  assert(A && B && A.est && B.est, 'both buildings have a stored estimate');
  assert(
    near(
      A.est.totalKwh,
      E_A.reduce((s, v) => s + v, 0),
    ),
    'building A keeps its own kWh after B was saved',
  );
  assert(near(B.est.totalKwh, 2 * E_B.reduce((s, v) => s + v, 0)), 'building B has its own kWh');
  assert(A.est.totalKwh !== B.est.totalKwh, 'the two estimates differ');
  assert(A.savedAt > 0 && B.savedAt > 0, 'saved times set');
  assert(A.inputs && A.inputs.thumb && A.inputs.thumb.kwhPct === '45', 'inputs stored on the building');
  assert(sb.calls.saveUtility === 2, 'each save writes the building data once');
  assert(sb.store.en_projects[0].hvacLoadEst === undefined, 'nothing stored on the project');
  const ru = sb.hvacLoadProjectRollup(7);
  assert(ru.buildings === 2 && ru.of === 3 && ru.saved === 2, 'roll-up counts 2 of 3 buildings');
  assert(near(ru.totalKwh, A.est.totalKwh + B.est.totalKwh), 'roll-up totalKwh = sum of the buildings');
  assert(near(ru.hvacKwh, A.est.hvacKwh + B.est.hvacKwh), 'roll-up hvacKwh = sum of the buildings');
  // roll-up is computed: change one building and it follows, no stored copy
  // a stored snapshot is not a source of truth: the roll-up calculates from the bills
  const wantRoll = A.est.hvacKwh + B.est.hvacKwh;
  sb.bldgs[0].hvacLoad.est.hvacKwh = 1;
  assert(
    near(sb.hvacLoadProjectRollup(7).hvacKwh, wantRoll),
    'roll-up ignores a stale stored estimate and calculates from the bills',
  );
  // measured method: cooling = bills above the 3-lowest-month base load
  {
    const base = [...E_A].sort((a, c) => a - c).slice(0, 3).reduce((x, y) => x + y, 0) / 3;
    const cool = E_A.reduce((x, v) => x + Math.max(0, v - base), 0);
    const calc = sb.hvacEstimateForBuilding(7, 'bA');
    assert(near(calc.est.hvacKwh, cool, 1e-6), 'measured HVAC kWh = bills above the base load, not 45% of the total');
    assert(calc.est.basis.hvacKwh === 'measured' && calc.est.basis.hvacGas === 'measured', 'basis says measured');
    assert(calc.est.basis.hvacKw === 'rule', 'demand split is labelled a rule of thumb');
    assert(near(calc.est.monthlyHvacKwh.reduce((x, v) => x + v, 0), cool, 1e-6), 'measured months add up to the annual number');
    assert(near(calc.est.monthlyHvacKwh[0], Math.max(0, E_A[0] - base), 1e-6), 'a measured month is the bill above the base load');
    assert(near(calc.est.hvacKwh + calc.est.nonHvacKwh, calc.est.totalKwh, 1e-6), 'HVAC + non-HVAC = total');
    assert(calc.estimate === 'saved' && calc.method === 'thumb', 'saved building uses its saved method');
    // a typed percentage is an explicit override and wins; the same value as shown is not
    sb.shown.kwhPct = 30; // screen showed 30, person left 45 typed
    sb._hvlSelBldg[7] = 'bA';
    sb.hvacLoadSave(7);
    const ov = sb.hvacEstimateForBuilding(7, 'bA');
    assert(ov.est.basis.hvacKwh === 'override' && near(ov.est.hvacKwh, 0.45 * ov.est.totalKwh, 1e-6), 'typed percentage overrides the measured split');
    sb.shown.kwhPct = 45;
    sb.hvacLoadSave(7);
    assert(sb.hvacEstimateForBuilding(7, 'bA').est.basis.hvacKwh === 'measured', 'a value left at the shown default is not an override');
  }
  // live calc without Save stores nothing
  sb.bldgs[2].meters = [meter('eC', 'Electric', { e: E_B, kw: E_B.map((v) => v / 30) })];
  sb._hvlSelBldg[7] = 'bC';
  sb.hvacLoadCalc(7);
  assert(sb.bldgs[2].hvacLoad === undefined, 'a live calculation (no Save) writes nothing to the building');
}

// -------------------------------------------------------------------------------------------------
console.log('--- 4. one-time data move ---');
{
  const sb = makeEnv();
  sb.store.en_projects[0].hvacLoadEst = { method: 'thumb', totalKwh: 123, hvacGasPct: 80 };
  sb.store.en_projects[0].hvacLoadSavedAt = 1700000000000;
  sb.store.en_projects[0].hvacLoadInputs = {
    bA: { thumb: { kwhPct: '30', kwPct: '55', gasPct: '70', coolKwhPct: '65', heatKwhPct: '0' } },
  };
  const rows = sb.migrateHvacLoadToBuildings();
  const p = sb.store.en_projects[0];
  assert(
    p.hvacLoadEst === undefined && p.hvacLoadSavedAt === undefined && p.hvacLoadInputs === undefined,
    'old project fields removed',
  );
  const A = sb.bldgs[0].hvacLoad;
  const B = sb.bldgs[1].hvacLoad;
  assert(
    A && A.est && A.est.basis.hvacKwh === 'override' && near(A.est.hvacKwhPct, 30),
    'building A: a typed 30% (different from the default, no flag before the move) stays 30% as an override',
  );
  assert(
    A.inputs.thumb.kwhPctOverride === true && A.inputs.thumb.kwPctOverride === false,
    'the move sets the override flag only for the value that differs from the default (kWh yes, kW 55 = default no)',
  );
  assert(A.savedAt === 1700000000000, 'saved time carried over');
  assert(A.inputs.thumb.kwhPct === '30', 'saved inputs moved onto the building');
  assert(
    B && B.est && B.est.basis.hvacKwh === 'measured' && B.savedAt === 1700000000000,
    'building B recalculated from the bills (measured split)',
  );
  assert(near(B.est.totalKwh, 2 * E_B.reduce((s, v) => s + v, 0)), 'building B estimate uses its own resolver data');
  assert(sb.bldgs[2].hvacLoad === undefined, 'building with no utility data gets no estimate');
  assert(
    rows.filter((x) => !/typed percentage kept/.test(x.result)).length === 3 && rows.some((x) => /no utility data/.test(x.result)),
    'report has one row per building',
  );
  assert(rows.some((x) => /typed percentage kept: kwhPct/.test(x.result)), 'report names the typed percentage that was kept');
  // Save on the tab after the move: the screen shows the saved 30, the default is the measured value; 30 stays
  {
    const d = sb._hvlThumbDefaults(7, 'bA');
    Object.assign(sb.fields, { kwhPct: 30, kwPct: 55, gasPct: d.gasPct, coolKwhPct: 65, heatKwhPct: 0 });
    Object.assign(sb.shown, { kwhPct: d.kwhPct, kwPct: d.kwPct, gasPct: d.gasPct });
    sb._hvlSelBldg[7] = 'bA';
    sb.hvacLoadSave(7);
    const after = sb.hvacEstimateForBuilding(7, 'bA');
    assert(
      after.est.basis.hvacKwh === 'override' && near(after.est.hvacKwhPct, 30),
      'typed 30% stays 30% after Save on the tab',
    );
  }
  const again = sb.migrateHvacLoadToBuildings();
  assert(again.length === 0, 'second run does nothing');

  // a building an earlier version already moved holds a typed value without a flag: marked once, then left alone
  {
    const sb3 = makeEnv();
    sb3.bldgs[0].hvacLoad = { savedAt: 1700000000000, est: null, inputs: { thumb: { kwhPct: '30', kwPct: '55', gasPct: '70' } } };
    const r1 = sb3.migrateHvacLoadToBuildings();
    const t = sb3.bldgs[0].hvacLoad.inputs.thumb;
    assert(t.kwhPctOverride === true && t.kwPctOverride === false, 'unflagged typed value of an already-moved building is flagged');
    assert(r1.some((x) => /typed percentage kept: kwhPct/.test(x.result)), 'already-moved building reported');
    assert(sb3.migrateHvacLoadToBuildings().length === 0, 'second run does nothing');
  }

  // a project without any old data is left alone
  const sb2 = makeEnv();
  const none = sb2.migrateHvacLoadToBuildings();
  assert(none.length === 0 && sb2.bldgs.every((b) => b.hvacLoad === undefined), 'no old estimate -> nothing created');
}

// -------------------------------------------------------------------------------------------------
console.log('--- 4a. cooling and electric heating each have their own measured monthly profile ---');
{
  const sb = makeEnv();
  const b = sb.bldgs[0];
  const resolved = sb.resolveHvacLoadData(7, b);
  const base = resolved.enduse.baseloadElec;
  const hv = E_A.map((v) => Math.max(0, v - base));
  const run = (heatPct) =>
    sb.computeHvacLoadEstimate('thumb', resolved, { kwhPct: 45, kwPct: 55, gasPct: 70, coolKwhPct: 65, heatKwhPct: heatPct }, 60000);
  const sum = (a) => a.reduce((x, v) => x + v, 0);
  // gas heat (electric heating 0): cooling has no January, total stays the measured HVAC kWh
  let est = run(0);
  assert(est.monthlyCoolKwh[0] === 0 && est.monthlyCoolKwh[11] === 0, 'no cooling in January or December');
  assert(est.monthlyCoolKwh[6] > hv[6] - 1e-9, 'July cooling is at least the measured July HVAC kWh');
  assert(near(sum(est.monthlyCoolKwh), est.coolKwhTotal, 1e-6) && near(est.coolKwhTotal, est.hvacKwh, 1e-6), 'cooling months add up to the cooling total');
  assert(sum(est.monthlyHeatKwh) === 0, 'no electric heating when the heating share is 0');
  assert(near(sum(est.monthlyHvacKwh), est.hvacKwh, 1e-6) && near(est.monthlyHvacKwh[0], hv[0], 1e-6), 'all electric HVAC of a month stays the measured bill above the base load');
  // electric heat: heating sits in the heating months, cooling in the cooling months, each adds up to its total
  est = run(35);
  assert(est.monthlyHeatKwh[6] === 0 && est.monthlyHeatKwh[7] === 0, 'no electric heating in July or August');
  assert(est.monthlyCoolKwh[0] === 0 && est.monthlyCoolKwh[11] === 0, 'no cooling in January or December with electric heat');
  assert(near(sum(est.monthlyHeatKwh), est.heatKwhTotal, 1e-6) && near(sum(est.monthlyCoolKwh), est.coolKwhTotal, 1e-6), 'each profile adds up to its annual total');
  assert(est.monthlyHeatKwh[0] > 0, 'January carries electric heating');
  // weather decides the season when it exists: a hot February (cooling degree days above heating) is a cooling month
  const wx = Array(12).fill(null);
  const prof = sb.computeHvacMonthlyProfiles(resolved.kwhArr, base, wx.map((_, i) => (i === 1 ? 1 : i <= 3 || i >= 9 ? 500 : 5)), wx.map((_, i) => (i === 1 ? 300 : i <= 3 || i >= 9 ? 10 : 400)));
  assert(prof.heating[1] === 0 && near(prof.cooling[1], hv[1], 1e-9) && prof.seasonBy[1] === 'weather', 'weather decides the season of a month');
  assert(prof.seasonBy[0] === 'weather' || prof.seasonBy[0] === 'calendar', 'season source is named');
}

// -------------------------------------------------------------------------------------------------
console.log('--- 4b. propane: a month with no delivery is null, not a fake 0 ---');
{
  const sb = makeEnv();
  // propane only, with deliveries in 3 months: the other 9 months have NO delivery
  sb.bldgs.push(
    { id: 'bD', name: 'Synthetic Propane Building', sqft: 8000, meters: [
      meter('pD', 'Propane', { p: [0, 0, 300, 0, 0, 0, 0, 0, 200, 0, 0, 250] }, { bills: billsFor([YMS[2], YMS[8], YMS[11]]) }),
    ] },
  );
  const r = sb.resolveHvacLoadData(7, sb.bldgs[3]);
  const k = sb.THERMS_PER_GAL_PROPANE;
  assert(r.gasArr.filter((v) => v === null).length === 9, 'propane: 9 months without a delivery are null, got ' + JSON.stringify(r.gasArr));
  assert(near(r.gasArr[2], 300 * k) && near(r.gasArr[8], 200 * k), 'propane months with a delivery carry gallons x therms per gallon');
  assert(near(r.billTherms, 750 * k), 'propane total therms = deliveries only');
  // 3 populated months only: the 3-lowest-month baseload cannot be built (needs 6) and no zero enters it
  assert(!r.enduse.gasValid, 'fewer than 6 populated months -> gas split not valid');
  // the report gate reads the same nulls
  assert(sb._wdHvacFullYear(7, sb.bldgs[3]).gas === false, 'propane building with 3 delivery months is not a full year');
  assert(sb._wdHvacFullYear(7, sb.bldgs[0]).elec === true && sb._wdHvacFullYear(7, sb.bldgs[0]).gas === true, 'a building with 12 bill months is a full year');
  assert(sb._wdHvacFullYear(7, sb.bldgs[2]).elec === false, 'a building with no meters is not a full year');
}

// -------------------------------------------------------------------------------------------------
console.log('--- 5. static gates ---');
{
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
  // 5a. no reader of the old project fields outside the one-time move
  const moveFn = fnSource(CALC, 'migrateHvacLoadToBuildings');
  const files = ['app', 'computations', 'lib', 'extraction'].flatMap((d) =>
    fs
      .readdirSync(path.join(REPO, d))
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ f: d + '/' + f, s: fs.readFileSync(path.join(REPO, d, f), 'utf8') })),
  );
  files.forEach((o) => {
    let s = strip(o.s);
    if (o.f === 'app/calculators.js') s = s.replace(moveFn, '');
    assert(
      !/hvacLoadEst|hvacLoadSavedAt|hvacLoadInputs/.test(s),
      'no reader of the old project estimate fields in ' + o.f,
    );
  });

  // 5b. bills are read only by _hvlMeterMoMap / _hvlMonthlyBaseline inside HVAC code of calculators.js
  const starts = [];
  const re = /^function (\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(CALC))) starts.push({ name: m[1], at: m.index });
  const hvlish = (n) => /^_?hvl|^hvac|^computeHvac|^resolveHvac|^_buildBaselineData/.test(n);
  const mayReadBills = new Set(['_hvlMeterMoMap', '_hvlMonthlyBaseline', '_buildBaselineDataHtml']);
  starts.forEach((s, i) => {
    if (!hvlish(s.name)) return;
    const body = strip(CALC.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : CALC.length));
    if (/getNormRows|buildMoMap\(|\.bills\b/.test(body) && !mayReadBills.has(s.name)) {
      // the resolver is allowed to see meters only through _hvlMonthlyBaseline; the data move reads none
      assert(false, s.name + ' reads bills or meters directly (use resolveHvacLoadData)');
    }
    if (/_hvlMonthlyBaseline\(/.test(body)) {
      assert(
        s.name === 'resolveHvacLoadData' || s.name === '_buildBaselineDataHtml' || s.name === '_hvlMonthlyBaseline',
        '_hvlMonthlyBaseline called only by the resolver and the Baseline Data table (found in ' + s.name + ')',
      );
    }
  });
  assert(true, 'HVAC functions read bills only through the resolver');

  // 5c. every other end-use / baseline reader calls the resolver
  // the report engine file that defines _wdBaselineHvac (found by content, not by a client-named path)
  const wd = fs
    .readdirSync(path.join(REPO, 'app'))
    .filter((f) => /^report-engine-.*\.js$/.test(f))
    .map((f) => read('app/' + f))
    .find((s) => /function _wdBaselineHvac\s*\(/.test(s));
  assert(
    /resolveHvacLoadData\(/.test(fnSource(wd, '_wdBaselineHvac')),
    '_wdBaselineHvac reads through resolveHvacLoadData',
  );
  assert(
    /resolveHvacLoadData\(/.test(fnSource(CALC, '_hvlGasHeatShare')),
    '_hvlGasHeatShare reads through resolveHvacLoadData',
  );
  assert(
    /resolveHvacLoadData\(/.test(read('app/graphics-setpoints.js')),
    'Energy Graphics HVAC card reads through resolveHvacLoadData',
  );
  assert(
    !/_hvlEnduseForBuilding/.test(CALC + wd + read('app/graphics-setpoints.js')),
    'the second end-use reader is gone',
  );

  // 5d. one place decides the peak
  assert(!/Math\.max\.apply\(null, peakVals\)/.test(ENDUSE), 'computeHvacEnduse peak comes from _hvacPeakOf');
  assert(/_hvacPeakOf\(kw\)/.test(fnSource(ENDUSE, 'computeHvacEnduse')), 'computeHvacEnduse uses _hvacPeakOf');
  assert(
    /computeHvacDemand\(/.test(fnSource(CALC, 'resolveHvacLoadData')),
    'the resolver gets demand from computeHvacDemand',
  );
  assert(!/Math\.max/.test(fnSource(wd, '_wdBaselineHvac')), '_wdBaselineHvac takes no private max of kW');

  // 5e. Phase 5: the BAS Calc Section D baseline (cooling kWh, heating kWh, gas therms) is read through getEndUse only
  const bas = strip(fnSource(CALC, 'openBASCalc'));
  assert(/getEndUse\(/.test(bas), 'openBASCalc reads its calibration baseline through getEndUse');
  assert(
    !/useSavedEst|hvacLoadStoredFor|hvacLoadProjectRollup|hvacCompute/.test(bas),
    'openBASCalc has no saved-versus-measured fork',
  );
  assert(
    /resolveHvacLoadData\(/.test(read('computations/end-use.js')),
    'getEndUse reads the data through resolveHvacLoadData',
  );

  // 5f. D2: the resolver path owns no month rule of its own
  const mm = strip(fnSource(CALC, '_hvlMeterMoMap'));
  assert(!/slice\(0, ?7\)/.test(mm), '_hvlMeterMoMap has no private end-month slice');
  assert(/billMonth\(/.test(mm) && !/normMonth\(/.test(mm), '_hvlMeterMoMap uses the one month function billMonth');

  // 5g. D3: no HVAC / report baseline code reads bills outside the resolver. Every function of a report engine
  // file or the Energy Graphics file whose name says HVAC, baseline, setpoint or report-gate is checked.
  // Listed exceptions (each reads bills for a reason that is not a baseline number):
  //  - _wdBuildMeterBaseline / _wdRawBillMeters / collect*ReportData: the report's RAW BILL pages print one
  //    account's bills as they are on paper; no HVAC or baseline value is computed from them.
  //  - _buildBaselineDataHtml (calculators.js): the Baseline Data table shows the NORMALIZED kWh/Therms
  //    (kwhPredicted, weather-regressed), a different number from the billed values by design; it reads the
  //    same month maps through _hvlMonthlyBaseline, so its months can not differ from the resolver's.
  const rawOk = (n) => n === '_wdBuildMeterBaseline' || n === '_wdRawBillMeters' || /^collect\w*ReportData$/.test(n);
  const scan = [{ f: 'report engine', src: WD }, { f: 'graphics-setpoints.js', src: read('app/graphics-setpoints.js') }];
  scan.forEach((o) => {
    const names = [];
    const rg = /^\s*function (\w+)\s*\(/gm;
    let mt;
    while ((mt = rg.exec(o.src))) names.push(mt[1]);
    let checked = 0;
    names.forEach((name) => {
      if (!/hvac|baseline|setpoint|CheckReportInputs|UpdateReportButton/i.test(name) || rawOk(name)) return;
      checked++;
      const body = strip(fnSource(o.src, name));
      const x = { name };
      assert(
        !/\.bills|getNormRows|buildMoMap\(|_wdBuildMeterBaseline|_wdRawBillMeters/.test(body),
        o.f + ': ' + x.name + ' reads bills directly (use resolveHvacLoadData)',
      );
    });
    assert(checked > 0, o.f + ': the bill-read gate checked at least one function');
  });
  assert(!/_wdBldgBaselines|_wdFullYear/.test(WD), 'the first-meter baseline reader is gone from the report engine');
  assert(
    /resolveHvacLoadData\(/.test(fnSource(WD, '_wdHvacFullYear')) &&
      /_wdHvacFullYear\(/.test(fnSource(WD, 'wdCheckReportInputs')) &&
      /_wdHvacFullYear\(/.test(fnSource(WD, 'wdUpdateReportButton')),
    'the setpoint report gate reads the resolver (_wdHvacFullYear)',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
