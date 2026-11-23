// computations/measure-savings.js - the ONE owner of the engineering energy of each Service Proposal savings measure (Matt 2026-11-23, 8c5bfd4a).
//
// "You need to estimate the savings using real formulas." Each measure the proposal sells has ONE owner function here. It turns the stated
// facts of a building into yearly QUANTITIES (kWh, therms, kW) with a physics formula. It never prices (the proposal prices once, at the
// building level, with the bill rates) and it never uses a judged "share saved". A measure that has no defensible formula says so
// (reason) and claims nothing.
//
// Reused formulas (no second copy of any):
//   fanResetSavingsFraction, fanSavingsForUnits inputs (computations/fan-savings.js)  duct static pressure reset on the fan model of the building
//   fanPowerFraction (computations/physics.js)                                         affinity law
//   dcvEnergySaved (app/ecm-calculators.js)                                            demand controlled ventilation
//   pumpVfdEnergySaved, vavMinFlowFanSaved (app/ecm-calculators.js)                    pump and fan affinity law (the pump_vfd and vav_reheat templates call them too)
//   ECM_TEMPLATES.occupancy_sensors (app/ecm-calculators.js)                           lighting occupancy sensors
//   BAS_WEATHER_BINS (app/data/bas-weather-bins.js)                                    typical-year hours by outdoor temperature bin
// New formulas (bin method, no function of the site did them): supply air temperature reset, economizer free cooling, terminal minimum
// airflow reheat, exterior photocell. Each is written once here.
//
// DATA LEVELS (the scheme of fan-savings.js): every input carries a level: 'trend' (a measured BAS trend), 'matrix' (a value in the Equipment
// Matrix), 'bill' (a utility bill value) or 'default' (a stated assumption, written below with its source). The estimate is a projection
// from the data on hand, not a measured and verified saving. Low / likely / high change ONLY stated input defaults (hours, cut, pass,
// occupancy, minimum flow, voltage, space type ...); the formula is the same in the three cases.
// SOURCES. A standard is named by its title. The edition and section must be checked before a client sees one: this module was written
// without the standards at hand.
//
// The building B that every owner reads is made by the caller (app/pricing-estimator.js, _pricingMeasureBuilding):
//   { sqft, heatFuel:'gas'|'electric', afue, cop, heatBalanceF,
//     counts:{ ahu, box }, fanUnits:[fanUnitModel result, ok only], fanCapKwh:number|null,
//     base:{ cool:kWh, heatEl:kWh, heatGas:therms }, window:{start,stop,level,source}, bins:[{t,hours}]|null (occupied window), degreeHours:{heat,cool}|null }
// Every owner returns null (no floor area or no weather: no estimate), { none:true, reason } (no formula: nothing claimed) or
// { low, likely, high } where each case = { kwh, therms, kw, byUse:{use:qty}, baseByUse:{use:qty}, inputs:[...], steps:[...] }.
// A use is an end use: fan, cool, heatEl (kWh), heatGas (therms), pumpHw, pumpChw, lightInt, lightExt (kWh). A measure never saves more
// than the base of its end use (byUse <= baseByUse).

var MS_CASES = ['low', 'likely', 'high'];
var MS_ELECTRIC_USES = ['fan', 'cool', 'heatEl', 'pumpHw', 'pumpChw', 'lightInt', 'lightExt'];
var MS_SENSIBLE_FACTOR = 1.08; // Btu/h per cfm per F (sensible heat of air; the factor typed in dcvEnergySaved and the BAS Savings Calc)
var MS_CFM_PER_TON = 400; // supply cfm per ton of cooling: the standard design rule of thumb (ASHRAE / ACCA)
var MS_SQFT_PER_TON = 300; // the BAS Savings Calc rule (app/calculators.js, max cooling tons = sqft / 300)
var MS_OA_CFM_PER_SQFT = 0.1; // the BAS Savings Calc rule (outside air cfm = sqft x 0.1)
var MS_HEAT_BTUH_PER_SQFT = 30; // the BAS Savings Calc rule (max heating = sqft x 30 Btu/h)
var MS_WATER_BTUH_PER_GPM_F = 500; // Btu/h per gpm per F of water
var MS_DEFAULT_WINDOW = { start: 8, stop: 18 }; // occupied hours of a building with no BAS schedule: 70 hours a week (fanDefaultRunHours 3,640 h a year) = 10 hours a day, every day
var MS_DAYLIGHT_HOURS = 4380; // hours of daylight in a year (12 h a day average at mid latitudes)

