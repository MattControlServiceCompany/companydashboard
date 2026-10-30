// app/space-map.js
//
// "Space map" card on the Project page, District Calendar tab (below the Calendar feed card).
// Says which BAS program(s) heat and cool each calendar space, so the BAS column of the events list can check
// each event. A space can also be marked Off-site (no BAS action).
//
// Data (shared key, read and written only through DB.get / DB.set; class SYNCED, prefix en_space_map_):
//   en_space_map_<pid>  { spaces:{ "<normalized space>": { space, programs:["location|program"], offsite, confirmed, by, at } } }
// Only a confirmed space is checked. A suggestion (from the space name, or from an imported suggestions file) is shown
// with a Confirm button; the user confirms each one.
//
// Network: none. Opening the tab reads saved data only. The suggestions file is read in the browser.
// The rules (name suggestions, matching a program to the saved schedules, reading the file) are in
// computations/bas-coverage.js (BasCoverage); the file is read by emParseCSVText (app/equipment-matrix.js).
// Tables use the calendar's table (window.pcalUi).
(function () {
  'use strict';

  var LIST_MAX = 40;
  var _st = {}; // per project: { rows, edit, sel, q, matches, msg }

  function state(pid) {
    return (_st[pid] = _st[pid] || { rows: [], edit: -1, sel: {}, q: '', matches: [], msg: '' });
  }
  function mapOf(pid) {
    var m = DB.get('en_space_map_' + pid, null);
    return m && typeof m === 'object' && m.spaces && typeof m.spaces === 'object' ? m : { spaces: {} };
  }
  function snapsOf(pid) {
    var s = DB.get('en_bas_snap_' + pid, {});
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  // Program row keys of the newest saved BAS copy, serving units left out.
  function programKeys(pid) {
    var snaps = snapsOf(pid);
    var dates = Object.keys(snaps)
      .filter(BasDiff.isDate)
      .sort();
    if (!dates.length || !snaps[dates[dates.length - 1]].rows) return [];
    return Object.keys(snaps[dates[dates.length - 1]].rows).filter(function (k) {
      return !BasCoverage.isServingProgram(BasDiff.splitKey(k).program.replace(/ #\d+$/, ''));
    });
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
  function tzOf(pid) {
    var c = DB.get('en_cal_cfg_' + pid, null);
    return (c && c.timezone) || 'America/Chicago';
  }
  function today(tz) {
    return CalendarDiff.calendarDay(new Date().toISOString(), tz);
  }
  // Spaces of the upcoming events (today and later): [{ key, space, count }], most events first.
  function upcomingSpaces(pid) {
    var snap = DB.get('en_cal_snap_' + pid, null);
    var tz = tzOf(pid);
    var t = today(tz);
    var by = {};
    Object.keys((snap && snap.events) || {}).forEach(function (id) {
      var row = snap.events[id];
      if (!row[1]) return;
      var last = CalendarDiff.calendarDay(row[1], tz);
      if (row[3] || /^\d{4}-\d{2}-\d{2}$/.test(row[1])) last = CalendarDiff.allDayLastDay(row[1], row[2], tz);
      if (last < t) return;
      var place = CalendarDiff.eventPlace({ title: row[0], location: row[4] }).text;
      if (!place) return;
      var key = BasCoverage.spaceKey(place);
      by[key] = by[key] || { key: key, space: place, count: 0 };
      by[key].count++;
    });
    return Object.keys(by)
      .map(function (k) {
        return by[k];
      })
      .sort(function (a, b) {
        return b.count - a.count || (a.space < b.space ? -1 : 1);
      });
  }
  function short(key) {
    var p = BasDiff.splitKey(key);
    return BasDiff.buildingOf(p.location) + ': ' + p.program;
  }
  function programsText(keys) {
    if (!keys.length) return 'none chosen';
    var t = keys.slice(0, 3).map(short).join('; ');
    return t + (keys.length > 3 ? '; +' + (keys.length - 3) + ' more' : '');
  }

  function rowsFor(pid) {
    var map = mapOf(pid);
    var keys = programKeys(pid);
    var list = upcomingSpaces(pid);
    var seen = {};
    list.forEach(function (x) {
      seen[x.key] = 1;
    });
    Object.keys(map.spaces).forEach(function (k) {
      if (!seen[k]) list.push({ key: k, space: map.spaces[k].space || k, count: 0 });
    });
    return list.map(function (x) {
      var e = map.spaces[x.key];
      var r = { key: x.key, space: x.space, count: x.count, state: 'none', programs: [], offsite: false };
      if (e && e.confirmed) {
        r.state = 'confirmed';
        r.offsite = !!e.offsite;
        r.programs = e.programs || [];
      } else {
        var sug = e && e.programs && e.programs.length ? e.programs : BasCoverage.suggestPrograms(x.space, keys);
        if (sug.length) {
          r.state = 'suggested';
          r.programs = sug;
        }
      }
      return r;
    });
  }

  function render(pid) {
    var host = document.getElementById('space-panel-' + pid);
    if (!host) return;
    window.pcalUi.ensureStyle();
    var s = state(pid);
    var rows = rowsFor(pid);
    s.rows = rows;
    var hasBas = programKeys(pid).length > 0;
    var nConf = rows.filter(function (r) { return r.state === 'confirmed'; }).length;
    var nSug = rows.filter(function (r) { return r.state === 'suggested'; }).length;
    var nNone = rows.length - nConf - nSug;
    var summary = rows.length
      ? nConf + ' confirmed, ' + nSug + ' suggested, ' + nNone + ' not mapped, of ' + rows.length + (rows.length === 1 ? ' space' : ' spaces') + ' in the upcoming events.'
      : 'No upcoming events with a space yet. Sync the calendar feed first.';
    var body = rows.map(function (r, i) {
      var prog = r.offsite ? 'Off-site (no BAS action)' : programsText(r.programs);
      var label = r.state === 'confirmed' ? 'Confirmed' : r.state === 'suggested' ? 'Suggested' : 'Not mapped';
      var b = function (txt, act, cls) {
        return '<button class="btn ' + (cls || 'btn-ghost') + ' btn-sm" onclick="spmAct(' + pid + ",'" + act + "'," + i + ')">' + txt + '</button> ';
      };
      var acts =
        r.state === 'confirmed'
          ? b('Change', 'edit') + b('Clear', 'clear')
          : (r.state === 'suggested' ? b('Confirm', 'confirm', 'btn-em') : '') + b(r.state === 'suggested' ? 'Change' : 'Choose', 'edit') + b('Off-site', 'off');
      return [esc(r.space), String(r.count), esc(prog), esc(label), acts];
    });
    var tbl = rows.length
      ? window.pcalUi.table(
          [
            ['Calendar space', '22%'],
            ['Upcoming events', '10%'],
            ['BAS program(s)', '36%'],
            ['Status', '12%'],
            ['', '20%'],
          ],
          body,
        )
      : '';
    host.innerHTML =
      '<div class="card pcal" style="margin-bottom:16px"><div class="card-hdr" style="justify-content:space-between"><span class="card-title">Space map</span>' +
      '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'spm-file-' + pid + '\').click()">Import suggestions</button></div>' +
      '<div style="padding:16px">' +
      '<input style="display:none" type="file" id="spm-file-' + pid + '" accept=".csv,text/csv" onchange="spmPick(' + pid + ',this)">' +
      '<div style="font-size:12px">Says which BAS program heats and cools each calendar space. The BAS column of the events list checks only confirmed spaces. Serving units (air handlers that serve boxes, hot and chilled water plants) run on requests and are never checked.</div>' +
      '<div class="pcal-sum">' + esc(summary) + '</div>' +
      (hasBas ? '' : '<div class="pcal-msg">No BAS schedules are saved yet. Import them in the BAS schedules card to choose programs.</div>') +
      '<div class="pcal-msg" id="spm-msg-' + pid + '" role="status">' + esc(s.msg) + '</div>' +
      tbl +
      pickerHtml(pid) +
      '</div></div>';
    if (s.edit >= 0) fillList(pid);
  }

  function pickerHtml(pid) {
    var s = state(pid);
    if (s.edit < 0 || !s.rows[s.edit]) return '';
    var r = s.rows[s.edit];
    return (
      '<h4>Choose the BAS program(s) for ' + esc(r.space) + '</h4>' +
      '<div class="pcal-row" style="margin-top:8px"><input class="fi" id="spm-q-' + pid + '" placeholder="Search programs, for example gym or room 114" value="' + esc(s.q) + '" oninput="spmSearch(' + pid + ',this.value)" autocomplete="off"></div>' +
      '<div id="spm-list-' + pid + '"></div>' +
      '<div class="pcal-nav"><button class="btn btn-em btn-sm" onclick="spmSave(' + pid + ')">Save and confirm</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="spmAct(' + pid + ",'cancel',0)\">Cancel</button></div>"
    );
  }
  // The program list under the search box. Chosen programs first, then matches of the search, at most LIST_MAX.
  function fillList(pid) {
    var el = document.getElementById('spm-list-' + pid);
    if (!el) return;
    var s = state(pid);
    var q = s.q.trim().toLowerCase();
    var chosen = Object.keys(s.sel);
    var hits = programKeys(pid).filter(function (k) {
      return !s.sel[k] && (!q || k.toLowerCase().indexOf(q) !== -1);
    });
    s.matches = chosen.concat(hits.slice(0, LIST_MAX));
    var rows = s.matches.map(function (k, i) {
      return [
        '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox"' + (s.sel[k] ? ' checked' : '') + ' onchange="spmToggle(' + pid + ',' + i + ')">' + esc(BasDiff.splitKey(k).program) + '</label>',
        esc(BasDiff.buildingOf(BasDiff.splitKey(k).location)),
        esc(BasDiff.splitKey(k).location.split('/').slice(2).join(' / ')),
      ];
    });
    el.innerHTML =
      (rows.length
        ? window.pcalUi.table([['Program', '40%'], ['Building', '30%'], ['Area', '30%']], rows)
        : '<div style="font-size:12px;margin-top:8px">No programs match.</div>') +
      (hits.length > LIST_MAX ? '<div style="font-size:12px;margin-top:8px">Showing the first ' + LIST_MAX + ' matches. Type more of the name to narrow the list.</div>' : '');
  }

  async function writeEntry(pid, r, patch) {
    var map = mapOf(pid);
    map.spaces[r.key] = Object.assign({ space: r.space, programs: [], offsite: false, confirmed: true, by: whoName(), at: new Date().toISOString() }, patch);
    await DB.set('en_space_map_' + pid, map);
  }
  // The events list shows the BAS column, so it redraws too (the calendar panel redraws this card as well).
  function refresh(pid) {
    if (typeof pcalRender === 'function') pcalRender(pid);
    else render(pid);
  }

  window.spaceMapRender = render;
  window.spmAct = async function (pid, act, i) {
    var s = state(pid);
    var r = s.rows[i];
    s.msg = '';
    if (act === 'cancel') {
      s.edit = -1;
      return render(pid);
    }
    if (!r) return;
    if (act === 'confirm') {
      if (!r.programs.length) return;
      await writeEntry(pid, r, { programs: r.programs });
    } else if (act === 'off') await writeEntry(pid, r, { offsite: true });
    else if (act === 'clear') {
      var map = mapOf(pid);
      delete map.spaces[r.key];
      await DB.set('en_space_map_' + pid, map);
    } else if (act === 'edit') {
      s.edit = i;
      s.q = '';
      s.sel = {};
      r.programs.forEach(function (k) {
        s.sel[k] = true;
      });
      return render(pid);
    }
    s.edit = -1;
    refresh(pid);
  };
  window.spmSearch = function (pid, v) {
    state(pid).q = v;
    fillList(pid);
  };
  window.spmToggle = function (pid, i) {
    var s = state(pid);
    var k = s.matches[i];
    if (!k) return;
    if (s.sel[k]) delete s.sel[k];
    else s.sel[k] = true;
    fillList(pid);
  };
  window.spmSave = async function (pid) {
    var s = state(pid);
    var r = s.rows[s.edit];
    if (!r) return;
    var keys = Object.keys(s.sel);
    if (!keys.length) {
      s.msg = 'Choose at least one program, or choose Off-site.';
      var el = document.getElementById('spm-msg-' + pid);
      if (el) el.textContent = s.msg;
      return;
    }
    await writeEntry(pid, r, { programs: keys });
    s.edit = -1;
    refresh(pid);
  };
  // Suggestions file (columns calendar_space, bas_location, bas_program, confirmed). A space the user already confirmed is kept.
  window.spmPick = function (pid, input) {
    var f = input.files && input.files[0];
    if (!f) return;
    f.text().then(async function (text) {
      input.value = '';
      var s = state(pid);
      var keys = programKeys(pid);
      if (!keys.length) {
        s.msg = 'Import the BAS schedules first, then import the suggestions.';
        return render(pid);
      }
      var res = BasCoverage.entriesFromCsv(emParseCSVText(text), keys, whoName(), new Date().toISOString());
      if (res.error) {
        s.msg = res.error;
        return render(pid);
      }
      var map = mapOf(pid);
      var added = 0;
      var kept = 0;
      Object.keys(res.entries).forEach(function (k) {
        if (map.spaces[k] && map.spaces[k].confirmed) kept++;
        else {
          map.spaces[k] = res.entries[k];
          added++;
        }
      });
      await DB.set('en_space_map_' + pid, map);
      s.msg = added + (added === 1 ? ' space' : ' spaces') + ' read from the file' + (kept ? '; ' + kept + ' you already confirmed were kept' : '') + '.';
      refresh(pid);
    });
  };
})();
