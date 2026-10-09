/**
 * test-wre-engine-fixes.js
 *
 * Standalone test (no browser) for the gas supplier (WRE) bill-reading fixes in
 * app/energy-savings.js and app/bill-analysis.js. The text below is SYNTHETIC:
 * invented names, ids and amounts in the same layout as a real invoice.
 *
 * Items covered:
 *   971c60d2  component line loses its decimal point ("6003" for "60.03")
 *   3f7873d6  garbled component line must not null a Sub-Total that its own rate confirms
 *   899011fd  Sub-Total garbled, components confirm the usage -> recover instead of null
 *   29ecdb43  a value taken from another OCR pass meets the same checks as a primary value
 *   5a5973d4  a missing "Service Address:" line must not shift later sites
 *   985847a7  invoice total read with the plain 2-decimal form
 *   1ac41b84  usage-only row is real data (NaturalGasMMbtu is a key field)
 *   0a852285  site-count gate is per customer
 *
 * Usage: node tools/test-wre-engine-fixes.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'lib', 'formatting.js'), 'utf8'), sandbox, {
  filename: 'formatting.js',
});
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'energy-savings.js'), 'utf8'), sandbox, {
  filename: 'energy-savings.js',
});
const PROVIDER = 'Wood River Energy';
const wre = vm.runInContext('UTILITY_RULES', sandbox).find((r) => r.name === PROVIDER);
if (!wre) throw new Error('WRE rule not found');

// The gate and key-field functions live in bill-analysis.js, which is too large to load.
// Cut the exact source text of each function and run it, so the real code is tested.
const baSrc = fs.readFileSync(path.join(root, 'app', 'bill-analysis.js'), 'utf8').replace(/\r\n/g, '\n');
function cut(startMarker, endMarker) {
  const a = baSrc.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = baSrc.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return baSrc.slice(a, b);
}
const gateCtx = vm.createContext({});
vm.runInContext(
  cut('function _wreExpectedSiteCount', '// FIX (fix/bill-review-gate-lifecycle') +
    cut('function _billHasKeyField', 'function _unmatchedToSyntheticBills'),
  gateCtx,
);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' | ' + detail : ''));
  }
}

const HEAD = [
  '%%PAGE_1%%',
  'Natural Gas Invoice',
  'Customer #: 10001',
  'Example District 100 Invoice #: 90003',
  'Production Month: September 2030',
  'Bill Date: 01/10/2030',
  'Item Mmbtu Fuel Rate £',
];
const TAIL = ['Mmbtu Fuel £', 'Total Natural Gas: 100.00 1.00 £500.00', 'Total Fees: £0.00', 'Total Tax: £0.00'];
function site(n, lines, withAddress = true) {
  const out = [];
  if (withAddress)
    out.push('Service Address: Site ' + n + ' - ' + n + ' Alpha St Acct/Meter: 90' + n + '/M000' + n + 'X');
  out.push('Sampletown, ZZ 00000 Pipeline: Example Pipe', 'Utility: Example Utility');
  return out.concat(lines);
}
const doc = (sites, tail = TAIL) => HEAD.concat(...sites, tail).join('\n');

// A plain site with a rate on both components, used as the invoice "rate witness".
const plain = (n) => site(n, ['Index (FOM) 10.00 0.10 £3.1900 £32.22', 'Sub-Total: 10.00 0.10 £32.22']);

// --- 971c60d2 ---
console.log('971c60d2 component line without its decimal point');
{
  const text = doc([
    plain(1),
    site(2, [
      'Trigger - Fixed 11.20 0.12 £5.1700 £58.45',
      'Index(bfOM) 6003 067 £50550 £304.85',
      'Sub-Total: 71.23 0.79 £363.30',
    ]),
  ]);
  const r = wre.extractAll(text);
  check('Index MMbtu repaired to 60.03', r[1]._wreIndexMMbtu === '60.03', 'got ' + r[1]._wreIndexMMbtu);
  check('Sub-Total usage ships', r[1].NaturalGasMMbtu === '71.23', 'got ' + r[1].NaturalGasMMbtu);
  check('not held for review', !r[1]._manualReview);
  check('repair is recorded', r[1]._wreComponentDecimalRepaired === 'indexMMbtu');
  // A legal whole number is not touched: 100.00 prints as 100.
  const t2 = doc([plain(1), site(2, ['Index (FOM) 100.00 1.00 £3.1900 £322.19', 'Sub-Total: 100.00 1.00 £322.19'])]);
  const r2 = wre.extractAll(t2);
  check('real 100.00 is not divided', r2[1]._wreIndexMMbtu === '100' && r2[1].NaturalGasMMbtu === '100');
}

// --- 3f7873d6 ---
console.log('3f7873d6 garbled component line, clean Sub-Total');
{
  const text = doc([
    plain(1),
    plain(2),
    site(3, ['Index(FOM) 4095 081 £31000 £161.07', 'Sub-Total: 49.95 0.81 £161.92']),
  ]);
  const r = wre.extractAll(text);
  check('Sub-Total usage 49.95 ships', r[2].NaturalGasMMbtu === '49.95', 'got ' + r[2].NaturalGasMMbtu);
  check('charge unchanged', r[2].GasCharge === 161.92);
  check('not held for review', !r[2]._manualReview);
  check('marked component line garbled', r[2]._wreComponentLineGarbled === true);
  // Control: Sub-Total that its rate does NOT confirm stays null and held.
  const bad = doc([
    plain(1),
    plain(2),
    site(3, ['Index(FOM) 4095 081 £31000 £161.07', 'Sub-Total: 94.95 0.81 £161.92']),
  ]);
  const rb = wre.extractAll(bad);
  check('unconfirmed Sub-Total stays null and held', rb[2].NaturalGasMMbtu === null && rb[2]._manualReview === true);
}

// --- 899011fd ---
console.log('899011fd Sub-Total garbled, components confirm the usage');
{
  const text = doc([
    plain(1),
    site(2, [
      'Trigger - Fixed 4.00 0.04 £5.1700 £20.90',
      'Index (FOM) 9.00 0.09 £3.7000 £33.69',
      'Sub-Total: 31.00 0.13 £54.59',
    ]),
  ]);
  const r = wre.extractAll(text);
  check('usage rebuilt from the components (13)', r[1].NaturalGasMMbtu === '13', 'got ' + r[1].NaturalGasMMbtu);
  check('marked as rebuilt', r[1]._wreUsageFromComponents === true);
  check('not held for review', !r[1]._manualReview);
  // Control: a component charge is missing, so the charges do not add up to the Sub-Total.
  const lost = doc([
    plain(1),
    site(2, [
      'Trigger - Fixed 4.00 0.04 £5.1700 £20.90',
      'Index (FOM) 9.00 0.09 £3.7000',
      'Sub-Total: 31.00 0.13 £54.59',
    ]),
  ]);
  const rl = wre.extractAll(lost);
  check('charges that do not add up are not rebuilt', rl[1].NaturalGasMMbtu === null && rl[1]._manualReview === true);
}

// --- 29ecdb43 ---
console.log('29ecdb43 value from another OCR pass');
{
  const primary = doc([plain(1), site(2, ['Index (FOM) garbled', 'Sub-Total: ---'])]);
  const alt = doc([plain(1), site(2, ['Index (FOM) garbled', 'Sub-Total: 6557 1.06 £214.55'])]);
  sandbox.window._pdfOcrPasses = { 1: [{ text: alt }] };
  const r = wre.extractAll(primary);
  delete sandbox.window._pdfOcrPasses;
  check('charge recovered from the other pass', r[1].GasCharge === 214.55, 'got ' + r[1].GasCharge);
  check(
    'bare-digit usage from the other pass is not shipped unchecked',
    r[1].NaturalGasMMbtu === null,
    'got ' + r[1].NaturalGasMMbtu,
  );
  check('and is held for review', r[1]._manualReview === true);
  // Same site read directly on the primary pass gives the same answer.
  const direct = wre.extractAll(alt);
  check('same result as a primary read', direct[1].NaturalGasMMbtu === null && direct[1]._manualReview === true);
}

// --- 5a5973d4 ---
console.log('5a5973d4 missing Service Address line');
{
  const text = doc([
    site(1, ['Index (FOM) 3.00 0.03 £3.1900 £9.67', 'Sub-Total: 3.00 0.03 £9.67']),
    site(2, ['Index (FOM) 20.00 0.20 £3.1900 £64.44', 'Sub-Total: 20.00 0.20 £64.44'], false),
    site(3, ['Index (FOM) 30.00 0.30 £3.1900 £96.66', 'Sub-Total: 30.00 0.30 £96.66']),
  ]);
  const r = wre.extractAll(text);
  check('three sites found', r.length === 3, 'got ' + r.length);
  check('site 1 not overwritten', r[0].NaturalGasMMbtu === '3' && r[0].GasCharge === 9.67);
  check('site 2 keeps its own values', r[1].NaturalGasMMbtu === '20' && r[1].GasCharge === 64.44);
  check('site 3 stays at position 3', /Site 3/.test(r[2].ServiceAddress || '') && r[2].NaturalGasMMbtu === '30');
  check('site 2 has no invented address', !r[1].ServiceAddress);
}

// --- 985847a7 ---
console.log('985847a7 invoice total, plain 2-decimal form');
{
  const text = doc([plain(1)], ['Total Fees: £0.00', 'Total Current Charges: £32.22']);
  const r = wre.extractAll(text);
  check('summary total read', r[0]._wreSummaryTotal === '32.22', 'got ' + r[0]._wreSummaryTotal);
}

// --- 1ac41b84 ---
console.log('1ac41b84 usage-only row is real data');
{
  check('usage only counts as a key field', gateCtx._billHasKeyField({ NaturalGasMMbtu: '12.5' }) === true);
  check('empty row does not', gateCtx._billHasKeyField({}) === false);
  check('null row does not', gateCtx._billHasKeyField(null) === false);
  check(
    'recovery path accepts an account-only row',
    gateCtx._unmatchedRecoveryHasKeyField({ AccountNumber: 'A1' }) === true,
  );
}

// --- 0a852285 ---
console.log('0a852285 site-count gate per customer');
{
  const mk = (acct, n) => Array.from({ length: n }, (_, i) => ({ id: 'm' + acct + i, account: acct, commodity: 'Gas' }));
  gateCtx.projects = [{ id: 1 }];
  gateCtx.forEachCustomerBuilding = (list, fn) => {
    fn({ meters: mk('10001', 3).concat([{ id: 'x', account: '10001', commodity: 'Electric' }]) });
    fn({ meters: mk('10002', 5) });
  };
  const gate = (prov, n, bills, cust) => vm.runInContext('_gateWRE_siteCountCheck', gateCtx)(prov, n, bills, cust);
  const g1 = gate(PROVIDER, 2, 2, '10001');
  check('customer with 3 expected, 2 found: held', g1 && g1.expected === 3 && g1.actual === 2);
  check('same customer, 3 found: not held', gate(PROVIDER, 3, 3, '10001') === null);
  const g2 = gate(PROVIDER, 4, 4, '10002');
  check('second customer has its own count (5)', g2 && g2.expected === 5);
  check('customer without a baseline is never held', gate(PROVIDER, 1, 1, '99999') === null);
  check('unreadable customer number is never held', gate(PROVIDER, 1, 1, null) === null);
  check('other provider is never held', gate('Other Supplier', 1, 1, '10001') === null);
  const num = vm.runInContext('_wreCustomerNumberOf', gateCtx)([{ x: 1 }, { CustomerNumber: '10002' }]);
  check('customer number is read from the bills', num === '10002');
}

console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
