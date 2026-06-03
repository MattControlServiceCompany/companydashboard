/* ══════════════════════════════════════════════════════
   ECM CALCULATOR LIBRARY — Framework + 3 Templates
   Templates: OA Dampers, RTU Replacement, VFD Savings
   ══════════════════════════════════════════════════════ */

/* ─── Template Registry ──────────────────────────────── */

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
        label: 'Unit Supply Air CFM',
        help: 'CFM — Cubic Feet per Minute. The total volume of air the unit delivers.',
        unit: 'CFM',
        type: 'number',
        default: 10000,
        min: 100,
        max: 200000,
      },
      {
        id: 'design_oa_cfm',
        label: 'Design Minimum OA CFM',
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
          { value: 'stuck_open', label: 'Stuck Fully Open (100% OA)' },
          { value: 'partial', label: 'Stuck Partially Open — enter actual fraction below' },
          { value: 'leakage', label: 'Low-Leakage Upgrade (10% → 1% leakage)' },
        ],
        default: 'stuck_open',
      },
      {
        id: 'actual_oa_fraction',
        label: 'Actual OA Fraction (partial only)',
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
        label: 'Avg ΔT Heating Season (Indoor–Outdoor)',
        help: 'ΔT — Delta-T, the temperature difference between indoors and outdoors. Higher ΔT means more energy is wasted heating excess outdoor air.',
        unit: '°F',
        type: 'number',
        default: 35,
        min: 5,
        max: 80,
      },
      {
        id: 'avg_delta_t_cooling',
        label: 'Avg ΔT Cooling Season (Outdoor–Indoor)',
        help: 'ΔT — Delta-T, the temperature difference between outdoors and indoors. Higher ΔT means more energy is wasted cooling excess outdoor air.',
        unit: '°F',
        type: 'number',
        default: 10,
        min: 0,
        max: 40,
      },
      {
        id: 'boiler_afue',
        label: 'Boiler AFUE',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 80,
        min: 60,
        max: 99,
      },
      {
        id: 'chiller_cop',
        label: 'Chiller / DX COP',
        help: 'COP — Coefficient of Performance. How efficiently the chiller converts electricity into cooling. Higher = more efficient. DX — Direct Expansion (refrigerant-based cooling). Typical range: 3–5.',
        unit: '',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'repair_cost',
        label: 'Repair / Replacement Cost',
        unit: '$',
        type: 'number',
        default: 1500,
        min: 0,
        max: 100000,
      },
    ],
    outputs: [
      {
        id: 'excess_cfm',
        label: 'Excess OA CFM Eliminated',
        unit: 'CFM',
        formula: 'excess_cfm = Design OA CFM (during unoccupied hours, when damper should be closed)',
      },
      {
        id: 'therms_saved',
        label: 'Annual Gas Savings',
        unit: 'therms/yr',
        formula: 'therms = 1.08 × excess_cfm × avg_dT_heating × unocc_heating_hrs / (100,000 × AFUE)',
      },
      {
        id: 'kwh_saved',
        label: 'Annual Cooling Savings',
        unit: 'kWh/yr',
        formula: 'kWh = 1.08 × excess_cfm × avg_dT_cooling × unocc_cooling_hrs / (COP × 3,412)',
      },
      { id: 'gas_savings_dollar', label: 'Annual Gas Savings ($)', unit: '$/yr', formula: 'therms_saved × gas_rate' },
      {
        id: 'elec_savings_dollar',
        label: 'Annual Electric Savings ($)',
        unit: '$/yr',
        formula: 'kwh_saved × elec_rate',
      },
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'gas_savings + elec_savings',
      },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'repair_cost / total_annual_savings' },
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
      const therms_saved = heat_btu_total / (100000 * afue);

      // Cooling energy saved
      const cool_btu_total = 1.08 * excess_cfm * inp.avg_delta_t_cooling * inp.unocc_cooling_hrs;
      const kwh_saved = cool_btu_total / (cop * 3412);

      const gas_savings_dollar = therms_saved * inp.gas_rate;
      const elec_savings_dollar = kwh_saved * inp.elec_rate;
      const total_savings_dollar = gas_savings_dollar + elec_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.repair_cost / total_savings_dollar : Infinity;

      return {
        excess_cfm: Math.round(excess_cfm),
        therms_saved: Math.round(therms_saved),
        kwh_saved: Math.round(kwh_saved),
        gas_savings_dollar: Math.round(gas_savings_dollar),
        elec_savings_dollar: Math.round(elec_savings_dollar),
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
        label: 'Existing Annual Cooling kWh (from utility analysis)',
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
        label: 'Existing Annual Heating Gas (from UA)',
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
      {
        id: 'equipment_cost',
        label: 'Total Equipment & Install Cost',
        unit: '$',
        type: 'number',
        default: 25000,
        min: 0,
        max: 5000000,
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
      {
        id: 'cooling_savings_dollar',
        label: 'Annual Cooling Savings ($)',
        unit: '$/yr',
        formula: 'cooling_kwh_saved × elec_rate',
      },
      {
        id: 'heating_savings_dollar',
        label: 'Annual Heating Savings ($)',
        unit: '$/yr',
        formula: 'heating_therms_saved × gas_rate',
      },
      { id: 'total_savings_dollar', label: 'Total Annual Savings', unit: '$/yr', formula: 'cooling + heating savings' },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula: 'equipment_cost / total_annual_savings',
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
        heating_therms_saved = inp.existing_heating_therms * (inp.pct_replaced / 100) * (1 - eff_existing / eff_new);
      }

      const cooling_savings_dollar = Math.max(0, cooling_kwh_saved) * inp.elec_rate;
      const heating_savings_dollar = heating_therms_saved * inp.gas_rate;
      const total_savings_dollar = cooling_savings_dollar + heating_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.equipment_cost / total_savings_dollar : Infinity;

      return {
        existing_kw_ton: Math.round(existingCurve.ari * 1000) / 1000,
        new_kw_ton: Math.round(newCurve.ari * 1000) / 1000,
        cooling_kwh_saved: Math.round(Math.max(0, cooling_kwh_saved)),
        heating_therms_saved: Math.round(heating_therms_saved),
        cooling_savings_dollar: Math.round(cooling_savings_dollar),
        heating_savings_dollar: Math.round(heating_savings_dollar),
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'vfd_cost',
        label: 'VFD Purchase & Install Cost',
        unit: '$',
        type: 'number',
        default: 5000,
        min: 0,
        max: 500000,
      },
    ],
    outputs: [
      {
        id: 'baseline_kwh',
        label: 'Baseline Energy (before VFD)',
        unit: 'kWh/yr',
        formula: 'HP × 0.746 × (load_before/100) × hours / (eff/100)',
      },
      {
        id: 'post_vfd_kwh',
        label: 'Post-VFD Energy',
        unit: 'kWh/yr',
        formula:
          'Affinity: baseline × (load_after/load_before)³  |  Linear: HP × 0.746 × (load_after/100) × hours / (eff/100)',
      },
      { id: 'savings_kwh', label: 'Annual kWh Saved', unit: 'kWh/yr', formula: 'baseline_kWh − post_vfd_kWh' },
      { id: 'annual_savings_dollar', label: 'Annual Savings ($)', unit: '$/yr', formula: 'savings_kWh × elec_rate' },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'vfd_cost / annual_savings_dollar' },
    ],
    calculate(inp) {
      const eff = inp.motor_eff / 100;

      // Baseline (always linear — motor is running at constant speed)
      const baseline_kwh = (inp.hp * 0.746 * (inp.load_before / 100) * inp.hours) / eff;

      let post_vfd_kwh;
      if (inp.use_affinity === 'affinity') {
        // Affinity law: power ∝ speed³, speed ∝ flow/load
        const speed_ratio = inp.load_after / inp.load_before;
        post_vfd_kwh = baseline_kwh * Math.pow(speed_ratio, 3);
      } else {
        // Linear model (matches Excel template exactly)
        post_vfd_kwh = (inp.hp * 0.746 * (inp.load_after / 100) * inp.hours) / eff;
      }

      const savings_kwh = baseline_kwh - post_vfd_kwh;
      const annual_savings_dollar = savings_kwh * inp.elec_rate;
      const simple_payback = annual_savings_dollar > 0 ? inp.vfd_cost / annual_savings_dollar : Infinity;

      return {
        baseline_kwh: Math.round(baseline_kwh),
        post_vfd_kwh: Math.round(post_vfd_kwh),
        savings_kwh: Math.round(savings_kwh),
        annual_savings_dollar: Math.round(annual_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'demand_rate',
        label: 'Demand Rate',
        unit: '$/kW/mo',
        type: 'number',
        default: 0,
        min: 0,
        max: 30,
      },
      {
        id: 'installed_cost',
        label: 'Installed Cost',
        unit: '$',
        type: 'number',
        default: 250000,
        min: 0,
        max: 5000000,
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
      {
        id: 'energy_savings_dollar',
        label: 'Energy Cost Savings',
        unit: '$/yr',
        formula: 'savings_kWh × elec_rate',
      },
      {
        id: 'demand_savings_dollar',
        label: 'Demand Cost Savings',
        unit: '$/yr',
        formula: 'peak_kW_savings × demand_rate × 12',
      },
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'energy_savings + demand_savings',
      },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula: 'installed_cost / total_annual_savings',
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

      const energy_savings_dollar = savings_kwh * inp.elec_rate;
      const demand_savings_dollar = peak_kw_savings * inp.demand_rate * 12;
      const total_savings_dollar = energy_savings_dollar + demand_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.installed_cost / total_savings_dollar : Infinity;

      return {
        existing_kw_full: Math.round(existing_kw_full * 10) / 10,
        proposed_kw_full: Math.round(proposed_kw_full * 10) / 10,
        savings_kwh: Math.round(savings_kwh),
        peak_kw_savings: Math.round(peak_kw_savings * 10) / 10,
        energy_savings_dollar: Math.round(energy_savings_dollar),
        demand_savings_dollar: Math.round(demand_savings_dollar),
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
        label: 'Outdoor Air CFM',
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
        label: 'Design Winter Outdoor Temp',
        unit: '°F',
        type: 'number',
        default: 10,
        min: -20,
        max: 50,
      },
      {
        id: 'summer_oa_enthalpy',
        label: 'Summer OA Enthalpy',
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
        label: 'Heating Efficiency (AFUE or COP)',
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
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.85, min: 0.1, max: 5.0 },
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'installed_cost',
        label: 'Installed Cost',
        unit: '$',
        type: 'number',
        default: 30000,
        min: 0,
        max: 2000000,
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
        formula: '1.08 × CFM × ΔT_net × heating_hours / (100,000 × AFUE); ΔT_net = ΔT × (1 − ERW_eff)',
      },
      {
        id: 'cooling_savings_kwh',
        label: 'Annual Cooling Electric Savings',
        unit: 'kWh/yr',
        formula: '4.5 × CFM × Δenthalpy_net × cooling_hours / (EER × 1000/3.412); Δh_net = Δh × (1 − ERW_eff)',
      },
      {
        id: 'heating_savings_dollar',
        label: 'Heating Cost Savings',
        unit: '$/yr',
        formula: 'heating_therms × gas_rate  (or heating_kWh × elec_rate if electric)',
      },
      {
        id: 'cooling_savings_dollar',
        label: 'Cooling Cost Savings',
        unit: '$/yr',
        formula: 'cooling_kWh × elec_rate',
      },
      { id: 'total_savings_dollar', label: 'Total Annual Savings', unit: '$/yr', formula: 'heating + cooling savings' },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula: 'installed_cost / total_annual_savings',
      },
    ],
    calculate(inp) {
      // Apply ERW derate: effective_eff = rated × (1 − derate%)
      const erw_winter = (inp.erw_winter_eff / 100) * (1 - inp.erw_derate / 100);
      const erw_summer = (inp.erw_summer_eff / 100) * (1 - inp.erw_derate / 100);

      // ── Heating savings ──
      // Sensible heat formula: Q [BTU/hr] = 1.08 × CFM × ΔT
      // ERW reduces ΔT by pre-heating OA: effective ΔT = raw ΔT × (1 − ERW_eff)
      const delta_t_raw = Math.max(0, inp.heating_setpoint - inp.design_winter_temp);
      const delta_t_net = delta_t_raw * (1 - erw_winter);
      const heat_btu_yr = 1.08 * inp.oa_cfm * delta_t_net * inp.heating_hours;

      // Convert to therms: BTU / (100,000 BTU/therm × AFUE)
      const heating_savings_therms = heat_btu_yr / (100000 * inp.afue);
      const heating_savings_kwh = heat_btu_yr / (inp.afue * 3412); // for electric

      const useGas = inp.heating_fuel < 0.5;
      const heating_savings_dollar = useGas
        ? heating_savings_therms * inp.gas_rate
        : heating_savings_kwh * inp.elec_rate;

      // ── Cooling savings ──
      // Total heat formula: Q [BTU/hr] = 4.5 × CFM × Δenthalpy
      // ERW reduces enthalpy gap: effective Δh = raw Δh × (1 − ERW_eff)
      const delta_h_raw = Math.max(0, inp.summer_oa_enthalpy - inp.target_enthalpy);
      const delta_h_net = delta_h_raw * (1 - erw_summer);
      const cool_btu_yr = 4.5 * inp.oa_cfm * delta_h_net * inp.cooling_hours;

      // kW = BTU/hr / (EER × 1000/3.412); 1 kW = 3,412 BTU/hr → kWh = BTU / (EER × 1000/3.412)
      // Simplified: kWh = BTU_yr / (EER × 293.07)
      const cooling_savings_kwh = cool_btu_yr / (inp.eer * 293.07);
      const cooling_savings_dollar = cooling_savings_kwh * inp.elec_rate;

      const total_savings_dollar = heating_savings_dollar + cooling_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.installed_cost / total_savings_dollar : Infinity;

      return {
        erw_winter_eff_derated: Math.round(erw_winter * 1000) / 10,
        erw_summer_eff_derated: Math.round(erw_summer * 1000) / 10,
        heating_savings_therms: Math.round(heating_savings_therms),
        cooling_savings_kwh: Math.round(cooling_savings_kwh),
        heating_savings_dollar: Math.round(heating_savings_dollar),
        cooling_savings_dollar: Math.round(cooling_savings_dollar),
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
      };
    },
  },

  /* ── 6. SOLAR PRODUCTION ────────────────────────────── */
  solar_production: {
    id: 'solar_production',
    name: 'Solar Production',
    category: 'Renewables',
    description:
      'Estimate annual savings from a rooftop or ground-mounted solar array. Supports both behind-the-meter (retail rate) and net metering (avoided cost) scenarios. Includes ITC credit and lifetime degradation.',
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
        id: 'btm_rate',
        label: 'Blended Rate (BTM scenario)',
        unit: '$/kWh',
        type: 'number',
        default: 0.085,
        min: 0.01,
        max: 0.5,
      },
      {
        id: 'nm_rate',
        label: 'Net Metering Export Rate',
        unit: '$/kWh',
        type: 'number',
        default: 0.045,
        min: 0.01,
        max: 0.3,
      },
      {
        id: 'use_net_metering',
        label: 'Use Net Metering rate? (0=BTM, 1=NM)',
        unit: '',
        type: 'number',
        default: 0,
        min: 0,
        max: 1,
      },
      {
        id: 'cost_per_watt',
        label: 'Installed Cost per Watt',
        unit: '$/W DC',
        type: 'number',
        default: 2.5,
        min: 1.0,
        max: 6.0,
      },
      {
        id: 'itc_rate',
        label: 'Federal ITC Rate',
        unit: '%',
        type: 'number',
        default: 30,
        min: 0,
        max: 30,
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
        id: 'year1_savings_dollar',
        label: 'Year 1 Savings',
        unit: '$/yr',
        formula: 'year1_kWh × rate  (BTM: blended_rate; NM: nm_rate)',
      },
      {
        id: 'gross_cost',
        label: 'Gross System Cost',
        unit: '$',
        formula: 'array_kW × 1,000 × cost_per_watt',
      },
      { id: 'itc_credit', label: 'Federal ITC Credit', unit: '$', formula: 'gross_cost × itc_rate' },
      { id: 'net_cost', label: 'Net Cost (after ITC)', unit: '$', formula: 'gross_cost − ITC_credit' },
      {
        id: 'simple_payback',
        label: 'Simple Payback (post-ITC)',
        unit: 'years',
        formula: 'net_cost / year1_savings',
      },
      {
        id: 'lifetime_kwh',
        label: 'Lifetime Production',
        unit: 'kWh',
        formula: 'geometric series: year1_kWh × (1 − (1−degradation)^years) / degradation',
      },
      {
        id: 'lifetime_savings_dollar',
        label: 'Lifetime Savings',
        unit: '$',
        formula: 'lifetime_kWh × rate',
      },
    ],
    calculate(inp) {
      // Year-1 production: array_kW × kWh/kW_ratio × system_derate
      const year1_kwh = inp.array_kw_dc * inp.production_ratio * (inp.system_derate / 100);

      const rate = inp.use_net_metering >= 0.5 ? inp.nm_rate : inp.btm_rate;
      const year1_savings_dollar = year1_kwh * rate;

      // Cost and ITC (Solar Calc §6.1: P5 = C2 × array_kW × 1000; Q5 = P5 × (1 − ITC))
      const gross_cost = inp.array_kw_dc * 1000 * inp.cost_per_watt;
      const itc_credit = gross_cost * (inp.itc_rate / 100);
      const net_cost = gross_cost - itc_credit;

      // Simple payback post-ITC
      const simple_payback = year1_savings_dollar > 0 ? net_cost / year1_savings_dollar : Infinity;

      // Lifetime production with annual degradation (geometric series)
      const d = inp.annual_degradation / 100;
      const years = inp.analysis_years;
      const lifetime_kwh = d > 0 ? (year1_kwh * (1 - Math.pow(1 - d, years))) / d : year1_kwh * years;
      const lifetime_savings_dollar = lifetime_kwh * rate;

      return {
        year1_kwh: Math.round(year1_kwh),
        year1_savings_dollar: Math.round(year1_savings_dollar),
        gross_cost: Math.round(gross_cost),
        itc_credit: Math.round(itc_credit),
        net_cost: Math.round(net_cost),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
        lifetime_kwh: Math.round(lifetime_kwh),
        lifetime_savings_dollar: Math.round(lifetime_savings_dollar),
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'demand_rate',
        label: 'Demand Rate',
        unit: '$/kW/mo',
        type: 'number',
        default: 8.0,
        min: 0,
        max: 30,
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
      {
        id: 'installed_cost',
        label: 'Installed Cost',
        unit: '$',
        type: 'number',
        default: 50000,
        min: 0,
        max: 5000000,
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
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'total_kWh × elec_rate + demand_kW × demand_rate × 12',
      },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula: 'installed_cost / total_annual_savings',
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

      const energy_dollar = total_savings_kwh * inp.elec_rate;
      const demand_dollar = demand_savings_kw * inp.demand_rate * 12;
      const total_savings_dollar = energy_dollar + demand_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.installed_cost / total_savings_dollar : Infinity;

      return {
        existing_kwh: Math.round(existing_kwh),
        proposed_kwh: Math.round(proposed_kwh),
        base_savings_kwh: Math.round(base_savings_kwh),
        sensor_savings_kwh: Math.round(sensor_savings_kwh),
        total_savings_kwh: Math.round(total_savings_kwh),
        demand_savings_kw: Math.round(demand_savings_kw * 10) / 10,
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'demand_rate',
        label: 'Demand Rate',
        unit: '$/kW/mo',
        type: 'number',
        default: 8.0,
        min: 0,
        max: 30,
      },
      {
        id: 'installed_cost',
        label: 'Installed Cost (all sensors)',
        unit: '$',
        type: 'number',
        default: 15000,
        min: 0,
        max: 2000000,
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
      { id: 'total_savings_dollar', label: 'Total Annual Savings', unit: '$/yr', formula: 'energy + demand savings' },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula: 'installed_cost / total_annual_savings',
      },
    ],
    // TRM vacancy % midpoints by space type
    // Source: missing-ecm-research-2026-05-16.md §ECM2 Table 1 (ComEd/Evergy TRM)
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

      const energy_dollar = savings_kwh * inp.elec_rate;
      const demand_dollar = demand_savings_kw * inp.demand_rate * 12;
      const total_savings_dollar = energy_dollar + demand_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.installed_cost / total_savings_dollar : Infinity;

      return {
        vacancy_pct_used: Math.round(vacancy_pct * 100),
        total_kw: Math.round(total_kw * 10) / 10,
        vacancy_hours: Math.round(vacancy_hours),
        savings_kwh: Math.round(savings_kwh),
        demand_savings_kw: Math.round(demand_savings_kw * 10) / 10,
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
        label: 'Avg Speed Ratio After VFD',
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      { id: 'install_cost', label: 'VFD Install Cost', unit: '$', type: 'number', default: 8000, min: 0, max: 500000 },
    ],
    outputs: [
      {
        id: 'bhp_design',
        label: 'Design BHP',
        unit: 'BHP',
        formula: 'BHP = (GPM × head_ft) / (3960 × pump_eff)  [pump affinity law — 3960 is unit constant for GPM/ft/HP]',
      },
      { id: 'kw_design', label: 'Design kW', unit: 'kW', formula: 'kW = BHP × 0.746 / motor_eff' },
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
      { id: 'annual_savings_dollar', label: 'Annual Cost Savings', unit: '$/yr', formula: 'savings_kwh × elec_rate' },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'install_cost / annual_cost_savings' },
    ],
    calculate(inp) {
      const pe = inp.pump_eff / 100;
      const me = inp.motor_eff / 100;
      const sr = inp.avg_speed_ratio;
      const bhp_design = (inp.gpm * inp.head_ft) / (3960 * pe);
      const kw_design = (bhp_design * 0.746) / me;
      const kwh_existing = kw_design * inp.op_hours;
      const kwh_new = kw_design * Math.pow(sr, 3) * inp.op_hours;
      const savings_kwh = kwh_existing - kwh_new;
      const annual_savings_dollar = savings_kwh * inp.elec_rate;
      const simple_payback = annual_savings_dollar > 0 ? inp.install_cost / annual_savings_dollar : Infinity;
      return {
        bhp_design: Math.round(bhp_design * 100) / 100,
        kw_design: Math.round(kw_design * 100) / 100,
        kwh_existing: Math.round(kwh_existing),
        kwh_new: Math.round(kwh_new),
        savings_kwh: Math.round(savings_kwh),
        annual_savings_dollar: Math.round(annual_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
      };
    },
  },

  /* ── 10. PREMIUM EFFICIENCY MOTOR ───────────────────── */
  motor_premium: {
    id: 'motor_premium',
    name: 'Premium Efficiency Motor',
    category: 'Motors & Drives',
    description:
      'Calculates energy savings from replacing a standard-efficiency motor with a NEMA Premium (IE3) motor. Savings formula: HP × 0.746 × load_factor × hours × (1/eff_old − 1/eff_new) × rate. Supports full-replacement and incremental-cost payback (premium vs. standard motor at failure).',
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'total_cost',
        label: 'Total Replacement Cost',
        unit: '$',
        type: 'number',
        default: 1000,
        min: 0,
        max: 500000,
      },
      {
        id: 'incr_cost',
        label: 'Incremental Cost (premium vs. standard at failure)',
        unit: '$',
        type: 'number',
        default: 200,
        min: 0,
        max: 50000,
      },
    ],
    outputs: [
      { id: 'shaft_hp', label: 'Shaft HP', unit: 'HP', formula: 'shaft_hp = nameplate_HP × load_factor' },
      { id: 'kw_old', label: 'Existing Motor kW', unit: 'kW', formula: 'kW = shaft_hp × 0.746 / eff_old' },
      { id: 'kw_new', label: 'New Motor kW', unit: 'kW', formula: 'kW = shaft_hp × 0.746 / eff_new' },
      {
        id: 'savings_kwh',
        label: 'Annual kWh Savings',
        unit: 'kWh/yr',
        formula: '(kW_old − kW_new) × op_hours  — same shaft load, fewer input watts',
      },
      { id: 'annual_savings_dollar', label: 'Annual Cost Savings', unit: '$/yr', formula: 'savings_kwh × elec_rate' },
      {
        id: 'payback_full',
        label: 'Payback — Full Cost',
        unit: 'years',
        formula: 'total_cost / annual_savings_dollar',
      },
      {
        id: 'payback_incr',
        label: 'Payback — Incremental Cost',
        unit: 'years',
        formula:
          'incr_cost / annual_savings_dollar  (motor replaced anyway at failure — only the premium delta matters)',
      },
    ],
    calculate(inp) {
      const eo = inp.eff_old / 100;
      const en = inp.eff_new / 100;
      const shaft_hp = inp.hp * inp.load_factor;
      const kw_old = (shaft_hp * 0.746) / eo;
      const kw_new = (shaft_hp * 0.746) / en;
      const savings_kwh = (kw_old - kw_new) * inp.op_hours;
      const annual_savings_dollar = savings_kwh * inp.elec_rate;
      const payback_full = annual_savings_dollar > 0 ? inp.total_cost / annual_savings_dollar : Infinity;
      const payback_incr = annual_savings_dollar > 0 ? inp.incr_cost / annual_savings_dollar : Infinity;
      return {
        shaft_hp: Math.round(shaft_hp * 100) / 100,
        kw_old: Math.round(kw_old * 1000) / 1000,
        kw_new: Math.round(kw_new * 1000) / 1000,
        savings_kwh: Math.round(savings_kwh),
        annual_savings_dollar: Math.round(annual_savings_dollar),
        payback_full: payback_full === Infinity ? null : Math.round(payback_full * 10) / 10,
        payback_incr: payback_incr === Infinity ? null : Math.round(payback_incr * 10) / 10,
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
        label: 'Design OA CFM (full occupancy)',
        unit: 'CFM',
        type: 'number',
        default: 2290,
        min: 50,
        max: 100000,
      },
      {
        id: 'per_person_frac',
        label: 'Per-Person OA Fraction of Total OA',
        unit: '0–1',
        type: 'number',
        default: 0.76,
        min: 0.1,
        max: 1.0,
      },
      {
        id: 'avg_occ_frac',
        label: 'Avg Occupancy During Occupied Hours',
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
        label: 'Avg Heating ΔT (indoor − outdoor)',
        help: 'ΔT — Delta-T, the temperature difference between indoors and outdoors during heating season.',
        unit: '°F',
        type: 'number',
        default: 35,
        min: 5,
        max: 80,
      },
      {
        id: 'boiler_afue',
        label: 'Boiler AFUE',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 82,
        min: 60,
        max: 99,
      },
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
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
        label: 'Avg Cooling ΔT (outdoor − indoor)',
        help: 'ΔT — Delta-T, the temperature difference between outdoors and indoors during cooling season.',
        unit: '°F',
        type: 'number',
        default: 10,
        min: 0,
        max: 40,
      },
      {
        id: 'chiller_cop',
        label: 'Cooling System COP',
        help: 'COP — Coefficient of Performance. How efficiently the cooling system converts electricity into cooling. Higher = more efficient. Typical range: 3–5.',
        unit: 'COP',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'install_cost',
        label: 'CO2 Sensor Install Cost',
        unit: '$',
        type: 'number',
        default: 3750,
        min: 0,
        max: 500000,
      },
    ],
    outputs: [
      {
        id: 'oa_reduction_pct',
        label: 'Avg OA Reduction',
        unit: '%',
        formula: 'per_person_frac × (1 − avg_occ_frac)  — only per-person component varies with CO2',
      },
      { id: 'cfm_saved', label: 'Avg CFM Reduced', unit: 'CFM', formula: 'oa_cfm_design × oa_reduction_frac' },
      {
        id: 'therms_saved',
        label: 'Heating Therms Saved',
        unit: 'therms/yr',
        formula: '1.08 × cfm_saved × avg_dt_heat × heat_hours / (100,000 × AFUE)',
      },
      { id: 'gas_savings_dollar', label: 'Heating Cost Savings', unit: '$/yr', formula: 'therms_saved × gas_rate' },
      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved',
        unit: 'kWh/yr',
        formula: '1.08 × cfm_saved × avg_dt_cool × cool_hours / (COP × 3,412)',
      },
      { id: 'cool_savings_dollar', label: 'Cooling Cost Savings', unit: '$/yr', formula: 'cool_kwh_saved × elec_rate' },
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'gas_savings + cooling_savings',
      },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'install_cost / total_annual_savings' },
    ],
    calculate(inp) {
      const afue = inp.boiler_afue / 100;
      const avgOaReduction = inp.per_person_frac * (1 - inp.avg_occ_frac);
      const cfm_saved = inp.oa_cfm_design * avgOaReduction;
      const heat_btu = 1.08 * cfm_saved * inp.avg_dt_heat * inp.heat_hours;
      const therms_saved = heat_btu / (100000 * afue);
      const gas_savings_dollar = therms_saved * inp.gas_rate;
      const cool_btu = 1.08 * cfm_saved * inp.avg_dt_cool * inp.cool_hours;
      const cool_kwh_saved = cool_btu / (inp.chiller_cop * 3412);
      const cool_savings_dollar = cool_kwh_saved * inp.elec_rate;
      const total_savings_dollar = gas_savings_dollar + cool_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.install_cost / total_savings_dollar : Infinity;
      return {
        oa_reduction_pct: Math.round(avgOaReduction * 1000) / 10,
        cfm_saved: Math.round(cfm_saved),
        therms_saved: Math.round(therms_saved),
        gas_savings_dollar: Math.round(gas_savings_dollar),
        cool_kwh_saved: Math.round(cool_kwh_saved),
        cool_savings_dollar: Math.round(cool_savings_dollar),
        total_savings_dollar: Math.round(total_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
      };
    },
  },

  /* ── 12. VAV REHEAT OPTIMIZATION ────────────────────── */
  vav_reheat: {
    id: 'vav_reheat',
    name: 'VAV Reheat Optimization',
    category: 'HVAC Controls',
    description:
      'Estimates savings from reducing simultaneous heating and cooling in VAV systems via two measures: (1) Supply Air Temperature (SAT) reset — raise SAT during mild weather so reheat zones need less heat while the AHU cools less air; (2) Minimum airflow setpoint reduction — per ASHRAE Guideline 36.',
    icon: '🔁',
    inputs: [
      {
        id: 'system_cfm',
        label: 'Total System CFM',
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
        label: 'Avg Reheat Reduction from SAT Reset',
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
        label: 'Boiler AFUE (gas reheat only)',
        help: 'AFUE — Annual Fuel Utilization Efficiency. How much of the fuel burned becomes useful heat. Older boilers: 70–80%. Modern high-efficiency: 85–95%.',
        unit: '%',
        type: 'number',
        default: 82,
        min: 60,
        max: 99,
      },
      {
        id: 'cooling_cop',
        label: 'Cooling System COP',
        help: 'COP — Coefficient of Performance. How efficiently the cooling system converts electricity into cooling. Higher = more efficient. Typical range: 3–5.',
        unit: 'COP',
        type: 'number',
        default: 3.5,
        min: 1,
        max: 8,
      },
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
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
        label: 'Fan Motor kW at Design CFM',
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
      {
        id: 'install_cost',
        label: 'Controls Install Cost',
        unit: '$',
        type: 'number',
        default: 5000,
        min: 0,
        max: 500000,
      },
    ],
    outputs: [
      {
        id: 'reheat_saved_qty',
        label: 'Reheat Savings (therms or kWh)',
        unit: 'therms or kWh/yr',
        formula: '1.08 × (system_cfm × pct_zones) × avg_dT × season_hours → ÷ (100,000×AFUE) gas, ÷ 3412 electric',
      },
      {
        id: 'reheat_savings_dollar',
        label: 'Reheat Energy Cost Savings',
        unit: '$/yr',
        formula: 'reheat_qty × gas_rate or elec_rate',
      },
      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved (SAT reset)',
        unit: 'kWh/yr',
        formula:
          '1.08 × system_cfm × avg_dT × season_hours × 0.30 / (COP × 3,412)  — 30% of airflow benefits from SAT reset',
      },
      {
        id: 'fan_kwh_saved',
        label: 'Fan kWh Saved (min flow)',
        unit: 'kWh/yr',
        formula: 'fan_kW × (min_old_ratio³ − min_new_ratio³) × unocc_hours  — cube law on airflow fraction',
      },
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'reheat_cost + cooling_cost + fan_cost',
      },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'install_cost / total_annual_savings' },
    ],
    calculate(inp) {
      const pct = inp.pct_zones_heat / 100;
      const afue = inp.boiler_afue / 100;
      const mfOld = inp.min_flow_old / 100;
      const mfNew = inp.min_flow_new / 100;
      const isElec = inp.reheat_type === 'electric';
      const zones_cfm = inp.system_cfm * pct;
      const reheat_btu_total = 1.08 * zones_cfm * inp.avg_dt_reheat * inp.season_hours;
      let reheat_saved_qty, reheat_savings_dollar;
      if (isElec) {
        reheat_saved_qty = Math.round(reheat_btu_total / 3412);
        reheat_savings_dollar = Math.round(reheat_saved_qty * inp.elec_rate);
      } else {
        reheat_saved_qty = Math.round(reheat_btu_total / (100000 * afue));
        reheat_savings_dollar = Math.round(reheat_saved_qty * inp.gas_rate);
      }
      const cool_btu = 1.08 * inp.system_cfm * inp.avg_dt_reheat * inp.season_hours * 0.3;
      const cool_kwh_saved = Math.round(cool_btu / (inp.cooling_cop * 3412));
      const cool_dollar = Math.round(cool_kwh_saved * inp.elec_rate);
      const fan_kwh_saved = Math.max(
        0,
        Math.round(inp.fan_kw_design * (Math.pow(mfOld, 3) - Math.pow(mfNew, 3)) * inp.unocc_hours),
      );
      const fan_dollar = Math.round(fan_kwh_saved * inp.elec_rate);
      const total_savings_dollar = reheat_savings_dollar + cool_dollar + fan_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.install_cost / total_savings_dollar : Infinity;
      return {
        reheat_saved_qty: reheat_saved_qty,
        reheat_savings_dollar: reheat_savings_dollar,
        cool_kwh_saved: cool_kwh_saved,
        fan_kwh_saved: fan_kwh_saved,
        total_savings_dollar: total_savings_dollar,
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
      };
    },
  },

  /* ── 13. HOT WATER BOILER REPLACEMENT ───────────────── */
  boiler_replacement: {
    id: 'boiler_replacement',
    name: 'Hot Water Boiler Replacement',
    category: 'HVAC Equipment',
    description:
      'Calculates gas savings from replacing an aging hot water boiler with a high-efficiency condensing unit. Uses HDD-based annual load: peak_load × HDD × 24 / design_ΔT. Includes standby loss adjustment for cast iron boilers (+10%) vs. standard (+3%). Supports full and incremental (end-of-life) payback.',
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
        label: 'Existing Boiler AFUE',
        help: 'AFUE — Annual Fuel Utilization Efficiency. The percentage of fuel burned that becomes useful heat. Typical old boilers: 70–80%.',
        unit: '%',
        type: 'number',
        default: 78,
        min: 60,
        max: 99,
      },
      {
        id: 'eff_new',
        label: 'New Boiler AFUE',
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
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
      {
        id: 'install_cost',
        label: 'Boiler Install Cost (full)',
        unit: '$',
        type: 'number',
        default: 55000,
        min: 0,
        max: 5000000,
      },
      {
        id: 'incr_cost',
        label: 'Incremental Cost vs. Standard',
        unit: '$',
        type: 'number',
        default: 15000,
        min: 0,
        max: 2000000,
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
        label: 'Existing Therms/yr',
        unit: 'therms/yr',
        formula: 'annual_heating_MMBtu × 10 / eff_old',
      },
      { id: 'new_therms', label: 'New Therms/yr', unit: 'therms/yr', formula: 'annual_heating_MMBtu × 10 / eff_new' },
      {
        id: 'pct_savings',
        label: 'Efficiency Improvement',
        unit: '%',
        formula: '1 − eff_old/eff_new  (before standby adjustment)',
      },
      {
        id: 'therms_saved',
        label: 'Total Therms Saved/yr',
        unit: 'therms/yr',
        formula: '(existing − new) × (1 + standby_factor)  — cast iron: +10%, standard: +3%',
      },
      { id: 'annual_savings_dollar', label: 'Annual Gas Savings', unit: '$/yr', formula: 'therms_saved × gas_rate' },
      { id: 'payback_full', label: 'Payback — Full Cost', unit: 'years', formula: 'install_cost / annual_savings' },
      {
        id: 'payback_incr',
        label: 'Payback — Incremental',
        unit: 'years',
        formula: 'incr_cost / annual_savings  (if replacing at end-of-life anyway — only delta to condensing matters)',
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
      const existing_therms = annual_heating_btu / (100000 * eo);
      const new_therms = annual_heating_btu / (100000 * en);
      const therms_saved_base = existing_therms - new_therms;
      const therms_saved = therms_saved_base * (1 + standby_factor);
      const pct_savings = Math.round((1 - eo / en) * 1000) / 10;
      const annual_savings_dollar = therms_saved * inp.gas_rate;
      const payback_full = annual_savings_dollar > 0 ? inp.install_cost / annual_savings_dollar : Infinity;
      const payback_incr = annual_savings_dollar > 0 ? inp.incr_cost / annual_savings_dollar : Infinity;
      return {
        annual_heating_mmbtu: annual_heating_mmbtu,
        existing_therms: Math.round(existing_therms),
        new_therms: Math.round(new_therms),
        pct_savings: pct_savings,
        therms_saved: Math.round(therms_saved),
        annual_savings_dollar: Math.round(annual_savings_dollar),
        payback_full: payback_full === Infinity ? null : Math.round(payback_full * 10) / 10,
        payback_incr: payback_incr === Infinity ? null : Math.round(payback_incr * 10) / 10,
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
      { id: 'cooling_cop', label: 'Cooling System COP', unit: 'COP', type: 'number', default: 3.5, min: 1, max: 8 },
      { id: 'gas_rate', label: 'Gas Rate', unit: '$/therm', type: 'number', default: 0.8, min: 0.1, max: 5.0 },
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      { id: 'install_cost', label: 'Install Cost', unit: '$', type: 'number', default: 25000, min: 0, max: 5000000 },
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
        formula: 'area × ΔU × HDD × 24 → ÷ 100,000 for therms (gas), ÷ 3,412 for kWh (electric), both ÷ efficiency',
      },
      {
        id: 'heat_savings_dollar',
        label: 'Heating Cost Savings',
        unit: '$/yr',
        formula: 'heat_qty × rate (gas_rate for therms, elec_rate for kWh)',
      },
      {
        id: 'cool_kwh_saved',
        label: 'Cooling kWh Saved',
        unit: 'kWh/yr',
        formula: 'area × ΔU × CDD × 24 / (COP × 3,412)',
      },
      { id: 'cool_savings_dollar', label: 'Cooling Cost Savings', unit: '$/yr', formula: 'cool_kwh_saved × elec_rate' },
      {
        id: 'total_savings_dollar',
        label: 'Total Annual Savings',
        unit: '$/yr',
        formula: 'heat_savings + cooling_savings',
      },
      { id: 'simple_payback', label: 'Simple Payback', unit: 'years', formula: 'install_cost / total_annual_savings' },
    ],
    calculate(inp) {
      const he = inp.heat_eff / 100;
      const isElecHeat = inp.heat_fuel === 'electric';
      const delta_u = 1 / inp.r_old - 1 / inp.r_new;
      const heat_btu_yr = delta_u * inp.area * inp.hdd * 24;
      let heat_qty, heat_savings_dollar;
      if (isElecHeat) {
        heat_qty = Math.round(heat_btu_yr / (he * 3412));
        heat_savings_dollar = Math.round(heat_qty * inp.elec_rate);
      } else {
        heat_qty = Math.round(heat_btu_yr / (100000 * he));
        heat_savings_dollar = Math.round(heat_qty * inp.gas_rate);
      }
      const cool_btu_yr = delta_u * inp.area * inp.cdd * 24;
      const cool_kwh_saved = Math.round(cool_btu_yr / (inp.cooling_cop * 3412));
      const cool_savings_dollar = Math.round(cool_kwh_saved * inp.elec_rate);
      const total_savings_dollar = heat_savings_dollar + cool_savings_dollar;
      const simple_payback = total_savings_dollar > 0 ? inp.install_cost / total_savings_dollar : Infinity;
      return {
        delta_u: Math.round(delta_u * 10000) / 10000,
        heat_qty: heat_qty,
        heat_savings_dollar: heat_savings_dollar,
        cool_kwh_saved: cool_kwh_saved,
        cool_savings_dollar: cool_savings_dollar,
        total_savings_dollar: total_savings_dollar,
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
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
        label: 'Avg Operating Speed Ratio',
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
      { id: 'elec_rate', label: 'Electric Rate', unit: '$/kWh', type: 'number', default: 0.085, min: 0.01, max: 1.0 },
      {
        id: 'install_cost',
        label: 'Fan Wall Install Cost',
        unit: '$',
        type: 'number',
        default: 45000,
        min: 0,
        max: 5000000,
      },
    ],
    outputs: [
      {
        id: 'bhp_old',
        label: 'Existing Fan BHP',
        unit: 'BHP',
        formula: 'BHP = (CFM × SP) / (6356 × fan_eff × belt_eff)  [6356 = unit constant for CFM/in.wg/HP]',
      },
      { id: 'kw_old_design', label: 'Existing kW at Design', unit: 'kW', formula: 'kW = BHP × 0.746 / motor_eff_old' },
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
        formula: 'kW = BHP × 0.746 / ec_motor_eff  — EC motor+drive is 92–95%',
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
      { id: 'annual_savings_dollar', label: 'Annual Cost Savings', unit: '$/yr', formula: 'savings_kwh × elec_rate' },
      {
        id: 'simple_payback',
        label: 'Simple Payback',
        unit: 'years',
        formula:
          'install_cost / annual_savings  (note: energy-only payback typically 10–25 yrs; fan walls often justified by maintenance savings + AHU replacement decision)',
      },
    ],
    calculate(inp) {
      const feo = inp.fan_eff_old / 100;
      const be = inp.belt_eff / 100;
      const meo = inp.motor_eff_old / 100;
      const fen = inp.fan_eff_new / 100;
      const men = inp.motor_eff_new / 100;
      const sr = inp.avg_speed_ratio;
      const power_ratio = Math.pow(sr, 3);
      const bhp_old = (inp.cfm * inp.static_pressure) / (6356 * feo * be);
      const kw_old_design = (bhp_old * 0.746) / meo;
      const bhp_new = (inp.cfm * inp.static_pressure) / (6356 * fen);
      const kw_new_design = (bhp_new * 0.746) / men;
      const kwh_old = kw_old_design * power_ratio * inp.op_hours;
      const kwh_new = kw_new_design * power_ratio * inp.op_hours;
      const savings_kwh = kwh_old - kwh_new;
      const annual_savings_dollar = savings_kwh * inp.elec_rate;
      const pct_improvement = kw_old_design > 0 ? ((kw_old_design - kw_new_design) / kw_old_design) * 100 : 0;
      const simple_payback = annual_savings_dollar > 0 ? inp.install_cost / annual_savings_dollar : Infinity;
      return {
        bhp_old: Math.round(bhp_old * 100) / 100,
        kw_old_design: Math.round(kw_old_design * 100) / 100,
        bhp_new: Math.round(bhp_new * 100) / 100,
        kw_new_design: Math.round(kw_new_design * 100) / 100,
        pct_improvement: Math.round(pct_improvement * 10) / 10,
        savings_kwh: Math.round(savings_kwh),
        annual_savings_dollar: Math.round(annual_savings_dollar),
        simple_payback: simple_payback === Infinity ? null : Math.round(simple_payback * 10) / 10,
      };
    },
  },
};

