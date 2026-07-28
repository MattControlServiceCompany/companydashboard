/* ── ASHRAE-36 Pricing & Cost-Estimator — Phase 1 + Phase 2 (Compliance Tier)
   Spec: 2026-06-18-ashrae36-pricing-cost-estimator-SPEC.md
   Storage keys:
     en_pricing_catalog        — global SKU→{list,net,contract,computed_net,category,desc}
     en_pricing_meta           — global {importedAt,filename,skuCount}
     en_pricing_config         — global {netMultiplier,contractPct,hourlyRate,priceBasis,perSequenceHours,
                                 installHoursByPoint} (Deliverable E, 2026-07-19 — installHoursByPoint
                                 prices the PHYSICAL install hours of hardware gaps; hourlyRate is now
                                 the SINGLE $/hr rate for ALL labor — programming AND physical install
                                 — per Matt 2026-07-28 ("we need to be using the $173/hr for all labor
                                 costs not just EM"). A separate installLaborRate field/default (195)
                                 existed 2026-07-19→2026-07-28 and is now removed; any project with a
                                 stale stored installLaborRate value simply has it ignored — nothing
                                 reads that key anymore, hourlyRate is the one source of truth)
     en_pricing_estimate_{id}  — per-project {rowToggles,manualPrices,laborOverrides,tier}
     en_pricing_budget_{id}    — per-project {mode,amount,denomination,termMonths,fitToBudget,
                                 fitExcludedIds,fitPrevToggleValues,fitAppliedAt} (174ad49a).
                                 NOT the same as en_budget_{id} in app/budget.js (that key is
                                 "monthly utility-spend budget" — a different feature this one
                                 never reads or writes).
   ──────────────────────────────────────────────────────────────────────────── */

/* ── Constants (spec §1, §5) ── */
const COST_CONTRACT_PCT = 0.4;
const COST_NET_MULTIPLIER_DEFAULT = 0.6;
const COST_LABOR_RATE_DEFAULT = 125; // $/hr

const COST_PER_SEQ_HOURS_DEFAULT = {
  ahu_sat_reset: 2.5,
  ahu_dsp_reset: 2.5,
  ahu_economizer: 3.0,
  ahu_freeze_prot: 1.5,
  ahu_min_oa: 2.0,
  ahu_rf_control: 2.5,
  vav_zone_temp: 0.75,
  vav_damper_writeback: 0.5,
  vav_reheat: 0.75,
  hwp_supply_reset: 3.0,
  hwp_pump_dp_reset: 3.0,
  hwp_staging: 4.0,
  chwp_supply_reset: 3.0,
  chwp_pump_dp_reset: 3.0,
  chwp_staging: 4.0,
  demandCtrl: 2.0,
  vav_dcv: 0.5,
};

/* ── Physical install labor — Deliverable E (2026-07-19), unified rate (2026-07-28) ─────────
   COST_LABOR_RATE_DEFAULT above + COST_PER_SEQ_HOURS_DEFAULT price BAS sequence PROGRAMMING
   labor (Phase 2). Neither had ever priced the physical labor to mount/wire a sensor, actuator,
   or valve — Phase 1 ("Hardware & Installation") was parts-cost only. This block adds
   per-device-class install HOURS so Phase 1 actually includes install labor.
   RATE (2026-07-28): install labor used to carry its own separate $195/hr default
   (COST_INSTALL_LABOR_RATE_DEFAULT, removed here) that never tracked the project's Hourly Rate
   field — so a project set to $173/hr (Cost Estimate tab) still priced install hours at $195/hr.
   Matt: "we need to be using the $173/hr for all labor costs not just EM." Install hours are now
   priced at the SAME shared hourlyRate as programming labor (COST_LABOR_RATE_DEFAULT fallback) —
   one rate, one source, everywhere below that used to read the separate install rate.
   ─────────────────────────────────────────────────────────────────────────── */
const INSTALL_HOURS_FALLBACK_DEFAULT = 2.0; // hrs — used for any point key with no entry in
// POINT_KEY_INSTALL_CLASS below (keeps every future PRICE_POINT_MAP addition priced).

/* Device-class install-hours library (Matt's field-verified defaults). One class can cover many
   PRICE_POINT_MAP point keys/SKUs that carry materially the same install effort (e.g. every
   immersion well-temp sensor — hwst/hwrt/chwst/chwrt/cwst/cwrt — installs the same way). */
const INSTALL_HOURS_BY_DEVICE_CLASS_DEFAULT = {
  spaceZoneSensor: 1.5,
  ductTempRhSensor: 1.5,
  ductStaticPressureSensor: 2.0,
  immersionWellTempSensor: 2.0,
  damperActuator: 2.5,
  valveActuator: 3.0,
  controlValveActuator: 5.0,
  currentSwitchStatusRelay: 1.0,
  diffPressureSwitch: 2.0,
  unitaryDdcController: 3.5,
  ahuPlantDdcController: 7.0,
  flowBtuMeter: 5.0,
  vfdIntegration: 5.0,
  networkRouterGateway: 3.0,
  thermostat: 1.0,
};

/* PRICE_POINT_MAP key → device class. Investigation finding (Deliverable E): en_pricing_catalog's
   free-text `category` column (from the imported vendor CSV) is NOT a clean/controlled device-type
   field — many catalogs omit it entirely (colCat<0 → ''), and where present it's whatever the
   vendor happened to type. PRICE_POINT_MAP, however, already IS a clean 1:1 device-type taxonomy
   (~30 canonical ASHRAE-36 point keys, each tied to exactly one defaultSku) — the same granularity
   buildCatalogRows already uses for defaultSku/note/whyNeeded/g36Section. Mapping install-hours by
   POINT KEY here (not by raw SKU or catalog category) reuses that existing taxonomy instead of
   inventing a second one, and needs zero catalog/CSV schema change. Every point key that currently
   produces a real (non-ioOnly) hardware-gap row is mapped; ioOnly point keys (dampCmd, sfStatus,
   etc.) need no entry — they're $0/no-install by definition, guarded in buildCatalogRows.
   ahuPlantDdcController/vfdIntegration/networkRouterGateway/thermostat classes have no
   PRICE_POINT_MAP entry today (buildCatalogRows only generates sensor/actuator/valve/flow-station
   GAP rows, never "replace the whole DDC controller"/VFD/gateway/stat) — defined for forward
   compatibility only; not reachable via today's rows. Flagged for Matt, not guessed at. */
const POINT_KEY_INSTALL_CLASS = {
  sat: 'ductTempRhSensor',
  rat: 'ductTempRhSensor',
  mat: 'ductTempRhSensor',
  oat: 'ductTempRhSensor',
  dsp: 'ductStaticPressureSensor',
  co2_ahu: 'ductTempRhSensor',
  dat: 'ductTempRhSensor',
  hwst: 'immersionWellTempSensor',
  hwrt: 'immersionWellTempSensor',
  chwst: 'immersionWellTempSensor',
  chwrt: 'immersionWellTempSensor',
  cwst: 'immersionWellTempSensor',
  cwrt: 'immersionWellTempSensor',
  hwdp: 'diffPressureSwitch',
  chwdp: 'diffPressureSwitch',
  oaWetBulb: 'ductTempRhSensor',
  zoneTemp: 'spaceZoneSensor',
  co2_zone: 'spaceZoneSensor',
  // co2_zone_standalone (2026-07-28): standalone CO2-only zone sensor — same wall-mount install
  // effort as the other zone-sensor classes above.
  co2_zone_standalone: 'spaceZoneSensor',
  oaDampCmd: 'damperActuator',
  raDampCmd: 'damperActuator',
  // damperPositionControl (2026-07-27): consolidated OA+RA damper row — same install class/hours
  // as either individual key (same physical actuator part).
  damperPositionControl: 'damperActuator',
  chwIsoValveCmd: 'valveActuator',
  cwIsoValveCmd: 'valveActuator',
  makeupValveCmd: 'valveActuator',
  clgValve: 'controlValveActuator',
  htgValve: 'controlValveActuator',
  reheatValve: 'controlValveActuator',
  discFlow: 'unitaryDdcController',
  primaryFlow: 'unitaryDdcController',
  freezeStat: 'currentSwitchStatusRelay',
  oaFlow: 'flowBtuMeter',
};

/* Computed default install-hours per point key — resolved once so buildCatalogRows/every caller
   doesn't re-walk the class indirection on every row. */
const INSTALL_HOURS_BY_POINT_DEFAULT = (function () {
  var out = {};
  Object.keys(POINT_KEY_INSTALL_CLASS).forEach(function (pk) {
    var cls = POINT_KEY_INSTALL_CLASS[pk];
    out[pk] =
      INSTALL_HOURS_BY_DEVICE_CLASS_DEFAULT[cls] != null
        ? INSTALL_HOURS_BY_DEVICE_CLASS_DEFAULT[cls]
        : INSTALL_HOURS_FALLBACK_DEFAULT;
  });
  return out;
})();

/* ── ROI Savings Impact Model — Phase 5 (2026-06-19)
   Sources:
     [NLR-DSP-2026]  Allen, NLR/TP-5500-98345, OSTI 3022261 (fan SP reset)
     [LBNL-G36-2022] Zhang/Blum/Granderson, J.Bldg.Perf.Sim. 15(2), OSTI 1842567 (31% avg HVAC)
     [ORNL-G36-2024] Energy & Buildings, DOI:10.1016/j.enbuild.2024.115005 (42% research facility)
     [NREL-DCV-2023] OSTI 2284042 (DCV 2.6% site energy)
     [NLR-VSP-2025]  OSTI 3021527 (variable-speed pumps; proxy for DP reset)
     [G36-2021]      ASHRAE Guideline 36-2021
     [CSC-BAS-CALC]  CSC BAS Savings Calculator (internal)
   ─────────────────────────────────────────────────────────────────────────── */

/* Source-type labels (correction #15) */
const SAVINGS_SOURCE_LITERATURE = 'literature'; // "Literature range — verify with M&V"
const SAVINGS_SOURCE_ENGINEERING = 'engineering'; // "Engineering estimate — site-specific calc needed"

/* ORNL context sentence — must accompany every citation of 42% (correction #2) */
const ORNL_CONTEXT_SENTENCE =
  '42% measured at a single research test facility with rooftop unit (ORNL 2024); ' +
  'multizone-VAV simulation (LBNL 2022) shows 31% avg — more representative of a multi-building VAV portfolio.';

/* M&V disclaimer (correction #11) */
const SAVINGS_DISCLAIMER_TEXT =
  'Energy savings estimates are based on published research studies and engineering calculations ' +
  'representing typical ranges for applicable building types. They are not guarantees of performance. ' +
  'Actual savings depend on existing control sequence quality, equipment condition, utility rates, ' +
  'occupancy patterns, and climate. Post-installation measurement and verification (M&V) is required ' +
  'to confirm realized savings.';

/* Per-sequence savings impact data (correction #1, #4, #5, #6, #7, #8, #9, #13, #14, #15)
   Fields:
     tier           — 'high'|'med-high'|'med'|'low-med'|'enabler'|'safety'
     type           — 'savings'|'enabler'|'safety'
     weight         — numeric sort weight within tier (higher = sort earlier)
     nominalCostTier — 1=programming-only, 2=one sensor, 3=multiple sensors/AFMS
     savingsRationale — full sentence shown in Notes column (visible, not hover-only)
     source         — citation abbreviation
     sourceType     — SAVINGS_SOURCE_LITERATURE | SAVINGS_SOURCE_ENGINEERING
   ─────────────────────────────────────────────────────────────────────────── */
const SEQUENCE_SAVINGS_IMPACT = {
  ahu_dsp_reset: {
    tier: 'high',
    type: 'savings',
    weight: 3,
    nominalCostTier: 2,
    savingsRationale:
      'Trim-and-respond duct pressure reset reduces supply fan speed during part-load hours, ' +
      'cutting fan energy 22–65% in applicable systems; field studies show 22–25% in real buildings. ' +
      '[NLR-DSP-2026, OSTI 3022261]',
    // clientSummary: client-facing 1-sentence benefit statement (2026-06-30 report defect fix).
    // No citations, warnings, tool names, or portfolio-specific counts — see savingsRationale above for internal use.
    clientSummary:
      'Reduces supply fan energy by automatically lowering duct pressure whenever zones have enough airflow, ' +
      'cutting fan energy use during part-load hours.',
    source: '[NLR-DSP-2026]',
    sourceType: SAVINGS_SOURCE_LITERATURE,
  },
  ahu_sat_reset: {
    tier: 'high',
    type: 'savings',
    weight: 3,
    nominalCostTier: 1,
    savingsRationale:
      'Supply air temperature trim-and-respond reset eliminates over-cooling and simultaneous heating, ' +
      'reducing chiller and reheat energy. Multizone-VAV simulation: G36 controls cut HVAC energy 31% avg ' +
      '(LBNL 2022). ' +
      ORNL_CONTEXT_SENTENCE,
    clientSummary:
      'Adjusts supply air temperature to match real-time building demand, reducing simultaneous heating and ' +
      'cooling and lowering overall HVAC energy use.',
    source: '[LBNL-G36-2022]',
    sourceType: SAVINGS_SOURCE_LITERATURE,
  },
  ahu_economizer: {
    tier: 'high',
    type: 'savings',
    weight: 2,
    nominalCostTier: 1,
    savingsRationale:
      'Modulating economizer provides free cooling when outdoor conditions are favorable, directly displacing ' +
      'compressor energy. Applicable in Climate Zone 4A approximately 20–40% of cooling hours annually ' +
      '(engineering estimate; site-specific simulation needed for $ projection).',
    clientSummary:
      'Uses outdoor air for free cooling whenever conditions allow, reducing mechanical cooling run time and ' +
      'compressor energy.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  demandCtrl: {
    // 2026-07-22: promoted from 'med-high' to 'high' — DCV is an easy/low-cost install that
    // gives high-value information (occupancy-driven ventilation data) and should be the
    // top-priority Recommended-tier measure. See also the DCV-first tiebreak added to
    // _pricingSortRecommendedRows (below), which guarantees this regardless of weight/cost
    // score math so DCV always sorts ahead of every other measure, not just ahead of the
    // med-high bucket.
    //
    // 2026-07-27 (Matt, twice in one message): "DCV should be top priority since its an easy
    // install and gives us good information" / "DCV should be highest priority." This was NOT yet
    // true for the ROI ranking that actually decides PHASE membership/order
    // (_pricingEquipRowScore, read by _pricingBuildRoiUnits/_pricingComputeRecommendedTimeline) —
    // only the Recommended-tier TABLE DISPLAY sort had a DCV-first override. A real JOCO vav_dcv
    // unit measured as low as score 1.25 (weight 2.5 / effectiveCostTier 2, when its CO2 sensor is
    // still a hardware gap) against ahu_sat_reset/ahu_dsp_reset's 3 — nowhere close to "highest".
    //
    // `priorityBonus` (read only by _pricingEquipRowScore, below) expresses WHY DCV outranks
    // higher-weight measures: it is a flat premium for install ease + diagnostic value, the two
    // reasons Matt gave — properties the weight/effectiveCostTier ratio alone cannot capture (that
    // ratio only prices $ savings against $ cost, not "how easy" or "how useful the data is").
    //
    // Sizing, REVISED after real-data verification (2026-07-27, same day/branch): the first attempt
    // used bonus=2, which made DCV's WORST case (weight 2.5 / costTier 2 = 1.25 + 2 = 3.25) exceed
    // dsp/sat-reset's max (weight 3 / costTier 1 = 3) outright — not merely tied. On real JOCO data
    // this had a second-order effect nobody asked for: because DCV strictly outranked dsp/sat-reset
    // (no longer TIED with them), the ~750-unit DCV candidate pool no longer competed in the same
    // tie group _pricingDiversifyTiedUnits round-robins — it simply out-ranked the ~24-unit
    // dsp/sat-reset pool everywhere, so the Fit-to-Budget greedy prefix (_pricingGreedyPrefix, used
    // by buildRecommendedRows for tier MEMBERSHIP, not just phase placement) filled the entire
    // ~$97k Recommended-tier budget with DCV before ever reaching a single dsp/sat-reset unit —
    // fan-energy optimization (this task's original Bug 2744e688) disappeared from the Recommended
    // tier ENTIRELY, not just from one phase. That is a worse outcome than the bug being fixed and
    // directly contradicts the client's own base document ("remaining ventilation and fan
    // optimization" in Phase 3).
    //
    // Fix: bonus=1.75, sized so DCV's WORST case lands at EXACTLY 3.0 — TYING dsp/sat-reset's max,
    // never exceeding it in the worst case (DCV instances that are cheaper — CO2 sensor already
    // covered, effectiveCostTier 1 — still score 4.25, genuinely ahead, which is correct: an easy
    // win should outrank a harder one). Because DCV now ties into the SAME score group as
    // dsp/sat-reset instead of a strictly-higher one, _pricingDiversifyTiedUnits' round-robin
    // (extended to _pricingGreedyPrefix too — see that function) applies to DCV alongside them:
    // DCV is listed first in the round-robin's family order (see _pricingDiversifyTiedUnits),
    // so it wins every round's first pick — "highest priority" within the tie — but the round-robin
    // still guarantees dsp/sat-reset get admitted too as rounds continue, rather than being frozen
    // out entirely. This is the "compose, don't fight" resolution: DCV is preferred at every
    // opportunity, but a finite, ROI-scored set of other high-tier measures still gets a seat.
    priorityBonus: 1.75,
    tier: 'high',
    type: 'savings',
    weight: 2.5,
    nominalCostTier: 2,
    savingsRationale:
      'CO2-based demand-controlled ventilation (AHU duct level) reduces outdoor air delivery during ' +
      'lower-occupancy periods, cutting heating and cooling energy. National average: 2.6% total site ' +
      'energy savings; 8.8% heating gas savings in applicable commercial buildings. [NREL-DCV-2023, OSTI 2284042]. ' +
      'Note: 2.6% is a commercial-office stock average; verify applicability to institutional/detention occupancy.',
    clientSummary:
      'Reduces outdoor air intake during lower-occupancy periods, cutting the heating and cooling energy needed ' +
      'to condition unnecessary ventilation air.',
    source: '[NREL-DCV-2023]',
    sourceType: SAVINGS_SOURCE_LITERATURE,
  },
  vav_dcv: {
    // 2026-07-22: promoted from 'med-high' to 'high' — see demandCtrl comment above.
    // 2026-07-27: priorityBonus — see the full rationale (and the revised 1.75 sizing after
    // real-data verification) in demandCtrl's comment block above; same reasoning applies
    // identically at zone level.
    priorityBonus: 1.75,
    tier: 'high',
    type: 'savings',
    weight: 2.5,
    nominalCostTier: 2,
    savingsRationale:
      'CO2-based demand-controlled ventilation (zone level — needs zone CO2 sensors) reduces outdoor air ' +
      'per zone during lower-occupancy periods. Same national average basis as AHU-level DCV: 2.6% total site ' +
      'energy savings in applicable buildings. [NREL-DCV-2023, OSTI 2284042]. ' +
      'Note: verify applicability to institutional/detention occupancy patterns.',
    clientSummary:
      'Reduces outdoor air delivered to each zone based on real-time occupancy, avoiding the energy cost of ' +
      'over-ventilating lightly used spaces.',
    source: '[NREL-DCV-2023]',
    sourceType: SAVINGS_SOURCE_LITERATURE,
  },
  hwp_supply_reset: {
    tier: 'med-high',
    type: 'savings',
    weight: 2,
    nominalCostTier: 1,
    savingsRationale:
      'Hot water supply temperature trim-and-respond reset reduces boiler firing rate during mild weather ' +
      'and can push condensing boilers into higher-efficiency operation (up to ~11 AFUE points on condensing-range hours), ' +
      'reducing heating gas consumption. Savings depend on boiler type — consult BAS Savings Calc for site-specific estimate. ' +
      '⚠ Verify boiler type: MED (non-condensing) / MED-HIGH (condensing).',
    clientSummary:
      'Lowers boiler water temperature during mild weather, reducing boiler firing and heating gas consumption.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  chwp_supply_reset: {
    tier: 'med-high',
    type: 'savings',
    weight: 2,
    nominalCostTier: 1,
    savingsRationale:
      'Chilled water supply temperature trim-and-respond reset raises the CHWST setpoint under light loads, ' +
      'reducing chiller lift. Every 1°F increase in CHWST improves chiller COP approximately 1–2% ' +
      '(rule of thumb from manufacturer performance curves). ' +
      'Centrifugal chillers most sensitive to CHWST; scroll/recip see smaller gains. ' +
      'Requires site-specific calculation for $ savings.',
    clientSummary: 'Raises chilled water temperature under light cooling loads, reducing chiller energy use.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  hwp_pump_dp_reset: {
    tier: 'med',
    type: 'savings',
    weight: 2,
    nominalCostTier: 2,
    savingsRationale:
      'Pump differential pressure reset reduces HW pump speed during lower-load periods. ' +
      'Pump power follows the cube law — a 20% speed reduction cuts pump power by nearly 50%. ' +
      'Requires differential pressure sensor installation; programming change is low-cost once sensor is in place. ' +
      '(Qualitative only — no single-measure study for controls-only savings; drop $ estimate.)',
    clientSummary: 'Reduces hot water pump speed during lower-load periods, cutting pump energy use.',
    source: '[NLR-VSP-2025]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  chwp_pump_dp_reset: {
    tier: 'med',
    type: 'savings',
    weight: 2,
    nominalCostTier: 2,
    savingsRationale:
      'Pump differential pressure reset reduces CHW pump speed during lower-load periods. ' +
      'Pump power follows the cube law — a 20% speed reduction cuts pump power by nearly 50%. ' +
      'CHW pump is typically larger than HW side, so absolute savings may be higher. ' +
      '(Qualitative only — no single-measure study for controls-only savings; drop $ estimate.)',
    clientSummary: 'Reduces chilled water pump speed during lower-load periods, cutting pump energy use.',
    source: '[NLR-VSP-2025]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  ahu_rf_control: {
    tier: 'med',
    type: 'savings',
    weight: 1.5,
    nominalCostTier: 1,
    savingsRationale:
      'Return fan speed coordination with supply fan maintains building pressurization and eliminates ' +
      'excess recirculation energy. Only applicable in systems with a powered return fan (hasReturnFan config).',
    clientSummary:
      'Coordinates return fan speed with the supply fan, maintaining proper building pressurization and ' +
      'eliminating wasted recirculation energy.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  vav_zone_temp: {
    tier: 'med',
    type: 'savings',
    weight: 1.5,
    nominalCostTier: 1,
    savingsRationale:
      'Zone temperature setpoints enable G36 dual-maximum logic — heating only activates below the heating ' +
      'setpoint, cooling only above the cooling setpoint, with a deadband in between. Eliminating zone ' +
      'over-conditioning directly reduces both heating and cooling energy. ' +
      'High prevalence in JOCO portfolio: 766 VAV units missing coolSP/htgSP.',
    clientSummary:
      'Establishes separate heating and cooling setpoints with a deadband between them, eliminating unnecessary ' +
      'simultaneous heating and cooling at the zone level.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  vav_reheat: {
    tier: 'med',
    type: 'savings',
    weight: 1,
    nominalCostTier: 1,
    savingsRationale:
      'G36 reheat sequencing prevents simultaneous heating and cooling by releasing reheat only after the ' +
      'cooling damper reaches minimum. Correct implementation can eliminate 5–15% of building energy waste ' +
      'in systems with misconfigured VAV reheat (rule of thumb from audit practice; no published study — ' +
      'confirm via BAS trend data before citing in a contract).',
    clientSummary:
      'Sequences reheat to activate only after the cooling damper reaches minimum position, preventing ' +
      'simultaneous heating and cooling energy waste.',
    source: '[audit rule of thumb]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  ahu_min_oa: {
    tier: 'low-med',
    type: 'savings',
    weight: 1.5,
    nominalCostTier: 2,
    savingsRationale:
      'Compliance/IAQ: code-minimum outside air at all fan speeds — measured airflow ensures ventilation ' +
      'code is met regardless of fan operating point. ' +
      'Energy: prevents part-load over-ventilation penalty (secondary benefit). ' +
      'Primarily a ventilation quality and compliance measure; energy savings are secondary.',
    clientSummary:
      'Ensures the correct amount of outside air is delivered at every fan speed, meeting ventilation ' +
      'requirements while avoiding over-ventilation energy waste.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  vav_damper_writeback: {
    tier: 'enabler',
    type: 'enabler',
    weight: 1,
    nominalCostTier: 1,
    savingsRationale:
      'Enables Duct SP Reset: damper write-back allows the BAS to detect zone damper positions for ' +
      'supply fan pressure optimization (DSP reset) and unoccupied-mode damper closure. ' +
      'Also enables fault detection for stuck-damper identification.',
    clientSummary:
      'Provides zone damper position feedback to the BAS, enabling duct pressure reset and automatic ' +
      'unoccupied-mode damper closure.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
    enablesLabel: 'Enables Duct SP Reset',
  },
  hwp_staging: {
    tier: 'enabler',
    type: 'enabler',
    weight: 1,
    nominalCostTier: 1,
    savingsRationale:
      'Enables HW Plant Reset: boiler/chiller staging sequences ensure the correctly sized unit runs ' +
      'at each load level, avoiding part-load inefficiency and enabling HW supply temperature and ' +
      'DP reset sequences to function correctly.',
    clientSummary:
      'Sequences multiple boilers so the right-sized unit runs at each load level, avoiding part-load ' +
      'inefficiency and enabling hot water temperature reset.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
    enablesLabel: 'Enables HW Plant Reset',
  },
  chwp_staging: {
    tier: 'enabler',
    type: 'enabler',
    weight: 1,
    nominalCostTier: 1,
    savingsRationale:
      'Enables CHW Plant Reset: chiller staging sequences ensure the correctly sized unit runs ' +
      'at each load level, avoiding part-load inefficiency and enabling CHW supply temperature and ' +
      'DP reset sequences to function correctly.',
    clientSummary:
      'Sequences multiple chillers so the right-sized unit runs at each load level, avoiding part-load ' +
      'inefficiency and enabling chilled water temperature reset.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
    enablesLabel: 'Enables CHW Plant Reset',
  },
  ahu_freeze_prot: {
    tier: 'safety',
    type: 'safety',
    weight: 0,
    nominalCostTier: 1,
    savingsRationale:
      'Freeze protection prevents coil damage during cold weather — a safety and reliability requirement, ' +
      'not an energy optimization. Cost avoidance from prevented repairs can be significant but is not ' +
      'an energy savings.',
    clientSummary:
      'Protects heating and cooling coils from freeze damage during cold weather, reducing the risk of costly ' +
      'equipment failure.',
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
};

/* ── Blocking sensor sets per sequence (for effectiveCostTier computation)
   If ALL blocking sensors for this sequence are already covered → effectiveCostTier=1
   ─────────────────────────────────────────────────────────────────────────── */
const SEQUENCE_BLOCKING_SENSORS = {
  ahu_dsp_reset: ['dsp'],
  ahu_sat_reset: ['sat'],
  ahu_economizer: ['mat', 'oat'],
  demandCtrl: ['co2_ahu'],
  vav_dcv: ['co2_zone'],
  hwp_supply_reset: ['hwst', 'hwSetpoint'],
  chwp_supply_reset: ['chwst', 'chwSetpoint'],
  hwp_pump_dp_reset: ['hwdp'],
  chwp_pump_dp_reset: ['chwdp'],
  ahu_rf_control: [],
  vav_zone_temp: ['coolSP', 'htgSP'],
  vav_reheat: [],
  ahu_min_oa: ['oaDampCmd'],
  vav_damper_writeback: [],
  hwp_staging: [],
  chwp_staging: [],
  ahu_freeze_prot: [],
};

/* ── _HW_ROW_KEY_ALIASES ────────────────────────────────────────────────────────────────────
   Pre-existing bug found by this branch's new unit-atomicity check (2026-07-28,
   fix/roi-no-hardware-first-per-unit — see _pricingBuildRoiUnits), NOT introduced by this
   branch: a phase-1 hardware row's `_pointKey` does not always literally equal the blocking-
   sensor key named above, because buildCatalogRows re-prices/re-groups a handful of point keys
   into a DIFFERENT catalog bucket for correct SKU selection or display consolidation:
     - 'co2_zone': the 2026-07-27 CO2 SKU correction (see dashboardlogic.md addendum) routes a
       zone missing ONLY co2 (zoneTemp already present — the common case, ~749 of 776 real JOCO
       instances) to 'co2_zone_standalone' (SKU N1-AQX-C-A), not 'co2_zone' (the combo SKU, only
       used when zoneTemp is ALSO missing). SEQUENCE_BLOCKING_SENSORS.vav_dcv still names the
       original 'co2_zone' key.
     - 'oaDampCmd'/'raDampCmd': the damper-actuator consolidation (2026-07-27) merges both into a
       single 'damperPositionControl' hardware row. SEQUENCE_BLOCKING_SENSORS.ahu_min_oa still
       names the original 'oaDampCmd' key.
   Effect before this alias map: _pricingPairHwSeq could never find a matching hardware row for
   vav_dcv (standalone case) or ahu_min_oa, so a unit needing hardware for either sequence always
   claimed hwRows=[] — silently under-costing the unit AND (pre-this-branch) always landing
   _effectiveCostTier=1 at the old building-level gapPointKeys check, which used the SAME
   mismatched key. Real-data impact: vav_dcv is a `priorityBonus` sequence at the center of this
   task's own worked example, so this was corrected as part of making Change 1/2 correct, not as
   an unrelated fix — flagged explicitly rather than silently folded in. Used only for matching a
   hardware row to the blocking-sensor requirement that generated it; does not change
   SEQUENCE_BLOCKING_SENSORS, PRICE_POINT_MAP, or any pricing/labor math. ── */
var _HW_ROW_KEY_ALIASES = {
  co2_zone: ['co2_zone', 'co2_zone_standalone'],
  oaDampCmd: ['oaDampCmd', 'damperPositionControl'],
  raDampCmd: ['raDampCmd', 'damperPositionControl'],
};
function _hwRowKeyMatchesBlocking(hwPointKey, blockingKeys) {
  for (var i = 0; i < blockingKeys.length; i++) {
    var accepted = _HW_ROW_KEY_ALIASES[blockingKeys[i]] || [blockingKeys[i]];
    if (accepted.indexOf(hwPointKey) !== -1) return true;
  }
  return false;
}

/* ── Step 5: $ savings range data per sequence (2026-06-19)
   energyBasis: 'fan' = annualElec × fanFraction × [low..high]
                'elec' = annualElec × [low..high]
                'elecPct' = annualElec × constant% (tight range around known study value)
                null = qualitative only — engineering estimate, show prompt not $
   Sequences without a published-study % basis are set to null (show qualitative only).
   DCV: 2.6% total site energy ≈ total elec (approximation; gas savings shown qualitatively).
   ─────────────────────────────────────────────────────────────────────────── */
const SAVINGS_RANGE_MAP = {
  ahu_dsp_reset: { lowPct: 0.22, highPct: 0.65, energyBasis: 'fan', citation: '[NLR-DSP-2026]' },
  ahu_sat_reset: { lowPct: 0.22, highPct: 0.42, energyBasis: 'fan', citation: '[LBNL-G36-2022 / ORNL-G36-2024]' },
  demandCtrl: { lowPct: 0.022, highPct: 0.03, energyBasis: 'elec', citation: '[NREL-DCV-2023]' },
  vav_dcv: { lowPct: 0.022, highPct: 0.03, energyBasis: 'elec', citation: '[NREL-DCV-2023]' },
  // All others: qualitative only (no fabricated % from engineering-only sources)
};
const FAN_FRACTION_DEFAULT = 0.12; // CBECS VAV 10–20%; user-editable

/* ── Get project annual electricity (kWh) from en_utility_<projId> bill data ──
   Returns { annualKwh: number|null, hasBillData: boolean, elecRate: number }.
   annualKwh: sum of kWh on all electricity meters over the most recent
   12 months of bill data (or all bills if fewer than 12 are available).
   elecRate: weighted average $/kWh across all elec bills; fallback 0.10.
   Returns hasBillData=false if the project has no electricity bills.
   Data source: en_utility_<projId> → { buildings: [{ meters: [{ bills: [] }] }] }
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingGetProjectAnnualElec(projId) {
  var utilData = typeof sget === 'function' ? sget('en_utility_' + projId, null) : null;
  if (!utilData || !utilData.buildings) return { annualKwh: null, hasBillData: false, elecRate: 0.1 };

  var allElecBills = [];
  var totalCost = 0,
    totalKwh = 0;
  (utilData.buildings || []).forEach(function (b) {
    (b.meters || []).forEach(function (m) {
      if (m.commodity && m.commodity !== 'Electricity') return;
      (m.bills || []).forEach(function (bill) {
        var kwh = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
        if (kwh > 0) {
          allElecBills.push({ kwh: kwh, start: bill.start || bill.date || '' });
          totalKwh += kwh;
          totalCost += parseFloat(bill.totalCost) || parseFloat(bill.amount) || 0;
        }
      });
    });
  });

  if (!allElecBills.length) return { annualKwh: null, hasBillData: false, elecRate: 0.1 };

  // Sort by date descending, take most recent 12 months of bills
  allElecBills.sort(function (a, b) {
    return (b.start || '').localeCompare(a.start || '');
  });
  var recentBills = allElecBills.slice(0, 12);
  var annualKwh = recentBills.reduce(function (s, b) {
    return s + b.kwh;
  }, 0);
  // If fewer than 12 bills, annualize by extrapolating
  if (recentBills.length < 12 && recentBills.length > 0) {
    annualKwh = (annualKwh / recentBills.length) * 12;
  }
  var elecRate = totalKwh > 0 && totalCost > 0 ? totalCost / totalKwh : 0.1;
  return { annualKwh: Math.round(annualKwh), hasBillData: true, elecRate: elecRate };
}

/* ── Format savings range as "$X,XXX–$Y,YYY/yr" ───────────────────────────── */
function _pricingFmtSavingsRange(low, high) {
  function fmt(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  if (low === high) return fmt(low) + '/yr';
  return fmt(low) + '–' + fmt(high) + '/yr';
}

/* ── Compute savings range for a row given annual energy data ───────────────
   Returns { low, high, label } or null if not computable.
   The 3 must-validate sequences (hwp_supply_reset, vav_reheat, demandCtrl/vav_dcv)
   keep their existing persistent warnings from savingsRationale — no $ suppression here
   beyond what SAVINGS_RANGE_MAP already handles (demandCtrl/vav_dcv ARE in the map).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeSavingsRange(row, annualKwh, fanFraction, elecRate) {
  var rmap = SAVINGS_RANGE_MAP[row.seqKey];
  if (!rmap) return null;
  if (!annualKwh) return null;
  // elecRate fallback: $0.10/kWh if not available
  var rate = elecRate || 0.1;
  var appEnergy;
  if (rmap.energyBasis === 'fan') {
    appEnergy = annualKwh * (fanFraction || FAN_FRACTION_DEFAULT);
  } else {
    appEnergy = annualKwh;
  }
  var low = Math.round(appEnergy * rmap.lowPct * rate);
  var high = Math.round(appEnergy * rmap.highPct * rate);
  return { low: low, high: high, citation: rmap.citation };
}

/* ── 45ceb14f: shared footer-string builders ─────────────────────────────────
   Extracted so the full-render footer (initCostEstimateTab) and the partial-
   refresh footer (_pricingRefreshFooter, patched below) render byte-identical
   Tier-label / advisory-line HTML instead of two independently-maintained
   copies. Pure functions — no DOM access, no globals mutated.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingTierLabelHTML(tier) {
  return (
    '<span style="font-size:11px;color:var(--text2);font-weight:600;text-transform:capitalize">Tier: ' +
    (tier === 'both'
      ? 'Compare'
      : tier === 'recommended'
        ? 'Recommended'
        : tier === 'full-scope'
          ? 'Full Scope'
          : 'Compliance') +
    '</span>'
  );
}

function _pricingAdvisoryLineHTML(anySavingsShown) {
  return (
    '<div style="width:100%;margin-top:6px;font-size:10px;color:var(--text3);font-style:italic">' +
    (anySavingsShown
      ? 'Savings estimates shown below in the Impact column.'
      : 'Import utility bills (Utility Data tab) to see estimated annual $ savings ranges.') +
    '</div>'
  );
}

/* ── Budget input (174ad49a) — per-project, own storage key. Two modes:
     'financing' — Mode A: "I have a total project cost, spread it over a term."
     'recurring'  — Mode B: "I have a periodic ceiling, tell me what fits inside it."
   Both modes share amount/denomination/termMonths so ONE conversion function
   (_pricingComputeBudgetTotal, below) serves both — see that function for why they
   reduce to the same arithmetic from opposite directions. fitToBudget/fitExcludedIds/
   fitPrevToggleValues/fitAppliedAt are Phase 3 state, present here from Phase 1 so the
   stored shape never needs a second migration.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingGetBudget(projId) {
  var stored = sget('en_pricing_budget_' + projId, null);
  var dflt = {
    mode: 'recurring', // 'financing' | 'recurring'
    amount: null, // null = no budget set — all budget UI stays silent/hidden
    denomination: 'monthly', // 'lump' | 'annual' | 'quarterly' | 'monthly'
    termMonths: 12,
    fitToBudget: false, // Phase 3: user has applied the Fit-to-Budget filter
    fitExcludedIds: [], // Phase 3: toggleKeys this feature (not the user) last turned off
    fitPrevToggleValues: {}, // Phase 3: toggleKey -> prior rowToggles value, for exact Clear/undo
    fitAppliedAt: null,
    serviceHoursPerMonth: 36, // Monthly Service Agreement (2026-07-20): hours/month drawn against
    // the monthly allowance (this.amount) at the shared global en_pricing_config.hourlyRate — see
    // _pricingComputeMonthlyService, below. Editable per-project; 36 is Matt's JOCO default.
  };
  if (!stored) return dflt;
  return Object.assign({}, dflt, stored);
}
function _pricingSetBudget(projId, updates) {
  var b = _pricingGetBudget(projId);
  Object.assign(b, updates);
  sset('en_pricing_budget_' + projId, b);
  return b;
}

/* ── Convert a budget entry into one comparable dollar total (174ad49a).
   Mode A (financing): the user's figure IS the thing being spread — a lump total, or a
   periodic payment that, over termMonths, finances a total. Either way, the result is
   "the total this budget affords."
   Mode B (recurring): the user's figure is a ceiling the measure-list total must fit
   inside. A lump ceiling compares directly. A periodic ceiling ("$6,800/mo") has no
   meaning as a one-time project-cost ceiling by itself — termMonths (labeled "Compare
   over (months)" for this mode) turns "$6,800/mo" into "$81,600 over 12 months," a
   horizon the USER set, never one this function invents.
   Returns null when no amount is set — callers must render nothing in that case, not a
   zero or a placeholder, so untouched projects see no UI change from this feature.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeBudgetTotal(budget) {
  if (!budget || budget.amount == null || isNaN(budget.amount) || Number(budget.amount) <= 0) return null;
  var amount = Number(budget.amount);
  if (budget.denomination === 'lump') {
    return { total: amount, basisLabel: _pricingFmt(amount) + ' lump sum' };
  }
  // 174ad49a Phase 2 guard (review-phase-b1.md check D): the Term field's markup min="1" is not
  // enforced on the stored value — a negative (-99), zero, blank, or non-integer (1.5) termMonths
  // must suppress the preview the SAME WAY an invalid amount already does above, not fall through
  // to arithmetic that renders a negative "ceiling"/"affords" total. No clamping to a fallback
  // value here on purpose: silently substituting 12 for a corrupt stored term would show a number
  // the user never entered as if it were valid.
  var term = Number(budget.termMonths);
  if (!isFinite(term) || term < 1 || Math.floor(term) !== term) return null;
  var monthsPerPeriod = { monthly: 1, quarterly: 3, annual: 12 }[budget.denomination] || 1;
  var monthlyAmount = amount / monthsPerPeriod;
  var total = monthlyAmount * term;
  var perLabel = { monthly: '/mo', quarterly: '/qtr', annual: '/yr' }[budget.denomination] || '/mo';
  return {
    total: total,
    basisLabel: _pricingFmt(amount) + perLabel + ' × ' + term + ' mo = ' + _pricingFmt(total),
  };
}

/* ── Monthly Service Agreement (2026-07-20) ───────────────────────────────────
   JOCO's offering is a MONTHLY energy-management SERVICE-ALLOWANCE agreement: the client pays
   monthly and draws down a monthly allowance at a labor rate for parts + install labor + all
   other labor. This computes that monthly figure from the per-project serviceHoursPerMonth
   budget field (default 36) × the shared global en_pricing_config.hourlyRate — the SAME rate
   Phase 1 hardware install-labor rows now use too (2026-07-28, unified labor rate; there is no
   longer a separate install rate) — and compares it against budget.amount as the not-to-exceed
   allowance. Purely additive/presentational: does not touch
   _pricingComputeBudgetTotal, the Fit-to-Budget ceiling walk, or any tier-total math above.
   Returns null when no budget.amount is set, same silent-until-configured convention as
   _pricingComputeBudgetTotal, so untouched projects see no UI change from this feature.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeMonthlyService(projId) {
  var budget = _pricingGetBudget(projId);
  if (budget.amount == null || isNaN(budget.amount) || Number(budget.amount) <= 0) return null;
  var cfg = _pricingGetConfig();
  var hourlyRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
  var hours = Number(budget.serviceHoursPerMonth);
  if (!isFinite(hours) || hours <= 0) hours = 36;
  var monthlyService = hours * hourlyRate;
  var allowance = Number(budget.amount);
  var diff = allowance - monthlyService; // positive = under cap, negative = over cap
  return {
    hours: hours,
    hourlyRate: hourlyRate,
    monthlyService: monthlyService,
    allowance: allowance,
    diff: diff,
    underCap: monthlyService <= allowance,
  };
}

/* ── Does this project have utility bills on file? (2026-07-22; NO LONGER called by the monthly
   labor breakdown as of 2026-07-27 fix/labor-bill-entry-and-audit-verification — Utility Bill Data
   Entry hours now derive from building count, not this gate, since the contract commits CSC to this
   work every month regardless of what's currently loaded into this project's database. Left intact
   as a general-purpose utility in case another caller needs it.) ──────────────────────────────────
   Utility bill data lives per-project at en_utility_{projId} → {buildings:[{meters:[{bills:[]}]}]}
   (same source _pricingGetProjectAnnualElec reads, above) — NOT en_pdf_bills, which is the
   global PDF-import staging array keyed by bill.projId before a bill is committed to a meter.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingProjectHasUtilityBills(projId) {
  var utilData = typeof sget === 'function' ? sget('en_utility_' + projId, null) : null;
  if (!utilData || !utilData.buildings) return false;
  return utilData.buildings.some(function (b) {
    return (b.meters || []).some(function (m) {
      return (m.bills || []).length > 0;
    });
  });
}

/* ── Real, campus-wide-excluded building count for a project (2026-07-27
   fix/labor-bill-entry-and-audit-verification) ───────────────────────────────────────────────────
   Single source of truth for "how many buildings does this project actually have" as far as the
   monthly labor model is concerned — reuses `collectASHRAE36Data`, the EXACT function
   `buildCatalogRows`/`buildFullScopeRows` above already call to build the cost estimate itself, so
   this can never drift from the 27-building figure shown anywhere else in the proposal that is fed
   by that same source. Campus-wide/non-building entries are excluded the same way that function
   already excludes them: collectASHRAE36Data (report-engine.js) groups equipment rows by building,
   then only pushes a building into `ashData.buildings` if it has at least one AUDITABLE-category
   row (`auditableRows.length` guard) — a "building" whose only rows are bare sensors, weather feeds,
   or non-equipment stubs never enters the list, so this never blindly counts raw building-name rows.
   Returns 0 (not null) when no equipment/ASHRAE data exists yet for the project, so callers can
   multiply by it directly without an extra null-check — 0 buildings correctly yields 0 hours for
   any per-building line item.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingGetBuildingCount(projId) {
  if (typeof collectASHRAE36Data !== 'function') return 0;
  var ashData = collectASHRAE36Data(projId);
  if (!ashData || !ashData.buildings) return 0;
  return ashData.buildings.length;
}

/* ── Monthly Recurring EM Service Labor Breakdown (2026-07-22; trend category added 2026-07-26;
   REBUILT 2026-07-26 fix-phase-cost-budget-model to stop double-counting Program & Sequence Setup
   and stop force-filling the whole allowance; REBUILT AGAIN 2026-07-27
   fix/em-labor-model-completeness to reflect everything the SIGNED agreement actually commits CSC
   to doing every month, not just setup-type work; CORRECTED same day, same branch, per Matt's
   direct client-correction: "I think the 16 hours should include the meetings, rebates and
   training"; EXTENDED 2026-07-27 fix/labor-bill-entry-and-audit-verification — Utility Bill Data
   Entry now derives from real building count instead of a flat gated constant, and a Month-1-only
   Audit Report verification/polish block was added) ──────────────────────────────────────────────
   WHY this exists: Matt's ask was to show WHY the monthly EM service hours are needed, not just a
   flat hours×rate total — real setup work (alarm configuration, report setup, trend/graphics
   setup, and — when the client hand-provides them — utility bill data entry) that is heaviest in
   the first few months and tapers to steady-state monitoring, PLUS the recurring contractual
   commitments below that exist for the life of the agreement, not just the ramp-in period.

   2026-07-27 REBUILD REASON (task: "rebuild the EM Services monthly labor model… reflects what the
   SIGNED agreement actually commits CSC to doing every month"): the 2026-07-26 rebuild fixed the
   double-count/fill-the-allowance defects, but a follow-up investigation (grep for "meeting",
   "rebate", "training" → zero hits) found the recurring side of the model was still incomplete: at
   steady state (Month 4+) only Ongoing Monitoring & Optimization (8 hrs) was counted, while three
   contract-mandated recurring commitments were entirely absent, and Utility Bill Data Entry was
   wrongly modeled as a SETUP category that tapers to zero even though bills arrive every month for
   the life of the agreement. Every category below is now explicitly tagged SETUP (ramps to zero
   over 3 months, one-time work) or RECURRING (flat, every month, forever):

     SETUP (ramped, unchanged from the 2026-07-26 rebuild):
       - Alarm Configuration (ALARM_SETUP_HOURS_DEFAULT)
       - Report Setup (REPORT_SETUP_HOURS_DEFAULT)
       - Trend Setup & Configuration (TREND_SETUP_HOURS_DEFAULT)

     RECURRING, ALL DRAWN FROM ONE 16-HR/MONTH BUCKET (correction, same day): the initial
     2026-07-27 version priced Ongoing Monitoring & Optimization at a flat 16 hrs/month IN ADDITION
     TO Monthly Client Review Meeting/Utility Rebate Assistance/Staff Training & Documentation (2
     hrs each), for 22 recurring hrs/month total. Matt corrected this: "I think the 16 hours should
     include the meetings, rebates and training" — the client's "16 hours/month of ongoing
     monitoring for 27 buildings" direction is the ENTIRE recurring EM-labor bucket, not monitoring
     work on top of it. RECURRING_EM_LABOR_HOURS_DEFAULT (=16) is now the single source of truth;
     Ongoing Monitoring & Optimization is whatever remains of that 16 after subtracting the three
     named categories below — it is NEVER an independent constant, so a future 5th recurring
     category added under this bucket automatically shrinks monitoring instead of silently
     inflating the recurring total past 16:
       - Monthly Client Review Meeting — 2 hrs/mo (1 hr meeting + 1 hr prep). Contract: "Monthly
         hourly scheduled meetings to review utility usage, costs, and feedback from the data
         analytics."
       - Utility Rebate Assistance — 2 hrs/mo (bursty work — rebate applications cluster around
         utility program deadlines — averaged to a flat monthly figure here since this breakdown has
         no per-event modeling). Contract explicitly: this time "shall be billed at the applicable
         labor rate and applied against the available labor hours under the Allowance."
       - Staff Training & Documentation — 2 hrs/mo. Contract: "Training to Client staff… updated
         documentation and quick-reference guides."
       - Ongoing Monitoring & Optimization — DERIVED, = RECURRING_EM_LABOR_HOURS_DEFAULT (16) minus
         the three above (6) = 10 hrs/mo. Client direction: "Use 16 hours/month of ongoing
         monitoring for 27 buildings" — read together with the correction above, "ongoing
         monitoring" is the residual of the 16-hr bucket after the three named carve-outs, not a
         separate 16-hr line of its own.

     OUTSIDE the 16-hr bucket, still its own separate RECURRING line — RE-DERIVED 2026-07-27
     fix/labor-bill-entry-and-audit-verification (see note below; this replaces the flat-3hr,
     hasBills-gated version from the same-day correction above):
       - Utility Bill Data Entry — client: "Utility bills becoming labor hours should be able to
         easily estimate based on number of buildings." The PRIOR version was wrong two ways: (1) a
         flat 3 hrs/mo that never scaled with portfolio size, sized off nothing in particular, and
         (2) gated on `_pricingProjectHasUtilityBills` — i.e. it showed ZERO for Johnson County
         today purely because no bills happen to be loaded into this database yet, even though the
         signed agreement commits CSC to this work every month regardless of what's currently on
         file. The labor exists because of the CONTRACT, not the current state of the app's data —
         same reasoning already applied to every other RECURRING category in this bucket. The
         `hasBills` gate is REMOVED entirely; this line now always appears (when the project has any
         building data to size it from) and scales with `_pricingGetBuildingCount(projId)` — the
         SAME building count `buildCatalogRows` above already reads from `collectASHRAE36Data`, so
         this can never drift from the building count shown anywhere else fed by that same source
         (27 for Johnson County today), and campus-wide/non-equipment "buildings" are excluded the
         same way that function already excludes them (a building with zero AUDITABLE equipment rows
         never enters `ashData.buildings` in the first place — see collectASHRAE36Data's
         `auditableRows.length` guard in report-engine.js). Rate:
         BILL_ENTRY_HOURS_PER_BUILDING_DEFAULT = 0.25 hrs/building/mo (15 min — retrieval, entry, and
         a sanity check of that one building's bills), a single named constant so it is tunable in
         one place. At 27 buildings that is 6.75 hrs/mo. This is NOT folded into the 16-hr bucket and
         does NOT shrink Ongoing Monitoring to absorb it — Matt was explicit the client needs to see
         the real number and decide, not have it smoothed away: 16 + 6.75 = 22.75 recurring hrs/mo
         (~$3,936/mo at $173/hr), ~63% of the $6,250/mo allowance BEFORE any hardware/measures dollar
         is spent — close to a ratio Matt already pushed back on once, so this must stay visible, not
         quietly absorbed. OPEN QUESTION, still not settled: whether meters/utility-accounts would be
         a materially better basis than raw building count (e.g. a building with 3 meters plausibly
         takes more entry time than a building with 1) — not adopted here because meter/account data
         is not reliably present across projects the way the building list already is; revisit if
         Matt confirms per-meter billing data is consistently available.

     Considered and NOT added as separate line items (no contract text beyond the quotes above was
     available to this rebuild to size them independently — flagged for Matt to confirm): a
     standalone "Alarm Response" line beyond Alarm Configuration setup, a standalone "Monthly Report
     Generation/Review" line beyond Report Setup, and a standalone "Trend Review & Analysis" line
     beyond Trend Setup & Configuration. Reasoning: the client's own explicit direction sizing the
     recurring EM-labor bucket at 16 hrs/month "for 27 buildings" reads as a portfolio-wide
     operational bucket — the ongoing act of watching alarms, reviewing trends, and keeping reports
     current IS what "ongoing monitoring" (the residual of that bucket) means once the one-time
     setup work is done. Inventing separate hour figures for those three without a contract quote to
     size them against would be exactly the kind of unverified number this rebuild was meant to
     eliminate. If Matt has contract language that specifically breaks these out with their own hour
     commitments, that should be supplied and this function revisited — do not silently split the 16
     hrs into further sub-buckets without that text.

   MONTH 1 ONLY, added 2026-07-27 fix/labor-bill-entry-and-audit-verification (NOT ramped like the
   three SETUP categories above — present at full value in Month 1 and ABSENT in every other month,
   including Month 2/3 of the same ramp): Audit Report verification and client-ready polish. Client,
   re: the generated Audit Report: "It is not 100% polished. The output files still have inconsistent
   layout and formatting… so yes we do need to build in time for verification." He wants this labor
   budgeted explicitly, delivered in Phase 1's first month (August 2026) since that's when the Audit
   Report is generated and handed over. Two separate visible line items, both sized off the real
   document rather than guessed:
     - Report page-count basis: report-engine.js's Audit Report renders one .rpt-page per building
       in the buildingSummaries section (the section that dominates the document's page count — see
       the `s.buildingSummaries` branch a few hundred lines into that file), so building count is a
       defensible proxy for page count: 27 buildings ≈ 27 pages today, matching the "roughly 27
       pages" figure Matt gave. Reuses the SAME `_pricingGetBuildingCount(projId)` this function now
       uses for Bill Entry above — one source of truth, not a second building count that could drift
       from the first.
     - Report Verification & Quality Review — AUDIT_VERIFY_MINUTES_PER_PAGE_DEFAULT = 10 min/page:
       reading the generated output page-by-page against the source equipment/compliance data (27
       buildings, ~1,584 equipment units across them — i.e. real per-building compliance tables, not
       a skim) and correcting errors. 10 min/page is a careful-but-not-exhaustive cross-check pace
       for a data-heavy compliance page, not a proofread. At 27 pages: 4.5 hrs.
     - Final Formatting & Polish — AUDIT_FORMAT_MINUTES_PER_PAGE_DEFAULT = 4 min/page: layout
       consistency, spacing, and presentation pass across the same page count, done AFTER
       verification finds the content errors — a visual/layout skim is materially faster per page
       than a data cross-check, hence the lower per-page rate. At 27 pages: 1.8 hrs.
     Both are named constants (minutes/page), never a single lump-sum guess, so they scale
     automatically if the portfolio's building/page count changes and stay auditable if Matt wants a
     different per-page rate.
   Adding ~6.3 hrs ($1,089.90 at $173/hr) in Month 1 ON TOP OF Month 1's existing SETUP ramp +
   RECURRING bucket pushed Month 1 hours/dollars well past the $6,250/mo allowance on its own before
   the fix/bill-entry-inside-recurring branch reduced the RECURRING bucket to 16 hrs — Month 1 fits
   under cap again today (see the 2026-07-28 addendum immediately below), but this paragraph is left
   intact as the historical record of why a per-month check (added that same day) exists at all: the
   phase-level math ALONE can look fine in aggregate while hiding a single over-cap month, which is
   exactly what happened here once.

   2026-07-28 ADDENDUM (comprehensive-monthly-cap task — supersedes the "No per-month cap assumption
   exists anywhere in that path" sentence that used to close this paragraph, which is no longer
   true): this function's returned `months[i]` entries now carry `laborCost`/`monthlyAllowance`/
   `overCap`/`overageAmount` — a genuine per-month check (EM labor for that month vs. the monthly
   allowance), surfaced non-silently in `_pricingLaborBreakdownHTML` (var(--warn) cell + caption),
   not just a console.error. This IS a labor-only check by construction — see that field's own
   comment block, just above where `months` is built, for why measures/parts dollars are never
   resolved to month granularity anywhere in this file, and why that's a real, documented
   limitation rather than a fabricated split. `_pricingComputeProgramCostModel`
   still sums `_pricingRecurringEMLaborHoursForMonth` across every calendar month IN THE PHASE
   before computing that phase's `emLaborTotal`/`measuresAvailable` (never compares a single month's
   cost against the monthly allowance in isolation on its own), and `measuresAvailable` is
   `Math.max(0, allowanceTotal - emLaborTotal)` — floored at 0, never negative, with an explicit
   `overCommitted` flag (non-silent) when a phase's EM labor ALONE exceeds that phase's calendar
   allowance — this remains a labor-only, phase-granularity flag on THIS return value; the true
   comprehensive (labor + priced measures) over-commit check now lives on
   `_pricingComputeRecommendedTimeline`'s returned `phases[i].overCommitted`, computed once real
   measures dollars are assigned per phase — see that function's header comment.

   This function is READ BY _pricingComputeProgramCostModel to compute `emLaborTotal`/
   `measuresAvailable` per phase — the monthly totals it returns flow into real dollar math and
   intentionally do NOT sum to a fixed cap (Month 1 is now the highest by a wide margin, due to the
   setup ramp AND the Month-1-only Audit Report block above; Month 4+ is the true recurring
   steady-state floor — see the per-month figures in the function below).

   Ramp model (simple 4-step taper — applies ONLY to the three SETUP categories; every RECURRING
   category above is present at full value in every month, Month 1 through steady state; the Audit
   Report block above is a THIRD, separate shape — full value in Month 1 only, zero afterward, never
   ramped):
     Month 1      — 100% of the "setup pool" (Alarm Configuration + Report Setup + Trend Setup)
                    + the Month-1-only Audit Report verification/polish block
     Month 2      —  60% of the setup pool
     Month 3      —  30% of the setup pool
     Month 4+     —   0% (steady state) — only the RECURRING categories remain

   Utility Bill Data Entry now appears in every month a building count can be derived for the
   project (see the RECURRING section above) — it is NO LONGER gated on
   `_pricingProjectHasUtilityBills`; that gate produced a false zero for any project (e.g. Johnson
   County today) that simply hasn't had bills entered into this database yet, even though the
   contract commits to this work regardless.

   Returns null when _pricingComputeMonthlyService returns null (no budget.amount set — same
   silent-until-configured convention as the rest of this feature).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeMonthlyLaborBreakdown(projId) {
  var svc = _pricingComputeMonthlyService(projId);
  if (!svc) return null;
  var hourlyRate = svc.hourlyRate;

  // 2026-07-28 (coordinator instruction, Matt verbatim: "why would you not estimate with whole
  // numbers only?"): every labor-hour figure this function produces must be a WHOLE number, not
  // just at display but at the point it's computed — a displayed whole number hiding a fractional
  // value underneath would make the dollar math (hours x hourlyRate) not match what's shown.
  // Rounding DIRECTION is UP (ceil) everywhere, per Matt's direct follow-up answer ("Always round
  // up") — never round down a labor estimate (never promise less time than the work needs), and
  // never round-to-nearest for some categories and up for others; ceil is applied uniformly to
  // every category below. The underlying per-unit rates (0.25 hrs/building, minutes/page, ramp
  // percentages) are UNCHANGED — this rounds the RESULT of applying those rates, not the rates
  // themselves.
  function ceilHrs(n) {
    return Math.ceil(n);
  }

  // ── SETUP categories (ramp to zero over 3 months — one-time project work) ──
  var ALARM_SETUP_HOURS_DEFAULT = 4;
  var REPORT_SETUP_HOURS_DEFAULT = 3;
  var TREND_SETUP_HOURS_DEFAULT = 3; // 2026-07-26: BAS trend log setup — see comment block above

  // ── RECURRING categories (flat every month, including steady state — see comment block above
  //    for the contract quote / client direction backing each figure) ──
  //
  // RECURRING_EM_LABOR_HOURS_DEFAULT is the single source of truth for the client-directed 16-hr
  // recurring bucket. 2026-07-28 correction (Matt, direct client confirmation): "utility bill data
  // entry goes INSIDE the 16-hour monthly recurring bucket, not on top of it. 16 hours is the
  // ENTIRE recurring allowance." Meeting/Rebate/Training/Bill Entry all come OUT OF the 16, not on
  // top of it. Ongoing Monitoring & Optimization below is DERIVED by subtraction, never its own
  // independent constant, so adding (or growing) a named category here automatically shrinks
  // monitoring instead of silently letting the recurring total drift past 16.
  var RECURRING_EM_LABOR_HOURS_DEFAULT = 16;
  var MEETING_HOURS_DEFAULT = 2; // 2026-07-27: Monthly Client Review Meeting — carved out of the 16
  var REBATE_ASSISTANCE_HOURS_DEFAULT = 2; // 2026-07-27: Utility Rebate Assistance — carved out of the 16
  var TRAINING_DOCS_HOURS_DEFAULT = 2; // 2026-07-27: Staff Training & Documentation — carved out of the 16

  // Utility Bill Data Entry — 2026-07-28: MOVED INSIDE the 16-hr recurring bucket (Matt: "16 hours
  // is the ENTIRE recurring allowance"). Previously this was additive on top of the 16-hr bucket
  // (2026-07-27); it now participates in the same subtraction-from-16 that Meeting/Rebate/Training
  // already used, so adding it shrinks Ongoing Monitoring rather than pushing the recurring total
  // past 16. Still scales with the project's real, campus-wide-excluded building count
  // (`_pricingGetBuildingCount`) — computed here, before the carve-out subtraction below, because it
  // must now be part of that subtraction — so it can never drift from the building count shown
  // elsewhere in the proposal, and is never falsely zeroed just because no bills happen to be
  // loaded into this database yet.
  var BILL_ENTRY_HOURS_PER_BUILDING_DEFAULT = 0.25; // 15 min/building/mo — retrieval + entry + sanity check
  var buildingCount = _pricingGetBuildingCount(projId);
  // 2026-07-28: ceil'd to a whole hour (was 6.75 for 27 buildings at 0.25 hrs/building — see header
  // comment above). Rounding UP here also means the named-carve-out subtraction below (which
  // includes this figure) never leaves a fractional Ongoing Monitoring remainder.
  var BILL_ENTRY_HOURS_DEFAULT = ceilHrs(buildingCount * BILL_ENTRY_HOURS_PER_BUILDING_DEFAULT);

  // 2026-07-27 review fix, still true after the 2026-07-28 change: the subtraction below has no
  // floor on its own — if the named categories (now including Bill Entry) are ever raised, or the
  // project's building count grows enough, their sum can reach or exceed the 16-hr bucket and the
  // naive subtraction goes to zero or NEGATIVE. A negative "Ongoing Monitoring & Optimization"
  // hours figure must never reach a client-facing table or the real dollar math in
  // _pricingComputeProgramCostModel (it would understate labor and overstate the improvement
  // budget on a document going to a county) — so this is Math.max(0, ...)'d AND, when the floor
  // actually engages, loudly logged (never silently swallowed — the floor hides a real
  // over-commitment: the named categories demanding more hours than the bucket contains, which is
  // exactly the kind of thing a human needs to see and fix, not have quietly clamped away).
  var _namedCarveoutHours =
    MEETING_HOURS_DEFAULT + REBATE_ASSISTANCE_HOURS_DEFAULT + TRAINING_DOCS_HOURS_DEFAULT + BILL_ENTRY_HOURS_DEFAULT;
  var _ongoingMonitoringRaw = RECURRING_EM_LABOR_HOURS_DEFAULT - _namedCarveoutHours;
  if (_ongoingMonitoringRaw < 0) {
    console.error(
      '[_pricingComputeMonthlyLaborBreakdown] Recurring EM labor bucket OVER-COMMITTED: ' +
        RECURRING_EM_LABOR_HOURS_DEFAULT +
        ' hr/mo bucket vs. ' +
        _namedCarveoutHours +
        ' hr/mo of named categories (Meeting+Rebate+Training+Bill Entry) — overflow of ' +
        -_ongoingMonitoringRaw +
        ' hr/mo. Ongoing Monitoring & Optimization floored to 0 hrs/mo instead of going negative. ' +
        'This means the named recurring categories alone now exceed the client-directed bucket — ' +
        'review the bucket size or the named category hours, this is not a display bug to ignore.',
    );
  }
  var ONGOING_MONITORING_HOURS_DEFAULT = Math.max(0, _ongoingMonitoringRaw); // residual of the 16, NOT an independent number — floored, never negative

  // Month-1-only Audit Report verification & polish (2026-07-27
  // fix/labor-bill-entry-and-audit-verification — see the header comment above for the full client
  // quote and reasoning). Sized off the same building count, used here as a page-count proxy
  // (report-engine.js's Audit Report renders one page per building in its dominant
  // buildingSummaries section — 27 buildings ≈ 27 pages today). Unaffected by the 2026-07-28
  // bill-entry-inside-the-16 change — this is its own separate one-time shape, not part of the
  // recurring bucket.
  var AUDIT_VERIFY_MINUTES_PER_PAGE_DEFAULT = 10; // data cross-check against source, per page
  var AUDIT_FORMAT_MINUTES_PER_PAGE_DEFAULT = 4; // layout/spacing polish pass, per page
  var auditReportPageEstimate = buildingCount;
  // 2026-07-28: ceil'd to whole hours (was 4.5/1.8 for 27 pages — see header comment above).
  var AUDIT_VERIFY_HOURS_DEFAULT = ceilHrs((auditReportPageEstimate * AUDIT_VERIFY_MINUTES_PER_PAGE_DEFAULT) / 60);
  var AUDIT_FORMAT_HOURS_DEFAULT = ceilHrs((auditReportPageEstimate * AUDIT_FORMAT_MINUTES_PER_PAGE_DEFAULT) / 60);

  var setupPoolHours = ALARM_SETUP_HOURS_DEFAULT + REPORT_SETUP_HOURS_DEFAULT + TREND_SETUP_HOURS_DEFAULT;
  var recurringPoolHours = RECURRING_EM_LABOR_HOURS_DEFAULT; // 2026-07-28: Bill Entry now INSIDE the 16-hr bucket, no longer additive on top of it
  var month1OnlyPoolHours = AUDIT_VERIFY_HOURS_DEFAULT + AUDIT_FORMAT_HOURS_DEFAULT; // Audit Report block — Month 1 only, never ramped

  // rampFraction: how much of the setup pool applies in a given month (1=Month1 … 4=Month4+).
  function rampFraction(monthIdx) {
    if (monthIdx === 1) return 1.0;
    if (monthIdx === 2) return 0.6;
    if (monthIdx === 3) return 0.3;
    return 0; // Month 4+ — steady state, setup pool fully tapered off
  }

  function buildMonthRows(monthIdx) {
    var out = [];
    var frac = rampFraction(monthIdx);
    if (frac > 0) {
      // 2026-07-28: ceil'd to whole hours — the 60%/30% ramp steps (e.g. 4 x 0.6 = 2.4) would
      // otherwise be the largest source of fractional hours in this table (see header comment).
      var alarmHrs = ceilHrs(ALARM_SETUP_HOURS_DEFAULT * frac);
      if (alarmHrs > 0) out.push({ category: 'Alarm Configuration', hours: alarmHrs });
      var reportHrs = ceilHrs(REPORT_SETUP_HOURS_DEFAULT * frac);
      if (reportHrs > 0) out.push({ category: 'Report Setup', hours: reportHrs });
      var trendHrs = ceilHrs(TREND_SETUP_HOURS_DEFAULT * frac);
      if (trendHrs > 0) out.push({ category: 'Trend Setup & Configuration', hours: trendHrs });
    }
    // MONTH-1-ONLY — Audit Report verification & polish. Deliberately NOT run through
    // rampFraction (never 60%/30% in Month 2/3) — this is one-time delivery work tied to when the
    // Audit Report is generated and handed over (Phase 1's first month), not a taper.
    if (monthIdx === 1) {
      if (AUDIT_VERIFY_HOURS_DEFAULT > 0) {
        out.push({ category: 'Audit Report Verification & Quality Review', hours: AUDIT_VERIFY_HOURS_DEFAULT });
      }
      if (AUDIT_FORMAT_HOURS_DEFAULT > 0) {
        out.push({ category: 'Audit Report Final Formatting & Polish', hours: AUDIT_FORMAT_HOURS_DEFAULT });
      }
    }
    // RECURRING — present at full value every month, Month 1 through steady state. NOT scaled by
    // the setup ramp, NOT a remainder that fills any target total (see comment block above).
    // Guarded with the same `> 0` check the SETUP rows above use — if the floor above ever
    // engages (bucket over-committed), a zeroed category disappears from the table instead of
    // printing a nonsense "0 hrs" row; the console.error above is what surfaces the real problem.
    if (ONGOING_MONITORING_HOURS_DEFAULT > 0) {
      out.push({ category: 'Ongoing Monitoring & Optimization', hours: ONGOING_MONITORING_HOURS_DEFAULT });
    }
    // Utility Bill Data Entry — no longer gated on hasBills (see header comment + constant setup
    // above); guarded only by `> 0` so a project with zero derivable buildings (no equipment/ASHRAE
    // data loaded at all) doesn't print a nonsense "0 hrs" row.
    if (BILL_ENTRY_HOURS_DEFAULT > 0) {
      out.push({ category: 'Utility Bill Data Entry', hours: BILL_ENTRY_HOURS_DEFAULT });
    }
    out.push({ category: 'Monthly Client Review Meeting', hours: MEETING_HOURS_DEFAULT });
    out.push({ category: 'Utility Rebate Assistance', hours: REBATE_ASSISTANCE_HOURS_DEFAULT });
    out.push({ category: 'Staff Training & Documentation', hours: TRAINING_DOCS_HOURS_DEFAULT });
    return out;
  }

  // 2026-07-28 (comprehensive-monthly-cap task, item 2 — "Enforce the cap per month, not only per
  // phase"): monthlyAllowance uses _pricingMonthlyAllowanceAmount (the same denomination-normalized
  // $/mo figure the calendar-phase model below uses), NOT svc.allowance (which is budget.amount
  // taken as-is regardless of denomination — correct for JOCO today since its budget is already
  // 'monthly', but would silently compare an annual/quarterly figure against a month's labor for a
  // differently-configured project). Null when no budget.amount is configured — same
  // silent-until-configured convention as the rest of this feature; laborCost/overCap/overageAmount
  // are omitted from each month in that case (nothing to compare against).
  var _budgetForCap = _pricingGetBudget(projId);
  var _monthlyAllowanceForCap = _pricingMonthlyAllowanceAmount(_budgetForCap);

  // KNOWN GRANULARITY LIMIT (documented, not silently assumed away): this per-month check is
  // EM LABOR ONLY — hardware/programming "measures" dollars are never resolved below phase
  // granularity anywhere in this file (a phase can span 5-12 calendar months; there is no
  // month-by-month measures schedule to check against, and inventing an even split across a
  // phase's months would be a fabricated number, not a real one). This is still a real,
  // non-fabricated comprehensive check for what it covers: if EM labor ALONE in a given month
  // already exceeds the monthly allowance, that month is over-cap regardless of what parts are
  // bought that month (labor-only is the floor, not the ceiling, of what a month can cost) — this
  // is exactly the Month-1 defect Matt flagged (39.05 hrs against a 36-hr/$6,250 cap, before any
  // parts). The complementary, TRUE labor+measures comprehensive check lives at PHASE granularity
  // in _pricingComputeRecommendedTimeline/_pricingComputeProgramCostModel below, where real priced
  // measures dollars are actually assigned.
  function buildMonthEntry(label, monthIdx) {
    var rows = buildMonthRows(monthIdx);
    var laborHours = rows.reduce(function (s, r) {
      return s + r.hours;
    }, 0);
    var m = { label: label, rows: rows, laborHours: laborHours };
    if (_monthlyAllowanceForCap != null) {
      var laborCost = Math.round(laborHours * hourlyRate * 100) / 100;
      m.laborCost = laborCost;
      m.monthlyAllowance = _monthlyAllowanceForCap;
      m.overCap = laborCost > _monthlyAllowanceForCap;
      m.overageAmount = m.overCap ? Math.round((laborCost - _monthlyAllowanceForCap) * 100) / 100 : 0;
      if (m.overCap) {
        console.error(
          '[_pricingComputeMonthlyLaborBreakdown] MONTHLY CAP EXCEEDED (labor alone, before any parts): ' +
            label +
            ' — ' +
            laborHours +
            ' hrs x $' +
            hourlyRate +
            '/hr = $' +
            laborCost +
            ' vs $' +
            _monthlyAllowanceForCap +
            '/mo allowance, over by $' +
            m.overageAmount +
            '. Surfaced in the Cost Estimate UI, not silently fixed — see _pricingLaborBreakdownHTML.',
        );
      }
    }
    return m;
  }

  var months = [
    buildMonthEntry('Month 1', 1),
    buildMonthEntry('Month 2', 2),
    buildMonthEntry('Month 3', 3),
    buildMonthEntry('Month 4+ (steady state)', 4),
  ];

  var anyMonthOverCap = months.some(function (m) {
    return m.overCap;
  });

  return {
    hourlyRate: hourlyRate,
    setupPoolHours: setupPoolHours,
    recurringPoolHours: recurringPoolHours,
    month1OnlyPoolHours: month1OnlyPoolHours, // Audit Report verification/polish — Month 1 only, see header comment
    ongoingMonitoringHours: ONGOING_MONITORING_HOURS_DEFAULT,
    buildingCount: buildingCount, // 2026-07-27: single source of truth this breakdown derives Bill Entry + Audit Report hours from
    monthlyAllowance: _monthlyAllowanceForCap, // 2026-07-28: null when no budget.amount configured
    anyMonthOverCap: anyMonthOverCap, // 2026-07-28: true if ANY month's labor-alone cost exceeds monthlyAllowance
    months: months,
  };
}

/* ── Recurring EM labor hours for one absolute calendar month of the program (2026-07-26) ─────
   _pricingComputeMonthlyLaborBreakdown buckets by "months since engagement start" (1/2/3/4+
   steady-state) — this resolves an ABSOLUTE month index (1 = the program's first calendar month,
   climbing across phase boundaries) to that bucket so _pricingComputeProgramCostModel can sum
   real per-month recurring-labor dollars across a whole phase (which may span the Month-1..3 ramp
   AND steady-state months, e.g. Phase 1 = program months 1-5).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingRecurringEMLaborHoursForMonth(bd, absoluteMonthIdx) {
  if (!bd) return 0;
  var idx = Math.min(Math.max(absoluteMonthIdx, 1), 4); // bucket index into bd.months (1,2,3,4=steady)
  var monthRows = bd.months[idx - 1].rows;
  return monthRows.reduce(function (s, r) {
    return s + r.hours;
  }, 0);
}

/* ── Monthly Labor Breakdown table (2026-07-22) ───────────────────────────────────────────────
   Renders _pricingComputeMonthlyLaborBreakdown as a category-by-month matrix table, following the
   site's ch-tbl conventions (ch-tbl-outer/ch-tbl-scroll wrapper, --s1 header, grid-line cells,
   right-aligned numeric columns, tabular-nums) instead of an ad-hoc box/card — matches the site's
   no-boxes-in-reports convention applied to this in-app section as well, per the task spec.
   Returns '' (renders nothing) when no budget.amount is configured, same silent-until-configured
   convention as the rest of the Monthly Service Agreement feature.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingLaborBreakdownHTML(projId) {
  var bd = _pricingComputeMonthlyLaborBreakdown(projId);
  if (!bd) return '';

  // Column order = first-seen order across the 4 months (setup categories appear early, Ongoing
  // Monitoring & Optimization always appears — every month sums to the same monthly total).
  var catOrder = [];
  var catSeen = {};
  bd.months.forEach(function (m) {
    m.rows.forEach(function (r) {
      if (!catSeen[r.category]) {
        catSeen[r.category] = true;
        catOrder.push(r.category);
      }
    });
  });

  var thBase =
    'background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;border-bottom:1px solid var(--border2)';
  var tdBase =
    'padding:6px 10px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);' +
    'font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis';

  var headerCells =
    '<th style="' +
    thBase +
    ';text-align:left">Labor Category</th>' +
    bd.months
      .map(function (m) {
        return '<th style="' + thBase + ';text-align:right">' + _pricingEscText(m.label) + '</th>';
      })
      .join('');

  var bodyRows = catOrder
    .map(function (cat) {
      var cells = bd.months
        .map(function (m) {
          var found = m.rows.filter(function (r) {
            return r.category === cat;
          })[0];
          return (
            '<td style="' +
            tdBase +
            ';text-align:right;white-space:nowrap">' +
            (found ? found.hours + ' hrs' : '—') +
            '</td>'
          );
        })
        .join('');
      return (
        '<tr><td style="' +
        tdBase +
        ';white-space:normal;word-break:break-word;color:var(--text)">' +
        _pricingEscText(cat) +
        '</td>' +
        cells +
        '</tr>'
      );
    })
    .join('');

  // 2026-07-28 (comprehensive-monthly-cap task, item 3 — "Surface violations loudly and visibly…
  // a console.error alone is not enough; this is a client-facing document"): a month whose labor
  // ALONE exceeds the monthly allowance (bd.months[i].overCap, computed in
  // _pricingComputeMonthlyLaborBreakdown) gets its Total-hrs/month cell rendered in var(--warn) with
  // an inline "OVER CAP" tag — same warn-color convention _pricingRecommendedTimelineHTML already
  // uses for the phase-level over-commit note below, so the two "this exceeds the allowance"
  // signals in this file look consistent to a reader who sees both.
  var totalCells = bd.months
    .map(function (m) {
      var sum = m.rows.reduce(function (s, r) {
        return s + r.hours;
      }, 0);
      var overCell = m.overCap;
      return (
        '<td style="padding:6px 10px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;' +
        'border-top:2px solid var(--border2)' +
        (overCell ? ';color:var(--warn)' : '') +
        '">' +
        Math.round(sum * 100) / 100 +
        ' hrs' +
        (overCell ? ' <span style="font-size:9px;font-weight:700">OVER CAP</span>' : '') +
        '</td>'
      );
    })
    .join('');

  // Caption (silent/omitted when no month is over cap — same silent-until-violated convention used
  // elsewhere in this file): names every over-cap month with its labor-only dollar figure and the
  // overage, so the violation is legible without opening devtools console.
  var capCaption = '';
  if (bd.anyMonthOverCap) {
    var overMonths = bd.months.filter(function (m) {
      return m.overCap;
    });
    capCaption =
      '<div style="font-size:10.5px;color:var(--warn);font-weight:700;margin:6px 14px 0;line-height:1.5">' +
      'Monthly cap exceeded (EM labor alone, before any parts/materials): ' +
      overMonths
        .map(function (m) {
          return (
            _pricingEscText(m.label) +
            ' — ' +
            _pricingFmt(m.laborCost) +
            ' vs. ' +
            _pricingFmt(m.monthlyAllowance) +
            '/mo allowance (over by ' +
            _pricingFmt(m.overageAmount) +
            ')'
          );
        })
        .join(' · ') +
      '.' +
      '</div>';
  }

  return (
    '<div style="margin:10px 14px 0;flex-shrink:0">' +
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:11px;text-transform:uppercase;' +
    'letter-spacing:0.5px">Monthly Service Hours — Why These Hours Are Needed</div>' +
    '<div class="ch-tbl-outer" style="margin:0 0 10px;max-height:240px;display:flex;flex-direction:column">' +
    '<div class="ch-tbl-scroll" style="overflow:auto">' +
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%">' +
    '<thead><tr>' +
    headerCells +
    '</tr></thead>' +
    '<tbody>' +
    bodyRows +
    '</tbody>' +
    '<tfoot><tr><td style="padding:6px 10px;font-weight:700;background:var(--s1);border-top:2px solid var(--border2)">' +
    'Total hrs/month</td>' +
    totalCells +
    '</tr></tfoot>' +
    '</table>' +
    '</div>' +
    capCaption +
    '</div>' +
    '</div>'
  );
}

/* ── Budget-vs-total indicator (174ad49a Phase 2) ─────────────────────────────
   Presentation only — compares a tier's ALREADY-COMPUTED grand total (from
   _pricingComputeTotals, read by the caller) against the budget entry. Touches no
   pricing math, no row selection. Returns '' when no budget amount is set, so every
   project that hasn't used this feature sees zero change to its footer. Shared by
   the main tier footer, _pricingRefreshFooter's partial-refresh footer, and the
   Summary sub-tab footer so all three always agree on the wording — same reason
   _pricingTierLabelHTML/_pricingAdvisoryLineHTML above are shared, not copied.
   contextLabel (optional) prefixes the mode label — used by Compare/Summary where
   more than one total is visible in the same footer (e.g. "vs Recommended").

   ceilingOverride (2026-07-26, fix-phase-cost-budget-model — buildRecommendedRows ceiling netting):
   when the caller is showing the RECOMMENDED tier's own total, this widget must compare against
   the SAME ceiling buildRecommendedRows() actually fit membership against — the program-wide
   net-of-labor measures budget (_pricingComputeProgramCostModel(projId).programMeasuresAvailable) —
   not the generic budget.amount x termMonths figure _pricingComputeBudgetTotal returns. Those two
   numbers diverged the moment the membership ceiling was netted against real EM labor: comparing a
   correctly-funded Recommended scope against the OLD term-based figure would show a false "OVER
   budget" alarm here, directly contradicting the accurate Phase Service Allowance timeline table
   rendered right below it. Callers pass null (or omit) for every non-Recommended context
   (Compliance/Full Scope were never fit to any budget ceiling, so the generic term-based
   comparison is still the right — if informal — reference point for them, unchanged from before).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBudgetVsTotalHTML(budget, grandTotal, contextLabel, ceilingOverride) {
  var comp;
  if (ceilingOverride != null && isFinite(ceilingOverride) && ceilingOverride > 0) {
    comp = {
      total: ceilingOverride,
      basisLabel:
        _pricingFmt(ceilingOverride) +
        ' program measures budget (net of EM labor, ' +
        _pricingRecommendedProgramMonths() +
        ' mo)',
    };
  } else {
    comp = _pricingComputeBudgetTotal(budget);
  }
  if (!comp || grandTotal == null) return '';
  var modeLabel =
    (contextLabel ? contextLabel + ' — ' : '') + (budget.mode === 'financing' ? 'Financing' : 'Recurring budget');
  var diff = comp.total - grandTotal; // positive = under budget (room to spare)
  var withinBudget = grandTotal <= comp.total;
  var pct = comp.total > 0 ? Math.abs(diff) / comp.total : 0;
  var stateLabel = withinBudget
    ? 'within budget (' + _pricingFmt(diff) + ' to spare)'
    : Math.round(pct * 100) + '% OVER (' + _pricingFmt(-diff) + ' short)';
  var stateColor = withinBudget ? '#86efac' : 'var(--warn)';
  return (
    '<div style="width:100%;margin-top:6px;padding:6px 10px;background:' +
    (withinBudget ? 'rgba(134,239,172,0.06)' : 'rgba(248,113,113,0.08)') +
    ';border:1px solid ' +
    (withinBudget ? 'rgba(134,239,172,0.2)' : 'var(--warn)') +
    ';border-radius:4px">' +
    '<span style="font-size:11px;font-weight:700;color:var(--text2)">' +
    modeLabel +
    ': ' +
    comp.basisLabel +
    '</span>' +
    '<span style="font-size:11px;font-weight:700;color:' +
    stateColor +
    ';margin-left:8px">' +
    stateLabel +
    '</span>' +
    '</div>'
  );
}

// 45ceb14f: re-derives the full-render path's `_anySavingsShown` boolean from a cached row array,
// without re-rendering any row. Mirrors the two places the full render sets that flag:
//   1. Per-row $/% savings chip (_savingsRangeChipHTML, ~line 3709) — called unconditionally for
//      every row regardless of estimate.rowToggles, so this does NOT need row-toggle state.
//   2. Portfolio-savings rollup (footer step, ~line 4784) — also independent of rowToggles.
// Only meaningful for tier === 'recommended' (the only tier _pricingRefreshFooter still handles
// inline; 'both' and 'full-scope' already delegate to a full initCostEstimateTab re-render, see
// the guard at the top of the patched _pricingRefreshFooter below).
function _pricingComputeAnySavingsShown(rows, annualElecData, fanFraction, elecRate) {
  var hasBills = annualElecData.hasBillData;
  var annKwh = annualElecData.annualKwh;
  var any = false;

  // Mirrors _savingsRangeChipHTML's two branches (lit-range-no-bill-data / $-range-with-bill-data).
  rows.forEach(function (row) {
    if (!(row.seqKey && row.savingsImpact && row.savingsImpact !== 'enabler' && row.savingsImpact !== 'safety')) {
      return;
    }
    if (!hasBills) {
      if (SAVINGS_RANGE_MAP[row.seqKey]) any = true;
      return;
    }
    if (annKwh && SAVINGS_RANGE_MAP[row.seqKey]) {
      var range = _pricingComputeSavingsRange(row, annKwh, fanFraction, elecRate);
      if (range && range.high > 0) any = true;
    }
  });

  // Mirrors the portfolio-rollup loop (footer step, ~line 4784-4794).
  if (hasBills && annKwh) {
    var seenSeqKeys = {};
    rows.forEach(function (r) {
      if (r.phase !== 2 || !r.seqKey || seenSeqKeys[r.seqKey]) return;
      if (!r.savingsImpact || r.savingsImpact === 'enabler' || r.savingsImpact === 'safety') return;
      var pr = _pricingComputeSavingsRange(r, annKwh, fanFraction, elecRate);
      if (pr && pr.high > 0) {
        seenSeqKeys[r.seqKey] = true;
        any = true;
      }
    });
  }

  return any;
}

/* ── Impact badge chip renderer (Recommended tier only) ─────────────────────
   Correction #4: enabler = purple-outline; #5: safety = neutral-grey.
   Correction #15: title attribute shows sourceType label.
   ─────────────────────────────────────────────────────────────────────────── */
function _a36ImpactChip(row) {
  var tier = row.savingsImpact;
  var sourceTypeLabel =
    row.sourceType === SAVINGS_SOURCE_LITERATURE
      ? 'Literature range — verify with M&V'
      : 'Engineering estimate — site-specific calc needed';
  var tooltipSuffix = row.savingsSource ? ' | ' + row.savingsSource + ' | ' + sourceTypeLabel : '';
  if (tier === 'high') {
    return (
      '<span title="HIGH savings impact' +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:#14532d;color:#86efac;white-space:nowrap">HIGH</span>'
    );
  }
  if (tier === 'med-high') {
    return (
      '<span title="MED-HIGH savings impact' +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:#1e3a5f;color:#93c5fd;white-space:nowrap">MED-HIGH</span>'
    );
  }
  if (tier === 'med') {
    return (
      '<span title="MED savings impact' +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:var(--s3);color:var(--text2);white-space:nowrap">MED</span>'
    );
  }
  if (tier === 'low-med') {
    return (
      '<span title="LOW-MED savings impact' +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:var(--s3);color:var(--text3);white-space:nowrap">LOW-MED</span>'
    );
  }
  if (tier === 'enabler') {
    var enablesLabel = row._enablesLabel || 'Supporting Sequence';
    return (
      '<span title="' +
      enablesLabel +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:transparent;color:#a78bfa;border:1px solid #a78bfa;white-space:nowrap">' +
      enablesLabel +
      '</span>'
    );
  }
  if (tier === 'safety') {
    return (
      '<span title="Safety / Compliance — not an energy savings measure' +
      tooltipSuffix +
      '" ' +
      'style="display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'background:var(--s3);color:var(--text3);border:1px solid var(--border);white-space:nowrap">Safety / Compliance</span>'
    );
  }
  return '';
}

/* ── Two-key sort for Recommended tier (correction #3)
   Primary:  impact group order (HIGH > MED-HIGH > MED > LOW-MED > enabler > safety)
   Secondary: weight / effectiveCostTier (higher weight, lower cost = sort earlier)
   Tertiary:  # instances (qty, desc)
   ─────────────────────────────────────────────────────────────────────────── */
var _SAVINGS_TIER_ORDER = { high: 0, 'med-high': 1, med: 2, 'low-med': 3, enabler: 4, safety: 5 };

function _pricingSortRecommendedRows(rows) {
  return rows.slice().sort(function (a, b) {
    // 2026-07-28 (fix/roi-no-hardware-first-per-unit) — PRIMARY key, ahead of the DCV tiebreak
    // below. Matt: "I know I told you to prioritize DCV but we really should be prioritizing
    // sequences that don't require installing sensors first." This REVISES the 2026-07-22 DCV
    // promotion immediately below: DCV still wins every tie it's eligible for, but ONLY within
    // its own hardware-readiness group now — a DCV row that still needs its CO2 sensor installed
    // (_hwGroup 'gap') must never display ahead of a no-hardware-required row (_hwGroup 'ready')
    // of any other measure. Reads the SAME rec._hwGroup buildCatalogRows stamps per unit and
    // _pricingSortUnitsNoHwFirst already uses for MEMBERSHIP ranking (see that function's header
    // comment) — this is the DISPLAY-order counterpart; the two must never silently disagree.
    // Missing _hwGroup (only possible on the defensive "no impactDef" fallback path) is treated
    // as needing hardware (never silently ranked as if it were the easy case).
    var aHw = a._hwGroup === 'ready' ? 0 : 1;
    var bHw = b._hwGroup === 'ready' ? 0 : 1;
    if (aHw !== bHw) return aHw - bHw;
    // 2026-07-22: DCV promotion — demandCtrl/vav_dcv must sort to the top of its hardware-
    // readiness group (see primary key above), ahead of every other measure IN THAT GROUP (not
    // merely ahead of its own tier bucket). An explicit tiebreak here guarantees that outcome
    // regardless of how the weight/effectiveCostTier score below happens to rank against other
    // 'high' tier measures (e.g. ahu_dsp_reset/ahu_sat_reset score higher on that formula alone).
    var aDcv = a.seqKey === 'demandCtrl' || a.seqKey === 'vav_dcv' ? 1 : 0;
    var bDcv = b.seqKey === 'demandCtrl' || b.seqKey === 'vav_dcv' ? 1 : 0;
    if (aDcv !== bDcv) return bDcv - aDcv;
    // Primary: tier group
    var ao = _SAVINGS_TIER_ORDER[a.savingsImpact] != null ? _SAVINGS_TIER_ORDER[a.savingsImpact] : 99;
    var bo = _SAVINGS_TIER_ORDER[b.savingsImpact] != null ? _SAVINGS_TIER_ORDER[b.savingsImpact] : 99;
    if (ao !== bo) return ao - bo;
    // Secondary: weight/effectiveCostTier (higher ratio = better ROI = earlier)
    var aScore = (a._savingsWeight || 0) / Math.max(a._effectiveCostTier || 1, 1);
    var bScore = (b._savingsWeight || 0) / Math.max(b._effectiveCostTier || 1, 1);
    if (Math.abs(aScore - bScore) > 0.0001) return bScore - aScore;
    // Tertiary: # instances (desc)
    return (b.qty || 0) - (a.qty || 0);
  });
}

/* ── Small HTML-escape helper for module-level (non-closure) functions.
   Mirrors the `_esc` closure defined inside initCostEstimateTab — needed here because
   _pricingTopRoiCallout is a standalone top-level function (b771dec6 3b).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingEscText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Top-ROI callout card (correction #12)
   Criteria: HIGH or MED-HIGH tier AND effectiveCostTier <= 2 AND not enabler AND not safety AND >= 1 instance
   Shows 2-4 items; hidden if < 2.
   b771dec6 3b: M&V disclaimer relocated here from the footer (see `showDisclaimer` param).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingTopRoiCallout(projId, recRows, showDisclaimer) {
  var qualifiers = recRows.filter(function (r) {
    return (
      r.phase === 2 &&
      (r.savingsImpact === 'high' || r.savingsImpact === 'med-high') &&
      (r._effectiveCostTier || 2) <= 2 &&
      r.savingsImpact !== 'enabler' &&
      r.savingsImpact !== 'safety' &&
      (r.qty || 0) >= 1
    );
  });
  // Deduplicate by seqKey (keep the first = highest-priority per sort)
  var seen = {};
  var unique = [];
  qualifiers.forEach(function (r) {
    if (!seen[r.seqKey]) {
      seen[r.seqKey] = true;
      unique.push(r);
    }
  });
  // Phase 7 (f33b69be): no cap — show every deduplicated qualifier, not just the first 4.

  // b771dec6 3b: disclaimer body built independent of the `unique.length < 2` gate below,
  // so it is never silently dropped when there are too few qualifying measures to show a list.
  var _disclaimerBodyHTML =
    '<strong style="color:var(--text2)">M&amp;V Disclaimer:</strong> ' + _pricingEscText(SAVINGS_DISCLAIMER_TEXT);

  if (unique.length < 2) {
    if (!showDisclaimer) return '';
    // Lightweight wrapper — no items to list, but the disclaimer still surfaces (edge case).
    return (
      '<div style="margin:10px 14px 0;padding:8px 12px;border:1px solid var(--border2);' +
      'border-radius:6px;background:var(--s3);font-size:10px;color:var(--text3);line-height:1.5">' +
      _disclaimerBodyHTML +
      '</div>'
    );
  }

  // DCV merge: if both demandCtrl and vav_dcv qualify, show one merged line.
  // Decide the merge BEFORE the loop so order of appearance does not matter (Bug C fix).
  var hasDemand = unique.some(function (r) {
    return r.seqKey === 'demandCtrl';
  });
  var hasDcv = unique.some(function (r) {
    return r.seqKey === 'vav_dcv';
  });
  var mergeDcv = hasDemand && hasDcv; // pre-decision: vav_dcv is always suppressed when demandCtrl is present
  var displayRows = [];
  var dcvMerged = false;
  unique.forEach(function (r) {
    if (r.seqKey === 'vav_dcv' && mergeDcv) {
      // always skip vav_dcv when demandCtrl is present (regardless of iteration order)
      return;
    }
    if (r.seqKey === 'demandCtrl' && mergeDcv && !dcvMerged) {
      dcvMerged = true;
      displayRows.push({ label: 'Demand-Controlled Ventilation (AHU + Zone)', row: r });
      return;
    }
    displayRows.push({ label: r.item, row: r });
  });

  var itemsHTML = displayRows
    .map(function (entry) {
      var r = entry.row;
      var chip = _a36ImpactChip(r);
      var costNote =
        r._effectiveCostTier === 1
          ? '<span style="font-size:10px;color:#86efac;margin-left:6px">Programming only</span>'
          : '<span style="font-size:10px;color:var(--text3);margin-left:6px">+sensor(s)</span>';
      // b771dec6 2b: prefer clientSummary (already stamped by buildRecommendedRows) over savingsRationale
      var _summaryText = r.clientSummary || r.savingsRationale || '';
      return (
        '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;' +
        'border-bottom:1px solid rgba(255,255,255,0.07)">' +
        '<div style="flex-shrink:0;margin-top:1px">' +
        chip +
        costNote +
        '</div>' +
        '<div>' +
        '<div style="font-size:11px;font-weight:600;color:var(--text)">' +
        entry.label +
        '</div>' +
        '<div style="font-size:10px;color:var(--text2);margin-top:2px;line-height:1.5">' +
        _summaryText.slice(0, 160) +
        (_summaryText.length > 160 ? '…' : '') +
        '</div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  var _roiChevronId = 'roi-chevron-' + projId;
  var _roiOpen = _pricingGetRoiOpen(projId); // b771dec6 2a: collapsed by default, persisted per-project
  // b771dec6 3b: disclaimer appended inside the card body (was previously in the table footer)
  var _disclaimerHTML = showDisclaimer
    ? '<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border);' +
      'font-size:10px;color:var(--text3);line-height:1.5">' +
      _disclaimerBodyHTML +
      '</div>'
    : '';
  return (
    '<details' +
    (_roiOpen ? ' open' : '') +
    ' style="margin:10px 14px 0;border:1px solid var(--border2);border-radius:6px;' +
    'background:var(--s3);overflow:hidden"' +
    ' ontoggle="(function(d){_pricingSetRoiOpen(' +
    JSON.stringify(projId) +
    ", d.open);var c=document.getElementById('" +
    _roiChevronId +
    "');if(c)c.textContent=d.open?'▼':'▶';})(this)\">" +
    '<summary style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text);' +
    'cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;' +
    'background:var(--s2);border-bottom:1px solid var(--border2)">' +
    '<span id="' +
    _roiChevronId +
    '" style="font-size:10px;color:var(--text2);flex-shrink:0">' +
    (_roiOpen ? '▼' : '▶') +
    '</span>' +
    '★ Top ROI Measures for This Project' +
    '<span style="font-size:10px;font-weight:400;color:var(--text2);margin-left:4px">' +
    '(full detail for every item is in the table below)</span>' +
    '</summary>' +
    '<div style="padding:4px 12px 8px">' +
    itemsHTML +
    _disclaimerHTML +
    '</div>' +
    '</details>'
  );
}

/* ── SKU → config defaults (spec §3) ──
   Fields:
     defaultSku  — catalog SKU (or null for NO-SKU)
     qtyRule     — 'perUnit'|'perBuilding'|'perZone'|'comboZone'
     flags       — array of 'engReview'|'noSku'|'ioOnly'|'comboWith'
     comboWith   — (optional) point key this can combo with
     note        — display note
  ─────────────────────────────────────────────────────────────────────────── */
const PRICE_POINT_MAP = {
  /* ── AHU/RTU sensors ── */
  sat: {
    defaultSku: 'N1-10K-2-D-8-BB-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSB duct temp, 8" probe — verify probe length',
    whyNeeded: 'Required for supply air temperature reset, reducing heating and cooling energy based on actual demand.',
    g36Section: '§5.16.1',
  },
  rat: {
    defaultSku: 'N1-10K-2-D-8-BB-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSB duct temp, 8" probe — verify probe length',
    whyNeeded:
      'Measures return air temperature, providing feedback on how effectively the system conditions the building.',
    g36Section: '§5.16.1',
  },
  mat: {
    defaultSku: 'N1-10K-2-D-8-BB-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSB duct temp, 8" probe — verify probe length',
    whyNeeded: 'Required for economizer control — enables the system to use outdoor air instead of mechanical cooling.',
    g36Section: '§5.16.2',
  },
  oat: {
    defaultSku: 'N1-10K-2-D-12-WP-A',
    qtyRule: 'perBuilding', // de-dup: 1 per building
    flags: ['engReview'],
    note: 'Weatherproof OAT — 1 per building',
    whyNeeded:
      'Required for nearly every energy-saving sequence; without it, the system cannot adapt to changing weather.',
    g36Section: '§5.1',
  },
  dsp: {
    defaultSku: 'N1-ZPS-LR-EZ-NT-IN-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Low-range duct static pressure — verify range',
    whyNeeded:
      'Enables fan speed control based on actual demand; fan energy drops 15–30% versus fixed-speed operation.',
    g36Section: '§5.16.5',
  },
  co2_ahu: {
    defaultSku: 'N1-DCD10-D-BB-LED-A',
    qtyRule: 'perUnit',
    flags: [],
    note: 'AHU duct CO2 sensor',
    whyNeeded:
      'Reduces outdoor air intake to match actual occupancy, cutting fan and cooling energy by 5–10% when rooms are empty.',
    g36Section: '§5.16.7',
  },
  /* ── VAV/FPB sensors ── */
  dat: {
    defaultSku: 'N1-10K-2-D-4-BB-A',
    qtyRule: 'perUnit',
    flags: [],
    note: '4" duct temp probe',
    whyNeeded:
      'Monitors delivered air temperature, enabling precise reheat control and preventing overcooling at minimum airflow.',
    g36Section: '§5.6.1',
  },
  /* ── Plant/CT sensors ── */
  hwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Required for boiler control and the outdoor reset strategy that lowers water temperature as outdoor air warms.',
    g36Section: '§5.20.1',
  },
  hwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Measures temperature drop across the heating system; a low reading signals pump, balancing, or coil problems.',
    g36Section: '§5.20.1',
  },
  chwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded: 'Verifies chiller output; enables the setpoint reset strategy that improves chiller efficiency.',
    g36Section: '§5.22.1',
  },
  chwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded: 'Poor chilled water utilization causes the chiller to over-cycle and consume excess energy.',
    g36Section: '§5.22.1',
  },
  cwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Required for cooling tower control and the condenser water reset strategy that improves chiller efficiency.',
    g36Section: '§5.24.1',
  },
  cwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Measures heat rejected through the cooling tower; a low temperature drop signals tower, chiller, or pumping problems.',
    g36Section: '§5.24.1',
  },
  hwdp: {
    defaultSku: 'N2-A/WPR2-30-M20-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSA wet DP 0-30 PSID — verify range',
    whyNeeded: 'Allows the pump to slow when fewer zones call for heat rather than running at full design speed.',
    g36Section: '§5.20.3',
  },
  chwdp: {
    defaultSku: 'N2-A/WPR2-30-M20-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSA wet DP 0-30 PSID — verify range',
    whyNeeded: 'Allows chilled water pumps to slow during light loads; pump energy drops sharply with speed.',
    g36Section: '§5.22.3',
  },
  oaWetBulb: {
    defaultSku: 'N1-10K-2-H200-O-BB-A',
    qtyRule: 'perBuilding',
    flags: ['engReview'],
    note: 'OA humidity+temp combo — 1 per building',
    whyNeeded: 'Measures outdoor temperature and humidity for the most accurate economizer control.',
    g36Section: '§5.16.2',
  },
  /* ── Zone sensors ── */
  zoneTemp: {
    defaultSku: 'ZS2-ALC',
    qtyRule: 'perUnit',
    flags: ['comboWith'],
    comboWith: 'co2',
    note: 'Zone temp wall sensor — combos with CO2 zone sensor',
    whyNeeded:
      'The required feedback signal for zone control; without it, airflow cannot be modulated to meet setpoints.',
    g36Section: '§5.6.1', // fallback (VAV single-duct)
    // Per-equipment-category G36 section overrides (source: ASHRAE 36-2021 table of contents)
    // vav=§5.6 (single-duct terminal units), fpb=§5.7 (fan-powered boxes),
    // ddvav=§5.13 (dual-duct terminal units), fcu=§5.22 (fan coil units)
    g36SectionByCategory: {
      vav: '§5.6.1',
      fpb: '§5.7',
      ddvav: '§5.13',
      fcu: '§5.22',
    },
  },
  co2_zone: {
    defaultSku: 'ZS2-HC-ALC',
    qtyRule: 'comboZone', // de-dup: if zoneTemp also missing, ZS2-HC-ALC covers both
    flags: [],
    // ZS2-HC-ALC is the actual physical device: the base ZS2-ALC zone wall sensor with the "H"
    // (Humidity) + "C" (CO2) options added — one sensor, one install, reading zone temperature,
    // relative humidity, AND CO2 together. Investigation 2026-07-22 (Matt's feedback: the Cost
    // Estimate read as disconnected sensor line items with no combined Temp/Hum/CO2 zone sensor):
    // this SKU was ALREADY the combo charged whenever both zoneTemp and CO2 are gaps on the same
    // zone (see the combo de-dup logic in buildCatalogRows) — this is a label/description fix to
    // match what the hardware already is, not a new part number or a pricing change.
    note: 'Zone Temp/Humidity/CO2 sensor — one physical device, replaces separate zone temp + CO2 sensors when both are missing',
    whyNeeded:
      'One wall sensor reads zone temperature, relative humidity, and CO2 in a single install — the temperature feedback zone control requires, plus the occupancy signal for demand-controlled ventilation.',
    g36Section: '§5.6.7',
  },
  // co2_zone_standalone (2026-07-28, audit-finding correction): a STANDALONE zone CO2 room sensor
  // for the case where the zone's temperature sensor is ALREADY present and only CO2 is missing —
  // 658 of 685 real zone-side CO2 gaps in the JOCO portfolio are this case. Before this entry
  // existed, buildCatalogRows fell through to the co2_zone COMBO entry above (ZS2-HC-ALC) for these
  // too, which prices replacing a working temperature sensor just to add CO2 — a real overcharge.
  // N1-AQX-C-A is a real, distinct catalog SKU (verified present: list $914, contract $365.60 at
  // COST_CONTRACT_PCT=0.4) — a dedicated CO2-only room sensor, not a temp/humidity/CO2 combo.
  co2_zone_standalone: {
    defaultSku: 'N1-AQX-C-A',
    qtyRule: 'perUnit',
    flags: [],
    note: 'Standalone CO2 room sensor — zone already has a working temp sensor',
    whyNeeded:
      'Provides the occupancy signal (CO2 ppm) for demand-controlled ventilation without replacing an already-working zone temperature sensor.',
    g36Section: '§5.6.7',
  },
  // occSensor (2026-07-28, fix/zone-sku-from-existing-points): fixes the dormant PRICE_POINT_MAP
  // hole for the 'occSensor' category — the IDENTICAL dead-code shape as the co2 bug fixed
  // 2026-07-27 (see the P0 FIX comment in buildCatalogRows below). occSensor becomes a genuine
  // hardware gap only when a user explicitly flags a VAV/DD-VAV unit hasOccSensor:true
  // (EM_EQUIP_CONFIG_FLAGS, default:false — Matt: "occupancy sensor is not usually something
  // recommended unless they already have it or want it") AND no occupancy point was matched.
  // Before this entry existed, that gap hit PRICE_POINT_MAP's `if (!mapEntry) return;` guard in
  // buildCatalogRows and silently vanished from every tier — same failure mode as the co2 bug,
  // just gated behind a manual per-unit flag so it never fired on real (unedited) JOCO data.
  // ZS2-M-ALC (verified present in en_pricing_catalog: list $610, desc 'Std Temp Motion ALC') is
  // the cheapest catalog device carrying an occupancy/motion sensor — engReview flagged because
  // the zone's existing wall sensor (already accounted for by its own zoneTemp/co2_zone gap row,
  // if any) may or may not be the same physical unit being augmented with occupancy.
  occSensor: {
    defaultSku: 'ZS2-M-ALC',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Occupancy/motion sensor — verify against existing zone wall sensor before ordering',
    whyNeeded:
      'Occupancy sensing lets the zone controller use unoccupied setback more aggressively than a schedule alone, cutting reheat and fan energy when a scheduled-occupied room is actually empty.',
    g36Section: '§3.1.5',
  },
  /* ── AHU actuators ── */
  oaDampCmd: {
    defaultSku: 'AFB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb spring-return — verify torque',
    // PART 2: why-needed rationale + G36 reference
    whyNeeded:
      'Controls outdoor air volume for ventilation and free cooling; without it, economizer operation is not possible.',
    whyNotHardware:
      'Verify: the AHU may already have a modulating damper actuator (then this is a point-exposure/programming gap) vs genuinely needing a new actuator.',
    g36Section: '§5.16',
  },
  raDampCmd: {
    defaultSku: 'AFB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb spring-return — verify torque',
    // PART 2: why-needed rationale + G36 reference
    whyNeeded:
      'Works with the outdoor air damper to maintain airflow balance and prevent over-pressurization during free cooling.',
    whyNotHardware:
      'Verify: the AHU may already have a modulating damper actuator (then this is a point-exposure/programming gap) vs genuinely needing a new actuator.',
    g36Section: '§5.16',
  },
  // damperPositionControl: consolidated report/summary line item for oaDampCmd + raDampCmd (Matt,
  // 2026-07-27: "Why would you split up damper position control? Don't do that in these kind of
  // reports and summaries.") — same SKU/price/install-hours as either individual key (they're the
  // same physical actuator part), just grouped under one label so a building missing both OA and
  // RA damper control shows ONE "damper actuators" line instead of two identically-priced rows.
  // See the merge logic in buildCatalogRows (search 'Damper Position Control consolidation').
  damperPositionControl: {
    defaultSku: 'AFB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb spring-return — verify torque',
    whyNeeded:
      'Controls outdoor air and return air damper position together for economizer operation and free-cooling airflow balance; without it, economizer operation is not possible.',
    whyNotHardware:
      'Verify: the AHU may already have modulating damper actuators (then this is a point-exposure/programming gap) vs genuinely needing new actuators.',
    g36Section: '§5.16',
  },
  /* ── VAV/FPB/DDVAV actuators ──
     dampCmd / coldDampCmd / hotDampCmd are classified ioOnly (Phase 2 programming, $0 hardware).
     Rationale: VAV/VVT terminal boxes have integral factory-installed actuators commanded over
     the internal bus. A missing dampCmd BACnet point is a control point-exposure gap, not
     missing hardware. Add an actuator SKU (AFRB24-MFT-06-A) only if field inspection confirms
     a pneumatic or failed actuator. (Investigation 2026-06-19: JOCO Courthouse 378/378 VAVs
     are Carrier VVT — no dampCmd BACnet point; mapping to new ~$44 actuators overstated ~$16.6k.) */
  dampCmd: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['ioOnly'],
    note: 'Phase 2 programming — not new hardware for VVT/integral-actuator boxes',
    whyNeeded:
      'Modulates conditioned air delivery to meet zone temperature setpoints and maintain minimum ventilation requirements.',
    whyNotHardware: 'Terminal unit actuator is integral; this is a programming task, not new hardware.',
    g36Section: '§5.6',
  },
  coldDampCmd: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['ioOnly'],
    note: 'Phase 2 programming — not new hardware for dual-duct VVT/integral-actuator boxes',
    whyNeeded:
      'Controls cool air delivery in a dual-duct system; without it, simultaneous heating and cooling cannot be prevented.',
    whyNotHardware: 'Terminal unit actuator is integral; this is a programming task, not new hardware.',
    g36Section: '§5.6',
  },
  hotDampCmd: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['ioOnly'],
    note: 'Phase 2 programming — not new hardware for dual-duct VVT/integral-actuator boxes',
    whyNeeded:
      'Controls warm air in a dual-duct system; both deck dampers must coordinate to prevent simultaneous heating and cooling.',
    whyNotHardware: 'Terminal unit actuator is integral; this is a programming task, not new hardware.',
    g36Section: '§5.6',
  },
  /* ── Plant valve actuators ── */
  chwIsoValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Controls chilled water flow to individual chillers; required for safe staging, lead/lag rotation, and preventing recirculation.',
    g36Section: '§5.22',
  },
  cwIsoValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Controls condenser water flow to individual cooling towers; required for safe tower staging and preventing recirculation.',
    g36Section: '§5.24',
  },
  makeupValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Automatically refills the cooling tower basin when level drops; prevents pump cavitation and maintains water balance.',
    g36Section: '§5.24',
  },
  /* ── Coil valves (ENG-REVIEW — spec §3, §4 optimizer must skip) ── */
  clgValve: {
    defaultSku: 'B214+TFRB-3-06-A', // VERIFIED in catalog (Cv7.4 spring-return)
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.75" 2-way Cv7.4 spring-return — ENG-REVIEW: verify Cv and pipe size',
    whyNeeded:
      'Controls chilled water flow through the cooling coil; required for temperature reset and economizer coordination.',
    g36Section: '§5.16.3',
  },
  htgValve: {
    defaultSku: 'B214+TFRB-3-06-A', // VERIFIED in catalog
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.75" 2-way Cv7.4 spring-return — ENG-REVIEW: verify Cv and pipe size',
    whyNeeded:
      'Controls hot water flow through the heating coil; required for morning warm-up, freeze protection, and supply air control.',
    g36Section: '§5.16.3',
  },
  reheatValve: {
    defaultSku: 'B209+TFRB-3-06-A', // VERIFIED in catalog
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.5" Cv0.8 spring-return — ENG-REVIEW: verify Cv',
    whyNeeded:
      'Controls the terminal reheat coil; without it, zone heating must come from the primary air system at higher cost.',
    g36Section: '§5.6.4',
  },
  /* ── VAV zone controller (discFlow/primaryFlow maps to controller, not sensor) ── */
  discFlow: {
    defaultSku: 'OF253A-E2',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'VAV zone controller w/ integral flow — ENG-REVIEW: verify if controller replacement or reprogramming only',
    whyNeeded:
      'Confirms minimum ventilation to each zone and enables the duct static pressure reset sequence; both require measured airflow.',
    g36Section: '§5.6.2',
  },
  primaryFlow: {
    defaultSku: 'OF253A-E2',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'FPB zone controller w/ integral flow — ENG-REVIEW: verify if controller replacement or reprogramming only',
    whyNeeded:
      'Measures cold primary air delivered to the terminal, driving damper modulation and local fan operation.',
    g36Section: '§5.8.2',
  },
  /* ── I/O Only ($0) ── */
  sfStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  sfSpeed: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  sfEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  sfSpeedCmd: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  coolSP: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  htgSP: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  fanStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  termFanStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  termFanEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  boilerStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  boilerEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  hwSetpoint: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  hwPumpStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  hwPumpEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  hwPumpSpeed: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  chillerStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  chillerEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  chwSetpoint: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  pchwpStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  schwpStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  schwpSpeed: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  chwIsoValveStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  pchwpEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  schwpEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  ctFanStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  cwPumpStatus: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  ctFanEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  cwPumpEnable: { defaultSku: null, qtyRule: 'perUnit', flags: ['ioOnly'], note: 'Controller I/O' },
  /* ── NO-SKU (manual price) ── */
  freezeStat: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['noSku'],
    note: 'Mechanical freeze stat — enter price (~$150 typical)',
    whyNeeded:
      'Triggers air handler shutdown when coil temperatures approach freezing, preventing costly water coil damage.',
    g36Section: '§5.16.12',
  },
  oaFlow: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['noSku'],
    note: 'OA flow station — enter price (~$1,200 typical)',
    whyNeeded:
      'Measures actual outdoor air volume; without it, code-required minimum ventilation rates cannot be confirmed.',
    g36Section: '§5.16.7',
  },
};

/* ── CSV parser (spec §7)
   Handles: SKU, List Price, Net, Contract, Category, Short Description, Note
   Quoted fields with commas inside are supported (RFC 4180 subset).
   ─────────────────────────────────────────────────────────────────────────── */
function parsePricingCSV(text) {
  var lines = text.split(/\r?\n/);
  if (!lines.length) return null;

  // Parse one CSV line respecting double-quoted fields
  function parseCSVLine(line) {
    var result = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuote = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  // Find header row — first row with a cell that looks like "SKU"
  var headerIdx = -1;
  var colSKU = -1,
    colList = -1,
    colNet = -1,
    colContract = -1,
    colCat = -1,
    colDesc = -1,
    colNote = -1;

  for (var h = 0; h < Math.min(5, lines.length); h++) {
    var hcells = parseCSVLine(lines[h]);
    for (var ci = 0; ci < hcells.length; ci++) {
      var hv = hcells[ci].replace(/﻿/g, '').toLowerCase().trim();
      if (hv === 'sku' || hv === 'part number' || hv === 'part no') {
        headerIdx = h;
        colSKU = ci;
        break;
      }
    }
    if (headerIdx >= 0) {
      // Map remaining columns
      hcells.forEach(function (cell, ci) {
        var v = cell.toLowerCase().replace(/[^a-z]/g, '');
        if (v === 'listprice' || v === 'list') colList = ci;
        else if (v === 'net' || v === 'netprice') colNet = ci;
        else if (v === 'contract' || v === 'contractprice') colContract = ci;
        else if (v === 'category' || v === 'cat') colCat = ci;
        else if (v === 'shortdescription' || v === 'description' || v === 'desc') colDesc = ci;
        else if (v === 'note' || v === 'notes') colNote = ci;
      });
      break;
    }
  }

  if (colSKU < 0) return null; // No SKU column found

  var catalog = {};
  var skuCount = 0;

  for (var r = headerIdx + 1; r < lines.length; r++) {
    var line = lines[r].trim();
    if (!line) continue;
    var cells = parseCSVLine(line);
    var sku = colSKU >= 0 ? (cells[colSKU] || '').trim() : '';
    if (!sku) continue;

    var listRaw = colList >= 0 ? cells[colList] || '' : '';
    var netRaw = colNet >= 0 ? cells[colNet] || '' : '';
    var contractRaw = colContract >= 0 ? cells[colContract] || '' : '';

    function parsePrice(s) {
      var n = parseFloat(String(s).replace(/[$,\s]/g, ''));
      return isNaN(n) ? null : n;
    }

    var list = parsePrice(listRaw);
    var netCSV = parsePrice(netRaw);
    var contract = parsePrice(contractRaw);

    if (list === null && netCSV === null && contract === null) continue; // skip non-priced rows

    skuCount++;
    catalog[sku] = {
      list: list,
      net: netCSV, // null if CSV Net absent or zero
      contract: contract,
      computed_net: null, // filled below
      category: colCat >= 0 ? (cells[colCat] || '').trim() : '',
      desc: colDesc >= 0 ? (cells[colDesc] || '').trim() : '',
      note: colNote >= 0 ? (cells[colNote] || '').trim() : '',
    };
  }

  // Apply net multiplier from config (spec §7)
  var cfg = _pricingGetConfig();
  Object.keys(catalog).forEach(function (sku) {
    var entry = catalog[sku];
    if (entry.list !== null) {
      entry.computed_net = parseFloat((cfg.netMultiplier * entry.list).toFixed(2));
      // If CSV Net is absent or 0, use computed net as canonical net
      if (!entry.net) entry.net = entry.computed_net;
    }
  });

  // Store
  sset('en_pricing_catalog', catalog);
  sset('en_pricing_meta', {
    importedAt: new Date().toISOString(),
    filename: '',
    skuCount: skuCount,
  });

  return { catalog: catalog, skuCount: skuCount };
}

/* ── Config helpers ── */
function _pricingGetConfig() {
  var stored = sget('en_pricing_config', null);
  var dflt = {
    netMultiplier: COST_NET_MULTIPLIER_DEFAULT,
    contractPct: COST_CONTRACT_PCT,
    hourlyRate: COST_LABOR_RATE_DEFAULT,
    priceBasis: 'contract',
    perSequenceHours: Object.assign({}, COST_PER_SEQ_HOURS_DEFAULT),
    fanFraction: FAN_FRACTION_DEFAULT, // Step 5: fan energy as % of total elec (CBECS 10–20%)
    // installLaborRate removed (2026-07-28, unified labor rate) — install labor now reads the
    // same hourlyRate above as programming labor. A stale installLaborRate key left over in an
    // existing project's stored en_pricing_config from before this change is harmless — nothing
    // reads it anymore.
    installHoursByPoint: Object.assign({}, INSTALL_HOURS_BY_POINT_DEFAULT), // Deliverable E
  };
  if (!stored) return dflt;
  // Merge defaults for any missing keys
  return Object.assign(dflt, stored);
}
function _pricingSetConfig(updates) {
  var cfg = _pricingGetConfig();
  Object.assign(cfg, updates);
  sset('en_pricing_config', cfg);
}

/* ── Get estimate state (row toggles, manual prices) ── */
function _pricingGetEstimate(projId) {
  var stored = sget('en_pricing_estimate_' + projId, null);
  return (
    stored || {
      rowToggles: {},
      manualPrices: {},
      laborOverrides: {},
      installHoursOverrides: {}, // Deliverable E — per-point-key install-hours override, mirrors laborOverrides
      qtyOverrides: {},
      noteOverrides: {},
      tier: 'compliance',
    }
  );
}
function _pricingSetEstimate(projId, est) {
  sset('en_pricing_estimate_' + projId, est);
}

/* ── Top ROI card open/collapsed persistence (b771dec6 2a) — defaults collapsed ── */
function _pricingGetRoiOpen(projId) {
  var est = _pricingGetEstimate(projId);
  return !!est.roiOpen;
}
function _pricingSetRoiOpen(projId, open) {
  var est = _pricingGetEstimate(projId);
  est.roiOpen = !!open;
  _pricingSetEstimate(projId, est);
}

/* ── _pricingIsMonitoringOnlyZoneUnit(eq) ─────────────────────────────────────────────────────
   2026-07-27 (Matt, repeated — see the buildCatalogRows/buildOptionalPointRows call sites for the
   "we talked about this already" investigation note): "The units not having Zone cooling/heating
   setpoint still makes no sense and should not be included, we talked about this already, those
   are most likely locally controlled units and it's monitoring only."

   Signal used: eq.compliance.missingPoints containing BOTH 'coolSP' AND 'htgSP' — the SAME
   required-category-gap data buildCatalogRows already reads for every other hardware row (not a
   new detection mechanism, not a heuristic over free-text notes). Verified against EM_POINT_
   CATEGORIES (equipment-matrix.js): coolSP/htgSP are `required: true` for vav/fpb/ddvav/furnace/
   zone (the equip types this predicate actually fires for in practice — 'zone' terminal boxes) and
   `required: false` for fcu and a couple of other types, so those never populate missingPoints for
   these keys and this predicate never fires a false-positive exclusion for them; it only ever
   excludes equipment where the zone setpoint really is a required-but-absent point.

   A unit missing BOTH is a unit you cannot write a setpoint to at all — it is locally controlled
   (a local stat) and monitoring-only for BAS purposes; no zone-level ASHRAE-36 sequence
   (vav_zone_temp, vav_reheat, vav_dcv, damper write-back) can legitimately be sold for it, and
   installing new zone sensors for it would price hardware nobody can act on. Excluding it happens
   ONE LEVEL UP from any single hardware/sequence key — the equipment is dropped entirely from
   buildCatalogRows'/buildOptionalPointRows' per-building equipment list before any row is
   generated, so this interacts cleanly with the CO2 remap fix (2026-07-27, same branch): a
   monitoring-only unit that also happens to be missing CO2 gets NEITHER a CO2 hardware row NOR DCV
   programming labor, rather than one fix pricing hardware the other fix would have excluded, or
   vice versa — there is one filter, applied once, before both row-generation passes read the
   equipment list.

   PRIOR-FIX CHECK (per task instruction to determine whether "we talked about this already" was
   ever acted on): grepped this file's git history and the current source for any existing gate on
   coolSP/htgSP absence prior to this change — none exists. buildCatalogRows/buildRecommendedRows
   priced vav_zone_temp programming (and every other zone-level sequence) for these units
   unconditionally before this fix. This is a NEW fix, not a regression of a prior one — the
   "already talked about this" was 8ea3ca72 (2026-07-09), which is a DIFFERENT, narrower decision:
   it removed coolSP/htgSP from vav_zone_temp's own SEQUENCE READINESS requiredCats/keyCats in
   equipment-matrix.js (the Equipment Matrix audit view) specifically to stop a false "Not Ready"
   for ~219 of 719 VAV rows on Carrier VVT terminals, where the zone setpoint genuinely lives at
   the VVT master controller rather than exposed per-terminal — those terminals ARE still
   BAS-controlled (the master writes the setpoint), just not exposed at the granularity this
   equipment-matrix.js field tracks. That decision is intentionally left untouched here (this
   predicate does not read or change eq.seqReadiness/emComputeSequenceReadiness at all) so the
   Equipment Matrix audit view keeps its VVT fix. This predicate operates one layer up, in the
   PRICING/PROPOSAL generators only, using the raw missingPoints hardware-gap signal — a unit could
   in principle be a VVT terminal (audit view: vav_zone_temp shows "Ready") while ALSO genuinely
   lacking both coolSP and htgSP hardware-gap entries for other reasons; Matt's literal instruction
   is scoped to "not having zone cooling/heating setpoint", so this predicate follows that literally
   rather than trying to infer VVT-vs-local-stat from data this codebase does not capture. Flagged
   for Matt: if some of the excluded units turn out to be VVT terminals rather than local stats, the
   predicate may need a VVT-aware carve-out — not assumed here since no such signal exists in the
   real data today.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingIsMonitoringOnlyZoneUnit(eq) {
  var missing = {};
  ((eq && eq.compliance && eq.compliance.missingPoints) || []).forEach(function (mp) {
    missing[mp.categoryKey] = true;
  });
  return !!(missing.coolSP && missing.htgSP);
}

/* ── _pricingDetectZoneFeatures(eq) — fix/zone-sku-from-existing-points (2026-07-28) ─────────
   Reads eq.compliance.coveredPoints — the SAME already-computed point-match list
   buildOptionalPointRows already trusts as its source of truth for "is this category present
   on this equipment" (see that function's header comment) — and reports which zone-sensor
   features the zone's EXISTING points reveal. This does NOT re-implement point matching; it
   only reads emComputeCompliance's output, which is now reachable here because
   EM_POINT_CATEGORIES.vav/fpb/ddvav were widened (equipment-matrix.js, same commit) to track
   zoneHumidity/coolAdj/htgAdj as non-required categories. Before that widening, these raw BAS
   points existed in the data (EM_POINT_MAP already routes them — see 'zoneRelativeHumidity',
   'zoneCoolAdjust', 'zoneHtgAdjust' cats) but had no vav/fpb/ddvav category definition to match
   against, so coveredPoints never included them for these three equipment types.
   Returns { humidity, setpointAdjust, occupancy } — all booleans, all evidence-based (never a
   default/guess). occSensor is already tracked as a category on vav/ddvav (not fpb, which has
   no hasOccSensor config flag today — out of scope here).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingDetectZoneFeatures(eq) {
  var covered = {};
  ((eq && eq.compliance && eq.compliance.coveredPoints) || []).forEach(function (cp) {
    covered[cp.categoryKey] = true;
  });
  return {
    humidity: !!covered.zoneHumidity,
    setpointAdjust: !!(covered.coolAdj || covered.htgAdj),
    occupancy: !!covered.occSensor,
  };
}

/* ── _pricingSelectZoneSensorSku(needCO2, features) — fix/zone-sku-from-existing-points ──────
   Picks a replacement zone sensor SKU from DETECTED existing-point evidence instead of a fixed
   default (Matt, 2026-07-28: "The points have to tell you which one they have existing. But
   yes, if you absolutely have to use the one you recommend[, use] Temp + occupant LED override
   + setpoint slide + CO2/Humidity ... occupancy sensor is not usually something recommended
   unless they already have it or want it").

   needCO2 — true only for the co2_zone COMBO gap (zoneTemp AND co2 both missing on the same
     zone): CO2 hardware is being installed as part of THIS gap, not detected evidence, so it is
     a requirement, not a feature to weigh. false for the zoneTemp-only gap (co2 already present
     via a separate/working device — nothing here replaces or duplicates that).
   features.humidity/setpointAdjust — real evidence from _pricingDetectZoneFeatures: the zone's
     OTHER points (not the one being replaced) already show these BAS-exposed capabilities.
   features.occupancy — real evidence the zone already has a matched occupancy/motion point.
     Per Matt, this is the ONLY thing that ever escalates to the motion-bearing SKU — it is never
     added speculatively "because it would be better."

   Catalog ladder actually used here (verified against en_pricing_catalog, list price):
     ZS2-ALC $155        temp only
     ZS2PL-ALC $183      temp + occupant LED override + setpoint slide
     ZS2-H-ALC $654      temp + humidity
     ZS2-HC-ALC $1,473   temp + humidity + CO2
     ZS2PL-HC-ALC $1,517 temp + humidity + CO2 + override + setpoint slide  (Matt's fallback)
     ZS2P-CM-ALC $1,645  + CO2 + motion (occupancy) — opt-in only, never a default upgrade

   No catalog SKU offers CO2 or humidity bundled WITHOUT the other (Viconics ships them as one
   "H+C" option together), so any branch that needs CO2 or humidity lands on the HC tier — the
   extra bundled feature (e.g. CO2 tagging along when only humidity evidence exists) is "better,
   never worse," matching the plan's explicit rule, not a fabricated upsell.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingSelectZoneSensorSku(needCO2, features) {
  var f = features || {};

  // Occupancy is opt-in only: never selected unless the zone's points already show it.
  if (f.occupancy) return 'ZS2P-CM-ALC';

  if (needCO2) {
    // co2_zone combo: CO2 (and therefore humidity, bundled) is being installed regardless of
    // what else the zone's other points reveal. When the zone's OTHER points reveal nothing
    // beyond the temp/CO2 gap itself (the common case — a zone missing both temp and CO2
    // usually has no live wall-sensor points at all), Matt's explicit fallback applies: use the
    // richer ZS2PL-HC-ALC, not the bare ZS2-HC-ALC. This also correctly covers the case where
    // setpointAdjust evidence DOES exist (ZS2PL-HC-ALC already carries it), so there is no
    // separate branch for f.setpointAdjust here — it can never demand less than this SKU already
    // provides.
    return 'ZS2PL-HC-ALC';
  }

  // zoneTemp-only gap (CO2 already present via a separate device) — genuine feature evidence
  // exists here (this is not the "nothing revealed" case), so pick the cheapest SKU that is
  // AT LEAST what the zone's other points show, never a default.
  if (f.humidity) {
    // No catalog SKU offers temp + humidity + setpoint-adjust without also bundling CO2, so
    // setpointAdjust evidence on top of humidity still resolves to the HC tier.
    return f.setpointAdjust ? 'ZS2PL-HC-ALC' : 'ZS2-H-ALC';
  }
  if (f.setpointAdjust) return 'ZS2PL-ALC';

  // No evidence of anything beyond temp — cheapest SKU that matches what was actually detected.
  return 'ZS2-ALC';
}

/* ── buildComplianceRows(projId) — spec §8, §3, §5 ─────────────────────────
   Produces the full row list for the Compliance tier from collectASHRAE36Data.
   Returns array of row objects:
   {
     id, building, item, type, equipLabel, qty, sku,
     engReview, noSku, ioOnly,
     unitPrice (from catalog + basis, or null), lineTotal (or null),
     note, phase (1=hardware|2=labor)
   }
   ─────────────────────────────────────────────────────────────────────────── */
/* ── buildCatalogRows(projId) ───────────────────────────────────────────────
   Single row-generation engine (c82cc354 REV 2, Step 1). Produces EVERY
   ASHRAE-36 hardware gap (phase 1) and EVERY applicable sequence-programming
   row (phase 2) for the project — the full catalog. Tiers (Compliance,
   Recommended, Full Scope) are membership FILTERS over this one function's
   output, not separate generators — row ids (hw_…/seq_…) are shared across
   tiers via _baseId so all user state (rowToggles, manualPrices,
   laborOverrides, qtyOverrides, noteOverrides) stays keyed consistently.
   Formerly named buildComplianceRows — byte-identical body, renamed only.
   ─────────────────────────────────────────────────────────────────────────── */
function buildCatalogRows(projId) {
  if (typeof collectASHRAE36Data !== 'function') return [];
  var ashData = collectASHRAE36Data(projId);
  if (!ashData || !ashData.buildings) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var estimate = _pricingGetEstimate(projId);
  var rows = [];
  var rowIdx = 0;

  // Deliverable E: install-labor inputs — same cfg object every other rate/hours lookup in this
  // function reads, so a Table-Settings edit to either is picked up on the very next render.
  // Unified labor rate (2026-07-28): install labor now prices at the SAME shared hourlyRate as
  // programming labor — no separate installLaborRate source anymore (Matt: "$173/hr for all
  // labor costs not just EM").
  var installHoursMap = cfg.installHoursByPoint || INSTALL_HOURS_BY_POINT_DEFAULT;
  var installLaborRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;

  // Helper: get unit price from catalog for a given SKU and basis
  function getUnitPrice(sku) {
    if (!catalog || !sku) return null;
    var entry = catalog[sku];
    if (!entry) return null;
    var basis = cfg.priceBasis || 'contract';
    if (basis === 'list') return entry.list != null ? entry.list : null;
    if (basis === 'net') return entry.net != null ? entry.net : null;
    if (basis === 'contract') {
      // contract: ALWAYS COST_CONTRACT_PCT × List — no CSV-contract fallback (spec §1/§7)
      if (entry.list != null) return parseFloat((COST_CONTRACT_PCT * entry.list).toFixed(2));
      return null; // list=null → no contract price possible → "⚠ No price"
    }
    return null;
  }

  // Helper: format equipment label for a group
  function equipLabel(count, catLabel, isBuilding) {
    if (isBuilding) return count + ' building' + (count !== 1 ? 's' : '');
    return count + ' ' + catLabel + (count !== 1 ? 's' : '');
  }

  // --- Phase 1: Hardware gaps ---
  // We need to group by building, then by (pointKey + equipType), NOT per-unit
  // to produce one row per point-type per equipment-type per building.
  // Special rules: oat → de-dup 1 per building; zoneTemp+co2 combo.

  ashData.buildings.forEach(function (bldgData) {
    var bName = bldgData.name;
    // Monitoring-only zone unit exclusion (2026-07-27) — see _pricingIsMonitoringOnlyZoneUnit's
    // header comment for the full rationale/citation. Filtered ONCE, before any row generation, so
    // it applies uniformly to hardware gaps, equipment-count labels, AND sequence-programming rows
    // below (a monitoring-only unit contributes NOTHING to buildCatalogRows' output at all).
    var equipResults = bldgData.equipResults.filter(function (eq) {
      return !_pricingIsMonitoringOnlyZoneUnit(eq);
    });
    // Map: pointKey → { equipType → { count, catLabel, engIds } }
    var hardwareGaps = {}; // pointKey → { equipType, count, catLabel, equipIds }
    var oatDeDupDone = false;
    var oaWetBulbDeDupDone = false;

    // Track per-zone which missing points exist (for combo logic)
    // equipId → set of missing required point keys
    var perEquipMissing = {};

    equipResults.forEach(function (eq) {
      var cat = eq.category;
      var eqId = eq.id;
      var missingKeys = {};
      eq.compliance.missingPoints.forEach(function (mp) {
        missingKeys[mp.categoryKey] = true;
      });
      perEquipMissing[eqId] = { keys: missingKeys, category: cat, name: eq.name };
    });

    // Now accumulate hardware gap rows
    // For oat: only 1 per building regardless of how many AHUs are missing it
    // For zoneTemp + co2 (zone): if both missing on same zone → one ZS2-HC-ALC instead of both
    // For oaWetBulb: 1 per building

    // First pass: accumulate all missing required points per equipment
    equipResults.forEach(function (eq) {
      var cat = eq.category;
      var catLabel = _pricingCatLabel(cat);
      eq.compliance.missingPoints.forEach(function (mp) {
        var pointKey = mp.categoryKey;
        // P0 FIX (2026-07-27, fix/phase-table-diversity-and-grouping): For co2, distinguish AHU
        // duct CO2 from zone CO2 using category — this remap MUST run before the PRICE_POINT_MAP
        // lookup below. PRICE_POINT_MAP has no bare 'co2' entry (only co2_ahu/co2_zone), so looking
        // up 'co2' directly always returned undefined and hit the `if (!mapEntry) return;` guard
        // before this remap ever ran — every co2 gap on every project silently vanished from every
        // tier (Catalog/Compliance/Full Scope) while DCV programming labor (which reads
        // eq.seqReadiness, a completely separate code path) was still priced, so DCV programming
        // was being sold with zero CO2 hardware ever budgeted for it. On real JOCO data: 754 of 899
        // VAV/AHU units are missing co2, 0 CO2 hardware rows existed in any tier before this fix.
        var effectiveKey = pointKey;
        if (pointKey === 'co2') {
          var zoneTypes = ['vav', 'fpb', 'ddvav', 'zone'];
          effectiveKey = zoneTypes.indexOf(cat) !== -1 ? 'co2_zone' : 'co2_ahu';
        }
        var mapEntry = PRICE_POINT_MAP[effectiveKey];
        if (!mapEntry) return; // no mapping → skip

        // Skip I/O-only here (handled separately for display)
        // Actually include them so we can show the $0 rows

        // oat de-dup: 1 per building
        if (effectiveKey === 'oat') {
          if (oatDeDupDone) return;
          oatDeDupDone = true;
          var key = 'oat__building';
          if (!hardwareGaps[key])
            hardwareGaps[key] = {
              pointKey: effectiveKey,
              equipType: 'building',
              catLabel: 'Building',
              count: 0,
              mapEntry: mapEntry,
            };
          hardwareGaps[key].count = 1;
          return;
        }

        // oaWetBulb de-dup: 1 per building
        if (effectiveKey === 'oaWetBulb') {
          if (oaWetBulbDeDupDone) return;
          oaWetBulbDeDupDone = true;
          var key2 = 'oaWetBulb__building';
          if (!hardwareGaps[key2])
            hardwareGaps[key2] = {
              pointKey: effectiveKey,
              equipType: 'building',
              catLabel: 'Building',
              count: 0,
              mapEntry: mapEntry,
            };
          hardwareGaps[key2].count = 1;
          return;
        }

        // Damper Position Control consolidation (2026-07-27, fix/phase-table-diversity-and-
        // grouping — Matt: "Why would you split up damper position control? Don't do that in
        // these kind of reports and summaries."). oaDampCmd (OA Damper Actuator) and raDampCmd (RA
        // Damper Actuator) are the same physical actuator SKU/price, both needed for one
        // conceptual measure — economizer damper position control on one AHU — but were
        // previously grouped/priced as two separate line items (same as zoneTemp+co2_zone below
        // are merged for the same reason: one retrofit, one line item). Merges into a single
        // 'damperPositionControl' bucket per building+equipType, SUMMING both counts (no dollar
        // change — every physical actuator gap is still counted once) so the report shows "N
        // damper actuators" instead of an "OA Damper Actuator" row and a same-priced "RA Damper
        // Actuator" row side by side.
        if (effectiveKey === 'oaDampCmd' || effectiveKey === 'raDampCmd') {
          var dampKey = 'damperPositionControl__' + cat;
          if (!hardwareGaps[dampKey]) {
            hardwareGaps[dampKey] = {
              pointKey: 'damperPositionControl',
              equipType: cat,
              catLabel: catLabel,
              count: 0,
              mapEntry: PRICE_POINT_MAP['damperPositionControl'],
            };
          }
          hardwareGaps[dampKey].count++;
          return;
        }

        // co2_zone + zoneTemp combo: if BOTH are missing on the same zone,
        // one combo zone sensor covers both — de-dup qty. Which SKU: fix/zone-sku-from-
        // existing-points (2026-07-28) — derived per zone from the zone's OTHER existing points
        // (_pricingDetectZoneFeatures/_pricingSelectZoneSensorSku above) instead of a single fixed
        // ZS2-HC-ALC default. The grouping key now includes the resolved SKU so zones on the same
        // building+category that detect different feature sets land in separate priced rows.
        if (effectiveKey === 'co2_zone' || effectiveKey === 'zoneTemp') {
          var eqMissing = perEquipMissing[eq.id] ? perEquipMissing[eq.id].keys : {};
          if (effectiveKey === 'co2_zone' && eqMissing['zoneTemp'] && eqMissing['co2']) {
            // Both missing: charge one combo sensor once (covers both), skip separate zoneTemp
            var _comboFeatures = _pricingDetectZoneFeatures(eq);
            var _comboSku = _pricingSelectZoneSensorSku(true, _comboFeatures);
            var comboKey = 'co2_zone__' + cat + '__' + _comboSku;
            if (!hardwareGaps[comboKey]) {
              var _comboBaseEntry = PRICE_POINT_MAP['co2_zone'];
              hardwareGaps[comboKey] = {
                pointKey: 'co2_zone',
                equipType: cat,
                catLabel: catLabel,
                count: 0,
                // Shallow clone: same flags/whyNeeded/g36Section as the base co2_zone mapEntry,
                // defaultSku swapped to the per-zone-detected SKU.
                mapEntry: Object.assign({}, _comboBaseEntry, {
                  defaultSku: _comboSku,
                  note:
                    _comboSku === 'ZS2P-CM-ALC'
                      ? 'Zone Temp/Humidity/CO2/Motion sensor — zone points show an existing occupancy sensor'
                      : _comboBaseEntry.note,
                }),
              };
            }
            hardwareGaps[comboKey].count++;
            // Mark zoneTemp as "covered by combo" so we skip it in zoneTemp pass
            if (!hardwareGaps['zoneTemp__' + cat + '__comboed'])
              hardwareGaps['zoneTemp__' + cat + '__comboed'] = { count: 0 };
            hardwareGaps['zoneTemp__' + cat + '__comboed'].count++;
            return;
          }
          // CO2-only gap (zoneTemp already present) — P0 correction (2026-07-28, audit finding):
          // 658 of 685 real zone-side CO2 gaps in the JOCO portfolio are this case (temp sensor
          // already installed, only CO2 missing). Before this branch existed, these fell through
          // to the general case below and were priced with the co2_zone COMBO mapEntry
          // (ZS2-HC-ALC, $589.20 contract) — replacing a working temperature sensor to add CO2,
          // a real overcharge (+$150K-ish portfolio-wide vs. pricing the correct part). The catalog
          // already carries the right standalone part for exactly this case (see
          // 'co2_zone_standalone' in PRICE_POINT_MAP, below) — a CO2-only room sensor, no temp
          // sensor replacement.
          if (effectiveKey === 'co2_zone' && !eqMissing['zoneTemp']) {
            var standaloneKey = 'co2_zone_standalone__' + cat;
            if (!hardwareGaps[standaloneKey])
              hardwareGaps[standaloneKey] = {
                pointKey: 'co2_zone_standalone',
                equipType: cat,
                catLabel: catLabel,
                count: 0,
                mapEntry: PRICE_POINT_MAP['co2_zone_standalone'],
              };
            hardwareGaps[standaloneKey].count++;
            return;
          }
          if (effectiveKey === 'zoneTemp') {
            var eqMissingZ = perEquipMissing[eq.id] ? perEquipMissing[eq.id].keys : {};
            // If co2 is also missing → this zone is handled in the co2_zone pass (combo)
            if (eqMissingZ['co2']) return;
            // Otherwise: standalone zoneTemp gap — CO2 already present via a separate/working
            // device (not being replaced here). fix/zone-sku-from-existing-points (2026-07-28):
            // derive the replacement SKU from the zone's OTHER detected points (humidity,
            // setpoint adjust, occupancy) instead of the fixed ZS2-ALC default.
            var _ztFeatures = _pricingDetectZoneFeatures(eq);
            var _ztSku = _pricingSelectZoneSensorSku(false, _ztFeatures);
            var ztKey = 'zoneTemp__' + cat + '__' + _ztSku;
            if (!hardwareGaps[ztKey]) {
              var _ztBaseEntry = PRICE_POINT_MAP['zoneTemp'];
              hardwareGaps[ztKey] = {
                pointKey: 'zoneTemp',
                equipType: cat,
                catLabel: catLabel,
                count: 0,
                // Shallow clone: same flags/whyNeeded/g36Section(ByCategory) as the base zoneTemp
                // mapEntry, defaultSku swapped to the per-zone-detected SKU.
                mapEntry: Object.assign({}, _ztBaseEntry, { defaultSku: _ztSku }),
              };
            }
            hardwareGaps[ztKey].count++;
            return;
          }
        }

        // General case: group by (pointKey + equipType)
        var gKey = effectiveKey + '__' + cat;
        if (!hardwareGaps[gKey]) {
          hardwareGaps[gKey] = {
            pointKey: effectiveKey,
            equipType: cat,
            catLabel: catLabel,
            count: 0,
            mapEntry: mapEntry,
          };
        }
        hardwareGaps[gKey].count++;
      });
    });

    // Build row objects from accumulated gaps
    var bldgEquipCount = {}; // category → total equip count in building
    equipResults.forEach(function (eq) {
      bldgEquipCount[eq.category] = (bldgEquipCount[eq.category] || 0) + 1;
    });

    Object.keys(hardwareGaps).forEach(function (gKey) {
      // Skip internal "comboed" tracking keys
      if (gKey.indexOf('__comboed') !== -1) return;

      var gap = hardwareGaps[gKey];
      if (gap.count <= 0) return;

      var mapEntry = gap.mapEntry;
      var sku = mapEntry.defaultSku;
      var engReview = mapEntry.flags.indexOf('engReview') !== -1;
      var noSku = mapEntry.flags.indexOf('noSku') !== -1;
      var ioOnly = mapEntry.flags.indexOf('ioOnly') !== -1;

      // Determine type label
      var typeName = _pricingPointType(gap.pointKey, mapEntry);

      // Equipment label — show gap count AND total for context ("1 of 33 FCUs")
      // If gap === total (all units missing the point), use the shorter "N FCUs" form.
      var totalForCat = bldgEquipCount[gap.equipType] || gap.count;
      var eqLabel;
      if (gap.pointKey === 'damperPositionControl') {
        // 2026-07-27: the merged OA+RA damper bucket sums TWO different point keys (one physical
        // actuator each) — its count is an actuator count, not a fraction of equipment in the
        // building, so "N of M [equip]" would misleadingly compare an actuator total against an
        // equipment count (e.g. 2 AHUs each missing both dampers reads as count=4, not "4 of 2
        // AHUs"). State it directly as an actuator count instead.
        eqLabel = gap.count + ' damper actuator' + (gap.count !== 1 ? 's' : '');
      } else if (gap.equipType === 'building') {
        eqLabel = '1 building';
      } else if (gap.count === totalForCat) {
        eqLabel = gap.count + ' ' + gap.catLabel + (gap.count !== 1 ? 's' : '');
      } else {
        eqLabel = gap.count + ' of ' + totalForCat + ' ' + gap.catLabel + (totalForCat !== 1 ? 's' : '');
      }

      var unitPrice = null;
      var lineTotal = null;
      if (ioOnly) {
        unitPrice = 0;
        lineTotal = 0;
      } else if (!noSku && sku) {
        unitPrice = getUnitPrice(sku);
        if (unitPrice !== null) {
          lineTotal = parseFloat((unitPrice * gap.count).toFixed(2));
        }
      }

      // Deliverable E: physical install labor. Applies to every real (non-ioOnly) hardware gap —
      // including noSku/SKU-missing rows, which don't have a resolvable parts price yet but still
      // need a device physically installed once the user enters one (see _pricingComputeTotals's
      // manual-price branch, which adds installLaborTotal back in at that point). ioOnly rows are
      // existing controller I/O points, not new hardware, so they get 0 install hours/labor.
      var _installHrsPerUnit = ioOnly
        ? 0
        : installHoursMap[gap.pointKey] != null
          ? installHoursMap[gap.pointKey]
          : INSTALL_HOURS_FALLBACK_DEFAULT;
      var _installLaborTotal = ioOnly ? 0 : parseFloat((_installHrsPerUnit * gap.count * installLaborRate).toFixed(2));
      var _partsUnitPrice = unitPrice; // raw parts-only unit price, pre-install (kept for the
      var _partsLineTotal = lineTotal; // optimizer substitution path and for transparency/debug)
      if (!ioOnly) {
        unitPrice =
          unitPrice != null ? parseFloat((unitPrice + _installHrsPerUnit * installLaborRate).toFixed(2)) : null;
        lineTotal = lineTotal != null ? parseFloat((lineTotal + _installLaborTotal).toFixed(2)) : null;
      }

      // Stamp list/net/contractPrice for the three-column display (FIX 2)
      var _catEntry = catalog && sku ? catalog[sku] : null;
      var _listPrice = _catEntry && _catEntry.list != null ? _catEntry.list : null;
      var _netPrice = _catEntry && _catEntry.net != null ? _catEntry.net : null;
      var _contractPrice =
        _catEntry && _catEntry.list != null ? parseFloat((cfg.contractPct * _catEntry.list).toFixed(2)) : null;

      rows.push({
        id: 'hw_' + bName + '_' + gKey + '_' + rowIdx++,
        building: bName,
        item: _pricingPointLabel(gap.pointKey),
        type: typeName,
        equipment: eqLabel,
        qty: gap.count,
        sku: sku || null,
        engReview: engReview,
        noSku: noSku,
        ioOnly: ioOnly,
        unitPrice: unitPrice, // parts + install (Deliverable E)
        partsUnitPrice: _partsUnitPrice, // raw parts-only, pre-install
        partsLineTotal: _partsLineTotal, // raw parts-only, pre-install
        installHours: _installHrsPerUnit,
        installLaborRate: installLaborRate,
        installLaborTotal: _installLaborTotal,
        listPrice: _listPrice,
        netPrice: _netPrice,
        contractPrice: _contractPrice,
        lineTotal: lineTotal, // parts + install (Deliverable E)
        note: mapEntry.note || '',
        whyNeeded: mapEntry.whyNeeded || '',
        whyNotHardware: mapEntry.whyNotHardware || '',
        g36Section:
          (mapEntry.g36SectionByCategory && mapEntry.g36SectionByCategory[gap.equipType]) || mapEntry.g36Section || '',
        phase: 1,
        _pointKey: gap.pointKey, // Fix 2: store resolved point key for reliable optimizer skip/class lookup
      });
    });

    // --- Phase 2: Sequence labor rows ---
    // Count non-'na' blocked/partial sequences per key across all equipment in this building
    // Track blocked vs partial breakdown for Qty clarity (FIX 3)
    //
    // 2026-07-28 (fix/roi-no-hardware-first-per-unit) — per Matt: "we really should be
    // prioritizing sequences that don't require installing sensors first" (this REVISES the
    // earlier DCV priority-bonus direction, not the priorityBonus value itself — see
    // SEQUENCE_SAVINGS_IMPACT.demandCtrl's comment). Root cause this fixes: cost tier used to be
    // decided per BUILDING (see the old buildRecommendedRows comment this replaced) — a building
    // with 25 AHUs on an `ahu_dsp_reset` opportunity, 18 of which already have the duct static
    // pressure sensor and 7 of which don't, scored the ENTIRE 25-unit row at the expensive tier,
    // ranking 18 programming-only units as if they needed hardware. Every blocked/partial
    // instance is now classified per EQUIPMENT UNIT (using the same per-unit missingPoints data
    // already gathered above as `perEquipMissing`) into 'ready' (every SEQUENCE_BLOCKING_SENSORS
    // key for this seqKey is already present on THIS unit — programming-only) or 'gap' (this
    // unit is still missing at least one blocking sensor — hardware install required). Two
    // counters per group so the row-generation loop below can emit up to two rows per seqKey
    // instead of one row that silently mixes both groups' cost tiers. Sequences with no blocking
    // sensors at all (SEQUENCE_BLOCKING_SENSORS[seqKey] === []) always land in 'ready' — same as
    // the old effectiveCostTier=1 shortcut for those.
    var seqCounts = {}; // seqKey → { ready: n, gap: n } — count of blocked/partial instances per hw-readiness group
    var seqBlocked = {}; // seqKey → { ready: n, gap: n } — count of blocked-only instances
    var seqPartial = {}; // seqKey → { ready: n, gap: n } — count of partial-only instances
    var seqApplicable = {}; // seqKey → count of non-'na' instances (denominator, both groups combined)

    function _bumpSeqGroupCount(map, seqKey, group) {
      if (!map[seqKey]) map[seqKey] = { ready: 0, gap: 0 };
      map[seqKey][group]++;
    }

    // 2026-07-27: uses the SAME filtered `equipResults` as the hardware-gap pass above, so a
    // monitoring-only unit (excluded above) never contributes sequence-programming labor either —
    // e.g. it can no longer be counted as a vav_dcv/DCV-programming "blocked/partial" instance,
    // which is exactly the outcome that would otherwise price DCV programming with no zone
    // control path to act on it.
    equipResults.forEach(function (eq) {
      if (!eq.seqReadiness) return;
      var eqMissing = (perEquipMissing[eq.id] && perEquipMissing[eq.id].keys) || {};
      Object.keys(eq.seqReadiness).forEach(function (seqKey) {
        var entry = eq.seqReadiness[seqKey];
        if (entry.status === 'na') return;
        // Count all non-na as applicable (denominator)
        seqApplicable[seqKey] = (seqApplicable[seqKey] || 0) + 1;
        if (entry.status !== 'blocked' && entry.status !== 'partial') return;

        // Per-UNIT hardware-readiness classification — see header comment above. `eqMissing`
        // stores the RAW mp.categoryKey (pre co2_ahu/co2_zone remap), so co2_ahu/co2_zone
        // blocking keys need the same category-based remap buildCatalogRows' hardware-gap pass
        // applies, checked against this unit's own category (not the building's).
        var blocking = SEQUENCE_BLOCKING_SENSORS[seqKey] || [];
        var needsHw = blocking.some(function (sk) {
          if (sk === 'co2_ahu' || sk === 'co2_zone') {
            var zoneTypes = ['vav', 'fpb', 'ddvav', 'zone'];
            var isZoneCat = zoneTypes.indexOf(eq.category) !== -1;
            if ((sk === 'co2_zone') !== isZoneCat) return false; // wrong category for this blocking key
            return !!eqMissing.co2;
          }
          return !!eqMissing[sk];
        });
        var group = needsHw ? 'gap' : 'ready';

        _bumpSeqGroupCount(seqCounts, seqKey, group);
        if (entry.status === 'blocked') _bumpSeqGroupCount(seqBlocked, seqKey, group);
        else _bumpSeqGroupCount(seqPartial, seqKey, group);
      });
    });

    var cfg2 = _pricingGetConfig();
    var perSeqHours = cfg2.perSequenceHours || COST_PER_SEQ_HOURS_DEFAULT;
    var hourlyRate = cfg2.hourlyRate || COST_LABOR_RATE_DEFAULT;

    // Use EM_SEQUENCE_DEFS for labels if available
    var seqLabels = {};
    if (typeof EM_SEQUENCE_DEFS !== 'undefined') {
      EM_SEQUENCE_DEFS.forEach(function (sd) {
        seqLabels[sd.key] = sd.label;
      });
    }

    // 2026-07-28 (fix/roi-no-hardware-first-per-unit): up to TWO rows per seqKey now — one per
    // hw-readiness group (see counting pass above) — instead of one row mixing both groups. Total
    // labor $ for a seqKey is unchanged (ready-count + gap-count === the old single count), only
    // the split changes; each split row carries its own group's blocked/partial breakdown and a
    // new `_hwGroup` field ('ready' | 'gap') consumed by buildRecommendedRows (cost-tier stamping)
    // and _pricingPairHwSeq (hardware claiming — a 'ready' row never claims a hardware gap row).
    Object.keys(seqCounts).forEach(function (seqKey) {
      ['ready', 'gap'].forEach(function (group) {
        var count = seqCounts[seqKey][group];
        if (!count || count <= 0) return;
        var hrs = perSeqHours[seqKey] != null ? perSeqHours[seqKey] : 2.0;
        var label = seqLabels[seqKey] || seqKey;
        // DCV label override per spec §2A note
        if (seqKey === 'demandCtrl' || seqKey === 'vav_dcv') label += ' (CO2/DCV Programming)';
        var lineHours = count * hrs;
        var lineTotal = parseFloat((lineHours * hourlyRate).toFixed(2));

        // FIX 3: Equipment label — show "N of M [type]" or "N [type]" if all applicable
        var applicable = seqApplicable[seqKey] || count;
        var seqTypeLabel = label.replace(/ \(CO2\/DCV Programming\)$/, ''); // strip suffix for the label
        var eqLabel2;
        if (count === applicable) {
          eqLabel2 = count + ' ' + seqTypeLabel + (count !== 1 ? 's' : '');
        } else {
          eqLabel2 = count + ' of ' + applicable + ' ' + seqTypeLabel + (applicable !== 1 ? 's' : '');
        }

        // Item 5a317ac7: blocked/partial breakdown folded into Equipment label (not Note).
        // hrs × $rate/hr was redundant with col 9 (hours spinner) and is removed entirely.
        var blockedN = (seqBlocked[seqKey] && seqBlocked[seqKey][group]) || 0;
        var partialN = (seqPartial[seqKey] && seqPartial[seqKey][group]) || 0;
        var statusBreakdown = '';
        if (blockedN > 0 && partialN > 0) {
          statusBreakdown = ' (' + blockedN + ' blocked, ' + partialN + ' partial)';
        } else if (blockedN > 0) {
          statusBreakdown = ' (' + blockedN + ' blocked)';
        } else if (partialN > 0) {
          statusBreakdown = ' (' + partialN + ' partial)';
        }

        rows.push({
          id: 'seq_' + bName + '_' + seqKey + '_' + group + '_' + rowIdx++,
          building: bName,
          item: label,
          type: 'Sequence',
          equipment: eqLabel2 + statusBreakdown,
          qty: count,
          sku: null,
          engReview: false,
          noSku: false,
          ioOnly: false,
          unitPrice: parseFloat((hrs * hourlyRate).toFixed(2)),
          listPrice: null,
          netPrice: null,
          contractPrice: null,
          lineTotal: lineTotal,
          note: '', // phase-2 rows have no static note; free-text override via est.noteOverrides
          phase: 2,
          seqKey: seqKey,
          hrsPerUnit: hrs,
          _hwGroup: group,
        });
      });
    });
  });

  return rows;
}

/* ── buildComplianceRows(projId) ────────────────────────────────────────────
   Compliance tier (c82cc354 REV 2, Step 1) = strictly ASHRAE-36-required rows:
   every phase-1 required-point hardware gap, plus phase-2 sequence rows whose
   sequence type is 'safety' (currently only ahu_freeze_prot — G36 §5.16.12,
   a required Bucket-A point per EM_POINT_CATEGORIES, equipment-matrix.js).
   Savings-type sequences (SAT reset, DSP reset, DCV, etc.) are NOT compliance
   items — they live in Recommended (budget-fit) and Full Scope (all).
   ─────────────────────────────────────────────────────────────────────────── */
function buildComplianceRows(projId) {
  return buildCatalogRows(projId).filter(function (row) {
    if (row.phase === 1) return true;
    var def = SEQUENCE_SAVINGS_IMPACT[row.seqKey];
    return !!(def && def.type === 'safety');
  });
}

/* ── Label helpers ── */
function _pricingCatLabel(cat) {
  var labels = {
    ahu: 'AHU',
    rtu: 'RTU',
    vav: 'VAV',
    fpb: 'FPB',
    ddvav: 'DDVAV',
    hwp: 'Hot Water Plant',
    chwp: 'Chilled Water Plant',
    ct: 'Cooling Tower',
    doas: 'DOAS',
    fcu: 'FCU',
    zone: 'Zone',
    furnace: 'Furnace',
    heater: 'Heater',
    ef: 'EF',
  };
  return labels[cat] || cat.toUpperCase();
}

function _pricingPointLabel(pointKey) {
  var labels = {
    sat: 'Supply Air Temp',
    rat: 'Return Air Temp',
    mat: 'Mixed Air Temp',
    oat: 'Outdoor Air Temp',
    dsp: 'Duct Static Pressure',
    co2_ahu: 'CO2 (AHU Duct)',
    // Renamed 2026-07-22 (Matt): the "CO2 (Zone)" label hid that this line item is the combined
    // ZS2-HC-ALC temp+humidity+CO2 zone sensor whenever the combo fires — see the PRICE_POINT_MAP
    // co2_zone entry above for the hardware-identity investigation behind this rename.
    co2_zone: 'Zone Temp/Humidity/CO2 Sensor',
    // 2026-07-28: standalone CO2-only sensor (zone already has a working temp sensor) — distinct
    // from co2_zone above (the combo replacement) so a reader can't confuse the two SKUs/prices.
    co2_zone_standalone: 'CO2 (Zone, Standalone)',
    dat: 'Discharge Air Temp',
    hwst: 'HW Supply Temp',
    hwrt: 'HW Return Temp',
    hwdp: 'HW Diff Pressure',
    chwst: 'CHW Supply Temp',
    chwrt: 'CHW Return Temp',
    chwdp: 'CHW Diff Pressure',
    cwst: 'CW Supply Temp',
    cwrt: 'CW Return Temp',
    oaWetBulb: 'OA Wet Bulb',
    zoneTemp: 'Zone Temp',
    oaDampCmd: 'OA Damper Actuator',
    raDampCmd: 'RA Damper Actuator',
    // damperPositionControl: consolidated OA+RA damper actuator line item (2026-07-27) — see the
    // PRICE_POINT_MAP entry of the same name for the full rationale.
    damperPositionControl: 'Damper Position Control (OA/RA Actuators)',
    dampCmd: 'Damper Actuator',
    coldDampCmd: 'Cold Deck Damper',
    hotDampCmd: 'Hot Deck Damper',
    chwIsoValveCmd: 'CHW Iso Valve',
    cwIsoValveCmd: 'CW Iso Valve',
    makeupValveCmd: 'Makeup Valve',
    clgValve: 'Cooling Coil Valve',
    htgValve: 'Heating Coil Valve',
    reheatValve: 'Reheat Valve',
    discFlow: 'VAV Zone Controller (Flow)',
    primaryFlow: 'FPB Zone Controller (Flow)',
    sfStatus: 'SF Status',
    sfSpeed: 'SF Speed',
    sfEnable: 'SF Enable',
    sfSpeedCmd: 'SF Speed Cmd',
    coolSP: 'Cool Setpoint',
    htgSP: 'Heat Setpoint',
    fanStatus: 'Fan Status',
    termFanStatus: 'Terminal Fan Status',
    termFanEnable: 'Terminal Fan Enable',
    boilerStatus: 'Boiler Status',
    boilerEnable: 'Boiler Enable',
    hwSetpoint: 'HW Setpoint',
    hwPumpStatus: 'HW Pump Status',
    hwPumpEnable: 'HW Pump Enable',
    hwPumpSpeed: 'HW Pump Speed',
    chillerStatus: 'Chiller Status',
    chillerEnable: 'Chiller Enable',
    chwSetpoint: 'CHW Setpoint',
    pchwpStatus: 'Primary CHWP Status',
    schwpStatus: 'Secondary CHWP Status',
    schwpSpeed: 'Secondary CHWP Speed',
    chwIsoValveStatus: 'CHW Iso Valve Status',
    pchwpEnable: 'Primary CHWP Enable',
    schwpEnable: 'Secondary CHWP Enable',
    ctFanStatus: 'CT Fan Status',
    cwPumpStatus: 'CW Pump Status',
    ctFanEnable: 'CT Fan Enable',
    cwPumpEnable: 'CW Pump Enable',
    freezeStat: 'Freeze Stat',
    oaFlow: 'OA Flow Station',
  };
  return labels[pointKey] || pointKey;
}

function _pricingPointType(pointKey, mapEntry) {
  // dampCmd / coldDampCmd / hotDampCmd are ioOnly but represent Phase 2 programming
  // (integral VVT actuator — not a Controller I/O point), so label them "Programming"
  var dampCmdKeys = ['dampCmd', 'coldDampCmd', 'hotDampCmd'];
  if (mapEntry.flags.indexOf('ioOnly') !== -1 && dampCmdKeys.indexOf(pointKey) !== -1) return 'Programming';
  if (mapEntry.flags.indexOf('ioOnly') !== -1) return 'No hardware needed';
  if (mapEntry.flags.indexOf('noSku') !== -1) return 'Manual';
  // Categorize by SKU prefix / point type
  var sku = mapEntry.defaultSku || '';
  // Distinguish ZS2 variants — fix/zone-sku-from-existing-points (2026-07-28) widened SKU
  // selection beyond the original ZS2-ALC/ZS2-HC-ALC pair, so these are named explicitly rather
  // than falling through to the (less accurate) ZS2 catch-all below.
  if (sku === 'ZS2P-CM-ALC') return 'Temp/Hum/CO2/Motion';
  if (sku === 'ZS2PL-HC-ALC') return 'Temp/Hum/CO2 + Override';
  if (sku === 'ZS2-HC-ALC') return 'Temp/Hum/CO2';
  if (sku === 'ZS2-H-ALC') return 'Temp/Humidity';
  if (sku === 'ZS2PL-ALC') return 'Zone Temp + Override';
  if (sku === 'ZS2-ALC') return 'Zone Temp';
  if (sku.startsWith('ZS2')) return 'Temp/Hum/CO2'; // catch-all for future ZS2 variants
  if (sku.startsWith('N1-DCD') || pointKey.indexOf('co2') !== -1) return 'CO2';
  if (sku.startsWith('N1-') || sku.startsWith('N2-')) return 'Sensor';
  if (sku.startsWith('AF') || sku.startsWith('AM') || sku.startsWith('AFRB')) return 'Actuator';
  if (sku.startsWith('B2')) return 'Valve';
  if (sku === 'OF253A-E2') return 'Controller';
  return 'Sensor';
}

/* ── formatCurrency helper ── */
function _pricingFmt(val) {
  if (val === null || val === undefined) return '—';
  return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── Compute footer totals ── */
function _pricingComputeTotals(rows, estimate) {
  var phase1 = 0,
    phase2 = 0;
  var included = 0,
    total = rows.length,
    engReviewCount = 0;
  var hasAnyPrice = false;
  var pendingPriceCount = 0; // included rows with no resolvable price (NO-SKU unpriced + SKU not in catalog)
  var catalog = sget('en_pricing_catalog', null);
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);

  rows.forEach(function (row) {
    if (row.engReview) engReviewCount++;
    // Fix 3: recommended rows carry _baseId (the compliance row id) so toggles
    // keyed by compliance ids apply consistently across both tiers.
    var toggleKey = row._baseId || row.id;
    var toggled = estimate.rowToggles[toggleKey];
    var isOn = toggled !== false; // default on
    if (!isOn) return;
    included++;

    if (row.ioOnly) return; // $0, legitimately priced at $0 — not pending

    var price = row.lineTotal;

    // Manual price override — blank/NaN/zero = MISSING (not $0)
    // Applies to: explicit noSku rows AND SKU rows not found in catalog (Fix: item 6f26cbfd)
    var _skuMissing = row.sku && hasCatalog && catalog && !catalog[row.sku];
    if (row.noSku || _skuMissing) {
      var manual = parseFloat(estimate.manualPrices[toggleKey]);
      // Deliverable E: install labor is already known at build time (device count doesn't change
      // just because the parts price was typed in manually) — fold it in once a real manual price
      // makes this row priced at all. Stays null/pending exactly as before when no manual price yet.
      price = isNaN(manual) || manual === 0 ? null : manual * row.qty + (row.installLaborTotal || 0);
    }

    if (price === null) {
      // Count hardware rows as pending when catalog is loaded (SKU missing/unpriced).
      // Without a catalog, hardware rows can't be priced — tracked separately via noCatalog flag.
      if (hasCatalog && row.phase === 1) pendingPriceCount++;
      return;
    }
    hasAnyPrice = true;
    if (row.phase === 1) phase1 += price;
    else if (row.phase === 2) phase2 += price;
  });

  // Bug B fix: grandTotal is null ONLY when zero included rows are priced.
  // Labor rows (phase 2) are always priced (qty × hrs × hourlyRate) regardless of
  // whether a pricing catalog is imported. Removing !hasCatalog from this condition
  // allows labor totals to display even when no catalog is loaded.
  var grandNull = !hasAnyPrice;

  return {
    phase1: grandNull ? null : phase1,
    phase2: grandNull ? null : phase2,
    grand: grandNull ? null : phase1 + phase2,
    included: included,
    total: total,
    engReviewCount: engReviewCount,
    pendingPriceCount: pendingPriceCount,
    hasAnyPrice: hasAnyPrice,
    noCatalog: !hasCatalog, // true when no pricing CSV imported; callers use to show "import CSV" note
  };
}

/* ── Main Tab Renderer ── */
function initCostEstimateTab(projId) {
  var el = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (!el) return;

  var cfg = _pricingGetConfig();
  var catalog = sget('en_pricing_catalog', null);
  var meta = sget('en_pricing_meta', null);
  var estimate = _pricingGetEstimate(projId);
  var rows = buildComplianceRows(projId);
  _pricingRowCache[projId] = rows;
  var totals = _pricingComputeTotals(rows, estimate);
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);

  // ── Toolbar HTML
  var importStatus = '';
  if (meta) {
    importStatus =
      '<span style="font-size:11px;color:var(--text2);margin-left:8px">' +
      meta.skuCount +
      ' SKUs imported ' +
      new Date(meta.importedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      '</span>';
  } else {
    importStatus =
      '<span style="font-size:11px;color:var(--warn);margin-left:8px">No pricing imported — unit prices will show as "—"</span>';
  }

  var toolbarHTML = [
    '<div class="ch-panel-header" style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--s1);border-bottom:1px solid var(--border2)">',
    '<label class="btn btn-ghost btn-sm" style="cursor:pointer;position:relative">',
    '<input type="file" accept=".csv" id="pricing-csv-input-' +
      projId +
      '" style="position:absolute;opacity:0;width:0;height:0" onchange="handlePricingCSVImport(event,' +
      projId +
      ')">',
    (hasCatalog ? '' : '<span style="color:var(--warn)">⚠ </span>') + 'Import Pricing CSV',
    '</label>',
    importStatus,
    '<span style="flex:1"></span>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Price Basis:',
    '<select id="pricing-basis-' +
      projId +
      '" style="font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px" onchange="updatePricingConfig(' +
      projId +
      ",'priceBasis',this.value)\">",
    '<option value="contract"' + (cfg.priceBasis === 'contract' ? ' selected' : '') + '>Contract (40% List)</option>',
    '<option value="net"' + (cfg.priceBasis === 'net' ? ' selected' : '') + '>Net</option>',
    '<option value="list"' + (cfg.priceBasis === 'list' ? ' selected' : '') + '>List</option>',
    '</select>',
    '</label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Net Multiplier:',
    '<input type="number" id="pricing-net-mult-' +
      projId +
      '" min="0.01" max="1.0" step="0.01" value="' +
      cfg.netMultiplier +
      '"',
    ' style="width:56px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"',
    ' onchange="updatePricingConfig(' + projId + ",'netMultiplier',parseFloat(this.value))\">",
    '</label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Contract %:',
    '<input type="number" id="pricing-contract-pct-' +
      projId +
      '" min="1" max="100" step="1" value="' +
      Math.round(cfg.contractPct * 100) +
      '"',
    ' style="width:48px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"',
    ' onchange="updatePricingConfig(' + projId + ",'contractPct',parseFloat(this.value)/100)\">",
    '</label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Hourly Rate:',
    '<input type="number" id="pricing-rate-' + projId + '" min="1" max="999" step="1" value="' + cfg.hourlyRate + '"',
    ' style="width:56px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"',
    ' onchange="updatePricingConfig(' + projId + ",'hourlyRate',parseFloat(this.value))\">",
    '</label>',
    '</div>',
  ].join('');

  // ── Table rows HTML, grouped by building → Phase 1 / Phase 2
  var buildings = [];
  var bldgSet = {};
  rows.forEach(function (row) {
    if (!bldgSet[row.building]) {
      bldgSet[row.building] = true;
      buildings.push(row.building);
    }
  });

  function renderRow(row) {
    var toggleOn = estimate.rowToggles[row.id] !== false;
    var manualVal = estimate.manualPrices[row.id] || '';

    var skuCell = '';
    if (row.ioOnly) {
      skuCell = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (row.phase === 2) {
      skuCell = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (!row.sku) {
      skuCell = '<span style="color:var(--warn);font-size:10px">Manual Price</span>';
    } else {
      skuCell =
        (row.engReview
          ? '<span title="Engineering review required before ordering" style="color:var(--warn);margin-right:3px;font-size:11px">⚠</span>'
          : '') +
        '<span style="font-family:monospace;font-size:10px">' +
        row.sku +
        '</span>';
    }

    var unitPriceCell = '';
    if (row.ioOnly) {
      unitPriceCell = '<span style="color:var(--text3);font-size:10px">$0 (no part)</span>';
    } else if (row.phase === 2) {
      // Labor: show hours × rate
      unitPriceCell = row.unitPrice !== null ? _pricingFmt(row.unitPrice) : '—';
    } else if (row.noSku) {
      // Manual price input
      unitPriceCell =
        '<input type="number" min="0" step="0.01" value="' +
        manualVal +
        '" placeholder="Enter price"' +
        ' style="width:80px;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid var(--warn);border-radius:4px;text-align:right"' +
        ' onchange="_pricingManualPrice(event,\'' +
        projId +
        "','" +
        row.id +
        '\')">';
    } else if (!hasCatalog) {
      unitPriceCell = '<span style="color:var(--text3)">—</span>';
    } else if (row.sku && catalog && !catalog[row.sku]) {
      unitPriceCell = '<span style="color:var(--warn)" title="SKU not found in imported pricing">⚠ No price</span>';
    } else {
      unitPriceCell = row.unitPrice !== null ? _pricingFmt(row.unitPrice) : '<span style="color:var(--text3)">—</span>';
    }

    var lineTotalCell = '';
    if (row.ioOnly) {
      lineTotalCell = '<span style="color:var(--text3);font-size:10px">$0</span>';
    } else if (row.noSku) {
      var mv = parseFloat(estimate.manualPrices[row.id] || 0);
      var lt = isNaN(mv) ? null : mv * row.qty;
      lineTotalCell =
        lt !== null && lt > 0 ? _pricingFmt(lt) : '<span style="color:var(--warn);font-size:10px">⚠ Enter price</span>';
    } else {
      lineTotalCell =
        row.lineTotal !== null
          ? '<span' + (!toggleOn ? ' style="color:var(--text3)"' : '') + '>' + _pricingFmt(row.lineTotal) + '</span>'
          : '<span style="color:var(--text3)">—</span>';
    }

    var rowStyle = !toggleOn ? 'opacity:0.45;' : '';
    if (row.ioOnly) rowStyle += 'background:var(--s1);';

    return [
      '<tr style="' + rowStyle + '">',
      // col 1: Include checkbox (frozen)
      '<td class="ch-frozen" style="width:36px;text-align:center;padding:4px 6px">',
      '<input type="checkbox"' +
        (toggleOn ? ' checked' : '') +
        (row.ioOnly ? ' title="Uses existing wiring — no new part needed"' : '') +
        ' onchange="_pricingToggleRow(\'' +
        projId +
        "','" +
        row.id +
        '\',this.checked)"' +
        ' style="cursor:pointer">',
      '</td>',
      // col 2: Building (frozen)
      '<td class="ch-frozen" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding:5px 8px">' +
        _esc(row.building) +
        '</td>',
      // col 3: Item
      '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding:5px 8px">' +
        _esc(row.item) +
        '</td>',
      // col 4: Type
      '<td style="font-size:10px;color:var(--text2);white-space:nowrap;padding:5px 8px">' + _esc(row.type) + '</td>',
      // col 5: Equipment
      '<td style="font-size:10px;color:var(--text2);white-space:nowrap;padding:5px 8px">' +
        _esc(row.equipment) +
        '</td>',
      // col 6: Qty
      '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:11px;padding:5px 8px">' +
        row.qty +
        '</td>',
      // col 7: SKU
      '<td style="white-space:nowrap;padding:5px 8px">' + skuCell + '</td>',
      // col 8: Unit Price
      '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:11px;padding:5px 8px">' +
        unitPriceCell +
        '</td>',
      // col 9: Line Total
      '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:11px;padding:5px 8px">' +
        lineTotalCell +
        '</td>',
      // col 10: Notes — visible text = note + G36 §; tooltip = whyNeeded (or whyNotHardware for programming rows)
      (function () {
        var noteText = row.note || '';
        if (row.g36Section) noteText += (noteText ? ' · ' : '') + _esc(row.g36Section);
        // Build tooltip: for ioOnly Programming rows (integral VVT dampers), surface whyNotHardware;
        // for all others surface whyNeeded; phase-2 sequence rows have no rationale field.
        var tooltipText = '';
        if (row.whyNotHardware) {
          tooltipText = row.whyNotHardware;
          if (row.g36Section) tooltipText += ' (' + row.g36Section + ')';
        } else if (row.whyNeeded) {
          tooltipText = row.whyNeeded;
          if (row.g36Section) tooltipText += ' (' + row.g36Section + ')';
        }
        var titleAttr = tooltipText ? ' title="' + _esc(tooltipText) + '"' : '';
        var cursorStyle = tooltipText ? 'cursor:help;' : '';
        return (
          '<td style="font-size:10px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;' +
          cursorStyle +
          '"' +
          titleAttr +
          '>' +
          _esc(noteText) +
          '</td>'
        );
      })(),
      '</tr>',
    ].join('');
  }

  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var tableBodyHTML = '';

  if (rows.length === 0) {
    tableBodyHTML =
      '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text3);font-size:13px">No compliance gaps found. Run the Equipment Matrix audit first.</td></tr>';
  } else {
    buildings.forEach(function (bName) {
      var bRows = rows.filter(function (r) {
        return r.building === bName;
      });
      var hw = bRows.filter(function (r) {
        return r.phase === 1;
      });
      var lb = bRows.filter(function (r) {
        return r.phase === 2;
      });

      // Building group header — only include toggled-on rows (mirrors footer logic)
      var bHw1 = hw.reduce(function (s, r) {
        return estimate.rowToggles[r.id] !== false ? s + (r.lineTotal || 0) : s;
      }, 0);
      var bLab2 = lb.reduce(function (s, r) {
        return estimate.rowToggles[r.id] !== false ? s + (r.lineTotal || 0) : s;
      }, 0);
      var bTotal = bHw1 + bLab2;

      tableBodyHTML += [
        '<tr>',
        '<td colspan="10" style="background:var(--s1);padding:6px 10px;font-size:11px;font-weight:700;color:var(--text2);border-bottom:1px solid var(--border2)">',
        _esc(bName),
        bTotal > 0 && hasCatalog
          ? ' <span style="font-weight:400;color:var(--text3)">— ' + _pricingFmt(bTotal) + ' est.</span>'
          : '',
        '</td>',
        '</tr>',
      ].join('');

      if (hw.length > 0) {
        tableBodyHTML += [
          '<tr>',
          '<td colspan="10" style="background:var(--s3);padding:3px 10px 3px 18px;font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid var(--border)">',
          'Phase 1 — Hardware',
          '</td>',
          '</tr>',
        ].join('');
        hw.forEach(function (row) {
          tableBodyHTML += renderRow(row);
        });
      }

      if (lb.length > 0) {
        tableBodyHTML += [
          '<tr>',
          '<td colspan="10" style="background:var(--s3);padding:3px 10px 3px 18px;font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid var(--border)">',
          'Phase 2 — Programming Labor',
          '</td>',
          '</tr>',
        ].join('');
        lb.forEach(function (row) {
          tableBodyHTML += renderRow(row);
        });
      }
    });
  }

  // ── Footer totals
  var _p2CaveatParts = [];
  if (totals.pendingPriceCount > 0) {
    _p2CaveatParts.push(totals.pendingPriceCount + ' item(s) pending price (excluded)');
  }
  if (totals.engReviewCount > 0) {
    _p2CaveatParts.push(totals.engReviewCount + ' eng-review at typical sizing');
  }
  _p2CaveatParts.push('Basis: ' + (cfg.priceBasis || 'contract'));
  var _p2CaveatLine = _p2CaveatParts.join(' · ');

  var footerHTML = [
    '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
    '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 1 Hardware:</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
      (totals.grand !== null ? _pricingFmt(totals.phase1) : '—') +
      '</span>',
    '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 2 Programming:</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
      (totals.grand !== null ? _pricingFmt(totals.phase2) : '—') +
      '</span>',
    '<span style="color:var(--border2)">|</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">Grand Total: ' +
      (totals.grand !== null ? _pricingFmt(totals.grand) : '—') +
      '</span>',
    '<span style="flex:1"></span>',
    '<span style="font-size:11px;color:var(--text3)">' + totals.included + ' of ' + totals.total + ' items</span>',
    '<span style="font-size:11px;color:var(--text3)">' + _p2CaveatLine + '</span>',
    '</div>',
  ].join('');

  // ── Assemble full panel
  el.innerHTML = [
    '<div class="ch-panel" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;height:100%">',
    toolbarHTML,
    '<div class="ch-panel-body" style="flex:1;min-height:0;overflow-y:auto;overflow-x:auto">',
    '<div class="ch-tbl-outer" style="margin:0">',
    '<div class="ch-tbl-scroll" style="overflow:auto">',
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%;min-width:860px">',
    '<thead>',
    '<tr>',
    '<th class="ch-frozen" style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 6px;white-space:nowrap;position:sticky;top:0;z-index:12;left:0;width:36px;text-align:center">Incl</th>',
    '<th class="ch-frozen" style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;left:36px;min-width:120px;max-width:130px">Building</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;min-width:140px">Item</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11">Type</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11">Equipment</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;text-align:center">Qty</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;min-width:150px">SKU</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;text-align:center">Unit Price</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;text-align:right">Line Total</th>',
    '<th style="background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;min-width:180px">Notes</th>',
    '</tr>',
    '</thead>',
    '<tbody id="pricing-tbody-' + projId + '">',
    tableBodyHTML,
    '</tbody>',
    '</table>',
    '</div>',
    '</div>',
    '</div>',
    '<div id="pricing-footer-' + projId + '">',
    footerHTML,
    '</div>',
    '</div>',
  ].join('');
}

/* ── Event handlers (called from inline HTML) ── */

function handlePricingCSVImport(event, projId) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (e) {
    var result = parsePricingCSV(e.target.result);
    if (!result) {
      if (typeof showToast === 'function') showToast('Could not parse pricing CSV — check column headers');
      return;
    }
    // Update meta with filename
    var meta = sget('en_pricing_meta', {});
    meta.filename = file.name;
    sset('en_pricing_meta', meta);
    if (typeof showToast === 'function') showToast(result.skuCount + ' SKUs imported from ' + file.name + ' ✓');
    // Re-render tab
    initCostEstimateTab(projId);
  };
  reader.readAsText(file);
}

function _pricingToggleRow(projId, rowId, checked) {
  var est = _pricingGetEstimate(projId);
  est.rowToggles[rowId] = checked;
  _pricingSetEstimate(projId, est);
  _pricingRefreshFooter(projId);
  // Dim the row
  var row = document.querySelector('[data-row-id="' + rowId + '"]');
  // We use a simpler approach: re-render footer and update row opacity
  _pricingRefreshRowState(projId, rowId, checked);
}

function _pricingToggleAllRows(projId, checked) {
  // Select-all checkbox in the Incl column header (mirrors _pricingToggleRow above,
  // but applies to every currently-visible/filtered row at once — item b771dec6 1d).
  var est = _pricingGetEstimate(projId);
  var rows = _pricingRowCache[projId] || [];
  rows.forEach(function (row) {
    var key = row._baseId || row.id;
    est.rowToggles[key] = checked;
  });
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

function _pricingToggleCombinedRow(projId, hwKey, seqKey, checked) {
  // b771dec6 5c (Finding 7): a merged sensor+sequence row shows ONE checkbox controlling TWO
  // underlying toggle keys — the phase-1 hardware row's and its paired phase-2 sequence row's.
  // Both are set together so the single visible control always reflects one consistent
  // include/exclude state for the whole combined line. A full re-render (not the single-row
  // opacity patch _pricingToggleRow uses) is required because two independent rowToggles keys
  // change at once and the footer/building-subtotal totals must reflect both — those totals are
  // recomputed by the untouched _pricingComputeTotals/buildXRows pipeline on every render.
  var est = _pricingGetEstimate(projId);
  est.rowToggles[hwKey] = checked;
  est.rowToggles[seqKey] = checked;
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

function _pricingRefreshRowState(projId, rowId, checked) {
  // Find all tds in this row via the checkbox
  var cb = document.querySelector('#ptab-cost-estimate-body-' + projId + ' input[onchange*="' + rowId + '"]');
  if (cb) {
    var tr = cb.closest('tr');
    if (tr) tr.style.opacity = checked ? '' : '0.45';
  }
  _pricingRefreshFooter(projId);
}

function _pricingManualPrice(event, projId, rowId) {
  var val = parseFloat(event.target.value);
  var est = _pricingGetEstimate(projId);
  est.manualPrices[rowId] = isNaN(val) ? '' : val;
  _pricingSetEstimate(projId, est);
  _pricingRefreshFooter(projId);
  // Update line total cell
  var input = event.target;
  var tr = input.closest ? input.closest('tr') : null;
  if (tr) {
    var tds = tr.querySelectorAll('td');
    if (tds.length >= 9) {
      var row = _pricingFindRow(projId, rowId);
      if (row) {
        var lt = isNaN(val) || val <= 0 ? null : val * row.qty;
        tds[8].innerHTML =
          lt !== null ? _pricingFmt(lt) : '<span style="color:var(--warn);font-size:10px">⚠ Enter price</span>';
      }
    }
  }
}

// Cache rows per projId for quick lookup
var _pricingRowCache = {};
// Bug A: optimizer substitution stats per projId — populated by buildRecommendedRows
var _pricingOptimizerStats = {}; // projId → { subCount: N }
function _pricingFindRow(projId, rowId) {
  var rows = _pricingRowCache[projId];
  if (!rows) return null;
  return (
    rows.find(function (r) {
      return r.id === rowId;
    }) || null
  );
}

function _pricingRefreshFooter(projId) {
  var footerEl = document.getElementById('pricing-footer-' + projId);
  if (!footerEl) return;
  var rows = _pricingRowCache[projId] || buildComplianceRows(projId);
  var est = _pricingGetEstimate(projId);
  var cfg = _pricingGetConfig();
  var catalog = sget('en_pricing_catalog', null);
  var totals = _pricingComputeTotals(rows, est);
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);

  var _rfCaveatParts = [];
  if (totals.pendingPriceCount > 0) {
    _rfCaveatParts.push(totals.pendingPriceCount + ' item(s) pending price (excluded)');
  }
  if (totals.engReviewCount > 0) {
    _rfCaveatParts.push(totals.engReviewCount + ' eng-review at typical sizing');
  }
  _rfCaveatParts.push('Basis: ' + (cfg.priceBasis || 'contract'));
  var _rfCaveatLine = _rfCaveatParts.join(' · ');

  footerEl.innerHTML = [
    '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
    '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 1 Hardware:</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
      (totals.grand !== null ? _pricingFmt(totals.phase1) : '—') +
      '</span>',
    '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 2 Programming:</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
      (totals.grand !== null ? _pricingFmt(totals.phase2) : '—') +
      '</span>',
    '<span style="color:var(--border2)">|</span>',
    '<span style="font-size:13px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">Grand Total: ' +
      (totals.grand !== null ? _pricingFmt(totals.grand) : '—') +
      '</span>',
    '<span style="flex:1"></span>',
    '<span style="font-size:11px;color:var(--text3)">' + totals.included + ' of ' + totals.total + ' items</span>',
    '<span style="font-size:11px;color:var(--text3)">' + _rfCaveatLine + '</span>',
    '</div>',
  ].join('');
}

function updatePricingConfig(projId, key, val) {
  _pricingSetConfig({ [key]: val });
  if (key === 'netMultiplier' && typeof showToast === 'function') {
    showToast('Net multiplier updated to ' + val + ' — recomputing prices ✓');
  }
  initCostEstimateTab(projId);
}

/* ── 174ad49a: budget field onchange handler — same shape as updatePricingConfig ── */
function _pricingUpdateBudget(projId, key, val) {
  _pricingSetBudget(projId, { [key]: val });
  initCostEstimateTab(projId);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 3 — Three-tier model (Recommended/Compliance/Full Scope), optimizer,
              COMBO de-dup, tier toggle, collectPricingEstimate (spec §4, §8, §10, §11)
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Optimizer qualifying classes (spec §4) ──────────────────────────────────
   Maps each optimizable pointKey class to a catalog category keyword filter
   (case-insensitive substring match on catalog entry .category or .desc).
   The optimizer finds the lowest-price SKU from the catalog that matches the
   class filter, then substitutes it for the curated default.

   SKIP LIST (use curated default + engReview, do NOT optimize):
     immersion temp: hwst, hwrt, chwst, chwrt, cwst, cwrt (thermowell sizing)
     DP sensors: dsp, hwdp, chwdp (range unknown)
     coil valves: clgValve, htgValve, reheatValve (Cv/pipe size)
     OA/RA damper actuators: oaDampCmd, raDampCmd (torque/spring-return safety)
     VAV zone controllers: discFlow, primaryFlow (I/O count)
   ─────────────────────────────────────────────────────────────────────────── */
var OPTIMIZER_SKIP_KEYS = {
  hwst: true,
  hwrt: true,
  chwst: true,
  chwrt: true,
  cwst: true,
  cwrt: true,
  dsp: true,
  hwdp: true,
  chwdp: true,
  clgValve: true,
  htgValve: true,
  reheatValve: true,
  oaDampCmd: true,
  raDampCmd: true,
  // damperPositionControl (2026-07-27): the consolidated OA+RA damper row's _pointKey — same
  // skip rationale as oaDampCmd/raDampCmd above (torque/spring-return safety, never auto-swapped).
  damperPositionControl: true,
  discFlow: true,
  primaryFlow: true,
};

/* Catalog class filters per optimizable point key.
   Value = {catMatch, descMatch} — one or both may be provided.
   Optimizer finds catalog[sku] where category.toLowerCase() contains catMatch
   (if set) AND desc.toLowerCase() does NOT contain descExclude (if set).
   The combo class (co2_zone) prefers ZS2-HC-ALC specifically; optimizer picks
   within ZS CO2 options. */
var OPTIMIZER_CLASS_FILTERS = {
  sat: { descMatch: 'duct temperature', descExclude: 'averaging' },
  rat: { descMatch: 'duct temperature', descExclude: 'averaging' },
  mat: { descMatch: 'duct temperature', descExclude: 'averaging' },
  oat: { descMatch: 'outdoor temperature', descExclude: null },
  co2_ahu: { descMatch: 'duct co2', descExclude: null },
  co2_zone: { descMatch: 'zone', descExclude: null, skuPrefix: 'ZS2' },
  dat: { descMatch: 'duct temperature', descExclude: 'averaging' },
  zoneTemp: { descMatch: 'zone', descExclude: 'co2', skuPrefix: 'ZS2' },
  // dampCmd/coldDampCmd/hotDampCmd removed (2026-06-19): classified ioOnly in PRICE_POINT_MAP;
  // _pricingFindCheapestSku is never called for ioOnly rows (guard at line ~1689), making
  // these entries unreachable dead code.
  chwIsoValveCmd: { descMatch: 'non-fail-safe', descExclude: null, skuPrefix: 'AMB' },
  cwIsoValveCmd: { descMatch: 'non-fail-safe', descExclude: null, skuPrefix: 'AMB' },
  makeupValveCmd: { descMatch: 'non-fail-safe', descExclude: null, skuPrefix: 'AMB' },
};

/* FDD add-on SKU (spec §11 build #3) — 1 per system (WebCTRL license, not per-building) */
var FDD_SKU = 'ADD-FDD-RPT';

/* ── _pricingFindCheapestSku(pointKey, catalog, basis) ──────────────────────
   Searches catalog for the cheapest qualifying SKU for the given point key.
   Returns { sku, unitPrice } or null if no qualifying entry found.
   Falls back to curated default if no cheaper match exists.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingFindCheapestSku(pointKey, catalog, cfg) {
  if (!catalog || OPTIMIZER_SKIP_KEYS[pointKey]) return null;

  var classFilter = OPTIMIZER_CLASS_FILTERS[pointKey];
  if (!classFilter) return null; // no filter defined → cannot optimize

  var basis = cfg.priceBasis || 'contract';

  function getPrice(entry) {
    if (!entry) return null;
    if (basis === 'list') return entry.list != null ? entry.list : null;
    if (basis === 'net') return entry.net != null ? entry.net : null;
    if (basis === 'contract') {
      return entry.list != null ? parseFloat((COST_CONTRACT_PCT * entry.list).toFixed(2)) : null;
    }
    return null;
  }

  var bestSku = null;
  var bestPrice = Infinity;

  Object.keys(catalog).forEach(function (sku) {
    var entry = catalog[sku];
    var desc = (entry.desc || '').toLowerCase();
    var cat = (entry.category || '').toLowerCase();

    // SKU prefix filter (if specified)
    if (classFilter.skuPrefix && sku.indexOf(classFilter.skuPrefix) !== 0) return;

    // Description match
    if (classFilter.descMatch && desc.indexOf(classFilter.descMatch.toLowerCase()) === -1) return;

    // Description exclusion
    if (classFilter.descExclude && desc.indexOf(classFilter.descExclude.toLowerCase()) !== -1) return;

    var price = getPrice(entry);
    if (price === null || price <= 0) return;

    if (price < bestPrice) {
      bestPrice = price;
      bestSku = sku;
    }
  });

  if (!bestSku) return null;
  return { sku: bestSku, unitPrice: bestPrice };
}

/* ── buildRecommendedRows(projId) ───────────────────────────────────────────
   Produces the row list for the Recommended tier — c82cc354 REV 2 (Step 2b):
   DYNAMIC, BUDGET-DRIVEN membership over the full catalog, per Matt's fork-1
   answer ("it should probably not be a static logic"). No longer a static
   savings-tier filter of Compliance; Recommended is NOT a subset of
   Compliance (measures are not compliance items — tier-analysis §2/§7).

   1. Clone every buildCatalogRows(projId) row; optimizer substitutes the
      lowest-price qualifying SKU for safe classes (unchanged); stamp
      savings-impact fields + dynamic _effectiveCostTier on phase-2 rows
      (unchanged). NO static tier filter — every sequence type is stamped and
      candidate for membership, not just high/med-high/med.
   2. Bundle every SAVINGS-type sequence with all its claimed blocking
      hardware into one "unit" (_pricingBuildRoiUnits) — a measure is never
      sold without the sensors it needs; standalone hardware and
      enabler/safety/null-impact sequences never form a unit and can never
      appear in Recommended.
   3. Ceiling = _pricingComputeBudgetTotal(budget) when a recurring budget is
      set — membership is the ranked (2026-07-28: no-hardware-required units
      first, _pricingEquipRowScore/best ROI-per-dollar as the tie-break within
      each group — see _pricingSortUnitsNoHwFirst) greedy prefix that fits
      (_pricingGreedyPrefix, the shipped v631 Fit-to-Budget engine, reused
      verbatim). No budget (or Mode A financing, or an invalid term) →
      membership = HIGH-impact units only (Matt's specified fallback).
   4. Kept rows (sequence + its claimed hardware) are returned in the
      existing building-grouped / phase-sorted order.
   ─────────────────────────────────────────────────────────────────────────── */
function buildRecommendedRows(projId) {
  // Start from the FULL catalog (every hardware gap + every applicable
  // sequence), not the Compliance-restricted subset — Recommended candidates
  // include savings sequences Compliance no longer carries.
  var catRows = buildCatalogRows(projId);
  if (!catRows.length) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var estimate = _pricingGetEstimate(projId);

  var recRows = [];
  var _optimizerSubCount = 0; // Bug A: track substitutions made

  // Process each catalog row and apply optimizer + savings-impact stamping
  catRows.forEach(function (row) {
    // Clone the row so catalog rows are unaffected
    var rec = Object.assign({}, row);

    // Only optimize Phase 1 hardware rows with a real SKU
    if (rec.phase === 1 && rec.sku && !rec.ioOnly && !rec.noSku) {
      if (OPTIMIZER_SKIP_KEYS[rec._pointKey || _extractPointKeyFromRowId(row.id)]) {
        // SKIP: keep curated default, preserve engReview
        rec.optimizerSkipped = true;
      } else {
        // Try to find a cheaper qualifying SKU
        var pointKey = rec._pointKey || _extractPointKeyFromRowId(row.id);
        var cheaper = _pricingFindCheapestSku(pointKey, catalog, cfg);
        if (cheaper && cheaper.sku !== rec.sku) {
          // Optimizer found a cheaper option
          rec.optimizerOriginalSku = rec.sku;
          rec.sku = cheaper.sku;
          rec.partsUnitPrice = cheaper.unitPrice;
          rec.partsLineTotal = rec.qty > 0 ? parseFloat((cheaper.unitPrice * rec.qty).toFixed(2)) : null;
          // Deliverable E: re-add install labor on top of the substituted parts price. rec's
          // installHours/installLaborRate/installLaborTotal were already stamped by
          // buildCatalogRows (keyed by pointKey, not SKU — a cheaper SKU for the same device
          // class needs the SAME install effort) and don't change with the SKU swap.
          rec.unitPrice = parseFloat(
            (
              cheaper.unitPrice +
              (rec.installHours || 0) * (rec.installLaborRate || cfg.hourlyRate || COST_LABOR_RATE_DEFAULT)
            ).toFixed(2),
          );
          rec.lineTotal =
            rec.partsLineTotal != null
              ? parseFloat((rec.partsLineTotal + (rec.installLaborTotal || 0)).toFixed(2))
              : null;
          rec.optimized = true;
          _optimizerSubCount++;
          // Recompute three-column price fields for the substituted SKU (FIX 2)
          var _optEntry = catalog ? catalog[cheaper.sku] : null;
          rec.listPrice = _optEntry && _optEntry.list != null ? _optEntry.list : null;
          rec.netPrice = _optEntry && _optEntry.net != null ? _optEntry.net : null;
          rec.contractPrice =
            _optEntry && _optEntry.list != null ? parseFloat((cfg.contractPct * _optEntry.list).toFixed(2)) : null;
        }
      }
    }

    // Fix 3: store the catalog row id as _baseId BEFORE re-keying,
    // so toggle state (keyed by catalog ids) is shared between tiers.
    rec._baseId = row.id;

    // Re-key the row ID so it's distinct from the catalog row ID
    rec.id = rec.id.replace(/^hw_/, 'rch_').replace(/^seq_/, 'rcs_');

    // ── Phase 5: stamp savings impact fields onto phase-2 sequence rows ──
    if (rec.phase === 2 && rec.seqKey) {
      var impactDef = SEQUENCE_SAVINGS_IMPACT[rec.seqKey];
      if (impactDef) {
        rec.savingsImpact = impactDef.tier;
        rec.savingsRationale = impactDef.savingsRationale;
        rec.clientSummary = impactDef.clientSummary || null;
        rec.savingsSource = impactDef.source;
        rec.sourceType = impactDef.sourceType;
        rec._savingsWeight = impactDef.weight;
        rec._enablesLabel = impactDef.enablesLabel || null;

        // Dynamic effectiveCostTier — 2026-07-28 (fix/roi-no-hardware-first-per-unit): now read
        // directly from the PER-UNIT hw-readiness group buildCatalogRows already computed
        // (rec._hwGroup: 'ready' = every blocking sensor this seqKey needs is already present on
        // every unit this row represents, 'gap' = at least one unit still needs hardware) instead
        // of re-deriving it from a building-wide scan of catRows' hardware-gap rows. The old scan
        // flagged an ENTIRE building's row as "needs hardware" the moment ANY ONE unit in that
        // building lacked the sensor — e.g. Courthouse ahu_dsp_reset: 18 of 25 AHUs already have
        // the duct static pressure sensor, but the whole 25-unit row scored at the expensive tier.
        // buildCatalogRows now emits a separate row per group, so this is just a direct read.
        // Default to nominalTier (not 1) if _hwGroup is ever missing — never silently under-price.
        var nominalTier = impactDef.nominalCostTier || 2;
        rec._effectiveCostTier = rec._hwGroup === 'ready' ? 1 : nominalTier;
      } else {
        // No impact definition — leave unlabeled
        rec.savingsImpact = null;
        rec._effectiveCostTier = 2;
      }
    }

    // c82cc354 REV 2: the static phase-2 savings-tier filter (high/med-high/med
    // only) is REMOVED — every sequence type is stamped and kept here; actual
    // Recommended membership is decided by the budget-driven greedy/HIGH-only
    // rule below, not by a fixed impact-tier cutoff.
    recRows.push(rec);
  });

  // ── c82cc354 REV 2 (Step 2b.2-3): budget-driven dynamic membership ──
  // Apply the same labor/qty overrides the shipped Fit-to-Budget plan used
  // before ranking, and exclude rows the user already manually toggled off
  // (never re-enter the pool — mirrors the shipped 3357-3360 behavior) so the
  // greedy ranking/ceiling math reflects the user's current, real numbers.
  var pooled = _pricingApplyLaborOverrides(projId, recRows);
  pooled = _pricingApplyQtyOverrides(projId, pooled);
  var poolRows = pooled.filter(function (r) {
    var toggleKey = r._baseId || r.id;
    return estimate.rowToggles[toggleKey] !== false;
  });

  var units = _pricingBuildRoiUnits(poolRows);

  var budget = _pricingGetBudget(projId);
  var comp = _pricingComputeBudgetTotal(budget);
  // 2026-07-26 (fix/phase-cost-budget-model) — RESOLVED, ceiling now netted against real EM labor.
  // History: comp.total (budget.termMonths-based, defaults to 12 → $75,000 for JOCO) was left
  // UNCHANGED through two earlier passes because both alternate ceilings tried then broke on real
  // JOCO numbers:
  //   1. Widening to the raw 29-month program allowance ($181,250, no netting): measures alone
  //      consumed 99.98% of the WHOLE allowance before a dollar of EM labor was even counted.
  //   2. Netting the FULL EM-labor total out of that same raw ceiling ($181,250 − $177,480 =
  //      $3,770): collapsed membership to 7 rows/$3,740 — but DOUBLE-SUBTRACTED, because
  //      `_pricingComputeMonthlyLaborBreakdown`'s old "Program & Sequence Setup" category reused
  //      the SAME COST_PER_SEQ_HOURS_DEFAULT hours already priced into every phase-2 row's
  //      Programming cost inside this same candidate pool.
  //   That double-count is now FIXED AT THE SOURCE (Program & Sequence Setup was removed from the
  //   recurring EM labor breakdown entirely — see _pricingComputeMonthlyLaborBreakdown's header
  //   comment) — so netting is safe now. Ceiling below is the PROGRAM-WIDE net-of-labor measures
  //   budget (`_pricingComputeProgramCostModel(projId).programMeasuresAvailable`) — every figure it
  //   derives from (budget.amount, the phase date ranges, and the recurring labor constants) is
  //   already stored/derived elsewhere; nothing here is a new hardcoded number. Falls back to the
  //   old `comp.total` (budget.termMonths-based) ceiling only when the calendar cost model can't be
  //   computed (e.g. a 'lump' denomination, which has no natural monthly figure to net against) —
  //   same recurring-mode branch as before, just a different derivation of the ceiling inside it.
  var costModelForCeiling = _pricingComputeProgramCostModel(projId);
  var keepUnitToggleKeys = {};
  if (comp && budget.mode === 'recurring') {
    // Budget entered: ranked prefix that fits the ceiling — the shipped v631 Fit-to-Budget greedy
    // engine, reused verbatim as the membership rule (pricing-estimator.js:536-558 conversion; NOT
    // re-derived here). Ceiling = program-wide measures budget net of recurring EM labor when the
    // calendar cost model is available; otherwise the pre-existing term-based total.
    var _ceiling = costModelForCeiling ? costModelForCeiling.programMeasuresAvailable : comp.total;
    var _fitPlan = _pricingGreedyPrefix(units, _ceiling);
    _fitPlan.keepKeys.forEach(function (k) {
      keepUnitToggleKeys[k] = true;
    });
  } else {
    // No budget (or Mode A financing, or an invalid term): highest-impact
    // (HIGH) units only — Matt's specified fallback.
    units.forEach(function (u) {
      if (u.seqRow && u.seqRow.savingsImpact === 'high') {
        u.toggleKeys.forEach(function (k) {
          keepUnitToggleKeys[k] = true;
        });
      }
    });
  }

  // A row survives in Recommended only if it's the sequence half or a claimed
  // hardware half of a KEPT unit. Standalone hardware (never formed a unit)
  // and non-kept sequences/hardware are absent from the tier entirely — not
  // merely unchecked (tier-analysis §7: "rows outside the prefix are simply
  // not in the tier"). Their toggle/override state is preserved by id and
  // reappears intact if the budget later grows to include them again.
  recRows = recRows.filter(function (r) {
    var toggleKey = r._baseId || r.id;
    return !!keepUnitToggleKeys[toggleKey];
  });

  // ── Phase 5: Two-key sort for phase-2 rows within each building group (correction #3)
  // Apply sort within building groups, preserve building order and phase-1/phase-2 structure.
  // Non-phase-2 rows are unaffected.
  var allBuildings = [];
  var bldgSet = {};
  recRows.forEach(function (r) {
    if (r.building && !bldgSet[r.building]) {
      bldgSet[r.building] = true;
      allBuildings.push(r.building);
    }
  });

  // 0ae36950 (979fd1af sort control): Batch 2c's hardcoded descending-ROI building sort has been
  // REMOVED from here — Matt asked for a user-facing sort control ("sort by best building return
  // and by best equipment return"), not a fixed default order he never asked for. allBuildings
  // now stays in natural/source order (the order buildings first appear walking recRows, which
  // itself follows buildComplianceRows' project-data order). The "Best building return first"
  // mode of the new toolbar sort control (initCostEstimateTab, tier==='recommended') reproduces
  // the exact same score formula at render time — see _pricingComputeBldgRoiScores below.
  // Per plan constraint: sorting must live in the RENDER layer only, so this function's output
  // array stays byte-identical for ce-totals-check (which fingerprints per-row by id anyway, so
  // building order was never actually gate-relevant — but other future consumers of this
  // function's return order should see the natural order, not a baked-in ranking).

  var sortedRows = [];
  allBuildings.forEach(function (bName) {
    var bPhase1 = recRows.filter(function (r) {
      return r.building === bName && r.phase === 1;
    });
    var bPhase2 = recRows.filter(function (r) {
      return r.building === bName && r.phase === 2;
    });
    // Apply two-key sort to phase-2 rows only
    bPhase2 = _pricingSortRecommendedRows(bPhase2);
    bPhase1.forEach(function (r) {
      sortedRows.push(r);
    });
    bPhase2.forEach(function (r) {
      sortedRows.push(r);
    });
  });
  // Any rows without a building (shouldn't happen) appended at end
  recRows.forEach(function (r) {
    if (!r.building) sortedRows.push(r);
  });

  // Bug A: store substitution count so initCostEstimateTab can show a notice
  _pricingOptimizerStats[projId] = { subCount: _optimizerSubCount };

  return sortedRows;
}

/* ── buildOptionalPointRows(projId) ──────────────────────────────────────────
   c82cc354 REV 2 (Step 4) — the "beyond-compliance" optional-point generator.
   For each building/equipment from collectASHRAE36Data, walks
   EM_POINT_CATEGORIES[eq.category] definitions with required === false
   (extra CO2, reheat/coil valve actuators, plant iso/makeup valves, …) and
   prices the ones that are genuinely missing:
     - SKIPPED if already covered: eq.compliance.coveredPoints already reports
       a match for ANY category (required or not) whose raw point name was
       found on this equipment — emComputeCompliance's own point-matching
       loop (equipment-matrix.js ~17707-17740) is NOT restricted to required
       categories, so coveredPoints is the correct/only source of truth here;
       this function does not re-implement point-name matching.
     - SKIPPED if N/A per configFlag: replicates emComputeCompliance's
       configFlag N/A handling (equipment-matrix.js ~17771-17788) exactly —
       same EM_EQUIP_CONFIG_FLAGS default lookup, same emLoadEquipConfigFlags
       per-equipment override — so an optional point whose prerequisite
       feature isn't present (e.g. no economizer) is correctly excluded, not
       priced as a gap.
     - EXCLUDED (not priced) if PRICE_POINT_MAP has no entry for the point key
       — Full Scope only prices what CSC has a catalogued hardware solution
       for; unmapped optional points are never invented a SKU.
   Grouping/pricing/de-dup rules (co2 zone/ahu split, oat/oaWetBulb per-
   building de-dup, contract-basis getUnitPrice) are the SAME as
   buildCatalogRows' phase-1 hardware-gap logic — replicated here rather than
   shared because the source category (required vs optional) and hence the
   gap-detection rule differ.
   Row shape: phase 1, id: 'opt_…', isOptionalPoint: true, type label distinct
   ('Beyond-Compliance'), grouped under the REAL building (never WebCTRL
   System campus-wide).
   ─────────────────────────────────────────────────────────────────────────── */
function buildOptionalPointRows(projId) {
  if (typeof collectASHRAE36Data !== 'function') return [];
  var ashData = collectASHRAE36Data(projId);
  if (!ashData || !ashData.buildings) return [];
  if (typeof EM_POINT_CATEGORIES === 'undefined') return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var rows = [];
  var rowIdx = 0;

  function getUnitPrice(sku) {
    if (!catalog || !sku) return null;
    var entry = catalog[sku];
    if (!entry) return null;
    var basis = cfg.priceBasis || 'contract';
    if (basis === 'list') return entry.list != null ? entry.list : null;
    if (basis === 'net') return entry.net != null ? entry.net : null;
    if (basis === 'contract') {
      if (entry.list != null) return parseFloat((COST_CONTRACT_PCT * entry.list).toFixed(2));
      return null;
    }
    return null;
  }

  ashData.buildings.forEach(function (bldgData) {
    var bName = bldgData.name;
    // Monitoring-only zone unit exclusion (2026-07-27) — same filter/rationale as buildCatalogRows
    // (see _pricingIsMonitoringOnlyZoneUnit's header comment). Optional (beyond-compliance) points
    // are no more sellable for a unit with no zone setpoint write path than required ones are.
    var equipResults = bldgData.equipResults.filter(function (eq) {
      return !_pricingIsMonitoringOnlyZoneUnit(eq);
    });
    var optionalGaps = {}; // gKey -> {pointKey, equipType, catLabel, count, mapEntry}
    var oatDeDupDone = false;
    var oaWetBulbDeDupDone = false;

    equipResults.forEach(function (eq) {
      var cat = eq.category;
      var catDefs = EM_POINT_CATEGORIES[cat];
      if (!catDefs) return;

      // Already-covered optional categories (any match, required or not —
      // emComputeCompliance's coveredPoints is not required-only).
      var coveredKeys = {};
      (eq.compliance && eq.compliance.coveredPoints ? eq.compliance.coveredPoints : []).forEach(function (cp) {
        coveredKeys[cp.categoryKey] = true;
      });

      var flags = typeof emLoadEquipConfigFlags === 'function' ? emLoadEquipConfigFlags(projId, eq.id) : {};

      catDefs.forEach(function (def) {
        if (def.required) return; // only optional (required:false) categories
        if (coveredKeys[def.key]) return; // already present on this equipment

        // Replicate emComputeCompliance's configFlag N/A handling
        // (equipment-matrix.js ~17771-17788) for optional categories too.
        if (def.configFlag) {
          var flagDefault = true;
          var flagDefs = (typeof EM_EQUIP_CONFIG_FLAGS !== 'undefined' && EM_EQUIP_CONFIG_FLAGS[cat]) || [];
          for (var fi = 0; fi < flagDefs.length; fi++) {
            if (flagDefs[fi].key === def.configFlag) {
              flagDefault = flagDefs[fi]['default'];
              break;
            }
          }
          var flagVal = def.configFlag in flags ? flags[def.configFlag] : flagDefault;
          if (!flagVal) return; // N/A for this equipment — not a real gap
        }

        var pointKey = def.key;
        // P0 FIX (2026-07-27) — same defect as buildCatalogRows above (search 'P0 FIX' there for
        // the full writeup): the co2 -> co2_zone/co2_ahu remap must run BEFORE the PRICE_POINT_MAP
        // lookup, since PRICE_POINT_MAP has no bare 'co2' entry. This function's `if (!mapEntry)
        // return` guard was previously reached first, silently excluding every optional-co2 gap.
        var effectiveKey = pointKey;
        if (pointKey === 'co2') {
          var zoneTypes = ['vav', 'fpb', 'ddvav', 'zone'];
          effectiveKey = zoneTypes.indexOf(cat) !== -1 ? 'co2_zone' : 'co2_ahu';
        }
        var mapEntry = PRICE_POINT_MAP[effectiveKey];
        if (!mapEntry) return; // unmapped — EXCLUDED, no catalogued hardware (spec §5)

        if (effectiveKey === 'oat') {
          if (oatDeDupDone) return;
          oatDeDupDone = true;
          var key = 'oat__building';
          if (!optionalGaps[key]) {
            optionalGaps[key] = {
              pointKey: effectiveKey,
              equipType: 'building',
              catLabel: 'Building',
              count: 0,
              mapEntry: mapEntry,
            };
          }
          optionalGaps[key].count = 1;
          return;
        }
        if (effectiveKey === 'oaWetBulb') {
          if (oaWetBulbDeDupDone) return;
          oaWetBulbDeDupDone = true;
          var key2 = 'oaWetBulb__building';
          if (!optionalGaps[key2]) {
            optionalGaps[key2] = {
              pointKey: effectiveKey,
              equipType: 'building',
              catLabel: 'Building',
              count: 0,
              mapEntry: mapEntry,
            };
          }
          optionalGaps[key2].count = 1;
          return;
        }

        // co2_zone standalone-vs-combo split (2026-07-28) — mirrors buildCatalogRows' combo dedup
        // (search 'CO2-only gap' there for the full writeup). This function's `coveredKeys` (built
        // above from eq.compliance.coveredPoints) already reports whether zoneTemp is present on
        // this equipment REGARDLESS of whether zoneTemp itself is a required or optional category
        // for this type, so it's the correct signal here too: zoneTemp covered => temp sensor
        // already installed => CO2-only gap => standalone sensor, not the temp+CO2 combo replacement.
        if (effectiveKey === 'co2_zone' && coveredKeys['zoneTemp']) {
          var standaloneOptKey = 'co2_zone_standalone__' + cat;
          var standaloneCatLabel = _pricingCatLabel(cat);
          if (!optionalGaps[standaloneOptKey]) {
            optionalGaps[standaloneOptKey] = {
              pointKey: 'co2_zone_standalone',
              equipType: cat,
              catLabel: standaloneCatLabel,
              count: 0,
              mapEntry: PRICE_POINT_MAP['co2_zone_standalone'],
            };
          }
          optionalGaps[standaloneOptKey].count++;
          return;
        }

        var gKey = effectiveKey + '__' + cat;
        var catLabel = _pricingCatLabel(cat);
        if (!optionalGaps[gKey]) {
          optionalGaps[gKey] = {
            pointKey: effectiveKey,
            equipType: cat,
            catLabel: catLabel,
            count: 0,
            mapEntry: mapEntry,
          };
        }
        optionalGaps[gKey].count++;
      });
    });

    var bldgEquipCount = {};
    equipResults.forEach(function (eq) {
      bldgEquipCount[eq.category] = (bldgEquipCount[eq.category] || 0) + 1;
    });

    Object.keys(optionalGaps).forEach(function (gKey) {
      var gap = optionalGaps[gKey];
      if (gap.count <= 0) return;

      var mapEntry = gap.mapEntry;
      var sku = mapEntry.defaultSku;
      var engReview = mapEntry.flags.indexOf('engReview') !== -1;
      var noSku = mapEntry.flags.indexOf('noSku') !== -1;
      var ioOnly = mapEntry.flags.indexOf('ioOnly') !== -1;
      var typeName = _pricingPointType(gap.pointKey, mapEntry);

      var totalForCat = bldgEquipCount[gap.equipType] || gap.count;
      var eqLabel;
      if (gap.equipType === 'building') {
        eqLabel = '1 building';
      } else if (gap.count === totalForCat) {
        eqLabel = gap.count + ' ' + gap.catLabel + (gap.count !== 1 ? 's' : '');
      } else {
        eqLabel = gap.count + ' of ' + totalForCat + ' ' + gap.catLabel + (totalForCat !== 1 ? 's' : '');
      }

      var unitPrice = null;
      var lineTotal = null;
      if (ioOnly) {
        unitPrice = 0;
        lineTotal = 0;
      } else if (!noSku && sku) {
        unitPrice = getUnitPrice(sku);
        if (unitPrice !== null) lineTotal = parseFloat((unitPrice * gap.count).toFixed(2));
      }

      var _catEntry = catalog && sku ? catalog[sku] : null;
      var _listPrice = _catEntry && _catEntry.list != null ? _catEntry.list : null;
      var _netPrice = _catEntry && _catEntry.net != null ? _catEntry.net : null;
      var _contractPrice =
        _catEntry && _catEntry.list != null ? parseFloat((cfg.contractPct * _catEntry.list).toFixed(2)) : null;

      rows.push({
        id: 'opt_' + bName + '_' + gKey + '_' + rowIdx++,
        building: bName,
        item: _pricingPointLabel(gap.pointKey),
        type: typeName,
        typeLabel: 'Beyond-Compliance',
        equipment: eqLabel,
        qty: gap.count,
        sku: sku || null,
        engReview: engReview,
        noSku: noSku,
        ioOnly: ioOnly,
        unitPrice: unitPrice,
        listPrice: _listPrice,
        netPrice: _netPrice,
        contractPrice: _contractPrice,
        lineTotal: lineTotal,
        note: mapEntry.note || '',
        whyNeeded: mapEntry.whyNeeded || '',
        whyNotHardware: mapEntry.whyNotHardware || '',
        g36Section:
          (mapEntry.g36SectionByCategory && mapEntry.g36SectionByCategory[gap.equipType]) || mapEntry.g36Section || '',
        phase: 1,
        _pointKey: gap.pointKey,
        isOptionalPoint: true,
      });
    });
  });

  return rows;
}

/* ── buildFullScopeRows(projId) ─────────────────────────────────────────────
   Produces the row list for the Full Scope tier — "the complete per-building
   modernization" (c82cc354 REV 2, Step 4): every required-point hardware gap
   + ALL applicable G36 sequences (the full catalog, not Compliance's
   safety-restricted subset) + every optional (required:false) point with a
   catalogued hardware mapping + the FDD Reporting add-on.
   Row IDs: fsc_/fsl_ prefix (catalog clone), fso_ prefix (optional-point
   clone). Each row carries _baseId so toggle state transfers/shares with the
   other tiers (fso_ rows share state only among themselves — their _baseId
   is their own opt_ id, since optional points have no Compliance/Recommended
   counterpart).
   Ordering: Full Scope >= Compliance in every building (structural
   guarantee); Full Scope ⊇ Compliance and ⊇ Recommended's _baseId sets.
   ─────────────────────────────────────────────────────────────────────────── */
function buildFullScopeRows(projId) {
  var catRows = buildCatalogRows(projId);
  if (!catRows.length) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var fsRows = [];
  var rowIdx = 20000; // offset to avoid ID collision with compliance + recommended rows

  // Clone all catalog rows with fsc_/fsl_ ID prefix and _baseId linkage
  catRows.forEach(function (row) {
    var fs = Object.assign({}, row);
    // Store catalog row id for shared toggle state
    fs._baseId = row.id;
    // Re-key the row ID with full-scope prefix
    fs.id = fs.id.replace(/^hw_/, 'fsc_').replace(/^seq_/, 'fsl_');
    fsRows.push(fs);
  });

  // c82cc354 REV 2 (Step 4): optional (beyond-compliance) point rows
  var optRows = buildOptionalPointRows(projId);
  optRows.forEach(function (row) {
    var fs = Object.assign({}, row);
    fs._baseId = row.id; // own opt_ id — no Compliance/Recommended counterpart
    fs.id = fs.id.replace(/^opt_/, 'fso_');
    fsRows.push(fs);
  });

  // Add FDD add-on row (moved from buildRecommendedRows — Full Scope is the correct home)
  {
    var fddUnitPrice = null;
    var fddLineTotal = null;
    if (catalog && catalog[FDD_SKU]) {
      var fddEntry = catalog[FDD_SKU];
      var basis = cfg.priceBasis || 'contract';
      if (basis === 'list') fddUnitPrice = fddEntry.list;
      else if (basis === 'net') fddUnitPrice = fddEntry.net;
      else fddUnitPrice = fddEntry.list != null ? parseFloat((COST_CONTRACT_PCT * fddEntry.list).toFixed(2)) : null;
      if (fddUnitPrice !== null) fddLineTotal = fddUnitPrice; // qty=1
    }

    fsRows.push({
      id: 'fsc_fdd_project_' + rowIdx++,
      building: 'WebCTRL System',
      item: 'FDD Reporting',
      type: 'Add-On',
      equipment: '1 WebCTRL system',
      qty: 1,
      sku: FDD_SKU,
      engReview: false,
      noSku: !catalog || !catalog[FDD_SKU],
      ioOnly: false,
      unitPrice: fddUnitPrice,
      lineTotal: fddLineTotal,
      note: '1 per WebCTRL system — verify system count',
      phase: 1,
      isFddAddon: true,
    });
  }

  return fsRows;
}

/* ── Helper: extract pointKey from a row id produced by buildComplianceRows ──
   Compliance row IDs have the form: hw_{building}_{effectiveKey}__{cat}_{idx}
   This is a best-effort extraction used by the optimizer.
   ─────────────────────────────────────────────────────────────────────────── */
function _extractPointKeyFromRowId(rowId) {
  // Strip prefix and trailing _idx
  var s = rowId.replace(/^hw_[^_]+_/, '').replace(/_\d+$/, '');
  // s is now like "sat__ahu" or "co2_ahu__ahu" — extract the part before __
  var parts = s.split('__');
  return parts[0] || '';
}

/* ── Tier toggle: render the tier selector buttons ──────────────────────────
   Order (left→right): Recommended | Compliance | Full Scope | Compare
   c82cc354 REV 2: the old "cost-ascending" guarantee no longer holds — Recommended
   is a budget-fit ranked selection of measures, NOT a subset of Compliance, so its
   $ total is independent of Compliance's and can be higher OR lower depending on
   the client's budget/term. The only guaranteed set relations are: Compliance ⊆
   Full Scope, Recommended ⊆ Full Scope (by _baseId), and Recommended's total is
   bounded by its budget ceiling (or the HIGH-impact-only total with no budget).
   'both' stored tier value preserved for saved-state compatibility; label → 'Compare'.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingTierToggleHTML(projId, currentTier) {
  function btn(tier, label) {
    var active = currentTier === tier;
    return (
      '<button onclick="_pricingSetTier(\'' +
      projId +
      "','" +
      tier +
      '\')"' +
      ' style="font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--border);' +
      (active ? 'background:var(--accent);color:#fff;font-weight:700;' : 'background:var(--s3);color:var(--text2);') +
      '">' +
      label +
      '</button>'
    );
  }
  return (
    // 098fd49c: "Tier:" label removed — the active toggle button's own styling (filled accent
    // background) already makes the current tier obvious without a redundant text label.
    '<div style="display:flex;gap:4px;align-items:center">' +
    btn('recommended', 'Recommended') +
    btn('compliance', 'Compliance') +
    btn('full-scope', 'Full Scope') +
    btn('both', 'Compare') +
    '</div>'
  );
}

function _pricingSetTier(projId, tier) {
  var est = _pricingGetEstimate(projId);
  est.tier = tier;
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── "Both" side-by-side mode: render two Line-Total columns ────────────────
   When tier='both', the table shows:
   - All compliance rows, with an extra "Recommended" total column
   - A footer showing Compliance total vs Recommended total side by side
   Implementation: render compliance rows; for each row, also look up the
   matching recommended row by pointKey+building+phase to show its lineTotal.
   ─────────────────────────────────────────────────────────────────────────── */
function _buildBothModeIndex(recRows) {
  // Index recommended rows by their row ID base (strip the rch_/rcs_ prefix back
  // to the compliance base key for matching)
  var idx = {};
  recRows.forEach(function (r) {
    // ID format: rch_{building}_{gKey}_{rowIdx} or rcs_{building}_{seqKey}_{rowIdx}
    // We want to match against the compliance row which has id like hw_{building}_{gKey}_{rowIdx}
    // Since rowIdx differs we match on (building + gKey portion)
    var base = r.id.replace(/^rch_/, '').replace(/^rcs_/, '').replace(/_\d+$/, ''); // strip trailing index
    idx[base] = r;
  });
  return idx;
}

/* Phase 3 render body removed 2026-06-19 — superseded by Phase 4 (below); never called after Phase 4 introduced. Recover from git history if needed. */

/* ══════════════════════════════════════════════════════════════════════════════
   PHASE 4 — Per-sequence labor-hour overrides, column resize/sort/hide
              persistence, freeze-pane confirmation, building filter
   Spec §11 Phase 4 + §8 + ui-standards.md "Tables"
   Storage keys (suffixed per ui-standards persistence pattern):
     sget('ch_tbl_col_widths_pricing_tbl_' + projId)  — col width map {colIdx: px}
     sget('ch_tbl_hidden_pricing_tbl_' + projId)       — hidden col set [colIdx,...]
   Sort state: module-level _pricingSortState per projId — NOT persisted (per spec).
   Labor overrides: stored in en_pricing_estimate_{projId}.laborOverrides[seqKey] = hrs
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Per-project sort state (module-level; resets on page reload per spec) ── */
var _pricingSortState = {}; // projId → { col: colIdx, dir: 'asc'|'desc'|null }

/* ── Per-project building filter state (module-level) ── */
var _pricingBldgFilter = {}; // projId → building name or '' for All

/* ── Column definitions (indices 0-13 for 14-col default layout)
   col 0:  Include (checkbox) — frozen, no-sort
   col 1:  Building — frozen, sortable
   col 2:  Item — sortable
   col 3:  Type — sortable
   col 4:  Equipment — sortable
   col 5:  Qty — sortable (numeric)
   col 6:  SKU — sortable
   col 7:  List — sortable (numeric) — entry.list from catalog
   col 8:  Net — sortable (numeric) — entry.net (multiplier×list or CSV net)
   col 9:  Contract (40%) — sortable (numeric) — contractPct×list, always live-computed
   col 10: Hours — sortable (numeric) — labor hours, phase-2 rows only
   col 11: Rate — sortable (numeric) — cc78ac9e: the $/hr labor rate applied to phase-2 Hours to
           produce Line Total (en_pricing_config.hourlyRate, fallback COST_LABOR_RATE_DEFAULT).
           Display-only — never affects unitPrice/lineTotal math, which _pricingApplyLaborOverrides
           already computes upstream of rendering.
   col 12: Line Total — sortable (numeric) — driven by basis selector
   col 13: Impact — no-sort — Phase 5 savings badge
   col 14: Notes — sortable
   ─────────────────────────────────────────────────────────────────────────── */
var PRICING_TBL_COLS = [
  { label: 'Incl', noSort: true, noHide: true, numeric: false, minWidth: 36 }, // 0
  { label: 'Building', noSort: false, noHide: false, numeric: false, minWidth: 90 }, // 1
  { label: 'Item', noSort: false, noHide: false, numeric: false, minWidth: 120 }, // 2
  { label: 'Type', noSort: false, noHide: false, numeric: false, minWidth: 70 }, // 3
  { label: 'Equipment', noSort: false, noHide: false, numeric: false, minWidth: 120 }, // 4 — widened for "(N blocked, N partial)" suffix (item 5a317ac7)
  { label: 'Qty', noSort: false, noHide: false, numeric: true, minWidth: 40 }, // 5
  { label: 'SKU', noSort: false, noHide: false, numeric: false, minWidth: 100 }, // 6
  { label: 'List', noSort: false, noHide: false, numeric: true, minWidth: 70 }, // 7
  { label: 'Net', noSort: false, noHide: false, numeric: true, minWidth: 70 }, // 8
  { label: 'Contract', noSort: false, noHide: false, numeric: true, minWidth: 110 }, // 9 — widened (0ae36950) to fit the merged-row side-by-side sensor-price + hours-input layout
  { label: 'Hours', noSort: false, noHide: false, numeric: true, minWidth: 70 }, // 10 — labor hours, split out of Contract (phase 4923ca9b/75827077)
  { label: 'Rate', noSort: false, noHide: false, numeric: true, minWidth: 70 }, // 11 — cc78ac9e: labor $/hr rate, restored between Hours and Line Total
  { label: 'Line Total', noSort: false, noHide: false, numeric: true, minWidth: 80 }, // 12 — label overridden at render time with active basis
  {
    label: 'Impact',
    noSort: true,
    noHide: false,
    numeric: false,
    minWidth: 170, // 13 — Phase 5 savings-tier badge + (0ae36950) the $-savings-range chip moved here from Notes
    isImpactCol: true,
  },
  { label: 'Notes', noSort: false, noHide: false, numeric: false, minWidth: 80 }, // 14
];

/* ── Apply labor overrides to a cloned row list ──────────────────────────── */
function _pricingApplyLaborOverrides(projId, rows) {
  var est = _pricingGetEstimate(projId);
  var overrides = est.laborOverrides || {};
  var installOverrides = est.installHoursOverrides || {}; // Deliverable E, keyed by _pointKey — same
  // "per device TYPE, not per row instance" design as laborOverrides/seqKey above.
  var cfg = _pricingGetConfig();
  var hourlyRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
  return rows.map(function (row) {
    if (row.phase === 2 && row.seqKey) {
      var overrideHrs = overrides[row.seqKey];
      if (overrideHrs == null) return row; // no override → keep original
      var hrs = parseFloat(overrideHrs);
      if (isNaN(hrs) || hrs < 0) return row;
      var cloned = Object.assign({}, row);
      cloned.hrsPerUnit = hrs;
      cloned.unitPrice = parseFloat((hrs * hourlyRate).toFixed(2));
      cloned.lineTotal = parseFloat((hrs * row.qty * hourlyRate).toFixed(2));
      cloned.note = ''; // hrs displayed in col 9 spinner; no static note needed (item 5a317ac7)
      return cloned;
    }
    // Deliverable E: install-hours override for Phase 1 hardware rows. Recomputes on top of the
    // row's own partsUnitPrice/partsLineTotal (raw parts, pre-install — stamped by buildCatalogRows
    // and preserved through the optimizer substitution path) so an override never double-counts
    // the DEFAULT install labor that's already baked into unitPrice/lineTotal.
    if (row.phase === 1 && !row.ioOnly && row._pointKey) {
      var overrideInstHrs = installOverrides[row._pointKey];
      if (overrideInstHrs == null) return row;
      var instHrs = parseFloat(overrideInstHrs);
      if (isNaN(instHrs) || instHrs < 0) return row;
      var instRate = row.installLaborRate != null ? row.installLaborRate : cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
      var newInstallTotal = parseFloat((instHrs * row.qty * instRate).toFixed(2));
      var instCloned = Object.assign({}, row);
      instCloned.installHours = instHrs;
      instCloned.installLaborTotal = newInstallTotal;
      instCloned.unitPrice =
        row.partsUnitPrice != null ? parseFloat((row.partsUnitPrice + instHrs * instRate).toFixed(2)) : null;
      instCloned.lineTotal =
        row.partsLineTotal != null ? parseFloat((row.partsLineTotal + newInstallTotal).toFixed(2)) : null;
      return instCloned;
    }
    return row;
  });
}

/* ── Save labor-hour override for one sequence key ── */
function _pricingSeqHrsChange(projId, seqKey, newHrsStr) {
  var hrs = parseFloat(newHrsStr);
  var est = _pricingGetEstimate(projId);
  if (!est.laborOverrides) est.laborOverrides = {};
  if (isNaN(hrs) || hrs < 0) {
    delete est.laborOverrides[seqKey];
  } else {
    est.laborOverrides[seqKey] = hrs;
  }
  _pricingSetEstimate(projId, est);
  // Recompute and re-render
  initCostEstimateTab(projId);
}

/* ── Reset one (or all) labor-hour overrides to default ── */
function _pricingSeqHrsReset(projId, seqKey) {
  var est = _pricingGetEstimate(projId);
  if (!est.laborOverrides) est.laborOverrides = {};
  if (seqKey) {
    delete est.laborOverrides[seqKey];
  } else {
    est.laborOverrides = {};
  }
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── Save install-hours override for one device point key — Deliverable E, mirrors
   _pricingSeqHrsChange above exactly (same per-TYPE-not-per-row storage design,
   _pricingApplyLaborOverrides reads both maps side by side). ── */
function _pricingInstallHrsChange(projId, pointKey, newHrsStr) {
  var hrs = parseFloat(newHrsStr);
  var est = _pricingGetEstimate(projId);
  if (!est.installHoursOverrides) est.installHoursOverrides = {};
  if (isNaN(hrs) || hrs < 0) {
    delete est.installHoursOverrides[pointKey];
  } else {
    est.installHoursOverrides[pointKey] = hrs;
  }
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── Reset one (or all) install-hours overrides to default — mirrors _pricingSeqHrsReset ── */
function _pricingInstallHrsReset(projId, pointKey) {
  var est = _pricingGetEstimate(projId);
  if (!est.installHoursOverrides) est.installHoursOverrides = {};
  if (pointKey) {
    delete est.installHoursOverrides[pointKey];
  } else {
    est.installHoursOverrides = {};
  }
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── Qty override handlers (Fix: item 6f26cbfd) ──────────────────────────── */
function _pricingQtyOverride(projId, rowId, valStr) {
  var val = parseFloat(valStr);
  var est = _pricingGetEstimate(projId);
  if (!est.qtyOverrides) est.qtyOverrides = {};
  if (isNaN(val) || val <= 0) {
    delete est.qtyOverrides[rowId];
  } else {
    est.qtyOverrides[rowId] = val;
  }
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

function _pricingQtyReset(projId, rowId) {
  var est = _pricingGetEstimate(projId);
  if (!est.qtyOverrides) est.qtyOverrides = {};
  delete est.qtyOverrides[rowId];
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── Apply qty overrides to a cloned row list ────────────────────────────── */
function _pricingApplyQtyOverrides(projId, rows) {
  var est = _pricingGetEstimate(projId);
  var overrides = est.qtyOverrides || {};
  return rows.map(function (row) {
    var key = row._baseId || row.id;
    var overrideQty = overrides[key];
    if (overrideQty == null) return row;
    var qty = parseFloat(overrideQty);
    if (isNaN(qty) || qty <= 0) return row;
    var cloned = Object.assign({}, row);
    cloned.qty = qty;
    // Recompute lineTotal with overridden qty (unitPrice is already set by labor/catalog logic)
    if (cloned.unitPrice != null) {
      cloned.lineTotal = parseFloat((cloned.unitPrice * qty).toFixed(2));
    }
    // Deliverable E: installLaborTotal/partsLineTotal scale with qty too — otherwise a qty
    // override on a noSku row (unitPrice stays null until a manual price is typed in) would leave
    // installLaborTotal computed against the OLD qty when _pricingComputeTotals's manual-price
    // branch later reads it.
    if (cloned.phase === 1 && !cloned.ioOnly && cloned.installHours != null) {
      var _qtyOvInstRate = cloned.installLaborRate != null ? cloned.installLaborRate : COST_LABOR_RATE_DEFAULT;
      cloned.installLaborTotal = parseFloat((cloned.installHours * qty * _qtyOvInstRate).toFixed(2));
      if (cloned.partsUnitPrice != null) {
        cloned.partsLineTotal = parseFloat((cloned.partsUnitPrice * qty).toFixed(2));
      }
    }
    return cloned;
  });
}

/* ── Unit-price override for any row (extends existing manualPrices) ─────── */
function _pricingUnitPriceOverride(event, projId, rowId) {
  var val = parseFloat(event.target.value);
  var est = _pricingGetEstimate(projId);
  if (!est.manualPrices) est.manualPrices = {};
  est.manualPrices[rowId] = isNaN(val) ? '' : val;
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

/* ── Note override handlers ──────────────────────────────────────────────── */
function _pricingNoteOverride(projId, rowId, val) {
  var est = _pricingGetEstimate(projId);
  if (!est.noteOverrides) est.noteOverrides = {};
  if (!val || !val.trim()) {
    delete est.noteOverrides[rowId];
  } else {
    est.noteOverrides[rowId] = val.trim();
  }
  _pricingSetEstimate(projId, est);
  // No full re-render needed — note is self-contained; footer not affected
}

/* ── Column width helpers (persistence per ui-standards) ─────────────────── */
function _pricingGetColWidths(projId) {
  return sget('ch_tbl_col_widths_pricing_tbl_' + projId, {});
}
function _pricingSetColWidths(projId, widths) {
  sset('ch_tbl_col_widths_pricing_tbl_' + projId, widths);
}

/* ── Column hidden set helpers ─────────────────────────────────────────────── */
function _pricingGetHiddenCols(projId) {
  return sget('ch_tbl_hidden_pricing_tbl_' + projId, []);
}
function _pricingSetHiddenCols(projId, hiddenArr) {
  sset('ch_tbl_hidden_pricing_tbl_' + projId, hiddenArr);
}

/* ── Column-schema migration (review-phase4.md #2; extended cc78ac9e) ──────
   PRICING_TBL_COLS gained a new "Hours" column at index 10 in Phase 4, which
   shifted every column previously at index >=10 up by one (old 10 = Line
   Total → new 11, old 11 = Impact → new 12, old 12 = Notes → new 13). cc78ac9e
   (2026-07-10) then restored the "Rate" column at index 11, shifting the
   Phase-4 schema's columns >=11 up by one again (v2's 11 = Line Total → v3's
   12, v2's 12 = Impact → v3's 13, v2's 13 = Notes → v3's 14). Both column
   widths (ch_tbl_col_widths_pricing_tbl_<id>) and hidden columns
   (ch_tbl_hidden_pricing_tbl_<id>) are persisted keyed by raw PRICING_TBL_COLS
   index with no migration, so any state saved before either deploy silently
   misapplies to the wrong column afterward.
   PRICING_COL_SCHEMA_VERSION bump the schema below your PRICING_TBL_COLS
   change if you insert/remove a column again, and extend SHIFT_STEPS to
   match. Migration now runs as a CHAIN of per-version shift steps (one entry
   per version bump, keyed by the threshold index that version's insertion
   used) so a project's marker can be at ANY earlier version (1, 2, ...) and
   still land on the exact current schema — not just the most recent bump.
   The stored per-project version marker keeps this idempotent — it only
   shifts once, never re-shifts an already-migrated or fresh map, and never
   deletes the user's saved widths/hidden set, only relocates them to the
   column they were originally set for. */
var PRICING_COL_SCHEMA_VERSION = 3; // 3 = cc78ac9e (Rate column inserted at index 11)
// One entry per version bump: shifting FROM (entry index + 1) TO (entry index + 2) inserted a
// column at `threshold` — every existing index >= threshold moves up by one.
var _PRICING_COL_SCHEMA_SHIFT_STEPS = [
  { fromVer: 1, threshold: 10 }, // v1 -> v2: Hours column inserted at index 10 (Phase 4)
  { fromVer: 2, threshold: 11 }, // v2 -> v3: Rate column inserted at index 11 (cc78ac9e)
];
function _pricingGetColSchemaVersion(projId) {
  return sget('ch_tbl_colschema_ver_pricing_tbl_' + projId, 1); // 1 = pre-Phase-4 (no marker ever written)
}
function _pricingSetColSchemaVersion(projId, ver) {
  sset('ch_tbl_colschema_ver_pricing_tbl_' + projId, ver);
}
function _pricingMigrateColSchema(projId) {
  var storedVer = _pricingGetColSchemaVersion(projId);
  if (storedVer >= PRICING_COL_SCHEMA_VERSION) return; // already migrated (or fresh) — idempotent no-op

  var widths = _pricingGetColWidths(projId);
  var hidden = _pricingGetHiddenCols(projId);

  _PRICING_COL_SCHEMA_SHIFT_STEPS.forEach(function (step) {
    if (storedVer > step.fromVer) return; // already past this step
    var newWidths = {};
    Object.keys(widths).forEach(function (k) {
      var ki = parseInt(k, 10);
      if (isNaN(ki)) {
        newWidths[k] = widths[k]; // preserve any non-numeric marker key untouched
      } else {
        newWidths[ki >= step.threshold ? ki + 1 : ki] = widths[k];
      }
    });
    widths = newWidths;
    hidden = hidden.map(function (ci) {
      return ci >= step.threshold ? ci + 1 : ci;
    });
  });

  _pricingSetColWidths(projId, widths);
  _pricingSetHiddenCols(projId, hidden);
  _pricingSetColSchemaVersion(projId, PRICING_COL_SCHEMA_VERSION);
}

/* ── Sort rows by column index ─────────────────────────────────────────────── */
function _pricingSortRows(rows, colIdx, dir) {
  if (!dir || colIdx == null) return rows;
  var col = PRICING_TBL_COLS[colIdx];
  var sorted = rows.slice();
  sorted.sort(function (a, b) {
    var av = _pricingRowColValue(a, colIdx);
    var bv = _pricingRowColValue(b, colIdx);
    var cmp = 0;
    if (col && col.numeric) {
      var an = parseFloat(av);
      var bn = parseFloat(bv);
      cmp =
        (isNaN(an) ? -Infinity : an) < (isNaN(bn) ? -Infinity : bn)
          ? -1
          : (isNaN(an) ? -Infinity : an) > (isNaN(bn) ? -Infinity : bn)
            ? 1
            : 0;
    } else {
      var as = String(av || '').toLowerCase();
      var bs = String(bv || '').toLowerCase();
      cmp = as < bs ? -1 : as > bs ? 1 : 0;
    }
    return dir === 'desc' ? -cmp : cmp;
  });
  return sorted;
}

/* ── Extract a sortable value from a row for a given column ─────────────────
   Group header and phase header rows have no colIdx values — they sort last. ── */
function _pricingRowColValue(row, colIdx) {
  // Only real data rows have these fields; group headers won't reach here
  switch (colIdx) {
    case 1:
      return row.building || '';
    case 2:
      return row.item || '';
    case 3:
      return row.type || '';
    case 4:
      return row.equipment || '';
    case 5:
      return row.qty != null ? row.qty : 0;
    case 6:
      return row.sku || '';
    case 7:
      return row.listPrice != null ? row.listPrice : -1;
    case 8:
      return row.netPrice != null ? row.netPrice : -1;
    case 9:
      return row.contractPrice != null ? row.contractPrice : -1;
    case 10:
      // Hours (phase 4923ca9b/75827077) — sortable/hide-empty value is the row's base
      // hrsPerUnit, same "raw field, not live override" convention already used by case 9
      // (Contract sorts by contractPrice, not a typed-in manualPrice override either).
      return row.hrsPerUnit != null ? row.hrsPerUnit : -1;
    case 11:
      // Rate (cc78ac9e) — the single global labor $/hr rate, only meaningful for phase-2 rows
      // that actually carry hours (same "row has this column's thing" convention as case 10).
      return row.phase === 2 && row.seqKey ? _pricingGetConfig().hourlyRate || COST_LABOR_RATE_DEFAULT : -1;
    case 12:
      return row.lineTotal != null ? row.lineTotal : -1;
    case 14:
      return row.note || '';
    default:
      return '';
  }
}

/* ── Building filter handler ─────────────────────────────────────────────── */
function _pricingBldgFilterChange(projId, val) {
  _pricingBldgFilter[projId] = val;
  initCostEstimateTab(projId);
}

/* ── Row sort control (979fd1af, item 0ae36950) ──────────────────────────────
   Matt's ask: "the user should have the ability to sort by best building return and by
   best equipment return." Module-level, per-project, resets on reload — same persistence
   rule as _pricingSortState/_pricingBldgFilter above (ui-standards.md: "Sort persists per
   session; resets on page reload — do NOT persist sort across sessions").
   Recommended tier ONLY — it's the only tier with savings-weight fields (_savingsWeight/
   _effectiveCostTier) to score against; Compliance/Full-Scope never show this control.
     'default'   — natural/source order (buildRecommendedRows' own order; see 0ae36950 note
                   there — this is NOT the old hardcoded descending-ROI order, which has been
                   removed; Matt said he never asked for that default).
     'building'  — group headers ordered by descending building ROI score (lifted verbatim
                   from the removed Batch 2c logic — see _pricingComputeBldgRoiScores).
     'equipment' — flat ranked list of equipment rows (merged + standalone) by the same
                   savings-per-cost ratio, across ALL buildings; no building grouping/subtotal
                   rows in this mode (subtotals only make sense grouped) — Building stays a
                   visible per-row column. See the tier==='recommended' && sortMode==='equipment'
                   branch in initCostEstimateTab's table-body assembly.
   ─────────────────────────────────────────────────────────────────────────── */
var _pricingRowSortMode = {}; // projId → 'default' | 'building' | 'equipment'
function _pricingGetRowSortMode(projId) {
  return _pricingRowSortMode[projId] || 'default';
}
function _pricingRowSortModeChange(projId, val) {
  _pricingRowSortMode[projId] = val;
  initCostEstimateTab(projId);
}

/* ── Score a building for the 'building' sort mode — same ratio Batch 2c used:
   max over the building's phase-2 rows of (savings weight / effective cost tier). ── */
function _pricingComputeBldgRoiScores(rows) {
  var scores = {};
  rows.forEach(function (r) {
    if (r.phase !== 2 || !r.building) return;
    var s = (r._savingsWeight || 0) / Math.max(r._effectiveCostTier || 1, 1);
    if (scores[r.building] == null || s > scores[r.building]) scores[r.building] = s;
  });
  return scores;
}

/* ── Score a single equipment row for the 'equipment' flat-rank sort mode. Standalone
   hardware-only rows (no seqKey — a sensor with no blocking sequence in this project) carry
   no savings data, so they sink to the bottom of the ranking (score -1, below any real
   sequence's 0). Merged rows are scored from their sequence half. ── */
function _pricingEquipRowScore(row) {
  // phase-1 standalone hw rows (no blocking sequence) never have _savingsWeight stamped —
  // score them below any real sequence (whose minimum possible score is 0) so they sink to
  // the bottom of the 'equipment' ranked list rather than the top.
  if (row.phase !== 2) return -1;
  // 2026-07-27 (Matt: "DCV should be highest priority", stated twice) — priorityBonus is an
  // explicit, data-driven premium (defined per-measure in SEQUENCE_SAVINGS_IMPACT, not a
  // hardcoded seqKey check here) added on top of the raw weight/effectiveCostTier ROI ratio. It
  // expresses factors that ratio cannot: install ease and diagnostic value, for measures where
  // that is genuinely true (today: DCV only — see demandCtrl's comment block for the full
  // rationale and the worst-case-still-wins math). A measure with no priorityBonus field behaves
  // exactly as before (bonus defaults to 0). This is read by every caller of this function —
  // Recommended-tier Fit-to-Budget membership (_pricingGreedyPrefix via _pricingBuildRoiUnits) AND
  // the calendar-phase packer (_pricingComputeRecommendedTimeline) — so DCV ranks first in both
  // "does it make the tier" and "which phase does it land in", not just in table display order.
  var _impactDef =
    row.seqKey && typeof SEQUENCE_SAVINGS_IMPACT !== 'undefined' ? SEQUENCE_SAVINGS_IMPACT[row.seqKey] : null;
  var _priorityBonus = (_impactDef && _impactDef.priorityBonus) || 0;
  return _priorityBonus + (row._savingsWeight || 0) / Math.max(row._effectiveCostTier || 1, 1);
}

/* ── Pair phase-1 hardware rows with the phase-2 sequence row they block, within ONE
   building's row set (b771dec6 Batch 5 pairing logic, factored out so both the grouped
   render loop and the flat 'equipment' sort mode share one implementation instead of two
   copies drifting apart). Sequences with no blocking sensors, or whose blocking sensors
   are absent/already claimed, stay standalone.
   c82cc354 REV 2 (Step 2a): a sequence now claims ALL of its blocking hardware rows in
   the building, not just the first match — the shipped one-hw-per-sequence `break`
   stranded additional blocking sensors (e.g. economizer's second sensor, OAT) outside
   the bundle. A measure is never sold without every sensor it needs, and a blocking
   sensor never appears standalone once its sequence claims it. Shared by the grouped
   render loop, the flat 'equipment' sort mode, and (new) the Recommended/Fit-to-Budget
   membership engine (_pricingBuildRoiUnits) — one implementation, upgraded once.
   JOCO $ effect of this change: +$160 (7 previously-stranded OAT rows) vs the old
   claim-one behavior — logged in dashboardlogic.md. ── */
function _pricingPairHwSeq(hw, lb) {
  var claimedHwIds = {};
  var claimedSeqIds = {};
  var pairedSeqByHwId = {};
  lb.forEach(function (seqRow) {
    // 2026-07-28 (fix/roi-no-hardware-first-per-unit): a 'ready' split row's units already have
    // every blocking sensor this seqKey needs (see buildCatalogRows' _hwGroup stamping) — it must
    // never claim a hardware gap row that belongs to this building's separate 'gap' split row for
    // the same seqKey. Without this guard, row order inside `lb` (ready row is generated before
    // the gap row for the same seqKey) would let the ready row claim the shared building-level
    // hardware gap row first, leaving the gap row — the one that actually needs it — unpaired.
    if (seqRow._hwGroup === 'ready') return;
    var blocking = (seqRow.seqKey && SEQUENCE_BLOCKING_SENSORS[seqRow.seqKey]) || [];
    if (!blocking.length) return; // no blocking sensors → standalone
    hw.forEach(function (_hwCandidate) {
      if (claimedHwIds[_hwCandidate.id]) return; // already claimed by another sequence
      // _hwRowKeyMatchesBlocking (see _HW_ROW_KEY_ALIASES above) — a hardware row's _pointKey can
      // differ from the blocking-sensor key that requires it (co2_zone_standalone/
      // damperPositionControl re-pricing splits) — not a plain equality check.
      if (_hwCandidate._pointKey && _hwRowKeyMatchesBlocking(_hwCandidate._pointKey, blocking)) {
        claimedHwIds[_hwCandidate.id] = true;
        claimedSeqIds[seqRow.id] = true;
        pairedSeqByHwId[_hwCandidate.id] = seqRow;
      }
    });
  });
  return { claimedHwIds: claimedHwIds, claimedSeqIds: claimedSeqIds, pairedSeqByHwId: pairedSeqByHwId };
}

/* ── _pricingBuildRoiUnits(rows) ─────────────────────────────────────────────
   c82cc354 REV 2 (Step 2a) — shared membership-candidate builder. Walks
   buildings in row order (the order they appear in `rows`); for each phase-2
   sequence row whose SEQUENCE_SAVINGS_IMPACT type === 'savings', builds ONE
   unit = that sequence row + every phase-1 hardware row _pricingPairHwSeq
   claims for it (a measure is never sold without the hardware it needs).
   cost = sum of the unit's row lineTotals (override-applied by the caller
   BEFORE calling this); score = _pricingEquipRowScore(seqRow) — the SAME
   ranking the 'equipment' sort mode and the shipped Fit-to-Budget engine use.
   Standalone hardware (no blocking sequence) and enabler/safety/null-impact
   sequences NEVER create a unit — they are not "measures" to rank/sell, so
   they never enter Recommended-tier membership or the Fit-to-Budget pool.
   Used by buildRecommendedRows (the new budget-driven membership engine) and
   by _pricingComputeBudgetFitPlan (retained for backcompat/non-Recommended
   callers — see Step 2c).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBuildRoiUnits(rows) {
  var order = [];
  var bldgSeen = {};
  rows.forEach(function (r) {
    if (r.building && !bldgSeen[r.building]) {
      bldgSeen[r.building] = true;
      order.push(r.building);
    }
  });

  var units = [];
  order.forEach(function (bName) {
    var bRows = rows.filter(function (r) {
      return r.building === bName;
    });
    var hw = bRows.filter(function (r) {
      return r.phase === 1;
    });
    var lb = bRows.filter(function (r) {
      return r.phase === 2;
    });
    var pairs = _pricingPairHwSeq(hw, lb);

    // Invert pairedSeqByHwId (hwId -> seqRow) into seqId -> [hwRow, ...] so a
    // sequence that claimed multiple hardware rows becomes ONE unit, not one
    // per claimed hw row (which would double-count the sequence's lineTotal).
    var hwBySeqId = {};
    hw.forEach(function (hwRow) {
      var seqRow = pairs.pairedSeqByHwId[hwRow.id];
      if (!seqRow) return;
      if (!hwBySeqId[seqRow.id]) hwBySeqId[seqRow.id] = [];
      hwBySeqId[seqRow.id].push(hwRow);
    });

    lb.forEach(function (seqRow) {
      if (!seqRow.seqKey) return;
      var def = SEQUENCE_SAVINGS_IMPACT[seqRow.seqKey];
      if (!def || def.type !== 'savings') return; // enabler/safety/null-impact never create units

      var claimedHw = hwBySeqId[seqRow.id] || [];
      var cost = seqRow.lineTotal || 0;
      var toggleKeys = [seqRow._baseId || seqRow.id];
      claimedHw.forEach(function (hwRow) {
        cost += hwRow.lineTotal || 0;
        toggleKeys.push(hwRow._baseId || hwRow.id);
      });

      // Unit-atomicity invariant (2026-07-28, fix/roi-no-hardware-first-per-unit) — a sequence
      // is never supposed to be sold without the hardware it needs (header comment above). This
      // was always true implicitly but had no guard; now that Change 2 sorts on "needs hardware"
      // as a primary key, a silent violation here (a 'gap'-group row with real blocking sensors
      // but zero claimed hardware) would make a unit LOOK like a no-hardware unit and jump the
      // queue incorrectly. Non-fatal — logs so it's visible without breaking rendering.
      var _seqBlocking = (seqRow.seqKey && SEQUENCE_BLOCKING_SENSORS[seqRow.seqKey]) || [];
      if (seqRow._hwGroup === 'gap' && _seqBlocking.length > 0 && claimedHw.length === 0) {
        console.warn(
          '[pricing-estimator] unit atomicity violation: ' +
            seqRow.building +
            '/' +
            seqRow.seqKey +
            ' is flagged as needing hardware but claimed none',
        );
      }

      units.push({
        toggleKeys: toggleKeys,
        cost: cost,
        score: _pricingEquipRowScore(seqRow),
        seqRow: seqRow,
        hwRows: claimedHw,
      });
    });
    // Standalone hardware rows (no blocking sequence) never create a unit —
    // they are not membership candidates for Recommended/Fit-to-Budget.
  });
  return units;
}

/* ── _pricingUnitNeedsHardware(u) / _pricingSortUnitsNoHwFirst(units) ─────────────────────────
   Change 2 (2026-07-28, fix/roi-no-hardware-first-per-unit) — Matt: "I know I told you to
   prioritize DCV but we really should be prioritizing sequences that don't require installing
   sensors first." This REVISES the earlier DCV priority-bonus direction, not the priorityBonus
   value itself (left at 1.75 — it still correctly orders DCV WITHIN each hardware-readiness
   group; see SEQUENCE_SAVINGS_IMPACT.demandCtrl's comment).

   Problem the old single-key sort had: _pricingEquipRowScore is priorityBonus + weight /
   effectiveCostTier. A DCV unit that STILL needs its CO2 sensor (1.75 + 2.5/2 = 3.0) could tie a
   programming-only duct-static-reset unit (0 + 3/1 = 3.0) — exactly the ordering Matt is
   rejecting. Tuning the bonus/divisor further to force a particular ordering was explicitly
   ruled out (plan: "Do NOT implement this by inflating a bonus or tuning a divisor... Make it an
   explicit two-key sort"). This is that explicit two-key sort: hardware-need is the PRIMARY key
   (no-hardware-required units always sort before hardware-required units, as a whole group), ROI
   score (_pricingEquipRowScore, unchanged) is the SECONDARY key within each group.

   Implementation note: the two groups are sorted+diversified INDEPENDENTLY, then concatenated
   (no-hardware group first) — never re-merged into one score-sorted array. If they were merged
   and diversified as one list, a same-score tie that happens to straddle the group boundary
   (e.g. a hardware-needing DCV unit at 3.0 next to a no-hardware duct-static unit also at 3.0)
   would look like one contiguous tie group to _pricingDiversifyTiedUnits (which only checks
   score, not hw-need) and its family round-robin could shuffle a hardware-needing unit ahead of
   a no-hardware one, silently reintroducing the exact ordering this change removes. Splitting
   first makes that impossible: no unit in the hardware-required group can ever precede any unit
   in the no-hardware group, regardless of score.

   `u.hwRows` (the _pricingBuildRoiUnits unit shape) is authoritative for "needs hardware" — a
   'ready'-group seqRow (buildCatalogRows' per-unit split, Change 1) never claims a hardware row
   (see _pricingPairHwSeq), so hwRows.length > 0 exactly captures "this unit's atomic bundle
   includes an unclaimed sensor to install". The remapped unit shape used by
   _pricingComputeRecommendedTimeline (`{rows: [...], score, ...}`, no `hwRows` field) is handled
   via its `rows` array instead: `rows.some(r => r.phase === 1)` — true for any unit whose bundle
   contains a hardware row, including the defensive single-row leftover-fold-in units.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingUnitNeedsHardware(u) {
  if (u.hwRows) return u.hwRows.length > 0;
  if (u.rows) {
    return u.rows.some(function (r) {
      return r.phase === 1;
    });
  }
  return false;
}

function _pricingSortUnitsNoHwFirst(units) {
  var noHw = [];
  var needsHw = [];
  units.forEach(function (u) {
    (_pricingUnitNeedsHardware(u) ? needsHw : noHw).push(u);
  });
  var byScoreDesc = function (a, b) {
    return b.score - a.score;
  };
  noHw.sort(byScoreDesc);
  needsHw.sort(byScoreDesc);
  // _pricingDiversifyTiedUnits runs PER GROUP (see header comment) so the family round-robin can
  // never cross the no-hardware/needs-hardware boundary.
  return _pricingDiversifyTiedUnits(noHw).concat(_pricingDiversifyTiedUnits(needsHw));
}

/* ── _pricingGreedyPrefix(units, ceiling) ────────────────────────────────────
   c82cc354 REV 2 (Step 2a) — the shipped v631 Fit-to-Budget greedy walk,
   extracted so buildRecommendedRows can reuse it as THE membership engine.
   Sort units score-desc (STABLE — Array#sort in this engine preserves
   relative order of equal-score elements, same tie-break the shipped Fit
   preview always produced) then walk keeping every unit that still fits under
   `ceiling`, skipping (never stopping at) ones that don't — a cheaper
   lower-ranked unit later in the list can still fit even after a pricier
   higher-ranked one was skipped. Returns kept/excluded toggle keys, the kept
   running total, and the kept unit objects themselves (rows can be recovered
   from unit.seqRow/unit.hwRows without re-deriving toggle keys).

   2026-07-27 (fix/phase-table-diversity-and-grouping): runs the SAME measure-family diversity
   tie-break the calendar-phase packer uses (_pricingDiversifyTiedUnits) before the greedy walk
   below. Without this, a family that ties on score with a much larger candidate pool (e.g. DCV
   tied with dsp/sat-reset after the 2026-07-27 priorityBonus fix) could still have the greedy
   MEMBERSHIP walk (not just phase placement) fill the whole ceiling with the larger pool before
   ever reaching the smaller one — real-data verification found exactly this on JOCO before this
   line was added. See _pricingDiversifyTiedUnits' header comment for the full diagnosis.

   2026-07-28 (fix/roi-no-hardware-first-per-unit): sort/diversify replaced with
   _pricingSortUnitsNoHwFirst — see its header comment. No-hardware units now fill the ceiling
   before any hardware-needing unit is offered, at every ceiling size (Recommended-tier
   membership AND any smaller Fit-to-Budget ceiling a caller passes in).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingGreedyPrefix(units, ceiling) {
  var sorted = _pricingSortUnitsNoHwFirst(units);

  var running = 0;
  var keepKeys = [];
  var excludeKeys = [];
  var keptUnits = [];
  sorted.forEach(function (u) {
    if (running + u.cost <= ceiling) {
      running += u.cost;
      keepKeys = keepKeys.concat(u.toggleKeys);
      keptUnits.push(u);
    } else {
      excludeKeys = excludeKeys.concat(u.toggleKeys);
    }
  });

  return { keepKeys: keepKeys, excludeKeys: excludeKeys, total: running, keptUnits: keptUnits };
}

/* ── _pricingDiversifyTiedUnits(sortedUnits) ─────────────────────────────────────────────────
   Bug 2744e688 (2026-07-27, fix/phase-table-diversity-and-grouping): measure-family diversity
   tie-break for the calendar-phase packer (_pricingComputeRecommendedTimeline).

   Diagnosis (already established, not re-derived here): 24 real JOCO units tie at score 3 — 19
   ahu_sat_reset + 5 ahu_dsp_reset (both 'high' tier, weight 3, effectiveCostTier 1 — see
   SEQUENCE_SAVINGS_IMPACT above). Because Array#sort is stable, a plain score-desc sort left every
   sat-reset unit ahead of every dsp-reset unit within that tie (sat-reset units simply occur first
   in buildRecommendedRows' natural building order). The greedy first-fit walk then offered all 19
   sat-reset units to Phase 1 before ever reaching a dsp-reset unit, so Phase 1's 5-month envelope
   was exhausted by sat-reset alone — none of the 5 fan (dsp-reset) line items ($432.50-$1,730 each)
   ever got a chance to compete for the remaining slack, even though they scored identically. The
   same starvation pattern then propagated: whatever didn't fit Phase 1 fed Phase 2 next, in the
   SAME lopsided order, so fan energy was also starved out of Phase 3 ("remaining ventilation and
   fan optimization" per the client's base document).

   Fix: within a contiguous run of EXACTLY-tied scores (post score-desc sort), reorder by
   round-robin across seqKey ("measure family") — round 1 offers the first not-yet-offered unit of
   EVERY distinct family in the tie group (in their original relative order), round 2 offers the
   second of each, etc. This guarantees at least one instance of every tied family is offered to the
   greedy walk before a SECOND instance of any other tied family, so a family that fits the
   envelope even once is never crowded out purely by volume of an equally-scored sibling family.

   Constraints preserved:
     - Cross-score ranking is untouched — this function never reorders across a score boundary, so
       a higher-scoring unit can never be displaced by a lower-scoring one (only same-score units
       are ever reordered relative to each other).
     - This changes OFFER ORDER only, not the envelope/fit test — a family that genuinely cannot
       fit a phase (even offered first) still does not land there; nothing is force-fit by evicting
       better-scoring work.

   2026-07-27 (same day, DCV-priority composability fix): within a tie group, families carrying a
   SEQUENCE_SAVINGS_IMPACT.priorityBonus (today: demandCtrl/vav_dcv — see those entries' comments)
   are moved to the FRONT of the round-robin order, so they win every round's first pick — "highest
   priority" expressed WITHIN the tie, not by strictly outranking the tie into its own bracket
   (which was tried first and starved every other tied family out of Fit-to-Budget membership
   entirely — see the priorityBonus sizing note on demandCtrl). A priority family still only gets
   ONE extra pick per round, same as everyone else — round 2 still reaches every family that has a
   second instance — so this composes with (does not replace) the round-robin fairness for the
   remaining tied families. Generalizes automatically: any future measure flagged with
   priorityBonus gets the same front-of-round-robin treatment, no seqKey-specific branch here.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingDiversifyTiedUnits(sortedUnits) {
  var out = [];
  var i = 0;
  while (i < sortedUnits.length) {
    var j = i;
    while (j < sortedUnits.length && Math.abs(sortedUnits[j].score - sortedUnits[i].score) < 0.0001) j++;
    var tieGroup = sortedUnits.slice(i, j);
    if (tieGroup.length <= 1) {
      out.push(tieGroup[0]);
    } else {
      var byFamily = {};
      var familyOrder = [];
      var priorityFamilies = [];
      tieGroup.forEach(function (u) {
        var fam = (u.seqRow && u.seqRow.seqKey) || '__none__';
        if (!byFamily[fam]) {
          byFamily[fam] = [];
          var impactDef = typeof SEQUENCE_SAVINGS_IMPACT !== 'undefined' ? SEQUENCE_SAVINGS_IMPACT[fam] : null;
          if (impactDef && impactDef.priorityBonus) {
            priorityFamilies.push(fam);
          } else {
            familyOrder.push(fam);
          }
        }
        byFamily[fam].push(u);
      });
      // Priority families (DCV today) first, in their own relative order, then everyone else in
      // first-seen order — see the header comment above for why.
      familyOrder = priorityFamilies.concat(familyOrder);
      var maxLen = 0;
      familyOrder.forEach(function (fam) {
        if (byFamily[fam].length > maxLen) maxLen = byFamily[fam].length;
      });
      for (var r = 0; r < maxLen; r++) {
        familyOrder.forEach(function (fam) {
          if (byFamily[fam][r]) out.push(byFamily[fam][r]);
        });
      }
    }
    i = j;
  }
  return out;
}

/* ── Fit-to-Budget plan (174ad49a Phase 3, Mode B only) ───────────────────────
   Computes which Recommended-tier "units" (hw+seq pairs, or standalone rows — the
   SAME units _pricingEquipRowScore/_pricingPairHwSeq already rank for the existing
   'equipment' sort mode) to keep vs. exclude so the tier's grand total fits inside
   the Mode-B ceiling. Ranks best-ROI-per-dollar first (reusing _pricingEquipRowScore
   verbatim — not a new scoring formula), then walks the ranked list keeping every
   unit that still fits, skipping (not stopping at) ones that don't. Returns a full
   plan — kept/excluded toggle keys, before/after totals — WITHOUT writing anything,
   so the caller can show the user the exact effect before an explicit Apply.
   c82cc354 REV 2 (Step 2a/2c): reimplemented on top of the shared
   _pricingBuildRoiUnits/_pricingGreedyPrefix helpers (verbatim math, no new
   formula) instead of its own copy of the unit-build + greedy loop. The
   Recommended tier no longer has a UI entry point to this function — Recommended
   membership is now computed the SAME way directly inside buildRecommendedRows
   (Step 2b), so this function is effectively superseded there. It is RETAINED,
   unchanged in contract/return shape, for any non-Recommended caller and for
   backward compatibility with the stored budget.fitToBudget/fitExcludedIds/
   fitPrevToggleValues fields a past Apply may have written.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeBudgetFitPlan(projId) {
  var budget = _pricingGetBudget(projId);
  var comp = _pricingComputeBudgetTotal(budget);
  if (!comp || budget.mode !== 'recurring') return null;

  var estimate = _pricingGetEstimate(projId);
  var rows = buildRecommendedRows(projId);
  rows = _pricingApplyLaborOverrides(projId, rows);
  rows = _pricingApplyQtyOverrides(projId, rows);

  // Fix (174ad49a Phase B3 review-phase-b3.md Check C / required fix 1): a row the user
  // already manually excluded (rowToggles[key] === false) before ever opening Fit is not
  // Fit's to re-enable -- _pricingApplyBudgetFit only ever DEMOTES (writes false for
  // excludeKeys); it never promotes a keepKeys row back to true. So an already-off row must
  // never enter the candidate pool or the running/afterTotal math here, or Preview can
  // promise a total Apply will never actually deliver. Mirrors the exact `toggled !== false`
  // test _pricingComputeTotals already uses (line ~1934-1936) so afterTotal truthfully
  // predicts what _pricingComputeTotals will show after Apply, in every case. beforeTotal
  // below still uses the full, unfiltered `rows` via _pricingComputeTotals, which already
  // honors toggles correctly on its own -- only the units/greedy pool needed this filter.
  var poolRows = rows.filter(function (r) {
    var toggleKey = r._baseId || r.id;
    return estimate.rowToggles[toggleKey] !== false;
  });

  var units = _pricingBuildRoiUnits(poolRows);
  var plan = _pricingGreedyPrefix(units, comp.total);

  var totals = _pricingComputeTotals(rows, estimate);
  return {
    ceiling: comp.total,
    ceilingLabel: comp.basisLabel,
    beforeTotal: totals.grand,
    afterTotal: plan.total,
    keepKeys: plan.keepKeys,
    excludeKeys: plan.excludeKeys,
    excludedCount: plan.excludeKeys.length,
    totalCount: plan.keepKeys.length + plan.excludeKeys.length,
  };
}

function _pricingOpenBudgetFitPreview(projId, btn) {
  _pricingCloseSettingsPopover(projId);
  // cost-estimate-toolbar-2026-07-10: this action can now also be triggered from the standalone
  // toolbar Budget popover (same "Fit to Budget…" button, shared markup) — close it too so it
  // doesn't sit open behind this preview popover.
  _pricingCloseBudgetPopover(projId);
  var plan = _pricingComputeBudgetFitPlan(projId);
  if (!plan) {
    if (typeof showToast === 'function') showToast('Set a Recurring Services Budget amount first.');
    return;
  }
  var pop = document.createElement('div');
  pop.id = 'pricing-budgetfit-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:10px 12px',
    'z-index:900',
    'min-width:260px',
    'max-width:320px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');
  pop.innerHTML =
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Fit to Budget — Preview</div>' +
    '<div style="color:var(--text2);line-height:1.6;margin-bottom:8px">' +
    'Ceiling: <strong style="color:var(--text)">' +
    plan.ceilingLabel +
    '</strong><br>' +
    'Current Recommended total: <strong style="color:var(--text)">' +
    _pricingFmt(plan.beforeTotal) +
    '</strong><br>' +
    'After fitting: <strong style="color:var(--text)">' +
    _pricingFmt(plan.afterTotal) +
    '</strong><br>' +
    '<strong style="color:var(--warn)">' +
    plan.excludedCount +
    ' of ' +
    plan.totalCount +
    ' item(s)</strong> would be unchecked (kept items are ranked best ROI-per-dollar first) — ' +
    'excluded items are NOT deleted, just unchecked; re-check any of them individually afterward, ' +
    'or use Clear to restore all of them at once.' +
    '</div>' +
    '<div style="display:flex;gap:6px;justify-content:flex-end">' +
    '<button class="btn btn-ghost btn-sm" onclick="_pricingCloseBudgetFitPopover(\'' +
    projId +
    '\')" style="cursor:pointer">Cancel</button>' +
    '<button class="btn btn-sm" onclick="_pricingApplyBudgetFit(\'' +
    projId +
    '\')" style="cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;padding:4px 10px">Apply</button>' +
    '</div>';
  var rect = btn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.left = rect.left - cRect.left + 'px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }
}
function _pricingCloseBudgetFitPopover(projId) {
  var pop = document.getElementById('pricing-budgetfit-popover-' + projId);
  if (pop) pop.remove();
}
function _pricingApplyBudgetFit(projId) {
  var plan = _pricingComputeBudgetFitPlan(projId);
  if (!plan) return;
  var estimate = _pricingGetEstimate(projId);
  estimate.rowToggles = estimate.rowToggles || {};
  var prevValues = {};
  plan.excludeKeys.forEach(function (k) {
    prevValues[k] = estimate.rowToggles[k] !== undefined ? estimate.rowToggles[k] : null;
    estimate.rowToggles[k] = false;
  });
  _pricingSetEstimate(projId, estimate);
  _pricingSetBudget(projId, {
    fitToBudget: true,
    fitExcludedIds: plan.excludeKeys,
    fitPrevToggleValues: prevValues,
    fitAppliedAt: Date.now(),
  });
  _pricingCloseBudgetFitPopover(projId);
  if (typeof showToast === 'function') {
    showToast('Fit to Budget applied — ' + plan.excludedCount + ' item(s) unchecked to fit ' + plan.ceilingLabel);
  }
  initCostEstimateTab(projId);
}
function _pricingClearBudgetFit(projId) {
  var budget = _pricingGetBudget(projId);
  var estimate = _pricingGetEstimate(projId);
  var prevValues = budget.fitPrevToggleValues || {};
  (budget.fitExcludedIds || []).forEach(function (k) {
    // Fix (174ad49a Phase B3 review-phase-b3.md Check D / Clear ruling (a), required fix 2):
    // only restore a key if its CURRENT value still equals exactly what Apply set (always
    // `false` for every key in fitExcludedIds) -- i.e. nothing has touched it since Apply.
    // If the user manually re-checked (or otherwise changed) it after Apply, that's their
    // most recent deliberate action; Clear must never silently overwrite it ("never destroy
    // user state"). No new stored state is needed -- "still false" IS the untouched-since-
    // Apply signal, since Apply is the only thing that ever wrote false to these specific keys.
    if (estimate.rowToggles[k] !== false) return; // touched since Apply -- leave it alone
    if (prevValues[k] === null || prevValues[k] === undefined) delete estimate.rowToggles[k];
    else estimate.rowToggles[k] = prevValues[k];
  });
  _pricingSetEstimate(projId, estimate);
  _pricingSetBudget(projId, { fitToBudget: false, fitExcludedIds: [], fitPrevToggleValues: {}, fitAppliedAt: null });
  if (typeof showToast === 'function') showToast('Fit to Budget cleared — Recommended items restored.');
  initCostEstimateTab(projId);
}

/* ── Toggle column visibility ─────────────────────────────────────────────── */
function _pricingToggleCol(projId, colIdx) {
  var hidden = _pricingGetHiddenCols(projId);
  var i = hidden.indexOf(colIdx);
  if (i !== -1) {
    hidden.splice(i, 1);
  } else {
    hidden.push(colIdx);
  }
  _pricingSetHiddenCols(projId, hidden);
  initCostEstimateTab(projId);
}

/* ── Hide empty columns (all visible rows have no value in that col) ─────── */
function _pricingHideEmptyCols(projId, rows) {
  // Find cols where every data row has empty/zero value
  var hidden = _pricingGetHiddenCols(projId);
  for (var ci = 2; ci < PRICING_TBL_COLS.length; ci++) {
    if (PRICING_TBL_COLS[ci].noHide) continue;
    if (hidden.indexOf(ci) !== -1) continue; // already hidden
    var allEmpty = rows.every(function (r) {
      var v = _pricingRowColValue(r, ci);
      return v === '' || v === null || v === undefined || v === 0 || v === -1;
    });
    if (allEmpty) hidden.push(ci);
  }
  _pricingSetHiddenCols(projId, hidden);
  initCostEstimateTab(projId);
}

/* ── Close Table Settings popover when clicking outside ───────────────────
   Renamed from _pricingCloseColPopover (b771dec6 3a) — the popover now holds
   pricing config too, not just the column checklist.
   Also removes the tracked outside-click listener (see _pricingSettingsPopoverOutsideHandler
   below) — found during functional verify: any Pricing Config field change re-renders the
   whole panel via initCostEstimateTab, which destroys the popover DOM node but NOT the
   document-level outside-click listener from the previous open(). Since the popover element
   id is the same on every open (keyed by projId, not per-instance), that stale listener would
   otherwise immediately close the NEXT popover the user opens (same id match) — reopening
   Table Settings after any config edit would silently fail. Explicit listener bookkeeping
   fixes it (was a latent bug in the pre-3a col-only popover too, now much more visible since
   Table Settings is reopened far more often).
   ─────────────────────────────────────────────────────────────────────────── */
var _pricingSettingsPopoverOutsideHandler = {};
function _pricingCloseSettingsPopover(projId) {
  var pop = document.getElementById('pricing-settings-popover-' + projId);
  if (pop) pop.remove();
  if (_pricingSettingsPopoverOutsideHandler[projId]) {
    document.removeEventListener('click', _pricingSettingsPopoverOutsideHandler[projId]);
    delete _pricingSettingsPopoverOutsideHandler[projId];
  }
}

/* ── Legend popover (Phase 1, cost-estimate-ux-2026-07-06) ────────────────
   Plain-language explanation of every icon/color/label in the table that
   otherwise has no on-page explanation (closes 82463b0f, 0fe8312b, 5ea71e75,
   7497271f). Same open/close/outside-click pattern as _pricingOpenSettingsPopover
   above — separate tracker map so the two popovers don't clobber each other's
   outside-click listeners.
   ─────────────────────────────────────────────────────────────────────────── */
var _pricingLegendPopoverOutsideHandler = {};
function _pricingCloseLegendPopover(projId) {
  var pop = document.getElementById('pricing-legend-popover-' + projId);
  if (pop) pop.remove();
  if (_pricingLegendPopoverOutsideHandler[projId]) {
    document.removeEventListener('click', _pricingLegendPopoverOutsideHandler[projId]);
    delete _pricingLegendPopoverOutsideHandler[projId];
  }
}

function _pricingOpenLegendPopover(projId, btn) {
  // Close any open popover first (all four kinds — only one popover open at a time)
  _pricingCloseLegendPopover(projId);
  _pricingCloseSettingsPopover(projId);
  _pricingCloseBudgetPopover(projId);
  _pricingCloseRatePopover(projId);

  var pop = document.createElement('div');
  pop.id = 'pricing-legend-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:10px 12px',
    'z-index:800',
    'min-width:280px',
    'max-width:340px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');

  var items = [
    {
      icon: '<span style="color:var(--warn);font-size:11px">⚠</span>',
      text: 'next to a part number — needs an on-site check before ordering (probe length, pressure range, etc.). The price shown is still correct.',
    },
    {
      icon: '<span style="color:var(--accent);font-size:11px">✓</span>',
      text: 'next to a part number — a cheaper qualifying part was substituted here. Hover to see the original part.',
    },
    {
      icon: '<span style="color:var(--warn)">Manual Price</span>',
      text: 'no catalog part exists for this item; a price is typed in by hand.',
    },
    { icon: 'Dimmed rows', text: 'no new part is needed; existing wiring/points are reused.' },
    {
      icon: 'Shaded first columns',
      text: 'these stay visible while you scroll sideways; the shading is just so scrolled content can’t show through them.',
    },
    {
      icon: 'Default order',
      text: 'rows and buildings appear in the order they were generated, not sorted by size, cost, or savings.',
    },
  ];

  var html =
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Table Legend</div>';
  html += '<div style="display:flex;flex-direction:column;gap:8px">';
  items.forEach(function (it) {
    html +=
      '<div style="display:flex;gap:6px;align-items:baseline">' +
      '<span style="flex-shrink:0;font-weight:600;color:var(--text)">' +
      it.icon +
      '</span>' +
      '<span style="color:var(--text2);line-height:1.4">' +
      it.text +
      '</span>' +
      '</div>';
  });
  html += '</div>';
  pop.innerHTML = html;

  // Position relative to the ⓘ Legend button (same pattern as Table Settings popover)
  var rect = btn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.left = rect.left - cRect.left + 'px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }

  setTimeout(function () {
    function handler(e) {
      if (!pop.contains(e.target) && e.target !== btn) {
        _pricingCloseLegendPopover(projId);
      }
    }
    _pricingLegendPopoverOutsideHandler[projId] = handler;
    document.addEventListener('click', handler);
  }, 10);
}

/* ── Standalone Budget popover (cost-estimate-toolbar-2026-07-10, discoverability fix) ────
   Opened from the new always-visible "Budget" toolbar chip. Renders the exact same section
   markup as Table Settings' Budget section (_pricingBuildBudgetSectionHTML) — same ids,
   same _pricingUpdateBudget onchange wiring, same en_pricing_budget_{id} storage key, same
   Fit-to-Budget action. This is a second entry point to the SAME control, not a fork: Budget
   still also lives inside Table Settings for anyone already in that flow. Same open/close/
   outside-click/positioning pattern as the Legend and Table Settings popovers above — own
   tracker map so all three popovers' outside-click listeners stay independent. Any budget
   field change re-renders the whole tab via _pricingUpdateBudget -> initCostEstimateTab,
   which destroys this popover's DOM node the same way it already does to the Table Settings
   popover (see the comment above _pricingCloseSettingsPopover) — expected, not a new bug.
   ─────────────────────────────────────────────────────────────────────────── */
var _pricingBudgetPopoverOutsideHandler = {};
function _pricingCloseBudgetPopover(projId) {
  var pop = document.getElementById('pricing-budget-popover-' + projId);
  if (pop) pop.remove();
  if (_pricingBudgetPopoverOutsideHandler[projId]) {
    document.removeEventListener('click', _pricingBudgetPopoverOutsideHandler[projId]);
    delete _pricingBudgetPopoverOutsideHandler[projId];
  }
}

function _pricingOpenBudgetPopover(projId, btn) {
  // Close any open popover first (all four kinds — only one popover open at a time)
  _pricingCloseBudgetPopover(projId);
  _pricingCloseSettingsPopover(projId);
  _pricingCloseLegendPopover(projId);
  _pricingCloseRatePopover(projId);

  var estimate = _pricingGetEstimate(projId);
  var tier = estimate.tier || 'compliance';

  var pop = document.createElement('div');
  pop.id = 'pricing-budget-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:10px 12px',
    'z-index:800',
    'min-width:220px',
    'max-width:280px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');
  pop.innerHTML = _pricingBuildBudgetSectionHTML(projId, tier);

  // Position relative to the Budget button (same pattern as the other toolbar popovers)
  var rect = btn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.left = rect.left - cRect.left + 'px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }

  setTimeout(function () {
    function handler(e) {
      if (!pop.contains(e.target) && e.target !== btn) {
        _pricingCloseBudgetPopover(projId);
      }
    }
    _pricingBudgetPopoverOutsideHandler[projId] = handler;
    document.addEventListener('click', handler);
  }, 10);
}

/* ── Rate section HTML (1476aedd) ─────────────────────────────────────────
   Shared by the Table Settings popover (Section 1a, the existing "Hourly Rate:" row,
   unchanged) and the new standalone toolbar Rate popover below — same id
   (pricing-rate-{projId}), same updatePricingConfig(projId,'hourlyRate',...) onchange
   wiring, same en_pricing_config storage key, exact same input markup as the Table
   Settings copy (mirrors the _pricingBuildBudgetSectionHTML precedent: one storage path,
   two entry points, no forked logic). Reusing the same element id is safe because only
   one of the two popovers is ever in the DOM at a time (Table Settings and Rate close
   each other on open, same as every other toolbar popover pair here).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBuildRateSectionHTML(projId, cfg) {
  return (
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Labor Rate</div>' +
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Hourly Rate:' +
    '<span style="display:flex;align-items:center;gap:4px">' +
    '<input type="number" id="pricing-rate-' +
    projId +
    '" min="1" max="999" step="1" value="' +
    cfg.hourlyRate +
    '"' +
    ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'hourlyRate',parseFloat(this.value))\">" +
    '<span style="font-size:10px;color:var(--text3)">$/hr</span>' +
    '</span></label>' +
    '<div style="font-size:10px;color:var(--text3);line-height:1.4">' +
    'Single rate for ALL labor — programming-labor row Hours (see the Rate column) AND every hardware row’s physical install hours (per device type — edit in the Hours column), folded into Phase 1 "Hardware &amp; Installation". Unified 2026-07-28 (was two separate rates).' +
    '</div>'
  );
}

/* ── Standalone Rate popover (1476aedd, discoverability fix) ──────────────────────────
   Same "buried in Table Settings, nothing in the toolbar hints it exists" problem the
   Budget control had (174ad49a) and the same fix: an always-visible toolbar chip
   (_pricingBuildToolbarHTML's rateBtnHTML) opens this small dedicated popover instead of
   requiring a trip through "⚙ Table Settings". Same open/close/outside-click/positioning
   pattern as _pricingOpenBudgetPopover — own tracker map so all four popovers' outside-click
   listeners stay independent.
   ─────────────────────────────────────────────────────────────────────────── */
var _pricingRatePopoverOutsideHandler = {};
function _pricingCloseRatePopover(projId) {
  var pop = document.getElementById('pricing-rate-popover-' + projId);
  if (pop) pop.remove();
  if (_pricingRatePopoverOutsideHandler[projId]) {
    document.removeEventListener('click', _pricingRatePopoverOutsideHandler[projId]);
    delete _pricingRatePopoverOutsideHandler[projId];
  }
}

function _pricingOpenRatePopover(projId, btn) {
  // Close any open popover first (only one popover open at a time)
  _pricingCloseRatePopover(projId);
  _pricingCloseSettingsPopover(projId);
  _pricingCloseLegendPopover(projId);
  _pricingCloseBudgetPopover(projId);

  var cfg = _pricingGetConfig();

  var pop = document.createElement('div');
  pop.id = 'pricing-rate-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:10px 12px',
    'z-index:800',
    'min-width:220px',
    'max-width:280px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');
  pop.innerHTML = _pricingBuildRateSectionHTML(projId, cfg);

  // Position relative to the Rate button (same pattern as the other toolbar popovers)
  var rect = btn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.left = rect.left - cRect.left + 'px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }

  setTimeout(function () {
    function handler(e) {
      if (!pop.contains(e.target) && e.target !== btn) {
        _pricingCloseRatePopover(projId);
      }
    }
    _pricingRatePopoverOutsideHandler[projId] = handler;
    document.addEventListener('click', handler);
  }, 10);
}

/* ── Column-visibility checklist HTML (b771dec6 3a) ───────────────────────
   Factored out of the old col-popover so _pricingOpenSettingsPopover can compose
   it as one section of the combined Table Settings popover. Same storage keys
   (_pricingGetHiddenCols/_pricingSetHiddenCols) and same buttons — markup only.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBuildColVisibilityHTML(projId) {
  var hidden = _pricingGetHiddenCols(projId);
  var rows = _pricingRowCache[projId] || [];

  var html =
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Columns</div>';
  PRICING_TBL_COLS.forEach(function (col, ci) {
    if (col.noHide) return;
    var isHidden = hidden.indexOf(ci) !== -1;
    html +=
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0;color:var(--text)">' +
      '<input type="checkbox"' +
      (isHidden ? '' : ' checked') +
      ' onchange="_pricingToggleCol(\'' +
      projId +
      "'," +
      ci +
      ')">' +
      col.label +
      '</label>';
  });
  html +=
    '<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;display:flex;gap:6px;flex-wrap:wrap">';
  html +=
    '<button onclick="_pricingHideEmptyCols(\'' +
    projId +
    "'," +
    JSON.stringify(rows) +
    ')" style="font-size:10px;padding:2px 8px;background:var(--s3);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer">Hide Empty</button>';
  html +=
    '<button onclick="_pricingSetHiddenCols(\'' +
    projId +
    "',[]);initCostEstimateTab('" +
    projId +
    '\')" style="font-size:10px;padding:2px 8px;background:var(--s3);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer">Show All</button>';
  html += '</div>';
  return html;
}

/* ── Budget section HTML (174ad49a; factored out cost-estimate-toolbar-2026-07-10) ───────
   Shared by the Table Settings popover (Section 1b, below) and the standalone toolbar Budget
   popover (_pricingOpenBudgetPopover, below) — same _pricingGetBudget/_pricingUpdateBudget/
   _pricingComputeBudgetTotal read/write path either way; this function only builds markup, it
   does not fork budget logic. `tier` is needed because the Fit-to-Budget action only applies
   while viewing Recommended. Do not duplicate this markup elsewhere — add a third caller here
   instead of copy-pasting the block again.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBuildBudgetSectionHTML(projId, tier) {
  var budget = _pricingGetBudget(projId); // 174ad49a
  var html =
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Budget</div>';
  html +=
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Mode:' +
    '<select id="pricing-budget-mode-' +
    projId +
    '" style="font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px" onchange="_pricingUpdateBudget(' +
    projId +
    ",'mode',this.value)\">" +
    '<option value="recurring"' +
    (budget.mode === 'recurring' ? ' selected' : '') +
    '>Recurring Services Budget</option>' +
    '<option value="financing"' +
    (budget.mode === 'financing' ? ' selected' : '') +
    '>Project Financing</option>' +
    '</select></label>';
  html +=
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Amount:' +
    '<span style="display:flex;gap:4px">' +
    '<input type="number" min="0" step="1" id="pricing-budget-amount-' +
    projId +
    '" value="' +
    (budget.amount != null ? budget.amount : '') +
    '" placeholder="0"' +
    ' style="width:76px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px;text-align:right"' +
    ' onchange="_pricingUpdateBudget(' +
    projId +
    ",'amount',parseFloat(this.value)||null)\">" +
    '<select id="pricing-budget-denom-' +
    projId +
    '" style="font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px" onchange="_pricingUpdateBudget(' +
    projId +
    ",'denomination',this.value)\">" +
    ['lump', 'monthly', 'quarterly', 'annual']
      .map(function (d) {
        var lbl = d === 'lump' ? 'Lump sum' : d.charAt(0).toUpperCase() + d.slice(1);
        return '<option value="' + d + '"' + (budget.denomination === d ? ' selected' : '') + '>' + lbl + '</option>';
      })
      .join('') +
    '</select></span></label>';
  if (budget.denomination !== 'lump') {
    html +=
      '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px" ' +
      'title="' +
      (budget.mode === 'financing'
        ? 'How many months the financing plan spans'
        : 'How many months to compare the recurring budget against — a horizon you choose, not one this feature assumes') +
      '">' +
      (budget.mode === 'financing' ? 'Financing term (months):' : 'Compare over (months):') +
      '<input type="number" min="1" step="1" id="pricing-budget-term-' +
      projId +
      '" value="' +
      budget.termMonths +
      '"' +
      ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px;text-align:right"' +
      ' onchange="_pricingUpdateBudget(' +
      projId +
      ",'termMonths',parseInt(this.value,10)||12)\">" +
      '</label>';
  }
  var _budgetComp = _pricingComputeBudgetTotal(budget);
  if (_budgetComp) {
    html +=
      '<div style="font-size:10px;color:var(--text3);margin-bottom:2px">' +
      (budget.mode === 'financing' ? 'Affords: ' : 'Ceiling: ') +
      _budgetComp.basisLabel +
      '</div>';
  }
  // 174ad49a Phase 3: Fit-to-Budget action — Mode B only, and only meaningful while viewing
  // Recommended (the tier the "measure list" refers to). Shown (not hidden) on other tiers with
  // an explanatory note, so the control isn't a mystery the user can't find.
  if (budget.mode === 'recurring' && _budgetComp) {
    if (tier !== 'recommended') {
      html +=
        '<div style="font-size:10px;color:var(--text3);font-style:italic;margin-top:4px">Switch to the Recommended tier to use Fit to Budget.</div>';
    } else if (budget.fitToBudget) {
      html +=
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:4px">' +
        '<span style="color:var(--accent);font-weight:700">Fit to Budget: ON (' +
        (budget.fitExcludedIds || []).length +
        ' excluded)</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="_pricingClearBudgetFit(\'' +
        projId +
        '\')" style="cursor:pointer">Clear</button>' +
        '</div>';
    } else {
      // 32878dc1: c82cc354 REV 2 made Recommended membership intrinsically budget-fit by
      // construction — buildRecommendedRows already runs the same greedy-ceiling walk before
      // any row reaches the table, so clicking "Fit to Budget…" here recomputes the SAME plan
      // against a row set that's already fit and (on Recommended) will always come back with
      // excludedCount 0. Compute the plan (read-only — nothing is written) so the copy reflects
      // the CURRENT state instead of a hardcoded string: only offer the action button when it
      // would actually exclude something (defensive — covers any future case where it wouldn't
      // be a no-op); otherwise show the reviewer-suggested static line so it stops implying an
      // action is needed (stages/c82cc354/review.md).
      var _recFitPlan = _pricingComputeBudgetFitPlan(projId);
      if (_recFitPlan && _recFitPlan.excludedCount > 0) {
        html +=
          '<button class="btn btn-ghost btn-sm" onclick="_pricingOpenBudgetFitPreview(\'' +
          projId +
          '\',this)" style="cursor:pointer;margin-top:4px;width:100%">Fit to Budget…</button>';
      } else {
        html +=
          '<div style="font-size:10px;color:var(--text3);font-style:italic;margin-top:4px">Recommended is already budget-fit.</div>';
      }
    }
  }
  // ── Monthly Service Agreement (2026-07-20) ──────────────────────────────────────
  // Additive block: editable hours/month, computed monthly figure (hours × shared global
  // hourlyRate), the existing budget.amount shown as the not-to-exceed allowance, and an
  // under/over indicator. Same silent-until-configured convention as the Ceiling/Affords line
  // above — renders nothing until a budget.amount is set (_pricingComputeMonthlyService).
  var _svc = _pricingComputeMonthlyService(projId);
  if (_svc) {
    var _svcMonthlyStr = '$' + Math.round(_svc.monthlyService).toLocaleString('en-US');
    var _svcAllowanceStr = '$' + Math.round(_svc.allowance).toLocaleString('en-US');
    var _svcDiffStr = '$' + Math.round(Math.abs(_svc.diff)).toLocaleString('en-US');
    var _svcColor = _svc.underCap ? '#86efac' : 'var(--warn)';
    html +=
      '<div style="font-weight:700;color:var(--text2);margin:10px 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;border-top:1px solid var(--border);padding-top:8px">Monthly Service Agreement</div>' +
      '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
      'Hours/month:' +
      '<input type="number" min="0" step="0.5" id="pricing-budget-svchours-' +
      projId +
      '" value="' +
      _svc.hours +
      '"' +
      ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px;text-align:right"' +
      ' onchange="_pricingUpdateBudget(' +
      projId +
      ",'serviceHoursPerMonth',parseFloat(this.value)||36)\">" +
      '</label>' +
      '<div style="font-size:10px;color:var(--text3);line-height:1.4;margin-bottom:2px">' +
      _svcMonthlyStr +
      '/month (' +
      _svc.hours +
      ' hrs × $' +
      _svc.hourlyRate +
      '/hr)' +
      '</div>' +
      '<div style="font-size:10px;color:var(--text3);line-height:1.4;margin-bottom:4px">' +
      _svcAllowanceStr +
      '/month allowance (not-to-exceed)' +
      '</div>' +
      '<div style="font-size:10px;font-weight:700;color:' +
      _svcColor +
      '">' +
      (_svc.underCap ? _svcDiffStr + ' under cap' : _svcDiffStr + ' OVER cap') +
      '</div>';
  }
  return html;
}

/* ── Table Settings popover (b771dec6 3a) ─────────────────────────────────
   Renamed/extended from _pricingToggleColPopover. Replaces the old Notes-header
   gear icon (deleted — documented exception to ui-standards.md's gear-in-
   rightmost-header convention, recorded there per Matt's instruction) as the
   single entry point for pricing config (Price Basis/Net×/Contract%/Hourly
   Rate/Fan energy% — moved VERBATIM, same ids/onchange/updatePricingConfig)
   plus the column-visibility checklist. Same positioning/outside-click/
   appendChild pattern as the old col popover.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingOpenSettingsPopover(projId, btn) {
  // Close any open popover first (all four kinds — only one popover open at a time;
  // cost-estimate-toolbar-2026-07-10 added the Legend/Budget closes for full symmetry with
  // the other two open functions, which already close this one; 1476aedd added Rate)
  _pricingCloseSettingsPopover(projId);
  _pricingCloseLegendPopover(projId);
  _pricingCloseBudgetPopover(projId);
  _pricingCloseRatePopover(projId);

  var cfg = _pricingGetConfig();
  var estimate = _pricingGetEstimate(projId);
  var tier = estimate.tier || 'compliance';

  var pop = document.createElement('div');
  pop.id = 'pricing-settings-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:10px 12px',
    'z-index:800',
    'min-width:220px',
    'max-width:280px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');

  // Section 1: pricing config — moved verbatim from the old toolbar (same ids/onchange)
  var html =
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Pricing Config</div>';
  html +=
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Price Basis:' +
    '<select id="pricing-basis-' +
    projId +
    '" style="font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px" onchange="updatePricingConfig(' +
    projId +
    ",'priceBasis',this.value)\">" +
    '<option value="contract"' +
    (cfg.priceBasis === 'contract' ? ' selected' : '') +
    '>Contract (40% List)</option>' +
    '<option value="net"' +
    (cfg.priceBasis === 'net' ? ' selected' : '') +
    '>Net</option>' +
    '<option value="list"' +
    (cfg.priceBasis === 'list' ? ' selected' : '') +
    '>List</option>' +
    '</select></label>';
  html +=
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Net ×:' +
    '<input type="number" id="pricing-net-mult-' +
    projId +
    '" min="0.01" max="1.0" step="0.01" value="' +
    cfg.netMultiplier +
    '"' +
    ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'netMultiplier',parseFloat(this.value))\">" +
    '</label>';
  html +=
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Contract %:' +
    '<input type="number" id="pricing-contract-pct-' +
    projId +
    '" min="1" max="100" step="1" value="' +
    Math.round(cfg.contractPct * 100) +
    '"' +
    ' style="width:44px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'contractPct',parseFloat(this.value)/100)\">" +
    '</label>';
  html +=
    /* Unified labor rate (2026-07-28): single Hourly Rate for ALL labor — programming/sequence
       (Phase 2) AND physical install hours on every Phase-1 hardware row (per-device-type,
       editable in the Hours column), folded into Phase 1 "Hardware & Installation". Was two
       separate rates (Hourly Rate + Install Rate) 2026-07-19→2026-07-28; Matt: "we need to be
       using the $173/hr for all labor costs not just EM." */
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px" ' +
    'title="Labor $/hr — applies to programming/sequence Hours (Phase 2) AND physical install Hours (Phase 1)">' +
    'Hourly Rate:' +
    '<input type="number" id="pricing-rate-' +
    projId +
    '" min="1" max="999" step="1" value="' +
    cfg.hourlyRate +
    '"' +
    ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'hourlyRate',parseFloat(this.value))\">" +
    '</label>';
  if (tier === 'recommended' || tier === 'both') {
    html +=
      '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px" ' +
      'title="Fan energy as % of total electricity (CBECS VAV typical range 10–20%); used for duct pressure/supply air temp reset savings estimates">' +
      'Fan energy %:' +
      '<input type="number" id="pricing-fanfrac-' +
      projId +
      '" min="1" max="50" step="1" value="' +
      Math.round((cfg.fanFraction !== undefined ? cfg.fanFraction : FAN_FRACTION_DEFAULT) * 100) +
      '"' +
      ' style="width:44px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--accent);border-radius:4px"' +
      ' onchange="updatePricingConfig(' +
      projId +
      ",'fanFraction',parseFloat(this.value)/100)\">" +
      '</label>';
  }

  // Section 1b (174ad49a): Budget input — dual mode (Mode A "Project Financing" spreads a
  // one-time total over a term; Mode B "Recurring Services Budget" is a periodic ceiling the
  // measure list must fit inside), lump/annual/quarterly/monthly denominations, per Matt's
  // 2026-07-03 spec. cost-estimate-toolbar-2026-07-10: Budget also now has its own always-
  // visible toolbar chip (_pricingOpenBudgetPopover) because this popover location alone wasn't
  // discoverable — this copy stays here too so Budget is still reachable from Table Settings
  // for anyone already in that flow. Markup factored into _pricingBuildBudgetSectionHTML so
  // both copies share one source of truth (same ids/onchange/storage key).
  html += '<div style="border-top:1px solid var(--border);margin:8px 0 6px;padding-top:8px">';
  html += _pricingBuildBudgetSectionHTML(projId, tier);
  html += '</div>';

  // Section 2: column-visibility checklist
  html += '<div style="border-top:1px solid var(--border);margin:8px 0 6px;padding-top:8px">';
  html += _pricingBuildColVisibilityHTML(projId);
  html += '</div>';

  pop.innerHTML = html;

  // Position relative to the Table Settings button (same pattern as the old col popover)
  var rect = btn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.left = rect.left - cRect.left + 'px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }

  // Close on outside click. Tracked in _pricingSettingsPopoverOutsideHandler (by projId)
  // so _pricingCloseSettingsPopover can explicitly remove this exact listener — prevents a
  // stale listener from a previous open() (destroyed by a config-change re-render) from
  // closing the NEXT popover instance the moment it opens (see comment above the tracker var).
  setTimeout(function () {
    function handler(e) {
      if (!pop.contains(e.target) && e.target !== btn) {
        _pricingCloseSettingsPopover(projId);
      }
    }
    _pricingSettingsPopoverOutsideHandler[projId] = handler;
    document.addEventListener('click', handler);
  }, 10);
}

/* ── Compute sticky left offsets for frozen columns ─────────────────────── */
function _pricingUpdateStickyOffsets(projId) {
  var tableEl = document.querySelector('#ptab-cost-estimate-body-' + projId + ' table.ch-tbl');
  if (!tableEl) return;
  var widths = _pricingGetColWidths(projId);
  var hidden = _pricingGetHiddenCols(projId);
  // col 0 = Incl (frozen), col 1 = Building (frozen)
  // col 0 starts at left:0
  var col0w = widths[0] || PRICING_TBL_COLS[0].minWidth;
  // col 1 starts at left:col0w
  // Update all th/td for col 0 and col 1
  var allRows = tableEl.querySelectorAll('tr');
  allRows.forEach(function (tr) {
    var cells = tr.querySelectorAll('th, td');
    if (cells.length < 2) return;
    // col 0
    var c0 = cells[0];
    if (c0) {
      c0.style.left = '0px';
      c0.style.zIndex = c0.tagName === 'TH' ? '12' : '10';
    }
    // col 1
    var c1 = cells[1];
    if (c1) {
      c1.style.left = col0w + 'px';
      c1.style.zIndex = c1.tagName === 'TH' ? '12' : '10';
    }
  });
}

/* ── Attach column resize handlers (post-render) ────────────────────────── */
// B2 FIX: use data-col-idx attribute (set by buildTH) so the correct PRICING_TBL_COLS
// index is used even when some columns are hidden (DOM forEach index ≠ col index).
function _pricingAttachResizeHandlers(projId) {
  var tableEl = document.querySelector('#ptab-cost-estimate-body-' + projId + ' table.ch-tbl');
  if (!tableEl) return;
  var ths = tableEl.querySelectorAll('thead th');
  if (!ths.length) return;

  ths.forEach(function (th) {
    // Read actual column index from data attribute stamped by buildTH
    var colIdx = parseInt(th.getAttribute('data-col-idx'), 10);
    if (isNaN(colIdx)) return;
    var handle = th.querySelector('.ch-col-resize-handle');
    if (!handle) return;

    // DOM cell index for body cells: count visible ths before this one
    var domIdx = Array.prototype.indexOf.call(ths, th);

    var startX, startW;
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      handle.classList.add('dragging');
      startX = e.clientX;
      startW = th.offsetWidth;

      function onMove(ev) {
        var dx = ev.clientX - startX;
        var newW = Math.max(PRICING_TBL_COLS[colIdx] ? PRICING_TBL_COLS[colIdx].minWidth : 40, startW + dx);
        th.style.width = newW + 'px';
        th.style.minWidth = newW + 'px';
        // Apply same width to all body cells in this column (use DOM cell index)
        var rows = tableEl.querySelectorAll('tbody tr, tfoot tr');
        rows.forEach(function (tr) {
          var td = tr.cells[domIdx];
          if (td) {
            td.style.width = newW + 'px';
            td.style.minWidth = newW + 'px';
          }
        });
        // Recompute sticky offsets if this is a frozen col (cols 0 or 1)
        if (colIdx <= 1) _pricingUpdateStickyOffsets(projId);
      }

      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Persist by col index (not DOM index) so widths survive hide/show
        var widths = _pricingGetColWidths(projId);
        widths[colIdx] = th.offsetWidth;
        _pricingSetColWidths(projId, widths);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

/* ── Attach sort click handlers (post-render) ───────────────────────────── */
// B2 FIX: use data-col-idx attribute so sort targets correct column when cols are hidden.
function _pricingAttachSortHandlers(projId) {
  var tableEl = document.querySelector('#ptab-cost-estimate-body-' + projId + ' table.ch-tbl');
  if (!tableEl) return;
  var ths = tableEl.querySelectorAll('thead th');

  ths.forEach(function (th) {
    // Read actual column index from data attribute stamped by buildTH
    var colIdx = parseInt(th.getAttribute('data-col-idx'), 10);
    if (isNaN(colIdx)) return;
    var col = PRICING_TBL_COLS[colIdx];
    if (!col || col.noSort) return;
    var label = th.querySelector('.ch-sort-label');
    if (!label) return;

    label.style.cursor = 'pointer';
    label.addEventListener('click', function (e) {
      e.stopPropagation();
      var state = _pricingSortState[projId] || { col: null, dir: null };
      var newDir;
      if (state.col === colIdx) {
        // Cycle: asc → desc → null (reset)
        if (state.dir === 'asc') newDir = 'desc';
        else if (state.dir === 'desc') newDir = null;
        else newDir = 'asc';
      } else {
        newDir = 'asc';
      }
      _pricingSortState[projId] = { col: newDir ? colIdx : null, dir: newDir };
      // Re-render — initCostEstimateTab picks up _pricingSortState
      initCostEstimateTab(projId);
    });
  });
}

/* ── Apply saved column widths (post-render) ────────────────────────────── */
// FIX 1: use data-col-idx attribute (stamped by buildTH) so the correct
// PRICING_TBL_COLS column gets the saved width even when some columns are
// hidden.  The old code used the saved key as a DOM array index into the
// visible TH NodeList, which pointed to the wrong TH whenever any column
// to the left of the resized column was hidden.
function _pricingApplyColWidths(projId) {
  var tableEl = document.querySelector('#ptab-cost-estimate-body-' + projId + ' table.ch-tbl');
  if (!tableEl) return;
  var widths = _pricingGetColWidths(projId);
  if (!Object.keys(widths).length) return;

  var ths = tableEl.querySelectorAll('thead th');
  ths.forEach(function (th) {
    var colIdx = th.getAttribute('data-col-idx');
    var w = widths[colIdx];
    if (!w) return;
    var domIdx = Array.prototype.indexOf.call(ths, th);
    th.style.width = w + 'px';
    th.style.minWidth = w + 'px';
    var bodyRows = tableEl.querySelectorAll('tbody tr, tfoot tr');
    bodyRows.forEach(function (tr) {
      var td = tr.cells[domIdx];
      if (td) {
        td.style.width = w + 'px';
        td.style.minWidth = w + 'px';
      }
    });
  });
}

/* ── d5286981: shared Cost Estimate toolbar builder ────────────────────────
   Used by every Cost Estimate view — Recommended/Compliance/Full Scope/Compare
   (initCostEstimateTab) AND Summary (_pricingRenderSummaryTab) — so a control that appears
   on more than one view renders at the exact same screen position on all of them
   (ui-standards.md "Stable control placement rule", 2026-07-08, binding). Origin bug: Summary
   built its own, much shorter toolbarHTML (just a title span before the Tier toggle), so the
   Tier toggle's left edge differed from the other 4 views, which all share the same fixed-width
   Import CSV/Table Settings/Legend content before Tier.

   Controls that don't apply on the current tier (Import CSV/Table Settings/Legend/Building
   filter on Summary; Sort on every tier except Recommended) are hidden IN PLACE via
   visibility:hidden + pointer-events:none + aria-hidden — never display:none — so the reserved
   layout box stays in the DOM flow and no sibling control can slide into the gap. The Tier
   toggle itself is NEVER hidden/wrapped — it is the one control this whole rule protects.

   opts.allBuildings (optional — Summary's call passes none, since the Building-filter slot is
   always hidden there): the list of distinct building names for the CURRENT tier's row set.
   Deliberately NOT re-derived inside this function: it depends on tier-specific row-building
   state (buildRecommendedRows/buildComplianceRows/buildFullScopeRows) that only
   initCostEstimateTab already computes — recomputing it here would mean a second row-build call
   per render, duplicating row-building logic this item's plan puts off-limits ("What NOT to
   touch"). Safe to omit/leave empty for Summary: the Building <select> now has a fixed width
   (d5286981 Change 2) so an empty option list doesn't change the reserved slot's width.

   hasCatalog/importStatus (catalog-import status) and filterBldg (the current Building-filter
   selection) ARE re-derived inside this function on every call, deliberately — both are simple,
   side-effect-free reads (sget('en_pricing_catalog'/'en_pricing_meta'), _pricingBldgFilter[projId])
   that are the SAME regardless of which tier is rendering, not row-building-derived. Passing them
   in via opts (an earlier draft of this function did) meant Summary's caller — which has no
   catalog/meta values of its own to pass — defaulted them to hasCatalog=false/importStatus='',
   giving Summary's reserved-but-hidden Import CSV slot a DIFFERENT (shorter) width than the
   other 4 views' real value ("N SKUs imported <date>" vs empty string). Because the toolbar row
   is flex-wrap:wrap, that width difference changed where the row wrapped onto a second line
   between Summary and the other 4 tiers — reproducing a subtler version of the exact bug this
   item exists to fix. Self-deriving these three values, identically on every tier including
   Summary, closes that gap.

   2026-07-22 update: the "Summary" sub-tab described above was REMOVED entirely (Matt: "The
   Cost Estimate per building I do not like and it honestly gives no information. Just remove
   completely.") — see the removed _pricingRenderSummaryTab. `opts.middleHTML` (below) replaces
   Summary's old caption slot as a generic reserved-elastic-space passthrough any caller may use
   (e.g. the Compliance/Full-Scope condensed-view toggle — see _pricingRenderCondensedTab).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingBuildToolbarHTML(projId, tier, opts) {
  opts = opts || {};
  var isRecommended = tier === 'recommended';
  var catalog = sget('en_pricing_catalog', null);
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);
  var meta = sget('en_pricing_meta', null);
  var importStatus = meta
    ? '<span style="font-size:11px;color:var(--text2);margin-left:8px">' +
      meta.skuCount +
      ' SKUs imported ' +
      new Date(meta.importedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      '</span>'
    : '<span style="font-size:11px;color:var(--warn);margin-left:8px">No pricing imported — unit prices will show as "—"</span>';
  var allBuildings = opts.allBuildings || [];
  var filterBldg = _pricingBldgFilter[projId] || '';

  var rowFilterActive = true; // Import CSV, Table Settings, Legend, Building filter — always on now that Summary (the one tier that hid these) is removed
  var sortActive = isRecommended; // Sort: Recommended-only, unchanged from the existing rule

  // visibility:hidden (not display:none) reserves the exact layout box so sibling controls never
  // slide into the gap when this slot doesn't apply to the current tier. pointer-events:none +
  // aria-hidden stop stray interaction/AT announcement of a control that can't act on this view.
  function slot(html, active) {
    return (
      '<span style="display:inline-flex;align-items:center;' +
      (active ? '' : 'visibility:hidden;pointer-events:none;') +
      '"' +
      (active ? '' : ' aria-hidden="true"') +
      '>' +
      html +
      '</span>'
    );
  }

  var importCsvHTML =
    '<label class="btn btn-ghost btn-sm" style="cursor:pointer;position:relative">' +
    '<input type="file" accept=".csv" id="pricing-csv-input-' +
    projId +
    '" style="position:absolute;opacity:0;width:0;height:0" onchange="handlePricingCSVImport(event,' +
    projId +
    ')">' +
    (hasCatalog ? '' : '<span style="color:var(--warn)">⚠ </span>') +
    'Import Pricing CSV' +
    '</label>' +
    importStatus;

  var tableSettingsBtnHTML =
    '<button class="btn btn-ghost btn-sm" onclick="_pricingOpenSettingsPopover(\'' +
    projId +
    '\',this)" title="Pricing config + column visibility" style="cursor:pointer">⚙ Table Settings</button>';

  var legendBtnHTML =
    '<button class="btn btn-ghost btn-sm" onclick="_pricingOpenLegendPopover(\'' +
    projId +
    '\',this)" title="What the icons and colors in this table mean" style="cursor:pointer">ⓘ Legend</button>';

  // Budget toolbar chip (174ad49a discoverability fix, cost-estimate-toolbar-2026-07-10) — Budget
  // used to live ONLY inside Table Settings (Section 1b, still there for the full Mode/Amount/
  // Denomination/Term fields) with nothing in the toolbar hinting it existed. This button opens a
  // dedicated small popover (_pricingOpenBudgetPopover) built from _pricingBuildBudgetSectionHTML —
  // the exact same markup/onchange wiring as the Table Settings copy, same storage key, same
  // Fit-to-Budget action, just surfaced. Label shows the current amount so the toolbar itself
  // answers "is a budget set" without opening anything.
  var _budgetForBtn = _pricingGetBudget(projId);
  var _budgetBtnLabel =
    _budgetForBtn.amount != null && !isNaN(_budgetForBtn.amount) && Number(_budgetForBtn.amount) > 0
      ? _pricingFmt(Number(_budgetForBtn.amount)) +
        ({ monthly: '/mo', quarterly: '/qtr', annual: '/yr', lump: '' }[_budgetForBtn.denomination] || '')
      : 'Not set';
  var budgetBtnHTML =
    '<button class="btn btn-ghost btn-sm" onclick="_pricingOpenBudgetPopover(\'' +
    projId +
    '\',this)" title="Client budget — drives Recommended-tier measure selection and Fit to Budget" style="cursor:pointer">' +
    (_budgetForBtn.amount == null ? '<span style="color:var(--warn)">⚠ </span>' : '') +
    'Budget: ' +
    _budgetBtnLabel +
    '</button>';

  // Rate toolbar chip (1476aedd discoverability fix) — mirrors the Budget chip immediately above
  // markup-for-markup (same "btn btn-ghost btn-sm" class, same cursor:pointer, same "Label: value"
  // text pattern): the hourly labor rate used to live ONLY inside Table Settings with nothing in
  // the toolbar hinting it existed. This button opens a dedicated small popover
  // (_pricingOpenRatePopover) built from _pricingBuildRateSectionHTML — the exact same
  // markup/onchange wiring as the Table Settings "Hourly Rate:" row, same en_pricing_config
  // storage key. Label shows the current $/hr so the toolbar itself answers "what rate is this
  // estimate using" without opening anything.
  var cfgForRateBtn = _pricingGetConfig();
  var rateBtnHTML =
    '<button class="btn btn-ghost btn-sm" onclick="_pricingOpenRatePopover(\'' +
    projId +
    '\',this)" title="Labor rate — the $/hr applied to every programming-labor row\'s Hours to compute its Line Total" style="cursor:pointer">' +
    'Rate: ' +
    _pricingFmt(cfgForRateBtn.hourlyRate || COST_LABOR_RATE_DEFAULT) +
    '/hr' +
    '</button>';

  // Building filter dropdown — width:150px added (d5286981 Change 2) so a reserved-but-hidden
  // instance (Summary) always matches a visible instance's width regardless of how long building
  // names in this project happen to be (previously auto-sized to the widest <option> text).
  var bldgFilterHTML =
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">' +
    'Building:' +
    '<select onchange="_pricingBldgFilterChange(\'' +
    projId +
    '\',this.value)"' +
    ' style="font-size:11px;padding:2px 6px;width:150px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px">' +
    '<option value=""' +
    (!filterBldg ? ' selected' : '') +
    '>All Buildings</option>' +
    allBuildings
      .map(function (b) {
        return (
          '<option value="' +
          _pricingEscText(b) +
          '"' +
          (filterBldg === b ? ' selected' : '') +
          '>' +
          _pricingEscText(b) +
          '</option>'
        );
      })
      .join('') +
    '</select></label>';

  // 979fd1af: row sort control — Recommended tier only (the only tier with savings-weight fields
  // to score by; Compliance/Full-Scope never stamp _savingsWeight/_effectiveCostTier so there is
  // nothing meaningful to sort them by). d5286981: the STRING is now always built (un-gated) so
  // the reserved slot always has real content/width to reserve on every tier — the
  // Recommended-only GATING moved to the sortActive/slot() wrapper below (see plan.md step 2).
  var _curSortMode = _pricingGetRowSortMode(projId);
  var rowSortHTML =
    '<span style="color:var(--border2)">|</span>' +
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px" ' +
    'title="Choose how buildings and equipment are ordered in this table">' +
    'Sort:' +
    '<select onchange="_pricingRowSortModeChange(\'' +
    projId +
    '\',this.value)"' +
    ' style="font-size:11px;padding:2px 6px;width:170px;overflow:hidden;text-overflow:ellipsis;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px">' +
    '<option value="default" title="Rows appear in the order they were generated — not sorted by ' +
    'size, cost, or savings"' +
    (_curSortMode === 'default' ? ' selected' : '') +
    '>Default order (unsorted)</option>' +
    '<option value="building"' +
    (_curSortMode === 'building' ? ' selected' : '') +
    '>Best building return first</option>' +
    '<option value="equipment"' +
    (_curSortMode === 'equipment' ? ' selected' : '') +
    '>Best equipment return first</option>' +
    '</select></label>';

  // 2026-07-22: generic reserved-elastic-space slot (formerly Summary's caption only — Summary
  // is removed). Content sits INSIDE the existing flex:1 spacer (not a separate element) — empty
  // string unless the caller passes opts.middleHTML, preserving today's visual output exactly on
  // every tier that doesn't use it. Because the spacer is the ELASTIC region between the
  // fixed-width "before Tier" group and the fixed-width "after spacer" group, putting content
  // here cannot move either neighbor; it only consumes some of the spacer's free space.
  var middleHTML = opts.middleHTML || '';

  return [
    '<div class="ch-panel-header" style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--s1);border-bottom:1px solid var(--border2)">',
    slot(importCsvHTML, rowFilterActive),
    slot(tableSettingsBtnHTML, rowFilterActive),
    slot(legendBtnHTML, rowFilterActive),
    slot(budgetBtnHTML, rowFilterActive),
    slot(rateBtnHTML, rowFilterActive),
    // Tier toggle — 35742dd5 (Phase 2) established that the flex:1 spacer must sit AFTER Tier,
    // not before it, so Tier's left edge is just the natural width of the fixed left-side
    // content (now IDENTICAL on all 5 views) — never wrapped in slot(): this is the one control
    // the whole binding rule (ui-standards.md "Stable control placement rule") protects.
    '<div style="flex:0 0 auto;display:flex;align-items:center">',
    _pricingTierToggleHTML(projId, tier),
    '</div>',
    // cost-estimate-toolbar-2026-07-10: Building/Sort moved out of the far-right flex:1-pushed
    // group (Matt reported them stranded at the right edge of the toolbar) and into this left-
    // side control group, immediately after Tier and BEFORE the "|" + flex:1 spacer below —
    // keeps Tier's own preceding-content dependency (Import CSV/Table Settings/Legend/Budget,
    // identical on every tier) unchanged, per ui-standards.md's Stable control placement rule.
    slot(bldgFilterHTML, rowFilterActive),
    slot(rowSortHTML, sortActive),
    '<span style="color:var(--border2)">|</span>',
    '<span style="flex:1">' + middleHTML + '</span>',
    '</div>',
  ].join('');
}

/* ── Condensed view toggle persistence (Task 1c, 2026-07-22) ─────────────────────────────────
   `estimate.condensedTier` is a per-project { compliance: bool, 'full-scope': bool } map; a
   missing/undefined entry means "condensed" (the new default) — only an explicit `false` means
   the user asked to see the full per-building itemization. Mirrors the read-with-`|| {}`-guard
   convention every other post-hoc estimate field in this file uses (installHoursOverrides,
   qtyOverrides, ...) so existing saved estimates from before this change need no migration.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingSetCondensedView(projId, tier, condensed) {
  var est = _pricingGetEstimate(projId);
  est.condensedTier = est.condensedTier || {};
  est.condensedTier[tier] = !!condensed;
  _pricingSetEstimate(projId, est);
  initCostEstimateTab(projId);
}

function _pricingCondensedToggleHTML(projId, tier, isCondensed) {
  return isCondensed
    ? '<button class="btn btn-ghost btn-sm" onclick="_pricingSetCondensedView(\'' +
        projId +
        "','" +
        tier +
        '\',false)" title="Show every row, one per building, with full edit controls" ' +
        'style="cursor:pointer">Show Full Itemization (by building)</button>'
    : '<button class="btn btn-ghost btn-sm" onclick="_pricingSetCondensedView(\'' +
        projId +
        "','" +
        tier +
        '\',true)" title="Collapse back to one row per item, summed across all buildings" ' +
        'style="cursor:pointer">Show Condensed Summary</button>';
}

/* ── Condensed-view row aggregation (Task 1c, 2026-07-22) ─────────────────────────────────────
   Groups a tier's rows by distinct item name PER PHASE (1=Hardware & Installation, 2=Programming
   & Commissioning), summing qty/lineTotal across every building carrying that same item — the
   exact same aggregate-by-item-name shape report-engine.js's _rptA36TierDetailAggByPhase already
   uses for the Proposal's collapsible detail panel, so a reader sees the identical grouping in
   both places. unitPrice is DERIVED (lineTotal/qty), never a separately-tracked field, so
   qty × unitPrice always foots exactly to lineTotal — this is a read-only summary, no new
   pricing math, no changes to the underlying row objects.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeCondensedRows(rows, estimate) {
  var toggles = (estimate && estimate.rowToggles) || {};
  function agg(phaseNum) {
    var byItem = {};
    var order = [];
    rows.forEach(function (r) {
      if (r.phase !== phaseNum) return;
      var toggleKey = r._baseId || r.id;
      if (toggles[toggleKey] === false) return;
      var name = r.item || '(unnamed)';
      if (!byItem[name]) {
        byItem[name] = { item: name, qty: 0, lineTotal: 0, buildings: {}, hasAnyPrice: false };
        order.push(name);
      }
      byItem[name].qty += r.qty || 0;
      if (r.lineTotal != null) {
        byItem[name].lineTotal += r.lineTotal;
        byItem[name].hasAnyPrice = true;
      }
      if (r.building) byItem[name].buildings[r.building] = true;
    });
    return order.map(function (k) {
      var it = byItem[k];
      return {
        item: it.item,
        qty: it.qty,
        buildingCount: Object.keys(it.buildings).length,
        lineTotal: it.hasAnyPrice ? it.lineTotal : null,
        unitPrice: it.hasAnyPrice && it.qty > 0 ? it.lineTotal / it.qty : null,
      };
    });
  }
  return { hw: agg(1), lb: agg(2) };
}

/* ── Condensed tab render (Task 1c, 2026-07-22) ────────────────────────────────────────────────
   Read-only grouped-summary render for Compliance/Full-Scope (see the initCostEstimateTab
   short-circuit above). Self-contained (mirrors the removed _pricingRenderSummaryTab's own
   self-containment) — recomputes rows/building filter independently rather than threading state
   through the big shared render path, since this view has none of that path's per-row edit
   affordances (no toggle checkboxes, manual-price inputs, hours overrides, column resize/hide,
   sort). Building filter + toolbar controls still apply (same _pricingBldgFilter module state,
   same _pricingBuildToolbarHTML), so switching Condensed <-> Full Itemization mid-filter is
   seamless. Grand total footer reuses _pricingComputeTotals on the SAME filtered row set the
   full table would use — cannot disagree with the full view or the tier's own totals.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingRenderCondensedTab(projId, el, estimate, tier) {
  var builder = tier === 'full-scope' ? buildFullScopeRows : buildComplianceRows;
  var baseRows = builder(projId);
  baseRows = _pricingApplyLaborOverrides(projId, baseRows);
  baseRows = _pricingApplyQtyOverrides(projId, baseRows);

  var allBuildings = [];
  var bSetAll = {};
  baseRows.forEach(function (r) {
    if (r.building && !bSetAll[r.building]) {
      bSetAll[r.building] = true;
      allBuildings.push(r.building);
    }
  });

  var filterBldg = _pricingBldgFilter[projId] || '';
  var filteredRows = filterBldg
    ? baseRows.filter(function (r) {
        return r.building === filterBldg;
      })
    : baseRows;

  var totals = _pricingComputeTotals(filteredRows, estimate);
  var agg = _pricingComputeCondensedRows(filteredRows, estimate);
  var itemCount = agg.hw.length + agg.lb.length;

  var toolbarHTML = _pricingBuildToolbarHTML(projId, tier, {
    allBuildings: allBuildings,
    middleHTML:
      '<span style="font-size:11px;color:var(--text2)">Condensed — ' +
      itemCount +
      ' item' +
      (itemCount !== 1 ? 's' : '') +
      ' grouped across ' +
      allBuildings.length +
      ' building' +
      (allBuildings.length !== 1 ? 's' : '') +
      '</span> ' +
      _pricingCondensedToggleHTML(projId, tier, true),
  });

  var thBase =
    'background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;border-bottom:1px solid var(--border2)';
  var tdBase =
    'padding:6px 10px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);' +
    'font-variant-numeric:tabular-nums';

  function section(title, items) {
    if (!items.length) return '';
    var head =
      '<tr>' +
      '<th style="' +
      thBase +
      ';text-align:left">Item</th>' +
      '<th style="' +
      thBase +
      ';text-align:right">Qty</th>' +
      '<th style="' +
      thBase +
      ';text-align:right">Unit Price</th>' +
      '<th style="' +
      thBase +
      ';text-align:center" title="Number of buildings this item is needed at">Buildings</th>' +
      '<th style="' +
      thBase +
      ';text-align:right">Line Total</th>' +
      '</tr>';
    var body = items
      .map(function (it) {
        return (
          '<tr>' +
          '<td style="' +
          tdBase +
          ';white-space:normal;word-break:break-word;color:var(--text)">' +
          _pricingEscText(it.item) +
          '</td>' +
          '<td style="' +
          tdBase +
          ';text-align:right">' +
          it.qty +
          '</td>' +
          '<td style="' +
          tdBase +
          ';text-align:right">' +
          (it.unitPrice != null ? _pricingFmt(it.unitPrice) : '—') +
          '</td>' +
          '<td style="' +
          tdBase +
          ';text-align:center">' +
          it.buildingCount +
          '</td>' +
          '<td style="' +
          tdBase +
          ';text-align:right;font-weight:700">' +
          (it.lineTotal != null ? _pricingFmt(it.lineTotal) : '—') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    var sum = items.reduce(function (s, it) {
      return s + (it.lineTotal || 0);
    }, 0);
    var foot =
      '<tr><td colspan="4" style="padding:6px 10px;font-weight:700;background:var(--s1);border-top:2px solid var(--border2)">Subtotal</td>' +
      '<td style="padding:6px 10px;text-align:right;font-weight:700;background:var(--s1);border-top:2px solid var(--border2);font-variant-numeric:tabular-nums">' +
      _pricingFmt(sum) +
      '</td></tr>';
    return (
      '<div style="margin:0 14px 14px">' +
      '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">' +
      _pricingEscText(title) +
      '</div>' +
      '<div class="ch-tbl-outer" style="margin:0"><div class="ch-tbl-scroll" style="overflow:auto">' +
      '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%">' +
      '<thead>' +
      head +
      '</thead><tbody>' +
      body +
      '</tbody><tfoot>' +
      foot +
      '</tfoot>' +
      '</table></div></div></div>'
    );
  }

  var emptyState = itemCount
    ? ''
    : '<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">No items in this scope.</div>';

  el.innerHTML = [
    '<div class="ch-panel" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;height:100%">',
    toolbarHTML,
    '<div class="ch-panel-body" style="flex:1;min-height:220px;overflow:auto;padding-top:10px">',
    section('Hardware & Installation', agg.hw),
    section('Programming', agg.lb),
    emptyState,
    '</div>',
    '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
    _pricingTierLabelHTML(tier),
    '<span style="color:var(--border2)">|</span>',
    '<span style="font-size:12px;font-weight:700;color:var(--text2)">Grand Total:</span>',
    '<span style="font-size:14px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">' +
      (totals.grand !== null
        ? _pricingFmt(totals.grand)
        : '<span style="color:var(--text3);font-size:11px;font-weight:400">' +
          (totals.noCatalog ? 'Import pricing CSV' : '—') +
          '</span>') +
      '</span>',
    '</div>',
    '</div>',
  ].join('');
}

/* ── Calendar-phase date definitions (2026-07-26 fix/phase-cost-budget-model) ──────────────────
   The Recommended tier's 3-phase rollout calendar: Phase 1 Aug 1 – Dec 31 2026, Phase 2 all of
   CY2027, Phase 3 all of CY2028. Only the start/end [year, month] pairs are literal (Matt's
   actual program dates) — the months-in-phase count and the "Aug 2026 – Dec 2026" display label
   are DERIVED from those two endpoints, never a separately hand-typed 5/12/12 number, so editing
   a date here changes the downstream cost math and the label text together (task requirement:
   "Derive the month counts from the phase date ranges, don't hardcode 5/12/12").
   ─────────────────────────────────────────────────────────────────────────── */
var _PRICING_PHASE_DATE_RANGES = [
  { label: 'Phase 1', start: [2026, 8], end: [2026, 12] },
  { label: 'Phase 2', start: [2027, 1], end: [2027, 12] },
  { label: 'Phase 3', start: [2028, 1], end: [2028, 12] },
];
var _PRICING_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function _pricingMonthsBetween(startYear, startMonth, endYear, endMonth) {
  // Inclusive whole-month count, e.g. Aug 2026 -> Dec 2026 = 5 (Aug, Sep, Oct, Nov, Dec).
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}
function _pricingPhaseDateDefs() {
  return _PRICING_PHASE_DATE_RANGES.map(function (p) {
    var months = _pricingMonthsBetween(p.start[0], p.start[1], p.end[0], p.end[1]);
    var dateRange =
      _PRICING_MONTH_ABBR[p.start[1] - 1] +
      ' ' +
      p.start[0] +
      ' – ' +
      _PRICING_MONTH_ABBR[p.end[1] - 1] +
      ' ' +
      p.end[0];
    return { label: p.label, months: months, dateRange: dateRange };
  });
}
// Total calendar months across the whole 3-phase program (29 for the current Aug 2026 – Dec 2028
// dates) — used to widen the Fit-to-Budget membership ceiling in buildRecommendedRows, above, to
// the program's TRUE horizon instead of budget.termMonths (which defaults to 12).
function _pricingRecommendedProgramMonths() {
  return _pricingPhaseDateDefs().reduce(function (s, p) {
    return s + p.months;
  }, 0);
}

/* ── Monthly allowance $/mo, independent of term (2026-07-26) ─────────────────────────────────
   _pricingComputeBudgetTotal (above) converts a budget entry into "the total this budget affords
   over its configured term" — useful for the general Budget-vs-Total feature (174ad49a), but the
   calendar-phase cost model below needs the underlying $/MONTH figure on its own, decoupled from
   termMonths (the phase calendar supplies its own month counts). Returns null for a 'lump'
   denomination (no natural monthly figure) or when no amount is set — same silent convention as
   every other function in this budget feature.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingMonthlyAllowanceAmount(budget) {
  if (!budget || budget.amount == null || isNaN(budget.amount) || Number(budget.amount) <= 0) return null;
  if (budget.denomination === 'lump') return null;
  var monthsPerPeriod = { monthly: 1, quarterly: 3, annual: 12 }[budget.denomination] || 1;
  return Number(budget.amount) / monthsPerPeriod;
}

/* ── Calendar-phase cost model (2026-07-26 fix/phase-cost-budget-model; REBUILT 2026-07-26 same
   branch, later commit, to stop double-counting programming labor and stop force-filling the
   allowance — see _pricingComputeMonthlyLaborBreakdown's header comment for the full defect
   writeup) ────────────────────────────────────────────────────────────────────────────────────
   Matt's complaint: "$74.xk is not the amount we should be showing. It should be the cost for
   August 1, 2026 - December 31st, 2026 as Phase 1 shows, then Phase 2 should show the full 2027
   annual cost." The OLD phase "Cost" column was a dollar-cumulative SLICE of the Recommended
   tier's priced-MEASURES total (itself fit against a 12-month budget ceiling) stretched across a
   29-calendar-month rollout — never the actual calendar-period cost of the monthly service
   allowance. This computes the real calendar cost: months-in-phase (from _pricingPhaseDateDefs)
   x the monthly allowance (_pricingMonthlyAllowanceAmount) — e.g. JOCO $6,250/mo: Phase 1 (5 mo)
   = $31,250, Phase 2/3 (12 mo each) = $75,000, program total (29 mo) = $181,250. This part was
   already correct and is UNCHANGED by the 2026-07-26 rebuild below.

   Also surfaces, per phase, the RECURRING EM labor cost that draws against the SAME monthly
   allowance — REBUILT to sum real per-calendar-month dollars from
   _pricingRecurringEMLaborHoursForMonth/_pricingComputeMonthlyLaborBreakdown (Alarm/Report/Trend/
   Bill Entry ramped over the first 3 months + a constant Ongoing Monitoring allocation), NOT the
   flat `hours/month x hourlyRate` `_pricingComputeMonthlyService` headline (that figure —
   `budget.serviceHoursPerMonth`, e.g. 36 hrs — is the all-labor-no-parts EXTREME shown in the
   "Monthly Service Agreement" widget, never a fixed monthly floor; using it here is exactly what
   consumed ~99.6% of the allowance before this rebuild). Program & Sequence Setup hours are
   deliberately EXCLUDED from this recurring figure — they are one-time project labor already
   priced as "Programming" line items inside the measures total this same function nets against,
   so including them here would double-count the same dollars (see wiki: joco-monthly-allowance-
   vs-em-labor-overlap.md). `measuresAvailable` = allowanceTotal − emLaborTotal, floored at 0;
   `overCommitted` flags when EM labor alone would exceed that phase's calendar allowance.

   Returns null when no budget.amount is configured (same silent-until-configured convention as
   the rest of this feature) — callers fall back to the pre-existing measures-total-only view.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeProgramCostModel(projId) {
  var budget = _pricingGetBudget(projId);
  var monthlyAllowance = _pricingMonthlyAllowanceAmount(budget);
  if (monthlyAllowance == null) return null;
  var svc = _pricingComputeMonthlyService(projId); // {hours, hourlyRate, monthlyService, allowance, diff, underCap} — used here only for hourlyRate
  var hourlyRate = svc
    ? svc.hourlyRate
    : typeof _pricingGetConfig === 'function'
      ? _pricingGetConfig().hourlyRate || COST_LABOR_RATE_DEFAULT
      : COST_LABOR_RATE_DEFAULT;
  var bd = _pricingComputeMonthlyLaborBreakdown(projId); // recurring EM labor breakdown — Program & Sequence Setup deliberately excluded (priced in measures instead)

  var absoluteMonth = 0; // climbs across phase boundaries so the Month-1..3 ramp only ever applies once, at the true start of the program
  var phases = _pricingPhaseDateDefs().map(function (p) {
    var allowanceTotal = Math.round(p.months * monthlyAllowance * 100) / 100;
    var emLaborHours = 0;
    for (var i = 0; i < p.months; i++) {
      absoluteMonth++;
      emLaborHours += _pricingRecurringEMLaborHoursForMonth(bd, absoluteMonth);
    }
    var emLaborTotal = Math.round(emLaborHours * hourlyRate * 100) / 100;
    var measuresAvailable = Math.round(Math.max(0, allowanceTotal - emLaborTotal) * 100) / 100;
    return {
      label: p.label,
      dateRange: p.dateRange,
      months: p.months,
      allowanceTotal: allowanceTotal,
      emLaborTotal: emLaborTotal,
      measuresAvailable: measuresAvailable,
      overCommitted: emLaborTotal > allowanceTotal,
    };
  });

  var programMonths = phases.reduce(function (s, p) {
    return s + p.months;
  }, 0);
  var programAllowanceTotal =
    Math.round(
      phases.reduce(function (s, p) {
        return s + p.allowanceTotal;
      }, 0) * 100,
    ) / 100;
  var programEmLaborTotal =
    Math.round(
      phases.reduce(function (s, p) {
        return s + p.emLaborTotal;
      }, 0) * 100,
    ) / 100;
  // programMeasuresAvailable (2026-07-26, buildRecommendedRows netting): sum of each phase's own
  // measuresAvailable (allowanceTotal − that phase's emLaborTotal, floored at 0) — NOT
  // programAllowanceTotal − programEmLaborTotal computed at the program level, so a phase that is
  // over-committed (emLaborTotal > allowanceTotal, floored to 0 measures) never lets its shortfall
  // be silently offset by a DIFFERENT phase's surplus. Used by buildRecommendedRows as the
  // Recommended-tier Fit-to-Budget membership ceiling.
  var programMeasuresAvailable =
    Math.round(
      phases.reduce(function (s, p) {
        return s + p.measuresAvailable;
      }, 0) * 100,
    ) / 100;

  return {
    monthlyAllowance: monthlyAllowance,
    // emMonthlyCost: informational only (no external caller reads it as of this rebuild — grepped
    // before changing) — steady-state (Month 4+) recurring EM labor $/mo, i.e. the number this
    // model settles to once the Month 1-3 setup ramp has tapered off.
    emMonthlyCost: bd ? Math.round(_pricingRecurringEMLaborHoursForMonth(bd, 4) * hourlyRate * 100) / 100 : 0,
    phases: phases,
    programMonths: programMonths,
    programAllowanceTotal: programAllowanceTotal,
    programEmLaborTotal: programEmLaborTotal,
    programMeasuresAvailable: programMeasuresAvailable,
  };
}

/* ── Recommended tier 3-phase implementation timeline (Task 2, 2026-07-22; rebuilt 2026-07-26
   fix/phase-cost-budget-model; rebuilt AGAIN 2026-07-26 same branch — global ROI ranking) ───────
   Matt's ask: a calendar-phase rollout plan for the RECOMMENDED tier specifically — Phase 1
   Aug-Dec 2026, Phase 2 all of CY2027, Phase 3 all of CY2028. No calendar-phase concept existed
   anywhere in this file before this — the pre-existing row `phase:1`/`phase:2` fields mean
   Hardware-install vs Labor-programming (a WITHIN-a-year categorization), unrelated to this.

   Two DIFFERENT dollar figures are now tracked per phase, deliberately, because they answer two
   different questions (see item 4 of the task spec — "give them clear, distinct labels so no
   reader thinks they contradict"):
     - `allowanceTotal` — the CALENDAR cost of the monthly service allowance for this phase's date
       range (months x monthly allowance). This is the number Matt asked for ("the cost for
       Aug 1 - Dec 31 2026"). Comes from _pricingComputeProgramCostModel; null if no budget.amount
       is configured.
     - `measuresTotal` — the priced dollar total of the hardware/sequence rows actually assigned to
       this phase (the pre-existing "cost of the stuff being installed" figure, still computed via
       _pricingComputeTotals on this phase's own row subset, still drift-folded to foot exactly to
       measuresGrandTotal). This is NOT the same number as allowanceTotal and is never presented as
       if it were — see _pricingRecommendedTimelineHTML/_rptA36RecommendedTimelineHTML below for
       how each is labeled.

   Row assignment rule (REBUILT 2026-07-26, same branch — Matt: "Why not make phase 1 based on best
   ROI instead of building?" He's right, and it matches the proposal's own copy: "Rather than
   pursuing a large one-time capital project, Control Service Company recommends a phased
   optimization program focused on the highest-value opportunities first." The PRIOR version of
   this function (see the row-level-walk defect writeup preserved in git history) walked
   buildRecommendedRows()' building-by-building "natural/source" order — Phase 1 got whatever
   happened to be in the first buildings encountered, not the best-return measures in the
   portfolio, directly contradicting that promise.

   New rule: rank every priced row across the WHOLE portfolio (2026-07-28: no-hardware-required
   units first, then by ROI within each group — see _pricingSortUnitsNoHwFirst), then fill Phase 1
   with the best-ranked measures regardless of building, Phase 2 the next tier, Phase 3 the rest —
   each phase still bounded by its own measures envelope (allowance − that phase's own recurring EM
   labor). Concretely:
     1. buildRecommendedRows() membership IS unit membership — Step 2/3 of that function's own
        header comment: every surviving row is either the sequence half or a claimed-hardware half
        of a unit _pricingBuildRoiUnits() built and kept via the Fit-to-Budget ranking. So
        re-running _pricingBuildRoiUnits() against THIS function's own (override-applied) `rows`
        recovers the identical hw+seq bundles with nothing left unclaimed — verified by the
        `leftover` safety net below, which would non-silently pick up any row that ISN'T a unit
        member (defensive; expected to be a no-op on every real project).
     2. Each unit is scored by _pricingEquipRowScore(seqRow) — the SAME return-per-dollar ranking
        buildRecommendedRows() already uses for tier membership (do not invent a second scoring
        scheme). Units are sorted best-score-first ACROSS THE WHOLE PORTFOLIO, not grouped by
        building.
     3. A single multi-round greedy first-fit walk (same bin-pack-with-carry mechanics the prior
        per-building version used, just operating on the global ranked list instead of one
        building's rows at a time): each round offers every still-pending unit, in ROI order, to
        the CURRENT phase's own envelope; a unit too big to fit is deferred to the next round
        (next phase) — never bumping a smaller, lower-ranked unit that DOES fit out of the way.
        phaseIdx only advances forward; Phase 3's envelope is treated as Infinity DURING THIS PASS
        ONLY so nothing is ever permanently stranded before the repair pass (step 6) gets a chance
        to redistribute it against Phase 3's real envelope. Ranking at UNIT (not raw-row)
        granularity also keeps a sequence and the hardware it needs together in the same phase — a
        measure is never sold half-installed across two phases.
     4. A building can now legitimately appear in more than one phase's list far more often than
        before (its measures are scattered across the ROI ranking, not walked as one contiguous
        block) — `phases[i].buildings` still collects each building name at most once per phase.
     5. Presentation order within a phase is then RESTORED to buildRecommendedRows' own natural
        building-grouped/hw-before-seq order (via `naturalRank`) so ROI decides WHICH phase a row
        lands in, but a phase's row list still reads coherently instead of as a scattered ROI-pick
        jumble (task constraint).
     6. REPAIR PASS (added 2026-07-27, same branch — the single-pass greedy above has no
        backtracking, so it strands whatever slack is left in an earlier phase once a later phase
        runs over: on real JOCO data Phase 1 finished +$138.20 under, Phase 2 +$59.70 under, Phase
        3 -$168.50 OVER, and the smallest unit anywhere ($259.50) is bigger than either individual
        gap, so no single relocate could ever close it). After the greedy walk, every phase over
        its OWN real envelope (not the Infinity placeholder step 3 used for phase index 2) is
        repaired by (a) relocating its smallest unit to any other phase with enough slack to
        absorb it outright, then (b) if that doesn't resolve it, the least-ROI-disruptive pairwise
        swap with a unit in any other phase that brings both phases' totals back within their own
        envelopes. Repeated pass over pass (a relocate/swap in one phase can free up the slack a
        DIFFERENT phase's own repair needs) until no phase is over or a full pass finds no
        improving move, capped at `REPAIR_MAX_PASSES` (scales with unit count, not a flat
        constant) so it can't loop unboundedly on a larger portfolio. Every relocate/swap is
        logged (`repairs` on the return value) and checked for ROI inversion (a lower-scored unit
        ending up in an earlier phase than a higher-scored one it swapped with) — inversions are
        reported, never silently hidden. If total portfolio demand exceeds total portfolio
        capacity, or no relocate/swap exists that satisfies both phases' envelopes, the residual
        overage is left in place and is still visible in the invariant check — this pass never
        forces a fit that isn't real.
   When no budget is configured (envelope unavailable for any phase), falls back to an even
   1/3-of-measures-grand split (the pre-existing behavior) so the timeline still renders something
   coherent — the repair pass runs against that same even split too, since it operates on
   `phaseShare` regardless of where it came from.

   2026-07-28 ADDENDUM (comprehensive-monthly-cap task — Matt verbatim: "Why would you check labor
   only when this is a monthly allowance for all parts and labor?… Quit trying to check only one
   thing, this is a comprehensive cost estimate and should be checked that way."): the repair pass
   above (step 6) is a best-effort bin-pack — its own header comment already says plainly that a
   residual overage can be "left in place" when no relocate/swap can close it. Before this task,
   NOTHING downstream ever looked at that residual: the phase-level `overCommitted` flag returned
   below compared EM labor alone (`emLaborTotal`) against `allowanceTotal`, never `measuresTotal` —
   so a phase whose priced measures alone blew through `measuresAvailable` reported `overCommitted:
   false`. Measured on real Johnson County data at the commit this branch forked from (e3a5538):
   Phase 3 priced measures $41,945 against a $41,784 `measuresAvailable` envelope, $161 over, with
   `overCommitted` still `false`. Fixed below: `overCommitted` is now computed AFTER the drift-fold
   (so it reflects each phase's FINAL `measuresTotal`) as `(emLaborTotal + measuresTotal) >
   allowanceTotal` — every dollar this phase actually draws against the allowance, not just the
   labor slice. The old labor-only signal is preserved as `emLaborOverCommitted` (read only by the
   facilitiesText fallback-copy branch above, which is answering a different, narrower question —
   see that field's own comment). Surfaced non-silently in `_pricingRecommendedTimelineHTML`
   (var(--warn) cell + caption naming every over-allowance phase and its overage) — never fixed by
   silently trimming/deferring measures out of an over-allowance phase; a genuine overage stays
   visible so Matt can act on it, per this task's explicit instruction not to hide the symptom.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeRecommendedTimeline(projId) {
  var estimate = _pricingGetEstimate(projId);
  var rows = buildRecommendedRows(projId);
  rows = _pricingApplyLaborOverrides(projId, rows);
  rows = _pricingApplyQtyOverrides(projId, rows);
  if (!rows.length) return null;

  var grandTotals = _pricingComputeTotals(rows, estimate);
  if (grandTotals.grand === null) return null; // nothing priced yet — same silent-until-priced convention as the rest of this file

  // naturalRank: buildRecommendedRows' own natural/source row order (building-grouped,
  // hw-before-seq — see the 0ae36950 comment above that function) — used ONLY to restore a
  // coherent within-phase presentation order after ROI ranking decides phase membership (step 5
  // above), never to decide which phase a row lands in.
  var naturalRank = {};
  rows.forEach(function (r, i) {
    naturalRank[r.id] = i;
  });

  var grand = grandTotals.grand;
  var defs = _pricingPhaseDateDefs();
  var costModel = _pricingComputeProgramCostModel(projId); // null when no budget.amount configured

  // Each phase's OWN envelope for MEASURES specifically — measuresAvailable (the calendar
  // allowance net of that phase's own EM labor cost), not the gross allowanceTotal — when a
  // budget is configured, since allowanceTotal includes dollars already committed to EM labor and
  // is not itself an envelope for hardware/programming measures (task item 2: "assign measures
  // per phase against that phase's own budget envelope"). Otherwise falls back to an even
  // 1/3-of-measures-grand split (pre-existing behavior, still needed for the no-budget case).
  // NON-cumulative deliberately (2026-07-26 bin-pack rebuild): each phase is checked against ITS
  // OWN phaseShare[i], never a running cumulative ceiling — a cumulative ceiling let unused slack
  // in an earlier phase silently roll forward and inflate a LATER phase's admission budget (Phase
  // 1 finishing $6.7k under its envelope let Phase 2 over-admit by the same ~$6.7k under a
  // cumulative check), which is exactly the kind of silent cross-phase borrowing the invariant
  // forbids.
  var phaseShare = defs.map(function (d, i) {
    return costModel ? costModel.phases[i].measuresAvailable : grand / 3;
  });

  // ── Global ROI-ranked units ────────────────────────────────────────────────────────────────
  // _pricingBuildRoiUnits (the SAME pairing/scoring engine buildRecommendedRows uses for tier
  // membership) bundles every savings-type sequence with the hardware it needs into one unit
  // scored by _pricingEquipRowScore. Re-run here against this function's own override-applied
  // `rows` — see step 1 of the header comment above for why this recovers the identical bundles
  // buildRecommendedRows already committed to.
  var units = _pricingBuildRoiUnits(rows).map(function (u) {
    var unitRows = u.hwRows.concat([u.seqRow]);
    return {
      rows: unitRows,
      building: u.seqRow.building,
      score: u.score,
      total: _pricingComputeTotals(unitRows, estimate).grand || 0,
    };
  });
  // Defensive safety net (expected no-op — see step 1 above): if any row from `rows` is NOT a
  // member of any unit _pricingBuildRoiUnits formed (should never happen given buildRecommendedRows'
  // own membership rule, but a silently-dropped row would violate the "nothing dropped" constraint),
  // fold it in as its own single-row unit, scored the same way the 'equipment' flat-sort mode
  // scores unpaired rows, rather than losing it from the timeline entirely.
  var claimedIds = {};
  units.forEach(function (u) {
    u.rows.forEach(function (r) {
      claimedIds[r.id] = true;
    });
  });
  rows.forEach(function (r) {
    if (claimedIds[r.id]) return;
    units.push({
      rows: [r],
      building: r.building,
      score: _pricingEquipRowScore(r),
      total: _pricingComputeTotals([r], estimate).grand || 0,
    });
  });
  // 2026-07-28 (fix/roi-no-hardware-first-per-unit): no-hardware-first primary key, ROI score
  // (stable sort, best first) secondary key within each group — see _pricingSortUnitsNoHwFirst's
  // header comment for the full rationale (this REVISES the pure ROI-score ordering DCV's
  // priorityBonus previously relied on, per Matt: "we really should be prioritizing sequences
  // that don't require installing sensors first").
  // Bug 2744e688 (2026-07-27): measure-family diversity tie-break — reorders ONLY within
  // exactly-tied score groups so an already-represented family (e.g. 19 tied ahu_sat_reset units)
  // never crowds an equally-scored sibling family (e.g. 5 tied ahu_dsp_reset/fan-energy units) out
  // of the phase it would otherwise fit. See _pricingDiversifyTiedUnits' header comment for the
  // full diagnosis/design. Never changes cross-score ranking; now run separately within each
  // hardware-readiness group (see _pricingSortUnitsNoHwFirst) so it can never cross that boundary.
  units = _pricingSortUnitsNoHwFirst(units);

  // phaseUnits: UNIT-granularity working set for the greedy walk + repair pass below (kept
  // separate from the final `phases` rows/buildings/total view, which is derived once at the end
  // — see step 6 of the header comment). Tracking whole units (never individual rows) here is
  // what keeps a sequence and the hardware it needs together through every relocate/swap.
  var phaseUnits = [[], [], []];
  // Multi-round greedy first-fit walk over the GLOBAL ROI-ranked unit list — see step 3 of the
  // header comment above. Replaces the prior per-building walk (preserved in git history) with the
  // same bin-pack-with-carry mechanics, just operating on ranked units across the whole portfolio
  // instead of one building's rows at a time; there is no "per building" boundary to reset
  // phaseIdx against anymore — phaseIdx only ever advances forward.
  var pending = units;
  var phaseIdx = 0;
  while (pending.length) {
    var envelope = phaseIdx < 2 ? phaseShare[phaseIdx] : Infinity;
    var runningTotal = 0;
    var stillPending = [];
    pending.forEach(function (item) {
      if (phaseIdx === 2 || runningTotal + item.total <= envelope) {
        phaseUnits[phaseIdx].push(item);
        runningTotal += item.total;
      } else {
        stillPending.push(item);
      }
    });
    pending = stillPending;
    if (pending.length) {
      if (phaseIdx < 2) phaseIdx++;
      else break; // unreachable safety net — phaseIdx 2 uses an Infinity envelope, so pending always empties above
    }
  }

  // ── Repair pass — step 6 of the header comment above ──────────────────────────────────────
  // realEnvelope: the TRUE per-phase envelope, including phase index 2 (the greedy walk above
  // used Infinity there deliberately so nothing was permanently stranded before this pass runs).
  var realEnvelope = phaseShare.slice();
  var repairLog = []; // every relocate/swap actually performed — surfaced on the return value for verification/reporting, not rendered anywhere
  // REPAIR_MAX_PASSES: scales with portfolio size (6 full relocate-then-swap passes per unit,
  // floored at 50) instead of a flat constant tuned to JOCO's ~49-unit portfolio, so this can't
  // loop unboundedly on a much larger one. Each pass itself does O(unitsInPhase^2) work across at
  // most 3 phases, so total work stays polynomial in unit count.
  var REPAIR_MAX_PASSES = Math.max(50, units.length * 6);
  var _repairPhaseTotal = function (i) {
    return phaseUnits[i].reduce(function (s, u) {
      return s + u.total;
    }, 0);
  };
  var repairPass = 0;
  var repairStalled = false;
  while (!repairStalled && repairPass < REPAIR_MAX_PASSES) {
    repairPass++;
    repairStalled = true;
    for (var pi = 0; pi < phaseUnits.length; pi++) {
      var overage = Math.round((_repairPhaseTotal(pi) - realEnvelope[pi]) * 100) / 100;
      if (overage <= 0.005) continue; // at/under envelope already (penny epsilon)

      // (a) relocate — try this phase's own units smallest-total-first (least disruptive move)
      var ordered = phaseUnits[pi].slice().sort(function (a, b) {
        return a.total - b.total;
      });
      var didRelocate = false;
      for (var ci = 0; ci < ordered.length && !didRelocate; ci++) {
        var cand = ordered[ci];
        for (var pj = 0; pj < phaseUnits.length; pj++) {
          if (pj === pi) continue;
          var slackJ = realEnvelope[pj] - _repairPhaseTotal(pj);
          if (cand.total <= slackJ + 0.005) {
            phaseUnits[pi].splice(phaseUnits[pi].indexOf(cand), 1);
            phaseUnits[pj].push(cand);
            repairLog.push({
              type: 'relocate',
              rowIds: cand.rows.map(function (r) {
                return r.id;
              }),
              building: cand.building,
              score: cand.score,
              total: cand.total,
              from: pi,
              to: pj,
            });
            didRelocate = true;
            repairStalled = false;
            break;
          }
        }
      }
      if (didRelocate) continue;

      // (b) swap — search every other phase's units for a valid pair. A single 2-phase swap can
      // only fully resolve pi's overage when the RECEIVING phase's own slack is >= pi's entire
      // overage (slack(pj) >= overage(pi)) — algebraically, u.total - v.total must sit in
      // [overage(pi), slack(pj)] simultaneously, which is only possible when slack(pj) is that
      // big. When NO phase individually holds enough slack (e.g. JOCO: Phase 1 slack $138.20 and
      // Phase 2 slack $59.70 are each smaller than Phase 3's $168.50 overage), fully resolving in
      // ONE swap is mathematically impossible no matter which units are chosen — this is a
      // property of the envelope numbers, not of this algorithm's search depth. In that case the
      // best available move is a swap that reduces pi's overage as much as slack(pj) allows
      // WITHOUT fully closing it (v.total >= u.total − slack(pj)), so a SECOND swap against a
      // DIFFERENT phase on a later pass can close what's left — chaining slack across phases the
      // way a single 2-party swap cannot.
      // Candidates are ranked in tiers, evaluated in this order (task's explicit instructions,
      // in priority order): (1) fully resolves pi this step > only makes partial progress;
      // (2) does NOT invert ROI order (the unit ending up in the earlier-indexed phase scores >=
      // the unit ending up in the later-indexed phase) > DOES invert — an inverting swap is only
      // ever taken when every non-inverting candidate in the same resolve-tier was exhausted,
      // i.e. inversion is used strictly to satisfy the envelopes, never merely to minimize
      // disruption; (3) within the same (resolves, non-inverting) group: least ROI-score
      // disruption for a fully-resolving swap, or the largest overage reduction for a
      // partial-progress swap (ties broken by least disruption).
      var candidates = [];
      for (var pj2 = 0; pj2 < phaseUnits.length; pj2++) {
        if (pj2 === pi) continue;
        for (var ui = 0; ui < phaseUnits[pi].length; ui++) {
          var u = phaseUnits[pi][ui];
          for (var vi = 0; vi < phaseUnits[pj2].length; vi++) {
            var v = phaseUnits[pj2][vi];
            if (v.total >= u.total) continue; // swap must actually reduce phase pi's total
            var newPiTotal = _repairPhaseTotal(pi) - u.total + v.total;
            var newPjTotal = _repairPhaseTotal(pj2) - v.total + u.total;
            if (newPjTotal > realEnvelope[pj2] + 0.005) continue; // never push the OTHER phase over its own envelope
            var earlierPhaseC = Math.min(pi, pj2);
            var scoreInEarlier = pi === earlierPhaseC ? v.score : u.score; // after the swap, u leaves pi/enters pj2 and v leaves pj2/enters pi
            var scoreInLater = pi === earlierPhaseC ? u.score : v.score;
            candidates.push({
              u: u,
              v: v,
              from: pi,
              to: pj2,
              resolves: newPiTotal <= realEnvelope[pi] + 0.005,
              inverted: scoreInEarlier < scoreInLater,
              disruption: Math.abs(u.score - v.score),
              reduction: u.total - v.total,
            });
          }
        }
      }
      candidates.sort(function (a, b) {
        if (a.resolves !== b.resolves) return a.resolves ? -1 : 1; // fully-resolving swaps first
        if (a.inverted !== b.inverted) return a.inverted ? 1 : -1; // non-inverting swaps first, within the same resolve tier
        return a.resolves ? a.disruption - b.disruption : b.reduction - a.reduction;
      });
      var best = candidates.length ? candidates[0] : null;
      if (best) {
        phaseUnits[best.from].splice(phaseUnits[best.from].indexOf(best.u), 1);
        phaseUnits[best.to].splice(phaseUnits[best.to].indexOf(best.v), 1);
        phaseUnits[best.from].push(best.v);
        phaseUnits[best.to].push(best.u);
        // Inversion (already computed above, before the swap was chosen — whichever unit ends up
        // in the EARLIER-indexed calendar phase should score >= the unit ending up in the
        // LATER-indexed phase; the sort above already deprioritized inverting candidates whenever
        // a non-inverting one existed in the same resolve tier, so `best.inverted === true` here
        // means every non-inverting option was exhausted, i.e. this inversion WAS strictly
        // required to satisfy the envelopes) — logged, never hidden.
        repairLog.push({
          type: 'swap',
          outRowIds: best.u.rows.map(function (r) {
            return r.id;
          }),
          outBuilding: best.u.building,
          outScore: best.u.score,
          outTotal: best.u.total,
          inRowIds: best.v.rows.map(function (r) {
            return r.id;
          }),
          inBuilding: best.v.building,
          inScore: best.v.score,
          inTotal: best.v.total,
          phaseA: best.from,
          phaseB: best.to,
          inverted: best.inverted,
        });
        repairStalled = false;
      }
    }
  }

  // Flatten the repaired unit assignment into the rows/buildings/total shape the rest of this
  // function (and every downstream caller) expects — buildings is rebuilt from `naturalRank` order
  // immediately below, so an unsorted dedup pass here is fine.
  var phases = phaseUnits.map(function (list) {
    var p = { rows: [], buildings: [], total: 0 };
    list.forEach(function (item) {
      item.rows.forEach(function (r) {
        p.rows.push(r);
      });
      if (p.buildings.indexOf(item.building) === -1) p.buildings.push(item.building);
      p.total += item.total;
    });
    return p;
  });

  // Restore coherent within-phase presentation order (step 5 above) — ROI decided WHICH phase a
  // row lands in; this restores buildRecommendedRows' own building-grouped/hw-before-seq order for
  // the rows that actually landed in phase i, and derives `buildings` from that same restored
  // order instead of the scattered ROI pick-order buildings were first encountered in.
  phases.forEach(function (p) {
    p.rows.sort(function (a, b) {
      return naturalRank[a.id] - naturalRank[b.id];
    });
    var seen = {};
    p.buildings = [];
    p.rows.forEach(function (r) {
      if (r.building && !seen[r.building]) {
        seen[r.building] = true;
        p.buildings.push(r.building);
      }
    });
  });

  // ── Bug 3306c189 (2026-07-27): building dedup / cross-phase description ──────────────────────
  // Point 4 of the header comment above is real and intentional — a building can legitimately have
  // measures scattered across phases (a sensor in one phase, the sequence depending on it in a
  // later one) — but every phase's `buildings` array previously listed EVERY building with ANY row
  // that phase independently, so a building with work in 2-3 phases was named 2-3 times in the
  // Proposal's "Facilities Included" row/column with no indication of what each occurrence meant
  // (Phase 2 showed 21 buildings, Phase 3 showed 13, heavily overlapping — the client's own base
  // document lists each building exactly once: 5, then 9, then 8).
  //
  // Fix is presentation-only — the optimization/phase assignment above is untouched. Each building
  // is named ONCE, in the earliest phase it has work; that occurrence is annotated with which
  // later phase(s) its work continues into (never silently hidden — just not repeated as a bare
  // duplicate name). A phase whose only building involvement is "continuing" work from an earlier
  // phase gets its own sentence naming those buildings and where they were introduced, so it never
  // reads as if nothing is happening there.
  //
  // bldgPhaseIndices: building name -> ascending array of every phase index (0/1/2) that has at
  // least one row for that building, derived from the SAME final p.rows/p.buildings computed above
  // (post repair-pass, post natural-order restore) — not a re-derivation of phase membership.
  var bldgPhaseIndices = {};
  phases.forEach(function (p, i) {
    p.buildings.forEach(function (bName) {
      (bldgPhaseIndices[bName] = bldgPhaseIndices[bName] || []).push(i);
    });
  });
  phases.forEach(function (p, i) {
    var _cmForFallback = costModel ? costModel.phases[i] : null;
    var newNames = p.buildings.filter(function (bName) {
      return bldgPhaseIndices[bName][0] === i;
    });
    var continuingNames = p.buildings.filter(function (bName) {
      return bldgPhaseIndices[bName][0] !== i;
    });
    // Dedup: `buildings` now names a building ONLY in its earliest phase — never again later.
    p.buildings = newNames;

    var pieces = [];
    if (newNames.length) {
      var annotated = newNames.map(function (bName) {
        var laterLabels = bldgPhaseIndices[bName]
          .slice(1)
          .map(function (pi) {
            return defs[pi] ? defs[pi].label : null;
          })
          .filter(Boolean);
        return laterLabels.length ? bName + ' (continues in ' + laterLabels.join(', ') + ')' : bName;
      });
      pieces.push(annotated.join('; ') + '.');
    }
    if (continuingNames.length) {
      var byOrigin = {};
      var originOrder = [];
      continuingNames.forEach(function (bName) {
        var originIdx = bldgPhaseIndices[bName][0];
        if (!byOrigin[originIdx]) {
          byOrigin[originIdx] = [];
          originOrder.push(originIdx);
        }
        byOrigin[originIdx].push(bName);
      });
      originOrder.sort(function (a, b) {
        return a - b;
      });
      originOrder.forEach(function (originIdx) {
        var originLabel = defs[originIdx] ? defs[originIdx].label : 'Phase ' + (originIdx + 1);
        pieces.push(
          'Continued work at facilities introduced in ' + originLabel + ': ' + byOrigin[originIdx].join(', ') + '.',
        );
      });
    }
    if (!pieces.length) {
      pieces.push(
        _cmForFallback && _cmForFallback.overCommitted
          ? "Ongoing Energy Management Services labor only — this period's allowance is fully committed to recurring service."
          : 'Ongoing Energy Management Services only for this period.',
      );
    }
    // facilitiesText: single ready-to-display plain-text string (no HTML) — every "Facilities
    // Included" render site (report-engine.js's Phase Table page AND Cost Estimate page,
    // pricing-estimator.js's own Recommended timeline table) reads this ONE field instead of each
    // independently re-deriving a dedup/fallback string from the raw `buildings` array, so the
    // wording can never drift between the 3 places it's shown.
    p.facilitiesText = pieces.join(' ');
  });

  var out = phases.map(function (p, i) {
    var cm = costModel ? costModel.phases[i] : null;
    return {
      label: defs[i].label,
      dateRange: defs[i].dateRange,
      months: defs[i].months,
      // buildings (Bug 3306c189, 2026-07-27): deduped — a building name appears here ONLY in the
      // earliest phase it has work, so this can legitimately be empty for a later phase whose
      // buildings were all already introduced earlier (that phase still has real `rows`/
      // `measuresTotal` — see `facilitiesText` below for the client-facing description of that
      // continuing work). Callers should prefer `facilitiesText` over re-deriving a summary from
      // this array.
      buildings: p.buildings,
      // facilitiesText (Bug 3306c189): ready-to-display plain-text "Facilities Included" string —
      // see the dedup/cross-phase-description block above this map for the full derivation.
      facilitiesText: p.facilitiesText,
      // rows (2026-07-26, Service Proposal rebuild): exposes the raw priced rows backing this
      // phase so callers can derive a live "what's included" summary without re-deriving the
      // phase split themselves.
      rows: p.rows,
      // measuresTotal (renamed from `total` 2026-07-26 — see item 4 above): priced dollar cost of
      // the rows assigned to this phase, drift-folded below to foot to measuresGrandTotal.
      measuresTotal: Math.round(p.total * 100) / 100,
      // allowanceTotal (new 2026-07-26): the calendar cost of the service allowance for this
      // phase's date range — the number Matt asked to see as "the cost for [date range]". null
      // when no budget.amount is configured.
      allowanceTotal: cm ? cm.allowanceTotal : null,
      emLaborTotal: cm ? cm.emLaborTotal : null,
      measuresAvailable: cm ? cm.measuresAvailable : null,
      // emLaborOverCommitted (renamed 2026-07-28 from `overCommitted` — see comprehensive-monthly-
      // cap task): the OLD labor-only signal (EM labor alone > allowanceTotal), preserved under its
      // own name only because the fallback-copy branch above (facilitiesText, "labor only — this
      // period's allowance is fully committed to recurring service") reads costModel's own
      // per-phase `overCommitted` directly (not this field) to answer a narrower question — whether
      // a phase has zero buildings because EM labor alone ate the whole allowance. Not read as the
      // "is this phase over budget" signal anywhere anymore; `overCommitted` below (computed after
      // the drift-fold, once measuresTotal is final) is that signal now.
      emLaborOverCommitted: cm ? cm.overCommitted : false,
    };
  });

  var sumMeasures = out.reduce(function (s, p) {
    return s + p.measuresTotal;
  }, 0);
  var drift = Math.round((grand - sumMeasures) * 100) / 100;
  if (drift !== 0) {
    for (var i = out.length - 1; i >= 0; i--) {
      // Bug 3306c189 fix note: this used to check `out[i].buildings.length`, which broke once
      // `buildings` became deduped (a phase can have real rows/measuresTotal but zero NEWLY-named
      // buildings if every building in it was already introduced earlier) — check the actual row
      // membership instead, which is unaffected by the dedup.
      if (out[i].rows.length) {
        out[i].measuresTotal = Math.round((out[i].measuresTotal + drift) * 100) / 100;
        break;
      }
    }
  }

  // 2026-07-28 (comprehensive-monthly-cap task, item 1 — Matt verbatim: "Why would you check labor
  // only when this is a monthly allowance for all parts and labor?… Quit trying to check only one
  // thing, this is a comprehensive cost estimate and should be checked that way."): THE
  // comprehensive over-commit check. Runs AFTER the drift-fold above so it evaluates each phase's
  // FINAL measuresTotal (drift-folding can shift the last-with-rows phase's measuresTotal by a few
  // cents to a few dollars — checking before the fold could miss/misreport a violation on that
  // phase). totalCommitted = emLaborTotal + measuresTotal — every dollar this phase actually draws
  // against the allowance, parts AND labor together, never labor alone. Measured defect this
  // replaced, on real Johnson County data at the commit this branch forked from (e3a5538, projId
  // 1779664753271): Phase 3 priced $41,945.00 in measures against a $41,784.00 measuresAvailable
  // envelope — $161.00 over — with the old labor-only `overCommitted` still reporting `false`,
  // because measuresTotal was never part of that comparison. (The dispatch that opened this task
  // cited a larger $5,531.50 example from an earlier pricing-data snapshot; this is the actual
  // figure measured on the current e3a5538 data — real numbers change as the underlying priced
  // rows change, the defect itself does not.)
  out.forEach(function (p) {
    if (p.allowanceTotal == null) {
      p.totalCommitted = null;
      p.overCommitted = false;
      p.overageAmount = 0;
      return;
    }
    var totalCommitted = Math.round(((p.emLaborTotal || 0) + p.measuresTotal) * 100) / 100;
    p.totalCommitted = totalCommitted;
    p.overCommitted = totalCommitted > p.allowanceTotal;
    p.overageAmount = p.overCommitted ? Math.round((totalCommitted - p.allowanceTotal) * 100) / 100 : 0;
    if (p.overCommitted) {
      console.error(
        '[_pricingComputeRecommendedTimeline] PHASE OVER ALLOWANCE (labor + measures combined): ' +
          p.label +
          ' — EM labor ' +
          _pricingFmt(p.emLaborTotal) +
          ' + priced measures ' +
          _pricingFmt(p.measuresTotal) +
          ' = ' +
          _pricingFmt(totalCommitted) +
          ' committed vs. ' +
          _pricingFmt(p.allowanceTotal) +
          ' calendar allowance, over by ' +
          _pricingFmt(p.overageAmount) +
          '. Surfaced in the Cost Estimate UI, not silently trimmed — see _pricingRecommendedTimelineHTML.',
      );
    }
  });

  return {
    phases: out,
    measuresGrandTotal: grand, // renamed from `grandTotal` 2026-07-26 — the priced-measures total (old $74,826-style figure)
    programAllowanceTotal: costModel ? costModel.programAllowanceTotal : null, // NEW headline figure — sum of calendar phase costs (e.g. $181,250)
    programEmLaborTotal: costModel ? costModel.programEmLaborTotal : null,
    programMonths: _pricingRecommendedProgramMonths(),
    monthlyAllowance: costModel ? costModel.monthlyAllowance : null,
    // repairs/repairPasses (2026-07-27, this task): diagnostic-only — the relocate/swap log and
    // pass count from step 6's repair pass above. Not read by any render function; exists so
    // verification tooling can inspect what the repair pass actually did without re-deriving it.
    repairs: repairLog,
    repairPasses: repairPass,
  };
}

/* ── Recommended tier timeline table (Task 2, 2026-07-22; rebuilt 2026-07-26
   fix/phase-cost-budget-model) ─────────────────────────────────────────────────────────────────
   Renders _pricingComputeRecommendedTimeline as a plain table — no boxes/cards, following the
   site's ch-tbl conventions (same --s1 header / grid-line cell pattern as
   _pricingLaborBreakdownHTML immediately below this). Returns '' when the Recommended tier has no
   priced rows yet, same silent-until-priced convention used throughout this file.

   Two distinct dollar columns, per item 4 of the task spec (never let one "Total" row silently
   mean two different things):
     - "Phase Service Allowance" = the calendar cost of the monthly service allowance for that
       phase's date range (allowanceTotal — the number Matt asked for). Falls back to the priced
       measures total with an explicit "(no budget configured)" suffix when no budget.amount is
       set, so the column never silently goes blank/— for an unconfigured project.
     - "Priced Measures This Phase" = the dollar cost of the hardware/sequence rows assigned to
       this phase (measuresTotal — the pre-existing figure), always shown so a reader can see both
       numbers side by side and is never left assuming they're the same thing.
   A caption line beneath the table surfaces the EM-labor-vs-measures split (verify requirement:
   "prove measures don't consume the whole allowance") using emLaborTotal/measuresAvailable from
   the compute function — silent (omitted) when no budget is configured.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingRecommendedTimelineHTML(projId) {
  var tl = _pricingComputeRecommendedTimeline(projId);
  if (!tl) return '';

  var hasBudget = tl.programAllowanceTotal != null;

  var thBase =
    'background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;' +
    'letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;border-bottom:1px solid var(--border2)';
  var tdBase =
    'padding:8px 10px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);' +
    'font-variant-numeric:tabular-nums;vertical-align:top';

  var headerCells =
    '<th style="' +
    thBase +
    ';text-align:left">Phase</th>' +
    '<th style="' +
    thBase +
    ';text-align:left">Date Range</th>' +
    '<th style="' +
    thBase +
    ';text-align:left">Scope Summary</th>' +
    '<th style="' +
    thBase +
    ';text-align:right">Phase Service Allowance</th>' +
    '<th style="' +
    thBase +
    ';text-align:right">Priced Measures This Phase</th>';

  var bodyRows = tl.phases
    .map(function (p) {
      // Scope Summary (Bug 3306c189, 2026-07-27): reads the shared `facilitiesText` field computed
      // once in _pricingComputeRecommendedTimeline (dedup — a building is named only in its
      // earliest phase, with later-phase continuation described rather than repeated) instead of
      // re-deriving a "N buildings: ..." string from the raw (now-deduped) `buildings` array here,
      // which would otherwise undercount buildings with real work this phase that were merely
      // introduced earlier. Already includes the "no additional scope this period" fallback text.
      var scope = _pricingEscText(p.facilitiesText);
      var allowanceCell = hasBudget
        ? _pricingFmt(p.allowanceTotal)
        : _pricingFmt(p.measuresTotal) +
          ' <span style="font-weight:400;color:var(--text3);font-size:10px">(no budget configured)</span>';
      // 2026-07-28 (comprehensive-monthly-cap task, item 3 — surface violations loudly/visibly in
      // the Cost Estimate UI, not just console.error): p.overCommitted is now the COMPREHENSIVE
      // check (labor + measures combined vs. allowanceTotal — see
      // _pricingComputeRecommendedTimeline). No new box/card — same var(--warn) text-color +
      // inline tag convention already used for the monthly cap cells in
      // _pricingLaborBreakdownHTML, applied to the existing "Priced Measures This Phase" cell.
      var measuresCell =
        _pricingFmt(p.measuresTotal) +
        (p.overCommitted
          ? ' <span style="font-size:9px;font-weight:700;color:var(--warn)">OVER ALLOWANCE by ' +
            _pricingFmt(p.overageAmount) +
            '</span>'
          : '');
      return (
        '<tr>' +
        '<td style="' +
        tdBase +
        ';font-weight:700;color:var(--text)">' +
        _pricingEscText(p.label) +
        '</td>' +
        '<td style="' +
        tdBase +
        ';white-space:nowrap;color:var(--text2)">' +
        _pricingEscText(p.dateRange) +
        '</td>' +
        '<td style="' +
        tdBase +
        ';white-space:normal;word-break:break-word;color:var(--text2)">' +
        scope +
        '</td>' +
        '<td style="' +
        tdBase +
        ';text-align:right;font-weight:700;color:var(--text)">' +
        allowanceCell +
        '</td>' +
        '<td style="' +
        tdBase +
        ';text-align:right;' +
        (p.overCommitted ? 'color:var(--warn);font-weight:700' : 'color:var(--text2)') +
        '">' +
        measuresCell +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  var footTotalAllowance = hasBudget ? tl.programAllowanceTotal : tl.measuresGrandTotal;

  // EM-labor-vs-measures caption (task verify requirement: prove measures don't consume the
  // whole allowance) — silent when no budget is configured (same convention as the rest of this
  // feature).
  var laborCaption = '';
  if (hasBudget) {
    var overCommittedPhases = tl.phases.filter(function (p) {
      return p.overCommitted;
    });
    // 2026-07-28: wording corrected — p.overCommitted is the COMPREHENSIVE check (EM labor +
    // priced measures together vs. allowanceTotal), not a labor-only signal, so the note naming a
    // violation must say what actually exceeded the allowance, not just "EM labor alone" (that was
    // the exact defect this task fixed — see _pricingComputeRecommendedTimeline's header comment).
    laborCaption =
      '<div style="font-size:10.5px;color:var(--text3);margin:6px 14px 0;line-height:1.5">' +
      'Phase Service Allowance already includes Ongoing Energy Management Services labor for that ' +
      'period (' +
      tl.phases
        .map(function (p) {
          return _pricingEscText(p.label) + ': ' + _pricingFmt(p.emLaborTotal);
        })
        .join(' · ') +
      ') — the dollar amount left over for hardware/programming measures after that labor is ' +
      tl.phases
        .map(function (p) {
          return _pricingEscText(p.label) + ': ' + _pricingFmt(p.measuresAvailable);
        })
        .join(' · ') +
      '.' +
      (overCommittedPhases.length
        ? ' <span style="color:var(--warn);font-weight:700">Over allowance (labor + measures combined): ' +
          overCommittedPhases
            .map(function (p) {
              return _pricingEscText(p.label) + ' by ' + _pricingFmt(p.overageAmount);
            })
            .join(' · ') +
          '.</span>'
        : '') +
      '</div>';
  }

  // Bounded max-height + its own overflow:auto scroll region (same "multi-zone-scroll" pattern
  // ui-standards.md documents for the Top ROI card and _pricingLaborBreakdownHTML immediately
  // above) — without this, an unbounded table stacked as a flex-shrink:0 sibling under the
  // fixed-height, overflow:hidden `.ch-panel` gets silently CLIPPED past the panel's bottom edge
  // (verified: `.ch-panel` scrollHeight 965 vs clientHeight 815 before this fix — Phase 2/Phase 3/
  // Total rows were invisible with no way to scroll to them). 220px comfortably shows all 4 rows
  // (3 phases + total) for a typical portfolio; a longer building list just scrolls within this
  // box instead of pushing the whole panel past its layout budget.
  return (
    '<div style="margin:10px 14px 0;flex-shrink:0">' +
    '<div style="font-weight:700;color:var(--text2);margin-bottom:6px;font-size:11px;text-transform:uppercase;' +
    'letter-spacing:0.5px">Recommended Tier — Phased Implementation Timeline</div>' +
    '<div class="ch-tbl-outer" style="margin:0 0 4px;max-height:220px;display:flex;flex-direction:column">' +
    '<div class="ch-tbl-scroll" style="overflow:auto">' +
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%">' +
    '<thead><tr>' +
    headerCells +
    '</tr></thead>' +
    '<tbody>' +
    bodyRows +
    '</tbody>' +
    '<tfoot><tr><td colspan="3" style="padding:8px 10px;font-weight:700;background:var(--s1);border-top:2px solid var(--border2)">' +
    (hasBudget ? 'Program Total (Service Allowance)' : 'Total (no budget configured)') +
    '</td>' +
    '<td style="padding:8px 10px;text-align:right;font-weight:700;background:var(--s1);border-top:2px solid var(--border2);font-variant-numeric:tabular-nums">' +
    _pricingFmt(footTotalAllowance) +
    '</td>' +
    '<td style="padding:8px 10px;text-align:right;font-weight:700;background:var(--s1);border-top:2px solid var(--border2);font-variant-numeric:tabular-nums;color:var(--text2)">' +
    _pricingFmt(tl.measuresGrandTotal) +
    '</td></tr></tfoot>' +
    '</table>' +
    '</div>' +
    laborCaption +
    '</div>' +
    '</div>'
  );
}

/* ── Phase 4: save Phase 3 version of initCostEstimateTab ─────────────────── */
var _initCostEstimateTabPhase3 = initCostEstimateTab;

/* ── Phase 4: shadow initCostEstimateTab ───────────────────────────────────
   Adds:
     1. Per-sequence hour overrides applied before render
     2. Building filter (module-level state + toolbar dropdown)
     3. Column sort (applied to data rows, group structure preserved)
     4. Column resize handles in header (CSS per ui-standards.md)
     5. Column visibility toggle (gear icon)
     6. Post-render: apply saved widths, attach resize + sort handlers
   ─────────────────────────────────────────────────────────────────────────── */
initCostEstimateTab = function initCostEstimateTab(projId) {
  var el = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (!el) return;

  // review-phase4.md #2: migrate any pre-Phase-4 saved column widths/hidden-cols to the
  // new post-Hours-column indices before anything reads them. Must run before the first
  // _pricingGetHiddenCols/_pricingGetColWidths call below — idempotent, safe to call every render.
  _pricingMigrateColSchema(projId);

  // ── 1. Get state
  var estimate = _pricingGetEstimate(projId);
  var tier = estimate.tier || 'compliance';

  // 2026-07-22: "Summary" (the per-building aggregate sub-tab, formerly rendered by
  // _pricingRenderSummaryTab) was REMOVED entirely per Matt's explicit request ("The Cost
  // Estimate per building I do not like and it honestly gives no information. Just remove
  // completely."). Any project with a PRE-EXISTING saved `tier: 'summary'` (from before this
  // change) falls back to Compliance here rather than reaching a tier value none of the toggle
  // buttons / row-builder branches below recognize.
  if (tier === 'summary') tier = 'compliance';

  // 2026-07-22 (Task 1c — "Compliance and Full Scope is huge"): Compliance/Full-Scope default to
  // a CONDENSED grouped-summary view (one row per distinct item, aggregated across every
  // building, qty/unit-price/line-total all visible) instead of the full per-building/per-row
  // table — same "collapse repetitive rows, itemize on demand" pattern already used by the
  // Proposal's collapsible Install & Programming Detail panel (report-engine.js
  // _rptA36TierDetailPanelHTML). The full editable per-building table is unchanged and still one
  // click away via the toggle rendered inside _pricingRenderCondensedTab. Recommended/Compare are
  // NOT condensed by default — Recommended is already a small budget-fit selection; Compare needs
  // the side-by-side per-row view to be useful. `estimate.condensedTier[tier] === false` is the
  // explicit "user chose full itemization" escape hatch — undefined/missing defaults to condensed.
  var _condensedApplicable = tier === 'compliance' || tier === 'full-scope';
  var _condensedOn = _condensedApplicable && !(estimate.condensedTier && estimate.condensedTier[tier] === false);
  if (_condensedOn) {
    _pricingRenderCondensedTab(projId, el, estimate, tier);
    return;
  }

  var hidden = _pricingGetHiddenCols(projId);
  var sortState = _pricingSortState[projId] || { col: null, dir: null };
  var filterBldg = _pricingBldgFilter[projId] || '';
  // Phase 5 (d284e714): fetched once, up-front, so renderRow/renderMergedRow (called below,
  // before the later `var widths` used for header sizing) can clip label spans to the column's
  // CURRENT width (resized or default) instead of forcing the table wider than its declared
  // width — see _pricingClipSpanMaxW.
  var _colWidthsForClip = _pricingGetColWidths(projId);
  function _pricingClipSpanMaxW(ci) {
    var w = _colWidthsForClip[ci] || _colWidthsForClip[String(ci)] || PRICING_TBL_COLS[ci].minWidth;
    return Math.max(20, w - 16); // 16 = cell's own horizontal padding (5px 8px × 2 sides)
  }
  // 979fd1af: row sort control — Recommended tier only (the only tier with savings-weight
  // fields to score by). See _pricingGetRowSortMode for mode definitions.
  var _rowSortMode = tier === 'recommended' ? _pricingGetRowSortMode(projId) : 'default';

  // ── 2. Build base rows (Phase 3 row builder)
  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);

  // Issue 4 fix: auto-hide the Impact column when tier cannot produce impact badges.
  // savingsImpact is only stamped on Recommended/Both phase-2 rows; Compliance/Full Scope blank.
  // We clone the hidden array so we don't mutate the user's saved preferences.
  // Phase-4-fix (review-phase4.md #1): look up the Impact column by its isImpactCol flag
  // instead of a hardcoded index — Phase 4's Hours column insertion shifted Impact from 11 to
  // 12 and a literal `11` here was left stale, which hid Line Total (the new col 11) instead of
  // Impact on Compliance/Full Scope. Deriving the index from PRICING_TBL_COLS means the next
  // column insertion can't silently break this again.
  var _impactColIdx = -1;
  for (var _ci = 0; _ci < PRICING_TBL_COLS.length; _ci++) {
    if (PRICING_TBL_COLS[_ci].isImpactCol) {
      _impactColIdx = _ci;
      break;
    }
  }
  var _tierHasImpact = tier === 'recommended' || tier === 'both';
  if (!_tierHasImpact && _impactColIdx !== -1 && hidden.indexOf(_impactColIdx) === -1) {
    hidden = hidden.concat([_impactColIdx]);
  }

  // Phase 6 (5ff6c401): auto-hide the Building column (index 1) when a single building is
  // selected in the Building filter — every visible row shows the identical value once the
  // group-header divider rows are removed below, so the column is pure redundant width in that
  // state. Re-shown automatically when "All Buildings" is selected (still needed for scanning/
  // sorting since there's no group header to identify a building anymore). Derived from filter
  // state, not a saved user preference — mirrors the Impact-column auto-hide above, not written
  // to _pricingGetHiddenCols storage.
  if (filterBldg && hidden.indexOf(1) === -1) {
    hidden = hidden.concat([1]);
  }

  // Phase 8 (3ee6b754): seqKey → display-item-name map, built once per render from the same
  // global EM_SEQUENCE_DEFS source (and the same DCV suffix rule) buildBaseRows already uses to
  // label phase-2 rows — so a standalone $0 ioOnly row can say "Enables: <name>" below without
  // depending on that sequence's own row being present in the CURRENT tier/filter's row list
  // (render-time lookup only, no new stored field — see renderRow col 12).
  var _seqItemLabelByKey = {};
  if (typeof EM_SEQUENCE_DEFS !== 'undefined') {
    EM_SEQUENCE_DEFS.forEach(function (sd) {
      var _lbl = sd.label;
      if (sd.key === 'demandCtrl' || sd.key === 'vav_dcv') _lbl += ' (CO2/DCV Programming)';
      _seqItemLabelByKey[sd.key] = _lbl;
    });
  }

  var baseRows;
  if (tier === 'recommended') {
    baseRows = buildRecommendedRows(projId);
  } else if (tier === 'full-scope') {
    baseRows = buildFullScopeRows(projId);
  } else {
    baseRows = buildComplianceRows(projId);
  }
  var recRows = null;
  if (tier === 'both') {
    recRows = buildRecommendedRows(projId);
  }

  // ── 3. Apply labor + qty overrides (Phase 4 + Fix 6f26cbfd)
  baseRows = _pricingApplyLaborOverrides(projId, baseRows);
  if (recRows) recRows = _pricingApplyLaborOverrides(projId, recRows);
  baseRows = _pricingApplyQtyOverrides(projId, baseRows);
  if (recRows) recRows = _pricingApplyQtyOverrides(projId, recRows);

  // ── 4. Apply building filter
  var allBuildings = [];
  var bldgSet = {};
  baseRows.forEach(function (r) {
    if (r.building && !bldgSet[r.building]) {
      bldgSet[r.building] = true;
      allBuildings.push(r.building);
    }
  });

  var filteredRows = filterBldg
    ? baseRows.filter(function (r) {
        return r.building === filterBldg;
      })
    : baseRows;
  if (filterBldg && recRows) {
    recRows = recRows.filter(function (r) {
      return r.building === filterBldg;
    });
  }

  // Update cache with labor-override-applied, filtered rows
  _pricingRowCache[projId] = filteredRows;
  if (recRows) _pricingRowCache[projId + '_rec'] = recRows;

  var totals = _pricingComputeTotals(filteredRows, estimate);
  var recTotals = recRows ? _pricingComputeTotals(recRows, estimate) : null;

  var buildings = [];
  var bSet2 = {};
  filteredRows.forEach(function (r) {
    if (r.building && !bSet2[r.building]) {
      bSet2[r.building] = true;
      buildings.push(r.building);
    }
  });

  // 979fd1af "Best building return first": lifted verbatim from the removed Batch 2c logic in
  // buildRecommendedRows (see the 0ae36950 note there). Only reorders which building group
  // renders first — does not flatten rows across buildings (that's the 'equipment' mode below).
  if (tier === 'recommended' && _rowSortMode === 'building') {
    var _bldgRoiScores = _pricingComputeBldgRoiScores(filteredRows);
    buildings = buildings.slice().sort(function (a, b) {
      return (_bldgRoiScores[b] || 0) - (_bldgRoiScores[a] || 0);
    });
  }

  var isBothMode = tier === 'both';
  // Effective column count (both mode adds 1 extra col)
  var totalColCount = PRICING_TBL_COLS.length + (isBothMode ? 1 : 0);
  // Visible column count (accounting for hidden cols)
  // Note: Both-mode extra col not toggleable — always shown
  var visibleColSpan = totalColCount - hidden.length;

  // ── 5. Sort data rows (only within their phase group; group headers stay in place)
  //       Sort is applied at render time per phase group, building group intact.

  // ── 5b. Step 5: Annual energy data for $ savings range (Recommended tier only)
  var _annualElecData =
    tier === 'recommended' || tier === 'both'
      ? _pricingGetProjectAnnualElec(projId)
      : { annualKwh: null, hasBillData: false, elecRate: 0.1 };
  var _fanFraction = cfg.fanFraction !== undefined && cfg.fanFraction !== null ? cfg.fanFraction : FAN_FRACTION_DEFAULT;
  // Avg electricity rate ($/kWh) — derived from en_utility_<projId> bills in _pricingGetProjectAnnualElec
  var _elecRate = _annualElecData.elecRate || 0.1;

  // ── 6. Helpers
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 0ae36950: single-line $-savings-range chip, rendered in the Impact column (Recommended tier
  // phase-2 rows only). Replaces the old wrapping <div> that was appended below the Notes-cell
  // input — at narrow Notes-column widths that div's white-space:normal text wrapped into many
  // lines, driving individual rows up to 233px tall (b771dec6 column-width-invest root cause).
  // Full detail text now lives entirely in the title tooltip (ui-standards single-line + hover
  // convention), matching the existing _a36ImpactChip pattern it now sits next to. Shared by
  // renderRow and renderMergedRow (called with whichever row carries the seqKey — for a merged
  // row that's the sequence half, since only phase-2 rows have savings data).
  function _savingsRangeChipHTML(seqLikeRow) {
    if (
      !(
        (tier === 'recommended' || tier === 'both') &&
        seqLikeRow.seqKey &&
        seqLikeRow.savingsImpact &&
        seqLikeRow.savingsImpact !== 'enabler' &&
        seqLikeRow.savingsImpact !== 'safety'
      )
    ) {
      return '';
    }
    var _hasBills = _annualElecData.hasBillData;
    var _annKwh = _annualElecData.annualKwh;
    var _chipBase =
      'display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;' +
      'white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;margin-left:4px;';
    if (!_hasBills) {
      // No bill data — show literature % range if available, otherwise a plain-language note
      var _litRange = SAVINGS_RANGE_MAP[seqLikeRow.seqKey];
      if (_litRange) {
        var _basisLabel = _litRange.energyBasis === 'fan' ? 'fan energy' : 'site electricity';
        _anySavingsShown = true;
        return (
          '<span title="' +
          _esc(
            'Literature range: ' +
              Math.round(_litRange.lowPct * 100) +
              '–' +
              Math.round(_litRange.highPct * 100) +
              '% of ' +
              _basisLabel +
              ' \xb7 ' +
              _litRange.citation +
              ' — import utility bills for a dollar estimate',
          ) +
          '" style="' +
          _chipBase +
          'background:var(--s3);color:var(--text2)">Est. ' +
          Math.round(_litRange.lowPct * 100) +
          '–' +
          Math.round(_litRange.highPct * 100) +
          '%</span>'
        );
      }
      return (
        '<span title="Import utility bills to see an estimated dollar savings" style="' +
        _chipBase +
        'color:var(--text3);font-style:italic;font-weight:400">Needs bill data</span>'
      );
    }
    if (_annKwh && SAVINGS_RANGE_MAP[seqLikeRow.seqKey]) {
      var _range = _pricingComputeSavingsRange(seqLikeRow, _annKwh, _fanFraction, _elecRate);
      if (_range && _range.high > 0) {
        _anySavingsShown = true;
        return (
          '<span title="' +
          _esc('Literature range — M&V required \xb7 ' + _range.citation) +
          '" style="' +
          _chipBase +
          'background:rgba(134,239,172,0.12);color:#86efac">Est. ' +
          _pricingFmtSavingsRange(_range.low, _range.high) +
          '</span>'
        );
      }
      return '';
    }
    if (_annKwh) {
      return (
        '<span title="Site-specific calculation needed for a dollar estimate" style="' +
        _chipBase +
        'color:var(--text3);font-style:italic;font-weight:400">Needs site calc</span>'
      );
    }
    return '';
  }

  // d5286981: toolbar HTML assembly now delegates to the shared _pricingBuildToolbarHTML
  // (defined above initCostEstimateTab) so every Cost Estimate view — including the (removed)
  // Summary sub-tab — renders the toolbar's shared controls (Import CSV, Table Settings, Legend,
  // Tier toggle, Building filter, Sort) at the exact same screen position.
  // Previously this block built its own inline toolbarHTML array (Import CSV/status/Settings/
  // Legend, Tier toggle, spacer, Building filter, Recommended-only Sort) — that fixed left-side
  // content differed from Summary's much shorter title-span toolbar, shifting the Tier toggle's
  // position between views (ui-standards.md "Stable control placement rule", 2026-07-08 binding;
  // origin bug logged as d5286981). See _pricingBuildToolbarHTML's own header comment for the
  // 35742dd5 Phase-2 spacer-placement history this extraction preserves verbatim, and for why
  // hasCatalog/importStatus/filterBldg are re-derived INSIDE that function now rather than
  // passed in (only `allBuildings` remains tier-dependent enough to need passing).
  // 2026-07-22 (Task 1c): when the user has explicitly opted OUT of the condensed view for
  // Compliance/Full-Scope (est.condensedTier[tier] === false — the only way this full render
  // path runs for those two tiers at all), surface a "Show Condensed Summary" button here so
  // there's a way BACK to condensed without it, the user would be stuck on full itemization
  // forever once opted out, since condensedTier is a persisted per-project preference.
  var _condensedToggleBackHTML =
    (tier === 'compliance' || tier === 'full-scope') && estimate.condensedTier && estimate.condensedTier[tier] === false
      ? _pricingCondensedToggleHTML(projId, tier, false)
      : '';
  var toolbarHTML = _pricingBuildToolbarHTML(projId, tier, {
    allBuildings: allBuildings,
    middleHTML: _condensedToggleBackHTML,
  });

  // ── 8. Render row function (Phase 4: adds hours-override input for labor rows)
  var recRowIdxByBase = isBothMode ? _buildBothModeIndex(recRows || []) : {};

  function renderRow(row, isBothMd, matchedRecRow, hiddenCols) {
    var toggleKey = row._baseId || row.id;
    var toggleOn = estimate.rowToggles[toggleKey] !== false;
    var manualVal = estimate.manualPrices[toggleKey] || '';
    var laborOverrides = estimate.laborOverrides || {};
    var installOverrides = estimate.installHoursOverrides || {}; // Deliverable E

    // Build per-column cell content
    var cells = [];

    // col 0: Include
    cells.push(
      '<input type="checkbox"' +
        (toggleOn ? ' checked' : '') +
        (row.ioOnly ? ' title="Uses existing wiring — no new part needed"' : '') +
        ' onchange="_pricingToggleRow(\'' +
        projId +
        "','" +
        toggleKey +
        '\',this.checked)"' +
        ' style="cursor:pointer">',
    );

    // col 1: Building — Phase 5 (d284e714): clip overflow instead of forcing the table wider
    // than its declared column widths; title carries the untruncated value.
    // DEVIATION FROM PLAN TEXT (measured, see phase5 verify results-before/after.json): the
    // plan's literal instruction (only overflow:hidden;text-overflow:ellipsis;white-space:nowrap
    // on the span) does nothing on a plain inline element — browsers report clientWidth/
    // scrollWidth as 0 for non-block inline boxes, so no clipping occurs and the column still
    // grows to fit content (measured: Building TH/TD width unchanged at 430px vs its declared
    // 90px minWidth, before AND after the literal-only change, seeded long-building-name test).
    // Minimal correct variant: display:inline-block + an explicit max-width (tied to the
    // column's current width, resized or default) actually bounds the box so ellipsis clipping
    // takes effect — this is the same pattern already used elsewhere in this file for the
    // savings-range chip (~line 3868-3870, `display:inline-block;max-width:120px;overflow:hidden`).
    cells.push(
      '<span style="font-size:11px;display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(1) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(row.building) +
        '">' +
        _esc(row.building) +
        '</span>',
    );

    // col 2: Item — Phase 5: same clipping pattern
    cells.push(
      '<span style="font-size:11px;display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(2) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(row.item) +
        '">' +
        _esc(row.item) +
        '</span>',
    );

    // col 3: Type — Phase 5: same clipping pattern
    cells.push(
      '<span style="font-size:10px;color:var(--text2);display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(3) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(row.type) +
        '">' +
        _esc(row.type) +
        '</span>',
    );

    // col 4: Equipment — Phase 5: same clipping pattern
    cells.push(
      '<span style="font-size:10px;color:var(--text2);display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(4) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(row.equipment) +
        '">' +
        _esc(row.equipment) +
        '</span>',
    );

    // col 5: Qty — editable override (Fix: item 6f26cbfd)
    var _qtyOverrides = estimate.qtyOverrides || {};
    var _qtyKey = toggleKey;
    var _qtyIsOverridden = _qtyOverrides[_qtyKey] != null;
    var _qtyDisplay = row.qty != null ? row.qty : 0;
    cells.push(
      '<div style="display:flex;align-items:center;gap:3px;justify-content:flex-end">' +
        '<input type="number" min="1" step="1" value="' +
        _qtyDisplay +
        '"' +
        ' title="' +
        (_qtyIsOverridden
          ? 'Qty override (default: auto-derived from equipment counts)'
          : 'Qty (auto-derived; edit to override)') +
        '"' +
        (_qtyIsOverridden ? '' : ' class="ch-soft-input"') +
        ' style="width:44px;font-size:11px;padding:2px 4px;background:var(--s3);color:var(--text);border-radius:4px;text-align:right;font-variant-numeric:tabular-nums' +
        (_qtyIsOverridden ? ';border:1px solid var(--accent)' : '') +
        '"' +
        ' onchange="_pricingQtyOverride(\'' +
        projId +
        "','" +
        _qtyKey +
        '\',this.value)">' +
        (_qtyIsOverridden
          ? '<button onclick="_pricingQtyReset(\'' +
            projId +
            "','" +
            _qtyKey +
            '\')" title="Reset to auto-derived qty"' +
            ' style="font-size:9px;padding:1px 3px;background:var(--s4);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer;line-height:1.2">↺</button>'
          : '') +
        '</div>',
    );

    // col 6: SKU
    var skuContent = '';
    if (row.ioOnly) {
      skuContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (row.phase === 2) {
      skuContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (!row.sku) {
      skuContent = '<span style="color:var(--warn);font-size:10px">Manual Price</span>';
    } else {
      var optNote = row.optimized
        ? '<span title="Optimizer: was ' +
          _esc(row.optimizerOriginalSku || '') +
          '" style="color:var(--accent);margin-right:3px;font-size:10px">✓</span>'
        : '';
      skuContent =
        (row.engReview
          ? '<span title="Engineering review required" style="color:var(--warn);margin-right:3px;font-size:11px">⚠</span>'
          : '') +
        optNote +
        '<span style="font-family:monospace;font-size:10px">' +
        _esc(row.sku) +
        '</span>';
    }
    cells.push(skuContent);

    // col 7: List price
    var listContent = '';
    if (row.phase === 2) {
      listContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (row.ioOnly) {
      listContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (!hasCatalog || row.noSku) {
      listContent = '<span style="color:var(--text3)">—</span>';
    } else {
      listContent = row.listPrice != null ? _pricingFmt(row.listPrice) : '<span style="color:var(--text3)">—</span>';
    }
    cells.push(listContent);

    // col 8: Net price
    var netContent = '';
    if (row.phase === 2) {
      netContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (row.ioOnly) {
      netContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (!hasCatalog || row.noSku) {
      netContent = '<span style="color:var(--text3)">—</span>';
    } else {
      netContent = row.netPrice != null ? _pricingFmt(row.netPrice) : '<span style="color:var(--text3)">—</span>';
    }
    cells.push(netContent);

    // col 9: Contract (40%) — dollar-price branches only (Phase 4 923ca9b/75827077: labor-hour
    // input moved to its own Hours column below, so Contract never mixes parts price + hours).
    var contractContent = '';
    if (row.ioOnly) {
      contractContent = '<span style="color:var(--text3);font-size:10px">$0 (no part)</span>';
    } else if (row.noSku) {
      contractContent =
        '<input type="number" min="0" step="0.01" value="' +
        manualVal +
        '" placeholder="Enter price"' +
        ' style="width:100%;box-sizing:border-box;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid var(--warn);border-radius:4px;text-align:right"' +
        ' onchange="_pricingManualPrice(event,\'' +
        projId +
        "','" +
        row.id +
        '\')">';
    } else if (!hasCatalog) {
      // Issue 8 fix: priceable rows (phase-1, not ioOnly, not noSku) get a manual price input even
      // without a catalog loaded, so the user can enter a unit price and include the row in the estimate.
      if (row.phase === 1 && !row.ioOnly && !row.noSku) {
        var _noCatManualVal = estimate.manualPrices[toggleKey] || '';
        contractContent =
          '<input type="number" min="0" step="0.01" value="' +
          _noCatManualVal +
          '" placeholder="Enter price"' +
          ' title="No catalog loaded — enter unit price manually"' +
          ' style="width:100%;box-sizing:border-box;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid var(--warn);border-radius:4px;text-align:right"' +
          ' onchange="_pricingUnitPriceOverride(event,\'' +
          projId +
          "','" +
          toggleKey +
          '\')">';
      } else {
        contractContent = '<span style="color:var(--text3)">—</span>';
      }
    } else if (row.sku && catalog && !catalog[row.sku]) {
      // SKU not in catalog — allow manual price entry (reuses est.manualPrices, Fix: item 6f26cbfd)
      var _skuManualVal = estimate.manualPrices[toggleKey] || '';
      contractContent =
        '<input type="number" min="0" step="0.01" value="' +
        _skuManualVal +
        '" placeholder="Enter price"' +
        ' title="SKU not found in imported pricing — enter unit price manually"' +
        ' style="width:100%;box-sizing:border-box;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid var(--warn);border-radius:4px;text-align:right"' +
        ' onchange="_pricingUnitPriceOverride(event,\'' +
        projId +
        "','" +
        toggleKey +
        '\')">';
    } else {
      contractContent =
        row.contractPrice != null ? _pricingFmt(row.contractPrice) : '<span style="color:var(--text3)">—</span>';
    }
    cells.push(contractContent);

    // col 10: Hours — labor-hour override input, split out of Contract (Phase 4 923ca9b/75827077).
    // Moved, not rewritten: identical markup/onchange/override-detection/reset-button that used to
    // live in the Contract cell for row.phase===2 && row.seqKey rows.
    var hoursContent = '<span style="color:var(--text3)">—</span>';
    if (row.phase === 2 && row.seqKey) {
      var defaultHrs = COST_PER_SEQ_HOURS_DEFAULT[row.seqKey] != null ? COST_PER_SEQ_HOURS_DEFAULT[row.seqKey] : 2.0;
      var currentHrs = laborOverrides[row.seqKey] != null ? parseFloat(laborOverrides[row.seqKey]) : row.hrsPerUnit;
      var isOverridden = laborOverrides[row.seqKey] != null;
      hoursContent =
        '<div style="display:flex;align-items:center;gap:4px">' +
        '<input type="number" min="0" step="0.25" value="' +
        currentHrs +
        '"' +
        ' title="Hours per instance (default: ' +
        defaultHrs +
        ')"' +
        (isOverridden ? '' : ' class="ch-soft-input"') +
        ' style="width:52px;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border-radius:4px;text-align:right;font-variant-numeric:tabular-nums' +
        (isOverridden ? ';border:1px solid var(--accent)' : '') +
        '"' +
        ' onchange="_pricingSeqHrsChange(\'' +
        projId +
        "','" +
        row.seqKey +
        '\',this.value)">' +
        '<span style="font-size:10px;color:var(--text3)">hrs</span>' +
        (isOverridden
          ? '<button onclick="_pricingSeqHrsReset(\'' +
            projId +
            "','" +
            row.seqKey +
            '\')"' +
            ' title="Reset to default (' +
            defaultHrs +
            ' hrs)"' +
            ' style="font-size:9px;padding:1px 4px;background:var(--s4);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer;line-height:1.2">↺</button>'
          : '') +
        '</div>';
    } else if (row.phase === 1 && !row.ioOnly && row._pointKey) {
      // Deliverable E: install-hours override input for hardware rows — same markup/onchange/
      // override-detection/reset-button pattern as the phase-2 branch above, wired to
      // _pricingInstallHrsChange/_pricingInstallHrsReset (installHoursOverrides, keyed by
      // _pointKey — a device TYPE setting, same design as laborOverrides/seqKey).
      var defaultInstHrs =
        INSTALL_HOURS_BY_POINT_DEFAULT[row._pointKey] != null
          ? INSTALL_HOURS_BY_POINT_DEFAULT[row._pointKey]
          : INSTALL_HOURS_FALLBACK_DEFAULT;
      var currentInstHrs =
        installOverrides[row._pointKey] != null ? parseFloat(installOverrides[row._pointKey]) : row.installHours;
      var isInstOverridden = installOverrides[row._pointKey] != null;
      hoursContent =
        '<div style="display:flex;align-items:center;gap:4px">' +
        '<input type="number" min="0" step="0.25" value="' +
        currentInstHrs +
        '"' +
        ' title="Install hours per unit (default: ' +
        defaultInstHrs +
        ')"' +
        (isInstOverridden ? '' : ' class="ch-soft-input"') +
        ' style="width:52px;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border-radius:4px;text-align:right;font-variant-numeric:tabular-nums' +
        (isInstOverridden ? ';border:1px solid var(--accent)' : '') +
        '"' +
        ' onchange="_pricingInstallHrsChange(\'' +
        projId +
        "','" +
        row._pointKey +
        '\',this.value)">' +
        '<span style="font-size:10px;color:var(--text3)">hrs</span>' +
        (isInstOverridden
          ? '<button onclick="_pricingInstallHrsReset(\'' +
            projId +
            "','" +
            row._pointKey +
            '\')"' +
            ' title="Reset to default (' +
            defaultInstHrs +
            ' hrs)"' +
            ' style="font-size:9px;padding:1px 4px;background:var(--s4);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer;line-height:1.2">↺</button>'
          : '') +
        '</div>';
    }
    cells.push(hoursContent);

    // col 11: Rate — cc78ac9e ("Rate column never built"): display-only $/hr labor rate applied
    // to this row's Hours to produce Line Total. Read-only (no input — the rate itself is edited
    // in Table Settings/the toolbar Rate chip, both of which write en_pricing_config.hourlyRate;
    // this cell never writes anything, so it cannot drift from the value _pricingApplyLaborOverrides
    // already used to compute unitPrice/lineTotal upstream). Phase-2 labor rows AND Phase-1
    // hardware rows now show the SAME unified rate (2026-07-28) — both read-only for the same
    // reason. ioOnly rows show the same em-dash placeholder as non-priced rows.
    var rateContent = '<span style="color:var(--text3)">—</span>';
    if (row.phase === 2 && row.seqKey) {
      var _rowRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
      rateContent =
        '<span style="font-size:11px">' +
        _pricingFmt(_rowRate) +
        '<span style="font-size:10px;color:var(--text3)">/hr</span></span>';
    } else if (row.phase === 1 && !row.ioOnly && row._pointKey) {
      var _instRowRate = row.installLaborRate != null ? row.installLaborRate : cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
      rateContent =
        '<span style="font-size:11px">' +
        _pricingFmt(_instRowRate) +
        '<span style="font-size:10px;color:var(--text3)">/hr</span></span>';
    }
    cells.push(rateContent);

    // col 12: Line Total
    var lineTotalContent = '';
    if (row.ioOnly) {
      lineTotalContent = '<span style="color:var(--text3);font-size:10px">$0</span>';
    } else if (row.noSku) {
      var mv = parseFloat(estimate.manualPrices[toggleKey] || 0);
      // Deliverable E: fold install labor in once a real manual parts price has been entered —
      // mirrors _pricingComputeTotals's manual-price branch exactly so this cell can never disagree
      // with the totals footer/report.
      var lt = isNaN(mv) || mv <= 0 ? null : mv * row.qty + (row.installLaborTotal || 0);
      lineTotalContent =
        lt !== null && lt > 0 ? _pricingFmt(lt) : '<span style="color:var(--warn);font-size:10px">⚠ Enter price</span>';
    } else {
      lineTotalContent =
        row.lineTotal !== null
          ? '<span' + (!toggleOn ? ' style="color:var(--text3)"' : '') + '>' + _pricingFmt(row.lineTotal) + '</span>'
          : '<span style="color:var(--text3)">—</span>';
    }
    cells.push(lineTotalContent);

    // col 13: Impact — savings-tier badge (correction #4 / Phase 5) + (0ae36950) the $-savings-range
    // chip, moved here from the Notes column. Both are single-line inline-block spans so this cell
    // never grows the row taller than any other row's baseline height — see _savingsRangeChipHTML.
    var impactCellContent = '';
    if (tier === 'recommended' && row.phase === 2 && row.savingsImpact) {
      impactCellContent = _a36ImpactChip(row);
    }
    impactCellContent += _savingsRangeChipHTML(row);
    // Phase 8 (3ee6b754): a standalone $0 ioOnly row (renderRow only ever sees ioOnly rows that
    // were NOT claimed by _pricingPairHwSeq — claimed ones render via renderMergedRow instead,
    // which already shows the paired sequence's real Impact chip) never gets savingsImpact
    // stamped (only phase-2 seqKey rows do, buildRecommendedRows), so impactCellContent is always
    // '' here for it — it reads as "no impact" instead of "named prerequisite for a sequence".
    // Render-time-only lookup against the existing SEQUENCE_BLOCKING_SENSORS map (no new field
    // stamped on the row, can't drift from _pricingPairHwSeq's own pairing logic).
    if ((tier === 'recommended' || tier === 'both') && row.ioOnly && !impactCellContent) {
      var _enablesLabels = [];
      Object.keys(SEQUENCE_BLOCKING_SENSORS).forEach(function (_sk) {
        var _blocking = SEQUENCE_BLOCKING_SENSORS[_sk] || [];
        if (row._pointKey && _blocking.indexOf(row._pointKey) !== -1 && _seqItemLabelByKey[_sk]) {
          _enablesLabels.push(_seqItemLabelByKey[_sk]);
        }
      });
      if (_enablesLabels.length) {
        impactCellContent =
          '<span title="This point has no cost of its own — it unblocks the listed sequence(s)" ' +
          'style="font-size:9px;color:var(--text3);font-style:italic">Enables: ' +
          _esc(_enablesLabels.join(', ')) +
          '</span>';
      }
    }
    cells.push(impactCellContent);

    // col 14: Notes — visible text = note + G36 §. Truncate + hover everywhere (b771dec6 2d):
    // superseding the earlier "Fuller-preference" decision (full rationale always visible in-cell)
    // because it made Recommended phase-2 rows taller than every other row in the table —
    // Matt rejected that height-inconsistency tradeoff. The rationale/clientSummary sentence now
    // lives in the hover tooltip (_tooltipText12 below) instead of a second visible line.
    var _noteText12 = row.note || '';
    if (row.g36Section) _noteText12 += (_noteText12 ? ' \xb7 ' : '') + row.g36Section;

    var _tooltipText12 = '';
    if (row.whyNotHardware) {
      _tooltipText12 = row.whyNotHardware + (row.g36Section ? ' (' + row.g36Section + ')' : '');
    } else if (row.whyNeeded) {
      _tooltipText12 = row.whyNeeded + (row.g36Section ? ' (' + row.g36Section + ')' : '');
    }
    // b771dec6 2d: Recommended phase-2 clientSummary/savingsRationale (formerly a second visible
    // line in-cell) now prefixes the hover tooltip so no content is lost, just relocated.
    if (tier === 'recommended' && row.phase === 2 && (row.clientSummary || row.savingsRationale)) {
      var _rationalePrefix12 = row.clientSummary || row.savingsRationale;
      _tooltipText12 = _rationalePrefix12 + (_tooltipText12 ? ' \xb7 ' + _tooltipText12 : '');
    }
    var _titleAttr12 = _tooltipText12 ? ' title="' + _esc(_tooltipText12) + '"' : '';
    var _cursorStyle12 = _tooltipText12 ? 'cursor:help;' : '';

    // Editable note override (Fix: item 6f26cbfd) — persists to est.noteOverrides[rowId]
    // Input is the sole element in every row (no stacked span) so all rows stay one line tall
    // (b771dec6 2d: uniform truncate + hover pattern, replacing the old multi-line exception).
    var _noteOverrides = estimate.noteOverrides || {};
    var _noteOverrideVal = _noteOverrides[toggleKey] || '';
    // Combine row's static note text with override; static text shown as placeholder when no override
    var _notePlaceholder = _noteText12 || 'Add note…';
    // Build tooltip from static text + any G36/tooltip text (for plain rows)
    var _noteTitleAttr = _noteText12
      ? ' title="' + _esc(_noteText12) + (_tooltipText12 ? ' \xb7 ' + _esc(_tooltipText12) : '') + '"'
      : _titleAttr12;
    var _noteInputHTML =
      '<input type="text" value="' +
      _esc(_noteOverrideVal) +
      '" placeholder="' +
      _esc(_notePlaceholder) +
      '"' +
      _noteTitleAttr +
      ' style="width:100%;font-size:10px;padding:2px 4px;background:' +
      (_noteOverrideVal ? 'var(--s3)' : 'transparent') +
      ';color:var(--text);' +
      'border:1px solid ' +
      (_noteOverrideVal ? 'var(--accent)' : 'transparent') +
      ';border-radius:3px;box-sizing:border-box"' +
      ' onfocus="this.style.cssText+=\';background:var(--s3);border-color:var(--border)\'"' +
      " onblur=\"var v=this.value;this.style.background=v?'var(--s3)':'';this.style.borderColor=v?'var(--accent)':''\"" +
      ' onchange="_pricingNoteOverride(\'' +
      projId +
      "','" +
      toggleKey +
      '\',this.value)">';

    // Single-line branch always used (b771dec6 2d) — rationale/clientSummary text now lives in the
    // hover tooltip (_tooltipText12 above), not as a second visible line, so every row is one line
    // tall. (0ae36950: the $-savings-range chip that used to be appended here now renders in the
    // Impact column instead — see col 12 above — so this cell is never anything but the input.)
    cells.push(_noteInputHTML);

    // Build TR
    var rowStyle = !toggleOn ? 'opacity:0.45;' : '';
    if (row.ioOnly) rowStyle += 'background:var(--s1);';

    var tds = '';
    cells.forEach(function (cellContent, ci) {
      if (hiddenCols.indexOf(ci) !== -1) return; // skip hidden columns
      var col = PRICING_TBL_COLS[ci] || {};
      // col 14 (Notes) may contain wrapped rationale text — allow wrap; other cols nowrap
      var isNotesCol = ci === 14;
      var isImpactCol = ci === 13;
      var tdStyle = isNotesCol
        ? 'overflow:hidden;padding:5px 8px;border-right:1px solid var(--border2);border-bottom:1px solid var(--border2);vertical-align:top;'
        : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;border-right:1px solid var(--border2);border-bottom:1px solid var(--border2);';
      if (ci === 0) tdStyle += 'text-align:center;width:36px;border-right:1px solid var(--border2);';
      // col 10 (Hours) for Phase 2 sequence rows: smaller padding for the hrs input (Phase 4:
      // moved here from Contract, which no longer carries this branch since Hours is its own col)
      // MUST be before the generic numeric right-align block (which also matches ci===10)
      else if (ci === 10 && row.phase === 2 && row.seqKey) tdStyle += 'padding:3px 6px;';
      // cols 5 (Qty), 7 (List), 8 (Net), 9 (Contract), 10 (Hours), 11 (Rate), 12 (Line Total) are right-aligned numerics
      else if (ci === 5 || ci === 7 || ci === 8 || ci === 9 || ci === 10 || ci === 11 || ci === 12)
        tdStyle += 'text-align:right;font-variant-numeric:tabular-nums;';
      else if (isImpactCol) tdStyle += 'text-align:center;vertical-align:middle;';
      var cls = ci === 0 || ci === 1 ? ' class="ch-frozen"' : '';
      tds += '<td' + cls + ' style="' + tdStyle + '">' + cellContent + '</td>';
    });

    // Both-mode extra col (Recommended Line Total)
    if (isBothMd) {
      var recLt = matchedRecRow ? matchedRecRow.lineTotal : null;
      if (hiddenCols.indexOf(-1) === -1) {
        // extra col always visible
        tds +=
          '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:11px;padding:5px 8px;border-left:2px solid var(--border2);border-bottom:1px solid var(--border);color:var(--accent)">' +
          (recLt !== null ? _pricingFmt(recLt) : '<span style="color:var(--text3)">—</span>') +
          '</td>';
      }
    }

    var trClass = row.ioOnly ? ' class="ch-tbl-row-io"' : '';
    return '<tr' + trClass + ' style="' + rowStyle + '">' + tds + '</tr>';
  }

  // b771dec6 Batch 5 (Finding 7): renderMergedRow — combines a phase-1 hardware (sensor) row
  // with its paired phase-2 sequence row into one visible <tr>. Presentation-only: does NOT
  // read/write anything the five build/compute functions produced beyond what renderRow already
  // reads; lineTotal is recomputed fresh here (hw.lineTotal + seq.lineTotal), never written back
  // to either row object, so buildComplianceRows/buildRecommendedRows/buildFullScopeRows/
  // _pricingComputeTotals/collectPricingEstimate remain byte-identical to their pre-Batch-5
  // output (verified by ce-totals-check, which fingerprints those functions' output, not the
  // DOM). Deliberately duplicates a small amount of column-rendering logic from renderRow above
  // instead of modifying it, per the plan's explicit scope ("Only the table-body HTML-assembly
  // loop... changes"; the five build functions AND renderRow itself were left untouched).
  function renderMergedRow(hwRow, seqRow, isBothMd, matchedRecRow, hiddenCols) {
    var hwToggleKey = hwRow._baseId || hwRow.id;
    var seqToggleKey = seqRow._baseId || seqRow.id;
    var hwOn = estimate.rowToggles[hwToggleKey] !== false;
    var seqOn = estimate.rowToggles[seqToggleKey] !== false;
    // b771dec6 5c: two toggles become one — the combined checkbox reads "on" only when BOTH
    // underlying rows are on; clicking it forces both to the same new value (see
    // _pricingToggleCombinedRow). Deliberate UX change, recorded in dashboardlogic.md.
    var combinedOn = hwOn && seqOn;
    var laborOverrides = estimate.laborOverrides || {};

    var cells = [];

    // col 0: single combined Include checkbox
    cells.push(
      '<input type="checkbox"' +
        (combinedOn ? ' checked' : '') +
        ' title="Sensor + blocking sequence — one control for both"' +
        ' onchange="_pricingToggleCombinedRow(\'' +
        projId +
        "','" +
        hwToggleKey +
        "','" +
        seqToggleKey +
        '\',this.checked)"' +
        ' style="cursor:pointer">',
    );

    // col 1: Building — Phase 5 (d284e714): clip overflow instead of forcing the table wider
    // than its declared column widths; title carries the untruncated value. Same measured
    // deviation as renderRow's col 1 above (display:inline-block + explicit max-width required —
    // plain overflow:hidden on an inline <span> is a no-op).
    cells.push(
      '<span style="font-size:11px;display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(1) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(hwRow.building) +
        '">' +
        _esc(hwRow.building) +
        '</span>',
    );

    // col 2: Item — concatenated (5c: implementer's call = inline, keeps row height uniform
    // with every other row per the Batch 2d one-line convention; full text in title for the
    // case it truncates at narrow viewports). Phase 5: added overflow clipping to the span.
    var _combinedItemFull = hwRow.item + ' + ' + seqRow.item;
    cells.push(
      '<span style="font-size:11px;display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(2) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(_combinedItemFull) +
        '">' +
        _esc(hwRow.item) +
        ' <span style="color:var(--text3)">+</span> ' +
        _esc(seqRow.item) +
        '</span>',
    );

    // col 3: Type — Phase 5: same clipping pattern
    var _combinedTypeFull = hwRow.type + ' + Sequence';
    cells.push(
      '<span style="font-size:10px;color:var(--text2);display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(3) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(_combinedTypeFull) +
        '">' +
        _esc(_combinedTypeFull) +
        '</span>',
    );

    // col 4: Equipment — Phase 5: same clipping pattern
    var _combinedEquipFull = hwRow.equipment + ' \xb7 ' + seqRow.equipment;
    cells.push(
      '<span style="font-size:10px;color:var(--text2);display:inline-block;vertical-align:middle;max-width:' +
        _pricingClipSpanMaxW(4) +
        'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
        _esc(_combinedEquipFull) +
        '">' +
        _esc(_combinedEquipFull) +
        '</span>',
    );

    // col 5: Qty — Phase 9 (13b52e14): two independently-editable inputs, one per underlying
    // qtyOverride key (hw's and seq's), same control/handler/storage as renderRow's standalone
    // Qty input above — never collapsed to one input even when the two values match, so the
    // display doesn't reintroduce the original ambiguity the next time they diverge.
    var _qtyOverridesM = estimate.qtyOverrides || {};
    var _hwQtyKey = hwToggleKey;
    var _seqQtyKey = seqToggleKey;
    var _hwQtyOverridden = _qtyOverridesM[_hwQtyKey] != null;
    var _seqQtyOverridden = _qtyOverridesM[_seqQtyKey] != null;
    function _mergedQtyInput(qty, key, isOverridden, label) {
      return (
        '<input type="number" min="1" step="1" value="' +
        qty +
        '"' +
        ' title="' +
        label +
        ' qty ' +
        (isOverridden
          ? '(overridden; default: auto-derived from equipment counts)'
          : '(auto-derived; edit to override)') +
        '"' +
        (isOverridden ? '' : ' class="ch-soft-input"') +
        ' style="width:32px;font-size:10px;padding:1px 2px;background:var(--s3);color:var(--text);border-radius:4px;text-align:right;font-variant-numeric:tabular-nums' +
        (isOverridden ? ';border:1px solid var(--accent)' : '') +
        '"' +
        ' onchange="_pricingQtyOverride(\'' +
        projId +
        "','" +
        key +
        '\',this.value)">' +
        (isOverridden
          ? '<button onclick="_pricingQtyReset(\'' +
            projId +
            "','" +
            key +
            '\')" title="Reset ' +
            label +
            ' qty to auto-derived"' +
            ' style="font-size:8px;padding:0 2px;background:var(--s4);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer;line-height:1.3">↺</button>'
          : '')
      );
    }
    cells.push(
      '<div style="display:flex;align-items:center;gap:2px;justify-content:flex-end" title="Sensor qty ' +
        hwRow.qty +
        ' / Sequence qty ' +
        seqRow.qty +
        '">' +
        _mergedQtyInput(hwRow.qty != null ? hwRow.qty : 0, _hwQtyKey, _hwQtyOverridden, 'Sensor') +
        '<span style="color:var(--text3);font-size:10px">/</span>' +
        _mergedQtyInput(seqRow.qty != null ? seqRow.qty : 0, _seqQtyKey, _seqQtyOverridden, 'Sequence') +
        '</div>',
    );

    // col 6: SKU — from the hardware row (sequence rows never have a SKU)
    var _skuContent = '';
    if (hwRow.ioOnly) {
      _skuContent = '<span style="color:var(--text3);font-size:10px">—</span>';
    } else if (!hwRow.sku) {
      _skuContent = '<span style="color:var(--warn);font-size:10px">Manual Price</span>';
    } else {
      var _optNote = hwRow.optimized
        ? '<span title="Optimizer: was ' +
          _esc(hwRow.optimizerOriginalSku || '') +
          '" style="color:var(--accent);margin-right:3px;font-size:10px">✓</span>'
        : '';
      _skuContent =
        (hwRow.engReview
          ? '<span title="Engineering review required" style="color:var(--warn);margin-right:3px;font-size:11px">⚠</span>'
          : '') +
        _optNote +
        '<span style="font-family:monospace;font-size:10px">' +
        _esc(hwRow.sku) +
        '</span>';
    }
    cells.push(_skuContent);

    // col 7: List — from the hardware row
    var _listContent =
      hwRow.ioOnly || !hasCatalog || hwRow.noSku
        ? '<span style="color:var(--text3);font-size:10px">—</span>'
        : hwRow.listPrice != null
          ? _pricingFmt(hwRow.listPrice)
          : '<span style="color:var(--text3)">—</span>';
    cells.push(_listContent);

    // col 8: Net — from the hardware row
    var _netContent =
      hwRow.ioOnly || !hasCatalog || hwRow.noSku
        ? '<span style="color:var(--text3);font-size:10px">—</span>'
        : hwRow.netPrice != null
          ? _pricingFmt(hwRow.netPrice)
          : '<span style="color:var(--text3)">—</span>';
    cells.push(_netContent);

    // col 9: Contract — hw's per-unit contract price, own cell (Phase 4 923ca9b/75827077: split
    // from the sequence's hours input, which now lives in its own Hours column below — no more
    // "+" glue text needed since price and hours are independent cells).
    var _hwContractText = hwRow.ioOnly
      ? '$0 (no part)'
      : hwRow.contractPrice != null
        ? _pricingFmt(hwRow.contractPrice)
        : '—';
    cells.push(_hwContractText);

    // col 10: Hours — sequence's editable hours-override input (same control/onchange as
    // renderRow's phase-2 branch — labor-hour editing is preserved unchanged on the merged row),
    // now its own cell instead of glued to Contract with a "+".
    var _defaultHrs =
      COST_PER_SEQ_HOURS_DEFAULT[seqRow.seqKey] != null ? COST_PER_SEQ_HOURS_DEFAULT[seqRow.seqKey] : 2.0;
    var _currentHrs =
      laborOverrides[seqRow.seqKey] != null ? parseFloat(laborOverrides[seqRow.seqKey]) : seqRow.hrsPerUnit;
    var _hrsOverridden = laborOverrides[seqRow.seqKey] != null;
    var _hoursContent =
      '<div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;white-space:nowrap">' +
      '<input type="number" min="0" step="0.25" value="' +
      _currentHrs +
      '"' +
      ' title="Hours per instance (default: ' +
      _defaultHrs +
      ')"' +
      (_hrsOverridden ? '' : ' class="ch-soft-input"') +
      ' style="width:44px;font-size:10px;padding:1px 3px;background:var(--s3);color:var(--text);border-radius:3px;text-align:right;font-variant-numeric:tabular-nums' +
      (_hrsOverridden ? ';border:1px solid var(--accent)' : '') +
      '"' +
      ' onchange="_pricingSeqHrsChange(\'' +
      projId +
      "','" +
      seqRow.seqKey +
      '\',this.value)">' +
      '<span style="font-size:9px;color:var(--text3)">hrs</span>' +
      (_hrsOverridden
        ? '<button onclick="_pricingSeqHrsReset(\'' +
          projId +
          "','" +
          seqRow.seqKey +
          '\')"' +
          ' title="Reset to default (' +
          _defaultHrs +
          ' hrs)"' +
          ' style="font-size:9px;padding:1px 3px;background:var(--s4);color:var(--text2);border:1px solid var(--border);border-radius:3px;cursor:pointer;line-height:1.2">↺</button>'
        : '') +
      '</div>';
    cells.push(_hoursContent);

    // col 11: Rate — cc78ac9e ("Rate column never built"): same read-only $/hr display as
    // renderRow's col 11, sourced from the sequence half of the pair (the merged row's Hours
    // cell edits seqRow.seqKey's hours, so the rate that applies to it is the same one).
    var _rateContent = '<span style="color:var(--text3)">—</span>';
    if (seqRow.phase === 2 && seqRow.seqKey) {
      var _mergedRowRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
      _rateContent =
        '<span style="font-size:10px">' +
        _pricingFmt(_mergedRowRate) +
        '<span style="font-size:9px;color:var(--text3)">/hr</span></span>';
    }
    cells.push(_rateContent);

    // col 12: Line Total — hw.lineTotal + seq.lineTotal, computed fresh here every render
    // (5c: "never written back") — the underlying row objects and their lineTotal fields are
    // never mutated, so toggling this row on/off moves the grand total by exactly this combined
    // amount and back (footer total comes from _pricingComputeTotals summing the SAME unmerged
    // per-row lineTotal fields keyed by rowToggles, untouched by this function).
    var _combinedLineTotal = (hwRow.lineTotal || 0) + (seqRow.lineTotal || 0);
    var _lineTotalContent =
      '<span' + (!combinedOn ? ' style="color:var(--text3)"' : '') + '>' + _pricingFmt(_combinedLineTotal) + '</span>';
    cells.push(_lineTotalContent);

    // col 13: Impact — same rule as renderRow (Recommended tier phase-2 only), sourced from the
    // sequence half of the pair. (0ae36950: $-savings-range chip also moved here from Notes,
    // same as renderRow — see _savingsRangeChipHTML.)
    var _impactCellContent = '';
    if (tier === 'recommended' && seqRow.savingsImpact) {
      _impactCellContent = _a36ImpactChip(seqRow);
    }
    _impactCellContent += _savingsRangeChipHTML(seqRow);
    cells.push(_impactCellContent);

    // col 14: Notes — combined tooltip (5d): sensor whyNeeded + sequence clientSummary, no info
    // lost. clientSummary/savingsRationale are read from the module-level SEQUENCE_SAVINGS_IMPACT
    // constant directly (not only from seqRow's own stamped fields, which buildRecommendedRows
    // only sets for the Recommended tier) so the combined tooltip carries the sequence's benefit
    // sentence on EVERY tier, not just Recommended.
    var _seqImpactDef = SEQUENCE_SAVINGS_IMPACT[seqRow.seqKey];
    var _seqSummaryText =
      seqRow.clientSummary ||
      seqRow.savingsRationale ||
      (_seqImpactDef && (_seqImpactDef.clientSummary || _seqImpactDef.savingsRationale)) ||
      '';
    var _hwWhy = hwRow.whyNeeded || '';
    var _combinedTooltipParts = [];
    if (_hwWhy) _combinedTooltipParts.push(_hwWhy + (hwRow.g36Section ? ' (' + hwRow.g36Section + ')' : ''));
    if (_seqSummaryText) _combinedTooltipParts.push(_seqSummaryText);
    var _combinedTooltip = _combinedTooltipParts.join(' \xb7 ');

    var _noteText12 = hwRow.note || '';
    if (hwRow.g36Section) _noteText12 += (_noteText12 ? ' \xb7 ' : '') + hwRow.g36Section;
    var _notePlaceholder = _noteText12 || 'Add note…';
    var _noteOverrides = estimate.noteOverrides || {};
    // Combined row shares ONE note-input, keyed by the hw row's toggle key by default (stable —
    // matches the "one control" pattern already used for the checkbox). 2b8edc03: that default
    // used to HIDE a pre-existing override stored under the sequence's key while merged (not
    // lost — just invisible/uneditable until unmerged). Fall back to the sequence's key only
    // when the hw key has no override of its own, so a sequence-side note is visible and
    // editable while merged too; edits keep writing to whichever key already had content, so
    // unmerging still shows the same value on the same row it always lived on.
    var _noteKey = _noteOverrides[hwToggleKey]
      ? hwToggleKey
      : _noteOverrides[seqToggleKey]
        ? seqToggleKey
        : hwToggleKey;
    var _noteOverrideVal = _noteOverrides[_noteKey] || '';
    var _noteTitleAttr = _combinedTooltip
      ? ' title="' + _esc(_noteText12 ? _noteText12 + ' \xb7 ' + _combinedTooltip : _combinedTooltip) + '"'
      : _noteText12
        ? ' title="' + _esc(_noteText12) + '"'
        : '';
    var _noteInputHTML =
      '<input type="text" value="' +
      _esc(_noteOverrideVal) +
      '" placeholder="' +
      _esc(_notePlaceholder) +
      '"' +
      _noteTitleAttr +
      ' style="width:100%;font-size:10px;padding:2px 4px;background:' +
      (_noteOverrideVal ? 'var(--s3)' : 'transparent') +
      ';color:var(--text);' +
      'border:1px solid ' +
      (_noteOverrideVal ? 'var(--accent)' : 'transparent') +
      ';border-radius:3px;box-sizing:border-box"' +
      ' onfocus="this.style.cssText+=\';background:var(--s3);border-color:var(--border)\'"' +
      " onblur=\"var v=this.value;this.style.background=v?'var(--s3)':'';this.style.borderColor=v?'var(--accent)':''\"" +
      ' onchange="_pricingNoteOverride(\'' +
      projId +
      "','" +
      _noteKey +
      '\',this.value)">';
    cells.push(_noteInputHTML);

    // Build TR — same column layout/CSS as renderRow
    var rowStyle = !combinedOn ? 'opacity:0.45;' : '';
    var tds = '';
    cells.forEach(function (cellContent, ci) {
      if (hiddenCols.indexOf(ci) !== -1) return;
      var isNotesCol = ci === 14;
      var isImpactCol = ci === 13;
      var tdStyle = isNotesCol
        ? 'overflow:hidden;padding:5px 8px;border-right:1px solid var(--border2);border-bottom:1px solid var(--border2);vertical-align:top;'
        : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;border-right:1px solid var(--border2);border-bottom:1px solid var(--border2);';
      if (ci === 0) tdStyle += 'text-align:center;width:36px;border-right:1px solid var(--border2);';
      else if (ci === 5 || ci === 7 || ci === 8 || ci === 9 || ci === 10 || ci === 11 || ci === 12)
        tdStyle += 'text-align:right;font-variant-numeric:tabular-nums;';
      else if (isImpactCol) tdStyle += 'text-align:center;vertical-align:middle;';
      var cls = ci === 0 || ci === 1 ? ' class="ch-frozen"' : '';
      tds += '<td' + cls + ' style="' + tdStyle + '">' + cellContent + '</td>';
    });

    if (isBothMd) {
      var recLt = matchedRecRow ? matchedRecRow.lineTotal : null;
      if (hiddenCols.indexOf(-1) === -1) {
        tds +=
          '<td style="text-align:right;font-variant-numeric:tabular-nums;font-size:11px;padding:5px 8px;border-left:2px solid var(--border2);border-bottom:1px solid var(--border);color:var(--accent)">' +
          (recLt !== null ? _pricingFmt(recLt) : '<span style="color:var(--text3)">—</span>') +
          '</td>';
      }
    }

    return (
      '<tr class="ch-tbl-row-merged" data-merged-hw="' +
      _esc(hwRow.id) +
      '" data-merged-seq="' +
      _esc(seqRow.id) +
      '" style="' +
      rowStyle +
      '">' +
      tds +
      '</tr>'
    );
  }

  // ── 9. Build table body HTML
  // _anySavingsShown is set true by renderRow when a $ or % savings range is rendered.
  // Used to gate the M&V disclaimer — only shown when there IS something to disclaim.
  var _anySavingsShown = false;
  var tableBodyHTML = '';
  if (filteredRows.length === 0) {
    tableBodyHTML =
      '<tr><td colspan="' +
      visibleColSpan +
      '" style="text-align:center;padding:40px;color:var(--text3);font-size:13px">No compliance gaps found. Run the Equipment Matrix audit first.</td></tr>';
  } else if (tier === 'recommended' && _rowSortMode === 'equipment') {
    // 979fd1af "Best equipment return first": flat ranked list across ALL buildings by
    // savings-per-cost (same ratio as the 'building' mode / the removed Batch 2c default) —
    // no per-building grouping or subtotal header rows in this mode (subtotals only make sense
    // grouped; Building stays a visible column on every row, same as always). Standalone
    // hardware-only rows (no blocking sequence) sink to the bottom — see _pricingEquipRowScore.
    var _flatItems = [];
    buildings.forEach(function (bName) {
      var bRows = filteredRows.filter(function (r) {
        return r.building === bName;
      });
      var hw = bRows.filter(function (r) {
        return r.phase === 1;
      });
      var lb = bRows.filter(function (r) {
        return r.phase === 2;
      });
      if (sortState.col != null && sortState.dir) {
        hw = _pricingSortRows(hw, sortState.col, sortState.dir);
        lb = _pricingSortRows(lb, sortState.col, sortState.dir);
      }
      var _pairs = _pricingPairHwSeq(hw, lb);
      var claimedSeqIds = _pairs.claimedSeqIds;
      var pairedSeqByHwId = _pairs.pairedSeqByHwId;

      hw.forEach(function (row) {
        var matchedRec = null;
        if (isBothMode) {
          var base = row.id.replace(/^hw_/, '').replace(/_\d+$/, '');
          matchedRec = recRowIdxByBase[base] || null;
        }
        var pairedSeq = pairedSeqByHwId[row.id];
        if (pairedSeq) {
          _flatItems.push({
            score: _pricingEquipRowScore(pairedSeq),
            hwGroup: pairedSeq._hwGroup, // 2026-07-28 (fix/roi-no-hardware-first-per-unit)
            html: renderMergedRow(row, pairedSeq, isBothMode, matchedRec, hidden),
          });
        } else {
          // A standalone (unpaired) hardware row IS the hardware install — always the 'gap'
          // side regardless of _hwGroup (which this row type never carries; see the fallback
          // below), same as the merged/lb cases.
          _flatItems.push({
            score: _pricingEquipRowScore(row),
            hwGroup: 'gap',
            html: renderRow(row, isBothMode, matchedRec, hidden),
          });
        }
      });
      lb.forEach(function (row) {
        if (claimedSeqIds[row.id]) return; // already rendered combined with its paired hw row
        _flatItems.push({
          score: _pricingEquipRowScore(row),
          hwGroup: row._hwGroup,
          html: renderRow(row, isBothMode, null, hidden),
        });
      });
    });
    // 2026-07-28 (fix/roi-no-hardware-first-per-unit) — same primary/secondary discipline as
    // _pricingSortRecommendedRows/_pricingSortUnitsNoHwFirst: no-hardware-required rows first
    // (hwGroup 'ready'), ROI score as the secondary/tie-break within each group. Missing hwGroup
    // (standalone hw rows, defensive fallback) treated as needing hardware, never as the easy case.
    _flatItems.sort(function (a, b) {
      var aHw = a.hwGroup === 'ready' ? 0 : 1;
      var bHw = b.hwGroup === 'ready' ? 0 : 1;
      if (aHw !== bHw) return aHw - bHw;
      return b.score - a.score;
    });
    tableBodyHTML = _flatItems
      .map(function (it) {
        return it.html;
      })
      .join('');
  } else {
    buildings.forEach(function (bName) {
      var bRows = filteredRows.filter(function (r) {
        return r.building === bName;
      });
      var hw = bRows.filter(function (r) {
        return r.phase === 1;
      });
      var lb = bRows.filter(function (r) {
        return r.phase === 2;
      });

      // Sort within each phase group
      if (sortState.col != null && sortState.dir) {
        hw = _pricingSortRows(hw, sortState.col, sortState.dir);
        lb = _pricingSortRows(lb, sortState.col, sortState.dir);
      }

      // Phase 6 (5ff6c401, cost-estimate-ux-2026-07-06): the building group-header <tr>
      // (building name + subtotal, "— $X est.") that used to render here is REMOVED — the data
      // table now renders buildings' rows back-to-back with no divider row. Building totals then
      // moved to a "Summary" sub-tab (_pricingRenderSummaryTab), which was ITSELF removed
      // 2026-07-22 per Matt's explicit request ("gives no information") — there is no per-building
      // dollar breakdown anywhere in this tool anymore by design; only the condensed-view's
      // per-item "Buildings" COUNT column (_pricingComputeCondensedRows) shows building context.
      // The bHw1/bLab2/bTotal/recBTotal calc that used to feed this <tr> is not needed here
      // (nothing else in this scope reads those vars — verified by grep before removal).
      //
      // b771dec6 5a/5b (Finding 7): Phase divider rows removed — hardware sensors and their
      // blocking sequences now render as merged same-row lines where paired, in a single
      // building group (no more "Phase 1 — Hardware" / "Phase 2 — Programming Labor" dividers).
      // Each phase-1 hw row is claimed by AT MOST one phase-2 seq row (first match wins,
      // in current sort order); sequences with no blocking sensors, or whose blocking sensors
      // are absent/already claimed, render standalone exactly as before.
      // 0ae36950: factored into _pricingPairHwSeq so the 'equipment' flat-sort mode below
      // shares this exact pairing logic instead of a second drifting copy.
      var _pairs = _pricingPairHwSeq(hw, lb);
      var claimedSeqIds = _pairs.claimedSeqIds;
      var pairedSeqByHwId = _pairs.pairedSeqByHwId;

      if (hw.length > 0) {
        hw.forEach(function (row) {
          var matchedRec = null;
          if (isBothMode) {
            var base = row.id.replace(/^hw_/, '').replace(/_\d+$/, '');
            matchedRec = recRowIdxByBase[base] || null;
          }
          var pairedSeq = pairedSeqByHwId[row.id];
          if (pairedSeq) {
            tableBodyHTML += renderMergedRow(row, pairedSeq, isBothMode, matchedRec, hidden);
          } else {
            tableBodyHTML += renderRow(row, isBothMode, matchedRec, hidden);
          }
        });
      }

      if (lb.length > 0) {
        lb.forEach(function (row) {
          if (claimedSeqIds[row.id]) return; // already rendered combined with its paired hw row
          tableBodyHTML += renderRow(row, isBothMode, null, hidden);
        });
      }
    });
  }

  // ── 10. Footer
  // Phase 3 (32521b08, cost-estimate-ux-2026-07-06): Tier: label moved to the FRONT of the
  // footer row (was last, easy to miss per the investigation) so it's the first thing read in
  // every tier, before the Phase1/Phase2/Total figures — same field-order rule applies to both
  // the isBothMode (Compare) and else (single-tier) branches below since this sits before the
  // branch split.
  var recTierLabel = tier === 'recommended' ? 'Recommended' : 'Compliance';
  // 45ceb14f: extracted to _pricingTierLabelHTML (byte-identical output) so
  // _pricingRefreshFooter's partial-refresh path can render the same Tier label without a
  // second copy of this ternary. recTierLabel above is pre-existing/unused — left as-is,
  // out of scope for this fix.
  var _tierLabelHTML = _pricingTierLabelHTML(tier);
  var footerParts = [
    '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
    _tierLabelHTML,
    '<span style="color:var(--border2)">|</span>',
  ];

  if (isBothMode && recTotals) {
    var _hwPending = '<span style="color:var(--text3);font-size:11px;font-weight:400">CSV needed</span>';
    footerParts.push(
      '<span style="font-size:11px;font-weight:700;color:var(--text2)">Compliance — Hardware: </span>',
      '<span style="font-size:12px;font-weight:700;font-variant-numeric:tabular-nums">' +
        (totals.noCatalog ? _hwPending : totals.grand !== null ? _pricingFmt(totals.phase1) : '—') +
        '</span>',
      '<span style="font-size:11px;font-weight:700;color:var(--text2)">Programming: </span>',
      '<span style="font-size:12px;font-weight:700;font-variant-numeric:tabular-nums">' +
        (totals.grand !== null ? _pricingFmt(totals.phase2) : '—') +
        '</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">Total: ' +
        (totals.grand !== null
          ? totals.noCatalog
            ? 'Labor: ' + _pricingFmt(totals.grand)
            : _pricingFmt(totals.grand)
          : '—') +
        '</span>',
      '<span style="color:var(--border2)">|</span>',
      '<span style="font-size:11px;font-weight:700;color:var(--text2)">Recommended — Hardware: </span>',
      '<span style="font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent)">' +
        (recTotals.noCatalog ? _hwPending : recTotals.grand !== null ? _pricingFmt(recTotals.phase1) : '—') +
        '</span>',
      '<span style="font-size:11px;font-weight:700;color:var(--text2)">Programming: </span>',
      '<span style="font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent)">' +
        (recTotals.grand !== null ? _pricingFmt(recTotals.phase2) : '—') +
        '</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums">Total: ' +
        (recTotals.grand !== null
          ? recTotals.noCatalog
            ? 'Labor: ' + _pricingFmt(recTotals.grand)
            : _pricingFmt(recTotals.grand)
          : '—') +
        '</span>',
    );
  } else {
    footerParts.push(
      '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 1 Hardware:</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
        (totals.noCatalog
          ? '<span style="color:var(--text3);font-size:11px;font-weight:400">Import pricing CSV</span>'
          : totals.grand !== null
            ? _pricingFmt(totals.phase1)
            : '—') +
        '</span>',
      '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 2 Programming:</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
        (totals.grand !== null ? _pricingFmt(totals.phase2) : '—') +
        '</span>',
      '<span style="color:var(--border2)">|</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">Grand Total: ' +
        (totals.grand !== null
          ? totals.noCatalog
            ? 'Labor: ' + _pricingFmt(totals.grand)
            : _pricingFmt(totals.grand)
          : '—') +
        '</span>',
    );
  }

  if (filterBldg) {
    footerParts.push(
      '<span style="font-size:11px;color:var(--accent);font-weight:600">Filter: ' + _esc(filterBldg) + '</span>',
    );
  }

  var _p4CaveatParts = [];
  if (totals.noCatalog) _p4CaveatParts.push('Hardware pending — import pricing CSV to see full estimate');
  if (totals.pendingPriceCount > 0) _p4CaveatParts.push(totals.pendingPriceCount + ' item(s) pending price (excluded)');
  if (totals.engReviewCount > 0) _p4CaveatParts.push(totals.engReviewCount + ' eng-review');
  _p4CaveatParts.push('Basis: ' + (cfg.priceBasis || 'contract'));

  footerParts.push(
    '<span style="flex:1"></span>',
    '<span style="font-size:11px;color:var(--text3)">' + totals.included + ' of ' + totals.total + ' items</span>',
    '<span style="font-size:11px;color:var(--text3)">' + _p4CaveatParts.join(' · ') + '</span>',
  );
  // (Tier: label now rendered at the front of footerParts, see Phase 3 comment above.)

  // Step 5: Portfolio savings rollup (Recommended tier, when bill data available)
  if ((tier === 'recommended' || tier === 'both') && _annualElecData.hasBillData && _annualElecData.annualKwh) {
    // Collect unique seqKeys with a range (de-dup: one per seqKey across buildings)
    var _portfolioRows = tier === 'recommended' ? filteredRows : recRows || [];
    var _seenSeqKeys = {};
    var _portfolioLow = 0,
      _portfolioHigh = 0,
      _portfolioCount = 0;
    _portfolioRows.forEach(function (r) {
      if (r.phase !== 2 || !r.seqKey || _seenSeqKeys[r.seqKey]) return;
      if (!r.savingsImpact || r.savingsImpact === 'enabler' || r.savingsImpact === 'safety') return;
      var _pr = _pricingComputeSavingsRange(r, _annualElecData.annualKwh, _fanFraction, _elecRate);
      if (_pr && _pr.high > 0) {
        _seenSeqKeys[r.seqKey] = true;
        _portfolioLow += _pr.low;
        _portfolioHigh += _pr.high;
        _portfolioCount++;
      }
    });
    if (_portfolioCount > 0) {
      _anySavingsShown = true;
      footerParts.push(
        '<div style="width:100%;margin-top:6px;padding:6px 10px;background:rgba(134,239,172,0.06);' +
          'border:1px solid rgba(134,239,172,0.2);border-radius:4px">' +
          '<span style="font-size:11px;font-weight:700;color:#86efac">Portfolio Est. Annual Savings: ' +
          _pricingFmtSavingsRange(_portfolioLow, _portfolioHigh) +
          '</span>' +
          '<span style="font-size:10px;color:var(--text3);margin-left:8px">across ' +
          _portfolioCount +
          ' lit.-range sequence' +
          (_portfolioCount !== 1 ? 's' : '') +
          ' · literature range — M&amp;V required · based on ' +
          (_annualElecData.annualKwh / 1000).toFixed(0) +
          'k kWh/yr · fan % = ' +
          Math.round(_fanFraction * 100) +
          '%</span>' +
          '</div>',
      );
    }
  }

  // Phase 3 (32521b08): advisory line always reserves its slot for Recommended/Compare tiers —
  // previously this line only rendered when there was no bill data AND no per-row savings chip
  // had shown (`!_anySavingsShown`, old `else if` branch above), so footer height/content jumped
  // between projects/tiers for reasons the user couldn't see (the investigation's root-cause
  // finding). Now it's unconditionally present in these two tiers, with text depending on
  // whether ANY savings info (the portfolio rollup above or a per-row chip) ended up visible.
  if (tier === 'recommended' || tier === 'both') {
    // 45ceb14f: extracted to _pricingAdvisoryLineHTML (byte-identical output) so
    // _pricingRefreshFooter's partial-refresh path can render the identical advisory line.
    footerParts.push(_pricingAdvisoryLineHTML(_anySavingsShown));
  }

  // b771dec6 3b: M&V disclaimer moved from here into the Top ROI card
  // (see _pricingTopRoiCallout's `showDisclaimer` param / call site below).

  // 174ad49a Phase 2: budget-vs-total indicator — every tier, including Compare (where it
  // compares against Recommended, the tier the original budget complaint was about).
  var _budgetForFooter = _pricingGetBudget(projId);
  var _budgetCompareTotal = isBothMode ? (recTotals ? recTotals.grand : null) : totals.grand;
  // 2026-07-26 ceiling-netting fix: this footer's total IS the Recommended tier's total whenever
  // tier==='recommended' OR isBothMode ('vs Recommended' always compares recTotals) — in both
  // cases it must be compared against the SAME ceiling buildRecommendedRows() actually used (see
  // _pricingBudgetVsTotalHTML's header comment), not the generic term-based figure.
  var _recCeilingOverride = null;
  if ((tier === 'recommended' || isBothMode) && _budgetForFooter.mode === 'recurring') {
    var _recCostModelForFooter = _pricingComputeProgramCostModel(projId);
    if (_recCostModelForFooter) _recCeilingOverride = _recCostModelForFooter.programMeasuresAvailable;
  }
  footerParts.push(
    _pricingBudgetVsTotalHTML(
      _budgetForFooter,
      _budgetCompareTotal,
      isBothMode ? 'vs Recommended' : '',
      _recCeilingOverride,
    ),
  );

  footerParts.push('</div>');
  var footerHTML = footerParts.join('');

  // ── 11. Build table header HTML with sort labels + resize handles + gear icon
  var widths = _pricingGetColWidths(projId);
  var sSt = _pricingSortState[projId] || { col: null, dir: null };

  function thStyle(ci, extraStyle) {
    // 0ae36950: fall back to the column's declared minWidth as the explicit default width
    // when the user hasn't drag-resized (widths[ci] falsy). Previously an unset width meant
    // NO width style at all, so auto table-layout sized each column to its own render's
    // content (different rows/content per tier), producing different widths for the same
    // logical column across Compliance/Recommended/Full-Scope (b771dec6 column-width-invest).
    // Explicit per-column defaults make shared columns pixel-identical across tiers at a
    // given viewport, while drag-resize (widths[ci] truthy) still always wins.
    var col = PRICING_TBL_COLS[ci];
    var w = widths[ci] || (col ? col.minWidth : null);
    var wStyle = w ? 'width:' + w + 'px;min-width:' + w + 'px;' : '';
    return (
      'background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 6px 8px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:sticky;top:0;user-select:none;border-right:1px solid var(--border);border-bottom:2px solid var(--border2);' +
      wStyle +
      (extraStyle || '')
    );
  }

  function sortIndicator(ci) {
    if (sSt.col !== ci) return '';
    return sSt.dir === 'asc' ? ' ▲' : ' ▼';
  }

  function buildTH(ci, extraStyle, frozen) {
    var col = PRICING_TBL_COLS[ci];
    if (!col) return '';
    if (hidden.indexOf(ci) !== -1) return ''; // skip hidden

    var frozenStyle = '';
    if (frozen) {
      frozenStyle = 'position:sticky;top:0;';
      if (ci === 0) frozenStyle += 'left:0;z-index:12;';
      else if (ci === 1) frozenStyle += 'left:' + (widths[0] || PRICING_TBL_COLS[0].minWidth) + 'px;z-index:12;';
    } else {
      frozenStyle = 'z-index:11;';
    }

    // col 12 (Line Total) label shows active basis in parens, e.g. "Line Total (Contract)"
    var colLabel = col.label;
    if (ci === 12) {
      var basisLabels = { contract: 'Contract', net: 'Net', list: 'List' };
      colLabel = 'Total (' + (basisLabels[cfg.priceBasis] || 'Contract') + ')';
    }

    var labelHTML;
    if (ci === 0) {
      // col 0 (Incl): header-level select-all checkbox replaces the "INCL" text label
      var _allOn =
        filteredRows.length > 0 &&
        filteredRows.every(function (r) {
          return estimate.rowToggles[r._baseId || r.id] !== false;
        });
      labelHTML =
        '<input type="checkbox"' +
        (_allOn ? ' checked' : '') +
        ' onclick="event.stopPropagation();_pricingToggleAllRows(\'' +
        projId +
        '\',this.checked)" title="Select/deselect all rows" style="cursor:pointer;vertical-align:middle">';
    } else {
      labelHTML = col.noSort
        ? '<span style="pointer-events:none">' + colLabel + '</span>'
        : '<span class="ch-sort-label" style="cursor:pointer">' + colLabel + sortIndicator(ci) + '</span>';
    }

    var resizeHandle =
      ci < PRICING_TBL_COLS.length - 1
        ? '<div class="ch-col-resize-handle" style="position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;background:transparent;z-index:1"></div>'
        : '';

    // b771dec6 3a: gear icon removed from the header — column visibility now lives in
    // the "⚙ Table Settings" toolbar popover alongside pricing config (see
    // _pricingOpenSettingsPopover). Documented exception recorded in ui-standards.md.

    // data-col-idx carries the PRICING_TBL_COLS index so sort/resize handlers can
    // find the correct column even when some columns are hidden (fixing defect B2).
    return (
      '<th' +
      (frozen ? ' class="ch-frozen"' : '') +
      ' data-col-idx="' +
      ci +
      '"' +
      ' style="position:relative;' +
      thStyle(ci, frozenStyle) +
      '">' +
      labelHTML +
      resizeHandle +
      '</th>'
    );
  }

  // Build each visible TH
  var headerCols = '';
  PRICING_TBL_COLS.forEach(function (col, ci) {
    if (hidden.indexOf(ci) !== -1) return;
    var isFrozen = ci <= 1;
    headerCols += buildTH(ci, null, isFrozen);
  });
  // Both mode extra header
  var extraRecHeader = isBothMode
    ? '<th style="background:var(--s1);color:var(--accent);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;text-align:right;border-left:2px solid var(--border2);border-bottom:2px solid var(--border2)">Rec. Total</th>'
    : '';

  // Phase 5 (d284e714): the old hardcoded `min-width:1006px` predated the Hours column (Phase 4)
  // and other column widenings, so it drifted out of sync with the real column-width sum. Compute
  // it live from PRICING_TBL_COLS + the current hidden-cols set so it can never drift again when
  // columns change.
  var _tblMinWidth = PRICING_TBL_COLS.reduce(function (sum, col, ci) {
    return sum + (hidden.indexOf(ci) !== -1 ? 0 : col.minWidth);
  }, 0);

  // ── 12. Assemble full panel
  // Top-ROI callout (Recommended + Both tiers, item d60f455f)
  // In Both mode, feed recRows (recommended rows carry savingsImpact); baseRows in Both = compliance rows.
  var topRoiCallout = '';
  if (tier === 'recommended' || tier === 'both') {
    var _allRecRows = tier === 'both' ? recRows || [] : baseRows;
    // b771dec6 3b: _anySavingsShown reaches its final value in the footer step (step 10)
    // above, which runs before this call — verified after Batches 1-2 land.
    topRoiCallout = _pricingTopRoiCallout(projId, _allRecRows, _anySavingsShown);
  }

  // Recommended tier: budget-state prompt + "no substitutions" notice + empty-state guard
  // c82cc354 REV 2 (Step 2c/Step 3): Recommended is now DYNAMIC and budget-driven, not a
  // static high/med-high/med subset of Compliance — the copy below reflects that.
  var recNoSubsNotice = '';
  if (tier === 'recommended') {
    var _recBudget = _pricingGetBudget(projId);
    var _recBudgetComp = _pricingComputeBudgetTotal(_recBudget);
    var _recHasBudget = !!(_recBudgetComp && _recBudget.mode === 'recurring');

    // No-budget plain-language prompt (Matt's exact-intent copy, Step 2c) — shown whenever the
    // tier is running on the HIGH-impact-only fallback (no recurring budget entered/valid).
    var recBudgetPrompt = '';
    if (!_recHasBudget) {
      recBudgetPrompt =
        '<div style="margin:8px 14px 0;padding:8px 12px;background:var(--s3);border:1px solid var(--border);' +
        'border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text2);line-height:1.5">' +
        'Showing the highest-impact measures only. Enter the client’s budget (Table Settings → Budget) ' +
        'to tailor this tier to what they can spend.' +
        '</div>';
    }

    // Empty-state: filter removed all rows (no budget-fit units at all — e.g. a ceiling too
    // small to fit even the cheapest measure, or no HIGH-impact measures exist for this project).
    if (filteredRows.length === 0) {
      recNoSubsNotice =
        recBudgetPrompt +
        '<div style="margin:8px 14px 0;padding:8px 12px;background:var(--s3);border:1px solid var(--border);' +
        'border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text2);line-height:1.5">' +
        '<strong style="color:var(--text)">No measures fit this tier</strong> — ' +
        (_recHasBudget
          ? 'no measure (with its required hardware) fits inside the current budget ceiling. Raise the budget or term to include measures.'
          : 'this project has no HIGH-impact measures identified. Enter the client’s budget to include lower-impact measures instead.') +
        ' Switch to Compliance or Full Scope to view required/complete scope.' +
        '</div>';
    } else {
      var _optStats = _pricingOptimizerStats[projId];
      var _subCount = _optStats ? _optStats.subCount : 0;
      var _subsNotice = '';
      if (_subCount === 0) {
        _subsNotice =
          '<div style="margin:8px 14px 0;padding:8px 12px;background:var(--s3);border:1px solid var(--border);' +
          'border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text2);line-height:1.5">' +
          '<strong style="color:var(--text)">No lower-cost substitutions found</strong> — ' +
          (hasCatalog
            ? 'the imported catalog contains no cheaper qualifying alternatives for the hardware in this project. '
            : 'no pricing catalog is loaded, so the optimizer could not search for alternatives. ' +
              'Import a pricing CSV to enable substitution analysis. ') +
          '<br><span style="color:var(--text3)">' +
          'Recommended is a budget-fit ranked selection of measures (not a fixed subset of Compliance). ' +
          'FDD Reporting add-on is in Full Scope tier.' +
          '</span>' +
          '</div>';
      }
      recNoSubsNotice = recBudgetPrompt + _subsNotice;
    }
  }

  // 2026-07-22: Monthly labor breakdown — same silent-until-configured convention as the rest of
  // the Monthly Service Agreement feature (returns '' until budget.amount is set). Placed as its
  // own flex-shrink:0 sibling after the footer, its own bounded-height scroll region (max-height:
  // 240px inside _pricingLaborBreakdownHTML), same documented multi-zone-scroll pattern already
  // used by the Top ROI card (ui-standards.md "Cost Estimate tab — Top ROI card + pricing table").
  var laborBreakdownHTML = _pricingLaborBreakdownHTML(projId);

  // Task 2 (2026-07-22): Recommended-tier-only phased implementation timeline (Aug-Dec 2026 /
  // CY2027 / CY2028). Same silent-until-priced convention as the labor breakdown above — renders
  // '' until the Recommended tier has at least one priced row. Not shown for 'both' (Compare) —
  // that view is about comparing tiers side-by-side, not planning one tier's rollout.
  var timelineHTML = tier === 'recommended' ? _pricingRecommendedTimelineHTML(projId) : '';

  // 2026-07-22 fix: laborBreakdownHTML + timelineHTML were each individually flex-shrink:0
  // siblings under the fixed-height, overflow:hidden `.ch-panel` — stacking BOTH (a project with
  // real sequences/budget AND a priced Recommended tier) could push their combined height past
  // whatever slack remained after the toolbar/table/footer, silently CLIPPING the bottom of the
  // timeline table with no way to scroll to it (verified: `.ch-panel` scrollHeight 959 vs
  // clientHeight 815 before this fix). Wrapping both in one flex:1/min-height:0/overflow:auto
  // container — a sibling of `.ch-panel-body` (also flex:1, with its own min-height:220 floor
  // that wins first) — means this combined "extra info" region absorbs whatever slack is left and
  // scrolls internally if it doesn't fit, instead of anything above it being invisibly cut off.
  // Each table's own bounded max-height/scroll (240px / 220px) is unchanged.
  var extraInfoHTML =
    laborBreakdownHTML || timelineHTML
      ? '<div style="flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column">' +
        laborBreakdownHTML +
        timelineHTML +
        '</div>'
      : '';

  el.innerHTML = [
    '<div class="ch-panel" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;height:100%">',
    toolbarHTML,
    topRoiCallout,
    recNoSubsNotice,
    '<div class="ch-panel-body" style="flex:1;min-height:220px;display:flex;flex-direction:column;overflow:hidden">',
    '<div class="ch-tbl-outer" style="margin:0;flex:1;min-height:220px;display:flex;flex-direction:column;overflow:hidden">',
    '<div class="ch-tbl-scroll" style="flex:1;min-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px">',
    // 0ae36950: dropped `width:100%` — with per-column default widths now always set (see
    // thStyle), a table wider than the sum of its own column widths (any viewport past ~1280px)
    // was being stretched by width:100% to fill the scroll container, and CSS auto table-layout
    // redistributes that extra width proportionally across ALL columns by their existing width
    // share. Recommended has one more column (Impact) than Compliance/Full-Scope, so its total
    // specified width differs, and the SAME shared column rendered at a different absolute px
    // width per tier at wide viewports even though thStyle gives them identical explicit widths.
    // Dropping width:100% makes the table render at its natural (column-sum) width in every case
    // — extra container space just shows as blank space to the right inside .ch-tbl-scroll,
    // which already provides the horizontal scrollbar for narrower viewports.
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;min-width:' + _tblMinWidth + 'px">',
    '<thead><tr>',
    headerCols,
    extraRecHeader,
    '</tr></thead>',
    '<tbody id="pricing-tbody-' + projId + '">',
    tableBodyHTML,
    '</tbody>',
    '</table>',
    '</div>',
    '</div>',
    '</div>',
    '<div id="pricing-footer-' + projId + '">',
    footerHTML,
    '</div>',
    extraInfoHTML,
    '</div>',
  ].join('');

  // ── 13. Post-render: apply saved widths, attach handlers, update sticky offsets
  setTimeout(function () {
    _pricingApplyColWidths(projId);
    _pricingUpdateStickyOffsets(projId);
    _pricingAttachResizeHandlers(projId);
    _pricingAttachSortHandlers(projId);
  }, 0);
};

/* ══════════════════════════════════════════════════════════════════════════════
   _pricingComputeSummaryData — per-building / per-tier aggregate data
   Formerly also fed a "Summary" sub-tab UI (5ff6c401, 2026-07-06) that rendered this data as its
   own peer tab next to Recommended/Compliance/Full Scope/Compare. That UI (_pricingRenderSummaryTab,
   plus its _pricingSummaryEsc/_pricingSummaryBldgCellHTML helpers) was REMOVED 2026-07-22 per
   Matt's explicit request ("The Cost Estimate per building I do not like and it honestly gives no
   information. Just remove completely.") — see the removed "Summary" tier button in
   _pricingTierToggleHTML and the tier==='summary' fallback in initCostEstimateTab.
   This function itself is UNCHANGED and still load-bearing: report-engine.js's
   rptPageASHRAE36ProposalPricing (both the cover Cost Summary strip and the Cost Estimate
   page's tier-detail panels) calls it directly — do not delete it.
   ══════════════════════════════════════════════════════════════════════════════ */
// Aggregates per-building / per-tier totals. Returns:
//   { buildings: [{ building, tiers: { recommended: {items,hw,lb,total}, compliance: {...},
//                    'full-scope': {...} } }, ...],
//     tierTotals: { recommended: <totals from _pricingComputeTotals>, compliance: {...},
//                   'full-scope': {...} } }
function _pricingComputeSummaryData(projId, estimate) {
  var tierDefs = [
    { key: 'compliance', builder: buildComplianceRows },
    { key: 'recommended', builder: buildRecommendedRows },
    { key: 'full-scope', builder: buildFullScopeRows },
  ];
  var perTier = {};
  var bldgOrder = [];
  var bldgSeen = {};

  tierDefs.forEach(function (t) {
    var rows = t.builder(projId);
    rows = _pricingApplyLaborOverrides(projId, rows);
    rows = _pricingApplyQtyOverrides(projId, rows);
    perTier[t.key] = rows;
    rows.forEach(function (r) {
      if (r.building && !bldgSeen[r.building]) {
        bldgSeen[r.building] = true;
        bldgOrder.push(r.building);
      }
    });
  });

  function sumRows(rows) {
    var hw = rows.filter(function (r) {
      return r.phase === 1;
    });
    var lb = rows.filter(function (r) {
      return r.phase === 2;
    });
    var hwSum = hw.reduce(function (s, r) {
      return estimate.rowToggles[r._baseId || r.id] !== false ? s + (r.lineTotal || 0) : s;
    }, 0);
    var lbSum = lb.reduce(function (s, r) {
      return estimate.rowToggles[r._baseId || r.id] !== false ? s + (r.lineTotal || 0) : s;
    }, 0);
    return { items: rows.length, hw: hwSum, lb: lbSum, total: hwSum + lbSum };
  }

  var buildings = bldgOrder.map(function (bName) {
    var tiers = {};
    tierDefs.forEach(function (t) {
      var bRows = perTier[t.key].filter(function (r) {
        return r.building === bName;
      });
      tiers[t.key] = sumRows(bRows);
    });
    return { building: bName, tiers: tiers };
  });

  var tierTotals = {};
  tierDefs.forEach(function (t) {
    tierTotals[t.key] = _pricingComputeTotals(perTier[t.key], estimate);
  });

  // perTier exposed so the client proposal's optional "Itemized Measures" sub-option can
  // aggregate measures across the portfolio without recomputing any pricing. Rows carry the
  // final lineTotal / item name / clientSummary only; no cost build-up. (No new math here.)
  return { buildings: buildings, tierTotals: tierTotals, perTier: perTier };
}

/* ── Phase 4: patch _pricingRefreshFooter to apply labor overrides ──────── */
(function () {
  var _origRefreshFooter = _pricingRefreshFooter;
  _pricingRefreshFooter = function (projId) {
    var est = _pricingGetEstimate(projId);
    var tier = est.tier || 'compliance';

    // Secondary fix: Both/full-scope modes have footers that cannot be reproduced
    // here cheaply. Delegate to full re-render to keep them consistent. ('summary' removed
    // 2026-07-22 — see initCostEstimateTab's tier==='summary' fallback.)
    if (tier === 'both' || tier === 'full-scope') {
      initCostEstimateTab(projId);
      return;
    }

    // Use labor+qty-override-applied rows from cache if available. Fallback (cache miss)
    // must use the tier-CORRECT builder — 'recommended' is no longer a filtered subset of
    // buildComplianceRows (c82cc354 REV 2), so this must call buildRecommendedRows for that
    // tier or the footer would show the wrong (Compliance) total while labeled Recommended.
    var rows = _pricingRowCache[projId];
    if (!rows) {
      var _fallbackRows = tier === 'recommended' ? buildRecommendedRows(projId) : buildComplianceRows(projId);
      rows = _pricingApplyQtyOverrides(projId, _pricingApplyLaborOverrides(projId, _fallbackRows));
    }
    var cfg = _pricingGetConfig();
    var catalog = sget('en_pricing_catalog', null);
    var totals = _pricingComputeTotals(rows, est);
    var filterBldg = _pricingBldgFilter[projId] || '';

    // 45ceb14f: re-derive the Tier-label + advisory-line state the same way the full render
    // does, WITHOUT re-rendering rows. tier is always 'compliance' or 'recommended' here (see
    // the 'both'/'full-scope' delegation guard above), so this mirrors the full render's
    // _annualElecData/_fanFraction/_elecRate derivation (app/pricing-estimator.js:3684-3690)
    // narrowed to that same two-tier domain — 'compliance' never has bill data pulled (matches
    // the full path, where _annualElecData is only computed for 'recommended'/'both').
    var _annualElecData =
      tier === 'recommended'
        ? _pricingGetProjectAnnualElec(projId)
        : { annualKwh: null, hasBillData: false, elecRate: 0.1 };
    var _fanFraction =
      cfg.fanFraction !== undefined && cfg.fanFraction !== null ? cfg.fanFraction : FAN_FRACTION_DEFAULT;
    var _elecRate = _annualElecData.elecRate || 0.1;
    var _anySavingsShown =
      tier === 'recommended' ? _pricingComputeAnySavingsShown(rows, _annualElecData, _fanFraction, _elecRate) : false;

    var _rfCaveatParts = [];
    if (totals.noCatalog) _rfCaveatParts.push('Hardware pending — import pricing CSV');
    if (totals.pendingPriceCount > 0)
      _rfCaveatParts.push(totals.pendingPriceCount + ' item(s) pending price (excluded)');
    if (totals.engReviewCount > 0) _rfCaveatParts.push(totals.engReviewCount + ' eng-review');
    _rfCaveatParts.push('Basis: ' + (cfg.priceBasis || 'contract'));

    var footerEl = document.getElementById('pricing-footer-' + projId);
    if (!footerEl) return;

    var filterNote = filterBldg
      ? '<span style="font-size:11px;color:var(--accent);font-weight:600">Filter: ' + filterBldg + '</span>'
      : '';

    footerEl.innerHTML = [
      '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
      _pricingTierLabelHTML(tier), // 45ceb14f: was missing entirely from this path
      '<span style="color:var(--border2)">|</span>', // 45ceb14f: separator to match full-render field order
      '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 1 Hardware:</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
        (totals.noCatalog
          ? '<span style="color:var(--text3);font-size:11px;font-weight:400">Import pricing CSV</span>'
          : totals.grand !== null
            ? _pricingFmt(totals.phase1)
            : '—') +
        '</span>',
      '<span style="font-size:12px;font-weight:700;color:var(--text2)">Phase 2 Programming:</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">' +
        (totals.grand !== null ? _pricingFmt(totals.phase2) : '—') +
        '</span>',
      '<span style="color:var(--border2)">|</span>',
      '<span style="font-size:13px;font-weight:700;color:var(--em);font-variant-numeric:tabular-nums">Grand Total: ' +
        (totals.grand !== null
          ? totals.noCatalog
            ? 'Labor: ' + _pricingFmt(totals.grand)
            : _pricingFmt(totals.grand)
          : '—') +
        '</span>',
      filterNote,
      '<span style="flex:1"></span>',
      '<span style="font-size:11px;color:var(--text3)">' + totals.included + ' of ' + totals.total + ' items</span>',
      '<span style="font-size:11px;color:var(--text3)">' + _rfCaveatParts.join(' · ') + '</span>',
      tier === 'recommended' ? _pricingAdvisoryLineHTML(_anySavingsShown) : '', // 45ceb14f: was missing entirely
      // 2026-07-26 ceiling-netting fix: same override as the full-render footer above — tier here
      // is always 'compliance' or 'recommended' (see the guard comment a few lines up), so only
      // 'recommended' needs the program-wide net-of-labor ceiling swapped in.
      _pricingBudgetVsTotalHTML(
        _pricingGetBudget(projId),
        totals.grand,
        '',
        (function () {
          if (tier !== 'recommended') return null;
          var _b = _pricingGetBudget(projId);
          if (_b.mode !== 'recurring') return null;
          var _cm = _pricingComputeProgramCostModel(projId);
          return _cm ? _cm.programMeasuresAvailable : null;
        })(),
      ), // 174ad49a Phase 2
      '</div>',
    ].join('');
  };
})();

/* ── Phase 4 CSS (injected once into document head) ─────────────────────── */
(function () {
  var styleId = 'pricing-phase4-styles';
  if (document.getElementById(styleId)) return; // already injected
  var style = document.createElement('style');
  style.id = styleId;
  style.textContent = [
    /* Resize handle */
    '.ch-tbl .ch-col-resize-handle:hover,',
    '.ch-tbl .ch-col-resize-handle.dragging {',
    '  background: var(--accent); opacity: 0.4;',
    '}',
    /* Sort label hover */
    '.ch-tbl .ch-sort-label:hover { color: var(--text); }',
    /* Frozen cells (Freeze-panes spec: opaque background + z-index so scrolled */
    /* content cannot bleed through; per-row-state overrides below) */
    '.ch-tbl .ch-frozen { position: sticky; z-index: 10; background: var(--s2); }',
    '.ch-tbl tbody tr.ch-tbl-row-io td.ch-frozen { background: var(--s1); }',
    '.ch-tbl tbody tr.ch-tbl-row-io:hover td.ch-frozen { background: var(--s4); }',
    /* Cell grid lines (ui-standards §Tables §Cell grid lines) */
    '.ch-tbl td { border-right: 1px solid var(--border2); border-bottom: 1px solid var(--border2); }',
    '.ch-tbl td:last-child { border-right: none; }',
    '.ch-tbl tbody tr:last-child td { border-bottom: none; }',
    /* Row hover */
    '.ch-tbl tbody tr:hover td { background: var(--s4); }',
    /* Tabular nums for numeric cells */
    '.ch-tbl td { font-variant-numeric: tabular-nums; }',
    /* Phase 1 (cost-estimate-ux-2026-07-06): soften optional editable-cell borders — */
    /* non-overridden Qty/Hours inputs get the .ch-soft-input class with a transparent */
    /* border (background still signals "editable"); reveal the border on hover/focus */
    /* so the edit affordance is not lost. Deviation from the plan's literal selector */
    /* (".ch-tbl input:hover") — that selector alone can never win against the inline */
    /* border-color already set on overridden (var(--accent)) and required-manual-price */
    /* (var(--warn)) inputs (inline style beats any non-!important stylesheet rule, */
    /* pseudo-class or not), so a blanket rule would either do nothing on those inputs */
    /* or require !important, which WOULD incorrectly flatten their border to grey on */
    /* hover. Scoping to .ch-soft-input (only added when NOT overridden/required) keeps */
    /* those meaningful borders on regardless of hover, per the constraint above. */
    '.ch-tbl input.ch-soft-input { border: 1px solid transparent; }',
    '.ch-tbl input.ch-soft-input:hover, .ch-tbl input.ch-soft-input:focus { border-color: var(--border); }',
  ].join('\n');
  if (document.head) document.head.appendChild(style);
})();

/* ── Phase 5 — collectPricingEstimate (spec §10) ────────────────────────────
   Returns {hardwareTotal, laborTotal, grandTotal, basis, skusMissing,
            engReviewCount, pendingPriceCount} for tier in {'compliance','recommended','full-scope'}.
   Returns null if no en_pricing_catalog.
   pendingPriceCount = included rows with no resolvable price (NO-SKU unpriced +
   SKU not in catalog). I/O-only ($0) rows are NOT counted as pending.
   grandTotal is the priced subtotal; null only when no catalog or zero priced rows.
   ─────────────────────────────────────────────────────────────────────────── */
function collectPricingEstimate(projId, tier) {
  var catalog = sget('en_pricing_catalog', null);
  if (!catalog || !Object.keys(catalog).length) return null;

  var activeTier = tier || 'compliance';
  var rows;
  if (activeTier === 'recommended') {
    rows = buildRecommendedRows(projId);
  } else if (activeTier === 'full-scope') {
    rows = buildFullScopeRows(projId);
  } else {
    rows = buildComplianceRows(projId);
  }

  if (!rows || !rows.length) return null;

  var estimate = _pricingGetEstimate(projId);
  var cfg = _pricingGetConfig();
  var totals = _pricingComputeTotals(rows, estimate);

  var skusMissing = 0;
  var engReviewCount = 0;

  rows.forEach(function (row) {
    if (row.engReview) engReviewCount++;
    if (row.phase === 1 && !row.ioOnly && !row.noSku && row.sku) {
      if (!catalog[row.sku]) skusMissing++;
    }
  });

  return {
    hardwareTotal: totals.phase1,
    laborTotal: totals.phase2,
    grandTotal: totals.grand,
    basis: cfg.priceBasis || 'contract',
    skusMissing: skusMissing,
    engReviewCount: engReviewCount,
    pendingPriceCount: totals.pendingPriceCount,
  };
}
