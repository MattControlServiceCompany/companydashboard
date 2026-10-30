// tools/test-audit-coverage.js - Facility Audit coverage. Run: node tools/test-audit-coverage.js
// SYNTHETIC fixtures only (fake building and equipment names).
'use strict';
const { loadAuditSandbox, makeCounter } = require('./audit-test-sandbox');
const t = makeCounter();
const sb = loadAuditSandbox();

function row(o) {
  const r = Object.assign({ building: 'Fake Hall A', category: 'vav', subtype: '', bacnetLocation: '/Fake/Hall A', schema: 2, pointsRaw: {}, checks: {} }, o);
  if (!r.id) r.id = r.building + '||' + r.equipName;
  return r;
}
const sp = { 'Occupied Heating Setpoint': '70', 'Occupied Cooling Setpoint': '74' };

// 1. Identical point sets form one group; covered when a member has the data.
let c = sb.auditComputeCoverage([
  row({ equipName: 'Zone | VAV-1', pointsRaw: sp }),
  row({ equipName: 'Zone | VAV-2', pointsRaw: sp }),
  row({ equipName: 'Zone | VAV-3', pointsRaw: sp }),
]);
t.eq(c.groups.length, 1, 'three identical boxes make one group');
t.eq(c.groups[0].units, 3, 'group counts its units');
t.eq(c.pct, 100, 'all covered');
t.eq(c.stillNeed.length, 0, 'no gaps');

// 2. A box without set points is a gap; it is one line for the group, not one per unit.
c = sb.auditComputeCoverage([
  row({ equipName: 'Zone | VAV-4', pointsRaw: { 'Air Flow': '800', 'Zone Temp': '70' } }),
  row({ equipName: 'Zone | VAV-5', pointsRaw: { 'Air Flow': '800', 'Zone Temp': '70' } }),
  row({ equipName: 'Zone | VAV-6', pointsRaw: sp }),
]);
t.eq(c.stillNeed.length, 1, 'identical gap units give one still-need line');
t.eq(c.stillNeed[0].units, 2, 'still-need line counts the units');
t.eq(c.covered, 1, 'only the box with set points is covered');
t.ok(/set points/.test(c.stillNeed[0].reason), 'reason names the missing item in plain words');
t.ok(!/energy|saving|waste|optimiz/i.test(JSON.stringify(c.stillNeed)), 'no energy finding wording');

// 3. A serving unit never needs a schedule, and needs only its SAT set point (plus the big items).
const ahuPts = { 'Supply Air Temp Setpoint': '55', 'Return Air CO2': '600', 'Economizer Damper': '40', 'Heat Request': '0', 'Cool Request': '0', 'System Mode': '2' };
c = sb.auditComputeCoverage([row({ category: 'ahu', equipName: 'AHU-1', pointsRaw: ahuPts })]);
t.eq(c.stillNeed.length, 0, 'serving AHU with SAT set point, CO2, economizer, mode, requests is covered with no schedule');
t.ok(!c.groups[0].needs.includes('schedule'), 'serving AHU does not need a schedule');

// 4. A single-zone RTU (no boxes in its building) needs its own schedule.
c = sb.auditComputeCoverage([row({ building: 'Fake Hall B', category: 'rtu', equipName: 'RTU-1', pointsRaw: Object.assign({ 'Economizer Position': '0', 'Return Air CO2': '500', Mode: '1', 'Heat Request': '0' }, sp) })]);
t.ok(c.groups[0].needs.includes('schedule'), 'single-zone RTU needs a schedule');
t.eq(c.stillNeed.length, 1, 'single-zone RTU without schedule is a gap');
const withSched = row({ building: 'Fake Hall B', category: 'rtu', equipName: 'RTU-2', pointsRaw: Object.assign({ 'Economizer Position': '0', 'Return Air CO2': '500', Mode: '1', 'Heat Request': '0' }, sp), existingSchedule: { rawText: 'Occupied from 6:00 AM to 5:00 PM' } });
c = sb.auditComputeCoverage([withSched]);
t.eq(c.stillNeed.length, 0, 'a schedule picture covers the schedule need');

// 5. Lighting is never a gap; domestic hot water and non-HVAC rows are out of scope.
c = sb.auditComputeCoverage([
  row({ category: 'lighting', equipName: 'Hall lights', pointsRaw: {} }),
  row({ category: 'plumbing', equipName: 'DHW heater', pointsRaw: {} }),
  row({ category: 'elevator', equipName: 'Lift', pointsRaw: {} }),
]);
t.eq(c.total, 1, 'only lighting is in scope');
t.eq(c.stillNeed.length, 0, 'unshot lighting is not a gap');

