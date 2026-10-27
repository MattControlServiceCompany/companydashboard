#!/usr/bin/env node
// test-seasonal-tou.js -- 2026-10-23. SYNTHETIC data only (fake customer, fake account, invented numbers).
// The seasonal on-peak / off-peak energy lines of a Utility E bill: On Pk Sum, On Pk Win, Off Pk Sum, Off Pk Win,
// each with kWh, rate and charge, written by one function (touResolveLines / touApplyToBill, computations/rates.js).
// Cases: straddle bill (4 lines + totals), garbled label, missing / garbled quantity, lines that do not add up to
// kWh used (held with one warning), non-straddle bill (2 lines), older saved bill (labels derived, nothing stored).
// Run: node test-seasonal-tou.js    (REPO env var picks another checkout)
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
  'this.__R = UTILITY_RULES; this.__P = _postExtractionVerify; this.__G = _applyExtractionGates; this.__L = touLinesOfBill; this.__S = _billSeasonRates; this.__A = touApplyToBill; this.__D = SEASON_DEFAULT_PROVIDER;',
  ctx,
);
async function run(text) {
  const rule = ctx.__R.find((r) => r.name === ctx.__D && r.detect(text)) || ctx.__R.find((r) => r.detect(text));
  let bills = typeof rule.extractAll === 'function' ? rule.extractAll.call(rule, text) : [rule.extract.call(rule, text)];
  if (!Array.isArray(bills)) bills = [bills];
  const out = await ctx.__P(bills, rule.name, text);
  ctx.__G(out.bills, null, null, null);
  return out.bills[0];
}
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kwh = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const cents = (n) => Math.round(n * 100) / 100;

// Invented straddle bill: summer + winter lines on both sides (kWh used = sum of the four).
const L = {
  onSum: { q: 2000.0, r: '0.07852' },
  onWin: { q: 500.5, r: '0.03417' },
  offSum: { q: 10000.0, r: '0.04182' },
  offWin: { q: 2500.25, r: '0.02915' },
};
for (const k of Object.keys(L)) L[k].c = cents(L[k].q * parseFloat(L[k].r));
const KWH_USED = L.onSum.q + L.onWin.q + L.offSum.q + L.offWin.q;

