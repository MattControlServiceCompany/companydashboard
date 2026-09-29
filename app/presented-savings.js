// app/presented-savings.js — "Mark as presented to client" screens for the report preview (WP-04a).
// The rule and the stored figures live in computations/savings.js (savePresentedRecord,
// removePresentedMark, totalSavingsWithPresented). This file only holds the report line, the
// preview-toolbar button and the entry form. Nothing here writes a figure except the form's
// confirm button.
// Depends on: computations/savings.js, app/report-preview.js (refreshReportPreview), showToast.

function _rptPresentedLineHTML(notice, sidePad) {
  return (
    '<div class="rpt-presented-line" style="' +
    (notice ? '' : 'display:none;') +
    'margin:6px 0;padding:0 ' +
    (sidePad == null ? '14px' : sidePad) +
    ';font-size:11px;font-weight:600;color:var(--rpt-green-dark)">' +
    _rptV2Esc(notice) +
    '</div>'
  );
}

// The report being previewed, as { projId, yms (sorted), data }, or null when it is not a
// project savings report.
function _rptPresentedCtx() {
  var d = window._currentReportData;
  if (!d || d._soo || d._ashrae || !d.period || !d.project || d.project.id == null) return null;
  var yms = (d.period.yearMonths || []).slice().sort();
  return yms.length ? { projId: d.project.id, yms: yms, data: d } : null;
}

// Button text and the report line follow the stored record for the period on screen.
function _rptRefreshPresentedUI() {
  var ctx = _rptPresentedCtx();
  var btn = document.getElementById('rptPresentedBtn');
  var marked = !!(ctx && getPresentedRecordFor(ctx.projId, ctx.yms));
  if (btn) {
    btn.style.display = ctx ? '' : 'none';
    btn.textContent = marked ? 'Remove presented mark' : 'Mark as presented to client';
  }
}

function rptTogglePresented() {
  var ctx = _rptPresentedCtx();
  if (!ctx) return;
  var label = ctx.data.period.label || 'this period';
  if (getPresentedRecordFor(ctx.projId, ctx.yms)) {
    if (
      !confirm(
        'Remove the presented mark for ' +
          label +
          '? Its savings figures will change again when bills or settings change.',
      )
    )
      return;
    removePresentedMark(ctx.projId, ctx.yms);
    showToast('Presented mark removed');
    refreshReportPreview();
    return;
  }
  _rptOpenPresentedForm(ctx);
}

var _rptPresentedFormCtx = null;

function _rptPresentedNum(v) {
  return v === '' || v == null ? null : parseFloat(v);
}

function _rptPresentedFmt(v) {
  if (v == null || !isFinite(v)) return '—';
  var r = Math.round(v);
  return (r < 0 ? '−' : '') + '$' + Math.abs(r).toLocaleString('en-US');
}

function _rptOpenPresentedForm(ctx) {
  _rptPresentedFormCtx = ctx;
  var d = ctx.data;
  var today = new Date().toISOString().slice(0, 10);
  var cellCss = 'border:1px solid var(--border);padding:4px 8px;';
  var inCss =
    'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--s1);color:var(--text);font-size:12px;text-align:right';
  var rows = d.buildings
    .map(function (b) {
      return (
        '<tr data-bldg="' +
        _rptV2Esc(b.id) +
        '">' +
        '<td style="' +
        cellCss +
        '">' +
        _rptV2Esc(b.name) +
        '</td>' +
        '<td style="' +
        cellCss +
        'text-align:right" class="pf-cur">' +
        _rptPresentedFmt(b.savings) +
        '</td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-dollars" style="' +
        inCss +
        '"></td>' +
        '<td style="' +
        cellCss +
        'text-align:right" class="pf-diff">—</td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-kwh" placeholder="' +
        Math.round(b.electric.kwhSaved) +
        '" style="' +
        inCss +
        '"></td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-therms" placeholder="' +
        Math.round(b.gas.thermsSaved) +
        '" style="' +
        inCss +
        '"></td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-gal" placeholder="' +
        Math.round(b.propane.galSaved) +
        '" style="' +
        inCss +
        '"></td>' +
        '</tr>'
      );
    })
    .join('');
  var thCss = 'border:1px solid var(--border);padding:5px 8px;background:var(--s1);text-align:left;font-size:11px';
  var body =
    '<div style="font-size:12px;color:var(--text2);margin-bottom:10px">Period: <strong style="color:var(--text)">' +
    _rptV2Esc(d.period.label || ctx.yms[0] + ' through ' + ctx.yms[ctx.yms.length - 1]) +
    '</strong>. Enter the figures exactly as printed in the document you gave the client. Only the figures you enter are locked. Monthly detail stays recalculated.</div>' +
    '<div style="display:flex;gap:12px;margin-bottom:10px">' +
    '<label style="flex:2;font-size:12px;color:var(--text2)">Document name<input id="pfDocName" type="text" style="' +
    inCss +
    ';text-align:left;margin-top:3px" placeholder="For example: Q1 2026 Quarterly Report"></label>' +
    '<label style="flex:1;font-size:12px;color:var(--text2)">Presented on<input id="pfDate" type="date" value="' +
    today +
    '" style="' +
    inCss +
    ';text-align:left;margin-top:3px"></label></div>' +
    '<div style="margin-bottom:10px;font-size:12px;color:var(--text2)">Or fill the table from a CSV file (rows: building, figure, value; figures: savings_dollars, kwh_saved, therms_saved, gallons_saved; a row named Portfolio total holds the total): ' +
    '<input id="pfCsv" type="file" accept=".csv,text/csv" onchange="_rptPresentedImportCsv(this)"></div>' +
    '<div id="pfMsg" style="font-size:12px;color:var(--text2);margin-bottom:8px"></div>' +
    '<table style="border-collapse:collapse;width:100%;font-size:12px;color:var(--text)"><thead><tr>' +
    '<th style="' +
    thCss +
    '">Building</th>' +
    '<th style="' +
    thCss +
    'text-align:right">Savings now ($)</th>' +
    '<th style="' +
    thCss +
    'text-align:right">Savings presented ($)</th>' +
    '<th style="' +
    thCss +
    'text-align:right">Difference ($)</th>' +
    '<th style="' +
    thCss +
    'text-align:right">kWh saved presented</th>' +
    '<th style="' +
    thCss +
    'text-align:right">Therms saved presented</th>' +
    '<th style="' +
    thCss +
    'text-align:right">Gallons saved presented</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody><tfoot><tr style="font-weight:600;background:var(--s1)">' +
    '<td style="' +
    cellCss +
    '">Portfolio total</td>' +
    '<td style="' +
    cellCss +
    'text-align:right">' +
    _rptPresentedFmt(d.totals.savings) +
    '</td>' +
    '<td style="' +
    cellCss +
    '"><input type="number" step="any" id="pfTotal" style="' +
    inCss +
    '"></td>' +
    '<td style="' +
    cellCss +
    'text-align:right" id="pfTotalDiff">—</td>' +
    '<td colspan="3" style="' +
    cellCss +
    '"></td></tr></tfoot></table>';
  document.getElementById('presentedModalBody').innerHTML = body;
  document.getElementById('presentedModal').classList.add('open');
  document.querySelectorAll('#presentedModalBody input.pf-dollars, #pfTotal').forEach(function (el) {
    el.addEventListener('input', _rptPresentedRecalc);
  });
}

