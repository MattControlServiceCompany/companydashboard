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
    _escHtml(notice) +
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
  var pbtn = document.getElementById('rptPresentedPdfBtn');
  if (pbtn) {
    var rec = ctx && getPresentedRecordFor(ctx.projId, ctx.yms);
    pbtn.style.display = rec ? '' : 'none';
    pbtn.textContent = rec && rec.pdfKey ? 'Replace presented report PDF' : 'Attach presented report PDF';
  }
}

// ── Presented report PDF (Matt 2026-09-29) ─────────────────────────────────────
// The PDF the client actually received is stored once in the bill PDF store (bpaStoreBlob, same
// en_pdf_shared_<hash16> key as attached bill PDFs) and its key is kept on the presented record.
// Only these user actions attach or replace it.
function _rptPresentedFileToB64(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () {
      resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    };
    r.onerror = function () {
      reject(r.error);
    };
    r.readAsDataURL(file);
  });
}

async function _rptPresentedAttachFile(projId, yms, file) {
  var rec = getPresentedRecordFor(projId, yms);
  if (!rec) return false;
  var b64 = await _rptPresentedFileToB64(file);
  if (atob(b64.slice(0, 8)).slice(0, 4) !== '%PDF') {
    showToast('That file is not a PDF.', 'warn');
    return false;
  }
  var blob = await bpaStoreBlob(b64, { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore, ensureUploaded: pdfEnsureUploaded });
  if (!blob) {
    showToast('Could not store the PDF. Nothing was changed.', 'warn');
    return false;
  }
  setPresentedPdf(projId, yms, blob.key, file.name);
  return true;
}

function rptAttachPresentedPdf() {
  var ctx = _rptPresentedCtx();
  var rec = ctx && getPresentedRecordFor(ctx.projId, ctx.yms);
  if (!rec) return;
  if (
    rec.pdfKey &&
    !confirm('A presented report PDF is already attached (' + (rec.pdfName || 'file') + '). Replace it with a new file?')
  )
    return;
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/pdf,.pdf';
  inp.id = 'rptPresentedPdfInput';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = async function () {
    var f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    if (await _rptPresentedAttachFile(ctx.projId, ctx.yms, f)) {
      showToast('Presented report PDF attached');
      _rptRefreshPresentedUI();
    }
  };
  inp.click();
}

// Open the stored PDF exactly as attached (the file's own bytes, in the browser's PDF viewer).
async function rptOpenPresentedPdf(projId, yms) {
  var rec = getPresentedRecordFor(projId, yms);
  var b64 = rec && rec.pdfKey ? await pdfLoad(rec.pdfKey) : null;
  if (!b64) {
    showToast('The presented report PDF could not be found.', 'warn');
    return;
  }
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  window._rptLastPresentedPdfUrl = url;
  window.open(url, '_blank');
}

