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
    // actUsage null = no bill usage for this month (a pinned month): saved/% show a dash, not 0.
    var sav = r.actUsage == null ? null : r.expUsage - r.actUsage;
    var parts = r.ym.split('-');
    return {
      ym: r.ym,
      label: monthNames[parseInt(parts[1]) - 1] + ' ' + parts[0],
      normDays: r.normDays,
      expUsage: r.expUsage,
      rawUsage: r.actUsage,
      sav: sav,
      savPc: sav == null ? null : r.expUsage > 0 ? (sav / r.expUsage) * 100 : null, // baseline 0: percent undefined, shown as a dash
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
      weatherMissing: !!r.weatherMissing,
    };
  });

  // Presented (printed) figures: opts.printed(monthYmOrTotal, column) returns the number the client saw
  // for that cell, or undefined. Only the report of a presented period passes it (app/report-printed.js).
  var pv = typeof opts.printed === 'function' ? opts.printed : null;
  var pvn = function (key, col, fb) {
    var v = pv ? pv(key, col) : undefined;
    return typeof v === 'number' && isFinite(v) ? v : fb;
  };
  if (pv) {
    rowData.forEach(function (d) {
      d.normDays = pvn(d.ym, 'days', d.normDays);
      d.expUsage = pvn(d.ym, 'baseline', d.expUsage);
      d.rawUsage = pvn(d.ym, 'actual', d.rawUsage);
      d.sav = pvn(d.ym, 'saved', d.sav);
      d.savPc = pvn(d.ym, 'pct', d.savPc);
      d.kwhRate = pvn(d.ym, 'per_kwh', d.kwhRate);
      d.kwhCostSav = pvn(d.ym, 'kwh_sav_dollars', d.kwhCostSav);
      d.thermRate = pvn(d.ym, 'per_unit', d.thermRate);
      d.thermCostSav = pvn(d.ym, 'cost_sav_dollars', d.thermCostSav);
      d.blExpKW = pvn(d.ym, 'bl_kw', d.blExpKW);
      d.demKW = pvn(d.ym, 'act_kw', d.demKW);
      d.bilKW = pvn(d.ym, 'bld_kw', d.bilKW);
      d.moKwRate = pvn(d.ym, 'per_kw', d.moKwRate);
      d.kwCostSav = pvn(d.ym, 'kw_sav_dollars', d.kwCostSav);
      d.totalCostSav = pvn(d.ym, 'total_dollars', d.totalCostSav);
    });
  }

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
  // Report (Matt, 2026-11-08): the kWh $ and kW $ cents of an electricity month add to the Total $ cents printed beside them.
  // The total is the exact savings; the two parts round down and the cents still owed go to the larger fractions.
  if (mode === 'report' && isElec && !pv) {
    dataRows.forEach(function (d) {
      var parts = [(d.kwhCostSav || 0) * 100, (d.kwCostSav || 0) * 100];
      var fl = parts.map(function (v) {
        return Math.floor(v);
      });
      var owed = Math.round((d.savings || 0) * 100) - fl[0] - fl[1];
      if (Math.abs(owed) > 2) return;
      var order = [0, 1].sort(function (a, c) {
        return parts[c] - fl[c] - (parts[a] - fl[a]) || a - c;
      });
      for (var k = 0; k < Math.abs(owed); k++) fl[order[owed > 0 ? k : 1 - k]] += owed > 0 ? 1 : -1;
      d.kwhCostSav = fl[0] / 100;
      d.kwCostSav = fl[1] / 100;
    });
  }

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
    // Report: one column set for every electricity meter. Actual kW is the billed kW (the figure the savings use), so the
    // metered-demand column is not printed and no meter has an extra column.
    if (mode === 'report') {
      hasBilKW = rowData.some(function (d) {
        return d.bilKW > 0 || d.demKW > 0;
      });
      hasKwData = false;
    }
    // Hide Billed kW if it always equals Demand kW
    if (mode !== 'report' && hasBilKW && hasKwData) {
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
  var mutedColor = mode === 'tab' ? 'var(--text2)' : 'var(--rpt-page-text)'; // report: black text in every cell (v252)
  var violetColor = mode === 'tab' ? 'var(--violet)' : '#7d3c98';
  var borderColor = mode === 'tab' ? 'var(--border2)' : '#bbb';
  var bgColor = mode === 'tab' ? 'var(--s1)' : '#f5f5f5';
  var borderLine = mode === 'tab' ? 'var(--border)' : '#ccc';

  var savColor = function (v, d) {
    return savingsSignColor(v, d, emColor, dangerColor, mode === 'tab' ? 'var(--text)' : 'var(--rpt-page-text)');
  };
  var costSign = function (v, d) {
    return savingsSign(v, d, true);
  };
  var savSign = function (v, d) {
    return savingsSign(v, d);
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
  // Report: a dollar column total is the sum of the cent values printed above it (the cells foot to the total).
  var rpt = mode === 'report';
  var _c2 = function (v) {
    return rpt ? Math.round((v || 0) * 100) / 100 : v;
  };
  dataRows.forEach(function (d) {
    sumTotalSav += _c2(d.savings);
    sumKwhSav += _c2(d.kwhCostSav);
    sumKwSav += _c2(d.kwCostSav);
    sumThermSav += _c2(d.thermCostSav);
    sumExpUsage += d.rawUsage == null ? 0 : d.expUsage || 0; // no-usage month: baseline shows a dash and is not summed
    sumRawUsage += d.rawUsage || 0;
    sumUnitSav += d.sav || 0;
    sumExpKW += d.blExpKW || 0;
    sumActKW += d.demKW || 0;
    sumBilKW += d.bilKW || 0;
    sumNormDays += d.normDays || 0;
  });
  // The printed total row wins over the sum of the rows (a printed document can differ by a rounding step).
  sumNormDays = pvn('Total', 'days', sumNormDays);
  sumExpUsage = pvn('Total', 'baseline', sumExpUsage);
  sumRawUsage = pvn('Total', 'actual', sumRawUsage);
  sumUnitSav = pvn('Total', 'saved', sumUnitSav);
  sumKwhSav = pvn('Total', 'kwh_sav_dollars', sumKwhSav);
  sumThermSav = pvn('Total', 'cost_sav_dollars', sumThermSav);
  sumExpKW = pvn('Total', 'bl_kw', sumExpKW);
  sumActKW = pvn('Total', 'act_kw', sumActKW);
  sumBilKW = pvn('Total', 'bld_kw', sumBilKW);
  sumKwSav = pvn('Total', 'kw_sav_dollars', sumKwSav);
  sumTotalSav = pvn('Total', 'total_dollars', sumTotalSav);
  var sumPct = pvn('Total', 'pct', sumExpUsage > 0 ? (sumUnitSav / sumExpUsage) * 100 : null);

  // Table classes
  var tblClass = mode === 'tab' ? 'ma-tbl' : 'rpt-table rpt-table-compact';
  var numClass = mode === 'tab' ? 'mono num' : 'rpt-n';
  var lblClass = mode === 'tab' ? 'lbl' : '';
  var fontSize = mode === 'report' ? 'font-size:11px;width:100%;table-layout:fixed;' : '';
  var kwDp = rpt ? 1 : 4; // report: kW with one decimal

  // Abbreviated headers for report mode to prevent column overflow. This table can run to 16
  // narrow columns at 6.5px print font (see fontSize above) -- the BL/Act/Sav $ abbreviations
  // are a deliberate, documented width tradeoff, out of scope for the 2026-09-24 header-overflow
  // fix (task 5b) to unwind without a full column-width re-tuning pass. The one piece that IS
  // in scope: 'kWh' must print in its real case even under this table's all-caps <th> styling
  // (same _rptUnit() fix as report-engine.js's own tables) -- mixed-case is never wider than the
  // all-caps rendering it replaces, so this cannot introduce new overflow.
  var _kwhHdr = typeof _rptUnit === 'function' ? _rptUnit('kWh') : 'kWh';
  // Report headers are whole words; a unit stays with its label on one line (no-break spaces).
  var NB = '&nbsp;';
  var BR = '<br>';
  var H_MONTH = 'Month';
  var H_NDAYS = rpt ? 'Days' : 'Normalized Days';
  // Propane is deliveries, not use: the report names the column "delivered gal" (v252).
  var H_UNIT = unit === 'kWh' ? _kwhHdr : unit;
  var H_BL_USAGE = rpt ? 'Baseline' + BR + (isPropane ? 'delivered' + BR : '') + H_UNIT : 'Baseline ' + unit;
  var H_ACT_USAGE = rpt ? 'Actual' + BR + (isPropane ? 'delivered' + BR : '') + H_UNIT : 'Actual ' + unit;
  var H_SAVED = rpt ? (unit === 'kWh' ? _kwhHdr : unit) + BR + 'saved' : (unit === 'kWh' ? _kwhHdr : unit) + ' Saved';
  var H_PCT = rpt ? 'Saved' + BR + '%' : '%';
  var H_KWH_RATE = rpt ? '$/' + _kwhHdr : 'Actual $/kWh';
  var H_KWH_SAV = rpt ? _kwhHdr + NB + '$' + BR + 'saved' : 'kWh Savings ($)';
  var H_GAS_RATE = rpt ? '$/' + costUnitLabel : 'Actual $/' + costUnitLabel;
  var H_GAS_SAV = rpt ? costUnitLabel + NB + '$' + BR + 'saved' : costUnitLabel + ' Savings ($)';
  // Report: the baseline billed kW is the model of billed kW at the weather of the year reported (the year of the filter months).
  var wxYear = rpt && filterYMs && filterYMs.length ? String(filterYMs[0]).slice(0, 4) : '';
  var H_BL_KW = rpt ? 'Baseline' + BR + 'billed' + NB + 'kW' + (wxYear ? BR + '(' + wxYear + BR + 'weather)' : '') : 'Baseline kW';
  var H_ACT_KW = rpt ? 'Actual' + BR + 'kW' : 'Actual kW';
  var H_BIL_KW = rpt ? 'Actual' + BR + 'billed' + NB + 'kW' : 'Billed kW';
  var H_KW_RATE = rpt ? '$/kW' : 'Actual $/kW';
  var H_KW_SAV = rpt ? 'kW' + NB + '$' + BR + 'saved' : 'kW Savings ($)';
  var H_TOTAL = rpt ? 'Total' + NB + '$' + BR + 'saved' : 'Total Savings ($)';

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
    '">' +
    H_PCT +
    '</th>';
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
        (d.weatherMissing
          ? '⚠ Weather not yet available for this month — left out of the savings until it is'
          : '⚠ Rate unavailable this month (' + d.rateReason + ') — savings excluded from the total, not shown as $0.00') +
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
      (d.normDays == null ? '&mdash;' : d.normDays) +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      mutedColor +
      '">' +
      (d.rawUsage == null ? '&mdash;' : fmtN(d.expUsage)) +
      '</td>' +
      '<td class="' +
      numClass +
      '">' +
      (d.rawUsage == null ? '&mdash;' : fmtN(d.rawUsage)) +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(d.sav, 0) +
      '">' +
      (d.sav == null ? '&mdash;' : savSign(d.sav, 0) + fmtN(Math.abs(d.sav))) +
      '</td>' +
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(d.savPc, 1) +
      '">' +
      (d.savPc == null ? '&mdash;' : savSign(d.savPc, 1) + Math.abs(d.savPc).toFixed(1) + '%') +
      '</td>';
    if (hasKwhCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        mutedColor +
        '">' +
        (d.kwhRate > 0 ? '$' + d.kwhRate.toFixed(rpt ? 4 : 5) : '&mdash;') +
        '</td>';
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.kwhCostSav, 2) +
        ';font-weight:600">' +
        (d.kwhRate > 0 ? costSign(d.kwhCostSav, 2) + '$' + fmtC(d.kwhCostSav) : '&mdash;') +
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
        savColor(d.thermCostSav, 2) +
        ';font-weight:600">' +
        (d.thermRate > 0 || d.pinned || (mode === 'report' && d.rawUsage != null) ? costSign(d.thermCostSav, 2) + '$' + fmtC(d.thermCostSav) : '&mdash;') +
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
          ? d.blExpKW.toLocaleString('en-US', { minimumFractionDigits: kwDp, maximumFractionDigits: kwDp })
          : '&mdash;') +
        '</td>';
    }
    if (hasKwData) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '">' +
        (d.demKW > 0
          ? d.demKW.toLocaleString('en-US', { minimumFractionDigits: kwDp, maximumFractionDigits: kwDp })
          : '&mdash;') +
        '</td>';
    }
    if (hasBilKW) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '">' +
        ((rpt && !(d.bilKW > 0) ? d.demKW : d.bilKW) > 0
          ? (rpt && !(d.bilKW > 0) ? d.demKW : d.bilKW).toLocaleString('en-US', { minimumFractionDigits: kwDp, maximumFractionDigits: kwDp })
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
        savColor(d.kwCostSav, 2) +
        ';font-weight:600">' +
        (d.moKwRate > 0 ? costSign(d.kwCostSav, 2) + '$' + fmtC(d.kwCostSav) : '&mdash;') +
        '</td>';
    }
    if (hasTotalCostSav) {
      rowsHTML +=
        '<td class="' +
        numClass +
        '" style="color:' +
        savColor(d.totalCostSav, 2) +
        ';font-weight:700">' +
        costSign(d.totalCostSav, 2) +
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
    '" style="' +
    (rpt ? 'text-align:left;font-weight:700;text-transform:none' : 'text-align:right;font-weight:800;text-transform:uppercase;font-size:10px;letter-spacing:.5px') +
    '">Total</td>' +
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
    savColor(sumUnitSav, 0) +
    ';font-weight:700">' +
    savSign(sumUnitSav, 0) +
    fmtN(Math.abs(sumUnitSav)) +
    '</td>' +
    '<td class="' +
    numClass +
    '" style="color:' +
    savColor(sumPct, 1) +
    ';font-weight:700">' +
    (sumPct !== null ? savSign(sumPct, 1) + Math.abs(sumPct).toFixed(1) + '%' : '&mdash;') +
    '</td>';
  if (hasKwhCostSav) sumRow += '<td class="' + numClass + '"></td>';
  if (hasKwhCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumKwhSav, 2) +
      ';font-weight:700">' +
      costSign(sumKwhSav, 2) +
      '$' +
      fmtC(sumKwhSav) +
      '</td>';
  if (hasGasCostSav) sumRow += '<td class="' + numClass + '"></td>';
  if (hasGasCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumThermSav, 2) +
      ';font-weight:700">' +
      costSign(sumThermSav, 2) +
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
      savColor(sumKwSav, 2) +
      ';font-weight:700">' +
      costSign(sumKwSav, 2) +
      '$' +
      fmtC(sumKwSav) +
      '</td>';
  if (hasTotalCostSav)
    sumRow +=
      '<td class="' +
      numClass +
      '" style="color:' +
      savColor(sumTotalSav, 2) +
      ';font-weight:700">' +
      costSign(sumTotalSav, 2) +
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
