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
//   { importedAt, importedBy, groups:{ "<building>|<group>": { building, group, schedules:[...], members:[...] } } }
// History (key en_bas_hist_<pid>): newest first, at most 50 records, one per import (kind 'schedules' or 'groups').
// A schedule change is a difference in the start, end or mode of a program's blocks. Nothing else counts.
(function (root) {
  'use strict';

  var DETAIL_CAP = 500;
  var HIST_MAX = 50;
  var SNAP_MAX = 60;
  var DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
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

  // --- scheduling groups -----------------------------------------------------------------------
  function norm(v) {
    return String(v == null ? '' : v).trim();
  }
  // "Mon-Fri", "Sat, Sun", "Every day", "None" from seven Y/N values in Mon..Sun order.
  function daysText(flags) {
    var on = flags.map(function (f) {
      return /^y/i.test(norm(f));
    });
    var n = on.filter(Boolean).length;
    if (n === 7) return 'Every day';
    if (n === 0) return 'No days';
    if (n === 5 && !on[5] && !on[6]) return 'Mon-Fri';
    if (n === 2 && on[5] && on[6]) return 'Sat, Sun';
    return DAY_NAMES.filter(function (_d, i) {
      return on[i];
    }).join(', ');
  }
  // rows2d = a parsed CSV (arrays). Returns { kind:'schedules'|'members'|'', items:[] }. Columns are found by header name.
  function readGroupRows(rows2d) {
    if (!rows2d || !rows2d.length) return { kind: '', items: [] };
    var head = rows2d[0].map(function (h) {
      return norm(h).toLowerCase();
    });
    var col = function (n) {
      return head.indexOf(n);
    };
    if (col('building') < 0 || col('group') < 0) return { kind: '', items: [] };
    var data = rows2d.slice(1).filter(function (r) {
      return r && !(r.length === 1 && !r[0]) && norm(r[col('building')]) && norm(r[col('group')]);
    });
    var get = function (r, n) {
      return col(n) < 0 ? '' : norm(r[col(n)]);
    };
    if (col('member') >= 0) {
      return {
        kind: 'members',
        items: data.map(function (r) {
          return { building: get(r, 'building'), group: get(r, 'group'), member: get(r, 'member') };
        }),
      };
    }
    if (col('schedule_description') < 0) return { kind: '', items: [] };
    return {
      kind: 'schedules',
      items: data.map(function (r) {
        return {
          building: get(r, 'building'),
          group: get(r, 'group'),
          schedule: {
            description: get(r, 'schedule_description'),
            priority: get(r, 'priority'),
            type: get(r, 'type'),
            days: daysText(
              DAY_KEYS.map(function (d) {
                return get(r, d);
              }),
            ),
            mode: get(r, 'period_mode'),
            start: get(r, 'start'),
            end: get(r, 'end'),
            dates: get(r, 'dates'),
            note: get(r, 'note'),
          },
        };
      }),
    };
  }
  // Builds the groups map from the items of the schedule file(s) and the member file(s). A kind that is not
  // imported keeps what is already stored (oldGroups).
  function buildGroups(oldGroups, scheduleItems, memberItems) {
    var out = {};
    var gk = function (b, g) {
      return b + '|' + g;
    };
    Object.keys(oldGroups || {}).forEach(function (k) {
      var g = oldGroups[k];
      out[k] = {
        building: g.building,
        group: g.group,
        schedules: scheduleItems ? [] : g.schedules.slice(),
        members: memberItems ? [] : g.members.slice(),
      };
    });
    function slot(b, g) {
      var k = gk(b, g);
      if (!out[k]) out[k] = { building: b, group: g, schedules: [], members: [] };
      return out[k];
    }
    (scheduleItems || []).forEach(function (x) {
      slot(x.building, x.group).schedules.push(x.schedule);
    });
    (memberItems || []).forEach(function (x) {
      slot(x.building, x.group).members.push(x.member);
    });
    // A group that lost every schedule and member is gone.
    Object.keys(out).forEach(function (k) {
      if (!out[k].schedules.length && !out[k].members.length) delete out[k];
    });
    return out;
  }
  function scheduleText(s) {
    var hours = s.start || s.end ? s.start + ' - ' + s.end : '';
    return [s.description, s.type, s.days, s.mode, hours, s.dates, s.priority !== 'Normal' ? s.priority : '']
      .filter(Boolean)
      .join(', ');
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
  // The groups import in one call. in: { groups (stored object or null), scheduleItems, memberItems, now, by, id }
  function applyGroupsImport(inp) {
    if (!(inp.scheduleItems && inp.scheduleItems.length) && !(inp.memberItems && inp.memberItems.length)) {
      return { error: 'No scheduling groups found in the file.' };
    }
    var oldGroups = inp.groups ? inp.groups.groups : {};
    var next = buildGroups(oldGroups, inp.scheduleItems, inp.memberItems);
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
      groups: { importedAt: inp.now, importedBy: inp.by || '', groups: next },
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
    daysText: daysText,
    readGroupRows: readGroupRows,
    scheduleText: scheduleText,
    groupText: groupText,
    applyGroupsImport: applyGroupsImport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BasDiff = api;
})(typeof window !== 'undefined' ? window : this);
