// tools/test-a36-round5-coverage.js - round 5 pricing coverage fixes C1-C6 (2026-11-14). SYNTHETIC data only.
//   C1 an optional point that the N/A evidence rules out (electric reheat, no hot water plant) is not priced in Full Scope.
//   C2 the DOAS outdoor air flow point matches "Outdoor Airflow".
//   C3 the heater enable point matches "Supply Fan Enable".
//   C4 the space-type exemption reads a room name that has no space before the "|" (fan coil / VRF indoor unit CO2).
//   C5 the supply fan variable speed drive is priced when the unit has no fan speed reading; $0 I/O only when it has one.
//   C6 single-zone air handler findings cite ASHRAE 36 Section 5.18.
// Run: node tools/test-a36-round5-coverage.js   (exit 0 = all pass)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
let failed = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failed++;
}

// ---------- equipment-matrix sandbox (C2, C3, C4, C6) ----------
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
vm.runInContext(read('app/equipment-matrix.js'), em, { filename: 'app/equipment-matrix.js' });
em.window._emActivePid = 'synthetic';
const mkRow = (id, name, category, pointsRaw, subtype) => ({ id, building: 'Synthetic Hall', location: '', equipName: name, equipType: name, category, subtype: subtype || '', points: Object.assign({}, pointsRaw), pointsRaw, checks: {}, schema: 2 });
const covers = (row, key) => em.emComputeCompliance(row, {}, []).coveredPoints.some((p) => p.categoryKey === key);

// C2
check(covers(mkRow('d1', 'DOAS-1', 'doas', { 'Outdoor Airflow': '3000 cfm' }), 'oaFlow'), 'C2. DOAS "Outdoor Airflow" is the outdoor air flow point');
check(covers(mkRow('d2', 'DOAS-2', 'doas', { 'Outdoor Airflow ANI': '3000' }), 'oaFlow'), 'C2. DOAS "Outdoor Airflow ANI" is the outdoor air flow point');
check(!covers(mkRow('d3', 'DOAS-3', 'doas', { 'Supply Fan Speed': '50' }), 'oaFlow'), 'C2. a DOAS with no outdoor air flow point still lacks it');

// C3
check(covers(mkRow('h1', 'UH-1', 'heater', { 'Supply Fan Enable': 'Off', 'Fan Status': 'Off' }), 'enable'), 'C3. heater "Supply Fan Enable" is the unit enable');
check(!covers(mkRow('h2', 'UH-2', 'heater', { 'Fan Status': 'Off', 'Zone Temp': '70' }), 'enable'), 'C3. a heater with a fan status only still lacks the enable');

// C4
const cls = (name) => (em.emClassifySpaceType(mkRow('f', name, 'fcu', {}), {}) || {}).spaceType || null;
check(cls("Men's Restroom 011| VRF-03") === 'restroom', 'C4. "Restroom 011| VRF-03" (no space before the bar) is a restroom');
check(cls('Mechanical Room 004| VRF-1') === 'mech_elec', 'C4. "Mechanical Room 004| VRF-1" is a mechanical room');
check(cls("Men's Restroom 011 | VRF-03") === 'restroom' && cls('Storage 108E - VRF-2') === 'storage', 'C4. the old " | " and " - " separators still classify');
check(cls('Study Room 015| VRF-06') === null && cls('Reading Area 003| VRF-16') === null, 'C4. an occupied room does not classify (still gets the CO2 point)');
const ov = em._emSpaceTypeConfigFlagOverrides(mkRow('f', "Men's Restroom 011| VRF-03", 'fcu', {}), {});
check(ov && ov.hasCO2 === false, 'C4. the exempt fan coil reads hasCO2 = false (the flag buildOptionalPointRows reads)');

// C6
const SZ = em.EM_SZ_AIR_UNIT_SECTIONS;
check(Object.values(SZ).every((s) => /^5\.18(\.\d+)?( to 5\.18\.\d+)?$/.test(s)), 'C6. every single-zone section is a 5.18 number');
check(em.emSingleZoneSection('ahu_min_oa') === '5.18.6' && em.emSingleZoneSection('ahu_sat_reset') === '5.18.4' && em.emSingleZoneSection('ahu_economizer') === '5.18.5 to 5.18.7' && em.emSingleZoneSection('ahu_freeze_prot') === '5.18.11', 'C6. sequence sections: min outdoor air 5.18.6, supply air temperature reset 5.18.4, economizer 5.18.5 to 5.18.7, freeze 5.18.11');
check(em.emSingleZoneSection('ahu_dsp_reset') === '', 'C6. duct static pressure reset has no 5.18 counterpart (empty, the caller keeps 5.16.1)');
const RE = read('app/report-engine.js');
check(/szGroup && emSingleZoneSection\(k\)/.test(RE) && /szGroup && emSingleZoneSection\(key\)/.test(RE), 'C6. the Detailed audit takes the section of a single-zone group from emSingleZoneSection (sequence and point findings)');

