/* ── BAS ALARMS — Import + Analytics ──────────────────────────────────────────
   Storage key:  en_alarms_<projId>  — { importedAt: ISO, rows: AlarmRecord[] }
   AlarmRecord shape defined in baParseCSV().
   Views: Alarm Log (pivot), By Type (category bar), By Building (building bar),
          Timeline (hour-of-day histogram / date histogram with toggle).
   ──────────────────────────────────────────────────────────────────────────── */

'use strict';

var _baModalOpen = false;
var _baParsedPreview = null; // { rows: [], fileName: '' } while modal open
var _baSubtab = 'log'; // 'log' | 'bytype' | 'bybuilding' | 'timeline'
var _baPage = 0; // current page in pivot table (0-indexed)
var BA_PAGE_SIZE = 50;
var _baFilters = { building: '', category: '', state: '', ackd: '' };
var _baShowRTN = false; // DP-2: RTN rows excluded from charts by default
var _baShowSystem = true; // DP-3: (System) alarms shown in building chart by default
var _baTimelineMode = 'hour'; // 'hour' | 'date'
var _baCharts = {}; // { bytype: ChartInstance, bybuilding: ChartInstance, timeline: ChartInstance }
var _baDrillFilter = { dim: '', value: '' }; // dim: 'category'|'building'|'hour'|'date', value: string

// ── Sort state for Alarm Log ──
var _baSortCol = 'ts';
var _baSortDir = -1; // 1=asc, -1=desc — default: newest first

// ── RFC 4180 CSV parser ──────────────────────────────────────────────────────

/**
 * RFC 4180-compliant CSV parser.
 * Handles quoted fields with embedded commas, quotes, and newlines.
 * Returns array of rows, each row is an array of string values.
 * Leading/trailing whitespace is NOT trimmed from field values (preserves
 * raw values per "never hide file values" rule).
 */
