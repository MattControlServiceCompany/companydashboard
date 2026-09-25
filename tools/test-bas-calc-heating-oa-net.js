// tools/test-bas-calc-heating-oa-net.js — BAS Savings Calc heating outside-air double-count fix,
// regression gate.
// Run: node tools/test-bas-calc-heating-oa-net.js
//
// Background: the heating combine step in openBASCalc's _bcDoCalc (app/calculators.js) used to
// add the calibrated setback load and the raw outside-air (ventilation) load straight together
// (setback*heatAdj + OA), which double-counts the ventilation load already implicit in the
// setback figure. The 2026-09-22 Excel parity dump documents Excel's own netting instead
// (Existing!D168, 2026-09-22-bas-calc-excel-parity/2026-09-22-excel-dump.txt line 152):
//   D168 = MAX(IF($A168<55,0,Temperature!E140*VLOOKUP($A168,$K$7:$P$16,4)) - D641/12, 0)
// i.e. MAX(setback_load - OA_load, 0) — "prevents double counting" per the parity audit. The
// 2026-09-24 night-run handoff (item 5) and 2026-09-25 cold review's fix spec both give the exact
// JS form to ship: Math.max(setback*heatAdj - OA, 0) + OA, for both Existing and New, every heat
// source. Cooling is explicitly NOT touched (Excel has no such clamp there).
//
// This gate proves, WITHOUT a browser:
//   1. The buggy straight-sum pattern (`* heatAdj + ...HeatKwhOAM[m]` etc. with no Math.max) is
//      gone from all four heating combine lines (Existing/New x kWh-bucket/gas-bucket).
//   2. The Excel-matching Math.max(...) netting pattern is present on all four.
//   3. Cooling's combine lines are UNCHANGED (still a straight sum) — this fix is heating-only.
//   4. The netting formula itself, run standalone against Woodland Spring Middle's real
//      Existing/New heating figures (2026-09-25 cold review, "Setback (setpoint+schedule)" /
//      "Outside Air (ventilation reheat)" rows — both already calibrated kWh/Therms-equivalent
//      monthly-summed totals), reproduces the MAX(setback, OA) parity Excel's D168 clamp implies,
//      and is NOT the old double-counting sum.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL: ' + msg);
  }
}

const src = fs.readFileSync(path.join(REPO, 'app', 'calculators.js'), 'utf8');

console.log('--- 1/2. Heating combine lines: buggy sum gone, Excel-netting present ---');
{
  const buggyHeatingPatterns = [
    /exHeatKwhSetbackM\.map\(\(v, m\) => v \* heatAdj \+ exHeatKwhOAM\[m\]\)/,
    /newHeatKwhSetbackM\.map\(\(v, m\) => v \* heatAdj \+ newHeatKwhOAM\[m\]\)/,
    /exHeatGasSetbackM\.map\(\(v, m\) => v \* heatAdj \+ exHeatGasOAM\[m\]\)/,
    /newHeatGasSetbackM\.map\(\(v, m\) => v \* heatAdj \+ newHeatGasOAM\[m\]\)/,
  ];
  for (const re of buggyHeatingPatterns) {
    assert(!re.test(src), 'old double-counting straight-sum pattern must be gone: ' + re);
  }

  const nettedHeatingPatterns = [
    /exHeatKwhSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - exHeatKwhOAM\[m\], 0\) \+ exHeatKwhOAM\[m\]\)/,
    /newHeatKwhSetbackM\.map\(\s*\(v, m\) => Math\.max\(v \* heatAdj - newHeatKwhOAM\[m\], 0\) \+ newHeatKwhOAM\[m\],?\s*\)/,
    /exHeatGasSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - exHeatGasOAM\[m\], 0\) \+ exHeatGasOAM\[m\]\)/,
    /newHeatGasSetbackM\.map\(\s*\(v, m\) => Math\.max\(v \* heatAdj - newHeatGasOAM\[m\], 0\) \+ newHeatGasOAM\[m\],?\s*\)/,
  ];
  for (const re of nettedHeatingPatterns) {
    assert(re.test(src), 'Excel D168-matching MAX(setback-OA,0)+OA netting must be present: ' + re);
  }
}

