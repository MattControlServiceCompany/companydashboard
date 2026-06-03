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
  (b.meters || []).forEach(function (m) {
    if (m.baselineInclude === false) return;
    if (!(m.baseline && m.baseline.months && m.baseline.months.length >= 3)) return;
    var mbills = (m.bills || []).slice().sort(function (a, c) {
      return _parseISO(a.start) - _parseISO(c.start);
    });
    var mincl = m.inclusive !== false;
    var mSav = getMeterSavings(m, mbills, mincl, projId, b.id).byCalMo;
    Object.keys(mSav).forEach(function (mo) {
      actualSavByCalMo[mo] = (actualSavByCalMo[mo] || 0) + mSav[mo];
    });
  });
  var hasActual = Object.keys(actualSavByCalMo).length > 0;
  var msrSav = getBldgMeasureSavingsByMo(projId, b.id);
  var bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
  var bspCfg = DB.get(bspKey, {});
  var savPct = (bspCfg.savingsPct || 11) / 100;
  var $f = function (v) {
    return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var savColor = function (v) {
    return v >= 0 ? 'var(--em)' : 'var(--danger)';
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
  var rows = MN.map(function (mn, mo) {
    var base = moBase[mo];
    var projSav = msrSav ? msrSav[mo] || 0 : base * savPct;
    var act = actualSavByCalMo[mo] != null ? actualSavByCalMo[mo] : null;
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
      '<td style="' +
      tdS(act != null ? savColor(act) : 'var(--text3)') +
      '">' +
      (act != null ? (act < 0 ? '−' : '') + $f(act) : '—') +
      '</td>' +
      '<td style="' +
      tdS(pct != null ? savColor(pct) : 'var(--text3)') +
      '">' +
      (pct != null ? (pct < 0 ? '−' : '') + Math.abs(pct).toFixed(1) + '%' : '—') +
      '</td>' +
      '</tr>'
    );
  }).join('');
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
        : annBase * savPct,
    ) +
    '</td>' +
    '<td style="' +
    tdS(hasActual ? savColor(annAct) : 'var(--text3)') +
    '">' +
    (hasActual ? (annAct < 0 ? '−' : '') + $f(annAct) : '—') +
    '</td>' +
    '<td style="' +
    tdS(annPct != null ? savColor(annPct) : 'var(--text3)') +
    '">' +
    (annPct != null ? (annPct < 0 ? '−' : '') + Math.abs(annPct).toFixed(1) + '%' : '—') +
    '</td>' +
    '</tr></tfoot></table></div></div>'
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
  bldgs.forEach(function (b) {
    (b.meters || []).forEach(function (m) {
      if (m.baselineInclude === false) return;
      var bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      var bills = (m.bills || []).slice().sort(function (a, c) {
        return _parseISO(a.start) - _parseISO(c.start);
      });
      var incl = m.inclusive !== false;
      var sav = getMeterSavings(m, bills, incl, projId, b.id).byCalMo;
      Object.keys(sav).forEach(function (mo) {
        actSavByMo[mo] = (actSavByMo[mo] || 0) + sav[mo];
      });
    });
  });
  var hasActual = Object.keys(actSavByMo).length > 0;
  var $f = function (v) {
    return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var savColor = function (v) {
    return v >= 0 ? 'var(--em)' : 'var(--danger)';
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
  var rows = MN.map(function (mn, mo) {
    var base = moBase[mo] || 0;
    var act = actSavByMo[mo] != null ? actSavByMo[mo] : null;
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
      tdS(act != null ? savColor(act) : 'var(--text3)') +
      '">' +
      (act != null ? (act < 0 ? '−' : '') + $f(act) : '—') +
      '</td>' +
      '<td style="' +
      tdS(pct != null ? savColor(pct) : 'var(--text3)') +
      '">' +
      (pct != null ? (pct < 0 ? '−' : '') + Math.abs(pct).toFixed(1) + '%' : '—') +
      '</td>' +
      '</tr>'
    );
  }).join('');
  var annPct = annBase > 0 && hasActual ? (annAct / annBase) * 100 : null;
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
    tdS(hasActual ? savColor(annAct) : 'var(--text3)') +
    '">' +
    (hasActual ? (annAct < 0 ? '−' : '') + $f(annAct) : '—') +
    '</td>' +
    '<td style="' +
    tdS(annPct != null ? savColor(annPct) : 'var(--text3)') +
    '">' +
    (annPct != null ? (annPct < 0 ? '−' : '') + Math.abs(annPct).toFixed(1) + '%' : '—') +
    '</td>' +
    '</tr></tfoot></table></div></div>'
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
      if (m.baselineInclude === false) return;
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
  // Year-over-year: collect by year
  let yearData = {}; // {year: {kwh:[12], kw:[12], gas:[12], cost:[12]}}
  let blYears = new Set();
  let bldgYearData = {}; // {bldgName: {year: {kwh:[12], kw:[12], gas:[12], cost:[12]}}}

  const _pfe = (v) => parseFloat(v) || 0;
  const _elecCommodityCost = (bill) => _pfe(bill.kwhCost) + _pfe(bill.kwCost) + _pfe(bill.facKWCost);
  const _gasCommodityCost = (bill) => _pfe(bill.totalCost) || _pfe(bill.thermCost) || _pfe(bill.cost) || 0;
  const _propaneCommodityCost = (bill) => _pfe(bill.totalCost) || _pfe(bill.cost) || 0;

  bldgs.forEach((b) => {
    const bName = b.name || 'Unknown';
    if (!bldgYearData[bName]) bldgYearData[bName] = {};
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const isElec = m.commodity === 'Electric';
      const isGas = m.commodity === 'Gas';
      const isPropane = m.commodity === 'Propane';
      const bl = m.baseline || {};
      // bl.months is an array of year-month strings like ['2024-01','2024-02',...]
      // populated when the user saves a baseline period. When missing, fall back to
      // treating every bill as baseline so graphics still render against stored data.
      const blSet = Array.isArray(bl.months) && bl.months.length ? new Set(bl.months) : null;

      const _mIncl = m.inclusive !== false;
      const _mBills = m.bills || [];
      _mBills.forEach((bill) => {
        // Use normMonth for consistent month assignment across all views
        let ym = normMonth(bill.start, bill.end, _mIncl, _mBills);
        let yr = null,
          mi = -1;
        if (ym && /^\d{4}-\d{2}/.test(ym)) {
          yr = parseInt(ym.slice(0, 4));
          mi = parseInt(ym.slice(5, 7)) - 1;
        } else {
          // Fallback for bills without valid dates
          const ymSrc = bill.end || bill.start || '';
          if (ymSrc && /^\d{4}-\d{2}/.test(ymSrc)) {
            yr = parseInt(ymSrc.slice(0, 4));
            mi = parseInt(ymSrc.slice(5, 7)) - 1;
            ym = ymSrc.slice(0, 7);
          }
        }
        if (mi < 0) return;

        // Baseline membership: if a baseline was saved, use its YM set;
        // otherwise treat every bill as baseline so charts still render.
        const isBaseline = blSet ? ym && blSet.has(ym) : true;

        if (isBaseline) {
          // Baseline data
          if (isElec) {
            blKwh[mi] += parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            blCost[mi] += _elecCommodityCost(bill);
          }
          if (isGas) blGas[mi] += parseFloat(bill.therms) || parseFloat(bill.usage) || 0;
          if (isGas) blCost[mi] += _gasCommodityCost(bill);
          if (isPropane) {
            blPropane[mi] += parseFloat(bill.gallonsDelivered) || parseFloat(bill.kwh) || parseFloat(bill.usage) || 0;
            blCost[mi] += _propaneCommodityCost(bill);
          }
          if (yr) blYears.add(yr);
          if (ym) blYmPerMo[mi].add(ym);
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
            const gasVal = parseFloat(bill.therms) || parseFloat(bill.usage) || 0;
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
      if (m.commodity !== 'Propane' || m.baselineInclude === false) return;
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
      if (m.baselineInclude === false) return;
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

      // kW CDD regression: normalize kW using the same pattern as perf-table.js
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
  const blKbtu = toKBtu(totalBlKwh, totalBlGas, totalBlPropane);
  const blEui = sqft > 0 ? blKbtu / sqft : 0;
  const cbecsEui = CBECS_EUI[p.type] || 48.5;

  const sortedYears = Object.keys(yearData).map(Number).sort();
  const latestYear = sortedYears.length > 0 ? sortedYears[sortedYears.length - 1] : null;

  // Build baseline kBtu per calendar month for completeness checks
  const blKbtuPerMo = blKwhAvg.map((v, mi) => toKBtu(v, blGasAvg[mi], blPropaneAvg[mi]));

  // Build a flat list of year-months with complete data, sorted chronologically.
  // A month is "complete" if its kBtu is at least 25% of the baseline average
  // for that calendar month — filters out straddling bills that barely touch a month.
  const allYms = [];
  for (const y of sortedYears) {
    const yd = yearData[y];
    for (let mi = 0; mi < 12; mi++) {
      if (yd.kwh[mi] > 0 || yd.gas[mi] > 0 || yd.propane[mi] > 0) {
        const moKbtu = toKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
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
    r12Kbtu += toKBtu(m.kwh, m.gas, m.propane || 0);
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
        const moKbtu = toKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
        return blKbtuPerMo[mi] <= 0 || moKbtu >= blKbtuPerMo[mi] * 0.25;
      });
      if (hasAll) {
        let qKbtu = 0,
          qBlKbtu = 0;
        ms.forEach((mi) => {
          qKbtu += toKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
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
    const moKbtu = toKBtu(latestMo.kwh, latestMo.gas, latestMo.propane || 0);
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
          'source EUI ' +
          srcEui.toFixed(0) +
          ' kBtu/ft²' +
          ' <span title="Based on source EUI vs CBECS K-12 data. Official score requires Portfolio Manager." style="cursor:help;color:var(--text3)">&#9432;</span>';
      }
    } else {
      estarScoreEl.textContent = '—';
      if (estarScoreSubEl) estarScoreSubEl.textContent = 'source EUI est.';
    }
  }

  // Compute actual savings from meter performance (single source of truth)
  const blCostAvg = blCost.map((v, mi) => v / (blYmPerMo[mi].size || 1));
  const totalBlCost = blCostAvg.reduce((a, b) => a + b, 0);
  const curYear = String(new Date().getFullYear());
  const egfxSavByMo = {};
  const egfxSavByYm = {};
  const egfxSavByCommodity = { Electric: 0, Gas: 0, Propane: 0 };
  const egfxUnitsSaved = { kwh: 0, kw: 0, therms: 0, gallons: 0 };
  const egfxCostSavedByCommodity = { Electric: 0, Gas: 0, Propane: 0 };
  bldgs.forEach((b) => {
    (b.meters || []).forEach((m) => {
      if (m.baselineInclude === false) return;
      if (!isCalcCommodity(projId, m.commodity)) return;
      const bl = m.baseline;
      if (!bl || !bl.months || bl.months.length < 3) return;
      const mBills = (m.bills || []).slice().sort((a, c) => _parseISO(a.start) - _parseISO(c.start));
      const mIncl = m.inclusive !== false;
      const savResult = getMeterSavings(m, mBills, mIncl, projId, b.id);
      let meterCostSav = 0;
      Object.entries(savResult.byYM).forEach(([ym, v]) => {
        egfxSavByYm[ym] = (egfxSavByYm[ym] || 0) + v;
        if (ym.startsWith(curYear)) {
          egfxSavByMo[ym] = (egfxSavByMo[ym] || 0) + v;
          meterCostSav += v;
        }
      });
      if (egfxCostSavedByCommodity[m.commodity] !== undefined) {
        egfxCostSavedByCommodity[m.commodity] += meterCostSav;
      }
      Object.entries(savResult.unitsByYM).forEach(([ym, u]) => {
        if (!ym.startsWith(curYear)) return;
        egfxUnitsSaved.kwh += u.kwh || 0;
        egfxUnitsSaved.kw += u.kw || 0;
        egfxUnitsSaved.therms += u.therms || 0;
        egfxUnitsSaved.gallons += u.gallons || 0;
      });
    });
  });
  const hasEgfxSav = Object.keys(egfxSavByYm).some((ym) => ym.startsWith(curYear));
  const totalEgfxSav = hasEgfxSav
    ? Object.entries(egfxSavByYm)
        .filter(([ym]) => ym.startsWith(curYear))
        .reduce((s, [, v]) => s + v, 0)
    : 0;

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
      if (_bMeters.length > 0 && _bMeters.every((m) => m.baselineInclude === false)) return;
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
      curSavEl.textContent = (totalEgfxSav >= 0 ? '' : '-') + '$' + Math.abs(Math.round(totalEgfxSav)).toLocaleString();
      curSavEl.style.color = totalEgfxSav >= 0 ? 'var(--green)' : 'var(--danger)';
      if (curSavSubEl) curSavSubEl.textContent = pct.toFixed(1) + '% actual savings';
    } else {
      curSavEl.textContent = '—';
      curSavEl.style.fontSize = '14px';
      if (curSavSubEl) curSavSubEl.textContent = 'no post-baseline data yet';
    }
  }

  // Per-commodity savings cards
  const commSavContainer = document.getElementById(`egfx-commodity-savings-${projId}`);
  if (commSavContainer) {
    const _$f = (v) => (v >= 0 ? '' : '-') + '$' + Math.abs(Math.round(v)).toLocaleString();
    const _$n = (v) => Math.round(Math.abs(v)).toLocaleString();
    const _clr = (v) => (v >= 0 ? 'var(--green)' : 'var(--danger)');
    let cards = '';
    if (totalBlKwh > 0) {
      cards +=
        '<div class="card" style="background:var(--s1);padding:12px;text-align:center">' +
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
        '<div class="card" style="background:var(--s1);padding:12px;text-align:center">' +
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
        '<div class="card" style="background:var(--s1);padding:12px;text-align:center">' +
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
        '<div class="card" style="background:var(--s1);padding:12px;text-align:center">' +
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
          Math.max(0, kwhSaved),
          Math.max(0, gasSaved),
          Math.max(0, propSaved),
          _stateCode,
        );
        const _pol = _pc.pollutants;
        const _eq = _pc.equivalents;
        const _fmt = (n) => Math.ceil(Math.abs(n)).toLocaleString();
        _pcEl.innerHTML =
          '<div style="font-weight:800;font-size:14px;letter-spacing:.8px;margin-bottom:12px;color:var(--text)">DETAILED POLLUTION CREDIT CALCULATIONS</div>' +
          '<div style="margin-bottom:14px;color:var(--text2)">The emission reductions produced from implementing this project are equivalent to saving:</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.co2) +
          '</strong> total pounds of CO2 reduction (carbon dioxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.ch4) +
          '</strong> total pounds of CH4 reduction (methane)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.n2o) +
          '</strong> total pounds of N2O reduction (nitrous oxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.so2) +
          '</strong> total pounds of SO2 reduction (sulfur dioxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.nox) +
          '</strong> total pounds of NOX reduction (nitrogen oxide)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.hg_oz) +
          '</strong> total ounces of HG reduction (mercury)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.pm10_oz) +
          '</strong> total ounces of PM10 reduction (particles of 10 micrometers or less)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.pm_filt_oz) +
          '</strong> total ounces of PM2.5 reduction (fine particulate matter)</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_pol.voc_oz) +
          '</strong> total ounces of VOC reduction (volatile organic compounds)</div>' +
          '<div style="margin-bottom:18px"><strong>' +
          _fmt(_pol.co_oz) +
          '</strong> total ounces of CO reduction (carbon monoxide)</div>' +
          '<div style="margin-bottom:14px;color:var(--text2)">This is equivalent to:</div>' +
          '<div style="margin-bottom:4px">Removing <strong>' +
          _fmt(_eq.carsRemoved) +
          '</strong> cars from the road each year</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.gallonsGasoline) +
          '</strong> gallons of gasoline each year</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.tankerTrucks) +
          '</strong> tanker trucks of gasoline each year</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.barrelsOil) +
          '</strong> barrels of oil each year</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.households) +
          '</strong> households worth of electricity each year</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_eq.treeSeedlings) +
          '</strong> tree seedlings allowed to grow for 10 years each year</div>' +
          '<div style="margin-bottom:4px"><strong>' +
          _fmt(_eq.acresForest) +
          '</strong> acres of forest preserved from deforestation</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.railcarsCoal) +
          '</strong> railcars of coal each year</div>' +
          '<div style="margin-bottom:4px">Recycling <strong>' +
          _fmt(_eq.tonsRecycled) +
          '</strong> tons of waste rather than landfilling each year</div>' +
          '<div style="margin-bottom:4px">Conserving <strong>' +
          _fmt(_eq.propaneCylinders) +
          '</strong> propane cylinders used for home barbeques each year</div>' +
          '<div style="margin-bottom:18px"><strong>' +
          _fmt(_eq.coalPlants) +
          '</strong> coal-fired power plant emissions each year</div>' +
          '<div style="font-size:11px;color:var(--text3);line-height:1.6">' +
          'Data from eGRID (First edition with year 2023 data (eGRID2023 Version 1.0 Rev 1) https://www.epa.gov/egrid)<br>' +
          'State: <strong>' +
          _stateCode +
          '</strong> • Inputs: <strong>' +
          Math.round(Math.max(0, kwhSaved)).toLocaleString() +
          '</strong> kWh + <strong>' +
          Math.round(Math.max(0, gasSaved)).toLocaleString() +
          '</strong> Therms + <strong>' +
          Math.round(Math.max(0, propSaved)).toLocaleString() +
          '</strong> Gal Propane' +
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
          bBlKbtu[mi] += toKBtu(bd.kwh[mi], bd.gas[mi], bd.propane[mi]);
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
          const moKbtu = toKBtu(bd.kwh[mi], bd.gas[mi], bd.propane[mi]);
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
      kbtu += toKBtu(m.kwh, m.gas, m.propane || 0);
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
    return `<div class="card" style="background:var(--s1);padding:14px;margin-bottom:12px">
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
        blAvgArr: blAvgArr,
      },
      { interactive: true },
    );
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
        if (m.commodity !== 'Propane' || m.baselineInclude === false) return;
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

  chartsEl.innerHTML = `
          ${_yoyHtml('Electric kWh', '⚡', 'kWh', 'kwh', blKwhAvg)}
          ${totalBlKwh > 0 ? _yoyHtml('Electric kW', '⚡', 'kW', 'kw', _blKwFromMap) : ''}
          ${hasGas ? _yoyHtml('Gas Therms', '🔥', 'therms', 'gas', blGasAvg) : ''}
          ${hasPropane ? _yoyHtml('Propane Gallons', '🛢️', 'gal', 'propane', blPropaneBl) : ''}
          <div class="card" style="background:var(--s1);padding:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">📊 Annual Summary by Year</div>
            <div style="overflow-x:auto">
              <table class="dtbl" style="min-width:500px">
                <thead><tr><th>Year</th><th style="text-align:right">kWh</th><th style="text-align:right">kW</th><th style="text-align:right">Gas Therms</th>${hasPropane ? '<th style="text-align:right">Propane Gal</th>' : ''}<th style="text-align:right">Site EUI kBtu/ft²</th><th style="text-align:right">Baseline Site EUI</th><th style="text-align:right">vs Baseline</th></tr></thead>
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
                          const mk = toKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
                          if (blKbtuPerMo[mi] <= 0 || mk >= blKbtuPerMo[mi] * 0.25) moCount++;
                        }
                      }
                      const isPartial = moCount > 0 && moCount < 12;
                      const annF = isPartial ? 12 / moCount : 1;
                      const ykwh = ykwhRaw * annF;
                      const ygas = ygasRaw * annF;
                      const ypropane = ypropaneRaw * annF;
                      const ykbtu = toKBtu(ykwh, ygas, ypropane);
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
          <div class="card" style="background:var(--s1);padding:14px;margin-top:12px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">🏢 Annual Summary by Building</div>
            <div style="overflow-x:auto">
              <table class="dtbl" style="min-width:600px;border-collapse:collapse">
                <thead><tr style="background:var(--s1)"><th style="text-align:left;padding:8px 10px">Building</th><th style="padding:8px 6px">Year</th><th style="text-align:right;padding:8px 10px">kWh</th><th style="text-align:right;padding:8px 10px">kW</th><th style="text-align:right;padding:8px 10px">Gas Therms</th>${hasPropane ? '<th style="text-align:right;padding:8px 10px">Propane Gal</th>' : ''}<th style="text-align:right;padding:8px 10px">Cost</th><th style="text-align:right;padding:8px 10px">Site EUI</th></tr></thead>
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
                            const bkbtu = toKBtu(bkwh, bgas, bpropane);
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
            const blPeriod =
              blYearList.length === 1 ? String(blYearList[0]) : blYearList[0] + '–' + blYearList[blYearList.length - 1];
            const hasPropaneBL = totalBlPropane > 0;
            const blCostAvg2 = blCost.map((v, mi) => v / (blYmPerMo[mi].size || 1));
            let tbl = '<div class="card" style="background:var(--s1);padding:14px;margin-top:12px">';
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
              const mkbtu = toKBtu(blKwhAvg[mi], blGasAvg[mi], blPropaneAvg[mi]);
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
              totalBlKbtu += toKBtu(bkwh, bgas, bprop);
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
      return `<div class="card" style="background:var(--s1);padding:14px;margin-top:12px">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">📊 Site EUI Benchmark — Your Buildings vs CBECS National Median</div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:8px">kBtu/ft²/yr · rolling 12-month data · buildings without sqft are excluded</div>
              <div style="position:relative;height:${chartH}px"><canvas id="${benchCanvasId}"></canvas></div>
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
              totalBlKbtu += toKBtu(bkwh, bgas, bprop);
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
      return `<div class="card" style="background:var(--s1);padding:14px;margin-top:12px">
              <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">🏆 Building Performance Benchmarking</div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:12px">Ranked by EUI (highest = most opportunity) · rolling 12-month data · CBECS percentiles + EnergyStar score-75 threshold</div>
              <div style="overflow-x:auto">
                <table class="dtbl" style="min-width:700px">
                  <thead><tr>
                    <th style="text-align:left">#</th>
                    <th style="text-align:left">Building</th>
                    <th style="text-align:left">Type</th>
                    <th style="text-align:right">Sqft</th>
                    <th style="text-align:right">Baseline Site EUI</th>
                    <th style="text-align:right">Current Site EUI</th>
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
                Site EUI = kBtu/ft²/yr (energy at the meter) · CBECS = DOE Commercial Buildings Energy Consumption Survey national median ·
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
        '<div class="card" style="background:var(--s1);padding:14px;margin-top:12px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px">💰 Monthly Savings: Projected vs Current</div>' +
        '<div style="height:173px;position:relative;margin-bottom:14px"><canvas id="egfx-savChart-' +
        projId +
        '"></canvas></div>' +
        '</div>';
      qHtml += '<div class="card" style="background:var(--s1);padding:14px;margin-top:12px">';
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
              const actKbtu = toKBtu(yd.kwh[mi], yd.gas[mi], yd.propane[mi]);
              const blRef = blKbtuPerMo[mi];
              if (blRef > 0 && actKbtu < blRef * 0.25) continue;
              hasActualData = true;
              moWithData++;
            }
          }
          if (!hasActualData) continue;
          if (moWithData < 3) continue;
          let costSav = 0;
          for (const mi of qMonths[qi]) {
            const ym = y + '-' + String(mi + 1).padStart(2, '0');
            costSav += egfxSavByYm[ym] || 0;
          }
          const costPct = qBlCost > 0 ? (costSav / qBlCost) * 100 : 0;
          const savColor = costSav >= 0 ? 'var(--green)' : 'var(--red)';
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
          qHtml +=
            '<td style="text-align:right;font-family:var(--mono);color:' +
            savColor +
            '">' +
            (costSav >= 0 ? '' : '-') +
            $f(costSav) +
            '</td>';
          qHtml +=
            '<td style="text-align:right;font-family:var(--mono);color:' +
            savColor +
            '">' +
            (costSav >= 0 ? '+' : '') +
            costPct.toFixed(1) +
            '%</td></tr>';
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
        } else {
          const bspKey = 'bldgsavproj_cfg_' + (b.id || b.name);
          const bspCfg = DB.get(bspKey, {});
          const savPct = (bspCfg.savingsPct != null ? bspCfg.savingsPct : 0) / 100;
          const bMoBase = aggBaseMoMapForBldgs([b]);
          for (let mo = 0; mo < 12; mo++) _egfxProjSavByMo[mo] += (bMoBase[mo] || 0) * savPct;
        }
      });
      const projVals = months.map((_, mo) => _egfxProjSavByMo[mo]);
      const actVals = months.map((_, mo) => {
        const ym = curYear + '-' + String(mo + 1).padStart(2, '0');
        return egfxSavByMo[ym] != null ? egfxSavByMo[ym] : null;
      });
      _maCharts[savChartId] = new Chart(savChartCv, {
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
              labels: { color: 'rgba(200,220,240,.9)', font: { size: 10 }, boxWidth: 12, padding: 10 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  ctx.dataset.label + ': $' + (ctx.raw != null ? Math.round(ctx.raw).toLocaleString() : '—'),
              },
            },
          },
          scales: {
            x: { ticks: { color: 'rgba(180,200,220,.8)', font: { size: 10 } }, grid: { display: false } },
            y: {
              ticks: {
                color: 'rgba(180,200,220,.8)',
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
  showToast('Export coming soon');
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
  const zones = displayRecord ? displayRecord.zones : [];

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
        const bZones = rec ? rec.zones : [];
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
                    ? `<button class="btn btn-ghost btn-sm" onclick="spAddZoneRow('${projId}','${activeBldgId}')">+ Add Zone</button>
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
                  ? `<!-- CSV Upload Area -->
              <div id="sp-upload-${projId}" style="border:2px dashed var(--border2);border-radius:8px;padding:16px;text-align:center;margin-bottom:16px;cursor:pointer;transition:border-color .2s"
                   onclick="document.getElementById('sp-file-${projId}').click()"
                   ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
                   ondragleave="this.style.borderColor='var(--border2)'"
                   ondrop="spHandleDrop(event,'${projId}','${activeBldgId}')">
                <div style="font-size:22px;margin-bottom:4px">📂</div>
                <div style="font-size:12px;font-weight:600;color:var(--text)">Drop BAS export here or click to browse</div>
                <div style="font-size:11px;color:var(--text3);margin-top:4px">CSV, XLSX, or Niagara equipment snapshot (Zone/System · Occ/Unocc Heat/Cool · Schedule)</div>
                <input type="file" id="sp-file-${projId}" accept=".csv,.txt,.xlsx,.xls" style="display:none"
                       onchange="spHandleFileInput(event,'${projId}','${activeBldgId}')">
              </div>`
                  : ''
              }
              ${isViewingSnapshot ? `<div style="margin-bottom:12px;padding:8px 12px;background:var(--s2);border:1px solid var(--border2);border-radius:6px;font-size:11px;color:var(--text2)">Viewing saved snapshot: <strong style="color:var(--text)">${_escHtml(activeSnapData.label)}</strong> — switch to <a href="#" style="color:var(--accent);text-decoration:none" onclick="event.preventDefault();spViewSnapshot('${projId}',null)">Current</a> to edit</div>` : ''}
              <!-- Zone Table -->
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12px" id="sp-table-${projId}">
                  <thead>
                    <tr style="border-bottom:1px solid var(--border);text-align:left">
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);min-width:150px">${isAvg ? 'Building' : 'Zone / System'}</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Occ Heat °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Occ Cool °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Unocc Heat °F</th>
                      <th style="padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);text-align:center;min-width:80px">Unocc Cool °F</th>
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

function _spZoneRow(projId, bldgId, z, idx) {
  const v = (val) => (val !== undefined && val !== null ? val : '');
  return `<tr style="border-bottom:1px solid var(--border)" data-sp-idx="${idx}">
          <td style="padding:4px 6px"><input class="fi" style="width:100%;font-size:12px" type="text"
            value="${_escHtml(z.name || '')}" placeholder="Zone or system name"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'name',this.value)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="number" min="50" max="90" step="1"
            value="${v(z.occHeat)}" placeholder="70"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'occHeat',parseFloat(this.value)||null)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="number" min="60" max="95" step="1"
            value="${v(z.occCool)}" placeholder="74"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'occCool',parseFloat(this.value)||null)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="number" min="45" max="80" step="1"
            value="${v(z.unoccHeat)}" placeholder="60"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'unoccHeat',parseFloat(this.value)||null)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:70px;font-size:12px;font-family:var(--mono);text-align:center" type="number" min="70" max="100" step="1"
            value="${v(z.unoccCool)}" placeholder="85"
            oninput="spUpdateField('${projId}','${bldgId}',${idx},'unoccCool',parseFloat(this.value)||null)"></td>
          <td style="padding:4px 6px"><input class="fi" style="width:100%;font-size:12px" type="text"
            value="${_escHtml(z.schedule || '')}" placeholder="e.g. M-F 6:00a-4:30p"
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
    var vals = arr.map((z) => z[key]).filter((v) => v !== null && v !== undefined && !isNaN(v));
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
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
  snapshots.forEach(function (s) {
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
      '\')" style="font-size:10px;opacity:.6;cursor:pointer;margin-left:2px" title="Delete snapshot">✕</span>' +
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
  if (!p || !p.setpoints) return;
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
  if (!p || !p.setpoints) return;
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
    window._spDraft[key] = JSON.parse(JSON.stringify(rec ? rec.zones : []));
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
      if (inputs[1]) draft[idx].occHeat = parseFloat(inputs[1].value) || null;
      if (inputs[2]) draft[idx].occCool = parseFloat(inputs[2].value) || null;
      if (inputs[3]) draft[idx].unoccHeat = parseFloat(inputs[3].value) || null;
      if (inputs[4]) draft[idx].unoccCool = parseFloat(inputs[4].value) || null;
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

function _spIsXlsx(fname) {
  return /\.xlsx?$/i.test(fname || '');
}

function _spReadXlsx(data, projId, bldgId, fname) {
  if (typeof XLSX === 'undefined') {
    showToast('SheetJS library not loaded ⚠');
    return;
  }
  var wb = XLSX.read(data, { type: 'array' });
  var ws = wb.Sheets[wb.SheetNames[0]];
  var csv = XLSX.utils.sheet_to_csv(ws);
  spParseCSV(csv, projId, bldgId, fname);
}

function spHandleFileInput(evt, projId, bldgId) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const fname = file.name;
  evt.target.value = '';
  const reader = new FileReader();
  if (_spIsXlsx(fname)) {
    reader.onload = (e) => _spReadXlsx(new Uint8Array(e.target.result), projId, bldgId, fname);
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = (e) => spParseCSV(e.target.result, projId, bldgId, fname);
    reader.readAsText(file);
  }
}

function spHandleDrop(evt, projId, bldgId) {
  evt.preventDefault();
  const upload = document.getElementById('sp-upload-' + projId);
  if (upload) upload.style.borderColor = 'var(--border2)';
  const file = evt.dataTransfer.files && evt.dataTransfer.files[0];
  if (!file) return;
  const fname = file.name;
  const reader = new FileReader();
  if (_spIsXlsx(fname)) {
    reader.onload = (e) => _spReadXlsx(new Uint8Array(e.target.result), projId, bldgId, fname);
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = (e) => spParseCSV(e.target.result, projId, bldgId, fname);
    reader.readAsText(file);
  }
}

function spParseCSV(text, projId, bldgId, fileName) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) {
    showToast('CSV appears empty ⚠');
    return;
  }

  // Auto-detect delimiter: comma or tab
  const delim = lines[0].split('\t').length > lines[0].split(',').length ? '\t' : ',';

  function splitRow(row) {
    const result = [];
    let cur = '',
      inQ = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === delim && !inQ) {
        result.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    result.push(cur.trim());
    return result;
  }

  // Skip leading empty rows so real header row is found even if row 0 is blank
  var headerIdx = 0;
  while (headerIdx < lines.length) {
    var testCols = splitRow(lines[headerIdx]);
    if (
      testCols.some(function (c) {
        return c.trim() !== '';
      })
    )
      break;
    headerIdx++;
  }
  if (headerIdx >= lines.length) {
    showToast('No header row found ⚠');
    return;
  }
  const headers = splitRow(lines[headerIdx]).map((h) => h.toLowerCase().trim());

  // Detect BAS equipment snapshot (Niagara/Tridium export)
  const isBAS =
    headers.some((h) => h.includes('heating sp')) &&
    headers.some((h) => h.includes('cooling sp')) &&
    headers.some((h) => h.includes('control program'));
  if (isBAS) {
    spParseBASSnapshot(lines, headers, splitRow, projId, fileName);
    return;
  }

  // Detect multi-building set points spreadsheet (e.g., "Louisburg Set Points.xlsx")
  var colBldgDetect = headers.findIndex(function (h) {
    return h === 'building name';
  });
  if (
    colBldgDetect >= 0 &&
    headers.some(function (h) {
      return h.includes('occupied heating');
    })
  ) {
    _spParseMultiBldgSetpoints(lines, headers, splitRow, projId, colBldgDetect, headerIdx);
    return;
  }

  function findCol(candidates) {
    for (const c of candidates) {
      const idx = headers.findIndex((h) => h.includes(c));
      if (idx >= 0) return idx;
    }
    return -1;
  }
  const colMap = {
    name: findCol(['zone', 'system', 'ahu', 'unit', 'name', 'location', 'equipment affected']),
    occHeat: findCol(['occ heat', 'occupied heat', 'occupied heating', 'occ h', 'occ_heat', 'occupied_heat']),
    occCool: findCol(['occ cool', 'occupied cool', 'occupied cooling', 'occ c', 'occ_cool', 'occupied_cool']),
    unoccHeat: findCol([
      'unocc heat',
      'unoccupied heat',
      'unoccupied heating',
      'unocc h',
      'unocc_heat',
      'unoccupied_heat',
    ]),
    unoccCool: findCol([
      'unocc cool',
      'unoccupied cool',
      'unoccupied cooling',
      'unocc c',
      'unocc_cool',
      'unoccupied_cool',
    ]),
    schedule: findCol(['schedule', 'sched', 'occupancy', 'hours', 'occupied time', 'occupied start']),
  };

  const imported = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (cols.every((c) => !c)) continue; // skip blank rows
    const zone = {};
    if (colMap.name >= 0) zone.name = cols[colMap.name] || '';
    if (colMap.occHeat >= 0) zone.occHeat = parseFloat(cols[colMap.occHeat]) || null;
    if (colMap.occCool >= 0) zone.occCool = parseFloat(cols[colMap.occCool]) || null;
    if (colMap.unoccHeat >= 0) zone.unoccHeat = parseFloat(cols[colMap.unoccHeat]) || null;
    if (colMap.unoccCool >= 0) zone.unoccCool = parseFloat(cols[colMap.unoccCool]) || null;
    if (colMap.schedule >= 0) zone.schedule = cols[colMap.schedule] || '';
    if (!zone.name && colMap.name < 0) zone.name = 'Zone ' + i;
    imported.push(zone);
  }

  if (!imported.length) {
    showToast('No data rows found in CSV ⚠');
    return;
  }

  // Merge into draft (replace all zones for this building)
  const key = projId + ':' + bldgId;
  window._spDraft[key] = imported;
  showToast('Imported ' + imported.length + ' zone' + (imported.length !== 1 ? 's' : '') + ' — click Save to keep');
  renderSetpointsTab(projId);
}

