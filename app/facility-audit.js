// app/facility-audit.js - Facility Audit project tab.
// One synced key per project: en_audit_<pid> = { findings: [...], edits: { <autoId>: {...} }, importedAt }.
//   findings  - records the user added or imported (rowId links to the Equipment Matrix row).
//   edits     - the user's changes to automatic findings (status, notes, cost, hours, picture, link).
// Automatic findings are NOT stored: computations/audit-rules.js recomputes them on every read.
// The Deficiency List is a filter on the same records. Set points are NEVER stored here: the Set Points
// view reads emBuildSetpointExportRows (app/equipment-matrix.js) each time.
// Cost and savings link through measureId to the existing measures; no energy math here.

var FA_STATUSES = ['Open', 'Planned', 'Done', 'Dismissed'];
var FA_ISSUE_TYPES = ['Energy Services', 'Optimization', 'Deficiency'];
var FA_EDIT_FIELDS = ['status', 'notes', 'cost', 'hours', 'picture', 'pictureLink', 'how', 'change', 'measureId'];
var _faView = 'findings';

function faLoad(pid) {
  var d = sget('en_audit_' + pid, null);
  if (!d || typeof d !== 'object') d = {};
  if (!Array.isArray(d.findings)) d.findings = [];
  if (!d.edits || typeof d.edits !== 'object') d.edits = {};
  return d;
}

function faSave(pid, d) {
  return sset('en_audit_' + pid, d);
}

// Every finding: automatic ones first (recomputed now), then the user's own.
function faAllFindings(pid) {
  var d = faLoad(pid);
  var m = emLoadMatrix(pid);
  var rows = (m && m.rows) || [];
  var autoRaw = auditComputeAutoFindings(rows, { hasGas: emHasGasLookup(pid) });
  var live = {};
  autoRaw.forEach(function (f) {
    live[f.id] = true;
  });
  var stale = Object.keys(d.edits).filter(function (k) {
    return k.indexOf('auto:') === 0 && !live[k];
  });
  if (m && stale.length) {
    stale.forEach(function (k) {
      delete d.edits[k];
    });
    faSave(pid, d);
  }
  var auto = autoRaw.map(function (f) {
    var e = d.edits[f.id] || {};
    var o = Object.assign({ status: '', notes: '', cost: null, hours: null, picture: '', pictureLink: '', how: '', measureId: null }, f);
    FA_EDIT_FIELDS.forEach(function (k) {
      if (e[k] !== undefined) o[k] = e[k];
    });
    return o;
  });
  return auto.concat(d.findings);
}

function faIsDeficiency(f) {
  return !!(f.deficiency || f.cscList || f.issueType === 'Deficiency');
}

// Set points: read from the Equipment Matrix every time, never stored.
function faSetPointRows(pid) {
  return emBuildSetpointExportRows(pid);
}

function faEdit(pid, id, field, value) {
  if (FA_EDIT_FIELDS.indexOf(field) === -1) return;
  var d = faLoad(pid);
  if (field === 'cost' || field === 'hours') {
    var n = parseFloat(String(value).replace(/[$,]/g, ''));
    value = isNaN(n) ? null : n;
  }
  if (String(id).indexOf('auto:') === 0) {
    d.edits[id] = d.edits[id] || {};
    d.edits[id][field] = value;
  } else {
    var f = d.findings.filter(function (x) {
      return x.id === id;
    })[0];
    if (!f) return;
    f[field] = value;
  }
  faSave(pid, d);
  if (field === 'status') faRender(pid);
}

function faAdd(pid) {
  var d = faLoad(pid);
  d.findings.push({
    id: 'u' + Date.now().toString(36),
    rowId: null,
    building: '',
    equipment: '',
    type: '',
    issueType: 'Optimization',
    issue: 'New finding',
    change: '',
    how: '',
    picture: '',
    pictureLink: '',
    notes: '',
    needsMod: '',
    measureId: null,
    hours: null,
    cost: null,
    status: 'Open',
    deficiency: false,
    cscList: false,
  });
  faSave(pid, d);
  faRender(pid);
}

function faSetView(pid, v) {
  _faView = v;
  faRender(pid);
}

function _faImportDone(pid, sheets) {
  var m = emLoadMatrix(pid);
  var d = faLoad(pid);
  var res = auditImportSheets(sheets, (m && m.rows) || [], d.findings);
  d.findings = d.findings.concat(res.findings);
  d.importedAt = new Date().toISOString();
  faSave(pid, d);
  faRender(pid, res);
}