function baSplitCSV(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQ = false;
  var i = 0;
  var len = text.length;

  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  len = text.length;

  while (i < len) {
    var ch = text[i];
    if (inQ) {
      if (ch === '"') {
        // Peek ahead: double-quote = escaped quote inside field
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          // Closing quote
          inQ = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQ = true;
        i++;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // Flush final field and row
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing empty row if file ends with newline
  if (rows.length > 0) {
    var last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
  }
  return rows;
}

// ── Building derivation helper ───────────────────────────────────────────────

function baBuildingFromLocation(loc) {
  var parts = (loc || '').split('/').filter(Boolean);
  // parts[0] = district/site root (e.g. "Louisburg School District")
  // parts[1] = building name when a specific building is targeted
  // If only the root segment is present (no building path) the alarm is
  // site-wide / BAS-level with no specific building. Both that case and the
  // legacy '(System)' fallback are unified under "System Wide".
  if (parts.length < 2) return 'System Wide';
  return parts[1];
}

// ── Acknowledged field parser ────────────────────────────────────────────────

/**
 * Parse the Acknowledged column.
 * Returns { acknowledged: bool, acknowledgedAt: Date|null, acknowledgedBy: string|null }
 * Format when present: "M/D/YYYY h:mm:ss AM/PM Name (username)"
 */
function baParseAcknowledged(val) {
  val = (val || '').trim();
  if (!val || val === 'Unacknowledged') {
    return { acknowledged: false, acknowledgedAt: null, acknowledgedBy: null };
  }
  // Extract date portion: leading date stamp M/D/YYYY H:MM:SS AM/PM
  var m = val.match(/^(\d+\/\d+\/\d{4}\s+\d+:\d+:\d+\s+(?:AM|PM))\s+(.*)/i);
  var acknowledgedAt = null;
  var acknowledgedBy = null;
  if (m) {
    acknowledgedAt = new Date(m[1]);
    if (isNaN(acknowledgedAt.getTime())) acknowledgedAt = null;
    // Remainder: "Name (username)" — extract name before the parenthesis
    var namePart = m[2].replace(/\s*\([^)]*\)\s*$/, '').trim();
    acknowledgedBy = namePart || null;
  }
  return { acknowledged: true, acknowledgedAt: acknowledgedAt, acknowledgedBy: acknowledgedBy };
}

// ── Main CSV parser ──────────────────────────────────────────────────────────

/**
 * Parse a WebCTRL alarm export CSV.
 * Returns { rows: AlarmRecord[], warnings: string[] }
 * Columns (0-indexed): S No, Date, Acknowledged, Category, Location,
 *   Source, Current State, To Do, Duration, Description, Acknowledge Comments
 */
function baParseCSV(text) {
  var allRows = baSplitCSV(text);
  if (!allRows.length) return { rows: [], warnings: ['File appears empty'] };

  // Validate header
  var headers = allRows[0].map(function (h) {
    return h.trim();
  });
  var expectedHeaders = [
    'S No',
    'Date',
    'Acknowledged',
    'Category',
    'Location',
    'Source',
    'Current State',
    'To Do',
    'Duration',
    'Description',
    'Acknowledge Comments',
  ];
  var warnings = [];
  for (var hi = 0; hi < expectedHeaders.length; hi++) {
    if (headers[hi] !== expectedHeaders[hi]) {
      warnings.push('Column ' + hi + ': expected "' + expectedHeaders[hi] + '", got "' + headers[hi] + '"');
    }
  }
  if (headers.length !== 11) {
    warnings.push('Expected 11 columns, found ' + headers.length);
  }

  var rows = [];
  for (var i = 1; i < allRows.length; i++) {
    var r = allRows[i];
    if (!r || r.length < 7) continue; // skip blank/truncated rows

    var ackParsed = baParseAcknowledged(r[2]);
    var ts = new Date(r[1]);
    if (isNaN(ts.getTime())) ts = null;

    rows.push({
      sNo: parseInt(r[0]) || i,
      ts: ts,
      acknowledged: ackParsed.acknowledged,
      acknowledgedAt: ackParsed.acknowledgedAt,
      acknowledgedBy: ackParsed.acknowledgedBy,
      category: (r[3] || '').trim(),
      location: (r[4] || '').trim(),
      building: baBuildingFromLocation((r[4] || '').trim()),
      source: (r[5] || '').trim(),
      state: (r[6] || '').trim(), // 'Offnormal' | 'Normal' | 'Fault'
      duration: (r[8] || '').trim(),
      description: (r[9] || '').trim(),
      comment: (r[10] || '').trim(),
    });
  }

  return { rows: rows, warnings: warnings };
}

// ── Storage helpers (mirrors btGetData/btSaveData exactly) ───────────────────

function baGetData(projId) {
  var data = sget('en_alarms_' + projId, null);
  if (data && Array.isArray(data.rows)) {
    // JSON round-trip converts Date objects to ISO strings; rehydrate on load
    data.rows.forEach(function (r) {
      if (r.ts && typeof r.ts === 'string') r.ts = new Date(r.ts);
      if (r.acknowledgedAt && typeof r.acknowledgedAt === 'string') r.acknowledgedAt = new Date(r.acknowledgedAt);
      // Migrate legacy '(System)' label to 'System Wide' without re-import
      if (r.building === '(System)') r.building = 'System Wide';
    });
  }
  return data;
}

function baSaveData(projId, data) {
  return sset('en_alarms_' + projId, data);
}

// ── Import modal ─────────────────────────────────────────────────────────────

function baOpenImportModal() {
  if (_baModalOpen) return;
  _baModalOpen = true;

  var activeProjId = window._activeProjId || null;
  var projects = sget('en_projects', []);
  var activeProj = activeProjId
    ? projects.filter(function (p) {
        return p.id === activeProjId;
      })[0] || null
    : null;
  var activeProjName = activeProj ? activeProj.name || activeProj.id : activeProjId || '';

  // Build project options; pre-select active project when known
  var projOptions = projects
    .map(function (p) {
      var sel = activeProjId && p.id === activeProjId ? ' selected' : '';
      return '<option value="' + baEsc(p.id) + '"' + sel + '>' + baEsc(p.name || p.id) + '</option>';
    })
    .join('');

  // When _activeProjId is known: render NO visible project element at all —
  // only the hidden pre-selected <select> so baCheckImportReady()/baRunImport() work unchanged.
  // Defensive fallback: show the full picker if _activeProjId is null.
  var step1Html;
  if (activeProjId) {
    step1Html = [
      // Hidden select only — no visible project label or display box
      '<select id="ba-proj-sel" style="display:none;" onchange="baCheckImportReady()">',
      '<option value="">Select project...</option>',
      projOptions,
      '</select>',
    ].join('');
  } else {
    step1Html = [
      '<div style="margin-bottom:14px;">',
      '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;">Step 1 — Project</label>',
      '<select id="ba-proj-sel" style="width:100%;background:var(--s3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;" onchange="baCheckImportReady()">',
      '<option value="">Select project...</option>',
      projOptions,
      '</select>',
      '</div>',
    ].join('');
  }

  var html = [
    '<div id="ba-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:2000;display:flex;align-items:center;justify-content:center;" onclick="baCloseImportModal(event)">',
    '<div id="ba-modal" style="background:var(--s2);border:1px solid var(--border);border-radius:12px;width:600px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:24px;" onclick="event.stopPropagation()">',

    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">',
    '<h2 style="font-size:17px;font-weight:600;color:var(--text);">Import BAS Alarm Data</h2>',
    '<button onclick="baCloseImportModal()" style="background:none;border:none;color:var(--text3);font-size:20px;cursor:pointer;line-height:1;">&#x2715;</button>',
    '</div>',

    step1Html,

    // Drop zone (Step 1 when project locked — no visible project step; Step 2 when picker shown)
    '<div style="margin-bottom:14px;">',
    '<label style="display:block;font-size:12px;color:var(--text3);margin-bottom:6px;">' +
      (activeProjId ? 'Step 1' : 'Step 2') +
      ' — WebCTRL Alarm CSV</label>',
    '<div id="ba-drop-zone" ',
    'style="border:2px dashed var(--border);border-radius:8px;padding:32px 20px;text-align:center;cursor:pointer;transition:border-color 0.2s;" ',
    'onclick="document.getElementById(\'ba-file-input\').click()" ',
    'ondragover="event.preventDefault();this.style.borderColor=\'var(--accent)\'" ',
    'ondragleave="this.style.borderColor=\'var(--border)\'" ',
    'ondrop="baHandleDrop(event)">',
    '<div style="font-size:28px;margin-bottom:8px;">&#128196;</div>',
    '<div style="font-size:13px;color:var(--text2);">Drop WebCTRL alarm CSV here or click to browse</div>',
    '<div style="font-size:11px;color:var(--text3);margin-top:4px;">Standard WebCTRL alarm report export (11-column format)</div>',
    '<input id="ba-file-input" type="file" accept=".csv,.txt" style="display:none;" onchange="baHandleFileSelect(this)" />',
    '</div>',
    '<div id="ba-file-name" style="font-size:12px;color:var(--text3);margin-top:6px;"></div>',
    '</div>',

    // Progress
    '<div id="ba-progress-wrap" style="display:none;margin-bottom:14px;">',
    '<div style="font-size:12px;color:var(--text3);" id="ba-progress-msg">Parsing...</div>',
    '</div>',

    // Result
    '<div id="ba-import-result" style="display:none;"></div>',

    // Footer
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;border-top:1px solid var(--border);padding-top:16px;">',
    '<button onclick="baCloseImportModal()" style="background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>',
    '<button id="ba-import-btn" onclick="baRunImport()" disabled style="background:var(--accent);color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;opacity:0.5;">Import</button>',
    '</div>',

    '</div></div>',
  ].join('');

  var overlay = document.createElement('div');
  overlay.innerHTML = html;
  document.body.appendChild(overlay.firstElementChild);

  // Project is pre-selected; run readiness check now so Import enables as soon as CSV is dropped
  if (activeProjId) {
    baCheckImportReady();
  }
}

function baCloseImportModal(event) {
  if (event && event.target && event.target.id !== 'ba-modal-overlay') return;
  var el = document.getElementById('ba-modal-overlay');
  if (el) el.parentNode.removeChild(el);
  _baModalOpen = false;
  _baParsedPreview = null;
}

function baCheckImportReady() {
  var btn = document.getElementById('ba-import-btn');
  if (!btn) return;
  var proj = document.getElementById('ba-proj-sel');
  var ok = _baParsedPreview && proj && proj.value;
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
}

function baHandleDrop(event) {
  event.preventDefault();
  var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) baReadFile(file);
}

function baHandleFileSelect(input) {
  var file = input && input.files && input.files[0];
  if (file) baReadFile(file);
}

function baReadFile(file) {
  var nameEl = document.getElementById('ba-file-name');
  if (nameEl) nameEl.textContent = file.name;
  var reader = new FileReader();
  reader.onload = function (e) {
    var text = e.target.result;
    var progressEl = document.getElementById('ba-progress-wrap');
    if (progressEl) progressEl.style.display = '';
    var msgEl = document.getElementById('ba-progress-msg');
    if (msgEl) msgEl.textContent = 'Parsing CSV...';
    setTimeout(function () {
      var result = baParseCSV(text);
      _baParsedPreview = { rows: result.rows, warnings: result.warnings, fileName: file.name };
      if (msgEl) {
        msgEl.textContent = 'Found ' + result.rows.length + ' alarm records.';
        if (result.warnings.length) {
          msgEl.textContent += ' (' + result.warnings.length + ' format warnings)';
        }
      }
      baCheckImportReady();
    }, 10);
  };
  reader.readAsText(file);
}

function baRunImport() {
  if (!_baParsedPreview) return;
  var projId = document.getElementById('ba-proj-sel').value;
  if (!projId) return;

  var data = {
    importedAt: new Date().toISOString(),
    fileName: _baParsedPreview.fileName,
    rows: _baParsedPreview.rows,
  };
  baSaveData(projId, data).catch(function (e) {
    if (typeof showToast === 'function')
      showToast('Alarm data could not be saved: ' + ((e && e.message) || e), 'error');
  });

  var resultEl = document.getElementById('ba-import-result');
  if (resultEl) {
    var buildings = {};
    _baParsedPreview.rows.forEach(function (r) {
      buildings[r.building] = true;
    });
    var bCount = Object.keys(buildings).length;
    resultEl.style.display = '';
    resultEl.innerHTML =
      '<div style="background:var(--s3);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text);">' +
      '&#10003; Imported <strong>' +
      _baParsedPreview.rows.length +
      '</strong> alarm records from <strong>' +
      bCount +
      '</strong> buildings/systems.' +
      '</div>';
  }

  // Refresh the view if the alarm tab is currently open for this project
  if (String(window._activeProjId) === String(projId) && window._activeProjTab === 'bas-alarms') {
    baRenderView(projId);
  }

  setTimeout(function () {
    baCloseImportModal();
  }, 1500);
}

// ── View entry points ────────────────────────────────────────────────────────

function baInitView(projId) {
  baRenderView(projId);
}

function baRenderView(projId) {
  projId = projId || window._activeProjId || null;
  var body = document.getElementById('ptab-bas-alarms-body-' + projId);
  if (!body) return;

  if (!projId) {
    body.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text3);">Select a project to view BAS alarm data.</div>';
    return;
  }

  var data = baGetData(projId);
  if (!data || !data.rows || !data.rows.length) {
    body.innerHTML = [
      '<div style="padding:48px;text-align:center;">',
      '<div style="font-size:32px;margin-bottom:12px;">&#128680;</div>',
      '<div style="font-size:15px;color:var(--text2);margin-bottom:8px;">No alarm data imported yet</div>',
      '<div style="font-size:13px;color:var(--text3);margin-bottom:20px;">Import a WebCTRL alarm report CSV to begin analyzing alarm patterns.</div>',
      '<button onclick="baOpenImportModal()" style="background:var(--accent);color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:13px;">Import Alarm Data</button>',
      '</div>',
    ].join('');
    return;
  }

  // Tab bar
  var tabs = [
    { id: 'log', label: 'Alarm Log' },
    { id: 'bytype', label: 'By Type' },
    { id: 'bybuilding', label: 'By Building' },
    { id: 'timeline', label: 'Timeline' },
  ];
  var tabHtml = tabs
    .map(function (t) {
      var active = _baSubtab === t.id;
      return (
        '<button class="ba-stab' +
        (active ? ' ba-stab-active' : '') +
        '" data-tab="' +
        t.id +
        '" onclick="baSwitchSubtab(\'' +
        t.id +
        '\')">' +
        t.label +
        '</button>'
      );
    })
    .join('');

  var importedLabel = data.importedAt
    ? '<span style="font-size:11px;color:var(--text3);">Imported ' +
      data.rows.length +
      ' rows &bull; ' +
      new Date(data.importedAt).toLocaleDateString() +
      '</span>'
    : '';

  body.innerHTML = [
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--border);flex-shrink:0;">',
    '<div style="display:flex;gap:2px;padding:10px 0 0;">' + tabHtml + '</div>',
    '<div style="display:flex;gap:8px;align-items:center;padding-bottom:6px;">',
    importedLabel,
    '<button onclick="baOpenImportModal()" style="font-size:11px;background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:5px;cursor:pointer;">Re-import</button>',
    '</div>',
    '</div>',
    '<style>',
    '.ba-stab{font-family:var(--font);font-size:12px;font-weight:500;padding:6px 14px;border-radius:6px 6px 0 0;border:none;cursor:pointer;color:var(--text2);background:transparent;border-bottom:2px solid transparent;transition:all 0.13s;}',
    '.ba-stab.ba-stab-active{color:var(--em);border-bottom-color:var(--em);font-weight:600;}',
    '.ba-stab:hover:not(.ba-stab-active){color:var(--text);}',
    '</style>',
    '<div id="ba-subtab-body" style="flex:1;overflow-y:auto;min-height:0;padding:16px;"></div>',
  ].join('');

  baRenderSubtab(_baSubtab, data.rows);
}

