// WP5 test: company settings, hour overrides and part price overrides in workbook mode - SYNTHETIC data only.
// Run: NODE_PATH=<dir with exceljs> node tools/test-workbook-overrides.js   (exit 0 = all pass)
// "Live" = git e6d7a6c (v2026.10.01.63): with nothing stored, new code must price exactly as live code.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert'),
  cp = require('child_process');
const ExcelJS = require('exceljs'); // eslint-disable-line no-unused-vars
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EW = require(path.join(ROOT, 'app/estimate-workbook.js'));
const X = require(path.join(ROOT, 'app/estimate-workbook-export.js'));
const live = (rel) =>
  cp.execFileSync('git', ['show', 'e6d7a6c:' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
// 'settings' is the settings snapshot; WP5 adds fields to it, so it is left out when comparing with live.
const plain = (x) => JSON.parse(JSON.stringify(x), (k, v) => (k === 'settings' || k === 'types' || k === 'site' ? undefined : v));
const cents = (x) => Math.round(x * 100);
const round0 = (x) => Math.floor(Math.abs(x) + 0.5) * Math.sign(x);
let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};

function makeSandbox(store, srcs, extra) {
  const el = () => ({
    style: {},
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    classList: { add() {}, remove() {} },
    innerHTML: '',
  });
  const sb = Object.assign(
    {
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
        sb.__writes.push(k);
        store[k] = JSON.parse(JSON.stringify(v));
      },
      __writes: [],
      showToast() {},
      setTimeout,
      clearTimeout,
      localStorage: { getItem: () => null, setItem() {} },
      navigator: {},
    },
    extra || {},
  );
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  srcs.forEach((s) => vm.runInContext(s, sb));
  return sb;
}

/* ───────────── Audit Estimate ───────────── */
function auditFixture() {
  const rows = [];
  const add = (b, cat, k, pts) => {
    for (let i = 0; i < k; i++) rows.push({ building: b, category: cat, points: { a: 1 }, pts: pts || {} });
  };
  add('Alpha Hall', 'vav', 23);
  add('Beta Annex', 'vav', 9, { reheatValve: 1 });
  add('Gamma', 'ahu', 2);
  add('Beta Annex', 'rtu', 7);
  return rows;
}
function auditBox(store, srcs) {
  return makeSandbox(store, srcs || [read('app/estimate-workbook.js'), read('app/audit-estimate.js')], {
    emLoadMatrix: () => ({ rows: auditFixture() }),
    emIsPhantomRow: () => false,
    emGetNormalizedPoints: (r) => r.pts || {},
    _pricingGetConfig: () => ({ hourlyRate: 170 }),
  });
}

