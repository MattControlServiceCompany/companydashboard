// Test: the estimated savings and payback of an option, the Recommended membership by estimated payback, and the proposal wording (Matt 2026-11-19).
// SYNTHETIC data, hand-computed values. Run: node tools/test-option-savings-estimate.js   (exit 0 = all pass)
// Owners under test (app/pricing-estimator.js): _pricingOptionSavingsEstimate, _pricingApplyEstimateMembership, _pricingOptionEstimateText,
// _pricingEquipRowScore; they call simplePayback (computations/cost-lines.js). The building use and the equipment counts are stubbed.
//
// Fixture ("Test Hall"): 100,000 kWh for $10,000 ($0.10 per kWh); 10,000 therms for $8,000 ($0.80 per therm); 2 air handlers, 10 terminal units
// (VAV), 1 hot water plant. End uses (CBECS split in PRICING_OPTION_SAVINGS_ESTIMATE): cooling 32,000 kWh; fans 9,000 kWh; lighting 12,000 kWh;
// pumps 2,500 kWh; gas heating 8,400 therms.
// Items (likely case), each alone:
//   duct static pressure reset, 1 of 2 air handlers: fans 0.25 x 0.5 = 0.125 -> 1,125 kWh = $112.50
//   supply air temperature reset, 2 of 2: cooling 0.05 -> 1,600 kWh; heating 0.04 -> 336 therms; fans 0.20 -> 1,800 kWh; = $160 + $268.80 + $180 = $608.80
//   duct static pressure override: fans 0.25 -> 2,250 kWh (releases the duct static pressure reset: counted once with it in the set)
//   hot water pump pressure override: pumps 0.10 -> 250 kWh = $25 (its own sequence is not in the set: counted)
//   terminal unit upgrade, 5 of 10 units: cooling, fans, heating 0.07 x 0.5 = 0.035
//   economizer, 2 of 2: cooling 0.10 -> 3,200 kWh = $320 (price $5,000: 15.6 years, over the limit)
// Overlap in the building (override of a reset in the set is left out; the rest multiply):
//   fans    1 - (1 - 0.125)(1 - 0.20)(1 - 0.035) = 0.3245  -> 2,920.5 kWh
//   cooling 1 - (1 - 0.05)(1 - 0.035)            = 0.08325 -> 2,664 kWh
//   gas     1 - (1 - 0.04)(1 - 0.035)            = 0.0736  -> 618.24 therms
//   pumps   0.10 -> 250 kWh
//   total 5,834.5 kWh + 618.24 therms = $583.45 + $494.592 = $1,078.042 a year (a plain sum would give a different number)
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

