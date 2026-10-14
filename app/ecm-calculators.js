/* ══════════════════════════════════════════════════════
   ECM CALCULATOR LIBRARY — the calc templates of the Energy Savings page
   A template turns its inputs into yearly QUANTITIES (kWh, Therms, kW) only. It never prices them and never
   spreads them over the year: the monthly shape comes from the building's HVAC Load Estimate (getEndUse,
   computations/end-use.js) and the dollars from the Energy Savings matrix pricing (calcMeasureDollars).
   tools/gate-ecm-templates-no-dollars.js fails on a dollar, a payback or a divide-by-12 inside a template.
   ══════════════════════════════════════════════════════ */

/* ─── Template Registry ──────────────────────────────── */

// Formula labels print the physics constants (computations/physics.js), never a typed copy.
const THERM_LABEL = BTU_PER_THERM.toLocaleString('en-US');
const KWH_LABEL = BTU_PER_KWH.toLocaleString('en-US', { maximumFractionDigits: 2 });

const ECM_TEMPLATES = {
  /* ── 1. OA DAMPERS ──────────────────────────────────── */
  oa_dampers: {
    id: 'oa_dampers',
    name: 'OA Dampers',
    category: 'HVAC Controls',
    description:
      'Stuck or leaking outside air dampers force the building to heat/cool excess outdoor air 24/7. Fixing or replacing them eliminates that waste.',
    icon: '🌬️',
    inputs: [
      {
        id: 'unit_cfm',
        label: 'Unit Supply Air (Cubic Feet per Minute)',
        help: 'CFM — Cubic Feet per Minute. The total volume of air the unit delivers.',
        unit: 'CFM',
        type: 'number',
        default: 10000,
        min: 100,
        max: 200000,
      },
      {
        id: 'design_oa_cfm',
        label: 'Design Minimum Outside Air (Cubic Feet per Minute)',
        help: 'OA — Outside Air. CFM — Cubic Feet per Minute. The minimum fresh outdoor air the unit should bring in per code.',
        unit: 'CFM',
        type: 'number',
        default: 2000,
        min: 0,
        max: 100000,
      },
      {
        id: 'failure_mode',
        label: 'Damper Failure Mode',
        unit: '',
        type: 'select',
        options: [
          { value: 'stuck_open', label: 'Stuck Fully Open (100% Outside Air)' },
          { value: 'partial', label: 'Stuck Partially Open — enter actual fraction below' },
          { value: 'leakage', label: 'Low-Leakage Upgrade (10% → 1% leakage)' },
        ],
        default: 'stuck_open',
      },
      {
        id: 'actual_oa_fraction',
        label: 'Actual Outside Air Fraction (partial only)',
        unit: '%',
        type: 'number',
        default: 50,
        min: 1,
        max: 100,
      },
      {
        id: 'unocc_heating_hrs',
        label: 'Unoccupied Hours — Heating Season',
        unit: 'hr/yr',
        type: 'number',
        default: 2200,
        min: 0,
        max: 5000,
      },
      {
        id: 'unocc_cooling_hrs',
        label: 'Unoccupied Hours — Cooling Season',
        unit: 'hr/yr',
        type: 'number',
        default: 600,
        min: 0,
        max: 3000,
      },
      {
        id: 'avg_delta_t_heating',
        label: 'Average ΔT Heating Season (Indoor–Outdoor)',
        help: 'ΔT — Delta-T, the temperature difference between indoors and outdoors. Higher ΔT means more energy is wasted heating excess outdoor air.',
        unit: '°F',
        type: 'number',
        default: 35,
        min: 5,
        max: 80,
      },
      {
        id: 'avg_delta_t_cooling',
        label: 'Average ΔT Cooling Season (Outdoor–Indoor)',
        help: 'ΔT — Delta-T, the temperature difference between outdoors and indoors. Higher ΔT means more energy is wasted cooling excess outdoor air.',
        unit: '°F',
        type: 'number',
        default: 10,
        min: 0,
        max: 40,
      },
      {
        id: 'boiler_afue',
        label: 'Boiler Efficiency (Annual Fuel Utilization Efficiency)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 80,
        min: 60,
        max: 99,
      },
      {
        id: 'chiller_cop',
        label: 'Chiller / DX Coefficient of Performance',
        help: 'COP — Coefficient of Performance. How efficiently the chiller converts electricity into cooling. Higher = more efficient. DX — Direct Expansion (refrigerant-based cooling). Typical range: 3–5.',
        unit: '',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },
    ],
    outputs: [
      {
        id: 'excess_cfm',
        label: 'Excess Outside Air (Cubic Feet per Minute) Eliminated',
        unit: 'CFM',
        formula: 'excess_cfm = Design OA CFM (during unoccupied hours, when damper should be closed)',
        assumption:
          'Assumption not yet checked by an engineer: for a damper that is partly open, the extra outside air is the actual outside air minus the design outside air.',
      },
      {
        id: 'therms_saved',
        label: 'Annual Gas Savings',
        unit: 'therms/yr',
        formula: 'therms = 1.08 × excess_cfm × avg_dT_heating × unocc_heating_hrs / (' + THERM_LABEL + ' × AFUE)',
      },
      {
        id: 'kwh_saved',
        label: 'Annual Cooling Savings',
        unit: 'kWh/yr',
        formula: 'kWh = 1.08 × excess_cfm × avg_dT_cooling × unocc_cooling_hrs / (COP × ' + KWH_LABEL + ')',
      },
    ],
    calculate(inp) {
      const afue = inp.boiler_afue / 100;
      const cop = inp.chiller_cop;

      // Determine excess CFM by failure mode
      let excess_cfm = 0;
      if (inp.failure_mode === 'stuck_open') {
        // All OA is excess during unoccupied (damper should be at 0)
        excess_cfm = inp.design_oa_cfm;
      } else if (inp.failure_mode === 'partial') {
        // Partial: excess = actual OA - intended OA
        // Intended is 0 during unoccupied, so all actual OA is excess
        const actual_oa = inp.unit_cfm * (inp.actual_oa_fraction / 100);
        excess_cfm = Math.max(0, actual_oa - inp.design_oa_cfm);
      } else if (inp.failure_mode === 'leakage') {
        // Low-leakage upgrade: eliminate 9% leakage (10% standard → 1% low-leakage)
        excess_cfm = inp.unit_cfm * 0.09;
      }

      // Heating energy saved (sensible OA load)
      // Formula: Q [Btu/hr] = 1.08 × CFM × ΔT
      const heat_btu_total = 1.08 * excess_cfm * inp.avg_delta_t_heating * inp.unocc_heating_hrs;
      const therms_saved = heat_btu_total / (BTU_PER_THERM * afue);

      // Cooling energy saved
      const cool_btu_total = 1.08 * excess_cfm * inp.avg_delta_t_cooling * inp.unocc_cooling_hrs;
      const kwh_saved = cool_btu_total / (cop * BTU_PER_KWH);

      return {
        excess_cfm: Math.round(excess_cfm),
        therms_saved: Math.round(therms_saved),
        kwh_saved: Math.round(kwh_saved),
      };
    },
  },

  /* ── 2. RTU REPLACEMENT ─────────────────────────────── */
  rtu_replacement: {
    id: 'rtu_replacement',
    name: 'RTU Replacement',
    category: 'HVAC Equipment',
    description:
      'Replace older rooftop units with higher-efficiency models. Uses ARI part-load curves to estimate annual cooling savings, plus heating efficiency gain.',
    icon: '🔄',
    inputs: [
      {
        id: 'replaced_tons',
        label: 'Replaced Cooling Capacity',
        unit: 'tons',
        type: 'number',
        default: 20,
        min: 1,
        max: 500,
      },
      { id: 'existing_eer', label: 'Existing EER', unit: 'BTU/Wh', type: 'number', default: 9.0, min: 4, max: 20 },
      { id: 'new_eer', label: 'New EER', unit: 'BTU/Wh', type: 'number', default: 14.0, min: 8, max: 30 },
      { id: 'existing_seer', label: 'Existing SEER', unit: '', type: 'number', default: 10.0, min: 6, max: 25 },
      { id: 'new_seer', label: 'New SEER', unit: '', type: 'number', default: 16.0, min: 13, max: 30 },
      {
        id: 'existing_cooling_kwh',
        label: 'Existing Annual Cooling kWh (from the HVAC Load Estimate)',
        endUse: 'cooling',
        unit: 'kWh/yr',
        type: 'number',
        default: 40000,
        min: 0,
        max: 5000000,
      },
      {
        id: 'heating_type',
        label: 'Heating Type',
        unit: '',
        type: 'select',
        options: [
          { value: 'gas', label: 'Gas' },
          { value: 'electric', label: 'Electric' },
          { value: 'none', label: 'No heating / not replacing' },
        ],
        default: 'gas',
      },
      {
        id: 'existing_heat_eff',
        label: 'Existing Heating Efficiency',
        unit: '% AFUE or COP×10',
        type: 'number',
        default: 80,
        min: 50,
        max: 100,
      },
      {
        id: 'new_heat_eff',
        label: 'New Heating Efficiency',
        unit: '% AFUE or COP×10',
        type: 'number',
        default: 92,
        min: 50,
        max: 100,
      },
      {
        id: 'existing_heating_therms',
        label: 'Existing Annual Heating Gas (from the HVAC Load Estimate)',
        endUse: 'heatingGas',
        unit: 'therms/yr',
        type: 'number',
        default: 2000,
        min: 0,
        max: 500000,
      },
      {
        id: 'pct_replaced',
        label: '% of Total Tons Being Replaced',
        unit: '%',
        type: 'number',
        default: 100,
        min: 1,
        max: 100,
      },
    ],
    outputs: [
      {
        id: 'existing_kw_ton',
        label: 'Existing ARI Weighted kW/Ton',
        unit: 'kW/ton',
        formula: 'buildPartLoadCurve(EER, SEER) → ARI weighted avg (2%@25% + 61.7%@50% + 23.8%@75% + 12.5%@100%)',
      },
      {
        id: 'new_kw_ton',
        label: 'New ARI Weighted kW/Ton',
        unit: 'kW/ton',
        formula: 'Same ARI formula with new EER/SEER',
      },
      {
        id: 'cooling_kwh_saved',
        label: 'Annual Cooling kWh Saved',
        unit: 'kWh/yr',
        formula: 'existing_cooling_kWh × (1 − new_kW_ton / existing_kW_ton)',
      },
      {
        id: 'heating_therms_saved',
        label: 'Annual Heating Gas Saved',
        unit: 'therms/yr',
        formula: 'existing_therms × pct_replaced × (1 − existing_eff / new_eff)',
      },
    ],
    calculate(inp) {
      // Build ARI part-load kW/ton curve
      // From RTUkW_ton sheet: kW_100 = 12/EER_full; kW_25 = 12/(SEER×0.9/0.875)
      function buildPartLoadCurve(eer, seer) {
        const kW_100 = 12 / eer;
        const kW_25 = 12 / ((seer * 0.9) / 0.875);
        // Linear interpolation for 75% and 50% load
        const kW_75 = kW_100 + (kW_25 - kW_100) * (1 / 3);
        const kW_50 = kW_100 + (kW_25 - kW_100) * (2 / 3);
        // ARI 210/240 weighted average
        const ari = 0.02 * kW_25 + 0.617 * kW_50 + 0.238 * kW_75 + 0.125 * kW_100;
        return { kW_100, kW_75, kW_50, kW_25, ari };
      }

      const existingCurve = buildPartLoadCurve(inp.existing_eer, inp.existing_seer);
      const newCurve = buildPartLoadCurve(inp.new_eer, inp.new_seer);

      // Cooling savings: efficiency ratio applied to existing calibrated kWh
      const cooling_kwh_saved = inp.existing_cooling_kwh * (1 - newCurve.ari / existingCurve.ari);

      // Heating savings (gas)
      let heating_therms_saved = 0;
      if (inp.heating_type === 'gas') {
        const eff_existing = inp.existing_heat_eff / 100;
        const eff_new = inp.new_heat_eff / 100;
        heating_therms_saved = Math.max(
          0,
          inp.existing_heating_therms * (inp.pct_replaced / 100) * (1 - eff_existing / eff_new),
        );
      }

      return {
        existing_kw_ton: Math.round(existingCurve.ari * 1000) / 1000,
        new_kw_ton: Math.round(newCurve.ari * 1000) / 1000,
        cooling_kwh_saved: Math.round(Math.max(0, cooling_kwh_saved)),
        heating_therms_saved: Math.round(heating_therms_saved),
      };
    },
  },

  /* ── 3. VFD SAVINGS ─────────────────────────────────── */
  vfd_savings: {
    id: 'vfd_savings',
    name: 'VFD Savings',
    category: 'Motors & Drives',
    description:
      'Adding a Variable Frequency Drive to a fan or pump motor. Savings come from the affinity law: power scales with speed cubed.',
    icon: '⚡',
    inputs: [
      { id: 'hp', label: 'Motor Horsepower', unit: 'HP', type: 'number', default: 15, min: 0.5, max: 1000 },
      { id: 'motor_eff', label: 'Motor Efficiency', unit: '%', type: 'number', default: 90, min: 60, max: 99 },
      {
        id: 'hours',
        label: 'Operating Hours per Year',
        unit: 'hr/yr',
        type: 'number',
        default: 2000,
        min: 100,
        max: 8760,
      },
      {
        id: 'load_before',
        label: 'Load Factor Before VFD',
        unit: '%',
        type: 'number',
        default: 100,
        min: 10,
        max: 100,
      },
      {
        id: 'load_after',
        label: 'Average Load Factor After VFD',
        unit: '%',
        type: 'number',
        default: 75,
        min: 10,
        max: 100,
      },
      {
        id: 'use_affinity',
        label: 'Use Affinity Law (cubic)?',
        unit: '',
        type: 'select',
        options: [
          { value: 'affinity', label: 'Yes — Affinity Law (power ∝ speed³) — more accurate for fans/pumps' },
          { value: 'linear', label: 'No — Linear load factor (matches Excel template)' },
        ],
        default: 'affinity',
      },
    ],
    outputs: [
      {
        id: 'baseline_kwh',
        label: 'Baseline Energy (before VFD)',
        unit: 'kWh/yr',
        formula: 'HP × ' + KW_PER_HP + ' × (load_before/100) × hours / (eff/100)',
      },
      {
        id: 'post_vfd_kwh',
        label: 'Post-VFD Energy',
        unit: 'kWh/yr',
        formula:
          'Affinity: baseline × (load_after/load_before)³  |  Linear: HP × ' + KW_PER_HP + ' × (load_after/100) × hours / (eff/100)',
      },
      { id: 'savings_kwh', label: 'Annual kWh Saved', unit: 'kWh/yr', formula: 'baseline_kWh − post_vfd_kWh' },
    ],
    calculate(inp) {
      const eff = inp.motor_eff / 100;

      // Baseline (always linear — motor is running at constant speed)
      const baseline_kwh = (hpToKw(inp.hp) * (inp.load_before / 100) * inp.hours) / eff;

      let post_vfd_kwh;
      if (inp.use_affinity === 'affinity') {
        // Affinity law: power ∝ speed³, speed ∝ flow/load
        const speed_ratio = inp.load_after / inp.load_before;
        post_vfd_kwh = baseline_kwh * fanPowerFraction(speed_ratio);
      } else {
        // Linear model (matches Excel template exactly)
        post_vfd_kwh = (hpToKw(inp.hp) * (inp.load_after / 100) * inp.hours) / eff;
      }

      const savings_kwh = baseline_kwh - post_vfd_kwh;

      return {
        baseline_kwh: Math.round(baseline_kwh),
        post_vfd_kwh: Math.round(post_vfd_kwh),
        savings_kwh: Math.round(savings_kwh),
      };
    },
  },

  /* ── 4. CHILLER REPLACEMENT ─────────────────────────── */
  chiller_replacement: {
    id: 'chiller_replacement',
    name: 'Chiller Replacement',
    category: 'HVAC Equipment',
    description:
      'Replace an existing chiller with a higher-efficiency model. Savings come from the reduction in kW/ton at part load, calculated using a linear load model consistent with the Chiller Calc template.',
    icon: '❄️',
    inputs: [
      { id: 'tonnage', label: 'Chiller Capacity', unit: 'tons', type: 'number', default: 200, min: 10, max: 5000 },
      {
        id: 'existing_kw_ton',
        label: 'Existing Efficiency',
        unit: 'kW/ton',
        type: 'number',
        default: 0.8,
        min: 0.3,
        max: 2.0,
      },
      {
        id: 'proposed_kw_ton',
        label: 'Proposed Efficiency',
        unit: 'kW/ton',
        type: 'number',
        default: 0.55,
        min: 0.2,
        max: 1.5,
      },
      {
        id: 'annual_hours',
        label: 'Annual Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 1800,
        min: 100,
        max: 8760,
      },
      {
        id: 'avg_load_pct',
        label: 'Average Load Factor',
        unit: '%',
        type: 'number',
        default: 70,
        min: 10,
        max: 100,
      },
    ],
    outputs: [
      {
        id: 'existing_kw_full',
        label: 'Existing Full-Load Power',
        unit: 'kW',
        formula: 'tonnage × existing_kW/ton',
      },
      {
        id: 'proposed_kw_full',
        label: 'Proposed Full-Load Power',
        unit: 'kW',
        formula: 'tonnage × proposed_kW/ton',
      },
      {
        id: 'savings_kwh',
        label: 'Annual Energy Savings',
        unit: 'kWh/yr',
        formula: '(existing_kW_full − proposed_kW_full) × avg_load_pct × annual_hours',
      },
      {
        id: 'peak_kw_savings',
        label: 'Peak Demand Reduction',
        unit: 'kW',
        formula: '(existing_kW_full − proposed_kW_full) × avg_load_pct',
      },
    ],
    calculate(inp) {
      const avgLoad = inp.avg_load_pct / 100;
      const existing_kw_full = inp.tonnage * inp.existing_kw_ton;
      const proposed_kw_full = inp.tonnage * inp.proposed_kw_ton;

      // Annual energy: full-load kW × average load fraction × hours
      const existing_kwh = existing_kw_full * avgLoad * inp.annual_hours;
      const proposed_kwh = proposed_kw_full * avgLoad * inp.annual_hours;
      const savings_kwh = Math.max(0, existing_kwh - proposed_kwh);

      // Peak demand savings at average load
      const peak_kw_savings = Math.max(0, existing_kw_full - proposed_kw_full) * avgLoad;

      return {
        existing_kw_full: Math.round(existing_kw_full * 10) / 10,
        proposed_kw_full: Math.round(proposed_kw_full * 10) / 10,
        savings_kwh: Math.round(savings_kwh),
        peak_kw_savings: Math.round(peak_kw_savings * 10) / 10,
      };
    },
  },

  /* ── 5. OUTDOOR AIR / ENERGY RECOVERY ───────────────── */
  oa_erw: {
    id: 'oa_erw',
    name: 'Outdoor Air / Energy Recovery',
    category: 'HVAC Controls',
    description:
      'Estimate savings from reducing outdoor air load or adding an energy recovery wheel. Uses the standard psychrometric formulas: 1.08×CFM×ΔT for sensible heating and 4.5×CFM×Δenthalpy for cooling.',
    icon: '💨',
    inputs: [
      {
        id: 'oa_cfm',
        label: 'Outdoor Air (Cubic Feet per Minute)',
        help: 'OA — Outside Air. CFM — Cubic Feet per Minute. The volume of fresh outdoor air brought into the building.',
        unit: 'CFM',
        type: 'number',
        default: 2000,
        min: 100,
        max: 100000,
      },
      {
        id: 'heating_setpoint',
        label: 'Heating Setpoint (Occupied)',
        unit: '°F',
        type: 'number',
        default: 68,
        min: 55,
        max: 80,
      },
      {
        id: 'design_winter_temp',
        label: 'Design Winter Outdoor Temperature',
        unit: '°F',
        type: 'number',
        default: 10,
        min: -20,
        max: 50,
      },
      {
        id: 'summer_oa_enthalpy',
        label: 'Summer Outside Air Enthalpy',
        unit: 'BTU/lb',
        type: 'number',
        default: 38.5,
        min: 20,
        max: 60,
      },
      {
        id: 'target_enthalpy',
        label: 'Target Supply Enthalpy',
        unit: 'BTU/lb',
        type: 'number',
        default: 28.0,
        min: 15,
        max: 40,
      },
      {
        id: 'heating_hours',
        label: 'Annual Heating Hours (Occupied)',
        unit: 'hr/yr',
        type: 'number',
        default: 1200,
        min: 0,
        max: 5000,
      },
      {
        id: 'cooling_hours',
        label: 'Annual Cooling Hours (Occupied)',
        unit: 'hr/yr',
        type: 'number',
        default: 1500,
        min: 0,
        max: 5000,
      },
      {
        id: 'erw_winter_eff',
        label: 'ERW Winter Sensible Effectiveness',
        unit: '%',
        type: 'number',
        default: 0,
        min: 0,
        max: 90,
      },
      {
        id: 'erw_summer_eff',
        label: 'ERW Summer Enthalpy Effectiveness',
        unit: '%',
        type: 'number',
        default: 0,
        min: 0,
        max: 90,
      },
      {
        id: 'erw_derate',
        label: 'ERW Performance Derate',
        unit: '%',
        type: 'number',
        default: 0,
        min: 0,
        max: 30,
      },
      {
        id: 'afue',
        label: 'Heating Efficiency (Annual Fuel Utilization Efficiency or Coefficient of Performance)',
        help: 'AFUE — Annual Fuel Utilization Efficiency (for gas systems, e.g. 0.80 = 80%). COP — Coefficient of Performance (for heat pumps, e.g. 3.0). Enter the appropriate value for your heating system.',
        unit: '',
        type: 'number',
        default: 0.8,
        min: 0.5,
        max: 5.0,
      },
      {
        id: 'eer',
        label: 'Cooling Efficiency (EER)',
        help: 'EER — Energy Efficiency Ratio. Cooling output (BTU/hr) divided by electrical input (watts). Higher = more efficient. Typical packaged units: 10–14 EER.',
        unit: 'EER',
        type: 'number',
        default: 12.0,
        min: 5.0,
        max: 30.0,
      },
      {
        id: 'heating_fuel',
        label: 'Heating Fuel (gas=0, electric=1)',
        unit: '',
        type: 'number',
        default: 0,
        min: 0,
        max: 1,
      },
    ],
    outputs: [
      {
        id: 'erw_winter_eff_derated',
        label: 'ERW Winter Effectiveness (derated)',
        unit: '%',
        formula: 'rated_eff × (1 − derate)',
      },
      {
        id: 'erw_summer_eff_derated',
        label: 'ERW Summer Effectiveness (derated)',
        unit: '%',
        formula: 'rated_eff × (1 − derate)',
      },
      {
        id: 'heating_savings_therms',
        label: 'Annual Heating Gas Savings',
        unit: 'therms/yr',
        formula: '1.08 × CFM × ΔT_recovered × heating_hours / (' + THERM_LABEL + ' × AFUE); ΔT_recovered = ΔT × ERW_eff; gas only (Heating Fuel = 0)',
      },
      {
        id: 'heating_savings_kwh',
        label: 'Annual Heating Electric Savings',
        unit: 'kWh/yr',
        formula: '1.08 × CFM × ΔT_recovered × heating_hours / (AFUE × ' + KWH_LABEL + ') when Heating Fuel = 1 (electric)',
      },
      {
        id: 'cooling_savings_kwh',
        label: 'Annual Cooling Electric Savings',
        unit: 'kWh/yr',
        formula: '4.5 × CFM × Δenthalpy_recovered × cooling_hours / (EER × 1000); Δh_recovered = Δh × ERW_eff',
      },
    ],
    calculate(inp) {
      // Apply ERW derate: effective_eff = rated × (1 − derate%)
      const erw_winter = (inp.erw_winter_eff / 100) * (1 - inp.erw_derate / 100);
      const erw_summer = (inp.erw_summer_eff / 100) * (1 - inp.erw_derate / 100);

      // ── Heating savings ──
      // Sensible heat formula: Q [BTU/hr] = 1.08 × CFM × ΔT
      // The wheel RECOVERS erw_winter of the raw OA load. Savings = the recovered part
      // (efficiency 0 saves nothing; a better wheel saves more).
      const delta_t_raw = Math.max(0, inp.heating_setpoint - inp.design_winter_temp);
      const delta_t_recovered = delta_t_raw * erw_winter;
      const heat_btu_yr = 1.08 * inp.oa_cfm * delta_t_recovered * inp.heating_hours;

      // Convert to therms: BTU / (BTU_PER_THERM × AFUE)
      const useGas = inp.heating_fuel < 0.5;
      const heating_savings_therms = useGas ? heat_btu_yr / (BTU_PER_THERM * inp.afue) : 0;
      const heating_savings_kwh = useGas ? 0 : heat_btu_yr / (inp.afue * BTU_PER_KWH);

      // ── Cooling savings ──
      // Total heat formula: Q [BTU/hr] = 4.5 × CFM × Δenthalpy
      // The wheel recovers erw_summer of the raw enthalpy gap: recovered Δh = raw Δh × ERW_eff
      const delta_h_raw = Math.max(0, inp.summer_oa_enthalpy - inp.target_enthalpy);
      const delta_h_recovered = delta_h_raw * erw_summer;
      const cool_btu_yr = 4.5 * inp.oa_cfm * delta_h_recovered * inp.cooling_hours;

      // EER is Btu/h per watt, so kW = Btu/h / (EER × 1000) and kWh = Btu_yr / (EER × 1000)
      const cooling_savings_kwh = cool_btu_yr / (inp.eer * 1000);

      return {
        erw_winter_eff_derated: Math.round(erw_winter * 1000) / 10,
        erw_summer_eff_derated: Math.round(erw_summer * 1000) / 10,
        heating_savings_therms: Math.round(heating_savings_therms),
        heating_savings_kwh: Math.round(heating_savings_kwh),
        cooling_savings_kwh: Math.round(cooling_savings_kwh),
      };
    },
  },

  /* ── 6. SOLAR PRODUCTION ────────────────────────────── */
  solar_production: {
    id: 'solar_production',
    name: 'Solar Production',
    category: 'Renewables',
    description:
      'Estimate annual production from a rooftop or ground-mounted solar array, with lifetime degradation. When added to the savings matrix, the months follow the production by month in the Solar calculator.',
    icon: '☀️',
    inputs: [
      {
        id: 'array_kw_dc',
        label: 'Array Size (DC)',
        unit: 'kW DC',
        type: 'number',
        default: 100,
        min: 1,
        max: 10000,
      },
      {
        id: 'production_ratio',
        label: 'Annual Production Ratio',
        unit: 'kWh/kW',
        type: 'number',
        default: 1350,
        min: 800,
        max: 1800,
      },
      {
        id: 'system_derate',
        label: 'System Derate Factor',
        unit: '%',
        type: 'number',
        default: 87,
        min: 70,
        max: 100,
      },
      {
        id: 'annual_degradation',
        label: 'Annual Panel Degradation',
        unit: '%/yr',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 2,
      },

      {
        id: 'analysis_years',
        label: 'Analysis Period',
        unit: 'years',
        type: 'number',
        default: 25,
        min: 5,
        max: 40,
      },
    ],
    outputs: [
      {
        id: 'year1_kwh',
        label: 'Year 1 Production',
        unit: 'kWh/yr',
        formula: 'array_kW × production_ratio × (system_derate / 100)',
      },

      {
        id: 'lifetime_kwh',
        label: 'Lifetime Production',
        unit: 'kWh',
        formula: 'geometric series: year1_kWh × (1 − (1−degradation)^years) / degradation',
      },
    ],
    calculate(inp) {
      // Year-1 production: array_kW × kWh/kW_ratio × system_derate
      const year1_kwh = inp.array_kw_dc * inp.production_ratio * (inp.system_derate / 100);

      // Lifetime production with annual degradation (geometric series)
      const d = inp.annual_degradation / 100;
      const years = inp.analysis_years;
      const lifetime_kwh = d > 0 ? (year1_kwh * (1 - Math.pow(1 - d, years))) / d : year1_kwh * years;

      return {
        year1_kwh: Math.round(year1_kwh),
        lifetime_kwh: Math.round(lifetime_kwh),
      };
    },
  },

  /* ── 7. LIGHTING REPLACEMENT ────────────────────────── */
  lighting_replacement: {
    id: 'lighting_replacement',
    name: 'Lighting Replacement',
    category: 'Lighting',
    description:
      'Calculate savings from replacing existing fixtures with higher-efficiency LEDs. Includes energy savings, demand savings with coincidence factor, and optional occupancy sensor add-on. Formula basis: LSI Lighting Calc LxL sheet.',
    icon: '💡',
    inputs: [
      {
        id: 'existing_watts',
        label: 'Existing Fixture Wattage',
        unit: 'W/fixture',
        type: 'number',
        default: 64,
        min: 1,
        max: 2000,
      },
      {
        id: 'proposed_watts',
        label: 'Proposed LED Wattage',
        unit: 'W/fixture',
        type: 'number',
        default: 28,
        min: 1,
        max: 1000,
      },
      {
        id: 'quantity',
        label: 'Number of Fixtures',
        unit: 'fixtures',
        type: 'number',
        default: 100,
        min: 1,
        max: 100000,
      },
      {
        id: 'annual_hours',
        label: 'Annual Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 2200,
        min: 100,
        max: 8760,
      },

      {
        id: 'coincidence_factor',
        label: 'Peak Demand Coincidence Factor',
        unit: '%',
        type: 'number',
        default: 90,
        min: 0,
        max: 100,
      },
      {
        id: 'occ_sensor_savings_pct',
        label: 'Occupancy Sensor Savings (0 = none)',
        unit: '%',
        type: 'number',
        default: 0,
        min: 0,
        max: 60,
      },
    ],
    outputs: [
      {
        id: 'existing_kwh',
        label: 'Existing Annual Energy',
        unit: 'kWh/yr',
        formula: 'existing_W × qty × hours / 1,000  [LxL: T4 = H4×I4×J4/1000]',
      },
      {
        id: 'proposed_kwh',
        label: 'Proposed Annual Energy',
        unit: 'kWh/yr',
        formula: 'proposed_W × qty × hours / 1,000  [LxL: U4 = L4×M4×J4/1000]',
      },
      {
        id: 'base_savings_kwh',
        label: 'Base Lighting Savings',
        unit: 'kWh/yr',
        formula: 'existing_kWh − proposed_kWh  [LxL: V4 = T4−U4]',
      },
      {
        id: 'sensor_savings_kwh',
        label: 'Occupancy Sensor Savings',
        unit: 'kWh/yr',
        formula: 'proposed_kWh × occ_sensor_pct  [LxL: X4 = W4×U4]',
      },
      {
        id: 'total_savings_kwh',
        label: 'Total Energy Savings',
        unit: 'kWh/yr',
        formula: 'base_savings + sensor_savings',
      },
      {
        id: 'demand_savings_kw',
        label: 'Peak Demand Reduction',
        unit: 'kW',
        formula: '(existing_W − proposed_W) × qty / 1,000 × coincidence_factor  [LxL: S4 = Q4−R4]',
      },
    ],
    calculate(inp) {
      // Base energy savings [LxL: T4, U4, V4]
      const existing_kwh = (inp.existing_watts * inp.quantity * inp.annual_hours) / 1000;
      const proposed_kwh = (inp.proposed_watts * inp.quantity * inp.annual_hours) / 1000;
      const base_savings_kwh = Math.max(0, existing_kwh - proposed_kwh);

      // Occupancy sensor savings applied to proposed kWh [LxL: X4 = W4×U4]
      const sensor_savings_kwh = proposed_kwh * (inp.occ_sensor_savings_pct / 100);
      const total_savings_kwh = base_savings_kwh + sensor_savings_kwh;

      // Peak demand savings [LxL: S4 = Q4−R4; Q4 = H4×I4/1000 × CF]
      const demand_savings_kw =
        ((Math.max(0, inp.existing_watts - inp.proposed_watts) * inp.quantity) / 1000) * (inp.coincidence_factor / 100);

      return {
        existing_kwh: Math.round(existing_kwh),
        proposed_kwh: Math.round(proposed_kwh),
        base_savings_kwh: Math.round(base_savings_kwh),
        sensor_savings_kwh: Math.round(sensor_savings_kwh),
        total_savings_kwh: Math.round(total_savings_kwh),
        demand_savings_kw: Math.round(demand_savings_kw * 10) / 10,
      };
    },
  },

  /* ── 8. OCCUPANCY SENSORS ───────────────────────────── */
  occupancy_sensors: {
    id: 'occupancy_sensors',
    name: 'Occupancy Sensors',
    category: 'Lighting',
    description:
      'Estimate lighting savings from occupancy/vacancy sensor controls. Vacancy percentages by space type follow ComEd/Evergy TRM and ASHRAE 90.1 defaults. Applies a control effectiveness factor (default 85%) to account for sensor dead zones and re-triggering.',
    icon: '👁️',
    inputs: [
      {
        id: 'space_type',
        label: 'Space Type (for vacancy % default)',
        unit: '',
        type: 'select',
        options: [
          { value: 'classroom', label: 'Classroom / Lecture Room (25–35%)' },
          { value: 'office_priv', label: 'Private Office (30–40%)' },
          { value: 'office_open', label: 'Open Office (20–25%)' },
          { value: 'conference', label: 'Conference Room (50–70%)' },
          { value: 'restroom', label: 'Restroom (60–80%)' },
          { value: 'corridor', label: 'Corridor / Hallway (30–50%)' },
          { value: 'storage', label: 'Storage Room (80–90%)' },
          { value: 'gym', label: 'Gymnasium / Large Space (20–35%)' },
        ],
        default: 'classroom',
      },
      {
        id: 'fixture_watts',
        label: 'Watts per Fixture',
        unit: 'W',
        type: 'number',
        default: 32,
        min: 1,
        max: 2000,
      },
      {
        id: 'fixtures_per_space',
        label: 'Fixtures per Space',
        unit: 'fixtures',
        type: 'number',
        default: 8,
        min: 1,
        max: 200,
      },
      {
        id: 'qty_spaces',
        label: 'Number of Spaces',
        unit: 'spaces',
        type: 'number',
        default: 20,
        min: 1,
        max: 1000,
      },
      {
        id: 'scheduled_hours',
        label: 'Scheduled Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 2200,
        min: 100,
        max: 8760,
      },
      {
        id: 'control_factor',
        label: 'Control Effectiveness Factor',
        unit: '%',
        type: 'number',
        default: 85,
        min: 50,
        max: 100,
      },
    ],
    outputs: [
      {
        id: 'vacancy_pct_used',
        label: 'Vacancy % Applied (TRM midpoint)',
        unit: '%',
        formula: 'TRM table lookup by space type — midpoint of reported range',
      },
      {
        id: 'total_kw',
        label: 'Total Controlled Load',
        unit: 'kW',
        formula: 'fixture_W × fixtures/space × spaces / 1,000',
      },
      {
        id: 'vacancy_hours',
        label: 'Annual Vacancy Hours',
        unit: 'hr/yr',
        formula: 'scheduled_hours × vacancy_pct',
      },
      {
        id: 'savings_kwh',
        label: 'Annual Energy Savings',
        unit: 'kWh/yr',
        formula: 'total_kW × vacancy_hours × control_factor',
      },
      {
        id: 'demand_savings_kw',
        label: 'Peak Demand Reduction',
        unit: 'kW',
        formula: 'total_kW × vacancy_pct × control_factor × 0.50 coincidence',
      },
    ],
    // TRM vacancy % midpoints by space type
    // Source: missing-ecm-research-2026-05-16.md §ECM2 Table 1 (ComEd/Utility E TRM)
    _vacancy: {
      classroom: 0.3,
      office_priv: 0.35,
      office_open: 0.225,
      conference: 0.6,
      restroom: 0.7,
      corridor: 0.4,
      storage: 0.85,
      gym: 0.275,
    },
    calculate(inp) {
      const vacancy_pct = this._vacancy[inp.space_type] || 0.3;
      const total_kw = (inp.fixture_watts * inp.fixtures_per_space * inp.qty_spaces) / 1000;
      const vacancy_hours = inp.scheduled_hours * vacancy_pct;
      const control_factor = inp.control_factor / 100;

      // Energy savings: total_kW × vacancy_hours × control_factor
      // Source: missing-ecm-research-2026-05-16.md §ECM2
      const savings_kwh = total_kw * vacancy_hours * control_factor;

      // Demand savings: 50% coincidence factor — sensors reduce peak only partially
      // (lights cycle on/off based on motion, not all off simultaneously at peak)
      const demand_savings_kw = total_kw * vacancy_pct * control_factor * 0.5;

      return {
        vacancy_pct_used: Math.round(vacancy_pct * 100),
        total_kw: Math.round(total_kw * 10) / 10,
        vacancy_hours: Math.round(vacancy_hours),
        savings_kwh: Math.round(savings_kwh),
        demand_savings_kw: Math.round(demand_savings_kw * 10) / 10,
      };
    },
  },

  /* ── 9. PUMP VFD INSTALLATION ───────────────────────── */
  pump_vfd: {
    id: 'pump_vfd',
    name: 'Pump VFD Installation',
    category: 'Pumps',
    description:
      'Calculates energy savings from adding a variable frequency drive to a constant-speed pump. Uses the pump affinity law: power scales with the cube of speed ratio. BHP = (GPM × head_ft) / (3960 × pump_eff). Applicable to hot water, chilled water, condenser water, and domestic booster pumps.',
    icon: '💧',
    inputs: [
      { id: 'gpm', label: 'Design Flow Rate', unit: 'GPM', type: 'number', default: 200, min: 1, max: 50000 },
      { id: 'head_ft', label: 'System Head', unit: 'ft w.g.', type: 'number', default: 60, min: 1, max: 500 },
      { id: 'pump_eff', label: 'Pump Efficiency', unit: '%', type: 'number', default: 72, min: 30, max: 92 },
      { id: 'motor_eff', label: 'Motor Efficiency', unit: '%', type: 'number', default: 91, min: 70, max: 97 },
      {
        id: 'avg_speed_ratio',
        label: 'Average Speed Ratio After VFD',
        unit: '0–1',
        type: 'number',
        default: 0.7,
        min: 0.2,
        max: 0.99,
      },
      {
        id: 'op_hours',
        label: 'Annual Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 1800,
        min: 100,
        max: 8760,
      },
    ],
    outputs: [
      {
        id: 'bhp_design',
        label: 'Design BHP',
        unit: 'BHP',
        formula: 'BHP = (GPM × head_ft) / (3960 × pump_eff)  [pump affinity law — 3960 is unit constant for GPM/ft/HP]',
      },
      { id: 'kw_design', label: 'Design kW', unit: 'kW', formula: 'kW = BHP × ' + KW_PER_HP + ' / motor_eff' },
      {
        id: 'kwh_existing',
        label: 'Existing Annual Energy',
        unit: 'kWh/yr',
        formula: 'kWh = kW_design × op_hours  (constant speed — pump runs at full power)',
      },
      {
        id: 'kwh_new',
        label: 'New Annual Energy (VFD)',
        unit: 'kWh/yr',
        formula: 'kWh = kW_design × avg_speed_ratio³ × op_hours  (cube law: power ∝ speed³)',
      },
      { id: 'savings_kwh', label: 'Annual kWh Savings', unit: 'kWh/yr', formula: 'savings = kwh_existing − kwh_new' },
    ],
    calculate(inp) {
      const pe = inp.pump_eff / 100;
      const me = inp.motor_eff / 100;
      const sr = inp.avg_speed_ratio;
      const bhp_design = (inp.gpm * inp.head_ft) / (3960 * pe);
      const kw_design = hpToKw(bhp_design, me);
      const kwh_existing = kw_design * inp.op_hours;
      const kwh_new = kw_design * fanPowerFraction(sr) * inp.op_hours;
      const savings_kwh = kwh_existing - kwh_new;
      return {
        bhp_design: Math.round(bhp_design * 100) / 100,
        kw_design: Math.round(kw_design * 100) / 100,
        kwh_existing: Math.round(kwh_existing),
        kwh_new: Math.round(kwh_new),
        savings_kwh: Math.round(savings_kwh),
      };
    },
  },

  /* ── 10. PREMIUM EFFICIENCY MOTOR ───────────────────── */
  motor_premium: {
    id: 'motor_premium',
    name: 'Premium Efficiency Motor',
    category: 'Motors & Drives',
    description:
      'Calculates energy savings from replacing a standard-efficiency motor with a NEMA Premium (IE3) motor. Savings formula: HP × ' + KW_PER_HP + ' × load_factor × hours × (1/eff_old − 1/eff_new).',
    icon: '⚙️',
    inputs: [
      { id: 'hp', label: 'Motor Horsepower', unit: 'HP', type: 'number', default: 20, min: 0.5, max: 1000 },
      {
        id: 'load_factor',
        label: 'Load Factor (fraction of nameplate HP)',
        unit: '0–1',
        type: 'number',
        default: 0.85,
        min: 0.1,
        max: 1.0,
      },
      { id: 'eff_old', label: 'Existing Motor Efficiency', unit: '%', type: 'number', default: 91.0, min: 60, max: 97 },
      {
        id: 'eff_new',
        label: 'NEMA Premium Motor Efficiency',
        unit: '%',
        type: 'number',
        default: 93.0,
        min: 70,
        max: 99,
      },
      {
        id: 'op_hours',
        label: 'Annual Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 4380,
        min: 100,
        max: 8760,
      },
    ],
    outputs: [
      { id: 'shaft_hp', label: 'Shaft HP', unit: 'HP', formula: 'shaft_hp = nameplate_HP × load_factor' },
      { id: 'kw_old', label: 'Existing Motor kW', unit: 'kW', formula: 'kW = shaft_hp × ' + KW_PER_HP + ' / eff_old' },
      { id: 'kw_new', label: 'New Motor kW', unit: 'kW', formula: 'kW = shaft_hp × ' + KW_PER_HP + ' / eff_new' },
      {
        id: 'savings_kwh',
        label: 'Annual kWh Savings',
        unit: 'kWh/yr',
        formula: '(kW_old − kW_new) × op_hours  — same shaft load, fewer input watts',
      },
    ],
    calculate(inp) {
      const eo = inp.eff_old / 100;
      const en = inp.eff_new / 100;
      const shaft_hp = inp.hp * inp.load_factor;
      const kw_old = hpToKw(shaft_hp, eo);
      const kw_new = hpToKw(shaft_hp, en);
      const savings_kwh = (kw_old - kw_new) * inp.op_hours;
      return {
        shaft_hp: Math.round(shaft_hp * 100) / 100,
        kw_old: Math.round(kw_old * 1000) / 1000,
        kw_new: Math.round(kw_new * 1000) / 1000,
        savings_kwh: Math.round(savings_kwh),
      };
    },
  },

  /* ── 11. DEMAND CONTROLLED VENTILATION (DCV) ─────────── */
  dcv: {
    id: 'dcv',
    name: 'Demand Controlled Ventilation',
    category: 'HVAC Controls',
    description:
      'Estimates heating and cooling savings from CO2-based DCV. OA is reduced proportionally when occupancy falls below design. Based on ASHRAE 62.1: Vbz = (Rp × people) + (Ra × area). Only the per-person OA component varies with CO2/occupancy — the area component is always required.',
    icon: '🌬️',
    inputs: [
      {
        id: 'oa_cfm_design',
        label: 'Design Outside Air (Cubic Feet per Minute, full occupancy)',
        unit: 'CFM',
        type: 'number',
        default: 2290,
        min: 50,
        max: 100000,
      },
      {
        id: 'per_person_frac',
        label: 'Per-Person Outside Air Fraction of Total Outside Air',
        unit: '0–1',
        type: 'number',
        default: 0.76,
        min: 0.1,
        max: 1.0,
      },
      {
        id: 'avg_occ_frac',
        label: 'Average Occupancy During Occupied Hours',
        unit: '0–1',
        type: 'number',
        default: 0.65,
        min: 0.05,
        max: 1.0,
      },
      {
        id: 'heat_hours',
        label: 'Occupied Heating Season Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 1000,
        min: 0,
        max: 4000,
      },
      {
        id: 'avg_dt_heat',
        label: 'Average Heating ΔT (indoor − outdoor)',
        help: 'ΔT — Delta-T, the temperature difference between indoors and outdoors during heating season.',
        unit: '°F',
        type: 'number',
        default: 35,
        min: 5,
        max: 80,
      },
      {
        id: 'boiler_afue',
        label: 'Boiler Efficiency (Annual Fuel Utilization Efficiency)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 82,
        min: 60,
        max: 99,
      },

      {
        id: 'cool_hours',
        label: 'Occupied Cooling Season Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 600,
        min: 0,
        max: 3000,
      },
      {
        id: 'avg_dt_cool',
        label: 'Average Cooling ΔT (outdoor − indoor)',
        help: 'ΔT — Delta-T, the temperature difference between outdoors and indoors during cooling season.',
        unit: '°F',
        type: 'number',
        default: 10,
        min: 0,
        max: 40,
      },
      {
        id: 'chiller_cop',
        label: 'Cooling System Coefficient of Performance',
        help: 'COP — Coefficient of Performance. How efficiently the cooling system converts electricity into cooling. Higher = more efficient. Typical range: 3–5.',
        unit: 'COP',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },
    ],
    outputs: [
      {
        id: 'oa_reduction_pct',
        label: 'Average Outside Air Reduction',
        unit: '%',
        formula: 'per_person_frac × (1 − avg_occ_frac)  — only per-person component varies with CO2',
      },
      { id: 'cfm_saved', label: 'Average Cubic Feet per Minute Reduced', unit: 'CFM', formula: 'oa_cfm_design × oa_reduction_frac' },
      {
        id: 'therms_saved',
        label: 'Heating Therms Saved',
        unit: 'therms/yr',
        formula: '1.08 × cfm_saved × avg_dt_heat × heat_hours / (' + THERM_LABEL + ' × AFUE)',
      },

      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved',
        unit: 'kWh/yr',
        formula: '1.08 × cfm_saved × avg_dt_cool × cool_hours / (COP × ' + KWH_LABEL + ')',
      },
    ],
    calculate(inp) {
      const afue = inp.boiler_afue / 100;
      const avgOaReduction = inp.per_person_frac * (1 - inp.avg_occ_frac);
      const cfm_saved = inp.oa_cfm_design * avgOaReduction;
      const heat_btu = 1.08 * cfm_saved * inp.avg_dt_heat * inp.heat_hours;
      const therms_saved = heat_btu / (BTU_PER_THERM * afue);
      const cool_btu = 1.08 * cfm_saved * inp.avg_dt_cool * inp.cool_hours;
      const cool_kwh_saved = cool_btu / (inp.chiller_cop * BTU_PER_KWH);
      return {
        oa_reduction_pct: Math.round(avgOaReduction * 1000) / 10,
        cfm_saved: Math.round(cfm_saved),
        therms_saved: Math.round(therms_saved),
        cool_kwh_saved: Math.round(cool_kwh_saved),
      };
    },
  },

  /* ── 12. VAV REHEAT OPTIMIZATION ────────────────────── */
  vav_reheat: {
    id: 'vav_reheat',
    name: 'VAV Reheat Optimization',
    category: 'HVAC Controls',
    description:
      'Estimates savings from reducing simultaneous heating and cooling in VAV systems via two measures: (1) Supply Air Temperature (SAT) reset — raise SAT during mild weather so reheat zones need less heat while the AHU cools less air; (2) Minimum airflow setpoint reduction — per ASHRAE 36.',
    icon: '🔁',
    inputs: [
      {
        id: 'system_cfm',
        label: 'Total System (Cubic Feet per Minute)',
        unit: 'CFM',
        type: 'number',
        default: 20000,
        min: 500,
        max: 500000,
      },
      {
        id: 'pct_zones_heat',
        label: '% Zones in Simultaneous Reheat',
        unit: '%',
        type: 'number',
        default: 40,
        min: 5,
        max: 100,
      },
      {
        id: 'avg_dt_reheat',
        label: 'Average Reheat Reduction from Supply Air Temperature Reset',
        unit: '°F',
        type: 'number',
        default: 8,
        min: 1,
        max: 20,
      },
      {
        id: 'season_hours',
        label: 'Simultaneous H/C Hours per Year',
        unit: 'hr/yr',
        type: 'number',
        default: 1000,
        min: 0,
        max: 3000,
      },
      {
        id: 'reheat_type',
        label: 'Reheat Energy Source',
        unit: '',
        type: 'select',
        options: [
          { value: 'gas', label: 'Gas hot water reheat' },
          { value: 'electric', label: 'Electric resistance reheat' },
        ],
        default: 'gas',
      },
      {
        id: 'boiler_afue',
        label: 'Boiler Efficiency (Annual Fuel Utilization Efficiency, gas reheat only)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 82,
        min: 60,
        max: 99,
      },
      {
        id: 'cooling_cop',
        label: 'Cooling System Coefficient of Performance',
        help: 'COP — Coefficient of Performance. How efficiently the cooling system converts electricity into cooling. Higher = more efficient. Typical range: 3–5.',
        unit: 'COP',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },

      {
        id: 'min_flow_old',
        label: 'Current Min Airflow Setpoint',
        unit: '%',
        type: 'number',
        default: 35,
        min: 0,
        max: 100,
      },
      {
        id: 'min_flow_new',
        label: 'Proposed Min Airflow Setpoint',
        unit: '%',
        type: 'number',
        default: 15,
        min: 0,
        max: 100,
      },
      {
        id: 'fan_kw_design',
        label: 'Fan Motor kW at Design (Cubic Feet per Minute)',
        unit: 'kW',
        type: 'number',
        default: 15,
        min: 0.5,
        max: 1000,
      },
      {
        id: 'unocc_hours',
        label: 'Unoccupied Hours per Year',
        unit: 'hr/yr',
        type: 'number',
        default: 2000,
        min: 0,
        max: 5000,
      },
    ],
    outputs: [
      {
        id: 'reheat_saved_qty',
        label: 'Reheat Savings (therms or kWh)',
        unit: 'therms or kWh/yr',
        formula: '1.08 × (system_cfm × pct_zones) × avg_dT × season_hours → ÷ (' + THERM_LABEL + '×AFUE) gas, ÷ ' + KWH_LABEL + ' electric',
      },

      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved (Supply Air Temperature Reset)',
        unit: 'kWh/yr',
        formula: '1.08 × system_cfm × avg_dT × season_hours × 0.30 / (COP × ' + KWH_LABEL + ')',
        assumption:
          'Assumption, not measured: 30% of the airflow is taken to benefit from the supply air temperature reset (the 0.30 factor).',
      },
      {
        id: 'fan_kwh_saved',
        label: 'Fan kWh Saved (min flow)',
        unit: 'kWh/yr',
        formula: 'fan_kW × (min_old_ratio³ − min_new_ratio³) × unocc_hours  — cube law on airflow fraction',
      },
    ],
    calculate(inp) {
      const pct = inp.pct_zones_heat / 100;
      const afue = inp.boiler_afue / 100;
      const mfOld = inp.min_flow_old / 100;
      const mfNew = inp.min_flow_new / 100;
      const isElec = inp.reheat_type === 'electric';
      const zones_cfm = inp.system_cfm * pct;
      const reheat_btu_total = 1.08 * zones_cfm * inp.avg_dt_reheat * inp.season_hours;
      const reheat_saved_qty = isElec
        ? Math.round(reheat_btu_total / BTU_PER_KWH)
        : Math.round(reheat_btu_total / (BTU_PER_THERM * afue));
      const cool_btu = 1.08 * inp.system_cfm * inp.avg_dt_reheat * inp.season_hours * 0.3;
      const cool_kwh_saved = Math.round(cool_btu / (inp.cooling_cop * BTU_PER_KWH));
      const fan_kwh_saved = Math.max(
        0,
        Math.round(inp.fan_kw_design * (fanPowerFraction(mfOld) - fanPowerFraction(mfNew)) * inp.unocc_hours),
      );
      return {
        reheat_saved_qty: reheat_saved_qty,
        cool_kwh_saved: cool_kwh_saved,
        fan_kwh_saved: fan_kwh_saved,
      };
    },
  },

  /* ── 13. HOT WATER BOILER REPLACEMENT ───────────────── */
  boiler_replacement: {
    id: 'boiler_replacement',
    name: 'Hot Water Boiler Replacement',
    category: 'HVAC Equipment',
    description:
      'Calculates gas savings from replacing an aging hot water boiler with a high-efficiency condensing unit. Uses HDD-based annual load: peak_load × HDD × 24 / design_ΔT. Includes standby loss adjustment for cast iron boilers (+10%) vs. standard (+3%).',
    icon: '🔥',
    inputs: [
      {
        id: 'boiler_cap_btuh',
        label: 'Existing Boiler Input Capacity',
        unit: 'Btu/hr',
        type: 'number',
        default: 1000000,
        min: 10000,
        max: 50000000,
      },
      {
        id: 'eff_old',
        label: 'Existing Boiler Efficiency (Annual Fuel Utilization Efficiency)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. The percentage of fuel burned that becomes useful heat. Typical old boilers: 70–80%.',
        unit: '%',
        type: 'number',
        default: 78,
        min: 60,
        max: 99,
      },
      {
        id: 'eff_new',
        label: 'New Boiler Efficiency (Annual Fuel Utilization Efficiency)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. Modern condensing boilers typically achieve 90–97% AFUE.',
        unit: '%',
        type: 'number',
        default: 95,
        min: 60,
        max: 99,
      },
      {
        id: 'hdd',
        label: 'Annual Heating Degree Days',
        unit: 'HDD',
        type: 'number',
        default: 5000,
        min: 500,
        max: 12000,
      },
      {
        id: 'design_delta_t',
        label: 'Design ΔT (indoor − outdoor)',
        help: 'ΔT — Delta-T, the design temperature difference between indoors and outdoors at peak heating conditions. Used to size the boiler load.',
        unit: '°F',
        type: 'number',
        default: 75,
        min: 30,
        max: 120,
      },
      {
        id: 'oversize_factor',
        label: 'Boiler Oversizing Factor',
        unit: '0–1',
        type: 'number',
        default: 0.85,
        min: 0.5,
        max: 1.0,
      },
      {
        id: 'boiler_type',
        label: 'Existing Boiler Type',
        unit: '',
        type: 'select',
        options: [
          { value: 'cast_iron', label: 'Cast iron / pre-1990 (+10% standby loss adjustment)' },
          { value: 'standard', label: 'Standard gas boiler (+3% standby adjustment)' },
        ],
        default: 'cast_iron',
      },
    ],
    outputs: [
      {
        id: 'annual_heating_mmbtu',
        label: 'Annual Heating Load',
        unit: 'MMBtu/yr',
        formula: 'peak_load × HDD × 24 / design_ΔT  (peak = boiler_cap × oversize_factor)',
      },
      {
        id: 'existing_therms',
        label: 'Existing Therms/Year',
        unit: 'therms/yr',
        formula: 'annual_heating_MMBtu × 10 / eff_old',
        assumption:
          'Assumption not yet checked by an engineer: the boiler capacity you enter is used as the heating load, and that load is then divided by the boiler efficiency.',
      },
      { id: 'new_therms', label: 'New Therms/Year', unit: 'therms/yr', formula: 'annual_heating_MMBtu × 10 / eff_new' },
      {
        id: 'pct_savings',
        label: 'Efficiency Improvement',
        unit: '%',
        formula: '1 − eff_old/eff_new  (before standby adjustment)',
      },
      {
        id: 'therms_saved',
        label: 'Total Therms Saved/Year',
        unit: 'therms/yr',
        formula: '(existing − new) × (1 + standby_factor)  — cast iron: +10%, standard: +3%',
      },
    ],
    calculate(inp) {
      const eo = inp.eff_old / 100;
      const en = inp.eff_new / 100;
      const isCastIron = inp.boiler_type === 'cast_iron';
      const standby_factor = isCastIron ? 0.1 : 0.03;
      const peak_load_btu_hr = inp.boiler_cap_btuh * inp.oversize_factor;
      const annual_heating_btu = (peak_load_btu_hr * inp.hdd * 24) / inp.design_delta_t;
      const annual_heating_mmbtu = Math.round(annual_heating_btu / 1e6);
      const existing_therms = annual_heating_btu / (BTU_PER_THERM * eo);
      const new_therms = annual_heating_btu / (BTU_PER_THERM * en);
      const therms_saved_base = existing_therms - new_therms;
      const therms_saved = therms_saved_base * (1 + standby_factor);
      const pct_savings = Math.round((1 - eo / en) * 1000) / 10;
      return {
        annual_heating_mmbtu: annual_heating_mmbtu,
        existing_therms: Math.round(existing_therms),
        new_therms: Math.round(new_therms),
        pct_savings: pct_savings,
        therms_saved: Math.round(therms_saved),
      };
    },
  },

  /* ── 14. WEATHERIZATION / BUILDING ENVELOPE ─────────── */
  weatherization: {
    id: 'weatherization',
    name: 'Weatherization / Envelope',
    category: 'Envelope',
    description:
      'Estimates heating and cooling savings from insulation, window, or air sealing upgrades. Formula: area × (1/R_old − 1/R_new) × HDD × 24 / (eff × fuel_conversion). Based on ECM #51-69 Weatherization Savings Calc methodology. Cooling: same ΔU applied to CDD.',
    icon: '🏠',
    inputs: [
      { id: 'area', label: 'Affected Assembly Area', unit: 'sf', type: 'number', default: 5000, min: 10, max: 1000000 },
      { id: 'r_old', label: 'Existing R-Value', unit: 'R', type: 'number', default: 11, min: 1, max: 100 },
      { id: 'r_new', label: 'Proposed R-Value', unit: 'R', type: 'number', default: 30, min: 1, max: 100 },
      { id: 'hdd', label: 'Heating Degree Days', unit: 'HDD', type: 'number', default: 5000, min: 500, max: 12000 },
      { id: 'cdd', label: 'Cooling Degree Days', unit: 'CDD', type: 'number', default: 1500, min: 0, max: 5000 },
      { id: 'heat_eff', label: 'Heating System Efficiency', unit: '%', type: 'number', default: 82, min: 50, max: 100 },
      {
        id: 'heat_fuel',
        label: 'Heating Fuel',
        unit: '',
        type: 'select',
        options: [
          { value: 'gas', label: 'Natural gas (therms)' },
          { value: 'electric', label: 'Electric (kWh)' },
        ],
        default: 'gas',
      },
      { id: 'cooling_cop', label: 'Cooling System Coefficient of Performance', unit: 'COP', type: 'number', default: 3.5, min: 1, max: 8 },
    ],
    outputs: [
      {
        id: 'delta_u',
        label: 'U-Value Improvement',
        unit: 'Btu/hr·°F·sf',
        formula: 'ΔU = 1/R_old − 1/R_new  (U-value is conductance; lower R = higher U = more heat loss)',
      },
      {
        id: 'heat_qty',
        label: 'Heating Energy Saved',
        unit: 'therms or kWh/yr',
        formula: 'area × ΔU × HDD × 24 → ÷ ' + THERM_LABEL + ' for therms (gas), ÷ ' + KWH_LABEL + ' for kWh (electric), both ÷ efficiency',
      },

      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved',
        unit: 'kWh/yr',
        formula: 'area × ΔU × CDD × 24 / (COP × ' + KWH_LABEL + ')',
      },
    ],
    calculate(inp) {
      const he = inp.heat_eff / 100;
      const isElecHeat = inp.heat_fuel === 'electric';
      const delta_u = 1 / inp.r_old - 1 / inp.r_new;
      const heat_btu_yr = delta_u * inp.area * inp.hdd * 24;
      const heat_qty = isElecHeat
        ? Math.round(heat_btu_yr / (he * BTU_PER_KWH))
        : Math.round(heat_btu_yr / (BTU_PER_THERM * he));
      const cool_btu_yr = delta_u * inp.area * inp.cdd * 24;
      const cool_kwh_saved = Math.round(cool_btu_yr / (inp.cooling_cop * BTU_PER_KWH));
      return {
        delta_u: Math.round(delta_u * 10000) / 10000,
        heat_qty: heat_qty,
        cool_kwh_saved: cool_kwh_saved,
      };
    },
  },

  /* ── 15. FAN WALL REPLACEMENT ───────────────────────── */
  fan_wall: {
    id: 'fan_wall',
    name: 'Fan Wall Replacement',
    category: 'HVAC Equipment',
    description:
      'Estimates energy savings from replacing a belt-drive centrifugal fan with an EC (electronically commutated) plug fan wall. EC fans eliminate belt drive losses and achieve 92–95% motor+drive efficiency. BHP = (CFM × SP) / (6356 × fan_eff × belt_eff). Cube law applied at average operating speed.',
    icon: '💨',
    inputs: [
      {
        id: 'cfm',
        label: 'System Design Airflow',
        unit: 'CFM',
        type: 'number',
        default: 20000,
        min: 1000,
        max: 500000,
      },
      {
        id: 'static_pressure',
        label: 'Total Static Pressure',
        unit: 'in. w.g.',
        type: 'number',
        default: 2.5,
        min: 0.1,
        max: 10,
      },
      {
        id: 'fan_eff_old',
        label: 'Existing Fan Aerodynamic Efficiency',
        unit: '%',
        type: 'number',
        default: 68,
        min: 40,
        max: 85,
      },
      { id: 'belt_eff', label: 'Belt Drive Efficiency', unit: '%', type: 'number', default: 94, min: 85, max: 99 },
      {
        id: 'motor_eff_old',
        label: 'Existing Motor Efficiency',
        unit: '%',
        type: 'number',
        default: 91,
        min: 70,
        max: 97,
      },
      {
        id: 'fan_eff_new',
        label: 'EC Fan Array Aerodynamic Efficiency',
        unit: '%',
        type: 'number',
        default: 78,
        min: 60,
        max: 90,
      },
      {
        id: 'motor_eff_new',
        label: 'EC Motor+Drive Efficiency',
        unit: '%',
        type: 'number',
        default: 93,
        min: 80,
        max: 97,
      },
      {
        id: 'avg_speed_ratio',
        label: 'Average Operating Speed Ratio',
        unit: '0–1',
        type: 'number',
        default: 0.75,
        min: 0.2,
        max: 1.0,
      },
      {
        id: 'op_hours',
        label: 'Annual Operating Hours',
        unit: 'hr/yr',
        type: 'number',
        default: 3000,
        min: 100,
        max: 8760,
      },
    ],
    outputs: [
      {
        id: 'bhp_old',
        label: 'Existing Fan BHP',
        unit: 'BHP',
        formula: 'BHP = (CFM × SP) / (6356 × fan_eff × belt_eff)  [6356 = unit constant for CFM/in.wg/HP]',
      },
      { id: 'kw_old_design', label: 'Existing kW at Design', unit: 'kW', formula: 'kW = BHP × ' + KW_PER_HP + ' / motor_eff_old' },
      {
        id: 'bhp_new',
        label: 'New EC Fan BHP',
        unit: 'BHP',
        formula: 'BHP = (CFM × SP) / (6356 × ec_fan_eff)  — no belt_eff term (direct drive)',
      },
      {
        id: 'kw_new_design',
        label: 'New kW at Design',
        unit: 'kW',
        formula: 'kW = BHP × ' + KW_PER_HP + ' / ec_motor_eff  — EC motor+drive is 92–95%',
      },
      {
        id: 'pct_improvement',
        label: 'Efficiency Gain at Design',
        unit: '%',
        formula: '(kW_old − kW_new) / kW_old × 100',
      },
      {
        id: 'savings_kwh',
        label: 'Annual kWh Savings',
        unit: 'kWh/yr',
        formula: '(kW_old − kW_new) × avg_speed_ratio³ × op_hours  — cube law at avg operating speed',
      },
    ],
    calculate(inp) {
      const feo = inp.fan_eff_old / 100;
      const be = inp.belt_eff / 100;
      const meo = inp.motor_eff_old / 100;
      const fen = inp.fan_eff_new / 100;
      const men = inp.motor_eff_new / 100;
      const sr = inp.avg_speed_ratio;
      const power_ratio = fanPowerFraction(sr);
      const bhp_old = (inp.cfm * inp.static_pressure) / (6356 * feo * be);
      const kw_old_design = hpToKw(bhp_old, meo);
      const bhp_new = (inp.cfm * inp.static_pressure) / (6356 * fen);
      const kw_new_design = hpToKw(bhp_new, men);
      const kwh_old = kw_old_design * power_ratio * inp.op_hours;
      const kwh_new = kw_new_design * power_ratio * inp.op_hours;
      const savings_kwh = kwh_old - kwh_new;
      const pct_improvement = kw_old_design > 0 ? ((kw_old_design - kw_new_design) / kw_old_design) * 100 : 0;
      return {
        bhp_old: Math.round(bhp_old * 100) / 100,
        kw_old_design: Math.round(kw_old_design * 100) / 100,
        bhp_new: Math.round(bhp_new * 100) / 100,
        kw_new_design: Math.round(kw_new_design * 100) / 100,
        pct_improvement: Math.round(pct_improvement * 10) / 10,
        savings_kwh: Math.round(savings_kwh),
      };
    },
  },

  /* ── 18. FAN SAVINGS (from the Equipment Matrix supply fans and the BAS trends) ── */
  fan_savings: {
    id: 'fan_savings',
    name: 'Fan Savings',
    category: 'HVAC Equipment',
    description:
      'Supply fans of the chosen Equipment Matrix units: a variable-speed drive or efficient motor on a constant-speed fan, a drive in place of a two-speed motor, and a duct static pressure reset where a drive exists. Each unit uses the best data on hand and the form shows which: a measured trend, an Equipment Matrix value or a default. Add fan amps, run hours and speed trends and the estimate refines itself. A projected estimate, not measured and verified savings.',
    icon: '🌀',
    inputs: [
      // Drawn by renderEcmCalculator (ecmFanUnitsFieldHtml): the building's supply-fan units with their data levels.
      { id: 'fan_units', label: 'Fans to include', type: 'fan_units', default: [] },
      // Drawn inside the fan_units table (a checkbox on each unit sized by the national average): the ids the user confirmed.
      { id: 'fan_confirmed', label: 'Sizes confirmed', type: 'fan_confirm', default: [] },
      {
        id: 'lever_vfd',
        label: 'Variable-speed drive or efficient motor on a constant-speed fan',
        type: 'select',
        options: [
          { value: 'yes', label: 'Include' },
          { value: 'no', label: 'Leave out' },
        ],
        default: 'yes',
      },
      {
        id: 'lever_twospeed',
        label: 'Variable-speed drive in place of a two-speed motor',
        type: 'select',
        options: [
          { value: 'yes', label: 'Include' },
          { value: 'no', label: 'Leave out' },
        ],
        default: 'yes',
      },
      {
        id: 'lever_reset',
        label: 'Duct static pressure reset on a fan that has a drive',
        type: 'select',
        options: [
          { value: 'yes', label: 'Include' },
          { value: 'no', label: 'Leave out' },
        ],
        default: 'yes',
      },
      {
        id: 'fan_curve',
        label: 'Fan power curve of a fan with a drive',
        help: 'ASHRAE 90.1 Appendix G part-load curve of a variable-air-volume fan (default, the more conservative on the 30 to 100% speed range), or the fan law with a share of fixed losses.',
        type: 'select',
        options: [
          { value: 'ashraeG', label: 'ASHRAE 90.1 Appendix G variable-air-volume curve' },
          { value: 'affinity', label: 'Fan law (speed cubed) with fixed losses' },
        ],
        default: FAN_DEFAULT_PART_LOAD_CURVE,
      },
      {
        id: 'reset_cut_pct',
        label: 'Duct static pressure cut the reset reaches',
        help: 'Default 20%, a stated assumption. A 20% pressure cut lowers fan power by 25.6% (fan law, with a share of fixed losses; fanResetSavingsFraction).',
        unit: '%',
        type: 'number',
        default: Math.round(FAN_RESET_DEFAULT_PRESSURE_CUT * 100),
        min: 5,
        max: 40,
      },
    ],
    outputs: [
      {
        id: 'baseline_kwh',
        label: 'Baseline Fan Energy of the Chosen Fans',
        unit: 'kWh/yr',
        formula: "Each unit's share of the building's fan end use (getEndUse 'fans'): fan kW x run hours, scaled to fit the building total electricity less cooling and electric heating.",
      },
      {
        id: 'savings_vfd_kwh',
        label: 'Drive on Constant-Speed Fans',
        unit: 'kWh/yr',
        assumption: FAN_VFD_SAVINGS_LABEL,
        formula: 'Fan kW x hours x the mid of the published range (FAN_VFD_SAVINGS_RANGE: low ' + Math.round(FAN_VFD_SAVINGS_RANGE.low * 100) + ', mid ' + Math.round(FAN_VFD_SAVINGS_RANGE.mid * 100) + ', high ' + Math.round(FAN_VFD_SAVINGS_RANGE.high * 100) + ' percent), no fan speed trend needed. Counted only on a unit whose drive status is known: no drive. A unit with a drive is left out.',
      },
      {
        id: 'savings_vfd_low_kwh',
        label: 'Drive on Constant-Speed Fans: Low End',
        unit: 'kWh/yr',
        assumption: 'Not in the total. The counted line above is the mid.',
        formula: 'The same units at the low end of the published range (' + Math.round(FAN_VFD_SAVINGS_RANGE.low * 100) + ' percent).',
      },
      {
        id: 'savings_vfd_high_kwh',
        label: 'Drive on Constant-Speed Fans: High End',
        unit: 'kWh/yr',
        assumption: 'Not in the total. The counted line above is the mid.',
        formula: 'The same units at the high end of the published range (' + Math.round(FAN_VFD_SAVINGS_RANGE.high * 100) + ' percent).',
      },
      {
        id: 'savings_twospeed_kwh',
        label: 'Drive in Place of a Two-Speed Motor',
        unit: 'kWh/yr',
        formula: 'High-speed kW x High hours x (1 - mean power fraction over Low to High). Low hours stay at Low speed. High/Low split: the enable trend if it has one, else the default.',
      },
      {
        id: 'savings_reset_kwh',
        label: 'Duct Static Pressure Reset',
        unit: 'kWh/yr',
        formula: 'Baseline kWh x fanResetSavingsFraction(pressure cut) x share of fans the reset works on (setpoint trend: flat = 1, moving = 0; else the default).',
      },
      { id: 'savings_kwh', label: 'Annual kWh Saved', unit: 'kWh/yr', formula: 'Drive + two-speed drive + reset, on the units whose drive status and size are known. The possible lines below are not in it.' },
      {
        id: 'possible_drive_kwh',
        label: 'Possible if no drive is installed',
        unit: 'kWh/yr',
        assumption: 'Not in the total. Confirm drive status (Has variable speed) of each unit to include it.',
        formula: 'The drive and two-speed drive measures on units whose drive status is unknown.',
      },
      {
        id: 'possible_size_kwh',
        label: 'Possible if the national-average size is confirmed',
        unit: 'kWh/yr',
        assumption: 'Not in the total. Tick "Size is right" on a unit sized by the national average to include it.',
        formula: 'All measures on units sized by the national average ventilation share and not yet confirmed.',
      },
      {
        id: 'savings_kw',
        label: 'Average Demand Reduction While the Fans Run',
        unit: 'kW',
        formula: "Sum over the units of (kWh saved / run hours). Laid over the months by the fan end use's profile when added as a measure.",
      },
    ],
    // The per-unit table under the results (ecmFanDetailHtml).
    detailHtml: (results) => ecmFanDetailHtml(results),
    calculate(inp, ctx) {
      const none = (note) => ({
        baseline_kwh: 0,
        savings_vfd_kwh: 0,
        savings_vfd_low_kwh: 0,
        savings_vfd_high_kwh: 0,
        savings_twospeed_kwh: 0,
        savings_reset_kwh: 0,
        savings_kwh: 0,
        possible_drive_kwh: 0,
        possible_size_kwh: 0,
        savings_kw: 0,
        units: [],
        note: note,
      });
      if (!ctx || !ctx.projId || !ctx.buildingId) return none('Choose a building to list its supply fans.');
      const eu = getEndUse(ctx.projId, ctx.buildingId, 'fans');
      if (eu.source === 'none') return none(eu.sourceLabel);
      const chosen = new Set(inp.fan_units || []);
      const models = eu.units.filter((m) => chosen.has(m.id));
      if (!models.some((m) => m.ok)) return none('Choose at least one fan that has data to size it.');
      const r = fanSavingsForUnits(
        models,
        {
          vfd: inp.lever_vfd !== 'no',
          twoSpeed: inp.lever_twospeed !== 'no',
          reset: inp.lever_reset !== 'no',
          resetCut: inp.reset_cut_pct / 100,
          curve: inp.fan_curve,
          confirmedSizes: inp.fan_confirmed || [],
        },
        eu.capFactor,
      );
      // The lines are sums of the rounded unit values, so the table under the results adds up to the headline.
      const units = r.units.map((u) => {
        const vfd = Math.round(u.vfd);
        const vfdLow = Math.round(u.vfdRange.low);
        const vfdHigh = Math.round(u.vfdRange.high);
        const twoSpeed = Math.round(u.twoSpeed);
        const reset = Math.round(u.reset);
        return {
          id: u.id,
          name: u.name,
          baselineKwh: Math.round(u.baselineKwh),
          vfd: vfd,
          vfdLow: vfdLow,
          vfdHigh: vfdHigh,
          twoSpeed: twoSpeed,
          reset: reset,
          total: vfd + twoSpeed + reset,
          possible: Math.round(u.possible),
          possibleKind: u.possibleKind,
          why: u.why,
        };
      });
      const sumOf = (k) => units.reduce((t, u) => t + u[k], 0);
      return {
        baseline_kwh: sumOf('baselineKwh'),
        savings_vfd_kwh: sumOf('vfd'),
        savings_vfd_low_kwh: sumOf('vfdLow'),
        savings_vfd_high_kwh: sumOf('vfdHigh'),
        savings_twospeed_kwh: sumOf('twoSpeed'),
        savings_reset_kwh: sumOf('reset'),
        savings_kwh: sumOf('total'),
        possible_drive_kwh: units.reduce((t, u) => t + (u.possibleKind === 'drive' ? u.possible : 0), 0),
        possible_size_kwh: units.reduce((t, u) => t + (u.possibleKind === 'size' ? u.possible : 0), 0),
        savings_kw: Math.round(r.savingsKw * 10) / 10,
        units: units,
        note: '',
      };
    },
  },

  /* ── 16. SOLAR (custom full-page calc, no inputs[]/calculate() — routes to openSolarCalc) ── */
  solar: {
    id: 'solar',
    name: 'Solar',
    category: 'Renewables',
    description: 'PV array savings with configurable rate schedules, net metering, and Helioscope data.',
    icon: '☀️',
    custom: true, // launchCalcTemplate opens the dedicated full-page view, not the generic ECM input form
  },

  /* ── 17. BAS (custom full-page calc, no inputs[]/calculate() — routes to openBASCalc) ── */
  bas: {
    id: 'bas',
    name: 'BAS',
    category: 'Controls',
    description:
      'Building Automation savings using weather bin data, setpoints, and schedules. Upload temp/humidity CSV for your city.',
    icon: '🏢',
    custom: true, // launchCalcTemplate opens the dedicated full-page view, not the generic ECM input form
  },
};

