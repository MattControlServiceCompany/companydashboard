// tools/test-savings-floor-contract-rates.js - synthetic data only (fake ids, no client names).
// Run: node tools/test-savings-floor-contract-rates.js
// 1. A contracted project (project.sa set) prices every measure with the rates saved with the contract,
//    never the current owner rates, whatever m.rateSource says. A project with no contract keeps the
//    2026-10-13 rule: an owner-sourced measure follows the owner rates.
// 2. A quarter's savings is never negative: billableSavingsWithPresented floors each calendar quarter at $0
//    at the project total. Cumulative savings to date = the sum of the floored quarters (same function).
//    Building rows stay net.
// 3. A quarter already presented to the client stays at its printed figure.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
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
  SAV = REPO + '/computations/savings.js',
  ES = REPO + '/app/energy-savings.js';

// Saved (contract) rates and the different current owner rates of a synthetic building.
const SAVED = { kwhSummer: 0.07, kwhWinter: 0.06, kwSummer: 6019.81, kwWinter: 3825.44, thermRate: 0.8 };
const CURRENT = { kwhSummer: 0.05, kwhWinter: 0.04, kwSummer: 15, kwWinter: 10, thermRate: 0.7, gasSummer: 0.7, gasWinter: 0.7 };
const mkMeasure = (id, extra) =>
  Object.assign(
    {
      id,
      desc: 'BAS Savings',
      bldgId: 'bT1',
      selected: true,
      kwh: Array(12).fill(1000),
      kw: Array(12).fill(0),
      gas: Array(12).fill(0),
      propane: Array(12).fill(0),
      rates: Object.assign({}, SAVED),
    },
    extra || {},
  );
const store = {
  en_presented_savings: [
    { projectId: 'pT1', periodStart: '2026-01', periodEnd: '2026-03', presentedAt: '2026-04-20T12:00:00Z', totalDollars: 1000, buildings: { bT1: { dollars: 1000 } } },
    { projectId: 'pT1', periodStart: '2026-04', periodEnd: '2026-06', presentedAt: '2026-07-20T12:00:00Z', totalDollars: 2000, buildings: { bT1: { dollars: 2000 } } },
  ],
};
const BL = { months: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'] };
const sb = {
  console: { log() {}, warn() {}, error: console.error },
  window: {},
  document: { getElementById: () => null },
  projects: [
    { id: 'pT1', sa: 'SA-TEST', savingsData: { measures: [mkMeasure('m_csv_t1'), mkMeasure('m_t2', { rateSource: 'owner' })] } },
    { id: 'pT2', sa: '', savingsData: { measures: [mkMeasure('m_t3', { rateSource: 'owner' })] } },
  ],
  sget: (k, d) => (k in store ? store[k] : d),
  sset: () => {},
  showToast: () => {},
  getUDBldg: (p, b) => ({ id: b, name: 'Synthetic School' }),
  computeSeasonalBldgRates: () => Object.assign({ months: {} }, CURRENT),
  DELIVERY_COMMODITIES: new Set(['Propane']),
  isBaselineExcluded: (pid, mid) => mid === 'mExcluded',
  isCalcCommodity: () => true,
  _rptMeterEligible: (pid, m) => (m.id === 'mExcluded' ? 'excluded' : ''),
  billMonth: (b) => b.ym,
  // pT1: electric bills through 2026-09, gas through 2026-08 (September gas not issued). Every other project: complete.
  getUDBldgs: (pid) => {
    const ymsTo = (last) => Array.from({ length: 12 }, (_, i) => '2026-' + String(i + 1).padStart(2, '0')).filter((y) => y <= last).map((ym) => ({ ym, end: ym + '-28' }));
    return [
      {
        id: 'bT1',
        meters: [
          { id: 'mE', commodity: 'Electric', baseline: BL, bills: ymsTo('2026-12') },
          { id: 'mG', commodity: 'Gas', baseline: BL, bills: ymsTo(pid === 'pT1' ? '2026-08' : '2026-12') },
          { id: 'mP', commodity: 'Propane', baseline: BL, bills: [] },
          { id: 'mExcluded', commodity: 'Gas', bills: [] },
        ],
      },
    ];
  },
};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(RATES, 'utf8'), sb);
vm.runInContext(fs.readFileSync(REPO + '/computations/report-data.js', 'utf8'), sb);
vm.runInContext(fs.readFileSync(SAV, 'utf8'), sb);
vm.runInContext(fs.readFileSync(REPO + '/computations/csc.js', 'utf8'), sb);
vm.runInContext(
  [
    constSrc(ES, 'RATE_WRITE_FIELDS'),
    constSrc(ES, 'RATE_MONTHLY_FIELD'),
    ...['measureRateAt', 'calcMeasureDollars', 'rateGuardCheckSet', 'ownerMeasureRates', 'measureRatesNow'].map((n) => fnSrc(ES, n)),
  ]
    .join('\n')
    .replace(/\bconst\s+/g, 'var '),
  sb,
);
sb.computeSeasonalBldgRates = () => Object.assign({ months: {} }, CURRENT); // the real one needs bills
const ev = (e) => vm.runInContext(e, sb);

