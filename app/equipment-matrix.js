/* ── EQUIPMENT MATRIX — Phase 1-3 ── */

/* ── CONSTANTS ── */
var EM_EQUIP_TYPES = {
  'multizone vav ahu': 'ahu',
  'multizone ahu': 'ahu',
  'vav ahu': 'ahu',
  ahu: 'ahu',
  'air handling unit': 'ahu',
  rtu: 'ahu',
  'rooftop unit': 'ahu',
  rooftop: 'ahu',
  mau: 'ahu',
  'makeup air unit': 'ahu',
  'makeup air': 'ahu',
  doas: 'ahu',
  erv: 'ahu',
  hrv: 'ahu',
  'energy recovery ventilator': 'ahu',
  'fan coil': 'ahu',
  fcu: 'ahu',
  crac: 'ahu',
  crah: 'ahu',
  'heat pump': 'ahu',
  wshp: 'ahu',
  gshp: 'ahu',
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
  ftu: 'fpb',
  'dual duct vav terminal': 'ddvav',
  'dual duct terminal': 'ddvav',
  'ddvav terminal': 'ddvav',
  'hot water plant': 'hwp',
  'hot water plant (boilers)': 'hwp',
  'boiler plant': 'hwp',
  hwp: 'hwp',
  blr: 'hwp',
  furnace: 'hwp',
  'unit heater': 'hwp',
  uh: 'hwp',
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
  // Lighting — recognized category so JOCO-style "Lighting - ADC" parses correctly
  lighting: 'lighting',
  'lighting zone': 'lighting',
  'lighting control': 'lighting',
  elv: 'lighting',
  // Non-HVAC equipment — explicitly 'other' so JOCO-style names flip correctly
  'smoke damper': 'other',
  'smoke damper monitor': 'other',
  'environmental index': 'other',
};

/* ── EDIT MODE FLAG ── */
var _emEditMode = false;

/* ── UPLOAD TARGET PID ──
   Set when the upload panel opens. Used by emQueueFiles/emHandleImport
   instead of window._emActivePid so stale-pid contamination cannot occur.  */
var _emUploadTargetPid = null;

/* ── COLUMN RESIZE STATE ── */
// Stores custom widths set by the user dragging column borders: { colIndex: widthPx }
var _emColWidths = {};

