/**
 * report-pdf.js - one-click "Download PDF" for every report that shows page boxes
 * (savings reports, ASHRAE 36 Audit Report, Service Proposal, audit proposals, Agreement,
 * Sequence of Operations, board and utility audit summaries). ONE shared function:
 * downloadReportPdf(). There is no print path.
 *
 * Method (all in the browser, no server): for each report page, html2canvas draws the page
 * to an image (same pixels as the screen preview), jsPDF puts that image on an 8.5 x 11 in
 * Letter page, and the words of the page are added on top as invisible real text, at the
 * place of each word. So the file looks like the report, and its text can be selected,
 * copied and searched. html2canvas and jsPDF are the libraries already loaded on the page
 * (energy-department.html). The page footer "Page N of M" is part of the page markup, so it
 * is in the file the same way it is in the print.
 * Cost: the page text is a picture, not vector. The file is larger than a print-to-PDF file.
 *
 * File name: rptReportFileName() (lib/report-file-name.js), the same rule as print and Word.
 * Pages: _rptReportExportPages() and _rptForceOpenTierPanels() (report-engine.js), the same
 * pages the print path uses.
 */

// Letter page in CSS px (96 per inch) and in PDF points (72 per inch).
var RPT_PDF_PAGE_W_PX = 816;
var RPT_PDF_PAGE_H_PX = 1056;
var RPT_PDF_PT_PER_PX = 0.75;
// 2.5x = 240 dpi, JPEG 0.75: the page text is a picture, so it must be sharp at 200% zoom on screen (Matt, 2026-11-06:
// "text is out of focus on the PDF download"; at 1.25x / 0.6 = 120 dpi it was). File size is in docs/OPERATIONS.md.
var RPT_PDF_RASTER_SCALE = 2.5;
var RPT_PDF_JPEG_QUALITY = 0.75;

// jsPDF standard fonts write Windows-1252 text. Map other characters to plain text.
var _RPT_PDF_CHAR_MAP = {
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '←': '<-',
  '−': '-',
  '✓': 'x',
  '✔': 'x',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
};
var _RPT_PDF_CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

function _rptPdfSafeText(str) {
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    var code = str.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || _RPT_PDF_CP1252_EXTRA.indexOf(ch) !== -1) {
      out += ch;
    } else if (_RPT_PDF_CHAR_MAP[ch] !== undefined) {
      out += _RPT_PDF_CHAR_MAP[ch];
    } else if (code > 0x7e) {
      out += '?';
    }
  }
  return out;
}

function _rptPdfApplyTextTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
  return text;
}

/**
 * _rptPdfCollectWords - every visible word on a page with its box, in px from the page's
 * top-left corner. Words outside the page box (clipped away) are left out.
 */
function _rptPdfCollectWords(page) {
  var origin = page.getBoundingClientRect();
  var sx = page.offsetWidth ? origin.width / page.offsetWidth : 1;
  var sy = page.offsetHeight ? origin.height / page.offsetHeight : 1;
  var words = [];
  var range = document.createRange();
  var walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var text = node.nodeValue;
    if (!text || !/\S/.test(text)) continue;
    var el = node.parentElement;
    if (!el || el.closest('script,style,noscript,template')) continue;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      var rects = range.getClientRects();
      if (!rects.length) continue;
      var r = rects[0];
      if (r.width < 0.5 || r.height < 1) continue;
      var x = (r.left - origin.left) / sx;
      var y = (r.top - origin.top) / sy;
      var w = r.width / sx;
      var h = r.height / sy;
      if (x + w < 0 || y + h < 0 || x > origin.width / sx || y > origin.height / sy) continue;
      var t = _rptPdfSafeText(_rptPdfApplyTextTransform(m[0], cs.textTransform));
      if (!t) continue;
      words.push({ t: t, x: x, y: y, w: w, h: h });
    }
  }
  return words;
}

/**
 * _rptPdfPageCuts - where a page taller than one Letter sheet is cut: the list of [start, end]
 * rows in px. A cut never goes through a line of text. A page of one sheet gives one pair.
 */
function _rptPdfPageCuts(totalH, words) {
  if (totalH <= RPT_PDF_PAGE_H_PX + 2) return [[0, totalH]];
  var cuts = [];
  var start = 0;
  while (totalH - start > RPT_PDF_PAGE_H_PX + 2) {
    var cut = start + RPT_PDF_PAGE_H_PX;
    for (var pass = 0; pass < 50; pass++) {
      var moved = false;
      for (var i = 0; i < words.length; i++) {
        var wd = words[i];
        if (wd.y < cut - 0.5 && wd.y + wd.h > cut + 0.5 && wd.y > start + RPT_PDF_PAGE_H_PX * 0.5) {
          cut = wd.y;
          moved = true;
        }
      }
      if (!moved) break;
    }
    cuts.push([start, cut]);
    start = cut;
  }
  cuts.push([start, totalH]);
  return cuts;
}