/* ─── ECM Project Storage ────────────────────────────── */

/**
 * Get all saved ECMs for a project.
 * @param {string|number} projId
 * @returns {Array}
 */
function getProjectEcms(projId) {
  const projects = typeof sget === 'function' ? sget('en_projects', []) : [];
  const p = projects.find((x) => String(x.id) === String(projId));
  return p && Array.isArray(p.ecms) ? p.ecms : [];
}

/**
 * Sum the yearly value of all saved ECMs of a project. A saved ECM keeps its yearly QUANTITIES (outputs); the
 * dollars are priced now, the same way the Energy Savings matrix prices a measure (ecmBuildMeasure +
 * ecmMeasureDollars: monthly shape from the building's HVAC Load Estimate, baseline-period rates). A saved ECM
 * that has no building, or whose building has no monthly profile, is not priced and adds nothing to the total.
 * @param {string|number} projId
 * @returns {{ total: number, count: number, ecms: Array }}
 */
function getProjectEcmTotal(projId) {
  const ecms = getProjectEcms(projId);
  let total = 0;
  for (const ecm of ecms) {
    const inputs = {};
    Object.keys(ecm.inputs || {}).forEach((k) => {
      const v = ecm.inputs[k];
      inputs[k] = v && typeof v === "object" && "value" in v ? v.value : v;
    });
    const built = ecm.buildingId
      ? ecmBuildMeasure(
          projId,
          ecm.buildingId,
          ecm.templateId,
          inputs,
          ecm.outputs || {},
        )
      : null;
    if (built && built.ok) total += ecmMeasureDollars(projId, built.measure);
  }
  return { total: Math.round(total), count: ecms.length, ecms };
}

