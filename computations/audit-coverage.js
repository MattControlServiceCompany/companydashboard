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
//   - Domestic hot water (category plumbing) and non-HVAC categories are out of scope.
//   - Lighting is audited from the screenshots we have. An unshot lighting zone is never a gap.
//   - This is about gathering coverage only. It makes no statement about energy use or savings.

// What each need looks like in the BAS point names (matched against the normalized point keys).
var AUDIT_COV_ITEMS = {
  setpoints: { label: 'set points', re: /set ?point|setpt/i },
  sat: { label: 'supply air temperature set point', re: /(sat|supply.*temp|discharge.*temp)\w*(set ?point|setpt|sp\b)/i },
  econ: { label: 'economizer settings', re: /econ/i },
  co2: { label: 'CO2 value', re: /co2/i },
  mode: { label: 'heating and cooling mode', re: /mode/i },
  request: { label: 'requests', re: /request/i },
  schedule: { label: 'schedule', re: /schedule|occupan/i },
  points: { label: 'BAS points', re: /./ },
};

// Category -> what we need.
var AUDIT_COV_ZONE = { vav: 1, fpb: 1, ddvav: 1, zone: 1, fcu: 1, vrf: 1, ac: 1 };
var AUDIT_COV_AIR = {
  ahu: ['sat', 'econ', 'co2', 'mode', 'request'],
  rtu: ['sat', 'econ', 'co2', 'mode', 'request'],
  doas: ['sat', 'co2', 'mode', 'request'],
  erv: ['sat', 'mode', 'request'],
};
var AUDIT_COV_PLANT = { hwp: 1, chwp: 1 };
var AUDIT_COV_BASIC = { ef: 1, heater: 1, mau: 1, furnace: 1 };
var AUDIT_COV_NONE = { lighting: 1 };

// The items we need for one row, or null when the row is out of scope.
function auditCoverageNeeds(row, rows) {
  var cat = row.category;
  if (AUDIT_COV_NONE[cat]) return [];
  if (AUDIT_COV_ZONE[cat] || AUDIT_COV_PLANT[cat]) return ['setpoints'];
  if (AUDIT_COV_BASIC[cat]) return ['points'];
  if (AUDIT_COV_AIR[cat]) {
    var needs = AUDIT_COV_AIR[cat].slice();
    // A single-zone RTU has its own schedule and zone set points. A serving unit has neither.
    if (!auditIsServingUnit(row, rows)) {
      needs = needs.filter(function (n) {
        return n !== 'sat';
      });
      needs.unshift('setpoints', 'schedule');
    }
    return needs;
  }
  return null;
}

function _auditCovHasItem(row, keys, item) {
  if (item === 'schedule' && row.existingSchedule && row.existingSchedule.rawText) return true;
  var re = AUDIT_COV_ITEMS[item].re;
  return keys.some(function (k) {
    return re.test(k);
  });
}

// Coverage for a matrix. Returns:
//   { total, covered, pct, buildings:[{name,total,covered,pct}], types:[{name,total,covered,pct}],
//     groups:[{type,buildings,units,needs,covered,missing,example}],
//     stillNeed:[{type,buildings,units,groups,example,missing,reason}] }
function auditComputeCoverage(rows) {
  rows = rows || [];
  var groups = {};
  rows.forEach(function (row) {
    if (!row || (typeof emIsPhantomRow === 'function' && emIsPhantomRow(row))) return;
    var needs = auditCoverageNeeds(row, rows);
    if (!needs) return;
    var pts = emGetNormalizedPoints(row) || {};
    var keys = Object.keys(pts)
      .filter(function (k) {
        return pts[k] !== '' && pts[k] !== null && pts[k] !== undefined;
      })
      .sort();
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
    g.members.forEach(function (r) {
      bset[r.building || ''] = true;
    });
    return {
      type: g.type,
      buildings: Object.keys(bset).sort(),
      units: g.members.length,
      needs: g.needs,
      covered: g.haveAll,
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
  list.forEach(function (g) {
    if (g.covered) return;
    var nk = g.type + '|' + g.missing.join(',');
    var n = needBy[nk];
    if (!n) {
      var labels = g.missing.map(function (m) {
        return AUDIT_COV_ITEMS[m].label;
      });
      n = needBy[nk] = {
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
  };
}