// opts.lines: override line text by key; opts.used: kWh used printed; opts.dates: [from, to]; opts.drop: keys left out.
function touBill(opts) {
  opts = opts || {};
  const lines = Object.assign(
    {
      onSum: 'Energy Chg On Pk Sum ' + kwh(L.onSum.q) + ' kWh at $' + L.onSum.r + ' per kWh ............  ' + money(L.onSum.c),
      onWin: 'Energy Chg On Pk Win ' + kwh(L.onWin.q) + ' kWh at $' + L.onWin.r + ' per kWh ............  ' + money(L.onWin.c),
      offSum: 'Energy Chg Off Pk Sum ' + kwh(L.offSum.q) + ' kWh at $' + L.offSum.r + ' per kWh ............  ' + money(L.offSum.c),
      offWin: 'Energy Chg Off Pk Win ' + kwh(L.offWin.q) + ' kWh at $' + L.offWin.r + ' per kWh ............  ' + money(L.offWin.c),
    },
    opts.lines || {},
  );
  const keys = ['onSum', 'onWin', 'offSum', 'offWin'].filter((k) => !(opts.drop || []).includes(k));
  const used = opts.used != null ? opts.used : KWH_USED;
  const dates = opts.dates || ['09/07/2026', '10/06/2026'];
  const fixed = 48.9 + 165.17;
  const energy = keys.reduce((s, k) => s + L[k].c, 0);
  const sub = cents(fixed + energy + (opts.subAdd || 0));
  const text = `%%PAGE_1%%
Customer Name : TEST CUSTOMER THREE
Account Number : 900123                                                                                                      Page 2 of 2
Billing Date: ${dates[1]}
3 TEST AVE EXAMPLEVILLE KS
MGS Secondary Voltage Commercial - 2MGSE                          Billing Details - service from ${dates[0]} to ${dates[1]}
Customer Chg ..............        $48.90
kWh                     Energy Use                                          Facilities Chg 57.8720 kW at $2.854 per kW.            $165.17
${keys.map((k) => lines[k]).join('\n')}
Subtotal over      ${money(sub)}
Current Charges ......cccocvnmnnnnnisssesanens       ${money(sub)}
Start          End                       End             Start            Read           Meter                                                         24
Read Date      Read Date        Days          Read     =)        Read (=)     Difference (x)     Multiplier (=)     KWh Used          KW Used          RKVA Used
"${dates[0].slice(0, 5)}                ${dates[1].slice(0, 5)}                  29              ${kwh(200000 + used)}           200,000.0000 ${Math.round(used * 100)}                 1.0000                ${kwh(used)}               39.3120                  16,1560
`;
  return { text, sub };
}
const f = (b, k) => (b[k] == null ? null : Number(b[k]));
const near = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 0.00005, (msg || '') + ' got ' + a + ' want ' + b);
const holds = (b) => (b._gateReasons || []).filter((r) => /do not add up to kWh used/.test(r));

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
  await check('straddle bill: four lines, each with kWh, rate and charge; totals are sums of the lines', async () => {
    const b = await run(touBill().text);
    for (const [k, p] of [['onSum', 'OnPkSum'], ['onWin', 'OnPkWin'], ['offSum', 'OffPkSum'], ['offWin', 'OffPkWin']]) {
      near(f(b, p + 'KWh'), L[k].q, p + 'KWh');
      near(f(b, p + 'Rate'), parseFloat(L[k].r), p + 'Rate');
      near(f(b, p + 'Charge'), L[k].c, p + 'Charge');
    }
    near(f(b, 'EnergyOnPeakCharge'), cents(L.onSum.c + L.onWin.c), 'On charge total');
    near(f(b, 'EnergyOffPeakCharge'), cents(L.offSum.c + L.offWin.c), 'Off charge total');
    near(f(b, 'OnPeakKWh'), L.onSum.q + L.onWin.q, 'On kWh total');
    near(f(b, 'OffPeakKWh'), L.offSum.q + L.offWin.q, 'Off kWh total');
    assert.strictEqual(holds(b).length, 0, 'bill held: ' + (b._gateReasons || []).join(' | '));
    const onParts = b._rates.EnergyOnPeakCharge.parts.map((p) => p.season).join(',');
    assert.strictEqual(onParts, 'Sum,Win', 'rates parts carry the season: ' + onParts);
  });

  await check('garbled label and lost rate: the Off Pk Sum line is recovered from qty x rate = charge and the kWh sum', async () => {
    const b = await run(
      touBill({ lines: { offSum: 'Fri Sha Cf Sc Sum ' + kwh(L.offSum.q) + ' ih a t p  ' + money(L.offSum.c) } }).text,
    );
    near(f(b, 'OffPkSumKWh'), L.offSum.q, 'OffPkSumKWh');
    near(f(b, 'OffPkSumRate'), parseFloat(L.offSum.r), 'OffPkSumRate');
    near(f(b, 'OffPkSumCharge'), L.offSum.c, 'OffPkSumCharge');
    near(f(b, 'EnergyOffPeakCharge'), cents(L.offSum.c + L.offWin.c), 'Off charge total keeps the Sum line');
    assert.strictEqual(holds(b).length, 0, 'bill held: ' + (b._gateReasons || []).join(' | '));
  });

  await check('chart noise in front of the quantity is not part of it (the rate is charge / quantity)', async () => {
    // label lost, "40 xy Chart" noise before the quantity, "kWh" garbled, no rate on the line
    const b = await run(
      touBill({ lines: { offSum: '40 xy Chart Sum ' + kwh(L.offSum.q) + ' kivh at p  ' + money(L.offSum.c) } }).text,
    );
    near(f(b, 'OffPkSumKWh'), L.offSum.q, 'OffPkSumKWh');
    near(f(b, 'OffPkSumRate'), parseFloat(L.offSum.r), 'OffPkSumRate');
    assert.strictEqual(holds(b).length, 0, 'bill held: ' + (b._gateReasons || []).join(' | '));
  });

  const lostOffSum = () => touBill({ lines: { offSum: 'Energy Chg Off Pk Sum   kWh at p  ' + money(L.offSum.c) } });
  const rateHolds = (b) => (b._gateReasons || []).filter((r) => /worked out from the charge/.test(r));
  const setSaved = (rate) =>
    vm.runInContext(
      'utilityData = ' +
        JSON.stringify({
          c1: {
            buildings: [
              {
                meters: [
                  {
                    bills: [
                      { accountNumber: '900123', commodity: 'Electric', start: '2026-06-05', end: '2026-07-07', offPeakRate: rate, onPeakRate: '0.07852' },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ctx,
    );
  const clearSaved = () => vm.runInContext('utilityData = {}', ctx);

  await check('quantity and rate both lost, no earlier bill: quantity kept, rate held as derived (unverified)', async () => {
    clearSaved();
    const b = await run(lostOffSum().text);
    near(f(b, 'OffPkSumKWh'), L.offSum.q, 'OffPkSumKWh');
    assert.strictEqual(rateHolds(b).length, 1, 'not held: ' + (b._gateReasons || []).join(' | '));
    assert.ok(b._touLines.recovered.includes('OffPkSum:identity-unverified'), b._touLines.recovered.join());
  });

  await check('quantity and rate both lost, earlier saved bill has the same rate: accepted, not held', async () => {
    setSaved('0.04182');
    const b = await run(lostOffSum().text);
    clearSaved();
    near(f(b, 'OffPkSumKWh'), L.offSum.q, 'OffPkSumKWh');
    near(f(b, 'OffPkSumRate'), parseFloat(L.offSum.r), 'OffPkSumRate');
    assert.strictEqual(rateHolds(b).length, 0, 'held: ' + (b._gateReasons || []).join(' | '));
    assert.ok(b._touLines.recovered.includes('OffPkSum:identity'), b._touLines.recovered.join());
  });

  await check('misread kWh used: the derived rate differs from the earlier saved rate, so it is held', async () => {
    setSaved('0.04182');
    const b = await run(touBill({ lines: lostOffSum().lines, used: KWH_USED + 1000 }).text);
    clearSaved();
    const rec = (b._touLines && b._touLines.recovered) || [];
    assert.ok(!rec.includes('OffPkSum:identity'), 'accepted silently');
    near(f(b, 'OffPkSumRate') || 0.04182, 0.04182, 'a wrong rate was stored');
    assert.ok((b._gateReasons || []).length >= 1, 'not held');
  });

  await check('missing quantity: kWh = charge / rate, accepted because round(kWh x rate, 2) = charge', async () => {
    const b = await run(
      touBill({ lines: { onSum: 'Energy Chg On Pk Sum  kWh at $' + L.onSum.r + ' per kWh ............  ' + money(L.onSum.c) } }).text,
    );
    near(f(b, 'OnPkSumKWh'), L.onSum.q, 'OnPkSumKWh');
    assert.strictEqual(holds(b).length, 0, 'bill held: ' + (b._gateReasons || []).join(' | '));
  });

  await check('garbled thousands digit: the whole quantity is repaired, a partial quantity is never stored', async () => {
    // "2,000.0000" read as "5. 000.0000" (the 713.7520 case of the real bill)
    const b = await run(
      touBill({ lines: { onSum: 'Energy Chg On Pk Sum 5. 000.0000 kWh at $' + L.onSum.r + ' per kWh ............  ' + money(L.onSum.c) } }).text,
    );
    near(f(b, 'OnPkSumKWh'), L.onSum.q, 'OnPkSumKWh');
    assert.notStrictEqual(Number(b.OnPeakKWh), 500.5, 'On kWh is a partial quantity');
    near(f(b, 'OnPeakKWh'), L.onSum.q + L.onWin.q, 'On kWh total');
  });

  await check('printed charge wins: a misread rate (qty x rate differs from the printed charge) never replaces the charge', async () => {
    // One On and one Off line, no Sum / Win word. The Off rate is misread (0.04282 for 0.04182); the printed charge
    // is right. A line of the bill (ECA) lost its amount, so the printed total is above the charges read: the
    // older gap check must not "correct" the Off charge to qty x rate.
    const b = await run(
      touBill({
        drop: ['onWin', 'offWin'],
        used: L.onSum.q + L.offSum.q,
        lines: {
          onSum: 'Energy Chg On Pk ' + kwh(L.onSum.q) + ' kWh at $' + L.onSum.r + ' per kWh ............  ' + money(L.onSum.c),
          offSum: 'Energy Chg Off Pk ' + kwh(L.offSum.q) + ' kWh at $0.04282 per kWh ............  ' + money(L.offSum.c),
        },
        extra: 'ECA Chg 09-07-2026-10-06-2026 for ' + kwh(L.onSum.q + L.offSum.q) + ' kWh at $0.01971 per kWh .....',
        subAdd: 41.72,
      }).text,
    );
    near(f(b, 'EnergyOffPeakCharge'), L.offSum.c, 'Off charge keeps the printed value');
    assert.ok(!b._auto_corrected_EnergyOffPeakCharge, 'a correction record was written for the printed charge');
  });

  await check('lines that do not add up to kWh used: held with ONE plain warning', async () => {
    const b = await run(touBill({ used: KWH_USED + 100 }).text);
    assert.strictEqual(holds(b).length, 1, 'hold count ' + holds(b).length + ': ' + (b._gateReasons || []).join(' | '));
    assert.strictEqual(
      holds(b)[0],
      'On-peak and off-peak kWh do not add up to kWh used. Check the PDF.',
      'hold text: ' + holds(b)[0],
    );
    assert.ok(b._gateTripped, 'bill not held');
  });

  await check('two lines unreadable: no partial quantity stored, one warning', async () => {
    // quantity and rate lost on both Winter lines: nothing can rebuild their kWh
    const b = await run(
      touBill({
        lines: {
          onWin: 'Energy Chg On Pk Win 1 kWh at $ per kWh ............  ' + money(L.onWin.c),
          offWin: 'Energy Chg Off Pk Win 9 kWh at $ per kWh ............  ' + money(L.offWin.c),
        },
      }).text,
    );
    assert.ok(!b.OnPeakKWh && !b.OffPeakKWh, 'a partial kWh total was stored: ' + b.OnPeakKWh + ' / ' + b.OffPeakKWh);
    assert.strictEqual(holds(b).length, 1, 'hold count ' + holds(b).length + ': ' + (b._gateReasons || []).join(' | '));
    near(f(b, 'EnergyOnPeakCharge'), cents(L.onSum.c + L.onWin.c), 'charges are still read');
  });

  await check('non-straddle bill: only its two lines', async () => {
    const used = L.onSum.q + L.offSum.q;
    const b = await run(touBill({ drop: ['onWin', 'offWin'], used, dates: ['07/07/2026', '08/06/2026'] }).text);
    assert.ok(b.OnPkSumCharge && b.OffPkSumCharge, 'summer lines missing');
    assert.ok(!b.OnPkWinCharge && !b.OffPkWinCharge, 'winter lines on a summer bill');
    near(f(b, 'EnergyOnPeakCharge'), L.onSum.c, 'On total');
    near(f(b, 'EnergyOffPeakCharge'), L.offSum.c, 'Off total');
    assert.strictEqual(holds(b).length, 0, 'bill held: ' + (b._gateReasons || []).join(' | '));
    assert.strictEqual(ctx.__L(b, 'on').length, 1, 'On lines shown');
    assert.strictEqual(ctx.__L(b, 'off')[0].label, 'Energy Off-Pk Summer', 'label');
  });

  await check('older saved bill: season labels derived for display, stored totals unchanged', async () => {
    const old = {
      BillingPeriodStart: '09/07/2026',
      BillingPeriodEnd: '10/06/2026',
      EnergyOnPeakCharge: '744.67',
      _chargeParts: {
        EnergyOnPeakCharge: [
          { qty: 8713.752, rate: 0.07852, unit: 'kWh', charge: 684.2 },
          { qty: 1769.664, rate: 0.03417, unit: 'kWh', charge: 60.47 },
        ],
      },
    };
    const before = JSON.stringify(old);
    const lines = ctx.__L(old, 'on');
    assert.strictEqual(
      lines.map((l) => l.label).join(','),
      'Energy On-Pk Summer,Energy On-Pk Winter',
    );
    assert.strictEqual(JSON.stringify(old), before, 'the old bill was changed');
    assert.strictEqual(old.EnergyOnPeakCharge, '744.67');
  });

  await check('season rates read the printed season labels of the lines', async () => {
    // the Winter line comes FIRST in the data: only the label (not the order) says which is summer
    const bill = {
      onPeakCost: 744.67,
      offPeakCost: 2349.46,
      _chargeParts: {
        EnergyOnPeakCharge: [
          { qty: 1769.664, rate: 0.03417, charge: 60.47, season: 'Win' },
          { qty: 8713.752, rate: 0.07852, charge: 684.2, season: 'Sum' },
        ],
        EnergyOffPeakCharge: [
          { qty: 9653.52, rate: 0.02915, charge: 281.4, season: 'Win' },
          { qty: 49451.472, rate: 0.04182, charge: 2068.06, season: 'Sum' },
        ],
      },
    };
    const days = { summer: 24, winter: 6, total: 30 };
    const r = ctx.__S(bill, 'kwh', days, ctx.__D);
    assert.ok(r, 'no split');
    assert.strictEqual(r.how, 'label');
    assert.ok(r.summer > r.winter, 'summer rate ' + r.summer + ' winter ' + r.winter);
  });

  if (failures) {
    console.log(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('all passed');
  process.exit(0);
})();
