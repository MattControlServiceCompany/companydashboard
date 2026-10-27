/**
 * test-kgs-sales-tax.js
 *
 * Synthetic test: a KGS bill with three tax lines (State, City, County). SalesTax is the sum of the
 * lines, the charge lines add up to Total Current Charges, the GasCharge recovery by subtraction leaves
 * the tax out of GasCharge, and the gas rate (getBillGasCost) does not move when salesTax is present.
 * Invented amounts, fake account 900123. No real bill data.
 *
 * Usage: node tools/test-kgs-sales-tax.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function load() {
  const sandbox = {
    window: {},
    convertUnit: (v) => v * 10, // Mcf to therms only; this test checks charge lines, not usage
    document: { getElementById: () => null, addEventListener: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error('no fetch in test sandbox')),
  };
  vm.createContext(sandbox);
  for (const rel of ['lib/formatting.js', 'computations/rates.js', 'app/energy-savings.js', 'app/bill-analysis.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  vm.runInContext('function forEachCustomerBuilding(projectsList, fn) {}', sandbox);
  return vm.runInContext('({ rules: UTILITY_RULES, verify: _postExtractionVerify, sum: sumKgsComponentCharges, gasFields: KGS_COMPONENT_CHARGE_FIELDS, baFields: CHARGE_FIELDS_GAS, gasCost: getBillGasCost })', sandbox);
}


function billText(over) {
  const L = Object.assign(
    {
      service: 'Service Charge                     30.00',
      delivery: 'Delivery Charge                     20.00',
      gsrs: 'Gas System Reliability Surcharge    1.50',
      wna: 'Weather Normalization                 2.50',
      gas: 'Cost of Gas                           40.00',
      ff1: 'Franchise Fee                         4.00',
      state: 'State Tax                             2.10',
      city: 'City Tax                              0.80',
      winter: 'Winter Event Securitized Cost         8.00',
      ff2: 'Franchise Fee                         0.50',
      county: 'County Tax                            0.30',
      total: 'Total Current Charges                 £109.70',
    },
    over || {},
  );
  return [
    'DEMO CUSTOMER                          Account Number            100200300 900123 45',
    'DIRECTOR OF FACILITIES                 Rate          General Service Sm',
    '1 TEST ROAD                            Active Deposit   NONE | Statement Date   01-20-26',
    L.service, L.delivery, L.gsrs, L.wna, L.gas, L.ff1, L.state, L.city, L.winter, L.ff2, L.county, L.total,
    'Meter Number        From        To       of Days Previous Present   Constant   Billed     Mcf    Gas/Mcf',
    'A1B2C3D4E5    12-19-25   01-19-26    31    100    200   1.0000   10.000   0.2500   4.0000',
  ].join('\n');
}
// 30 + 20 + 1.50 + 2.50 + 40 + 4 + 8 + 0.50 + (2.10 + 0.80 + 0.30) = 109.70

const env = load();
const rule = env.rules.find((r) => /^Gas Utility/.test(r.name));
async function run(over) {
  const bills = rule.extractAll.call(rule, billText(over));
  const out = await env.verify(bills, rule.name, '');
  return out.bills[0];
}
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name);
  else { failures++; console.error('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

(async () => {
  const none = { state: 'x', city: 'x', county: 'x' };
  let b = await run({});
  check('three tax lines: SalesTax is the exact sum', b.SalesTax === '3.20', String(b.SalesTax));
  check('lines sum to Total Current Charges', env.sum(b) === 109.7 && b.TotalCurrentCharges === '109.70', env.sum(b) + ' / ' + b.TotalCurrentCharges);
  check('the gas sum list holds SalesTax and CHARGE_FIELDS_GAS is that list', env.gasFields.includes('SalesTax') && env.baFields === env.gasFields);
  check('no sum warning on the clean bill', !b._sum_mismatch_kgs && !(b._warnings || []).some((w) => w.field === 'TotalCurrentCharges'));

  b = await run({ county: 'County Tax                            0.30CR' });
  check('CR tax line is negative', b.SalesTax === '2.60', String(b.SalesTax));
  b = await run(none);
  check('no tax line: SalesTax null', b.SalesTax === null, String(b.SalesTax));
  b = await run({ city: 'City Tax                              fad' });
  check('unreadable tax amount: SalesTax null, not a smaller sum', b.SalesTax === null, String(b.SalesTax));

  // GasCharge recovery: the Cost of Gas line is lost. Recovered value excludes the tax.
  b = await run({ gas: 'Cost of Gas' });
  check('recovery: GasCharge is 40.00, tax not absorbed', b.GasCharge === '40.00', String(b.GasCharge));

  // Gas rate: tax never enters getBillGasCost.
  const withTax = env.gasCost({ gasCharge: '40.00', salesTax: '3.20', totalCost: '109.70' });
  const noTax = env.gasCost({ gasCharge: '40.00', totalCost: '106.50' });
  check('gas cost unchanged by salesTax', withTax === 40 && noTax === 40, withTax + ' / ' + noTax);

  // One table, no second copy.
  const ba = fs.readFileSync(path.join(ROOT, 'app/bill-analysis.js'), 'utf8');
  const rates = fs.readFileSync(path.join(ROOT, 'computations/rates.js'), 'utf8');
  check('SalesTax is in the one KGS table', /extractedKey: 'SalesTax', savedKey: 'salesTax'/.test(ba));
  check('no literal salesTax copy outside the table', !/^\s*salesTax: /m.test(ba));
  check('not named taxCost', !/taxCost:/.test(ba.slice(ba.indexOf('const KGS_GAS_SAVED_FIELDS'), ba.indexOf('const KGS_GAS_STATEMENT_FIELDS'))));
  check('getBillTaxCost does not read salesTax', !/function getBillTaxCost[\s\S]{0,400}salesTax/i.test(rates));
  check('one KGS line-sum function, no local copy', (rates.match(/^function sumKgsComponentCharges\(/gm) || []).length === 1 && !/_kgsComponentSum/.test(ba));
  console.log('');
  if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
  console.log('All KGS sales tax tests passed');
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
