// tools/test-audit-rules.js - Facility Audit automatic rules. Run: node tools/test-audit-rules.js
// SYNTHETIC fixtures only (fake building and equipment names).
'use strict';
const fs = require('fs');
const path = require('path');
const { loadAuditSandbox, makeCounter, ROOT } = require('./audit-test-sandbox');
const t = makeCounter();
const sb = loadAuditSandbox();

function row(o) {
  const r = Object.assign(
    { building: 'Fake Hall A', category: 'vav', subtype: '', bacnetLocation: '/Fake/Hall A', schema: 2, pointsRaw: {}, checks: {} },
    o
  );
  if (!r.id) r.id = r.building + '||' + r.equipName;
  return r;
}
const ruleOf = (list, id) => list.filter((f) => f.ruleId.indexOf(id) === 0);
const run = (rows) => sb.auditComputeAutoFindings(rows, {});

// 1. Set points off the standard
const spStd = row({ equipName: 'Zone | VAV-1', pointsRaw: { 'Occupied Heating Setpoint': '70', 'Occupied Cooling Setpoint': '74' } });
const spOff = row({ equipName: 'Zone | VAV-2', pointsRaw: { 'Occupied Heating Setpoint': '72', 'Occupied Cooling Setpoint': '74' } });
const spNone = row({ equipName: 'Zone | VAV-3', pointsRaw: { 'Air Flow': '800' } });
let f = run([spStd, spOff, spNone]);
t.eq(ruleOf(f, 'setpoint-off-standard').map((x) => x.rowId), [spOff.id], 'set point rule fires only for the off row');
t.ok(/occupied heating is 72 \(standard 70\)/.test((ruleOf(f, 'setpoint-off-standard')[0] || {}).issue || ''), 'set point issue names value and standard');
// unoccupied standard follows the heating type (hot water valve -> hydronic 55)
const unoccHyd = row({ equipName: 'Zone | VAV-4', pointsRaw: { 'Unoccupied Heating Setpoint': '55', 'Hot Water Valve': '0' } });
const unoccBad = row({ equipName: 'Zone | VAV-5', pointsRaw: { 'Unoccupied Heating Setpoint': '65', 'Hot Water Valve': '0' } });
f = run([unoccHyd, unoccBad]);
t.eq(ruleOf(f, 'setpoint-off-standard').map((x) => x.rowId), [unoccBad.id], 'unoccupied standard uses the heating type');
t.eq(sb.EM_SP_DEFAULTS.unocc.hydronic.heat, 55, 'fixture assumes the matrix standard (read, not copied)');

// 2. Sensor deficiencies
const sensBad = row({ equipName: 'Zone | VAV-6', pointsRaw: { 'Zone CO2': '-5' } });
const sensOk = row({ equipName: 'Zone | VAV-7', pointsRaw: { 'Zone CO2': '650' } });
const defs = sb.emGetSensorDeficiencies(sensBad);
f = run([sensBad, sensOk]);
const sens = f.filter((x) => x.ruleId.indexOf('sensor-') === 0);
t.ok(defs.length > 0, 'fixture really has a sensor deficiency in the matrix');
t.eq(sens.length, defs.length, 'one sensor finding per matrix deficiency');
t.ok(sens.length > 0 && sens.every((x) => x.rowId === sensBad.id && x.deficiency === true && x.issueType === 'Deficiency'), 'sensor findings are deficiencies on the bad row only');

// 3. Schedule extra hours
const occ = (a, b) => 'Occupied from ' + a + ' to ' + b;
const schedLong = row({ equipName: 'Zone | VAV-8', existingSchedule: { rawText: occ('4:00 AM', '10:00 PM') } });
const schedOk = row({ equipName: 'Zone | VAV-9', existingSchedule: { rawText: occ('6:00 AM', '5:00 PM') } });
const schedNone = row({ equipName: 'Zone | VAV-10' });
f = run([schedLong, schedOk, schedNone]);
const sch = ruleOf(f, 'schedule-extra-hours');
t.eq(sch.map((x) => x.rowId), [schedLong.id], 'schedule rule fires only for the long schedule');
t.eq((sch[0] || {}).extraHours, 7, 'extra hours = 18h run minus 11h proposed');

