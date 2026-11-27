// Known-value test of the savings numbers before and after the single-source change (2026-11-27). SYNTHETIC data, hand-computed.
// Run: node tools/test-savings-known-values.js   (exit 0 = all pass)
// Pins: (1) the matrix project total and the cost roll-up of the hand-entered Energy Savings measures, (2) the Cost Estimate footer line and
// top line of an option, (3) the option totals (kWh, therms, dollars, payback) of the Service Proposal estimate.
//
// (1) Matrix fixture, summer = June to September (4 months), winter = the other 8:
//   m1  kWh 100 a month at $0.10 summer / $0.08 winter = 4 x 10 + 8 x 8 = 104;  gas 10 therms a month at $0.80 = 96;  total $200.00
//   m2  kWh 50 a month at $0.20 = 120;  kW 2 a month at $10 summer / $6 winter = 4 x 20 + 8 x 12 = 176;  total $296.00
//   m3  not selected (kWh 1,000 a month): not in any total
//   project total = 200 + 296 = $496.00. Cost lines: m1 third party $1,000 less incentive $200, m2 parts $500 -> cost $1,500, net $1,300;
//   payback = 1,300 / 496 = 2.621 years.
// (2) and (3) use the fixture of tools/test-option-savings-estimate.js ("Test Hall", rows below): option total $3,543.14 a year, price $8,000.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};
const near = (a, b, rel, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * (rel || 0.0001) + 1e-9, m + ': ' + a + ' vs ' + b);
const loadOwners = fs.existsSync(path.join(__dirname, 'savings-sandbox.js')) ? require('./savings-sandbox.js').loadSavingsOwners : () => {};

// (1) matrix project total and cost roll-up
{
  const arr = (v) => Array(12).fill(v);
  const measures = [
    { id: 'm1', selected: true, bldgId: 'b1', rateSource: 'manual', rates: { kwhSummer: 0.1, kwhWinter: 0.08, thermRate: 0.8 }, kwh: arr(100), kw: arr(0), gas: arr(10), propane: arr(0), costLines: [{ kind: 'thirdParty', amount: 1000 }, { kind: 'incentive', amount: 200 }] },
    { id: 'm2', selected: true, bldgId: 'b1', rateSource: 'manual', rates: { kwhSummer: 0.2, kwhWinter: 0.2, kwSummer: 10, kwWinter: 6 }, kwh: arr(50), kw: arr(2), gas: arr(0), propane: arr(0), costLines: [{ kind: 'parts', amount: 500 }] },
    { id: 'm3', selected: false, bldgId: 'b1', rateSource: 'manual', rates: { kwhSummer: 1, kwhWinter: 1 }, kwh: arr(1000), kw: arr(0), gas: arr(0), propane: arr(0) },
  ];
  const sd = { measures, blRates: {} };
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
    document: { getElementById: () => null },
    projects: [{ id: 'p', savingsData: sd }],
    getProjSavingsData: () => sd,
    projHasContract: () => true,
    _pricingGetConfig: () => ({ hourlyRate: 100 }),
    sget: () => [],
    sset() {},
  };
  sb.window = sb;
  vm.createContext(sb);
  ['lib/date-helpers.js', 'lib/formatting.js', 'computations/rates.js', 'computations/cost-lines.js'].forEach((f) => vm.runInContext(read(f), sb));
  const t = read('app/energy-savings.js');
  const a = t.indexOf('const RATE_WRITE_FIELDS');
  vm.runInContext(t.slice(a, t.indexOf('function _clMoney', a)), sb);
  near(sb.msrAnnualSavings('p', measures[0]), 200, 0.000001, 'm1 = $200');
  near(sb.msrAnnualSavings('p', measures[1]), 296, 0.000001, 'm2 = $296');
  near(sb.getProjMatrixSavingsTotal('p'), 496, 0.000001, 'matrix project total = $496 (the unselected measure is out)');
  const c = sb.projCostSummary('p', measures.filter((m) => m.selected));
  near(c.gross, 1500, 0.000001, 'gross cost');
  near(c.net, 1300, 0.000001, 'net cost');
  near(c.years, 1300 / 496, 0.000001, 'payback = net / annual (simplePayback)');
  ok('matrix: project total $496, cost $1,500, net $1,300, payback 2.62 years');
}

