#!/usr/bin/env node
// computations/utility-e-sum-fixes.gate.js -- deploy gate for two Utility E bill-sum fixes.
// 1. Taxed bill: Stage 3 sum must include sales tax, so no printed charge is rewritten.
// 2. Two-part ECA where OCR adds a digit to part 1: the printed total proves the qty x rate value.
//    Controls: correct bill unchanged; rounding drift keeps the printed value; 10x qty garble rejected.
// All values are synthetic (fake name, fake account). Run: node computations/utility-e-sum-fixes.gate.js
// REPO env var picks another checkout (used to prove the test fails on old code).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const REPO = process.env.REPO || path.join(__dirname, '..');
const ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/rates.js',
  'computations/regression.js',
  'computations/normalization.js',
  'computations/eui.js',
  'computations/hvac-enduse.js',
  'computations/pollution.js',
  'computations/csc.js',
  'computations/savings.js',
  'computations/bill-flags.js',
  'computations/anomaly-detection.js',
  'lib/perf-table.js',
  'lib/shared-charts.js',
  'computations/report-data.js',
  'computations/data-quality.js',
  'extraction/pdf-engine.js',
  'app/sync-classification.js',
  'app/db.js',
  'app/core.js',
  'app/energy-savings.js',
  'app/bill-analysis.js',
  'extraction/bill-validation.js',
  'app/utility-data.js',
];
const sb = {
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  TextEncoder,
  TextDecoder,
  window: { addEventListener() {}, removeEventListener() {}, location: { href: '', search: '' } },
  document: {
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, getContext: () => null }),
  },
  navigator: { userAgent: 'n' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  Tesseract: {},
  pdfjsLib: {},
  Chart: function () {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance: { now: () => Date.now() },
  Image: function () {},
};
sb.globalThis = sb;
sb.self = sb;
const ctx = vm.createContext(sb);
for (const r of ORDER) {
  try {
    vm.runInContext(fs.readFileSync(path.join(REPO, r), 'utf8'), ctx, { filename: r });
  } catch (e) {
    /* browser-only tail code */
  }
}
vm.runInContext('this.__R = UTILITY_RULES; this.__P = _postExtractionVerify;', ctx);
async function run(text) {
  const rule = ctx.__R.find((r) => r.name === 'Evergy' && r.detect(text)) || ctx.__R.find((r) => r.detect(text));
  let bills =
    typeof rule.extractAll === 'function' ? rule.extractAll.call(rule, text) : [rule.extract.call(rule, text)];
  if (!Array.isArray(bills)) bills = [bills];
  return (await ctx.__P(bills, rule.name, text)).bills[0];
}
const money = (n) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (n) => Math.round(n * 100) / 100;

// Taxed bill (layout copied from the real Utility E page shape, all numbers invented).
function taxedBill() {
  const ch = {
    cust: 60.13,
    fac: 135.32,
    on: 69.54,
    off: 91.39,
    tax: 114.72,
    eca1: 8.77,
    eca2: 29.32,
    eer: 1.36,
    pts: 2.5,
    tdc1: 5.04,
    tdc2: 18.1,
  };
  const sub = cents(ch.cust + ch.fac + ch.on + ch.off + ch.eca1 + ch.eca2 + ch.eer + ch.pts + ch.tdc1 + ch.tdc2);
  const fr = 23.1,
    t1 = 22.57,
    t2 = 5.21,
    t3 = 5.21;
  const total = cents(sub + fr + t1 + t2 + t3);
  const text = `%%PAGE_1%%
Customer Name : TEST CUSTOMER ONE
AccountNumber : 900123                                                                                                          Page 2 of 4
Billing Date: 06/01/2026
1 TEST DR, FIELD ONE EXAMPLEVILLE KS
SGS Secondary Voltage - 2SGSE                                         Billing Details - service from 04/22/2026 to 05/31/2026
Customer Chg .......ccooiiiiniiiiecccrc         ${money(ch.cust)}
kWh                      Energy Use                                           Facilities Chg 49.6400 kW at $2.726 per kW
550 mm (for 39 0f 30 daYS) covers seeeeinenns          ${money(ch.fac)}
Energy Chg On Pk Win 811.8680 kWh at
1700 —                              — 0.08566 per kWh (for 39 of 30 days) ............             ${money(ch.on)}
Energy Chg Off Pk Win 1,612.8975 kWh at
so               $0.05666 per kWh (for 39 of 30 days) ............             ${money(ch.off)}
Tax exempt delivery cost from bill ..........cco.....           ${money(ch.tax)}
o                                                                                     ECA Chg 04-23-2026-04-30-2026 for 497.3878
TT May                                                             kWh at $0.01763 per kWh ......ccovccuiuiiririrenccs              ${money(ch.eca1)}
ECA Chg 05-01-2026-05-31-2026 for
1,927.3777 kWh at $0.01521 per KWh ............              ${money(ch.eca2)}
EER Chg 04-23-2026-05-31-2026 for
2,424.7655 kWh at $0.00056 per kWh ............               ${money(ch.eer)}
PTS Chg 04-23-2026-05-31-2026 for
2,424.7655 kWh at $0.00103 per kWh ............            ${money(ch.pts)}
TDC Chg 04-23-2026-04-30-2026 for 497.3878
kWh at $0.01013 per KWh .....vcvivviiiiiniiiin             ${money(ch.tdc1)}
TDC Chg 05-01-2026-05-31-2026 for
1,927.3777 kWh at $0.00939 per kWh ............              ${money(ch.tdc2)}
Bill OffSEE uvcvvusssnirunsrnusssssusmssssrseniasasssssnnsean       -${money(ch.tax)}
Subtotal civic      ${money(sub)}
Example Franchise Fee ........ccocoivviiicnininnne           ${money(fr)}
Kansas State Sales Tax @ 6.5% .cccvovveeenierenne             ${money(t1)}
Example County Sales Tax @ 1.5% .....ccovecveninne              ${money(t2)}
Example City Sales Tax @ 1.5% .c.covererruees               ${money(t3)}
Current Charges ........coeeeeeeniinnsnsnsnnns      ${money(total)}  B2
Start          End                        End             Start            Read            Meter
Read Date     Read Date      Days         Read    )       Read (=)  Difference x)    Multiplier =    kWh Used        KW Used        RKVA Used
0422 osl01      40        24305082      57427 24247700         1.0000         24247700         74.6400          0.5500
`;
  return { text, ch, total };
}

// Two-part ECA bill (layout copied from the real Utility E page shape, all numbers invented).
// part1True is the true part 1 amount; part1Printed is the dollar text OCR returns for it.
function ecaBill(part1True, part1Printed, qty1, rate1) {
  const p2 = 15.0;
  const rest = cents(48.9 + 165.17 + 85.35 + 53.18 + 268.99 + 3.71 + 6.82 + 85.61 + 16.53);
  const sub = cents(rest + part1True + p2);
  const fr = cents(sub * 0.05);
  const total = cents(sub + fr);
  const text = `%%PAGE_1%%
Customer Name : TEST CUSTOMER TWO
Account Number : 900456                                                                                                      Page 2 of 2
Billing Date: 05/06/2026
2 TEST AVE EXAMPLEVILLE KS
MGS Secondary Voltage Commercial - 2MGSE                          Billing Details - service from 04/06/2026 to 05/05/2026
Customer Chg ..............        $48.90
kWh                     Energy Use                                          Facilities Chg 57.8720 kW at $2.854 per kW.            $165.17
Demand Chg 39.3120 kW at $2.171 per kW ...            $85.35
Energy Chg On Pk Win 978.3618 kWh at
10000    —            —       $0.05438 per KWH covers emcees         $53.18
Energy Chg Off Pk Win 5,640.3790 kWh at
5000 ——                                                 — $0.04769 per KWH ..ocoreeieeeereeicniseresisnsenens         $268.99
Tax exempt delivery cost from bill ...................           $133.64
ECA Chg 04-07-2026-04-30-2026 for
May Jun Jul Aug Sep Oct Nov Dec Jan Feb Mar Apr May       ${qty1} kWh at $${rate1} per kWh ............            ${money(part1Printed)}
ECA Chg 05-01-2026-05-05-2026 for
1,000.0000 kWh at $0.01500 per kWh ............          ${money(p2)}
EER Chg 04-07-2026-05-05-2026 for
6,618.7408 kWh at $0.00056 per kWh ............              $3.71
PTS Chg 04-07-2026-05-05-2026 for
6,618.7408 kWh at $0.00103 per kWh ............              $6.82   --
TDC Chg 04-07-2026-04-30-2026 for 39.3120
kW at $2.63145 per kW ....cocoeireciicininiinenicncn             $85.61
TDC Chg 05-01-2026-05-05-2026 for 39.3120
kW at $2.43891 per kW .......ccvcvvievimrieiereninnns           $16.53
Bill Offset ........        -$133.64
Subtotal over      ${money(sub)}
Example Franchise Fee .........ccconiiiinins          ${money(fr)}
Current Charges ......cccocvnmnnnnnisssesanens       ${money(total)}
Start          End                       End             Start            Read           Meter                                                         24
Read Date      Read Date        Days          Read     =)        Read (=)     Difference (x)     Multiplier (=)     KWh Used          KW Used          RKVA Used
"04/07                05/06                  20              15,327.4584           15,161.9903 1654661                 40.0000                6,618.7240               39.3120                  16,1560
`;
  return { text, total, sub };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + ' -- ' + e.message);
  }
}

