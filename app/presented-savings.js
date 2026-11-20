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
  document.querySelector('#presentedModal .modal-title').textContent = 'Mark as presented to client';
  document.querySelector('#presentedModal .modal').style.width = '900px';
  _ppSetFooter(true);
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
        '"><input type="number" step="any" class="pf-kwh" style="' +
        inCss +
        '"></td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-therms" style="' +
        inCss +
        '"></td>' +
        '<td style="' +
        cellCss +
        '"><input type="number" step="any" class="pf-gal" style="' +
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
async function _rptConfirmPresentedForm() {
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
  var pdfKey = '';
  if (ctx.fromPdf) {
    var pp = ctx.pdfPeriod;
    if (pp && (pp.start !== ctx.yms[0] || pp.end !== ctx.yms[ctx.yms.length - 1])) {
      document.getElementById('pfMsg').textContent = 'The PDF says "' + pp.src + '". That is not ' + label + '. Close this window and pick the matching quarter.';
      return;
    }
    if (!dateVal) {
      document.getElementById('pfMsg').textContent = 'Enter the date the report was presented.';
      return;
    }
  }
  var without = ctx.fromPdf ? ctx.nBldgs - Object.keys(buildings).length : 0;
  if (
    !confirm(
      'Lock these figures for ' +
        label +
        '? They will not change when bills or settings change. You can remove the mark later.' +
        (without ? ' ' + without + ' building(s) have no savings figure and keep the calculated value.' : ''),
    )
  )
    return;
  if (ctx.fromPdf) {
    // The PDF is stored first. When it cannot be stored, nothing is saved.
    var blob = await bpaStoreBlob(ctx.pdfB64, { hash: _bpaSha256Hex, load: pdfLoad, store: pdfStore, ensureUploaded: pdfEnsureUploaded });
    if (!blob) {
      document.getElementById('pfMsg').textContent = 'Could not store the PDF. Nothing was changed.';
      return;
    }
    pdfKey = blob.key;
  }
  var res = savePresentedRecord({
    projectId: ctx.projId,
    periodStart: ctx.yms[0],
    periodEnd: ctx.yms[ctx.yms.length - 1],
    presentedAt: new Date((dateVal || new Date().toISOString().slice(0, 10)) + 'T12:00:00').toISOString(),
    documentName: document.getElementById('pfDocName').value.trim(),
    totalDollars: total == null ? null : total,
    buildings: buildings,
    printed: _rptPresentedFormPrinted,
    pdfKey: pdfKey,
    pdfName: ctx.fromPdf ? ctx.pdfName : '',
  });
  if (!res.ok) {
    document.getElementById('pfMsg').textContent = res.reason;
    return;
  }
  _rptClosePresentedForm();
  showToast('Marked as presented to client');
  if (ctx.fromPdf) renderDocsSubTab('presented', ctx.projId);
  else refreshReportPreview();
}

// ── Mark a quarter as presented from the PDF the client received (Matt 2026-11-16) ──────────────────
// No report is generated. The figures come from the text of the delivered PDF only. A figure that the
// PDF text does not hold stays empty and is marked "not found". Nothing here reads a current site
// calculation. The one writer is still savePresentedRecord (computations/savings.js), called from
// _rptConfirmPresentedForm.

var _PP_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
var _PP_MONEY = '[-−–]?\\s?\\$\\s?[\\d,]+(?:\\.\\d+)?';

