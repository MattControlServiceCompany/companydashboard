// tools/test-physics-single-source.js - computations/physics.js: the one fan affinity rule, the one duct static
// reset rule, the unit constants, and proof that tools/gate-single-physics.js fails on a second copy.
// Run: node tools/test-physics-single-source.js
// Synthetic numbers only.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-12 : tol);

const sb = {};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/physics.js'), 'utf8'), sb);

// ---- constants ----
ok(sb.KW_PER_HP === 0.746, 'KW_PER_HP');
ok(sb.BTU_PER_KWH === 3412, 'BTU_PER_KWH');
ok(sb.BTU_PER_THERM === 100000, 'BTU_PER_THERM');
ok(sb.KBTU_PER_KWH === 3.412 && sb.KBTU_PER_THERM === 100, 'kBtu factors equal the old literals bit for bit');
ok(sb.KBTU_PER_GAL_PROPANE === 91.5, 'KBTU_PER_GAL_PROPANE');
ok(sb.THERMS_PER_GAL_PROPANE === 0.9153, 'THERMS_PER_GAL_PROPANE');
ok(near(sb.THERMS_PER_KWH, 0.03412), 'THERMS_PER_KWH');

// ---- fanPowerFraction ----
ok(sb.fanPowerFraction(1) === 1, 'full speed is full power');
ok(sb.fanPowerFraction(0.5) === Math.pow(0.5, 3), 'half speed with the default exponent is one eighth');
ok(sb.fanPowerFraction(0.5, { exponent: 2.5 }) === Math.pow(0.5, 2.5), 'explicit exponent');
ok(sb.fanPowerFraction(0.2, { minSpeed: 0.4 }) === Math.pow(0.4, 3), 'speed below the floor runs at the floor');
ok(sb.fanPowerFraction(0.8, { minSpeed: 0.4 }) === Math.pow(0.8, 3), 'speed above the floor is unchanged');
ok(near(sb.fanPowerFraction(0.5, { fixedShare: 0.1 }), 0.1 + 0.9 * 0.125), 'fixed share does not fall with speed');
ok(sb.fanPowerFraction(0, { fixedShare: 0.1 }) === 0.1, 'stopped fan with a fixed share');

// ---- hpToKw ----
ok(sb.hpToKw(10) === 10 * 0.746, 'shaft kW');
ok(sb.hpToKw(10, 0.91) === (10 * 0.746) / 0.91, 'input kW with motor efficiency, same operation order as the old code');

// ---- ductStaticResetPowerSavings: the old BAS Trends rule, 20 percent pressure cut ----
const oldDsp = 1 - Math.pow(Math.sqrt(1 - 0.2), 3);
ok(sb.ductStaticResetPowerSavings(0.2) === oldDsp, 'duct static reset equals the old inline value ' + oldDsp);
ok(near(oldDsp, 0.2845, 0.0005), 'a 20 percent pressure cut saves about 28 percent of fan power');
ok(sb.ductStaticResetPowerSavings(0) === 0, 'no reset, no saving');
ok(sb.ductStaticResetPowerSavings(0.2, { minSpeed: 0.95 }) < oldDsp, 'a speed floor lowers the saving');

// ---- the gate: clean tree passes, each kind of second copy fails ----
const gate = require('./gate-single-physics.js');
const clean = gate.readRepo(REPO);
ok(gate.check(clean).length === 0, 'gate passes on this tree: ' + gate.check(clean).slice(0, 3).join(' | '));
const withLine = (file, line) => Object.assign({}, clean, { [file]: clean[file] + '\n' + line + '\n' });
const mustFail = (name, files) => ok(gate.check(files).length > 0, 'gate fails on ' + name);
mustFail('Math.pow(x, 3) in a template', withLine('app/ecm-calculators.js', 'var p = Math.pow(speed, 3);'));
mustFail('x ** 3', withLine('app/calculators.js', 'var p = speed ** 3;'));
mustFail('x * x * x', withLine('app/calculators.js', 'var p = spd * spd * spd;'));
mustFail(
  'Math.pow with the exponent name',
  withLine('app/bas-trends.js', 'var p = Math.pow(s, FAN_AFFINITY_EXPONENT);'),
);
mustFail('a second static reset formula', withLine('app/bas-trends.js', 'var s = Math.sqrt(1 - reduction);'));
mustFail('0.746', withLine('app/calculators.js', 'var kw = hp * 0.746;'));
mustFail('3412', withLine('app/ecm-calculators.js', 'var k = btu / 3412;'));
mustFail('3.412', withLine('app/report-engine.js', 'var k = kwh * 3.412;'));
mustFail('0.9153', withLine('app/utility-data.js', 'var t = gal * 0.9153;'));
mustFail('0.03413', withLine('app/calculators.js', 'var t = kwh * 0.03413;'));
mustFail('91.5', withLine('computations/eui.js', 'var k = gal * 91.5;'));
mustFail('100000 as Btu per therm', withLine('app/ecm-calculators.js', 'var th = btu / (100000 * afue);'));
mustFail('a second fanPowerFraction', withLine('app/bas-trends.js', 'function fanPowerFraction(s) { return s; }'));
const noPhys = Object.assign({}, clean);
delete noPhys['computations/physics.js'];
mustFail('a missing physics.js', noPhys);
ok(
  gate.check(withLine('app/audit-estimate.js', 'var r = Math.round(v * 100000) / 100000;')).length === 0,
  'gate leaves a five-decimal rounding alone',
);
ok(
  gate.check(withLine('app/calculators.js', 'var a = Math.pow(10, 2); var b = Math.pow(x, 13);')).length === 0,
  'gate leaves other powers alone',
);

console.log('\ntest-physics-single-source: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