function _spParseMultiBldgSetpoints(lines, headers, splitRow, projId, colBldgName, headerIdx) {
  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (!p) return;
  var bldgs = getUDBldgs(projId);
  if (!bldgs.length) {
    showToast('No buildings in project — add buildings in Utility Data tab first ⚠');
    return;
  }

  // Column detection — prefer "Existing" columns for baseline data
  function fc(candidates) {
    for (var ci = 0; ci < candidates.length; ci++) {
      var idx = headers.findIndex(function (h) {
        return h.includes(candidates[ci]);
      });
      if (idx >= 0) return idx;
    }
    return -1;
  }

  var colZone = fc(['equipment affected', 'location or equipment']);
  var colEquip = fc(['type of equipment']);
  var colOH = fc(['existing occupied heating']);
  var colOC = fc(['existing occupied cooling']);
  var colUH = fc(['existing unoccupied heating']);
  var colUC = fc(['existing unoccupied cooling']);
  var colSched = fc(['existing occupied time']);
  var colWknd = fc(['existing occupied sat']);

  // Group rows by building name
  var byBldg = {};
  for (var i = headerIdx + 1; i < lines.length; i++) {
    var cols = splitRow(lines[i]);
    if (
      cols.every(function (c) {
        return !c;
      })
    )
      continue;
    var bName = (cols[colBldgName] || '').trim();
    if (!bName) continue;
    if (!byBldg[bName]) byBldg[bName] = [];

    var schedText = colSched >= 0 ? cols[colSched] || '' : '';
    if (schedText) schedText = 'M-F ' + schedText;
    var wknd = colWknd >= 0 ? cols[colWknd] || '' : '';
    if (wknd && wknd.toLowerCase() !== 'none') {
      schedText += (schedText ? ' / ' : '') + 'Sat-Sun ' + wknd;
    }

    var zone = {
      name: colZone >= 0 ? cols[colZone] || 'Zone ' + i : 'Zone ' + i,
      occHeat: colOH >= 0 ? parseFloat(cols[colOH]) || null : null,
      occCool: colOC >= 0 ? parseFloat(cols[colOC]) || null : null,
      unoccHeat: colUH >= 0 ? parseFloat(cols[colUH]) || null : null,
      unoccCool: colUC >= 0 ? parseFloat(cols[colUC]) || null : null,
      schedule: schedText,
    };
    if (colEquip >= 0 && cols[colEquip]) zone.equipmentType = cols[colEquip];
    byBldg[bName].push(zone);
  }

  // Match Excel building names to project buildings (fuzzy)
  if (!p.setpoints) p.setpoints = [];
  var totalZones = 0;
  var matched = 0;
  var unmatchedNames = [];
  var matchLog = [];

  var bldgNames = Object.keys(byBldg);
  for (var bi = 0; bi < bldgNames.length; bi++) {
    var xlName = bldgNames[bi];
    var zones = byBldg[xlName];
    var match = null;

    // Try exact match first, then case-insensitive contains in either direction
    for (var mi = 0; mi < bldgs.length; mi++) {
      var bn = (bldgs[mi].name || '').toLowerCase();
      var xn = xlName.toLowerCase();
      if (bn === xn || bn.includes(xn) || xn.includes(bn)) {
        match = bldgs[mi];
        break;
      }
    }

    if (match) {
      var rec = p.setpoints.find(function (r) {
        return r.buildingId === match.id;
      });
      if (rec) {
        rec.zones = zones;
      } else {
        p.setpoints.push({ buildingId: match.id, zones: zones });
      }
      totalZones += zones.length;
      matched++;
      matchLog.push(xlName + ' → ' + match.name + ' (' + zones.length + ')');
    } else {
      unmatchedNames.push(xlName + ' (' + zones.length + ')');
    }
  }

  sset('en_projects', projects);

  var msg = 'Imported ' + totalZones + ' zones across ' + matched + ' building' + (matched !== 1 ? 's' : '') + ' ✓';
  if (unmatchedNames.length) msg += '\nUnmatched: ' + unmatchedNames.join(', ');
  showToast(msg);
  console.log('[Set Points Import] Matched:', matchLog, 'Unmatched:', unmatchedNames);
  renderSetpointsTab(projId);
}

