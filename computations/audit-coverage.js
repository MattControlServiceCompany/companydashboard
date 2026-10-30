// computations/audit-coverage.js - Facility Audit coverage (canonical source, internal tracker).
// ONE function, auditComputeCoverage, answers "do we have the audit data we need?" for a matrix.
// The Facility Audit tab only renders its result. Nothing is stored; it is recomputed on every read.
// Reads (never copies): emIsPhantomRow, emGetNormalizedPoints, emFormatEquipTypeLabel (app/equipment-matrix.js)
// and auditIsServingUnit (computations/audit-rules.js).
// Rules (Matt, 2026-10-29/30):
//   - Equipment with the same BAS point set (same system type + same point names) is ONE group.
//     A group is covered when at least one member has the data we need. Units are never listed one by one.
//   - Serving units (AHU, ERV, DOAS, serving RTU) have no schedule. They run on requests.
//     A missing schedule is never a gap for them. Plants need only their water temperature set point.
//   - A serving unit needs ONLY its supply air temperature (SAT) set point. A single-zone unit (subtype sz) serves
//     one zone: it is not a serving unit, it needs its own zone set points and schedule, and never "requests".
//   - Domestic hot water (category plumbing, or any DHW/domestic row) and non-HVAC categories are out of scope.
//   - A plant row needs a water temperature set point only when it makes or holds water temperature. Pumps,
//     sump/grinder/fire pump alarms, meters, pressure sensors, and fan units are not plants.
//   - Point names are tested in BOTH forms: the normalized key and the raw BAS point name, so a name the
//     normalizer dropped or renamed still counts.
//   - Lighting is audited from the screenshots we have. An unshot lighting zone is never a gap.
//   - Screenshot evidence: a Still-need line (key = auditCovLineKey) with evidence {files,note,who,when} counts as covered.
//     Equipment we have SEEN in a screenshot is gathered, even if the unit lacks the feature. The caller passes the evidence in.
//   - This is about gathering coverage only. It makes no statement about energy use or savings.

// What each need looks like in the BAS point names (matched against the normalized point keys).
// Names that look like a set point but are not the one we need (alarms, diagnostics, limits, pressure, flow...).
var AUDIT_COV_NOT_SP = /diagnostic|fail|fault|alarm|safety|limit|static|pressure|\bdp\b|dpset|diff|humid|dehumid|cfm|flow|speed|enthalpy|co2|firing|tracking|prohibit|feedback|enable|mode|reset ?sel/i;
var AUDIT_COV_ITEMS = {
  setpoints: { label: 'set points', re: /set ?point|setpt|stpt/i, not: AUDIT_COV_NOT_SP },
  // SAT set point: a supply/discharge air temperature set point, or the cooling/heating set point PID of a supply
  // air loop ("Cooling Set Point BACnet PID / Setpoint": its input is the supply air temperature).
  sat: {
    label: 'supply air temperature set point',
    re: /(supply|discharge)[\w ]*temp[\w ]*(set ?point|setpt|\bsp\b)|(^|[^a-z])(sat|dat)[\w ]*(set ?point|setpt|\bsp\b)|(^|[^a-z])(cool|heat|hw|chw)\w*( valve| coil)? ?(set ?point)? ?(bacnet ?)?pid ?[\/ ]*set ?point|(^|[^a-z])(remote |integration )?(cool|heat)(ing)? (remote |integration )?set ?point( signal)?( ani| av| ano)?$|(^|[^a-z])eru set ?point/i,
    not: /diagnostic|fail|fault|alarm|safety|limit|oa ?(cooling|heating)|static|pressure|humid|dehumid|zone|space|room|occupied|effective|adjust|pre-?heat/i,
  },
  wsp: { label: 'water temperature set point', re: /set ?point|setpt|stpt/i, not: AUDIT_COV_NOT_SP },
  econ: { label: 'economizer settings', re: /econ|outside ?air ?damper|oa ?damper/i },
  co2: { label: 'CO2 value', re: /co2|carbon dioxide/i },
  mode: { label: 'heating and cooling mode', re: /mode/i },
  request: { label: 'requests', re: /request/i },
  schedule: { label: 'schedule', re: /schedule|occupan/i },
  points: { label: 'BAS points', re: /./ },
};

