// WP4 test: Cost Estimate tiers priced by the workbook engine - SYNTHETIC data only.
// Run: node tools/test-pricing-workbook-tiers.js   (exit 0 = all pass)
// Hourly mode is compared with app/pricing-estimator.js before WP4 (git 587fd84).
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert'),
  cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const EW = require(path.join(ROOT, 'app/estimate-workbook.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const oldPE = cp.execFileSync('git', ['show', '587fd84:app/pricing-estimator.js'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 1 << 26,
});

function make(peSrc, store, tiers) {
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
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(peSrc, sb);
  vm.runInContext(read('app/estimate-workbook.js'), sb);
  vm.runInContext(read('app/audit-estimate.js'), sb);
  if (tiers) {
    sb.buildComplianceRows = () => tiers.compliance;
    sb.buildRecommendedRows = () => tiers.recommended;
    sb.buildFullScopeRows = () => tiers['full-scope'];
    sb._pricingApplyLaborOverrides = (p, r) => r;
    sb._pricingApplyQtyOverrides = (p, r) => r;
  }
  return sb;
}

// Synthetic rows: hardware (parts + install labor) and sequence labor.
function hw(id, b, qty, part, instH, rate) {
  const inst = +(instH * qty * rate).toFixed(2);
  return {
    id,
    building: b,
    phase: 1,
    qty,
    sku: 'S-' + id,
    ioOnly: false,
    noSku: false,
    engReview: false,
    partsLineTotal: +(part * qty).toFixed(2),
    installHours: instH,
    installLaborRate: rate,
    installLaborTotal: inst,
    lineTotal: +(part * qty + inst).toFixed(2),
  };
}
function sq(id, b, qty, hrs, rate) {
  return {
    id,
    building: b,
    phase: 2,
    qty,
    seqKey: 'k' + id,
    hrsPerUnit: hrs,
    ioOnly: false,
    noSku: false,
    engReview: false,
    lineTotal: +(qty * hrs * rate).toFixed(2),
  };
}
const RATE = 170;
function tiers() {
  const a = [
    hw('h1', 'Alpha', 3, 41.37, 1.5, RATE),
    hw('h2', 'Beta', 7, 12.99, 0.75, RATE),
    sq('s1', 'Alpha', 2, 2.5, RATE),
    sq('s2', 'Beta', 5, 1.25, RATE),
    sq('s3', 'Gamma', 1, 3.4, RATE),
  ];
  const b = a.concat([hw('h3', 'Gamma', 11, 88.2, 2, RATE), sq('s4', 'Gamma', 4, 2, RATE)]);
  return { compliance: a.slice(0, 3), recommended: a, 'full-scope': b };
}
const catalog = { 'S-h1': { list: 1 }, 'S-h2': { list: 1 }, 'S-h3': { list: 1 } };
const est = {
  rowToggles: { s3: false },
  manualPrices: {},
  laborOverrides: {},
  installHoursOverrides: {},
  qtyOverrides: {},
  noteOverrides: {},
  tier: 'compliance',
};
let n = 0;
const ok = (name) => {
  n++;
  console.log('PASS ' + name);
};
const plain = (x) => JSON.parse(JSON.stringify(x));

// 1. Hourly mode == old code (totals per tier, with and without projId, and summary data)
{
  const T = tiers();
  const oldC = make(oldPE, { en_pricing_catalog: catalog }, T);
  const newC = make(
    read('app/pricing-estimator.js'),
    { en_pricing_catalog: catalog, en_pricing_workbook_p: { method: 'hourly' } },
    T,
  );
  for (const t of Object.keys(T)) {
    const o = oldC._pricingComputeTotals(T[t], est);
    assert.deepStrictEqual(plain(newC._pricingComputeTotals(T[t], est, 'p')), plain(o), 'totals ' + t);
    assert.deepStrictEqual(plain(newC._pricingComputeTotals(T[t], est)), plain(o), 'totals no projId ' + t);
  }
  ok('hourly totals identical to main (3 tiers, with and without projId)');
  assert.deepStrictEqual(
    plain(newC._pricingComputeSummaryData('p', est)),
    plain(oldC._pricingComputeSummaryData('p', est)),
  );
  ok('hourly summary data identical to main');
}

