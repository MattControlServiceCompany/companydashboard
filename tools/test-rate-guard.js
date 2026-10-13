// tools/test-rate-guard.js — rate guard + rate-write-path test (synthetic data only).
// Run: node tools/test-rate-guard.js
// Loads the REAL functions from computations/rates.js, app/energy-savings.js, app/calculators.js into a vm.
//   1. rateGuardCheck: bounds, baseline ratio, blank/zero pass, message states value + baseline + range.
//   2. Reproduction of the 2026-10-13 defect: a BAS measure whose kW rate is dollars per BILL (6019.81)
//      is blocked by the BAS apply (and logged), not priced; the measure is not changed.
//   3. Programmatic writes (add measure, reset rates) out of range: blocked + logged, rates unchanged.
//   4. Typed rates: out of range + "no" saves nothing and puts the saved value back; "yes" saves it.
//   5. One-time refresh sets an imported measure's rates to the baseline rates, keeps its saved quantities.
//   6. The gate fails when a new rate write path skips the validator.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm'),
  cp = require('child_process'),
  os = require('os');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
function fnSrc(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
function constSrc(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('(?:const|var) ' + name + ' =').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let d = 0;
  for (let j = m.index; j < src.length; j++) {
    const c = src[j];
    if ('[{('.includes(c)) d++;
    else if (']})'.includes(c)) d--;
    else if (c === ';' && !d) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const RATES = REPO + '/computations/rates.js',
  ES = REPO + '/app/energy-savings.js',
  CALC = REPO + '/app/calculators.js';

// ---- synthetic building: baseline rates the owner function would return ----
const BASE = {
  kwhSummer: 0.0666,
  kwhWinter: 0.0558,
  kwhRate: 0.0594,
  kwSummer: 16.92,
  kwWinter: 11.56,
  kwRate: 13.35,
  thermRate: 0.798,
  gasSummer: 0.798,
  gasWinter: 0.798,
  gallonRate: 0,
};
const toasts = [];
let confirmAnswer = true;
const confirmAsked = [];
const sb = {
  console: { log() {}, warn() {}, error: console.error },
  window: {},
  document: { getElementById: () => null },
  projects: [],
  svSelProjId: 'p1',
  showToast: (t) => toasts.push(t),
  sset: () => {},
  getUDBldg: (p, b) => (b === 'b1' ? { id: 'b1', name: 'Synthetic School' } : null),
  computeSeasonalBldgRates: () => ({ ...BASE, months: {} }),
  confirmAsync: async (msg) => {
    confirmAsked.push(msg);
    return confirmAnswer;
  },
  _calcTemplateContext: { bldgId: 'b1', targetMeasureId: 'mT' },
  closeCalcTemplate: () => {},
  initSavingsTab: () => {},
  renderSvDetail: () => {},
  BAS_CITIES: [{ id: 4, name: 'Synthetic City' }],
};
const code = [
  fs.readFileSync(RATES, 'utf8'),
  constSrc(ES, 'RATE_WRITE_FIELDS'),
  constSrc(ES, 'RATE_MONTHLY_FIELD'),
  ...[
    'measureRateAt',
    'calcMeasureDollars',
    'rateGuardCheckSet',
    'rateGuardLog',
    '_rateGuardToastText',
    'rateGuardAccept',
    'rateGuardAcceptAll',
    'writeRateSet',
    'writeRateField',
    'initMeasureRates',
    'ensureMeasureRates',
    'fixMeasureRateSources',
    'ownerMeasureRates',
    'measureRatesNow',
    'followOwnerMeasureRates',
    'svUpdateMsrRate',
    'svResetMsrRates',
  ].map((n) => fnSrc(ES, n)),
  fnSrc(CALC, 'bcApplyToMeasure'),
  fnSrc(CALC, '_bcMeasureArrays'),
  constSrc(CALC, 'BAS_MO_DAYS'),
]
  .join('\n')
  .replace(/\bconst\s+/g, 'var ');
sb.convertUnit = (v) => v;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: 'rate-guard-extracted.js' });
// the real computeSeasonalBldgRates needs bills; the test hands back the synthetic baseline instead
sb.computeSeasonalBldgRates = () => ({ ...BASE, months: {} });

console.log('=== 1. rateGuardCheck ===');
const ck = (f, v) => sb.rateGuardCheck(f, v, BASE, 'Synthetic School');
const bad = ck('kwSummer', 6019.81);
assert(!bad.ok, '6019.81 $/kW is out of range');
assert(
  bad.message.includes('$6019.81') && bad.message.includes('$16.92') && bad.message.includes('$3.00 to $45.00'),
  'message states the value, the baseline rate and the normal range: ' + bad.message,
);
assert(ck('kwSummer', 16.5).ok, 'a normal $/kW passes');
assert(ck('kwSummer', 0).ok && ck('kwSummer', '').ok, 'zero or blank passes (clears the field)');
assert(!ck('kwhSummer', 0.2).ok, '0.2 $/kWh is inside the fixed bounds but over 2x the baseline');
assert(ck('kwhSummer', 0.2).baseline === 0.0666, 'result carries the baseline rate');
assert(
  sb.rateGuardCheck('kwhSummer', 0.2, { kwhSummer: 0 }, 'x').ok,
  'no baseline rate: only the fixed bounds apply (0.2 passes)',
);
assert(!sb.rateGuardCheck('kwhSummer', 0.3, null, 'x').ok, 'no baseline rate: 0.3 $/kWh is over the fixed bound');
assert(!ck('thermRate', 5).ok && !ck('thermRate', 0.05).ok, 'therm outside bounds fails');
assert(
  !ck('elec_rate', 0.2).ok && ck('elec_rate', 0.06).ok,
  'ECM electric input is checked against the all-season baseline',
);
assert(!ck('demand_rate', 6000).ok, 'ECM demand input is checked as $/kW');
assert(ck('someOtherField', 99999).ok, 'unknown fields are not rates');

console.log('=== 2. defect reproduction: BAS apply on a measure with a $/kW rate of 6019.81 ===');
const stale = { kwhSummer: 0.0681, kwhWinter: 0.0582, kwSummer: 6019.81, kwWinter: 3825.44, thermRate: 0.798 };
const mT = {
  id: 'mT',
  bldgId: 'b1',
  source: 'bas',
  rates: { ...stale },
  kwh: Array(12).fill(5),
  kw: Array(12).fill(1),
  gas: [],
};
const proj = {
  id: 'p1',
  basCalc: {},
  _bcResults: {
    kwhSavings: Array(12).fill(1000),
    gasSavings: Array(12).fill(0),
    peakKwhSavings: Array(12).fill(100),
    peakHours: 2,
    gasUnit: 'Therms',
  },
};
sb.projects.push(proj);
sb.getProjSavingsData = () => ({ measures: [mT], blRates: {} });
const kwBefore = mT.kw.join(',');
sb.bcApplyToMeasure('p1');
assert(mT.kw.join(',') === kwBefore, 'blocked apply did not change the measure quantities');
assert(mT.rates.kwSummer === 6019.81, 'blocked apply did not touch the rates (the refresh/reset fixes them)');
assert(
  (sb.window._rateGuardLog || []).some((e) => e.source === 'BAS apply' && e.value === 6019.81),
  'blocked apply is logged',
);
assert(
  toasts.some((t) => /Not applied/.test(t)),
  'blocked apply tells the user',
);
// after the rates are the baseline rates, the same apply works and prices from them
sb.writeRateSet(mT, 'rates', sb.computeSeasonalBldgRates(), 'p1', 'b1', 'test');
sb.bcApplyToMeasure('p1');
assert(
  mT.kw.join(',') !== kwBefore && mT.totalDollar > 0 && mT.totalDollar < 1e6,
  'apply with baseline rates prices a plausible total: ' + mT.totalDollar,
);

console.log('=== 3. programmatic writes out of range are blocked + logged ===');
const logN = sb.window._rateGuardLog.length;
const m3 = { rates: { kwSummer: 16.92 } };
const okSet = sb.writeRateSet(m3, 'rates', { kwSummer: 6019.81, kwhSummer: 0.07 }, 'p1', 'b1', 'unit test write');
assert(
  okSet === false && m3.rates.kwSummer === 16.92 && Object.keys(m3.rates).length === 1,
  'blocked write leaves the holder untouched',
);
assert(
  sb.window._rateGuardLog.length === logN + 1 && sb.window._rateGuardLog[logN].source === 'unit test write',
  'blocked write is logged with its source',
);
assert(
  sb.writeRateSet(m3, 'rates', { kwSummer: 17, kwhSummer: 0.07, junk: 5 }, 'p1', 'b1', 'unit test write') &&
    m3.rates.junk === undefined,
  'in-range write saves rate fields only',
);
// reset with bad baseline
const saveBase = { ...BASE };
BASE.kwSummer = 6019.81;
const mR = { id: 'mR', bldgId: 'b1', rates: { kwSummer: 16 } };
sb.getProjSavingsData = () => ({ measures: [mR], blRates: {} });
sb.svResetMsrRates('mR');
assert(mR.rates.kwSummer === 16, 'Reset rates with a baseline outside the bounds is blocked');
Object.assign(BASE, saveBase);

console.log('=== 4. typed rates: popup, cancel saves nothing, accept saves ===');
const mY = { id: 'mY', bldgId: 'b1', rates: { kwSummer: 16.92, kwhSummer: 0.0666 } };
sb.getProjSavingsData = () => ({ measures: [mY], blRates: {} });
const el = { value: '6019.81' };
confirmAnswer = false;
confirmAsked.length = 0;
(async () => {
  await sb.svUpdateMsrRate('mY', 'kwSummer', 6019.81, el);
  assert(
    confirmAsked.length === 1 && /6019\.81/.test(confirmAsked[0]) && /16\.92/.test(confirmAsked[0]),
    'popup asked, naming value and baseline',
  );
  assert(mY.rates.kwSummer === 16.92, 'cancel: nothing saved');
  assert(el.value === 16.92, 'cancel: the input shows the saved value again');
  confirmAnswer = true;
  await sb.svUpdateMsrRate('mY', 'kwSummer', 6019.81, el);
  assert(mY.rates.kwSummer === 6019.81, 'accept: saved');
  confirmAsked.length = 0;
  await sb.svUpdateMsrRate('mY', 'kwSummer', 17.1, el);
  assert(confirmAsked.length === 0 && mY.rates.kwSummer === 17.1, 'in-range value saves without a popup');
  await sb.svUpdateMsrRate('mY', 'thermRate', 0.8, el);
  assert(mY.rates.thermRate === 0.8, 'a normal therm rate saves');

  console.log('=== 5. rates follow the owner unless typed ===');
  const old = {
    id: 'm_csv_b1',
    bldgId: 'b1',
    rates: { ...stale },
    kwh: Array(12).fill(1000),
    kw: Array(12).fill(10),
    gas: Array(12).fill(50),
    totalDollar: 22557,
  };
  const typed = { id: 'm123', bldgId: 'b1', rates: { kwSummer: 99 }, rateSource: 'manual', kwh: [], kw: [], gas: [] };
  const unmarked = { id: 'm456', bldgId: 'b1', rates: { kwSummer: 98 }, kwh: [], kw: [], gas: [] };
  const sd = { measures: [old, typed, unmarked], blRates: {} };
  // one-time data fix by evidence: m_csv_ = owner, everything else unmarked = manual; a marked one is not touched
  assert(sb.followOwnerMeasureRates('p1', sd) === false && old.rates.kwSummer === stale.kwSummer, 'an unmarked measure is not owner: code reads only rateSource owner');
  const legacy = { id: 'm999', bldgId: 'b1', desc: '', rates: { kwhSummer: 0.0694, kwhWinter: 0.0597, kwSummer: 13.51, kwWinter: 8.96, thermRate: 0, gallonRate: 0 }, kwh: Array(12).fill(0), kw: Array(12).fill(0), gas: Array(12).fill(0), propane: Array(12).fill(0) };
  const legacyTyped = { ...legacy, id: 'm998', desc: 'typed measure', kw: Array(12).fill(5), rates: { ...legacy.rates } };
  const projFix = { savingsData: { measures: [old, typed, unmarked, legacy, legacyTyped] } };
  assert(sb.fixMeasureRateSources(projFix) === true, 'data fix changed measures');
  assert(old.rateSource === 'owner' && unmarked.rateSource === 'manual' && typed.rateSource === 'manual', 'data fix: m_csv_ owner, unmarked manual, marked untouched');
  assert(legacy.rateSource === 'owner' && legacyTyped.rateSource === 'manual', 'data fix: empty legacy default-shape measure owner, a measure with quantities manual');
  assert(sb.fixMeasureRateSources(projFix) === false, 'data fix is idempotent');
  const kwhKeep = old.kwh.join(',');
  assert(sb.followOwnerMeasureRates('p1', sd) === true, 'follow changed the imported measure');
  assert(
    old.rates.kwSummer === 16.92 && old.rates.kwWinter === 11.56 && old.rates.kwhSummer === 0.0666,
    'imported measure got the baseline rates',
  );
  assert(old.rateSource === 'owner', 'imported measure is marked owner');
  assert(old.kwh.join(',') === kwhKeep && old.kw.length === 12, 'imported measure keeps its saved quantities');
  assert(
    Math.abs(old.totalDollar - sb.calcMeasureDollars(old, old.rates).total) < 1e-9 && old.totalDollar < 22557,
    'totalDollar recomputed from the new rates',
  );
  assert(typed.rates.kwSummer === 99 && typed.rateSource === 'manual', 'a typed (manual) measure is untouched');
  assert(unmarked.rates.kwSummer === 98, 'a manual measure that was never imported is untouched');
  assert(sb.followOwnerMeasureRates('p1', sd) === false, 'nothing changes when the rates already match the owner');
  // the owner changes: an owner-sourced measure moves with it, with no flag involved
  const baseBefore = { ...BASE };
  sb.computeSeasonalBldgRates = () => ({ ...BASE, kwSummer: 17.5, months: {} });
  assert(sb.followOwnerMeasureRates('p1', sd) === true && old.rates.kwSummer === 17.5, 'owner rate change is followed');
  assert(typed.rates.kwSummer === 99, 'owner rate change leaves the manual measure alone');
  // a rate typed on an owner measure turns it manual
  sb.getProjSavingsData = () => sd;
  confirmAnswer = true;
  await sb.svUpdateMsrRate('m_csv_b1', 'kwSummer', 17.2, el);
  assert(old.rateSource === 'manual' && old.rates.kwSummer === 17.2, 'typing a rate marks the measure manual');
  assert(sb.followOwnerMeasureRates('p1', sd) === false && old.rates.kwSummer === 17.2, 'manual rate stays as typed');
  sb.svResetMsrRates('m_csv_b1');
  assert(old.rateSource === 'owner' && old.rates.kwSummer === 17.5, 'Reset returns the measure to the owner');
  sb.computeSeasonalBldgRates = () => ({ ...baseBefore, months: {} });

  console.log('=== 5b. owner rates: fixed bounds only; one flag, one toast; the total getter writes nothing ===');
  // monthly gas that swings 3x inside the year is real, and the owner write must pass
  const swing = [0.3, 0.3, 0.4, 0.5, 0.6, 0.9, 0.9, 0.9, 0.6, 0.5, 0.4, 0.3];
  sb.computeSeasonalBldgRates = () => ({ ...BASE, thermRate: 0.4, gasMonthly: swing, months: {} });
  assert(sb.rateGuardCheckSet({ gasMonthly: swing }, 'p1', 'b1', true).length === 0, 'owner write: a month 2.25x the annual mean passes (fixed bounds only)');
  assert(sb.rateGuardCheckSet({ gasMonthly: swing }, 'p1', 'b1').length > 0, 'a typed or calculator rate set keeps the full 0.5x-2x check');
  const mo1 = { id: 'mo1', bldgId: 'b1', rateSource: 'owner', rates: { thermRate: 0.5 }, kwh: [], kw: [], gas: Array(12).fill(10), propane: [] };
  sb.followOwnerMeasureRates('p1', { measures: [mo1], blRates: {} });
  assert(mo1.rates.gasMonthly && mo1.rates.gasMonthly.join() === swing.join() && !mo1.rateFlag, 'owner measure took the monthly gas rates');
  // an owner rate outside the fixed bounds: not saved, flagged once, toasted once, logged once, over many calls
  sb.computeSeasonalBldgRates = () => ({ ...BASE, kwSummer: 6019.81, months: {} });
  const mo2 = { id: 'mo2', desc: 'Synthetic measure', bldgId: 'b1', rateSource: 'owner', rates: { kwSummer: 16 }, kwh: [], kw: Array(12).fill(1), gas: [], propane: [] };
  const sd2 = { measures: [mo2], blRates: {} };
  const t0 = toasts.length, l0 = sb.window._rateGuardLog.length;
  for (let i = 0; i < 20; i++) sb.followOwnerMeasureRates('p1', sd2);
  assert(mo2.rates.kwSummer === 16, 'blocked owner rate: measure keeps its rates');
  assert(mo2.rateFlag && mo2.rateFlag.field === 'kwSummer' && mo2.rateFlag.value === 6019.81, 'blocked owner rate: stored flag names the rate');
  assert(toasts.length === t0 + 1 && /Synthetic measure/.test(toasts[t0]), 'toast shown once and names the measure: ' + (toasts.length - t0));
  assert(sb.window._rateGuardLog.length === l0 + 1, 'logged once over 20 calls: ' + (sb.window._rateGuardLog.length - l0));
  // the total getter path prices from saved rates without writing or toasting
  const snap = JSON.stringify(mo2), t1 = toasts.length;
  for (let i = 0; i < 20; i++) sb.measureRatesNow('p1', mo2);
  assert(JSON.stringify(mo2) === snap && toasts.length === t1, 'measureRatesNow writes nothing and toasts nothing');
  sb.computeSeasonalBldgRates = () => ({ ...baseBefore, months: {} });
  assert(sb.measureRatesNow('p1', mo2).kwSummer === baseBefore.kwSummer && mo2.rates.kwSummer === 16, 'measureRatesNow returns the owner rates without saving them');

  console.log('=== 6. gate fails when a new rate write path skips the validator ===');
  const tmp = fs.mkdtempSync(path.join('C:/Temp', 'rate-gate-test-'));
  try {
    ['app', 'computations', 'lib'].forEach((d) => fs.mkdirSync(path.join(tmp, d)));
    ['app/energy-savings.js', 'app/ecm-calculators.js'].forEach((f) =>
      fs.copyFileSync(path.join(REPO, f), path.join(tmp, f)),
    );
    fs.writeFileSync(path.join(tmp, 'site-ui.js'), '');
    const run = () =>
      cp.spawnSync(process.execPath, [path.join(REPO, 'tools/gate-rate-write-guard.js')], {
        env: { ...process.env, RATE_GATE_ROOT: tmp },
        encoding: 'utf8',
      });
    assert(run().status === 0, 'gate passes on the real writers');
    fs.writeFileSync(
      path.join(tmp, 'app/new-path.js'),
      'function newPath(m, b) {\n  m.rates = computeSeasonalBldgRates(1, b);\n}\n',
    );
    let r = run();
    assert(
      r.status === 1 && /writes \.rates directly/.test(r.stdout),
      'gate fails on a direct .rates write: ' + r.stdout.slice(0, 120),
    );
    fs.writeFileSync(
      path.join(tmp, 'app/new-path.js'),
      'async function newPath(m) {\n  writeRateField(m, "rates", "kwSummer", 5);\n}\n',
    );
    r = run();
    assert(
      r.status === 1 && /without rateGuardAccept/.test(r.stdout),
      'gate fails on writeRateField without the popup check',
    );
    fs.writeFileSync(
      path.join(tmp, 'app/new-path.js'),
      'function newPath(sd, b) {\n  sd.measures.push({\n    id: 1,\n    rates: computeSeasonalBldgRates(1, b),\n  });\n}\n',
    );
    r = run();
    assert(r.status === 1 && /rates: literal/.test(r.stdout), 'gate fails on a measure built with a rates literal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('ERROR', e);
  process.exit(1);
});