console.log('=== 1. contract rates ===');
const annual = (pid, i) =>
  ev(`(function(){const p=projects.find(x=>x.id==='${pid}');const m=p.savingsData.measures[${i}];return calcMeasureDollars(m, measureRatesNow(p.id, m)).total;})()`);
const savedAnnual = ev(`calcMeasureDollars(projects[0].savingsData.measures[0], ${JSON.stringify(SAVED)}).total`);
const curAnnual = ev(`calcMeasureDollars(projects[0].savingsData.measures[0], ${JSON.stringify(CURRENT)}).total`);
assert(savedAnnual !== curAnnual, 'fixture: saved and current rates price differently');
assert(Math.abs(annual('pT1', 0) - savedAnnual) < 1e-9, 'contracted project, unmarked csv measure: saved rates');
assert(Math.abs(annual('pT1', 1) - savedAnnual) < 1e-9, 'contracted project, rateSource owner: still the saved rates');
assert(Math.abs(annual('pT2', 0) - curAnnual) < 1e-9, 'no contract, owner measure: follows the current owner rates (2026-10-13 rule kept)');
assert(ev(`ownerMeasureRates('pT1', projects[0].savingsData.measures[1])`) === null, 'contracted project: nothing to write from the owner');

console.log('=== 2. quarter floor and cumulative ===');
assert(ev('floorQuarterSavings(-9051.02)') === 0 && ev('floorQuarterSavings(12.5)') === 12.5 && ev('floorQuarterSavings(0)') === 0, 'floorQuarterSavings');
const perB = { bX: { '2026-07': 500, '2026-08': -2000, '2026-09': -1500, '2026-10': 700, '2026-11': 300, '2026-12': 100 } };
const J = JSON.stringify(perB);
const bill = (y) => ev(`billableSavingsWithPresented('pNone', ${JSON.stringify(y)}, ${J})`);
assert(bill(['2026-07', '2026-08', '2026-09']).total === 0, 'negative quarter -> 0');
assert(bill(['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']).total === 1100, 'two quarters: 0 + 1100 (sum of floored quarters)');
assert(bill(['2026-07', '2026-08', '2026-09']).byBldg.bX === -3000, 'building row stays net (-3000)');

console.log('=== 3. presented quarters frozen ===');
const perP = JSON.stringify({ bT1: { '2026-01': 5, '2026-02': 5, '2026-03': 5, '2026-04': 1, '2026-05': 1, '2026-06': 1, '2026-07': -50, '2026-08': -50, '2026-09': -50 } });
const bp = (y) => ev(`billableSavingsWithPresented('pT1', ${JSON.stringify(y)}, ${perP}).total`);
assert(bp(['2026-01', '2026-02', '2026-03']) === 1000, 'presented Q1 stays 1000');
assert(bp(['2026-04', '2026-05', '2026-06']) === 2000, 'presented Q2 stays 2000');
assert(bp(['2026-07', '2026-08', '2026-09']) === 0, 'open negative Q3 -> 0');
assert(bp(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) === 3000, 'cumulative = 1000 + 2000 + 0 (sum of floored quarters, not net 2850)');

