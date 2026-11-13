// tools/test-point-mapping-fixes.js: compliance point mapper fixes (Matt, 2026-11-13).
// Seven rules, each with a positive case (the real point still maps) and a negative case (the wrong point no longer maps):
//   1. co2: an alarm, limit, setpoint, max/min, ratio or request name is not a CO2 sensor.
//   2. tier 2b alias match: a "Low/High ..." alarm-limit name does not map to dat or zoneTemp. A real DAT / zone temp does.
//   3. "Heating Valve Flow Adjust" is not the reheat valve command (vav, fpb).
//   4. "Cooling/Heating Setpoint Adjust" is the offset (coolAdj/htgAdj), not the setpoint (coolSP/htgSP).
//   5. "Exhaust Fan Enable" / "Fan Enable" is a command, not fan status (ef, fcu).
//   6. fpb bare "Fan" is the terminal fan command (termFanEnable). Other equipment keeps bareFan.
//   7. fpb "Zone Damper" is the damper command (dampCmd), the same as vav.
// Run: node tools/test-point-mapping-fixes.js
// Loads the real app/equipment-matrix.js into a vm sandbox. SYNTHETIC point names only.
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

function key(name, equip) {
  const m = sandbox.emNormalizePoint(name, equip);
  return m ? m.categoryKey : null;
}
function audit(name, equip) {
  const m = sandbox.emNormalizePoint(name, equip);
  return !!(m && m.auditRelevant);
}
function maps(name, equip, expectKey) {
  check(key(name, equip) === expectKey && audit(name, equip), equip + ': "' + name + '" maps to ' + expectKey + ' (got ' + key(name, equip) + ')');
}
function notMaps(name, equip, notKey) {
  check(key(name, equip) !== notKey, equip + ': "' + name + '" does not map to ' + notKey + ' (got ' + key(name, equip) + ')');
}

// ---- 1. co2 ----
['ahu', 'rtu', 'vav', 'fpb', 'ddvav', 'fcu'].forEach((eq) => {
  ['Zone CO2', 'Return Air CO2', 'Space CO2 Sensor', 'Zone Carbon Dioxide'].forEach((n) => {
    if (eq !== 'ahu' && eq !== 'rtu' && /Return/.test(n)) return;
    maps(n, eq, 'co2');
  });
  [
    'High Carbon Dioxide Level',
    'Low Carbon Dioxide Level',
    'CO2 Maximum 1-4',
    'CO2 Max',
    'CO2 High Level',
    'Occupied CO2 Setpoint',
    'zoneCO2Setpoint',
    'Primary Air Source CO2 Ratio Request',
    'Zone CO2 Alarm',
    'CO2 Limit',
  ].forEach((n) => notMaps(n, eq, 'co2'));
});
maps('Return Air Carbon Dioxide Level', 'ahu', 'co2'); // "Level" alone is a real sensor name

// ---- 2. tier 2b alarm / limit veto ----
['vav', 'fpb'].forEach((eq) => {
  maps('Supply Temperature', eq, 'dat');
  maps('Zone Temperature', eq, 'zoneTemp');
  notMaps('Low Supply Air Temperature', eq, 'dat');
  notMaps('High Supply Air Temperature', eq, 'dat');
  notMaps('Low Zone Temperature', eq, 'zoneTemp');
  notMaps('High Zone Temperature', eq, 'zoneTemp');
});
['ddvav', 'fcu', 'zone'].forEach((eq) => {
  maps('Zone Temperature', eq, 'zoneTemp');
  notMaps('Low Zone Temperature', eq, 'zoneTemp');
  notMaps('High Zone Temperature', eq, 'zoneTemp');
});
// a category about limits keeps its own limit names (the veto only blocks categories with no such word)
maps('Low Limit Safety', 'ahu', 'freezeStat');
// a fan stage name is not an alarm limit
maps('Supply Fan High Enable', 'ahu', 'sfEnable');

// ---- 3. Heating Valve Flow Adjust ----
['vav', 'fpb'].forEach((eq) => {
  maps('Heating Valve', eq, 'reheatValve');
  maps('Reheat Valve', eq, 'reheatValve');
  notMaps('Heating Valve Flow Adjust', eq, 'reheatValve');
});

// ---- 4. Setpoint Adjust ----
['vav', 'fpb', 'ddvav'].forEach((eq) => {
  maps('Cooling Setpoint', eq, 'coolSP');
  maps('Heating Setpoint', eq, 'htgSP');
  notMaps('Cooling Setpoint Adjust', eq, 'coolSP');
  notMaps('Heating Setpoint Adjust', eq, 'htgSP');
  notMaps('Setpoint / Cooling Setpoint Adjust', eq, 'coolSP');
  notMaps('Setpoint / Heating Setpoint Adjust', eq, 'htgSP');
  maps('Cooling Setpoint Adjust', eq, 'coolAdj');
  maps('Heating Setpoint Adjust', eq, 'htgAdj');
});
['fcu', 'zone'].forEach((eq) => {
  maps('Cooling Setpoint', eq, 'coolSP');
  notMaps('Cooling Setpoint Adjust', eq, 'coolSP');
  notMaps('Heating Setpoint Adjust', eq, 'htgSP');
});

