// app/bas-diff.js
//
// The ONE place that decides what changed between two BAS schedule snapshots, which earlier snapshot an
// import is compared with, and how a scheduling-group import is read. Used by the BAS schedules section of
// the District Calendar tab (app/bas-schedules.js) and by tools/test-bas-diff.js.
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
//
// Snapshots (key en_bas_snap_<pid>) are ONE object keyed by the date the export covers:
//   { "2026-10-29": { forDate, importedAt, importedBy, rows:{ "<location>|<program>": [[start, end, mode], ...] } } }
//   start and end are minutes since midnight. mode is 'occ' or 'unocc'. Buildings imported for the same
//   date merge into the same snapshot; importing a building again replaces that building's rows.
// Groups (key en_bas_groups_<pid>):
//   { importedAt, importedBy, groups:{ "<building>|<group>": { building, group, schedules:[...], members:[...] } },
//     locations:[{ location, building, area, schedule }] }   (read from the WebCTRL Schedules report; see readGroupRows)
// History (key en_bas_hist_<pid>): newest first, at most 50 records, one per import (kind 'schedules' or 'groups').
// A schedule change is a difference in the start, end or mode of a program's blocks. Nothing else counts.
(function (root) {
  'use strict';

  var DETAIL_CAP = 500;
  var HIST_MAX = 50;
  var SNAP_MAX = 60;
  var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // --- dates -----------------------------------------------------------------------------------
  function isDate(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return false;
    var d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)));
    return d.toISOString().slice(0, 10) === ymd;
  }
  // 'weekday' (Mon-Fri), 'sat' or 'sun'. Schedules are compared with a day of the same type.
  function dayType(ymd) {
    var wd = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).getUTCDay();
    return wd === 0 ? 'sun' : wd === 6 ? 'sat' : 'weekday';
  }
  // 'Thu Oct 29, 2026'
  function dateText(ymd) {
    var d = new Date(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '');
  }

  // --- names -----------------------------------------------------------------------------------
  // The building of a WebCTRL location "/District/Building/Area/...": the second part of the path.
  function buildingOf(location) {
    var parts = String(location || '')
      .split('/')
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
    if (parts.length >= 2) return parts[1];
    return parts[0] || 'Unknown building';
  }
  // The area of a WebCTRL location "/District/Building/Floor/Area": every node after the building, joined with " / ".
  // "" when the path ends at the building (the program sits at building level). The ONE place that cuts the area from a path.
  function areaOf(location) {
    var parts = String(location || '')
      .split('/')
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
    return parts.slice(2).join(' / ');
  }
  // "<location>|<program>" -> parts. A program name may hold '|'; a location does not.
  function splitKey(key) {
    var j = key.indexOf('|');
    return { location: key.slice(0, j), program: key.slice(j + 1) };
  }
  function keyBuilding(key) {
    return buildingOf(splitKey(key).location);
  }

  // --- time text -------------------------------------------------------------------------------
  // Minutes since midnight -> "5:00 AM".
  function clock(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    var ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  // Blocks -> "Occupied 5:00 AM - 9:00 PM". Unoccupied blocks are left out; no occupied block = "Unoccupied all day".
  // A program with no block at all has no schedule in the file.
  function blocksText(blocks) {
    if (!blocks || !blocks.length) return 'No schedule in file';
    var occ = blocks.filter(function (b) {
      return b[2] === 'occ';
    });
    if (!occ.length) return 'Unoccupied all day';
    return (
      'Occupied ' +
      occ
        .map(function (b) {
          return clock(b[0]) + ' - ' + clock(b[1]);
        })
        .join('; ')
    );
  }

  // --- snapshot rows ---------------------------------------------------------------------------
  // parsed = the rows of emParseEffectiveSchedulesCSV; blocksOf = _emScheduleBlocks (the one block reader).
  // Two rows with the same location and program get " #2", " #3" after the program so none is lost.
  function rowsFromParsed(parsed, blocksOf) {
    var rows = {};
    parsed.forEach(function (p) {
      var key = p.location + '|' + p.controlProgram;
      var n = 1;
      while (Object.prototype.hasOwnProperty.call(rows, key)) {
        n++;
        key = p.location + '|' + p.controlProgram + ' #' + n;
      }
      rows[key] = blocksOf(p.scheduleText);
    });
    return rows;
  }
  // { "High School": 437, ... } from a rows map.
  function buildingCounts(rows) {
    var out = {};
    Object.keys(rows).forEach(function (k) {
      var b = keyBuilding(k);
      out[b] = (out[b] || 0) + 1;
    });
    return out;
  }
  function rowsOfBuildings(rows, buildings) {
    var out = {};
    Object.keys(rows || {}).forEach(function (k) {
      if (buildings.indexOf(keyBuilding(k)) >= 0) out[k] = rows[k];
    });
    return out;
  }

  // --- the one comparison ----------------------------------------------------------------------
  function sameBlocks(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
    }
    return true;
  }
  // Compares two maps key by key. same(a, b) says whether two values are equal.
  // Returns { added:[{key,value}], removed:[{key,value}], changed:[{key,before,after}], unchanged, total }.
  function diffMaps(oldMap, newMap, same) {
    var has = Object.prototype.hasOwnProperty;
    var out = { added: [], removed: [], changed: [], unchanged: 0, total: Object.keys(newMap).length };
    Object.keys(newMap).forEach(function (key) {
      if (!has.call(oldMap, key)) out.added.push({ key: key, value: newMap[key] });
      else if (same(oldMap[key], newMap[key])) out.unchanged++;
      else out.changed.push({ key: key, before: oldMap[key], after: newMap[key] });
    });
    Object.keys(oldMap).forEach(function (key) {
      if (!has.call(newMap, key)) out.removed.push({ key: key, value: oldMap[key] });
    });
    return out;
  }
  function diffBasSnapshots(oldRows, newRows) {
    return diffMaps(oldRows, newRows, sameBlocks);
  }

  // The earlier snapshot an import for forDate is compared with:
  // the same date (a corrected export), else the latest earlier date of the same day type,
  // else the latest other date of any type. Returns the snapshot or null.
  function pickBaseline(snaps, forDate) {
    if (snaps[forDate]) return snaps[forDate];
    var dates = Object.keys(snaps).sort();
    var type = dayType(forDate);
    var best = null;
    dates.forEach(function (d) {
      if (d < forDate && dayType(d) === type) best = d;
    });
    if (!best) {
      dates.forEach(function (d) {
        if (d !== forDate) best = d;
      });
    }
    return best ? snaps[best] : null;
  }

  function cut(list, mapper) {
    return list.slice(0, DETAIL_CAP).map(mapper);
  }
  function counts(diff) {
    return {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      unchanged: diff.unchanged,
      total: diff.total,
    };
  }

  // --- schedule import -------------------------------------------------------------------------
  // The whole import in one call. in: { snaps, hist, rows, forDate, now (ISO), by, id }
  // out: { error } or { snaps, hist, rec }. Nothing is stored here; the caller writes snaps and hist.
  function applyScheduleImport(inp) {
    if (!isDate(inp.forDate)) return { error: 'Choose the date this export covers.' };
    var rowKeys = Object.keys(inp.rows || {});
    if (!rowKeys.length) return { error: 'No schedules found in the file.' };
    var buildings = Object.keys(buildingCounts(inp.rows)).sort();
    var base = pickBaseline(inp.snaps, inp.forDate);
    var baseRows = base ? rowsOfBuildings(base.rows, buildings) : {};
    var compared = Object.keys(baseRows).length > 0;
    var rec = {
      id: inp.id,
      kind: 'schedules',
      at: inp.now,
      by: inp.by || '',
      forDate: inp.forDate,
      comparedTo: compared ? base.forDate : '',
      buildings: buildings.map(function (b) {
        return { name: b, programs: buildingCounts(inp.rows)[b] };
      }),
      first: !compared,
      counts: { added: 0, removed: 0, changed: 0, unchanged: rowKeys.length, total: rowKeys.length },
      byBuilding: {},
      added: [],
      removed: [],
      changed: [],
    };
    if (compared) {
      var d = diffBasSnapshots(baseRows, inp.rows);
      rec.counts = counts(d);
      rec.added = cut(d.added, function (x) {
        return { key: x.key, blocks: x.value };
      });
      rec.removed = cut(d.removed, function (x) {
        return { key: x.key, blocks: x.value };
      });
      rec.changed = cut(d.changed, function (x) {
        return { key: x.key, before: x.before, after: x.after };
      });
      buildings.forEach(function (b) {
        rec.byBuilding[b] = { added: 0, removed: 0, changed: 0 };
      });
      d.added.forEach(function (x) {
        rec.byBuilding[keyBuilding(x.key)].added++;
      });
      d.removed.forEach(function (x) {
        rec.byBuilding[keyBuilding(x.key)].removed++;
      });
      d.changed.forEach(function (x) {
        rec.byBuilding[keyBuilding(x.key)].changed++;
      });
    }
    // Merge into the snapshot of that date: the imported buildings replace their old rows.
    var snaps = Object.assign({}, inp.snaps);
    var old = snaps[inp.forDate];
    var rows = {};
    if (old) {
      Object.keys(old.rows).forEach(function (k) {
        if (buildings.indexOf(keyBuilding(k)) < 0) rows[k] = old.rows[k];
      });
    }
    Object.keys(inp.rows).forEach(function (k) {
      rows[k] = inp.rows[k];
    });
    snaps[inp.forDate] = { forDate: inp.forDate, importedAt: inp.now, importedBy: inp.by || '', rows: rows };
    var dates = Object.keys(snaps).sort();
    while (dates.length > SNAP_MAX) delete snaps[dates.shift()];
    return { snaps: snaps, hist: [rec].concat(inp.hist || []).slice(0, HIST_MAX), rec: rec };
  }

  // --- scheduling groups and location schedules (the WebCTRL "Schedules" report) --------------
  // The ONE reader of the native WebCTRL Schedules report (CSV "Location","Priority","Description"). Part 1 lists schedules on
  // locations; after the row "Schedule Groups:" come the groups ("Building / Group"), the 2nd and later schedules of a group on
  // continuation rows whose first cells are empty. Description = name line, optional days or dates line, then period lines.
  // Stored schedule: { name, priority, type:'weekly'|'date'|'range'|'recurring', days:['Mon',..], dates:['YYYY-MM-DD',..] (date),
  //   from, to ('YYYY-MM-DD', range), recur:{month,day,nth,dow} (recurring; 0 / '' = any, nth -1 = last),
  //   periods:[{mode:'occ'|'unocc', from, to}] (minutes of a day; an end at or before the start is stored as 1440), raw:'days or dates line' }.
  var CLOCK_RE = '(\\d{1,2}):(\\d{2})\\s*(AM|PM)';
  var PERIOD_RE = new RegExp('^(Occupied|Unoccupied)\\s+from\\s+' + CLOCK_RE + '\\s+to\\s+' + CLOCK_RE + '$', 'i');
  var DAY_LIST_RE = /^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s*,\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)?\s*(.*)$/;
  var DATE_RE = '(\\d{1,2})/(\\d{1,2})/(\\d{4})';
  function norm(v) {
    return String(v == null ? '' : v).trim();
  }
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function isoOf(m, d, y) {
    return y + '-' + pad2(+m) + '-' + pad2(+d);
  }
  function minuteOf(h, m, ap) {
    return (+h % 12) * 60 + +m + (ap.toUpperCase() === 'PM' ? 720 : 0);
  }
  // The weekday name ('Mon'..'Sun') of YYYY-MM-DD.
  function weekdayOf(ymd) {
    var wd = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).getUTCDay();
    return DAY_NAMES[(wd + 6) % 7];
  }
  // "Mon,Wed" / "2/16/2026 - 12/31/2026" / "Wed,Thu  9/24/2026 - 2/26/2027" / "Every 2/28/* *" / "Every 2nd */*/* Mon" -> the when-part of a schedule.
  function parseWhen(line) {
    var out = { type: 'weekly', days: [], dates: [], from: '', to: '', recur: null, raw: norm(line) };
    var m = DAY_LIST_RE.exec(norm(line));
    if (m[1]) out.days = m[1].split(/\s*,\s*/);
    var rest = norm(m[2]);
    var r;
    if (!rest) return out;
    if ((r = new RegExp('^' + DATE_RE + '\\s*-\\s*' + DATE_RE + '$').exec(rest))) {
      out.type = 'range';
      out.from = isoOf(r[1], r[2], r[3]);
      out.to = isoOf(r[4], r[5], r[6]);
    } else if (new RegExp('^' + DATE_RE + '(\\s*,\\s*' + DATE_RE + ')*$').test(rest)) {
      out.type = 'date';
      var re = new RegExp(DATE_RE, 'g');
      var x;
      while ((x = re.exec(rest))) out.dates.push(isoOf(x[1], x[2], x[3]));
    } else if ((r = /^Every\s+(?:(\d+)(?:st|nd|rd|th)\s+|(Last)\s+)?(\d+|\*)\/(\d+|\*)\/(\d+|\*)\s*(\*|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?$/i.exec(rest))) {
      out.type = 'recurring';
      out.recur = {
        month: r[3] === '*' ? 0 : +r[3],
        day: r[4] === '*' ? 0 : +r[4],
        nth: r[2] ? -1 : r[1] ? +r[1] : 0,
        dow: !r[6] || r[6] === '*' ? '' : r[6].charAt(0).toUpperCase() + r[6].slice(1).toLowerCase(),
      };
    }
    return out;
  }
  // One Description cell -> a stored schedule, or null when it has no name, no days and no period.
  function parseDescription(desc, priority) {
    var lines = String(desc == null ? '' : desc).split(/\r?\n/).map(norm).filter(Boolean);
    var periods = [];
    var pre = [];
    lines.forEach(function (ln) {
      var m = PERIOD_RE.exec(ln);
      if (m) {
        var from = minuteOf(m[2], m[3], m[4]);
        var to = minuteOf(m[5], m[6], m[7]);
        periods.push({ mode: /^occ/i.test(m[1]) ? 'occ' : 'unocc', from: from, to: to <= from ? 1440 : to });
      } else if (!periods.length) pre.push(ln);
    });
    var name = '';
    var whenLine = '';
    if (pre.length >= 2) {
      name = pre[0];
      whenLine = pre[1];
    } else if (pre.length === 1) {
      var w = parseWhen(pre[0]);
      if (w.days.length || w.type !== 'weekly' || /^Every\b/i.test(pre[0])) whenLine = pre[0];
      else name = pre[0];
    }
    if (!name && !whenLine && !periods.length) return null;
    return Object.assign({ name: name, priority: norm(priority) || 'Normal' }, parseWhen(whenLine), { periods: periods });
  }
  // rows2d = the parsed CSV. Returns { kind:'schedules'|'', locations:[{ location, building, area, schedule }], items:[{ building, group, schedule }] }.
  function readGroupRows(rows2d) {
    var none = { kind: '', locations: [], items: [] };
    if (!rows2d || !rows2d.length) return none;
    var head = rows2d[0].map(function (h) {
      return norm(h).toLowerCase();
    });
    if (head[0] !== 'location' || head[1] !== 'priority' || head[2] !== 'description') return none;
    var out = { kind: 'schedules', locations: [], items: [] };
    var inGroups = false;
    var cur = null; // the group of the last group row (continuation rows belong to it)
    rows2d.slice(1).forEach(function (r) {
      if (!r || !r.length || (r.length === 1 && !norm(r[0]))) return;
      var first = norm(r[0]);
      if (/^schedule groups:?$/i.test(first)) {
        inGroups = true;
        return;
      }
      if (!inGroups) {
        var s = parseDescription(r[2], r[1]);
        if (first && s) out.locations.push({ location: first, building: buildingOf(first), area: areaOf(first), schedule: s });
        return;
      }
      var cont = !first; // continuation row: the first cells are empty; priority and description are the last two cells
      var sc = parseDescription(r[r.length - 1], cont ? r[r.length - 2] : r[1]);
      if (!cont) {
        var at = first.indexOf(' / ');
        cur = at < 0 ? { building: '', group: first } : { building: norm(first.slice(0, at)), group: norm(first.slice(at + 3)) };
      }
      if (cur && sc) out.items.push({ building: cur.building, group: cur.group, schedule: sc });
    });
    // WebCTRL also prints every group schedule in part 1, all under one location (seen 2026-11-12: 61 of 61 under "East Entry Way
    // Exterior Lights"). A location whose part-1 rows are all exact copies of group schedules is that listing, not real location schedules.
    var key = function (s) {
      return JSON.stringify([s.name, s.priority, s.raw, s.periods]);
    };
    var inGroup = {};
    out.items.forEach(function (x) {
      inGroup[key(x.schedule)] = true;
    });
    var copyOnly = {};
    out.locations.forEach(function (l) {
      if (copyOnly[l.location] === undefined) copyOnly[l.location] = true;
      if (!inGroup[key(l.schedule)]) copyOnly[l.location] = false;
    });
    out.locations = out.locations.filter(function (l) {
      return !copyOnly[l.location];
    });
    return out;
  }

  // --- reading a stored schedule -------------------------------------------------------------
  // "12:00 AM-8:00 AM and 4:45 PM-12:00 AM"; unoccupied periods read "Unoccupied 12:00 AM-5:00 AM".
  function periodsText(s) {
    return ((s && s.periods) || [])
      .map(function (p) {
        return (p.mode === 'occ' ? '' : 'Unoccupied ') + clock(p.from) + '-' + clock(p.to >= 1440 ? 0 : p.to);
      })
      .join(' and ');
  }
  function mdy(iso) {
    return +iso.slice(5, 7) + '/' + +iso.slice(8, 10) + '/' + iso.slice(0, 4);
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', '-1': 'last' };
  // A WEEKLY schedule with no day of the week selected is NOT active: it never runs (Matt 2026-11-12). The ONE rule of "active".
  // Active: a weekly schedule with weekdays, a schedule on specific dates, a recurring one with a date or a weekday, and a date range
  // (a range with no weekday runs on EVERY day of the range, a range with weekdays only on those days: WebCTRL 2026-11-12).
  function scheduleActive(s) {
    if (!s || !Array.isArray(s.periods) || !Array.isArray(s.days)) return false; // a schedule saved in an older shape is read as not active until the report is imported again
    if (s.type === 'date') return !!(s.dates && s.dates.length);
    if (s.type === 'recurring') return !!(s.recur && (s.recur.day || s.recur.dow));
    if (s.type === 'range') return !!(s.from && s.to);
    return !!(s.days && s.days.length);
  }
  // The days or dates of a schedule as words: 'Mon,Tue', 'every day', '11/12/2026', '2/16/2026 - 12/31/2026', 'No days selected (not active)'.
  function whenText(s) {
    if (!s) return '';
    if (!scheduleActive(s)) return 'No days selected (not active)';
    var dayPart = s.days && s.days.length === 7 ? 'every day' : (s.days || []).join(',');
    if (s.type === 'date') return s.dates.map(mdy).join(', ');
    if (s.type === 'range') return (dayPart || 'every day') + ' ' + mdy(s.from) + ' - ' + mdy(s.to);
    if (s.type === 'recurring') {
      var r = s.recur;
      if (r.day) return 'every ' + (r.month ? MONTHS[r.month - 1] + ' ' : '') + r.day;
      return (r.nth ? ORD[r.nth] + ' ' : 'every ') + r.dow + (r.month ? ' in ' + MONTHS[r.month - 1] : r.nth ? ' of every month' : '');
    }
    return dayPart;
  }
  // Does the schedule run on YYYY-MM-DD (days, dates, date range, recurrence)? An inactive schedule never does.
  function scheduleAppliesOn(s, ymd) {
    if (!scheduleActive(s) || !isDate(ymd)) return false;
    var wd = weekdayOf(ymd);
    if (s.type === 'date') return s.dates.indexOf(ymd) !== -1;
    if (s.type === 'range') return ymd >= s.from && ymd <= s.to && (!s.days.length || s.days.indexOf(wd) !== -1);
    if (s.type === 'recurring') {
      var r = s.recur;
      var day = +ymd.slice(8, 10);
      if (r.month && r.month !== +ymd.slice(5, 7)) return false;
      if (r.day && r.day !== day) return false;
      if (r.dow && r.dow !== wd) return false;
      if (r.nth > 0 && Math.ceil(day / 7) !== r.nth) return false;
      if (r.nth < 0 && day + 7 <= new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7), 0)).getUTCDate()) return false;
      return true;
    }
    return s.days.indexOf(wd) !== -1;
  }
  // The occupied blocks [[from,to,'occ']] a schedule gives on one date. Unoccupied periods give none (they never count as coverage).
  function scheduleBlocksOn(s, ymd) {
    if (!scheduleAppliesOn(s, ymd)) return [];
    return s.periods
      .filter(function (p) {
        return p.mode === 'occ';
      })
      .map(function (p) {
        return [p.from, p.to, 'occ'];
      });
  }
  // WebCTRL priority: Override beats Holiday beats Normal.
  function priorityRank(s) {
    return /override/i.test(s.priority || '') ? 3 : /holiday/i.test(s.priority || '') ? 2 : 1;
  }
  // The ONE reader of what a set of schedules (one scheduling group) does on one date. For each minute of the day, the highest-priority
  // schedule that runs on the date and has a period covering that minute decides; a minute that no higher schedule covers falls
  // through to the lower ones. At equal priority an occupied period wins over an unoccupied one.
  // Returns { occ:[[from,to]], forcedUnocc:[[from,to]] } (minutes of the day). forcedUnocc = minutes that a Holiday or Override period
  // decides unoccupied: the BAS copy of another date must not count them as occupied.
  function effectiveBlocksOn(schedules, ymd) {
    var live = (schedules || []).filter(function (s) {
      return scheduleAppliesOn(s, ymd);
    });
    var occ = [];
    var forced = [];
    var push = function (list, m) {
      var last = list[list.length - 1];
      if (last && last[1] === m) last[1] = m + 1;
      else list.push([m, m + 1]);
    };
    for (var m = 0; m < 1440; m++) {
      var best = 0;
      var occHere = false;
      live.forEach(function (s) {
        var r = priorityRank(s);
        s.periods.forEach(function (p) {
          if (m < p.from || m >= p.to) return;
          if (r > best) {
            best = r;
            occHere = p.mode === 'occ';
          } else if (r === best && p.mode === 'occ') occHere = true;
        });
      });
      if (!best) continue;
      if (occHere) push(occ, m);
      else if (best > 1) push(forced, m);
    }
    return { occ: occ, forcedUnocc: forced };
  }
  // 'LRC BBall Practice- BES Gym, Tue,Wed, 5:00 PM-8:30 PM'
  function scheduleText(s) {
    return [s.name, whenText(s), periodsText(s), s.priority !== 'Normal' ? s.priority : ''].filter(Boolean).join(', ');
  }
  // Builds the groups map from the schedule items of the report. Members are not in the report: the stored members of a group stay.
  function buildGroups(oldGroups, scheduleItems) {
    var out = {};
    Object.keys(oldGroups || {}).forEach(function (k) {
      var g = oldGroups[k];
      out[k] = { building: g.building, group: g.group, schedules: [], members: (g.members || []).slice() };
    });
    scheduleItems.forEach(function (x) {
      var k = x.building + '|' + x.group;
      if (!out[k]) out[k] = { building: x.building, group: x.group, schedules: [], members: [] };
      out[k].schedules.push(x.schedule);
    });
    // A group that lost every schedule and member is gone.
    Object.keys(out).forEach(function (k) {
      if (!out[k].schedules.length && !out[k].members.length) delete out[k];
    });
    return out;
  }
  // One text per group, the thing that is compared and shown in a change line.
  function groupText(g) {
    return (
      g.schedules.map(scheduleText).join('; ') +
      ' | ' +
      g.members.length +
      ' members' +
      (g.members.length ? ': ' + g.members.slice().sort().join('; ') : '')
    );
  }
  function sameGroup(a, b) {
    return groupText(a) === groupText(b);
  }
  // The import in one call. in: { groups (stored object or null), scheduleItems, locationItems, now, by, id }
  function applyGroupsImport(inp) {
    var locs = inp.locationItems || [];
    if (!(inp.scheduleItems && inp.scheduleItems.length) && !locs.length) {
      return { error: 'No schedules found in the file.' };
    }
    var oldGroups = inp.groups ? inp.groups.groups : {};
    var next = buildGroups(oldGroups, inp.scheduleItems || []);
    var d = diffMaps(oldGroups, next, sameGroup);
    var had = Object.keys(oldGroups).length > 0;
    var buildings = {};
    Object.keys(next).forEach(function (k) {
      buildings[next[k].building] = (buildings[next[k].building] || 0) + 1;
    });
    var rec = {
      id: inp.id,
      kind: 'groups',
      at: inp.now,
      by: inp.by || '',
      first: !had,
      locations: locs.length,
      buildings: Object.keys(buildings)
        .sort()
        .map(function (b) {
          return { name: b, programs: buildings[b] };
        }),
      counts: had
        ? counts(d)
        : { added: 0, removed: 0, changed: 0, unchanged: Object.keys(next).length, total: Object.keys(next).length },
      byBuilding: {},
      added: [],
      removed: [],
      changed: [],
    };
    if (had) {
      rec.added = cut(d.added, function (x) {
        return { key: x.key, text: groupText(x.value) };
      });
      rec.removed = cut(d.removed, function (x) {
        return { key: x.key, text: groupText(x.value) };
      });
      rec.changed = cut(d.changed, function (x) {
        return { key: x.key, before: groupText(x.before), after: groupText(x.after) };
      });
    }
    return {
      groups: { importedAt: inp.now, importedBy: inp.by || '', groups: next, locations: locs },
      hist: [rec].concat(inp.hist || []).slice(0, HIST_MAX),
      rec: rec,
    };
  }

  var api = {
    DETAIL_CAP: DETAIL_CAP,
    HIST_MAX: HIST_MAX,
    SNAP_MAX: SNAP_MAX,
    isDate: isDate,
    dayType: dayType,
    dateText: dateText,
    buildingOf: buildingOf,
    areaOf: areaOf,
    splitKey: splitKey,
    keyBuilding: keyBuilding,
    clock: clock,
    blocksText: blocksText,
    rowsFromParsed: rowsFromParsed,
    buildingCounts: buildingCounts,
    diffMaps: diffMaps,
    diffBasSnapshots: diffBasSnapshots,
    pickBaseline: pickBaseline,
    applyScheduleImport: applyScheduleImport,
    weekdayOf: weekdayOf,
    parseWhen: parseWhen,
    parseDescription: parseDescription,
    readGroupRows: readGroupRows,
    scheduleActive: scheduleActive,
    scheduleAppliesOn: scheduleAppliesOn,
    scheduleBlocksOn: scheduleBlocksOn,
    effectiveBlocksOn: effectiveBlocksOn,
    periodsText: periodsText,
    whenText: whenText,
    scheduleText: scheduleText,
    groupText: groupText,
    applyGroupsImport: applyGroupsImport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasDiff = api;
})(typeof window !== 'undefined' ? window : this);