function faImportFile(pid, input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  var isCsv = /\.csv$/i.test(file.name || '');
  var isXlsx = /\.xlsx$/i.test(file.name || '');
  input.value = '';
  if (!isCsv && !isXlsx) {
    showToast(AUDIT_CSV_MESSAGE, 'error');
    return;
  }
  var reader = new FileReader();
  if (isCsv) {
    reader.onload = function () {
      var parsed = auditCsvToSheets(reader.result);
      if (parsed.error) return showToast(parsed.error, 'error');
      _faImportDone(pid, parsed.sheets);
    };
    reader.readAsText(file);
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('Spreadsheet reader not loaded', 'error');
    return;
  }
  reader.onload = function () {
    var wb = XLSX.read(reader.result, { type: 'array' });
    var sheets = {};
    [AUDIT_IMPORT_SHEETS.audit, AUDIT_IMPORT_SHEETS.csc].forEach(function (n) {
      if (wb.Sheets[n]) sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' });
    });
    if (!Object.keys(sheets).length) return showToast(AUDIT_CSV_MESSAGE, 'error');
    _faImportDone(pid, sheets);
  };
  reader.readAsArrayBuffer(file);
}

function _faStatusChip(pid, f) {
  return (
    '<select class="fa-chip" aria-label="Status" data-pid="' +
    _escHtml(pid) +
    '" data-id="' +
    _escHtml(f.id) +
    '" data-field="status"><option value="">No status</option>' +
    FA_STATUSES.map(function (s) {
      return '<option' + (f.status === s ? ' selected' : '') + '>' + s + '</option>';
    }).join('') +
    '</select>'
  );
}

function _faField(pid, f, field, label, wide) {
  var v = f[field] == null ? '' : f[field];
  return (
    '<label class="fa-fld' +
    (wide ? ' fa-wide' : '') +
    '"><span>' +
    label +
    '</span><input data-pid="' +
    _escHtml(pid) +
    '" data-id="' +
    _escHtml(f.id) +
    '" data-field="' +
    _escHtml(field) +
    '" value="' +
    _escHtml(v) +
    '"></label>'
  );
}

// ONE delegated listener per tab body. Data never goes into a handler string.
function _faBindChange(body) {
  if (body._faBound) return;
  body._faBound = true;
  body.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.dataset) return;
    if (t.dataset.action === 'import') faImportFile(t.dataset.pid, t);
    else if (t.dataset.field && t.dataset.id) faEdit(t.dataset.pid, t.dataset.id, t.dataset.field, t.value);
  });
  body.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!t || !t.dataset) return;
    if (t.dataset.action === 'view') faSetView(t.dataset.pid, t.dataset.view);
    else if (t.dataset.action === 'add') faAdd(t.dataset.pid);
  });
}

function _faRow(pid, f) {
  var detail =
    '<details><summary>More</summary><div class="fa-detail">' +
    _faField(pid, f, 'picture', 'Picture file name', true) +
    _faField(pid, f, 'pictureLink', 'Picture link (optional)', true) +
    _faField(pid, f, 'hours', 'Hours to fix') +
    _faField(pid, f, 'cost', 'Cost ($)') +
    _faField(pid, f, 'measureId', 'Savings measure id') +
    '</div></details>';
  return (
    '<tr><td>' +
    _escHtml(f.building) +
    '</td><td>' +
    _escHtml(f.equipment) +
    '</td><td>' +
    _escHtml(f.type) +
    '</td><td>' +
    _escHtml(f.issueType) +
    (f.auto ? '<div class="fa-sub">Automatic</div>' : '') +
    '</td><td>' +
    _escHtml(f.issue) +
    '</td><td>' +
    _faCellInput(pid, f, 'change', 'Type of Optimization') +
    '</td><td>' +
    _faCellInput(pid, f, 'how', 'How do we accomplish') +
    '</td><td>' +
    _faCellInput(pid, f, 'notes', 'Notes') +
    detail +
    '</td><td>' +
    _faStatusChip(pid, f) +
    '</td></tr>'
  );
}

function _faCellInput(pid, f, field, label) {
  var v = f[field] == null ? '' : f[field];
  return (
    '<textarea class="fa-cell" rows="2" aria-label="' +
    label +
    '" data-pid="' +
    _escHtml(pid) +
    '" data-id="' +
    _escHtml(f.id) +
    '" data-field="' +
    _escHtml(field) +
    '">' +
    _escHtml(v) +
    '</textarea>'
  );
}

function _faFindingsTable(pid, list) {
  if (!list.length) return '<div class="fa-empty">No findings yet.</div>';
  return (
    '<div class="ch-tbl-outer fa-outer fa-scroll"><table class="fa-tbl"><thead><tr><th>Building</th><th>Equipment</th><th>Type</th><th>Issue Type</th><th>Issue</th><th>Type of Optimization</th><th>How do we accomplish</th><th>Notes</th><th>Status</th></tr></thead><tbody>' +
    list
      .map(function (f) {
        return _faRow(pid, f);
      })
      .join('') +
    '</tbody></table></div>'
  );
}

function _faSetPointsTable(pid) {
  var rows = faSetPointRows(pid);
  if (!rows.length) return '<div class="fa-empty">No equipment in the matrix.</div>';
  var heads = typeof EM_SETPOINT_EXPORT_HEADERS !== 'undefined' ? EM_SETPOINT_EXPORT_HEADERS : [];
  return (
    '<div class="fa-sub">Read from the Equipment Matrix. Nothing is stored here.</div><div class="ch-tbl-outer fa-outer fa-scroll"><table class="fa-tbl"><thead><tr>' +
    heads
      .map(function (h) {
        return '<th>' + _escHtml(h) + '</th>';
      })
      .join('') +
    '</tr></thead><tbody>' +
    rows
      .map(function (r) {
        return (
          '<tr>' +
          r
            .map(function (c) {
              return '<td>' + _escHtml(c) + '</td>';
            })
            .join('') +
          '</tr>'
        );
      })
      .join('') +
    '</tbody></table></div>'
  );
}

