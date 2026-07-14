// test-kwh-corroboration.mjs — unit + acceptance tests for the kWh corruption
// cascade fix (2026-07-14, see docs/dashboardlogic.md).
//
// Covers:
//   1. Unit tests for the corroboration primitives (_qtySelfVerifies,
//      _decideQuantityCorrection, _gatherKwhWitnesses, _decideOnOffPeakKWh)
//      exported from app/bill-analysis.js via the same Node `vm` technique
//      used by AI/_context/reference/ocr-harness/gate-a-run.mjs and
//      test_ocr_phase0_harness.mjs — loads the REAL source, no reimplementation.
//   2. The acceptance test: Matt's real 4-bill Louisburg April 2026 Evergy
//      extraction, driven through the REAL extractAll() + _postExtractionVerify()
//      + analyzeBillExtraction() pipeline from raw OCR text (same raw text
//      captured in his production debug file), asserting every corrected
//      field against the known-good values documented in the bug report.
//
// Run: node test-kwh-corroboration.mjs   (from the repo root)

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
  const a = typeof actual === 'number' ? actual : actual;
  const e = typeof expected === 'number' ? expected : expected;
  const ok = typeof a === 'number' && typeof e === 'number' ? Math.abs(a - e) < 1e-6 : String(a) === String(e);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertTrue(actual, label) {
  if (actual) {
    pass++;
  } else {
    fail++;
    failures.push(label + ': expected truthy, got ' + JSON.stringify(actual));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Load the REAL app source into a Node vm sandbox (same LOAD_ORDER as
// test_ocr_phase0_harness.mjs / harness.js), export the internal functions
// under test so this file never reimplements extraction logic.
// ─────────────────────────────────────────────────────────────────────────
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
  const sandboxWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: '', search: '' },
  };
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
    navigator: { userAgent: 'node-kwh-corroboration-test' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  const skipped = [];
  for (const rel of LOAD_ORDER) {
    const full = path.join(REPO, rel);
    if (!fs.existsSync(full)) {
      skipped.push(rel + ' (not found)');
      continue;
    }
    try {
      vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      skipped.push(rel + ' (load error: ' + e.message + ')');
    }
  }
  vm.runInContext(
    [
      'this.__UTILITY_RULES = typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null;',
      'this.__postExtractionVerify = typeof _postExtractionVerify !== "undefined" ? _postExtractionVerify : null;',
      'this.__analyzeBillExtraction = typeof analyzeBillExtraction !== "undefined" ? analyzeBillExtraction : null;',
      'this.__qtySelfVerifies = typeof _qtySelfVerifies !== "undefined" ? _qtySelfVerifies : null;',
      'this.__decideQuantityCorrection = typeof _decideQuantityCorrection !== "undefined" ? _decideQuantityCorrection : null;',
      'this.__gatherKwhWitnesses = typeof _gatherKwhWitnesses !== "undefined" ? _gatherKwhWitnesses : null;',
      'this.__decideOnOffPeakKWh = typeof _decideOnOffPeakKWh !== "undefined" ? _decideOnOffPeakKWh : null;',
    ].join('\n'),
    ctx,
    { filename: 'export-tags.js' },
  );
  return {
    UTILITY_RULES: ctx.__UTILITY_RULES,
    postExtractionVerify: ctx.__postExtractionVerify,
    analyzeBillExtraction: ctx.__analyzeBillExtraction,
    qtySelfVerifies: ctx.__qtySelfVerifies,
    decideQuantityCorrection: ctx.__decideQuantityCorrection,
    gatherKwhWitnesses: ctx.__gatherKwhWitnesses,
    decideOnOffPeakKWh: ctx.__decideOnOffPeakKWh,
    skipped,
  };
}

const pf = (v) => (v ? parseFloat(String(v).replace(/,/g, '')) || 0 : 0);

async function main() {
  const X = loadRealPipeline();
  if (X.skipped.length) {
    console.log('SKIPPED FILES (not found or load error):');
    for (const s of X.skipped) console.log('  ' + s);
  }
  assertTrue(!!X.qtySelfVerifies, 'export: _qtySelfVerifies');
  assertTrue(!!X.decideQuantityCorrection, 'export: _decideQuantityCorrection');
  assertTrue(!!X.gatherKwhWitnesses, 'export: _gatherKwhWitnesses');
  assertTrue(!!X.decideOnOffPeakKWh, 'export: _decideOnOffPeakKWh');

  // ── _qtySelfVerifies ──────────────────────────────────────────────────
  assertTrue(X.qtySelfVerifies(1053.8354, 0.00056, 0.59), 'selfVerify: EER exact match within a cent');
  assertTrue(X.qtySelfVerifies(251.4974, 0.05438, 13.67), 'selfVerify: within-a-cent rounding (13.676 vs 13.67)');
  assertTrue(!X.qtySelfVerifies(973.04, 0.00056, 0.59), 'selfVerify: wrong qty must NOT verify');
  assertTrue(!X.qtySelfVerifies(0, 0.00056, 0.59), 'selfVerify: zero qty must NOT verify');
  assertTrue(!X.qtySelfVerifies(1053.8354, 0, 0.59), 'selfVerify: zero rate must NOT verify');

  // ── _decideQuantityCorrection ────────────────────────────────────────
  // Case: current value already in the strongest cluster — no correction.
  {
    const witnesses = [
      { source: 'printed kWh Used', value: 1053.84, strong: true },
      { source: 'EERCharge', value: 1053.8354, strong: true },
      { source: 'PTSCharge', value: 1053.8354, strong: true },
      { source: 'EndRead−StartRead×Multiplier', value: 973.04, strong: false },
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 1053.84, witnesses);
    assertTrue(
      !d.apply && !d.hold,
      'decideQuantity: Louisburg bill 4 shape — current already in winning cluster, no correction',
    );
  }
  // Case: current value is the OCR-corrupted outlier, strong witnesses agree elsewhere — apply.
  {
    const witnesses = [
      { source: 'ReadDifference×Multiplier', value: 2282.496, strong: false },
      { source: 'EndRead−StartRead×Multiplier', value: 2282.496, strong: false },
      { source: 'EERCharge', value: 2282.5018, strong: true },
      { source: 'PTSCharge', value: 2282.5018, strong: true },
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 2262.496, witnesses);
    assertTrue(d.apply === true, 'decideQuantity: Louisburg bill 2 shape — outlier corrected');
    assertEqual(
      d.corrected,
      2282.5018,
      'decideQuantity: Louisburg bill 2 shape — corrected value uses the strong witnesses, not the weak anchor',
    );
  }
  // Case: only WEAK witnesses disagree with current — refuse (hold), never guess off unverified evidence.
  {
    const witnesses = [{ source: 'EndRead−StartRead×Multiplier', value: 973.04, strong: false }];
    const d = X.decideQuantityCorrection('kWhConsumed', 1053.84, witnesses);
    assertTrue(
      d.hold === true && d.apply === false,
      'decideQuantity: weak-only disagreement refuses rather than guessing',
    );
  }
  // Case: strong witnesses agree but the swing exceeds the 5% auto-apply threshold — hold for confirmation.
  {
    const witnesses = [
      { source: 'EERCharge', value: 42135.84, strong: true },
      { source: 'PTSCharge', value: 42135.84, strong: true },
      { source: 'ECACharge', value: 42135.84, strong: true },
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 70226.4, witnesses);
    assertTrue(
      d.hold === true && d.apply === false,
      'decideQuantity: LMS bill 30 shape — 40% swing held despite 3 strong witnesses',
    );
  }
  // Case: two buckets tie on strong-witness count and total count — ambiguous, refuse.
  {
    const witnesses = [
      { source: 'A', value: 100, strong: true },
      { source: 'B', value: 200, strong: true },
    ];
    const d = X.decideQuantityCorrection('kWhConsumed', 500, witnesses);
    assertTrue(d.hold === true, 'decideQuantity: tied strong buckets refuse rather than pick a side');
  }

  // ── _gatherKwhWitnesses (synthetic bill matching Louisburg bill 4 shape) ──
  {
    const bill4 = {
      kWhConsumed: '1053.8400',
      ReadDifference: '13.1730',
      MeterMultiplier: '80.0000',
      EndRead: '1728.5289',
      StartRead: '1716.3659',
      EERCharge: '0.59',
      PTSCharge: '1.09',
      EnergyOnPeakCharge: '13.67',
      EnergyOffPeakCharge: '38.26',
      _rates: {
        EERCharge: { rate: 0.00056, parts: [{ qty: 1053.8354 }] },
        PTSCharge: { rate: 0.00103, parts: [{ qty: 1053.8354 }] },
        EnergyOnPeakCharge: { rate: 0.05438, parts: [{ qty: 251.4974 }] },
        EnergyOffPeakCharge: { rate: 0.04769, parts: [{ qty: 802.3379 }] },
      },
    };
    const w = X.gatherKwhWitnesses(bill4, pf);
    const bySource = Object.fromEntries(w.map((x) => [x.source, x]));
    assertTrue(!!bySource['EERCharge'] && bySource['EERCharge'].strong, 'gatherWitnesses: EER self-verifies');
    assertTrue(!!bySource['PTSCharge'] && bySource['PTSCharge'].strong, 'gatherWitnesses: PTS self-verifies');
    assertTrue(!!bySource['printed kWh Used'], 'gatherWitnesses: printed kWh Used present');
    assertTrue(
      !!bySource['EndRead−StartRead×Multiplier'] && !bySource['EndRead−StartRead×Multiplier'].strong,
      'gatherWitnesses: EndRead-StartRead is WEAK (the exact derivation that corrupted production)',
    );
    const decision = X.decideQuantityCorrection('kWhConsumed', pf(bill4.kWhConsumed), w);
    assertTrue(
      !decision.apply,
      'gatherWitnesses+decide: Louisburg bill 4 end-to-end — no correction (current already correct)',
    );
  }

  // ── _decideOnOffPeakKWh ───────────────────────────────────────────────
  // Bill 2 shape: OnPeak self-verifies, OffPeak's rate is missing entirely
  // (garbled OCR) — must derive OffPeak from the corroborated total, not
  // trust a stale identity-recovered value.
  {
    const bill2 = {
      OnPeakKWh: '349.6962',
      OffPeakKWh: '1912.7998', // stale, wrongly identity-recovered upstream
      EnergyOnPeakCharge: '13.02',
      EnergyOffPeakCharge: null,
      _rates: {
        EnergyOnPeakCharge: { rate: 0.03723, parts: [{ qty: 349.6962 }] },
        // EnergyOffPeakCharge intentionally absent — matches the real bug
      },
    };
    const d = X.decideOnOffPeakKWh(bill2, pf, 2282.5018, false);
    assertTrue(!!d.offCorrection, 'decideOnOff: bill 2 shape — OffPeak corrected');
    assertEqual(
      d.offCorrection.value,
      1932.8056,
      'decideOnOff: bill 2 shape — OffPeak = kWhConsumed - self-verified OnPeak',
    );
    assertTrue(!d.onCorrection, 'decideOnOff: bill 2 shape — self-verified OnPeak left untouched');
  }
  // Bill 4 shape: both legs self-verify and already sum to kWhConsumed — no-op.
  {
    const bill4 = {
      OnPeakKWh: '251.4974',
      OffPeakKWh: '802.3379',
      EnergyOnPeakCharge: '13.67',
      EnergyOffPeakCharge: '38.26',
      _rates: {
        EnergyOnPeakCharge: { rate: 0.05438, parts: [{ qty: 251.4974 }] },
        EnergyOffPeakCharge: { rate: 0.04769, parts: [{ qty: 802.3379 }] },
      },
    };
    const d = X.decideOnOffPeakKWh(bill4, pf, 1053.84, false);
    assertTrue(
      !d.onCorrection && !d.offCorrection && !d.gate,
      'decideOnOff: bill 4 shape — already consistent, no mutation',
    );
  }
  // LMS bill 30 shape: field already corrupted upstream by energy-savings.js's
  // own identity fallback; the RATES-sourced qty still self-verifies — must
  // self-heal the field regardless of the kWhConsumed hold state.
  {
    const lms30 = {
      OnPeakKWh: '32844.8550', // already clobbered upstream
      OffPeakKWh: '37381.5450',
      EnergyOnPeakCharge: '197.11',
      EnergyOffPeakCharge: '1322.56',
      _rates: {
        EnergyOnPeakCharge: { rate: 0.04146, parts: [{ qty: 4754.295 }] },
        EnergyOffPeakCharge: { rate: 0.03538, parts: [{ qty: 37381.545 }] },
      },
    };
    const d = X.decideOnOffPeakKWh(lms30, pf, 70226.4, true); // kwhHeld=true
    assertTrue(
      !!d.onCorrection,
      'decideOnOff: LMS bill 30 shape — self-heals corrupted OnPeak field even when kWhConsumed is held',
    );
    assertEqual(
      d.onCorrection.value,
      4754.295,
      'decideOnOff: LMS bill 30 shape — restores the self-verified charge-line qty',
    );
  }
  // Neither leg verifies and kWhConsumed is held — refuse, don't guess.
  {
    const ambiguous = {
      OnPeakKWh: '100',
      OffPeakKWh: '200',
      EnergyOnPeakCharge: '1',
      EnergyOffPeakCharge: '1',
      _rates: {
        EnergyOnPeakCharge: { rate: 0.5, parts: [{ qty: 100 }] }, // 100*0.5=50 != 1, doesn't verify
        EnergyOffPeakCharge: { rate: 0.5, parts: [{ qty: 200 }] }, // same
      },
    };
    const d = X.decideOnOffPeakKWh(ambiguous, pf, 1000, true);
    assertTrue(
      !d.onCorrection && !d.offCorrection && !!d.gate,
      'decideOnOff: neither leg verifies + total held — gate, never guess',
    );
  }
  // ── FIRST-TIER-RATE TRAP (changeover bill) ──────────────────────────────
  // On-Peak charge line spans TWO seasonal rate tiers (a "changeover" bill —
  // On-Peak + Tiered both present, see energy-savings.js ~3178-3188). Its
  // qty (250 = 150 + 100) is CORRECT and its printed charge ($13.50 = 150 ×
  // $0.05 + 100 × $0.06) IS backed by the charge line — but the top-level
  // `.rate` field is only the FIRST tier's rate ($0.05, per `allParts[0].rate`).
  // A naive `qty * r.rate` self-check (250 × 0.05 = $12.50) would NOT match
  // the printed $13.50 and spuriously mark OnPeak unverified even though the
  // quantity is exactly right. kWhConsumed is (deliberately, for this test)
  // corrupted to 760 instead of the true 750 (250 + 500), so the "already
  // consistent" early-return does not mask the bug: with the old
  // `qty * r.rate` check, OnPeak would spuriously fail to verify while
  // OffPeak (single-tier, unaffected) verifies, and the code would derive
  // OnPeakKWh = 760 − 500 = 260 by subtraction — silently overwriting the
  // already-correct 250 with a wrong value derived from the corrupted total.
  // The fix must verify OnPeak correctly (per-part computed sum vs printed
  // charge) so BOTH legs verify individually, and — since they verify but
  // don't sum to the (corrupted) kWhConsumed — GATE for manual review
  // instead of guessing.
  {
    const changeover = {
      OnPeakKWh: '250', // already correct — must NOT be "corrected"
      OffPeakKWh: '500', // already correct — must NOT be "corrected"
      EnergyOnPeakCharge: '13.50', // 150×$0.05 + 100×$0.06, NOT 250×$0.05 (=$12.50)
      EnergyOffPeakCharge: '20.00', // 500×$0.04
      _rates: {
        EnergyOnPeakCharge: {
          rate: 0.05, // first tier's rate only, per allParts[0].rate — the trap
          parts: [
            { qty: 150, rate: 0.05, computed: 7.5 },
            { qty: 100, rate: 0.06, computed: 6.0 },
          ],
        },
        EnergyOffPeakCharge: { rate: 0.04, parts: [{ qty: 500, rate: 0.04, computed: 20.0 }] },
      },
    };
    const d = X.decideOnOffPeakKWh(changeover, pf, 760, false); // kWhConsumed deliberately wrong (should be 750)
    assertTrue(
      !d.onCorrection,
      'decideOnOff: changeover trap — correct multi-tier OnPeak qty must NOT be overwritten by subtraction',
    );
    assertTrue(
      !d.offCorrection,
      'decideOnOff: changeover trap — correct OffPeak qty must NOT be overwritten either',
    );
    assertTrue(
      !!d.gate,
      'decideOnOff: changeover trap — both legs self-verify but disagree with the (corrupted) total — gate, don\'t guess',
    );
  }

  // ── ACCEPTANCE TEST: Matt's real 4-bill Louisburg April 2026 extraction ──
  const DEBUG_FILE = path.join(
    'C:\\Users\\Matt Miller\\Downloads',
    'ocr-debug_April 2026 Electric bills - BES_ MB_ Field House_20260714_113332.txt',
  );
  if (fs.existsSync(DEBUG_FILE)) {
    const debugText = fs.readFileSync(DEBUG_FILE, 'utf8');
    const marker = '=== RAW OCR TEXT ===';
    const idx = debugText.indexOf(marker);
    const rawText = debugText.slice(idx + marker.length).trim();
    const rule = X.UTILITY_RULES.find((r) => r.name === 'Evergy');
    let bills = rule.extractAll.call(rule, rawText);
    if (!Array.isArray(bills)) bills = [bills];
    const v = await X.postExtractionVerify(bills, 'Evergy', rawText);
    bills = v.bills;
    await X.analyzeBillExtraction(bills, 'Evergy', v.historicalCache || {});

    const byAcct = Object.fromEntries(bills.map((b) => [b.AccountNumber, b]));
    // Bill 1 — Maint Bldg (958.4676) — must be unaffected by this fix.
    assertEqual(pf(byAcct['0669287870'].kWhConsumed), 958.4676, 'ACCEPTANCE bill1: kWhConsumed unchanged');
    assertEqual(pf(byAcct['0669287870'].TotalCurrentCharges), 318.97, 'ACCEPTANCE bill1: dollar total unchanged');
    // Bill 2 — the cross-corrupted On/Off-Peak bill.
    assertEqual(pf(byAcct['2129690146'].kWhConsumed), 2282.5018, 'ACCEPTANCE bill2: kWhConsumed corroborated');
    assertEqual(pf(byAcct['2129690146'].OnPeakKWh), 349.6962, 'ACCEPTANCE bill2: OnPeakKWh correct');
    assertEqual(pf(byAcct['2129690146'].OffPeakKWh), 1932.8056, 'ACCEPTANCE bill2: OffPeakKWh correct (was 1912.7998)');
    assertEqual(pf(byAcct['2129690146'].TotalCurrentCharges), 561.57, 'ACCEPTANCE bill2: dollar total unchanged');
    // Bill 3 — Louis Elementary (49636.144) — must be unaffected by this fix.
    assertEqual(pf(byAcct['6699289683'].kWhConsumed), 49636.144, 'ACCEPTANCE bill3: kWhConsumed unchanged');
    assertEqual(pf(byAcct['6699289683'].TotalCurrentCharges), 5718.13, 'ACCEPTANCE bill3: dollar total unchanged');
    // Bill 4 — the primary repro (kWhConsumed silently overwritten 1053.84 -> 973.04).
    assertEqual(
      pf(byAcct['8980291458'].kWhConsumed),
      1053.84,
      'ACCEPTANCE bill4: kWhConsumed NOT overwritten to 973.04',
    );
    assertEqual(pf(byAcct['8980291458'].OnPeakKWh), 251.4974, 'ACCEPTANCE bill4: OnPeakKWh unchanged');
    assertEqual(pf(byAcct['8980291458'].OffPeakKWh), 802.3379, 'ACCEPTANCE bill4: OffPeakKWh unchanged');
    assertEqual(pf(byAcct['8980291458'].TotalCurrentCharges), 414.17, 'ACCEPTANCE bill4: dollar total unchanged');
  } else {
    console.log('ACCEPTANCE TEST SKIPPED — debug file not present on this machine: ' + DEBUG_FILE);
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
