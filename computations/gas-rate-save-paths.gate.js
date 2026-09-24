#!/usr/bin/env node
// computations/gas-rate-save-paths.gate.js — regression gate for item
// 2026-09-23-gas-rate-fix2 (cold-review NOT READY finding #1: 3 of 4 gas-bill
// SAVE paths in app/bill-analysis.js divided charge by raw MMBtu with no x10
// conversion to Therms, storing a $/MMBtu value mislabeled as $/Therm).
//
// Fix: confirmAutoAssign, _mbSaveOneBill, _saveBillToMatchedMeter, and
// _saveSinglePDFBill now ALL compute `totalGasRate` via one shared helper,
// _computeGasRate(bill) (app/bill-analysis.js), which delegates all
// usage-to-Therms math to the single canonical resolveGasUsageTherms()
// (computations/savings.js) — the same resolver getStoredRate('gas') and
// ensureBillRates() already use.
//
// This gate does two things:
//   1. STRUCTURAL: greps app/bill-analysis.js and asserts every `totalGasRate:`
//      save-time assignment calls `_computeGasRate(...)` — zero duplicate
//      MMBtu-division math anywhere in the file. This is the regression trap:
//      if a future edit reintroduces inline totalGasRate math at ANY save
//      site (new or old), this assertion fails even before the numeric checks
//      below run.
//   2. FUNCTIONAL: loads the REAL app/bill-analysis.js (+ its computations/
//      savings.js dependency) into a Node vm sandbox and calls the REAL
//      _computeGasRate() — the exact function every one of the 4 save paths
//      now calls — with synthetic bills shaped exactly like what each path
//      passes it: raw OCR-extractor output (PascalCase NaturalGasMMbtu/
//      NaturalGasTherms/NaturalGasCCF, e.g. Wood River Energy) for
//      confirmAutoAssign/_mbSaveOneBill/_saveBillToMatchedMeter/
//      _saveSinglePDFBill, AND an already-saved camelCase bill (for the
//      one-time migrations that re-run it on loaded data).
//
// Run:    node computations/gas-rate-save-paths.gate.js
// Exits nonzero on any assertion failure.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const BILL_ANALYSIS_PATH = path.join(REPO, 'app/bill-analysis.js');
const BILL_ANALYSIS_SRC = fs.readFileSync(BILL_ANALYSIS_PATH, 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + ' — ' + e.message);
  }
}

// ── 1. STRUCTURAL: no duplicate gas-rate math anywhere in bill-analysis.js ──
check('structural: every totalGasRate save assignment routes through _computeGasRate', () => {
  const assignLines = BILL_ANALYSIS_SRC.split('\n').filter((l) => /totalGasRate:\s*/.test(l));
  assert.ok(assignLines.length >= 4, 'expected >=4 totalGasRate assignment sites, found ' + assignLines.length);
  for (const line of assignLines) {
    assert.ok(
      /_computeGasRate\(/.test(line),
      'totalGasRate assignment does not call _computeGasRate — duplicate math reintroduced: ' + line.trim(),
    );
  }
});

check('structural: no bare charge/naturalGasMMbtu division remains (the original bug shape)', () => {
  // The original bug: `c / mmbtu` or `cost / mmbtu` with no x10 — matches the exact
  // expression shape the cold review flagged. Fails if that pattern reappears anywhere.
  const bugPattern = /\/\s*mmbtu\b/;
  const offendingLines = BILL_ANALYSIS_SRC.split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => bugPattern.test(l));
  assert.strictEqual(
    offendingLines.length,
    0,
    'found raw charge/mmbtu division (the original bug): lines ' + offendingLines.map((o) => o.i).join(', '),
  );
});

check('structural: exactly one _computeGasRate implementation (no duplicate helper)', () => {
  const defs = BILL_ANALYSIS_SRC.match(/function _computeGasRate\(/g) || [];
  assert.strictEqual(defs.length, 1, 'expected exactly 1 _computeGasRate definition, found ' + defs.length);
});

// ── 2. FUNCTIONAL: drive the REAL _computeGasRate() every save path calls ──
function buildSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // computations/savings.js defines resolveGasUsageTherms as a bare `function` — load it
  // first so _computeGasRate's `typeof resolveGasUsageTherms === 'function'` guard sees
  // the real implementation, not a no-op.
  vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/savings.js'), 'utf8'), sandbox, {
    filename: 'savings.js',
  });
  // Extract JUST the _computeGasRate function body from the real on-disk file (rather than
  // loading all 22k lines of bill-analysis.js, which requires document/pdfStore/showToast/
  // projects globals this test doesn't stub) — the structural checks above already guarantee
  // every save path calls this exact function with no other logic in between, so evaluating
  // its real source text here is equivalent to driving the save paths themselves.
  const m = BILL_ANALYSIS_SRC.match(/function _computeGasRate\(bill\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, '_computeGasRate function body not found in app/bill-analysis.js — source shape changed');
  vm.runInContext(m[0], sandbox, { filename: 'bill-analysis.js (_computeGasRate extract)' });
  return sandbox;
}

