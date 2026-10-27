#!/usr/bin/env node
// test-bill-reader-repairs.js -- 2026-10-27. SYNTHETIC data only (fake customer, fake account, fake address, invented numbers).
// Reader repairs of the shared bill engine (backlog a74e400d):
//   3. City gas: a start read that lost its leading digit is restored from the meter's last saved end read, then the
//      therms are read from the meter reads. (Numbers 2 and 4 of the item are added by their own commits.)
//   1. Electric meter table: a misread MULTIPLIER (whole number, one confusable digit) is repaired from kWh Used /
//      Read Difference; the product replaces a kWh Used column that is one digit off; the meter's last SAVED end read
//      repairs a misread start and end read (computeReadCorrection rule e).
// Run: node test-bill-reader-repairs.js    (REPO env var picks another checkout)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const REPO = process.env.REPO || __dirname;
const ORDER = [
  'lib/date-helpers.js',
  'lib/formatting.js',
  'lib/unit-conversion.js',
  'lib/csv-parser.js',
  'computations/physics.js',
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
vm.runInContext(
  'this.__X = extractBillsFromText; this.__C = computeReadCorrection; this.__C2 = typeof computeShortStartRepair === "function" ? computeShortStartRepair : () => "missing"; this.__F = _extractFileBills; this.__CITY = UTILITY_RULES.find((r) => typeof r._extractNew === "function");',
  ctx,
);
// Saved bills of the project (what the app keeps in utilityData); the reader looks up the meter's last saved bill.
function seedSaved(bills) {
  ctx.__seed = { c1: { buildings: [{ meters: [{ bills }] }] } };
  vm.runInContext('utilityData = this.__seed;', ctx);
}
async function run(text) {
  const out = await ctx.__X(text, { analyze: false });
  return out.bills[0];
}
const num = (n, d) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const f = (b, k) => (b[k] == null ? null : Number(b[k]));
const near = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 0.00005, (msg || '') + ' got ' + a + ' want ' + b);

// Invented single-meter Utility E bill. m = the meter-table values AS SCANNED (text or number); the energy lines are fixed.
const ACCT = '900123';
const GOOD = { end: 72310.4821, start: 71102.365, diff: 1208.1171, mult: 80, kwh: 96649.368, kw: 301.2, rkva: 120.5 };
function elecBill(m, dates, over) {
  dates = dates || ['09/07/2026', '10/08/2026'];
  over = over || {};
  const T = (v, d) => (typeof v === 'string' ? v : num(v, d));
  const on = 30000.0,
    off = GOOD.kwh - on;
  const onC = Math.round(on * 0.07852 * 100) / 100,
    offC = Math.round(off * 0.04182 * 100) / 100;
  const sub = Math.round((48.9 + 165.17 + onC + offC) * 100) / 100;
  return `%%PAGE_1%%
Customer Name : TEST CUSTOMER FOUR
Account Number : ${ACCT}                                                                                                      Page 2 of 2
Billing Date: ${dates[1]}
${over.addr || '4 TEST AVE EXAMPLEVILLE KS'}
MGS Secondary Voltage Commercial - 2MGSE                          Billing Details - service from ${dates[0]} to ${dates[1]}
Customer Chg ..............        $48.90
kWh                     Energy Use                                          Facilities Chg 57.8720 kW at $2.854 per kW.            $165.17
Energy Chg On Pk ${num(on, 4)} kWh at $0.07852 per kWh ............  $${num(onC, 2)}
${over.offLine ? over.offLine(num(off, 4), num(offC, 2)) : `Energy Chg Off Pk ${num(off, 4)} kWh at $0.04182 per kWh ............  $${num(offC, 2)}`}
Subtotal over      $${num(sub, 2)}
Current Charges ......cccocvnmnnnnnisssesanens       $${num(sub, 2)}
Start          End                       End             Start            Read           Meter                                                         24
Read Date      Read Date        Days          Read     =)        Read (=)     Difference (x)     Multiplier (=)     KWh Used          KW Used          RKVA Used
"${dates[0].slice(0, 5)}                ${dates[1].slice(0, 5)}                  31              ${T(m.end, 4)}           ${T(m.start, 4)} ${T(m.diff, 4)}                 ${T(m.mult, 4)}                ${T(m.kwh, 4)}               ${T(m.kw, 4)}                  ${T(m.rkva, 4)}
`;
}
const saved = (over) =>
  Object.assign(
    {
      accountNumber: ACCT,
      commodity: 'Electric',
      start: '2026-08-07',
      end: '2026-09-07',
      startRead: '70000.0000',
      endRead: '71102.3650',
      readDifference: '1102.3650',
      meterMultiplier: '80.0000',
      kwh: '88189.2000',
    },
    over || {},
  );