// 2. Workbook mode (method absent): totals == compute() on the same input; phases sum to the total.
{
  const T = tiers();
  const store = { en_pricing_catalog: catalog };
  const c = make(read('app/pricing-estimator.js'), store, T);
  const r = c._pricingComputeTotals(T.recommended, est, 'p');
  assert.strictEqual(r.method, 'workbook');
  // included rows: h1, h2, s1, s2 (s3 is toggled off)
  const parts = Math.round((3 * 41.37 + 7 * 12.99) * 100) / 100;
  const instH = 3 * 1.5 + 7 * 0.75,
    seqH = 2 * 2.5 + 5 * 1.25;
  const exp = EW.compute({ hours: { EI: instH, SE: seqH }, parts: [{ qty: 1, unit: parts }] });
  assert.strictEqual(r.grand, exp.summary.total);
  assert.strictEqual(r.phase1 + r.phase2, r.grand);
  assert.ok(Number.isInteger(r.grand) && Number.isInteger(r.phase1) && Number.isInteger(r.phase2));
  ok('workbook tier total == compute() (' + r.grand + '), phases ' + r.phase1 + ' + ' + r.phase2);

  store.en_pricing_workbook_p = {
    roles: { install_per_point: 'SC', bas_programming: 'DE' },
    ot: 'x1.5',
    state: 'Missouri',
    taxRate: 0.0875,
    bond: true,
  };
  const r2 = c._pricingComputeTotals(T.recommended, est, 'p');
  const exp2 = EW.compute({
    hours: { SC: instH, DE: seqH },
    ot: 'x1.5',
    state: 'Missouri',
    taxRate: 0.0875,
    bond: true,
    parts: [{ qty: 1, unit: parts }],
  });
  assert.strictEqual(r2.grand, exp2.summary.total);
  assert.strictEqual(r2.phase1 + r2.phase2, r2.grand);
  ok('workbook with roles/OT/tax/bond == compute() (' + r2.grand + ')');

  assert.ok(r.grand % 100 !== 0 || r2.grand % 100 !== 0);
  ok('no round-up to $100');

  delete store.en_pricing_workbook_p;
  const sd = c._pricingComputeSummaryData('p', est);
  for (const t of Object.keys(T)) {
    const tt = sd.tierTotals[t];
    const sum = sd.buildings.reduce((s, b) => s + b.tiers[t].total, 0);
    assert.strictEqual(sum, tt.grand, 'buildings sum ' + t);
    assert.strictEqual(tt.phase1 + tt.phase2, tt.grand);
  }
  ok('summary: per-building totals add up to each tier total');

  const mr = {
    id: 'm1',
    building: 'Alpha',
    phase: 1,
    qty: 2,
    sku: null,
    noSku: true,
    ioOnly: false,
    engReview: false,
    installHours: 1,
    installLaborTotal: 340,
    installLaborRate: RATE,
    lineTotal: null,
  };
  const rm = c._pricingComputeTotals([mr], { rowToggles: {}, manualPrices: { m1: '55.5' } }, 'p');
  const em = EW.compute({ hours: { EI: 2 }, parts: [{ qty: 1, unit: 111 }] });
  assert.strictEqual(rm.grand, em.summary.total);
  ok('manual-price row: parts = typed price x qty, install hours to EI');

  assert.strictEqual(c._pricingComputeTotals([], est, 'p').grand, null);
  ok('no priced rows -> grand null');
}
// 3. Proposal output in workbook mode (report-engine.js): no round-up to $100, itemized lines add up
//    to the workbook subtotals, no "Rounding" line. Hourly keeps the old rule.
{
  const REP = read('app/report-engine.js');
  function fnSrc(src, name) {
    const m = new RegExp('function ' + name + '[ ]*[(]').exec(src);
    let d = 0,
      e = src.indexOf('(', m.index);
    for (; e < src.length; e++) {
      if (src[e] === '(') d++;
      else if (src[e] === ')' && --d === 0) break;
    }
    let j = src.indexOf('{', e);
    d = 0;
    for (; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}' && --d === 0) break;
    }
    return src.slice(m.index, j + 1);
  }
  const rsb = { console, Math, Object, Array, String, Number, JSON, isFinite, isNaN };
  vm.createContext(rsb);
  vm.runInContext(
    [
      'function _esc(s){ return String(s == null ? "" : s); }',
      fnSrc(read('app/audit-estimate.js'), '_auditEstAllocate'),
      fnSrc(read('app/audit-estimate.js'), '_auditEstShareLines'),
    ]
      .concat(
        [
          '_rptRoundUp100',
          '_rptTierTotal',
          '_rptFootTier',
          '_rptItemizedLine',
          '_rptItemizedLineText',
          '_rptRoundingDelta',
          '_rptA36TierDetailAggByPhase',
          '_rptA36HardwareCategoryAgg',
          '_rptA36TierDetailPanelHTML',
        ].map((f) => fnSrc(REP, f)),
      )
      .join('\n'),
    rsb,
  );
  const ev = (e) => vm.runInContext(e, rsb);
  rsb.__fmt = (v) => '$' + Math.round(v).toLocaleString('en-US');
  // grand 5489
  assert.strictEqual(ev("_rptTierTotal({ grand: 5489, method: 'workbook' })"), 5489);
  assert.strictEqual(ev('_rptTierTotal({ grand: 5489 })'), 5500);
  assert.deepStrictEqual(plain(ev('_rptFootTier(5489, 4303, 1186, true)')), { totalR: 5489, p1r: 4303, p2r: 1186 });
  assert.strictEqual(ev('_rptFootTier(5489, 4303, 1186).totalR'), 5500);
  ok('proposal: workbook grand 5489 prints 5489; Hourly still rounds up to 5500');

  // 3700 hardware / 1020 sequence rows, workbook subtotals 4303 / 1186
  const rows = [
    { id: 'h', item: 'Zone Sensor', phase: 1, qty: 4, lineTotal: 3700 },
    { id: 'q', item: 'Seq A', phase: 2, qty: 2, lineTotal: 600 },
    { id: 'r', item: 'Seq B', phase: 2, qty: 1, lineTotal: 420 },
  ];
  rsb.__tt = { compliance: { grand: 5489, phase1: 4303, phase2: 1186, method: 'workbook' }, recommended: null };
  rsb.__sd = { perTier: { compliance: rows } };
  const html = ev("_rptA36TierDetailPanelHTML('compliance', __tt, __sd, {rowToggles:{}}, true, __fmt)");
  assert.ok(!/Rounding/.test(html), 'no Rounding line in workbook mode');
  const usd = (t) => Number(t.replace(/[$,]/g, ''));
  const hwPart = html.slice(0, html.indexOf('>Programming'));
  const pgPart = html.slice(html.indexOf('>Programming'));
  const sub = (part) => usd(/font-weight:700">(\$[\d,]+)<\/span>/.exec(part)[1]);
  const lines = (part) => [...part.matchAll(/<li>[^<]*: (?:\d+ units, )?(\$[\d,]+)<\/li>/g)].map((m) => usd(m[1]));
  assert.strictEqual(sub(hwPart), 4303);
  assert.strictEqual(sub(pgPart), 1186);
  assert.strictEqual(lines(hwPart).reduce((a, b) => a + b, 0), 4303);
  assert.strictEqual(lines(pgPart).reduce((a, b) => a + b, 0), 1186);
  assert.strictEqual(lines(pgPart).length, 2);
  assert.ok(!/\u00d7/.test(html), 'no qty x unit text in workbook mode');
  ok('proposal: lines add up to the workbook subtotals (4303 / 1186), no Rounding line');

  // Hourly: same rows keep the old output (rounded subtotals and a Rounding line)
  rsb.__tt = { compliance: { grand: 4720, phase1: 3700, phase2: 1020 }, recommended: null };
  const hh = ev("_rptA36TierDetailPanelHTML('compliance', __tt, __sd, {rowToggles:{}}, true, __fmt)");
  assert.ok(/\u00d7/.test(hh), 'Hourly keeps qty x unit lines');
  ok('proposal: Hourly panel keeps qty x unit lines');
}

