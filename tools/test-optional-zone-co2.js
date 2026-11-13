// Test: zone CO2 scope is OPTIONAL scope in every cost tier (Matt, 2026-11-13). SYNTHETIC data only.
// Run: node tools/test-optional-zone-co2.js   (exit 0 = all pass)
// Loads app/pricing-estimator.js, estimate-workbook.js,
// audit-estimate.js and lib/formatting.js in a vm sandbox with a fake collectASHRAE36Data.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- synthetic fixture: one building, 3 buildings worth of cases in one --------------------------
const eq = (id, name, category, missing, covered, seq) => ({
  id,
  name,
  category,
  compliance: {
    missingPoints: missing.map((k) => ({ categoryKey: k })),
    coveredPoints: covered.map((k) => ({ categoryKey: k })),
  },
  seqReadiness: seq || {},
});
const BLOCKED = { status: 'blocked' };
const PARTIAL = { status: 'partial' };
const buildings = [
  {
    name: 'Test Hall A',
    equipResults: [
      // air handler: CO2 missing -> co2_ahu hardware + air handler DCV sequence. Must stay in BASE.
      eq('a1', 'AHU-1', 'ahu', ['co2'], [], { demandCtrl: BLOCKED }),
      // 3 VAV zones: temp sensor present, CO2 missing -> co2_zone_standalone + vav_dcv 'gap' labor.
      eq('v1', 'Room 1 - VAV-1', 'vav', ['co2'], ['zoneTemp'], { vav_dcv: BLOCKED }),
      eq('v2', 'Room 2 - VAV-2', 'vav', ['co2'], ['zoneTemp'], { vav_dcv: BLOCKED }),
      eq('v3', 'Room 3 - VAV-3', 'vav', ['co2'], ['zoneTemp'], { vav_dcv: PARTIAL }),
      // 2 VAV zones that already have CO2: vav_dcv labor is 'ready' (no sensor to buy) -> stays BASE.
      eq('v4', 'Room 4 - VAV-4', 'vav', [], ['zoneTemp', 'co2'], { vav_dcv: PARTIAL }),
      eq('v5', 'Room 5 - VAV-5', 'vav', [], ['zoneTemp', 'co2'], { vav_dcv: PARTIAL }),
      // fan-powered boxes: CO2 is an optional point category (Full Scope beyond-compliance rows).
      eq('f1', 'Room 6 - FPB-1', 'fpb', [], ['zoneTemp'], {}),
      eq('f2', 'Room 7 - FPB-2', 'fpb', [], ['zoneTemp'], {}),
      // exempt space (restroom): emLoadEquipConfigFlags says hasCO2=false -> in neither section.
      eq('f3', 'Restroom - FPB-3', 'fpb', [], ['zoneTemp'], {}),
    ],
  },
];
const EXEMPT_IDS = { f3: true };
const catalog = {
  'N1-AQX-C-A': { list: 500, net: 300, contract: 200 }, // zone CO2 sensor (standalone)
  'N1-DCD10-D-BB-LED-A': { list: 400, net: 240, contract: 160 }, // air handler CO2 sensor
};

