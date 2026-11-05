// computations/pollution.js — Pollution credits (canonical source)

// Unit conversion constants
var GAS_THERM_TO_MMBTU = 0.1; // 1 therm = 0.1 MMBtu
var PROPANE_GAL_TO_MMBTU = 0.091452; // 1 gallon propane = 0.091452 MMBtu (EPA GHG Emission Factors Hub heat content)
var KG_TO_LB = 2.20462;
var LBS_PER_METRIC_TON = 2204.6; // Excel uses this constant throughout

// On-site fuel emission factors: lbs per MMBtu.
// CO2, CH4, N2O: U.S. EPA GHG Emission Factors Hub (stationary combustion, Table 1):
//   natural gas 53.06 kg CO2/MMBtu, 1.0 g CH4/MMBtu, 0.10 g N2O/MMBtu;
//   propane (LPG) 61.71 kg CO2/MMBtu, 3.0 g CH4/MMBtu, 0.60 g N2O/MMBtu.
// SO2, NOx: EPA AP-42 section 1.4 (natural gas, per MMBtu) and section 1.5 (propane, per 1000 gal,
//   converted to per MMBtu with PROPANE_GAL_TO_MMBTU).
// PM10, VOC, CO and Hg are not computed: eGRID has no electricity factor for them, so a mixed total would mislead.
var GAS_FACTORS = {
  co2: 53.06 * KG_TO_LB,
  ch4: 0.001 * KG_TO_LB,
  n2o: 0.0001 * KG_TO_LB,
  so2: 0.0006,
  nox: 0.098,
};

var PROPANE_FACTORS = {
  co2: 61.71 * KG_TO_LB,
  ch4: 0.003 * KG_TO_LB,
  n2o: 0.0006 * KG_TO_LB,
  so2: 0.00001 / PROPANE_GAL_TO_MMBTU,
  nox: 0.013 / PROPANE_GAL_TO_MMBTU,
};

// Electric emission factors: lbs per kWh.
// Source: U.S. EPA eGRID2023 (rev 2), "eGRID Summary Tables 2023", Table 3 "State Output Emission Rates",
// total output emission rates in lb/MWh (CO2, CH4, N2O, SO2, annual NOx), divided by 1000 here to give lb/kWh.
// eGRID publishes no state electricity rate for Hg, PM10, VOC or CO, so those are not computed for electricity.
var EGRID_SOURCE_LABEL = 'EPA eGRID2023 (rev 2)';
var ONSITE_FUEL_SOURCE_LABEL = 'EPA GHG Emission Factors Hub';

