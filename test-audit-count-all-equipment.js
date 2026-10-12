// Every equipment row counts in the audit estimate; non-equipment rows are listed, not priced. SYNTHETIC data only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
function make(rows) {
  const ctx = {
    window: {}, console, EstimateWorkbook: require('./app/estimate-workbook.js'),
    sget: (k, d) => d, sset: () => {},
    emLoadMatrix: () => ({ rows }), emIsPhantomRow: () => false, emPointOrMeterKind: require('./test-em-point-kind-helper.js'),
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
// Monitor / detector / water-meter rows add no units, even when filed under an equipment category.
const pts = [['vrf', 'VRF-01 CO2 Monitoring'], ['ac', 'AC-1A Monitor'], ['plumbing', 'Pit Leak Detector'], ['plumbing', 'Domestic Water Meter']]
  .map(([c, n]) => ({ building: 'B', category: c, name: n, equipName: n, pts: {} }));
const real = [{ building: 'B', category: 'vrf', name: 'VRF-01', equipName: 'VRF-01', pts: {} }, { building: 'B', category: 'heater', name: 'Baseboard Heaters', equipName: 'Baseboard Heaters', pts: {} }];
const ctx2 = make(real.concat(pts));
const s2 = ctx2.auditEstGetEquipmentSummary('p');
assert.strictEqual(s2.equipTypes.reduce((n, e) => n + e.count, 0), 2, 'only the 2 real units count');
assert.strictEqual(s2.notEquipment.reduce((n, e) => n + e.count, 0), 4, 'the 4 points / meters are listed, not counted');
console.log('count-all-equipment tests ok');
