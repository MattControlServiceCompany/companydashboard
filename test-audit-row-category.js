// Row category for the audit count: heating / plant equipment is equipment; monitors, detectors and
// water meters are points / meters, never units. Loads the REAL emParseEquipBaseName. SYNTHETIC names only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/equipment-matrix.js', 'utf8');
const start = src.indexOf('function emParseEquipBaseName(');
let i = src.indexOf('{', start), depth = 0, end = i;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(start, end + 1), ctx);
const cat = (n) => ctx.emParseEquipBaseName(n);
// the stored category rule must NOT move these rows (pricing = origin/main)
['Baseboard Heaters Zone 1-1', 'Book Drop Heaters', 'First Floor Perimeter Heat', 'Aerco Integration', 'Hot Water - Site 1']
  .forEach((n) => assert.strictEqual(cat(n), null, n));
// audit-only unit rule: heating / plant rows are counted with the closest category
const unit = require('./test-em-point-kind-helper.js');
assert.strictEqual(unit('Baseboard Heaters Zone 1-1', 'monitoring'), 'heater');
assert.strictEqual(unit('Book Drop Heaters', 'monitoring'), 'heater');
assert.strictEqual(unit('First Floor Perimeter Heat', 'other'), 'heater');
assert.strictEqual(unit('Aerco Integration', 'other'), 'hwp');
assert.strictEqual(unit('Glycol Feeder', 'other'), 'plumbing');
assert.strictEqual(unit('Hot Water - Site 1', 'other'), 'plumbing');
assert.strictEqual(unit('Hot Water Plant A Boiler 1', 'boiler'), 'boiler');
assert.strictEqual(unit('Glycol Feeder Monitor', 'plumbing'), 'monitoring');
assert.strictEqual(unit('VRF-02 CO2 Monitoring', 'vrf'), 'monitoring');
assert.strictEqual(unit('AHU-1', 'ahu'), 'ahu');
// points and meters on a unit: one rule, emPointOrMeterKind (does not change the stored category)
const kind = require('./test-em-point-kind-helper.js').kind;
assert.strictEqual(kind('VRF-02 CO2 Monitoring'), 'monitoring');
assert.strictEqual(kind('AC-1A Monitor'), 'monitoring');
assert.strictEqual(kind('Glycol Feeder Monitor'), 'monitoring');
assert.strictEqual(kind('Sump Pump Pit Leak Detector'), 'monitoring');
assert.strictEqual(kind('Domestic Water Meter - Central'), 'meter');
assert.strictEqual(kind('Hot Water Makeup Water Meter'), 'meter');
assert.strictEqual(kind('Baseboard Heaters Zone 1-1'), null);
assert.strictEqual(kind('VRF Outdoor Unit 3'), null);
// real units untouched
assert.strictEqual(cat('VRF Outdoor Unit 3'), 'vrf');
assert.strictEqual(cat('AC-2'), 'ac');
console.log('audit row category tests ok');
