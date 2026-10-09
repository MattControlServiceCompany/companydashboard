/**
 * test-provider-synthetic-bills.js  (item 43ba92a5)
 *
 * One full synthetic regression bill for each provider parser that has no full-bill test of its own:
 *   Constellation, Gas Utility (Spire, Atmos, Black Hills branches), the city utility bill, Propane.
 * Every name, id, address, read and amount below is made up (ids are on the synthetic id list).
 * The text mimics the layout of a scanned bill, not any real bill.
 * Loads the REAL app files through Node's vm module and calls the REAL UTILITY_RULES.
 *
 * Usage: node tools/test-provider-synthetic-bills.js           (add --print to show the parsed fields)
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

function loadRules() {
  const sandbox = {
    console,
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, getContext: () => null }),
    },
    navigator: { userAgent: 'node-provider-synthetic-test' },
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
      /* later files may need a DOM; only the parsers are used here */
    }
  }
  vm.runInContext('this.__rules = typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null;', ctx);
  return ctx.__rules;
}

let passed = 0;
let failed = 0;
function eq(label, actual, expected) {
  const ok =
    typeof expected === 'number' && actual !== null && actual !== undefined
      ? Math.abs(parseFloat(String(actual).replace(/,/g, '')) - expected) < 0.005
      : String(actual) === String(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log('FAIL: ' + label + '  expected ' + JSON.stringify(expected) + '  got ' + JSON.stringify(actual));
  }
}

const rules = loadRules();
if (!rules) {
  console.log('FAIL: UTILITY_RULES did not load');
  process.exit(1);
}
const PRINT = process.argv.includes('--print');
const byName = (re) => rules.find((r) => re.test(r.name));
function parse(re, text) {
  const rule = byName(re);
  if (!rule) {
    failed++;
    console.log('FAIL: no parser matches ' + re);
    return [];
  }
  const winner = rules.find((r) => r.detect(text));
  eq(re + ' is the parser chosen for its own bill', winner && winner.name, rule.name);
  const bills = typeof rule.extractAll === 'function' ? rule.extractAll(text) : [rule.extract(text)];
  if (PRINT) console.log(rule.name, JSON.stringify(bills, null, 1));
  return bills;
}

// ---- 1. Propane / fuel oil delivery (two deliveries, one page each) ----
const PROPANE = [
  '%%PAGE_1%%',
  'SALE 9001 DATE 03/05/30 09:15:00',
  'NET DELIVERY 100.5 GALLONS',
  'MFA OIL - TESTVILLE, MO',
  '100 Example Road',
  'Customer# 900123 Invoice #: 1000001',
  'SAMPLE SCHOOL Date: 03/05/2030',
  'Delivery Address:',
  '100 SAMPLE ROAD TESTVILLE, KS',
  'Driver: SAMPLE DRIVER',
  '100.5 G PROPANE COMMERCIAL 2.0000 201.00',
  'Invoice Sub 201.00',
  'Tax 10.00',
  'Net Due 211.00',
  '',
  '%%PAGE_2%%',
  'SALE 9002 DATE 04/02/30 10:00:00',
  'NET DELIVERY 200.0 GALLONS',
  'MFA OIL - TESTVILLE, MO',
  '100 Example Road',
  'Customer# 900123 Invoice #: 100200300',
  'SAMPLE SCHOOL Date: 04/02/2030',
  'Delivery Address:',
  '100 SAMPLE ROAD TESTVILLE, KS',
  'Driver: SAMPLE DRIVER',
  '200.0 G PROPANE COMMERCIAL 2.0000 400.00',
  'Invoice Sub 400.00',
  'Tax 20.00',
  'Net Due 420.00',
].join('\n');
{
  const bills = parse(/Propane/, PROPANE);
  eq('propane: two deliveries', bills.length, 2);
  const [a, b] = bills;
  eq('propane 1: commodity', a.Commodity, 'Propane');
  eq('propane 1: account', a.AccountNumber, '900123');
  eq('propane 1: invoice', a.InvoiceNumber, '1000001');
  eq('propane 1: delivery date', a.DeliveryDate, '03/05/2030');
  eq('propane 1: gallons', a.GallonsDelivered, 100.5);
  eq('propane 1: unit price', a.UnitPrice, 2.0);
  eq('propane 1: subtotal', a.Subtotal, 201.0);
  eq('propane 1: tax', a.Tax, 10.0);
  eq('propane 1: total', a.TotalAmountDue, 211.0);
  eq('propane 1: subtotal + tax = total', parseFloat(a.Subtotal) + parseFloat(a.Tax), parseFloat(a.TotalAmountDue));
  eq('propane 1: address', a.ServiceAddress, '100 SAMPLE ROAD TESTVILLE, KS');
  eq('propane 2: invoice', b.InvoiceNumber, '100200300');
  eq('propane 2: gallons', b.GallonsDelivered, 200.0);
  eq('propane 2: total', b.TotalAmountDue, 420.0);
  eq('propane 2: delivery date', b.DeliveryDate, '04/02/2030');
}

