// computations/audit-rules.js - Facility Audit automatic findings (canonical source).
// ONE function per rule. Findings are recomputed from the Equipment Matrix on every read; nothing
// here is stored. Only user edits persist (app/facility-audit.js, key en_audit_<pid>).
// Reads these Equipment Matrix functions and values and never copies them:
//   EM_SP_DEFAULTS, emRowHeatingType, emGetNormalizedPoints, emGetSensorDeficiencies,
//   EM_SENSOR_DEFICIENCY_CATEGORY_LABELS, _emParseScheduleBlock, _emProposedScheduleMinutes.
// Browser: plain globals. Node tests: loaded into a vm sandbox beside app/equipment-matrix.js.

var AUDIT_SETPOINT_TOLERANCE_F = 0.5;
var AUDIT_SCHEDULE_TOLERANCE_HOURS = 0.5;

// Units that feed boxes or zones. An air source unit serving other units has no schedule of its own:
// it turns on from their requests (Matt, 2026-10-28). Plants (hot water, chilled water) work the same way.
// AHU, ERV, DOAS and the plants are ALWAYS serving units. An RTU is serving only when its building has
// box or zone rows (VAV, FPB, DDVAV, zone); otherwise it is a single-zone RTU with its own schedule.
// Domestic hot water is NOT a serving unit. A single-zone AHU or RTU (subtype sz) is NOT a serving unit.
var AUDIT_ALWAYS_SERVING_CATEGORIES = { ahu: true, erv: true, doas: true, hwp: true, chwp: true };
var AUDIT_TERMINAL_CATEGORIES = { vav: true, fpb: true, ddvav: true, zone: true };

function _auditNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function _auditHasOwnZoneSetpoints(row) {
  var pts = typeof emGetNormalizedPoints === 'function' ? emGetNormalizedPoints(row) || {} : {};
  return ['zoneCoolSetpoint', 'zoneHtgSetpoint', 'effectiveCoolSetpoint', 'effectiveHtgSetpoint'].some(function (k) {
    return pts[k] !== undefined && pts[k] !== null && pts[k] !== '';
  });
}

function _auditHasNumberedRequests(row) {
  var raw = row.pointsRaw && !Array.isArray(row.pointsRaw) ? row.pointsRaw : {};
  return Object.keys(raw).some(function (k) {
    return /request ?#?\d/i.test(k) && raw[k] !== '' && raw[k] !== null && raw[k] !== undefined;
  });
}

function auditIsServingUnit(row, rows) {
  if (!row) return false;
  var cat = row.category;
  // A single-zone unit (subtype sz) serves one zone and runs its own schedule: not a serving unit.
  // Numbered request inputs ("Air Request 1") prove other units request from it, so they override a wrong sz subtype.
  if (row.subtype === 'sz' && !_auditHasNumberedRequests(row)) return false;
  // A unit with its own zone set points and no numbered request inputs ("Air Request 1", "Heat Request #2")
  // controls its own zone and runs its own schedule: not a serving unit.
  if (_auditHasOwnZoneSetpoints(row) && !_auditHasNumberedRequests(row)) return false;
  if (AUDIT_ALWAYS_SERVING_CATEGORIES[cat]) return true;
  if (cat !== 'rtu') return false;
  var bn = _emNormBldgNameForJoin(row.building || '');
  return (rows || []).some(function (r) {
    return r && r !== row && AUDIT_TERMINAL_CATEGORIES[r.category] && _emNormBldgNameForJoin(r.building || '') === bn;
  });
}

function _auditFinding(row, ruleId, fields) {
  var f = {
    id: 'auto:' + row.id + '::' + ruleId,
    auto: true,
    ruleId: ruleId,
    rowId: row.id,
    building: row.building || '',
    equipment: row.location || row.equipName || '',
    type: typeof emFormatEquipTypeLabel === 'function' ? emFormatEquipTypeLabel(row) || '' : row.category || '',
  };
  for (var k in fields) f[k] = fields[k];
  return f;
}