function baSwitchSubtab(tab) {
  _baSubtab = tab;
  var btns = document.querySelectorAll('.ba-stab');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('ba-stab-active', btns[i].getAttribute('data-tab') === tab);
  }
  var projId = window._activeProjId || null;
  if (!projId) return;
  var data = baGetData(projId);
  if (data && data.rows) baRenderSubtab(tab, data.rows);
}

function baRenderSubtab(tab, rows) {
  var body = document.getElementById('ba-subtab-body');
  if (!body) return;
  // Destroy any existing Chart.js instances to prevent canvas reuse errors
  ['bytype', 'bybuilding', 'timeline'].forEach(function (k) {
    if (_baCharts[k]) {
      try {
        _baCharts[k].destroy();
      } catch (e) {}
      delete _baCharts[k];
    }
  });
  if (tab === 'log') baRenderLog(body, rows);
  else if (tab === 'bytype') baRenderByType(body, rows);
  else if (tab === 'bybuilding') baRenderByBuilding(body, rows);
  else if (tab === 'timeline') baRenderTimeline(body, rows);
}

// ── Inline hover tooltip helper ──────────────────────────────────────────────
// Used by Description cells in the alarm log. Shows a styled floating div that
// preserves line breaks (white-space:pre-wrap) — native title strips newlines.