check(/singleZone: typeof emIsSingleZoneAirUnit === 'function' && emIsSingleZoneAirUnit\(/.test(RE) && /var szGroup = !!\(g && g\.singleZone\)/.test(RE), 'C6. a group is single-zone from the one rule emIsSingleZoneAirUnit (the equipment result has no subtype; the matrix row has)');

// ---------- pricing-estimator sandbox (C1, C5) ----------
const PE = read('app/pricing-estimator.js');
let buildings = [];
const eq = (id, name, category, missing, covered, na, sub) => ({
  id,
  name,
  category,
  subtype: sub || '',
  compliance: {
    missingPoints: missing.map((k) => ({ categoryKey: k })),
    coveredPoints: covered.map((k) => ({ categoryKey: k })),
    naEvidence: na || {},
    singleZone: sub === 'sz',
  },
  seqReadiness: {},
});
const store = {};
const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} }, innerHTML: '' });
const pe = {
  console, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN, isFinite, Date, Set, Map, RegExp, Error,
  document: { getElementById: () => null, createElement: el, head: el(), body: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: el() },
  sget: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
  sset: (k, v) => {
    store[k] = JSON.parse(JSON.stringify(v));
  },
  showToast() {},
  setTimeout,
  clearTimeout,
  localStorage: { getItem: () => null, setItem() {} },
  navigator: {},
  collectASHRAE36Data: () => ({ buildings }),
  EM_POINT_CATEGORIES: { vav: [{ key: 'reheatValve', required: false, label: 'Reheat Valve' }] },
  emLoadEquipConfigFlags: () => ({}),
  EM_SEQUENCE_DEFS: [],
};
pe.window = pe;
pe.globalThis = pe;
vm.createContext(pe);
vm.runInContext(read('lib/formatting.js'), pe);
vm.runInContext(PE, pe);
const rate = vm.runInContext('COST_LABOR_RATE_DEFAULT', pe);
const qtyOf = (rows, pk) => rows.filter((r) => r._pointKey === pk).reduce((s, r) => s + r.qty, 0);

// C1: one electric-reheat box (N/A on evidence), one plain box (a real optional gap)
buildings = [
  {
    name: 'Test Hall',
    equipResults: [
      eq('v1', 'Room 1 - VAV-1', 'vav', [], [], { reheatValve: { reason: 'electric (SCR) reheat, no hot water valve', source: 'reheatType' } }),
      eq('v2', 'Room 2 - VAV-2', 'vav', [], [], {}),
    ],
  },
];
store.en_pricing_catalog = { 'B209+TFRB-3-06-A': { list: 500, net: 300, contract: 200 } };
const opt = pe.buildOptionalPointRows('p');
check(qtyOf(opt, 'reheatValve') === 1, 'C1. Full Scope optional reheat valve: 1 of 2 boxes (the electric-reheat box is N/A on evidence), got ' + qtyOf(opt, 'reheatValve'));

// C5
buildings = [
  {
    name: 'Test Hall',
    equipResults: [
      eq('s1', 'AHU-A', 'ahu', ['sfSpeed', 'sfSpeedCmd'], [], {}, 'sz'), // no fan speed reading: constant speed fan, needs a drive
      eq('s2', 'AHU-B', 'ahu', ['sfSpeed', 'sfSpeedCmd'], [], {}, 'sz'),
      eq('r1', 'RTU-1', 'rtu', ['sfSpeedCmd'], ['sfSpeed'], {}, 'sz'), // reads its fan speed: has a drive
      eq('m1', 'AHU-M', 'ahu', ['sfSpeed', 'sfSpeedCmd'], [], {}, 'vav'), // multiple-zone VAV unit: has a drive, speed points not integrated
    ],
  },
];
const rows = pe.buildComplianceRows('p');
const drv = rows.filter((r) => r._pointKey === 'sfSpeedCmd');
const priced = drv.filter((r) => !r.ioOnly);
const io = drv.filter((r) => r.ioOnly);
check(priced.length === 1 && priced[0].qty === 2, 'C5. 2 units with no fan speed reading: one priced drive line, qty 2 (got ' + priced.map((r) => r.qty) + ')');
const want = 3000 + 5 * rate;
check(priced[0] && Math.abs(priced[0].unitPrice - want) < 0.01 && Math.abs(priced[0].lineTotal - 2 * want) < 0.01, 'C5. drive unit price = $3,000 covering price + 5.0 h install labor = ' + want + ' (got ' + (priced[0] && priced[0].unitPrice) + ')');
check(io.reduce((n, r) => n + r.qty, 0) === 2 && io.every((r) => r.lineTotal === 0), 'C5. the unit that reads its fan speed and the multiple-zone VAV unit stay $0 I/O only (got ' + io.map((r) => r.qty) + ')');
check(rows.filter((r) => r._pointKey === 'sfSpeed').every((r) => r.lineTotal === 0), 'C5. sfSpeed stays $0 (one drive = one priced line)');
check(vm.runInContext('PRICE_POINT_MAP.sfSpeedCmd.coverPrice', pe) === 3000 && vm.runInContext('POINT_KEY_INSTALL_CLASS.sfSpeedCmd', pe) === 'vfdIntegration', 'C5. covering price 3000 and install class vfdIntegration (5.0 h)');
check(/sfSpeedCmd: 'Supply Fan Variable Speed Drives'/.test(RE), 'C5. proposal line name is "Supply Fan Variable Speed Drives"');
const blk = vm.runInContext('SEQUENCE_BLOCKING_SENSORS', pe);
check(blk.ahu_sat_reset.includes('sfSpeedCmd') && blk.ahu_min_oa.includes('sfSpeedCmd'), 'C5. Recommended prices the drive with the sequences that need it (supply air temperature reset, minimum outdoor air)');

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