/**
 * Save a completed ECM calculation to the project record.
 * @param {string|number} projId
 * @param {string} buildingId
 * @param {string} buildingName
 * @param {string} templateId
 * @param {Object} inputs — key/value map (may include source metadata)
 * @param {Object} outputs — result from calculateEcm()
 * @param {string} [notes]
 * @returns {boolean} success
 */
function saveEcmToProject(projId, buildingId, buildingName, templateId, inputs, outputs, notes) {
  if (typeof sget !== 'function' || typeof sset !== 'function') return false;
  const projects = sget('en_projects', []);
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!p) return false;

  if (!Array.isArray(p.ecms)) p.ecms = [];

  // Build a clean inputs record — strip source metadata for storage,
  // but keep the sourceLabel for display
  const cleanInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === 'object' && v !== null && 'value' in v) {
      cleanInputs[k] = v; // already has { value, source, sourceLabel, manual }
    } else {
      cleanInputs[k] = { value: v, source: 'manual', manual: true };
    }
  }

  const ecmId = 'ecm_' + Date.now() + Math.random().toString(36).slice(2, 6);
  const record = {
    id: ecmId,
    templateId,
    buildingId: buildingId || null,
    buildingName: buildingName || null,
    inputs: cleanInputs,
    outputs,
    savedAt: new Date().toISOString(),
    notes: notes || '',
  };

  // Replace existing record for same template+building combo, or append
  const existIdx = p.ecms.findIndex(
    (e) => e.templateId === templateId && String(e.buildingId || '') === String(buildingId || ''),
  );
  if (existIdx >= 0) {
    p.ecms[existIdx] = record;
  } else {
    p.ecms.push(record);
  }

  sset('en_projects', projects);
  return true;
}