function baTip(el, text) {
  var tip = document.getElementById('ba-tip-box');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'ba-tip-box';
    tip.style.cssText =
      'position:fixed;z-index:9999;max-width:360px;padding:8px 12px;' +
      'background:var(--s4);border:1px solid var(--border);border-radius:6px;' +
      'color:var(--text);font-size:12px;line-height:1.5;white-space:pre-wrap;' +
      'pointer-events:none;display:none;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.display = 'block';
  var rect = el.getBoundingClientRect();
  var tipLeft = Math.min(rect.left, window.innerWidth - 380);
  var tipTop = rect.bottom + 4;
  if (tipTop + 200 > window.innerHeight) tipTop = rect.top - 8 - tip.offsetHeight;
  tip.style.left = tipLeft + 'px';
  tip.style.top = tipTop + 'px';
}

function baTipHide() {
  var tip = document.getElementById('ba-tip-box');
  if (tip) tip.style.display = 'none';
}

// ── Component 1 — Alarm Log (pivot table) ───────────────────────────────────

function baRenderLog(body, rows) {
  // Build filter dropdowns from data
  var buildings = ['']
    .concat(
      baUnique(
        rows.map(function (r) {
          return r.building;
        }),
      ),
    )
    .sort();
  var categories = ['']
    .concat(
      baUnique(
        rows.map(function (r) {
          return r.category;
        }),
      ),
    )
    .sort();
  var states = ['', 'Offnormal', 'Fault', 'Normal'];
  var ackds = ['', 'Acknowledged', 'Unacknowledged'];

  var drillLabel = '';
  if (_baDrillFilter.dim && _baDrillFilter.value !== '') {
    var drillDimName =
      { category: 'Type', building: 'Building', hour: 'Hour', date: 'Date' }[_baDrillFilter.dim] || _baDrillFilter.dim;
    var drillDisplayValue = _baDrillFilter.dim === 'hour' ? _baDrillFilter.value + ':00' : _baDrillFilter.value;
    drillLabel =
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(0,212,170,0.12);border:1px solid rgba(0,212,170,0.35);border-radius:6px;margin-bottom:10px;font-size:12px;">' +
      '<span style="color:var(--em);">&#9654;</span>' +
      '<span style="color:var(--text);">Showing alarms for <strong>' +
      drillDimName +
      '</strong>: <strong>' +
      baEsc(drillDisplayValue) +
      '</strong></span>' +
      '<button onclick="baClearDrillFilter()" style="margin-left:auto;background:none;border:1px solid var(--border);color:var(--text2);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;" title="Clear chart filter">&times; Clear</button>' +
      '</div>';
  }

  var filterHtml =
    drillLabel +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">' +
    baSelect('ba-flt-building', buildings, _baFilters.building, 'Building', 'baApplyFilters()', 'All Buildings') +
    baSelect('ba-flt-category', categories, _baFilters.category, 'Category', 'baApplyFilters()', 'All Categories') +
    baSelect('ba-flt-state', states, _baFilters.state, 'State', 'baApplyFilters()', 'All States') +
    baSelect('ba-flt-ackd', ackds, _baFilters.ackd, 'Acknowledged', 'baApplyFilters()', 'All') +
    '<button onclick="baClearFilters()" style="font-size:11px;background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:5px;cursor:pointer;">Clear</button>' +
    '<button onclick="baDownloadFilteredCSV()" style="font-size:11px;background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:5px;cursor:pointer;margin-left:auto;">&#11015; CSV</button>' +
    '</div>';

  // Apply filters
  var filtered = baFilterRows(rows);

  // Sort
  filtered = baSortRows(filtered, _baSortCol, _baSortDir);

  // Paginate
  var totalPages = Math.max(1, Math.ceil(filtered.length / BA_PAGE_SIZE));
  if (_baPage >= totalPages) _baPage = totalPages - 1;
  var pageRows = filtered.slice(_baPage * BA_PAGE_SIZE, (_baPage + 1) * BA_PAGE_SIZE);

  // Row background tints removed — State column text color (var(--red/amber/green)) is sufficient.

  var thStyle =
    'padding:8px 10px;text-align:left;background:var(--s3);color:var(--text3);font-weight:500;font-size:11px;position:sticky;top:0;cursor:pointer;user-select:none;white-space:nowrap;position:relative;overflow:hidden;';
  var cols = [
    { key: 'ts', label: 'Date', minW: 140 },
    { key: 'building', label: 'Building', minW: 80 },
    { key: 'category', label: 'Category', minW: 80 },
    { key: 'source', label: 'Source', minW: 80 },
    { key: 'description', label: 'Description', minW: 120 },
    { key: 'state', label: 'State', minW: 70 },
    { key: 'duration', label: 'Duration', minW: 70 },
    { key: 'acknowledged', label: 'Acknowledged', minW: 100 },
  ];

  var theadHtml =
    '<thead><tr>' +
    cols
      .map(function (c, i) {
        var arrow = c.key === _baSortCol ? (_baSortDir === 1 ? ' &#9650;' : ' &#9660;') : '';
        return (
          '<th data-col="' +
          i +
          '" style="' +
          thStyle +
          '" onclick="baSortBy(\'' +
          c.key +
          '\')" title="Sort by ' +
          c.label +
          '">' +
          c.label +
          arrow +
          '<div class="col-resize-handle" data-col="' +
          i +
          '"></div>' +
          '</th>'
        );
      })
      .join('') +
    '</tr></thead>';

  var tbodyHtml =
    '<tbody>' +
    pageRows
      .map(function (r) {
        // bgStyle removed — no row background tinting
        var ackText = r.acknowledged
          ? '&#10003; ' + baEsc(r.acknowledgedBy || 'Acknowledged')
          : '<span style="color:var(--amber);">Unacknowledged</span>';
        var dateText = r.ts ? r.ts.toLocaleString() : '';
        return (
          '<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">' +
          '<td style="padding:7px 10px;font-size:12px;white-space:nowrap;color:var(--text2);">' +
          dateText +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:var(--text);">' +
          baEsc(r.building) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:var(--text);">' +
          baEsc(r.category) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:var(--text);">' +
          baEsc(r.source) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:var(--text2);white-space:normal;word-break:break-word;cursor:default;"' +
          (r.description
            ? ' data-desc="' +
              baEsc(r.description) +
              '" onmouseenter="baTip(this,this.dataset.desc)" onmouseleave="baTipHide()"'
            : '') +
          '>' +
          baEsc(r.description) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;font-weight:600;color:' +
          (r.state === 'Fault' ? 'var(--red)' : r.state === 'Offnormal' ? 'var(--amber)' : 'var(--green)') +
          ';">' +
          baEsc(r.state) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:var(--text3);">' +
          baEsc(r.duration) +
          '</td>' +
          '<td style="padding:7px 10px;font-size:12px;">' +
          ackText +
          '</td>' +
          '</tr>'
        );
      })
      .join('') +
    '</tbody>';

  var countLabel =
    '<div style="font-size:12px;color:var(--text3);margin-bottom:8px;">' +
    filtered.length +
    ' of ' +
    rows.length +
    ' records' +
    (filtered.length !== rows.length ? ' (filtered)' : '') +
    '</div>';

  var pagerHtml =
    totalPages > 1
      ? '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:12px;">' +
        '<button onclick="_baPage=Math.max(0,_baPage-1);baSwitchSubtab(\'log\')" ' +
        (_baPage === 0 ? 'disabled' : '') +
        ' style="background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:4px;cursor:pointer;">&#8249; Prev</button>' +
        '<span style="color:var(--text3);">Page ' +
        (_baPage + 1) +
        ' of ' +
        totalPages +
        '</span>' +
        '<button onclick="_baPage=Math.min(' +
        (totalPages - 1) +
        ",_baPage+1);baSwitchSubtab('log')\" " +
        (_baPage === totalPages - 1 ? 'disabled' : '') +
        ' style="background:var(--s3);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:4px;cursor:pointer;">Next &#8250;</button>' +
        '</div>'
      : '';

  body.innerHTML =
    filterHtml +
    countLabel +
    '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:6px;">' +
    '<table id="ba-log-table" style="width:100%;border-collapse:collapse;font-size:12px;">' +
    theadHtml +
    tbodyHtml +
    '</table>' +
    '</div>' +
    pagerHtml;

  // ── Resizable columns for Alarm Log ─────────────────────────────────────────
  // Self-contained; does NOT touch the Bills table in utility-data.js.
  (function () {
    var BA_COL_KEY = 'ba_alarm_log_col_widths';
    requestAnimationFrame(function () {
      var tbl = document.getElementById('ba-log-table');
      if (!tbl) return;

      // Measure natural widths from first body row (or header if no rows)
      var firstRow = tbl.querySelector('tbody tr:first-child');
      var rawWidths;
      if (firstRow) {
        rawWidths = Array.from(firstRow.querySelectorAll('td')).map(function (td) {
          return td.getBoundingClientRect().width;
        });
      } else {
        rawWidths = Array.from(tbl.querySelectorAll('thead th')).map(function (th) {
          return th.getBoundingClientRect().width;
        });
      }
      if (!rawWidths.length) return;

      // Also measure header widths so header text sets a minimum
      var hdrWidths = Array.from(tbl.querySelectorAll('thead th')).map(function (th) {
        return th.getBoundingClientRect().width;
      });

      // Load saved widths from DB
      var savedWidths = null;
      try {
        var s = DB.get(BA_COL_KEY);
        if (s) savedWidths = s;
      } catch (e) {}

      var widths = rawWidths.map(function (w, i) {
        var floor = Math.max(40, cols[i] ? cols[i].minW || 0 : 0);
        if (savedWidths && savedWidths[i]) return Math.max(floor, savedWidths[i]);
        var hw = hdrWidths[i] || 0;
        return Math.max(Math.ceil(w), Math.ceil(hw), floor);
      });

      function applyWidths(ws) {
        // Remove old colgroup
        var old = tbl.querySelector('colgroup');
        if (old) old.remove();
        var cg = document.createElement('colgroup');
        ws.forEach(function (w) {
          var col = document.createElement('col');
          col.style.width = w + 'px';
          cg.appendChild(col);
        });
        tbl.insertBefore(cg, tbl.firstChild);
        tbl.style.tableLayout = 'fixed';
        tbl.style.width =
          ws.reduce(function (s, w) {
            return s + w;
          }, 0) + 'px';
      }

      applyWidths(widths);

      // Wire resize drag — delegated on body element
      var _resizing = null;
      var _bodyEl = body; // captured from outer scope
      _bodyEl.addEventListener('mousedown', function (e) {
        var handle = e.target.closest ? e.target.closest('.col-resize-handle') : null;
        if (!handle || !handle.dataset.col) return;
        e.preventDefault();
        e.stopPropagation();
        var colIdx = parseInt(handle.dataset.col, 10);
        var th = tbl.querySelector('th[data-col="' + colIdx + '"]');
        if (!th) return;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        _resizing = { colIdx: colIdx, startX: e.clientX, startW: th.getBoundingClientRect().width, handle: handle };
      });
      document.addEventListener('mousemove', function (e) {
        if (!_resizing) return;
        var newW = Math.max(40, _resizing.startW + (e.clientX - _resizing.startX));
        var col = tbl.querySelector('colgroup col:nth-child(' + (_resizing.colIdx + 1) + ')');
        if (col) col.style.width = newW + 'px';
        var allCols = Array.from(tbl.querySelectorAll('colgroup col'));
        tbl.style.width =
          allCols.reduce(function (s, c) {
            return s + parseInt(c.style.width || 0, 10);
          }, 0) + 'px';
      });
      document.addEventListener('mouseup', function () {
        if (!_resizing) return;
        _resizing.handle.classList.remove('dragging');
        document.body.style.cursor = '';
        var currentWidths = Array.from(tbl.querySelectorAll('colgroup col')).map(function (c) {
          return parseInt(c.style.width || 0, 10);
        });
        try {
          DB.set(BA_COL_KEY, currentWidths);
        } catch (e) {}
        _resizing = null;
      });
    });
  })();
}

