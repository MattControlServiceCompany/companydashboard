// Test: the estimated savings and the simple payback of the optional room CO2 sensors (Matt 2026-11-19). SYNTHETIC data, hand-computed values.
// Run: node tools/test-room-co2-estimate.js   (exit 0 = all pass)
// Owner under test: _pricingZoneCo2SavingsEstimate and _pricingZoneCo2EstimateText (app/pricing-estimator.js), which call dcvEnergySaved
// (app/ecm-calculators.js) and simplePayback (computations/cost-lines.js). The building use and the weather are stubbed with round numbers.
//
// Fixture (one building, "Test Hall"):
//   floor area 10,000 ft2; two zone units: "Meeting Room 1 | VAV-1" (dense, weight 0.7) and "Stacks | VAV-2" (public, weight 1.0)
//   -> weights sum 1.7; the dense room area = 10,000 x 0.7 / 1.7 = 4,117.647 ft2.
//   BAS schedule 8:00 to 17:00 -> occupied hours 8..16.
//   Weather (one month): 1,000 h at 40 F in each of hours 8..16 (9,000 h) -> heating degree-hours = 9,000 x (70 - 40) = 270,000;
//                        500 h at 80 F in hour 10 -> cooling degree-hours = 500 x (80 - 72) = 4,000.
//   Rates: electric 1,000 kWh for $100 = $0.10 per kWh; gas 500 therms for $400 = $0.80 per therm.
//   Design outdoor air of the room = area x (0.06 + 5 x 50 / 1,000) = area x 0.31; the per-person part = area x 0.25.
//   cfm saved = area x 0.25 x (1 - occupancy):  low 0.25 -> 772.06;  likely 0.15 -> 875.00;  high 0.08 -> 947.06.
//   therms = 1.08 x cfm x 270,000 / (100,000 x 0.82) x incremental (0.30 / 0.55 / 0.80)
//   kWh    = 1.08 x cfm x 4,000 / (3.5 x 3,412.14) x incremental
//   price = $1,000 sensor + $200 programming = $1,200.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const ROOT = path.join(__dirname, '..');
const { loadSavingsOwners } = require('./savings-sandbox.js'); // project savings owners (2026-11-27)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};
const near = (a, b, rel, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * (rel || 0.001) + 1e-9, m + ': ' + a + ' vs ' + b);

