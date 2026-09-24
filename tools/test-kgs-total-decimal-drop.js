/**
 * test-kgs-total-decimal-drop.js
 *
 * Standalone regression test for backlog ddbc038f — Kansas Gas Service
 * minimum-charge gas bills where "Total Current Charges" OCR's with its
 * decimal point dropped (e.g. printed "$34.64" -> "3464"), inflating the
 * saved cost by 100x. Confirmed real cases (ground-truth reconciliation,
 * AI/_context/ground-truth/2026-09-07-site-vs-ground-truth-reconciliation.md):
 * Baker Student Health Oct 2025 ($3,464.00 site vs $34.64 GT) and Markham
 * Apartments #202 (two occurrences).
 *
 * SYNTHETIC fixture only (no real client bill data) — a fabricated bill
 * object shaped exactly like the Kansas Gas Service extractor's return value
 * (app/energy-savings.js ~line 8499-8543), reproducing the same 100x
 * decimal-drop signature: TotalCurrentCharges is exactly 100x the sum of
 * this bill's own (correctly-parsed) component charge fields.
 *
 * Loads the REAL _postExtractionVerify() from app/bill-analysis.js via
 * Node's vm module (same source, same code path as production, not a
 * reimplementation), with computations/rates.js and app/energy-savings.js
 * loaded first into the same sandbox — the same script load order used in
 * energy-department.html (rates.js, then energy-savings.js, then
 * bill-analysis.js).
 *
 * Usage: node tools/test-kgs-total-decimal-drop.js [path-to-bill-analysis.js]
 *   (defaults to ../app/bill-analysis.js relative to this file — pass the
 *   path to a PRE-FIX copy to confirm this test fails on the old code)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const billAnalysisPath = process.argv[2] || path.join(__dirname, '..', 'app', 'bill-analysis.js');
const ratesPath = path.join(__dirname, '..', 'computations', 'rates.js');
const energySavingsPath = path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadPostExtractionVerify() {
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
  // Stub for app/utility-data.js's forEachCustomerBuilding — _postExtractionVerify
  // calls it as `forEachCustomerBuilding(typeof projects !== 'undefined' ? projects : [], ...)`.
  // We don't load utility-data.js (pulls in unrelated DB/UI dependencies out of scope
  // for this KGS-specific test); since `projects` is always undefined here, the real
  // implementation's `(projectsList || []).forEach(...)` on an empty array would never
  // invoke the callback either — a no-op stub is behaviorally identical for this test.
  vm.runInContext('function forEachCustomerBuilding(projectsList, fn) {}', sandbox);
  const fn = vm.runInContext('typeof _postExtractionVerify !== "undefined" ? _postExtractionVerify : null', sandbox);
  if (!fn) throw new Error('_postExtractionVerify not found in ' + billAnalysisPath);
  return fn;
}

function makeMinChargeBill(overrides) {
  // Shaped exactly like the KGS extractor's return object
  // (app/energy-savings.js, isKGS path, ~line 8499-8543). Component charges
  // sum to the TRUE $34.64 minimum-charge total; TotalCurrentCharges below
  // carries the OCR decimal-drop bug (100x) unless overridden.
  return Object.assign(
    {
      UtilityCompany: 'Kansas Gas Service',
      Commodity: 'Gas',
      commodity: 'gas',
      _utilityName: 'Kansas Gas Service',
      AccountNumber: '510000123 9999999 00',
      McfBilled: '0.500',
      NaturalGasTherms: '5.00',
      CustomerCharge: '20.35',
      DeliveryCharge: '10.29',
      GasSystemReliability: null,
      WeatherNormalization: null,
      GasCharge: '4.00',
      FranchiseFee: null,
      WinterEventCost: null,
      DelayedPaymentCharge: null,
      FuelAdjustment: null,
      WNAPerMcf: null,
      CostOfGasPerMcf: null,
      TotalCurrentCharges: '3464.00',
      TotalAmountDue: '3464.00',
    },
    overrides,
  );
}

async function main() {
  const _postExtractionVerify = loadPostExtractionVerify();
  let failures = 0;

  // ── Case 1: the confirmed 100x decimal-drop signature ──
  // True total (sum of components) = 20.35 + 10.29 + 4.00 = $34.64.
  // OCR'd TotalCurrentCharges = "3464.00" (decimal dropped) = exactly 100x.
  {
    const bills = [makeMinChargeBill({})];
    const { bills: out } = await _postExtractionVerify(bills, 'Kansas Gas Service', '');
    const b = out[0];
    const total = parseFloat(String(b.TotalCurrentCharges).replace(/,/g, ''));
    const due = parseFloat(String(b.TotalAmountDue).replace(/,/g, ''));
    if (Math.abs(total - 34.64) > 0.01) {
      failures++;
      console.error('FAIL Case 1: TotalCurrentCharges not corrected — expected 34.64, got ' + b.TotalCurrentCharges);
    } else {
      console.log('PASS Case 1: TotalCurrentCharges corrected 3464.00 -> ' + b.TotalCurrentCharges);
    }
    if (Math.abs(due - 34.64) > 0.01) {
      failures++;
      console.error('FAIL Case 1: TotalAmountDue not corrected — expected 34.64, got ' + b.TotalAmountDue);
    } else {
      console.log('PASS Case 1: TotalAmountDue corrected 3464.00 -> ' + b.TotalAmountDue);
    }
    if (!b._auto_corrected_TotalCurrentCharges) {
      failures++;
      console.error('FAIL Case 1: no _auto_corrected_TotalCurrentCharges diagnostic recorded');
    } else {
      console.log('PASS Case 1: diagnostic flag recorded');
    }
  }

  // ── Case 2: no-regression — a bill whose TotalCurrentCharges already
  // reconciles with its component sum must NOT be mutated. ──
  {
    const bills = [makeMinChargeBill({ TotalCurrentCharges: '34.64', TotalAmountDue: '34.64' })];
    const { bills: out } = await _postExtractionVerify(bills, 'Kansas Gas Service', '');
    const b = out[0];
    if (b.TotalCurrentCharges !== '34.64' || b._auto_corrected_TotalCurrentCharges) {
      failures++;
      console.error(
        'FAIL Case 2: an already-correct bill was mutated — TotalCurrentCharges=' +
          b.TotalCurrentCharges +
          ', flag=' +
          JSON.stringify(b._auto_corrected_TotalCurrentCharges),
      );
    } else {
      console.log('PASS Case 2: already-correct bill left untouched (no regression)');
    }
  }

  // ── Case 3: a genuinely large gas bill near the old $5,000 threshold must
  // NOT be divided by 100 just because it's a large round-ish number — only
  // an ACTUAL 100x-of-component-sum match should trigger the correction. ──
  {
    const bills = [
      makeMinChargeBill({
        McfBilled: '55.000',
        NaturalGasTherms: '550.00',
        CustomerCharge: '20.35',
        DeliveryCharge: '210.29',
        GasCharge: '4200.00',
        TotalCurrentCharges: '4430.64',
        TotalAmountDue: '4430.64',
      }),
    ];
    const { bills: out } = await _postExtractionVerify(bills, 'Kansas Gas Service', '');
    const b = out[0];
    if (b.TotalCurrentCharges !== '4430.64' || b._auto_corrected_TotalCurrentCharges) {
      failures++;
      console.error(
        'FAIL Case 3: a genuine large correct total was wrongly mutated — TotalCurrentCharges=' + b.TotalCurrentCharges,
      );
    } else {
      console.log('PASS Case 3: genuine large correct total left untouched (no false positive)');
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(failures + ' failure(s) — bill-analysis.js under test: ' + billAnalysisPath);
    process.exit(1);
  } else {
    console.log('All KGS decimal-drop tests passed — bill-analysis.js under test: ' + billAnalysisPath);
  }
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
