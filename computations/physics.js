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