// Rule: set points off the company standard (EM_SP_DEFAULTS; unoccupied depends on the heating type).
function auditRuleSetpointsOffStandard(row, ctx) {
  var pts = emGetNormalizedPoints(row) || {};
  var ht = emRowHeatingType(row, ctx && ctx.hasGas);
  var std = EM_SP_DEFAULTS.unocc[ht.key];
  var checks = [
    ['occupied heating', _auditNum(pts.zoneHtgSetpoint), EM_SP_DEFAULTS.occHeat],
    ['occupied cooling', _auditNum(pts.zoneCoolSetpoint), EM_SP_DEFAULTS.occCool],
    ['unoccupied heating', _auditNum(pts.zoneUnoccHtgSetpoint), std.heat],
    ['unoccupied cooling', _auditNum(pts.zoneUnoccCoolSetpoint), std.cool],
  ];
  var off = checks.filter(function (c) {
    return c[1] !== null && Math.abs(c[1] - c[2]) > AUDIT_SETPOINT_TOLERANCE_F;
  });
  if (!off.length) return [];
  return [
    _auditFinding(row, 'setpoint-off-standard', {
      issueType: 'Optimization',
      deficiency: false,
      issue:
        'Set point differs from the standard: ' +
        off
          .map(function (c) {
            return c[0] + ' is ' + c[1] + ' (standard ' + c[2] + ')';
          })
          .join('; ') +
        '.',
      change: 'Adjust set points.',
    }),
  ];
}

// Rule: sensor readings that are dead or suspect (emGetSensorDeficiencies is the one source).
function auditRuleSensorDeficiency(row) {
  return emGetSensorDeficiencies(row).map(function (d) {
    var nm = EM_SENSOR_DEFICIENCY_CATEGORY_LABELS[d.col] || d.col;
    return _auditFinding(row, 'sensor-' + d.col, {
      issueType: 'Deficiency',
      deficiency: true,
      issue: nm + ' sensor reading looks ' + (d.status === 'failed' ? 'dead' : 'suspect') + '.',
      change: 'Check the sensor and replace it if it is bad.',
    });
  });
}

// Rule: the existing occupied schedule runs more hours a day than school hours plus staff time.
// A serving unit never gets this finding (it turns on from requests, it has no schedule of its own).
function auditRuleScheduleExtraHours(row, ctx) {
  var es = row && row.existingSchedule;
  if (!es || !es.rawText) return [];
  if (auditIsServingUnit(row, ctx && ctx.rows)) return [];
  var cur = _emParseScheduleBlock(es.rawText);
  if (!cur.hasOccupied) return [];
  var prop = _emProposedScheduleMinutes(row.building || '');
  var extra = (cur.stopMin - cur.startMin - (prop.stopMin - prop.startMin)) / 60;
  if (extra <= AUDIT_SCHEDULE_TOLERANCE_HOURS) return [];
  return [
    _auditFinding(row, 'schedule-extra-hours', {
      issueType: 'Optimization',
      deficiency: false,
      issue:
        'Runs ' +
        Math.round(extra * 10) / 10 +
        ' more hours a day than school hours plus staff time (' +
        cur.startStr +
        ' to ' +
        cur.stopStr +
        ').',
      change: 'Adjust schedules to reduce hours.',
      extraHours: Math.round(extra * 10) / 10,
    }),
  ];
}

var AUDIT_RULES = [
  { id: 'setpoint-off-standard', run: auditRuleSetpointsOffStandard },
  { id: 'sensor-deficiency', run: auditRuleSensorDeficiency },
  { id: 'schedule-extra-hours', run: auditRuleScheduleExtraHours },
];

// All automatic findings for a matrix. ctx: { hasGas: building -> bool|undefined }.
function auditComputeAutoFindings(rows, ctx) {
  var c = { hasGas: ctx && ctx.hasGas, rows: rows || [] };
  var out = [];
  c.rows.forEach(function (row) {
    if (!row || (typeof emIsPhantomRow === 'function' && emIsPhantomRow(row))) return;
    AUDIT_RULES.forEach(function (rule) {
      out = out.concat(rule.run(row, c));
    });
  });
  return out;
}
