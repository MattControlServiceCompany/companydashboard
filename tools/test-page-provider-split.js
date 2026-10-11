/**
 * test-page-provider-split.js  (backlog 7c0cde2a, 6e907ea6, 402ff7f2, f567e91d, 0c5f8dc5)
 *
 * Synthetic checks for provider routing:
 *   1. A PDF that mixes providers gives each page to its own provider (_extractFileBills).
 *      A one-provider PDF is read exactly as rule.extractAll(text) reads it.
 *   2. OCR scoring: other gas brands get a gas signal set; each page scores with its own provider.
 *   3. The OCR retry test is one test for every provider.
 *   4. A weak provider hint (a shared "FRANCHISE FEE" line) is not a strong signal.
 * Every name, id, address and amount is made up. Loads the REAL app files through Node's vm module.
 *
 * Usage: node tools/test-page-provider-split.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
const LOAD_ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/eui.js',
  'computations/pollution.js',
  'computations/csc.js',
  'computations/savings.js',
  'computations/anomaly-detection.js',
  'lib/perf-table.js',
  'lib/shared-charts.js',
  'computations/report-data.js',
  'computations/data-quality.js',
  'app/db.js',
  'app/core.js',
  'app/utility-data.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
];

function load() {
  const sandbox = {
    console,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, getContext: () => null }),
    },
    navigator: { userAgent: 'node-page-provider-split-test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Chart: function () {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => Date.now() },
    Image: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const rel of LOAD_ORDER) {
    try {
      vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), ctx, { filename: rel });
    } catch (e) {
      /* later files may need a DOM; only the pure helpers are used here */
    }
  }
  vm.runInContext(
    'this.__t = { rules: UTILITY_RULES, pick: _pickFileRule, extract: _extractFileBills, detect: _detectProvider,' +
      ' detectEx: _detectProviderEx, make: makeScorePage, needsRetry: _ocrPageNeedsRetry };',
    ctx,
  );
  return ctx.__t;
}

let passed = 0;
let failed = 0;
function eq(label, actual, expected) {
  if (String(actual) === String(expected)) passed++;
  else {
    failed++;
    console.log('FAIL: ' + label + '  expected ' + JSON.stringify(expected) + '  got ' + JSON.stringify(actual));
  }
}

const T = load();

// ---- synthetic pages ----
const propane = (n, sale, inv, gal, sub, tax, net) =>
  [
    '%%PAGE_' + n + '%%',
    'SALE ' + sale + ' DATE 03/05/30 09:15:00',
    'NET DELIVERY ' + gal + ' GALLONS',
    'MFA OIL - TESTVILLE, MO',
    'Customer# 900123 Invoice #: ' + inv,
    'SAMPLE SCHOOL Date: 03/05/2030',
    'Delivery Address:',
    '100 SAMPLE ROAD TESTVILLE, KS',
    gal + ' G PROPANE COMMERCIAL 2.0000 ' + sub,
    'Invoice Sub ' + sub,
    'Tax ' + tax,
    'Net Due ' + net,
    '',
  ].join('\n');
const gasPage = (n, brand, acct) =>
  [
    '%%PAGE_' + n + '%%',
    brand,
    'Customer Name: SAMPLE SCHOOL ONE',
    'Account: ' + acct,
    'Service Address: 100 Sample Street',
    'Service from 03/01/2030 to 03/31/2030 (31 days)',
    'Therms used: 450',
    'Gas charge 315.00',
    'Customer charge 25.00',
    'Total current charges 340.00',
    'Amount due 340.00',
    '',
  ].join('\n');
const count = (bills, re) => bills.filter((b) => re.test(String(b.UtilityCompany || ''))).length;
const readOld = (text) => {
  const r = T.pick(text);
  return r.extractAll ? r.extractAll(text) : [r.extract(text)];
};

