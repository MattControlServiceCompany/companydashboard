// Tests: Audit Estimate pricing methods (Workbook default, Hourly = old numbers) — SYNTHETIC data only.
// Hourly mode is compared with the pre-change app/audit-estimate.js (git ba5bc87) read from git.
const fs = require('fs'),
  vm = require('vm'),
  assert = require('assert'),
  cp = require('child_process');
const EW = require('./app/estimate-workbook.js');
const newSrc = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
const oldSrc = cp.execFileSync('git', ['show', 'ba5bc87:app/audit-estimate.js'], {
  cwd: __dirname,
  encoding: 'utf8',
  maxBuffer: 1 << 24,
});

function make(src, rows, store, rate) {
  store = store || {};
  const ctx = {
    window: {},
    console,
    EstimateWorkbook: EW,
    sget: (k, d) => (store[k] != null ? JSON.parse(JSON.stringify(store[k])) : d),
    sset: (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
    },
    emLoadMatrix: () => ({ rows }),
    emIsPhantomRow: () => false,
    emGetNormalizedPoints: (r) => r.pts || {},
    _pricingGetConfig: () => ({ hourlyRate: rate == null ? 170 : rate }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
function fixture() {
  const rows = [];
  const add = (b, cat, n, pts) => {
    for (let i = 0; i < n; i++) rows.push({ building: b, category: cat, points: { a: 1 }, pts: pts || {} });
  };
  add('Alpha Hall', 'vav', 23);
  add('Beta Annex', 'vav', 9, { reheatValve: 1 });
  add('Gamma', 'vav', 4);
  add('Alpha Hall', 'ahu', 2);
  add('Gamma', 'ahu', 1, { oaDamperPosition: 1 });
  add('Beta Annex', 'rtu', 7);
  add('Delta', 'rtu', 1);
  add('Epsilon Empty', 'lighting', 3);
  add('Gamma', 'ef', 1);
  return rows;
}
const deq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const cents = (x) => Math.round(x * 100);
let n = 0;

// 1. Hourly mode == the old code, field by field, both audit types, several rates.
for (const rate of [170, 120, 97.35]) {
  const oldC = make(oldSrc, fixture(), {}, rate);
  const newC = make(newSrc, fixture(), { en_pricing_workbook_p: { method: 'hourly' } }, rate);
  for (const t of ['bas', 'full']) {
    const o = oldC.auditEstComputeBreakdown('p', t),
      h = newC.auditEstComputeBreakdown('p', t);
    assert.strictEqual(h.method, 'hourly');
    for (const k of [
      'totalHours',
      'totalCost',
      'buildingLineHours',
      'buildingLineCost',
      'reportHours',
      'reportCost',
      'hourlyRate',
    ])
      assert.strictEqual(h[k], o[k], 'hourly ' + k + ' ' + t + ' ' + rate);
    deq(h.byBuilding, o.byBuilding);
    deq(h.extras, o.extras);
    deq(
      h.rows.map((r) => [r.category, r.hours, r.cost, r.sampled]),
      o.rows.map((r) => [r.category, r.hours, r.cost, r.sampled]),
    );
    assert.strictEqual(h.proposalPrice, oldC.auditEstRoundProposalPrice(o.totalCost)); // $100 round-up kept
    assert.strictEqual(h.workbook, null);
    n++;
  }
}

// 2. Workbook mode (default: no setting stored) == compute() of the role hours.
for (const t of ['bas', 'full']) {
  const c = make(newSrc, fixture(), {}, 170);
  const b = c.auditEstComputeBreakdown('p', t);
  assert.strictEqual(b.method, 'workbook');
  const hrsSum = b.workbook.tasks.reduce((s, x) => s + cents(x.hours), 0);
  assert.strictEqual(hrsSum, cents(b.totalHours), 'task hours add to total hours');
  assert.ok(
    b.workbook.tasks.every((x) => x.role === 'PE'),
    'all audit work -> PE by default',
  );
  const ref = EW.compute({
    hours: { PE: b.totalHours },
    ot: 'Not Applicable',
    state: 'Kansas',
    taxRate: 0,
    bond: false,
  });
  assert.strictEqual(b.totalCost, ref.summary.total);
  assert.strictEqual(b.totalCost, ref.cells['Dash!N36']);
  assert.strictEqual(b.proposalPrice, b.totalCost, 'no $100 round-up in workbook mode');
  const lab = b.workbook.chain.find((x) => x.key === 'labor').amount,
    tools = b.workbook.chain.find((x) => x.key === 'tools').amount;
  assert.strictEqual(lab, ref.cells['Dash!G18']);
  assert.strictEqual(tools, ref.cells['Dash!G32']);
  assert.ok(b.workbook.chain.find((x) => x.label === 'Tool rental tax (paid by CSC)'));
  // everything adds to the total in whole dollars
  assert.strictEqual(
    b.byBuilding.reduce((s, x) => s + cents(x.cost), 0),
    cents(b.totalCost),
  );
  assert.ok(b.byBuilding.every((x) => Number.isInteger(x.cost)));
  const lines =
    b.rows.reduce((s, r) => s + r.cost, 0) +
    b.buildingLineCost +
    b.reportCost +
    b.extras.reduce((s, x) => s + x.cost, 0);
  assert.strictEqual(lines, b.totalCost);
  n++;
}

// 3. Fixture: 52 h of PE -> 9195 (labor 6335, tools 95, direct 6430, overhead 643, profit 2122).
{
  const rows = [{ building: 'A', category: 'vav', points: {}, pts: {} }];
  const c = make(newSrc, rows, {
    audit_estimate_config: { hoursReport: 52, matrixReviewHours: 0 },
    en_pricing_audit_hours_p: { vav: 0 },
  });
  const b = c.auditEstComputeBreakdown('p', 'bas');
  assert.strictEqual(b.totalHours, 52);
  deq(b.workbook.roleHours, { PE: 52 });
  const ch = Object.fromEntries(b.workbook.chain.map((x) => [x.key, x.amount]));
  deq(
    [ch.labor, ch.tools, ch.rentalTax, ch.direct, ch.overhead, ch.profit, ch.total],
    [6335, 95, 0, 6430, 643, 2122, 9195],
  );
  assert.strictEqual(b.totalCost, 9195);
  n++;
}

// 4. Settings: role per task, OT, state/tax, bond; stored only when changed; invalid rejected.
{
  const store = {};
  const c = make(newSrc, fixture(), store);
  const base = c.auditEstComputeBreakdown('p', 'full');
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'method', 'hourly'), 'ok');
  deq(store.en_pricing_workbook_p, { method: 'hourly' });
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'method', 'workbook'), 'ok');
  deq(store.en_pricing_workbook_p, {}); // absent = workbook
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'method', 'bogus'), 'invalid');
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'SE' }), 'ok');
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'ZZ' }), 'invalid');
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'role', { task: 'nope', role: 'PE' }), 'invalid');
  let b = c.auditEstComputeBreakdown('p', 'full');
  assert.strictEqual(b.workbook.tasks.find((x) => x.id === 'audit_report').role, 'SE');
  const ref = EW.compute({ hours: { PE: Math.round((b.totalHours - b.reportHours) * 100) / 100, SE: b.reportHours } });
  assert.strictEqual(b.totalCost, ref.summary.total);
  assert.notStrictEqual(b.totalCost, base.totalCost);
  c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'PE' });
  deq(store.en_pricing_workbook_p, {}); // back to default drops the entry
  // OT only moves OT-capable roles; PE is not -> same total
  c.auditEstSetWorkbookSetting('p', 'ot', 'x1.5');
  assert.strictEqual(c.auditEstComputeBreakdown('p', 'full').totalCost, base.totalCost);
  c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'SC' }); // SC has OT
  const sc15 = c.auditEstComputeBreakdown('p', 'full').totalCost;
  c.auditEstSetWorkbookSetting('p', 'ot', 'x2.0');
  assert.ok(c.auditEstComputeBreakdown('p', 'full').totalCost > sc15);
  c.auditEstSetWorkbookSetting('p', 'ot', 'Not Applicable');
  c.auditEstSetWorkbookSetting('p', 'role', { task: 'audit_report', role: 'PE' });
  // Kansas tax on the project total; Missouri: none on audit work (no materials)
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'taxRate', 0.0875), 'ok');
  b = c.auditEstComputeBreakdown('p', 'bas');
  const ks = EW.compute({ hours: { PE: b.totalHours }, state: 'Kansas', taxRate: 0.0875 });
  assert.strictEqual(b.totalCost, ks.summary.total);
  assert.ok(b.workbook.chain.find((x) => x.key === 'tax'));
  c.auditEstSetWorkbookSetting('p', 'state', 'Missouri');
  const mo = EW.compute({ hours: { PE: b.totalHours }, state: 'Missouri', taxRate: 0.0875 });
  assert.strictEqual(c.auditEstComputeBreakdown('p', 'bas').totalCost, mo.summary.total);
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'taxRate', '-1'), 'invalid');
  assert.strictEqual(c.auditEstSetWorkbookSetting('p', 'state', 'Texas'), 'invalid');
  c.auditEstSetWorkbookSetting('p', 'bond', true);
  assert.ok(c.auditEstComputeBreakdown('p', 'bas').workbook.chain.find((x) => x.key === 'bond'));
  // corrupt stored values fall back to the defaults
  store.en_pricing_workbook_p = {
    method: 5,
    roles: { audit_report: 'ZZ', bad: 'PE' },
    ot: 'x9',
    state: 1,
    taxRate: 'x',
    bond: 'yes',
  };
  const s = c.auditEstGetWorkbookSettings('p');
  deq(s, {
    method: 'workbook',
    roles: {},
    ot: 'Not Applicable',
    state: 'Kansas',
    taxRate: 0,
    bond: false,
    hours: {},
    partPrices: {},
    baseRates: {},
    pct: {},
  });
  n++;
}

