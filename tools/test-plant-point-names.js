// tools/test-plant-point-names.js - plant point names (2026-11-14 review fix). SYNTHETIC data only.
//   1. "Chilled Water Loop Return/Supply Temperature" are the chilled water return/supply temperature points.
//   2. A hot water plant point named only "Heating Set Point" is the hot water supply setpoint.
// Run: node tools/test-plant-point-names.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}
const em = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => fb,
  sset: () => Promise.resolve(),
  DB: { get: (k, fb) => fb, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
  _escHtml: (s) => String(s),
};
vm.createContext(em);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8'), em, { filename: 'app/equipment-matrix.js' });
em.window._emActivePid = 'synthetic';
const mkRow = (id, name, category, pointsRaw) => ({ id, building: 'Synthetic Hall', location: '', equipName: name, equipType: name, category, subtype: '', points: Object.assign({}, pointsRaw), pointsRaw, checks: {}, schema: 2 });
const covered = (row) => em.emComputeCompliance(row, {}, []).coveredPoints.map((p) => p.categoryKey);

const chw = covered(mkRow('c1', 'Chilled Water System', 'chwp', { 'Chilled Water Loop Return Temperature': '57.3 F', 'Chilled Water Loop Supply Temperature': '57.0 F' }));
check(chw.includes('chwrt'), '1. "Chilled Water Loop Return Temperature" is the chilled water return temperature');
check(chw.includes('chwst'), '1. "Chilled Water Loop Supply Temperature" is the chilled water supply temperature');
const hw = covered(mkRow('h1', 'Heating Water System', 'hwp', { 'Heating Set Point': '120.0 F', 'Hot Water Supply Temperature': '118 F' }));
check(hw.includes('hwSetpoint'), '2. a hot water plant "Heating Set Point" is the hot water supply setpoint');
const hw2 = covered(mkRow('h2', 'Heating Water System', 'hwp', { 'Heating Set Point BACnet PID': '0.0 %', 'Hot Water Supply Temperature': '118 F' }));
check(!hw2.includes('hwSetpoint'), '2. a longer name ("Heating Set Point BACnet PID") is not the setpoint');

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
