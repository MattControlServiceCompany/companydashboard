// app/calendar-diff.js
//
// The ONE place that decides what changed between two calendar snapshots.
// Used by the Project page (app/project-calendar.js) and by tools/test-calendar-feed.js.
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
//
// Snapshot: { window:{start,end}, events:{ <key>: [title, start, end, allDay(0/1), location] } }
// A change is a difference in title, start, end, all-day flag or location. Nothing else counts.
(function (root) {
  'use strict';

  var FIELDS = ['title', 'start', 'end', 'allDay', 'location'];
  var DETAIL_CAP = 500; // longest list stored per group in one history record

  // The overlap of two sync windows. Events outside it may have only fallen off one window edge.
  function overlap(oldWin, newWin) {
    if (!oldWin || !newWin) return null;
    var lo = oldWin.start > newWin.start ? oldWin.start : newWin.start;
    var hi = oldWin.end < newWin.end ? oldWin.end : newWin.end;
    return { start: lo, end: hi };
  }

  function inside(row, win) {
    if (!win) return true;
    var start = row[1];
    if (!start) return true;
    return start >= win.start && start <= win.end;
  }

  function sameRow(a, b) {
    for (var i = 0; i < FIELDS.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Returns { added:[{key,row}], removed:[{key,row}], changed:[{key,fields:{name:[old,new]},row}], unchanged, total }.
  // added/removed count only events inside the overlap of both windows.
  // changed/unchanged compare every key present in both snapshots.
  function diffSnapshots(oldSnap, newSnap) {
    var oldEv = (oldSnap && oldSnap.events) || {};
    var newEv = (newSnap && newSnap.events) || {};
    var win = overlap(oldSnap && oldSnap.window, newSnap && newSnap.window);
    var out = { added: [], removed: [], changed: [], unchanged: 0, total: Object.keys(newEv).length };
    Object.keys(newEv).forEach(function (key) {
      var n = newEv[key];
      var o = Object.prototype.hasOwnProperty.call(oldEv, key) ? oldEv[key] : null;
      if (!o) {
        if (inside(n, win)) out.added.push({ key: key, row: n });
        return;
      }
      if (sameRow(o, n)) {
        out.unchanged++;
        return;
      }
      var fields = {};
      FIELDS.forEach(function (f, i) {
        if (o[i] !== n[i]) fields[f] = [o[i], n[i]];
      });
      out.changed.push({ key: key, fields: fields, row: n });
    });
    Object.keys(oldEv).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(newEv, key) && inside(oldEv[key], win)) {
        out.removed.push({ key: key, row: oldEv[key] });
      }
    });
    return out;
  }

  // One history record from a diff. Lists are cut at DETAIL_CAP; the counts stay exact.
  function historyRecord(diff, at, id) {
    return {
      id: id,
      at: at,
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
        total: diff.total,
      },
      added: diff.added.slice(0, DETAIL_CAP).map(function (x) {
        return { key: x.key, title: x.row[0], start: x.row[1] };
      }),
      removed: diff.removed.slice(0, DETAIL_CAP).map(function (x) {
        return { key: x.key, title: x.row[0], start: x.row[1], row: x.row };
      }),
      changed: diff.changed.slice(0, DETAIL_CAP).map(function (x) {
        return { key: x.key, title: x.row[0], fields: x.fields };
      }),
    };
  }

  // The place of an event. Its own location when it has one. Otherwise the text after the LAST place marker in the title.
  // A place marker is: "@", a hyphen with a space on either side ("Gym- Main", "A - B"), or a hyphen glued between a
  // lowercase letter and a capitalized word ("Practice-LHS Cheer Area"). A hyphen inside a word (in-service, K-12, Pre-K,
  // Mid-Winter) is never a marker.
  // Returns { text, fromTitle }. text is '' when there is no place. Stored data is not changed.
  var PLACE_MARK = /\s-|-\s|@|[a-z]-(?=[A-Z][A-Za-z]{1,})/g;
  var WORD_PREFIX = /(^|[^A-Za-z])(pre|mid|non|co|ex|self|post|anti|semi|multi|re|all|k)$/i;
  function eventPlace(ev) {
    var own = ev && ev.location != null ? String(ev.location).trim() : '';
    if (own) return { text: own, fromTitle: false };
    var title = ev && ev.title != null ? String(ev.title) : '';
    var cut = -1;
    var m;
    PLACE_MARK.lastIndex = 0;
    while ((m = PLACE_MARK.exec(title))) {
      var mark = m[0];
      var at = m.index + mark.length;
      if (/^[a-z]-$/.test(mark) && WORD_PREFIX.test(title.slice(0, m.index + 1))) continue;
      cut = at;
      PLACE_MARK.lastIndex = m.index + 1;
    }
    if (cut < 0) return { text: '', fromTitle: false };
    var t = title.slice(cut).trim();
    return { text: t, fromTitle: !!t };
  }

  // The calendar day (YYYY-MM-DD) of a stored time in the calendar time zone.
  // A date-only value ("2026-10-20") is already a calendar day. It must NOT go through Date, which reads it as UTC midnight.
  var DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  var _fmt = {};
  function calendarDay(iso, tz) {
    if (DATE_ONLY.test(iso)) return iso;
    var f = (_fmt[tz] = _fmt[tz] || new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
    var o = {};
    f.formatToParts(new Date(iso)).forEach(function (x) {
      o[x.type] = x.value;
    });
    return o.year + '-' + o.month + '-' + o.day;
  }
  // Last day of an all-day event. The stored end is exclusive (a 1-day event on 10-20 ends 10-21), so it is one day back.
  function allDayLastDay(start, end, tz) {
    var first = calendarDay(start, tz);
    if (!end) return first;
    var e = calendarDay(end, tz).split('-');
    var last = new Date(Date.UTC(Number(e[0]), Number(e[1]) - 1, Number(e[2]) - 1)).toISOString().slice(0, 10);
    return last > first ? last : first;
  }

  // --- what to show on the District Calendar tab ------------------------------
  // The ONE place that decides which events a view shows and which badge each carries.
  // Badges come only from the last history record (made by diffSnapshots + historyRecord).
  var SPAN = '\u2013';
  var ARROW = '\u2192';
  function addDays(ymd, n) {
    var a = ymd.split('-');
    return new Date(Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2]) + n)).toISOString().slice(0, 10);
  }
  function isAllDay(row) {
    return !!row[3] || DATE_ONLY.test(row[1] || '');
  }
  function clock(iso, tz) {
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  }
  // '3:15 PM - 4:00 PM', '3:15 PM' (no end) or 'All day'.
  function timeText(row, tz) {
    if (!row[1]) return '';
    if (isAllDay(row)) return 'All day';
    return clock(row[1], tz) + (row[2] ? ' ' + SPAN + ' ' + clock(row[2], tz) : '');
  }
  function dayLabel(ymd) {
    var a = ymd.split('-');
    return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // Plain-words lines for a changed event, e.g. 'Time 3:15 PM -> 4:00 PM', 'Location BES Gym -> LHS Main Gym'.
  // newRow is the event as it is now; the old row is the new row with each changed field put back.
  function changeLines(fields, newRow, tz) {
    var out = [];
    var oldRow = newRow.slice();
    FIELDS.forEach(function (f, i) {
      if (fields[f]) oldRow[i] = fields[f][0];
    });
    if (fields.start && oldRow[1] && newRow[1] && calendarDay(oldRow[1], tz) !== calendarDay(newRow[1], tz)) {
      out.push('Date ' + dayLabel(calendarDay(oldRow[1], tz)) + ' ' + ARROW + ' ' + dayLabel(calendarDay(newRow[1], tz)));
    }
    if (fields.start || fields.end || fields.allDay) {
      var o = timeText(oldRow, tz);
      var n = timeText(newRow, tz);
      if (o !== n) out.push('Time ' + (o || 'none') + ' ' + ARROW + ' ' + (n || 'none'));
    }
    if (fields.location) out.push('Location ' + (fields.location[0] || 'none') + ' ' + ARROW + ' ' + (fields.location[1] || 'none'));
    if (fields.title) out.push('Title ' + fields.title[0] + ' ' + ARROW + ' ' + fields.title[1]);
    return out;
  }

  // The first and last calendar day an event covers (all-day events can run several days).
  function eventDays(row, tz) {
    var first = calendarDay(row[1], tz);
    var last = isAllDay(row) ? allDayLastDay(row[1], row[2], tz) : first;
    return [first, last];
  }
  // Does a day span touch the view? mode: 'next14' (today and 13 more days), 'month' (opts.month YYYY-MM), 'past' (before today).
  function inView(days, o) {
    if (o.mode === 'month') return days[1].slice(0, 7) >= o.month && days[0].slice(0, 7) <= o.month;
    if (o.mode === 'past') return days[0] < o.today;
    return days[1] >= o.today && days[0] <= addDays(o.today, 13);
  }

  // opts: { events (snapshot events), last (newest history record or null), tz, today (YYYY-MM-DD), mode, month, q, changesOnly }
  // Returns { items:[{key,row,day,status:'new'|'changed'|'canceled'|'',lines:[]}], counts:{new,changed,canceled}, compared }.
  // counts cover the whole view (not the search or the Changes-only filter). items are sorted by day, then start; 'past' is newest first.
  function listView(o) {
    var compared = !!(o.last && !o.last.first);
    var tag = {};
    var gone = [];
    if (compared) {
      (o.last.added || []).forEach(function (x) { tag[x.key] = { status: 'new', lines: [] }; });
      (o.last.changed || []).forEach(function (x) { tag[x.key] = { status: 'changed', lines: o.events[x.key] ? changeLines(x.fields || {}, o.events[x.key], o.tz) : [] }; });
      (o.last.removed || []).forEach(function (x) {
        if (Object.prototype.hasOwnProperty.call(o.events, x.key)) return;
        gone.push({ key: x.key, row: x.row || [x.title, x.start, '', 0, ''], tag: { status: 'canceled', lines: [] } });
      });
    }
    var all = Object.keys(o.events).map(function (key) {
      return { key: key, row: o.events[key], tag: tag[key] || null };
    }).concat(gone);
    var counts = { 'new': 0, changed: 0, canceled: 0 };
    var q = (o.q || '').trim().toLowerCase();
    var items = [];
    all.forEach(function (e) {
      if (!e.row[1]) return;
      var days = eventDays(e.row, o.tz);
      var inV = inView(days, o);
      if (inV && e.tag) counts[e.tag.status]++;
      var keep = q ? (e.row[0] + ' ' + e.row[4]).toLowerCase().indexOf(q) !== -1 : inV;
      if (!keep || (o.changesOnly && !e.tag)) return;
      // An event that began before today is listed under the first day of the view that it covers.
      var day = days[0];
      if (!q && o.mode === 'next14' && day < o.today) day = o.today;
      items.push({ key: e.key, row: e.row, day: day, status: e.tag ? e.tag.status : '', lines: e.tag ? e.tag.lines : [] });
    });
    var dir = o.mode === 'past' && !q ? -1 : 1;
    items.sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? -dir : dir;
      var x = a.row[1];
      var y = b.row[1];
      return x < y ? -dir : x > y ? dir : 0;
    });
    return { items: items, counts: counts, compared: compared };
  }

  var MARK_DAYS = 7;
  var AUTO_SYNC_MS = 60 * 60 * 1000;

  // Should the tab sync by itself on open? Needs a saved feed, a signed-in user, and a copy older than 1 hour (or none).
  // Client copy of the feed address rule in netlify/functions/lib/calendar/feed-url.mjs (the server stays the real gate).
  // Returns '' when the address looks like a Google Calendar iCal link, else a plain message.
  function feedUrlProblem(value) {
    var u;
    try {
      u = new URL(String(value || ''));
    } catch (e) {
      return 'That is not a web address. Paste the secret address in iCal format from Google Calendar.';
    }
    if (u.protocol !== 'https:' || u.hostname !== 'calendar.google.com' || u.port || u.username || u.password || !/\.ics$/i.test(u.pathname)) {
      return 'That is not a Google Calendar feed. The address must start with https://calendar.google.com and end in .ics.';
    }
    return '';
  }

  function needsAutoSync(o) {
    if (!o.cfg || !o.token) return false;
    var t = o.snap && o.snap.fetchedAt ? Date.parse(o.snap.fetchedAt) : NaN;
    return isNaN(t) || o.nowMs - t > AUTO_SYNC_MS;
  }

  // The marks to show: every New / Changed / Canceled from the kept history records (newest first) that were first seen
  // in the last 7 days, and whose event date has not passed. The newest record wins for each event.
  // Returns a record shaped like a history record ({added, removed, changed}) for listView, or the newest record when
  // there is nothing to carry (no history, or only the first copy).
  function carriedMarks(hist, o) {
    if (!hist || !hist.length || hist[0].first) return hist && hist[0] ? hist[0] : null;
    var cd = new Date(o.nowMs);
    cd.setUTCDate(cd.getUTCDate() - MARK_DAYS);
    var cutoff = cd.getTime();
    var by = {};
    for (var i = hist.length - 1; i >= 0; i--) {
      var r = hist[i];
      if (r.first || Date.parse(r.at) < cutoff) continue;
      ['added', 'changed', 'removed'].forEach(function (kind) {
        (r[kind] || []).forEach(function (x) { by[x.key] = { kind: kind, x: x }; });
      });
    }
    var out = { at: hist[0].at, added: [], changed: [], removed: [] };
    Object.keys(by).forEach(function (key) {
      var m = by[key];
      var row = m.kind === 'removed' ? m.x.row : o.events[key];
      if (!row || !row[1]) return;
      if (eventDays(row, o.tz)[1] < o.today) return;
      out[m.kind].push(m.x);
    });
    return out;
  }

  var api = {
    MARK_DAYS: MARK_DAYS,
    needsAutoSync: needsAutoSync,
    feedUrlProblem: feedUrlProblem,
    carriedMarks: carriedMarks,
    calendarDay: calendarDay,
    allDayLastDay: allDayLastDay,
    FIELDS: FIELDS,
    DETAIL_CAP: DETAIL_CAP,
    diffSnapshots: diffSnapshots,
    historyRecord: historyRecord,
    eventPlace: eventPlace,
    listView: listView,
    timeText: timeText,
    dayLabel: dayLabel,
    changeLines: changeLines,
    addDays: addDays,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalendarDiff = api;
})(typeof window !== 'undefined' ? window : this);