(async () => {
  await check('taxed bill: On-Peak keeps its printed value', async () => {
    const t = taxedBill();
    const b = await run(t.text);
    assert.strictEqual(ctx.parseBillNumber(b.EnergyOnPeakCharge), t.ch.on, 'On-Peak is ' + b.EnergyOnPeakCharge);
    assert.strictEqual(ctx.parseBillNumber(b.TotalCurrentCharges), t.total, 'total is ' + b.TotalCurrentCharges);
    assert.ok(!b._auto_corrected_EnergyOnPeakCharge, 'On-Peak was auto-corrected');
  });
  await check('two-part ECA with OCR extra digit: qty x rate value wins', async () => {
    const t = ecaBill(100.0, 1100.0, '5,000.0000', '0.02000');
    const b = await run(t.text);
    assert.strictEqual(ctx.parseBillNumber(b.ECACharge), 115.0, 'ECACharge is ' + b.ECACharge);
    assert.strictEqual(ctx.parseBillNumber(b.TotalCurrentCharges), t.total, 'total is ' + b.TotalCurrentCharges);
    assert.ok(!b._sum_mismatch, 'sum mismatch flag set');
  });
  await check('control: correct two-part ECA bill is unchanged', async () => {
    const t = ecaBill(100.0, 100.0, '5,000.0000', '0.02000');
    const b = await run(t.text);
    assert.strictEqual(ctx.parseBillNumber(b.ECACharge), 115.0, 'ECACharge is ' + b.ECACharge);
    assert.ok(!b._auto_corrected_ECACharge, 'ECA was auto-corrected');
  });
  await check('control: rounding drift keeps the printed ECA value', async () => {
    // qty x rate = 100.04 but the bill prints 100.00 (and the printed total agrees with 100.00).
    const t = ecaBill(100.0, 100.0, '5,002.0000', '0.02000');
    const b = await run(t.text);
    assert.strictEqual(ctx.parseBillNumber(b.ECACharge), 115.0, 'ECACharge is ' + b.ECACharge);
  });
  await check('control: 10x quantity garble is rejected', async () => {
    // OCR reads qty 50,000 instead of 5,000: qty x rate = 1000.00 against a printed 100.00.
    const t = ecaBill(100.0, 100.0, '50,000.0000', '0.02000');
    const b = await run(t.text);
    assert.strictEqual(ctx.parseBillNumber(b.ECACharge), 115.0, 'ECACharge is ' + b.ECACharge);
  });
  if (failures) {
    console.log(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('all passed');
  process.exit(0);
})();