function emToggleEditMode(btn) {
  _emEditMode = !_emEditMode;
  if (btn) {
    btn.textContent = _emEditMode ? 'Lock' : 'Edit';
    btn.style.background = _emEditMode ? 'var(--accent)' : '';
    btn.style.color = _emEditMode ? '#fff' : '';
  }
  var deleteAllBtn = document.getElementById('em-delete-all-btn');
  if (deleteAllBtn) deleteAllBtn.style.display = _emEditMode ? '' : 'none';
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

/* ── emToggleViewMode ───────────────────────────────────────────────────────
   Switches between 'audit' (ASHRAE 36 compliance columns) and 'raw' (raw
   point name columns). Updates the toggle button label/style and re-renders
   the table. Also shows/hides the appropriate column-toggle controls.    */
function emToggleViewMode() {
  _emDrillBuilding = null;
  _emViewMode = _emViewMode === 'audit' ? 'raw' : 'audit';
  var btn = document.getElementById('em-view-mode-btn');
  if (btn) {
    if (_emViewMode === 'audit') {
      btn.textContent = 'Audit View';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
    } else {
      btn.textContent = 'Raw View';
      btn.style.background = 'var(--s2)';
      btn.style.color = 'var(--text2)';
      btn.style.borderColor = 'var(--border)';
    }
  }
  emSyncViewModeControls();
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

/* ── emSetSummaryView ───────────────────────────────────────────────────────
   Activates the Summary view mode. Separate button (not part of the
   Audit/Raw toggle cycle) so neither existing toggle is disrupted.       */
function emSetSummaryView() {
  _emDrillBuilding = null;
  if (_emViewMode === 'summary') {
    // Clicking Summary again returns to Audit View
    _emViewMode = 'audit';
  } else {
    _emViewMode = 'summary';
  }
  emSyncViewModeControls();
  var data = emLoadMatrix(window._emActivePid);
  emRenderTable(data, _emFilters);
}

/* ── emDrillBuilding ────────────────────────────────────────────────────────
   Enters per-building detail view within the Summary view.
   Sets _emDrillBuilding to the building name and re-renders.             */
function emDrillBuilding(pid, buildingName) {
  _emDrillBuilding = buildingName;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  emRenderTable(data, _emFilters);
}

/* ── emExitDrillBuilding ────────────────────────────────────────────────────
   Exits per-building detail view and returns to the summary table.       */
function emExitDrillBuilding(pid) {
  _emDrillBuilding = null;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  emRenderTable(data, _emFilters);
}

/* ── emSyncViewModeControls ─────────────────────────────────────────────────
   Shows/hides toolbar controls based on current _emViewMode.             */
function emSyncViewModeControls() {
  var rawToggles = document.getElementById('em-raw-col-toggles');
  var dynControls = document.getElementById('em-dyn-col-controls');
  var auditInfo = document.getElementById('em-audit-col-info');
  var summaryBtn = document.getElementById('em-summary-btn');
  var viewModeBtn = document.getElementById('em-view-mode-btn');
  if (_emViewMode === 'audit') {
    if (rawToggles) rawToggles.style.display = 'none';
    if (dynControls) dynControls.style.display = 'none';
    if (auditInfo) auditInfo.style.display = 'inline-flex';
    if (viewModeBtn) {
      viewModeBtn.textContent = 'Audit View';
      viewModeBtn.style.background = 'var(--accent)';
      viewModeBtn.style.color = '#fff';
      viewModeBtn.style.borderColor = 'transparent';
    }
    if (summaryBtn) {
      summaryBtn.style.background = 'var(--s2)';
      summaryBtn.style.color = 'var(--text2)';
      summaryBtn.style.borderColor = 'var(--border)';
    }
  } else if (_emViewMode === 'summary') {
    if (rawToggles) rawToggles.style.display = 'none';
    if (dynControls) dynControls.style.display = 'none';
    if (auditInfo) auditInfo.style.display = 'none';
    if (viewModeBtn) {
      viewModeBtn.textContent = 'Audit View';
      viewModeBtn.style.background = 'var(--s2)';
      viewModeBtn.style.color = 'var(--text2)';
      viewModeBtn.style.borderColor = 'var(--border)';
    }
    if (summaryBtn) {
      summaryBtn.style.background = 'var(--accent)';
      summaryBtn.style.color = '#fff';
      summaryBtn.style.borderColor = 'transparent';
    }
  } else {
    // raw mode
    if (rawToggles) rawToggles.style.display = 'inline-flex';
    if (dynControls) dynControls.style.display = 'inline-flex';
    if (auditInfo) auditInfo.style.display = 'none';
    if (viewModeBtn) {
      viewModeBtn.textContent = 'Raw View';
      viewModeBtn.style.background = 'var(--s2)';
      viewModeBtn.style.color = 'var(--text2)';
      viewModeBtn.style.borderColor = 'var(--border)';
    }
    if (summaryBtn) {
      summaryBtn.style.background = 'var(--s2)';
      summaryBtn.style.color = 'var(--text2)';
      summaryBtn.style.borderColor = 'var(--border)';
    }
  }
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

// Parse a WebCTRL Control Program name.
// Returns { location, equipName }
// Auto-detects two naming conventions:
//   Standard WebCTRL: "{Location/Area} - {Equipment Name}" (e.g. "Supply Duct - Air Handling Unit B1")
//   JOCO-style:       "{Equipment Type} - {Building Abbr}" (e.g. "Cooling Towers - ADC")
// Detection: if the part BEFORE the first " - " classifies to a known equipment type,
// it is JOCO-style and the assignment is flipped (equipName=first, location=second).
function emParseControlProgram(cpStr) {
  if (!cpStr) return { location: '', equipName: cpStr || '' };
  var idx = cpStr.indexOf(' - ');
  if (idx === -1) return { location: '', equipName: cpStr.trim() };
  var firstPart = cpStr.slice(0, idx).trim();
  var secondPart = cpStr.slice(idx + 3).trim();
  // If the first segment is a recognizable equipment type, this is JOCO-style naming.
  // isKnownType triggers on HVAC types (non-'other' classification) AND on known non-HVAC
  // program types that legitimately use the "Type - Building" JOCO naming pattern.
  var firstCategory = emClassifyEquipType(firstPart);
  var isKnownType =
    firstCategory !== 'other' ||
    /^(smoke|environmental|exhaust|weather|fire|generator|elevator|irrigation)/i.test(firstPart);
  if (isKnownType) {
    return { location: secondPart, equipName: firstPart };
  }
  // Standard WebCTRL style: location before the dash, equipment name after
  return { location: firstPart, equipName: secondPart };
}

function emParseLocation(locString) {
  if (!locString) return { floor: '', area: '' };
  var s = locString.trim();
  var floorMatch =
    s.match(/(\d+(?:st|nd|rd|th)?\s*floor)/i) ||
    s.match(/\b((?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor)\b/i) ||
    s.match(/\b(ground\s+(?:floor|level))\b/i) ||
    s.match(/\b(penthouse|rooftop|roof|basement|mezzanine|lobby)\b/i);
  var floor = floorMatch ? floorMatch[1] : '';
  var area = s;
  return { floor: floor, area: area };
}

/* ── emIsFloorSegment ───────────────────────────────────────────────────────
   Returns true if the string looks like a genuine floor/level identifier.
   Used to validate BACnet path segments before assigning them to the Floor
   column — prevents equipment category nodes ("Lighting", "Environmental Index")
   from appearing in the Floor column.                                        */
function emIsFloorSegment(str) {
  if (!str) return false;
  var s = str.trim();
  if (!s) return false;

  // Reject anything that contains known equipment keywords
  if (
    /\b(lighting|smoke|environmental|monitor|rtu|ahu|vav|boiler|chiller|exhaust|fan|pump|elevator|generator|weather|fire|irrigation|transfer|metering|erv|hrv|doas|mau|fcu|ftu|fpb|plant|station|domestic|exterior|interior)\b/i.test(
      s,
    )
  )
    return false;

  // Reject if it matches any key in EM_EQUIP_TYPES (after lowercasing)
  var lc = s.toLowerCase();
  if (lc in EM_EQUIP_TYPES) return false;

  // Accept: purely numeric (e.g. "1", "2", "01")
  if (/^\d+$/.test(s)) return true;

  // Accept: ordinal patterns — "1st", "2nd", "3rd", "4th", "5th" etc.
  if (/^\d+(st|nd|rd|th)$/i.test(s)) return true;

  // Accept: contains a number AND a floor/level/area/zone/wing keyword
  if (/\d/.test(s) && /\b(floor|level|area|wing|zone)\b/i.test(s)) return true;

  // Accept: named floor concepts (including text-ordinal standalone words and multi-word phrases)
  if (/\b(basement|ground|mezzanine|penthouse|rooftop|roof|attic|lobby)\b/i.test(s)) return true;

  // Accept: "Ground Level" as a phrase
  if (/\bground\s+level\b/i.test(s)) return true;

  // Accept: single-letter + number or number + single-letter (e.g. "A1", "1A", "B2")
  if (/^[A-Za-z]\d+$/.test(s) || /^\d+[A-Za-z]$/.test(s)) return true;

  // Accept: ordinal text combined with "floor" (e.g. "First Floor", "Second Floor")
  if (/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor\b/i.test(s)) return true;

  return false;
}

/* ── emClassifyEquipType ────────────────────────────────────────────────────
   Maps an equipment type string (from CSV "Equipment Type" or control program
   name) to one of the internal category keys: ahu, vav, fpb, ddvav, hwp,
   chwp, ct, or 'other'.

   Steps (in order):
   A. Strip leading manufacturer name if present
   B. Exact lookup in EM_EQUIP_TYPES
   C. Substring scan of EM_EQUIP_TYPES keys
   D. Regex pattern fallbacks (expanded)
   E. Fuzzy keyword scan as last resort                                     */
function emClassifyEquipType(equipTypeStr) {
  if (!equipTypeStr) return 'other';
  var raw = equipTypeStr.trim();

  // ── A. Strip leading manufacturer names ──
  var mfgPattern =
    /^(?:trane|carrier|lennox|york|daikin|mcquay|rheem|ruud|heil|bard|aaon|mammoth|reznor|modine|lochinvar|honeywell|johnson controls|siemens|schneider|alc|automated logic)\s+/i;
  var stripped = raw.replace(mfgPattern, '');

  var key = stripped.toLowerCase();

  // ── B. Exact lookup ──
  if (key in EM_EQUIP_TYPES) return EM_EQUIP_TYPES[key];

  // ── C. Substring scan of EM_EQUIP_TYPES keys ──
  for (var pattern in EM_EQUIP_TYPES) {
    if (key.indexOf(pattern) !== -1) return EM_EQUIP_TYPES[pattern];
  }

  // ── D. Regex fallbacks (expanded) ──
  if (/\bahu\b|air.?handl/i.test(key)) return 'ahu';
  if (/\brtu\b/i.test(key)) return 'ahu';
  if (/\bmau\b/i.test(key)) return 'ahu';
  if (/\bdoas\b/i.test(key)) return 'ahu';
  if (/\berv\b/i.test(key)) return 'ahu';
  if (/\bhrv\b/i.test(key)) return 'ahu';
  if (/\bfcu\b/i.test(key)) return 'ahu';
  if (/\bcrac\b/i.test(key)) return 'ahu';
  if (/\bcrah\b/i.test(key)) return 'ahu';
  if (/roof.?top/i.test(key)) return 'ahu';
  if (/make.?up.?air/i.test(key)) return 'ahu';
  if (/heat.?pump/i.test(key)) return 'ahu';
  if (/\bwshp\b/i.test(key)) return 'ahu';
  if (/\bgshp\b/i.test(key)) return 'ahu';
  if (/split.?system/i.test(key)) return 'ahu';
  if (/vav|variable.?air.?vol/i.test(key)) return 'vav';
  if (/\bvas[\s\-]?\d/i.test(key)) return 'vav';
  if (/\bfpb\b/i.test(key)) return 'fpb';
  if (/fan.?pow|parallel.?fan|\bfpt\b/i.test(key)) return 'fpb';
  if (/fan.?power/i.test(key)) return 'fpb';
  if (/\bftu\b/i.test(key)) return 'fpb';
  if (/dual.?duct|ddvav/i.test(key)) return 'ddvav';
  if (/\bboiler\b/i.test(key)) return 'hwp';
  if (/\bhwp\b/i.test(key)) return 'hwp';
  if (/\bblr\b/i.test(key)) return 'hwp';
  if (/\bfurnace\b/i.test(key)) return 'hwp';
  if (/unit.?heater/i.test(key)) return 'hwp';
  if (/\buh[\-\s]?\d/i.test(key)) return 'hwp';
  if (/hot.?water.*boil/i.test(key)) return 'hwp';
  if (/heating.?water/i.test(key)) return 'hwp';
  if (/\bchiller\b/i.test(key)) return 'chwp';
  if (/\bchwp\b/i.test(key)) return 'chwp';
  if (/chilled.?water/i.test(key)) return 'chwp';
  if (/chill|chw.*plant/i.test(key)) return 'chwp';
  if (/cool.*tower/i.test(key)) return 'ct';
  if (/\bcwp\b/i.test(key)) return 'ct';
  // Lighting
  if (/\blighting\b/i.test(key)) return 'lighting';
  // Smoke damper — explicitly 'other' but recognized for JOCO-style flip
  if (/smoke.?damper/i.test(key)) return 'other';

  // ── E. Fuzzy keyword scan (last resort) ──
  var fuzzyMap = [
    ['ahu', 'ahu'],
    ['rtu', 'ahu'],
    ['vav', 'vav'],
    ['chiller', 'chwp'],
    ['boiler', 'hwp'],
    ['cooling tower', 'ct'],
    ['pump', 'hwp'],
    ['fan coil', 'ahu'],
    ['rooftop', 'ahu'],
    ['air handler', 'ahu'],
    ['lighting', 'lighting'],
  ];
  for (var fi = 0; fi < fuzzyMap.length; fi++) {
    if (key.indexOf(fuzzyMap[fi][0]) !== -1) return fuzzyMap[fi][1];
  }

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
      // Extract floor from BACnet path — use the last segment after the building level.
      // This handles variable-depth paths: standard 3-segment paths are unaffected;
      // 4-segment paths like /Org/Building/Station/Floor correctly use the last segment.
      var bacnetParts = bacnetPath.replace(/^\//, '').split('/');
      // Left-to-right scan from index 2 (after project and building).
      // Takes the first segment that passes emIsFloorSegment(), so a real floor
      // at index 2 is found even when a sub-node at index 3+ is an equipment category.
      var wfloor = '';
      for (var si = 2; si < bacnetParts.length; si++) {
        if (bacnetParts[si] && emIsFloorSegment(bacnetParts[si].trim())) {
          wfloor = bacnetParts[si].trim();
          break;
        }
      }
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
  return DB.get('en_eqmatrix_cols_' + projId, []);
}
function emSaveCustomCols(projId, cols) {
  DB.set('en_eqmatrix_cols_' + projId, cols);
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
  // '__preview__' is an in-memory-only sentinel — return the preview data without touching the DB
  if (projId === '__preview__') return window._emPreviewData || { rows: [], importedAt: null, buildings: [] };
  return sget('en_eqmatrix_' + projId, { rows: [], importedAt: null, buildings: [] });
}

function emSaveMatrix(projId, data) {
  if (!projId) return;
  // Invalidate caches — data may have changed (edits, imports, deletions)
  _emComplianceCache = {};
  _emNormCache = new Map();
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
  // ── Sort rows alphabetically by building, then by equipment name ──
  merged.sort(function (a, b) {
    var ab = (a.building || '').toLowerCase();
    var bb = (b.building || '').toLowerCase();
    if (ab < bb) return -1;
    if (ab > bb) return 1;
    var ae = (a.equipName || '').toLowerCase();
    var be = (b.equipName || '').toLowerCase();
    return ae < be ? -1 : ae > be ? 1 : 0;
  });

  var buildings = [];
  var bldgSeen = {};
  for (var n = 0; n < merged.length; n++) {
    if (!bldgSeen[merged[n].building]) {
      buildings.push(merged[n].building);
      bldgSeen[merged[n].building] = true;
    }
  }
  // ── Sort buildings list alphabetically ──
  buildings.sort(function (a, b) {
    return (a || '').toLowerCase() < (b || '').toLowerCase() ? -1 : 1;
  });

  return { rows: merged, importedAt: new Date().toISOString(), buildings: buildings };
}

/* ── PHASE 3: VIEW SCAFFOLD ── */

var _emPendingFiles = [];
var _emImportMode = 'merge'; // 'merge' = add to existing data; 'replace' = clear and reimport
var _emSortCol = null;
var _emSortDir = 1;
var _emFilters = { building: '', type: '', search: '' };
var _emDrillBuilding = null; // null = summary table; string = per-building detail view
var _emHiddenGroups = {};
var EM_PAGE_SIZE = 100;
var _emCurrentPage = 0;
var _emPageSize = 100;
var _emShowAllDynCols = false; // when false, limit dynamic point columns to top 20 by frequency
var EM_DYN_COL_LIMIT = 20; // max dynamic point columns shown by default
var _emViewMode = 'audit'; // 'audit' = ASHRAE 36 compliance columns; 'raw' = raw point columns; 'summary' = aggregated card view
var _emZoomLevel = 100; // zoom percentage, 50–150
var _emComplianceCache = {}; // Performance: module-level compliance result cache, keyed by row.id
var _emNormCache = new Map(); // Performance: memoized emNormalizePoint results, keyed by rawName+'\0'+category
var _emSearchTimer = null; // Performance: debounce timer for search input
function emDebouncedSearch() {
  clearTimeout(_emSearchTimer);
  _emSearchTimer = setTimeout(emApplyFilters, 200);
}

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
    '.em-table-wrap { overflow: scroll; scrollbar-gutter: stable both-edges; isolation: isolate; }',
    '.em-table-wrap::-webkit-scrollbar { height: 14px; width: 14px; }',
    '.em-table-wrap::-webkit-scrollbar-thumb { background: var(--s4); border-radius: 7px; border: 3px solid var(--s2); }',
    '.em-table-wrap::-webkit-scrollbar-track { background: var(--s1); }',
    // All cells get right + bottom borders for a full grid
    '.em-table-wrap td, .em-table-wrap th { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }',
    // Frozen column base styles — left: values are set dynamically by emUpdateStickyOffsets()
    '.em-table-wrap td.em-frozen, .em-table-wrap th.em-frozen { position: sticky; background: var(--s2); z-index: 10; }',
    // Frozen header corners need higher z-index so they sit above both sticky header and sticky column
    '.em-table-wrap thead th.em-frozen { z-index: 12; }',
    // Non-frozen headers stay at z-index 11 (above body, horizontally scrollable)
    '.em-table-wrap thead th { position: sticky; top: 0; background: var(--s2); z-index: 11; }',
    // Resize cursor hint — applied to th when hovering near right edge (set via JS)
    '.em-table-wrap th.em-col-resizing { cursor: col-resize; user-select: none; }',
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * emUpdateStickyOffsets — Computes and sets inline left: positions on the 3 frozen columns.
 * Called after every table render and after column resize. Handles edit mode (extra delete col).
 *
 * In normal mode: columns 0, 1, 2 (Building, Floor, Equipment) are frozen.
 * In edit mode: column 0 is the delete button; columns 1, 2, 3 (Building, Floor, Equipment) are frozen.
 * We freeze whichever columns those are (always 3 data columns + delete button if present).
 */
function emUpdateStickyOffsets() {
  var wrap = document.getElementById('em-table-wrap');
  if (!wrap) return;
  var table = wrap.querySelector('table');
  if (!table) return;

  // Determine if edit mode is active by checking for the delete button column in the first body row
  var firstBodyRow = table.querySelector('tbody tr');
  var hasDelCol = false;
  if (firstBodyRow) {
    var firstCell = firstBodyRow.cells[0];
    if (firstCell && firstCell.querySelector('button')) hasDelCol = true;
  }

  // Number of frozen columns: always 3 data columns. In edit mode, also freeze the delete col.
  var frozenCount = hasDelCol ? 4 : 3;

  // Collect all rows (thead + tbody)
  var allRows = [];
  var theadRows = table.querySelectorAll('thead tr');
  var tbodyRows = table.querySelectorAll('tbody tr');
  for (var i = 0; i < theadRows.length; i++) allRows.push(theadRows[i]);
  for (var j = 0; j < tbodyRows.length; j++) allRows.push(tbodyRows[j]);

  if (allRows.length === 0) return;

  // Read actual cell widths from first row to compute cumulative offsets
  var firstRow = allRows[0];
  var offsets = [0]; // offsets[n] = left position for column n
  for (var c = 0; c < frozenCount - 1; c++) {
    var cell = firstRow.cells[c];
    if (!cell) break;
    offsets.push(offsets[c] + cell.offsetWidth);
  }

  // Apply frozen class and left: style to every row
  for (var r = 0; r < allRows.length; r++) {
    var row = allRows[r];
    var isHeadRow = row.parentNode && row.parentNode.nodeName === 'THEAD';
    for (var col = 0; col < frozenCount; col++) {
      var td = row.cells[col];
      if (!td) continue;
      td.classList.add('em-frozen');
      td.style.left = (offsets[col] || 0) + 'px';
      // Ensure top:0 on header frozen cells
      if (isHeadRow) td.style.top = '0px';
    }
  }
}

function emRenderMatrix(container, data, pid) {
  window._emActivePid = pid;
  if (!data.edits) data.edits = {};
  _emFilters = { building: '', type: '', search: '' };
  _emSortCol = null;
  _emSortDir = 1;
  _emHiddenGroups = { asset: true }; // asset columns (Serial#, Model#, Manufacturer, Size/Capacity) hidden by default
  _emEditMode = false;
  _emCurrentPage = 0;
  _emPageSize = EM_PAGE_SIZE;
  _emShowAllDynCols = false;
  _emViewMode = 'audit';
  var savedZoom = parseInt(DB.get('en_em_zoom', '100'), 10);
  _emZoomLevel = savedZoom >= 50 && savedZoom <= 150 ? savedZoom : 100;
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
    '<div id="em-stats-bar" style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--s1);flex-shrink:0">' +
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
    '<div id="em-upload-inline" style="display:none;flex-shrink:0;border-bottom:1px solid var(--border);padding:16px 20px"></div>' +
    '<div id="em-table-wrap" class="em-table-wrap" style="flex:1;min-height:0"></div>' +
    '</div>';

  emRenderTable(data, _emFilters);
  // Apply persisted zoom (no-op at 100% but sets up the style tag consistently)
  emSetZoom(0);
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

function emShowUploadPanel(btn, mode, pid) {
  var resolvedMode = mode || 'merge';
  // Resolve the target pid: prefer the explicit argument, fall back to window._emActivePid.
  // Guard: never allow __preview__ or falsy as the import target.
  var resolvedPid = pid || window._emActivePid;
  if (!resolvedPid || resolvedPid === '__preview__') {
    showToast('No project selected — please select a project before importing CSVs', 'warn');
    return;
  }

  // If the modal is already open, close it (toggle behaviour)
  var existing = document.getElementById('em-upload-modal-backdrop');
  if (existing) {
    emCloseUploadModal(btn, resolvedMode);
    return;
  }

  // Re-Import mode requires confirmation before opening the panel
  if (resolvedMode === 'replace') {
    if (!confirm('This will replace all existing equipment data for this project. Continue?')) return;
  }
  _emImportMode = resolvedMode;
  // Lock in the target pid at panel-open time so file-drop cannot use a stale pid
  _emUploadTargetPid = resolvedPid;

  // Build a fixed-position backdrop + modal panel so it is immune to overflow:clip clipping
  var backdrop = document.createElement('div');
  backdrop.id = 'em-upload-modal-backdrop';
  backdrop.style.cssText =
    'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding-top:70px';
  // Click on backdrop (not on the panel) closes the modal
  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) emCloseUploadModal(btn, resolvedMode);
  });

  var panel = document.createElement('div');
  panel.id = 'em-upload-modal-panel';
  panel.style.cssText =
    'background:var(--s1);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.28);width:600px;max-width:calc(100vw - 32px);z-index:9999;overflow:hidden';

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  emRenderUploadPanel(panel, resolvedPid, true);
  btn.textContent = 'Cancel';
}

function emCloseUploadModal(btn, resolvedMode) {
  _emUploadTargetPid = null;
  var backdrop = document.getElementById('em-upload-modal-backdrop');
  if (backdrop) backdrop.parentNode.removeChild(backdrop);
  if (btn) btn.textContent = resolvedMode === 'replace' ? 'Re-Import CSVs' : 'Import CSVs';
}

/* ── PHASE 4: TOOLBAR & TABLE ── */

function emRenderToolbar(data, pid, projBadge) {
  var buildings = (data.buildings || []).slice().sort(function (a, b) {
    return (a || '').toLowerCase() < (b || '').toLowerCase() ? -1 : 1;
  });

  // Phase 4: count equipment per building for the filter dropdown labels
  var equipCountPerBldg = {};
  var totalEquip = 0;
  var rows = data.rows || [];
  for (var rci = 0; rci < rows.length; rci++) {
    var bname = rows[rci].building || '';
    if (bname) {
      equipCountPerBldg[bname] = (equipCountPerBldg[bname] || 0) + 1;
      totalEquip++;
    }
  }

  var bldgOpts = '<option value="">All Buildings (' + totalEquip + ' equipment)</option>';
  for (var i = 0; i < buildings.length; i++) {
    var bCount = equipCountPerBldg[buildings[i]] || 0;
    bldgOpts +=
      '<option value="' + buildings[i].replace(/"/g, '&quot;') + '">' + buildings[i] + ' (' + bCount + ')</option>';
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
    '<div id="em-col-toggles" style="display:flex;align-items:center;gap:6px;padding:4px 16px 6px;flex-wrap:wrap;border-top:1px solid var(--border)">' +
    // Raw-view-only toggles (hidden in audit mode)
    '<span id="em-raw-col-toggles" style="display:none;align-items:center;gap:6px">' +
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
    '<label style="' +
    colToggleStyle +
    '"><input type="checkbox" onchange="emToggleColGroup(\'asset\',this.checked)" style="margin:0"> Asset Details</label>' +
    '</span>' +
    // Raw-mode dynamic point column controls
    '<span id="em-dyn-col-controls" style="display:none;margin-left:8px;border-left:1px solid var(--border);padding-left:8px;align-items:center;gap:4px">' +
    '<span id="em-dyn-col-info" style="font-size:10px;color:var(--text3)"></span>' +
    '<button id="em-dyn-col-toggle" onclick="emToggleAllDynCols()" ' +
    'style="font-size:10px;padding:2px 8px;background:var(--s3);border:1px solid var(--border);color:var(--text2);border-radius:3px;cursor:pointer;height:20px;line-height:1">' +
    'Show All Point Columns' +
    '</button>' +
    '</span>' +
    // Audit-view legend bar — always visible in audit mode, shows all cell state symbols
    '<span id="em-audit-col-info" style="display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--text3)">' +
    '<span title="BAS point present — showing live value. Green background = automatic match" style="padding:1px 6px;border-radius:3px;background:rgba(39,174,96,0.15);color:#27ae60;font-weight:600">Yes</span>' +
    '<span title="Similar point found — showing live value. Amber background = lower confidence match" style="padding:1px 6px;border-radius:3px;background:rgba(230,126,34,0.15);color:#e67e22;font-weight:600">Fuzzy</span>' +
    '<span title="Required ASHRAE 36 point not found in BAS" style="padding:1px 6px;border-radius:3px;background:rgba(192,57,43,0.15);color:#c0392b;font-weight:600">No</span>' +
    '<span title="Not applicable to this equipment type" style="padding:1px 6px;border-radius:3px;background:rgba(128,128,128,0.08);color:var(--text3)">N/A</span>' +
    '<span title="Optional point — not present in BAS data" style="padding:1px 6px;border-radius:3px;background:rgba(128,128,128,0.05);color:var(--text3)">--</span>' +
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
    '<input id="em-filter-search" type="text" placeholder="Search..." oninput="emDebouncedSearch()" style="font-size:11px;padding:4px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:28px;width:140px">' +
    '<span id="em-row-count" style="font-size:11px;color:var(--text3);margin-left:4px"></span>' +
    '<div style="flex:1"></div>' +
    (projBadge || '') +
    '<button id="em-view-mode-btn" class="btn btn-sm" onclick="emToggleViewMode()" style="height:28px;font-size:11px;background:var(--accent);color:#fff;border-color:transparent">Audit View</button>' +
    '<button id="em-summary-btn" class="btn btn-ghost btn-sm" onclick="emSetSummaryView()" title="Aggregated stats grouped by building and equipment type" style="height:28px;font-size:11px;background:var(--s2);color:var(--text2);border-color:var(--border)">Summary</button>' +
    '<button id="em-edit-mode-btn" class="btn btn-ghost btn-sm" onclick="emToggleEditMode(this)" style="height:28px;font-size:11px">Edit</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emHandleSaveEdits()" style="height:28px;font-size:11px">Save Edits</button>' +
    '<button id="em-delete-all-btn" class="btn btn-ghost btn-sm" onclick="emDeleteAllRows(\'' +
    pid +
    '\')" style="height:28px;font-size:11px;display:none;background:#fee2e2;border-color:#fca5a5;color:#b91c1c">Delete All</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emHandleExportCSV()" style="height:28px;font-size:11px">Export CSV</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emAddManualRow(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">+ Add Row</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emAddCustomCol(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">+ Column</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emShowUploadPanel(this,\'merge\',\'' +
    pid +
    '\')" style="height:28px;font-size:11px">Import CSVs</button>' +
    (data.rows && data.rows.length > 0
      ? '<button class="btn btn-ghost btn-sm" onclick="emShowUploadPanel(this,\'replace\',\'' +
        pid +
        '\')" style="height:28px;font-size:11px;color:#b45309;border-color:#d97706">Re-Import CSVs</button>'
      : '') +
    (data.rows && data.rows.length > 0
      ? '<button class="btn btn-ghost btn-sm" onclick="emOpenManageMappings(\'' +
        pid +
        '\')" style="height:28px;font-size:11px">Manage Mappings</button>'
      : '') +
    '<button class="btn btn-sm" onclick="emCopyFromProject(\'' +
    pid +
    '\')" style="height:28px;font-size:11px">Copy From Project</button>' +
    '<span style="width:1px;height:20px;background:var(--border);display:inline-block;margin:0 4px;vertical-align:middle"></span>' +
    (data.buildings && data.buildings.length > 0
      ? '<button class="btn btn-ghost btn-sm" onclick="emOpenCreateBldgsModal(\'' +
        pid +
        '\')" style="height:28px;font-size:11px">+ Create Buildings</button>'
      : '') +
    (data.rows && data.rows.length > 0
      ? '<button class="btn btn-sm" onclick="openASHRAE36ReportModal(\'' +
        pid +
        '\',\'audit\')" style="height:28px;font-size:11px;background:var(--rpt-blue,#1e40af);color:#fff;border-color:transparent">Audit Report</button>' +
        '<button class="btn btn-sm" onclick="openASHRAE36ReportModal(\'' +
        pid +
        '\',\'proposal\')" style="height:28px;font-size:11px;background:#7c3aed;color:#fff;border-color:transparent">Service Proposal</button>'
      : '') +
    '<span style="width:1px;height:20px;background:var(--border);display:inline-block;margin:0 4px;vertical-align:middle"></span>' +
    '<div style="display:inline-flex;align-items:center;gap:2px">' +
    '<button onclick="emSetZoom(-10)" style="height:28px;width:24px;font-size:13px;line-height:1;background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer;padding:0" title="Zoom out">−</button>' +
    '<span id="em-zoom-label" style="font-size:11px;color:var(--text2);min-width:38px;text-align:center;user-select:none">' +
    _emZoomLevel +
    '%</span>' +
    '<button onclick="emSetZoom(10)" style="height:28px;width:24px;font-size:13px;line-height:1;background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer;padding:0" title="Zoom in">+</button>' +
    '</div>' +
    '</div>' +
    colToggles +
    '</div>'
  );
}

/**
 * emSetZoom — Adjusts the table zoom level by `delta` percent (e.g. +10 or -10).
 * Clamped to 50–150. Applies font-size and padding scaling to .em-table-wrap
 * proportionally: at 100% font-size is 11px and cell padding is 4px 8px.
 * Persists the choice to IndexedDB as `en_em_zoom`.
 */
function emSetZoom(delta) {
  _emZoomLevel = Math.min(150, Math.max(50, _emZoomLevel + delta));
  DB.set('en_em_zoom', String(_emZoomLevel));

  var wrap = document.getElementById('em-table-wrap');
  if (wrap) {
    var ratio = _emZoomLevel / 100;
    var tdFs = Math.round(11 * ratio);
    var thFs = Math.round(10 * ratio);
    var tdPadV = Math.round(4 * ratio);
    var tdPadH = Math.round(8 * ratio);
    var thPadV = Math.round(6 * ratio);
    var thPadH = Math.round(8 * ratio);
    // Apply to all td and th inside the table wrap via a dynamic style tag.
    // Separate rules so th (10px/6px 8px base) and td (11px/4px 8px base) scale correctly.
    var styleEl = document.getElementById('em-zoom-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'em-zoom-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      '#em-table-wrap td { font-size: ' +
      tdFs +
      'px; padding: ' +
      tdPadV +
      'px ' +
      tdPadH +
      'px; } ' +
      '#em-table-wrap th { font-size: ' +
      thFs +
      'px; padding: ' +
      thPadV +
      'px ' +
      thPadH +
      'px; }';
  }

  var label = document.getElementById('em-zoom-label');
  if (label) label.textContent = _emZoomLevel + '%';

  // Column widths change with font-size — recompute sticky offsets
  emUpdateStickyOffsets();
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
  // Asset Details (hidden by default — enable via "Asset Details" toggle)
  // Serial #, Model #, Manufacturer, Size/Capacity are excluded from default view
  defs.push({ key: 'serial', label: 'Serial #', group: 'asset', width: 120 });
  defs.push({ key: 'model', label: 'Model #', group: 'asset', width: 120 });
  defs.push({ key: 'manufacturer', label: 'Manufacturer', group: 'asset', width: 140 });
  defs.push({ key: 'sizeCapacity', label: 'Size/Capacity', group: 'asset', width: 120 });
  // Physical Attributes (remaining)
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

/* ── emGetAuditColDefs ──────────────────────────────────────────────────────
   Returns column definitions for Audit View mode.
   Frozen columns: Building, Floor, Equipment Name (same as raw).
   Then: Equipment Type, Coverage %, Total BAS Points.
   Then: One column per required point category, derived from EM_POINT_CATEGORIES
   for the equipment types actually present in the filtered rows.

   equipTypes = array of unique category strings present in the data/filter.
   When multiple equipment types are visible ("All Types"), the UNION of all
   required categories is shown. Cells are blank/gray for non-applicable types.  */
function emGetAuditColDefs(filteredRows) {
  // Collect the equipment types present in these rows
  var typeSet = {};
  for (var ri = 0; ri < filteredRows.length; ri++) {
    var cat = filteredRows[ri].category;
    if (cat && EM_POINT_CATEGORIES[cat]) typeSet[cat] = true;
  }
  var equipTypes = Object.keys(typeSet);

  // If only one equipment type is selected, use its categories only.
  // Otherwise, take the UNION of all required point categories across present types.
  // Track which equipment types each category applies to for gray-out logic.
  var categoryMap = {}; // key -> { key, label, equipTypes: [] }
  for (var ti = 0; ti < equipTypes.length; ti++) {
    var et = equipTypes[ti];
    var cats = EM_POINT_CATEGORIES[et] || [];
    for (var ci = 0; ci < cats.length; ci++) {
      var c = cats[ci];
      if (!categoryMap[c.key]) {
        categoryMap[c.key] = {
          key: c.key,
          label: c.label,
          equipTypes: [],
          required: c.required,
          configFlag: c.configFlag || null,
        };
      }
      if (categoryMap[c.key].equipTypes.indexOf(et) === -1) {
        categoryMap[c.key].equipTypes.push(et);
      }
    }
  }

  // Build defs array
  var defs = [
    { key: 'building', label: 'Building', group: 'id', width: 180 },
    { key: 'floor', label: 'Floor', group: 'id', width: 80 },
    { key: 'equipName', label: 'Equipment Name', group: 'id', width: 200 },
    {
      key: 'category',
      label: 'Equipment Type',
      group: 'audit',
      width: 120,
      isAuditType: true,
      title: 'ASHRAE 36 equipment category used to determine compliance requirements',
    },
    {
      key: '_coverage',
      label: 'Coverage %',
      group: 'audit',
      width: 90,
      isAuditCoverage: true,
      title:
        'Percentage of required ASHRAE 36 BAS points present for this equipment. Click a cell for details. N/A = no requirements for this type.',
    },
    {
      key: '_baspoints',
      label: 'Total BAS Points',
      group: 'audit',
      width: 110,
      isAuditBasPts: true,
      title: 'Total number of BAS data points found in the imported CSV for this equipment',
    },
  ];

  // Add one column per point category (required and optional)
  var catKeys = Object.keys(categoryMap);
  for (var ki = 0; ki < catKeys.length; ki++) {
    var cd = categoryMap[catKeys[ki]];
    var reqLabel = cd.required ? 'Required' : 'Optional';
    var appliesToLabel = cd.equipTypes
      .map(function (t) {
        return t.toUpperCase();
      })
      .join(', ');
    defs.push({
      key: '_cat_' + cd.key,
      label: cd.label,
      group: 'audit-cat',
      width: 110,
      isAuditCat: true,
      catKey: cd.key,
      catEquipTypes: cd.equipTypes,
      catRequired: cd.required,
      catConfigFlag: cd.configFlag,
      title:
        reqLabel +
        ' ASHRAE 36 point — applies to: ' +
        appliesToLabel +
        '. Yes = present, Fuzzy = fuzzy match, No = missing, N/A = not applicable.',
    });
  }

  // Add one column per relevant ASHRAE 36 sequence (Sequences group)
  // Only include sequences that apply to at least one equipment type visible in the filtered rows
  var seqTypeSet = typeSet; // reuse the type set already built above
  for (var sdi = 0; sdi < EM_SEQUENCE_DEFS.length; sdi++) {
    var seqDef = EM_SEQUENCE_DEFS[sdi];
    // Check if any of this sequence's equipTypes are in the visible set
    var seqVisible = false;
    for (var sti = 0; sti < seqDef.equipTypes.length; sti++) {
      if (seqTypeSet[seqDef.equipTypes[sti]]) {
        seqVisible = true;
        break;
      }
    }
    if (!seqVisible) continue;
    defs.push({
      key: '_seq_' + seqDef.key,
      label: seqDef.label,
      group: 'audit-seq',
      width: 100,
      isAuditSeq: true,
      seqKey: seqDef.key,
      seqEquipTypes: seqDef.equipTypes,
      title:
        seqDef.label +
        ' sequence (' +
        seqDef.ashrae36 +
        '). Yes = ready (all points present), Partial = partial, No = blocked (key points missing), N/A = not applicable.',
    });
  }

  // "Behavior" column — BAS trend behavioral check verdict for this equipment.
  // Only shown when bas-trends.js is loaded (btGetBuildingBehaviorSummary exists).
  // PASS = all checks pass, WARN = warnings present, FAIL = checks failed, No Data = no trend import.
  defs.push({
    key: '_behavior',
    label: 'Behavior',
    group: 'audit-behavior',
    width: 90,
    isAuditBehavior: true,
    title:
      'BAS trend behavioral verification — whether the ASHRAE 36 sequences are actually running correctly based on measured trend data. ' +
      'PASS = all checks passed, WARN = warnings, FAIL = checks failed, No Data = no trend data uploaded. ' +
      'Upload trend CSVs via the BAS Trends view to populate this column.',
  });

  return defs;
}

/* ── emComputeAuditStats ────────────────────────────────────────────────────
   Compute average compliance % and total BAS point count across all rows.
   Returns: { avgCoverage: number, totalBASPoints: number }              */
function emComputeAuditStats(rows) {
  var totalPts = 0;
  var totalCoverage = 0;
  var covCount = 0;
  var _auditStatsMaps = emLoadCustomMappings(window._emActivePid || '');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var pts = r.points || {};
    totalPts += Object.keys(pts).length;
    if (r.category && EM_POINT_CATEGORIES[r.category]) {
      var compliance = emComputeCompliance(r, {}, _auditStatsMaps);
      totalCoverage += compliance.coveragePct;
      covCount++;
    }
  }
  // Compute sequence readiness across all applicable rows
  // Count sequences that are 'ready' vs total applicable (non-'na') sequences
  var totalSeqApplicable = 0;
  var totalSeqReady = 0;
  for (var si = 0; si < rows.length; si++) {
    var sr = rows[si];
    if (!sr.category || !EM_POINT_CATEGORIES[sr.category]) continue;
    var srCompliance = emComputeCompliance(sr, {}, _auditStatsMaps);
    var srReadiness = emComputeSequenceReadiness(sr, srCompliance);
    for (var sk in srReadiness) {
      if (!srReadiness.hasOwnProperty(sk)) continue;
      var seqEntry = srReadiness[sk];
      if (seqEntry.status !== 'na') {
        totalSeqApplicable++;
        if (seqEntry.status === 'ready') totalSeqReady++;
      }
    }
  }
  var seqReadinessPct = totalSeqApplicable > 0 ? Math.round((totalSeqReady / totalSeqApplicable) * 100) : 0;

  return {
    avgCoverage: covCount > 0 ? Math.round(totalCoverage / covCount) : 0,
    totalBASPoints: totalPts,
    seqReadinessPct: seqReadinessPct,
    seqReady: totalSeqReady,
    seqApplicable: totalSeqApplicable,
  };
}

/* ── emUpdateStatsPillsForAudit ─────────────────────────────────────────────
   Replace the stats bar with audit-mode pills when in audit view.       */
function emUpdateStatsPillsForAudit(rows) {
  var bar = document.getElementById('em-stats-bar');
  if (!bar) return;
  var base = emCalcSummaryStats(rows);
  var audit = emComputeAuditStats(rows);
  var avgCov = audit.avgCoverage;
  var covColor = avgCov >= 75 ? '#27ae60' : avgCov >= 50 ? '#e67e22' : '#c0392b';
  var covPill =
    '<div style="display:flex;flex-direction:column;align-items:center;min-width:64px">' +
    '<div style="font-size:18px;font-weight:700;color:' +
    covColor +
    ';line-height:1">' +
    avgCov +
    '%</div>' +
    '<div style="font-size:10px;color:var(--text3);margin-top:2px;text-transform:uppercase;letter-spacing:0.04em">Pt Coverage</div>' +
    '</div>';
  var seqPct = audit.seqReadinessPct;
  var seqColor = seqPct >= 75 ? '#27ae60' : seqPct >= 50 ? '#e67e22' : '#c0392b';
  var seqPill =
    audit.seqApplicable > 0
      ? '<div style="display:flex;flex-direction:column;align-items:center;min-width:64px">' +
        '<div style="font-size:18px;font-weight:700;color:' +
        seqColor +
        ';line-height:1">' +
        seqPct +
        '%</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:2px;text-transform:uppercase;letter-spacing:0.04em">Seq Ready</div>' +
        '</div>'
      : '';
  bar.innerHTML =
    emStatPill('Buildings', base.buildings) +
    emStatPill('Equipment', base.total) +
    covPill +
    seqPill +
    emStatPill('BAS Points', audit.totalBASPoints.toLocaleString());
}

/* ── emUpdateStatsPillsForRaw ───────────────────────────────────────────────
   Restore the stats bar to raw-mode pills.                               */
function emUpdateStatsPillsForRaw(rows, totalBASPoints) {
  var bar = document.getElementById('em-stats-bar');
  if (!bar) return;
  var stats = emCalcSummaryStats(rows);
  bar.innerHTML =
    emStatPill('Buildings', stats.buildings) +
    emStatPill('Equipment', stats.total) +
    emStatPill('AHU / RTU', stats.ahu) +
    emStatPill('VAV / FPB', stats.vav) +
    emStatPill('Plants', stats.plants) +
    emStatPill('Live Data', stats.live) +
    (totalBASPoints ? emStatPill('BAS Points', totalBASPoints.toLocaleString()) : '');
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
  asset: '#6b7280',
  lifecycle: '#f39c12',
  maintenance: '#2980b9',
  locDetail: '#8e44ad',
  controls: '#16a085',
  custom: '#c0392b',
  audit: '#1e40af',
  'audit-cat': '#3b82f6',
  'audit-seq': '#7c3aed',
  'audit-behavior': '#0891b2',
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

/* ── emComputeFooterAvg ─────────────────────────────────────────────────────
   Computes per-column averages for a set of rows.
   Only processes defs where def.type==='num' || def.isLive || def.isDynPoint.
   Returns: { [def.key]: { sum, count, avg } }
   Columns with no numeric data return { sum:0, count:0, avg:NaN }.      */
function emComputeFooterAvg(rows, defs) {
  var result = {};
  for (var di = 0; di < defs.length; di++) {
    var def = defs[di];
    if (def.type !== 'num' && !def.isLive && !def.isDynPoint) continue;
    var sum = 0,
      count = 0;
    for (var ri = 0; ri < rows.length; ri++) {
      var raw = emGetCellValByDef(rows[ri], def, {});
      if (raw === null || raw === undefined || raw === '') continue;
      var n = parseFloat(raw);
      if (isNaN(n)) continue;
      sum += n;
      count++;
    }
    result[def.key] = { sum: sum, count: count, avg: count > 0 ? sum / count : NaN };
  }
  return result;
}

/* ── buildAvgFooterRow ──────────────────────────────────────────────────────
   Builds a <tr> HTML string for a footer average row.
   avgMap: output of emComputeFooterAvg.
   defs: column defs array.
   label: text for the first cell (building column).
   isBold: true → bold label style (Total Average), false → italic (Page Average).
   hasEditCol: true → prepend an extra empty <td> for the edit/delete column.  */
function buildAvgFooterRow(avgMap, defs, label, isBold, hasEditCol) {
  var rowStyle = 'background:var(--s1);';
  var tdBase =
    'padding:8px 12px;vertical-align:middle;border-top:2px solid var(--border);font-size:13px;background:var(--s1);';
  var html = '<tr style="' + rowStyle + '">';
  if (hasEditCol) {
    html += '<td style="' + tdBase + '"></td>';
  }
  for (var di = 0; di < defs.length; di++) {
    var def = defs[di];
    // First column (building) gets the label text
    if (di === 0) {
      var labelStyle =
        tdBase +
        'position:sticky;left:0;z-index:1;' +
        (isBold ? 'font-weight:700;color:var(--text)' : 'font-style:italic;color:var(--text2)');
      html += '<td style="' + labelStyle + '">' + label + '</td>';
      continue;
    }
    // Numeric/live columns get the average value
    if (avgMap[def.key] && avgMap[def.key].count > 0) {
      var avg = avgMap[def.key].avg;
      var formatted = (Math.round(avg * 10) / 10).toFixed(1);
      html +=
        '<td style="' +
        tdBase +
        'text-align:right;font-weight:' +
        (isBold ? '700' : '500') +
        '">' +
        formatted +
        '</td>';
    } else {
      html += '<td style="' + tdBase + 'text-align:center;color:var(--text3)">&#8212;</td>';
    }
  }
  html += '</tr>';
  return html;
}

function emRenderTable(data, filters) {
  // Route to audit renderer when in audit view mode
  if (_emViewMode === 'audit') {
    emRenderAuditTable(data, filters);
    return;
  }
  // Route to summary renderer when in summary view mode
  if (_emViewMode === 'summary') {
    emRenderSummaryView(data, filters);
    return;
  }
  emSyncViewModeControls();

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

  // Sort final dynamic column list by point count descending so most common columns appear leftmost
  dynColsToShow.sort(function (a, b) {
    var diff = (dynPointFreq[b] || 0) - (dynPointFreq[a] || 0);
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

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
  if (countEl) {
    var totalPts = 0,
      filteredPts = 0;
    for (var i = 0; i < rows.length; i++) totalPts += Object.keys(rows[i].points || {}).length;
    for (var i = 0; i < filtered.length; i++) filteredPts += Object.keys(filtered[i].points || {}).length;
    var ptsText =
      filtered.length < rows.length
        ? filteredPts.toLocaleString() + ' of ' + totalPts.toLocaleString() + ' BAS Points'
        : totalPts.toLocaleString() + ' Total BAS Points';
    countEl.textContent = ptsText;
  }

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
  if (_emEditMode) {
    theadCells +=
      '<th style="position:sticky;top:0;background:var(--s2);border-top:3px solid transparent;' +
      'font-weight:600;color:var(--text2);white-space:nowrap;' +
      'width:36px;text-align:center;border-bottom:1px solid var(--border);border-right:1px solid var(--border)"></th>';
  }
  for (var ci = 0; ci < defs.length; ci++) {
    var d = defs[ci];
    var color = _EM_GROUP_COLORS[d.group] || 'transparent';
    var borderTop =
      color !== 'transparent' ? 'border-top:3px solid ' + color + ';' : 'border-top:3px solid transparent;';
    var isSorted = _emSortCol === ci;
    var sortInd = isSorted ? (_emSortDir === 1 ? ' (asc)' : ' (desc)') : '';
    theadCells +=
      '<th data-ci="' +
      ci +
      '" onclick="emHandleSort(' +
      ci +
      ')" ' +
      'style="position:sticky;top:0;background:var(--s2);' +
      borderTop +
      'font-weight:600;color:var(--text2);white-space:nowrap;cursor:pointer;' +
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
    if (_emEditMode) {
      var delLabel = String(row.building || '') + ', ' + String(row.name || row.id || '');
      cells +=
        '<td style="padding:2px 6px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);vertical-align:middle;white-space:nowrap">' +
        '<button onclick="emDeleteRow(\'' +
        String(rowId).replace(/'/g, "\\'") +
        "','" +
        delLabel.replace(/'/g, "\\'") +
        '\')" ' +
        'style="font-size:10px;padding:1px 6px;background:#fee2e2;border:1px solid #fca5a5;color:#b91c1c;border-radius:3px;cursor:pointer;line-height:1.4" ' +
        'title="Delete this row">X</button>' +
        '</td>';
    }
    for (var di = 0; di < defs.length; di++) {
      var def = defs[di];
      var editKey = rowId + '::' + def.key;
      var isEdited = edits && edits[editKey] !== undefined;
      var rawVal = emGetCellValByDef(row, def, edits);
      var isEmpty = rawVal === null || rawVal === undefined || rawVal === '';
      var displayVal = emFormatCell(rawVal, def);
      var cellStyle =
        'border-bottom:1px solid var(--border);border-right:1px solid var(--border);vertical-align:middle;' +
        (def.isLive ? 'font-family:Consolas,monospace;font-size:10px;' : '') +
        (def.isDynPoint ? 'font-family:Consolas,monospace;font-size:10px;' : '') +
        (isEmpty ? 'color:var(--text3);' : '') +
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
    sizeSelectHtml += '<option value="' + opt + '"' + (isCurrent ? ' selected' : '') + '>' + lbl + '</option>';
  }
  sizeSelectHtml += '</select>';

  var prevDisabled = _emCurrentPage <= 0 || useAll;
  var nextDisabled = _emCurrentPage >= totalPages - 1 || useAll;
  var pageLabel = useAll
    ? 'All ' + filtered.length + ' rows'
    : totalPages === 1
      ? 'All rows visible (' + filtered.length + ' rows)'
      : 'Page ' + (_emCurrentPage + 1) + ' of ' + totalPages + ' (' + filtered.length + ' total rows)';

  var paginationHtml =
    '<div class="em-pagination" style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--border);background:var(--s1);flex-shrink:0;font-size:11px;color:var(--text2)">' +
    '<button onclick="emPrevPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (prevDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Prev</button>' +
    '<span style="flex:1;text-align:center">' +
    pageLabel +
    '</span>' +
    '<button onclick="emNextPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (nextDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Next</button>' +
    '<span style="color:var(--text3)">Rows per page:</span>' +
    sizeSelectHtml +
    '</div>';

  // Update stats bar for raw view
  emUpdateStatsPillsForRaw(rows, data.totalBASPoints);

  // ── Footer average rows ──
  var pageAvg = emComputeFooterAvg(pageRows, defs);
  var totalAvg = emComputeFooterAvg(filtered, defs);
  var tfootHtml =
    '<tfoot>' +
    buildAvgFooterRow(pageAvg, defs, 'Page Average', false, !!_emEditMode) +
    buildAvgFooterRow(totalAvg, defs, 'Total Average', true, !!_emEditMode) +
    '</tfoot>';

  wrap.innerHTML =
    '<table style="border-collapse:separate;border-spacing:0;table-layout:auto">' +
    '<thead><tr>' +
    theadCells +
    '</tr></thead>' +
    '<tbody>' +
    tbodyRows +
    '</tbody>' +
    tfootHtml +
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

  // Apply computed left: positions to frozen columns now that the DOM is live
  emUpdateStickyOffsets();

  // Attach column resize handler to the thead
  emAttachColResizeHandler(wrap);
}

/* ── emComputeSummaryStats ──────────────────────────────────────────────────
   Groups rows by building and equipment category, then for each EM_POINT_MAP
   entry whose cats[] includes the category, collects all numeric point values,
   and computes: count, avg, min, max.
   Returns:
   {
     [building]: {
       [category]: {
         label: string,           // e.g. "Courthouse"
         category: string,        // e.g. "ahu"
         equipCount: number,      // total equipment rows in this group
         metrics: [
           { col, label, count, avg, min, max }
         ]
       }
     }
   }                                                                        */
function emComputeSummaryStats(rows) {
  // Step 1: group rows by building and category
  var groups = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var bldg = (row.building || '(No Building)').trim();
    var cat = (row.category || '').toLowerCase();
    if (!cat) continue;
    if (!groups[bldg]) groups[bldg] = {};
    if (!groups[bldg][cat]) groups[bldg][cat] = { equipCount: 0, rows: [] };
    groups[bldg][cat].equipCount++;
    groups[bldg][cat].rows.push(row);
  }

  // Step 2: for each group, compute metrics from EM_POINT_MAP
  var result = {};
  var bldgKeys = Object.keys(groups).sort();
  for (var bi = 0; bi < bldgKeys.length; bi++) {
    var bldg = bldgKeys[bi];
    result[bldg] = {};
    var catKeys = Object.keys(groups[bldg]).sort();
    for (var ci = 0; ci < catKeys.length; ci++) {
      var cat = catKeys[ci];
      var group = groups[bldg][cat];
      var metrics = [];
      for (var mi = 0; mi < EM_POINT_MAP.length; mi++) {
        var entry = EM_POINT_MAP[mi];
        // Only include this metric if it applies to this equipment category
        if (entry.cats.indexOf(cat) === -1) continue;
        // Collect numeric values from all rows in this group
        var values = [];
        for (var rj = 0; rj < group.rows.length; rj++) {
          var pts = group.rows[rj].points || {};
          var raw = pts[entry.col];
          if (raw === undefined || raw === null || raw === '') continue;
          var num = parseFloat(raw);
          if (!isNaN(num)) values.push(num);
        }
        // Require at least 2 data points to show a stat
        if (values.length < 2) continue;
        var sum = 0;
        var mn = values[0];
        var mx = values[0];
        for (var vi = 0; vi < values.length; vi++) {
          sum += values[vi];
          if (values[vi] < mn) mn = values[vi];
          if (values[vi] > mx) mx = values[vi];
        }
        var avg = sum / values.length;
        metrics.push({
          col: entry.col,
          label: entry.label,
          count: values.length,
          avg: avg,
          min: mn,
          max: mx,
        });
      }

      // Also compute above/below setpoint for VAV zones if we have zone temp + setpoints
      if ((cat === 'vav' || cat === 'fpb' || cat === 'ddvav') && group.rows.length > 0) {
        var aboveCount = 0;
        var belowCount = 0;
        var spCompCount = 0;
        for (var rk = 0; rk < group.rows.length; rk++) {
          var pts2 = group.rows[rk].points || {};
          var zoneTemp = parseFloat(pts2['zoneAirTempLive']);
          var coolSp = parseFloat(pts2['zoneCoolSpLive']);
          var htgSp = parseFloat(pts2['zoneHtgSpLive']);
          if (isNaN(zoneTemp)) continue;
          spCompCount++;
          if (!isNaN(coolSp) && zoneTemp > coolSp) aboveCount++;
          else if (!isNaN(htgSp) && zoneTemp < htgSp) belowCount++;
        }
        if (spCompCount >= 2) {
          metrics.push({
            col: '_setpointBand',
            label: 'Zones vs Setpoint',
            count: spCompCount,
            aboveCount: aboveCount,
            belowCount: belowCount,
            withinCount: spCompCount - aboveCount - belowCount,
            isSetpointBand: true,
          });
        }
      }

      result[bldg][cat] = {
        equipCount: group.equipCount,
        metrics: metrics,
      };
    }
  }
  return result;
}

/* ── emComputeBuildingZoneStats ─────────────────────────────────────────────
   Aggregates zone air temp, heating setpoint, cooling setpoint, and
   hot/ok/cold counts per building. Only processes VAV, FPB, and DD-VAV rows.
   Returns: { [buildingName]: { zoneTemp, htgSp, coolSp, hot, ok, cold, totalZones } }
   where zoneTemp/htgSp/coolSp are { sum, count, avg }.                  */
function emComputeBuildingZoneStats(rows) {
  var result = {};
  var zoneCategories = { vav: true, fpb: true, ddvav: true };

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!zoneCategories[row.category]) continue;

    var bldg = row.building || '(No Building)';
    if (!result[bldg]) {
      result[bldg] = {
        zoneTemp: { sum: 0, count: 0, avg: 0 },
        htgSp: { sum: 0, count: 0, avg: 0 },
        coolSp: { sum: 0, count: 0, avg: 0 },
        hot: 0,
        ok: 0,
        cold: 0,
        totalZones: 0,
      };
    }

    var pts = row.points || {};
    var bldgStats = result[bldg];
    bldgStats.totalZones++;

    var tempRaw = pts['zoneAirTempLive'];
    var htgRaw = pts['zoneHtgSpLive'];
    var coolRaw = pts['zoneCoolSpLive'];

    var tempVal = tempRaw !== undefined && tempRaw !== '' ? parseFloat(tempRaw) : NaN;
    var htgVal = htgRaw !== undefined && htgRaw !== '' ? parseFloat(htgRaw) : NaN;
    var coolVal = coolRaw !== undefined && coolRaw !== '' ? parseFloat(coolRaw) : NaN;

    if (!isNaN(tempVal)) {
      bldgStats.zoneTemp.sum += tempVal;
      bldgStats.zoneTemp.count += 1;
    }
    if (!isNaN(htgVal)) {
      bldgStats.htgSp.sum += htgVal;
      bldgStats.htgSp.count += 1;
    }
    if (!isNaN(coolVal)) {
      bldgStats.coolSp.sum += coolVal;
      bldgStats.coolSp.count += 1;
    }

    // Compute hot/ok/cold for this zone (only when we have temp and at least one setpoint)
    if (!isNaN(tempVal) && (!isNaN(htgVal) || !isNaN(coolVal))) {
      if (!isNaN(coolVal) && tempVal > coolVal) {
        bldgStats.hot++;
      } else if (!isNaN(htgVal) && tempVal < htgVal) {
        bldgStats.cold++;
      } else {
        bldgStats.ok++;
      }
    }
  }

  // Compute averages
  var bldgNames = Object.keys(result).sort();
  var sorted = {};
  for (var bi = 0; bi < bldgNames.length; bi++) {
    var b = bldgNames[bi];
    var s = result[b];
    s.zoneTemp.avg = s.zoneTemp.count > 0 ? s.zoneTemp.sum / s.zoneTemp.count : NaN;
    s.htgSp.avg = s.htgSp.count > 0 ? s.htgSp.sum / s.htgSp.count : NaN;
    s.coolSp.avg = s.coolSp.count > 0 ? s.coolSp.sum / s.coolSp.count : NaN;
    sorted[b] = s;
  }
  return sorted;
}

/* ── emRenderSummaryView ────────────────────────────────────────────────────
   Renders the Summary view. When _emDrillBuilding is set, delegates to
   emRenderBuildingDetailView instead.
   Otherwise renders a 5-column table: Building | Zone Air Temp |
   Zone Htg Setpoint | Zone Clg Setpoint | Zones vs Setpoints.           */
function emRenderSummaryView(data, filters) {
  emSyncViewModeControls();

  var wrap = document.getElementById('em-table-wrap');
  if (!wrap) return;

  var rows = data.rows || [];
  var filtered = emFilterRows(rows, filters);

  // Remove any existing pagination bar (used by table views)
  var tableWrap = document.getElementById('em-table-wrap');
  if (tableWrap && tableWrap.parentNode) {
    var existingPag = tableWrap.parentNode.querySelector('.em-pagination');
    if (existingPag) existingPag.parentNode.removeChild(existingPag);
  }

  // Update row count pill
  var countEl = document.getElementById('em-row-count');
  if (countEl) {
    var totalPts = 0,
      filteredPts = 0;
    for (var ii = 0; ii < rows.length; ii++) totalPts += Object.keys(rows[ii].points || {}).length;
    for (var ii = 0; ii < filtered.length; ii++) filteredPts += Object.keys(filtered[ii].points || {}).length;
    countEl.textContent =
      filtered.length < rows.length
        ? filteredPts.toLocaleString() + ' of ' + totalPts.toLocaleString() + ' BAS Points'
        : totalPts.toLocaleString() + ' Total BAS Points';
  }

  if (filtered.length === 0) {
    wrap.innerHTML =
      '<div style="padding:48px;text-align:center;font-size:13px;color:var(--text2)">No rows match the current filters.</div>';
    return;
  }

  // ── Drill-down routing ──
  if (_emDrillBuilding !== null) {
    emRenderBuildingDetailView(data, filters, _emDrillBuilding);
    return;
  }

  // ── Build zone stats from filtered rows (VAV + FPB + DD-VAV only) ──
  var zoneStats = emComputeBuildingZoneStats(filtered);
  var bldgNames = Object.keys(zoneStats); // already sorted alphabetically

  // Also compute total-average stats from ALL rows (unfiltered)
  var totalZoneStats = emComputeBuildingZoneStats(rows);

  // Helper: format a numeric avg to 1 decimal + unit, or "—" if no data
  function fmtAvg(statObj, unit) {
    if (!statObj || statObj.count === 0 || isNaN(statObj.avg)) return '<span style="color:var(--text3)">&#8212;</span>';
    return (Math.round(statObj.avg * 10) / 10).toFixed(1) + (unit || '');
  }

  // Helper: aggregate stats across all buildings in a stats map
  function aggregateZoneStats(statsMap) {
    var agg = {
      zoneTemp: { sum: 0, count: 0, avg: 0 },
      htgSp: { sum: 0, count: 0, avg: 0 },
      coolSp: { sum: 0, count: 0, avg: 0 },
      hot: 0,
      ok: 0,
      cold: 0,
    };
    var keys = Object.keys(statsMap);
    for (var ki = 0; ki < keys.length; ki++) {
      var s = statsMap[keys[ki]];
      agg.zoneTemp.sum += s.zoneTemp.sum;
      agg.zoneTemp.count += s.zoneTemp.count;
      agg.htgSp.sum += s.htgSp.sum;
      agg.htgSp.count += s.htgSp.count;
      agg.coolSp.sum += s.coolSp.sum;
      agg.coolSp.count += s.coolSp.count;
      agg.hot += s.hot;
      agg.ok += s.ok;
      agg.cold += s.cold;
    }
    agg.zoneTemp.avg = agg.zoneTemp.count > 0 ? agg.zoneTemp.sum / agg.zoneTemp.count : NaN;
    agg.htgSp.avg = agg.htgSp.count > 0 ? agg.htgSp.sum / agg.htgSp.count : NaN;
    agg.coolSp.avg = agg.coolSp.count > 0 ? agg.coolSp.sum / agg.coolSp.count : NaN;
    return agg;
  }

  var pid = window._emActivePid || '';
  var thStyle =
    'padding:12px 16px;font-size:14px;font-weight:600;background:var(--s1);' +
    'border-bottom:2px solid var(--border);color:var(--text2);white-space:nowrap;';
  var thStyleCenter = thStyle + 'text-align:center;';
  var thStyleLeft = thStyle + 'text-align:left;';

  var html = '<div style="padding:24px;overflow:auto;height:100%;box-sizing:border-box">';
  html +=
    '<h2 style="font-size:20px;font-weight:600;margin:0 0 20px 0;color:var(--text)">Equipment Summary — Zone Comfort</h2>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:15px">';
  html += '<thead><tr>';
  html += '<th style="' + thStyleLeft + '">Building</th>';
  html += '<th style="' + thStyleCenter + '">Zone Air Temp</th>';
  html += '<th style="' + thStyleCenter + '">Zone Htg Setpoint</th>';
  html += '<th style="' + thStyleCenter + '">Zone Clg Setpoint</th>';
  html += '<th style="' + thStyleCenter + '">Zones vs Setpoints</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  if (bldgNames.length === 0) {
    html +=
      '<tr><td colspan="5" style="padding:48px;text-align:center;font-size:14px;color:var(--text2)">' +
      'No zone equipment (VAV/FPB/DD-VAV) found for the current filter selection.</td></tr>';
  } else {
    var tdStyle = 'padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:15px;';
    var tdCenter = tdStyle + 'text-align:center;';
    for (var bi = 0; bi < bldgNames.length; bi++) {
      var bldg = bldgNames[bi];
      var bs = zoneStats[bldg];
      // Building name as hyperlink — use JSON.stringify to safely handle special chars
      var bldgLink =
        '<a href="#" onclick="emDrillBuilding(' +
        JSON.stringify(pid) +
        ',' +
        JSON.stringify(bldg) +
        ');return false;" ' +
        'style="color:var(--accent);cursor:pointer;font-weight:600;font-size:15px;text-decoration:none">' +
        emHtmlEsc(bldg) +
        '</a>';
      // Zones vs Setpoints cell
      var vsCell =
        '<span style="color:#c0392b;font-weight:500">' +
        bs.hot +
        ' hot</span> <span style="color:var(--text3)">|</span> ' +
        '<span style="color:#27ae60;font-weight:500">' +
        bs.ok +
        ' ok</span> <span style="color:var(--text3)">|</span> ' +
        '<span style="color:#2980b9;font-weight:500">' +
        bs.cold +
        ' cold</span>';
      html += '<tr style="min-height:48px">';
      html += '<td style="' + tdStyle + 'font-weight:600">' + bldgLink + '</td>';
      html += '<td style="' + tdCenter + 'font-weight:600">' + fmtAvg(bs.zoneTemp, '°F') + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.htgSp, '°F') + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.coolSp, '°F') + '</td>';
      html += '<td style="' + tdCenter + '">' + vsCell + '</td>';
      html += '</tr>';
    }
  }

  html += '</tbody>';

  // ── tfoot: Page Average + Total Average ──
  var pageAgg = aggregateZoneStats(zoneStats); // filtered buildings
  var totalAgg = aggregateZoneStats(totalZoneStats); // all rows
  var tfootRowStyle = 'background:var(--s1);border-top:2px solid var(--border);min-height:44px;font-size:13px;';
  var tfootTdBase = 'padding:10px 16px;vertical-align:middle;border-top:2px solid var(--border);';
  var tfootTdCenter = tfootTdBase + 'text-align:center;';

  // Page Average row
  var pageVsCell =
    '<span style="color:#c0392b">' +
    pageAgg.hot +
    ' hot</span> <span style="color:var(--text3)">|</span> ' +
    '<span style="color:#27ae60">' +
    pageAgg.ok +
    ' ok</span> <span style="color:var(--text3)">|</span> ' +
    '<span style="color:#2980b9">' +
    pageAgg.cold +
    ' cold</span>';
  html += '<tfoot>';
  html += '<tr style="' + tfootRowStyle + '">';
  html +=
    '<td style="' +
    tfootTdBase +
    'font-style:italic;color:var(--text2)">Page Average (' +
    bldgNames.length +
    ' buildings)</td>';
  html += '<td style="' + tfootTdCenter + '">' + fmtAvg(pageAgg.zoneTemp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + '">' + fmtAvg(pageAgg.htgSp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + '">' + fmtAvg(pageAgg.coolSp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + '">' + pageVsCell + '</td>';
  html += '</tr>';

  // Total Average row (all rows in project)
  var totalBldgCount = Object.keys(totalZoneStats).length;
  var totalVsCell =
    '<span style="color:#c0392b">' +
    totalAgg.hot +
    ' hot</span> <span style="color:var(--text3)">|</span> ' +
    '<span style="color:#27ae60">' +
    totalAgg.ok +
    ' ok</span> <span style="color:var(--text3)">|</span> ' +
    '<span style="color:#2980b9">' +
    totalAgg.cold +
    ' cold</span>';
  html += '<tr style="' + tfootRowStyle + '">';
  html +=
    '<td style="' +
    tfootTdBase +
    'font-weight:700;color:var(--text)">Total Average (' +
    totalBldgCount +
    ' buildings)</td>';
  html += '<td style="' + tfootTdCenter + 'font-weight:600">' + fmtAvg(totalAgg.zoneTemp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + 'font-weight:600">' + fmtAvg(totalAgg.htgSp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + 'font-weight:600">' + fmtAvg(totalAgg.coolSp, '°F') + '</td>';
  html += '<td style="' + tfootTdCenter + '">' + totalVsCell + '</td>';
  html += '</tr>';
  html += '</tfoot>';

  html += '</table>';
  html += '</div>'; // end outer padding div
  wrap.innerHTML = html;
}

/* ── emRenderBuildingDetailView ─────────────────────────────────────────────
   Renders a per-building detail view when the user clicks a building name in
   the Summary table. Shows all VAV/FPB/DD-VAV rows for that building with
   zone air temp, setpoints, and status color coding. Includes a Back button,
   a stats bar, a detail table, footer avg rows, and pagination.           */
function emRenderBuildingDetailView(data, filters, buildingName) {
  var wrap = document.getElementById('em-table-wrap');
  if (!wrap) return;

  var pid = window._emActivePid || '';
  var allRows = data.rows || [];
  var zoneCategories = { vav: true, fpb: true, ddvav: true };
  var catLabels = { vav: 'VAV', fpb: 'FPB', ddvav: 'DD-VAV' };

  // Filter: apply current filters first, then restrict to this building's zone equipment
  var baseFiltered = emFilterRows(allRows, filters);
  var bldgRows = baseFiltered.filter(function (r) {
    return r.building === buildingName && zoneCategories[r.category];
  });

  // Pagination
  var pageSize = _emPageSize;
  var useAll = pageSize === 0;
  var totalPages = useAll ? 1 : Math.ceil(bldgRows.length / pageSize);
  if (totalPages < 1) totalPages = 1;
  _emCurrentPage = Math.max(0, Math.min(_emCurrentPage, totalPages - 1));
  var pageStart = useAll ? 0 : _emCurrentPage * pageSize;
  var pageEnd = useAll ? bldgRows.length : Math.min(pageStart + pageSize, bldgRows.length);
  var pageRows = bldgRows.slice(pageStart, pageEnd);

  // Compute stats for the whole building (all bldgRows, not just page)
  var statAll = emComputeBuildingZoneStats(bldgRows);
  var bs = statAll[buildingName] || {
    zoneTemp: { count: 0, avg: NaN },
    htgSp: { count: 0, avg: NaN },
    coolSp: { count: 0, avg: NaN },
    hot: 0,
    ok: 0,
    cold: 0,
    totalZones: 0,
  };

  function fmtTempVal(statObj) {
    if (!statObj || statObj.count === 0 || isNaN(statObj.avg)) return '—';
    return (Math.round(statObj.avg * 10) / 10).toFixed(1) + '°F';
  }

  // ── Back button + header ──
  var html = '<div style="padding:24px;overflow:auto;height:100%;box-sizing:border-box">';
  html +=
    '<button onclick="emExitDrillBuilding(' +
    JSON.stringify(pid) +
    ')" ' +
    'style="background:var(--s2);border:1px solid var(--border);color:var(--text);' +
    'padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;margin-bottom:16px">&#8592; Back to Summary</button>';
  html +=
    '<h2 style="font-size:22px;font-weight:700;margin:0 0 16px 0;color:var(--text)">' +
    emHtmlEsc(buildingName) +
    '</h2>';

  // ── Stats bar ──
  html +=
    '<div style="display:flex;gap:24px;flex-wrap:wrap;font-size:15px;padding:10px 16px;' +
    'background:var(--s1);border-radius:6px;margin-bottom:20px;border:1px solid var(--border)">';
  html +=
    '<span style="color:var(--text2)">Total Zones: <strong style="color:var(--text)">' +
    bs.totalZones +
    '</strong></span>';
  html +=
    '<span style="color:var(--text2)">Zones with Live Data: <strong style="color:var(--text)">' +
    bs.zoneTemp.count +
    '</strong></span>';
  html += '<span style="color:#c0392b">Hot: <strong>' + bs.hot + '</strong></span>';
  html += '<span style="color:#27ae60">OK: <strong>' + bs.ok + '</strong></span>';
  html += '<span style="color:#2980b9">Cold: <strong>' + bs.cold + '</strong></span>';
  html += '</div>';

  // ── Detail table ──
  var thStyle =
    'padding:10px 14px;font-size:13px;font-weight:600;background:var(--s1);' +
    'border-bottom:2px solid var(--border);color:var(--text2);white-space:nowrap;text-align:left;';
  var thCenter = thStyle + 'text-align:center;';

  html += '<table style="width:100%;border-collapse:collapse;font-size:15px">';
  html += '<thead><tr>';
  html += '<th style="' + thStyle + '">Equipment Name</th>';
  html += '<th style="' + thStyle + '">Type</th>';
  html += '<th style="' + thStyle + '">Floor / Area</th>';
  html += '<th style="' + thCenter + '">Zone Air Temp</th>';
  html += '<th style="' + thCenter + '">Htg Setpoint</th>';
  html += '<th style="' + thCenter + '">Clg Setpoint</th>';
  html += '<th style="' + thCenter + '">Status</th>';
  html += '<th style="' + thCenter + '">Damper Posn</th>';
  html += '<th style="' + thCenter + '">Discharge Air Temp</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  if (pageRows.length === 0) {
    html +=
      '<tr><td colspan="9" style="padding:32px;text-align:center;font-size:14px;color:var(--text2)">' +
      'No zone equipment rows for this building with current filters.</td></tr>';
  } else {
    var tdBase = 'padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:15px;';
    var tdCenter = tdBase + 'text-align:center;';

    for (var ri = 0; ri < pageRows.length; ri++) {
      var row = pageRows[ri];
      var pts = row.points || {};

      var tempRaw = pts['zoneAirTempLive'];
      var htgRaw = pts['zoneHtgSpLive'];
      var coolRaw = pts['zoneCoolSpLive'];
      var dampRaw = pts['dampPosnLive'];
      var datRaw = pts['datLive'];

      var tempVal = tempRaw !== undefined && tempRaw !== '' ? parseFloat(tempRaw) : NaN;
      var htgVal = htgRaw !== undefined && htgRaw !== '' ? parseFloat(htgRaw) : NaN;
      var coolVal = coolRaw !== undefined && coolRaw !== '' ? parseFloat(coolRaw) : NaN;

      // Determine status
      var status = 'none';
      if (!isNaN(tempVal)) {
        if (!isNaN(coolVal) && tempVal > coolVal) {
          status = 'hot';
        } else if (!isNaN(htgVal) && tempVal < htgVal) {
          status = 'cold';
        } else if (!isNaN(htgVal) || !isNaN(coolVal)) {
          status = 'ok';
        }
      }

      // Zone Air Temp cell — color coded
      var tempBg = '';
      var tempColor = 'var(--text)';
      if (status === 'hot') {
        tempBg = 'background:#fde8e8;';
        tempColor = '#c0392b';
      } else if (status === 'cold') {
        tempBg = 'background:#e8f0fd;';
        tempColor = '#2980b9';
      } else if (status === 'ok') {
        tempBg = 'background:#e8f8ee;';
        tempColor = '#27ae60';
      }

      var tempDisplay = isNaN(tempVal)
        ? '<span style="color:var(--text3)">—</span>'
        : '<span style="color:' + tempColor + ';font-weight:600">' + tempVal.toFixed(1) + '°F</span>';
      var htgDisplay = isNaN(htgVal) ? '<span style="color:var(--text3)">—</span>' : htgVal.toFixed(1) + '°F';
      var coolDisplay = isNaN(coolVal) ? '<span style="color:var(--text3)">—</span>' : coolVal.toFixed(1) + '°F';

      // Status pill
      var statusPill = '<span style="color:var(--text3)">—</span>';
      if (status === 'hot') {
        statusPill =
          '<span style="background:#fde8e8;color:#c0392b;padding:2px 8px;border-radius:10px;font-weight:600;font-size:13px">Hot</span>';
      } else if (status === 'cold') {
        statusPill =
          '<span style="background:#e8f0fd;color:#2980b9;padding:2px 8px;border-radius:10px;font-weight:600;font-size:13px">Cold</span>';
      } else if (status === 'ok') {
        statusPill =
          '<span style="background:#e8f8ee;color:#27ae60;padding:2px 8px;border-radius:10px;font-weight:600;font-size:13px">OK</span>';
      }

      var dampDisplay =
        dampRaw !== undefined && dampRaw !== ''
          ? parseFloat(dampRaw).toFixed(1) + '%'
          : '<span style="color:var(--text3)">—</span>';
      var datDisplay =
        datRaw !== undefined && datRaw !== ''
          ? parseFloat(datRaw).toFixed(1) + '°F'
          : '<span style="color:var(--text3)">—</span>';

      html += '<tr style="min-height:44px">';
      html += '<td style="' + tdBase + 'font-weight:500">' + emHtmlEsc(row.equipName || row.name || '') + '</td>';
      html +=
        '<td style="' +
        tdBase +
        'color:var(--text2)">' +
        emHtmlEsc(catLabels[row.category] || row.category || '') +
        '</td>';
      html += '<td style="' + tdBase + 'color:var(--text2)">' + emHtmlEsc(row.floor || '') + '</td>';
      html += '<td style="' + tdCenter + tempBg + '">' + tempDisplay + '</td>';
      html += '<td style="' + tdCenter + '">' + htgDisplay + '</td>';
      html += '<td style="' + tdCenter + '">' + coolDisplay + '</td>';
      html += '<td style="' + tdCenter + '">' + statusPill + '</td>';
      html += '<td style="' + tdCenter + '">' + dampDisplay + '</td>';
      html += '<td style="' + tdCenter + '">' + datDisplay + '</td>';
      html += '</tr>';
    }
  }

  html += '</tbody>';

  // ── tfoot: Page Average + Total Average ──
  var pageStatMap = emComputeBuildingZoneStats(pageRows);
  var pageAgg = {
    zoneTemp: { sum: 0, count: 0, avg: NaN },
    htgSp: { sum: 0, count: 0, avg: NaN },
    coolSp: { sum: 0, count: 0, avg: NaN },
  };
  var pgKeys = Object.keys(pageStatMap);
  for (var pki = 0; pki < pgKeys.length; pki++) {
    var pgs = pageStatMap[pgKeys[pki]];
    pageAgg.zoneTemp.sum += pgs.zoneTemp.sum;
    pageAgg.zoneTemp.count += pgs.zoneTemp.count;
    pageAgg.htgSp.sum += pgs.htgSp.sum;
    pageAgg.htgSp.count += pgs.htgSp.count;
    pageAgg.coolSp.sum += pgs.coolSp.sum;
    pageAgg.coolSp.count += pgs.coolSp.count;
  }
  pageAgg.zoneTemp.avg = pageAgg.zoneTemp.count > 0 ? pageAgg.zoneTemp.sum / pageAgg.zoneTemp.count : NaN;
  pageAgg.htgSp.avg = pageAgg.htgSp.count > 0 ? pageAgg.htgSp.sum / pageAgg.htgSp.count : NaN;
  pageAgg.coolSp.avg = pageAgg.coolSp.count > 0 ? pageAgg.coolSp.sum / pageAgg.coolSp.count : NaN;

  function fmtFootAvg(statObj) {
    if (!statObj || statObj.count === 0 || isNaN(statObj.avg)) return '<span style="color:var(--text3)">&#8212;</span>';
    return (Math.round(statObj.avg * 10) / 10).toFixed(1) + '°F';
  }

  var ftdBase =
    'padding:10px 14px;vertical-align:middle;border-top:2px solid var(--border);font-size:14px;background:var(--s1);';
  var ftdCenter = ftdBase + 'text-align:center;font-weight:600;';

  html += '<tfoot>';
  html += '<tr>';
  html += '<td colspan="3" style="' + ftdBase + 'font-style:italic;color:var(--text2)">Page Average</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(pageAgg.zoneTemp) + '</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(pageAgg.htgSp) + '</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(pageAgg.coolSp) + '</td>';
  html += '<td colspan="3" style="' + ftdBase + '"></td>';
  html += '</tr>';
  html += '<tr>';
  html +=
    '<td colspan="3" style="' +
    ftdBase +
    'font-weight:700;color:var(--text)">Total Average (' +
    bldgRows.length +
    ' zones)</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(bs.zoneTemp) + '</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(bs.htgSp) + '</td>';
  html += '<td style="' + ftdCenter + '">' + fmtFootAvg(bs.coolSp) + '</td>';
  html += '<td colspan="3" style="' + ftdBase + '"></td>';
  html += '</tr>';
  html += '</tfoot>';

  html += '</table>';

  // ── Pagination bar ──
  if (!useAll && totalPages > 1) {
    var prevDisabled = _emCurrentPage <= 0;
    var nextDisabled = _emCurrentPage >= totalPages - 1;
    var pageLabel = 'Page ' + (_emCurrentPage + 1) + ' of ' + totalPages + ' (' + bldgRows.length + ' total zones)';
    var pageSizeOptions = [50, 100, 250, 0];
    var pageSizeLabels = { 50: '50', 100: '100', 250: '250', 0: 'All' };
    var sizeSelectHtml =
      '<select onchange="emSetPageSize(' +
      JSON.stringify(pid) +
      ', this.value)" style="font-size:11px;padding:2px 6px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">';
    for (var si = 0; si < pageSizeOptions.length; si++) {
      var opt = pageSizeOptions[si];
      sizeSelectHtml +=
        '<option value="' +
        opt +
        '"' +
        (_emPageSize === opt ? ' selected' : '') +
        '>' +
        pageSizeLabels[opt] +
        '</option>';
    }
    sizeSelectHtml += '</select>';

    html +=
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;font-size:11px;color:var(--text2);margin-top:8px">' +
      '<button onclick="emPrevPage(' +
      JSON.stringify(pid) +
      ')" ' +
      (prevDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
      'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Prev</button>' +
      '<span style="flex:1;text-align:center">' +
      pageLabel +
      '</span>' +
      '<button onclick="emNextPage(' +
      JSON.stringify(pid) +
      ')" ' +
      (nextDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
      'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Next</button>' +
      '<span style="color:var(--text3)">Rows per page:</span>' +
      sizeSelectHtml +
      '</div>';
  }

  html += '</div>'; // end outer padding div
  wrap.innerHTML = html;
}

/* ── emRenderAuditTable ─────────────────────────────────────────────────────
   Renders the equipment table in ASHRAE 36 Audit View mode.
   Uses emGetAuditColDefs() to generate compliance columns, and calls
   emComputeCompliance() per row to determine cell indicators.
   Pagination, sorting, and sticky frozen columns all work the same as raw view.
   Edit mode is suppressed in audit view (compliance cells are computed, not edited). */
function emRenderAuditTable(data, filters) {
  emSyncViewModeControls();

  var wrap = document.getElementById('em-table-wrap');
  if (!wrap) return;
  var rows = data.rows || [];
  var _auditPid = window._emActivePid || '';
  var _auditMaps = emLoadCustomMappings(_auditPid);
  var filtered = emFilterRows(rows, filters);

  // Build column defs from filtered rows so category columns match what's visible
  var defs = emGetAuditColDefs(filtered);

  // ── Sort ──
  if (_emSortCol !== null) {
    var sortDef = defs[_emSortCol];
    var sd = _emSortDir;
    if (sortDef) {
      filtered = filtered.slice().sort(function (a, b) {
        var av = emAuditGetSortVal(a, sortDef);
        var bv = emAuditGetSortVal(b, sortDef);
        if (av < bv) return -sd;
        if (av > bv) return sd;
        return 0;
      });
    }
  }

  var countEl = document.getElementById('em-row-count');
  if (countEl) {
    var totalPts = 0,
      filteredPts = 0;
    for (var i = 0; i < rows.length; i++) totalPts += Object.keys(rows[i].points || {}).length;
    for (var i = 0; i < filtered.length; i++) filteredPts += Object.keys(filtered[i].points || {}).length;
    var ptsText =
      filtered.length < rows.length
        ? filteredPts.toLocaleString() + ' of ' + totalPts.toLocaleString() + ' BAS Points'
        : totalPts.toLocaleString() + ' Total BAS Points';
    countEl.textContent = ptsText;
  }

  var visibleRows = filtered;

  var pageSize = _emPageSize;
  var useAll = pageSize === 0;
  var totalPages = useAll ? 1 : Math.ceil(visibleRows.length / pageSize);
  if (totalPages < 1) totalPages = 1;
  _emCurrentPage = Math.max(0, Math.min(_emCurrentPage, totalPages - 1));
  var pageStart = useAll ? 0 : _emCurrentPage * pageSize;
  var pageEnd = useAll ? visibleRows.length : Math.min(pageStart + pageSize, visibleRows.length);
  var pageRows = visibleRows.slice(pageStart, pageEnd);

  // ── Pre-compute compliance and sequence readiness for each page row ──
  var complianceCache = {};
  var seqReadinessCache = {};
  for (var pr = 0; pr < pageRows.length; pr++) {
    var r = pageRows[pr];
    complianceCache[r.id] = emComputeCompliance(r, {}, _auditMaps);
    seqReadinessCache[r.id] = emComputeSequenceReadiness(r, complianceCache[r.id]);
  }

  // ── Pre-compute BAS behavior summaries per building (Phase 5) ──
  // Only runs when bas-trends.js is loaded. Results keyed by building name.
  var behaviorByBuilding = {};
  var hasBehaviorCol = typeof btGetBuildingBehaviorSummary === 'function';
  if (hasBehaviorCol) {
    var pid5 = window._emActivePid;
    // Collect unique building names from page rows
    var bldgSet5 = {};
    for (var b5 = 0; b5 < pageRows.length; b5++) {
      if (pageRows[b5].building) bldgSet5[pageRows[b5].building] = true;
    }
    for (var bldg5 in bldgSet5) {
      if (!bldgSet5.hasOwnProperty(bldg5)) continue;
      behaviorByBuilding[bldg5] = btGetBuildingBehaviorSummary(pid5, bldg5);
    }
  }

  // ── Build thead ──
  var theadCells = '';
  for (var ci = 0; ci < defs.length; ci++) {
    var d = defs[ci];
    var color = _EM_GROUP_COLORS[d.group] || 'transparent';
    var borderTop =
      color !== 'transparent' ? 'border-top:3px solid ' + color + ';' : 'border-top:3px solid transparent;';
    var isSorted = _emSortCol === ci;
    var sortInd = isSorted ? (_emSortDir === 1 ? ' (asc)' : ' (desc)') : '';
    theadCells +=
      '<th data-ci="' +
      ci +
      '" onclick="emHandleSort(' +
      ci +
      ')" ' +
      (d.title ? 'title="' + emHtmlEsc(d.title) + '" ' : '') +
      'style="position:sticky;top:0;background:var(--s2);' +
      borderTop +
      'font-weight:600;color:var(--text2);white-space:nowrap;cursor:pointer;' +
      'min-width:' +
      d.width +
      'px;text-align:left;' +
      'border-bottom:1px solid var(--border);border-right:1px solid var(--border)">' +
      d.label +
      sortInd +
      '</th>';
  }

  // ── Build tbody ──
  var tbodyRows = '';
  for (var ri = 0; ri < pageRows.length; ri++) {
    var row = pageRows[ri];

    var compliance = complianceCache[row.id] || { coveredPoints: [], missingPoints: [], naPoints: [], coveragePct: 0 };
    // Build a quick lookup: catKey -> match result
    var coveredMap = {};
    for (var cp = 0; cp < compliance.coveredPoints.length; cp++) {
      var cp2 = compliance.coveredPoints[cp];
      coveredMap[cp2.categoryKey] = cp2;
    }
    var naMap = {};
    for (var np = 0; np < compliance.naPoints.length; np++) {
      naMap[compliance.naPoints[np].categoryKey] = true;
    }
    var missingMap = {};
    for (var mp = 0; mp < compliance.missingPoints.length; mp++) {
      missingMap[compliance.missingPoints[mp].categoryKey] = true;
    }

    var seqReadiness = seqReadinessCache[row.id] || {};
    var rowBehaviorSummary = hasBehaviorCol ? behaviorByBuilding[row.building] || {} : {};
    var cells = '';
    for (var di = 0; di < defs.length; di++) {
      var def = defs[di];
      cells += emRenderAuditCell(row, def, compliance, coveredMap, naMap, missingMap, seqReadiness, rowBehaviorSummary);
    }
    tbodyRows += '<tr>' + cells + '</tr>';
  }

  if (filtered.length === 0) {
    tbodyRows =
      '<tr><td colspan="' +
      defs.length +
      '" ' +
      'style="padding:32px;text-align:center;font-size:12px;color:var(--text2)">No rows match the current filters.</td></tr>';
  }

  // ── Pagination bar ──
  var pid = window._emActivePid || '';
  var pageSizeOptions = [50, 100, 250, 0];
  var pageSizeLabels = { 50: '50', 100: '100', 250: '250', 0: 'All' };
  var sizeSelectHtml =
    '<select onchange="emSetPageSize(' +
    JSON.stringify(pid) +
    ', this.value)" ' +
    'style="font-size:11px;padding:2px 6px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">';
  for (var si = 0; si < pageSizeOptions.length; si++) {
    var opt = pageSizeOptions[si];
    var isCurrent = _emPageSize === opt;
    sizeSelectHtml +=
      '<option value="' + opt + '"' + (isCurrent ? ' selected' : '') + '>' + pageSizeLabels[opt] + '</option>';
  }
  sizeSelectHtml += '</select>';

  var prevDisabled = _emCurrentPage <= 0 || useAll;
  var nextDisabled = _emCurrentPage >= totalPages - 1 || useAll;
  var pageLabel = useAll
    ? 'All ' + filtered.length + ' rows'
    : totalPages === 1
      ? 'All rows visible (' + filtered.length + ' rows)'
      : 'Page ' + (_emCurrentPage + 1) + ' of ' + totalPages + ' (' + filtered.length + ' total rows)';

  var paginationHtml =
    '<div class="em-pagination" style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--border);background:var(--s1);flex-shrink:0;font-size:11px;color:var(--text2)">' +
    '<button onclick="emPrevPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (prevDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Prev</button>' +
    '<span style="flex:1;text-align:center">' +
    pageLabel +
    '</span>' +
    '<button onclick="emNextPage(' +
    JSON.stringify(pid) +
    ')" ' +
    (nextDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;' : 'style="cursor:pointer;') +
    'font-size:11px;padding:3px 10px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;height:24px">Next</button>' +
    '<span style="color:var(--text3)">Rows per page:</span>' +
    sizeSelectHtml +
    '</div>';

  // Update stats bar for audit view
  emUpdateStatsPillsForAudit(rows);

  var pageAvg = emComputeFooterAvg(pageRows, defs);
  var totalAvg = emComputeFooterAvg(filtered, defs);
  var tfootHtml =
    '<tfoot>' +
    buildAvgFooterRow(pageAvg, defs, 'Page Average', false, false) +
    buildAvgFooterRow(totalAvg, defs, 'Total Average', true, false) +
    '</tfoot>';

  wrap.innerHTML =
    '<table style="border-collapse:separate;border-spacing:0;table-layout:auto">' +
    '<thead><tr>' +
    theadCells +
    '</tr></thead>' +
    '<tbody>' +
    tbodyRows +
    '</tbody>' +
    tfootHtml +
    '</table>';

  // Inject pagination bar
  var tableWrap = document.getElementById('em-table-wrap');
  if (tableWrap && tableWrap.parentNode) {
    var existingPag = tableWrap.parentNode.querySelector('.em-pagination');
    if (existingPag) existingPag.parentNode.removeChild(existingPag);
    var pagDiv = document.createElement('div');
    pagDiv.innerHTML = paginationHtml;
    tableWrap.parentNode.insertBefore(pagDiv.firstChild, tableWrap.nextSibling);
  }

  emUpdateStickyOffsets();
  emAttachColResizeHandler(wrap);
}

/* ── emRenderAuditCell ──────────────────────────────────────────────────────
   Renders a single <td> for a compliance column in audit view.
   Returns HTML string.
   behaviorSummary (optional) — per-building map from btGetBuildingBehaviorSummary().  */
function emRenderAuditCell(row, def, compliance, coveredMap, naMap, missingMap, seqReadiness, behaviorSummary) {
  var baseStyle =
    'border-bottom:1px solid var(--border);border-right:1px solid var(--border);vertical-align:middle;text-align:center;';

  // ── Frozen identity columns ──
  if (def.key === 'building') {
    return '<td style="' + baseStyle + 'text-align:left;font-weight:500">' + emHtmlEsc(row.building || '') + '</td>';
  }
  if (def.key === 'floor') {
    return '<td style="' + baseStyle + 'text-align:left">' + emHtmlEsc(row.floor || '') + '</td>';
  }
  if (def.key === 'equipName') {
    return '<td style="' + baseStyle + 'text-align:left">' + emHtmlEsc(row.equipName || row.name || '') + '</td>';
  }

  // ── Equipment Type ──
  if (def.isAuditType) {
    var catLabel = row.category ? row.category.toUpperCase() : 'Unknown';
    return (
      '<td style="' + baseStyle + 'text-align:left;font-size:10px;color:var(--text2)">' + emHtmlEsc(catLabel) + '</td>'
    );
  }

  // ── Coverage % ──
  if (def.isAuditCoverage) {
    var pct = compliance.coveragePct;
    var pctColor = pct >= 75 ? '#27ae60' : pct >= 50 ? '#e67e22' : '#c0392b';
    var pctBg = pct >= 75 ? 'rgba(39,174,96,0.1)' : pct >= 50 ? 'rgba(230,126,34,0.1)' : 'rgba(192,57,43,0.1)';
    var hasPoints = row.category && EM_POINT_CATEGORIES[row.category];
    if (!hasPoints) {
      // Equipment type is 'other' or unrecognized — no ASHRAE 36 compliance requirements apply
      return (
        '<td style="' +
        baseStyle +
        'color:var(--text3)" title="No ASHRAE 36 compliance requirements for this equipment type">N/A</td>'
      );
    }
    return (
      '<td onclick="emShowComplianceDetail(\'' +
      String(row.id).replace(/'/g, "\\'") +
      '\')" ' +
      'style="' +
      baseStyle +
      'background:' +
      pctBg +
      ';color:' +
      pctColor +
      ';font-weight:700;cursor:pointer" ' +
      'title="Click for compliance detail">' +
      pct +
      '%</td>'
    );
  }

  // ── Total BAS Points ──
  if (def.isAuditBasPts) {
    var ptCount = Object.keys(row.points || {}).length;
    return '<td style="' + baseStyle + 'color:var(--text2)">' + (ptCount > 0 ? ptCount : '--') + '</td>';
  }

  // ── Compliance category cell ──
  if (def.isAuditCat) {
    var catKey = def.catKey;
    // Gray/blank if this equipment type doesn't have this category at all
    if (!row.category || def.catEquipTypes.indexOf(row.category) === -1) {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(128,128,128,0.08);color:var(--text3)" title="Not applicable to this equipment type">N/A</td>'
      );
    }
    // N/A due to config flag
    if (naMap[catKey]) {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(128,128,128,0.08);color:var(--text3)" title="N/A for this equipment">N/A</td>'
      );
    }
    // Matched: determine tier
    if (coveredMap[catKey]) {
      var match = coveredMap[catKey];
      var tier = match.matchTier;
      var rawVal = row.points && match.pointName ? row.points[match.pointName] || '' : '';
      var displayVal = rawVal ? (rawVal.length > 8 ? rawVal.slice(0, 8) : rawVal) : null;
      var tooltipBase = emHtmlEsc((match.pointName || '') + (rawVal ? ': ' + rawVal : ''));
      if (tier <= 2) {
        // High confidence — green cell showing live value (fallback to "Yes" if no value)
        return (
          '<td style="' +
          baseStyle +
          'background:rgba(39,174,96,0.15);color:#27ae60;font-size:11px;font-weight:700">' +
          (displayVal !== null ? emHtmlEsc(displayVal) : 'Yes') +
          '</td>'
        );
      } else {
        // Fuzzy match — amber cell showing live value (fallback to "Fuzzy" if no value)
        return (
          '<td style="' +
          baseStyle +
          'background:rgba(230,126,34,0.15);color:#e67e22;font-size:11px;font-weight:700">' +
          (displayVal !== null ? emHtmlEsc(displayVal) : 'Fuzzy') +
          '</td>'
        );
      }
    }
    // Required but missing — red No
    if (def.catRequired && missingMap[catKey]) {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(192,57,43,0.15);color:#c0392b;font-size:11px;font-weight:700">No</td>'
      );
    }
    // Optional and not present — dash so the cell is not silently blank
    return '<td style="' + baseStyle + 'color:var(--text3)">--</td>';
  }

  // ── Sequence status cell ──
  if (def.isAuditSeq) {
    var seqKey = def.seqKey;
    var seqResult = seqReadiness ? seqReadiness[seqKey] : null;
    // Gray if this sequence doesn't apply to this equipment type
    if (!row.category || def.seqEquipTypes.indexOf(row.category) === -1) {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(128,128,128,0.08);color:var(--text3)" title="Not applicable to this equipment type">N/A</td>'
      );
    }
    return emRenderSequenceCell(def.label, seqResult);
  }

  // ── Behavior column (Phase 5 — BAS trend behavioral verification) ──
  if (def.isAuditBehavior) {
    // If bas-trends.js is not loaded, show a static "No Data" cell
    if (typeof btMatchBehaviorToRow !== 'function' || !behaviorSummary) {
      return (
        '<td style="' +
        baseStyle +
        'color:var(--text3);font-size:10px" ' +
        'title="Upload trend data via BAS Trends view to populate">No Data</td>'
      );
    }
    var behaviorEntry = btMatchBehaviorToRow(behaviorSummary, row);
    if (!behaviorEntry) {
      return (
        '<td style="' +
        baseStyle +
        'color:var(--text3);font-size:10px" ' +
        'title="No trend data uploaded for this equipment. Use the BAS Trends view to import a WebCTRL CSV.">No Data</td>'
      );
    }
    var bVerdict = behaviorEntry.verdict;
    var bDays = behaviorEntry.daysCount || 0;
    var bRange = behaviorEntry.dataRange || {};
    var bRangeText = bRange.start && bRange.end ? bRange.start + ' to ' + bRange.end : '';
    var bTooltip = behaviorEntry.label ? 'Equipment: ' + behaviorEntry.label + '. ' : '';
    bTooltip += bDays + ' days of trend data' + (bRangeText ? ' (' + bRangeText + ')' : '') + '.';

    // Build check detail tooltip
    if (behaviorEntry.checks) {
      var checkLines = [];
      var checkLabels = {
        satReset: 'SAT Reset',
        dspReset: 'DSP Reset',
        economizer: 'Economizer',
        shc: 'SHC',
        afterHours: 'After-Hours',
        setpointDeviation: 'Setpoint Dev.',
        hunting: 'Valve Hunting',
      };
      for (var ck in behaviorEntry.checks) {
        if (!behaviorEntry.checks.hasOwnProperty(ck)) continue;
        var checkObj = behaviorEntry.checks[ck];
        var ckLabel = checkLabels[ck] || ck;
        checkLines.push(ckLabel + ': ' + checkObj.verdict);
      }
      if (checkLines.length) bTooltip += ' | ' + checkLines.join(', ');
    }

    if (bVerdict === 'PASS') {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(39,174,96,0.15);color:#27ae60;font-size:11px;font-weight:700" ' +
        'title="' +
        emHtmlEsc(bTooltip) +
        '">PASS</td>'
      );
    }
    if (bVerdict === 'WARN') {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(230,126,34,0.15);color:#e67e22;font-size:11px;font-weight:700" ' +
        'title="' +
        emHtmlEsc(bTooltip) +
        '">WARN</td>'
      );
    }
    if (bVerdict === 'FAIL') {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(192,57,43,0.15);color:#c0392b;font-size:11px;font-weight:700" ' +
        'title="' +
        emHtmlEsc(bTooltip) +
        '">FAIL</td>'
      );
    }
    // NO_DATA or unknown
    return (
      '<td style="' +
      baseStyle +
      'color:var(--text3);font-size:10px" ' +
      'title="' +
      emHtmlEsc(bTooltip) +
      '">No Data</td>'
    );
  }

  // ── Fallback ──
  return '<td style="' + baseStyle + '">' + emHtmlEsc(String(row[def.key] || '')) + '</td>';
}

/* ── emHtmlEsc ──────────────────────────────────────────────────────────────
   Escape HTML special characters for safe insertion into HTML strings.   */
function emHtmlEsc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── emAuditGetSortVal ──────────────────────────────────────────────────────
   Get sort value for a given audit column def and row.                   */
function emAuditGetSortVal(row, def) {
  var _sortMaps = null; // loaded lazily below when needed
  if (def.key === 'building') return row.building || '';
  if (def.key === 'floor') return row.floor || '';
  if (def.key === 'equipName') return row.equipName || row.name || '';
  if (def.isAuditType) return row.category || '';
  if (def.isAuditCoverage) {
    _sortMaps = _sortMaps || emLoadCustomMappings(window._emActivePid || '');
    var c = emComputeCompliance(row, {}, _sortMaps);
    return c.coveragePct;
  }
  if (def.isAuditBasPts) return Object.keys(row.points || {}).length;
  if (def.isAuditCat) {
    var catKey = def.catKey;
    if (!row.category || def.catEquipTypes.indexOf(row.category) === -1) return -1;
    _sortMaps = _sortMaps || emLoadCustomMappings(window._emActivePid || '');
    var comp = emComputeCompliance(row, {}, _sortMaps);
    for (var i = 0; i < comp.coveredPoints.length; i++) {
      if (comp.coveredPoints[i].categoryKey === catKey) return comp.coveredPoints[i].matchTier;
    }
    return 99; // missing
  }
  if (def.isAuditSeq) {
    if (!row.category || def.seqEquipTypes.indexOf(row.category) === -1) return -1;
    _sortMaps = _sortMaps || emLoadCustomMappings(window._emActivePid || '');
    var seqComp = emComputeCompliance(row, {}, _sortMaps);
    var seqR = emComputeSequenceReadiness(row, seqComp);
    var seqEntry = seqR[def.seqKey];
    if (!seqEntry || seqEntry.status === 'na') return -1;
    var statusOrder = { ready: 0, partial: 1, blocked: 2 };
    return statusOrder[seqEntry.status] !== undefined ? statusOrder[seqEntry.status] : 99;
  }
  // Behavior column sort: FAIL=0, WARN=1, PASS=2, NO_DATA=3, (no BAS data)=4
  if (def.isAuditBehavior) {
    if (typeof btGetBuildingBehaviorSummary === 'function' && typeof btMatchBehaviorToRow === 'function') {
      var bSummary = btGetBuildingBehaviorSummary(window._emActivePid, row.building);
      var bEntry = btMatchBehaviorToRow(bSummary, row);
      if (bEntry) {
        var bOrder = { FAIL: 0, WARN: 1, PASS: 2, NO_DATA: 3 };
        return bOrder[bEntry.verdict] !== undefined ? bOrder[bEntry.verdict] : 4;
      }
    }
    return 4; // no BAS data — sort last
  }
  return '';
}

/* ── emShowComplianceDetail ─────────────────────────────────────────────────
   Clicking the Coverage % cell opens a simple detail view showing which
   points were matched, fuzzy-matched, or missing.
   Phase 3 will replace this with a panel — for now, shows an alert summary. */
function emShowComplianceDetail(rowId) {
  var data = emLoadMatrix(window._emActivePid);
  if (!data) return;
  var row = null;
  for (var i = 0; i < (data.rows || []).length; i++) {
    if (data.rows[i].id === rowId) {
      row = data.rows[i];
      break;
    }
  }
  if (!row) return;
  var _detailMaps = emLoadCustomMappings(window._emActivePid || '');
  var c = emComputeCompliance(row, {}, _detailMaps);
  var lines = [
    (row.equipName || row.name || rowId) + ' — ' + (row.category || '').toUpperCase() + ' Compliance',
    'Coverage: ' + c.coveragePct + '% (' + c.totalMatched + '/' + (c.totalRequired - c.totalNA) + ' required points)',
    '',
  ];
  if (c.coveredPoints.length) {
    lines.push('Matched (' + c.coveredPoints.length + '):');
    for (var cp = 0; cp < c.coveredPoints.length; cp++) {
      var p = c.coveredPoints[cp];
      lines.push('  ' + (p.matchTier <= 2 ? '[OK]' : '[~]') + ' ' + p.categoryLabel + ' — "' + p.pointName + '"');
    }
    lines.push('');
  }
  if (c.missingPoints.length) {
    lines.push('Missing required (' + c.missingPoints.length + '):');
    for (var mp = 0; mp < c.missingPoints.length; mp++) {
      lines.push('  [X] ' + c.missingPoints[mp].categoryLabel);
    }
    lines.push('');
  }
  if (c.naPoints.length) {
    lines.push('N/A (' + c.naPoints.length + '):');
    for (var np = 0; np < c.naPoints.length; np++) {
      lines.push('  [-] ' + c.naPoints[np].categoryLabel);
    }
  }
  alert(lines.join('\n'));
}

/**
 * emAttachColResizeHandler — Enables drag-to-resize on column header right edges.
 * Detects mousedown within 5px of a th right border, then updates column width on drag.
 * After resize, calls emUpdateStickyOffsets() to recompute frozen column positions.
 * Detects mousedown within 5px of a th right border, then updates column width on drag.
 * After resize, calls emUpdateStickyOffsets() to recompute frozen column positions.
 */
function emAttachColResizeHandler(wrap) {
  if (!wrap) return;
  var thead = wrap.querySelector('thead');
  if (!thead) return;

  var _resizing = false;
  var _resizeTh = null;
  var _resizeStartX = 0;
  var _resizeStartW = 0;

  function onMouseMove(e) {
    if (!_resizing) {
      // Change cursor when near right edge of a th
      var th = e.target.closest ? e.target.closest('th') : null;
      if (th && th.closest('thead')) {
        var rect = th.getBoundingClientRect();
        if (rect.right - e.clientX <= 5) {
          th.classList.add('em-col-resizing');
        } else {
          th.classList.remove('em-col-resizing');
        }
      }
      return;
    }
    // Actively resizing
    var dx = e.clientX - _resizeStartX;
    var newW = Math.max(40, _resizeStartW + dx);
    _resizeTh.style.minWidth = newW + 'px';
    _resizeTh.style.width = newW + 'px';
  }

  function onMouseDown(e) {
    var th = e.target.closest ? e.target.closest('th') : null;
    if (!th || !th.closest('thead')) return;
    var rect = th.getBoundingClientRect();
    if (rect.right - e.clientX > 5) return; // not near right edge
    e.preventDefault();
    _resizing = true;
    _resizeTh = th;
    _resizeStartX = e.clientX;
    _resizeStartW = th.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseUp() {
    if (_resizing) {
      _resizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Recalculate frozen column offsets after resize
      emUpdateStickyOffsets();
    }
  }

  // Clean up any document-level handlers from a previous render to prevent accumulation
  if (wrap._emDocMoveHandler) document.removeEventListener('mousemove', wrap._emDocMoveHandler);
  if (wrap._emDocUpHandler) document.removeEventListener('mouseup', wrap._emDocUpHandler);

  // Remove any previous thead-level handlers by cloning (safe — no inline events on thead itself)
  var newThead = thead.cloneNode(true);
  thead.parentNode.replaceChild(newThead, thead);

  // Re-query wrap since we replaced thead
  var activeThead = wrap.querySelector('thead');
  activeThead.addEventListener('mousemove', onMouseMove);
  activeThead.addEventListener('mousedown', onMouseDown);

  // Store named references so we can remove them on next render
  wrap._emDocMoveHandler = function (e) {
    if (_resizing) onMouseMove(e);
  };
  wrap._emDocUpHandler = onMouseUp;
  document.addEventListener('mousemove', wrap._emDocMoveHandler);
  document.addEventListener('mouseup', wrap._emDocUpHandler);
}

function emPrevPage(pid) {
  if (_emCurrentPage > 0) {
    _emCurrentPage--;
    var data = emLoadMatrix(pid);
    emRenderTable(data, _emFilters);
  }
}

function emNextPage(pid) {
  var data = emLoadMatrix(pid);
  var rows = data ? data.rows || [] : [];
  var filtered = emFilterRows(rows, _emFilters);
  var totalPages = _emPageSize === 0 ? 1 : Math.ceil(filtered.length / _emPageSize);
  if (totalPages < 1) totalPages = 1;
  if (_emCurrentPage >= totalPages - 1) return;
  _emCurrentPage++;
  emRenderTable(data, _emFilters);
}

function emSetPageSize(pid, val) {
  _emPageSize = parseInt(val, 10);
  if (isNaN(_emPageSize)) _emPageSize = EM_PAGE_SIZE;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  var rows = data ? data.rows || [] : [];
  var filtered = emFilterRows(rows, _emFilters);
  emRenderTable(data, _emFilters);
  if (_emPageSize === 0) {
    showToast('Showing all ' + filtered.length + ' rows');
  } else {
    var showing = Math.min(_emPageSize, filtered.length);
    showToast('Showing rows 1–' + showing + ' of ' + filtered.length);
  }
}

function emDeleteRow(rowId, label) {
  if (!confirm('Delete this equipment row?\n(' + label + ')')) return;
  var pid = window._emActivePid;
  var data = emLoadMatrix(pid);
  if (!data || !data.rows) return;
  data.rows = data.rows.filter(function (r) {
    return String(r.id) !== String(rowId);
  });
  // Rebuild buildings list
  var bldgSeen = {};
  var buildings = [];
  for (var i = 0; i < data.rows.length; i++) {
    if (!bldgSeen[data.rows[i].building]) {
      buildings.push(data.rows[i].building);
      bldgSeen[data.rows[i].building] = true;
    }
  }
  buildings.sort(function (a, b) {
    return (a || '').toLowerCase() < (b || '').toLowerCase() ? -1 : 1;
  });
  data.buildings = buildings;
  emSaveMatrix(pid, data);
  emRenderTable(data, _emFilters);
  showToast('Row deleted');
}

function emDeleteAllRows(pid) {
  var data = emLoadMatrix(pid);
  var rowCount = data && data.rows ? data.rows.length : 0;
  if (rowCount === 0) {
    showToast('No equipment data to delete');
    return;
  }
  if (
    !confirm('Delete ALL equipment data for this project? This will remove ' + rowCount + ' rows and cannot be undone.')
  )
    return;
  data.rows = [];
  data.buildings = [];
  data.totalBASPoints = 0;
  emSaveMatrix(pid, data);
  var container = document.getElementById('em-proj-wrap');
  if (container) emRenderMatrix(container, data, pid);
  showToast('All equipment data deleted');
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
  if (val === null || val === undefined || val === '') return '--';
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
        if (/^x$/i.test(s)) return '<span style="color:#2ecc71;font-size:11px;font-weight:700">Yes</span>';
        if (/^missing$/i.test(s)) return '<span style="color:#e74c3c;font-size:11px;font-weight:700">No</span>';
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
  // Modal header with title + close button
  var headerHtml =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)">' +
    '<div style="font-size:14px;font-weight:700;color:var(--text)">Import Equipment CSVs</div>' +
    '<button onclick="emCloseUploadModal(null,\'' +
    _emImportMode +
    '\')" ' +
    'style="background:none;border:none;cursor:pointer;font-size:18px;line-height:1;color:var(--text3);padding:2px 6px" ' +
    'title="Close">&#x2715;</button>' +
    '</div>';

  // Drop zone + file input + status
  var bodyHtml =
    '<div style="padding:20px">' +
    '<div id="em-drop-zone" ' +
    'style="border:2px dashed var(--border);border-radius:8px;padding:40px 24px;text-align:center;cursor:pointer;background:var(--s2);transition:border-color 0.15s;margin-bottom:12px" ' +
    'ondragover="emHandleFileDrop(event,\'over\')" ' +
    'ondragleave="emHandleFileDrop(event,\'leave\')" ' +
    'ondrop="emHandleFileDrop(event,\'drop\')" ' +
    'onclick="document.getElementById(\'em-file-input\').click()">' +
    '<div style="font-size:32px;margin-bottom:8px;color:var(--text3)">&#x1F4C2;</div>' +
    '<div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">Drop CSV files here</div>' +
    '<div style="font-size:12px;color:var(--text3)">or click to browse — accepts multiple files</div>' +
    '</div>' +
    '<input type="file" id="em-file-input" accept=".csv" multiple style="display:none" onchange="emHandleFileSelect(event)">' +
    '<div id="em-file-list" style="margin-bottom:8px;display:none">' +
    '<div id="em-file-list-header" style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">Files queued: 0</div>' +
    '<ul id="em-file-items" style="list-style:none;padding:0;margin:0;font-size:11px;color:var(--text);max-height:150px;overflow-y:auto"></ul>' +
    '</div>' +
    '<div id="em-import-status-wrap" style="display:none;align-items:center;gap:8px;padding:10px;background:var(--s2);border-radius:6px">' +
    '<div id="em-import-spinner" style="width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0"></div>' +
    '<span id="em-import-status" style="font-size:12px;color:var(--text2)"></span>' +
    '</div>' +
    '<div id="em-import-success-wrap" style="display:none;align-items:center;gap:8px;padding:10px;background:var(--s2);border-radius:6px">' +
    '<span style="font-size:16px;color:#22c55e">&#x2713;</span>' +
    '<span id="em-import-success-msg" style="font-size:12px;font-weight:600;color:var(--text)"></span>' +
    '</div>' +
    '<div id="em-import-summary" style="display:none;margin-top:10px"></div>' +
    '</div>';

  container.innerHTML = headerHtml + bodyHtml;
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
  var listHeader = document.getElementById('em-file-list-header');
  if (!listDiv || !itemsUl) return;
  if (_emPendingFiles.length === 0) return;
  listDiv.style.display = 'block';
  if (listHeader) listHeader.textContent = 'Files queued: ' + _emPendingFiles.length;
  var html = '';
  for (var j = 0; j < _emPendingFiles.length; j++) {
    html += '<li style="padding:2px 0;color:var(--text)">' + emHtmlEsc(_emPendingFiles[j].name) + '</li>';
  }
  itemsUl.innerHTML = html;
  // Auto-start import as soon as valid CSVs are queued.
  // Use _emUploadTargetPid (locked at panel-open time) to prevent stale-pid contamination.
  emHandleImport(_emUploadTargetPid);
}

function emHandleImport(pid) {
  if (!_emPendingFiles || _emPendingFiles.length === 0) return;
  var statusEl = document.getElementById('em-import-status');
  var statusWrap = document.getElementById('em-import-status-wrap');
  // Use flex so spinner and text sit side-by-side (see emRenderUploadPanel)
  if (statusWrap) statusWrap.style.display = 'flex';
  if (statusEl) statusEl.textContent = 'Parsing file 1 of ' + _emPendingFiles.length + '...';
  var allRows = [];
  var detectedFormats = [];
  var totalRawRows = 0; // count of raw CSV data rows across all files, before grouping
  var pending = _emPendingFiles.length;
  var done = 0;
  function onFileDone() {
    done++;
    if (done < pending) {
      if (statusEl) statusEl.textContent = 'Processing file ' + (done + 1) + ' of ' + pending + '...';
      return;
    }

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

    // Only save to DB when a project is selected
    if (pid) {
      // merge mode: preserve existing rows and dedup by id; replace mode: start fresh
      var baseData =
        _emImportMode === 'replace' ? { rows: [], buildings: [] } : emLoadMatrix(pid) || { rows: [], buildings: [] };
      var merged = emMergeIntoMatrix(baseData, allRows);
      merged.totalBASPoints = totalRawRows;
      emSaveMatrix(pid, merged);
      var modeLabel = _emImportMode === 'replace' ? 'Re-imported' : 'Imported';
      var successMsg =
        modeLabel +
        ' ' +
        totalRawRows.toLocaleString() +
        ' rows from ' +
        pending +
        ' file' +
        (pending !== 1 ? 's' : '');
      // Compute category breakdown from allRows (the newly imported rows)
      var catCounts = {};
      var catOrder = ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'ct', 'lighting', 'other'];
      var catLabels = {
        ahu: 'AHU',
        vav: 'VAV',
        fpb: 'FPB',
        ddvav: 'DDVAV',
        hwp: 'HWP',
        chwp: 'CHWP',
        ct: 'CT',
        lighting: 'Lighting',
        other: 'Other',
      };
      allRows.forEach(function (r) {
        catCounts[r.category] = (catCounts[r.category] || 0) + 1;
      });
      var withFloor = allRows.filter(function (r) {
        return r.floor && r.floor.trim();
      }).length;
      var importBuildings = {};
      allRows.forEach(function (r) {
        importBuildings[r.building] = true;
      });
      var importBldgCount = Object.keys(importBuildings).length;
      var otherRate = allRows.length > 0 ? (catCounts['other'] || 0) / allRows.length : 0;
      var showPoints = totalRawRows !== allRows.length;
      // Build category breakdown lines
      var catLines = [];
      catOrder.forEach(function (k) {
        var n = catCounts[k] || 0;
        if (n > 0) {
          var pct = Math.round((n / allRows.length) * 100);
          var pctStr = pct < 1 ? '<1%' : pct + '%';
          var label = catLabels[k] + ': ' + n.toLocaleString() + ' (' + pctStr + ')';
          if (k === 'other' && otherRate > 0.2) label += ' ⚠';
          catLines.push('<div style="padding:1px 0">' + label + '</div>');
        }
      });
      var summaryHtml =
        '<div style="font-size:11px;color:var(--text2);line-height:1.6;background:var(--s3);border-radius:4px;padding:8px 10px">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:6px">Category Breakdown:</div>' +
        catLines.join('') +
        '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">' +
        'Buildings: ' +
        importBldgCount +
        (showPoints ? ' &nbsp;|&nbsp; BAS Points: ' + totalRawRows.toLocaleString() : '') +
        ' &nbsp;|&nbsp; Floor field non-blank: ' +
        withFloor.toLocaleString() +
        ' of ' +
        allRows.length.toLocaleString() +
        '</div>' +
        (otherRate > 0.2
          ? '<div style="margin-top:6px;color:#f59e0b;font-weight:600">⚠ High unclassified rate — some equipment types may need mapping</div>'
          : '') +
        '</div>';
      // Hide the spinner/status, show green success message before closing
      if (statusWrap) statusWrap.style.display = 'none';
      var successWrap = document.getElementById('em-import-success-wrap');
      var successMsgEl = document.getElementById('em-import-success-msg');
      var summaryEl = document.getElementById('em-import-summary');
      if (successWrap) {
        successWrap.style.display = 'flex';
        if (successMsgEl)
          successMsgEl.textContent = modeLabel + ' complete — ' + allRows.length.toLocaleString() + ' equipment rows';
      }
      if (summaryEl) {
        summaryEl.innerHTML = summaryHtml;
        summaryEl.style.display = 'block';
      }
      var closeDelay = otherRate > 0.2 ? 4000 : 3000;
      setTimeout(function () {
        // Close the modal — emRenderMatrix below rebuilds the toolbar with fresh button text
        var backdrop = document.getElementById('em-upload-modal-backdrop');
        if (backdrop) backdrop.parentNode.removeChild(backdrop);
        _emUploadTargetPid = null;
        var container = document.getElementById('em-proj-wrap');
        if (container) emRenderMatrix(container, merged, pid);
        showToast(successMsg);
      }, closeDelay);
    } else {
      // No project selected — abort with a clear error.
      // The old __preview__ path was removed because it poisoned window._emActivePid with
      // the sentinel '__preview__', which caused subsequent real-project imports to save
      // to a ghost DB key (en_eqmatrix___preview__), silently discarding data.
      showToast('No project selected — select a project first, then import CSVs', 'warn');
      if (statusEl) statusEl.textContent = 'No project selected. Select a project and try again.';
      _emPendingFiles = [];
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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 1 — AUDIT DATA LAYER: Point Normalization Engine
   Added: 2026-05-26
   Purpose: ASHRAE 36 compliance audit — normalize BAS point names to
   canonical ASHRAE 36 categories and compute per-equipment coverage scores.
   These functions are additive. Phase 2 will wire them into the view.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── EM_EXCLUSION_PATTERNS ──────────────────────────────────────────────────
   Points matching any of these should be flagged auditRelevant=false.
   They are operational/monitoring/metering points, not ASHRAE 36 control
   inputs/outputs. Filtering them prevents false-positive coverage credits.  */
var EM_EXCLUSION_PATTERNS = [
  /^EI\s/i, // Environmental Index points (WebCTRL)
  /environmental\s*index/i,
  /air\s*source\s*status/i, // WebCTRL VAV "Air Source Status" (mode enum, not a control point)
  /air\s*source\s*mode/i,
  /smoke\s*(detector|zone|alarm|damper|stat)?/i,
  /\bsmoke\b/i,
  /\bschedule\b/i, // BACnet schedule objects
  /\bruntime\b/i,
  /run\s*hours?/i,
  /energy.*month/i,
  /energy.*year/i,
  /monthly.*energy/i,
  /yearly.*energy/i,
  /\bdemand\b/i, // demand meter readings (not control)
  /electrical\s*bypass/i,
  /\bbypass\b.*\b(relay|contact|switch)\b/i,
  /\balarm\b/i,
  /BNI$/, // WebCTRL BACnet Network Interface suffix
  /\btrend\b/i, // trend logs
  /\bhistory\b/i,
  /occupied\s*override/i,
  /occupancy\s*override/i,
];

/* ── EM_EQUIP_CONFIG_FLAGS schema ───────────────────────────────────────────
   Per-equipment configuration flags stored in data.edits keyed by
   rowId + '::config'. Describes optional equipment features so the
   compliance engine knows which N/A categories to skip.               */
var EM_EQUIP_CONFIG_FLAGS = {
  ahu: [
    { key: 'hasReturnFan', label: 'Has Return Fan', default: false },
    { key: 'hasReliefFan', label: 'Has Relief Fan', default: false },
    { key: 'hasEconomizer', label: 'Has Economizer', default: true },
    { key: 'hasCHWCoil', label: 'Has CHW Coil', default: true },
    { key: 'hasHWCoil', label: 'Has HW Coil', default: true },
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: false },
    { key: 'hasOAFlow', label: 'Has OA Flow Meter', default: false },
  ],
  vav: [
    { key: 'hasReheat', label: 'Has Reheat Coil', default: true },
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: false },
    { key: 'hasOccSensor', label: 'Has Occupancy Sensor', default: false },
  ],
  fpb: [
    { key: 'hasReheat', label: 'Has Reheat Coil', default: true },
    { key: 'isSeries', label: 'Series Fan (vs Parallel)', default: false },
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: false },
  ],
  ddvav: [
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: false },
    { key: 'hasOccSensor', label: 'Has Occupancy Sensor', default: false },
  ],
  hwp: [
    { key: 'hasSecPump', label: 'Has Secondary HW Pump', default: true },
    { key: 'hasFlowMeter', label: 'Has HW Flow Meter', default: false },
    { key: 'hasIsoValves', label: 'Has Isolation Valves', default: true },
  ],
  chwp: [
    { key: 'hasSecPump', label: 'Has Secondary CHW Pump', default: true },
    { key: 'hasFlowMeter', label: 'Has CHW Flow Meter', default: false },
    { key: 'hasIsoValves', label: 'Has Isolation Valves', default: true },
    { key: 'hasPrimary', label: 'Has Primary Pump', default: true },
  ],
  ct: [
    { key: 'hasVFD', label: 'Has VFD Fan', default: true },
    { key: 'hasCWIsoValve', label: 'Has CW Isolation Valve', default: true },
    { key: 'hasMakeupValve', label: 'Has Makeup Water Valve', default: true },
  ],
};

/* ── EM_POINT_CATEGORIES ────────────────────────────────────────────────────
   Structured per-equipment-type point category map.
   Each entry: { key, label, ashrae36Name, ashrae36Section, required,
                 configFlag (optional — if set, only required when flag=true),
                 patterns[], aliases[] }
   patterns = regex array for matching raw BAS point names (vendor-neutral)
   aliases  = standard alias strings (lowercased for matching)           */
var EM_POINT_CATEGORIES = {
  /* ── AHU (Multizone VAV, ASHRAE 36 §5.16) ─────────────────────────── */
  ahu: [
    {
      key: 'sat',
      label: 'Supply Air Temperature',
      required: true,
      ashrae36Name: 'Supply Air Temperature',
      ashrae36Section: '5.16',
      patterns: [
        /\bsat\b/i,
        /supply air temp/i,
        /discharge air temp/i,
        /\bdat\b/i,
        /leaving air temp/i,
        /ahu.?sat/i,
        /supply.?temp/i,
        /discharge temp/i,
        /sa temp/i,
        /\blat\b/i,
      ],
      aliases: [
        'sat',
        'supply air temp',
        'discharge air temp',
        'dat',
        'discharge air temperature',
        'supply temp',
        'leaving air temp',
        'ahu supply temp',
        'sa temp',
        'supply-air temp',
        'ahu-sat',
        'lat',
      ],
    },
    {
      key: 'rat',
      label: 'Return Air Temperature',
      required: true,
      ashrae36Name: 'Return Air Temperature',
      ashrae36Section: '5.16',
      patterns: [/\brat\b/i, /return air temp/i, /ra temp/i, /ahu.?return/i, /return.?air.?temp/i],
      aliases: [
        'rat',
        'return air temp',
        'return temp',
        'ra temp',
        'ahu return temp',
        'return-air temp',
        'ahu-rat',
        'return air temperature',
      ],
    },
    {
      key: 'mat',
      label: 'Mixed Air Temperature',
      required: true,
      ashrae36Name: 'Mixed Air Temperature',
      ashrae36Section: '5.16',
      patterns: [/\bmat\b/i, /mixed air temp/i, /mix air temp/i, /mixing box temp/i, /post.?mix temp/i],
      aliases: [
        'mat',
        'mixed air temp',
        'mix air temp',
        'ahu mixed air temp',
        'mixing box temp',
        'mixed-air temp',
        'ahu-mat',
        'post-mix temp',
      ],
    },
    {
      key: 'oat',
      label: 'Outdoor Air Temperature',
      required: true,
      ashrae36Name: 'Outdoor Air Temperature',
      ashrae36Section: '5.16',
      patterns: [
        /\boat\b/i,
        /outdoor air temp/i,
        /outside air temp/i,
        /oa temp/i,
        /ambient temp/i,
        /outdoor temp/i,
        /external temp/i,
        /outside air dry bulb/i,
        /oa dry bulb/i,
      ],
      aliases: [
        'oat',
        'outdoor air temp',
        'outside air temp',
        'oa temp',
        'ambient temp',
        'outdoor temp',
        'oa-t',
        'ahu oat',
        'external temperature',
        'outside air dry bulb',
        'oa dry bulb',
      ],
    },
    {
      key: 'dsp',
      label: 'Duct Static Pressure',
      required: true,
      ashrae36Name: 'Duct Static Pressure',
      ashrae36Section: '5.16',
      patterns: [
        /\bdsp\b/i,
        /duct static pressure/i,
        /duct static/i,
        /static pressure/i,
        /supply duct.?sp/i,
        /duct.?sp/i,
        /ahu static/i,
        /sa static/i,
        /duct pressure/i,
        /dp duct/i,
      ],
      aliases: [
        'dsp',
        'duct static',
        'static pressure',
        'supply duct sp',
        'duct sp',
        'ahu static pressure',
        'supply duct static',
        'duct pressure',
        'sa static pressure',
        'duct-sp',
        'dp duct',
      ],
    },
    {
      key: 'oaFlow',
      label: 'Outdoor Air Flow',
      required: true,
      ashrae36Name: 'Outdoor Air Flow',
      ashrae36Section: '5.16',
      configFlag: 'hasOAFlow',
      patterns: [
        /oa.?flow/i,
        /outdoor air.?cfm/i,
        /oa.?airflow/i,
        /outside air flow/i,
        /ventilation airflow/i,
        /oa airflow station/i,
        /oa cfm/i,
        /minimum oa flow/i,
      ],
      aliases: [
        'oa flow',
        'outdoor air cfm',
        'oa airflow',
        'outdoor air volume flow',
        'oa volume',
        'outside air flow',
        'oa-flow',
        'oa cfm',
        'ventilation airflow',
        'oa airflow station',
        'outside air flow',
        'minimum oa flow',
      ],
    },
    {
      key: 'sfStatus',
      label: 'Supply Fan Status',
      required: true,
      ashrae36Name: 'Supply Fan Status',
      ashrae36Section: '5.16',
      patterns: [
        /supply fan.?run/i,
        /supply fan.?status/i,
        /sf.?status/i,
        /sf.?run/i,
        /ahu fan.?run/i,
        /ahu fan.?status/i,
        /fan.?run.?status/i,
        /supply fan.?vfd.?status/i,
        /supply fan enabled/i,
      ],
      aliases: [
        'supply fan run',
        'sf status',
        'supply fan proof',
        'fan run status',
        'ahu fan status',
        'supply fan on',
        'sf run',
        'fan status',
        'ahu fan run',
        'sa fan status',
        'supply fan vfd status',
        'supply fan enabled',
      ],
    },
    {
      key: 'sfSpeed',
      label: 'Supply Fan Speed',
      required: true,
      ashrae36Name: 'Supply Fan Speed',
      ashrae36Section: '5.16',
      patterns: [
        /supply fan.?speed/i,
        /sf.?speed/i,
        /supply.?vfd.?feedback/i,
        /sf.?hz/i,
        /fan speed feedback/i,
        /vfd speed feedback/i,
        /supply vfd feedback/i,
      ],
      aliases: [
        'sf speed',
        'supply fan vfd feedback',
        'fan speed feedback',
        'vfd speed feedback',
        'sf hz',
        'supply fan hz',
        'supply fan vfd speed',
        'sf vfd speed',
        'supply vfd feedback',
        'supply fan speed feedback',
      ],
    },
    {
      key: 'sfEnable',
      label: 'Supply Fan Enable Command',
      required: true,
      ashrae36Name: 'Supply Fan Enable Command',
      ashrae36Section: '5.16',
      patterns: [
        /supply fan.?enable/i,
        /sf.?enable/i,
        /supply fan.?command/i,
        /supply fan.?start/i,
        /supply fan.?on.?off/i,
      ],
      aliases: [
        'supply fan start/stop',
        'sf enable',
        'supply fan on/off',
        'ahu fan enable',
        'fan command',
        'sf command',
        'supply fan enable',
        'supply fan command',
        'supply fan start',
      ],
    },
    {
      key: 'sfSpeedCmd',
      label: 'Supply Fan Speed Command',
      required: true,
      ashrae36Name: 'Supply Fan Speed Command',
      ashrae36Section: '5.16',
      patterns: [
        /supply fan.?vfd.?speed/i,
        /sf.?vfd.?speed/i,
        /supply vfd speed/i,
        /supply fan speed.?set/i,
        /fan speed command/i,
      ],
      aliases: [
        'sf vfd speed',
        'supply fan vfd',
        'fan speed command',
        'sf speed setpoint',
        'supply fan speed setpoint',
        'supply fan vfd speed',
        'sf vfd speed',
        'supply vfd speed',
        'supply fan speed',
      ],
    },
    {
      key: 'oaDampCmd',
      label: 'OA Damper Position Command',
      required: true,
      ashrae36Name: 'Outdoor Air Damper Position Command',
      ashrae36Section: '5.16',
      configFlag: 'hasEconomizer',
      patterns: [/oa.?damper/i, /outdoor air damper/i, /econ.?damper/i, /oad.?position/i, /outside air damper/i],
      aliases: [
        'oa damper',
        'outdoor air damper',
        'economizer damper',
        'oa damper command',
        'oad position',
        'outside air damper',
        'oa-damper',
        'econ damper',
      ],
    },
    {
      key: 'raDampCmd',
      label: 'Return Air Damper Position Command',
      required: true,
      ashrae36Name: 'Return Air Damper Position Command',
      ashrae36Section: '5.16',
      configFlag: 'hasEconomizer',
      patterns: [/ra.?damper/i, /return air damper/i, /return damper/i, /rad.?position/i, /exhaust damper/i],
      aliases: [
        'ra damper',
        'return air damper',
        'return damper',
        'ra damper command',
        'rad position',
        'return-damper',
        'exhaust damper',
      ],
    },
    {
      key: 'clgValve',
      label: 'Cooling Coil Valve',
      required: true,
      ashrae36Name: 'Cooling Coil Valve Position Command',
      ashrae36Section: '5.16',
      configFlag: 'hasCHWCoil',
      patterns: [
        /chw.?valve/i,
        /cooling.?valve/i,
        /cooling coil valve/i,
        /ccv.?position/i,
        /chilled water valve/i,
        /clg.?valve/i,
        /cool valve/i,
      ],
      aliases: [
        'chw valve',
        'cooling valve',
        'cooling coil valve',
        'chw coil valve',
        'cool valve',
        'chilled water valve',
        'ccv position',
        'cooling-valve',
      ],
    },
    {
      key: 'htgValve',
      label: 'Heating Coil Valve',
      required: true,
      ashrae36Name: 'Heating Coil Valve Position Command',
      ashrae36Section: '5.16',
      configFlag: 'hasHWCoil',
      patterns: [
        /hw.?valve/i,
        /heating.?valve/i,
        /heating coil valve/i,
        /hcv.?position/i,
        /hot water valve/i,
        /htg.?valve/i,
        /preheat valve/i,
        /heat valve/i,
      ],
      aliases: [
        'hw valve',
        'heating valve',
        'heating coil valve',
        'hw coil valve',
        'heat valve',
        'hot water valve',
        'hcv position',
        'heating-valve',
        'preheat valve',
      ],
    },
    {
      key: 'freezeStat',
      label: 'Freeze Protection Status',
      required: true,
      ashrae36Name: 'Freeze Protection Status',
      ashrae36Section: '5.16',
      patterns: [
        /freeze.?stat/i,
        /freeze.?protect/i,
        /low.?temp.?cutout/i,
        /freeze.?alarm/i,
        /low.?limit/i,
        /frost.?stat/i,
        /low temp alarm/i,
      ],
      aliases: [
        'freeze stat',
        'freeze protection',
        'low temp cutout',
        'freeze thermostat',
        'low limit stat',
        'freezestat',
        'frost stat',
        'coil freeze stat',
        'freeze alarm',
        'low temp alarm',
      ],
    },
    {
      key: 'rfEnable',
      label: 'Return Fan Enable Command',
      required: false,
      ashrae36Name: 'Return Fan Enable Command',
      ashrae36Section: '5.16',
      configFlag: 'hasReturnFan',
      patterns: [
        /return fan.?enable/i,
        /rf.?enable/i,
        /return fan.?command/i,
        /return fan.?on.?off/i,
        /return fan.?start/i,
      ],
      aliases: [
        'return fan start/stop',
        'rf enable',
        'return fan on/off',
        'rf command',
        'return fan enable',
        'return fan command',
      ],
    },
    {
      key: 'rfSpeedCmd',
      label: 'Return Fan Speed Command',
      required: false,
      ashrae36Name: 'Return Fan Speed Command',
      ashrae36Section: '5.16',
      configFlag: 'hasReturnFan',
      patterns: [/rf.?vfd.?speed/i, /return fan.?vfd/i, /return fan speed/i, /rf.?speed/i],
      aliases: ['rf vfd speed', 'return fan vfd', 'return fan speed command', 'rf speed setpoint'],
    },
    {
      key: 'bldgPressure',
      label: 'Building Static Pressure',
      required: false,
      ashrae36Name: 'Building Static Pressure',
      ashrae36Section: '5.16',
      configFlag: 'hasReliefFan',
      patterns: [
        /building.?dp/i,
        /building.?pressure/i,
        /bldg.?static/i,
        /bldg.?dp/i,
        /building static/i,
        /building pressurization/i,
      ],
      aliases: [
        'building dp',
        'building pressure',
        'bldg pressure',
        'bldg static',
        'building static',
        'bldg dp',
        'building pressurization',
        'building-dp',
      ],
    },
    {
      key: 'co2',
      label: 'CO2 Sensor',
      required: false,
      ashrae36Name: 'CO2 Sensor (Return or Zone)',
      ashrae36Section: '5.16',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?sensor/i, /return co2/i, /zone.?co2/i, /co2.?ppm/i, /duct co2/i],
      aliases: [
        'co2',
        'carbon dioxide',
        'co2 sensor',
        'return co2',
        'zone co2',
        'co2 ppm',
        'duct co2',
        'return air co2',
      ],
    },
    {
      key: 'oaEnthalpy',
      label: 'Outdoor Air Enthalpy',
      required: false,
      ashrae36Name: 'Outdoor Air Enthalpy',
      ashrae36Section: '5.16',
      configFlag: 'hasEconomizer',
      patterns: [/oa.?enthalpy/i, /outdoor.?enthalpy/i, /outside air enthalpy/i, /enthalpy sensor/i],
      aliases: ['oa enthalpy', 'outdoor enthalpy', 'outside air enthalpy', 'oa-h', 'outdoor air h', 'enthalpy sensor'],
    },
  ],

  /* ── VAV (Single-Duct with Reheat, ASHRAE 36 §5.6) ────────────────── */
  vav: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: true,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: '5.6',
      patterns: [
        /zone.?temp/i,
        /room.?temp/i,
        /zone air temp/i,
        /space temp/i,
        /space temperature/i,
        /room temperature/i,
        /\bzat\b/i,
        /occ space temp/i,
        /t.?zone/i,
      ],
      aliases: [
        'zone temp',
        'room temp',
        'zone air temp',
        'space temp',
        'space temperature',
        'room temperature',
        'zone temperature',
        'tzone',
        't-zone',
        'zat',
        'zone-temp',
        'occ space temp',
      ],
    },
    {
      key: 'coolSP',
      label: 'Zone Cooling Setpoint',
      required: true,
      ashrae36Name: 'Zone Cooling Setpoint',
      ashrae36Section: '5.6',
      patterns: [
        /cooling.?setpoint/i,
        /cool.?setpoint/i,
        /zone.?cooling.?sp/i,
        /cooling.?sp\b/i,
        /t.?cool/i,
        /setpoint.*cooling occupied/i,
        /effective cooling setpoint/i,
        /cooling occupied setpoint/i,
      ],
      aliases: [
        'cooling setpoint',
        'cool setpoint',
        'zone cooling sp',
        'cooling sp',
        't-cool',
        'tcool',
        'cooling temp sp',
        'zone cool sp',
        'setpoint / cooling occupied setpoint',
        'setpoint / effective cooling setpoint',
        'cooling occupied setpoint',
        'effective cooling setpoint',
        'zone cooling setpoint',
      ],
    },
    {
      key: 'htgSP',
      label: 'Zone Heating Setpoint',
      required: true,
      ashrae36Name: 'Zone Heating Setpoint',
      ashrae36Section: '5.6',
      patterns: [
        /heating.?setpoint/i,
        /heat.?setpoint/i,
        /zone.?heating.?sp/i,
        /heating.?sp\b/i,
        /t.?heat/i,
        /setpoint.*heating occupied/i,
        /effective heating setpoint/i,
        /heating occupied setpoint/i,
      ],
      aliases: [
        'heating setpoint',
        'heat setpoint',
        'zone heating sp',
        'heating sp',
        't-heat',
        'theat',
        'heating temp sp',
        'zone heat sp',
        'setpoint / heating occupied setpoint',
        'setpoint / effective heating setpoint',
        'heating occupied setpoint',
        'effective heating setpoint',
        'zone heating setpoint',
      ],
    },
    {
      key: 'discFlow',
      label: 'Discharge Airflow',
      required: true,
      ashrae36Name: 'Discharge Airflow',
      ashrae36Section: '5.6',
      patterns: [
        /discharge.?airflow/i,
        /zone.?airflow/i,
        /box.?airflow/i,
        /vav.?flow/i,
        /vav.?cfm/i,
        /primary.?airflow/i,
        /disc.?flow/i,
        /box.?cfm/i,
        /zone.?cfm/i,
        /air.?flow/i,
        /\bcfm\b/i,
        /flow control/i,
        /flow input/i,
        /air volume/i,
      ],
      aliases: [
        'zone airflow',
        'box airflow',
        'vav flow',
        'vav cfm',
        'primary airflow',
        'discharge flow',
        'box cfm',
        'zone cfm',
        'vav box flow',
        'primary flow',
        'air volume',
        'flow rate',
        'flow control',
        'flow input',
        'air flow',
        'airflow',
        'zone air flow',
        'cfm',
        'discharge cfm',
        'flow control / flow input',
      ],
    },
    {
      key: 'dat',
      label: 'Discharge Air Temperature',
      required: true,
      ashrae36Name: 'Discharge Air Temperature',
      ashrae36Section: '5.6',
      patterns: [
        /discharge air temp/i,
        /\bdat\b/i,
        /leaving air temp/i,
        /box discharge temp/i,
        /reheat discharge/i,
        /zone discharge/i,
        /\btdis\b/i,
        /t.?discharge/i,
        /discharge temp/i,
        /supply temperature/i,
      ],
      aliases: [
        'dat',
        'discharge air temp',
        'leaving air temp',
        'box discharge temp',
        'reheat discharge temp',
        'zone discharge temp',
        'discharge temp',
        'tdis',
        't-discharge',
        'supply temperature',
        'zone supply temp',
      ],
    },
    {
      key: 'fanStatus',
      label: 'AHU Supply Fan Status',
      required: true,
      ashrae36Name: 'AHU Supply Fan Status',
      ashrae36Section: '5.6',
      patterns: [
        /ahu fan.?status/i,
        /supply fan.?status/i,
        /fan.?run.?status/i,
        /ahu fan.?run/i,
        /fan status/i,
        /air source status/i,
      ],
      aliases: [
        'fan status',
        'ahu fan status',
        'supply fan status',
        'ahu fan run',
        'fan run status',
        'air source status',
        'primary air source status',
      ],
    },
    {
      key: 'dampCmd',
      label: 'Damper Position Command',
      required: true,
      ashrae36Name: 'Damper Position Command',
      ashrae36Section: '5.6',
      patterns: [
        /damper.?position/i,
        /vav.?damper/i,
        /box.?damper/i,
        /damper.?command/i,
        /damper.?signal/i,
        /air.?valve/i,
        /zone.?damper/i,
      ],
      aliases: [
        'damper position',
        'vav damper',
        'box damper',
        'damper command',
        'damper signal',
        'air valve',
        'zone damper',
        'damper-position',
        'air damper',
      ],
    },
    {
      key: 'reheatValve',
      label: 'Reheat Valve Position Command',
      required: false,
      ashrae36Name: 'Reheat Valve Position Command',
      ashrae36Section: '5.6',
      configFlag: 'hasReheat',
      patterns: [
        /reheat.?valve/i,
        /hw.?reheat/i,
        /heating.?valve/i,
        /hot water valve/i,
        /hw.?valve/i,
        /zone.?hw.?valve/i,
        /reheat coil valve/i,
        /heating coil valve/i,
      ],
      aliases: [
        'reheat valve',
        'hw reheat valve',
        'heating valve',
        'hot water valve',
        'reheat coil valve',
        'hw valve',
        'zone hw valve',
        'reheat-valve',
        'heating coil valve',
      ],
    },
    {
      key: 'hwPlantStatus',
      label: 'Hot Water Plant Status',
      required: false,
      ashrae36Name: 'Hot Water Plant Status',
      ashrae36Section: '5.6',
      configFlag: 'hasReheat',
      patterns: [
        /hw.?plant.?status/i,
        /heat.?source.?status/i,
        /heating.?source.?status/i,
        /hw plant on.?off/i,
        /heating plant status/i,
      ],
      aliases: [
        'hw plant status',
        'hw plant on/off',
        'heating plant status',
        'boiler plant status',
        'heat source status',
        'heating source status',
        'heat source mode',
        'heating source mode',
      ],
    },
    {
      key: 'ahuSAT',
      label: 'AHU Supply Air Temperature',
      required: false,
      ashrae36Name: 'AHU Supply Air Temperature',
      ashrae36Section: '5.6',
      patterns: [
        /ahu.?sat/i,
        /system.?sat/i,
        /ahu.?supply.?temp/i,
        /central.?sat/i,
        /air source supply/i,
        /primary air supply temp/i,
      ],
      aliases: [
        'ahu sat',
        'system sat',
        'ahu supply temp',
        'supply air temp',
        'sat',
        'central sat',
        'system supply temp',
        'air source supply temp',
        'air source supply',
        'primary air supply temp',
      ],
    },
    {
      key: 'co2',
      label: 'Zone CO2 Sensor',
      required: false,
      ashrae36Name: 'Zone CO2 Concentration',
      ashrae36Section: '5.6',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?ppm/i, /zone.?co2/i],
      aliases: ['zone co2', 'room co2', 'co2 sensor', 'co2 ppm', 'carbon dioxide', 'space co2'],
    },
  ],

  /* ── FPB (Fan-Powered Box — Parallel or Series, ASHRAE 36 §5.7/5.8) ─ */
  fpb: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: true,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: '5.7',
      patterns: [/zone.?temp/i, /room.?temp/i, /space temp/i, /\bzat\b/i],
      aliases: ['zone temp', 'room temp', 'zone air temp', 'space temp', 'space temperature', 'zat', 'zone-temp'],
    },
    {
      key: 'coolSP',
      label: 'Zone Cooling Setpoint',
      required: true,
      ashrae36Name: 'Zone Cooling Setpoint',
      ashrae36Section: '5.7',
      patterns: [/cooling.?setpoint/i, /cool.?setpoint/i, /t.?cool/i, /cooling occupied setpoint/i],
      aliases: [
        'cooling setpoint',
        'cool setpoint',
        'zone cooling sp',
        't-cool',
        'cooling sp',
        'cooling occupied setpoint',
      ],
    },
    {
      key: 'htgSP',
      label: 'Zone Heating Setpoint',
      required: true,
      ashrae36Name: 'Zone Heating Setpoint',
      ashrae36Section: '5.7',
      patterns: [/heating.?setpoint/i, /heat.?setpoint/i, /t.?heat/i, /heating occupied setpoint/i],
      aliases: [
        'heating setpoint',
        'heat setpoint',
        'zone heating sp',
        't-heat',
        'heating sp',
        'heating occupied setpoint',
      ],
    },
    {
      key: 'primaryFlow',
      label: 'Primary (Cold Deck) Airflow',
      required: true,
      ashrae36Name: 'Primary (Cold Deck) Airflow',
      ashrae36Section: '5.7',
      patterns: [
        /primary.?airflow/i,
        /cold.?deck.?flow/i,
        /vav.?primary.?flow/i,
        /box.?primary.?cfm/i,
        /primary.?cfm/i,
        /primary air volume/i,
        /vav.?flow/i,
        /box.?airflow/i,
        /zone.?airflow/i,
        /air.?flow/i,
        /flow control/i,
        /flow input/i,
      ],
      aliases: [
        'primary airflow',
        'cold deck flow',
        'vav primary flow',
        'box primary cfm',
        'primary cfm',
        'vpri_flow',
        'primary air volume',
        'vav flow',
        'box airflow',
        'zone airflow',
        'flow control',
        'flow input',
      ],
    },
    {
      key: 'dat',
      label: 'Discharge Air Temperature',
      required: true,
      ashrae36Name: 'Discharge Air Temperature',
      ashrae36Section: '5.7',
      patterns: [/discharge air temp/i, /\bdat\b/i, /reheat discharge/i, /\btdis\b/i, /supply temperature/i],
      aliases: [
        'dat',
        'discharge air temp',
        'box discharge temp',
        'reheat discharge temp',
        'tdis',
        'discharge temp',
        'supply temperature',
      ],
    },
    {
      key: 'termFanStatus',
      label: 'Terminal Fan Status',
      required: true,
      ashrae36Name: 'Terminal Fan Status',
      ashrae36Section: '5.7',
      patterns: [
        /term.?fan.?status/i,
        /box.?fan.?status/i,
        /terminal.?fan.?run/i,
        /fan.?proof/i,
        /plenum fan/i,
        /\bu1terfan\b/i,
      ],
      aliases: ['term fan status', 'box fan status', 'terminal fan run', 'fan proof', 'plenum fan status', 'u1terfan'],
    },
    {
      key: 'fanStatus',
      label: 'AHU Supply Fan Status',
      required: true,
      ashrae36Name: 'AHU Supply Fan Status',
      ashrae36Section: '5.7',
      patterns: [/ahu fan.?status/i, /supply fan.?status/i, /fan status/i, /air source status/i],
      aliases: ['fan status', 'ahu fan status', 'supply fan status', 'ahu fan run', 'air source status'],
    },
    {
      key: 'dampCmd',
      label: 'Primary Damper Position Command',
      required: true,
      ashrae36Name: 'Primary Damper Position Command',
      ashrae36Section: '5.7',
      patterns: [/primary.?damper/i, /damper.?position/i, /vav.?damper/i, /box.?damper/i, /cold.?deck.?damper/i],
      aliases: ['damper position', 'primary damper', 'cold deck damper', 'vav damper', 'box damper'],
    },
    {
      key: 'termFanEnable',
      label: 'Terminal Fan Enable Command',
      required: true,
      ashrae36Name: 'Terminal Fan Enable Command',
      ashrae36Section: '5.7',
      patterns: [/term.?fan.?enable/i, /box.?fan.?enable/i, /terminal.?fan.?command/i, /\by1fan\b/i, /fan.?enable/i],
      aliases: [
        'term fan enable',
        'box fan enable',
        'terminal fan command',
        'plenum fan command',
        'fan enable',
        'y1fan',
      ],
    },
    {
      key: 'reheatValve',
      label: 'Reheat Valve Position Command',
      required: false,
      ashrae36Name: 'Reheat Valve Position Command',
      ashrae36Section: '5.7',
      configFlag: 'hasReheat',
      patterns: [/reheat.?valve/i, /hw.?reheat/i, /heating.?valve/i, /hot water valve/i, /hw.?valve/i],
      aliases: ['reheat valve', 'hw reheat valve', 'heating valve', 'hot water valve', 'hw valve'],
    },
    {
      key: 'termFanSpeed',
      label: 'Terminal Fan Speed Command',
      required: false,
      ashrae36Name: 'Terminal Fan Speed Command',
      ashrae36Section: '5.8',
      configFlag: 'isSeries',
      patterns: [
        /term.?fan.?speed/i,
        /box.?fan.?vfd/i,
        /series.?fan.?speed/i,
        /terminal.?fan.?vfd/i,
        /fan speed command/i,
      ],
      aliases: [
        'term fan speed',
        'box fan vfd',
        'series fan speed',
        'terminal fan vfd',
        'fan speed command',
        'vfan_flow_set',
      ],
    },
  ],

  /* ── DDVAV (Dual Duct VAV, ASHRAE 36 §5.13) ────────────────────────── */
  ddvav: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: true,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: '5.13',
      patterns: [/zone.?temp/i, /room.?temp/i, /space temp/i, /\bzat\b/i],
      aliases: ['zone temp', 'room temp', 'zone air temp', 'space temp', 'space temperature', 'zat', 'zone-temp'],
    },
    {
      key: 'coolSP',
      label: 'Zone Cooling Setpoint',
      required: true,
      ashrae36Name: 'Zone Cooling Setpoint',
      ashrae36Section: '5.13',
      patterns: [/cooling.?setpoint/i, /cool.?setpoint/i, /t.?cool/i],
      aliases: ['cooling setpoint', 'cool setpoint', 'zone cooling sp', 't-cool', 'cooling sp'],
    },
    {
      key: 'htgSP',
      label: 'Zone Heating Setpoint',
      required: true,
      ashrae36Name: 'Zone Heating Setpoint',
      ashrae36Section: '5.13',
      patterns: [/heating.?setpoint/i, /heat.?setpoint/i, /t.?heat/i],
      aliases: ['heating setpoint', 'heat setpoint', 'zone heating sp', 't-heat', 'heating sp'],
    },
    {
      key: 'discFlow',
      label: 'Discharge Airflow',
      required: true,
      ashrae36Name: 'Discharge Airflow',
      ashrae36Section: '5.13',
      patterns: [
        /discharge.?flow/i,
        /total.?discharge.?cfm/i,
        /box.?airflow/i,
        /zone.?airflow/i,
        /discharge.?cfm/i,
        /mixed.?discharge/i,
        /air.?flow/i,
        /flow control/i,
      ],
      aliases: [
        'discharge flow',
        'total discharge cfm',
        'box airflow',
        'zone airflow',
        'discharge cfm',
        'mixed discharge flow',
        'air flow',
        'flow control',
      ],
    },
    {
      key: 'fanStatus',
      label: 'AHU Supply Fan Status',
      required: true,
      ashrae36Name: 'AHU Supply Fan Status',
      ashrae36Section: '5.13',
      patterns: [/ahu fan.?status/i, /supply fan.?status/i, /fan status/i, /air source status/i],
      aliases: ['fan status', 'ahu fan status', 'supply fan status', 'air source status'],
    },
    {
      key: 'coldDampCmd',
      label: 'Cold Deck Damper Position Command',
      required: true,
      ashrae36Name: 'Cold Deck Damper Position Command',
      ashrae36Section: '5.13',
      patterns: [/cold.?deck.?damper/i, /cold.?damper/i, /cooling.?damper/i, /supply.?damper/i, /cold air damper/i],
      aliases: [
        'cold deck damper',
        'cold damper',
        'cooling damper',
        'cold duct damper',
        'supply damper',
        'cold air damper',
      ],
    },
    {
      key: 'hotDampCmd',
      label: 'Hot Deck Damper Position Command',
      required: true,
      ashrae36Name: 'Hot Deck Damper Position Command',
      ashrae36Section: '5.13',
      patterns: [/hot.?deck.?damper/i, /hot.?damper/i, /heating.?damper/i, /warm.?damper/i, /hot air damper/i],
      aliases: ['hot deck damper', 'hot damper', 'heating damper', 'hot duct damper', 'warm damper', 'hot air damper'],
    },
  ],

  /* ── HWP (Hot Water Plant, ASHRAE 36 §5.19) ────────────────────────── */
  hwp: [
    {
      key: 'hwst',
      label: 'Hot Water Supply Temperature',
      required: true,
      ashrae36Name: 'Hot Water Supply Temperature',
      ashrae36Section: '5.19',
      patterns: [
        /\bhwst\b/i,
        /hw.?supply.?temp/i,
        /hot.?water.?supply/i,
        /heating.?water.?supply/i,
        /boiler.?supply.?temp/i,
        /\bhws\b.?temp/i,
        /supply.?water.?temp/i,
        /system supply/i,
        /supply temp/i,
        /boiler.*supply.*water.*temp/i,
      ],
      aliases: [
        'hwst',
        'hw supply temp',
        'hot water supply temp',
        'leaving hw temp',
        'boiler supply temp',
        'heating water supply temp',
        'hws temp',
        'hw-st',
        'hw_st',
        'boiler lwt',
        'loop supply temp',
        'heating water supply temperature',
        'boiler 1 heating water supply temperature',
        'boiler 2 heating water supply temperature',
        'boiler 1 supply water temperature',
        'boiler 2 supply water temperature',
        'supply water temperature',
        'system supply',
        'supply temp',
        'hw supply',
        'hot water supply',
        'hws temp',
      ],
    },
    {
      key: 'hwrt',
      label: 'Hot Water Return Temperature',
      required: true,
      ashrae36Name: 'Hot Water Return Temperature',
      ashrae36Section: '5.19',
      patterns: [
        /\bhwrt\b/i,
        /hw.?return.?temp/i,
        /hot.?water.?return/i,
        /heating.?water.?return/i,
        /boiler.?return/i,
        /return.?temp/i,
        /return.?water.?temp/i,
      ],
      aliases: [
        'hwrt',
        'hw return temp',
        'hot water return temp',
        'entering hw temp',
        'boiler return temp',
        'heating water return temp',
        'hwr temp',
        'hw-rt',
        'hw_rt',
        'loop return temp',
        'heating water return temperature',
        'boiler return',
        'return temperature',
        'boiler 1 return water temperature',
        'boiler 2 return water temperature',
        'return water temperature',
        'return temp av',
        'return temp',
        'hw return',
        'hot water return',
      ],
    },
    {
      key: 'hwdp',
      label: 'Hot Water Differential Pressure',
      required: true,
      ashrae36Name: 'Hot Water Differential Pressure',
      ashrae36Section: '5.19',
      patterns: [
        /\bhwdp\b/i,
        /hw.?dp\b/i,
        /hot.?water.?dp/i,
        /hw.?differential/i,
        /heating.?water.?dp/i,
        /hw.?system.?dp/i,
        /heating.?loop.?dp/i,
        /hw.?diff.?press/i,
        /hot water loop dp/i,
        /differential pressure \d/i,
        /system differential pressure/i,
      ],
      aliases: [
        'hw dp',
        'hwdp',
        'hot water dp',
        'heating water dp',
        'hw differential pressure',
        'hw system dp',
        'secondary hw dp',
        'heating loop dp',
        'hw-dp',
        'hw_dp',
        'heating dp',
        'hot water loop dp',
        'hot water loop differential pressure',
        'differential pressure 1',
        'differential pressure 2',
        'hot water differential pressure',
        'system differential pressure',
        'hw sdp',
        'hw system dp',
        'high hot water loop differential pressure',
        'low hot water loop differential pressure',
      ],
    },
    {
      key: 'hwFlow',
      label: 'Hot Water Flow',
      required: false,
      ashrae36Name: 'Hot Water Flow',
      ashrae36Section: '5.19',
      configFlag: 'hasFlowMeter',
      patterns: [/hw.?flow/i, /\bhwfm\b/i, /hot.?water.?flow/i, /heating.?water.?flow/i, /boiler.?loop.?flow/i],
      aliases: [
        'hw flow',
        'hwfm',
        'hot water flow rate',
        'heating water flow',
        'primary hw flow',
        'hw gpm',
        'boiler loop flow',
        'hw volume flow',
      ],
    },
    {
      key: 'oat',
      label: 'Outdoor Air Temperature',
      required: true,
      ashrae36Name: 'Outdoor Air Temperature',
      ashrae36Section: '5.19',
      patterns: [/\boat\b/i, /outdoor air temp/i, /outside air temp/i, /oa temp/i, /ambient temp/i],
      aliases: [
        'oat',
        'outdoor air temp',
        'outside air temp',
        'oa temp',
        'ambient temp',
        'outdoor temp',
        'oa-t',
        'external temperature',
      ],
    },
    {
      key: 'boilerStatus',
      label: 'Boiler Status',
      required: true,
      ashrae36Name: 'Boiler Status',
      ashrae36Section: '5.19',
      patterns: [
        /boiler.?run.?status/i,
        /boiler.?alarm/i,
        /boiler.?fault/i,
        /boiler.?status/i,
        /boiler.?on.?off/i,
        /boiler.?\d+.?status/i,
        /boiler.?system.?alarm/i,
        /\bb-1b.?status/i,
        /\bb-2b.?status/i,
      ],
      aliases: [
        'boiler run status',
        'boiler alarm',
        'boiler fault',
        'boiler enable status',
        'boiler proof',
        'boiler on/off status',
        'boiler 1 status',
        'boiler 2 status',
        'boiler 3 status',
        'b-1 status',
        'boiler 1 run',
        'boiler 2 run',
        'boiler 3 run',
        'boiler b-1b status',
        'boiler b-2b status',
        'boiler system alarm',
        'boiler 1 alarm',
        'boiler 2 alarm',
        'boiler 3 alarm',
        'boiler status',
        'boiler 1 alarm bni',
        'boiler 2 alarm bni',
      ],
    },
    {
      key: 'hwPumpStatus',
      label: 'Primary HW Pump Status',
      required: true,
      ashrae36Name: 'Primary Hot Water Pump Status',
      ashrae36Section: '5.19',
      patterns: [
        /phwp.?status/i,
        /primary.?hw.?pump.?status/i,
        /primary.?pump.?run/i,
        /hw.?pump.?status/i,
        /hot.?water.?pump.?\d*.?status/i,
        /hhwp.?\d.?vfd.?status/i,
        /pump.?p.?\d.?status/i,
      ],
      aliases: [
        'phwp status',
        'primary hw pump status',
        'primary pump run',
        'hw primary pump proof',
        'boiler pump status',
        'primary hwp status',
        'hot water pump 1 status',
        'hot water pump 2 status',
        'hot water pump 3 status',
        'hot water pump 4 status',
        'hot water pump 1 fault',
        'hot water pump 2 fault',
        'hhwp-1 vfd status',
        'hhwp-2 vfd status',
        'pump p-1 vfd status',
        'pump p-2 vfd status',
        'hw pump a status',
        'hw pump status',
        'pump p-1 status',
        'pump p-2 status',
      ],
    },
    {
      key: 'hwIsoValve',
      label: 'HW Isolation Valve Status',
      required: false,
      ashrae36Name: 'HW Isolation Valve Status',
      ashrae36Section: '5.19',
      configFlag: 'hasIsoValves',
      patterns: [
        /boiler.?iso.?valve/i,
        /hw.?isolation.?valve/i,
        /hw.?iso.?valve/i,
        /boiler.?\d+.?isolation.?valve/i,
        /boiler shutoff valve/i,
      ],
      aliases: [
        'boiler iso valve',
        'hw isolation valve',
        'boiler shutoff valve',
        'boiler hw valve status',
        'hw shutoff valve',
        'boiler 1 isolation valve',
        'boiler 2 isolation valve',
        'hw isolation valve',
        'boiler isolation valve status',
        'hw iso valve',
      ],
    },
    {
      key: 'boilerEnable',
      label: 'Boiler Enable Command',
      required: true,
      ashrae36Name: 'Boiler Enable Command',
      ashrae36Section: '5.19',
      patterns: [
        /boiler.?enable/i,
        /boiler.?start.?stop/i,
        /boiler.?command/i,
        /boiler.?on.?command/i,
        /boiler.?system.?enable/i,
      ],
      aliases: [
        'boiler start/stop',
        'boiler enable',
        'boiler command',
        'boiler on command',
        'boiler 1 enable',
        'boiler 2 enable',
        'boiler 3 enable',
        'boiler system enable',
        'boiler enable / set point',
      ],
    },
    {
      key: 'hwSetpoint',
      label: 'Boiler HW Supply Temperature Setpoint',
      required: true,
      ashrae36Name: 'Boiler HW Supply Temperature Setpoint',
      ashrae36Section: '5.19',
      patterns: [
        /boiler.?lwt.?setpoint/i,
        /hw.?setpoint/i,
        /hw.?set.?point/i,
        /boiler.?setpoint/i,
        /hw.?supply.?setpoint/i,
        /hw.?temp.?setpoint/i,
        /boiler.?outlet.?setpoint/i,
        /hw.?reset/i,
      ],
      aliases: [
        'boiler lwt setpoint',
        'boiler setpoint',
        'hw setpoint',
        'boiler supply temp setpoint',
        'boiler temp setpoint',
        'boiler system set point reference',
        'hw setpoint av',
        'boiler 1 outlet setpoint',
        'boiler 2 outlet setpoint',
        'boiler outlet setpoint',
        'hw setpoint ani',
        'boiler hw reset',
        'hw set point av',
        'hw reset',
        'hw supply setpoint',
        'hw set point',
        'hws setpoint',
        'supply setpoint',
      ],
    },
    {
      key: 'hwPumpEnable',
      label: 'Primary HW Pump Enable Command',
      required: true,
      ashrae36Name: 'Primary HW Pump Enable Command',
      ashrae36Section: '5.19',
      patterns: [
        /primary.?hw.?pump.?enable/i,
        /phwp.?enable/i,
        /hw.?pump.?\w+.?enable/i,
        /hot.?water.?pump.?\d+.?enable/i,
        /hhwp.?\d.?vfd.?enable/i,
        /pump.?p.?\d.?enable/i,
      ],
      aliases: [
        'primary hw pump start/stop',
        'phwp enable',
        'boiler pump command',
        'hot water pump 1 enable',
        'hot water pump 2 enable',
        'hot water pump 3 enable',
        'hot water pump 4 enable',
        'hhwp-1 vfd enable',
        'hhwp-2 vfd enable',
        'pump p-1 vfd enable',
        'pump p-2 vfd enable',
        'pump p-1 enable',
        'hw pump a enable',
      ],
    },
    {
      key: 'hwPumpSpeed',
      label: 'Primary HW Pump Speed Command',
      required: true,
      ashrae36Name: 'Primary HW Pump Speed Command',
      ashrae36Section: '5.19',
      patterns: [
        /primary.?hw.?pump.?vfd/i,
        /phwp.?speed/i,
        /hw.?pump.?speed/i,
        /hot.?water.?pump.?\d+.?speed/i,
        /hhwp.?\d.?vfd.?signal/i,
        /pump.?p.?\d.?speed/i,
      ],
      aliases: [
        'primary hw pump vfd speed',
        'phwp speed command',
        'boiler pump speed',
        'primary hw vfd',
        'hot water pump 1 speed',
        'hot water pump 2 speed',
        'hot water pump 3 speed',
        'hot water pump 4 speed',
        'pump 3 vfd speed',
        'pump 4 vfd speed',
        'pump 3 speed ani',
        'pump 4 speed ani',
        'hhwp-1 vfd signal',
        'hhwp-2 vfd signal',
        'pump p-1 speed',
        'pump p-2 speed',
        'hw pump speed',
      ],
    },
    {
      key: 'secHWPumpStatus',
      label: 'Secondary HW Pump Status',
      required: false,
      ashrae36Name: 'Secondary Hot Water Pump Status',
      ashrae36Section: '5.19',
      configFlag: 'hasSecPump',
      patterns: [
        /shwp.?status/i,
        /secondary.?hw.?pump.?status/i,
        /secondary.?pump.?run/i,
        /dist.?hwp.?status/i,
        /sec.?pump.?status/i,
      ],
      aliases: [
        'shwp status',
        'secondary hw pump status',
        'secondary pump run',
        'distribution hw pump status',
        'dist hwp status',
        'secondary hwp status',
        'sec pump status',
        'hw sec pump status',
      ],
    },
    {
      key: 'hwIsoValveCmd',
      label: 'HW Isolation Valve Command',
      required: false,
      ashrae36Name: 'HW Isolation Valve Command',
      ashrae36Section: '5.19',
      configFlag: 'hasIsoValves',
      patterns: [
        /boiler.?iso.?valve.?command/i,
        /hw.?isolation.?valve.?command/i,
        /boiler.?\d+.?isolation.?valve.?enable/i,
        /boiler.?isolation.?valve.?enable/i,
      ],
      aliases: [
        'boiler iso valve command',
        'hw isolation valve command',
        'boiler shutoff valve command',
        'boiler 1 isolation valve enable',
        'boiler 2 isolation valve enable',
        'boiler isolation valve enable',
      ],
    },
  ],

  /* ── CHWP (Chilled Water Plant, ASHRAE 36 §5.20) ───────────────────── */
  chwp: [
    {
      key: 'chwst',
      label: 'CHW Supply Temperature',
      required: true,
      ashrae36Name: 'Chilled Water Supply Temperature',
      ashrae36Section: '5.20',
      patterns: [
        /\bchwst\b/i,
        /chw.?supply.?temp/i,
        /chilled.?water.?supply.?temp/i,
        /leaving.?chilled.?water/i,
        /\blchwt\b/i,
        /\blwt\b/i,
        /chiller.?plant.?supply/i,
        /\bchws\b.?temp/i,
      ],
      aliases: [
        'chwst',
        'chw supply temp',
        'chilled water supply temp',
        'leaving chilled water temp',
        'lchwt',
        'lwt',
        'supply chw temp',
        'chiller plant supply temp',
        'chw-st',
        'chw_st',
        'chws temp',
        'cw supply temp',
      ],
    },
    {
      key: 'chwrt',
      label: 'CHW Return Temperature',
      required: true,
      ashrae36Name: 'Chilled Water Return Temperature',
      ashrae36Section: '5.20',
      patterns: [
        /\bchwrt\b/i,
        /chw.?return.?temp/i,
        /chilled.?water.?return.?temp/i,
        /entering.?chilled.?water/i,
        /\bechwt\b/i,
      ],
      aliases: [
        'chwrt',
        'chw return temp',
        'chilled water return temp',
        'entering chilled water temp',
        'echwt',
        'ewt',
        'return chw temp',
        'chw-rt',
        'chw_rt',
        'chwr temp',
      ],
    },
    {
      key: 'chwdp',
      label: 'CHW Differential Pressure',
      required: true,
      ashrae36Name: 'Chilled Water Differential Pressure',
      ashrae36Section: '5.20',
      patterns: [
        /chw.?dp\b/i,
        /\bchwdp\b/i,
        /chw.?differential/i,
        /chilled.?water.?dp/i,
        /chw.?system.?dp/i,
        /chw.?loop.?dp/i,
        /chilled.?water.?loop.?dp/i,
        /chw.?system.?differential/i,
        /chilled.?water.?loop.?differential/i,
        /system.?diff.?pressure/i,
      ],
      aliases: [
        'chw dp',
        'chwdp',
        'chw differential pressure',
        'chilled water dp',
        'chw system dp',
        'secondary chw dp',
        'distribution dp',
        'chw header dp',
        'chilled water pressure differential',
        'chw-dp',
        'chw_dp',
        'chilled-water loop dp',
        'chilled water loop dp',
        'chilled water differential pressure av',
        'chilled water loop differential pressure',
        'system diff pressure',
        'chw system differential pressure',
        'chw sdp',
      ],
    },
    {
      key: 'chillerEvapDP',
      label: 'Chiller Evaporator DP',
      required: false,
      ashrae36Name: 'Chiller Evaporator Differential Pressure',
      ashrae36Section: '5.20',
      patterns: [
        /chiller.?evap.?dp/i,
        /evaporator.?dp/i,
        /chiller.?dp\b/i,
        /chiller.?flow.?dp/i,
        /chiller.?min.?flow.?dp/i,
        /chiller.?\d+.?evap.?diff/i,
      ],
      aliases: [
        'chiller dp',
        'evaporator dp',
        'chiller evap dp',
        'primary loop dp',
        'chw evaporator pressure drop',
        'chiller flow pressure drop',
        'chiller 1 evap diff pressure',
        'chiller 2 evap diff pressure',
        'chiller evap diff pressure',
        'chiller 1 evaporator return pressure',
        'chiller 2 evaporator return pressure',
        'chilled water pump 1 dp',
        'chilled water pump 2 dp',
        'chiller minimum flow dp sensor',
        'chiller evap dp',
        'chiller flow dp',
        'chiller minimum flow dp',
      ],
    },
    {
      key: 'chwFlow',
      label: 'Chilled Water Flow',
      required: false,
      ashrae36Name: 'Chilled Water Flow',
      ashrae36Section: '5.20',
      configFlag: 'hasFlowMeter',
      patterns: [/chw.?flow/i, /chilled.?water.?flow/i, /chiller.?flow\b/i, /onicon.?tons/i],
      aliases: [
        'chw flow',
        'chwf',
        'chilled water flow rate',
        'primary chw flow',
        'chw gpm',
        'chiller flow',
        'primary flow',
        'chw volume flow',
        'chw-flow',
        'chw_flow',
        'chilled water supply flow',
        'chilled water flow input',
        'secondary chilled water flow',
        'schwf',
        'onicon tons',
      ],
    },
    {
      key: 'oat',
      label: 'Outdoor Air Temperature',
      required: true,
      ashrae36Name: 'Outdoor Air Temperature',
      ashrae36Section: '5.20',
      patterns: [/\boat\b/i, /outdoor air temp/i, /outside air temp/i, /oa temp/i, /ambient temp/i],
      aliases: [
        'oat',
        'outdoor air temp',
        'outside air temp',
        'oa temp',
        'ambient temp',
        'outdoor temp',
        'external temperature',
      ],
    },
    {
      key: 'chillerStatus',
      label: 'Chiller Status',
      required: true,
      ashrae36Name: 'Chiller Status',
      ashrae36Section: '5.20',
      patterns: [
        /chiller.?run.?status/i,
        /chiller.?on.?off/i,
        /chiller.?fault/i,
        /chiller.?alarm/i,
        /chiller.?status/i,
        /chiller.?running.?state/i,
        /chiller.?\d+.?status/i,
        /chiller.?\d+.?alarm/i,
      ],
      aliases: [
        'chiller run status',
        'chiller on/off status',
        'chiller fault',
        'chiller alarm',
        'chiller enable status',
        'chiller proof',
        'chiller run proof',
        'ch status',
        'ch-1 status',
        'chiller 1 status',
        'chiller 2 status',
        'chiller running state',
        'chiller general alarm',
        'chiller 1 general alarm',
        'chiller 2 general alarm',
      ],
    },
    {
      key: 'pchwpStatus',
      label: 'Primary CHW Pump Status',
      required: true,
      ashrae36Name: 'Primary Chilled Water Pump Status',
      ashrae36Section: '5.20',
      configFlag: 'hasPrimary',
      patterns: [
        /pchwp.?status/i,
        /primary.?chw.?pump.?status/i,
        /chw.?pump.?\d+.?status/i,
        /chwp.?\w+.?dp.?status/i,
        /chwp.?\d+.?status/i,
        /chilled.?water.?pump.?\d+.?status/i,
        /chilled.?water.?pump.?\d+.?vfd.?status/i,
      ],
      aliases: [
        'pchwp status',
        'primary chw pump status',
        'primary pump run',
        'primary pump proof',
        'p-chw pump status',
        'primary cwp status',
        'chiller pump status',
        'pcw pump status',
        'chw pump 1 status',
        'chw pump 2 status',
        'chilled water pump 1 status',
        'chilled water pump 2 status',
        'chilled water pump 1 vfd status',
        'chilled water pump 2 vfd status',
        'chwp a dp status',
        'chwp-1 status',
      ],
    },
    {
      key: 'schwpStatus',
      label: 'Secondary CHW Pump Status',
      required: false,
      ashrae36Name: 'Secondary Chilled Water Pump Status',
      ashrae36Section: '5.20',
      configFlag: 'hasSecPump',
      patterns: [/schwp.?status/i, /secondary.?chw.?pump.?status/i, /chwp.?\w+b.?status/i, /chwp.?\d+b.?status/i],
      aliases: [
        'schwp status',
        'secondary chw pump status',
        'secondary pump run',
        'secondary pump proof',
        's-chw pump status',
        'distribution pump status',
        'dist pump status',
        'chwp b vfd status',
        'chwp-2 status',
      ],
    },
    {
      key: 'schwpSpeed',
      label: 'Secondary CHW Pump Speed',
      required: false,
      ashrae36Name: 'Secondary Chilled Water Pump Speed',
      ashrae36Section: '5.20',
      configFlag: 'hasSecPump',
      patterns: [/schwp.?speed/i, /secondary.?chw.?pump.?speed/i, /secondary.?pump.?speed/i, /pump.?\d+.?vfd.?speed/i],
      aliases: [
        'schwp speed',
        'secondary pump speed',
        'secondary chw pump speed feedback',
        'vfd speed',
        'vfd feedback',
        'pump hz',
        'pump speed feedback',
        'chilled water pump 2 speed',
        'chilled-water pump 2 speed',
        'chwp-2 speed',
      ],
    },
    {
      key: 'chwIsoValveStatus',
      label: 'CHW Isolation Valve Status',
      required: false,
      ashrae36Name: 'Chiller CHW Isolation Valve Status',
      ashrae36Section: '5.20',
      configFlag: 'hasIsoValves',
      patterns: [
        /chw.?isolation.?valve.?status/i,
        /chiller.?isolation.?valve/i,
        /ch.?iso.?valve/i,
        /chiller.?\d+.?chw.?isolation/i,
        /chiller.?\d+.?evaporator.?valve.?feedback/i,
      ],
      aliases: [
        'chw isolation valve',
        'chiller isolation valve',
        'chw shutoff valve',
        'evaporator isolation valve',
        'ch iso valve',
        'chiller chw valve status',
        'chiller 1 isolation valve',
        'chiller 2 isolation valve',
        'chiller 1 evaporator valve feedback',
        'chiller 2 evaporator valve feedback',
        'chilled water pump 1 isolation valve',
        'chilled water pump 2 isolation valve',
      ],
    },
    {
      key: 'chillerEnable',
      label: 'Chiller Enable Command',
      required: true,
      ashrae36Name: 'Chiller Enable Command',
      ashrae36Section: '5.20',
      patterns: [/chiller.?enable/i, /chiller.?start.?stop/i, /chiller.?command/i, /\bch.?\d+.?enable\b/i],
      aliases: [
        'chiller start/stop',
        'chiller enable',
        'chiller command',
        'ch enable',
        'chiller on command',
        'ch-1 enable',
        'chiller 1 command',
      ],
    },
    {
      key: 'chwSetpoint',
      label: 'CHW Supply Temperature Setpoint',
      required: true,
      ashrae36Name: 'Chiller CHW Supply Temperature Setpoint',
      ashrae36Section: '5.20',
      patterns: [
        /chiller.?chwst.?setpoint/i,
        /lwt.?setpoint/i,
        /chw.?setpoint/i,
        /chw.?set.?point/i,
        /cool.?set.?p/i,
        /cooling.?set.?point/i,
        /chilled.?water.?set.?point/i,
        /chiller.?\d+.?active.?setpoint/i,
      ],
      aliases: [
        'chiller chwst setpoint',
        'lwt setpoint',
        'chiller leaving water setpoint',
        'chw setpoint',
        'ch lwt sp',
        'chiller temp setpoint',
        'cooling set point',
        'cool set point',
        'chw set point av',
        'chilled water set point',
        'chiller 1 active setpoint',
        'chiller 2 active setpoint',
        'chws set point',
        'chws setpoint',
        'chw supply setpoint',
        'cool setpt',
        'alc cool setpt',
      ],
    },
    {
      key: 'pchwpEnable',
      label: 'Primary CHW Pump Enable Command',
      required: true,
      ashrae36Name: 'Primary CHW Pump Enable Command',
      ashrae36Section: '5.20',
      configFlag: 'hasPrimary',
      patterns: [
        /pchwp.?enable/i,
        /primary.?chw.?pump.?enable/i,
        /chwp.?\w*.?enable/i,
        /chw.?pump.?\d+.?enable/i,
        /chilled.?water.?pump.?\d+.?enable/i,
      ],
      aliases: [
        'primary pump start/stop',
        'pchwp enable',
        'primary chw pump command',
        'primary pump command',
        'chw pump 1 enable',
        'chw pump 2 enable',
        'chilled water pump 1 enable',
        'chilled water pump 2 enable',
        'chilled water pump 1 vfd enable',
        'chilled water pump 2 vfd enable',
        'chwp a enable',
        'chwp-1 enable',
        'chwp enable',
      ],
    },
    {
      key: 'schwpEnable',
      label: 'Secondary CHW Pump Enable Command',
      required: false,
      ashrae36Name: 'Secondary CHW Pump Enable Command',
      ashrae36Section: '5.20',
      configFlag: 'hasSecPump',
      patterns: [/schwp.?enable/i, /secondary.?chw.?pump.?enable/i, /chwp.?\w*b.?enable/i],
      aliases: [
        'secondary pump start/stop',
        'schwp enable',
        'secondary chw pump command',
        'dist pump enable',
        'chwp b enable',
        'chwp-2 enable',
      ],
    },
    {
      key: 'chwIsoValveCmd',
      label: 'CHW Isolation Valve Command',
      required: false,
      ashrae36Name: 'CHW Isolation Valve Command',
      ashrae36Section: '5.20',
      configFlag: 'hasIsoValves',
      patterns: [
        /chw.?iso.?valve.?command/i,
        /chiller.?iso.?valve.?command/i,
        /chw.?isolation.?valve.?open/i,
        /chiller.?\d+.?isolation.?valve\b/i,
        /chiller.?\d+.?evaporator.?valve.?signal/i,
      ],
      aliases: [
        'chiller iso valve command',
        'chw isolation valve open/close',
        'chiller shutoff valve command',
        'evaporator valve command',
        'chiller 1 isolation valve',
        'chiller 2 isolation valve',
        'chiller 1 evaporator valve signal',
        'chiller 2 evaporator valve signal',
        'ch condenser valve signal',
        'chw isolation valve',
      ],
    },
  ],

  /* ── CT (Cooling Tower Plant, ASHRAE 36 §5.21) ─────────────────────── */
  ct: [
    {
      key: 'cwst',
      label: 'Condenser Water Supply Temperature',
      required: true,
      ashrae36Name: 'Condenser Water Supply Temperature',
      ashrae36Section: '5.21',
      patterns: [
        /\bcwst\b/i,
        /cw.?supply.?temp/i,
        /condenser.?water.?supply/i,
        /leaving.?cw.?temp/i,
        /tower.?supply.?temp/i,
        /tower.?leaving.?water/i,
        /condenser.?supply.?temp/i,
        /condenser.?water.?temp.?to.?tower/i,
        /cws.?temp/i,
      ],
      aliases: [
        'cwst',
        'cw supply temp',
        'condenser water supply temp',
        'leaving cw temp',
        'tower supply temp',
        'tower leaving water temp',
        'condenser supply temp',
        'tower outlet temp',
        'cw-st',
        'cw_st',
        'cond water supply temp',
        'condenser water temp to towers',
        'cws temp',
        'condenser supply',
      ],
    },
    {
      key: 'cwrt',
      label: 'Condenser Water Return Temperature',
      required: true,
      ashrae36Name: 'Condenser Water Return Temperature',
      ashrae36Section: '5.21',
      patterns: [
        /\bcwrt\b/i,
        /cw.?return.?temp/i,
        /condenser.?water.?return/i,
        /entering.?cw.?temp/i,
        /tower.?return.?temp/i,
        /tower.?entering.?water/i,
        /condenser.?water.?temp.?from.?tower/i,
        /cwr.?temp/i,
      ],
      aliases: [
        'cwrt',
        'cw return temp',
        'condenser water return temp',
        'entering cw temp',
        'tower return temp',
        'tower entering water temp',
        'condenser return temp',
        'tower inlet temp',
        'cw-rt',
        'cw_rt',
        'cond water return temp',
        'condenser water temp from towers',
        'cwr temp',
        'condenser return',
      ],
    },
    {
      key: 'oaWetBulb',
      label: 'Outdoor Air Wet Bulb Temperature',
      required: true,
      ashrae36Name: 'Outdoor Air Wet Bulb Temperature',
      ashrae36Section: '5.21',
      patterns: [
        /wet.?bulb/i,
        /\bwb\b.?temp/i,
        /oa.?wet.?bulb/i,
        /\boawb\b/i,
        /outdoor.?wb/i,
        /ambient.?wet.?bulb/i,
        /dewpoint.?temp/i,
      ],
      aliases: [
        'oa wet bulb',
        'wb temp',
        'wet bulb temperature',
        'oat wb',
        'outdoor wb',
        'ambient wet bulb',
        'wet bulb',
        'oa-wb',
        'oa enthalpy (calculated)',
        'dewpoint temp',
      ],
    },
    {
      key: 'oaRH',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.21',
      patterns: [/oa.?rh\b/i, /outdoor.?humidity/i, /outside.?air.?humidity/i, /relative.?humidity/i, /\boat.?rh\b/i],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'oa humidity',
        'relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
      ],
    },
    {
      key: 'ctFanStatus',
      label: 'Cooling Tower Fan Status',
      required: true,
      ashrae36Name: 'Cooling Tower Fan Status',
      ashrae36Section: '5.21',
      patterns: [
        /tower.?fan.?status/i,
        /ct.?fan.?status/i,
        /ct.?\d+.?fan.?status/i,
        /cooling.?tower.?fan.?run/i,
        /ct.?fan.?vfd.?status/i,
      ],
      aliases: [
        'tower fan status',
        'ct fan status',
        'cooling tower fan run',
        'tower fan run',
        'ct fan run',
        'tower fan proof',
        'ct fan 1 status',
        'cell fan status',
        'ct fan vfd status',
        'ct 1 fan vfd status',
        'ct 2 fan vfd status',
      ],
    },
    {
      key: 'cwPumpStatus',
      label: 'Condenser Water Pump Status',
      required: true,
      ashrae36Name: 'Condenser Water Pump Status',
      ashrae36Section: '5.21',
      patterns: [
        /cw.?pump.?status/i,
        /condenser.?pump.?status/i,
        /condenser.?water.?pump.?run/i,
        /cwp.?dp.?status/i,
        /cwp.?\d+.?dp.?status/i,
      ],
      aliases: [
        'cw pump status',
        'condenser pump status',
        'condenser water pump run',
        'cw pump run',
        'tower pump status',
        'condenser pump run',
        'cwp status',
        'cwp run',
        'cwp dp status',
        'cwp 1 dp status',
        'cwp 2 dp status',
      ],
    },
    {
      key: 'sumpLevel',
      label: 'Sump Level',
      required: true,
      ashrae36Name: 'Sump Level',
      ashrae36Section: '5.21',
      patterns: [
        /sump.?level/i,
        /ct.?sump/i,
        /basin.?level/i,
        /tower.?sump/i,
        /cooling.?tower.?basin.?level/i,
        /makeup.?water.?level/i,
      ],
      aliases: [
        'tower sump level',
        'ct sump level',
        'basin level',
        'cooling tower basin level',
        'sump float',
        'tower basin level',
        'water level',
        'makeup water level',
        'ct level',
      ],
    },
    {
      key: 'cwIsoValveStatus',
      label: 'CW Isolation Valve Status',
      required: false,
      ashrae36Name: 'Condenser Water Isolation Valve Status',
      ashrae36Section: '5.21',
      configFlag: 'hasCWIsoValve',
      patterns: [
        /condenser.?iso.?valve/i,
        /cw.?isolation.?valve/i,
        /chiller.?cw.?valve/i,
        /cnd.?isolation.?valve/i,
        /condenser.?isolation.?valve/i,
      ],
      aliases: [
        'condenser iso valve',
        'cw isolation valve',
        'chiller cw valve status',
        'condenser isolation valve',
        'cw shutoff valve',
        'cond isolation valve',
        'ch cnd isolation valve status',
        'condenser valve status',
      ],
    },
    {
      key: 'ctFanEnable',
      label: 'CT Fan Enable Command',
      required: true,
      ashrae36Name: 'Cooling Tower Fan Enable Command',
      ashrae36Section: '5.21',
      patterns: [
        /tower.?fan.?enable/i,
        /ct.?fan.?enable/i,
        /ct.?\d+.?fan.?enable/i,
        /tower.?fan.?start/i,
        /ct.?fan.?vfd.?enable/i,
      ],
      aliases: [
        'tower fan enable',
        'ct fan command',
        'tower fan start/stop',
        'ct fan on/off',
        'cell fan enable',
        'ct fan vfd enable',
        'ct 1 fan vfd enable',
        'ct 2 fan vfd enable',
        'ct fan enable',
      ],
    },
    {
      key: 'ctFanSpeed',
      label: 'CT Fan Speed Command',
      required: false,
      ashrae36Name: 'Cooling Tower Fan Speed Command',
      ashrae36Section: '5.21',
      configFlag: 'hasVFD',
      patterns: [/tower.?fan.?speed/i, /ct.?fan.?vfd.?speed/i, /ct.?\d+.?fan.?speed/i, /ct.?fan.?speed/i],
      aliases: [
        'tower fan speed',
        'ct fan vfd',
        'tower fan vfd speed',
        'ct fan speed command',
        'tower vfd speed',
        'cell fan speed',
        'ct fan vfd speed',
        'ct 1 fan vfd speed',
        'ct 2 fan vfd speed',
        'ct fan speed',
      ],
    },
    {
      key: 'cwPumpEnable',
      label: 'CW Pump Enable Command',
      required: true,
      ashrae36Name: 'Condenser Water Pump Enable Command',
      ashrae36Section: '5.21',
      patterns: [
        /cw.?pump.?enable/i,
        /condenser.?pump.?enable/i,
        /cw.?pump.?start/i,
        /tower.?pump.?enable/i,
        /cwp.?\d+.?enable/i,
      ],
      aliases: [
        'cw pump enable',
        'condenser pump command',
        'cw pump start/stop',
        'tower pump enable',
        'cwp enable',
        'cwp 1 enable',
        'cwp 2 enable',
        'cwp 3 enable',
      ],
    },
    {
      key: 'cwIsoValveCmd',
      label: 'CW Isolation Valve Command',
      required: false,
      ashrae36Name: 'Condenser Water Isolation Valve Command',
      ashrae36Section: '5.21',
      configFlag: 'hasCWIsoValve',
      patterns: [
        /cw.?iso.?valve.?command/i,
        /condenser.?iso.?valve.?command/i,
        /condenser.?valve.?signal/i,
        /cw.?shutoff.?valve.?command/i,
        /\bcv.?ref\b/i,
        /\bcv\d+ref\b/i,
      ],
      aliases: [
        'cw iso valve command',
        'condenser isolation valve command',
        'cw shutoff valve command',
        'condenser valve open/close',
        'ch condenser valve signal',
        'condenser valve signal',
        'cv ref',
        'cv1ref',
        'cv2ref',
      ],
    },
    {
      key: 'makeupValveCmd',
      label: 'Makeup Water Valve Command',
      required: false,
      ashrae36Name: 'Makeup Water Valve Command',
      ashrae36Section: '5.21',
      configFlag: 'hasMakeupValve',
      patterns: [
        /makeup.?water.?valve/i,
        /basin.?fill.?valve/i,
        /sump.?makeup/i,
        /ct.?makeup.?valve/i,
        /tower.?fill.?valve/i,
        /makeup.?valve/i,
      ],
      aliases: [
        'makeup water valve',
        'basin fill valve',
        'sump makeup valve',
        'ct makeup valve',
        'tower fill valve',
        'makeup valve',
      ],
    },
  ],
};

