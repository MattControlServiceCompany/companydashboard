// tools/test-phase-dcv-wording.js: a phase with only CO2 sensor rows gets the DCV wording (2026-11-14).
// Pricing rows carry _pointKey co2_zone / co2_zone_standalone / co2_ahu, never bare 'co2'. SYNTHETIC rows only.
// Run: node tools/test-phase-dcv-wording.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const doc = { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } };
const sb = { console, window: { addEventListener() {} }, document: doc, addEventListener() {}, sget: (k, fb) => fb, sset: () => Promise.resolve() };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app/report-engine.js'), 'utf8'), sb, { filename: 'app/report-engine.js' });
let passed = 0, failed = 0;
const check = (c, m) => { c ? passed++ : failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const dcv = sb._RPT_A36_PHASE_VERBS[0].dcv;
['co2_zone', 'co2_zone_standalone', 'co2_ahu'].forEach((k) => {
  const t = sb._rptA36PhaseImprovementsText([{ phase: 1, _pointKey: k }], 0);
  check(t.toLowerCase().indexOf(dcv.toLowerCase()) !== -1, k + ' sensor row gives the DCV wording');
});
const t2 = sb._rptA36PhaseImprovementsText([{ phase: 1, _pointKey: 'dat' }], 0);
check(t2.toLowerCase().indexOf(dcv.toLowerCase()) === -1, 'a non-CO2 sensor row does not give the DCV wording');
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
