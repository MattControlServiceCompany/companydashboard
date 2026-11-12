// tools/test-em-vav-point-rule.js: the VAV point rule (emVerifyTypeByPoints rule 8) must not type an air handler
// as a VAV terminal (item 143b0aa2). Run: node tools/test-em-vav-point-rule.js
// Loads the real app/equipment-matrix.js into a vm sandbox. SYNTHETIC fixture only.
// Cause: a combined AHU/ERV unit has airflow (cfm), a damper position and Air Source Mode, so rule 8 fired;
// a VAV terminal never has its own supply fan or VFD.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log('PASS ' + msg);
  } else {
    failed++;
    console.log('FAIL ' + msg);
  }
}

const sandbox = {
  console,
  window: {},
  document: undefined,
  sget: (k, fb) => fb,
  sset: () => Promise.resolve(),
  DB: { get() {}, set() {}, isReady: () => true },
  getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }),
  showToast() {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8'), sandbox, { filename: 'app/equipment-matrix.js' });
const verify = sandbox.emVerifyTypeByPoints;

const ahuErv = verify({
  category: 'erv',
  equipName: 'SYN AHU-9 & ERV-9',
  pointValues: {
    'Air Source Mode': '1',
    'ERV Outside Air CFM': '800',
    'Supply Fan VFD Speed': '60 %',
    'ERV Supply Fan Status': 'On',
    'EF Isolation Damper Position': '100 %',
    'Supply Duct Static Pressure': '1.1 inWC',
  },
});
check(ahuErv.category !== 'vav', 'air handler with supply fan, VFD, cfm, damper position and Air Source Mode is not a VAV terminal (got ' + ahuErv.category + ', rule ' + ahuErv.rule + ')');

const box = verify({
  category: 'vav',
  equipName: 'SYN VAV-1',
  pointValues: { 'Air Flow': '300', 'Damper Position': '50 %', 'Air Source Mode': '1', 'Zone Temp': '72' },
});
check(box.category === 'vav' && box.rule === '8', 'a plain VAV terminal is still typed VAV by rule 8 (got ' + box.category + ', rule ' + box.rule + ')');

// ── 848ba9b2 defect 2: a lighting controller named "Rooftop" is not an RTU (point evidence wins) ──
const lightingRoof = verify({
  category: 'rtu',
  equipName: 'SYN Mechanical Rooftop Space 201',
  pointValues: {
    Mode: '1', PanelXXX: '', Schedule: 'On', relayXXX: '', circuitXXX: '',
    'Load 1-3 FB': '0', 'Load 1-3 CMD': '0', 'Digital Inputs': '', 'COMM / Outside PC': '',
    'Exterior Photocell': 'Off', 'Lighting Panel Alarm': 'Normal',
  },
});
check(lightingRoof.category === 'lighting', 'lighting-only unit with a "Rooftop" name is lighting, not rtu (got ' + lightingRoof.category + ', rule ' + lightingRoof.rule + ')');
const realRtu = verify({
  category: 'rtu',
  equipName: 'SYN Rooftop Unit 1',
  pointValues: { 'Supply Fan Status': 'On', 'Supply Air Temp': '55', 'Zone Temp': '72', 'Cooling Stage 1': 'Off' },
});
check(realRtu.category === 'rtu', 'a real rooftop unit with supply fan and SAT points stays rtu (got ' + realRtu.category + ')');
const realRtuLoadPt = verify({
  category: 'rtu',
  equipName: 'SYN Rooftop Unit 2',
  pointValues: { 'Supply Fan Status': 'On', 'Supply Air Temp': '55', 'Load 1-3 CMD': '0' },
});
check(realRtuLoadPt.category === 'rtu', 'a rooftop unit with a supply fan and one load point stays rtu (got ' + realRtuLoadPt.category + ')');

// ── 848ba9b2 defect 3: emLoadMatrix Pass A must not turn "EF-n | VAV x" into a VAV ──
function loadRows(rows) {
  let n = 0;
  sandbox.sget = (k, fb) => (/^en_eqmatrix_/.test(k) ? { rows, importedAt: null, buildings: [] } : fb);
  sandbox.window.DB = undefined;
  return sandbox.emLoadMatrix('syn' + n++).rows;
}
const efPts = { Schedule: 'On', 'Exhaust Fan Enable': 'On', 'System Run Control': 'On' };
const out = loadRows([
  { equipName: 'SYN Bathroom EF-3 | VAV 1-10', equipType: 'SYN Bathroom EF-3 | VAV 1-10', category: 'ef', points: efPts },
  { equipName: 'SYN VAV 1-10', equipType: 'SYN VAV 1-10', category: 'vav', points: { 'Zone Temp': '72' } },
]);
check(out[0].category === 'ef', 'stored ef "Bathroom EF-3 | VAV 1-10" stays ef after load (got ' + out[0].category + ')');
check(out[1].category === 'vav', '"VAV 1-10" stays vav (got ' + out[1].category + ')');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
