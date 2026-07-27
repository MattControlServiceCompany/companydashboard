/* ── ASHRAE-36 Pricing & Cost-Estimator — Phase 1 + Phase 2 (Compliance Tier)
   Spec: 2026-06-18-ashrae36-pricing-cost-estimator-SPEC.md
   Storage keys:
     en_pricing_catalog        — global SKU→{list,net,contract,computed_net,category,desc}
     en_pricing_meta           — global {importedAt,filename,skuCount}
     en_pricing_config         — global {netMultiplier,contractPct,hourlyRate,priceBasis,perSequenceHours,
                                 installLaborRate,installHoursByPoint} (Deliverable E, 2026-07-19 —
                                 installLaborRate/installHoursByPoint price the PHYSICAL install of
                                 hardware gaps; hourlyRate/perSequenceHours remain BAS sequence-
                                 PROGRAMMING labor, untouched)
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

/* ── Physical install labor — Deliverable E (2026-07-19) ────────────────────
   COST_LABOR_RATE_DEFAULT above ($125/hr) + COST_PER_SEQ_HOURS_DEFAULT price BAS sequence
   PROGRAMMING labor only (Phase 2). Neither has ever priced the physical labor to mount/wire
   a sensor, actuator, or valve — Phase 1 ("Hardware & Installation") was parts-cost only. This
   block adds a SEPARATE $/hr rate + per-device-class hours so Phase 1 actually includes install
   labor, without touching the programming-labor math above.
   ─────────────────────────────────────────────────────────────────────────── */
const COST_INSTALL_LABOR_RATE_DEFAULT = 195; // $/hr — physical install, distinct from the $125/hr
// programming rate above.
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
  oaDampCmd: 'damperActuator',
  raDampCmd: 'damperActuator',
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
   budget field (default 36) × the shared global en_pricing_config.hourlyRate — NOT a new rate
   field, and NOT the installLaborRate added for Phase 1 hardware rows — and compares it against
   budget.amount as the not-to-exceed allowance. Purely additive/presentational: does not touch
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