// 4. Serving units never get a schedule finding
const longText = occ('12:00 AM', '11:00 PM');
const ahu = row({ equipName: 'AHU-1', category: 'ahu', existingSchedule: { rawText: longText } });
const rtuAlone = row({ building: 'Fake Hall B', equipName: 'RTU-1', category: 'rtu', existingSchedule: { rawText: longText } });
const erv = row({ equipName: 'ERV-1', category: 'erv', existingSchedule: { rawText: longText } });
const doas = row({ equipName: 'DOAS-1', category: 'doas', existingSchedule: { rawText: longText } });
const hwp = row({ equipName: 'Hot Water Plant', category: 'hwp', existingSchedule: { rawText: longText } });
const chwp = row({ equipName: 'Chilled Water Plant', category: 'chwp', existingSchedule: { rawText: longText } });
const dhw = row({ equipName: 'Domestic Hot Water 1', category: 'plumbing', existingSchedule: { rawText: longText } });
const box = row({ equipName: 'Zone | VAV-11' });
f = run([ahu, rtuAlone, erv, doas, hwp, chwp, dhw, box]);
const schIds = ruleOf(f, 'schedule-extra-hours').map((x) => x.rowId);
t.ok(schIds.indexOf(ahu.id) === -1, 'AHU serving boxes: no schedule finding');
t.ok(schIds.indexOf(erv.id) === -1 && schIds.indexOf(doas.id) === -1, 'ERV and DOAS serving a building with boxes: no schedule finding');
t.ok(schIds.indexOf(hwp.id) === -1 && schIds.indexOf(chwp.id) === -1, 'heating and cooling plants: no schedule finding');
t.ok(schIds.indexOf(rtuAlone.id) !== -1, 'RTU with no boxes or zones in its building keeps its own schedule finding');
t.ok(schIds.indexOf(dhw.id) !== -1, 'domestic hot water is not a serving unit: schedule finding stays');
t.eq(sb.auditIsServingUnit(ahu, [ahu, box]), true, 'auditIsServingUnit: AHU with a box');
t.eq(sb.auditIsServingUnit(dhw, [dhw, box]), false, 'auditIsServingUnit: domestic hot water');

// 4b. Serving rule without box rows
const ahuNb = row({ building: 'Fake Hall C', equipName: 'AHU-9', category: 'ahu', existingSchedule: { rawText: longText } });
const ervNb = row({ building: 'Fake Hall C', equipName: 'ERV-9', category: 'erv', existingSchedule: { rawText: longText } });
const rtuNb = row({ building: 'Fake Hall C', equipName: 'RTU-9', category: 'rtu', existingSchedule: { rawText: longText } });
const dhwNb = row({ building: 'Fake Hall C', equipName: 'Domestic Hot Water 9', category: 'plumbing', existingSchedule: { rawText: longText } });
const idsNb = ruleOf(run([ahuNb, ervNb, rtuNb, dhwNb]), 'schedule-extra-hours').map((x) => x.rowId);
t.ok(idsNb.indexOf(ahuNb.id) === -1, 'AHU with no box rows: no schedule finding');
t.ok(idsNb.indexOf(ervNb.id) === -1, 'ERV with no box rows: no schedule finding');
t.ok(idsNb.indexOf(rtuNb.id) !== -1, 'single-zone RTU with no boxes: schedule finding');
t.ok(idsNb.indexOf(dhwNb.id) !== -1, 'DHW with no boxes: schedule finding');

// 5. Recomputed on read, never stored
const before = Object.keys(sb.__store).length;
run([spOff, schedLong]);
t.eq(Object.keys(sb.__store).length, before, 'computing findings writes nothing');

// 6. Set points are read from the matrix, not stored
sb.__store['en_eqmatrix_900'] = JSON.stringify({ rows: [spOff], importedAt: 'x', buildings: [] });
const viaTab = sb.faSetPointRows(900);
const viaMatrix = sb.emBuildSetpointExportRows(900);
t.eq(viaTab, viaMatrix, 'Set Points view returns emBuildSetpointExportRows output');
t.ok(viaTab.length === 1 && viaTab[0].indexOf('72') !== -1, 'set point value comes from the matrix row');
sb.faEdit(900, 'auto:' + spOff.id + '::setpoint-off-standard', 'status', 'Planned');
sb.faAdd(900);
const saved = sb.__store['en_audit_900'] || '';
t.ok(saved && !/72|zoneHtg|EM_SP/i.test(saved), 'saved audit record holds no set point values');
t.eq(((sb.faLoad(900).edits['auto:' + spOff.id + '::setpoint-off-standard']) || {}).status, 'Planned', 'user edit on an automatic finding persists');
t.eq(((sb.faAllFindings(900).filter((x) => x.ruleId === 'setpoint-off-standard')[0]) || {}).status, 'Planned', 'edit shows on the recomputed finding');