console.log('--- 3. Cooling combine lines: unchanged (still a straight sum, no clamp) ---');
{
  assert(
    /exCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ exCoolOAM\[m\]\)/.test(src),
    'Existing cooling combine must stay a straight sum (cooling is out of scope for this fix)',
  );
  assert(
    /newCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ newCoolOAM\[m\]\)/.test(src),
    'New cooling combine must stay a straight sum (cooling is out of scope for this fix)',
  );
  // Peak cooling tracking (same additive cooling model) also untouched.
  assert(
    /exPeakCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ exPeakCoolOAM\[m\]\)/.test(src),
    'Existing peak-cooling combine must stay a straight sum',
  );
}

console.log('--- 4. Netting formula vs. Excel D168 parity, Woodland Spring Middle real figures ---');
{
  // Standalone re-implementation of the exact formula shipped in app/calculators.js
  // (Math.max(setback*heatAdj - OA, 0) + OA) — kept in lockstep with the source patterns
  // asserted above, so this test would fail loudly if the two ever diverged.
  const netHeat = (setbackCalibrated, oa) => Math.max(setbackCalibrated - oa, 0) + oa;
  const oldBuggySum = (setbackCalibrated, oa) => setbackCalibrated + oa;

  // 2026-09-25 cold review, Woodland Spring Middle, Heating Gas (Therms) — already
  // calibrated (setback*heatAdj) / raw OA, annual totals from the "term-by-term" table:
  const existing = { setback: 1478.4, oa: 15907.6 }; // old total 17,386.0 = 1478.4 + 15907.6
  const proposed = { setback: 1114.8, oa: 5105.4 }; // old total 6,220.2 = 1114.8 + 5105.4

  assert(
    Math.abs(existing.setback + existing.oa - 17386.0) < 0.05,
    'sanity: existing setback+OA must reproduce the reviewed old (buggy) existing total 17,386.0',
  );
  assert(
    Math.abs(proposed.setback + proposed.oa - 6220.2) < 0.05,
    'sanity: proposed setback+OA must reproduce the reviewed old (buggy) proposed total 6,220.2',
  );

  const newExistingTotal = netHeat(existing.setback, existing.oa);
  const newProposedTotal = netHeat(proposed.setback, proposed.oa);

  // Excel!D168's MAX(setback - OA, 0) drives the netted setback to 0 whenever OA already exceeds
  // the setback on its own (true for both Woodland buckets here — ventilation reheat dwarfs the
  // setpoint/schedule load) — netHeat then collapses to just the OA figure. This is the Excel
  // parity property under test, not an assumption: MAX(setback-OA,0)+OA === MAX(setback, OA).
  assert(
    Math.abs(newExistingTotal - Math.max(existing.setback, existing.oa)) < 1e-9,
    'netted existing total must equal MAX(setback, OA) — the algebraic form of MAX(setback-OA,0)+OA',
  );
  assert(
    Math.abs(newProposedTotal - Math.max(proposed.setback, proposed.oa)) < 1e-9,
    'netted proposed total must equal MAX(setback, OA)',
  );
  assert(
    Math.abs(newExistingTotal - 15907.6) < 0.05,
    'Existing Heating Gas total, netted, must equal 15,907.6 Therms (the OA figure — setback is floored out)',
  );
  assert(Math.abs(newProposedTotal - 5105.4) < 0.05, 'Proposed Heating Gas total, netted, must equal 5,105.4 Therms');

  const oldSavings = oldBuggySum(existing.setback, existing.oa) - oldBuggySum(proposed.setback, proposed.oa);
  const newSavings = newExistingTotal - newProposedTotal;
  assert(Math.abs(oldSavings - 11165.8) < 0.05, 'old (buggy, double-counted) savings must reproduce 11,165.8 Therms');
  assert(
    Math.abs(newSavings - 10802.2) < 0.05,
    'new (netted, Excel-matching) Woodland Heating Gas Savings must be 10,802.2 Therms',
  );
  assert(newSavings !== oldSavings, 'the fix must actually change the Woodland heating savings number');
  assert(newSavings < oldSavings, 'netting removes double-counted savings, so the new figure must be lower');

  console.log(
    `  Woodland Heating Gas Savings — old (buggy, double-counted): ${oldSavings.toFixed(1)} Therms; new (netted, Excel D168-matching): ${newSavings.toFixed(1)} Therms`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
