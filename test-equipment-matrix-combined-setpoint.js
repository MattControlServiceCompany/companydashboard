// afe7abb5: single combined Temperature Setpoint is recognized by the setpoint compliance check.
// Loads the REAL app/equipment-matrix.js in a vm sandbox. Fixtures are 100% SYNTHETIC.
// Run: node test-equipment-matrix-combined-setpoint.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = path.join(__dirname, 'app', 'equipment-matrix.js');
const sb = {
  console,
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return { style: {}, classList: { add() {} } }; } },
  localStorage: { getItem() { return null; }, setItem() {} },
  navigator: {},
  window: {},
};
sb.window = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb, { filename: SRC });

let fail = 0;
function eq(a, b, label) {
  if (a === b) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label + ' expected ' + b + ' got ' + a); }
}
function row(id, cat, raw) {
  return { id: id, building: 'Test Bldg', equipName: id, equipType: id, category: cat, points: Object.assign({}, raw), pointsRaw: Object.assign({}, raw) };
}
function find(res, k) { return res.results.filter(function (r) { return r.checkKey === k; })[0]; }

// 1. Combined setpoint inside the band: evaluated, deadband and split checks are NA (not missing).
let r = sb.emComputeSetpointCompliance(row('Unit-A', 'fcu', { 'Temperature Setpoint': '72.0' }), {}, {});
eq(r.hasAnyData, true, 'combined 72F -> hasAnyData');
eq(find(r, 'occSingle').status, 'PASS', 'combined 72F -> occSingle PASS');
eq(find(r, 'occHeat').status, 'NA', 'combined -> occHeat NA');
eq(find(r, 'occCool').status, 'NA', 'combined -> occCool NA');
eq(find(r, 'deadband').status, 'NA', 'combined -> deadband NA (deadband 0 is not a violation)');
// 2. Outside the band: deviation.
r = sb.emComputeSetpointCompliance(row('Unit-B', 'fcu', { 'Space Temperature Set Point': '60' }), {}, {});
eq(find(r, 'occSingle').status, 'DEVIATION', 'combined 60F -> DEVIATION');
// 3. Combined point present but blank: not evaluated, still not "missing heat/cool".
r = sb.emComputeSetpointCompliance(row('Unit-C', 'fcu', { 'Temperature Setpoint': '' }), {}, {});
eq(r.hasAnyData, false, 'blank combined -> no data');
// 4. Split heat/cool present: old behavior, no occSingle.
r = sb.emComputeSetpointCompliance(row('Unit-D', 'vav', { 'Occupied Cooling Setpoint': '74', 'Occupied Heating Setpoint': '70' }), {}, {});
eq(find(r, 'occSingle'), undefined, 'split setpoints -> no occSingle');
eq(find(r, 'occCool').status, 'PASS', 'split cool 74 -> PASS');
// 5. Names with extra words are NOT a combined setpoint.
r = sb.emComputeSetpointCompliance(row('Unit-E', 'fcu', { 'Temperature Set Point Feedback': '70', 'Return Temperature Set Point To Device': '70' }), {}, {});
eq(find(r, 'occSingle'), undefined, 'feedback/to-device names are not combined');
// 6. Coverage: VAV with combined setpoint only -> coolSP/htgSP are N/A, not missing; one point counted once.
const vav = row('Unit-F', 'vav', { 'Zone Temp': '71', 'Temperature Setpoint': '72' });
const c = sb.emComputeCompliance(vav, {});
const missKeys = c.missingPoints.map(function (m) { return m.categoryKey; });
eq(missKeys.indexOf('coolSP') === -1 && missKeys.indexOf('htgSP') === -1, true, 'combined only -> coolSP/htgSP not missing');
eq(c.naPoints.filter(function (n) { return n.reason === 'single combined setpoint'; }).length, 2, 'combined only -> 2 N/A entries');
// 7. Combined point must not also satisfy zoneTemp (one point = one point).
const fcu = row('Unit-G', 'fcu', { 'Space Temperature Set Point': '70' });
const cf = sb.emComputeCompliance(fcu, {});
eq(cf.coveredPoints.filter(function (p) { return p.categoryKey === 'zoneTemp'; }).length, 0, 'combined setpoint does not count as zone temp sensor');
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
