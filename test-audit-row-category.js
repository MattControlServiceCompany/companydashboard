// Row category for the audit count: heating / plant equipment is equipment; monitors, detectors and
// water meters are points / meters, never units. Loads the REAL emParseEquipBaseName. SYNTHETIC names only.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/app/equipment-matrix.js', 'utf8');
const start = src.indexOf('function emParseEquipBaseName(');
let i = src.indexOf('{', start), depth = 0, end = i;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(start, end + 1), ctx);
const cat = (n) => ctx.emParseEquipBaseName(n);
// equipment
assert.strictEqual(cat('Baseboard Heaters Zone 1-1'), 'heater');
assert.strictEqual(cat('Book Drop Heaters'), 'heater');
assert.strictEqual(cat('First Floor Perimeter Heat'), 'heater');
assert.strictEqual(cat('Aerco Integration'), 'hwp');
assert.strictEqual(cat('Hot Water - Site 1'), 'plumbing');
assert.strictEqual(cat('Hot Water Plant A Boiler 1'), null); // real plant keeps its own rule
// points and meters on a unit: one rule, emPointOrMeterKind (does not change the stored category)
const kind = require('./test-em-point-kind-helper.js');
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
