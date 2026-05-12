// computations/eui.js — EUI calculations (canonical source)
// No DOM dependencies. All EUI displays call these functions.

var KBTU_FACTORS = { electric: 3.412, gas: 100, propane: 91.5 };

function computeKBtu(kwh, therms, propaneGal) {
  return (
    (kwh || 0) * KBTU_FACTORS.electric + (therms || 0) * KBTU_FACTORS.gas + (propaneGal || 0) * KBTU_FACTORS.propane
  );
}

function computeBaselineEUI(blKBtu, monthCount, sqft) {
  if (!sqft || sqft <= 0 || !blKBtu || blKBtu <= 0) return 0;
  var moCt = monthCount || 12;
  return ((blKBtu / moCt) * 12) / sqft;
}

function computeRolling12EUI(kBtu, monthCount, sqft) {
  if (!sqft || sqft <= 0 || !monthCount || monthCount <= 0) return 0;
  return ((kBtu / monthCount) * 12) / sqft;
}

function computePeriodEUI(kBtu, monthCount, sqft) {
  if (!sqft || sqft <= 0 || !monthCount || monthCount <= 0) return 0;
  return ((kBtu / monthCount) * 12) / sqft;
}

function computeQuarterlyEUI(qKBtu, sqft) {
  if (!sqft || sqft <= 0) return 0;
  return ((qKBtu / 3) * 12) / sqft;
}

function computeMonthlyEUI(moKBtu, sqft) {
  if (!sqft || sqft <= 0) return 0;
  return (moKBtu * 12) / sqft;
}

function computeProjectEUI(buildings) {
  var blWt = 0,
    curWt = 0,
    sqftSum = 0;
  buildings.forEach(function (b) {
    var s = b.sqft || 0;
    blWt += ((b.eui && b.eui.baseline) || 0) * s;
    curWt += ((b.eui && b.eui.current) || 0) * s;
    sqftSum += s;
  });
  return {
    baseline: sqftSum > 0 ? blWt / sqftSum : 0,
    current: sqftSum > 0 ? curWt / sqftSum : 0,
  };
}
