// tools/test-bas-trends-math.js - WP-18 BAS Trends math (E-BT-1..5, DUP-5, math-01 E14).
// Run: node tools/test-bas-trends-math.js
// Real function text from app/bas-trends.js is loaded into a vm. Synthetic data only.
'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'bas-trends.js'), 'utf8');
let passed = 0,
  failed = 0;
function assert(c, m) {
  if (c) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + m);
  }
}
function block(startIdx, open, close) {
  let d = 0,
    j = SRC.indexOf(open, startIdx);
  for (; j < SRC.length; j++) {
    if (SRC[j] === open) d++;
    else if (SRC[j] === close && --d === 0) break;
  }
  return j;
}
function loadFn(fn) {
  const mi = SRC.indexOf('function ' + fn + '(');
  if (mi < 0) return '';
  const e = block(mi, '(', ')');
  const j = block(e, '{', '}');
  return SRC.slice(mi, j + 1);
}
function loadVar(name) {
  const mi = SRC.indexOf('var ' + name + ' =');
  if (mi < 0) return '';
  let d = 0,
    j = mi;
  for (; j < SRC.length; j++) {
    const c = SRC[j];
    if ('[{('.includes(c)) d++;
    else if (']})'.includes(c)) d--;
    else if (c === ';' && !d) break;
  }
  return SRC.slice(mi, j + 1);
}

// Synthetic project: one building, electric meter (1200 / 10000 kWh = 0.12), gas meter (600 / 100 therm = 6.00).
const bldgs = [
  {
    id: 'B1',
    name: 'Test Bldg',
    meters: [
      {
        id: 'M1',
        commodity: 'Electric',
        bills: [
          { id: 'e1', start: '2026-01-01', end: '2026-01-31', totalCost: 1200, kwh: 10000 },
          { id: 'e2', start: '2026-02-01', end: '2026-02-28', totalCost: 0, kwh: 0 },
        ],
      },
      {
        id: 'M2',
        commodity: 'Gas',
        bills: [{ id: 'g1', start: '2026-01-01', end: '2026-01-31', totalCost: 600, therms: 100 }],
      },
    ],
  },
];
const gasOnly = [{ id: 'B1', meters: [bldgs[0].meters[1]] }];
let activeBldgs = bldgs;

function day(o) {
  return Object.assign({ fanstatus: { runtimeHours: 10 }, faults: {} }, o);
}
const basData = {
  buildings: {
    B1: {
      equipment: {
        AHU1: {
          days: {
            '2026-01-05': day({
              occupied: { scheduledHours: 10, actualHours: 9 },
              coolvalve: { occupiedAvg: 20 },
              heatvalve: { occupiedAvg: 0 },
              faults: { afterHours: 5, shc: 2, economizer: 1 },
            }),
            '2026-01-06': day({ coolvalve: { occupiedAvg: 20 }, faults: {} }), // no occupied data
          },
        },
      },
    },
  },
};

const code = [
  loadFn('btRound'),
  loadVar('BT_HVAC_KW_PER_AHU'),
  loadVar('BT_FAULT_KW'),
  loadFn('btFaultKwh'),
  loadFn('btAssumeText'),
  loadFn('btGetBlendedRate'),
  loadFn('btGetBASForBillPeriod'),
  loadFn('btEstimateSavings'),
  loadFn('btMonthsCovered'),
  loadFn('btIntervalHours'),
].join('\n');
const ctx = {
  getUDBldgs: () => activeBldgs,
  btGetData: () => basData,
  btRunBehavioralChecks: () => ({ satReset: null, dspReset: null, economizer: null }),
  console,
};
vm.createContext(ctx);
try {
  vm.runInContext(code, ctx);
} catch (e) {
  console.log('  LOAD ERROR: ' + e.message);
}
const has = (n) => typeof ctx[n] === 'function';

// E-BT-3: rate reads meters[].bills and 'Electric'
assert(
  has('btGetBlendedRate') && ctx.btGetBlendedRate('P', 'B1', 'Electric') === 0.12,
  'blended rate reads meters[].bills Electric = 0.12, got ' +
    (has('btGetBlendedRate') && ctx.btGetBlendedRate('P', 'B1', 'Electric')),
);
activeBldgs = gasOnly;
assert(
  has('btGetBlendedRate') && ctx.btGetBlendedRate('P', 'B1', 'Electric') === null,
  'no electric bills -> null (no 0.10 fallback)',
);
activeBldgs = bldgs;

// E-BT-1: gas bill must not price electric fault kWh at gas $/therm
const g =
  has('btGetBASForBillPeriod') && ctx.btGetBASForBillPeriod('P', 'B1', '2026-01-01', '2026-01-31', 600, 100, 'Gas');
assert(g && g.blendedRate === 0.12, 'gas bill: fault kWh priced at electric rate 0.12, got ' + (g && g.blendedRate));
const el =
  has('btGetBASForBillPeriod') &&
  ctx.btGetBASForBillPeriod('P', 'B1', '2026-01-01', '2026-01-31', 1000, 10000, 'Electric');
assert(el && el.blendedRate === 0.1, 'electric bill: bill-specific rate 0.1, got ' + (el && el.blendedRate));