// Category -> what we need.
var AUDIT_COV_ZONE = { vav: 1, fpb: 1, ddvav: 1, zone: 1, fcu: 1, vrf: 1, ac: 1 };
var AUDIT_COV_AIR = {
  ahu: ['econ', 'co2', 'mode'],
  rtu: ['econ', 'co2', 'mode'],
  doas: ['co2', 'mode'],
  erv: ['mode'],
};
var AUDIT_COV_PLANT = { hwp: 1, chwp: 1 };
var AUDIT_COV_BASIC = { ef: 1, heater: 1, mau: 1, furnace: 1 };
var AUDIT_COV_NONE = { lighting: 1 };
// Domestic hot water, meters and pump or sump alarm rows are not HVAC water plants.
var AUDIT_COV_NOT_PLANT_NAME = /domestic|\bdhw\b|meter|sump|ejector|grinder|fire pump/i;
// A plant makes or holds water temperature: it has a loop/boiler/chiller/system supply, return or leaving water point.
var AUDIT_COV_PLANT_POINT = /system ?(supply|return)|(boiler|chiller|loop|secondary|primary|plant|source)\W*(\w+\W+){0,2}(supply|return|leaving|outlet)|(supply|return|leaving)\W*water|hot ?water (supply|temp)|chilled ?water (supply|temp)|lchw|lcw|chws|hws/i;
// A control point: something a unit can command or run.
var AUDIT_COV_CONTROL_POINT = /fan|valve|damper|mode|enable|command|cmd|flow|schedule|heat|cool|set ?point/i;
// A zone unit has a set point only when it senses a zone temperature.
var AUDIT_COV_ZONE_TEMP = /(zone|space|room)\W*(air\W*)?temp|temp\W*(of )?(zone|space|room)|^raw:temp(erature)?$/i;

// An air handler or rooftop unit has a supply air temperature, mixed air, return air or an economizer.
// A fan alone (stair pressure fan, exhaust fan, destratification fan) is not an air unit.
var AUDIT_COV_AIR_UNIT_POINT = /supply ?air ?temp|mixed ?air|return ?air ?temp|discharge ?air ?temp|economizer/i;
// A terminal box has an air flow set point or flow control and no supply fan.
var AUDIT_COV_BOX_POINT = /air ?flow ?set ?point|flow ?control/i;

function _auditCovNames(row) {
  var pts = emGetNormalizedPoints(row) || {};
  var seen = {};
  Object.keys(pts).forEach(function (k) {
    if (pts[k] !== '' && pts[k] !== null && pts[k] !== undefined) seen[k] = true;
  });
  var raw = row.pointsRaw;
  if (raw && !Array.isArray(raw)) {
    Object.keys(raw).forEach(function (k) {
      if (raw[k] !== '' && raw[k] !== null && raw[k] !== undefined) seen['raw:' + k] = true;
    });
  }
  return Object.keys(seen).sort();
}

// The items we need for one row, or null when the row is out of scope. names = _auditCovNames(row).
function auditCoverageNeeds(row, rows, names) {
  var cat = row.category;
  // Filed as an air unit but the equipment name says it is a fan coil, box or fan: use the name's category
  // (emParseEquipBaseName is the one name classifier).
  if (AUDIT_COV_AIR[cat] && typeof emParseEquipBaseName === 'function') {
    var nameCat = emParseEquipBaseName(row.equipName || row.location || '');
    if (nameCat === 'fcu' || nameCat === 'vav' || nameCat === 'ef') cat = nameCat;
  }
  names = names || _auditCovNames(row);
  var has = function (re) {
    return names.some(function (k) {
      return re.test(k);
    });
  };
  if (AUDIT_COV_NONE[cat]) return [];
  if (AUDIT_COV_PLANT[cat]) {
    if (AUDIT_COV_NOT_PLANT_NAME.test((row.location || '') + ' ' + (row.equipName || ''))) return null;
    if (!has(AUDIT_COV_PLANT_POINT) || has(/fan/i)) return null;
    return ['wsp'];
  }
  if (AUDIT_COV_AIR[cat] && !has(AUDIT_COV_AIR_UNIT_POINT)) {
    // Filed as an air unit but the points show no air unit: a terminal box, or a panel/relay row.
    // A box needs its zone set points. Anything else is not an air unit and is out of scope.
    return has(AUDIT_COV_BOX_POINT) && has(AUDIT_COV_ZONE_TEMP) ? ['setpoints'] : null;
  }
  if (AUDIT_COV_ZONE[cat]) {
    // A CO2 monitoring program (sensors only, nothing to control) has no set point to find.
    if (has(/co2/i) && !has(AUDIT_COV_CONTROL_POINT)) return [];
    // A zone unit senses a zone temperature. An outdoor unit, an exhaust fan or a damper row filed as a zone unit does not.
    return has(AUDIT_COV_ZONE_TEMP) ? ['setpoints'] : [];
  }
  if (AUDIT_COV_BASIC[cat]) return ['points'];
  if (AUDIT_COV_AIR[cat]) {
    // A serving unit has no schedule and runs on requests: it needs only its SAT set point.
    if (auditIsServingUnit(row, rows)) return ['sat'];
    // A single-zone unit has its own schedule and zone set points. Nothing requests from it.
    // An energy wheel (ERV) replaces the economizer. A garage unit reads carbon monoxide, not CO2.
    return ['setpoints', 'schedule'].concat(
      AUDIT_COV_AIR[cat].filter(function (n) {
        if (n === 'econ') return !has(/energy wheel|enthalpy wheel|sensible wheel|\berv\b/i);
        if (n === 'co2') return !has(/carbon monoxide/i);
        return true;
      })
    );
  }
  return null;
}

function _auditCovHasItem(row, names, item) {
  if (item === 'schedule' && row.existingSchedule && row.existingSchedule.rawText) return true;
  var def = AUDIT_COV_ITEMS[item];
  return names.some(function (k) {
    return def.re.test(k) && !(def.not && def.not.test(k));
  });
}

