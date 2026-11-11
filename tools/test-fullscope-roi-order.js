// PD-11 + PD-16 acceptance test (Matt 2026-11-03). Synthetic data only.
// Run: node tools/test-fullscope-roi-order.js   (exit 0 = all pass)
//  PD-11: Full Scope holds every item; a monitoring-only zone unit is priced, never dropped.
//  PD-16: phase order follows ROI score only (impact weight per installed dollar); no category bonus.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path');
const ROOT = path.join(__dirname, '..');
function makeCtx(store) {
  const el = () => ({
    style: {},
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    classList: { add() {}, remove() {} },
    innerHTML: '',
  });
  const doc = {
    getElementById: () => null,
    createElement: el,
    head: el(),
    body: el(),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: el(),
  };
  const sb = {
    console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite,
    Date, Set, Map, RegExp, Error,
    document: doc,
    sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    sset: (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
    },
    showToast() {},
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
  };
  sb.window = sb;
  sb.globalThis = sb;
  return vm.createContext(sb);
}
const run = (ctx, s) => vm.runInContext(s, ctx);
let pass = 0,
  fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  }
}

const store = {};
const ctx = makeCtx(store);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/pricing-estimator.js'), 'utf8'), ctx, {
  filename: 'app/pricing-estimator.js',
});

// ---- PD-11 fixture: one building, two VAV zones. Zone V1 is normal (missing zoneTemp).
// Zone V2 is monitoring-only (missing BOTH coolSP and htgSP, plus zoneTemp). ----
function zone(id, missing) {
  return {
    id: id,
    name: id,
    category: 'vav',
    compliance: {
      missingPoints: missing.map((k) => ({ categoryKey: k })),
      coveredPoints: [],
    },
    seqReadiness: {},
  };
}
store.en_pricing_catalog = { 'ZS2-ALC': { list: 100, net: 80 } };
ctx.collectASHRAE36Data = () => ({
  buildings: [
    {
      name: 'Bldg A',
      equipResults: [zone('V1', ['zoneTemp']), zone('V2', ['coolSP', 'htgSP', 'zoneTemp'])],
    },
  ],
});
const qtyOf = (rows) => rows.filter((r) => r.type !== 'Sequence' && /Zone/i.test(r.item + '')).reduce((s, r) => s + r.qty, 0);
let fsRows = [];
let compRows = [];
try {
  fsRows = run(ctx, 'buildFullScopeRows(1)');
  compRows = run(ctx, 'buildCatalogRows(1)');
} catch (e) {
  console.log('ERROR building rows: ' + e.message);
}
const fsZone = fsRows.filter((r) => r.building === 'Bldg A' && /^fsc_/.test(r.id) && r.qty > 0 && r.sku === 'ZS2-ALC');
const fsQty = fsZone.reduce((s, r) => s + r.qty, 0);
const fsTotal = fsZone.reduce((s, r) => s + (r.lineTotal || 0), 0);
check('PD-11 Full Scope prices the monitoring-only zone unit (qty 2 = V1 + V2)', fsQty === 2, 'qty=' + fsQty);
check('PD-11 Full Scope zone sensor line total > 0 and covers both units', fsTotal > 0 && fsZone.every((r) => r.lineTotal > 0), 'total=' + fsTotal);
const compQty = compRows.filter((r) => r.sku === 'ZS2-ALC').reduce((s, r) => s + r.qty, 0);
check('PD-11 Compliance keeps its scope (monitoring-only unit stays out, qty 1)', compQty === 1, 'qty=' + compQty);
// Shared toggle state: every Compliance row id is still the _baseId of a Full Scope row.
const baseIds = new Set(fsRows.map((r) => r._baseId));
check('PD-11 every Compliance row id is a Full Scope _baseId', compRows.every((r) => baseIds.has(r.id)));
check('PD-11 Full Scope total >= Compliance total (PD-10)',
  fsRows.reduce((s, r) => s + (r.lineTotal || 0), 0) >= compRows.reduce((s, r) => s + (r.lineTotal || 0), 0));

// ---- PD-16: score = impact weight per installed dollar, no category bonus ----
function seqRow(seqKey) {
  return { phase: 2, seqKey: seqKey, _savingsWeight: 2.5, _effectiveCostTier: 2 };
}
const keys = ['vav_dcv', 'demandCtrl', 'ahu_sat_reset', 'vav_zone_temp'];
const scores = keys.map((k) => run(ctx, '_pricingEquipRowScore(' + JSON.stringify(seqRow(k)) + ')'));
check('PD-16 equal weight and cost give equal score for every seqKey (1.25)',
  scores.every((s) => s === 1.25), JSON.stringify(scores));
check('PD-16 no priorityBonus field remains in SEQUENCE_SAVINGS_IMPACT',
  run(ctx, 'Object.keys(SEQUENCE_SAVINGS_IMPACT).every(function(k){return SEQUENCE_SAVINGS_IMPACT[k].priorityBonus === undefined;})'));

// Order follows score only: a hardware-needing unit with the higher score sorts before a
// no-hardware unit with the lower score, and the reverse.
ctx.__u = [
  { score: 1.0, hwRows: [], seqRow: { seqKey: 'ahu_sat_reset' } },
  { score: 1.5, hwRows: [{ id: 'h' }], seqRow: { seqKey: 'vav_dcv' } },
  { score: 0.5, hwRows: [], seqRow: { seqKey: 'ahu_dsp_reset' } },
];
const order = run(ctx, '_pricingSortUnitsByRoi(__u)').map((u) => u.score);
check('PD-16 units sort by score only (1.5, 1.0, 0.5)', JSON.stringify(order) === '[1.5,1,0.5]', JSON.stringify(order));
ctx.__t = [
  { score: 3, seqRow: { seqKey: 'a' } },
  { score: 3, seqRow: { seqKey: 'b' } },
  { score: 3, seqRow: { seqKey: 'vav_dcv' } },
];
const tie = run(ctx, '_pricingSortUnitsByRoi(__t)').map((u) => u.seqRow.seqKey);
check('PD-16 tied scores keep input order (no category goes first)', JSON.stringify(tie) === '["a","b","vav_dcv"]', JSON.stringify(tie));
// Display sort used by the Recommended table follows the same rule.
const rs = run(ctx, '_pricingSortRecommendedRows([{seqKey:"x",_hwGroup:"gap",_savingsWeight:3,_effectiveCostTier:1,savingsImpact:"high",qty:1},{seqKey:"vav_dcv",_hwGroup:"ready",_savingsWeight:1,_effectiveCostTier:1,savingsImpact:"high",qty:1}])').map((r) => r.seqKey);
check('PD-16 display sort: higher ROI first regardless of hardware group or DCV', JSON.stringify(rs) === '["x","vav_dcv"]', JSON.stringify(rs));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
