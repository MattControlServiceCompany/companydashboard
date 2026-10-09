/**
 * test-kgs-suspect-line.js
 *
 * Standalone regression test: one gas-bill charge line that OCR could not read (label printed, no
 * number) or read without its decimal point is rebuilt from Total Current Charges, but only when
 * it is the single suspect line and the rebuilt value is consistent with what OCR saw.
 * Also checks that the KGS sum check runs when the file-level rule name is the shared gas rule
 * name (before the fix it ran only when that name was the provider name, which never happens).
 *
 * SYNTHETIC text only: invented charge lines and amounts in pounds (GBP), fake ids from the
 * synthetic test id list. No real bill data.
 *
 * Loads the REAL extractor (app/energy-savings.js) and the REAL _postExtractionVerify
 * (app/bill-analysis.js) with Node's vm module, same load order as the app.
 *
 * Usage: node tools/test-kgs-suspect-line.js
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
  return vm.runInContext('({ rules: UTILITY_RULES, verify: _postExtractionVerify })', sandbox);
}

// One synthetic bill block. Lines are the six charge lines plus two Franchise Fee lines and the total.
// Each key in `over` replaces the printed text of one line.
function billText(over) {
  const L = Object.assign(
    {
      service: 'Service Charge                     30.00',
      delivery: 'Delivery Charge                     20.00',
      gsrs: 'Gas System Reliability Surcharge    1.50',
      wna: 'Weather Normalization                 2.50',
      gas: 'Cost of Gas                           40.00',
      ff1: 'Franchise Fee                         4.00',
      winter: 'Winter Event Securitized Cost         8.00',
      ff2: 'Franchise Fee                         0.50',
      total: 'Total Current Charges                 £106.50',
    },
    over || {},
  );
  return [
    'DEMO CUSTOMER                          Account Number            100200300 900123 45',
    'DIRECTOR OF FACILITIES                 Rate          General Service Sm',
    '1 TEST ROAD                            Active Deposit   NONE | Statement Date   01-20-26',
    L.service,
    L.delivery,
    L.gsrs,
    L.wna,
    L.gas,
    L.ff1,
    L.winter,
    L.ff2,
    L.total,
    'Meter Number        From        To       of Days Previous Present   Constant   Billed     Mcf    Gas/Mcf',
    'A1B2C3D4E5    12-19-25   01-19-26    31    100    110   1.0000   10.000   0.2500   4.0000',
  ].join('\n');
}
// 30 + 20 + 1.50 + 2.50 + 40 + 4 + 8 + 0.50 = 106.50

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
  else {
    failures++;
    console.error('FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

(async () => {
  // 1. Control: clean bill, nothing suspect, nothing changed.
  {
    const b = await run({});
    check('clean bill: no suspect list', b._kgsSuspectLines === undefined);
    check('clean bill: sum unchanged', b.WeatherNormalization === '2.50' && b.FranchiseFee === '4.50');
    check('clean bill: no recovery flag', !Object.keys(b).some((k) => k.startsWith('_auto_recovered_B2_')));
  }
  // 2. Unreadable value (label, then a short non-number): rebuilt from the total.
  {
    const b = await run({ wna: 'Weather Normalization                 fad' });
    check('unreadable line: rebuilt to 2.50', b.WeatherNormalization === '2.50', String(b.WeatherNormalization));
    check('unreadable line: recovery flag set', !!b._auto_recovered_B2_WeatherNormalization);
    check('unreadable line: suspect list cleared', b._kgsSuspectLines === undefined);
  }
  // 3. Second Franchise Fee line lost its decimal point ("050" for 0.50): rebuilt, total of both lines right.
  {
    const b = await run({ ff2: 'Franchise Fee                         050' });
    check('bare digits: franchise total 4.50', b.FranchiseFee === '4.50', String(b.FranchiseFee));
    check('bare digits: second line 0.50', b.FranchiseFee2 === '0.50', String(b.FranchiseFee2));
  }
  // 4. Underscore filler before the number ("__ 400" for 4.00): the line is still read.
  {
    const b = await run({ ff1: 'Franchise Fee                      __ 400' });
    check('filler before number: franchise total 4.50', b.FranchiseFee === '4.50', String(b.FranchiseFee));
  }
  // 5. One wrong digit in a bare read ("500" printed as 4.00): within one digit, rebuilt.
  {
    const b = await run({ ff1: 'Franchise Fee                      __ 480' });
    check('one digit off: rebuilt to 4.00', b.FranchiseFee1 === '4.00', String(b.FranchiseFee1));
  }
  // 6. Two digits off: not rebuilt, flagged as a sum mismatch instead.
  {
    const b = await run({ ff1: 'Franchise Fee                      __ 790' });
    check('two digits off: not rebuilt', !b._auto_recovered_B2_FranchiseFee, JSON.stringify(b.FranchiseFee1));
    check('two digits off: sum mismatch flag', !!b._sum_mismatch_kgs);
  }
  // 7. Two suspect lines: nothing rebuilt.
  {
    const b = await run({
      wna: 'Weather Normalization                 fad',
      gsrs: 'Gas System Reliability Surcharge    xx',
    });
    check('two suspect lines: nothing rebuilt', b.WeatherNormalization === null && b.GasSystemReliability === null);
  }
  // 8. Credit line read without its decimal point is allowed to rebuild, sign comes from the total.
  {
    const b = await run({
      gsrs: 'Gas System Reliability Surcharge    150',
      total: 'Total Current Charges                 £103.50',
    });
    check('credit-capable line: rebuilt negative', b.GasSystemReliability === '-1.50', String(b.GasSystemReliability));
  }
  console.log('');
  if (failures) {
    console.error(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('All KGS suspect-line tests passed');
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
