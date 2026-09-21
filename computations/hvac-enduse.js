// computations/hvac-enduse.js — HVAC End-Use Estimate (canonical source)
// No DOM dependencies. Weather-independent 3-lowest-month baseload subtraction method.
// This matches the "HVAC End-Use Estimate" Excel deliverable. Do NOT confuse with the
// CDD/HDD weather regression method used by getBaseloadTrend()/m._reg — that is a
// different method and will not reproduce these numbers.

/**
 * Average of the N lowest positive values in an array.
 * @param {number[]} arr
 * @param {number} n
 * @returns {number}
 */
function _hvacLowestNAvg(arr, n) {
  var sorted = (arr || [])
    .filter(function (v) {
      return v > 0;
    })
    .slice()
    .sort(function (a, b) {
      return a - b;
    });
  if (!sorted.length) return 0;
  var take = sorted.slice(0, Math.min(n, sorted.length));
  return (
    take.reduce(function (s, v) {
      return s + v;
    }, 0) / take.length
  );
}

/**
 * Compute the HVAC end-use estimate for one building over its 12 baseline calendar months.
 * Method (matches Excel "HVAC End-Use Estimate" sheet):
 *   baseloadElec = avg of 3 lowest monthly kWh
 *   baseloadGas  = avg of 3 lowest monthly gas Therms
 *   winterDemandBase = avg of Dec/Jan/Feb billed demand kW
 *   coolingKwh[mo] = max(0, kwh[mo] - baseloadElec); summed over 12 months
 *   heatingTherms[mo] = max(0, gas[mo] - baseloadGas); summed over 12 months
 *   coolingDemandKw = peakKw - winterDemandBase
 *
 * @param {number[]} kwhArr12 - monthly electric kWh, indexed Jan(0)..Dec(11)
 * @param {number[]} kwArr12 - monthly billed demand kW, indexed Jan(0)..Dec(11)
 * @param {number[]} gasArr12 - monthly gas Therms, indexed Jan(0)..Dec(11)
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
  while (kwh.length < 12) kwh.push(0);
  while (kw.length < 12) kw.push(0);
  while (gas.length < 12) gas.push(0);

  var MIN_POPULATED_MONTHS = 6;

  var kwhPopulated = kwh.filter(function (v) {
    return v > 0;
  }).length;
  if (kwhPopulated >= MIN_POPULATED_MONTHS) {
    out.elecValid = true;
    out.baseloadElec = _hvacLowestNAvg(kwh, 3);
    var totalKwh = kwh.reduce(function (s, v) {
      return s + v;
    }, 0);
    var coolKwh = kwh.reduce(function (s, v) {
      return s + Math.max(0, v - out.baseloadElec);
    }, 0);
    out.coolingKwh = coolKwh;
    out.coolingPct = totalKwh > 0 ? coolKwh / totalKwh : 0;
  }

  var gasPopulated = gas.filter(function (v) {
    return v > 0;
  }).length;
  if (gasPopulated >= MIN_POPULATED_MONTHS) {
    out.gasValid = true;
    out.baseloadGas = _hvacLowestNAvg(gas, 3);
    var totalGas = gas.reduce(function (s, v) {
      return s + v;
    }, 0);
    var heatTherms = gas.reduce(function (s, v) {
      return s + Math.max(0, v - out.baseloadGas);
    }, 0);
    out.heatingTherms = heatTherms;
    out.heatingPct = totalGas > 0 ? heatTherms / totalGas : 0;
  }

  var kwPopulated = kw.filter(function (v) {
    return v > 0;
  }).length;
  if (kwPopulated >= MIN_POPULATED_MONTHS) {
    // Dec=11, Jan=0, Feb=1
    var winterVals = [kw[11], kw[0], kw[1]].filter(function (v) {
      return v > 0;
    });
    if (winterVals.length) {
      out.winterDemandBase =
        winterVals.reduce(function (s, v) {
          return s + v;
        }, 0) / winterVals.length;
      out.peakKw = Math.max.apply(null, kw);
      out.demandValid = true;
      out.coolingDemandKw = out.peakKw - out.winterDemandBase;
      out.coolingDemandPct = out.peakKw > 0 ? out.coolingDemandKw / out.peakKw : 0;
    }
  }

  return out;
}