/* ─── Project Rate Helper ────────────────────────────── */

/**
 * Compute average energy rates for a project from the last 12 months of bills.
 * Returns an object with electric_rate, gas_rate, demand_rate, and source labels.
 * Reads from the runtime utilityData object populated by loadUtilityData().
 * @param {string|number} projId
 * @returns {{ electric_rate: number|null, gas_rate: number|null, demand_rate: number|null, sourceLabel: string, billCount: number }}
 */
function getProjectRates(projId) {
  const result = {
    electric_rate: null,
    gas_rate: null,
    demand_rate: null,
    sourceLabel: '',
    billCount: 0,
  };

  // utilityData is the runtime object in core.js / utility-data.js
  const ud = typeof utilityData !== 'undefined' && utilityData ? utilityData[projId] : null;
  if (!ud || !ud.buildings) return result;

  const now = new Date();
  const cutoff = new Date(now.getFullYear() - 1, now.getMonth(), 1); // 12 months back

  let elecCost = 0,
    elecKwh = 0,
    elecBills = 0;
  let gasCost = 0,
    gasTherms = 0,
    gasBills = 0;
  let demandCharge = 0,
    demandKw = 0,
    demandBills = 0;

  for (const bldg of ud.buildings) {
    for (const meter of bldg.meters || []) {
      const commodity = (meter.commodity || '').toLowerCase();
      const isElec = commodity === 'electric';
      const isGas = commodity === 'gas' || commodity === 'natural gas';

      for (const bill of meter.bills || []) {
        // Only use last 12 months
        const billEnd = bill.end ? new Date(bill.end + 'T12:00:00') : null;
        if (!billEnd || billEnd < cutoff) continue;

        result.billCount++;

        if (isElec) {
          const cost =
            (parseFloat(bill.kwhCost) || 0) +
            (parseFloat(bill.kwCost) || 0) +
            (parseFloat(bill.otherCost) || 0) +
            (parseFloat(bill.taxCost) || 0);
          const kwh = parseFloat(bill.kwh || bill.kWhConsumed) || 0;
          if (cost > 0 && kwh > 0) {
            elecCost += cost;
            elecKwh += kwh;
            elecBills++;
          }
          // Demand: from demand charge line items
          const dc = parseFloat(bill.kwCost) || 0; // BilledKWCharge + TDCCharge
          const bkw = parseFloat(bill.billedKW || bill.BilledKW) || 0;
          if (dc > 0 && bkw > 0) {
            demandCharge += dc;
            demandKw += bkw;
            demandBills++;
          }
        }

        if (isGas) {
          // Gas bills store total cost in totalCost; therms in bill.therms, bill.units, or bill.kwh (generic field)
          const _gasTotalCost = parseFloat(bill.totalCost) || 0;
          const _gasLineCost =
            (parseFloat(bill.kwhCost) || 0) + (parseFloat(bill.otherCost) || 0) + (parseFloat(bill.taxCost) || 0);
          const cost = _gasTotalCost > 0 ? _gasTotalCost : _gasLineCost;
          const therms = parseFloat(bill.therms || bill.units || bill.kwh) || 0;
          if (cost > 0 && therms > 0) {
            gasCost += cost;
            gasTherms += therms;
            gasBills++;
          }
        }
      }
    }
  }

  if (elecKwh > 0) {
    result.electric_rate = Math.round((elecCost / elecKwh) * 10000) / 10000;
    result.sourceLabel = elecBills + ' bill' + (elecBills !== 1 ? 's' : '') + ' (12-mo avg)';
  }
  if (gasTherms > 0) {
    result.gas_rate = Math.round((gasCost / gasTherms) * 10000) / 10000;
  }
  if (demandKw > 0 && demandBills > 0) {
    // $/kW/month: total demand charges / (sum of billed kW / months)
    result.demand_rate = Math.round((demandCharge / demandBills / (demandKw / demandBills)) * 100) / 100;
  }

  return result;
}

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
 * Sum ECM annual savings across all saved ECMs for a project.
 * Looks for outputs.annual_savings_dollars, outputs.total_savings_dollar,
 * or outputs.annual_cost_saved — whichever field the template produced.
 * @param {string|number} projId
 * @returns {{ total: number, count: number, ecms: Array }}
 */
