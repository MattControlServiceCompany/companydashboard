/**
 * test-rkva-rate-reconciliation.js
 *
 * Standalone regression test for backlog ade32899 — the Evergy RkVA charge
 * cross-check detects an OCR digit-misread rate (rate x qty does not
 * reconcile with the printed charge) but never corrects the stored rate,
 * so the wrong per-unit rate keeps feeding downstream savings math even
 * though the printed dollar charge is preserved correctly.
 *
 * Real-world signature (Louisburg Rockville bill, backlog ade32899):
 *   printed line: "RkVA Chg 17.7840 kW at $0.663 per kW ... $11.79"
 *   OCR misread the rate 6 -> 8: stored RkVARate = 0.883
 *   The pipeline's own reconciliation flagged it:
 *     _part_mismatches_RkVACharge {qty:17.784, rate:0.883, computed:15.70,
 *       ocrCharge:11.79, diff:3.91, valid:false}
 *   ...but RkVARate stayed 0.883 forever because:
 *     1. The SINGLE-PART RATE AUTO-CORRECTION gate compared the rate
 *        mismatch to a percentage of the DOLLAR CHARGE instead of a
 *        percentage of the RATE itself (a unit mismatch), so a mismatch
 *        this size on an $11.79 charge computed to ~1.9% and never
 *        crossed the 5% gate.
 *     2. Even when the gate does fire, it only ever mutated
 *        result._rates.RkVACharge — the top-level result.RkVARate field
 *        (what saved bills and TotalKWRate actually read) was already
 *        snapshotted from the pre-correction value earlier in the same
 *        function and was never updated.
 *
 * SYNTHETIC fixture only — a fabricated single-bill Evergy text block
 * using the same structural markers the real _extractEvergy parser keys
 * off ("Billing Details - service from" header, a "RkVA Chg <qty> kW at
 * $<rate> per kW ... $<charge>" line) with fake dollar amounts. No real
 * client identifiers or bill data.
 *
 * Loads the REAL _extractEvergy() function from app/energy-savings.js via
 * Node's vm module (same source, same code path as production, not a
 * reimplementation).
 *
 * Usage: node tools/test-rkva-rate-reconciliation.js [path-to-energy-savings.js]
 *   (defaults to ../app/energy-savings.js relative to this file — pass the
 *   path to a PRE-FIX copy to confirm this test fails on the old code)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadExtractEvergy(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  const fn = vm.runInContext('typeof _extractEvergy !== "undefined" ? _extractEvergy : null', sandbox);
  if (!fn) throw new Error('_extractEvergy not found in ' + scriptPath);
  return fn;
}

// Builds a synthetic single-bill Evergy text block. `rkvaRate` is the (possibly
// OCR-misread) per-unit rate printed on the RkVA Chg line; `rkvaCharge` is the
// printed dollar total for that line (independently OCR'd, assumed correct —
// matches the real-world signature where the charge column reads fine but the
// rate column has a single misread digit).
function makeSyntheticBill(rkvaQty, rkvaRate, rkvaCharge) {
  return (
    `Billing Details - service from 07/14/2026 to 08/13/2026\n` +
    `Account Number 9999999999\n` +
    `999 TEST ST, TESTVILLE, KS 66000\n` +
    `Customer Chg $25.00\n` +
    `Facilities Chg 12.0000 kW at $8.500 per kW $102.00\n` +
    `Demand Chg 12.0000 kW at $9.250 per kW $111.00\n` +
    `Energy On Pk Chg 4,000.0000 kWh at $0.06000 per kWh $240.00\n` +
    `TDC Chg 12.0000 kW at $3.100 per kW $37.20\n` +
    `RkVA Chg ${rkvaQty.toFixed(4)} kW at $${rkvaRate.toFixed(3)} per kW $${rkvaCharge.toFixed(2)}\n` +
    `Current Charges $515.20\n`
  );
}

function fmt(v) {
  return v === null || v === undefined ? 'null' : typeof v === 'number' ? v.toFixed(6) : String(v);
}

function runCase(name, extractFn, rkvaQty, rkvaRate, rkvaCharge, expect) {
  const text = makeSyntheticBill(rkvaQty, rkvaRate, rkvaCharge);
  const result = extractFn(text, null, null);
  const got = {
    RkVACharge: result.RkVACharge,
    RkVARate: result.RkVARate,
    partMismatch: !!result._part_mismatches_RkVACharge,
    autoCorrected: result._auto_corrected_rate_RkVACharge || null,
  };
  let pass = true;
  const problems = [];
  for (const [k, v] of Object.entries(expect)) {
    if (k === 'autoCorrected') {
      continue; // checked separately by callers that care (object shape, not a fixed value)
    } else if (k === 'RkVARate') {
      const gotNum = got[k] === null || got[k] === undefined ? null : parseFloat(got[k]);
      if (v === null) {
        if (gotNum !== null) {
          pass = false;
          problems.push(`RkVARate expected null, got ${fmt(gotNum)}`);
        }
      } else if (gotNum === null || Math.abs(gotNum - v) > 0.001) {
        pass = false;
        problems.push(`RkVARate expected ~${fmt(v)}, got ${fmt(gotNum)}`);
      }
    } else if (got[k] !== v) {
      pass = false;
      problems.push(`${k} expected ${fmt(v)}, got ${fmt(got[k])}`);
    }
  }
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass) problems.forEach((p) => console.log('       ' + p));
  console.log('       raw:', JSON.stringify(got));
  return pass;
}

function main() {
  const extractFn = loadExtractEvergy(jsPath);
  let allPass = true;

  // Case 1 — the real ade32899 signature: printed "17.7840 kW at $0.663 per
  // kW ... $11.79", rate OCR-misread 6->8 as $0.883. Charge/qty both known and
  // reconcile with each other (11.79 / 17.784 = 0.663) — the rate should be
  // derived from charge/qty and both _rates AND result.RkVARate corrected.
  allPass =
    runCase(
      'ade32899 signature: RkVA rate OCR digit-misread (0.883 -> 0.663), single-part, derivable',
      extractFn,
      17.784,
      0.883,
      11.79,
      {
        RkVACharge: '11.79',
        RkVARate: 0.663,
        partMismatch: false,
        autoCorrected: null, // presence checked separately below (object, not a fixed value)
      },
    ) && allPass;
  {
    const text = makeSyntheticBill(17.784, 0.883, 11.79);
    const result = extractFn(text, null, null);
    const tag = result._auto_corrected_rate_RkVACharge;
    const ok = tag && Math.abs(tag.ocrRate - 0.883) < 0.001 && Math.abs(tag.derivedRate - 0.663) < 0.001;
    console.log(
      `[${ok ? 'PASS' : 'FAIL'}] ade32899 signature: _auto_corrected_rate_RkVACharge populated with ocrRate/derivedRate`,
    );
    if (!ok) console.log('       raw:', JSON.stringify(tag));
    allPass = ok && allPass;
  }

  // Case 2 — clean bill, rate already correct. Must NOT be touched (no false
  // positives from the fixed threshold).
  allPass =
    runCase('clean bill: RkVA rate already correct — untouched', extractFn, 17.784, 0.663, 11.79, {
      RkVACharge: '11.79',
      RkVARate: 0.663,
      partMismatch: false,
    }) && allPass;

  // Case 3 — small legitimate rounding noise (well under 5%) must NOT trigger
  // a "correction" that overwrites a fine rate with rounding jitter.
  allPass =
    runCase('rounding noise: RkVA rate within 1% — untouched', extractFn, 17.784, 0.665, 11.79, {
      RkVACharge: '11.79',
      RkVARate: 0.665,
      partMismatch: false,
    }) && allPass;

  console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(allPass ? 0 : 1);
}

main();
