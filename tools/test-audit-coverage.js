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
  row({ equipName: 'Zone | VAV-4', pointsRaw: { 'Air Flow': '800' } }),
  row({ equipName: 'Zone | VAV-5', pointsRaw: { 'Air Flow': '800' } }),
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
  row({ building: 'Fake Hall B', equipName: 'Zone | VAV-8', pointsRaw: { 'Air Flow': '1' } }),
]);
t.eq(c.buildings.map((b) => b.name + ':' + b.pct), ['Fake Hall A:100', 'Fake Hall B:0'], 'building percentages');
t.eq(c.types.length, 1, 'one system type');
t.eq(c.pct, 50, 'overall percentage');

// 7. Empty matrix.
t.eq(sb.auditComputeCoverage([]).total, 0, 'empty matrix has no units');

const fs = require('fs');
const faSrc = fs.readFileSync(require('path').join(__dirname, '..', 'app/facility-audit.js'), 'utf8');
t.ok(/auditComputeCoverage\(/.test(faSrc) && !/AUDIT_COV_ITEMS|auditCoverageNeeds/.test(faSrc), 'the tab calls the one coverage function and has no coverage rules of its own');
t.done('test-audit-coverage');
