// WP6 test: Cost Estimate Excel export, one sheet set per tier - SYNTHETIC data only.
// Run: NODE_PATH=<dir with exceljs> node tools/test-cost-estimate-export.js   (exit 0 = all pass)
// WP6_OUT=<file.xlsx> also saves the exported sample.
const vm = require('vm'),
  fs = require('fs'),
  path = require('path'),
  assert = require('assert'),
  crypto = require('crypto');
const ExcelJS = require('exceljs');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EW = require(path.join(ROOT, 'app/estimate-workbook.js'));
const X = require(path.join(ROOT, 'app/estimate-workbook-export.js'));
const TEMPLATE = path.join(ROOT, 'app/assets/estimate-template.xlsx');
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(TEMPLATE)).digest('hex');
const OUT = process.env.WP6_OUT || null;
const SHEET_RE = /(Info|Proposal|Dash|Mat & Equip|Labor Rates|CSC Parts Quote|NS)$/;

let n = 0;
const ok = (m) => {
  n++;
  console.log('PASS ' + m);
};

function make(store, tiers) {
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
  vm.runInContext(read('app/pricing-estimator.js'), sb);
  vm.runInContext(read('app/estimate-workbook.js'), sb);
  vm.runInContext(read('app/audit-estimate.js'), sb);
  sb.buildComplianceRows = () => tiers.compliance;
  sb.buildRecommendedRows = () => tiers.recommended;
  sb.buildFullScopeRows = () => tiers['full-scope'];
  sb._pricingApplyLaborOverrides = (p, r) => r;
  sb._pricingApplyQtyOverrides = (p, r) => r;
  return sb;
}
const RATE = 170;
function hw(id, b, qty, part, instH) {
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
    partsLineTotal: +(part * qty).toFixed(2),
    installHours: instH,
    installLaborRate: RATE,
    installLaborTotal: inst,
    lineTotal: +(part * qty + inst).toFixed(2),
  };
}
function sq(id, b, qty, hrs) {
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
    lineTotal: +(qty * hrs * RATE).toFixed(2),
  };
}
// a typed-price row: NO-SKU, price typed on the page (manualPrices)
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
const a = [
  hw('h1', 'Alpha', 3, 41.37, 1.5),
  hw('h2', 'Beta', 7, 12.99, 0.75),
  sq('s1', 'Alpha', 2, 2.5),
  sq('s2', 'Beta', 5, 1.25),
  manualRow,
];
const b = a.concat([hw('h3', 'Gamma', 11, 88.2, 2), sq('s4', 'Gamma', 4, 2)]);
const T = { compliance: a.slice(0, 3), recommended: a, 'full-scope': b };
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
const store = {
  en_pricing_catalog: catalog,
  en_pricing_workbook_p: {
    roles: { install_per_point: 'SC' },
    ot: 'x1.5',
    state: 'Missouri',
    taxRate: 0.0875,
    bond: true,
  },
};
const sb = make(store, T);
sb._pricingGetEstimate = () => est;

