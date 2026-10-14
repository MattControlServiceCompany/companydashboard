// computations/physics.js - the ONE home for physical constants and fan/motor power rules.
// No DOM dependencies. Loaded before every file that uses it. tools/gate-single-physics.js
// fails when any other file in app/, computations/, extraction/ or lib/ keeps its own copy.
//
// Chain (Matt, 2026-10-13): baseline -> HVAC Load Estimate -> per-measure calc template -> baseline rates.
// A calc template calls these functions. It never writes its own affinity law or unit factor.

// ---- unit constants ----
var KW_PER_HP = 0.746; // kW per mechanical horsepower (NEMA 746 W/hp)
// Electric: EIA, 1 kWh = 3,412.14 Btu
// https://www.eia.gov/energyexplained/units-and-calculators/british-thermal-units.php
var BTU_PER_KWH = 3412.14; // Btu per kWh. Every other electric factor below comes from this one.
var BTU_PER_THERM = 100000; // Btu per therm of natural gas
var KBTU_PER_KWH = BTU_PER_KWH / 1000; // kBtu per kWh (site energy)
var KBTU_PER_THERM = BTU_PER_THERM / 1000; // 100 kBtu per therm
var THERMS_PER_KWH = BTU_PER_KWH / BTU_PER_THERM; // therms per kWh
var KWH_PER_MMBTU = 1000000 / BTU_PER_KWH; // 293.071 kWh per MMBtu
var THERMS_PER_MMBTU = 1000000 / BTU_PER_THERM; // 10 therms per MMBtu
var KWH_PER_BTU = 1 / BTU_PER_KWH; // kWh per Btu
var THERMS_PER_BTU = 1 / BTU_PER_THERM; // therms per Btu

// Propane: EIA, 1 gallon of propane = 91,452 Btu
// https://www.eia.gov/energyexplained/units-and-calculators/british-thermal-units.php
// ONE figure. The bill conversion (gallons -> therms) and the energy-use-intensity factor (kBtu per gallon)
// both come from it. Do not write a second propane figure.
var BTU_PER_GAL_PROPANE = 91452; // Btu per gallon of propane
var THERMS_PER_GAL_PROPANE = BTU_PER_GAL_PROPANE / BTU_PER_THERM; // 0.91452 therms per gallon
var KBTU_PER_GAL_PROPANE = BTU_PER_GAL_PROPANE / 1000; // 91.452 kBtu per gallon

// Boiler horsepower: 1 boiler hp = 33,475 Btu/h (ASME PTC 4; 34.5 lb/h steam from and at 212 F)
var BTU_PER_HR_PER_BHP = 33475; // Btu per hour per boiler horsepower
var THERMS_PER_HR_PER_BHP = BTU_PER_HR_PER_BHP / BTU_PER_THERM; // 0.33475 therm/h per boiler hp
// Steam: 1 boiler hp evaporates 34.5 lb/h of water from and at 212 F (ASME PTC 4; DOE AMO steam tip sheets).
// 33,475 / 34.5 = 970.3 Btu per lb, the latent heat of steam at 14.696 psia (ASHRAE Fundamentals steam tables;
// IAPWS 2256.9 kJ/kg). Both sources agree, so the Btu per lb derives from the boiler hp figure, never a second literal.
var LB_STEAM_PER_HR_PER_BHP = 34.5; // lb/h of steam per boiler hp, from and at 212 F
var BTU_PER_LB_STEAM = BTU_PER_HR_PER_BHP / LB_STEAM_PER_HR_PER_BHP; // 970.29 Btu per lb of steam
var THERMS_PER_LB_STEAM = BTU_PER_LB_STEAM / BTU_PER_THERM; // 0.0097029 therm per lb of steam (output, no efficiency)
// District steam METERED energy (what a utility bill delivers) uses a different factor from the boiler OUTPUT
// factor above (970.3 Btu/lb latent heat, used by _gasMaxThermHr). ENERGY STAR Portfolio Manager Thermal Energy
// Conversions: District Steam 1 lb = 1.194 kBtu (1,194 Btu/lb); kLbs = 1,194 kBtu; MLbs (million lb) = 1,194,000 kBtu.
// https://portfoliomanager.energystar.gov/pdf/reference/Thermal%20Conversions.pdf
// Keep both: boiler output is steam leaving the boiler; this one is benchmark energy of delivered district steam.
var BTU_PER_LB_DISTRICT_STEAM = 1194; // Btu per lb of district steam
var THERMS_PER_THOUSAND_LB_DISTRICT_STEAM = (BTU_PER_LB_DISTRICT_STEAM * 1000) / BTU_PER_THERM; // 11.94 therms per thousand lb (Mlb)

// ---- fan and pump power ----
var FAN_AFFINITY_EXPONENT = 3; // fan/pump power varies as speed to this power (affinity law)

/**
 * Electrical input kW of a motor.
 * @param {number} hp - shaft horsepower
 * @param {number} [motorEff] - motor efficiency as a fraction (0.91). Omit for kW at the shaft.
 */
function hpToKw(hp, motorEff) {
  return (hp * KW_PER_HP) / (motorEff == null ? 1 : motorEff);
}

/**
 * Fan or pump power as a fraction of full-speed power. The ONE affinity-law rule.
 *   fraction = fixedShare + (1 - fixedShare) * max(speed, minSpeed) ^ exponent
 * @param {number} speedFraction - speed (or flow) as a fraction of full speed, 0 to 1
 * @param {object} [opts]
 * @param {number} [opts.exponent=FAN_AFFINITY_EXPONENT] - power exponent; 3 is the ideal cube law
 * @param {number} [opts.minSpeed=0] - lowest speed the drive allows; speeds below it run at it
 * @param {number} [opts.fixedShare=0] - share of full power that does not fall with speed
 *   (bearing, drive and motor losses). 0 is the ideal law. Every caller today uses 0.
 * @returns {number} power fraction; multiply by full-speed kW
 */