// 6. Per building and per type numbers.
c = sb.auditComputeCoverage([
  row({ building: 'Fake Hall A', equipName: 'Zone | VAV-7', pointsRaw: sp }),
  row({ building: 'Fake Hall B', equipName: 'Zone | VAV-8', pointsRaw: { 'Air Flow': '1', 'Zone Temp': '70' } }),
]);
t.eq(c.buildings.map((b) => b.name + ':' + b.pct), ['Fake Hall A:100', 'Fake Hall B:0'], 'building percentages');
t.eq(c.types.length, 1, 'one system type');
t.eq(c.pct, 50, 'overall percentage');

// 8. SAT set point: found under every real name form, never taken from a sensor or a zone/alarm point.
const satOnly = (pointsRaw, extra) => sb.auditComputeCoverage([row(Object.assign({ category: 'ahu', equipName: 'AHU-9', pointsRaw }, extra || {}))]).stillNeed.length;
const satSensor = { 'Supply Air Temperature': '55', 'Supply Fan Status': 'On', 'Return Air Temperature': '70', 'Heat Request 1': '0' };
t.eq(satOnly(satSensor), 1, 'a supply air temperature SENSOR alone is a true gap');
t.eq(satOnly(Object.assign({ 'Discharge Air Temperature Setpoint': '55' }, satSensor)), 0, 'Discharge Air Temperature Setpoint (words between) is the SAT set point');
t.eq(satOnly(Object.assign({ 'Remote Cooling Setpoint': '55' }, satSensor)), 0, 'Remote Cooling Setpoint on a serving unit is the SAT set point');
t.eq(satOnly(Object.assign({ 'Cooling PID / Setpoint': '55' }, satSensor)), 0, 'Cooling PID / Setpoint is the SAT set point');
t.eq(satOnly(Object.assign({ 'Heating Valve PID / Setpoint': '70' }, satSensor)), 0, 'Heating Valve PID / Setpoint is a SAT set point');
t.eq(satOnly(Object.assign({ 'Cooling Set Point BACnet PID / Setpoint': '55' }, satSensor)), 0, 'Cooling Set Point BACnet PID / Setpoint is a SAT set point');
t.eq(satOnly(Object.assign({ 'Pre-Heating Valve PID / Setpoint': '48' }, satSensor)), 1, 'a pre-heat (freeze) loop is not the SAT set point');
t.eq(satOnly(Object.assign({ 'Low Supply Air Temperature Alarm': 'Normal', 'High Cooling Air Temperature Alarm': 'Normal', 'Supply Static PID / Setpoint': '1' }, satSensor)), 1, 'alarms and static pressure set points are not the SAT set point');

// 9. A serving unit needs ONLY the SAT set point: no CO2, economizer, mode or request gap.
c = sb.auditComputeCoverage([row({ category: 'ahu', equipName: 'AHU-8', pointsRaw: { 'Supply Air Temp Setpoint': '55' } })]);
t.eq(c.groups[0].needs, ['sat'], 'serving AHU needs only the SAT set point');
t.eq(c.stillNeed.length, 0, 'serving AHU without CO2, economizer, mode, requests is covered');

// 10. A single-zone unit (subtype sz) is not a serving unit, even in a building with boxes. It never needs requests.
const boxA = row({ building: 'Fake Hall C', equipName: 'Zone | VAV-20', pointsRaw: sp });
const szRtu = row({ building: 'Fake Hall C', category: 'rtu', subtype: 'sz', equipName: 'RTU-20', pointsRaw: Object.assign({ 'Economizer Damper': '0', 'Zone CO2': '500', Mode: '1', Schedule: 'On', 'Supply Air Temperature': '55' }, sp) });
t.eq(sb.auditIsServingUnit(szRtu, [boxA, szRtu]), false, 'single-zone RTU in a building with boxes is not serving');
c = sb.auditComputeCoverage([boxA, szRtu]);
t.ok(!c.groups.some((g) => g.needs.includes('request')), 'no unit needs requests');
t.eq(c.stillNeed.length, 0, 'single-zone RTU with its own points is covered');
// own zone set points and no numbered request inputs = single zone; numbered request inputs = serving
const ownZone = row({ category: 'ahu', equipName: 'AHU-21', pointsRaw: { 'Setpoint / Effective Cooling Setpoint': '74', 'Setpoint / Effective Heating Setpoint': '70', 'Supply Air Temperature': '55' } });
t.eq(sb.auditIsServingUnit(ownZone, [ownZone]), false, 'unit with its own zone set points and no numbered requests is not serving');
const ownZoneServing = row({ category: 'ahu', equipName: 'AHU-22', pointsRaw: { 'Setpoint / Effective Cooling Setpoint': '74', 'Air Request 1': '0', 'Air Request 2': '0', 'Supply Air Temperature': '55' } });
t.eq(sb.auditIsServingUnit(ownZoneServing, [ownZoneServing]), true, 'unit with numbered request inputs is serving');