// 3b. Phase split (workbook): Phase 2 = the programming labor priced alone (its labor + tools + OH + profit);
// Phase 1 = everything else. Phase 2 is the same with hardware on or off; grand total unchanged.
{
  const T = tiers();
  const c = make(read('app/pricing-estimator.js'), { en_pricing_catalog: catalog }, T);
  const seqH = 2 * 2.5 + 5 * 1.25;
  const own = EW.compute({ hours: { SE: seqH } }).summary.total;
  const on = c._pricingComputeTotals(T.recommended, est, 'p');
  assert.strictEqual(on.phase2, own, 'phase 2 == programming priced alone');
  assert.strictEqual(on.phase1 + on.phase2, on.grand);
  const off = c._pricingComputeTotals(
    T.recommended.filter((r) => r.phase === 2),
    est,
    'p',
  );
  assert.strictEqual(off.phase2, own);
  assert.strictEqual(off.phase1, 0);
  assert.strictEqual(off.grand, own);
  ok('workbook phase split: phase 2 = own programming cost (' + own + ') with hardware on or off');
}

// 4. Budget Fit in workbook mode: after-total <= target and equals the footer total of the kept rows.
{
  // Six buildings, each one sensor row paired with one supply-air-reset sequence row (one unit each).
  const U = [];
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((b, i) => {
    const h = hw('h' + b, 'Bldg ' + b, 1 + (i % 3), 30 + i * 11.5, 1.25, RATE);
    h._pointKey = 'sat';
    const q = sq('s' + b, 'Bldg ' + b, 1 + (i % 2), 1.5 + i * 0.5, RATE);
    q.seqKey = 'ahu_sat_reset';
    U.push(h, q);
  });
  const T = { compliance: U, recommended: U, 'full-scope': U };
  const store = { en_pricing_catalog: catalog };
  const c = make(read('app/pricing-estimator.js'), store, T);
  const full = c._pricingComputeTotals(T.recommended, { rowToggles: {}, manualPrices: {} }, 'p').grand;
  for (const frac of [0.9, 0.75, 0.5, 0.3]) {
    const target = Math.round(full * frac);
    store.en_pricing_budget_p = { mode: 'recurring', amount: target, denomination: 'lump', termMonths: 12 };
    store.en_pricing_estimate_p = { rowToggles: {}, manualPrices: {}, laborOverrides: {}, tier: 'recommended' };
    const plan = c._pricingComputeBudgetFitPlan('p');
    assert.ok(plan, 'plan');
    assert.ok(plan.afterTotal <= target, 'after ' + plan.afterTotal + ' <= ' + target);
    const tg = {};
    plan.excludeKeys.forEach((k) => (tg[k] = false));
    const footer = c._pricingComputeTotals(T.recommended, { rowToggles: tg, manualPrices: {} }, 'p');
    assert.strictEqual(plan.afterTotal, footer.grand === null ? 0 : footer.grand, 'after == footer');
    assert.strictEqual(plan.beforeTotal, full);
    assert.ok(plan.excludedCount > 0 && plan.excludedCount < plan.totalCount + 1, 'some rows dropped');
  }
  ok('budget fit (workbook): after-total <= target and equals the footer total');
}