// "-$4,421", "−$49", "+33,182", "- 3" -> number, or null.
function _ppNum(s) {
  if (s == null) return null;
  var t = String(s).replace(/[−–—]/g, '-').replace(/[\s$,+]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
}

function _ppRegexEsc(s) {
  return String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

// Text lines of a loaded pdf.js document: pages -> lines (the cells of one visual row joined with a
// space, rows from top to bottom).
async function presentedPdfPages(pdf) {
  var pages = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var content = await (await pdf.getPage(p)).getTextContent();
    var rows = [];
    content.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var y = it.transform[5];
      var row = rows.find(function (r) {
        return Math.abs(r.y - y) < 3;
      });
      if (!row) {
        row = { y: y, items: [] };
        rows.push(row);
      }
      row.items.push({ x: it.transform[4], s: it.str });
    });
    rows.sort(function (a, b) {
      return b.y - a.y;
    });
    pages.push(
      rows.map(function (r) {
        return r.items
          .sort(function (a, b) {
            return a.x - b.x;
          })
          .map(function (i) {
            return i.s;
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }),
    );
  }
  return pages;
}

// Read the printed figures out of the text of a delivered report.
//   pages = [[line, ...], ...] (see presentedPdfPages); bldgs = [{ id, name }] of the project.
// Returns { period: { start, end, src } | null, totalDollars: { value, src } | null,
//           buildings: { <id>: { dollars, kwhSaved, thermsSaved, gallonsSaved, elecDollars, gasDollars,
//           propaneDollars } } }. Each figure is { value, src } (src = the text it was read from).
// A figure that is not in the text has no key. Nothing is computed, estimated or taken from the site.
function parsePresentedPdfText(pages, bldgs) {
  var text = pages
    .map(function (l) {
      return l.join(' ');
    })
    .join(' ')
    .replace(/\s+/g, ' ');
  var out = { period: null, totalDollars: null, buildings: {} };
  var pm = text.match(/([A-Z][a-z]+) (\d{4}) through ([A-Z][a-z]+) (\d{4})/);
  if (pm && _PP_MONTHS[pm[1].toLowerCase()] && _PP_MONTHS[pm[3].toLowerCase()]) {
    var two = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    out.period = {
      start: pm[2] + '-' + two(_PP_MONTHS[pm[1].toLowerCase()]),
      end: pm[4] + '-' + two(_PP_MONTHS[pm[3].toLowerCase()]),
      src: pm[0],
    };
  }
  [
    new RegExp('savings measured (?:were|was) (' + _PP_MONEY + ')', 'i'),
    new RegExp('achieved (' + _PP_MONEY + ') in verified', 'i'),
  ].some(function (re) {
    var m = text.match(re);
    var v = m ? _ppNum(m[1]) : null;
    if (v == null) return false;
    out.totalDollars = { value: v, src: m[0] };
    return true;
  });

  var UNIT = { electricity: 'kwhSaved', 'natural gas': 'thermsSaved', propane: 'gallonsSaved' };
  var COMM = [
    ['Electricity', 'elecDollars'],
    ['Natural gas', 'gasDollars'],
    ['Propane', 'propaneDollars'],
  ];
  // Units: the Total row of each meter table, under its building heading.
  var meters = {};
  var curB = null;
  var curC = null;
  pages.forEach(function (lines) {
    lines.forEach(function (ln) {
      var nb = (bldgs || []).find(function (b) {
        return new RegExp('^' + _ppRegexEsc(b.name) + '(\\s+Meter Performance.*)?$', 'i').test(ln);
      });
      if (nb) {
        curB = nb;
        curC = null;
        return;
      }
      var hm = ln.match(/^(Electricity|Natural gas|Propane)\b/i);
      if (hm) {
        curC = /\bPerformance\b/i.test(ln) ? UNIT[hm[1].toLowerCase()] : null;
        return;
      }
      // Total <days> <baseline> <actual> <saved> <percent or dash> ... The saved cell can reach us as split pieces ("- 7 6").
      var tm = curB && curC && ln.match(/^Total\s+(\d+)\s+[\d,.]+\s+[\d,.]+\s+([-+−–]?[\d,\s]*\d)\s+(?:[-+−–]?[\d.]+%|—)(?:\s|$)/);
      if (!tm) return;
      var v = _ppNum(tm[2]);
      if (v == null) return;
      var k = curB.id + '|' + curC;
      (meters[k] = meters[k] || []).push({ v: v, src: ln });
    });
  });

  (bldgs || []).forEach(function (b) {
    var f = {};
    var nm = _ppRegexEsc(b.name);
    var ma = new RegExp(nm + ':\\s*savings measured\\s+(' + _PP_MONEY + ')', 'i').exec(text);
    var mb = ma ? null : new RegExp(nm + '\\b[^$]{0,160}?\\(\\s*(' + _PP_MONEY + ')\\s+saved\\s*\\)', 'i').exec(text);
    var m = ma || mb;
    if (m && _ppNum(m[1]) != null) {
      var src = m[0];
      if (mb) src = src.slice(src.toLowerCase().lastIndexOf(b.name.toLowerCase()));
      f.dollars = { value: _ppNum(m[1]), src: src };
    }
    if (ma) {
      // The commodity dollars printed under this building's line, up to the next building line.
      var seg = text.slice(ma.index + ma[0].length, ma.index + ma[0].length + 600);
      var cut = seg.search(/savings measured|\bWeather\b/i);
      if (cut >= 0) seg = seg.slice(0, cut);
      COMM.forEach(function (c) {
        var cm = new RegExp(c[0] + ':\\s*(' + _PP_MONEY + ')', 'i').exec(seg);
        if (cm && _ppNum(cm[1]) != null) f[c[1]] = { value: _ppNum(cm[1]), src: cm[0] };
      });
    }
    Object.keys(UNIT).forEach(function (u) {
      var rows = meters[b.id + '|' + UNIT[u]];
      if (!rows || !rows.length) return;
      f[UNIT[u]] = {
        value: rows.reduce(function (s, r) {
          return s + r.v;
        }, 0),
        src:
          rows
            .map(function (r) {
              return r.src;
            })
            .join(' | ') + (rows.length > 1 ? ' (sum of ' + rows.length + ' meter totals)' : ''),
      };
    });
    out.buildings[b.id] = f;
  });
  return out;
}

// pdf.js loads on first use through chLoadLib (lib/lazy-libs.js, Matt 2026-11-19 d184cc83). Same options as the bill reader.
async function _ppReadPdfPages(b64) {
  await chLoadLib('pdfjs');
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var pdf = await pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  return presentedPdfPages(pdf);
}

// "Q3 2026" for one whole calendar quarter, else "July 2026 through August 2026".
function _ppPeriodLabel(start, end) {
  var sm = Number(start.slice(5, 7));
  if (presentedMonthRange(start, end).length === 3 && sm % 3 === 1) return 'Q' + ((sm - 1) / 3 + 1) + ' ' + start.slice(0, 4);
  return _presentedMonthLabel(start) + ' through ' + _presentedMonthLabel(end);
}

// ── Documents > Presented Reports ──
function _renderDocsPresented(body, projId) {
  var cellCss = 'border:1px solid var(--border);padding:6px 8px;';
  var thCss = 'border:1px solid var(--border);padding:6px 8px;background:var(--s1);text-align:left;font-size:11px;color:var(--text2)';
  var recs = getPresentedRecords(projId)
    .slice()
    .sort(function (a, b) {
      return b.periodStart.localeCompare(a.periodStart);
    });
  var rows = recs
    .map(function (r) {
      var pdf = r.pdfKey
        ? '<button class="btn btn-ghost btn-sm" onclick="rptOpenPresentedPdf(' + projId + ",['" + r.periodStart + "','" + r.periodEnd + '\'])">Open the PDF</button> ' + _escHtml(r.pdfName || '')
        : 'No PDF stored';
      return (
        '<tr><td style="' + cellCss + '">' + _escHtml(_ppPeriodLabel(r.periodStart, r.periodEnd)) + '</td>' +
        '<td style="' + cellCss + '">' + _escHtml(r.documentName || '') + '</td>' +
        '<td style="' + cellCss + '">' + _escHtml(_presentedDateLabel(r)) + '</td>' +
        '<td style="' + cellCss + '">' + pdf + '</td></tr>'
      );
    })
    .join('');
  body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
    '<div style="font-size:14px;font-weight:600">Presented Reports</div>' +
    '<button class="btn btn-em btn-sm" id="ppMarkBtn" onclick="_ppOpenMark(' + projId + ')">Mark a quarter as presented</button></div>' +
    '<div style="font-size:12px;color:var(--text2);margin-bottom:10px">A presented quarter keeps the figures printed in the PDF that the client received. To add one, pick the quarter and choose that PDF. The site makes no report.</div>' +
    (recs.length
      ? '<table style="border-collapse:collapse;width:100%;font-size:12px;color:var(--text)"><thead><tr>' +
        '<th style="' + thCss + '">Period</th><th style="' + thCss + '">Document</th><th style="' + thCss + '">Presented on</th><th style="' + thCss + '">PDF</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">No quarter is marked as presented yet.</div>');
}

// The quarters the project can mark: each quarter with a savings month, and the next quarter to present.
// Oldest first: the first one is the earliest quarter not yet marked.
function _ppQuarterOptions(projId) {
  var seen = {};
  getUDBldgs(projId).forEach(function (b) {
    Object.keys(getBuildingSavingsByYM(b, projId)).forEach(function (y) {
      seen[quarterKeyOfYM(y)] = true;
    });
  });
  var nq = nextQuarterToPresent(projId);
  if (nq) seen[quarterKeyOfYM(nq.yms[0])] = true;
  var done = {};
  getPresentedRecords(projId).forEach(function (r) {
    presentedMonthRange(r.periodStart, r.periodEnd).forEach(function (y) {
      done[quarterKeyOfYM(y)] = true;
    });
  });
  return Object.keys(seen)
    .filter(function (k) {
      return !done[k];
    })
    .sort()
    .map(function (k) {
      var y = k.slice(0, 4);
      var q = Number(k.slice(6)) - 1;
      return {
        key: k,
        label: 'Q' + (q + 1) + ' ' + y,
        yms: [1, 2, 3].map(function (n) {
          return y + '-' + String(q * 3 + n).padStart(2, '0');
        }),
      };
    });
}

function _ppSetFooter(showConfirm) {
  var b = document.querySelector('#presentedModal .modal-ftr .btn-em');
  if (b) b.style.display = showConfirm ? '' : 'none';
}

var _ppOptions = [];
// Step 1: pick the quarter and the delivered PDF.
function _ppOpenMark(projId) {
  _ppOptions = _ppQuarterOptions(projId);
  _rptPresentedFormCtx = null;
  _rptPresentedFormPrinted = {};
  var inCss = 'padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--s1);color:var(--text);font-size:12px';
  document.querySelector('#presentedModal .modal-title').textContent = 'Mark a quarter as presented';
  _ppSetFooter(false);
  document.querySelector('#presentedModal .modal').style.width = '900px';
  document.getElementById('presentedModalBody').innerHTML =
    '<div style="font-size:12px;color:var(--text2);margin-bottom:12px">Pick the quarter. Then choose the PDF file that the client received. The site reads the figures from the PDF text. You check them before they are saved.</div>' +
    '<div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">' +
    '<label style="font-size:12px;color:var(--text2)">Quarter<br><select id="ppQuarter" style="' + inCss + ';margin-top:3px">' +
    _ppOptions
      .map(function (o, i) {
        return '<option value="' + i + '">' + _escHtml(o.label) + '</option>';
      })
      .join('') +
    '</select></label>' +
    '<label style="font-size:12px;color:var(--text2)">PDF file<br><input id="ppFile" type="file" accept="application/pdf,.pdf" style="' + inCss + ';margin-top:3px" onchange="_ppFilePicked(' + projId + ',this)"></label></div>' +
    '<div id="pfMsg" style="font-size:12px;color:var(--text2);margin-top:12px">' +
    (_ppOptions.length ? '' : 'Every quarter of this project is already marked as presented.') +
    '</div>';
  document.getElementById('presentedModal').classList.add('open');
}

// Step 2: read the PDF and show every figure with the text it came from.
async function _ppFilePicked(projId, input) {
  var file = input.files && input.files[0];
  var msg = document.getElementById('pfMsg');
  var opt = _ppOptions[Number(document.getElementById('ppQuarter').value)];
  if (!file || !opt) return;
  msg.textContent = 'Reading the PDF...';
  try {
    var b64 = await _rptPresentedFileToB64(file);
    if (atob(b64.slice(0, 8)).slice(0, 4) !== '%PDF') {
      msg.textContent = 'That file is not a PDF.';
      return;
    }
    var pages = await _ppReadPdfPages(b64);
    var all = getUDBldgs(projId);
    var parsed = parsePresentedPdfText(
      pages,
      all.map(function (b) {
        return { id: b.id, name: b.name };
      }),
    );
    // The buildings the document names. When it names none, the buildings that have savings in the quarter.
    var text = pages
      .map(function (l) {
        return l.join(' ');
      })
      .join(' ')
      .toLowerCase();
    var listed = all.filter(function (b) {
      return text.indexOf(String(b.name).toLowerCase()) >= 0;
    });
    if (!listed.length)
      listed = all.filter(function (b) {
        var sv = getBuildingSavingsByYM(b, projId);
        return opt.yms.some(function (y) {
          return y in sv;
        });
      });
    _ppRenderForm(
      projId,
      opt,
      file,
      b64,
      parsed,
      listed.map(function (b) {
        return { id: b.id, name: b.name };
      }),
    );
  } catch (e) {
    msg.textContent = 'The PDF could not be read: ' + (e && e.message ? e.message : e) + ' Nothing was changed.';
  }
}

var _PP_FIELDS = [
  ['dollars', 'pf-dollars', 'Savings ($)'],
  ['kwhSaved', 'pf-kwh', 'kWh saved'],
  ['thermsSaved', 'pf-therms', 'Therms saved'],
  ['gallonsSaved', 'pf-gal', 'Gallons saved'],
  ['elecDollars', 'pf-elec', 'Electric ($)'],
  ['gasDollars', 'pf-gas', 'Gas ($)'],
  ['propaneDollars', 'pf-prop', 'Propane ($)'],
];

function _ppCell(figure, idAttr, inCss, cellCss) {
  return (
    '<td style="' + cellCss + 'vertical-align:top"><input type="number" step="any" ' + idAttr + ' style="' + inCss + '"' +
    (figure ? ' value="' + figure.value + '"' : '') + '>' +
    '<div class="pf-src" style="font-size:10px;margin-top:3px;word-break:break-word;color:' + (figure ? 'var(--text2)' : 'var(--amber)') + '">' +
    (figure ? 'Read from the PDF: ' + _escHtml(figure.src) : 'Not found in the PDF. Type it.') + '</div></td>'
  );
}

function _ppRenderForm(projId, opt, file, b64, parsed, bldgs) {
  _rptPresentedFormCtx = {
    projId: projId,
    yms: opt.yms,
    data: { period: { label: opt.label } },
    fromPdf: true,
    pdfName: file.name,
    pdfB64: b64,
    pdfPeriod: parsed.period,
    nBldgs: bldgs.length,
  };
  _rptPresentedFormPrinted = {};
  var cellCss = 'border:1px solid var(--border);padding:4px 8px;';
  var inCss = 'width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--s1);color:var(--text);font-size:12px;text-align:right';
  var thCss = 'border:1px solid var(--border);padding:5px 8px;background:var(--s1);text-align:left;font-size:11px';
  var fm = file.name.match(/(\d{4})[.\-_](\d{2})[.\-_](\d{2})/);
  var period = parsed.period;
  var mismatch = !!(period && (period.start !== opt.yms[0] || period.end !== opt.yms[2]));
  var periodNote;
  if (!period) periodNote = 'The PDF text does not name its period. Check that this PDF is for ' + opt.label + '.';
  else if (mismatch) periodNote = 'Warning: the PDF says "' + period.src + '". That is not ' + opt.label + '. Close this window and pick the matching quarter.';
  else periodNote = 'Period read from the PDF: "' + period.src + '". It matches ' + opt.label + '.';
  var rows = bldgs
    .map(function (b) {
      var f = parsed.buildings[b.id] || {};
      return (
        '<tr data-bldg="' + _escHtml(b.id) + '"><td style="' + cellCss + 'vertical-align:top">' + _escHtml(b.name) + '</td>' +
        _PP_FIELDS.map(function (x) {
          return _ppCell(f[x[0]], 'class="' + x[1] + '"', inCss, cellCss);
        }).join('') +
        '</tr>'
      );
    })
    .join('');
  var body =
    '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Period: <strong style="color:var(--text)">' + _escHtml(opt.label) + '</strong>. File: <strong style="color:var(--text)">' + _escHtml(file.name) + '</strong>. Each figure was read from the PDF text. The text it came from is under the figure. Check each one. Type any figure that was not found. A figure you leave empty is not locked.</div>' +
    '<div id="pfPeriodNote" style="font-size:12px;margin-bottom:10px;color:' + (mismatch ? 'var(--amber)' : 'var(--text2)') + '">' + _escHtml(periodNote) + '</div>' +
    '<div style="display:flex;gap:12px;margin-bottom:10px">' +
    '<label style="flex:2;font-size:12px;color:var(--text2)">Document name (from the file name)<input id="pfDocName" type="text" value="' + _escHtml(file.name.replace(/\.pdf$/i, '')) + '" style="' + inCss + ';text-align:left;margin-top:3px"></label>' +
    '<label style="flex:1;font-size:12px;color:var(--text2)">Presented on' + (fm ? ' (read from the file name: ' + _escHtml(fm[0]) + ')' : ' (not found in the file name. Type it.)') +
    '<input id="pfDate" type="date" value="' + (fm ? fm[1] + '-' + fm[2] + '-' + fm[3] : '') + '" style="' + inCss + ';text-align:left;margin-top:3px"></label></div>' +
    '<div id="pfMsg" style="font-size:12px;color:var(--text2);margin-bottom:8px"></div>' +
    '<table style="border-collapse:collapse;width:100%;font-size:12px;color:var(--text)"><thead><tr><th style="' + thCss + '">Building</th>' +
    _PP_FIELDS.map(function (x) {
      return '<th style="' + thCss + 'text-align:right">' + x[2] + '</th>';
    }).join('') +
    '</tr></thead><tbody>' + rows + '</tbody><tfoot><tr style="font-weight:600;background:var(--s1)"><td style="' + cellCss + 'vertical-align:top">Portfolio total</td>' +
    _ppCell(parsed.totalDollars, 'id="pfTotal"', inCss, cellCss) +
    '<td colspan="6" style="' + cellCss + '"></td></tr></tfoot></table>';
  document.querySelector('#presentedModal .modal').style.width = '1240px';
  document.getElementById('presentedModalBody').innerHTML = body;
  _ppSetFooter(true);
}
