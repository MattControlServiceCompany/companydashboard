// computations/pollution.js — Pollution credits (canonical source)

// Unit conversion constants (from Excel Reference Data sheet)
var GAS_THERM_TO_MMBTU = 0.1; // Row 10: 1 Therm = 0.1 MMBtu
var PROPANE_GAL_TO_MMBTU = 0.0900054; // Row 4: 1 gallon propane = 0.0900054 MMBtu
var LBS_PER_METRIC_TON = 2204.6; // Excel uses this constant throughout

// Natural gas emission factors: lbs per MMBtu (Excel Reference Data column K, rows 14-22)
var GAS_FACTORS = {
  co2: 117.6,
  ch4: 0.0225,
  n2o: 0.0022,
  so2: 0.0006,
  nox: 0.098,
  co: 0.0824,
  pm10: 0.00186,
  voc: 0.0054,
  hg: 0.00000025,
};

// Propane emission factors: lbs per MMBtu (Excel Reference Data column O, rows 14-22)
var PROPANE_FACTORS = {
  co2: 12.5,
  ch4: 0.0002,
  n2o: 0.0009,
  nox: 0.013,
  so2: 0.00001,
  pm_filt: 0.0002,
  voc: 0.001,
  co: 0.0075,
  hg: 0,
};

// Electric emission factors: lbs per kWh (Excel Reference Data columns C-H)
// Only CO2, CH4, N2O, SO2, NOx, Hg — no PM10/VOC/CO for electric
var EGRID_FACTORS = {
  AL: { co2: 1.242198, ch4: 0.000071, n2o: 0.00001, so2: 0.000155, nox: 0.000443, hg: 0 },
  AK: { co2: 1.146032, ch4: 0.000109, n2o: 0.000015, so2: 0.000704, nox: 0.008993, hg: 0 },
  AZ: { co2: 1.353181, ch4: 0.000074, n2o: 0.00001, so2: 0.000256, nox: 0.000595, hg: 0 },
  AR: { co2: 1.648502, ch4: 0.000142, n2o: 0.000021, so2: 0.002018, nox: 0.001009, hg: 0 },
  CA: { co2: 0.958329, ch4: 0.000041, n2o: 0.000005, so2: 0.000024, nox: 0.000564, hg: 0 },
  CO: { co2: 1.620707, ch4: 0.000125, n2o: 0.000018, so2: 0.00047, nox: 0.000917, hg: 0 },
  CT: { co2: 0.848815, ch4: 0.000036, n2o: 0.000004, so2: 0.000087, nox: 0.000356, hg: 0 },
  DC: { co2: 0.191681, ch4: 0.000018, n2o: 0.000002, so2: 0.000028, nox: 0.003112, hg: 0 },
  DE: { co2: 0.835159, ch4: 0.000018, n2o: 0.000002, so2: 0.00002, nox: 0.000265, hg: 0 },
  FL: { co2: 1.040142, ch4: 0.000045, n2o: 0.000006, so2: 0.000158, nox: 0.000341, hg: 0 },
  GA: { co2: 1.657639, ch4: 0.000152, n2o: 0.000022, so2: 0.00058, nox: 0.000924, hg: 0 },
  HI: { co2: 1.71065, ch4: 0.000162, n2o: 0.000026, so2: 0.005348, nox: 0.006458, hg: 0 },
  ID: { co2: 0.940554, ch4: 0.000033, n2o: 0.000005, so2: 0.000228, nox: 0.000419, hg: 0 },
  IL: { co2: 1.404328, ch4: 0.000111, n2o: 0.000016, so2: 0.000635, nox: 0.00057, hg: 0 },
  IN: { co2: 2.021343, ch4: 0.000203, n2o: 0.000029, so2: 0.000945, nox: 0.001205, hg: 0 },
  IA: { co2: 1.683026, ch4: 0.000167, n2o: 0.000024, so2: 0.001509, nox: 0.001165, hg: 0 },
  KS: { co2: 2.036756, ch4: 0.00021, n2o: 0.00003, so2: 0.000285, nox: 0.001524, hg: 0 },
  KY: { co2: 1.926359, ch4: 0.000201, n2o: 0.000029, so2: 0.001286, nox: 0.001049, hg: 0 },
  LA: { co2: 1.054598, ch4: 0.000042, n2o: 0.000006, so2: 0.000392, nox: 0.001112, hg: 0 },
  ME: { co2: 0.739169, ch4: 0.000119, n2o: 0.000017, so2: 0.000322, nox: 0.000501, hg: 0 },
  MD: { co2: 1.215971, ch4: 0.000089, n2o: 0.000012, so2: 0.000348, nox: 0.000514, hg: 0 },
  MA: { co2: 0.933641, ch4: 0.000068, n2o: 0.000008, so2: 0.000134, nox: 0.000429, hg: 0 },
  MI: { co2: 1.460093, ch4: 0.000139, n2o: 0.00002, so2: 0.000979, nox: 0.001236, hg: 0 },
  MN: { co2: 1.522568, ch4: 0.000135, n2o: 0.000019, so2: 0.000381, nox: 0.001099, hg: 0 },
  MS: { co2: 1.04226, ch4: 0.000038, n2o: 0.000005, so2: 0.000129, nox: 0.000581, hg: 0 },
  MO: { co2: 1.855762, ch4: 0.00019, n2o: 0.000027, so2: 0.001834, nox: 0.001514, hg: 0 },
  MT: { co2: 1.822761, ch4: 0.000163, n2o: 0.000023, so2: 0.000655, nox: 0.002403, hg: 0 },
  NE: { co2: 2.039632, ch4: 0.000225, n2o: 0.000033, so2: 0.003921, nox: 0.002039, hg: 0 },
  NV: { co2: 1.035114, ch4: 0.000043, n2o: 0.000006, so2: 0.000335, nox: 0.000765, hg: 0 },
  NH: { co2: 0.935261, ch4: 0.000074, n2o: 0.00001, so2: 0.000174, nox: 0.00038, hg: 0 },
  NJ: { co2: 0.895495, ch4: 0.00003, n2o: 0.000003, so2: 0.000041, nox: 0.000254, hg: 0 },
  NM: { co2: 1.489153, ch4: 0.000098, n2o: 0.000014, so2: 0.000217, nox: 0.001078, hg: 0 },
  NY: { co2: 1.038038, ch4: 0.000035, n2o: 0.000004, so2: 0.000073, nox: 0.000475, hg: 0 },
  NC: { co2: 1.278075, ch4: 0.000083, n2o: 0.000012, so2: 0.00038, nox: 0.000836, hg: 0 },
  ND: { co2: 2.036713, ch4: 0.000216, n2o: 0.000031, so2: 0.002504, nox: 0.00193, hg: 0 },
  OH: { co2: 1.544105, ch4: 0.000115, n2o: 0.000016, so2: 0.001066, nox: 0.000732, hg: 0 },
  OK: { co2: 1.281877, ch4: 0.000059, n2o: 0.000008, so2: 0.000555, nox: 0.001145, hg: 0 },
  OR: { co2: 0.931028, ch4: 0.000056, n2o: 0.000007, so2: 0.000097, nox: 0.002237, hg: 0 },
  PA: { co2: 1.338253, ch4: 0.000096, n2o: 0.000013, so2: 0.000942, nox: 0.00078, hg: 0 },
  RI: { co2: 0.942327, ch4: 0.000018, n2o: 0.000002, so2: 0.000009, nox: 0.000187, hg: 0 },
  SC: { co2: 1.575453, ch4: 0.000148, n2o: 0.000021, so2: 0.00054, nox: 0.000742, hg: 0 },
  SD: { co2: 1.522399, ch4: 0.0001, n2o: 0.000014, so2: 0.000322, nox: 0.001349, hg: 0 },
  TN: { co2: 1.73321, ch4: 0.000158, n2o: 0.000023, so2: 0.000564, nox: 0.000559, hg: 0 },
  TX: { co2: 1.299256, ch4: 0.000078, n2o: 0.000011, so2: 0.00082, nox: 0.00096, hg: 0 },
  UT: { co2: 1.934773, ch4: 0.000183, n2o: 0.000026, so2: 0.00045, nox: 0.001887, hg: 0 },
  VT: { co2: 0.539254, ch4: 0.000949, n2o: 0.000125, so2: 0.000114, nox: 0.001221, hg: 0 },
  VA: { co2: 0.956321, ch4: 0.000071, n2o: 0.000009, so2: 0.000118, nox: 0.000405, hg: 0 },
  WA: { co2: 1.046356, ch4: 0.000101, n2o: 0.000014, so2: 0.00023, nox: 0.00102, hg: 0 },
  WV: { co2: 2.149051, ch4: 0.000243, n2o: 0.000035, so2: 0.001432, nox: 0.001194, hg: 0 },
  WI: { co2: 1.819192, ch4: 0.000189, n2o: 0.000027, so2: 0.000274, nox: 0.000837, hg: 0 },
  WY: { co2: 2.356978, ch4: 0.000252, n2o: 0.000037, so2: 0.001587, nox: 0.001612, hg: 0 },
};

