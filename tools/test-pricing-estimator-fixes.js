// WP-22 acceptance test: pricing estimator + Audit Estimate. Synthetic data only.
// Run: node tools/test-pricing-estimator-fixes.js   (exit 0 = all pass)
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
function load(ctx, rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
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
load(ctx, 'app/pricing-estimator.js');
load(ctx, 'app/audit-estimate.js');
const pSrc = fs.readFileSync(path.join(ROOT, 'app/pricing-estimator.js'), 'utf8');
const aSrc = fs.readFileSync(path.join(ROOT, 'app/audit-estimate.js'), 'utf8');

// 1. Electric commodity + newest 12 months
function mkBills(n, startY, startM) {
  const b = [];
  for (let i = 0; i < n; i++) {
    const m = startM + i,
      y = startY + Math.floor((m - 1) / 12),
      mm = ((m - 1) % 12) + 1;
    const s = y + '-' + String(mm).padStart(2, '0') + '-01';
    b.push({ start: s, end: s, kwh: 1000, totalCost: 100 });
  }
  return b;
}
ctx.getUDBldgs = () => [
  {
    meters: [
      { commodity: 'Electric', bills: mkBills(24, 2024, 1) },
      { commodity: 'Electric', bills: mkBills(24, 2024, 1) },
    ],
  },
];
let r = run(ctx, '_pricingGetProjectAnnualElec(1)');
check('Electric meters are read (hasBillData)', r.hasBillData === true && r.annualKwh !== null, JSON.stringify(r));
check('24 months x 2 meters -> newest 12 months = 24000 kWh (not 12 bills)', r.annualKwh === 24000, r.annualKwh);
ctx.getUDBldgs = () => [{ meters: [{ commodity: 'Electric', bills: mkBills(6, 2025, 1) }] }];
r = run(ctx, '_pricingGetProjectAnnualElec(1)');
check('6 months of data annualized x12/6 = 12000', r.annualKwh === 12000, r.annualKwh);
ctx.getUDBldgs = () => [{ meters: [{ commodity: 'Gas', bills: mkBills(12, 2025, 1) }] }];
check('Gas meter is not counted as electric', run(ctx, '_pricingGetProjectAnnualElec(1)').hasBillData === false);

// 2. Saved config: new save stores only changed fields; stored values always win
delete store.en_pricing_config;
run(ctx, "_pricingSetConfig({ priceBasis: 'net' })");
check(
  'new save stores only the changed field',
  JSON.stringify(Object.keys(store.en_pricing_config)) === '["priceBasis"]',
  JSON.stringify(Object.keys(store.en_pricing_config)),
);
let cfg = run(ctx, '_pricingGetConfig()');
check(
  'new config reads live default hourlyRate',
  cfg.hourlyRate === run(ctx, 'COST_LABOR_RATE_DEFAULT'),
  cfg.hourlyRate,
);
store.en_pricing_config = { hourlyRate: 173 };
cfg = run(ctx, '_pricingGetConfig()');
check('existing stored 173 is kept', cfg.hourlyRate === 173, cfg.hourlyRate);
run(ctx, "_pricingSetConfig({ priceBasis: 'list' })");
check(
  'save on top of stored 173 keeps 173 and adds only the change',
  store.en_pricing_config.hourlyRate === 173 &&
    store.en_pricing_config.priceBasis === 'list' &&
    Object.keys(store.en_pricing_config).length === 2,
  JSON.stringify(store.en_pricing_config),
);
store.en_pricing_config = { perSequenceHours: { ahu_sat_reset: 9 } };
cfg = run(ctx, '_pricingGetConfig()');
check(
  'partial stored hours table: stored key wins, missing keys use live defaults',
  cfg.perSequenceHours.ahu_sat_reset === 9 &&
    cfg.perSequenceHours.vav_dcv === run(ctx, 'COST_PER_SEQ_HOURS_DEFAULT.vav_dcv') &&
    cfg.perSequenceHours.vav_dcv !== undefined,
  JSON.stringify(cfg.perSequenceHours.vav_dcv),
);
delete store.en_pricing_config;

// 3. Unit price resolver: one keeper
check('keeper _pricingUnitPriceFor exists', run(ctx, 'typeof _pricingUnitPriceFor') === 'function');
if (run(ctx, 'typeof _pricingUnitPriceFor') === 'function') {
  check(
    'contract basis = 40% of list',
    run(ctx, "_pricingUnitPriceFor({list:100,net:55},{priceBasis:'contract'})") === 40,
  );
  check('list basis', run(ctx, "_pricingUnitPriceFor({list:100,net:55},{priceBasis:'list'})") === 100);
  check('net basis', run(ctx, "_pricingUnitPriceFor({list:100,net:55},{priceBasis:'net'})") === 55);
  check('missing entry -> null', run(ctx, "_pricingUnitPriceFor(null,{priceBasis:'list'})") === null);
}
const cpCount = (pSrc.match(/COST_CONTRACT_PCT \* /g) || []).length;
check('no inline contract-price copies remain (max 1 in the keeper)', cpCount <= 1, cpCount);

// 4. Contract % input removed (constant 40%, never drove price)
check('Contract % input removed', pSrc.indexOf('pricing-contract-pct-') === -1 && pSrc.indexOf("'contractPct'") === -1);
check('no cfg.contractPct reads', pSrc.indexOf('cfg.contractPct') === -1);

// 5. One labor rate constant
check('AUDIT_EST_RATE_DEFAULT removed', aSrc.indexOf('AUDIT_EST_RATE_DEFAULT') === -1);
check('audit config has no own hourlyRate', run(ctx, 'auditEstGetConfig().hourlyRate') === undefined);
ctx._pricingGetConfig = () => ({ hourlyRate: 172.5 });
check('audit rate = pricing config rate', run(ctx, 'auditEstGetHourlyRate()') === 172.5);

// 6. Audit Proposal: building with only non-auditable category is not priced
const rows = [];
const add = (b, cat, n) => {
  for (let i = 0; i < n; i++) rows.push({ building: b, category: cat, points: { a: 1 } });
};
add('Bldg A', 'vav', 4);
add('Bldg B', 'ahu', 2);
add('Bldg C', 'lighting', 4);
ctx.emLoadMatrix = () => ({ rows });
ctx.emIsPhantomRow = () => false;
ctx.emGetNormalizedPoints = (r) => r.points;
let b = run(ctx, "auditEstComputeBreakdown(1,'bas')");
check('audit priced building count = 2 (not 3)', b.buildingCount === 2 && b.buildingList.length === 2, b.buildingCount);
b = run(ctx, "auditEstComputeBreakdown(1,'full')");
const extraHrs = b.extras.reduce((s, x) => s + x.hours, 0);
check('Full Facility per-building extras for 2 buildings = 2 x (2+1+1+1) = 10 h', extraHrs === 10, extraHrs);
// 6b. Sample-based hours (synthetic): 4 VAV same points -> 1 group; 2 AHU -> min cap.
{
  const bas = run(ctx, "auditEstComputeBreakdown(1,'bas')");
  const vav = bas.rows.find((r) => r.category === 'vav');
  check('VAV 4 same-point units = 1 group', vav.groupCount === 1, vav.groupCount);
  // one group -> one sampled unit: min(4*1.12, 0.5 + 1*1.12) = 1.62
  check('VAV sampled = 1 unit (one group), hours 0.5 + 1.12 = 1.62', vav.hours === 1.62 && vav.sampled === 1, vav.hours);
  const ahu = bas.rows.find((r) => r.category === 'ahu');
  check('AHU 2 same-feature units = 0.5 + 1*2.83 = 3.33', ahu.hours === 3.33, ahu.hours);
  check('BAS has no site visit hours', bas.buildingLineHours === 0 && bas.buildingLineCost === 0);
  const full = run(ctx, "auditEstComputeBreakdown(1,'full')");
  check('Full keeps site visit = 2 buildings x 2 h', full.buildingLineHours === 4, full.buildingLineHours);
  rows.push({ building: 'Bldg B', category: 'vav', points: { a: 1, zoneCO2: 1 } });
  const vav2 = run(ctx, "auditEstComputeBreakdown(1,'bas')").rows.find((r) => r.category === 'vav');
  check('different control features (CO2) = 2 groups', vav2.groupCount === 2, vav2.groupCount);
  rows.pop();
  rows.push({ building: 'Bldg A', category: 'hwp', points: { a: 1 } });
  const hwp = run(ctx, "auditEstComputeBreakdown(1,'bas')").rows.find((r) => r.category === 'hwp');
  check('one-unit type costs the old figure (min cap)', hwp.hours === 4, hwp.hours);
  rows.pop();
}
check('proposal price 84377.80 -> 84400', run(ctx, 'auditEstRoundProposalPrice(84377.8)') === 84400);
check('proposal price 84400 -> 84400', run(ctx, 'auditEstRoundProposalPrice(84400)') === 84400);

// 7. One totals function; cents rounding at total; dead code removed
check('sumRows removed', pSrc.indexOf('function sumRows') === -1);
check('collectPricingEstimate removed', pSrc.indexOf('function collectPricingEstimate') === -1);
ctx.__t = [
  { id: 'a', phase: 1, lineTotal: 0.1, qty: 1 },
  { id: 'b', phase: 1, lineTotal: 0.2, qty: 1 },
  { id: 'c', phase: 2, lineTotal: 1422158.1999999993, qty: 1 },
];
ctx.__e = { rowToggles: {}, manualPrices: {} };
const t = run(ctx, '_pricingComputeTotals(__t, __e)');
check('phase1 0.1+0.2 = 0.3 exactly', t.phase1 === 0.3, t.phase1);
check('grand rounded to cents (1422158.50)', t.grand === 1422158.5, t.grand);

// 8. False toast removed
check('false "Net multiplier updated" toast removed', pSrc.indexOf('Net multiplier updated') === -1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