function baApplyFilters() {
  var b = document.getElementById('ba-flt-building');
  var c = document.getElementById('ba-flt-category');
  var s = document.getElementById('ba-flt-state');
  var a = document.getElementById('ba-flt-ackd');
  _baFilters.building = b ? b.value : '';
  _baFilters.category = c ? c.value : '';
  _baFilters.state = s ? s.value : '';
  _baFilters.ackd = a ? a.value : '';
  _baPage = 0;
  baSwitchSubtab('log');
}

function baClearFilters() {
  _baFilters = { building: '', category: '', state: '', ackd: '' };
  _baPage = 0;
  baSwitchSubtab('log');
}

function baFilterRows(rows) {
  return rows.filter(function (r) {
    // Manual dropdown filters
    if (_baFilters.building && r.building !== _baFilters.building) return false;
    if (_baFilters.category && r.category !== _baFilters.category) return false;
    if (_baFilters.state && r.state !== _baFilters.state) return false;
    if (_baFilters.ackd === 'Acknowledged' && !r.acknowledged) return false;
    if (_baFilters.ackd === 'Unacknowledged' && r.acknowledged) return false;
    // Chart drill-down filter
    if (_baDrillFilter.dim === 'category' && r.category !== _baDrillFilter.value) return false;
    if (_baDrillFilter.dim === 'building' && r.building !== _baDrillFilter.value) return false;
    if (_baDrillFilter.dim === 'hour' && r.ts) {
      if (r.ts.getHours() !== parseInt(_baDrillFilter.value, 10)) return false;
    }
    if (_baDrillFilter.dim === 'date' && r.ts) {
      var dk =
        r.ts.getFullYear() +
        '-' +
        String(r.ts.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(r.ts.getDate()).padStart(2, '0');
      if (dk !== _baDrillFilter.value) return false;
    }
    return true;
  });
}

function baSortBy(col) {
  if (_baSortCol === col) {
    _baSortDir *= -1;
  } else {
    _baSortCol = col;
    _baSortDir = 1;
  }
  _baPage = 0;
  baSwitchSubtab('log');
}

function baSortRows(rows, col, dir) {
  return rows.slice().sort(function (a, b) {
    var av = col === 'ts' ? (a.ts ? a.ts.getTime() : 0) : a[col] || '';
    var bv = col === 'ts' ? (b.ts ? b.ts.getTime() : 0) : b[col] || '';
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

function baApplyDrillFilter(dim, value) {
  _baDrillFilter = { dim: dim, value: value };
  _baPage = 0;
  baSwitchSubtab('log');
}

function baClearDrillFilter() {
  _baDrillFilter = { dim: '', value: '' };
  _baPage = 0;
  baSwitchSubtab('log');
}

// ── Component 2 — By Type (horizontal bar chart) ─────────────────────────────

function baRenderByType(body, rows) {
  // DP-2: Exclude RTN (Normal state) from charts by default — toggle available
  var chartRows = _baShowRTN
    ? rows
    : rows.filter(function (r) {
        return r.state !== 'Normal';
      });

  var counts = {};
  chartRows.forEach(function (r) {
    counts[r.category] = (counts[r.category] || 0) + 1;
  });
  var sorted = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });

  var toggleHtml =
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">' +
    '<label style="font-size:12px;color:var(--text3);display:flex;align-items:center;gap:6px;cursor:pointer;" title="Return-to-Normal events are State=Normal rows — the alarm cleared. Include them to see total event volume.">' +
    '<input type="checkbox" ' +
    (_baShowRTN ? 'checked' : '') +
    ' onchange="_baShowRTN=this.checked;baRenderSubtab(\'bytype\',window._baAllRows)" style="cursor:pointer;"> Include Return-to-Normal events' +
    '</label>' +
    '<span style="font-size:11px;color:var(--text3);">' +
    chartRows.length +
    ' events shown</span>' +
    '</div>';

  body.innerHTML =
    toggleHtml + '<div style="position:relative;height:400px;"><canvas id="ba-chart-bytype"></canvas></div>';

  // Store reference for toggle re-render
  window._baAllRows = rows;

  var ctx = document.getElementById('ba-chart-bytype');
  if (!ctx || typeof Chart === 'undefined') return;
  var cs = getComputedStyle(document.documentElement);
  var c_text = cs.getPropertyValue('--text').trim() || '#e2e8f0';
  var c_text2 = cs.getPropertyValue('--text2').trim() || '#94a3b8';
  var c_text3 = cs.getPropertyValue('--text3').trim() || '#64748b';
  _baCharts.bytype = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted,
      datasets: [
        {
          label: 'Alarm Count',
          data: sorted.map(function (k) {
            return counts[k];
          }),
          backgroundColor: 'rgba(0,212,170,0.75)',
          borderColor: 'rgba(0,212,170,1)',
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick: function (evt, elements) {
        if (!elements || !elements.length) return;
        var idx = elements[0].index;
        var label = sorted[idx];
        if (label != null) baApplyDrillFilter('category', label);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function (items) {
              return items[0].label;
            },
            footer: function () {
              return 'Click to filter log';
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Count', color: c_text3, font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.10)' },
          ticks: { color: c_text2, font: { size: 11 } },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: c_text, font: { size: 11 } },
        },
      },
    },
  });
}

