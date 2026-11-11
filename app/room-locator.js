// app/room-locator.js
//
// "Where is it?" on the Equipment Matrix tab: type a room, equipment or space name and see which building and
// which Area of the WebCTRL tree it is in. Reads saved data only (DB.get); it writes nothing and has no network call.
//
// Data (read through DB.get):
//   en_eqmatrix_<pid>  { rows:[{ equipName, building, category, bacnetLocation }] }  bacnetLocation = WebCTRL path of the program
//   en_space_map_<pid> { spaces:{ "<normalized name>": { space, programs:["location|program"] } } }  adds calendar space names
// The path rules (building, area, key split) are BasDiff.buildingOf / areaOf / splitKey (app/bas-diff.js). Not copied here.
// Works as a browser script and as a CommonJS module (search() is pure and is tested by tools/test-room-locator.js).
(function (root) {
  'use strict';

  var isNode = typeof require === 'function' && typeof module !== 'undefined' && module.exports;
  var BasDiff = isNode ? require('./bas-diff.js') : root.BasDiff;
  var AirSource = isNode ? require('./air-source.js') : root.AirSource;
  var RESULT_MAX = 100;
  var NO_AREA = 'Building level';

  function words(q) {
    return String(q || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }
  // Words that name the same kind of space. A search word in a group also finds the other words of its group.
  var SAME_SPACE = [['library', 'media']];
  function alternatives(w) {
    for (var i = 0; i < SAME_SPACE.length; i++) {
      if (SAME_SPACE[i].some(function (x) { return w.indexOf(x) === 0; })) return SAME_SPACE[i].concat([w]);
    }
    return [w];
  }
  // Every word of the search must appear somewhere in the text (a word may be part of "F114" or "Math 114").
  function matches(text, ws) {
    var t = String(text || '').toLowerCase();
    return ws.length > 0 && ws.every(function (w) {
      return alternatives(w).some(function (a) { return t.indexOf(a) !== -1; });
    });
  }
  function item(building, path, name, category, space, air) {
    var a = AirSource.text(air);
    return {
      building: building,
      area: path ? BasDiff.areaOf(path) || NO_AREA : 'Not in the Building Automation System tree',
      path: path ? String(path).split('/').map(function (x) { return x.trim(); }).filter(Boolean).join(' / ') : '',
      name: name,
      space: space || '',
      airHandler: AirSource.isAirHandler(category, name),
      airText: a.text,
      airHint: a.hint,
    };
  }

  // rows: Equipment Matrix rows. spaceMap: the en_space_map value or null. query: the typed text.
  // airCtx: { snaps, audit, links } for AirSource.analyze (optional; without it the "Air source" column stays empty).
  // -> { groups:[{ building, items:[...] }], total, shown, hasAirHandler }
  function search(rows, spaceMap, query, airCtx) {
    var ws = words(query);
    var air = airCtx ? AirSource.analyze(rows, airCtx).byKey : {};
    var out = [];
    var seen = {};
    function add(it) {
      var k = (it.building + '|' + it.path + '|' + it.name).toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(it);
    }
    if (ws.length) {
      (rows || []).forEach(function (r) {
        var path = r.bacnetLocation || '';
        var building = path ? BasDiff.buildingOf(path) : r.building || 'Unknown building';
        var it = item(building, path, r.equipName || '', r.category, '', air[AirSource.snapKey(r)]);
        if (matches(it.name + ' ' + it.building + ' ' + (path ? it.area : ''), ws)) add(it);
      });
      var spaces = (spaceMap && spaceMap.spaces) || {};
      Object.keys(spaces).forEach(function (k) {
        var sp = spaces[k];
        if (!sp || !matches(sp.space || k, ws)) return;
        (sp.programs || []).forEach(function (key) {
          var p = BasDiff.splitKey(key);
          add(item(BasDiff.buildingOf(p.location), p.location, p.program, '', sp.space || k, air[key]));
        });
      });
    }
    out.sort(function (a, b) {
      return a.building.localeCompare(b.building) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name);
    });
    var shownItems = out.slice(0, RESULT_MAX);
    var groups = [];
    shownItems.forEach(function (it) {
      var g = groups.length && groups[groups.length - 1].building === it.building ? groups[groups.length - 1] : null;
      if (!g) groups.push((g = { building: it.building, items: [] }));
      g.items.push(it);
    });
    return {
      groups: groups,
      total: out.length,
      shown: shownItems.length,
      hasAirHandler: shownItems.some(function (it) {
        return it.airHandler;
      }),
    };
  }

  var api = { RESULT_MAX: RESULT_MAX, NO_AREA: NO_AREA, search: search };

  // --- page part (browser only) ----------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function resultsHtml(res, query) {
    if (!res.total) return '<div style="padding:16px 20px;font-size:12px;color:var(--text)">Nothing in the Building Automation System data matches "' + esc(query.trim()) + '".</div>';
    var T = root.pcalUi;
    var html = '<div style="padding:8px 20px 16px">';
    res.groups.forEach(function (g) {
      html +=
        '<div style="margin-top:10px;font-size:12px;font-weight:700;color:var(--text)">' + esc(g.building) + ' (' + g.items.length + ')</div>' +
        T.table(
          [['Building', '14%'], ['Area', '15%'], ['WebCTRL tree path', '27%'], ['Equipment or program', '22%'], ['Air source', '22%']],
          g.items.map(function (it) {
            return [esc(it.building), esc(it.area), esc(it.path), esc(it.name) + (it.space ? ' (calendar space: ' + esc(it.space) + ')' : ''), it.airText ? '<span title="' + esc(it.airHint) + '">' + esc(it.airText) + '</span>' : ''];
          }),
        );
    });
    if (res.total > res.shown) html += '<div style="margin-top:8px;font-size:12px;color:var(--text)">Showing the first ' + res.shown + ' of ' + res.total + ' matches. Type more of the name to narrow the list.</div>';
    if (res.hasAirHandler) html += '<div style="margin-top:8px;font-size:12px;color:var(--text)">Air source links come from the unit number in the program name or the Area in the air handler name. Hover a link to see which.</div>';
    return html + '</div>';
  }
  // Called by the search box (oninput). Shows the results in place of the equipment table while there is text.
  function onInput(value) {
    var pid = root._emActivePid;
    var box = document.getElementById('rl-results');
    var table = document.getElementById('em-table-wrap');
    if (!box || !table) return;
    if (!String(value || '').trim()) {
      box.style.display = 'none';
      box.innerHTML = '';
      table.style.display = '';
      return;
    }
    var m = root.DB.get('en_eqmatrix_' + pid, { rows: [] });
    var res = search((m && m.rows) || [], root.DB.get('en_space_map_' + pid, null), value, {
      snaps: root.DB.get('en_bas_snap_' + pid, {}),
      audit: root.DB.get('en_bas_auditevents_' + pid, null),
      links: root.DB.get('en_bas_airsource_' + pid, null),
    });
    root.pcalUi.ensureStyle();
    box.innerHTML = resultsHtml(res, String(value));
    box.style.display = '';
    table.style.display = 'none';
  }
  // The search box and the (empty) results area for the top of the Equipment Matrix tab.
  function boxHtml() {
    return (
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 20px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">' +
      '<label for="rl-search" style="font-size:12px;font-weight:700;color:var(--text)">Where is it?</label>' +
      '<input id="rl-search" type="text" autocomplete="off" placeholder="Room or equipment name, for example gym, library or 114" oninput="roomLocatorInput(this.value)" ' +
      'style="font-size:12px;padding:4px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:28px;flex:1;min-width:240px;max-width:520px">' +
      '</div>'
    );
  }
  function areaHtml() {
    return '<div id="rl-results" class="em-table-wrap" style="display:none;flex:1;min-height:0"></div>';
  }
  api.boxHtml = boxHtml;
  api.areaHtml = areaHtml;
  api.onInput = onInput;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.RoomLocator = api;
    root.roomLocatorInput = onInput;
  }
})(typeof window !== 'undefined' ? window : this);
