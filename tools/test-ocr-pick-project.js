// Item #13: the pick-meter list shows only the project the file goes to.
const vm = require('vm');
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const list = [{ id: 1, name: 'Synth A' }, { id: 2, name: 'Synth B' }, { id: 3, name: 'Synth C' }];
const f = sb.get('_mbPickProjects');
ok(f(list, 2, '').map((p) => p.id).join() === '2', 'only the file project');
ok(f(list, 2, 3).map((p) => p.id).join() === '2,3', 'a project already picked stays');
ok(f(list, null, '').length === 3, 'no known project: all listed');
vm.runInContext("udSelProjId = null; _mbRowTargets = {0:{projId:7,matchType:'identity'},1:{projId:9,matchType:'create'}}; window._pdfQueue = null;", sb);
ok(sb.get('_mbFileProjId')() === 7, 'file project = project of a matched bill');
vm.runInContext("window._pdfQueue = {batchProjId: 5};", sb);
ok(sb.get('_mbFileProjId')() === 5, 'batch project wins');
process.exit(bad ? 1 : 0);