function make(useByName, eqList) {
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
  const month = (hrs) => hrs; // temp[month][bin][hour]
  const zeros = () => Array.from({ length: 3 }, () => new Array(24).fill(0));
  const temp = Array.from({ length: 12 }, zeros);
  for (let h = 8; h <= 16; h++) temp[0][0][h] = 1000; // bin 0 = 40 F
  temp[0][2][10] = 500; // bin 2 = 80 F
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
    document: { getElementById: () => null, createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
    sget: (k, d) => d, sset() {}, showToast() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    collectASHRAE36Data: () => ({ buildings: [{ name: 'Test Hall', equipResults: eqList }] }),
    BAS_WEATHER_BINS: { bins: [40, 60, 80], cities: { 4: { name: 'Test City, TS', temp: temp } } },
    getUDBldgs: () => Object.keys(useByName).map((k) => ({ id: k, name: k })),
    _a36UtilityBuilding: (d, b) => (useByName[b.name] ? { id: b.name, name: b.name } : null),
    buildingAnnualUse: (pid, id) => useByName[id],
    EM_SEQUENCE_DEFS: [],
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/formatting.js'), sb);
  vm.runInContext(read('computations/physics.js'), sb);
  vm.runInContext(read('computations/cost-lines.js'), sb);
  const ecm = read('app/ecm-calculators.js');
  vm.runInContext(ecm.slice(ecm.indexOf('function dcvEnergySaved'), ecm.indexOf('const ECM_TEMPLATES')), sb);
  const em = read('app/equipment-matrix.js');
  vm.runInContext(em.slice(em.indexOf('var EM_SPACE_TYPE_ZONE_TERMINAL_CATS'), em.indexOf('/* _emSpaceTypeConfigFlagOverrides')), sb);
  vm.runInContext(read('computations/measure-savings.js'), sb); // the Service Proposal measure formulas _pricingOptionSavingsEstimate calls (Matt 2026-11-23 8c5bfd4a)
  loadSavingsOwners(sb, vm, ROOT);
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  return sb;
}
const sched = { startMin: 480, stopMin: 1020 };
const eqs = [
  { id: 'v1', name: 'Meeting Room 1 | VAV-1', category: 'vav', existingSchedule: sched },
  { id: 'v2', name: 'Stacks | VAV-2', category: 'vav', existingSchedule: sched },
  { id: 'a1', name: 'AHU-1', category: 'ahu', existingSchedule: { startMin: 0, stopMin: 0 } },
];
const gasUse = { label: '2025', sqft: 10000, kwh: 1000, electricCost: 100, therms: 500, gasCost: 400, hasGas: true };
const rows = [
  { id: 'h1', building: 'Test Hall', phase: 1, qty: 1, lineTotal: 1000, _denseRooms: ['Meeting Room 1'] },
  { id: 's1', building: 'Test Hall', phase: 2, qty: 1, lineTotal: 200 },
];
const est = { rowToggles: {} };

// 1. the occupied window and the degree-hours of the typical year
{
  const sb = make({ 'Test Hall': gasUse }, eqs);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb._pricingBuildingOccupiedWindow(eqs))), { start: 8, stop: 17 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb._pricingTypicalYearDegreeHours(4, 8, 17))), { heat: 270000, cool: 4000 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb._pricingTypicalYearDegreeHours(4, 8, 10))), { heat: 60000, cool: 0 }); // hours 8 and 9 only
  assert.strictEqual(sb._pricingBuildingOccupiedWindow([{ existingSchedule: { startMin: 0, stopMin: 0 } }]), null, 'an all-day schedule gives no window');
  ok('occupied window (8 to 17) and typical-year degree-hours (270,000 heating, 4,000 cooling)');
}
// 2. the estimate, hand computed
{
  const sb = make({ 'Test Hall': gasUse }, eqs);
  const e = sb._pricingZoneCo2SavingsEstimate('p', rows, est, { grand: 1200 });
  assert.ok(e && e.complete, 'complete');
  const area = (10000 * 0.7) / 1.7;
  const cfm = { low: area * 0.25 * 0.75, likely: area * 0.25 * 0.85, high: area * 0.25 * 0.92 };
  const inc = { low: 0.3, likely: 0.55, high: 0.8 };
  near(cfm.likely, 875, 0.0001, 'hand check cfm');
  const exp = {};
  ['low', 'likely', 'high'].forEach((k) => {
    const th = ((1.08 * cfm[k] * 270000) / (100000 * 0.82)) * inc[k];
    const kwh = ((1.08 * cfm[k] * 4000) / (3.5 * 3412.14)) * inc[k];
    exp[k] = { th, kwh, usd: th * 0.8 + kwh * 0.1 };
    const b = e.buildings[0];
    near(b.therms[k], th, 0.001, k + ' therms');
    near(b.kwh[k], kwh, 0.001, k + ' kWh');
    near(b.usd[k], exp[k].usd, 0.001, k + ' dollars (energy x rate per fuel)');
    near(e.total.usd[k], exp[k].usd, 0.001, k + ' total dollars');
  });
  // the hand numbers (rounded): likely 1,711.4 therms, 1,741 kWh... see the formulas above
  near(exp.likely.th, 1711.4, 0.002, 'likely therms by hand');
  near(e.total.years.likely, 1200 / exp.likely.usd, 0.001, 'simple payback = price / annual savings, no incentive');
  assert.strictEqual(e.buildings[0].rooms, 1);
  assert.strictEqual(e.total.price, 1200);
  assert.strictEqual(e.year, '2025');
  assert.strictEqual(e.weatherCity, 'Test City');
  assert.ok(e.total.usd.low < e.total.usd.likely && e.total.usd.likely < e.total.usd.high, 'low < likely < high');
  const r100 = (v) => Math.round(v / 100) * 100;
  assert.strictEqual(e.display.likely, r100(exp.likely.usd));
  assert.strictEqual(e.display.low, r100(exp.low.usd));
  assert.strictEqual(e.display.high, r100(exp.high.usd));
  assert.strictEqual(e.display.years, Math.max(1, Math.round(1200 / exp.likely.usd)));
  ok('estimate: therms, kWh, dollars (energy x own rate), simple payback and the rounded display equal the hand-computed values');

  // 3. the sentences
  const t = sb._pricingZoneCo2EstimateText(e, true);
  const usd = (v) => '$' + v.toLocaleString('en-US');
  assert.strictEqual(
    t.savings,
    'Estimated savings ' + usd(e.display.likely) + ' per year (range ' + usd(e.display.low) + ' to ' + usd(e.display.high) + '); estimated payback about ' + e.display.years + (e.display.years === 1 ? ' year.' : ' years.'),
  );
  // (Matt 2026-11-23 8c5bfd4a) the one basis sentence names the engineering formulas, the weather city, the year and the equipment.
  assert.strictEqual(t.basis, "Savings are estimated with engineering formulas for each measure (fan and pump laws, airflow and heat transfer with typical Test City weather) from each building's 2025 utility use and its equipment.");
  assert.strictEqual(sb._pricingZoneCo2EstimateText(e, false).savings, 'The sensors prepare these rooms for occupancy-based ventilation.');
  assert.strictEqual(sb._pricingZoneCo2EstimateText(e, false).basis, '');
  assert.strictEqual(sb._pricingZoneCo2EstimateText(null, true).savings, '');
  ok('sentences: savings range, payback in whole years, basis with the real year and weather city; Compliance says the sensors prepare the rooms');
}
// 4. no gas meter: the mean gas rate of the project buildings that have one
{
  const use = {
    'Test Hall': { label: '2025', sqft: 10000, kwh: 1000, electricCost: 100, therms: null, gasCost: null, hasGas: false },
    'Other Hall': { label: '2025', sqft: 5000, kwh: 1000, electricCost: 100, therms: 100, gasCost: 120, hasGas: true }, // $1.20 per therm
    'Third Hall': { label: '2025', sqft: 5000, kwh: 1000, electricCost: 100, therms: 100, gasCost: 100, hasGas: true }, // $1.00 per therm
  };
  const sb = make(use, eqs);
  const e = sb._pricingZoneCo2SavingsEstimate('p', rows, est, { grand: 1200 });
  const th = e.buildings[0].therms.likely;
  const kwh = e.buildings[0].kwh.likely;
  near(e.buildings[0].usd.likely, th * 1.1 + kwh * 0.1, 0.001, 'gas rate = mean of $1.20 and $1.00');
  ok('no gas meter: the mean gas rate of the project buildings that have one');
}
// 5. no data, no estimate (never invent)
{
  const none = make({}, eqs)._pricingZoneCo2SavingsEstimate('p', rows, est, { grand: 1200 });
  assert.strictEqual(none.complete, false);
  assert.strictEqual(none.display, null);
  assert.strictEqual(none.buildings[0].usd, undefined);
  assert.strictEqual(none.total.usd.likely, 0);
  const noSqft = make({ 'Test Hall': Object.assign({}, gasUse, { sqft: 0 }) }, eqs)._pricingZoneCo2SavingsEstimate('p', rows, est, { grand: 1200 });
  assert.strictEqual(noSqft.complete, false);
  const noSched = make({ 'Test Hall': gasUse }, eqs.map((e) => Object.assign({}, e, { existingSchedule: null })))._pricingZoneCo2SavingsEstimate('p', rows, est, { grand: 1200 });
  assert.strictEqual(noSched.complete, false, 'no BAS schedule, no estimate');
  assert.strictEqual(make({}, eqs)._pricingZoneCo2SavingsEstimate('p', [], est, null), null, 'no rooms, no estimate');
  assert.strictEqual(make({}, eqs)._pricingZoneCo2EstimateText(none, true).savings, '');
  ok('no utility data, no floor area or no schedule: no estimate and no savings sentence');
}
// 6. a toggled-off row is not counted
{
  const sb = make({ 'Test Hall': gasUse }, eqs);
  assert.strictEqual(sb._pricingZoneCo2SavingsEstimate('p', rows, { rowToggles: { h1: false, s1: false } }, null), null);
  ok('rows the user toggled off are left out');
}
console.log('\n' + n + ' checks passed');
