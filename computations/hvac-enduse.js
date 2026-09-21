// computations/hvac-enduse.js — HVAC End-Use Estimate (canonical source)
// No DOM dependencies. Weather-independent 3-lowest-month baseload subtraction method.
// This matches the "HVAC End-Use Estimate" Excel deliverable. Do NOT confuse with the
// CDD/HDD weather regression method used by getBaseloadTrend()/m._reg — that is a
// different method and will not reproduce these numbers.
//
// Input arrays are indexed by CALENDAR month, Jan(0)..Dec(11) — NOT baseline sequence
// order — because a baseline can span 12-36 months (app/utility-data.js:6679) and
// every year in the baseline contributes to the same 12 calendar-month buckets.
// Callers MUST pre-average multi-year baselines into one value per calendar month
// (sum / count of bills seen for that month) BEFORE calling this function. A month with
// NO bill at all (missing from the baseline, not a genuine zero-usage bill) must be
// passed as `null`, never `0` — `0` means "a real bill recorded zero usage that month"
// and IS eligible to be one of the "3 lowest" months; `null` means "no data" and is
// excluded from every calculation (population count, lowest-3 selection, totals, peak).

/**
 * Average of the N lowest values among populated (non-null) months.
 * A real recorded value of 0 is eligible to be selected — only `null`/`undefined`
 * ("no data for this month") is excluded.
 * @param {Array<number|null>} arr
 * @param {number} n
 * @returns {number}
 */
function _hvacLowestNAvg(arr, n) {
  var vals = (arr || [])
    .filter(function (v) {
      return v !== null && v !== undefined;
    })
    .slice()
    .sort(function (a, b) {
      return a - b;
    });
  if (!vals.length) return 0;
  var take = vals.slice(0, Math.min(n, vals.length));
  return (
    take.reduce(function (s, v) {
      return s + v;
    }, 0) / take.length
  );
}

function _hvacPopulatedCount(arr) {
  return (arr || []).filter(function (v) {
    return v !== null && v !== undefined;
  }).length;
}

/**
 * Compute the HVAC end-use estimate for one building over its 12 baseline calendar months.
 * Method (matches Excel "HVAC End-Use Estimate" sheet):
 *   baseloadElec = avg of 3 lowest monthly kWh (among populated months)
 *   baseloadGas  = avg of 3 lowest monthly gas Therms (among populated months)
 *   winterDemandBase = avg of Dec/Jan/Feb billed demand kW (among populated winter months)
 *   coolingKwh[mo] = max(0, kwh[mo] - baseloadElec); summed over populated months
 *   heatingTherms[mo] = max(0, gas[mo] - baseloadGas); summed over populated months
 *   coolingDemandKw = peakKw - winterDemandBase
 *
 * @param {Array<number|null>} kwhArr12 - monthly electric kWh, indexed Jan(0)..Dec(11).
 *   Already averaged across baseline years per calendar month by the caller. `null` = no
 *   bill that month; a real 0 is a valid low-month candidate.
 * @param {Array<number|null>} kwArr12 - monthly billed demand kW, same indexing/averaging rules.
 * @param {Array<number|null>} gasArr12 - monthly gas Therms, same indexing/averaging rules.
 * @returns {{baseloadElec:number, baseloadGas:number, winterDemandBase:number,
 *   coolingKwh:number, coolingPct:number, heatingTherms:number, heatingPct:number,
 *   peakKw:number, coolingDemandKw:number, coolingDemandPct:number,
 *   elecValid:boolean, gasValid:boolean, demandValid:boolean}}
 */
function computeHvacEnduse(kwhArr12, kwArr12, gasArr12) {
  var out = {
    baseloadElec: 0,
    baseloadGas: 0,
    winterDemandBase: 0,
    coolingKwh: 0,
    coolingPct: 0,
    heatingTherms: 0,
    heatingPct: 0,
    peakKw: 0,
    coolingDemandKw: 0,
    coolingDemandPct: 0,
    elecValid: false,
    gasValid: false,
    demandValid: false,
  };

  var kwh = (kwhArr12 || []).slice(0, 12);
  var kw = (kwArr12 || []).slice(0, 12);
  var gas = (gasArr12 || []).slice(0, 12);
  while (kwh.length < 12) kwh.push(null);
  while (kw.length < 12) kw.push(null);
  while (gas.length < 12) gas.push(null);

  var MIN_POPULATED_MONTHS = 6;

  if (_hvacPopulatedCount(kwh) >= MIN_POPULATED_MONTHS) {
    out.elecValid = true;
    out.baseloadElec = _hvacLowestNAvg(kwh, 3);
    var totalKwh = kwh.reduce(function (s, v) {
      return v === null || v === undefined ? s : s + v;
    }, 0);
    var coolKwh = kwh.reduce(function (s, v) {
      return v === null || v === undefined ? s : s + Math.max(0, v - out.baseloadElec);
    }, 0);
    out.coolingKwh = coolKwh;
    out.coolingPct = totalKwh > 0 ? coolKwh / totalKwh : 0;
  }

  if (_hvacPopulatedCount(gas) >= MIN_POPULATED_MONTHS) {
    out.gasValid = true;
    out.baseloadGas = _hvacLowestNAvg(gas, 3);
    var totalGas = gas.reduce(function (s, v) {
      return v === null || v === undefined ? s : s + v;
    }, 0);
    var heatTherms = gas.reduce(function (s, v) {
      return v === null || v === undefined ? s : s + Math.max(0, v - out.baseloadGas);
    }, 0);
    out.heatingTherms = heatTherms;
    out.heatingPct = totalGas > 0 ? heatTherms / totalGas : 0;
  }

  if (_hvacPopulatedCount(kw) >= MIN_POPULATED_MONTHS) {
    // Dec=11, Jan=0, Feb=1
    var winterVals = [kw[11], kw[0], kw[1]].filter(function (v) {
      return v !== null && v !== undefined;
    });
    var peakVals = kw.filter(function (v) {
      return v !== null && v !== undefined;
    });
    if (winterVals.length && peakVals.length) {
      out.winterDemandBase =
        winterVals.reduce(function (s, v) {
          return s + v;
        }, 0) / winterVals.length;
      out.peakKw = Math.max.apply(null, peakVals);
      out.demandValid = true;
      out.coolingDemandKw = out.peakKw - out.winterDemandBase;
      out.coolingDemandPct = out.peakKw > 0 ? out.coolingDemandKw / out.peakKw : 0;
    }
  }

  return out;
}