/* ── emNormalizePointName ───────────────────────────────────────────────────
   Internal helper: normalize a raw BAS point name for fuzzy matching.
   - Lowercases
   - Replaces _-/.# with spaces
   - Strips numeric suffixes (removes unit numbers like "1", "2" etc.)
     but keeps them in original for display
   - Collapses whitespace                                                 */
function emNormalizePointName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[_\-\/\.#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── emNormalizePointNameStrip ─────────────────────────────────────────────
   Aggressive normalize: strips digits too (for alias matching where "pump 1"
   and "pump 2" should both match "pump" categories).                    */
function emNormalizePointNameStrip(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[_\-\/\.#]/g, ' ')
    .replace(/\b(ahu|asu|rtu)\b/gi, 'ahu')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── emNormalizePoint ───────────────────────────────────────────────────────
   3-tier point name matcher.
   Returns: { categoryKey, categoryLabel, matchTier, confidence,
              auditRelevant, ashrae36PointName, ashrae36Section }
   matchTier: 1=exact name, 2=standard alias exact, 3=pattern/alias fuzzy
   Returns null if the point does not match any category.
   auditRelevant=false if matched an exclusion pattern.                  */
function emNormalizePoint(rawName, equipCategory) {
  if (!rawName) return null;

  // ── Memoization ───────────────────────────────────────────────────────
  var _normCacheKey = rawName + '\0' + (equipCategory || '');
  if (_emNormCache.has(_normCacheKey)) return _emNormCache.get(_normCacheKey);

  var _normResult = emNormalizePointInner(rawName, equipCategory);
  _emNormCache.set(_normCacheKey, _normResult);
  return _normResult;
}

function emNormalizePointInner(rawName, equipCategory) {
  // ── Exclusion check ──────────────────────────────────────────────────
  for (var ei = 0; ei < EM_EXCLUSION_PATTERNS.length; ei++) {
    if (EM_EXCLUSION_PATTERNS[ei].test(rawName)) {
      return {
        categoryKey: null,
        categoryLabel: null,
        matchTier: 0,
        confidence: 'excluded',
        auditRelevant: false,
        ashrae36PointName: null,
        ashrae36Section: null,
        rawName: rawName,
      };
    }
  }

  var cats = equipCategory && EM_POINT_CATEGORIES[equipCategory] ? EM_POINT_CATEGORIES[equipCategory] : [];

  // If no category known, try all equipment types
  if (!cats.length) {
    var allCats = Object.keys(EM_POINT_CATEGORIES);
    for (var ac = 0; ac < allCats.length; ac++) {
      cats = cats.concat(EM_POINT_CATEGORIES[allCats[ac]]);
    }
  }

  var normDisplay = emNormalizePointName(rawName);
  var normStripped = emNormalizePointNameStrip(rawName);

  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];

    // ── Tier 1: Exact canonical name match (case-insensitive) ────────
    var canonNorm = emNormalizePointName(cat.ashrae36Name || cat.label);
    if (normDisplay === canonNorm) {
      return {
        categoryKey: cat.key,
        categoryLabel: cat.label,
        matchTier: 1,
        confidence: 'high',
        auditRelevant: true,
        ashrae36PointName: cat.ashrae36Name,
        ashrae36Section: cat.ashrae36Section,
        rawName: rawName,
        required: cat.required,
        configFlag: cat.configFlag || null,
      };
    }

    // ── Tier 2: Standard alias exact match ──────────────────────────
    var aliases = cat.aliases || [];
    for (var ai = 0; ai < aliases.length; ai++) {
      var aliasNorm = emNormalizePointName(aliases[ai]);
      if (normDisplay === aliasNorm) {
        return {
          categoryKey: cat.key,
          categoryLabel: cat.label,
          matchTier: 2,
          confidence: 'high',
          auditRelevant: true,
          ashrae36PointName: cat.ashrae36Name,
          ashrae36Section: cat.ashrae36Section,
          rawName: rawName,
          required: cat.required,
          configFlag: cat.configFlag || null,
        };
      }
      // Alias substring: alias must appear within the normalized name
      if (aliasNorm.length >= 4 && normDisplay.includes(aliasNorm)) {
        return {
          categoryKey: cat.key,
          categoryLabel: cat.label,
          matchTier: 2,
          confidence: 'medium',
          auditRelevant: true,
          ashrae36PointName: cat.ashrae36Name,
          ashrae36Section: cat.ashrae36Section,
          rawName: rawName,
          required: cat.required,
          configFlag: cat.configFlag || null,
        };
      }
    }

    // ── Tier 3: Regex pattern match ──────────────────────────────────
    var patterns = cat.patterns || [];
    for (var pi = 0; pi < patterns.length; pi++) {
      if (patterns[pi].test(rawName)) {
        return {
          categoryKey: cat.key,
          categoryLabel: cat.label,
          matchTier: 3,
          confidence: 'medium',
          auditRelevant: true,
          ashrae36PointName: cat.ashrae36Name,
          ashrae36Section: cat.ashrae36Section,
          rawName: rawName,
          required: cat.required,
          configFlag: cat.configFlag || null,
        };
      }
    }

    // Tier 3b: stripped alias (number-insensitive)
    for (var ai2 = 0; ai2 < aliases.length; ai2++) {
      var aliasStripped = emNormalizePointNameStrip(aliases[ai2]);
      if (aliasStripped.length >= 4 && normStripped === aliasStripped) {
        return {
          categoryKey: cat.key,
          categoryLabel: cat.label,
          matchTier: 3,
          confidence: 'low',
          auditRelevant: true,
          ashrae36PointName: cat.ashrae36Name,
          ashrae36Section: cat.ashrae36Section,
          rawName: rawName,
          required: cat.required,
          configFlag: cat.configFlag || null,
        };
      }
    }
  }

  // No match found
  return {
    categoryKey: null,
    categoryLabel: null,
    matchTier: 0,
    confidence: 'none',
    auditRelevant: true,
    ashrae36PointName: null,
    ashrae36Section: null,
    rawName: rawName,
  };
}

/* ── emComputeCompliance ────────────────────────────────────────────────────
   For a single equipment row, compute ASHRAE 36 coverage.
   equipRow.category = 'ahu'|'vav'|'fpb'|'ddvav'|'hwp'|'chwp'|'ct'
   equipRow.points   = { rawPointName: value, ... }
   configFlags       = object of { hasReturnFan: bool, hasEconomizer: bool, ... }
                       loaded from emLoadEquipConfigFlags()

   Returns:
   {
     coveredPoints:  [{ categoryKey, categoryLabel, matchTier, confidence, pointName }]
     missingPoints:  [{ categoryKey, categoryLabel, ashrae36Name, required }]
     naPoints:       [{ categoryKey, categoryLabel, reason }]   // N/A due to configFlag
     coveragePct:    number 0-100  (matched required / (required - na))
     totalRequired:  number
     totalMatched:   number
     totalNA:        number
   }                                                                      */
function emComputeCompliance(equipRow, configFlags, customMappings) {
  // ── Module-level cache (keyed by row.id; all call sites pass flags={}) ──
  var _cacheId = equipRow && equipRow.id;
  if (_cacheId && _emComplianceCache[_cacheId]) return _emComplianceCache[_cacheId];

  var category = equipRow && equipRow.category;
  var catDefs = category && EM_POINT_CATEGORIES[category];
  if (!catDefs) {
    return {
      coveredPoints: [],
      missingPoints: [],
      naPoints: [],
      coveragePct: 0,
      totalRequired: 0,
      totalMatched: 0,
      totalNA: 0,
    };
  }

  var flags = configFlags || {};
  var points = equipRow.points || {};
  var rawNames = Object.keys(points);

  // Build a set of covered category keys from matching point names
  var coveredKeys = {}; // key -> match result
  var coveredPoints = [];

  for (var ri = 0; ri < rawNames.length; ri++) {
    var pName = rawNames[ri];
    var match = emNormalizePointWithCustom(pName, category, customMappings || []);
    if (match && match.auditRelevant && match.categoryKey) {
      // Keep the highest-confidence match per category key
      if (!coveredKeys[match.categoryKey] || match.matchTier < coveredKeys[match.categoryKey].matchTier) {
        coveredKeys[match.categoryKey] = match;
      }
    }
  }

  // Build covered list
  for (var ck in coveredKeys) {
    if (coveredKeys.hasOwnProperty(ck)) {
      var m = coveredKeys[ck];
      coveredPoints.push({
        categoryKey: m.categoryKey,
        categoryLabel: m.categoryLabel,
        ashrae36PointName: m.ashrae36PointName,
        ashrae36Section: m.ashrae36Section,
        matchTier: m.matchTier,
        confidence: m.confidence,
        pointName: m.rawName,
        required: m.required,
      });
    }
  }

  var missingPoints = [];
  var naPoints = [];
  var totalRequired = 0;
  var totalNA = 0;
  var totalMatched = 0;

  for (var di = 0; di < catDefs.length; di++) {
    var def = catDefs[di];
    if (!def.required) continue; // Only count required points toward coverage

    totalRequired++;

    // Check if this category is N/A due to a config flag being false
    if (def.configFlag) {
      // Default flag value: look up EM_EQUIP_CONFIG_FLAGS for default
      var flagDefault = true;
      var flagDefs = EM_EQUIP_CONFIG_FLAGS[category] || [];
      for (var fi = 0; fi < flagDefs.length; fi++) {
        if (flagDefs[fi].key === def.configFlag) {
          flagDefault = flagDefs[fi]['default'];
          break;
        }
      }
      var flagVal = def.configFlag in flags ? flags[def.configFlag] : flagDefault;
      if (!flagVal) {
        naPoints.push({ categoryKey: def.key, categoryLabel: def.label, reason: def.configFlag + '=false' });
        totalNA++;
        continue;
      }
    }

    if (coveredKeys[def.key]) {
      totalMatched++;
    } else {
      missingPoints.push({
        categoryKey: def.key,
        categoryLabel: def.label,
        ashrae36Name: def.ashrae36Name,
        ashrae36Section: def.ashrae36Section,
        required: true,
      });
    }
  }

  var denominator = totalRequired - totalNA;
  var coveragePct = denominator > 0 ? Math.round((totalMatched / denominator) * 100) : 0;

  var _compResult = {
    coveredPoints: coveredPoints,
    missingPoints: missingPoints,
    naPoints: naPoints,
    coveragePct: coveragePct,
    totalRequired: totalRequired,
    totalMatched: totalMatched,
    totalNA: totalNA,
  };
  if (_cacheId) _emComplianceCache[_cacheId] = _compResult;
  return _compResult;
}

/* ── emLoadEquipConfigFlags / emSaveEquipConfigFlags ────────────────────────
   Per-equipment configuration flags stored in data.edits, keyed by
   rowId + '::config'. These tell the compliance engine which optional
   hardware features are present (has economizer, has return fan, etc.)  */
function emLoadEquipConfigFlags(projId, rowId) {
  var editKey = 'en_eqmatrix_edits_' + projId;
  var edits = DB.get(editKey, {});
  return edits[rowId + '::config'] || {};
}

function emSaveEquipConfigFlags(projId, rowId, flags) {
  var editKey = 'en_eqmatrix_edits_' + projId;
  var edits = DB.get(editKey, {});
  edits[rowId + '::config'] = flags;
  DB.set(editKey, edits);
}

/* ── emLoadCustomMappings / emSaveCustomMappings ────────────────────────────
   Per-project custom point name → category mappings.
   Allows users to manually override the auto-match for unusual BAS names.
   Stored in IndexedDB as an array of { rawName, categoryKey, equipCategory }.  */
function emLoadCustomMappings(projId) {
  if (!projId) return [];
  return DB.get('en_eqmatrix_cmaps_' + projId, []);
}

function emSaveCustomMappings(projId, mappings) {
  if (!projId) return;
  DB.set('en_eqmatrix_cmaps_' + projId, mappings);
}

/* ── CREATE BUILDINGS FROM EQUIPMENT MATRIX ──────────────────────────────── */

/* ── _emCreateBldgsRows ─────────────────────────────────────────────────────
   Module-level state for the Create Buildings modal.                      */
var _emCreateBldgsRows = [];

/* ── emOpenCreateBldgsModal ─────────────────────────────────────────────────
   Reads unique building names from the equipment matrix, checks which ones
   already exist in the project's utility data, and opens the modal.      */
function emOpenCreateBldgsModal(pid) {
  if (!pid) return;
  var data = emLoadMatrix(pid);
  var matrixBuildings = data.buildings || [];
  if (matrixBuildings.length === 0) {
    showToast('No buildings in equipment matrix');
    return;
  }

  // Get existing buildings from utility data for this project
  var existingBldgs = [];
  if (typeof getUDProj === 'function') {
    var proj = getUDProj(pid);
    existingBldgs = proj && proj.buildings ? proj.buildings : [];
  }

  // Build a set of existing names (lower-case) for dedup check
  var existingNamesLower = {};
  for (var ei = 0; ei < existingBldgs.length; ei++) {
    existingNamesLower[(existingBldgs[ei].name || '').toLowerCase()] = true;
  }

  // Count equipment per building from matrix rows
  var equipCount = {};
  var rows = data.rows || [];
  for (var ri = 0; ri < rows.length; ri++) {
    var bname = rows[ri].building || '';
    if (bname) equipCount[bname] = (equipCount[bname] || 0) + 1;
  }

  // Build row data — dedup within batch handled by name
  var seen = {};
  _emCreateBldgsRows = [];
  for (var bi = 0; bi < matrixBuildings.length; bi++) {
    var name = matrixBuildings[bi];
    if (!name) continue; // skip empty building names (e.g. WebCTRL single-segment BACnet paths)
    var nameLower = name.toLowerCase();
    if (seen[nameLower]) continue;
    seen[nameLower] = true;
    var alreadyExists = !!existingNamesLower[nameLower];
    _emCreateBldgsRows.push({
      name: name,
      alreadyExists: alreadyExists,
      checked: !alreadyExists,
      equipCount: equipCount[name] || 0,
    });
  }

  // Populate summary
  var newCount = _emCreateBldgsRows.filter(function (r) {
    return !r.alreadyExists;
  }).length;
  var existCount = _emCreateBldgsRows.filter(function (r) {
    return r.alreadyExists;
  }).length;
  var summaryEl = document.getElementById('emCreateBldgsSummary');
  if (summaryEl) {
    summaryEl.textContent =
      'Found ' +
      matrixBuildings.length +
      ' building' +
      (matrixBuildings.length !== 1 ? 's' : '') +
      ' in equipment matrix. ' +
      newCount +
      ' new, ' +
      existCount +
      ' already exist in this project.';
  }

  // Render table
  var tableEl = document.getElementById('emCreateBldgsTable');
  if (tableEl) tableEl.innerHTML = emRenderCreateBldgsTable(_emCreateBldgsRows);

  // Update submit button
  emUpdateCreateBldgsSubmitBtn();

  // Open modal
  var modal = document.getElementById('emCreateBldgsModal');
  if (modal) modal.classList.add('open');
}

/* ── emRenderCreateBldgsTable ───────────────────────────────────────────────
   Returns HTML string for the table shown in the Create Buildings modal.  */
function emRenderCreateBldgsTable(rows) {
  if (!rows || rows.length === 0) return '<p style="color:var(--text3);font-size:13px">No buildings found.</p>';

  // Select All should only be checked if at least one non-disabled (new) row exists
  var hasSelectableRow = rows.some(function (r) {
    return !r.alreadyExists;
  });

  var html =
    '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead>' +
    '<tr style="background:var(--s1);border-bottom:2px solid var(--border)">' +
    '<th style="padding:6px 8px;text-align:left;font-weight:600;color:var(--text2);width:32px">' +
    '<input type="checkbox" id="emCreateBldgsSelectAll"' +
    (hasSelectableRow ? ' checked' : '') +
    ' ' +
    'onchange="emToggleAllCreateBldgs(this.checked)" title="Select/deselect all">' +
    '</th>' +
    '<th style="padding:6px 8px;text-align:left;font-weight:600;color:var(--text2)">Building Name</th>' +
    '<th style="padding:6px 8px;text-align:center;font-weight:600;color:var(--text2);width:100px">Equipment</th>' +
    '<th style="padding:6px 8px;text-align:left;font-weight:600;color:var(--text2);width:130px">Status</th>' +
    '</tr>' +
    '</thead>' +
    '<tbody>';

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var dimStyle = row.alreadyExists ? 'opacity:0.5;' : '';
    var statusHtml = row.alreadyExists
      ? '<span style="font-size:11px;color:var(--text3);font-style:italic">(already exists)</span>'
      : '<span style="font-size:11px;color:var(--em)">New</span>';
    html +=
      '<tr style="border-bottom:1px solid var(--border);' +
      dimStyle +
      '">' +
      '<td style="padding:6px 8px;text-align:center">' +
      '<input type="checkbox" class="em-create-bldg-cb" data-idx="' +
      i +
      '" ' +
      (row.checked ? 'checked' : '') +
      ' ' +
      (row.alreadyExists ? 'disabled' : '') +
      ' ' +
      'onchange="emUpdateCreateBldgsSubmitBtn()">' +
      '</td>' +
      '<td style="padding:6px 8px">' +
      '<input type="text" class="em-create-bldg-name" data-idx="' +
      i +
      '" ' +
      'value="' +
      emHtmlEsc(row.name) +
      '" ' +
      (row.alreadyExists ? 'disabled ' : '') +
      'style="width:100%;font-size:12px;padding:2px 6px;background:var(--s2);border:1px solid var(--border);' +
      'color:var(--text);border-radius:3px;box-sizing:border-box">' +
      '</td>' +
      '<td style="padding:6px 8px;text-align:center;color:var(--text2)">' +
      row.equipCount +
      '</td>' +
      '<td style="padding:6px 8px">' +
      statusHtml +
      '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/* ── emToggleAllCreateBldgs ─────────────────────────────────────────────────
   Selects or deselects all non-disabled checkboxes in the modal table.   */
function emToggleAllCreateBldgs(checked) {
  var cbs = document.querySelectorAll('.em-create-bldg-cb');
  for (var i = 0; i < cbs.length; i++) {
    if (!cbs[i].disabled) cbs[i].checked = checked;
  }
  emUpdateCreateBldgsSubmitBtn();
}

/* ── emUpdateCreateBldgsSubmitBtn ───────────────────────────────────────────
   Updates the submit button text with the count of selected buildings.   */
function emUpdateCreateBldgsSubmitBtn() {
  var cbs = document.querySelectorAll('.em-create-bldg-cb');
  var count = 0;
  for (var i = 0; i < cbs.length; i++) {
    if (cbs[i].checked && !cbs[i].disabled) count++;
  }
  var btn = document.getElementById('emCreateBldgsSubmitBtn');
  if (btn) {
    btn.textContent = count > 0 ? 'Create ' + count + ' Building' + (count !== 1 ? 's' : '') : 'Create Buildings';
    btn.disabled = count === 0;
  }
}

/* ── emCloseCreateBldgsModal ────────────────────────────────────────────────
   Closes the Create Buildings modal and clears module state.             */
function emCloseCreateBldgsModal() {
  var modal = document.getElementById('emCreateBldgsModal');
  if (modal) modal.classList.remove('open');
  _emCreateBldgsRows = [];
}

/* ── emExecuteCreateBuildings ───────────────────────────────────────────────
   Reads checked rows from the modal, creates building records in utility
   data for the active project, then refreshes all relevant views.        */
function emExecuteCreateBuildings() {
  var pid = window._emActivePid;
  if (!pid) return;

  // Collect name inputs (user may have edited them)
  var nameInputs = document.querySelectorAll('.em-create-bldg-name');
  var cbs = document.querySelectorAll('.em-create-bldg-cb');

  // Build final list of buildings to create
  var toCreate = [];
  var skippedExisting = 0;
  var skippedDeselected = 0;
  for (var i = 0; i < cbs.length; i++) {
    var cb = cbs[i];
    var idx = parseInt(cb.getAttribute('data-idx'), 10);
    var row = _emCreateBldgsRows[idx];
    if (!row) continue;
    if (!cb.checked || cb.disabled) {
      if (row.alreadyExists) {
        skippedExisting++;
      } else {
        skippedDeselected++;
      }
      continue;
    }
    // Read the (possibly edited) name from the input
    var nameInput = document.querySelector('.em-create-bldg-name[data-idx="' + idx + '"]');
    var name = nameInput ? nameInput.value.trim() : row.name;
    if (!name) continue;
    toCreate.push(name);
  }

  if (toCreate.length === 0) {
    showToast('No buildings selected');
    return;
  }

  // Get the project's utility data
  if (typeof getUDProj !== 'function') {
    showToast('Cannot access project data');
    return;
  }
  var proj = getUDProj(pid);
  if (!proj) return;
  if (!proj.buildings) proj.buildings = [];

  // Dedup within batch (case-insensitive) and against existing buildings
  var existingNamesLower = {};
  for (var ei = 0; ei < proj.buildings.length; ei++) {
    existingNamesLower[(proj.buildings[ei].name || '').toLowerCase()] = true;
  }

  var created = 0;
  var batchSeen = {};
  for (var ci = 0; ci < toCreate.length; ci++) {
    var bname = toCreate[ci];
    var bnameLower = bname.toLowerCase();
    if (existingNamesLower[bnameLower] || batchSeen[bnameLower]) {
      skippedExisting++;
      continue;
    }
    batchSeen[bnameLower] = true;
    proj.buildings.push({
      id: 'b' + (Date.now() + ci),
      name: bname,
      addr: '',
      sqft: 0,
      zip: '',
      addrAliases: [],
      meters: [],
    });
    created++;
  }

  // Persist and refresh
  if (typeof saveUtilityData === 'function') saveUtilityData();
  if (typeof renderUDProjList === 'function') renderUDProjList();
  if (typeof renderUDDetail === 'function') renderUDDetail();
  if (typeof renderProjTable === 'function') renderProjTable();
  if (typeof renderSidebarFolders === 'function') renderSidebarFolders();

  emCloseCreateBldgsModal();

  var msg = 'Created ' + created + ' building' + (created !== 1 ? 's' : '');
  var skippedParts = [];
  if (skippedExisting > 0) skippedParts.push(skippedExisting + ' already existed');
  if (skippedDeselected > 0) skippedParts.push(skippedDeselected + ' deselected');
  if (skippedParts.length > 0) msg += ' (' + skippedParts.join(', ') + ')';
  showToast(msg);
}

/* ── emNormalizePointWithCustom ─────────────────────────────────────────────
   Wrapper around emNormalizePoint that checks custom mappings first.
   Custom mappings take priority over all 3 auto-match tiers.           */
function emNormalizePointWithCustom(rawName, equipCategory, customMappings) {
  var maps = customMappings || [];
  var normRaw = emNormalizePointName(rawName);
  for (var mi = 0; mi < maps.length; mi++) {
    var m = maps[mi];
    if (!m.rawName || !m.categoryKey) continue;
    if ((!m.equipCategory || m.equipCategory === equipCategory) && emNormalizePointName(m.rawName) === normRaw) {
      // Custom mapping: tier 0 (highest priority), confidence 'custom'
      var catDefs = (equipCategory && EM_POINT_CATEGORIES[equipCategory]) || [];
      var catDef = null;
      for (var di = 0; di < catDefs.length; di++) {
        if (catDefs[di].key === m.categoryKey) {
          catDef = catDefs[di];
          break;
        }
      }
      var isExclude = m.categoryKey === '__exclude__';
      return {
        categoryKey: isExclude ? null : m.categoryKey,
        categoryLabel: catDef ? catDef.label : m.categoryKey,
        matchTier: 0,
        confidence: 'custom',
        auditRelevant: !isExclude,
        ashrae36PointName: catDef ? catDef.ashrae36Name : null,
        ashrae36Section: catDef ? catDef.ashrae36Section : null,
        rawName: rawName,
        required: catDef ? catDef.required : false,
        configFlag: catDef ? catDef.configFlag || null : null,
      };
    }
  }
  return emNormalizePoint(rawName, equipCategory);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 3 — SEQUENCE STATUS COLUMNS
   Added: 2026-05-26
   Purpose: For each ASHRAE 36 control sequence relevant to the equipment
   type, check whether the required BAS point categories are present.
   Results are displayed as additional columns in Audit View.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── EM_SEQUENCE_DEFS ───────────────────────────────────────────────────────
   Defines ASHRAE 36 sequences per equipment type.
   Each sequence entry: {
     key:          unique string ID for this sequence
     label:        short display label (fits in a table header)
     ashrae36:     section reference
     equipTypes:   array of equipment category strings this applies to
     requiredCats: array of point category keys — ALL must be present for 'ready'
     keyCats:      array of category keys considered "key" — absence = 'blocked'
                   (subset of requiredCats; if any key cat missing → blocked,
                    if only non-key cats missing → partial)
   }                                                                         */
var EM_SEQUENCE_DEFS = [
  /* ── AHU sequences ─────────────────────────────────────────────────── */
  {
    key: 'ahu_sat_reset',
    label: 'SAT Reset',
    ashrae36: '§5.16.2',
    equipTypes: ['ahu'],
    requiredCats: ['sat', 'oat', 'sfSpeed'],
    keyCats: ['sat', 'oat'],
  },
  {
    key: 'ahu_dsp_reset',
    label: 'DSP Reset',
    ashrae36: '§5.16.1',
    equipTypes: ['ahu'],
    requiredCats: ['dsp', 'sfSpeed', 'sfSpeedCmd'],
    keyCats: ['dsp', 'sfSpeedCmd'],
  },
  {
    key: 'ahu_economizer',
    label: 'Economizer',
    ashrae36: '§5.16.10',
    equipTypes: ['ahu'],
    requiredCats: ['oat', 'oaDampCmd', 'mat'],
    keyCats: ['oaDampCmd'],
    configFlag: 'hasEconomizer',
  },
  {
    key: 'ahu_freeze_prot',
    label: 'Freeze Prot.',
    ashrae36: '§5.16.12',
    equipTypes: ['ahu'],
    requiredCats: ['freezeStat', 'mat'],
    keyCats: ['freezeStat'],
  },
  {
    key: 'ahu_min_oa',
    label: 'Min OA',
    ashrae36: '§5.16.6',
    equipTypes: ['ahu'],
    requiredCats: ['oaDampCmd', 'sfSpeedCmd'],
    keyCats: ['oaDampCmd'],
  },
  {
    key: 'ahu_rf_control',
    label: 'RF Control',
    ashrae36: '§5.16.5',
    equipTypes: ['ahu'],
    requiredCats: ['rfEnable', 'rfSpeedCmd'],
    keyCats: ['rfEnable'],
    configFlag: 'hasReturnFan',
  },

  /* ── VAV sequences ──────────────────────────────────────────────────── */
  {
    key: 'vav_zone_temp',
    label: 'Zone Temp',
    ashrae36: '§5.6.1',
    equipTypes: ['vav', 'fpb', 'ddvav'],
    requiredCats: ['zoneTemp', 'dampCmd', 'coolSP', 'htgSP'],
    keyCats: ['zoneTemp', 'dampCmd'],
  },
  {
    key: 'vav_reheat',
    label: 'Reheat',
    ashrae36: '§5.6.4',
    equipTypes: ['vav', 'fpb'],
    requiredCats: ['reheatValve', 'zoneTemp', 'dat'],
    keyCats: ['reheatValve'],
    configFlag: 'hasReheat',
  },

  /* ── HWP sequences ──────────────────────────────────────────────────── */
  {
    key: 'hwp_supply_reset',
    label: 'Supply Temp Reset',
    ashrae36: '§5.19.1',
    equipTypes: ['hwp'],
    requiredCats: ['hwst', 'oat', 'hwSetpoint'],
    keyCats: ['hwst', 'hwSetpoint'],
  },
  {
    key: 'hwp_pump_dp_reset',
    label: 'Pump DP Reset',
    ashrae36: '§5.19.2',
    equipTypes: ['hwp'],
    requiredCats: ['hwdp', 'hwPumpSpeed'],
    keyCats: ['hwdp', 'hwPumpSpeed'],
  },
  {
    key: 'hwp_staging',
    label: 'Staging',
    ashrae36: '§5.19.3',
    equipTypes: ['hwp'],
    requiredCats: ['boilerStatus', 'boilerEnable', 'hwPumpStatus'],
    keyCats: ['boilerEnable'],
  },

  /* ── CHWP sequences ─────────────────────────────────────────────────── */
  {
    key: 'chwp_supply_reset',
    label: 'Supply Temp Reset',
    ashrae36: '§5.20.1',
    equipTypes: ['chwp'],
    requiredCats: ['chwst', 'oat', 'chwSetpoint'],
    keyCats: ['chwst', 'chwSetpoint'],
  },
  {
    key: 'chwp_pump_dp_reset',
    label: 'Pump DP Reset',
    ashrae36: '§5.20.2',
    equipTypes: ['chwp'],
    requiredCats: ['chwdp', 'schwpSpeed'],
    keyCats: ['chwdp', 'schwpSpeed'],
  },
  {
    key: 'chwp_staging',
    label: 'Staging',
    ashrae36: '§5.20.3',
    equipTypes: ['chwp'],
    requiredCats: ['chillerStatus', 'chillerEnable', 'pchwpStatus'],
    keyCats: ['chillerEnable'],
  },
];

/* ── emComputeSequenceReadiness ─────────────────────────────────────────────
   For each ASHRAE 36 sequence relevant to this equipment type, check whether
   all required point categories are present in the compliance data.

   Parameters:
     equipRow      — a matrix row object (needs .category, .points)
     complianceData — result of emComputeCompliance(equipRow, {})
                      Provides coveredPoints[], missingPoints[], naPoints[]

   Returns an object keyed by sequence key:
     {
       [seqKey]: {
         status:        'ready'|'partial'|'blocked'|'na'
         label:         display label
         ashrae36:      section reference
         presentCats:   string[] — category keys that ARE present
         missingCats:   string[] — category keys that are missing
         keyCatsMissing: bool — true if any key category is absent
       }
     }

   Status logic:
     'na'      — sequence does not apply to this equipment type, OR
                 sequence has a configFlag set to false (by default)
     'ready'   — all requiredCats present
     'partial' — some requiredCats present, but no key cats missing
     'blocked' — one or more keyCats are missing                         */
function emComputeSequenceReadiness(equipRow, complianceData) {
  var result = {};
  var category = equipRow && equipRow.category;
  if (!category) return result;

  // Build a set of covered category keys from complianceData for fast lookup
  var coveredSet = {};
  var covered = (complianceData && complianceData.coveredPoints) || [];
  for (var ci = 0; ci < covered.length; ci++) {
    coveredSet[covered[ci].categoryKey] = true;
  }

  for (var si = 0; si < EM_SEQUENCE_DEFS.length; si++) {
    var seq = EM_SEQUENCE_DEFS[si];

    // Check if this sequence applies to this equipment type
    var applies = seq.equipTypes.indexOf(category) !== -1;
    if (!applies) {
      result[seq.key] = {
        status: 'na',
        label: seq.label,
        ashrae36: seq.ashrae36,
        presentCats: [],
        missingCats: seq.requiredCats.slice(),
        keyCatsMissing: false,
      };
      continue;
    }

    // Check configFlag — if defined and default is false, mark N/A
    if (seq.configFlag) {
      var flagDefs = (category && EM_EQUIP_CONFIG_FLAGS[category]) || [];
      var flagDefault = false;
      for (var fi = 0; fi < flagDefs.length; fi++) {
        if (flagDefs[fi].key === seq.configFlag) {
          flagDefault = flagDefs[fi]['default'];
          break;
        }
      }
      // If flag defaults false and no override, treat as N/A
      if (!flagDefault) {
        result[seq.key] = {
          status: 'na',
          label: seq.label,
          ashrae36: seq.ashrae36,
          presentCats: [],
          missingCats: seq.requiredCats.slice(),
          keyCatsMissing: false,
        };
        continue;
      }
    }

    // Evaluate which required categories are present and which are missing
    var presentCats = [];
    var missingCats = [];
    var requiredCats = seq.requiredCats || [];
    for (var ri = 0; ri < requiredCats.length; ri++) {
      var catKey = requiredCats[ri];
      if (coveredSet[catKey]) {
        presentCats.push(catKey);
      } else {
        missingCats.push(catKey);
      }
    }

    // Check if any key categories are missing
    var keyCats = seq.keyCats || [];
    var keyCatsMissing = false;
    for (var ki = 0; ki < keyCats.length; ki++) {
      if (!coveredSet[keyCats[ki]]) {
        keyCatsMissing = true;
        break;
      }
    }

    var status;
    if (missingCats.length === 0) {
      status = 'ready';
    } else if (keyCatsMissing) {
      status = 'blocked';
    } else {
      status = 'partial';
    }

    result[seq.key] = {
      status: status,
      label: seq.label,
      ashrae36: seq.ashrae36,
      presentCats: presentCats,
      missingCats: missingCats,
      keyCatsMissing: keyCatsMissing,
    };
  }

  return result;
}

/* ── emRenderSequenceCell ───────────────────────────────────────────────────
   Renders a single <td> for a sequence status column in audit view.
   Returns an HTML string.

   Status → visual:
     'ready'   — green  ✓  (all required points present)
     'partial' — amber  ~  (some points present, no key points missing)
     'blocked' — red    ✗  (key points missing)
     'na'      — gray   —  (not applicable)

   Tooltip shows present and missing category keys for quick diagnosis.    */
function emRenderSequenceCell(seqName, readiness) {
  var baseStyle =
    'border-bottom:1px solid var(--border);' +
    'border-right:1px solid var(--border);vertical-align:middle;text-align:center;';

  if (!readiness || readiness.status === 'na') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(128,128,128,0.08);color:var(--text3)" title="N/A for this equipment">N/A</td>'
    );
  }

  var status = readiness.status;
  var presentList = (readiness.presentCats || []).join(', ');
  var missingList = (readiness.missingCats || []).join(', ');
  var tooltip = seqName + ' (' + (readiness.ashrae36 || '') + ')';
  if (presentList) tooltip += '\nPresent: ' + presentList;
  if (missingList) tooltip += '\nMissing: ' + missingList;

  if (status === 'ready') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(39,174,96,0.15);color:#27ae60;font-size:11px;font-weight:700" ' +
      'title="' +
      emHtmlEsc(tooltip) +
      '">Yes</td>'
    );
  }
  if (status === 'partial') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(230,126,34,0.15);color:#e67e22;font-size:11px;font-weight:700" ' +
      'title="' +
      emHtmlEsc(tooltip) +
      '">Partial</td>'
    );
  }
  if (status === 'blocked') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(192,57,43,0.15);color:#c0392b;font-size:11px;font-weight:700" ' +
      'title="' +
      emHtmlEsc(tooltip) +
      '">No</td>'
    );
  }

  // Fallback — should not reach here
  return '<td style="' + baseStyle + 'color:var(--text3)">N/A</td>';
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 4 — MANAGE MAPPINGS UI
   Added: 2026-05-26
   Updated: 2026-05-27 — show all points (matched + unmatched), merge save,
                          functional dropdown grouping, guidance text
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── emGetUnmatchedPoints ───────────────────────────────────────────────────
   Preserved for backward compatibility. Delegates to emGetAllPoints and
   returns only the unmatched subset.                                        */
