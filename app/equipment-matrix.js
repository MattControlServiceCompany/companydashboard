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
  'weather station (no hvac)': null,
  'weather station': null,
  'no gl36 equipment': null,
  'no bas equipment': null,
};

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
  var n = headerRow.length;
  var checkCount = 11;
  if (n >= 4 + 14) checkCount = 14;
  return {
    building: 0,
    location: 1,
    equipName: 2,
    equipType: 3,
    checkStart: 4,
    checkCount: checkCount,
    pointStart: 4 + checkCount,
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
  if (!equipTypeStr) return null;
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
  if (/weather.?station|no.*(gl36|bas|hvac)/i.test(key)) return null;
  return null;
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
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.length < 4) continue;
    var building = (row[colMap.building] || '').trim();
    var location = (row[colMap.location] || '').trim();
    var equipName = (row[colMap.equipName] || '').trim();
    var equipTypeStr = (row[colMap.equipType] || '').trim();
    if (!building || !equipName || equipName === '—') continue;
    var category = emClassifyEquipType(equipTypeStr);
    if (category === null) continue;
    var groupKey = building + '||' + equipName;
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
  return {
    id: groupKey,
    building: group.building,
    location: group.location,
    floor: loc.floor,
    area: loc.area,
    equipName: group.equipName,
    equipType: group.equipTypeStr,
    category: group.category,
    checks: checks,
    points: group.pointValues,
    notes: '',
    editedAt: null,
  };
}

/* ── PHASE 2: STORAGE AND MERGE ── */

function emGetActiveProjId() {
  if (typeof udSelProjId !== 'undefined' && udSelProjId) return String(udSelProjId);
  try {
    var stored = localStorage.getItem('ch_activeView');
    var proj = sessionStorage.getItem('ch_proj');
    if (proj) {
      var p = JSON.parse(proj);
      if (p && p.projId != null) return String(p.projId);
    }
  } catch (e) {}
  return null;
}

function emLoadMatrix(projId) {
  if (!projId) return { rows: [], importedAt: null, buildings: [] };
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

function initEquipMatrix(projId) {
  var pid = projId || emGetActiveProjId();
  var container = document.getElementById('em-view-body');
  if (!container) return;
  var data = emLoadMatrix(pid);
  if (data && data.rows && data.rows.length > 0) {
    emRenderSummary(container, data, pid);
  } else {
    emRenderUploadPanel(container, pid);
  }
}

function emRenderSummary(container, data, pid) {
  var bldgCount = data.buildings ? data.buildings.length : 0;
  var rowCount = data.rows ? data.rows.length : 0;
  container.innerHTML =
    '<div style="padding:20px 24px">' +
    '<div style="background:var(--s2);border:1px solid var(--border);border-radius:6px;padding:16px 20px;margin-bottom:16px">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Matrix loaded: ' +
    rowCount +
    ' rows from ' +
    bldgCount +
    ' building' +
    (bldgCount !== 1 ? 's' : '') +
    '</div>' +
    (data.importedAt
      ? '<div style="font-size:11px;color:var(--text3)">Last imported: ' +
        new Date(data.importedAt).toLocaleString() +
        '</div>'
      : '') +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="emShowUploadPanel(this)" style="margin-bottom:12px">+ Import More CSVs</button>' +
    '<div id="em-upload-inline" style="display:none"></div>' +
    '</div>';
  window._emActivePid = pid;
}

function emShowUploadPanel(btn) {
  var inline = document.getElementById('em-upload-inline');
  if (!inline) return;
  if (inline.style.display === 'none') {
    inline.style.display = 'block';
    emRenderUploadPanel(inline, window._emActivePid, true);
    btn.textContent = 'Cancel';
  } else {
    inline.style.display = 'none';
    btn.textContent = '+ Import More CSVs';
  }
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
  var pending = _emPendingFiles.length;
  var done = 0;
  function onFileDone() {
    done++;
    if (done < pending) return;
    var existingData = emLoadMatrix(pid);
    var merged = emMergeIntoMatrix(existingData, allRows);
    emSaveMatrix(pid, merged);
    var container = document.getElementById('em-view-body');
    if (container) emRenderSummary(container, merged, pid);
    showToast(
      'Equipment matrix imported: ' +
        allRows.length +
        ' rows from ' +
        merged.buildings.length +
        ' building' +
        (merged.buildings.length !== 1 ? 's' : ''),
    );
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
