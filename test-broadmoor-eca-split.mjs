// test-broadmoor-eca-split.mjs — targeted self-check for the split-ECA
// kWhConsumed witness-consensus override (2026-09-03).
// Loads the REAL app/bill-analysis.js via the same vm technique as
// test-kwh-corroboration.mjs (no reimplementation of app logic).
//
// Run: node test-broadmoor-eca-split.mjs

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = __dirname;

let pass = 0;
let fail = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-4
    : String(actual) === String(expected);
  if (ok) pass++;
  else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function assertTrue(actual, label) {
  if (actual) pass++;
  else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}

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
  'app/energy-savings.js',
  'app/bill-analysis.js',
];

function loadRealPipeline() {
  const sandboxWindow = { addEventListener: () => {}, removeEventListener: () => {}, location: { href: '', search: '' } };
  const sandboxDocument = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, getContext: () => null }),
  };
  const sandbox = {
    console,
    window: sandboxWindow,
    document: sandboxDocument,
    navigator: { userAgent: 'node-broadmoor-eca-split-test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Chart: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    Image: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const skipped = [];
  for (const rel of LOAD_ORDER) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) { skipped.push(rel + ' (not found)'); continue; }
    try {
      vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      skipped.push(rel + ' (load error: ' + e.message + ')');
    }
  }
  vm.runInContext(
    [
      'this.__decideQuantityCorrection = typeof _decideQuantityCorrection !== "undefined" ? _decideQuantityCorrection : null;',
      'this.__gatherKwhWitnesses = typeof _gatherKwhWitnesses !== "undefined" ? _gatherKwhWitnesses : null;',
      'this.__UTILITY_RULES = typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null;',
      'this.__postExtractionVerify = typeof _postExtractionVerify !== "undefined" ? _postExtractionVerify : null;',
      'this.__analyzeBillExtraction = typeof analyzeBillExtraction !== "undefined" ? analyzeBillExtraction : null;',
    ].join('\n'),
    ctx,
    { filename: 'export-tags.js' },
  );
  return {
    decideQuantityCorrection: ctx.__decideQuantityCorrection,
    gatherKwhWitnesses: ctx.__gatherKwhWitnesses,
    UTILITY_RULES: ctx.__UTILITY_RULES,
    postExtractionVerify: ctx.__postExtractionVerify,
    analyzeBillExtraction: ctx.__analyzeBillExtraction,
    skipped,
  };
}

const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);