function emGetUnmatchedPoints(rows) {
  var all = emGetAllPoints(rows);
  return all.filter(function (p) {
    return p.status === 'unmatched';
  });
}

/* ── emGetAllPoints ─────────────────────────────────────────────────────────
   Scans all equipment rows and collects every raw BAS point name, classifying
   each as 'unmatched', 'matched', or 'excluded'.
   Returns an array sorted by count descending:
     [{
       name:          string   — raw BAS point name
       count:         number   — how many equipment rows contain this name
       equipCategory: string   — most common equipment type for this point
       status:        string   — 'unmatched' | 'matched' | 'excluded'
       matchedLabel:  string   — category label if matched (else '')
       matchedKey:    string   — "equipType:categoryKey" if matched (else '')
       confidence:    string   — 'high' | 'medium' | 'low' | 'excluded' | ''
     }, ...]
   NOTE: uses emNormalizePoint (auto-match only). Custom mappings are applied
   in the open-modal function so the modal can show pre-selected values.     */
function emGetAllPoints(rows) {
  // freq map: rawName -> { count, catFreq, normResult }
  // normResult is from the FIRST row this name appeared in (for status/label)
  var freq = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var pts = row.points || {};
    for (var ptKey in pts) {
      if (!pts.hasOwnProperty(ptKey)) continue;
      // Skip internal mapped keys (camelCase + 'Live' suffix)
      if (/Live$/.test(ptKey) && !/\s/.test(ptKey)) continue;
      var ec = row.category || 'other';
      if (!freq[ptKey]) {
        var norm = emNormalizePoint(ptKey, row.category);
        freq[ptKey] = { count: 0, catFreq: {}, norm: norm };
      }
      freq[ptKey].count++;
      freq[ptKey].catFreq[ec] = (freq[ptKey].catFreq[ec] || 0) + 1;
    }
  }

  var result = [];
  for (var name in freq) {
    if (!freq.hasOwnProperty(name)) continue;
    var entry = freq[name];
    // Find most common equipment category
    var bestCat = '';
    var bestCount = 0;
    for (var cat in entry.catFreq) {
      if (entry.catFreq[cat] > bestCount) {
        bestCount = entry.catFreq[cat];
        bestCat = cat;
      }
    }
    var norm = entry.norm;
    var status, matchedLabel, matchedKey, confidence;
    if (!norm || !norm.categoryKey) {
      status = 'unmatched';
      matchedLabel = '';
      matchedKey = '';
      confidence = '';
    } else if (!norm.auditRelevant) {
      status = 'excluded';
      matchedLabel = '';
      matchedKey = '';
      confidence = 'excluded';
    } else {
      status = 'matched';
      matchedLabel = norm.categoryLabel || norm.categoryKey;
      // Build "equipType:categoryKey" — use bestCat as equipment type approximation
      matchedKey = (bestCat || 'ahu') + ':' + norm.categoryKey;
      confidence = norm.confidence || 'medium';
    }
    result.push({
      name: name,
      count: entry.count,
      equipCategory: bestCat,
      status: status,
      matchedLabel: matchedLabel,
      matchedKey: matchedKey,
      confidence: confidence,
    });
  }

  result.sort(function (a, b) {
    var diff = b.count - a.count;
    if (diff !== 0) return diff;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return result;
}

/* ── emBuildFunctionalCatOptions ────────────────────────────────────────────
   Builds the category dropdown options list grouped by point function
   (Temperature, Pressure, Airflow, etc.) rather than by equipment type.
   Returns an array of { key, label, equipType, funcGroup } sorted by group.
   Deduplicates by label within each group to avoid showing the same concept
   twice (e.g. "Supply Air Temperature" from AHU and from FPB).             */
function emBuildFunctionalCatOptions() {
  // Functional group assignments by label keywords — order matters (first match wins)
  var funcGroups = [
    {
      name: 'Temperature',
      test: function (label) {
        return /temp|temperature|enthalpy/i.test(label);
      },
    },
    {
      name: 'Pressure',
      test: function (label) {
        return /pressure|static/i.test(label);
      },
    },
    {
      name: 'Airflow',
      test: function (label) {
        return /airflow|flow|cfm/i.test(label);
      },
    },
    {
      name: 'Valve Commands',
      test: function (label) {
        return /valve/i.test(label);
      },
    },
    {
      name: 'Damper Commands',
      test: function (label) {
        return /damper/i.test(label);
      },
    },
    {
      name: 'Fan Controls',
      test: function (label) {
        return /fan|vfd|speed/i.test(label);
      },
    },
    {
      name: 'Setpoints',
      test: function (label) {
        return /setpoint|set point/i.test(label);
      },
    },
    {
      name: 'Status & Sensors',
      test: function (label) {
        return /status|sensor|co2|freeze|plant/i.test(label);
      },
    },
  ];

  var catTypeOrder = ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'ct'];
  // Collect all options: { key, label, equipType }
  var raw = [];
  var rawSeen = {}; // equipType:key dedup
  for (var ti = 0; ti < catTypeOrder.length; ti++) {
    var et = catTypeOrder[ti];
    var cats = EM_POINT_CATEGORIES[et] || [];
    for (var ci = 0; ci < cats.length; ci++) {
      var ck = et + ':' + cats[ci].key;
      if (!rawSeen[ck]) {
        rawSeen[ck] = true;
        raw.push({ key: cats[ci].key, label: cats[ci].label, equipType: et });
      }
    }
  }

  // Assign functional group, deduplicate by label within each group
  var grouped = {}; // groupName -> [{ key, label, equipType }]
  var labelInGroup = {}; // groupName + ':' + normLabel -> true
  for (var ri = 0; ri < raw.length; ri++) {
    var opt = raw[ri];
    var grpName = 'Other';
    for (var gi = 0; gi < funcGroups.length; gi++) {
      if (funcGroups[gi].test(opt.label)) {
        grpName = funcGroups[gi].name;
        break;
      }
    }
    var dedupeKey = grpName + ':' + opt.label.toLowerCase();
    if (!labelInGroup[dedupeKey]) {
      labelInGroup[dedupeKey] = true;
      if (!grouped[grpName]) grouped[grpName] = [];
      grouped[grpName].push({ key: opt.key, label: opt.label, equipType: opt.equipType, funcGroup: grpName });
    }
  }

  // Flatten in group order (funcGroups order, then Other)
  var result = [];
  var groupOrder = funcGroups.map(function (g) {
    return g.name;
  });
  groupOrder.push('Other');
  for (var gi2 = 0; gi2 < groupOrder.length; gi2++) {
    var gName = groupOrder[gi2];
    var entries = grouped[gName] || [];
    for (var ei = 0; ei < entries.length; ei++) {
      result.push(entries[ei]);
    }
  }
  return result;
}

