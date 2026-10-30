// computations/sched-actions.js
//
// The ONE place that builds the "What needs to change" list of the District Calendar tab, keeps each action's
// Open / Done / Closed status, and finds BAS-side waste. The coverage decision itself is BasCoverage.eventCoverage
// (computations/bas-coverage.js); nothing here repeats it. app/sched-actions.js only draws the result and saves it.
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
//
// Stored (key en_sched_actions_<pid>, class SYNCED):
//   { actions:{ "<event id>": { id, date, text, program, status:'open'|'done'|'closed', openedAt, doneBy, doneAt, closedAt, note } } }
// An action exists only for a Not covered event (status "short"). Serving units are never checked, so they never make one.
//
//   computeActions(o)  o = { events, map, snaps, groups, tz, today }          -> [action] newest event first
//   reconcile(o)       o = computeActions input + { stored, now, latestImport } -> { stored, changes:[{id,text,what}] }
//   latestImport(snaps, calFetchedAt) -> newest BAS import or calendar sync time
//   setStatus(stored, id, status, who, now) -> { stored, changes }
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
  // en_bas_groups_<pid> { "building|group": { building, group, schedules, members:["Roof / RTU-8 Gym", ...] } }.
  // A member names the program as its last part, after the area. Returns the group name or ''.
  function groupFor(groups, key) {
    var p = BD.splitKey(key);
    var prog = norm(programName(key));
    var parts = p.location.split('/').map(norm).filter(Boolean);
    var area = parts[parts.length - 1] || '';
    var name = '';
    Object.keys(groups || {}).some(function (gk) {
      var g = groups[gk];
      var hit = (g.members || []).some(function (m) {
        var mp = String(m).split(' / ').map(norm);
        if (mp.pop() !== prog) return false;
        return !mp.length || mp[mp.length - 1] === area;
      });
      if (hit) name = g.group;
      return hit;
    });
    return name;
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
  // One line = one BAS unit (its scheduling group, else its program) x one set of uncovered spans, over every date and event
  // that needs it. Events in one unit on one day merge: overlapping or touching uncovered spans become one span. Days with the
  // same merged spans join into one line.
  function computeActions(o) {
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps };
    var units = {};
    Object.keys(o.events || {}).forEach(function (id) {
      var row = o.events[id];
      if (!row || !row[1]) return;
      var date = CD.calendarDay(row[1], o.tz);
      if (date < o.today) return;
      var c = BC.eventCoverage(row, ctx);
      if (c.status !== 'short') return;
      var group = groupFor(o.groups, c.program);
      var uk = group ? BD.keyBuilding(c.program) + '|' + group : c.program;
      var u = (units[uk] = units[uk] || { key: uk, group: group, days: {} });
      var d = (u.days[date] = u.days[date] || { spans: [], events: [], programs: [], short: 0 });
      d.spans = d.spans.concat(c.gaps);
      d.events.push({ id: id, title: row[0], space: c.space });
      d.programs.push(c.program);
      d.short += c.short;
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
        out.push({
          id: uk + '|' + sig,
          date: dates[dates.length - 1],
          dates: dates,
          start: dates[0],
          eventIds: events.map(function (e) { return e.id; }),
          title: titlesText(events.map(function (e) { return e.title; })),
          space: uniq(events.map(function (e) { return e.space; })).join(', '),
          program: programs[0],
          short: ds.reduce(function (n, d) { return n + d.short; }, 0),
          group: u.group,
          text:
            whenText(dates) + ' ' + titlesText(events.map(function (e) { return e.title; })) + ': ' +
            names.join(', ') + ' unoccupied ' + spansText(spans) +
            ' -> add ' + spansText(spans) + (u.group ? ' to group ' + u.group : ''),
        });
      });
    });
    return out.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;
    });
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
    var ctx = { tz: o.tz, map: o.map, snaps: o.snaps };
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
          var e = place ? spaces[BC.spaceKey(place)] : null;
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

  var api = {
    computeActions: computeActions,
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
