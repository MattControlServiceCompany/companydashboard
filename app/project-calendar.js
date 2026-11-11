// app/project-calendar.js
//
// "Calendar feed" panel at the top of the Project page, District Calendar tab.
// Shows what is on the district calendar feed and what changed since the last sync.
//
// Data (shared keys, read and written only through DB.get / DB.set):
//   en_cal_cfg_<pid>   { icsUrl, timezone }          the feed address for this project
//   en_cal_snap_<pid>  { fetchedAt, count, window, events:{key:[title,start,end,allDay,location]} }
//   en_cal_hist_<pid>  [ { id, at, counts, added, removed, changed } ]   newest first
//   en_bas_auditevents_<pid>  the BAS changes of the imported audit logs. Read only, through BasAuditLog.changeList (app/bas-audit-log.js).
//
// Network: ONE call to /.netlify/functions/calendar-fetch, when the user clicks Sync now, or once when the tab opens
// and the saved copy is older than 1 hour (pcalAutoSync). There are no timers.
// Text is escaped with _escHtml (lib/formatting.js). The comparison is done by CalendarDiff.diffSnapshots (app/calendar-diff.js), the only copy.
(function () {
  'use strict';

  var FN_URL = '/.netlify/functions/calendar-fetch';
  var HIST_MAX = 50;
  var PAGE_ROWS = 200;
  var DEFAULT_TZ = 'America/Chicago';
  var ZONES = [
    ['America/New_York', 'Eastern'],
    ['America/Chicago', 'Central'],
    ['America/Denver', 'Mountain'],
    ['America/Phoenix', 'Arizona'],
    ['America/Los_Angeles', 'Pacific'],
  ];
  var FIELD_LABEL = { title: 'Title', start: 'Start', end: 'End', allDay: 'All-day', location: 'Location' };
  var _st = {}; // per project: { view ('day'|'week'|'month'|'year'), anchor (YYYY-MM-DD or null = today), q, changesOnly, limit, busy, msg }

  function k(kind, pid) {
    return 'en_cal_' + kind + '_' + pid;
  }
  function state(pid) {
    return (_st[pid] = _st[pid] || {
      view: 'week',
      anchor: null,
      q: '',
      changesOnly: false,
      limit: PAGE_ROWS,
      basDays: 30,
      basLimit: PAGE_ROWS,
      busy: false,
      msg: '',
    });
  }
  function cfgOf(pid) {
    return DB.get(k('cfg', pid), null);
  }
  function snapOf(pid) {
    return DB.get(k('snap', pid), null);
  }
  function histOf(pid) {
    var h = DB.get(k('hist', pid), []);
    return Array.isArray(h) ? h : [];
  }
  function tzOf(pid) {
    var c = cfgOf(pid);
    return (c && c.timezone) || DEFAULT_TZ;
  }

  // --- date text ---------------------------------------------------------------
  var _fmtCache = {};
  function fmt(tz, key, opts) {
    var id = tz + '|' + key;
    return (_fmtCache[id] = _fmtCache[id] || new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)));
  }
  function dayKey(iso, tz) {
    return CalendarDiff.calendarDay(iso, tz);
  }
  // 'Oct 20, 2026' from a YYYY-MM-DD day. No Date-in-UTC shift: built from year, month, day.
  function dayText(ymd) {
    var a = ymd.split('-');
    return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function when(iso, allDay, tz, endIso) {
    if (!iso) return '';
    if (allDay) {
      var first = dayKey(iso, tz);
      var last = CalendarDiff.allDayLastDay(iso, endIso, tz);
      return dayText(first) + (last > first ? ' to ' + dayText(last) : '') + ' (all day)';
    }
    var d = new Date(iso);
    return fmt(tz, 'dt', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  }
  // Sync time without the current year. Single formatter for the sync lines.
  function stampShort(iso) {
    return stamp(iso).replace(', ' + new Date().getFullYear(), '');
  }
  function stamp(iso) {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  function fieldValue(name, v, tz) {
    if (name === 'start' || name === 'end') return v ? when(v, false, tz) : 'none';
    if (name === 'allDay') return v ? 'yes' : 'no';
    return v === '' || v == null ? 'none' : String(v);
  }

  // --- small html builders -----------------------------------------------------
  function ensureStyle() {
    if (document.getElementById('pcal-style')) return;
    var s = document.createElement('style');
    s.id = 'pcal-style';
    s.textContent = [
      '.pcal{color:var(--text)}',
      '.pcal details{margin-top:12px}',
      '.pcal summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text)}',
      '.pcal-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.pcal-row .fi{flex:1 1 220px;min-width:0}',
      '.pcal-msg{font-size:12px;margin-top:8px;color:var(--text)}',
      '.pcal-outer{border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-top:8px}',
      '.pcal-tbl{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed}',
      '.pcal-tbl th{background:var(--s1);color:var(--text);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;text-align:left;border-bottom:1px solid var(--border2);border-right:1px solid var(--border)}',
      '.pcal-tbl td{color:var(--text);font-size:12px;padding:6px 10px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);overflow:hidden;word-break:break-word;vertical-align:top;font-variant-numeric:tabular-nums}',
      '.pcal-tbl th:last-child,.pcal-tbl td:last-child{border-right:none}',
      '.pcal-tbl tbody tr:last-child td{border-bottom:none}',
      '.pcal-tbl tbody tr:nth-child(even) td{background:var(--s3)}',
      '.pcal-sum{font-size:15px;font-weight:700;margin-top:12px;color:var(--text)}',
      '.pcal-feed{font-size:12px;margin-top:4px;color:var(--text)}',
      '.pcal-range{font-size:13px;font-weight:600;color:var(--text);min-width:130px;text-align:center}',
      '.pcal-ev-tbl tbody tr:nth-child(even) td{background:transparent}',
      '.pcal-ev-tbl tr.pcal-day th{background:var(--s2);color:var(--text);text-transform:none;font-size:12px;letter-spacing:0;border-right:none;border-top:1px solid var(--border2)}',
      '.pcal-badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border:1px solid var(--text);border-radius:3px;color:var(--text);vertical-align:1px}',
      '.pcal-new{background:color-mix(in srgb,var(--green) 40%,var(--s1));border-color:var(--green)}',
      '.pcal-changed{background:color-mix(in srgb,var(--amber) 40%,var(--s1));border-color:var(--amber)}',
      '.pcal-canceled{background:color-mix(in srgb,var(--red) 40%,var(--s1));border-color:var(--red)}',
      '.pcal-gone .pcal-ev{text-decoration:line-through}',
      '.pcal-chg{margin-top:2px;font-size:12px;color:var(--text)}',
      '.pcal-nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}',
      '.pcal-hist-item{margin-top:8px;border:1px solid var(--border);border-radius:6px;padding:8px 10px}',
      '.pcal-why{margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--text)}',
      '.pcal h4{margin:12px 0 0;font-size:12px;font-weight:700;color:var(--text)}',
    ].join('');
    document.head.appendChild(s);
  }
  function table(cols, rows) {
    return (
      '<div class="pcal-outer"><table class="pcal-tbl"><colgroup>' +
      cols
        .map(function (c) {
          return '<col style="width:' + c[1] + '">';
        })
        .join('') +
      '</colgroup><thead><tr>' +
      cols
        .map(function (c) {
          return '<th>' + _escHtml(c[0]) + '</th>';
        })
        .join('') +
      '</tr></thead><tbody>' +
      rows
        .map(function (r) {
          return (
            '<tr>' +
            r
              .map(function (c) {
                return '<td>' + c + '</td>';
              })
              .join('') +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
  }
  function num(n) {
    return Number(n).toLocaleString('en-US');
  }

  function listRows(items, tz) {
    return items.map(function (x) {
      return [_escHtml(when(x.start, false, tz)), _escHtml(x.title)];
    });
  }
  function changeTables(rec, tz) {
    var out = '';
    var two = [
      ['Date', '34%'],
      ['Event', '66%'],
    ];
    if (rec.added && rec.added.length) {
      out += '<h4>New (' + num(rec.counts.added) + ')</h4>' + table(two, listRows(rec.added, tz));
    }
    if (rec.removed && rec.removed.length) {
      out += '<h4>Canceled (' + num(rec.counts.removed) + ')</h4>' + table(two, listRows(rec.removed, tz));
    }
    if (rec.changed && rec.changed.length) {
      out +=
        '<h4>Changed (' +
        num(rec.counts.changed) +
        ')</h4>' +
        table(
          [
            ['Event', '34%'],
            ['What changed (before, then after)', '66%'],
          ],
          rec.changed.map(function (x) {
            var lines = Object.keys(x.fields).map(function (f) {
              return (
                '<div>' +
                _escHtml(FIELD_LABEL[f]) +
                ': ' +
                _escHtml(fieldValue(f, x.fields[f][0], tz)) +
                ' &rarr; ' +
                _escHtml(fieldValue(f, x.fields[f][1], tz)) +
                '</div>'
              );
            });
            return [_escHtml(x.title), lines.join('')];
          }),
        );
    }
    var total = (rec.counts.added || 0) + (rec.counts.removed || 0) + (rec.counts.changed || 0);
    if (!total) out = '<div style="font-size:12px;margin-top:8px">Nothing changed in this sync.</div>';
    var cut = ['added', 'removed', 'changed'].some(function (g) {
      return rec[g] && rec[g].length < rec.counts[g];
    });
    if (cut) {
      out +=
        '<div style="font-size:12px;margin-top:8px">Only the first ' +
        CalendarDiff.DETAIL_CAP +
        ' of each group are listed. The counts are complete.</div>';
    }
    return out;
  }

  // --- events list (what exists now) -------------------------------------------
  // Which events show, and their New / Changed / Canceled marks, come from CalendarDiff.listView (the only copy).
  function todayOf(tz) {
    return dayKey(new Date().toISOString(), tz);
  }
  // The shown period (view + anchor day) of a project. The "What needs to change" card (app/sched-actions.js) reads it too.
  function periodOf(pid) {
    var s = state(pid);
    var today = todayOf(tzOf(pid));
    var anchor = s.anchor || today;
    // The default period (nobody stepped) starts today: no past days. Stepping back shows the whole earlier period.
    return Object.assign({ view: s.view, anchor: anchor }, CalendarDiff.periodRange(s.view, anchor, s.anchor ? '' : today));
  }
  var VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
  var VIEW_HINT = {
    day: 'Show one day',
    week: 'Show one week, Monday to Sunday',
    month: 'Show one month',
    year: 'Show one year, month by month',
  };
  function btn(label, on, call, tip) {
    return '<button class="btn btn-sm ' + (on ? 'btn-em' : 'btn-ghost') + '" onclick="' + call + '"' + (on ? ' aria-pressed="true"' : '') + (tip ? ' title="' + _escHtml(tip) + '"' : '') + '>' + label + '</button>';
  }
  function badge(status, lines) {
    return status ? '<span class="pcal-badge pcal-' + status + '">' + CalendarDiff.markLabel(status, lines) + '</span>' : '';
  }
  // The BAS column: one cell per event from BasCoverage.eventCoverage (computations/bas-coverage.js, the only copy).
  function basCell(row, status, ctx) {
    if (status === 'canceled' || !window.BasCoverage) return '';
    var c = BasCoverage.eventCoverage(row, ctx);
    if (c.status === 'allday') return '';
    var cls = c.status === 'covered' ? ' pcal-new' : c.status === 'short' ? ' pcal-changed' : '';
    var tip = '';
    if (c.from) {
      tip = 'Checked against the ' + c.source + (c.program ? '. Least covered: ' + BasDiff.splitKey(c.program).program : '');
    }
    return '<span class="pcal-badge' + cls + '"' + (tip ? ' title="' + _escHtml(tip) + '"' : '') + '>' + _escHtml(c.label) + '</span>';
  }
  // The events of one project in the shown period, with marks. The one call of CalendarDiff.listView for this tab.
  function viewOf(pid, snap, q, changesOnly) {
    var tz = tzOf(pid);
    var per = periodOf(pid);
    return CalendarDiff.listView({
      events: snap.events,
      last: CalendarDiff.carriedMarks(histOf(pid), { events: snap.events, tz: tz, today: todayOf(tz), nowMs: Date.now() }),
      tz: tz,
      from: per.from,
      to: per.to,
      q: q,
      changesOnly: changesOnly,
    });
  }
  // The top card: Day / Week / Month / Year, step back and forward, and the change counts of the shown period.
  function renderTop(pid) {
    var host = document.getElementById('pcal-top-' + pid);
    if (!host) return;
    var snap = snapOf(pid);
    if (!snap) {
      host.innerHTML = '';
      return;
    }
    ensureStyle();
    var s = state(pid);
    var per = periodOf(pid);
    var v = viewOf(pid, snap, '', false);
    var line;
    if (!v.compared) {
      line = 'No earlier sync to compare yet.';
    } else {
      var c = v.counts;
      var parts = [];
      if (c['new']) parts.push(num(c['new']) + ' new');
      if (c.changed) parts.push(num(c.changed) + ' moved or changed');
      if (c.canceled) parts.push(num(c.canceled) + ' canceled');
      line = (parts.length ? parts.join(', ') : 'No new, moved or canceled events') + ' in this ' + per.view + ' since the last sync';
    }
    var today = todayOf(tzOf(pid));
    var onToday = per.from <= today && today <= per.to;
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr"><span class="card-title">Calendar</span></div>' +
      '<div style="padding:16px"><div class="pcal-nav" style="margin-top:0">' +
      VIEWS.map(function (x) { return btn(x[1], s.view === x[0], 'pcalView(' + pid + ",'" + x[0] + "')", VIEW_HINT[x[0]]); }).join('') +
      '<button class="btn btn-ghost btn-sm" aria-label="Previous ' + per.view + '" title="Go back one ' + per.view + '" onclick="pcalStep(' + pid + ',-1)">&#9664;</button>' +
      '<span class="pcal-range">' + _escHtml(per.label) + '</span>' +
      '<button class="btn btn-ghost btn-sm" aria-label="Next ' + per.view + '" title="Go forward one ' + per.view + '" onclick="pcalStep(' + pid + ',1)">&#9654;</button>' +
      (onToday ? '' : '<button class="btn btn-ghost btn-sm" title="Go back to the ' + per.view + ' that has today" onclick="pcalToday(' + pid + ')">Today</button>') +
      '</div><div class="pcal-sum" title="Compared with the calendar feed as saved at each sync. A mark stays ' + CalendarDiff.MARK_DAYS + ' days or until the date passes.">' + _escHtml(line) + '</div></div></div>';
  }
  function renderList(pid) {
    var host = document.getElementById('pcal-list-' + pid);
    if (!host) return;
    var snap = snapOf(pid);
    if (!snap) {
      host.innerHTML = '';
      return;
    }
    var s = state(pid);
    var tz = tzOf(pid);
    var hist = histOf(pid);
    var per = periodOf(pid);
    var q = s.q.trim();
    var v = viewOf(pid, snap, s.q, s.changesOnly);
    var last = hist[0];
    var lc = last && !last.first ? last.counts : null;
    var feedLine =
      'Whole feed: ' + num(snap.count) + (snap.count === 1 ? ' event' : ' events') +
      '; last sync ' + stampShort(snap.fetchedAt) +
      (lc ? ': ' + num(lc.added) + ' new, ' + num(lc.changed) + ' changed, ' + num(lc.removed) + ' canceled' : '');
    var controls =
      '<div class="pcal-nav">' + (v.compared ? btn('Changes only', s.changesOnly, 'pcalChangesOnly(' + pid + ')', 'Show only new, moved and canceled events') : '') + '</div>';
    var basCtx = { tz: tz, map: DB.get('en_space_map_' + pid, null), snaps: DB.get('en_bas_snap_' + pid, {}), groups: (DB.get('en_bas_groups_' + pid, null) || {}).groups || {} };
    var heading;
    var tbl;
    var more = '';
    if (!q && s.view === 'year') {
      // Year: one line for each month; choose a month to see its events.
      var months = {};
      v.items.forEach(function (e) {
        var m = (months[e.day.slice(0, 7)] = months[e.day.slice(0, 7)] || { n: 0, nw: 0, ch: 0, ca: 0 });
        m.n++;
        if (e.status === 'new') m.nw++;
        else if (e.status === 'changed') m.ch++;
        else if (e.status === 'canceled') m.ca++;
      });
      var yrows = [];
      for (var mi = +per.from.slice(5, 7); mi <= +per.to.slice(5, 7); mi++) {
        var mk = per.from.slice(0, 5) + String(mi).padStart(2, '0');
        var m = months[mk] || { n: 0, nw: 0, ch: 0, ca: 0 };
        yrows.push(
          '<tr><td><button class="btn btn-ghost btn-sm" title="Show this month" onclick="pcalGo(' + pid + ",'month','" + mk + "-01')\">" +
          _escHtml(CalendarDiff.periodRange('month', mk + '-01').label.replace(/ \d{4}$/, '')) + '</button></td><td>' + num(m.n) + '</td><td>' + num(m.nw) + '</td><td>' + num(m.ch) + '</td><td>' + num(m.ca) + '</td></tr>'
        );
      }
      tbl =
        '<div class="pcal-outer"><table class="pcal-tbl pcal-ev-tbl"><colgroup><col style="width:34%"><col style="width:16%"><col style="width:16%"><col style="width:18%"><col style="width:16%"></colgroup>' +
        '<thead><tr><th>Month</th><th>Events</th><th>New</th><th title="Events whose day, time, place or name changed">Moved or changed</th><th>Canceled</th></tr></thead><tbody>' + yrows.join('') + '</tbody></table></div>';
      heading = per.label + ' (' + num(v.items.length) + (v.items.length === 1 ? ' event)' : ' events)');
    } else {
      var shown = v.items.slice(0, s.limit);
      var today = todayOf(tz);
      var yr = today.slice(0, 4);
      var body = '';
      var lastDay = null;
      shown.forEach(function (e) {
        if (e.day !== lastDay) {
          lastDay = e.day;
          body +=
            '<tr class="pcal-day"><th colspan="4" scope="colgroup">' +
            _escHtml(CalendarDiff.dayLabel(e.day) + (e.day.slice(0, 4) !== yr ? ', ' + e.day.slice(0, 4) : '') + (e.day === today ? ' (today)' : '')) +
            '</th></tr>';
        }
        var pl = CalendarDiff.eventPlace({ title: e.row[0], location: e.row[4] });
        var place = pl.fromTitle ? '<span title="Taken from the event title">' + _escHtml(pl.text) + '</span>' : _escHtml(pl.text);
        var multi = '';
        if (e.row[3] || /^\d{4}-\d{2}-\d{2}$/.test(e.row[1])) {
          var lastD = CalendarDiff.allDayLastDay(e.row[1], e.row[2], tz);
          if (lastD > dayKey(e.row[1], tz)) multi = ' (through ' + dayText(lastD) + ')';
        }
        var what =
          '<span class="pcal-ev">' + _escHtml(e.row[0]) + '</span> ' + badge(e.status, e.lines) +
          (e.lines.length ? '<div class="pcal-chg">' + e.lines.map(_escHtml).join('<br>') + '</div>' : '');
        var tip = e.lines.length ? ' title="' + _escHtml(e.lines.join('; ')) + '"' : '';
        body +=
          '<tr class="pcal-r' + (e.status === 'canceled' ? ' pcal-gone' : '') + '"' + tip + '><td>' +
          _escHtml(CalendarDiff.timeText(e.row, tz) + multi) +
          '</td><td>' + what + '</td><td>' + place + '</td><td>' + basCell(e.row, e.status, basCtx) + '</td></tr>';
      });
      tbl = shown.length
        ? '<div class="pcal-outer"><table class="pcal-tbl pcal-ev-tbl"><colgroup><col style="width:19%"><col style="width:35%"><col style="width:22%"><col style="width:24%"></colgroup>' +
          '<thead><tr><th>Time</th><th>Event</th><th>Location</th><th title="Whether the BAS schedule is on for the whole event">BAS</th></tr></thead><tbody>' + body + '</tbody></table></div>'
        : '<div style="font-size:12px;margin-top:8px">' +
          (s.changesOnly ? 'No new, moved or canceled events in this ' + per.view + '.' : q ? 'No events found.' : 'No events in this ' + per.view + '.') + '</div>';
      heading = q
        ? 'Events matching "' + q + '" (' + num(v.items.length) + '), any date'
        : per.label + ' (' + num(v.items.length) + (v.items.length === 1 ? ' event)' : ' events)');
      more = v.items.length > shown.length
        ? '<div class="pcal-nav"><span style="font-size:12px">Showing ' + num(shown.length) + ' of ' + num(v.items.length) +
          '.</span><button class="btn btn-ghost btn-sm" onclick="pcalMore(' + pid + ')">Show more</button></div>'
        : '';
    }
    host.innerHTML =
      '<div class="pcal-feed">' + _escHtml(feedLine) + '</div>' + controls + '<h4>' + _escHtml(heading) + '</h4>' + tbl + more;
  }

  // --- BAS changes (from the imported WebCTRL audit log) ---------------------------------------------------------
  var BAS_RANGES = [[30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year'], [0, 'All stored changes']];
  // 'Nov 10, 2026 5:35 PM' from a stored time 'YYYY-MM-DDTHH:MM:SS' (local time of the building; no zone shift).
  function basStamp(iso) {
    var h = +iso.slice(11, 13);
    var m = iso.slice(14, 16);
    return dayText(iso.slice(0, 10)) + ' ' + (h % 12 === 0 ? 12 : h % 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function renderBas(pid) {
    var host = document.getElementById('pcal-bas-' + pid);
    if (!host || !window.BasAuditLog) return; // the audit log reader loads after this file
    ensureStyle();
    var s = state(pid);
    var days = s.basDays;
    var res = window.BasAuditLog.changeList(DB.get('en_bas_auditevents_' + pid, null), { today: todayOf(tzOf(pid)), days: days });
    var body;
    var ctl = '';
    if (!res.has) {
      body = '<div class="pcal-msg">No WebCTRL audit log is imported for this project. Open the BAS schedules section on this tab and choose Import audit log.</div>';
    } else {
      var opts = BAS_RANGES.map(function (r) {
        return '<option value="' + r[0] + '"' + (r[0] === days ? ' selected' : '') + '>' + _escHtml(r[1]) + '</option>';
      }).join('');
      ctl = '<select class="fi" aria-label="Range of BAS changes" style="flex:0 0 auto;width:auto" onchange="pcalBasRange(' + pid + ',this.value)">' + opts + '</select>';
      var shown = res.rows.slice(0, s.basLimit);
      var line = res.rows.length
        ? num(res.rows.length) + (res.rows.length === 1 ? ' change' : ' changes') + (days ? ' in the last ' + num(days) + ' days' : ' stored') + '. The newest day in the imported log is ' + dayText(res.lastDay) + '.'
        : 'No BAS changes in the last ' + num(days) + ' days. The newest day in the imported log is ' + dayText(res.lastDay) + '.';
      var tbl = res.rows.length
        ? table(
            [['Date and time', '15%'], ['Type', '12%'], ['Building', '13%'], ['Location', '20%'], ['What changed', '27%'], ['Operator', '13%']],
            shown.map(function (r) {
              return [
                _escHtml(basStamp(r.iso)),
                _escHtml(r.type),
                _escHtml(r.building),
                _escHtml(r.area || 'Whole building'),
                _escHtml(r.what),
                r.operator ? _escHtml(r.operator) : '<span title="The audit log was imported before operator names were kept. Import the audit log file again to add them.">Not saved</span>',
              ];
            }),
          )
        : '';
      var more = res.rows.length > shown.length
        ? '<div class="pcal-nav"><span class="pcal-msg">Showing ' + num(shown.length) + ' of ' + num(res.rows.length) + '.</span><button class="btn btn-ghost btn-sm" onclick="pcalBasMore(' + pid + ')">Show more</button></div>'
        : '';
      body = '<div class="pcal-feed">' + _escHtml(line) + '</div>' + tbl + more;
    }
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr" style="justify-content:space-between"><span class="card-title">BAS changes</span>' +
      ctl +
      '</div><div style="padding:16px">' +
      body +
      '</div></div>';
  }
  // Redraw everything that follows the shown period.
  function refresh(pid) {
    renderTop(pid);
    renderList(pid);
    if (typeof window.sactRender === 'function') window.sactRender(pid);
  }

  // --- panel -------------------------------------------------------------------
  function render(pid) {
    var host = document.getElementById('pcal-panel-' + pid);
    if (!host) return;
    ensureStyle();
    var s = state(pid);
    var cfg = cfgOf(pid);
    var snap = snapOf(pid);
    var hist = histOf(pid);
    var tz = tzOf(pid);
    var syncBtn = cfg
      ? '<button class="btn btn-em btn-sm" id="pcal-sync-' +
        pid +
        '" onclick="pcalSync(' +
        pid +
        ')"' +
        (s.busy ? ' disabled' : '') +
        '>' +
        (s.busy ? 'Syncing...' : 'Sync now') +
        '</button>'
      : '';
    var summary;
    if (!cfg) {
      summary =
        '<div style="font-size:13px">Enter the calendar feed address for this project, then choose Save and sync.</div>';
    } else if (!snap) {
      summary = '<div style="font-size:13px">No copy of the feed is saved yet. Choose Sync now.</div>';
    } else if (s.feedChanged) {
      summary =
        '<div class="pcal-msg">The calendar feed has changes that are not saved yet. Choose Sync now to save them.</div>';
    } else {
      summary = '';
    }
    var leftOut = snap && snap.leftOut && snap.leftOut.length ? snap.leftOut : null;
    if (leftOut) {
      summary +=
        '<div class="pcal-msg">' +
        _escHtml(
          (leftOut.length === 1 ? '1 repeating event has' : num(leftOut.length) + ' repeating events have') +
            ' too many dates and ' +
            (leftOut.length === 1 ? 'was' : 'were') +
            ' left out: ' +
            leftOut.join(', '),
        ) +
        '</div>';
    }
    var zoneOpts = ZONES.map(function (z) {
      return '<option value="' + z[0] + '"' + (z[0] === tz ? ' selected' : '') + '>' + z[1] + ' time</option>';
    }).join('');
    var form =
      '<div class="pcal-row" style="margin-top:8px">' +
      '<input class="fi" id="pcal-url-' +
      pid +
      '" placeholder="Feed address (link ending in .ics)" value="' +
      _escHtml(cfg ? cfg.icsUrl : '') +
      '" autocomplete="off">' +
      '<select class="fi" id="pcal-tz-' +
      pid +
      '" style="flex:0 0 auto;width:auto">' +
      zoneOpts +
      '</select>' +
      '<button class="btn btn-ghost btn-sm" onclick="pcalSave(' +
      pid +
      ')">' +
      (cfg ? 'Save address' : 'Save and sync') +
      '</button></div>' +
      '<div class="pcal-note" style="margin-top:4px;font-size:12px;color:var(--text2)">In Google Calendar: Settings, then the calendar, then Integrate calendar. Copy the Secret address in iCal format (it ends in .ics).</div>';
    var history = '';
    if (hist.length) {
      history =
        '<details><summary>Sync history (' +
        hist.length +
        ')</summary>' +
        hist
          .map(function (r) {
            var line = r.first
              ? 'First copy saved, ' + num(r.counts.total) + ' events'
              : num(r.counts.added) +
                ' new, ' +
                num(r.counts.removed) +
                ' canceled, ' +
                num(r.counts.changed) +
                ' changed';
            return (
              '<details class="pcal-hist-item"><summary>' +
              _escHtml(stamp(r.at)) +
              ' &mdash; ' +
              _escHtml(line) +
              '</summary>' +
              (r.first ? '' : changeTables(r, tz)) +
              '</details>'
            );
          })
          .join('') +
        '</details>';
    }
    var nav = snap
      ? '<div class="pcal-nav">' +
        '<input class="fi" id="pcal-q-' +
        pid +
        '" placeholder="Search all events" value="' +
        _escHtml(s.q) +
        '" oninput="pcalSearch(' +
        pid +
        ',this.value)" style="flex:1 1 220px;min-width:0"></div>'
      : '';
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr" style="justify-content:space-between"><span class="card-title">Calendar feed</span>' +
      syncBtn +
      '</div><div style="padding:16px">' +
      summary +
      '<div class="pcal-msg" id="pcal-msg-' +
      pid +
      '">' +
      _escHtml(s.msg) +
      '</div>' +
      history +
      '<details' +
      (cfg ? '' : ' open') +
      '><summary>Feed address</summary>' +
      form +
      '</details>' +
      nav +
      '<div id="pcal-list-' +
      pid +
      '"></div></div></div><div id="pcal-bas-' +
      pid +
      '"></div>';
    renderTop(pid);
    renderList(pid);
    renderBas(pid);
    if (typeof window.spaceMapRender === 'function') window.spaceMapRender(pid);
    if (typeof window.sactRender === 'function') window.sactRender(pid);
  }

  // --- actions -----------------------------------------------------------------
  function say(pid, msg) {
    state(pid).msg = msg;
    var el = document.getElementById('pcal-msg-' + pid);
    if (el) el.textContent = msg;
  }
  async function save(pid) {
    var url = (document.getElementById('pcal-url-' + pid) || {}).value || '';
    var tz = (document.getElementById('pcal-tz-' + pid) || {}).value || DEFAULT_TZ;
    url = url.trim();
    if (!url) return say(pid, 'Enter the feed address first.');
    var bad = CalendarDiff.feedUrlProblem(url);
    if (bad) return say(pid, bad);
    var had = !!cfgOf(pid);
    await DB.set(k('cfg', pid), { icsUrl: url, timezone: tz });
    if (had) {
      say(pid, 'Feed address saved.');
      render(pid);
    } else {
      render(pid);
      await sync(pid);
    }
  }
  // Reads the feed and returns the new copy ({fetchedAt, count, window, leftOut, events}); writes NOTHING.
  // Sets s.msg and returns null when the feed cannot be read. The ONE feed read: sync (saves) and
  // pcalAutoSync (only looks) both use it.
  async function readFeed(pid, cfg, token) {
    var s = state(pid);
    var res = await fetch(FN_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ icsUrl: cfg.icsUrl, timezone: cfg.timezone }),
    });
    var body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    if (!res.ok || !body || !body.ok) {
      s.msg = (body && body.error) || 'The calendar feed could not be read. The last saved copy is kept.';
      return null;
    }
    var fresh = body.snapshot;
    return { fetchedAt: fresh.fetchedAt, count: fresh.count, window: fresh.window, leftOut: fresh.leftOut || [], events: fresh.events };
  }
  // A person chose Sync now (or Save and sync): read the feed and SAVE the new copy and the history record.
  async function sync(pid) {
    var s = state(pid);
    var cfg = cfgOf(pid);
    if (!cfg || s.busy) return;
    var token = window.CH_AUTH && window.CH_AUTH.getToken && window.CH_AUTH.getToken();
    if (!token) {
      say(pid, 'Sign in first, then try again.');
      return;
    }
    s.busy = true;
    s.msg = '';
    s.feedChanged = false;
    render(pid);
    try {
      var snap = await readFeed(pid, cfg, token);
      if (!snap) return;
      var old = snapOf(pid);
      var hist = histOf(pid);
      var id = 'calh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var rec;
      if (old) {
        rec = CalendarDiff.historyRecord(CalendarDiff.diffSnapshots(old, snap), snap.fetchedAt, id);
      } else {
        rec = {
          id: id,
          at: snap.fetchedAt,
          first: true,
          counts: { added: 0, removed: 0, changed: 0, unchanged: snap.count, total: snap.count },
          added: [],
          removed: [],
          changed: [],
        };
      }
      await DB.set(k('hist', pid), [rec].concat(hist).slice(0, HIST_MAX));
      await DB.set(k('snap', pid), snap);
      if (typeof window.sactPersist === 'function') await window.sactPersist(pid); // closes or reopens actions against the new copy
    } catch (e) {
      s.msg = 'The calendar feed could not be read. The last saved copy is kept.';
    } finally {
      s.busy = false;
      render(pid);
    }
  }

  // The calendar's own table and text helpers, shared with the BAS schedules card (app/bas-schedules.js).
  window.pcalBasCell = basCell; // the one BAS badge, also used by the manual events table (district-calendar.js)
  window.pcalUi = { table: table, num: num, stamp: stamp, ensureStyle: ensureStyle };
  window.pcalRender = render;
  window.pcalSync = sync;
  window.pcalHasFeed = function (pid) {
    return !!cfgOf(pid);
  };
  // Called when the District Calendar tab opens, and for every project once per page load (pcalAutoSyncAll).
  // If the saved copy is older than 1 hour it READS the feed and compares it with the saved copy. It saves
  // NOTHING (no copy, no history, no actions: a page saves only when a person makes a change). When the feed
  // differs, the panel says so and the person chooses Sync now. No timers.
  // A second render within 60 seconds does not call again (a failed read leaves the copy old).
  window.pcalAutoSync = async function (pid) {
    var s = state(pid);
    if (s.busy || (s.autoAt && Date.now() - s.autoAt < 60000)) return;
    var token = window.CH_AUTH && window.CH_AUTH.getToken && window.CH_AUTH.getToken();
    var cfg = cfgOf(pid);
    var saved = snapOf(pid);
    if (!CalendarDiff.needsAutoSync({ cfg: cfg, token: token, snap: saved, nowMs: Date.now() })) return;
    s.autoAt = Date.now();
    try {
      var snap = await readFeed(pid, cfg, token);
      if (!snap) return;
      var d = saved ? CalendarDiff.diffSnapshots(saved, snap) : null;
      s.feedChanged = !saved || d.added.length + d.removed.length + d.changed.length > 0;
    } catch (e) {
      s.feedChanged = false;
    }
    render(pid);
  };
  // Runs once per page load, after the first full data pull (event dbFullPull, signed in). Checks every project
  // with a feed through pcalAutoSync (same 1 hour rule). No timers, no polling.
  window.pcalAutoSyncAll = function () {
    var list = DB.get('en_projects', []);
    if (!Array.isArray(list)) return;
    list.forEach(function (p) {
      if (p && p.id != null) window.pcalAutoSync(p.id);
    });
  };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('dbFullPull', function () {
      redrawBas('');
      window.pcalAutoSyncAll();
    });
  }
  // A new audit log import (DB.set fires dataUpdated for en_bas_auditevents_<pid>) or a data pull redraws the section.
  function redrawBas(key) {
    var m = key ? String(key).match(/en_bas_auditevents_(.+)$/) : null;
    if (m) return renderBas(m[1]);
    if (typeof document.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(document.querySelectorAll('[id^="pcal-bas-"]'), function (el) {
      renderBas(el.id.slice('pcal-bas-'.length));
    });
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('dataUpdated', function (e) {
      var key = e && e.detail && e.detail.key;
      if (key && !/en_bas_auditevents_/.test(String(key))) return;
      redrawBas(key);
    });
  }
  window.pcalBasRender = renderBas;
  window.pcalBasRange = function (pid, v) {
    var s = state(pid);
    s.basDays = +v || 0;
    s.basLimit = PAGE_ROWS;
    renderBas(pid);
  };
  window.pcalBasMore = function (pid) {
    var s = state(pid);
    s.basLimit += PAGE_ROWS;
    renderBas(pid);
  };
  window.pcalSave = save;
  window.pcalPeriod = periodOf;
  window.pcalView = function (pid, view) {
    var s = state(pid);
    s.view = view;
    s.q = '';
    s.limit = PAGE_ROWS;
    var q = document.getElementById('pcal-q-' + pid);
    if (q) q.value = '';
    refresh(pid);
  };
  window.pcalStep = function (pid, d) {
    var s = state(pid);
    s.anchor = CalendarDiff.shiftAnchor(s.view, periodOf(pid).anchor, d);
    s.q = '';
    s.limit = PAGE_ROWS;
    var q = document.getElementById('pcal-q-' + pid);
    if (q) q.value = '';
    refresh(pid);
  };
  window.pcalToday = function (pid) {
    var s = state(pid);
    s.anchor = null;
    s.limit = PAGE_ROWS;
    refresh(pid);
  };
  window.pcalGo = function (pid, view, anchor) {
    var s = state(pid);
    s.view = view;
    s.anchor = anchor;
    s.q = '';
    s.limit = PAGE_ROWS;
    refresh(pid);
  };
  window.pcalChangesOnly = function (pid) {
    var s = state(pid);
    s.changesOnly = !s.changesOnly;
    s.limit = PAGE_ROWS;
    renderList(pid);
  };
  window.pcalSearch = function (pid, v) {
    var s = state(pid);
    s.q = v;
    s.limit = PAGE_ROWS;
    renderList(pid);
  };
  window.pcalMore = function (pid) {
    var s = state(pid);
    s.limit += PAGE_ROWS;
    renderList(pid);
  };
})();