// ── Component 3 — By Building (vertical bar chart) ───────────────────────────

function baRenderByBuilding(body, rows) {
  // DP-2: Exclude RTN by default
  var chartRows = _baShowRTN
    ? rows
    : rows.filter(function (r) {
        return r.state !== 'Normal';
      });
  // DP-3: (System) toggle
  if (!_baShowSystem)
    chartRows = chartRows.filter(function (r) {
      return r.building !== 'System Wide';
    });

  var counts = {};
  chartRows.forEach(function (r) {
    counts[r.building] = (counts[r.building] || 0) + 1;
  });
  var sorted = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });

  var toggleHtml =
    '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">' +
    '<label style="font-size:12px;color:var(--text3);display:flex;align-items:center;gap:6px;cursor:pointer;" title="Return-to-Normal events are State=Normal rows where the alarm cleared.">' +
    '<input type="checkbox" ' +
    (_baShowRTN ? 'checked' : '') +
    ' onchange="_baShowRTN=this.checked;baRenderSubtab(\'bybuilding\',window._baAllRows)"> Include Return-to-Normal events' +
    '</label>' +
    '<label style="font-size:12px;color:var(--text3);display:flex;align-items:center;gap:6px;cursor:pointer;" title="System alarms are BAS-level errors with no specific building (e.g. email failures, trend manager errors).">' +
    '<input type="checkbox" ' +
    (_baShowSystem ? 'checked' : '') +
    ' onchange="_baShowSystem=this.checked;baRenderSubtab(\'bybuilding\',window._baAllRows)"> Show System Wide alarms' +
    '</label>' +
    '</div>';

  body.innerHTML =
    toggleHtml + '<div style="position:relative;height:380px;"><canvas id="ba-chart-bybuilding"></canvas></div>';
  window._baAllRows = rows;

  var ctx = document.getElementById('ba-chart-bybuilding');
  if (!ctx || typeof Chart === 'undefined') return;
  var cs = getComputedStyle(document.documentElement);
  var c_text = cs.getPropertyValue('--text').trim() || '#e2e8f0';
  var c_text2 = cs.getPropertyValue('--text2').trim() || '#94a3b8';
  var c_text3 = cs.getPropertyValue('--text3').trim() || '#64748b';
  _baCharts.bybuilding = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted,
      datasets: [
        {
          label: 'Alarm Count',
          data: sorted.map(function (k) {
            return counts[k];
          }),
          backgroundColor: sorted.map(function () {
            return 'rgba(0,212,170,0.75)';
          }),
          borderColor: sorted.map(function () {
            return 'rgba(0,212,170,1)';
          }),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: function (evt, elements) {
        if (!elements || !elements.length) return;
        var idx = elements[0].index;
        var label = sorted[idx];
        if (label != null) baApplyDrillFilter('building', label);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            footer: function () {
              return 'Click to filter log';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: c_text, font: { size: 11 }, maxRotation: 30 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          title: { display: true, text: 'Count', color: c_text3, font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.10)' },
          ticks: { color: c_text2, font: { size: 11 } },
        },
      },
    },
  });
}