// Coverage for a matrix. Returns:
//   { total, covered, pct, buildings:[{name,total,covered,pct}], types:[{name,total,covered,pct}],
//     groups:[{type,buildings,units,needs,covered,missing,example}],
//     stillNeed:[{type,buildings,units,groups,example,missing,reason}] }
// Key of one Still-need line (system type + missing items). Evidence is stored under this key.
function auditCovLineKey(type, missing) {
  return type + '|' + (missing || []).join(',');
}

// evidence (optional) = { <auditCovLineKey>: { files:[...], note, who, when } }. A line with evidence is covered.
function auditComputeCoverage(rows, evidence) {
  rows = rows || [];
  evidence = evidence || {};
  var groups = {};
  rows.forEach(function (row) {
    if (!row || (typeof emIsPhantomRow === 'function' && emIsPhantomRow(row))) return;
    var keys = _auditCovNames(row);
    var needs = auditCoverageNeeds(row, rows, keys);
    if (!needs) return;
    var type = emFormatEquipTypeLabel(row) || row.category || '';
    var gk = type + '|' + needs.join(',') + '|' + keys.join(',');
    var g = groups[gk];
    if (!g) g = groups[gk] = { type: type, needs: needs, members: [], haveAll: false, missing: null, example: row.location || row.equipName || row.id };
    var miss = needs.filter(function (n) {
      return !_auditCovHasItem(row, keys, n);
    });
    // Lighting is audited from the screenshots we have: never a gap (its needs list is empty).
    if (!miss.length) g.haveAll = true;
    else if (g.missing === null || miss.length < g.missing.length) g.missing = miss;
    g.members.push(row);
  });
  var list = Object.keys(groups).map(function (k) {
    var g = groups[k];
    var bset = {};
    var shot = !g.haveAll && evidence[auditCovLineKey(g.type, g.missing || [])] ? evidence[auditCovLineKey(g.type, g.missing || [])] : null;
    g.members.forEach(function (r) {
      bset[r.building || ''] = true;
    });
    return {
      type: g.type,
      buildings: Object.keys(bset).sort(),
      units: g.members.length,
      needs: g.needs,
      covered: g.haveAll || !!shot,
      shot: shot,
      missing: g.haveAll ? [] : g.missing || [],
      example: g.example,
      members: g.members,
    };
  });
  function tally(keyFn) {
    var t = {};
    list.forEach(function (g) {
      g.members.forEach(function (r) {
        var k = keyFn(g, r);
        if (!t[k]) t[k] = { name: k, total: 0, covered: 0, pct: 0 };
        t[k].total++;
        if (g.covered) t[k].covered++;
      });
    });
    return Object.keys(t)
      .sort()
      .map(function (k) {
        t[k].pct = Math.round((100 * t[k].covered) / t[k].total);
        return t[k];
      });
  }
  var total = 0;
  var covered = 0;
  list.forEach(function (g) {
    total += g.units;
    if (g.covered) covered += g.units;
  });
  // Still need: one line per system type + missing items (not one per group), biggest first.
  var needBy = {};
  var shotBy = {};
  list.forEach(function (g) {
    if (g.covered && !g.shot) return;
    var nk = auditCovLineKey(g.type, g.missing);
    var n = (g.shot ? shotBy : needBy)[nk];
    if (!n) {
      var labels = g.missing.map(function (m) {
        return AUDIT_COV_ITEMS[m].label;
      });
      n = (g.shot ? shotBy : needBy)[nk] = {
        key: nk,
        evidence: g.shot,
        type: g.type,
        units: 0,
        groups: 0,
        buildings: {},
        example: g.example,
        missing: g.missing,
        reason: 'Missing ' + labels.join(', ') + '. No unit with the same BAS points has it.',
      };
    }
    n.units += g.units;
    n.groups++;
    g.buildings.forEach(function (b) {
      n.buildings[b] = true;
    });
  });
  var stillNeed = Object.keys(needBy)
    .map(function (k) {
      var n = needBy[k];
      n.buildings = Object.keys(n.buildings).sort();
      return n;
    })
    .sort(function (a, b) {
      return b.units - a.units || (a.type < b.type ? -1 : 1);
    });
  return {
    total: total,
    covered: covered,
    pct: total ? Math.round((100 * covered) / total) : 100,
    buildings: tally(function (g, r) {
      return r.building || '(no building)';
    }),
    types: tally(function (g) {
      return g.type;
    }),
    groups: list
      .map(function (g) {
        return { type: g.type, buildings: g.buildings, units: g.units, needs: g.needs, covered: g.covered, missing: g.missing, example: g.example };
      })
      .sort(function (a, b) {
        return a.type < b.type ? -1 : a.type > b.type ? 1 : b.units - a.units;
      }),
    stillNeed: stillNeed,
    screenshotCovered: Object.keys(shotBy)
      .map(function (k) {
        var n = shotBy[k];
        n.buildings = Object.keys(n.buildings).sort();
        return n;
      })
      .sort(function (a, b) {
        return b.units - a.units || (a.type < b.type ? -1 : 1);
      }),
  };
}