// 9. Compare tab "Rec. Total" column: workbook mode foots to the recommended footer hardware subtotal;
// Hourly mode shows each matched row's own line total.
{
  const T = tiers();
  const rec = T.recommended.filter((r) => r.phase === 1);
  const e = { rowToggles: {}, manualPrices: {}, laborOverrides: {}, installHoursOverrides: {}, qtyOverrides: {} };
  const wbC = make(read('app/pricing-estimator.js'), { en_pricing_catalog: catalog }, T);
  const tot = wbC._pricingComputeTotals(T.recommended, e, 'p');
  assert.strictEqual(tot.method, 'workbook');
  const colSum = rec.reduce((sum, r) => sum + Math.round(wbC._pricingBothRecAmount(r, tot) * 100), 0);
  assert.strictEqual(colSum, Math.round(tot.phase1 * 100), 'workbook Rec. Total column == footer hardware');
  const hC = make(
    read('app/pricing-estimator.js'),
    { en_pricing_catalog: catalog, en_pricing_workbook_p: { method: 'hourly' } },
    T,
  );
  const ht = hC._pricingComputeTotals(T.recommended, e, 'p');
  rec.forEach((r) => assert.strictEqual(hC._pricingBothRecAmount(r, ht), r.lineTotal, 'hourly == lineTotal'));
  assert.strictEqual(hC._pricingBothRecAmount(null, ht), null);
  ok('Compare Rec. Total column: workbook foots to footer; hourly = line total');
}

