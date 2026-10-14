// computations/fan-savings.js - the ONE place that sizes a supply fan and counts its run hours (Phase 6, 2026-10-14).
//
// Chain (Matt): Utility Data baseline -> HVAC Load Estimate -> getEndUse(.., 'fans') -> one fan savings template ->
// baseline-period rates. This file holds the fan rules both ends share:
//   fanReadUnits      reads the building's supply-fan rows from the Equipment Matrix and the BAS Trends daily summaries
//   fanUnitModel      one unit: fan kW, run hours, speed drive, speed profile, two-speed split, each with its data level
//   fanModelUnits     every unit of a building: fanUnitModel, plus a stated Default estimate for a unit with no amps, airflow
//                     or horsepower (never a silent 0)
//   fanSavingsForUnits the three savings measures of the template, per unit: COUNTED (drive status known) and POSSIBLE (not counted)
//   fanResetSavingsFraction, fanKwFromHp, fanDefaultRunHours  the fan rules the BAS report calls (app/bas-trends.js)
// getEndUse (computations/end-use.js) adds the units up into the fan end use. The template (app/ecm-calculators.js)
// calls getEndUse and fanSavingsForUnits. tools/gate-single-fan-model.js fails when another file keeps its own fan kW
// or run-hours rule. Power and speed rules are NOT here: they are in computations/physics.js (fanKwFromCfm,
// motorKwFromAmps, hpToKw, fanPowerFraction (affinity law or the ASHRAE 90.1 Appendix G VAV curve), fanMeanPowerFraction,
// ductStaticResetPowerSavings).
// A SAVINGS NUMBER IS COUNTED only when the data under it is known. A drive or a two-speed replacement is counted only when the
// drive status of the unit is known "no drive" (Has variable speed: No, or a trend that shows one speed). A unit of unknown status,
// and a unit sized by the national average, show their potential on a separate "possible" line and stay out of the total.
//
// DATA LEVELS. Every number carries one: 'trend' (measured in a BAS Trends file), 'matrix' (a value in the
// Equipment Matrix: a point read or an asset field) or 'default' (a stated assumption, written in the constants below).
// A better level replaces a worse one on its own when the data arrives: add the fan amps, add the Hi/Lo enable
// trend, fill the voltage and phase, and the same unit moves from default to matrix to trend.
// This is a projected estimate from the data on hand. It is not measured and verified savings.

// ---- stated defaults (each is shown to the person with the data level "default") ----
var FAN_SUPPLY_CATEGORIES = ['ahu', 'rtu', 'doas', 'mau', 'fan']; // Equipment Matrix equipment types that have a fan (a row also needs a fan point: _fanRowHasFanPoint)
var FAN_HP_CATEGORIES = ['ahu', 'doas', 'mau', 'fan']; // the Horsepower/Tons column is read as HP here (an RTU is sized in tons)
var FAN_DEFAULT_ANNUAL_HOURS = 3640; // hours per year when nothing says how long the fan runs (commercial-building median, 70 h a week)
var FAN_CONTINUOUS_HOURS = 8760; // hours per year of a fan that runs all the time
var FAN_DEFAULT_VOLTS = 208; // line voltage when the matrix has amps and no voltage (the low end of common supply voltages)
var FAN_DEFAULT_PHASE = 3; // phase when the matrix has amps and no phase
var FAN_HP_MOTOR_EFF = 0.9; // motor efficiency for a nameplate HP
var FAN_HP_LOAD_FACTOR = 0.8; // share of nameplate HP the fan draws
// Default saving of adding a drive to a constant-speed fan when no fan speed trend exists: a published range, counted at its mid.
// Source: "25-45% reduction compared to constant-volume belt-drive systems": ASHRAE Handbook HVAC Systems and Equipment (fan chapter);
// PNNL "Energy Savings Potential of Plug Fans in Commercial HVAC Systems"; ENERGY STAR fan guidance (CSC research file missing-ecm-research-2026-05-16).
var FAN_VFD_SAVINGS_RANGE = { low: 0.25, mid: 0.35, high: 0.45 };
var FAN_VFD_SAVINGS_LABEL = 'Default: typical savings range for adding variable speed to a constant-volume fan, 25–45% (ASHRAE Handbook fan chapter; PNNL plug fan study)';
var FAN_TWO_SPEED_RATIO = 0.58; // Low speed as a fraction of High (4/6 pole common case; read the motor tag)
var FAN_TWO_SPEED_DEFAULT_LOW_SHARE = 0.55; // share of run hours on Low when no Hi/Lo enable trend exists
var FAN_RESET_DEFAULT_PRESSURE_CUT = 0.2; // duct static pressure cut a reset reaches (a 20 percent cut saves 25.6 percent of fan power: fan law with the fixed-loss share)
var FAN_RESET_DEFAULT_PASS = 0.7; // share of drive-equipped fans a reset works on when no setpoint trend exists
var FAN_SETPOINT_FLAT_INWG = 0.05; // inches w.g.: a duct static setpoint that moves less than this over the trend is flat (a reset is missing)
var FAN_TWO_SPEED_VFD_STEPS = 8; // steps across Low to High when a drive replaces the two-speed motor
var FAN_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // a fan runs all year: its month profile is days in month
var FAN_DAYS_PER_YEAR = 365;

var FAN_LEVEL_LABEL = { trend: 'Measured trend', matrix: 'Equipment Matrix value', default: 'Default' };