// ---- 2. Gas Utility, labelled-line branches (Spire, Atmos, Black Hills) ----
// One bill per brand. Each brand line is the only thing the brand-name check reads.
function gasBill(brand, acct, name, therms, gas, cust, total) {
  return [
    brand,
    'Customer Name: ' + name,
    'Account: ' + acct,
    'Service Address: 100 Sample Street',
    'Service from 03/01/2030 to 03/31/2030 (31 days)',
    'Therms used: ' + therms,
    'Gas charge ' + gas,
    'Customer charge ' + cust,
    'Total current charges ' + total,
    'Amount due ' + total,
  ].join('\n');
}
const GAS_BRANDS = [
  ['Spire Energy', 'Spire Energy', '900123', 'SAMPLE SCHOOL ONE', '450', '315.00', '25.00', '340.00'],
  ['Atmos Energy', 'Atmos Energy', '900456', 'SAMPLE SCHOOL TWO', '120', '84.00', '25.00', '109.00'],
  ['Black Hills Energy', 'Black Hills Energy', '123456789', 'SAMPLE SCHOOL THREE', '800', '560.00', '25.00', '585.00'],
];
for (const [label, brand, acct, name, therms, gas, cust, total] of GAS_BRANDS) {
  const bills = parse(/^Gas Utility/, gasBill(brand, acct, name, therms, gas, cust, total));
  eq(label + ': one bill', bills.length, 1);
  const b = bills[0] || {};
  eq(label + ': company', b.UtilityCompany, brand);
  eq(label + ': commodity', b.Commodity, 'Gas');
  eq(label + ': account', b.AccountNumber, acct);
  eq(label + ': customer', b.CustomerName, name);
  eq(label + ': address', b.ServiceAddress, '100 Sample Street');
  eq(label + ': period start', b.BillingPeriodStart, '03/01/2030');
  eq(label + ': period end', b.BillingPeriodEnd, '03/31/2030');
  eq(label + ': days', b.NumberOfDays, 31);
  eq(label + ': therms', b.NaturalGasTherms, parseFloat(therms));
  eq(label + ': gas charge', b.GasCharge, parseFloat(gas));
  eq(label + ': customer charge', b.CustomerCharge, parseFloat(cust));
  eq(label + ': total', b.TotalCurrentCharges, parseFloat(total));
  eq(label + ': gas + customer = total', parseFloat(b.GasCharge) + parseFloat(b.CustomerCharge), parseFloat(b.TotalCurrentCharges));
}