// Equivalency factors: per metric ton CO2-equivalent
// Source: EPA Greenhouse Gas Equivalencies Calculator (updated to 2023 values)
// https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator
var EQUIV_PER_MT_CO2E = {
  carsRemoved: 1 / 4.65, // EPA 2023: 4.65 MT CO2e/vehicle/year (was 5.23, older EPA value)
  gallonsGasoline: 1 / 0.00889, // EPA current: unchanged
  tankerTrucks: 1 / 74.89,
  barrelsOil: 2.11,
  households: 1 / 7.46, // EPA 2023: 7.46 MT CO2e/household (was 7.7, older EPA value)
  treeSeedlings: 17, // EPA current: ~17 trees/MT (was 23, older EPA value)
  acresForest: 1.099, // EPA current: 1.099 acres/MT (0.91 MT/acre/yr); was 0.0074 which was erroneous
  railcarsCoal: 0.0046,
  tonsRecycled: 1 / 2.97,
  propaneCylinders: 1 / 0.054,
  coalPlants: 1 / 3850479,
};

// GWP (Global Warming Potential) multipliers for CO2-equivalent (Excel row 19)
var GWP_CH4 = 21;
var GWP_N2O = 310;

// Metric ton equivalents — used by PDF export (mirrors EQUIV_PER_MT_CO2E above)
var POLLUTION_EQUIV_MT = {
  co2PerKwh: 0.000404, // retained for backward compat (PDF export section uses its own constants)
  co2PerTherm: 0.005302, // retained for backward compat
  co2PerPropGal: 0.00574, // retained for backward compat
  treesPerTon: 17, // EPA 2023: ~17 trees/MT (was 23)
  carsPerTon: 1 / 4.65, // EPA 2023: 4.65 MT CO2e/vehicle/year (was 1/5.23)
  homesPerTon: 1 / 7.46, // EPA 2023: 7.46 MT CO2e/household (was 1/7.7)
  acresForestPerTon: 1.099, // EPA current: 1.099 acres/MT (was 0.0074, erroneous)
};