/* ══════════════════════════════════════════════════════
         BAS EQUIPMENT SNAPSHOT ANALYZER
      ══════════════════════════════════════════════════════ */

function _basIsError(v) {
  if (v === undefined || v === null || v === '') return true;
  var s = String(v).trim();
  return s.startsWith('(Error)') || s.startsWith('"(Error)') || s.startsWith('(?)') || s.startsWith('"(?)');
}

function _basNum(v) {
  if (_basIsError(v)) return null;
  var n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function _basStr(v) {
  if (_basIsError(v)) return '';
  return String(v)
    .replace(/^"+|"+$/g, '')
    .trim();
}

function _basExtractBuilding(paths) {
  // paths = array of path column values (up to 5), representing geographic hierarchy
  // The building is typically the level just below the district/org level
  // Pattern: Area > Building > District — building is the second-to-last non-empty path
  var clean = paths
    .map(function (p) {
      return _basStr(p);
    })
    .filter(function (p) {
      return p && p !== '';
    });
  if (clean.length === 0) return '';
  // The district/org is usually the last non-empty path value
  // Building is the one before it
  if (clean.length >= 2) return clean[clean.length - 2];
  return clean[0];
}

function _basExtractProgram(fullPath) {
  var s = _basStr(fullPath);
  if (!s) return '';
  // Strip /defs/equipment/ prefix
  var prefix = '/defs/equipment/';
  var idx = s.indexOf(prefix);
  if (idx >= 0) return s.substring(idx + prefix.length);
  return s;
}

function _basParseFileDate(fileName) {
  if (!fileName) return null;
  var m = fileName.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6];
  var m2 = fileName.match(/(\d{4})(\d{2})(\d{2})/);
  if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
  return null;
}

