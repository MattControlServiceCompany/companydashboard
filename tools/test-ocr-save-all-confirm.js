// Item #4: Save All asks once before it changes saved bills that differ.
const fs = require('fs');
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const count = sb.get('_mbCountSavedChanges');
const words = sb.get('_mbOverwriteWords');
const view = { 0: { diffFields: [{ key: 'a' }] }, 1: { diffFields: [] }, 2: { diffFields: [{ key: 'b' }], action: 'skip' }, 3: { diffFields: [{ key: 'c' }] } };
ok(count([0, 1, 2, 3, 4], view) === 2, 'counts only differing, not skipped, rows to save');
ok(count([1, 4], view) === 0, 'no differing rows gives 0');
ok(words(5).startsWith('5 saved bills have different values') && words(1).startsWith('1 saved bill has'), 'words give the count');
const src = fs.readFileSync(__dirname + '/../app/bill-analysis.js', 'utf8');
const a = src.indexOf('_mbCountSavedChanges(toSave');
const b = src.indexOf('_mbSaveAllInProgress = true;', a);
ok(a > 0 && b > a && src.slice(a, b).includes('confirm('), 'confirm comes before the save loop');
process.exit(bad ? 1 : 0);