function make(useByName, counts) {
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
  const store = { en_pricing_workbook_p: { method: 'hourly' } };
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
    document: { getElementById: () => null, createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
    sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    sset() {}, showToast() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    collectASHRAE36Data: () => ({ buildings: [{ name: 'Test Hall', equipResults: [], equipCounts: counts }] }),
    getUDBldgs: () => Object.keys(useByName).map((k) => ({ id: k, name: k })),
    _a36UtilityBuilding: (d, b) => (useByName[b.name] ? { id: b.name, name: b.name } : null),
    buildingAnnualUse: (pid, id) => useByName[id],
    EM_SEQUENCE_DEFS: [],
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/formatting.js'), sb);
  vm.runInContext(read('computations/cost-lines.js'), sb);
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  return sb;
}
const use = { label: '2025', sqft: 50000, kwh: 100000, electricCost: 10000, therms: 10000, gasCost: 8000, hasGas: true };
const counts = { ahu: 2, vav: 10, hwp: 1 };
const seq = (id, seqKey, qty, total) => ({ id, building: 'Test Hall', phase: 2, seqKey, qty, lineTotal: total, item: seqKey, _hwGroup: 'ready' });
const opp = (id, oppKey, qty, total, phase) => ({ id, building: 'Test Hall', phase: phase || 2, oppKey, qty, lineTotal: total, item: oppKey });
const rows = [
  seq('s_dsp', 'ahu_dsp_reset', 1, 1000),
  seq('s_sat', 'ahu_sat_reset', 2, 2000),
  opp('o_sp', 'spOverride', 1, 200),
  opp('o_hwdp', 'hwDpOverride', 1, 200),
  opp('o_term', 'terminalStandard', 5, 3000),
  seq('s_minoa', 'ahu_min_oa', 2, 500),
  seq('s_freeze', 'ahu_freeze_prot', 2, 300),
  opp('o_meter', 'powerMeter', 1, 800, 1),
];
const est = { rowToggles: {} };
const sum = (rs) => rs.reduce((s, r) => s + r.lineTotal, 0);

// 1. the estimate, hand computed (overlap = product; an override and its own sequence count once)
{
  const sb = make({ 'Test Hall': use }, counts);
  const e = sb._pricingOptionSavingsEstimate('p', rows, est, { grand: sum(rows) });
  assert.ok(e.claims && e.complete, 'claims and complete');
  near(e.total.kwh.likely, 5834.5, 0.0001, 'likely kWh (product overlap)');
  near(e.total.therms.likely, 618.24, 0.0001, 'likely therms');
  near(e.total.usd.likely, 1078.042, 0.0001, 'likely dollars (energy x own rate per fuel)');
  assert.ok(e.total.usd.low < e.total.usd.likely && e.total.usd.likely < e.total.usd.high, 'low < likely < high');
  near(e.total.price, 8000, 0.0001, 'price = the totals given');
  near(e.total.years.likely, 8000 / 1078.042, 0.0001, 'simple payback = price / annual savings');
  assert.strictEqual(e.display.likely, 1100);
  assert.strictEqual(e.display.years, 7);
  assert.strictEqual(e.year, '2025');
  const by = {};
  e.items.forEach((i) => (by[i.key] = i));
  near(by.ahu_dsp_reset.usd.likely, 112.5, 0.0001, 'duct static pressure reset alone');
  near(by.ahu_sat_reset.usd.likely, 608.8, 0.0001, 'supply air temperature reset alone');
  near(by.hwDpOverride.usd.likely, 25, 0.0001, 'pump pressure override alone');
  assert.strictEqual(by.powerMeter.claimed, false, 'a power meter claims no energy');
  assert.strictEqual(by.ahu_min_oa.claimed, false, 'minimum outdoor air claims no energy');
  assert.strictEqual(by.ahu_freeze_prot.claimed, false, 'freeze protection claims no energy');
  assert.strictEqual(by.ahu_min_oa.over || by.powerMeter.over || by.ahu_freeze_prot.over, false, 'no-claim items are never over the limit');
  ok('estimate: kWh, therms, dollars and payback equal the hand values; overlap is the product; an override counts once with its sequence');
}
// 2. no utility data = no estimate (the items stay, the display is empty)
{
  const sb = make({}, counts);
  const e = sb._pricingOptionSavingsEstimate('p', rows, est, { grand: sum(rows) });
  assert.strictEqual(e.display, null);
  assert.ok(e.items.every((i) => !i.over), 'nothing is removed without data');
  assert.strictEqual(sb._pricingOptionEstimateText(e, 'recommended'), '');
  ok('no utility data: no display, no sentence, nothing over the limit');
}
// 3. a gas-free building uses electric heating and the electric rate
{
  const sb = make({ 'Test Hall': { label: '2025', sqft: 50000, kwh: 100000, electricCost: 10000, therms: 0, gasCost: 0, hasGas: false } }, counts);
  const e = sb._pricingOptionSavingsEstimate('p', [seq('s_sat', 'ahu_sat_reset', 2, 2000)], est, { grand: 2000 });
  // cooling 0.28 x 100,000 = 28,000 x 0.05 = 1,400; electric heating 0.20 x 100,000 = 20,000 x 0.04 = 800; fans 9,000 x 0.20 = 1,800 -> 4,000 kWh = $400
  near(e.total.kwh.likely, 4000, 0.0001, 'electric heating counts as kWh');
  near(e.total.usd.likely, 400, 0.0001, 'dollars at the electric rate');
  assert.strictEqual(e.total.therms.likely, 0);
  ok('low-gas building: heating is electric, saved at the electric rate');
}
// 4. membership: a unit over 10 years leaves, no-claim items stay, the rest is re-priced
{
  const sb = make({ 'Test Hall': use }, counts);
  const all = rows.concat([seq('s_eco', 'ahu_economizer', 2, 5000)]);
  const m = sb._pricingApplyEstimateMembership('p', all, est);
  const ids = m.rows.map((r) => r.id);
  assert.ok(ids.indexOf('s_eco') === -1, 'the economizer (15.6 years) is out');
  ['s_dsp', 's_sat', 'o_term', 'o_sp', 'o_hwdp'].forEach((id) => assert.ok(ids.indexOf(id) > -1, id + ' stays (payback of 10 years or less)'));
  ['s_minoa', 's_freeze', 'o_meter'].forEach((id) => assert.ok(ids.indexOf(id) > -1, id + ' stays (no energy claimed)'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.notNow.map((x) => x.key))), ['ahu_economizer']);
  near(m.notNow[0].years, 5000 / 320, 0.0001, 'the removed unit carries its payback');
  assert.strictEqual(sb.PRICING_OPTION_SAVINGS_ESTIMATE.keepLimitYears, 10, 'the limit is 10 years, one place');
  ok('membership: the unit over 10 years leaves; power meter, minimum outdoor air, freeze protection and the others stay');
}
// 5. ranking: the shortest estimated payback first; no energy claimed first of all
{
  const sb = make({ 'Test Hall': use }, counts);
  const m = sb._pricingApplyEstimateMembership('p', rows, est);
  const sc = (id) => sb._pricingEquipRowScore(m.rows.filter((r) => r.id === id)[0]);
  near(sc('s_sat'), 100 / (2000 / 608.8), 0.0001, 'score = 100 / likely years');
  assert.ok(sc('s_sat') > sc('s_dsp'), 'a payback of 3.3 years ranks before 8.9 years');
  assert.strictEqual(sc('s_minoa'), 1000, 'no energy claimed: first');
  assert.ok(sc('s_minoa') > sc('s_sat'));
  assert.strictEqual(sb._pricingEquipRowScore({ phase: 1 }), -1, 'a standalone device keeps its place');
  assert.strictEqual(typeof sb.PRICING_NO_HW_SCORE_BONUS, 'undefined', 'the no-hardware bonus is removed');
  ok('ranking: shortest estimated payback first, no-claim items first of all, no bonus');
}
// 6. the client sentences
{
  const sb = make({ 'Test Hall': use }, counts);
  const e = sb._pricingOptionSavingsEstimate('p', rows, est, { grand: sum(rows) });
  assert.strictEqual(sb._pricingOptionEstimateText(e, 'recommended'), 'Estimated savings $1,100 per year (range $' + e.display.low.toLocaleString('en-US') + ' to $' + e.display.high.toLocaleString('en-US') + '); estimated payback about 7 years.');
  assert.strictEqual(sb._pricingOptionEstimateText(e, 'compliance'), 'No energy savings claimed: this option installs devices and safety programming.');
  assert.strictEqual(sb._pricingEstimateBasisText('2025', 'Kansas City'), "Estimates use each building's 2025 energy use and rates and typical Kansas City weather, and the savings shares come from published field studies and national building energy data.");
  ok('sentences: estimate with range and payback, Compliance claims none, one basis sentence');
}
// 7. no "finding" in the client text of the proposal (strings of the proposal functions of app/report-engine.js)
{
  const src = read('app/report-engine.js');
  const fn = (name) => {
    const a = src.indexOf('function ' + name + '(');
    assert.ok(a > -1, name);
    const b = src.indexOf('\nfunction ', a + 10);
    return src.slice(a, b > -1 ? b : a + 20000);
  };
  const text = [fn('rptPageASHRAE36ProposalCover'), fn('_rptA36TierPlain'), fn('_rptA36NotNowSentence'), fn('rptPageASHRAE36ProposalPricing')].join('\n') +
    src.slice(src.indexOf('var _RPT_A36_TIER_PLAIN'), src.indexOf('function _rptA36TierPlain'));
  // the string literals of every code line (a comment line is not client text; an identifier is not a literal)
  const bad = [];
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .forEach((l) => {
      (l.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || []).forEach((s) => {
        if (/finding/i.test(s)) bad.push(s.slice(0, 80));
      });
    });
  assert.deepStrictEqual(bad, [], 'a client string says "finding"');
  assert.ok(/Assessment Results/.test(src), 'page 1 heading is Assessment Results');
  ok('no string of the proposal pages says "finding"; page 1 heading is "Assessment Results"');
}
console.log(n + ' checks passed');
