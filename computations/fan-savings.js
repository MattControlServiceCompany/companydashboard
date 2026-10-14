// computations/fan-savings.js - the ONE place that sizes a supply fan and counts its run hours (Phase 6, 2026-10-14).
//
// Chain (Matt): Utility Data baseline -> HVAC Load Estimate -> getEndUse(.., 'fans') -> one fan savings template ->
// baseline-period rates. This file holds the fan rules both ends share:
//   fanReadUnits      reads the building's supply-fan rows from the Equipment Matrix and the BAS Trends daily summaries
//   fanUnitModel      one unit: fan kW, run hours, speed drive, speed profile, two-speed split, each with its data level
//   fanSavingsForUnits the three savings measures of the template, per unit
// getEndUse (computations/end-use.js) adds the units up into the fan end use. The template (app/ecm-calculators.js)
// calls getEndUse and fanSavingsForUnits. tools/gate-single-fan-model.js fails when another file keeps its own fan kW
// or run-hours rule. Power and speed rules are NOT here: they are in computations/physics.js (fanKwFromCfm,
// motorKwFromAmps, hpToKw, fanPowerFraction, fanMeanPowerFraction, ductStaticResetPowerSavings).
//
// DATA LEVELS. Every number carries one: 'trend' (measured in a BAS Trends file), 'matrix' (a value in the
// Equipment Matrix: a point read or an asset field) or 'default' (a stated assumption, written in the constants below).
// A better level replaces a worse one on its own when the data arrives: add the fan amps, add the Hi/Lo enable
// trend, fill the voltage and phase, and the same unit moves from default to matrix to trend.
// This is a projected estimate from the data on hand. It is not measured and verified savings.

// ---- stated defaults (each is shown to the person with the data level "default") ----
var FAN_SUPPLY_CATEGORIES = ['ahu', 'rtu', 'doas', 'mau']; // Equipment Matrix categories that have a supply fan
var FAN_HP_CATEGORIES = ['ahu', 'doas', 'mau']; // the Horsepower/Tons column is read as HP here (an RTU is sized in tons)
var FAN_DEFAULT_ANNUAL_HOURS = 3640; // hours per year when nothing says how long the fan runs (commercial-building median, 70 h a week)
var FAN_CONTINUOUS_HOURS = 8760; // hours per year of a fan that runs all the time
var FAN_DEFAULT_VOLTS = 208; // line voltage when the matrix has amps and no voltage (the low end of common supply voltages)
var FAN_DEFAULT_PHASE = 3; // phase when the matrix has amps and no phase
var FAN_HP_MOTOR_EFF = 0.9; // motor efficiency for a nameplate HP
var FAN_HP_LOAD_FACTOR = 0.8; // share of nameplate HP the fan draws
var FAN_DEFAULT_SPEED_BINS = [
  { speed: 0.5, share: 0.2 },
  { speed: 0.65, share: 0.3 },
  { speed: 0.8, share: 0.3 },
  { speed: 1, share: 0.2 },
]; // speed profile of a variable-flow fan with no speed trend
var FAN_TWO_SPEED_RATIO = 0.58; // Low speed as a fraction of High (4/6 pole common case; read the motor tag)
var FAN_TWO_SPEED_DEFAULT_LOW_SHARE = 0.55; // share of run hours on Low when no Hi/Lo enable trend exists
var FAN_RESET_DEFAULT_PRESSURE_CUT = 0.2; // duct static pressure cut a reset reaches (a 20 percent cut saves about 28 percent of fan power)
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