/**
 * Per-template map from a calculate() result field to a savings-matrix column and to the building end use that
 * shapes it over the year (Phase 5, 2026-10-14).
 *   field   - the result id that holds the yearly quantity
 *   kind    - 'kwh' | 'gas' (Therms) | 'kw' (peak kW reduction, laid over the months by the same profile: month kW = peak kW x month weight / highest month weight)
 *   endUse  - ordered end-use keys for getEndUseWeights (computations/end-use.js): the first one that has a
 *             monthly profile in the building's HVAC Load Estimate shapes the field
 *   by      - a field that is gas OR electric depending on a select input: { input, electric: {kind, endUse}, otherwise: {...} }
 * The end use is the best one the load estimate models today. Fans, lighting and plug loads are not modeled
 * separately yet: fan and motor templates use the HVAC electric profile, lighting templates the non-HVAC
 * electric profile (lighting, plug and other together). monthlyFrom:'solar' takes the months from the Solar calculator
 * (solarMonthlyWeights). A template mapped to null has no month-by-month source.
 */
const ECM_MEASURE_FIELD_MAP = {
  oa_dampers: [
    { field: "kwh_saved", kind: "kwh", endUse: ["cooling"] },
    { field: "therms_saved", kind: "gas", endUse: ["heatingGas"] },
  ],
  rtu_replacement: [
    { field: "cooling_kwh_saved", kind: "kwh", endUse: ["cooling"] },
    { field: "heating_therms_saved", kind: "gas", endUse: ["heatingGas"] },
  ],
  vfd_savings: [
    { field: "savings_kwh", kind: "kwh", endUse: ["hvacElectric"] },
  ],
  chiller_replacement: [
    { field: "savings_kwh", kind: "kwh", endUse: ["cooling"] },
    { field: "peak_kw_savings", kind: "kw", endUse: ["cooling"] },
  ],
  oa_erw: [
    { field: "cooling_savings_kwh", kind: "kwh", endUse: ["cooling"] },
    { field: "heating_savings_therms", kind: "gas", endUse: ["heatingGas"] },
    {
      field: "heating_savings_kwh",
      kind: "kwh",
      endUse: ["heatingElectric", "heatingGas"],
    },
  ],
  // Production has no building end use: its months come from the Solar calculator (solarMonthlyWeights, one owner).
  solar_production: [
    { field: "year1_kwh", kind: "kwh", monthlyFrom: "solar" },
  ],
  lighting_replacement: [
    { field: "total_savings_kwh", kind: "kwh", endUse: ["nonHvacElectric"] },
    { field: "demand_savings_kw", kind: "kw", endUse: ["nonHvacElectric"] },
  ],
  occupancy_sensors: [
    { field: "savings_kwh", kind: "kwh", endUse: ["nonHvacElectric"] },
    { field: "demand_savings_kw", kind: "kw", endUse: ["nonHvacElectric"] },
  ],
  pump_vfd: [{ field: "savings_kwh", kind: "kwh", endUse: ["hvacElectric"] }],
  motor_premium: [
    { field: "savings_kwh", kind: "kwh", endUse: ["hvacElectric"] },
  ],
  dcv: [
    { field: "cool_kwh_saved", kind: "kwh", endUse: ["cooling"] },
    { field: "therms_saved", kind: "gas", endUse: ["heatingGas"] },
  ],
  vav_reheat: [
    { field: "cool_kwh_saved", kind: "kwh", endUse: ["cooling"] },
    { field: "fan_kwh_saved", kind: "kwh", endUse: ["hvacElectric"] },
    {
      field: "reheat_saved_qty",
      by: {
        input: "reheat_type",
        electric: { kind: "kwh", endUse: ["heatingElectric", "heatingGas"] },
        otherwise: { kind: "gas", endUse: ["heatingGas"] },
      },
    },
  ],
  boiler_replacement: [
    { field: "therms_saved", kind: "gas", endUse: ["heatingGas"] },
  ],
  weatherization: [
    { field: "cool_kwh_saved", kind: "kwh", endUse: ["cooling"] },
    {
      field: "heat_qty",
      by: {
        input: "heat_fuel",
        electric: { kind: "kwh", endUse: ["heatingElectric", "heatingGas"] },
        otherwise: { kind: "gas", endUse: ["heatingGas"] },
      },
    },
  ],
  fan_wall: [{ field: "savings_kwh", kind: "kwh", endUse: ["hvacElectric"] }],
  // The fan end use (getEndUse 'fans', the Equipment Matrix supply fans) shapes both: a fan runs all year.
  fan_savings: [
    { field: "savings_kwh", kind: "kwh", endUse: ["fans"] },
    { field: "savings_kw", kind: "kw", endUse: ["fans"] },
  ],
};

