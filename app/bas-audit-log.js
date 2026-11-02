// app/bas-audit-log.js
//
// The ONE place that turns a WebCTRL audit log export into the BAS schedule history record the quarterly report
// prints (store key en_bas_schedhistory_<projectId>, read by _rptBasHistoryLoad in app/report-engine.js).
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
// The CSV is split by baSplitCSV (app/bas-alarms.js); the caller passes the split rows. The building of a row is
// BasDiff.buildingOf (app/bas-diff.js). The card in app/bas-schedules.js reads files and writes the result with DB.set.
//
// Input rows: header Date, Description, Details, Location, Operator. One audit event per row. A cell may hold
// several lines. Date is M/D/YYYY h:mm:ss AM/PM.
// Rules (the same as the hand-built facts they replace):
//   - A change at time T on date D applies from D. The state of a day is its END-OF-DAY state.
//   - Weekday and weekend hours: "Add / Update / Delete schedule" rows at the building root location
//     (/District/Building) whose schedule type is Weekly. Hours are the union of the schedules that list the day.
//   - Set points: lines "<path>/occupied_heating|occupied_cooling changed from "X" to "Y"" in Details, any Description.
//     A zone is the Location of the row. Its value before its first logged change is the "from" of that change.
//     The value of a day is the most common (heating, cooling) pair over the zones that have both points.
//   - A value the log cannot show is printed as "Not found in the audit log"; nothing is invented.
// Output record: { version:1, buildings:[{ building, baselineWeekday:[{text}], weekday:[{text,from,to}],
//   weekend:[{kind,text,from,to}], setPoints:[{kind,text,from,to}] }] }  (from, to are YYYY-MM-DD).
(function (root) {
  'use strict';

  var BD = root.BasDiff || (typeof require === 'function' ? require('./bas-diff.js') : null);
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var HEAD = ['date', 'description', 'details', 'location', 'operator'];
  var NOT_FOUND = 'Not found in the audit log';
  var NO_SETPOINTS = 'Not determinable (no occupied set point rows in the log)';
  var AUTO = 'audit-log'; // marks a baseline entry this module wrote; an entry without it was typed by a person and is kept

  // --- dates -------------------------------------------------------------------------------------
  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }
  // "7/27/2026 10:16:25 AM" -> "2026-07-27T10:16:25"; null when it is not a date.
  function isoOf(text) {
    var m = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    var h = parseInt(m[4], 10) % 12;
    if (m[7].toUpperCase() === 'PM') h += 12;
    return m[3] + '-' + pad(+m[1]) + '-' + pad(+m[2]) + 'T' + pad(h) + ':' + m[5] + ':' + m[6];
  }
  function addDays(ymd, n) {
    var d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n));
    return d.toISOString().slice(0, 10);
  }
  function dowOf(ymd) {
    return (new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).getUTCDay() + 6) % 7; // Mon = 0
  }

  // --- reading rows ------------------------------------------------------------------------------
  // rows2d = baSplitCSV(text). Returns { error } or { events:[{iso, ymd, desc, details, loc, building}] } oldest first.
  function parseRows(rows2d) {
    if (!rows2d || !rows2d.length) return { error: 'The file is empty.' };
    var head = rows2d[0].map(function (h) {
      return String(h).replace(/^﻿/, '').trim().toLowerCase();
    });
    if (head.length < 5 || HEAD.some(function (h, i) { return head[i] !== h; })) {
      return { error: 'This is not a WebCTRL audit log. The first row must be: Date, Description, Details, Location, Operator.' };
    }
    var events = [];
    rows2d.slice(1).forEach(function (r) {
      if (r.length < 5) return;
      var iso = isoOf(r[0]);
      if (!iso) return;
      events.push({ iso: iso, ymd: iso.slice(0, 10), desc: String(r[1]), details: String(r[2]), loc: String(r[3]).trim(), building: BD.buildingOf(r[3]) });
    });
    events.reverse(); // the export is newest first
    return { events: events };
  }
  function sortEvents(events) {
    return events
      .map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) { return a.e.iso < b.e.iso ? -1 : a.e.iso > b.e.iso ? 1 : a.i - b.i; })
      .map(function (x) { return x.e; });
  }

  // --- schedules ---------------------------------------------------------------------------------
  // A "Weekly" occupancy block -> { name, days:[...], iv:[[start,end]] } (minutes). null for any other type.
  function parseBlock(txt) {
    var nm = String(txt).match(/schedule "([^"]*)"/);
    if (!nm || String(txt).indexOf('Type "Weekly"') < 0) return null;
    var dm = String(txt).match(/days:([^\n]*)/);
    var days = dm ? dm[1].split(/\s+/).filter(Boolean) : [];
    var iv = [];
    var cur = null;
    var re = /At "(\d+):(\d+)" set "(\w+)"/g;
    var m;
    while ((m = re.exec(txt))) {
      var t = +m[1] * 60 + +m[2];
      if (m[3] === 'Occupied' && cur === null) cur = t;
      else if (m[3] !== 'Occupied' && cur !== null) {
        iv.push([cur, t]);
        cur = null;
      }
    }
    if (cur !== null) iv.push([cur, 1440]);
    return { name: nm[1], days: days, iv: iv };
  }
  function isRoot(loc) {
    return String(loc).split('/').filter(function (x) { return x.trim(); }).length === 2;
  }
  // Schedule events of one building: { iso, ymd, kind:'add'|'upd'|'del', old, nw }.
  function scheduleEvents(evs) {
    var out = [];
    evs.forEach(function (e) {
      var m = e.desc.match(/^(Add|Update|Delete) schedule\b/);
      if (!m || !isRoot(e.loc)) return;
      if (m[1] === 'Update') {
        var j = e.details.indexOf('New values:');
        if (j < 0) return;
        var o = parseBlock(e.details.slice(0, j));
        var n = parseBlock(e.details.slice(j));
        if (o && n) out.push({ iso: e.iso, ymd: e.ymd, kind: 'upd', old: o, nw: n });
      } else {
        var b = parseBlock(e.details);
        if (b) out.push({ iso: e.iso, ymd: e.ymd, kind: m[1] === 'Add' ? 'add' : 'del', old: null, nw: b });
      }
    });
    return out;
  }
  function hm(min) {
    return Math.floor(min / 60) + ':' + pad(min % 60);
  }
  // Hours of one day from a state { name: block }: "6:00 to 16:00", joined by " and "; '' when none.
  function dayHours(state, dow) {
    var iv = [];
    Object.keys(state).forEach(function (k) {
      if (state[k].days.indexOf(DAYS[dow]) >= 0) iv = iv.concat(state[k].iv);
    });
    iv.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var mg = [];
    iv.forEach(function (x) {
      if (mg.length && x[0] <= mg[mg.length - 1][1]) mg[mg.length - 1][1] = Math.max(mg[mg.length - 1][1], x[1]);
      else mg.push([x[0], x[1]]);
    });
    return mg.map(function (x) { return hm(x[0]) + ' to ' + hm(x[1]); }).join(' and ');
  }
  // dayStrs: hours text for days from..to of the week -> "Mon-Thu 7:00 to 16:00; Fri 7:00 to 12:00" or "None".
  function daysText(week, from, to) {
    var parts = [];
    var i = from;
    while (i <= to) {
      var j = i;
      while (j + 1 <= to && week[j + 1] === week[i]) j++;
      if (week[i]) parts.push((j > i ? DAYS[i] + '-' + DAYS[j] : DAYS[i]) + ' ' + week[i]);
      i = j + 1;
    }
    return parts.length ? parts.join('; ') : 'None';
  }
  function copyState(s) {
    var o = {};
    Object.keys(s).forEach(function (k) { o[k] = s[k]; });
    return o;
  }
  // Day by day end-of-day weekday and weekend text from wFrom to wTo. Also the state before any logged event.
  function scheduleDays(sevs, wFrom, wTo) {
    var initial = {};
    var seen = {};
    sevs.forEach(function (e) {
      if (e.kind === 'upd') {
        if (!seen[e.old.name]) initial[e.old.name] = e.old;
        seen[e.old.name] = 1;
        seen[e.nw.name] = 1;
      } else if (e.kind === 'del') {
        if (!seen[e.nw.name]) initial[e.nw.name] = e.nw;
        seen[e.nw.name] = 1;
      } else seen[e.nw.name] = 1;
    });
    var state = copyState(initial);
    var k = 0;
    var days = [];
    for (var d = wFrom; d <= wTo; d = addDays(d, 1)) {
      while (k < sevs.length && sevs[k].ymd <= d) {
        var e = sevs[k++];
        if (e.kind === 'upd') {
          delete state[e.old.name];
          state[e.nw.name] = e.nw;
        } else if (e.kind === 'del') delete state[e.nw.name];
        else state[e.nw.name] = e.nw;
      }
      var week = [];
      for (var i = 0; i < 7; i++) week.push(dayHours(state, i));
      days.push({ ymd: d, wd: daysText(week, 0, 4), we: daysText(week, 5, 6) });
    }
    var w0 = [];
    for (var q = 0; q < 7; q++) w0.push(dayHours(initial, q));
    var uniform = w0[0] && w0.slice(0, 5).every(function (x) { return x === w0[0]; });
    // The baseline weekday cell is plain hours when all five weekdays agree.
    return { days: days, hasInitial: Object.keys(initial).length > 0, wd0: uniform ? w0[0] : daysText(w0, 0, 4), we0: daysText(w0, 5, 6) };
  }

  // --- set points --------------------------------------------------------------------------------
  function num(x) {
    return String(Math.round(parseFloat(x) * 10) / 10);
  }
  // zone events: { "<loc>": { H:[[iso,from,to]], C:[...] } }
  function setPointEvents(evs) {
    var zones = {};
    evs.forEach(function (e) {
      e.details.split('\n').forEach(function (ln) {
        var m = ln.match(/\S*\/(occupied_heating|occupied_cooling) changed from "([\d.]+)" to "([\d.]+)"/);
        if (!m) return;
        var z = (zones[e.loc] = zones[e.loc] || { H: [], C: [] });
        z[m[1] === 'occupied_heating' ? 'H' : 'C'].push([e.iso, num(m[2]), num(m[3])]);
      });
    });
    return zones;
  }
  function valueAt(list, endIso) {
    var v = list[0][1];
    for (var i = 0; i < list.length; i++) if (list[i][0] <= endIso) v = list[i][2];
    return v;
  }
  function modeOf(pairs) {
    var order = [];
    var cnt = {};
    pairs.forEach(function (p) {
      if (!(p in cnt)) {
        cnt[p] = 0;
        order.push(p);
      }
      cnt[p]++;
    });
    var best = order[0];
    order.forEach(function (p) {
      if (cnt[p] > cnt[best]) best = p;
    });
    return best;
  }
  function spText(pair) {
    var p = pair.split('/');
    return 'heating ' + p[0] + ', cooling ' + p[1];
  }
  // { base:'68/72', days:[{ymd, pair}] } or null when no zone has both points.
  function setPointDays(zones, wFrom, wTo) {
    var names = Object.keys(zones)
      .filter(function (z) { return zones[z].H.length && zones[z].C.length; })
      .sort();
    if (!names.length) return null;
    var base = modeOf(names.map(function (z) { return zones[z].H[0][1] + '/' + zones[z].C[0][1]; }));
    var days = [];
    for (var d = wFrom; d <= wTo; d = addDays(d, 1)) {
      var end = d + 'T23:59:59';
      days.push({
        ymd: d,
        pair: modeOf(names.map(function (z) { return valueAt(zones[z].H, end) + '/' + valueAt(zones[z].C, end); })),
      });
    }
    return { base: base, days: days };
  }

  // --- runs --------------------------------------------------------------------------------------
  // [{ymd, text}] -> [{text, from, to}] with equal neighbours joined.
  function runs(list) {
    var out = [];
    list.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && last.text === x.text) last.to = x.ymd;
      else out.push({ text: x.text, from: x.ymd, to: x.ymd });
    });
    return out;
  }

  // --- the whole analysis ------------------------------------------------------------------------
  // events from parseRows (one or many files joined). Returns [{ building, window:[from,to], record }] by building name.
  function analyze(allEvents) {
    var evs = sortEvents(allEvents);
    var byB = {};
    var order = [];
    evs.forEach(function (e) {
      if (!byB[e.building]) {
        byB[e.building] = [];
        order.push(e.building);
      }
      byB[e.building].push(e);
    });
    var out = [];
    order.forEach(function (b) {
      var list = byB[b];
      var sevs = scheduleEvents(list);
      var zones = setPointEvents(list);
      var hasSp = Object.keys(zones).some(function (z) { return zones[z].H.length && zones[z].C.length; });
      if (!sevs.length && !hasSp) return; // nothing this module reads: the building gets no record
      var wFrom = list[0].ymd;
      var wTo = list[list.length - 1].ymd;
      var sch = scheduleDays(sevs, wFrom, wTo);
      var sp = setPointDays(zones, wFrom, wTo);
      var rec = {
        building: b,
        baselineWeekday: [{ text: sch.hasInitial ? sch.wd0 : NOT_FOUND, src: AUTO }],
        weekday: runs(sch.days.map(function (d) { return { ymd: d.ymd, text: d.wd }; })),
        weekend: [{ kind: 'baseline', text: sch.hasInitial ? sch.we0 : NOT_FOUND, src: AUTO }].concat(
          runs(sch.days.map(function (d) { return { ymd: d.ymd, text: d.we }; })).map(function (r) {
            return { kind: 'period', text: r.text, from: r.from, to: r.to };
          }),
        ),
        setPoints: sp
          ? [{ kind: 'baseline', text: spText(sp.base), src: AUTO }].concat(
              runs(sp.days.map(function (d) { return { ymd: d.ymd, text: spText(d.pair) }; })).map(function (r) {
                return { kind: 'period', text: r.text, from: r.from, to: r.to };
              }),
            )
          : [
              { kind: 'baseline', text: NOT_FOUND, src: AUTO },
              { kind: 'period', text: NO_SETPOINTS, from: wFrom, to: wTo },
            ],
      };
      if (!sch.hasInitial && !sevs.length) {
        // no schedule row at all: say so for the periods too
        rec.weekday = [{ text: NOT_FOUND, from: wFrom, to: wTo }];
        rec.weekend = [{ kind: 'baseline', text: NOT_FOUND, src: AUTO }, { kind: 'period', text: NOT_FOUND, from: wFrom, to: wTo }];
      }
      out.push({ building: b, window: [wFrom, wTo], record: rec });
    });
    return out;
  }

  // --- merging into the stored record ------------------------------------------------------------
  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  // The project building the log building belongs to: same name, else the one name that starts with the other.
  function matchName(logName, projectNames) {
    var n = norm(logName);
    var list = projectNames || [];
    var exact = list.filter(function (p) { return norm(p) === n; });
    if (exact.length === 1) return exact[0];
    var near = list.filter(function (p) {
      var q = norm(p);
      return q.indexOf(n + ' ') === 0 || n.indexOf(q + ' ') === 0;
    });
    return near.length === 1 ? near[0] : logName;
  }
  // Entries of a list with the days inside [a, b] cut out. An entry with no dates (baseline) is kept.
  function cutWindow(list, a, b) {
    var out = [];
    (list || []).forEach(function (e) {
      if (!e.from && !e.to) return out.push(e);
      var to = e.to || '9999-12-31';
      var from = e.from || '0000-01-01';
      if (to < a || from > b) return out.push(e);
      if (from < a) out.push(Object.assign({}, e, { to: addDays(a, -1) }));
      if (to > b) out.push(Object.assign({}, e, { from: addDays(b, 1) }));
    });
    return out;
  }
  function joinRuns(list) {
    var dated = list
      .filter(function (e) { return e.from || e.to; })
      .sort(function (x, y) { return (x.from || '') < (y.from || '') ? -1 : (x.from || '') > (y.from || '') ? 1 : 0; });
    var out = [];
    dated.forEach(function (e) {
      var last = out[out.length - 1];
      if (last && last.text === e.text && last.kind === e.kind && last.to && e.from && addDays(last.to, 1) === e.from) last.to = e.to;
      else out.push(Object.assign({}, e));
    });
    return out;
  }
  // The base entries: a baseline a person typed is kept; one this module wrote is replaced unless the new one says "not found".
  function pickBase(oldList, newBase) {
    var old = (oldList || []).filter(function (e) { return !e.from && !e.to; });
    var typed = old.filter(function (e) { return e.src !== AUTO; });
    if (typed.length) return typed;
    if (newBase && newBase.text === NOT_FOUND && old.length) return old;
    return newBase ? [newBase] : old;
  }
  // existing = the stored record or null. results = analyze(...). Returns { rec, matched:[{log, project}] }.
  // The stored days inside each building's window are replaced; days outside it stay. Applying the same results twice gives the same record.
  function apply(existing, results, projectNames) {
    var rec = { version: 1, buildings: existing && Array.isArray(existing.buildings) ? existing.buildings.slice() : [] };
    var matched = [];
    results.forEach(function (r) {
      var name = matchName(r.building, projectNames);
      matched.push({ log: r.building, project: name, inProject: name !== r.building || (projectNames || []).indexOf(name) >= 0 });
      var idx = -1;
      rec.buildings.forEach(function (b, i) { if (b && b.building === name) idx = i; });
      var old = idx >= 0 ? rec.buildings[idx] : {};
      var a = r.window[0];
      var z = r.window[1];
      var n = r.record;
      var merged = {
        building: name,
        baselineWeekday: pickBase(old.baselineWeekday, n.baselineWeekday[0]),
        weekday: joinRuns(cutWindow(old.weekday, a, z).concat(n.weekday)),
        weekend: pickBase(old.weekend, n.weekend[0]).map(function (e) { return Object.assign({ kind: 'baseline' }, e); }).concat(
          joinRuns(cutWindow(old.weekend, a, z).concat(n.weekend.slice(1))),
        ),
        setPoints: pickBase(old.setPoints, n.setPoints[0]).map(function (e) { return Object.assign({ kind: 'baseline' }, e); }).concat(
          joinRuns(cutWindow(old.setPoints, a, z).concat(n.setPoints.slice(1))),
        ),
      };
      if (idx >= 0) rec.buildings[idx] = merged;
      else rec.buildings.push(merged);
    });
    return { rec: rec, matched: matched };
  }

  var api = {
    NOT_FOUND: NOT_FOUND,
    NO_SETPOINTS: NO_SETPOINTS,
    parseRows: parseRows,
    analyze: analyze,
    apply: apply,
    matchName: matchName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasAuditLog = api;
})(typeof window !== 'undefined' ? window : this);