function getProjectEcmTotal(projId) {
  const ecms = getProjectEcms(projId);
  let total = 0;
  for (const ecm of ecms) {
    const out = ecm.outputs || {};
    const sav =
      out.annual_savings_dollars || out.total_savings_dollar || out.annual_cost_saved || out.annual_savings_dollar || 0;
    total += parseFloat(sav) || 0;
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

/* ─── Calculate API ──────────────────────────────────── */

/**
 * Run a template's calculate() function after coercing all inputs to numbers.
 * @param {string} templateId
 * @param {Object} inputs — key/value map from the form
 * @returns {Object} results object
 */
function calculateEcm(templateId, inputs) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl) throw new Error('Unknown ECM template: ' + templateId);

  // Coerce inputs to correct types
  const coerced = {};
  tmpl.inputs.forEach((inp) => {
    const raw = inputs[inp.id];
    if (inp.type === 'number') {
      coerced[inp.id] = parseFloat(raw) || 0;
    } else {
      coerced[inp.id] = raw != null ? raw : inp.default;
    }
  });

  return tmpl.calculate(coerced);
}

/* ─── Render API ─────────────────────────────────────── */

/**
 * Render the ECM calculator picker grid into a container element.
 * @param {HTMLElement} container
 * @param {Function} onSelect — called with templateId when a card is clicked
 */