// 8. A hostile finding id renders inert and still edits correctly
const evil = "x' \" ); alert(1)//";
const d8 = sb.faLoad(900);
d8.findings.push({ id: evil, rowId: null, building: 'Fake Hall A', equipment: 'Fake Unit', type: '', issueType: 'Optimization', issue: 'Hostile id', change: '', how: '', picture: '', pictureLink: '', notes: '', measureId: null, hours: null, cost: null, status: 'Open', deficiency: false, cscList: false });
sb.faSave(900, d8);
let handler = null;
let clickHandler = null;
const fakeBody = { innerHTML: '', addEventListener: (type, fn) => { if (type === 'change') handler = fn; if (type === 'click') clickHandler = fn; } };
sb.document.getElementById = () => fakeBody;
sb.faRender(900);
const html = fakeBody.innerHTML;
t.ok(html.indexOf('Hostile id') !== -1, 'hostile record is rendered');
t.ok(!/\son(change|click|input)="[^"]*alert/i.test(html), 'no handler attribute carries the id');
t.ok(!/onchange="faEdit/.test(html), 'no inline edit handler is built from data');
t.ok(html.indexOf("data-id=\"x&#39; &quot; ); alert(1)//\"") !== -1, 'id sits in an escaped data attribute');
t.ok(!/\son(change|click|input)=/i.test(html), 'no inline handler attribute anywhere (buttons, file input)');
t.ok(/data-action="add"/.test(html) && /data-action="import"/.test(html) && /data-action="view"/.test(html), 'buttons and file input use data-action');
t.ok(typeof handler === 'function' && typeof clickHandler === 'function', 'delegated change and click listeners are bound');
clickHandler({ target: { closest: () => ({ dataset: { action: 'view', pid: '900', view: 'deficiency' } }) } });
t.ok(sb._faView === 'deficiency', 'view click dispatches');
const nBefore = sb.faLoad(900).findings.length;
clickHandler({ target: { closest: () => ({ dataset: { action: 'add', pid: '900' } }) } });
t.eq(sb.faLoad(900).findings.length, nBefore + 1, 'delegated add click adds a finding');
sb.faSetView(900, 'findings');
handler({ target: { dataset: { pid: '900', id: evil, field: 'notes' }, value: 'checked' } });
t.eq(sb.faLoad(900).findings.filter((x) => x.id === evil)[0].notes, 'checked', 'delegated edit reaches the right record');

// 9. faEdit refuses unknown fields; stale auto edits are pruned
sb.faEdit(900, evil, 'issue', 'tampered');
sb.faEdit(900, 'auto:' + spOff.id + '::setpoint-off-standard', 'ruleId', 'tampered');
t.eq(sb.faLoad(900).findings.filter((x) => x.id === evil)[0].issue, 'Hostile id', 'faEdit refuses a field outside FA_EDIT_FIELDS (finding)');
t.ok(sb.faLoad(900).edits['auto:' + spOff.id + '::setpoint-off-standard'].ruleId === undefined, 'faEdit refuses a field outside FA_EDIT_FIELDS (auto edit)');
const gone = 'auto:fake-gone-row::setpoint-off-standard';
const d9 = sb.faLoad(900);
d9.edits[gone] = { status: 'Done' };
sb.faSave(900, d9);
sb.faAllFindings(900);
t.ok(sb.faLoad(900).edits[gone] === undefined, 'stale auto edit pruned when its source row is gone');
t.ok(sb.faLoad(900).edits['auto:' + spOff.id + '::setpoint-off-standard'] !== undefined, 'live auto edit kept');

// 7. One function per rule (grep)
const src = fs.readFileSync(path.join(ROOT, 'computations/audit-rules.js'), 'utf8');
const ruleFns = src.match(/^function auditRule\w+/gm) || [];
t.eq(ruleFns.length, 3, 'exactly three rule functions');
t.eq(sb.AUDIT_RULES.length, 3, 'registry lists three rules');
sb.AUDIT_RULES.forEach((r) => {
  const n = (src.match(new RegExp("id: '" + r.id + "'", 'g')) || []).length;
  t.eq(n, 1, 'rule id ' + r.id + ' appears once');
});
const appSrc = fs.readdirSync(path.join(ROOT, 'app')).filter((x) => x.endsWith('.js') && x !== 'equipment-matrix.js');
const dup = appSrc.filter((x) => /setpoint-off-standard|schedule-extra-hours|function auditRule/.test(fs.readFileSync(path.join(ROOT, 'app', x), 'utf8')));
t.eq(dup, [], 'no second copy of a rule in app/');
const faSrc = fs.readFileSync(path.join(ROOT, 'app/facility-audit.js'), 'utf8');
t.ok(!/EM_SP_DEFAULTS|zoneHtgSetpoint/.test(faSrc), 'facility-audit.js has no set point standard or point read of its own');

t.done('test-audit-rules');