// Shown only on the render right after an import (res passed in); never stored.
function _faImportReview(r) {
  if (!r) return '';
  var h =
    '<details class="fa-review" open><summary>Import: ' +
    r.matched +
    ' matched to the matrix, ' +
    r.unmatched.length +
    ' not matched, ' +
    r.duplicates +
    ' already here</summary>';
  if (r.unmatched.length) {
    h +=
      '<div class="fa-sub">These rows were kept as free text. Check the equipment name.</div><ul>' +
      r.unmatched
        .map(function (u) {
          return (
            '<li>' + _escHtml(u.sheet) + ' row ' + u.rowNum + ': ' + _escHtml(u.building) + ' / ' + _escHtml(u.equipment) + ' - ' + _escHtml(u.reason) + '</li>'
          );
        })
        .join('') +
      '</ul>';
  }
  return h + '</details>';
}

var _faCss =
  '.fa-wrap{padding:16px;color:var(--text)}' +
  '.fa-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}' +
  '.fa-btn,.fa-pill{background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}' +
  '.fa-pill.on{background:var(--accent-dim);border-color:var(--accent)}' +
  '.fa-outer{border:1px solid var(--border);border-radius:6px;overflow:hidden}' +
  '.fa-scroll{overflow-x:auto}' +
  '.fa-tbl{width:100%;border-collapse:separate;border-spacing:0;table-layout:auto;font-size:12px}' +
  '.fa-tbl th{background:var(--s1);color:var(--text);text-align:left;padding:6px;font-size:11px;white-space:nowrap}' +
  '.fa-tbl th,.fa-tbl td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px;vertical-align:top;overflow-wrap:anywhere;color:var(--text)}' +
  '.fa-tbl th:last-child,.fa-tbl td:last-child{border-right:none}' +
  '.fa-tbl tbody tr:last-child td{border-bottom:none}' +
  '.fa-tbl td{min-width:90px}' +
  '.fa-sub{font-size:11px;color:var(--text)}' +
  '.fa-chip{background:var(--s3);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:2px 6px;font-size:11px}' +
  '.fa-detail{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
  '.fa-fld{display:flex;flex-direction:column;font-size:11px;gap:2px;flex:1 1 140px}' +
  '.fa-fld.fa-wide{flex-basis:100%}' +
  '.fa-fld input{background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px}' +
  '.fa-line{flex-basis:100%;font-size:12px}' +
  '.fa-cell{width:100%;min-width:140px;box-sizing:border-box;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;font-family:inherit;resize:vertical}' +
  '.fa-empty{padding:24px;text-align:center}' +
  '.fa-review{border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:12px;font-size:12px}' +
  '.fa-tbl summary{cursor:pointer}';

function faRender(pid, importResult) {
  pid = pid || window._activeProjId;
  var body = document.getElementById('ptab-facility-audit-body-' + pid);
  if (!body) return;
  var m = emLoadMatrix(pid);
  if (m === null) {
    body.innerHTML = '<div class="fa-empty">Loading...</div>';
    return;
  }
  _faBindChange(body);
  var all = faAllFindings(pid);
  var defs = all.filter(faIsDeficiency);
  var open = all.filter(function (f) {
    return f.status !== 'Done' && f.status !== 'Dismissed';
  });
  var shown = _faView === 'deficiency' ? defs : all;
  var pills = [
    ['findings', 'All findings'],
    ['deficiency', 'Deficiency list'],
    ['setpoints', 'Set points'],
  ]
    .map(function (v) {
      return '<button class="fa-pill' + (_faView === v[0] ? ' on' : '') + '" data-action="view" data-pid="' + _escHtml(pid) + '" data-view="' + _escHtml(v[0]) + '">' + v[1] + '</button>';
    })
    .join('');
  body.innerHTML =
    '<style>' +
    _faCss +
    '</style><div class="fa-wrap"><div class="fa-bar">' +
    pills +
    '<span class="fa-sub">' +
    all.length +
    ' findings, ' +
    open.length +
    ' not done, ' +
    defs.length +
    ' deficiencies</span></div>' +
    '<div class="fa-bar"><button class="fa-btn" data-action="add" data-pid="' +
    _escHtml(pid) +
    '">Add finding</button><label class="fa-btn">Import audit workbook or CSV<input type="file" accept=".xlsx,.csv" style="display:none" data-action="import" data-pid="' +
    _escHtml(pid) +
    '"></label></div>' +
    _faImportReview(importResult) +
    (_faView === 'setpoints' ? _faSetPointsTable(pid) : _faFindingsTable(pid, shown)) +
    '</div>';
}

function initFacilityAuditTab(pid) {
  faRender(pid);
}