// ── City gas (synthetic page: fake school, fake street, fake account) ──
const GACCT = '01-900123-00';
function gasPage(o) {
  o = o || {};
  return [
    '%%PAGE_1%%',
    'Customer Account Information - Retain for your records',
    'SD 999 TEST SCHOOL        1 TEST ST        ' + GACCT,
    '8/15/2026   9/15/2026   31   9/21/2026   10/13/2026   10/10/2026',
    'Previous Balance: 0.00',
    'WATER 100.00',
    o.gasLine,
    'FUEL ADJUSTMENT -5.00',
    'WATER PROTECTION 1.00',
    'SEWER 80.00',
    'STORMWATER 4.00',
    'Current Bill ' + o.current,
    'Total Amount Due ' + o.current,
  ].join(String.fromCharCode(10));
}
// saved gas bills of the account: reads 17029 at the end of the last one, usage = read difference x 1.017
const gasSaved = [
  { start: '2026-07-15', end: '2026-08-15', startRead: '16900', endRead: '17029', readDifference: '129', kwh: '131.193' },
  { start: '2026-06-15', end: '2026-07-15', startRead: '16800', endRead: '16900', readDifference: '100', kwh: '101.7' },
  { start: '2026-05-15', end: '2026-06-15', startRead: '16700', endRead: '16800', readDifference: '100', kwh: '101.7' },
].map((b) => Object.assign({ accountNumber: GACCT, commodity: 'Gas' }, b));
// 125 read units x 1.017 = 127.125 therms; charge = 127.125 x 0.798062 + 23.33 customer charge
const GAS_CHARGE = (Math.round(127.125 * 0.798062 * 100) / 100 + 23.33).toFixed(2);
const gasCurrent = (Math.round((Number(GAS_CHARGE) - 5 + 100 + 1 + 80 + 4) * 100) / 100).toFixed(2);
const gasOf = (bills) => bills.find((b) => b.Commodity === 'Gas');

let failures = 0;
async function check(name, fn) {
  try {
    seedSaved([]);
    await fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + ' -- ' + e.message);
  }
}

