// A bill with a charge line whose quantity x rate does not give its charge is never "Ready to save". Synthetic data only.
const vm = require('vm');
const sb = require('./ocr-sandbox.js')();
let bad = 0;
const ok = (c, l) => { if (!c) { bad++; console.error('FAIL ' + l); } else console.log('PASS ' + l); };
const run = (c) => vm.runInContext(c, sb);

sb._b = { AccountNumber: 'TST-0001', Commodity: 'Electric', CustomerCharge: '10.00', TotalCurrentCharges: '10.00' };
ok(run('_pdfBillIssueItems(_b, []).length') === 0, 'a clean bill has no issue');
sb._b._part_mismatches_BilledKWCharge = [{ idx: 1, qty: 100.5, rate: 2, computed: 201, ocrCharge: 201.02, diff: 0.02 }];
const items = run('_pdfBillIssueItems(_b, [])');
ok(items.length === 1 && items[0].level === 'warn' && items[0].field === 'BilledKWCharge', 'a line mismatch is a warn issue on its field: ' + JSON.stringify(items));
ok(/Billed kW Charge/.test(items[0].text), 'the issue names the line: ' + items[0].text);
ok(run('_pdfBillStatus(_b, []).level') === 'warn', 'the bill status is warn, not ready');
sb._b._part_mismatches_BilledKWCharge = [];
ok(run('_pdfBillIssueItems(_b, []).length') === 0, 'an empty mismatch list is no issue');

console.log(bad ? bad + ' failed' : 'ALL PASS');
process.exit(bad ? 1 : 0);