// Difference column: presented minus what the site calculates now.
function _rptPresentedRecalc() {
  var d = _rptPresentedFormCtx.data;
  document.querySelectorAll('#presentedModalBody tbody tr').forEach(function (tr) {
    var b = d.buildings.find(function (x) {
      return String(x.id) === tr.getAttribute('data-bldg');
    });
    var v = _rptPresentedNum(tr.querySelector('.pf-dollars').value);
    tr.querySelector('.pf-diff').textContent = v == null ? '—' : _rptPresentedFmt(v - b.savings);
  });
  var t = _rptPresentedNum(document.getElementById('pfTotal').value);
  document.getElementById('pfTotalDiff').textContent = t == null ? '—' : _rptPresentedFmt(t - d.totals.savings);
}

function _rptPresentedImportCsv(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var d = _rptPresentedFormCtx.data;
    var r = parsePresentedCsv(String(reader.result), d.buildings);
    document.querySelectorAll('#presentedModalBody tbody tr').forEach(function (tr) {
      var f = r.buildings[tr.getAttribute('data-bldg')];
      if (!f) return;
      if (f.dollars != null) tr.querySelector('.pf-dollars').value = f.dollars;
      if (f.kwhSaved != null) tr.querySelector('.pf-kwh').value = f.kwhSaved;
      if (f.thermsSaved != null) tr.querySelector('.pf-therms').value = f.thermsSaved;
      if (f.gallonsSaved != null) tr.querySelector('.pf-gal').value = f.gallonsSaved;
    });
    if (r.totalDollars != null) document.getElementById('pfTotal').value = r.totalDollars;
    _rptPresentedRecalc();
    var notes = [];
    if (r.unmatched.length) notes.push('No building named: ' + r.unmatched.join(', ') + '.');
    if (r.bad.length) notes.push(r.bad.length + ' row(s) could not be read.');
    document.getElementById('pfMsg').textContent = notes.length
      ? notes.join(' ')
      : 'File read. Check the numbers, then confirm.';
  };
  reader.readAsText(file);
}

function _rptClosePresentedForm() {
  document.getElementById('presentedModal').classList.remove('open');
  _rptPresentedFormCtx = null;
}

// The only writer: the confirm button of the form.
function _rptConfirmPresentedForm() {
  var ctx = _rptPresentedFormCtx;
  if (!ctx) return;
  var buildings = {};
  document.querySelectorAll('#presentedModalBody tbody tr').forEach(function (tr) {
    var dollars = _rptPresentedNum(tr.querySelector('.pf-dollars').value);
    if (dollars == null) return;
    var f = { dollars: dollars };
    var kwh = _rptPresentedNum(tr.querySelector('.pf-kwh').value);
    var therms = _rptPresentedNum(tr.querySelector('.pf-therms').value);
    var gal = _rptPresentedNum(tr.querySelector('.pf-gal').value);
    if (kwh != null) f.kwhSaved = kwh;
    if (therms != null) f.thermsSaved = therms;
    if (gal != null) f.gallonsSaved = gal;
    buildings[tr.getAttribute('data-bldg')] = f;
  });
  var dateVal = document.getElementById('pfDate').value;
  var total = _rptPresentedNum(document.getElementById('pfTotal').value);
  var label = ctx.data.period.label || 'this period';
  if (
    !confirm(
      'Lock these figures for ' +
        label +
        '? They will not change when bills or settings change. You can remove the mark later.',
    )
  )
    return;
  var res = savePresentedRecord({
    projectId: ctx.projId,
    periodStart: ctx.yms[0],
    periodEnd: ctx.yms[ctx.yms.length - 1],
    presentedAt: new Date((dateVal || new Date().toISOString().slice(0, 10)) + 'T12:00:00').toISOString(),
    documentName: document.getElementById('pfDocName').value.trim(),
    totalDollars: total == null ? null : total,
    buildings: buildings,
  });
  if (!res.ok) {
    document.getElementById('pfMsg').textContent = res.reason;
    return;
  }
  _rptClosePresentedForm();
  showToast('Marked as presented to client');
  refreshReportPreview();
}