// Gate for a report whose period was presented. Default is the presented report; the updated
// report (current layout, locked figures) is the second choice. Returns true when the chooser
// took over (the caller stops).
function _rptPresentedChooser(projId, yms, label, onUpdated) {
  var rec = getPresentedRecordFor(projId, yms);
  if (!rec) return false;
  window._rptPresentedChoiceCb = onUpdated;
  window._rptPresentedChoiceKey = { projId: projId, yms: yms.slice() };
  var on = new Date(rec.presentedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  var body =
    '<div style="font-size:13px;color:var(--text);margin-bottom:12px">' +
    _escHtml(label || 'This period') +
    ' was presented to the client on ' +
    _escHtml(on) +
    '.</div>';
  if (rec.pdfKey) {
    body +=
      '<button id="pcOpenBtn" class="btn btn-em" style="width:100%;margin-bottom:8px" onclick="_rptPresentedChoiceOpen()">Presented report' +
      (rec.pdfName ? ' (' + _escHtml(rec.pdfName) + ')' : '') +
      '</button>';
  } else {
    body +=
      '<div id="pcNoPdf" style="font-size:12px;color:var(--text2);margin-bottom:10px">No presented report PDF is attached for this period. Generate the updated report and use "Attach presented report PDF" in its toolbar to add the file.</div>';
  }
  body +=
    '<button id="pcUpdatedBtn" class="btn btn-ghost" style="width:100%" onclick="_rptPresentedChoiceUpdated()">Generate updated report</button>' +
    '<div style="font-size:11px;color:var(--text2);margin-top:8px">The updated report uses the current layout. Every figure that was presented to the client keeps its presented value.</div>';
  document.getElementById('presentedChoiceBody').innerHTML = body;
  document.getElementById('presentedChoiceModal').classList.add('open');
  return true;
}
function _rptClosePresentedChoice() {
  document.getElementById('presentedChoiceModal').classList.remove('open');
}
function _rptPresentedChoiceOpen() {
  var k = window._rptPresentedChoiceKey;
  _rptClosePresentedChoice();
  rptOpenPresentedPdf(k.projId, k.yms);
}
function _rptPresentedChoiceUpdated() {
  var cb = window._rptPresentedChoiceCb;
  _rptClosePresentedChoice();
  if (cb) cb();
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
// Other printed figures read from the CSV (see parsePresentedCsv); stored with the record on confirm.
var _rptPresentedFormPrinted = {};

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
  _rptPresentedFormPrinted = {};
  var d = ctx.data;
  var today = new Date().toISOString().slice(0, 10);
  var cellCss = 'border:1px solid var(--border);padding:4px 8px;';
  var inCss =
    'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--s1);color:var(--text);font-size:12px;text-align:right';
  var rows = d.buildings
    .map(function (b) {
      return (
        '<tr data-bldg="' +
        _escHtml(b.id) +
        '">' +
        '<td style="' +
        cellCss +
        '">' +
        _escHtml(b.name) +
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
        '<td style="' + cellCss + '"><input type="number" step="any" class="pf-elec" style="' + inCss + '"></td>' +
        '<td style="' + cellCss + '"><input type="number" step="any" class="pf-gas" style="' + inCss + '"></td>' +
        '<td style="' + cellCss + '"><input type="number" step="any" class="pf-prop" style="' + inCss + '"></td>' +
        '</tr>'
      );
    })
    .join('');
  var thCss = 'border:1px solid var(--border);padding:5px 8px;background:var(--s1);text-align:left;font-size:11px';
  var body =
    '<div style="font-size:12px;color:var(--text2);margin-bottom:10px">Period: <strong style="color:var(--text)">' +
    _escHtml(d.period.label || ctx.yms[0] + ' through ' + ctx.yms[ctx.yms.length - 1]) +
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
    '<div style="margin-bottom:10px;font-size:12px;color:var(--text2)">Or fill the table from a CSV file (rows: building, figure, value; figures: savings_dollars, kwh_saved, therms_saved, gallons_saved, electric_savings_dollars, gas_savings_dollars, propane_savings_dollars; a row named Portfolio total holds the total; a figure named printed:section|commodity|month|column keeps any other printed number for the updated report): ' +
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
    '<th style="' + thCss + 'text-align:right">Electric $ presented</th>' +
    '<th style="' + thCss + 'text-align:right">Gas $ presented</th>' +
    '<th style="' + thCss + 'text-align:right">Propane $ presented</th>' +
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
    '<td colspan="6" style="' +
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
    _rptPresentedFormPrinted = r.printed;
    document.querySelectorAll('#presentedModalBody tbody tr').forEach(function (tr) {
      var f = r.buildings[tr.getAttribute('data-bldg')];
      if (!f) return;
      if (f.dollars != null) tr.querySelector('.pf-dollars').value = f.dollars;
      if (f.kwhSaved != null) tr.querySelector('.pf-kwh').value = f.kwhSaved;
      if (f.thermsSaved != null) tr.querySelector('.pf-therms').value = f.thermsSaved;
      if (f.gallonsSaved != null) tr.querySelector('.pf-gal').value = f.gallonsSaved;
      if (f.elecDollars != null) tr.querySelector('.pf-elec').value = f.elecDollars;
      if (f.gasDollars != null) tr.querySelector('.pf-gas').value = f.gasDollars;
      if (f.propaneDollars != null) tr.querySelector('.pf-prop').value = f.propaneDollars;
    });
    if (r.totalDollars != null) document.getElementById('pfTotal').value = r.totalDollars;
    _rptPresentedRecalc();
    var notes = [];
    if (r.unmatched.length) notes.push('No building named: ' + r.unmatched.join(', ') + '.');
    if (r.bad.length) notes.push(r.bad.length + ' row(s) could not be read.');
    var _np = Object.keys(r.printed).length;
    if (_np) notes.push(_np + ' other printed figure(s) read.');
    document.getElementById('pfMsg').textContent = notes.length
      ? notes.join(' ')
      : 'File read. Check the numbers, then confirm.';
  };
  reader.readAsText(file);
}

function _rptClosePresentedForm() {
  document.getElementById('presentedModal').classList.remove('open');
  _rptPresentedFormCtx = null;
  _rptPresentedFormPrinted = {};
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
    var ed = _rptPresentedNum(tr.querySelector('.pf-elec').value);
    var gd = _rptPresentedNum(tr.querySelector('.pf-gas').value);
    var pd = _rptPresentedNum(tr.querySelector('.pf-prop').value);
    if (ed != null) f.elecDollars = ed;
    if (gd != null) f.gasDollars = gd;
    if (pd != null) f.propaneDollars = pd;
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
    printed: _rptPresentedFormPrinted,
  });
  if (!res.ok) {
    document.getElementById('pfMsg').textContent = res.reason;
    return;
  }
  _rptClosePresentedForm();
  showToast('Marked as presented to client');
  refreshReportPreview();
}