// 5. Per-project: another project keeps its own method.
{
  const store = {};
  const c = make(newSrc, fixture(), store);
  c.auditEstSetWorkbookSetting('p', 'method', 'hourly');
  assert.strictEqual(c.auditEstComputeBreakdown('q', 'bas').method, 'workbook');
  assert.strictEqual(c.auditEstComputeBreakdown('p', 'bas').method, 'hourly');
  n++;
}

// 6. Switch + UI HTML render for both modes (no throw, buttons present, export disabled in hourly).
{
  const store = {};
  const c = make(newSrc, fixture(), store);
  assert.ok(/aria-pressed="true"[^>]*>Workbook/.test(c.auditEstMethodSwitchHTML('p')));
  const html = c.auditEstRenderHTML('p', 'bas');
  assert.ok(html.indexOf('How this total is built') > -1 && html.indexOf('Tool rental tax (paid by CSC)') > -1);
  assert.ok(
    html.indexOf('Export to Excel') > -1 &&
      !/disabled title="[^"]*export/.test(html),
  );
  assert.ok(html.indexOf('rounded up') === -1);
  c.auditEstSetWorkbookSetting('p', 'method', 'hourly');
  const h2 = c.auditEstRenderHTML('p', 'bas');
  assert.ok(h2.indexOf('rounded up to the next $100') > -1 && h2.indexOf('How this total is built') === -1);
  assert.ok(/ disabled title="Switch to the Workbook method to export"/.test(h2));
  assert.ok(/aria-pressed="true"[^>]*>Hourly \$170/.test(c.auditEstMethodSwitchHTML('p')));
  n++;
}
console.log('PASS', n, 'method tests (hourly = old numbers, workbook = compute(), 52 h = 9195)');