function calculatePollutionCredits(kwhSaved, thermsSaved, propaneGalSaved, stateCode, unit) {
  unit = unit || 'lbs';

  if (unit === 'mt') {
    // Metric ton mode (used by PDF export)
    var elec = EGRID_FACTORS[stateCode] || EGRID_FACTORS['KS'];
    var gasMMBtu = thermsSaved * GAS_THERM_TO_MMBTU;
    var propMMBtu = propaneGalSaved * PROPANE_GAL_TO_MMBTU;

    // CO2 in metric tons from each fuel
    var elecCO2mt = (kwhSaved * elec.co2) / LBS_PER_METRIC_TON;
    var gasCO2mt = (gasMMBtu * GAS_FACTORS.co2) / LBS_PER_METRIC_TON;
    var propCO2mt = (propMMBtu * PROPANE_FACTORS.co2) / LBS_PER_METRIC_TON;

    // CH4 and N2O in metric tons
    var elecCH4mt = (kwhSaved * elec.ch4) / LBS_PER_METRIC_TON;
    var gasCH4mt = (gasMMBtu * GAS_FACTORS.ch4) / LBS_PER_METRIC_TON;
    var propCH4mt = (propMMBtu * PROPANE_FACTORS.ch4) / LBS_PER_METRIC_TON;
    var totalCH4mt = elecCH4mt + gasCH4mt + propCH4mt;

    var elecN2Omt = (kwhSaved * elec.n2o) / LBS_PER_METRIC_TON;
    var gasN2Omt = (gasMMBtu * GAS_FACTORS.n2o) / LBS_PER_METRIC_TON;
    var propN2Omt = (propMMBtu * PROPANE_FACTORS.n2o) / LBS_PER_METRIC_TON;
    var totalN2Omt = elecN2Omt + gasN2Omt + propN2Omt;

    var totalCO2mt = elecCO2mt + gasCO2mt + propCO2mt;
    var totalCO2e = totalCO2mt + GWP_CH4 * totalCH4mt + GWP_N2O * totalN2Omt;
    var lbsCO2 = totalCO2mt * LBS_PER_METRIC_TON;

    var eq = EQUIV_PER_MT_CO2E;
    return {
      totalCO2: totalCO2e,
      lbsCO2: lbsCO2,
      equivalents: {
        treeSeedlings: Math.round(Math.abs(totalCO2e) * eq.treeSeedlings),
        carsRemoved: Math.abs(totalCO2e * eq.carsRemoved),
        households: Math.abs(totalCO2e * eq.households),
        acresForest: Math.abs(totalCO2e * eq.acresForest),
      },
      stateCode: stateCode,
      inputs: { kwhSaved: kwhSaved, thermsSaved: thermsSaved, propaneGalSaved: propaneGalSaved },
    };
  }

  // Default: lbs mode
  var elec = EGRID_FACTORS[stateCode] || EGRID_FACTORS['KS'];
  var gasMMBtu = thermsSaved * GAS_THERM_TO_MMBTU;
  var propMMBtu = propaneGalSaved * PROPANE_GAL_TO_MMBTU;

  // Calculate each pollutant in lbs (electric uses lbs/kWh, gas/propane use lbs/MMBtu)
  var pollutants = {
    co2: kwhSaved * elec.co2 + gasMMBtu * GAS_FACTORS.co2 + propMMBtu * PROPANE_FACTORS.co2,
    ch4: kwhSaved * elec.ch4 + gasMMBtu * GAS_FACTORS.ch4 + propMMBtu * PROPANE_FACTORS.ch4,
    n2o: kwhSaved * elec.n2o + gasMMBtu * GAS_FACTORS.n2o + propMMBtu * PROPANE_FACTORS.n2o,
    so2: kwhSaved * elec.so2 + gasMMBtu * GAS_FACTORS.so2 + propMMBtu * PROPANE_FACTORS.so2,
    nox: kwhSaved * elec.nox + gasMMBtu * GAS_FACTORS.nox + propMMBtu * PROPANE_FACTORS.nox,
    hg: kwhSaved * elec.hg + gasMMBtu * GAS_FACTORS.hg + propMMBtu * PROPANE_FACTORS.hg,
    pm10: gasMMBtu * GAS_FACTORS.pm10,
    pm_filt: propMMBtu * PROPANE_FACTORS.pm_filt,
    voc: gasMMBtu * GAS_FACTORS.voc + propMMBtu * PROPANE_FACTORS.voc,
    co: gasMMBtu * GAS_FACTORS.co + propMMBtu * PROPANE_FACTORS.co,
  };

  // Convert small-quantity pollutants to ounces (lbs * 16) for display
  // Preserving _oz suffix keys for backward compatibility with report-engine.js and graphics-setpoints.js
  pollutants.hg_oz = pollutants.hg * 16;
  pollutants.pm10_oz = pollutants.pm10 * 16;
  pollutants.pm_filt_oz = pollutants.pm_filt * 16;
  pollutants.voc_oz = pollutants.voc * 16;
  pollutants.co_oz = pollutants.co * 16;

  // CO2-equivalent in metric tons (Excel formula: CO2 + 21*CH4 + 310*N2O, all in MT)
  var co2eMT = (pollutants.co2 + GWP_CH4 * pollutants.ch4 + GWP_N2O * pollutants.n2o) / LBS_PER_METRIC_TON;

  // Equivalencies based on CO2e metric tons (Excel Calculations rows 34-44)
  var eq = EQUIV_PER_MT_CO2E;
  var absCo2eMT = Math.abs(co2eMT);
  var equivalents = {
    carsRemoved: Math.ceil(absCo2eMT * eq.carsRemoved),
    gallonsGasoline: Math.ceil(absCo2eMT * eq.gallonsGasoline),
    tankerTrucks: Math.ceil(absCo2eMT * eq.tankerTrucks),
    barrelsOil: Math.ceil(absCo2eMT * eq.barrelsOil),
    households: Math.ceil(absCo2eMT * eq.households),
    treeSeedlings: Math.ceil(absCo2eMT * eq.treeSeedlings),
    acresForest: Math.ceil(absCo2eMT * eq.acresForest),
    railcarsCoal: Math.ceil(absCo2eMT * eq.railcarsCoal),
    tonsRecycled: Math.ceil(absCo2eMT * eq.tonsRecycled),
    propaneCylinders: Math.ceil(absCo2eMT * eq.propaneCylinders),
    coalPlants: Math.ceil(absCo2eMT * eq.coalPlants),
  };

  return {
    pollutants: pollutants,
    equivalents: equivalents,
    co2eMT: co2eMT,
    stateCode: stateCode,
    inputs: { kwhSaved: kwhSaved, thermsSaved: thermsSaved, propaneGalSaved: propaneGalSaved },
  };
}
