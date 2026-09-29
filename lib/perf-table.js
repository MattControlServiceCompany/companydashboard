// lib/perf-table.js — Shared Meter Performance table rendering (canonical source)
// Depends on: savings.js (getMeterSavings) only. This file does NO savings math of its own:
// every usage, rate and dollar figure below is a row returned by getMeterSavings (WP-04), so the
// table, the dashboards, the reports and the portal cannot disagree. It only chooses columns,
// formats numbers and adds up the rows it shows.
//
// Used by: renderPerfPane (Meter Performance tab) and report generation.
// This is THE one source of truth for the Meter Performance table.

function buildMeterPerfTableHTML(m, bills, incl, opts) {
  opts = opts || {};
  var mode = opts.mode || 'tab'; // 'tab' or 'report'
  var wrapperId = opts.wrapperId || 'perf-table-wrap'; // allow callers to set distinct id
  var filterYMs = opts.filterYMs || null; // null = all post-baseline, or array of YYYY-MM

  var bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return { html: '', rows: [], incompleteMonths: [] };

  var isElec = m.commodity === 'Electric';
  var isPropane = m.commodity === 'Propane';
  var isGas = m.commodity === 'Gas';
  var unit = isElec ? 'kWh' : isPropane ? 'Gal' : isGas ? 'Therms' : 'Units';
  var costUnitLabel = isPropane ? 'Gallon' : isGas ? 'Therm' : '';

  // The one savings function. A project with no Service Agreement gets the same rows with
  // every dollar at 0 (usage and rate columns still show). opts.effectiveRows = the
  // normal-weather view (Meter Performance tab); it changes the prediction only.
  var savResult = getMeterSavings(m, bills, incl, opts.projId, opts.bldgId, { effectiveRows: opts.effectiveRows });
  var savRows = savResult.rows || [];
  if (filterYMs) {
    savRows = savRows.filter(function (r) {
      return filterYMs.includes(r.ym);
    });
  }
  if (!savRows.length) return { html: '', rows: [], incompleteMonths: [] };

  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var rowData = savRows.map(function (r) {
    var sav = r.expUsage - r.actUsage;
    var parts = r.ym.split('-');
    return {
      ym: r.ym,
      label: monthNames[parseInt(parts[1]) - 1] + ' ' + parts[0],
      normDays: r.normDays,
      expUsage: r.expUsage,
      rawUsage: r.actUsage,
      sav: sav,
      savPc: r.expUsage > 0 ? (sav / r.expUsage) * 100 : 0,
      kwhRate: r.kwhRate,
      kwhCostSav: r.kwhCostSav,
      thermRate: r.unitRate,
      thermCostSav: isElec ? 0 : r.savings,
      blExpKW: r.blExpKW,
      demKW: r.demKW,
      bilKW: r.bilKW,
      moKwRate: r.kwRate,
      kwCostSav: r.kwCostSav,
      totalCostSav: isElec ? r.savings : 0,
      savings: r.savings,
      pinned: r.pinned,
      rateIncomplete: r.rateIncomplete,
      rateReason: r.rateReason,
    };
  });

  // a67db8ce: only treat a row as a FALSE $0 when the rate gap actually zeroed the
  // displayed total (d.savings === 0). A month with one real rate (e.g. kWh) and one
  // missing rate (e.g. kW) still shows a real, non-zero, unmodified number — that must
  // not be hidden or excluded; only a bare, unexplained $0.00 is the bug this fixes.
  var _isFalseZero = function (d) {
    return d.rateIncomplete && d.savings === 0;
  };

  // Client documents (mode 'report') never show a data-quality label — a false-zero
  // month is left out of the report table and its total entirely instead ("leave the
  // month out of the total, and list the fix on the site"). The site (mode 'tab')
  // keeps the month and renders an explicit warning row in its place. Either way the
  // month is not a data row, so it is left out of every column of the Total row too
  // (Days, usage and dollars foot to the rows the reader can see - WP-04, math-02 H2).
  var dataRows = rowData.filter(function (d) {
    return !_isFalseZero(d);
  });

  // Detect which columns have data
  var hasExpKW = false,
    hasKwData = false,
    hasBilKW = false,
    hasKwCostSav = false;
  var hasKwhCostSav = false,
    hasGasCostSav = false,
    hasTotalCostSav = false;
  if (isElec) {
    hasKwhCostSav = true;
    hasTotalCostSav = true;
    hasKwData = rowData.some(function (d) {
      return d.demKW > 0;
    });
    hasBilKW = rowData.some(function (d) {
      return d.bilKW > 0;
    });
    hasExpKW = rowData.some(function (d) {
      return d.blExpKW > 0;
    });
    hasKwCostSav = hasExpKW || hasKwData;
    // Hide Billed kW if it always equals Demand kW
    if (hasBilKW && hasKwData) {
      var allSame = rowData.every(function (d) {
        return Math.abs(d.demKW - d.bilKW) <= 0.01;
      });
      if (allSame) hasBilKW = false;
    }
  } else {
    hasGasCostSav = true; // gas/propane: therm savings IS total savings
  }

  // Colors
  var emColor = mode === 'tab' ? 'var(--em)' : '#1e8449';
  var dangerColor = mode === 'tab' ? 'var(--danger)' : '#c0392b';
  var mutedColor = mode === 'tab' ? 'var(--text2)' : '#666';
  var violetColor = mode === 'tab' ? 'var(--violet)' : '#7d3c98';
  var borderColor = mode === 'tab' ? 'var(--border2)' : '#bbb';
  var bgColor = mode === 'tab' ? 'var(--s1)' : '#f5f5f5';
  var borderLine = mode === 'tab' ? 'var(--border)' : '#ccc';

  var savColor = function (v) {
    return v >= 0 ? emColor : dangerColor;
  };
  var costSign = function (v) {
    return v >= 0 ? '' : '−';
  };
  var savSign = function (v) {
    return v >= 0 ? '+' : '−';
  };
  var fmtN = function (v, d) {
    if (d === undefined) d = 0;
    return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  var fmtC = function (v) {
    return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Total row = SUM of the data rows shown above it, column by column.
  var sumTotalSav = 0,
    sumKwhSav = 0,
    sumKwSav = 0,
    sumThermSav = 0;
  var sumExpUsage = 0;
  var sumRawUsage = 0;
  var sumUnitSav = 0;
  var sumExpKW = 0;
  var sumActKW = 0;
  var sumBilKW = 0;
  var sumNormDays = 0;
  dataRows.forEach(function (d) {
    sumTotalSav += d.savings;
    sumKwhSav += d.kwhCostSav;
    sumKwSav += d.kwCostSav;
    sumThermSav += d.thermCostSav;
    sumExpUsage += d.expUsage || 0;
    sumRawUsage += d.rawUsage || 0;
    sumUnitSav += d.sav || 0;
    sumExpKW += d.blExpKW || 0;
    sumActKW += d.demKW || 0;
    sumBilKW += d.bilKW || 0;
    sumNormDays += d.normDays || 0;
  });

  // Table classes
  var tblClass = mode === 'tab' ? 'ma-tbl' : 'rpt-table rpt-table-compact';
  var numClass = mode === 'tab' ? 'mono num' : 'rpt-n';
  var lblClass = mode === 'tab' ? 'lbl' : '';
  var fontSize = mode === 'report' ? 'font-size:6.5px;' : '';
  var rpt = mode === 'report';

  // Abbreviated headers for report mode to prevent column overflow. This table can run to 16
  // narrow columns at 6.5px print font (see fontSize above) -- the BL/Act/Sav $ abbreviations
  // are a deliberate, documented width tradeoff, out of scope for the 2026-09-24 header-overflow
  // fix (task 5b) to unwind without a full column-width re-tuning pass. The one piece that IS
  // in scope: 'kWh' must print in its real case even under this table's all-caps <th> styling
  // (same _rptUnit() fix as report-engine.js's own tables) -- mixed-case is never wider than the
  // all-caps rendering it replaces, so this cannot introduce new overflow.
  var _kwhHdr = typeof _rptUnit === 'function' ? _rptUnit('kWh') : 'kWh';
  var H_MONTH = 'Month';
  var H_NDAYS = rpt ? 'Days' : 'Normalized Days';
  var H_BL_USAGE = rpt ? 'BL ' + (unit === 'kWh' ? _kwhHdr : unit) : 'Baseline ' + unit;
  var H_ACT_USAGE = rpt ? 'Act ' + (unit === 'kWh' ? _kwhHdr : unit) : 'Actual ' + unit;
  var H_SAVED = (unit === 'kWh' ? _kwhHdr : unit) + ' Saved';
  var H_KWH_RATE = rpt ? '$/' + _kwhHdr : 'Actual $/kWh';
  var H_KWH_SAV = rpt ? _kwhHdr + ' Sav $' : 'kWh Savings ($)';
  var H_GAS_RATE = rpt ? '$/' + costUnitLabel : 'Actual $/' + costUnitLabel;
  var H_GAS_SAV = rpt ? costUnitLabel + ' Sav $' : costUnitLabel + ' Savings ($)';
  var H_BL_KW = rpt ? 'BL kW' : 'Baseline kW';
  var H_ACT_KW = rpt ? 'Act kW' : 'Actual kW';
  var H_BIL_KW = rpt ? 'Bld kW' : 'Billed kW';
  var H_KW_RATE = rpt ? '$/kW' : 'Actual $/kW';
  var H_KW_SAV = rpt ? 'kW Sav $' : 'kW Savings ($)';
  var H_TOTAL = rpt ? 'Total $' : 'Total Savings ($)';

  // Build header
  var hdr =
    '<tr>' +
    '<th class="' +
    lblClass +
    '">' +
    H_MONTH +
    '</th>' +
    '<th class="' +
    numClass +
    '">' +
    H_NDAYS +
    '</th>' +
    '<th class="' +
    numClass +
    '">' +
    H_BL_USAGE +
    '</th>' +
    '<th class="' +
    numClass +
    '">' +
    H_ACT_USAGE +
    '</th>' +
    '<th class="' +
    numClass +
    '">' +
    H_SAVED +
    '</th>' +
    '<th class="' +
    numClass +
    '">%</th>';
  if (hasKwhCostSav) hdr += '<th class="' + numClass + '">' + H_KWH_RATE + '</th>';
  if (hasKwhCostSav) hdr += '<th class="' + numClass + '">' + H_KWH_SAV + '</th>';
  if (hasGasCostSav) hdr += '<th class="' + numClass + '">' + H_GAS_RATE + '</th>';
  if (hasGasCostSav) hdr += '<th class="' + numClass + '">' + H_GAS_SAV + '</th>';
  if (hasExpKW) hdr += '<th class="' + numClass + '">' + H_BL_KW + '</th>';
  if (hasKwData) hdr += '<th class="' + numClass + '">' + H_ACT_KW + '</th>';
  if (hasBilKW) hdr += '<th class="' + numClass + '">' + H_BIL_KW + '</th>';
  if (hasKwCostSav) hdr += '<th class="' + numClass + '">' + H_KW_RATE + '</th>';
  if (hasKwCostSav) hdr += '<th class="' + numClass + '">' + H_KW_SAV + '</th>';
  if (hasTotalCostSav) hdr += '<th class="' + numClass + '">' + H_TOTAL + '</th>';
  hdr += '</tr>';
  // Total column count — used to span the incomplete-rate warning row below.
  var colCount =
    6 +
    (hasKwhCostSav ? 2 : 0) +
    (hasGasCostSav ? 2 : 0) +
    (hasExpKW ? 1 : 0) +
    (hasKwData ? 1 : 0) +
    (hasBilKW ? 1 : 0) +
    (hasKwCostSav ? 2 : 0) +
    (hasTotalCostSav ? 1 : 0);

  // Build rows
  var rowsHTML = '';
  (rpt ? dataRows : rowData).forEach(function (d) {
    if (!rpt && _isFalseZero(d)) {
      rowsHTML +=
        '<tr style="background:rgba(230,126,34,0.12)">' +
        '<td class="' +
        lblClass +
        '">' +
        d.label +
        '</td>' +
        '<td class="' +
        numClass +
        '" colspan="' +
        (colCount - 1) +
        '" style="text-align:left;color:var(--warn,#e67e22);font-weight:600">' +
        '⚠ Rate unavailable this month (' +
        d.rateReason +
        ') — savings excluded from the total, not shown as $0.00' +
        '</td>' +
        '</tr>';
      return;
    }
    rowsHTML +=
      '<tr>' +
      '<td class="' +
      lblClass +
      '">' +
      d.label +
      '</td>' +
      '<td class="' +
      numClass +
      '">' +
      d.normDays +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      mutedColor +
      '">' +
      fmtN(d.expUsage) +
      '</td>' +
      '<td class="' +
      numClass +
      '">' +
      fmtN(d.rawUsage) +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(d.sav) +
      '">' +
      savSign(d.sav) +
      fmtN(Math.abs(d.sav)) +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(d.savPc) +
      '">' +
      savSign(d.savPc) +
      Math.abs(d.savPc).toFixed(1) +
      '%</td>';
    if (hasKwhCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        mutedColor +
        '">' +
        (d.kwhRate > 0 ? '$' + d.kwhRate.toFixed(5) : '&mdash;') +
        '</td>';
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.kwhCostSav) +
        ';font-weight:600">' +
        (d.kwhRate > 0 ? costSign(d.kwhCostSav) + '$' + fmtC(d.kwhCostSav) : '&mdash;') +
        '</td>';
    }
    if (hasGasCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        mutedColor +
        '">' +
        (d.thermRate > 0 ? '$' + d.thermRate.toFixed(4) : '&mdash;') +
        '</td>';
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.thermCostSav) +
        ';font-weight:600">' +
        (d.thermRate > 0 || d.pinned ? costSign(d.thermCostSav) + '$' + fmtC(d.thermCostSav) : '&mdash;') +
        '</td>';
    }
    if (hasExpKW) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        mutedColor +
        '">' +
        (d.blExpKW > 0
          ? d.blExpKW.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
          : '&mdash;') +
        '</td>';
    }
    if (hasKwData) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '">' +
        (d.demKW > 0
          ? d.demKW.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
          : '&mdash;') +
        '</td>';
    }
    if (hasBilKW) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '">' +
        (d.bilKW > 0
          ? d.bilKW.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
          : '&mdash;') +
        '</td>';
    }
    if (hasKwCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        mutedColor +
        '">' +
        (d.moKwRate > 0 ? '$' + d.moKwRate.toFixed(4) : '&mdash;') +
        '</td>';
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.kwCostSav) +
        ';font-weight:600">' +
        (d.moKwRate > 0 ? costSign(d.kwCostSav) + '$' + fmtC(d.kwCostSav) : '&mdash;') +
        '</td>';
    }
    if (hasTotalCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.totalCostSav) +
        ';font-weight:700">' +
        costSign(d.totalCostSav) +
        '$' +
        fmtC(d.totalCostSav) +
        '</td>';
    }
    rowsHTML += '</tr>';
  });

  // Sum row
  var sumRow =
    '<tr style="border-top:2px solid ' +
    borderColor +
    ';background:' +
    bgColor +
    ';font-weight:700">' +
    '<td class="' +
    lblClass +
    '" style="text-align:right;font-weight:800;text-transform:uppercase;font-size:10px;letter-spacing:.5px">Total</td>' +
    '<td class="' +
    numClass +
    '" style="font-weight:700">' +
    sumNormDays +
    '</td>' +
    '<td class="' +
    numClass +
    '" style="color:' +
    mutedColor +
    ';font-weight:700">' +
    fmtN(sumExpUsage) +
    '</td>' +
    '<td class="' +
    numClass +
    '" style="font-weight:700">' +
    fmtN(sumRawUsage) +
    '</td>' +
    '<td class="' +
    numClass +
    '" style="color:' +
    savColor(sumUnitSav) +
    ';font-weight:700">' +
    savSign(sumUnitSav) +
    fmtN(Math.abs(sumUnitSav)) +
    '</td>' +
    '<td class="' +
    numClass +
    '" style="color:' +
    savColor(sumUnitSav) +
    ';font-weight:700">' +
    (sumExpUsage > 0 ? savSign(sumUnitSav) + Math.abs((sumUnitSav / sumExpUsage) * 100).toFixed(1) + '%' : '&mdash;') +
    '</td>';
  if (hasKwhCostSav) sumRow += '<td class="' + numClass + '"></td>';
  if (hasKwhCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumKwhSav) +
      ';font-weight:700">' +
      costSign(sumKwhSav) +
      '$' +
      fmtC(sumKwhSav) +
      '</td>';
  if (hasGasCostSav) sumRow += '<td class="' + numClass + '"></td>';
  if (hasGasCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumThermSav) +
      ';font-weight:700">' +
      costSign(sumThermSav) +
      '$' +
      fmtC(sumThermSav) +
      '</td>';
  if (hasExpKW)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      mutedColor +
      ';font-weight:700">' +
      (sumExpKW > 0
        ? sumExpKW.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : '&mdash;') +
      '</td>';
  if (hasKwData)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="font-weight:700">' +
      (sumActKW > 0
        ? sumActKW.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : '&mdash;') +
      '</td>';
  if (hasBilKW)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="font-weight:700">' +
      (sumBilKW > 0
        ? sumBilKW.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : '&mdash;') +
      '</td>';
  if (hasKwCostSav) sumRow += '<td class="' + numClass + '"></td>'; // $/kW rate
  if (hasKwCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumKwSav) +
      ';font-weight:700">' +
      costSign(sumKwSav) +
      '$' +
      fmtC(sumKwSav) +
      '</td>';
  if (hasTotalCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumTotalSav) +
      ';font-weight:800">' +
      costSign(sumTotalSav) +
      '$' +
      fmtC(sumTotalSav) +
      '</td>';
  sumRow += '</tr>';

  var wrapStyle =
    mode === 'tab'
      ? 'overflow-x:auto;border:1px solid ' + borderLine + ';border-radius:8px;max-height:320px;overflow-y:auto'
      : '';

  var html =
    (wrapStyle ? '<div id="' + wrapperId + '" style="' + wrapStyle + '">' : '') +
    '<table class="' +
    tblClass +
    '" style="' +
    fontSize +
    '">' +
    '<thead>' +
    hdr +
    '</thead>' +
    '<tbody>' +
    rowsHTML +
    sumRow +
    '</tbody>' +
    '</table>' +
    (wrapStyle ? '</div>' : '') +
    (mode === 'tab'
      ? '<p style="font-size:11px;color:var(--t3);margin:6px 0 0 4px;">* Baseline year data is excluded from savings calculations</p>'
      : '');

  // a67db8ce: months whose displayed savings is a false $0 (rate could not be resolved) —
  // exposed so callers that roll several meters into one building/project total (e.g.
  // renderBldgPerfPane, the Project Performance pane in app/utility-data.js) can show one
  // combined warning naming every affected month instead of each meter re-deriving it.
  var incompleteMonths = rowData
    .filter(function (d) {
      return _isFalseZero(d);
    })
    .map(function (d) {
      return { ym: d.ym, label: d.label, reason: d.rateReason };
    });

  return {
    html: html,
    rows: rowData,
    totals: { savings: sumTotalSav, kwhSav: sumKwhSav, kwSav: sumKwSav, thermSav: sumThermSav },
    incompleteMonths: incompleteMonths,
  };
}
