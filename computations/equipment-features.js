// computations/equipment-features.js - what one Equipment Matrix row HAS, from its points (item 6715c224).
// The ONE place for: the control-concept list, the sensor yes/no rule, the motor speed rule and the estimated HP of a row.
// Callers: the Equipment Matrix > Counts view (app/equipment-matrix.js) and the sample groups of the Audit Estimate
// (app/audit-estimate.js, auditEstPointSetSignature). Neither keeps its own copy of any rule here.
// Depends on: emGetNormalizedPoints (app/equipment-matrix.js), fanDrivePointName and fanEstimateHp (computations/fan-savings.js).
// Calls are made at run time, so the load order of the files does not matter.

/**
 * Control concepts. A concept is found when one normalized point key of the row passes `test`.
 * `audit: true` = the concept splits the sample groups of the Audit Estimate (units of one type with the same SET of audit
 * concepts are one group). `audit: false` = the concept is for the Counts view only and never changes an audit group.
 * Validated on real BAS data 2026-10-01 for air-side equipment (the audit concepts).
 */
var EM_FEATURE_CONCEPTS = [
  { name: 'Economizer', audit: true, test: /econom|^oaDamperPosition$|returnAirDamper|reliefDamper|mixedAirTemp|returnAirEnthalpy|exhaustAirDamper/i },
  { name: 'Fan speed/VFD', audit: true, test: function (k) { return fanDrivePointName([k]) !== null; } }, // the one drive-name rule (computations/fan-savings.js)
  { name: 'Electric heat', audit: true, test: /(?<!de)scr|baseboard|electricHeat|unitHeater/i },
  { name: 'Hot-water heat', audit: true, test: /^heatingValve$|^reheatValve$|heatingCoil|heatSourceSupplyTemp|hotDeck|preheat/i },
  { name: 'DX cooling', audit: true, test: /circuit|condensing|compressor|cuStage|cuEnable/i },
  { name: 'Chilled-water cooling', audit: true, test: /^coolingValve$|coolingCoil|coolSourceSupplyTemp|chw/i },
  { name: 'CO2', audit: true, test: /co2|carbonDioxide/i },
  { name: 'Zone temp', audit: true, test: /^zoneAirTemp$|^zoneTemp$/i },
  // outside air humidity is a weather point, not a space sensor
  { name: 'Humidity', audit: false, test: /^(?!oa|outdoor|outside|auto_(?:high|low))(?!.*(?:dehumid|set\s?point)).*humid/i },
];

// Points that only the estimated HP reads. They are read from the row's raw point names here, NOT mapped to Equipment Matrix
// columns: a new column would move points between "scored" and "additional" in the Audit View counter (scoring must not change).
// A value is the first raw point whose name passes `pat` and not `neg`, for the listed types.
var EM_HP_RAW_POINTS = {
  cfm: { pat: [/supply\s+fan\s+(?:total\s+)?cfm/i, /supply\s+fan\s+\d+\s+cfm/i], neg: [/set\s?point/i, /\(calculated\)/i, /\(vav\s+total\)/i], cats: ['doas'] },
  driveKw: { pat: [/(?:vfd|drive)\s+power\b/i], neg: [/factor|set\s?point|\b(?:input|output)\s+power\s+on\b/i], cats: ['ahu', 'rtu', 'doas', 'mau', 'ef'] },
  exhaustAmps: { pat: [/exhaust\s+fan\s*\d*\s+(?:amperage|amps)\b/i], neg: [], cats: ['ef'] },
};

function _efRawPoint(row, def) {
  if (def.cats.indexOf(row.category) < 0) return null;
  var raw = row.pointsRaw && !Array.isArray(row.pointsRaw) ? row.pointsRaw : row.points || {};
  var names = Object.keys(raw);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (def.pat.some(function (r) { return r.test(n); }) && !def.neg.some(function (r) { return r.test(n); })) {
      var v = _efNum(raw[n]);
      if (v !== null) return v;
    }
  }
  return null;
}

// Types a feature applies to. Any other type shows a dash in the Counts view.
var EM_FEATURE_MOTOR_CATS = ['ahu', 'rtu', 'doas', 'mau', 'erv', 'ef', 'fcu', 'heater', 'furnace', 'hwp', 'chwp', 'ct', 'plumbing'];
var EM_FEATURE_SENSOR_CATS = ['ahu', 'rtu', 'doas', 'mau', 'erv', 'vav', 'fpb', 'ddvav', 'zone', 'fcu', 'furnace'];
var EM_FEATURE_HP_CATS = ['ahu', 'rtu', 'doas', 'mau', 'erv', 'ef'];

