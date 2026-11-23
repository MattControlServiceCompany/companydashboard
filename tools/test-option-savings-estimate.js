// Test: the estimated savings and payback of an option, the Recommended membership by estimated payback, and the proposal wording (Matt 2026-11-19).
// SYNTHETIC data, hand-computed values. Run: node tools/test-option-savings-estimate.js   (exit 0 = all pass)
// Owners under test (app/pricing-estimator.js): _pricingOptionSavingsEstimate, _pricingApplyEstimateMembership, _pricingOptionEstimateText,
// _pricingEquipRowScore; they call simplePayback (computations/cost-lines.js). The building use and the equipment counts are stubbed.
//
// (Matt 2026-11-23 8c5bfd4a) The savings of each item now come from the engineering formulas of computations/measure-savings.js (its own test:
// tools/test-measure-savings.js). This test checks how the proposal combines them. Stubs: the fan units, the Rules of Thumb end uses, the weather.
//
// Fixture ("Test Hall"): 50,000 ft2; 100,000 kWh for $10,000 ($0.10 per kWh); 10,000 therms for $8,000 ($0.80 per therm); 2 air handlers,
// 10 terminal units (VAV), 1 hot water plant. Fan units (variable-speed drive, 3,640 h): 5 kW and 3 kW. End-use base (Rules of Thumb): cooling
// 30,000 kWh; gas heating 6,000 therms. Window 8 to 18 h; bins 32.5, 57.5 and 77.5 F with 1,000 occupied hours each. Design airflow
// 50,000 / 300 x 400 = 66,666.7 cfm; average airflow 40,000 cfm (x 0.6). Items (likely case), each alone:
//   duct static pressure reset, 1 of 2 air handlers: fans 29,120 kWh x 0.256012 x pass 0.7 = 5,218.56 kWh for both, 2,609.28 kWh for one = $260.93
//   duct static pressure override: 5,218.56 kWh = $521.86 (releases the duct static pressure reset: counted once with it in the set)
//   supply air temperature reset, 2 of 2: reheat cfm 66,666.7 x 0.4 x 0.35 = 9,333.3; 1.08 x 9,333.3 x 10 F x 2,000 h / 82,000 = 2,458.54 therms;
//     coil load 2.5 F x 1,000 h x 1.08 x 40,000 cfm / (3.5 x 3,412.14) = 9,043.34 kWh = $904.33 + $1,966.83 = $2,871.16
//   hot water pump pressure override: gpm 150, 2.5877 kW, 1,000 h below 55 F, x (1 - 0.715542) = 736.09 kWh = $73.61 (own sequence not in the set: counted)
//   terminal unit upgrade, 5 of 10 units: delta cfm 5 x 6,666.7 x 0.2 x 0.4 = 2,666.7; 1.08 x 2,666.7 x 20 F x 1,000 h / 82,000 = 702.44 therms;
//     fan 8 kW x 0.5 x 0.4 x (0.35^3 - 0.15^3) x 1,000 h = 63.2 kWh; = $6.32 + $561.95 = $568.27
//   economizer, 2 of 2: free cooling 58,555.6 kWh, capped at the cooling base 30,000 kWh = $3,000 (price $40,000: 13.3 years, over the limit)
// Overlap in the building (override of a reset in the set is left out; the rest multiply per end use):
//   fans    29,120 x (1 - (1 - 2,609.28 / 29,120)(1 - 63.2 / 29,120)) = 2,666.82 kWh
//   cooling 9,043.34 kWh;  pumps 736.09 kWh;  gas  6,000 x (1 - (1 - 2,458.54 / 6,000)(1 - 702.44 / 6,000)) = 2,873.15 therms
//   total 12,446.25 kWh + 2,873.15 therms = $1,244.62 + $2,298.52 = $3,543.14 a year (a plain sum would give a different number)
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

