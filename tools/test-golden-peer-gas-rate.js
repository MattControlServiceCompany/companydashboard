// tools/test-golden-peer-gas-rate.js - golden known-value test. SYNTHETIC data only (fake ids, no client data).
// Run: node tools/test-golden-peer-gas-rate.js
// getPeerMonthGasRate(projId, meter, ym) (computations/rates.js:289): the current monthly gas rate for a gas meter-month with
// no use and no charge. From ZERO_USE_GAS_FROM_YM (2026-07) on. PLAIN average of the individual billed rates (gas charge /
// therms of each bill) of the other gas meters of the same provider in that month. A rate more than PEER_GAS_RATE_OUTLIER (0.1)
// from the median of those rates is left out. 0 when no peer bill has a rate.
// Every expected value is hand-computed in the comments.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-9);
function check(c, msg) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}
function loadFn(file, fnName) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp('function ' + fnName + '\\s*\\(').exec(src);
  if (!m) throw new Error('not found: ' + fnName);
  let p = src.indexOf('(', m.index),
    d = 0,
    e = p;
  for (; e < src.length; e++) {
    if (src[e] === '(') d++;
    else if (src[e] === ')' && --d === 0) break;
  }
  let i = src.indexOf('{', e);
  d = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(m.index, j + 1);
}
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const sb = { console };
sb.window = sb;
vm.createContext(sb);
sb.__bldgs = { 1: { id: 'b1', meters: [] } };
const pre = [
  'var projects = [{ id: 1, contractType: "fixedProject" }];',
  'var udSelProjId = 1;',
  'function getUDBldg(p, b){ return __bldgs[p]; }',
  'function getUDBldgs(p){ return [__bldgs[p]]; }',
  loadFn(REPO + '/app/utility-data.js', '_fixISO'),
  loadFn(REPO + '/app/utility-data.js', '_parseISO'),
  loadFn(REPO + '/app/utility-data.js', 'calcDays'),
].join('\n');
const files = ['lib/formatting.js', 'lib/date-helpers.js', 'computations/regression.js', 'computations/rates.js', 'computations/normalization.js', 'computations/csc.js', 'computations/savings.js'];
vm.runInContext([pre].concat(files.map(rd)).join('\n\n'), sb);
const ev = (e) => vm.runInContext(e, sb);

// a one-month gas bill of the given therms and gas charge
const gb = (ym, therms, gasCharge) => ({ start: ym + '-01', end: ym + '-28', therms: therms, gasCharge: gasCharge });
const gasMeter = (id, provider, bills) => ({ id, commodity: 'Gas', provider, bills });
const target = gasMeter('T', 'Acme Gas', [gb('2026-08', 100, 900)]); // the meter being priced; its own bill (rate 9.00) must never count
// set the building's meters (the target is always first) and ask the peer rate
function peerRate(peers, ym) {
  sb.__bldgs[1].meters = [target].concat(peers);
  sb.__target = target;
  return ev('getPeerMonthGasRate(1, __target, ' + JSON.stringify(ym) + ')');
}

console.log('0. constants');
check(ev('ZERO_USE_GAS_FROM_YM') === '2026-07', 'starts 2026-07');
check(ev('PEER_GAS_RATE_OUTLIER') === 0.1, 'outlier limit 0.1');

// Three same-provider peers in 2026-08, different therms so a pooled rate would differ from the plain average:
//   P1: $100 / 100 th = 1.00 ; P2: $11 / 10 th = 1.10 ; P3: $105 / 100 th = 1.05
const P1 = gasMeter('P1', 'ACME GAS ', [gb('2026-08', 100, 100)]); // provider matches with other case / trailing space
const P2 = gasMeter('P2', 'acme gas', [gb('2026-08', 10, 11)]);
const P3 = gasMeter('P3', ' Acme Gas', [gb('2026-08', 100, 105)]);