// 10. One building split: in workbook mode a building shows the same amount in the row table (sum of its
// rows' shares), the Recommended timeline (phase amounts = sum of the building amounts in that phase) and
// Summary; phases add up to the tier total.
{
  const T = tiers();
  const e = { rowToggles: {}, manualPrices: {}, laborOverrides: {}, installHoursOverrides: {}, qtyOverrides: {} };
  const wb = make(read('app/pricing-estimator.js'), { en_pricing_catalog: catalog, en_pricing_estimate_p: e }, T);
  // fixed envelope per phase so the timeline spreads the rows over several phases
  wb._pricingComputeProgramCostModel = (p, k) => {
    const ph = [];
    for (let i = 0; i < k; i++)
      ph.push({ measuresAvailable: 150, allowanceTotal: 1150, emLaborTotal: 1000, overCommitted: false });
    return { phases: ph, programAllowanceTotal: 1, programEmLaborTotal: 1, monthlyAllowance: 1 };
  };
  const tot = wb._pricingComputeTotals(T.recommended, e, 'p');
  assert.strictEqual(tot.method, 'workbook');
  const key = (r) => r._baseId || r.id;
  const rowB = {};
  T.recommended.forEach((r) => (rowB[r.building] = (rowB[r.building] || 0) + (tot.rowShares[key(r)] || 0)));
  const tl = wb._pricingComputeRecommendedTimeline('p');
  assert.ok(tl && tl.phases.length >= 2, 'timeline has several phases');
  const tlB = {};
  let phaseSum = 0;
  tl.phases.forEach((p) => {
    const perB = {};
    p.rows.forEach((r) => (perB[r.building] = (perB[r.building] || 0) + (tot.rowShares[key(r)] || 0)));
    assert.strictEqual(
      p.measuresTotal,
      Object.keys(perB).reduce((a, b) => a + perB[b], 0),
      'phase amount == sum of its building amounts',
    );
    Object.keys(perB).forEach((b) => (tlB[b] = (tlB[b] || 0) + perB[b]));
    phaseSum += p.measuresTotal;
  });
  assert.strictEqual(phaseSum, tot.grand, 'phases sum to tier total');
  const sd = wb._pricingComputeSummaryData('p', e);
  sd.buildings.forEach((b) => {
    assert.strictEqual(b.tiers.recommended.total, rowB[b.building] || 0, 'summary == row table ' + b.building);
    if (rowB[b.building]) assert.strictEqual(tlB[b.building], rowB[b.building], 'timeline == row table ' + b.building);
  });
  assert.strictEqual(sd.buildings.reduce((a, b) => a + b.tiers.recommended.total, 0), tot.grand);
  ok('workbook: building amount equal in row table, timeline and Summary; phases sum to ' + tot.grand);
}

