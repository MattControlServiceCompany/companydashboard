// tools/test-bas-first-use.js - BAS / audit first-use fixes. Run: node tools/test-bas-first-use.js
// SYNTHETIC fixtures only.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAuditSandbox, makeCounter, ROOT } = require('./audit-test-sandbox');
const t = makeCounter();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- #1 one import entry point; imported schedules reach the Set Points source ----
const sb = loadAuditSandbox();
const PID = 900;
const eqRow = {
  id: 'r1', building: 'Fake Hall A', category: 'rtu', equipName: 'RTU-1', location: 'RTU-1',
  bacnetLocation: '/Fake District/Fake Hall A/Roof', schema: 2, pointsRaw: {}, checks: {}, points: {},
};
sb.__store['en_eqmatrix_' + PID] = JSON.stringify({ rows: [eqRow], importedAt: 'x', buildings: [] });
sb.getUDBldgs = () => [{ id: 'b1', name: 'Fake Hall A', meters: [] }];
const before = sb.emCurrentSetpointZones(PID, 'b1');
t.eq(before.length, 1, 'no saved record: zones come from the matrix');
t.eq(before[0].schedule, '?', 'before the import the schedule is unknown');
const parsed = [{ location: '/Fake District/Fake Hall A/Roof', controlProgram: 'RTU-1',
  scheduleText: 'Unoccupied from 12:00 AM to 6:00 AM\nOccupied from 6:00 AM to 5:00 PM\nUnoccupied from 5:00 PM to 12:00 AM' }];
const att = sb.emAttachParsedSchedules(PID, parsed, 'fake.csv');
t.eq(att.matchedCount, 1, 'the District Calendar import fills the matrix row');
const after = sb.emCurrentSetpointZones(PID, 'b1');
t.eq(after[0].schedule, 'M-F 6:00-17:00', 'imported schedule shows as Set Points schedule');
t.ok(read('app/bas-schedules.js').indexOf('emAttachParsedSchedules(pid, p.parsed') !== -1, 'basSave calls the shared attach function');
t.ok(read('app/equipment-matrix.js').indexOf('em-import-schedules-btn') === -1, 'Equipment Matrix import button is gone');
t.ok(read('app/graphics-setpoints.js').indexOf('Drop BAS export here') === -1, 'Set Points drop zone is gone');

// ---- #15 Facility Audit set points = Set Points tab, one function ----
const faRows = sb.faSetPointRows(PID);
t.eq(faRows.length, 1, 'audit has one row for the one zone');
t.eq(faRows[0][1], after[0].name, 'audit zone name equals Set Points zone name');
t.eq(faRows[0][6], after[0].schedule, 'audit schedule equals Set Points schedule');
// a saved Set Points record wins in both views
sb.projects = [{ id: PID, setpoints: [{ buildingId: 'b1', zones: [{ name: 'Saved Zone', occHeat: 71, occCool: 75, unoccHeat: 60, unoccCool: 85, schedule: 'Mon-Fri 7-4' }] }] }];
t.eq(sb.emCurrentSetpointZones(PID, 'b1')[0].name, 'Saved Zone', 'saved record is the source');
t.eq(sb.faSetPointRows(PID)[0], ['Fake Hall A', 'Saved Zone', '71', '75', '60', '85', 'Mon-Fri 7-4'], 'audit shows the saved record');
const sp = read('app/graphics-setpoints.js');
t.ok(sp.indexOf('emCurrentSetpointZones(projId, activeBldgId)') !== -1, 'Set Points tab reads the shared function');
t.ok(read('app/facility-audit.js').indexOf('emCurrentSetpointZones(pid, b.id)') !== -1, 'Facility Audit reads the shared function');

// ---- #18 readable WebCTRL text ----
const BasDiff = require(path.join(ROOT, 'app/bas-diff.js'));
t.eq(BasDiff.readableDates('Year 0000 (any), Month 00 (any), Day of Month 00 (any)'), 'any year, any month, any day of the month', 'zero codes become words');
t.eq(BasDiff.readableDates('Year 2026, Day of Month 15'), 'Year 2026, Day of Month 15', 'real dates are unchanged');
const ok = BasDiff.readableHours({ mode: 'Occupied', start: '6:00 AM', end: '5:00 PM' });
t.eq(ok, { text: 'Occupied 6:00 AM - 5:00 PM', note: '' }, 'readable hours');
const bad = BasDiff.readableHours({ mode: 'Occupied', start: 'stagger (not opened)', end: '' });
t.ok(bad.text === 'Occupied, hours not in file' && /stagger/.test(bad.note), 'unreadable hours: plain text, raw text only in the note');

