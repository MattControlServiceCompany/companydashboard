/* ── ASHRAE-36 Pricing & Cost-Estimator — Phase 1 + Phase 2 (Compliance Tier)
   Spec: 2026-06-18-ashrae36-pricing-cost-estimator-SPEC.md
   Storage keys:
     en_pricing_catalog        — global SKU→{list,net,contract,computed_net,category,desc}
     en_pricing_meta           — global {importedAt,filename,skuCount}
     en_pricing_config         — global {netMultiplier,contractPct,hourlyRate,priceBasis,perSequenceHours}
     en_pricing_estimate_{id}  — per-project {rowToggles,manualPrices,laborOverrides,tier}
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
    source: '[G36-2021]',
    sourceType: SAVINGS_SOURCE_ENGINEERING,
  },
  demandCtrl: {
    tier: 'med-high',
    type: 'savings',
    weight: 2.5,
    nominalCostTier: 2,
    savingsRationale:
      'CO2-based demand-controlled ventilation (AHU duct level) reduces outdoor air delivery during ' +
      'lower-occupancy periods, cutting heating and cooling energy. National average: 2.6% total site ' +
      'energy savings; 8.8% heating gas savings in applicable commercial buildings. [NREL-DCV-2023, OSTI 2284042]. ' +
      'Note: 2.6% is a commercial-office stock average; verify applicability to institutional/detention occupancy.',
    source: '[NREL-DCV-2023]',
    sourceType: SAVINGS_SOURCE_LITERATURE,
  },
  vav_dcv: {
    tier: 'med-high',
    type: 'savings',
    weight: 2.5,
    nominalCostTier: 2,
    savingsRationale:
      'CO2-based demand-controlled ventilation (zone level — needs zone CO2 sensors) reduces outdoor air ' +
      'per zone during lower-occupancy periods. Same national average basis as AHU-level DCV: 2.6% total site ' +
      'energy savings in applicable buildings. [NREL-DCV-2023, OSTI 2284042]. ' +
      'Note: verify applicability to institutional/detention occupancy patterns.',
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

/* ── Top-ROI callout card (correction #12)
   Criteria: HIGH or MED-HIGH tier AND effectiveCostTier <= 2 AND not enabler AND not safety AND >= 1 instance
   Shows 2-4 items; hidden if < 2.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingTopRoiCallout(projId, recRows) {
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
  // Limit to 4
  unique = unique.slice(0, 4);
  if (unique.length < 2) return '';

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
        (r.savingsRationale || '').slice(0, 160) +
        (r.savingsRationale && r.savingsRationale.length > 160 ? '…' : '') +
        '</div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  var _roiChevronId = 'roi-chevron-' + projId;
  return (
    '<details open style="margin:10px 14px 0;border:1px solid var(--border2);border-radius:6px;' +
    'background:var(--s3);overflow:hidden"' +
    ' ontoggle="(function(d){var c=document.getElementById(\'' +
    _roiChevronId +
    "');if(c)c.textContent=d.open?'▼':'▶';})(this)\">" +
    '<summary style="padding:8px 12px;font-size:11px;font-weight:700;color:var(--text);' +
    'cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;' +
    'background:var(--s2);border-bottom:1px solid var(--border2)">' +
    '<span id="' +
    _roiChevronId +
    '" style="font-size:10px;color:var(--text2);flex-shrink:0">▼</span>' +
    '★ Top ROI Measures for This Project' +
    '<span style="font-size:10px;font-weight:400;color:var(--text2);margin-left:4px">' +
    '(highest savings per dollar based on current point coverage — full list below)</span>' +
    '</summary>' +
    '<div style="padding:4px 12px 8px">' +
    '<div style="font-size:10px;color:var(--text3);margin-bottom:6px;margin-top:4px">' +
    ORNL_CONTEXT_SENTENCE +
    '</div>' +
    itemsHTML +
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
    whyNeeded:
      'Without a supply air temperature sensor, the system cannot adjust how warm or cold it delivers air based on outdoor conditions — one of the primary ways ASHRAE 36 sequences cut heating and cooling costs.',
    g36Section: '§5.16.1',
  },
  rat: {
    defaultSku: 'N1-10K-2-D-8-BB-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSB duct temp, 8" probe — verify probe length',
    whyNeeded:
      'Measures the temperature of air returning from occupied spaces, giving the system feedback to verify how effectively it is conditioning the building and enabling economizer control.',
    g36Section: '§5.16.1',
  },
  mat: {
    defaultSku: 'N1-10K-2-D-8-BB-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSB duct temp, 8" probe — verify probe length',
    whyNeeded:
      'Required for economizer control — without it, the system cannot determine when outdoor air is cool enough to replace mechanical cooling at no operating cost.',
    g36Section: '§5.16.2',
  },
  oat: {
    defaultSku: 'N1-10K-2-D-12-WP-A',
    qtyRule: 'perBuilding', // de-dup: 1 per building
    flags: ['engReview'],
    note: 'Weatherproof OAT — 1 per building',
    whyNeeded:
      'Nearly every ASHRAE 36 energy-saving sequence depends on outdoor temperature. Without a reliable reading, the system cannot adapt supply air setpoints, economizer lockout, or boiler/chiller reset to changing weather.',
    g36Section: '§5.1',
  },
  dsp: {
    defaultSku: 'N1-ZPS-LR-EZ-NT-IN-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Low-range duct static pressure — verify range',
    whyNeeded:
      'Enables variable fan speed control. When duct pressure is measured and reset based on actual zone demand, fan energy drops 15–30% compared to fixed-speed operation.',
    g36Section: '§5.16.5',
  },
  co2_ahu: {
    defaultSku: 'N1-DCD10-D-BB-LED-A',
    qtyRule: 'perUnit',
    flags: [],
    note: 'AHU duct CO2 sensor',
    whyNeeded:
      'Enables demand-controlled ventilation — the system reduces outdoor air (and the energy to condition it) when rooms are partially or fully empty, saving 5–10% of fan and cooling energy.',
    g36Section: '§5.16.7',
  },
  /* ── VAV/FPB sensors ── */
  dat: {
    defaultSku: 'N1-10K-2-D-4-BB-A',
    qtyRule: 'perUnit',
    flags: [],
    note: '4" duct temp probe',
    whyNeeded:
      'Monitors the temperature of air actually delivered to the space, enabling precise reheat control and preventing overcooling at minimum airflow.',
    g36Section: '§5.6.1',
  },
  /* ── Plant/CT sensors ── */
  hwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Primary feedback for boiler control. Required for the outdoor reset strategy that lowers water temperature — and heating costs — as outdoor air warms.',
    g36Section: '§5.20.1',
  },
  hwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Measures the temperature drop across the heating system. Low temperature drop signals pump, balancing, or coil problems that raise operating costs.',
    g36Section: '§5.20.1',
  },
  chwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Verifies chiller output and enables the setpoint reset strategy that improves chiller efficiency during mild weather.',
    g36Section: '§5.22.1',
  },
  chwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Measures how fully the chilled water is utilized. Poor utilization causes the chiller to over-cycle and consume excess energy.',
    g36Section: '§5.22.1',
  },
  cwst: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Required for cooling tower and chiller coordination, including the condenser water reset strategy that improves chiller efficiency during cooler weather.',
    g36Section: '§5.24.1',
  },
  cwrt: {
    defaultSku: 'N1-10K-2-I-2-BB-M304-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'Immersion w/ 304SS thermowell',
    whyNeeded:
      'Measures the condenser water temperature rise across the tower, confirming heat rejection and flagging tower performance problems.',
    g36Section: '§5.24.1',
  },
  hwdp: {
    defaultSku: 'N2-A/WPR2-30-M20-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSA wet DP 0-30 PSID — verify range',
    whyNeeded:
      'Allows the pump to slow when fewer zones call for heat rather than running at full design speed regardless of load — saves 10–20% of pump energy.',
    g36Section: '§5.20.3',
  },
  chwdp: {
    defaultSku: 'N2-A/WPR2-30-M20-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'NSA wet DP 0-30 PSID — verify range',
    whyNeeded:
      'Allows chilled water pumps to slow during light loads. Pump energy drops sharply with speed, yielding 10–20% savings during the many partial-load hours typical in commercial buildings.',
    g36Section: '§5.22.3',
  },
  oaWetBulb: {
    defaultSku: 'N1-10K-2-H200-O-BB-A',
    qtyRule: 'perBuilding',
    flags: ['engReview'],
    note: 'OA humidity+temp combo — 1 per building',
    whyNeeded:
      'Measures outdoor temperature and humidity together, enabling the most accurate method (differential enthalpy) for deciding when outdoor air is suitable for free cooling.',
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
      'The primary feedback signal for zone control. Without it, the terminal unit cannot modulate airflow to meet setpoints and there is no way to verify the space is comfortable.',
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
    note: 'Zone CO2+temp combo — replaces separate zoneTemp+CO2 if both missing',
    whyNeeded:
      'Tracks occupancy through air quality, allowing the zone to reduce outdoor air — and the energy to condition it — when rooms are partially or fully empty.',
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
      'Controls how much outdoor air enters for free cooling and ventilation. Without BAS control of the OA damper, economizer sequences and minimum ventilation compliance are not possible.',
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
      'Works with the OA damper to maintain airflow balance during economizer operation. Without it, the AHU cannot prevent over-pressurization when outdoor air increases.',
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
      'Required to verify each zone damper is responding correctly to temperature setpoints. Without this feedback in the BAS, a stuck or failed actuator cannot be detected until occupants complain.',
    whyNotHardware:
      'Damper actuator is integral to the VVT/terminal box and commanded over the internal bus — a missing damper command is a BACnet point-exposure / programming task, not new hardware. Add an actuator SKU only if field inspection finds a pneumatic or failed actuator.',
    g36Section: '§5.6',
  },
  coldDampCmd: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['ioOnly'],
    note: 'Phase 2 programming — not new hardware for dual-duct VVT/integral-actuator boxes',
    whyNeeded:
      'Controls cool air delivery in a dual-duct system. Without BAS visibility of this command, cooling cannot be modulated or verified to prevent simultaneous heating and cooling.',
    whyNotHardware:
      'Damper actuator is integral to the VVT/terminal box and commanded over the internal bus — a missing damper command is a BACnet point-exposure / programming task, not new hardware. Add an actuator SKU only if field inspection finds a pneumatic or failed actuator.',
    g36Section: '§5.6',
  },
  hotDampCmd: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['ioOnly'],
    note: 'Phase 2 programming — not new hardware for dual-duct VVT/integral-actuator boxes',
    whyNeeded:
      'Controls warm air delivery in a dual-duct system. Both hot and cold deck dampers must be controlled together to prevent simultaneous heating and cooling waste.',
    whyNotHardware:
      'Damper actuator is integral to the VVT/terminal box and commanded over the internal bus — a missing damper command is a BACnet point-exposure / programming task, not new hardware. Add an actuator SKU only if field inspection finds a pneumatic or failed actuator.',
    g36Section: '§5.6',
  },
  /* ── Plant valve actuators ── */
  chwIsoValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Controls chilled water flow isolation to individual chillers; required for safe staging, lead/lag rotation, and preventing flow through a non-operating chiller.',
    g36Section: '§5.22',
  },
  cwIsoValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Controls condenser water flow isolation to individual cooling towers; required for safe tower staging and preventing recirculation through an idle tower.',
    g36Section: '§5.24',
  },
  makeupValveCmd: {
    defaultSku: 'AMB24-MFT-06-A',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '180 in-lb non-fail-safe',
    whyNeeded:
      'Controls cooling tower makeup water flow automatically; without it, tower basin level must be managed manually and there is no BAS alarm for low water.',
    g36Section: '§5.24',
  },
  /* ── Coil valves (ENG-REVIEW — spec §3, §4 optimizer must skip) ── */
  clgValve: {
    defaultSku: 'B214+TFRB-3-06-A', // VERIFIED in catalog (Cv7.4 spring-return)
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.75" 2-way Cv7.4 spring-return — ENG-REVIEW: verify Cv and pipe size',
    whyNeeded:
      'Controls chilled water flow through the AHU cooling coil. Required for supply air temperature reset and for coordinating mechanical cooling with the economizer — both core ASHRAE 36 sequences.',
    g36Section: '§5.16.3',
  },
  htgValve: {
    defaultSku: 'B214+TFRB-3-06-A', // VERIFIED in catalog
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.75" 2-way Cv7.4 spring-return — ENG-REVIEW: verify Cv and pipe size',
    whyNeeded:
      'Controls hot water flow through the AHU heating coil. Required for morning warm-up, freeze protection, and cold-weather supply air temperature control.',
    g36Section: '§5.16.3',
  },
  reheatValve: {
    defaultSku: 'B209+TFRB-3-06-A', // VERIFIED in catalog
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: '0.5" Cv0.8 spring-return — ENG-REVIEW: verify Cv',
    whyNeeded:
      'Controls hot water flow through the terminal reheat coil. Without it, zone heating must come entirely from the primary air system, reducing efficiency and occupant comfort.',
    g36Section: '§5.6.4',
  },
  /* ── VAV zone controller (discFlow/primaryFlow maps to controller, not sensor) ── */
  discFlow: {
    defaultSku: 'OF253A-E2',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'VAV zone controller w/ integral flow — ENG-REVIEW: verify if controller replacement or reprogramming only',
    whyNeeded:
      'Measures airflow delivered to each zone, confirming minimum ventilation rates and enabling the duct static pressure reset sequence that cuts fan energy by 15–25%.',
    g36Section: '§5.6.2',
  },
  primaryFlow: {
    defaultSku: 'OF253A-E2',
    qtyRule: 'perUnit',
    flags: ['engReview'],
    note: 'FPB zone controller w/ integral flow — ENG-REVIEW: verify if controller replacement or reprogramming only',
    whyNeeded:
      'Measures how much cold primary air the fan-powered box receives from the air handler, driving damper position and determining when the local fan should run.',
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
      'Signals the control system when coil temperatures approach freezing so the air handler shuts down before water coils are damaged — a critical life-safety interlock.',
    g36Section: '§5.16.6',
  },
  oaFlow: {
    defaultSku: null,
    qtyRule: 'perUnit',
    flags: ['noSku'],
    note: 'OA flow station — enter price (~$1,200 typical)',
    whyNeeded:
      'Measures actual outdoor air volume entering the unit. Without it, there is no way to confirm code-required minimum ventilation rates are met, and the duct static pressure reset sequence cannot be verified.',
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
      qtyOverrides: {},
      noteOverrides: {},
      tier: 'compliance',
    }
  );
}
function _pricingSetEstimate(projId, est) {
  sset('en_pricing_estimate_' + projId, est);
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
function buildComplianceRows(projId) {
  if (typeof collectASHRAE36Data !== 'function') return [];
  var ashData = collectASHRAE36Data(projId);
  if (!ashData || !ashData.buildings) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var estimate = _pricingGetEstimate(projId);
  var rows = [];
  var rowIdx = 0;

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
    co2_zone: 'CO2 (Zone)',
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
  if (mapEntry.flags.indexOf('ioOnly') !== -1) return 'IO Only';
  if (mapEntry.flags.indexOf('noSku') !== -1) return 'Manual';
  // Categorize by SKU prefix / point type
  var sku = mapEntry.defaultSku || '';
  // Distinguish ZS2 variants: ZS2-HC-ALC is combo CO2+temp; ZS2-ALC is temp-only
  if (sku === 'ZS2-HC-ALC') return 'CO2/Zone';
  if (sku === 'ZS2-ALC') return 'Zone Temp';
  if (sku.startsWith('ZS2')) return 'CO2/Zone'; // catch-all for future ZS2 variants
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
      price = isNaN(manual) || manual === 0 ? null : manual * row.qty;
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
      unitPriceCell = '<span style="color:var(--text3);font-size:10px">$0 (I/O)</span>';
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
        (row.ioOnly ? ' title="Controller I/O — no cost"' : '') +
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
   Produces the row list for the Recommended tier.
   Recommended = best-ROI curated SUBSET of Compliance. Always <= Compliance cost.
   Differences from Compliance:
     1. Optimizer substitutes lowest-price qualifying SKU for safe classes
     2. COMBO de-dup: zone missing both zoneTemp+co2 → single ZS2-HC-ALC line
        (identical to compliance combo, but note says "Combo: replaces separate…")
     3. Phase-2 savings-impact filter: keep only rows where savingsImpact is
        'high', 'med-high', or 'med'. Drops 'low-med', 'enabler', 'safety', null.
     4. SKIP list: curated default kept + engReview preserved
     5. NO add-ons — FDD add-on moved to buildFullScopeRows
   Tier ordering: Recommended <= Compliance <= Full Scope (structural guarantee).
   ─────────────────────────────────────────────────────────────────────────── */
function buildRecommendedRows(projId) {
  // Start from compliance rows as foundation, then apply optimizer + add-ons
  var compRows = buildComplianceRows(projId);
  if (!compRows.length) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var estimate = _pricingGetEstimate(projId);

  var recRows = [];
  var _optimizerSubCount = 0; // Bug A: track substitutions made

  // Process each compliance row and apply optimizer or skip
  compRows.forEach(function (row) {
    // Clone the row so compliance rows are unaffected
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
          rec.unitPrice = cheaper.unitPrice;
          rec.lineTotal = rec.qty > 0 ? parseFloat((cheaper.unitPrice * rec.qty).toFixed(2)) : null;
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

    // Fix 3: store the compliance row id as _baseId BEFORE re-keying,
    // so toggle state (keyed by compliance ids) is shared between tiers.
    rec._baseId = row.id;

    // Re-key the row ID so it's distinct from the compliance row ID
    rec.id = rec.id.replace(/^hw_/, 'rch_').replace(/^seq_/, 'rcs_');

    // ── Phase 5: stamp savings impact fields onto phase-2 sequence rows ──
    if (rec.phase === 2 && rec.seqKey) {
      var impactDef = SEQUENCE_SAVINGS_IMPACT[rec.seqKey];
      if (impactDef) {
        rec.savingsImpact = impactDef.tier;
        rec.savingsRationale = impactDef.savingsRationale;
        rec.savingsSource = impactDef.source;
        rec.sourceType = impactDef.sourceType;
        rec._savingsWeight = impactDef.weight;
        rec._enablesLabel = impactDef.enablesLabel || null;

        // Dynamic effectiveCostTier: if all blocking sensors for this sequence are
        // already covered in the equipment matrix → effectiveCostTier=1 (programming only).
        // We approximate "covered" by checking if phase-1 hardware rows for those sensors
        // exist in compRows (i.e., they AREN'T in the gap list — gaps = missing sensors).
        // Since buildComplianceRows only adds rows for MISSING points, if a blocking sensor
        // key has NO row in compRows for this building, it is already covered.
        var blocking = SEQUENCE_BLOCKING_SENSORS[rec.seqKey] || [];
        var nominalTier = impactDef.nominalCostTier || 2;
        if (blocking.length === 0) {
          // No blocking sensors — programming only
          rec._effectiveCostTier = 1;
        } else {
          // Check if any blocking sensor is still a gap (has a phase-1 row in compRows for this building)
          var gapPointKeys = {};
          compRows.forEach(function (cr) {
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

    // Phase-2 savings-impact filter: Recommended only keeps high/med-high/med sequences.
    // Drop 'low-med', 'enabler', 'safety', and null-impact phase-2 rows.
    // Phase-1 hardware rows are all kept (optimizer already reduces their cost;
    // conservative approach per blueprint Risk 2 — phase-1 seqKey mapping not stamped).
    if (rec.phase === 2) {
      var _keepTiers = { high: true, 'med-high': true, med: true };
      if (!_keepTiers[rec.savingsImpact]) {
        return; // skip this row — drop low-ROI, enabler, safety, and null-impact sequences
      }
    }

    recRows.push(rec);
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

/* ── buildFullScopeRows(projId) ─────────────────────────────────────────────
   Produces the row list for the Full Scope tier.
   Full Scope = Compliance + all add-ons (FDD reporting, future add-ons).
   Row IDs: fsc_ prefix (phase 1), fsl_ prefix (phase 2).
   Each row carries _baseId = compliance row id so toggle state transfers.
   Ordering: Full Scope >= Compliance >= Recommended (structural guarantee).
   ─────────────────────────────────────────────────────────────────────────── */
function buildFullScopeRows(projId) {
  var compRows = buildComplianceRows(projId);
  if (!compRows.length) return [];

  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var fsRows = [];
  var rowIdx = 20000; // offset to avoid ID collision with compliance + recommended rows

  // Clone all compliance rows with fsc_/fsl_ ID prefix and _baseId linkage
  compRows.forEach(function (row) {
    var fs = Object.assign({}, row);
    // Store compliance row id for shared toggle state
    fs._baseId = row.id;
    // Re-key the row ID with full-scope prefix
    fs.id = fs.id.replace(/^hw_/, 'fsc_').replace(/^seq_/, 'fsl_');
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
   Order (left→right, cost-ascending): Recommended | Compliance | Full Scope | Compare
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
    '<div style="display:flex;gap:4px;align-items:center">' +
    '<span style="font-size:11px;color:var(--text2);margin-right:2px">Tier:</span>' +
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

/* ── Column definitions (indices 0-12 for 13-col default layout)
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
   col 10: Line Total — sortable (numeric) — driven by basis selector
   col 11: Impact — no-sort — Phase 5 savings badge
   col 12: Notes — sortable
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
  { label: 'Contract (40%)', noSort: false, noHide: false, numeric: true, minWidth: 90 }, // 9
  { label: 'Line Total', noSort: false, noHide: false, numeric: true, minWidth: 80 }, // 10 — label overridden at render time with active basis
  {
    label: 'Impact',
    noSort: true,
    noHide: false,
    numeric: false,
    minWidth: 80, // 11 — Phase 5 savings badge
    isImpactCol: true,
  },
  { label: 'Notes', noSort: false, noHide: false, numeric: false, minWidth: 80 }, // 12
];

/* ── Apply labor overrides to a cloned row list ──────────────────────────── */
function _pricingApplyLaborOverrides(projId, rows) {
  var est = _pricingGetEstimate(projId);
  var overrides = est.laborOverrides || {};
  var cfg = _pricingGetConfig();
  var hourlyRate = cfg.hourlyRate || COST_LABOR_RATE_DEFAULT;
  return rows.map(function (row) {
    if (row.phase !== 2 || !row.seqKey) return row;
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
      return row.lineTotal != null ? row.lineTotal : -1;
    case 12:
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

/* ── Close col-visibility popover when clicking outside ─────────────────── */
function _pricingCloseColPopover(projId) {
  var pop = document.getElementById('pricing-col-popover-' + projId);
  if (pop) pop.remove();
}

/* ── Toggle col-visibility popover ─────────────────────────────────────────
   Opens a small checklist of columns below the gear icon.
   ─────────────────────────────────────────────────────────────────────────── */
function _pricingToggleColPopover(projId, gearBtn) {
  // Close any open popover first
  _pricingCloseColPopover(projId);

  var pop = document.createElement('div');
  pop.id = 'pricing-col-popover-' + projId;
  pop.style.cssText = [
    'position:absolute',
    'background:var(--s2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:8px 10px',
    'z-index:800',
    'min-width:160px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'font-size:11px',
  ].join(';');

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
  pop.innerHTML = html;

  // Position relative to gear button
  var rect = gearBtn.getBoundingClientRect();
  var container = document.getElementById('ptab-cost-estimate-body-' + projId);
  if (container) {
    var cRect = container.getBoundingClientRect();
    pop.style.top = rect.bottom - cRect.top + 4 + 'px';
    pop.style.right = '4px';
    pop.style.position = 'absolute';
    container.style.position = 'relative';
    container.appendChild(pop);
  }

  // Close on outside click
  setTimeout(function () {
    document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target) && e.target !== gearBtn) {
        _pricingCloseColPopover(projId);
        document.removeEventListener('click', handler);
      }
    });
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

  // ── 1. Get state
  var estimate = _pricingGetEstimate(projId);
  var tier = estimate.tier || 'compliance';
  var hidden = _pricingGetHiddenCols(projId);
  var sortState = _pricingSortState[projId] || { col: null, dir: null };
  var filterBldg = _pricingBldgFilter[projId] || '';

  // ── 2. Build base rows (Phase 3 row builder)
  var catalog = sget('en_pricing_catalog', null);
  var cfg = _pricingGetConfig();
  var hasCatalog = !!(catalog && Object.keys(catalog).length > 0);

  // Issue 4 fix: auto-hide Impact column (col 11) when tier cannot produce impact badges.
  // savingsImpact is only stamped on Recommended/Both phase-2 rows; Compliance/Full Scope blank.
  // We clone the hidden array so we don't mutate the user's saved preferences.
  var _tierHasImpact = tier === 'recommended' || tier === 'both';
  if (!_tierHasImpact && hidden.indexOf(11) === -1) {
    hidden = hidden.concat([11]);
  }
  var meta = sget('en_pricing_meta', null);

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

  // ── 7. Build toolbar HTML (extends Phase 3 toolbar with building filter)
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

  // Building filter dropdown
  var bldgFilterHTML =
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">' +
    'Building:' +
    '<select onchange="_pricingBldgFilterChange(\'' +
    projId +
    '\',this.value)"' +
    ' style="font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px">' +
    '<option value=""' +
    (!filterBldg ? ' selected' : '') +
    '>All Buildings</option>' +
    allBuildings
      .map(function (b) {
        return '<option value="' + _esc(b) + '"' + (filterBldg === b ? ' selected' : '') + '>' + _esc(b) + '</option>';
      })
      .join('') +
    '</select></label>';

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
    // Tier toggle
    _pricingTierToggleHTML(projId, tier),
    '<span style="color:var(--border2)">|</span>',
    bldgFilterHTML,
    '<span style="color:var(--border2)">|</span>',
    // Price Basis
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
    '</select></label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Net ×:',
    '<input type="number" id="pricing-net-mult-' +
      projId +
      '" min="0.01" max="1.0" step="0.01" value="' +
      cfg.netMultiplier +
      '"' +
      ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
      ' onchange="updatePricingConfig(' +
      projId +
      ",'netMultiplier',parseFloat(this.value))\">",
    '</label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Contract %:',
    '<input type="number" id="pricing-contract-pct-' +
      projId +
      '" min="1" max="100" step="1" value="' +
      Math.round(cfg.contractPct * 100) +
      '"' +
      ' style="width:44px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
      ' onchange="updatePricingConfig(' +
      projId +
      ",'contractPct',parseFloat(this.value)/100)\">",
    '</label>',
    '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">',
    'Hourly Rate:',
    '<input type="number" id="pricing-rate-' +
      projId +
      '" min="1" max="999" step="1" value="' +
      cfg.hourlyRate +
      '"' +
      ' style="width:52px;font-size:11px;padding:2px 6px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px"' +
      ' onchange="updatePricingConfig(' +
      projId +
      ",'hourlyRate',parseFloat(this.value))\">",
    '</label>',
    // Step 5: fan fraction field — only shown when Recommended tier is active
    tier === 'recommended' || tier === 'both'
      ? '<span style="color:var(--border2)">|</span>' +
        '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px" ' +
        'title="Fan energy as % of total electricity (CBECS VAV typical range 10–20%); used for DSP/SAT reset savings estimates">' +
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
        '</label>'
      : '',
    '</div>',
  ].join('');

  // ── 8. Render row function (Phase 4: adds hours-override input for labor rows)
  var recRowIdxByBase = isBothMode ? _buildBothModeIndex(recRows || []) : {};

  function renderRow(row, isBothMd, matchedRecRow, hiddenCols) {
    var toggleKey = row._baseId || row.id;
    var toggleOn = estimate.rowToggles[toggleKey] !== false;
    var manualVal = estimate.manualPrices[toggleKey] || '';
    var laborOverrides = estimate.laborOverrides || {};

    // Build per-column cell content
    var cells = [];

    // col 0: Include
    cells.push(
      '<input type="checkbox"' +
        (toggleOn ? ' checked' : '') +
        (row.ioOnly ? ' title="Controller I/O — no cost"' : '') +
        ' onchange="_pricingToggleRow(\'' +
        projId +
        "','" +
        toggleKey +
        '\',this.checked)"' +
        ' style="cursor:pointer">',
    );

    // col 1: Building
    cells.push('<span style="font-size:11px">' + _esc(row.building) + '</span>');

    // col 2: Item
    cells.push('<span style="font-size:11px">' + _esc(row.item) + '</span>');

    // col 3: Type
    cells.push('<span style="font-size:10px;color:var(--text2)">' + _esc(row.type) + '</span>');

    // col 4: Equipment
    cells.push('<span style="font-size:10px;color:var(--text2)">' + _esc(row.equipment) + '</span>');

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
        ' style="width:44px;font-size:11px;padding:2px 4px;background:var(--s3);color:var(--text);border:1px solid ' +
        (_qtyIsOverridden ? 'var(--accent)' : 'var(--border)') +
        ';border-radius:4px;text-align:right;font-variant-numeric:tabular-nums"' +
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

    // col 9: Contract (40%) — for Phase 2 rows, show editable hours input here
    var contractContent = '';
    if (row.ioOnly) {
      contractContent = '<span style="color:var(--text3);font-size:10px">$0 (I/O)</span>';
    } else if (row.phase === 2 && row.seqKey) {
      // Per-sequence labor-hour override input (Phase 4) — shown in Contract column
      var defaultHrs = COST_PER_SEQ_HOURS_DEFAULT[row.seqKey] != null ? COST_PER_SEQ_HOURS_DEFAULT[row.seqKey] : 2.0;
      var currentHrs = laborOverrides[row.seqKey] != null ? parseFloat(laborOverrides[row.seqKey]) : row.hrsPerUnit;
      var isOverridden = laborOverrides[row.seqKey] != null;
      contractContent =
        '<div style="display:flex;align-items:center;gap:4px">' +
        '<input type="number" min="0" step="0.25" value="' +
        currentHrs +
        '"' +
        ' title="Hours per instance (default: ' +
        defaultHrs +
        ')"' +
        ' style="width:52px;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid ' +
        (isOverridden ? 'var(--accent)' : 'var(--border)') +
        ';border-radius:4px;text-align:right;font-variant-numeric:tabular-nums"' +
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
    } else if (row.phase === 2) {
      contractContent = row.unitPrice !== null ? _pricingFmt(row.unitPrice) : '—';
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
          ' style="width:100%;box-sizing:border-box;font-size:11px;padding:2px 5px;background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:4px;text-align:right"' +
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

    // col 10: Line Total
    var lineTotalContent = '';
    if (row.ioOnly) {
      lineTotalContent = '<span style="color:var(--text3);font-size:10px">$0</span>';
    } else if (row.noSku) {
      var mv = parseFloat(estimate.manualPrices[toggleKey] || 0);
      var lt = isNaN(mv) ? null : mv * row.qty;
      lineTotalContent =
        lt !== null && lt > 0 ? _pricingFmt(lt) : '<span style="color:var(--warn);font-size:10px">⚠ Enter price</span>';
    } else {
      lineTotalContent =
        row.lineTotal !== null
          ? '<span' + (!toggleOn ? ' style="color:var(--text3)"' : '') + '>' + _pricingFmt(row.lineTotal) + '</span>'
          : '<span style="color:var(--text3)">—</span>';
    }
    cells.push(lineTotalContent);

    // col 11: Impact — badge chip for Recommended tier phase-2 rows only (correction #4 / Phase 5)
    // Fuller-preference rule: badge LEADS but full rationale stays visible in Notes (col 12).
    var impactCellContent = '';
    if (tier === 'recommended' && row.phase === 2 && row.savingsImpact) {
      impactCellContent = _a36ImpactChip(row);
    }
    cells.push(impactCellContent);

    // col 12: Notes — visible text = note + G36 § + (Recommended) full savingsRationale sentence
    // Fuller-preference: full rationale visible in cell, never hover-only (correction from REVIEW).
    var _noteText12 = row.note || '';
    if (row.g36Section) _noteText12 += (_noteText12 ? ' \xb7 ' : '') + row.g36Section;

    // For Recommended tier phase-2 rows: append full rationale sentence (visible, not hover-only)
    // savingsRationale already contains all warnings (reheat note, boiler-type warning) — no appends needed.
    var _rationaleText = '';
    if (tier === 'recommended' && row.phase === 2 && row.savingsRationale) {
      _rationaleText = row.savingsRationale;
    }

    // Step 5: $ savings range line (Recommended tier, phase-2 savings sequences only)
    var _savingsRangeHTML = '';
    if (
      (tier === 'recommended' || tier === 'both') &&
      row.phase === 2 &&
      row.seqKey &&
      row.savingsImpact &&
      row.savingsImpact !== 'enabler' &&
      row.savingsImpact !== 'safety'
    ) {
      var _hasBills = _annualElecData.hasBillData;
      var _annKwh = _annualElecData.annualKwh;
      if (!_hasBills) {
        // No bill data — show literature % range if available, otherwise show import prompt
        var _litRange = SAVINGS_RANGE_MAP[row.seqKey];
        if (_litRange) {
          var _basisLabel = _litRange.energyBasis === 'fan' ? 'fan energy' : 'site electricity';
          _savingsRangeHTML =
            '<div style="margin-top:5px;padding:3px 6px;background:rgba(134,239,172,0.05);' +
            'border-left:2px solid rgba(134,239,172,0.4);border-radius:0 3px 3px 0;white-space:normal">' +
            '<span style="font-size:10px;font-weight:700;color:var(--text2)">Est. ' +
            Math.round(_litRange.lowPct * 100) +
            '–' +
            Math.round(_litRange.highPct * 100) +
            '% of ' +
            _basisLabel +
            '</span>' +
            '<span style="font-size:9px;color:var(--text3);margin-left:4px">' +
            'literature range · ' +
            _esc(_litRange.citation) +
            ' — import utility bills for $ estimate' +
            '</span>' +
            '</div>';
          _anySavingsShown = true;
        } else {
          _savingsRangeHTML =
            '<div style="margin-top:4px;font-size:9px;color:var(--text3);font-style:italic">' +
            'Import utility bills to see estimated $ savings</div>';
        }
      } else if (_annKwh && SAVINGS_RANGE_MAP[row.seqKey]) {
        var _range = _pricingComputeSavingsRange(row, _annKwh, _fanFraction, _elecRate);
        if (_range && _range.high > 0) {
          _savingsRangeHTML =
            '<div style="margin-top:5px;padding:3px 6px;background:rgba(134,239,172,0.08);' +
            'border-left:2px solid #86efac;border-radius:0 3px 3px 0;white-space:normal">' +
            '<span style="font-size:10px;font-weight:700;color:#86efac">Est. ' +
            _pricingFmtSavingsRange(_range.low, _range.high) +
            '</span>' +
            '<span style="font-size:9px;color:var(--text3);margin-left:4px">' +
            'literature range — M&amp;V required · ' +
            _esc(_range.citation) +
            '</span>' +
            '</div>';
          _anySavingsShown = true;
        }
      } else if (_annKwh) {
        // Bill data present but no literature range for this sequence
        _savingsRangeHTML =
          '<div style="margin-top:4px;font-size:9px;color:var(--text3);font-style:italic">' +
          'Site-specific calculation needed for $ estimate</div>';
      }
    }

    var _tooltipText12 = '';
    if (row.whyNotHardware) {
      _tooltipText12 = row.whyNotHardware + (row.g36Section ? ' (' + row.g36Section + ')' : '');
    } else if (row.whyNeeded) {
      _tooltipText12 = row.whyNeeded + (row.g36Section ? ' (' + row.g36Section + ')' : '');
    }
    var _titleAttr12 = _tooltipText12 ? ' title="' + _esc(_tooltipText12) + '"' : '';
    var _cursorStyle12 = _tooltipText12 ? 'cursor:help;' : '';

    // Editable note override (Fix: item 6f26cbfd) — persists to est.noteOverrides[rowId]
    // Issue 1 fix: input is the sole element in plain rows (no stacked span) so rows stay one line tall.
    // Rationale-bearing rows (Recommended phase-2) intentionally multi-line; _savingsRangeHTML stays.
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

    if (_rationaleText) {
      // Rationale visible in cell (white-space:normal so it wraps; fuller-preference)
      // These rows intentionally multi-line — savings range + rationale are value-add content
      cells.push(
        _noteInputHTML +
          '<span style="font-size:10px;color:var(--text2);display:block;white-space:normal;word-break:break-word;line-height:1.4;margin-top:2px">' +
          _esc(_rationaleText) +
          '</span>' +
          _savingsRangeHTML,
      );
    } else {
      // Plain row: input fills the cell; one line tall
      cells.push(_noteInputHTML + _savingsRangeHTML);
    }

    // Build TR
    var rowStyle = !toggleOn ? 'opacity:0.45;' : '';
    if (row.ioOnly) rowStyle += 'background:var(--s1);';

    var tds = '';
    cells.forEach(function (cellContent, ci) {
      if (hiddenCols.indexOf(ci) !== -1) return; // skip hidden columns
      var col = PRICING_TBL_COLS[ci] || {};
      // col 12 (Notes) may contain wrapped rationale text — allow wrap; other cols nowrap
      var isNotesCol = ci === 12;
      var isImpactCol = ci === 11;
      var tdStyle = isNotesCol
        ? 'overflow:hidden;padding:5px 8px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);vertical-align:top;'
        : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);';
      if (ci === 0) tdStyle += 'text-align:center;width:36px;border-right:1px solid var(--border);';
      // col 9 (Contract) for Phase 2 sequence rows: smaller padding for the hrs input
      // MUST be before the generic numeric right-align block (which also matches ci===9)
      else if (ci === 9 && row.phase === 2 && row.seqKey) tdStyle += 'padding:3px 6px;';
      // cols 5 (Qty), 7 (List), 8 (Net), 9 (Contract), 10 (Line Total) are right-aligned numerics
      else if (ci === 5 || ci === 7 || ci === 8 || ci === 9 || ci === 10)
        tdStyle += 'text-align:right;font-variant-numeric:tabular-nums;';
      else if (isImpactCol) tdStyle += 'text-align:center;vertical-align:middle;';
      if (ci === 0 || ci === 1) tdStyle += 'position:sticky;background:inherit;';
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

    return '<tr style="' + rowStyle + '">' + tds + '</tr>';
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

      // Building subtotal
      var bHw1 = hw.reduce(function (s, r) {
        return estimate.rowToggles[r._baseId || r.id] !== false ? s + (r.lineTotal || 0) : s;
      }, 0);
      var bLab2 = lb.reduce(function (s, r) {
        return estimate.rowToggles[r._baseId || r.id] !== false ? s + (r.lineTotal || 0) : s;
      }, 0);
      var bTotal = bHw1 + bLab2;

      var recBTotal = 0;
      if (isBothMode && recRows) {
        var rBRows = recRows.filter(function (r) {
          return r.building === bName;
        });
        recBTotal = rBRows.reduce(function (s, r) {
          return estimate.rowToggles[r._baseId || r.id] !== false ? s + (r.lineTotal || 0) : s;
        }, 0);
      }

      tableBodyHTML +=
        '<tr><td colspan="' +
        visibleColSpan +
        '" style="background:var(--s1);padding:6px 10px;font-size:11px;font-weight:700;color:var(--text2);border-bottom:1px solid var(--border2)">' +
        _esc(bName) +
        (bTotal > 0 && hasCatalog
          ? ' <span style="font-weight:400;color:var(--text3)">— ' +
            _pricingFmt(bTotal) +
            ' est.' +
            (isBothMode && recBTotal > 0 ? ' / Rec: ' + _pricingFmt(recBTotal) : '') +
            '</span>'
          : '') +
        '</td></tr>';

      if (hw.length > 0) {
        tableBodyHTML +=
          '<tr><td colspan="' +
          visibleColSpan +
          '" style="background:var(--s3);padding:3px 10px 3px 18px;font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid var(--border)">Phase 1 — Hardware</td></tr>';
        hw.forEach(function (row) {
          var matchedRec = null;
          if (isBothMode) {
            var base = row.id.replace(/^hw_/, '').replace(/_\d+$/, '');
            matchedRec = recRowIdxByBase[base] || null;
          }
          tableBodyHTML += renderRow(row, isBothMode, matchedRec, hidden);
        });
      }

      if (lb.length > 0) {
        tableBodyHTML +=
          '<tr><td colspan="' +
          visibleColSpan +
          '" style="background:var(--s3);padding:3px 10px 3px 18px;font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid var(--border)">Phase 2 — Programming Labor</td></tr>';
        lb.forEach(function (row) {
          tableBodyHTML += renderRow(row, isBothMode, null, hidden);
        });
      }
    });
  }

  // ── 10. Footer
  var recTierLabel = tier === 'recommended' ? 'Recommended' : 'Compliance';
  var footerParts = [
    '<div class="ch-panel-footer" style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;padding:10px 14px;background:var(--s1);border-top:2px solid var(--border2);flex-shrink:0">',
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
    '<span style="color:var(--border2)">|</span>',
    '<span style="font-size:11px;color:var(--text2);font-weight:600;text-transform:capitalize">Tier: ' +
      (tier === 'both'
        ? 'Compare'
        : tier === 'recommended'
          ? 'Recommended'
          : tier === 'full-scope'
            ? 'Full Scope'
            : 'Compliance') +
      '</span>',
  );

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
  } else if ((tier === 'recommended' || tier === 'both') && !_annualElecData.hasBillData) {
    // No bill data — footer import-bills note only shown if no % ranges were shown per-row
    if (!_anySavingsShown) {
      footerParts.push(
        '<div style="width:100%;margin-top:6px;font-size:10px;color:var(--text3);font-style:italic">' +
          'Import utility bills (Utility Data tab) to see estimated annual $ savings ranges.' +
          '</div>',
      );
    }
  }

  // M&V disclaimer — only shown when there IS savings data to disclaim (Fix: was unconditional, item 5d1245ec)
  if ((tier === 'recommended' || tier === 'both') && _anySavingsShown) {
    footerParts.push(
      '<div style="width:100%;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);' +
        'font-size:10px;color:var(--text3);line-height:1.5">' +
        '<strong style="color:var(--text2)">M&amp;V Disclaimer:</strong> ' +
        _esc(SAVINGS_DISCLAIMER_TEXT) +
        '</div>',
    );
  }

  footerParts.push('</div>');
  var footerHTML = footerParts.join('');

  // ── 11. Build table header HTML with sort labels + resize handles + gear icon
  var widths = _pricingGetColWidths(projId);
  var sSt = _pricingSortState[projId] || { col: null, dir: null };

  function thStyle(ci, extraStyle) {
    var w = widths[ci];
    var wStyle = w ? 'width:' + w + 'px;min-width:' + w + 'px;' : '';
    return (
      'background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 6px 8px 10px;white-space:normal;word-break:break-word;position:sticky;top:0;user-select:none;border-right:1px solid var(--border);border-bottom:2px solid var(--border2);' +
      wStyle +
      (extraStyle || '')
    );
  }

  function sortIndicator(ci) {
    if (sSt.col !== ci) return '';
    return sSt.dir === 'asc' ? ' ▲' : ' ▼';
  }

  function buildTH(ci, extraStyle, frozen, isGear) {
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

    // col 10 (Line Total) label shows active basis in parens, e.g. "Line Total (Contract)"
    var colLabel = col.label;
    if (ci === 10) {
      var basisLabels = { contract: 'Contract', net: 'Net', list: 'List' };
      colLabel = 'Line Total (' + (basisLabels[cfg.priceBasis] || 'Contract') + ')';
    }

    var labelHTML = col.noSort
      ? '<span style="pointer-events:none">' + colLabel + '</span>'
      : '<span class="ch-sort-label" style="cursor:pointer">' + colLabel + sortIndicator(ci) + '</span>';

    var resizeHandle =
      ci < PRICING_TBL_COLS.length - 1
        ? '<div class="ch-col-resize-handle" style="position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;background:transparent;z-index:1"></div>'
        : '';

    var gearHTML = '';
    if (isGear) {
      // Last column header gets the gear icon (column visibility toggle)
      gearHTML =
        '<button onclick="_pricingToggleColPopover(\'' +
        projId +
        '\',this)"' +
        ' title="Toggle column visibility"' +
        ' style="position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:11px;background:transparent;border:none;color:var(--text2);cursor:pointer;padding:0 2px;z-index:2">⚙</button>';
    }

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
      gearHTML +
      '</th>'
    );
  }

  // Build each visible TH
  var headerCols = '';
  PRICING_TBL_COLS.forEach(function (col, ci) {
    if (hidden.indexOf(ci) !== -1) return;
    var isFrozen = ci <= 1;
    var isGear = ci === PRICING_TBL_COLS.length - 1; // Notes col gets gear
    headerCols += buildTH(ci, null, isFrozen, isGear);
  });
  // Both mode extra header
  var extraRecHeader = isBothMode
    ? '<th style="background:var(--s1);color:var(--accent);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:8px 10px;white-space:nowrap;position:sticky;top:0;z-index:11;text-align:right;border-left:2px solid var(--border2);border-bottom:2px solid var(--border2)">Rec. Total</th>'
    : '';

  // ── 12. Assemble full panel
  // Top-ROI callout (Recommended + Both tiers, item d60f455f)
  // In Both mode, feed recRows (recommended rows carry savingsImpact); baseRows in Both = compliance rows.
  var topRoiCallout = '';
  if (tier === 'recommended' || tier === 'both') {
    var _allRecRows = tier === 'both' ? recRows || [] : baseRows;
    topRoiCallout = _pricingTopRoiCallout(projId, _allRecRows);
  }

  // Recommended tier: "no substitutions" notice + empty-state guard
  var recNoSubsNotice = '';
  if (tier === 'recommended') {
    // Empty-state: if filter removed all rows (project has no high/med-high/med sequences)
    if (filteredRows.length === 0) {
      recNoSubsNotice =
        '<div style="margin:8px 14px 0;padding:8px 12px;background:var(--s3);border:1px solid var(--border);' +
        'border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text2);line-height:1.5">' +
        '<strong style="color:var(--text)">No high-ROI measures identified</strong> — ' +
        'all required items for this project are in the Compliance tier. ' +
        'Switch to Compliance to view the full scope.' +
        '</div>';
    } else {
      var _optStats = _pricingOptimizerStats[projId];
      var _subCount = _optStats ? _optStats.subCount : 0;
      if (_subCount === 0) {
        recNoSubsNotice =
          '<div style="margin:8px 14px 0;padding:8px 12px;background:var(--s3);border:1px solid var(--border);' +
          'border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text2);line-height:1.5">' +
          '<strong style="color:var(--text)">No lower-cost substitutions found</strong> — ' +
          (hasCatalog
            ? 'the imported catalog contains no cheaper qualifying alternatives for the hardware in this project. ' +
              'Recommended hardware pricing matches Compliance. '
            : 'no pricing catalog is loaded, so the optimizer could not search for alternatives. ' +
              'Import a pricing CSV to enable substitution analysis. ') +
          '<br><span style="color:var(--text3)">' +
          'Note: Recommended shows only high/med-high/med ROI sequences (subset of Compliance). ' +
          'FDD Reporting add-on is in Full Scope tier.' +
          '</span>' +
          '</div>';
      }
    }
  }

  el.innerHTML = [
    '<div class="ch-panel" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;height:100%">',
    toolbarHTML,
    topRoiCallout,
    recNoSubsNotice,
    '<div class="ch-panel-body" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden">',
    '<div class="ch-tbl-outer" style="margin:0;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden">',
    '<div class="ch-tbl-scroll" style="flex:1;min-height:0;overflow:auto;border:1px solid var(--border);border-radius:6px">',
    '<table class="ch-tbl" style="border-collapse:separate;border-spacing:0;width:100%;min-width:1006px">',
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

/* ── Phase 4: patch _pricingRefreshFooter to apply labor overrides ──────── */
(function () {
  var _origRefreshFooter = _pricingRefreshFooter;
  _pricingRefreshFooter = function (projId) {
    var est = _pricingGetEstimate(projId);
    var tier = est.tier || 'compliance';

    // Secondary fix: Both/full-scope modes have footers that cannot be reproduced
    // here cheaply. Delegate to full re-render to keep them consistent.
    if (tier === 'both' || tier === 'full-scope') {
      initCostEstimateTab(projId);
      return;
    }

    // Use labor+qty-override-applied rows from cache if available
    var rows = _pricingRowCache[projId];
    if (!rows) {
      rows = _pricingApplyQtyOverrides(projId, _pricingApplyLaborOverrides(projId, buildComplianceRows(projId)));
    }
    var cfg = _pricingGetConfig();
    var catalog = sget('en_pricing_catalog', null);
    var totals = _pricingComputeTotals(rows, est);
    var filterBldg = _pricingBldgFilter[projId] || '';

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
    /* Frozen cells */
    '.ch-tbl .ch-frozen { position: sticky; }',
    /* Cell grid lines (ui-standards §Tables §Cell grid lines) */
    '.ch-tbl td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }',
    '.ch-tbl td:last-child { border-right: none; }',
    '.ch-tbl tbody tr:last-child td { border-bottom: none; }',
    /* Row hover */
    '.ch-tbl tbody tr:hover td { background: var(--s4); }',
    /* Tabular nums for numeric cells */
    '.ch-tbl td { font-variant-numeric: tabular-nums; }',
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