// The input defaults of the three cases. v = [low, likely, high] SAVINGS case. Every entry has a unit and a source. Built per call so
// the values that belong to another file (fan-savings.js, the ECM templates) are read from it, never typed again.
function _msTemplateDefault(templateId, inputId) {
  var t = typeof ECM_TEMPLATES !== 'undefined' ? ECM_TEMPLATES[templateId] : null;
  var inp = t && t.inputs ? t.inputs.find(function (i) { return i.id === inputId; }) : null;
  return inp ? inp.default : null;
}
function _msDefaults() {
  var cut = FAN_RESET_DEFAULT_PRESSURE_CUT;
  var pct = _msTemplateDefault('vav_reheat', 'pct_zones_heat') / 100;
  var mfOld = _msTemplateDefault('vav_reheat', 'min_flow_old') / 100;
  var mfNew = _msTemplateDefault('vav_reheat', 'min_flow_new') / 100;
  var tmplSrc = 'default: the value of the ECM Calculator template (app/ecm-calculators.js)';
  return {
    dspCut: { v: [cut - 0.05, cut, cut + 0.05], unit: 'share of static pressure', src: 'default: fan-savings.js FAN_RESET_DEFAULT_PRESSURE_CUT (20 percent) in the likely case, 5 points less and more in the other two' },
    dspPass: { v: [0.5, FAN_RESET_DEFAULT_PASS, 0.9], unit: 'share of fans', src: 'default: fan-savings.js FAN_RESET_DEFAULT_PASS (70 percent) in the likely case, 50 and 90 percent in the other two (no setpoint trend)' },
    fanHours: { v: [50 * 52, fanDefaultRunHours(), 84 * 52], unit: 'h per year', src: 'default: 70 hours a week = fan-savings.js fanDefaultRunHours() in the likely case, 50 and 84 hours a week in the other two (no run-hours trend)' },
    avgFlow: { v: [0.5, 0.6, 0.7], unit: 'share of design airflow', src: 'default: average supply airflow of a variable-volume unit in its occupied hours (no airflow trend)' },
    reheatShare: { v: [pct - 0.15, pct, pct + 0.15], unit: 'share of airflow', src: tmplSrc + ' vav_reheat, share of zones in reheat (40 percent) in the likely case, 15 points less and more in the other two' },
    satOld: { v: [55, 55, 55], unit: 'F', src: 'default: supply air temperature held at 55 F (ASHRAE Guideline 36 minimum supply air temperature)' },
    satMax: { v: [65, 65, 65], unit: 'F', src: 'default: ASHRAE Guideline 36 supply air temperature reset, maximum 65 F' },
    satOatLo: { v: [60, 60, 60], unit: 'F', src: 'default: ASHRAE Guideline 36 reset: maximum supply air temperature at outdoor air of 60 F or colder' },
    satOatHi: { v: [70, 70, 70], unit: 'F', src: 'default: ASHRAE Guideline 36 reset: minimum supply air temperature at outdoor air of 70 F or warmer' },
    returnTemp: { v: [75, 75, 75], unit: 'F', src: 'default: return air temperature in the cooling season (cooling setpoint 72 to 76 F)' },
    ecoLimit: { v: [65, 70, 75], unit: 'F', src: 'default: economizer high limit; ASHRAE 90.1 section 6.5.1 fixed dry bulb high limit 70 F in the likely case, 65 and 75 F in the other two' },
    balanceDelta: { v: [5, 0, -5], unit: 'F', src: 'default: the building balance point (the proposal heat balance temperature) 5 F warmer, the same, 5 F cooler' },
    dcvOcc: { v: [0.7, 0.5, 0.3], unit: 'share of design occupancy', src: 'default: average occupancy of an occupied hour as a share of the design occupancy (no people counts)' },
    dcvPerPerson: { v: [(5 * 10) / 1000 / (0.12 + (5 * 10) / 1000)], unit: 'share of outdoor air', src: 'default: ASHRAE 62.1 libraries, 5 cfm per person x 10 people per 1,000 ft2 against 0.12 cfm per ft2: the per-person share of the outdoor air' },
    mfOld: { v: [0.3, mfOld, 0.4], unit: 'share of design airflow', src: tmplSrc + ' vav_reheat, minimum airflow now (35 percent) in the likely case, 30 and 40 percent in the other two' },
    mfNew: { v: [0.2, mfNew, mfNew], unit: 'share of design airflow', src: tmplSrc + ' vav_reheat, new minimum airflow (15 percent: ASHRAE Guideline 36 terminal minimum) in the likely case and the high case, 20 percent in the low case' },
    reheatRise: { v: [15, 20, 25], unit: 'F', src: 'default: temperature rise of the reheat coil of a terminal unit at its minimum airflow (supply air 55 F to discharge 70 to 80 F)' },
    pumpCut: { v: [cut - 0.05, cut, cut + 0.1], unit: 'share of differential pressure', src: 'default: the duct static reset default (fan-savings.js, 20 percent) in the likely case, 15 and 30 percent in the other two' },
    pumpHead: { v: [60, 60, 60], unit: 'ft', src: tmplSrc + ' pump_vfd, system head' },
    pumpEff: { v: [0.72, 0.72, 0.72], unit: 'share', src: tmplSrc + ' pump_vfd, pump efficiency' },
    motorEff: { v: [0.91, 0.91, 0.91], unit: 'share', src: tmplSrc + ' pump_vfd, motor efficiency' },
    waterDt: { v: [20, 20, 20], unit: 'F', src: 'default: design water temperature difference (the heating hot water standard)' },
    occSpace: { v: ['office_open', 'classroom', 'office_priv'], unit: 'space type', src: 'default: the space types of the occupancy_sensors template (utility TRM vacancy midpoints 22.5, 30 and 35 percent)' },
    occHours: { v: [_msTemplateDefault('occupancy_sensors', 'scheduled_hours')], unit: 'h per year', src: tmplSrc + ' occupancy_sensors, scheduled hours' },
    occWatts: { v: [_msTemplateDefault('occupancy_sensors', 'fixture_watts')], unit: 'W', src: tmplSrc + ' occupancy_sensors, watts per fixture' },
    occFixtures: { v: [_msTemplateDefault('occupancy_sensors', 'fixtures_per_space')], unit: 'fixtures per space', src: tmplSrc + ' occupancy_sensors, fixtures per space' },
    occFactor: { v: [_msTemplateDefault('occupancy_sensors', 'control_factor')], unit: 'percent', src: tmplSrc + ' occupancy_sensors, control effectiveness' },
    photoWatts: { v: [150, 300, 450], unit: 'W per photocell circuit', src: 'default: 2, 4 or 6 exterior fixtures of 75 W on one photocell circuit (the Equipment Matrix holds no exterior fixture count or watts)' },
    photoHours: { v: [1000, 2000, MS_DAYLIGHT_HOURS], unit: 'h per year', src: 'default: daylight hours the exterior lights stay on without a photocell (1,000 and 2,000 h; 4,380 h = every daylight hour of the year)' },
  };
}
function _msPick(def, i) {
  return def.v.length === 1 ? def.v[0] : def.v[i];
}
// An input record: { name, value, unit, level, source }.
function _msIn(name, value, unit, level, source) {
  return { name: name, value: value, unit: unit, level: level, source: source };
}
function _msInDef(name, def, i) {
  return _msIn(name, _msPick(def, i), def.unit, 'default', def.src);
}
function _msStep(name, formula, value) {
  return { name: name, formula: formula, value: value };
}

