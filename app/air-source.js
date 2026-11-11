// app/air-source.js
//
// Source units and terminal units. A "source" unit is an air handler or rooftop unit that feeds terminal units (variable
// air volume boxes, fan powered boxes). It has no schedule and no set points of its own. A "terminal" unit reads its air
// from a source through the points "Air Source ..." / "Primary Air Source ...". The BAS data does not name the source of a
// terminal, so the link comes from (1) a stored, confirmed override or (2) the number rule below. Nothing else is guessed.
// Reads saved data only (the caller passes it in); it writes nothing. Browser script and CommonJS module (pure functions,
// tested by tools/test-air-source.js).
//
// Data the caller reads with DB.get:
//   en_eqmatrix_<pid>        { rows:[{ id, equipName, building, category, bacnetLocation, pointsRaw|points, pointPaths }] }
//   en_bas_snap_<pid>        { "YYYY-MM-DD": { rows:{ "location|program": [...] } } }   the newest date is used
//   en_bas_auditevents_<pid> { locs:[location,...] }   a location is in the list only when it has schedule or set point events
//   en_bas_airsource_<pid>   { links:{ "<row id or location|program>": { source:"<unit name>", basis:"confirmed" } } }  read only here
// Key rules: snapshot key = bacnetLocation + '|' + equipName. Audit location = bacnetLocation + '/' + equipName.
// Building = BasDiff.buildingOf, date check = BasDiff.isDate (app/bas-diff.js). Not copied here.
(function (root) {
  'use strict';

  var BasDiff = typeof require === 'function' && typeof module !== 'undefined' && module.exports ? require('./bas-diff.js') : root.BasDiff;

  function isAirHandler(category, name) {
    return category === 'ahu' || category === 'rtu' || /\b(ahu|rtu)\b/i.test(String(name || ''));
  }
  function pointNames(row) {
    var p = row && (row.pointsRaw && typeof row.pointsRaw === 'object' ? row.pointsRaw : row.points);
    return p && typeof p === 'object' ? Object.keys(p) : [];
  }
  function hasAirSourcePoints(row) {
    return pointNames(row).some(function (n) {
      return /^(primary )?air source\b/i.test(n);
    });
  }
  function snapKey(row) {
    return (row.bacnetLocation || '') + '|' + (row.equipName || '');
  }
  function auditLoc(row) {
    return (row.bacnetLocation || '') + '/' + (row.equipName || '');
  }
  // The schedule keys of the newest saved day: a set of "location|program".
  function scheduledKeysOf(snaps) {
    var days = Object.keys(snaps || {})
      .filter(BasDiff.isDate)
      .sort();
    var set = {};
    if (!days.length) return set;
    var rows = (snaps[days[days.length - 1]] || {}).rows || {};
    Object.keys(rows).forEach(function (k) {
      set[k] = true;
    });
    return set;
  }
  // The locations with schedule or set point events: a set of "location/program".
  function auditLocsOf(store) {
    var set = {};
    ((store && store.locs) || []).forEach(function (l) {
      set[l] = true;
    });
    return set;
  }

  // -> 'direct'   air handler with a schedule row or events: it serves its space itself
  //    'source'   air handler with neither, and with air source points: it feeds terminal units
  //    'terminal' not an air handler, with air source points
  //    'unknown'  air handler with neither and no air source points, or no schedule data saved at all
  //    'none'     anything else (no air source relation)
  function classify(row, scheduledKeys, auditLocs) {
    var sk = scheduledKeys || {};
    var al = auditLocs || {};
    if (!isAirHandler(row.category, row.equipName)) return hasAirSourcePoints(row) ? 'terminal' : 'none';
    if (sk[snapKey(row)] || al[auditLoc(row)]) return 'direct';
    if (!Object.keys(sk).length && !Object.keys(al).length) return 'unknown';
    return hasAirSourcePoints(row) ? 'source' : 'unknown';
  }

  // The unit number in a program code "#vav-02-03_bes" -> 2. null when the code has no <type>-NN-MM form.
  function groupNumber(row) {
    var paths = row.pointPaths;
    var first = Array.isArray(paths) && paths.length ? String(paths[0]) : '';
    var m = first.match(/^#?[a-z]+-(\d+)-\d+(?:_|\/|$)/i);
    return m ? parseInt(m[1], 10) : null;
  }
  function unitNumber(name) {
    var m = String(name || '').match(/\b(?:ahu|rtu)-0*(\d+)(?!\d)/i);
    return m ? parseInt(m[1], 10) : null;
  }
  // The Area letters an air handler name lists: "AHU-7 Area A" -> ['A'], "AHU-5 Areas B, C, D, E, F" -> ['B','C','D','E','F'].
  function namedAreas(name) {
    var m = String(name || '').match(/\bareas?\s+([a-z](?:\s*(?:,|&|and)\s*[a-z])*)\s*$/i);
    return m ? m[1].toUpperCase().match(/[A-Z]/g) : [];
  }
  // The Area letter of a tree path: ".../AREA 'F' SUMMARY" or ".../Area A" -> 'F' / 'A'. '' when none.
  function areaLetter(location) {
    var m = BasDiff.areaOf(location).match(/\barea\s*'?([a-z])'?(?:\s|$)/i);
    return m ? m[1].toUpperCase() : '';
  }
  // The space words of an air handler named for a space: "AHU-8 Media Center" -> ['media', 'center']. [] when the
  // name lists Areas or has no space words. Direction words (lower, north ...) do not name a space by themselves.
  var NOT_SPACE = { lower: 1, upper: 1, north: 1, south: 1, east: 1, west: 1, main: 1, room: 1, area: 1, areas: 1 };
  function spaceWords(name) {
    if (namedAreas(name).length) return [];
    return String(name || '')
      .toLowerCase()
      .replace(/\b(?:ahu|rtu)-\w+/g, ' ')
      .split(/[^a-z]+/)
      .filter(function (w) {
        return w.length >= 3 && !NOT_SPACE[w];
      });
  }
  // A room number in a unit name: "Room A111 Center W" -> 'A111', "Media Center 101 v206" -> '101'. '' when none.
  function roomNumber(name) {
    var m = String(name || '').match(/\b([a-z]?\d{3})\b/i);
    return m ? m[1].toUpperCase() : '';
  }
  function buildingOfRow(row) {
    return BasDiff.buildingOf(row.bacnetLocation || row.building || '');
  }

  // rows: Equipment Matrix rows. ctx: { snaps, audit, links } as read from DB (each may be null).
  // -> { byKey:{ "location|program": { kind, source, feeds, basis } }, counts:{ source, terminal, direct, linked, notLinked } }
  //   kind: classify() result. For a terminal: source = the unit name or '', basis = 'confirmed' | 'number' | ''.
  //   For a source: feeds = number of terminal units linked to it.
  function analyze(rows, ctx) {
    ctx = ctx || {};
    var sk = scheduledKeysOf(ctx.snaps);
    var al = auditLocsOf(ctx.audit);
    var links = (ctx.links && ctx.links.links) || {};
    var info = {};
    var sources = [];
    var counts = { source: 0, terminal: 0, direct: 0, linked: 0, notLinked: 0 };
    (rows || []).forEach(function (r) {
      var k = classify(r, sk, al);
      info[snapKey(r)] = { kind: k, source: '', feeds: 0, basis: '' };
      if (k === 'source') {
        sources.push(r);
        counts.source++;
      } else if (k === 'direct') counts.direct++;
    });
    // A source named for a space ("AHU-8 Media Center") feeds the terminals in its building whose name holds one of its
    // space words, and the terminals that share a room number with those.
    var allNamed = {};
    sources.forEach(function (s) {
      var b = buildingOfRow(s);
      var ok = namedAreas(s.equipName).length > 0 || spaceWords(s.equipName).length > 0;
      allNamed[b] = (allNamed[b] === undefined ? true : allNamed[b]) && ok;
    });
    var bySpace = {};
    sources.forEach(function (s) {
      var ws = spaceWords(s.equipName);
      if (!ws.length) return;
      var b = buildingOfRow(s);
      var hit = (rows || []).filter(function (r) {
        var n = String(r.equipName || '').toLowerCase();
        return info[snapKey(r)].kind === 'terminal' && buildingOfRow(r) === b && ws.some(function (w) { return n.indexOf(w) !== -1; });
      });
      var rooms = {};
      hit.forEach(function (r) {
        var rn = roomNumber(r.equipName);
        if (rn) rooms[rn] = true;
      });
      (rows || []).forEach(function (r) {
        if (info[snapKey(r)].kind !== 'terminal' || buildingOfRow(r) !== b) return;
        if (hit.indexOf(r) !== -1 || rooms[roomNumber(r.equipName)]) (bySpace[snapKey(r)] = bySpace[snapKey(r)] || []).push(s);
      });
    });
    (rows || []).forEach(function (r) {
      var key = snapKey(r);
      if (info[key].kind !== 'terminal') return;
      counts.terminal++;
      var building = buildingOfRow(r);
      var link = links[r.id] || links[key];
      var src = null;
      var basis = '';
      if (link && link.source) {
        // A stored link wins over the number rule. It names the unit.
        src = { equipName: link.source };
        sources.forEach(function (s) {
          if (buildingOfRow(s) === building && s.equipName === link.source) src = s;
        });
        basis = link.basis || 'confirmed';
      } else {
        var n = groupNumber(r);
        if (n !== null) {
          var same = sources.filter(function (s) {
            return buildingOfRow(s) === building && unitNumber(s.equipName) === n;
          });
          if (same.length === 1) {
            src = same[0];
            basis = 'number';
          }
        }
      }
      if (!src && bySpace[key] && bySpace[key].length === 1) {
        src = bySpace[key][0];
        basis = 'space';
      }
      if (!src) {
        // The Area named in the air handler name ("AHU-7 Area A") feeds the terminals in that tree Area.
        // Only where every source of the building names its Areas or its space: an unnamed source may share the Area.
        var letter = allNamed[building] ? areaLetter(r.bacnetLocation) : '';
        var named = letter
          ? sources.filter(function (s) {
              return buildingOfRow(s) === building && namedAreas(s.equipName).indexOf(letter) !== -1;
            })
          : [];
        if (named.length === 1) {
          src = named[0];
          basis = 'name';
        } else if (named.length > 1) {
          info[key].source = named
            .map(function (s) {
              return s.equipName;
            })
            .join(' or ');
          info[key].basis = 'name-shared';
          counts.linked++;
          return;
        }
      }
      if (!src) {
        counts.notLinked++;
        return;
      }
      info[key].source = src.equipName;
      info[key].basis = basis;
      counts.linked++;
      if (src.bacnetLocation !== undefined) info[snapKey(src)].feeds++;
    });
    return { byKey: info, counts: counts };
  }

  // The words shown in the "Where is it?" table. Empty text for a unit with no air source relation.
  var BASIS_HINT = {
    confirmed: 'Confirmed link',
    number: 'Matched by the unit number in the program name',
    name: 'Matched by the Area in the air handler name',
    space: 'Matched by the space in the air handler name, or the same room number',
    'name-shared': 'More than one air handler name lists this Area',
  };
  var NOT_KNOWN_HINT = 'The BAS data does not name its air handler';
  function text(inf) {
    if (!inf) return { text: '', hint: '' };
    if (inf.kind === 'direct') return { text: 'Serves its space directly', hint: '' };
    if (inf.kind === 'source') {
      if (inf.feeds > 0) return { text: 'Feeds ' + inf.feeds + (inf.feeds === 1 ? ' terminal unit' : ' terminal units'), hint: '' };
      return { text: 'Feeds terminal units (list not known)', hint: '' };
    }
    if (inf.kind === 'terminal') {
      if (inf.source) return { text: 'Fed by ' + inf.source, hint: BASIS_HINT[inf.basis] || '' };
      return { text: 'Not known', hint: NOT_KNOWN_HINT };
    }
    return { text: '', hint: '' };
  }

  var api = {
    isAirHandler: isAirHandler,
    hasAirSourcePoints: hasAirSourcePoints,
    snapKey: snapKey,
    scheduledKeysOf: scheduledKeysOf,
    auditLocsOf: auditLocsOf,
    classify: classify,
    groupNumber: groupNumber,
    namedAreas: namedAreas,
    areaLetter: areaLetter,
    spaceWords: spaceWords,
    roomNumber: roomNumber,
    analyze: analyze,
    sourceOf: function (terminal, rows, ctx) {
      var i = analyze(rows, ctx).byKey[snapKey(terminal)];
      return i ? i.source : '';
    },
    text: text,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AirSource = api;
})(typeof window !== 'undefined' ? window : this);