// 11. Economizer settings: an outside air damper counts; an energy wheel replaces the economizer; a garage unit reads CO, not CO2.
const szNeeds = (pointsRaw) => sb.auditComputeCoverage([row({ category: 'rtu', subtype: 'sz', equipName: 'RTU-30', pointsRaw: Object.assign({ Mode: '1', Schedule: 'On', 'Zone CO2': '500', 'Supply Air Temperature': '55' }, sp, pointsRaw) })]).stillNeed.map((n) => n.missing.join());
t.eq(szNeeds({ 'Outside Air Damper': '20' }), [], 'Outside Air Damper is the economizer data');
t.eq(szNeeds({}), ['econ'], 'a single-zone RTU with no economizer point is a true gap');
t.eq(szNeeds({ 'Energy Wheel Status': 'On' }), [], 'an energy wheel unit has no economizer to find');
t.eq(sb.auditComputeCoverage([row({ category: 'ahu', subtype: 'sz', equipName: 'AHU-31', pointsRaw: Object.assign({ Mode: '1', Schedule: 'On', 'Outside Air Damper': '10', 'High Carbon Monoxide Level': 'Normal', 'Supply Air Temperature': '55' }, sp) })]).stillNeed.length, 0, 'a garage unit with carbon monoxide points needs no CO2 value');

// 12. Rows filed as air units that are not air units.
c = sb.auditComputeCoverage([
  row({ category: 'ahu', equipName: 'Stair Pressure Fan 1 - SPF-2', pointsRaw: { 'Fan Status': 'On', 'Fan Enable': 'On' } }),
  row({ category: 'ahu', equipName: 'Lobby - S-29-0', pointsRaw: { Schedule: 'On', 'Load 1 CMD': '1', 'Lighting Group Status': 'On' } }),
  row({ category: 'ahu', equipName: 'Shutdown panel', pointsRaw: { 'Air Handler 1A Off Command BV': 'Off' } }),
]);
t.eq(c.total, 0, 'fan, relay and panel rows filed as air units are out of scope');
c = sb.auditComputeCoverage([row({ category: 'ahu', equipName: 'Room 1 - VAV-1-15', pointsRaw: { 'Air Flow Set Point': '220', 'Flow Control': 'On', 'Zone Temp': '70' } })]);
t.eq(c.stillNeed[0] && c.stillNeed[0].missing, ['setpoints'], 'a box filed as an air unit needs zone set points (an air flow set point is not one)');
c = sb.auditComputeCoverage([row({ category: 'ahu', equipName: 'Lab - FCU-4', pointsRaw: { 'Supply Air Temperature': '55', 'Supply Fan Status': 'On' } })]);
t.eq(c.groups[0].needs, [], 'a fan coil filed as an air unit follows its name (no zone temperature, so no zone set point)');

// 13. Plants: only a unit that makes or holds water temperature needs a water temperature set point.
const plantOnly = (equipName, pointsRaw, category) => sb.auditComputeCoverage([row({ category: category || 'hwp', equipName, pointsRaw })]);
t.eq(plantOnly('Floor 2 - Boiler Plant', { 'System Supply': '140', 'Heat Source Supply': '140', 'System Mode': '2' }).stillNeed.length, 1, 'a boiler plant with no water set point is a true gap');
t.eq(plantOnly('Floor 2 - Boiler Plant', { 'System Supply': '140', 'Boiler 1 Outlet Setpoint': '150' }).stillNeed.length, 0, 'a boiler outlet set point covers the plant');
t.eq(plantOnly('Plant Integration', { 'System Supply': '44', '_BAS Chw Set Point': '44' }, 'chwp').stillNeed.length, 0, 'a point name with a leading underscore still counts');
t.eq(plantOnly('Loop 1', { 'System Supply': '140', 'Chilled Water Loop DP Set Point': '10', 'Outlet High Limit Setpoint': '200' }).stillNeed.length, 1, 'pressure and high-limit set points are not the water temperature set point');
t.eq(plantOnly('Domestic Hot Water Pump', { Schedule: 'On', 'Supply Temperature': '120' }).total, 0, 'domestic hot water is out of scope');
t.eq(plantOnly('Sump Pump 1', { 'High Level Alarm': 'Off' }).total, 0, 'a sump pump alarm is not a plant');
t.eq(plantOnly('Gas Meter - Boiler', { Demand: '1', Meter: '2' }).total, 0, 'a meter is not a plant');
t.eq(plantOnly('Chilled Water Differential Pressure', { 'Differential Pressure': '10' }, 'chwp').total, 0, 'a pressure sensor is not a plant');
t.eq(plantOnly('Boiler Room UH', { 'Heat Source Supply': '140', 'Supply Fan Enable': 'On' }).total, 0, 'a unit heater with a fan is not a plant');

