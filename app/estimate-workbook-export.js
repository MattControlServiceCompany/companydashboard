/* Estimate workbook Excel export (UMD: browser + node). No DOM or storage access.
   Loads app/assets/estimate-template.xlsx (macro-free copy of the CSC change-order workbook with
   every input blank), writes ONLY input cells, keeps every formula, sets each formula cell's cached
   result from EstimateWorkbook.compute(), and asks Excel for a full recalculation on load.
   Browser: needs the ExcelJS global (CDN, already loaded by the app). Node: requires 'exceljs'. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./estimate-workbook.js'));
  else root.EstimateWorkbookExport = factory(root.EstimateWorkbook);
})(typeof self !== 'undefined' ? self : this, function (EW) {
  'use strict';

  var TEMPLATE_URL = 'app/assets/estimate-template.xlsx';
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  // compute() cell-key prefix -> template sheet name
  var SHEET_OF_PREFIX = { Dash: 'Dash', MatEquip: 'Mat & Equip', LaborRates: 'Labor Rates' };
  var QUOTE = 'CSC Parts Quote';

  function getExcelJS(opts) {
    if (opts && opts.ExcelJS) return opts.ExcelJS;
    if (typeof ExcelJS !== 'undefined') return ExcelJS; // browser global
    if (typeof require === 'function') return require('exceljs');
    throw new Error('ExcelJS is not available');
  }

  function loadTemplateBytes(opts) {
    if (opts && opts.templateBytes) return Promise.resolve(opts.templateBytes);
    if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function') {
      var fs = require('fs'),
        path = require('path');
      return Promise.resolve(fs.readFileSync(path.join(__dirname, 'assets', 'estimate-template.xlsx')));
    }
    return fetch((opts && opts.templateUrl) || TEMPLATE_URL).then(function (r) {
      if (!r.ok) throw new Error('Template not found: ' + r.status);
      return r.arrayBuffer();
    });
  }

  function parseDate(d) {
    if (d instanceof Date) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  }
  function serial(date) {
    return (date.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
  }
  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }
  function slug(s) {
    return (
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'project'
    );
  }
  // YYYY-MM-DD-<project-slug>-estimate.xlsx
  function fileName(meta) {
    var m = meta || {};
    return isoDate(parseDate(m.date)) + '-' + slug(m.project) + '-estimate.xlsx';
  }

  function isFormula(v) {
    return !!v && typeof v === 'object' && (v.formula != null || v.sharedFormula != null);
  }
  function setResult(cell, result) {
    var v = cell.value;
    if (!isFormula(v)) return false;
    var o = {};
    Object.keys(v).forEach(function (k) {
      o[k] = v[k];
    });
    o.result = result;
    cell.value = o;
    return true;
  }
  function plain(cell) {
    var v = cell.value;
    if (isFormula(v)) v = v.result;
    if (v == null || v === '') return 0;
    if (v instanceof Date) return serial(v);
    if (typeof v === 'object' && v.richText)
      return v.richText
        .map(function (r) {
          return r.text;
        })
        .join('');
    return v;
  }
  function put(ws, addr, v) {
    if (v == null || v === '') return;
    ws.getCell(addr).value = v;
  }

  // Write every input cell of the template from the compute() input and the meta block.
  function writeInputs(wb, input, meta, date) {
    var inp = input || {};
    var info = wb.getWorksheet('Info'),
      dash = wb.getWorksheet('Dash'),
      mat = wb.getWorksheet('Mat & Equip'),
      quote = wb.getWorksheet(QUOTE),
      labor = wb.getWorksheet('Labor Rates');
    var D = EW.DEFAULTS;
    var project = meta.project || '';

    put(info, 'C7', project);
    put(info, 'C9', meta.title || project);
    put(info, 'C12', meta.preparedBy);
    put(info, 'C16', meta.customer);
    info.getCell('F7').value = date;
    info.getCell('F8').value = date; // static export date (template formula was TODAY())
    info.getCell('F13').value = inp.taxRate != null ? Number(inp.taxRate) : D.taxRate;
    info.getCell('F15').value = (inp.bond != null ? inp.bond : D.bond) ? 'Applicable' : 'Not Applicable';
    info.getCell('F16').value = inp.ot || D.ot;
    info.getCell('F18').value = inp.state || D.state;

    var pct = {};
    Object.keys(D.pct).forEach(function (k) {
      pct[k] = inp.pct && inp.pct[k] != null ? Number(inp.pct[k]) : D.pct[k];
    });
    dash.getCell('D17').value = pct.warrantyFactor;
    dash.getCell('F22').value = pct.freight;
    dash.getCell('F32').value = pct.smallTools;
    dash.getCell('F37').value = pct.safety;
    dash.getCell('M27').value = pct.overhead;
    dash.getCell('M28').value = pct.profit;
    dash.getCell('M31').value = pct.subProfit;
    if (pct.bond !== D.pct.bond)
      dash.getCell('M35').value = { formula: 'IF(Info!F15="Applicable",' + pct.bond + ',0)' };

    // labor hours (Dash E8:E16) and base-rate overrides (Labor Rates col D)
    var table = EW.rateTable(inp.baseRates);
    var hours = inp.hours || {};
    table.forEach(function (rr) {
      if (hours[rr.code] != null) dash.getCell('E' + rr.dashRow).value = Number(hours[rr.code]);
      if (inp.baseRates && inp.baseRates[rr.code] != null)
        labor.getCell('D' + rr.row).value = Number(inp.baseRates[rr.code]);
    });

    (inp.parts || []).forEach(function (p, i) {
      if (i >= D.limits.parts || !p) return;
      var row = 8 + i;
      put(mat, 'B' + row, p.partNo);
      put(mat, 'C' + row, p.desc);
      put(mat, 'D' + row, p.code);
      if (p.qty != null) mat.getCell('E' + row).value = Number(p.qty);
      if (p.unit != null) quote.getCell('E' + (11 + i)).value = Number(p.unit);
    });
    (inp.tools || []).forEach(function (t, i) {
      if (i >= D.limits.tools || !t) return;
      var row = 27 + i;
      if (t.qty != null) dash.getCell('D' + row).value = Number(t.qty);
      if (t.hrs != null) dash.getCell('E' + row).value = Number(t.hrs);
      if (t.rate != null) dash.getCell('F' + row).value = Number(t.rate);
    });
    var vans = inp.vans || {};
    if (vans.qty != null) dash.getCell('E38').value = Number(vans.qty);
    if (vans.rate != null) dash.getCell('F38').value = Number(vans.rate);
    (inp.misc || []).forEach(function (m, i) {
      if (i >= D.limits.misc || !m) return;
      var row = 39 + i;
      if (m.qty != null) dash.getCell('E' + row).value = Number(m.qty);
      if (m.rate != null) dash.getCell('F' + row).value = Number(m.rate);
    });
    (inp.subs || []).forEach(function (s, i) {
      if (i >= D.limits.subs || !s) return;
      var row = 8 + i;
      if (s.amount != null) dash.getCell('L' + row).value = Number(s.amount);
      if (s.bondPct != null) dash.getCell('M' + row).value = Number(s.bondPct);
    });
  }

  // Cached results: compute() cells, then simple mirror / helper formulas the engine does not model.
  function writeCachedResults(wb, calc, dateSerial) {
    var cells = calc.cells;
    Object.keys(cells).forEach(function (key) {
      var i = key.indexOf('!');
      var sheetName = SHEET_OF_PREFIX[key.slice(0, i)];
      if (!sheetName) return;
      var cell = wb.getWorksheet(sheetName).getCell(key.slice(i + 1));
      var v = cells[key];
      setResult(cell, v == null ? { error: '#DIV/0!' } : v);
    });

    var refRe = /^(?:(Info|'Mat & Equip'|Dash|'Labor Rates')!)\$?([A-Z]+)\$?(\d+)$/;
    var expReg = /^Info!F8\+30$/;
    wb.eachSheet(function (ws) {
      ws.eachRow(function (row) {
        row.eachCell(function (cell) {
          var v = cell.value;
          if (!isFormula(v) || v.formula == null || v.result !== undefined) return;
          var f = v.formula,
            m;
          if ((m = refRe.exec(f))) {
            var src = wb.getWorksheet(m[1].replace(/'/g, ''));
            setResult(cell, plain(src.getCell(m[2] + m[3])));
          } else if (expReg.test(f)) {
            setResult(cell, dateSerial + 30);
          } else if (f === 'NOW()' || f === 'TODAY()') {
            setResult(cell, dateSerial);
          } else if (f === 'IF(F13=0%,"Applicable","Not Applicable")') {
            setResult(cell, plain(ws.getCell('F13')) === 0 ? 'Applicable' : 'Not Applicable');
          } else if ((m = /^ROUND\(E(\d+)\*D(\d+),0\)$/.exec(f)) && ws.name === QUOTE) {
            setResult(cell, EW.round0(Number(plain(ws.getCell('E' + m[1]))) * Number(plain(ws.getCell('D' + m[2])))));
          } else if (f === 'SUM(F11:F36)' && ws.name === QUOTE) {
            var t = 0;
            for (var r = 11; r <= 36; r++) t += Number(plain(ws.getCell('F' + r)));
            setResult(cell, t);
          } else if (f === 'E18/769' && ws.name === 'Dash') {
            setResult(cell, calc.cells['Dash!E18'] / 769);
          }
        });
      });
    });
  }

  // ExcelJS writes a "containsBlanks" rule with operator="containsBlanks", which is not a valid
  // OOXML operator (Excel may offer to repair the file). Rewrite those rules as the equivalent
  // expression rule, which is what Excel itself evaluates: LEN(TRIM(<top-left cell>))=0.
  function fixBlankRules(wb) {
    wb.eachSheet(function (ws) {
      (ws.conditionalFormattings || []).forEach(function (cf) {
        var tl = String(cf.ref).split(/[ :]/)[0];
        cf.rules = (cf.rules || []).map(function (rule) {
          if (rule.operator !== 'containsBlanks' && rule.operator !== 'notContainsBlanks') return rule;
          var f = rule.operator === 'containsBlanks' ? 'LEN(TRIM(' + tl + '))=0' : 'LEN(TRIM(' + tl + '))>0';
          return { type: 'expression', formulae: [f], priority: rule.priority, style: rule.style };
        });
      });
    });
  }

  /* exportWorkbook(input, meta, opts) -> Promise<ArrayBuffer|Buffer>
       input: same object EstimateWorkbook.compute() takes (parts may also carry partNo, desc, code)
       meta:  {customer, project, title, date ('YYYY-MM-DD' or Date), preparedBy}
       opts:  {ExcelJS, templateBytes, templateUrl} (tests and special hosts only) */
  function exportWorkbook(input, meta, opts) {
    var m = meta || {};
    var Lib = getExcelJS(opts);
    var calc = EW.compute(input);
    var date = parseDate(m.date);
    return loadTemplateBytes(opts).then(function (bytes) {
      var wb = new Lib.Workbook();
      return wb.xlsx.load(bytes).then(function () {
        writeInputs(wb, input, m, date);
        writeCachedResults(wb, calc, serial(date));
        fixBlankRules(wb);
        wb.calcProperties = { fullCalcOnLoad: true };
        wb.creator = 'Control Service Company';
        wb.lastModifiedBy = m.preparedBy || 'Control Service Company';
        wb.created = date;
        wb.modified = date;
        return wb.xlsx.writeBuffer();
      });
    });
  }

  // Browser helper: same as exportWorkbook but resolves to a Blob.
  function exportBlob(input, meta, opts) {
    return exportWorkbook(input, meta, opts).then(function (buf) {
      return new Blob([buf], { type: XLSX_MIME });
    });
  }

  return { exportWorkbook: exportWorkbook, exportBlob: exportBlob, fileName: fileName, XLSX_MIME: XLSX_MIME };
});
