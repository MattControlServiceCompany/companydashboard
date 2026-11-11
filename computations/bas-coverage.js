// computations/bas-coverage.js
//
// The ONE place that decides whether the BAS schedule covers a calendar event: event x the BAS programs its space
// is mapped to x that date's effective schedule. Also holds the space map rules (name suggestions, matching a mapped
// program to a snapshot row, reading a suggestions CSV). The District Calendar tab (app/project-calendar.js,
// app/space-map.js) and tools/test-bas-coverage.js call these functions. Nothing else repeats these rules.
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
//
// Inputs
//   snaps  en_bas_snap_<pid>  { "YYYY-MM-DD": { rows:{ "location|program": [[start,end,mode]] } } }  (app/bas-diff.js)
//   map    en_space_map_<pid> { spaces:{ "<normalized space>": { space, programs:["location|program"], offsite,
//                              confirmed, by, at } } }
//   event  en_cal_snap_<pid> row [title, start, end, allDay, location]; the space is CalendarDiff.eventPlace
// Statuses (eventCoverage): covered, short (not covered, with minutes short), nobas (no BAS schedule for this space),
//   offsite, notmapped, nocopy (no BAS copy for that kind of day), allday (no times to check).
// Serving units (AHU/RTU/ERV/DOAS that serve boxes, HW/CHW plants) run on requests and have no schedule to check:
//   isServingProgram. They are never suggested and never checked. Domestic hot water (DHW) is NOT serving: it is out of
//   scope (isOutOfScopeProgram). isUnchecked is the one test for both.
(function (root) {
  'use strict';

  var CD = typeof require === 'function' && typeof module !== 'undefined' ? require('../app/calendar-diff.js') : root.CalendarDiff;
  var BD = typeof require === 'function' && typeof module !== 'undefined' ? require('../app/bas-diff.js') : root.BasDiff;

  var NO_END_MIN = 60; // an event with no end time is checked for one hour
  var SUGGEST_MAX = 8; // a name that matches more programs than this is too vague to suggest
  var GENERIC = { main: 1, area: 1, room: 1, rm: 1, the: 1, and: 1, of: 1 };

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }
  // "/District/Building /Roof" -> "/district/building/roof"
  function normLoc(s) {
    return String(s || '')
      .split('/')
      .map(norm)
      .filter(Boolean)
      .join('/');
  }
  function spaceKey(space) {
    return norm(space);
  }
  function keyParts(key) {
    var p = BD.splitKey(key);
    return { location: p.location, program: p.program };
  }

  // --- serving units --------------------------------------------------------------------------
  // A plant (HW, CHW, boiler, chiller, pump), an ERV or a DOAS is serving. An AHU, RTU or MAU whose name is only its
  // tag ("AHU-2", "RTU-3A") serves boxes. An air handler named for a room ("AHU-1 - Rm 12") serves that room.
  var SERVING_WORD = /\b(hw|chw|hws|chws|hwp|chwp|boiler|chiller|pump|plant|erv|doas|hrv)\b/i;
  var BARE_UNIT = /^(ahu|rtu|mau|oau|ac|cu|hp)[-_ ]?[a-z0-9]{1,4}([/,][a-z0-9]{1,4})*$/i;
  function isServingProgram(program) {
    var p = String(program || '')
      .replace(/ #\d+$/, '')
      .trim();
    return SERVING_WORD.test(p) || BARE_UNIT.test(p);
  }

  // --- out of scope ---------------------------------------------------------------------------
  // Domestic hot water is NOT a serving unit. It is outside these checks: never suggested, never checked.
  var OUT_OF_SCOPE_WORD = /\b(dhw|domestic hot water)\b/i;
  function isOutOfScopeProgram(program) {
    return OUT_OF_SCOPE_WORD.test(String(program || ''));
  }
  // Exterior and site lighting (exterior, pole, parking lot, walkway, canopy, bollard lights). It normally runs on a photocell or
  // an astronomical clock, so an all-day schedule only enables it. The waste check skips it.
  var LIGHT_WORD = /\b(lights?|lighting)\b/i;
  var EXTERIOR_WORD = /\b(exterior|pole|poles|parking|site|outdoor|walkway|canopy|bollard|security)\b/i;
  function isExteriorLighting(program) {
    var p = String(program || '');
    return LIGHT_WORD.test(p) && EXTERIOR_WORD.test(p);
  }
  // The ONE test for "this program is never suggested, checked or listed": a serving unit or out of scope.
  function isUnchecked(program) {
    return isServingProgram(program) || isOutOfScopeProgram(program);
  }

  // --- matching a mapped program to snapshot rows ---------------------------------------------
  function programOfKey(key) {
    return keyParts(key).program.replace(/ #\d+$/, '');
  }
  // Rows of one location whose program is the named one; else whose program holds the name. [] when the location is blank.
  function matchKeys(keys, location, program) {
    var nl = normLoc(location);
    var np = norm(program);
    if (!nl || !np) return [];
    var inLoc = keys.filter(function (k) {
      return normLoc(keyParts(k).location) === nl;
    });
    var exact = inLoc.filter(function (k) {
      return norm(programOfKey(k)) === np;
    });
    if (exact.length) return exact;
    if (np.length < 4) return [];
    return inLoc.filter(function (k) {
      return norm(programOfKey(k)).indexOf(np) !== -1;
    });
  }
  // Stored program keys of a space -> the snapshot row keys they stand for (serving units dropped, order kept, no repeats).
  function resolveKeys(rows, stored) {
    var keys = Object.keys(rows || {});
    var out = [];
    (stored || []).forEach(function (s) {
      var hit = Object.prototype.hasOwnProperty.call(rows || {}, s) ? [s] : matchKeys(keys, keyParts(s).location, keyParts(s).program);
      hit.forEach(function (k) {
        if (out.indexOf(k) === -1 && !isUnchecked(programOfKey(k))) out.push(k);
      });
    });
    return out;
  }

  // --- name suggestions -----------------------------------------------------------------------
  function initials(name) {
    return String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(function (w) {
        return w[0].toLowerCase();
      })
      .join('');
  }
  // Does the first word of a space ("RES", "LHS") stand for the building? Initials of the building words, or the
  // first word ends with them (LHS = HS plus a leading L) or starts with them (RES = RE plus S).
  function prefixMatchesBuilding(prefix, building) {
    var t = prefix.toLowerCase();
    var ini = initials(building);
    if (!ini || t.length < 2) return false;
    return t === ini || (t.length === ini.length + 1 && (t.slice(1) === ini || t.slice(0, ini.length) === ini));
  }
  // The building a space name points to by its first word ("TAH Gym" -> Test Alpha Hall), or '' when the word
  // stands for none or for more than one of the buildings in keys.
  function buildingOfPlace(space, keys) {
    var words = String(space || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return '';
    var buildings = {};
    keys.forEach(function (k) {
      buildings[BD.keyBuilding(k)] = 1;
    });
    var hit = Object.keys(buildings).filter(function (b) {
      return prefixMatchesBuilding(words[0], b);
    });
    return hit.length === 1 ? hit[0] : '';
  }
  // suggestPrograms(space, keys) -> row keys. The first word names the building; the other words (and any room number)
  // name programs of that building. Serving units are never suggested. [] when nothing matches or the name is vague.
  function suggestPrograms(space, keys) {
    var words = String(space || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length < 2) return [];
    var hit = [buildingOfPlace(space, keys)];
    if (!hit[0]) return [];
    var rest = words.slice(1);
    var tokens = rest
      .map(function (w) {
        return w.toLowerCase().replace(/[^a-z0-9]/g, '');
      })
      .filter(function (w) {
        return w.length >= 3 && !GENERIC[w];
      });
    if (!tokens.length) return [];
    var out = keys.filter(function (k) {
      if (BD.keyBuilding(k) !== hit[0]) return false;
      var p = programOfKey(k);
      if (isUnchecked(p)) return false;
      var low = p.toLowerCase();
      return tokens.every(function (t) {
        return /^\d+$/.test(t) ? new RegExp('(^|[^0-9])' + t + '([^0-9]|$)').test(low) : low.indexOf(t) !== -1;
      });
    });
    return out.length && out.length <= SUGGEST_MAX ? out : [];
  }

  // --- suggestions CSV ------------------------------------------------------------------------
  // rows2d = CSV rows (first row = headers calendar_space, bas_location, bas_program, confirmed). bas_program holds one
  // or more programs separated by ";". "yes" and "confirmed" in the confirmed column count as confirmed; "assumed" and anything else is a suggestion. Returns
  // { entries:{ spaceKey: entry }, count }. keys = row keys of the newest snapshot, to turn names into row keys.
  function entriesFromCsv(rows2d, keys, who, at) {
    var head = (rows2d[0] || []).map(norm);
    var col = function (n) {
      return head.indexOf(n);
    };
    var cs = col('calendar_space');
    var cl = col('bas_location');
    var cp = col('bas_program');
    var cc = col('confirmed');
    var out = { entries: {}, count: 0, error: '' };
    if (cs < 0 || cp < 0) {
      out.error = 'The file needs the columns calendar_space and bas_program.';
      return out;
    }
    rows2d.slice(1).forEach(function (r) {
      var space = String(r[cs] || '').trim();
      if (!space) return;
      var loc = cl >= 0 ? String(r[cl] || '').trim() : '';
      var programs = [];
      String(r[cp] || '')
        .split(';')
        .map(function (x) {
          return x.trim();
        })
        .filter(Boolean)
        .forEach(function (name) {
          var hit = matchKeys(keys, loc, name);
          if (hit.length) hit.forEach(function (k) { if (programs.indexOf(k) === -1) programs.push(k); });
          else if (loc) programs.push(loc + '|' + name);
        });
      var flag = cc >= 0 ? norm(r[cc]) : '';
      out.entries[spaceKey(space)] = {
        space: space,
        programs: programs,
        offsite: false,
        confirmed: flag === 'yes' || flag === 'confirmed',
        by: who || '',
        at: at || '',
      };
      out.count++;
    });
    return out;
  }

  // --- the date's effective schedule ----------------------------------------------------------
  function dow(ymd) {
    return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).getUTCDay();
  }
  // The copy for the date. When there is none: the newest earlier copy of the same weekday (else the nearest later one); for a
  // Monday to Thursday date with no copy of its weekday, the nearest copy of another Monday to Thursday day (the BAS runs one
  // weekday schedule on Monday to Thursday; Friday and the weekend can differ, so they are never borrowed).
  // Returns { date, rows, exact, kind } or null. kind: 'date' (the day itself), 'weekday' (same weekday), 'monthu' (Monday to Thursday).
  function pickCopy(snaps, date, days, kind) {
    var all = Object.keys(snaps || {}).filter(function (d) {
      return BD.isDate(d) && snaps[d] && snaps[d].rows && days.indexOf(dow(d)) !== -1;
    }).sort();
    if (!all.length) return null;
    var before = all.filter(function (d) { return d < date; });
    var pick = before.length ? before[before.length - 1] : all[0];
    return { date: pick, rows: snaps[pick].rows, exact: false, kind: kind };
  }
  function snapshotForDate(snaps, date) {
    var all = Object.keys(snaps || {}).filter(BD.isDate);
    if (all.indexOf(date) !== -1 && snaps[date] && snaps[date].rows) return { date: date, rows: snaps[date].rows, exact: true, kind: 'date' };
    return pickCopy(snaps, date, [dow(date)], 'weekday') || (dow(date) >= 1 && dow(date) <= 4 ? pickCopy(snaps, date, [1, 2, 3, 4], 'monthu') : null);
  }
  // Plain words for the copy a check used, for hover text: 'Thu Oct 29 BAS copy', 'same-weekday Thu Oct 29 BAS copy', 'Mon-Thu schedule (Thu Oct 29 BAS copy)'.
  function sourceText(snap) {
    var d = BD.dateText(snap.date);
    return snap.kind === 'monthu' ? 'Mon-Thu schedule (' + d + ' BAS copy)' : (snap.exact ? '' : 'same-weekday ') + d + ' BAS copy';
  }

  // Minutes since midnight of a stored time in the calendar time zone.
  var _fmt = {};
  function minuteOfDay(iso, tz) {
    var f = (_fmt[tz] =
      _fmt[tz] || new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    var o = {};
    f.formatToParts(new Date(iso)).forEach(function (x) {
      o[x.type] = x.value;
    });
    return (+o.hour % 24) * 60 + +o.minute;
  }
  // The stretches of [from,to] (minutes) that the occupied blocks do not cover: [[start,end]] in order.
  function gapsOf(blocks, from, to) {
    var occ = (blocks || [])
      .filter(function (b) {
        return b[2] === 'occ';
      })
      .map(function (b) {
        return b[1] <= b[0] ? [b[0], 1440] : [b[0], b[1]];
      })
      .sort(function (a, b) {
        return a[0] - b[0];
      });
    var cur = from;
    var gaps = [];
    occ.forEach(function (b) {
      var s = Math.max(b[0], cur);
      var e = Math.min(b[1], to);
      if (e > s) {
        if (s > cur) gaps.push([cur, s]);
        cur = e;
      }
    });
    if (to > cur) gaps.push([cur, to]);
    return gaps;
  }
  // Minutes of [from,to] that the occupied blocks do not cover.
  function minutesShort(blocks, from, to) {
    return gapsOf(blocks, from, to).reduce(function (n, g) {
      return n + g[1] - g[0];
    }, 0);
  }

  // --- scheduling groups ----------------------------------------------------------------------
  // en_bas_groups_<pid> { "building|group": { building, group, schedules, members:["Roof / RTU-8 Gym", ...] } }.
  // A member names the program as its last part, after the area. Returns the group entry of a program row key, or null.
  function groupEntryFor(groups, key) {
    var p = BD.splitKey(key);
    var prog = norm(programOfKey(key));
    var parts = p.location.split('/').map(norm).filter(Boolean);
    var area = parts[parts.length - 1] || '';
    var found = null;
    Object.keys(groups || {}).some(function (gk) {
      var g = groups[gk];
      var hit = (g.members || []).some(function (m) {
        var mp = String(m).split(' / ').map(norm);
        if (mp.pop() !== prog) return false;
        return !mp.length || mp[mp.length - 1] === area;
      });
      if (hit) found = g;
      return hit;
    });
    return found;
  }
  // The occupied blocks [[from,to,'occ']] that the Weekly schedules of a program's scheduling group add on one weekday.
  // The BAS copy is the effective schedule as exported on its day; a Weekly group schedule for another weekday (Mon-Thu copies
  // are borrowed for Mon, Tue, Wed) is invisible in it, so the group schedules are read here as well.
  var DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function groupBlocksOn(groups, key, ymd) {
    var g = groupEntryFor(groups, key);
    var out = [];
    ((g && g.schedules) || []).forEach(function (s) {
      var b = BD.groupScheduleBlock(s);
      if (b && b.days.indexOf(DAY_ABBR[dow(ymd)]) !== -1) out.push([b.from, b.to, 'occ']);
    });
    return out;
  }

  // --- the one coverage function --------------------------------------------------------------
  // eventCoverage(row, ctx) -> { status, label, space, short, program, from, exact }
  //   row = [title, start, end, allDay, location]; ctx = { tz, map, snaps, groups }
  //   groups (en_bas_groups) is optional: the Weekly schedules of a program's scheduling group that list the event weekday count as occupied.
  //   short = minutes the worst mapped program is unoccupied during the event; program = its row key; gaps = those stretches.
//   fromMin/toMin = the event as minutes of that day.
  function eventCoverage(row, ctx) {
    var place = CD.eventPlace({ title: row[0], location: row[4] }).text;
    var res = { status: '', label: '', space: place, short: 0, program: '', from: '', exact: true, source: '', fromMin: 0, toMin: 0, gaps: [] };
    var done = function (status, label) {
      res.status = status;
      res.label = label;
      return res;
    };
    if (!row[1]) return done('notmapped', 'Not mapped');
    var allDay = !!row[3] || /^\d{4}-\d{2}-\d{2}$/.test(row[1]);
    if (allDay) return done('allday', 'All-day, no times');
    var spaces = (ctx.map && ctx.map.spaces) || {};
    var entry = place ? spaces[spaceKey(place)] : null;
    if (!entry || !entry.confirmed) return done('notmapped', 'Not mapped');
    if (entry.offsite) return done('offsite', 'Off-site');
    var date = CD.calendarDay(row[1], ctx.tz);
    var snap = snapshotForDate(ctx.snaps, date);
    if (!snap) return done('nocopy', 'No BAS copy for this weekday');
    res.from = snap.date;
    res.exact = snap.exact;
    res.source = sourceText(snap);
    var keys = resolveKeys(snap.rows, entry.programs);
    if (!keys.length) return done('nobas', 'No BAS schedule for this space');
    var from = minuteOfDay(row[1], ctx.tz);
    var to;
    if (!row[2]) to = from + NO_END_MIN;
    else to = CD.calendarDay(row[2], ctx.tz) > date ? 1440 : minuteOfDay(row[2], ctx.tz);
    if (to <= from) to = Math.min(1440, from + NO_END_MIN);
    res.fromMin = from;
    res.toMin = to;
    keys.forEach(function (k) {
      var blocks = (snap.rows[k] || []).concat(groupBlocksOn(ctx.groups, k, date));
      var m = minutesShort(blocks, from, to);
      if (m > res.short) {
        res.short = m;
        res.program = k;
        res.gaps = gapsOf(blocks, from, to);
      }
    });
    if (!res.short) return done('covered', 'Covered');
    return done('short', 'Not covered, ' + res.short + ' min short');
  }

  // --- can the shown events be compared with the BAS copies? ----------------------------------
  // checkStatus(rows, ctx) -> counts of the eventCoverage results for these events (canceled ones are not passed), plus the
  // plain reasons why some events cannot be compared. rows = [[title, start, end, allDay, location]], ctx = { tz, map, snaps }.
  //   checked = covered + short (events that could be compared); skipped = all-day and off-site events (nothing to compare).
  //   uncheckable = total - checked - skipped.
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function checkStatus(rows, ctx) {
    var copyDates = Object.keys(ctx.snaps || {}).filter(function (d) {
      return BD.isDate(d) && ctx.snaps[d] && ctx.snaps[d].rows;
    });
    var out = { total: 0, covered: 0, short: 0, notmapped: 0, offsite: 0, nocopy: 0, nobas: 0, allday: 0, checked: 0, skipped: 0, uncheckable: 0, noCopyDay: 0, noCopyDays: [], noPlace: 0, unmappedPlaces: [], copies: copyDates.length, copyWeekdays: [], reasons: [] };
    var seen = {};
    copyDates.forEach(function (d) {
      var w = WD[dow(d)];
      if (out.copyWeekdays.indexOf(w) === -1) out.copyWeekdays.push(w);
    });
    var order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    out.copyWeekdays.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    (rows || []).forEach(function (row) {
      if (!row || !row[1]) return;
      out.total++;
      var c = eventCoverage(row, ctx);
      if (c.status === 'notmapped') {
        out.notmapped++;
        if (c.space) {
          var u = (seen[c.space] = seen[c.space] || { name: c.space, count: 0 });
          u.count++;
        } else out.noPlace++;
      } else out[c.status] = (out[c.status] || 0) + 1;
      if (c.status !== 'allday' && c.status !== 'offsite') {
        var cd = CD.calendarDay(row[1], ctx.tz);
        if (!snapshotForDate(ctx.snaps, cd)) {
          out.noCopyDay++;
          var wn = WD[dow(cd)];
          if (out.noCopyDays.indexOf(wn) === -1) out.noCopyDays.push(wn);
        }
      }
    });
    out.unmappedPlaces = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
    out.noCopyDays.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    out.checked = out.covered + out.short;
    out.skipped = out.allday + out.offsite;
    out.uncheckable = out.total - out.checked - out.skipped;
    if (out.uncheckable > 0 || out.noCopyDay > 0) {
      if (!out.copies) out.reasons.push('No BAS schedule copy is imported. Import one in the BAS schedules card.');
      if (out.unmappedPlaces.length) {
        out.reasons.push(out.unmappedPlaces.length + (out.unmappedPlaces.length === 1 ? ' place is' : ' places are') + ' not matched to a BAS space (' + out.notmapped + (out.notmapped === 1 ? ' event' : ' events') + '). Match them in the Space map card.');
      }
      if (out.noPlace) out.reasons.push(out.noPlace + (out.noPlace === 1 ? ' event has' : ' events have') + ' no place, so it cannot be matched.');
      if (out.copies && out.noCopyDay) {
        out.reasons.push('Days with no BAS copy (' + out.noCopyDays.join(', ') + '): ' + out.noCopyDay + (out.noCopyDay === 1 ? ' event cannot' : ' events cannot') + ' be checked. BAS copies exist for ' + out.copyWeekdays.join(', ') + (out.copyWeekdays.some(function (w) { return ['Mon', 'Tue', 'Wed', 'Thu'].indexOf(w) !== -1; }) ? ' (one copy covers Mon-Thu)' : '') + '.');
      }
      if (out.nobas) out.reasons.push(out.nobas + (out.nobas === 1 ? ' event is' : ' events are') + ' in a space with no BAS schedule.');
    }
    return out;
  }

  var api = {
    checkStatus: checkStatus,
    spaceKey: spaceKey,
    isServingProgram: isServingProgram,
    isOutOfScopeProgram: isOutOfScopeProgram,
    isUnchecked: isUnchecked,
    isExteriorLighting: isExteriorLighting,
    matchKeys: matchKeys,
    resolveKeys: resolveKeys,
    suggestPrograms: suggestPrograms,
    buildingOfPlace: buildingOfPlace,
    entriesFromCsv: entriesFromCsv,
    snapshotForDate: snapshotForDate,
    sourceText: sourceText,
    minutesShort: minutesShort,
    gapsOf: gapsOf,
    eventCoverage: eventCoverage,
    groupEntryFor: groupEntryFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasCoverage = api;
})(typeof window !== 'undefined' ? window : this);
