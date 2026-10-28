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
        return { key: x.key, title: x.row[0], start: x.row[1] };
      }),
      changed: diff.changed.slice(0, DETAIL_CAP).map(function (x) {
        return { key: x.key, title: x.row[0], fields: x.fields };
      }),
    };
  }

  // The place of an event. Its own location when it has one. Otherwise the text after the LAST hyphen of the title.
  // Returns { text, fromTitle }. text is '' when there is no place. Stored data is not changed.
  function eventPlace(ev) {
    var own = ev && ev.location != null ? String(ev.location).trim() : '';
    if (own) return { text: own, fromTitle: false };
    var title = ev && ev.title != null ? String(ev.title) : '';
    var i = title.lastIndexOf('-');
    if (i < 0) return { text: '', fromTitle: false };
    var t = title.slice(i + 1).trim();
    return { text: t, fromTitle: !!t };
  }

  var api = {
    FIELDS: FIELDS,
    DETAIL_CAP: DETAIL_CAP,
    diffSnapshots: diffSnapshots,
    historyRecord: historyRecord,
    eventPlace: eventPlace,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalendarDiff = api;
})(typeof window !== 'undefined' ? window : this);