// Typical-year hours by outdoor temperature bin inside the occupied window [startHour, stopHour): [{ t (bin midpoint, F), hours }].
// weather = BAS_WEATHER_BINS (app/data/bas-weather-bins.js). The ONE reader of those hours for the proposal estimates.
function msOccupiedBins(weather, cityId, startHour, stopHour) {
  var c = weather && weather.cities ? weather.cities[cityId] : null;
  if (!c) return null;
  var out = [];
  for (var b = 0; b < weather.bins.length; b++) {
    var hours = 0;
    for (var m = 0; m < c.temp.length; m++) for (var h = startHour; h < stopHour; h++) hours += c.temp[m][b][h] || 0;
    if (hours) out.push({ t: weather.bins[b], hours: hours });
  }
  return out;
}
function _msSumBins(bins, f) {
  var s = 0;
  bins.forEach(function (x) {
    s += f(x.t, x.hours);
  });
  return s;
}
function _msClamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
// Heat energy of Btu: therms (gas, through the boiler AFUE) or kWh (electric resistance, COP 1).
function _msHeatUse(B) {
  return B.heatFuel === 'gas' ? 'heatGas' : 'heatEl';
}
function _msHeatQty(B, btu) {
  return B.heatFuel === 'gas' ? btu / (BTU_PER_THERM * B.afue) : btu / BTU_PER_KWH;
}
function _msHeatUnit(B) {
  return B.heatFuel === 'gas' ? 'therms' : 'kWh';
}
function _msHeatFuelInput(B) {
  return _msIn('Heating fuel', B.heatFuel === 'gas' ? 'gas boiler, AFUE ' + B.afue : 'electric resistance, COP 1', '', 'bill', 'a building with a gas meter of 1,500 therms or more heats with gas; otherwise electric (proposal rule)');
}
// Supply airflow of the building at design: cooling tons (sqft / 300, the BAS Savings Calc rule) x 400 cfm per ton.
var MS_DEFAULT_BOX_CFM = 1000; // default design airflow of one terminal unit when the Equipment Matrix lists none (cfm)
function _msDesignCfm(B) {
  return (B.sqft / MS_SQFT_PER_TON) * MS_CFM_PER_TON;
}

// One fan unit of the fan model at the hours of a case: a unit with default hours takes the case hours, a unit with trend or matrix hours
// or sized by the national average keeps its own kWh (fan-savings.js).
function _msFanUnitKwh(u, hours) {
  if (u.sizeBasis === 'national' || u.hoursLevel !== 'default') return u.kwh;
  return u.kw * hours * u.baselineFraction;
}
// The fan base of a case: sum of the units, capped by the building total less cooling and electric heating (the rule of _fanEndUse).
function _msFanBase(B, hours) {
  var raw = 0;
  B.fanUnits.forEach(function (u) {
    raw += _msFanUnitKwh(u, hours);
  });
  var factor = B.fanCapKwh && raw > B.fanCapKwh ? B.fanCapKwh / raw : 1;
  return { raw: raw, factor: factor, kwh: raw * factor };
}
// A measure that does not apply, or has nothing to save: saving 0 with a stated reason (the 10-year rule then treats the item as over).
function _msZero(reason) {
  var o = { reason: reason };
  MS_CASES.forEach(function (k) {
    o[k] = { kwh: 0, therms: 0, kw: 0, byUse: {}, baseByUse: {}, inputs: [], steps: [_msStep('No saving', reason, 0)] };
  });
  return o;
}
// Closes one case: caps each use at its base, adds the totals.
function _msCase(byUse, baseByUse, kw, inputs, steps) {
  var out = { kwh: 0, therms: 0, kw: kw || 0, byUse: {}, baseByUse: baseByUse, inputs: inputs, steps: steps };
  Object.keys(byUse).forEach(function (u) {
    var v = Math.max(0, Math.min(byUse[u], baseByUse[u] === undefined ? byUse[u] : baseByUse[u]));
    out.byUse[u] = v;
    if (u === 'heatGas') out.therms += v;
    else out.kwh += v;
  });
  return out;
}
function _msEach(f) {
  var out = {};
  MS_CASES.forEach(function (k, i) {
    out[k] = f(i, k);
  });
  return out;
}
function _msLevelCounts(list, field) {
  var n = {};
  list.forEach(function (u) {
    n[u[field]] = (n[u[field]] || 0) + 1;
  });
  return Object.keys(n)
    .sort()
    .map(function (l) {
      return n[l] + ' ' + l;
    })
    .join(', ');
}
function _msWorstLevel(list, field) {
  var order = ['default', 'matrix', 'trend'];
  var worst = 2;
  list.forEach(function (u) {
    worst = Math.min(worst, Math.max(0, order.indexOf(u[field])));
  });
  return order[worst];
}

/* msDspReset(B, qty): duct static pressure reset (ahu_dsp_reset; spOverride is the same saving, qty null = every unit).
   Per unit of the fan model that has a variable-speed drive (driveStatus 'has': the rule of fanSavingsForUnits):
     saving = unit fan kWh x fanResetSavingsFraction(cut) x pass,    fanResetSavingsFraction = 1 - (fixed + (1 - fixed) x sqrt(1 - cut)^3)
   (affinity law, fixed = 10 percent: physics.js FAN_FIXED_POWER_SHARE). Unit fan kWh = kW x hours x part-load fraction (fanUnitModel).
   The item covers `qty` units: the mean saving of the counted units x min(qty, counted units). The item itself shows the unit controls duct static
   pressure: the Equipment Matrix terminal unit count is NOT a gate (missing input is unknown, never a gap). A building with no sized fan unit takes
   the fan model's default unit (fanBuildingUnitModels, national ventilation share). */