function _efNum(v) {
  if (v == null || v === '') return null;
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

/** The first normalized key that shows each concept: { 'CO2': 'zoneCO2', ... }. */
function emConceptKeys(keys) {
  var found = {};
  keys.forEach(function (k) {
    for (var i = 0; i < EM_FEATURE_CONCEPTS.length; i++) {
      var c = EM_FEATURE_CONCEPTS[i];
      if (c.test.test ? c.test.test(k) : c.test(k)) {
        if (found[c.name] === undefined) found[c.name] = k;
        return; // a key counts toward the first matching concept only
      }
    }
  });
  return found;
}

/**
 * What one Equipment Matrix row has.
 * @param {Object} row - Equipment Matrix row
 * @param {string} projId - project id (custom point aliases are read through window._emActivePid)
 * @param {Object} [edits] - the matrix edits map; with it a person's "Has variable speed" answer wins
 * @returns {{category:string, keys:string[], concepts:string[], conceptKeys:Object,
 *   drive:?string, drivePoint:?string, co2:?boolean, co2Point:?string, humidity:?boolean, humidityPoint:?string,
 *   hp:?{hp:number, source:string, how:string}, hpApplies:boolean}}
 *   drive is 'variable' | 'single' | 'unknown', or null when motor speed does not apply to the type.
 *   co2 and humidity are true / false, or null when sensors do not apply to the type.
 */
function emRowFeatures(row, projId, edits) {
  var prev = window._emActivePid;
  window._emActivePid = projId;
  var pts;
  try {
    pts = emGetNormalizedPoints(row) || {};
  } finally {
    window._emActivePid = prev;
  }
  var keys = Object.keys(pts);
  var found = emConceptKeys(keys);
  var cat = row.category;
  var out = {
    category: cat,
    keys: keys,
    conceptKeys: found,
    concepts: EM_FEATURE_CONCEPTS.map(function (c) { return c.name; }).filter(function (n) { return found[n] !== undefined; }),
    drive: null,
    drivePoint: null,
    co2: null,
    co2Point: null,
    humidity: null,
    humidityPoint: null,
    hp: null,
    hpApplies: EM_FEATURE_HP_CATS.indexOf(cat) >= 0,
  };

  if (EM_FEATURE_SENSOR_CATS.indexOf(cat) >= 0) {
    out.co2 = found['CO2'] !== undefined;
    out.co2Point = found['CO2'] || null;
    out.humidity = found['Humidity'] !== undefined;
    out.humidityPoint = found['Humidity'] || null;
  }

  if (EM_FEATURE_MOTOR_CATS.indexOf(cat) >= 0) {
    var names = row.pointsRaw && !Array.isArray(row.pointsRaw) ? Object.keys(row.pointsRaw) : Object.keys(row.points || {});
    var person = edits && typeof emGetCellValByDef === 'function' ? String(emGetCellValByDef(row, { key: 'hasVfd' }, edits) || '').toLowerCase() : '';
    var point = fanDrivePointName(names, row.equipName, 'motor');
    if (person === 'yes') {
      out.drive = 'variable';
      out.drivePoint = 'Set by a person: has variable speed';
    } else if (person === 'no') {
      out.drive = 'single';
      out.drivePoint = 'Set by a person: no variable speed';
    } else if (point) {
      out.drive = 'variable';
      out.drivePoint = point;
    } else if (/\b(vrf|vrv)\b/i.test(String(row.equipName || ''))) {
      out.drive = 'unknown'; // refrigerant-flow units: the compressor speed is inside the unit
    } else {
      var motorPoint = names.filter(function (n) {
        return /\b(fan|pump|motor|blower)\b/i.test(String(n).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '));
      })[0];
      out.drive = motorPoint ? 'single' : 'unknown';
      out.drivePoint = motorPoint ? 'Motor found, no drive point: ' + motorPoint : null;
    }
  }

  if (out.hpApplies && typeof fanEstimateHp === 'function') {
    out.hp = fanEstimateHp({
      cfm: _efNum(pts.supplyFanCFM) != null ? _efNum(pts.supplyFanCFM) : _efRawPoint(row, EM_HP_RAW_POINTS.cfm),
      speedPct: _efNum(pts.supplyFanSpeed != null ? pts.supplyFanSpeed : pts.exhaustFanSpeed),
      driveKw: _efRawPoint(row, EM_HP_RAW_POINTS.driveKw),
      amps: _efNum(pts.supplyFanAmps) != null ? _efNum(pts.supplyFanAmps) : _efRawPoint(row, EM_HP_RAW_POINTS.exhaustAmps),
      drive: out.drive || 'unknown',
    });
  }
  return out;
}
