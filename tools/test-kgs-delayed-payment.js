/**
 * test-kgs-delayed-payment.js
 *
 * Standalone regression test, two parts. SYNTHETIC text only: invented lines and amounts, fake account.
 *  1. A Delayed Payment Charge that OCR read without its decimal point ("127" for 1.27) is rebuilt from
 *     Total Current Charges, like the other single gas charge lines. A clean line is left alone.
 *  2. Every gas component charge in the one line-sum list (KGS_COMPONENT_CHARGE_FIELDS) has a charge row in the
 *     KGS review layout, so the running total on the review screen adds up to Total Current Charges.
 *
 * Usage: node tools/test-kgs-delayed-payment.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function load() {
  const sandbox = {
    window: {},
    convertUnit: (v) => v * 10,
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
  return vm.runInContext('({ rules: UTILITY_RULES, verify: _postExtractionVerify, fields: KGS_COMPONENT_CHARGE_FIELDS })', sandbox);
}

function billText(delayed) {
  return [
    'DEMO CUSTOMER                          Account Number            100200300 900123 45',
    'DIRECTOR OF FACILITIES                 Rate          General Service Sm',
    '1 TEST ROAD                            Active Deposit   NONE | Statement Date   01-20-26',
    'Service Charge                     30.00',
    'Delivery Charge                     20.00',
    'Gas System Reliability Surcharge    1.50',
    'Weather Normalization                 2.50',
    'Cost of Gas                           40.00',
    'Franchise Fee                         4.00',
    delayed,
    'Winter Event Securitized Cost         8.00',
    'Franchise Fee                         0.50',
    'Total Current Charges                 £107.77',
    'Meter Number        From        To       of Days Previous Present   Constant   Billed     Mcf    Gas/Mcf',
    'A1B2C3D4E5    12-19-25   01-19-26    31    100    200   1.0000   10.000   0.2500   4.0000',
  ].join('\n');
}
// 30 + 20 + 1.50 + 2.50 + 40 + 4 + 1.27 + 8 + 0.50 = 107.77

const env = load();
const rule = env.rules.find((r) => /^Gas Utility/.test(r.name));
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name);
  else {
    failures++;
    console.error('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}
async function run(delayed) {
  const bills = rule.extractAll.call(rule, billText(delayed));
  return (await env.verify(bills, rule.name, '')).bills[0];
}

(async () => {
  let b = await run('Delayed Payment Charge               1.27');
  check('clean delayed line: 1.27, no recovery', b.DelayedPaymentCharge === '1.27' && !b._auto_recovered_B2_DelayedPaymentCharge, String(b.DelayedPaymentCharge));
  b = await run('Delayed Payment Charge               127');
  check('decimal dropped: rebuilt to 1.27', b.DelayedPaymentCharge === '1.27', String(b.DelayedPaymentCharge));
  check('decimal dropped: recovery flag set', !!b._auto_recovered_B2_DelayedPaymentCharge);
  check('decimal dropped: no sum mismatch', !b._sum_mismatch_kgs && !b._gateTripped, JSON.stringify(b._gateReasons));
  b = await run('Delayed Payment Charge');
  check('delayed unreadable: rebuilt to 1.27', b.DelayedPaymentCharge === '1.27', String(b.DelayedPaymentCharge));

  const ba = fs.readFileSync(path.join(ROOT, 'app/bill-analysis.js'), 'utf8');
  const start = ba.indexOf('const _LAYOUT_KGS');
  const end = ba.indexOf("type: 'total'", start);
  const layout = ba.slice(start, end);
  for (const f of env.fields) {
    if (f === 'FuelAdjustment' || f === 'FranchiseFee') continue; // FuelAdjustment is null on KGS; Franchise Fee shows as lines (1) and (2)
    check('KGS layout has a charge row for ' + f, new RegExp("chargeField: '" + f + "'").test(layout));
  }
  console.log('');
  if (failures) {
    console.error(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('All KGS delayed payment tests passed');
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