/* ── emBuildCategoryDropdown ────────────────────────────────────────────────
   Builds the HTML for a category <select> element, grouped by point function.
   currentVal: the currently selected value ("equipType:categoryKey" or
   "__exclude__" or ""). rawName and equipCategory are stored as data attrs. */
function emBuildCategoryDropdown(rawName, equipCategory, currentVal, allCatOptions) {
  var selectHtml =
    '<select data-rawname="' +
    emHtmlEsc(rawName) +
    '" data-equip="' +
    emHtmlEsc(equipCategory) +
    '" ' +
    'style="font-size:11px;padding:2px 6px;background:var(--s2);border:1px solid var(--border);' +
    'color:var(--text);border-radius:4px;height:24px;max-width:280px">' +
    '<option value="">— Select category —</option>' +
    '<option value="__exclude__"' +
    (currentVal === '__exclude__' ? ' selected' : '') +
    '>Exclude (not audit relevant)</option>';

  var lastGroup = '';
  for (var oi = 0; oi < allCatOptions.length; oi++) {
    var opt = allCatOptions[oi];
    if (opt.funcGroup !== lastGroup) {
      if (lastGroup !== '') selectHtml += '</optgroup>';
      selectHtml += '<optgroup label="' + emHtmlEsc(opt.funcGroup) + '">';
      lastGroup = opt.funcGroup;
    }
    var optVal = opt.equipType + ':' + opt.key;
    // Match: currentVal may be "equipType:key" — try exact match first,
    // then match on key alone (for cases where equipType differs)
    var isSelected =
      currentVal === optVal ||
      (currentVal &&
        currentVal !== '__exclude__' &&
        currentVal.split(':').slice(1).join(':') === opt.key &&
        !selectHtml.includes(' selected'));
    selectHtml +=
      '<option value="' +
      emHtmlEsc(optVal) +
      '"' +
      (isSelected ? ' selected' : '') +
      '>' +
      emHtmlEsc(opt.label) +
      '</option>';
  }
  if (lastGroup !== '') selectHtml += '</optgroup>';
  selectHtml += '</select>';
  return selectHtml;
}

