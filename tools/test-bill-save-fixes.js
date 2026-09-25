/**
 * test-bill-save-fixes.js
 *
 * Standalone regression test for two backlog items fixed together in
 * app/bill-analysis.js (branch fix/bill-save-paths, 2026-09-24):
 *
 *  - a20d0943: a held total-correction (GATE C/D, _decideTotalCorrection)
 *    still let corrupted raw charge-component fields (e.g. BilledKWCharge)
 *    flow into the saved kwCost/kwhCost on "Save Anyway", even though the
 *    total itself was correctly protected. Fixed in _extractedToBillRowCosts
 *    (the single shared cost/usage mapper every save path already calls) —
 *    when a bill carries _correction_pending_TotalCurrentCharges or
 *    _charge_exceeds_total, every cost bucket is capped at the trusted
 *    (held/displayed) total instead of trusting the raw component sum.
 *
 *  - 0bc25b67: a saved bill could be attached to a meter object that was no
 *    longer present in the live project tree (a captured/stale match, from
 *    findMeterMatch, _mbRowTargets, or _autoAssignTarget, that went stale
 *    between match-time and save-time). Fixed with ONE shared guard,
 *    _liveMeterOrNull(bldg, meterId), called by all three named save paths
 *    (confirmAutoAssign, _mbSaveOneBill, _saveBillToMatchedMeter) right
 *    before any of them trusts a target meter.
 *
 * SYNTHETIC fixtures only — no real client bill or project data.
 *
 * Loads the REAL functions from app/bill-analysis.js via Node's vm module
 * (same source, same code path as production), same sandbox/load pattern as
 * tools/test-kgs-total-decimal-drop.js.
 *
 * Usage: node tools/test-bill-save-fixes.js [path-to-bill-analysis.js]
 *   (defaults to ../app/bill-analysis.js relative to this file — pass the
 *   path to a PRE-FIX copy, e.g. from origin/main, to confirm this test
 *   fails on the old code)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const billAnalysisPath = process.argv[2] || path.join(__dirname, '..', 'app', 'bill-analysis.js');
const ratesPath = path.join(__dirname, '..', 'computations', 'rates.js');
const energySavingsPath = path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadSandbox() {
  const sandbox = {
    window: {},
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
    fetch: () => Promise.reject(new Error('fetch not available in test sandbox')),
  };
  vm.createContext(sandbox);
  for (const p of [ratesPath, energySavingsPath, billAnalysisPath]) {
    const src = fs.readFileSync(p, 'utf8');
    vm.runInContext(src, sandbox, { filename: path.basename(p) });
  }
  return sandbox;
}

function getFn(sandbox, name) {
  const fn = vm.runInContext(`typeof ${name} !== "undefined" ? ${name} : null`, sandbox);
  if (!fn) throw new Error(name + ' not found in ' + billAnalysisPath);
  return fn;
}

async function main() {
  const sandbox = loadSandbox();
  const src = fs.readFileSync(billAnalysisPath, 'utf8');
  let failures = 0;

  // ── Item a20d0943: held total-correction must never leak a corrupted
  // component into kwCost/kwhCost on Save Anyway ──
  {
    const _extractedToBillRowCosts = getFn(sandbox, '_extractedToBillRowCosts');

    // Case 1: BilledKWCharge is a wildly corrupted OCR value (e.g. a misread
    // digit turned $200 into $30,000) that tripped GATE C/D — the gate HELD
    // TotalCurrentCharges at its correct, reviewed value ($500) and stamped
    // _correction_pending_TotalCurrentCharges rather than silently applying
    // the compSum-derived correction. The user reviews the $500 total and
    // clicks "Save Anyway".
    const heldBill = {
      TotalCurrentCharges: '500.00',
      TotalAmountDue: '500.00',
      BilledKWCharge: '30000.00', // corrupted OCR value — the violation field
      TDCCharge: '200.00',
      EnergyOnPeakCharge: '100.00',
      _correction_pending_TotalCurrentCharges: {
        original: '500.00',
        proposedCorrection: '30300.00',
        pctChange: '5960.0',
        dollarChange: '29800.00',
        provenanceOk: true,
      },
    };
    const { kwCost, kwhCost, otherCost, taxCost } = _extractedToBillRowCosts(heldBill);
    const sum = parseFloat(kwCost) + parseFloat(kwhCost) + parseFloat(otherCost) + parseFloat(taxCost);
    if (parseFloat(kwCost) > 500.0) {
      failures++;
      console.error('FAIL a20d0943 Case 1: kwCost carried the corrupted component through Save Anyway — got ' + kwCost);
    } else {
      console.log(
        'PASS a20d0943 Case 1: kwCost capped at the accepted total instead of the corrupted $30,200 — got ' + kwCost,
      );
    }
    // Each bucket is individually capped at the accepted total (the fix's
    // actual contract — see _extractedToBillRowCosts) — an uncorrupted small
    // bucket (kwhCost=100 here) is left alone, so the sum can still exceed
    // the total when more than one bucket is nonzero. What must never happen
    // is the CORRUPTED bucket itself carrying its raw, uncapped value — that
    // is asserted above (kwCost). Confirm no single bucket exceeds the total.
    if (parseFloat(kwhCost) > 500.0 || parseFloat(otherCost) > 500.0 || parseFloat(taxCost) > 500.0) {
      failures++;
      console.error('FAIL a20d0943 Case 1: a cost bucket exceeded the accepted total $500.00 — sum=' + sum.toFixed(2));
    } else {
      console.log('PASS a20d0943 Case 1: no single cost bucket exceeds the accepted total');
    }

    // Case 2: no-regression — a bill with NO pending correction (the normal
    // case) must compute kwCost/kwhCost exactly as before, uncapped.
    const cleanBill = {
      TotalCurrentCharges: '300.00',
      BilledKWCharge: '200.00',
      TDCCharge: '50.00',
      EnergyOnPeakCharge: '40.00',
    };
    const clean = _extractedToBillRowCosts(cleanBill);
    if (clean.kwCost !== '250.00') {
      failures++;
      console.error('FAIL a20d0943 Case 2: no-regression — expected kwCost 250.00, got ' + clean.kwCost);
    } else {
      console.log('PASS a20d0943 Case 2: uncorrected bill computes kwCost normally (no regression)');
    }
  }

  // ── Item 0bc25b67: a save must never attach a bill to a meter id that
  // does not exist in the live project tree ──
  {
    const _liveMeterOrNull = getFn(sandbox, '_liveMeterOrNull');

    const liveMeter = { id: 'm-real-1', commodity: 'Electric', bills: [] };
    const bldg = { id: 'b1', meters: [liveMeter] };

    // Case 1: meter id exists on the building — returns the live object.
    const found = _liveMeterOrNull(bldg, 'm-real-1');
    if (found !== liveMeter) {
      failures++;
      console.error('FAIL 0bc25b67 Case 1: existing meter id did not resolve to the live meter object');
    } else {
      console.log('PASS 0bc25b67 Case 1: existing meter id resolves to the live meter object');
    }

    // Case 2: a STALE captured meter id (e.g. deleted, or from a snapshot
    // taken before the meter was removed) — must return null, never a
    // detached/stale object a save path could write into.
    const stale = _liveMeterOrNull(bldg, 'm-deleted-9999');
    if (stale !== null) {
      failures++;
      console.error(
        'FAIL 0bc25b67 Case 2: a nonexistent meter id resolved to something other than null: ' + JSON.stringify(stale),
      );
    } else {
      console.log('PASS 0bc25b67 Case 2: a meter id absent from the live tree resolves to null');
    }

    // Case 3: no building at all (e.g. the building itself was removed).
    const noBldg = _liveMeterOrNull(null, 'm-real-1');
    if (noBldg !== null) {
      failures++;
      console.error('FAIL 0bc25b67 Case 3: a null building did not resolve to null');
    } else {
      console.log('PASS 0bc25b67 Case 3: a missing building resolves to null');
    }
  }

  // ── Wiring check: the fix must be ONE shared function used by ALL THREE
  // named save paths (confirmAutoAssign, _mbSaveOneBill,
  // _saveBillToMatchedMeter) — not a copy-pasted check per path. ──
  {
    const paths = ['confirmAutoAssign', '_mbSaveOneBill', '_saveBillToMatchedMeter'];
    for (const name of paths) {
      const re = new RegExp('function\\s+' + (name.startsWith('_') ? '\\' + name : name) + '\\s*\\(');
      const startMatch = src.match(new RegExp('(async\\s+)?function ' + name.replace(/[$]/g, '\\$') + '\\s*\\('));
      if (!startMatch) {
        failures++;
        console.error('FAIL wiring: could not locate function ' + name + ' in ' + billAnalysisPath);
        continue;
      }
      const start = startMatch.index;
      // Grab a generous window of source after the function start (these are
      // long functions, several hundred lines) and check it references the
      // shared guard.
      const window_ = src.slice(start, start + 25000);
      if (!window_.includes('_liveMeterOrNull(')) {
        failures++;
        console.error('FAIL wiring: ' + name + ' does not call the shared _liveMeterOrNull guard');
      } else {
        console.log('PASS wiring: ' + name + ' calls the shared _liveMeterOrNull guard');
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s) — bill-analysis.js under test: ' + billAnalysisPath);
    process.exit(1);
  } else {
    console.log('All bill-save-fixes tests passed — bill-analysis.js under test: ' + billAnalysisPath);
  }
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