// The one source line printed with emission figures (report and site).
function emissionsSourceLine(stateCode) {
  return EGRID_SOURCE_LABEL + ', state ' + stateCode + ' (electricity); ' + ONSITE_FUEL_SOURCE_LABEL + ' (natural gas, propane)';
}
var EGRID_FACTORS = {
  AK: { co2: 0.8098, ch4: 0.000072, n2o: 0.00001, so2: 0.000404, nox: 0.0062 },
  AL: { co2: 0.711, ch4: 0.000045, n2o: 0.000007, so2: 0.000093, nox: 0.0002 },
  AR: { co2: 0.9934, ch4: 0.000076, n2o: 0.000011, so2: 0.000857, nox: 0.0005 },
  AZ: { co2: 0.6867, ch4: 0.000038, n2o: 0.000005, so2: 0.000126, nox: 0.0003 },
  CA: { co2: 0.3935, ch4: 0.000021, n2o: 0.000003, so2: 0.000013, nox: 0.0003 },
  CO: { co2: 1.085, ch4: 0.000092, n2o: 0.000013, so2: 0.000351, nox: 0.0005 },
  CT: { co2: 0.5383, ch4: 0.00004, n2o: 0.000005, so2: 0.000072, nox: 0.0002 },
  DC: { co2: 0.3941, ch4: 0.000017, n2o: 0.000002, so2: 0.000027, nox: 0.0028 },
  DE: { co2: 0.7032, ch4: 0.000017, n2o: 0.000002, so2: 0.000074, nox: 0.0002 },
  FL: { co2: 0.7866, ch4: 0.00004, n2o: 0.000005, so2: 0.000126, nox: 0.0003 },
  GA: { co2: 0.7138, ch4: 0.000055, n2o: 0.000008, so2: 0.0002, nox: 0.0003 },
  HI: { co2: 1.3851, ch4: 0.000137, n2o: 0.000022, so2: 0.004339, nox: 0.005 },
  IA: { co2: 0.6302, ch4: 0.00006, n2o: 0.000009, so2: 0.00052, nox: 0.0004 },
  ID: { co2: 0.3133, ch4: 0.000009, n2o: 0.000001, so2: 0.000049, nox: 0.0001 },
  IL: { co2: 0.4717, ch4: 0.000042, n2o: 0.000006, so2: 0.00027, nox: 0.0002 },
  IN: { co2: 1.4572, ch4: 0.000126, n2o: 0.000018, so2: 0.000547, nox: 0.0008 },
  KS: { co2: 0.7282, ch4: 0.000077, n2o: 0.000011, so2: 0.000113, nox: 0.0005 },
  KY: { co2: 1.735, ch4: 0.000181, n2o: 0.000026, so2: 0.001116, nox: 0.001 },
  LA: { co2: 0.7614, ch4: 0.000026, n2o: 0.000004, so2: 0.000192, nox: 0.0007 },
  MA: { co2: 0.8224, ch4: 0.000124, n2o: 0.000016, so2: 0.000278, nox: 0.0006 },
  MD: { co2: 0.52, ch4: 0.000035, n2o: 0.000005, so2: 0.000116, nox: 0.0002 },
  ME: { co2: 0.3118, ch4: 0.000076, n2o: 0.000011, so2: 0.000188, nox: 0.0003 },
  MI: { co2: 0.7932, ch4: 0.000065, n2o: 0.000009, so2: 0.000439, nox: 0.0006 },
  MN: { co2: 0.7475, ch4: 0.000073, n2o: 0.00001, so2: 0.000187, nox: 0.0005 },
  MO: { co2: 1.4441, ch4: 0.000158, n2o: 0.000023, so2: 0.00218, nox: 0.0011 },
  MS: { co2: 0.8263, ch4: 0.00003, n2o: 0.000004, so2: 0.000123, nox: 0.0004 },
  MT: { co2: 1.0562, ch4: 0.000116, n2o: 0.000017, so2: 0.000809, nox: 0.0009 },
  NC: { co2: 0.624, ch4: 0.000038, n2o: 0.000005, so2: 0.000166, nox: 0.0004 },
  ND: { co2: 1.2884, ch4: 0.000143, n2o: 0.000021, so2: 0.001603, nox: 0.0013 },
  NE: { co2: 1.0182, ch4: 0.000115, n2o: 0.000017, so2: 0.002119, nox: 0.001 },
  NH: { co2: 0.2729, ch4: 0.000054, n2o: 0.000007, so2: 0.000053, nox: 0.0001 },
  NJ: { co2: 0.4683, ch4: 0.000031, n2o: 0.000004, so2: 0.000059, nox: 0.0002 },
  NM: { co2: 0.7702, ch4: 0.000053, n2o: 0.000007, so2: 0.000105, nox: 0.0004 },
  NV: { co2: 0.6424, ch4: 0.000024, n2o: 0.000003, so2: 0.000137, nox: 0.0005 },
  NY: { co2: 0.4651, ch4: 0.000025, n2o: 0.000003, so2: 0.000051, nox: 0.0002 },
  OH: { co2: 1.0638, ch4: 0.000068, n2o: 0.00001, so2: 0.00061, nox: 0.0003 },
  OK: { co2: 0.6472, ch4: 0.000026, n2o: 0.000003, so2: 0.000221, nox: 0.0005 },
  OR: { co2: 0.3642, ch4: 0.000013, n2o: 0.000002, so2: 0.00002, nox: 0.0006 },
  PA: { co2: 0.6458, ch4: 0.000034, n2o: 0.000004, so2: 0.000229, nox: 0.0002 },
  PR: { co2: 1.5431, ch4: 0.000077, n2o: 0.000012, so2: 0.003695, nox: 0.0039 },
  RI: { co2: 0.8391, ch4: 0.000016, n2o: 0.000002, so2: 0.000013, nox: 0.0004 },
  SC: { co2: 0.5572, ch4: 0.000048, n2o: 0.000007, so2: 0.000171, nox: 0.0002 },
  SD: { co2: 0.334, ch4: 0.000024, n2o: 0.000003, so2: 0.000076, nox: 0.0003 },
  TN: { co2: 0.6573, ch4: 0.000059, n2o: 0.000008, so2: 0.000213, nox: 0.0002 },
  TX: { co2: 0.7683, ch4: 0.000044, n2o: 0.000006, so2: 0.000389, nox: 0.0005 },
  UT: { co2: 1.413, ch4: 0.000125, n2o: 0.000018, so2: 0.000275, nox: 0.0013 },
  VA: { co2: 0.5369, ch4: 0.000044, n2o: 0.000006, so2: 0.000071, nox: 0.0002 },
  VT: { co2: 0.043, ch4: 0.000147, n2o: 0.000019, so2: 0.000039, nox: 0.0002 },
  WA: { co2: 0.2651, ch4: 0.000023, n2o: 0.000003, so2: 0.000044, nox: 0.0002 },
  WI: { co2: 1.157, ch4: 0.0001, n2o: 0.000014, so2: 0.000144, nox: 0.0005 },
  WV: { co2: 1.9544, ch4: 0.000218, n2o: 0.000032, so2: 0.001498, nox: 0.0011 },
  WY: { co2: 1.8203, ch4: 0.000195, n2o: 0.000028, so2: 0.001113, nox: 0.0012 },
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

// GWP (Global Warming Potential, 100-year) multipliers for CO2-equivalent.
// Source: IPCC Fifth Assessment Report (AR5), the values the EPA GHG Emission Factors Hub uses: CH4 = 28, N2O = 265.
var GWP_CH4 = 28;
var GWP_N2O = 265;

// Display text for a change compared with baseline. Input: the AVOIDED amount from calculatePollutionCredits
// (or an energy saving), positive = less than baseline. Output: "+1,234" = MORE than baseline, "-1,234" = LESS.
// Empty when it rounds to zero. This is the only place that flips the sign for display.
function emissionsChangeText(avoided) {
  var v = Math.round(-(avoided || 0));
  if (!v) return '0';
  return (v > 0 ? '+' : '-') + Math.abs(v).toLocaleString('en-US');
}
// "Energy use compared with baseline: electricity +107,310 kWh, natural gas -222 therms, propane -24 gal".
// Inputs are the SAVED amounts (positive = less use), so the shown sign is the use change.
function energyUseChangeLine(kwhSaved, thermsSaved, galSaved) {
  return (
    'Energy use compared with baseline: electricity ' + emissionsChangeText(kwhSaved) + ' kWh, natural gas ' +
    emissionsChangeText(thermsSaved) + ' therms, propane ' + emissionsChangeText(galSaved) + ' gal'
  );
}
var EMISSIONS_SIGN_NOTE = 'A plus sign means more emissions than baseline.';

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
  };

  // CO2-equivalent in metric tons (CO2 + GWP_CH4*CH4 + GWP_N2O*N2O, all in MT)
  var co2eMT = (pollutants.co2 + GWP_CH4 * pollutants.ch4 + GWP_N2O * pollutants.n2o) / LBS_PER_METRIC_TON;

  // Equivalencies based on CO2e metric tons (Excel Calculations rows 34-44)
  var eq = EQUIV_PER_MT_CO2E;
  // Equivalents describe avoided emissions only; a net increase has none.
  var absCo2eMT = Math.max(0, co2eMT);
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
