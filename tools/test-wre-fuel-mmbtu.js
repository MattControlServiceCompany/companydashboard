/**
 * test-wre-fuel-mmbtu.js
 *
 * Standalone regression test (no browser required) for the WoodRiver Energy
 * (WRE) "Fuel" column fix (2026-09-24):
 *   1. Fuel MMBtu per site line (Trigger and Index) is shipped as its own
 *      output field (_wreTriggerFuelMMbtu / _wreIndexFuelMMbtu) — the
 *      2026-09-23 fix captured these internally (blk.triggerFuelMMbtu /
 *      blk.indexFuelMMbtu, used only by the rate cross-check) but never put
 *      them on the record the review panel reads.
 *   2. Usage (NaturalGasMMbtu) stays the billed MMbtu only — Fuel is a
 *      separate billed quantity and must never be added into it. Verified
 *      against the real WRE invoice layout: the printed Sub-Total and Total
 *      Natural Gas lines both print Mmbtu and Fuel as two separate columns
 *      and never sum them (see tools/test-wre-fuel-mmbtu.js SYNTHETIC_TEXT
 *      below, modeled on that layout with fake data).
 *   3. The rate cross-check (which decides _mmbtuRateMismatch/_manualReview)
 *      uses (MMbtu + Fuel) x Rate = Charge, WRE's own printed formula — a
 *      site whose charge only reconciles with Fuel folded in must NOT be
 *      flagged for manual review.
 *
 * Uses Node's vm module to load the REAL UTILITY_RULES array from
 * app/energy-savings.js (same source/code path as production, not a
 * reimplementation) — same harness pattern as
 * tools/test-wre-parser-regression.js.
 *
 * SYNTHETIC_TEXT below is entirely fabricated: fake customer/district name,
 * fake addresses, fake account/meter numbers, a fake far-future production
 * month, and round MMbtu/Fuel/Rate figures chosen so (MMbtu+Fuel) x Rate
 * multiplies out to the printed charge EXACTLY (no OCR-tolerance rounding
 * ambiguity). No real client data. Committed to git (not tools/fixtures/,
 * which is gitignored for real-bill-OCR-text only).
 *
 * Usage: node tools/test-wre-fuel-mmbtu.js [path-to-energy-savings.js]
 *   (defaults to ../app/energy-savings.js relative to this file)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const jsPath = process.argv[2] || path.join(__dirname, '..', 'app', 'energy-savings.js');

function loadWRE(scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = { window: {}, console: { log: () => {}, warn: () => {}, error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(scriptPath) });
  const rules = vm.runInContext('typeof UTILITY_RULES !== "undefined" ? UTILITY_RULES : null', sandbox);
  if (!rules) throw new Error('UTILITY_RULES not found in ' + scriptPath);
  const wre = rules.find((r) => r.name === 'Wood River Energy');
  if (!wre) throw new Error('Wood River Energy parser not found in ' + scriptPath);
  return wre;
}

// ── SYNTHETIC WRE invoice text — fully fabricated, modeled on the real
// WoodRiver Energy layout (Item/Mmbtu/Fuel/Rate/$ per-site lines, Sub-Total
// per site, Total Natural Gas summary). Site 1 has BOTH a Trigger and an
// Index component (exercises both Fuel-capture regexes plus the
// two-component Sub-Total cross-check); Site 2 has Index only (the common
// single-component case, matching the review-panel bug this fix closes).
const SYNTHETIC_TEXT = `
WoodRiver Energy
Natural Gas Invoice
Customer #: 900000
Fake School District 999                                                          Invoice #: 900001
Attn: Fake Contact                                                                Production Month: January 2099
100 Fake Pkwy                                                          Acct Rep: Fake Rep
Faketown, KS 00000                                                                Bill Date: 01/01/2099
Pmt Due Date: 01/16/2099
Item Mmbtu Fuel Rate $
Service Address: Test Elementary - 100 Test St                                   Acct/Meter: 900101/M000001A
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Trigger - Fixed   10.00   0.15   $5.0000   $50.75
Index (FOM)   20.00   0.30   $5.0000   $101.50
Sub-Total:   30.00   0.45   $152.25
Service Address: Test Middle - 200 Test Ave                                      Acct/Meter: 900102/M000002B
Faketown, KS 00000                                                      Pipeline: SoStar MKT
Utility: Atmos
Index (FOM)   8.20   0.13   $5.0000   $41.65
Sub-Total:   8.20   0.13   $41.65
Mmbtu Fuel $
Total Natural Gas: 38.20 0.58 $193.90
Total Fees: $0.00
Total Tax: $0.00
Total Current Charges: $193.90
`;

function approxEq(a, b, tol) {
  return a != null && b != null && Math.abs(parseFloat(a) - parseFloat(b)) < (tol == null ? 0.005 : tol);
}

let fail = 0;
let pass = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

const wre = loadWRE(jsPath);
console.log('Loaded WRE parser from: ' + jsPath + '\n');

const results = wre.extractAll(SYNTHETIC_TEXT);
console.log('Sites extracted: ' + results.length);

check('extracts exactly 2 sites', results.length === 2, 'got ' + results.length);

if (results.length === 2) {
  const [site1, site2] = results;

  // ── Requirement 1: Fuel MMBtu shipped as its own output field ──
  check(
    'site 1 _wreTriggerFuelMMbtu === 0.15',
    approxEq(site1._wreTriggerFuelMMbtu, 0.15),
    'actual: ' + site1._wreTriggerFuelMMbtu,
  );
  check(
    'site 1 _wreIndexFuelMMbtu === 0.30',
    approxEq(site1._wreIndexFuelMMbtu, 0.3),
    'actual: ' + site1._wreIndexFuelMMbtu,
  );
  check(
    'site 2 _wreIndexFuelMMbtu === 0.13',
    approxEq(site2._wreIndexFuelMMbtu, 0.13),
    'actual: ' + site2._wreIndexFuelMMbtu,
  );

  // ── Requirement 3: usage stays billed MMbtu, Fuel never folded in ──
  check(
    'site 1 NaturalGasMMbtu === 30 (Trigger 10.00 + Index 20.00, excludes Fuel 0.45)',
    approxEq(site1.NaturalGasMMbtu, 30),
    'actual: ' + site1.NaturalGasMMbtu,
  );
  check(
    'site 2 NaturalGasMMbtu === 8.20 (excludes Fuel 0.13)',
    approxEq(site2.NaturalGasMMbtu, 8.2),
    'actual: ' + site2.NaturalGasMMbtu,
  );

  // ── Requirement 2: rate cross-check uses (MMbtu+Fuel) x Rate — a site
  // whose charge only reconciles with Fuel folded in must not be flagged.
  check('site 1 not flagged for manual review', !site1._manualReview, 'actual: ' + site1._manualReview);
  check('site 1 no rate mismatch', !site1._mmbtuRateMismatch, 'actual: ' + site1._mmbtuRateMismatch);
  check('site 2 not flagged for manual review', !site2._manualReview, 'actual: ' + site2._manualReview);
  check('site 2 no rate mismatch', !site2._mmbtuRateMismatch, 'actual: ' + site2._mmbtuRateMismatch);

  // Charges themselves must still be exactly as printed (untouched by this fix).
  check('site 1 GasCharge === 152.25', approxEq(site1.GasCharge, 152.25), 'actual: ' + site1.GasCharge);
  check('site 2 GasCharge === 41.65', approxEq(site2.GasCharge, 41.65), 'actual: ' + site2.GasCharge);
}

console.log('\n' + '='.repeat(50));
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