// ---- 5. Fan Enable is not fan status ----
['Exhaust Fan Enable', 'Fan Enable', 'EF Enable'].forEach((n) => notMaps(n, 'ef', 'fanStatus'));
['Exhaust Fan Status', 'Fan Status'].forEach((n) => maps(n, 'ef', 'fanStatus'));
notMaps('Fan Enable', 'fcu', 'fanStatus');
notMaps('Supply Fan Enable', 'fcu', 'fanStatus');
maps('Fan Status', 'fcu', 'fanStatus');

// ---- 6. fpb bare Fan ----
maps('Fan', 'fpb', 'termFanEnable');
['vav', 'ahu', 'ddvav', 'fcu'].forEach((eq) => check(key('Fan', eq) === 'bareFan', eq + ': bare "Fan" stays bareFan (got ' + key('Fan', eq) + ')'));
check(key('Fan', undefined) === 'bareFan', 'no equipment category: bare "Fan" stays bareFan');
maps('Terminal Fan Enable', 'fpb', 'termFanEnable');

// ---- 7. fpb Zone Damper ----
maps('Zone Damper', 'fpb', 'dampCmd');
maps('Zone Damper', 'vav', 'dampCmd');
maps('Primary Damper', 'fpb', 'dampCmd');
check(key('Zone Damper', 'ddvav') !== 'dampCmd', 'ddvav: "Zone Damper" is not changed by this fix (got ' + key('Zone Damper', 'ddvav') + ')');

// ---- unit level: a synthetic unit with only the wrong names shows the key missing; with the real name it is covered ----
function unit(category, names, id) {
  const pointsRaw = {};
  names.forEach((n) => (pointsRaw[n] = '1'));
  return { id: id, category: category, points: pointsRaw, pointsRaw: pointsRaw };
}
function state(category, names, k) {
  const c = sandbox.emComputeCompliance(unit(category, names, 'u-' + category + '-' + names.join('|') + '-' + k), {}, null);
  if (c.coveredPoints.some((p) => p.categoryKey === k)) return 'covered';
  if (c.missingPoints.some((p) => p.categoryKey === k)) return 'missing';
  return 'other';
}
check(state('ahu', ['CO2 Maximum 1', 'High Carbon Dioxide Level'], 'co2') === 'missing', 'unit ahu: only CO2 limit and alarm names -> co2 missing');
check(state('ahu', ['CO2 Maximum 1', 'Return Air CO2'], 'co2') === 'covered', 'unit ahu: limit name plus a real Return Air CO2 -> co2 covered');
check(state('vav', ['Low Zone Temperature', 'High Zone Temperature'], 'zoneTemp') === 'missing', 'unit vav: only zone temp alarm limits -> zoneTemp missing');
check(state('vav', ['Low Zone Temperature', 'Zone Temperature'], 'zoneTemp') === 'covered', 'unit vav: alarm limit plus a real Zone Temperature -> zoneTemp covered');
check(state('fpb', ['Low Supply Air Temperature', 'Supply Temperature'], 'dat') === 'covered', 'unit fpb: alarm limit plus a real Supply Temperature -> dat covered');
check(state('fpb', ['Low Supply Air Temperature'], 'dat') === 'missing', 'unit fpb: only a supply temp alarm limit -> dat missing');
check(state('vav', ['Setpoint / Cooling Setpoint Adjust'], 'coolSP') === 'missing', 'unit vav: only a cooling setpoint adjust -> coolSP missing');
check(state('vav', ['Setpoint / Cooling Setpoint Adjust', 'Setpoint / Cooling Occupied Setpoint'], 'coolSP') === 'covered', 'unit vav: adjust plus a real cooling setpoint -> coolSP covered');
check(state('fpb', ['Fan'], 'termFanEnable') === 'covered', 'unit fpb: bare Fan -> termFanEnable covered');
check(state('fpb', ['Zone Damper'], 'dampCmd') === 'covered', 'unit fpb: Zone Damper -> dampCmd covered');
check(state('ef', ['Exhaust Fan Enable'], 'fanStatus') === 'missing', 'unit ef: only Exhaust Fan Enable -> fanStatus missing');
check(state('ef', ['Exhaust Fan Enable', 'Exhaust Fan Status'], 'fanStatus') === 'covered', 'unit ef: enable plus a real status -> fanStatus covered');
// ---- 8. air handler alarm limits (Manager addition 2026-11-13): sat, rat, mat, dsp; fcu hwValve adjust ----
['ahu', 'rtu', 'doas'].forEach((eq) => {
  notMaps('Low Supply Air Temperature', eq, 'sat');
  notMaps('High Supply Air Static Pressure', eq, 'dsp');
  notMaps('Low Mixed Air Temperature', eq, 'mat');
  notMaps('High Return Air Temperature', eq, 'rat');
  maps('Supply Air Temperature', eq, 'sat');
  maps('Mixed Air Temperature', eq, 'mat');
  maps('Return Air Temperature', eq, 'rat');
});
notMaps('Low Supply Air Temperature', 'furnace', 'sat');
notMaps('Heating Valve Flow Adjust', 'fcu', 'hwValve');
maps('Heating Valve', 'fcu', 'hwValve');
check(state('ahu', ['Low Supply Air Static Pressure', 'High Supply Air Static Pressure'], 'dsp') === 'missing', 'unit ahu: only static pressure alarm limits -> dsp missing');
check(state('ahu', ['High Supply Air Static Pressure', 'Duct Static Pressure'], 'dsp') === 'covered', 'unit ahu: alarm limit plus a real Duct Static Pressure -> dsp covered');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
