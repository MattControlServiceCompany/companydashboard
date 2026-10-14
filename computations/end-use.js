// computations/end-use.js - the ONE reader of a building's end-use baseline (Phase 5, 2026-10-14).
//
// Matt's chain: Utility Data baseline (or the quick annual entry) -> HVAC Load Estimate (per building, owns the
// end-use split) -> one savings calc template per replaced item reads ITS baseline from the load estimate.
// getEndUse is the only function a template, the BAS Calc or any other savings calc calls to learn "how much
// cooling kWh / heating Therms / HVAC kWh does this building use". Nothing else may read b.hvacLoad.est for an
// end-use quantity (tools/gate-ecm-templates-no-dollars.js checks this).
//
// Where the numbers come from (never a second estimate): hvacEstimateForBuilding (app/calculators.js) calculates the
// building's estimate now from its data (resolveHvacLoadData). It never reads a stored snapshot (b.hvacLoad.est):
//   - monthly bills: the split is the measured 3-lowest-month baseload split (computations/hvac-enduse.js), unless
//     a person typed a percentage over it (an explicit override saved with the building);
//   - annual totals only (quick entry): Rules of Thumb percentages;
//   - no data: nothing, source 'none'.
// result.basis says which one produced the number ('measured', 'rule', 'override', 'method').
// The data under the estimate is bills (monthly) or the quick annual entry (annual only, no monthly values are made up).
//
// End uses the estimate models today: cooling, heatingElectric, heatingGas, hvacElectric (cooling + electric
// heating above baseload) and nonHvacElectric (lighting + plug + other, not split, less the supply fans). Lighting and
// plug loads are NOT modeled separately yet: getEndUse answers them with modeled:false.
// Fans (Phase 6, 2026-10-14) are modeled from the Equipment Matrix supply-fan rows of the building, not from the load
// estimate: see _fanEndUse below. Fans run all year, so they sit in the baseload of the bills, not in hvacElectric.
// DOUBLE-COUNT RULE: total building electricity = cooling + electric heating + (everything else). The cap of the fan end use
// is that "everything else" (total less measured cooling and electric heating). getEndUse 'nonHvacElectric' is that same
// remainder LESS the fans, so fans + nonHvacElectric + cooling + electric heating never add up to more than the total.
//
// Monthly arrays are indexed by calendar month, Jan(0)..Dec(11), the same indexing the Energy Savings matrix uses.

var END_USES = {
  cooling: {
    unit: 'kWh',
    label: 'Cooling',
    annual: 'coolKwhTotal',
    monthly: 'monthlyCoolKwh',
    basis: 'coolKwh',
    kw: 'hvac',
  },
  heatingElectric: {
    unit: 'kWh',
    label: 'Electric heating',
    annual: 'heatKwhTotal',
    monthly: 'monthlyHeatKwh',
    basis: 'heatKwh',
    kw: 'hvac',
  },
  heatingGas: { unit: 'Therms', label: 'Gas heating', annual: 'hvacGasT', monthly: 'monthlyHvacGas', basis: 'hvacGas', kw: null },
  hvacElectric: {
    unit: 'kWh',
    label: 'HVAC electric (cooling and electric heating above baseload)',
    annual: 'hvacKwh',
    monthly: 'monthlyHvacKwh',
    basis: 'hvacKwh',
    kw: 'hvac',
  },
  nonHvacElectric: {
    unit: 'kWh',
    label: 'Non-HVAC electric (lighting, plug loads and other, not split)',
    annual: 'nonHvacKwh',
    monthly: 'monthlyNonHvacKwh',
    basis: 'nonHvacKwh',
    kw: 'nonHvac',
  },
};
var END_USES_NOT_MODELED = ['lighting', 'plug'];