function msDspReset(B, qty) {
  // A unit with a drive counts in every case; a unit whose drive is not in the data counts in the likely and high cases (the reset needs a drive,
  // unknown is not "none"); a unit known to have no drive counts in none.
  var anyDrive = B.fanUnits.filter(function (u) {
    return u.driveStatus === 'has' || u.driveStatus === 'unknown';
  });
  if (!B.fanUnits.length) return null; // no utility electricity use: the fan model has no default either (unknown, kept)
  if (!anyDrive.length) return _msZero('every fan of the building is known to have no variable-speed drive');
  var D = _msDefaults();
  return _msEach(function (i) {
    var units = anyDrive.filter(function (u) {
      return u.driveStatus === 'has' || i > 0;
    });
    var cut = _msPick(D.dspCut, i);
    var hours = _msPick(D.fanHours, i);
    var fb = _msFanBase(B, hours);
    if (!units.length) {
      return _msCase({ fan: 0 }, { fan: fb.kwh }, 0, [_msInDef('Fan run hours (units with default hours)', D.fanHours, i)], [_msStep('No saving', 'no fan has a variable-speed drive in the data (low case)', 0)]);
    }
    var covered = qty > 0 ? Math.min(qty, units.length) : units.length;
    var frac = fanResetSavingsFraction(cut);
    var sum = 0;
    var kwSum = 0;
    var baseSum = 0;
    units.forEach(function (u) {
      var pass = u.reset && u.reset.level === 'trend' ? u.reset.pass : _msPick(D.dspPass, i);
      var base = _msFanUnitKwh(u, hours) * fb.factor;
      baseSum += base;
      sum += base * frac * pass;
      kwSum += u.kw * u.baselineFraction * fb.factor * frac * pass;
    });
    // the one default unit stands for every fan of the building: the item covers qty of the building's air handlers
    var whole = units.length === 1 && units[0].id === FAN_BUILDING_DEFAULT_ID;
    var scale = whole ? (qty > 0 ? Math.min(1, qty / Math.max(1, B.counts.ahu)) : 1) : covered / units.length;
    var kwhSaved = sum * scale;
    var unknown = units.filter(function (u) {
      return u.driveStatus !== 'has';
    }).length;
    var inputs = [
      _msInDef('Static pressure cut', D.dspCut, i),
      _msInDef('Share of fans the reset works on', D.dspPass, i),
      _msInDef('Fan run hours (units with default hours)', D.fanHours, i),
      _msIn('Fan kW of the ' + units.length + ' units counted', units.reduce(function (s, u) { return s + u.kw; }, 0), 'kW', _msWorstLevel(units, 'kwLevel'), 'fan model (fanModelUnits): ' + _msLevelCounts(units, 'kwLevel')),
      _msIn('Units with a drive not in the data', unknown, 'units', 'default', 'counted in the likely and high cases, not in the low case (the drive status of the Equipment Matrix is unknown)'),
      _msIn('Units covered by the item', covered, 'units', 'matrix', 'the item quantity, at most the units counted'),
    ];
    var steps = [
      _msStep('Fan power saved by the cut', '1 - (0.10 + 0.90 x sqrt(1 - cut)^3)', frac),
      _msStep('Baseline fan energy of the counted units', 'sum of kW x hours x part-load fraction', baseSum),
      _msStep('Energy saved', 'baseline x fraction saved x pass x covered / counted', kwhSaved),
    ];
    return _msCase({ fan: kwhSaved }, { fan: fb.kwh }, kwSum * scale, inputs, steps);
  });
}

/* msSatReset(B, qty): supply air temperature reset (ahu_sat_reset; satOverride = same saving, qty null = every unit). Bin method on the
   typical year of the occupied window. Now: supply air held at satOld (55 F). Reset (ASHRAE Guideline 36): the supply air is satMax (65 F) at
   outdoor air of 60 F or colder, falls linearly to satOld at 70 F. In each bin (outdoor temperature t, hours h):
     dSAT      = satNew(t) - satOld
     reheat    = 1.08 x reheat cfm x dSAT x h,   reheat cfm = design airflow x share of zones in reheat x their minimum airflow   (heat: gas / AFUE or electric)
     cooling   = 1.08 x average cfm x ( max(0, t - satOld) - max(0, t - satNew) ) x h / (COP x Btu per kWh)   (coil load, mixed air = outdoor air:
                 an economizer holds the supply air)
   Fan: 0. Raising the supply air temperature raises airflow only in zones at their maximum airflow; at outdoor temperatures below 70 F in
   the occupied hours the zones sit at their minimum airflow (Guideline 36), so the fan penalty is taken as 0 and no fan saving is credited. */