// Global callback registry so onclick attributes can fire into the current context
let _ecmPickerOnSelect = null;

function _ecmPickerSelect(templateId) {
  if (typeof _ecmPickerOnSelect === 'function') _ecmPickerOnSelect(templateId);
}

function renderEcmPicker(container, onSelect) {
  _ecmPickerOnSelect = onSelect;

  const cards = Object.values(ECM_TEMPLATES)
    .map((t) => {
      return `
      <button class="ecm-picker-card card" onclick="_ecmPickerSelect('${t.id}')"
        style="background:var(--s1);padding:18px;border:1px solid var(--border);cursor:pointer;text-align:left;
               transition:border-color .15s;border-radius:8px;width:100%;"
        onmouseenter="this.style.borderColor='var(--accent)'"
        onmouseleave="this.style.borderColor='var(--border)'">
        <div style="font-size:28px;margin-bottom:8px">${t.icon}</div>
        <div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--text)">${t.name}</div>
        <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">${t.category}</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.6">${t.description}</div>
        <div style="font-size:10px;color:var(--em);margin-top:8px;font-weight:600">Available</div>
      </button>`;
    })
    .join('');

  container.innerHTML = `
    <div style="padding:20px">
      <div style="margin-bottom:16px">
        <h2 style="font-size:16px;font-weight:700;margin:0 0 4px">ECM Calculator Library</h2>
        <p style="font-size:12px;color:var(--text2);margin:0">Select a template to estimate energy savings. Results include formula traces for transparency.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">
        ${cards}
      </div>
    </div>`;
}