/**
 * _rptPdfFlattenTables - html2canvas does not draw collapsed table borders: it draws every cell
 * border on its own, so lines look double and cell corners look round. In the copy of the page
 * that html2canvas draws, each collapsed table becomes a separate-border table with no gap, a
 * cell keeps its left and top border only where no neighbour already draws that line, and
 * table and cell corners are square (the print look).
 */
function _rptPdfFlattenTables(root, win) {
  var tables = root.querySelectorAll('table');
  for (var ti = 0; ti < tables.length; ti++) {
    var table = tables[ti];
    var tcs = win.getComputedStyle(table);
    table.style.borderRadius = '0';
    if (tcs.borderCollapse !== 'collapse') continue;
    table.style.borderCollapse = 'separate';
    table.style.borderSpacing = '0';
    // Grid of the table: grid[row][col] is the cell that covers that slot. A cell with rowspan or
    // colspan fills several slots, so a neighbour is found by slot, never by position in the row.
    var rows = table.rows;
    var grid = [];
    var cellList = [];
    for (var ri = 0; ri < rows.length; ri++) {
      grid[ri] = grid[ri] || [];
      var gc = 0;
      for (var ci = 0; ci < rows[ri].cells.length; ci++) {
        var cell = rows[ri].cells[ci];
        while (grid[ri][gc]) gc++;
        var rs = cell.rowSpan || 1;
        var cs = cell.colSpan || 1;
        for (var r2 = ri; r2 < ri + rs && r2 < rows.length; r2++) {
          grid[r2] = grid[r2] || [];
          for (var c2 = gc; c2 < gc + cs; c2++) grid[r2][c2] = cell;
        }
        cellList.push({ cell: cell, row: ri, col: gc, cs: cs });
        gc += cs;
      }
    }
    var bw = function (el, side) {
      return parseFloat(win.getComputedStyle(el)['border' + side + 'Width']) || 0;
    };
    for (var li = 0; li < cellList.length; li++) {
      var it = cellList[li];
      it.cell.style.borderRadius = '0';
      var left = it.col > 0 ? grid[it.row][it.col - 1] : null;
      var leftW = bw(it.cell, 'Left');
      var topW = bw(it.cell, 'Top');
      var dropLeft = !!left && left !== it.cell && bw(left, 'Right') >= leftW;
      var dropTop = it.row > 0 && topW > 0;
      for (var tc = it.col; dropTop && tc < it.col + it.cs; tc++) {
        var above = grid[it.row - 1][tc];
        if (!above || above === it.cell || bw(above, 'Bottom') < topW) dropTop = false;
      }
      it._dropLeft = dropLeft;
      it._dropTop = dropTop;
    }
    // html2canvas paints a row background after the cells of the rows above it. A row background of
    // the second row of a rowspan group would cover the lower half of the merged cell (its border and
    // its fill). Each row background moves onto the cells of that row, so nothing paints over a
    // merged cell.
    for (var bi = 0; bi < rows.length; bi++) {
      var rowBg = win.getComputedStyle(rows[bi]).backgroundColor;
      if (!rowBg || rowBg === 'transparent' || rowBg === 'rgba(0, 0, 0, 0)') continue;
      for (var bc = 0; bc < rows[bi].cells.length; bc++) {
        var bcell = rows[bi].cells[bc];
        var cellBg = win.getComputedStyle(bcell).backgroundColor;
        if (!cellBg || cellBg === 'transparent' || cellBg === 'rgba(0, 0, 0, 0)') bcell.style.backgroundColor = rowBg;
      }
      rows[bi].style.backgroundColor = 'transparent';
    }
    // Set after every measurement: dropping a border must not change what a neighbour measures.
    for (var si = 0; si < cellList.length; si++) {
      if (cellList[si]._dropLeft) cellList[si].cell.style.borderLeftWidth = '0';
      if (cellList[si]._dropTop) cellList[si].cell.style.borderTopWidth = '0';
    }
  }
}

/**
 * downloadReportPdf - saves the open report as a PDF file with one click. See the file header.
 */
