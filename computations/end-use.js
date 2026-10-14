// computations/end-use.js - the ONE reader of a building's end-use baseline (Phase 5, 2026-10-14).
//
// Matt's chain: Utility Data baseline (or the quick annual entry) -> HVAC Load Estimate (per building, owns the
// end-use split) -> one savings calc template per replaced item reads ITS baseline from the load estimate.
// getEndUse is the only function a template, the BAS Calc or any other savings calc calls to learn "how much
// cooling kWh / heating Therms / HVAC kWh does this building use". Nothing else may read b.hvacLoad.est for an
// end-use quantity (tools/gate-ecm-templates-no-dollars.js checks this).
//
// Where the numbers come from (never a second estimate):
//   1. the building's stored HVAC Load Estimate, b.hvacLoad.est (hvacLoadStoredFor, app/calculators.js), saved by a
//      person or moved over from the old project estimate; else
//   2. the same estimate calculated now (computeHvacLoadEstimate) from the building's data (resolveHvacLoadData)
//      with the Rules of Thumb start values (_hvlThumbDefaults) - exactly what the HVAC Load Estimate tab shows
//      for a building nobody has saved yet; else
//   3. nothing: source 'none'.
// The data under the estimate is bills (monthly) or the quick annual entry (annual only, no monthly values are made up).
//
// End uses the estimate models today: cooling, heatingElectric, heatingGas, hvacElectric (cooling + electric
// heating, fans and pumps are inside it) and nonHvacElectric (lighting + plug + other, not split). Fans,
// lighting and plug loads are NOT modeled separately yet: getEndUse answers them with modeled:false.
//
// Monthly arrays are indexed by calendar month, Jan(0)..Dec(11), the same indexing the Energy Savings matrix uses.

var END_USES = {
  cooling: { unit: 'kWh', label: 'Cooling', annual: 'coolKwhTotal', monthly: 'monthlyCoolKwh', kw: 'hvac' },
  heatingElectric: {
    unit: 'kWh',
    label: 'Electric heating',
    annual: 'heatKwhTotal',
    monthly: 'monthlyHeatKwh',
    kw: 'hvac',
  },
  heatingGas: { unit: 'Therms', label: 'Gas heating', annual: 'hvacGasT', monthly: 'monthlyHvacGas', kw: null },
  hvacElectric: {
    unit: 'kWh',
    label: 'HVAC electric (cooling, electric heating, fans and pumps)',
    annual: 'hvacKwh',
    monthly: 'monthlyHvacKwh',
    kw: 'hvac',
  },
  nonHvacElectric: {
    unit: 'kWh',
    label: 'Non-HVAC electric (lighting, plug loads and other, not split)',
    annual: 'nonHvacKwh',
    monthly: 'monthlyNonHvacKwh',
    kw: 'nonHvac',
  },
};
var END_USES_NOT_MODELED = ['fans', 'lighting', 'plug'];

function _euNotAvailable(endUse, label, unit, modeled, sourceLabel) {
  return {
    endUse: endUse,
    label: label,
    modeled: modeled,
    unit: unit,
    source: 'none',
    sourceLabel: sourceLabel,
    estimate: null,
    annual: null,
    monthly: null,
    kw: null,
  };
}

function _euMonthlyOrNull(arr) {
  if (!Array.isArray(arr) || arr.length !== 12) return null;
  return arr.map(function (v) {
    return parseFloat(v) || 0;
  });
}

/**
 * The building's annual and monthly baseline of one end use, from its HVAC Load Estimate.
 * @param {string|number} projId
 * @param {string} bldgId
 * @param {string} endUse - a key of END_USES (cooling, heatingElectric, heatingGas, hvacElectric, nonHvacElectric)
 * @returns {{endUse:string, label:string, modeled:boolean, unit:string|null,
 *   source:'bills'|'annual'|'none', sourceLabel:string, estimate:'saved'|'calculated'|'default'|null,
 *   annual:number|null, monthly:number[]|null,
 *   kw:{annual:number, monthly:number[]|null, peak:number|null}|null}}
 *   annual = quantity per year in `unit`; monthly = 12 calendar-month values that add up to annual, or null
 *   when the building has only annual totals (monthly values are never made up); kw = the demand of the
 *   same end use (annual = sum of the 12 monthly kW, or the entered peak share for annual-only data).
 */
