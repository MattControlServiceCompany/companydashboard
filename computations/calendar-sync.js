// computations/calendar-sync.js
//
// The ONE place that decides what "Sync now" saves for one project's calendar: the history record and list (en_cal_hist_<pid>),
// the new copy (en_cal_snap_<pid>), and the schedule actions that follow from it (en_sched_actions_<pid>, en_bas_acthist_<pid>).
// Pure: no DOM, no storage, no network. Works as a browser script and as a CommonJS module.
// Used by the page (app/project-calendar.js `sync`) and by the daily update (scripts/calendar-daily-sync.js).
// The comparison is CalendarDiff.diffSnapshots; the actions are SchedActions.persistPlan. Nothing is repeated here.
//
//   savedCopy(fresh)                   -> the fields of a feed read that are saved (en_cal_snap_<pid>)
//   historyRecord(old, snap, id)       -> the record for en_cal_hist_<pid> (first copy: all events unchanged)
//   historyList(rec, hist)             -> the new en_cal_hist_<pid> list (newest first, 50 kept)
//   hasChange(old, snap)               -> true when the feed differs from the saved copy (added, removed or changed events)
//   plan(o)  o = { pid, snap, io, ids:{ hist, act } }  io = SchedActions.buildInput io (get, matrixRows, manualRows, auditList, now)
//            -> { writes:{ <key>: value }, counts, first }  writes = the keys to save, in order
(function (root) {
  'use strict';

  var CD = typeof require === 'function' && typeof module !== 'undefined' ? require('../app/calendar-diff.js') : root.CalendarDiff;
  var SA = typeof require === 'function' && typeof module !== 'undefined' ? require('./sched-actions.js') : root.SchedActions;

  var HIST_MAX = 50;

  // The saved copy of a feed read (what calendar-fetch returns): only these fields are kept in en_cal_snap_<pid>.
  function savedCopy(fresh) {
    return { fetchedAt: fresh.fetchedAt, count: fresh.count, window: fresh.window, leftOut: fresh.leftOut || [], events: fresh.events };
  }
  function historyRecord(old, snap, id) {
    if (old) return CD.historyRecord(CD.diffSnapshots(old, snap), snap.fetchedAt, id);
    return {
      id: id,
      at: snap.fetchedAt,
      first: true,
      counts: { added: 0, removed: 0, changed: 0, unchanged: snap.count, total: snap.count },
      added: [],
      removed: [],
      changed: [],
    };
  }
  function historyList(rec, hist) {
    return [rec].concat(Array.isArray(hist) ? hist : []).slice(0, HIST_MAX);
  }
  function hasChange(old, snap) {
    if (!old) return true;
    var d = CD.diffSnapshots(old, snap);
    return d.added.length + d.removed.length + d.changed.length > 0;
  }
  function plan(o) {
    var pid = o.pid;
    var io = o.io;
    var old = io.get('en_cal_snap_' + pid, null);
    var rec = historyRecord(old, o.snap, o.ids.hist);
    var writes = {};
    writes['en_cal_hist_' + pid] = historyList(rec, io.get('en_cal_hist_' + pid, []));
    writes['en_cal_snap_' + pid] = o.snap;
    // The actions are worked out against the NEW copy, as the page does after it saves the copy.
    var after = Object.assign({}, io, {
      get: function (key, fb) {
        return key === 'en_cal_snap_' + pid ? o.snap : io.get(key, fb);
      },
    });
    var act = SA.persistPlan(SA.buildInput(after, pid), io.get('en_bas_acthist_' + pid, []), o.ids.act);
    if (act) {
      writes['en_sched_actions_' + pid] = act.stored;
      writes['en_bas_acthist_' + pid] = act.hist;
    }
    return { writes: writes, counts: rec.counts, first: !!rec.first };
  }

  var api = { savedCopy: savedCopy, historyRecord: historyRecord, historyList: historyList, hasChange: hasChange, plan: plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalendarSync = api;
})(typeof window !== 'undefined' ? window : this);