function make(store) {
  const el = () => ({
    style: {},
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    classList: { add() {}, remove() {} },
    innerHTML: '',
  });
  const sb = {
    console,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    Date,
    Set,
    Map,
    RegExp,
    Error,
    document: {
      getElementById: () => null,
      createElement: el,
      head: el(),
      body: el(),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: el(),
    },
    sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
    sset: (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
    },
    showToast() {},
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    collectASHRAE36Data: () => ({ buildings }),
    EM_POINT_CATEGORIES: {
      fpb: [{ key: 'co2', required: false, configFlag: 'hasCO2', label: 'CO2' }],
    },
    emLoadEquipConfigFlags: (p, id) => (EXEMPT_IDS[id] ? { hasCO2: false } : {}),
    EM_SEQUENCE_DEFS: [],
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/formatting.js'), sb);
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  vm.runInContext(read('app/estimate-workbook.js'), sb);
  vm.runInContext(read('app/audit-estimate.js'), sb);
  return sb;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
let n = 0;
const ok = (name) => {
  n++;
  console.log('PASS ' + name);
};
const ZONE_CO2 = ['co2_zone', 'co2_zone_standalone'];
const isZoneCo2Hw = (r) => r.phase === 1 && ZONE_CO2.includes(r._pointKey);
const isGapDcv = (r) => r.phase === 2 && r.seqKey === 'vav_dcv' && r._hwGroup === 'gap';
const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const TIERS = ['compliance', 'recommended', 'full-scope'];
const builderOf = (sb, t) =>
  t === 'recommended' ? sb.buildRecommendedRows : t === 'full-scope' ? sb.buildFullScopeRows : sb.buildComplianceRows;

for (const method of ['hourly', 'workbook']) {
  const store = { en_pricing_catalog: catalog };
  if (method === 'hourly') store.en_pricing_workbook_p = { method: 'hourly' };
  const sb = make(store);
  const est = sb._pricingGetEstimate('p');

  // 1. the rule: one function, hardware by point key, programming only for the 'gap' group
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 1, _pointKey: 'co2_zone' }), true);
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 1, _pointKey: 'co2_zone_standalone' }), true);
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 1, _pointKey: 'co2_ahu' }), false);
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 2, seqKey: 'demandCtrl', _hwGroup: 'gap' }), false);
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 2, seqKey: 'vav_dcv', _hwGroup: 'gap' }), true);
  assert.strictEqual(sb._pricingIsOptionalZoneCo2Row({ phase: 2, seqKey: 'vav_dcv', _hwGroup: 'ready' }), false);
  ok(method + ': one rule function: zone CO2 hardware and gap-group zone DCV labor only');

  const all = {};
  for (const t of TIERS) {
    const base = builderOf(sb, t)('p');
    const opt = sb.buildOptionalZoneCo2Rows('p', t);

    // 2. zone CO2 rows are out of the base and in the optional section, in every tier
    assert.strictEqual(base.filter((r) => isZoneCo2Hw(r) || isGapDcv(r)).length, 0, t + ': no zone CO2 rows in base');
    const optHw = opt.filter(isZoneCo2Hw);
    const optQty = sum(optHw, (r) => r.qty);
    const wantQty = t === 'full-scope' ? 3 + 2 : 3; // 3 VAV zones; Full Scope adds 2 non-exempt fan-powered boxes
    assert.strictEqual(optQty, wantQty, t + ': optional zone CO2 sensor quantity');
    assert.ok(
      opt.every((r) => isZoneCo2Hw(r) || isGapDcv(r)),
      t + ': optional section holds only zone CO2 rows',
    );
    if (t !== 'compliance') {
      const optDcv = opt.filter(isGapDcv);
      assert.strictEqual(optDcv.length, 1, t + ': zone DCV gap labor is optional');
      assert.strictEqual(optDcv[0].qty, 3, t + ': zone DCV gap labor covers the 3 zones that need a sensor');
    }
    // 3. air handler CO2 stays in the base, and so does the 'ready' zone DCV labor
    assert.ok(
      base.some((r) => r.phase === 1 && r._pointKey === 'co2_ahu'),
      t + ': air handler CO2 stays in base',
    );
    if (t !== 'compliance') {
      assert.ok(
        base.some((r) => r.phase === 2 && r.seqKey === 'vav_dcv' && r._hwGroup === 'ready'),
        t + ': zone DCV labor for zones that already have a sensor stays in base',
      );
      assert.ok(
        base.some((r) => r.phase === 2 && r.seqKey === 'demandCtrl'),
        t + ': air handler DCV labor stays in base',
      );
    }
    // 4. exempt space (restroom) is in neither section
    const names = JSON.stringify(opt.concat(base).map((r) => r.equipment + '|' + r.id));
    assert.ok(!/Restroom/.test(names));
    const fpbOpt = opt.filter((r) => isZoneCo2Hw(r) && r.category === 'fpb');
    assert.strictEqual(sum(fpbOpt, (r) => r.qty), t === 'full-scope' ? 2 : 0, t + ': exempt fan-powered box not counted');
    all[t] = { base, opt };
  }
  ok(method + ': zone CO2 out of base and in the optional section in all 3 tiers; AHU CO2 and ready DCV stay in base');
  ok(method + ': exempt space type (restroom) is in neither section');

  // 5. totals: base excludes the optional rows; base + optional rows together equal the old total
  const summary = sb._pricingComputeSummaryData('p', est);
  for (const t of TIERS) {
    const rowsBase = sb._pricingApplyQtyOverrides('p', sb._pricingApplyLaborOverrides('p', all[t].base));
    const rowsOpt = sb._pricingApplyQtyOverrides('p', sb._pricingApplyLaborOverrides('p', all[t].opt));
    const baseTot = sb._pricingComputeTotals(rowsBase, est, 'p');
    assert.strictEqual(summary.tierTotals[t].grand, baseTot.grand, t + ': summary base total');
    assert.deepStrictEqual(plain(summary.perTier[t].map((r) => r.id)), plain(rowsBase.map((r) => r.id)));
    const o = summary.optional[t];
    assert.strictEqual(o.label, 'Optional: Zone CO2 Sensors');
    assert.strictEqual(o.sensorQty, sum(rowsOpt.filter(isZoneCo2Hw), (r) => r.qty), t + ': optional quantity');
    assert.ok(o.totals && o.totals.grand > 0, t + ': optional cost subtotal');
    // the old total (all rows together) is the base plus the optional rows (hourly: exact)
    const together = sb._pricingComputeTotals(rowsBase.concat(rowsOpt), est, 'p');
    if (method === 'hourly') {
      assert.strictEqual(Math.round((baseTot.grand + o.totals.grand) * 100), Math.round(together.grand * 100), t);
    } else {
      assert.ok(Math.abs(baseTot.grand + o.totals.grand - together.grand) <= 5, t + ': workbook base + optional ~ together');
    }
    assert.ok(baseTot.grand < together.grand, t + ': base total is lower than the old total');
  }
  // the same sensors show the same hardware figure in Compliance and Recommended; hardware + programming = section total
  assert.strictEqual(summary.optional.compliance.totals.phase1, summary.optional.recommended.totals.phase1, 'same hardware figure');
  for (const t of TIERS) {
    const ot = summary.optional[t].totals;
    assert.ok(Math.abs(ot.phase1 + ot.phase2 - ot.grand) < 0.011, t + ': hardware + programming = optional total');
  }
  ok(method + ': base total excludes the optional rows; base + optional = old total (workbook within rounding)');

  // 6. exports: Excel sets carry one optional set per tier (workbook method only)
  const sets = sb._pricingExportSets('p');
  const names = sets.map((s) => s.name);
  if (method === 'workbook') {
    assert.deepStrictEqual(plain(names), [
      'Compliance',
      'Recommended',
      'Full Scope',
      'Opt CO2 Compliance',
      'Opt CO2 Recommended',
      'Opt CO2 Full Scope',
    ]);
    sets.slice(3).forEach((s) => {
      assert.ok(s.grand > 0 && s.meta.title.indexOf('Optional: Zone CO2 Sensors') === 0);
      assert.ok(s.name.length <= 19, 'sheet prefix fits');
    });
    ok('workbook: Excel export has an optional set per tier, sheet prefix within 19 characters');
  } else {
    assert.deepStrictEqual(plain(names), []);
    ok('hourly: Excel export unchanged (no sets)');
  }

  // 7. proposal page block: reads summaryData.optional, prints quantity and cost per tier
  const src = read('app/report-engine.js');
  const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name);
    let d = 0,
      j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
    }
  };
  vm.runInContext(
    ['_rptA36OptionalZoneCo2HTML', '_rptFootTier', '_rptRoundUp100'].map(grab).join('\n'),
    sb,
  );
  const tierCols = [
    { key: 'recommended', label: 'Recommended' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'full-scope', label: 'Full Scope' },
  ];
  sb.__sd = summary;
  sb.__tc = tierCols;
  const html = vm.runInContext('_rptA36OptionalZoneCo2HTML(__sd, __tc)', sb);
  assert.ok(html.indexOf('Optional: Zone CO2 Sensors') >= 0);
  ['Recommended', 'Compliance', 'Full Scope'].forEach((l) => assert.ok(html.indexOf('>' + l + '<') >= 0, l));
  assert.ok(/>3<\/td>/.test(html) && />5<\/td>/.test(html), 'quantities 3 and 5 in the table');
  const fmt = (v) => sb._fmtUSD(v);
  const fsT = summary.optional['full-scope'].totals;
  const want = method === 'workbook' ? Math.round(fsT.grand) : Math.ceil(Math.round(fsT.grand * 100) / 100 / 100) * 100;
  assert.ok(html.indexOf(fmt(want)) >= 0, 'Full Scope optional cost printed: ' + fmt(want));
  ok(method + ': proposal block lists quantity and cost per tier');

  // 8. Cost Estimate tab block: label, quantity, cost, and no row outside the section
  const tabHtml = sb._pricingOptionalZoneCo2HTML('p', all['full-scope'].opt);
  assert.ok(tabHtml.indexOf('Optional: Zone CO2 Sensors') >= 0 && tabHtml.indexOf('5 sensors') >= 0);
  assert.ok(tabHtml.indexOf('<tfoot>') >= 0);
  assert.strictEqual(sb._pricingOptionalZoneCo2HTML('p', []), '');
  ok(method + ': Cost Estimate tab section shows the label, the sensor quantity and a footer total');
}