console.log('1. month before ZERO_USE_GAS_FROM_YM returns 0 even with peers');
check(peerRate([P1, P2, P3], '2026-06') === 0, '2026-06 -> 0');
check(peerRate([P1, P2, P3], '2025-12') === 0, '2025-12 -> 0');

console.log('2. plain average of the peer billed rates (not pooled), 2026-08');
// rates 1.00, 1.10, 1.05; sorted 1.00, 1.05, 1.10; median 1.05; limit 0.1 x 1.05 = 0.105; |1.00-1.05| = 0.05 and |1.10-1.05| = 0.05, both kept
// plain average = (1.00 + 1.10 + 1.05) / 3 = 3.15 / 3 = 1.05
// (a pooled rate would be (100 + 11 + 105) / (100 + 10 + 100) = 216 / 210 = 1.028571..., which must NOT be returned)
const avg3 = peerRate([P1, P2, P3], '2026-08');
check(near(avg3, 1.05, 1e-9), 'average = 1.05 (got ' + avg3 + ')');
check(!near(avg3, 216 / 210, 1e-6), 'not the pooled rate 1.028571');

console.log('3. the first month, 2026-07, is included');
const J1 = gasMeter('J1', 'Acme Gas', [gb('2026-07', 100, 80)]); // 0.80
const J2 = gasMeter('J2', 'Acme Gas', [gb('2026-07', 50, 44)]); // 0.88
// median = (0.80 + 0.88) / 2 = 0.84; limit 0.084; |0.80-0.84| = 0.04, |0.88-0.84| = 0.04, both kept; average = 0.84
check(near(peerRate([J1, J2], '2026-07'), 0.84, 1e-9), '2026-07 -> 0.84');

console.log('4. a peer more than PEER_GAS_RATE_OUTLIER from the median is excluded');
// add P5: $150 / 100 th = 1.50. Rates 1.00, 1.05, 1.10, 1.50; median = (1.05 + 1.10) / 2 = 1.075; limit 0.1 x 1.075 = 0.1075
// |1.00-1.075| = 0.075 kept; |1.05-1.075| = 0.025 kept; |1.10-1.075| = 0.025 kept; |1.50-1.075| = 0.425 EXCLUDED
// average of the kept = 3.15 / 3 = 1.05 (with the outlier it would be 4.65 / 4 = 1.1625)
const P5 = gasMeter('P5', 'Acme Gas', [gb('2026-08', 100, 150)]);
const avgOut = peerRate([P1, P2, P3, P5], '2026-08');
check(near(avgOut, 1.05, 1e-9), 'outlier excluded: 1.05 (got ' + avgOut + ')');
check(!near(avgOut, 1.1625, 1e-6), 'not the average with the outlier 1.1625');

console.log('5. other provider, other commodity, other month, zero therms: all ignored');
const OTHER = gasMeter('O', 'Different Utility', [gb('2026-08', 100, 500)]); // 5.00, other provider
const ELEC = { id: 'E', commodity: 'Electric', provider: 'Acme Gas', bills: [gb('2026-08', 100, 700)] };
const OTHERMO = gasMeter('M', 'Acme Gas', [gb('2026-09', 100, 900)]); // 9.00 in another month
const ZERO = gasMeter('Z', 'Acme Gas', [gb('2026-08', 0, 0)]); // no usage, no charge: no rate
const noisy = peerRate([P1, P2, P3, OTHER, ELEC, OTHERMO, ZERO], '2026-08');
check(near(noisy, 1.05, 1e-9), 'still 1.05 with the ignored meters present (got ' + noisy + ')');

console.log('6. no peers -> 0');
check(peerRate([], '2026-08') === 0, 'no other meter -> 0');
check(peerRate([OTHER, ELEC, OTHERMO, ZERO], '2026-08') === 0, 'only ignored meters -> 0');

console.log('7. one peer -> its own rate');
// $108 / 90 th = 1.20
check(near(peerRate([gasMeter('S', 'Acme Gas', [gb('2026-08', 90, 108)])], '2026-08'), 1.2, 1e-9), 'single peer 1.20');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