/* ── emOpenManageMappings ───────────────────────────────────────────────────
   Opens the Manage Mappings modal.
   Section 1: Unmatched Points — points with no auto-match; each has a
              dropdown to assign to a category.
   Section 2: Mapped Points — points that auto-matched; shown read-only with
              category label and confidence level.
   Guidance text at top. Dropdown groups by point function, not equipment type.
   Existing custom mappings are pre-selected in unmatched dropdowns.        */
function emOpenManageMappings(pid) {
  if (!pid) pid = window._emActivePid;
  if (!pid) return;

  var data = emLoadMatrix(pid);
  var rows = data.rows || [];
  if (rows.length === 0) {
    showToast('No equipment data to analyse', 'warn');
    return;
  }

  var allPoints = emGetAllPoints(rows);
  var customMappings = emLoadCustomMappings(pid);

  // Build lookup: normName -> { categoryKey, equipCategory } from existing custom mappings
  var existingCustomMap = {};
  for (var mi = 0; mi < customMappings.length; mi++) {
    var m = customMappings[mi];
    if (m.rawName) existingCustomMap[emNormalizePointName(m.rawName)] = m;
  }

  // Separate into unmatched (need attention) and matched (auto-detected)
  var unmatchedPoints = [];
  var matchedPoints = [];
  for (var pi = 0; pi < allPoints.length; pi++) {
    var pt = allPoints[pi];
    var normName = emNormalizePointName(pt.name);
    var hasCustom = !!existingCustomMap[normName];
    if (pt.status === 'unmatched' || hasCustom) {
      // Unmatched OR previously custom-mapped — show in editable section
      unmatchedPoints.push(pt);
    } else if (pt.status === 'matched') {
      matchedPoints.push(pt);
    }
    // excluded points are silently omitted (they're already handled)
  }

  // Build functional category options for dropdown
  var allCatOptions = emBuildFunctionalCatOptions();

  // ── Section 1: Unmatched Points ──────────────────────────────────────────
  var unmatchedRowsHtml = '';
  var unmatchedTotalOccurrences = 0;
  for (var ui = 0; ui < unmatchedPoints.length; ui++) {
    unmatchedTotalOccurrences += unmatchedPoints[ui].count;
  }

  if (unmatchedPoints.length === 0) {
    unmatchedRowsHtml =
      '<tr><td colspan="3" style="padding:16px 12px;text-align:center;color:var(--text3);font-size:11px">' +
      'All points are matched — nothing needs mapping.' +
      '</td></tr>';
  } else {
    for (var upi = 0; upi < unmatchedPoints.length; upi++) {
      var up = unmatchedPoints[upi];
      var normUp = emNormalizePointName(up.name);
      // currentVal: use existing custom mapping if present, else empty
      var existingEntry = existingCustomMap[normUp];
      var currentVal = '';
      if (existingEntry) {
        currentVal =
          existingEntry.categoryKey === '__exclude__'
            ? '__exclude__'
            : existingEntry.equipCategory
              ? existingEntry.equipCategory + ':' + existingEntry.categoryKey
              : existingEntry.categoryKey;
      }
      var countTitle = 'This point appears on ' + up.count + ' equipment row' + (up.count !== 1 ? 's' : '');
      var selectHtml = emBuildCategoryDropdown(up.name, up.equipCategory, currentVal, allCatOptions);
      unmatchedRowsHtml +=
        '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px 12px;font-size:11px;font-family:Consolas,monospace;color:var(--text);max-width:320px;word-break:break-word">' +
        emHtmlEsc(up.name) +
        '</td>' +
        '<td style="padding:6px 12px;font-size:11px;color:var(--text2);text-align:center;white-space:nowrap" title="' +
        emHtmlEsc(countTitle) +
        '">' +
        up.count +
        '</td>' +
        '<td style="padding:6px 8px;font-size:11px">' +
        selectHtml +
        '</td>' +
        '</tr>';
    }
  }

  // ── Section 2: Auto-Matched Points ───────────────────────────────────────
  var matchedRowsHtml = '';
  for (var mpi = 0; mpi < matchedPoints.length; mpi++) {
    var mp = matchedPoints[mpi];
    var confColor = mp.confidence === 'high' ? '#27ae60' : mp.confidence === 'medium' ? '#e67e22' : '#888';
    var confLabel = mp.confidence === 'high' ? 'High' : mp.confidence === 'medium' ? 'Medium' : 'Low';
    var confTitle =
      'Auto-match confidence: ' +
      confLabel +
      '. Click Save if this looks correct, or use the Unmatched section to override.';
    var mCountTitle = 'This point appears on ' + mp.count + ' equipment row' + (mp.count !== 1 ? 's' : '');
    matchedRowsHtml +=
      '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:6px 12px;font-size:11px;font-family:Consolas,monospace;color:var(--text);max-width:280px;word-break:break-word">' +
      emHtmlEsc(mp.name) +
      '</td>' +
      '<td style="padding:6px 12px;font-size:11px;color:var(--text2);text-align:center;white-space:nowrap" title="' +
      emHtmlEsc(mCountTitle) +
      '">' +
      mp.count +
      '</td>' +
      '<td style="padding:6px 12px;font-size:11px;color:var(--text2)">' +
      emHtmlEsc(mp.matchedLabel) +
      '</td>' +
      '<td style="padding:6px 12px;font-size:11px;text-align:center" title="' +
      emHtmlEsc(confTitle) +
      '">' +
      '<span style="color:' +
      confColor +
      ';font-weight:600;font-size:10px">' +
      confLabel +
      '</span>' +
      '</td>' +
      '</tr>';
  }

  // ── Assemble modal HTML ───────────────────────────────────────────────────
  var thStyle =
    'padding:8px 12px;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;' +
    'letter-spacing:0.05em;text-align:left;border-bottom:1px solid var(--border);' +
    'position:sticky;top:0;background:var(--s1)';

  var sectionHeadStyle =
    'padding:8px 12px;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;' +
    'letter-spacing:0.06em;background:var(--s1);border-bottom:1px solid var(--border);' +
    'border-top:2px solid var(--border)';

  var matchedSection =
    matchedPoints.length === 0
      ? ''
      : '<tr><td colspan="4" style="' +
        sectionHeadStyle +
        '">Auto-Matched Points (' +
        matchedPoints.length +
        ') — verify these look correct</td></tr>' +
        matchedRowsHtml;

  var modalHtml =
    '<div id="em-manage-mappings-overlay" ' +
    'style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px" ' +
    'onclick="emCloseManageMappings(event)">' +
    '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;width:860px;max-width:100%;' +
    'max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4)" ' +
    'onclick="event.stopPropagation()">' +
    // Header
    '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:12px;flex-shrink:0">' +
    '<div style="flex:1">' +
    '<div style="font-size:14px;font-weight:700;color:var(--text)">Manage Point Mappings</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px" ' +
    'title="Map unrecognized BAS points to ASHRAE 36 categories. Hover any point name or count for details.">' +
    'Map unrecognized BAS points to ASHRAE 36 categories. Hover any point for details.' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:2px">' +
    unmatchedPoints.length +
    ' unmatched &nbsp;|&nbsp; ' +
    matchedPoints.length +
    ' auto-matched &nbsp;|&nbsp; ' +
    (unmatchedTotalOccurrences +
      (function () {
        var t = 0;
        for (var i = 0; i < matchedPoints.length; i++) t += matchedPoints[i].count;
        return t;
      })()) +
    ' total point occurrences' +
    '</div>' +
    '</div>' +
    '<button onclick="emCloseManageMappings()" ' +
    'style="font-size:16px;background:none;border:none;color:var(--text2);cursor:pointer;padding:4px 8px;line-height:1;flex-shrink:0">X</button>' +
    '</div>' +
    // Table scroll area
    '<div style="flex:1;overflow-y:auto;min-height:0">' +
    '<table style="width:100%;border-collapse:collapse">' +
    '<thead>' +
    '<tr style="background:var(--s1)">' +
    '<th style="' +
    thStyle +
    '">Point Name</th>' +
    '<th style="' +
    thStyle +
    ';text-align:center;width:70px" title="Number of equipment rows that contain this point name">Devices</th>' +
    '<th style="' +
    thStyle +
    '">Assign to Category</th>' +
    '<th style="' +
    thStyle +
    ';width:10px"></th>' +
    '</tr>' +
    '</thead>' +
    '<tbody>' +
    // Unmatched section header
    '<tr><td colspan="4" style="' +
    sectionHeadStyle +
    'border-top:none">Unmatched Points (' +
    unmatchedPoints.length +
    ') — need mapping</td></tr>' +
    unmatchedRowsHtml +
    // Matched section
    matchedSection +
    '</tbody>' +
    '</table>' +
    '</div>' +
    // Footer
    '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0">' +
    '<span style="font-size:11px;color:var(--text3);flex:1">Mappings are saved per project. Re-import is not required — the matrix re-renders immediately.</span>' +
    '<button onclick="emCloseManageMappings()" ' +
    'style="font-size:11px;padding:6px 16px;background:var(--s3);border:1px solid var(--border);color:var(--text);border-radius:4px;cursor:pointer;height:30px">Cancel</button>' +
    '<button onclick="emSaveManageMappings(\'' +
    pid +
    '\')" ' +
    'style="font-size:11px;padding:6px 16px;background:var(--accent);border:none;color:#fff;border-radius:4px;cursor:pointer;height:30px;font-weight:600">Save Mappings</button>' +
    '</div>' +
    '</div>' +
    '</div>';

  var el = document.createElement('div');
  el.innerHTML = modalHtml;
  document.body.appendChild(el.firstChild);
}