const hourly = (v) => Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? v / 10 : 0)); // 1,000 hours a year inside 8 to 18 h
const WEATHER = { bins: [32.5, 57.5, 77.5], cities: { 4: { temp: Array.from({ length: 12 }, (_, m) => [hourly(m === 0 ? 1000 : 0), hourly(m === 0 ? 1000 : 0), hourly(m === 0 ? 1000 : 0)]) } } };
function make(useByName, counts, noSchedule) {
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
  const store = { en_pricing_workbook_p: { method: 'hourly' } };
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
    document: { getElementById: () => ({}), createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
    sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    sset() {}, showToast() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    collectASHRAE36Data: () => ({ buildings: [{ name: 'Test Hall', equipResults: noSchedule ? [] : [{ category: 'vav', existingSchedule: { startMin: 480, stopMin: 1080 } }], equipCounts: counts }] }),
    getUDBldgs: () => Object.keys(useByName).map((k) => ({ id: k, name: k })),
    _a36UtilityBuilding: (d, b) => (useByName[b.name] ? { id: b.name, name: b.name } : null),
    buildingAnnualUse: (pid, id) => useByName[id],
    EM_SEQUENCE_DEFS: [],
    // (Matt 2026-11-23 8c5bfd4a) the fan units, the Rules of Thumb end uses and the weather the measure formulas read
    hvacRuleOfThumbEnduse: (pid, bid, kwh, therms, electricHeat) =>
      electricHeat ? { coolKwh: 28000, heatKwh: 20000, heatGasTherms: 0 } : { coolKwh: 30000, heatKwh: 0, heatGasTherms: 6000 },
    BAS_WEATHER_BINS: WEATHER,
    EM_SPACE_TYPE_ZONE_TERMINAL_CATS: { vav: true },
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/formatting.js'), sb);
  vm.runInContext(read('computations/cost-lines.js'), sb);
  ['computations/physics.js', 'computations/fan-savings.js', 'app/ecm-calculators.js', 'computations/measure-savings.js'].forEach((f) => vm.runInContext(read(f), sb)); // (Matt 2026-11-23 8c5bfd4a)
  sb.fanBuildingUnitModels = () => [fanUnit(5), fanUnit(3)]; // after fan-savings.js: stands in for the Equipment Matrix reader
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  return sb;
}
const fanUnit = (kw) => ({ id: 'f' + kw, ok: true, kw, hours: 3640, hoursLevel: 'default', kwLevel: 'default', kwh: kw * 3640, baselineFraction: 1, driveStatus: 'has', reset: { pass: 0.7, level: 'default' } });
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
  near(e.total.kwh.likely, 12446.25, 0.0001, 'likely kWh (product overlap)'); // (Matt 2026-11-23 8c5bfd4a) engineering formulas
  near(e.total.therms.likely, 2873.15, 0.0001, 'likely therms');
  near(e.total.usd.likely, 3543.14, 0.0001, 'likely dollars (energy x own rate per fuel)');
  assert.ok(e.total.usd.low < e.total.usd.likely && e.total.usd.likely < e.total.usd.high, 'low < likely < high');
  near(e.total.price, 8000, 0.0001, 'price = the totals given');
  near(e.total.years.likely, 8000 / 3543.14, 0.0001, 'simple payback = price / annual savings');
  assert.strictEqual(e.display.likely, 3500);
  assert.strictEqual(e.display.years, 2);
  assert.strictEqual(e.year, '2025');
  const by = {};
  e.items.forEach((i) => (by[i.key] = i));
  near(by.ahu_dsp_reset.usd.likely, 260.93, 0.0001, 'duct static pressure reset alone (1 of 2 units)');
  near(by.spOverride.usd.likely, 521.86, 0.0001, 'duct static pressure override alone (every unit)');
  near(by.ahu_sat_reset.usd.likely, 2871.16, 0.0001, 'supply air temperature reset alone');
  near(by.terminalStandard.usd.likely, 568.27, 0.0001, 'terminal minimum airflow alone');
  near(by.hwDpOverride.usd.likely, 73.61, 0.0001, 'pump pressure override alone');
  assert.ok(by.ahu_dsp_reset.inputs.likely.length > 3 && by.ahu_dsp_reset.steps.likely.length > 2, 'each item carries its inputs and steps');
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
// 2b. (Matt 2026-11-23 8c5bfd4a) a Matrix with no VAV rows is missing input, not proof of no VAV: the item itself shows the unit controls duct static pressure, so it is estimated
{
  const noVav = { ahu: 2, vav: 0, hwp: 1 };
  const sb = make({ 'Test Hall': use }, noVav);
  const rs = [seq('s_dsp', 'ahu_dsp_reset', 2, 1000), opp('o_sp', 'spOverride', 1, 200)];
  const e = sb._pricingOptionSavingsEstimate('p', rs, est, { grand: 1200 });
  const by = {};
  e.items.forEach((i) => (by[i.key] = i));
  assert.strictEqual(by.ahu_dsp_reset.hasData, true);
  assert.ok(by.ahu_dsp_reset.usd.likely > 0, 'duct static pressure reset without VAV rows in the Matrix: a real estimate, not 0');
  assert.ok(!by.ahu_dsp_reset.reason, 'no reason of zero');
  assert.ok(by.spOverride.usd.likely > 0 || by.spOverride.claimed === false, 'its override is estimated or released into the sequence');
  ok('no VAV rows in the Equipment Matrix: duct static pressure reset is still estimated from the fan units');
}
// 2c. (Matt 2026-11-23 8c5bfd4a) no BAS schedule: the default window (8 to 18 h, 70 hours a week) gives an estimate, never a hole
{
  const sb = make({ 'Test Hall': use }, counts, true);
  const e = sb._pricingOptionSavingsEstimate('p', [seq('s_sat', 'ahu_sat_reset', 2, 2000)], est, { grand: 2000 });
  near(e.total.usd.likely, 2871.16, 0.0001, 'the default window 8 to 18 h gives the same bins as the 8 to 18 h fixture');
  const inp = e.items[0].inputs.likely.filter((i) => i.name === 'Occupied hours of the day')[0];
  assert.ok(inp && inp.level === 'default' && /70 hours a week/.test(inp.source), 'the input states the default window and its source');
  ok('no BAS schedule: the default window of 70 hours a week is used and stated');
}
// 3. a gas-free building uses electric heating and the electric rate
{
  const sb = make({ 'Test Hall': { label: '2025', sqft: 50000, kwh: 100000, electricCost: 10000, therms: 0, gasCost: 0, hasGas: false } }, counts);
  const e = sb._pricingOptionSavingsEstimate('p', [seq('s_sat', 'ahu_sat_reset', 2, 2000)], est, { grand: 2000 });
  // (Matt 2026-11-23 8c5bfd4a) electric reheat 201.6e6 Btu / 3,412.14 = 59,085 kWh, capped at the electric heating base 20,000 kWh; cooling 9,043.34 kWh
  near(e.total.kwh.likely, 29043.34, 0.0001, 'electric heating counts as kWh, capped at its base');
  near(e.total.usd.likely, 2904.33, 0.0001, 'dollars at the electric rate');
  assert.strictEqual(e.total.therms.likely, 0);
  ok('low-gas building: heating is electric, saved at the electric rate');
}
// 4. membership: a unit over 10 years leaves, no-claim items stay, the rest is re-priced
{
  const sb = make({ 'Test Hall': use }, counts);
  const all = rows.concat([seq('s_eco', 'ahu_economizer', 2, 40000)]);
  const m = sb._pricingApplyEstimateMembership('p', all, est);
  const ids = m.rows.map((r) => r.id);
  assert.ok(ids.indexOf('s_eco') === -1, 'the economizer (13.3 years) is out');
  ['s_dsp', 's_sat', 'o_term', 'o_sp', 'o_hwdp'].forEach((id) => assert.ok(ids.indexOf(id) > -1, id + ' stays (payback of 10 years or less)'));
  ['s_minoa', 's_freeze', 'o_meter'].forEach((id) => assert.ok(ids.indexOf(id) > -1, id + ' stays (no energy claimed)'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.notNow.map((x) => x.key))), ['ahu_economizer']);
  near(m.notNow[0].years, 40000 / 3000, 0.0001, 'the removed unit carries its payback (saving capped at the cooling base)');
  assert.strictEqual(sb.PRICING_OPTION_SAVINGS_ESTIMATE.keepLimitYears, 10, 'the limit is 10 years, one place');
  ok('membership: the unit over 10 years leaves; power meter, minimum outdoor air, freeze protection and the others stay');
}
// 5. ranking: the shortest estimated payback first; no energy claimed first of all
{
  const sb = make({ 'Test Hall': use }, counts);
  const m = sb._pricingApplyEstimateMembership('p', rows, est);
  const sc = (id) => sb._pricingEquipRowScore(m.rows.filter((r) => r.id === id)[0]);
  near(sc('s_sat'), 100 / (2000 / 2871.16), 0.0001, 'score = 100 / likely years');
  assert.ok(sc('s_sat') > sc('s_dsp'), 'a payback of 0.7 years ranks before 3.8 years');
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
  assert.strictEqual(sb._pricingOptionEstimateText(e, 'recommended'), 'Estimated savings $3,500 per year (range $' + e.display.low.toLocaleString('en-US') + ' to $' + e.display.high.toLocaleString('en-US') + '); estimated payback about 2 years.');
  assert.strictEqual(sb._pricingOptionEstimateText(e, 'compliance'), 'No energy savings claimed: this option installs devices and safety programming.');
  // (Matt 2026-11-23 8c5bfd4a) the basis sentence names the engineering formulas
  assert.strictEqual(sb._pricingEstimateBasisText('2025', 'Kansas City'), "Savings are estimated with engineering formulas for each measure (fan and pump laws, airflow and heat transfer with typical Kansas City weather) from each building's 2025 utility use and its equipment.");
  ok('sentences: estimate with range and payback, Compliance claims none, one basis sentence');
}
// 6b. (Matt 2026-11-23, 5df0a14e) the per-item cells and the top line of the Cost Estimate tab: same numbers, same rounding, site only
{
  const sb = make({ 'Test Hall': use }, counts);
  const e = sb._pricingOptionSavingsEstimate('p', rows, est, { grand: sum(rows) });
  const by = {};
  e.items.forEach((i) => (by[i.key] = i));
  const cells = (k) => JSON.parse(JSON.stringify(sb._pricingItemSavingsCellsHTML(by[k])));
  // each item shows on its first row; every item has one and the rows are different
  const first = e.items.map((i) => i.rowIds[0]);
  assert.strictEqual(new Set(first).size, e.items.length, 'one first row for every item');
  first.forEach((id) => assert.ok(rows.some((r) => r.id === id), id + ' is a row of the option'));
  const dsp = cells('ahu_sat_reset');
  assert.strictEqual(dsp.savings, '$2,900', 'likely 2,871.16 to the nearest $100, the same rounding as the option line');
  assert.strictEqual(dsp.years, '&lt;1', 'payback 2,000 / 2,871 = 0.7 years shows as <1 (an item under one year; Manager 2026-11-23 5df0a14e)');
  assert.strictEqual(dsp.title, 'Estimated savings range $' + sb._pricingEstimateRound100(by.ahu_sat_reset.usd.low).toLocaleString('en-US') + ' to $' + sb._pricingEstimateRound100(by.ahu_sat_reset.usd.high).toLocaleString('en-US') + ' per year');
  assert.strictEqual(cells('ahu_dsp_reset').savings, '$300', '260.93 rounds to $300');
  ['powerMeter', 'ahu_min_oa', 'ahu_freeze_prot'].forEach((k) => {
    const c = cells(k);
    assert.ok(/—/.test(c.savings) && /—/.test(c.years), k + ': no energy claim shows a dash');
  });
  assert.ok(/—/.test(sb._pricingItemSavingsCellsHTML(null).savings), 'a row that starts no item shows a dash');
  // the top line reads the same display values as the client sentence
  assert.strictEqual(
    sb._pricingOptionTopLineText(e, 'recommended'),
    'Estimated savings $3,500/yr (range $' + e.display.low.toLocaleString('en-US') + '-$' + e.display.high.toLocaleString('en-US') + ') · payback about 2 yr',
  );
  assert.strictEqual(sb._pricingOptionTopLineText(e, 'compliance'), 'No energy savings claimed: this option installs devices and safety programming.');
  assert.strictEqual(sb._pricingOptionTopLineText(null, 'recommended'), '');
  const noUse = make({}, counts)._pricingOptionSavingsEstimate('p', rows, est, { grand: sum(rows) });
  assert.strictEqual(make({}, counts)._pricingOptionTopLineText(noUse, 'recommended'), '', 'no data: no line');
  // the columns: right after Total, before Impact; not sortable; no other file reads the column list
  const cols = sb.PRICING_TBL_COLS.map((c) => c.label);
  const iTot = cols.indexOf('Line Total');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cols.slice(iTot + 1, iTot + 4))), ['Est. savings ($/yr, likely)', 'Payback (yr)', 'Impact']);
  assert.ok(sb.PRICING_TBL_COLS[iTot + 1].noSort && sb.PRICING_TBL_COLS[iTot + 2].noSort);
  assert.strictEqual(sb.PRICING_TBL_COLS[iTot + 1].isItemSavingsCol, true);
  assert.strictEqual(sb.PRICING_COL_SCHEMA_VERSION, 5, 'two columns inserted at 13: schema version 5');
  assert.strictEqual(sb._pricingRowColValue({ note: 'n' }, cols.indexOf('Notes')), 'n', 'Notes sorts by its own index');
  const users = fs.readdirSync(path.join(ROOT, 'app')).filter((f) => /\.js$/.test(f) && f !== 'pricing-estimator.js' && /PRICING_TBL_COLS|isItemSavingsCol|_pricingItemSavingsCellsHTML/.test(read('app/' + f)));
  assert.deepStrictEqual(users, [], 'no report or export file reads the table columns');
  ok('item savings cells: rounding, dashes, first row of each item, top line text, column order, no other reader of the columns');
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