/* ── Does this project have utility bills on file? (2026-07-22) ──────────────────────────────
   Utility bill data lives per-project at en_utility_{projId} → {buildings:[{meters:[{bills:[]}]}]}
   (same source _pricingGetProjectAnnualElec reads, above) — NOT en_pdf_bills, which is the
   global PDF-import staging array keyed by bill.projId before a bill is committed to a meter.
   Checked here (not just electricity, any commodity) purely to decide whether "Utility Bill Data
   Entry" belongs in the monthly labor breakdown below — this performs no calculation of its own.
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

/* ── Monthly Recurring EM Service Labor Breakdown (2026-07-22; trend category added 2026-07-26;
   REBUILT 2026-07-26 fix-phase-cost-budget-model to stop double-counting Program & Sequence Setup
   and stop force-filling the whole allowance) ────────────────────────────────────────────────────
   WHY this exists: Matt's ask was to show WHY the monthly EM service hours are needed, not just a
   flat hours×rate total — real setup work (alarm configuration, report setup, trend/graphics
   setup, and — when the client hand-provides them — utility bill data entry) that is heaviest in
   the first few months and tapers to steady-state monitoring.

   REBUILD REASON (2026-07-26, Matt: "get the allowance model working and correct"): the prior
   version had two defects, both fixed here:
     (a) "Ongoing Monitoring & Optimization" was a REMAINDER category — `totalHours (36) −
         setupHoursUsed` — which forced every month's categories to sum to exactly the flat
         36-hr/mo total by construction, regardless of what work was actually needed. That left
         ~$22/mo of a $6,250 allowance for parts after 36hrs×$173/hr. 36 hrs is
         `budget.serviceHoursPerMonth`, the all-labor-no-parts EXTREME used by
         _pricingComputeMonthlyService's not-to-exceed headline — it was never meant to be a floor
         every month must hit. Fixed: Ongoing Monitoring & Optimization is now a DEFINED flat
         allocation (ONGOING_MONITORING_HOURS_DEFAULT, same shape as the other *_DEFAULT constants
         below), present every month, never scaled to fill anything.
     (b) "Program & Sequence Setup" reused COST_PER_SEQ_HOURS_DEFAULT — the EXACT SAME per-sequence
         hours buildCatalogRows' phase-2 rows already price as "Programming" inside the measures
         total (see _pricingComputeProgramCostModel below, which nets this breakdown's total against
         the SAME calendar allowance the measures total draws from). Keeping it here meant those
         programming hours were priced twice against the same dollars. Fixed: Program & Sequence
         Setup is REMOVED from this function entirely — it is one-time PROJECT work, already priced
         as "Programming" line items inside the measures total, not part of the RECURRING monthly
         EM service. Documented in my-knowledge-base/wiki/joco-monthly-allowance-vs-em-labor-
         overlap.md (that overlap is now resolved by this removal — see the update note there).

   This function now answers a narrower, correct question: "what RECURRING monthly labor must
   happen regardless of which measures get funded?" — Alarm Configuration, Report Setup, Trend
   Setup & Configuration, Utility Bill Data Entry (conditional on bills on file), and Ongoing
   Monitoring & Optimization. It is READ BY _pricingComputeProgramCostModel to compute
   `emLaborTotal`/`measuresAvailable` per phase — no longer purely presentational; the monthly
   totals it returns now flow into real dollar math, so they intentionally do NOT sum to a fixed
   cap anymore (Month 1 is highest, Month 4+ is lowest — see the per-month figures in the function
   below). This is deliberate — the old "sums-to-36-every-month" invariant WAS the double-count/
   fill-the-allowance bug and has been removed on purpose.

   Ramp model (simple 4-step taper, unchanged from the original, per Matt's ask — still applies
   only to the SETUP categories, not to Ongoing Monitoring which is now constant every month):
     Month 1      — 100% of the "setup pool" (alarms + reports + trends + bill entry)
     Month 2      —  60% of the setup pool
     Month 3      —  30% of the setup pool
     Month 4+     —   0% (steady state) — only Ongoing Monitoring & Optimization remains

   Utility Bill Data Entry only appears when the project has bill data on file
   (_pricingProjectHasUtilityBills) — a project with no bills doesn't need this line.

   Trend Setup & Configuration (2026-07-26, task: "we also need to build in time for setting up
   trends and other changes like that") — unchanged from its 2026-07-26 addition, still flat
   TREND_SETUP_HOURS_DEFAULT, unconditional.

   Returns null when _pricingComputeMonthlyService returns null (no budget.amount set — same
   silent-until-configured convention as the rest of this feature).
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeMonthlyLaborBreakdown(projId) {
  var svc = _pricingComputeMonthlyService(projId);
  if (!svc) return null;
  var hourlyRate = svc.hourlyRate;

  var ALARM_SETUP_HOURS_DEFAULT = 4;
  var REPORT_SETUP_HOURS_DEFAULT = 3;
  var TREND_SETUP_HOURS_DEFAULT = 3; // 2026-07-26: BAS trend log setup — see comment block above
  var hasBills = _pricingProjectHasUtilityBills(projId);
  var BILL_ENTRY_HOURS_DEFAULT = hasBills ? 3 : 0;
  // Ongoing Monitoring & Optimization (2026-07-26 rebuild): a DEFINED recurring monthly
  // allocation — present in every month, same magnitude-of-constant pattern as the setup
  // categories above (not derived, not scaled to fill anything). This is the number a future
  // pricing decision may want to tune per-portfolio-size; flagged as a default, not a
  // config-editable field yet (matches how Alarm/Report/Trend/Bill Entry hours are also
  // uneditable *_DEFAULT constants today).
  var ONGOING_MONITORING_HOURS_DEFAULT = 8;

  var setupPoolHours =
    ALARM_SETUP_HOURS_DEFAULT + REPORT_SETUP_HOURS_DEFAULT + TREND_SETUP_HOURS_DEFAULT + BILL_ENTRY_HOURS_DEFAULT;

  function roundHrs(n) {
    return Math.round(n * 100) / 100;
  }

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
      var alarmHrs = roundHrs(ALARM_SETUP_HOURS_DEFAULT * frac);
      if (alarmHrs > 0) out.push({ category: 'Alarm Configuration', hours: alarmHrs });
      var reportHrs = roundHrs(REPORT_SETUP_HOURS_DEFAULT * frac);
      if (reportHrs > 0) out.push({ category: 'Report Setup', hours: reportHrs });
      var trendHrs = roundHrs(TREND_SETUP_HOURS_DEFAULT * frac);
      if (trendHrs > 0) out.push({ category: 'Trend Setup & Configuration', hours: trendHrs });
      if (hasBills) {
        var billHrs = roundHrs(BILL_ENTRY_HOURS_DEFAULT * frac);
        if (billHrs > 0) out.push({ category: 'Utility Bill Data Entry', hours: billHrs });
      }
    }
    // Constant every month — NOT a remainder. This is what fixes defect (a).
    out.push({ category: 'Ongoing Monitoring & Optimization', hours: ONGOING_MONITORING_HOURS_DEFAULT });
    return out;
  }

  var months = [
    { label: 'Month 1', rows: buildMonthRows(1) },
    { label: 'Month 2', rows: buildMonthRows(2) },
    { label: 'Month 3', rows: buildMonthRows(3) },
    { label: 'Month 4+ (steady state)', rows: buildMonthRows(4) },
  ];

  return {
    hourlyRate: hourlyRate,
    setupPoolHours: setupPoolHours,
    ongoingMonitoringHours: ONGOING_MONITORING_HOURS_DEFAULT,
    months: months,
    hasBills: hasBills,
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

  var totalCells = bd.months
    .map(function (m) {
      var sum = m.rows.reduce(function (s, r) {
        return s + r.hours;
      }, 0);
      return (
        '<td style="padding:6px 10px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;' +
        'border-top:2px solid var(--border2)">' +
        Math.round(sum * 100) / 100 +
        ' hrs</td>'
      );
    })
    .join('');

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
    // 2026-07-22: DCV promotion — demandCtrl/vav_dcv must sort to the very top of the
    // Recommended list, ahead of every other measure (not merely ahead of its own tier
    // bucket). An explicit tiebreak here guarantees that outcome regardless of how the
    // weight/effectiveCostTier score below happens to rank against other 'high' tier
    // measures (e.g. ahu_dsp_reset/ahu_sat_reset score higher on that formula alone).
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
    installLaborRate: COST_INSTALL_LABOR_RATE_DEFAULT, // Deliverable E — physical install $/hr
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
  var installHoursMap = cfg.installHoursByPoint || INSTALL_HOURS_BY_POINT_DEFAULT;
  var installLaborRate = cfg.installLaborRate != null ? cfg.installLaborRate : COST_INSTALL_LABOR_RATE_DEFAULT;

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
    // Map: pointKey → { equipType → { count, catLabel, engIds } }
    var hardwareGaps = {}; // pointKey → { equipType, count, catLabel, equipIds }
    var oatDeDupDone = false;
    var oaWetBulbDeDupDone = false;

    // Track per-zone which missing points exist (for combo logic)
    // equipId → set of missing required point keys
    var perEquipMissing = {};

    bldgData.equipResults.forEach(function (eq) {
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
    bldgData.equipResults.forEach(function (eq) {
      var cat = eq.category;
      var catLabel = _pricingCatLabel(cat);
      eq.compliance.missingPoints.forEach(function (mp) {
        var pointKey = mp.categoryKey;
        var mapEntry = PRICE_POINT_MAP[pointKey];
        if (!mapEntry) return; // no mapping → skip

        // Skip I/O-only here (handled separately for display)
        // Actually include them so we can show the $0 rows

        // For co2: distinguish AHU duct CO2 from zone CO2 using category
        var effectiveKey = pointKey;
        if (pointKey === 'co2') {
          var zoneTypes = ['vav', 'fpb', 'ddvav', 'zone'];
          effectiveKey = zoneTypes.indexOf(cat) !== -1 ? 'co2_zone' : 'co2_ahu';
          mapEntry = PRICE_POINT_MAP[effectiveKey];
          if (!mapEntry) return;
        }

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

        // co2_zone + zoneTemp combo: if BOTH are missing on the same zone,
        // one ZS2-HC-ALC covers both — de-dup qty
        if (effectiveKey === 'co2_zone' || effectiveKey === 'zoneTemp') {
          var eqMissing = perEquipMissing[eq.id] ? perEquipMissing[eq.id].keys : {};
          if (effectiveKey === 'co2_zone' && eqMissing['zoneTemp'] && eqMissing['co2']) {
            // Both missing: charge ZS2-HC-ALC once (covers both), skip separate zoneTemp
            var comboKey = 'co2_zone__' + cat;
            if (!hardwareGaps[comboKey])
              hardwareGaps[comboKey] = {
                pointKey: 'co2_zone',
                equipType: cat,
                catLabel: catLabel,
                count: 0,
                mapEntry: PRICE_POINT_MAP['co2_zone'],
              };
            hardwareGaps[comboKey].count++;
            // Mark zoneTemp as "covered by combo" so we skip it in zoneTemp pass
            if (!hardwareGaps['zoneTemp__' + cat + '__comboed'])
              hardwareGaps['zoneTemp__' + cat + '__comboed'] = { count: 0 };
            hardwareGaps['zoneTemp__' + cat + '__comboed'].count++;
            return;
          }
          if (effectiveKey === 'zoneTemp') {
            var eqMissingZ = perEquipMissing[eq.id] ? perEquipMissing[eq.id].keys : {};
            // If co2 is also missing → this zone is handled in the co2_zone pass (combo)
            if (eqMissingZ['co2']) return;
            // Otherwise: standalone zoneTemp
            var ztKey = 'zoneTemp__' + cat;
            if (!hardwareGaps[ztKey])
              hardwareGaps[ztKey] = {
                pointKey: 'zoneTemp',
                equipType: cat,
                catLabel: catLabel,
                count: 0,
                mapEntry: PRICE_POINT_MAP['zoneTemp'],
              };
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
    bldgData.equipResults.forEach(function (eq) {
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
    var seqCounts = {}; // seqKey → count of blocked/partial instances
    var seqBlocked = {}; // seqKey → count of blocked-only instances
    var seqPartial = {}; // seqKey → count of partial-only instances
    var seqApplicable = {}; // seqKey → count of non-'na' instances (denominator)

    bldgData.equipResults.forEach(function (eq) {
      if (!eq.seqReadiness) return;
      Object.keys(eq.seqReadiness).forEach(function (seqKey) {
        var entry = eq.seqReadiness[seqKey];
        if (entry.status === 'na') return;
        // Count all non-na as applicable (denominator)
        seqApplicable[seqKey] = (seqApplicable[seqKey] || 0) + 1;
        if (entry.status === 'blocked') {
          seqCounts[seqKey] = (seqCounts[seqKey] || 0) + 1;
          seqBlocked[seqKey] = (seqBlocked[seqKey] || 0) + 1;
        } else if (entry.status === 'partial') {
          seqCounts[seqKey] = (seqCounts[seqKey] || 0) + 1;
          seqPartial[seqKey] = (seqPartial[seqKey] || 0) + 1;
        }
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

    Object.keys(seqCounts).forEach(function (seqKey) {
      var count = seqCounts[seqKey];
      if (count <= 0) return;
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
      var blockedN = seqBlocked[seqKey] || 0;
      var partialN = seqPartial[seqKey] || 0;
      var statusBreakdown = '';
      if (blockedN > 0 && partialN > 0) {
        statusBreakdown = ' (' + blockedN + ' blocked, ' + partialN + ' partial)';
      } else if (blockedN > 0) {
        statusBreakdown = ' (' + blockedN + ' blocked)';
      } else if (partialN > 0) {
        statusBreakdown = ' (' + partialN + ' partial)';
      }

      rows.push({
        id: 'seq_' + bName + '_' + seqKey + '_' + rowIdx++,
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
  // Distinguish ZS2 variants: ZS2-HC-ALC is the combo Temp/Humidity/CO2 sensor; ZS2-ALC is temp-only
  if (sku === 'ZS2-HC-ALC') return 'Temp/Hum/CO2';
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
      set — membership is the ranked (_pricingEquipRowScore, best ROI-per-
      dollar first) greedy prefix that fits (_pricingGreedyPrefix, the
      shipped v631 Fit-to-Budget engine, reused verbatim). No budget (or Mode
      A financing, or an invalid term) → membership = HIGH-impact units only
      (Matt's specified fallback).
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
              (rec.installHours || 0) * (rec.installLaborRate || COST_INSTALL_LABOR_RATE_DEFAULT)
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

        // Dynamic effectiveCostTier: if all blocking sensors for this sequence are
        // already covered in the equipment matrix → effectiveCostTier=1 (programming only).
        // We approximate "covered" by checking if phase-1 hardware rows for those sensors
        // exist in catRows (i.e., they AREN'T in the gap list — gaps = missing sensors).
        // Since buildCatalogRows only adds rows for MISSING points, if a blocking sensor
        // key has NO row in catRows for this building, it is already covered.
        var blocking = SEQUENCE_BLOCKING_SENSORS[rec.seqKey] || [];
        var nominalTier = impactDef.nominalCostTier || 2;
        if (blocking.length === 0) {
          // No blocking sensors — programming only
          rec._effectiveCostTier = 1;
        } else {
          // Check if any blocking sensor is still a gap (has a phase-1 row in catRows for this building)
          var gapPointKeys = {};
          catRows.forEach(function (cr) {
            if (cr.phase === 1 && cr.building === rec.building && cr._pointKey) {
              gapPointKeys[cr._pointKey] = true;
            }
          });
          var anyBlocked = blocking.some(function (sk) {
            return gapPointKeys[sk];
          });
          rec._effectiveCostTier = anyBlocked ? nominalTier : 1;
        }
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
    var optionalGaps = {}; // gKey -> {pointKey, equipType, catLabel, count, mapEntry}
    var oatDeDupDone = false;
    var oaWetBulbDeDupDone = false;

    bldgData.equipResults.forEach(function (eq) {
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
        var mapEntry = PRICE_POINT_MAP[pointKey];
        if (!mapEntry) return; // unmapped — EXCLUDED, no catalogued hardware (spec §5)

        var effectiveKey = pointKey;
        if (pointKey === 'co2') {
          var zoneTypes = ['vav', 'fpb', 'ddvav', 'zone'];
          effectiveKey = zoneTypes.indexOf(cat) !== -1 ? 'co2_zone' : 'co2_ahu';
          mapEntry = PRICE_POINT_MAP[effectiveKey];
          if (!mapEntry) return;
        }

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
    bldgData.equipResults.forEach(function (eq) {
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
      var instRate =
        row.installLaborRate != null ? row.installLaborRate : cfg.installLaborRate || COST_INSTALL_LABOR_RATE_DEFAULT;
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
      var _qtyOvInstRate = cloned.installLaborRate != null ? cloned.installLaborRate : COST_INSTALL_LABOR_RATE_DEFAULT;
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
  return (row._savingsWeight || 0) / Math.max(row._effectiveCostTier || 1, 1);
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
    var blocking = (seqRow.seqKey && SEQUENCE_BLOCKING_SENSORS[seqRow.seqKey]) || [];
    if (!blocking.length) return; // no blocking sensors → standalone
    hw.forEach(function (_hwCandidate) {
      if (claimedHwIds[_hwCandidate.id]) return; // already claimed by another sequence
      if (_hwCandidate._pointKey && blocking.indexOf(_hwCandidate._pointKey) !== -1) {
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
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingGreedyPrefix(units, ceiling) {
  var sorted = units.slice().sort(function (a, b) {
    return b.score - a.score;
  });

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
    '<div style="font-size:10px;color:var(--text3);line-height:1.4;margin-bottom:8px">' +
    'Applied to every programming-labor row’s Hours to compute its Line Total (see the Rate column).' +
    '</div>' +
    /* Deliverable E: Install Rate — same shared-HTML/same-id-reused-across-two-popovers pattern
       as the Hourly Rate block above (mirrors the 1476aedd precedent this comment describes).
       Separate storage key (installLaborRate) from Hourly Rate's (hourlyRate) — physical install
       labor vs. BAS sequence-programming labor are never the same $/hr. */
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px">' +
    'Install Rate:' +
    '<span style="display:flex;align-items:center;gap:4px">' +
    '<input type="number" id="pricing-install-rate-' +
    projId +
    '" min="1" max="999" step="1" value="' +
    (cfg.installLaborRate != null ? cfg.installLaborRate : COST_INSTALL_LABOR_RATE_DEFAULT) +
    '"' +
    ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'installLaborRate',parseFloat(this.value))\">" +
    '<span style="font-size:10px;color:var(--text3)">$/hr</span>' +
    '</span></label>' +
    '<div style="font-size:10px;color:var(--text3);line-height:1.4">' +
    'Applied to every hardware row’s install hours (per device type — edit in the Hours column) to price physical installation, folded into Phase 1 "Hardware &amp; Installation".' +
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
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px" ' +
    'title="Programming/sequence labor $/hr — Phase 2">' +
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
  html +=
    /* Deliverable E: physical install labor $/hr — separate rate from Hourly Rate above (Phase 2
       programming labor). Applied to every Phase-1 hardware row's install hours (per-device-type,
       editable in the Hours column on hardware rows) to price physical installation, folded into
       Phase 1 "Hardware & Installation". */
    '<label style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--text2);margin-bottom:6px" ' +
    'title="Physical install labor $/hr — Phase 1 (Hardware & Installation)">' +
    'Install Rate:' +
    '<input type="number" id="pricing-install-rate-' +
    projId +
    '" min="1" max="999" step="1" value="' +
    (cfg.installLaborRate != null ? cfg.installLaborRate : COST_INSTALL_LABOR_RATE_DEFAULT) +
    '"' +
    ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
    ' onchange="updatePricingConfig(' +
    projId +
    ",'installLaborRate',parseFloat(this.value))\">" +
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
   fix/phase-cost-budget-model) ────────────────────────────────────────────────────────────────
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

   Row/building assignment rule: buildRecommendedRows() emits rows building-by-building in a
   stable "natural/source" rollout order (see the 0ae36950 comment above that function). This
   walks buildings in that order and cuts into 3 CONTIGUOUS groups by cumulative MEASURES dollars,
   advancing to the next phase once the running measures total crosses that phase's OWN
   allowanceTotal share (task: "assign measures per phase against that phase's own budget envelope
   rather than slicing one flat total into thirds") — Phase 1's smaller 5-month/$31,250 envelope
   fills first, then Phase 2's larger $75,000 envelope, etc. When no budget is configured
   (allowanceTotal unavailable for any phase), falls back to an even 1/3-of-measures-grand split
   (the pre-existing behavior) so the timeline still renders something coherent.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingComputeRecommendedTimeline(projId) {
  var estimate = _pricingGetEstimate(projId);
  var rows = buildRecommendedRows(projId);
  rows = _pricingApplyLaborOverrides(projId, rows);
  rows = _pricingApplyQtyOverrides(projId, rows);
  if (!rows.length) return null;

  var grandTotals = _pricingComputeTotals(rows, estimate);
  if (grandTotals.grand === null) return null; // nothing priced yet — same silent-until-priced convention as the rest of this file

  var order = [];
  var byBldg = {};
  rows.forEach(function (r) {
    var b = r.building || '(Unassigned)';
    if (!byBldg[b]) {
      byBldg[b] = [];
      order.push(b);
    }
    byBldg[b].push(r);
  });

  var bldgInfo = order.map(function (b) {
    var t = _pricingComputeTotals(byBldg[b], estimate);
    return { building: b, rows: byBldg[b], total: t.grand || 0 };
  });

  var grand = grandTotals.grand;
  var defs = _pricingPhaseDateDefs();
  var costModel = _pricingComputeProgramCostModel(projId); // null when no budget.amount configured

  // Cumulative cutpoints buildings are measured against while walking rollout order. Uses each
  // phase's OWN envelope for MEASURES specifically — measuresAvailable (the calendar allowance
  // net of that phase's own EM labor cost), not the gross allowanceTotal — when a budget is
  // configured, since allowanceTotal includes dollars already committed to EM labor and is not
  // itself an envelope for hardware/programming measures (task item 2: "assign measures per phase
  // against that phase's own budget envelope"). Otherwise falls back to an even
  // 1/3-of-measures-grand split (pre-existing behavior, still needed for the no-budget case).
  var phaseShare = defs.map(function (d, i) {
    return costModel ? costModel.phases[i].measuresAvailable : grand / 3;
  });
  var cumCutpoint = [];
  phaseShare.reduce(function (running, share, i) {
    cumCutpoint[i] = running + share;
    return cumCutpoint[i];
  }, 0);

  var phases = [
    { rows: [], buildings: [], total: 0 },
    { rows: [], buildings: [], total: 0 },
    { rows: [], buildings: [], total: 0 },
  ];
  var running = 0;
  var phaseIdx = 0;
  bldgInfo.forEach(function (b) {
    // Advance once the RUNNING measures total (before this building) has already crossed that
    // phase's own cumulative allowance/measures-share cutpoint — keeps each phase's building
    // group contiguous in rollout order.
    if (phaseIdx < 2 && cumCutpoint[phaseIdx] > 0 && running >= cumCutpoint[phaseIdx]) phaseIdx++;
    phases[phaseIdx].rows = phases[phaseIdx].rows.concat(b.rows);
    phases[phaseIdx].buildings.push(b.building);
    phases[phaseIdx].total += b.total;
    running += b.total;
  });

  var out = phases.map(function (p, i) {
    var cm = costModel ? costModel.phases[i] : null;
    return {
      label: defs[i].label,
      dateRange: defs[i].dateRange,
      months: defs[i].months,
      buildings: p.buildings,
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
      overCommitted: cm ? cm.overCommitted : false,
    };
  });

  var sumMeasures = out.reduce(function (s, p) {
    return s + p.measuresTotal;
  }, 0);
  var drift = Math.round((grand - sumMeasures) * 100) / 100;
  if (drift !== 0) {
    for (var i = out.length - 1; i >= 0; i--) {
      if (out[i].buildings.length) {
        out[i].measuresTotal = Math.round((out[i].measuresTotal + drift) * 100) / 100;
        break;
      }
    }
  }

  return {
    phases: out,
    measuresGrandTotal: grand, // renamed from `grandTotal` 2026-07-26 — the priced-measures total (old $74,826-style figure)
    programAllowanceTotal: costModel ? costModel.programAllowanceTotal : null, // NEW headline figure — sum of calendar phase costs (e.g. $181,250)
    programEmLaborTotal: costModel ? costModel.programEmLaborTotal : null,
    programMonths: _pricingRecommendedProgramMonths(),
    monthlyAllowance: costModel ? costModel.monthlyAllowance : null,
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
      var scope = p.buildings.length
        ? p.buildings.length +
          ' building' +
          (p.buildings.length !== 1 ? 's' : '') +
          ': ' +
          p.buildings.map(_pricingEscText).join(', ')
        : 'No additional scope';
      var allowanceCell = hasBudget
        ? _pricingFmt(p.allowanceTotal)
        : _pricingFmt(p.measuresTotal) +
          ' <span style="font-weight:400;color:var(--text3);font-size:10px">(no budget configured)</span>';
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
        ';text-align:right;color:var(--text2)">' +
        _pricingFmt(p.measuresTotal) +
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
    var anyOverCommitted = tl.phases.some(function (p) {
      return p.overCommitted;
    });
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
      (anyOverCommitted
        ? ' <span style="color:var(--warn);font-weight:700">Note: EM labor alone exceeds the calendar allowance in at least one phase.</span>'
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
    // already used to compute unitPrice/lineTotal upstream). Phase-2 labor rows show the
    // programming rate; Phase-1 hardware rows show the install rate (Deliverable E) — both read-
    // only for the same reason. ioOnly rows show the same em-dash placeholder as non-priced rows.
    var rateContent = '<span style="color:var(--text3)">—</span>';
    if (row.phase === 2 && row.seqKey) {
      var _rowRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
      rateContent =
        '<span style="font-size:11px">' +
        _pricingFmt(_rowRate) +
        '<span style="font-size:10px;color:var(--text3)">/hr</span></span>';
    } else if (row.phase === 1 && !row.ioOnly && row._pointKey) {
      var _instRowRate =
        row.installLaborRate != null ? row.installLaborRate : cfg.installLaborRate || COST_INSTALL_LABOR_RATE_DEFAULT;
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
            html: renderMergedRow(row, pairedSeq, isBothMode, matchedRec, hidden),
          });
        } else {
          _flatItems.push({ score: _pricingEquipRowScore(row), html: renderRow(row, isBothMode, matchedRec, hidden) });
        }
      });
      lb.forEach(function (row) {
        if (claimedSeqIds[row.id]) return; // already rendered combined with its paired hw row
        _flatItems.push({ score: _pricingEquipRowScore(row), html: renderRow(row, isBothMode, null, hidden) });
      });
    });
    _flatItems.sort(function (a, b) {
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
