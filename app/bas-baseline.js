// app/bas-baseline.js
//
// The ONE place that turns the Optimization Strategy Sheet "Set Points" sheet (CSV) into the BASELINE entries of the
// BAS schedule history record (store key en_bas_schedhistory_<projectId>, read by the quarterly report; the dated
// entries come from app/bas-audit-log.js). Pure: no DOM, no storage, no network. Browser script or CommonJS module.
// The CSV is split by baSplitCSV (app/bas-alarms.js). The columns are the "Existing ..." columns the Equipment Matrix
// Set Points export writes (EM_SETPOINT_EXPORT_HEADERS, app/equipment-matrix.js), found by header name.
//
// Rules, per building, over its rows:
//   - occupied hours Mon-Fri: the most common (start, stop). Any other (start, stop) held by 15% or more of the rows
//     is added in brackets: "(Area G 6:00 to 20:00)" when every row of that group is in one area, else "(some ...)".
//   - weekend: the most common "Existing Occupied Sat & Sun" value.
//   - occupied set points: the most common (heating, cooling) pair.
// A baseline entry carries src = SOURCE. An entry already in the record is replaced only when it carries SOURCE or one of
// the fallback marks of the audit log import (BasAuditLog.AUDIT_SRC, POINTS_SRC); one typed by a person is kept.
// fromPoints: the set points of a building from the stored WebCTRL points list (the Equipment Matrix rows), for a
// building the audit log shows no set point change for (the audit log import uses it; this module never stores it).
(function (root) {
  'use strict';

  var BAL = root.BasAuditLog || (typeof require === 'function' ? require('./bas-audit-log.js') : null);
  var SOURCE = 'Optimization Strategy Sheet (Existing)';
  var SECONDARY_SHARE = 0.15;
  var COLS = {
    building: 'Building Name',
    location: 'Building location or equipment affected',
    heat: 'Existing Occupied Heating',
    cool: 'Existing Occupied Cooling',
    start: 'Existing Occupied Start Time Monday-Friday',
    stop: 'Existing Occupied Stop Time Monday-Friday',
    weekend: 'Existing Occupied Sat & Sun',
  };

  function clock(v) {
    var m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    return m ? parseInt(m[1], 10) + ':' + m[2] : null;
  }
  function numText(v) {
    var n = parseFloat(String(v || '').trim());
    return isFinite(n) ? String(Math.round(n * 10) / 10) : null;
  }
  // [{key, n, rows}] most common first (ties: key order).
  function tally(items) {
    var by = {};
    items.forEach(function (it) {
      (by[it.key] = by[it.key] || { key: it.key, n: 0, rows: [] }).n++;
      by[it.key].rows.push(it);
    });
    return Object.keys(by)
      .map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
  }
  function areaOf(location) {
    var m = String(location || '').match(/^\s*(Area\s+[A-Za-z0-9]+)\s*-/i);
    return m ? m[1].replace(/\s+/, ' ') : null;
  }
  function hoursText(key) {
    return key.replace('|', ' to ');
  }

  // rows2d = baSplitCSV(text). Returns { error } or { buildings:[{ building, rows, baselineWeekday, weekend, setPoints }] }.
  function parseRows(rows2d) {
    if (!rows2d || !rows2d.length) return { error: 'The file is empty.' };
    var head = rows2d[0].map(function (h) { return String(h).replace(/^\uFEFF/, '').trim().toLowerCase(); });
    var at = {};
    var missing = [];
    Object.keys(COLS).forEach(function (k) {
      at[k] = head.indexOf(COLS[k].toLowerCase());
      if (at[k] < 0) missing.push(COLS[k]);
    });
    if (missing.length) return { error: 'This is not the Set Points sheet. Missing columns: ' + missing.join(', ') + '.' };
    var byB = {};
    var order = [];
    rows2d.slice(1).forEach(function (r) {
      var b = String(r[at.building] || '').trim();
      if (!b) return;
      if (!byB[b]) {
        byB[b] = [];
        order.push(b);
      }
      var s = clock(r[at.start]);
      var e = clock(r[at.stop]);
      var h = numText(r[at.heat]);
      var c = numText(r[at.cool]);
      byB[b].push({
        hours: s && e ? s + '|' + e : null,
        area: areaOf(r[at.location]),
        weekend: String(r[at.weekend] || '').trim(),
        pair: h !== null && c !== null ? h + '|' + c : null,
      });
    });
    var buildings = order.map(function (b) {
      var rows = byB[b];
      var hrs = tally(rows.filter(function (x) { return x.hours; }).map(function (x) { return { key: x.hours, area: x.area }; }));
      var total = hrs.reduce(function (s, g) { return s + g.n; }, 0);
      var weekdayText = null;
      if (hrs.length) {
        var notes = hrs
          .slice(1)
          .filter(function (g) { return g.n / total >= SECONDARY_SHARE; })
          .map(function (g) {
            var areas = {};
            g.rows.forEach(function (x) { areas[x.area || ''] = 1; });
            var ks = Object.keys(areas);
            return (ks.length === 1 && ks[0] ? ks[0] : 'some') + ' ' + hoursText(g.key);
          });
        weekdayText = hoursText(hrs[0].key) + (notes.length ? ' (' + notes.join('; ') + ')' : '');
      }
      var we = tally(rows.filter(function (x) { return x.weekend; }).map(function (x) { return { key: x.weekend }; }));
      var sp = tally(rows.filter(function (x) { return x.pair; }).map(function (x) { return { key: x.pair }; }));
      return {
        building: b,
        rows: rows.length,
        baselineWeekday: weekdayText,
        weekend: we.length ? we[0].key : null,
        setPoints: sp.length ? 'heating ' + sp[0].key.split('|')[0] + ', cooling ' + sp[0].key.split('|')[1] : null,
      };
    });
    return { buildings: buildings };
  }

  // Baseline entries of a list: replaced when none exist or all carry SOURCE; otherwise kept (typed by a person).
  function setBase(list, entry) {
    var old = (list || []).filter(function (e) { return !e.from && !e.to; });
    var dated = (list || []).filter(function (e) { return e.from || e.to; });
    var mine = old.every(function (e) { return e.src === SOURCE || e.src === BAL.AUDIT_SRC || e.src === BAL.POINTS_SRC; });
    if (!mine || !entry) return list || [];
    return [entry].concat(dated);
  }
  // existing = the stored record or null; parsed = parseRows(...).buildings. Returns { rec, matched }.
  function apply(existing, parsed, projectNames) {
    var rec = { version: 1, buildings: existing && Array.isArray(existing.buildings) ? existing.buildings.slice() : [] };
    var matched = [];
    var names = BAL.resolveNames(parsed.map(function (p) { return p.building; }), projectNames);
    parsed.forEach(function (p) {
      var name = names.map[p.building];
      matched.push({ log: p.building, project: name });
      if (!name) return;
      var idx = -1;
      rec.buildings.forEach(function (b, i) { if (b && b.building === name) idx = i; });
      var old = idx >= 0 ? rec.buildings[idx] : { building: name, weekday: [], weekend: [], setPoints: [] };
      var merged = Object.assign({ building: '', baselineWeekday: [], weekday: [], weekend: [], setPoints: [] }, old, {
        baselineWeekday: setBase(old.baselineWeekday, p.baselineWeekday ? { text: p.baselineWeekday, src: SOURCE } : null),
        weekend: setBase(old.weekend, p.weekend ? { kind: 'baseline', text: p.weekend, src: SOURCE } : null),
        setPoints: setBase(old.setPoints, p.setPoints ? { kind: 'baseline', text: p.setPoints, src: SOURCE } : null),
      });
      if (idx >= 0) rec.buildings[idx] = merged;
      else rec.buildings.push(merged);
    });
    return { rec: rec, matched: matched };
  }

  // rows = [{ building, type, heat, cool }] (heat and cool as in the points list, e.g. "45.0 F"; type = the matrix equipment
  // type label). Returns [{ building, text }]: the most common (heat, cool) pair over rows that have both, labelled with
  // the type when every one of those rows has the same type ("Unit heaters: heating 45, cooling 90").
  function fromPoints(rows) {
    var byB = {};
    var order = [];
    (rows || []).forEach(function (r) {
      var h = numText(r.heat);
      var c = numText(r.cool);
      var b = String(r.building || '').trim();
      if (!b || h === null || c === null) return;
      if (!byB[b]) {
        byB[b] = [];
        order.push(b);
      }
      byB[b].push({ key: h + '|' + c, type: String(r.type || '').trim() });
    });
    return order.map(function (b) {
      var top = tally(byB[b])[0].key.split('|');
      var types = {};
      byB[b].forEach(function (x) { types[x.type] = 1; });
      var ts = Object.keys(types);
      var label = ts.length === 1 && ts[0] ? ts[0].charAt(0).toUpperCase() + ts[0].slice(1).toLowerCase() + (/s$/i.test(ts[0]) ? '' : 's') + ': ' : '';
      return { building: b, text: label + 'heating ' + top[0] + ', cooling ' + top[1] };
    });
  }

  var api = {
    fromPoints: fromPoints, SOURCE: SOURCE, COLS: COLS, parseRows: parseRows, apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasBaseline = api;
})(typeof window !== 'undefined' ? window : this);