// ── Component 4 — Timeline (histogram) ──────────────────────────────────────

function baRenderTimeline(body, rows) {
  var chartRows = _baShowRTN
    ? rows
    : rows.filter(function (r) {
        return r.state !== 'Normal';
      });

  var modeToggle =
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">' +
    "<button onclick=\"_baTimelineMode='hour';_baCharts.timeline&&(_baCharts.timeline.destroy(),delete _baCharts.timeline);baRenderSubtab('timeline',window._baAllRows)\" " +
    'style="font-size:12px;padding:4px 12px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:' +
    (_baTimelineMode === 'hour' ? 'var(--em)' : 'var(--s3)') +
    ';color:' +
    (_baTimelineMode === 'hour' ? '#fff' : 'var(--text2)') +
    ';">Hour of Day</button>' +
    "<button onclick=\"_baTimelineMode='date';_baCharts.timeline&&(_baCharts.timeline.destroy(),delete _baCharts.timeline);baRenderSubtab('timeline',window._baAllRows)\" " +
    'style="font-size:12px;padding:4px 12px;border-radius:5px;border:1px solid var(--border);cursor:pointer;background:' +
    (_baTimelineMode === 'date' ? 'var(--em)' : 'var(--s3)') +
    ';color:' +
    (_baTimelineMode === 'date' ? '#fff' : 'var(--text2)') +
    ';">Date Timeline</button>' +
    '<label style="font-size:12px;color:var(--text3);display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:12px;" title="the event logged when an alarm condition clears and the point returns to normal">' +
    '<input type="checkbox" ' +
    (_baShowRTN ? 'checked' : '') +
    ' onchange="_baShowRTN=this.checked;baRenderSubtab(\'timeline\',window._baAllRows)"> Include Return-to-Normal events</label>' +
    '</div>';

  var labels, data;
  if (_baTimelineMode === 'hour') {
    labels = Array.from({ length: 24 }, function (_, i) {
      return i + ':00';
    });
    var hourCounts = new Array(24).fill(0);
    chartRows.forEach(function (r) {
      if (r.ts) hourCounts[r.ts.getHours()]++;
    });
    data = hourCounts;
  } else {
    // Date timeline — aggregate by day
    var dayMap = {};
    chartRows.forEach(function (r) {
      if (!r.ts) return;
      var dk =
        r.ts.getFullYear() +
        '-' +
        String(r.ts.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(r.ts.getDate()).padStart(2, '0');
      dayMap[dk] = (dayMap[dk] || 0) + 1;
    });
    labels = Object.keys(dayMap).sort();
    data = labels.map(function (k) {
      return dayMap[k];
    });
  }

  var xTitle = _baTimelineMode === 'hour' ? 'Hour of Day' : 'Date';
  body.innerHTML =
    modeToggle + '<div style="position:relative;height:380px;"><canvas id="ba-chart-timeline"></canvas></div>';
  window._baAllRows = rows;

  var ctx = document.getElementById('ba-chart-timeline');
  if (!ctx || typeof Chart === 'undefined') return;
  var cs = getComputedStyle(document.documentElement);
  var c_text = cs.getPropertyValue('--text').trim() || '#e2e8f0';
  var c_text2 = cs.getPropertyValue('--text2').trim() || '#94a3b8';
  var c_text3 = cs.getPropertyValue('--text3').trim() || '#64748b';
  _baCharts.timeline = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Alarm Count',
          data: data,
          backgroundColor: 'rgba(0,212,170,0.75)',
          borderColor: 'rgba(0,212,170,1)',
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: function (evt, elements) {
        if (!elements || !elements.length) return;
        var idx = elements[0].index;
        var label = labels[idx];
        if (label == null) return;
        if (_baTimelineMode === 'hour') {
          baApplyDrillFilter('hour', String(parseInt(label, 10)));
        } else {
          baApplyDrillFilter('date', label);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            footer: function () {
              return 'Click to filter log';
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: xTitle, color: c_text3, font: { size: 11 } },
          ticks: {
            color: c_text2,
            font: { size: _baTimelineMode === 'date' ? 9 : 11 },
            maxRotation: _baTimelineMode === 'date' ? 45 : 0,
            maxTicksLimit: _baTimelineMode === 'date' ? 30 : 24,
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          title: { display: true, text: 'Count', color: c_text3, font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.10)' },
          ticks: { color: c_text2, font: { size: 11 } },
        },
      },
    },
  });
}