(async () => {
  // A1. nothing stored: new code == live code; nothing written by load, compute or render
  for (const t of ['bas', 'full']) {
    const store = {};
    const nw = auditBox(store);
    const lv = auditBox({}, [read('app/estimate-workbook.js'), live('app/audit-estimate.js')]);
    const b = nw.auditEstComputeBreakdown('p', t);
    const o = lv.auditEstComputeBreakdown('p', t);
    ['totalCost', 'totalHours', 'proposalPrice', 'buildingLineCost', 'reportCost', 'method'].forEach((k) =>
      assert.deepStrictEqual(b[k], o[k], k + ' ' + t),
    );
    assert.deepStrictEqual(plain(b.byBuilding), plain(o.byBuilding));
    assert.deepStrictEqual(plain(b.workbook.chain), plain(o.workbook.chain));
    assert.deepStrictEqual(plain(b.workbook.input), plain(o.workbook.input));
    nw.auditEstCompanySettingsHTML('p');
    nw.auditEstWorkbookPanelHTML('p', b.workbook, 'Labor by task');
    assert.strictEqual(nw.__writes.length, 0, 'no write on load/render');
    assert.deepStrictEqual(Object.keys(store), []);
  }
  ok('audit: nothing stored -> same as live v.63 (total, chain, input); no key written on load or render');

  // A2. company base rate and percentage change follow the workbook formula; footer == proposal == export
  {
    const store = {};
    const c = auditBox(store);
    const base = c.auditEstComputeBreakdown('p', 'bas');
    assert.strictEqual(c.auditEstSetWorkbookConfig('rate', { code: 'PE', value: 130 }), 'ok');
    assert.strictEqual(c.auditEstSetWorkbookConfig('pct', { key: 'overhead', value: 0.12 }), 'ok');
    assert.strictEqual(c.auditEstSetWorkbookConfig('pct', { key: 'profit', value: 0.25 }), 'ok');
    assert.deepStrictEqual(Object.keys(store), ['en_pricing_workbook_config']);
    assert.deepStrictEqual(plain(store.en_pricing_workbook_config.baseRates), { PE: 130 });
    assert.deepStrictEqual(plain(store.en_pricing_workbook_config.pct), { overhead: 0.12, profit: 0.25 });
    const b = c.auditEstComputeBreakdown('p', 'bas');
    const h = b.totalHours;
    // workbook formula by hand: PE rate = base + burdens (module rate table), labor = ROUND(hours x rate),
    // tools = ROUND(labor x 1.5%), direct = labor + tools, overhead = ROUND(direct x 12%),
    // profit = ROUND((direct + overhead) x 25%), total = direct + overhead + profit.
    const P = EW.rateTable({ PE: 130 }).find((r) => r.code === 'PE').P;
    const labor = round0(h * P),
      tools = round0(labor * 0.015),
      direct = labor + tools,
      oh = round0(direct * 0.12),
      pr = round0((direct + oh) * 0.25);
    const ch = Object.fromEntries(b.workbook.chain.map((x) => [x.key, x.amount]));
    assert.deepStrictEqual(
      [ch.labor, ch.tools, ch.direct, ch.overhead, ch.profit, ch.total],
      [labor, tools, direct, oh, pr, direct + oh + pr],
    );
    assert.strictEqual(b.totalCost, direct + oh + pr);
    assert.notStrictEqual(b.totalCost, base.totalCost);
    assert.ok(/Overhead \(12%\)/.test(b.workbook.chain.find((x) => x.key === 'overhead').label), 'label shows 12%');
    // footer (totalCost) == proposal == export
    assert.strictEqual(b.proposalPrice, b.totalCost);
    const buf = await X.exportWorkbook(b.workbook.input, { project: 'Sample', date: '2026-10-01' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.strictEqual(wb.getWorksheet('Dash').getCell('N36').value.result, b.totalCost, 'export N36');
    assert.strictEqual(wb.getWorksheet('Dash').getCell('M27').value, 0.12);
    assert.strictEqual(wb.getWorksheet('Dash').getCell('M28').value, 0.25);
    const lr = wb.getWorksheet('Labor Rates');
    const peRow = EW.DEFAULTS.roles.find((r) => r.code === 'PE').rRow;
    assert.strictEqual(lr.getCell('D' + peRow).value, 130);
    assert.deepStrictEqual(plain(EW.compute(b.workbook.input).summary.total), b.totalCost);
    ok('audit: company rate/percent change follows the formula (' + b.totalCost + '); footer == proposal == export');

    // history: who / when / field / old -> new
    const hist = c.auditEstGetWorkbookConfig().history;
    assert.strictEqual(hist.length, 3);
    assert.deepStrictEqual(
      hist.map((x) => [x.field, x.from, x.to]),
      [
        ['Base rate PE', EW.DEFAULTS.roles.find((r) => r.code === 'PE').base, 130],
        ['Overhead', 0.1, 0.12],
        ['Profit', 0.3, 0.25],
      ],
    );
    assert.ok(
      hist.every((x) => !('who' in x) && !isNaN(Date.parse(x.t))),
      'no identity -> no who',
    );
    c.currentUser = { name: 'Sample User' };
    c.auditEstSetWorkbookConfig('pct', { key: 'freight', value: 0.07 });
    assert.strictEqual(c.auditEstGetWorkbookConfig().history[3].who, 'Sample User');
    const html = c.auditEstCompanySettingsHTML('p');
    assert.ok(/Sample User/.test(html) && /Freight on parts/.test(html) && /5% &rarr; 7%|5% &rarr; 7%/.test(html));
    assert.ok(/title="[^"]*Added to the parts cost/.test(html), 'hover text explains the percent');
    assert.ok(html.indexOf('Freight on parts</td><td class="ch-tbl-col-type-number"><span class="ae-ov"><input') > 0);
    ok('history: who/when/field/old->new recorded; shown newest first with hover text');

    // reset per field -> exactly the live values; stored fields removed
    c.auditEstSetWorkbookConfig('pct', { key: 'freight', value: '' });
    c.auditEstSetWorkbookConfig('pct', { key: 'overhead', value: '' });
    c.auditEstSetWorkbookConfig('pct', { key: 'profit', value: '' });
    c.auditEstSetWorkbookConfig('rate', { code: 'PE', value: '' });
    const cfg = store.en_pricing_workbook_config;
    assert.ok(!('baseRates' in cfg) && !('pct' in cfg), 'reset removes the stored fields');
    const again = c.auditEstComputeBreakdown('p', 'bas');
    assert.deepStrictEqual(plain(again.workbook.chain), plain(base.workbook.chain));
    assert.strictEqual(again.totalCost, base.totalCost);
    assert.deepStrictEqual(plain(again.workbook.input), plain(base.workbook.input));
    ok('company reset per field -> back to live values exactly, stored fields removed');
  }

  // A3. default role per task type (company), project role beats company role
  {
    const store = {};
    const c = auditBox(store);
    const base = c.auditEstComputeBreakdown('p', 'bas');
    c.auditEstSetWorkbookConfig('role', { task: 'audit_report', role: 'SE' });
    let b = c.auditEstComputeBreakdown('p', 'bas');
    assert.ok(b.workbook.tasks.find((t) => t.id === 'audit_report').role === 'SE');
    assert.ok(b.workbook.roleHours.SE > 0);
    assert.ok(b.totalCost !== base.totalCost);
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'PE' }), 'ok');
    assert.strictEqual(store.en_pricing_workbook_p.roles.audit_report, 'PE', 'explicit project role kept');
    b = c.auditEstComputeBreakdown('p', 'bas');
    assert.strictEqual(b.totalCost, base.totalCost);
    ok('company default role changes the roles; a project role chosen on purpose wins');
  }

  // A4. hour override: typed hours -> compute -> footer == proposal == export; reset -> live values
  {
    const store = {};
    const c = auditBox(store);
    const base = c.auditEstComputeBreakdown('p', 'full');
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'hours', { task: 'audit_report', hours: 10 }), 'ok');
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'hours', { task: 'audit_report', hours: -1 }), 'invalid');
    assert.deepStrictEqual(plain(store.en_pricing_workbook_p), { hours: { audit_report: 10 } });
    const b = c.auditEstComputeBreakdown('p', 'full');
    const t = b.workbook.tasks.find((x) => x.id === 'audit_report');
    assert.strictEqual(t.hours, 10);
    assert.strictEqual(t.overridden, true);
    assert.strictEqual(t.computedHours, base.workbook.tasks.find((x) => x.id === 'audit_report').hours);
    const hrs = b.workbook.tasks.reduce((s, x) => s + cents(x.hours), 0) / 100;
    assert.strictEqual(b.totalHours, hrs);
    const ref = EW.compute({ hours: { PE: hrs }, ot: 'Not Applicable', state: 'Kansas', taxRate: 0, bond: false });
    assert.strictEqual(b.totalCost, ref.summary.total);
    assert.strictEqual(b.proposalPrice, b.totalCost);
    assert.strictEqual(
      b.byBuilding.reduce((s, x) => s + x.cost, 0),
      b.totalCost,
      'building shares add up',
    );
    const lines =
      b.rows.reduce((s, r) => s + r.cost, 0) +
      b.buildingLineCost +
      b.reportCost +
      b.extras.reduce((s, x) => s + x.cost, 0);
    assert.strictEqual(lines, b.totalCost, 'line shares add up');
    const buf = await X.exportWorkbook(b.workbook.input, { project: 'Sample', date: '2026-10-01' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.strictEqual(wb.getWorksheet('Dash').getCell('N36').value.result, b.totalCost);
    const html = c.auditEstWorkbookPanelHTML('p', b.workbook, 'Labor by task');
    assert.ok(/ae-ov-in on"[^>]*auditEstSaveWorkbookHours\('p','audit_report'/.test(html), 'typed marker');
    assert.ok(/Reset to the computed hours/.test(html), 'reset button');
    c.auditEstSetWorkbookSetting('p', 'hours', { task: 'audit_report', hours: '' });
    const again = c.auditEstComputeBreakdown('p', 'full');
    assert.deepStrictEqual(plain(again.workbook.input), plain(base.workbook.input));
    assert.strictEqual(again.totalCost, base.totalCost);
    assert.strictEqual(again.totalHours, base.totalHours);
    ok(
      'audit: typed hours (' + b.totalHours + ' h) -> ' + b.totalCost + ' == proposal == export; reset -> live values',
    );
  }

  /* ───────────── Cost Estimate ───────────── */
  const RATE = 170;
  const hw = (id, b, qty, part, instH) => {
    const inst = +(instH * qty * RATE).toFixed(2);
    return {
      id,
      building: b,
      phase: 1,
      qty,
      sku: 'S-' + id,
      ioOnly: false,
      noSku: false,
      engReview: false,
      partsUnitPrice: part,
      partsLineTotal: +(part * qty).toFixed(2),
      contractPrice: part,
      installHours: instH,
      installLaborRate: RATE,
      installLaborTotal: inst,
      lineTotal: +(part * qty + inst).toFixed(2),
    };
  };
  const sq = (id, b, qty, hrs) => ({
    id,
    building: b,
    phase: 2,
    qty,
    seqKey: 'k' + id,
    hrsPerUnit: hrs,
    ioOnly: false,
    noSku: false,
    engReview: false,
    lineTotal: +(qty * hrs * RATE).toFixed(2),
  });
  const manualRow = {
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
  const A = [
    hw('h1', 'Alpha', 3, 41.37, 1.5),
    hw('h2', 'Beta', 7, 12.99, 0.75),
    sq('s1', 'Alpha', 2, 2.5),
    sq('s2', 'Beta', 5, 1.25),
    manualRow,
  ];
  const T = {
    compliance: A.slice(0, 3),
    recommended: A,
    'full-scope': A.concat([hw('h3', 'Gamma', 11, 88.2, 2), sq('s4', 'Gamma', 4, 2)]),
  };
  const catalog = { 'S-h1': { list: 1 }, 'S-h2': { list: 1 }, 'S-h3': { list: 1 } };
  const est = {
    rowToggles: {},
    manualPrices: { m1: '55.5' },
    laborOverrides: {},
    installHoursOverrides: {},
    qtyOverrides: {},
    noteOverrides: {},
    tier: 'compliance',
  };
  function ceBox(store, pe, au) {
    const sb = makeSandbox(store, [
      pe || read('app/pricing-estimator.js'),
      read('app/estimate-workbook.js'),
      au || read('app/audit-estimate.js'),
    ]);
    sb.buildComplianceRows = () => T.compliance;
    sb.buildRecommendedRows = () => T.recommended;
    sb.buildFullScopeRows = () => T['full-scope'];
    sb._pricingApplyLaborOverrides = (p, r) => r;
    sb._pricingApplyQtyOverrides = (p, r) => r;
    sb._pricingGetEstimate = () => est;
    return sb;
  }

  // The phase split (Phase 2 = programming alone, Phase 1 = rest) deliberately differs from live v.63; compare everything else (per-building hw/lb/total shares follow the split too).
  const nonPhase = (t, shares) =>
    JSON.parse(JSON.stringify(t, (k, v) => (k === 'phase1' || k === 'phase2' || k === 'rowShares' || (shares && (k === 'hw' || k === 'lb' || k === 'total')) ? undefined : v)));
  // C1. nothing stored: totals, summary data, export sets identical to live v.63; nothing written
  {
    const store = { en_pricing_catalog: catalog };
    const nw = ceBox(store);
    const lv = ceBox({ en_pricing_catalog: catalog }, live('app/pricing-estimator.js'), live('app/audit-estimate.js'));
    for (const k of Object.keys(T))
      assert.deepStrictEqual(
        nonPhase(plain(nw._pricingComputeTotals(T[k], est, 'p'))),
        nonPhase(plain(lv._pricingComputeTotals(T[k], est, 'p'))),
        k,
      );
    assert.deepStrictEqual(
      nonPhase(plain(nw._pricingComputeSummaryData('p', est)), true),
      nonPhase(plain(lv._pricingComputeSummaryData('p', est)), true),
    );
    assert.deepStrictEqual(plain(nw._pricingExportSets('p')), plain(lv._pricingExportSets('p')));
    nw.auditEstCompanySettingsHTML('p');
    assert.deepStrictEqual(nw.__writes, [], 'no write on load');
    ok('cost estimate: nothing stored -> totals, summary data and export sets equal live v.63; no key written');
  }

  // C2. company settings flow to footer == proposal == export == building shares
  {
    const store = { en_pricing_catalog: catalog };
    const c = ceBox(store);
    const base = {};
    for (const k of Object.keys(T)) base[k] = plain(c._pricingComputeTotals(T[k], est, 'p'));
    c.auditEstSetWorkbookConfig('rate', { code: 'EI', value: 70 });
    c.auditEstSetWorkbookConfig('rate', { code: 'DE', value: 150 });
    c.auditEstSetWorkbookConfig('pct', { key: 'smallTools', value: 0.02 });
    c.auditEstSetWorkbookConfig('state', 'Missouri');
    c.auditEstSetWorkbookConfig('taxRate', 0.08);
    const r = c._pricingComputeTotals(T.recommended, est, 'p');
    const parts = Math.round((3 * 41.37 + 7 * 12.99 + 55.5 * 2) * 100) / 100;
    const instH = 3 * 1.5 + 7 * 0.75 + 2;
    const exp = EW.compute({
      hours: { EI: instH, SE: 2 * 2.5 + 5 * 1.25 },
      baseRates: { EI: 70, DE: 150 },
      pct: { smallTools: 0.02 },
      state: 'Missouri',
      taxRate: 0.08,
      parts: [{ qty: 1, unit: parts }],
    });
    assert.strictEqual(r.grand, exp.summary.total);
    assert.notStrictEqual(r.grand, base.recommended.grand);
    assert.ok(/Small tools|Tools \(2%/.test(r.workbook.chain.map((x) => x.label).join('|')), 'chain label 2%');
    assert.strictEqual(r.phase1 + r.phase2, r.grand);
    const sets = c._pricingExportSets('p');
    sets.forEach((s) => {
      const key = { Compliance: 'compliance', Recommended: 'recommended', 'Full Scope': 'full-scope' }[s.name];
      assert.strictEqual(s.grand, c._pricingComputeTotals(T[key], est, 'p').grand, 'export set == footer ' + s.name);
      assert.strictEqual(EW.compute(s.input).summary.total, s.grand);
      assert.deepStrictEqual(plain(s.input.baseRates), { EI: 70, DE: 150 });
    });
    const sd = c._pricingComputeSummaryData('p', est);
    for (const k of Object.keys(T)) {
      assert.strictEqual(
        sd.buildings.reduce((s, b) => s + b.tiers[k].total, 0),
        sd.tierTotals[k].grand,
        'building shares ' + k,
      );
    }
    // proposal prints the same number (workbook mode: no round-up)
    const rsb = vm.createContext({ console, Math });
    const fnSrc = (src, name) => {
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
    };
    vm.runInContext(
      fnSrc(read('app/report-engine.js'), '_rptTierTotal') + fnSrc(read('app/report-engine.js'), '_rptRoundUp100'),
      rsb,
    );
    rsb.__t = plain(r);
    assert.strictEqual(vm.runInContext('_rptTierTotal(__t)', rsb), r.grand, 'proposal == footer');
    // export file cached total == footer
    const buf = await X.exportSetsBlob(sets, {
      customer: 'Sample',
      project: 'Sample',
      title: 'Cost Estimate',
      date: '2026-10-01',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    for (const s of sets) assert.strictEqual(wb.getWorksheet(s.name + ' Dash').getCell('N36').value.result, s.grand);
    ok('cost estimate: company rates/percent/tax -> footer == proposal == export == building shares (' + r.grand + ')');

    ['EI', 'DE'].forEach((code) => c.auditEstSetWorkbookConfig('rate', { code, value: '' }));
    c.auditEstSetWorkbookConfig('pct', { key: 'smallTools', value: '' });
    c.auditEstSetWorkbookConfig('state', '');
    c.auditEstSetWorkbookConfig('taxRate', '');
    for (const k of Object.keys(T))
      assert.deepStrictEqual(plain(c._pricingComputeTotals(T[k], est, 'p')), base[k], 'reset ' + k);
    const cfg = store.en_pricing_workbook_config;
    assert.deepStrictEqual(Object.keys(cfg), ['history']);
    ok('company reset -> every tier total exactly as live; only the history stays stored');
  }

  // C3. part price override: typed wins over manual and catalog; marker + reset; foots everywhere
  {
    const store = { en_pricing_catalog: catalog };
    const c = ceBox(store);
    const base = {};
    for (const k of Object.keys(T)) base[k] = plain(c._pricingComputeTotals(T[k], est, 'p'));
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'partPrice', { row: 'h1', price: 50 }), 'ok');
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'partPrice', { row: 'm1', price: 60 }), 'ok');
    assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'partPrice', { row: 'h2', price: 0 }), 'invalid');
    assert.deepStrictEqual(plain(store.en_pricing_workbook_p), { partPrices: { h1: 50, m1: 60 } });
    const r = c._pricingComputeTotals(T.recommended, est, 'p');
    const parts = Math.round((3 * 50 + 7 * 12.99 + 60 * 2) * 100) / 100; // typed 50 over catalog, typed 60 over manual 55.5
    const exp = EW.compute({
      hours: { EI: 3 * 1.5 + 7 * 0.75 + 2, SE: 2 * 2.5 + 5 * 1.25 },
      parts: [{ qty: 1, unit: parts }],
    });
    assert.strictEqual(r.grand, exp.summary.total);
    assert.strictEqual(r.phase1 + r.phase2, r.grand);
    assert.strictEqual(
      Object.values(r.rowShares).reduce((a, b) => a + b, 0),
      r.grand,
      'row shares add up',
    );
    const sets = c._pricingExportSets('p');
    assert.strictEqual(sets[1].grand, r.grand);
    assert.strictEqual(sets[1].input.parts[0].unit, parts);
    const sd = c._pricingComputeSummaryData('p', est);
    assert.strictEqual(
      sd.buildings.reduce((s, b) => s + b.tiers.recommended.total, 0),
      r.grand,
    );
    // compliance tier = h1, h2, s1 (no manual row): typed 50 applies there too
    const comp = c._pricingComputeTotals(T.compliance, est, 'p');
    assert.strictEqual(
      comp.grand,
      EW.compute({ hours: { EI: 3 * 1.5 + 7 * 0.75, SE: 5 }, parts: [{ qty: 1, unit: Math.round((150 + 7 * 12.99) * 100) / 100 }] }).summary.total,
    );
    // cell: marker only when typed
    const typedHtml = c._pricingPartPriceCellHTML('p', 'h1', T.recommended[0], 50);
    const plainHtml = c._pricingPartPriceCellHTML('p', 'h2', T.recommended[1], undefined);
    assert.ok(/var\(--accent\)/.test(typedHtml) && /Reset to the catalog price/.test(typedHtml));
    assert.ok(!/var\(--accent\)/.test(plainHtml) && !/Reset/.test(plainHtml) && /value="12.99"/.test(plainHtml));
    // reset returns exactly to live values
    c.auditEstSetWorkbookSetting('p', 'partPrice', { row: 'h1', price: '' });
    c.auditEstSetWorkbookSetting('p', 'partPrice', { row: 'm1', price: '' });
    for (const k of Object.keys(T))
      assert.deepStrictEqual(plain(c._pricingComputeTotals(T[k], est, 'p')), base[k], 'reset ' + k);
    ok(
      'part price: typed 50/60 beat catalog/manual -> ' +
        r.grand +
        ' == compute() == export == shares; reset -> live values',
    );
  }

  // C4. Hourly mode ignores every override and equals live Hourly
  {
    const store = {
      en_pricing_catalog: catalog,
      en_pricing_workbook_p: { method: 'hourly', partPrices: { h1: 50 } },
      en_pricing_workbook_config: { baseRates: { PE: 200 }, pct: { overhead: 0.2 } },
    };
    const nw = ceBox(store);
    const lv = ceBox(
      { en_pricing_catalog: catalog, en_pricing_workbook_p: { method: 'hourly' } },
      live('app/pricing-estimator.js'),
      live('app/audit-estimate.js'),
    );
    for (const k of Object.keys(T))
      assert.deepStrictEqual(
        nonPhase(plain(nw._pricingComputeTotals(T[k], est, 'p'))),
        nonPhase(plain(lv._pricingComputeTotals(T[k], est, 'p'))),
        k,
      );
    const a1 = auditBox({
      en_pricing_workbook_p: { method: 'hourly', hours: { audit_report: 3 } },
      en_pricing_workbook_config: { pct: { overhead: 0.2 } },
    });
    const a2 = auditBox({ en_pricing_workbook_p: { method: 'hourly' } }, [
      read('app/estimate-workbook.js'),
      live('app/audit-estimate.js'),
    ]);
    for (const t of ['bas', 'full']) {
      const x = a1.auditEstComputeBreakdown('p', t),
        y = a2.auditEstComputeBreakdown('p', t);
      assert.strictEqual(x.totalCost, y.totalCost);
      assert.strictEqual(x.proposalPrice, y.proposalPrice);
      assert.strictEqual(x.totalHours, y.totalHours);
    }
    ok('Hourly mode: company settings and typed values change nothing (cost estimate and audit == live)');
  }

  // C5. validation: bad company values are refused and write nothing
  {
    const store = {};
    const c = auditBox(store);
    assert.strictEqual(c.auditEstSetWorkbookConfig('rate', { code: 'PE', value: -5 }), 'invalid');
    assert.strictEqual(c.auditEstSetWorkbookConfig('rate', { code: 'XX', value: 5 }), 'invalid');
    ['SE', 'CO', 'TR'].forEach((code) => assert.strictEqual(c.auditEstSetWorkbookConfig('rate', { code, value: 90 }), 'invalid')); // tied to another role
    assert.strictEqual(c.auditEstSetWorkbookConfig('pct', { key: 'profit', value: 2 }), 'invalid');
    assert.strictEqual(c.auditEstSetWorkbookConfig('state', 'Texas'), 'invalid');
    assert.strictEqual(c.auditEstSetWorkbookConfig('role', { task: 'audit_report', role: 'ZZ' }), 'invalid');
    assert.strictEqual(c.auditEstSetWorkbookConfig('pct', { key: 'profit', value: 0.3 }), 'ok'); // same as default
    assert.deepStrictEqual(c.__writes, []);
    ok('invalid values refused; setting a value equal to the default writes nothing');
  }

  console.log('\nAll ' + n + ' checks passed');
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
