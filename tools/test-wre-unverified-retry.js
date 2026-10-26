/**
 * test-wre-unverified-retry.js
 *
 * Standalone test (no browser). Synthetic data only (fake ids).
 * An MMbtu value that is kept but unverified (_mmbtuUnverified) must:
 *   1. keep its review flag when the retry merge runs (app/bill-analysis.js),
 *   2. not count as "validated" when it comes from a retry candidate,
 *   3. survive save: listed in the save-field gate and written by every row builder.
 * The retry merge loop is cut out of the REAL source and run in a vm (no copy of the rule).
 *
 * Usage: node tools/test-wre-unverified-retry.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app', 'bill-analysis.js'), 'utf8').split('\r\n').join('\n');
let pass = 0,
  fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name);
}

// Cut the pair loop out of the real source by brace matching.
const startMark = 'for (let bi = 0; bi < retryBills.length; bi++) {';
const i0 = src.indexOf(startMark);
if (i0 < 0) throw new Error('retry merge loop not found');
let depth = 0,
  i1 = -1;
for (let i = i0 + startMark.length - 1; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) {
    i1 = i + 1;
    break;
  }
}
const loopSrc = src.slice(i0, i1);

function runMerge(origArr, retryArr) {
  const sb = { retryBills: origArr, retryCheck: retryArr, _mergeIdentityConflict: () => false };
  vm.createContext(sb);
  vm.runInContext(loopSrc, sb);
  return origArr;
}

console.log('retry merge keeps the review flag on an unverified value');
{
  const orig = {
    AccountNumber: '90000a',
    NaturalGasMMbtu: '5.95',
    _manualReview: true,
    _manualReviewLabel: 'MMbtu not confirmed',
    _mmbtuUnverified: true,
  };
  const retry = { AccountNumber: '90000a', NaturalGasMMbtu: '5.95' };
  runMerge([orig], [retry]);
  check('_manualReview still true', orig._manualReview === true);
  check('label kept', orig._manualReviewLabel === 'MMbtu not confirmed');
}

console.log('control: a plain stale flag is still cleared');
{
  const orig = { AccountNumber: '90000b', GasCharge: 10, _manualReview: true, _manualReviewLabel: 'x' };
  runMerge([orig], [{ AccountNumber: '90000b' }]);
  check('cleared when nothing guards it', orig._manualReview === false);
}

console.log('an unverified retry value is not validated');
{
  const orig = { AccountNumber: '90000c', NaturalGasMMbtu: null, _mmbtuRateMismatch: true, _manualReview: true };
  const retry = { AccountNumber: '90000c', NaturalGasMMbtu: '5.95', _mmbtuUnverified: true, _manualReview: true };
  runMerge([orig], [retry]);
  check('value not filled', orig.NaturalGasMMbtu === null);
  check('mismatch flag not cleared', orig._mmbtuRateMismatch === true);
  check('review flag kept', orig._manualReview === true);
}

console.log('a validated retry value still fills the site');
{
  const orig = { AccountNumber: '90000d', NaturalGasMMbtu: null, _mmbtuRateMismatch: true, _manualReview: true };
  const retry = { AccountNumber: '90000d', NaturalGasMMbtu: '9.99' };
  runMerge([orig], [retry]);
  check('value filled', orig.NaturalGasMMbtu === '9.99');
  check('mismatch cleared', orig._mmbtuRateMismatch === false);
}

console.log('saved row keeps _mmbtuUnverified');
{
  const gate = fs.readFileSync(path.join(root, 'computations', 'bill-save-fields.gate.js'), 'utf8');
  check('listed in save-field gate', /'_mmbtuUnverified',/.test(gate));
  const n = (re) => (src.match(re) || []).length;
  const mism = n(/_mmbtuRateMismatch: \w+\._mmbtuRateMismatch \|\| undefined,/g);
  const unv = n(/_mmbtuUnverified: \w+\._mmbtuUnverified \|\| undefined,/g);
  check('every row builder that copies _mmbtuRateMismatch copies _mmbtuUnverified (' + unv + '/' + mism + ')', mism >= 3 && unv === mism);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