function _euNotAvailable(endUse, label, unit, modeled, sourceLabel) {
  return {
    endUse: endUse,
    label: label,
    modeled: modeled,
    unit: unit,
    source: 'none',
    sourceLabel: sourceLabel,
    estimate: null,
    basis: null,
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
 * @param {string} endUse - a key of END_USES (cooling, heatingElectric, heatingGas, hvacElectric, nonHvacElectric) or 'fans'
 * @returns {{endUse:string, label:string, modeled:boolean, unit:string|null,
 *   source:'bills'|'annual'|'matrix'|'none', sourceLabel:string, estimate:'saved'|'default'|null, basis:'measured'|'rule'|'override'|'method'|null,
 *   annual:number|null, monthly:number[]|null,
 *   kw:{annual:number, monthly:number[]|null, peak:number|null}|null}}
 *   annual = quantity per year in `unit`; monthly = 12 calendar-month values that add up to annual, or null
 *   when the building has only annual totals (monthly values are never made up); kw = the demand of the
 *   same end use (annual = sum of the 12 monthly kW, or the entered peak share for annual-only data).
 */
function getEndUse(projId, bldgId, endUse) {
  if (endUse === 'fans') return _fanEndUse(projId, bldgId);
  if (endUse === 'nonHvacElectric') return _nonHvacLessFans(projId, bldgId, _readEndUse(projId, bldgId, endUse));
  return _readEndUse(projId, bldgId, endUse);
}

/** One end use read from the HVAC Load Estimate (no fan step). getEndUse is the only caller. */
function _readEndUse(projId, bldgId, endUse) {
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

  var calc = hvacEstimateForBuilding(projId, bldgId);
  if (!calc) {
    var none = resolveHvacLoadData(projId, b);
    return _euNotAvailable(endUse, def.label, def.unit, true, none.label);
  }
  var est = calc.est;
  var basis = est.basis[def.basis] || '';
  var source = calc.resolved.source;
  var sourceLabel =
    'HVAC Load Estimate (' +
    (calc.savedAt ? 'saved ' + new Date(calc.savedAt).toLocaleDateString() : 'not saved yet') +
    '), ' +
    hvlBasisLabel(basis) +
    ', ' +
    calc.resolved.label;
  var estimate = calc.estimate;

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
    basis: basis,
    annual: isFinite(annual) ? annual : null,
    monthly: monthly,
    kw: kw,
  };
}

/**
 * The building's total baseline electricity (kWh per year) from its HVAC Load Estimate, or null when there is none.
 * The ONE place the fan default and the fan cap read the total.
 */
function _euTotalElectric(projId, bldgId) {
  var calc = hvacEstimateForBuilding(projId, bldgId);
  var t = calc ? parseFloat(calc.est.totalKwh) : NaN;
  return t > 0 ? t : null;
}

/**
 * nonHvacElectric less the supply fans: fans run all year, so their kWh sits in this baseload remainder; taking them out
 * here keeps cooling + electric heating + fans + non-HVAC from adding up to more than the building total.
 * Annual, the 12 months and the kW series each go down by the fans (never below 0). No fan end use: unchanged.
 */
function _nonHvacLessFans(projId, bldgId, nh) {
  if (!nh.modeled || nh.source === 'none' || !(nh.annual > 0)) return nh;
  var fans = _fanEndUse(projId, bldgId);
  if (fans.source === 'none' || !(fans.annual > 0)) return nh;
  var less = function (arr, sub) {
    return arr.map(function (v, i) {
      return Math.max(0, v - sub[i]);
    });
  };
  var total = function (arr) {
    return arr.reduce(function (s, v) {
      return s + v;
    }, 0);
  };
  var monthly = nh.monthly ? less(nh.monthly, fans.monthly) : null;
  var kw = nh.kw;
  if (kw && kw.monthly) {
    var kwMonthly = less(kw.monthly, fans.kw.monthly);
    kw = { annual: total(kwMonthly), monthly: kwMonthly, peak: Math.max.apply(null, kwMonthly) };
  }
  return Object.assign({}, nh, {
    annual: monthly ? total(monthly) : Math.max(0, nh.annual - fans.annual),
    monthly: monthly,
    kw: kw,
    sourceLabel:
      nh.sourceLabel + ', less the ' + Math.round(fans.annual).toLocaleString() + ' kWh of supply fans (they run all year, inside the baseload)',
  });
}

/**
 * The fan end use of one building (Phase 6): the supply fans of its Equipment Matrix rows, each unit sized by
 * fanModelUnits (computations/fan-savings.js: kW from amps, else cfm, else HP, else a Default estimate; hours from the BAS trend, else the
 * matrix, else a stated default), added up and capped by the building's total baseline electricity less its measured cooling and electric heating (fans run all year: they sit in the baseload).
 * The result has the same shape as every other end use, plus:
 *   units       - the sized units (fanModelUnits results, kWh before the cap; a unit with no amps, airflow or horsepower is a Default estimate, see fanModelUnits) and the units that could not be sized (ok:false, missing)
 *   capFactor   - 1, or capAnnual / sum when the units add up to more than the cap
 *   capAnnual   - total baseline electricity less cooling and electric heating, kWh (null: no total electricity, so no cap)
 *   levels      - count of units by data level for kW and for hours ({kw:{trend,matrix,default}, hours:{...}})
 * Monthly = the annual quantity by days in the month (a fan runs all year); the kW of each month is the running kW of the units.
 */
function _fanEndUse(projId, bldgId) {
  var label = 'Fans';
  var b = bldgId && typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) return _euNotAvailable('fans', label, 'kWh', true, 'No building chosen');
  var read = fanReadUnits(projId, bldgId);
  if (!read.units.length) return _euNotAvailable('fans', label, 'kWh', true, read.note);
  var total = _euTotalElectric(projId, bldgId);
  var coolAnnual = _readEndUse(projId, bldgId, 'cooling').annual || 0;
  var heatAnnual = _readEndUse(projId, bldgId, 'heatingElectric').annual || 0;
  var capAnnual = total && total - coolAnnual - heatAnnual > 0 ? total - coolAnnual - heatAnnual : null;
  var units = fanModelUnits(projId, bldgId, read, total);
  var sized = units.filter(function (u) {
    return u.ok;
  });
  if (!sized.length)
    return _euNotAvailable(
      'fans',
      label,
      'kWh',
      true,
      'None of the ' +
        units.length +
        ' supply-fan rows has the data to size a fan (needs amps, a supply fan airflow, or a horsepower)',
    );
  var raw = sized.reduce(function (s, u) {
    return s + u.kwh;
  }, 0);
  var factor = capAnnual && raw > capAnnual ? capAnnual / raw : 1;
  var annual = raw * factor;
  var weights = fanMonthWeights();
  var monthly = weights.map(function (w) {
    return annual * w;
  });
  var runKw =
    sized.reduce(function (s, u) {
      return s + u.kwh / u.hours;
    }, 0) * factor;
  var kwMonthly = weights.map(function () {
    return runKw;
  });
  var levels = { kw: { trend: 0, matrix: 0, default: 0 }, hours: { trend: 0, matrix: 0, default: 0 } };
  sized.forEach(function (u) {
    levels.kw[u.kwLevel]++;
    levels.hours[u.hoursLevel]++;
  });
  var nEst = sized.filter(function (u) {
    return u.estimate;
  }).length;
  var lv = function (o) {
    return ['trend', 'matrix', 'default']
      .filter(function (k) {
        return o[k];
      })
      .map(function (k) {
        return o[k] + ' ' + FAN_LEVEL_LABEL[k].toLowerCase();
      })
      .join(', ');
  };
  var sourceLabel =
    'Equipment Matrix supply fans: ' +
    sized.length +
    ' of ' +
    units.length +
    ' rows sized' +
    (nEst ? ' (' + nEst + ' of them a Default estimate from siblings or the national average ventilation share)' : '') +
    ' (kW: ' +
    lv(levels.kw) +
    '; run hours: ' +
    lv(levels.hours) +
    ')' +
    (factor < 1
      ? ', scaled down (x' + Math.round(factor * 100) / 100 + ') to fit the building total electricity less cooling and electric heating'
      : capAnnual
        ? ', within the building total electricity less cooling and electric heating'
        : ', no total electricity to check against');
  return {
    endUse: 'fans',
    label: label,
    modeled: true,
    unit: 'kWh',
    source: 'matrix',
    sourceLabel: sourceLabel,
    estimate: null,
    basis: 'method',
    annual: annual,
    monthly: monthly,
    kw: { annual: runKw * 12, monthly: kwMonthly, peak: runKw },
    units: units,
    capFactor: factor,
    capAnnual: capAnnual,
    levels: levels,
  };
}

/**
 * endUseFill - the ONE prefill rule for a calculator input that is a building end-use quantity (the BAS Calc
 * calibration fields and the ECM template inputs both call it). Returns { value, source } for chResolveCalcField
 * when the end use is modeled, has data, and its annual quantity is above 0; else null (a zero end use, for example
 * no electric heating, fills nothing).
 * @param {Object} eu - the result of getEndUse
 * @returns {{value:number, source:string}|null}
 */
function endUseFill(eu) {
  return eu && eu.modeled && eu.source !== 'none' && eu.annual > 0
    ? { value: Math.round(eu.annual), source: eu.sourceLabel }
    : null;
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