(async () => {
  await check('clean table: nothing is repaired', async () => {
    const b = await run(elecBill(GOOD));
    near(f(b, 'MeterMultiplier'), 80, 'multiplier');
    near(f(b, 'kWhConsumed'), GOOD.kwh, 'kWh');
    assert.ok(!b._auto_corrected_MeterMultiplier, 'a record was written for a clean multiplier');
  });

  await check('misread multiplier (80 read as 60) and kWh Used one digit off: both repaired, one record each', async () => {
    const b = await run(elecBill(Object.assign({}, GOOD, { mult: '60.0000', kwh: '96,649.8680' })));
    near(f(b, 'MeterMultiplier'), 80, 'multiplier');
    near(f(b, 'kWhConsumed'), GOOD.kwh, 'kWh');
    assert.strictEqual(b._auto_corrected_MeterMultiplier.original, '60.0000');
    assert.strictEqual(b._auto_corrected_MeterMultiplier.corrected, '80.0000');
  });

  await check('multiplier misread but kWh Used / Difference is not a whole number: nothing is rewritten', async () => {
    const b = await run(elecBill(Object.assign({}, GOOD, { mult: '60.0000', kwh: '96,640.3680' })));
    near(f(b, 'MeterMultiplier'), 60, 'multiplier kept as printed');
    assert.ok(!b._auto_corrected_MeterMultiplier, 'a record was written');
  });

  await check('multiplier is not changed when the new value is not one confusable digit away', async () => {
    // 80 printed as 20: kWh Used / Difference is 80, but 2 and 8 are not an OCR confusion
    const b = await run(elecBill(Object.assign({}, GOOD, { mult: '20.0000' })));
    near(f(b, 'MeterMultiplier'), 20, 'multiplier kept as printed');
    assert.ok(!b._auto_corrected_MeterMultiplier, 'a record was written');
  });

  await check('start and end read misread, meter has a saved bill: both reads are set from the chain', async () => {
    seedSaved([saved()]);
    const b = await run(elecBill(Object.assign({}, GOOD, { start: '71,103.3650', end: '72,310.5821' })));
    near(f(b, 'StartRead'), GOOD.start, 'StartRead');
    near(f(b, 'EndRead'), GOOD.end, 'EndRead');
    assert.ok(b._auto_corrected_StartRead && b._auto_corrected_EndRead, 'no correction records');
    assert.strictEqual(b._auto_corrected_StartRead.original, '71103.3650');
  });

  await check('same misreads, no saved bill: the reads stay as scanned', async () => {
    const b = await run(elecBill(Object.assign({}, GOOD, { start: '71,103.3650', end: '72,310.5821' })));
    near(f(b, 'StartRead'), 71103.365, 'StartRead');
    assert.ok(!b._auto_corrected_StartRead, 'a record was written');
  });

  await check('saved bill of another account: no chain, reads stay as scanned', async () => {
    seedSaved([saved({ accountNumber: '900456' })]);
    const b = await run(elecBill(Object.assign({}, GOOD, { start: '71,103.3650', end: '72,310.5821' })));
    assert.ok(!b._auto_corrected_StartRead, 'a record was written');
  });

  await check('a replaced meter (start read near zero) is never rewritten from the saved end read', async () => {
    seedSaved([saved()]);
    const b = await run(elecBill(Object.assign({}, GOOD, { start: '0.0000', end: '1,208.1171' })));
    near(f(b, 'StartRead'), 0, 'StartRead');
    assert.ok(!b._auto_corrected_StartRead, 'a record was written');
  });

  await check('service address: house number and street joined by OCR is read; a bare number line is not an address', async () => {
    const b = await run(elecBill(GOOD, null, { addr: '4TEST AVE EXAMPLEVILLE KS' }));
    assert.strictEqual(b.ServiceAddress, '4TEST AVE EXAMPLEVILLE KS');
    const c = await run(elecBill(GOOD, null, { addr: '40123456 KS' }));
    assert.ok(!c.ServiceAddress, 'a digit run was read as an address: ' + c.ServiceAddress);
  });

  await check('gas: start read that lost its leading digit is restored from the saved end read, therms follow', async () => {
    seedSaved(gasSaved);
    const g = gasOf(ctx.__F(gasPage({ gasLine: '7.029   17154 1]   GAS   ---   ' + GAS_CHARGE, current: gasCurrent }), ctx.__CITY));
    assert.strictEqual(String(g.StartRead), '17029');
    assert.strictEqual(String(g.EndRead), '17154');
    assert.ok(g._auto_corrected_StartRead && /leading digit/.test(g._auto_corrected_StartRead.reason), 'no record');
    near(f(g, 'NaturalGasTherms'), 127.125, 'therms');
  });

  await check('gas: no saved bill, the short start read stays as scanned', async () => {
    const g = gasOf(ctx.__F(gasPage({ gasLine: '7.029   17154 1]   GAS   ---   ' + GAS_CHARGE, current: gasCurrent }), ctx.__CITY));
    assert.strictEqual(String(g.StartRead), '7029');
    assert.ok(!g._auto_corrected_StartRead, 'a record was written');
  });

  await check('gas: a start read whose digits are not the end of the saved end read is left alone', async () => {
    seedSaved(gasSaved);
    const g = gasOf(ctx.__F(gasPage({ gasLine: '6.030   17154 1]   GAS   ---   ' + GAS_CHARGE, current: gasCurrent }), ctx.__CITY));
    assert.ok(!g._auto_corrected_StartRead, 'a record was written');
  });

  // 1,125 read units x 1.017 = 1,144.125 therms. The usage cell prints a lone "I" for the leading 1.
  const bigCharge = (Math.round(1144.125 * 0.798062 * 100) / 100 + 23.33).toFixed(2);
  const bigCurrent = (Number(bigCharge) - 5 + 100 + 1 + 80 + 4).toFixed(2);
  for (const u of ['I,144.125', '1,144.125']) {
    await check('gas: usage "' + u + '" reads as 1,144.125 therms (a lone I before a thousands group is a 1)', async () => {
      const g = gasOf(ctx.__F(gasPage({ gasLine: '7,029   8,154   ' + u + '   GAS   ---   ' + bigCharge, current: bigCurrent }), ctx.__CITY));
      assert.strictEqual(String(g.StartRead), '7029');
      assert.strictEqual(String(g.EndRead), '8154');
      near(f(g, 'NaturalGasTherms'), 1144.125, 'therms');
    });
  }

  await check('rule f: needs fewer digits, the same ending, and an end read at or above the saved end read', () => {
    const f1 = ctx.__C2({ prevEnd: '17029', start: '7029', end: '17154' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(f1)), { start: '17029', diff: '125' });
    assert.strictEqual(ctx.__C2({ prevEnd: '17029', start: '7030', end: '17154' }), null);
    assert.strictEqual(ctx.__C2({ prevEnd: '17029', start: '17029', end: '17154' }), null);
    assert.strictEqual(ctx.__C2({ prevEnd: '17029', start: '7029', end: '16999' }), null);
    assert.strictEqual(ctx.__C2({ prevEnd: '117029', start: '7029', end: '17154' }), null);
  });

  await check('rule e of computeReadCorrection: needs both reads to be 1-2 digit misreads of the chain', () => {
    const base = { prevEnd: '71102.3650', prevStart: '70000.0000', prevDiff: '1102.3650', prevMult: '80.0000', prevUsage: '88189.2000', start: '71103.3650', diff: '1208.1171', mult: '80.0000', usage: '96649.3680' };
    const far = ctx.__C(Object.assign({}, base, { end: '72399.9999', nextStart: null }));
    assert.strictEqual(far, null);
    const ok = ctx.__C(Object.assign({}, base, { end: '72310.5821', nextStart: null }));
    assert.strictEqual(ok.rule, 'e0');
    assert.strictEqual(ok.start, '71102.3650');
    assert.strictEqual(ok.end, '72310.4821');
    const withNext = ctx.__C(Object.assign({}, base, { end: '72310.5821', nextStart: '72310.4821' }));
    assert.strictEqual(withNext.rule, 'e');
    const wrongNext = ctx.__C(Object.assign({}, base, { end: '72310.5821', nextStart: '72310.0000' }));
    assert.strictEqual(wrongNext, null);
  });

  if (failures) {
    console.log(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('all passed');
  process.exit(0);
})();