/**
 * Render the input form for a template into a container element.
 * @param {string} templateId
 * @param {HTMLElement} container
 * @param {Object|null} savedValues — previously entered values (optional)
 * @param {Function} onBack — called when Back is clicked
 * @param {Function} onCalculate — called with (templateId, inputs, results) when Calculate is clicked
 * @param {Object|null} projectContext — { projId, buildingId, buildingName } when opened from a project
 */
function renderEcmCalculator(templateId, container, savedValues, onBack, onCalculate, projectContext) {
  const tmpl = ECM_TEMPLATES[templateId];
  if (!tmpl || !container) return;

  const sv = savedValues || {};
  const ctx = projectContext || null;

  // Auto-populate rates from project bill data when context is provided
  let autoRates = null;
  if (ctx && ctx.projId) {
    try {
      autoRates = getProjectRates(ctx.projId);
    } catch (e) {
      autoRates = null;
    }
  }

  // Map of input IDs that can be auto-populated from bills
  const AUTO_FIELDS = {
    elec_rate: autoRates && autoRates.electric_rate != null ? autoRates.electric_rate : null,
    electric_rate: autoRates && autoRates.electric_rate != null ? autoRates.electric_rate : null,
    gas_rate: autoRates && autoRates.gas_rate != null ? autoRates.gas_rate : null,
    demand_rate: autoRates && autoRates.demand_rate != null ? autoRates.demand_rate : null,
  };

  // Track which fields were auto-populated (for styling and source display)
  const autoPopulated = {};

  const fields = tmpl.inputs
    .map((inp) => {
      let val = sv[inp.id] != null ? sv[inp.id] : inp.default;
      const id = 'ecm-inp-' + inp.id;

      // Check for auto-population
      const autoVal = AUTO_FIELDS[inp.id];
      let isAuto = false;
      if (autoVal != null && sv[inp.id] == null) {
        val = autoVal;
        isAuto = true;
        autoPopulated[inp.id] = true;
      }

      const helpTitle = inp.help ? ` title="${inp.help.replace(/"/g, '&quot;')}"` : '';
      const helpCursor = inp.help ? ';cursor:help' : '';

      if (inp.type === 'select') {
        const opts = inp.options
          .map((o) => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`)
          .join('');
        return `
        <div class="ecm-field-row" style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <label${helpTitle} style="flex:0 0 280px;font-size:12px;font-weight:600;color:var(--text2);padding-top:4px${helpCursor}">${inp.label}</label>
          <select id="${id}" class="fs ecm-input" data-inp="${inp.id}" style="flex:1;min-width:200px;font-size:13px">
            ${opts}
          </select>
        </div>`;
      }

      // Auto-populated inputs shown in blue with a source tag; override clears the tag
      const autoStyle = isAuto ? 'color:#60a5fa;border-color:rgba(96,165,250,0.4)' : '';
      const autoTag = isAuto
        ? `<span id="${id}-autotag" style="font-size:10px;color:#60a5fa;margin-top:3px;display:block">
             from bills (${autoRates.sourceLabel}) — <button type="button" style="font-size:10px;color:var(--text3);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline" onclick="document.getElementById('${id}').style.color='';document.getElementById('${id}').style.borderColor='';document.getElementById('${id}-autotag').style.display='none'">override</button>
           </span>`
        : '';

      return `
      <div class="ecm-field-row" style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <label for="${id}"${helpTitle} style="flex:0 0 280px;font-size:12px;font-weight:600;color:var(--text2);padding-top:6px${helpCursor}">${inp.label}${inp.unit ? ' <span style="opacity:.6;font-weight:400">(' + inp.unit + ')</span>' : ''}</label>
        <div style="flex:1;min-width:160px">
          <input id="${id}" class="fi ecm-input" type="number" data-inp="${inp.id}"
            value="${val}" min="${inp.min}" max="${inp.max}"
            step="${inp.type === 'number' && val < 1 ? '0.001' : '1'}"
            style="width:100%;font-size:13px;${autoStyle}"
            oninput="_ecmValidateInput(this,${inp.min},${inp.max})" />
          ${autoTag}
          <div id="${id}-err" style="font-size:11px;color:var(--red,#e55);margin-top:2px;display:none"></div>
        </div>
      </div>`;
    })
    .join('');

  // Build context banner if opened from a project
  const autoCount = Object.keys(autoPopulated).length;
  const contextBanner =
    ctx && ctx.buildingName
      ? `<div style="background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.3);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#93c5fd;display:flex;align-items:center;gap:8px">
           <span style="font-size:16px">📌</span>
           <span>Auto-populated from <strong>${ctx.buildingName}</strong> data${autoCount > 0 ? ' — ' + autoCount + ' rate' + (autoCount !== 1 ? 's' : '') + ' filled from bills' : ' — no bill data found'}</span>
         </div>`
      : '';

  container.innerHTML = `
    <div style="padding:20px;overflow-y:auto;flex:1" id="ecm-calc-form-wrap">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="ecm-back-btn">← Back</button>
        <span style="font-size:20px">${tmpl.icon}</span>
        <h2 style="font-size:18px;font-weight:700;margin:0;color:var(--text)">${tmpl.name}</h2>
        <span style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border:1px solid var(--accent);border-radius:10px">${tmpl.category}</span>
      </div>
      ${contextBanner}
      <p style="font-size:13px;color:var(--text2);margin:0 0 20px;line-height:1.6">${tmpl.description}</p>

      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Inputs</div>
        <div id="ecm-inputs-container">
          ${fields}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="ecm-reset-btn">Reset Defaults</button>
        <button class="btn btn-em" id="ecm-calc-btn" style="min-width:120px">Calculate</button>
      </div>

      <div id="ecm-results-wrap"></div>
    </div>`;

  // Wire back button
  container.querySelector('#ecm-back-btn').addEventListener('click', () => {
    if (typeof onBack === 'function') onBack();
  });

  // Wire reset button
  container.querySelector('#ecm-reset-btn').addEventListener('click', () => {
    tmpl.inputs.forEach((inp) => {
      const el = container.querySelector('#ecm-inp-' + inp.id);
      if (el) {
        el.value = inp.default;
        el.style.color = '';
        el.style.borderColor = '';
      }
      const tag = container.querySelector('#ecm-inp-' + inp.id + '-autotag');
      if (tag) tag.style.display = 'none';
    });
    container.querySelector('#ecm-results-wrap').innerHTML = '';
  });

  // Wire calculate button
  container.querySelector('#ecm-calc-btn').addEventListener('click', () => {
    const inputs = {};
    let valid = true;
    tmpl.inputs.forEach((inp) => {
      const el = container.querySelector('#ecm-inp-' + inp.id);
      if (el) {
        inputs[inp.id] = inp.type === 'number' ? parseFloat(el.value) : el.value;
        if (inp.type === 'number' && isNaN(inputs[inp.id])) {
          _ecmShowFieldError(el, 'Required');
          valid = false;
        }
      }
    });
    if (!valid) return;

    const results = calculateEcm(templateId, inputs);
    renderEcmResults(templateId, results, container.querySelector('#ecm-results-wrap'), ctx, inputs);

    if (typeof onCalculate === 'function') onCalculate(templateId, inputs, results);
  });

  // Wire live formula hints on focus
  tmpl.inputs.forEach((inp) => {
    const el = container.querySelector('#ecm-inp-' + inp.id);
    if (el) {
      el.addEventListener('change', () => _ecmValidateInput(el, inp.min, inp.max));
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
          : out.id === 'simple_payback'
            ? val === null
              ? '—'
              : val + ' yrs'
            : out.unit === 'kWh/yr' || out.unit === 'CFM' || out.unit === 'therms/yr'
              ? typeof val === 'number'
                ? val.toLocaleString()
                : val
              : out.unit.startsWith('$/yr') || out.unit === '$'
                ? '$' + (typeof val === 'number' ? val.toLocaleString() : val)
                : typeof val === 'number' && !Number.isInteger(val)
                  ? val.toFixed(3)
                  : val;

      const isMajor =
        out.id === 'total_savings_dollar' ||
        out.id === 'simple_payback' ||
        out.id === 'savings_kwh' ||
        out.id === 'annual_savings_dollar';

      return `
      <tr class="ecm-result-row" style="border-bottom:1px solid var(--border)">
        <td class="ecm-result-cell" style="font-weight:${isMajor ? '700' : '400'};color:${isMajor ? 'var(--text)' : 'var(--text2)'}">
          ${out.label}
          ${out.unit ? `<span style="font-size:11px;font-weight:400;color:var(--text3);margin-left:4px">${out.unit}</span>` : ''}
        </td>
        <td class="${isMajor ? 'ecm-result-cell--major' : 'ecm-result-cell'}" style="text-align:right;font-weight:${isMajor ? '700' : '400'};color:${isMajor ? 'var(--em)' : 'var(--text)'};font-family:var(--mono)">
          ${display}
        </td>
        <td class="ecm-result-cell" style="text-align:right;width:32px">
          <button class="btn btn-ghost btn-sm"
            style="font-size:10px;padding:2px 6px;opacity:.6"
            title="Show formula"
            onclick="_ecmToggleFormula(this,'${out.id}')">
            ƒ
          </button>
        </td>
      </tr>
      <tr class="ecm-formula-row" id="ecm-formula-${out.id}" style="display:none">
        <td colspan="3" class="ecm-formula-cell" style="color:var(--text3);font-family:var(--mono);background:var(--s2);border-bottom:1px solid var(--border)">
          ${out.formula || 'No formula trace available.'}
        </td>
      </tr>`;
    })
    .join('');

  // Build the "Save to Project" footer if a project context is available
  const saveBtnHtml =
    ctx && ctx.projId
      ? `<div style="padding:14px 16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
         <div style="flex:1;min-width:200px">
           <input type="text" id="ecm-save-notes" class="fi" placeholder="Notes (optional — e.g. 'RTU-3 and RTU-4')" style="width:100%;font-size:12px" />
         </div>
         <button class="btn btn-em btn-sm" id="ecm-save-to-proj-btn" style="white-space:nowrap">
           Save to ${ctx.buildingName ? ctx.buildingName : 'Project'}
         </button>
         <span id="ecm-save-status" style="font-size:11px;color:var(--green);display:none">Saved!</span>
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
  }
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

/* ─── Main View Controller ───────────────────────────── */

let _ecmActiveTemplate = null;
// Current project context: { projId, buildingId, buildingName } or null
let _ecmProjectContext = null;

/**
 * Initialize the Calculators view. Called when the user navigates to view-calculators.
 * @param {Object|null} projectContext — optional { projId, buildingId, buildingName }
 *   Pass this when opening from a building context so inputs are auto-populated from bills
 *   and results can be saved back to the project.
 */
function initEcmCalculatorsView(projectContext) {
  const container = document.getElementById('ecm-view-body');
  if (!container) return;

  _ecmActiveTemplate = null;
  _ecmProjectContext = projectContext || null;

  function onSelect(templateId) {
    _ecmActiveTemplate = templateId;
    renderEcmCalculator(
      templateId,
      container,
      null, // no saved values on first open
      function onBack() {
        // Return to picker, preserving context
        _ecmActiveTemplate = null;
        initEcmCalculatorsView(_ecmProjectContext);
      },
      function onCalculate(tid, inputs, results) {
        // Results are rendered inline by renderEcmResults (with Save to Project button if ctx set)
      },
      _ecmProjectContext,
    );
  }

  renderEcmPicker(container, onSelect);
}

/**
 * Open the Calculators view pre-scoped to a specific project/building.
 * Call this from the project UI to launch a calculator with auto-populated inputs.
 * @param {string|number} projId
 * @param {string} buildingId
 * @param {string} buildingName
 */
function openEcmCalculatorForBuilding(projId, buildingId, buildingName) {
  // Navigate to calculators view
  if (typeof sv === 'function') {
    sv('calculators');
  }
  // Set context and reinitialize after view is active
  setTimeout(function () {
    initEcmCalculatorsView({ projId: String(projId), buildingId: buildingId, buildingName: buildingName });
  }, 50);
}

/* ─── Auto-init if navigating directly to calculators view ── */
/* This handles the case where the sv() wrapper fails (e.g. local file:// CORS) */
document.addEventListener('DOMContentLoaded', function () {
  var lastView = localStorage.getItem('ch_activeView') || sessionStorage.getItem('ch_activeView');
  if (lastView === 'calculators') {
    // Page was reloaded while on calculators view — init immediately
    setTimeout(function () {
      if (typeof initEcmCalculatorsView === 'function') initEcmCalculatorsView();
    }, 150);
  }
});