function msSatReset(B, qty) {
  if (!B.bins || !(B.sqft > 0)) return null;
  var D = _msDefaults();
  var n = Math.max(1, B.counts.ahu);
  var share = qty > 0 ? Math.min(1, qty / n) : 1;
  var hu = _msHeatUse(B);
  return _msEach(function (i) {
    var satOld = _msPick(D.satOld, i);
    var satMax = _msPick(D.satMax, i);
    var lo = _msPick(D.satOatLo, i);
    var hi = _msPick(D.satOatHi, i);
    var cfmAvg = _msDesignCfm(B) * share * _msPick(D.avgFlow, i);
    var cfmReheat = _msDesignCfm(B) * share * _msPick(D.reheatShare, i) * _msPick(D.mfOld, i); // zones in reheat sit at their minimum airflow
    var reheatBtu = _msSumBins(B.bins, function (t, h) {
      var dSat = (satMax - satOld) * _msClamp((hi - t) / (hi - lo), 0, 1);
      return MS_SENSIBLE_FACTOR * cfmReheat * dSat * h;
    });
    var coilBtu = _msSumBins(B.bins, function (t, h) {
      var satNew = satOld + (satMax - satOld) * _msClamp((hi - t) / (hi - lo), 0, 1);
      return MS_SENSIBLE_FACTOR * cfmAvg * (Math.max(0, t - satOld) - Math.max(0, t - satNew)) * h;
    });
    var heat = _msHeatQty(B, reheatBtu);
    var cool = coilBtu / (B.cop * BTU_PER_KWH);
    var inputs = [
      _msIn('Floor area', B.sqft, 'ft2', 'bill', 'the building floor area (utility data)'),
      _msIn('Design supply airflow', _msDesignCfm(B) * share, 'cfm', 'default', 'floor area / 300 ft2 per ton x 400 cfm per ton (BAS Savings Calc cooling rule)'),
      _msInDef('Average airflow', D.avgFlow, i),
      _msInDef('Share of zones in reheat', D.reheatShare, i),
      _msInDef('Minimum airflow of the zones in reheat', D.mfOld, i),
      _msInDef('Supply air now', D.satOld, i),
      _msInDef('Supply air at the top of the reset', D.satMax, i),
      _msIn('Typical year hours in the occupied window', _msSumBins(B.bins, function (t, h) { return h; }), 'h', 'default', 'BAS weather bins of the proposal city; occupied window of the BAS schedules'),
      _msHeatFuelInput(B),
      _msIn('Cooling COP', B.cop, '', 'default', 'the proposal cooling plant efficiency'),
    ];
    var steps = [
      _msStep('Reheat saved', '1.08 x reheat cfm x dSAT x hours, summed over the bins', reheatBtu),
      _msStep('Reheat energy saved', _msHeatUse(B) === 'heatGas' ? 'Btu / (Btu per therm x AFUE)' : 'Btu / Btu per kWh', heat),
      _msStep('Cooling coil load saved', '1.08 x cfm x (max(0, t - SATold) - max(0, t - SATnew)) x hours', coilBtu),
      _msStep('Cooling energy saved', 'Btu / (COP x Btu per kWh)', cool),
      _msStep('Fan energy', '0: zones are at minimum airflow below 70 F outdoor, so no airflow penalty and no fan saving', 0),
    ];
    var by = { cool: cool };
    by[hu] = heat;
    var base = { cool: B.base.cool };
    base[hu] = B.base[hu];
    return _msCase(by, base, 0, inputs, steps);
  });
}

/* msEconomizer(B, qty): economizer (ahu_economizer). Free cooling, bin method. Now: the unit mixes the minimum outdoor air (no free cooling).
   With an economizer the unit uses outdoor air up to the high limit (ASHRAE 90.1 section 6.5.1). In each bin from the balance point to the
   high limit (outdoor t, hours h; the building needs cooling above the balance point):
     mixed air at minimum outdoor air  Tmix = Treturn - f_oa x (Treturn - t),   f_oa = outdoor air cfm / supply cfm
     coil load removed = 1.08 x average cfm x ( (Tmix - SAT) - max(0, t - SAT) ) x h     (SAT = supply air now)
     kWh = coil load / (COP x Btu per kWh) */
function msEconomizer(B, qty) {
  if (!B.bins || !(B.sqft > 0)) return null;
  var D = _msDefaults();
  var n = Math.max(1, B.counts.ahu);
  var share = qty > 0 ? Math.min(1, qty / n) : 1;
  return _msEach(function (i) {
    var sat = _msPick(D.satOld, i);
    var tRa = _msPick(D.returnTemp, i);
    var limit = _msPick(D.ecoLimit, i);
    var balance = B.heatBalanceF + _msPick(D.balanceDelta, i);
    var fOa = (MS_OA_CFM_PER_SQFT * B.sqft) / _msDesignCfm(B);
    var cfmAvg = _msDesignCfm(B) * share * _msPick(D.avgFlow, i);
    var coilBtu = _msSumBins(B.bins, function (t, h) {
      if (t < balance || t >= limit) return 0;
      var tMix = tRa - fOa * (tRa - t);
      return MS_SENSIBLE_FACTOR * cfmAvg * Math.max(0, tMix - sat - Math.max(0, t - sat)) * h;
    });
    var cool = coilBtu / (B.cop * BTU_PER_KWH);
    var inputs = [
      _msIn('Floor area', B.sqft, 'ft2', 'bill', 'the building floor area (utility data)'),
      _msIn('Design supply airflow', _msDesignCfm(B) * share, 'cfm', 'default', 'floor area / 300 ft2 per ton x 400 cfm per ton (BAS Savings Calc cooling rule)'),
      _msInDef('Average airflow', D.avgFlow, i),
      _msIn('Outdoor air share of the supply air', fOa, 'share', 'default', 'outdoor air 0.1 cfm per ft2 (BAS Savings Calc rule) / design supply airflow'),
      _msInDef('Return air temperature', D.returnTemp, i),
      _msInDef('Supply air now', D.satOld, i),
      _msInDef('Economizer high limit', D.ecoLimit, i),
      _msIn('Cooling starts at outdoor temperature', balance, 'F', 'default', _msPick(D.balanceDelta, i) === 0 ? 'the proposal building balance point' : 'the proposal building balance point, shifted for the case'),
      _msIn('Cooling COP', B.cop, '', 'default', 'the proposal cooling plant efficiency'),
    ];
    var steps = [
      _msStep('Coil load removed', '1.08 x cfm x ((Tmix - SAT) - max(0, t - SAT)) x hours, bins from the balance point to the high limit', coilBtu),
      _msStep('Cooling energy saved', 'Btu / (COP x Btu per kWh)', cool),
    ];
    return _msCase({ cool: cool }, { cool: B.base.cool }, 0, inputs, steps);
  });
}

