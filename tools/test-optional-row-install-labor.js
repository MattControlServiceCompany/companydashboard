// Optional-point (opt_/fso_) rows carry the same install labor as required-point rows
// (Deliverable E; Matt: Full Scope holds every item with a price). Synthetic data only.
// Run: node tools/test-optional-row-install-labor.js   (exit 0 = all pass)
const vm = require('vm'),
  fs = require('fs'),
  path = require('path');
const ROOT = path.join(__dirname, '..');
const store = {};
const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
const sb = {
  console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
  document: { getElementById: () => null, createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
  sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  sset: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
  showToast() {}, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
};
sb.window = sb;
sb.globalThis = sb;
const ctx = vm.createContext(sb);
const run = (s) => vm.runInContext(s, ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/pricing-estimator.js'), 'utf8'), ctx, { filename: 'app/pricing-estimator.js' });
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}

store.en_pricing_catalog = { 'ZS2-ALC': { list: 100, net: 80 } };
const RATE = run('_pricingGetConfig().hourlyRate');
const zone = (cat, id, missing) => ({
  id, name: id, category: cat,
  compliance: { missingPoints: missing.map((k) => ({ categoryKey: k })), coveredPoints: [] },
  seqReadiness: {},
});

// ---- Optional rows: one equipment, three optional point categories ----
ctx.EM_POINT_CATEGORIES = {
  testcat: [
    { key: 'zoneTemp', required: false },
    { key: 'freezeStat', required: false },
    { key: 'dampCmd', required: false },
  ],
};
ctx.collectASHRAE36Data = () => ({ buildings: [{ name: 'Bldg A', equipResults: [zone('testcat', 'E1', [])] }] });
const opt = run('buildOptionalPointRows(1)');
const byPk = (k) => opt.find((r) => r._pointKey === k);
const sku = byPk('zoneTemp'), nosku = byPk('freezeStat'), io = byPk('dampCmd');
check('optional rows exist (sku, noSku, ioOnly)', !!(sku && nosku && io), opt.map((r) => r._pointKey).join(','));
if (sku && nosku && io) {
  const hrs = run('INSTALL_HOURS_BY_POINT_DEFAULT.zoneTemp');
  const labor = Math.round(hrs * 1 * RATE * 100) / 100;
  check('optional SKU row installLaborTotal = hours x qty x rate', sku.installLaborTotal === labor && labor > 0, sku.installLaborTotal + ' vs ' + labor);
  check('optional SKU row lineTotal = parts + labor', sku.lineTotal === Math.round((sku.partsLineTotal + labor) * 100) / 100 && sku.partsLineTotal > 0, JSON.stringify([sku.lineTotal, sku.partsLineTotal]));
  check('optional SKU row unitPrice = partsUnitPrice + hours x rate', sku.unitPrice === Math.round((sku.partsUnitPrice + hrs * RATE) * 100) / 100, sku.unitPrice + ' / ' + sku.partsUnitPrice);
  check('optional SKU row stamps installHours and installLaborRate', sku.installHours === hrs && sku.installLaborRate === RATE);
  check('optional noSku row has installLaborTotal > 0 and null lineTotal/unitPrice',
    nosku.noSku === true && nosku.installLaborTotal > 0 && nosku.lineTotal === null && nosku.unitPrice === null,
    JSON.stringify([nosku.installLaborTotal, nosku.lineTotal, nosku.unitPrice]));
  check('optional ioOnly row has 0 labor, 0 hours, 0 price', io.ioOnly === true && io.installLaborTotal === 0 && io.installHours === 0 && io.lineTotal === 0 && io.unitPrice === 0);
  // Full Scope returns [] without a required row, so add one zone with a required gap.
  ctx.collectASHRAE36Data = () => ({ buildings: [{ name: 'Bldg A', equipResults: [zone('testcat', 'E1', []), zone('vav', 'V1', ['zoneTemp'])] }] });
  const fso = run('buildFullScopeRows(1)').filter((r) => /^fso_/.test(r.id));
  const fsoSku = fso.find((r) => r._pointKey === 'zoneTemp');
  check('Full Scope fso_ row carries the labor', !!fsoSku && fsoSku.installLaborTotal === labor && fsoSku.lineTotal === sku.lineTotal);
}

// ---- Required row unchanged (known value): 1 zone missing zoneTemp, ZS2-ALC ----
ctx.collectASHRAE36Data = () => ({ buildings: [{ name: 'Bldg A', equipResults: [zone('vav', 'V1', ['zoneTemp'])] }] });
const req = run('buildCatalogRows(1)').find((r) => r.sku === 'ZS2-ALC');
check('required row exists', !!req);
if (req) {
  const labor = Math.round(1.5 * RATE * 100) / 100;
  check('required row known value: 1.5 h x qty 1 x rate', req.installHours === 1.5 && req.installLaborTotal === labor, JSON.stringify([req.installHours, req.installLaborTotal]));
  check('required row lineTotal = parts + labor', req.lineTotal === Math.round((req.partsLineTotal + labor) * 100) / 100);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
