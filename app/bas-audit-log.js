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
//   - Baseline columns: the Set Points sheet import (app/bas-baseline.js) is the source. This module writes a baseline
//     entry only as a fallback, marked with its source: the earliest values in the log (old value of the first change;
//     for a building with no set point change in the log, the stored points list value). It replaces only entries that
//     carry one of its own marks; the sheet import replaces them too. A value with no source is left out; the report
//     prints a plain dash for an empty cell. Nothing is invented.
// Stored events (en_bas_auditevents_<pid>): { version:2, lastDay, locs, events:[[iso,kind,locIndex,text,operatorHash]], ops:{ operatorHash: name } }.
//   ops is written by mergeStore from the imported rows (a store made before names were kept has none; importing the file again adds them).
//   changeList(store, { today, days }) is the one reader for the Calendar tab (BAS changes, app/project-calendar.js): newest first, in words.
// Output record: { version:1, buildings:[{ building, baselineWeekday:[{text}], weekday:[{text,from,to}],
//   weekend:[{kind,text,from,to}], setPoints:[{kind,text,from,to}] }] }  (from, to are YYYY-MM-DD).
(function (root) {
  'use strict';

  var BD = root.BasDiff || (typeof require === 'function' ? require('./bas-diff.js') : null);
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var AUDIT_SRC = 'WebCTRL audit log (earliest values)';
  var POINTS_SRC = 'WebCTRL points list (no set point change in the audit log)';
  var HEAD = ['date', 'description', 'details', 'location', 'operator'];

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
    // Columns are found by header name. The scheduled report adds a sixth column (Reason); a manual export has five.
    var col = {};
    HEAD.forEach(function (h) { col[h] = head.indexOf(h); });
    if (HEAD.some(function (h) { return col[h] < 0; })) {
      return { error: 'This is not a WebCTRL audit log. The first row must have these columns: Date, Description, Details, Location, Operator.' };
    }
    var events = [];
    var lastDay = '';
    rows2d.slice(1).forEach(function (r) {
      var iso = r.length > col.operator ? isoOf(r[col.date]) : null;
      if (!iso) return;
      if (iso.slice(0, 10) > lastDay) lastDay = iso.slice(0, 10);
      events.push({ iso: iso, ymd: iso.slice(0, 10), desc: String(r[col.description]), details: String(r[col.details]), loc: String(r[col.location]).trim(), op: String(r[col.operator]), building: BD.buildingOf(r[col.location]) });
    });
    events.reverse(); // the export is newest first
    return { events: events, lastDay: lastDay };
  }
  // Reads a whole pick. files = [{name, text}], split = baSplitCSV. A file that cannot be read is skipped and named;
  // the others are read as before. noDay = readable files with no dated row (the day cannot be known from the file).
  // Returns { events, lastDay, good, skipped:[{name, reason}], noDay:[name], note } ; note is one message ('' when nothing to tell).
  // One message for the files a pick could not read (also used by the baseline import). skipped = [{name, reason}].
  function skipNote(skipped) {
    if (!skipped || !skipped.length) return '';
    return 'Skipped ' + skipped.length + ' file' + (skipped.length === 1 ? '' : 's') + ': ' + skipped.map(function (s) { return s.name + ' (' + s.reason + ')'; }).join('; ') + '.';
  }
  function readFiles(files, split) {
    var out = { events: [], lastDay: '', good: 0, skipped: [], noDay: [], note: '' };
    (files || []).forEach(function (f) {
      var r = parseRows(split(f.text || ''));
      if (r.error) {
        out.skipped.push({ name: f.name, reason: r.error });
        return;
      }
      out.good++;
      out.events = out.events.concat(r.events);
      if (r.lastDay) {
        if (r.lastDay > out.lastDay) out.lastDay = r.lastDay;
      } else out.noDay.push(f.name);
    });
    var parts = [];
    if (out.skipped.length) parts.push(skipNote(out.skipped));
    if (out.noDay.length) parts.push('No dated rows, so the last day was not moved: ' + out.noDay.join(', ') + '.');
    out.note = parts.join(' ');
    return out;
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
  // pointsList = [{ building, text }] set points of the equipment in the stored WebCTRL points list (the Equipment Matrix),
  // used only for a building whose log has no occupied set point row: the value never changed since the log starts.
  // --- event store -------------------------------------------------------------------------------
  // A scheduled report file covers one day. The site keeps every schedule and set point event it has read (the store,
  // en_bas_auditevents_<pid>) and rebuilds the history from ALL of them, so the files can come in any order and may overlap.
  // The store keeps only what the rebuild reads: store = { version:2, lastDay:'YYYY-MM-DD', locs:[location,...],
  // events:[[iso, kind, locIndex, text, operatorHash], ...] } oldest first. kind: A/U/D = Add/Update/Delete schedule
  // (text = the schedule lines the reader uses), S = set point change (text = "H from to" / "C from to" lines).
  // STORE_WARN_BYTES: 6 audit logs of one district (12 months, 2325 events) measured 178 KB in this format (630 KB before compaction),
  // so about 180 KB a year. The browser store holds about 5 MB for the whole site; 1 MB is about 5 years of this one key.
  // Above 1 MB the card says so. Nothing is ever pruned.
  var STORE_WARN_BYTES = 1048576;
  var SP_LINE = /\S*\/(occupied_heating|occupied_cooling) changed from "([\d.]+)" to "([\d.]+)"/;
  var KEEP_LINE = /schedule "|^Type "|days:|^At "|^New values:/;
  var KIND_DESC = { A: 'Add schedule', U: 'Update schedule', D: 'Delete schedule' };
  function opHash(op) {
    var h = 5381;
    String(op).split('').forEach(function (c) { h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; });
    return h.toString(36);
  }
  // The part of an event the history uses, or null (alarm acknowledgements and all other rows are not stored).
  function compact(e) {
    var m = e.desc.match(/^(Add|Update|Delete) schedule\b/);
    if (m) {
      var keep = e.details.split('\n').filter(function (ln) { return KEEP_LINE.test(ln); });
      return { iso: e.iso, kind: m[1].charAt(0), loc: e.loc, text: keep.join('\n'), oh: opHash(e.op) };
    }
    var lines = [];
    e.details.split('\n').forEach(function (ln) {
      var p = ln.match(SP_LINE);
      if (p) lines.push((p[1] === 'occupied_heating' ? 'H ' : 'C ') + p[2] + ' ' + p[3]);
    });
    return lines.length ? { iso: e.iso, kind: 'S', loc: e.loc, text: lines.join('\n'), oh: opHash(e.op) } : null;
  }
  function mergeStore(store, events, lastDay) {
    var locs = (store && store.locs) || [];
    var old = ((store && store.events) || []).map(function (t) {
      return { iso: t[0], kind: t[1], loc: locs[t[2]], text: t[3], oh: t[4] };
    });
    var seen = {};
    var all = [];
    // Operator names by hash. A stored event keeps only the hash; this small table (one entry for each person) turns it back into the name.
    var ops = {};
    Object.keys((store && store.ops) || {}).forEach(function (h) { ops[h] = store.ops[h]; });
    var fresh = [];
    events.forEach(function (e) {
      var c = compact(e);
      if (!c) return;
      fresh.push(c);
      var nm = String(e.op || '').trim();
      if (nm) ops[c.oh] = nm;
    });
    old.concat(fresh).forEach(function (e) {
      var k = [e.iso, e.loc, e.text, e.oh].join('|');
      if (seen[k]) return;
      seen[k] = true;
      all.push(e);
    });
    all = sortEvents(all);
    var outLocs = [];
    var idx = {};
    var rows = all.map(function (e) {
      if (idx[e.loc] === undefined) {
        idx[e.loc] = outLocs.length;
        outLocs.push(e.loc);
      }
      return [e.iso, e.kind, idx[e.loc], e.text, e.oh];
    });
    var ld = (store && store.lastDay) || '';
    if ((lastDay || '') > ld) ld = lastDay;
    var out = { version: 2, lastDay: ld, locs: outLocs, events: rows };
    if (Object.keys(ops).length) out.ops = ops;
    return out;
  }
  // The stored events as the reader wants them (same shape parseRows gives).
  function storeEvents(store) {
    var locs = (store && store.locs) || [];
    return ((store && store.events) || []).map(function (t) {
      var loc = locs[t[2]];
      var details = t[3];
      if (t[1] === 'S') {
        details = t[3].split('\n').map(function (ln) {
          var p = ln.split(' ');
          return 'x/' + (p[0] === 'H' ? 'occupied_heating' : 'occupied_cooling') + ' changed from "' + p[1] + '" to "' + p[2] + '"';
        }).join('\n');
      }
      return { iso: t[0], ymd: t[0].slice(0, 10), desc: KIND_DESC[t[1]] || 'Set point change', details: details, loc: loc, building: BD.buildingOf(loc) };
    });
  }

  // --- the change list the Calendar tab shows (BAS changes) --------------------------------------------------
  // One stored schedule block as words: 'Gym: Mon Tue Wed, occupied 6:00 AM to 4:00 PM'.
  function blockText(b) {
    var hrs = b.iv.length ? 'occupied ' + b.iv.map(function (x) { return BD.clock(x[0]) + ' to ' + BD.clock(x[1]); }).join(' and ') : 'no occupied hours';
    return b.name + ': ' + (b.days.length ? b.days.join(' ') : 'no days') + ', ' + hrs;
  }
  // The words for one stored schedule event (kind A, U or D) from its kept text.
  function scheduleText(kind, text) {
    var nm = String(text).match(/schedule "([^"]*)"/);
    var fallback = nm ? 'Schedule ' + nm[1] : 'Schedule';
    if (kind === 'U') {
      var j = text.indexOf('New values:');
      var o = j < 0 ? null : parseBlock(text.slice(0, j));
      var n = j < 0 ? null : parseBlock(text.slice(j));
      return o && n ? blockText(o) + ' \u2192 ' + blockText(n) : fallback;
    }
    var b = parseBlock(text);
    return b ? blockText(b) : fallback;
  }
  var KIND_TYPE = { A: 'Schedule added', U: 'Schedule changed', D: 'Schedule deleted', S: 'Set point' };
  // The Weekly block an added or changed schedule has AFTER the edit ({ name, days, iv } from parseBlock), else null
  // (deleted, set point, or a schedule type that is not Weekly). The Calendar "What needs to change" card reads it to see if an edit spans an event.
  function newBlockOf(kind, text) {
    if (kind === 'A') return parseBlock(text);
    if (kind !== 'U') return null;
    var j = text.indexOf('New values:');
    return j < 0 ? null : parseBlock(text.slice(j));
  }
  // 'Occupied heating 63\u00B0F \u2192 66\u00B0F; Occupied cooling 68\u00B0F \u2192 73\u00B0F' from the stored lines 'H 63 66' and 'C 68 73'.
  function setPointWords(text) {
    return String(text).split('\n').map(function (ln) {
      var p = ln.split(' ');
      return (p[0] === 'H' ? 'Occupied heating ' : 'Occupied cooling ') + p[1] + '\u00B0F \u2192 ' + p[2] + '\u00B0F';
    }).join('; ');
  }
  // The schedule and set point events of a stored audit log, newest first, for the Calendar tab.
  // opts.today (YYYY-MM-DD) with opts.days gives the range: events on or after today minus days. No days = every stored event.
  // Returns { has, lastDay, total, rows:[{ iso, ymd, type, building, area, what, operator, block }] }. block = newBlockOf (schedule added or changed, else null). has is false when nothing was imported.
  // operator is '' when the stored log came from an import made before names were kept (import the file again).
  function changeList(store, opts) {
    var o = opts || {};
    if (!store || !store.events || !store.events.length) return { has: false, lastDay: '', total: 0, rows: [] };
    var locs = store.locs || [];
    var ops = store.ops || {};
    var from = o.days && o.today ? addDays(o.today, -o.days) : '';
    var rows = [];
    store.events.forEach(function (t) {
      if (from && t[0].slice(0, 10) < from) return;
      var loc = locs[t[2]];
      rows.push({
        iso: t[0],
        ymd: t[0].slice(0, 10),
        type: KIND_TYPE[t[1]] || 'Set point',
        building: BD.buildingOf(loc),
        area: BD.areaOf(loc),
        what: t[1] === 'S' ? setPointWords(t[3]) : scheduleText(t[1], t[3]),
        operator: ops[t[4]] || '',
        block: newBlockOf(t[1], t[3]),
      });
    });
    rows.reverse(); // the store is oldest first
    return { has: true, lastDay: store.lastDay || '', total: store.events.length, rows: rows };
  }
  // Size of the stored blob in bytes, and the card warning text when it passes STORE_WARN_BYTES ('' otherwise).
  function storeSize(store) {
    return JSON.stringify(store).length;
  }
  function storeWarning(store) {
    var n = storeSize(store);
    return n > STORE_WARN_BYTES
      ? ' The stored audit log events are ' + Math.round(n / 1024) + ' KB. This is large; tell the site owner before importing more.'
      : '';
  }
  function analyze(allEvents, pointsList, endDay) {
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
    // The last run of every building ends on the latest day of the whole export, so a state still in effect is not cut short.
    var lastDay = evs.length ? evs[evs.length - 1].ymd : '';
    if (endDay && endDay > lastDay) lastDay = endDay;
    var pointMap = resolveNames(order, (pointsList || []).map(function (x) { return x.building; }));
    order.forEach(function (b) {
      var list = byB[b];
      var sevs = scheduleEvents(list);
      var zones = setPointEvents(list);
      var hasSp = Object.keys(zones).some(function (z) { return zones[z].H.length && zones[z].C.length; });
      if (!sevs.length && !hasSp) return; // nothing this module reads: the building gets no record
      var wFrom = list[0].ymd;
      var wTo = lastDay;
      var sch = scheduleDays(sevs, wFrom, wTo);
      var sp = setPointDays(zones, wFrom, wTo);
      var period = function (list) {
        return runs(list).map(function (r) {
          return { kind: 'period', text: r.text, from: r.from, to: r.to };
        });
      };
      var fb = null;
      if (!sp && pointsList && pointsList.length) {
        var pointsBuilding = pointMap.map[b];
        fb = pointsList.filter(function (x) { return x.building === pointsBuilding; })[0] || null;
      }
      var baseline = {
        // Earliest values in the log: the old values of the first change of each schedule, the old value of the first
        // change of each zone set point, or (no set point change in the log) the stored points list value.
        weekday: sch.hasInitial ? { text: sch.wd0, src: AUDIT_SRC, windowStart: wFrom } : null,
        weekend: sch.hasInitial ? { kind: 'baseline', text: sch.we0, src: AUDIT_SRC, windowStart: wFrom } : null,
        setPoints: sp ? { kind: 'baseline', text: spText(sp.base), src: AUDIT_SRC, windowStart: wFrom } : fb ? { kind: 'baseline', text: fb.text, src: POINTS_SRC, windowStart: wFrom } : null,
      };
      var rec = {
        building: b,
        weekday: sevs.length ? runs(sch.days.map(function (d) { return { ymd: d.ymd, text: d.wd }; })) : [],
        weekend: sevs.length ? period(sch.days.map(function (d) { return { ymd: d.ymd, text: d.we }; })) : [],
        setPoints: sp
          ? period(sp.days.map(function (d) { return { ymd: d.ymd, text: spText(d.pair) }; }))
          : fb
            ? [{ kind: 'period', text: fb.text, from: wFrom, to: wTo, src: POINTS_SRC }]
            : [],
      };
      out.push({ building: b, window: [wFrom, wTo], record: rec, baseline: baseline });
    });
    return out;
  }

  // --- merging into the stored record ------------------------------------------------------------
  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  // Which project building each log building belongs to: { map:{ logName: projectName | null }, unmatched:[logName] }.
  // An exact name (case and spacing ignored) wins. A name that only starts with the other ("X Elementary" for "X Elementary
  // School") is accepted only when it is the one candidate AND no other log building could map to the same project building.
  // Anything else is null: the building is not imported and the caller says so. No project list: names are kept as they are.
  function resolveNames(logNames, projectNames) {
    var map = {};
    var unmatched = [];
    var list = projectNames || [];
    if (!list.length) {
      logNames.forEach(function (n) { map[n] = n; });
      return { map: map, unmatched: unmatched };
    }
    var exactOf = function (n) { return list.filter(function (p) { return norm(p) === norm(n); }); };
    var nearOf = function (n) {
      var a = norm(n);
      return list.filter(function (p) {
        var q = norm(p);
        return q.indexOf(a + ' ') === 0 || a.indexOf(q + ' ') === 0;
      });
    };
    var claims = function (n) { return exactOf(n).concat(nearOf(n)); };
    logNames.forEach(function (n) {
      var ex = exactOf(n);
      var pick = null;
      if (ex.length === 1) pick = ex[0];
      else if (!ex.length) {
        var near = nearOf(n);
        if (near.length === 1) {
          var rivals = logNames.filter(function (o) {
            return norm(o) !== norm(n) && claims(o).indexOf(near[0]) >= 0;
          });
          if (!rivals.length) pick = near[0];
        }
      }
      map[n] = pick;
      if (!pick) unmatched.push(n);
    });
    return { map: map, unmatched: unmatched };
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
  // existing = the stored record or null. results = analyze(...). Returns { rec, matched:[{log, project}] }.
  // The stored days inside each building's window are replaced; days outside it stay. Applying the same results twice gives the same record.
  function apply(existing, results, projectNames) {
    var rec = { version: 1, buildings: existing && Array.isArray(existing.buildings) ? existing.buildings.slice() : [] };
    var matched = [];
    var names = resolveNames(results.map(function (r) { return r.building; }), projectNames);
    results.forEach(function (r) {
      var name = names.map[r.building];
      matched.push({ log: r.building, project: name });
      if (!name) return;
      var idx = -1;
      rec.buildings.forEach(function (b, i) { if (b && b.building === name) idx = i; });
      var old = idx >= 0 ? rec.buildings[idx] : {};
      var a = r.window[0];
      var z = r.window[1];
      var n = r.record;
      // An auto baseline is replaced by one whose log starts at the same day or EARLIER (the rebuild covers all stored events), so the order of
      // imports does not matter. One typed by a person (no mark) is never replaced and stays beside an auto one.
      var base = function (list, entry) {
        var oldBase = (list || []).filter(function (e) { return !e.from && !e.to; });
        var auto = oldBase.every(function (e) { return e.src === AUDIT_SRC || e.src === POINTS_SRC; });
        if (!entry || !auto) return oldBase;
        // Every import is a rebuild from the full store, so an equal window start also takes the newer result.
        var earlier = oldBase.some(function (e) { return !e.windowStart || entry.windowStart <= e.windowStart; });
        return !oldBase.length || earlier ? [entry] : oldBase;
      };
      var merged = Object.assign({ building: '', baselineWeekday: [], weekday: [], weekend: [], setPoints: [] }, old, {
        building: name,
        baselineWeekday: base(old.baselineWeekday, r.baseline && r.baseline.weekday),
        weekday: joinRuns(cutWindow(old.weekday, a, z).concat(n.weekday)),
        weekend: base(old.weekend, r.baseline && r.baseline.weekend).concat(joinRuns(cutWindow(old.weekend, a, z).concat(n.weekend))),
        setPoints: base(old.setPoints, r.baseline && r.baseline.setPoints).concat(joinRuns(cutWindow(old.setPoints, a, z).concat(n.setPoints))),
      });
      if (idx >= 0) rec.buildings[idx] = merged;
      else rec.buildings.push(merged);
    });
    return { rec: rec, matched: matched };
  }

  var api = {
    parseRows: parseRows,
    readFiles: readFiles,
    skipNote: skipNote,
    analyze: analyze,
    apply: apply,
    resolveNames: resolveNames,
    mergeStore: mergeStore,
    storeSize: storeSize,
    storeWarning: storeWarning,
    storeEvents: storeEvents,
    changeList: changeList,
    AUDIT_SRC: AUDIT_SRC,
    POINTS_SRC: POINTS_SRC,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasAuditLog = api;
})(typeof window !== 'undefined' ? window : this);
