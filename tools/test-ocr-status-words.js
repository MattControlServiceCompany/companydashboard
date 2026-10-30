// Items #22 and #23: an error shows its reason; the "fixed" chip names the fixed values.
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const w = sb.get('_pdfTypeWords');
ok(w({ comm: 'Water', level: 'err', reason: 'No matching meter' }) === 'Water · No matching meter', 'error shows the reason');
ok(w({ comm: 'Water', level: 'err', reason: '' }) === 'Water · needs a fix', 'error without reason still explains');
ok(w({ comm: 'Gas', level: 'warn' }) === 'Gas (check)' && w({ comm: 'Gas', level: '' }) === 'Gas', 'check and ok unchanged');
const t = sb.get('_pdfFixedTitle');
ok(t(['Rate', 'Total']) === 'The reader changed: Rate, Total', 'fixed chip lists the values');
ok(/Values the reader changed/.test(t([])), 'empty list keeps the old hover');
const src = require('fs').readFileSync(__dirname + '/../app/bill-analysis.js', 'utf8');
ok(!/' \(error\)'|' · error'/.test(src), 'no bare "(error)" label left');
process.exit(bad ? 1 : 0);
