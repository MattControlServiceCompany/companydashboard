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
  doas: 'doas',
  erv: 'ahu',
  hrv: 'ahu',
  'energy recovery ventilator': 'ahu',
  'fan coil': 'fcu',
  fcu: 'fcu',
  crac: 'fcu',
  crah: 'fcu',
  'heat pump': 'ahu',
  wshp: 'ahu',
  gshp: 'ahu',
  // PTAC / packaged terminal units — zone-level, no central air logic → fcu bucket
  ptac: 'fcu',
  pth: 'fcu',
  'packaged terminal': 'fcu',
  'packaged terminal air conditioner': 'fcu',
  'packaged terminal heat pump': 'fcu',
  // Unit ventilators — zone-level terminal unit → fcu bucket
  'unit ventilator': 'fcu',
  'unit vent': 'fcu',
  uv: 'fcu',
  'vav terminal w/ reheat': 'vav',
  'vav terminal with reheat': 'vav',
  'vav reheat': 'vav',
  'vav box': 'vav',
  'vav terminal': 'vav',
  'parallel fan terminal': 'fpb',
  'fan terminal unit': 'fpb',
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
  furnace: 'furnace',
  'unit heater': 'heater',
  uh: 'heater',
  'chilled water plant': 'chwp',
  'chilled water plant (chillers)': 'chwp',
  'chiller plant': 'chwp',
  chwp: 'chwp',
  'cooling tower': 'ct',
  ct: 'ct',
  'weather station (no hvac)': 'other',
  'no gl36 equipment': 'other',
  'no bas equipment': 'other',
  // Exhaust fans — dedicated ef type
  'exhaust fan': 'ef',
  // Blower coil units (fan-coil equivalent in data rooms)
  bcu: 'fcu',
  // Fan terminal coils — fan-powered terminal equivalent
  ftc: 'fpb',
  // Energy recovery units
  eru: 'ahu',
  // Radiant heating ceiling panels — HW-fed terminal heating
  rhc: 'vav',
  // VRF outdoor units
  'vrf outdoor unit': 'ahu',
  'vrf condenser': 'ahu',
  // Typo: "Air Handing Unit" (missing 'l')
  'air handing unit': 'ahu',
  // Destratification fans — air circulation, ahu bucket
  'destratification fans': 'ahu',
  // Fintube heat — HW terminal heating
  'fintube heat': 'hwp',
  // Tube/infrared heaters
  'tube heater': 'heater',
  'infrared heater': 'heater',
  'radiant heater': 'heater',
  // VFD integration wrappers
  'vfd integration': 'controls',
  // Environmental / weather programs
  'environmental index': 'sensor',
  'outside air conditions': 'sensor',
  'outiside air conditions': 'sensor',
  'weather station': 'sensor',
  // Fire / smoke systems
  'smoke damper': 'fire',
  'smoke damper monitor': 'fire',
  // Plumbing / domestic water
  'domestic flow': 'plumbing',
  'domestic water': 'plumbing',
  // Power monitoring
  generator: 'power',
  'electric meter': 'power',
  'power meter': 'power',
  ups: 'power',
  ats: 'power',
  // Lighting — recognized category so JOCO-style "Lighting - ADC" parses correctly
  lighting: 'lighting',
  'lighting zone': 'lighting',
  'lighting control': 'lighting',
  // Lighting / shade programs — JOCO Courthouse naming conventions
  glpp: 'lighting',
  // M4: Non-HVAC specific categories — eliminate generic 'other'
  // Elevator systems
  elevator: 'elevator',
  // Temperature / pressure / leak monitors (non-HVAC environmental monitoring)
  'temperature monitor': 'monitoring',
  'temp monitor': 'monitoring',
  'leak detection': 'monitoring',
  'water detection': 'monitoring',
  'pressure monitor': 'monitoring',
  // Security / access control perimeter programs
  'access control': 'security',
  'card reader': 'security',
};

/* ── CATEGORY FRIENDLY LABELS ──
   Maps internal category keys (from emClassifyEquipType) to human-readable labels
   shown in the "Equipment Type" column. Used by emFormatCell for isCategory defs. */
var EM_CATEGORY_LABELS = {
  ahu: 'AHU / RTU',
  vav: 'VAV',
  fpb: 'FPB',
  ddvav: 'DD-VAV',
  hwp: 'HW Plant',
  chwp: 'CHW Plant',
  ct: 'Cooling Tower',
  // M3: New specific types — replace generic 'other' for HVAC
  fcu: 'Fan Coil / VRF',
  heater: 'Unit Heater',
  ef: 'Exhaust Fan',
  doas: 'DOAS / ERV',
  furnace: 'Furnace / VVT',
  zone: 'VVT Zone',
  // M3: Non-HVAC specific categories
  lighting: 'Lighting',
  fire: 'Fire / Smoke',
  power: 'Power / Gen',
  plumbing: 'Plumbing',
  controls: 'Controls / VFD',
  sensor: 'Sensor / Weather',
  // M4: New non-HVAC categories to eliminate generic 'other'
  elevator: 'Elevator',
  monitoring: 'Monitoring',
  security: 'Security / Access',
  other: 'Other',
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

function emGetActiveProjId() {
  return window._activeProjId || window._emActivePid || null;
}

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
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}

/* ── emSetAuditView / emSetRawView ──────────────────────────────────────────
   Each button selects its own mode directly (no blind toggle). Both buttons
   stay visible at all times; emSyncViewModeControls handles active/inactive
   styling. Re-renders the table and shows/hides column controls.           */
function emSetAuditView() {
  _emDrillBuilding = null;
  _emViewMode = 'audit';
  emSyncViewModeControls();
  var data = emLoadMatrix(window._emActivePid);
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}
function emSetRawView() {
  _emDrillBuilding = null;
  _emViewMode = 'raw';
  emSyncViewModeControls();
  var data = emLoadMatrix(window._emActivePid);
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}
/* Legacy alias — kept in case any caller still uses emToggleViewMode()    */
function emToggleViewMode() {
  if (_emViewMode === 'audit') {
    emSetRawView();
  } else {
    emSetAuditView();
  }
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
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}

/* ── emDrillBuilding ────────────────────────────────────────────────────────
   Enters per-building detail view within the Summary view.
   Sets _emDrillBuilding to the building name and re-renders.             */
function emDrillBuilding(pid, buildingName) {
  _emDrillBuilding = buildingName;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}

/* ── emExitDrillBuilding ────────────────────────────────────────────────────
   Exits per-building detail view and returns to the summary table.       */
function emExitDrillBuilding(pid) {
  _emDrillBuilding = null;
  _emCurrentPage = 0;
  var data = emLoadMatrix(pid);
  if (!data) return; // DB not ready yet — user will re-click after load
  emRenderTable(data, _emFilters);
}

/* ── emSyncViewModeControls ─────────────────────────────────────────────────
   Shows/hides toolbar controls based on current _emViewMode.
   Manages two always-visible Audit/Raw buttons (#em-audit-btn, #em-raw-btn):
   the active one gets accent fill; the inactive one gets btn-ghost styling
   (visible 1px border, transparent bg, text2 color).                      */
function emSyncViewModeControls() {
  var rawToggles = document.getElementById('em-raw-col-toggles');
  var dynControls = document.getElementById('em-dyn-col-controls');
  var auditInfo = document.getElementById('em-audit-col-info');
  var summaryBtn = document.getElementById('em-summary-btn');
  var auditBtn = document.getElementById('em-audit-btn');
  var rawBtn = document.getElementById('em-raw-btn');

  // Helper: set active accent style on a button
  function setActive(btn) {
    if (!btn) return;
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'transparent';
  }
  // Helper: set inactive ghost style on a button
  function setInactive(btn) {
    if (!btn) return;
    btn.style.background = 'transparent';
    btn.style.color = 'var(--text2)';
    btn.style.borderColor = 'var(--border2)';
  }

  if (_emViewMode === 'audit') {
    if (rawToggles) rawToggles.style.display = 'none';
    if (dynControls) dynControls.style.display = 'none';
    if (auditInfo) auditInfo.style.display = 'inline-flex';
    setActive(auditBtn);
    setInactive(rawBtn);
    setInactive(summaryBtn);
  } else if (_emViewMode === 'summary') {
    if (rawToggles) rawToggles.style.display = 'none';
    if (dynControls) dynControls.style.display = 'none';
    if (auditInfo) auditInfo.style.display = 'none';
    setInactive(auditBtn);
    setInactive(rawBtn);
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
    setInactive(auditBtn);
    setActive(rawBtn);
    setInactive(summaryBtn);
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
    col: 'supplyAirTemp',
    label: 'Supply Air Temp',
    // M1A: added /discharge air temp/i — at AHU level "Discharge Air Temperature" is an HVAC synonym
    // for supply air temperature (discharge = leaving the AHU). This is the KEY AHU synonym test.
    // datLive cats do not include 'ahu', so without this pattern "Discharge Air Temp" is lost when
    // equipCategory='ahu'. cats includes 'ahu' so this only fires for AHU-category lookups.
    patterns: [/supply air temp/i, /sat\b/i, /discharge air temp/i],
    // Phase 2A: guard against config/alarm points like "Low Supply Air Temperature Alarm",
    // "High Supply Air Temperature Cooling" (limit config), "Supply Air Temp Setpoint",
    // "Cooling Supply Air Set Point" (SAT reset setpoint — belongs in satCoolSpLive, Phase 3).
    // M1A: added control-object exclusions — PID objects, mode-selection MSVs, diagnostic fault
    // flags, and binary enable/output signals must not map to a live sensor column.
    negativePatterns: [
      /\b(low|high|alarm|limit|setpoint|set\s*point|capacity|fault|heating|cooling)\b/i,
      /\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?|enable|lockout|output|bno)\b/i,
    ],
    types: ['AI', 'SP'],
    // Phase 1 (item 21eb08f8): added 'heater', 'furnace', 'doas' — v532 reclassified ~1,227 rows
    // from 'other' into these categories; without them in cats the category gate drops legitimate
    // supply-air-temp readings (e.g. a furnace's "Supply Air Temperature"). negativePatterns
    // already guard alarm/setpoint/limit variants so no new false matches are introduced.
    cats: ['ahu', 'vav', 'fpb', 'other', 'heater', 'furnace', 'doas'],
  },
  {
    col: 'returnAirTemp',
    label: 'Return Air Temp',
    patterns: [/return air temp/i, /rat\b/i],
    // Phase 2A: guard against "Return Air Temperature Alarm", "Return Air Temp Setpoint".
    // M1A: added control-object exclusions — control selection MSVs and diagnostic fault flags.
    negativePatterns: [
      /\b(low|high|alarm|limit|setpoint|set\s*point|capacity|fault)\b/i,
      /\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?|enable|lockout|output)\b/i,
    ],
    types: ['AI'],
    // Phase 1 (item 21eb08f8): added 'heater', 'furnace', 'doas' — same rationale as supplyAirTemp.
    cats: ['ahu', 'other', 'heater', 'furnace', 'doas'],
  },
  {
    col: 'mixedAirTemp',
    label: 'Mixed Air Temp',
    // Phase 2A: use /mixed\s+air\s+temp/i to tolerate double-space artifact
    // "Mixed  Air Temperature" from LSSD CSV exports (see taxonomy investigation).
    patterns: [/mixed\s+air\s+temp/i, /mat\b/i],
    // Phase 2A: guard against "Low Mixed Air Temperature" / "High Mixed Air Temperature"
    // (freeze-protection limit configs) and "AHU9 Mixed Air Low Limit".
    // M1A: added control-object exclusions — control selection MSVs and diagnostic fault flags.
    negativePatterns: [
      /\b(low|high|alarm|limit|setpoint|set\s*point|cutoff|capacity|fault)\b/i,
      /\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?|enable|lockout|output)\b/i,
    ],
    types: ['AI'],
    // Phase 1 (item 21eb08f8): added 'furnace', 'doas' — mixed air is an AHU/furnace/DOAS concept.
    // heater intentionally excluded: a standalone heater does not have a mixed-air plenum.
    cats: ['ahu', 'furnace', 'doas'],
  },
  {
    col: 'outdoorAirTemp',
    label: 'OAT (Live)',
    // FIX 4d: Added dry bulb patterns to match CSV 'Outside Air Dry Bulb'
    // Phase 1: Added /outside air temperature/i and /outside\s+air\s+temp\b/i for JOCO naming ("Outside Air Temperature").
    patterns: [
      /outside air temperature/i,
      /outside\s+air\s+temp\b/i,
      /outside air dry bulb/i,
      /outdoor air dry bulb/i,
      /outdoor air temp/i,
      /\boat\b/i,
      /oat \(live\)/i,
    ],
    // M1A: added negativePatterns — oatLive previously had none. Blocks lockout setpoints (ANO),
    // diagnostic fault flags, and sensor-alarm objects from occupying the live OAT column.
    negativePatterns: [/\b(alarm|lockout|diagnostic|sensor\s+fail(ed|ure)?|enable|output)\b/i],
    types: ['AI'],
    // M5+: added 'sensor' so dedicated outdoor-air sensor programs can map live OAT.
    // Phase 1: added 'other' + global:true so 'other'-category equipment get OAT; global bypasses cat-gate entirely.
    cats: ['ahu', 'hwp', 'chwp', 'sensor', 'other'],
    global: true,
  },
  {
    col: 'supplyFanSpeed',
    label: 'Supply Fan Speed',
    // FIX 4b: Added /supply fan.*speed/i and /fan.*vfd.*speed/i to match 'Supply Fan VFD Speed'
    patterns: [/supply fan.*speed/i, /fan.*vfd.*speed/i, /supply fan speed/i, /fan speed/i, /sf speed/i],
    // Phase 2A: guard against "Return Fan VFD Speed" (needs rfSpeedLive, Phase 3), "Low Fan Speed
    // Alarm", "Max Fan Speed" / "Maximum Fan Speed" (config limit), "Return Fan Drive Output Speed".
    // M3: added boiler (combustion fan), ct-N (cooling tower fan — routes to ctFanSpeedLive),
    // stair/pressurization (life-safety fans), manual/msv/select/command (control objects),
    // diagnostic (diagnostic messages where "fan speed" is context only), running/enable (binary status).
    // liebert blocks "Fan Speed Temperature Set Point To Liebert" setpoint transmission.
    // Pump guard prevents "EF-7 VFD Speed" and similar from landing here — exhaust already guarded.
    // M8: added 'relief' to first negativePattern so "Relief Fan VFD Speed" routes to efSpeedLive.
    negativePatterns: [
      /\b(return|exhaust|relief|low|high|alarm|limit|maximum|minimum|fault)\b/i,
      /\b(boiler|ct-?\d+|tower\s*\d+|stair|pressuri[sz]ation|manual|msv|select|command|diagnostic|running|enable|liebert)\b/i,
    ],
    types: ['AI', 'AO'],
    cats: ['ahu'],
  },
  {
    col: 'ductStaticPressure',
    label: 'Duct Static Pressure',
    patterns: [/duct static pressure/i, /\bdsp\b/i],
    // M1A: added negativePatterns. Blocks alarm objects (High/Low DSP Alarm), exhaust duct static
    // (routes to rdspLive which has /exhaust\s+duct\s+static/i confirmed), and DSP setpoint ANOs
    // (routes to dspSpLive). "exhaust" safe here because rdspLive already has exhaust patterns.
    negativePatterns: [
      /\b(alarm|lockout|diagnostic|sensor\s+fail(ed|ure)?|enable|output|pid|high|low|exhaust|setpoint|ano)\b/i,
    ],
    types: ['AI'],
    cats: ['ahu'],
  },
  // Building Static Pressure — space/building differential pressure vs outdoors (DOAS, large AHUs)
  {
    col: 'buildingStaticPressure',
    label: 'Building Static Pressure',
    patterns: [
      /building\s+static\s+pressure/i,
      /building\s+(?:static\s+)?dp\b/i,
      /bldg\s+static/i,
      /doas\s+building\s+static/i,
    ],
    negativePatterns: [/\b(alarm|setpoint|set\s?point|control\s+selection|smoothed)\b/i],
    types: ['AI', 'BAI', 'BAV', 'ANI'],
    cats: ['ahu', 'doas', 'other'],
  },
  {
    col: 'oaDamperPosition',
    label: 'OA Damper Position',
    // M4: added /outside\s+air\s+damper/i — "Outside Air Damper Position" was missing this
    // variant and falling through to damperPosition. "outdoor air damper" existed; "outside air
    // damper" is a common alternative phrasing in JOCO data.
    patterns: [/oa damper/i, /outdoor air damper/i, /outside\s+air\s+damper/i],
    types: ['AO', 'AI'],
    cats: ['ahu'],
  },
  {
    col: 'coolingValve',
    label: 'Cooling Valve Position',
    patterns: [/cooling valve/i, /chw valve/i, /clg valve/i, /chilled\s+water\s+valve/i],
    // Phase 2A: guard against "Cooling Valve Capacity GPM" (sizing config), "Cooling Valve Low Limit"
    // (valve minimum position config), "Cooling Valve Cutoff Temp" (freeze protection limit).
    negativePatterns: [/\b(limit|capacity|cutoff|gpm|alarm|fault|maximum|minimum)\b/i],
    types: ['AO', 'AI'],
    cats: ['ahu', 'fpb'],
  },
  {
    col: 'heatingValve',
    label: 'Heating Valve Position',
    // Phase 3a: removed /reheat valve/i — reheat valve must map to reheatValveLive (zone category),
    // not to the AHU heating-coil valve. Shadow was preventing zone reheat valve from auto-assigning.
    // M1A: added /preheat\s+valve/i — preheat coil valve belongs with AHU heating valves (taxonomy
    // confirms), blocked from reheatValveLive by M1A preheat negative added there.
    patterns: [/heating valve/i, /hw valve/i, /htg valve/i, /preheat\s+valve/i, /hot\s+water\s+valve/i],
    // Phase 2A: guard against "Heating Valve Capacity GPM", "Heating Valve Low Limit",
    // "Heating Valve Cutoff", "Heating Valve Maximum/Minimum".
    // M1A: added PID/float-subobject/enable/adjust exclusions.
    // floating/close and floating/open are sub-objects; the base "Heating Valve Floating" still matches.
    negativePatterns: [
      /\b(limit|capacity|cutoff|gpm|alarm|fault|maximum|minimum)\b/i,
      /\b(pid|bacnet\s*pid|floating\s*\/\s*(close|open)|enable|adjust)\b/i,
    ],
    types: ['AO', 'AI'],
    cats: ['ahu', 'vav', 'fpb'],
  },
  {
    col: 'oaAirflow',
    label: 'OA Airflow (cfm)',
    // M4: added /outdoor\s+airflow/i and /outside\s+airflow/i so "Outdoor Airflow" and
    // "Outside Airflow" route here instead of falling through to discFlowLive.
    // These must be positioned BEFORE discFlowLive in the array (oaFlowLive is currently before
    // discFlowLive at lines ~429 vs ~489) — confirmed safe.
    // M5: added /outside\s+air\s+cfm\b/i, /outside\s+air\s+total\s+cfm\b/i,
    // /economizer\s+outside\s+air\s+cfm/i for additional OA CFM name variants.
    // negativePatterns blocks "Low Outdoor Airflow" alarm and "(Calculated)" derived values.
    patterns: [
      /oa airflow/i,
      /outdoor air flow/i,
      /oa cfm/i,
      /outdoor\s+airflow/i,
      /outside\s+airflow/i,
      /outside\s+air\s+cfm\b/i,
      /outside\s+air\s+total\s+cfm\b/i,
      /economizer\s+outside\s+air\s+cfm/i,
    ],
    negativePatterns: [/\b(low|high|alarm|normal|fault|status|reset|minimum|maximum)\b/i, /\bcalculated\b/i],
    types: ['AI', 'BAI', 'BAV'],
    cats: ['ahu', 'doas'],
  },
  {
    col: 'zoneAirTemp',
    label: 'Zone Air Temp',
    patterns: [/zone air temp/i, /room temp/i, /space temp/i, /zone temp/i],
    // Fix 4c566756: labelAliases for WebCTRL snapshot column-name variants where the
    // BACnet key appears in parens after the label (e.g. 'Zone Air Temp (zone_air_temp)').
    // These follow the same pattern used by zoneCO2 and zoneRelativeHumidity labelAliases.
    labelAliases: ['Zone Air Temp (zone_air_temp)', 'Zone Temp (zone_temp)', 'Zone Temperature (zone_temperature)'],
    // Negative guard: alarm/status/setpoint names must NOT map here even if the
    // pattern matches (e.g. "High Zone Temperature", "Low Zone Temperature").
    // Phase 2B: "virtual" removed — "Virtual Zone Temperature" should map here via
    // the virtual-stripping logic in emMapPointToColumn; excluding it hides useful data.
    // M1A: added ano (ANO = Analog Network Output command) and controlling (control output).
    negativePatterns: [
      /\b(high|low|alarm|fault|fail(ed|ure)?|diagnostic|setpoint|set\s?point|override|limit|status|enable|effective)\b/i,
      /\b(ano\b|controlling)\b/i,
    ],
    types: ['AI'],
    // Single-zone-AHU (Quick Win 2): 'ahu' added so import-time mapping routes "Zone Temp"
    // on single-zone RTUs/AHUs to zoneAirTemp. Gate in emComputeBuildingZoneStats prevents
    // true multizone AHUs from being counted as zone equipment at runtime.
    cats: ['vav', 'fpb', 'ddvav', 'ahu'],
  },
  {
    col: 'zoneCoolSetpoint',
    label: 'Zone Cooling Setpoint',
    // FIX 3b (1b74f531): Use /cooling.*setpoint/i to also match 'Cooling Occupied Setpoint'
    // (word order: Cooling → Occupied → Setpoint). negativePatterns blocks Adjust and Unoccupied.
    patterns: [/cooling.*setpoint/i, /clg setpoint/i],
    // M1A: added exclusions for PID sub-objects, integration parameters, mismatch alarms,
    // remote/network transmitted copies, and SAT-level cooling setpoints (route to satCoolSpLive).
    negativePatterns: [
      /adjust|unoccupied/i,
      /\b(bacnet\s*pid|integration|mismatch|alarm|remote|command|mcs|bas\b)\b/i,
      /supply\s+air/i,
    ],
    types: ['SP'],
    // Single-zone-AHU (Quick Win 2): 'ahu' added so import-time mapping routes occupied
    // cooling setpoints on single-zone RTUs/AHUs to zoneCoolSetpoint.
    cats: ['vav', 'fpb', 'ddvav', 'fcu', 'ahu'],
  },
  {
    col: 'zoneHtgSetpoint',
    label: 'Zone Heating Setpoint',
    // FIX 3b (1b74f531): Use /heating.*setpoint/i to also match 'Heating Occupied Setpoint'.
    // negativePatterns blocks Adjust and Unoccupied.
    patterns: [/heating.*setpoint/i, /htg setpoint/i],
    // M1A: added exclusions for PID sub-objects, mismatch alarms, remote/network copies,
    // and SAT-level heating setpoints (route to satHtgSpLive).
    negativePatterns: [
      /adjust|unoccupied/i,
      /\b(bacnet\s*pid|mismatch|alarm|remote|command|mcs|diagnostic)\b/i,
      /supply\s+air/i,
    ],
    types: ['SP'],
    // Single-zone-AHU (Quick Win 2): 'ahu' added so import-time mapping routes occupied
    // heating setpoints on single-zone RTUs/AHUs to zoneHtgSetpoint.
    cats: ['vav', 'fpb', 'ddvav', 'fcu', 'ahu'],
  },
  // Zone cooling setpoint ADJUST (separate from occupied setpoint, which uses existing zoneCoolSetpoint)
  {
    col: 'zoneCoolAdjust',
    label: 'Cooling Setpoint Adjust',
    patterns: [/cooling setpoint adjust/i, /clg setpoint adj/i, /cooling set point adjust/i],
    types: ['SP', 'AV'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Zone heating setpoint ADJUST
  {
    col: 'zoneHtgAdjust',
    label: 'Heating Setpoint Adjust',
    patterns: [/heating setpoint adjust/i, /htg setpoint adj/i, /heating set point adjust/i],
    types: ['SP', 'AV'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  {
    col: 'dischargeAirTemp',
    label: 'Discharge Air Temp',
    patterns: [/discharge air temp/i, /\bdat\b/i],
    // M1A: added negativePatterns (proactive guard — same structural risk as other temp columns).
    negativePatterns: [
      /\b(alarm|lockout|diagnostic|sensor\s+fail(ed|ure)?|enable|output|pid|bacnet\s*pid|control\s+selection)\b/i,
    ],
    types: ['AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'reheatValve',
    label: 'Reheat Valve',
    patterns: [/reheat valve/i],
    // M1A: added negativePatterns. "Preheat Valve" and its sub-objects contain "reheat valve"
    // as a substring (P-REHEAT-VALVE). GPM/limit block config sizing points. Enable blocks command.
    // "Preheat Valve" now routes to htgValveLive via /preheat\s+valve/i added there.
    negativePatterns: [/\b(preheat|gpm|limit|enable)\b/i],
    types: ['AO', 'AI'],
    cats: ['vav', 'fpb'],
  },
  {
    col: 'damperPosition',
    label: 'Damper Position',
    patterns: [/damper position/i, /dmp pos/i],
    // M4: added negativePatterns. "Outside Air Damper Position" now caught by oaDampLive
    // (M4: /outside\s+air\s+damper/i added there). "Return Air Damper Position" caught by
    // raDampLive (/return\s+air\s+damper/i confirmed). Economizer min is a config setpoint,
    // not a live position feedback.
    negativePatterns: [/\b(outside\s+air|return\s+air|economizer\s+min|minimum|maximum)\b/i],
    types: ['AO', 'AI'],
    cats: ['vav', 'fpb', 'ddvav'],
  },
  {
    col: 'dischargeAirflow',
    label: 'Discharge Airflow',
    // FIX 2 (a0d29b4c): Added /\bair\s*flow\b/i and /flow.*input/i to match CSV 'Air Flow'
    // and 'Flow Control / Flow Input'. negativePatterns blocks setpoints/requests/min/max.
    // M4: Tightened /flow.*input/i to /\bflow\s+(control\s*\/\s*)?input\b/i so "Chilled Water
    // Flow Input" no longer matches (it contains "chilled water" which is a water-system point,
    // not zone airflow). Also added broad negativePatterns for OA/water/alarm words per plan M4
    // "discFlowLive / oaFlowLive fix": outdoor/outside redirect to oaFlowLive; chilled/condenser/
    // hot water are plant-side flow points; supply fan/filter/switch/proof/loss/status/alarm/
    // percentage/percent all indicate non-airflow points. These are confirmed mis-maps (Group J).
    // 2e6322d5/a0d29b4c: expanded cats to include fcu and zone — FCU/FTU units and VVT zone
    // terminals may report discharge cfm; ahu added so RTU airflow readings surface on AHU rows.
    // v469 fix: removed 'ahu' from cats — discharge airflow is a terminal-unit concept; AHU
    // supply-side airflow belongs to supplyFanCFM (cats: ahu). Also added /supply\s+air/ to
    // negativePatterns as belt-and-suspenders so "Supply Air Flow" never routes here even on
    // terminal rows where the broad /\bair\s*flow\b/i pattern would otherwise match.
    patterns: [
      /discharge airflow/i,
      /disc airflow/i,
      /zone airflow/i,
      /\bair\s*flow\b/i,
      /\bflow\s+(control\s*\/\s*)?input\b/i,
    ],
    negativePatterns: [
      /set\s*point|setpoint|request|minimum|maximum/i,
      /\bsupply\s+air(?:\s*flow)?\b/i,
      /\b(outdoor|outside|supply\s+fan|filter|switch|proof|loss|status|alarm|percentage|percent|chilled\s+water|condenser\s+water|hot\s+water)\b/i,
    ],
    types: ['AI'],
    cats: ['vav', 'fpb', 'ddvav', 'fcu', 'zone'],
  },
  {
    col: 'hwSupplyTemp',
    label: 'HW Supply Temp',
    // Phase 1: added JOCO naming patterns (heating water supply / boiler supply water temp).
    patterns: [
      /hw supply temp/i,
      /hot water supply/i,
      /hwst\b/i,
      /heating water supply/i,
      /heating\s+water\s+supply\s+temp/i,
      /boiler\s+\w+\s+supply\s+water\s+temp/i,
      /boiler\s+supply\s+water\s+temp/i,
    ],
    // M2: added negativePatterns. CHW/CHWST names contain "HW" as substring causing false matches.
    // Domestic/DHW points are plumbing (excluded per plan decision A). High/low block alarm limits.
    negativePatterns: [
      /\b(chw|chwst|domestic|dhw|high|low|alarm)\b/i,
      /setpoint|set\s?point/i,
      /\b(valve|position|percent|cmd|command|output)\b/i,
    ],
    types: ['AI'],
    // Phase 1: added 'other' so boiler/plant equipment classified 'other' are not gated out.
    cats: ['hwp', 'other'],
  },
  {
    col: 'hwReturnTemp',
    label: 'HW Return Temp',
    // Phase 1: added JOCO naming patterns (heating water return / boiler return water temp).
    patterns: [
      /hw return temp/i,
      /hot water return/i,
      /hwrt\b/i,
      /heating water return/i,
      /heating\s+water\s+return\s+temp/i,
      /boiler\s+\w+\s+return\s+water\s+temp/i,
      /boiler\s+return\s+water\s+temp/i,
    ],
    // M2: added negativePatterns. CHWRT contains "HWRT" as substring; "DHW" contains "HW".
    // Domestic/DHW excluded (plumbing). Flow blocks "Hot Water Return Flow" (not temperature).
    // High/low block alarm limit names.
    negativePatterns: [
      /\b(chw|chwrt|domestic|dhw|high|low|alarm|flow)\b/i,
      /setpoint|set\s?point/i,
      /\b(valve|position|percent|cmd|command|output)\b/i,
    ],
    types: ['AI'],
    // Phase 1: added 'other' so boiler/plant equipment classified 'other' are not gated out.
    cats: ['hwp', 'other'],
  },
  {
    col: 'hwDiffPressure',
    label: 'HW Diff Pressure',
    // Phase 1: added JOCO naming patterns for heating water differential pressure.
    patterns: [
      /hw diff pressure/i,
      /hw differential/i,
      /heating\s+water\s+differential\s+pressure/i,
      /hot\s+water\s+differential\s+pressure/i,
    ],
    // M2: "CHW" contains "HW" so /hw differential/i fires on "CHW Differential Pressure".
    negativePatterns: [/\bchw\b/i],
    types: ['AI'],
    // Phase 1: added 'other' so plant equipment classified 'other' are not gated out.
    cats: ['hwp', 'other'],
  },
  {
    col: 'hwSupplySetpoint',
    label: 'HW Supply Setpoint',
    patterns: [/hw supply setpoint/i, /hw setpoint/i],
    types: ['SP'],
    cats: ['hwp'],
  },
  {
    col: 'chwSupplyTemp',
    label: 'CHW Supply Temp',
    patterns: [/chw supply temp/i, /chilled water supply/i, /chwst\b/i],
    // M2: high/low block alarm limit names. Flow blocks "Chilled Water Supply Flow"
    // (flow measurement, not temperature — routes to chwFlowLive).
    negativePatterns: [/\b(high|low|alarm|flow)\b/i],
    types: ['AI'],
    // Phase 1: added 'other' so plant equipment classified 'other' are not gated out.
    cats: ['chwp', 'other'],
  },
  {
    col: 'chwReturnTemp',
    label: 'CHW Return Temp',
    patterns: [/chw return temp/i, /chilled water return/i, /chwrt\b/i],
    // M2: high/low block alarm limit names (High/Low Chilled Water ReturnTemperature).
    negativePatterns: [/\b(high|low|alarm)\b/i],
    types: ['AI'],
    // Phase 1: added 'other' so plant equipment classified 'other' are not gated out.
    cats: ['chwp', 'other'],
  },
  {
    col: 'chwSupplySetpoint',
    label: 'CHW Supply Setpoint',
    patterns: [/chw supply setpoint/i, /chw setpoint/i],
    types: ['SP'],
    cats: ['chwp'],
  },
  {
    col: 'chwDiffPressure',
    label: 'CHW Diff Pressure',
    // Phase 1: added JOCO naming pattern for chilled water differential pressure.
    patterns: [/chw diff pressure/i, /chw differential/i, /chilled\s+water\s+differential\s+pressure/i],
    negativePatterns: [/setpoint|set\s?point/i, /\b(alarm|high|low)\b/i],
    types: ['AI'],
    // Phase 1: added 'other' so plant equipment classified 'other' are not gated out.
    cats: ['chwp', 'other'],
  },
  {
    col: 'chwFlow',
    label: 'CHW Flow',
    patterns: [/chw flow/i, /chilled water flow/i],
    types: ['AI'],
    cats: ['chwp'],
  },
  {
    col: 'cwSupplyTemp',
    label: 'CW Supply Temp',
    patterns: [/cw supply temp/i, /condenser water supply/i, /cwst\b/i],
    // M2: high/low block alarm limit names (High/Low Condenser Water Supply Temperature).
    negativePatterns: [/\b(high|low|alarm)\b/i],
    types: ['AI'],
    cats: ['ct'],
  },
  {
    col: 'cwReturnTemp',
    label: 'CW Return Temp',
    patterns: [/cw return temp/i, /condenser water return/i, /cwrt\b/i],
    types: ['AI'],
    cats: ['ct'],
  },
  // M4 ORDERING: co2ReturnLive is placed HERE, before co2Live.
  // co2Live has broad /\bco2\b/i which fires on any CO2 name. co2ReturnLive needs to be
  // positioned before co2Live so the more-specific return-air CO2 patterns win.
  // (The co2ReturnLive definition below replaces the original late-array position, which is removed.)
  {
    col: 'returnAirCO2',
    label: 'Return Air CO2',
    patterns: [
      /\bra\s+co2\b/i,
      /return\s+air\s+co2/i,
      /return\s+co2/i,
      /ahu-?\d+\s*-\s*co2\b/i,
      /return\s+air\s+carbon\s+dioxide/i,
    ],
    negativePatterns: [/alarm|setpoint|set\s?point/i],
    types: ['AI', 'BAI'],
    cats: ['ahu', 'dhu'],
  },
  // Fix c0bf56e0: Zone CO2 — CSV uses 'Zone CO2' and 'Zone CO2 AV'
  {
    col: 'zoneCO2',
    label: 'Zone CO2',
    // Fix c0bf56e0: 'Zone CO2 AV' is a known CSV column header variant; mapped via labelAliases.
    // 2e6322d5/c0bf56e0: added snapshot-format header 'Zone CO2 (zone_co2)' as labelAlias so
    // enriched-format snapshot CSVs with that column name map to this col at import time.
    labelAliases: ['Zone CO2 AV', 'Zone CO2 (zone_co2)'],
    patterns: [/\bco2\b/i, /zone\s*co2/i, /carbon dioxide/i, /co2\s*sensor/i, /co2\s*ppm/i],
    // Phase 2A: guard against "CO2 Alarm", "High CO2 Alarm", "CO2 Override", "CO2 Setpoint",
    // "CO2 Fault" — these are alarm/config objects, not live sensor readings.
    // M1A: added maximum/min (CO2 Maximum 1-4 config), diagnostic (sensor failure flag),
    // selection (control selection mode object), and oa/outdoor/outside (OA CO2 baseline —
    // a different ASHRAE 36 point category, excluded here).
    // NOTE: "return" and "ahu" are NOT added here — ordering fix in M4 (co2ReturnLive moved
    // before co2Live) handles return-air CO2 routing more cleanly.
    // 2e6322d5: expanded cats to include fcu — FCU/FTU equipment (FTU maps to fpb already but
    // fcu is needed for standalone fan-coil units that may carry zone CO2 sensors).
    negativePatterns: [
      /\b(alarm|high|low|override|fault|setpoint|set\s*point)\b/i,
      /\b(maximum|max|minimum|min|diagnostic|selection|outdoor|outside|oa\b)\b/i,
    ],
    types: ['AI', 'BAI', 'BAV', 'AV'],
    cats: ['ahu', 'vav', 'fpb', 'ddvav', 'fcu'],
  },
  // Milestone 1: Zone Humidity — surfaces from raw BAS point names at read time
  // Phase 3a: added negativePatterns to block "Outside Air Humidity", "Outdoor Humidity",
  // "Outside Humidity", "Return Air Humidity" — those now go to oaRhLive / rhReturnLive.
  // The broad /\bhumidity\b/i pattern is intentionally kept for zone-level humidity labels
  // (e.g. "Zone Humidity", "Space Humidity", "Media Center Humidity") but OA/outdoor/return
  // contexts are now excluded here so the more-specific columns win.
  // 2e6322d5: expanded cats to include fcu and zone — RTU units (→ahu) were already covered;
  // fcu added for standalone fan-coil units; zone added for VVT zone terminals with humidity.
  // labelAliases added for snapshot-format column headers:
  //   'Zone Hum (zone_humidity)' — WebCTRL multi-col snapshot with BACnet key in parens
  //   'Zone Hum (zhum)'          — alternate WebCTRL snapshot key variant
  //   'Zone Humidity'            — plain descriptive variant used in some CSV exports
  //   'Zone Hum'                 — abbreviated form in older snapshot exports
  // negativePatterns block "Zone Hum (sph)" (setpoint variant) via set\s?point guard.
  {
    col: 'zoneRelativeHumidity',
    label: 'Zone RH %',
    labelAliases: ['Zone Hum (zone_humidity)', 'Zone Hum (zhum)', 'Zone Humidity', 'Zone Hum'],
    patterns: [
      /zone\s*r\.?h/i,
      /space\s*r\.?h/i,
      /room\s*r\.?h/i,
      /relative\s*humidity/i,
      /zone\s*humid/i,
      /space\s*humid/i,
      /\brh\s*%/i,
      /\bhumidity\b/i,
      /\bzone\s+hum\b/i,
    ],
    // M1A: expanded negativePatterns. Exhaust/supply-air humidity are not zone RH. High/low/alarm
    // block limit configs and alarm objects. call for/controlling/selection/ano block control
    // outputs and mode objects. Existing OA/outdoor/return guards retained.
    // 2e6322d5: added sph (setpoint humidity) guard so 'Zone Hum (sph)' stays out of this col.
    negativePatterns: [
      /outside|outdoor|outside\s+air|outdoor\s+air|\boa\s+hum|return\s+air|return\s+hum|\bra\s+hum|set\s?point|\bsph\b/i,
      /\b(exhaust|supply\s+air|high|low|alarm|call\s+for|controlling|selection|ano\b)\b/i,
    ],
    types: ['AI'],
    cats: ['ahu', 'vav', 'fpb', 'ddvav', 'fcu', 'zone'],
  },
  // Phase 2C: expanded cats from ['ct'] to ['ct', 'ahu', 'dhu'] — "Outside Air Wet Bulb" and
  // "Broadcast Wet Bulb" appear on AHU and DHU (pool dehumidifier) equipment in JOCO data,
  // not only on cooling towers.
  {
    col: 'oaWetBulb',
    label: 'OA Wet Bulb',
    patterns: [/wet bulb/i, /wb\b/i],
    // M5: added negativePatterns. "HUWB" (High Wet Bulb) appears in smoke/zone alarm point names
    // like "Smoke Zone 3 HUWB" — these are alarm registers, not live OA wet bulb readings.
    // /\bhuwb\b/i blocks the confirmed Group R mis-maps without affecting "Outside Air Wet Bulb".
    negativePatterns: [/\bhuwb\b/i],
    types: ['AI'],
    cats: ['ct', 'ahu', 'dhu', 'sensor'],
    global: true,
  },
  {
    col: 'ctFanSpeed',
    label: 'CT Fan Speed',
    // M3: added CT-N and Tower-N positive patterns so "CT-1 Fan VFD Speed" and "Tower 1 Fan Speed"
    // route here (previously went to sfSpeedLive because ctFanSpeedLive missed the "CT-N" prefix format).
    patterns: [
      /ct fan speed/i,
      /cooling tower fan/i,
      /tower fan/i,
      /\bct-?\d+.*fan.*speed/i,
      /\btower\s*\d+.*fan.*speed/i,
    ],
    // M3: added negativePatterns. HOA (Hand/Off/Auto switch), PID (control loop), run/status
    // (binary run feedback), disabled/enabled status sentences, and runtime alarm objects
    // must not land in the live speed column.
    negativePatterns: [/\b(hoa|pid|run\b|disabled|enabled|runtime|exceeded|status\s+is)\b/i],
    types: ['AI', 'AO'],
    cats: ['ct'],
  },
  // M4 additions — VVT / air-source / zone points
  // Zone Damper position (VVT zone-damper terminal, zone-category units)
  {
    col: 'zoneDamper',
    label: 'Zone Damper',
    patterns: [/\bzone damper\b/i, /zone dmp/i],
    types: ['AO', 'AI'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Air Source Supply Temp — primary air temperature from VVT air-source unit
  {
    col: 'airSourceSupplyTemp',
    label: 'Air Source Supply Temp',
    patterns: [/air source supply\b/i, /primary air.*supply temp/i, /air source duct/i],
    negativePatterns: [/setpoint|set\s?point|request|min|max/i, /\b(heat|cool|hot|chilled|static)\b/i],
    types: ['AI'],
    cats: ['zone', 'vav', 'fpb', 'ahu', 'ddvav'],
  },
  // Heat Source Supply Temp — hot-water / hydronic primary supply temperature at VVT/VAV terminal
  {
    col: 'heatSourceSupplyTemp',
    label: 'Heat Source Supply Temp',
    patterns: [/heat source supply\b/i],
    negativePatterns: [/setpoint|set\s?point|request|static|alarm|mode|status/i],
    types: ['AI', 'ANI'],
    cats: ['vav', 'fpb', 'ddvav', 'ahu'],
  },
  // Cool Source Supply Temp — chilled-water primary supply temperature at VVT/VAV terminal
  {
    col: 'coolSourceSupplyTemp',
    label: 'Cool Source Supply Temp',
    patterns: [/cool source supply\b/i],
    negativePatterns: [/setpoint|set\s?point|request|static|alarm|mode|status/i],
    types: ['AI', 'ANI'],
    cats: ['vav', 'fpb', 'ddvav', 'ahu'],
  },
  // Effective cooling setpoint (post-adjustment value, computed by BAS)
  {
    col: 'effectiveCoolSetpoint',
    label: 'Effective Cooling Setpoint',
    patterns: [/effective cooling setpoint/i, /eff.*cool.*setpoint/i, /effective clg setpoint/i],
    types: ['SP', 'AV'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Effective heating setpoint
  {
    col: 'effectiveHtgSetpoint',
    label: 'Effective Heating Setpoint',
    patterns: [/effective heating setpoint/i, /eff.*htg.*setpoint/i, /effective htg setpoint/i],
    types: ['SP', 'AV'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Primary Air Source Cool Request — DCV/demand signal from zone to air source
  {
    col: 'primaryAirCoolRequest',
    label: 'Primary Air Source Cool Request',
    patterns: [/primary air source cool request/i, /air source cool request/i, /primary air.*cool.*request/i],
    types: ['AV', 'AI'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Primary Air Source Heat Request
  {
    col: 'primaryAirHtgRequest',
    label: 'Primary Air Source Heat Request',
    patterns: [/primary air source heat request/i, /air source heat request/i, /primary air.*heat.*request/i],
    types: ['AV', 'AI'],
    cats: ['zone', 'vav', 'fpb', 'ddvav'],
  },
  // Outside Air Dry Bulb — broadcast shared point appearing on non-ahu units via VVT controller
  {
    col: 'outdoorAirTempBcast',
    label: 'Outside Air Dry Bulb',
    patterns: [
      /outside air dry bulb/i,
      /outside air temperature/i,
      /outside air temp - rnet/i,
      /outdoor air dry bulb/i,
    ],
    // M5: expanded negativePatterns. Original guard blocked setpoints only. Group W mis-maps:
    // "Primary Outside Air Temperature Sensor Invalid" (matches "invalid"), "Outside Air
    // Temperatures Low, Cooling Tower 3-1 Heat Trace Is Off" (matches "heat trace" and "is off"),
    // "Outside Air Temperature Is On/Off" status booleans (matches "is on"/"is off"). These are
    // alarm/status objects, not live temperature readings.
    negativePatterns: [/setpoint|set\s?point/i, /\b(invalid|sensor\s+invalid|heat\s+trace|is\s+off|is\s+on)\b/i],
    types: ['AI'],
    cats: ['zone', 'vav', 'fpb', 'ddvav', 'fcu', 'furnace', 'sensor'],
    global: true,
  },
  // Zone Temperature (short alias used by some controllers — "Zone Temp")
  {
    col: 'zoneTemp',
    label: 'Zone Temperature',
    patterns: [/^zone temp(erature)?$/i, /^zone\s+temperature$/i],
    // Phase 2B: removed "virtual" — "Virtual Zone Temperature" should match after virtual-stripping
    // in emMapPointToColumn; it was previously blocked here, hiding useful data.
    negativePatterns: [/high|low|alarm|effective|set\s?point/i],
    types: ['AI'],
    cats: ['zone', 'fcu', 'heater', 'ef'],
  },

  // ── Phase 3a NEW ENTRIES ────────────────────────────────────────────────
  // GROUP 2 — Outside Air Conditions (all 3 were user-reported missing; highest priority)

  // C1: Outside Air Relative Humidity — broadcast OA RH from outdoor sensor
  // Taxonomy variants: "Outside Air Humidity", "Outside Air Humidity - RNet",
  // "Outside Humidity", "Local Outside Air Humidity", "Local Outdoor Air Humidity",
  // "RTU Outside Air Humidity", "Outdoor Humidity", "VCC-X Outside Air Humidity",
  // "AmbientHumidity". negativePatterns: sensor-fault flags are excluded.
  // Placed AFTER oaWetBulbLive (which has /wet bulb/i) so no collision possible.
  {
    col: 'oaRelativeHumidity',
    label: 'OA Relative Humidity',
    patterns: [
      /outside\s+air\s+hum/i,
      /outdoor\s+air\s+hum/i,
      /outside\s+hum(?!id.*set)/i,
      /outdoor\s+hum(?!id.*set)/i,
      /local\s+out(?:side|door)\s+air\s+hum/i,
      /rtu\s+outside\s+air\s+hum/i,
      /vcc.?x\s+outside\s+air\s+hum/i,
      /ambient\s*humidity/i,
      /\boa\s+r\.?h\b/i,
      /\boa\s+humidity\b/i,
    ],
    negativePatterns: [/invalid|sensor\s+fail|fault|set\s?point/i],
    types: ['AI'],
    cats: ['ahu', 'ct', 'dhu', 'rtu', 'vav', 'fpb', 'fcu', 'furnace', 'sensor'],
    global: true,
  },

  // C2: Outside Air Dewpoint — DISTINCT from wet bulb (was mis-aliased in oaWetBulb)
  // Taxonomy variants: "Outside Air Dewpoint", "Outside Air Dew Point",
  // "Current Dew Point". "Return Dewpoint" is AMBIGUOUS (return-air, not OA) — excluded here.
  {
    col: 'oaDewpoint',
    label: 'OA Dewpoint',
    patterns: [
      /outside\s+air\s+dew\s?point/i,
      /outdoor\s+air\s+dew\s?point/i,
      /current\s+dew\s?point/i,
      /\boa\s+dew\s?point/i,
    ],
    negativePatterns: [/return|set\s?point|invalid|fault/i],
    types: ['AI'],
    cats: ['ahu', 'ct', 'dhu', 'rtu', 'vav', 'fpb', 'fcu', 'furnace', 'sensor'],
    global: true,
  },

  // C3: Outside Air Enthalpy — broadcast OA enthalpy used for economizer control
  // Taxonomy: "Outside Air Enthalpy". negativePatterns: return-air enthalpy variants
  // ("AHU-1 - Return Air Enthalpy") and economizer-control-selection flags are not sensors.
  // Already exists in EM_POINT_CATEGORIES.ahu as 'oaEnthalpy' — this EM_POINT_MAP entry
  // allows import-time auto-assignment to show in Raw View "Mapped" column.
  {
    col: 'oaEnthalpy',
    label: 'OA Enthalpy',
    patterns: [/outside\s+air\s+enthalpy/i, /outdoor\s+air\s+enthalpy/i, /\boa\s+enthalpy\b/i],
    negativePatterns: [/return|economizer\s+control\s+selection|set\s?point|fault/i],
    types: ['AI'],
    cats: ['ahu', 'ct', 'dhu', 'rtu', 'vav', 'fpb', 'fcu', 'furnace', 'sensor'],
    global: true,
  },

  // GROUP 10 — Demand/Mode/Occupancy (user-reported missing; was blocked by EM_EXCLUSION_PATTERNS
  // broad /\bdemand\b/i — now narrowed in Phase 1C to billing demand only)

  // K1: Demand Level — broadcast ANI present on literally every control program
  // Taxonomy: "Demand Level", "KW Demand Level", "High Meter Demand Level",
  // "Demand Limit Set Point" (setpoint). negativePatterns: meter/kwh/billing/peak/interval
  // ensures utility-meter demand readings are excluded; "set point" excluded so
  // "Demand Limit Set Point" does not collide here (it's a setpoint, not a live level).
  {
    col: 'demandLevel',
    label: 'Demand Level',
    patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
    negativePatterns: [/meter|kwh|billing|peak|interval|set\s?point|limit/i],
    types: ['AI', 'AV', 'BAV'],
    cats: ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'ct', 'fcu', 'heater', 'ef', 'zone', 'furnace'],
    global: true,
  },

  // K4: Schedule / Scheduled Occupied
  // Taxonomy: "Schedule", "Scheduled Occupied", "Zone Schedule".
  // negativePatterns: "BACnet Schedule" is excluded (BACnet Schedule Object type, not a point name).
  {
    col: 'scheduledOccupied',
    label: 'Scheduled Occupied',
    patterns: [/\bscheduled?\s+occupied\b/i, /\bzone\s+schedule\b/i, /\bscheduled\s+on\b/i],
    negativePatterns: [/bacnet\s+schedule|override/i],
    types: ['AV', 'BAV', 'BI'],
    cats: ['ahu', 'vav', 'fpb', 'ddvav', 'fcu', 'heater', 'ef', 'zone', 'furnace'],
    global: true,
  },

  // GROUP 1 — Missing Air Temperature columns (A7/A8/A9)
  // A7: Preheat Coil Leaving Air Temperature
  // Taxonomy: "Preheat Air Temperature" (JOCO AHU1_extract), "OA Pre-Coil Temperature".
  {
    col: 'preheatAirTemp',
    label: 'Preheat Air Temp',
    patterns: [/preheat\s+air\s+temp/i, /oa\s+pre.?coil\s+temp/i, /pre.?heat\s+coil\s+leaving/i],
    // M1A: added low/high/warning to existing negativePatterns (blocks warning alarm variants).
    negativePatterns: [/alarm|limit|setpoint|set\s?point|fault|\b(low|high|warning)\b/i],
    types: ['AI'],
    cats: ['ahu'],
  },

  // A8: Cooling Coil Leaving Air Temperature
  // Taxonomy: "Cooling Coil Leaving Air Temperature".
  {
    col: 'coolingCoilLeavingTemp',
    label: 'Cooling Coil Leaving Temp',
    patterns: [
      /cooling\s+coil\s+leaving\s+air/i,
      /clg\s+coil\s+lvg/i,
      /cooling\s+coil\s+leaving\s+temp/i,
      /chilled\s+water\s+coil\s+leaving/i,
    ],
    negativePatterns: [/alarm|limit|setpoint|set\s?point|fault/i],
    types: ['AI'],
    cats: ['ahu'],
  },

  // A9: Heating Coil Leaving Air Temperature
  // Taxonomy: "Heating Coil Leaving Air Temperature".
  {
    col: 'heatingCoilLeavingTemp',
    label: 'Heating Coil Leaving Temp',
    patterns: [
      /heating\s+coil\s+leaving\s+air/i,
      /htg\s+coil\s+lvg/i,
      /heating\s+coil\s+leaving\s+temp/i,
      /hot\s+water\s+coil\s+leaving/i,
    ],
    negativePatterns: [/alarm|limit|setpoint|set\s?point|fault/i],
    types: ['AI'],
    cats: ['ahu'],
  },

  // GROUP 3 — Missing Zone/Space Conditions

  // D2: Return Air Humidity — at AHU or DHU level (distinct from zone RH)
  // Taxonomy: "Return Air Humidity" (DHU pool unit), "RA Hum", "AHU-1 - Return Air Humidity".
  // negativePatterns: set point excluded (that's D3 below).
  // Phase 1: added diagnostic/control-selection/sensor-fail/alarm guard to block JOCO false-positives:
  //   "Diagnostic: Return Air Humidity Sensor Failed", "Air Source Return Air Humidity Control Selection".
  {
    col: 'returnAirHumidity',
    label: 'Return Air Humidity',
    patterns: [/return\s+air\s+hum/i, /\bra\s+hum\b/i],
    negativePatterns: [/setpoint|set\s?point/i, /\b(diagnostic|control\s+selection|sensor\s+fail(ed|ure)?|alarm)\b/i],
    types: ['AI'],
    cats: ['ahu', 'dhu'],
  },

  // D3: Zone Humidity Setpoint / Dehumidification Setpoint
  // Taxonomy: "Dehumidification Set Point", "Return Humidity Set Point", "Zone Hum Set Point".
  {
    col: 'humiditySetpoint',
    label: 'Humidity Setpoint',
    patterns: [/dehumidif.*set\s?point/i, /return\s+humidity\s+set/i, /zone\s+hum.*set/i, /humidity\s+set\s?point/i],
    // M1A: added negativePatterns. PID sub-object setpoints (Dehumidification SAT BACnet PID /
    // Setpoint) must not land here; feedback/mismatch status points are not setpoints.
    negativePatterns: [/\b(bacnet\s*pid|feedback|mismatch|feedack)\b/i],
    types: ['SP', 'AV'],
    cats: ['ahu', 'dhu', 'rtu', 'vav', 'fpb'],
  },

  // E2: Return Air CO2 — MOVED before co2Live (M4 ordering fix). See entry above co2Live.

  // SP-CO2: CO2 Setpoint — the programmed CO2 SP point (distinct from co2Live which is the
  // measured CO2 level). Typical BAS names: "CO2 Setpoint", "CO2 Set Point", "Zone CO2 Setpoint".
  // negativePatterns exclude alarm/limit objects and unocc variants (separate point category).
  // RENDER-VERIFY DEFERRED: col routing against live JOCO data requires headless render.
  {
    col: 'zoneCO2Setpoint',
    label: 'Zone CO2 Setpoint',
    patterns: [/co2.*set\s*point/i, /co2.*setpoint/i],
    negativePatterns: [/unocc|alarm|high|low|reset/i],
    types: ['SP'],
    cats: ['vav', 'fpb', 'ddvav', 'ahu', 'fcu'],
  },

  // H9: Unoccupied Cooling Setpoint
  // Taxonomy: "Cooling Unoccupied Setpoint", "Unoccupied Cooling Set Point",
  // "Unoccupied Cooling Set Point ANI/ANO".
  {
    col: 'zoneUnoccCoolSetpoint',
    label: 'Unocc Cooling Setpoint',
    patterns: [/cooling\s+unoccupied\s+set/i, /unoccupied\s+cool.*set/i, /unoccupied\s+cooling/i],
    types: ['SP', 'AV'],
    cats: ['vav', 'fpb', 'ddvav', 'fcu', 'furnace', 'zone'],
  },

  // H10: Unoccupied Heating Setpoint
  // Taxonomy: "Heating Unoccupied Setpoint", "Unoccupied Heating Set Point",
  // "Unoccupied Heating Set Point ANI/ANO", "Unoccupied HTSP".
  {
    col: 'zoneUnoccHtgSetpoint',
    label: 'Unocc Heating Setpoint',
    patterns: [
      /heating\s+unoccupied\s+set/i,
      /unoccupied\s+heat.*set/i,
      /unoccupied\s+heating/i,
      /\bunoccupied\s+htsp\b/i,
    ],
    types: ['SP', 'AV'],
    cats: ['vav', 'fpb', 'ddvav', 'fcu', 'furnace', 'zone'],
  },

  // GROUP 5 — Airflow (AHU/Plant Level)

  // F2: Discharge/Zone Airflow Setpoint
  // Taxonomy: "Air Flow Set Point", "Airflow Set Point", "Flow SP".
  {
    col: 'airflowSetpoint',
    label: 'Airflow Setpoint',
    patterns: [/air\s+flow\s+set\s?point/i, /airflow\s+set\s?point/i, /flow\s+set\s?point/i],
    // M4: added negativePatterns. "Diagnostic: Min OA Flow Setpoint Fail" and "GEV-145 Valve
    // Flow Set Point ANI" variants are mis-maps (Group AA). "diagnostic" blocks the former;
    // "valve" blocks GEV valve flow setpoints which belong to valve position columns, not airflow.
    negativePatterns: [/\b(diagnostic|valve)\b/i],
    types: ['SP', 'AV'],
    cats: ['vav', 'fpb', 'ddvav'],
  },

  // F4: Ventilation CFM (AHU DCV total)
  // Taxonomy: "Ventilation CFM".
  {
    col: 'ventilationCFM',
    label: 'Ventilation CFM',
    patterns: [/ventilation\s+cfm/i],
    negativePatterns: [/set\s?point/i],
    types: ['AI', 'AV'],
    cats: ['ahu'],
  },

  // F5: Ventilation CFM Setpoint
  // Taxonomy: "Ventilation CFM Set Point", "Ventilation CFM Setpoint".
  {
    col: 'ventilationCFMSetpoint',
    label: 'Ventilation CFM Setpoint',
    patterns: [/ventilation\s+cfm\s+set/i, /ventilation\s+cfm\s+setpoint/i],
    types: ['SP', 'AV'],
    cats: ['ahu'],
  },

  // Return Air CFM — total return air volume (duct measurement, not fan speed-derived)
  {
    col: 'returnAirCFM',
    label: 'Return Air CFM',
    patterns: [/return\s+air\s+(?:total\s+)?cfm/i],
    negativePatterns: [/set\s?point|alarm|\(calculated\)/i],
    types: ['AI', 'BAI', 'BAV'],
    cats: ['ahu'],
  },

  // F6: Return Fan CFM
  // Taxonomy: "Return Fan CFM".
  {
    col: 'returnFanCFM',
    label: 'Return Fan CFM',
    patterns: [/return\s+fan\s+cfm/i],
    negativePatterns: [/set\s?point/i],
    types: ['AI', 'AV'],
    cats: ['ahu'],
  },

  // F7: Supply Fan CFM (total or per-fan)
  // Taxonomy: "Supply Fan Total CFM", "Supply Fan 1 CFM", "Supply Fan 2 CFM".
  {
    col: 'supplyFanCFM',
    label: 'Supply Fan CFM',
    patterns: [/supply\s+fan\s+(?:total\s+)?cfm/i, /supply\s+fan\s+\d+\s+cfm/i],
    negativePatterns: [/set\s?point/i, /\(calculated\)/i, /\(vav\s+total\)/i],
    types: ['AI', 'AV'],
    cats: ['ahu'],
  },

  // GROUP 6 — Pressure (missing columns)

  // G2: Duct Static Pressure Setpoint
  // Taxonomy: "Supply Duct Static Set Point", "Supply Fan Duct Static Pressure Setpoint ANO".
  {
    col: 'ductStaticSetpoint',
    label: 'Duct Static Setpoint',
    patterns: [
      /supply\s+duct\s+static\s+set/i,
      /duct\s+static\s+set/i,
      /supply\s+fan\s+duct\s+static\s+pressure\s+setpoint/i,
      /air\s+source\s+static\s+set\s?point/i,
    ],
    types: ['SP', 'AV'],
    cats: ['ahu', 'rtu'],
  },

  // G3: Return/Exhaust Duct Static Pressure
  // Taxonomy: "Return Duct Static - Smoothed", "Exhaust Static Set Point", "Exhaust Static - Smoothed".
  {
    col: 'returnDuctStatic',
    label: 'Return/Exhaust Duct Static',
    patterns: [/return\s+duct\s+static/i, /exhaust\s+static(?!\s+set)/i, /exhaust\s+duct\s+static/i],
    negativePatterns: [/alarm|fault/i],
    types: ['AI'],
    cats: ['ahu'],
  },

  // GROUP 7 — Setpoints (AHU/Plant Level)

  // H7: SAT Cooling Reset Setpoint
  // Taxonomy: "Cooling Supply Air Set Point", "Active Supply Air Setpoint",
  // "Active Discharge Temp Setpoint" (from locked AMBIG-2 decision: Group 7.1).
  {
    col: 'satCoolSetpoint',
    label: 'SAT Cooling Setpoint',
    patterns: [/cooling\s+supply\s+air\s+set/i, /active\s+discharge\s+temp\s+set/i, /active\s+supply\s+air\s+set/i],
    negativePatterns: [/heating/i],
    types: ['SP', 'AV'],
    cats: ['ahu', 'rtu'],
  },

  // H8: SAT Heating Reset Setpoint
  // Taxonomy: "Heating Supply Air Set Point".
  {
    col: 'satHtgSetpoint',
    label: 'SAT Heating Setpoint',
    patterns: [/heating\s+supply\s+air\s+set/i],
    negativePatterns: [/cooling/i],
    types: ['SP', 'AV'],
    cats: ['ahu', 'rtu'],
  },

  // H11: Economizer Setpoint
  // Taxonomy: "Economizer Set Point", "Economizer Control Temp" (JOCO AHU1_extract trend file).
  {
    col: 'economizerSetpoint',
    label: 'Economizer Setpoint',
    patterns: [/economizer\s+set\s?point/i, /economizer\s+control\s+temp/i, /oa\s+enable\s+setpoint/i],
    types: ['SP', 'AV'],
    cats: ['ahu', 'rtu'],
  },

  // GROUP 8 — Valves & Dampers (AHU Level)

  // I6: Return Air Damper Position
  // Taxonomy: "Return Air Damper". negativePatterns: "set point" and "enable" excluded.
  {
    col: 'returnAirDamper',
    label: 'Return Air Damper',
    patterns: [/return\s+air\s+damper/i, /\bra\s+damper\b/i],
    negativePatterns: [/set\s?point|enable/i],
    types: ['AO', 'AI'],
    cats: ['ahu', 'rtu'],
  },

  // I7: Relief Damper Position
  // Taxonomy: "Relief Damper Feedback", "Relief Damper".
  {
    col: 'reliefDamper',
    label: 'Relief Damper',
    patterns: [/relief\s+damper/i, /bldg\s+relief\s+damper/i],
    negativePatterns: [/set\s?point|enable/i],
    types: ['AO', 'AI'],
    cats: ['ahu'],
  },

  // GROUP 9 — Fans & Pumps (missing columns)

  // J2: Return Fan VFD Speed
  // Taxonomy: "Return Fan VFD Speed", "Return Fan Drive Output Speed", "RF Speed".
  // M8: strengthened negativePatterns to block supply/exhaust/ct/boiler/alarm/fault;
  // added /rf speed/i and /return fan drive.*speed/i patterns per plan spec.
  {
    col: 'returnFanSpeed',
    label: 'Return Fan VFD Speed',
    patterns: [
      /return\s+fan\s+vfd\s+speed/i,
      /return\s+fan\s+drive\s+output\s+speed/i,
      /return\s+fan.*speed/i,
      /\brf\s+speed\b/i,
      /return\s+fan\s+drive.*speed/i,
    ],
    negativePatterns: [/\b(supply|exhaust|ct|boiler|alarm|fault)\b/i],
    types: ['AI', 'AO'],
    cats: ['ahu'],
  },

  // J3: Exhaust Fan VFD Speed
  // M8: new entry. Routes "Exhaust Fan Speed", "EF-N VFD Speed", "Relief Fan VFD Speed" here.
  // sfSpeedLive already guards against exhaust via its negativePatterns (M3).
  {
    col: 'exhaustFanSpeed',
    label: 'Exhaust Fan Speed',
    patterns: [/exhaust\s+fan.*speed/i, /ef.*vfd.*speed/i, /relief\s+fan\s+vfd\s+speed/i],
    negativePatterns: [/\b(supply|return|ct|boiler|alarm|fault)\b/i],
    types: ['AI', 'AO'],
    cats: ['ahu', 'ef'],
  },

  // J4: Supply Fan Status / Enable / Command
  // Taxonomy: "Supply Fan Status", "Supply Fan Enable", "Supply Fan Command",
  // "Fan Status" (short form on RTU/furnace). negativePatterns: speed and VFD signal excluded
  // (those go to sfSpeedLive); alarm/fault excluded.
  {
    col: 'supplyFanStatus',
    label: 'Supply Fan Status',
    patterns: [/supply\s+fan\s+status/i, /supply\s+fan\s+command/i, /supply\s+fan\s+enable/i, /\bfan\s+status\b/i],
    // M3: expanded negativePatterns. Exhaust/EF-N fans are not supply fans. Relief/return fans are
    // not supply fans. Smoke evac and destratification fans are life-safety/specialty. Latched failure
    // sentences (CT fault records) contain "Fan Status" parenthetically. RTU/Unit Disabled/Enabled
    // alarm sentences are diagnostic conditions, not live status readings.
    negativePatterns: [
      /alarm|fault|speed|vfd/i,
      /\b(exhaust|ef-?\d+|relief|return\s+fan|smoke|evac|destratif|latched|failure|disabled|enabled)\b/i,
      /RTU\s+(Disabled|Enabled)|Unit\s+(Disabled|Enabled)/i,
    ],
    types: ['BI', 'BO', 'BAI', 'BAO', 'BAV', 'BV'],
    cats: ['ahu', 'rtu', 'furnace', 'fcu'],
  },

  // J6: Supply Fan Amperage
  // Taxonomy: "Supply Fan Amperage", "Supply Fan VFD Amps".
  {
    col: 'supplyFanAmps',
    label: 'Supply Fan Amperage',
    patterns: [/supply\s+fan\s+amperage/i, /supply\s+fan.*amps/i, /supply\s+fan\s+vfd\s+amps/i],
    types: ['AI'],
    cats: ['ahu', 'rtu'],
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
      headerRow: headerRow, // M4: stored for pointsRaw capture
    };
  }

  // Enriched 45-column matrix (original format)
  var n = headerRow.length;
  var checkCount = 11;
  if (n >= 4 + 14) checkCount = 14;
  var pointStart = 4 + checkCount;
  // Build a reverse map: column index → EM_POINT_MAP col key, by matching header labels
  var liveColKeyByIdx = {};
  for (var pi = pointStart; pi < headerRow.length; pi++) {
    var hdr = (headerRow[pi] || '').trim().toLowerCase();
    for (var mi = 0; mi < EM_POINT_MAP.length; mi++) {
      var mapEntry = EM_POINT_MAP[mi];
      // Fix c0bf56e0: also check labelAliases so variants like 'Zone CO2 AV' map correctly.
      var labelMatch = mapEntry.label.toLowerCase() === hdr;
      if (!labelMatch && mapEntry.labelAliases) {
        for (var ai = 0; ai < mapEntry.labelAliases.length; ai++) {
          if (mapEntry.labelAliases[ai].toLowerCase() === hdr) {
            labelMatch = true;
            break;
          }
        }
      }
      if (labelMatch) {
        liveColKeyByIdx[pi] = mapEntry.col;
        break;
      }
    }
  }
  return {
    format: 'enriched',
    building: 0,
    location: 1,
    equipName: 2,
    equipType: 3,
    checkStart: 4,
    checkCount: checkCount,
    pointStart: pointStart,
    liveColKeyByIdx: liveColKeyByIdx,
    headerRow: headerRow, // M4: stored for pointsRaw capture
  };
}

// Parse a BACnet path from WebCTRL (e.g. "/Johnson County/Courthouse/Fire/...")
// Returns the building name.  Uses a CONSERVATIVE / WHITELIST approach to avoid
// mistakenly expanding department/area segments into the building name:
//
//   Default:  building = parts[1]  (correct for ALL standard JOCO paths)
//   Exception: extend to parts[1] + '/' + parts[2] ONLY when all three conditions hold:
//     1. parts[1] matches the known MedAct-station nesting pattern (/^medact\s*\d+/i)
//     2. parts[2] exists and is non-empty
//     3. parts[2] is NOT a floor/level segment (emIsFloorSegment returns false)
//   This yields "MedAct 51/SS Olathe" for nested MedAct campus paths while leaving
//   every other building — including "Jo Co Northeast Offices" — exactly as parts[1].
//
// Examples:
//   "/Johnson County/Courthouse/First Floor"                   → "Courthouse"
//   "/Johnson County/Jo Co Northeast Offices/Mental Health/…"  → "Jo Co Northeast Offices"
//   "/New Century Complex/MedAct 51/SS Olathe/Support Services"→ "MedAct 51/SS Olathe"
//   "/New Century Complex/MedAct 1131 Shawnee/First Floor/…"   → "MedAct 1131 Shawnee"
function emParseBACnetBuilding(pathStr) {
  if (!pathStr) return '';
  var parts = pathStr.replace(/^\//, '').split('/');
  if (parts.length < 2) return (parts[0] || '').trim();
  var p1 = (parts[1] || '').trim();
  if (!p1) return '';
  // MedAct-station nesting: extend to two segments only for the known pattern.
  var p2 = parts.length > 2 ? (parts[2] || '').trim() : '';
  if (/^medact\s*\d+/i.test(p1) && p2 && !emIsFloorSegment(p2)) {
    return p1 + '/' + p2;
  }
  return p1;
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
    /^(smoke|environmental|exhaust|weather|fire|generator|elevator|irrigation|outside air|outiside air)/i.test(
      firstPart,
    );
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

  if (/\bvfd\s+integration\b/i.test(raw)) return 'other';

  // ── A. Strip leading manufacturer names ──
  var mfgPattern =
    /^(?:trane|carrier|lennox|york|daikin|mcquay|rheem|ruud|heil|bard|aaon|mammoth|reznor|modine|lochinvar|honeywell|johnson controls|siemens|schneider|alc|automated logic)\s+/i;
  var stripped = raw.replace(mfgPattern, '');

  var key = stripped.toLowerCase();

  // ── B. Exact lookup ──
  if (key in EM_EQUIP_TYPES) return EM_EQUIP_TYPES[key];

  // ── C. Substring scan of EM_EQUIP_TYPES keys ──
  // Skip patterns of 2 chars or fewer — word-boundary regex handles them safely below
  // and short keys false-match inside longer words (e.g. 'ct' inside 'MedAct', 'uh' inside 'touch').
  for (var pattern in EM_EQUIP_TYPES) {
    if (pattern.length <= 2) continue;
    if (key.indexOf(pattern) !== -1) return EM_EQUIP_TYPES[pattern];
  }

  // ── D. Regex fallbacks (expanded) ──
  // Widen air-handling match to catch "Air Handing Unit" typo (missing 'l')
  if (/\bahu\b|air.?hand/i.test(key)) return 'ahu';
  if (/\brtu\b/i.test(key)) return 'ahu';
  if (/\bmau\b/i.test(key)) return 'ahu';
  // M3: DOAS is its own type (dedicated energy recovery ventilation unit)
  if (/\bdoas\b/i.test(key)) return 'doas';
  if (/\berv\b/i.test(key)) return 'ahu';
  if (/\bhrv\b/i.test(key)) return 'ahu';
  // M3: FCU/CRAC/CRAH are their own fcu type
  if (/\bfcu\b/i.test(key)) return 'fcu';
  if (/\bcrac\b/i.test(key)) return 'fcu';
  if (/\bcrah\b/i.test(key)) return 'fcu';
  if (/roof.?top/i.test(key)) return 'ahu';
  if (/make.?up.?air/i.test(key)) return 'ahu';
  if (/heat.?pump/i.test(key)) return 'ahu';
  if (/\bwshp\b/i.test(key)) return 'ahu';
  if (/\bgshp\b/i.test(key)) return 'ahu';
  if (/split.?system/i.test(key)) return 'ahu';
  // PTAC / packaged terminal units — fcu bucket (zone-level, no central air logic)
  if (/\bptac\b/i.test(key)) return 'fcu';
  if (/\bpth\b/i.test(key)) return 'fcu';
  if (/packaged.?terminal/i.test(key)) return 'fcu';
  // Unit ventilators (UV-1, UV-12, "unit ventilator", "unit vent")
  if (/unit.?ventilator|unit.?vent\b/i.test(key)) return 'fcu';
  if (/\buv[-\s]?\d/i.test(key)) return 'fcu'; // UV-1, UV-12, UV 3 — digit suffix required (avoids matching UV-C/UVGI)
  // VAV check must come before short-code patterns (EF/DD) to avoid
  // misclassifying combo names like "VAV-11/EF-3" as ahu/ddvav.
  if (/vav|variable.?air.?vol/i.test(key)) return 'vav';
  if (/\bvas[\s\-]?\d/i.test(key)) return 'vav';
  // Exhaust fans: EF-N / EF-KT04 / Ventilation-EF-XX style — M3: dedicated 'ef' type
  if (/\bef[-\s]?[\da-z]/i.test(key)) return 'ef'; // EF-1, EF-KT04, EF-OR02
  if (/exhaust.?fan/i.test(key)) return 'ef';
  // Make-up air units with suffix (MUA-KT01, MUA-1, etc.)
  if (/\bmua[-\s]?(?:\d|[a-z])/i.test(key)) return 'ahu';
  // Energy recovery units (ERU-1 format)
  if (/\beru[-\s]?\d/i.test(key)) return 'ahu';
  // Blower coil units (BCU-1A format) — M3: fcu type
  if (/\bbcu[-\s]?\d/i.test(key)) return 'fcu';
  // Stairwell pressurization fans (SPF-1)
  if (/\bspf[-\s]?\d/i.test(key)) return 'ahu';
  // VRF outdoor condensing units
  if (/\bvrf\b/i.test(key)) return 'ahu';
  if (/\bfpb\b/i.test(key)) return 'fpb';
  if (/fan.?pow|parallel.?fan|\bfpt\b/i.test(key)) return 'fpb';
  if (/fan.?power/i.test(key)) return 'fpb';
  if (/\bftu\b/i.test(key)) return 'fpb';
  // "Fan Terminal Unit" full name (a6bd97ef) — with or without room/number suffix
  if (/fan\s+terminal\s+unit/i.test(key)) return 'fpb';
  // Fan terminal coils (FTC-1.01) — fpb bucket
  if (/\bftc[-\s.]?\d/i.test(key)) return 'fpb';
  // Dual-duct abbreviation DD-N — must come BEFORE the broader dual.?duct line
  if (/\bdd[-\s]?\d/i.test(key)) return 'ddvav';
  if (/dual.?duct|ddvav/i.test(key)) return 'ddvav';
  if (/\bboiler\b/i.test(key)) return 'hwp';
  if (/\bhwp\b/i.test(key)) return 'hwp';
  if (/\bblr\b/i.test(key)) return 'hwp';
  // M3: Furnace is its own type
  if (/\bfurnace\b/i.test(key)) return 'furnace';
  // M3: Unit/tube/infrared heaters — heater type
  if (/unit.?heater|tube.?heater|infrared.?heater|radiant.?heater/i.test(key)) return 'heater';
  if (/\buh[-\s]?[\da-z]/i.test(key)) return 'heater'; // UH-1, UH-5A
  if (/\bcuh[-\s]?[\da-z]/i.test(key)) return 'heater'; // CUH-1, CUH-2 (cabinet unit heater)
  if (/\bguh[-\s]?[\da-z]/i.test(key)) return 'heater'; // GUH-East (gas unit heater)
  if (/\btuh[-\s]?\d/i.test(key)) return 'heater'; // tube unit heater variant
  if (/\bigh[-\s]?\d/i.test(key)) return 'heater'; // infrared gas heater
  if (/\btth[-\s]?\d/i.test(key)) return 'heater'; // tube type heater
  if (/hot.?water.*boil/i.test(key)) return 'hwp';
  if (/heating.?water/i.test(key)) return 'hwp';
  // Radiant heating ceiling panels (RHC-0101 format) — M3: map to vav (terminal)
  if (/\brhc[-\s]?\d/i.test(key)) return 'vav';
  if (/\bchiller\b/i.test(key)) return 'chwp';
  if (/\bchwp\b/i.test(key)) return 'chwp';
  if (/chilled.?water/i.test(key)) return 'chwp';
  if (/chill|chw.*plant/i.test(key)) return 'chwp';
  if (/cool.*tower/i.test(key)) return 'ct';
  // Word-boundary CT guard — prevents 'ct' inside 'MedAct' from matching
  if (/\bct\b/i.test(key)) return 'ct';
  // M3: Non-HVAC specific categories
  if (/outside.?air.?condition/i.test(key)) return 'sensor';
  if (/outiside.?air.?condition/i.test(key)) return 'sensor'; // common typo in JOCO data
  if (/environmental.?index/i.test(key)) return 'sensor';
  if (/weather.?station/i.test(key)) return 'sensor';
  if (/smoke.?damper/i.test(key)) return 'fire';
  if (/fire.?alarm|fire.?panel/i.test(key)) return 'fire';
  if (/\bgenerator\b/i.test(key)) return 'power';
  if (/electric.?meter|power.?meter|energy.?meter/i.test(key)) return 'power';
  if (/\bups\b|\bats\b/i.test(key)) return 'power';
  if (/domestic.?water|domestic.?flow/i.test(key)) return 'plumbing';
  if (/vfd.?integration|vfd.?monitor/i.test(key)) return 'controls';
  // Lighting — general keyword
  if (/\blighting\b/i.test(key)) return 'lighting';
  // Lighting / shade programs by naming convention (JOCO Courthouse)
  // GLPP-NN-* (glass panel lighting programs) — numeric panel ID prefix
  if (/^\d{4}\s+-\s+glpp-/i.test(key)) return 'lighting'; // e.g. "2800 - GLPP-46-2A"
  if (/^glpp-\d/i.test(key)) return 'lighting'; // e.g. "GLPP-21-1A"
  // LZ-NN-* (lighting zones) — starts with LZ- followed by digits
  if (/^\[?lz[-.]?\d/i.test(key)) return 'lighting'; // "LZ-01-0", "[LZ.51][EXT-1]..."
  // Zone naming — M3 FIX: replace old overly-broad rules with specific ones
  // Zone-F3-7 style (letter+digit+hyphen+digit = VVT zone-damper terminal)
  if (/^zone-[a-f]\d+[-\s]\d+/i.test(key)) return 'zone'; // "Zone-F3-7", "Zone-F1-1"
  // Zone-F3 style (letter+digit only, no second segment = furnace/air source unit)
  if (/^zone-[a-f]\d+$/i.test(key)) return 'furnace'; // "Zone-F3"
  // "Zone N Color" style (smoke zone indicator programs)
  if (/^zone\s+\d+[a-z]?\s+color$/i.test(key)) return 'fire'; // "Zone 9 Color"
  // "Zone N-M" style (VVT zone terminal, e.g. "Zone 3-5")
  if (/^zone\s+\d+-\d+$/i.test(key)) return 'ddvav'; // "Zone 3-5"
  // Zone-N / Zone N (generic lighting zone — only plain numeric suffix, no letter-floor)
  if (/^zone[-\s]\d+[a-z]?(?:\s+|$)/i.test(key) && !/^zone-[a-f]\d/i.test(key)) return 'lighting'; // "Zone-1", "Zone 9D Color"
  // S-NN-* (shade zone programs) — two-digit shade code
  if (/^s-\d{2}[-\s]/i.test(key)) return 'lighting'; // "S-01-0", "S-09-4B"
  // Shades-* and Shades_* (alternate shade format)
  if (/^(?:\w+\s+)?shades[-_]/i.test(key)) return 'lighting'; // "Shades-00-2A", "West Shades_03-1B"
  // EXT-* (exterior lighting zones) — letter code format
  if (/^ext-[a-z]-/i.test(key)) return 'lighting'; // "EXT-A-0", "EXT-B-4B"

  // ── E. Fuzzy keyword scan (last resort) ──
  var fuzzyMap = [
    ['ahu', 'ahu'],
    ['rtu', 'ahu'],
    ['vav', 'vav'],
    ['chiller', 'chwp'],
    ['boiler', 'hwp'],
    ['cooling tower', 'ct'],
    ['pump', 'hwp'],
    ['fan coil', 'fcu'],
    ['rooftop', 'ahu'],
    ['air handler', 'ahu'],
    ['exhaust fan', 'ef'],
    ['destratification', 'ahu'],
    ['blower coil', 'fcu'],
    ['radiant heat', 'hwp'],
    ['vrf', 'ahu'],
    ['lighting', 'lighting'],
    ['unit heater', 'heater'],
    ['tube heater', 'heater'],
    ['infrared', 'heater'],
    ['furnace', 'furnace'],
    ['doas', 'doas'],
    ['smoke', 'fire'],
    ['generator', 'power'],
    ['domestic', 'plumbing'],
    ['outside air conditions', 'sensor'],
    ['environmental index', 'sensor'],
    ['weather station', 'sensor'],
  ];
  for (var fi = 0; fi < fuzzyMap.length; fi++) {
    if (key.indexOf(fuzzyMap[fi][0]) !== -1) return fuzzyMap[fi][1];
  }

  // ── M4: Non-HVAC specific categories — eliminate generic 'other' ──
  // Elevator systems (elevator equipment, pressurization fans, water-detection near elevators)
  if (/\belevator\b/i.test(key)) return 'elevator';
  if (/elevator\s+(pressurization|equip|lobby|room|water)/i.test(key)) return 'elevator';
  // Radiant tube heaters (RTH-1, RTH-4 — not caught by earlier patterns)
  if (/\brth[-\s]?\d/i.test(key)) return 'heater';
  // VAS (Volume Air Source — shop-level VAV air sources in JOCO Fire Stations)
  if (/\bvas[-\s]?\d/i.test(key)) return 'vav';
  // Fan unit programs (FU-1, FU-2, etc. — ceiling fan / unit ventilator style)
  if (/\bfu[-\s]?\d/i.test(key)) return 'fcu';
  // Energy recovery units (standalone programs, not just ERU-N device names)
  if (/energy recovery unit/i.test(key)) return 'ahu';
  if (/energy recovery water system/i.test(key)) return 'plumbing';
  // Kitchen hood / exhaust systems
  if (/kitchen.?hood/i.test(key)) return 'fire';
  if (/\bfume.?hood\b/i.test(key)) return 'fire';
  // Building relief dampers (GV-N style — smoke/relief, not HVAC supply)
  if (/building relief damper/i.test(key)) return 'fire';
  if (/relief damper/i.test(key)) return 'fire';
  // Fuel system integration
  if (/fuel system/i.test(key)) return 'power';
  if (/transfer switch/i.test(key)) return 'power';
  if (/surge suppress/i.test(key)) return 'power';
  if (/power loss/i.test(key)) return 'power';
  // Irrigation and water systems
  if (/irrigation/i.test(key)) return 'plumbing';
  if (/water softener/i.test(key)) return 'plumbing';
  if (/reverse osmosis/i.test(key)) return 'plumbing';
  if (/snow melt/i.test(key)) return 'plumbing';
  if (/heat trace/i.test(key)) return 'plumbing';
  if (/btu meter/i.test(key)) return 'plumbing';
  if (/hot water system/i.test(key)) return 'plumbing';
  if (/building hot water/i.test(key)) return 'plumbing';
  if (/building cold water/i.test(key)) return 'plumbing';
  if (/apparatus bay hot water/i.test(key)) return 'plumbing';
  if (/apparatus bay cold water/i.test(key)) return 'plumbing';
  if (/differential pressure hot water/i.test(key)) return 'plumbing';
  if (/hot water loop bypass/i.test(key)) return 'plumbing';
  // Temperature / humidity / pressure monitors (non-HVAC spaces)
  if (/temp(erature)?.?humidity monitor/i.test(key)) return 'monitoring';
  if (/temp(erature)? monitor/i.test(key)) return 'monitoring';
  if (/humidity control/i.test(key)) return 'monitoring';
  if (/^room temp(erature)?$/i.test(key)) return 'monitoring';
  if (/temperature monitoring/i.test(key)) return 'monitoring';
  if (/\btemperature\s+(monitor|sensor)\b/i.test(key)) return 'monitoring';
  // Leak / water detection programs
  if (/leak detect/i.test(key)) return 'monitoring';
  if (/water detect/i.test(key)) return 'monitoring';
  if (/sump monitor/i.test(key)) return 'monitoring';
  // Building / room pressure monitors (non-HVAC control — pure monitoring)
  if (/pressure monitor/i.test(key)) return 'monitoring';
  if (/\bbuilding pressure\b/i.test(key)) return 'monitoring';
  if (/building air pressure/i.test(key)) return 'monitoring';
  if (/kitchen pressure/i.test(key)) return 'monitoring';
  if (/medical room pressure/i.test(key)) return 'monitoring';
  // Gas / air-quality monitors
  if (/no\/co monitor/i.test(key)) return 'monitoring';
  if (/\bco monitor\b/i.test(key)) return 'monitoring';
  if (/gas monitor/i.test(key)) return 'monitoring';
  if (/outside air carbon dioxide/i.test(key)) return 'monitoring';
  if (/refrigerant monitor/i.test(key)) return 'monitoring';
  // Freezer / cooler / food-service monitoring
  if (/freezer monitor/i.test(key)) return 'monitoring';
  if (/cooler monitor/i.test(key)) return 'monitoring';
  if (/freezer temperature/i.test(key)) return 'monitoring';
  if (/cooler temperature/i.test(key)) return 'monitoring';
  if (/refrigerator.*freezer/i.test(key)) return 'monitoring';
  // Air compressor / air purification monitors
  if (/air compressor/i.test(key)) return 'monitoring';
  if (/air purif/i.test(key)) return 'monitoring';
  if (/hepa filter/i.test(key)) return 'monitoring';
  // IT / data room monitors
  if (/\bdata.?center\b.*monitor|data.?closet.*monitor|data.?room.*monitor/i.test(key)) return 'monitoring';
  if (/it.*(monitor|temp|closet|room)/i.test(key)) return 'monitoring';
  // Medical / lab monitors
  if (/medical system monitor|medical room/i.test(key)) return 'monitoring';
  if (/lab control|lab \d+ monitor/i.test(key)) return 'monitoring';
  if (/phoenix lab/i.test(key)) return 'monitoring';
  // Security / access control
  if (/\baccess.?control\b/i.test(key)) return 'security';
  if (/\bcard.?reader\b/i.test(key)) return 'security';
  if (/perimeter.*(lc-\d|zone)/i.test(key)) return 'security';
  if (/^lc-\d/i.test(key)) return 'security'; // LC-1 through LC-6 = perimeter security zones
  // Fire-related monitors not yet caught
  if (/fire riser/i.test(key)) return 'fire';
  if (/fire system/i.test(key)) return 'fire';
  if (/fireman.?control/i.test(key)) return 'fire';
  if (/data center fire/i.test(key)) return 'fire';
  // Garage / bay temperature monitoring (fire stations, shops)
  if (/garage bay temp/i.test(key)) return 'monitoring';
  if (/bay temp/i.test(key)) return 'monitoring';
  if (/riser room temp/i.test(key)) return 'monitoring';
  // Room-level temperature/humidity monitoring (format: "Room Description | Temp Monitor")
  if (/\|\s*temp monitor/i.test(key)) return 'monitoring';
  // Corridor / permanent exhibit / collection zone averages (non-HVAC control programs)
  if (/\|\s*zone average/i.test(key)) return 'monitoring';
  // Fan coil units identified by room label + pipe char (format: "Room Name | FC-N")
  if (/\|\s*fc-?\d/i.test(key)) return 'fcu';
  if (/\|\s*msfc-?\d/i.test(key)) return 'fcu'; // mini split fan coil
  if (/\|\s*ac-?\d/i.test(key)) return 'fcu'; // precision AC units (AC-1, AC-2A, etc.)
  // Fan units identified by room label + pipe char (format: "Room Name | FU-N")
  if (/\|\s*fu-?\d/i.test(key)) return 'fcu';
  // Variable diffuser units (VD-N) — fan-terminal style
  if (/\|\s*vd-?\d/i.test(key)) return 'fcu';
  // Chilled ceiling / chilled beam units (CC-NNN)
  if (/\|\s*cc-\d{3}/i.test(key)) return 'fcu';
  // Data server/server room fan coil precision cooling (DSS-NNN)
  if (/\|\s*dss-\d{3}/i.test(key)) return 'fcu';
  // Liebert precision cooling units
  if (/\bliebert\b/i.test(key)) return 'fcu';
  // IHR (Infrared Heater) with suffix — not caught by earlier /\bigh/ pattern
  if (/\bihr[-\s]?\d/i.test(key)) return 'heater';
  // ASU (Air Supply Unit) — context from JOCO is hot water differential pressure monitors
  if (/^asu[-\s]?\d/i.test(key)) return 'monitoring'; // ASU-1, ASU-2, ASU-3 (standalone = monitors)
  if (/asu\s+\d+\s+hot water/i.test(key)) return 'plumbing'; // "ASU 12 Hot Water Differential Pressure"
  // HRU (Heat Recovery Unit) — energy recovery type
  if (/\bhru[-\s]?\d/i.test(key)) return 'ahu';
  // EXU (Exhaust Unit) — exhaust fan type
  if (/\bexu[-\s]?\d/i.test(key)) return 'ef';
  // TH (tube heater) variants not caught earlier
  if (/^th[-\s]?\d/i.test(key)) return 'heater';
  // SS-N (stairwell smoke sensor / pressurization?)
  // From JOCO context these appear near elevator/mechanical programs — monitor bucket
  if (/^ss-\d/i.test(key)) return 'monitoring';
  // SP-N (stairwell pressurization fans)
  if (/^sp[-\s]?\d/i.test(key)) return 'ef'; // pressurization = exhaust fan type
  if (/^sp-\d{1,2},/i.test(key)) return 'ef'; // "SP-1,2,3,4" combined entry
  // Stairwell pressurization fans (combined label)
  if (/stairwell pressurization/i.test(key)) return 'ef';
  // F-N (fan, filter, or fixture abbreviations in fire station context)
  if (/^f-\d+$/i.test(key)) return 'ef'; // F-2, F-4 — likely exhaust fans
  // CU-N (condensing unit)
  if (/^cu-\d/i.test(key)) return 'ahu';
  // DX (direct expansion unit)
  if (/^dx$/i.test(key)) return 'ahu';
  // Alarm horn / panel — fire/security ancillary, route to fire
  if (/alarm horn/i.test(key)) return 'fire';
  // Garage / bay ventilation programs (Apparatus Bay 101 Ventilation)
  if (/bay.*ventilation|ventilation.*bay/i.test(key)) return 'ef';
  // Elev equipment room / elevator lobby monitors
  if (/elev.*equipment room/i.test(key) || /elevator.*room/i.test(key)) return 'elevator';
  if (/elevator.*lobby/i.test(key)) return 'elevator';
  if (/elevator.*sump/i.test(key)) return 'elevator';
  // Mechanical room / electrical room monitors (water detection, sump)
  if (/mechanical room.*water|mechanical room.*sump/i.test(key)) return 'monitoring';
  if (/electrical room.*water/i.test(key)) return 'monitoring';
  // Collections / exhibit environment monitoring
  if (/collections.*water|evidence room/i.test(key)) return 'monitoring';
  // Building-floor labels like "1A", "2B1", "3A" — lighting zone context
  if (/^\d+[ab]\d*$/i.test(key)) return 'lighting';
  // Fireman's Control Panel — apostrophe breaks /fireman.?control/, needs wider wildcard
  if (/fireman.*control/i.test(key)) return 'fire';
  // Surge Suppression (typo variant "Supression" — single 'p')
  if (/surge supres/i.test(key)) return 'power';
  // Standalone precision AC units not preceded by a room label (VN-AC-N, AC-N patterns)
  if (/^v\w+\s*-\s*ac-\d/i.test(key)) return 'fcu'; // "V7Q50 - AC-1" style
  if (/^ac-\d/i.test(key)) return 'fcu'; // "AC-6" standalone
  // EXT-I- exterior lighting zone variant (EXT-[letter]-[number] with uppercase)
  if (/^ext-[a-z]-/i.test(key)) return 'lighting'; // already covered above — no-op
  // Electric room temperature monitor
  if (/electric.*rm.*temp|electric.*room.*temp/i.test(key)) return 'monitoring';
  // Gymnasium / commons / kitchen spaces — these are room-level programs with no BAS
  // equipment directly; treat as monitoring (zone average or misc room program)
  if (/^gymnasium$/i.test(key)) return 'monitoring';
  if (/^commons\s|^commons\/|^kitchen\s/i.test(key)) return 'monitoring';

  // All unrecognized types (including weather stations, etc.) are kept as 'other'
  return 'other';
}

/* ── emVerifyTypeByPoints ────────────────────────────────────────────────────
   M3: Point-signature verification pass. Called after grouping is complete,
   when the full point set for an equipment group is known. Inspects the
   lowercased point names stored in group.pointValues and returns a refined
   type string, or the group's existing category if no signature matches.

   Rules are evaluated in priority order — first match wins.               */
function emVerifyTypeByPoints(group) {
  var provisional = group.category || 'other';
  var ptKeys = Object.keys(group.pointValues || {});
  if (ptKeys.length === 0) return provisional;

  // Build a single lowercased space-joined string for quick regex scanning
  var pts = ptKeys.map(function (k) {
    return k.toLowerCase();
  });
  var ptStr = pts.join('\n'); // newline-separated so anchors don't bleed across names

  function hasPoint(re) {
    for (var i = 0; i < pts.length; i++) {
      if (re.test(pts[i])) return true;
    }
    return false;
  }

  var hasZoneTemp = hasPoint(/zone.?temp|room.?temp|space.?temp/);
  var hasSupplyFan = hasPoint(/supply fan/);
  var hasAirFlow = hasPoint(/air.?flow|flow control|flow input|\bcfm\b/);
  var hasTermFan = hasPoint(/\bfan\b/) && !hasPoint(/supply fan|exhaust fan|return fan/);

  // 1. Fire/smoke: tiny point set with smoke zone BNI (not an HVAC unit)
  if (ptKeys.length <= 2 && hasPoint(/smoke zone.*bni/)) return 'fire';

  // 2. VFD integration wrapper: drive telemetry but no zone temp or supply fan
  if (
    hasPoint(/output frequency|drive temperature|motor current|motor torque|motor kw/) &&
    !hasZoneTemp &&
    !hasSupplyFan
  )
    return 'controls';

  // 3. VVT zone-damper terminal: Air Source VVT + Zone Damper + zone temp, NO airflow
  if (hasPoint(/air source vvt/) && hasPoint(/zone damper/) && hasZoneTemp && !hasAirFlow) return 'zone';

  // 4. VVT furnace/air source: VVT Mode + Zone Communications Failure + supply fan + DX cooling
  if (hasPoint(/vvt mode/) && hasPoint(/zone communications failure/) && hasSupplyFan && hasPoint(/cooling stage 1/))
    return 'furnace';

  // 5. DOAS/ERV: energy recovery wheel + supply fan + building pressure
  if (hasPoint(/energy recovery wheel|energy wheel/) && hasSupplyFan && hasPoint(/building pressure/)) return 'doas';

  // 6. Dual-deck VAV: cold deck supply or air source cold deck + hot deck + zone damper, no airflow sensor
  if (
    (hasPoint(/cold deck supply|air source cold deck/) || hasPoint(/hot deck/)) &&
    hasPoint(/zone damper/) &&
    !hasAirFlow
  )
    return 'ddvav';

  // 7. Fan-powered box (FPB): airflow + terminal fan + heating valve + air source mode
  if (hasAirFlow && hasTermFan && hasPoint(/heating valve|hw valve|reheat valve/) && hasPoint(/air source mode/))
    return 'fpb';

  // 8. VAV: airflow + damper position + air source mode, no terminal fan
  if (hasAirFlow && hasPoint(/damper position|zone damper/) && hasPoint(/air source mode/) && !hasTermFan) return 'vav';

  // 9. FCU (Daikin VRF): gas pipe temperature + (fan speed or daikin alarm)
  if (hasPoint(/gas pipe temperature/) && (hasPoint(/fan speed/) || hasPoint(/daikin.*alarm/))) return 'fcu';

  // 10. FCU (generic hydronic fan coil): zone temp + cooling/heating valve, no airflow, no supply fan
  if (
    hasZoneTemp &&
    (hasPoint(/cooling valve|chw valve|chilled water valve/) || hasPoint(/heating valve/)) &&
    !hasAirFlow &&
    !hasSupplyFan
  )
    return 'fcu';

  // 11. Tube/radiant heater: tube heater or unit heater points
  if (hasPoint(/tube heater (enable|status|amperage)/)) return 'heater';
  if (hasPoint(/unit heater (enable|status)/) && !hasTermFan) return 'heater';

  // 12. RTU (name-only AHU with DX cooling): supply fan + DX staging + zone temp, no VVT
  if (hasSupplyFan && hasPoint(/cooling stage 1/) && hasZoneTemp && !hasPoint(/vvt mode/)) return 'ahu';

  // No signature match — keep provisional name-pass classification
  return provisional;
}

function emMapPointToColumn(pointName, pointType, equipCategory) {
  if (!pointName) return null;
  // FIX 4c: Normalize whitespace before pattern matching so 'Mixed  Air Temperature' (double-space)
  // and similar CSV artifacts match the same patterns as single-spaced names.
  pointName = pointName.replace(/\s+/g, ' ').trim();
  // Milestone 1: page-lifetime name cache (category-less lookups only — import path passes category)
  if (!equipCategory) {
    if (_emPointNameCache.has(pointName)) return _emPointNameCache.get(pointName);
  }
  // Phase 2B: strip leading "Virtual" qualifier before matching so "Virtual Zone Temperature"
  // maps to the same column as "Zone Temperature". The original pointName is preserved by the
  // caller — the collision resolution block uses it to detect virtual vs. real points.
  var matchName = pointName.replace(/^\s*virtual\s+/i, '');
  // M1B: Pre-filter for BACnet control-object types. BPID/BMSV/BALM/BMBI are categorically
  // never live sensor readings. If the caller supplies a pointType in this set, skip ALL
  // EM_POINT_MAP entries entirely — the name-pattern layer (negativePatterns) is defense-in-depth.
  var CONTROL_OBJ_TYPES = ['BPID', 'BMSV', 'BALM', 'BMBI'];
  if (pointType && CONTROL_OBJ_TYPES.indexOf(pointType) !== -1) {
    return null;
  }
  var _mapResult = null;
  for (var i = 0; i < EM_POINT_MAP.length; i++) {
    var mapping = EM_POINT_MAP[i];
    if (equipCategory && mapping.cats && !mapping.global && mapping.cats.indexOf(equipCategory) === -1) continue;
    for (var p = 0; p < mapping.patterns.length; p++) {
      if (mapping.patterns[p].test(matchName)) {
        // If this column has negative guards, reject names that match any of them.
        // Prevents alarm/status point names from mapping to live-reading columns
        // (e.g. "High Zone Temperature" must not map to zoneAirTemp).
        // Guards are tested against matchName (post-virtual-strip) so "Virtual Zone Temperature"
        // is not blocked by the former "virtual" guard that was in zoneAirTemp.
        if (mapping.negativePatterns) {
          var blocked = false;
          for (var n = 0; n < mapping.negativePatterns.length; n++) {
            if (mapping.negativePatterns[n].test(matchName)) {
              blocked = true;
              break;
            }
          }
          if (blocked) break; // break inner loop — skip this mapping entry entirely
        }
        _mapResult = mapping.col;
        break;
      }
    }
    if (_mapResult !== null) break;
  }
  // Milestone 1: write result to name cache for category-less lookups
  if (!equipCategory) {
    _emPointNameCache.set(pointName, _mapResult);
  }
  return _mapResult;
}

function emExtractEquipmentGroups(rows, colMap) {
  var groups = new Map();

  // ── WebCTRL 14-column point-list format ──
  // Each row is a single BACnet point. Multiple rows share the same Control Program (col 1).
  // Milestone 2: equipName = the FULL Control Program string (no longer split into
  // location + equipment tokens). Each control program is one equipment row.
  // Classification still uses the full CP string — emClassifyEquipType handles both
  // standard ("Supply Duct - Air Handling Unit B1") and JOCO-style ("Cooling Towers - ADC").
  if (colMap.format === 'webctrl') {
    for (var wi = 0; wi < rows.length; wi++) {
      var wrow = rows[wi];
      if (!wrow || wrow.length < 4) continue;
      var bacnetPath = (wrow[0] || '').trim();
      var controlProgram = (wrow[1] || '').trim();
      var pointName = (wrow[2] || '').trim();
      var pointVal = wrow[3] != null ? String(wrow[3]).trim() : '';
      if (!controlProgram) continue;

      var building = emParseBACnetBuilding(bacnetPath);
      // Extract floor from BACnet path — use the segment after the building portion.
      // Derive segment count from emParseBACnetBuilding's result: if the building name
      // contains '/' it consumed 2 path segments (MedAct nested), otherwise 1.
      // This keeps floor-search aligned with the conservative building parser above.
      var bacnetParts = bacnetPath.replace(/^\//, '').split('/');
      var wBldgSegCount = building.indexOf('/') !== -1 ? 2 : 1;
      // Floor search begins at the segment immediately after the building portion
      var wfloor = '';
      for (var si = 1 + wBldgSegCount; si < bacnetParts.length; si++) {
        if (bacnetParts[si] && emIsFloorSegment(bacnetParts[si].trim())) {
          wfloor = bacnetParts[si].trim();
          break;
        }
      }

      // Milestone 2: equipName = full Control Program string (no split)
      var equipName = controlProgram;
      // location is no longer split from equipName; retain empty string for compatibility
      var location = '';

      // Classify using the parsed token from emParseControlProgram rather than the full
      // CP string. The existing emClassifyEquipType was designed for single-token names
      // and produces false positives on full CP strings via its substring scan
      // (e.g. "services" contains "erv"→ahu, "MedAct" contains "ct"→ct).
      // Passing the parsed equipName token avoids these collisions.
      // M3 will replace this with a point-signature classifier anyway.
      var _cpParsed = emParseControlProgram(controlProgram);
      var category = emClassifyEquipType(_cpParsed.equipName || controlProgram);

      // Group key: building + full control program. Location is no longer part of key.
      // In JOCO WebCTRL each control program string is unique per building (it encodes
      // both equipment type and building abbreviation), so collisions are not expected in
      // normal data.  The guard below detects the rare case where the same key would be
      // produced for a LOGICALLY DIFFERENT equipment (i.e. the stored group has a different
      // bacnetPath root) and appends a numeric disambiguator to prevent silent point loss.
      var groupKey = building + '||' + equipName;
      if (groups.has(groupKey)) {
        // Key already exists — check if it's from the same bacnetPath root (safe merge) or
        // a distinct logical equipment (collision that would lose points).
        var _existingGroup = groups.get(groupKey);
        var _existingPathRoot = _existingGroup.bacnetPathRoot || '';
        var _thisPathRoot = bacnetPath.split('/').slice(0, 3).join('/');
        if (_existingPathRoot && _existingPathRoot !== _thisPathRoot) {
          // Genuine collision from a different path: append disambiguator
          var _disambig = 2;
          while (groups.has(groupKey + '||#' + _disambig)) {
            _disambig++;
          }
          groupKey = groupKey + '||#' + _disambig;
          // Fall through to create a new group below
          groups.set(groupKey, {
            building: building,
            floor: wfloor,
            location: location,
            equipName: equipName,
            equipTypeStr: equipName,
            category: category,
            bacnetPathRoot: _thisPathRoot,
            bacnetLocation: bacnetPath, // 2224d15d: full BACnet path for integration-stub detection at audit time
            checkValues: {},
            pointValues: {},
            rawPointMap: {}, // M4: all raw BAS point names captured at import
            colMap: colMap,
          });
        }
        // else: same path root — normal multi-point accumulation, use existing group
      } else {
        var _thisPathRoot2 = bacnetPath.split('/').slice(0, 3).join('/');
        groups.set(groupKey, {
          building: building,
          floor: wfloor,
          location: location,
          equipName: equipName,
          equipTypeStr: equipName,
          category: category,
          bacnetPathRoot: _thisPathRoot2,
          bacnetLocation: bacnetPath, // 2224d15d: full BACnet path for integration-stub detection at audit time
          checkValues: {},
          pointValues: {},
          rawPointMap: {}, // M4: all raw BAS point names captured at import
          colMap: colMap,
        });
      }
      var wgroup = groups.get(groupKey);

      // M4: Capture EVERY raw point name→value in rawPointMap (0-safe: skip only null/undefined).
      // pointVal from CSV trim() is always a string, never null/undefined, so store unconditionally
      // as long as the point name is non-empty.
      if (pointName !== '') {
        wgroup.rawPointMap[pointName] = pointVal;
      }
      // Map point name + value to a live data column if we recognise it.
      // Also store every point directly under its raw name for dynamic column display.
      if (pointName !== '' && pointVal !== '') {
        wgroup.pointValues[pointName] = pointVal;
      }
      var pointCol = emMapPointToColumn(pointName, null, category);
      if (pointCol && pointVal !== '') {
        // ── Collision resolution ──────────────────────────────────────────
        // Phase 2B: detect whether the incoming point is a "Virtual" qualifier point.
        // "Virtual Zone Temperature" is a software-computed aggregate; the physical sensor
        // ("Zone Temperature") is preferred when both map to the same column.
        var isVirtual = /^\s*virtual\s+/i.test(pointName);

        // Track which point name won each column slot so we can warn on genuine collisions.
        if (!wgroup._pointColWinner) wgroup._pointColWinner = {};

        var existing = wgroup.pointValues[pointCol];
        var existingWinner = wgroup._pointColWinner[pointCol];

        if (existing === undefined) {
          // Slot is empty — write unconditionally.
          wgroup.pointValues[pointCol] = pointVal;
          wgroup._pointColWinner[pointCol] = pointName;
        } else if (isVirtual) {
          // Phase 2B: virtual point — only write if slot is still empty (already handled above).
          // A real/physical point already occupies the slot; the virtual value loses silently.
          // No console.warn — real-vs-virtual collision is expected and resolved by design.
        } else {
          // Phase 2B / Phase 4: slot already occupied by another non-virtual point.
          // Check whether this is a redundant write (same point name repeated) or a genuine
          // collision between two distinct non-virtual points that both mapped here.
          var existingIsVirtual = existingWinner && /^\s*virtual\s+/i.test(existingWinner);
          if (existingIsVirtual) {
            // The previous winner was a virtual point — the real/physical point wins.
            // Overwrite silently (no warning; this is the expected virtual-loses outcome).
            wgroup.pointValues[pointCol] = pointVal;
            wgroup._pointColWinner[pointCol] = pointName;
          } else if (existingWinner && existingWinner !== pointName) {
            // Phase 4: genuine collision — two distinct non-virtual points map to the same column.
            // This is a mapping configuration problem. Surface it for triage.
            // Value-preference: keep a numeric value over a text value; otherwise keep existing
            // (first-wins for same-type values, since we have no other priority signal here).
            var existingNum = parseFloat(existing);
            var newNum = parseFloat(pointVal);
            var existingIsNumeric = !isNaN(existingNum);
            var newIsNumeric = !isNaN(newNum);
            if (!existingIsNumeric && newIsNumeric) {
              // Numeric displaces text — better signal.
              wgroup.pointValues[pointCol] = pointVal;
              wgroup._pointColWinner[pointCol] = pointName;
              console.warn(
                '[EM] Collision on column "' +
                  pointCol +
                  '" for equipment "' +
                  wgroup.equipName +
                  '": ' +
                  '"' +
                  existingWinner +
                  '" (text "' +
                  existing +
                  '") displaced by "' +
                  pointName +
                  '" (numeric ' +
                  pointVal +
                  '). Check EM_POINT_MAP patterns.',
              );
            } else {
              // Keep existing; log that the challenger lost.
              console.warn(
                '[EM] Collision on column "' +
                  pointCol +
                  '" for equipment "' +
                  wgroup.equipName +
                  '": ' +
                  '"' +
                  pointName +
                  '" (' +
                  pointVal +
                  ') lost to existing "' +
                  existingWinner +
                  '" (' +
                  existing +
                  '). Check EM_POINT_MAP patterns.',
              );
            }
          }
          // else: same point name seen again (duplicate row in CSV) — silently overwrite.
          // Phase 3 (STEP 3): the 30-120°F temperature range guard has been removed.
          // The exclusion negativePatterns added in Phase 2A now prevent config/alarm points
          // (capacity ratings, limit configs) from matching temperature columns in the first place.
          // A range check on the displayed value is never-hide-a-raw-value-safe only if done
          // before storage; since the raw drawer shows rawPointMap (always complete), removing
          // this range guard from the display/collision path is safe per the locked rules.
          if (existingWinner === pointName) {
            wgroup.pointValues[pointCol] = pointVal;
          }
        }
      }
    }
    // ── M3: Point-signature verification pass (WebCTRL format) ──
    // After all rows are consumed and every group has its full point set,
    // run the signature verifier to override name-pass classification for
    // groups whose type is ambiguous or known to mis-classify by name alone.
    groups.forEach(function (grp) {
      var provisionalCat = grp.category || 'other';
      // Run verifier when category is 'other', or is one of the types that may be
      // refined once we have the complete point signature.
      var needsVerify =
        provisionalCat === 'other' ||
        provisionalCat === 'ahu' ||
        provisionalCat === 'furnace' ||
        provisionalCat === 'zone' ||
        provisionalCat === 'fcu' ||
        provisionalCat === 'heater' ||
        provisionalCat === 'vav' ||
        provisionalCat === 'fpb' ||
        provisionalCat === 'ddvav' ||
        provisionalCat === 'doas';
      if (needsVerify) {
        var refined = emVerifyTypeByPoints(grp);
        if (refined !== provisionalCat) {
          grp.category = refined;
        }
      }
    });
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
        rawPointMap: {}, // M4: all raw column header→value for pointsRaw capture
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
    // Read live-data columns (zone temps, setpoints, etc.) using the header-derived index map
    if (colMap.liveColKeyByIdx) {
      for (var lpi in colMap.liveColKeyByIdx) {
        var lpiNum = parseInt(lpi, 10);
        // FIX 3a (1b74f531): Use explicit null/undefined check so 0 survives (was falsy || '')
        var lval = row[lpiNum] != null ? String(row[lpiNum]).trim() : '';
        if (lval !== '') {
          group.pointValues[colMap.liveColKeyByIdx[lpi]] = lval;
        }
      }
    }
    // M4: Capture all column header→value pairs from pointStart onward into rawPointMap.
    // Uses colMap.headerRow for column names. 0-safe: store even if value is '0' or empty.
    if (colMap.headerRow && colMap.pointStart >= 0) {
      for (var rpi = colMap.pointStart; rpi < row.length && rpi < colMap.headerRow.length; rpi++) {
        var rphdr = (colMap.headerRow[rpi] || '').trim();
        if (!rphdr) continue;
        var rpval = row[rpi] != null ? String(row[rpi]).trim() : '';
        group.rawPointMap[rphdr] = rpval;
      }
    }
  }
  // ── M3: Point-signature verification pass (enriched format) ──
  groups.forEach(function (grp) {
    var provisionalCat = grp.category || 'other';
    var needsVerify =
      provisionalCat === 'other' ||
      provisionalCat === 'ahu' ||
      provisionalCat === 'furnace' ||
      provisionalCat === 'zone' ||
      provisionalCat === 'fcu' ||
      provisionalCat === 'heater' ||
      provisionalCat === 'vav' ||
      provisionalCat === 'fpb' ||
      provisionalCat === 'ddvav' ||
      provisionalCat === 'doas';
    if (needsVerify) {
      var refined = emVerifyTypeByPoints(grp);
      if (refined !== provisionalCat) {
        grp.category = refined;
      }
    }
  });
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
    bacnetLocation: group.bacnetLocation || '', // 2224d15d: full BACnet path; used by integration-stub filter
    checks: checks,
    points: group.pointValues,
    pointsRaw: group.rawPointMap || {}, // M4: complete raw point name→value map
    schema: 2, // M4: rows with pointsRaw set are schema version 2
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
  // ── Cold-cache guard: return null sentinel when DB not ready ──
  // Callers must check for null and treat it as "loading", not "empty".
  // emRenderMatrix's Fix 1 guard handles this via DB.isReady() directly,
  // so null never reaches the empty-state branch there. Other callers
  // (emToggleEditMode, emToggleViewMode, etc.) have explicit null guards below.
  if (window.DB && !window.DB.isReady()) return null;
  var _emData = sget('en_eqmatrix_' + projId, { rows: [], importedAt: null, buildings: [] });
  // Back-compat shim (M2): the identity column key was renamed from 'equipType' to 'category'.
  // Pre-M2 stored rows that have equipType but no category will show '--' in the Equipment Type
  // column without this shim.  Patch at load time so no migration is needed.
  if (_emData && _emData.rows) {
    for (var _bci = 0; _bci < _emData.rows.length; _bci++) {
      var _bcrow = _emData.rows[_bci];
      if (_bcrow && (!_bcrow.category || _bcrow.category === '') && _bcrow.equipType) {
        _bcrow.category = _bcrow.equipType;
      }
      // Step 4 — Reclassify shim: in-memory only; emLoadMatrix never writes back to storage.
      // Pass A: name-based — re-run emClassifyEquipType for rows stored as 'other'.
      // Pass B: point-based — run emVerifyTypeByPoints on originally-'other' rows (even if Pass A
      //   moved them to a provisional non-'other' like 'ef' or 'fpb') so that point signatures
      //   can override an incorrect name-derived guess.  This catches F-2/F-4 (stored 'other',
      //   name pass → 'ef', point pass → 'ahu' via rule 12) and FTC/RHC fan-coil rows.
      if (_bcrow && _bcrow.category === 'other' && _bcrow.equipType) {
        // Pass A: name-based reclassify
        var _recat = emClassifyEquipType(_bcrow.equipType);
        if (_recat && _recat !== 'other') {
          _bcrow.category = _recat;
        }
        // Pass B: point-based — always run on originally-'other' rows (they may now be
        //   provisional 'ef', 'fpb', 'vav', etc. from Pass A; points take precedence).
        //   emVerifyTypeByPoints expects group.pointValues (object keyed by point name).
        //   Stored rows carry row.points; expose it as group.pointValues for the function.
        if (_bcrow.points && Object.keys(_bcrow.points).length > 0) {
          var _ptGroup = { category: _bcrow.category, pointValues: _bcrow.points };
          var _ptRecat = emVerifyTypeByPoints(_ptGroup);
          if (_ptRecat && _ptRecat !== 'other' && _ptRecat !== _bcrow.category) {
            _bcrow.category = _ptRecat;
          }
        }
      }
    }
    // Step 4B — hwp stale-row shim: reclassify stored 'hwp' rows that are actually
    //   furnaces, unit heaters, or plumbing pumps.  The generic /pump/i keyword in
    //   emClassifyEquipType's fuzzy map routed these into 'hwp' at import time.
    //   In-memory only; no storage mutation.
    for (var _hwpi = 0; _hwpi < _emData.rows.length; _hwpi++) {
      var _hwprow = _emData.rows[_hwpi];
      if (!_hwprow || _hwprow.category !== 'hwp' || !_hwprow.equipType) continue;
      // Furnaces: name contains 'furnace', or VVT air-source point signature
      if (/\bfurnace\b/i.test(_hwprow.equipType)) {
        _hwprow.category = 'furnace';
        continue;
      }
      // Unit heaters: UH/CUH/GUH/TUH names, or name contains 'unit heater' / 'unit heaters'
      if (
        /\buh[-\s]?[\da-z]/i.test(_hwprow.equipType) ||
        /\bcuh[-\s]?[\da-z]/i.test(_hwprow.equipType) ||
        /\bguh[-\s]?[\da-z]/i.test(_hwprow.equipType) ||
        /unit.?heater/i.test(_hwprow.equipType)
      ) {
        _hwprow.category = 'heater';
        continue;
      }
      // Unit heaters detected by point signature (Unit Heater Enable/Status/Amperage points)
      if (_hwprow.points && Object.keys(_hwprow.points).length > 0) {
        var _hwpPtGroup = { category: 'hwp', pointValues: _hwprow.points };
        var _hwpPtRecat = emVerifyTypeByPoints(_hwpPtGroup);
        if (_hwpPtRecat === 'heater' || _hwpPtRecat === 'furnace') {
          _hwprow.category = _hwpPtRecat;
          continue;
        }
      }
      // Plumbing pumps: clearly non-HVAC pump names → 'plumbing'.
      // Conservative: only fire/sewage/sump/grinder/domestic-water pumps; real HW
      // circulation pumps (Hot Water Pump, Primary/Sec HW Pump) stay 'hwp'.
      if (
        /fire.?pump/i.test(_hwprow.equipType) ||
        /sump.?pump/i.test(_hwprow.equipType) ||
        /grinder.?pump/i.test(_hwprow.equipType) ||
        /sewage.?pump/i.test(_hwprow.equipType) ||
        /domestic.?(hot.?water|water).?pump/i.test(_hwprow.equipType) ||
        /domestic.?hot.?water.?pump/i.test(_hwprow.equipType) ||
        /water.?&.?fire.?pump/i.test(_hwprow.equipType) ||
        /domestic.?water.?booster.?pump/i.test(_hwprow.equipType)
      ) {
        _hwprow.category = 'plumbing';
        continue;
      }
    }
  }
  return _emData;
}

function emSaveMatrix(projId, data) {
  if (!projId) return Promise.resolve();
  // Invalidate caches — data may have changed (edits, imports, deletions)
  _emComplianceCache = {};
  _emNormCache = new Map();
  // Milestone 1: _emPointNameCache is page-lifetime but cleared here to stay consistent
  // (edit path calls emSaveMatrix before re-render). _emPointsComputedCache is explicitly
  // reset so any in-place mutation of row.points that may occur before emLoadMatrix replaces
  // the row object is never served stale from the WeakMap.
  _emPointNameCache = new Map();
  _emPointsComputedCache = new WeakMap();
  // Invalidate the dynPoint frequency cache — data rows have changed.
  _emDynPointFreqCache = null;
  _emDynPointFreqCacheKey = null;
  // sset() returns a Promise that resolves on IDB tx.oncomplete (real commit).
  // Callers that need write durability (e.g. emHandleImport) should await this.
  return sset('en_eqmatrix_' + projId, data);
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
  // ── Sort rows: building alphabetically, then HVAC types before non-HVAC, then equipment name ──
  // M3: expanded priority map — extracted to module scope as _emTypePriority (shared with render functions)
  merged.sort(function (a, b) {
    var ab = (a.building || '').toLowerCase();
    var bb = (b.building || '').toLowerCase();
    if (ab < bb) return -1;
    if (ab > bb) return 1;
    var ap = _emTypePriority[a.category] !== undefined ? _emTypePriority[a.category] : 8;
    var bp = _emTypePriority[b.category] !== undefined ? _emTypePriority[b.category] : 8;
    if (ap !== bp) return ap - bp;
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
// Module-level HVAC priority map — used at import time (emMergeIntoMatrix) and display time (emRenderTable, emRenderAuditTable)
var _emTypePriority = {
  ahu: 0,
  doas: 1,
  vav: 2,
  fpb: 3,
  ddvav: 4,
  zone: 5,
  furnace: 6,
  fcu: 7,
  heater: 8,
  ef: 9,
  hwp: 10,
  chwp: 11,
  ct: 12,
  lighting: 13,
  fire: 14,
  power: 15,
  plumbing: 16,
  controls: 17,
  sensor: 18,
  // M4: new non-HVAC categories
  elevator: 19,
  monitoring: 20,
  security: 21,
  other: 22,
};
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
var _emColKeyToCatKey = null; // FIX A: reverse map { colKey: { equipType: { catKey, catLabel, ashrae36Name, ashrae36Section, required } } } built lazily
var _emNormCache = new Map(); // Performance: memoized emNormalizePoint results, keyed by rawName+'\0'+category
var _emPointsComputedCache = new WeakMap(); // Milestone 1: keyed on row object; caches emGetNormalizedPoints result
var _emPointNameCache = new Map(); // Milestone 1: rawName -> colKey, page-lifetime memoization for emMapPointToColumn
var _emSearchTimer = null; // Performance: debounce timer for search input
var _emOpenDrawers = new Set(); // M4: per-equipment "All Points" drawer state, keyed by row.id
// Performance (Quick Win 3): Dynamic-column frequency scan cache.
// Keyed by "<pid>|<building>|<type>|<rowCount>" so it auto-invalidates when
// the filter or dataset changes. Stores { freq: {ptKey: count}, keys: [...sorted] }.
var _emDynPointFreqCache = null;
var _emDynPointFreqCacheKey = null;
// Render-generation counter — incremented on every emRenderTable call so async
// chunked render batches can detect a stale render and self-cancel.
var _emRenderGen = 0;
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
  // ── State (a): DB not ready yet — show loading placeholder, re-render when ready ──
  if (window.DB && !window.DB.isReady()) {
    wrap.innerHTML =
      '<div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--text2);min-height:0">' +
      '<div style="font-size:28px;opacity:.4">&#x23F3;</div>' +
      '<div style="font-size:14px;font-weight:600">Loading equipment data…</div>' +
      '</div>';
    // Re-render once DB signals completion — dbReady (success) or dbLoadFailed (failure).
    // Both use {once:true} so the handler fires at most once. dataUpdated is intentionally
    // NOT registered here — see lines below for the reason.
    var _emInitPending = function () {
      initEquipMatrix(projId);
    };
    window.addEventListener('dbReady', _emInitPending, { once: true });
    window.addEventListener('dbLoadFailed', _emInitPending, { once: true });
    // dataUpdated REMOVED: fires while DB is still cold (e.g. theme change, settings save)
    // and consumes the {once:true} slot prematurely. The original dbReady listener was
    // already consumed, leaving the matrix stuck on "Loading…" forever. dbReady is the
    // only reliable signal that warmCache has completed successfully.
    // Fix 2B — defensive double-check: if DB became ready between the isReady() check
    // above and the addEventListener calls (theoretical single-threaded race, but explicit),
    // remove the listeners and re-call immediately.
    if (window.DB && window.DB.isReady()) {
      window.removeEventListener('dbReady', _emInitPending);
      window.removeEventListener('dbLoadFailed', _emInitPending);
      initEquipMatrix(projId);
    }
    return;
  }
  // ── State (b): DB ready but load failed (IDB unavailable, fell back to localStorage) ──
  if (window._dbLoadFailed || (window.DB && window.DB.isLoadFailed())) {
    wrap.innerHTML =
      '<div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0">' +
      '<div style="font-size:32px">&#x26A0;&#xFE0F;</div>' +
      '<div style="font-size:14px;font-weight:700;color:var(--text)">Couldn\'t load equipment data</div>' +
      '<div style="font-size:12px;color:var(--text2);text-align:center;max-width:320px">Storage failed to initialize. Your data is not lost — try refreshing.</div>' +
      '<button class="btn btn-sm" style="margin-top:6px" onclick="location.reload()">Refresh</button>' +
      '</div>';
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
    // Handle-div resize pattern — th must be relative so the handle can position absolutely
    '.em-table-wrap th { position: relative; }',
    '.em-col-resize-handle { position:absolute; right:0; top:0; width:6px; height:100%; cursor:col-resize; z-index:1; }',
    '.em-col-resize-handle:hover, .em-col-resize-handle.dragging { background: var(--accent); opacity:0.4; }',
    // Footer frozen cells keep the table-body background, not the header background
    '.em-table-wrap tfoot td.em-frozen { background: var(--s1) !important; }',
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

  // Collect all rows (thead + tbody + tfoot)
  var allRows = [];
  var theadRows = table.querySelectorAll('thead tr');
  var tbodyRows = table.querySelectorAll('tbody tr');
  var tfootRows = table.querySelectorAll('tfoot tr');
  for (var i = 0; i < theadRows.length; i++) allRows.push(theadRows[i]);
  for (var j = 0; j < tbodyRows.length; j++) allRows.push(tbodyRows[j]);
  for (var k = 0; k < tfootRows.length; k++) allRows.push(tfootRows[k]);

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
  if (!data) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:#888">⏳ Loading equipment data…</div>';
    return;
  }
  if (!data.edits) data.edits = {};

  // ── Guard: if DB not ready, show loading state instead of empty state ──────
  // This closes the gap for all call sites that bypass initEquipMatrix
  // (emToggleEditMode, emToggleViewMode, emSetSummaryView, emDrillBuilding,
  // emExitDrillBuilding, import-success render). When warmCache is still
  // running, emLoadMatrix returns null and sget falls back to {rows:[]}.
  // Without this guard, those cold reads render "Import CSVs" incorrectly.
  if (window.DB && !window.DB.isReady()) {
    container.innerHTML =
      '<div style="display:flex;flex:1;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;color:var(--text2);min-height:0">' +
      '<div style="font-size:28px;opacity:.4">&#x23F3;</div>' +
      '<div style="font-size:14px;font-weight:600">Loading equipment data…</div>' +
      '</div>';
    return;
  }
  // ── Empty state: no rows yet (DB is ready — this is a genuinely empty project) ──
  if (!data.rows || data.rows.length === 0) {
    container.innerHTML =
      '<div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text2);min-height:0">' +
      '<div style="font-size:32px;opacity:.3">📋</div>' +
      '<div style="font-size:14px;font-weight:600">No equipment data for this project yet</div>' +
      '<div style="font-size:12px;color:var(--text3)">Import a WebCTRL CSV export to build the Equipment Matrix.</div>' +
      '<button class="btn btn-em btn-sm" style="margin-top:6px" onclick="emShowUploadPanel(this,\'merge\',\'' +
      pid +
      '\')">Import CSVs</button>' +
      '</div>';
    return;
  }

  _emFilters = { building: '', type: '', search: '' };
  _emSortCol = null;
  _emSortDir = 1;
  _emHiddenGroups = { asset: true }; // asset columns (Serial#, Model#, Manufacturer, Size/Capacity) hidden by default
  _emEditMode = false;
  _emCurrentPage = 0;
  _emPageSize = EM_PAGE_SIZE;
  _emShowAllDynCols = false;
  _emViewMode = 'audit';
  _emOpenDrawers = new Set();
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
    (stats.lighting ? emStatPill('Lighting', stats.lighting) : '') +
    (stats.other ? emStatPill('Other', stats.other) : '') +
    emStatPill('Has Data', stats.live) +
    (data.totalBASPoints ? emStatPill('BAS Points', data.totalBASPoints.toLocaleString()) : '') +
    '</div>';

  var projBadge = projName
    ? '<span style="font-size:11px;color:var(--text3);margin-left:10px;font-weight:400">' + projName + '</span>'
    : '';

  var toolbarHtml = emRenderToolbar(data, pid, projBadge);

  container.innerHTML =
    '<div style="display:flex;flex-direction:column;flex:1;min-height:0">' +
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
    lighting = 0,
    other = 0,
    live = 0;
  // M3: new type buckets for stats bar
  var _hvacNewTypes = { doas: 0, fcu: 0, heater: 0, ef: 0, furnace: 0, zone: 0 };
  var _nonHvacTypes = { fire: 0, power: 0, plumbing: 0, controls: 0, sensor: 0 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.building) buildings[r.building] = true;
    if (r.category === 'ahu') ahu++;
    // M3: VAV family now includes zone (VVT zone terminals)
    if (r.category === 'vav' || r.category === 'fpb' || r.category === 'ddvav' || r.category === 'zone') vav++;
    if (r.category === 'hwp' || r.category === 'chwp' || r.category === 'ct') plants++;
    if (r.category === 'lighting') lighting++;
    if (r.category === 'other') other++;
    // Count new M3 types
    if (r.category in _hvacNewTypes) _hvacNewTypes[r.category]++;
    if (r.category in _nonHvacTypes) _nonHvacTypes[r.category]++;
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
    lighting: lighting,
    other: other,
    live: live,
    doas: _hvacNewTypes.doas,
    fcu: _hvacNewTypes.fcu,
    heater: _hvacNewTypes.heater,
    ef: _hvacNewTypes.ef,
    furnace: _hvacNewTypes.furnace,
    zone: _hvacNewTypes.zone,
    fire: _nonHvacTypes.fire,
    power: _nonHvacTypes.power,
    plumbing: _nonHvacTypes.plumbing,
    controls: _nonHvacTypes.controls,
    sensor: _nonHvacTypes.sensor,
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
    'background:var(--s1);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.28);width:600px;max-width:calc(100vw - 32px);z-index:9999;overflow-y:auto;max-height:calc(100vh - 90px)';

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
    '<option value="ahu">AHU / RTU</option>' +
    '<option value="doas">DOAS / ERV</option>' +
    '<option value="vav">VAV</option>' +
    '<option value="fpb">FPB</option>' +
    '<option value="ddvav">DD-VAV</option>' +
    '<option value="zone">VVT Zone</option>' +
    '<option value="furnace">Furnace / VVT</option>' +
    '<option value="fcu">Fan Coil / VRF</option>' +
    '<option value="heater">Unit Heater</option>' +
    '<option value="ef">Exhaust Fan</option>' +
    '<option value="hwp">HW Plant</option>' +
    '<option value="chwp">CHW Plant</option>' +
    '<option value="ct">Cooling Tower</option>' +
    '<option value="lighting">Lighting</option>' +
    '<option value="fire">Fire / Smoke</option>' +
    '<option value="power">Power / Gen</option>' +
    '<option value="plumbing">Plumbing</option>' +
    '<option value="controls">Controls / VFD</option>' +
    '<option value="sensor">Sensor / Weather</option>' +
    '<option value="other">Other</option>';
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
    // Audit-view legend bar — color-only cells; legend explains each color
    '<span id="em-audit-col-info" style="display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--text3)">' +
    '<span style="font-size:10px;color:var(--text3);margin-right:2px">Legend:</span>' +
    '<span title="Green = point matched in BAS data (automatic name match). Shows snapshot value when available." style="padding:1px 10px;border-radius:3px;background:rgba(39,174,96,0.15);color:#27ae60;font-weight:600">&nbsp;</span>' +
    '<span style="font-size:10px;color:var(--text3)">Matched</span>' +
    '<span title="Amber = point likely present but name is non-standard (lower-confidence match). Hover cell for point name." style="padding:1px 10px;border-radius:3px;background:rgba(230,126,34,0.15);color:#e67e22;font-weight:600">&nbsp;</span>' +
    '<span style="font-size:10px;color:var(--text3)">Likely match</span>' +
    '<span title="Red = required ASHRAE 36 point not found in BAS data." style="padding:1px 10px;border-radius:3px;background:rgba(192,57,43,0.15);color:#c0392b;font-weight:600">&nbsp;</span>' +
    '<span style="font-size:10px;color:var(--text3)">Not found</span>' +
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
    '<span style="font-size:11px;color:var(--text3)">View:</span>' +
    '<button id="em-audit-btn" class="btn btn-sm" onclick="emSetAuditView()" style="height:28px;font-size:11px;background:var(--accent);color:#fff;border-color:transparent">Audit View</button>' +
    '<button id="em-raw-btn" class="btn btn-ghost btn-sm" onclick="emSetRawView()" style="height:28px;font-size:11px">Raw View</button>' +
    '<button id="em-summary-btn" class="btn btn-ghost btn-sm" onclick="emSetSummaryView()" title="Aggregated stats grouped by building and equipment type" style="height:28px;font-size:11px;background:var(--s2);color:var(--text2);border-color:var(--border)">Summary</button>' +
    '<button id="em-edit-mode-btn" class="btn btn-ghost btn-sm" onclick="emToggleEditMode(this)" style="height:28px;font-size:11px">Edit</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emHandleSaveEdits()" style="height:28px;font-size:11px">Save Edits</button>' +
    '<button id="em-delete-all-btn" class="btn btn-ghost btn-sm" onclick="emDeleteAllRows(\'' +
    pid +
    '\')" style="height:28px;font-size:11px;display:none;background:#fee2e2;border-color:#fca5a5;color:#b91c1c">Delete All</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="emClearAllData(\'' +
    pid +
    '\')" style="height:28px;font-size:11px;background:#b91c1c;border-color:#991b1b;color:#fff">Clear All Data</button>' +
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
    // Milestone 2: equipName is now the FULL control program string
    { key: 'equipName', label: 'Equipment Name', group: 'id', width: 240 },
    // Milestone 2: renamed from "Control Program" — shows classified equipment type
    { key: 'category', label: 'Equipment Type', group: 'id', width: 130, isCategory: true },
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
      } else {
        // Promote required to true if ANY equipment type marks this key required.
        // Prevents first-writer-wins from hiding a real compliance gap when a
        // DOAS row (required:false) precedes an AHU row (required:true) for
        // shared keys like oat/rat/mat.
        if (c.required) categoryMap[c.key].required = true;
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

  // CHANGE 1 (1fc747b4): Build a set of category keys that have at least one match
  // across the filtered rows so optional zero-match columns can be hidden.
  // Required columns are always kept (red "not found" cells are intentional audit findings).
  // emComputeCompliance is cached by row.id so this scan is cheap on repeat renders.
  var coveredCatKeys = {};
  for (var si = 0; si < filteredRows.length; si++) {
    var sRow = filteredRows[si];
    if (!sRow.category || !EM_POINT_CATEGORIES[sRow.category]) continue;
    var sCompliance = emComputeCompliance(sRow);
    for (var sci = 0; sci < sCompliance.coveredPoints.length; sci++) {
      coveredCatKeys[sCompliance.coveredPoints[sci].categoryKey] = true;
    }
  }

  // CHANGE 2 (column ordering): ASHRAE-36 logical group rank for stable column order.
  // Groups: 1=Zone Comfort (temp+SPs lead), 2=Zone Adjacent, 3=Air Temps, 4=Water Temps,
  //         5=Outside Air, 6=Non-Zone Setpoints, 7=Flow/Damper/Valve,
  //         8=Fan/Status/Pressure, 9=Plant/Central/Mode, 10=Other (unmapped fallback)
  var _emAshraeCatGroup = {
    // Group 1 — Zone Comfort Leads (temp first, then setpoints adjacent)
    zoneTemp: 1,
    coolSP: 1,
    htgSP: 1,
    // Group 2 — Zone / Space Adjacent Conditions
    zoneHumidity: 2,
    co2: 2,
    rhReturn: 2,
    co2Return: 2,
    // Group 3 — Air Temperatures
    sat: 3,
    rat: 3,
    mat: 3,
    dat: 3,
    ahuSAT: 3,
    preheatAirTemp: 3,
    clgCoilLvgTemp: 3,
    htgCoilLvgTemp: 3,
    // Group 4 — Water Temperatures
    hwst: 4,
    hwrt: 4,
    chwst: 4,
    chwrt: 4,
    cwst: 4,
    cwrt: 4,
    // Group 5 — Outside Air Conditions
    oat: 5,
    oaRh: 5,
    oaDewpoint: 5,
    oaEnthalpy: 5,
    oaWetBulb: 5,
    // Group 6 — Non-Zone Setpoints
    dspSp: 6,
    satCoolSp: 6,
    satHtgSp: 6,
    econSp: 6,
    ventCfmSp: 6,
    hwSetpoint: 6,
    chwSetpoint: 6,
    oaEnable: 6,
    // Group 7 — Flow / Damper / Valve
    oaFlow: 7,
    discFlow: 7,
    primaryFlow: 7,
    ventCfm: 7,
    rfCfm: 7,
    sfCfm: 7,
    oaDampCmd: 7,
    raDampCmd: 7,
    oaDamp: 7,
    raDamp: 7,
    reliefDamp: 7,
    dampCmd: 7,
    coldDampCmd: 7,
    hotDampCmd: 7,
    zoneDamper: 7,
    clgValve: 7,
    htgValve: 7,
    reheatValve: 7,
    chwValve: 7,
    hwValve: 7,
    hwIsoValve: 7,
    hwIsoValveCmd: 7,
    chwIsoValveStatus: 7,
    chwIsoValveCmd: 7,
    cwIsoValveStatus: 7,
    cwIsoValveCmd: 7,
    makeupValveCmd: 7,
    // Group 8 — Fan / Status / Commands / Pressure
    sfStatus: 8,
    sfSpeed: 8,
    sfEnable: 8,
    sfSpeedCmd: 8,
    rfEnable: 8,
    rfSpeedCmd: 8,
    rfSpeed: 8,
    sfAmps: 8,
    fanStatus: 8,
    fanSpeed: 8,
    termFanStatus: 8,
    termFanEnable: 8,
    termFanSpeed: 8,
    ctFanStatus: 8,
    ctFanEnable: 8,
    ctFanSpeed: 8,
    dsp: 8,
    bldgPressure: 8,
    rdsp: 8,
    hwdp: 8,
    chwdp: 8,
    chillerEvapDP: 8,
    // Group 9 — Plant / Central Equipment / Mode
    hwFlow: 9,
    chwFlow: 9,
    boilerStatus: 9,
    boilerEnable: 9,
    hwPumpStatus: 9,
    hwPumpEnable: 9,
    hwPumpSpeed: 9,
    secHWPumpStatus: 9,
    chillerStatus: 9,
    chillerEnable: 9,
    pchwpStatus: 9,
    schwpStatus: 9,
    schwpEnable: 9,
    schwpSpeed: 9,
    pchwpEnable: 9,
    cwPumpStatus: 9,
    cwPumpEnable: 9,
    sumpLevel: 9,
    hwIsoValveStatus: 9,
    freezeStat: 9,
    enable: 9,
    vvtMode: 9,
    airSourceVVT: 9,
    oaDamper: 9,
    demandLevel: 9,
    schedule: 9,
  };

  // Add one column per point category (required, or optional with at least one match)
  var catKeys = Object.keys(categoryMap);
  for (var ki = 0; ki < catKeys.length; ki++) {
    var cd = categoryMap[catKeys[ki]];
    // CHANGE 1: skip optional categories that have zero matches in the filtered rows
    if (!cd.required && !coveredCatKeys[cd.key]) continue;
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
        '. Green = matched, Amber = likely match (non-standard name), Red = not found, N/A = not applicable.',
    });
  }

  // CHANGE 2: Sort audit-cat columns by ASHRAE logical group, then by definition order within each group.
  // Fixed-position columns (id, audit metadata) are prepended before this sort — only audit-cat entries move.
  var _auditCatStart =
    defs.length -
    catKeys.filter(function (k) {
      var c = categoryMap[k];
      return c.required || coveredCatKeys[c.key];
    }).length;
  var _nonCatDefs = defs.slice(0, _auditCatStart);
  var _catDefs = defs.slice(_auditCatStart);
  _catDefs.sort(function (a, b) {
    var ga = _emAshraeCatGroup[a.catKey] || 10;
    var gb = _emAshraeCatGroup[b.catKey] || 10;
    return ga - gb;
  });
  // Rebuild defs: fixed prefix + sorted audit-cat + any remaining (seq, behavior) appended after
  defs = _nonCatDefs.concat(_catDefs);

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

  // Phase 4.1 — "Setpoint Values" column (GL36 §3.1.1.1 / Table 3.1.1.3 value compliance).
  // Only applies to zone equipment (vav, fpb, ddvav, zone, fcu). Shows pill per row.
  var _spZoneCats = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
  var _hasSpZoneType = false;
  for (var _spti = 0; _spti < equipTypes.length; _spti++) {
    if (_spZoneCats[equipTypes[_spti]]) {
      _hasSpZoneType = true;
      break;
    }
  }
  if (_hasSpZoneType) {
    defs.push({
      key: '_spValues',
      label: 'Setpoint Values',
      group: 'audit-sp',
      width: 130,
      isAuditSpValues: true,
      spZoneEquipTypes: Object.keys(_spZoneCats),
      title:
        'GL36 §3.1.1.1 / Table 3.1.1.3 — Compares actual zone setpoint values against GL36 defaults. ' +
        'Green = All Match, Amber = Needs Review (deviations found — may be intentional per §3.1.1.1), ' +
        'Gray = No Data (setpoints not in BAS export), — = not applicable to this equipment type. ' +
        'Click Coverage % cell to see the full GL36 Setpoint Check detail.',
    });
  }

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
    (stats.doas ? emStatPill('DOAS', stats.doas) : '') +
    emStatPill('VAV / FPB', stats.vav) +
    (stats.furnace ? emStatPill('Furnace', stats.furnace) : '') +
    (stats.fcu ? emStatPill('Fan Coil', stats.fcu) : '') +
    (stats.heater ? emStatPill('Heater', stats.heater) : '') +
    (stats.ef ? emStatPill('Exh Fan', stats.ef) : '') +
    emStatPill('Plants', stats.plants) +
    (stats.lighting ? emStatPill('Lighting', stats.lighting) : '') +
    (stats.fire ? emStatPill('Fire', stats.fire) : '') +
    (stats.power ? emStatPill('Power', stats.power) : '') +
    (stats.plumbing ? emStatPill('Plumbing', stats.plumbing) : '') +
    (stats.controls ? emStatPill('Controls', stats.controls) : '') +
    (stats.sensor ? emStatPill('Sensors', stats.sensor) : '') +
    (stats.other ? emStatPill('Other', stats.other) : '') +
    emStatPill('Has Data', stats.live) +
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

/* ── Milestone 1: Known col-key set ─────────────────────────────────────────
   Built once from EM_POINT_MAP. Used by emGetNormalizedPoints to distinguish
   already-mapped col keys (e.g. 'supplyAirTemp') from raw BAS names in row.points. */
var _emKnownPointColKeys = (function () {
  var s = new Set();
  for (var _ki = 0; _ki < EM_POINT_MAP.length; _ki++) {
    s.add(EM_POINT_MAP[_ki].col);
  }
  return s;
})();

/* -- Backward-compatibility alias map (item 65248601) -----------------
   Maps OLD col keys (e.g. 'satLive') to NEW col keys (e.g. 'supplyAirTemp').
   Used by emGetNormalizedPoints so previously-enriched CSVs whose row.points
   carry old key names still resolve correctly without re-import.

   PROTOCOL (Step 4 — item b3bc972e): every future EM_POINT_MAP col-key rename MUST
   add an entry here in the form  oldKey: 'newKey'  so stored rows whose row.points
   carry the old key still resolve without forcing a re-import.  Failure to add an
   entry will silently zero-out that point for all previously-imported datasets.    */
var _emColKeyAliases = {
  airSrcSupTempLive: 'airSourceSupplyTemp',
  chwDiffPresLive: 'chwDiffPressure',
  chwFlowLive: 'chwFlow',
  chwRetTempLive: 'chwReturnTemp',
  chwSupSpLive: 'chwSupplySetpoint',
  chwSupTempLive: 'chwSupplyTemp',
  clgCoilLvgTempLive: 'coolingCoilLeavingTemp',
  clgValveLive: 'coolingValve',
  co2Live: 'zoneCO2',
  co2ReturnLive: 'returnAirCO2',
  ctFanSpeedLive: 'ctFanSpeed',
  cwRetTempLive: 'cwReturnTemp',
  cwSupTempLive: 'cwSupplyTemp',
  dampPosLive: 'damperPosition',
  datLive: 'dischargeAirTemp',
  demandLevelLive: 'demandLevel',
  discFlowLive: 'dischargeAirflow',
  discFlowSpLive: 'airflowSetpoint',
  dspLive: 'ductStaticPressure',
  dspSpLive: 'ductStaticSetpoint',
  econSpLive: 'economizerSetpoint',
  efSpeedLive: 'exhaustFanSpeed',
  effCoolSpLive: 'effectiveCoolSetpoint',
  effHtgSpLive: 'effectiveHtgSetpoint',
  htgCoilLvgTempLive: 'heatingCoilLeavingTemp',
  htgValveLive: 'heatingValve',
  hwDiffPresLive: 'hwDiffPressure',
  hwRetTempLive: 'hwReturnTemp',
  hwSupSpLive: 'hwSupplySetpoint',
  hwSupTempLive: 'hwSupplyTemp',
  matLive: 'mixedAirTemp',
  oaDampLive: 'oaDamperPosition',
  oaDewpointLive: 'oaDewpoint',
  oaEnthalpyLive: 'oaEnthalpy',
  oaFlowLive: 'oaAirflow',
  oaRhLive: 'oaRelativeHumidity',
  oaWetBulbLive: 'oaWetBulb',
  oatLive: 'outdoorAirTemp',
  oatLiveBcast: 'outdoorAirTempBcast',
  preheatAirTempLive: 'preheatAirTemp',
  primAirSrcCoolReqLive: 'primaryAirCoolRequest',
  primAirSrcHtgReqLive: 'primaryAirHtgRequest',
  raDampLive: 'returnAirDamper',
  ratLive: 'returnAirTemp',
  rdspLive: 'returnDuctStatic',
  reheatValveLive: 'reheatValve',
  reliefDampLive: 'reliefDamper',
  rfCfmLive: 'returnFanCFM',
  rfSpeedLive: 'returnFanSpeed',
  rhReturnLive: 'returnAirHumidity',
  rhZone: 'zoneRelativeHumidity',
  rhZoneSpLive: 'humiditySetpoint',
  satCoolSpLive: 'satCoolSetpoint',
  satHtgSpLive: 'satHtgSetpoint',
  satLive: 'supplyAirTemp',
  schedLive: 'scheduledOccupied',
  sfAmpsLive: 'supplyFanAmps',
  sfCfmLive: 'supplyFanCFM',
  sfSpeedLive: 'supplyFanSpeed',
  sfStatusLive: 'supplyFanStatus',
  ventCfmLive: 'ventilationCFM',
  ventCfmSpLive: 'ventilationCFMSetpoint',
  zoneAirTempLive: 'zoneAirTemp',
  zoneCoolAdjLive: 'zoneCoolAdjust',
  zoneCO2SpLive: 'zoneCO2Setpoint',
  zoneCoolSpLive: 'zoneCoolSetpoint',
  zoneCoolUnoccSpLive: 'zoneUnoccCoolSetpoint',
  zoneDamperLive: 'zoneDamper',
  zoneHtgAdjLive: 'zoneHtgAdjust',
  zoneHtgSpLive: 'zoneHtgSetpoint',
  zoneHtgUnoccSpLive: 'zoneUnoccHtgSetpoint',
  zoneTempShortLive: 'zoneTemp',
};

/* ── emGetNormalizedPoints ───────────────────────────────────────────────────
   Returns a flat { colKey: value } map for a row, derived at read time.

   For rows already stored with mapped col keys (current import path):
     - Copies existing mapped values directly.
   For rows with raw BAS names mixed in (or future pointsRaw schema):
     - Runs emMapPointToColumn on unknown keys to surface new columns
       (e.g. 'Zone Humidity' → zoneRelativeHumidity) WITHOUT requiring re-import.

   Rules:
     - Never overwrites an already-set colKey.
     - Preserves 0 / '0' / false — only skips null/undefined.
     - Result is WeakMap-memoized on the row object (invalidated when
       emSaveMatrix loads fresh deserialized row objects).            */
function emGetNormalizedPoints(row) {
  if (_emPointsComputedCache.has(row)) return _emPointsComputedCache.get(row);

  var result = {};
  // Collision-priority (item 0f00639f): track which columns were filled by a virtual point
  // so a real/physical point can overwrite them. Virtual points are a fallback only.
  var _virtualFilledCols = {};
  // Returns true if the raw point name starts with "Virtual " (case-insensitive).
  function _isVirtual(name) {
    return /^\s*virtual\s+/i.test(name);
  }

  if (row.pointsRaw) {
    // M4 schema: pointsRaw is an object { rawName: value } (string→string map)
    // Legacy fallback: also handle array of [rawName, val] pairs (pre-M4 placeholder)
    var rawEntries = row.pointsRaw;
    if (Array.isArray(rawEntries)) {
      for (var ri = 0; ri < rawEntries.length; ri++) {
        var rawName = rawEntries[ri][0];
        var rawVal = rawEntries[ri][1];
        if (rawVal == null || rawVal === '') continue;
        var rColKey = emMapPointToColumn(rawName);
        if (!rColKey) continue;
        var rIsVirtual = _isVirtual(rawName);
        if (result[rColKey] == null) {
          // Column is empty — fill it regardless of virtual/real.
          result[rColKey] = rawVal;
          _virtualFilledCols[rColKey] = rIsVirtual;
        } else if (!rIsVirtual && _virtualFilledCols[rColKey]) {
          // Real point displaces a previously written virtual point.
          result[rColKey] = rawVal;
          _virtualFilledCols[rColKey] = false;
        }
        // else: column already held by a real point — do not overwrite.
      }
    } else {
      // Object format (M4): iterate keys
      var rawKeys = Object.keys(rawEntries);
      for (var rki = 0; rki < rawKeys.length; rki++) {
        var rawName2 = rawKeys[rki];
        var rawVal2 = rawEntries[rawName2];
        if (rawVal2 == null || rawVal2 === '') continue;
        var rColKey2 = emMapPointToColumn(rawName2);
        if (!rColKey2) continue;
        var rIsVirtual2 = _isVirtual(rawName2);
        if (result[rColKey2] == null) {
          result[rColKey2] = rawVal2;
          _virtualFilledCols[rColKey2] = rIsVirtual2;
        } else if (!rIsVirtual2 && _virtualFilledCols[rColKey2]) {
          // Real displaces virtual.
          result[rColKey2] = rawVal2;
          _virtualFilledCols[rColKey2] = false;
        } else if (!rIsVirtual2 && !_virtualFilledCols[rColKey2]) {
          // Real-vs-real: apply numeric-over-text preference (parity with import-time Path A).
          var _existNum2 = parseFloat(result[rColKey2]);
          var _newNum2 = parseFloat(rawVal2);
          if (isNaN(_existNum2) && !isNaN(_newNum2)) {
            // Existing is text, incoming is numeric — numeric wins (same rule as emExtractEquipmentGroups).
            result[rColKey2] = rawVal2;
            _virtualFilledCols[rColKey2] = false;
          }
          // else: same type — first-wins (keep existing). No change needed.
        }
      }
    }
  } else if (row.points) {
    // Legacy / current schema: row.points may contain a mix of known col keys
    // (e.g. 'supplyAirTemp') and raw BAS names (e.g. 'Zone Humidity') stored at import time.

    // Pass 1: copy entries that are already known col keys — these are trusted mapped values.
    // Known col keys are never raw BAS names so virtual-priority does not apply here.
    // Backward-compat (item 65248601): also remap old col keys (e.g. 'satLive') to new keys.
    //   - If k is a new-name key (e.g. 'supplyAirTemp'), kResolved === k → copies directly.
    //   - If k is an old-name key (e.g. 'satLive'), kResolved is the new name → remapped.
    var pts = row.points;
    var keys = Object.keys(pts);
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      // Remap old key to new key if it is a known alias (backward-compat)
      var kResolved = _emColKeyAliases[k] ? _emColKeyAliases[k] : k;
      if (_emKnownPointColKeys.has(kResolved)) {
        var v = pts[k];
        if (v != null && result[kResolved] == null) result[kResolved] = v;
      }
    }

    // Pass 2: iterate unknown keys (raw BAS names) and try to match them.
    // This surfaces new columns (humidity, CO2 additions, etc.) on already-stored data.
    // Collision-priority: a real point overwrites a virtual point that mapped to the same column.
    for (var ki2 = 0; ki2 < keys.length; ki2++) {
      var rawKey = keys[ki2];
      // Skip if it's a current col key OR an old col key alias (both handled in pass 1)
      if (_emKnownPointColKeys.has(rawKey) || _emColKeyAliases[rawKey]) continue;
      var rawV = pts[rawKey];
      if (rawV == null) continue;
      var colKey = emMapPointToColumn(rawKey);
      if (!colKey) continue;
      var isVirt = _isVirtual(rawKey);
      if (result[colKey] == null) {
        // Column is empty — fill it (real or virtual).
        result[colKey] = rawV;
        _virtualFilledCols[colKey] = isVirt;
      } else if (!isVirt && _virtualFilledCols[colKey]) {
        // Real point displaces a previously written virtual point from pass 2.
        // Never overwrite a value from pass 1 (known col keys are never virtual-flagged).
        result[colKey] = rawV;
        _virtualFilledCols[colKey] = false;
      }
      // else: already held by a real point or a pass-1 value — do not overwrite.
    }
  }

  _emPointsComputedCache.set(row, result);
  return result;
}

function emGetCellValByDef(row, def, edits) {
  var editKey = row.id + '::' + def.key;
  if (edits && edits[editKey] !== undefined) return edits[editKey];
  if (def.key.indexOf('check_') === 0) {
    var checkCols = EM_CHECK_COLS_14;
    // FIX 3a (1b74f531): Use explicit null/undefined check so 0 passes through (was falsy || '')
    var cv = row.checks && row.checks[checkCols[def.checkIdx]];
    return cv != null ? cv : '';
  }
  if (def.isLive || def.isDynPoint) {
    // Milestone 1: read through normalized-points engine so new columns (e.g. rhZone)
    // surface from already-stored raw BAS names without re-import.
    // FIX 3a (1b74f531): Use explicit null/undefined check so 0 and '0' pass through.
    var pv = emGetNormalizedPoints(row)[def.key];
    return pv != null ? pv : '';
  }
  // FIX 3a (1b74f531): Use explicit null/undefined check so 0 passes through (was falsy || '')
  return row[def.key] != null ? row[def.key] : '';
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
    // Skip dynamic BAS point columns — averaging ~500 dyn cols × 2700 rows = ~1.35M
    // lookups before any DOM write. Dyn-point values are volatile raw BAS values and a
    // cross-equipment average is not meaningful. Footer shows '—' for these columns.
    if (def.isDynPoint) continue;
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

/* ── emComputeAuditFooterTotals ─────────────────────────────────────────────
   Computes footer totals for the Audit view.
   _baspoints: sum of BAS point counts across all rows.
   _coverage:  average coverage % across rows that have a recognized point
               category (mirrors the avgCoverage logic in emComputeAuditStats).
   _cat_<key>: count of rows where that point category is "present" (covered,
               tier 1/2 = exact match, tier 3+ = fuzzy match). N/A rows are
               excluded from the count (not applicable to equip type).
   _seq_<key>: count of rows where the sequence is 'ready' or 'partial'
               (i.e. at least one required point present). N/A rows excluded.
   defs: optional array of column defs — if provided, _cat_ and _seq_ counts
         are computed. If omitted, only _baspoints and _coverage are returned.
   Returns: { _baspoints, _coverage, [_cat_*]: { present, applicable },
                                     [_seq_*]: { present, applicable } }      */
function emComputeAuditFooterTotals(rows, defs) {
  var ptSum = 0;
  var covSum = 0;
  var covCount = 0;
  var _footerMaps = emLoadCustomMappings(window._emActivePid || '');

  // Collect cat and seq defs we need to count
  var catDefs = [];
  var seqDefs = [];
  if (defs) {
    for (var di = 0; di < defs.length; di++) {
      if (defs[di].isAuditCat) catDefs.push(defs[di]);
      else if (defs[di].isAuditSeq) seqDefs.push(defs[di]);
    }
  }

  // Accumulators: present count and applicable count per column key
  var catCounts = {}; // key -> { present: 0, applicable: 0 }
  var seqCounts = {}; // key -> { present: 0, applicable: 0 }
  for (var ci = 0; ci < catDefs.length; ci++) {
    catCounts[catDefs[ci].key] = { present: 0, applicable: 0 };
  }
  for (var si = 0; si < seqDefs.length; si++) {
    seqCounts[seqDefs[si].key] = { present: 0, applicable: 0 };
  }

  for (var ri = 0; ri < rows.length; ri++) {
    var r = rows[ri];
    ptSum += Object.keys(r.points || {}).length;
    var comp = null;
    if (r.category && EM_POINT_CATEGORIES[r.category]) {
      comp = emComputeCompliance(r, {}, _footerMaps);
      covSum += comp.coveragePct;
      covCount++;
    }

    // Count per-cat column presence
    if (catDefs.length) {
      if (!comp && r.category && EM_POINT_CATEGORIES[r.category]) {
        comp = emComputeCompliance(r, {}, _footerMaps);
      }
      for (var cdi = 0; cdi < catDefs.length; cdi++) {
        var cd = catDefs[cdi];
        var colKey = cd.key; // e.g. "_cat_sat"
        var catKey = cd.catKey;
        // N/A if equip type doesn't match this column
        if (!r.category || cd.catEquipTypes.indexOf(r.category) === -1) continue;
        catCounts[colKey].applicable++;
        if (comp) {
          // Present if coveredPoints contains this catKey
          for (var pi = 0; pi < comp.coveredPoints.length; pi++) {
            if (comp.coveredPoints[pi].categoryKey === catKey) {
              catCounts[colKey].present++;
              break;
            }
          }
        }
      }
    }

    // Count per-seq column presence
    if (seqDefs.length) {
      if (!comp) comp = emComputeCompliance(r, {}, _footerMaps);
      var seqReadiness = emComputeSequenceReadiness(r, comp);
      for (var sdi = 0; sdi < seqDefs.length; sdi++) {
        var sd = seqDefs[sdi];
        var sColKey = sd.key; // e.g. "_seq_sat_reset"
        var seqKey = sd.seqKey;
        // N/A if equip type doesn't match this sequence
        if (!r.category || sd.seqEquipTypes.indexOf(r.category) === -1) continue;
        var seqEntry = seqReadiness && seqReadiness[seqKey];
        // Skip sequences resolved to 'na' (e.g. applicableIfCovered not met, configFlag false)
        // so they don't inflate the applicable denominator in the footer row.
        if (seqEntry && seqEntry.status === 'na') continue;
        seqCounts[sColKey].applicable++;
        if (seqEntry && (seqEntry.status === 'ready' || seqEntry.status === 'partial')) {
          seqCounts[sColKey].present++;
        }
      }
    }
  }

  var result = {
    _baspoints: { sum: ptSum, count: rows.length },
    _coverage: covCount > 0 ? { avg: Math.round(covSum / covCount), count: covCount } : null,
  };

  // Merge cat/seq counts into result
  for (var ck in catCounts) {
    if (catCounts.hasOwnProperty(ck)) result[ck] = catCounts[ck];
  }
  for (var sk in seqCounts) {
    if (seqCounts.hasOwnProperty(sk)) result[sk] = seqCounts[sk];
  }

  return result;
}

/* ── buildAuditFooterRow ────────────────────────────────────────────────────
   Builds a <tr> HTML string for an Audit view footer totals row.
   totalsMap: output of emComputeAuditFooterTotals.
   defs: column defs array.
   label: text for the first (sticky) cell.
   isBold: true → bold style (Total), false → italic style (Page Total).     */
function buildAuditFooterRow(totalsMap, defs, label, isBold) {
  var tdBase = 'padding:8px 12px;vertical-align:middle;border-top:2px solid var(--border);background:var(--s1);';
  var html = '<tr style="background:var(--s1);">';
  for (var di = 0; di < defs.length; di++) {
    var def = defs[di];
    if (di === 0) {
      var labelStyle = tdBase + (isBold ? 'font-weight:700;color:var(--text)' : 'font-style:italic;color:var(--text2)');
      html += '<td style="' + labelStyle + '">' + label + '</td>';
      continue;
    }
    if (def.isAuditBasPts && totalsMap['_baspoints'] && totalsMap['_baspoints'].count > 0) {
      html +=
        '<td style="' +
        tdBase +
        'text-align:right;font-weight:' +
        (isBold ? '700' : '500') +
        '">' +
        totalsMap['_baspoints'].sum +
        '</td>';
    } else if (def.isAuditCoverage && totalsMap['_coverage']) {
      var cov = totalsMap['_coverage'].avg;
      var covColor = cov >= 75 ? '#27ae60' : cov >= 50 ? '#e67e22' : '#c0392b';
      html +=
        '<td style="' +
        tdBase +
        'text-align:right;font-weight:' +
        (isBold ? '700' : '500') +
        ';color:' +
        covColor +
        '">' +
        cov +
        '%</td>';
    } else if ((def.isAuditCat || def.isAuditSeq) && totalsMap[def.key] !== undefined) {
      var colTot = totalsMap[def.key];
      var presentCount = colTot.present;
      var applicableCount = colTot.applicable;
      if (applicableCount === 0) {
        // No rows where this column applies — show dash
        html += '<td style="' + tdBase + 'text-align:center;color:var(--text3)">&#8212;</td>';
      } else {
        html +=
          '<td style="' +
          tdBase +
          'text-align:right;font-weight:' +
          (isBold ? '700' : '500') +
          ';color:var(--text2)" title="' +
          presentCount +
          ' of ' +
          applicableCount +
          ' applicable units have this point/sequence present">' +
          presentCount +
          '</td>';
      }
    } else {
      html += '<td style="' + tdBase + 'text-align:center;color:var(--text3)">&#8212;</td>';
    }
  }
  html += '</tr>';
  return html;
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
  var tdBase = 'padding:8px 12px;vertical-align:middle;border-top:2px solid var(--border);background:var(--s1);';
  var html = '<tr style="' + rowStyle + '">';
  // Always emit a placeholder for the expand-toggle column (always present in Raw view)
  html += '<td style="' + tdBase + 'width:28px;min-width:28px;"></td>';
  if (hasEditCol) {
    html += '<td style="' + tdBase + '"></td>';
  }
  for (var di = 0; di < defs.length; di++) {
    var def = defs[di];
    // First column (building) gets the label text
    if (di === 0) {
      var labelStyle = tdBase + (isBold ? 'font-weight:700;color:var(--text)' : 'font-style:italic;color:var(--text2)');
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
  // Skip keys that are already covered by a mapped live column (e.g. 'supplyAirTemp') or
  // any standard def key — only raw BACnet point names become dynamic columns.
  // PERFORMANCE LIMIT: With thousands of BAS points, showing every unique point name
  // as a column creates hundreds/thousands of columns × 100 rows = tens of thousands of
  // cells, causing the browser to freeze. Default: show only the top 20 most common
  // point names. Use the "Show All Columns" toggle to override.
  var existingDefKeys = {};
  for (var ex = 0; ex < defs.length; ex++) existingDefKeys[defs[ex].key] = true;
  // Also skip the EM_POINT_MAP col names (supplyAirTemp, returnAirTemp, etc.)
  for (var pm = 0; pm < EM_POINT_MAP.length; pm++) existingDefKeys[EM_POINT_MAP[pm].col] = true;

  // M4 Part 3: Count frequency of each raw point name across FILTERED rows only.
  // When a building filter is active, only columns present in that building appear.
  // (Audit view emGetAuditColDefs already scopes to filtered rows — mirrors that behavior here.)
  //
  // Quick Win 3: Cache the frequency scan so re-renders with the same filter/row-count
  // reuse the result instead of re-scanning ~162k iterations every time.
  // Cache key encodes pid + building filter + type filter + row count so it auto-invalidates
  // when any of those change. emSaveMatrix() also explicitly clears it on data write.
  var _dynCacheKey =
    (window._emActivePid || '') + '|' + (filters.building || '') + '|' + (filters.type || '') + '|' + filtered.length;
  var dynPointFreq;
  var allDynKeys;
  if (_emDynPointFreqCacheKey === _dynCacheKey && _emDynPointFreqCache) {
    // Cache hit — reuse previous scan result
    dynPointFreq = _emDynPointFreqCache.freq;
    allDynKeys = _emDynPointFreqCache.keys.slice(); // shallow copy so sort doesn't mutate cache
  } else {
    // Cache miss — run the scan and store
    dynPointFreq = {};
    for (var rr = 0; rr < filtered.length; rr++) {
      var pts = filtered[rr].points || {};
      for (var ptKey in pts) {
        if (!existingDefKeys[ptKey]) {
          dynPointFreq[ptKey] = (dynPointFreq[ptKey] || 0) + 1;
        }
      }
    }
    allDynKeys = Object.keys(dynPointFreq);
    // Sort by frequency descending, then alphabetically for ties
    allDynKeys.sort(function (a, b) {
      var diff = dynPointFreq[b] - dynPointFreq[a];
      if (diff !== 0) return diff;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    _emDynPointFreqCache = { freq: dynPointFreq, keys: allDynKeys.slice() };
    _emDynPointFreqCacheKey = _dynCacheKey;
  }

  var totalUniqueDynCols = allDynKeys.length;

  // Apply column limit unless user toggled "Show All".
  // NOTE: No hard cell-budget cap here — user requirement is to show ALL columns.
  // Responsiveness is achieved via chunked async render below, not by hiding columns.
  var dynColsToShow = _emShowAllDynCols ? allDynKeys : allDynKeys.slice(0, EM_DYN_COL_LIMIT);

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
  } else {
    // Default sort: building alpha → HVAC type priority → equipment name alpha
    filtered = filtered.slice().sort(function (a, b) {
      var ab = (a.building || '').toLowerCase();
      var bb = (b.building || '').toLowerCase();
      if (ab < bb) return -1;
      if (ab > bb) return 1;
      var ap = _emTypePriority[a.category] !== undefined ? _emTypePriority[a.category] : 22;
      var bp = _emTypePriority[b.category] !== undefined ? _emTypePriority[b.category] : 22;
      if (ap !== bp) return ap - bp;
      var ae = (a.equipName || '').toLowerCase();
      var be = (b.equipName || '').toLowerCase();
      return ae < be ? -1 : ae > be ? 1 : 0;
    });
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
  // M4 Part 2: expand-toggle column (leftmost, always visible in raw view)
  theadCells +=
    '<th style="position:sticky;top:0;background:var(--s2);border-top:3px solid transparent;' +
    'font-weight:600;color:var(--text2);white-space:nowrap;' +
    'width:28px;text-align:center;border-bottom:1px solid var(--border);border-right:1px solid var(--border)"></th>';
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
    var colW = _emColWidths[ci] !== undefined ? _emColWidths[ci] : d.width;
    theadCells +=
      '<th data-ci="' +
      ci +
      '" ' +
      'style="position:sticky;top:0;background:var(--s2);' +
      borderTop +
      'font-weight:600;color:var(--text2);white-space:nowrap;' +
      'min-width:' +
      colW +
      'px;width:' +
      colW +
      'px;text-align:left;' +
      'border-bottom:1px solid var(--border);border-right:1px solid var(--border)">' +
      '<span style="cursor:pointer;" onclick="emHandleSort(' +
      ci +
      ')">' +
      d.label +
      sortInd +
      '</span>' +
      '<div class="em-col-resize-handle" data-ci="' +
      ci +
      '"></div>' +
      '</th>';
  }

  // M4 Part 2: total column count for drawer colspan
  // = expand col (1) + edit col (0 or 1) + defs.length
  var _emTotalColCount = 1 + (_emEditMode ? 1 : 0) + defs.length;

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

  // ── Quick Win 3: Chunked async render ────────────────────────────────────
  // Determine if the table is "large" (many cols × rows likely to block the main
  // thread for >100 ms). Threshold: more than 5,000 projected cells.
  var _projectedCells = pageRows.length * defs.length;
  var _useChunked = _projectedCells > 5000;

  // Increment render generation so any in-flight async render from a previous call
  // can self-cancel when it wakes up and sees a stale generation number.
  _emRenderGen++;
  var _thisGen = _emRenderGen;

  // Helper: build HTML string for one table row (closes over outer-scope state).
  function _buildOneRowHtml(row) {
    var rowId = row.id;
    var isDrawerOpen = _emOpenDrawers.has(rowId);
    var cells = '';
    // M4 Part 2: expand-toggle cell
    var safeRowId = String(rowId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    cells +=
      '<td style="padding:2px 4px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);' +
      'vertical-align:middle;text-align:center;width:28px">' +
      '<button onclick="emTogglePointDrawer(\'' +
      safeRowId +
      '\')" ' +
      'title="' +
      (isDrawerOpen ? 'Collapse point list' : 'Expand all points') +
      '" ' +
      'style="font-size:11px;padding:0 4px;background:none;border:none;cursor:pointer;color:var(--text2);' +
      'line-height:1;display:inline-block;transform:' +
      (isDrawerOpen ? 'rotate(90deg)' : 'none') +
      '">' +
      '&#9654;</button>' +
      '</td>';
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
    var rowHtml = '<tr>' + cells + '</tr>';
    // M4 Part 2: inline "All Points" drawer row (inserted right after equipment row)
    if (isDrawerOpen) {
      rowHtml += '<tr><td colspan="' + _emTotalColCount + '" style="padding:0;border-bottom:2px solid var(--accent)">';
      rowHtml += '<div style="padding:10px 16px;background:var(--s1);font-size:12px">';
      if (row.schema >= 2 && row.pointsRaw && Object.keys(row.pointsRaw).length > 0) {
        var _drRawKeys = Object.keys(row.pointsRaw)
          .slice()
          .sort(function (a, b) {
            return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
          });
        rowHtml +=
          '<div style="font-weight:600;color:var(--text2);margin-bottom:6px">All BAS Points (' +
          _drRawKeys.length +
          ' captured)</div>';
        rowHtml += '<table style="border-collapse:collapse;font-size:11px;font-family:Consolas,monospace;width:auto">';
        rowHtml +=
          '<thead><tr>' +
          '<th style="padding:3px 10px 3px 0;border-bottom:1px solid var(--border);color:var(--text2);font-weight:600;white-space:nowrap">Point Name</th>' +
          '<th style="padding:3px 10px 3px 10px;border-bottom:1px solid var(--border);color:var(--text2);font-weight:600;white-space:nowrap">Value</th>' +
          '<th style="padding:3px 0 3px 10px;border-bottom:1px solid var(--border);color:var(--text2);font-weight:600;white-space:nowrap">Mapped Column</th>' +
          '</tr></thead><tbody>';
        var _drColCount = {};
        for (var _dci = 0; _dci < _drRawKeys.length; _dci++) {
          var _dcMapped = emMapPointToColumn(_drRawKeys[_dci], null, row.category);
          if (_dcMapped) _drColCount[_dcMapped] = (_drColCount[_dcMapped] || 0) + 1;
        }
        for (var _dri = 0; _dri < _drRawKeys.length; _dri++) {
          var _drKey = _drRawKeys[_dri];
          var _drVal = row.pointsRaw[_drKey];
          var _drMapped = emMapPointToColumn(_drKey, null, row.category);
          var _drHasCollision = _drMapped && (_drColCount[_drMapped] || 0) > 1;
          var _drBadge = _drMapped
            ? '<span style="background:var(--accent);color:#fff;border-radius:3px;padding:1px 5px;font-size:10px"' +
              (_drHasCollision
                ? ' title="' +
                  _drColCount[_drMapped] +
                  ' points map to this column — only one value is shown in the Audit view"'
                : '') +
              '>' +
              emHtmlEsc(_drMapped) +
              '</span>' +
              (_drHasCollision
                ? '<span style="color:#f59e0b;margin-left:4px;cursor:default" title="Collision: ' +
                  _drColCount[_drMapped] +
                  ' points map here">&#x26A0;</span>'
                : '')
            : '<span style="color:var(--text3)">—</span>';
          var _drValDisplay =
            _drVal === '' ? '<span style="color:var(--text3)">empty</span>' : emHtmlEsc(String(_drVal));
          rowHtml +=
            '<tr>' +
            '<td style="padding:2px 10px 2px 0;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--text)">' +
            emHtmlEsc(_drKey) +
            '</td>' +
            '<td style="padding:2px 10px;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--text2)">' +
            _drValDisplay +
            '</td>' +
            '<td style="padding:2px 0 2px 10px;border-bottom:1px solid var(--border)">' +
            _drBadge +
            '</td>' +
            '</tr>';
        }
        rowHtml += '</tbody></table>';
      } else if (row.points && Object.keys(row.points).length > 0) {
        rowHtml +=
          '<div style="color:var(--text2);margin-bottom:8px"><em>Full point list available after re-importing this CSV.</em></div>';
        var _legPts = row.points;
        var _legKeys = Object.keys(_legPts).slice().sort();
        rowHtml += '<table style="border-collapse:collapse;font-size:11px;font-family:Consolas,monospace;width:auto">';
        rowHtml +=
          '<thead><tr>' +
          '<th style="padding:3px 10px 3px 0;border-bottom:1px solid var(--border);color:var(--text2);font-weight:600;white-space:nowrap">Point / Column</th>' +
          '<th style="padding:3px 0 3px 10px;border-bottom:1px solid var(--border);color:var(--text2);font-weight:600;white-space:nowrap">Value</th>' +
          '</tr></thead><tbody>';
        for (var _lki = 0; _lki < _legKeys.length; _lki++) {
          var _lk = _legKeys[_lki];
          var _lv = _legPts[_lk];
          if (_lv == null) continue;
          rowHtml +=
            '<tr>' +
            '<td style="padding:2px 10px 2px 0;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--text)">' +
            emHtmlEsc(_lk) +
            '</td>' +
            '<td style="padding:2px 0 2px 10px;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--text2)">' +
            emHtmlEsc(String(_lv)) +
            '</td>' +
            '</tr>';
        }
        rowHtml += '</tbody></table>';
      } else {
        rowHtml += '<span style="color:var(--text3)">No point data available for this equipment.</span>';
      }
      rowHtml += '</div></td></tr>';
    }
    return rowHtml;
  }

  // Helper: finalize the table after all rows are in the DOM.
  function _finalizeTable(tbody, wrapEl) {
    // Remove loading indicator if present
    var loadingRow = tbody.querySelector('tr[data-em-loading]');
    if (loadingRow) tbody.removeChild(loadingRow);

    // Empty-state row
    if (pageRows.length === 0) {
      var emptyMsg =
        rows.length === 0 ? 'No equipment data — click Import CSVs to begin' : 'No rows match the current filters.';
      var emptyTr = document.createElement('tr');
      emptyTr.innerHTML =
        '<td colspan="' +
        _emTotalColCount +
        '" style="padding:48px 32px;text-align:center;font-size:14px;color:var(--text2)">' +
        emptyMsg +
        '</td>';
      tbody.appendChild(emptyTr);
    }

    // Footer average rows (dyn-point cols skipped inside emComputeFooterAvg)
    var pageAvg = emComputeFooterAvg(pageRows, defs);
    var totalAvg = emComputeFooterAvg(filtered, defs);
    var tfootHtml =
      '<tfoot>' +
      buildAvgFooterRow(pageAvg, defs, 'Page Average', false, !!_emEditMode) +
      buildAvgFooterRow(totalAvg, defs, 'Total Average', true, !!_emEditMode) +
      '</tfoot>';
    var existingTfoot = wrapEl.querySelector('tfoot');
    if (existingTfoot) existingTfoot.parentNode.removeChild(existingTfoot);
    var table = wrapEl.querySelector('table');
    if (table) {
      // Use a <table> as the temp container so <tfoot> parses correctly.
      // A <tbody> container strips/misplaces <tfoot> children.
      var tfootProxy = document.createElement('table');
      tfootProxy.innerHTML = tfootHtml;
      var parsedTfoot = tfootProxy.querySelector('tfoot');
      if (parsedTfoot) table.appendChild(parsedTfoot);
    }

    // Inject pagination bar after the scroll container
    var existingPag = wrapEl.parentNode ? wrapEl.parentNode.querySelector('.em-pagination') : null;
    if (existingPag) existingPag.parentNode.removeChild(existingPag);
    var pagDiv = document.createElement('div');
    pagDiv.innerHTML = paginationHtml;
    if (wrapEl.parentNode) {
      wrapEl.parentNode.insertBefore(pagDiv.firstChild, wrapEl.nextSibling);
    }

    // Sticky offsets + resize handlers now that all columns are in the DOM
    emUpdateStickyOffsets();
    emAttachColResizeHandler(wrapEl);
  }

  // Write header skeleton immediately — the thead is cheap and makes the table
  // "appear" to the user right away, even before body rows are rendered.
  wrap.innerHTML =
    '<table style="border-collapse:separate;border-spacing:0;table-layout:auto">' +
    '<thead><tr>' +
    theadCells +
    '</tr></thead>' +
    '<tbody id="em-tbody-live"></tbody>' +
    '</table>';

  var tbody = wrap.querySelector('#em-tbody-live');

  if (!_useChunked) {
    // ── Small table: synchronous render (unchanged behavior for ≤100 rows default) ──
    var tbodyRows = '';
    for (var ri = 0; ri < pageRows.length; ri++) {
      tbodyRows += _buildOneRowHtml(pageRows[ri]);
    }
    if (pageRows.length === 0) {
      var emptyMsg2 =
        rows.length === 0 ? 'No equipment data — click Import CSVs to begin' : 'No rows match the current filters.';
      tbodyRows =
        '<tr><td colspan="' +
        _emTotalColCount +
        '" style="padding:48px 32px;text-align:center;font-size:14px;color:var(--text2)">' +
        emptyMsg2 +
        '</td></tr>';
    }
    tbody.innerHTML = tbodyRows;
    _finalizeTable(tbody, wrap);
  } else {
    // ── Large table: chunked async render ───────────────────────────────────
    // Show a loading indicator row immediately so the user sees feedback.
    var loadTr = document.createElement('tr');
    loadTr.setAttribute('data-em-loading', '1');
    loadTr.innerHTML =
      '<td colspan="' +
      _emTotalColCount +
      '" style="padding:24px 32px;text-align:center;font-size:13px;color:var(--text2);background:var(--s1)">' +
      '<span style="display:inline-block;margin-right:8px;animation:em-spin 1s linear infinite;' +
      'border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;width:16px;height:16px;vertical-align:middle"></span>' +
      'Loading ' +
      pageRows.length +
      ' rows × ' +
      defs.length +
      ' columns…' +
      '</td>';
    tbody.appendChild(loadTr);

    // Inject a tiny keyframes rule for the spinner (idempotent check)
    if (!document.getElementById('em-spin-style')) {
      var spinStyle = document.createElement('style');
      spinStyle.id = 'em-spin-style';
      spinStyle.textContent = '@keyframes em-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(spinStyle);
    }

    // Chunk size: aim for ~50 ms per batch. With many dyn cols a single row can be
    // expensive, so keep chunks small. 20 rows per chunk is a safe default.
    var CHUNK_SIZE = 20;
    var chunkStart = 0;

    function renderNextChunk() {
      // Stale-render guard: if a new emRenderTable() was called since we started,
      // this async chain is obsolete — bail out silently.
      if (_emRenderGen !== _thisGen) return;

      // Re-acquire tbody in case innerHTML= was re-issued by another call
      var liveWrap = document.getElementById('em-table-wrap');
      if (!liveWrap) return;
      var liveTbody = liveWrap.querySelector('#em-tbody-live');
      if (!liveTbody) return;

      var chunkEnd = Math.min(chunkStart + CHUNK_SIZE, pageRows.length);
      var chunkHtml = '';
      for (var ci2 = chunkStart; ci2 < chunkEnd; ci2++) {
        chunkHtml += _buildOneRowHtml(pageRows[ci2]);
      }

      // Remove the loading row before inserting the first real chunk
      if (chunkStart === 0) {
        var lr = liveTbody.querySelector('tr[data-em-loading]');
        if (lr) liveTbody.removeChild(lr);
      }

      // Append chunk via insertAdjacentHTML for efficiency
      liveTbody.insertAdjacentHTML('beforeend', chunkHtml);
      chunkStart = chunkEnd;

      if (chunkStart < pageRows.length) {
        // Yield to the browser so it can paint and handle input events, then continue
        setTimeout(renderNextChunk, 0);
      } else {
        // All rows rendered — finalize
        _finalizeTable(liveTbody, liveWrap);
      }
    }

    // Kick off the first chunk after a tick so the loading indicator paints first
    setTimeout(renderNextChunk, 0);
  }
}

/* ── emComputeBuildingZoneStats ─────────────────────────────────────────────
   Aggregates zone air temp, heating setpoint, cooling setpoint, CO2, and
   relative humidity, plus hot/ok/cold counts per building.
   Only processes VAV, FPB, and DD-VAV rows.
   Returns: { [buildingName]: { zoneTemp, htgSp, coolSp, zoneCO2,
             zoneRelativeHumidity, hot, ok, cold, totalZones } }
   where each stat field is { sum, count, avg }.                          */
function emComputeBuildingZoneStats(rows, seedRows) {
  // Fix 8c7dcc71 (A): seedRows is optional. When provided (from emRenderSummaryView),
  // the first-pass building-seeding uses seedRows (ALL rows, unfiltered) so that
  // AHU-only / plant-only buildings appear in the Summary even when a type filter
  // has narrowed `rows` to only zone-category rows.
  var _seed = seedRows || rows;
  var result = {};
  var zoneCategories = { vav: true, fpb: true, ddvav: true, fcu: true };

  // First pass: seed every building with a blank stat entry so that AHU-only /
  // plant-only buildings always appear in the Summary view (Fix 8c7dcc71).
  // Also accumulate _seedByBuilding so the campus-wide filter below can inspect
  // every row that belongs to each building key.
  var _seedByBuilding = {};
  for (var si = 0; si < _seed.length; si++) {
    var sbldg = _seed[si].building || '(No Building)';
    if (!result[sbldg]) {
      result[sbldg] = {
        zoneTemp: { sum: 0, count: 0, avg: 0 },
        htgSp: { sum: 0, count: 0, avg: 0 },
        coolSp: { sum: 0, count: 0, avg: 0 },
        zoneCO2: { sum: 0, count: 0, avg: 0 },
        zoneRelativeHumidity: { sum: 0, count: 0, avg: 0 },
        hot: 0,
        ok: 0,
        cold: 0,
        totalZones: 0,
      };
    }
    if (!_seedByBuilding[sbldg]) _seedByBuilding[sbldg] = [];
    _seedByBuilding[sbldg].push(_seed[si]);
  }

  // Campus-wide exclusion (Fix da562f20): remove any seeded building whose ENTIRE
  // equipment set consists of campus-wide informational points (weather sensors,
  // AccuWeather/NWS virtual points, or bare 'sensor'-category rows).
  // These are not real buildings — they are site-level data feeds with no
  // addressable zone or mechanical equipment.
  //
  // SAFEGUARD (preserves Fix 8c7dcc71): a building is only removed when EVERY one
  // of its seed rows is campus-wide. A single non-campus-wide row (AHU, VAV, plant,
  // FCU, DDV, etc.) is enough to keep the building in the Summary list.
  //
  // isCampusWide predicate:
  //   category === 'sensor'                             → bare sensor/weather point
  //   category === 'other' AND equipName starts with
  //     "weather", "accuweather", or "nws" (case-insensitive) → named weather feed
  var _weatherEquipRe = /^(weather|accuweather|nws)/i;
  function _isCampusWide(row) {
    if (row.category === 'sensor') return true;
    if (row.category === 'other' && _weatherEquipRe.test(row.equipName || '')) return true;
    return false;
  }
  var _seedBldgKeys = Object.keys(_seedByBuilding);
  for (var ci = 0; ci < _seedBldgKeys.length; ci++) {
    var _ck = _seedBldgKeys[ci];
    var _crows = _seedByBuilding[_ck];
    if (_crows.length === 0) continue; // no rows at all → leave as-is
    var _allCampusWide = true;
    for (var cj = 0; cj < _crows.length; cj++) {
      if (!_isCampusWide(_crows[cj])) {
        _allCampusWide = false;
        break;
      }
    }
    if (_allCampusWide) {
      delete result[_ck];
    }
  }

  // Single-zone AHU gate (Quick Win 2): an 'ahu' row qualifies as a single-zone unit
  // (and therefore contributes to zone stats) if its normalized points include zone-level
  // setpoints (cooling OR heating occupied setpoint) OR a zone air temperature sensor.
  // True multizone AHUs have neither — they only have supply air temp + duct static —
  // and must be excluded so their blended return-air is not mistaken for a single space.
  // This function is only called for rows with category === 'ahu'.
  function _isSingleZoneAhu(ahuRow) {
    var _p = emGetNormalizedPoints(ahuRow);
    return (
      (_p['zoneCoolSetpoint'] !== undefined && _p['zoneCoolSetpoint'] !== '') ||
      (_p['zoneHtgSetpoint'] !== undefined && _p['zoneHtgSetpoint'] !== '') ||
      (_p['zoneAirTemp'] !== undefined && _p['zoneAirTemp'] !== '')
    );
  }

  // Second pass: fill in zone stats for rows that belong to zone-category equipment.
  // Also includes single-zone AHUs (RTUs, split systems, FCU-style AHUs) per the gate above.
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var _rowIsSingleZoneAhu = false;
    if (!zoneCategories[row.category]) {
      // Not a traditional zone category — check if it is a single-zone AHU.
      if (row.category !== 'ahu') continue;
      _rowIsSingleZoneAhu = _isSingleZoneAhu(row);
      if (!_rowIsSingleZoneAhu) continue; // true multizone AHU — skip
    }

    var bldg = row.building || '(No Building)';
    // Entry already exists from first pass; no need to create.
    // Fix 58cf0031: route through normalized-point engine so raw BAS names are resolved.
    var pts = emGetNormalizedPoints(row);

    // Return-air fallback (Quick Win 2): on a single-zone unit the return air IS the space air.
    // When a dedicated zone sensor is absent, promote return-air values to zone columns so the
    // unit contributes to zone stats.  GUARDRAIL: only applied to single-zone AHUs — never to
    // traditional zone categories (VAV, FPB, etc.) or true multizone AHUs.
    if (_rowIsSingleZoneAhu) {
      if (
        (pts['zoneAirTemp'] === undefined || pts['zoneAirTemp'] === '') &&
        pts['returnAirTemp'] !== undefined &&
        pts['returnAirTemp'] !== ''
      ) {
        pts = Object.assign({}, pts);
        pts['zoneAirTemp'] = pts['returnAirTemp'];
      }
      if (
        (pts['zoneCO2'] === undefined || pts['zoneCO2'] === '') &&
        pts['returnAirCO2'] !== undefined &&
        pts['returnAirCO2'] !== ''
      ) {
        pts = Object.assign({}, pts);
        pts['zoneCO2'] = pts['returnAirCO2'];
      }
      if (
        (pts['zoneRelativeHumidity'] === undefined || pts['zoneRelativeHumidity'] === '') &&
        pts['returnAirHumidity'] !== undefined &&
        pts['returnAirHumidity'] !== ''
      ) {
        pts = Object.assign({}, pts);
        pts['zoneRelativeHumidity'] = pts['returnAirHumidity'];
      }
    }

    var bldgStats = result[bldg];
    bldgStats.totalZones++;

    var tempRaw = pts['zoneAirTemp'];
    var htgRaw = pts['zoneHtgSetpoint'];
    var coolRaw = pts['zoneCoolSetpoint'];
    var co2Raw = pts['zoneCO2'];
    var rhRaw = pts['zoneRelativeHumidity'];

    var tempVal = tempRaw !== undefined && tempRaw !== '' ? parseFloat(tempRaw) : NaN;
    var htgVal = htgRaw !== undefined && htgRaw !== '' ? parseFloat(htgRaw) : NaN;
    var coolVal = coolRaw !== undefined && coolRaw !== '' ? parseFloat(coolRaw) : NaN;
    var co2Val = co2Raw !== undefined && co2Raw !== '' ? parseFloat(co2Raw) : NaN;
    var rhVal = rhRaw !== undefined && rhRaw !== '' ? parseFloat(rhRaw) : NaN;

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
    if (!isNaN(co2Val)) {
      bldgStats.zoneCO2.sum += co2Val;
      bldgStats.zoneCO2.count += 1;
    }
    if (!isNaN(rhVal)) {
      bldgStats.zoneRelativeHumidity.sum += rhVal;
      bldgStats.zoneRelativeHumidity.count += 1;
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
    s.zoneCO2.avg = s.zoneCO2.count > 0 ? s.zoneCO2.sum / s.zoneCO2.count : NaN;
    s.zoneRelativeHumidity.avg =
      s.zoneRelativeHumidity.count > 0 ? s.zoneRelativeHumidity.sum / s.zoneRelativeHumidity.count : NaN;
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
  // Fix 8c7dcc71 (B): Suppress the building filter in Summary mode.
  // Summary purpose is cross-building comparison -- applying the building filter would
  // collapse the table to a single building row, defeating the view's purpose.
  // Use a LOCAL copy (summaryFilters) so the global `filters` object is never mutated
  // and other views (Audit / Raw) continue to honor the building filter normally.
  var summaryFilters = Object.assign({}, filters, { building: '' });
  var filtered = emFilterRows(rows, summaryFilters);

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

  // ── Drill-down routing ──
  if (_emDrillBuilding !== null) {
    emRenderBuildingDetailView(data, filters, _emDrillBuilding);
    return;
  }

  // ── Build zone stats from filtered rows (VAV + FPB + DD-VAV only) ──
  // Fix 8c7dcc71 (A): pass `rows` (ALL unfiltered rows) as seedRows so that
  // AHU-only / plant-only buildings are always seeded into zoneStats even when
  // the type filter has removed them from `filtered`.
  var zoneStats = emComputeBuildingZoneStats(filtered, rows);
  var bldgNames = Object.keys(zoneStats); // already sorted alphabetically

  // Also compute total-average stats from ALL rows (unfiltered) -- unchanged
  var totalZoneStats = emComputeBuildingZoneStats(rows);

  // Helper: format a numeric avg to 1 decimal + unit.
  // Fix 8c7dcc71 (C): 3-way distinction:
  //   totalZones === 0  -> "N/A" (gray italic) -- building has no zone equipment at all
  //   totalZones > 0 but count === 0 or NaN -> "--" -- has zones but no data in import
  //   actual value (incl. 0) -> show the value; 0 is VALID data, never hidden
  function fmtAvg(statObj, unit, totalZones) {
    if (totalZones === 0) return '<span style="color:var(--text3);font-style:italic">N/A</span>';
    if (!statObj || statObj.count === 0 || isNaN(statObj.avg)) return '<span style="color:var(--text3)">&#8212;</span>';
    return (Math.round(statObj.avg * 10) / 10).toFixed(1) + (unit || '');
  }

  // Helper: aggregate stats across all buildings in a stats map
  function aggregateZoneStats(statsMap) {
    var agg = {
      zoneTemp: { sum: 0, count: 0, avg: 0 },
      htgSp: { sum: 0, count: 0, avg: 0 },
      coolSp: { sum: 0, count: 0, avg: 0 },
      zoneCO2: { sum: 0, count: 0, avg: 0 },
      zoneRelativeHumidity: { sum: 0, count: 0, avg: 0 },
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
      agg.zoneCO2.sum += s.zoneCO2.sum;
      agg.zoneCO2.count += s.zoneCO2.count;
      agg.zoneRelativeHumidity.sum += s.zoneRelativeHumidity.sum;
      agg.zoneRelativeHumidity.count += s.zoneRelativeHumidity.count;
      agg.hot += s.hot;
      agg.ok += s.ok;
      agg.cold += s.cold;
    }
    agg.zoneTemp.avg = agg.zoneTemp.count > 0 ? agg.zoneTemp.sum / agg.zoneTemp.count : NaN;
    agg.htgSp.avg = agg.htgSp.count > 0 ? agg.htgSp.sum / agg.htgSp.count : NaN;
    agg.coolSp.avg = agg.coolSp.count > 0 ? agg.coolSp.sum / agg.coolSp.count : NaN;
    agg.zoneCO2.avg = agg.zoneCO2.count > 0 ? agg.zoneCO2.sum / agg.zoneCO2.count : NaN;
    agg.zoneRelativeHumidity.avg =
      agg.zoneRelativeHumidity.count > 0 ? agg.zoneRelativeHumidity.sum / agg.zoneRelativeHumidity.count : NaN;
    return agg;
  }

  var pid = window._emActivePid || '';
  var thStyle =
    'padding:12px 16px;font-weight:600;background:var(--s1);' +
    'border-bottom:2px solid var(--border);color:var(--text2);white-space:nowrap;' +
    'position:sticky;top:0;z-index:2;';
  var thStyleCenter = thStyle + 'text-align:center;';
  var thStyleLeft = thStyle + 'text-align:left;';

  // ── Stale-data callout detection: key on EMPTY-POINTS (not displayed dashes) ──
  // Show callout only when: (i) every building's zoneTemp.count === 0
  // AND (ii) at least one VAV/FPB/DD-VAV row has both points and pointsRaw empty/absent.
  // This is intentionally decoupled from emFormatCell '?' display (Step 3).
  var _zoneCalloutCats = { vav: true, fpb: true, ddvav: true };
  var _allZeroTemp = true;
  var _bldgNamesForCallout = Object.keys(zoneStats);
  for (var _ci = 0; _ci < _bldgNamesForCallout.length; _ci++) {
    if (zoneStats[_bldgNamesForCallout[_ci]].zoneTemp.count > 0) {
      _allZeroTemp = false;
      break;
    }
  }
  var _hasEmptyZoneRow = false;
  if (_allZeroTemp && _bldgNamesForCallout.length > 0) {
    for (var _cj = 0; _cj < filtered.length; _cj++) {
      var _cr = filtered[_cj];
      if (!_zoneCalloutCats[_cr.category]) continue;
      var _ptCount = Object.keys(_cr.points || {}).length;
      var _rawCount = Object.keys(_cr.pointsRaw || {}).length;
      if (_ptCount === 0 && _rawCount === 0) {
        _hasEmptyZoneRow = true;
        break;
      }
    }
  }
  var _showStaleCallout = _allZeroTemp && _hasEmptyZoneRow && _bldgNamesForCallout.length > 0;

  var html = '<div style="padding:24px;overflow:visible;height:100%;box-sizing:border-box">';
  html +=
    '<h2 style="font-size:20px;font-weight:600;margin:0 0 20px 0;color:var(--text)">Equipment Summary — Zone Comfort</h2>';
  if (_showStaleCallout) {
    html +=
      '<div style="background:#3a2e00;border:1px solid #b8860b;border-radius:6px;' +
      'padding:10px 16px;margin-bottom:16px;font-size:13px;color:#f0d060;display:flex;align-items:center;gap:10px">' +
      '<span style="font-size:16px">&#9888;</span>' +
      '<span>Zone temperature values require a fresh import — your data was imported before live values were captured. ' +
      'Re-import your CSV.</span>' +
      '</div>';
  }
  html += '<table style="width:100%;border-collapse:collapse;font-size:15px">';
  html += '<thead><tr>';
  html += '<th style="' + thStyleLeft + '">Building</th>';
  html += '<th style="' + thStyleCenter + '">Zone Air Temp</th>';
  html +=
    '<th style="' +
    thStyleCenter +
    '" title="Setpoints require a WebCTRL point-list export, not the enriched matrix snapshot.">Zone Htg Setpoint</th>';
  html +=
    '<th style="' +
    thStyleCenter +
    '" title="Setpoints require a WebCTRL point-list export, not the enriched matrix snapshot.">Zone Clg Setpoint</th>';
  html += '<th style="' + thStyleCenter + '">Zones vs Setpoints</th>';
  html += '<th style="' + thStyleCenter + '">CO2 (ppm)</th>';
  html += '<th style="' + thStyleCenter + '">Humidity (%)</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  if (bldgNames.length === 0) {
    html +=
      '<tr><td colspan="7" style="padding:48px;text-align:center;font-size:14px;color:var(--text2)">' +
      'No zone equipment (VAV/FPB/DD-VAV) found for the current filter selection.</td></tr>';
  } else {
    var tdStyle = 'padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle;';
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
        'style="color:var(--accent);cursor:pointer;font-weight:600;text-decoration:none">' +
        emHtmlEsc(bldg) +
        '</a>';
      // Zones vs Setpoints cell
      var vsCell;
      if (bs.totalZones === 0) {
        vsCell =
          '<span style="color:var(--text3)">—</span>' +
          '<span style="color:var(--text3);font-size:0.85em;margin-left:6px">(no zone equip)</span>';
      } else {
        vsCell =
          '<span style="color:#c0392b;font-weight:500">' +
          bs.hot +
          ' hot</span> <span style="color:var(--text3)">|</span> ' +
          '<span style="color:#27ae60;font-weight:500">' +
          bs.ok +
          ' ok</span> <span style="color:var(--text3)">|</span> ' +
          '<span style="color:#2980b9;font-weight:500">' +
          bs.cold +
          ' cold</span>';
      }
      html += '<tr style="min-height:48px">';
      html += '<td style="' + tdStyle + 'font-weight:600">' + bldgLink + '</td>';
      html += '<td style="' + tdCenter + 'font-weight:600">' + fmtAvg(bs.zoneTemp, '°F', bs.totalZones) + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.htgSp, '°F', bs.totalZones) + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.coolSp, '°F', bs.totalZones) + '</td>';
      html += '<td style="' + tdCenter + '">' + vsCell + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.zoneCO2, ' ppm', bs.totalZones) + '</td>';
      html += '<td style="' + tdCenter + '">' + fmtAvg(bs.zoneRelativeHumidity, '%', bs.totalZones) + '</td>';
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
  html += '<td style="' + tfootTdCenter + '">' + fmtAvg(pageAgg.zoneCO2, ' ppm') + '</td>';
  html += '<td style="' + tfootTdCenter + '">' + fmtAvg(pageAgg.zoneRelativeHumidity, '%') + '</td>';
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
  html += '<td style="' + tfootTdCenter + 'font-weight:600">' + fmtAvg(totalAgg.zoneCO2, ' ppm') + '</td>';
  html += '<td style="' + tfootTdCenter + 'font-weight:600">' + fmtAvg(totalAgg.zoneRelativeHumidity, '%') + '</td>';
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
  var zoneCategories = { vav: true, fpb: true, ddvav: true, fcu: true };
  var catLabels = { vav: 'VAV', fpb: 'FPB', ddvav: 'DD-VAV', fcu: 'FCU', ahu: 'AHU/RTU' };

  // Single-zone AHU gate for detail view (mirrors emComputeBuildingZoneStats):
  // include an 'ahu' row only if it has zone setpoints or a zone temp (i.e. single-zone unit).
  function _detailIsSingleZoneAhu(r) {
    var _p = emGetNormalizedPoints(r);
    return (
      (_p['zoneCoolSetpoint'] !== undefined && _p['zoneCoolSetpoint'] !== '') ||
      (_p['zoneHtgSetpoint'] !== undefined && _p['zoneHtgSetpoint'] !== '') ||
      (_p['zoneAirTemp'] !== undefined && _p['zoneAirTemp'] !== '')
    );
  }

  // Filter: apply current filters first, then restrict to this building's zone equipment.
  // Includes single-zone AHUs (RTUs, split systems) via the gate above.
  var baseFiltered = emFilterRows(allRows, filters);
  var bldgRows = baseFiltered.filter(function (r) {
    if (r.building !== buildingName) return false;
    if (zoneCategories[r.category]) return true;
    if (r.category === 'ahu') return _detailIsSingleZoneAhu(r);
    return false;
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
      var pts = emGetNormalizedPoints(row);

      var tempRaw = pts['zoneAirTemp'];
      var htgRaw = pts['zoneHtgSetpoint'];
      var coolRaw = pts['zoneCoolSetpoint'];
      var dampRaw = pts['damperPosition']; // FIX 4a: was 'dampPosnLive' (typo), correct key is 'damperPosition'
      var datRaw = pts['dischargeAirTemp'];

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
  } else {
    // Default sort: building alpha → HVAC type priority → equipment name alpha
    filtered = filtered.slice().sort(function (a, b) {
      var ab = (a.building || '').toLowerCase();
      var bb = (b.building || '').toLowerCase();
      if (ab < bb) return -1;
      if (ab > bb) return 1;
      var ap = _emTypePriority[a.category] !== undefined ? _emTypePriority[a.category] : 22;
      var bp = _emTypePriority[b.category] !== undefined ? _emTypePriority[b.category] : 22;
      if (ap !== bp) return ap - bp;
      var ae = (a.equipName || '').toLowerCase();
      var be = (b.equipName || '').toLowerCase();
      return ae < be ? -1 : ae > be ? 1 : 0;
    });
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
    var colW = _emColWidths[ci] !== undefined ? _emColWidths[ci] : d.width;
    theadCells +=
      '<th data-ci="' +
      ci +
      '" ' +
      (d.title ? 'title="' + emHtmlEsc(d.title) + '" ' : '') +
      'style="position:sticky;top:0;background:var(--s2);' +
      borderTop +
      'font-weight:600;color:var(--text2);white-space:nowrap;' +
      'min-width:' +
      colW +
      'px;width:' +
      colW +
      'px;text-align:left;' +
      'border-bottom:1px solid var(--border);border-right:1px solid var(--border)">' +
      '<span style="cursor:pointer;" onclick="emHandleSort(' +
      ci +
      ')">' +
      d.label +
      sortInd +
      '</span>' +
      '<div class="em-col-resize-handle" data-ci="' +
      ci +
      '"></div>' +
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
    var emptyMsg =
      rows.length === 0 ? 'No equipment data — click Import CSVs to begin' : 'No rows match the current filters.';
    // When there is no data at all, defs only has 7 fixed columns (no equipment-type ASHRAE columns).
    // Use those 7 columns — the empty-state row spans them all and the table still fills full width.
    tbodyRows =
      '<tr><td colspan="' +
      defs.length +
      '" style="padding:48px 32px;text-align:center;font-size:14px;color:var(--text2)">' +
      emptyMsg +
      '</td></tr>';
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

  var pageTotals = emComputeAuditFooterTotals(pageRows, defs);
  var allTotals = emComputeAuditFooterTotals(filtered, defs);
  var tfootHtml =
    '<tfoot>' +
    buildAuditFooterRow(pageTotals, defs, 'Page Total', false) +
    buildAuditFooterRow(allTotals, defs, 'Total', true) +
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
      // FIX 3a (1b74f531): Use explicit null/undefined check so 0/'0' passes through (was falsy || '')
      var rawVal =
        row.points && match.pointName ? (row.points[match.pointName] != null ? row.points[match.pointName] : '') : '';
      var displayVal = rawVal !== '' ? (String(rawVal).length > 8 ? String(rawVal).slice(0, 8) : String(rawVal)) : null;
      var tooltipBase = emHtmlEsc((match.pointName || '') + (rawVal !== '' ? ': ' + rawVal : ''));

      // FIX 65030b9b: detect "present but blank at export time" state.
      // A point is in this state when: (a) the compliance engine found it covered via
      // row.pointsRaw (point name exists on the controller), (b) row.points has no entry
      // for this point name (no live value was stored), AND (c) row.pointsRaw explicitly
      // has the name with a blank-string value (confirmed blank at export, not a col-key match).
      // Render as amber "--" so it is visually distinct from both green (live value present)
      // and red (point genuinely absent). This state is NOT a missing point — do NOT count
      // it as a gap in coverage percentage.
      var isBlankAtExport =
        rawVal === '' &&
        match.pointName &&
        row.pointsRaw &&
        Object.prototype.hasOwnProperty.call(row.pointsRaw, match.pointName) &&
        row.pointsRaw[match.pointName] === '';
      if (isBlankAtExport) {
        var blankTitle =
          emHtmlEsc(match.pointName || '') + ': point exists on controller but had no live value at export time';
        return (
          '<td style="' +
          baseStyle +
          'background:rgba(243,156,18,0.15);color:#d4820a;font-weight:700" title="' +
          blankTitle +
          '">--</td>'
        );
      }

      if (tier <= 2) {
        // High confidence — green cell. Show snapshot value when present; color alone signals match.
        var greenTitle = tooltipBase || 'Matched';
        return (
          '<td style="' +
          baseStyle +
          'background:rgba(39,174,96,0.15);color:#27ae60;font-weight:700" title="' +
          greenTitle +
          '">' +
          (displayVal !== null ? emHtmlEsc(displayVal) : '') +
          '</td>'
        );
      } else {
        // Lower-confidence match — amber cell. Show snapshot value when present; color signals confidence.
        var amberTitle = tooltipBase ? tooltipBase + ' (lower-confidence match)' : 'Likely match (non-standard name)';
        return (
          '<td style="' +
          baseStyle +
          'background:rgba(230,126,34,0.15);color:#e67e22;font-weight:700" title="' +
          amberTitle +
          '">' +
          (displayVal !== null ? emHtmlEsc(displayVal) : '') +
          '</td>'
        );
      }
    }
    // Required but missing — red cell, color-only (no text)
    if (def.catRequired && missingMap[catKey]) {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(192,57,43,0.15);color:#c0392b;font-weight:700" title="Not found: ' +
        emHtmlEsc(def.label || catKey) +
        '"></td>'
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
        'background:rgba(39,174,96,0.15);color:#27ae60;font-weight:700" ' +
        'title="' +
        emHtmlEsc(bTooltip) +
        '">PASS</td>'
      );
    }
    if (bVerdict === 'WARN') {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(230,126,34,0.15);color:#e67e22;font-weight:700" ' +
        'title="' +
        emHtmlEsc(bTooltip) +
        '">WARN</td>'
      );
    }
    if (bVerdict === 'FAIL') {
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(192,57,43,0.15);color:#c0392b;font-weight:700" ' +
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

  // ── Setpoint Values column (Phase 4.1) ──
  // GL36 §3.1.1.1 / Table 3.1.1.3 value compliance pill.
  // Green "All Match", Amber "N Needs Review", Gray "No Data", dash for N/A types.
  if (def.isAuditSpValues) {
    var _spCats = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
    if (!row.category || !_spCats[row.category]) {
      return (
        '<td style="' +
        baseStyle +
        'color:var(--text3)" title="Setpoint value checks apply to zone equipment only">&#8212;</td>'
      );
    }
    var _spPid = window._emActivePid || '';
    var _spFlags = emLoadEquipConfigFlags(_spPid, row.id);
    var _spOvr = emLoadSpOverrides(_spPid, row.id);
    var _spResult = emComputeSetpointCompliance(row, _spFlags, _spOvr);
    if (!_spResult.hasAnyData) {
      // No numeric setpoint values in BAS export for this equipment
      var _spNoDataTooltip = 'No setpoint values found in the imported BAS export for this equipment.';
      return (
        '<td style="' +
        baseStyle +
        'color:var(--text3);font-size:11px" title="' +
        emHtmlEsc(_spNoDataTooltip) +
        '">No Data</td>'
      );
    }
    // Count deviations (excluding intentionally-marked ones)
    var _spDevCount = 0;
    var _spDevLines = [];
    for (var _spri = 0; _spri < _spResult.results.length; _spri++) {
      var _spr = _spResult.results[_spri];
      if (_spr.status === 'DEVIATION' && !_spr.intentionalFlag) {
        _spDevCount++;
        _spDevLines.push(_spr.label + ': ' + (_spr.deviationNote || 'Needs Review'));
      }
    }
    if (_spDevCount === 0) {
      // All checks passed (or all deviations are marked intentional)
      return (
        '<td style="' +
        baseStyle +
        'background:rgba(39,174,96,0.15);color:#27ae60;font-weight:700;font-size:11px" ' +
        'title="All setpoint checks match GL36 defaults (±1°F / ±50 ppm)">All Match</td>'
      );
    }
    // Amber — deviations need review
    var _spTooltip = _spDevCount + ' check(s) need review: ' + _spDevLines.join('; ');
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(230,126,34,0.15);color:#e67e22;font-weight:700;font-size:11px;cursor:pointer" ' +
      'title="' +
      emHtmlEsc(_spTooltip) +
      '" onclick="emShowComplianceDetail(\'' +
      String(row.id).replace(/'/g, "\\'") +
      '\')">' +
      _spDevCount +
      ' Needs Review</td>'
    );
  }

  // ── Fallback ──
  // Milestone 1: use != null guard (0-safe) instead of || '' (was falsy)
  return '<td style="' + baseStyle + '">' + emHtmlEsc(String(row[def.key] != null ? row[def.key] : '')) + '</td>';
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
  // Setpoint Values column sort: 0=has deviations (worst first), 1=all match, 2=no data, 3=N/A
  if (def.isAuditSpValues) {
    var _spSortCats = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
    if (!row.category || !_spSortCats[row.category]) return 3; // N/A — sort last
    var _spSortPid = window._emActivePid || '';
    var _spSortFlags = emLoadEquipConfigFlags(_spSortPid, row.id);
    var _spSortOvr = emLoadSpOverrides(_spSortPid, row.id);
    var _spSortResult = emComputeSetpointCompliance(row, _spSortFlags, _spSortOvr);
    if (!_spSortResult.hasAnyData) return 2;
    // Count unacknowledged deviations
    var _spSortDevs = 0;
    for (var _spsi = 0; _spsi < _spSortResult.results.length; _spsi++) {
      var _spse = _spSortResult.results[_spsi];
      if (_spse.status === 'DEVIATION' && !_spse.intentionalFlag) _spSortDevs++;
    }
    return _spSortDevs > 0 ? 0 : 1;
  }
  return '';
}

/* ── emShowComplianceDetail ─────────────────────────────────────────────────
   Clicking the Coverage % cell (or an amber Setpoint Values pill) opens a
   side panel showing:
     1. Point Coverage breakdown (matched / missing / N/A)
     2. Equipment Config Flags — checkboxes + select dropdowns (Phase 2.3)
     3. GL36 Setpoint Check table (Phase 4.2)
   The panel slides in from the right edge of the em-table-wrap container.  */
function emShowComplianceDetail(rowId) {
  var pid = window._emActivePid || '';
  var data = emLoadMatrix(pid);
  if (!data) return;
  var row = null;
  for (var i = 0; i < (data.rows || []).length; i++) {
    if (data.rows[i].id === rowId) {
      row = data.rows[i];
      break;
    }
  }
  if (!row) return;

  var _detailMaps = emLoadCustomMappings(pid);
  var c = emComputeCompliance(row, {}, _detailMaps);
  var flags = emLoadEquipConfigFlags(pid, rowId);
  var spOvr = emLoadSpOverrides(pid, rowId);
  var category = row.category || '';
  var equipName = row.equipName || row.name || rowId;
  var catLabel = category ? category.toUpperCase() : 'Unknown';

  // ── Section 1: Point Coverage ─────────────────────────────────────────────
  var covHtml =
    '<div style="margin-bottom:16px">' +
    '<div style="font-weight:600;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Point Coverage</div>' +
    '<div style="font-size:13px;margin-bottom:6px">Coverage: <strong>' +
    c.coveragePct +
    '%</strong> (' +
    c.totalMatched +
    '/' +
    (c.totalRequired - c.totalNA) +
    ' required points)</div>';

  if (c.coveredPoints.length) {
    covHtml +=
      '<div style="font-size:11px;color:#27ae60;margin-bottom:4px">Matched (' + c.coveredPoints.length + '):</div>';
    for (var cp = 0; cp < c.coveredPoints.length; cp++) {
      var p = c.coveredPoints[cp];
      var tier = p.matchTier <= 2 ? '' : ' style="color:#e67e22"';
      covHtml +=
        '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid var(--border)"' +
        tier +
        '>' +
        emHtmlEsc((p.matchTier <= 2 ? '✓ ' : '~ ') + p.categoryLabel + ' — “' + (p.pointName || '') + '”') +
        '</div>';
    }
  }
  if (c.missingPoints.length) {
    covHtml +=
      '<div style="font-size:11px;color:#c0392b;margin-top:6px;margin-bottom:4px">Missing Required (' +
      c.missingPoints.length +
      '):</div>';
    for (var mp = 0; mp < c.missingPoints.length; mp++) {
      covHtml +=
        '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid var(--border);color:#c0392b">' +
        emHtmlEsc('✗ ' + c.missingPoints[mp].categoryLabel) +
        '</div>';
    }
  }
  if (c.naPoints.length) {
    covHtml +=
      '<div style="font-size:11px;color:var(--text3);margin-top:6px;margin-bottom:4px">N/A (' +
      c.naPoints.length +
      '):</div>';
    for (var np = 0; np < c.naPoints.length; np++) {
      covHtml +=
        '<div style="font-size:11px;padding:2px 0;color:var(--text3)">' +
        emHtmlEsc('— ' + c.naPoints[np].categoryLabel) +
        '</div>';
    }
  }
  covHtml += '</div>';

  // ── Section 2: Equipment Config Flags (Phase 2.3) ─────────────────────────
  var flagDefs = (category && EM_EQUIP_CONFIG_FLAGS[category]) || [];
  var cfHtml = '';
  if (flagDefs.length) {
    cfHtml =
      '<div style="margin-bottom:16px">' +
      '<div style="font-weight:600;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Equipment Configuration</div>';

    for (var fi = 0; fi < flagDefs.length; fi++) {
      var fd = flagDefs[fi];
      var storedVal = fd.key in flags ? flags[fd.key] : fd['default'];
      var safeRowId = JSON.stringify(rowId);
      var safePid = JSON.stringify(pid);
      var safeFdKey = JSON.stringify(fd.key);

      if (fd.type === 'select') {
        // ── Select dropdown (zoneType, occupancyCat) ──────────────────────
        var optionKeys;
        if (fd.options === 'Object.keys(GL36_CO2_DEFAULTS)') {
          optionKeys = Object.keys(GL36_CO2_DEFAULTS);
        } else {
          optionKeys = Array.isArray(fd.options) ? fd.options : [];
        }

        // Determine current value: stored override, or inferred default
        var currentVal = storedVal;
        var isInferred = !(fd.key in flags);
        if (fd.key === 'zoneType' && isInferred) {
          currentVal = emInferZoneType(row);
        } else if (!(fd.key in flags)) {
          currentVal = fd['default'];
        }

        // Build friendly label lookup for zoneType
        var zoneTypeLabels = {
          vav: 'General VAV Zone',
          mech_elec: 'Mechanical/Electrical Room',
          networking: 'Networking/Server Room',
        };

        var optionsHtml = '';
        for (var oi = 0; oi < optionKeys.length; oi++) {
          var oKey = optionKeys[oi];
          var oLabel;
          if (GL36_CO2_DEFAULTS[oKey]) {
            oLabel = GL36_CO2_DEFAULTS[oKey].label + ' (' + GL36_CO2_DEFAULTS[oKey].group + ')';
          } else {
            oLabel = zoneTypeLabels[oKey] || oKey;
          }
          var isSelected = oKey === currentVal ? ' selected' : '';
          optionsHtml += '<option value="' + emHtmlEsc(oKey) + '"' + isSelected + '>' + emHtmlEsc(oLabel) + '</option>';
        }

        var inferredHint =
          isInferred && fd.key === 'zoneType'
            ? ' <span style="color:var(--text3);font-style:italic;font-size:10px">(inferred)</span>'
            : '';
        cfHtml +=
          '<div style="margin-bottom:8px">' +
          '<label style="font-size:11px;color:var(--text2);display:block;margin-bottom:3px">' +
          emHtmlEsc(fd.label) +
          inferredHint +
          '</label>' +
          '<select style="font-size:11px;padding:3px 6px;background:var(--s2);border:1px solid var(--border);' +
          'color:var(--text);border-radius:4px;width:100%" ' +
          'onchange="emSaveEquipConfigFlagFromPanel(' +
          safePid +
          ',' +
          safeRowId +
          ',' +
          safeFdKey +
          ',this.value)">' +
          optionsHtml +
          '</select>' +
          '</div>';
      } else {
        // ── Boolean checkbox ──────────────────────────────────────────────
        var isChecked = storedVal === true || storedVal === 'true';
        cfHtml +=
          '<div style="margin-bottom:6px;display:flex;align-items:center;gap:8px">' +
          '<input type="checkbox"' +
          (isChecked ? ' checked' : '') +
          ' onchange="emSaveEquipConfigFlagFromPanel(' +
          safePid +
          ',' +
          safeRowId +
          ',' +
          safeFdKey +
          ',this.checked)"' +
          ' style="width:14px;height:14px;cursor:pointer">' +
          '<span style="font-size:12px;color:var(--text)">' +
          emHtmlEsc(fd.label) +
          '</span>' +
          '</div>';
      }
    }
    cfHtml += '</div>';
  }

  // ── Section 3: GL36 Setpoint Check (Phase 4.2) ────────────────────────────
  var _spCatsForDetail = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
  var spHtml = '';
  if (category && _spCatsForDetail[category]) {
    var spResult = emComputeSetpointCompliance(row, flags, spOvr);
    var statusIcons = { PASS: '✓ Matches', DEVIATION: '⚠ Needs Review', NOT_SCHEDULED: 'Not Scheduled', NA: 'N/A' };
    var statusColors = { PASS: '#27ae60', DEVIATION: '#e67e22', NOT_SCHEDULED: 'var(--text3)', NA: 'var(--text3)' };

    spHtml =
      '<div style="margin-bottom:16px">' +
      '<div style="font-weight:600;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">GL36 Setpoint Check</div>' +
      '<div style="font-size:10px;color:var(--text3);margin-bottom:8px" ' +
      'title="GL36 §3.1.1.1/Table 3.1.1.3 provides default setpoints. Designers may intentionally use different values; ' +
      'items marked Needs Review should be confirmed as intentional.">' +
      'GL36 §3.1.1.1/Table 3.1.1.3 defaults. Deviations may be intentional (hover for details).' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<thead><tr style="background:var(--s1)">' +
      '<th style="text-align:left;padding:4px 6px;border:1px solid var(--border);color:var(--text2)">Check</th>' +
      '<th style="text-align:right;padding:4px 6px;border:1px solid var(--border);color:var(--text2)">Your Setting</th>' +
      '<th style="text-align:right;padding:4px 6px;border:1px solid var(--border);color:var(--text2)">GL36 Default</th>' +
      '<th style="text-align:left;padding:4px 6px;border:1px solid var(--border);color:var(--text2)">Status</th>' +
      '</tr></thead><tbody>';

    for (var sri = 0; sri < spResult.results.length; sri++) {
      var sr = spResult.results[sri];
      var srColor = statusColors[sr.status] || 'var(--text)';
      var srIcon = statusIcons[sr.status] || sr.status;

      var actualDisp = sr.actualValue !== null ? String(Math.round(sr.actualValue * 10) / 10) : '—';
      var defaultDisp;
      if (sr.checkKey === 'co2') {
        defaultDisp = sr.gl36Default + ' ppm';
        actualDisp = sr.actualValue !== null ? sr.actualValue + ' ppm' : '—';
      } else if (sr.checkKey === 'deadband') {
        defaultDisp = '≥1°F (rec. 2°F)';
        actualDisp = sr.actualValue !== null ? sr.actualValue.toFixed(1) + '°F' : '—';
      } else {
        defaultDisp = sr.gl36Default + '°F';
        actualDisp = sr.actualValue !== null ? sr.actualValue + '°F' : '—';
      }

      var intentionalBadge = '';
      var markBtn = '';
      if (sr.status === 'DEVIATION') {
        if (sr.intentionalFlag) {
          srIcon = '✓ Confirmed intentional';
          srColor = '#27ae60';
          intentionalBadge = '';
        } else {
          markBtn =
            ' <button onclick="emMarkSpOverrideIntentional(' +
            JSON.stringify(pid) +
            ',' +
            JSON.stringify(rowId) +
            ',' +
            JSON.stringify(sr.checkKey) +
            ')" ' +
            'style="font-size:10px;padding:1px 6px;background:var(--s2);border:1px solid var(--border);' +
            'color:var(--text2);border-radius:3px;cursor:pointer;margin-left:4px" ' +
            'title="Mark this deviation as intentional (designer override per GL36 §3.1.1.1)">Mark as intentional</button>';
        }
      }

      var trTooltip = sr.deviationNote ? ' title="' + emHtmlEsc(sr.deviationNote) + '"' : '';
      spHtml +=
        '<tr' +
        trTooltip +
        '>' +
        '<td style="padding:4px 6px;border:1px solid var(--border)">' +
        emHtmlEsc(sr.label) +
        '</td>' +
        '<td style="padding:4px 6px;border:1px solid var(--border);text-align:right">' +
        emHtmlEsc(actualDisp) +
        '</td>' +
        '<td style="padding:4px 6px;border:1px solid var(--border);text-align:right;color:var(--text3)">' +
        emHtmlEsc(defaultDisp) +
        '</td>' +
        '<td style="padding:4px 6px;border:1px solid var(--border);color:' +
        srColor +
        ';white-space:nowrap">' +
        emHtmlEsc(srIcon) +
        markBtn +
        '</td>' +
        '</tr>';
    }
    spHtml += '</tbody></table></div>';
  }

  // ── Assemble panel HTML ────────────────────────────────────────────────────
  var panelId = 'em-compliance-detail-panel';
  var existing = document.getElementById(panelId);
  if (existing) existing.parentNode.removeChild(existing);

  var panelHtml =
    '<div id="' +
    panelId +
    '" style="position:fixed;top:0;right:0;width:380px;height:100vh;background:var(--bg);' +
    'border-left:2px solid var(--border);box-shadow:-4px 0 16px rgba(0,0,0,0.18);z-index:9999;' +
    'display:flex;flex-direction:column;overflow:hidden">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;' +
    'border-bottom:1px solid var(--border);background:var(--s1);flex-shrink:0">' +
    '<div>' +
    '<div style="font-weight:700;font-size:13px;color:var(--text)">' +
    emHtmlEsc(equipName) +
    '</div>' +
    '<div style="font-size:11px;color:var(--text3)">' +
    emHtmlEsc(catLabel) +
    ' &mdash; ASHRAE 36 Detail</div>' +
    '</div>' +
    '<button onclick="emCloseComplianceDetail()" style="background:none;border:none;font-size:18px;' +
    'cursor:pointer;color:var(--text2);padding:4px;line-height:1" title="Close">&times;</button>' +
    '</div>' +
    '<div style="flex:1;overflow-y:auto;padding:16px">' +
    covHtml +
    cfHtml +
    spHtml +
    '</div>' +
    '</div>';

  var container = document.createElement('div');
  container.innerHTML = panelHtml;
  document.body.appendChild(container.firstChild);
}

/* ── emCloseComplianceDetail ─────────────────────────────────────────────────
   Closes the compliance detail side panel.                                 */
function emCloseComplianceDetail() {
  var panel = document.getElementById('em-compliance-detail-panel');
  if (panel) panel.parentNode.removeChild(panel);
}

/* ── emSaveEquipConfigFlagFromPanel ──────────────────────────────────────────
   Called by checkbox/select onchange handlers inside the compliance detail
   panel. Saves a single config flag value and re-renders the panel +
   the audit table so the Setpoint Values column updates immediately.

   Phase 2.3 — supports boolean (checkbox) and string (select) values.     */
function emSaveEquipConfigFlagFromPanel(pid, rowId, flagKey, value) {
  var flags = emLoadEquipConfigFlags(pid, rowId);
  flags[flagKey] = value;
  emSaveEquipConfigFlags(pid, rowId, flags);
  // Invalidate compliance cache so the table re-evaluates immediately
  if (typeof _emComplianceCache !== 'undefined') delete _emComplianceCache[rowId];
  // Re-render the panel with updated flags
  emShowComplianceDetail(rowId);
  // Re-render the audit table so the Setpoint Values column pill updates
  var data = emLoadMatrix(pid);
  if (data) emRenderTable(data, _emFilters);
}

/* ── emMarkSpOverrideIntentional ─────────────────────────────────────────────
   Called by "Mark as intentional" buttons in the GL36 Setpoint Check table.
   Saves a spOverride and re-renders the detail panel.

   Phase 4.2 — persists via emSaveSpOverride; re-renders panel + audit row.  */
function emMarkSpOverrideIntentional(pid, rowId, checkKey) {
  emSaveSpOverride(pid, rowId, checkKey, true);
  // Re-render panel to show confirmed badge
  emShowComplianceDetail(rowId);
  // Re-render audit table so the Setpoint Values pill updates
  var data = emLoadMatrix(pid);
  if (data) emRenderTable(data, _emFilters);
}

/**
 * emAttachColResizeHandler — Handle-div resize pattern (mirrors bas-alarms.js / utility-data.js).
 * Each TH contains a .em-col-resize-handle div. mousedown on that div starts a drag;
 * mousemove/mouseup on document finishes it. Widths are written to _emColWidths so they
 * survive re-renders within the session. sort onclick lives on a <span> inside the TH,
 * so handle clicks never reach the sort handler.
 */
function emAttachColResizeHandler(wrap) {
  if (!wrap) return;

  // Clean up document-level handlers from a previous render
  if (wrap._emDocMoveHandler) document.removeEventListener('mousemove', wrap._emDocMoveHandler);
  if (wrap._emDocUpHandler) document.removeEventListener('mouseup', wrap._emDocUpHandler);

  var _resizing = null; // { handle, targetTh, startX, startW }

  function onMouseDown(e) {
    var h = e.target.closest ? e.target.closest('.em-col-resize-handle') : null;
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    var targetTh = h.closest('th');
    if (!targetTh) return;
    h.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    _resizing = { handle: h, targetTh: targetTh, startX: e.clientX, startW: targetTh.offsetWidth };
  }

  function onMouseMove(e) {
    if (!_resizing) return;
    var newW = Math.max(40, _resizing.startW + (e.clientX - _resizing.startX));
    _resizing.targetTh.style.minWidth = newW + 'px';
    _resizing.targetTh.style.width = newW + 'px';
  }

  function onMouseUp() {
    if (!_resizing) return;
    _resizing.handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Write width back to module-level store so re-renders preserve it
    var ci = parseInt(_resizing.targetTh.dataset.ci, 10);
    if (!isNaN(ci)) {
      _emColWidths[ci] = _resizing.targetTh.offsetWidth;
    }
    emUpdateStickyOffsets();
    _resizing = null;
  }

  wrap.addEventListener('mousedown', onMouseDown);

  // Store named references so we can remove them on next render
  wrap._emDocMoveHandler = onMouseMove;
  wrap._emDocUpHandler = onMouseUp;
  document.addEventListener('mousemove', wrap._emDocMoveHandler);
  document.addEventListener('mouseup', wrap._emDocUpHandler);
}

function emPrevPage(pid) {
  if (_emCurrentPage > 0) {
    _emCurrentPage--;
    var _wrap = document.getElementById('em-table-wrap');
    if (_wrap) {
      _wrap.scrollTop = 0;
      _wrap.scrollLeft = 0;
    }
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
  var _wrap = document.getElementById('em-table-wrap');
  if (_wrap) {
    _wrap.scrollTop = 0;
    _wrap.scrollLeft = 0;
  }
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
  emSaveMatrix(pid, data).catch(() => {});
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
  emSaveMatrix(pid, data).catch(() => {});
  var container = document.getElementById('em-proj-wrap');
  if (container) emRenderMatrix(container, data, pid);
  showToast('All equipment data deleted');
}

function emClearAllData(pid) {
  var data = emLoadMatrix(pid);
  var rowCount = data && data.rows ? data.rows.length : 0;
  if (
    !confirm(
      'Clear ALL Equipment Matrix data for this project? This removes ' +
        rowCount +
        ' rows, all edits, custom columns, and point mappings. This cannot be undone.',
    )
  )
    return;
  // Remove all 4 IndexedDB keys for this project
  DB.remove('en_eqmatrix_' + pid);
  DB.remove('en_eqmatrix_cols_' + pid);
  DB.remove('en_eqmatrix_edits_' + pid);
  DB.remove('en_eqmatrix_cmaps_' + pid);
  // Clear in-memory caches
  _EM_COL_DEFS = null;
  _emComplianceCache = {};
  _emNormCache = new Map();
  _emPointNameCache = new Map(); // Milestone 1: also clear name lookup cache
  // Re-render matrix as empty
  var emptyData = { rows: [], importedAt: null, buildings: [] };
  var container = document.getElementById('em-proj-wrap');
  if (container) emRenderMatrix(container, emptyData, pid);
  showToast('All Equipment Matrix data cleared');
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
    // FIX: Use explicit null/undefined check so 0 and '0' pass through (was falsy || '')
    var cv = row.checks && row.checks[checkCols[idx]];
    return cv != null ? cv : '';
  }
  if (def.isLive || def.isDynPoint) {
    // Milestone 1: read through normalized-points engine (mirrors emGetCellValByDef)
    // FIX: Use explicit null/undefined check so 0 and '0' pass through (was falsy || '')
    var pv = emGetNormalizedPoints(row)[def.key];
    return pv != null ? pv : '';
  }
  // FIX: Use explicit null/undefined check so 0 passes through (was falsy || '')
  return row[def.key] != null ? row[def.key] : '';
}

/* M4 Part 2: Toggle the "All Points" inline drawer for a single equipment row.
   Keyed by row.id in the module-level _emOpenDrawers Set.
   Survives sort/filter/page-toggle because state is in the Set, not the DOM.  */
function emTogglePointDrawer(rowId) {
  if (_emOpenDrawers.has(rowId)) {
    _emOpenDrawers.delete(rowId);
  } else {
    _emOpenDrawers.add(rowId);
  }
  var data = emLoadMatrix(window._emActivePid);
  if (data) emRenderTable(data, _emFilters);
}

function emFormatCell(val, def) {
  if (val === null || val === undefined || val === '') return '--';
  var s = String(val);
  // Step 3 — offline sentinel display: WebCTRL "no data" markers render as muted "offline" label.
  // DISPLAY ONLY — do NOT filter these at import time or delete from row.points.
  // Points must still count toward Total BAS Points (Object.keys(row.points).length unchanged).
  // Place before isCategory and check_ branches so it applies to Live + dynamic columns.
  if (s.trim() === '?' || s.trim() === 'offline') {
    return '<span style="color:var(--text3);font-size:11px;font-style:italic">offline</span>';
  }
  // Milestone 2: render category key as a friendly equipment-type label
  if (def.isCategory) {
    return EM_CATEGORY_LABELS[s] || (s ? s.toUpperCase() : '--');
  }
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
  emSaveMatrix(pid, data).catch(() => {});
}

function emHandleSaveEdits() {
  var pid = window._emActivePid;
  if (!pid) return;
  var data = emLoadMatrix(pid);
  var editCount = data.edits ? Object.keys(data.edits).length : 0;
  emSaveMatrix(pid, data).catch(() => {});
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
  emSaveMatrix(projId, data).catch(() => {});
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
    '<div id="em-import-success-wrap" style="display:none;align-items:center;gap:8px;padding:10px;background:var(--s2);border-radius:6px;flex-wrap:wrap">' +
    '<span style="font-size:16px;color:#22c55e">&#x2713;</span>' +
    '<span id="em-import-success-msg" style="font-size:12px;font-weight:600;color:var(--text);flex:1;min-width:0"></span>' +
    '<button onclick="emCloseUploadModal(null,_emImportMode)" ' +
    'style="background:var(--accent);color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0">Done</button>' +
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
  async function onFileDone() {
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
      // In replace mode: snapshot old notes/editedAt and old buildings BEFORE wiping, so we can
      // (a) re-apply hand-typed notes to matching rows, and (b) warn about removed buildings.
      var _replaceNotesMap = {}; // id → { notes, editedAt }
      var _oldBuildingSet = {}; // building name → true
      if (_emImportMode === 'replace') {
        var _oldData = emLoadMatrix(pid) || { rows: [], buildings: [] };
        (_oldData.rows || []).forEach(function (r) {
          if (r.id) {
            _replaceNotesMap[r.id] = { notes: r.notes || '', editedAt: r.editedAt || '' };
          }
          if (r.building) _oldBuildingSet[r.building] = true;
        });
      }

      // merge mode: preserve existing rows and dedup by id; replace mode: start fresh
      var baseData =
        _emImportMode === 'replace' ? { rows: [], buildings: [] } : emLoadMatrix(pid) || { rows: [], buildings: [] };
      var merged = emMergeIntoMatrix(baseData, allRows);

      // Re-apply preserved notes/editedAt onto newly merged rows (replace mode only).
      // emMergeIntoMatrix ran with empty existing[], so the preservation block inside it
      // never fired. Walk the merged rows here and restore from our snapshot.
      if (_emImportMode === 'replace') {
        var _notesPreservedCount = 0;
        merged.rows.forEach(function (r) {
          var saved = _replaceNotesMap[r.id];
          if (saved) {
            if (saved.notes && !r.notes) {
              r.notes = saved.notes;
              _notesPreservedCount++;
            }
            if (saved.editedAt && !r.editedAt) r.editedAt = saved.editedAt;
          }
        });
      }
      merged.totalBASPoints = totalRawRows;
      // Show "Saving..." while awaiting the real IDB commit (tx.oncomplete).
      // We do NOT show "Import complete" until the write is fully durable on disk.
      if (statusEl) statusEl.textContent = 'Saving to database...';
      if (statusWrap) statusWrap.style.display = 'flex';
      try {
        await emSaveMatrix(pid, merged);
      } catch (e) {
        console.error('[EquipMatrix] emSaveMatrix failed:', e);
        showToast('Save failed — your import was NOT stored. Try again.', 'error');
        if (statusEl) statusEl.textContent = 'Save failed.';
        return;
      }
      // ── Belt-and-suspenders: request persistent storage after a successful import ──
      // Does NOT override the user's "clear browsing data on close" setting.
      // Only prevents browser eviction under storage pressure (low-disk, cache-clearing).
      // Fire-and-forget — failure is non-fatal. No toast for grant/deny result.
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage
          .persist()
          .then(function (granted) {
            if (granted) {
              console.log('[EquipMatrix] navigator.storage.persist() granted — IDB is durable.');
            } else {
              console.log(
                '[EquipMatrix] navigator.storage.persist() not granted — IDB remains best-effort. ' +
                  'This does not mean data will be lost; it means the browser may evict it under pressure.',
              );
            }
          })
          .catch(function (e) {
            console.warn('[EquipMatrix] navigator.storage.persist() failed:', e);
          });
      }
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
      // Compute diff for replace mode: compare old row IDs vs new row IDs.
      var _replaceDiffHtml = '';
      if (_emImportMode === 'replace') {
        var _newIdSet = {};
        merged.rows.forEach(function (r) {
          _newIdSet[r.id] = true;
        });
        var _oldIds = Object.keys(_replaceNotesMap);
        var _addedCount = 0;
        var _removedCount = 0;
        var _updatedCount = 0;
        merged.rows.forEach(function (r) {
          if (_replaceNotesMap[r.id]) {
            _updatedCount++;
          } else {
            _addedCount++;
          }
        });
        _oldIds.forEach(function (id) {
          if (!_newIdSet[id]) _removedCount++;
        });
        var _removedBuildings = Object.keys(_oldBuildingSet).filter(function (b) {
          return !importBuildings[b];
        });
        var _diffParts = [];
        if (_addedCount > 0) _diffParts.push('+' + _addedCount + ' added');
        if (_removedCount > 0) _diffParts.push('−' + _removedCount + ' removed');
        if (_updatedCount > 0) _diffParts.push(_updatedCount + ' updated');
        if (_notesPreservedCount > 0) _diffParts.push(_notesPreservedCount + ' notes preserved');
        _replaceDiffHtml =
          '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;font-weight:600;color:var(--text)">' +
          'Changes vs. previous import:</div>' +
          '<div style="padding:1px 0">' +
          (_diffParts.length ? _diffParts.join(' &nbsp;|&nbsp; ') : 'No changes') +
          '</div>';
        if (_removedBuildings.length > 0) {
          _replaceDiffHtml +=
            '<div style="margin-top:6px;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:6px 8px;color:#92400e;font-weight:600">' +
            'WARNING: The following building' +
            (_removedBuildings.length > 1 ? 's were' : ' was') +
            ' in the previous import but NOT in the new CSVs — those rows were removed:<br>' +
            '<span style="font-weight:400">' +
            _removedBuildings
              .map(function (b) {
                return '&bull; ' + b;
              })
              .join('<br>') +
            '</span>' +
            '<br><span style="font-weight:400;font-style:italic">To keep those buildings, re-import all CSVs together or use Import (not Re-Import).</span>' +
            '</div>';
        }
      }

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
        _replaceDiffHtml +
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
      // Re-render the matrix immediately (modal is position:fixed so it stays on top);
      // the user closes the modal manually via the Done button or the × button.
      // Keep _emUploadTargetPid set to the current pid so a second file drop works.
      // (Setting it to null was the v409 bug: dropping a 2nd file then showed
      // "No project selected" because the pid had been cleared.)
      _emUploadTargetPid = pid;
      var container = document.getElementById('em-proj-wrap');
      if (container) emRenderMatrix(container, merged, pid);
      showToast(successMsg);
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
  emSaveMatrix(targetProjId, targetData).catch(() => {});
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
  // Note: air source mode/status are ASHRAE 36 Group 10 VVT control points — NOT excluded
  /smoke\s*(detector|zone|alarm|damper|stat)?/i,
  /\bsmoke\b/i,
  /\bbacnet\s+schedule\b/i, // BACnet Schedule objects only (not occupancy/zone schedule control points)
  /\bruntime\b/i,
  /run\s*hours?/i,
  /energy.*month/i,
  /energy.*year/i,
  /monthly.*energy/i,
  /yearly.*energy/i,
  /\b(peak\s+demand|interval\s+demand|billing\s+demand|demand\s+meter|demand\s+kw|kw\s+demand|kwh\s+demand)\b/i, // billing/meter demand readings only (not BAS control demand points)
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
    // M4 Part C: default true so missing CO2 lowers audit coverage for AHU/VAV
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: true },
    { key: 'hasOAFlow', label: 'Has OA Flow Meter', default: false },
  ],
  vav: [
    { key: 'hasReheat', label: 'Has Reheat Coil', default: true },
    // M4 Part C: default true so missing CO2 lowers audit coverage for VAV zones
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: true },
    { key: 'hasOccSensor', label: 'Has Occupancy Sensor', default: false },
    // Phase 2 (setpoint-value-compliance): zone classification for GL36 §3.1.1.1 + §3.1.1.3.
    // type:'select' — renderer not yet built (Phase 2.3). options/default stored here for later.
    {
      key: 'zoneType',
      label: 'Zone Type (GL36 §3.1.1.1)',
      type: 'select',
      options: ['vav', 'mech_elec', 'networking'],
      default: 'vav',
    },
    {
      key: 'occupancyCat',
      label: 'Occupancy Category (GL36 Table 3.1.1.3)',
      type: 'select',
      options: 'Object.keys(GL36_CO2_DEFAULTS)',
      default: 'office_space',
    },
  ],
  fpb: [
    { key: 'hasReheat', label: 'Has Reheat Coil', default: true },
    { key: 'isSeries', label: 'Series Fan (vs Parallel)', default: false },
    // M4 Part C: default true so missing CO2 lowers audit coverage for FPB zones
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: true },
    // Phase 2 (setpoint-value-compliance): zone classification for GL36 §3.1.1.1 + §3.1.1.3.
    {
      key: 'zoneType',
      label: 'Zone Type (GL36 §3.1.1.1)',
      type: 'select',
      options: ['vav', 'mech_elec', 'networking'],
      default: 'vav',
    },
    {
      key: 'occupancyCat',
      label: 'Occupancy Category (GL36 Table 3.1.1.3)',
      type: 'select',
      options: 'Object.keys(GL36_CO2_DEFAULTS)',
      default: 'office_space',
    },
  ],
  ddvav: [
    // M4 Part C: default true so missing CO2 lowers audit coverage for DD-VAV zones
    { key: 'hasCO2', label: 'Has CO2 Sensor', default: true },
    { key: 'hasOccSensor', label: 'Has Occupancy Sensor', default: false },
    // Phase 2 (setpoint-value-compliance): zone classification for GL36 §3.1.1.1 + §3.1.1.3.
    {
      key: 'zoneType',
      label: 'Zone Type (GL36 §3.1.1.1)',
      type: 'select',
      options: ['vav', 'mech_elec', 'networking'],
      default: 'vav',
    },
    {
      key: 'occupancyCat',
      label: 'Occupancy Category (GL36 Table 3.1.1.3)',
      type: 'select',
      options: 'Object.keys(GL36_CO2_DEFAULTS)',
      default: 'office_space',
    },
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
  // Phase 2 (setpoint-value-compliance): zone + fcu categories added so zoneType/occupancyCat
  // flags are accessible for equipment imported under these category keys.
  zone: [
    {
      key: 'zoneType',
      label: 'Zone Type (GL36 §3.1.1.1)',
      type: 'select',
      options: ['vav', 'mech_elec', 'networking'],
      default: 'vav',
    },
    {
      key: 'occupancyCat',
      label: 'Occupancy Category (GL36 Table 3.1.1.3)',
      type: 'select',
      options: 'Object.keys(GL36_CO2_DEFAULTS)',
      default: 'office_space',
    },
  ],
  fcu: [
    {
      key: 'zoneType',
      label: 'Zone Type (GL36 §3.1.1.1)',
      type: 'select',
      options: ['vav', 'mech_elec', 'networking'],
      default: 'vav',
    },
    {
      key: 'occupancyCat',
      label: 'Occupancy Category (GL36 Table 3.1.1.3)',
      type: 'select',
      options: 'Object.keys(GL36_CO2_DEFAULTS)',
      default: 'office_space',
    },
  ],
};

/* ── GL36_TEMP_DEFAULTS ─────────────────────────────────────────────────────
   GL36-2021 Table 3.1.1.1, p.4 — Default zone temperature setpoints (°F)   */
var GL36_TEMP_DEFAULTS = {
  vav: { occHeat: 70, occCool: 75, unoccHeat: 60, unoccCool: 90, deadbandMin: 1, deadbandRec: 2 },
  mech_elec: { occHeat: 65, occCool: 85, unoccHeat: 65, unoccCool: 85, deadbandMin: 1, deadbandRec: 2 },
  networking: { occHeat: 65, occCool: 75, unoccHeat: 65, unoccCool: 75, deadbandMin: 1, deadbandRec: 2 },
};

/* ── GL36_CO2_DEFAULTS ──────────────────────────────────────────────────────
   GL36-2021 Table 3.1.1.3, pp.5-6 — Default CO2 setpoints (ppm)
   Values assume 400 ppm outdoor air, 90% steady-state per Lawrence 2008     */
var GL36_CO2_DEFAULTS = {
  /* Correctional Facilities */
  correctional_cell: { ppm: 965, label: 'Cell', group: 'Correctional Facilities' },
  correctional_dayroom: { ppm: 1656, label: 'Dayroom', group: 'Correctional Facilities' },
  correctional_guard: { ppm: 1200, label: 'Guard Stations', group: 'Correctional Facilities' },
  correctional_booking: { ppm: 1200, label: 'Booking/Waiting', group: 'Correctional Facilities' },
  /* Educational Facilities */
  edu_daycare_age4: { ppm: 1027, label: 'Day Care (Through Age 4)', group: 'Educational Facilities' },
  edu_daycare_sickroom: { ppm: 716, label: 'Day Care Sickroom', group: 'Educational Facilities' },
  edu_classroom_5_8: { ppm: 864, label: 'Classrooms (Age 5-8)', group: 'Educational Facilities' },
  edu_classroom_9plus: { ppm: 942, label: 'Classrooms (Age 9+)', group: 'Educational Facilities' },
  edu_lecture_classroom: { ppm: 1305, label: 'Lecture Classroom', group: 'Educational Facilities' },
  edu_lecture_hall: { ppm: 1305, label: 'Lecture Hall (Fixed Seats)', group: 'Educational Facilities' },
  edu_art_classroom: { ppm: 837, label: 'Art Classroom', group: 'Educational Facilities' },
  edu_science_lab: { ppm: 894, label: 'Science Laboratories', group: 'Educational Facilities' },
  edu_college_lab: { ppm: 894, label: 'University/College Lab', group: 'Educational Facilities' },
  edu_wood_metal_shop: { ppm: 1156, label: 'Wood/Metal Shop', group: 'Educational Facilities' },
  edu_computer_lab: { ppm: 965, label: 'Computer Lab', group: 'Educational Facilities' },
  edu_media_center: { ppm: 965, label: 'Media Center', group: 'Educational Facilities' },
  edu_music_theater: { ppm: 1620, label: 'Music/Theater/Dance', group: 'Educational Facilities' },
  edu_multiuse_assembly: { ppm: 1778, label: 'Multiuse Assembly', group: 'Educational Facilities' },
  /* Food and Beverage Service */
  food_restaurant: { ppm: 1418, label: 'Restaurant Dining Rooms', group: 'Food and Beverage Service' },
  food_cafeteria: { ppm: 1536, label: 'Cafeteria/Fast-Food Dining', group: 'Food and Beverage Service' },
  food_bars: { ppm: 1536, label: 'Bars, Cocktail Lounges', group: 'Food and Beverage Service' },
  /* General */
  general_break_room: { ppm: 1267, label: 'Break Rooms', group: 'General' },
  general_coffee: { ppm: 1185, label: 'Coffee Stations', group: 'General' },
  general_conference: { ppm: 1620, label: 'Conference/Meeting', group: 'General' },
  /* Hotels, Motels, Resorts, Dormitories */
  hotel_bedroom: { ppm: 910, label: 'Bedroom/Living Area', group: 'Hotels, Motels, Resorts, Dormitories' },
  hotel_barracks: { ppm: 1116, label: 'Barracks Sleeping Areas', group: 'Hotels, Motels, Resorts, Dormitories' },
  hotel_laundry_central: { ppm: 1249, label: 'Laundry Rooms, Central', group: 'Hotels, Motels, Resorts, Dormitories' },
  hotel_laundry_dwelling: { ppm: 983, label: 'Laundry Within Dwelling', group: 'Hotels, Motels, Resorts, Dormitories' },
  hotel_lobby: { ppm: 1494, label: 'Lobbies/Prefunction', group: 'Hotels, Motels, Resorts, Dormitories' },
  hotel_multipurpose: { ppm: 2250, label: 'Multipurpose Assembly', group: 'Hotels, Motels, Resorts, Dormitories' },
  /* Office Buildings */
  office_space: { ppm: 894, label: 'Office Space', group: 'Office Buildings' },
  office_reception: { ppm: 1656, label: 'Reception Areas', group: 'Office Buildings' },
  office_telephone: { ppm: 1872, label: 'Telephone/Data Entry', group: 'Office Buildings' },
  office_main_lobby: { ppm: 1391, label: 'Main Entry/Lobbies', group: 'Office Buildings' },
  /* Miscellaneous Spaces */
  misc_bank_vault: { ppm: 805, label: 'Bank Vaults/Safe Deposit', group: 'Miscellaneous Spaces' },
  misc_computer: { ppm: 738, label: 'Computer (Not Printing)', group: 'Miscellaneous Spaces' },
  misc_pharmacy: { ppm: 820, label: 'Pharmacy (Preparation Area)', group: 'Miscellaneous Spaces' },
  misc_photo_studio: { ppm: 983, label: 'Photo Studios', group: 'Miscellaneous Spaces' },
  misc_transport_waiting: { ppm: 1305, label: 'Transportation Waiting', group: 'Miscellaneous Spaces' },
  /* Public Assembly Spaces */
  pub_auditorium: { ppm: 1872, label: 'Auditorium Seating Area', group: 'Public Assembly Spaces' },
  pub_religious: { ppm: 1872, label: 'Place of Religious Worship', group: 'Public Assembly Spaces' },
  pub_courtroom: { ppm: 1872, label: 'Courtrooms', group: 'Public Assembly Spaces' },
  pub_legislative: { ppm: 1872, label: 'Legislative Chambers', group: 'Public Assembly Spaces' },
  pub_library: { ppm: 805, label: 'Libraries', group: 'Public Assembly Spaces' },
  pub_lobby: { ppm: 2628, label: 'Lobbies', group: 'Public Assembly Spaces' },
  pub_museum_childrens: { ppm: 1391, label: "Museums (Children's)", group: 'Public Assembly Spaces' },
  pub_museum_galleries: { ppm: 1620, label: 'Museum/Galleries', group: 'Public Assembly Spaces' },
  /* Retail */
  retail_sales: { ppm: 1069, label: 'Sales (Except Below)', group: 'Retail' },
  retail_mall: { ppm: 1620, label: 'Mall Common Areas', group: 'Retail' },
  retail_barbershop: { ppm: 1267, label: 'Barbershop', group: 'Retail' },
  retail_beauty_nails: { ppm: 723, label: 'Beauty and Nail Salons', group: 'Retail' },
  retail_pet_shop: { ppm: 709, label: 'Pet Shops (Animal Areas)', group: 'Retail' },
  retail_supermarket: { ppm: 1116, label: 'Supermarket', group: 'Retail' },
  retail_laundry: { ppm: 1322, label: 'Coin-operated Laundries', group: 'Retail' },
  /* Sports and Entertainment */
  sport_spectator: { ppm: 1778, label: 'Spectator Areas', group: 'Sports and Entertainment' },
  sport_disco: { ppm: 1440, label: 'Disco/Dance Floors', group: 'Sports and Entertainment' },
  sport_aerobics: { ppm: 1735, label: 'Health Clubs/Aerobics Room', group: 'Sports and Entertainment' },
  sport_weight_room: { ppm: 1232, label: 'Health Clubs/Weight Room', group: 'Sports and Entertainment' },
  sport_bowling: { ppm: 1232, label: 'Bowling Alley (Seating)', group: 'Sports and Entertainment' },
  sport_casino: { ppm: 1368, label: 'Gambling Casinos', group: 'Sports and Entertainment' },
  sport_arcade: { ppm: 894, label: 'Game Arcades', group: 'Sports and Entertainment' },
  sport_stages: { ppm: 1391, label: 'Stages, Studios', group: 'Sports and Entertainment' },
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
        /leaving air temp/i,
        /ahu.?sat/i,
        /supply.?temp/i,
        /sa temp/i,
        /\blat\b/i,
      ],
      aliases: [
        'sat',
        'supply air temp',
        'discharge air temp',
        'dat',
        'discharge air temperature',
        'discharge temp',
        'supply temp',
        'leaving air temp',
        'ahu supply temp',
        'sa temp',
        'supply-air temp',
        'ahu-sat',
        'lat',
      ],
      // M6 6B: block control objects, diagnostics, and mode-select points from ahu.sat
      negativeGuards: [
        /\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?|enable|lockout|output|bno)\b/i,
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
        'return temperature',
        'ra temp',
        'ahu return temp',
        'return-air temp',
        'ahu-rat',
        'return air temperature',
      ],
      // M6 6B: block control objects and diagnostics from ahu.rat
      negativeGuards: [/\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?)\b/i],
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
      // M6 6B: block control objects and diagnostics from ahu.mat
      negativeGuards: [/\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?)\b/i],
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
        // Belt-and-suspenders: match oatLive col key label variants after (live)-strip
        'oat (live)',
        'outdoor air temperature',
      ],
      // M6 6B: block lockouts, diagnostics, alarms from ahu.oat
      negativeGuards: [/\b(alarm|lockout|diagnostic|sensor\s+fail(ed|ure)?|enable|output)\b/i],
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
      // FIX5: "Building Static Pressure" must fall through to bldgPressure, not match here
      negativeGuards: [/\bbuilding\b/i],
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
      // M6 6B: block exhaust fans, relief fans, and unit-level disabled/enabled sentences
      negativeGuards: [/\b(exhaust|ef-?\d+|relief|return\s+fan|smoke|evac|destratif|disabled|enabled)\b/i],
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
      // M6 6B: block boiler fans, CT fans, stair fans, diagnostic and command objects
      negativeGuards: [
        /\b(boiler|ct-?\d+|tower\s*\d+|stair|pressuri[sz]ation|diagnostic|running|enable|command|msv|select)\b/i,
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
      required: true,
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
    // ── Phase 3a additions to AHU block ────────────────────────────────
    // C1: OA Relative Humidity — moved from ct-only to ahu (and added to ct separately)
    // Matches "Outside Air Humidity", "Outside Air Humidity - RNet", "Outdoor Humidity",
    // "Local Outside Air Humidity", "RTU Outside Air Humidity", "AmbientHumidity"
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.16',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /local.*out(?:side|door).*air.*hum/i,
        /rtu.*outside.*air.*hum/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
        /relative.?humidity.{0,10}(?:outside|outdoor|oa)/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'outside air humidity - rnet',
        'local outside air humidity',
        'local outdoor air humidity',
        'rtu outside air humidity',
        'ambient humidity',
      ],
    },
    // C2: OA Dewpoint — standalone category (previously mis-aliased to wet bulb in ct block)
    // Taxonomy: "Outside Air Dewpoint", "Outside Air Dew Point", "Current Dew Point"
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.16',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
    // K1: Demand Level — broadcast ANI present on all equipment
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.16',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    // A7: Preheat Coil Leaving Air Temperature
    {
      key: 'preheatAirTemp',
      label: 'Preheat Air Temperature',
      required: false,
      ashrae36Name: 'Preheat Air Temperature',
      ashrae36Section: '5.16',
      patterns: [/preheat\s+air\s+temp/i, /oa\s+pre.?coil\s+temp/i, /pre.?heat\s+coil\s+leaving/i],
      aliases: ['preheat air temperature', 'preheat air temp', 'oa pre-coil temperature', 'pre-heat coil leaving temp'],
    },
    // A8: Cooling Coil Leaving Air Temperature
    {
      key: 'clgCoilLvgTemp',
      label: 'Cooling Coil Leaving Air Temp',
      required: false,
      ashrae36Name: 'Cooling Coil Leaving Air Temperature',
      ashrae36Section: '5.16',
      patterns: [/cooling\s+coil\s+leaving\s+air/i, /clg\s+coil\s+lvg/i, /cooling\s+coil\s+leaving\s+temp/i],
      aliases: ['cooling coil leaving air temperature', 'cooling coil leaving air temp', 'clg coil leaving temp'],
    },
    // A9: Heating Coil Leaving Air Temperature
    {
      key: 'htgCoilLvgTemp',
      label: 'Heating Coil Leaving Air Temp',
      required: false,
      ashrae36Name: 'Heating Coil Leaving Air Temperature',
      ashrae36Section: '5.16',
      patterns: [/heating\s+coil\s+leaving\s+air/i, /htg\s+coil\s+lvg/i, /heating\s+coil\s+leaving\s+temp/i],
      aliases: ['heating coil leaving air temperature', 'heating coil leaving air temp', 'htg coil leaving temp'],
    },
    // D2: Return Air Humidity
    {
      key: 'rhReturn',
      label: 'Return Air Humidity',
      required: false,
      ashrae36Name: 'Return Air Relative Humidity',
      ashrae36Section: '5.16',
      patterns: [/return\s+air\s+hum/i, /\bra\s+hum\b/i],
      aliases: ['return air humidity', 'return air relative humidity', 'ra hum', 'ra humidity', 'ahu return humidity'],
    },
    // E2: Return Air CO2
    {
      key: 'co2Return',
      label: 'Return Air CO2',
      required: false,
      ashrae36Name: 'Return Air CO2',
      ashrae36Section: '5.16',
      patterns: [/\bra\s+co2\b/i, /return\s+air\s+co2/i, /return\s+co2/i],
      aliases: ['ra co2', 'return air co2', 'return co2', 'ahu co2', 'ahu-1 - co2', 'ahu-2 - co2'],
    },
    // G2: Duct Static Pressure Setpoint
    {
      key: 'dspSp',
      label: 'Duct Static Pressure Setpoint',
      required: false,
      ashrae36Name: 'Duct Static Pressure Setpoint',
      ashrae36Section: '5.16',
      patterns: [
        /supply\s+duct\s+static\s+set/i,
        /duct\s+static\s+set/i,
        /supply\s+fan\s+duct\s+static.*setpoint/i,
        /air\s+source\s+static\s+set\s?point/i,
      ],
      aliases: [
        'supply duct static set point',
        'duct static set point',
        'duct static setpoint',
        'supply duct static setpoint',
      ],
    },
    // G3: Return/Exhaust Duct Static
    {
      key: 'rdsp',
      label: 'Return / Exhaust Duct Static',
      required: false,
      ashrae36Name: 'Return Duct Static Pressure',
      ashrae36Section: '5.16',
      patterns: [/return\s+duct\s+static/i, /exhaust\s+static(?!\s+set)/i, /exhaust\s+duct\s+static/i],
      aliases: [
        'return duct static',
        'return duct static - smoothed',
        'exhaust static',
        'exhaust static - smoothed',
        'exhaust duct static pressure',
      ],
    },
    // H7: SAT Cooling Reset Setpoint
    {
      key: 'satCoolSp',
      label: 'SAT Cooling Setpoint',
      required: false,
      ashrae36Name: 'Supply Air Temperature Cooling Setpoint',
      ashrae36Section: '5.16',
      patterns: [/cooling\s+supply\s+air\s+set/i, /active\s+discharge\s+temp\s+set/i, /active\s+supply\s+air\s+set/i],
      aliases: [
        'cooling supply air set point',
        'active discharge temp setpoint',
        'active supply air setpoint',
        'sat cooling setpoint',
      ],
    },
    // H8: SAT Heating Reset Setpoint
    {
      key: 'satHtgSp',
      label: 'SAT Heating Setpoint',
      required: false,
      ashrae36Name: 'Supply Air Temperature Heating Setpoint',
      ashrae36Section: '5.16',
      patterns: [/heating\s+supply\s+air\s+set/i],
      aliases: ['heating supply air set point', 'sat heating setpoint', 'heat supply air setpoint'],
    },
    // H11: Economizer Setpoint
    {
      key: 'econSp',
      label: 'Economizer Setpoint',
      required: false,
      ashrae36Name: 'Economizer Setpoint',
      ashrae36Section: '5.16',
      configFlag: 'hasEconomizer',
      patterns: [/economizer\s+set\s?point/i, /economizer\s+control\s+temp/i, /oa\s+enable\s+setpoint/i],
      aliases: ['economizer set point', 'economizer setpoint', 'economizer control temp', 'oa enable setpoint'],
    },
    // F4: Ventilation CFM
    {
      key: 'ventCfm',
      label: 'Ventilation CFM',
      required: false,
      ashrae36Name: 'Ventilation Airflow',
      ashrae36Section: '5.16',
      patterns: [/ventilation\s+cfm/i],
      aliases: ['ventilation cfm', 'ventilation airflow'],
    },
    // F5: Ventilation CFM Setpoint
    {
      key: 'ventCfmSp',
      label: 'Ventilation CFM Setpoint',
      required: false,
      ashrae36Name: 'Ventilation Airflow Setpoint',
      ashrae36Section: '5.16',
      patterns: [/ventilation\s+cfm\s+set/i, /ventilation\s+cfm\s+setpoint/i],
      aliases: ['ventilation cfm set point', 'ventilation cfm setpoint'],
    },
    // F6: Return Fan CFM
    {
      key: 'rfCfm',
      label: 'Return Fan CFM',
      required: false,
      ashrae36Name: 'Return Fan Airflow',
      ashrae36Section: '5.16',
      configFlag: 'hasReturnFan',
      patterns: [/return\s+fan\s+cfm/i],
      aliases: ['return fan cfm', 'return fan airflow'],
    },
    // F7: Supply Fan CFM
    {
      key: 'sfCfm',
      label: 'Supply Fan CFM',
      required: false,
      ashrae36Name: 'Supply Fan Airflow',
      ashrae36Section: '5.16',
      patterns: [/supply\s+fan\s+(?:total\s+)?cfm/i],
      aliases: ['supply fan cfm', 'supply fan total cfm', 'supply fan 1 cfm', 'supply fan 2 cfm'],
    },
    // I6: Return Air Damper
    {
      key: 'raDamp',
      label: 'Return Air Damper',
      required: false,
      ashrae36Name: 'Return Air Damper Position',
      ashrae36Section: '5.16',
      configFlag: 'hasEconomizer',
      patterns: [/return\s+air\s+damper/i, /\bra\s+damper\b/i],
      aliases: ['return air damper', 'ra damper', 'return damper'],
    },
    // I7: Relief Damper
    {
      key: 'reliefDamp',
      label: 'Relief Damper',
      required: false,
      ashrae36Name: 'Relief Damper Position',
      ashrae36Section: '5.16',
      configFlag: 'hasReliefFan',
      patterns: [/relief\s+damper/i, /bldg\s+relief\s+damper/i],
      aliases: ['relief damper', 'relief damper feedback', 'bldg relief damper control'],
    },
    // J2: Return Fan VFD Speed
    {
      key: 'rfSpeed',
      label: 'Return Fan VFD Speed',
      required: false,
      ashrae36Name: 'Return Fan Speed',
      ashrae36Section: '5.16',
      configFlag: 'hasReturnFan',
      patterns: [/return\s+fan\s+vfd\s+speed/i, /return\s+fan\s+drive\s+output\s+speed/i, /return\s+fan.*speed/i],
      aliases: [
        'return fan vfd speed',
        'return fan drive output speed',
        'return fan speed',
        'rf vfd speed',
        'rf speed',
      ],
    },
    // J6: Supply Fan Amperage
    {
      key: 'sfAmps',
      label: 'Supply Fan Amperage',
      required: false,
      ashrae36Name: 'Supply Fan Amperage',
      ashrae36Section: '5.16',
      patterns: [/supply\s+fan\s+amperage/i, /supply\s+fan.*amps/i, /supply\s+fan\s+vfd\s+amps/i],
      aliases: ['supply fan amperage', 'supply fan amps', 'supply fan vfd amps', 'sf amps'],
    },
    // K1 (duplicate for ahu — same entry also added to each equipment block below)
    // Already added above as 'demandLevel'
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
      required: true,
      ashrae36Name: 'Zone CO2 Concentration',
      ashrae36Section: '5.6',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?ppm/i, /zone.?co2/i],
      aliases: ['zone co2', 'room co2', 'co2 sensor', 'co2 ppm', 'carbon dioxide', 'space co2'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.6',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.6',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.6',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
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
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.7',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.7',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.7',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
    // 40a0876a: FPB zones may carry CO2 sensors for DCV (ASHRAE 62.1). hasCO2 flag was wired
    // in EM_EQUIP_CONFIG_FLAGS but no category entry existed, so CO2 never surfaced in Audit view.
    {
      key: 'co2',
      label: 'Zone CO2 Sensor',
      required: false,
      ashrae36Name: 'Zone CO2 Concentration',
      ashrae36Section: '5.7 / DCV',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?ppm/i, /zone.?co2/i],
      aliases: ['zone co2', 'room co2', 'co2 sensor', 'co2 ppm', 'carbon dioxide', 'space co2'],
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
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.13',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.13',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.13',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
    // 40a0876a: DDVAV zones may carry CO2 sensors for DCV (ASHRAE 62.1). hasCO2 flag was wired
    // in EM_EQUIP_CONFIG_FLAGS but no category entry existed, so CO2 never surfaced in Audit view.
    {
      key: 'co2',
      label: 'Zone CO2 Sensor',
      required: false,
      ashrae36Name: 'Zone CO2 Concentration',
      ashrae36Section: '5.13 / DCV',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?ppm/i, /zone.?co2/i],
      aliases: ['zone co2', 'room co2', 'co2 sensor', 'co2 ppm', 'carbon dioxide', 'space co2'],
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
      // M6 6B: block chilled/domestic/DHW/high/low/alarm variants from matching hwst
      negativeGuards: [/\b(chw|chwst|domestic|dhw|high|low|alarm)\b/i],
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
      // M6 6B: block chilled/domestic/DHW/high/low/alarm/flow variants from matching hwrt
      negativeGuards: [/\b(chw|chwrt|domestic|dhw|high|low|alarm|flow)\b/i],
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
        // Belt-and-suspenders: match oatLive col key label variants after (live)-strip
        'oat (live)',
        'outdoor air temperature',
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
        'sec pump b status',
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
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.19',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.19',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.19',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
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
        // Belt-and-suspenders: match oatLive col key label variants after (live)-strip
        'oat (live)',
        'outdoor air temperature',
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
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.20',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: '5.20',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.20',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
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
      // Phase 3a: removed /dewpoint.?temp/i pattern and 'dewpoint temp' alias —
      // dewpoint is a distinct measurement from wet bulb; "Outside Air Dewpoint"
      // must map to oaDewpoint (new category), not be aliased to wet bulb.
      patterns: [/wet.?bulb/i, /\bwb\b.?temp/i, /oa.?wet.?bulb/i, /\boawb\b/i, /outdoor.?wb/i, /ambient.?wet.?bulb/i],
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
      ],
    },
    {
      key: 'oaRh',
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
    // M7: broadcast categories — present on all equipment types
    // Note: CT block already has 'oaRH' (capital H, legacy pre-Phase-3a). demandLevel and
    // oaDewpoint are new additions. oaRh (lowercase) is added alongside oaRH for consistency
    // with the broadcast standard used in all other blocks.
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: '5.21',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: '5.21',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
  ],

  /* ── M3 NEW TYPE: FCU (Fan Coil Unit / VRF indoor unit) ─────────────── */
  fcu: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: true,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: 'FCU',
      patterns: [/zone.?temp/i, /room.?temp/i, /space temp/i, /\bzat\b/i],
      aliases: ['zone temp', 'room temp', 'zone air temp', 'space temp', 'space temperature', 'zat'],
    },
    {
      key: 'coolSP',
      label: 'Cooling Setpoint',
      required: false,
      ashrae36Name: 'Zone Cooling Setpoint',
      ashrae36Section: 'FCU',
      patterns: [/cooling.?setpoint/i, /cool.?setpoint/i, /cooling occupied setpoint/i],
      aliases: ['cooling setpoint', 'cool setpoint', 'cooling sp', 'cooling occupied setpoint'],
    },
    {
      key: 'htgSP',
      label: 'Heating Setpoint',
      required: false,
      ashrae36Name: 'Zone Heating Setpoint',
      ashrae36Section: 'FCU',
      patterns: [/heating.?setpoint/i, /heat.?setpoint/i, /heating occupied setpoint/i],
      aliases: ['heating setpoint', 'heat setpoint', 'heating sp', 'heating occupied setpoint'],
    },
    {
      key: 'chwValve',
      label: 'CHW / Cooling Valve',
      required: false,
      ashrae36Name: 'Cooling Valve Position',
      ashrae36Section: 'FCU',
      patterns: [/chw.?valve/i, /cooling.?valve/i, /chilled water valve/i, /clg.?valve/i],
      aliases: ['chw valve', 'cooling valve', 'chilled water valve', 'clg valve'],
    },
    {
      key: 'hwValve',
      label: 'HW / Heating Valve',
      required: false,
      ashrae36Name: 'Heating Valve Position',
      ashrae36Section: 'FCU',
      patterns: [/hw.?valve/i, /heating.?valve/i, /hot water valve/i, /htg.?valve/i],
      aliases: ['hw valve', 'heating valve', 'hot water valve', 'htg valve'],
    },
    {
      key: 'fanStatus',
      label: 'Fan Status',
      required: false,
      ashrae36Name: 'Fan Status',
      ashrae36Section: 'FCU',
      patterns: [/fan.?status/i, /fan.?run/i, /fan speed/i, /fan.?enable/i],
      aliases: ['fan status', 'fan run', 'fan speed', 'fan enable'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'FCU',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'FCU',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'FCU',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
    // 2e6322d5: added co2 and zoneHumidity to fcu — fan-coil units may carry zone CO2 sensors
    // and zone RH sensors (per ASHRAE 62.1 DCV requirements). Without these, the audit view
    // shows no CO2 or humidity columns for FCU rows even when data is present.
    {
      key: 'co2',
      label: 'Zone CO2 Sensor',
      required: false,
      ashrae36Name: 'Zone CO2 Concentration',
      ashrae36Section: 'FCU / DCV',
      configFlag: 'hasCO2',
      patterns: [/\bco2\b/i, /carbon dioxide/i, /co2.?ppm/i, /zone.?co2/i],
      aliases: ['zone co2', 'room co2', 'co2 sensor', 'co2 ppm', 'carbon dioxide', 'space co2'],
    },
    {
      key: 'zoneHumidity',
      label: 'Zone Humidity',
      required: false,
      ashrae36Name: 'Zone Relative Humidity',
      ashrae36Section: 'FCU',
      patterns: [/zone.?humidity/i, /zone.?r\.?h/i, /space.?humidity/i, /\bhumidity\b/i, /zone\s+hum\b/i],
      aliases: ['zone humidity', 'zone rh', 'space humidity', 'humidity', 'zone hum', 'zone relative humidity'],
    },
  ],

  /* ── M3 NEW TYPE: Heater (unit heater / tube heater / infrared) ─────── */
  heater: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: false,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: 'Heater',
      patterns: [/zone.?temp/i, /room.?temp/i, /space temp/i],
      aliases: ['zone temp', 'room temp', 'space temp'],
    },
    {
      key: 'enable',
      label: 'Heater Enable / Status',
      required: true,
      ashrae36Name: 'Heater Enable Command',
      ashrae36Section: 'Heater',
      patterns: [
        /heater.?enable/i,
        /heater.?status/i,
        /unit heater.?enable/i,
        /uh.?status/i,
        /uh.?enable/i,
        /tube heater.?enable/i,
        /heater.?on.?off/i,
      ],
      aliases: [
        'heater enable',
        'heater status',
        'unit heater enable',
        'uh status',
        'uh enable',
        'tube heater enable',
        'heater on/off',
      ],
    },
    {
      key: 'oaEnable',
      label: 'OA Lockout Setpoint',
      required: false,
      ashrae36Name: 'OA Enable Setpoint',
      ashrae36Section: 'Heater',
      patterns: [/oa.?enable.?setpoint/i, /outdoor.?lockout/i, /oa.?lockout/i, /outside air setpoint/i],
      aliases: ['oa enable setpoint', 'outdoor lockout', 'oa lockout', 'outside air setpoint'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'Heater',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'Heater',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'Heater',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
  ],

  /* ── M3 NEW TYPE: EF (Exhaust Fan) ─────────────────────────────────── */
  ef: [
    {
      key: 'fanStatus',
      label: 'Fan Status / Enable',
      required: true,
      ashrae36Name: 'Exhaust Fan Status',
      ashrae36Section: 'EF',
      patterns: [
        /exhaust fan.?enable/i,
        /exhaust fan.?status/i,
        /ef.?enable/i,
        /ef.?status/i,
        /fan.?enable/i,
        /fan.?status/i,
      ],
      aliases: ['exhaust fan enable', 'exhaust fan status', 'ef enable', 'ef status', 'fan enable', 'fan status'],
    },
    {
      key: 'fanSpeed',
      label: 'VFD / Fan Speed',
      required: false,
      ashrae36Name: 'Fan Speed Command',
      ashrae36Section: 'EF',
      patterns: [/fan speed/i, /vfd.?speed/i, /ef.?speed/i, /exhaust.?vfd/i],
      aliases: ['fan speed', 'vfd speed', 'ef speed', 'exhaust vfd speed'],
    },
    {
      key: 'schedule',
      label: 'Schedule',
      required: false,
      ashrae36Name: 'Occupancy Schedule',
      ashrae36Section: 'EF',
      patterns: [/schedule/i, /occupancy/i, /occupied/i],
      aliases: ['schedule', 'occupancy', 'occupied'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'EF',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'EF',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'EF',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
  ],

  /* ── M3 NEW TYPE: DOAS (Dedicated Outdoor Air System / ERV) ─────────── */
  // M7: expanded with all base AHU categories + 21 Phase-3a categories.
  // DOAS physically runs the same sensor/control points as an AHU.
  doas: [
    {
      key: 'sat',
      label: 'Supply Air Temperature',
      required: true,
      ashrae36Name: 'Supply Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/supply air temp/i, /\bsat\b/i, /discharge air temp/i, /\bdat\b/i],
      aliases: ['supply air temp', 'sat', 'discharge air temp', 'dat'],
      // M7: carry negativeGuards from ahu.sat so control objects don't match here either
      negativeGuards: [
        /\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?|enable|lockout|output|bno)\b/i,
      ],
    },
    {
      key: 'rat',
      label: 'Return Air Temperature',
      required: false,
      ashrae36Name: 'Return Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/\brat\b/i, /return air temp/i, /ra temp/i, /return.?air.?temp/i],
      aliases: ['rat', 'return air temp', 'return temp', 'return temperature', 'ra temp', 'return air temperature'],
      negativeGuards: [/\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?)\b/i],
    },
    {
      key: 'mat',
      label: 'Mixed Air Temperature',
      required: false,
      ashrae36Name: 'Mixed Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/\bmat\b/i, /mixed air temp/i, /mix air temp/i],
      aliases: ['mat', 'mixed air temp', 'mix air temp', 'mixed-air temp'],
      negativeGuards: [/\b(pid|bacnet\s*pid|control\s+selection|diagnostic|sensor\s+fail(ure)?)\b/i],
    },
    {
      key: 'oat',
      label: 'Outdoor Air Temperature',
      required: false,
      ashrae36Name: 'Outdoor Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/\boat\b/i, /outdoor air temp/i, /outside air temp/i, /oa temp/i, /ambient temp/i],
      aliases: ['oat', 'outdoor air temp', 'outside air temp', 'oa temp', 'ambient temp', 'outdoor temp'],
      negativeGuards: [/\b(alarm|lockout|diagnostic|sensor\s+fail(ed|ure)?|enable|output)\b/i],
    },
    {
      key: 'sfSpeed',
      label: 'Supply Fan Speed',
      required: false,
      ashrae36Name: 'Supply Fan Speed',
      ashrae36Section: 'DOAS',
      patterns: [/supply fan.?speed/i, /sf.?speed/i, /fan speed feedback/i, /vfd speed feedback/i],
      aliases: ['sf speed', 'supply fan vfd feedback', 'fan speed feedback', 'vfd speed feedback', 'supply fan speed'],
      negativeGuards: [/\b(boiler|ct-?\d+|tower\s*\d+|stair|diagnostic|running|enable|command|msv|select)\b/i],
    },
    {
      key: 'dsp',
      label: 'Duct Static Pressure',
      required: false,
      ashrae36Name: 'Duct Static Pressure',
      ashrae36Section: 'DOAS',
      patterns: [/\bdsp\b/i, /duct static pressure/i, /duct static/i, /static pressure/i],
      aliases: ['dsp', 'duct static', 'static pressure', 'supply duct static', 'duct pressure'],
      // FIX5: "Building Static Pressure" must fall through to bldgPressure, not match here
      negativeGuards: [/\bbuilding\b/i],
    },
    {
      key: 'oaDamp',
      label: 'OA Damper Position',
      required: false,
      ashrae36Name: 'OA Damper Position',
      ashrae36Section: 'DOAS',
      patterns: [/oa.?damper/i, /outdoor air damper/i, /outside air damper/i, /econ.?damper/i],
      aliases: ['oa damper', 'outdoor air damper', 'outside air damper', 'econ damper'],
    },
    {
      key: 'clgValve',
      label: 'Cooling Coil Valve',
      required: false,
      ashrae36Name: 'Cooling Coil Valve Position Command',
      ashrae36Section: 'DOAS',
      patterns: [/chw.?valve/i, /cooling.?valve/i, /cooling coil valve/i, /chilled water valve/i, /clg.?valve/i],
      aliases: ['chw valve', 'cooling valve', 'cooling coil valve', 'chilled water valve', 'clg valve'],
    },
    {
      key: 'htgValve',
      label: 'Heating Coil Valve',
      required: false,
      ashrae36Name: 'Heating Coil Valve Position Command',
      ashrae36Section: 'DOAS',
      patterns: [
        /hw.?valve/i,
        /heating.?valve/i,
        /heating coil valve/i,
        /hot water valve/i,
        /htg.?valve/i,
        /preheat valve/i,
      ],
      aliases: ['hw valve', 'heating valve', 'heating coil valve', 'hot water valve', 'htg valve', 'preheat valve'],
    },
    {
      key: 'oaFlow',
      label: 'Outdoor Air Flow',
      required: false,
      ashrae36Name: 'Outdoor Air Flow',
      ashrae36Section: 'DOAS',
      patterns: [/oa.?flow/i, /outdoor air.?cfm/i, /outside air flow/i, /oa cfm/i],
      aliases: ['oa flow', 'outdoor air cfm', 'oa airflow', 'outside air flow', 'oa cfm'],
    },
    {
      key: 'ervWheel',
      label: 'Energy Recovery Wheel',
      required: false,
      ashrae36Name: 'Energy Recovery Wheel Speed / Status',
      ashrae36Section: 'DOAS',
      patterns: [/energy recovery wheel/i, /energy wheel/i, /erv wheel/i, /enthalpy wheel/i, /heat wheel/i],
      aliases: ['energy recovery wheel', 'energy wheel', 'erv wheel', 'enthalpy wheel', 'heat wheel'],
    },
    {
      key: 'bldgPressure',
      label: 'Building Pressure',
      required: false,
      ashrae36Name: 'Building Static Pressure',
      ashrae36Section: 'DOAS',
      patterns: [/building.?pressure/i, /bldg.?static/i, /building.?dp/i],
      aliases: ['building pressure', 'bldg static', 'building dp'],
    },
    {
      key: 'sfStatus',
      label: 'Supply Fan Status',
      required: true,
      ashrae36Name: 'Supply Fan Status',
      ashrae36Section: 'DOAS',
      patterns: [/supply fan.?status/i, /supply fan.?run/i, /sf.?status/i, /fan.?run/i],
      aliases: ['supply fan status', 'supply fan run', 'sf status', 'fan run'],
      negativeGuards: [/\b(exhaust|ef-?\d+|relief|return\s+fan|smoke|evac|destratif|disabled|enabled)\b/i],
    },
    // Phase 3a categories (copied from AHU block)
    {
      key: 'co2Return',
      label: 'Return Air CO2',
      required: false,
      ashrae36Name: 'Return Air CO2',
      ashrae36Section: 'DOAS',
      patterns: [/\bra\s+co2\b/i, /return\s+air\s+co2/i, /return\s+co2/i],
      aliases: ['ra co2', 'return air co2', 'return co2', 'return air co2 ani'],
    },
    {
      key: 'rhReturn',
      label: 'Return Air Humidity',
      required: false,
      ashrae36Name: 'Return Air Relative Humidity',
      ashrae36Section: 'DOAS',
      patterns: [/return\s+air\s+hum/i, /\bra\s+hum\b/i],
      aliases: ['return air humidity', 'return air relative humidity', 'ra hum', 'ra humidity'],
    },
    {
      key: 'dspSp',
      label: 'Duct Static Pressure Setpoint',
      required: false,
      ashrae36Name: 'Duct Static Pressure Setpoint',
      ashrae36Section: 'DOAS',
      patterns: [/supply\s+duct\s+static\s+set/i, /duct\s+static\s+set/i],
      aliases: ['supply duct static set point', 'duct static set point', 'duct static setpoint'],
    },
    {
      key: 'rdsp',
      label: 'Return / Exhaust Duct Static',
      required: false,
      ashrae36Name: 'Return Duct Static Pressure',
      ashrae36Section: 'DOAS',
      patterns: [/return\s+duct\s+static/i, /exhaust\s+static(?!\s+set)/i, /exhaust\s+duct\s+static/i],
      aliases: ['return duct static', 'exhaust static', 'exhaust duct static pressure'],
    },
    {
      key: 'satCoolSp',
      label: 'SAT Cooling Setpoint',
      required: false,
      ashrae36Name: 'Supply Air Temperature Cooling Setpoint',
      ashrae36Section: 'DOAS',
      patterns: [/cooling\s+supply\s+air\s+set/i, /active\s+discharge\s+temp\s+set/i, /active\s+supply\s+air\s+set/i],
      aliases: ['cooling supply air set point', 'active discharge temp setpoint', 'sat cooling setpoint'],
    },
    {
      key: 'satHtgSp',
      label: 'SAT Heating Setpoint',
      required: false,
      ashrae36Name: 'Supply Air Temperature Heating Setpoint',
      ashrae36Section: 'DOAS',
      patterns: [/heating\s+supply\s+air\s+set/i],
      aliases: ['heating supply air set point', 'sat heating setpoint'],
    },
    {
      key: 'econSp',
      label: 'Economizer Setpoint',
      required: false,
      ashrae36Name: 'Economizer Setpoint',
      ashrae36Section: 'DOAS',
      patterns: [/economizer\s+set\s?point/i, /economizer\s+control\s+temp/i, /oa\s+enable\s+setpoint/i],
      aliases: ['economizer set point', 'economizer setpoint', 'oa enable setpoint'],
    },
    {
      key: 'ventCfm',
      label: 'Ventilation CFM',
      required: false,
      ashrae36Name: 'Ventilation Airflow',
      ashrae36Section: 'DOAS',
      patterns: [/ventilation\s+cfm/i],
      aliases: ['ventilation cfm', 'ventilation airflow'],
    },
    {
      key: 'ventCfmSp',
      label: 'Ventilation CFM Setpoint',
      required: false,
      ashrae36Name: 'Ventilation Airflow Setpoint',
      ashrae36Section: 'DOAS',
      patterns: [/ventilation\s+cfm\s+set/i, /ventilation\s+cfm\s+setpoint/i],
      aliases: ['ventilation cfm set point', 'ventilation cfm setpoint'],
    },
    {
      key: 'rfCfm',
      label: 'Return Fan CFM',
      required: false,
      ashrae36Name: 'Return Fan Airflow',
      ashrae36Section: 'DOAS',
      patterns: [/return\s+fan\s+cfm/i],
      aliases: ['return fan cfm', 'return fan airflow'],
    },
    {
      key: 'sfCfm',
      label: 'Supply Fan CFM',
      required: false,
      ashrae36Name: 'Supply Fan Airflow',
      ashrae36Section: 'DOAS',
      patterns: [/supply\s+fan\s+(?:total\s+)?cfm/i],
      aliases: ['supply fan cfm', 'supply fan total cfm'],
    },
    {
      key: 'raDamp',
      label: 'Return Air Damper',
      required: false,
      ashrae36Name: 'Return Air Damper Position',
      ashrae36Section: 'DOAS',
      patterns: [/return\s+air\s+damper/i, /\bra\s+damper\b/i],
      aliases: ['return air damper', 'ra damper', 'return damper'],
    },
    {
      key: 'reliefDamp',
      label: 'Relief Damper',
      required: false,
      ashrae36Name: 'Relief Damper Position',
      ashrae36Section: 'DOAS',
      patterns: [/relief\s+damper/i, /bldg\s+relief\s+damper/i],
      aliases: ['relief damper', 'relief damper feedback', 'bldg relief damper control'],
    },
    {
      key: 'rfSpeed',
      label: 'Return Fan VFD Speed',
      required: false,
      ashrae36Name: 'Return Fan Speed',
      ashrae36Section: 'DOAS',
      patterns: [/return\s+fan\s+vfd\s+speed/i, /return\s+fan.*speed/i],
      aliases: ['return fan vfd speed', 'return fan speed', 'rf vfd speed', 'rf speed'],
    },
    {
      key: 'sfAmps',
      label: 'Supply Fan Amperage',
      required: false,
      ashrae36Name: 'Supply Fan Amperage',
      ashrae36Section: 'DOAS',
      patterns: [/supply\s+fan\s+amperage/i, /supply\s+fan.*amps/i, /supply\s+fan\s+vfd\s+amps/i],
      aliases: ['supply fan amperage', 'supply fan amps', 'supply fan vfd amps', 'sf amps'],
    },
    {
      key: 'preheatAirTemp',
      label: 'Preheat Air Temperature',
      required: false,
      ashrae36Name: 'Preheat Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/preheat\s+air\s+temp/i, /oa\s+pre.?coil\s+temp/i, /pre.?heat\s+coil\s+leaving/i],
      aliases: ['preheat air temperature', 'preheat air temp', 'oa pre-coil temperature'],
    },
    {
      key: 'clgCoilLvgTemp',
      label: 'Cooling Coil Leaving Air Temp',
      required: false,
      ashrae36Name: 'Cooling Coil Leaving Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/cooling\s+coil\s+leaving\s+air/i, /clg\s+coil\s+lvg/i, /cooling\s+coil\s+leaving\s+temp/i],
      aliases: ['cooling coil leaving air temperature', 'cooling coil leaving air temp', 'clg coil leaving temp'],
    },
    {
      key: 'htgCoilLvgTemp',
      label: 'Heating Coil Leaving Air Temp',
      required: false,
      ashrae36Name: 'Heating Coil Leaving Air Temperature',
      ashrae36Section: 'DOAS',
      patterns: [/heating\s+coil\s+leaving\s+air/i, /htg\s+coil\s+lvg/i, /heating\s+coil\s+leaving\s+temp/i],
      aliases: ['heating coil leaving air temperature', 'heating coil leaving air temp', 'htg coil leaving temp'],
    },
    // M7 broadcast categories
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'DOAS',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'DOAS',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'DOAS',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
  ],

  /* ── M3 NEW TYPE: Furnace (VVT air-source unit / split-system furnace) ─ */
  furnace: [
    {
      key: 'sfStatus',
      label: 'Supply Fan Status',
      required: true,
      ashrae36Name: 'Supply Fan Status',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/supply fan.?status/i, /supply fan.?run/i, /sf.?status/i, /fan.?status/i],
      aliases: ['supply fan status', 'supply fan run', 'sf status', 'fan status'],
    },
    {
      key: 'clgStage',
      label: 'DX Cooling Stage 1',
      required: false,
      ashrae36Name: 'Cooling Stage 1',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/cooling stage 1/i, /dx cooling/i, /stage 1 cool/i, /clg stage/i],
      aliases: ['cooling stage 1', 'dx cooling', 'stage 1 cool', 'clg stage 1'],
    },
    {
      key: 'gasHeat',
      label: 'Gas Heat Stage',
      required: false,
      ashrae36Name: 'Gas Heat Stage 1',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/gas heat/i, /heat stage/i, /heating stage/i, /burner/i],
      aliases: ['gas heat', 'heat stage', 'heating stage', 'burner enable'],
    },
    {
      key: 'vvtMode',
      label: 'VVT Mode',
      required: false,
      ashrae36Name: 'VVT Mode',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/vvt mode/i, /vvt.*mode/i],
      aliases: ['vvt mode', 'vvt mode av', 'vvt mode msv'],
    },
    {
      key: 'oaDamper',
      label: 'OA Damper',
      required: false,
      ashrae36Name: 'Outdoor Air Damper',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/oa.?damper/i, /outdoor air damper/i, /bypass damper/i, /supply air bypass/i],
      aliases: ['oa damper', 'outdoor air damper', 'bypass damper', 'supply air bypass damper'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'Furnace/VVT',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'Furnace/VVT',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'Furnace/VVT',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
      ],
    },
  ],

  /* ── M3 NEW TYPE: Zone (VVT zone-damper terminal) ───────────────────── */
  zone: [
    {
      key: 'zoneTemp',
      label: 'Zone Air Temperature',
      required: true,
      ashrae36Name: 'Zone Air Temperature',
      ashrae36Section: 'VVT Zone',
      patterns: [/zone.?temp/i, /room.?temp/i, /space temp/i],
      aliases: ['zone temp', 'room temp', 'zone air temp', 'space temp'],
    },
    {
      key: 'zoneHumidity',
      label: 'Zone Humidity',
      required: false,
      ashrae36Name: 'Zone Relative Humidity',
      ashrae36Section: 'VVT Zone',
      patterns: [/zone.?humidity/i, /zone.?r\.?h/i, /space.?humidity/i, /\bhumidity\b/i, /ambient.?humidity/i],
      aliases: ['zone humidity', 'zone rh', 'space humidity', 'humidity', 'ambient humidity'],
    },
    {
      key: 'zoneDamper',
      label: 'Zone Damper',
      required: true,
      ashrae36Name: 'Zone Damper Position Command',
      ashrae36Section: 'VVT Zone',
      patterns: [/zone damper/i, /damper.?position/i, /damper/i],
      aliases: ['zone damper', 'damper position', 'damper'],
    },
    {
      key: 'coolSP',
      label: 'Cooling Setpoint',
      required: true,
      ashrae36Name: 'Zone Cooling Setpoint',
      ashrae36Section: 'VVT Zone',
      patterns: [/cooling.?setpoint/i, /cool.?setpoint/i, /cooling occupied setpoint/i, /effective cooling setpoint/i],
      aliases: [
        'cooling setpoint',
        'cool setpoint',
        'cooling sp',
        'cooling occupied setpoint',
        'effective cooling setpoint',
      ],
    },
    {
      key: 'htgSP',
      label: 'Heating Setpoint',
      required: true,
      ashrae36Name: 'Zone Heating Setpoint',
      ashrae36Section: 'VVT Zone',
      patterns: [/heating.?setpoint/i, /heat.?setpoint/i, /heating occupied setpoint/i, /effective heating setpoint/i],
      aliases: [
        'heating setpoint',
        'heat setpoint',
        'heating sp',
        'heating occupied setpoint',
        'effective heating setpoint',
      ],
    },
    {
      key: 'airSourceVVT',
      label: 'Air Source VVT Mode',
      required: false,
      ashrae36Name: 'Air Source VVT Mode',
      ashrae36Section: 'VVT Zone',
      patterns: [/air source vvt/i, /asvvt/i],
      aliases: ['air source vvt', 'asvvt', 'air source vvt msv', 'air source vvt ani'],
    },
    // M7: broadcast categories — present on all equipment types
    {
      key: 'demandLevel',
      label: 'Demand Level',
      required: false,
      ashrae36Name: 'Demand Level',
      ashrae36Section: 'VVT Zone',
      patterns: [/\bdemand\s+level\b/i, /\bkw\s+demand\s+level\b/i],
      aliases: [
        'demand level',
        'kw demand level',
        'demand level 1',
        'demand level 2',
        'demand level 3',
        'demand level 4',
        'demand level 5',
      ],
    },
    {
      key: 'oaRh',
      label: 'Outdoor Air Relative Humidity',
      required: false,
      ashrae36Name: 'Outdoor Air Relative Humidity',
      ashrae36Section: 'VVT Zone',
      patterns: [
        /oa.?rh\b/i,
        /outdoor.{0,10}humidity/i,
        /outside.?air.?humidity/i,
        /outside\s+humidity/i,
        /ambient.?humidity/i,
        /(?:outside|outdoor|oa).{0,10}relative.?humidity/i,
      ],
      aliases: [
        'oa rh',
        'outdoor humidity',
        'outside air humidity',
        'outside humidity',
        'oa humidity',
        'outside air relative humidity',
        'outdoor air relative humidity',
        'oa relative humidity',
        'oat rh',
        'outdoor rh',
        'ambient rh',
        'oa-rh',
        'ambient humidity',
      ],
    },
    {
      key: 'oaDewpoint',
      label: 'Outdoor Air Dewpoint',
      required: false,
      ashrae36Name: 'Outdoor Air Dewpoint',
      ashrae36Section: 'VVT Zone',
      patterns: [
        /outside\s+air\s+dew\s?point/i,
        /outdoor\s+air\s+dew\s?point/i,
        /current\s+dew\s?point/i,
        /\boa\s+dew\s?point/i,
        /oa.?dewpoint/i,
      ],
      aliases: [
        'outside air dewpoint',
        'outside air dew point',
        'outdoor air dewpoint',
        'outdoor air dew point',
        'current dew point',
        'oa dewpoint',
        'oa dew point',
        'current dewpoint',
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
  return (
    name
      .toLowerCase()
      .replace(/[_\-\/\.#]/g, ' ')
      .replace(/\b(ahu|asu|rtu)\b/gi, 'ahu')
      // Strip digit sequences only (letters are preserved so "CHWP-1B" -> "chwp b"
      // and can match role-letter aliases like 'chwp b vfd status').
      // M7 goal (Sec Pump 1B Status matching secHWPumpStatus) is met via explicit
      // alias 'sec pump b status' added to secHWPumpStatus instead of a greedy strip.
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
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

// ── M6: CONTRADICTING_PAIRS for tokenized alias veto (6A) ───────────────
// Words in the alias -> words in the point NAME that contradict the alias meaning.
// If aliasTokens contains pair.aliasWord AND nameTokens contains any pair.nameVeto word,
// the alias match is vetoed. discharge/supply are NOT listed here — they are AHU synonyms.
var _EM_CONTRADICTING_PAIRS = [
  { aliasWord: 'chilled', nameVeto: ['hot', 'domestic', 'condenser'] },
  { aliasWord: 'hot', nameVeto: ['chilled', 'condenser', 'domestic'] },
  { aliasWord: 'domestic', nameVeto: ['chilled', 'condenser'] },
  { aliasWord: 'supply', nameVeto: ['return', 'exhaust'] },
  { aliasWord: 'return', nameVeto: ['supply', 'exhaust'] },
  { aliasWord: 'exhaust', nameVeto: ['supply', 'return'] },
  { aliasWord: 'fan', nameVeto: ['pump'] },
  { aliasWord: 'pump', nameVeto: ['fan'] },
  { aliasWord: 'heating', nameVeto: ['cooling', 'chilled'] },
  { aliasWord: 'cooling', nameVeto: ['heating'] },
];

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

  // M6 6C (Option A): track whether we are in the no-category all-fallback path.
  // When equipCategory is unknown, Tier 2 alias matching is SKIPPED entirely —
  // only Tier 1 (exact canonical) and Tier 3 (regex) fire. This prevents
  // equipment-specific aliases (e.g. discharge=supply at AHU) from polluting
  // cross-category lookups where the equipment context is unknown.
  var _skipTier2 = !cats.length;

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

    // ── negativeGuards check (M6 6B) ─────────────────────────────────
    // Applied before EVERY return in this loop. If rawName matches any guard
    // for this category, skip the category entirely (continue to next cat).
    var _negGuarded = false;
    if (cat.negativeGuards) {
      for (var gi = 0; gi < cat.negativeGuards.length; gi++) {
        if (cat.negativeGuards[gi].test(rawName)) {
          _negGuarded = true;
          break;
        }
      }
    }
    if (_negGuarded) continue;

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

    // ── Tier 2: Alias matching ───────────────────────────────────────
    // Skipped entirely when equipCategory is unknown (Option A, M6 6C).
    if (!_skipTier2) {
      var aliases = cat.aliases || [];
      for (var ai = 0; ai < aliases.length; ai++) {
        var aliasNorm = emNormalizePointName(aliases[ai]);
        // Tier 2a: exact alias match
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
        // Tier 2b: tokenized subset match + contradicting-word veto (M6 6A)
        // Replaces the old substring check (aliasNorm.length >= 4 && normDisplay.includes(aliasNorm)).
        // Step 1: tokenize
        var aliasTokens = aliasNorm.split(' ').filter(function (t) {
          return t.length > 0;
        });
        var nameTokens = normDisplay.split(' ').filter(function (t) {
          return t.length > 0;
        });
        // Step 2: all alias tokens must be present in name tokens
        var allPresent = aliasTokens.every(function (tok) {
          return nameTokens.indexOf(tok) !== -1;
        });
        if (!allPresent) continue;
        // Step 3: contradicting-word veto
        var vetoed = false;
        for (var vp = 0; vp < _EM_CONTRADICTING_PAIRS.length; vp++) {
          var pair = _EM_CONTRADICTING_PAIRS[vp];
          if (aliasTokens.indexOf(pair.aliasWord) !== -1) {
            for (var vv = 0; vv < pair.nameVeto.length; vv++) {
              if (nameTokens.indexOf(pair.nameVeto[vv]) !== -1) {
                vetoed = true;
                break;
              }
            }
          }
          if (vetoed) break;
        }
        if (vetoed) continue;
        // Step 4: match accepted (confidence medium — name has more words than alias)
        if (aliasTokens.length > 0) {
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
    // Skipped in no-category mode (same _skipTier2 gate as Tier 2) — Tier 3b is a
    // variant of alias matching and must not fire when equipment context is unknown.
    if (_skipTier2) continue;
    // Note: aliases array may be undefined if _skipTier2 path skipped the var declaration above.
    var aliases3b = cat.aliases || [];
    for (var ai2 = 0; ai2 < aliases3b.length; ai2++) {
      var aliasStripped = emNormalizePointNameStrip(aliases3b[ai2]);
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

/* ── emBuildColKeyToCatKey ──────────────────────────────────────────────────
   FIX A: builds (once) a reverse map from EM_POINT_MAP col keys to their
   EM_POINT_CATEGORIES category key per equipment type.

   Map shape:
     _emColKeyToCatKey[colKey][equipType] = {
       catKey, catLabel, ashrae36Name, ashrae36Section, required
     }

   This lets emComputeCompliance resolve col keys like 'zoneCoolSetpoint'
   directly to { catKey: 'coolSP' } for equipment type 'vav', bypassing the
   human-name regex matcher which does not understand internal identifiers.

   Build strategy: for each EM_POINT_MAP entry, use the entry's label as a
   probe and run emNormalizePointInner against each equipType in entry.cats.
   The label is designed to match its corresponding EM_POINT_CATEGORIES entry
   (tier 1 canonical or tier 2 alias), so this reliably resolves the mapping.  */
function emBuildColKeyToCatKey() {
  if (_emColKeyToCatKey !== null) return;
  _emColKeyToCatKey = {};
  for (var mi = 0; mi < EM_POINT_MAP.length; mi++) {
    var entry = EM_POINT_MAP[mi];
    var colKey = entry.col;
    var label = entry.label;
    var equipTypes = entry.cats || [];
    for (var ti = 0; ti < equipTypes.length; ti++) {
      var equipType = equipTypes[ti];
      var catDefs = EM_POINT_CATEGORIES[equipType];
      if (!catDefs) continue;
      // Try to find a matching category def by direct label/alias scan
      // (exact canonical + exact alias, Tier 1+2 only — no Tier 2b/Tier 3 regex here;
      //  also strips a trailing "(live)" or "live" suffix before matching so that
      //  EM_POINT_MAP labels like "OAT (Live)" resolve to "oat" and hit the right category)
      var normLabel = emNormalizePointName(label);
      // Strip trailing "(live)" or standalone "live" suffix (e.g. "oat (live)" → "oat")
      var normLabelStripped = normLabel
        .replace(/\s*\(live\)\s*$/, '')
        .replace(/\blive\s*$/, '')
        .trim();
      for (var ci = 0; ci < catDefs.length; ci++) {
        var cd = catDefs[ci];
        // Tier 1: canonical name match (try both raw and live-stripped label)
        var canonNorm = emNormalizePointName(cd.ashrae36Name || cd.label);
        var matched = normLabel === canonNorm || (normLabelStripped !== normLabel && normLabelStripped === canonNorm);
        // Tier 2: alias match (try both raw and live-stripped label)
        if (!matched && cd.aliases) {
          for (var ai = 0; ai < cd.aliases.length; ai++) {
            var aliasNorm = emNormalizePointName(cd.aliases[ai]);
            if (normLabel === aliasNorm || (normLabelStripped !== normLabel && normLabelStripped === aliasNorm)) {
              matched = true;
              break;
            }
          }
        }
        if (matched) {
          if (!_emColKeyToCatKey[colKey]) _emColKeyToCatKey[colKey] = {};
          _emColKeyToCatKey[colKey][equipType] = {
            catKey: cd.key,
            catLabel: cd.label,
            ashrae36Name: cd.ashrae36Name || cd.label,
            ashrae36Section: cd.ashrae36Section || null,
            required: !!cd.required,
          };
          break;
        }
      }
    }
  }
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
  // ── Module-level cache (keyed by row.id) ──
  // Bypass cache entirely when customMappings is provided: different call sites pass
  // different mapping sets (_auditStatsMaps, _footerMaps, etc.) and the first call
  // must not win for all subsequent ones.  Default (no customMappings) still caches.
  var _cacheId = !customMappings && equipRow && equipRow.id;
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

  // FIX A: ensure the reverse col-key map is built before first use
  emBuildColKeyToCatKey();

  // FIX A: build a deduplicated set of point names from all available sources:
  //   1. equipRow.points   — non-empty values (current + enriched-CSV col keys)
  //   2. equipRow.pointsRaw — all raw names including blank-value points
  //   3. emGetNormalizedPoints — col-key passthrough for already-mapped keys
  // Display value is always read from row.points[pointName]; blank-value points
  // from pointsRaw produce a colored cell with no text, which is correct.
  var _allPointNames = {};
  var _rawPtsObj = equipRow.pointsRaw || {};
  var _ptsObj = equipRow.points || {};
  // Source 1: row.points (non-empty values; also enriched-CSV col keys)
  var _ptsKeys = Object.keys(_ptsObj);
  for (var _pi = 0; _pi < _ptsKeys.length; _pi++) {
    _allPointNames[_ptsKeys[_pi]] = true;
  }
  // Source 2: row.pointsRaw (adds blank-value points absent from row.points)
  var _rawKeys = Object.keys(_rawPtsObj);
  for (var _ri2 = 0; _ri2 < _rawKeys.length; _ri2++) {
    _allPointNames[_rawKeys[_ri2]] = true;
  }
  // Source 3: emGetNormalizedPoints col keys (handles enriched-CSV rows where points
  // keys are already EM_POINT_MAP col keys like 'zoneAirTemp')
  var _normPts = emGetNormalizedPoints(equipRow);
  var _normKeys = Object.keys(_normPts);
  for (var _ni = 0; _ni < _normKeys.length; _ni++) {
    _allPointNames[_normKeys[_ni]] = true;
  }
  var rawNames = Object.keys(_allPointNames);

  // Build a set of covered category keys from matching point names
  var coveredKeys = {}; // key -> match result
  var coveredPoints = [];

  for (var ri = 0; ri < rawNames.length; ri++) {
    var pName = rawNames[ri];
    var match;
    // FIX A: if pName is a known EM_POINT_MAP col key, use the reverse map directly
    // to avoid running the human-name regex on an internal identifier like 'zoneCoolSetpoint'
    if (_emColKeyToCatKey[pName] && _emColKeyToCatKey[pName][category]) {
      var _catInfo = _emColKeyToCatKey[pName][category];
      match = {
        categoryKey: _catInfo.catKey,
        categoryLabel: _catInfo.catLabel,
        matchTier: 1,
        confidence: 'high',
        auditRelevant: true,
        ashrae36PointName: _catInfo.ashrae36Name,
        ashrae36Section: _catInfo.ashrae36Section,
        rawName: pName,
        required: _catInfo.required,
        configFlag: null,
      };
    } else {
      match = emNormalizePointWithCustom(pName, category, customMappings || []);
    }
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

/* ── emInferZoneType ────────────────────────────────────────────────────────
   Infers GL36 §3.1.1.1 zone type from equipment name and location string.
   Returns 'networking', 'mech_elec', or 'vav' (general, the safe fallback).
   Called by setpoint compliance engine (Phase 3) and config flag pre-fill (Phase 2.3).
   Standalone — not wired to any call sites yet.

   Keyword sets (case-insensitive, applied to equipName + ' ' + location):
     networking: server, network, \bidf\b, \bmdf\b, comms, telecom, data ?center
     mech_elec:  \bmer\b, \beer\b, \belec\b, electric, mechanical room, boiler,
                 chiller, pump room, generator
     vav:        everything else (most zones in office/courthouse/school)       */
function emInferZoneType(equipRow) {
  var haystack = ((equipRow.equipName || '') + ' ' + (equipRow.location || '')).toLowerCase();
  if (/server|network|\bidf\b|\bmdf\b|comms|telecom|data ?center/.test(haystack)) {
    return 'networking';
  }
  if (/\bmer\b|\beer\b|\belec\b|electric|mechanical room|boiler|chiller|pump room|generator/.test(haystack)) {
    return 'mech_elec';
  }
  return 'vav';
}

/* ── emComputeSetpointCompliance ────────────────────────────────────────────
   Phase 3 — Setpoint Value Compliance Engine.
   Compares actual BAS setpoint values against GL36-2021 defaults.
   Does NOT extend emComputeCompliance (that answers "present?"; this answers
   "value within limits?" — different shape, different call surface).

   Parameters:
     equipRow    — standard equipRow object (same as emComputeCompliance)
     configFlags — object from emLoadEquipConfigFlags(); uses .zoneType and
                   .occupancyCat if present; both fallback to inferred/defaults.
     overrides   — optional spOverrides object from emLoadSpOverrides(); if
                   omitted AND projId+rowId are derivable the caller should
                   pass it; defaults to {}.

   Checks performed (VAV / FPB / DDVAV / Zone categories):
     occHeat     — zone occupied heating setpoint vs GL36 default (±1°F)
     occCool     — zone occupied cooling setpoint vs GL36 default (±1°F)
     unoccHeat   — zone unoccupied heating setpoint vs GL36 default (±1°F)
     unoccCool   — zone unoccupied cooling setpoint vs GL36 default (±1°F)
     deadband    — occCool minus occHeat; <1°F→DEVIATION, 1–<2°F→PASS w/ note
     co2         — zone CO2 setpoint vs GL36 Table 3.1.1.3 default (±50 ppm)

   Status values:
     PASS          — within tolerance of GL36 default
     DEVIATION     — present but beyond tolerance; confirm intentional per §3.1.1.1
     NOT_SCHEDULED — point category expected but no numeric value in export
     NA            — check does not apply to this equipment or zone type

   Returns:
     { results, hasAnyData, hasAnyDeviation, hasAnyNotScheduled }             */
function emComputeSetpointCompliance(equipRow, configFlags, overrides) {
  var _empty = { results: [], hasAnyData: false, hasAnyDeviation: false, hasAnyNotScheduled: false };
  if (!equipRow) return _empty;

  // Only applies to zone-type equipment
  var cat = equipRow.category;
  var _zoneCategories = { vav: true, fpb: true, ddvav: true, zone: true, fcu: true };
  if (!cat || !_zoneCategories[cat]) return _empty;

  var flags = configFlags || {};
  var spOvr = overrides || {};

  // ── 1. Read setpoint values via emGetNormalizedPoints ───────────────────
  var pts = emGetNormalizedPoints(equipRow);
  function _toFloat(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  var occCool = _toFloat(pts.zoneCoolSetpoint);
  var occHeat = _toFloat(pts.zoneHtgSetpoint);
  var unoccCool = _toFloat(pts.zoneUnoccCoolSetpoint);
  var unoccHeat = _toFloat(pts.zoneUnoccHtgSetpoint);
  var co2Setpoint = _toFloat(pts.zoneCO2Setpoint);

  // ── 2. Determine zone type and look up GL36 temp limits ─────────────────
  var zoneType = flags.zoneType || emInferZoneType(equipRow);
  var tempLimits = GL36_TEMP_DEFAULTS[zoneType] || GL36_TEMP_DEFAULTS.vav;

  // ── 3. Determine occupancy category and CO2 limit ───────────────────────
  var occupancyCat = flags.occupancyCat || 'office_space';
  var co2Entry = GL36_CO2_DEFAULTS[occupancyCat] || GL36_CO2_DEFAULTS.office_space;
  var co2Default = co2Entry ? co2Entry.ppm : 894;

  // ── 4. Helper: build one result entry ────────────────────────────────────
  function _makeResult(checkKey, label, actual, gl36Default, toleranceAbs, deadbandOther) {
    var status, deviationNote;
    var intentionalFlag = spOvr[checkKey] === true;

    if (actual === null) {
      status = 'NOT_SCHEDULED';
      deviationNote = null;
    } else {
      var diff = Math.abs(actual - gl36Default);
      if (diff <= toleranceAbs) {
        status = 'PASS';
        deviationNote = null;
      } else {
        status = 'DEVIATION';
        var unit = toleranceAbs === 50 ? ' ppm' : '°F';
        deviationNote = 'Actual ' + actual + unit + ' vs GL36 default ' + gl36Default + unit;
      }
    }

    return {
      checkKey: checkKey,
      label: label,
      actualValue: actual,
      gl36Default: gl36Default,
      deadbandOtherValue: deadbandOther !== undefined ? deadbandOther : null,
      status: status,
      deviationNote: deviationNote,
      intentionalFlag: intentionalFlag,
    };
  }

  var results = [];

  // ── 5. Occupied heating setpoint ─────────────────────────────────────────
  results.push(_makeResult('occHeat', 'Occ Heat Setpoint', occHeat, tempLimits.occHeat, 1));

  // ── 6. Occupied cooling setpoint ─────────────────────────────────────────
  results.push(_makeResult('occCool', 'Occ Cool Setpoint', occCool, tempLimits.occCool, 1));

  // ── 7. Unoccupied heating setpoint ───────────────────────────────────────
  results.push(_makeResult('unoccHeat', 'Unocc Heat Setpoint', unoccHeat, tempLimits.unoccHeat, 1));

  // ── 8. Unoccupied cooling setpoint ───────────────────────────────────────
  results.push(_makeResult('unoccCool', 'Unocc Cool Setpoint', unoccCool, tempLimits.unoccCool, 1));

  // ── 9. Deadband check ────────────────────────────────────────────────────
  // deadband = occCool - occHeat; only when both present.
  // <1°F  → DEVIATION ('Deadband Xf below GL36 1f minimum')
  // 1–<2°F → PASS with note 'below recommended 2f deadband'
  // ≥2°F  → PASS
  var dbEntry;
  if (occCool === null || occHeat === null) {
    dbEntry = {
      checkKey: 'deadband',
      label: 'Deadband (Occ Cool − Occ Heat)',
      actualValue: null,
      gl36Default: tempLimits.deadbandMin,
      deadbandOtherValue: tempLimits.deadbandRec,
      status: 'NOT_SCHEDULED',
      deviationNote: null,
      intentionalFlag: spOvr['deadband'] === true,
    };
  } else {
    var db = occCool - occHeat;
    var dbStatus, dbNote;
    if (db < tempLimits.deadbandMin) {
      dbStatus = 'DEVIATION';
      dbNote = 'Deadband ' + db.toFixed(1) + '°F below GL36 ' + tempLimits.deadbandMin + '°F minimum';
    } else if (db < tempLimits.deadbandRec) {
      dbStatus = 'PASS';
      dbNote = 'Below recommended ' + tempLimits.deadbandRec + '°F deadband (actual ' + db.toFixed(1) + '°F)';
    } else {
      dbStatus = 'PASS';
      dbNote = null;
    }
    dbEntry = {
      checkKey: 'deadband',
      label: 'Deadband (Occ Cool − Occ Heat)',
      actualValue: db,
      gl36Default: tempLimits.deadbandMin,
      deadbandOtherValue: tempLimits.deadbandRec,
      status: dbStatus,
      deviationNote: dbNote,
      intentionalFlag: spOvr['deadband'] === true,
    };
  }
  results.push(dbEntry);

  // ── 10. CO2 setpoint ────────────────────────────────────────────────────
  // NA if: no zoneCO2Setpoint value AND no hasCO2 config flag set.
  // NOT_SCHEDULED if: hasCO2 flag is true but value is null.
  // Otherwise use normal PASS/DEVIATION logic (±50 ppm).
  var co2Status, co2Note;
  var hasCO2Flag = flags.hasCO2 === true;
  if (co2Setpoint === null && !hasCO2Flag) {
    results.push({
      checkKey: 'co2',
      label: 'CO₂ Setpoint',
      actualValue: null,
      gl36Default: co2Default,
      deadbandOtherValue: null,
      status: 'NA',
      deviationNote: null,
      intentionalFlag: spOvr['co2'] === true,
    });
  } else if (co2Setpoint === null) {
    // hasCO2 flag is true but no exported value
    results.push({
      checkKey: 'co2',
      label: 'CO₂ Setpoint',
      actualValue: null,
      gl36Default: co2Default,
      deadbandOtherValue: null,
      status: 'NOT_SCHEDULED',
      deviationNote: null,
      intentionalFlag: spOvr['co2'] === true,
    });
  } else {
    results.push(_makeResult('co2', 'CO₂ Setpoint', co2Setpoint, co2Default, 50));
  }

  // ── 11. Derive summary flags ─────────────────────────────────────────────
  var hasAnyData = false;
  var hasAnyDeviation = false;
  var hasAnyNotScheduled = false;
  for (var ri = 0; ri < results.length; ri++) {
    var r = results[ri];
    if (r.status === 'PASS' || r.status === 'DEVIATION') hasAnyData = true;
    if (r.status === 'DEVIATION') hasAnyDeviation = true;
    if (r.status === 'NOT_SCHEDULED') hasAnyNotScheduled = true;
  }

  return {
    results: results,
    hasAnyData: hasAnyData,
    hasAnyDeviation: hasAnyDeviation,
    hasAnyNotScheduled: hasAnyNotScheduled,
  };
}

/* ── emLoadSpOverrides / emSaveSpOverride ───────────────────────────────────
   Per-equipment intentional-deviation overrides for setpoint compliance.
   Mirrors the exact pattern of emLoadEquipConfigFlags/emSaveEquipConfigFlags.

   Storage: edits[rowId + '::spOverrides'] = { checkKey: true, ... }
   inside en_eqmatrix_edits_<projId>.

   emLoadSpOverrides(projId, rowId)
     Returns the overrides object for this row (e.g. { occCool: true }).
     Returns {} if none saved yet.

   emSaveSpOverride(projId, rowId, checkKey, isIntentional)
     Sets (isIntentional=true) or clears (isIntentional=false) a single key.
     Reads existing overrides first so other keys are preserved.              */
function emLoadSpOverrides(projId, rowId) {
  var editKey = 'en_eqmatrix_edits_' + projId;
  var edits = DB.get(editKey, {});
  return edits[rowId + '::spOverrides'] || {};
}

function emSaveSpOverride(projId, rowId, checkKey, isIntentional) {
  var editKey = 'en_eqmatrix_edits_' + projId;
  var edits = DB.get(editKey, {});
  var current = edits[rowId + '::spOverrides'] || {};
  if (isIntentional) {
    current[checkKey] = true;
  } else {
    delete current[checkKey];
  }
  edits[rowId + '::spOverrides'] = current;
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
    label: 'Supply Air Temperature Reset',
    ashrae36: '§5.16.2',
    equipTypes: ['ahu'],
    requiredCats: ['sat', 'oat', 'sfSpeed'],
    keyCats: ['sat', 'oat'],
  },
  {
    key: 'ahu_dsp_reset',
    label: 'Duct Static Pressure Reset',
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
    label: 'Freeze Protection',
    ashrae36: '§5.16.12',
    equipTypes: ['ahu'],
    requiredCats: ['freezeStat', 'mat'],
    keyCats: ['freezeStat'],
  },
  {
    key: 'ahu_min_oa',
    label: 'Minimum Outside Air',
    ashrae36: '§5.16.6',
    equipTypes: ['ahu'],
    requiredCats: ['oaDampCmd', 'sfSpeedCmd'],
    keyCats: ['oaDampCmd'],
  },
  {
    key: 'ahu_rf_control',
    label: 'Return Fan Control',
    ashrae36: '§5.16.5',
    equipTypes: ['ahu'],
    requiredCats: ['rfEnable', 'rfSpeedCmd'],
    keyCats: ['rfEnable'],
    configFlag: 'hasReturnFan',
  },

  /* ── VAV sequences ──────────────────────────────────────────────────── */
  {
    key: 'vav_zone_temp',
    label: 'Zone Temperature Control',
    ashrae36: '§5.6.1',
    equipTypes: ['vav', 'fpb', 'ddvav'],
    requiredCats: ['zoneTemp', 'coolSP', 'htgSP'],
    keyCats: ['zoneTemp'],
  },
  {
    // Only shown/counted when the unit actually exposes a damper command point
    // in the WebCTRL export. VVT-style zone terminals command the damper
    // internally over the VVT network and never surface a dampCmd BACnet point,
    // so this sequence is N/A for them (not a false "Not Ready").
    //
    // ddvav units use coldDampCmd / hotDampCmd instead of dampCmd. The sequence
    // is applicable for a ddvav if EITHER deck damper is present. Required cats
    // for ddvav default to both (ready only if both present); coldDampCmd is the
    // key cat so a unit missing only hotDampCmd is partial rather than blocked.
    // vav and fpb continue to use dampCmd for both applicability and evaluation.
    key: 'vav_damper_writeback',
    label: 'Damper Position Write-back',
    ashrae36: '§5.6.2',
    equipTypes: ['vav', 'fpb', 'ddvav'],
    requiredCats: ['dampCmd'],
    keyCats: ['dampCmd'],
    applicableIfCovered: 'dampCmd',
    // Per-type overrides for ddvav (dual-duct VAV) — uses separate category keys
    applicableIfCoveredByType: { ddvav: ['coldDampCmd', 'hotDampCmd'] },
    requiredCatsByType: { ddvav: ['coldDampCmd', 'hotDampCmd'] },
    keyCatsByType: { ddvav: ['coldDampCmd'] },
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
    label: 'Supply Temperature Reset',
    ashrae36: '§5.19.1',
    equipTypes: ['hwp'],
    requiredCats: ['hwst', 'oat', 'hwSetpoint'],
    keyCats: ['hwst', 'hwSetpoint'],
  },
  {
    key: 'hwp_pump_dp_reset',
    label: 'Pump Differential Pressure Reset',
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
    label: 'Supply Temperature Reset',
    ashrae36: '§5.20.1',
    equipTypes: ['chwp'],
    requiredCats: ['chwst', 'oat', 'chwSetpoint'],
    keyCats: ['chwst', 'chwSetpoint'],
  },
  {
    key: 'chwp_pump_dp_reset',
    label: 'Pump Differential Pressure Reset',
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

  /* ── DCV sequences ──────────────────────────────────────────────────── */
  {
    key: 'demandCtrl',
    label: 'Demand-Controlled Ventilation (AHU)',
    ashrae36: '§5.16',
    equipTypes: ['ahu'],
    requiredCats: ['co2', 'oaDampCmd'],
    keyCats: ['co2'],
    configFlag: 'hasCO2',
  },
  {
    key: 'vav_dcv',
    label: 'Demand-Controlled Ventilation (VAV)',
    ashrae36: '§5.6',
    equipTypes: ['vav', 'fpb', 'ddvav'],
    requiredCats: ['co2', 'dampCmd'],
    keyCats: ['co2'],
    configFlag: 'hasCO2',
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

    // Check applicableIfCovered — if defined, the sequence is N/A unless
    // the specified category key is actually present in the covered set.
    // Used for sequences like damper write-back that are meaningless for
    // units that don't expose that point (e.g. VVT-style zone terminals).
    // applicableIfCovered may be a string (single key) or an array (OR — any match passes).
    // applicableIfCoveredByType may provide per-type overrides (object mapping equip type to
    // a string or array); when present, it takes precedence over applicableIfCovered for the
    // matched type.
    var applicableCheck = null;
    if (seq.applicableIfCoveredByType && seq.applicableIfCoveredByType[category] !== undefined) {
      applicableCheck = seq.applicableIfCoveredByType[category];
    } else if (seq.applicableIfCovered) {
      applicableCheck = seq.applicableIfCovered;
    }
    if (applicableCheck !== null) {
      // Resolve to array for uniform OR check
      var checkKeys = Array.isArray(applicableCheck) ? applicableCheck : [applicableCheck];
      var anyPresent = false;
      for (var aki = 0; aki < checkKeys.length; aki++) {
        if (coveredSet[checkKeys[aki]]) {
          anyPresent = true;
          break;
        }
      }
      if (!anyPresent) {
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

    // Resolve per-type required/key cat overrides (e.g. ddvav uses different point keys)
    var requiredCats =
      seq.requiredCatsByType && seq.requiredCatsByType[category]
        ? seq.requiredCatsByType[category]
        : seq.requiredCats || [];
    var keyCatsResolved =
      seq.keyCatsByType && seq.keyCatsByType[category] ? seq.keyCatsByType[category] : seq.keyCats || [];

    // Evaluate which required categories are present and which are missing
    var presentCats = [];
    var missingCats = [];
    for (var ri = 0; ri < requiredCats.length; ri++) {
      var catKey = requiredCats[ri];
      if (coveredSet[catKey]) {
        presentCats.push(catKey);
      } else {
        missingCats.push(catKey);
      }
    }

    // Check if any key categories are missing
    var keyCats = keyCatsResolved;
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

/* ── _emCatKeyLabel ─────────────────────────────────────────────────────────
   Returns a human-readable label for a point category key by looking it up
   in ASHRAE36_GAP_DESCRIPTIONS (report-engine.js) or EM_POINT_CATEGORIES.
   Falls back to the raw key only when no label is found.                   */
var _emCatKeyLabelCache = null;
function _emCatKeyLabel(catKey) {
  // Build a flat key→label map on first call (lazy, cached).
  if (!_emCatKeyLabelCache) {
    _emCatKeyLabelCache = {};
    // First priority: ASHRAE36_GAP_DESCRIPTIONS.short (report-engine.js, same global scope)
    if (typeof ASHRAE36_GAP_DESCRIPTIONS !== 'undefined') {
      for (var gk in ASHRAE36_GAP_DESCRIPTIONS) {
        if (ASHRAE36_GAP_DESCRIPTIONS.hasOwnProperty(gk) && ASHRAE36_GAP_DESCRIPTIONS[gk].short) {
          _emCatKeyLabelCache[gk] = ASHRAE36_GAP_DESCRIPTIONS[gk].short;
        }
      }
    }
    // Second priority: EM_POINT_CATEGORIES[type][].label — fills in any key not in GAP_DESCRIPTIONS
    if (typeof EM_POINT_CATEGORIES !== 'undefined') {
      for (var et in EM_POINT_CATEGORIES) {
        if (!EM_POINT_CATEGORIES.hasOwnProperty(et)) continue;
        var cats = EM_POINT_CATEGORIES[et];
        for (var ci = 0; ci < cats.length; ci++) {
          var c = cats[ci];
          if (c.key && c.label && !_emCatKeyLabelCache[c.key]) {
            _emCatKeyLabelCache[c.key] = c.label;
          }
        }
      }
    }
  }
  return _emCatKeyLabelCache[catKey] || catKey;
}

/* ── emRenderSequenceCell ───────────────────────────────────────────────────
   Renders a single <td> for a sequence status column in audit view.
   Returns an HTML string.

   Status → visual:
     'ready'   — green  ✓  (all required points present)
     'partial' — amber  ~  (some points present, no key points missing)
     'blocked' — red    ✗  (key points missing)
     'na'      — gray   —  (not applicable)

   Tooltip shows present and missing point labels for quick diagnosis.      */
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
  // Resolve raw category keys to human-readable labels for tooltip display
  var presentList = (readiness.presentCats || []).map(_emCatKeyLabel).join(', ');
  var missingList = (readiness.missingCats || []).map(_emCatKeyLabel).join(', ');
  var tooltip = seqName + ' (' + (readiness.ashrae36 || '') + ')';
  if (presentList) tooltip += '\nPresent: ' + presentList;
  if (missingList) tooltip += '\nMissing: ' + missingList;

  if (status === 'ready') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(39,174,96,0.15);color:#27ae60;font-weight:700" ' +
      'title="' +
      emHtmlEsc(tooltip) +
      '">Yes</td>'
    );
  }
  if (status === 'partial') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(230,126,34,0.15);color:#e67e22;font-weight:700" ' +
      'title="' +
      emHtmlEsc(tooltip) +
      '">Partial</td>'
    );
  }
  if (status === 'blocked') {
    return (
      '<td style="' +
      baseStyle +
      'background:rgba(192,57,43,0.15);color:#c0392b;font-weight:700" ' +
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
      // Skip internal mapped keys (col keys — new or old alias) — mirrors Pass 2 of emGetNormalizedPoints
      if (_emKnownPointColKeys.has(ptKey) || _emColKeyAliases[ptKey]) continue;
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
  // Functional group assignments by label keywords — order matters (first match wins).
  // Phase 3a: reorganized to match the 10 intuitive subject-based groups from the locked taxonomy:
  //   Air Temperatures, Outside Air Conditions, Zone/Space Conditions, Water Temperatures,
  //   Airflow, Pressure, Setpoints, Valves & Dampers, Fans & Pumps, Demand/Mode/Occupancy.
  // Added "Humidity" group so RH/dewpoint/enthalpy land correctly and not in "Other".
  // "Outside Air Conditions" added so OAT, OA RH, OA Dewpoint, OA Enthalpy, OA Wet Bulb
  //   are grouped together, not scattered across Temperature/Other.
  var funcGroups = [
    {
      // Group 2 — Outside Air Conditions: OAT, OA RH, OA Dewpoint, OA Enthalpy, OA Wet Bulb
      // Test before Temperature so "Outdoor Air Temperature" lands here, not in Temperature.
      name: 'Outside Air Conditions',
      test: function (label) {
        return (
          /outdoor\s+air|outside\s+air|\boa\s+(temp|r\.?h|dewpoint|dew\s?point|enthalpy|wet\s+bulb|humid|relative)/i.test(
            label,
          ) ||
          /\boa\s+relative\s+humidity|\boa\s+humidity\b|outdoor\s+humidity|outside\s+humidity/i.test(label) ||
          /wet\s+bulb|dewpoint|dew\s+point/i.test(label)
        );
      },
    },
    {
      // Group 1 — Air Temperatures (AHU/RTU coil-level air temps)
      name: 'Air Temperatures',
      test: function (label) {
        return /\btemp(?:erature)?\b|\benthalpy\b/i.test(label);
      },
    },
    {
      // Group 3 — Zone/Space Conditions (zone-level sensors and setpoints)
      name: 'Zone/Space Conditions',
      test: function (label) {
        return /\bzone\b|\bspace\b|\broom\b/i.test(label);
      },
    },
    {
      // Group 4 — Water Temperatures (HW, CHW, CW, boiler)
      name: 'Water Temperatures',
      test: function (label) {
        return /\b(hot\s+water|chilled\s+water|condenser\s+water|hw|chw|cw|boiler|pool\s+water)\b/i.test(label);
      },
    },
    {
      // New: Humidity group so RH/dewpoint/humidity labels not in Outside Air still sort correctly
      name: 'Humidity',
      test: function (label) {
        return /humidity|relative\s+humidity|\brh\b|dewpoint|dew\s+point/i.test(label);
      },
    },
    {
      // Group 5 — Airflow
      name: 'Airflow',
      test: function (label) {
        return /airflow|cfm|\bflow\b/i.test(label);
      },
    },
    {
      // Group 6 — Pressure
      name: 'Pressure',
      test: function (label) {
        return /pressure|static/i.test(label);
      },
    },
    {
      // Group 7 — Setpoints (plant/AHU level; zone setpoints caught by Zone/Space above)
      name: 'Setpoints',
      test: function (label) {
        return /setpoint|set\s+point/i.test(label);
      },
    },
    {
      // Group 8 — Valves & Dampers
      name: 'Valves & Dampers',
      test: function (label) {
        return /valve|damper/i.test(label);
      },
    },
    {
      // Group 9 — Fans & Pumps
      name: 'Fans & Pumps',
      test: function (label) {
        return /fan|pump|vfd|speed|amperage|amps/i.test(label);
      },
    },
    {
      // Group 10 — Demand / Mode / Occupancy
      name: 'Demand/Mode/Occupancy',
      test: function (label) {
        return /demand|mode|occupancy|occupied|schedule|override/i.test(label);
      },
    },
    {
      // CO2 / IAQ — sensors not caught above
      name: 'CO2 / IAQ',
      test: function (label) {
        return /co2|carbon\s+dioxide|iaq/i.test(label);
      },
    },
    {
      // Status & Sensors catch-all before Other
      name: 'Status & Sensors',
      test: function (label) {
        return /status|sensor|freeze|plant|enable/i.test(label);
      },
    },
  ];

  // Phase 3a: added fcu, heater, ef, zone, furnace so their categories appear in
  // the Manage Mappings dropdown (previously only the first 7 were included).
  var catTypeOrder = ['ahu', 'vav', 'fpb', 'ddvav', 'hwp', 'chwp', 'ct', 'fcu', 'heater', 'ef', 'zone', 'furnace'];
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

  // d5fe0454: Guard against double-open — if modal is already present (e.g. user
  // clicked again while the deferred content was still loading), do nothing.
  if (document.getElementById('em-manage-mappings-overlay')) return;

  var data = emLoadMatrix(pid);
  if (!data) {
    showToast('Equipment data still loading — try again in a moment', 'warn');
    return;
  }
  var rows = data.rows || [];
  if (rows.length === 0) {
    showToast('No equipment data to analyse', 'warn');
    return;
  }

  // ── Fix d5fe0454: non-blocking modal build ────────────────────────────────
  // Previously the entire HTML was built synchronously, which caused the UI
  // thread to freeze for several seconds on large datasets (~2700 rows).
  // Now we: (1) insert the modal shell immediately so it renders, then
  // (2) compute+inject the row content in a deferred callback so the browser
  // can paint the loading state first.

  var thStyle =
    'padding:8px 12px;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;' +
    'letter-spacing:0.05em;text-align:left;border-bottom:1px solid var(--border);' +
    'position:sticky;top:0;background:var(--s1)';

  var sectionHeadStyle =
    'padding:8px 12px;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;' +
    'letter-spacing:0.06em;background:var(--s1);border-bottom:1px solid var(--border);' +
    'border-top:2px solid var(--border)';

  // Modal shell — tbody starts with a single loading row; content is injected below.
  var shellHtml =
    '<div id="em-manage-mappings-overlay" ' +
    'style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px" ' +
    'onclick="emCloseManageMappings(event)">' +
    '<div style="background:var(--s2);border:1px solid var(--border);border-radius:8px;width:860px;max-width:100%;' +
    'max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4)" ' +
    'onclick="event.stopPropagation()">' +
    '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:12px;flex-shrink:0">' +
    '<div style="flex:1">' +
    '<div style="font-size:14px;font-weight:700;color:var(--text)">Manage Point Mappings</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:4px" ' +
    'title="Map unrecognized BAS points to ASHRAE 36 categories. Hover any point name or count for details.">' +
    'Map unrecognized BAS points to ASHRAE 36 categories. Hover any point for details.' +
    '</div>' +
    '<div id="em-mm-summary" style="font-size:11px;color:var(--text3);margin-top:2px">Loading…</div>' +
    '</div>' +
    '<button onclick="emCloseManageMappings()" ' +
    'style="font-size:16px;background:none;border:none;color:var(--text2);cursor:pointer;padding:4px 8px;line-height:1;flex-shrink:0">X</button>' +
    '</div>' +
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
    '<tbody id="em-mm-tbody">' +
    '<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--text3);font-size:12px">Building point list…</td></tr>' +
    '</tbody>' +
    '</table>' +
    '</div>' +
    '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0">' +
    '<span style="font-size:11px;color:var(--text3);flex:1">Mappings are saved per project. Re-import is not required — the matrix re-renders immediately.</span>' +
    '<button onclick="emCloseManageMappings()" ' +
    'style="font-size:11px;padding:6px 16px;background:var(--s3);border:1px solid var(--border);color:var(--text);border-radius:4px;cursor:pointer;height:30px">Cancel</button>' +
    '<button id="em-mm-save-btn" onclick="emSaveManageMappings(\'' +
    pid +
    '\')" disabled ' +
    'style="font-size:11px;padding:6px 16px;background:var(--accent);border:none;color:#fff;border-radius:4px;cursor:pointer;height:30px;font-weight:600;opacity:0.6">Save Mappings</button>' +
    '</div>' +
    '</div>' +
    '</div>';

  var el = document.createElement('div');
  el.innerHTML = shellHtml;
  document.body.appendChild(el.firstChild);

  // Defer the expensive computation so the modal shell can paint first.
  setTimeout(function () {
    // Guard: modal may have been closed before we get here.
    var tbody = document.getElementById('em-mm-tbody');
    if (!tbody) return;

    // d5fe0454: wrap in try/catch so any unexpected exception surfaces as a toast
    // instead of silently swallowing the error and leaving the modal stuck on "Loading…".
    try {
      var allPoints = emGetAllPoints(rows);
      var customMappings = emLoadCustomMappings(pid);

      // Build lookup: normName -> mapping entry from existing custom mappings
      var existingCustomMap = {};
      for (var mi = 0; mi < customMappings.length; mi++) {
        var m = customMappings[mi];
        if (m.rawName) existingCustomMap[emNormalizePointName(m.rawName)] = m;
      }

      // Separate into unmatched and matched
      var unmatchedPoints = [];
      var matchedPoints = [];
      for (var pi = 0; pi < allPoints.length; pi++) {
        var pt = allPoints[pi];
        var normName = emNormalizePointName(pt.name);
        var hasCustom = !!existingCustomMap[normName];
        if (pt.status === 'unmatched' || hasCustom) {
          unmatchedPoints.push(pt);
        } else if (pt.status === 'matched') {
          matchedPoints.push(pt);
        }
        // excluded points are silently omitted
      }

      var allCatOptions = emBuildFunctionalCatOptions();

      // Count total occurrences for summary line
      var unmatchedTotalOccurrences = 0;
      for (var ui = 0; ui < unmatchedPoints.length; ui++) unmatchedTotalOccurrences += unmatchedPoints[ui].count;
      var matchedTotalOccurrences = 0;
      for (var mti = 0; mti < matchedPoints.length; mti++) matchedTotalOccurrences += matchedPoints[mti].count;

      // Update summary line
      var summaryEl = document.getElementById('em-mm-summary');
      if (summaryEl) {
        summaryEl.textContent =
          unmatchedPoints.length +
          ' unmatched  |  ' +
          matchedPoints.length +
          ' auto-matched  |  ' +
          (unmatchedTotalOccurrences + matchedTotalOccurrences) +
          ' total point occurrences';
      }

      // ── Build tbody HTML in chunks to stay non-blocking ───────────────────
      // Each chunk processes CHUNK_SIZE points before yielding via setTimeout.
      var CHUNK_SIZE = 80;
      var htmlParts = [];

      // Section 1 header
      htmlParts.push(
        '<tr><td colspan="4" style="' +
          sectionHeadStyle +
          'border-top:none">Unmatched Points (' +
          unmatchedPoints.length +
          ') — need mapping</td></tr>',
      );

      if (unmatchedPoints.length === 0) {
        htmlParts.push(
          '<tr><td colspan="3" style="padding:16px 12px;text-align:center;color:var(--text3);font-size:11px">' +
            'All points are matched — nothing needs mapping.</td></tr>',
        );
      } else {
        for (var upi = 0; upi < unmatchedPoints.length; upi++) {
          var up = unmatchedPoints[upi];
          var normUp = emNormalizePointName(up.name);
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
          htmlParts.push(
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
              '<td></td></tr>',
          );
        }
      }

      // Section 2 header + rows
      if (matchedPoints.length > 0) {
        htmlParts.push(
          '<tr><td colspan="4" style="' +
            sectionHeadStyle +
            '">Auto-Matched Points (' +
            matchedPoints.length +
            ') — verify these look correct</td></tr>',
        );
        for (var mpi = 0; mpi < matchedPoints.length; mpi++) {
          var mp = matchedPoints[mpi];
          var confColor = mp.confidence === 'high' ? '#27ae60' : mp.confidence === 'medium' ? '#e67e22' : '#888';
          var confLabel = mp.confidence === 'high' ? 'High' : mp.confidence === 'medium' ? 'Medium' : 'Low';
          var confTitle =
            'Auto-match confidence: ' +
            confLabel +
            '. Click Save if this looks correct, or use the Unmatched section to override.';
          var mCountTitle = 'This point appears on ' + mp.count + ' equipment row' + (mp.count !== 1 ? 's' : '');
          htmlParts.push(
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
              '</td></tr>',
          );
        }
      }

      // Inject in chunks so the UI thread stays responsive during large builds.
      var chunkIdx = 0;
      function injectChunk() {
        var tbodyNow = document.getElementById('em-mm-tbody');
        if (!tbodyNow) return; // modal was closed
        if (chunkIdx === 0) tbodyNow.innerHTML = ''; // clear the loading row on first chunk
        var end = Math.min(chunkIdx + CHUNK_SIZE, htmlParts.length);
        var fragment = htmlParts.slice(chunkIdx, end).join('');
        tbodyNow.insertAdjacentHTML('beforeend', fragment);
        chunkIdx = end;
        if (chunkIdx < htmlParts.length) {
          setTimeout(injectChunk, 0);
        } else {
          // All rows injected — enable Save button
          var saveBtn = document.getElementById('em-mm-save-btn');
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
          }
        }
      }
      injectChunk();
    } catch (e) {
      // d5fe0454: surface unexpected exceptions so the user sees what went wrong
      // instead of the modal staying stuck on "Building point list..."
      console.error('[EM] emOpenManageMappings deferred build failed:', e);
      var tbodyErr = document.getElementById('em-mm-tbody');
      if (tbodyErr) {
        tbodyErr.innerHTML =
          '<tr><td colspan="4" style="padding:24px;text-align:center;color:#ef4444;font-size:12px">' +
          'Error building point list — check browser console for details. Try closing and reopening.' +
          '</td></tr>';
      }
      if (typeof showToast === 'function') {
        showToast('Manage Mappings failed to load — see console for details', 'error');
      }
    }
  }, 0);
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
  _emPointNameCache = new Map(); // Milestone 1: also clear name lookup cache

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