function _fanPhase(v) {
  if (v == null || v === '') return null;
  var s = String(v);
  if (/3|three/i.test(s)) return 3;
  if (/1|single/i.test(s)) return 1;
  return null;
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

/**
 * The supply-fan rows of one building, as raw facts (no math). Equipment Matrix rows of the supply-fan categories,
 * joined to the BAS Trends equipment with the same tag (building + equipment name).
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
  var edits = typeof DB !== 'undefined' && DB.get ? DB.get('en_eqmatrix_edits_' + projId, {}) : {};
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
      var asset = function (key) {
        return emGetCellValByDef(row, { key: key }, edits);
      };
      var speedPoint = pts.supplyFanSpeed != null && pts.supplyFanSpeed !== '';
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
        speedPoint: speedPoint,
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
    out.note = 'No supply-fan rows (AHU, RTU, DOAS, MAU) for this building in the Equipment Matrix';
  return out;
}

/**
 * One unit's fan model from its raw facts. Pure.
 * kW:     measured amps x volts x phase (trend amps first, then the matrix amps), else cfm x W per cfm, else nameplate HP.
 * Hours:  BAS trend run hours (status, enable, amps or speed), else a fan the matrix read running while unoccupied
 *         (runs all the time), else the stated default.
 * Drive:  a speed trend that moves, or a speed point in the matrix, means a variable-speed drive.
 * @returns {Object} model; ok:false (with `missing`) when the unit cannot be sized
 */
function fanUnitModel(raw) {
  var t = raw.trend;
  var m = { id: raw.id, name: raw.name, category: raw.category, ok: false, missing: '' };

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
    m.kw = hpToKw(raw.hp, FAN_HP_MOTOR_EFF) * FAN_HP_LOAD_FACTOR;
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

  // ---- variable-speed drive and speed profile ----
  var tSpeed = t && t.speed ? t.speed : null;
  if (tSpeed && tSpeed.varies) {
    m.vfd = 'yes';
    m.vfdLevel = 'trend';
    m.vfdHow = 'trend fan speed moves';
  } else if (raw.speedPoint) {
    m.vfd = 'yes';
    m.vfdLevel = 'matrix';
    m.vfdHow = 'the matrix has a fan speed point';
  } else if (tSpeed) {
    m.vfd = 'no';
    m.vfdLevel = 'trend';
    m.vfdHow = 'trend fan speed stays in one range';
  } else {
    m.vfd = 'no';
    m.vfdLevel = 'default';
    m.vfdHow = 'no fan speed point: assumed constant speed';
  }
  if (tSpeed) {
    m.profile = { bins: tSpeed.bins, level: 'trend', how: 'trend fan speed by hours' };
  } else {
    m.profile = { bins: FAN_DEFAULT_SPEED_BINS, level: 'default', how: 'default speed profile (50% to 100% of speed)' };
  }
  m.profileFraction = fanMeanPowerFraction(m.profile.bins, { fixedShare: FAN_FIXED_POWER_SHARE });

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
  var opts = { fixedShare: FAN_FIXED_POWER_SHARE };
  var f = 1;
  if (m.twoSpeed) f = m.twoSpeed.lowShare * fanPowerFraction(m.twoSpeed.ratio, opts) + (1 - m.twoSpeed.lowShare);
  else if (m.vfd === 'yes' && m.kwBasis === 'full') f = m.profileFraction;
  m.baselineFraction = f;
  m.kwh = m.kw * m.hours * f;
  m.ok = m.kw > 0 && m.hours > 0;
  return m;
}

/** The days-in-month weights of a fan's year (a fan runs all year; the month profile is the month length). Jan..Dec, add up to 1. */
function fanMonthWeights() {
  return FAN_MONTH_DAYS.map(function (d) {
    return d / FAN_DAYS_PER_YEAR;
  });
}

/**
 * The three savings measures of the fan template for the chosen units. Quantities only (kWh and kW).
 *   vfd      a variable-speed drive or EC motor on a constant-speed fan (speed profile from the trend, else the default)
 *   twoSpeed a drive in place of a two-speed motor: Low hours stay at Low speed, High hours modulate (Low share from the enable trend)
 *   reset    duct static pressure reset on a fan that has a drive
 * Each unit's energy is scaled by `factor` (its share of the fan end use after the HVAC electric cap).
 * @param {Array<Object>} models - fanUnitModel results of the chosen units
 * @param {Object} P - { vfd:boolean, twoSpeed:boolean, reset:boolean, resetCut:number (0.2 = 20 percent) }
 * @param {number} factor - cap factor, 0..1
 * @returns {{units:Array<Object>, baselineKwh:number, savingsKwh:{vfd:number,twoSpeed:number,reset:number,total:number}, savingsKw:number}}
 */
function fanSavingsForUnits(models, P, factor) {
  var opts = { fixedShare: FAN_FIXED_POWER_SHARE };
  var steps = [];
  for (var i = 0; i < FAN_TWO_SPEED_VFD_STEPS; i++)
    steps.push({
      speed: FAN_TWO_SPEED_RATIO + ((1 - FAN_TWO_SPEED_RATIO) * (i + 0.5)) / FAN_TWO_SPEED_VFD_STEPS,
      share: 1,
    });
  var highFraction = fanMeanPowerFraction(steps, opts);
  var resetSave = ductStaticResetPowerSavings(P.resetCut, opts);
  var out = { units: [], baselineKwh: 0, savingsKwh: { vfd: 0, twoSpeed: 0, reset: 0, total: 0 }, savingsKw: 0 };
  models.forEach(function (m) {
    if (!m.ok) return;
    var u = { id: m.id, name: m.name, baselineKwh: m.kwh * factor, vfd: 0, twoSpeed: 0, reset: 0, why: {} };
    if (m.twoSpeed) {
      u.why.vfd = 'a two-speed fan: see the two-speed drive measure';
      var highHours = m.hours * (1 - m.twoSpeed.lowShare);
      u.twoSpeed = P.twoSpeed ? m.kw * highHours * (1 - highFraction) * factor : 0;
      if (!P.twoSpeed) u.why.twoSpeed = 'measure not chosen';
      u.why.reset = 'a two-speed fan: no reset measure';
    } else {
      u.why.twoSpeed = 'not a two-speed fan';
      if (m.vfd === 'no') {
        u.vfd = P.vfd ? m.kw * m.hours * (1 - m.profileFraction) * factor : 0;
        if (!P.vfd) u.why.vfd = 'measure not chosen';
        u.why.reset = 'no drive today: a reset needs one';
      } else {
        u.why.vfd = 'already has a variable-speed drive';
        u.reset = P.reset ? m.kwh * resetSave * m.reset.pass * factor : 0;
        if (!P.reset) u.why.reset = 'measure not chosen';
        else if (m.reset.pass === 0) u.why.reset = m.reset.how;
      }
    }
    u.total = u.vfd + u.twoSpeed + u.reset;
    u.kw = m.hours > 0 ? u.total / m.hours : 0;
    out.units.push(u);
    out.baselineKwh += u.baselineKwh;
    out.savingsKwh.vfd += u.vfd;
    out.savingsKwh.twoSpeed += u.twoSpeed;
    out.savingsKwh.reset += u.reset;
    out.savingsKw += u.kw;
  });
  out.savingsKwh.total = out.savingsKwh.vfd + out.savingsKwh.twoSpeed + out.savingsKwh.reset;
  return out;
}