async function main() {
  const X = loadRealPipeline();
  if (X.skipped.length) {
    console.log('SKIPPED FILES:');
    for (const s of X.skipped) console.log('  ' + s);
  }
  assertTrue(!!X.decideQuantityCorrection, 'export: _decideQuantityCorrection');
  assertTrue(!!X.gatherKwhWitnesses, 'export: _gatherKwhWitnesses');

  // ── Case A: Broadmoor shape via _gatherKwhWitnesses + _decideQuantityCorrection ──
  // kWhConsumed extracted as ONLY the 2nd ECA sub-line (13,357.0909) instead of
  // the full-period total (35,618.9091 + 13,357.0909 = 48,976). EER/PTS/ECA-sum/
  // On+Off-peak-sum all self-verify and unanimously agree on 48,976.
  {
    const bill = {
      kWhConsumed: '13357.0909',
      EERCharge: '27.43', // 48976 * 0.00056 = 27.42656 -> rounds to 27.43
      PTSCharge: '50.44', // 48976 * 0.00103 = 50.44528 -> rounds to 50.44 (within a cent tol below)
      EnergyOnPeakCharge: '319.02', // 5849.3539 * 0.05455
      EnergyOffPeakCharge: '1980.19', // 43126.6462 * 0.04592 (approx)
      _rates: {
        EERCharge: { rate: 0.00056, parts: [{ qty: 48976 }] },
        PTSCharge: { rate: 0.00103, parts: [{ qty: 48976 }] },
        ECACharge: {
          rate: 0.02,
          parts: [
            { qty: 35618.9091, rate: 0.02 },
            { qty: 13357.0909, rate: 0.02 },
          ],
        },
        EnergyOnPeakCharge: { rate: 0.05455, parts: [{ qty: 5849.3539, rate: 0.05455, computed: 319.02 }] },
        EnergyOffPeakCharge: { rate: 0.04592, parts: [{ qty: 43126.6462, rate: 0.04592, computed: 1980.18 }] },
      },
    };
    // Fix EER/PTS/ECA charges to self-verify exactly within a cent.
    bill.EERCharge = (48976 * 0.00056).toFixed(2);
    bill.PTSCharge = (48976 * 0.00103).toFixed(2);
    bill.ECACharge = (35618.9091 * 0.02 + 13357.0909 * 0.02).toFixed(2);
    bill._rates.ECACharge.parts[0].qty = 35618.9091;
    bill.EnergyOnPeakCharge = (5849.3539 * 0.05455).toFixed(2);
    bill.EnergyOffPeakCharge = (43126.6462 * 0.04592).toFixed(2);
    bill._rates.EnergyOnPeakCharge.parts[0].computed = parseFloat(bill.EnergyOnPeakCharge);
    bill._rates.EnergyOffPeakCharge.parts[0].computed = parseFloat(bill.EnergyOffPeakCharge);

    const witnesses = X.gatherKwhWitnesses(bill, pf);
    const bySource = Object.fromEntries(witnesses.map((w) => [w.source, w]));
    assertTrue(!!bySource['ECACharge'] && bySource['ECACharge'].value === 48976, 'Broadmoor: ECACharge witness sums both sub-lines to 48976');
    assertTrue(!!bySource['EERCharge'] && bySource['EERCharge'].strong, 'Broadmoor: EER witness self-verifies STRONG');
    assertTrue(!!bySource['PTSCharge'] && bySource['PTSCharge'].strong, 'Broadmoor: PTS witness self-verifies STRONG');
    assertTrue(!!bySource['On+Off peak sum'] && bySource['On+Off peak sum'].strong, 'Broadmoor: On+Off-peak witness self-verifies STRONG');

    const decision = X.decideQuantityCorrection('kWhConsumed', pf(bill.kWhConsumed), witnesses);
    assertTrue(decision.apply === true, 'Broadmoor: decision applies despite >5% swing (unanimous override)');
    assertTrue(decision.unanimousOverride === true, 'Broadmoor: decision flagged as unanimousOverride');
    assertEqual(decision.corrected, 48976, 'Broadmoor: corrected kWhConsumed = 48976 (full ECA-split total)');
    console.log('Broadmoor decision.reason:', decision.reason);
  }

  // ── Case B: LMS bill 30 regression guard — unanimous strong witnesses but NO
  // bucket echoing the (wrong) current value exists at all (synthetic shape
  // from test-kwh-corroboration.mjs). Must still HOLD, not auto-apply — this
  // is the pre-existing behavior this fix must not disturb.
  {
    const witnesses = [
      { source: 'EERCharge', value: 42135.84, strong: true },
      { source: 'PTSCharge', value: 42135.84, strong: true },
      { source: 'ECACharge', value: 42135.84, strong: true },
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 70226.4, witnesses);
    assertTrue(d.hold === true && d.apply === false, 'LMS bill 30 regression: still HELD (no self-echo bucket to distinguish from genuine conflict)');
  }

  // ── Case C: genuinely conflicting evidence must still refuse ──
  // Winner bucket (48976) disagrees with current (13357), but a SECOND
  // independent (non-current-matching) bucket also disagrees — e.g. a weak
  // meter-read derivation landing on a THIRD value. Must NOT unanimous-override.
  {
    const witnesses = [
      { source: 'EERCharge', value: 48976, strong: true },
      { source: 'PTSCharge', value: 48976, strong: true },
      { source: 'printed kWh Used', value: 13357.0909, strong: false },
      { source: 'EndRead-StartRead×Multiplier', value: 30000, strong: false }, // 3rd, independent, conflicting value
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 13357.0909, witnesses);
    assertTrue(d.hold === true && d.apply === false, 'Genuine 3-way conflict: held, not overridden (real disagreement present)');
  }

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  process.exit(1);
});