// ── Utility helpers ──────────────────────────────────────────────────────────

/** Escape HTML entities */
function baEsc(s) {
  s = s == null ? '' : String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Unique values from an array */
function baUnique(arr) {
  var seen = {};
  return arr.filter(function (v) {
    if (seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

/** Build a <select> element */
function baSelect(id, options, selected, placeholder, onchange, allLabel) {
  var showAllLabel = allLabel || placeholder;
  return (
    '<select id="' +
    id +
    '" onchange="' +
    onchange +
    '" ' +
    'style="background:var(--s3);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 8px;font-size:12px;">' +
    options
      .map(function (o) {
        return (
          '<option value="' +
          baEsc(o) +
          '"' +
          (o === selected ? ' selected' : '') +
          '>' +
          (o || showAllLabel) +
          '</option>'
        );
      })
      .join('') +
    '</select>'
  );
}

/** Download filtered rows as CSV */
function baDownloadFilteredCSV() {
  var projId = window._activeProjId || null;
  if (!projId) return;
  var data = baGetData(projId);
  if (!data || !data.rows) return;
  var filtered = baFilterRows(data.rows);
  var header = [
    'S No',
    'Date',
    'Acknowledged',
    'AcknowledgedAt',
    'AcknowledgedBy',
    'Category',
    'Location',
    'Building',
    'Source',
    'State',
    'Duration',
    'Description',
    'Comment',
  ];
  var lines = [header.join(',')];
  filtered.forEach(function (r) {
    var fields = [
      r.sNo,
      r.ts ? '"' + r.ts.toLocaleString() + '"' : '',
      r.acknowledged,
      r.acknowledgedAt ? '"' + r.acknowledgedAt.toLocaleString() + '"' : '',
      '"' + baEsc(r.acknowledgedBy || '') + '"',
      '"' + (r.category || '').replace(/"/g, '""') + '"',
      '"' + (r.location || '').replace(/"/g, '""') + '"',
      '"' + (r.building || '').replace(/"/g, '""') + '"',
      '"' + (r.source || '').replace(/"/g, '""') + '"',
      r.state,
      r.duration,
      '"' + (r.description || '').replace(/"/g, '""') + '"',
      '"' + (r.comment || '').replace(/"/g, '""') + '"',
    ];
    lines.push(fields.join(','));
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'bas-alarms-filtered.csv';
  a.click();
  URL.revokeObjectURL(url);
}