const sandbox = buildSandbox();

check(
  '_computeGasRate: MMBtu-only OCR extraction (Wood River Energy shape, PascalCase) = charge / (MMBtu x 10)',
  () => {
    // Synthetic — not a real bill. $200 charge, 5 MMBtu = 50 Therms -> $4.00/Therm.
    const bill = { GasCharge: '200.00', NaturalGasMMbtu: '5' };
    const rate = sandbox._computeGasRate(bill);
    assert.strictEqual(rate, (200 / 50).toFixed(5), 'got ' + rate);
  },
);

check('_computeGasRate: MMBtu-only, TotalCurrentCharges fallback (no GasCharge field)', () => {
  const bill = { TotalCurrentCharges: '83.53', NaturalGasMMbtu: '2.5' }; // 25 Therms
  const rate = sandbox._computeGasRate(bill);
  assert.strictEqual(rate, (83.53 / 25).toFixed(5), 'got ' + rate);
});

check('_computeGasRate: Therms-branch bill (NaturalGasTherms present) unaffected by MMBtu fix', () => {
  const bill = { GasCharge: '52.4873', NaturalGasTherms: '100' };
  const rate = sandbox._computeGasRate(bill);
  assert.strictEqual(rate, (52.4873 / 100).toFixed(5), 'got ' + rate);
});

check('_computeGasRate: CCF-branch bill (NaturalGasCCF present, x1.037 conversion)', () => {
  const bill = { GasCharge: '100', NaturalGasCCF: '96.43' }; // ~100.02 Therms
  const rate = sandbox._computeGasRate(bill);
  const expectTherms = 96.43 * 1.037;
  assert.strictEqual(rate, (100 / expectTherms).toFixed(5), 'got ' + rate);
});

check('_computeGasRate: same underlying gas volume gives the SAME $/Therm whether reported as Therms or MMBtu', () => {
  const thermsBill = { GasCharge: '400', NaturalGasTherms: '40' };
  const mmbtuBill = { GasCharge: '400', NaturalGasMMbtu: '4' }; // 4 MMBtu = 40 Therms
  const rateA = sandbox._computeGasRate(thermsBill);
  const rateB = sandbox._computeGasRate(mmbtuBill);
  assert.strictEqual(rateA, rateB, 'Therms=' + rateA + ' vs MMBtu=' + rateB + ' — unit-dependent rate (regression)');
});

check('_computeGasRate: already-saved camelCase bill (post-save/migration shape) also resolves', () => {
  const bill = { gasCharge: '200.00', naturalGasMMbtu: '5' };
  const rate = sandbox._computeGasRate(bill);
  assert.strictEqual(rate, (200 / 50).toFixed(5), 'got ' + rate);
});

check('_computeGasRate: no usage and no charge -> blank (never a fabricated rate)', () => {
  const rate = sandbox._computeGasRate({});
  assert.strictEqual(rate, '', 'got ' + JSON.stringify(rate));
});

check('_computeGasRate: MMBtu-only rate is NEVER the old (unconverted) $/MMBtu value', () => {
  // The bug this item fixes: cold review found stored rates 6-16x too high because the
  // save path divided by raw MMBtu instead of MMBtu x 10 Therms.
  const bill = { GasCharge: '83.53', NaturalGasMMbtu: '1' };
  const rate = parseFloat(sandbox._computeGasRate(bill));
  const buggyOldRate = 83.53 / 1; // what the pre-fix save paths would have stored
  assert.ok(rate < buggyOldRate / 5, 'rate ' + rate + ' too close to buggy $/MMBtu value ' + buggyOldRate);
  assert.strictEqual(rate, 8.353, 'expected 83.53 / (1*10) = 8.353, got ' + rate);
});

// ── 3. FUNCTIONAL: the v2 second-pass migration (cold-review NOT READY finding #2) ──
// Extracts and runs the REAL migration block from app/utility-data.js (same on-disk-source
// extraction technique as _computeGasRate above — the structural check right after this
// confirms the extracted text still matches what's on disk) against a stubbed DB/
// utilityData/saveUtilityData so the exact gate-timing, manual-marker, and MMBtu-only-scope
// logic runs for real, not a re-implementation.
const UTILITY_DATA_SRC = fs.readFileSync(path.join(REPO, 'app/utility-data.js'), 'utf8');
const V2_BLOCK_MATCH = UTILITY_DATA_SRC.match(
  /const _gasMMbtuRateFixedKeyV2[\s\S]*?\n {4}if \(billsScannedV2 > 0\) DB\.set\(_gasMMbtuRateFixedKeyV2, '1'\);\n {2}\}\n/,
);