(async () => {
  const before = sha();

  // 1. sets come from the page's own pricing; totals == page footer total
  const sets = sb._pricingExportSets('p');
  assert.strictEqual(sets.length, 3);
  assert.strictEqual(sets.map((s) => s.name).join('|'), 'Compliance|Recommended|Full Scope');
  const footer = {};
  for (const k of Object.keys(T)) footer[k] = sb._pricingComputeTotals(T[k], est, 'p').grand;
  const keyOf = { Compliance: 'compliance', Recommended: 'recommended', 'Full Scope': 'full-scope' };
  sets.forEach((s) => {
    assert.strictEqual(s.grand, footer[keyOf[s.name]], 'set grand == footer ' + s.name);
    assert.strictEqual(EW.compute(s.input).summary.total, s.grand, 'compute() == footer ' + s.name);
  });
  assert.ok(new Set(sets.map((s) => s.grand)).size === 3, 'tiers differ');
  ok('3 tier sets: compute() == page footer total (' + sets.map((s) => s.grand).join(', ') + ')');

  // typed price wins: manual row parts = 55.5 x 2 in the Recommended parts line
  const rec = sets[1].input;
  const partsExp = Math.round((3 * 41.37 + 7 * 12.99 + 55.5 * 2) * 100) / 100;
  assert.strictEqual(rec.parts[0].unit, partsExp);
  assert.strictEqual(rec.hours.SC, 3 * 1.5 + 7 * 0.75 + 2 * 1);
  assert.strictEqual(rec.ot, 'x1.5');
  assert.strictEqual(rec.state, 'Missouri');
  assert.strictEqual(rec.bond, true);
  ok('inputs: typed price used, role SC hours, OT, state, bond carried');

  // 2. export one file, reload, compare cached totals
  const meta = {
    customer: 'Sample Customer',
    project: 'Sample Project',
    title: 'Cost Estimate',
    date: '2026-10-01',
    preparedBy: 'Sample Preparer',
  };
  const buf = await X.exportWorkbookSets(sets, meta);
  if (OUT) fs.writeFileSync(OUT, Buffer.from(buf));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const names = wb.worksheets.map((w) => w.name);
  assert.strictEqual(names.length, 21);
  names.forEach((nm) => {
    assert.ok(nm.length >= 1 && nm.length <= 31, 'length ' + nm);
    assert.ok(!/[\[\]:*?\/\\]/.test(nm) && !/^'|'$/.test(nm), 'illegal chars ' + nm);
  });
  assert.strictEqual(new Set(names.map((x) => x.toLowerCase())).size, names.length);
  ok('21 sheets, names valid (<=31, no illegal chars, unique): ' + names.slice(0, 7).join(' | '));

  for (const s of sets) {
    const calc = EW.compute(s.input);
    const cell = wb.getWorksheet(s.name + ' Dash').getCell('N36').value;
    assert.ok(cell && cell.formula, 'N36 keeps its formula (' + s.name + ')');
    assert.strictEqual(cell.result, s.grand, 'cached N36 == page total ' + s.name);
    assert.strictEqual(cell.result, calc.summary.total);
    let checked = 0;
    for (const key of Object.keys(calc.cells)) {
      const [pre, addr] = key.split('!');
      const sheet = { Dash: 'Dash', MatEquip: 'Mat & Equip', LaborRates: 'Labor Rates' }[pre];
      const v = wb.getWorksheet(s.name + ' ' + sheet).getCell(addr).value;
      if (v && typeof v === 'object' && v.formula != null) {
        // ExcelJS omits a cached result of 0 (also in the single export); Excel recalculates on load
        assert.strictEqual(v.result === undefined ? 0 : v.result, calc.cells[key], s.name + ' ' + key);
        checked++;
      }
    }
    assert.ok(checked > 100);
    assert.strictEqual(wb.getWorksheet(s.name + ' Info').getCell('F18').value, 'Missouri');
    assert.strictEqual(wb.getWorksheet(s.name + ' Info').getCell('F16').value, 'x1.5');
    assert.strictEqual(wb.getWorksheet(s.name + ' Info').getCell('C9').value, s.name + ' Cost Estimate');
    ok(s.name + ': N36 cached ' + s.grand + ' == compute() == footer; ' + checked + ' cached cells exact');
  }

  // every formula refers only to sheets of its own set
  const sheetsOf = new Set(names);
  let fcount = 0;
  wb.eachSheet((ws) => {
    const suffix = (ws.name.match(SHEET_RE) || [''])[0];
    const pre = ws.name.slice(0, ws.name.length - suffix.length - 1);
    ws.eachRow((r) =>
      r.eachCell((c) => {
        const v = c.value;
        if (v && v.formula) {
          fcount++;
          (v.formula.match(/'[^']+'!|\b[A-Za-z]+!/g) || []).forEach((ref) => {
            const nm = ref.replace(/!$/, '').replace(/^'|'$/g, '');
            assert.ok(sheetsOf.has(nm), 'ref to missing sheet ' + nm + ' in ' + ws.name + '!' + c.address);
            assert.ok(nm.startsWith(pre + ' '), 'ref leaves set: ' + nm + ' in ' + ws.name + '!' + c.address);
          });
        }
      }),
    );
  });
  ok('all ' + fcount + ' formulas point only at their own tier set');

  let imgs = 0;
  wb.eachSheet((ws) => (imgs += ws.getImages().length));
  assert.strictEqual(imgs, 18);
  ok('images kept (18 = 6 sheets x 3 sets)');

  // 3. prefix rules
  const P = X.setPrefixes([
    { name: 'A/B:C*D?[E]\\F' },
    { name: 'A B C D E F' },
    { name: 'A_Very_Long_Tier_Name_Beyond_Limit' },
    { name: 'A_Very_Long_Tier_Name_Beyond_Limit' },
    { name: "'Quoted'" },
    { name: '' },
  ]);
  P.forEach((p) => assert.ok(p.length + 1 + 'CSC Parts Quote'.length <= 31 && !/[\[\]:*?\/\\']/.test(p)));
  assert.strictEqual(new Set(P.map((x) => x.toLowerCase())).size, P.length);
  ok('prefix rules: ' + JSON.stringify(P));

  // 4. one set keeps template names; Hourly mode has nothing to export; button states
  const one = await X.exportWorkbookSets([sets[1]], meta);
  const w1 = new ExcelJS.Workbook();
  await w1.xlsx.load(one);
  assert.strictEqual(w1.getWorksheet('Dash').getCell('N36').value.result, sets[1].grand);
  ok('single set keeps the template sheet names');
  store.en_pricing_workbook_p = { method: 'hourly' };
  assert.strictEqual(sb._pricingExportSets('p').length, 0);
  const html = sb._pricingEstimateTypeBarHTML('p', 'retrofit');
  assert.ok(
    /id="estExportExcel-p" onclick="pricingExportExcel\('p'\)" disabled title="Switch to the Workbook method to export"/.test(
      html,
    ),
  );
  store.en_pricing_workbook_p = {};
  assert.ok(!/estExportExcel-p"[^>]* disabled/.test(sb._pricingEstimateTypeBarHTML('p', 'retrofit')));
  assert.ok(!/estExportExcel/.test(sb._pricingEstimateTypeBarHTML('p', 'bas')));
  ok('Hourly: no sets, button disabled with reason; Workbook: enabled; audit types: no button');

  // 5. template untouched
  assert.strictEqual(sha(), before);
  ok('template file unchanged on disk');
  console.log('\n' + n + ' checks passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
