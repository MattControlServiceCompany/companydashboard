/* ── EQUIPMENT MATRIX — Phase 1-3 ── */

/* ── CONSTANTS ── */
var EM_EQUIP_TYPES = {
  'multizone vav ahu': 'ahu',
  'multizone ahu': 'ahu',
  'vav ahu': 'ahu',
  ahu: 'ahu',
  'air handling unit': 'ahu',
  'vav terminal w/ reheat': 'vav',
  'vav terminal with reheat': 'vav',
  'vav reheat': 'vav',
  'vav box': 'vav',
  'vav terminal': 'vav',
  'parallel fan terminal': 'fpb',
  'fan powered terminal': 'fpb',
  'fan-powered terminal': 'fpb',
  fpt: 'fpb',
  fpb: 'fpb',
  'dual duct vav terminal': 'ddvav',
  'dual duct terminal': 'ddvav',
  'ddvav terminal': 'ddvav',
  'hot water plant': 'hwp',
  'hot water plant (boilers)': 'hwp',
  'boiler plant': 'hwp',
  hwp: 'hwp',
  'chilled water plant': 'chwp',
  'chilled water plant (chillers)': 'chwp',
  'chiller plant': 'chwp',
  chwp: 'chwp',
  'cooling tower': 'ct',
  ct: 'ct',
  'weather station (no hvac)': 'other',
  'weather station': 'other',
  'no gl36 equipment': 'other',
  'no bas equipment': 'other',
};

/* ── EDIT MODE FLAG ── */
var _emEditMode = false;

