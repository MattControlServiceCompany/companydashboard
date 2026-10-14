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
ok(sb.BTU_PER_KWH === 3412.14, 'BTU_PER_KWH is the EIA 3412.14');
ok(sb.BTU_PER_THERM === 100000, 'BTU_PER_THERM');
ok(sb.KBTU_PER_KWH === 3412.14 / 1000 && sb.KBTU_PER_THERM === 100, 'kBtu factors derive from the Btu constants');
ok(near(sb.THERMS_PER_KWH, 0.0341214), 'THERMS_PER_KWH derives from BTU_PER_KWH');
ok(near(sb.KWH_PER_MMBTU, 293.071, 0.001), 'KWH_PER_MMBTU derives from BTU_PER_KWH: ' + sb.KWH_PER_MMBTU);
ok(near(sb.KWH_PER_BTU, 1 / 3412.14) && sb.THERMS_PER_MMBTU === 10 && sb.THERMS_PER_BTU === 0.00001, 'Btu factors');
ok(sb.BTU_PER_GAL_PROPANE === 91452, 'BTU_PER_GAL_PROPANE is the EIA 91,452');
ok(sb.THERMS_PER_GAL_PROPANE === 91452 / 100000 && near(sb.THERMS_PER_GAL_PROPANE, 0.91452), 'THERMS_PER_GAL_PROPANE');
ok(sb.KBTU_PER_GAL_PROPANE === 91452 / 1000 && near(sb.KBTU_PER_GAL_PROPANE, 91.452), 'KBTU_PER_GAL_PROPANE');
ok(sb.BTU_PER_HR_PER_BHP === 33475 && near(sb.THERMS_PER_HR_PER_BHP, 0.33475), 'boiler hp is 33,475 Btu/h = 0.33475 therm/h');

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
mustFail('0.91452', withLine('app/utility-data.js', 'var t = gal * 0.91452;'));
mustFail('91452', withLine('app/calculators.js', 'var b = gal * 91452;'));
mustFail('3412.14', withLine('app/calculators.js', 'var b = kwh * 3412.14;'));
mustFail('293.071', withLine('app/utility-data.js', 'var f = 293.071;'));
mustFail('0.03346 boiler hp', withLine('app/calculators.js', 'var t = bhp * 0.03346;'));
mustFail('33475', withLine('app/calculators.js', 'var t = bhp * 33475;'));
mustFail('a propane figure not derived', Object.assign({}, clean, {
  'computations/physics.js': clean['computations/physics.js'].replace('BTU_PER_GAL_PROPANE / BTU_PER_THERM', '0.9153'),
}));
mustFail('toKBtu returning', withLine('computations/rates.js', 'function toKBtu(a, b, c) { return a; }'));
mustFail('a second computeKBtu', withLine('app/calculators.js', 'function computeKBtu(a, b, c) { return a; }'));
mustFail('0.03413', withLine('app/calculators.js', 'var t = kwh * 0.03413;'));
mustFail('91.5', withLine('computations/eui.js', 'var k = gal * 91.5;'));
mustFail('100000 as Btu per therm', withLine('app/ecm-calculators.js', 'var th = btu / (100000 * afue);'));
mustFail('a literal steam factor', withLine('app/calculators.js', 'return qty * size * 0.0097;'));
mustFail('a literal Btu per lb steam', withLine('app/calculators.js', 'var h = 970.3;'));
mustFail('a literal lb/h per boiler hp', withLine('app/calculators.js', 'var l = size * 34.5;'));
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
