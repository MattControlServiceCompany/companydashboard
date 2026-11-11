/* ══════════════════════════════════════════════════════
         ENERGY GRAPHICS — per project
      ══════════════════════════════════════════════════════ */
function egfxTogglePollCalc(projId) {
  const body = document.getElementById(`egfx-pollcalc-body-${projId}`);
  const chev = document.getElementById(`egfx-pollcalc-chev-${projId}`);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.textContent = open ? '▶' : '▼';
}

function egfxTogglePerfVerify(projId) {
  var body = document.getElementById('egfx-perfverify-body-' + projId);
  var chev = document.getElementById('egfx-perfverify-chev-' + projId);
  if (!body) return;
  var open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.textContent = open ? '▶' : '▼';
  if (!open) egfxRenderPerfVerify(projId);
}

// egfxRedrawTrendChart — draws/redraws the Multi-Year Usage Trend chart (Talisen FAC workbook
// annual data, b.annualBenchmarks) inside the Energy Graphics tab. Re-derives everything from
// getUDBldgs() fresh each call rather than reading captured egfxRefresh() closure state, so it
// works both on initial render and as the onchange handler for the metric/mode selects. No-op
// if the canvas isn't in the DOM (card only renders when at least one building has data).
function egfxRedrawTrendChart(projId) {
  const canvas = document.getElementById('egfx-trend-' + projId);
  if (!canvas) return;
  const bldgs = getUDBldgs(projId).filter((b) => Array.isArray(b.annualBenchmarks) && b.annualBenchmarks.length > 0);
  if (bldgs.length === 0) return;

  let minYr = Infinity,
    maxYr = -Infinity;
  bldgs.forEach((b) =>
    b.annualBenchmarks.forEach((y) => {
      if (y.year < minYr) minYr = y.year;
      if (y.year > maxYr) maxYr = y.year;
    }),
  );
  const years = [];
  for (let y = minYr; y <= maxYr; y++) years.push(y);

  const metricSel = document.getElementById('egfx-trend-metric-' + projId);
  const modeSel = document.getElementById('egfx-trend-mode-' + projId);
  const metric = metricSel ? metricSel.value : 'kwh';
  const mode = modeSel ? modeSel.value : 'perBldg';

  const METRIC_MAP = {
    kwh: { unit: 'kWh', get: (y) => (y.elecKwh != null ? y.elecKwh : null) },
    // Gas rows in the source workbook are CCF; convert with the one unit table (UNIT_TO_BASE).
    therms: { unit: 'therms', get: (y) => (y.gasCcf != null ? convertUnit(y.gasCcf, 'CCF', 'Therms', 'Gas') : null) },
    cost: {
      unit: '$',
      get: (y) => (y.elecCost != null || y.gasCost != null ? (y.elecCost || 0) + (y.gasCost || 0) : null),
    },
    eui: { unit: 'kBtu/ft²/yr', get: (y) => (y.euiSite != null ? y.euiSite : null) },
  };
  const m = METRIC_MAP[metric] || METRIC_MAP.kwh;

  let series;
  if (mode === 'total') {
    const totals = years.map((y) => {
      // EUI is an intensity (kBtu/ft²/yr), not additive across buildings — summing each
      // building's EUI would overstate the portfolio value. Portfolio EUI = total kBtu
      // (Site EUI × sqft, summed) / total sqft, for buildings with data that year.
      if (metric === 'eui') {
        let kbtu = 0,
          sqft = 0;
        bldgs.forEach((b) => {
          const yr = b.annualBenchmarks.find((r) => r.year === y);
          if (yr && yr.euiSite != null && yr.sqft) {
            kbtu += yr.euiSite * yr.sqft;
            sqft += yr.sqft;
          }
        });
        return sqft > 0 ? kbtu / sqft : null;
      }
      let sum = 0,
        any = false;
      bldgs.forEach((b) => {
        const yr = b.annualBenchmarks.find((r) => r.year === y);
        if (yr) {
          const v = m.get(yr);
          if (v != null) {
            sum += v;
            any = true;
          }
        }
      });
      return any ? sum : null;
    });
    series = [{ label: 'Portfolio Total', data: totals, color: '#3b82f6' }];
  } else {
    series = bldgs.map((b) => ({
      label: b.name,
      data: years.map((y) => {
        const yr = b.annualBenchmarks.find((r) => r.year === y);
        return yr ? m.get(yr) : null;
      }),
    }));
  }

  SharedCharts.renderAnnualTrendChart('egfx-trend-' + projId, { years, series, unit: m.unit }, { interactive: true });
}

function _pvToggleBldg(projId, bldgId) {
  var body = document.getElementById('pv-bldg-body-' + projId + '-' + bldgId);
  var chev = document.getElementById('pv-bldg-chev-' + projId + '-' + bldgId);
  if (!body) return;
  var open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.textContent = open ? '▼' : '▶';
}

function _pvRenderMeterPerf(m, bills, incl, projId, bldgId) {
  var result = buildMeterPerfTableHTML(m, bills, incl, {
    mode: 'tab',
    wrapperId: 'perf-table-wrap-pv',
    projId: projId,
    bldgId: bldgId,
  });
  if (!result.html) return '';
  return (
    '<div style="margin-bottom:12px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:4px">' +
    _escHtml(m.name || 'Meter') +
    ' (' +
    m.commodity +
    ') — Meter Performance</div>' +
    result.html +
    '</div>'
  );
}

function _pvRenderBldgPerf(b, projId) {
  if (!b) return '';
  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var baselineByCalMo = {};
  (b.meters || []).forEach(function (m) {
    var bl = m.baseline;
    if (!bl || !(bl.months || []).length) return;
    var bills = (m.bills || []).slice().sort(function (a, c) {
      return _parseISO(a.start) - _parseISO(c.start);
    });
    var incl = m.inclusive !== false;
    var weatherByYm =
      typeof getWeatherForBuilding === 'function' ? getWeatherForBuilding(projId, b.id).byYm || null : null;
    var allRows = bills.length ? getNormRows(m, bills, incl, weatherByYm) : [];
    allRows
      .filter(function (r) {
        return bl.months.includes(r.ym);
      })
      .forEach(function (r) {
        var mo = parseInt(r.ym.split('-')[1]) - 1;
        baselineByCalMo[mo] = (baselineByCalMo[mo] || 0) + r.cost;
      });
  });
  var moBase = [];
  for (var i = 0; i < 12; i++) moBase.push(baselineByCalMo[i] || 0);
  var annBase = moBase.reduce(function (s, v) {
    return s + v;
  }, 0);
  if (annBase === 0) return '';
  var actualSavByCalMo = {};
  var actualSavByYM = {};
  (b.meters || []).forEach(function (m) {
    if (isBaselineExcluded(projId, m.id)) return;
    if (!(m.baseline && m.baseline.months && m.baseline.months.length >= 3)) return;
    var mbills = (m.bills || []).slice().sort(function (a, c) {
      return _parseISO(a.start) - _parseISO(c.start);
    });
    var mincl = m.inclusive !== false;
    var mSavResult = getMeterSavings(m, mbills, mincl, projId, b.id);
    var mSav = mSavResult.byCalMo;
    Object.keys(mSav).forEach(function (mo) {
      actualSavByCalMo[mo] = (actualSavByCalMo[mo] || 0) + mSav[mo];
    });
    Object.keys(mSavResult.byYM).forEach(function (ym) {
      actualSavByYM[ym] = (actualSavByYM[ym] || 0) + mSavResult.byYM[ym];
    });
  });
  var hasActual = Object.keys(actualSavByCalMo).length > 0;
  var msrSav = getBldgMeasureSavingsByMo(projId, b.id);
  var savPct = getBspCfg(b).savingsPct / 100; // the ONE reader (utility-data.js getBspCfg); a real 0 stays 0
  // 2026-09-15 (SA-gate fix): the % fallback below never checked the project's `sa`
  // (Service Agreement #). No contract means no projected savings.
  var _hasContract = projHasContract(projId);
  var $f = function (v) {
    return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var savColor = function (v, d) {
    return savingsSignColor(v, d, 'var(--em)', 'var(--danger)', 'var(--text)');
  };
  var thS =
    'padding:6px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);background:var(--s1);border:1px solid var(--border2);white-space:nowrap';
  var tdS = function (c) {
    return (
      'padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:' +
      (c || 'var(--text)') +
      ';border:1px solid var(--border);white-space:nowrap'
    );
  };
  var annAct = 0;
  // Months with no weather yet: no savings figure (weatherWaitingMonths, computations/savings.js).
  var waitYms = hasActual ? weatherWaitingMonths(projId, Object.keys(actualSavByYM).sort()) : [];
  var waitMo = {};
  waitYms.forEach(function (y) {
    waitMo[Number(y.slice(5, 7)) - 1] = true;
  });
  var waitCell = '<td colspan="2" style="' + tdS('var(--text2)') + '">Waiting for weather data</td>';
  var rows = MN.map(function (mn, mo) {
    var base = moBase[mo];
    var projSav = msrSav ? msrSav[mo] || 0 : _hasContract ? base * savPct : 0;
    var act = actualSavByCalMo[mo] != null && !waitMo[mo] ? actualSavByCalMo[mo] : null;
    if (act != null) annAct += act;
    var pct = act != null && base > 0 ? (act / base) * 100 : null;
    return (
      '<tr>' +
      '<td style="padding:6px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--s3)">' +
      mn +
      '</td>' +
      '<td style="' +
      tdS() +
      '">' +
      $f(base) +
      '</td>' +
      '<td style="' +
      tdS() +
      '">' +
      $f(projSav) +
      '</td>' +
      (waitMo[mo]
        ? waitCell
        : '<td style="' +
          tdS(act != null ? savColor(act, 2) : 'var(--text3)') +
          '">' +
          (act != null ? savingsSign(act, 2, true) + $f(act) : '—') +
          '</td>' +
          '<td style="' +
          tdS(pct != null ? savColor(pct, 1) : 'var(--text3)') +
          '">' +
          (pct != null ? savingsSign(pct, 1, true) + Math.abs(pct).toFixed(1) + '%' : '—') +
          '</td>') +
      '</tr>'
    );
  }).join('');
  // Annual total: a period presented to the client uses the presented figure (computations/savings.js).
  if (hasActual) {
    var _bMap = {};
    _bMap[b.id] = actualSavByYM;
    annAct = billableSavingsWithPresented(projId, Object.keys(actualSavByYM).sort(), _bMap).byBldg[b.id];
  }
  var annPct = annBase > 0 && hasActual ? (annAct / annBase) * 100 : null;
  return (
    '<div style="margin-top:8px;margin-bottom:4px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:4px">' +
    _escHtml(b.name) +
    ' — Building Performance</div>' +
    '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">' +
    '<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr style="background:var(--s1)">' +
    '<th style="' +
    thS +
    ';text-align:left">Month</th><th style="' +
    thS +
    '">Baseline Cost</th><th style="' +
    thS +
    '">Projected Savings</th><th style="' +
    thS +
    '">Actual Savings</th><th style="' +
    thS +
    '">%</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody>' +
    '<tfoot><tr style="background:var(--s1);font-weight:700">' +
    '<td style="padding:6px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)">Annual</td>' +
    '<td style="' +
    tdS() +
    '">' +
    $f(annBase) +
    '</td>' +
    '<td style="' +
    tdS() +
    '">' +
    $f(
      msrSav
        ? msrSav.reduce(function (s, v) {
            return s + v;
          }, 0)
        : _hasContract
          ? annBase * savPct
          : 0,
    ) +
    '</td>' +
    '<td style="' +
    tdS(hasActual ? savColor(annAct, 2) : 'var(--text3)') +
    '">' +
    (hasActual ? savingsSign(annAct, 2, true) + $f(annAct) : '—') +
    '</td>' +
    '<td style="' +
    tdS(annPct != null ? savColor(annPct, 1) : 'var(--text3)') +
    '">' +
    (annPct != null ? savingsSign(annPct, 1, true) + Math.abs(annPct).toFixed(1) + '%' : '—') +
    '</td>' +
    '</tr></tfoot></table></div>' +
    (waitYms.length
      ? '<div style="font-size:11px;color:var(--text2);margin-top:4px">Annual does not include ' +
        _escHtml(weatherWaitingLabel(waitYms)) +
        ': waiting for weather data</div>'
      : '') +
    '</div>'
  );
}

function _pvRenderProjPerf(bldgs, projId) {
  if (!bldgs || !bldgs.length) return '';
  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var moBase = aggBaseMoMapForBldgs(bldgs);
  var annBase = 0;
  for (var i = 0; i < 12; i++) annBase += moBase[i] || 0;
  if (annBase === 0) return '';
  var actSavByMo = {};
  var actSavByBldgYM = {};
  bldgs.forEach(function (b) {
    (b.meters || []).forEach(function (m) {
      if (isBaselineExcluded(projId, m.id)) return;
      var bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      var bills = (m.bills || []).slice().sort(function (a, c) {
        return _parseISO(a.start) - _parseISO(c.start);
      });
      var incl = m.inclusive !== false;
      var savResult = getMeterSavings(m, bills, incl, projId, b.id);
      var sav = savResult.byCalMo;
      Object.keys(sav).forEach(function (mo) {
        actSavByMo[mo] = (actSavByMo[mo] || 0) + sav[mo];
      });
      var bY = (actSavByBldgYM[b.id] = actSavByBldgYM[b.id] || {});
      Object.keys(savResult.byYM).forEach(function (ym) {
        bY[ym] = (bY[ym] || 0) + savResult.byYM[ym];
      });
    });
  });
  var hasActual = Object.keys(actSavByMo).length > 0;
  var $f = function (v) {
    return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var savColor = function (v, d) {
    return savingsSignColor(v, d, 'var(--em)', 'var(--danger)', 'var(--text)');
  };
  var thS =
    'padding:6px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text2);background:var(--s1);border:1px solid var(--border2);white-space:nowrap';
  var tdS = function (c) {
    return (
      'padding:6px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:' +
      (c || 'var(--text)') +
      ';border:1px solid var(--border);white-space:nowrap'
    );
  };
  var annAct = 0;
  var annActMeas = 0;
  // Months with no weather yet: no savings figure (weatherWaitingMonths, computations/savings.js).
  var _allYms = {};
  Object.keys(actSavByBldgYM).forEach(function (id) {
    Object.keys(actSavByBldgYM[id]).forEach(function (ym) {
      _allYms[ym] = true;
    });
  });
  var waitYms = hasActual ? weatherWaitingMonths(projId, Object.keys(_allYms).sort()) : [];
  var waitMo = {};
  waitYms.forEach(function (y) {
    waitMo[Number(y.slice(5, 7)) - 1] = true;
  });
  var waitCell = '<td colspan="2" style="' + tdS('var(--text2)') + '">Waiting for weather data</td>';
  var rows = MN.map(function (mn, mo) {
    var base = moBase[mo] || 0;
    var act = actSavByMo[mo] != null && !waitMo[mo] ? actSavByMo[mo] : null;
    if (act != null) annAct += act;
    var pct = act != null && base > 0 ? (act / base) * 100 : null;
    return (
      '<tr>' +
      '<td style="padding:6px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--s3)">' +
      mn +
      '</td>' +
      '<td style="' +
      tdS() +
      '">' +
      $f(base) +
      '</td>' +
      (waitMo[mo]
        ? waitCell
        : '<td style="' +
          tdS(act != null ? savColor(act, 2) : 'var(--text3)') +
          '">' +
          (act != null ? savingsSign(act, 2, true) + $f(act) : '—') +
          '</td>' +
          '<td style="' +
          tdS(pct != null ? savColor(pct, 1) : 'var(--text3)') +
          '">' +
          (pct != null ? savingsSign(pct, 1, true) + Math.abs(pct).toFixed(1) + '%' : '—') +
          '</td>') +
      '</tr>'
    );
  }).join('');
  // Annual total: a period presented to the client uses the presented figure (computations/savings.js).
  if (hasActual) {
    var _allYMs = {};
    Object.keys(actSavByBldgYM).forEach(function (id) {
      Object.keys(actSavByBldgYM[id]).forEach(function (ym) {
        _allYMs[ym] = true;
      });
    });
    var _annB = billableSavingsWithPresented(projId, Object.keys(_allYMs).sort(), actSavByBldgYM);
    annAct = _annB.total;
    annActMeas = _annB.measured; // before the $0 floor
  }
  var annPct = annBase > 0 && hasActual ? (annAct / annBase) * 100 : null;
  var annPctMeas = annBase > 0 && hasActual ? (annActMeas / annBase) * 100 : null;
  var _annShown = hasActual ? savingsFlooredShown(annActMeas, annAct, 2, $f, 'var(--em)', 'var(--danger)', 'var(--text)') : null;
  var _annPctShown =
    annPct != null
      ? savingsFlooredShown(annPctMeas, annPct, 1, function (n) { return n.toFixed(1) + '%'; }, 'var(--em)', 'var(--danger)', 'var(--text)')
      : null;
  var projMeta = projects.find(function (p) {
    return p.id === projId;
  });
  var projName = (projMeta && projMeta.name) || 'Project';
  return (
    '<div style="margin-top:16px;padding-top:12px;border-top:2px solid var(--border)">' +
    '<div style="font-size:13px;font-weight:800;font-family:var(--head);color:var(--em);margin-bottom:6px">💡 ' +
    _escHtml(projName) +
    ' — Project Performance Total</div>' +
    '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">' +
    '<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr style="background:var(--s1)">' +
    '<th style="' +
    thS +
    ';text-align:left">Month</th><th style="' +
    thS +
    '">Baseline Cost</th><th style="' +
    thS +
    '">Total Savings</th><th style="' +
    thS +
    '">%</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody>' +
    '<tfoot><tr style="background:var(--s1);font-weight:700">' +
    '<td style="padding:6px 10px;font-size:12px;font-weight:700;border:1px solid var(--border)">Annual</td>' +
    '<td style="' +
    tdS() +
    '">' +
    $f(annBase) +
    '</td>' +
    '<td style="' +
    tdS(hasActual ? _annShown.color : 'var(--text3)') +
    '">' +
    (hasActual ? _annShown.text : '—') +
    '</td>' +
    '<td style="' +
    tdS(annPct != null ? _annPctShown.color : 'var(--text3)') +
    '">' +
    (annPct != null ? _annPctShown.text : '—') +
    '</td>' +
    '</tr></tfoot></table></div>' +
    (waitYms.length
      ? '<div style="font-size:11px;color:var(--text2);margin-top:4px">Annual does not include ' +
        _escHtml(weatherWaitingLabel(waitYms)) +
        ': waiting for weather data</div>'
      : '') +
    '</div>'
  );
}

function egfxRenderPerfVerify(projId) {
  var content = document.getElementById('egfx-perfverify-content-' + projId);
  if (!content) return;
  var bldgs = getUDBldgs(projId);
  if (!bldgs.length) {
    content.innerHTML = '<div style="color:var(--text3);font-size:12px">No buildings in this project.</div>';
    return;
  }
  var html = '';
  bldgs.forEach(function (b) {
    var meterHtml = '';
    var _commOrder = ['Electric', 'Gas', 'Propane', 'Water', 'Sewer', 'Stormwater'];
    var sortedMeters = (b.meters || []).slice().sort(function (a, b) {
      return _commOrder.indexOf(a.commodity) - _commOrder.indexOf(b.commodity);
    });
    sortedMeters.forEach(function (m) {
      if (isBaselineExcluded(projId, m.id)) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      var bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      var bills = (m.bills || []).slice().sort(function (a, c) {
        return _parseISO(a.start) - _parseISO(c.start);
      });
      var incl = m.inclusive !== false;
      meterHtml += _pvRenderMeterPerf(m, bills, incl, projId, b.id);
    });
    var bldgPerfHtml = _pvRenderBldgPerf(b, projId);
    if (!meterHtml && !bldgPerfHtml) return;
    html +=
      '<div style="margin-bottom:12px">' +
      '<div onclick="_pvToggleBldg(\'' +
      projId +
      "','" +
      b.id +
      '\')" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--s2);border-radius:6px;cursor:pointer;border:1px solid var(--border)">' +
      '<span id="pv-bldg-chev-' +
      projId +
      '-' +
      b.id +
      '" style="font-size:10px;color:var(--text3)">▶</span>' +
      '<span style="font-size:12px;font-weight:700;color:var(--text)">' +
      _escHtml(b.name || 'Building') +
      '</span>' +
      '</div>' +
      '<div id="pv-bldg-body-' +
      projId +
      '-' +
      b.id +
      '" style="display:none;padding:12px 8px 8px">' +
      meterHtml +
      bldgPerfHtml +
      '</div></div>';
  });
  html += _pvRenderProjPerf(bldgs, projId);
  content.innerHTML = html || '<div style="color:var(--text3);font-size:12px">No baseline data available.</div>';
}

/* ══════════════════════════════════════════════════════
   kWh vs kW analysis card (Energy Graphics tab, right below the kWh / kW charts).
   Math: computations/energy-analysis.js. Month rule, day count, gas therms and degree days come from the
   shared functions it calls. Every value carries its arithmetic in its hover text.
══════════════════════════════════════════════════════ */
// Table look shared by the kWh vs kW card and the Where-the-energy-goes table (ui-standards.md Tables: outer border,
// --s1 header, grid lines, totals footer). Rendered once at the top of the charts area.
const _EGFX_TBL_CSS = `<style>
        .ea-tbl-outer{border:1px solid var(--border);border-radius:6px;overflow:hidden;max-width:100%}
        .ea-scroll{overflow-x:auto}
        .ea-tbl{border-collapse:separate;border-spacing:0;width:100%;font-size:11px;font-variant-numeric:tabular-nums}
        .ea-tbl th,.ea-tbl td{padding:4px 5px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);color:var(--text);white-space:nowrap;text-align:right}
        .ea-tbl th:last-child,.ea-tbl td:last-child{border-right:none}
        .ea-tbl tbody tr:last-child td{border-bottom:none}
        .ea-tbl thead th{background:var(--s1);color:var(--text2);font-size:10px;font-weight:700;letter-spacing:.3px;text-align:center;cursor:help;white-space:normal;line-height:1.2;border-bottom:1px solid var(--border2)}
        .ea-tbl td.ea-l,.ea-tbl th.ea-l{text-align:left}
        .ea-tbl td[title]{cursor:help}
        .ea-tbl td.ea-wrap{white-space:normal}
        .ea-tbl tfoot td{background:var(--s1);font-weight:700;border-top:2px solid var(--border2);border-bottom:none}
        .ea-tbl tbody tr:hover td{background:var(--s4)}
        @media (max-width:1200px){.ea-tbl th,.ea-tbl td{padding:3px 3px}.ea-tbl{font-size:10.5px}}
</style>`;

var _egfxEaSel = {}; // projId -> selected building id

function _eaFmt(v, d) {
  return v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
}
// kW values keep one decimal only when the bill has one; degree-day ratios keep digits that matter.
function _eaFmtKw(v) {
  return v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
}
function _eaFmtRatio(v) {
  return v == null || !isFinite(v) ? '—' : _eaFmt(v, v >= 100 ? 0 : v >= 10 ? 1 : 2);
}
function _eaPct(v) {
  return v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%';
}
function _eaSigned(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100);
  return (r > 0 ? '+' : r < 0 ? '-' : '') + Math.abs(r) + '%';
}
// The numbers one building's card needs. Used by the reading list and by the table.
function _egfxEaCompute(projId, b) {
  const ea = getEnergyAnalysis(projId, b);
  const r = { ea: ea, cy: null, py: null, S: [], G: [], cur: null, prev: null, label: '', reading: '' };
  if (!ea.years.length) {
    r.reading = 'No electric bills for this building.';
    return r;
  }
  r.cy = ea.years[ea.years.length - 1];
  if (ea.years.length < 2) {
    r.reading = 'Only one year of electric bills. Add another year to compare.';
    return r;
  }
  r.py = ea.years[ea.years.length - 2];
  const cm = ea.byYear[r.cy].months;
  const pm = ea.byYear[r.py].months;
  r.S = eaCommonMonths(cm, pm, (m) => m && m.kwh > 0 && m.kw > 0);
  r.G = eaCommonMonths(cm, pm, (m) => m && m.therms > 0);
  r.cur = eaYearSummary(cm, r.S, r.G);
  r.prev = eaYearSummary(pm, r.S, r.G);
  r.label = eaMonthsLabel(r.S);
  r.reading = r.S.length ? eaReadingText(r.cy, r.py, r.cur, r.prev, r.label) : 'Not enough months in both years to compare.';
  return r;
}

function _egfxEaCardHtml(projId) {
  const bl = getUDBldgs(projId).filter((b) => getEnergyAnalysis(projId, b).years.length);
  if (!bl.length) return '';
  if (!bl.some((b) => String(b.id) === String(_egfxEaSel[projId]))) _egfxEaSel[projId] = bl[0].id;
  const selId = _egfxEaSel[projId];
  const readings = bl
    .map(
      (b) =>
        `<div style="font-size:12px;color:var(--text)"><span style="color:var(--text2);font-weight:700">${_escHtml(b.name || 'Unknown')}:</span> ${_escHtml(_egfxEaCompute(projId, b).reading)}</div>`,
    )
    .join('');
  const opts = bl
    .map((b) => `<option value="${_escHtml(b.id)}"${String(b.id) === String(selId) ? ' selected' : ''}>${_escHtml(b.name || 'Unknown')}</option>`)
    .join('');
  return `<div class="card ea-card" id="egfx-ea-${projId}" style="padding:14px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">⚡ kWh vs kW — more energy, or the same building running longer?</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px">kWh is the energy used. kW is the highest power demand. Hover over any number or column heading to see how it is worked out.</div>
      <div style="display:flex;flex-direction:column;gap:3px;margin-bottom:12px" id="egfx-ea-readings-${projId}">${readings}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <label for="egfx-ea-sel-${projId}" style="font-size:11px;color:var(--text2);font-weight:700">Building</label>
        <select id="egfx-ea-sel-${projId}" class="fs" style="width:auto;max-width:100%;padding:4px 8px;font-size:12px" onchange="egfxEaSelect('${projId}', this.value)">${opts}</select>
      </div>
      <div id="egfx-ea-body-${projId}">${_egfxEaBodyHtml(projId, selId)}</div>
    </div>`;
}

function egfxEaSelect(projId, bId) {
  _egfxEaSel[projId] = bId;
  const el = document.getElementById(`egfx-ea-body-${projId}`);
  if (el) el.innerHTML = _egfxEaBodyHtml(projId, bId);
}

function _egfxEaBodyHtml(projId, bId) {
  const b = getUDBldgs(projId).find((x) => String(x.id) === String(bId));
  if (!b) return '';
  const c = _egfxEaCompute(projId, b);
  const ea = c.ea;
  const years = c.py != null ? [c.py, c.cy] : [c.cy];
  const MO = EA_MONTHS;
  const baseKw = typeof resolveHvacLoadData === 'function' ? resolveHvacLoadData(projId, b).kwArr : Array(12).fill(null);
  const showGas = ea.hasGas;
  const kw1 = (v) => _eaFmtKw(v) + ' kW';

  // ---- hover text, one per figure (the arithmetic) ----
  const tLf = (m) =>
    m.kw > 0 && m.hours > 0 && m.kwh > 0
      ? `${_eaFmt(m.kwh)} kWh ÷ (${_eaFmtKw(m.kw)} kW × ${_eaFmt(m.hours)} hours) = ${_eaPct(eaLoadFactor(m.kwh, m.kw, m.hours))}`
      : 'Needs kWh, peak kW and the bill dates';
  const tFlh = (m) =>
    m.kw > 0 && m.kwh > 0 ? `${_eaFmt(m.kwh)} kWh ÷ ${_eaFmtKw(m.kw)} kW = ${_eaFmt(eaFullLoadHours(m.kwh, m.kw))} hours` : 'Needs kWh and peak kW';
  const tLow = (kind) => `Fewer than ${EA_MIN_DEGREE_DAYS} ${kind} degree days this month, so this ratio is not meaningful.`;
  const tCdd = (m) =>
    m.kwh > 0 && m.cdd > 0 && m.cdd < EA_MIN_DEGREE_DAYS
      ? tLow('cooling')
      : m.kwh > 0 && m.cdd > 0
      ? `${_eaFmt(m.kwh)} kWh ÷ ${_eaFmt(m.cdd, 0)} cooling degree days = ${_eaFmtRatio(eaPerDegreeDay(m.kwh, m.cdd))} kWh per degree day`
      : 'No cooling degree days that month (nothing to divide by)';
  const tHdd = (m) =>
    m.therms > 0 && m.hdd > 0 && m.hdd < EA_MIN_DEGREE_DAYS
      ? tLow('heating')
      : m.therms > 0 && m.hdd > 0
      ? `${_eaFmt(m.therms)} therms ÷ ${_eaFmt(m.hdd, 0)} heating degree days = ${_eaFmtRatio(eaPerDegreeDay(m.therms, m.hdd))} therms per degree day`
      : 'No heating degree days that month (nothing to divide by)';
  const HELP = {
    kwh: 'Electric energy used in the month: the sum of the kWh on the bills in that month.',
    kw: 'Highest power demand (kW) on the bill for the month. Baseline is the same calendar month in the baseline year.',
    lf: 'Load factor: how much of the time the building ran at its highest demand. 100% would mean the peak kW lasted every hour of the bill period. Worked out as kWh ÷ (peak kW × hours in the bill period).',
    flh: 'Equivalent full-load hours: the hours the building would need to run at its peak kW to use that many kWh. Worked out as kWh ÷ peak kW.',
    cdd: 'kWh for each cooling degree day. A cooling degree day measures how much hotter than mild the outdoor air was, so a hot month has more of them. This lets months with different weather be compared. Worked out as kWh ÷ cooling degree days.',
    hdd: 'Therms of gas for each heating degree day. A heating degree day measures how much colder than mild the outdoor air was. Worked out as therms ÷ heating degree days.',
  };
  const yr = (help) => years.map((y) => `<th title="${_escHtml(help)}">${y}</th>`).join('');

  // ---- monthly table ----
  const grp = (label, help, n) => `<th colspan="${n}" title="${_escHtml(help)}">${label}</th>`;
  const head =
    `<tr><th rowspan="2" class="ea-l" style="cursor:default">Month</th>` +
    grp('kWh', HELP.kwh, years.length) +
    grp('Peak kW', HELP.kw, years.length + 1) +
    grp('Load factor', HELP.lf, years.length) +
    grp('Full-load hours', HELP.flh, years.length) +
    grp('kWh per cooling degree day', HELP.cdd, years.length) +
    (showGas ? grp('Therms per heating degree day', HELP.hdd, years.length) : '') +
    `</tr><tr>` +
    yr(HELP.kwh) +
    yr(HELP.kw) +
    `<th title="${_escHtml(HELP.kw)}">Baseline</th>` +
    yr(HELP.lf) +
    yr(HELP.flh) +
    yr(HELP.cdd) +
    (showGas ? yr(HELP.hdd) : '') +
    `</tr>`;
  const cell = (txt, tip) => `<td title="${_escHtml(tip)}">${txt}</td>`;
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const ms = years.map((y) => (ea.byYear[y] ? ea.byYear[y].months[i] : null));
    if (!ms.some((m) => m && m.hasElec)) continue;
    const blv = baseKw[i];
    const per = (fn) => ms.map((m) => (m && m.hasElec ? fn(m) : cell('—', 'No electric bill in this month'))).join('');
    rows.push(
      `<tr><td class="ea-l">${MO[i]}</td>` +
        per((m) => cell(_eaFmt(m.kwh), `${MO[i]}: ${_eaFmt(m.kwh)} kWh (sum of the bills in the month)`)) +
        per((m) => cell(_eaFmtKw(m.kw), `${MO[i]}: highest demand on the bill = ${kw1(m.kw)}`)) +
        cell(blv != null ? _eaFmtKw(blv) : '—', blv != null ? `Baseline year, ${MO[i]}: ${kw1(blv)}` : 'No baseline bill for this month') +
        per((m) => cell(_eaPct(eaLoadFactor(m.kwh, m.kw, m.hours)), tLf(m))) +
        per((m) => cell(_eaFmt(eaFullLoadHours(m.kwh, m.kw)), tFlh(m))) +
        per((m) => cell(_eaFmtRatio(eaPerDegreeDay(m.kwh, m.cdd)), tCdd(m))) +
        (showGas
          ? ms.map((m) => (m && m.hasGas ? cell(_eaFmtRatio(eaPerDegreeDay(m.therms, m.hdd)), tHdd(m)) : cell('—', 'No gas bill in this month'))).join('')
          : '') +
        `</tr>`,
    );
  }

  // ---- same-months summary (the totals row of the monthly table, and the comparison table) ----
  let foot = '';
  let summary = '';
  if (c.cur && c.S.length) {
    const sums = [c.prev, c.cur];
    const blS = c.S.map((i) => baseKw[i]).filter((v) => v != null && v > 0);
    const blPeak = blS.length ? Math.max(...blS) : null;
    const tLfS = (s) =>
      s.loadFactor != null
        ? `${_eaFmt(s.lfKwh)} kWh ÷ (${_eaFmtKw(s.peakKw)} kW × ${_eaFmt(s.hours)} hours) = ${_eaPct(s.loadFactor)}`
        : 'Needs kWh, peak kW and the bill dates';
    const tFlhS = (s) => `${_eaFmt(s.kwh)} kWh ÷ ${_eaFmtKw(s.peakKw)} kW = ${_eaFmt(s.fullLoadHours)} hours`;
    const tCddS = (s) => (s.kwhPerCdd != null ? `${_eaFmt(s.cddKwh)} kWh ÷ ${_eaFmt(s.cddSum)} cooling degree days = ${_eaFmtRatio(s.kwhPerCdd)}` : 'No cooling degree days');
    const tHddS = (s) => (s.thermsPerHdd != null ? `${_eaFmt(s.therms)} therms ÷ ${_eaFmt(s.hddSum)} heating degree days = ${_eaFmtRatio(s.thermsPerHdd)}` : 'No heating degree days');
    const scope = `${c.label}, the months with bills in both ${c.py} and ${c.cy}`;
    foot =
      `<tfoot><tr><td class="ea-l" title="${_escHtml('Months with bills in both years: ' + c.label)}">${_escHtml(c.label)}</td>` +
      sums.map((s) => cell(_eaFmt(s.kwh), `Sum of kWh, ${scope}`)).join('') +
      sums.map((s) => cell(_eaFmtKw(s.peakKw), `Highest of the monthly peak kW, ${scope}`)).join('') +
      cell(_eaFmtKw(blPeak), `Highest baseline kW over the same months`) +
      sums.map((s) => cell(_eaPct(s.loadFactor), tLfS(s))).join('') +
      sums.map((s) => cell(_eaFmt(s.fullLoadHours), tFlhS(s))).join('') +
      sums.map((s) => cell(_eaFmtRatio(s.kwhPerCdd), tCddS(s))).join('') +
      (showGas ? sums.map((s) => cell(_eaFmtRatio(s.thermsPerHdd), tHddS(s))).join('') : '') +
      `</tr></tfoot>`;

    // comparison table: one row per measure, the two years side by side, and the change
    const chg = (a, p) => eaPctChange(a, p);
    const row = (label, help, pv, cv, pt, ct, change, changeTip) =>
      `<tr><td class="ea-l" title="${_escHtml(help)}" style="cursor:help">${label}</td>` + cell(pv, pt) + cell(cv, ct) + cell(change, changeTip) + `</tr>`;
    const dLf = c.cur.loadFactor != null && c.prev.loadFactor != null ? c.cur.loadFactor - c.prev.loadFactor : null;
    const dTip = (a, p) => {
      const ca = chg(a, p);
      return ca != null ? `(${_eaFmtRatio(a)} − ${_eaFmtRatio(p)}) ÷ ${_eaFmtRatio(p)} = ${_eaSigned(ca)}` : 'Needs both years';
    };
    const blPct = (s) => (s.peakKw != null && blPeak ? (s.peakKw - blPeak) / blPeak : null);
    const blTip = (s) =>
      blPct(s) != null ? `(${_eaFmtKw(s.peakKw)} kW − ${_eaFmtKw(blPeak)} kW) ÷ ${_eaFmtKw(blPeak)} kW = ${_eaSigned(blPct(s))}` : 'No baseline kW to compare with';
    const blTxt = (s) => (s.baseload ? _eaFmt(s.baseload.perDay) : '—');
    const blTipTxt = (s) =>
      s.baseload
        ? `Lowest month: ${MO[s.baseload.mo]}. ${_eaFmt(s.baseload.kwh)} kWh ÷ ${_eaFmt(s.baseload.days, 1)} days = ${_eaFmt(s.baseload.perDay)} kWh per day`
        : 'No month with kWh and bill dates';
    const bC = chg(c.cur.baseload && c.cur.baseload.perDay, c.prev.baseload && c.prev.baseload.perDay);
    const pk = (s, y) => `Highest monthly peak kW in ${y}${s.peakMo != null ? ' (' + MO[s.peakMo] + ')' : ''}`;
    summary =
      `<div style="font-size:11px;font-weight:700;color:var(--text2);margin:14px 0 6px">${c.cy} compared with ${c.py}, ${_escHtml(c.label)} (the months with bills in both years)</div>` +
      `<div class="ea-tbl-outer" style="max-width:640px"><table class="ea-tbl"><thead><tr><th class="ea-l" style="cursor:default">Measure</th><th style="cursor:default">${c.py}</th><th style="cursor:default">${c.cy}</th><th style="cursor:default">Change</th></tr></thead><tbody>` +
      row('Electric use (kWh)', HELP.kwh, _eaFmt(c.prev.kwh), _eaFmt(c.cur.kwh), `Sum of kWh, ${scope}`, `Sum of kWh, ${scope}`, _eaSigned(chg(c.cur.kwh, c.prev.kwh)), dTip(c.cur.kwh, c.prev.kwh)) +
      row('Peak kW (highest month)', HELP.kw, _eaFmtKw(c.prev.peakKw), _eaFmtKw(c.cur.peakKw), pk(c.prev, c.py), pk(c.cur, c.cy), _eaSigned(chg(c.cur.peakKw, c.prev.peakKw)), dTip(c.cur.peakKw, c.prev.peakKw)) +
      row('Peak kW compared with baseline year', 'How far the highest monthly kW is above (+) or below (−) the highest baseline kW over the same months.', _eaSigned(blPct(c.prev)), _eaSigned(blPct(c.cur)), blTip(c.prev), blTip(c.cur), '—', 'Each year is compared with the baseline year, not with the other year') +
      row('Load factor', HELP.lf, _eaPct(c.prev.loadFactor), _eaPct(c.cur.loadFactor), tLfS(c.prev), tLfS(c.cur), dLf == null ? '—' : (Math.round(dLf * 100) > 0 ? '+' : '') + Math.round(dLf * 100) + ' points', dLf == null ? 'Needs both years' : `${_eaPct(c.cur.loadFactor)} − ${_eaPct(c.prev.loadFactor)} = ${Math.round(dLf * 100)} percentage points`) +
      row('Full-load hours', HELP.flh, _eaFmt(c.prev.fullLoadHours), _eaFmt(c.cur.fullLoadHours), tFlhS(c.prev), tFlhS(c.cur), _eaSigned(chg(c.cur.fullLoadHours, c.prev.fullLoadHours)), dTip(c.cur.fullLoadHours, c.prev.fullLoadHours)) +
      row('Baseload (lowest month, kWh per day)', 'The lowest daily electric use of any month. Worked out as the month kWh ÷ the days in the bill period; the lowest month is used.', blTxt(c.prev), blTxt(c.cur), blTipTxt(c.prev), blTipTxt(c.cur), _eaSigned(bC), bC != null ? `(${blTxt(c.cur)} − ${blTxt(c.prev)}) ÷ ${blTxt(c.prev)} = ${_eaSigned(bC)}` : 'Needs both years') +
      row('kWh per cooling degree day', HELP.cdd, _eaFmtRatio(c.prev.kwhPerCdd), _eaFmtRatio(c.cur.kwhPerCdd), tCddS(c.prev), tCddS(c.cur), _eaSigned(chg(c.cur.kwhPerCdd, c.prev.kwhPerCdd)), dTip(c.cur.kwhPerCdd, c.prev.kwhPerCdd)) +
      (showGas && c.G.length
        ? row('Therms per heating degree day', HELP.hdd, _eaFmtRatio(c.prev.thermsPerHdd), _eaFmtRatio(c.cur.thermsPerHdd), tHddS(c.prev), tHddS(c.cur), _eaSigned(chg(c.cur.thermsPerHdd, c.prev.thermsPerHdd)), dTip(c.cur.thermsPerHdd, c.prev.thermsPerHdd))
        : '') +
      `</tbody></table></div>`;
  }

  return (
    summary +
    `<div style="font-size:11px;font-weight:700;color:var(--text2);margin:14px 0 6px">Month by month</div>` +
    `<div class="ea-tbl-outer"><div class="ea-scroll"><table class="ea-tbl"><thead>${head}</thead><tbody>${rows.join('')}</tbody>${foot}</table></div></div>`
  );
}