function _basFormatDate(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function _basPopulateSetpoints(p, projId, rows) {
  var bldgs = getUDBldgs(projId);
  if (!bldgs.length) return;
  if (!p.setpoints) p.setpoints = [];

  // Group snapshot rows by building name
  var bldgMap = {};
  rows.forEach(function (r) {
    if (!r.building) return;
    if (!bldgMap[r.building]) bldgMap[r.building] = [];
    bldgMap[r.building].push(r);
  });

  var populated = 0;
  bldgs.forEach(function (b) {
    // Match by building name — fuzzy: either side can be a substring of the other
    var bName = (b.name || '').trim().toLowerCase();
    var matchKey = Object.keys(bldgMap).find(function (k) {
      var sName = k.trim().toLowerCase();
      return sName === bName || bName.includes(sName) || sName.includes(bName);
    });
    if (!matchKey) return;

    var snapRows = bldgMap[matchKey];
    var zones = snapRows.map(function (r) {
      return {
        name: r.location || '',
        occHeat: r.heatSP,
        occCool: r.coolSP,
        unoccHeat: null,
        unoccCool: null,
        schedule: '',
      };
    });

    var existing = p.setpoints.find(function (s) {
      return s.buildingId === b.id;
    });
    if (existing) {
      existing.zones = zones;
    } else {
      p.setpoints.push({ buildingId: b.id, zones: zones });
    }
    populated += zones.length;
  });

  if (populated > 0) {
    _spClearDraft(projId, bldgs[0].id);
    // Propagate BAS snapshot date to setpoint versionDate
    var activeSnapId = (window._basActiveSnap && window._basActiveSnap[projId]) || null;
    var activeSnap = activeSnapId
      ? (p.basSnapshots || []).find(function (s) {
          return s.id === activeSnapId;
        })
      : null;
    if (activeSnap && activeSnap.snapshotDate) {
      (p.setpoints || []).forEach(function (sp) {
        sp.versionDate = activeSnap.snapshotDate;
      });
    }
  }
}

function spParseBASSnapshot(lines, headers, splitRow, projId, fileName) {
  function findCol(candidates) {
    for (var ci = 0; ci < candidates.length; ci++) {
      var idx = headers.findIndex(function (h) {
        return h.includes(candidates[ci]);
      });
      if (idx >= 0) return idx;
    }
    return -1;
  }
  function findAllCols(candidate) {
    var result = [];
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] === candidate || headers[i].includes(candidate)) result.push(i);
    }
    return result;
  }

  var col = {
    location: findCol(['location']),
    zoneTemp: findCol(['zone temp (zone)']),
    zoneTempSpt: findCol(['zone temp (spt)']),
    zoneTempZT: findCol(['zone temp (zone_temp)']),
    zoneTempZoneTemp: findCol(['zone temp (zonetemperature)']),
    heatSP: findCol(['heating sp']),
    coolSP: findCol(['cooling sp']),
    spAdj: findCol(['set point adj']),
    zoneCO2: findCol(['zone co2']),
    raCO2: findCol(['ra co2']),
    zoneHum: findCol(['zone hum (zone_humidity)']),
    zoneHumZ: findCol(['zone hum (zhum)']),
    zoneHumSph: findCol(['zone hum (sph)']),
    raHum: findCol(['ra hum']),
    zoneState: findCol(['zone state']),
    flowSP: findCol(['flow sp']),
    heatPct: findCol(['heat%']),
    coolPct: findCol(['cool%']),
    sat: findCol(['sat']),
    satSP: findCol(['satsp']),
    pumpSts: findCol(['pump status']),
    pumpSpd: findCol(['pump speed']),
    hwSP: findCol(['hot water set point']),
    poolSP: findCol(['pool water set point']),
    ctrlProg: findCol(['control program name']),
  };
  var pathCols = findAllCols('path');

  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var vals = splitRow(lines[i]);
    if (
      vals.every(function (c) {
        return !c;
      })
    )
      continue;

    var zoneTemp = _basNum(vals[col.zoneTemp]);
    if (zoneTemp === null) zoneTemp = _basNum(vals[col.zoneTempSpt]);
    if (zoneTemp === null) zoneTemp = _basNum(vals[col.zoneTempZT]);
    if (zoneTemp === null) zoneTemp = _basNum(vals[col.zoneTempZoneTemp]);

    var heatSP = _basNum(vals[col.heatSP]);
    var coolSP = _basNum(vals[col.coolSP]);
    var spAdj = _basNum(vals[col.spAdj]);

    var defHeat = null;
    var defCool = null;
    if (heatSP !== null && spAdj !== null) {
      var dh = heatSP - spAdj;
      defHeat = dh === 0 ? null : dh;
    }
    if (coolSP !== null && spAdj !== null) {
      var dc = coolSP - spAdj;
      defCool = dc === 0 ? null : dc;
    }

    var zoneCO2 = _basNum(vals[col.zoneCO2]);
    var raCO2 = _basNum(vals[col.raCO2]);
    var zoneHum = _basNum(vals[col.zoneHum]);
    if (zoneHum === null) zoneHum = _basNum(vals[col.zoneHumZ]);
    if (zoneHum === null) zoneHum = _basNum(vals[col.zoneHumSph]);
    var raHum = _basNum(vals[col.raHum]);

    var pathVals = pathCols.map(function (ci) {
      return vals[ci];
    });
    var building = _basExtractBuilding(pathVals);
    var program = _basExtractProgram(vals[col.ctrlProg]);

    var zoneState = _basStr(vals[col.zoneState]);

    rows.push({
      location: _basStr(vals[col.location]),
      zoneTemp: zoneTemp,
      heatSP: heatSP,
      coolSP: coolSP,
      defHeatSP: defHeat,
      defCoolSP: defCool,
      spAdj: spAdj,
      zoneCO2: zoneCO2,
      raCO2: raCO2,
      zoneHum: zoneHum,
      raHum: raHum,
      zoneState: zoneState,
      flowSP: _basNum(vals[col.flowSP]),
      heatPct: _basNum(vals[col.heatPct]),
      coolPct: _basNum(vals[col.coolPct]),
      sat: _basNum(vals[col.sat]),
      satSP: _basNum(vals[col.satSP]),
      building: building,
      controlProgram: program,
    });
  }

  if (!rows.length) {
    showToast('No data rows found in BAS snapshot');
    return;
  }

  var analysis = spComputeBASAnalysis(rows);

  var p = projects.find(function (x) {
    return String(x.id) === String(projId);
  });
  if (p) {
    var snapshotDate = _basParseFileDate(fileName);
    var newSnap = {
      id: Date.now().toString(36),
      snapshotDate: snapshotDate,
      importedAt: new Date().toISOString(),
      fileName: fileName || 'unknown.csv',
      rows: rows,
      buildings: analysis,
    };
    // Migrate old single basSnapshot to array
    if (p.basSnapshot && !p.basSnapshots) {
      p.basSnapshots = [p.basSnapshot];
      if (!p.basSnapshots[0].id) p.basSnapshots[0].id = 'legacy';
      delete p.basSnapshot;
    }
    if (!p.basSnapshots) p.basSnapshots = [];
    // Prevent duplicate imports of the same file
    var dup = p.basSnapshots.find(function (s) {
      return s.fileName === newSnap.fileName;
    });
    if (dup) {
      Object.assign(dup, newSnap);
      showToast('BAS Snapshot updated: ' + rows.length + ' zones across ' + analysis.length + ' buildings');
    } else {
      p.basSnapshots.push(newSnap);
      showToast('BAS Snapshot added: ' + rows.length + ' zones (' + _basFormatDate(snapshotDate) + ')');
    }
    window._basActiveSnap = window._basActiveSnap || {};
    window._basActiveSnap[projId] = newSnap.id;

    // Auto-populate Set Points from snapshot data
    _basPopulateSetpoints(p, projId, rows);

    sset('en_projects', projects);
  }
  renderSetpointsTab(projId);
}