function getEndUse(projId, bldgId, endUse) {
  var def = END_USES[endUse];
  if (!def) {
    var known = END_USES_NOT_MODELED.indexOf(endUse) >= 0;
    return _euNotAvailable(
      endUse,
      endUse,
      null,
      false,
      known ? 'Not modeled yet in the HVAC Load Estimate' : 'Unknown end use',
    );
  }
  var b = bldgId && typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return _euNotAvailable(endUse, def.label, def.unit, true, 'No building chosen');

  var stored = typeof hvacLoadStoredFor === 'function' ? hvacLoadStoredFor(projId, bldgId) : null;
  var est = null;
  var estimate = null;
  var sourceLabel = '';
  var source = 'none';
  if (stored) {
    est = stored.est;
    estimate = stored.savedAt ? 'saved' : 'calculated';
    source = est.dataSource || 'none';
    sourceLabel =
      'HVAC Load Estimate (' +
      (stored.savedAt ? 'saved ' + new Date(stored.savedAt).toLocaleDateString() : 'calculated, not saved yet') +
      '), ' +
      (est.dataSourceLabel || source);
  } else {
    var resolved = resolveHvacLoadData(projId, b);
    if (resolved.source === 'none') return _euNotAvailable(endUse, def.label, def.unit, true, resolved.label);
    est = computeHvacLoadEstimate('thumb', resolved, _hvlThumbDefaults(projId, bldgId), parseInt(b.sqft) || 0);
    estimate = 'default';
    source = resolved.source;
    sourceLabel = 'HVAC Load Estimate (Rules of Thumb start values, not saved yet), ' + resolved.label;
  }

  var annual = parseFloat(est[def.annual]);
  var monthly = _euMonthlyOrNull(est[def.monthly]);
  var kw = null;
  if (def.kw) {
    var kwAnnual = parseFloat(def.kw === 'hvac' ? est.hvacKw : est.nonHvacKw) || 0;
    var kwMonthly = _euMonthlyOrNull(def.kw === 'hvac' ? est.monthlyHvacKw : est.monthlyNonHvacKw);
    kw = {
      annual: kwAnnual,
      monthly: kwMonthly,
      peak: kwMonthly ? Math.max.apply(null, kwMonthly) : null,
    };
  }
  return {
    endUse: endUse,
    label: def.label,
    modeled: true,
    unit: def.unit,
    source: source,
    sourceLabel: sourceLabel,
    estimate: estimate,
    annual: isFinite(annual) ? annual : null,
    monthly: monthly,
    kw: kw,
  };
}

/**
 * The month weights that shape a yearly savings quantity: the monthly profile of the first end use in `endUses`
 * that has a monthly profile with a positive total. weights[mo] = monthly[mo] / sum(monthly), so they add up to 1.
 * @returns {{ok:true, weights:number[], endUse:string, eu:Object}|{ok:false, reason:string}}
 */
function getEndUseWeights(projId, bldgId, endUses) {
  var reasons = [];
  for (var i = 0; i < endUses.length; i++) {
    var eu = getEndUse(projId, bldgId, endUses[i]);
    if (!eu.modeled || eu.source === 'none') {
      reasons.push(eu.label + ': ' + eu.sourceLabel);
      continue;
    }
    if (!eu.monthly) {
      reasons.push(eu.label + ': this building has annual totals only, so there is no monthly profile');
      continue;
    }
    var sum = eu.monthly.reduce(function (s, v) {
      return s + v;
    }, 0);
    if (!(sum > 0)) {
      reasons.push(eu.label + ': the HVAC Load Estimate has none for this building');
      continue;
    }
    return {
      ok: true,
      weights: eu.monthly.map(function (v) {
        return v / sum;
      }),
      endUse: endUses[i],
      eu: eu,
    };
  }
  return { ok: false, reason: reasons.join('; ') };
}

// A yearly energy quantity (kWh or Therms) laid over the 12 months with the end use's weights.
function spreadEnergyByWeights(weights, annual) {
  return weights.map(function (w) {
    return annual * w;
  });
}

// A kW reduction laid over the 12 months: the full reduction in the end use's peak month, the other months in
// proportion to that month's end-use energy (a cooling kW reduction is largest in the cooling peak and near 0 in winter).
function spreadDemandByWeights(weights, kw) {
  var peak = Math.max.apply(null, weights);
  return weights.map(function (w) {
    return peak > 0 ? (kw * w) / peak : 0;
  });
}