// ---- #16 cost note ----
const pe = read('app/pricing-estimator.js');
const fnSrc = (src, name) => { const a = src.indexOf('function ' + name); let d = 0, i = src.indexOf('{', a); for (let j = i; j < src.length; j++) { if (src[j] === '{') d++; if (src[j] === '}' && --d === 0) return src.slice(a, j + 1); } };
const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc(pe, '_pricingCostNote'), ctx);
t.ok(/No measure has cost lines/.test(ctx._pricingCostNote(0, 3)) && /Financials/.test(ctx._pricingCostNote(0, 3)), 'zero costed: says where to add');
t.ok(!/only the 0/.test(ctx._pricingCostNote(0, 3)), 'never says "only the 0 measures"');
t.ok(/only the 2 of 3 measures/.test(ctx._pricingCostNote(2, 3)), 'partial count reads N of M');
t.ok(/Energy Savings page: open a measure, then Financials/.test(pe), 'heading says how to reach the cost entry');

// ---- #17 HVAC source help ----
const ctx2 = {}; vm.createContext(ctx2); vm.runInContext(fnSrc(read('app/calculators.js'), 'hvlSourceHelp'), ctx2);
const none = ctx2.hvlSourceHelp({ source: 'none' });
t.ok(none.open && /Missing/.test(none.missing) && /Utility Data/.test(none.missing), 'no data: says what is missing and where to fill it');
const bills = ctx2.hvlSourceHelp({ source: 'bills' });
t.ok(!bills.open && /Optional/.test(bills.summary) && bills.missing === '', 'bills: entry closed and labelled optional');
t.ok(ctx2.hvlSourceHelp({ source: 'annual' }).open, 'annual: entry open');
// ---- v187 fixes: a saved Set Points record gets the import's schedules; audit = tab cell for cell ----
const PID2 = 901;
const servRow = { id: 'r2', building: 'Fake Hall A', category: 'ahu', equipName: 'TST-0002', location: 'TST-0002', bacnetLocation: '/Fake District/Fake Hall A/Roof', schema: 2, pointsRaw: {}, checks: {}, points: {} };
const boxRow = Object.assign({}, eqRow, { id: 'r3', equipName: 'TST-0003', location: 'TST-0003' });
sb.__store['en_eqmatrix_' + PID2] = JSON.stringify({ rows: [servRow, boxRow], importedAt: 'x', buildings: [] });
sb.projects = [{ id: PID2, setpoints: [{ buildingId: 'b1', zones: [
  { name: 'TST-0002', occHeat: null, occCool: null, unoccHeat: null, unoccCool: null, schedule: '' },
  { name: 'TST-0003', occHeat: 70, occCool: 74, unoccHeat: '?', unoccCool: 85, schedule: '' },
  { name: 'TST-0004', occHeat: 68, occCool: 72, unoccHeat: 60, unoccCool: 85, schedule: 'typed by hand' }] }] }];
const parsed2 = [{ location: '/Fake District/Fake Hall A/Roof', controlProgram: 'TST-0003', scheduleText: 'Occupied from 7:00 AM to 4:00 PM' },
  { location: '/Fake District/Fake Hall A/Roof', controlProgram: 'TST-0004', scheduleText: 'Occupied from 1:00 AM to 2:00 AM' }];
sb.emAttachParsedSchedules(PID2, parsed2, 'fake2.csv');
const zs = sb.emCurrentSetpointZones(PID2, 'b1');
t.eq(zs[1].schedule, 'M-F 7:00-16:00', 'import fills the schedule of a saved Set Points zone');
t.eq(zs[0].schedule, '', 'serving unit with no schedule in the file stays blank (no gap marker)');
t.eq(zs[2].schedule, 'typed by hand', 'a typed schedule is never replaced');
t.eq(JSON.parse(sb.__store['en_projects'])[0].setpoints[0].zones[1].schedule, 'M-F 7:00-16:00', 'the filled schedule is saved');
const faCells = sb.faSetPointRows(PID2);
t.eq(faCells[0], ['Fake Hall A', 'TST-0002', '70', '74', '60', '85', ''], 'audit shows the italic defaults like the tab');
t.eq(faCells[1], ['Fake Hall A', 'TST-0003', '70', '74', '?', '85', 'M-F 7:00-16:00'], 'audit keeps ? and values like the tab');
const faHtml = sb._faSetPointsTable(PID2).split('</tr>');
t.ok(/<td><i>70<\/i><\/td><td><i>74<\/i><\/td><td><i>60<\/i><\/td><td><i>85<\/i><\/td>/.test(faHtml[1]), 'audit shows empty cells as italic defaults');
t.ok(/<td>70<\/td><td>74<\/td><td>\?<\/td><td>85<\/td>/.test(faHtml[2]), 'audit shows saved values and ? as plain text');
t.eq(BasDiff.readableDates('Day of Month 28; Month February; Day of Week Any; Week Any; Year 0000 (any)'), 'Feb 28', 'fixed day reads like a date');
t.ok(/Create meter on Unmatched Bills/.test(read('app/bill-analysis.js')) && !/Create building \+ meter/.test(read('app/bill-analysis.js')), 'no-building button says what it does');
t.done('test-bas-first-use');