function spComputeBASAnalysis(rows) {
  var bldgMap = {};
  rows.forEach(function (r) {
    var b = r.building || '(Unknown)';
    if (!bldgMap[b]) bldgMap[b] = [];
    bldgMap[b].push(r);
  });

  function avg(arr, key) {
    var vals = arr
      .map(function (r) {
        return r[key];
      })
      .filter(function (v) {
        return v !== null && v !== undefined;
      });
    if (!vals.length) return null;
    return (
      Math.round(
        (vals.reduce(function (a, b) {
          return a + b;
        }, 0) /
          vals.length) *
          10,
      ) / 10
    );
  }

  var result = [];
  var bldgNames = Object.keys(bldgMap).sort();
  bldgNames.forEach(function (name) {
    var bRows = bldgMap[name];
    var progs = bRows
      .map(function (r) {
        return r.controlProgram;
      })
      .filter(function (p) {
        return p;
      });
    var uniqueProgs = [];
    progs.forEach(function (p) {
      if (uniqueProgs.indexOf(p) < 0) uniqueProgs.push(p);
    });

    var baselineCount = 2;
    var minsPerProg = 1.5;
    var hrsPerUnique = 0.375;
    var changed = Math.max(uniqueProgs.length - baselineCount, 0);
    var auditMins = progs.length * minsPerProg;
    var auditHrs = Math.ceil(auditMins / 60);
    var implHrs = Math.ceil(changed * hrsPerUnique);

    result.push({
      building: name,
      count: bRows.length,
      avgHeatSP: avg(bRows, 'heatSP'),
      avgCoolSP: avg(bRows, 'coolSP'),
      avgDefHeatSP: avg(bRows, 'defHeatSP'),
      avgDefCoolSP: avg(bRows, 'defCoolSP'),
      avgZoneTemp: avg(bRows, 'zoneTemp'),
      avgSPAdj: avg(bRows, 'spAdj'),
      avgCO2: avg(bRows, 'zoneCO2'),
      avgRACO2: avg(bRows, 'raCO2'),
      avgHum: avg(bRows, 'zoneHum'),
      totalProgs: progs.length,
      uniqueProgs: uniqueProgs.length,
      changedProgs: changed,
      auditHrs: auditHrs,
      implHrs: implHrs,
    });
  });
  return result;
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
    '<select class="fi" style="font-size:12px;padding:4px 8px;max-width:240px" onchange="spBASFilter(\'' +
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
    '<th>Location</th><th class="num">Zone Temp</th><th class="num">Heat SP</th><th class="num">Cool SP</th>' +
    '<th class="num">Def Heat SP</th><th class="num">Def Cool SP</th><th class="num">SP Adj</th>' +
    '<th class="num">Zone CO2</th><th class="num">RA CO2</th><th class="num">Zone Hum</th>' +
    '<th>Zone State</th><th class="num">Flow SP</th><th class="num">Heat%</th><th class="num">Cool%</th>' +
    '<th class="num">SAT</th><th>Building</th><th>Control Program</th></tr>';

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
    '<th class="num">Zone Temp</th>' +
    '<th class="num">Heat SP</th>' +
    '<th class="num">Cool SP</th>' +
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