// 10. Building filter (workbook): the filtered amounts are the sum of the chosen buildings' shares from the
// full estimate - equal to those buildings' amounts in Summary and the timeline, for ANY subset of
// buildings. Hourly: filtered totals deep-equal the main-branch compute on the same subset.
{
  const mainPE = cp.execFileSync('git', ['show', '12a6614:app/pricing-estimator.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const plain = (x) => JSON.parse(JSON.stringify(x));
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const BL = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const key = (r) => r._baseId || r.id;
  let subsets = 0;
  for (let it = 0; it < 60; it++) {
    const rows = [];
    const cnt = 4 + Math.floor(rnd() * 8);
    for (let i = 0; i < cnt; i++) {
      const b = BL[Math.floor(rnd() * BL.length)];
      rows.push(hw('x' + i, b, 1 + Math.floor(rnd() * 9), +(rnd() * 200 + 0.37).toFixed(2), [0.25, 0.5, 1, 1.5][i % 4], RATE));
      rows.push(sq('y' + i, b, 1 + Math.floor(rnd() * 4), [0.5, 1.25, 2.5, 3.4][i % 4], RATE));
    }
    const T = { compliance: rows, recommended: rows, 'full-scope': rows };
    const cat = {};
    rows.forEach((r) => r.sku && (cat[r.sku] = { list: 1 }));
    const e = { rowToggles: {}, manualPrices: {}, laborOverrides: {}, installHoursOverrides: {}, qtyOverrides: {} };
    rows.forEach((r) => rnd() < 0.1 && (e.rowToggles[r.id] = false));
    const store = () => ({ en_pricing_catalog: cat, en_pricing_estimate_p: e });
    const wb = make(read('app/pricing-estimator.js'), store(), T);
    wb._pricingComputeProgramCostModel = (p, k) => ({
      phases: Array.from({ length: k }, () => ({ measuresAvailable: 150, allowanceTotal: 1150, emLaborTotal: 1000, overCommitted: false })),
      programAllowanceTotal: 1,
      programEmLaborTotal: 1,
      monthlyAllowance: 1,
    });
    const hr = make(read('app/pricing-estimator.js'), Object.assign(store(), { en_pricing_workbook_p: { method: 'hourly' } }), T);
    const mn = make(mainPE, Object.assign(store(), { en_pricing_workbook_p: { method: 'hourly' } }), T);
    const tot = wb._pricingComputeTotals(rows, e, 'p');
    if (tot.grand === null) continue;
    const sd = wb._pricingComputeSummaryData('p', e);
    const tl = wb._pricingComputeRecommendedTimeline('p');
    const tlB = {};
    if (tl)
      tl.phases.forEach((p) =>
        p.rows.forEach((r) => (tlB[r.building] = (tlB[r.building] || 0) + (tot.rowShares[key(r)] || 0))),
      );
    const names = BL.filter((b) => rows.some((r) => r.building === b));
    for (let mask = 1; mask < 1 << names.length; mask++) {
      const pickB = names.filter((_, i) => mask & (1 << i));
      const sub = rows.filter((r) => pickB.indexOf(r.building) >= 0);
      subsets++;
      const f = wb._pricingComputeFilteredTotals(rows, sub, e, 'p');
      const sumSummary = sd.buildings
        .filter((b) => pickB.indexOf(b.building) >= 0)
        .reduce((a, b) => a + Math.round(b.tiers.recommended.total * 100), 0);
      // No `_all` cache (condensed tab path): totals built on demand equal the cached-path/footer total.
      const fNoAll = wb._pricingComputeFilteredTotals(null, sub, e, 'p');
      assert.strictEqual(fNoAll.grand, f.grand, 'condensed (no _all) == footer filtered total ' + pickB);
      assert.deepStrictEqual(plain(fNoAll.rowShares), plain(f.rowShares), 'no-_all rowShares == footer ' + pickB);
      if (f.grand !== null) {
        assert.strictEqual(Math.round(fNoAll.grand * 100), sumSummary, 'no-_all total == Summary sum ' + pickB);
        assert.strictEqual(Math.round(f.grand * 100), sumSummary, 'filtered total == Summary sum ' + pickB);
        assert.strictEqual(Math.round((f.phase1 + f.phase2) * 100), Math.round(f.grand * 100), 'phases foot');
        const sumRows = Object.keys(f.rowShares).reduce((a, k) => a + Math.round(f.rowShares[k] * 100), 0);
        assert.strictEqual(sumRows, Math.round(f.grand * 100), 'filtered rowShares foot');
        if (tl) {
          const sumTl = pickB.reduce((a, b) => a + Math.round((tlB[b] || 0) * 100), 0);
          assert.strictEqual(Math.round(f.grand * 100), sumTl, 'filtered total == timeline sum ' + pickB);
        }
        sub.forEach((r) => {
          if (!r.ioOnly && f.rowShares[key(r)] != null)
            assert.strictEqual(f.rowShares[key(r)], tot.rowShares[key(r)], 'row share unchanged by filter');
        });
      }
      assert.deepStrictEqual(
        plain(hr._pricingComputeFilteredTotals(rows, sub, e, 'p')),
        plain(mn._pricingComputeTotals(sub, e, 'p')),
        'hourly filtered == main ' + pickB,
      );
    }
    // no filter: identical to the plain compute
    assert.deepStrictEqual(plain(wb._pricingComputeFilteredTotals(rows, rows, e, 'p')), plain(tot));
  }
  assert.ok(subsets > 200, 'enough subsets ran: ' + subsets);
  ok('building filter (workbook): any subset == sum of those buildings in Summary/timeline; Hourly == main (' + subsets + ' subsets)');
}

console.log('\n' + n + ' checks passed');
