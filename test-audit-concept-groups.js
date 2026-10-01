// Unit tests for concept-based sample groups in app/audit-estimate.js — SYNTHETIC data only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
function make(rows, cfg) {
  const store = { audit_estimate_config: cfg || null };
  const ctx = {
    window: {}, console,
    sget: (k, d) => (store[k] != null ? store[k] : d),
    sset: (k, v) => { store[k] = v; },
    emLoadMatrix: () => ({ rows }),
    emIsPhantomRow: () => false,
    emGetNormalizedPoints: (r) => r.pts,
    _pricingGetConfig: () => ({ hourlyRate: 100 }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const P = (...k) => { const o = {}; k.forEach((x) => (o[x] = 1)); return o; };
const mk = (cat, n, pts, b) => Array.from({ length: n }, (_, i) => ({ building: b || 'B', category: cat, name: cat + i, pts }));
const row = (rows, cat) => make(rows).auditEstComputeBreakdown('p', 'bas').rows.find((r) => r.category === cat);

// VAV with / without reheat never merge; noise keys (supply temp, duct static, auto_ alarms) do not split
let rows = [].concat(
  mk('vav', 5, P('damperPosition', 'supplyAirTemp', 'auto_alarmA')),
  mk('vav', 5, P('damperPosition', 'ductStaticPressure', 'auto_alarmB', 'auto_leakDetector')),
  mk('vav', 4, P('damperPosition', 'reheatValve', 'supplyAirTemp')),
  mk('vav', 4, P('damperPosition', 'reheatValve', 'zoneCO2')),
  mk('vav', 1, P('damperPosition', 'reheatValve', 'auto_heatingScr')));
let v = row(rows, 'vav');
assert.strictEqual(v.count, 19);
assert.strictEqual(v.groupCount, 4); // none, HW, HW+CO2, electric+HW
assert.strictEqual(v.sampled, 4);
assert.strictEqual(v.groupList.reduce((s, g) => s + g.count, 0), 19);

// AHU splits: economizer, VFD, DX, CHW
rows = [].concat(
  mk('ahu', 2, P('oaDamperPosition', 'supplyFanSpeed', 'heatingValve', 'coolingValve')),
  mk('ahu', 2, P('oaDamperPosition', 'supplyFanSpeed', 'heatingValve', 'auto_circuit1')),
  mk('ahu', 2, P('oaDamperPosition', 'supplyFanSpeed', 'heatingValve', 'coolingValve', 'ductStaticPressure', 'zoneRelativeHumidity')),
  mk('ahu', 2, P('heatingValve', 'coolingValve')),
  mk('ahu', 1, P('oaDamperPosition', 'auto_supplyVfd', 'heatingValve', 'coolingValve')));
let a = row(rows, 'ahu');
assert.strictEqual(a.groupCount, 3); // econ+fan+HW+CHW (3 point sets merge), econ+fan+HW+DX, HW+CHW
assert.strictEqual(a.sampled, 3);

// Plants: mapped-keys-only exact signature (auto_ keys ignored)
rows = [].concat(
  mk('hwp', 3, P('pumpStatus', 'auto_x')),
  mk('hwp', 3, P('pumpStatus', 'auto_y')),
  mk('hwp', 1, P('pumpStatus', 'pumpSpeed')),
  mk('chwp', 4, P('zoneAirTemp', 'zoneCO2')));
let h = row(rows, 'hwp');
assert.strictEqual(h.groupCount, 2);
assert.strictEqual(row(rows, 'chwp').groupCount, 1); // plants do not use concepts

// Cap: sampled never above count; hours capped at count x hoursEach; singletons count
rows = mk('ahu', 2, P('oaDamperPosition')).concat(mk('ahu', 1, P('coolingValve')));
a = row(rows, 'ahu');
assert.strictEqual(a.sampled, 2);
assert.ok(a.hours <= a.count * a.hoursEach + 1e-9);
// 20 same units -> 1 group -> 0.5 + 1 x each
a = row(mk('ahu', 20, P('oaDamperPosition')), 'ahu');
assert.strictEqual(a.sampled, 1);
assert.strictEqual(a.hours, Math.round((0.5 + a.hoursEach) * 100) / 100);
// Old saved sampleFactor is ignored and not rewritten
const c = make(mk('vav', 50, P('reheatValve')), { sampleFactor: 5 });
assert.strictEqual(c.auditEstComputeBreakdown('p', 'bas').rows[0].sampled, 1);
// Per-building invariants with several buildings
rows = [].concat(mk('vav', 6, P('reheatValve'), 'A'), mk('vav', 5, P(), 'B'), mk('vav', 2, P('zoneCO2'), 'C'));
const b = make(rows).auditEstComputeBreakdown('p', 'bas');
const cents = (x) => Math.round(x * 100);
assert.strictEqual(b.byBuilding.reduce((s, x) => s + cents(x.hours), 0), cents(b.totalHours));
assert.strictEqual(b.byBuilding.reduce((s, x) => s + cents(x.cost), 0), cents(b.totalCost));
assert.strictEqual(b.byBuilding.reduce((s, x) => s + (x.sampled || 0), 0), 3);
console.log('PASS concept-group tests');
