// Every equipment row counts in the audit estimate; non-equipment rows are listed, not priced. SYNTHETIC data only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
function make(rows) {
  const ctx = {
    window: {}, console, EstimateWorkbook: require('./app/estimate-workbook.js'),
    sget: (k, d) => d, sset: () => {},
    emLoadMatrix: () => ({ rows }), emIsPhantomRow: () => false,
    emGetNormalizedPoints: (r) => r.pts || {}, _pricingGetConfig: () => ({ hourlyRate: 100 }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const mk = (cat, n) => Array.from({ length: n }, (_, i) => ({ building: 'B', category: cat, name: cat + i, pts: {} }));
const equip = ['ahu', 'vav', 'ef', 'vrf', 'ac', 'plumbing', 'controls', 'power', 'fire', 'lifesafety', 'security', 'elevator', 'mau', 'erv'];
const nonEquip = ['lighting', 'sensor', 'monitoring', 'meter', 'other'];
let rows = [];
equip.forEach((c, i) => { rows = rows.concat(mk(c, i + 1)); });
nonEquip.forEach((c) => { rows = rows.concat(mk(c, 2)); });
const ctx = make(rows);
['bas', 'full'].forEach((t) => {
  const b = ctx.auditEstComputeBreakdown('p', t);
  assert.strictEqual(b.rows.reduce((s, r) => s + r.count, 0), equip.length * (equip.length + 1) / 2);
  equip.forEach((c) => assert.ok(b.rows.find((r) => r.category === c && r.hoursEach > 0), c + ' counted with hours'));
  assert.strictEqual(JSON.stringify(b.notEquipment.map((x) => x.category).sort()), JSON.stringify(nonEquip.slice().sort()));
  assert.ok(b.notEquipment.every((x) => x.count === 2));
});
assert.strictEqual(typeof ctx.AUDIT_EST_EXCLUDED_CATEGORIES, 'undefined');
console.log('count-all-equipment tests ok');
