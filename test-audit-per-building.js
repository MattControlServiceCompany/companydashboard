// Unit tests for auditEstComputeBreakdown().byBuilding — SYNTHETIC data only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
function make(rows, cfgOver, rate, mbuildings) {
  const store = { audit_estimate_config: cfgOver || null };
  const ctx = {
    window: {}, console,
    sget: (k, d) => (store[k] != null ? store[k] : d),
    sset: (k, v) => { store[k] = v; },
    emLoadMatrix: () => ({ rows, buildings: mbuildings }),
    emIsPhantomRow: () => false,
    emGetNormalizedPoints: (r) => r.pts || {},
    _pricingGetConfig: () => ({ hourlyRate: rate == null ? 120 : rate }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const MIXES = [
  [{}],
  [{}, { reheatValve: 1 }],
  [{}, { reheatValve: 1 }, { zoneCO2: 1 }, { reheatValve: 1, zoneCO2: 1 }, { auto_scr: 1 }],
];
let MIX = MIXES[0], mix = 1;
function fixture() {
  const rows = [];
  const add = (b, cat, n) => { for (let i = 0; i < n; i++) rows.push({ building: b, category: cat, points: { a: 1 }, pts: MIX[(i + rows.length) % mix] }); };
  add('Alpha Hall', 'vav', 23); add('Beta  Annex', 'vav', 9); add('Gamma', 'vav', 4);
  add('Alpha Hall', 'ahu', 2); add('Gamma', 'ahu', 1);
  add('Beta  Annex', 'rtu', 7); add('Delta', 'rtu', 1);
  add('Epsilon Empty', 'lighting', 3); // building with only excluded equipment
  add('Gamma', 'ef', 1);
  return rows;
}
let n = 0;
function check(b, label) {
  const cents = (x) => Math.round(x * 100);
  const sumH = b.byBuilding.reduce((s, x) => s + cents(x.hours), 0);
  const sumC = b.byBuilding.reduce((s, x) => s + cents(x.cost), 0);
  assert.strictEqual(sumH, cents(b.totalHours), label + ' hours');
  assert.strictEqual(sumC, cents(b.totalCost), label + ' cost');
  const sumS = b.byBuilding.reduce((s, x) => s + (x.sampled || 0), 0);
  assert.strictEqual(sumS, b.rows.reduce((s, r) => s + r.sampled, 0), label + ' sampled');
  const sumE = b.byBuilding.reduce((s, x) => s + (x.equipment || 0), 0);
  assert.strictEqual(sumE, b.rows.reduce((s, r) => s + r.count, 0), label + ' equipment');
  n++;
}
for (const sf of [0, 1, 2]) {
  MIX = MIXES[sf]; mix = MIX.length;
  for (const rate of [120, 97.35]) {
    const ctx = make(fixture(), null, rate);
    for (const t of ['bas', 'full']) {
      const b = ctx.auditEstComputeBreakdown('p', t);
      check(b, t + ' mix=' + sf + ' rate=' + rate);
      assert.strictEqual(b.byBuilding.length, 6); // 5 buildings + Project-wide
      const eps = b.byBuilding.find((x) => x.building === 'Epsilon Empty');
      assert.ok(eps && eps.equipment === 0 && eps.sampled === 0 && eps.hours === 0 && eps.cost === 0);
      assert.ok(b.byBuilding.find((x) => x.building === 'Beta  Annex')); // name kept exactly
      assert.ok(b.byBuilding[5].projectWide);
      // building with 0 of a type gets 0 of it: Delta has only rtu (1 unit)
      assert.ok(b.byBuilding.find((x) => x.building === 'Delta').sampled <= 1);
      if (t === 'bas') assert.ok(b.byBuilding.filter((x) => !x.projectWide).every((x) => x.hours >= 0));
    }
  }
}
// Full: per-building rows reach buildings that carry auditable equipment, not Epsilon.
const f = make(fixture(), null).auditEstComputeBreakdown('p', 'full');
const bas = make(fixture(), null).auditEstComputeBreakdown('p', 'bas');
assert.ok(f.byBuilding.find((x) => x.building === 'Delta').hours > bas.byBuilding.find((x) => x.building === 'Delta').hours);
assert.strictEqual(f.byBuilding.find((x) => x.building === 'Epsilon Empty').hours, 0);
// More distinct control features -> more groups -> more sampled
MIX = MIXES[0]; mix = 1;
const lo = make(fixture(), null).auditEstComputeBreakdown('p', 'bas');
MIX = MIXES[2]; mix = MIX.length;
const hi = make(fixture(), null).auditEstComputeBreakdown('p', 'bas');
assert.ok(hi.byBuilding.reduce((s, x) => s + (x.sampled || 0), 0) > lo.byBuilding.reduce((s, x) => s + (x.sampled || 0), 0));
MIX = MIXES[0]; mix = 1;
// Per-type allocation sums (single-type project)
for (const cnt of [[5, 3, 0, 1], [1, 1, 1], [40, 7, 13, 2, 9], [2]]) {
  const rows = [];
  cnt.forEach((c, i) => { for (let k = 0; k < c; k++) rows.push({ building: 'B' + i, category: 'vav', points: {} }); });
  const b = make(rows, null).auditEstComputeBreakdown('p', 'bas');
  assert.strictEqual(b.byBuilding.filter((x) => !x.projectWide).reduce((s, x) => s + x.sampled, 0), b.rows[0].sampled);
  check(b, 'single ' + cnt);
}
// Matrix-only building (listed in matrix.buildings, no rows) appears with zeros; invariants hold.
for (const t of ['bas', 'full']) {
  const z = make(fixture(), null, 120, ['Alpha Hall', 'Zeta Not In Matrix']).auditEstComputeBreakdown('p', t);
  const zb = z.byBuilding.find((x) => x.building === 'Zeta Not In Matrix');
  assert.ok(zb && zb.equipment === 0 && zb.sampled === 0 && zb.hours === 0 && zb.cost === 0);
  assert.strictEqual(z.byBuilding.length, 7);
  check(z, 'zeta ' + t);
}
console.log('PASS', n, 'invariant checks + allocation/zero-equipment/mix tests');