// ---- 1. Mixed-provider file: each page goes to its own provider ----
{
  const text = gasPage(1, 'Spire Energy', '900123') + propane(2, 9001, '1000001', '100.5', '201.00', '10.00', '211.00');
  const rule = T.pick(text);
  const old = readOld(text);
  const now = T.extract(text, rule);
  eq('mixed gas+propane: file rule is the gas rule', /^Gas Utility/.test(rule.name), true);
  eq('mixed gas+propane: old single-rule read has no propane bill', count(old, /MFA/i), 0);
  eq('mixed gas+propane: gas bill kept', count(now, /Spire/i), 1);
  eq('mixed gas+propane: propane bill read by the propane rule', count(now, /MFA/i), 1);
  eq('mixed gas+propane: flag set', now._mixedProvider, true);
  const pro = now.find((b) => /MFA/i.test(String(b.UtilityCompany || ''))) || {};
  eq('mixed gas+propane: propane total', pro.TotalAmountDue, '211.00');
  eq('mixed gas+propane: propane invoice', pro.InvoiceNumber, '1000001');
}
{
  // Page order does not matter: the propane page first, the gas page second.
  const text =
    propane(1, 9002, '100200300', '200.0', '400.00', '20.00', '420.00') + gasPage(2, 'Atmos Energy', '900456');
  const now = T.extract(text, T.pick(text));
  eq('propane first: propane page read', count(now, /MFA/i), 1);
  eq('propane first: gas page read by the gas rule', count(now, /Atmos/i), 1);
  const gas = now.find((b) => /Atmos/i.test(String(b.UtilityCompany || ''))) || {};
  eq('propane first: gas total', gas.TotalCurrentCharges, '340.00');
}
{
  // One provider only: read exactly as before.
  const text = gasPage(1, 'Spire Energy', '900123') + gasPage(2, 'Spire Energy', '900456');
  const rule = T.pick(text);
  const old = readOld(text);
  const now = T.extract(text, rule);
  eq('one provider: same bill count', now.length, old.length);
  eq('one provider: same bills', JSON.stringify(now), JSON.stringify(old));
  eq('one provider: not flagged mixed', now._mixedProvider, undefined);
}
{
  // A continuation page that no rule claims stays with the file rule.
  const text =
    propane(1, 9001, '1000001', '100.5', '201.00', '10.00', '211.00') +
    '%%PAGE_2%%\nTerms and conditions of delivery.\n';
  const rule = T.pick(text);
  eq('continuation page: read as before', JSON.stringify(T.extract(text, rule)), JSON.stringify(readOld(text)));
}
{
  // The word "expire" is not the gas brand Spire.
  const gasRule = T.rules.find((r) => /^Gas Utility/.test(r.name));
  eq('expire is not a gas brand', gasRule.detectPage('Your offer will expire on 04/01/2030.'), false);
  eq('Spire Energy is a gas brand', gasRule.detectPage('Spire Energy bill'), true);
}

// ---- 2. OCR scoring: gas brands, and one provider per page ----
for (const brand of ['Spire Energy', 'Atmos Energy', 'Black Hills Energy', 'Laclede Gas', 'Kansas Gas Service']) {
  const want = /Kansas/.test(brand) ? 'kgs' : 'gas';
  eq('provider of ' + brand, T.detect(brand + '\nAccount Number 900123\nTherms 450'), want);
}
eq('provider of expire text is generic', T.detect('Your offer will expire soon. Account Number 900123'), 'generic');
{
  const electricPage =
    'Billing Details service from 03/01/2030 to 03/31/2030 Current Charges kWh Demand Charge Customer Charge Account Number 900123 ' +
    'x'.repeat(100);
  const gas =
    'Atmos Energy Account Number 900456 Therms used 450 Amount due 340.00 Service Charge 25.00 Meter Number 99 ' +
    'y'.repeat(100);
  const docProvider = { name: null };
  const pageOne = T.make(docProvider);
  pageOne(electricPage);
  eq('page 1 provider is remembered', docProvider.name, T.detect(electricPage));
  eq('page 1 provider is not the gas set', docProvider.name !== 'gas' && docProvider.name !== 'generic', true);
  const pageTwo = T.make(docProvider);
  const alone = T.make({ name: null })(gas);
  eq('page 2 scores with its own provider, not the page 1 provider', pageTwo(gas), alone);
  eq('page 2 provider replaces the remembered one', docProvider.name, 'gas');
  const shortRead = 'Therms used 450 Amount due';
  eq(
    'a short first pass keeps the earlier provider signals',
    T.make(docProvider)(shortRead),
    T.make({ name: 'gas' })(shortRead),
  );
}

// ---- 3. OCR retry test: one test for every provider ----
const wellRead = ['Account Number 900123', 'Statement 03/01/30', 'Total 340.00'].join('\n');
eq('retry: page with account, amount and date needs none', T.needsRetry(wellRead), false);
eq('retry: no account label', T.needsRetry('Statement 03/01/30\nTotal 340.00'), true);
eq('retry: no amount', T.needsRetry('Account Number 900123\nStatement 03/01/30'), true);
eq('retry: no date', T.needsRetry('Account Number 900123\nTotal 340.00'), true);
eq(
  'retry: same answer for a gas text and an electric text',
  T.needsRetry('Atmos Energy\n' + wellRead),
  T.needsRetry('service from 03/01/30\n' + wellRead),
);

// ---- 4. Strong and weak provider signals ----
eq(
  'FRANCHISE FEE alone is weak',
  JSON.stringify(T.detectEx('SW - FRANCHISE FEE 4.00')),
  JSON.stringify({ name: 'baldwin', strong: false }),
);
eq('city name is strong', T.detectEx('City of Baldwin City 803 8th Street').strong, true);
eq('bare MMBtu is weak', T.detectEx('Usage 65.00 MMBtu').strong, false);
eq('account id line is strong', T.detectEx('Account ID: BG-10001').strong, true);

console.log((failed ? failed + ' failure(s), ' : 'all passed, ') + passed + ' checks');
process.exit(failed ? 1 : 0);
