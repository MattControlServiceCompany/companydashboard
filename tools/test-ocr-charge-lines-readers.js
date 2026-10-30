// A sewer, water or franchise charge printed on 2 lines keeps each line (bill._chargeLines). SYNTHETIC text only.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');
const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
vm.createContext(sandbox);
for (const f of ['lib/formatting.js', 'app/energy-savings.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
const rule = vm.runInContext('UTILITY_RULES', sandbox).find((r) => r.name === 'City of Baldwin City');
let bad = 0;
const ok = (c, l) => (c ? console.log('PASS ' + l) : (bad++, console.error('FAIL ' + l)));
const page = (lines) =>
  '%%PAGE_2%%\n4/10/25\nACCOUNT NUMBER\nTEST UNIVERSITY/TEST GYM\nACCOUNT #: TST-0004     DUE DATE AFTER DUE DATE\nSERVICE\nADDRESS: 100 TEST ST       4/25/25  100.00  90.00\nCurrent Reading Previous Reading\n' +
  lines.join('\n') + '\nCOPY ONLY - BANK PAID\n';
const run = (l) => { const r = rule._extractPage(page(l)); return r ? (Array.isArray(r) ? r : [r]) : []; };
const by = (b, c) => b.find((x) => x.Commodity === c);
let b = run(['SW - SEWER 100 200 98 12.50', 'SW - SEWER 300 400 98 7.50', 'WA - WATER 500 600 98 30.00', 'WA - WATER 700 800 98 10.00']);
ok(JSON.stringify(by(b, 'Sewer')._chargeLines) === '{"SewerCharge":[{"charge":12.5},{"charge":7.5}]}' && by(b, 'Sewer').SewerCharge === 20, 'TST-0004 two sewer lines');
ok(JSON.stringify(by(b, 'Water')._chargeLines) === '{"WaterCharge":[{"charge":30},{"charge":10}]}' && by(b, 'Water').WaterCharge === 40, 'TST-0004 two water lines');
b = run(['SW - SEWER 100 200 98 12.50', 'WA - WATER 500 600 98 30.00']);
ok(!by(b, 'Sewer')._chargeLines && !by(b, 'Water')._chargeLines, 'TST-0004 one line each: no _chargeLines');
process.exit(bad ? 1 : 0);
