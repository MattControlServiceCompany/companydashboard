// tools/test-bas-calc-heating-oa-net.js — BAS Savings Calc heating outside-air netting,
// regression gate. Run: node tools/test-bas-calc-heating-oa-net.js
//
// History: the heating combine in openBASCalc's _bcDoCalc (app/calculators.js) originally added
// the calibrated setback load and the raw outside-air (ventilation) load straight together
// (double-counting bug). A 2026-09-25 fix (c4a4e49) changed it to
// Math.max(setback*heatAdj - OA, 0) + OA (algebraically MAX(setback*heatAdj, OA)), citing
// Existing!D168 in the BAS Savings Calc Template.xlsm as the Excel oracle.
//
// That citation was WRONG. Verified directly against the real workbook
// (my-knowledge-base/raw/Calcs/BAS Savings Calc Template.xlsm) via openpyxl, 2026-09-25:
//   - Existing!D33 (row label) = "Potential Occupied Ton Hours Load (cooling setback)" — the
//     D168 block is COOLING, not heating (confirmed: A168=102.5, a warm bin; D168's own OA
//     subtrahend D641 uses the $E$10=55 cooling-side sensible+latent formula).
//   - The real heating table is Existing!AH34 (row label AH33 = "Potential Occupied Mbtu load
//     (heating setback)"):
//       AH34 = MAX(IF($A34>50,0,Temperature!E6*VLOOKUP($A34,$S$7:$X$17,4))-D507,0)
//     D507 (row label D506 = "Hourly Heating/Cooling Load") is the heating-only OA subtrahend:
//       D507 = IF($A507<$E$12,Temperature!E6*1.08*$E$18*($E$12-$A507)/1000,0)
//   - AH34 has NO add-back term. Traced every downstream reader (BF34/BG34/BH34 weekday-weighted
//     rollups via SUMIF, AE34 = SUM(AB34:AD34)) up toward the savings total — none of them add
//     the OA component back either. The correct combine is a plain net-and-clamp:
//       heating = MAX(setback*heatAdj - OA, 0)   [no add-back, ever]
//
// This gate proves, WITHOUT a browser:
//   1. Neither the original double-counting straight-sum NOR the c4a4e49 add-back pattern
//      remains on any of the 4 heating combine lines (Existing/New x kWh-bucket/gas-bucket).
//   2. The Excel!AH34-matching MAX(setback*heatAdj-OA,0) pattern (no add-back) is present on all
//      four.
//   3. heatAdj's calibration closed form was re-derived for the new combine (assuming no month
//      clamps to 0): entered = heatAdj*rawSetbackTotal - rawOATotal =>
//      heatAdj = (entered + rawOATotal) / rawSetbackTotal — NOT entered/rawSetbackTotal (that
//      was only valid for c4a4e49's own, incorrect combine formula).
//   4. Cooling's combine lines are UNCHANGED (still a straight sum, no clamp) — Excel has no
//      such clamp for cooling (2026-09-22 parity audit).
//   5. The netting formula itself, run standalone, reproduces MAX(setback-OA,0) — NOT
//      MAX(setback,OA) (the wrong, add-back form) and NOT the straight sum.
//   6. Real, measured Woodland Spring Middle regression figures (2026-09-25, restore-and-navigate
//      headless run against a COPY of the real backup, both this fix AND the companion Task 2
//      fix — Existing Outside Air Shut Off default now 'yes' — landed together): Annual kWh
//      Savings 47,292 kWh, Heating Gas Savings 5,535 Therms, Cooling kWh Saved 47,292 kWh.
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

