// tools/test-em-round1-rules.js: Detailed audit round 1 rules in the Equipment Matrix (2026-11-14). SYNTHETIC names only.
//   1. DX cooling evidence: a unit with a compressor point and no chilled water valve point has the cooling valve N/A (reason: DX).
//   2. Gas or electric stage heating evidence: the heating valve is N/A. A valve point the unit has still counts as matched.
//   3. A unit with no DX or stage evidence still lacks the valve (no silent N/A).
//   4. An Exhaust Air Damper point is NOT the return air damper; a Return Damper point is.
//   5. A unit that returns "?" for nearly every point is offline (emIsUnitOffline); a unit with real readings is not.
// Run: node tools/test-em-round1-rules.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
const sandbox = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => fb,
  sset: () => Promise.resolve(),
  DB: { get: (k, fb) => fb, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
  _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'app/equipment-matrix.js' });
sandbox.window._emActivePid = 'synthetic';

function mkRow(id, name, category, pointsRaw, subtype) {
  return { id, building: 'Synthetic Hall', location: '', equipName: name, equipType: name, category, subtype: subtype || 'vav', points: Object.assign({}, pointsRaw), pointsRaw: pointsRaw || {}, checks: {}, schema: 2 };
}
const base = { 'Supply Air Temperature': '55', 'Supply Fan Status': 'On', 'Mixed Air Temperature': '60' };
const status = (row, key) => {
  const c = sandbox.emComputeCompliance(row, {}, []);
  if (c.coveredPoints.some((p) => p.categoryKey === key)) return 'covered';
  const na = c.naPoints.find((p) => p.categoryKey === key);
  if (na) return 'na:' + na.reason;
  return c.missingPoints.some((p) => p.categoryKey === key) ? 'missing' : 'absent';
};

const dx = mkRow('a1', 'AHU-1', 'ahu', Object.assign({ 'Compressor 1 Status': 'On', 'Cooling Stage 1': 'On' }, base));
check(/^na:.*DX/.test(status(dx, 'clgValve')), '1. compressor points: cooling coil valve is N/A (' + status(dx, 'clgValve') + ')');
const dxRtu = mkRow('r1', 'RTU-1', 'rtu', Object.assign({ 'Liquid Line Solenoid': 'On' }, base));
check(/^na:.*DX/.test(status(dxRtu, 'clgValve')), '1b. liquid line solenoid on an RTU: cooling coil valve is N/A (' + status(dxRtu, 'clgValve') + ')');
const gas = mkRow('a2', 'AHU-2', 'ahu', Object.assign({ 'Heating Stage 1': 'On', 'Heating Stage 2': 'Off' }, base));
check(/^na:.*(gas|electric)/.test(status(gas, 'htgValve')), '2. stage heating points: heating coil valve is N/A (' + status(gas, 'htgValve') + ')');
const withValve = mkRow('a3', 'AHU-3', 'ahu', Object.assign({ 'Compressor 1 Status': 'On', 'Cooling Coil Valve': '40' }, base));
check(status(withValve, 'clgValve') === 'covered', '2b. a valve point the unit has still counts as matched (' + status(withValve, 'clgValve') + ')');
const plain = mkRow('a4', 'AHU-4', 'ahu', Object.assign({}, base));
check(status(plain, 'clgValve') === 'missing' && status(plain, 'htgValve') === 'missing', '3. no DX or stage evidence: both valves stay missing (' + status(plain, 'clgValve') + ', ' + status(plain, 'htgValve') + ')');

const exh = mkRow('a5', 'AHU-5', 'ahu', Object.assign({ 'Exhaust Air Damper': '50', 'Economizer Damper': '30' }, base));
check(status(exh, 'raDampCmd') !== 'covered', '4. Exhaust Air Damper is not the return air damper (' + status(exh, 'raDampCmd') + ')');
const ret = mkRow('a6', 'AHU-6', 'ahu', Object.assign({ 'Roof Return Damper': '50', 'Exhaust Air Damper': '50', 'Economizer Damper': '30' }, base));
check(status(ret, 'raDampCmd') === 'covered', '4b. a Return Damper point is the return air damper (' + status(ret, 'raDampCmd') + ')');

const offPts = {};
for (let i = 1; i <= 14; i++) offPts['Point ' + i] = '?';
offPts['Flow Input'] = '570.0 cfm';
check(sandbox.emIsUnitOffline(mkRow('f1', 'FPB-1', 'fpb', offPts)) === true, '5. 14 "?" points and one fixed input: the unit is offline');
const live = Object.assign({}, offPts, { 'Zone Temp': '71.2 F', 'Air Flow': '120 cfm', 'Damper Position': '40 %', 'Fan': 'On', 'Heating': '0 %', 'Occupied': 'On', 'Mode': 'Cool', 'Setpoint A': '72', 'Setpoint B': '70', 'Setpoint C': '75', 'Setpoint D': '68', 'Setpoint E': '77', 'Setpoint F': '60', 'Setpoint G': '85', 'Setpoint H': '65' });
check(sandbox.emIsUnitOffline(mkRow('f2', 'FPB-2', 'fpb', live)) === false, '5b. a unit with real readings is not offline');
check(sandbox.emIsUnitOffline(mkRow('f3', 'FPB-3', 'fpb', { A: '?', B: '?' })) === false, '5c. fewer than 10 "?" points is not offline');
process.exit(failed ? 1 : 0);
