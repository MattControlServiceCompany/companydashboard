// computations/sched-actions.js
//
// The ONE place that builds the "What needs to change" list of the District Calendar tab, keeps each action's
// Open / Done / Closed status, and finds BAS-side waste. The coverage decision itself is BasCoverage.eventCoverage
// (computations/bas-coverage.js); nothing here repeats it. app/sched-actions.js only draws the result and saves it.
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
// todoView is the To do card of the District Calendar tab: the rows are the events BasCoverage.coverageOf says need a WebCTRL change.
//
// Stored (key en_sched_actions_<pid>, class SYNCED):
//   { actions:{ "<event id>": { id, date, text, program, status:'open'|'done'|'closed', openedAt, doneBy, doneAt, closedAt, note } } }
// An action exists only for a Not covered event (status "short"). Serving units are never checked, so they never make one.
//
//   computeActions(o)  o = { events, map, snaps, groups, tz, today, scheduleEdits }          -> [action] newest event first
//   reconcile(o)       o = computeActions input + { stored, now, latestImport } -> { stored, changes:[{id,text,what}] }
//   latestImport(snaps, calFetchedAt) -> newest BAS import or calendar sync time
//   setStatus(stored, id, status, who, now) -> { stored, changes }
//   periodUnknown(o) -> events a group with no saved rooms may cover (not a to-do)
//   todoView(o)        o = periodView input + { stored, now } -> { todo, done, covered, optional, later, status }
//   wasteFindings(o)   o = { events, map, snaps, groups, tz, today }          -> [finding]
//   historyRecord(changes, at, by, id)  -> one en_bas_hist record (kind 'action')
(function (root) {
  'use strict';

  var CD = typeof require === 'function' && typeof module !== 'undefined' ? require('../app/calendar-diff.js') : root.CalendarDiff;
  var BD = typeof require === 'function' && typeof module !== 'undefined' ? require('../app/bas-diff.js') : root.BasDiff;
  var BC = typeof require === 'function' && typeof module !== 'undefined' ? require('./bas-coverage.js') : root.BasCoverage;

  var WASTE_MIN = 1380; // a program occupied at least 23 hours of the day counts as occupied all day
  var WASTE_DAYS = 7; // saved BAS days older than this many days are not checked for waste
  var CLOSED_KEEP_DAYS = 30; // a closed action is kept this many days after its event date

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function programName(key) {
    return BD.splitKey(key).program.replace(/ #\d+$/, '');
  }

  // --- scheduling group of a program ----------------------------------------------------------
  // en_bas_groups_<pid>. The groups of a program are found by BasCoverage.groupsFor (the one membership rule; coverage uses it too).
  // A program can be in several groups. groupFor returns the name of the first one (a group that lists the program) or ''.
  function groupFor(groups, key) {
    return BC.groupFor(groups, key);
  }

  // The schedules saved for the scheduling groups of a program, as plain text ('' when none was read): 'LRC Volleyball Games, Mon,Tue,Wed,Thu, 4:00 PM-10:00 PM'.
  // The text is BasDiff.scheduleText (the one writer); a schedule with no day selected reads 'No days selected (not active)'.
  // With several groups, each group's schedules start with the group name.
  function groupScheduleText(groups, key) {
    var gs = BC.groupsFor(groups, key);
    return gs
      .map(function (g) {
        var t = (g.schedules || []).map(BD.scheduleText).join('; ');
        return gs.length > 1 ? g.group + ': ' + t : t;
      })
      .join(' | ');
  }
  // 'AREA 'F' SUMMARY' -> 'Area F'. Any other area text stays as it is.
  function areaName(area) {
    return String(area || '')
      .split(' / ')
      .map(function (a) {
        var m = /^area\s+'?([^']+?)'?\s+summary$/i.exec(a.trim());
        return m ? 'Area ' + m[1] : a;
      })
      .join(' / ');
  }
  // 'Middle School / Area C / Gym East AHU-4 RF-14': where in WebCTRL a program lives (building / area / program, from BasDiff.buildingOf and areaOf).
  function whereText(key) {
    var p = BD.splitKey(key);
    return [BD.buildingOf(p.location), areaName(BD.areaOf(p.location)), programName(key)].filter(Boolean).join(' / ');
  }

  // --- room number -> Area --------------------------------------------------------------------
  // A calendar event that names "Room 114" or "Rm 107" in its title or location: the programs of its building named "Room <letter><number>"
  // with that number say which Area the room is in. -> ['Room 114 = Area F (Room F114)'], several matches listed with ' or '.
  // Programs come from the BAS copy for the event date and (optional o.matrixRooms [{ location, name }], the Equipment Matrix rows).
  var ROOM_NO = /\b(?:class)?(?:room|rm)\.?\s*#?\s*(\d{1,4})\b/gi;
  var ROOM_NAME = /^room\s+[a-z]0*(\d+)(?:\s|$)/i;
  function roomLines(o, rows) {
    var out = [];
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations };
    (rows || []).forEach(function (row) {
      if (!row) return;
      var nums = [];
      var m;
      ROOM_NO.lastIndex = 0;
      while ((m = ROOM_NO.exec(String(row[0] || '') + ' ' + String(row[4] || '')))) {
        var n = String(+m[1]);
        if (nums.indexOf(n) === -1) nums.push(n);
      }
      if (!nums.length) return;
      var c = BC.eventCoverage(row, ctx);
      var snap = row[1] ? BC.snapshotForDate(o.snaps, CD.calendarDay(row[1], o.tz)) : null;
      var progs = [];
      Object.keys((snap && snap.rows) || {}).forEach(function (k) {
        var p = BD.splitKey(k);
        progs.push({ location: p.location, name: programName(k) });
      });
      (o.matrixRooms || []).forEach(function (r) {
        progs.push({ location: r.location, name: r.name });
      });
      var building = c.keys && c.keys.length ? BD.keyBuilding(c.keys[0]) : BC.buildingOfPlace(c.space, Object.keys((snap && snap.rows) || {}));
      if (!building) return;
      nums.forEach(function (num) {
        var seen = {};
        var hits = [];
        progs.forEach(function (p) {
          var r = ROOM_NAME.exec(String(p.name || '').trim());
          if (!r || String(+r[1]) !== num || norm(BD.buildingOf(p.location)) !== norm(building)) return;
          var k = norm(BD.areaOf(p.location)) + '|' + norm(p.name);
          if (seen[k]) return;
          seen[k] = 1;
          hits.push((areaName(BD.areaOf(p.location)) ? areaName(BD.areaOf(p.location)) + ' ' : '') + '(' + p.name + ')');
        });
        if (hits.length) {
          var text = 'Room ' + num + ' = ' + hits.join(' or ');
          if (out.indexOf(text) === -1) out.push(text);
        }
      });
    });
    return out;
  }

  // --- the action list ------------------------------------------------------------------------
  function rangeText(g) {
    return BD.clock(g[0]) + ' - ' + BD.clock(g[1] >= 1440 ? 0 : g[1]);
  }
  // 'Fri Oct 30'
  function dayText(ymd) {
    return CD.dayLabel(ymd).replace(',', '');
  }
  function and(list) {
    return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  // Merge spans [[a,b]] (minutes of a day) that overlap or touch: [[a,b]] sorted.
  function mergeSpans(list) {
    var out = [];
    list
      .slice()
      .sort(function (x, y) {
        return x[0] - y[0];
      })
      .forEach(function (g) {
        var last = out[out.length - 1];
        if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
        else out.push([g[0], g[1]]);
      });
    return out;
  }
  function spansText(spans) {
    return and(spans.map(rangeText));
  }
  // 'Fri Oct 30', or 'Mon/Wed Nov 3 - Nov 24 (6 dates)' for several dates (ascending YYYY-MM-DD)
  function whenText(dates) {
    if (dates.length < 2) return dayText(dates[0]);
    var days = [];
    dates.forEach(function (d) {
      var w = dayText(d).split(' ')[0];
      if (days.indexOf(w) === -1) days.push(w);
    });
    var order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    days.sort(function (x, y) {
      return order.indexOf(x) - order.indexOf(y);
    });
    var md = function (d) {
      return dayText(d).split(' ').slice(1).join(' ');
    };
    return days.join('/') + ' ' + md(dates[0]) + ' - ' + md(dates[dates.length - 1]) + ' (' + dates.length + ' dates)';
  }
  function uniq(list) {
    return list.filter(function (x, i) {
      return list.indexOf(x) === i;
    });
  }
  function titlesText(titles) {
    var t = uniq(titles);
    return t.length > 3 ? t.slice(0, 3).join(', ') + ' and ' + (t.length - 3) + ' more' : and(t);
  }
  // The status words of a line the audit log shows as added: 'Added in WebCTRL on Fri Nov 13, 2026 by Test Operator; the saved BAS schedule does not show it yet'.
  function webctrlText(w) {
    return 'Added in WebCTRL on ' + BD.dateText(w.ymd) + (w.operator ? ' by ' + w.operator : '') + '; the saved BAS schedule does not show it yet';
  }
  // One line = one BAS unit (its scheduling group, else its program) x one set of uncovered spans, over every date and event
  // that needs it. Events in one unit on one day merge: overlapping or touching uncovered spans become one span. Days with the
  // same merged spans join into one line.
  function computeActions(o) {
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations, scheduleEdits: o.scheduleEdits };
    var units = {};
    Object.keys(o.events || {}).forEach(function (id) {
      var row = o.events[id];
      if (!row || !row[1]) return;
      var date = CD.calendarDay(row[1], o.tz);
      if (date < o.today) return;
      var c = BC.coverageOf(row, ctx);
      if (c.status !== 'short') return;
      var group = groupFor(o.groups, c.program);
      var webctrl = c.edit;
      var uk = (group ? BD.keyBuilding(c.program) + '|' + group : c.program) + (webctrl ? '|webctrl' : '');
      var u = (units[uk] = units[uk] || { key: uk, group: group, days: {} });
      var d = (u.days[date] = u.days[date] || { spans: [], events: [], programs: [], short: 0 });
      d.spans = d.spans.concat(c.gaps);
      d.events.push({ id: id, title: row[0], space: c.space });
      d.programs.push(c.program);
      d.short += c.short;
      if (webctrl && (!d.webctrl || webctrl.ymd > d.webctrl.ymd)) d.webctrl = webctrl;
    });
    var out = [];
    Object.keys(units).forEach(function (uk) {
      var u = units[uk];
      var bySig = {};
      Object.keys(u.days).forEach(function (date) {
        var d = u.days[date];
        d.spans = mergeSpans(d.spans);
        var sig = d.spans.map(function (g) { return g[0] + '-' + g[1]; }).join(',');
        (bySig[sig] = bySig[sig] || []).push(date);
      });
      Object.keys(bySig).forEach(function (sig) {
        var dates = bySig[sig].sort();
        var ds = dates.map(function (x) { return u.days[x]; });
        var events = [].concat.apply([], ds.map(function (d) { return d.events; }));
        var programs = uniq([].concat.apply([], ds.map(function (d) { return d.programs; })));
        var names = uniq(programs.map(programName));
        var spans = ds[0].spans;
        var webctrl = ds.reduce(function (best, d) { return d.webctrl && (!best || d.webctrl.ymd > best.ymd) ? d.webctrl : best; }, null);
        var change = 'add ' + spansText(spans) + (u.group ? ' to group ' + u.group : '');
        out.push({
          change: change,
          webctrl: webctrl ? Object.assign({ text: webctrlText(webctrl) }, webctrl) : null,
          id: uk + '|' + sig,
          date: dates[dates.length - 1],
          dates: dates,
          start: dates[0],
          eventIds: events.map(function (e) { return e.id; }),
          title: titlesText(events.map(function (e) { return e.title; })),
          space: uniq(events.map(function (e) { return e.space; })).join(', '),
          program: programs[0],
          programs: programs,
          short: ds.reduce(function (n, d) { return n + d.short; }, 0),
          group: u.group,
          unit: u.group || names.join(', '),
          spans: spans,
          spanText: spansText(spans),
          titleText: titlesText(events.map(function (e) { return e.title; })),
          text:
            whenText(dates) + ' ' + titlesText(events.map(function (e) { return e.title; })) + ': ' +
            names.join(', ') + ' unoccupied ' + spansText(spans) +
            ' -> ' + change,
        });
      });
    });
    return out.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;
    });
  }

  // A schedule of the event's scheduling group that is saved but has no day selected (not active) and whose occupied periods span every
  // uncovered stretch: turning it on is easier than a new schedule. Returns { name, days:'Wed,Thu' } or null. dates = the dates of the line.
  function activateOption(o, a, dates) {
    var g = null;
    var hit = null;
    BC.groupsFor(o.groups, a.program).some(function (grp) {
      hit = (grp.schedules || []).filter(function (s) {
        if (BD.scheduleActive(s) || s.type === 'date' || s.type === 'recurring') return false;
        var occ = (s.periods || []).filter(function (p) { return p.mode === 'occ'; }).map(function (p) { return [p.from, p.to, 'occ']; });
        return occ.length && a.spans.every(function (sp) { return BC.minutesShort(occ, sp[0], sp[1]) === 0; });
      })[0];
      if (hit) g = grp;
      return !!hit;
    });
    if (!hit) return null;
    var days = uniq(dates.map(function (d) { return BD.weekdayOf(d); }));
    days.sort(function (x, y) { return WD_ORDER.indexOf(x) - WD_ORDER.indexOf(y); });
    return { name: hit.name, group: g.group, days: days.join(',') };
  }

  // --- the needs of one shown period ----------------------------------------------------------
  var WD_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Dates of one action that repeat: a weekday with 3 or more dates is a weekly pattern (one repeating schedule to add).
  // Returns { weekdays:[ 'Thu' ], dates:[repeating dates], rest:[other dates] }.
  function repeatOf(dates) {
    var byDay = {};
    dates.forEach(function (d) {
      var w = dayText(d).split(' ')[0];
      (byDay[w] = byDay[w] || []).push(d);
    });
    var out = { weekdays: [], dates: [], rest: [] };
    Object.keys(byDay).forEach(function (w) {
      if (byDay[w].length >= 3) {
        out.weekdays.push(w);
        out.dates = out.dates.concat(byDay[w]);
      } else out.rest = out.rest.concat(byDay[w]);
    });
    out.weekdays.sort(function (a, b) { return WD_ORDER.indexOf(a) - WD_ORDER.indexOf(b); });
    out.dates.sort();
    out.rest.sort();
    return out;
  }
  // The lines of "What needs to change" for the period [o.from, o.to]. An action is listed when at least one of its dates is in
  // the period, so a one-time need in December is not listed in a November week. A weekly pattern is one line (one repeating
  // schedule to add to the scheduling group), whatever part of it falls in the period.
  // o = computeActions input (+ locations: the location schedules of en_bas_groups) + { from, to }. -> [{ id, change, dates, forText, unit, inBas, where, groupNow, named, repeats, action }]
    //   where = the place of every BAS program the line's events use (building / area / program; '; ' between them); groupNow = the schedules saved for its scheduling groups.
  //   rooms = ['Room 114 = Area F (Room F114)']: the Area of a room number named in an event title or location.
  // The calendar rows of these event ids whose date is in [o.from, o.to].
  function rowsInPeriod(o, ids) {
    return ids
      .map(function (id) { return (o.events || {})[id]; })
      .filter(function (row) {
        if (!row || !row[1]) return false;
        var d = CD.calendarDay(row[1], o.tz);
        return d >= o.from && d <= o.to;
      });
  }
  function periodNeeds(o) {
    var out = [];
    computeActions(o).forEach(function (a) {
      var inP = a.dates.filter(function (d) { return d >= o.from && d <= o.to; });
      if (!inP.length) return;
      var rep = repeatOf(a.dates);
      var repIn = rep.dates.some(function (d) { return d >= o.from && d <= o.to; });
      var parts = [];
      if (repIn) {
        parts.push('Every ' + rep.weekdays.join('/') + ', ' + CD.dayLabel(rep.dates[0]).replace(/^\w+, /, '') + ' - ' + CD.dayLabel(rep.dates[rep.dates.length - 1]).replace(/^\w+, /, '') + ' (' + rep.dates.length + ' dates). Add once as a repeating schedule');
      }
      var oneIn = (repIn ? rep.rest : a.dates).filter(function (d) { return d >= o.from && d <= o.to; });
      if (oneIn.length) parts.push(oneIn.map(dayText).join(', '));
      var snap = BC.snapshotForDate(o.snaps, inP[0]);
      var inBas = '';
      if (snap) {
        inBas = BD.blocksText(snap.rows[a.program]) + '. Source: ' + BC.sourceText(snap);
      }
      var act = activateOption(o, a, inP);
      out.push({
        id: a.id,
        activate: act,
        change: a.change, // the one text of the change: the same words as the end of the stored action text (computeActions)
        dates: parts.join('. '),
        repeats: repIn,
        webctrl: a.webctrl,
        forText: a.titleText,
        unit: a.unit,
        inBas: inBas,
        where: uniq(a.programs.map(whereText)).join('; '),
        groupNow: groupScheduleText(o.groups, a.program),
        rooms: roomLines(o, rowsInPeriod(o, a.eventIds)),
        action: a,
      });
    });
    return out.sort(function (a, b) { return a.action.start < b.action.start ? -1 : a.action.start > b.action.start ? 1 : a.id < b.id ? -1 : 1; });
  }
  // --- opportunities: covered events whose own schedule is longer than the event -------------------
  // Matt 2026-11-12: tell the user when a new schedule could fit better, but do not force it when the event is already covered.
  // Only the event's OWN WebCTRL schedule counts (BC.webctrlMatch: equal name, or a 3-word-or-longer schedule name that starts the title).
  // A schedule of the group made for another event runs anyway, so splitting it would save nothing.
  // The schedule runs OPP_MIN minutes or more before the event start or after its end on that date. Time that another calendar event in
  // the same BAS program uses that day does not count. One line per schedule; dates join by weekday. 'a week' is said only when
  // the event repeats weekly: the same title on the same weekday on 2 or more dates within 5 weeks.
  var OPP_MIN = 30;
  var REPEAT_DAYS = 35;
  function hoursText(min) {
    return String(Math.round(min / 6) / 10);
  }
  // o = computeActions input + { from, to }. -> [{ id, title, schedule, hours, weekly, dates, text }] by title.
  function periodOpportunities(o) {
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations, effectCache: {} };
    // Only events within REPEAT_DAYS of the shown period matter: repeats() and used() never look farther.
    var lo = CD.addDays(o.from, -REPEAT_DAYS);
    var hi = CD.addDays(o.to, REPEAT_DAYS);
    var info = {};
    Object.keys(o.events || {}).forEach(function (id) {
      var row = o.events[id];
      if (!row || !row[1]) return;
      var date = CD.calendarDay(row[1], o.tz);
      if (date < lo || date > hi) return;
      var c = BC.eventCoverage(row, ctx);
      info[id] = { id: id, row: row, date: date, c: c, name: BC.normName(row[0]) };
    });
    var ids = Object.keys(info);
    var repeats = function (e) {
      var lo = CD.addDays(e.date, -REPEAT_DAYS);
      var hi = CD.addDays(e.date, REPEAT_DAYS);
      return ids.some(function (k) {
        var x = info[k];
        return x !== e && x.name === e.name && x.date !== e.date && x.date >= lo && x.date <= hi && BD.weekdayOf(x.date) === BD.weekdayOf(e.date);
      });
    };
    // Does another event of the same date and BAS program overlap [a, b)?
    var used = function (e, a, b) {
      return ids.some(function (k) {
        var x = info[k];
        if (x === e || x.date !== e.date || !x.c.keys.length) return false;
        if (!x.c.keys.some(function (key) { return e.c.keys.indexOf(key) !== -1; })) return false;
        return x.c.fromMin < b && x.c.toMin > a;
      });
    };
    var bySched = {};
    ids.forEach(function (id) {
      var e = info[id];
      var c = e.c;
      if (e.date < o.today || e.date < o.from || e.date > o.to || c.status !== 'covered') return;
      var m = BC.webctrlMatch(o.groups, o.locations, e.row[0], e.date, c.keys.length ? BD.keyBuilding(c.keys[0]) : '');
      if (!m) return;
      var block = m.blocks.filter(function (b) { return b[0] <= c.fromMin && b[1] >= c.toMin; })[0];
      if (!block) return;
      var before = c.fromMin - block[0];
      var after = block[1] - c.toMin;
      if (before < OPP_MIN || used(e, block[0], c.fromMin)) before = 0;
      if (after < OPP_MIN || used(e, c.toMin, block[1])) after = 0;
      var extra = before + after;
      if (!extra) return;
      var k = m.schedule.name + '|' + BD.scheduleText(m.schedule);
      var u = (bySched[k] = bySched[k] || { schedule: m.schedule, titles: [], days: {} });
      u.titles.push(e.row[0]);
      var wd = BD.weekdayOf(e.date);
      var d = u.days[wd];
      var weekly = repeats(e);
      if (!d || extra < d.extra) u.days[wd] = { wd: wd, extra: extra, before: before, after: after, from: c.fromMin, to: c.toMin, bStart: block[0], bEnd: block[1], dates: [e.date], weekly: weekly };
      else d.dates.push(e.date);
    });
    var clk = function (m) { return BD.clock(m >= 1440 ? 0 : m); };
    var out = [];
    Object.keys(bySched).forEach(function (k) {
      var u = bySched[k];
      var days = Object.keys(u.days).map(function (w) { return u.days[w]; }).sort(function (a, b) { return WD_ORDER.indexOf(a.wd) - WD_ORDER.indexOf(b.wd); });
      var groups = [];
      days.forEach(function (d) {
        var key = [d.extra, d.from, d.to, d.bStart, d.bEnd].join('|');
        var g = groups.filter(function (x) { return x.key === key; })[0];
        if (g) g.wds.push(d.wd);
        else groups.push({ key: key, wds: [d.wd], d: d });
      });
      var total = days.reduce(function (n, d) { return n + d.extra; }, 0);
      var weekly = days.every(function (d) { return d.weekly; });
      var runs = groups.map(function (g) {
        var d = g.d;
        return hoursText(d.extra) + ' h longer than the event on ' + g.wds.join(',') + ' (event ' + clk(d.from) + '-' + clk(d.to) + ', schedule ' + clk(d.bStart) + '-' + clk(d.bEnd) + ')';
      });
      var seps = groups.map(function (g) {
        var d = g.d;
        return g.wds.join(',') + ' ' + clk(d.from) + '-' + clk(d.to);
      });
      var dates = [].concat.apply([], days.map(function (d) { return d.dates; })).sort();
      out.push({
        id: 'opp|' + k,
        title: titlesText(u.titles),
        schedule: u.schedule.name,
        hours: Math.round(total / 6) / 10,
        weekly: weekly,
        dates: dates,
        text: 'Opportunity: ' + u.schedule.name + ' runs ' + runs.join('; ') + '. A separate ' + and(seps) + ' schedule would save about ' + hoursText(total) + ' h' + (weekly ? ' a week' : '') + '. Optional: the event is already covered.',
      });
    });
    return out.sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
  }

  // --- probably covered: the scheduling group has no saved members --------------------------------
  // Events of the period that no saved schedule covers, while a scheduling group with no saved members has a schedule that spans them
  // (BC.eventCoverage status 'unknown'). Not a to-do, no Done button. Upcoming events only. One line per title and text; dates joined.
  // o = computeActions input + { from, to }. -> [{ id, title, group, dates, rooms, text }] by title.
  function periodUnknown(o) {
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations, effectCache: {} };
    var by = {};
    Object.keys(o.events || {}).forEach(function (id) {
      var row = o.events[id];
      if (!row || !row[1]) return;
      var date = CD.calendarDay(row[1], o.tz);
      if (date < o.today || date < o.from || date > o.to) return;
      var c = BC.eventCoverage(row, ctx);
      if (c.status !== 'unknown') return;
      var k = row[0] + '|' + c.label;
      var u = (by[k] = by[k] || { id: 'unk|' + k, title: row[0], group: c.probable.group, dates: [], rooms: [], text: c.label });
      u.dates.push(date);
      roomLines(o, [row]).forEach(function (r) {
        if (u.rooms.indexOf(r) === -1) u.rooms.push(r);
      });
    });
    return Object.keys(by)
      .map(function (k) {
        by[k].dates = uniq(by[k].dates.sort());
        return by[k];
      })
      .sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : a.text < b.text ? -1 : 1; });
  }

  // Everything the District Calendar needs for one shown period: the needs lines and the comparison status.
  // o = computeActions input + { from, to, rows (the live events of the period) }.
  function periodView(o) {
    return {
      needs: periodNeeds(o),
      opportunities: periodOpportunities(o),
      unknown: periodUnknown(o),
      status: BC.checkStatus(o.rows, { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations }),
    };
  }

  // --- the To do card: what to do in WebCTRL in the shown period ------------------------------
  // The event name without the place the title ends with ('LHS Cross Country Awards- LHS Commons' -> 'LHS Cross Country Awards').
  function eventName(row) {
    var p = CD.eventPlace({ title: row[0], location: row[4] });
    if (!p.fromTitle) return row[0];
    var i = String(row[0]).lastIndexOf(p.text);
    var t = i > 0 ? String(row[0]).slice(0, i).replace(/[\s@-]+$/, '').trim() : '';
    return t || row[0];
  }
  function monthDay(ymd) {
    return dayText(ymd).split(' ').slice(1).join(' ');
  }
  // One to-do line (a periodNeeds line n) as plain words for the shown period [o.from, o.to].
  //   { id, head, doThis, why, count, dates, eventIds }
  //   head  'Mon Nov 16, 6:30-8:00 PM: LHS Cross Country Awards in LHS Commons'
  //   doThis  'Do this: in WebCTRL, group HS NewArea F, add a one-day schedule Mon Nov 16, 6:30-8:00 PM.'
  //   why     the words of BC.describe for the events (rooms, group, where the schedule ends, a schedule of that name in another group).
  // A weekday that repeats 3 or more times is ONE row with its date count.
  function todoRow(o, n, ctx) {
    var a = n.action;
    var rep = repeatOf(a.dates);
    var repIn = n.repeats;
    var inPeriod = function (d) { return d >= o.from && d <= o.to; };
    var shownDates = repIn ? rep.dates.concat(rep.rest.filter(inPeriod)) : a.dates.filter(inPeriod);
    var events = [];
    a.eventIds.forEach(function (id) {
      var row = (o.events || {})[id];
      if (!row) return;
      var d = CD.calendarDay(row[1], o.tz);
      if (shownDates.indexOf(d) === -1) return;
      var c = BC.describe(BC.coverageOf(row, ctx), ctx);
      events.push({ id: id, row: row, c: c, date: d });
    });
    var names = uniq(events.map(function (e) { return eventName(e.row); }));
    var spaces = uniq(events.map(function (e) { return e.c.space; }).filter(Boolean));
    var times = BC.spansRange(a.spans);
    var when;
    var doWhen;
    if (repIn) {
      var wd = rep.weekdays.join('/');
      var span = monthDay(rep.dates[0]) + ' – ' + monthDay(rep.dates[rep.dates.length - 1]);
      when = 'Every ' + wd + ', ' + times;
      doWhen = 'a weekly schedule on ' + wd + ', ' + times + ' (' + rep.dates.length + ' dates, ' + span + ')';
      var more = rep.rest.filter(inPeriod);
      if (more.length) doWhen += ', and one-day schedules on ' + and(more.map(dayText)) + ', ' + times;
    } else if (shownDates.length === 1) {
      when = dayText(shownDates[0]) + ', ' + times;
      doWhen = 'a one-day schedule ' + dayText(shownDates[0]) + ', ' + times;
    } else {
      when = shownDates.map(dayText).join(', ') + ', ' + times;
      doWhen = 'one-day schedules on ' + and(shownDates.map(dayText)) + ', ' + times;
    }
    var head = when + ': ' + (names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : and(names)) + (spaces.length ? ' in ' + (spaces.length > 3 ? spaces.slice(0, 3).join(', ') + ' and ' + (spaces.length - 3) + ' more' : and(spaces)) : '');
    var base = a.group ? 'in WebCTRL, group ' + a.group : 'in WebCTRL, for ' + a.unit;
    var act = n.activate ? ' Or turn on the saved schedule ' + n.activate.name + ' in group ' + n.activate.group + ' (select ' + n.activate.days + ').' : '';
    var whys = uniq(events.map(function (e) { return e.c.why; }).filter(Boolean));
    var why = whys.slice(0, 2).join(' ') + (whys.length > 2 ? ' ' + (whys.length - 2) + ' more places are checked the same way.' : '');
    return {
      id: n.id,
      head: head,
      doThis: 'Do this: ' + base + ', add ' + doWhen + '.' + act,
      why: why ? 'Why: ' + why : '',
      count: shownDates.length,
      dates: shownDates,
      eventIds: events.map(function (e) { return e.id; }),
    };
  }
  // Everything the To do card shows for the period [o.from, o.to] (o = periodView input + stored/now). The default period is this week.
  //   todo      rows to do (each has a Done button) ; done  rows a person marked Done (waiting for the next BAS import)
  //   covered   [{ date, when, title, reason }] events of the period that are covered (or were added in WebCTRL), nothing to do
  //   optional  [{ id, text }] covered events whose own schedule is longer than the event
  //   later     { count, from } open to-dos dated after the period, or null
  //   status    BC.checkStatus of the period's events (counts, reasons)
  function todoView(o) {
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations, scheduleEdits: o.scheduleEdits, effectCache: {} };
    var pv = periodView(o);
    var stored = reconcile(o).stored.actions;
    var out = { todo: [], done: [], covered: [], optional: [], later: null, status: pv.status };
    var shown = {};
    pv.needs.forEach(function (n) {
      var r = todoRow(o, n, ctx);
      var s = stored[n.id];
      r.note = s && s.note ? s.note : '';
      if (s && s.status === 'done') {
        r.doneBy = s.doneBy || '';
        r.doneAt = s.doneAt || '';
        out.done.push(r);
      } else if (!n.webctrl) out.todo.push(r); // a line added in WebCTRL (audit log) is in covered, with the events
      r.eventIds.forEach(function (id) { shown[id] = 1; });
    });
    (o.rows || []).forEach(function (row) {
      if (!row || !row[1]) return;
      var c = BC.describe(BC.coverageOf(row, ctx), ctx);
      if (c.state !== 'covered' && c.state !== 'edited') return;
      out.covered.push({ date: c.date, from: c.fromMin, when: dayText(c.date) + ', ' + BC.timeRange(c.fromMin, c.toMin), title: eventName(row), reason: c.hover });
    });
    out.covered.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.from - b.from || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0); });
    pv.opportunities.forEach(function (op) {
      out.optional.push({
        id: op.id,
        text: op.title + ' (' + op.dates.map(function (d) { return monthDay(d); }).join(', ') + '): the schedule ' + op.schedule + ' runs about ' + op.hours + ' h longer than the event' + (op.weekly ? ' each week' : '') + '.',
      });
    });
    var laterIds = [];
    var laterFrom = '';
    computeActions(o).forEach(function (a) {
      var s = stored[a.id];
      if ((s && s.status === 'done') || a.webctrl) return;
      a.eventIds.forEach(function (id) {
        var row = (o.events || {})[id];
        var d = row && CD.calendarDay(row[1], o.tz);
        if (!d || d <= o.to || shown[id]) return;
        laterIds.push(id);
        if (!laterFrom || d < laterFrom) laterFrom = d;
      });
    });
    if (laterIds.length) out.later = { count: laterIds.length, from: laterFrom };
    return out;
  }

  // The newest time the data changed: the newest BAS import or the calendar sync (ISO text), '' when unknown.
  function latestImport(snaps, calFetchedAt) {
    var t = calFetchedAt || '';
    Object.keys(snaps || {}).forEach(function (d) {
      var at = BD.isDate(d) && snaps[d] && snaps[d].importedAt;
      if (at && at > t) t = at;
    });
    return t;
  }

  // Which saved copies the list is built from, in plain words, so the reader knows how old the data is.
  // o = { snapFetchedAt (ISO or ''), snaps, tz, today, auditLastDay, scheduleEdits }. 'Saved calendar: Nov 3, 2026 (7 days old). Saved BAS schedules: Oct 29, 2026, Oct 30, 2026.'
  function copyNote(o) {
    var out = [];
    if (o.snapFetchedAt) {
      var d = CD.calendarDay(o.snapFetchedAt, o.tz);
      // Whole calendar days from the copy day to today, counted with CD.addDays (no millisecond math; the day-count gate allows only calcDays).
      var age = 0;
      for (var c = d; c < o.today && age < 3660; age++) c = CD.addDays(c, 1);
      out.push('Saved calendar: ' + BD.dateText(d) + ' (' + (age <= 0 ? 'today' : age + (age === 1 ? ' day' : ' days') + ' old') + ').');
    } else out.push('No calendar saved.');
    var days = Object.keys(o.snaps || {}).filter(function (x) { return BD.isDate(x) && o.snaps[x] && o.snaps[x].rows; }).sort();
    out.push(days.length ? 'Saved BAS schedules: ' + days.map(BD.dateText).join(', ') + '.' : 'No BAS schedule saved.');
    // The audit log is the only record of edits made in WebCTRL after the newest BAS copy.
    // o.auditLastDay = the newest day of the imported audit log ('' when none); o.scheduleEdits = its schedule rows (changeList rows with a type of Schedule added, changed or deleted).
    var newest = days.length ? days[days.length - 1] : '';
    if (o.auditLastDay) {
      var since = (o.scheduleEdits || []).filter(function (e) { return !newest || e.ymd > newest; }).length;
      out.push('Newest saved BAS schedule: ' + (newest ? BD.dateText(newest) : 'none') + '. Newest audit log day: ' + BD.dateText(o.auditLastDay) + '. Schedule edits in the audit log since that BAS schedule: ' + since + '.');
    }
    return out.join(' ');
  }

  // --- status over time -----------------------------------------------------------------------
  function clone(stored) {
    var a = (stored && stored.actions) || {};
    var out = { actions: {} };
    Object.keys(a).forEach(function (k) {
      out.actions[k] = Object.assign({}, a[k]);
    });
    return out;
  }
  function dayOf(iso, tz) {
    return BD.dateText(CD.calendarDay(iso, tz));
  }
  // The stored actions after one more look at the calendar and the BAS copies.
  //   A new Not covered event opens an action. An open action whose event is now Covered closes ("Fixed in BAS on <date>").
  //   A Done action whose event is still Not covered after a newer BAS import or calendar sync (o.latestImport, ISO)
  //   reopens with a note. A closed action whose event is Not covered again reopens.
  // changes = what changed, one { id, text, what } each, for the history.
  function reconcile(o) {
    var now = o.now;
    var store = clone(o.stored);
    var changes = [];
    var cur = {};
    computeActions(o).forEach(function (a) {
      cur[a.id] = a;
    });
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps, groups: o.groups, locations: o.locations };
    var latest = o.latestImport || '';
    Object.keys(cur).forEach(function (id) {
      var a = cur[id];
      var s = store.actions[id];
      if (!s) {
        store.actions[id] = { id: id, date: a.date, text: a.text, program: a.program, eventIds: a.eventIds, status: 'open', openedAt: now, note: '' };
        changes.push({ id: id, text: a.text, what: 'New action' });
        return;
      }
      s.date = a.date;
      s.text = a.text;
      s.program = a.program;
      s.eventIds = a.eventIds;
      if (s.status === 'done' && latest && latest > s.doneAt) {
        var note = 'Marked done by ' + (s.doneBy || 'someone') + ' on ' + dayOf(s.doneAt, o.tz) + ', still not covered after the update of ' + dayOf(latest, o.tz);
        s.status = 'open';
        s.note = note;
        changes.push({ id: id, text: a.text, what: 'Reopened: ' + note });
      } else if (s.status === 'closed') {
        s.status = 'open';
        s.note = 'Closed earlier, not covered again';
        s.closedAt = '';
        changes.push({ id: id, text: a.text, what: 'Reopened: not covered again' });
      }
    });
    Object.keys(store.actions).forEach(function (id) {
      var s = store.actions[id];
      if (cur[id]) return;
      if (s.status === 'closed') {
        if (s.date < CD.addDays(o.today, -CLOSED_KEEP_DAYS)) delete store.actions[id];
        return;
      }
      var note;
      var rows = (s.eventIds || [id])
        .map(function (e) {
          return (o.events || {})[e];
        })
        .filter(Boolean);
      if (!rows.length) note = 'Event removed from the calendar';
      else if (s.date < o.today) note = 'Event date passed';
      else {
        var cs = rows.map(function (r) {
          return BC.eventCoverage(r, ctx);
        });
        var every = function (st) {
          return cs.every(function (c) { return c.status === st; });
        };
        if (every('covered')) note = 'Fixed in BAS on ' + (latest ? dayOf(latest, o.tz) : BD.dateText(o.today));
        else if (cs.some(function (c) { return c.status === 'short'; })) note = 'Merged into another line';
        else note = 'No longer checked (' + cs[0].label + ')';
      }
      s.status = 'closed';
      s.closedAt = now;
      s.note = note;
      changes.push({ id: id, text: s.text, what: 'Closed: ' + note });
    });
    return { stored: store, changes: changes };
  }
  // Mark one action done or open again by a person.
  function setStatus(stored, id, status, who, now) {
    var store = clone(stored);
    var s = store.actions[id];
    var changes = [];
    if (!s || (status !== 'done' && status !== 'open') || s.status === status) return { stored: store, changes: changes };
    s.status = status;
    s.note = '';
    if (status === 'done') {
      s.doneBy = who || '';
      s.doneAt = now;
    } else {
      s.doneBy = '';
      s.doneAt = '';
    }
    changes.push({ id: id, text: s.text, what: status === 'done' ? 'Marked done' : 'Marked open again' });
    return { stored: store, changes: changes };
  }
  // One record for en_bas_hist_<pid> (shown with the BAS schedule history).
  function historyRecord(changes, at, by, id) {
    return { id: id, kind: 'action', at: at, by: by || '', counts: { total: changes.length }, changes: changes.slice(0, 200) };
  }

  // --- BAS-side waste -------------------------------------------------------------------------
  // A program occupied all day on a saved BAS day while no event of that building is on the calendar that day.
  // An event belongs to a building by its confirmed space map, else by the first word of its space name.
  // Serving units and exterior lights (see below) are never listed. -> [{ key, building, program, group, dates:[YYYY-MM-DD], text }], by building then program.
  function wasteFindings(o) {
    var since = CD.addDays(o.today, -WASTE_DAYS);
    var spaces = (o.map && o.map.spaces) || {};
    var byKey = {};
    Object.keys(o.snaps || {})
      .filter(function (d) {
        return BD.isDate(d) && d >= since && o.snaps[d] && o.snaps[d].rows;
      })
      .sort()
      .forEach(function (d) {
        var rows = o.snaps[d].rows;
        var keys = Object.keys(rows);
        var busy = {};
        Object.keys(o.events || {}).forEach(function (id) {
          var row = o.events[id];
          if (!row || !row[1]) return;
          var last = CD.calendarDay(row[1], o.tz);
          if (row[3] || /^\d{4}-\d{2}-\d{2}$/.test(row[1])) last = CD.allDayLastDay(row[1], row[2], o.tz);
          if (CD.calendarDay(row[1], o.tz) > d || last < d) return;
          var place = CD.eventPlace({ title: row[0], location: row[4] }).text;
          var hit = place ? BC.findSpace(spaces, place) : null;
          var e = hit && hit.entry;
          if (e && e.confirmed) BC.resolveKeys(rows, e.programs).forEach(function (k) { busy[BD.keyBuilding(k)] = 1; });
          var b = BC.buildingOfPlace(place, keys);
          if (b) busy[b] = 1;
        });
        keys.forEach(function (k) {
          if (BC.isUnchecked(programName(k)) || busy[BD.keyBuilding(k)]) return;
          // Exterior lights run on a photocell or astro clock: all-day only enables them. Listed only when the caller names
          // the program as having no photocell, astro or light-level point (o.noLightLevel[key]). The schedule export carries no points.
          if (BC.isExteriorLighting(programName(k)) && !(o.noLightLevel && o.noLightLevel[k])) return;
          if (BC.minutesShort(rows[k], 0, 1440) > 1440 - WASTE_MIN) return;
          byKey[k] = byKey[k] || { key: k, building: BD.keyBuilding(k), program: programName(k), group: groupFor(o.groups, k), dates: [] };
          byKey[k].dates.push(d);
        });
      });
    return Object.keys(byKey)
      .map(function (k) {
        var f = byKey[k];
        f.text =
          f.building + ': ' + f.program + ' is occupied all day on ' +
          and(f.dates.map(dayText)) +
          ' with no event on the calendar' + (f.group ? ' (group ' + f.group + ')' : '');
        return f;
      })
      .sort(function (a, b) {
        return a.building < b.building ? -1 : a.building > b.building ? 1 : a.program < b.program ? -1 : a.program > b.program ? 1 : 0;
      });
  }

  // --- the input of the check, and the save plan (one copy, used by the page and by the daily update) ---------
  // io = { get(key, fallback), matrixRows(pid) -> rows, manualRows(pid) -> event rows, auditList(store) -> BasAuditLog.changeList result, now (ISO) }.
  // The page (app/sched-actions.js) and scripts/calendar-daily-sync.js each pass their own io; the rules are here only.
  // The schedule rows (type Schedule added, changed or deleted) of a BasAuditLog.changeList result: the edits coverageOf reads (ctx.scheduleEdits).
  function scheduleEditsOf(log) {
    return ((log && log.rows) || []).filter(function (r) { return /^Schedule/.test(r.type); });
  }
  function buildInput(io, pid) {
    var cfg = io.get('en_cal_cfg_' + pid, null);
    var snap = io.get('en_cal_snap_' + pid, null);
    var snaps = io.get('en_bas_snap_' + pid, {});
    if (!snaps || typeof snaps !== 'object' || Array.isArray(snaps)) snaps = {};
    var tz = (cfg && cfg.timezone) || 'America/Chicago';
    var g = io.get('en_bas_groups_' + pid, null);
    var log = io.auditList(io.get('en_bas_auditevents_' + pid, null));
    return {
      scheduleEdits: scheduleEditsOf(log),
      auditLastDay: log.lastDay,
      events: Object.assign({}, (snap && snap.events) || {}, io.manualRows(pid)),
      map: io.get('en_space_map_' + pid, null),
      snaps: snaps,
      groups: (g && g.groups) || {},
      locations: (g && g.locations) || [],
      matrixRooms: (io.matrixRows(pid) || [])
        .filter(function (r) { return r.bacnetLocation && r.equipName; })
        .map(function (r) { return { location: r.bacnetLocation, name: r.equipName }; }),
      tz: tz,
      today: CD.calendarDay(io.now, tz),
      stored: io.get('en_sched_actions_' + pid, null),
      now: io.now,
      latestImport: latestImport(snaps, snap && snap.fetchedAt),
      snapFetchedAt: (snap && snap.fetchedAt) || '',
    };
  }
  var ACT_HIST_MAX = 50;
  // The new en_bas_acthist_<pid> list: one record for these changes in front of the old list (50 kept). No changes: the old list.
  function appendHistory(old, changes, at, by, id) {
    var list = Array.isArray(old) ? old : [];
    if (!changes.length) return list;
    return [historyRecord(changes, at, by, id)].concat(list).slice(0, ACT_HIST_MAX);
  }
  // What a save after a calendar sync or a BAS import writes: null when no action changed, else { stored, hist } (en_sched_actions_<pid>, en_bas_acthist_<pid>).
  function persistPlan(inp, histOld, id) {
    var v = reconcile(inp);
    if (!v.changes.length) return null;
    return { stored: v.stored, hist: appendHistory(histOld, v.changes, inp.now, 'automatic check', id) };
  }

  var api = {
    buildInput: buildInput,
    scheduleEditsOf: scheduleEditsOf,
    appendHistory: appendHistory,
    persistPlan: persistPlan,
    computeActions: computeActions,
    periodNeeds: periodNeeds,
    periodView: periodView,
    todoView: todoView,
    periodOpportunities: periodOpportunities,
    periodUnknown: periodUnknown,
    roomLines: roomLines,
    copyNote: copyNote,
    repeatOf: repeatOf,
    reconcile: reconcile,
    setStatus: setStatus,
    wasteFindings: wasteFindings,
    historyRecord: historyRecord,
    groupFor: groupFor,
    latestImport: latestImport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchedActions = api;
})(typeof window !== 'undefined' ? window : this);