// E-BT-2: per-day occupied hours, no 8 h fallback
assert(
  el && el.runtimeTotals.occupiedHours === 10,
  'occupied hours = 10 (only the day with data), got ' + (el && el.runtimeTotals.occupiedHours),
);
assert(
  el && el.runtimeTotals.coolingHours === 10,
  'cooling hours = 10 (no 8 h fallback for the day without occupied data), got ' +
    (el && el.runtimeTotals.coolingHours),
);

// DUP-5: one fault kW table. afterHours 5h*8kW + shc 2h*4kW + econ 1h*3kW = 51 kWh * 0.12
assert(
  el && Math.abs(g.estWasteDollars - 6.12) < 0.005,
  'waste $ = 51 kWh * 0.12 = 6.12, got ' + (g && g.estWasteDollars),
);
assert(
  !/HVAC_KW\s*=\s*20/.test(SRC.replace(/var BT_HVAC_KW_PER_AHU\s*=\s*20/, '')) && !/hvacKW\s*=\s*20/.test(SRC),
  'no local HVAC_KW/hvacKW = 20 copies remain',
);

// E-BT-4: annualize by 365 / days at any window length (10 days -> x36.5)
// E-BT-3 (no 0.10): no rate -> dollars null
activeBldgs = gasOnly;
const est = has('btEstimateSavings') ? ctx.btEstimateSavings('P', 'B1') : [];
const ah = est.find((e) => e.type === 'afterHours');
assert(
  ah && ah.annualDollars === null,
  'no electric rate -> annualDollars null (rate unavailable), got ' + (ah && ah.annualDollars),
);
activeBldgs = bldgs;
const est2 = has('btEstimateSavings') ? ctx.btEstimateSavings('P', 'B1', { fanHpPerAhu: 5 }) : [];
const ah2 = est2.find((e) => e.type === 'afterHours');
// 2 days in window (max per equipment): scale = 365/2; hrs = 5 * 182.5 = 912.5 -> detail "913 hrs/yr"
assert(
  ah2 && /^913 hrs\/yr/.test(ah2.detail),
  'annualized by 365/totalDays even under 14 days, got ' + (ah2 && ah2.detail),
);

// math-01 E14: months covered by real month length
assert(
  has('btMonthsCovered') &&
    Math.abs(
      ctx.btMonthsCovered(Array.from({ length: 31 }, (_, i) => '2026-01-' + String(i + 1).padStart(2, '0'))) - 1,
    ) < 1e-9,
  '31 days of January = 1.0 month',
);
assert(
  has('btMonthsCovered') &&
    Math.abs(
      ctx.btMonthsCovered(Array.from({ length: 28 }, (_, i) => '2026-02-' + String(i + 1).padStart(2, '0'))) - 1,
    ) < 1e-9,
  '28 days of February = 1.0 month',
);

// E-BT-5: interval = median gap, not first two rows
const t0 = Date.UTC(2026, 0, 5);
const rows = [0, 1, 16, 31, 46, 61, 76].map((m) => ({ ts: t0 + m * 60000 })); // first gap 1 min, rest 15 min
assert(
  has('btIntervalHours') && Math.abs(ctx.btIntervalHours(rows) - 0.25) < 1e-9,
  'interval from median gap = 0.25 h, got ' + (has('btIntervalHours') && ctx.btIntervalHours(rows)),
);

// Follow-up 1: gas rate from the gas meters' bills through the same helper; no $0.80 default
assert(has('btGetBlendedRate') && ctx.btGetBlendedRate('P', 'B1', 'Gas') === 6, 'gas rate = 600 / 100 therms = 6');
assert(
  !SRC.slice(SRC.indexOf('function btEstimateSavings('), SRC.indexOf('function btRenderSavingsPanel(')).includes(
    '0.8;',
  ),
  'no 0.8 $/therm literal in btEstimateSavings',
);
const elecOnly = [{ id: 'B1', meters: [bldgs[0].meters[0]] }];
activeBldgs = elecOnly;
const est3 = has('btEstimateSavings') ? ctx.btEstimateSavings('P', 'B1') : [];
const shc3 = est3.find((e) => e.type === 'shc');
const ah3 = est3.find((e) => e.type === 'afterHours');
assert(
  shc3 && shc3.annualDollars === null,
  'no gas bills -> SHC dollars null (rate unavailable), got ' + (shc3 && shc3.annualDollars),
);
assert(ah3 && ah3.annualDollars > 0, 'after-hours (electric only) still priced');
activeBldgs = bldgs;
const shc4 = (has('btEstimateSavings') ? ctx.btEstimateSavings('P', 'B1') : []).find((e) => e.type === 'shc');
assert(shc4 && shc4.annualDollars > 0, 'with gas bills SHC is priced');

// Follow-up 2: the 4.9 kW fan model is shown as a labeled assumption
assert(
  ah2 && ah2.assumption === 'Assumes 4.9 kW per air handler fan — not measured.',
  'after-hours assumption label, got ' + (ah2 && ah2.assumption),
);

console.log('\ntest-bas-trends-math: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
