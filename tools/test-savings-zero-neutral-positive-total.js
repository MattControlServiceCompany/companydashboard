// tools/test-savings-zero-neutral-positive-total.js - synthetic values only.
// Run: node tools/test-savings-zero-neutral-positive-total.js
// 1. savingsSignColor (computations/savings.js): green only for > 0, red only for < 0, neutral for 0.
// 2. sumPositiveSavings: totals only the positive values.
// 3. The Energy Graphics quarterly table and the Project Performance panel call those two helpers.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const REPO = path.join(__dirname, '..');
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log('  FAIL: ' + m); } };
function fnSrc(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1);
  }
}
const sav = path.join(REPO, 'computations', 'savings.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fnSrc(sav, 'savingsSignColor') + '\n' + fnSrc(sav, 'sumPositiveSavings'), ctx);
const c = (v) => ctx.savingsSignColor(v, 'G', 'R', 'N');
ok(c(0) === 'N', '0 is neutral');
ok(c(0.4 - 0.4) === 'N', 'computed zero is neutral');
ok(c(Math.round(0.3)) === 'N', 'rounds-to-zero value passed rounded is neutral');
ok(c(5) === 'G', 'positive is green');
ok(c(-5) === 'R', 'negative is red');
ok(c(null) === 'N' && c(undefined) === 'N', 'null/undefined neutral');
ok(ctx.sumPositiveSavings([100, -40, 25.5, 0, -1]) === 125.5, 'positive-only sum');
ok(ctx.sumPositiveSavings([-1, -2]) === 0, 'all negative sums to 0');
ok(ctx.sumPositiveSavings([]) === 0, 'empty sums to 0');
const gfx = fs.readFileSync(path.join(REPO, 'app', 'graphics-setpoints.js'), 'utf8');
ok(/const savColor = savingsSignColor\(Math\.round\(costSav\)/.test(gfx), 'quarterly table uses savingsSignColor');
ok(!/costSav >= 0 \? 'var\(--green\)'/.test(gfx), 'old >= 0 green rule is gone from the quarterly table');
const ud = fs.readFileSync(path.join(REPO, 'app', 'utility-data.js'), 'utf8');
ok(/Total of positive savings only/.test(ud) && /sumPositiveSavings\(bRows\.map/.test(ud), 'Project Performance has the positive-only total row');
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