/* msDemandCtrl(B, qty): air handler CO2 demand controlled ventilation (demandCtrl) = dcvEnergySaved (app/ecm-calculators.js).
   Outside air at design = floor area x 0.1 cfm per ft2 (the BAS Savings Calc rule) x the share of the air handlers the item covers.
   The occupied window degree hours come from the typical year (heat below the balance point, cool above the cooling target). */
function msDemandCtrl(B, qty) {
  if (!B.degreeHours || !(B.sqft > 0)) return null;
  var D = _msDefaults();
  var n = Math.max(1, B.counts.ahu);
  var share = qty > 0 ? Math.min(1, qty / n) : 1;
  var hu = _msHeatUse(B);
  return _msEach(function (i) {
    var oa = MS_OA_CFM_PER_SQFT * B.sqft * share;
    var r = dcvEnergySaved({
      oa_cfm_design: oa,
      per_person_frac: _msPick(D.dcvPerPerson, i),
      avg_occ_frac: _msPick(D.dcvOcc, i),
      heat_degree_hours: B.degreeHours.heat,
      cool_degree_hours: B.degreeHours.cool,
      afue: B.afue,
      cop: B.cop,
    });
    var heatBtu = r.therms_saved * BTU_PER_THERM * B.afue;
    var heat = _msHeatQty(B, heatBtu);
    var inputs = [
      _msIn('Outdoor air at design', oa, 'cfm', 'default', 'floor area x 0.1 cfm per ft2 (BAS Savings Calc rule) x air handlers covered / air handlers'),
      _msInDef('Per-person share of the outdoor air', D.dcvPerPerson, i),
      _msInDef('Average occupancy', D.dcvOcc, i),
      _msIn('Heating degree hours of the occupied window', B.degreeHours.heat, 'F h', 'default', 'typical year, heat below the balance point to the heating target'),
      _msIn('Cooling degree hours of the occupied window', B.degreeHours.cool, 'F h', 'default', 'typical year, cool above the cooling target'),
      _msHeatFuelInput(B),
      _msIn('Cooling COP', B.cop, '', 'default', 'the proposal cooling plant efficiency'),
    ];
    var steps = [
      _msStep('Outdoor air saved', 'design outdoor air x per-person share x (1 - occupancy)', r.cfm_saved),
      _msStep('Heating energy saved', '1.08 x cfm saved x heat degree hours / (Btu per therm x AFUE)', heat),
      _msStep('Cooling energy saved', '1.08 x cfm saved x cool degree hours / (COP x Btu per kWh)', r.cool_kwh_saved),
    ];
    var by = { cool: r.cool_kwh_saved };
    by[hu] = heat;
    var base = { cool: B.base.cool };
    base[hu] = B.base[hu];
    return _msCase(by, base, 0, inputs, steps);
  });
}

/* msTerminalMinFlow(B, qty): terminal unit minimum airflow (terminalStandard), the minimum airflow part of the vav_reheat template.
   Box design airflow = supply cfm of the building / terminal units (no box cfm is in the Equipment Matrix). Heating bins (outdoor below the
   balance point, occupied window): the boxes sit at their minimum airflow.
     delta cfm = boxes covered x box cfm x (old minimum - new minimum) x share of the boxes in reheat (the others are above their minimum)
     reheat    = 1.08 x delta cfm x reheat rise x hours / (Btu per therm x AFUE)   (or / Btu per kWh for electric reheat)
     fan       = vavMinFlowFanSaved: fan kW x (power fraction at the old minimum - at the new minimum) x hours, fan kW of the building units x
                 boxes covered / boxes x share in reheat
   Cooling: 0. The air the boxes stop delivering at minimum airflow is cooled only in free-cooling hours below the balance point, so no
   mechanical cooling energy is credited. */
