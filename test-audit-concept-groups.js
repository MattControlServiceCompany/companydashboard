// Unit tests for concept-based sample groups in app/audit-estimate.js — SYNTHETIC data only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/audit-estimate.js', 'utf8');
function make(rows, cfg) {
  const store = { audit_estimate_config: cfg || null };
  const ctx = {
    window: {}, console, EstimateWorkbook: require('./app/estimate-workbook.js'),
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

// ── Hours Each overrides (per project) ──
(function () {
  const rows = [].concat(mk('vav', 6, P('reheatValve'), 'A'), mk('vav', 5, P(), 'B'), mk('ahu', 3, P('oaDamperPosition'), 'A'));
  const ctx = make(rows);
  const cents = (x) => Math.round(x * 100);
  const get = (t) => ctx.auditEstComputeBreakdown('p', t);
  const base = get('bas'), baseFull = get('full');
  const vavDefault = base.rows.find((r) => r.category === 'vav').hoursEach;
  assert.strictEqual(ctx.auditEstSetHourOverride('p', 'vav', '2'), 'ok');
  let o = get('bas');
  let vr = o.rows.find((r) => r.category === 'vav');
  assert.strictEqual(vr.hoursEach, 2); assert.strictEqual(vr.overridden, true); assert.strictEqual(vr.defaultHoursEach, vavDefault);
  assert.ok(o.totalHours !== base.totalHours);
  assert.strictEqual(o.rows.find((r) => r.category === 'ahu').overridden, false);
  const f = get('full'); // applies to the Full table too
  assert.strictEqual(f.rows.find((r) => r.category === 'vav').hoursEach, 2);
  [o, f].forEach((b) => {
    assert.strictEqual(b.byBuilding.reduce((s, x) => s + cents(x.hours), 0), cents(b.totalHours));
    assert.strictEqual(b.byBuilding.reduce((s, x) => s + cents(x.cost), 0), cents(b.totalCost));
    assert.ok(isFinite(b.totalHours) && isFinite(b.totalCost));
  });
  // zero is valid (a free type), still finite
  assert.strictEqual(ctx.auditEstSetHourOverride('p', 'vav', '0'), 'ok');
  assert.ok(isFinite(get('bas').totalCost));
  // invalid input leaves the stored value unchanged
  for (const bad of ['-1', 'abc', 'NaN', 'Infinity']) assert.strictEqual(ctx.auditEstSetHourOverride('p', 'vav', bad), 'invalid');
  assert.strictEqual(get('bas').rows.find((r) => r.category === 'vav').hoursEach, 0);
  // blank = default
  assert.strictEqual(ctx.auditEstSetHourOverride('p', 'vav', '  '), 'ok');
  assert.strictEqual(get('bas').totalHours, base.totalHours);
  assert.strictEqual(get('full').totalHours, baseFull.totalHours);
  // reset all restores every default
  ctx.auditEstSetHourOverride('p', 'vav', '3'); ctx.auditEstSetHourOverride('p', 'ahu', '4');
  assert.strictEqual(Object.keys(ctx.auditEstGetHourOverrides('p')).length, 2);
  ctx.auditEstClearHourOverrides('p');
  assert.strictEqual(get('bas').totalCost, base.totalCost);
  // other project unaffected; corrupt stored values ignored
  ctx.auditEstSetHourOverride('q', 'vav', '9');
  assert.strictEqual(Object.keys(ctx.auditEstGetHourOverrides('p')).length, 0);
  ctx.sset('en_pricing_audit_hours_p', { vav: 'x', ahu: -2, ct: null, hwp: NaN });
  assert.strictEqual(Object.keys(ctx.auditEstGetHourOverrides('p')).length, 0);
  assert.strictEqual(get('bas').totalCost, base.totalCost);
  // storage failure does not throw
  ctx.sset = () => { throw new Error('quota'); };
  assert.strictEqual(ctx.auditEstSetHourOverride('p', 'vav', '1'), 'failed');
  // groupList carries representative unit + building
  const g = base.rows.find((r) => r.category === 'vav').groupList[0];
  assert.ok(g.rep && g.repBuilding && typeof g.count === 'number');
})();
console.log('PASS hours override tests');

// ── Resolution order: project override -> company default -> built-in ──
(function () {
  const rows = mk('vav', 4, P('reheatValve'), 'A');
  const store = { audit_estimate_config: null };
  const ctx = make(rows);
  // make() has its own store; rebuild a context with a shared, inspectable store
  const vm = require('vm');
  const c2 = { window: {}, console, EstimateWorkbook: require('./app/estimate-workbook.js'), sget: (k, d) => (store[k] != null ? store[k] : d), sset: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    emLoadMatrix: () => ({ rows }), emIsPhantomRow: () => false, emGetNormalizedPoints: (r) => r.pts, _pricingGetConfig: () => ({ hourlyRate: 100 }) };
  vm.createContext(c2); vm.runInContext(src, c2);
  const vav = () => c2.auditEstComputeBreakdown('p', 'bas').rows[0];
  assert.strictEqual(vav().hoursEach, 1.12); assert.strictEqual(vav().defaultSource, 'built-in');
  // company edit
  c2.auditEstSetConfig('hoursPerEquip.vav', 2.5);
  assert.strictEqual(vav().hoursEach, 2.5); assert.strictEqual(vav().defaultSource, 'company');
  assert.strictEqual(store.audit_estimate_config.hoursPerEquip.vav, 2.5);
  // other stored fields untouched
  c2.auditEstSetConfig('hoursReport', 7);
  assert.strictEqual(store.audit_estimate_config.hoursReport, 7); assert.strictEqual(store.audit_estimate_config.hoursPerEquip.vav, 2.5);
  // project override wins, defaultHoursEach is the company value
  c2.auditEstSetHourOverride('p', 'vav', '4');
  assert.strictEqual(vav().hoursEach, 4); assert.strictEqual(vav().defaultHoursEach, 2.5);
  // save project value as company default clears the override and shares the value
  c2.auditEstSaveCompanyHours('p', 'vav'); // window.initCostEstimateTab absent: guarded
  assert.strictEqual(vav().hoursEach, 4); assert.strictEqual(vav().overridden, false);
  assert.strictEqual(store.audit_estimate_config.hoursPerEquip.vav, 4);
  // reset company default to built-in
  c2.auditEstResetCompanyHours('p', 'vav');
  assert.strictEqual(vav().hoursEach, 1.12);
  assert.strictEqual(store.audit_estimate_config.hoursReport, 7); // never rewrites other values
  assert.ok(store.audit_estimate_config.history.length >= 3);
})();
// sync rule
(function () {
  const SC = require('./app/sync-classification.js');
  assert.strictEqual(SC.classifyKey('audit_estimate_config'), 'synced');
  assert.strictEqual(SC.classifyKey('en_pricing_audit_hours_9'), 'synced');
})();
console.log('PASS resolution order + sync rule tests');

// "Description" auto_ point must not count as SCR (electric heat) and must not split groups
rows = [].concat(mk('vav', 3, P('damperPosition', 'auto_description')), mk('vav', 3, P('damperPosition')));
assert.strictEqual(row(rows, 'vav').groupCount, 1, 'auto_description must not split groups');
assert.strictEqual(make(mk('vav', 2, P('damperPosition', 'auto_heatingScr'))).auditEstComputeBreakdown('p', 'bas').rows[0].groupCount, 1);

// Corrupt company hoursPerEquip (string, negative, NaN, null) is ignored: totals stay finite and equal the built-in result
const base = make(mk('vav', 3, P('damperPosition'))).auditEstComputeBreakdown('p', 'bas');
['x', -2, NaN, null].forEach((bad) => {
  const t = make(mk('vav', 3, P('damperPosition')), { hoursPerEquip: { vav: bad } }).auditEstComputeBreakdown('p', 'bas');
  assert.ok(isFinite(t.totalHours) && isFinite(t.totalCost), 'finite for ' + bad);
  assert.strictEqual(t.totalHours, base.totalHours);
  assert.strictEqual(t.totalCost, base.totalCost);
});
const good = make(mk('vav', 3, P('damperPosition')), { hoursPerEquip: { vav: 3 } }).auditEstComputeBreakdown('p', 'bas');
assert.ok(good.totalHours !== base.totalHours, 'valid company value still used');
console.log('corrupt-config + description tests ok');
