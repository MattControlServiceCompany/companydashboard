// tools/test-equipment-features.js - SYNTHETIC-fixture test of emRowFeatures and the estimated HP (item 6715c224).
// No real client data: invented rows. Runs in the regression gate by glob.
//   1. the concept list: sensors, outside air humidity, dehumidification, alarms and setpoints, audit flag
//   2. motor speed: drive point, person's answer, single speed, not known, refrigerant-flow, type that has no motor
//   3. fanDrivePointName: supply kind unchanged, motor kind widened, bare "Fan Speed" is not a drive
//   4. fanHpFromKw / fanHpFromCfm: the inverse of the kW rules, rounded UP to a standard size
//   5. fanEstimateHp: source order, speed rule, VFD amps never used, 0 A and under 0.5 A are not known
//   6. emRowFeatures HP: from airflow, from drive power, from single speed amps, dash when nothing applies
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function ok(cond, msg, info) {
  if (cond) passed++;
  else {
    failed++;
    console.log('FAIL ' + msg + (info !== undefined ? '  [' + info + ']' : ''));
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const sb = {
  console,
  window: {},
  // the test rows carry their normalized points in `pts`
  emGetNormalizedPoints: (row) => row.pts || {},
  emGetCellValByDef: (row, def, edits) => (edits && edits[row.id + '::' + def.key] !== undefined ? edits[row.id + '::' + def.key] : ''),
};
vm.createContext(sb);
['computations/physics.js', 'computations/fan-savings.js', 'computations/equipment-features.js'].forEach((f) =>
  vm.runInContext(read(f), sb, { filename: f }),
);
const row = (id, category, pts, extra) => Object.assign({ id: id, building: 'B', equipName: id, category: category, pts: pts, pointsRaw: Object.assign({}, pts) }, extra || {});
const feat = (r, edits) => sb.emRowFeatures(r, 'p', edits);

// ---- 1. concepts ----
const found = (k) => Object.keys(sb.emConceptKeys(k));
ok(found(['zoneCO2']).join() === 'CO2' && found(['returnAirCO2']).join() === 'CO2', 'CO2 from zone and return air CO2');
ok(found(['zoneRelativeHumidity']).join() === 'Humidity' && found(['returnAirHumidity']).join() === 'Humidity', 'Humidity from zone and return air humidity');
ok(found(['oaRelativeHumidity', 'outdoorAirHumidity']).length === 0, 'outside air humidity is not a humidity sensor');
ok(found(['auto_dehumidificationTemperatureActive']).length === 0, 'dehumidification is not a humidity sensor');
ok(found(['humiditySetpoint', 'auto_highRelativeHumidity', 'auto_lowZoneHumidity']).length === 0, 'a humidity setpoint or alarm is not a humidity sensor');
const auditNames = sb.EM_FEATURE_CONCEPTS.filter((c) => c.audit).map((c) => c.name);
ok(auditNames.join() === 'Economizer,Fan speed/VFD,Electric heat,Hot-water heat,DX cooling,Chilled-water cooling,CO2,Zone temp', 'audit concepts are the original eight, in order', auditNames.join());
ok(sb.EM_FEATURE_CONCEPTS.filter((c) => !c.audit).map((c) => c.name).join() === 'Humidity', 'Humidity is a Counts-only concept (never splits an audit group)');

// ---- 2. motor speed ----
let f = feat(row('a1', 'ahu', { supplyFanStatus: 'On', 'Supply Fan VFD Speed': '60 %' }));
ok(f.drive === 'variable' && f.drivePoint === 'Supply Fan VFD Speed', 'drive point -> variable, says which point', f.drivePoint);
f = feat(row('a2', 'ahu', { 'Supply Fan Status': 'On', 'Supply Fan Amperage': '20 A' }));
ok(f.drive === 'single' && /Supply Fan Status/.test(f.drivePoint), 'fan point and no drive point -> single speed', f.drive);
f = feat(row('a3', 'ahu', { 'Zone Temp': '70 F' }));
ok(f.drive === 'unknown', 'no fan or pump point -> not known');
f = feat(row('a4', 'fcu', { 'Fan Status': 'On' }, { equipName: 'VRF-3 Indoor' }));
ok(f.drive === 'unknown', 'refrigerant-flow unit -> not known');
f = feat(row('a5', 'ahu', { 'Supply Fan Status': 'On' }), { 'a5::hasVfd': 'yes' });
ok(f.drive === 'variable' && /person/i.test(f.drivePoint), 'a person answer of yes wins over the points');
f = feat(row('a6', 'ahu', { 'Supply Fan VFD Speed': '60 %' }), { 'a6::hasVfd': 'no' });
ok(f.drive === 'single', 'a person answer of no wins over a drive point');
f = feat(row('v1', 'vav', { zoneCO2: '600', 'Fan Speed': '1' }));
ok(f.drive === null && f.co2 === true && f.humidity === false && !f.hpApplies, 'VAV: motor speed does not apply, sensors do, HP does not');
f = feat(row('l1', 'lighting', { 'Lighting Status': 'On' }));
ok(f.drive === null && f.co2 === null && f.humidity === null && f.hp === null, 'lighting: nothing applies');
f = feat(row('e1', 'ef', { 'Exhaust Fan VFD Status': 'On' }));
ok(f.drive === 'variable', 'exhaust fan: its own drive point counts (motor kind)');

// ---- 3. fanDrivePointName ----
const dn = (a, e, k) => sb.fanDrivePointName(a, e, k);
ok(dn(['Exhaust Fan VFD Status']) === null, 'supply kind: an exhaust drive point is not a supply fan drive (unchanged)');
ok(dn(['Exhaust Fan VFD Status'], '', 'motor') === 'Exhaust Fan VFD Status', 'motor kind: an exhaust drive point counts');
ok(dn(['Hot Water Pump 1 Speed'], '', 'motor') === 'Hot Water Pump 1 Speed' && dn(['Hot Water Pump 1 Speed']) === null, 'motor kind: a pump speed counts; supply kind: it does not');
ok(dn(['Fan Speed', 'Fan Speed Feedback'], '', 'motor') === null, 'motor kind: a bare "Fan Speed" (a 3-speed switch) is not a drive');
ok(dn(['Fan Speed Select'], '', 'motor') === null && dn(['Manual Fan Speed MSV'], '', 'motor') === null, 'motor kind: a selector is not a drive');
ok(dn(['Circuit 1 - VFD Temperature', 'Rotation Frequency: HX-1,2'], '', 'motor') === null, 'motor kind: compressor circuit and rotation frequency are not a fan drive');
ok(dn(['Supply Fan Control Signal'], '', 'motor') === 'Supply Fan Control Signal' && dn(['Outdoor Air Percent'], '', 'motor') === null, 'motor kind: signal counts beside a fan word only');
ok(dn(['Supply Fan Speed'], 'VRF-1', 'motor') === null, 'a refrigerant-flow unit has no drive');
ok(dn(['Supply Fan Speed']) === 'Supply Fan Speed' && dn(['High Fan Speed', 'Low Fan Speed'], '', 'motor') === null, 'supply kind and a Hi/Lo speed enable unchanged');

// ---- 4. HP from kW and airflow ----
const sizes = sb.FAN_STANDARD_HP_SIZES;
ok(sb.fanHpFromKw(0) === null && sb.fanHpFromKw(-1) === null, 'no HP from 0 kW');
for (const kw of [0.2, 1, 3.3, 7.9, 15, 40, 150]) {
  const hp = sb.fanHpFromKw(kw);
  const i = sizes.indexOf(hp);
  ok(i >= 0 && sb.fanKwFromHp(hp) >= kw - 1e-9 && (i === 0 || sb.fanKwFromHp(sizes[i - 1]) < kw), 'fanHpFromKw(' + kw + ') = ' + hp + ' is the first standard size that draws that kW');
}
ok(sb.fanHpFromKw(sb.fanKwFromHp(10)) === 10 && sb.fanHpFromKw(sb.fanKwFromHp(25)) === 25, 'fanHpFromKw is the inverse of fanKwFromHp');
ok(sb.fanHpFromCfm(14700) === sb.fanHpFromKw(sb.fanKwFromCfm(14700)), 'fanHpFromCfm goes through fanKwFromCfm (one W per cfm rule)');
ok(sb.fanHpFromKw(sb.fanKwFromHp(300) * 1.5) === 450, 'above 300 HP: next 50 HP');

// ---- 5. fanEstimateHp ----
const est = (o) => sb.fanEstimateHp(Object.assign({ cfm: null, speedPct: null, driveKw: null, amps: null, drive: 'unknown' }, o));
let e = est({ cfm: 7318, speedPct: 49.7, drive: 'variable' });
ok(e && e.source === 'airflow' && e.hp === sb.fanHpFromCfm(7318 / 0.497), 'airflow is scaled to full speed by the speed fraction', e && e.hp);
e = est({ cfm: 7318, speedPct: 30, drive: 'variable' });
ok(e === null, 'speed under 35 percent: airflow is not used');
e = est({ cfm: 5000, drive: 'single' });
ok(e && e.source === 'airflow' && e.hp === sb.fanHpFromCfm(5000), 'a single speed fan with airflow and no speed point = full speed');
ok(est({ cfm: 5000, drive: 'variable' }) === null, 'a variable speed fan with airflow and no speed reading is not sized');
e = est({ cfm: 6000, speedPct: 60, driveKw: 2, amps: 30, drive: 'variable' });
ok(e.source === 'airflow', 'airflow comes before drive power and amps');
e = est({ driveKw: 1.3, speedPct: 49.5, drive: 'variable' });
ok(e && e.source === 'drive power' && e.hp === sb.fanHpFromKw(1.3 / sb.fanPowerFraction(0.495, { fixedShare: sb.FAN_FIXED_POWER_SHARE })), 'drive power is scaled to full speed by the fan power curve', e && e.hp);
ok(est({ driveKw: 1.3, speedPct: 20, drive: 'variable' }) === null, 'drive power at under 35 percent speed is not used');
e = est({ amps: 24, drive: 'single' });
ok(e && e.source === 'amps' && e.hp === sb.fanHpFromKw(sb.motorKwFromAmps(24, 460, 3)), 'single speed motor: amps through motorKwFromAmps at 460 V, 3 phase, power factor 0.85', e && e.hp);
ok(sb.FAN_HP_AMPS_VOLTS === 460 && sb.FAN_HP_AMPS_PHASE === 3 && sb.MOTOR_DEFAULT_POWER_FACTOR === 0.85, 'the amps assumptions: 460 V, 3 phase, power factor 0.85');
ok(est({ amps: 24, drive: 'variable' }) === null, 'VFD amps are never converted');
ok(est({ amps: 24, drive: 'unknown' }) === null, 'amps with the drive not known are not converted');
ok(est({ amps: 0, drive: 'single' }) === null && est({ amps: 0.4, drive: 'single' }) === null, '0 A and under 0.5 A are not known');
ok(est({ amps: 0.5, drive: 'single' }) !== null, '0.5 A is the lowest reading used');
ok(est({ cfm: 0, driveKw: 0, drive: 'single' }) === null, 'readings of 0 are not known');

// ---- 6. emRowFeatures HP ----
f = feat(row('h1', 'ahu', { supplyFanCFM: '7318.0', supplyFanSpeed: '49.7 %', 'Supply Fan VFD Speed': '49.7 %' }));
ok(f.hpApplies && f.hp && f.hp.source === 'airflow' && f.hp.hp === sb.fanHpFromCfm(7318 / 0.497), 'ahu with airflow and speed -> airflow estimate', f.hp && f.hp.hp);
f = feat(row('h2', 'ef', { 'Exhaust Fan Status': 'On', 'Exhaust Fan 1 Amperage': '9.5 A' }));
ok(f.hp && f.hp.source === 'amps' && f.hp.hp === sb.fanHpFromKw(sb.motorKwFromAmps(9.5, 460, 3)), 'exhaust fan: single speed amps estimate', f.hp && f.hp.hp);
f = feat(row('h3', 'ahu', { 'Supply Fan VFD Speed': '60 %', supplyFanSpeed: '60 %', supplyFanAmps: '30 A' }));
ok(f.hpApplies && f.hp === null, 'ahu with a drive and amps only -> HP not known');
f = feat(row('h4', 'ahu', { 'Supply Fan VFD Speed': '60 %', supplyFanSpeed: '60 %', 'Drive Power': '3.1 kW' }));
ok(f.hp && f.hp.source === 'drive power', 'ahu with a drive power point -> drive power estimate');
f = feat(row('h5', 'vav', { supplyFanCFM: '5000' }));
ok(!f.hpApplies && f.hp === null, 'a type that is not a fan unit gets no HP');
f = feat(row('h6', 'doas', { 'Supply Fan 1 CFM': '3000' }));
ok(f.hp && f.hp.source === 'airflow', 'doas with airflow and a single speed motor -> airflow estimate');
f = feat(row('h7', 'ahu', { 'Supply Fan Status': 'On', supplyFanAmps: '0.0 A' }));
ok(f.hpApplies && f.hp === null, 'a fan that reads 0 A is not sized');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