function _fanNum(v) {
  if (v == null || v === '') return null;
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// true / false / null (not known) for a status, enable or schedule point value.
function _fanOn(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0.5;
  var s = String(v).trim();
  if (/^(on|active|run|running|true|yes|enabled|occupied|occ)$/i.test(s)) return true;
  if (/^(off|inactive|stop|stopped|false|no|disabled|unoccupied|unocc)$/i.test(s)) return false;
  var n = parseFloat(s);
  return isFinite(n) ? n > 0.5 : null;
}

// 'yes' / 'no' / null (unknown or blank) for the unit field "Has variable speed"
function _fanYesNo(v) {
  var s = String(v == null ? '' : v)
    .trim()
    .toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true') return 'yes';
  if (s === 'no' || s === 'n' || s === 'false') return 'no';
  return null;
}

function _fanPhase(v) {
  if (v == null || v === '') return null;
  var s = String(v);
  if (/3|three/i.test(s)) return 3;
  if (/1|single/i.test(s)) return 1;
  return null;
}

// Part-load options for the fan model: a variable-flow fan with a drive follows the selected curve (default FAN_DEFAULT_PART_LOAD_CURVE).
function _fanPowerOpts(curve) {
  return { fixedShare: FAN_FIXED_POWER_SHARE, curve: curve || FAN_DEFAULT_PART_LOAD_CURVE };
}
// The affinity law with the fixed-loss share: a two-speed motor at Low speed and a duct static pressure reset follow it (not a VAV flow curve).
function _fanAffinityOpts() {
  return { fixedShare: FAN_FIXED_POWER_SHARE };
}

/** Fan power saved by a duct static pressure reset, as a fraction of fan power (the one answer; the BAS report calls it too). */
function fanResetSavingsFraction(pressureCut) {
  return ductStaticResetPowerSavings(pressureCut, _fanAffinityOpts());
}

/** Fan input kW from a nameplate HP: motor efficiency and the share of nameplate the fan draws (the one HP rule). */
function fanKwFromHp(hp, motorEff) {
  return hpToKw(hp, motorEff == null ? FAN_HP_MOTOR_EFF : motorEff) * FAN_HP_LOAD_FACTOR;
}

/** Run hours per year of a fan with no run-hours data (the stated default). */
function fanDefaultRunHours() {
  return FAN_DEFAULT_ANNUAL_HOURS;
}

function _fanNormTag(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Sum the BAS Trends daily summaries of one unit into the fan facts a savings estimate needs.
 * Reads the fields btFanPointExtras and btComputeOneDaySummary (app/bas-trends.js) write: fanstatus.runtimeHours,
 * fanhienable/fanloenable.runtimeHours, fanamps.runtimeHours + runAvg, fanspeed.binHours + binSpeed, staticpsp.min/max.
 * @param {Object} days - equipment.days of en_bas_<projId>: { 'YYYY-MM-DD': summary }
 * @returns {{days:number, runDays:number, runHoursPerDay:number|null, runSource:string|null, hiHours:number, loHours:number,
 *   lowShare:number|null, runAmps:number|null, speed:{bins:Array,varies:boolean}|null,
 *   setpoint:{min:number,max:number,spread:number}|null}|null} null when there are no days
 */
function fanTrendSummary(days) {
  var keys = days ? Object.keys(days) : [];
  if (!keys.length) return null;
  var a = {
    stDays: 0,
    stHrs: 0,
    enDays: 0,
    enHrs: 0,
    hi: 0,
    lo: 0,
    ampDays: 0,
    ampHrs: 0,
    ampW: 0,
    spDays: 0,
    spHrs: 0,
    binH: [0, 0, 0, 0],
    binW: [0, 0, 0, 0],
    spMin: null,
    spMax: null,
  };
  keys.forEach(function (k) {
    var d = days[k] || {};
    if (d.fanstatus && d.fanstatus.runtimeHours != null) {
      a.stDays++;
      a.stHrs += d.fanstatus.runtimeHours;
    }
    var hi = d.fanhienable && d.fanhienable.runtimeHours != null ? d.fanhienable.runtimeHours : null;
    var lo = d.fanloenable && d.fanloenable.runtimeHours != null ? d.fanloenable.runtimeHours : null;
    if (hi != null || lo != null) {
      a.enDays++;
      a.hi += hi || 0;
      a.lo += lo || 0;
      a.enHrs += (hi || 0) + (lo || 0);
    }
    if (d.fanamps && d.fanamps.runtimeHours != null) {
      a.ampDays++;
      a.ampHrs += d.fanamps.runtimeHours;
      a.ampW += (d.fanamps.runAvg || 0) * d.fanamps.runtimeHours;
    }
    if (d.fanspeed && d.fanspeed.binHours) {
      a.spDays++;
      for (var i = 0; i < 4; i++) {
        var h = d.fanspeed.binHours[i] || 0;
        a.binH[i] += h;
        a.binW[i] += h * (d.fanspeed.binSpeed && d.fanspeed.binSpeed[i] != null ? d.fanspeed.binSpeed[i] : 0);
        a.spHrs += h;
      }
    }
    if (d.staticpsp && d.staticpsp.min != null && d.staticpsp.max != null) {
      a.spMin = a.spMin == null ? d.staticpsp.min : Math.min(a.spMin, d.staticpsp.min);
      a.spMax = a.spMax == null ? d.staticpsp.max : Math.max(a.spMax, d.staticpsp.max);
    }
  });
  var run = null;
  if (a.stDays) run = { src: 'fan status', days: a.stDays, hrs: a.stHrs };
  else if (a.enDays) run = { src: 'fan enable', days: a.enDays, hrs: a.enHrs };
  else if (a.ampDays) run = { src: 'fan amps', days: a.ampDays, hrs: a.ampHrs };
  else if (a.spDays) run = { src: 'fan speed', days: a.spDays, hrs: a.spHrs };
  var bins = [];
  var big = 0;
  for (var b = 0; b < 4; b++) {
    if (a.binH[b] > 0) bins.push({ speed: a.binW[b] / a.binH[b], share: a.binH[b] });
    if (a.spHrs > 0 && a.binH[b] / a.spHrs >= 0.05) big++;
  }
  return {
    days: keys.length,
    runDays: run ? run.days : 0,
    runHoursPerDay: run ? run.hrs / run.days : null,
    runSource: run ? run.src : null,
    hiHours: a.hi,
    loHours: a.lo,
    lowShare: a.hi + a.lo > 0 && a.enDays ? a.lo / (a.hi + a.lo) : null,
    runAmps: a.ampHrs > 0 ? a.ampW / a.ampHrs : null,
    speed: bins.length ? { bins: bins, varies: big >= 2 } : null,
    setpoint: a.spMin != null ? { min: a.spMin, max: a.spMax, spread: a.spMax - a.spMin } : null,
  };
}

// the trend summary of every unit in a building, by normalized equipment tag
function _fanTrendByTag(projId, bldgId) {
  var out = {};
  if (typeof btGetData !== 'function') return out;
  var data = btGetData(projId);
  var b = data && data.buildings ? data.buildings[bldgId] : null;
  if (!b || !b.equipment) return out;
  Object.keys(b.equipment).forEach(function (tag) {
    var s = fanTrendSummary(b.equipment[tag].days);
    if (s) out[_fanNormTag(tag)] = s;
  });
  return out;
}

// Hi/Lo enable point names in the matrix row (a two-speed fan), from the raw point names.
function _fanRowHasHiLo(row) {
  var names = Object.keys(row.pointsRaw && !Array.isArray(row.pointsRaw) ? row.pointsRaw : row.points || {});
  var hi = false;
  var lo = false;
  names.forEach(function (n) {
    if (/fan\s*(high|hi)\s*(speed\s*)?enable/i.test(n)) hi = true;
    if (/fan\s*(low|lo)\s*(speed\s*)?enable/i.test(n)) lo = true;
  });
  return hi && lo;
}

// A real fan row has a fan point: a supply fan status, speed, amps or airflow point, a High/Low enable pair, or any point named "fan".
// A duct, damper, water detection or zone sensor row of an AHU has none of them and is not a fan.
function _fanRowHasFanPoint(row, pts) {
  if (['supplyFanStatus', 'supplyFanSpeed', 'supplyFanAmps', 'supplyFanCFM'].some(function (k) { return pts[k] !== undefined; })) return true;
  if (_fanRowHasHiLo(row)) return true;
  var names = Object.keys(row.pointsRaw && !Array.isArray(row.pointsRaw) ? row.pointsRaw : row.points || {});
  return names.some(function (n) {
    return /\bfan\b/i.test(n);
  });
}

/**
 * The first point name of a unit that shows its supply fan has a variable-speed drive (the one drive-name rule), or null.
 * A name shows a drive when it holds VFD, VSD, drive, inverter, Hz, frequency or speed. Not a drive: a High/Low speed enable or status
 * (a two-speed motor), wind or air speed, a diagnostic message, and a point of another fan or machine (exhaust, return, relief,
 * condenser, compressor, pump, energy recovery wheel).
 * @param {string[]} names - point names of one Equipment Matrix row
 * @param {string} [equipName] - the equipment name; a VRF or condenser unit has no supply fan drive
 * @returns {string|null}
 */
function fanDrivePointName(names, equipName) {
  if (/\b(vrf|vrv|condenser|condensing)\b/i.test(String(equipName || ''))) return null;
  // a camelCase key (supplyFanSpeed) or an underscore key (auto_sf_vfd) is read as words
  var drive = /\b(vfd|vsd|drive|inverter|hz|frequency|speed)\b/i;
  var notDrive = /\b(wind|air\s*speed|exhaust|return|relief|condenser|compressors?|comp|pump|chiller|boiler|tower|wheel|diagnostic)\b|\b(high|hi|low|lo)\s*(fan\s*)?speed\b|\bspeed\s*(high|hi|low|lo)\b|\bconstant\s*speed\b|\bspeed\s*enable\b|\bbox\s*drive\b/i;
  for (var i = 0; i < names.length; i++) {
    var words = String(names[i]).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    // an inverter with no fan word is a compressor inverter
    if (/\binverter\b/i.test(words) && !/\bfan\b/i.test(words)) continue;
    if (drive.test(words) && !notDrive.test(words)) return names[i];
  }
  return null;
}

/**
 * The supply-fan rows of one building, as raw facts (no math). Equipment Matrix rows of the fan equipment types (AHU, RTU, DOAS,
 * MAU, fan) that have a fan point, joined to the BAS Trends equipment with the same tag (building + equipment name).
 * @returns {{units:Array<Object>, note:string}}
 */
function fanReadUnits(projId, bldgId) {
  var out = { units: [], note: '' };
  if (typeof emLoadMatrix !== 'function' || typeof emGetNormalizedPoints !== 'function') {
    out.note = 'The Equipment Matrix is not loaded';
    return out;
  }
  var b = bldgId && typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
  if (!b) {
    out.note = 'No building chosen';
    return out;
  }
  var data = emLoadMatrix(projId);
  if (!data || !data.rows || !data.rows.length) {
    out.note = 'No Equipment Matrix rows for this project';
    return out;
  }
  var edits = data.edits || {};
  var wantName = _emNormBldgNameForJoin(b.name);
  var trends = _fanTrendByTag(projId, bldgId);
  var hasWin = typeof window !== 'undefined';
  var prevPid = hasWin ? window._emActivePid : undefined;
  if (hasWin) window._emActivePid = String(projId);
  try {
    data.rows.forEach(function (row) {
      if (FAN_SUPPLY_CATEGORIES.indexOf(row.category) < 0) return;
      if (_emNormBldgNameForJoin(row.building || '') !== wantName) return;
      var pts = emGetNormalizedPoints(row) || {};
      if (!_fanRowHasFanPoint(row, pts)) return;
      var asset = function (key) {
        return emGetCellValByDef(row, { key: key }, edits);
      };
      var pointNames = Object.keys(row.pointsRaw && !Array.isArray(row.pointsRaw) ? row.pointsRaw : row.points || {});
      var drivePoint = fanDrivePointName(pointNames, row.equipName);
      if (!drivePoint && pts.supplyFanSpeed != null && pts.supplyFanSpeed !== '') drivePoint = 'Supply Fan Speed';
      out.units.push({
        id: String(row.id),
        name: row.equipName || '',
        category: row.category,
        cfm: _fanNum(pts.supplyFanCFM),
        ampsPoint: _fanNum(pts.supplyFanAmps),
        ampsAsset: _fanNum(asset('amps')),
        volts: _fanNum(asset('voltage')),
        phase: _fanPhase(asset('phase')),
        hp: FAN_HP_CATEGORIES.indexOf(row.category) >= 0 ? _fanNum(asset('hpTons')) : null,
        tons: FAN_HP_CATEGORIES.indexOf(row.category) >= 0 ? null : _fanNum(asset('hpTons')), // size hint only (an RTU is sized in tons)
        drivePoint: drivePoint,
        hasVfd: _fanYesNo(asset('hasVfd')),
        status: _fanOn(pts.supplyFanStatus),
        occupied: _fanOn(pts.scheduledOccupied),
        hiLoPoints: _fanRowHasHiLo(row),
        trend: trends[_fanNormTag(row.equipName)] || null,
      });
    });
  } finally {
    if (hasWin) window._emActivePid = prevPid;
  }
  if (!out.units.length)
    out.note = 'No fan rows (an AHU, RTU, DOAS or MAU with a fan point) for this building in the Equipment Matrix';
  return out;
}

/**
 * One unit's fan model from its raw facts. Pure.
 * kW:     measured amps x volts x phase (trend amps first, then the matrix amps), else cfm x W per cfm, else nameplate HP.
 * Hours:  BAS trend run hours (status, enable, amps or speed), else a fan the matrix read running while unoccupied
 *         (runs all the time), else the stated default.
 * Drive:  driveStatus 'none' (Has variable speed: no, set by the user, wins over every other evidence), 'has' (a speed trend that
 *         moves, Has variable speed: yes, or a point of the unit named like a drive: fanDrivePointName, "Drive found from point:
 *         <name>"), 'none' also when a speed trend stays in one range, else 'unknown' (nothing says).
 *         Only 'none' lets the savings template COUNT a drive or two-speed replacement.
 * Speed profile: only a speed trend that moves (fan speed bins by hours). Without it there is no profile; the drive saving then
 *         comes from the published range in fanSavingsForUnits (FAN_VFD_SAVINGS_RANGE).
 * Estimate: `est` ({kw, how, rule} or {annualKwh, how, rule}, from fanModelUnits) sizes a unit that has no amps, airflow
 *         or horsepower. The model carries `estimate` (the rule) and its power is tagged Default with the basis in kwHow.
 *         sizeBasis 'national' marks a unit sized by the national average (rule 'area'): the template counts it only when confirmed.
 * @param {Object} raw - fanReadUnits unit
 * @param {Object|null} est
 * @returns {Object} model; ok:false (with `missing`) when the unit cannot be sized
 */
function fanUnitModel(raw, est) {
  var t = raw.trend;
  var m = { id: raw.id, name: raw.name, category: raw.category, hasVfd: raw.hasVfd || null, ok: false, missing: '' };

  // ---- fan kW ----
  var ampsRun = t && t.runAmps ? { v: t.runAmps, level: 'trend', how: 'trend running amps' } : null;
  if (!ampsRun && raw.ampsPoint != null && raw.ampsPoint > 0)
    ampsRun = { v: raw.ampsPoint, level: 'matrix', how: 'matrix amps point' };
  if (!ampsRun && raw.ampsAsset != null && raw.ampsAsset > 0)
    ampsRun = { v: raw.ampsAsset, level: 'matrix', how: 'matrix amps field' };
  var ampsOk = ampsRun && raw.volts > 0 && raw.phase;
  if (ampsOk) {
    m.kw = motorKwFromAmps(ampsRun.v, raw.volts, raw.phase);
    m.kwBasis = 'operating';
    m.kwLevel = ampsRun.level;
    m.kwHow =
      ampsRun.how +
      ' x ' +
      raw.volts +
      ' V x ' +
      raw.phase +
      ' phase, power factor ' +
      MOTOR_DEFAULT_POWER_FACTOR +
      ' (default)';
  } else if (raw.cfm > 0) {
    m.kw = fanKwFromCfm(raw.cfm);
    m.kwBasis = 'full';
    m.kwLevel = 'matrix';
    m.kwHow = raw.cfm + ' cfm x ' + FAN_W_PER_CFM.mid + ' W per cfm (default)';
  } else if (raw.hp > 0) {
    m.kw = fanKwFromHp(raw.hp);
    m.kwBasis = 'full';
    m.kwLevel = 'matrix';
    m.kwHow = raw.hp + ' HP, motor efficiency ' + FAN_HP_MOTOR_EFF + ' and load ' + FAN_HP_LOAD_FACTOR + ' (default)';
  } else if (ampsRun) {
    // amps with no voltage or phase in the matrix: the stated low-end supply voltage, so a missing voltage never overstates
    var volts = raw.volts > 0 ? raw.volts : FAN_DEFAULT_VOLTS;
    var phase = raw.phase ? raw.phase : FAN_DEFAULT_PHASE;
    m.kw = motorKwFromAmps(ampsRun.v, volts, phase);
    m.kwBasis = 'operating';
    m.kwLevel = 'default';
    m.kwHow =
      ampsRun.how +
      ' x ' +
      volts +
      ' V' +
      (raw.volts > 0 ? '' : ' (assumed)') +
      ' x ' +
      phase +
      ' phase' +
      (raw.phase ? '' : ' (assumed)') +
      ', power factor ' +
      MOTOR_DEFAULT_POWER_FACTOR +
      ' (default)';
  } else if (est) {
    m.estimate = est.rule;
    m.sizeBasis = est.rule === 'area' ? 'national' : null;
    m.kw = est.kw != null ? est.kw : 1; // an annual-energy estimate gets its kW once the hours are known (below)
    m.kwBasis = 'operating';
    m.kwLevel = 'default';
    m.kwHow = est.how;
  } else {
    m.kw = null;
    m.kwBasis = null;
    m.kwLevel = null;
    m.kwHow = '';
    m.missing = 'needs amps, a supply fan airflow, or a horsepower in the Equipment Matrix';
    return m;
  }

  // ---- run hours ----
  if (t && t.runHoursPerDay != null) {
    m.hours = t.runHoursPerDay * FAN_DAYS_PER_YEAR;
    m.hoursLevel = 'trend';
    m.hoursHow =
      'trend ' + t.runSource + ', ' + t.runDays + ' day' + (t.runDays === 1 ? '' : 's') + ' of data, scaled to a year';
  } else if (raw.status === true && raw.occupied === false) {
    m.hours = FAN_CONTINUOUS_HOURS;
    m.hoursLevel = 'matrix';
    m.hoursHow = 'the matrix read shows the fan on while unoccupied: runs all the time';
  } else {
    m.hours = FAN_DEFAULT_ANNUAL_HOURS;
    m.hoursLevel = 'default';
    m.hoursHow = FAN_DEFAULT_ANNUAL_HOURS + ' h per year (no run-hours trend)';
  }

  // ---- variable-speed drive: status and where it came from ----
  var tSpeed = t && t.speed ? t.speed : null;
  if (tSpeed && tSpeed.varies) {
    m.vfd = 'yes';
    m.driveStatus = 'has';
    m.vfdLevel = 'trend';
    m.vfdHow = 'trend fan speed moves';
  } else if (raw.hasVfd) {
    m.vfd = raw.hasVfd;
    m.driveStatus = raw.hasVfd === 'yes' ? 'has' : 'none';
    m.vfdLevel = 'matrix';
    m.vfdHow = 'Has variable speed: ' + raw.hasVfd + ' (a value in the Equipment Matrix: set by a person or read from a drawing flag)';
  } else if (raw.drivePoint) {
    m.vfd = 'yes';
    m.driveStatus = 'has';
    m.vfdLevel = 'matrix';
    m.vfdHow = 'Drive found from point: ' + raw.drivePoint + ' (set Has variable speed to No to override)';
  } else if (tSpeed) {
    m.vfd = 'no';
    m.driveStatus = 'none';
    m.vfdLevel = 'trend';
    m.vfdHow = 'trend fan speed stays in one range';
  } else {
    m.vfd = null;
    m.driveStatus = 'unknown';
    m.vfdLevel = 'default';
    m.vfdHow = 'Drive status unknown: no fan speed point and Has variable speed is not set (set it to count a drive)';
  }
  // ---- speed profile: only a moving speed trend (hours by speed bin); no trend, no profile ----
  m.profile =
    tSpeed && tSpeed.varies
      ? { bins: tSpeed.bins, level: 'trend', how: 'trend fan speed by hours' }
      : { bins: null, level: 'default', how: 'no fan speed trend: no speed profile' };
  m.profileFraction = m.profile.bins ? fanMeanPowerFraction(m.profile.bins, _fanPowerOpts()) : null;

  // ---- two-speed fan ----
  var lowShare = t && t.lowShare != null ? t.lowShare : null;
  if (lowShare != null || raw.hiLoPoints) {
    m.twoSpeed = {
      ratio: FAN_TWO_SPEED_RATIO,
      lowShare: lowShare != null ? lowShare : FAN_TWO_SPEED_DEFAULT_LOW_SHARE,
      level: lowShare != null ? 'trend' : 'default',
      how:
        lowShare != null
          ? 'trend High/Low enable hours'
          : 'default ' + Math.round(FAN_TWO_SPEED_DEFAULT_LOW_SHARE * 100) + '% of hours on Low (no enable trend)',
      detectedBy: lowShare != null ? 'trend' : 'matrix',
    };
  } else {
    m.twoSpeed = null;
  }

  // ---- duct static pressure reset ----
  var sp = t && t.setpoint ? t.setpoint : null;
  if (sp) {
    var flat = sp.spread < FAN_SETPOINT_FLAT_INWG;
    m.reset = {
      pass: flat ? 1 : 0,
      level: 'trend',
      how: flat
        ? 'trend setpoint is flat (moves ' + Math.round(sp.spread * 100) / 100 + ' in. w.g.): a reset is missing'
        : 'trend setpoint already moves ' + Math.round(sp.spread * 100) / 100 + ' in. w.g.: a reset is running',
    };
  } else {
    m.reset = {
      pass: FAN_RESET_DEFAULT_PASS,
      level: 'default',
      how: 'default ' + Math.round(FAN_RESET_DEFAULT_PASS * 100) + '% of fans (no setpoint trend)',
    };
  }

  // ---- baseline energy (before any cap) ----
  // A fan with a drive that is sized at full speed (cfm, HP) or by the national average runs at its part-load power. Measured running
  // amps are already part-load power. A two-speed motor at Low follows the affinity law.
  var f = 1;
  if (m.twoSpeed)
    f = m.twoSpeed.lowShare * fanPowerFraction(m.twoSpeed.ratio, _fanAffinityOpts()) + (1 - m.twoSpeed.lowShare);
  else if (m.vfd === 'yes' && (m.kwBasis === 'full' || (est && est.annualKwh != null)) && m.profileFraction != null)
    f = m.profileFraction;
  m.baselineFraction = f;
  if (est && est.annualKwh != null) m.kw = est.annualKwh / (m.hours * f);
  m.kwh = m.kw * m.hours * f;
  m.ok = m.kw > 0 && m.hours > 0;
  return m;
}

function _fanMedian(a) {
  var s = a.slice().sort(function (x, y) {
    return x - y;
  });
  var n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function _fanRound1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Every unit of one building, modelled. A unit with amps, airflow or horsepower is sized by fanUnitModel alone. A unit
 * with none of them is NOT left at 0: it gets a stated Default estimate, the first rule that applies (v10 criteria matrix,
 * sibling rule), and the estimate refines itself when the real data arrives:
 *   (a) the median fan kW of the sized units of the same equipment type in this building
 *   (b) the median fan kW of the sized units of the same equipment type in the other buildings of the project
 *   (c) the airflow implied by the served VAV boxes: NOT available, the Equipment Matrix has no link from a box to its AHU
 *   (d) the national average ventilation share of total building electricity (fanVentilationShare, physics.js: EIA CBECS 2018
 *       Table E5; Education for a school, else All buildings) x the building's total baseline electricity, less the fans
 *       already sized, split across the units still unsized by the tons of the unit when the matrix has it (a unit without
 *       tons takes the mean of the others), else equally (kWh per sq ft is shown); needs the total baseline electricity kWh
 * The national average is a mean of fans with and without drives. The units already sized are taken out of it at their own
 * power (a fan with a drive at its part-load power, fanUnitModel baseline fraction), and a unit sized by it that has a drive
 * is held at part-load power too, so the pool is never read as all constant speed.
 * The building type decides the share (the building's own type when set; else the project type; the label says which).
 * A sibling is a unit with its own data (not an estimate). The end use caps the sum (total electricity less measured cooling and electric heating).
 * @param {string|number} projId
 * @param {string} bldgId
 * @param {{units:Array<Object>}} read - fanReadUnits result of the building
 * @param {number|null} totalAnnual - the building's total baseline electricity kWh per year, or null
 * @returns {Array<Object>} fanUnitModel results, in the order of read.units
 */
function fanModelUnits(projId, bldgId, read, totalAnnual) {
  var models = read.units.map(function (u) {
    return fanUnitModel(u, null);
  });
  var pending = [];
  models.forEach(function (m, i) {
    if (m.kw == null) pending.push(i);
  });
  if (!pending.length) return models;
  var kwOf = function (list, category) {
    return list
      .filter(function (m) {
        return m.ok && m.category === category;
      })
      .map(function (m) {
        return m.kw;
      });
  };
  var other = null; // sized models of the other buildings, read once
  var otherModels = function () {
    if (other) return other;
    other = [];
    var all = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : [];
    all.forEach(function (ob) {
      if (String(ob.id) === String(bldgId)) return;
      fanReadUnits(projId, ob.id).units.forEach(function (ru) {
        other.push(fanUnitModel(ru, null, null));
      });
    });
    return other;
  };
  var unresolved = [];
  var here = {}; // sibling kW lists by category: own-data units only, so one estimate never feeds another
  pending.forEach(function (i) {
    var cat = models[i].category;
    var est = null;
    if (!here[cat]) here[cat] = kwOf(models, cat);
    if (here[cat].length) {
      est = {
        rule: 'sibling',
        kw: _fanMedian(here[cat]),
        how:
          'median of ' +
          here[cat].length +
          ' sized ' +
          cat.toUpperCase() +
          ' unit' +
          (here[cat].length === 1 ? '' : 's') +
          ' in this building: ' +
          _fanRound1(_fanMedian(here[cat])) +
          ' kW (Default)',
      };
    } else {
      var far = kwOf(otherModels(), cat);
      if (far.length)
        est = {
          rule: 'project',
          kw: _fanMedian(far),
          how:
            'median of ' +
            far.length +
            ' sized ' +
            cat.toUpperCase() +
            ' unit' +
            (far.length === 1 ? '' : 's') +
            ' in the other buildings of the project: ' +
            _fanRound1(_fanMedian(far)) +
            ' kW (Default)',
        };
    }
    if (est) models[i] = fanUnitModel(read.units[i], est);
    else unresolved.push(i);
  });
  if (unresolved.length && totalAnnual > 0) {
    var have = models.reduce(function (s, m) {
      return s + (m.ok ? m.kwh : 0);
    }, 0);
    var b = typeof getUDBldg === 'function' ? getUDBldg(projId, bldgId) : null;
    var projs = typeof sget === 'function' ? sget('en_projects', []) : [];
    var proj = projs.find(function (x) {
      return String(x.id) === String(projId);
    });
    var ownType = b && b.type ? String(b.type) : '';
    var typeUsed = ownType || (proj && proj.type ? String(proj.type) : '');
    var vs = fanVentilationShare(typeUsed);
    var typeText = ownType
      ? "the building's own type '" + ownType + "'"
      : typeUsed
        ? "the project type '" + typeUsed + "' (the building has no type)"
        : 'no type set (all buildings)';
    var target = vs.share * totalAnnual;
    var pool = Math.max(0, target - have);
    var sqft = b ? parseFloat(b.sqft) || 0 : 0;
    var tons = unresolved.map(function (i) {
      return read.units[i].tons > 0 ? read.units[i].tons : 0;
    });
    var known = tons.filter(function (t) {
      return t > 0;
    });
    var fill = known.length ? known.reduce(function (a, c) { return a + c; }, 0) / known.length : 1;
    var weights = tons.map(function (t) {
      return t > 0 ? t : fill;
    });
    var wSum = weights.reduce(function (a, c) { return a + c; }, 0);
    if (pool > 0)
      unresolved.forEach(function (i, k) {
        var each = (pool * weights[k]) / wSum;
        models[i] = fanUnitModel(read.units[i], {
          rule: 'area',
          annualKwh: each,
          how:
            'Default: national average ventilation share for ' +
            vs.label +
            ' buildings, from ' +
            typeText +
            ' (EIA CBECS 2018): ' +
            Math.round(vs.share * 1000) / 10 +
            '% of the building total baseline electricity (' +
            Math.round(totalAnnual).toLocaleString() +
            ' kWh' +
            (sqft > 0 ? ', ' + Math.round((target * 100) / sqft) / 100 + ' kWh per sq ft of fans' : '') +
            '), less the fans already sized (a fan with a drive counted at its part-load power), split across ' +
            unresolved.length +
            ' unsized unit' +
            (unresolved.length === 1 ? '' : 's') +
            (known.length ? ' by tons' : ' equally') +
            ': ' +
            Math.round(each).toLocaleString() +
            ' kWh (Default)',
        });
      });
  }
  return models;
}

/** The days-in-month weights of a fan's year (a fan runs all year; the month profile is the month length). Jan..Dec, add up to 1. */
function fanMonthWeights() {
  return FAN_MONTH_DAYS.map(function (d) {
    return d / FAN_DAYS_PER_YEAR;
  });
}

/**
 * The three savings measures of the fan template for the chosen units. Quantities only (kWh and kW).
 *   vfd      a variable-speed drive or EC motor on a constant-speed fan: the published range FAN_VFD_SAVINGS_RANGE (low, mid, high) of the
 *            fan energy, the mid counted (savingsKwh.vfd; low and high in savingsKwh.vfdLow and vfdHigh)
 *   twoSpeed a drive in place of a two-speed motor: Low hours stay at Low speed, High hours modulate (Low share from the enable trend)
 *   reset    duct static pressure reset on a fan that has a drive
 * COUNTED vs POSSIBLE. A drive or two-speed replacement is counted only when the unit's drive status is known "no drive"
 * (m.driveStatus 'none'). A unit sized by the national average (m.sizeBasis 'national') is counted only when its id is in
 * P.confirmedSizes. Everything else is computed and returned as possible, not counted:
 *   possible.drive  units whose drive status is not known (what a drive or two-speed replacement would save if no drive is installed)
 *   possible.size   units of known drive status that wait for the user to confirm a national-average size
 * Each unit's energy is scaled by `factor` (its share of the fan end use after the HVAC electric cap).
 * @param {Array<Object>} models - fanUnitModel results of the chosen units
 * @param {Object} P - { vfd:boolean, twoSpeed:boolean, reset:boolean, resetCut:number (0.2 = 20 percent),
 *   curve:string ('affinity' | 'ashraeG', default FAN_DEFAULT_PART_LOAD_CURVE),
 *   confirmedSizes:string[] (ids of national-average units the user confirmed) }
 * @param {number} factor - cap factor, 0..1
 * @returns {{units:Array<Object>, baselineKwh:number, savingsKwh:{vfd:number,vfdLow:number,vfdHigh:number,twoSpeed:number,reset:number,total:number},
 *   possible:{drive:number,size:number,total:number}, savingsKw:number}}
 */
function fanSavingsForUnits(models, P, factor) {
  var curveOpts = _fanPowerOpts(P.curve);
  var confirmed = P.confirmedSizes || [];
  var steps = [];
  for (var i = 0; i < FAN_TWO_SPEED_VFD_STEPS; i++)
    steps.push({
      speed: FAN_TWO_SPEED_RATIO + ((1 - FAN_TWO_SPEED_RATIO) * (i + 0.5)) / FAN_TWO_SPEED_VFD_STEPS,
      share: 1,
    });
  var highFraction = fanMeanPowerFraction(steps, curveOpts);
  var resetSave = fanResetSavingsFraction(P.resetCut);
  var out = {
    units: [],
    baselineKwh: 0,
    savingsKwh: { vfd: 0, vfdLow: 0, vfdHigh: 0, twoSpeed: 0, reset: 0, total: 0 },
    possible: { drive: 0, size: 0, total: 0 },
    savingsKw: 0,
  };
  var DRIVE_GAP = 'drive status unknown: not counted. Set Has variable speed to No to count it';
  models.forEach(function (m) {
    if (!m.ok) return;
    var u = {
      id: m.id,
      name: m.name,
      baselineKwh: m.kwh * factor,
      vfd: 0,
      twoSpeed: 0,
      reset: 0,
      vfdRange: { low: 0, mid: 0, high: 0 },
      possible: 0,
      possibleKind: null,
      why: {},
    };
    var sizeGap = m.sizeBasis === 'national' && confirmed.indexOf(m.id) < 0;
    // route one computed saving to the counted lines or to the possible line
    var put = function (key, kwh, driveGap) {
      if (!(kwh > 0)) return;
      if (!driveGap && !sizeGap) {
        u[key] += kwh;
        return;
      }
      u.possible += kwh;
      u.possibleKind = driveGap ? 'drive' : u.possibleKind || 'size';
    };
    var sizeWhy = 'national-average size: not counted until you confirm it';
    if (m.twoSpeed) {
      u.why.vfd = 'a two-speed fan: see the two-speed drive measure';
      u.why.reset = 'a two-speed fan: no reset measure';
      if (m.driveStatus === 'has') u.why.twoSpeed = 'already has a variable-speed drive';
      else if (!P.twoSpeed) u.why.twoSpeed = 'measure not chosen';
      else {
        var driveGap2 = m.driveStatus !== 'none';
        put('twoSpeed', m.kw * m.hours * (1 - m.twoSpeed.lowShare) * (1 - highFraction) * factor, driveGap2);
        if (driveGap2) u.why.twoSpeed = DRIVE_GAP;
        else if (sizeGap) u.why.twoSpeed = sizeWhy;
      }
    } else {
      u.why.twoSpeed = 'not a two-speed fan';
      if (m.driveStatus === 'has') {
        u.why.vfd = 'already has a variable-speed drive';
        if (!P.reset) u.why.reset = 'measure not chosen';
        else {
          put('reset', m.kwh * resetSave * m.reset.pass * factor, false);
          if (m.reset.pass === 0) u.why.reset = m.reset.how;
          else if (sizeGap) u.why.reset = sizeWhy;
        }
      } else {
        // 'none' (known) or 'unknown': the drive measure
        var driveGap = m.driveStatus !== 'none';
        u.why.reset = driveGap ? 'drive status unknown: a reset needs a drive' : 'no drive today: a reset needs one';
        if (!P.vfd) u.why.vfd = 'measure not chosen';
        else {
          // no fan speed trend (a moving one would make the status 'has'): the published range, counted at its mid
          var base = m.kw * m.hours * factor;
          put('vfd', base * FAN_VFD_SAVINGS_RANGE.mid, driveGap);
          if (!driveGap && !sizeGap) {
            u.vfdRange.low += base * FAN_VFD_SAVINGS_RANGE.low;
            u.vfdRange.high += base * FAN_VFD_SAVINGS_RANGE.high;
          }
          u.why.vfd = FAN_VFD_SAVINGS_LABEL;
          if (driveGap) u.why.vfd = DRIVE_GAP + '. ' + u.why.vfd;
          else if (sizeGap) u.why.vfd = sizeWhy + '. ' + u.why.vfd;
        }
      }
    }
    u.vfdRange.mid = u.vfd;
    u.total = u.vfd + u.twoSpeed + u.reset;
    u.kw = m.hours > 0 ? u.total / m.hours : 0;
    out.units.push(u);
    out.baselineKwh += u.baselineKwh;
    out.savingsKwh.vfd += u.vfd;
    out.savingsKwh.vfdLow += u.vfdRange.low;
    out.savingsKwh.vfdHigh += u.vfdRange.high;
    out.savingsKwh.twoSpeed += u.twoSpeed;
    out.savingsKwh.reset += u.reset;
    out.savingsKw += u.kw;
    if (u.possibleKind) out.possible[u.possibleKind] += u.possible;
  });
  out.savingsKwh.total = out.savingsKwh.vfd + out.savingsKwh.twoSpeed + out.savingsKwh.reset;
  out.possible.total = out.possible.drive + out.possible.size;
  return out;
}