async function downloadReportPdf() {
  var data = window._currentReportData;
  if (!data) {
    showToast('No report data available');
    return;
  }
  if (typeof html2canvas === 'undefined' || !window.jspdf || !window.jspdf.jsPDF) {
    showToast('The PDF library did not load. Check the internet connection and reload the page.', 'error');
    return;
  }
  var found = _rptReportExportPages(data);
  var pages = found.pages.filter(function (p) {
    return p.getClientRects().length > 0;
  });
  if (!pages.length) {
    showToast('No report pages to export');
    return;
  }
  if (window._rptPdfBusy) return;
  window._rptPdfBusy = true;
  var filename = rptReportFileName(data, '.pdf');
  var restoreTierPanels = _rptForceOpenTierPanels(found.pagesRoot);
  try {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait', compress: true });
    doc.setProperties({ title: filename.replace(/\.pdf$/, '') });
    var first = true;
    var sheet = 0;
    for (var pi = 0; pi < pages.length; pi++) {
      var page = pages[pi];
      showToast('Building PDF: page ' + (pi + 1) + ' of ' + pages.length, '', 4000);
      // let the toast paint before the heavy work
      await new Promise(function (r) {
        setTimeout(r, 30);
      });
      var words = _rptPdfCollectWords(page);
      var cssW = page.offsetWidth || RPT_PDF_PAGE_W_PX;
      var cssH = page.offsetHeight;
      page.setAttribute('data-rpt-pdf-cur', '1');
      var keepPath = new Set();
      for (var anc = page; anc; anc = anc.parentNode) keepPath.add(anc);
      var canvas;
      try {
        canvas = await html2canvas(page, {
        scale: RPT_PDF_RASTER_SCALE,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
        scrollX: 0,
        scrollY: 0,
        // html2canvas copies the whole document for every call, which is slow here (the app and
        // every other page are in it). Skip the copy of every element that is neither this page,
        // nor inside it, nor a parent of it: only the parents that carry its styles are kept.
        ignoreElements: function (el) {
          var par = el.parentNode;
          return !!par && par !== page && keepPath.has(par) && !keepPath.has(el) && el !== document.head;
        },
        onclone: function (clonedDoc) {
          var mine = clonedDoc.querySelector('[data-rpt-pdf-cur]');
          if (mine) _rptPdfFlattenTables(mine, clonedDoc.defaultView);
        },
        });
      } finally {
        page.removeAttribute('data-rpt-pdf-cur');
      }
      var cuts = _rptPdfPageCuts(cssH, words);
      var k = canvas.height / cssH; // canvas px per CSS px
      for (var ci = 0; ci < cuts.length; ci++) {
        var c0 = cuts[ci][0];
        var c1 = cuts[ci][1];
        var jpeg;
        if (cuts.length === 1) {
          jpeg = canvas.toDataURL('image/jpeg', RPT_PDF_JPEG_QUALITY);
        } else {
          var slice = document.createElement('canvas');
          slice.width = canvas.width;
          slice.height = Math.max(1, Math.round((c1 - c0) * k));
          var sctx = slice.getContext('2d');
          sctx.fillStyle = '#ffffff';
          sctx.fillRect(0, 0, slice.width, slice.height);
          sctx.drawImage(canvas, 0, Math.round(c0 * k), canvas.width, slice.height, 0, 0, slice.width, slice.height);
          jpeg = slice.toDataURL('image/jpeg', RPT_PDF_JPEG_QUALITY);
          slice.width = slice.height = 0;
        }
        if (!first) doc.addPage('letter', 'portrait');
        first = false;
        sheet++;
        var wPt = cssW * RPT_PDF_PT_PER_PX;
        var hPt = (c1 - c0) * RPT_PDF_PT_PER_PX;
        // A page about one sheet high fills the sheet exactly; a short last slice keeps its height.
        if (cuts.length === 1 && Math.abs(hPt - 792) < 2) hPt = 792;
        doc.addImage(jpeg, 'JPEG', 0, 0, wPt, hPt, undefined, 'FAST');
        // Invisible real text on top of the picture: selectable, copyable, searchable.
        for (var wi = 0; wi < words.length; wi++) {
          var wd = words[wi];
          var cy = wd.y + wd.h / 2;
          if (cy < c0 || cy >= c1) continue;
          var sizePt = Math.max(2, (wd.h / 1.15) * RPT_PDF_PT_PER_PX);
          doc.setFontSize(sizePt);
          var natural = doc.getTextWidth(wd.t);
          var space = wd.t.length ? (wd.w * RPT_PDF_PT_PER_PX - natural) / wd.t.length : 0;
          doc.text(wd.t, wd.x * RPT_PDF_PT_PER_PX, (wd.y - c0 + wd.h * 0.8) * RPT_PDF_PT_PER_PX, {
            renderingMode: 'invisible',
            charSpace: space,
          });
        }
      }
      canvas.width = canvas.height = 0;
      canvas = null;
      // give the browser a turn so the page stays responsive
      await new Promise(function (r) {
        setTimeout(r, 0);
      });
    }
    var blob = doc.output('blob');
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
    showToast('PDF saved: ' + filename + ' (' + sheet + ' pages)', 'success', 6000);
  } catch (err) {
    console.error('downloadReportPdf failed:', err);
    showToast('Could not build the PDF: ' + (err && err.message ? err.message : err), 'error', 8000);
  } finally {
    restoreTierPanels();
    window._rptPdfBusy = false;
  }
}
window.downloadReportPdf = downloadReportPdf;