/* ── emCloseManageMappings ──────────────────────────────────────────────────
   Closes the Manage Mappings modal. Called by the Cancel button, the X
   button, and clicks on the overlay backdrop.                              */
function emCloseManageMappings(evt) {
  // If called from the overlay onclick, only close if the click target IS the overlay
  if (evt && evt.target && evt.target.id !== 'em-manage-mappings-overlay') return;
  var overlay = document.getElementById('em-manage-mappings-overlay');
  if (overlay) overlay.parentNode.removeChild(overlay);
}

/* ── emSaveManageMappings ───────────────────────────────────────────────────
   Reads all dropdown values from the Manage Mappings modal, merges with
   existing custom mappings (preserving any not shown in the modal), persists
   via emSaveCustomMappings(), closes the modal, and re-renders the table.

   MERGE LOGIC (fixes data-loss bug):
   1. Load existing saved mappings from storage.
   2. Build a set of raw names present in the modal (the "shown" set).
   3. For each shown point: if the user selected a value, update/add the
      entry. If the user left "— Select category —", remove any existing
      entry for that point (explicit clear).
   4. Preserve all existing entries whose raw name was NOT shown in the modal
      (i.e. previously mapped points that now auto-match and are not in the
      unmatched list). These are never deleted.                              */
function emSaveManageMappings(pid) {
  if (!pid) return;
  var overlay = document.getElementById('em-manage-mappings-overlay');
  if (!overlay) return;

  // Load existing mappings to merge into
  var existing = emLoadCustomMappings(pid);
  // Build lookup: normName -> index in existing array
  var existingIdx = {};
  for (var ei = 0; ei < existing.length; ei++) {
    if (existing[ei].rawName) {
      existingIdx[emNormalizePointName(existing[ei].rawName)] = ei;
    }
  }

  // Read all dropdowns shown in the modal
  var selects = overlay.querySelectorAll('select[data-rawname]');
  // Track which rawNames are shown in the modal (to know what we can safely update/remove)
  var shownNorms = {};
  var modalMappings = []; // new/updated entries from the modal

  for (var si = 0; si < selects.length; si++) {
    var sel = selects[si];
    var rawName = sel.getAttribute('data-rawname');
    var val = sel.value;
    var normName = emNormalizePointName(rawName);
    shownNorms[normName] = true;

    if (!val || val === '') {
      // User left blank — explicit clear: this rawName will be removed from saved mappings
      // (handled below by not including it in modalMappings)
      continue;
    }

    if (val === '__exclude__') {
      modalMappings.push({ rawName: rawName, categoryKey: '__exclude__', equipCategory: '' });
    } else {
      // val is "equipType:categoryKey" e.g. "ahu:sat"
      var parts = val.split(':');
      if (parts.length < 2) continue;
      var equipType = parts[0];
      var categoryKey = parts.slice(1).join(':');
      modalMappings.push({ rawName: rawName, categoryKey: categoryKey, equipCategory: equipType });
    }
  }

  // Build merged result:
  // Start with existing entries that were NOT shown in the modal (preserve them)
  var merged = [];
  for (var xi = 0; xi < existing.length; xi++) {
    var xEntry = existing[xi];
    var xNorm = xEntry.rawName ? emNormalizePointName(xEntry.rawName) : '';
    if (!shownNorms[xNorm]) {
      // Not shown in modal — preserve as-is
      merged.push(xEntry);
    }
    // If shown, it will be replaced by modalMappings (or dropped if blank)
  }
  // Add all entries from the modal that have a selection
  for (var nmi = 0; nmi < modalMappings.length; nmi++) {
    merged.push(modalMappings[nmi]);
  }

  emSaveCustomMappings(pid, merged);

  // Invalidate compliance cache so re-render uses the new mappings
  _emComplianceCache = {};
  _emNormCache = new Map();

  // Close modal
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

  // Re-render with updated mappings
  var data = emLoadMatrix(pid);
  emRenderTable(data, _emFilters);
  showToast(
    'Mappings saved — ' +
      modalMappings.length +
      ' assignment' +
      (modalMappings.length !== 1 ? 's' : '') +
      ' stored, ' +
      (merged.length - modalMappings.length) +
      ' preserved',
  );
}