// 9. audit report is not touched: buildCatalogRows still lists every zone CO2 gap (the audit reads it)
{
  const sb = make({ en_pricing_catalog: catalog });
  const cat = sb.buildCatalogRows('p');
  assert.strictEqual(sum(cat.filter(isZoneCo2Hw), (r) => r.qty), 3);
  assert.ok(cat.some(isGapDcv));
  ok('buildCatalogRows (audit report source) still holds all zone CO2 rows');
}
// 10. budget ceiling (Fit to Budget): Fit to Budget reads buildRecommendedRows (base rows), so zone CO2 units never take
// ceiling room and non-CO2 units fill it. Recommended has no automatic ceiling; Fit to Budget is the user action.
{
  buildings.push({
    name: 'Test Hall B',
    equipResults: [
      eq('b1', 'AHU-B1', 'ahu', ['dsp'], [], { ahu_dsp_reset: BLOCKED }),
      eq('b2', 'AHU-B2', 'ahu', ['dsp'], [], { ahu_dsp_reset: BLOCKED }),
    ],
  });
  catalog['N1-ZPS-LR-EZ-NT-IN-A'] = { list: 300, net: 200, contract: 150 };
  const store = { en_pricing_catalog: catalog, en_pricing_workbook_p: { method: 'hourly' } };
  const sb = make(store);
  const base = sb.buildRecommendedRows('p');
  const opt = sb.buildOptionalZoneCo2Rows('p', 'recommended');
  assert.ok(opt.some(isZoneCo2Hw) && opt.some(isGapDcv), 'optional section lists the zone CO2 unit');
  assert.ok(base.some((r) => r._pointKey === 'dsp'), 'non-CO2 hardware unit is in the base');
  assert.strictEqual(base.filter((r) => sb._pricingIsOptionalZoneCo2Row(r)).length, 0);
  const baseUnits = sb._pricingBuildRoiUnits(base);
  const baseUnitCost = baseUnits.reduce((s, u) => s + u.cost, 0);
  assert.ok(baseUnits.length >= 2, 'several non-CO2 units exist');
  // ceiling = the full base unit cost: every base unit fits, no zone CO2 unit competes for the room
  const store2 = JSON.parse(JSON.stringify(store));
  store2['en_pricing_budget_p'] = {
    mode: 'recurring',
    amount: baseUnitCost,
    termMonths: 1,
    denomination: 'monthly',
    fitToBudget: false,
  };
  const sb2 = make(store2);
  const plan = sb2._pricingComputeBudgetFitPlan('p');
  assert.strictEqual(plan.excludedCount, 0, 'ceiling filled by non-CO2 units: nothing excluded');
  const unitKeys = baseUnits.reduce((a, u) => a.concat(u.toggleKeys), []);
  assert.deepStrictEqual(plain(plan.keepKeys.slice().sort()), plain(unitKeys.slice().sort()));
  // for comparison: zone CO2 units left in the pool would take ceiling room and push a base unit out
  const optUnits = sb._pricingBuildRoiUnits(opt);
  assert.ok(optUnits.length >= 1, 'zone CO2 unit exists');
  const oldPlan = sb._pricingGreedyPrefix(baseUnits.concat(optUnits), baseUnitCost);
  assert.ok(oldPlan.excludeKeys.length > 0, 'with zone CO2 in the pool the same ceiling would exclude a unit');
  ok('budget ceiling: base Recommended fills the ceiling with non-CO2 units once zone CO2 is taken out');
}
console.log('\n' + n + ' checks passed');
