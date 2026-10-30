// Item #3: the Create button says what it will create (meter, project, building).
const sb = require('./ocr-sandbox.js')();
const f = sb.get('_mbCreateWords');
let bad = 0;
const eq = (a, e, l) => { if (a !== e) { bad++; console.error('FAIL ' + l + ': ' + a); } else console.log('PASS ' + l); };
const bill = { Commodity: 'Water', AccountNumber: 'TST-0001', ServiceAddress: '1 Test Dr' };
eq(f(bill, { proj: { name: 'Synth Project' }, bldg: null }), 'New Water meter for account TST-0001 in Synth Project, on building Unmatched Bills', 'no building');
eq(f(bill, { proj: { name: 'Synth Project' }, bldg: { name: 'Synth Hall' } }), 'New Water meter for account TST-0001 in Synth Project, on building Synth Hall', 'chosen building');
process.exit(bad ? 1 : 0);