function msTerminalMinFlow(B, qty) {
  if (!B.bins || !(B.sqft > 0)) return null;
  var D = _msDefaults();
  var design = _msDesignCfm(B);
  // The item quantity is the terminal units. The Equipment Matrix count is used when it lists terminals; a Matrix with none is missing input,
  // so the stated default box airflow stands in (never a gap).
  var matrixBoxes = B.counts.box > 0;
  var boxes = matrixBoxes ? B.counts.box : Math.max(1, design / MS_DEFAULT_BOX_CFM);
  var covered = qty > 0 ? Math.min(qty, boxes) : boxes;
  var hu = _msHeatUse(B);
  return _msEach(function (i) {
    var hours = _msSumBins(B.bins, function (t, h) {
      return t < B.heatBalanceF ? h : 0;
    });
    var boxCfm = matrixBoxes ? design / boxes : MS_DEFAULT_BOX_CFM;
    var mOld = _msPick(D.mfOld, i);
    var mNew = _msPick(D.mfNew, i);
    var inReheat = _msPick(D.reheatShare, i); // share of the boxes at their minimum airflow in these hours
    var dCfm = covered * boxCfm * (mOld - mNew) * inReheat;
    var rise = _msPick(D.reheatRise, i);
    var heatBtu = MS_SENSIBLE_FACTOR * dCfm * rise * hours;
    var heat = _msHeatQty(B, heatBtu);
    var fanKw = B.fanUnits.reduce(function (s, u) { return s + u.kw * u.baselineFraction; }, 0) * (covered * boxCfm / design) * inReheat;
    var fan = vavMinFlowFanSaved({ fan_kw_design: fanKw, min_flow_old: mOld, min_flow_new: mNew, hours: hours });
    var inputs = [
      _msIn('Floor area', B.sqft, 'ft2', 'bill', 'the building floor area (utility data)'),
      _msIn('Terminal units in the building', boxes, 'units', matrixBoxes ? 'matrix' : 'default', matrixBoxes ? 'Equipment Matrix terminal unit rows' : 'building supply cfm / ' + MS_DEFAULT_BOX_CFM + ' cfm per terminal unit (the Matrix lists none)'),
      _msIn('Design airflow of one terminal unit', boxCfm, 'cfm', 'default', 'building supply cfm (floor area / 300 x 400 cfm per ton) / terminal units: the matrix holds no box cfm'),
      _msInDef('Minimum airflow now', D.mfOld, i),
      _msInDef('Minimum airflow after', D.mfNew, i),
      _msInDef('Share of the boxes in reheat at minimum airflow', D.reheatShare, i),
      _msInDef('Reheat temperature rise', D.reheatRise, i),
      _msIn('Terminal units covered by the item', covered, 'units', 'matrix', 'the item quantity'),
      _msIn('Hours at minimum airflow', hours, 'h', 'default', 'typical year hours below the balance point of ' + B.heatBalanceF + ' F in the occupied window'),
      _msIn('Fan kW of the units that serve the boxes', fanKw, 'kW', B.fanUnits.length ? _msWorstLevel(B.fanUnits, 'kwLevel') : 'default', 'fan model, share of the covered boxes'),
      _msHeatFuelInput(B),
    ];
    var steps = [
      _msStep('Reheat airflow no longer delivered', 'boxes x box cfm x (old minimum - new minimum) x share in reheat', dCfm),
      _msStep('Reheat saved', '1.08 x delta cfm x rise x hours', heatBtu),
      _msStep('Reheat energy saved', hu === 'heatGas' ? 'Btu / (Btu per therm x AFUE)' : 'Btu / Btu per kWh', heat),
      _msStep('Fan energy saved', 'fan kW x (fan power fraction at old minimum - at new minimum) x hours', fan),
      _msStep('Cooling energy', '0: the air is cooled only in free-cooling hours, no mechanical cooling credited', 0),
    ];
    var by = { fan: fan };
    by[hu] = heat;
    var base = { fan: _msFanBase(B, _msPick(D.fanHours, i)).kwh };
    base[hu] = B.base[hu];
    return _msCase(by, base, 0, inputs, steps);
  });
}

/* msPumpDpReset(B, plant): hot water (plant 'hw': hwp_pump_dp_reset, hwDpOverride) or chilled water (plant 'chw': chwp_pump_dp_reset,
   chwDpOverride) pump differential pressure reset = pumpVfdEnergySaved (app/ecm-calculators.js) at speed = sqrt(1 - cut) (pressure varies as
   speed squared). gpm = floor area x 30 Btu/h / (500 x 20 F) (the BAS Savings Calc heating capacity rule). Head, pump and motor efficiency are
   the pump_vfd template defaults. Hours = typical year occupied hours below (hot water) or above (chilled water) the balance point. */
function msPumpDpReset(B, plant) {
  if (!B.bins || !(B.sqft > 0)) return null;
  var D = _msDefaults();
  var use = plant === 'hw' ? 'pumpHw' : 'pumpChw';
  return _msEach(function (i) {
    var hours = _msSumBins(B.bins, function (t, h) {
      return plant === 'hw' ? (t < B.heatBalanceF ? h : 0) : t >= B.heatBalanceF ? h : 0;
    });
    var dt = _msPick(D.waterDt, i);
    var gpm = (B.sqft * MS_HEAT_BTUH_PER_SQFT) / (MS_WATER_BTUH_PER_GPM_F * dt);
    var cut = _msPick(D.pumpCut, i);
    var speed = pressureCutSpeedRatio(cut);
    var r = pumpVfdEnergySaved({
      gpm: gpm,
      head_ft: _msPick(D.pumpHead, i),
      pump_eff: _msPick(D.pumpEff, i),
      motor_eff: _msPick(D.motorEff, i),
      avg_speed_ratio: speed,
      op_hours: hours,
    });
    var inputs = [
      _msIn('Floor area', B.sqft, 'ft2', 'bill', 'the building floor area (utility data)'),
      _msIn('Pump flow', gpm, 'gpm', 'default', 'floor area x 30 Btu/h / (500 x water temperature difference): the BAS Savings Calc capacity rule; the matrix holds no pump gpm'),
      _msInDef('Water temperature difference', D.waterDt, i),
      _msInDef('System head', D.pumpHead, i),
      _msInDef('Pump efficiency', D.pumpEff, i),
      _msInDef('Motor efficiency', D.motorEff, i),
      _msInDef('Differential pressure cut', D.pumpCut, i),
      _msIn('Pump run hours', hours, 'h', 'default', 'typical year occupied hours ' + (plant === 'hw' ? 'below' : 'at or above') + ' the balance point of ' + B.heatBalanceF + ' F'),
    ];
    var steps = [
      _msStep('Pump power at design', 'gpm x head / (pump constant x pump eff) x kW per hp / motor eff', r.kw_design),
      _msStep('Speed after the reset', 'sqrt(1 - cut)', speed),
      _msStep('Energy saved', 'kW x (1 - speed^3) x hours', r.savings_kwh),
    ];
    var by = {};
    by[use] = r.savings_kwh;
    var base = {};
    base[use] = r.kwh_existing;
    return _msCase(by, base, r.kw_design * (1 - r.kwh_new / r.kwh_existing), inputs, steps);
  });
}

/* msHotWaterReset(B): hot water supply temperature reset released (hwOverride). No formula is claimed: the saving of a lower supply water
   temperature depends on the boiler type (a condensing boiler gains efficiency, a non-condensing boiler saves only a little distribution
   and standby loss) and the site holds no boiler make, model, type or efficiency. A judged share would not be an engineering projection. */