// The map entries of one template with the gas-or-electric choice resolved from the inputs. null = no month-by-month source.
function _ecmMapEntries(templateId, inputs) {
  const map = ECM_MEASURE_FIELD_MAP[templateId];
  if (!map) return null;
  return map.map((e) => {
    if (!e.by) return e;
    const pick =
      (inputs || {})[e.by.input] === "electric"
        ? e.by.electric
        : e.by.otherwise;
    return { field: e.field, kind: pick.kind, endUse: pick.endUse };
  });
}

/**
 * Build the Energy Savings matrix measure of one calculated template: the yearly quantities of the result laid
 * over the 12 months with the monthly profile of the end use that drives them (getEndUseWeights), never
 * quantity / 12. The measure carries no dollars: ecmMeasureDollars prices it like every matrix row.
 * @returns {{ok:true, measure:Object, shapes:Array}|{ok:false, reason:string}}
 */
function ecmBuildMeasure(projId, bldgId, templateId, inputs, results) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl) return { ok: false, reason: "Unknown template" };
  if (!bldgId)
    return {
      ok: false,
      reason:
        "Choose a building: the monthly shape of the savings comes from that building's HVAC Load Estimate.",
    };
  const entries = _ecmMapEntries(templateId, inputs);
  if (!entries)
    return {
      ok: false,
      reason:
        tmpl.name +
        " has no month-by-month source yet, so it cannot be added to the savings matrix from here.",
    };
  const bldg =
    typeof getUDBldg === "function" ? getUDBldg(projId, bldgId) : null;
  const measure = {
    id: "preview",
    selected: true,
    msrNum: "",
    bldgId: bldgId,
    sqft: bldg ? parseFloat(bldg.sqft) || 0 : 0,
    desc: tmpl.name + (bldg ? " — " + bldg.name : ""),
    kwh: Array(12).fill(0),
    kw: Array(12).fill(0),
    gas: Array(12).fill(0),
    totalDollar: 0,
    rates: {},
    rateSource: "owner",
    source: "ecm_" + templateId,
  };
  const shapes = [];
  for (const e of entries) {
    const qty = parseFloat((results || {})[e.field]) || 0;
    if (!qty) continue;
    const w =
      e.monthlyFrom === "solar"
        ? solarMonthlyWeights(projId)
        : getEndUseWeights(projId, bldgId, e.endUse);
    if (!w.ok)
      return {
        ok: false,
        reason:
          e.monthlyFrom === "solar"
            ? w.reason
            : "No monthly profile for this building. " + w.reason,
      };
    const spread =
      e.kind === "kw"
        ? spreadDemandByWeights(w.weights, qty)
        : spreadEnergyByWeights(w.weights, qty);
    spread.forEach((v, mo) => {
      measure[e.kind][mo] += v;
    });
    shapes.push({
      field: e.field,
      kind: e.kind,
      endUse: w.endUse,
      label: w.eu.label,
      sourceLabel: w.eu.sourceLabel,
    });
  }
  if (!shapes.length)
    return { ok: false, reason: "No savings to add — check inputs" };
  return { ok: true, measure, shapes };
}