function egfxRefresh(projId) {
  const p = projects.find((x) => x.id === projId);
  if (!p) return;
  const bldgs = getUDBldgs(projId);
  const sqft = bldgs.reduce((s, b) => s + parseInt(b.sqft || 0), 0) || 1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const moNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // Collect baseline and post-baseline data from all electric and gas meters
  let blKwh = new Array(12).fill(0),
    blGas = new Array(12).fill(0),
    blPropane = new Array(12).fill(0);
  let blCost = new Array(12).fill(0);
  let blYmPerMo = Array.from({ length: 12 }, () => new Set());
  let blYmAll = new Set(); // every actual YM ('YYYY-MM') counted as baseline, for the real first->last month range
  // Year-over-year: collect by year
  let yearData = {}; // {year: {kwh:[12], kw:[12], gas:[12], cost:[12]}}
  let blYears = new Set();
  let bldgYearData = {}; // {bldgName: {year: {kwh:[12], kw:[12], gas:[12], cost:[12]}}}
  // The HVAC End-Use Estimate cards read resolveHvacLoadData (app/calculators.js) — the one
  // per-building monthly reader for the 3-lowest-month baseload split (WP-15). No private sums here.

  // getBillFacKWCost (computations/rates.js) — the ONE accessor for Facilities kW Cost
  // (2026-09-23 single-source fix); never read bill.facKWCost/facilitiesCharge directly.
  const _elecCommodityCost = (bill) => getBillKwhCost(bill) + getBillKwCost(bill) + getBillFacKWCost(bill);
  const _gasCommodityCost = (bill) => parseBillNumber(bill.totalCost) || getBillGasCost(bill) || parseBillNumber(bill.cost) || 0;
  const _propaneCommodityCost = (bill) => parseBillNumber(bill.totalCost) || parseBillNumber(bill.cost) || 0;

  bldgs.forEach((b) => {
    const bName = b.name || 'Unknown';
    if (!bldgYearData[bName]) bldgYearData[bName] = {};
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id)) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const isElec = m.commodity === 'Electric';
      const isGas = m.commodity === 'Gas';
      const isPropane = m.commodity === 'Propane';
      const bl = m.baseline || {};
      // bl.months is an array of year-month strings like ['2024-01','2024-02',...]
      // populated when the user saves a baseline period. When missing, fall back to
      // treating every bill as baseline so graphics still render against stored data.
      const blSet = Array.isArray(bl.months) && bl.months.length ? new Set(bl.months) : null;

      const _mBills = m.bills || [];
      _mBills.forEach((bill) => {
        // billMonth: the one month rule across all views
        const ym = billMonth(bill, _mBills);
        let yr = null,
          mi = -1;
        if (/^\d{4}-\d{2}/.test(ym)) {
          yr = parseInt(ym.slice(0, 4));
          mi = parseInt(ym.slice(5, 7)) - 1;
        }
        if (mi < 0) return;

        // Baseline membership: if a baseline was saved, use its YM set;
        // otherwise treat every bill as baseline so charts still render.
        const isBaseline = blSet ? ym && blSet.has(ym) : true;

        if (isBaseline) {
          // Baseline data
          if (isElec) {
            const _kwhVal = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            blKwh[mi] += _kwhVal;
            blCost[mi] += _elecCommodityCost(bill);
          }
          if (isGas) {
            const _gasVal = resolveGasUsageTherms(bill);
            blGas[mi] += _gasVal;
          }
          if (isGas) blCost[mi] += _gasCommodityCost(bill);
          if (isPropane) {
            blPropane[mi] += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            blCost[mi] += _propaneCommodityCost(bill);
          }
          if (yr) blYears.add(yr);
          if (ym) blYmPerMo[mi].add(ym);
          if (ym) blYmAll.add(ym);
        }

        // Collect year-over-year (project-level and per-building)
        if (yr) {
          if (!yearData[yr])
            yearData[yr] = {
              kwh: new Array(12).fill(0),
              kw: new Array(12).fill(0),
              gas: new Array(12).fill(0),
              propane: new Array(12).fill(0),
              cost: new Array(12).fill(0),
              elecCost: new Array(12).fill(0),
              gasCost: new Array(12).fill(0),
              propaneCost: new Array(12).fill(0),
            };
          if (!bldgYearData[bName][yr])
            bldgYearData[bName][yr] = {
              kwh: new Array(12).fill(0),
              kw: new Array(12).fill(0),
              gas: new Array(12).fill(0),
              propane: new Array(12).fill(0),
              cost: new Array(12).fill(0),
              elecCost: new Array(12).fill(0),
              gasCost: new Array(12).fill(0),
              propaneCost: new Array(12).fill(0),
            };
          const byd = bldgYearData[bName][yr];
          if (isElec) {
            const kwhVal = parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            const kwVal = parseFloat(bill.demandKW) || 0;
            const costVal = _elecCommodityCost(bill);
            yearData[yr].kwh[mi] += kwhVal;
            yearData[yr].kw[mi] += kwVal;
            yearData[yr].cost[mi] += costVal;
            yearData[yr].elecCost[mi] += costVal;
            byd.kwh[mi] += kwhVal;
            byd.kw[mi] += kwVal;
            byd.cost[mi] += costVal;
            byd.elecCost[mi] += costVal;
          }
          if (isGas) {
            const gasVal = resolveGasUsageTherms(bill);
            const gasCostVal = _gasCommodityCost(bill);
            yearData[yr].gas[mi] += gasVal;
            yearData[yr].cost[mi] += gasCostVal;
            yearData[yr].gasCost[mi] += gasCostVal;
            byd.gas[mi] += gasVal;
            byd.cost[mi] += gasCostVal;
            byd.gasCost[mi] += gasCostVal;
          }
          if (isPropane) {
            const propVal = parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            const propCostVal = _propaneCommodityCost(bill);
            yearData[yr].propane[mi] += propVal;
            yearData[yr].cost[mi] += propCostVal;
            yearData[yr].propaneCost[mi] += propCostVal;
            byd.propane[mi] += propVal;
            byd.cost[mi] += propCostVal;
            byd.propaneCost[mi] += propCostVal;
          }
        }
      });
    });
  });

  // Normalize propane deliveries using HDD-weighted spreading
  bldgs.forEach((b) => {
    const bName = b.name || 'Unknown';
    const zip = b.zip || '';
    const wCache = zip ? wddLoadCache(zip) : [];
    const wByYm = {};
    wCache.forEach((r) => {
      wByYm[r.ym] = r;
    });
    (b.meters || []).forEach((m) => {
      if (m.commodity !== 'Propane' || isBaselineExcluded(projId, m.id)) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const bills = (m.bills || []).filter((b) => b.start);
      if (!bills.length) return;
      const normResult = normalizePropaneDeliveries(bills, wByYm);
      if (!normResult.length) return;
      // Clear raw propane from yearData/bldgYearData for this building, then re-add normalized
      const yrs = new Set();
      bills.forEach((bill) => {
        const ymSrc = bill.end || bill.start || '';
        if (/^\d{4}/.test(ymSrc)) yrs.add(parseInt(ymSrc.slice(0, 4)));
      });
      // Clear this building's raw propane contributions
      for (const yr of yrs) {
        if (bldgYearData[bName]?.[yr]) bldgYearData[bName][yr].propane = new Array(12).fill(0);
      }
      // Re-add normalized values
      normResult.forEach((nr) => {
        const yr = parseInt(nr.month.slice(0, 4));
        const mi = parseInt(nr.month.slice(5, 7)) - 1;
        // Create entries if normalization spans into a year with no raw bills
        if (!bldgYearData[bName]) bldgYearData[bName] = {};
        if (!bldgYearData[bName][yr]) {
          bldgYearData[bName][yr] = {
            kwh: new Array(12).fill(0),
            kw: new Array(12).fill(0),
            gas: new Array(12).fill(0),
            propane: new Array(12).fill(0),
            cost: new Array(12).fill(0),
            elecCost: new Array(12).fill(0),
            gasCost: new Array(12).fill(0),
            propaneCost: new Array(12).fill(0),
          };
        }
        if (!yearData[yr]) {
          yearData[yr] = {
            kwh: new Array(12).fill(0),
            kw: new Array(12).fill(0),
            gas: new Array(12).fill(0),
            propane: new Array(12).fill(0),
            cost: new Array(12).fill(0),
            elecCost: new Array(12).fill(0),
            gasCost: new Array(12).fill(0),
            propaneCost: new Array(12).fill(0),
          };
        }
        bldgYearData[bName][yr].propane[mi] += nr.gallons;
      });
    });
  });
  // Rebuild project-level yearData propane from per-building normalized data
  for (const yr of Object.keys(yearData)) {
    yearData[yr].propane = new Array(12).fill(0);
    for (const bName of Object.keys(bldgYearData)) {
      if (bldgYearData[bName][yr]) {
        for (let mi = 0; mi < 12; mi++) yearData[yr].propane[mi] += bldgYearData[bName][yr].propane[mi];
      }
    }
  }

  // Baseline per calendar month — use buildMoMap (same as Utility Data Performance tab)
  const _blKwhFromMap = new Array(12).fill(0);
  const _blGasFromMap = new Array(12).fill(0);
  const _blPropaneFromMap = new Array(12).fill(0);
  const _blKwFromMap = new Array(12).fill(0);
  const _kwNormByYm = {}; // project-level: YYYY-MM -> sum of CDD-regression-predicted kW across meters
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id)) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const mBills = (m.bills || []).slice().sort((a, c) => (a.start || '').localeCompare(c.start || ''));
      const mIncl = m.inclusive !== false;
      const wx = getWeatherForBuilding(projId, b.id);
      const mAllRows = getNormRows(m, mBills, mIncl, wx.byYm);
      const mBlRows = mAllRows.filter((r) => bl.months.includes(r.ym));
      const mMap = buildMoMap(m, mBlRows, mBills, mIncl);
      const isElec = m.commodity === 'Electric';
      const isGas = m.commodity === 'Gas';
      const isPropane = m.commodity === 'Propane';

      // kW CDD regression: normalize kW with the one kW CDD regression (computations/regression.js)
      // computeKwCddRegression returns {ym: predictedKW} for all months, or {} if insufficient data
      let _mKwNorm = {};
      if (isElec && typeof computeKwCddRegression === 'function') {
        _mKwNorm = computeKwCddRegression(mBlRows, mAllRows, mBills, mIncl);
      }
      const _hasKwNorm = Object.keys(_mKwNorm).length > 0;

      // Merge this meter's kW predictions into project-level lookup (sum across meters per YM)
      if (_hasKwNorm) {
        Object.entries(_mKwNorm).forEach(([ym, kw]) => {
          _kwNormByYm[ym] = (_kwNormByYm[ym] || 0) + kw;
        });
      }

      const moMap = isElec ? mMap.elecByMo : isGas ? mMap.gasByMo : isPropane ? mMap.propaneByMo : {};
      Object.entries(moMap).forEach(([mo, v]) => {
        if (isElec) {
          _blKwhFromMap[mo] += v.kwh || 0;
          if (_hasKwNorm) {
            // Baseline kW: average regression predictions for this calendar month across baseline YMs
            const blYmsForMo = mBlRows.filter((r) => parseInt(r.ym.split('-')[1]) - 1 === parseInt(mo));
            let kwNormSum = 0,
              kwNormCnt = 0;
            blYmsForMo.forEach((r) => {
              if (_mKwNorm[r.ym] != null) {
                kwNormSum += _mKwNorm[r.ym];
                kwNormCnt++;
              }
            });
            const avgKwNorm = kwNormCnt > 0 ? kwNormSum / kwNormCnt : 0;
            if (avgKwNorm > 0) {
              _blKwFromMap[mo] += avgKwNorm;
            } else {
              // Fallback to raw if regression returned nothing for this month
              _blKwFromMap[mo] += v.demandKW || 0;
            }
          } else {
            // No regression available — fallback to raw demandKW (same as before)
            _blKwFromMap[mo] += v.demandKW || 0;
          }
        }
        if (isGas) _blGasFromMap[mo] += v.therms || 0;
        if (isPropane) _blPropaneFromMap[mo] += v.gallons || 0;
      });
    });
  });

  // NOTE: _kwNormByYm is no longer used to overwrite yearData kW.
  // The baseline line uses _blKwFromMap (passed as blAvgArr to the chart).
  // Each year's bars should show actual summed demandKW from bills, not regression predictions.
  // Removed overwrite block that made all YoY series show identical regression values.

  const blKwhAvg = _blKwhFromMap;
  const blGasAvg = _blGasFromMap;
  const blPropaneAvg = _blPropaneFromMap;
  const totalBlKwh = blKwhAvg.reduce((a, b) => a + b, 0);
  const totalBlGas = blGasAvg.reduce((a, b) => a + b, 0);
  const totalBlPropane = blPropaneAvg.reduce((a, b) => a + b, 0);
  const blEui = getProjectBaselineTotals(projId).eui; // same call as the project header Site EUI
  const cbecsEui = CBECS_EUI[p.type] || 48.5;

  const sortedYears = Object.keys(yearData).map(Number).sort();
  const latestYear = sortedYears.length > 0 ? sortedYears[sortedYears.length - 1] : null;

  // Build baseline kBtu per calendar month for completeness checks
  const blKbtuPerMo = blKwhAvg.map((v, mi) => computeKBtu(v, blGasAvg[mi], blPropaneAvg[mi]));

  // Build a flat list of year-months with complete data, sorted chronologically.
  // A month is "complete" if its kBtu is at least 25% of the baseline average
  // for that calendar month — filters out straddling bills that barely touch a month.
  const allYms = [];
  for (const y of sortedYears) {
    const yd = yearData[y];
    for (let mi = 0; mi < 12; mi++) {
      if (yd.kwh[mi] > 0 || yd.gas[mi] > 0 || yd.propane[mi] > 0) {
        const moKbtu = computeKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
        const blRef = blKbtuPerMo[mi];
        if (blRef > 0 && moKbtu < blRef * 0.25) continue;
        allYms.push({ y, mi, kwh: yd.kwh[mi], gas: yd.gas[mi], propane: yd.propane[mi], cost: yd.cost[mi] });
      }
    }
  }
  allYms.sort((a, b) => a.y * 12 + a.mi - (b.y * 12 + b.mi));

  // Rolling 12-month EUI: last 12 complete months with actual data
  const r12 = allYms.slice(-12);
  let r12Kbtu = 0,
    r12Cost = 0;
  r12.forEach((m) => {
    r12Kbtu += computeKBtu(m.kwh, m.gas, m.propane || 0);
    r12Cost += m.cost;
  });
  const r12Eui = sqft > 0 && r12.length > 0 ? ((r12Kbtu / r12.length) * 12) / sqft : 0;
  const r12Label = r12.length + ' months';

  // Quarterly EUI: most recent complete quarter (3 consecutive months)
  let qEui = 0,
    qBlEui = 0,
    qLabel = '';
  const qNames = ['Q1', 'Q2', 'Q3', 'Q4'];
  const qMonthRanges = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [9, 10, 11],
  ];
  for (let yi = sortedYears.length - 1; yi >= 0 && qEui === 0; yi--) {
    const y = sortedYears[yi];
    const yd = yearData[y];
    for (let qi = 3; qi >= 0; qi--) {
      const ms = qMonthRanges[qi];
      const hasAll = ms.every((mi) => {
        if (yd.kwh[mi] <= 0 && yd.gas[mi] <= 0 && yd.propane[mi] <= 0) return false;
        const moKbtu = computeKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
        return blKbtuPerMo[mi] <= 0 || moKbtu >= blKbtuPerMo[mi] * 0.25;
      });
      if (hasAll) {
        let qKbtu = 0,
          qBlKbtu = 0;
        ms.forEach((mi) => {
          qKbtu += computeKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
          qBlKbtu += blKbtuPerMo[mi];
        });
        qEui = sqft > 0 ? ((qKbtu / 3) * 12) / sqft : 0;
        qBlEui = sqft > 0 && qBlKbtu > 0 ? ((qBlKbtu / 3) * 12) / sqft : 0;
        qLabel = qNames[qi] + ' ' + y;
        break;
      }
    }
  }

  // Monthly EUI: most recent single month with actual data
  const latestMo = allYms.length > 0 ? allYms[allYms.length - 1] : null;
  let moEui = 0,
    moBlEui = 0,
    moLabel = '';
  if (latestMo) {
    const moKbtu = computeKBtu(latestMo.kwh, latestMo.gas, latestMo.propane || 0);
    moEui = sqft > 0 ? (moKbtu * 12) / sqft : 0;
    moBlEui = sqft > 0 && blKbtuPerMo[latestMo.mi] > 0 ? (blKbtuPerMo[latestMo.mi] * 12) / sqft : 0;
    const moNamesFull = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    moLabel = moNamesFull[latestMo.mi] + ' ' + latestMo.y;
  }

  // Update EUI cards
  const blEl = document.getElementById(`egfx-blEui-${projId}`);
  const curEl = document.getElementById(`egfx-curEui-${projId}`);
  const curSubEl = document.getElementById(`egfx-curEuiSub-${projId}`);
  if (blEl) blEl.textContent = blEui > 0 ? blEui.toFixed(1) : 'No baseline data';
  if (blEl && blEui === 0) blEl.style.fontSize = '14px';
  if (curEl) curEl.textContent = r12Eui > 0 ? r12Eui.toFixed(1) : '—';
  if (curSubEl) curSubEl.textContent = r12Eui > 0 ? 'kBtu/ft² · ' + r12Label : 'kBtu/ft²';

  // Compute source EUI and estimated ENERGY STAR score from rolling 12-month data
  // r12 entries have raw site units: kwh (kWh), gas (therms), propane (gallons)
  const estarScoreEl = document.getElementById(`egfx-estarScore-${projId}`);
  const estarScoreSubEl = document.getElementById(`egfx-estarScoreSub-${projId}`);
  if (estarScoreEl && r12.length > 0 && sqft > 0) {
    // Sum raw site fuel for the rolling 12 months
    let r12Kwh = 0,
      r12Gas = 0,
      r12Prop = 0;
    r12.forEach((m) => {
      r12Kwh += m.kwh || 0;
      r12Gas += m.gas || 0;
      r12Prop += m.propane || 0;
    });
    // Annualize (same pattern as r12Eui): scale to 12 months
    const annFactor = 12 / r12.length;
    const annKwh = r12Kwh * annFactor;
    const annGas = r12Gas * annFactor;
    const annProp = r12Prop * annFactor;
    // computeSourceEUI lives in computations/eui.js (loaded before this file)
    const srcEui = typeof computeSourceEUI === 'function' ? computeSourceEUI(annKwh, annGas, annProp, sqft) : 0;
    const score = srcEui > 0 && typeof estimateEnergyStarScore === 'function' ? estimateEnergyStarScore(srcEui) : 0;
    if (score > 0) {
      estarScoreEl.textContent = '~' + score;
      // Color: green ≥75, yellow 50–74, red <50
      const scoreColor = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--danger)';
      estarScoreEl.style.color = scoreColor;
      if (estarScoreSubEl) {
        estarScoreSubEl.style.color = 'var(--text2)';
        estarScoreSubEl.innerHTML =
          'source Energy Use Intensity ' +
          srcEui.toFixed(0) +
          ' kBtu/ft²' +
          ' <span title="Based on source Energy Use Intensity vs CBECS K-12 data. Official score requires Portfolio Manager." style="cursor:help;color:var(--text3)">&#9432;</span>';
      }
    } else {
      estarScoreEl.textContent = '—';
      if (estarScoreSubEl) estarScoreSubEl.textContent = 'source Energy Use Intensity estimate';
    }
  }

  // Compute actual savings from meter performance (single source of truth)
  const blCostAvg = blCost.map((v, mi) => v / (blYmPerMo[mi].size || 1));
  const totalBlCost = blCostAvg.reduce((a, b) => a + b, 0);
  const curYear = String(new Date().getFullYear());
  const egfxSavByMo = {};
  const egfxSavByYm = {};
  const egfxSavByBldgYm = {}; // current savings by building and month, for billableSavingsWithPresented()
  const egfxSavByCommodity = { Electric: 0, Gas: 0, Propane: 0 };
  const egfxUnitsSaved = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
  const egfxCommByBldgYm = {}; // current-year cost saved by building, month, commodity
  const egfxUnitsByBldgYm = {}; // current-year units by building and month, for totalUnitsWithPresented()
  const egfxCostSavedByCommodity = { Electric: 0, Gas: 0, Propane: 0 };
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id)) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const mBills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const mIncl = m.inclusive !== false;
      const savResult = getMeterSavings(m, mBills, mIncl, projId, b.id);
      let meterCostSav = 0;
      Object.entries(savResult.byYM).forEach(([ym, v]) => {
        egfxSavByYm[ym] = (egfxSavByYm[ym] || 0) + v;
        const _bY = (egfxSavByBldgYm[b.id] = egfxSavByBldgYm[b.id] || {});
        _bY[ym] = (_bY[ym] || 0) + v;
        if (ym.startsWith(curYear)) {
          egfxSavByMo[ym] = (egfxSavByMo[ym] || 0) + v;
          meterCostSav += v;
        }
      });
      if (egfxCostSavedByCommodity[m.commodity] !== undefined) {
        egfxCostSavedByCommodity[m.commodity] += meterCostSav;
        // Same figure by building, month and commodity, for totalCommodityDollarsWithPresented().
        const _cK = m.commodity.toLowerCase();
        const _bC = (egfxCommByBldgYm[b.id] = egfxCommByBldgYm[b.id] || {});
        Object.entries(savResult.byYM).forEach(([ym, v]) => {
          if (!ym.startsWith(curYear)) return;
          const _c2 = (_bC[ym] = _bC[ym] || { electric: 0, gas: 0, propane: 0 });
          _c2[_cK] += v;
        });
      }
      Object.entries(savResult.unitsByYM).forEach(([ym, u]) => {
        if (!ym.startsWith(curYear)) return;
        const _bU = (egfxUnitsByBldgYm[b.id] = egfxUnitsByBldgYm[b.id] || {});
        const _c = (_bU[ym] = _bU[ym] || { kwh: 0, therms: 0, gallons: 0 });
        _c.kwh += u.kwh || 0;
        _c.therms += u.therms || 0;
        _c.gallons += u.gallons || 0;
        egfxUnitsSaved.kw += u.kw || 0; // kW is not a printed figure, stays current
      });
    });
  });
  // Unit totals: a period presented to the client uses the printed unit figures (the keeper).
  const _egfxU = totalUnitsWithPresented(
    projId,
    Array.from(new Set(Object.values(egfxUnitsByBldgYm).flatMap((bu) => Object.keys(bu)))).sort(),
    egfxUnitsByBldgYm,
  );
  egfxUnitsSaved.kwh = _egfxU.kwh;
  egfxUnitsSaved.therms = _egfxU.therms;
  egfxUnitsSaved.gallons = _egfxU.gallons;
  const _egfxC = totalCommodityDollarsWithPresented(
    projId,
    Array.from(new Set(Object.values(egfxCommByBldgYm).flatMap((bu) => Object.keys(bu)))).sort(),
    egfxCommByBldgYm,
  );
  egfxCostSavedByCommodity.Electric = _egfxC.electric;
  egfxCostSavedByCommodity.Gas = _egfxC.gas;
  egfxCostSavedByCommodity.Propane = _egfxC.propane;
  const hasEgfxSav = Object.keys(egfxSavByYm).some((ym) => ym.startsWith(curYear));
  // A period presented to the client uses the presented figure (computations/savings.js).
  const egfxWaitYms = hasEgfxSav
    ? weatherWaitingMonths(
        projId,
        Object.keys(egfxSavByYm)
          .filter((ym) => ym.startsWith(curYear))
          .sort(),
      )
    : [];
  const _egfxBill = hasEgfxSav
    ? billableSavingsWithPresented(
        projId,
        Object.keys(egfxSavByYm)
          .filter((ym) => ym.startsWith(curYear))
          .sort(),
        egfxSavByBldgYm,
      )
    : { total: 0, measured: 0 };
  const totalEgfxSav = _egfxBill.total;
  const totalEgfxMeas = _egfxBill.measured; // before the $0 floor

  // Unit savings (kwh, therms, gallons) are now accumulated from getMeterSavings
  // via savResult.unitsByYM filtered to current year — weather-normalized, not rolling-12

  // Projected Savings card — from measures only (buildings with all meters excluded are skipped)
  const projSavEl = document.getElementById(`egfx-projSav-${projId}`);
  const projSavSubEl = document.getElementById(`egfx-projSavSub-${projId}`);
  if (projSavEl) {
    let annProjSav = 0;
    let _egfxHasSrc = false;
    bldgs.forEach((b) => {
      const _bMeters = b.meters || [];
      if (_bMeters.length > 0 && _bMeters.every((m) => isBaselineExcluded(projId, m.id))) return;
      const msrSav = getBldgMeasureSavingsByMo(projId, b.id);
      if (msrSav) {
        _egfxHasSrc = true;
        annProjSav += msrSav.reduce((s, v) => s + v, 0);
      }
    });
    if (_egfxHasSrc && annProjSav > 0) {
      const avgSavPct = totalBlCost > 0 ? annProjSav / totalBlCost : 0;
      projSavEl.textContent = '$' + Math.round(annProjSav).toLocaleString();
      projSavEl.style.color = 'var(--accent)';
      if (projSavSubEl) projSavSubEl.textContent = (avgSavPct * 100).toFixed(1) + '% projected';
    } else {
      projSavEl.textContent = '—';
      projSavEl.style.fontSize = '14px';
      if (projSavSubEl) projSavSubEl.textContent = 'set savings % in Building Savings Projection';
    }
  }

  // Current Savings card — actual calculated savings to date
  const curSavEl = document.getElementById(`egfx-curSav-${projId}`);
  const curSavSubEl = document.getElementById(`egfx-curSavSub-${projId}`);
  if (curSavEl) {
    if (hasEgfxSav) {
      const pct = totalBlCost > 0 ? (totalEgfxSav / totalBlCost) * 100 : 0;
      const _curShown = savingsFlooredShown(totalEgfxMeas, totalEgfxSav, 0, (n) => '$' + Math.round(n).toLocaleString(), 'var(--green)', 'var(--danger)', 'var(--text)');
      const _pctShown = savingsFlooredShown(totalBlCost > 0 ? (totalEgfxMeas / totalBlCost) * 100 : 0, pct, 1, (n) => n.toFixed(1) + '%', 'var(--green)', 'var(--danger)', 'var(--text)');
      curSavEl.textContent = _curShown.text;
      curSavEl.style.color = _curShown.color;
      if (curSavSubEl) curSavSubEl.textContent = _pctShown.text + ' actual savings';
      if (curSavSubEl && egfxWaitYms.length)
        curSavSubEl.textContent += '. Does not include ' + weatherWaitingLabel(egfxWaitYms) + ': waiting for weather data';
    } else {
      curSavEl.textContent = '—';
      curSavEl.style.fontSize = '14px';
      if (curSavSubEl) curSavSubEl.textContent = 'no post-baseline data yet';
    }
  }

  // Per-commodity savings cards
  const commSavContainer = document.getElementById(`egfx-commodity-savings-${projId}`);
  if (commSavContainer) {
    const _$f = (v) => savingsSign(v, 0, true) + '$' + Math.abs(Math.round(v)).toLocaleString();
    const _$n = (v) => Math.round(Math.abs(v)).toLocaleString();
    const _clr = (v) => savingsSignColor(v, 0, 'var(--green)', 'var(--danger)', 'var(--text)');
    let cards = '';
    if (totalBlKwh > 0) {
      cards +=
        '<div class="card" style="padding:12px;text-align:center">' +
        '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">kWh Saved</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:var(--mono);color:' +
        _clr(egfxUnitsSaved.kwh) +
        ';margin:4px 0">' +
        _$n(egfxUnitsSaved.kwh) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text2)">' +
        _$f(egfxCostSavedByCommodity.Electric) +
        '</div></div>';
    }
    if (_blKwFromMap.some((v) => v > 0)) {
      cards +=
        '<div class="card" style="padding:12px;text-align:center">' +
        '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Peak kW Reduced</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:var(--mono);color:' +
        _clr(egfxUnitsSaved.kw) +
        ';margin:4px 0">' +
        _$n(egfxUnitsSaved.kw) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text2)">peak demand</div></div>';
    }
    if (totalBlGas > 0) {
      cards +=
        '<div class="card" style="padding:12px;text-align:center">' +
        '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Therms Saved</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:var(--mono);color:' +
        _clr(egfxUnitsSaved.therms) +
        ';margin:4px 0">' +
        _$n(egfxUnitsSaved.therms) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text2)">' +
        _$f(egfxCostSavedByCommodity.Gas) +
        '</div></div>';
    }
    if (totalBlPropane > 0) {
      cards +=
        '<div class="card" style="padding:12px;text-align:center">' +
        '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Gallons Saved</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:var(--mono);color:' +
        _clr(egfxUnitsSaved.gallons) +
        ';margin:4px 0">' +
        _$n(egfxUnitsSaved.gallons) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text2)">' +
        _$f(egfxCostSavedByCommodity.Propane) +
        '</div></div>';
    }
    commSavContainer.innerHTML = cards;
  }

  // Pollution Credit Calculator — uses per-commodity savings
  const kwhSaved = egfxUnitsSaved.kwh;
  const gasSaved = egfxUnitsSaved.therms;
  const propSaved = egfxUnitsSaved.gallons;
  {
    const _pcEl = document.getElementById(`egfx-pollcalc-content-${projId}`);
    if (_pcEl) {
      if (totalBlKwh > 0 || totalBlGas > 0 || totalBlPropane > 0) {
        // Extract 2-letter state code from project address (e.g. "Kansas City, KS 66101" → "KS")
        const _addrStr = p.addr || '';
        const _stateMatch = _addrStr.match(/\b([A-Z]{2})\b(?=\s*\d{5}|\s*$|,|\s*$)/);
        const _stateCode = (_stateMatch ? _stateMatch[1] : null) || 'KS';
        const _pc = calculatePollutionCredits(
          kwhSaved,
          gasSaved,
          propSaved,
          _stateCode,
        );
        const _pol = _pc.pollutants;
        const _eq = _pc.equivalents;
        const _fmt = (n) => Math.ceil(Math.abs(n)).toLocaleString();
        const _net = emissionsChangeText;
        _pcEl.innerHTML =
          '<div style="font-weight:800;font-size:14px;letter-spacing:.8px;margin-bottom:12px;color:var(--text)">CHANGE IN EMISSIONS COMPARED WITH BASELINE</div>' +
          '<div style="margin-bottom:14px;color:var(--text2)">' + EMISSIONS_SIGN_NOTE + '</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _net(_pol.co2) +
          '</strong> pounds of CO2 (carbon dioxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _net(_pol.ch4) +
          '</strong> pounds of CH4 (methane)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _net(_pol.n2o) +
          '</strong> pounds of N2O (nitrous oxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _net(_pol.so2) +
          '</strong> pounds of SO2 (sulfur dioxide)</div>' +
          '<div style="margin-bottom:18px"><strong>' +
          _net(_pol.nox) +
          '</strong> pounds of NOX (nitrogen oxide)</div>' +
          (_pc.co2eMT > 0
            ? '<div style="margin-bottom:14px;color:var(--text2)">The decrease in emissions is equivalent to:</div>' +
          '<div style="margin-bottom:4px">Removing <strong>' +
          _fmt(_eq.carsRemoved) +
          '</strong> ' + _rptPluralize(_eq.carsRemoved, 'car{s} from the road each year') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.gallonsGasoline) +
          '</strong> ' + _rptPluralize(_eq.gallonsGasoline, 'gallon{s} of gasoline each year') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.tankerTrucks) +
          '</strong> ' + _rptPluralize(_eq.tankerTrucks, 'tanker truck{s} of gasoline each year') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.barrelsOil) +
          '</strong> ' + _rptPluralize(_eq.barrelsOil, 'barrel{s} of oil each year') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.households) +
          '</strong> ' + _rptPluralize(_eq.households, 'household{s} worth of electricity each year') + '</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_eq.treeSeedlings) +
          '</strong> ' + _rptPluralize(_eq.treeSeedlings, 'tree seedling{s} allowed to grow for 10 years each year') + '</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_eq.acresForest) +
          '</strong> ' + _rptPluralize(_eq.acresForest, 'acre{s} of forest preserved from deforestation') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.railcarsCoal) +
          '</strong> ' + _rptPluralize(_eq.railcarsCoal, 'railcar{s} of coal each year') + '</div>' +
          '<div style="margin-bottom:4px">Recycling <strong>' +
          _fmt(_eq.tonsRecycled) +
          '</strong> ' + _rptPluralize(_eq.tonsRecycled, 'ton{s} of waste rather than landfilling each year') + '</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.propaneCylinders) +
          '</strong> ' + _rptPluralize(_eq.propaneCylinders, 'propane cylinder{s} used for home barbeques each year') + '</div>' +
          '<div style="margin-bottom:18px"><strong>' +
          _fmt(_eq.coalPlants) +
          '</strong> coal-fired power plant emissions each year</div>'
            : '') +
          '<div style="font-size:11px;color:var(--text3);line-height:1.6">' +
          'Source: ' +
          emissionsSourceLine(_stateCode) +
          '<br>' +
          'State: <strong>' +
          _stateCode +
          '</strong><br>' +
          energyUseChangeLine(kwhSaved, gasSaved, propSaved) +
          '</div>';
      } else {
        _pcEl.innerHTML =
          '<span style="color:var(--text3)">Add utility data and set a baseline to calculate pollution credits.</span>';
      }
    }
  }

  // Populate monthly/quarterly EUI detail row
  const _euiDelta = (cur, bl) => {
    if (!bl || bl <= 0) return '';
    const pct = ((cur - bl) / bl) * 100;
    const arrow = pct <= 0 ? '▼' : '▲';
    const color = pct <= 0 ? 'var(--green)' : 'var(--danger)';
    return (
      ' <span style="color:' +
      color +
      ';font-size:10px">' +
      arrow +
      Math.abs(pct).toFixed(1) +
      '% vs BL ' +
      bl.toFixed(1) +
      '</span>'
    );
  };
  const euiDetailEl = document.getElementById(`egfx-eui-detail-${projId}`);
  if (euiDetailEl) {
    const items = [];
    if (moEui > 0)
      items.push(
        '<span style="font-family:var(--mono);color:var(--text)"><strong>Monthly:</strong> ' +
          moEui.toFixed(1) +
          ' kBtu/ft²' +
          _euiDelta(moEui, moBlEui) +
          ' <span style="color:var(--text3)">(' +
          moLabel +
          ')</span></span>',
      );
    if (qEui > 0)
      items.push(
        '<span style="font-family:var(--mono);color:var(--text)"><strong>Quarterly:</strong> ' +
          qEui.toFixed(1) +
          ' kBtu/ft²' +
          _euiDelta(qEui, qBlEui) +
          ' <span style="color:var(--text3)">(' +
          qLabel +
          ')</span></span>',
      );
    if (r12Eui > 0 && r12.length >= 12)
      items.push(
        '<span style="font-family:var(--mono);color:var(--text)"><strong>12-Month:</strong> ' +
          r12Eui.toFixed(1) +
          ' kBtu/ft²' +
          _euiDelta(r12Eui, blEui) +
          ' <span style="color:var(--text3)">(' +
          r12Label +
          ')</span></span>',
      );
    else if (r12Eui > 0)
      items.push(
        '<span style="font-family:var(--mono);color:var(--text)"><strong>12-Month:</strong> ' +
          r12Eui.toFixed(1) +
          '* kBtu/ft²' +
          _euiDelta(r12Eui, blEui) +
          ' <span style="color:var(--text3)">(' +
          r12Label +
          ', annualized)</span></span>',
      );
    euiDetailEl.innerHTML = items.join('<span style="color:var(--text3)">|</span>');
  }

  const chartsEl = document.getElementById(`egfx-charts-${projId}`);
  const prePollCalcEl = document.getElementById(`egfx-pre-pollcalc-${projId}`);
  if (!chartsEl) return;
  if (totalBlKwh === 0 && totalBlGas === 0 && totalBlPropane === 0) {
    chartsEl.innerHTML =
      '<div style="font-size:13px;color:var(--text3);text-align:center;padding:40px">Add utility data to buildings and set a baseline to see energy graphics.</div>';
    return;
  }

  // Per-building rolling 12-month EUI (used by benchmark chart + table)
  const _bldgR12 = {};
  bldgs.forEach((b) => {
    const bSqft = parseInt(b.sqft || 0);
    if (bSqft <= 0) return;
    const byrs = bldgYearData[b.name];
    if (!byrs) return;
    // Build per-building baseline reference for each calendar month
    const bBlKbtu = new Array(12).fill(0);
    const bBlCount = new Array(12).fill(0);
    const maxBlYr = Math.max(...blYears);
    for (const blY of blYears) {
      const bd = byrs[blY];
      if (!bd) continue;
      for (let mi = 0; mi < 12; mi++) {
        if (bd.kwh[mi] > 0 || bd.gas[mi] > 0 || bd.propane[mi] > 0) {
          bBlKbtu[mi] += computeKBtu(bd.kwh[mi], bd.gas[mi], bd.propane[mi]);
          bBlCount[mi]++;
        }
      }
    }
    const bBlAvg = bBlKbtu.map((v, mi) => (bBlCount[mi] > 0 ? v / bBlCount[mi] : 0));
    const bYms = [];
    for (const y of sortedYears) {
      const bd = byrs[y];
      if (!bd) continue;
      for (let mi = 0; mi < 12; mi++) {
        if (bd.kwh[mi] > 0 || bd.gas[mi] > 0 || bd.propane[mi] > 0) {
          const moKbtu = computeKBtu(bd.kwh[mi], bd.gas[mi], bd.propane[mi]);
          if (bBlAvg[mi] > 0 && moKbtu < bBlAvg[mi] * 0.25) continue;
          bYms.push({ kwh: bd.kwh[mi], gas: bd.gas[mi], propane: bd.propane[mi], cost: bd.cost[mi] });
        }
      }
    }
    const last12 = bYms.slice(-12);
    if (last12.length === 0) return;
    let kbtu = 0,
      cost = 0,
      sumKwh = 0,
      sumGas = 0,
      sumPropane = 0;
    last12.forEach((m) => {
      kbtu += computeKBtu(m.kwh, m.gas, m.propane || 0);
      cost += m.cost;
      sumKwh += m.kwh || 0;
      sumGas += m.gas || 0;
      sumPropane += m.propane || 0;
    });
    const annF12 = 12 / last12.length;
    _bldgR12[b.name] = {
      eui: ((kbtu / last12.length) * 12) / bSqft,
      costSqft: ((cost / last12.length) * 12) / bSqft,
      months: last12.length,
      // Annualized site fuel totals (for source EUI / ENERGY STAR score)
      kwh: sumKwh * annF12,
      gas: sumGas * annF12,
      propane: sumPropane * annF12,
    };
  });

  // Commodity-consistent chart colors (Bug 987fa314, updated Bug 8e4322d1):
  // Each commodity always uses its designated hue. Within a chart, years are
  // distinguished by clearly different lightness shades (see _yrPalette below).
  // Electric = Blue, Gas = Orange, Propane = Amber/Yellow, Water/Sewer = Green.
  const _commodityBaseColor = {
    kwh: '#3b82f6', // Electric — Blue
    kw: '#3b82f6', // Electric demand — Blue
    gas: '#f97316', // Gas — Orange
    propane: '#f59e0b', // Propane — Amber/Yellow
    water: '#22c55e', // Water — Green
    cost: '#8b5cf6', // Cost fallback — Purple
  };
  // Per-year distinct color palettes so bars are clearly distinguishable within one commodity.
  // Each commodity gets its own set of 4 visually distinct shades, newest→oldest.
  const _yrPalette = {
    kwh: ['#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'], // Blues: light→dark
    kw: ['#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'],
    gas: ['#fed7aa', '#f97316', '#c2410c', '#7c2d12'], // Oranges: light→dark
    propane: ['#fde68a', '#f59e0b', '#b45309', '#78350f'], // Ambers: light→dark
    water: ['#86efac', '#22c55e', '#15803d', '#14532d'], // Greens: light→dark
    cost: ['#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'], // Purples: light→dark
  };
  // Baseline normalized line color — always purple for clear visual distinction
  const _blLineColor = 'rgba(168,85,247,0.9)';

  // Build year-over-year charts
  const maxBlYear2 = blYears.size > 0 ? Math.max(...blYears) : 0;
  const yrsToShow = p.showPreBaselineYears
    ? sortedYears.slice(-4)
    : sortedYears.filter((y) => y >= maxBlYear2).slice(-4);
  const _yoyChartsToDraw = [];
  let _yoyChartCount = 0;
  function _yoyHtml(title, icon, unit, field, blAvgArr) {
    const cid = `egfx-yoy-${projId}-${_yoyChartCount++}`;
    _yoyChartsToDraw.push({ cid, field, unit, blAvgArr });
    return `<div class="card" style="padding:14px;margin-bottom:12px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">${icon} Monthly ${title} — Year over Year</div>
            <div style="position:relative;height:160px"><canvas id="${cid}"></canvas></div>
          </div>`;
  }

  function _drawYoyChart(canvasId, field, unit, blAvgArr) {
    SharedCharts.renderYearOverYearChart(
      canvasId,
      {
        field: field,
        unit: unit,
        yearData: yearData,
        yrsToShow: yrsToShow,
        blYears: blYears,
        blYmPerMo: blYmPerMo,
        blAvgArr: blAvgArr,
      },
      { interactive: true },
    );
  }

  // Where the energy goes (HVAC End-Use Estimate) - one plain table per building. Numbers come from
  // resolveHvacLoadData(...).enduse = computeHvacEnduse (computations/hvac-enduse.js): the weather-independent
  // 3-lowest-month baseload split (matches the Excel "HVAC End-Use Estimate" deliverable). Totals are the sums of
  // the real baseline bills (totalGas, totalKwh) and the real highest monthly kW (peakKw); nothing is back-calculated.
  function _hvacEnduseCardsHtml() {
    if (typeof computeHvacEnduse !== 'function' || typeof resolveHvacLoadData !== 'function') return '';
    if (!bldgs.length) return '';
    const fmt = (v) => Math.round(v).toLocaleString('en-US');
    const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) + '%' : '—');
    const kw = (v) => _eaFmtKw(v);
    return bldgs
      .map((b) => {
        const name = b.name || 'Unknown';
        const r = resolveHvacLoadData(projId, b).enduse;
        if (!r.elecValid && !r.gasValid) return '';
        // one table cell: "Label: value unit (nn%)"; the hover shows the arithmetic
        const td = (label, value, unit, part, total, tip) =>
          `<td class="ea-l ea-wrap" title="${_escHtml(tip)}">${label}: <strong>${value} ${unit}</strong>${total != null ? ' (' + pct(part, total) + ')' : ''}</td>`;
        const share = (partTxt, totalTxt, part, total) => `${partTxt} ÷ ${totalTxt} = ${pct(part, total)}`;
        const rows = [];
        const reading = [];
        if (r.gasValid) {
          const base = fmt(r.baseloadGas);
          rows.push(
            `<tr><td class="ea-l">Gas (therms)</td>` +
              td('Heating', fmt(r.heatingTherms), 'therms', r.heatingTherms, r.totalGas, `Heating: ${share(fmt(r.heatingTherms), fmt(r.totalGas), r.heatingTherms, r.totalGas)}. Heating is the gas used above ${base} therms a month (the average of the 3 lowest months), added up over the months.`) +
              td('Year-round', fmt(r.yearRoundGas), 'therms', r.yearRoundGas, r.totalGas, `Year-round: ${share(fmt(r.yearRoundGas), fmt(r.totalGas), r.yearRoundGas, r.totalGas)}. Year-round is the gas used at or below ${base} therms a month, added up over the months.`) +
              td('Total', fmt(r.totalGas), 'therms', 0, null, `Total: the gas on the baseline bills added up. ${fmt(r.heatingTherms)} + ${fmt(r.yearRoundGas)} = ${fmt(r.totalGas)} therms.`) +
              `</tr>`,
          );
          reading.push(`${pct(r.heatingTherms, r.totalGas)} of gas goes to heating.`);
        }
        if (r.elecValid) {
          const base = fmt(r.baseloadElec);
          rows.push(
            `<tr><td class="ea-l">Electric (kWh)</td>` +
              td('Cooling', fmt(r.coolingKwh), 'kWh', r.coolingKwh, r.totalKwh, `Cooling: ${share(fmt(r.coolingKwh), fmt(r.totalKwh), r.coolingKwh, r.totalKwh)}. Cooling is the electricity used above ${base} kWh a month (the average of the 3 lowest months), added up over the months.`) +
              td('Year-round', fmt(r.yearRoundKwh), 'kWh', r.yearRoundKwh, r.totalKwh, `Year-round: ${share(fmt(r.yearRoundKwh), fmt(r.totalKwh), r.yearRoundKwh, r.totalKwh)}. Year-round is the electricity used at or below ${base} kWh a month, added up over the months.`) +
              td('Total', fmt(r.totalKwh), 'kWh', 0, null, `Total: the electricity on the baseline bills added up. ${fmt(r.coolingKwh)} + ${fmt(r.yearRoundKwh)} = ${fmt(r.totalKwh)} kWh.`) +
              `</tr>`,
          );
          reading.push(`${pct(r.coolingKwh, r.totalKwh)} of electricity goes to cooling.`);
        }
        if (r.demandValid) {
          rows.push(
            `<tr><td class="ea-l">Peak demand (kW)</td>` +
              td('Cooling', kw(r.coolingDemandKw), 'kW', r.coolingDemandKw, r.peakKw, `Cooling: ${share(kw(r.coolingDemandKw), kw(r.peakKw), r.coolingDemandKw, r.peakKw)}. Cooling kW is the summer peak ${kw(r.peakKw)} kW minus the winter level ${kw(r.winterDemandBase)} kW.`) +
              td('Winter', kw(r.winterDemandBase), 'kW', r.winterDemandBase, r.peakKw, `Winter: ${share(kw(r.winterDemandBase), kw(r.peakKw), r.winterDemandBase, r.peakKw)}. The winter level is the average of the billed kW in December, January and February.`) +
              td('Summer peak', kw(r.peakKw), 'kW', 0, null, `Summer peak: the highest monthly billed kW of the year. ${kw(r.coolingDemandKw)} + ${kw(r.winterDemandBase)} = ${kw(r.peakKw)} kW.`) +
              `</tr>`,
          );
          reading.push(`Cooling adds ${kw(r.coolingDemandKw)} kW to the summer peak.`);
        }
        return `<div class="card" style="padding:14px;margin-bottom:12px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">🌡️ Where the energy goes — ${_escHtml(name)}</div>
            <div style="font-size:12px;color:var(--text);margin-bottom:10px">${_escHtml(reading.join(' '))}</div>
            <div class="ea-tbl-outer"><table class="ea-tbl">
              <thead><tr><th class="ea-l" style="cursor:default"></th><th class="ea-l" title="The part of the use that comes and goes with the weather: gas for heating, electricity for cooling.">Heating / Cooling</th><th class="ea-l" title="The part used in every month of the year, taken as the average of the 3 lowest months.">Year-round</th><th class="ea-l" title="The real total from the baseline bills.">Total</th></tr></thead>
              <tbody>${rows.join('')}</tbody>
            </table></div>
            <div style="font-size:10px;color:var(--text3);margin-top:8px">Year-round is the average of the 3 lowest months, used for all 12 months. Heating and cooling are the use above it. Estimated from the baseline bills. Hover over a figure to see its arithmetic.</div>
          </div>`;
      })
      .filter(Boolean)
      .join('');
  }

  const hasGas = totalBlGas > 0 || sortedYears.some((y) => yearData[y].gas.some((g) => g > 0));
  const hasPropane = totalBlPropane > 0 || sortedYears.some((y) => yearData[y].propane.some((g) => g > 0));

  // Compute normalized propane baseline (HDD-weighted monthly consumption, not raw deliveries)
  // Fix (a75cb5c1): Run normalization on the FULL bill history first, then derive the
  // baseline average from the normalized output. The old code filtered bills to baseline
  // months BEFORE normalization, which discarded summer months that normalizePropaneDeliveries
  // correctly spreads deliveries into. Now we normalize all bills, then average only the
  // baseline-period months to get the per-calendar-month baseline value.
  const blPropaneNorm = new Array(12).fill(0);
  if (hasPropane) {
    bldgs.forEach((b) => {
      (b.meters || []).forEach((m) => {
        if (m.commodity !== 'Propane' || isBaselineExcluded(projId, m.id)) return;
        const bl = m.baseline;
        if (!bl || !bl.months || bl.months.length < 3) return;
        const mBills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
        const bWeatherByYm =
          typeof getWeatherForBuilding === 'function' ? getWeatherForBuilding(projId, b.id).byYm || null : null;
        // Normalize ALL bills (full history) so summer months get their HDD-weighted share
        const allRows = mBills.length ? getNormRows(m, mBills, m.inclusive !== false, bWeatherByYm) : [];
        // Determine how many baseline years contributed to each calendar month
        // so we can average across years (same logic as buildMoMap)
        const moAccum = {}; // {mo: [usage, ...]}
        const meterBlYears = new Set(bl.months.map((bym) => bym.slice(0, 4)));
        allRows.forEach((r) => {
          const mo = parseInt(r.ym.split('-')[1]) - 1;
          const yr = r.ym.slice(0, 4);
          // Include this row in the baseline average if any baseline YM in the same
          // calendar month (same month number, any baseline year) exists
          const sameCalMoInBl = bl.months.some((bym) => parseInt(bym.slice(5, 7)) - 1 === mo);
          if (!sameCalMoInBl) return;
          // Only include years that are actually in the baseline
          if (!meterBlYears.has(yr)) return;
          if (!moAccum[mo]) moAccum[mo] = [];
          moAccum[mo].push(r.usage);
        });
        Object.entries(moAccum).forEach(([mo, usages]) => {
          const avg = usages.reduce((s, v) => s + v, 0) / usages.length;
          blPropaneNorm[parseInt(mo)] += avg;
        });
      });
    });
  }
  const blPropaneBl = blPropaneNorm.some((v) => v > 0) ? blPropaneNorm : blPropaneAvg;

  // Bill months newer than the newest stored weather month: same plain text as the Utility Data Normalized tab
  // (wxPendingMonths / wxPendingNotice, computations/weather-refresh.js - the one rule).
  const _wxPendingYms = new Set();
  bldgs.forEach((b) => {
    const wx = getWeatherForBuilding(projId, b.id);
    if (!wx.cache.length) return;
    const yms = [];
    (b.meters || []).forEach((m) => {
      if (isBaselineExcluded(projId, m.id)) return;
      (m.bills || []).forEach((bill) => yms.push(billMonth(bill, m.bills)));
    });
    wxPendingMonths(wx.cache, yms.filter((ym) => /^\d{4}-\d{2}$/.test(ym))).forEach((ym) => _wxPendingYms.add(ym));
  });
  const _wxPendingTxt = wxPendingNotice(Array.from(_wxPendingYms).sort(), (ym) => fmtMon(ym + '-01'));
  const _wxPendingHtml = _wxPendingTxt
    ? '<div style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:12px;color:var(--text)">' +
      _escHtml(_wxPendingTxt) +
      '.</div>'
    : '';

  chartsEl.innerHTML = `
          ${_wxPendingHtml}
          ${_EGFX_TBL_CSS}
          ${_yoyHtml('Electric kWh', '⚡', 'kWh', 'kwh', blKwhAvg)}
          ${totalBlKwh > 0 ? _yoyHtml('Electric kW', '⚡', 'kW', 'kw', _blKwFromMap) : ''}
          ${_egfxEaCardHtml(projId)}
          ${hasGas ? _yoyHtml('Gas Therms', '🔥', 'therms', 'gas', blGasAvg) : ''}
          ${hasPropane ? _yoyHtml('Propane Gallons', '🛢️', 'gal', 'propane', blPropaneBl) : ''}
          ${_hvacEnduseCardsHtml()}
          <div class="card" style="padding:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">📊 Annual Summary by Year</div>
            <div style="overflow-x:auto">
              <table class="dtbl" data-egfx-export="annual" style="min-width:500px">
                <thead><tr><th>Year</th><th style="text-align:right">kWh</th><th style="text-align:right">kW</th><th style="text-align:right">Gas Therms</th>${hasPropane ? '<th style="text-align:right">Propane Gal</th>' : ''}<th style="text-align:right">Site Energy Use Intensity kBtu/ft²</th><th style="text-align:right">Baseline Site Energy Use Intensity</th><th style="text-align:right">vs Baseline</th></tr></thead>
                <tbody>
                  ${yrsToShow
                    .map((y) => {
                      const yd = yearData[y];
                      const ykwhRaw = yd.kwh.reduce((a, b) => a + b, 0);
                      const ygasRaw = yd.gas.reduce((a, b) => a + b, 0);
                      const ypropaneRaw = yd.propane.reduce((a, b) => a + b, 0);
                      const ykw = Math.max(...yd.kw);
                      let moCount = 0;
                      for (let mi = 0; mi < 12; mi++) {
                        if (yd.kwh[mi] > 0 || yd.gas[mi] > 0 || yd.propane[mi] > 0) {
                          const mk = computeKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
                          if (blKbtuPerMo[mi] <= 0 || mk >= blKbtuPerMo[mi] * 0.25) moCount++;
                        }
                      }
                      const isPartial = moCount > 0 && moCount < 12;
                      const annF = isPartial ? 12 / moCount : 1;
                      const ykwh = ykwhRaw * annF;
                      const ygas = ygasRaw * annF;
                      const ypropane = ypropaneRaw * annF;
                      const ykbtu = computeKBtu(ykwh, ygas, ypropane);
                      const yeui = sqft > 0 && moCount > 0 ? ykbtu / sqft : 0;
                      const diff = blEui > 0 ? ((yeui - blEui) / blEui) * 100 : 0;
                      const isBl = blYears.has(y);
                      const projLabel = isPartial
                        ? ' <span style="font-size:9px;color:var(--text3)">(' + moCount + ' mo, annualized)</span>'
                        : '';
                      return `<tr${isBl ? ' style="background:rgba(59,130,246,0.05)"' : ''}>
                      <td style="font-weight:600">${y}${isBl ? ' <span style="font-size:10px;color:var(--accent)">(BL)</span>' : ''}${projLabel}</td>
                      <td style="text-align:right;font-family:var(--mono)">${Math.round(ykwh).toLocaleString()}${isPartial ? '*' : ''}</td>
                      <td style="text-align:right;font-family:var(--mono)">${ykw.toFixed(1)}</td>
                      <td style="text-align:right;font-family:var(--mono)">${Math.round(ygas).toLocaleString()}${isPartial ? '*' : ''}</td>
                      ${hasPropane ? '<td style="text-align:right;font-family:var(--mono)">' + Math.round(ypropane).toLocaleString() + (isPartial ? '*' : '') + '</td>' : ''}
                      <td style="text-align:right;font-family:var(--mono)">${yeui.toFixed(1)}${isPartial ? '*' : ''}</td>
                      <td style="text-align:right;font-family:var(--mono);color:var(--accent)">${blEui > 0 ? blEui.toFixed(1) : '—'}</td>
                      <td style="text-align:right;font-family:var(--mono);color:${diff < 0 ? 'var(--green)' : diff > 0 ? 'var(--red)' : 'var(--text2)'}">${isBl ? '—' : (diff > 0 ? '+' : '') + diff.toFixed(1) + '%'}</td>
                    </tr>`;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
          ${
            bldgs.length > 1
              ? `
          <div class="card" style="padding:14px;margin-top:12px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">🏢 Annual Summary by Building</div>
            <div style="overflow-x:auto">
              <table class="dtbl" style="min-width:600px;border-collapse:collapse">
                <thead><tr style="background:var(--s1)"><th style="text-align:left;padding:8px 10px">Building</th><th style="padding:8px 6px">Year</th><th style="text-align:right;padding:8px 10px">kWh</th><th style="text-align:right;padding:8px 10px">kW</th><th style="text-align:right;padding:8px 10px">Gas Therms</th>${hasPropane ? '<th style="text-align:right;padding:8px 10px">Propane Gal</th>' : ''}<th style="text-align:right;padding:8px 10px">Cost</th><th style="text-align:right;padding:8px 10px">Site Energy Use Intensity</th></tr></thead>
                <tbody>
                  ${(() => {
                    let rowIdx = 0;
                    return Object.entries(bldgYearData)
                      .map(([bName, byrs]) => {
                        const bObj = bldgs.find((bb) => bb.name === bName);
                        const bSqft = (bObj && parseInt(bObj.sqft)) || 0;
                        const rows = yrsToShow
                          .map((y) => {
                            const bd = byrs[y];
                            if (!bd) return null;
                            const bkwhRaw = bd.kwh.reduce((a, v) => a + v, 0);
                            const bgasRaw = bd.gas.reduce((a, v) => a + v, 0);
                            const bpropaneRaw = bd.propane.reduce((a, v) => a + v, 0);
                            if (bkwhRaw === 0 && bgasRaw === 0 && bpropaneRaw === 0) return null;
                            const bkw = Math.max(...bd.kw);
                            const bcostRaw = bd.cost.reduce((a, v) => a + v, 0);
                            let moCount = 0;
                            for (let mi = 0; mi < 12; mi++) {
                              if (bd.kwh[mi] > 0 || bd.gas[mi] > 0 || bd.propane[mi] > 0) moCount++;
                            }
                            const bPartial = moCount > 0 && moCount < 12;
                            const bAnnF = bPartial ? 12 / moCount : 1;
                            const bkwh = bkwhRaw * bAnnF;
                            const bgas = bgasRaw * bAnnF;
                            const bpropane = bpropaneRaw * bAnnF;
                            const bcost = bcostRaw * bAnnF;
                            const bkbtu = computeKBtu(bkwh, bgas, bpropane);
                            const beui = bSqft > 0 && moCount > 0 ? bkbtu / bSqft : 0;
                            return { y, bkwh, bkw, bgas, bpropane, bcost, beui, moCount, bPartial };
                          })
                          .filter(Boolean);
                        if (!rows.length) return '';
                        return rows
                          .map((r, i) => {
                            const isFirst = i === 0;
                            const bg = rowIdx++ % 2 === 0 ? 'transparent' : 'var(--s2)';
                            const borderTop = isFirst ? 'border-top:2px solid var(--border2)' : '';
                            const tdS =
                              'padding:6px 10px;font-family:var(--mono);font-size:11px;text-align:right;' + borderTop;
                            return (
                              '<tr style="background:' +
                              bg +
                              '">' +
                              (isFirst
                                ? '<td rowspan="' +
                                  rows.length +
                                  '" style="font-weight:600;padding:6px 10px;vertical-align:top;' +
                                  borderTop +
                                  '">' +
                                  bName +
                                  (bSqft > 0
                                    ? '<div style="font-size:9px;color:var(--text3);font-weight:400">' +
                                      bSqft.toLocaleString() +
                                      ' ft²</div>'
                                    : '') +
                                  '</td>'
                                : '') +
                              '<td style="padding:6px 6px;font-size:11px;' +
                              borderTop +
                              '">' +
                              r.y +
                              (r.bPartial
                                ? ' <span style="font-size:8px;color:var(--text3)">(' + r.moCount + 'mo)</span>'
                                : '') +
                              '</td>' +
                              '<td style="' +
                              tdS +
                              '">' +
                              Math.round(r.bkwh).toLocaleString() +
                              (r.bPartial ? '*' : '') +
                              '</td>' +
                              '<td style="' +
                              tdS +
                              '">' +
                              r.bkw.toFixed(1) +
                              '</td>' +
                              '<td style="' +
                              tdS +
                              '">' +
                              Math.round(r.bgas).toLocaleString() +
                              (r.bPartial ? '*' : '') +
                              '</td>' +
                              (hasPropane
                                ? '<td style="' +
                                  tdS +
                                  '">' +
                                  Math.round(r.bpropane).toLocaleString() +
                                  (r.bPartial ? '*' : '') +
                                  '</td>'
                                : '') +
                              '<td style="' +
                              tdS +
                              '">$' +
                              Math.round(r.bcost).toLocaleString() +
                              (r.bPartial ? '*' : '') +
                              '</td>' +
                              '<td style="' +
                              tdS +
                              '">' +
                              (r.beui > 0 ? r.beui.toFixed(1) + (r.bPartial ? '*' : '') : '—') +
                              '</td></tr>'
                            );
                          })
                          .join('');
                      })
                      .join('');
                  })()}
                </tbody>
              </table>
            </div>
          </div>`
              : ''
          }
          ${(() => {
            if (blEui === 0) return '';
            const blYearList = [...blYears].sort();
            const _monthNamesFull = [
              'January',
              'February',
              'March',
              'April',
              'May',
              'June',
              'July',
              'August',
              'September',
              'October',
              'November',
              'December',
            ];
            const _fmtYm = (ym) => _monthNamesFull[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + ym.slice(0, 4);
            const blYmSorted = [...blYmAll].sort();
            const blPeriod = blYmSorted.length
              ? blYmSorted.length === 1
                ? _fmtYm(blYmSorted[0])
                : _fmtYm(blYmSorted[0]) + ' – ' + _fmtYm(blYmSorted[blYmSorted.length - 1])
              : blYearList.length === 1
                ? String(blYearList[0])
                : blYearList[0] + '–' + blYearList[blYearList.length - 1];
            const hasPropaneBL = totalBlPropane > 0;
            const blCostAvg2 = blCost.map((v, mi) => v / (blYmPerMo[mi].size || 1));
            let tbl = '<div class="card" style="padding:14px;margin-top:12px">';
            tbl +=
              '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">📋 Baseline Monthly Data — Project Level</div>';
            tbl +=
              '<div style="font-size:10px;color:var(--text3);margin-bottom:10px">Averaged monthly values for baseline period: ' +
              blPeriod +
              '</div>';
            tbl += '<div style="overflow-x:auto"><table class="dtbl" style="min-width:500px">';
            tbl += '<thead><tr><th>Month</th>';
            if (totalBlKwh > 0) tbl += '<th style="text-align:right">kWh</th>';
            tbl += '<th style="text-align:right">kW</th>';
            if (totalBlGas > 0) tbl += '<th style="text-align:right">Therms</th>';
            if (hasPropaneBL) tbl += '<th style="text-align:right">Propane Gal</th>';
            tbl += '<th style="text-align:right">kBtu</th><th style="text-align:right">Cost</th></tr></thead><tbody>';
            let totKwh = 0,
              totKw = 0,
              totGas = 0,
              totProp = 0,
              totKbtu = 0,
              totCost = 0;
            for (let mi = 0; mi < 12; mi++) {
              const mkbtu = computeKBtu(blKwhAvg[mi], blGasAvg[mi], blPropaneAvg[mi]);
              const mcost = blCostAvg2[mi];
              const mkw = _blKwFromMap[mi];
              totKwh += blKwhAvg[mi];
              totKw = Math.max(totKw, mkw);
              totGas += blGasAvg[mi];
              totProp += blPropaneAvg[mi];
              totKbtu += mkbtu;
              totCost += mcost;
              tbl += '<tr><td>' + months[mi] + '</td>';
              if (totalBlKwh > 0)
                tbl +=
                  '<td style="text-align:right;font-family:var(--mono)">' +
                  Math.round(blKwhAvg[mi]).toLocaleString() +
                  '</td>';
              tbl += '<td style="text-align:right;font-family:var(--mono)">' + mkw.toFixed(1) + '</td>';
              if (totalBlGas > 0)
                tbl +=
                  '<td style="text-align:right;font-family:var(--mono)">' +
                  Math.round(blGasAvg[mi]).toLocaleString() +
                  '</td>';
              if (hasPropaneBL)
                tbl +=
                  '<td style="text-align:right;font-family:var(--mono)">' +
                  Math.round(blPropaneAvg[mi]).toLocaleString() +
                  '</td>';
              tbl +=
                '<td style="text-align:right;font-family:var(--mono)">' + Math.round(mkbtu).toLocaleString() + '</td>';
              tbl +=
                '<td style="text-align:right;font-family:var(--mono)">$' +
                Math.round(mcost).toLocaleString() +
                '</td></tr>';
            }
            tbl += '<tr style="font-weight:700;border-top:2px solid var(--border2)"><td>Total</td>';
            if (totalBlKwh > 0)
              tbl +=
                '<td style="text-align:right;font-family:var(--mono)">' + Math.round(totKwh).toLocaleString() + '</td>';
            tbl += '<td style="text-align:right;font-family:var(--mono)">' + totKw.toFixed(1) + '</td>';
            if (totalBlGas > 0)
              tbl +=
                '<td style="text-align:right;font-family:var(--mono)">' + Math.round(totGas).toLocaleString() + '</td>';
            if (hasPropaneBL)
              tbl +=
                '<td style="text-align:right;font-family:var(--mono)">' +
                Math.round(totProp).toLocaleString() +
                '</td>';
            tbl +=
              '<td style="text-align:right;font-family:var(--mono)">' + Math.round(totKbtu).toLocaleString() + '</td>';
            tbl +=
              '<td style="text-align:right;font-family:var(--mono)">$' +
              Math.round(totCost).toLocaleString() +
              '</td></tr>';
            tbl += '</tbody></table></div></div>';
            return tbl;
          })()}
          ${(() => {
            if (blEui === 0 || bldgs.length <= 1) return '';
            return (
              '<div style="margin-top:12px">' +
              bldgs
                .map((b) => _buildBaselineDataHtml(b, projId))
                .filter(Boolean)
                .join('') +
              '</div>'
            );
          })()}`;

  if (prePollCalcEl) {
    prePollCalcEl.innerHTML = `${(() => {
      // CBECS Benchmark Comparison Chart — canvas via SharedCharts
      if (bldgs.length === 0 || !latestYear) return '';
      const benchRows = bldgs
        .map((b) => {
          const bSqft = parseInt(b.sqft || 0);
          if (bSqft <= 0) return null;
          const bR12 = _bldgR12[b.name];
          if (!bR12 || bR12.eui <= 0) return null;
          const beui = bR12.eui;
          const bType = b.type || p.type || 'K-12 School';
          const cbVal = CBECS_EUI[bType] || CBECS_EUI['Other'] || 52.4;
          // Compute baseline EUI for this building
          let bBlEui = 0;
          let totalBlKbtu = 0,
            totalBlMoCount = 0;
          for (const blY of blYears) {
            const bd = bldgYearData[b.name]?.[blY];
            if (!bd) continue;
            const bkwh = bd.kwh.reduce((a, v) => a + v, 0);
            const bgas = bd.gas.reduce((a, v) => a + v, 0);
            const bprop = bd.propane ? bd.propane.reduce((a, v) => a + v, 0) : 0;
            if (bkwh > 0 || bgas > 0 || bprop > 0) {
              totalBlKbtu += computeKBtu(bkwh, bgas, bprop);
              for (let mi = 0; mi < 12; mi++) {
                if (bd.kwh[mi] > 0 || bd.gas[mi] > 0 || (bd.propane && bd.propane[mi] > 0)) totalBlMoCount++;
              }
            }
          }
          if (totalBlMoCount > 0) bBlEui = ((totalBlKbtu / totalBlMoCount) * 12) / bSqft;
          return { name: b.name, eui: beui, blEui: bBlEui, cbecs: cbVal, type: bType };
        })
        .filter(Boolean);
      if (benchRows.length === 0) return '';
      const benchCanvasId = 'egfx-euiBench-' + projId;
      _yoyChartsToDraw.push({ cid: benchCanvasId, _benchRows: benchRows });
      const chartH = Math.max(120, benchRows.length * 40 + 40);
      return `<div class="card" style="padding:14px;margin-top:12px">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">📊 <span title="Site Energy Use Intensity: yearly energy use per square foot, in kBtu">Site EUI</span> Benchmark — Your Buildings vs <span title="Commercial Buildings Energy Consumption Survey">CBECS</span> National Median</div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:8px">kBtu/ft²/yr · rolling 12-month data · buildings without sqft are excluded</div>
              <div style="position:relative;height:${chartH}px"><canvas id="${benchCanvasId}"></canvas></div>
            </div>`;
    })()}${(() => {
      // Multi-Year Usage Trend — Talisen FAC workbook data (b.annualBenchmarks, added via
      // importAnnualBenchmarksJSON). Absent for any project that hasn't imported that data —
      // the section returns '' and existing Energy Graphics rendering is unaffected.
      const trendBldgs = bldgs.filter((b) => Array.isArray(b.annualBenchmarks) && b.annualBenchmarks.length > 0);
      if (trendBldgs.length === 0) return '';
      let minYr = Infinity,
        maxYr = -Infinity;
      trendBldgs.forEach((b) =>
        b.annualBenchmarks.forEach((y) => {
          if (y.year < minYr) minYr = y.year;
          if (y.year > maxYr) maxYr = y.year;
        }),
      );
      const trendCanvasId = 'egfx-trend-' + projId;
      return `<div class="card" style="padding:14px;margin-top:12px">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
                <div style="font-size:12px;font-weight:700;color:var(--text2)">📈 Multi-Year Usage Trend — ${minYr}–${maxYr}</div>
                <div style="display:flex;gap:6px;align-items:center">
                  <select id="egfx-trend-metric-${projId}" onchange="egfxRedrawTrendChart(${projId})" style="font-size:11px;padding:4px 6px;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px">
                    <option value="kwh">Electric (kWh)</option>
                    <option value="therms">Gas (Therms)</option>
                    <option value="cost">Total Cost ($)</option>
                    <option value="eui" title="Site Energy Use Intensity: yearly energy use per square foot, in kBtu">Site EUI (kBtu/ft²/Year)</option>
                  </select>
                  <select id="egfx-trend-mode-${projId}" onchange="egfxRedrawTrendChart(${projId})" style="font-size:11px;padding:4px 6px;background:var(--s2);color:var(--text);border:1px solid var(--border);border-radius:4px">
                    <option value="perBldg">Per Building</option>
                    <option value="total">Portfolio Total</option>
                  </select>
                </div>
              </div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:8px">Source: Talisen FAC workbook · annual whole-building metering · a gap in a building's line means the building did not exist yet or was not yet tracked that year — not zero usage</div>
              <div style="position:relative;height:220px"><canvas id="${trendCanvasId}"></canvas></div>
            </div>`;
    })()}${(() => {
      // Property & Age strip — Talisen FAC workbook yearBuilt + ENERGY STAR benchmark, per
      // building. Teal left-border + explicit "Source" line keeps this visually distinct from
      // the green/red live CBECS EUI Benchmark chart above so the two methods (site-metered
      // rolling-12-month vs Talisen's own annual workbook figures) are never conflated.
      const ageBldgs = bldgs.filter(
        (b) => b.yearBuilt || (Array.isArray(b.annualBenchmarks) && b.annualBenchmarks.length),
      );
      if (ageBldgs.length === 0) return '';
      const curYr = new Date().getFullYear();
      const rows = ageBldgs.map((b) => {
        const latest =
          Array.isArray(b.annualBenchmarks) && b.annualBenchmarks.length
            ? b.annualBenchmarks.slice().sort((a, c) => a.year - c.year)[b.annualBenchmarks.length - 1]
            : null;
        const age = b.yearBuilt ? curYr - b.yearBuilt : null;
        return { name: b.name, yearBuilt: b.yearBuilt, age, latest };
      });
      return `<div class="card" style="padding:14px;margin-top:12px;border-left:3px solid var(--teal)">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">🏛️ Property &amp; Age</div>
              <div style="font-size:10px;color:var(--teal);font-weight:700;margin-bottom:8px">Source: Talisen FAC workbook — separate from the site's live CBECS Energy Use Intensity Benchmark above</div>
              <div style="overflow-x:auto">
                <table class="dtbl" style="min-width:760px">
                  <thead><tr>
                    <th style="text-align:left">Building</th>
                    <th style="text-align:right">Year Built</th>
                    <th style="text-align:right">Age</th>
                    <th style="text-align:left">ENERGY STAR Property Type</th>
                    <th style="text-align:right">Latest Year</th>
                    <th style="text-align:right">Median Energy Use Intensity</th>
                    <th style="text-align:right">Top 25% Energy Use Intensity</th>
                    <th style="text-align:right">DOE Target Energy Use Intensity</th>
                    <th style="text-align:right">vs Median</th>
                  </tr></thead>
                  <tbody>
                    ${rows
                      .map(
                        (r) => `<tr>
                        <td style="font-weight:600;white-space:nowrap">${r.name}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.yearBuilt || '—'}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.age != null ? r.age + ' yrs' : '—'}</td>
                        <td style="font-size:11px;color:var(--text2)">${r.latest ? r.latest.estarPropertyType || '—' : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.latest ? r.latest.year : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.latest && r.latest.benchmarkMedianEui != null ? r.latest.benchmarkMedianEui.toFixed(1) : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.latest && r.latest.benchmarkTop25Eui != null ? r.latest.benchmarkTop25Eui.toFixed(1) : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.latest && r.latest.doeTargetEui != null ? r.latest.doeTargetEui.toFixed(1) : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono);color:${r.latest && r.latest.pctVsMedian != null ? (r.latest.pctVsMedian < 0 ? 'var(--green)' : 'var(--danger)') : 'var(--text3)'}">${r.latest && r.latest.pctVsMedian != null ? (r.latest.pctVsMedian > 0 ? '+' : '') + (r.latest.pctVsMedian * 100).toFixed(1) + '%' : '—'}</td>
                      </tr>`,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            </div>`;
    })()}${(() => {
      // Energy Plan — read-only text panel. Field relocation (2026-09-24): energyPlan now
      // lives on the project record (project.energyPlan), not the shared customer blob —
      // it's a per-project setting, not a customer/building fact (Talisen source).
      const _egProj = (typeof projects !== 'undefined' ? projects : sget('en_projects', [])).find(
        (p) => p.id === projId,
      );
      const plan = _egProj ? _egProj.energyPlan : null;
      if (!plan || !plan.text) return '';
      return `<div class="card" style="padding:14px;margin-top:12px;border-left:3px solid var(--teal)">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">📋 Energy Management Plan</div>
              <div style="font-size:10px;color:var(--teal);font-weight:700;margin-bottom:8px">Source: ${_escHtml(plan.source || 'Talisen FAC workbook')}</div>
              <div style="font-size:11px;color:var(--text2);white-space:pre-wrap;line-height:1.5;font-family:var(--mono)">${_escHtml(plan.text)}</div>
            </div>`;
    })()}${(() => {
      // Building Performance Benchmarking — comprehensive comparison table
      if (bldgs.length === 0 || !latestYear) return '';
      const bRows = bldgs
        .map((b) => {
          const bSqft = parseInt(b.sqft || 0);
          if (bSqft <= 0) return null;
          const bType = b.type || p.type || 'K-12 School';
          const cbecs = CBECS_EUI[bType] || CBECS_EUI['Other'] || 52.4;
          const estar = ESTAR_EUI[bType] || null;
          const pctiles = CBECS_PERCENTILES[bType] || CBECS_PERCENTILES['Other'];
          const bR12 = _bldgR12[b.name];
          if (!bR12 || bR12.eui <= 0) return null;
          const latestEui = bR12.eui;
          const latestCostSqft = bR12.costSqft;
          // Compute baseline EUI for this building (average across all baseline years)
          let bBlEui = 0;
          let totalBlKbtu = 0,
            totalBlMoCount = 0;
          for (const blY of blYears) {
            const bd = bldgYearData[b.name]?.[blY];
            if (!bd) continue;
            const bkwh = bd.kwh.reduce((a, v) => a + v, 0);
            const bgas = bd.gas.reduce((a, v) => a + v, 0);
            const bprop = bd.propane ? bd.propane.reduce((a, v) => a + v, 0) : 0;
            if (bkwh > 0 || bgas > 0 || bprop > 0) {
              totalBlKbtu += computeKBtu(bkwh, bgas, bprop);
              for (let mi = 0; mi < 12; mi++) {
                if (bd.kwh[mi] > 0 || bd.gas[mi] > 0 || (bd.propane && bd.propane[mi] > 0)) totalBlMoCount++;
              }
            }
          }
          if (totalBlMoCount > 0) bBlEui = ((totalBlKbtu / totalBlMoCount) * 12) / bSqft;
          // Percentile estimate: where does the building fall?
          let pctileLabel = '';
          if (pctiles) {
            if (latestEui <= pctiles[0]) pctileLabel = 'Top 25%';
            else if (latestEui <= pctiles[1]) pctileLabel = '25th–50th';
            else if (latestEui <= pctiles[2]) pctileLabel = '50th–75th';
            else pctileLabel = 'Bottom 25%';
          }
          const estarStatus = estar ? (latestEui <= estar ? '✓ Eligible' : '✗ Above') : '—';
          const estarColor = estar ? (latestEui <= estar ? 'var(--green)' : 'var(--text3)') : 'var(--text3)';
          // Compute per-building source EUI and estimated ENERGY STAR score
          // Use rolling 12-month raw fuel from _bldgR12 (kwh/gas/propane are site values)
          let bSrcEui = 0;
          let bEstScore = 0;
          if (bR12.kwh != null || bR12.gas != null || bR12.propane != null) {
            bSrcEui =
              typeof computeSourceEUI === 'function'
                ? computeSourceEUI(bR12.kwh || 0, bR12.gas || 0, bR12.propane || 0, bSqft)
                : 0;
            bEstScore =
              bSrcEui > 0 && typeof estimateEnergyStarScore === 'function' ? estimateEnergyStarScore(bSrcEui) : 0;
          }
          // Trend: rolling 12-month EUI vs baseline EUI for this building
          let trend = '';
          if (bBlEui > 0) {
            const chg = ((latestEui - bBlEui) / bBlEui) * 100;
            trend =
              chg <= -2
                ? '<span style="color:var(--green)">↓ ' + Math.abs(chg).toFixed(1) + '%</span>'
                : chg >= 2
                  ? '<span style="color:var(--danger)">↑ ' + chg.toFixed(1) + '%</span>'
                  : '<span style="color:var(--text3)">→ flat</span>';
          }
          return {
            name: b.name,
            type: bType,
            sqft: bSqft,
            blEui: bBlEui,
            eui: latestEui,
            costSqft: latestCostSqft,
            cbecs,
            estar,
            estarStatus,
            estarColor,
            pctileLabel,
            srcEui: bSrcEui,
            estScore: bEstScore,
            trend,
          };
        })
        .filter(Boolean);
      if (bRows.length === 0) return '';
      // Sort by EUI descending (worst performers first)
      bRows.sort((a, b) => b.eui - a.eui);
      return `<div class="card" style="padding:14px;margin-top:12px">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">🏆 Building Performance Benchmarking</div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:12px">Ranked by <span title="Site Energy Use Intensity: yearly energy use per square foot, in kBtu">Site EUI</span> (highest = most opportunity) · rolling 12-month data · CBECS percentiles + EnergyStar score-75 threshold</div>
              <div style="overflow-x:auto">
                <table class="dtbl" style="min-width:700px">
                  <thead><tr>
                    <th style="text-align:left">#</th>
                    <th style="text-align:left">Building</th>
                    <th style="text-align:left">Type</th>
                    <th style="text-align:right">Square Feet</th>
                    <th style="text-align:right" title="Baseline Site Energy Use Intensity: yearly energy use per square foot, in kBtu">Baseline Site EUI</th>
                    <th style="text-align:right" title="Current Site Energy Use Intensity: yearly energy use per square foot, in kBtu">Current Site EUI</th>
                    <th style="text-align:right">CBECS Median</th>
                    <th style="text-align:right">vs CBECS</th>
                    <th style="text-align:center">Percentile</th>
                    <th style="text-align:center">EnergyStar</th>
                    <th style="text-align:right">$/ft²</th>
                    <th style="text-align:center">Trend</th>
                  </tr></thead>
                  <tbody>
                    ${bRows
                      .map((r, i) => {
                        const vsCbecs = r.cbecs > 0 ? ((r.eui - r.cbecs) / r.cbecs) * 100 : 0;
                        const vsColor = vsCbecs <= 0 ? 'var(--green)' : 'var(--danger)';
                        const pctBg =
                          r.pctileLabel === 'Top 25%'
                            ? 'rgba(34,197,94,0.15)'
                            : r.pctileLabel === 'Bottom 25%'
                              ? 'rgba(239,68,68,0.15)'
                              : 'transparent';
                        return `<tr>
                        <td style="font-family:var(--mono);color:var(--text3);font-size:10px">${i + 1}</td>
                        <td style="font-weight:600;white-space:nowrap">${r.name}</td>
                        <td style="font-size:11px;color:var(--text2)">${r.type}</td>
                        <td style="text-align:right;font-family:var(--mono)">${r.sqft.toLocaleString()}</td>
                        <td style="text-align:right;font-family:var(--mono);color:var(--text2)">${r.blEui > 0 ? r.blEui.toFixed(1) : '—'}</td>
                        <td style="text-align:right;font-family:var(--mono);font-weight:700">${r.eui.toFixed(1)}</td>
                        <td style="text-align:right;font-family:var(--mono);color:var(--amber)">${r.cbecs.toFixed(1)}</td>
                        <td style="text-align:right;font-family:var(--mono);color:${vsColor};font-weight:600">${vsCbecs > 0 ? '+' : ''}${vsCbecs.toFixed(0)}%</td>
                        <td style="text-align:center;font-size:10px;font-weight:600;background:${pctBg};border-radius:4px">${r.pctileLabel}</td>
                        <td style="text-align:center;font-size:10px;color:${r.estarColor};font-weight:600">${r.estarStatus}</td>
                        <td style="text-align:right;font-family:var(--mono)">$${r.costSqft.toFixed(2)}</td>
                        <td style="text-align:center;font-size:11px">${r.trend || '—'}</td>
                      </tr>`;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>
              ${
                bRows.length > 1
                  ? `<div style="margin-top:12px;font-size:10px;color:var(--text3)">
                <strong style="color:var(--text2)">Key:</strong>
                Site EUI = Site Energy Use Intensity, kBtu/ft²/yr (energy at the meter) · CBECS = DOE Commercial Buildings Energy Consumption Survey national median ·
                EnergyStar = Score 75 threshold (minimum for certification) ·
                Percentile = estimated position in CBECS distribution ·
                $/ft² = annual energy cost per square foot · Trend = rolling 12-month Site EUI vs baseline Site EUI
              </div>`
                  : ''
              }
            </div>`;
    })()}${(() => {
      const maxBlYear = Math.max(...blYears);
      const postBlYears = sortedYears.filter((y) => y > maxBlYear);
      if (postBlYears.length === 0 || blEui === 0) return '';
      const qNames = ['Q1 (Jan-Mar)', 'Q2 (Apr-Jun)', 'Q3 (Jul-Sep)', 'Q4 (Oct-Dec)'];
      const qMonths = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [9, 10, 11],
      ];

      const hasElec = totalBlKwh > 0 || sortedYears.some((y) => yearData[y].kwh.some((v) => v > 0));
      const hasGasQ = totalBlGas > 0 || sortedYears.some((y) => yearData[y].gas.some((v) => v > 0));
      const hasPropaneQ = totalBlPropane > 0 || sortedYears.some((y) => yearData[y].propane.some((v) => v > 0));
      let qHtml =
        '<div class="card" style="padding:14px;margin-top:12px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">💰 Monthly Savings: Projected vs Current</div>' +
        '<div style="height:173px;position:relative;margin-bottom:14px"><canvas id="egfx-savChart-' +
        projId +
        '"></canvas></div>' +
        '</div>';
      qHtml += '<div class="card" style="padding:14px;margin-top:12px">';
      qHtml +=
        '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">📅 Quarterly Savings vs Baseline</div>';
      qHtml += '<div style="overflow-x:auto"><table class="dtbl" style="min-width:500px">';
      qHtml += '<thead><tr><th>Year</th><th>Quarter</th>';
      if (hasElec)
        qHtml += '<th style="text-align:right">Baseline kWh</th><th style="text-align:right">Actual kWh</th>';
      if (hasGasQ)
        qHtml += '<th style="text-align:right">Baseline Therms</th><th style="text-align:right">Actual Therms</th>';
      if (hasPropaneQ)
        qHtml += '<th style="text-align:right">Baseline Gal</th><th style="text-align:right">Actual Gal</th>';
      qHtml +=
        '<th style="text-align:right">Baseline Cost</th><th style="text-align:right">Actual Cost</th><th style="text-align:right">Savings</th><th style="text-align:right">Savings %</th></tr></thead><tbody>';
      for (const y of postBlYears) {
        const yd = yearData[y];
        if (!yd) continue;
        for (let qi = 0; qi < 4; qi++) {
          let qBlKwh = 0,
            qActKwh = 0,
            qBlGas = 0,
            qActGas = 0,
            qBlPropane = 0,
            qActPropane = 0,
            qBlCost = 0,
            qActCost = 0;
          let hasActualData = false;
          let moWithData = 0;
          for (const mi of qMonths[qi]) {
            const nYrs = blYmPerMo[mi].size || 1;
            qBlKwh += blKwhAvg[mi];
            qBlGas += blGasAvg[mi];
            qBlPropane += blPropaneAvg[mi];
            qBlCost += blCostAvg[mi];
            qActKwh += yd.kwh[mi];
            qActGas += yd.gas[mi];
            qActPropane += yd.propane[mi];
            qActCost += yd.cost[mi];
            if (yd.kwh[mi] > 0 || yd.gas[mi] > 0 || yd.propane[mi] > 0) {
              const actKbtu = computeKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
              const blRef = blKbtuPerMo[mi];
              if (blRef > 0 && actKbtu < blRef * 0.25) continue;
              hasActualData = true;
              moWithData++;
            }
          }
          if (!hasActualData) continue;
          if (moWithData < 3) continue;
          // The quarter's billable savings: a presented quarter shows its printed figure, a negative quarter shows $0
          // (billableSavingsWithPresented, computations/savings.js), not a re-sum of live months.
          const _qr = billableSavingsWithPresented(
            projId,
            qMonths[qi].map((mi) => y + '-' + String(mi + 1).padStart(2, '0')),
            egfxSavByBldgYm,
          );
          const _qWait = weatherWaitingMonths(
            projId,
            qMonths[qi].map((mi) => y + '-' + String(mi + 1).padStart(2, '0')),
          );
          const costSav = _qr.total;
          const costPct = qBlCost > 0 ? (costSav / qBlCost) * 100 : 0;
          const costPctMeas = qBlCost > 0 ? (_qr.measured / qBlCost) * 100 : 0; // before the $0 floor
          const _costShown = savingsFlooredShown(_qr.measured, costSav, 0, (n) => '$' + Math.round(n).toLocaleString(), 'var(--green)', 'var(--red)', 'var(--text)');
          const _pctQShown = savingsFlooredShown(costPctMeas, costPct, 1, (n) => n.toFixed(1) + '%', 'var(--green)', 'var(--red)', 'var(--text)', true);
          const $f = (n) => '$' + Math.abs(Math.round(n)).toLocaleString();
          qHtml += '<tr><td>' + y + '</td><td>' + qNames[qi] + '</td>';
          if (hasElec)
            qHtml +=
              '<td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qBlKwh).toLocaleString() +
              '</td><td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qActKwh).toLocaleString() +
              '</td>';
          if (hasGasQ)
            qHtml +=
              '<td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qBlGas).toLocaleString() +
              '</td><td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qActGas).toLocaleString() +
              '</td>';
          if (hasPropaneQ)
            qHtml +=
              '<td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qBlPropane).toLocaleString() +
              '</td><td style="text-align:right;font-family:var(--mono)">' +
              Math.round(qActPropane).toLocaleString() +
              '</td>';
          qHtml += '<td style="text-align:right;font-family:var(--mono)">' + $f(qBlCost) + '</td>';
          qHtml += '<td style="text-align:right;font-family:var(--mono)">' + $f(qActCost) + '</td>';
          if (_qWait.length)
            qHtml +=
              '<td colspan="2" style="text-align:right;font-family:var(--mono)">' +
              _escHtml(savingsOrWaiting(_qWait, 0)) +
              '</td></tr>';
          else {
            qHtml +=
              '<td style="text-align:right;font-family:var(--mono);color:' +
              _costShown.color +
              '">' +
              _costShown.text +
              '</td>';
            qHtml +=
              '<td style="text-align:right;font-family:var(--mono);color:' +
              _pctQShown.color +
              '">' +
              _pctQShown.text +
              '</td></tr>';
          }
        }
      }
      qHtml += '</tbody></table></div></div>';
      return qHtml;
    })()}`;
  }

  setTimeout(() => {
    _yoyChartsToDraw.forEach((entry) => {
      if (entry._benchRows) {
        SharedCharts.renderEUIBenchmarkChart(
          entry.cid,
          {
            buildings: entry._benchRows,
          },
          { interactive: true, showBaseline: blYears.size > 0 },
        );
      } else {
        _drawYoyChart(entry.cid, entry.field, entry.unit, entry.blAvgArr);
      }
    });
    // Multi-Year Usage Trend chart (Talisen FAC workbook data) — no-op if the card wasn't
    // rendered (no building has annualBenchmarks) since the canvas won't exist.
    egfxRedrawTrendChart(projId);
    // Savings chart
    const savChartCv = document.getElementById('egfx-savChart-' + projId);
    if (savChartCv && hasEgfxSav) {
      const savChartId = 'egfx-savChart-' + projId;
      if (_maCharts[savChartId]) _maCharts[savChartId].destroy();
      const egfxMoBase = aggBaseMoMapForBldgs(bldgs);
      // Bug d3e7c89b fix: use measure-based monthly savings (with % fallback) — same pattern as other 4 locations
      const _egfxProjSavByMo = Array(12).fill(0);
      bldgs.forEach((b) => {
        const msrSav = getBldgMeasureSavingsByMo(projId, b.id);
        if (msrSav) {
          msrSav.forEach((v, mo) => {
            _egfxProjSavByMo[mo] += v;
          });
        } else if (projHasContract(projId)) {
          // 2026-09-15 (SA-gate fix): no contract means no projected savings — skip
          // the % fallback accumulation entirely so the chart shows $0 for that building.
          const savPct = getBspCfg(b).savingsPct / 100; // the ONE reader (utility-data.js getBspCfg)
          const bMoBase = aggBaseMoMapForBldgs([b]);
          for (let mo = 0; mo < 12; mo++) _egfxProjSavByMo[mo] += (bMoBase[mo] || 0) * savPct;
        }
      });
      const projVals = months.map((_, mo) => _egfxProjSavByMo[mo]);
      const actVals = months.map((_, mo) => {
        const ym = curYear + '-' + String(mo + 1).padStart(2, '0');
        return egfxSavByMo[ym] != null ? egfxSavByMo[ym] : null;
      });
      // Fix 5 (2026-09-10, report export speed): willReadFrequently on the FIRST getContext('2d')
      // call — see the same fix's comment on SharedCharts._ctx2d() in lib/shared-charts.js for why.
      // This chart (egfx-savChart) lives outside the report preview and is hidden (not walked or
      // cloned) by the print-to-PDF path — see the shared-charts.js comment for the fix's original
      // (2026-09-10, since removed by fix/quarterly-text-pdf 2026-09-25) html2canvas rationale.
      _maCharts[savChartId] = new Chart(savChartCv.getContext('2d', { willReadFrequently: true }), {
        type: 'bar',
        data: {
          labels: months,
          datasets: [
            {
              label: 'Projected Savings $',
              data: projVals,
              backgroundColor: 'rgba(0,212,170,.35)',
              borderColor: 'rgba(0,212,170,.8)',
              borderWidth: 1,
            },
            {
              // Bug 7849b7b7 fix: one consistent color regardless of positive/negative value
              label: 'Current Savings $',
              data: actVals,
              backgroundColor: 'rgba(59,130,246,.75)',
              borderColor: 'rgba(59,130,246,1)',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: { color: SharedCharts.textColor(), font: { size: 10 }, boxWidth: 12, padding: 10 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ctx.dataset.label +
                  ': ' +
                  (ctx.raw == null
                    ? '—'
                    : (ctx.raw < 0 ? '-' : '') +
                      '$' +
                      Math.abs(ctx.raw).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })),
              },
            },
          },
          scales: {
            x: { ticks: { color: SharedCharts.textColor(), font: { size: 10 } }, grid: { display: false } },
            y: {
              ticks: {
                color: SharedCharts.textColor(),
                font: { size: 10 },
                callback: (v) => '$' + v.toLocaleString(),
              },
              grid: { color: 'rgba(255,255,255,.12)' },
            },
          },
        },
      });
    }
  }, 120);

  // Re-render performance verification if panel is open
  var pvBody = document.getElementById('egfx-perfverify-body-' + projId);
  if (pvBody && pvBody.style.display === 'block') {
    egfxRenderPerfVerify(projId);
  }
}
function egfxExport(projId) {
  const chartsEl = document.getElementById(`egfx-charts-${projId}`);
  const table = chartsEl ? chartsEl.querySelector('table[data-egfx-export="annual"]') : null;
  if (!chartsEl || !table) {
    showToast('Open the Energy Graphics tab and let it load first');
    return;
  }

  const esc = function (v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

  const lines = [];

  lines.push('KPI,Value');
  const kpis = [
    [`egfx-blEui-${projId}`, 'Baseline Energy Use Intensity'],
    [`egfx-curEui-${projId}`, 'Rolling 12-mo Energy Use Intensity'],
    [`egfx-estarScore-${projId}`, 'Est. ENERGY STAR Score'],
    [`egfx-projSav-${projId}`, 'Projected Savings'],
    [`egfx-curSav-${projId}`, 'Current Savings'],
  ];
  kpis.forEach(([id, label]) => {
    const el = document.getElementById(id);
    if (!el) return;
    lines.push(`${esc(label)},${esc(el.textContent.trim())}`);
  });

  lines.push('');
  lines.push('Annual Summary by Year');
  Array.from(table.querySelectorAll('tr')).forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => esc(c.textContent.trim()));
    lines.push(cells.join(','));
  });

  const p = projects.find((x) => String(x.id) === String(projId));
  const projLabel = (p && p.name ? p.name : String(projId)).trim().replace(/\s+/g, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `energy-graphics-${projLabel}-${dateStr}.csv`;

  _exportTriggerDownload(new Blob([lines.join('\r\n')], { type: 'text/csv' }), filename);
  showToast('Exported energy graphics data');
}

/* ══════════════════════════════════════════════════════
         SET POINTS & SCHEDULES TAB
      ══════════════════════════════════════════════════════ */

/* Data model stored on project in en_projects:
         project.setpoints = [
           { buildingId: 'xxx', zones: [
             { name: 'Classrooms', occHeat: 70, occCool: 74,
               unoccHeat: 60, unoccCool: 85, schedule: 'M-F 6:00a-4:30p' }
           ]}
         ]
      */

function renderSetpointsTab(projId) {
  const container = document.getElementById('ptab-setpoints-body-' + projId);
  if (!container) return;
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!p) {
    container.innerHTML = '<div style="color:var(--text3);padding:20px">Project not found.</div>';
    return;
  }

  const bldgs = getUDBldgs(projId);
  if (!bldgs.length) {
    container.innerHTML =
      '<div style="text-align:center;color:var(--text3);padding:40px;font-size:13px">No buildings found. Add buildings in the Utility Data tab first.</div>';
    return;
  }

  // Determine active building — preserve last selection per project
  if (!window._spActiveBldg) window._spActiveBldg = {};
  const savedBldgId = window._spActiveBldg[projId];
  const activeBldgId = (bldgs.find((b) => b.id === savedBldgId) ? savedBldgId : null) || bldgs[0].id;
  window._spActiveBldg[projId] = activeBldgId;

  const spRecord = (p.setpoints || []).find((r) => r.buildingId === activeBldgId);

  // View mode: 'individual' (default) or 'average'
  if (!window._spViewMode) window._spViewMode = {};
  const viewMode = window._spViewMode[projId] || (spRecord && spRecord.viewMode) || 'individual';
  window._spViewMode[projId] = viewMode;
  const isAvg = viewMode === 'average';

  // Version metadata (shared across all setpoint records in this project)
  const versionType = (spRecord && spRecord.versionType) || 'current';
  const versionDate = (spRecord && spRecord.versionDate) || null;

  // Snapshot tracking: null = current (editable), string = snapshot id (read-only)
  if (!window._spActiveSnapshot) window._spActiveSnapshot = {};
  const activeSnapId = window._spActiveSnapshot[projId] || null;
  const snapshots = p.setpointSnapshots || [];
  const activeSnapData = activeSnapId ? snapshots.find((s) => s.id === activeSnapId) : null;
  const isViewingSnapshot = !!activeSnapData;
  const dataSource = isViewingSnapshot ? activeSnapData.data : p.setpoints || [];

  const displayRecord = dataSource.find((r) => r.buildingId === activeBldgId);
  // Current view: the one shared source (saved record, else the Equipment Matrix). Snapshots: their own copy.
  const zones = isViewingSnapshot ? (displayRecord ? displayRecord.zones : []) : emCurrentSetpointZones(projId, activeBldgId);

  const snapPills = _spBuildSnapshotPills(projId, activeSnapId, snapshots);

  // Version info bar (type pills + date editor)
  let versionInfoBar = '';
  if (!isViewingSnapshot) {
    const vtPill = (t, label, radius) =>
      `<button style="padding:6px 14px;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:all .15s;${versionType === t ? 'background:var(--accent);color:#fff' : 'background:var(--s1);color:var(--text2)'}${radius}" onclick="spSetVersionType('${projId}','${t}')">${label}</button>`;
    const dateDisplay = versionDate
      ? `<span style="font-size:12px;color:var(--text)">${_basFormatDate(versionDate)}</span> <span onclick="document.getElementById('sp-vdate-edit-${projId}').style.display='inline-flex';this.parentElement.querySelector('.sp-vdate-show').style.display='none'" style="cursor:pointer;font-size:11px;color:var(--text3);border-bottom:1px dashed var(--text3)" title="Change date">edit</span>`
      : `<span style="font-size:12px;color:var(--text3);cursor:pointer" onclick="document.getElementById('sp-vdate-edit-${projId}').style.display='inline-flex';this.style.display='none'">No date — click to set</span>`;
    const dateEditor = `<span id="sp-vdate-edit-${projId}" style="display:none;align-items:center;gap:4px"><input type="date" id="sp-vdate-input-${projId}"${versionDate ? ` value="${versionDate}"` : ''} style="font-size:12px;padding:3px 6px;background:var(--s3);border:1px solid var(--border2);border-radius:4px;color:var(--text);font-family:var(--mono)"><button onclick="spSetVersionDate('${projId}',document.getElementById('sp-vdate-input-${projId}').value)" style="font-size:11px;padding:3px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">Save</button><button onclick="document.getElementById('sp-vdate-edit-${projId}').style.display='none';renderSetpointsTab('${projId}')" style="font-size:11px;padding:3px 6px;background:none;border:1px solid var(--border2);border-radius:4px;cursor:pointer;color:var(--text3)">Cancel</button></span>`;
    versionInfoBar = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;gap:0;border:1px solid var(--border2);border-radius:6px;overflow:hidden;width:fit-content">
              ${vtPill('current', 'Current', ';border-radius:6px 0 0 6px')}${vtPill('baseline', 'Baseline', ';border-left:1px solid var(--border2)')}${vtPill('historic', 'Historic', ';border-radius:0 6px 6px 0;border-left:1px solid var(--border2)')}
            </div>
            <div style="display:flex;align-items:center;gap:6px" class="sp-vdate-show">${dateDisplay}${dateEditor}</div>
          </div>`;
  } else {
    const snapLabel = activeSnapData ? activeSnapData.label : '';
    const snapDateStr = activeSnapData && activeSnapData.savedAt ? _basFormatDate(activeSnapData.savedAt) : '';
    if (snapLabel || snapDateStr) {
      versionInfoBar = `<div style="margin-bottom:12px;font-size:12px;color:var(--text2)"><span style="font-weight:600">${_escHtml(snapLabel)}</span>${snapDateStr ? ` <span style="color:var(--text3)">(${snapDateStr})</span>` : ''}</div>`;
    }
  }

  const bldgPills = bldgs
    .map(
      (b) =>
        `<button style="padding:4px 12px;font-size:12px;font-weight:600;border:none;border-radius:20px;cursor:pointer;transition:all .15s;${b.id === activeBldgId ? 'background:var(--accent);color:#fff' : 'background:var(--s2);color:var(--text2);border:1px solid var(--border2)'}"
                onclick="window._spActiveBldg['${projId}']='${b.id}';renderSetpointsTab('${projId}')">${_escHtml(b.name || 'Building')}</button>`,
    )
    .join('');

  let tableContent = '';
  if (isAvg) {
    // Show averages for ALL buildings at once
    const avgRows = bldgs
      .map((b) => {
        const rec = dataSource.find((r) => r.buildingId === b.id);
        const bZones = isViewingSnapshot ? (rec ? rec.zones : []) : emCurrentSetpointZones(projId, b.id);
        return _spComputeAvgRow(bZones, b);
      })
      .filter(Boolean);
    tableContent = avgRows.length
      ? avgRows.map((r) => _spAvgRow(r)).join('')
      : `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3);font-style:italic">No zones to average.</td></tr>`;
  } else if (isViewingSnapshot) {
    const tableRows = zones.map((z) => _spReadOnlyZoneRow(z)).join('');
    tableContent =
      tableRows ||
      `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text3);font-style:italic">No zones in this snapshot.</td></tr>`;
  } else {
    const tableRows = zones.map((z, i) => _spZoneRow(projId, activeBldgId, z, i)).join('');
    tableContent =
      tableRows ||
      `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text3);font-style:italic">No zones yet — add one above or import a CSV.</td></tr>`;
  }

  container.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-hdr" style="justify-content:space-between">
              <span class="card-title">🌡️ BAS Set Points &amp; Schedules</span>
              <div style="display:flex;gap:8px;align-items:center">
                ${
                  !isAvg && !isViewingSnapshot
                    ? `<button class="btn btn-ghost btn-sm" id="sp-pull-em-btn-${projId}" onclick="spOpenPullFromEMDialog('${projId}','${activeBldgId}')">Pull from Equipment Matrix</button>
                <button class="btn btn-ghost btn-sm" id="sp-delete-all-btn-${projId}" onclick="spDeleteAllZones('${projId}','${activeBldgId}')" style="color:var(--red);border-color:rgba(244,63,94,.3)">Delete All</button>
                <button class="btn btn-ghost btn-sm" onclick="spAddZoneRow('${projId}','${activeBldgId}')">+ Add Zone</button>
                <button class="btn btn-em btn-sm" onclick="spSave('${projId}','${activeBldgId}')">💾 Save</button>
                <div style="position:relative;display:inline-block">
                  <button class="btn btn-ghost btn-sm" onclick="spShowSaveAsMenu(event,'${projId}','${activeBldgId}')">Save As…</button>
                </div>`
                    : ''
                }
              </div>
            </div>
            <div style="padding:16px">
              <!-- View Mode Toggle -->
              <div style="display:flex;gap:0;margin-bottom:16px;border:1px solid var(--border2);border-radius:6px;overflow:hidden;width:fit-content">
                <button style="padding:6px 14px;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:all .15s;${!isAvg ? 'background:var(--accent);color:#fff' : 'background:var(--s1);color:var(--text2)'}"
                  onclick="spSetViewMode('${projId}','individual')">Individual Zones</button>
                <button style="padding:6px 14px;font-size:12px;font-weight:600;border:none;border-left:1px solid var(--border2);cursor:pointer;transition:all .15s;${isAvg ? 'background:var(--accent);color:#fff' : 'background:var(--s1);color:var(--text2)'}"
                  onclick="spSetViewMode('${projId}','average')">Building Average</button>
              </div>
              ${versionInfoBar}
              <!-- Snapshot Version Pills -->
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
                <span style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-right:2px">Version:</span>
                ${snapPills}
              </div>
              ${
                !isAvg && bldgs.length > 1
                  ? `<!-- Building Pills -->
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
                ${bldgPills}
              </div>`
                  : ''
              }
              ${
                !isAvg && !isViewingSnapshot
                  ? `<div style="font-size:12px;color:var(--text2);margin-bottom:16px">Set points and schedules come from the Equipment Matrix. WebCTRL schedules are imported once, on the <a href="#" style="color:var(--accent)" onclick="sPTab('district',document.querySelector('.pdt[data-tab=&quot;district&quot;]'));return false">Calendar</a> tab. Use Pull from Equipment Matrix to refresh the rows below.</div>`
                  : ''
              }
              ${isViewingSnapshot ? `<div style="margin-bottom:12px;padding:8px 12px;background:var(--s2);border:1px solid var(--border2);border-radius:6px;font-size:11px;color:var(--text2)">Viewing saved snapshot: <strong style="color:var(--text)">${_escHtml(activeSnapData.label)}</strong> — switch to <a href="#" style="color:var(--accent);text-decoration:none" onclick="event.preventDefault();spViewSnapshot('${projId}',null)">Current</a> to edit</div>` : ''}
              <!-- Zone Table -->
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12px" id="sp-table-${projId}">
                  <thead>
                    <tr style="border-bottom:1px solid var(--border);text-align:left">
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);min-width:150px">${isAvg ? 'Building' : 'Zone / System'}</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Occupied Heat °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Occupied Cool °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Unoccupied Heat °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Unoccupied Cool °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);min-width:160px">Schedule</th>
                      ${!isAvg && !isViewingSnapshot ? '<th style="padding:6px 4px;width:32px"></th>' : ''}
                    </tr>
                  </thead>
                  <tbody id="sp-tbody-${projId}">
                    ${tableContent}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          ${spRenderBASSnapshot(projId)}`;
}

// Numeric setpoint fields can also hold the literal string '?' — the "unknown, never
// invented" marker used by the Equipment Matrix Setpoint & Schedule export (_emSpDisplay).
// Pulling from Equipment Matrix (spPullFromEquipmentMatrix) writes '?' straight into these
// fields when no BAS point exists, so these four inputs must be text (a number input silently
// discards a non-numeric value attribute, which would turn '?' into a blank with no way to
// tell "unknown" apart from "never filled in").
function _spParseSpField(raw) {
  var s = (raw || '').trim();
  if (s === '?') return '?';
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function _spZoneRow(projId, bldgId, z, idx) {
  const v = (val) => (val !== undefined && val !== null ? val : '');
  return `<tr style="border-bottom:1px solid var(--border)" data-sp-idx="${idx}">
          <td style="padding:4px 6px"><input class="fi" style="width:100%;font-size:12px" type="text"
            value="${_escHtml(z.name || '')}" placeholder="Zone or system name"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'name',this.value)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="text" inputmode="decimal"
            value="${v(z.occHeat)}" placeholder="${EM_SP_PLACEHOLDER.occHeat}"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'occHeat',_spParseSpField(this.value))"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="text" inputmode="decimal"
            value="${v(z.occCool)}" placeholder="${EM_SP_PLACEHOLDER.occCool}"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'occCool',_spParseSpField(this.value))"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="text" inputmode="decimal"
            value="${v(z.unoccHeat)}" placeholder="${EM_SP_PLACEHOLDER.unoccHeat}"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'unoccHeat',_spParseSpField(this.value))"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="text" inputmode="decimal"
            value="${v(z.unoccCool)}" placeholder="${EM_SP_PLACEHOLDER.unoccCool}"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'unoccCool',_spParseSpField(this.value))"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:100%;font-size:12px" type="text"
            value="${_escHtml(z.schedule || '')}" placeholder="e.g. Monday–Friday 6:00a-4:30p"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'schedule',this.value)"></td>
          <td style="padding:4px 6px;text-align:center">
            <button class="btn btn-ghost btn-sm" style="padding:2px 6px;color:var(--red);border-color:rgba(244,63,94,.3);font-size:11px"
              onclick="spDeleteZone('${projId}','${bldgId}',${idx})">✕</button>
          </td>
        </tr>`;
}

function _spComputeAvgRow(zones, bldg) {
  if (!zones || !zones.length) return null;
  function avg(arr, key) {
    return avgSetpoint(
      arr.map((z) => z[key]),
      0,
    );
  }
  var schedules = zones.map((z) => (z.schedule || '').trim()).filter((s) => s);
  var sched = '';
  if (schedules.length) {
    var counts = {};
    schedules.forEach((s) => {
      counts[s] = (counts[s] || 0) + 1;
    });
    var sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    sched = sorted.length > 1 && sorted[0][1] === sorted[1][1] ? 'Varies' : sorted[0][0];
  }
  return {
    name: (bldg && bldg.name) || 'Building',
    occHeat: avg(zones, 'occHeat'),
    occCool: avg(zones, 'occCool'),
    unoccHeat: avg(zones, 'unoccHeat'),
    unoccCool: avg(zones, 'unoccCool'),
    schedule: sched,
  };
}

function _spAvgRow(z) {
  const v = (val) => (val !== null && val !== undefined ? val : '—');
  return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--text)">${_escHtml(z.name)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.occHeat)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.occCool)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.unoccHeat)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.unoccCool)}</td>
          <td style="padding:6px 8px;font-size:12px;color:var(--text2)">${_escHtml(z.schedule || '—')}</td>
        </tr>`;
}