function msHotWaterReset() {
  return { none: true, reason: 'No boiler type, make, model or efficiency is on file: the efficiency gain of a lower supply water temperature cannot be calculated, so no saving is claimed.' };
}

/* msLightingOccupancy(B, qty): interior lighting occupancy sensors = ECM_TEMPLATES.occupancy_sensors (app/ecm-calculators.js). The item quantity
   is the number of spaces. Fixtures, watts, hours and control factor are the template defaults; the space type (vacancy share) varies by case. */
function msLightingOccupancy(B, qty) {
  var D = _msDefaults();
  var spaces = Math.max(1, qty || 0);
  var t = ECM_TEMPLATES.occupancy_sensors;
  return _msEach(function (i) {
    var inp = {
      space_type: _msPick(D.occSpace, i),
      fixture_watts: _msPick(D.occWatts, i),
      fixtures_per_space: _msPick(D.occFixtures, i),
      qty_spaces: spaces,
      scheduled_hours: _msPick(D.occHours, i),
      control_factor: _msPick(D.occFactor, i),
    };
    var r = t.calculate(inp);
    var inputs = [
      _msInDef('Space type', D.occSpace, i),
      _msIn('Vacancy share', r.vacancy_pct_used / 100, 'share', 'default', 'ECM Calculator occupancy_sensors vacancy table (utility TRM midpoint of the space type)'),
      _msInDef('Fixtures per space', D.occFixtures, i),
      _msInDef('Watts per fixture', D.occWatts, i),
      _msInDef('Scheduled hours', D.occHours, i),
      _msInDef('Control effectiveness', D.occFactor, i),
      _msIn('Spaces', spaces, 'spaces', 'matrix', 'the item quantity'),
    ];
    var steps = [
      _msStep('Controlled load', 'watts x fixtures x spaces / 1,000', r.total_kw),
      _msStep('Energy saved', 'controlled kW x scheduled hours x vacancy x control factor', r.savings_kwh),
    ];
    return _msCase({ lightInt: r.savings_kwh }, { lightInt: r.total_kw * inp.scheduled_hours }, r.demand_savings_kw, inputs, steps);
  });
}

/* msLightingPhotocell(B, qty): exterior lighting photocell (lightingPhotocell). A circuit of exterior lights on a clock stays on for some
   daylight hours. A photocell turns it off. kWh saved = watts x photocells / 1,000 x daylight hours the clock leaves the lights on.
   The base is the circuit on all night (8,760 - 4,380 h) plus those daylight hours. */
function msLightingPhotocell(B, qty) {
  var D = _msDefaults();
  var n = Math.max(1, qty || 0);
  return _msEach(function (i) {
    var w = _msPick(D.photoWatts, i);
    var h = _msPick(D.photoHours, i);
    var kw = (w * n) / 1000;
    var inputs = [_msInDef('Watts of one photocell circuit', D.photoWatts, i), _msInDef('Daylight hours the lights stay on', D.photoHours, i), _msIn('Photocells', n, 'circuits', 'matrix', 'the item quantity')];
    var steps = [_msStep('Energy saved', 'watts x photocells / 1,000 x daylight hours left on', kw * h)];
    return _msCase({ lightExt: kw * h }, { lightExt: kw * (8760 - MS_DAYLIGHT_HOURS + h) }, 0, inputs, steps);
  });
}

// The owner of each key the proposal claims. releases = the sequence an override item frees (counted once with it in the same set).
// qty: the item quantity (null for an override: it covers the whole building).
var MS_OWNERS = {
  ahu_dsp_reset: { fn: function (B, q) { return msDspReset(B, q); } },
  spOverride: { fn: function (B) { return msDspReset(B, null); }, releases: 'ahu_dsp_reset' },
  ahu_sat_reset: { fn: function (B, q) { return msSatReset(B, q); } },
  satOverride: { fn: function (B) { return msSatReset(B, null); }, releases: 'ahu_sat_reset' },
  ahu_economizer: { fn: function (B, q) { return msEconomizer(B, q); } },
  demandCtrl: { fn: function (B, q) { return msDemandCtrl(B, q); } },
  terminalStandard: { fn: function (B, q) { return msTerminalMinFlow(B, q); } },
  hwp_pump_dp_reset: { fn: function (B) { return msPumpDpReset(B, 'hw'); } },
  hwDpOverride: { fn: function (B) { return msPumpDpReset(B, 'hw'); }, releases: 'hwp_pump_dp_reset' },
  chwp_pump_dp_reset: { fn: function (B) { return msPumpDpReset(B, 'chw'); } },
  chwDpOverride: { fn: function (B) { return msPumpDpReset(B, 'chw'); }, releases: 'chwp_pump_dp_reset' },
  hwOverride: { fn: function (B) { return msHotWaterReset(B); }, releases: 'hwp_supply_reset' },
  lightingPhotocell: { fn: function (B, q) { return msLightingPhotocell(B, q); } },
  lightingOccupancy: { fn: function (B, q) { return msLightingOccupancy(B, q); } },
};
function msClaims(key) {
  return Object.prototype.hasOwnProperty.call(MS_OWNERS, key);
}
function msReleases(key) {
  return msClaims(key) ? MS_OWNERS[key].releases || null : null;
}
// The estimate of one item: { low, likely, high } | { none, reason } | null (no data). qty = the item quantity.
function msEstimate(key, B, qty) {
  var e = msClaims(key) ? MS_OWNERS[key].fn(B, qty) : null;
  if (e && !e.none && B.window) {
    MS_CASES.forEach(function (k) {
      if (e[k].inputs.length) e[k].inputs.push(_msIn('Occupied hours of the day', B.window.start + ' to ' + B.window.stop + ' h', '', B.window.level, B.window.source));
    });
  }
  return e;
}