// (2) and (3) option estimate, the footer line and the top line
{
  const hourly = (v) => Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? v / 10 : 0));
  const WEATHER = { bins: [32.5, 57.5, 77.5], cities: { 4: { temp: Array.from({ length: 12 }, (_, m) => [hourly(m === 0 ? 1000 : 0), hourly(m === 0 ? 1000 : 0), hourly(m === 0 ? 1000 : 0)]) } } };
  const use = { label: '2025', sqft: 50000, kwh: 100000, electricCost: 10000, therms: 10000, gasCost: 8000, hasGas: true };
  const counts = { ahu: 2, vav: 10, hwp: 1 };
  const fanUnit = (kw) => ({ id: 'f' + kw, ok: true, kw, hours: 3640, hoursLevel: 'default', kwLevel: 'default', kwh: kw * 3640, baselineFraction: 1, driveStatus: 'has', reset: { pass: 0.7, level: 'default' } });
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
  const store = { en_pricing_workbook_p: { method: 'hourly' } };
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
    document: { getElementById: () => ({}), createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
    sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    sset() {}, showToast() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    collectASHRAE36Data: () => ({ buildings: [{ name: 'Test Hall', equipResults: [{ category: 'vav', existingSchedule: { startMin: 480, stopMin: 1080 } }], equipCounts: counts }] }),
    getUDBldgs: () => [{ id: 'Test Hall', name: 'Test Hall' }],
    _a36UtilityBuilding: (d, b) => (b.name === 'Test Hall' ? { id: 'Test Hall', name: 'Test Hall' } : null),
    buildingAnnualUse: (pid, id) => (id === 'Test Hall' ? use : null),
    EM_SEQUENCE_DEFS: [],
    hvacRuleOfThumbEnduse: (pid, bid, kwh, therms, electricHeat) => (electricHeat ? { coolKwh: 28000, heatKwh: 20000, heatGasTherms: 0 } : { coolKwh: 30000, heatKwh: 0, heatGasTherms: 6000 }),
    BAS_WEATHER_BINS: WEATHER,
    EM_SPACE_TYPE_ZONE_TERMINAL_CATS: { vav: true },
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/formatting.js'), sb);
  vm.runInContext(read('computations/cost-lines.js'), sb);
  ['computations/physics.js', 'computations/fan-savings.js', 'app/ecm-calculators.js', 'computations/measure-savings.js'].forEach((f) => vm.runInContext(read(f), sb));
  sb.fanBuildingUnitModels = () => [fanUnit(5), fanUnit(3)];
  loadOwners(sb, vm, ROOT);
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  const seq = (id, seqKey, qty, total) => ({ id, building: 'Test Hall', phase: 2, seqKey, qty, lineTotal: total, item: seqKey, _hwGroup: 'ready' });
  const opp = (id, oppKey, qty, total, phase) => ({ id, building: 'Test Hall', phase: phase || 2, oppKey, qty, lineTotal: total, item: oppKey });
  const rows = [
    seq('s_dsp', 'ahu_dsp_reset', 1, 1000), seq('s_sat', 'ahu_sat_reset', 2, 2000), opp('o_sp', 'spOverride', 1, 200), opp('o_hwdp', 'hwDpOverride', 1, 200),
    opp('o_term', 'terminalStandard', 5, 3000), seq('s_minoa', 'ahu_min_oa', 2, 500), seq('s_freeze', 'ahu_freeze_prot', 2, 300), opp('o_meter', 'powerMeter', 1, 800, 1),
  ];
  const est = { rowToggles: {} };
  const e = sb._pricingOptionSavingsEstimate('p', rows, est, { grand: 8000 });
  near(e.total.kwh.likely, 12446.25, 0.0001, 'option likely kWh');
  near(e.total.therms.likely, 2873.15, 0.0001, 'option likely therms');
  near(e.total.usd.likely, 3543.14, 0.0001, 'option likely dollars');
  near(e.total.years.likely, 8000 / 3543.14, 0.0001, 'option payback');
  assert.strictEqual(e.display.likely, 3500);
  assert.strictEqual(e.display.years, 2);
  ok('option total: 12,446 kWh + 2,873 therms = $3,543.14 a year, payback 2.26 years');
  const lo = '$' + e.display.low.toLocaleString('en-US');
  const hi = '$' + e.display.high.toLocaleString('en-US');
  const foot = sb._pricingSavingsLineHTML('p', { est: e, tier: 'recommended' });
  assert.ok(foot.indexOf('Estimated savings $3,500 per year (range ' + lo + ' to ' + hi + '); estimated payback about 2 years.') > -1, 'footer line: ' + foot);
  assert.ok(sb._pricingSavingsLineHTML('p', { est: null, tier: 'compliance' }).indexOf('No energy savings claimed') > -1, 'Compliance footer line');
  ok('Cost Estimate footer line: the option sentence with range and payback');
  assert.strictEqual(sb._pricingOptionTopLineText(e, 'recommended'), 'Estimated savings $3,500 per year (range ' + lo + '-' + hi + ') · payback about 2 years');
  ok('Cost Estimate top line text');
  const cells = JSON.parse(JSON.stringify(sb._pricingOptionTotalCells(e)));
  assert.deepStrictEqual(cells, { savings: '$3,500', years: '2' });
  ok('Service Proposal total cells $3,500 / 2 years');
}
console.log('\n' + n + ' passed');