// 14. Zone units: an air flow set point is not a temperature set point.
c = sb.auditComputeCoverage([row({ category: 'fpb', equipName: 'Hall | FPB-1', pointsRaw: { 'Air Flow Set Point': '300', 'Zone Temperature': '70' } })]);
t.eq(c.stillNeed.length, 1, 'a box with only an air flow set point is a true gap');
c = sb.auditComputeCoverage([row({ category: 'vrf', equipName: 'VRF-02 CO2 Monitoring', pointsRaw: { 'Zone CO2': '459 ppm', 'Zone Temp AV': '70 F', 'High Carbon Dioxide Level': 'Normal' } })]);
t.eq(c.stillNeed.length, 0, 'a CO2 monitoring program (sensors only) has no set point to find');
c = sb.auditComputeCoverage([row({ category: 'vrf', equipName: 'VRF-03', pointsRaw: { 'Zone CO2': '459 ppm', 'Zone Temp AV': '70 F', 'Fan Mode': 'Auto' } })]);
t.eq(c.stillNeed.length, 1, 'a VRF unit with fan control and a zone temperature but no set point is a true gap');

// 7. Empty matrix.
t.eq(sb.auditComputeCoverage([]).total, 0, 'empty matrix has no units');

// 8. Serving fix: numbered request inputs override a wrong sz subtype (RTU feeding boxes).
const feeder = row({ building: 'Fake Hall D', category: 'rtu', subtype: 'sz', equipName: 'RTU-40', pointsRaw: { 'Air Request 1': '0', 'Air Request 2': '0', 'Supply Air Temp Setpoint': '55', 'Supply Air Temperature': '55', 'Economizer Damper': '0' } });
const fbox = row({ building: 'Fake Hall D', equipName: 'Zone | VAV-40', pointsRaw: sp });
t.eq(sb.auditIsServingUnit(feeder, [feeder, fbox]), true, 'sz-tagged RTU with numbered requests is serving');
t.eq(sb.auditComputeCoverage([feeder, fbox]).stillNeed.length, 0, 'serving RTU needs only SAT set point, not CO2');

// 9. Screenshot evidence moves a Still-need line to covered.
const hp = row({ building: 'Fake Hall E', category: 'rtu', equipName: 'HP-1', pointsRaw: Object.assign({ Mode: '1', Schedule: 'On', 'Supply Air Temperature': '55' }, sp) });
c = sb.auditComputeCoverage([hp]);
t.eq(c.stillNeed.length, 1, 'unit with no economizer or CO2 point is a Still-need line');
const ev = {};
ev[c.stillNeed[0].key] = { files: ['shot-1.png'], note: 'unit has no economizer', who: 'Tester', when: '2026-01-01T00:00:00Z' };
const c2 = sb.auditComputeCoverage([hp], ev);
t.eq(c2.stillNeed.length, 0, 'evidence removes the line from Still need');
t.eq(c2.screenshotCovered.length, 1, 'evidence puts it in the screenshot-covered list');
t.eq(c2.screenshotCovered[0].evidence.files, ['shot-1.png'], 'screenshot list keeps the file names');
t.eq([c.pct, c2.pct], [0, 100], 'coverage percent includes screenshot-covered items');
t.eq(sb.auditComputeCoverage([hp], {}).stillNeed.length, 1, 'undo (no evidence) puts the line back');

const fs = require('fs');
const faSrc = fs.readFileSync(require('path').join(__dirname, '..', 'app/facility-audit.js'), 'utf8');
t.ok(/auditComputeCoverage\(/.test(faSrc) && !/AUDIT_COV_ITEMS|auditCoverageNeeds/.test(faSrc), 'the tab calls the one coverage function and has no coverage rules of its own');
t.ok(/class="[^"]*fa-need|'fa-need'/.test(faSrc) && /@media \(max-width:700px\)\{\.fa-need\{table-layout:fixed\}\.fa-need td\{min-width:0\}/.test(faSrc), 'Still-need table drops min widths and fixes layout at 700px and narrower (640px fit; browser check separate)');
t.done('test-audit-coverage');