// ---- 3. Constellation (one invoice, two sites, usage in MMBtu) ----
// The invoice-level GasCharge line needs a dollar sign in front of the amount, so it is left out here.
const CONSTELLATION = [
  '%%PAGE_1%%',
  'Monthly Invoice',
  'Constellation   Invoice Date: 04/10/30   Account ID: BG-10001',
  'Invoice Number: 7001',
  'Sample Customer',
  '100 Test St, Testville, KS 66000',
  'Customer ID: RG-900123',
  'Service for Mar-2030 - Actual',
  'Incremental Costs  65.00 MMBtu  4.00000  260.00',
  'CRM Charge  65.00 MMBtu  0.00720  0.47',
  'Total Current Site Charges 260.47',
  '%%PAGE_2%%',
  '200 Test St, Testville, KS 66000',
  'Customer ID: RG-900456',
  'Service for Mar-2030 - Actual',
  'Incremental Costs  30.00 MMBtu  4.00000  120.00',
  'CRM Charge  30.00 MMBtu  0.00720  0.22',
  'Total Current Site Charges 120.22',
  'Total Amount Due 380.69',
].join('\n');
{
  const bills = parse(/^Constellation/, CONSTELLATION);
  eq('constellation: two sites', bills.length, 2);
  const one = bills.find((x) => x.AccountNumber === 'RG900123') || {};
  const two = bills.find((x) => x.AccountNumber === 'RG900456') || {};
  eq('constellation 1: commodity', one.Commodity, 'Gas');
  eq('constellation 1: period start', one.BillingPeriodStart, '03/01/2030');
  eq('constellation 1: period end', one.BillingPeriodEnd, '03/31/2030');
  eq('constellation 1: therms (65 MMBtu = 650 therms, read once)', one.NaturalGasTherms, 650);
  eq('constellation 1: site total', one.TotalCurrentCharges, 260.47);
  eq('constellation 1: statement date', one.StatementDate, '04/10/2030');
  eq('constellation 2: therms', two.NaturalGasTherms, 300);
  eq('constellation 2: site total', two.TotalCurrentCharges, 120.22);
  eq('constellation: site totals add to the invoice total', parseFloat(one.TotalCurrentCharges) + parseFloat(two.TotalCurrentCharges), 380.69);
}

// ---- 4. City utility bill (new layout: one page holds gas, water, sewer, stormwater lines) ----
// Gas: 100 therms x 0.798062 + 23.33 base charge = 103.14. Fuel adjustment is signed.
const CITY_BILL = [
  '%%PAGE_1%%',
  'City of Louisburg   Utility Bill',
  '100 S. Broadway   01-900123-00',
  'Utility Bill   3/23/2030',
  'Scan to pay After Due Date Pay 252.00',
  'Customer Account Information - Retain for your records',
  '100 SAMPLE DR 01-900123-00',
  '2/14/2030 3/18/2030 3/23/2030 4/11/2030 4/10/2030',
  'Water Utility Bill Previous Balance: 0.00',
  'Payments: (0.00)',
  'Current Adjustments: 0.00',
  'Penalty: 0.00',
  'Account Balance 0.00',
  'Previous Current',
  'Reading Reading Usage',
  '1,000 1,020 20 WATER 60.00',
  '100 200 100 GAS 103.14',
  'FUEL ADJUSTMENT -3.14',
  'WATER PROTECTION 1.00',
  'SEWER 40.00',
  'STORMWATER 5.00',
  'Current Bill 206.00',
  'Total Amount Due 206.00',
  'Amount Due After 4/10/2030 216.00',
].join('\n');
{
  const winner = rules.find((r) => r.detect(CITY_BILL));
  eq('city bill is read by the city parser', winner && typeof winner._extractNew, 'function');
  const bills = winner ? winner.extractAll(CITY_BILL) : [];
  if (PRINT) console.log(JSON.stringify(bills, null, 1));
  const by = (c) => bills.find((x) => x.Commodity === c) || {};
  eq('city: four commodity rows', bills.length, 4);
  eq('city: account', by('Water').AccountNumber, '01-900123-00');
  eq('city: address', by('Water').ServiceAddress, '100 SAMPLE DR');
  eq('city: period start', by('Water').BillingPeriodStart, '2/14/2030');
  eq('city: period end', by('Water').BillingPeriodEnd, '3/18/2030');
  eq('city: water charge', by('Water').WaterCharge, 60);
  eq('city: water protection fee', by('Water').WaterProtectionFee, 1);
  eq('city: sewer total', by('Sewer').TotalCurrentCharges, 40);
  eq('city: stormwater total', by('Stormwater').TotalCurrentCharges, 5);
  eq('city: gas total (printed gas line + fuel adjustment)', by('Gas').TotalCurrentCharges, 100);
  eq('city: gas usage', by('Gas').NaturalGasTherms, 100);
}

console.log(PRINT ? '' : (failed ? failed + ' failure(s), ' : 'all passed, ') + passed + ' checks');
process.exit(failed ? 1 : 0);