// The yearly dollars of a built measure: the Energy Savings matrix pricing (measureRatesNow + calcMeasureDollars,
// baseline-period rates, month by month). The only dollar a template shows.
function ecmMeasureDollars(projId, measure) {
  return calcMeasureDollars(measure, measureRatesNow(projId, measure)).total;
}

/**
 * "Add as Measure" — pushes the built measure (monthly kWh / kW / Therms shaped by the end use) into the project's
 * Energy Savings matrix, which prices it.
 * @param {string|number} projId
 * @param {string} bldgId — building to attribute the measure to (required: its load estimate gives the monthly shape)
 * @param {string} templateId
 * @param {Object} inputs
 * @param {Object} results — from calculateEcm()
 * @returns {boolean} success
 */
function ecmAddAsMeasure(projId, bldgId, templateId, inputs, results) {
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!ECM_TEMPLATES[templateId] || !p) return false;
  const built = ecmBuildMeasure(projId, bldgId, templateId, inputs, results);
  if (!built.ok) {
    if (typeof showToast === "function") showToast(built.reason);
    return false;
  }
  const sd =
    typeof getProjSavingsData === "function"
      ? getProjSavingsData(projId)
      : null;
  if (!sd) return false;
  const measure = built.measure;
  measure.id = "m" + Date.now();
  measure.msrNum = sd.measures.length + 1 + "";
  initMeasureRates(measure, projId, bldgId, "ECM add measure");
  sd.measures.push(measure);
  sset("en_projects", projects);
  if (typeof _svRecalcFrom === "function") _svRecalcFrom(projId);
  if (typeof showToast === "function")
    showToast(
      `Measure "${ECM_TEMPLATES[templateId].name}" added to savings matrix`,
    );
  return true;
}

/* ─── Calculate API ──────────────────────────────────── */

/**
 * Run a template's calculate() function after coercing all inputs to numbers. Returns yearly quantities only.
 * @param {string} templateId
 * @param {Object} inputs — key/value map from the form
 * @param {Object} [ctx] — { projId, buildingId } for a template that reads the building's data (Fan Savings)
 * @returns {Object} results object
 */
function calculateEcm(templateId, inputs, ctx) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl) throw new Error("Unknown ECM template: " + templateId);

  // Coerce inputs to correct types
  const coerced = {};
  tmpl.inputs.forEach((inp) => {
    const raw = inputs[inp.id];
    if (inp.type === "number") {
      coerced[inp.id] = parseFloat(raw) || 0;
    } else {
      coerced[inp.id] = raw != null ? raw : inp.default;
    }
  });
  return tmpl.calculate(coerced, ctx || null);
}
/* ─── Render API ─────────────────────────────────────── */

/**
 * Render the input form for a template into a container element.
 * An input that is a building end-use quantity (inp.endUse, e.g. existing cooling kWh) is prefilled from the
 * building's HVAC Load Estimate through getEndUse and labelled with its source. The precedence is the shared
 * chResolveCalcField rule (app/calc-autofill.js): a typed value stays typed, then the load estimate, then the
 * shipped default flagged as "not from building data".
 * @param {string} templateId
 * @param {HTMLElement} container
 * @param {Object|null} savedValues — values to keep (typed by the person); the rest is prefilled
 * @param {Function} onBack — called when Back is clicked
 * @param {Function} onCalculate — called with (templateId, inputs, results) when Calculate is clicked
 * @param {Object|null} projectContext — { projId, buildingId, buildingName, backLabel } when opened from a project
 * @param {Array<string>} [typedIds] — ids of the inputs a person typed (kept when the building changes)
 */