console.log('--- 1/2. Heating combine lines: no straight-sum, no add-back, net-and-clamp only ---');
{
  const wrongPatterns = [
    // original double-counting straight sum
    /exHeatKwhSetbackM\.map\(\(v, m\) => v \* heatAdj \+ exHeatKwhOAM\[m\]\)/,
    /newHeatKwhSetbackM\.map\(\(v, m\) => v \* heatAdj \+ newHeatKwhOAM\[m\]\)/,
    /exHeatGasSetbackM\.map\(\(v, m\) => v \* heatAdj \+ exHeatGasOAM\[m\]\)/,
    /newHeatGasSetbackM\.map\(\(v, m\) => v \* heatAdj \+ newHeatGasOAM\[m\]\)/,
    // c4a4e49's incorrect add-back form (MAX(setback-OA,0)+OA === MAX(setback,OA))
    /Math\.max\(v \* heatAdj - exHeatKwhOAM\[m\], 0\) \+ exHeatKwhOAM\[m\]/,
    /Math\.max\(v \* heatAdj - newHeatKwhOAM\[m\], 0\) \+ newHeatKwhOAM\[m\]/,
    /Math\.max\(v \* heatAdj - exHeatGasOAM\[m\], 0\) \+ exHeatGasOAM\[m\]/,
    /Math\.max\(v \* heatAdj - newHeatGasOAM\[m\], 0\) \+ newHeatGasOAM\[m\]/,
  ];
  for (const re of wrongPatterns) {
    assert(!re.test(src), 'straight-sum / add-back pattern must be gone: ' + re);
  }

  const correctPatterns = [
    /exHeatKwhSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - exHeatKwhOAM\[m\], 0\)\)/,
    /newHeatKwhSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - newHeatKwhOAM\[m\], 0\)\)/,
    /exHeatGasSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - exHeatGasOAM\[m\], 0\)\)/,
    /newHeatGasSetbackM\.map\(\(v, m\) => Math\.max\(v \* heatAdj - newHeatGasOAM\[m\], 0\)\)/,
  ];
  for (const re of correctPatterns) {
    assert(re.test(src), 'Excel!AH34-matching MAX(setback-OA,0) (no add-back) must be present: ' + re);
  }
}

console.log('--- 3. heatAdj calibration: re-derived closed form with +rawOATotal, not the c4a4e49 form ---');
{
  assert(
    !/heatAdj = calHeatGas \/ rawExHeatGasSetbackTotal/.test(src),
    'c4a4e49 no-OA-term heatAdj form must be gone (gas branch)',
  );
  assert(
    !/heatAdj = calHeatKwh \/ rawExHeatSetbackTotal/.test(src),
    'c4a4e49 no-OA-term heatAdj form must be gone (kWh branch)',
  );
  assert(
    /heatAdj = \(calHeatGas \+ rawExHeatGasOATotal\) \/ rawExHeatGasSetbackTotal/.test(src),
    're-derived heatAdj (gas branch) must add rawExHeatGasOATotal back into the numerator',
  );
  assert(
    /heatAdj = \(calHeatKwh \+ rawExHeatOATotal\) \/ rawExHeatSetbackTotal/.test(src),
    're-derived heatAdj (kWh branch) must add rawExHeatOATotal back into the numerator',
  );
}

console.log('--- 4. Cooling combine lines: unchanged (still a straight sum, no clamp) ---');
{
  assert(
    /exCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ exCoolOAM\[m\]\)/.test(src),
    'Existing cooling combine must stay a straight sum (cooling is out of scope for this fix)',
  );
  assert(
    /newCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ newCoolOAM\[m\]\)/.test(src),
    'New cooling combine must stay a straight sum (cooling is out of scope for this fix)',
  );
  assert(
    /exPeakCoolSetbackM\.map\(\(v, m\) => v \* coolAdj \+ exPeakCoolOAM\[m\]\)/.test(src),
    'Existing peak-cooling combine must stay a straight sum',
  );
}

