// app/sched-actions.js
//
// "To do in WebCTRL" card of the Project page, District Calendar tab. It follows the shown period of the calendar
// (Day / Week / Month / Year, window.pcalPeriod): one row for each change to make in WebCTRL for the events of that period, with a Done
// button; below, collapsed: what is covered, optional shorter schedules, events that could not be checked, and a short list of BAS
// schedules occupied all day with no event. Events dated after the period are one line ("Later").
// This file only draws the result and saves it. The rules (which events need a change, closing and reopening, waste) are in
// computations/sched-actions.js (SchedActions); the coverage decision is BasCoverage.coverageOf (computations/bas-coverage.js).
//
// Data (shared keys, read and written only through DB.get / DB.set):
//   en_sched_actions_<pid>  { actions:{ "<event id>": { id, date, text, program, status, openedAt, doneBy, doneAt, closedAt, note } } }  class SYNCED
//   en_bas_acthist_<pid>    one record (kind 'action') for each save that changed an action: who, when, what. Its own list (50), so actions never push out BAS import history (en_bas_hist_).
// Reads en_cal_snap_<pid>, en_cal_cfg_<pid>, en_space_map_<pid>, en_bas_snap_<pid>, en_bas_groups_<pid>, en_bas_auditevents_<pid> (only through BasAuditLog.changeList).
//
// Network: none. Opening the tab only reads saved data and works out the list in memory. The list is saved
// after a calendar sync (project-calendar.js), after a BAS import (bas-schedules.js), and when a person chooses Done or Open.
(function () {
  'use strict';

  var _ids = {}; // per project: the action ids of the Done buttons on screen, by position
  var _doneIds = {}; // the same for the Open again buttons

  function whoName() {
    try {
      return (typeof currentUser !== 'undefined' && currentUser && (currentUser.name || currentUser.email)) || '';
    } catch (e) {
      return '';
    }
  }
  function esc(s) {
    return _escHtml(String(s == null ? '' : s));
  }
  // The page's io for SchedActions.buildInput (computations/sched-actions.js, the one copy of the input rules).
  function input(pid) {
    var mx = typeof emLoadMatrix === 'function' ? emLoadMatrix(pid) : null;
    return SchedActions.buildInput(
      {
        get: function (key, fb) {
          return DB.get(key, fb);
        },
        matrixRows: function () {
          return (mx && mx.rows) || [];
        },
        manualRows: function (p) {
          return typeof distCalManualRows === 'function' ? distCalManualRows(p) : {};
        },
        auditList: function (store) {
          return window.BasAuditLog ? window.BasAuditLog.changeList(store, {}) : { lastDay: '', rows: [] };
        },
        now: new Date().toISOString(),
      },
      pid,
    );
  }
  async function writeHistory(pid, changes, by) {
    if (!changes.length) return;
    var id = 'bash_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await DB.set('en_bas_acthist_' + pid, SchedActions.appendHistory(DB.get('en_bas_acthist_' + pid, []), changes, new Date().toISOString(), by, id));
  }

  var COVERED_MAX = 60; // the collapsed "Covered" list shows this many lines; the count is complete

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }
  // The line under the card title. st = SchedActions.todoView(...).status, nTodo = the number of to-do rows, per = the shown period.
  // The count of the first sentence is the number of rows of the table, nothing else.
  function headline(st, nTodo, per) {
    var where = 'in this ' + per.view;
    if (!st.total) return { text: 'No events ' + where + '.', ok: false };
    if (nTodo) {
      return { text: plural(nTodo, 'change', 'changes') + ' to make in WebCTRL. ' + plural(st.checked, 'event was', 'events were') + ' checked: ' + st.covered + ' covered, ' + nTodo + ' to do.', ok: false };
    }
    if (!st.checked) return { text: 'Cannot tell yet: no event ' + where + ' could be compared with the BAS schedules.', ok: false };
    return { text: 'Nothing to change in WebCTRL for ' + per.label + '. All ' + st.checked + ' ' + (st.checked === 1 ? 'event is' : 'events are') + ' covered.', ok: true };
  }

  function render(pid) {
    var host = document.getElementById('sact-panel-' + pid);
    if (!host) return;
    var T = window.pcalUi.table;
    window.pcalUi.ensureStyle();
    var inp = input(pid);
    var v = SchedActions.reconcile(inp);
    var per = window.pcalPeriod(pid);
    var rows = CalendarDiff.listView({ events: inp.events, last: null, tz: inp.tz, from: per.from, to: per.to, q: '', changesOnly: false }).items.map(function (x) {
      return x.row;
    });
    var tv = SchedActions.todoView(Object.assign({}, inp, { from: per.from, to: per.to, rows: rows }));
    var st = tv.status;
    _ids[pid] = tv.todo.map(function (n) {
      return n.id;
    });
    _doneIds[pid] = tv.done.map(function (n) {
      return n.id;
    });
    var closed = Object.keys(v.stored.actions)
      .map(function (k) {
        return v.stored.actions[k];
      })
      .filter(function (a) {
        return a.status === 'closed';
      })
      .sort(function (a, b) {
        return a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;
      });
    var hl = headline(st, tv.todo.length, per);
    var note = function (n) {
      return n.note ? '<div class="pcal-chg">' + esc(n.note) + '</div>' : '';
    };
    // The to-do list: one row for each change, one Done button for each row.
    var todoHtml = tv.todo.length
      ? T(
          [['Event', '28%'], ['What to do in WebCTRL', '28%'], ['Why', '34%'], ['', '10%']],
          tv.todo.map(function (n, i) {
            return [
              '<b>' + esc(n.head) + '</b>' + note(n),
              esc(n.doThis),
              esc(n.why),
              '<button class="btn btn-em btn-sm" onclick="sactSet(' + pid + ',' + i + ",'done')\">Done</button>",
            ];
          }),
        )
      : '';
    var doneHtml = tv.done.length
      ? '<details><summary>Marked done, waiting for the next BAS import (' + tv.done.length + ')</summary>' +
        T(
          [['Event', '40%'], ['What was marked done', '36%'], ['', '24%']],
          tv.done.map(function (n, i) {
            return [
              '<b>' + esc(n.head) + '</b>' + note(n),
              esc('Done by ' + (n.doneBy || 'someone') + ', ' + CalendarDiff.calendarDay(n.doneAt, inp.tz) + '. It opens again if the next import still shows it not covered.'),
              '<button class="btn btn-ghost btn-sm" onclick="sactSet(' + pid + ',' + i + ",'open','done')\">Open again</button>",
            ];
          }),
        ) +
        '</details>'
      : '';
    var covered = tv.covered.slice(0, COVERED_MAX);
    var coveredHtml = tv.covered.length
      ? '<details><summary>Covered, nothing to do (' + tv.covered.length + ')</summary>' +
        T(
          [['When', '24%'], ['Event', '30%'], ['Covered by', '46%']],
          covered.map(function (c) {
            return [esc(c.when), esc(c.title), esc(c.reason)];
          }),
        ) +
        (tv.covered.length > covered.length ? '<div class="pcal-chg">Showing ' + covered.length + ' of ' + tv.covered.length + '. Choose a shorter period to see the rest.</div>' : '') +
        '</details>'
      : '';
    var optionalHtml = tv.optional.length
      ? '<details><summary>Optional: schedules longer than the event (' + tv.optional.length + ')</summary><ul class="pcal-why">' +
        tv.optional
          .map(function (o) {
            return '<li>' + esc(o.text) + '</li>';
          })
          .join('') +
        '</ul></details>'
      : '';
    var places = st.unmappedPlaces.length
      ? '<div class="pcal-chg">Places not matched to a BAS space: ' +
        esc(
          st.unmappedPlaces
            .map(function (u) {
              return u.name + ' (' + u.count + ')';
            })
            .join(', '),
        ) +
        '</div>'
      : '';
    var uncheckedHtml = st.uncheckable
      ? '<details><summary>Could not be checked (' + st.uncheckable + ')</summary><ul class="pcal-why">' +
        st.reasons
          .map(function (r) {
            return '<li>' + esc(r) + '</li>';
          })
          .join('') +
        '</ul>' +
        places +
        '</details>'
      : '';
    var laterHtml = tv.later
      ? '<div class="pcal-chg" style="margin-top:12px">Later: ' + plural(tv.later.count, 'event', 'events') + ' from ' + esc(CalendarDiff.dayLabel(tv.later.from).replace(',', '')) + '; ' + (tv.later.count === 1 ? 'it shows' : 'they show') + ' when you open ' + (tv.later.count === 1 ? 'its week.' : 'their week.') + '</div>'
      : '';
    var closedHtml = closed.length
      ? '<details><summary>Closed (' + closed.length + ')</summary>' +
        T(
          [['Action', '62%'], ['Why it closed', '38%']],
          closed.map(function (a) {
            return [esc(a.text), esc(a.note + (a.closedAt ? ', ' + CalendarDiff.calendarDay(a.closedAt, inp.tz) : ''))];
          }),
        ) +
        '</details>'
      : '';
    var waste = SchedActions.wasteFindings(inp);
    var wasteHtml = waste.length
      ? '<h4>BAS schedules occupied all day with no event (' + waste.length + ')</h4>' +
        T(
          [['Building', '24%'], ['Program', '32%'], ['Scheduling group', '22%'], ['Saved BAS days', '22%']],
          waste.map(function (f) {
            return [esc(f.building), esc(f.program), esc(f.group), esc(f.dates.map(BasDiff.dateText).join(', '))];
          }),
        ) +
        '<div style="font-size:12px;margin-top:8px">Check that the building needs these on when it is closed. Air handlers that serve boxes and hot and chilled water plants are not listed.</div>'
      : '';
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title" title="The changes to make in WebCTRL so the schedules run for the events of the shown period. Events that are covered need nothing. After the next BAS import or calendar sync, a fixed line closes by itself and a Done line that is still not covered opens again.">To do in WebCTRL: ' + esc(per.label) + '</span></div>' +
      '<div style="padding:16px"><div class="' + (hl.ok ? 'sact-ok' : 'pcal-sum') + '" style="margin-top:0">' + esc(hl.text) + '</div>' +
      todoHtml + doneHtml + coveredHtml + optionalHtml + uncheckedHtml + laterHtml + closedHtml + wasteHtml +
      '<div class="pcal-chg" style="margin-top:12px">' + esc(SchedActions.copyNote({ snapFetchedAt: inp.snapFetchedAt, snaps: inp.snaps, tz: inp.tz, today: inp.today, auditLastDay: inp.auditLastDay, scheduleEdits: inp.scheduleEdits })) + '</div></div></div>';
  }

  // Saves what the check found now: new actions, closed actions, reopened actions. Called after a calendar sync and a BAS import.
  async function persist(pid) {
    var id = 'bash_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var plan = SchedActions.persistPlan(input(pid), DB.get('en_bas_acthist_' + pid, []), id);
    if (!plan) return;
    await DB.set('en_sched_actions_' + pid, plan.stored);
    await DB.set('en_bas_acthist_' + pid, plan.hist);
  }
  window.sactRender = render;
  window.sactPersist = persist;
  window.sactSet = async function (pid, i, status, which) {
    var id = ((which === 'done' ? _doneIds : _ids)[pid] || [])[i];
    if (id == null) return;
    var inp = input(pid);
    var v = SchedActions.reconcile(inp);
    var r = SchedActions.setStatus(v.stored, id, status, whoName(), inp.now);
    if (!r.changes.length) return;
    await DB.set('en_sched_actions_' + pid, r.stored);
    await writeHistory(pid, v.changes, 'automatic check');
    await writeHistory(pid, r.changes, whoName());
    render(pid);
  };
})();
