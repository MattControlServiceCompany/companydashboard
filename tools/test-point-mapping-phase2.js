// tools/test-point-mapping-phase2.js: point mapping phase 2 (2026-11-13). SYNTHETIC point names only.
// A1 panel label helper, A2 six non-audit keys, A3 Air Source Duct Static, A4 override/test/min-CFM/PID names,
// A5 optional dat and zoneTemp, A6 column cats widening.
// Run: node tools/test-point-mapping-phase2.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(c, m) { if (c) { passed++; console.log('PASS ' + m); } else { failed++; console.log('FAIL ' + m); } }
const sandbox = {
  console, window: {}, document: undefined, sget: (k, fb) => fb, sset: () => Promise.resolve(),
  DB: { get() {}, set() {}, isReady: () => true }, getUDBldgs: () => [],
  getProjSavingsData: () => ({ measures: [], blRates: {}, basSetpoint: {} }), showToast() {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/equipment-matrix.js'), 'utf8'), sandbox, { filename: 'app/equipment-matrix.js' });
const norm = (n, e) => sandbox.emNormalizePoint(n, e);
const key = (n, e) => { const m = norm(n, e); return m ? m.categoryKey : null; };
const col = (n, e) => sandbox.emMapPointToColumn(n, undefined, e);

// A2: six new non-audit keys
check(key('Minimum CFM Heating', 'vav') === 'zoneMinAirflowSP', 'A4: "Minimum CFM Heating" -> zoneMinAirflowSP');
check(!norm('Minimum CFM Heating', 'vav').auditRelevant, 'A2: zoneMinAirflowSP is not scored');
check(key('Write CFM Minimum', 'vav') === 'zoneMinAirflowSP', 'A4: "Write CFM Minimum" -> zoneMinAirflowSP');
check(key('Associated Zone CFM Min', 'fpb') === 'zoneMinAirflowSP', 'A4: "Associated Zone CFM Min" -> zoneMinAirflowSP');

// A3: Air Source Duct Static is not the AHU duct static
check(key('Air Source Duct Static', 'vav') !== 'dsp', 'A3: Air Source Duct Static is not dsp (vav)');
check(col('Air Source Duct Static', 'vav') !== 'ductStaticPressure', 'A3: Air Source Duct Static is not column ductStaticPressure');
check(col('Air Source Duct Static', 'vav') === 'airSourceDuctStatic', 'A6: Air Source Duct Static -> column airSourceDuctStatic');

// A4: names that are not the thing they looked like
check(key('Testing Airflow Percentage', 'vav') !== 'discFlow', 'A4: Testing Airflow Percentage is not discFlow');
check(key('Zone Temp / Override Time Remaining', 'vav') !== 'zoneTemp', 'A4: override timer is not zoneTemp');

const cats = (e) => sandbox.EM_POINT_CATEGORIES[e];
const find = (e, k) => (cats(e) || []).find((c) => c.key === k);
// A5 (Manager 2026-11-13): NOT optional audit keys. Non-audit keys, no price entry, not scored.
check(key('Supply Temperature', 'ddvav') === 'ddvavSupplyTemp', 'A5: ddvav "Supply Temperature" -> ddvavSupplyTemp');
check(!norm('Supply Temperature', 'ddvav').auditRelevant, 'A5: ddvavSupplyTemp is not scored');
check(key('Deck Supply Temperature', 'ddvav') !== 'ddvavSupplyTemp', 'A5: ddvav deck name is not ddvavSupplyTemp');
['ahu', 'rtu'].forEach((e) => {
  check(key('Zone Temp', e) === 'unitZoneTemp', 'A5: ' + e + ' "Zone Temp" -> unitZoneTemp');
  check(key('Virtual Zone Temperature', e) === 'unitZoneTemp', 'A5: ' + e + ' "Virtual Zone Temperature" -> unitZoneTemp');
  check(!norm('Zone Temp', e).auditRelevant, 'A5: ' + e + ' unitZoneTemp is not scored');
  check(key('Zone Temp Setpoint', e) !== 'unitZoneTemp', 'A5: ' + e + ' "Zone Temp Setpoint" is not unitZoneTemp');
  check(!find(e, 'zoneTemp'), 'A5: ' + e + ' has no audit zoneTemp key');
});
check(!find('ddvav', 'dat'), 'A5: ddvav has no audit dat key');
// A4 (Manager 2026-11-13): PID loop setpoint on EVERY type
['vav', 'fpb', 'ddvav', 'fcu', 'rtu', 'ahu'].forEach((e) => {
  check(key('Cooling Set Point BACnet PID / Setpoint', e) === 'pidLoopSetpoint', 'A4: ' + e + ' PID loop setpoint -> pidLoopSetpoint');
  check(col('Cooling Set Point BACnet PID / Setpoint', e) == null, 'A4: ' + e + ' PID loop setpoint has no column');
  // A3 read path: category-less column mapper, every zone type
  check(col('Air Source Duct Static', e) !== 'ductStaticPressure', 'A3: ' + e + ' Air Source Duct Static not column ductStaticPressure');
});
['Air Source Duct Static', 'Air Source Cold Deck Duct Static', 'Air Source Hot Deck Duct Static'].forEach((n) => {
  ['vav', 'fpb', 'ddvav', 'fcu'].forEach((e) => check(key(n, e) === 'airSourceDuctStatic', 'A3: ' + e + ' "' + n + '" -> airSourceDuctStatic'));
  check(sandbox.emMapPointToColumn(n) === 'airSourceDuctStatic', 'A3: category-less read path "' + n + '" -> column airSourceDuctStatic');
});
check(key('Economizer BACnet PID / Setpoint', 'rtu') === 'econSp', 'A4: rtu Economizer PID keeps econSp');

// A6: widening keeps the same meaning
check(col('Effective Cooling Setpoint', 'fcu') === 'effectiveCoolSetpoint', 'A6: fcu effective cool setpoint column');
check(col('Zone CO2', 'rtu') == null || col('Zone CO2', 'rtu') !== 'zoneCO2', 'A6: zoneCO2 column not widened to rtu (Source 3 co2 risk)');

// ef/other Schedule keeps the audit key
check(key('Schedule', 'ef') === 'schedule', 'ef: "Schedule" keeps audit key schedule');
check(key('Schedule', 'other') === 'schedule', 'other: "Schedule" keeps audit key schedule');

// A1: shared panel helper
check(typeof sandbox.emPointPanelInfo === 'function', 'A1: emPointPanelInfo exists');
const pi = sandbox.emPointPanelInfo('Minimum CFM Heating', 'vav');
check(pi && pi.kind === 'category' && pi.notScored === true && !!pi.label, 'A1: zoneMinAirflowSP shows category label plus notScored');
const po = sandbox.emPointPanelInfo('zzz unknown synthetic', 'vav');
check(po && po.kind === 'other', 'A1: unknown name stays Other');
const pd = sandbox.emPointPanelInfo('Air Source Duct Static', 'vav');
check(pd && pd.kind === 'column' && pd.notScored === true, 'A1: a column with no audit key (Air Source Duct Static) is not scored, so the panel shows it grey');
const pz = sandbox.emPointPanelInfo('Zone Temperature', 'vav');
check(pz && pz.kind === 'column' && pz.notScored === false, 'A1: a scored column (Zone Temperature on vav) is scored, so the panel shows it blue');
const pt = sandbox.emPointPanelInfo('Supply Temperature', 'vav');
check(pt && pt.notScored === false, 'A1: an audit key with no column (Supply Temperature = dat on vav) is scored');

// New keys have no price entry (text check)
const price = fs.readFileSync(path.join(REPO, 'app/pricing-estimator.js'), 'utf8');
['zoneTempAlarm', 'vvtAirRequest', 'airSourceDuctStatic', 'scheduleObject', 'zoneMinAirflowSP', 'valveFlowAdjust', 'unitZoneTemp', 'ddvavSupplyTemp', 'pidLoopSetpoint'].forEach((k) => {
  check(!new RegExp('\\b' + k + '\\b').test(price), 'price: ' + k + ' has no pricing-estimator.js entry');
  const inAny = Object.keys(sandbox.EM_POINT_CATEGORIES).some((e) => (cats(e) || []).some((c) => c.key === k && c.auditRelevant === false)) ||
    (sandbox.EM_NAMED_EXCLUSIONS || []).some((c) => c.key === k);
  check(inAny || k === 'airSourceDuctStatic', 'A2: ' + k + ' is defined as non-audit');
});
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