function renderEcmCalculator(
  templateId,
  container,
  savedValues,
  onBack,
  onCalculate,
  projectContext,
  typedIds,
) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl || !container) return;

  const sv = savedValues || {};
  const ctx = projectContext || null;
  const touched = new Set(typedIds || []);
  const bldgs =
    ctx && ctx.projId && typeof getUDBldgs === "function"
      ? getUDBldgs(ctx.projId)
      : [];

  let endUseInputs = 0;
  let endUseFilled = 0;
  const fields = tmpl.inputs
    .map((inp) => {
      let val =
        sv[inp.id] != null
          ? sv[inp.id]
          : inp.default == null
            ? ""
            : inp.default;
      let hint = null;
      const id = "ecm-inp-" + inp.id;

      if (inp.endUse) {
        endUseInputs++;
        const eu =
          ctx && ctx.buildingId
            ? getEndUse(ctx.projId, ctx.buildingId, inp.endUse)
            : null;
        const auto = endUseFill(eu);
        const r = chResolveCalcField(
          sv[inp.id],
          inp.default,
          auto,
          touched,
          inp.id,
        );
        val = r.value == null ? "" : r.value;
        hint = r.hint;
        if (hint && hint.indexOf("from ") === 0) endUseFilled++;
        else if (hint && eu)
          hint = hint.replace(")", ": " + eu.sourceLabel + ")");
      }

      if (inp.type === "fan_units") return ecmFanUnitsFieldHtml(ctx);
      if (inp.type === "fan_confirm") return "";

      const helpTitle = inp.help
        ? ` title="${_escHtml(inp.help)}"`
        : "";
      const helpCursor = inp.help ? ";cursor:help" : "";

      if (inp.type === "select") {
        const opts = inp.options
          .map(
            (o) =>
              `<option value="${_escHtml(o.value)}" ${o.value === val ? "selected" : ""}>${_escHtml(o.label)}</option>`,
          )
          .join("");
        return `
        <div class="ecm-field-row" style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <label${helpTitle} style="flex:0 0 280px;font-size:12px;font-weight:600;color:var(--text2);padding-top:4px${helpCursor}">${_escHtml(inp.label)}</label>
          <select id="${id}" class="fs ecm-input" data-inp="${_escHtml(inp.id)}" style="flex:1;min-width:200px;font-size:13px">
            ${opts}
          </select>
        </div>`;
      }

      return `
      <div class="ecm-field-row" style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <label for="${id}"${helpTitle} style="flex:0 0 280px;font-size:12px;font-weight:600;color:var(--text2);padding-top:6px${helpCursor}">${_escHtml(inp.label)}${inp.unit ? ' <span style="opacity:.6;font-weight:400">(' + _escHtml(inp.unit) + ")</span>" : ""}</label>
        <div style="flex:1;min-width:160px">
          <input id="${id}" class="fi ecm-input" type="number" data-inp="${_escHtml(inp.id)}"
            value="${_escHtml(val)}"${inp.min != null ? ` min="${inp.min}"` : ""}${inp.max != null ? ` max="${inp.max}"` : ""}
            step="${inp.type === "number" && (val === "" || val < 1) ? "0.001" : "1"}"
            style="width:100%;font-size:13px"
            oninput="_ecmValidateInput(this,${inp.min != null ? inp.min : "null"},${inp.max != null ? inp.max : "null"})" />
          <div id="${id}-hint">${chCalcFieldHintHTML(hint)}</div>
          <div id="${id}-err" style="font-size:11px;color:var(--red,#e55);margin-top:2px;display:none"></div>
        </div>
      </div>`;
    })
    .join("");

  // Building row: the building's HVAC Load Estimate is the baseline and the monthly shape of the savings.
  const bldgOpts = bldgs
    .map(
      (b) =>
        `<option value="${_escHtml(String(b.id))}" ${String(b.id) === String(ctx.buildingId) ? "selected" : ""}>${_escHtml(b.name || "Building")}</option>`,
    )
    .join("");
  const contextBanner =
    ctx && ctx.projId
      ? `<div id="ecm-bldg-row" style="background:var(--s1);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--text2);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
           <label for="ecm-bldg-select" style="font-weight:600;color:var(--text)">Building</label>
           <select id="ecm-bldg-select" class="fs" style="min-width:220px;font-size:13px">
             <option value="">Choose a building</option>${bldgOpts}
           </select>
           <span id="ecm-bldg-note">${
             ctx.buildingId
               ? endUseInputs
                 ? endUseFilled +
                   " of " +
                   endUseInputs +
                   " baseline inputs filled from the HVAC Load Estimate"
                 : "The monthly shape of the savings comes from this building’s HVAC Load Estimate"
               : "Choose a building to fill the baseline from its HVAC Load Estimate and to see the dollar value"
           }</span>
         </div>`
      : "";

  container.innerHTML = `
    <div style="padding:20px;overflow-y:auto;flex:1" id="ecm-calc-form-wrap">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="ecm-back-btn">${_escHtml((ctx && ctx.backLabel) || "← Back")}</button>
        <span style="font-size:20px">${_escHtml(tmpl.icon)}</span>
        <h2 style="font-size:18px;font-weight:700;margin:0;color:var(--text)">${_escHtml(tmpl.name)}</h2>
        <span style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border:1px solid var(--accent);border-radius:10px">${_escHtml(tmpl.category)}</span>
      </div>
      ${contextBanner}
      <p style="font-size:13px;color:var(--text2);margin:0 0 20px;line-height:1.6">${_escHtml(tmpl.description)}</p>

      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Inputs</div>
        <div id="ecm-inputs-container">
          ${fields}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="ecm-reset-btn">Reset Inputs</button>
        <button class="btn btn-em" id="ecm-calc-btn" style="min-width:120px">Calculate</button>
      </div>

      <div id="ecm-results-wrap"></div>
    </div>`;

  // Wire back button
  container.querySelector("#ecm-back-btn").addEventListener("click", () => {
    if (typeof onBack === "function") onBack();
  });

  // Wire the building choice: the baseline and the monthly shape follow the building. Typed values stay.
  const bldgSel = container.querySelector("#ecm-bldg-select");
  if (bldgSel)
    bldgSel.addEventListener("change", () => {
      const typed = {};
      touched.forEach((tid) => {
        const el = container.querySelector("#ecm-inp-" + tid);
        if (el) typed[tid] = el.value;
      });
      const b = bldgs.find((x) => String(x.id) === bldgSel.value);
      renderEcmCalculator(
        templateId,
        container,
        typed,
        onBack,
        onCalculate,
        Object.assign({}, ctx, {
          buildingId: b ? b.id : null,
          buildingName: b ? b.name : null,
        }),
        Array.from(touched),
      );
    });

  // Wire reset button: typed values go, the building's values come back.
  container.querySelector("#ecm-reset-btn").addEventListener("click", () => {
    renderEcmCalculator(
      templateId,
      container,
      null,
      onBack,
      onCalculate,
      ctx,
      [],
    );
  });

  // Fan Savings: "Has variable speed" of a unit is stored once in the Equipment Matrix (emSetAssetEdit); the rows redraw
  // from the stored value and the results shown for the old value go away.
  const fanForm = container.querySelector("#ecm-calc-form-wrap");
  if (fanForm && tmpl.id === "fan_savings")
    fanForm.addEventListener("change", (ev) => {
      const sel = ev.target;
      if (!sel || !sel.classList || !sel.classList.contains("fan-hasvfd")) return;
      emSetAssetEdit(
        ctx.projId,
        sel.getAttribute("data-fan-id"),
        "hasVfd",
        sel.value,
      ).then(() => {
        const keepOf = (cls) =>
          new Set(
            Array.from(container.querySelectorAll(cls))
              .filter((c) => c.checked)
              .map((c) => c.getAttribute("data-fan-id")),
          );
        const keep = keepOf(".fan-unit-pick");
        const keepSize = keepOf(".fan-size-confirm");
        const old = container.querySelector("#ecm-fanunits");
        old.outerHTML = ecmFanUnitsFieldHtml(ctx);
        container.querySelectorAll(".fan-unit-pick").forEach((c) => {
          c.checked = keep.has(c.getAttribute("data-fan-id"));
        });
        container.querySelectorAll(".fan-size-confirm").forEach((c) => {
          c.checked = keepSize.has(c.getAttribute("data-fan-id"));
        });
        container.querySelector("#ecm-results-wrap").innerHTML = "";
      });
    });

  // Wire calculate button
  container.querySelector("#ecm-calc-btn").addEventListener("click", () => {
    const inputs = {};
    let valid = true;
    tmpl.inputs.forEach((inp) => {
      if (inp.type === "fan_units") {
        inputs[inp.id] = Array.from(
          container.querySelectorAll(".fan-unit-pick:checked"),
        ).map((c) => c.getAttribute("data-fan-id"));
        return;
      }
      if (inp.type === "fan_confirm") {
        inputs[inp.id] = Array.from(
          container.querySelectorAll(".fan-size-confirm:checked"),
        ).map((c) => c.getAttribute("data-fan-id"));
        return;
      }
      const el = container.querySelector("#ecm-inp-" + inp.id);
      if (el) {
        inputs[inp.id] =
          inp.type === "number" ? parseFloat(el.value) : el.value;
        if (inp.type === "number" && isNaN(inputs[inp.id])) {
          _ecmShowFieldError(el, "Required");
          valid = false;
        }
      }
    });
    if (!valid) return;

    const results = calculateEcm(
      templateId,
      inputs,
      ctx && ctx.projId
        ? { projId: ctx.projId, buildingId: ctx.buildingId }
        : null,
    );
    renderEcmResults(
      templateId,
      results,
      container.querySelector("#ecm-results-wrap"),
      ctx,
      inputs,
    );

    if (typeof onCalculate === "function")
      onCalculate(templateId, inputs, results);
  });

  // A typed value stays typed: the source marker goes away and the building change keeps the value.
  tmpl.inputs.forEach((inp) => {
    const el = container.querySelector("#ecm-inp-" + inp.id);
    if (el) {
      el.addEventListener("input", () => {
        touched.add(inp.id);
        const hintEl = container.querySelector("#ecm-inp-" + inp.id + "-hint");
        if (hintEl) hintEl.innerHTML = "";
      });
      el.addEventListener("change", () =>
        _ecmValidateInput(el, inp.min, inp.max),
      );
    }
  });
}
/**
 * Render calculation results into a container element.
 * Each output value is clickable and shows the formula that produced it.
 * @param {string} templateId
 * @param {Object} results
 * @param {HTMLElement} container
 * @param {Object|null} projectContext — { projId, buildingId, buildingName } for Save to Project
 * @param {Object|null} inputs — raw input values (for storing with the ECM record)
 */
/* Inject base ECM result cell styles once — these carry the default font-size
   and padding so the zoom rule (#ecm-results-table-wrap td { … }) can override
   them (ID+element specificity beats a class). */
(function _injectEcmResultCSS() {
  if (document.getElementById('ecm-result-cell-styles')) return;
  var s = document.createElement('style');
  s.id = 'ecm-result-cell-styles';
  s.textContent =
    '.ecm-result-cell { font-size:13px; padding:8px 12px; }' +
    '.ecm-result-cell--major { font-size:15px; padding:8px 12px; }' +
    '.ecm-formula-cell { font-size:11px; padding:6px 12px 10px; }';
  document.head.appendChild(s);
})();

function renderEcmResults(templateId, results, container, projectContext, inputs) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl || !container) return;

  const ctx = projectContext || null;

  const rows = tmpl.outputs
    .map((out) => {
      const val = results[out.id];
      const display =
        val === null || val === undefined
          ? '—'
          : out.unit === 'kWh/yr' || out.unit === 'CFM' || out.unit === 'therms/yr'
            ? typeof val === 'number'
              ? val.toLocaleString()
              : val
            : typeof val === 'number' && !Number.isInteger(val)
              ? val.toFixed(3)
              : val;

      const isMajor = out.id === 'savings_kwh';

      return `
      <tr class="ecm-result-row" style="border-bottom:1px solid var(--border)">
        <td class="ecm-result-cell" style="font-weight:${isMajor ? '700' : '400'};color:${isMajor ? 'var(--text)' : 'var(--text2)'}">
          ${_escHtml(out.label)}
          ${out.unit ? `<span style="font-size:11px;font-weight:400;color:var(--text3);margin-left:4px">${_escHtml(out.unit)}</span>` : ''}
          ${out.assumption ? `<div style="font-size:11px;font-weight:400;color:var(--text2);margin-top:3px">${_escHtml(out.assumption)}</div>` : ''}
        </td>
        <td class="${isMajor ? 'ecm-result-cell--major' : 'ecm-result-cell'}" style="text-align:right;font-weight:${isMajor ? '700' : '400'};color:${isMajor ? 'var(--em)' : 'var(--text)'};font-family:var(--mono)">
          ${_escHtml(display)}
        </td>
        <td class="ecm-result-cell" style="text-align:right;width:32px">
          <button class="btn btn-ghost btn-sm"
            style="font-size:10px;padding:2px 6px;opacity:.6"
            title="Show formula"
            onclick="_ecmToggleFormula(this,'${_escHtml(out.id)}')">
            ƒ
          </button>
        </td>
      </tr>
      <tr class="ecm-formula-row" id="ecm-formula-${_escHtml(out.id)}" style="display:none">
        <td colspan="3" class="ecm-formula-cell" style="color:var(--text3);font-family:var(--mono);background:var(--s2);border-bottom:1px solid var(--border)">
          ${_escHtml(out.formula || 'No formula trace available.')}
        </td>
      </tr>`;
    })
    .join('');

  // The dollar value of the result: the Energy Savings matrix pricing of the monthly measure (ecmMeasureDollars).
  // A template computes no dollars and no payback of its own (payback and cost lines come in phase 7).
  const built = ctx && ctx.projId ? ecmBuildMeasure(ctx.projId, ctx.buildingId, templateId, inputs || {}, results) : null;
  const seenShapes = new Set();
  const shapeLines = built && built.ok
    ? built.shapes
        .filter((s) => {
          const k = s.endUse + '|' + s.sourceLabel;
          if (seenShapes.has(k)) return false;
          seenShapes.add(k);
          return true;
        })
        .map((s) => _escHtml(s.label) + ' profile from ' + _escHtml(s.sourceLabel))
        .join('; ')
    : '';
  const valueHtml = built
    ? built.ok
      ? (() => {
          const dollars = ecmMeasureDollars(ctx.projId, built.measure);
          return `<div style="padding:12px 16px;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
              <span style="font-size:13px;font-weight:700;color:var(--text)">Savings value</span>
              <span id="ecm-savings-value" style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--em)">${dollars > 0 ? '$' + Math.round(dollars).toLocaleString() + '/yr' : 'No baseline bill rates yet'}</span>
            </div>
            <div style="font-size:11px;color:var(--text2);margin-top:4px">Priced month by month at this building's baseline-period rates, the same way the Energy Savings matrix prices a measure. Monthly shape: ${shapeLines}.</div>
          </div>`;
        })()
      : `<div id="ecm-savings-value" style="padding:12px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--text2)">${_escHtml(built.reason)}</div>`
    : '';

  const detailHtml = tmpl.detailHtml ? tmpl.detailHtml(results) : '';

  // Build the "Save to Project" + "Add as Measure" footer if a project context is available
  const saveBtnHtml =
    ctx && ctx.projId
      ? `<div style="padding:14px 16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
         <div style="flex:1;min-width:200px">
           <input type="text" id="ecm-save-notes" class="fi" placeholder="Notes (optional — e.g. 'RTU-3 and RTU-4')" style="width:100%;font-size:12px" />
         </div>
         <button class="btn btn-ghost btn-sm" id="ecm-save-to-proj-btn" style="white-space:nowrap">
           Save to ${ctx.buildingName ? _escHtml(ctx.buildingName) : 'Project'}
         </button>
         <span id="ecm-save-status" style="font-size:11px;color:var(--green);display:none">Saved!</span>
         <button class="btn btn-em btn-sm" id="ecm-add-measure-btn" style="white-space:nowrap"${built && built.ok ? '' : ' disabled'}>+ Add as Savings Measure</button>
       </div>`
      : '';

  const _ecmZoomCtrl =
    typeof tableZoomControlHTML === 'function'
      ? tableZoomControlHTML('ecm-results-table-wrap', 'en_ecm_results_zoom', 'ecm-results-zoom-lbl')
      : '';
  container.innerHTML = `
    <div class="card" style="margin-top:4px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Results</span>
        <span style="font-size:11px;color:var(--text3)">— click</span>
        <span style="font-size:11px;font-family:var(--mono);background:var(--s3);padding:1px 6px;border-radius:3px">ƒ</span>
        <span style="font-size:11px;color:var(--text3)">to see formula</span>
        <span style="margin-left:auto">${_ecmZoomCtrl}</span>
      </div>
      <div id="ecm-results-table-wrap">
        <table style="width:100%;border-collapse:collapse">
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      ${detailHtml}
      ${valueHtml}
      ${saveBtnHtml}
    </div>`;

  // Apply persisted zoom to results table
  if (typeof setTableZoom === 'function') {
    requestAnimationFrame(function () {
      setTableZoom('ecm-results-table-wrap', null, 'en_ecm_results_zoom', 'ecm-results-zoom-lbl');
    });
  }

  // Wire Save to Project button
  if (ctx && ctx.projId) {
    const saveBtn = container.querySelector('#ecm-save-to-proj-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const notesEl = container.querySelector('#ecm-save-notes');
        const notes = notesEl ? notesEl.value.trim() : '';
        const ok = saveEcmToProject(
          ctx.projId,
          ctx.buildingId,
          ctx.buildingName,
          templateId,
          inputs || {},
          results,
          notes,
        );
        const status = container.querySelector('#ecm-save-status');
        if (ok) {
          saveBtn.textContent = 'Saved';
          saveBtn.disabled = true;
          if (status) status.style.display = 'inline';
          if (typeof showToast === 'function') {
            showToast('ECM saved to project — projected savings updated');
          }
        } else {
          if (typeof showToast === 'function') showToast('Could not save — project not found', 'warn');
        }
      });
    }
    // Wire "Add as Measure" button
    const addMsrBtn = container.querySelector('#ecm-add-measure-btn');
    if (addMsrBtn) {
      addMsrBtn.addEventListener('click', () => {
        const ok = ecmAddAsMeasure(ctx.projId, ctx.buildingId, templateId, inputs || {}, results);
        if (ok) {
          addMsrBtn.textContent = 'Added ✓';
          addMsrBtn.disabled = true;
          if (typeof closeCalcTemplate === 'function') closeCalcTemplate();
        }
      });
    }
  }
}

/* ─── Fan Savings: the unit picker with data levels, and the per-unit result table ─────────────── */

