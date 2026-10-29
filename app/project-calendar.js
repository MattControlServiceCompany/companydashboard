// app/project-calendar.js
//
// "Calendar feed" panel at the top of the Project page, District Calendar tab.
// Shows what is on the district calendar feed and what changed since the last sync.
//
// Data (shared keys, read and written only through DB.get / DB.set):
//   en_cal_cfg_<pid>   { icsUrl, timezone }          the feed address for this project
//   en_cal_snap_<pid>  { fetchedAt, count, window, events:{key:[title,start,end,allDay,location]} }
//   en_cal_hist_<pid>  [ { id, at, counts, added, removed, changed } ]   newest first
//
// Network: ONE call to /.netlify/functions/calendar-fetch, only when the user clicks Sync.
// Opening the page or the tab makes no call. There are no timers.
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
  var _st = {}; // per project: { view, month, q, changesOnly, limit, busy, msg }

  function k(kind, pid) {
    return 'en_cal_' + kind + '_' + pid;
  }
  function state(pid) {
    return (_st[pid] = _st[pid] || {
      view: 'next14',
      month: null,
      q: '',
      changesOnly: false,
      limit: PAGE_ROWS,
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
  function monthLabel(m) {
    var a = m.split('-');
    return new Date(Number(a[0]), Number(a[1]) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function shiftMonth(m, delta) {
    var a = m.split('-');
    var d = new Date(Number(a[0]), Number(a[1]) - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
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
  function currentMonth(tz) {
    return todayOf(tz).slice(0, 7);
  }
  var VIEW_NAME = { next14: 'in the next 14 days', month: '', past: 'before today' };
  function btn(label, on, call) {
    return '<button class="btn btn-sm ' + (on ? 'btn-em' : 'btn-ghost') + '" onclick="' + call + '"' + (on ? ' aria-pressed="true"' : '') + '>' + label + '</button>';
  }
  function badge(status) {
    return status ? '<span class="pcal-badge pcal-' + status + '">' + (status === 'new' ? 'New' : status === 'changed' ? 'Changed' : 'Canceled') + '</span>' : '';
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
    if (!s.month) s.month = currentMonth(tz);
    var hist = histOf(pid);
    var v = CalendarDiff.listView({
      events: snap.events,
      last: hist[0] || null,
      tz: tz,
      today: todayOf(tz),
      mode: s.view,
      month: s.month,
      q: s.q,
      changesOnly: s.changesOnly,
    });
    var q = s.q.trim();
    var scope = s.view === 'month' ? 'in ' + monthLabel(s.month) : VIEW_NAME[s.view];
    var line;
    if (!v.compared) {
      line = 'No earlier sync to compare yet.';
    } else {
      var c = v.counts;
      var parts = [];
      if (c['new']) parts.push(num(c['new']) + ' new');
      if (c.changed) parts.push(num(c.changed) + ' changed');
      if (c.canceled) parts.push(num(c.canceled) + ' canceled');
      var prev = hist[1] ? ' (' + stampShort(hist[1].at) + ')' : '';
      line = 'Since last sync' + prev + ': ' + (parts.length ? parts.join(', ') : 'no changes') + ' ' + scope;
    }
    var last = hist[0];
    var lc = last && !last.first ? last.counts : null;
    var feedLine =
      'Whole feed: ' + num(snap.count) + (snap.count === 1 ? ' event' : ' events') +
      '; last sync ' + stampShort(snap.fetchedAt) +
      (lc ? ': ' + num(lc.added) + ' new, ' + num(lc.changed) + ' changed, ' + num(lc.removed) + ' canceled' : '');
    var stepper = '';
    if (!q && s.view === 'month') {
      stepper =
        '<div class="pcal-nav"><button class="btn btn-ghost btn-sm" aria-label="Previous month" onclick="pcalMonth(' + pid + ',-1)">&#9664;</button>' +
        '<span class="pcal-range">' + _escHtml(monthLabel(s.month)) + '</span>' +
        '<button class="btn btn-ghost btn-sm" aria-label="Next month" onclick="pcalMonth(' + pid + ',1)">&#9654;</button></div>';
    } else if (!q && s.view === 'next14') {
      var d0 = todayOf(tz);
      var d1 = CalendarDiff.addDays(d0, 13);
      var md = function (d) { return dayText(d).replace(/,\s*\d{4}$/, ''); };
      stepper = '<div class="pcal-nav"><span class="pcal-range" style="text-align:left">' + _escHtml(md(d0) + ' – ' + md(d1)) + '</span></div>';
    }
    var controls =
      '<div class="pcal-nav">' +
      btn('Next 14 days', s.view === 'next14' && !q, 'pcalView(' + pid + ",'next14')") +
      btn('This month', s.view === 'month' && !q, 'pcalView(' + pid + ",'month')") +
      btn('Show past', s.view === 'past' && !q, 'pcalView(' + pid + ",'past')") +
      (v.compared ? btn('Changes only', s.changesOnly, 'pcalChangesOnly(' + pid + ')') : '') +
      '</div>' + stepper;
    var shown = v.items.slice(0, s.limit);
    var today = todayOf(tz);
    var yr = today.slice(0, 4);
    var body = '';
    var lastDay = null;
    shown.forEach(function (e) {
      if (e.day !== lastDay) {
        lastDay = e.day;
        body +=
          '<tr class="pcal-day"><th colspan="3" scope="colgroup">' +
          _escHtml(CalendarDiff.dayLabel(e.day) + (e.day.slice(0, 4) !== yr ? ', ' + e.day.slice(0, 4) : '') + (e.day === today ? ' (today)' : '')) +
          '</th></tr>';
      }
      var pl = CalendarDiff.eventPlace({ title: e.row[0], location: e.row[4] });
      var place = pl.fromTitle ? '<i title="Taken from the event title">' + _escHtml(pl.text) + '</i>' : _escHtml(pl.text);
      var multi = '';
      if (e.row[3] || /^\d{4}-\d{2}-\d{2}$/.test(e.row[1])) {
        var lastD = CalendarDiff.allDayLastDay(e.row[1], e.row[2], tz);
        if (lastD > dayKey(e.row[1], tz)) multi = ' (through ' + dayText(lastD) + ')';
      }
      var what =
        '<span class="pcal-ev">' + _escHtml(e.row[0]) + '</span> ' + badge(e.status) +
        (e.lines.length ? '<div class="pcal-chg">' + e.lines.map(_escHtml).join('<br>') + '</div>' : '');
      var tip = e.lines.length ? ' title="' + _escHtml(e.lines.join('; ')) + '"' : '';
      body +=
        '<tr class="pcal-r' + (e.status === 'canceled' ? ' pcal-gone' : '') + '"' + tip + '><td>' +
        _escHtml(CalendarDiff.timeText(e.row, tz) + multi) +
        '</td><td>' + what + '</td><td>' + place + '</td></tr>';
    });
    var tbl = shown.length
      ? '<div class="pcal-outer"><table class="pcal-tbl pcal-ev-tbl"><colgroup><col style="width:24%"><col style="width:48%"><col style="width:28%"></colgroup>' +
        '<thead><tr><th>Time</th><th>Event</th><th>Location</th></tr></thead><tbody>' + body + '</tbody></table></div>'
      : '<div style="font-size:12px;margin-top:8px">' +
        (s.changesOnly ? 'No changes ' + _escHtml(scope) + '.' : 'No events found.') + '</div>';
    var heading = q
      ? 'Events matching "' + q + '" (' + num(v.items.length) + ')'
      : (s.view === 'month' ? monthLabel(s.month) : s.view === 'past' ? 'Past events, newest first' : 'Next 14 days') + ' (' + num(v.items.length) + ' events)';
    host.innerHTML =
      '<div class="pcal-sum">' + _escHtml(line) + '</div><div class="pcal-feed">' + _escHtml(feedLine) + '</div>' + controls + '<h4>' + _escHtml(heading) + '</h4>' + tbl +
      (v.items.length > shown.length
        ? '<div class="pcal-nav"><span style="font-size:12px">Showing ' + num(shown.length) + ' of ' + num(v.items.length) +
          '.</span><button class="btn btn-ghost btn-sm" onclick="pcalMore(' + pid + ')">Show more</button></div>'
        : '');
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
        (s.busy ? 'Syncing...' : 'Sync feed') +
        '</button>'
      : '';
    var summary;
    if (!cfg) {
      summary =
        '<div style="font-size:13px">Enter the calendar feed address for this project, then choose Save and sync.</div>';
    } else if (!snap) {
      summary = '<div style="font-size:13px">No copy of the feed is saved yet. Choose Sync feed.</div>';
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
      '</button></div>';
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
      '"></div></div></div>';
    renderList(pid);
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
    var had = !!cfgOf(pid);
    await DB.set(k('cfg', pid), { icsUrl: url, timezone: tz });
    state(pid).month = null;
    if (had) {
      say(pid, 'Feed address saved.');
      render(pid);
    } else {
      render(pid);
      await sync(pid);
    }
  }
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
    render(pid);
    try {
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
        return;
      }
      var fresh = body.snapshot;
      var snap = { fetchedAt: fresh.fetchedAt, count: fresh.count, window: fresh.window, leftOut: fresh.leftOut || [], events: fresh.events };
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
      s.month = null;
    } catch (e) {
      s.msg = 'The calendar feed could not be read. The last saved copy is kept.';
    } finally {
      s.busy = false;
      render(pid);
    }
  }

  window.pcalRender = render;
  window.pcalSync = sync;
  window.pcalSave = save;
  window.pcalMonth = function (pid, d) {
    var s = state(pid);
    s.view = 'month';
    s.month = shiftMonth(s.month || currentMonth(tzOf(pid)), d);
    s.q = '';
    s.limit = PAGE_ROWS;
    var q = document.getElementById('pcal-q-' + pid);
    if (q) q.value = '';
    renderList(pid);
  };
  window.pcalView = function (pid, view) {
    var s = state(pid);
    s.view = view;
    s.month = null;
    s.q = '';
    s.limit = PAGE_ROWS;
    render(pid);
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