function _spReadOnlyZoneRow(z) {
  const v = (val) => (val !== null && val !== undefined ? val : '—');
  return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--text)">${_escHtml(z.name || '')}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.occHeat)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.occCool)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.unoccHeat)}</td>
          <td style="padding:6px 8px;font-size:12px;font-family:var(--mono);text-align:center;color:var(--text2)">${v(z.unoccCool)}</td>
          <td style="padding:6px 8px;font-size:12px;color:var(--text2)">${_escHtml(z.schedule || '—')}</td>
        </tr>`;
}

function _spBuildSnapshotPills(projId, activeSnapId, snapshots) {
  var isCurrentActive = !activeSnapId;
  var pills =
    '<button style="padding:4px 12px;font-size:11px;font-weight:600;border:none;border-radius:20px;cursor:pointer;transition:all .15s;' +
    (isCurrentActive
      ? 'background:var(--accent);color:#fff'
      : 'background:var(--s2);color:var(--text2);border:1px solid var(--border2)') +
    '"' +
    ' onclick="spViewSnapshot(\'' +
    projId +
    '\',null)">Current</button>';
  // Version pills default newest first (2026-09-23) — "Current" (the live,
  // editable state) always stays leftmost; saved snapshots sort by savedAt
  // descending. Sorts a copy so the underlying array order (and any other
  // reader of p.setpointSnapshots) is unaffected.
  var sortedSnapshots = snapshots.slice().sort(function (a, b) {
    return (b.savedAt || '') > (a.savedAt || '') ? 1 : (b.savedAt || '') < (a.savedAt || '') ? -1 : 0;
  });
  sortedSnapshots.forEach(function (s) {
    var isActive = activeSnapId === s.id;
    pills +=
      '<button style="padding:4px 12px;font-size:11px;font-weight:600;border:none;border-radius:20px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px;' +
      (isActive
        ? 'background:var(--accent);color:#fff'
        : 'background:var(--s2);color:var(--text2);border:1px solid var(--border2)') +
      '"' +
      ' onclick="spViewSnapshot(\'' +
      projId +
      "','" +
      s.id +
      '\')">' +
      _escHtml(s.label) +
      ' <span onclick="event.stopPropagation();spDeleteSnapshot(\'' +
      projId +
      "','" +
      s.id +
      '\')" style="font-size:10px;cursor:pointer;margin-left:2px" title="Delete snapshot">✕</span>' +
      '</button>';
  });
  return pills;
}

function spViewSnapshot(projId, snapId) {
  if (!window._spActiveSnapshot) window._spActiveSnapshot = {};
  window._spActiveSnapshot[projId] = snapId || null;
  renderSetpointsTab(projId);
}

function spSetVersionType(projId, type) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p || !p.setpoints || !p.setpoints.length) {
    showToast('Save zone set point data first to apply a version label');
    return;
  }
  p.setpoints.forEach(function (sp) {
    sp.versionType = type;
  });
  sset('en_projects', projects);
  showToast('Version type set to ' + type.charAt(0).toUpperCase() + type.slice(1));
  renderSetpointsTab(projId);
}

function spSetVersionDate(projId, date) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p || !p.setpoints || !p.setpoints.length) {
    showToast('Save zone set point data first to apply a version date');
    return;
  }
  p.setpoints.forEach(function (sp) {
    sp.versionDate = date || null;
  });
  sset('en_projects', projects);
  showToast(date ? 'Version date set to ' + _basFormatDate(date) : 'Version date cleared');
  renderSetpointsTab(projId);
}

function spDeleteSnapshot(projId, snapId) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p || !p.setpointSnapshots) return;
  p.setpointSnapshots = p.setpointSnapshots.filter(function (s) {
    return s.id !== snapId;
  });
  sset('en_projects', projects);
  if (window._spActiveSnapshot && window._spActiveSnapshot[projId] === snapId) {
    window._spActiveSnapshot[projId] = null;
  }
  showToast('Snapshot deleted');
  renderSetpointsTab(projId);
}

function spShowSaveAsMenu(evt, projId, bldgId) {
  var old = document.getElementById('sp-save-menu');
  if (old) {
    old.remove();
    return;
  }
  var today = new Date().toISOString().slice(0, 10);
  var menu = document.createElement('div');
  menu.id = 'sp-save-menu';
  menu.style.cssText =
    'position:absolute;top:100%;right:0;margin-top:4px;background:var(--s2);border:1px solid var(--border2);border-radius:8px;padding:8px 0;min-width:240px;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  menu.innerHTML =
    '<button style="display:block;width:100%;text-align:left;padding:8px 16px;font-size:12px;font-weight:600;background:none;border:none;color:var(--text);cursor:pointer"' +
    ' onmouseover="this.style.background=\'var(--s3)\'" onmouseout="this.style.background=\'none\'"' +
    ' onclick="spSaveSnapshot(\'' +
    projId +
    "','Baseline');document.getElementById('sp-save-menu').remove()\">" +
    'Save as Baseline</button>' +
    '<button style="display:block;width:100%;text-align:left;padding:8px 16px;font-size:12px;font-weight:600;background:none;border:none;color:var(--text);cursor:pointer"' +
    ' onmouseover="this.style.background=\'var(--s3)\'" onmouseout="this.style.background=\'none\'"' +
    ' onclick="spSaveSnapshot(\'' +
    projId +
    "','" +
    today +
    "');document.getElementById('sp-save-menu').remove()\">" +
    'Save as Today (' +
    today +
    ')</button>' +
    '<div style="padding:8px 16px;display:flex;gap:6px;align-items:center;border-top:1px solid var(--border)">' +
    '<input type="date" id="sp-save-date-' +
    projId +
    '" style="font-size:12px;padding:4px 6px;background:var(--s3);border:1px solid var(--border2);border-radius:4px;color:var(--text);font-family:var(--mono)">' +
    '<button style="font-size:11px;padding:4px 10px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;white-space:nowrap"' +
    ' onclick="var d=document.getElementById(\'sp-save-date-' +
    projId +
    "').value;if(d){spSaveSnapshot('" +
    projId +
    "',d);document.getElementById('sp-save-menu').remove();}else{showToast('Pick a date first')}\">" +
    'Save</button></div>';
  var wrap = evt.currentTarget.parentElement;
  wrap.style.position = 'relative';
  wrap.appendChild(menu);
  setTimeout(function () {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== evt.currentTarget) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

function spSaveSnapshot(projId, label) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p) return;
  // Save current building edits first
  var bldgId = window._spActiveBldg && window._spActiveBldg[projId];
  if (bldgId) spSave(projId, bldgId);
  if (!p.setpointSnapshots) p.setpointSnapshots = [];
  var id = label === 'Baseline' ? 'baseline' : 'date_' + label;
  var existing = p.setpointSnapshots.find(function (s) {
    return s.id === id;
  });
  var snapData = JSON.parse(JSON.stringify(p.setpoints || []));
  if (existing) {
    existing.data = snapData;
    existing.savedAt = new Date().toISOString();
    existing.label = label;
  } else {
    p.setpointSnapshots.push({
      id: id,
      label: label,
      savedAt: new Date().toISOString(),
      data: snapData,
    });
  }
  sset('en_projects', projects);
  showToast('Saved as ' + label + ' ✓');
  renderSetpointsTab(projId);
}

function spSetViewMode(projId, mode) {
  window._spViewMode[projId] = mode;
  var p = projects.find((x) => String(x.id) === String(projId));
  if (p) {
    if (!p.setpoints) p.setpoints = [];
    p.setpoints.forEach((sp) => {
      sp.viewMode = mode;
    });
    sset('en_projects', projects);
  }
  renderSetpointsTab(projId);
}

// In-memory scratch pad for unsaved edits
if (!window._spDraft) window._spDraft = {};

function _spGetDraft(projId, bldgId) {
  const key = projId + ':' + bldgId;
  if (!window._spDraft[key]) {
    const p = projects.find((x) => String(x.id) === String(projId));
    const rec = p && (p.setpoints || []).find((r) => r.buildingId === bldgId);
    window._spDraft[key] = JSON.parse(JSON.stringify(emCurrentSetpointZones(projId, bldgId)));
  }
  return window._spDraft[key];
}

function _spClearDraft(projId, bldgId) {
  delete window._spDraft[projId + ':' + bldgId];
}

function spUpdateField(projId, bldgId, idx, field, value) {
  const zones = _spGetDraft(projId, bldgId);
  if (!zones[idx]) return;
  zones[idx][field] = value;
  // Sync into table DOM without full re-render
}

function spAddZoneRow(projId, bldgId) {
  const zones = _spGetDraft(projId, bldgId);
  zones.push({ name: '', occHeat: null, occCool: null, unoccHeat: null, unoccCool: null, schedule: '' });
  const tbody = document.getElementById('sp-tbody-' + projId);
  if (!tbody) return;
  // If the empty-state placeholder row is showing, remove it
  const placeholder = tbody.querySelector('td[colspan="7"]');
  if (placeholder) tbody.innerHTML = '';
  const idx = zones.length - 1;
  const row = document.createElement('tr');
  row.style.borderBottom = '1px solid var(--border)';
  row.setAttribute('data-sp-idx', idx);
  row.innerHTML = _spZoneRow(projId, bldgId, zones[idx], idx)
    .replace(/^<tr[^>]*>/, '')
    .replace(/<\/tr>$/, '');
  tbody.appendChild(row);
}

function spDeleteZone(projId, bldgId, idx) {
  const zones = _spGetDraft(projId, bldgId);
  zones.splice(idx, 1);
  // Re-render the full tab to refresh indices
  _spClearDraft(projId, bldgId);
  // Repopulate draft with updated zones
  const p = projects.find((x) => String(x.id) === String(projId));
  if (p) {
    if (!p.setpoints) p.setpoints = [];
    const rec = p.setpoints.find((r) => r.buildingId === bldgId);
    if (rec) rec.zones = zones;
  }
  renderSetpointsTab(projId);
}

function spSave(projId, bldgId) {
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!p) return;
  if (!p.setpoints) p.setpoints = [];
  // Read current values directly from the input fields in the table
  const tbody = document.getElementById('sp-tbody-' + projId);
  const draft = _spGetDraft(projId, bldgId);
  if (tbody) {
    const rows = tbody.querySelectorAll('tr[data-sp-idx]');
    rows.forEach((row) => {
      const idx = parseInt(row.getAttribute('data-sp-idx'));
      if (!draft[idx]) return;
      const inputs = row.querySelectorAll('input');
      if (inputs[0]) draft[idx].name = inputs[0].value;
      if (inputs[1]) draft[idx].occHeat = _spParseSpField(inputs[1].value);
      if (inputs[2]) draft[idx].occCool = _spParseSpField(inputs[2].value);
      if (inputs[3]) draft[idx].unoccHeat = _spParseSpField(inputs[3].value);
      if (inputs[4]) draft[idx].unoccCool = _spParseSpField(inputs[4].value);
      if (inputs[5]) draft[idx].schedule = inputs[5].value;
    });
  }
  const existing = p.setpoints.find((r) => r.buildingId === bldgId);
  if (existing) {
    existing.zones = JSON.parse(JSON.stringify(draft));
  } else {
    p.setpoints.push({ buildingId: bldgId, zones: JSON.parse(JSON.stringify(draft)) });
  }
  _spClearDraft(projId, bldgId);
  sset('en_projects', projects);
  showToast('Set points saved ✓ (' + draft.length + ' zone' + (draft.length !== 1 ? 's' : '') + ')');
  renderSetpointsTab(projId);
}

/* ── Delete all zones (item 5af, Matt 2026-09-22) ─────────────────────────
   "Can we have a delete all" — removes every zone row for the selected
   building's CURRENT (editable) version. Never touches saved snapshots
   (setpointSnapshots are a separate read-only copy — see spSaveSnapshot). */
function spDeleteAllZones(projId, bldgId) {
  const p = projects.find((x) => String(x.id) === String(projId));
  if (!p) return;
  const rec = (p.setpoints || []).find((r) => r.buildingId === bldgId);
  const draft = _spGetDraft(projId, bldgId);
  const count = (rec && rec.zones && rec.zones.length) || draft.length || 0;
  if (!count) {
    showToast('No zones to delete');
    return;
  }
  if (
    !confirm('Delete all ' + count + ' zone' + (count !== 1 ? 's' : '') + ' for this building? This cannot be undone.')
  )
    return;
  if (rec) rec.zones = [];
  _spClearDraft(projId, bldgId);
  window._spDraft[projId + ':' + bldgId] = [];
  sset('en_projects', projects);
  showToast('Deleted ' + count + ' zone' + (count !== 1 ? 's' : '') + ' ✓');
  renderSetpointsTab(projId);
}

/* ── Pull from Equipment Matrix (item 5af, Matt 2026-09-22) ───────────────
   "a way for an option for it to just pull from the Equipment Matrix tab
   data with building selection" — one zone row per Equipment Matrix
   row (zone/equipment), not per BAS point. Reuses emBuildSetpointExportRows
   (app/equipment-matrix.js) — the SAME derivation the Setpoint & Schedule
   .xlsx export uses — so this never re-parses BAS Points itself. Only reads
   from equipment-matrix.js; never modifies it.
   Column indices below match EM_SETPOINT_EXPORT_HEADERS (equipment-matrix.js):
   0 Building Name, 1 location/equipment, 2 Type, 3-6 Existing Occ/Unocc
   Heat/Cool, 7 Adjustment, 8 has-schedule(Yes/No/'?'), 9-10 start/stop,
   11 Sat&Sun, 12-19 Proposed (not used here — Set Points tab tracks the
   EXISTING/current BAS program, not a savings-calc proposal). */
function spOpenPullFromEMDialog(projId, defaultBldgId) {
  var existing = document.getElementById('sp-pull-em-modal');
  if (existing) existing.remove();
  var bldgs = typeof getUDBldgs === 'function' ? getUDBldgs(projId) : [];
  var data = typeof emLoadMatrix === 'function' ? emLoadMatrix(projId) : null;
  var matrixBldgNames = {};
  ((data && data.rows) || []).forEach(function (r) {
    if (r.building && typeof _emNormBldgNameForJoin === 'function') {
      matrixBldgNames[_emNormBldgNameForJoin(r.building)] = true;
    }
  });
  var bldgOpts = bldgs.filter(function (b) {
    return typeof _emNormBldgNameForJoin === 'function' && matrixBldgNames[_emNormBldgNameForJoin(b.name)];
  });
  if (!bldgOpts.length) {
    showToast(
      'No Equipment Matrix rows found for any building in this project — import a BAS Points CSV in the Equipment Matrix tab first ⚠',
    );
    return;
  }
  var optsHtml = bldgOpts
    .map(function (b) {
      var sel = b.id === defaultBldgId ? ' selected' : '';
      return '<option value="' + _escHtml(b.id) + '"' + sel + '>' + _escHtml(b.name || 'Building') + '</option>';
    })
    .join('');
  var html =
    '<div id="sp-pull-em-modal" class="modal-bg open" onclick="if(event.target===this)document.getElementById(\'sp-pull-em-modal\').remove()">' +
    '<div class="modal" style="width:400px">' +
    '<div class="modal-hdr"><div class="modal-title">Pull from Equipment Matrix</div>' +
    '<button class="modal-x" onclick="document.getElementById(\'sp-pull-em-modal\').remove()">&#10005;</button></div>' +
    '<div class="modal-body">' +
    '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">Builds one zone row per Equipment Matrix zone/equipment for the selected building, using its BAS Points. Unknown values show "?" — never invented.</div>' +
    '<label style="font-size:11px;color:var(--text3);display:block;margin-bottom:4px">Building</label>' +
    '<select id="sp-pull-em-bldg" style="font-size:12px;padding:5px 8px;background:var(--s2);border:1px solid var(--border);color:var(--text);border-radius:4px;width:100%">' +
    optsHtml +
    '</select>' +
    '</div>' +
    '<div class="modal-ftr"><button class="btn btn-ghost" onclick="document.getElementById(\'sp-pull-em-modal\').remove()">Cancel</button>' +
    '<button class="btn btn-em" id="sp-pull-em-go-btn">Pull</button></div>' +
    '</div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  var goBtn = document.getElementById('sp-pull-em-go-btn');
  if (goBtn) {
    goBtn.addEventListener('click', function () {
      var sel = document.getElementById('sp-pull-em-bldg');
      var bldgId = sel ? sel.value : defaultBldgId;
      var modal = document.getElementById('sp-pull-em-modal');
      if (modal) modal.remove();
      spPullFromEquipmentMatrix(projId, bldgId);
    });
  }
}

function spPullFromEquipmentMatrix(projId, bldgId) {
  if (typeof emBuildSetpointExportRows !== 'function') {
    showToast('Equipment Matrix module not loaded ⚠');
    return;
  }
  var rows = emBuildSetpointExportRows(projId, bldgId, '') || [];
  if (!rows.length) {
    showToast('No Equipment Matrix rows found for that building ⚠');
    return;
  }
  var p = projects.find((x) => String(x.id) === String(projId));
  if (!p) return;
  if (!p.setpoints) p.setpoints = [];
  var rec = p.setpoints.find((r) => r.buildingId === bldgId);
  var existingCount = (rec && rec.zones && rec.zones.length) || 0;
  if (
    existingCount &&
    !confirm(
      'This building already has ' +
        existingCount +
        ' saved zone' +
        (existingCount !== 1 ? 's' : '') +
        '. Pulling from Equipment Matrix will replace them with ' +
        rows.length +
        ' zone' +
        (rows.length !== 1 ? 's' : '') +
        ' from the Equipment Matrix. Continue?',
    )
  ) {
    return;
  }
  var zones = emZonesFromSetpointRows(rows);
  if (rec) {
    rec.zones = zones;
  } else {
    p.setpoints.push({ buildingId: bldgId, zones: zones });
  }
  _spClearDraft(projId, bldgId);
  window._spActiveBldg = window._spActiveBldg || {};
  window._spActiveBldg[projId] = bldgId;
  sset('en_projects', projects);
  showToast(
    'Pulled ' + zones.length + ' zone' + (zones.length !== 1 ? 's' : '') + ' from Equipment Matrix ✓ (Save to keep)',
  );
  renderSetpointsTab(projId);
}

/* ══════════════════════════════════════════════════════
         BAS EQUIPMENT SNAPSHOT ANALYZER
      ══════════════════════════════════════════════════════ */

function _basFormatDate(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function _basGetSnapshots(p) {
  // Migrate old single basSnapshot to array
  if (p.basSnapshot && !p.basSnapshots) {
    p.basSnapshots = [p.basSnapshot];
    if (!p.basSnapshots[0].id) p.basSnapshots[0].id = 'legacy';
    delete p.basSnapshot;
  }
  return p.basSnapshots || [];
}

function _basGetActiveSnap(projId, snaps) {
  if (!snaps.length) return null;
  if (!window._basActiveSnap) window._basActiveSnap = {};
  var activeId = window._basActiveSnap[projId];
  var found = snaps.find(function (s) {
    return s.id === activeId;
  });
  return found || snaps[snaps.length - 1];
}

function spRenderBASSnapshot(projId) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p) return '';
  var snaps = _basGetSnapshots(p);
  if (!snaps.length) return '';
  var snap = _basGetActiveSnap(projId, snaps);
  if (!snap) return '';
  var rows = snap.rows || [];
  var buildings = snap.buildings || [];

  // Snapshot selector (if multiple)
  var snapSelector = '';
  if (snaps.length > 1) {
    var snapOpts = snaps
      .map(function (s) {
        var label = _basFormatDate(s.snapshotDate) || _basFormatDate(s.importedAt) || s.fileName;
        var sel = s.id === snap.id ? ' selected' : '';
        return (
          '<option value="' +
          s.id +
          '"' +
          sel +
          '>' +
          _escHtml(label) +
          ' (' +
          (s.rows || []).length +
          ' zones)</option>'
        );
      })
      .join('');
    snapSelector =
      '<select class="fi" style="font-size:12px;padding:4px 8px" onchange="spBASSelectSnap(\'' +
      projId +
      '\',this.value)">' +
      snapOpts +
      '</select>';
  }

  var bldgList = [];
  rows.forEach(function (r) {
    if (r.building && bldgList.indexOf(r.building) < 0) bldgList.push(r.building);
  });
  bldgList.sort();
  var bldgOpts =
    '<option value="">All Buildings (' +
    rows.length +
    ')</option>' +
    bldgList
      .map(function (b) {
        var ct = rows.filter(function (r) {
          return r.building === b;
        }).length;
        return '<option value="' + _escHtml(b) + '">' + _escHtml(b) + ' (' + ct + ')</option>';
      })
      .join('');

  var snapDate = snap.snapshotDate ? _basFormatDate(snap.snapshotDate) : '';
  var dateLabel = snapDate ? 'Snapshot: ' + snapDate : _escHtml(snap.fileName || '');

  // Pre-compute fault count for tab badge
  var shcFaults = detectSHCFaults(rows);
  var shcCount = shcFaults.length;
  var healthScore = _basHealthScore(shcCount, rows.length);
  var healthBadge =
    healthScore !== null
      ? ' <span style="font-size:10px;padding:1px 6px;border-radius:8px;font-weight:700;background:' +
        (healthScore >= 90
          ? 'rgba(34,197,94,.18)'
          : healthScore >= 70
            ? 'rgba(245,158,11,.18)'
            : 'rgba(244,63,94,.18)') +
        ';color:' +
        (healthScore >= 90 ? 'var(--green,#22c55e)' : healthScore >= 70 ? 'var(--em)' : 'var(--red)') +
        '">' +
        healthScore +
        '%</span>'
      : '';
  var faultTabLabel =
    'Fault Detection' +
    (shcCount > 0
      ? ' <span style="font-size:10px;padding:1px 6px;border-radius:8px;font-weight:700;background:rgba(244,63,94,.18);color:var(--red)">' +
        shcCount +
        '</span>'
      : '');

  return (
    '<div class="card" style="margin-top:16px">' +
    '<div class="card-hdr" style="justify-content:space-between">' +
    '<span class="card-title">📊 BAS Equipment Snapshot' +
    healthBadge +
    '</span>' +
    '<div style="display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text3)">' +
    snapSelector +
    '<span>' +
    dateLabel +
    '</span>' +
    '<button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:rgba(244,63,94,.3)" onclick="spClearBASSnapshot(\'' +
    projId +
    "','" +
    snap.id +
    '\')">Remove</button>' +
    '</div>' +
    '</div>' +
    '<div style="padding:12px">' +
    '<div class="bas-tabs">' +
    '<button class="bas-tab active" onclick="spBASTab(\'' +
    projId +
    "','data',this)\">Data (" +
    rows.length +
    ' rows)</button>' +
    '<button class="bas-tab" onclick="spBASTab(\'' +
    projId +
    "','analysis',this)\">Building Analysis (" +
    buildings.length +
    ')</button>' +
    '<button class="bas-tab" onclick="spBASTab(\'' +
    projId +
    "','faults',this)\">" +
    faultTabLabel +
    '</button>' +
    '</div>' +
    '<div id="bas-panel-data-' +
    projId +
    '">' +
    '<div style="margin-bottom:8px;display:flex;gap:8px;align-items:center">' +
    '<select data-ch-filter class="fi" style="font-size:12px;padding:4px 8px;max-width:240px" onchange="spBASFilter(\'' +
    projId +
    '\',this.value)">' +
    bldgOpts +
    '</select>' +
    '</div>' +
    '<div id="bas-table-wrap-' +
    projId +
    '">' +
    _basRenderTable(rows) +
    '</div>' +
    '</div>' +
    '<div id="bas-panel-analysis-' +
    projId +
    '" style="display:none">' +
    _basRenderAnalysis(buildings) +
    '</div>' +
    '<div id="bas-panel-faults-' +
    projId +
    '" style="display:none">' +
    _basRenderFaultDetection(projId, rows) +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

function _basRenderTable(rows) {
  function cell(v) {
    if (v === null || v === undefined || v === '') return '<td class="bas-blank num">—</td>';
    return '<td class="num">' + v + '</td>';
  }
  function cellStr(v) {
    if (!v) return '<td class="bas-blank">—</td>';
    return '<td>' + _escHtml(v) + '</td>';
  }

  var thead =
    '<tr>' +
    '<th>Location</th><th class="num">Zone Temperature</th><th class="num">Heating Setpoint</th><th class="num">Cooling Setpoint</th>' +
    '<th class="num">Def Heating Setpoint</th><th class="num">Def Cooling Setpoint</th><th class="num">Setpoint Adj</th>' +
    '<th class="num">Zone CO2</th><th class="num">RA CO2</th><th class="num">Zone Hum</th>' +
    '<th>Zone State</th><th class="num">Flow Setpoint</th><th class="num">Heat%</th><th class="num">Cool%</th>' +
    '<th class="num">Supply Air Temperature</th><th>Building</th><th>Control Program</th></tr>';

  var tbody = '';
  rows.forEach(function (r) {
    var cls = '';
    if (r.zoneState && r.zoneState !== 'Good') {
      cls = r.zoneState === 'Out of Range' ? ' class="bas-err"' : ' class="bas-warn"';
    }
    tbody +=
      '<tr' +
      cls +
      '>' +
      '<td>' +
      _escHtml(r.location) +
      '</td>' +
      cell(r.zoneTemp) +
      cell(r.heatSP) +
      cell(r.coolSP) +
      cell(r.defHeatSP) +
      cell(r.defCoolSP) +
      cell(r.spAdj) +
      cell(r.zoneCO2) +
      cell(r.raCO2) +
      cell(r.zoneHum) +
      cellStr(r.zoneState) +
      cell(r.flowSP) +
      cell(r.heatPct) +
      cell(r.coolPct) +
      cell(r.sat) +
      cellStr(r.building) +
      cellStr(r.controlProgram) +
      '</tr>';
  });

  return (
    '<div class="bas-wrap"><table class="bas-tbl"><thead>' +
    thead +
    '</thead><tbody>' +
    tbody +
    '</tbody></table></div>'
  );
}

function _basRenderAnalysis(buildings) {
  if (!buildings.length)
    return '<div style="color:var(--text3);padding:20px;text-align:center">No building data.</div>';

  function row(label, val, unit) {
    var display = val !== null && val !== undefined ? val + (unit || '') : '—';
    return (
      '<div class="bas-sum-row"><span class="lbl">' + label + '</span><span class="val">' + display + '</span></div>'
    );
  }

  var totalProgs = 0,
    totalUnique = 0,
    totalAudit = 0,
    totalImpl = 0,
    totalZones = 0;

  var cards = buildings
    .map(function (b) {
      totalProgs += b.totalProgs;
      totalUnique += b.uniqueProgs;
      totalAudit += b.auditHrs;
      totalImpl += b.implHrs;
      totalZones += b.count;
      return (
        '<div class="bas-sum-card">' +
        '<h4>' +
        _escHtml(b.building) +
        ' <span style="font-weight:400;font-size:11px;color:var(--text3)">(' +
        b.count +
        ' zones)</span></h4>' +
        row('Avg Heating SP', b.avgHeatSP, '°F') +
        row('Avg Cooling SP', b.avgCoolSP, '°F') +
        row('Avg Default Heat SP', b.avgDefHeatSP, '°F') +
        row('Avg Default Cool SP', b.avgDefCoolSP, '°F') +
        row('Avg Zone Temp', b.avgZoneTemp, '°F') +
        row('Avg SP Adjustment', b.avgSPAdj) +
        row('Avg Zone CO2', b.avgCO2, ' ppm') +
        row('Avg RA CO2', b.avgRACO2, ' ppm') +
        row('Avg Zone Humidity', b.avgHum, '%') +
        row('Control Programs', b.totalProgs) +
        row('Unique Programs', b.uniqueProgs) +
        row('Programs to Change', b.changedProgs) +
        row('Audit Time', b.auditHrs, ' hrs') +
        row('Implementation Time', b.implHrs, ' hrs') +
        '</div>'
      );
    })
    .join('');

  var totals =
    '<div class="bas-sum-card" style="border-color:var(--em);background:var(--s1)">' +
    '<h4>Totals</h4>' +
    row('Total Zones', totalZones) +
    row('Total Control Programs', totalProgs) +
    row('Total Unique Programs', totalUnique) +
    row('Total Audit Time', totalAudit, ' hrs') +
    row('Total Implementation Time', totalImpl, ' hrs') +
    '</div>';

  return '<div class="bas-summary-grid">' + totals + cards + '</div>';
}

function spBASTab(projId, tab, btn) {
  var tabs = btn.parentElement.querySelectorAll('.bas-tab');
  tabs.forEach(function (t) {
    t.classList.remove('active');
  });
  btn.classList.add('active');
  var dataPanel = document.getElementById('bas-panel-data-' + projId);
  var analysisPanel = document.getElementById('bas-panel-analysis-' + projId);
  var faultPanel = document.getElementById('bas-panel-faults-' + projId);
  if (dataPanel) dataPanel.style.display = tab === 'data' ? '' : 'none';
  if (analysisPanel) analysisPanel.style.display = tab === 'analysis' ? '' : 'none';
  if (faultPanel) faultPanel.style.display = tab === 'faults' ? '' : 'none';
}

/* ── SHC Fault Detection ─────────────────────────────── */

function detectSHCFaults(zones) {
  // For each zone row: if heatPct > 0 AND coolPct > 0, flag it
  // Returns array sorted by severity (highest combined %) first
  var faults = [];
  (zones || []).forEach(function (r) {
    var h = r.heatPct;
    var c = r.coolPct;
    if (h === null || h === undefined || c === null || c === undefined) return;
    if (h > 0 && c > 0) {
      faults.push({
        zoneName: r.location || '(Unknown)',
        building: r.building || '',
        heatPct: h,
        coolPct: c,
        zoneTemp: r.zoneTemp !== null && r.zoneTemp !== undefined ? r.zoneTemp : null,
        heatSP: r.heatSP !== null && r.heatSP !== undefined ? r.heatSP : null,
        coolSP: r.coolSP !== null && r.coolSP !== undefined ? r.coolSP : null,
        severity: h + c, // higher combined % = more energy waste
      });
    }
  });
  faults.sort(function (a, b) {
    return b.severity - a.severity;
  });
  return faults;
}

function _basHealthScore(faultCount, totalZones) {
  if (!totalZones) return null;
  return Math.max(0, Math.round(100 - (faultCount / totalZones) * 100));
}

function _basRenderFaultDetection(projId, rows) {
  var totalZones = (rows || []).length;
  var faults = detectSHCFaults(rows);
  var faultCount = faults.length;
  var score = _basHealthScore(faultCount, totalZones);
  var scoreColor =
    score === null ? 'var(--text3)' : score >= 90 ? 'var(--green,#22c55e)' : score >= 70 ? 'var(--em)' : 'var(--red)';

  var badgeText = totalZones
    ? faultCount + ' of ' + totalZones + ' zone' + (totalZones !== 1 ? 's' : '') + ' with SHC faults'
    : '—';

  var scoreHtml =
    score !== null
      ? '<div style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;background:var(--s2);border:1px solid var(--border2);font-size:12px;font-weight:600;color:' +
        scoreColor +
        '">' +
        'BAS Health Score: <span style="font-size:15px;font-weight:700">' +
        score +
        '%</span>' +
        '</div>'
      : '';

  var badgeColor = faultCount === 0 ? 'var(--green,#22c55e)' : 'var(--red)';
  var badgeHtml =
    '<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:' +
    (faultCount === 0 ? 'rgba(34,197,94,.15)' : 'rgba(244,63,94,.15)') +
    ';color:' +
    badgeColor +
    ';border:1px solid ' +
    (faultCount === 0 ? 'rgba(34,197,94,.3)' : 'rgba(244,63,94,.3)') +
    '">' +
    badgeText +
    '</span>';

  var header =
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">' +
    '<div style="display:flex;align-items:center;gap:10px">' +
    badgeHtml +
    '</div>' +
    scoreHtml +
    '</div>';

  if (!totalZones) {
    return (
      header +
      '<div style="color:var(--text3);padding:20px;text-align:center;font-size:13px">No zone data in this snapshot.</div>'
    );
  }

  if (!faultCount) {
    return (
      header +
      '<div style="color:var(--text3);padding:20px;text-align:center;font-size:13px">No simultaneous heating and cooling faults detected in this snapshot.</div>'
    );
  }

  // Render fault table
  var thead =
    '<tr>' +
    '<th>Building</th>' +
    '<th>Zone</th>' +
    '<th class="num">Heat %</th>' +
    '<th class="num">Cool %</th>' +
    '<th class="num">Zone Temperature</th>' +
    '<th class="num">Heating Setpoint</th>' +
    '<th class="num">Cooling Setpoint</th>' +
    '<th>Severity</th>' +
    '</tr>';

  var tbody = faults
    .map(function (f) {
      // Severity tiers: both > 25% = severe (red), otherwise moderate (amber)
      var isSevere = f.heatPct > 25 && f.coolPct > 25;
      var rowBg = isSevere ? 'background:rgba(244,63,94,.08)' : 'background:rgba(245,158,11,.07)';
      var severityLabel = isSevere
        ? '<span style="color:var(--red);font-weight:700;font-size:11px">Severe</span>'
        : '<span style="color:var(--em);font-weight:600;font-size:11px">Moderate</span>';
      function cell(v) {
        return v !== null && v !== undefined ? '<td class="num">' + v + '</td>' : '<td class="bas-blank num">—</td>';
      }
      return (
        '<tr style="border-bottom:1px solid var(--border);' +
        rowBg +
        '">' +
        '<td>' +
        _escHtml(f.building || '—') +
        '</td>' +
        '<td>' +
        _escHtml(f.zoneName) +
        '</td>' +
        '<td class="num" style="color:var(--red);font-weight:600">' +
        f.heatPct +
        '%</td>' +
        '<td class="num" style="color:#38bdf8;font-weight:600">' +
        f.coolPct +
        '%</td>' +
        cell(f.zoneTemp !== null ? f.zoneTemp + '°F' : null) +
        cell(f.heatSP !== null ? f.heatSP + '°F' : null) +
        cell(f.coolSP !== null ? f.coolSP + '°F' : null) +
        '<td>' +
        severityLabel +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  var table =
    '<div class="bas-wrap"><table class="bas-tbl"><thead>' +
    thead +
    '</thead><tbody>' +
    tbody +
    '</tbody></table></div>';

  var legend =
    '<div style="font-size:11px;color:var(--text3);margin-top:8px;display:flex;gap:16px;flex-wrap:wrap">' +
    '<span><span style="color:var(--red);font-weight:700">Severe</span> — both Heat% and Cool% above 25%</span>' +
    '<span><span style="color:var(--em);font-weight:600">Moderate</span> — any simultaneous heating and cooling</span>' +
    '</div>';

  return header + table + legend;
}

function spBASFilter(projId, building) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p) return;
  var snaps = _basGetSnapshots(p);
  var snap = _basGetActiveSnap(projId, snaps);
  if (!snap) return;
  var rows = snap.rows || [];
  if (building)
    rows = rows.filter(function (r) {
      return r.building === building;
    });
  var wrap = document.getElementById('bas-table-wrap-' + projId);
  if (wrap) wrap.innerHTML = _basRenderTable(rows);
}

function spBASSelectSnap(projId, snapId) {
  if (!window._basActiveSnap) window._basActiveSnap = {};
  window._basActiveSnap[projId] = snapId;
  renderSetpointsTab(projId);
}

function spClearBASSnapshot(projId, snapId) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p) return;
  var snaps = _basGetSnapshots(p);
  p.basSnapshots = snaps.filter(function (s) {
    return s.id !== snapId;
  });
  if (!p.basSnapshots.length) delete p.basSnapshots;
  sset('en_projects', projects);
  showToast('BAS snapshot removed');
  renderSetpointsTab(projId);
}

/* ══════════════════════════════════════════════════════
         WIRE UP NEW TABS IN sPTab
      ══════════════════════════════════════════════════════ */