console.log('=== 4. frozen values of a contracted project do not move ===');
// Frozen: projected savings (saved rates x saved quantities) and every presented quarter. A rate refresh,
// a changed baseline rate, a new bill month or a changed month inside a presented quarter must not change them.
const frozen = () => JSON.stringify([annual('pT1', 0), annual('pT1', 1), bp(['2026-01', '2026-02', '2026-03']), bp(['2026-04', '2026-05', '2026-06'])]);
const before = frozen();
sb.computeSeasonalBldgRates = () => Object.assign({ months: {} }, CURRENT, { kwhSummer: 0.09, kwhWinter: 0.08, kwSummer: 40, kwWinter: 30, thermRate: 1.5 }); // rate refresh
assert(frozen() === before, 'baseline rate refresh leaves projected and presented values unchanged');
ev(`projects[0].savingsData.measures.forEach(m => { delete m.rateSource; })`);
assert(frozen() === before, 'a missing rate marker leaves them unchanged');
const perP2 = JSON.stringify({ bT1: { '2026-01': 99, '2026-02': -99, '2026-03': 7, '2026-04': 900, '2026-05': 1, '2026-06': 1, '2026-07': 400, '2026-08': 400, '2026-09': 400 } }); // changed bills in presented months, new open quarter
assert(ev(`billableSavingsWithPresented('pT1', ['2026-01','2026-02','2026-03'], ${perP2}).total`) === 1000, 'bill changes inside presented Q1 do not move Q1');
assert(ev(`billableSavingsWithPresented('pT1', ['2026-04','2026-05','2026-06'], ${perP2}).total`) === 2000, 'bill changes inside presented Q2 do not move Q2');

console.log('=== 5. shared savings: a negative quarter pays neither side ===');
const neg = ev('computeCscSplit(-9051.02, 60, "pct")');
assert(neg.csc === 0 && neg.client === 0, 'negative quarter: CSC share 0 and client share 0, got ' + JSON.stringify(neg));
const pos = ev('computeCscSplit(1000, 60, "pct")');
assert(pos.csc === 600 && pos.client === 400, 'positive quarter splits 60/40');

console.log('=== 6. a quarter missing bills still counts what we have, and names what is missing ===');
const q3m = ev(`billableSavingsWithPresented('pT1', ['2026-07','2026-08','2026-09'], ${JSON.stringify({ bT1: { '2026-07': 100, '2026-08': -30, '2026-09': 5 } })})`);
assert(q3m.total === 75 && Object.keys(q3m.missing).join() === '2026-Q3', 'Q3 counts the bills we have (75) and is named');
assert(q3m.missing['2026-Q3'].length === 1 && /Gas Sep$/.test(q3m.missing['2026-Q3'][0]), 'the missing line names the meter and month: ' + q3m.missing['2026-Q3']);
assert(Object.keys(ev(`billableSavingsWithPresented('pNone', ['2026-07','2026-08','2026-09'], ${J})`).missing).length === 0, 'a project with every bill has nothing missing');
assert(ev(`quarterMissingBills('pT1', '2026-Q1')`).length === 0, 'a presented quarter lacks nothing');
const cum9 = ev(`billableSavingsWithPresented('pT1', ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'], ${perP})`);
assert(cum9.total === 3000, 'cumulative = 1000 + 2000 + floored open Q3 (0), got ' + cum9.total);

console.log('=== 7. contract rates cannot be typed or reset ===');
vm.runInContext(
  [constSrc(ES, 'RATE_LOCK_ATTRS'), ...['writeRateField', 'svUpdateMsrRate', 'svResetMsrRates'].map((n) => fnSrc(ES, n))]
    .join(String.fromCharCode(10))
    .replace(/const\s+/g, 'var '),
  sb,
);
Object.assign(sb, {
  svSelProjId: 'pT1',
  getProjSavingsData: (pid) => sb.projects.find((x) => x.id === pid).savingsData,
  rateGuardAccept: async () => true,
  renderSvDetail() {},
  initSavingsTab() {},
});
const lockedBefore = JSON.stringify(sb.projects[0].savingsData.measures[0].rates);
ev(`svUpdateMsrRate('m_csv_t1', 'kwhSummer', 0.5, null)`);
ev(`svResetMsrRates('m_csv_t1')`);
assert(JSON.stringify(sb.projects[0].savingsData.measures[0].rates) === lockedBefore, 'contracted: typing a rate or Reset leaves the contract rates unchanged');
assert(/readonly/.test(ev('RATE_LOCK_ATTRS')) && /Contract rate - fixed by the agreement/.test(ev('RATE_LOCK_ATTRS')), 'locked inputs are read-only with the hover text');
sb.svSelProjId = 'pT2';
ev(`svUpdateMsrRate('m_t3', 'kwhSummer', 0.5, null)`);
setTimeout(() => {
  assert(sb.projects[1].savingsData.measures[0].rates.kwhSummer === 0.5, 'no contract: a typed rate is still saved');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 20);