function emToggleEditMode(btn) {
  _emEditMode = !_emEditMode;
  if (btn) {
    btn.textContent = _emEditMode ? '🔒 Lock' : '✏️ Edit';
    btn.style.background = _emEditMode ? 'var(--accent)' : '';
    btn.style.color = _emEditMode ? '#fff' : '';
  }
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

var EM_CHECK_COLS_11 = [
  'Duct Static Pressure Sensor',
  'Supply Air Temp Sensor',
  'Return Air Temp Sensor',
  'Outdoor Air Temp Sensor',
  'VFD Present',
  'SAT Reset Sequence',
  'DSP Reset Sequence',
  'HW Temp Reset',
  'CHW Temp Reset',
  'Optimum Start/Stop',
  'Lead/Lag Pump',
];

var EM_CHECK_COLS_14 = [
  'Duct Static Pressure Sensor',
  'Supply Air Temp Sensor',
  'Return Air Temp Sensor',
  'Outdoor Air Temp Sensor',
  'VFD Present',
  'SAT Reset Sequence',
  'DSP Reset Sequence',
  'HW Temp Reset',
  'CHW Temp Reset',
  'Optimum Start/Stop',
  'Lead/Lag Pump',
  'CO2 Sensor',
  'Economizer Control',
  'Airflow Measurement',
];

var EM_POINT_MAP = [
  {
    col: 'satLive',
    label: 'Supply Air Temp',
    patterns: [/supply air temp/i, /sat\b/i],
    types: ['AI', 'SP'],
    cats: ['ahu', 'vav', 'fpb'],
  },
  { col: 'ratLive', label: 'Return Air Temp', patterns: [/return air temp/i, /rat\b/i], types: ['AI'], cats: ['ahu'] },
  { col: 'matLive', label: 'Mixed Air Temp', patterns: [/mixed air temp/i, /mat\b/i], types: ['AI'], cats: ['ahu'] },
  {
    col: 'oatLive',
    label: 'OAT (Live)',
    patterns: [/outdoor air temp/i, /\boat\b/i, /oat \(live\)/i],
    types: ['AI'],
    cats: ['ahu', 'hwp', 'chwp'],
  },
  {
    col: 'sfSpeedLive',
    label: 'Supply Fan Speed',
    patterns: [/supply fan speed/i, /fan speed/i, /sf speed/i],
    types: ['AI', 'AO'],
    cats: ['ahu'],
  },
  {
    col: 'dspLive',
    label: 'Duct Static Pressure',
    patterns: [/duct static pressure/i, /\bdsp\b/i],
    types: ['AI'],
    cats: ['ahu'],
  },
  {
    col: 'oaDampLive',
    label: 'OA Damper Position',
    patterns: [/oa damper/i, /outdoor air damper/i],
    types: ['AO', 'AI'],
    cats: ['ahu'],
  },
  {
    col: 'clgValveLive',
    label: 'Cooling Valve Position',
    patterns: [/cooling valve/i, /chw valve/i, /clg valve/i],
    types: ['AO', 'AI'],
    cats: ['ahu', 'fpb'],
  },
  {
    col: 'htgValveLive',
    label: 'Heating Valve Position',
    patterns: [/heating valve/i, /hw valve/i, /htg valve/i, /reheat valve/i],
    types: ['AO', 'AI'],
    cats: ['ahu', 'vav', 'fpb'],
  },
  {
    col: 'oaFlowLive',
    label: 'OA Airflow (cfm)',
    patterns: [/oa airflow/i, /outdoor air flow/i, /oa cfm/i],
    types: ['AI'],
    cats: ['ahu'],
  },
  {
    col: 'zoneAirTempLive',
    label: 'Zone Air Temp',
    patterns: [/zone air temp/i, /room temp/i, /space temp/i, /zone temp/i],
    types: ['AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'zoneCoolSpLive',
    label: 'Zone Cooling Setpoint',
    patterns: [/zone cooling setpoint/i, /cooling setpoint/i, /clg setpoint/i],
    types: ['SP'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'zoneHtgSpLive',
    label: 'Zone Heating Setpoint',
    patterns: [/zone heating setpoint/i, /heating setpoint/i, /htg setpoint/i],
    types: ['SP'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'datLive',
    label: 'Discharge Air Temp',
    patterns: [/discharge air temp/i, /\bdat\b/i],
    types: ['AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'reheatValveLive',
    label: 'Reheat Valve',
    patterns: [/reheat valve/i],
    types: ['AO', 'AI'],
    cats: ['vav', 'fpb'],
  },
  {
    col: 'dampPosLive',
    label: 'Damper Position',
    patterns: [/damper position/i, /dmp pos/i],
    types: ['AO', 'AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'discFlowLive',
    label: 'Discharge Airflow',
    patterns: [/discharge airflow/i, /disc airflow/i, /zone airflow/i],
    types: ['AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'hwSupTempLive',
    label: 'HW Supply Temp',
    patterns: [/hw supply temp/i, /hot water supply/i, /hwst\b/i],
    types: ['AI'],
    cats: ['hwp'],
  },
  {
    col: 'hwRetTempLive',
    label: 'HW Return Temp',
    patterns: [/hw return temp/i, /hot water return/i, /hwrt\b/i],
    types: ['AI'],
    cats: ['hwp'],
  },
  {
    col: 'hwDiffPresLive',
    label: 'HW Diff Pressure',
    patterns: [/hw diff pressure/i, /hw differential/i],
    types: ['AI'],
    cats: ['hwp'],
  },
  {
    col: 'hwSupSpLive',
    label: 'HW Supply Setpoint',
    patterns: [/hw supply setpoint/i, /hw setpoint/i],
    types: ['SP'],
    cats: ['hwp'],
  },
  {
    col: 'chwSupTempLive',
    label: 'CHW Supply Temp',
    patterns: [/chw supply temp/i, /chilled water supply/i, /chwst\b/i],
    types: ['AI'],
    cats: ['chwp'],
  },
  {
    col: 'chwRetTempLive',
    label: 'CHW Return Temp',
    patterns: [/chw return temp/i, /chilled water return/i, /chwrt\b/i],
    types: ['AI'],
    cats: ['chwp'],
  },
  {
    col: 'chwSupSpLive',
    label: 'CHW Supply Setpoint',
    patterns: [/chw supply setpoint/i, /chw setpoint/i],
    types: ['SP'],
    cats: ['chwp'],
  },
  {
    col: 'chwDiffPresLive',
    label: 'CHW Diff Pressure',
    patterns: [/chw diff pressure/i, /chw differential/i],
    types: ['AI'],
    cats: ['chwp'],
  },
  {
    col: 'chwFlowLive',
    label: 'CHW Flow',
    patterns: [/chw flow/i, /chilled water flow/i],
    types: ['AI'],
    cats: ['chwp'],
  },
  {
    col: 'cwSupTempLive',
    label: 'CW Supply Temp',
    patterns: [/cw supply temp/i, /condenser water supply/i, /cwst\b/i],
    types: ['AI'],
    cats: ['ct'],
  },
  {
    col: 'cwRetTempLive',
    label: 'CW Return Temp',
    patterns: [/cw return temp/i, /condenser water return/i, /cwrt\b/i],
    types: ['AI'],
    cats: ['ct'],
  },
  { col: 'oaWetBulbLive', label: 'OA Wet Bulb', patterns: [/wet bulb/i, /wb\b/i], types: ['AI'], cats: ['ct'] },
  {
    col: 'ctFanSpeedLive',
    label: 'CT Fan Speed',
    patterns: [/ct fan speed/i, /cooling tower fan/i, /tower fan/i],
    types: ['AI', 'AO'],
    cats: ['ct'],
  },
];

/* ── PHASE 1: PARSER ── */

function emParseCSVText(text) {
  text = text.replace(/^﻿/, '');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var rows = [];
  var i = 0;
  var len = text.length;
  while (i <= len) {
    var row = [];
    while (i <= len) {
      if (i === len || text[i] === '\n') {
        row.push('');
        i++;
        break;
      }
      if (text[i] === '"') {
        i++;
        var cell = '';
        while (i < len) {
          if (text[i] === '"' && text[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else if (text[i] === '"') {
            i++;
            break;
          } else {
            cell += text[i++];
          }
        }
        row.push(cell);
        if (i < len && text[i] === ',') i++;
        else if (i <= len && (text[i] === '\n' || i === len)) {
          i++;
          break;
        }
      } else {
        var start = i;
        while (i < len && text[i] !== ',' && text[i] !== '\n') i++;
        row.push(text.slice(start, i));
        if (i < len && text[i] === ',') i++;
        else if (i <= len && (text[i] === '\n' || i === len)) {
          i++;
          break;
        }
      }
    }
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
  }
  return rows;
}

function emDetectColMap(headerRow) {
  var h0 = (headerRow[0] || '').trim().toLowerCase();
  var h1 = (headerRow[1] || '').trim().toLowerCase();

  // WebCTRL 14-column point-list export
  if (h0 === 'location' && h1 === 'control program') {
    return {
      format: 'webctrl',
      building: 0, // BACnet path — parsed for building name
      location: 1, // Control Program — part before " - "
      equipName: 1, // Control Program — part after " - "
      equipType: 1, // inferred from equipment name portion
      pointName: 2, // BACnet point Name
      pointValue: 3, // Live value
      checkStart: -1,
      checkCount: 0,
      pointStart: -1,
    };
  }

  // Enriched 45-column matrix (original format)
  var n = headerRow.length;
  var checkCount = 11;
  if (n >= 4 + 14) checkCount = 14;
  return {
    format: 'enriched',
    building: 0,
    location: 1,
    equipName: 2,
    equipType: 3,
    checkStart: 4,
    checkCount: checkCount,
    pointStart: 4 + checkCount,
  };
}

// Parse a BACnet path from WebCTRL (e.g. "/Johnson County/Courthouse/Fire/...")
// Returns the second path segment as the building name (first is the org/county level).
function emParseBACnetBuilding(pathStr) {
  if (!pathStr) return '';
  var parts = pathStr.replace(/^\//, '').split('/');
  // Return index 1 (building) if it exists, else index 0
  return (parts[1] || parts[0] || '').trim();
}

// Parse a WebCTRL Control Program name like "Air Handling Unit B1 - Supply Duct"
// Returns { location, equipName }
// The part before the first " - " (space-dash-space) is the location/system area.
// The part after is the equipment name.
function emParseControlProgram(cpStr) {
  if (!cpStr) return { location: '', equipName: cpStr || '' };
  var idx = cpStr.indexOf(' - ');
  if (idx === -1) return { location: '', equipName: cpStr.trim() };
  return {
    location: cpStr.slice(0, idx).trim(),
    equipName: cpStr.slice(idx + 3).trim(),
  };
}

function emParseLocation(locString) {
  if (!locString) return { floor: '', area: '' };
  var s = locString.trim();
  var floorMatch = s.match(/(\d+(?:st|nd|rd|th)?\s*floor)/i);
  var floor = floorMatch ? floorMatch[1] : '';
  var area = s;
  return { floor: floor, area: area };
}

function emClassifyEquipType(equipTypeStr) {
  if (!equipTypeStr) return 'other';
  var key = equipTypeStr.trim().toLowerCase();
  if (key in EM_EQUIP_TYPES) return EM_EQUIP_TYPES[key];
  for (var pattern in EM_EQUIP_TYPES) {
    if (key.indexOf(pattern) !== -1) return EM_EQUIP_TYPES[pattern];
  }
  if (/ahu|air.?handl/i.test(key)) return 'ahu';
  if (/vav|variable.?air.?vol/i.test(key)) return 'vav';
  if (/fan.?pow|parallel.?fan|fpb|fpt/i.test(key)) return 'fpb';
  if (/dual.?duct|ddvav/i.test(key)) return 'ddvav';
  if (/hot.?water.*boil|boiler|hwp/i.test(key)) return 'hwp';
  if (/chill|chw.*plant|chwp/i.test(key)) return 'chwp';
  if (/cool.*tower|cooling tower|\bct\b/i.test(key)) return 'ct';
  // All unrecognized types (including weather stations, etc.) are kept as 'other'
  return 'other';
}

function emMapPointToColumn(pointName, pointType, equipCategory) {
  if (!pointName) return null;
  for (var i = 0; i < EM_POINT_MAP.length; i++) {
    var mapping = EM_POINT_MAP[i];
    if (equipCategory && mapping.cats && mapping.cats.indexOf(equipCategory) === -1) continue;
    for (var p = 0; p < mapping.patterns.length; p++) {
      if (mapping.patterns[p].test(pointName)) return mapping.col;
    }
  }
  return null;
}

function emExtractEquipmentGroups(rows, colMap) {
  var groups = new Map();

  // ── WebCTRL 14-column point-list format ──
  // Each row is a single BACnet point. Multiple rows share the same Control Program (col 1).
  // Group by building + Control Program name. Parse location and equipment name from the CP string.
  if (colMap.format === 'webctrl') {
    for (var wi = 0; wi < rows.length; wi++) {
      var wrow = rows[wi];
      if (!wrow || wrow.length < 4) continue;
      var bacnetPath = (wrow[0] || '').trim();
      var controlProgram = (wrow[1] || '').trim();
      var pointName = (wrow[2] || '').trim();
      var pointVal = (wrow[3] || '').trim();
      if (!controlProgram) continue;

      var building = emParseBACnetBuilding(bacnetPath);
      // Extract floor from BACnet path segment 2 (e.g. /Site/Building/Floor/Area/CP)
      var bacnetParts = bacnetPath.replace(/^\//, '').split('/');
      var wfloor = (bacnetParts[2] || '').trim();
      var parsed = emParseControlProgram(controlProgram);
      var location = parsed.location;
      var equipName = parsed.equipName || controlProgram;

      // Infer equipment type from the equipment name portion
      // emClassifyEquipType always returns a non-null string now — no rows are filtered
      var category = emClassifyEquipType(equipName);

      var groupKey = building + '||' + location + '||' + equipName;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          building: building,
          floor: wfloor,
          location: location,
          equipName: equipName,
          equipTypeStr: equipName,
          category: category,
          checkValues: {},
          pointValues: {},
          colMap: colMap,
        });
      }
      var wgroup = groups.get(groupKey);

      // Map point name + value to a live data column if we recognise it.
      // Also store every point directly under its raw name for dynamic column display.
      if (pointName !== '' && pointVal !== '') {
        wgroup.pointValues[pointName] = pointVal;
      }
      var pointCol = emMapPointToColumn(pointName, null, category);
      if (pointCol && pointVal !== '') {
        wgroup.pointValues[pointCol] = pointVal;
      }
    }
    return groups;
  }

  // ── Enriched 45-column matrix format (original) ──
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.length < 4) continue;
    var building = (row[colMap.building] || '').trim();
    var location = (row[colMap.location] || '').trim();
    var equipName = (row[colMap.equipName] || '').trim();
    var equipTypeStr = (row[colMap.equipType] || '').trim();
    if (!building || !equipName || equipName === '—') continue;
    // emClassifyEquipType always returns a non-null string now — no rows are filtered
    var category = emClassifyEquipType(equipTypeStr);
    // Include location in key so same-named equipment in different locations stays separate
    var groupKey = building + '||' + location + '||' + equipName;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        building: building,
        location: location,
        equipName: equipName,
        equipTypeStr: equipTypeStr,
        category: category,
        checkValues: {},
        pointValues: {},
        colMap: colMap,
      });
    }
    var group = groups.get(groupKey);
    for (var c = 0; c < colMap.checkCount; c++) {
      var colIdx = colMap.checkStart + c;
      var val = (row[colIdx] || '').trim();
      var checkCols = colMap.checkCount === 14 ? EM_CHECK_COLS_14 : EM_CHECK_COLS_11;
      if (val !== '') {
        group.checkValues[checkCols[c]] = val;
      }
    }
  }
  return groups;
}

function emGroupToMatrixRow(groupKey, group) {
  var loc = emParseLocation(group.location);
  var checkCols = group.colMap.checkCount === 14 ? EM_CHECK_COLS_14 : EM_CHECK_COLS_11;
  var checks = {};
  for (var i = 0; i < checkCols.length; i++) {
    checks[checkCols[i]] = group.checkValues[checkCols[i]] || '';
  }
  // Prefer floor extracted directly from BACnet path (stored on group.floor); fall back to parsed location
  var floorVal = group.floor || loc.floor;
  return {
    id: groupKey,
    building: group.building,
    location: group.location,
    floor: floorVal,
    area: loc.area,
    equipName: group.equipName,
    equipType: group.equipTypeStr,
    category: group.category,
    checks: checks,
    points: group.pointValues,
    // Physical Attributes
    serial: '',
    model: '',
    manufacturer: '',
    sizeCapacity: '',
    voltage: '',
    phase: '',
    amps: '',
    hpTons: '',
    // Lifecycle
    installDate: '',
    age: '',
    expectedLife: '',
    condition: '',
    // Maintenance
    warrantyInfo: '',
    lastServiceDate: '',
    serviceProvider: '',
    // Location Detail
    room: '',
    floorDetail: '',
    wing: '',
    buildingArea: '',
    // Controls/BAS
    controllerType: '',
    bacnetAddr: '',
    ipAddr: '',
    notes: '',
    editedAt: null,
  };
}

/* ── PHASE 2: STORAGE AND MERGE ── */

function emLoadCustomCols(projId) {
  var raw = localStorage.getItem('en_eqmatrix_cols_' + projId);
  return raw ? JSON.parse(raw) : [];
}
function emSaveCustomCols(projId, cols) {
  localStorage.setItem('en_eqmatrix_cols_' + projId, JSON.stringify(cols));
}

function emAddCustomCol(projId) {
  if (!projId) return;
  var label = (window.prompt('New column name:') || '').trim();
  if (!label) return;
  var key = 'custom_col_' + Date.now();
  var cols = emLoadCustomCols(projId);
  cols.push({ key: key, label: label, dataType: 'text' });
  emSaveCustomCols(projId, cols);
  // Invalidate col defs cache so the new column renders immediately
  _EM_COL_DEFS = null;
  var data = emLoadMatrix(projId);
  emRenderTable(data, _emFilters);
}

function emLoadMatrix(projId) {
  if (!projId) return { rows: [], importedAt: null, buildings: [] };
  // '__preview__' is an in-memory-only sentinel — return the preview data without touching localStorage
  if (projId === '__preview__') return window._emPreviewData || { rows: [], importedAt: null, buildings: [] };
  return sget('en_eqmatrix_' + projId, { rows: [], importedAt: null, buildings: [] });
}

function emSaveMatrix(projId, data) {
  if (!projId) return;
  sset('en_eqmatrix_' + projId, data);
}

function emMergeIntoMatrix(existingData, newRows) {
  var existing = existingData && existingData.rows ? existingData.rows : [];
  var byId = {};
  for (var i = 0; i < existing.length; i++) {
    byId[existing[i].id] = existing[i];
  }
  for (var j = 0; j < newRows.length; j++) {
    var nr = newRows[j];
    if (byId[nr.id]) {
      var old = byId[nr.id];
      nr.notes = old.notes || nr.notes;
      nr.editedAt = old.editedAt || nr.editedAt;
    }
    byId[nr.id] = nr;
  }
  var merged = [];
  var seen = {};
  for (var k = 0; k < existing.length; k++) {
    var id = existing[k].id;
    if (!seen[id]) {
      merged.push(byId[id]);
      seen[id] = true;
    }
  }
  for (var m = 0; m < newRows.length; m++) {
    var nid = newRows[m].id;
    if (!seen[nid]) {
      merged.push(byId[nid]);
      seen[nid] = true;
    }
  }
  var buildings = [];
  var bldgSeen = {};
  for (var n = 0; n < merged.length; n++) {
    if (!bldgSeen[merged[n].building]) {
      buildings.push(merged[n].building);
      bldgSeen[merged[n].building] = true;
    }
  }
  return { rows: merged, importedAt: new Date().toISOString(), buildings: buildings };
}

/* ── PHASE 3: VIEW SCAFFOLD ── */

var _emPendingFiles = [];
var _emSortCol = null;
var _emSortDir = 1;
var _emFilters = { building: '', type: '', search: '' };
var _emHiddenGroups = {};
var EM_PAGE_SIZE = 100;
var _emCurrentPage = 0;
var _emPageSize = 100;
var _emShowAllDynCols = false; // when false, limit dynamic point columns to top 20 by frequency
var EM_DYN_COL_LIMIT = 20; // max dynamic point columns shown by default

function initEquipMatrix(projId) {
  var wrap = document.getElementById('em-proj-wrap');
  if (!wrap) return;
  if (!projId) {
    wrap.innerHTML = '<p style="padding:24px;color:var(--t2)">Select a project to view equipment.</p>';
    return;
  }
  var data = emLoadMatrix(projId);
  emRenderMatrix(wrap, data, projId);
}

function emInjectMatrixCSS() {
  if (document.getElementById('em-matrix-styles')) return;
  var style = document.createElement('style');
  style.id = 'em-matrix-styles';
  style.textContent = [
    '.em-table-wrap { overflow: scroll; max-height: 70vh; }',
    '.em-table-wrap::-webkit-scrollbar { height: 14px; width: 14px; }',
    '.em-table-wrap::-webkit-scrollbar-thumb { background: var(--s4); border-radius: 7px; border: 3px solid var(--s2); }',
    '.em-table-wrap::-webkit-scrollbar-track { background: var(--s1); }',
    '.em-table-wrap thead th { position: sticky; top: 0; background: var(--s2); z-index: 3; }',
    '.em-table-wrap td:nth-child(1), .em-table-wrap th:nth-child(1) { position: sticky; left: 0; background: var(--s2); z-index: 2; }',
    '.em-table-wrap td:nth-child(2), .em-table-wrap th:nth-child(2) { position: sticky; left: 150px; background: var(--s2); z-index: 2; }',
    '.em-table-wrap td:nth-child(3), .em-table-wrap th:nth-child(3) { position: sticky; left: 300px; background: var(--s2); z-index: 2; }',
    '.em-table-wrap thead th:nth-child(-n+3) { z-index: 4; }',
  ].join('\n');
  document.head.appendChild(style);
}

function emRenderMatrix(container, data, pid) {
  window._emActivePid = pid;
  if (!data.edits) data.edits = {};
  _emFilters = { building: '', type: '', search: '' };
  _emSortCol = null;
  _emSortDir = 1;
  _emHiddenGroups = {};
  _emEditMode = false;
  _emCurrentPage = 0;
  _emPageSize = EM_PAGE_SIZE;
  _emShowAllDynCols = false;
  emInjectMatrixCSS();

  var projName = '';
  if (typeof projects !== 'undefined') {
    var proj = projects.find(function (p) {
      return String(p.id) === String(pid);
    });
    if (proj) projName = proj.name;
  }

  var stats = emCalcSummaryStats(data.rows || []);
  var statsHtml =
    '<div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--s1);flex-shrink:0">' +
    emStatPill('Buildings', stats.buildings) +
    emStatPill('Equipment', stats.total) +
    emStatPill('AHU / RTU', stats.ahu) +
    emStatPill('VAV / FPB', stats.vav) +
    emStatPill('Plants', stats.plants) +
    emStatPill('Live Data', stats.live) +
    (data.totalBASPoints ? emStatPill('BAS Points', data.totalBASPoints.toLocaleString()) : '') +
    '</div>';

  var projBadge = projName
    ? '<span style="font-size:11px;color:var(--text3);margin-left:10px;font-weight:400">' + projName + '</span>'
    : '';

  var toolbarHtml = emRenderToolbar(data, pid, projBadge);

  container.innerHTML =
    '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
    statsHtml +
    '<div style="flex-shrink:0;border-bottom:1px solid var(--border)">' +
    toolbarHtml +
    '</div>' +
    '<div id="em-table-wrap" class="em-table-wrap" style="flex:1;min-height:0"></div>' +
    '<div id="em-upload-inline" style="display:none;flex-shrink:0;border-top:1px solid var(--border);padding:16px 20px"></div>' +
    '</div>';

  emRenderTable(data, _emFilters);
}

function emStatPill(label, val) {
  return (
    '<div style="display:flex;flex-direction:column;align-items:center;min-width:64px">' +
    '<div style="font-size:18px;font-weight:700;color:var(--text);line-height:1">' +
    val +
    '</div>' +
    '<div style="font-size:10px;color:var(--text3);margin-top:2px;text-transform:uppercase;letter-spacing:0.04em">' +
    label +
    '</div>' +
    '</div>'
  );
}

function emCalcSummaryStats(rows) {
  var buildings = {},
    ahu = 0,
    vav = 0,
    plants = 0,
    live = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.building) buildings[r.building] = true;
    if (r.category === 'ahu') ahu++;
    if (r.category === 'vav' || r.category === 'fpb' || r.category === 'ddvav') vav++;
    if (r.category === 'hwp' || r.category === 'chwp' || r.category === 'ct') plants++;
    var pts = r.points || {};
    var hasLive = false;
    for (var k in pts) {
      if (pts[k] !== '' && pts[k] != null) {
        hasLive = true;
        break;
      }
    }
    if (hasLive) live++;
  }
  return {
    buildings: Object.keys(buildings).length,
    total: rows.length,
    ahu: ahu,
    vav: vav,
    plants: plants,
    live: live,
  };
}

function emShowUploadPanel(btn) {
  var inline = document.getElementById('em-upload-inline');
  if (!inline) return;
  var data = emLoadMatrix(window._emActivePid);
  if (inline.style.display === 'none') {
    inline.style.display = 'block';
    emRenderUploadPanel(inline, window._emActivePid, true);
    btn.textContent = 'Cancel';
  } else {
    inline.style.display = 'none';
    btn.textContent = 'Re-import CSVs';
  }
}

/* ── PHASE 4: TOOLBAR & TABLE ── */

function emRenderToolbar(data, pid, projBadge) {
  var buildings = data.buildings || [];
  var bldgOpts = '<option value="">All Buildings</option>';
  for (var i = 0; i < buildings.length; i++) {
    bldgOpts += '<option value="' + buildings[i].replace(/"/g, '&quot;') + '">' + buildings[i] + '</option>';
  }
  var typeOpts =
    '<option value="">All Types</option>' +
    '<option value="ahu">AHU</option>' +
    '<option value="vav">VAV</option>' +
    '<option value="fpb">FPB</option>' +
    '<option value="ddvav">DD-VAV</option>' +
    '<option value="hwp">HW Plant</option>' +
    '<option value="chwp">CHW Plant</option>' +
    '<option value="ct">Cooling Tower</option>';
  var colToggleStyle =
    'display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text2);cursor:pointer;padding:2px 6px;border-radius:3px;border:1px solid var(--border);background:var(--s2);user-select:none';
  var colToggles =
    '<div style="display:flex;align-items:center;gap:6px;padding:4px 16px 6px;flex-wrap:wrap;border-top:1px solid var(--border)">' +
    '<span style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-right:2px">Columns:</span>' +
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" checked onchange="emToggleColGroup(\'physical\',this.checked)" style="margin:0"> Physical</label>' +
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" checked onchange="emToggleColGroup(\'lifecycle\',this.checked)" style="margin:0"> Lifecycle</label>' +
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" checked onchange="emToggleColGroup(\'maintenance\',this.checked)" style="margin:0"> Maintenance</label>' +
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" checked onchange="emToggleColGroup(\'locDetail\',this.checked)" style="margin:0"> Location</label>' +
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" checked onchange="emToggleColGroup(\'controls\',this.checked)" style="margin:0"> Controls</label>' +
    '<span style="margin-left:8px;border-left:1px solid var(--border);padding-left:8px;display:inline-flex;align-items:center;gap:4px">' +
    '<span id="em-dyn-col-info" style="font-size:10px;color:var(--text3)"></span>' +
    '<button id="em-dyn-col-toggle" onclick="emToggleAllDynCols()" ' +
    'style="font-size:10px;padding:2px 8px;background:var(--s3);border:1px solid var(--border);color:var(--text2);border-radius:3px;cursor:pointer;height:20px;line-height:1">' +
    'Show All Point Columns' +
    '</button>' +
    '</span>' +
    '</div>';
  return (
    '<div style="display:flex;flex-direction:column">' +
    '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;flex-wrap:wrap">' +
    '<select id="em-filter-bldg" onchange="emApplyFilters()" style="font-size:11px;padding:4px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:28px">' +
    bldgOpts +
    '</select>' +
    '<select id="em-filter-type" onchange="emApplyFilters()" style="font-size:11px;padding:4px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:28px">' +
    typeOpts +
    '</select>' +
    '<input id="em-filter-search" type="text" placeholder="Search..." oninput="emApplyFilters()" style="font-size:11px;padding:4px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:28px;width:140px">' +
    '<span id="em-row-count" style="font-size:11px;color:var(--text3);margin-left:4px"></span>' +
    '<div style="flex:1"></div>' +
    (projBadge || '') +
    '<button id="em-edit-mode-btn" class="btn btn-ghost btn-sm" onclick="emToggleEditMode(this)" style="height:28px;font-size:11px">✏️ Edit</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emHandleSaveEdits()" style="height:28px;font-size:11px">Save Edits</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emHandleExportCSV()" style="height:28px;font-size:11px">Export CSV</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emAddManualRow(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">+ Add Row</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emAddCustomCol(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">+ Column</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emShowUploadPanel(this)" style="height:28px;font-size:11px">Re-import CSVs</button>' +
    '<button class="btn btn-sm" onclick="emCopyFromProject(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">📋 Copy From Project</button>' +
    '</div>' +
    colToggles +
    '</div>'
  );
}

var _EM_COL_DEFS = null;
function emGetColDefs(projId) {
  var customCols = projId ? emLoadCustomCols(projId) : [];
  // Only use the cache when there are no custom columns (custom cols are per-project and dynamic)
  if (!customCols.length && _EM_COL_DEFS) return _EM_COL_DEFS;
  var checkCols14 = EM_CHECK_COLS_14;
  var defs = [
    { key: 'building', label: 'Building', group: 'id', width: 180 },
    { key: 'floor', label: 'Floor', group: 'id', width: 80 },
    { key: 'equipName', label: 'Equipment', group: 'id', width: 200 },
    { key: 'equipType', label: 'Control Program', group: 'id', width: 160 },
  ];
  for (var i = 0; i < checkCols14.length; i++) {
    var ck = checkCols14[i];
    var isSeq =
      ck.indexOf('Sequence') !== -1 ||
      ck.indexOf('Reset') !== -1 ||
      ck.indexOf('Start') !== -1 ||
      ck.indexOf('Lag') !== -1 ||
      ck.indexOf('Control') !== -1 ||
      ck.indexOf('Measurement') !== -1;
    defs.push({ key: 'check_' + i, label: ck, group: 'check', width: isSeq ? 110 : 90, checkIdx: i });
  }
  var liveCols = EM_POINT_MAP;
  var liveCatGroups = {
    ahu: { group: 'live-ahu', cats: ['ahu'] },
    zone: { group: 'live-zone', cats: ['vav', 'fpb', 'ddvav'] },
    hwp: { group: 'live-hw', cats: ['hwp'] },
    chwp: { group: 'live-chw', cats: ['chwp'] },
    ct: { group: 'live-ct', cats: ['ct'] },
  };
  for (var j = 0; j < liveCols.length; j++) {
    var pm = liveCols[j];
    var grp = 'live-ahu';
    for (var gk in liveCatGroups) {
      if (liveCatGroups[gk].cats.indexOf(pm.cats[0]) !== -1) {
        grp = liveCatGroups[gk].group;
        break;
      }
    }
    defs.push({ key: pm.col, label: pm.label, group: grp, width: 120, isLive: true });
  }
  // Physical Attributes
  defs.push({ key: 'serial', label: 'Serial #', group: 'physical', width: 120 });
  defs.push({ key: 'model', label: 'Model #', group: 'physical', width: 120 });
  defs.push({ key: 'manufacturer', label: 'Manufacturer', group: 'physical', width: 140 });
  defs.push({ key: 'sizeCapacity', label: 'Size/Capacity', group: 'physical', width: 120 });
  defs.push({ key: 'voltage', label: 'Voltage', group: 'physical', width: 80 });
  defs.push({ key: 'phase', label: 'Phase', group: 'physical', width: 70 });
  defs.push({ key: 'amps', label: 'Amps', group: 'physical', width: 70 });
  defs.push({ key: 'hpTons', label: 'HP/Tons', group: 'physical', width: 80 });

  // Lifecycle
  defs.push({ key: 'installDate', label: 'Install Date', group: 'lifecycle', width: 100 });
  defs.push({ key: 'age', label: 'Age', group: 'lifecycle', width: 60 });
  defs.push({ key: 'expectedLife', label: 'Expected Life', group: 'lifecycle', width: 90 });
  defs.push({ key: 'condition', label: 'Condition', group: 'lifecycle', width: 90 });

  // Maintenance
  defs.push({ key: 'warrantyInfo', label: 'Warranty Info', group: 'maintenance', width: 120 });
  defs.push({ key: 'lastServiceDate', label: 'Last Service', group: 'maintenance', width: 100 });
  defs.push({ key: 'serviceProvider', label: 'Service Provider', group: 'maintenance', width: 130 });

  // Location Detail
  defs.push({ key: 'room', label: 'Room', group: 'locDetail', width: 80 });
  defs.push({ key: 'floorDetail', label: 'Floor', group: 'locDetail', width: 70 });
  defs.push({ key: 'wing', label: 'Wing', group: 'locDetail', width: 80 });
  defs.push({ key: 'buildingArea', label: 'Building Area', group: 'locDetail', width: 120 });

  // Controls/BAS
  defs.push({ key: 'controllerType', label: 'Controller Type', group: 'controls', width: 120 });
  defs.push({ key: 'bacnetAddr', label: 'BACnet Addr', group: 'controls', width: 110 });
  defs.push({ key: 'ipAddr', label: 'IP Address', group: 'controls', width: 110 });

  defs.push({ key: 'notes', label: 'Notes', group: 'id', width: 200 });

  // Append user-created custom columns at the end
  for (var cc = 0; cc < customCols.length; cc++) {
    var ccol = customCols[cc];
    defs.push({
      key: ccol.key,
      label: ccol.label,
      group: 'custom',
      width: 120,
      isCustom: true,
      dataType: ccol.dataType,
    });
  }

  if (!customCols.length) _EM_COL_DEFS = defs;
  return defs;
}

var _EM_GROUP_COLORS = {
  id: 'transparent',
  check: 'var(--text3)',
  'live-ahu': '#2ecc71',
  'live-zone': '#e67e22',
  'live-hw': '#e74c3c',
  'live-chw': '#3498db',
  'live-ct': '#9b59b6',
  physical: '#27ae60',
  lifecycle: '#f39c12',
  maintenance: '#2980b9',
  locDetail: '#8e44ad',
  controls: '#16a085',
  custom: '#c0392b',
};

function emGetCellValByDef(row, def, edits) {
  var editKey = row.id + '::' + def.key;
  if (edits && edits[editKey] !== undefined) return edits[editKey];
  if (def.key.indexOf('check_') === 0) {
    var checkCols = EM_CHECK_COLS_14;
    return (row.checks && row.checks[checkCols[def.checkIdx]]) || '';
  }
  if (def.isLive || def.isDynPoint) {
    return (row.points && row.points[def.key]) || '';
  }
  return row[def.key] || '';
}

function emRenderTable(data, filters) {
  var wrap = document.getElementById('em-table-wrap');
  if (!wrap) return;
  var rows = data.rows || [];
  var edits = data.edits || {};
  var filtered = emFilterRows(rows, filters);

  var defs = emGetColDefs(window._emActivePid).filter(function (d) {
    return !_emHiddenGroups[d.group];
  });

  // ── Dynamic point columns ──
  // Collect all unique point names from every row's .points object.
  // Skip keys that are already covered by a mapped live column (e.g. 'satLive') or
  // any standard def key — only raw BACnet point names become dynamic columns.
  // PERFORMANCE LIMIT: With thousands of BAS points, showing every unique point name
  // as a column creates hundreds/thousands of columns × 100 rows = tens of thousands of
  // cells, causing the browser to freeze. Default: show only the top 20 most common
  // point names. Use the "Show All Columns" toggle to override.
  var existingDefKeys = {};
  for (var ex = 0; ex < defs.length; ex++) existingDefKeys[defs[ex].key] = true;
  // Also skip the short EM_POINT_MAP col names (satLive, ratLive, etc.)
  for (var pm = 0; pm < EM_POINT_MAP.length; pm++) existingDefKeys[EM_POINT_MAP[pm].col] = true;

  // Count frequency of each raw point name across all rows
  var dynPointFreq = {};
  for (var rr = 0; rr < rows.length; rr++) {
    var pts = rows[rr].points || {};
    for (var ptKey in pts) {
      if (!existingDefKeys[ptKey]) {
        dynPointFreq[ptKey] = (dynPointFreq[ptKey] || 0) + 1;
      }
    }
  }
  var allDynKeys = Object.keys(dynPointFreq);
  var totalUniqueDynCols = allDynKeys.length;

  // Sort by frequency descending, then alphabetically for ties
  allDynKeys.sort(function (a, b) {
    var diff = dynPointFreq[b] - dynPointFreq[a];
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Apply column limit unless user toggled "Show All"
  var dynColsToShow = _emShowAllDynCols ? allDynKeys : allDynKeys.slice(0, EM_DYN_COL_LIMIT);

  // Safety check: if projected cell count per page is still too large, reduce further.
  // Cap _estRowsPerPage at EM_PAGE_SIZE for budget calculation — the budget was designed around
  // page size, not total row count. When "All" rows mode is active with a large dataset,
  // using filtered.length would make cellBudget go negative and zero out all dynamic columns.
  var _estRowsPerPage = Math.min(_emPageSize === 0 ? EM_PAGE_SIZE : _emPageSize, filtered.length);
  var projectedCells = _estRowsPerPage * (defs.length + dynColsToShow.length);
  if (projectedCells > 10000 && !_emShowAllDynCols) {
    // Calculate how many dyn cols fit within the 10,000-cell budget
    var cellBudget = Math.max(0, 10000 - _estRowsPerPage * defs.length);
    var safeDynCount = _estRowsPerPage > 0 ? Math.floor(cellBudget / _estRowsPerPage) : 0;
    safeDynCount = Math.max(0, Math.min(safeDynCount, dynColsToShow.length));
    dynColsToShow = dynColsToShow.slice(0, safeDynCount);
  }
  // Guard: "Show All Columns" + "All Rows" with a very large dataset can freeze the browser.
  // If the true projected cell count (using actual row count) would be extreme, ignore _emShowAllDynCols.
  if (_emShowAllDynCols && _emPageSize === 0 && filtered.length * (defs.length + dynColsToShow.length) > 100000) {
    dynColsToShow = dynColsToShow.slice(0, EM_DYN_COL_LIMIT);
  }

  if (!_emHiddenGroups['dynpoint']) {
    for (var dp = 0; dp < dynColsToShow.length; dp++) {
      defs.push({ key: dynColsToShow[dp], label: dynColsToShow[dp], group: 'dynpoint', width: 120, isDynPoint: true });
    }
  }

  if (!_EM_GROUP_COLORS['dynpoint']) {
    _EM_GROUP_COLORS['dynpoint'] = '#7f8c8d';
  }

  // Update the dyn-col info label and toggle button state to reflect current counts
  var dynInfoEl = document.getElementById('em-dyn-col-info');
  if (dynInfoEl) {
    if (totalUniqueDynCols === 0) {
      dynInfoEl.textContent = 'No raw point columns';
    } else if (_emShowAllDynCols) {
      dynInfoEl.textContent = 'Showing all ' + dynColsToShow.length + ' point columns';
    } else {
      dynInfoEl.textContent = 'Showing ' + dynColsToShow.length + ' of ' + totalUniqueDynCols + ' point columns';
    }
  }
  var dynToggleBtn = document.getElementById('em-dyn-col-toggle');
  if (dynToggleBtn) {
    dynToggleBtn.textContent = _emShowAllDynCols ? 'Limit to Top ' + EM_DYN_COL_LIMIT : 'Show All Point Columns';
    dynToggleBtn.style.background = _emShowAllDynCols ? 'var(--accent)' : 'var(--s3)';
    dynToggleBtn.style.color = _emShowAllDynCols ? '#fff' : 'var(--text2)';
    dynToggleBtn.style.display = totalUniqueDynCols === 0 ? 'none' : '';
  }

  var checkCols = EM_CHECK_COLS_14;

  if (_emSortCol !== null) {
    var sortDef = defs[_emSortCol];
    var sd = _emSortDir;
    if (sortDef) {
      filtered = filtered.slice().sort(function (a, b) {
        var av = emGetCellValByDef(a, sortDef, data.edits);
        var bv = emGetCellValByDef(b, sortDef, data.edits);
        if (av < bv) return -sd;
        if (av > bv) return sd;
        return 0;
      });
    }
  }

  var countEl = document.getElementById('em-row-count');
  if (countEl) countEl.textContent = filtered.length + ' of ' + rows.length + ' rows';

  // ── Pagination ──
  var pageSize = _emPageSize;
  var useAll = pageSize === 0;
  var totalPages = useAll ? 1 : Math.ceil(filtered.length / pageSize);
  if (totalPages < 1) totalPages = 1;
  _emCurrentPage = Math.max(0, Math.min(_emCurrentPage, totalPages - 1));
  var pageStart = useAll ? 0 : _emCurrentPage * pageSize;
  var pageEnd = useAll ? filtered.length : Math.min(pageStart + pageSize, filtered.length);
  var pageRows = filtered.slice(pageStart, pageEnd);

  var theadCells = '';
  for (var ci = 0; ci < defs.length; ci++) {
    var d = defs[ci];
    var color = _EM_GROUP_COLORS[d.group] || 'transparent';
    var borderTop =
      color !== 'transparent' ? 'border-top:3px solid ' + color + ';' : 'border-top:3px solid transparent;';
    var isSorted = _emSortCol === ci;
    var sortInd = isSorted ? (_emSortDir === 1 ? ' ▲' : ' ▼') : '';
    theadCells +=
      '<th data-ci="' +
      ci +
      '" onclick="emHandleSort(' +
      ci +
      ')" ' +
      'style="position:sticky;top:0;z-index:2;background:var(--s2);' +
      borderTop +
      'padding:6px 8px;font-size:10px;font-weight:600;color:var(--text2);white-space:nowrap;cursor:pointer;' +
      'min-width:' +
      d.width +
      'px;text-align:left;' +
      'border-bottom:1px solid var(--border);border-right:1px solid var(--border)">' +
      d.label +
      sortInd +
      '</th>';
  }

  var tbodyRows = '';
  for (var ri = 0; ri < pageRows.length; ri++) {
    var row = pageRows[ri];
    var rowId = row.id;
    var cells = '';
    for (var di = 0; di < defs.length; di++) {
      var def = defs[di];
      var editKey = rowId + '::' + def.key;
      var isEdited = edits && edits[editKey] !== undefined;
      var rawVal = emGetCellValByDef(row, def, edits);
      var displayVal = emFormatCell(rawVal, def);
      var cellStyle =
        'padding:4px 8px;font-size:11px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);vertical-align:middle;' +
        (def.isLive ? 'font-family:Consolas,monospace;font-size:10px;' : '') +
        (def.isDynPoint ? 'font-family:Consolas,monospace;font-size:10px;' : '') +
        (isEdited ? 'background:#fffde7;border-left:3px solid var(--em);' : '');
      if (_emEditMode) {
        cells +=
          '<td contenteditable="true" ' +
          'onblur="emHandleCellEdit(\'' +
          rowId.replace(/'/g, "\\'") +
          "','" +
          def.key.replace(/'/g, "\\'") +
          '\',this.textContent)" ' +
          'style="' +
          cellStyle +
          '">' +
          displayVal +
          '</td>';
      } else {
        cells += '<td style="' + cellStyle + '">' + displayVal + '</td>';
      }
    }
    tbodyRows += '<tr>' + cells + '</tr>';
  }

  if (filtered.length === 0) {
    tbodyRows =
      '<tr><td colspan="' +
      defs.length +
      '" style="padding:32px;text-align:center;font-size:12px;color:var(--text2)">No rows match the current filters.</td></tr>';
  }

  // ── Pagination bar ──
  var pid = window._emActivePid || '';
  var pageSizeOptions = [50, 100, 250, 0];
  var pageSizeLabels = { 50: '50', 100: '100', 250: '250', 0: 'All' };
  var sizeSelectHtml =
    '<select onchange="emSetPageSize(' +
    JSON.stringify(pid) +
    ', this.value)" style="font-size:11px;padding:2px 6px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">';
  for (var si = 0; si < pageSizeOptions.length; si++) {
    var opt = pageSizeOptions[si];
    var lbl = pageSizeLabels[opt];
    var isCurrent = _emPageSize === opt;
    var warn = opt === 0 && filtered.length > 500 ? ' ⚠️ slow' : '';
    sizeSelectHtml += '<option value="' + opt + '"' + (isCurrent ? ' selected' : '') + '>' + lbl + warn + '</option>';
  }
  sizeSelectHtml += '</select>';

  var prevDisabled = _emCurrentPage <= 0 || useAll;
  var nextDisabled = _emCurrentPage >= totalPages - 1 || useAll;
  var pageLabel = useAll
    ? 'All ' + filtered.length + ' rows'
    : 'Page ' + (_emCurrentPage + 1) + ' of ' + totalPages + ' (' + filtered.length + ' total rows)';

  var paginationHtml =
    '<div class="em-pagination" style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--border);background:var(--s1);flex-shrink:0;font-size:11px;color:var(--text2)">' +
    '<button onclick="emPrevPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (prevDisabled ? 'disabled style="opacity:0.4;cursor:default;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">&#8592; Previous</button>' +
    '<span style="flex:1;text-align:center">' +
    pageLabel +
    '</span>' +
    '<button onclick="emNextPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (nextDisabled ? 'disabled style="opacity:0.4;cursor:default;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Next &#8594;</button>' +
    '<span style="color:var(--text3)">Rows per page:</span>' +
    sizeSelectHtml +
    '</div>';

  wrap.innerHTML =
    '<table style="border-collapse:collapse;table-layout:auto">' +
    '<thead><tr>' +
    theadCells +
    '</tr></thead>' +
    '<tbody>' +
    tbodyRows +
    '</tbody>' +
    '</table>';

  // Inject pagination bar after the scroll container (outside the scroll wrap)
  var tableWrap = document.getElementById('em-table-wrap');
  if (tableWrap && tableWrap.parentNode) {
    var existingPag = tableWrap.parentNode.querySelector('.em-pagination');
    if (existingPag) existingPag.parentNode.removeChild(existingPag);
    var pagDiv = document.createElement('div');
    pagDiv.innerHTML = paginationHtml;
    tableWrap.parentNode.insertBefore(pagDiv.firstChild, tableWrap.nextSibling);
  }
}

function emPrevPage(pid) {
  if (_emCurrentPage > 0) {
    _emCurrentPage--;
    var data = emLoadMatrix(pid);
    emRenderTable(data, _emFilters);
  }
}

function emNextPage(pid) {
  _emCurrentPage++;
  var data = emLoadMatrix(pid);
  emRenderTable(data, _emFilters);
}

function emSetPageSize(pid, val) {
  _emPageSize = parseInt(val, 10);
  if (isNaN(_emPageSize)) _emPageSize = EM_PAGE_SIZE;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  emRenderTable(data, _emFilters);
}

function emGetCellVal(row, colIdx, edits) {
  var defs = emGetColDefs();
  var def = defs[colIdx];
  if (!def) return '';
  var editKey = row.id + '::' + def.key;
  if (edits && edits[editKey] !== undefined) return edits[editKey];
  if (def.key.indexOf('check_') === 0) {
    var idx = def.checkIdx;
    var checkCols = EM_CHECK_COLS_14;
    return (row.checks && row.checks[checkCols[idx]]) || '';
  }
  if (def.isLive || def.isDynPoint) {
    return (row.points && row.points[def.key]) || '';
  }
  return row[def.key] || '';
}

function emFormatCell(val, def) {
  if (val === null || val === undefined || val === '') return '<span style="color:var(--text3)">—</span>';
  var s = String(val);
  if (def.key.indexOf('check_') === 0) {
    if (!def.isLive) {
      var isSeq =
        def.label.indexOf('Sequence') !== -1 ||
        def.label.indexOf('Reset') !== -1 ||
        def.label.indexOf('Start') !== -1 ||
        def.label.indexOf('Lag') !== -1 ||
        def.label.indexOf('Control') !== -1 ||
        def.label.indexOf('Measurement') !== -1;
      if (isSeq) {
        if (/^active$/i.test(s))
          return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#1a4a2e;color:#2ecc71;font-size:10px;font-weight:600">Active</span>';
        if (/^partial$/i.test(s))
          return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#3a3010;color:#f1c40f;font-size:10px;font-weight:600">Partial</span>';
        if (/^missing$/i.test(s))
          return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#4a1010;color:#e74c3c;font-size:10px;font-weight:600">Missing</span>';
        if (/^n\/?a$/i.test(s))
          return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:var(--s3);color:var(--text3);font-size:10px">N/A</span>';
      } else {
        if (/^x$/i.test(s)) return '<span style="color:#2ecc71;font-size:13px;font-weight:700">✓</span>';
        if (/^missing$/i.test(s)) return '<span style="color:#e74c3c;font-size:13px;font-weight:700">✗</span>';
        if (/^n\/?a$/i.test(s)) return '<span style="color:var(--text3);font-size:11px">N/A</span>';
      }
    }
  }
  return s;
}

function emFilterRows(rows, filters) {
  var f = filters || {};
  return rows.filter(function (r) {
    if (f.building && r.building !== f.building) return false;
    if (f.type && r.category !== f.type) return false;
    if (f.search) {
      var q = f.search.toLowerCase();
      var haystack = (r.building + ' ' + r.equipName + ' ' + r.location + ' ' + r.notes).toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function emApplyFilters() {
  var bldg = document.getElementById('em-filter-bldg');
  var type = document.getElementById('em-filter-type');
  var search = document.getElementById('em-filter-search');
  _emFilters = {
    building: bldg ? bldg.value : '',
    type: type ? type.value : '',
    search: search ? search.value : '',
  };
  _emCurrentPage = 0;
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

function emToggleColGroup(group, visible) {
  _emHiddenGroups[group] = !visible;
  // Reset column defs cache so index-based sort stays consistent
  _EM_COL_DEFS = null;
  _emSortCol = null;
  _emCurrentPage = 0;
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

function emToggleAllDynCols() {
  _emShowAllDynCols = !_emShowAllDynCols;
  _emSortCol = null;
  _emCurrentPage = 0;
  var btn = document.getElementById('em-dyn-col-toggle');
  if (btn) {
    btn.textContent = _emShowAllDynCols ? 'Limit to Top ' + EM_DYN_COL_LIMIT : 'Show All Point Columns';
    btn.style.background = _emShowAllDynCols ? 'var(--accent)' : 'var(--s3)';
    btn.style.color = _emShowAllDynCols ? '#fff' : 'var(--text2)';
  }
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

function emHandleSort(colIdx) {
  if (_emSortCol === colIdx) {
    _emSortDir = _emSortDir === 1 ? -1 : 1;
  } else {
    _emSortCol = colIdx;
    _emSortDir = 1;
  }
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

function emHandleCellEdit(rowId, fieldKey, newValue) {
  var pid = window._emActivePid;
  if (!pid) return;
  var data = emLoadMatrix(pid);
  if (!data.edits) data.edits = {};
  var editKey = rowId + '::' + fieldKey;
  data.edits[editKey] = newValue.trim();
  emSaveMatrix(pid, data);
}

function emHandleSaveEdits() {
  var pid = window._emActivePid;
  if (!pid) return;
  var data = emLoadMatrix(pid);
  var editCount = data.edits ? Object.keys(data.edits).length : 0;
  emSaveMatrix(pid, data);
  showToast('Edits saved — ' + editCount + ' field' + (editCount !== 1 ? 's' : '') + ' modified');
}

function emHandleExportCSV() {
  var pid = window._emActivePid;
  if (!pid) return;
  var data = emLoadMatrix(pid);
  var rows = data.rows || [];
  var defs = emGetColDefs();
  var headers = defs
    .map(function (d) {
      return '"' + d.label.replace(/"/g, '""') + '"';
    })
    .join(',');
  var lines = [headers];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var cells = defs.map(function (def, ci) {
      var val = emGetCellVal(row, ci, data.edits);
      if (val === null || val === undefined) val = '';
      return '"' + String(val).replace(/"/g, '""') + '"';
    });
    lines.push(cells.join(','));
  }
  var csv = lines.join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'equipment-matrix-' + pid + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function emAddManualRow(projId) {
  if (!projId) projId = window._emActivePid;
  if (!projId) return;
  var data = emLoadMatrix(projId);
  var newRow = {
    id: 'manual_' + Date.now(),
    // Identity
    building: '',
    location: '',
    equipName: '',
    equipType: '',
    category: '',
    floor: '',
    area: '',
    // Checks / Points
    checks: {},
    points: {},
    // Physical Attributes
    serial: '',
    model: '',
    manufacturer: '',
    sizeCapacity: '',
    voltage: '',
    phase: '',
    amps: '',
    hpTons: '',
    // Lifecycle
    installDate: '',
    age: '',
    expectedLife: '',
    condition: '',
    // Maintenance
    warrantyInfo: '',
    lastServiceDate: '',
    serviceProvider: '',
    // Location Detail
    room: '',
    floorDetail: '',
    wing: '',
    buildingArea: '',
    // Controls/BAS
    controllerType: '',
    bacnetAddr: '',
    ipAddr: '',
    // Notes
    notes: '',
    editedAt: new Date().toISOString(),
  };
  if (!data.rows) data.rows = [];
  data.rows.push(newRow);
  emSaveMatrix(projId, data);
  emRenderTable(data, _emFilters);
  showToast('New row added — fill in inline');
}

function emRenderUploadPanel(container, pid, inline) {
  _emPendingFiles = [];
  container.innerHTML =
    '<div style="' +
    (inline ? '' : 'padding:20px 24px') +
    '">' +
    '<div id="em-drop-zone" ' +
    'style="border:2px dashed var(--border);border-radius:8px;padding:32px 24px;text-align:center;cursor:pointer;background:var(--s2);transition:border-color 0.15s;margin-bottom:12px" ' +
    'ondragover="emHandleFileDrop(event,\'over\')" ' +
    'ondragleave="emHandleFileDrop(event,\'leave\')" ' +
    'ondrop="emHandleFileDrop(event,\'drop\')" ' +
    'onclick="document.getElementById(\'em-file-input\').click()">' +
    '<div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">Drop CSV files here</div>' +
    '<div style="font-size:11px;color:var(--text3)">or click to browse — accepts multiple files</div>' +
    '</div>' +
    '<input type="file" id="em-file-input" accept=".csv" multiple style="display:none" onchange="emHandleFileSelect(event)">' +
    '<div id="em-file-list" style="margin-bottom:12px;display:none">' +
    '<div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">Files queued:</div>' +
    '<ul id="em-file-items" style="list-style:none;padding:0;margin:0;font-size:11px;color:var(--text)"></ul>' +
    '</div>' +
    '<div id="em-import-row" style="display:none">' +
    '<button class="btn btn-sm" style="background:var(--accent);color:#fff;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-weight:600" onclick="emHandleImport(\'' +
    pid +
    '\')">' +
    'Import' +
    '</button>' +
    '<span id="em-import-status" style="font-size:11px;color:var(--text3);margin-left:10px"></span>' +
    '</div>' +
    '</div>';
}

function emHandleFileDrop(event, action) {
  event.preventDefault();
  var zone = document.getElementById('em-drop-zone');
  if (action === 'over') {
    if (zone) zone.style.borderColor = 'var(--accent)';
    return;
  }
  if (action === 'leave') {
    if (zone) zone.style.borderColor = 'var(--border)';
    return;
  }
  if (zone) zone.style.borderColor = 'var(--border)';
  if (action === 'drop') {
    var files = event.dataTransfer ? event.dataTransfer.files : [];
    emQueueFiles(files);
  }
}

function emHandleFileSelect(event) {
  var files = event.target ? event.target.files : [];
  emQueueFiles(files);
  event.target.value = '';
}

function emQueueFiles(files) {
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.name.toLowerCase().endsWith('.csv')) {
      _emPendingFiles.push(f);
    }
  }
  var listDiv = document.getElementById('em-file-list');
  var itemsUl = document.getElementById('em-file-items');
  var importRow = document.getElementById('em-import-row');
  if (!listDiv || !itemsUl || !importRow) return;
  if (_emPendingFiles.length === 0) return;
  listDiv.style.display = 'block';
  importRow.style.display = 'block';
  var html = '';
  for (var j = 0; j < _emPendingFiles.length; j++) {
    html += '<li style="padding:2px 0;color:var(--text)">' + _emPendingFiles[j].name + '</li>';
  }
  itemsUl.innerHTML = html;
}

function emHandleImport(pid) {
  if (!_emPendingFiles || _emPendingFiles.length === 0) return;
  var statusEl = document.getElementById('em-import-status');
  if (statusEl) statusEl.textContent = 'Parsing...';
  var allRows = [];
  var detectedFormats = [];
  var totalRawRows = 0; // count of raw CSV data rows across all files, before grouping
  var pending = _emPendingFiles.length;
  var done = 0;
  function onFileDone() {
    done++;
    if (done < pending) return;

    // ── Zero-row warning ──
    if (allRows.length === 0) {
      var formatList = detectedFormats.join(', ') || 'unknown';
      console.warn(
        '[EquipMatrix] Import produced 0 rows. Detected format(s): ' +
          formatList +
          '. Check that the CSV has recognisable equipment type names ' +
          '(e.g. AHU, VAV, FPB, Boiler) in the Control Program column (WebCTRL) ' +
          'or Equipment Type column (enriched matrix).',
      );
      showToast('WARNING: No equipment found in CSV — check the file format', 'warn');
      if (statusEl) statusEl.textContent = 'No equipment rows found.';
      return;
    }

    // Only save to localStorage when a project is selected
    if (pid) {
      var existingData = emLoadMatrix(pid);
      var merged = emMergeIntoMatrix(existingData, allRows);
      // Accumulate total BAS points: add new raw rows to any previously stored count
      merged.totalBASPoints = (existingData.totalBASPoints || 0) + totalRawRows;
      emSaveMatrix(pid, merged);
      var container = document.getElementById('em-proj-wrap');
      if (container) emRenderMatrix(container, merged, pid);
      showToast(
        'Equipment matrix imported: ' +
          allRows.length +
          ' rows from ' +
          merged.buildings.length +
          ' building' +
          (merged.buildings.length !== 1 ? 's' : ''),
      );
    } else {
      // No project — render a preview without saving
      var previewData = emMergeIntoMatrix({ rows: [], buildings: [] }, allRows);
      previewData.totalBASPoints = totalRawRows;
      var container = document.getElementById('em-proj-wrap');
      if (container) {
        // Store preview in a temporary in-memory key so emRenderMatrix can load it
        window._emPreviewData = previewData;
        window._emActivePid = '__preview__';
        emRenderMatrix(container, previewData, '__preview__');
      }
      showToast(
        'Preview: ' +
          allRows.length +
          ' rows from ' +
          previewData.buildings.length +
          ' building' +
          (previewData.buildings.length !== 1 ? 's' : '') +
          ' — select a project to save',
      );
    }
  }
  for (var i = 0; i < _emPendingFiles.length; i++) {
    (function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var text = e.target.result;
        var parsed = emParseCSVText(text);
        if (parsed.length < 2) {
          onFileDone();
          return;
        }
        var colMap = emDetectColMap(parsed[0]);
        detectedFormats.push(colMap.format || 'enriched');
        // Count raw data rows (header row excluded) before grouping
        totalRawRows += parsed.slice(1).length;
        var groups = emExtractEquipmentGroups(parsed.slice(1), colMap);
        groups.forEach(function (group, key) {
          allRows.push(emGroupToMatrixRow(key, group));
        });
        onFileDone();
      };
      reader.onerror = function () {
        onFileDone();
      };
      reader.readAsText(file);
    })(_emPendingFiles[i]);
  }
}

function emCopyFromProject(targetProjId) {
  var projects = sget('en_projects') || [];
  var otherProjects = projects.filter(function (p) {
    return p.id !== targetProjId;
  });
  if (!otherProjects.length) {
    alert('No other projects available to copy from.');
    return;
  }
  var listText = otherProjects
    .map(function (p, i) {
      return i + 1 + '. ' + (p.name || p.id);
    })
    .join('\n');
  var answer = prompt('Copy equipment from which project?\n\n' + listText + '\n\nEnter number:');
  if (!answer) return;
  var idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= otherProjects.length) {
    alert('Invalid selection.');
    return;
  }
  var sourceProj = otherProjects[idx];
  var sourceData = emLoadMatrix(sourceProj.id);
  if (!sourceData || !sourceData.rows || !sourceData.rows.length) {
    alert('No equipment data found in "' + (sourceProj.name || sourceProj.id) + '".');
    return;
  }
  var clonedRows = JSON.parse(JSON.stringify(sourceData.rows));
  var now = Date.now();
  for (var i = 0; i < clonedRows.length; i++) {
    clonedRows[i].id = 'copy_' + now + i;
  }
  var targetData = emLoadMatrix(targetProjId);
  for (var j = 0; j < clonedRows.length; j++) {
    targetData.rows.push(clonedRows[j]);
  }
  emSaveMatrix(targetProjId, targetData);
  var container = document.getElementById('em-proj-wrap');
  if (container) emRenderMatrix(container, targetData, targetProjId);
  alert(clonedRows.length + ' rows copied from "' + (sourceProj.name || sourceProj.id) + '".');
}