function fanPowerFraction(speedFraction, opts) {
  var o = opts || {};
  var exponent = o.exponent == null ? FAN_AFFINITY_EXPONENT : o.exponent;
  var minSpeed = o.minSpeed == null ? 0 : o.minSpeed;
  var fixedShare = o.fixedShare == null ? 0 : o.fixedShare;
  var s = speedFraction < minSpeed ? minSpeed : speedFraction;
  return fixedShare + (1 - fixedShare) * Math.pow(s, exponent);
}

/**
 * Fan power saved by a duct static pressure reset, as a fraction of fan power.
 * Fan law: pressure varies as speed squared, so speed = sqrt(1 - pressure reduction).
 * Power then follows fanPowerFraction. Example: a 20 percent pressure cut saves 28.4 percent.
 * @param {number} spReductionFraction - pressure reduction as a fraction (0.2 = 20 percent)
 * @param {object} [opts] - passed to fanPowerFraction
 * @returns {number} fraction of fan power saved
 */
function ductStaticResetPowerSavings(spReductionFraction, opts) {
  return 1 - fanPowerFraction(Math.sqrt(1 - spReductionFraction), opts);
}

/**
 * Fan power per unit of air, W per cfm at full speed: the range from the fan opportunity method (15 air handlers
 * calibrated, R squared 0.92). low = the cube-law fit, high = the free fit at full speed, mid = their middle.
 * A quick estimate for a fan with a cfm and no motor data. Use the mid figure unless a person picks another.
 */
var FAN_W_PER_CFM = { low: 0.774, mid: 0.851, high: 0.928 };

/**
 * Ventilation (fan) electricity as a share of the TOTAL electricity of a building, by building type. Source: US EIA,
 * Commercial Buildings Energy Consumption Survey (CBECS) 2018, Table E5 "Electricity consumption (kWh) by end use, 2018"
 * (https://www.eia.gov/consumption/commercial/data/2018/ce/xls/e5.xlsx), billion kWh. Education: ventilation 19 of 128 total
 * (14.8 percent). All buildings: ventilation 213 of 1,196 total (17.8 percent). The default for a supply fan with no amps,
 * airflow or horsepower (computations/fan-savings.js, fanModelUnits). Fans run all year, so most of this energy sits in the
 * baseload of the bills, not in the HVAC electric above baseload.
 */
var FAN_VENTILATION_SHARE_CBECS = {
  education: { label: 'education', ventilationBillionKwh: 19, totalBillionKwh: 128 },
  all: { label: 'all', ventilationBillionKwh: 213, totalBillionKwh: 1196 },
};

/**
 * The ventilation share of total building electricity for a building type text (Education when it names a school, else All buildings).
 * @param {string} typeText - the building type, else the project type
 * @returns {{key:string, label:string, share:number}}
 */
function fanVentilationShare(typeText) {
  var key = /school|education|k-12/i.test(String(typeText || '')) ? 'education' : 'all';
  var row = FAN_VENTILATION_SHARE_CBECS[key];
  return { key: key, label: row.label, share: row.ventilationBillionKwh / row.totalBillionKwh };
}

/** Share of fan power that does not fall with speed (bearing, drive and motor losses). The default for fanPowerFraction callers that model a drive. */
var FAN_FIXED_POWER_SHARE = 0.1;

/** Power factor used to turn motor amps into kW when no power factor is known. */
var MOTOR_DEFAULT_POWER_FACTOR = 0.85;

/**
 * Fan input kW from airflow.
 * @param {number} cfm - airflow at full speed
 * @param {number} [wPerCfm] - W per cfm; default FAN_W_PER_CFM.mid
 */
function fanKwFromCfm(cfm, wPerCfm) {
  return (cfm * (wPerCfm == null ? FAN_W_PER_CFM.mid : wPerCfm)) / 1000;
}

/**
 * Motor input kW from a measured current. Three phase: sqrt(3) x volts x amps x power factor. Single phase: volts x amps x power factor.
 * @param {number} amps - line current
 * @param {number} volts - line voltage
 * @param {number} phase - 1 or 3
 * @param {number} [powerFactor] - default MOTOR_DEFAULT_POWER_FACTOR
 */
function motorKwFromAmps(amps, volts, phase, powerFactor) {
  var factor = powerFactor == null ? MOTOR_DEFAULT_POWER_FACTOR : powerFactor;
  return ((phase === 3 ? Math.sqrt(3) : 1) * volts * amps * factor) / 1000;
}

/**
 * Mean fan power as a fraction of full-speed power over a speed profile (hours or share by speed).
 * Every speed goes through fanPowerFraction. The shares need not add up to 1: the result is the share-weighted mean.
 * @param {Array<{speed:number, share:number}>} bins - speed (fraction of full speed) and its share of run time
 * @param {object} [opts] - passed to fanPowerFraction
 * @returns {number|null} null when the shares add up to 0
 */
function fanMeanPowerFraction(bins, opts) {
  var sum = 0;
  var acc = 0;
  for (var i = 0; i < bins.length; i++) {
    sum += bins[i].share;
    acc += bins[i].share * fanPowerFraction(bins[i].speed, opts);
  }
  return sum > 0 ? acc / sum : null;
}
