// lib/perf-table.js — Shared Meter Performance table rendering (canonical source)
// Depends on: normalization.js (getNormRows, buildMoMap, normMonth), rates.js (getStoredRate),
//             savings.js (getMeterSavings), and getWeatherForBuilding() (in energy-department.html)
//
// Used by: renderPerfPane (Meter Performance tab) and report generation.
// This is THE one source of truth for the Meter Performance table.

function buildMeterPerfTableHTML(m, bills, incl, opts) {
  opts = opts || {};
  var mode = opts.mode || 'tab'; // 'tab' or 'report'
  var filterYMs = opts.filterYMs || null; // null = all post-baseline, or array of YYYY-MM

  var bl = m.baseline;
  if (!bl || !bl.months || bl.months.length < 3) return { html: '', rows: [] };

  var isElec = m.commodity === 'Electric';
  var isPropane = m.commodity === 'Propane';
  var isGas = m.commodity === 'Gas';
  var unit = isElec ? 'kWh' : isPropane ? 'Gal' : isGas ? 'Therms' : 'Units';
  var costUnitLabel = isPropane ? 'Gallon' : isGas ? 'Therm' : '';

  var weatherByYm =
    opts.weatherByYm ||
    (typeof getWeatherForBuilding === 'function' ? getWeatherForBuilding(opts.projId, opts.bldgId).byYm || {} : {});
  var allRows = bills.length ? getNormRows(m, bills, incl, weatherByYm) : [];
  var blRows = allRows.filter(function (r) {
    return bl.months.includes(r.ym);
  });
  var blEnd = bl.months.slice().sort().pop();
  var postRows = allRows.filter(function (r) {
    return r.ym > blEnd && !r.partial;
  });
  // Bug 1 fix: Water/Sewer bills have irregular cycles that flag all rows as partial.
  // If the partial filter leaves postRows empty, fall back to including partial rows.
  if (!postRows.length) {
    postRows = allRows.filter(function (r) {
      return r.ym > blEnd;
    });
  }
  if (filterYMs) {
    postRows = postRows.filter(function (r) {
      return filterYMs.includes(r.ym);
    });
  }
  if (!postRows.length) return { html: '', rows: [] };

  // Baseline maps
  var moMapResult = buildMoMap(m, blRows, bills, incl);
  var eMo = moMapResult.elecByMo || {};
  var gMo = moMapResult.gasByMo || {};
  var pMo = moMapResult.propaneByMo || {};
  var wMo = moMapResult.waterByMo || {};
  // Bug 2 fix: water/sewer commodities fell through to {}, losing all baseline calendar-month data.
  var _moMap = isElec ? eMo : isGas ? gMo : isPropane ? pMo : wMo;

  var blByCalMo = {};
  var blDemKWByCalMo = {};
  Object.keys(_moMap).forEach(function (mo) {
    var v = _moMap[mo];
    blByCalMo[mo] = isElec ? v.kwh : isGas ? v.therms : isPropane ? v.gallons : v.kgal;
    if (isElec) blDemKWByCalMo[mo] = v.billedKW || v.demandKW || 0;
  });
  var hasBlCalMap = Object.keys(blByCalMo).length > 0;
  var hasRegrP = allRows.some(function (r) {
    return r.regrBaseline != null;
  });
  var blAvgMo = blRows.length
    ? blRows.reduce(function (s, r) {
        return s + r.usage;
      }, 0) / blRows.length
    : 0;

  // kW weather normalization via CDD regression (electric only)
  var _kwReg = false;
  var _kwNormByYm = {};
  if (isElec && hasRegrP) {
    var pts = blRows
      .map(function (r) {
        var bfr = bills.filter(function (b) {
          return normMonth(b.start, b.end, incl, bills) === r.ym;
        });
        var kw = bfr.length
          ? bfr.reduce(function (s, b) {
              return s + (parseFloat(b.demandKW) || 0);
            }, 0) / bfr.length
          : 0;
        return { x: r.cdd != null ? r.cdd : 0, y: kw };
      })
      .filter(function (p) {
        return p.y > 0;
      });
    if (pts.length >= 3) {
      var n = pts.length;
      var mx =
        pts.reduce(function (s, p) {
          return s + p.x;
        }, 0) / n;
      var my =
        pts.reduce(function (s, p) {
          return s + p.y;
        }, 0) / n;
      var ssxx = pts.reduce(function (s, p) {
        return s + (p.x - mx) * (p.x - mx);
      }, 0);
      var ssxy = pts.reduce(function (s, p) {
        return s + (p.x - mx) * (p.y - my);
      }, 0);
      if (ssxx > 0) {
        _kwReg = true;
        var slope = ssxy / ssxx;
        var intercept = my - slope * mx;
        allRows.forEach(function (r) {
          var cdd = r.cdd != null ? r.cdd : 0;
          _kwNormByYm[r.ym] = Math.max(0, intercept + slope * cdd);
        });
      }
    }
  }

  // Per-bill demand/cost data by year-month (electric only)
  var perfDemByYm = {};
  if (isElec) {
    bills.forEach(function (b) {
      var ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      if (!perfDemByYm[ym])
        perfDemByYm[ym] = { demKW: 0, bilKW: 0, kwCost: 0, facKWCost: 0, kwhRate: 0, energyCostAmt: 0, ct: 0 };
      var d = perfDemByYm[ym];
      var dk = parseFloat(b.demandKW) || 0;
      var bk = parseFloat(b.billedKW || b.demandKW) || 0;
      if (dk > d.demKW) d.demKW = dk;
      if (bk > d.bilKW) d.bilKW = bk;
      d.kwCost += parseFloat(b.kwCost || 0);
      d.facKWCost += parseFloat(b.facKWCost || 0);
      d.energyCostAmt += parseFloat(b.kwhCost || 0);
      var rate = parseFloat(b.totalKwhRate) || (typeof getStoredRate === 'function' ? getStoredRate(b, 'kwh') : 0);
      d.kwhRate = (d.kwhRate * d.ct + rate) / (d.ct + 1);
      d.ct++;
    });
  }

  // Gas/propane cost data by year-month
  var gasCostByYm = {};
  if (isGas || isPropane) {
    bills.forEach(function (b) {
      var ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      if (!gasCostByYm[ym]) gasCostByYm[ym] = { thermRate: 0, thermCostAmt: 0, ct: 0 };
      var g = gasCostByYm[ym];
      var rate = isGas
        ? parseFloat(b.totalGasRate) || (typeof getStoredRate === 'function' ? getStoredRate(b, 'gas') : 0)
        : parseFloat(b.totalPropaneRate) || (typeof getStoredRate === 'function' ? getStoredRate(b, 'propane') : 0);
      var cost = isGas ? parseFloat(b.gasCharge || b.thermCost || b.cost || 0) : parseFloat(b.totalCost || b.cost || 0);
      g.thermRate = (g.thermRate * g.ct + rate) / (g.ct + 1);
      g.thermCostAmt += cost;
      g.ct++;
    });
  }

  // Raw usage by year-month (from bills, not normalized)
  var rawUsageByYm = {};
  if (isElec) {
    bills.forEach(function (b) {
      var ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + (parseFloat(b.kwh) || parseFloat(b.usage) || 0);
    });
  } else if (isPropane) {
    allRows.forEach(function (r) {
      rawUsageByYm[r.ym] = r.usage;
    });
  } else {
    // Bug 3 fix: water/sewer bills store usage in b.waterUsage or b.sewerUsage, not b.therms.
    bills.forEach(function (b) {
      var ym = normMonth(b.start, b.end, incl, bills);
      if (!ym) return;
      var actUsage = isGas
        ? parseFloat(b.therms || b.usage || 0)
        : parseFloat(b.waterUsage || b.sewerUsage || b.usage || 0);
      rawUsageByYm[ym] = (rawUsageByYm[ym] || 0) + actUsage;
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
    postRows.forEach(function (r) {
      var dem = perfDemByYm[r.ym];
      if (dem && dem.demKW > 0) hasKwData = true;
      if (dem && dem.bilKW > 0) hasBilKW = true;
    });
    blRows.forEach(function (r) {
      var calMo = parseInt(r.ym.split('-')[1]) - 1;
      if (blDemKWByCalMo[calMo] > 0 || (_kwReg && _kwNormByYm[r.ym] > 0)) hasExpKW = true;
    });
    hasKwCostSav = hasExpKW || hasKwData;
    // Hide Billed kW if it always equals Demand kW
    if (hasBilKW && hasKwData) {
      var allSame = true;
      Object.keys(perfDemByYm).forEach(function (ym) {
        var d = perfDemByYm[ym];
        if (Math.abs(d.demKW - d.bilKW) > 0.01) allSame = false;
      });
      if (allSame) hasBilKW = false;
    }
  } else {
    hasGasCostSav = true;
    hasTotalCostSav = false; // gas/propane: therm savings IS total savings
  }

  // Colors
  var emColor = mode === 'tab' ? 'var(--em)' : '#1e8449';
  var dangerColor = mode === 'tab' ? 'var(--danger)' : '#c0392b';
  var mutedColor = mode === 'tab' ? 'var(--text2)' : '#666';
  var violetColor = mode === 'tab' ? 'var(--violet)' : '#7d3c98';
  var borderColor = mode === 'tab' ? 'var(--border2)' : '#bbb';
  var bgColor = mode === 'tab' ? 'var(--s2)' : '#f5f5f5';
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

  // Build row data
  var rowData = [];
  var sumTotalSav = 0,
    sumKwhSav = 0,
    sumKwSav = 0,
    sumThermSav = 0;
  var sumExpUsage = 0;
  var sumRawUsage = 0;
  var sumUnitSav = 0;

  postRows.forEach(function (r) {
    var calMo = parseInt(r.ym.split('-')[1]) - 1;
    var expMo =
      hasBlCalMap && blByCalMo[calMo] != null
        ? blByCalMo[calMo]
        : hasRegrP && r.regrBaseline != null
          ? r.regrBaseline
          : blAvgMo;
    var rawUsage = rawUsageByYm[r.ym] != null ? rawUsageByYm[r.ym] : r.usage;
    var sav = expMo - rawUsage;
    var savPc = expMo > 0 ? (sav / expMo) * 100 : 0;
    var isRegr = hasBlCalMap && blByCalMo[calMo] != null ? false : hasRegrP && r.regrBaseline != null;

    var dem = isElec ? perfDemByYm[r.ym] || {} : null;
    var demKW = dem ? dem.demKW || 0 : 0;
    var bilKW = dem ? dem.bilKW || 0 : 0;
    var kwCostRow = dem ? (dem.kwCost || 0) + (dem.facKWCost || 0) : 0;
    var kwhRate = dem ? dem.kwhRate || 0 : 0;

    var kwhSaved = sav;
    var kwhCostSav = hasKwhCostSav && kwhRate > 0 ? kwhSaved * kwhRate : 0;

    var blExpKW = _kwReg && _kwNormByYm[r.ym] != null ? _kwNormByYm[r.ym] : blDemKWByCalMo[calMo] || 0;
    var moKwRate = hasKwCostSav && demKW > 0 ? kwCostRow / demKW : 0;
    var kwSaved = blExpKW - bilKW;
    var kwCostSav = hasKwCostSav && moKwRate > 0 ? kwSaved * moKwRate : 0;
    var calcTotalCostSav = kwhCostSav + kwCostSav;

    var gasMo = gasCostByYm[r.ym] || null;
    var thermRate = gasMo ? gasMo.thermRate || 0 : 0;
    var thermSaved = expMo - rawUsage;
    var calcThermCostSav = hasGasCostSav && thermRate > 0 ? thermSaved * thermRate : 0;

    var _costOvr = bl.costSavOverrides ? bl.costSavOverrides[r.ym] : undefined;
    var totalCostSav = _costOvr != null && isElec ? _costOvr : calcTotalCostSav;
    var thermCostSav = _costOvr != null && !isElec ? _costOvr : calcThermCostSav;
    var rowSavings = isElec ? totalCostSav : thermCostSav;

    sumTotalSav += rowSavings;
    sumKwhSav += kwhCostSav;
    sumKwSav += kwCostSav;
    sumThermSav += thermCostSav;
    sumExpUsage += expMo || 0;
    sumRawUsage += rawUsage || 0;
    sumUnitSav += sav || 0;

    // Month label
    var parts = r.ym.split('-');
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var label = monthNames[parseInt(parts[1]) - 1] + ' ' + parts[0];

    rowData.push({
      ym: r.ym,
      label: label,
      normDays: r.normDays,
      isRegr: isRegr,
      expUsage: expMo,
      rawUsage: rawUsage,
      sav: sav,
      savPc: savPc,
      kwhRate: kwhRate,
      kwhCostSav: kwhCostSav,
      thermRate: thermRate,
      thermCostSav: thermCostSav,
      blExpKW: blExpKW,
      demKW: demKW,
      bilKW: bilKW,
      moKwRate: moKwRate,
      kwCostSav: kwCostSav,
      totalCostSav: totalCostSav,
      savings: rowSavings,
    });
  });

  // Table classes
  var tblClass = mode === 'tab' ? 'ma-tbl' : 'rpt-table rpt-table-compact';
  var numClass = mode === 'tab' ? 'mono num' : 'rpt-n';
  var lblClass = mode === 'tab' ? 'lbl' : '';
  var fontSize = mode === 'report' ? 'font-size:6.5px;' : '';
  var rpt = mode === 'report';

  // Abbreviated headers for report mode to prevent column overflow
  var H_MONTH = 'Month';
  var H_NDAYS = rpt ? 'Days' : 'Norm Days';
  var H_BL_USAGE = rpt ? 'BL ' + unit : 'Baseline ' + unit;
  var H_ACT_USAGE = rpt ? 'Act ' + unit : 'Actual ' + unit;
  var H_SAVED = unit + ' Saved';
  var H_KWH_RATE = rpt ? '$/kWh' : 'Actual $/kWh';
  var H_KWH_SAV = rpt ? 'kWh Sav $' : 'kWh Savings ($)';
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

  // Build rows
  var rowsHTML = '';
  rowData.forEach(function (d) {
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
        (d.thermRate > 0 || d.savings !== d.thermCostSav
          ? costSign(d.thermCostSav) + '$' + fmtC(d.thermCostSav)
          : '&mdash;') +
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
        (d.moKwRate > 0 ? '$' + d.moKwRate.toFixed(2) : '&mdash;') +
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
    '" colspan="2" style="text-align:right;font-weight:800;text-transform:uppercase;font-size:10px;letter-spacing:.5px">Total</td>' +
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
  if (hasExpKW) sumRow += '<td class="' + numClass + '"></td>';
  if (hasKwData) sumRow += '<td class="' + numClass + '"></td>';
  if (hasBilKW) sumRow += '<td class="' + numClass + '"></td>';
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
    (wrapStyle ? '<div style="' + wrapStyle + '">' : '') +
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
    (wrapStyle ? '</div>' : '');

  return {
    html: html,
    rows: rowData,
    totals: { savings: sumTotalSav, kwhSav: sumKwhSav, kwSav: sumKwSav, thermSav: sumThermSav },
  };
}
