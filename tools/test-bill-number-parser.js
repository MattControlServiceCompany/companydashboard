/**
 * test-bill-number-parser.js  (WP-01, math-audit 2026-09-28)
 *
 * Acceptance test for the ONE bill-number parser, parseBillNumber (lib/formatting.js).
 * Synthetic data only. Loads the REAL app files through Node's vm module.
 *
 *  1. Parser table: comma, dollar, space, (12.00), 12.00-, 12.00CR, "1.234,5", junk, empty.
 *     Contract: junk or empty returns null (missing). It never returns 0.
 *  2. Kansas Gas Service (KGS) extractor: amounts of $1,000 or more are stored without commas,
 *     and the rate is right (2,022.93 / 33 therms = 61.30 per therm, not 2 / 33 = 0.0606).
 *  3. Null path through each caller class (blank / "N/A" input must not throw and must not be read
 *     as a number): rate readers (rates.js), gas usage resolver (savings.js), extractor mappers and
 *     verifier (bill-analysis.js), Evergy decimal repair (energy-savings.js), CSV warnings (csv-import.js).
 *  4. Decimal repair never rewrites a real 12,345.6789 kW reading (E-20).
 *
 * Usage: node tools/test-bill-number-parser.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  }
}
function same(a, b) {
  return Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
}

function makeSandbox() {
  const noop = () => {};
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      createElement: () => ({ style: {}, getContext: () => null }),
    },
    console: { log: noop, warn: noop, error: noop },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    requestAnimationFrame: () => 0,
    addEventListener: noop,
    showToast: noop,
    fetch: () => Promise.reject(new Error('no fetch')),
    forEachCustomerBuilding: noop,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
function loadInto(sandbox, files) {
  for (const rel of files) {
    vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  }
}
function get(sandbox, name) {
  return vm.runInContext('typeof ' + name + ' !== "undefined" ? ' + name + ' : null', sandbox);
}

// ── 1. Parser table ─────────────────────────────────────────────────────────────────────────
let parseBillNumber;
try {
  const s0 = makeSandbox();
  loadInto(s0, ['lib/formatting.js']);
  parseBillNumber = get(s0, 'parseBillNumber');
} catch (e) {
  parseBillNumber = null;
}
check('parseBillNumber exists in lib/formatting.js', typeof parseBillNumber === 'function');
if (typeof parseBillNumber !== 'function') {
  console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
const TABLE = [
  ['4,271.50', 4271.5],
  ['1,234.5', 1234.5],
  ['(12.00)', -12],
  ['12.00-', -12],
  ['12.00CR', -12],
  ['12.00cr', -12],
  ['-12.00', -12],
  ['$1,234.50', 1234.5],
  ['$ 1,000', 1000],
  ['1 234.5', 1234.5],
  ['1,234', 1234],
  ['1234', 1234],
  ['0', 0],
  [' 5 ', 5],
  ['.5', 0.5],
  ['0.00', 0],
  [1234.5, 1234.5],
  ['1.234,5', null], // ambiguous locale: not guessed
  ['12,5', null],
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  ['N/A', null],
  ['abc', null],
  ['12abc', null],
  ['--5', null],
  ['(12.00)-', null],
  [NaN, null],
  [Infinity, null],
  [{}, null],
];
for (const [input, expected] of TABLE) {
  const got = parseBillNumber(input);
  check('parseBillNumber(' + JSON.stringify(input) + ') = ' + expected, same(got, expected), got);
}
check('junk never returns 0', parseBillNumber('N/A') === null && parseBillNumber('') === null);
const orZero = (() => {
  const s0 = makeSandbox();
  loadInto(s0, ['lib/formatting.js']);
  return get(s0, 'parseBillNumberOrZero');
})();
check('parseBillNumberOrZero: junk -> 0, value kept', orZero('N/A') === 0 && orZero('(2.5)') === -2.5);

// ── 2. KGS extractor: no commas stored, right rate ─────────────────────────────────────────
const sb = makeSandbox();
loadInto(sb, [
  'lib/formatting.js',
  'computations/rates.js',
  'computations/savings.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
]);
const rules = get(sb, 'UTILITY_RULES');
const kgs = rules.find((r) => /Gas Utility|Kansas Gas/i.test(r.name));
check('KGS rule found', !!kgs);
const kgsText = [
  'Kansas Gas Service',
  'Statement Date 02-10-26',
  'Account Number 510000123 2051604 18',
  'ABC12345 01-10-26 02-09-26 30 100 133 1.0000 3.300 $0.2034 6.9480',
  'Service Charge $1,234.56',
  'Delivery Charge $10.34',
  'Gas System Reliability Surcharge $1.24CR',
  'Weather Normalization Adj $0.67',
  'Cost of Gas $2,022.93',
  'Franchise Fee $1,001.69',
  'Franchise Fee $0.15',
  'Total Current Charges  $4,271.50',
  'Amount Due: $4,271.50',
].join('\n');
let e = kgs.extract(kgsText);
e = Array.isArray(e) ? e[0] : e;
for (const k of ['CustomerCharge', 'GasCharge', 'FranchiseFee', 'TotalCurrentCharges', 'TotalAmountDue']) {
  check('KGS ' + k + ' has no comma', typeof e[k] === 'string' && !/,/.test(e[k]), e[k]);
}
check('KGS TotalCurrentCharges = 4271.50', e.TotalCurrentCharges === '4271.50', e.TotalCurrentCharges);
check('KGS GasCharge = 2022.93', e.GasCharge === '2022.93', e.GasCharge);
check('KGS FranchiseFee sums both lines = 1001.84', e.FranchiseFee === '1001.84', e.FranchiseFee);
check('KGS credit line CR is negative', e.GasSystemReliability === '-1.24', e.GasSystemReliability);
const getExtractedRate = get(sb, 'getExtractedRate');
e.Commodity = 'Gas';
const rate = getExtractedRate(e, 'gas');
check('KGS gas rate = 2022.93 / 33 (61.30), not 0.0606', same(Math.round(rate * 100) / 100, 61.3), rate);
const rowCosts = get(sb, '_extractedToBillRowCosts')(e);
check('KGS bill row totalCost parses to 4271.5', parseFloat(rowCosts.totalCost) === 4271.5, rowCosts.totalCost);

// A stored bill that already holds comma text is still read correctly by the rate readers.
const getStoredRate = get(sb, 'getStoredRate');
const storedGas = getStoredRate({ totalCost: '4,271.50', naturalGasTherms: '70' }, 'gas');
check('getStoredRate reads "4,271.50" (61.02 per therm)', same(Math.round(storedGas * 100) / 100, 61.02), storedGas);

// ── 3. Null path per caller class ──────────────────────────────────────────────────────────
function noThrow(name, fn) {
  try {
    const r = fn();
    check(name + ' does not throw', true);
    return r;
  } catch (err) {
    check(name + ' does not throw', false, String(err && err.message));
    return undefined;
  }
}
// rate readers
for (const blank of ['', null, undefined, 'N/A']) {
  const label = JSON.stringify(blank);
  check('getStoredRate blank ' + label + ' = 0', getStoredRate({ totalCost: blank, kWhConsumed: blank }, 'kwh') === 0);
  check(
    'getExtractedRate blank ' + label + ' = 0',
    getExtractedRate({ GasCharge: blank, NaturalGasTherms: '33' }, 'gas') === 0,
  );
  check(
    'resolveGasUsageTherms blank ' + label + ' = 0',
    get(sb, 'resolveGasUsageTherms')({ therms: blank, naturalGasTherms: blank }) === 0,
  );
  noThrow('ensureBillRates blank ' + label, () =>
    get(sb, 'ensureBillRates')({ kWhConsumed: blank, kwhCost: blank, totalCost: blank }),
  );
  // extractor mapper (direct .toFixed on cost buckets)
  const rc = noThrow('_extractedToBillRowCosts blank ' + label, () =>
    get(
      sb,
      '_extractedToBillRowCosts',
    )({
      Commodity: 'Electric',
      TotalCurrentCharges: blank,
      FranchiseFee: blank,
      BilledKWCharge: blank,
      EnergyOnPeakCharge: blank,
    }),
  );
  if (rc)
    check(
      '_extractedToBillRowCosts blank ' + label + ': cost buckets are "0.00" text',
      rc.taxCost === '0.00' && rc.kwCost === '0.00',
      rc,
    );
}
// validators and self-verify (the .toFixed / === 0 sites)
const decide = get(sb, '_decideOnOffPeakKWh');
noThrow('_decideOnOffPeakKWh blank charges', () =>
  decide({ EnergyOnPeakCharge: '', EnergyOffPeakCharge: null, OnPeakKWh: 'N/A' }, 0, false),
);
const validate = get(sb, 'validateBillData');
if (validate) {
  const w = noThrow('validateBillData junk charge', () =>
    validate(
      {
        Commodity: 'Electric',
        UtilityCompany: 'Evergy',
        TotalCurrentCharges: '100.00',
        CustomerCharge: 'N/A',
        kWhConsumed: '',
      },
      'Evergy',
    ),
  );
  if (Array.isArray(w)) {
    check(
      'validateBillData reports an unreadable charge (not "$0.00")',
      w.some((x) => /could not be read/i.test(x.message || '')),
      w.map((x) => x.message),
    );
  }
}
const post = get(sb, '_postExtractionVerify');
noThrow('_postExtractionVerify blank/junk bills (Evergy)', () => {
  const bills = [
    {
      UtilityCompany: 'Evergy',
      Commodity: 'Electric',
      TotalCurrentCharges: '',
      EnergyOnPeakCharge: 'N/A',
      kWhConsumed: null,
    },
    {
      UtilityCompany: 'Evergy',
      Commodity: 'Electric',
      TotalCurrentCharges: '55.10',
      CustomerCharge: '',
      kWhConsumed: '',
    },
  ];
  return post(bills, 'Evergy', '');
});
noThrow('_postExtractionVerify blank/junk gas bill (KGS)', () =>
  post(
    [{ UtilityCompany: 'Kansas Gas Service', Commodity: 'Gas', TotalCurrentCharges: 'N/A', GasCharge: '' }],
    'Kansas Gas Service',
    '',
  ),
);

// Evergy decimal repair (E-20): a real reading keeps its digits; a dropped decimal is restored.
const repair = get(sb, '_evergyRepairDroppedDecimals');
check('_evergyRepairDroppedDecimals exists', typeof repair === 'function');
if (typeof repair === 'function') {
  const real = { BilledKW: '12,345.6789', kWhConsumed: '2,345,678.1234' };
  repair(real);
  check(
    'real 12,345.6789 kW is not rewritten',
    real.BilledKW === '12,345.6789' && !real._ocr_decimal_fix_BilledKW,
    real,
  );
  check('real 2,345,678.1234 kWh is not rewritten', real.kWhConsumed === '2,345,678.1234', real);
  const dropped = { BilledKW: '4755360.0000' };
  repair(dropped);
  check('dropped decimal 4755360.0000 -> 475.5360', dropped.BilledKW === '475.5360', dropped);
  const blank = { BilledKW: 'N/A', ActualKW: '', kWhConsumed: null };
  noThrow('_evergyRepairDroppedDecimals junk', () => repair(blank));
}

// CSV warnings and formatters (csv-import.js)
const sc = makeSandbox();
try {
  loadInto(sc, ['lib/formatting.js', 'computations/rates.js', 'app/csv-import.js']);
} catch (err) {
  check('csv-import.js loads in the test sandbox', false, String(err && err.message));
}
const fieldWarnings = get(sc, '_billFieldWarnings');
if (fieldWarnings) {
  const pairs = get(sc, '_CHARGE_QTY_PAIRS');
  const chargeKey = Object.keys(pairs)[0];
  const qtyKey = pairs[chargeKey];
  const row = {};
  row[chargeKey] = '$12.50';
  row[qtyKey] = ''; // blank qty is missing: warn
  const w1 = noThrow('_billFieldWarnings charge with blank qty', () => fieldWarnings(row, 'Electric'));
  check('blank qty with a charge is warned (null = missing)', !!(w1 && w1[qtyKey]), w1);
  row[qtyKey] = 'N/A';
  const w2 = noThrow('_billFieldWarnings charge with junk qty', () => fieldWarnings(row, 'Electric'));
  check('junk qty with a charge is warned', !!(w2 && w2[qtyKey]), w2);
  row[qtyKey] = '1,000';
  const w3 = fieldWarnings(row, 'Electric');
  check('valid qty "1,000" is not warned', !(w3 && w3[qtyKey]), w3);
}
const fmtNum = get(sc, '_billFmtNumber');
const fmtCur = get(sc, '_billFmtCurrency');
if (fmtNum && fmtCur) {
  check('_billFmtNumber("12,5") keeps the typed text (not 125)', fmtNum('12,5') === '12,5', fmtNum('12,5'));
  check('_billFmtNumber("1,234.5") = "1,234.5"', fmtNum('1,234.5') === '1,234.5', fmtNum('1,234.5'));
  check('_billFmtCurrency("(12.00)") = "$-12.00"', fmtCur('(12.00)') === '$-12.00', fmtCur('(12.00)'));
  check('_billFmtCurrency("") = ""', fmtCur('') === '');
}

console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
