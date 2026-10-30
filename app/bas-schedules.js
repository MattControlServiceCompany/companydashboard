// app/bas-schedules.js
//
// "BAS schedules" card on the Project page, District Calendar tab (below the Calendar feed card).
// Keeps a dated copy of the building automation schedules and shows what changed between copies.
//
// Data (shared keys, read and written only through DB.get / DB.set; class SYNCED, prefix en_bas_):
//   en_bas_snap_<pid>    { "YYYY-MM-DD": { forDate, importedAt, importedBy, rows:{ "location|program": [[start,end,mode]] } } }
//   en_bas_hist_<pid>    [ { id, kind, at, by, forDate, comparedTo, buildings, counts, byBuilding, added, removed, changed } ]  newest first, 50
//   en_bas_groups_<pid>  { importedAt, importedBy, groups:{ "building|group": { building, group, schedules, members } } }
//
// Network: none. Opening the page or the tab reads saved data only. Files are read in the browser.
// The CSV is read by emParseEffectiveSchedulesCSV and the time blocks by _emScheduleBlocks (app/equipment-matrix.js),
// the comparison and the choice of the earlier copy by BasDiff (app/bas-diff.js). Tables use the calendar's table (window.pcalUi).
(function () {
  'use strict';

  var PAGE_ROWS = 200;
  var _st = {}; // per project: { date, bldg, q, limit, msg, pending, gpending }

  function state(pid) {
    return (_st[pid] = _st[pid] || { date: '', bldg: '', q: '', limit: PAGE_ROWS, msg: '', pending: null, gpending: null });
  }
  function ui() {
    return window.pcalUi;
  }
  function snapsOf(pid) {
    var s = DB.get('en_bas_snap_' + pid, {});
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  // Saved dates, newest first. A key that is not a real YYYY-MM-DD date is never shown (synced data is untrusted).
  function dateKeys(snaps) {
    return Object.keys(snaps)
      .filter(BasDiff.isDate)
      .sort()
      .reverse();
  }
  function histOf(pid) {
    var h = DB.get('en_bas_hist_' + pid, []);
    return Array.isArray(h) ? h : [];
  }
  function groupsOf(pid) {
    return DB.get('en_bas_groups_' + pid, null);
  }
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
  function num(n) {
    return ui().num(n);
  }
  function plural(n, one, many) {
    return num(n) + ' ' + (n === 1 ? one : many);
  }
  function timeText(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function shortStamp(iso) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ensureStyle() {
    ui().ensureStyle();
    if (document.getElementById('bas-style')) return;
    var s = document.createElement('style');
    s.id = 'bas-style';
    s.textContent = [
      '.bas-file{display:none}',
      '.bas-box{border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-top:12px;background:var(--s2)}',
      '.bas-box .pcal-row{margin-top:8px}',
      '.bas-date{flex:0 0 auto;width:auto}',
      '.bas-sched{white-space:nowrap}',
    ].join('');
    document.head.appendChild(s);
  }

  // --- text of one change -----------------------------------------------------------------
  // 'Area A / Room 101' from a key (the district and building parts of the path are left out).
  function programLabel(key) {
    var p = BasDiff.splitKey(key);
    var parts = p.location.split('/').map(function (x) { return x.trim(); }).filter(Boolean).slice(2);
    return parts.concat([p.program]).join(' / ');
  }
  function buildingLine(rec) {
    var names = Object.keys(rec.byBuilding || {}).filter(function (b) {
      var c = rec.byBuilding[b];
      return c.added + c.removed + c.changed > 0;
    });
    return names
      .map(function (b) {
        var c = rec.byBuilding[b];
        return b + ' ' + num(c.added + c.removed + c.changed);
      })
      .join(', ');
  }
  function recSummary(rec) {
    var head = shortStamp(rec.at) + (rec.by ? ' by ' + rec.by : '') + ' — ';
    var total = rec.counts.total;
    if (rec.kind === 'groups') {
      if (rec.first) return head + 'scheduling groups: first copy saved, ' + plural(total, 'group', 'groups');
      return (
        head + 'scheduling groups: ' + num(rec.counts.added) + ' new, ' + num(rec.counts.removed) + ' removed, ' +
        num(rec.counts.changed) + ' changed'
      );
    }
    var day = BasDiff.dateText(rec.forDate);
    if (rec.first) return head + day + ': first copy, ' + plural(total, 'program', 'programs') + ' (' + rec.buildings.map(function (b) { return b.name; }).join(', ') + ')';
    var by = buildingLine(rec);
    return (
      head + day + ' compared with ' + BasDiff.dateText(rec.comparedTo) + ': ' + num(rec.counts.changed) + ' changed, ' +
      num(rec.counts.added) + ' new, ' + num(rec.counts.removed) + ' removed' + (by ? ' (' + by + ')' : '')
    );
  }
  function recTables(rec) {
    var T = ui().table;
    var out = '';
    var isGroup = rec.kind === 'groups';
    var label = function (key) {
      return isGroup ? esc(key.split('|')[1]) : esc(programLabel(key));
    };
    var bldg = function (key) {
      return esc(isGroup ? key.split('|')[0] : BasDiff.keyBuilding(key));
    };
    var what = function (x) {
      return esc(isGroup ? x.text : BasDiff.blocksText(x.blocks));
    };
    if (rec.changed && rec.changed.length) {
      out +=
        '<h4>Changed (' + num(rec.counts.changed) + ')</h4>' +
        T(
          [['Building', '18%'], [isGroup ? 'Group' : 'Program', '30%'], ['Before', '26%'], ['After', '26%']],
          rec.changed.map(function (x) {
            return [
              bldg(x.key), label(x.key),
              esc(isGroup ? x.before : BasDiff.blocksText(x.before)),
              esc(isGroup ? x.after : BasDiff.blocksText(x.after)),
            ];
          }),
        );
    }
    [['added', 'New'], ['removed', 'Removed']].forEach(function (g) {
      if (rec[g[0]] && rec[g[0]].length) {
        out +=
          '<h4>' + g[1] + ' (' + num(rec.counts[g[0]]) + ')</h4>' +
          T(
            [['Building', '18%'], [isGroup ? 'Group' : 'Program', '32%'], ['Schedule', '50%']],
            rec[g[0]].map(function (x) { return [bldg(x.key), label(x.key), what(x)]; }),
          );
      }
    });
    var n = rec.counts.added + rec.counts.removed + rec.counts.changed;
    if (!n) out = '<div style="font-size:12px;margin-top:8px">Nothing changed in this import.</div>';
    var cutShort = ['added', 'removed', 'changed'].some(function (g) { return rec[g] && rec[g].length < rec.counts[g]; });
    if (cutShort) out += '<div style="font-size:12px;margin-top:8px">Only the first ' + BasDiff.DETAIL_CAP + ' of each group are listed. The counts are complete.</div>';
    return out;
  }

  // --- sections ---------------------------------------------------------------------------------
  function datesSection(pid, snaps) {
    var dates = dateKeys(snaps);
    if (!dates.length) {
      return '<div style="font-size:13px;margin-top:8px">No schedules are saved yet. Choose Import schedules and pick the WebCTRL Effective Schedules files.</div>';
    }
    var rows = dates.map(function (d) {
      var sn = snaps[d];
      var n = Object.keys(sn.rows).length;
      var b = Object.keys(BasDiff.buildingCounts(sn.rows)).length;
      return [
        esc(BasDiff.dateText(d)),
        esc(plural(n, 'program', 'programs') + ' in ' + plural(b, 'building', 'buildings')),
        esc(shortStamp(sn.importedAt) + (sn.importedBy ? ' by ' + sn.importedBy : '')),
        '<button class="btn btn-ghost btn-sm" data-date="' + esc(d) + '" onclick="basView(' + pid + ',this.dataset.date)">View</button>',
      ];
    });
    return (
      '<h4>Saved dates</h4>' +
      ui().table([['Date covered', '26%'], ['What is saved', '34%'], ['Imported', '28%'], ['', '12%']], rows)
    );
  }
  function histSection(hist) {
    if (!hist.length) return '';
    return (
      '<details open><summary>BAS changes (' + hist.length + ')</summary>' +
      hist
        .map(function (r) {
          return '<details class="pcal-hist-item"><summary>' + esc(recSummary(r)) + '</summary>' + (r.first ? '' : recTables(r)) + '</details>';
        })
        .join('') +
      '</details>'
    );
  }
  function viewSection(pid, snaps) {
    var dates = dateKeys(snaps);
    if (!dates.length) return '';
    var s = state(pid);
    if (!snaps[s.date]) s.date = dates[0];
    var snap = snaps[s.date];
    var counts = BasDiff.buildingCounts(snap.rows);
    var names = Object.keys(counts).sort();
    if (s.bldg && names.indexOf(s.bldg) < 0) s.bldg = '';
    var q = s.q.trim().toLowerCase();
    var keys = Object.keys(snap.rows)
      .filter(function (k) {
        if (s.bldg && BasDiff.keyBuilding(k) !== s.bldg) return false;
        if (!q) return true;
        return (k + ' ' + BasDiff.blocksText(snap.rows[k])).toLowerCase().indexOf(q) >= 0;
      })
      .sort(function (a, b) {
        var ba = BasDiff.keyBuilding(a);
        var bb = BasDiff.keyBuilding(b);
        return ba < bb ? -1 : ba > bb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    var shown = keys.slice(0, s.limit);
    var dateOpts = dates
      .map(function (d) { return '<option value="' + esc(d) + '"' + (d === s.date ? ' selected' : '') + '>' + esc(BasDiff.dateText(d)) + '</option>'; })
      .join('');
    var bOpts =
      '<option value="">All buildings</option>' +
      names.map(function (b) { return '<option value="' + esc(b) + '"' + (b === s.bldg ? ' selected' : '') + '>' + esc(b + ' (' + counts[b] + ')') + '</option>'; }).join('');
    var body = '';
    var last = null;
    shown.forEach(function (k) {
      var b = BasDiff.keyBuilding(k);
      if (b !== last) {
        last = b;
        body += '<tr class="pcal-day"><th colspan="2" scope="colgroup">' + esc(b) + '</th></tr>';
      }
      body += '<tr><td>' + esc(programLabel(k)) + '</td><td>' + esc(BasDiff.blocksText(snap.rows[k])) + '</td></tr>';
    });
    var tbl = shown.length
      ? '<div class="pcal-outer"><table class="pcal-tbl pcal-ev-tbl"><colgroup><col style="width:55%"><col style="width:45%"></colgroup>' +
        '<thead><tr><th>Program</th><th>Schedule</th></tr></thead><tbody>' + body + '</tbody></table></div>'
      : '<div style="font-size:12px;margin-top:8px">No programs found.</div>';
    return (
      '<h4>Schedules saved for ' + esc(BasDiff.dateText(s.date)) + ' (' + num(keys.length) + ')</h4>' +
      '<div class="pcal-nav">' +
      '<select class="fi bas-date" aria-label="Date" onchange="basPickDate(' + pid + ',this.value)">' + dateOpts + '</select>' +
      '<select class="fi bas-date" aria-label="Building" onchange="basPickBldg(' + pid + ',this.value)">' + bOpts + '</select>' +
      '<input class="fi" id="bas-q-' + pid + '" placeholder="Search schedules" value="' + esc(s.q) + '" oninput="basSearch(' + pid + ',this.value)" style="flex:1 1 220px;min-width:0"></div>' +
      '<div id="bas-view-' + pid + '">' + tbl +
      (keys.length > shown.length
        ? '<div class="pcal-nav"><span style="font-size:12px">Showing ' + num(shown.length) + ' of ' + num(keys.length) + '.</span><button class="btn btn-ghost btn-sm" onclick="basMore(' + pid + ')">Show more</button></div>'
        : '') +
      '</div>'
    );
  }
  function groupsSection(g) {
    if (!g) return '<h4>Scheduling groups</h4><div style="font-size:13px;margin-top:8px">No scheduling groups are saved yet. Choose Import scheduling groups and pick the groups file and the group members file.</div>';
    var keys = Object.keys(g.groups).sort(function (a, b) {
      var x = g.groups[a];
      var y = g.groups[b];
      return x.building < y.building ? -1 : x.building > y.building ? 1 : x.group < y.group ? -1 : x.group > y.group ? 1 : 0;
    });
    var bset = {};
    keys.forEach(function (k) { bset[g.groups[k].building] = 1; });
    var body = '';
    var last = null;
    keys.forEach(function (k) {
      var x = g.groups[k];
      if (x.building !== last) {
        last = x.building;
        body += '<tr class="pcal-day"><th colspan="5" scope="colgroup">' + esc(x.building) + '</th></tr>';
      }
      var mem = x.members.length
        ? '<details><summary>' + esc(plural(x.members.length, 'member', 'members')) + '</summary>' + x.members.map(function (m) { return '<div>' + esc(m) + '</div>'; }).join('') + '</details>'
        : '<div>No members in file</div>';
      var cell = '<b>' + esc(x.group) + '</b>' + mem;
      var sch = x.schedules.length ? x.schedules : [null];
      sch.forEach(function (s, i) {
        body +=
          '<tr><td>' + (i === 0 ? cell : '') + '</td>' +
          (s
            ? '<td>' + esc(s.description + (s.type ? ' (' + s.type + ')' : '')) + '</td><td>' + esc(s.days) + '</td><td' +
              (BasDiff.readableHours(s).note ? ' title="' + esc(BasDiff.readableHours(s).note) + '"' : '') + '>' +
              esc(BasDiff.readableHours(s).text) + '</td><td>' + esc(BasDiff.readableDates(s.dates)) + '</td>'
            : '<td colspan="4">No schedule in file</td>') +
          '</tr>';
      });
    });
    return (
      '<h4>Scheduling groups (' + num(keys.length) + ' in ' + Object.keys(bset).length + ' buildings)</h4>' +
      '<div class="pcal-feed">Saved ' + esc(shortStamp(g.importedAt) + (g.importedBy ? ' by ' + g.importedBy : '')) + '</div>' +
      '<div class="pcal-outer"><table class="pcal-tbl pcal-ev-tbl"><colgroup><col style="width:28%"><col style="width:30%"><col style="width:12%"><col style="width:20%"><col style="width:10%"></colgroup>' +
      '<thead><tr><th>Group</th><th>Schedule</th><th>Days</th><th>Hours</th><th>Dates</th></tr></thead><tbody>' + body + '</tbody></table></div>'
    );
  }
  function pendingBox(pid) {
    var s = state(pid);
    var p = s.pending;
    var g = s.gpending;
    if (g) {
      var rows = g.files.map(function (f) {
        return [esc(f.name), esc(f.kind === 'schedules' ? 'Group schedules' : f.kind === 'members' ? 'Group members' : 'Not a scheduling groups file'), esc(f.kind ? num(f.items) : '')];
      });
      var ok = g.files.some(function (f) { return f.kind; });
      return (
        '<div class="bas-box"><b>Import scheduling groups</b>' +
        ui().table([['File', '46%'], ['What it holds', '34%'], ['Rows', '20%']], rows) +
        '<div class="pcal-row">' +
        (ok ? '<button class="btn btn-em btn-sm" onclick="basSaveGroups(' + pid + ')">Save groups</button>' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="basCancel(' + pid + ')">Cancel</button></div></div>'
      );
    }
    if (!p) return '';
    var frows = [];
    p.files.forEach(function (f) {
      var names = Object.keys(f.buildings).sort();
      if (!f.programs) frows.push([esc(f.name), esc('No schedules found. This is not an Effective Schedules file.'), '0']);
      else frows.push([esc(f.name), esc(names.map(function (b) { return b + ' (' + f.buildings[b] + ')'; }).join(', ')), esc(num(f.programs))]);
    });
    var total = p.files.reduce(function (t, f) { return t + f.programs; }, 0);
    var dup = p.date && snapsOf(pid)[p.date] ? '<div class="pcal-msg">A copy for this date is already saved. The buildings in these files replace their old rows, and the change is listed.</div>' : '';
    return (
      '<div class="bas-box"><b>Import schedules</b>' +
      ui().table([['File', '30%'], ['Building found in the Location column (programs)', '56%'], ['Programs', '14%']], frows) +
      '<div class="pcal-row"><label for="bas-for-' + pid + '"><b>Date this export covers</b> (required)</label>' +
      '<input class="fi bas-date" type="date" id="bas-for-' + pid + '" value="' + esc(p.date) + '" onchange="basSetDate(' + pid + ',this.value)"></div>' +
      dup +
      '<div class="pcal-row">' +
      (total ? '<button class="btn btn-em btn-sm" onclick="basSave(' + pid + ')">Save ' + esc(plural(total, 'program', 'programs')) + '</button>' : '') +
      '<button class="btn btn-ghost btn-sm" onclick="basCancel(' + pid + ')">Cancel</button></div></div>'
    );
  }

  // --- panel -------------------------------------------------------------------------------------
  function render(pid) {
    var host = document.getElementById('bas-panel-' + pid);
    if (!host) return;
    ensureStyle();
    var s = state(pid);
    var snaps = snapsOf(pid);
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr" style="justify-content:space-between"><span class="card-title">BAS schedules</span>' +
      '<span style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-em btn-sm" onclick="document.getElementById(\'bas-file-' + pid + '\').click()">Import schedules</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'bas-gfile-' + pid + '\').click()">Import scheduling groups</button></span></div>' +
      '<div style="padding:16px">' +
      '<input class="bas-file" type="file" id="bas-file-' + pid + '" accept=".csv,text/csv" multiple onchange="basPick(' + pid + ',this)">' +
      '<input class="bas-file" type="file" id="bas-gfile-' + pid + '" accept=".csv,text/csv" multiple onchange="basPickGroups(' + pid + ',this)">' +
      '<div class="pcal-msg" id="bas-msg-' + pid + '" role="status">' + esc(s.msg) + '</div>' +
      pendingBox(pid) +
      datesSection(pid, snaps) +
      histSection(histOf(pid)) +
      viewSection(pid, snaps) +
      groupsSection(groupsOf(pid)) +
      '</div></div>';
  }
  function say(pid, msg) {
    state(pid).msg = msg;
    var el = document.getElementById('bas-msg-' + pid);
    if (el) el.textContent = msg;
  }
  function newId() {
    return 'bash_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function readFiles(input) {
    var files = Array.prototype.slice.call(input.files || []);
    return Promise.all(
      files.map(function (f) {
        return f.text().then(function (t) { return { name: f.name, text: t }; });
      }),
    ).then(function (r) {
      input.value = '';
      return r;
    });
  }

  window.basRender = render;
  window.basPick = function (pid, input) {
    readFiles(input).then(function (files) {
      if (!files.length) return;
      var parsed = [];
      var infos = files.map(function (f) {
        var p = emParseEffectiveSchedulesCSV(f.text).filter(function (r) {
          return _emScheduleBlocks(r.scheduleText).length > 0;
        });
        parsed = parsed.concat(p);
        var rows = BasDiff.rowsFromParsed(p, _emScheduleBlocks);
        return { name: f.name, programs: p.length, buildings: BasDiff.buildingCounts(rows) };
      });
      var s = state(pid);
      s.gpending = null;
      s.pending = { files: infos, parsed: parsed, date: '' };
      s.msg = '';
      render(pid);
    });
  };
  window.basSetDate = function (pid, v) {
    var p = state(pid).pending;
    if (p) {
      p.date = v;
      render(pid);
    }
  };
  window.basCancel = function (pid) {
    var s = state(pid);
    s.pending = null;
    s.gpending = null;
    render(pid);
  };
  window.basSave = async function (pid) {
    var s = state(pid);
    var p = s.pending;
    if (!p) return;
    var res = BasDiff.applyScheduleImport({
      snaps: snapsOf(pid),
      hist: histOf(pid),
      rows: BasDiff.rowsFromParsed(p.parsed, _emScheduleBlocks),
      forDate: p.date,
      now: new Date().toISOString(),
      by: whoName(),
      id: newId(),
    });
    if (res.error) return say(pid, res.error);
    await DB.set('en_bas_hist_' + pid, res.hist);
    await DB.set('en_bas_snap_' + pid, res.snaps);
    // The same import also fills the Equipment Matrix schedules (Set Points tab, Facility Audit, reports).
    var att = typeof emAttachParsedSchedules === 'function' ? emAttachParsedSchedules(pid, p.parsed, p.files.map(function (f) { return f.name; }).join(', ')) : null;
    s.pending = null;
    s.date = p.date;
    s.msg =
      'Saved ' + plural(p.parsed.length, 'program', 'programs') + ' for ' + BasDiff.dateText(p.date) + '.' +
      (att && !att.error ? ' ' + att.matchedCount + ' of ' + att.totalCount + ' matched to Equipment Matrix rows.' : '') +
      (att && att.error ? ' Equipment Matrix schedules not filled: ' + att.error : '');
    render(pid);
  };
  window.basPickGroups = function (pid, input) {
    readFiles(input).then(function (files) {
      if (!files.length) return;
      var infos = files.map(function (f) {
        var r = BasDiff.readGroupRows(emParseCSVText(f.text));
        return { name: f.name, kind: r.kind, items: r.items.length, list: r.items };
      });
      var s = state(pid);
      s.pending = null;
      s.gpending = { files: infos };
      s.msg = '';
      render(pid);
    });
  };
  window.basSaveGroups = async function (pid) {
    var s = state(pid);
    if (!s.gpending) return;
    var pick = function (kind) {
      var out = [];
      s.gpending.files.forEach(function (f) {
        if (f.kind === kind) out = out.concat(f.list);
      });
      return out.length ? out : null;
    };
    var res = BasDiff.applyGroupsImport({
      hist: histOf(pid),
      groups: groupsOf(pid),
      scheduleItems: pick('schedules'),
      memberItems: pick('members'),
      now: new Date().toISOString(),
      by: whoName(),
      id: newId(),
    });
    if (res.error) return say(pid, res.error);
    await DB.set('en_bas_hist_' + pid, res.hist);
    await DB.set('en_bas_groups_' + pid, res.groups);
    s.gpending = null;
    s.msg = 'Saved ' + plural(res.rec.counts.total, 'scheduling group', 'scheduling groups') + '.';
    render(pid);
  };
  window.basView = function (pid, d) {
    var s = state(pid);
    s.date = d;
    s.limit = PAGE_ROWS;
    render(pid);
    var el = document.getElementById('bas-view-' + pid);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  };
  window.basPickDate = function (pid, d) {
    window.basView(pid, d);
  };
  window.basPickBldg = function (pid, b) {
    var s = state(pid);
    s.bldg = b;
    s.limit = PAGE_ROWS;
    render(pid);
  };
  window.basSearch = function (pid, v) {
    var s = state(pid);
    s.q = v;
    s.limit = PAGE_ROWS;
    render(pid);
    var el = document.getElementById('bas-q-' + pid);
    if (el) {
      el.focus();
      el.setSelectionRange(v.length, v.length);
    }
  };
  window.basMore = function (pid) {
    var s = state(pid);
    s.limit += PAGE_ROWS;
    render(pid);
  };
})();
