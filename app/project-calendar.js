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
  var _st = {}; // per project: { month, q, limit, busy, msg, index, indexFor }

  function k(kind, pid) {
    return 'en_cal_' + kind + '_' + pid;
  }
  function state(pid) {
    return (_st[pid] = _st[pid] || {
      month: null,
      q: '',
      limit: PAGE_ROWS,
      busy: false,
      msg: '',
      index: null,
      indexFor: null,
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
      '.pcal-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.pcal-chip{font-size:12px;padding:3px 10px;border-radius:20px;border:1px solid var(--border2);color:var(--text);background:var(--s3)}',
      '.pcal-chip.em{border-color:var(--em)}',
      '.pcal-tbl .pcal-chip{padding:2px 6px;white-space:nowrap}',
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
  function chip(text, cls) {
    return '<span class="pcal-chip' + (cls ? ' ' + cls : '') + '">' + _escHtml(text) + '</span>';
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
      out += '<h4>Added (' + num(rec.counts.added) + ')</h4>' + table(two, listRows(rec.added, tz));
    }
    if (rec.removed && rec.removed.length) {
      out += '<h4>Removed (' + num(rec.counts.removed) + ')</h4>' + table(two, listRows(rec.removed, tz));
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
  function buildIndex(pid) {
    var s = state(pid);
    var snap = snapOf(pid);
    if (!snap) return [];
    var tz = tzOf(pid);
    var sig = snap.fetchedAt + '|' + tz;
    if (s.index && s.indexFor === sig) return s.index;
    var idx = Object.keys(snap.events).map(function (key) {
      var r = snap.events[key];
      return { key: key, row: r, day: r[1] ? dayKey(r[1], tz) : '' };
    });
    idx.sort(function (a, b) {
      var x = a.row[1] || '';
      var y = b.row[1] || '';
      return x < y ? -1 : x > y ? 1 : 0;
    });
    s.index = idx;
    s.indexFor = sig;
    return idx;
  }
  function currentMonth(tz) {
    return dayKey(new Date().toISOString(), tz).slice(0, 7);
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
    var q = s.q.trim().toLowerCase();
    var idx = buildIndex(pid);
    var last = histOf(pid)[0] || null;
    var newKeys = {};
    var chgKeys = {};
    if (last && !last.first) {
      (last.added || []).forEach(function (x) {
        newKeys[x.key] = 1;
      });
      (last.changed || []).forEach(function (x) {
        chgKeys[x.key] = 1;
      });
    }
    var list = idx.filter(function (e) {
      if (q) return (e.row[0] + ' ' + e.row[4]).toLowerCase().indexOf(q) !== -1;
      return e.day.slice(0, 7) === s.month;
    });
    var shown = list.slice(0, s.limit);
    var heading = q
      ? 'Events matching "' + s.q.trim() + '" (' + num(list.length) + ')'
      : monthLabel(s.month) + ' (' + num(list.length) + ' events)';
    var rows = shown.map(function (e) {
      var tag = newKeys[e.key] ? chip('New', 'em') : chgKeys[e.key] ? chip('Changed', 'em') : '';
      var pl = CalendarDiff.eventPlace({ title: e.row[0], location: e.row[4] });
      var place = pl.fromTitle
        ? '<i title="Taken from the event title">' + _escHtml(pl.text) + '</i>'
        : _escHtml(pl.text);
      return [_escHtml(when(e.row[1], e.row[3], tz, e.row[2])), _escHtml(e.row[0]) + (tag ? ' ' + tag : ''), place];
    });
    host.innerHTML =
      '<h4>' +
      _escHtml(heading) +
      '</h4>' +
      (rows.length
        ? table(
            [
              ['Date', '28%'],
              ['Event', '44%'],
              ['Location', '28%'],
            ],
            rows,
          )
        : '<div style="font-size:12px;margin-top:8px">No events found.</div>') +
      (list.length > shown.length
        ? '<div class="pcal-nav"><span style="font-size:12px">Showing ' +
          num(shown.length) +
          ' of ' +
          num(list.length) +
          '.</span><button class="btn btn-ghost btn-sm" onclick="pcalMore(' +
          pid +
          ')">Show more</button></div>'
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
      var last = hist[0];
      var c = last && !last.first ? last.counts : null;
      summary =
        '<div class="pcal-chips">' +
        chip('Last sync ' + stamp(snap.fetchedAt)) +
        chip(num(snap.count) + (snap.count === 1 ? ' event in feed' : ' events in feed')) +
        (c
          ? chip(num(c.added) + ' added') +
            chip(num(c.removed) + ' removed') +
            chip(num(c.changed) + ' changed') +
            chip(num(c.unchanged) + ' unchanged')
          : chip('First copy saved. Changes show after the next sync.')) +
        '</div>';
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
    var changes = '';
    if (hist[0] && !hist[0].first) {
      changes = '<details><summary>Changes in last sync</summary>' + changeTables(hist[0], tz) + '</details>';
    }
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
                ' added, ' +
                num(r.counts.removed) +
                ' removed, ' +
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
        '<button class="btn btn-ghost btn-sm" onclick="pcalMonth(' +
        pid +
        ',-1)">Previous month</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="pcalMonth(' +
        pid +
        ',1)">Next month</button>' +
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
      changes +
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
    state(pid).index = null;
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
      s.index = null;
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
    s.month = shiftMonth(s.month || currentMonth(tzOf(pid)), d);
    s.q = '';
    s.limit = PAGE_ROWS;
    var q = document.getElementById('pcal-q-' + pid);
    if (q) q.value = '';
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
