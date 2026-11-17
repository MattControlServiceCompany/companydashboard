// _a36DetMergeShareSentences: sentences in a row with the same "On N of the M units," start become one sentence; a share of one unit reads
// "One of the 3 exhaust fans runs ..." (Audit Report review, 2026-11-17).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'report-engine.js'), 'utf8');
const fn = src.match(/function _a36DetMergeShareSentences\([\s\S]*?\n}\r?\n/)[0];
const merge = new Function(fn + '; return _a36DetMergeShareSentences;')();
let fail = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; }
const t = (arr) => merge(arr.map((x) => (typeof x === 'string' ? { fn: 'seq', text: x } : x))).map((s) => s.text);

const three = t([
  'Each unit follows the occupied schedule.',
  'On 8 of the 17 units, the unit changes between heating and cooling automatically.',
  'On 8 of the 17 units, the fan speed follows the zone load.',
  'On 8 of the 17 units, the unit can start the fan on a request.',
]);
ok(three.length === 2 && three[1] === 'On 8 of the 17 units, the unit changes between heating and cooling automatically; the fan speed follows the zone load; and the unit can start the fan on a request.', 'three sentences with one share become one: ' + three[1]);
ok(t(['On 1 of the 3 exhaust fans, the exhaust fan runs on the occupancy status of its area.'])[0] === 'One of the 3 exhaust fans runs on the occupancy status of its area.', 'share of one: no repeated noun');
const diff = t(['On 1 of the 4 heaters, the heater turns on with demand.', 'On 2 of the 4 heaters, the heater has a lockout.']);
ok(diff.length === 2, 'different shares stay separate');
const fns = merge([{ fn: 'a', text: 'On 2 of the 5 units, x.' }, { fn: 'b', text: 'On 2 of the 5 units, y.' }]);
ok(fns.length === 2, 'different paragraph parts stay separate');
ok(t(['The plant has a lockout.'])[0] === 'The plant has a lockout.', 'other sentences unchanged');
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