check('structural: v2 migration block still present on disk (extraction target unchanged)', () => {
  assert.ok(V2_BLOCK_MATCH, 'v2 migration block not found in app/utility-data.js — source shape changed');
});

function runV2Migration(initialUtilityData, dbStore) {
  const sandbox = {
    console,
    utilityData: initialUtilityData,
    SAVE_ALL_PROJECTS: '__ALL__',
    saveCalls: 0,
    DB: {
      get: (k) => dbStore[k],
      set: (k, v) => {
        dbStore[k] = v;
      },
    },
    saveUtilityData: function () {
      sandbox.saveCalls++;
    },
    resolveGasUsageTherms: null, // set below after loading savings.js
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'computations/savings.js'), 'utf8'), sandbox, {
    filename: 'savings.js',
  });
  vm.runInContext(V2_BLOCK_MATCH[0], sandbox, { filename: 'utility-data.js (v2 migration extract)' });
  return sandbox;
}

check('v2 migration: fixes an MMBtu-only bill left wrong by the old save-path bug', () => {
  const dbStore = {};
  const ud = {
    p1: {
      buildings: [
        {
          id: 'b1',
          name: 'Spring Hill High',
          meters: [
            {
              id: 'm1',
              commodity: 'Gas',
              bills: [
                // Simulates a bill saved by the pre-fix confirmAutoAssign: cost/mmbtu with no x10.
                { end: '2026-04-30', GasCharge: '38.17', naturalGasMMbtu: '1.2', totalGasRate: '31.80833' },
              ],
            },
          ],
        },
      ],
    },
  };
  const sandbox = runV2Migration(ud, dbStore);
  const bill = ud.p1.buildings[0].meters[0].bills[0];
  assert.strictEqual(bill.totalGasRate, (38.17 / 12).toFixed(5), 'got ' + bill.totalGasRate); // 1.2*10=12 Therms
  assert.strictEqual(sandbox.saveCalls, 1, 'expected saveUtilityData to be called once');
  assert.strictEqual(dbStore['en_utility_gas_mmbtu_rate_fixed_v2'], '1', 'gate should be set after a real scan');
});

check('v2 migration: NEVER overwrites a bill the user hand-corrected (_userCorrected marker)', () => {
  const dbStore = {};
  const ud = {
    p1: {
      buildings: [
        {
          id: 'b1',
          name: 'Test Bldg',
          meters: [
            {
              id: 'm1',
              commodity: 'Gas',
              bills: [
                {
                  end: '2026-03-31',
                  GasCharge: '38.17',
                  naturalGasMMbtu: '1.2',
                  totalGasRate: '9.99999', // deliberately NOT what the formula would give
                  _userCorrected: { totalGasRate: { original: '31.80833', at: '2026-09-01T00:00:00.000Z' } },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  runV2Migration(ud, dbStore);
  const bill = ud.p1.buildings[0].meters[0].bills[0];
  assert.strictEqual(
    bill.totalGasRate,
    '9.99999',
    'hand-corrected bill must be left untouched, got ' + bill.totalGasRate,
  );
  assert.ok(
    JSON.parse(dbStore['en_gas_mmbtu_rate_fix_v2_skipped_report'] || '[]').length === 1,
    'skipped-manual report should list the hand-corrected bill',
  );
});

check('v2 migration: never trips its gate on an empty pre-Restore pass (gate-timing guard)', () => {
  const dbStore = {};
  const sandbox = runV2Migration({}, dbStore);
  assert.strictEqual(sandbox.saveCalls, 0, 'must not call saveUtilityData on an empty pass');
  assert.strictEqual(
    dbStore['en_utility_gas_mmbtu_rate_fixed_v2'],
    undefined,
    'gate must NOT be set on an empty/pre-data pass — it must retry on the next real load',
  );
});

check('v2 migration: leaves Therms/CCF-branch gas bills alone (out of MMBtu-only scope)', () => {
  const dbStore = {};
  const ud = {
    p1: {
      buildings: [
        {
          id: 'b1',
          name: 'Test Bldg',
          meters: [
            {
              id: 'm1',
              commodity: 'Gas',
              bills: [{ end: '2026-03-31', gasCharge: '52.4873', naturalGasTherms: '100', totalGasRate: '0.52487' }],
            },
          ],
        },
      ],
    },
  };
  const sandbox = runV2Migration(ud, dbStore);
  const bill = ud.p1.buildings[0].meters[0].bills[0];
  assert.strictEqual(
    bill.totalGasRate,
    '0.52487',
    'Therms-branch bill must not be touched by the MMBtu-only migration',
  );
  assert.strictEqual(sandbox.saveCalls, 0, 'no change made -> no save call');
});

console.log('');
if (failures > 0) {
  console.log(failures + ' FAILURE(S)');
  process.exit(1);
} else {
  console.log('ALL PASS');
}
