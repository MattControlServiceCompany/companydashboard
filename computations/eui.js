// computations/eui.js — EUI calculations (canonical source)
// No DOM dependencies. All EUI displays call these functions.

var KBTU_FACTORS = { electric: 3.412, gas: 100, propane: 91.5 };

// Site-to-source multipliers (EPA Portfolio Manager standard values)
var SOURCE_SITE_RATIOS = { electric: 3.14, gas: 1.05, propane: 1.01 };

// Source EUI CBECS percentile benchmarks for K-12 schools (kBtu/ft²/yr)
// Derived from CBECS site EUI percentiles × weighted source-site ratio (~3.1 for typical K-12)
// Used to estimate ENERGY STAR score via percentile interpolation
var CBECS_SOURCE_PERCENTILES_K12 = [
  { pct: 10, sourceEUI: 60 },
  { pct: 25, sourceEUI: 87 },
  { pct: 50, sourceEUI: 126 }, // corresponds to CBECS median site EUI ~48.5
  { pct: 75, sourceEUI: 223 },
  { pct: 90, sourceEUI: 310 },
];

/**
 * Compute source EUI from site consumption values.
 * @param {number} kwhSite - site electricity in kWh
 * @param {number} thermsSite - site natural gas in therms
 * @param {number} propGalSite - site propane in gallons
 * @param {number} sqft - gross floor area in square feet
 * @returns {number} source EUI in kBtu/ft²/yr, or 0 if sqft is missing
 */
function computeSourceEUI(kwhSite, thermsSite, propGalSite, sqft) {
  if (!sqft || sqft <= 0) return 0;
  var elecSourceKBtu = (kwhSite || 0) * KBTU_FACTORS.electric * SOURCE_SITE_RATIOS.electric;
  var gasSourceKBtu = (thermsSite || 0) * KBTU_FACTORS.gas * SOURCE_SITE_RATIOS.gas;
  var propSourceKBtu = (propGalSite || 0) * KBTU_FACTORS.propane * SOURCE_SITE_RATIOS.propane;
  return (elecSourceKBtu + gasSourceKBtu + propSourceKBtu) / sqft;
}

/**
 * Estimate an ENERGY STAR score from source EUI using CBECS K-12 percentile data.
 * Score = 100 - percentile rank (lower source EUI = better = higher score).
 * Uses linear interpolation between known CBECS percentile values.
 * @param {number} sourceEUI - source EUI in kBtu/ft²/yr
 * @param {Array} [percentileTable] - optional override; defaults to CBECS_SOURCE_PERCENTILES_K12
 * @returns {number} estimated ENERGY STAR score (1–100), or 0 if sourceEUI is invalid
 */
function estimateEnergyStarScore(sourceEUI, percentileTable) {
  if (!sourceEUI || sourceEUI <= 0) return 0;
  var table = percentileTable || CBECS_SOURCE_PERCENTILES_K12;
  // Below the best known point → score near 100
  if (sourceEUI <= table[0].sourceEUI) return 99;
  // Above the worst known point → score near 1
  if (sourceEUI >= table[table.length - 1].sourceEUI) return 1;
  // Linear interpolation between bounding rows
  for (var i = 0; i < table.length - 1; i++) {
    var lo = table[i];
    var hi = table[i + 1];
    if (sourceEUI >= lo.sourceEUI && sourceEUI <= hi.sourceEUI) {
      var t = (sourceEUI - lo.sourceEUI) / (hi.sourceEUI - lo.sourceEUI);
      var pctRank = lo.pct + t * (hi.pct - lo.pct);
      return Math.max(1, Math.min(99, Math.round(100 - pctRank)));
    }
  }
  return 0;
}

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
