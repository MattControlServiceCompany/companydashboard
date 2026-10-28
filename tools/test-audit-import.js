// tools/test-audit-import.js - Facility Audit workbook import. Run: node tools/test-audit-import.js
// SYNTHETIC fixtures only. With a path argument it also runs the import on a real workbook rows file
// (JSON of {sheet: rows}) and prints the counts; nothing from that file is kept.
'use strict';
const { loadAuditSandbox, makeCounter } = require('./audit-test-sandbox');
const t = makeCounter();
const sb = loadAuditSandbox();

const matrix = [
  { id: 'r1', building: 'Fake Library A', equipName: 'Zone | VAV-1-1', location: 'Meeting Room | VAV-1-1', category: 'vav' },
  { id: 'r2', building: 'Fake Library A', equipName: 'Boiler Plant', location: '', category: 'hwp' },
  { id: 'r3', building: 'Fake Library A School', equipName: 'Zone | VAV-2-1', location: '', category: 'vav' },
  { id: 'r4', building: 'Fake Library B', equipName: 'Twin', location: '', category: 'vav' },
  { id: 'r5', building: 'Fake Library B', equipName: 'Twin', location: '', category: 'vav' },
];
const head = ['Building Name', 'Building location or equipment affected', 'Type of Equipment', 'Issue Type', 'Issue', 'Type of Optimization or Change', 'How do we accomplish?', 'Picture', 'Notes/Comments', 'Does it take modifications to fix?', 'How much time to modify?', 'How much would this cost?'];
const sheets = {
  'Facility Audit List': [
    head,
    ['Fake Library A', 'Meeting Room | VAV-1-1', 'VAV', 'Optimization', 'Set point is high', 'Adjust set points.', 'Edit in BAS', 'shot-1.png; shot-2.png', 'n1', 'Yes', '2', '$150'],
    ['fake library a ', ' boiler  plant', 'Plant', 'Deficiency', 'Runtime alarm wrong', 'Fix program', '', '', '', '', '', ''],
    ['Fake Library A', 'VAV-2-1', 'VAV', 'Energy Services', 'Runs too long', 'Adjust schedules to reduce hours.', '', '', '', '', '', ''],
    ['Fake Library A', 'Unknown Room', 'VAV', 'Optimization', 'Nothing matches', '', '', '', '', '', '', ''],
    ['Fake Library B', 'Twin', 'VAV', 'Optimization', 'Two share a name', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
  ],
  'CSC Deficiency List': [
    ['Building Name', 'Building location or equipment affected', 'Issue', 'Type of Optimization or Change', 'Status'],
    ['Fake Library A', 'Boiler Plant', 'Runtime alarm wrong', 'Fix program', 'Open'],
    ['Fake Library C', 'Ghost Unit', 'Gone', 'Check', ''],
  ],
};

const res = sb.auditImportSheets(sheets, matrix, []);
t.eq(res.matched, 4, 'matched count (3 audit rows plus 1 deficiency-list row)');
t.eq(res.unmatched.length, 3, 'unmatched count');
const un = res.unmatched.map((u) => u.sheet + ':' + u.rowNum + ':' + u.reason);
t.ok(un.indexOf('Facility Audit List:5:No equipment with this name in the matrix') !== -1, 'unknown equipment is listed with a reason');
t.ok(un.indexOf('Facility Audit List:6:More than one equipment in the matrix has this name') !== -1, 'two matrix rows with one name are listed, not guessed');
t.ok(un.some((x) => x.indexOf('CSC Deficiency List:3') === 0), 'unmatched row on the second sheet is listed');
t.eq(res.findings.length, 6, 'no row dropped: every non-empty row becomes a finding (the repeat issue merges)');
const byIssue = (i) => res.findings.filter((f) => f.issue === i)[0];
t.eq(byIssue('Set point is high').rowId, 'r1', 'matched by location text');
t.eq(byIssue('Runtime alarm wrong').rowId, 'r2', 'name match ignores case and extra spaces');
t.eq(byIssue('Runs too long').rowId, 'r3', 'building match drops a trailing School; equipment matches the part after the bar');
t.eq(byIssue('Nothing matches').rowId, null, 'unmatched row stays as free text');
t.eq(byIssue('Set point is high').picture, 'shot-1.png; shot-2.png', 'picture file names kept');
t.eq([byIssue('Set point is high').hours, byIssue('Set point is high').cost], [2, 150], 'hours and cost read as numbers');
t.eq([byIssue('Runtime alarm wrong').deficiency, byIssue('Runtime alarm wrong').cscList], [true, true], 'same issue on both sheets: one record, on the deficiency list');
t.eq(res.duplicates, 1, 'one repeat merged');

// Importing again adds nothing
const again = sb.auditImportSheets(sheets, matrix, res.findings);
t.eq(again.findings.length, 0, 'second import adds no records');

// Deficiency list is a filter on the same records
const asRecords = res.findings;
t.eq(asRecords.filter(sb.faIsDeficiency).map((f) => f.issue).sort(), ['Gone', 'Runtime alarm wrong'], 'deficiency list = filter over the same records');

// Stored through the tab code: one key, nothing else
sb.__store['en_eqmatrix_901'] = JSON.stringify({ rows: matrix, importedAt: 'x', buildings: [] });
const d = sb.faLoad(901);
d.findings = res.findings;
sb.faSave(901, d);
t.eq(Object.keys(sb.__store).filter((k) => k.indexOf('en_audit_') === 0), ['en_audit_901'], 'one synced key per project');


// CSV import: same matcher as the workbook path
const csv = ['Building,location/equipment,Type of Equipment,Issue Type,Issue,Type of Optimization or Change,How do we accomplish?,Notes',
  'Fake Library A,Meeting Room | VAV-1-1,VAV,Optimization,"Set point, high",Adjust set points.,Edit in BAS,n1',
  'Fake Library A,Nowhere,VAV,Optimization,Unmatched thing,,,'].join('\n') + '\n';
const pc = sb.auditCsvToSheets(csv);
t.ok(!pc.error, 'CSV with the columns parses');
const cres = sb.auditImportSheets(pc.sheets, matrix, []);
t.eq([cres.matched, cres.unmatched.length, cres.findings.length], [1, 1, 2], 'CSV rows go through the same matcher');
t.eq(cres.findings.filter((f) => f.issue === 'Set point, high')[0].rowId, 'r1', 'CSV quoted comma kept, row matched');
const bad = sb.auditCsvToSheets('Name,Value\nA,1\n');
t.ok(bad.error && bad.error.indexOf('Type of Optimization or Change') !== -1 && bad.error.indexOf('How do we accomplish?') !== -1, 'wrong CSV columns give a message naming the expected columns');
t.ok(sb.auditCsvToSheets('').error, 'empty CSV gives the message');
const miss = sb.auditCsvToSheets('Building,Issue\nA,b\n');
t.ok(miss.error, 'CSV with missing columns gives the message');

// Banner: only on the render right after an import; never stored
t.ok(sb._faImportReview(cres).indexOf('Import: 1 matched') !== -1, 'banner shows for a fresh import result');
t.eq(sb._faImportReview(undefined), '', 'no banner when no import just ran');
t.eq(sb.window._faLastImport, undefined, 'import result is not kept on window');

// Real workbook rows (optional)
if (process.argv[2]) {
  const real = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const rm = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8'));
  const rr = sb.auditImportSheets(real, rm, []);
  console.log('REAL workbook: matched ' + rr.matched + ', unmatched ' + rr.unmatched.length + ', records ' + rr.findings.length + ', merged repeats ' + rr.duplicates);
}

t.done('test-audit-import');
