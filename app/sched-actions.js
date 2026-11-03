// app/sched-actions.js
//
// "What needs to change" card of the Project page, District Calendar tab. It follows the shown period of the calendar
// (Day / Week / Month / Year, window.pcalPeriod): the BAS changes needed in that period, with To do / Done, what the BAS has now,
// why events could not be compared, and a short list of BAS schedules occupied all day with no event.
// This file only draws the result and saves it. The rules (which events need a change, closing and reopening, waste) are in
// computations/sched-actions.js (SchedActions); the coverage check is computations/bas-coverage.js (BasCoverage).
//
// Data (shared keys, read and written only through DB.get / DB.set):
//   en_sched_actions_<pid>  { actions:{ "<event id>": { id, date, text, program, status, openedAt, doneBy, doneAt, closedAt, note } } }  class SYNCED
//   en_bas_acthist_<pid>    one record (kind 'action') for each save that changed an action: who, when, what. Its own list (50), so actions never push out BAS import history (en_bas_hist_).
// Reads en_cal_snap_<pid>, en_cal_cfg_<pid>, en_space_map_<pid>, en_bas_snap_<pid>, en_bas_groups_<pid>.
//
// Network: none. Opening the tab only reads saved data and works out the list in memory. The list is saved
// after a calendar sync (project-calendar.js), after a BAS import (bas-schedules.js), and when a person chooses Done or Open.
(function () {
  'use strict';

  var HIST_MAX = 50;
  var _ids = {}; // per project: the action ids of the buttons on screen, by position

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
  function input(pid) {
    var cfg = DB.get('en_cal_cfg_' + pid, null);
    var snap = DB.get('en_cal_snap_' + pid, null);
    var snaps = DB.get('en_bas_snap_' + pid, {});
    if (!snaps || typeof snaps !== 'object' || Array.isArray(snaps)) snaps = {};
    var tz = (cfg && cfg.timezone) || 'America/Chicago';
    var g = DB.get('en_bas_groups_' + pid, null);
    return {
      events: Object.assign({}, (snap && snap.events) || {}, typeof distCalManualRows === 'function' ? distCalManualRows(pid) : {}),
      map: DB.get('en_space_map_' + pid, null),
      snaps: snaps,
      groups: (g && g.groups) || {},
      tz: tz,
      today: CalendarDiff.calendarDay(new Date().toISOString(), tz),
      stored: DB.get('en_sched_actions_' + pid, null),
      now: new Date().toISOString(),
      latestImport: SchedActions.latestImport(snaps, snap && snap.fetchedAt),
    };
  }
  async function writeHistory(pid, changes, by) {
    if (!changes.length) return;
    var h = DB.get('en_bas_acthist_' + pid, []);
    var id = 'bash_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var rec = SchedActions.historyRecord(changes, new Date().toISOString(), by, id);
    await DB.set('en_bas_acthist_' + pid, [rec].concat(Array.isArray(h) ? h : []).slice(0, HIST_MAX));
  }

  // The headline of the card and the reasons why events could not be compared. st = SchedActions.periodView(...).status.
  function headline(st, nNeeds, nOpen, per) {
    var where = 'in this ' + per.view;
    if (!st.total) return 'No events ' + where + '.';
    if (!st.checked) return 'Cannot tell yet: no event ' + where + ' could be compared with the BAS schedules.';
    var checked = st.checked + (st.checked === 1 ? ' event was' : ' events were') + ' compared with the BAS schedules';
    var tail = st.uncheckable ? ' ' + st.uncheckable + (st.uncheckable === 1 ? ' event' : ' events') + ' could not be checked.' : '';
    if (nNeeds) return nNeeds + (nNeeds === 1 ? ' change needs' : ' changes need') + ' to be made ' + where + ' (' + nOpen + ' to do). ' + checked + '.' + tail;
    if (st.uncheckable) return 'No change found. ' + checked + '.' + tail;
    return 'Nothing needs to change ' + where + '. All ' + st.checked + ' checked ' + (st.checked === 1 ? 'event is' : 'events are') + ' covered by the BAS schedule.';
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
    var pv = SchedActions.periodView(Object.assign({}, inp, { from: per.from, to: per.to, rows: rows }));
    var needs = pv.needs.sort(function (a, b) {
      var sa = v.stored.actions[a.id];
      var sb = v.stored.actions[b.id];
      var da = sa && sa.status === 'done' ? 1 : 0;
      var db = sb && sb.status === 'done' ? 1 : 0;
      return da - db;
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
    _ids[pid] = needs.map(function (n) {
      return n.id;
    });
    var nOpen = needs.filter(function (n) {
      var s = v.stored.actions[n.id];
      return !s || s.status === 'open';
    }).length;
    var st = pv.status;
    var reasons = st.reasons.length
      ? '<ul class="pcal-why">' +
        st.reasons
          .map(function (r) {
            return '<li>' + esc(r) + '</li>';
          })
          .join('') +
        '</ul>'
      : '';
    var places = st.unmappedPlaces.length
      ? '<details><summary>Places not matched to a BAS space (' + st.unmappedPlaces.length + ')</summary><div class="pcal-chg">' +
        esc(
          st.unmappedPlaces
            .map(function (u) {
              return u.name + ' (' + u.count + ')';
            })
            .join(', '),
        ) +
        '</div></details>'
      : '';
    var trows = needs.map(function (n, i) {
      var s = v.stored.actions[n.id];
      var done = s && s.status === 'done';
      var who = done ? 'Done by ' + (s.doneBy || 'someone') + ', ' + CalendarDiff.calendarDay(s.doneAt, inp.tz) : 'To do';
      var b = done
        ? '<button class="btn btn-ghost btn-sm" onclick="sactSet(' + pid + ',' + i + ",'open')\">Open again</button>"
        : '<button class="btn btn-em btn-sm" onclick="sactSet(' + pid + ',' + i + ",'done')\">Done</button>";
      var note = s && s.note ? '<div class="pcal-chg">' + esc(s.note) + '</div>' : '';
      var rep = n.repeats ? ' <span class="pcal-badge" title="The same change repeats every week. Add one repeating schedule to the scheduling group instead of one line for each date.">Repeats weekly</span>' : '';
      return [
        '<b>' + esc(n.change) + '</b>' + rep + '<div class="pcal-chg">For: ' + esc(n.forText) + '</div>' + note,
        esc(n.dates),
        esc(n.inBas || 'No BAS copy for this day'),
        esc(who) + '<div style="margin-top:4px">' + b + '</div>',
      ];
    });
    var tbl = trows.length
      ? T([['Change needed', '32%'], ['Dates', '26%'], ['In the BAS now', '24%'], ['Status', '18%']], trows)
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
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title" title="Events in the shown period that the BAS schedule does not cover. After the next BAS import or calendar sync, a fixed line closes by itself and a Done line that is still not covered opens again.">What needs to change: ' + esc(per.label) + '</span></div>' +
      '<div style="padding:16px"><div class="pcal-sum" style="margin-top:0">' + esc(headline(st, needs.length, nOpen, per)) + '</div>' +
      reasons + places + tbl + closedHtml + wasteHtml + '</div></div>';
  }

  // Saves what the check found now: new actions, closed actions, reopened actions. Called after a calendar sync and a BAS import.
  async function persist(pid) {
    var v = SchedActions.reconcile(input(pid));
    if (!v.changes.length) return;
    await DB.set('en_sched_actions_' + pid, v.stored);
    await writeHistory(pid, v.changes, 'automatic check');
  }
  window.sactRender = render;
  window.sactPersist = persist;
  window.sactSet = async function (pid, i, status) {
    var id = (_ids[pid] || [])[i];
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
