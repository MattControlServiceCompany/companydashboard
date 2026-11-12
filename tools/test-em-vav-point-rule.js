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
let loadSeq = 0;
function loadRows(rows) {
  sandbox.sget = (k, fb) => (/^en_eqmatrix_/.test(k) ? { rows, importedAt: null, buildings: [] } : fb);
  sandbox.window.DB = undefined;
  return sandbox.emLoadMatrix('syn' + loadSeq++).rows;
}
const efPts = { Schedule: 'On', 'Exhaust Fan Enable': 'On', 'System Run Control': 'On' };
const out = loadRows([
  { equipName: 'SYN Bathroom EF-3 | VAV 1-10', equipType: 'SYN Bathroom EF-3 | VAV 1-10', category: 'ef', points: efPts },
  { equipName: 'SYN VAV 1-10', equipType: 'SYN VAV 1-10', category: 'vav', points: { 'Zone Temp': '72' } },
]);
check(out[0].category === 'ef', 'stored ef "Bathroom EF-3 | VAV 1-10" stays ef after load (got ' + out[0].category + ')');
check(out[1].category === 'vav', '"VAV 1-10" stays vav (got ' + out[1].category + ')');

// ── A36-3 (item c8e86985): a single-zone ahu/rtu is scored on the single-zone sequence set ──
function seqFor(row) {
  const comp = sandbox.emComputeCompliance(row, {});
  return { comp, seq: sandbox.emComputeSequenceReadiness(row, comp) };
}
const szPts = {
  'Supply Fan Status': 'On', 'Supply Fan Enable': 'On', 'Cooling Stage 1': 'Off', 'Heating Stage 1': 'Off',
  'Discharge Air Temp': '60', 'Zone Temp': '72', 'Outside Air Temp': '50',
};
const szBase = { category: 'rtu', subtype: 'sz', equipName: 'SYN RTU-1', equipType: 'SYN RTU-1' };
const szA = seqFor(Object.assign({ id: 'syn-sz-a', points: szPts }, szBase));
const missA = szA.comp.missingPoints.map((p) => p.categoryKey);
const naA = szA.comp.naPoints.map((p) => p.categoryKey);
check(szA.seq.ahu_sat_reset.status !== 'na', 'sz rtu: SAT reset applies (got ' + szA.seq.ahu_sat_reset.status + ')');
check(szA.seq.ahu_dsp_reset.status === 'na', 'sz rtu: duct static pressure reset is na (got ' + szA.seq.ahu_dsp_reset.status + ')');
check(missA.indexOf('dsp') === -1 && naA.indexOf('dsp') !== -1, 'sz rtu: duct static pressure point is not required');
check(missA.indexOf('clgValve') === -1 && missA.indexOf('htgValve') === -1, 'sz rtu with stage points: coil valves are not required (missing: ' + missA.join(',') + ')');
check(szA.seq.ahu_economizer.status === 'na' && szA.seq.ahu_min_oa.status === 'na', 'sz rtu without OA damper: economizer and minimum OA are na');
check(szA.seq.ahu_freeze_prot.status === 'na' && szA.seq.demandCtrl.status === 'na', 'sz rtu without freeze or mixed-air or OA damper points: freeze and demand control are na');
check(missA.indexOf('oaDampCmd') === -1 && missA.indexOf('freezeStat') === -1 && missA.indexOf('mat') === -1 && missA.indexOf('co2') === -1, 'sz rtu without those parts: damper, freeze, mixed-air and CO2 points are not required');
const szNoStage = seqFor(Object.assign({ id: 'syn-sz-b', points: { 'Supply Fan Status': 'On', 'Zone Temp': '72' } }, szBase));
check(szNoStage.comp.missingPoints.map((p) => p.categoryKey).indexOf('clgValve') !== -1, 'sz rtu with NO stage points: cooling coil valve is still required');
const szOa = seqFor(Object.assign({ id: 'syn-sz-c', points: Object.assign({ 'Outside Air Damper Command': '20' }, szPts) }, szBase));
check(szOa.seq.ahu_economizer.status !== 'na' && szOa.seq.ahu_min_oa.status !== 'na', 'sz rtu WITH OA damper: economizer and minimum OA apply (got ' + szOa.seq.ahu_economizer.status + ', ' + szOa.seq.ahu_min_oa.status + ')');
check(szOa.seq.ahu_dsp_reset.status === 'na', 'sz rtu WITH OA damper: duct static pressure reset is still na');
const szFreeze = seqFor(Object.assign({ id: 'syn-sz-d', points: Object.assign({ 'Freeze Stat': 'Normal' }, szPts) }, szBase));
check(szFreeze.seq.ahu_freeze_prot.status !== 'na', 'sz rtu WITH freeze stat: freeze protection applies (got ' + szFreeze.seq.ahu_freeze_prot.status + ')');
const mzPts = Object.assign({ 'Duct Static Pressure': '1.1', 'Supply Fan Speed': '60', 'Outside Air Damper Command': '20' }, szPts);
const mz = seqFor({ id: 'syn-mz-a', category: 'ahu', subtype: 'vav', equipName: 'SYN AHU-1', equipType: 'SYN AHU-1', points: mzPts });
const mzNoSub = seqFor({ id: 'syn-mz-b', category: 'ahu', subtype: '', equipName: 'SYN AHU-2', equipType: 'SYN AHU-2', points: { 'Supply Fan Status': 'On' } });
const SIX = ['ahu_sat_reset', 'ahu_dsp_reset', 'ahu_economizer', 'ahu_freeze_prot', 'ahu_min_oa', 'demandCtrl'];
check(SIX.every((k) => mz.seq[k].status !== 'na') && mz.seq.ahu_rf_control.status === 'na', 'multi-zone ahu: the same 6 sequences apply as before');
check(SIX.every((k) => mzNoSub.seq[k].status !== 'na'), 'ahu with no subtype: the same 6 sequences apply as before');
check(mz.comp.missingPoints.map((p) => p.categoryKey).indexOf('clgValve') !== -1 && mz.comp.naPoints.map((p) => p.categoryKey).indexOf('dsp') === -1, 'multi-zone ahu: coil valves still required, duct static pressure not na');

// ── Task 2: "VRF Outdoor Unit" stored as fcu is vrf; a VRF indoor unit stays fcu ──
const vrfRows = loadRows([
  { equipName: 'SYN VRF Outdoor Unit', equipType: 'SYN VRF Outdoor Unit', category: 'fcu', points: { 'S1 EV Position 1': '0', 'Gas Pipe Temperature': '40', 'Fan Speed': '1' } },
  { equipName: 'SYN Room 3| VRF-03', equipType: 'SYN Room 3| VRF-03', category: 'fcu', points: { 'Gas Pipe Temperature': '40', 'Fan Speed': '1', 'Zone Temp': '72' } },
]);
check(vrfRows[0].category === 'vrf', 'stored fcu "VRF Outdoor Unit" resolves to vrf on load (got ' + vrfRows[0].category + ')');
check(vrfRows[1].category === 'fcu', 'VRF indoor unit stays fcu (got ' + vrfRows[1].category + ')');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