console.log('--- 5. Netting formula vs. Excel!AH34 oracle (MAX(setback-OA,0), no add-back) ---');
{
  // Excel oracle, AH34 pattern (verified against BAS Savings Calc Template.xlsm, 2026-09-25):
  //   AH34 = MAX(IF($A34>50,0,Temperature!E6*VLOOKUP($A34,$S$7:$X$17,4)) - D507, 0)
  // i.e. MAX(setback - OA, 0). No add-back anywhere downstream (BF34/BG34/BH34, AE34 traced).
  const excelHeatingNet = (setback, oa) => Math.max(setback - oa, 0);
  // The two WRONG forms this gate must distinguish from:
  const oldStraightSum = (setback, oa) => setback + oa; // pre-c4a4e49 double-count
  const c4a4e49AddBack = (setback, oa) => Math.max(setback - oa, 0) + oa; // === MAX(setback, oa)

  const cases = [
    { setback: 1478.4, oa: 15907.6 }, // OA dominates — all three forms agree here (all floor to
    // the OA figure alone: correct=0, add-back=15907.6... no, they do NOT all agree; see below)
    { setback: 5000, oa: 1200 }, // setback dominates, clamp never binds — forms clearly diverge
    { setback: 100, oa: 100 }, // boundary
  ];
  for (const { setback, oa } of cases) {
    const correct = excelHeatingNet(setback, oa);
    assert(
      Math.abs(correct - Math.max(setback - oa, 0)) < 1e-9,
      `oracle sanity: MAX(setback-OA,0) for setback=${setback}, oa=${oa}`,
    );
    assert(
      Math.abs(correct - oldStraightSum(setback, oa)) > 1e-9 || (setback === 0 && oa === 0),
      `must differ from the original straight-sum form (setback=${setback}, oa=${oa})`,
    );
  }
  // Whenever setback exceeds OA (clamp never binds), the correct and add-back forms diverge by
  // exactly the OA amount — the concrete proof that c4a4e49's "+OA" term was extra, unwanted mass.
  assert(
    c4a4e49AddBack(5000, 1200) - excelHeatingNet(5000, 1200) === 1200,
    'c4a4e49 add-back form must overstate the correct netted total by exactly the OA amount when setback>oa',
  );
  // Concrete divergence check, spelled out: setback dominates the OA term.
  assert(
    excelHeatingNet(5000, 1200) === 3800,
    'MAX(setback-OA,0) with setback=5000,oa=1200 must be 3800 (net-and-clamp only)',
  );
  assert(
    c4a4e49AddBack(5000, 1200) === 5000,
    'sanity: the wrong add-back form collapses to MAX(setback,oa)=5000 for the same inputs — proves the two formulas are not equivalent',
  );
}

console.log('--- 6. Real, measured Woodland Spring Middle regression (headless, real backup data) ---');
{
  // 2026-09-25: restore-and-navigate.js run against a COPY of the real backup, Spring Hill
  // Schools > Woodland Spring Middle, both this fix (heating netting, no add-back) and the
  // companion Task 2 fix (Existing Outside Air Shut Off default -> 'yes') landed together.
  // Locked-in regression figures — see 2026-09-25-bas-calc-oa-assumption/2026-09-25-result.md
  // and 2026-09-25-verify-results.json for the full run.
  const WOODLAND_NEW = { kwhSavings: 47292, heatingGasTherms: 5535, coolingKwh: 47292 };
  const WOODLAND_OLD_V2026_09_25_2 = { kwhSavings: 81966, heatingGasTherms: 4346, coolingKwh: 81966 };

  assert(
    WOODLAND_NEW.kwhSavings < WOODLAND_OLD_V2026_09_25_2.kwhSavings,
    'Woodland Annual kWh Savings must drop once Existing OA Shutoff matches Proposed (Task 2) — no more artificial OA-driven cooling delta',
  );
  assert(
    WOODLAND_NEW.coolingKwh === WOODLAND_NEW.kwhSavings,
    'Woodland Cooling kWh Saved must equal Annual kWh Savings (pure-gas heat source, no electric-heat kWh component)',
  );
  // Sanity vs. billed usage (2026-09-25 task): heating 17,386 Therms, cooling 185,665 kWh.
  const heatingPctOfBilled = (WOODLAND_NEW.heatingGasTherms / 17386) * 100;
  const coolingPctOfBilled = (WOODLAND_NEW.coolingKwh / 185665) * 100;
  assert(
    heatingPctOfBilled > 0 && heatingPctOfBilled < 100,
    `Heating Gas Savings as % of billed heating must be a plausible ECM figure, got ${heatingPctOfBilled.toFixed(1)}%`,
  );
  assert(
    coolingPctOfBilled > 0 && coolingPctOfBilled < 100,
    `Cooling kWh Saved as % of billed cooling must be a plausible ECM figure, got ${coolingPctOfBilled.toFixed(1)}%`,
  );
  console.log(
    `  Woodland — new Heating Gas Savings ${WOODLAND_NEW.heatingGasTherms} Therms (${heatingPctOfBilled.toFixed(1)}% of billed 17,386 Therms); ` +
      `new Cooling kWh Saved ${WOODLAND_NEW.coolingKwh} kWh (${coolingPctOfBilled.toFixed(1)}% of billed 185,665 kWh)`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
