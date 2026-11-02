/**
 * test-report-degree-day-text.js
 * The "Understanding Degree Days" explainer must be CSC's own wording: old copied sentences gone,
 * new examples present. Source-text check, no browser, no data.
 * Usage: node tools/test-report-degree-day-text.js
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'report-engine.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
[
  'measure of relative heating and cooling energy required by buildings',
  'Average daily temperature = 80',
  'Why not use average temperature instead of degree days',
  'highs and lows cancel each other out',
  'A warm day (80 average temp)',
].forEach((t) => ok(!src.includes(t), 'old sentence gone: ' + t));
['72 &minus; 60 = 12 CDD', '60 &minus; 38 = 22 HDD', 'balance point of 60&deg;F'].forEach((t) =>
  ok(src.includes(t), 'new text present: ' + t));
process.exit(fails ? 1 : 0);