(function _injectFanTableCSS() {
  if (
    typeof document === "undefined" ||
    document.getElementById("ecm-fan-table-styles")
  )
    return;
  var s = document.createElement("style");
  s.id = "ecm-fan-table-styles";
  s.textContent =
    ".fan-tbl-outer { border:1px solid var(--border); border-radius:6px; overflow:hidden; overflow-x:auto; }" +
    ".fan-tbl { width:100%; border-collapse:separate; border-spacing:0; font-size:12px; }" +
    ".fan-tbl th { background:var(--s1); color:var(--text2); font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; padding:8px 10px; text-align:left; border-right:1px solid var(--border); border-bottom:1px solid var(--border2); }" +
    ".fan-tbl td { padding:6px 10px; color:var(--text); border-right:1px solid var(--border); border-bottom:1px solid var(--border); vertical-align:top; font-variant-numeric:tabular-nums; }" +
    ".fan-tbl th:last-child, .fan-tbl td:last-child { border-right:none; }" +
    ".fan-tbl tbody tr:last-child td { border-bottom:none; }" +
    ".fan-tbl td.fan-num, .fan-tbl th.fan-num { text-align:right; }" +
    ".fan-tbl tfoot td { background:var(--s1); font-weight:700; border-top:2px solid var(--border2); border-bottom:none; }" +
    ".fan-lvl { display:inline-block; font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px; border:1px solid var(--border2); margin-top:2px; }" +
    ".fan-lvl-trend { color:var(--green); border-color:var(--green); }" +
    ".fan-lvl-matrix { color:var(--accent); border-color:var(--accent); }" +
    ".fan-lvl-default { color:var(--text2); }" +
    ".fan-how { font-size:10px; color:var(--text2); }";
  document.head.appendChild(s);
})();

// One value with its data level: the value, a level tag in words (colour is never the only cue) and how it was found.
function ecmFanLevelCell(valueText, level, how) {
  const lv = FAN_LEVEL_LABEL[level] || "";
  return (
    (valueText ? "<div>" + _escHtml(valueText) + "</div>" : "") +
    (lv
      ? '<span class="fan-lvl fan-lvl-' +
        _escHtml(level) +
        '">' +
        _escHtml(lv) +
        "</span>"
      : "") +
    (how ? '<div class="fan-how">' + _escHtml(how) + "</div>" : "")
  );
}

// What would refine the estimate, in plain words, from the units that are not yet at a measured trend.
function ecmFanRefineHints(units) {
  const sized = units.filter((u) => u.ok);
  const hints = [];
  const plural = (c, one, many) => c + " " + (c === 1 ? one : many);
  const count = (f) => sized.filter(f).length;
  const noHours = count((u) => u.hoursLevel !== "trend");
  if (noHours)
    hints.push(
      "Import a fan status (or fan enable) trend for " +
        plural(noHours, "unit", "units") +
        " to replace the default run hours.",
    );
  const estimated = count((u) => u.estimate);
  if (estimated)
    hints.push(
      "Fill the amps, a supply fan airflow or a horsepower in the Equipment Matrix for " +
        plural(estimated, "unit", "units") +
        " now estimated from siblings or the national average ventilation share of the building total electricity.",
    );
  const noAmps = count((u) => u.kwLevel !== "trend" && !u.estimate);
  if (noAmps)
    hints.push(
      "Import a fan amps trend, and fill the voltage and phase in the Equipment Matrix, for " +
        plural(noAmps, "unit", "units") +
        " to replace the fan power estimated from airflow, horsepower or amps with an assumed voltage.",
    );
  const unknownDrive = count((u) => u.driveStatus === "unknown" || (u.twoSpeed && u.driveStatus !== "none" && u.driveStatus !== "has"));
  if (unknownDrive)
    hints.push(
      "Set Has variable speed (Yes or No) for " +
        plural(unknownDrive, "unit", "units") +
        " whose drive status is unknown. A drive is counted in the savings total only for a unit set to No.",
    );
  const national = count((u) => u.sizeBasis === "national");
  if (national)
    hints.push(
      plural(national, "unit", "units") +
        " sized by the national average are not in the savings total until you tick Size is right, or the real amps, airflow or horsepower are in the Equipment Matrix.",
    );
  const noSpeed = count((u) => u.vfd === "yes" && u.profile.level !== "trend");
  if (noSpeed)
    hints.push(
      "Import a fan speed trend for " +
        plural(noSpeed, "unit", "units") +
        " that already have a drive (it replaces the default fan power of a unit sized at full speed).",
    );
  const twoNoTrend = count((u) => u.twoSpeed && u.twoSpeed.level !== "trend");
  if (twoNoTrend)
    hints.push(
      "Import the High and Low fan enable trends for " +
        plural(twoNoTrend, "two-speed unit", "two-speed units") +
        ".",
    );
  const noSet = count(
    (u) => u.vfd === "yes" && !u.twoSpeed && u.reset.level !== "trend",
  );
  if (noSet)
    hints.push(
      "Import a duct static pressure setpoint trend for " +
        plural(noSet, "unit", "units") +
        " with a drive.",
    );
  return hints;
}

// The unit picker of the Fan Savings form: one row per sized supply-fan unit of the building, each input with its data
// level. Units that cannot be sized are named in one line under the table.
function ecmFanUnitsFieldHtml(ctx) {
  const wrap = (inner) =>
    '<div id="ecm-fanunits" style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Fans to include</div>' +
    inner +
    "</div>";
  if (!ctx || !ctx.buildingId)
    return wrap(
      '<div style="font-size:12px;color:var(--text2)">Choose a building to list its supply fans from the Equipment Matrix.</div>',
    );
  const eu = getEndUse(ctx.projId, ctx.buildingId, "fans");
  if (!eu.units)
    return wrap(
      '<div id="ecm-fanunits-none" style="font-size:12px;color:var(--text2)">' +
        _escHtml(eu.sourceLabel) +
        "</div>",
    );
  const byName = (x, y) =>
    String(x.name).localeCompare(String(y.name), undefined, { numeric: true });
  const rows = eu.units
    .filter((u) => u.ok)
    .sort(byName)
    .map((u) => {
      const kwText =
        Math.round(u.kw * 10) / 10 +
        " kW" +
        (u.kwBasis === "full" ? " at full speed" : " while running");
      const hasDrive = u.vfd === "yes";
      const resetApplies = hasDrive && !u.twoSpeed;
      const driveText = hasDrive
        ? "Has a drive"
        : u.driveStatus === "none"
          ? "Constant speed"
          : "Drive status unknown";
      const resetText =
        u.reset.pass === 0
          ? "Already running"
          : u.reset.pass === 1
            ? "None today"
            : Math.round(u.reset.pass * 100) + "% of fans assumed to lack one";
      return (
        "<tr>" +
        '<td><input type="checkbox" class="fan-unit-pick" data-fan-id="' +
        _escHtml(u.id) +
        '" checked aria-label="Include ' +
        _escHtml(u.name) +
        '"></td>' +
        "<td>" +
        _escHtml(u.name || "Unit") +
        '<div class="fan-how">' +
        _escHtml(u.category) +
        "</div></td>" +
        '<td class="fan-num">' +
        ecmFanLevelCell(kwText, u.kwLevel, u.kwHow) +
        (u.sizeBasis === "national"
          ? '<div class="fan-how"><label><input type="checkbox" class="fan-size-confirm" data-fan-id="' +
            _escHtml(u.id) +
            '" aria-label="Size is right: ' +
            _escHtml(u.name) +
            '"> Size is right (national average: not counted until ticked)</label></div>'
          : "") +
        "</td>" +
        '<td class="fan-num">' +
        ecmFanLevelCell(
          Math.round(u.hours).toLocaleString() + " h/yr",
          u.hoursLevel,
          u.hoursHow,
        ) +
        "</td>" +
        "<td>" +
        ecmFanLevelCell(driveText, u.vfdLevel, u.vfdHow) +
        '<div class="fan-how"><label>Has variable speed <select class="fan-hasvfd" data-fan-id="' +
        _escHtml(u.id) +
        '" aria-label="Has variable speed: ' +
        _escHtml(u.name) +
        '">' +
        [["", "Unknown"], ["yes", "Yes"], ["no", "No"]]
          .map(
            (o) =>
              '<option value="' +
              o[0] +
              '"' +
              ((u.hasVfd || "") === o[0] ? " selected" : "") +
              ">" +
              o[1] +
              "</option>",
          )
          .join("") +
        "</select></label></div>" +
        (u.twoSpeed
          ? ""
          : '<div class="fan-how">Speed profile:</div>' +
            ecmFanLevelCell("", u.profile.level, u.profile.how)) +
        "</td>" +
        "<td>" +
        (u.twoSpeed
          ? ecmFanLevelCell(
              Math.round(u.twoSpeed.lowShare * 100) + "% of hours on Low",
              u.twoSpeed.level,
              u.twoSpeed.how,
            )
          : "No") +
        "</td>" +
        "<td>" +
        (resetApplies
          ? ecmFanLevelCell(resetText, u.reset.level, u.reset.how)
          : "Not applicable") +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
  const unsized = eu.units.filter((u) => !u.ok).sort(byName);
  const hints = ecmFanRefineHints(eu.units);
  return wrap(
    '<div id="ecm-fan-enduse" style="font-size:12px;color:var(--text2);margin-bottom:8px">Fan end use of this building: <strong style="color:var(--text)">' +
      Math.round(eu.annual).toLocaleString() +
      " kWh/yr</strong>. " +
      _escHtml(eu.sourceLabel) +
      ".</div>" +
      '<div class="fan-tbl-outer"><table class="fan-tbl"><thead><tr><th></th><th>Unit</th><th class="fan-num">Fan power</th><th class="fan-num">Run hours</th><th>Speed drive</th><th>Two-speed fan</th><th>Static pressure reset</th></tr></thead><tbody>' +
      rows +
      "</tbody></table></div>" +
      (unsized.length
        ? '<div id="ecm-fan-unsized" style="font-size:12px;color:var(--text2);margin-top:8px"><strong style="color:var(--text)">Not sized (' +
          unsized.length +
          ")</strong>: " +
          unsized.map((u) => _escHtml(u.name || "Unit")).join(", ") +
          ". Each needs amps, a supply fan airflow or a horsepower in the Equipment Matrix, and no sibling or building total electricity gives an estimate.</div>"
        : "") +
      (hints.length
        ? '<div id="ecm-fan-hints" style="font-size:12px;color:var(--text2);margin-top:8px"><strong style="color:var(--text)">What would refine this estimate</strong><ul style="margin:4px 0 0 18px;padding:0">' +
          hints.map((h) => "<li>" + _escHtml(h) + "</li>").join("") +
          "</ul></div>"
        : ""),
  );
}
// The per-unit result table under the Fan Savings results, with a totals row.
function ecmFanDetailHtml(results) {
  if (!results) return "";
  if (!results.units || !results.units.length)
    return results.note
      ? '<div id="ecm-fan-note" style="padding:12px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--text2)">' +
          _escHtml(results.note) +
          "</div>"
      : "";
  const n = (v) => (v ? Math.round(v).toLocaleString() : "0");
  const tot = results.units.reduce(
    (a, u) => ({
      b: a.b + u.baselineKwh,
      v: a.v + u.vfd,
      t: a.t + u.twoSpeed,
      r: a.r + u.reset,
      s: a.s + u.total,
      p: a.p + (u.possible || 0),
    }),
    { b: 0, v: 0, t: 0, r: 0, s: 0, p: 0 },
  );
  const names = { vfd: "Drive", twoSpeed: "Two-speed drive", reset: "Reset" };
  const why = (u) =>
    Object.keys(u.why || {})
      .map((k) => names[k] + ": " + u.why[k])
      .join("; ");
  const body = results.units
    .map(
      (u) =>
        "<tr><td>" +
        _escHtml(u.name || "Unit") +
        "</td>" +
        '<td class="fan-num">' +
        n(u.baselineKwh) +
        '</td><td class="fan-num">' +
        n(u.vfd) +
        '</td><td class="fan-num">' +
        n(u.twoSpeed) +
        '</td><td class="fan-num">' +
        n(u.reset) +
        '</td><td class="fan-num">' +
        n(u.total) +
        '</td><td class="fan-num">' +
        n(u.possible) +
        '</td><td class="fan-how">' +
        _escHtml(why(u)) +
        "</td></tr>",
    )
    .join("");
  return (
    '<div style="padding:12px 16px;border-top:1px solid var(--border)"><div class="fan-tbl-outer"><table class="fan-tbl" id="ecm-fan-result-tbl"><thead><tr><th>Unit</th><th class="fan-num">Baseline kWh</th><th class="fan-num">Drive kWh saved</th><th class="fan-num">Two-speed drive kWh saved</th><th class="fan-num">Reset kWh saved</th><th class="fan-num">Total kWh saved</th><th class="fan-num">Possible kWh (not counted)</th><th>Not counted because</th></tr></thead><tbody>' +
    body +
    '</tbody><tfoot><tr><td>Total</td><td class="fan-num">' +
    n(tot.b) +
    '</td><td class="fan-num">' +
    n(tot.v) +
    '</td><td class="fan-num">' +
    n(tot.t) +
    '</td><td class="fan-num">' +
    n(tot.r) +
    '</td><td class="fan-num">' +
    n(tot.s) +
    '</td><td class="fan-num">' +
    n(tot.p) +
    "</td><td></td></tr></tfoot></table></div>" +
    (tot.p
      ? '<div id="ecm-fan-possible" class="fan-how" style="margin-top:6px">' +
        (results.possible_drive_kwh
          ? "Possible if no drive is installed: " +
            n(results.possible_drive_kwh) +
            " kWh — confirm drive status to include. "
          : "") +
        (results.possible_size_kwh
          ? "Possible if the national-average size is confirmed: " + n(results.possible_size_kwh) + " kWh. "
          : "") +
        "These are not in the total above.</div>"
      : "") +
    '<div class="fan-how" style="margin-top:6px">Projected from the data on hand (a measured trend, an Equipment Matrix value or a default, shown for each input above). Not measured and verified savings.</div></div>'
  );
}
/* ─── Input Validation Helpers ───────────────────────── */

function _ecmValidateInput(el, min, max) {
  const errEl = document.getElementById(el.id + '-err');
  const val = parseFloat(el.value);
  if (isNaN(val)) {
    _ecmShowFieldError(el, 'Required');
    return false;
  }
  if (min != null && val < min) {
    _ecmShowFieldError(el, 'Min: ' + min);
    return false;
  }
  if (max != null && val > max) {
    _ecmShowFieldError(el, 'Max: ' + max);
    return false;
  }
  el.style.borderColor = '';
  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }
  return true;
}

function _ecmShowFieldError(el, msg) {
  el.style.borderColor = 'var(--red, #e55)';
  const errEl = document.getElementById(el.id + '-err');
  if (errEl) {
    errEl.style.display = 'block';
    errEl.textContent = msg;
  }
}

function _ecmToggleFormula(btn, outId) {
  const row = document.getElementById('ecm-formula-' + outId);
  if (!row) return;
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'table-row';
  btn.style.opacity = visible ? '.6' : '1';
  btn.style.color = visible ? '' : 'var(--accent)';
}

/* Main view controller (initEcmCalculatorsView, openEcmCalculatorForBuilding, and the
   DOMContentLoaded auto-init) removed 2026-09-22 — the sidebar "ECM Calculators" tab
   they served is gone; the 15 ECM calcs are now launched via the unified Calc Templates
   picker (openCalcTemplates/launchCalcTemplate in calculators.js), which calls
   renderEcmCalculator directly. */
