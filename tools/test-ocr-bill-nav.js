// Item #12: the multi-account view opens on Bill 1 and has Previous / Next.
const fs = require('fs');
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
// 3 synthetic bills; the bill numbers (rows order) are set as the review would set them.
sb.window._pdfMultiBills = [{ AccountNumber: 'TST-0003' }, { AccountNumber: 'TST-0001' }, { AccountNumber: 'TST-0002' }];
sb.vm = require('vm');
require('vm').runInContext('_mbRowOrder = {0:3,1:1,2:2}', sb);
ok(sb.get('_mbBillIdxAtNo')(1) === 1 && sb.get('_mbBillIdxAtNo')(3) === 0 && sb.get('_mbBillIdxAtNo')(9) === -1, 'bill number to index');
const step = sb.get('_mbStepButtons');
const first = step(1, 3), last = step(0, 3), mid = step(2, 3);
ok(/disabled title="Previous bill"/.test(first) && !/disabled title="Next bill"/.test(first), 'first bill: Previous off, Next on');
ok(/disabled title="Next bill"/.test(last) && !/disabled title="Previous bill"/.test(last), 'last bill: Next off, Previous on');
ok(!/disabled/.test(mid), 'middle bill: both on');
// stepping goes to the neighbour by bill number
let went = null;
sb.selectMultiBill = (i) => (went = i);
require('vm').runInContext('selectMultiBill = function(i){ globalThis.__w = i; }; _pdfCommOf = function(){return "x"};', sb);
sb.get('_mbStepBill')(1, 1);
ok(sb.__w === 2 || (sb.window && sb.__w === 2) || require('vm').runInContext('globalThis.__w', sb) === 2, 'Next from Bill 1 opens Bill 2');
const src = fs.readFileSync(__dirname + '/../app/bill-analysis.js', 'utf8');
ok(/_mbBillIdxAtNo\(1\)/.test(src), 'extraction opens on Bill 1');
process.exit(bad ? 1 : 0);
